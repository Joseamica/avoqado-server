import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { closesAt, isWithinHours } from './hours'
import {
  FOLIO_LAST_CALL_MINUTES,
  MAX_PENDING_PER_VENUE,
  PRESENCE_WINDOW_MS,
  FOLIO_PRESENCE_WINDOW_MS,
  PRESENCE_WRITE_DEBOUNCE_MS,
  awaitingAcceptanceWhere,
  liveCardDraftsWhere,
} from './constants'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getSettings, preloadReservationHours } from './settings.service'
import type { AcceptingReason, AcceptingState, AcceptingStatus } from './types'

// En memoria a propósito (una sola instancia): amortigua la escritura; la verdad es la columna.
const lastWrite = new Map<string, number>()
// R11: llave propia del latido de folios; si compartiera mapa, la Bandeja abierta le «comería» el latido a la TPV.
const lastToPayWrite = new Map<string, number>()

export function __resetPresenceDebounceForTests(): void {
  lastWrite.clear()
  lastToPayWrite.clear()
}

/**
 * La bandeja abierta consultó ahora: eso demuestra que hay alguien mirando. Devuelve `true` si escribió.
 * R13: el debounce se mueve SÓLO si la escritura funcionó; un fallo no puede callar el siguiente latido.
 * Sin fila de ajustes no hay nada que actualizar (la tienda está apagada).
 */
export async function touchInboxPoll(venueId: string, now: Date = new Date()): Promise<boolean> {
  const last = lastWrite.get(venueId) ?? 0
  if (now.getTime() - last < PRESENCE_WRITE_DEBOUNCE_MS) return false
  await prisma.onlineOrderingSettings.updateMany({ where: { venueId }, data: { lastInboxPollAt: now } })
  lastWrite.set(venueId, now.getTime())
  return true
}

/**
 * Tienda híbrida: un aparato que PUEDE cobrar folios (TPV o POS) consultó ahora. Si aún no hay fila de ajustes, el primer latido la
 * crea apagada y en «Mi equipo» (R37), con el horario de reservas precargado, bajo el mismo candado de `updateSettings`.
 */
export async function touchToPayPoll(venueId: string, now: Date = new Date()): Promise<boolean> {
  const last = lastToPayWrite.get(venueId) ?? 0
  if (now.getTime() - last < PRESENCE_WRITE_DEBOUNCE_MS) return false
  const { count } = await prisma.onlineOrderingSettings.updateMany({ where: { venueId }, data: { lastToPayPollAt: now } })
  if (count === 0) {
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'online-ordering-settings:' + venueId}))`
      const hours = await preloadReservationHours(tx, venueId)
      await tx.onlineOrderingSettings.upsert({
        where: { venueId },
        create: { venueId, enabled: false, requiresAcceptance: true, lastToPayPollAt: now, ...(hours ? { hours } : {}) },
        update: { lastToPayPollAt: now },
      })
    })
  }
  lastToPayWrite.set(venueId, now.getTime())
  return true
}

/**
 * Lo que el panel, la bandeja y el MCP muestran del estado de la tienda: un solo armado. D662 parte 2 (aditivo): `autoPausedAt`, la
 * tienda se pausó sola por 2 pedidos sin atender; un cliente viejo no lo lee y dice «Pausada» por el `reason`.
 */
export function storeView(state: AcceptingState) {
  return {
    status: state.status,
    reason: state.reason,
    pausedUntil: state.config.pausedUntil,
    manualPause: state.config.manualPause,
    autoPausedAt: state.autoPausedAt ?? null,
  }
}

/**
 * D662 parte 2 (v3): tope de seguridad de la lectura de la pausa sola. NO es una ventana: la lectura mira todo lo que hay desde el corte
 * (`autoPauseResumedAt`), y el corte avanza solo hasta la última respuesta a tiempo (`avanzarCortePausaSola`), así que lo normal son
 * unas decenas de pedidos (a lo más una falla suelta más los que siguen por aceptar, tope 30, y los contestados desde entonces). Si
 * algún día se llena, se leen los MÁS VIEJOS primero (una pareja nunca se pierde por los nuevos) y se avisa en el log.
 */
export const PAUSA_SOLA_TOPE = 1000

/** Lo que la lectura de la pausa sola necesita de cada pedido: sólo datos que no cambian después de su hora límite. */
const PEDIDO_DE_LA_PAUSA = {
  id: true,
  acceptDeadlineAt: true,
  staffAnsweredAt: true,
  rejectedAt: true,
  rejectReason: true,
  cancelledAt: true,
  cancelledBy: true,
} satisfies Prisma.OnlineOrderSelect
type PedidoDeLaPausa = Prisma.OnlineOrderGetPayload<{ select: typeof PEDIDO_DE_LA_PAUSA }>

/** El pedido terminó solo ANTES de su hora límite y sin una persona (la clienta lo canceló, o el sistema lo rechazó por pago). */
function terminoSoloATiempo(p: PedidoDeLaPausa): boolean {
  const limite = p.acceptDeadlineAt.getTime()
  if (p.cancelledBy === 'CUSTOMER' && p.cancelledAt && p.cancelledAt.getTime() <= limite) return true
  return p.rejectReason === 'PAYMENT_FAILED' && !p.staffAnsweredAt && !!p.rejectedAt && p.rejectedAt.getTime() <= limite
}

export interface LecturaPausaSola {
  /** La segunda falla de la primera pareja (hora límite y pedido), o `null` si no hay pausa. */
  pausa: { at: Date; onlineOrderId: string } | null
  /** La última RESPUESTA a tiempo ya ocurrida (para avanzar el corte), o `null`. */
  ultimaRespuesta: Date | null
}

/**
 * D662 parte 2 (founder, 19-nov, «a»; v3 del 20-nov): la pausa sola se LEE, no se lleva. Una línea de tiempo de dos sucesos:
 * - FALLA: un pedido llegó a su hora límite sin que una persona lo tocara a más tardar en ella (`staffAnsweredAt <= hora límite`).
 *   No se borra después: un rechazo tardío, la clienta que cancela tarde o un cobro no la quitan (Codex p2-r1 #4, p2-r2 #2).
 * - RESPUESTA: una persona tocó un pedido A TIEMPO, a la hora en que lo hizo (aunque su hora límite sea después; p2-r1 #2). Una
 *   respuesta tardía no es respuesta: su pedido ya es falla.
 * Pausada si hay 2 FALLAS seguidas sin RESPUESTA en medio, y se queda así aunque después llegue una respuesta (p2-r1 #1). A la misma
 * hora, la respuesta va primero; las fallas a la misma hora, por `id`. Lo que terminó solo antes de su hora límite no cuenta.
 * Sólo crece hacia adelante: nada de lo que ya pasó cambia después (salvo los milisegundos de T2), y por eso el corte puede avanzar.
 * Techos aceptados: T1 (quien ya estaba pagando termina) y T2 (la respuesta a tiempo que todavía se guarda): aquí no hay candados.
 */
export function leerLineaDeTiempo(pedidos: PedidoDeLaPausa[], now: Date): LecturaPausaSola {
  type Suceso = { t: number; falla: boolean; id: string }
  const sucesos: Suceso[] = []
  const ahora = now.getTime()
  for (const p of pedidos) {
    if (terminoSoloATiempo(p)) continue
    const limite = p.acceptDeadlineAt.getTime()
    const toque = p.staffAnsweredAt?.getTime() ?? null
    const aTiempo = toque !== null && toque <= limite
    if (aTiempo && toque <= ahora) sucesos.push({ t: toque, falla: false, id: p.id })
    if (!aTiempo && limite <= ahora) sucesos.push({ t: limite, falla: true, id: p.id })
  }
  sucesos.sort((a, b) => a.t - b.t || Number(a.falla) - Number(b.falla) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let seguidas = 0
  let ultimaRespuesta: number | null = null
  for (const s of sucesos) {
    if (!s.falla) {
      seguidas = 0
      ultimaRespuesta = s.t
      continue
    }
    seguidas += 1
    if (seguidas >= 2) return { pausa: { at: new Date(s.t), onlineOrderId: s.id }, ultimaRespuesta: null }
  }
  return { pausa: null, ultimaRespuesta: ultimaRespuesta === null ? null : new Date(ultimaRespuesta) }
}

/** Compatibilidad con las pruebas de la v2: la hora de la pausa (ISO) o `null`. */
export function pausaSolaDesde(pedidos: PedidoDeLaPausa[], now: Date): string | null {
  return leerLineaDeTiempo(pedidos, now).pausa?.at.toISOString() ?? null
}

/**
 * Los pedidos de «Mi equipo» con hora límite después del corte, del más viejo al más nuevo, y su lectura. Lo que terminó solo antes de
 * su hora límite (la clienta canceló; el sistema rechazó por pago) se queda fuera desde la consulta (Codex p2-r3 #5: no es suceso y,
 * si se acumulara, la lectura crecería sin que el corte avance). `COALESCE(…, false)`: con un campo nulo la condición es «no», nunca
 * «desconocido» que dejaría fuera un pedido normal.
 */
async function leerPausaSola(venueId: string, now: Date, corte: Date | null): Promise<LecturaPausaSola> {
  const pedidos = await prisma.$queryRaw<PedidoDeLaPausa[]>`
    SELECT oo.id, oo."acceptDeadlineAt", oo."staffAnsweredAt", oo."rejectedAt", oo."rejectReason", oo."cancelledAt", oo."cancelledBy"
    FROM "OnlineOrder" oo
    WHERE oo."venueId" = ${venueId}
      AND oo."requiresAcceptance" = true
      ${corte ? Prisma.sql`AND oo."acceptDeadlineAt" > ${utcTs(corte)}` : Prisma.empty}
      AND NOT COALESCE(oo."cancelledBy" = 'CUSTOMER' AND oo."cancelledAt" <= oo."acceptDeadlineAt", false)
      AND NOT COALESCE(
        oo."rejectReason" = 'PAYMENT_FAILED' AND oo."staffAnsweredAt" IS NULL AND oo."rejectedAt" <= oo."acceptDeadlineAt",
        false
      )
    ORDER BY oo."acceptDeadlineAt" ASC, oo.id ASC
    LIMIT ${PAUSA_SOLA_TOPE}`
  if (pedidos.length >= PAUSA_SOLA_TOPE) {
    logger.warn('[OnlineOrdering] la lectura de la pausa sola llenó su tope: el corte no está avanzando', {
      venueId,
      tope: PAUSA_SOLA_TOPE,
    })
  }
  return leerLineaDeTiempo(pedidos, now)
}

/**
 * D662 parte 2 (v3): sube el corte (`autoPauseResumedAt`) hasta justo antes de la última respuesta a tiempo, SÓLO si la tienda no
 * está pausada sola. Nada de lo anterior a esa respuesta puede formar una pareja después (la línea sólo crece hacia adelante), así que
 * la lectura sigue siendo exacta y queda corta. Nunca baja el corte (`updateMany` condicionado), nunca lanza: si falla, la lectura
 * sólo sale más larga. La llaman, después del commit, las respuestas de una persona (aceptar, rechazar, aceptar con tarjeta).
 */
export async function avanzarCortePausaSola(venueId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const fila = await prisma.onlineOrderingSettings.findUnique({
      where: { venueId },
      select: { enabled: true, requiresAcceptance: true, autoPauseResumedAt: true },
    })
    if (!fila || fila.requiresAcceptance === false) return false
    const corte = fila.autoPauseResumedAt ?? null
    const lectura = await leerPausaSola(venueId, now, corte)
    if (lectura.pausa || !lectura.ultimaRespuesta) return false
    const nuevo = new Date(lectura.ultimaRespuesta.getTime() - 1)
    if (corte && nuevo.getTime() <= corte.getTime()) return false
    const r = await prisma.onlineOrderingSettings.updateMany({
      where: { venueId, OR: [{ autoPauseResumedAt: null }, { autoPauseResumedAt: { lt: nuevo } }] },
      data: { autoPauseResumedAt: nuevo },
    })
    return r.count === 1
  } catch (error) {
    logger.warn('[OnlineOrdering] no se pudo avanzar el corte de la pausa sola (la lectura sigue exacta)', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** `preloaded`: los ajustes que quien llama ya leyó (p. ej. `GET /settings`), para no leerlos dos veces. */
export async function getAcceptingStatus(
  venueId: string,
  now: Date = new Date(),
  preloaded?: Awaited<ReturnType<typeof getSettings>>,
): Promise<AcceptingState> {
  const [settings, venue] = await Promise.all([
    preloaded ?? getSettings(venueId),
    prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }),
  ])
  const { lastInboxPollAt, lastToPayPollAt, autoPauseResumedAt, ...config } = settings
  const timezone = venue?.timezone || 'America/Mexico_City'
  let autoPausedAt: string | null = null
  const done = (status: AcceptingStatus, reason: AcceptingReason): AcceptingState => ({ status, reason, config, autoPausedAt })

  if (!config.enabled) return done('DISABLED', 'NOT_ENABLED')
  // La pausa del gerente gana con su forma de hoy: el «Reanudar» del piso no la quita (M-8), así que no se anuncia la sola.
  if (config.manualPause) return done('PAUSED', 'MANUAL_PAUSE')
  // D662 parte 2: sólo en «Mi equipo» (`=== false` es «Nadie»). Mismo motivo que la pausa a mano para las apps viejas. Va antes del
  // horario y de la presencia: sólo «Reanudar» la abre. Con una pausa de 15/30/60 vigente también se lee: al vencer, sigue pausada.
  let pausaSola: LecturaPausaSola['pausa'] = null
  if (config.requiresAcceptance !== false) pausaSola = (await leerPausaSola(venueId, now, autoPauseResumedAt ?? null)).pausa
  autoPausedAt = pausaSola?.at.toISOString() ?? null
  if (config.pausedUntil && new Date(config.pausedUntil) > now) return done('PAUSED', 'MANUAL_PAUSE')
  if (autoPausedAt) return done('PAUSED', 'MANUAL_PAUSE')
  if (!isWithinHours(config.hours, now, timezone)) return done('CLOSED', 'OUTSIDE_HOURS')
  // R56: en «Nadie» (`=== false`), el último pedido para pagar en caja es FOLIO_LAST_CALL_MINUTES antes del cierre REAL de la franja
  // (`closesAt` junta las contiguas). Se dice igual que fuera de horario; `/info` sigue anunciando el cierre real.
  if (config.requiresAcceptance === false) {
    const cierre = closesAt(config.hours, now, timezone)
    if (cierre && cierre.getTime() - now.getTime() < FOLIO_LAST_CALL_MINUTES * 60_000) return done('CLOSED', 'OUTSIDE_HOURS')
  }
  // «Nadie» (`=== false`: una fila sin el campo no lo es) cuenta a quien puede cobrar folios; «Mi equipo», al POS a la vista (D662).
  const latido = config.requiresAcceptance === false ? lastToPayPollAt : lastInboxPollAt
  // D659/D660: la caja que cobra folios duerme con la pantalla apagada y late cada 2–11 min; la Bandeja abierta, cada ~10 s.
  const ventana = config.requiresAcceptance === false ? FOLIO_PRESENCE_WINDOW_MS : PRESENCE_WINDOW_MS
  if (!latido || now.getTime() - latido.getTime() > ventana) return done('OFFLINE', 'NO_DEVICE')

  // Fase 2: los borradores de tarjeta vigentes también ocupan lugar (el tope de admisión los cuenta igual).
  const pending =
    (await prisma.onlineOrder.count({ where: awaitingAcceptanceWhere(venueId) })) +
    (await prisma.onlineOrderCharge.count({ where: liveCardDraftsWhere(venueId, now) }))
  if (pending >= MAX_PENDING_PER_VENUE) return done('PAUSED', 'TOO_BUSY')

  return done('OPEN', null)
}

/**
 * D662 parte 2: bitácora `ONLINE_ORDERING_AUTO_PAUSED`, SÓLO como registro (la verdad es la lectura de `getAcceptingStatus`). La llama
 * el vencimiento de un pedido después de su commit: si la tienda quedó pausada sola y ESTE pedido es la segunda falla de la pareja
 * (por `id`, no por hora: dos pedidos pueden vencer en el mismo milisegundo; Codex p2-r2 #8), escribe una fila. El CAS de vencer gana
 * una sola vez por pedido. Si el pedido que la pausó no vence (la clienta lo canceló tarde, un rechazo tardío), no hay fila: aceptado.
 * Nunca lanza.
 */
export async function registrarSiLaPausoSola(venueId: string, onlineOrderId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const fila = await prisma.onlineOrderingSettings.findUnique({
      where: { venueId },
      select: { enabled: true, manualPause: true, requiresAcceptance: true, autoPauseResumedAt: true },
    })
    if (!fila || !fila.enabled || fila.manualPause || fila.requiresAcceptance === false) return false
    const { pausa } = await leerPausaSola(venueId, now, fila.autoPauseResumedAt ?? null)
    if (!pausa || pausa.onlineOrderId !== onlineOrderId) return false
    const pedido = await prisma.onlineOrder.findFirst({
      where: { id: onlineOrderId, venueId },
      select: { order: { select: { orderNumber: true } } },
    })
    void logAction({
      staffId: null,
      venueId,
      action: 'ONLINE_ORDERING_AUTO_PAUSED',
      entity: 'OnlineOrderingSettings',
      entityId: venueId,
      data: {
        autoPausedAt: pausa.at.toISOString(),
        orderNumber: pedido?.order.orderNumber ?? null,
        reason: '2 pedidos seguidos sin aceptar',
      },
    })
    return true
  } catch {
    return false
  }
}
