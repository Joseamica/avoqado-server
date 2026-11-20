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

/** D662 parte 2 (v3): tope de una página de la lectura de la pausa sola (no es una ventana: ver `leerPausaSola`). */
export const PAUSA_SOLA_TOPE = 1000
/** Cuántas páginas, como mucho, recorre una lectura que se llena (cada una sube el corte antes de leer la siguiente). */
const PAUSA_SOLA_PAGINAS = 5
/**
 * Holgura de lo que «terminó solo» y del corte (Codex p2-r3 #3, p2-r4 #2): una escritura con su hora tomada se confirma, a lo más, al
 * vencer la transacción (`ORDER_LOCK_WAIT_BUDGET.timeout`, 15 s). Con 30 s, todo lo que la lectura ve como «ya pasó hace 30 s» es
 * definitivo, y una cancelación de la clienta o un rechazo de Stripe que todavía se guarda nunca quita una pausa ya visible: lo que
 * termina solo en los últimos 30 s antes de su hora límite cuenta como si hubiera llegado a ella sin respuesta.
 */
export const MARGEN_DEFINITIVO_MS = 30_000
/** Gracia del despliegue: la primera lectura del SERVIDOR nuevo, con el corte vacío, lo pone 20 min adelante (ver `leerPausaSola`). */
export const GRACIA_DESPLIEGUE_MS = 20 * 60_000
/** La lectura sube el corte (sin esperarlo) cuando puede avanzar al menos esto: una escritura cada pocos minutos por negocio activo. */
export const AVANCE_MINIMO_MS = 5 * 60_000

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

/**
 * El pedido terminó solo con 30 s de anticipación a su hora límite y sin una persona: la clienta lo canceló, o el sistema lo rechazó por
 * pago. Lo que termina solo en los últimos 30 s cuenta como sin respuesta (`MARGEN_DEFINITIVO_MS`).
 */
function terminoSoloATiempo(p: PedidoDeLaPausa): boolean {
  const limite = p.acceptDeadlineAt.getTime() - MARGEN_DEFINITIVO_MS
  if (p.cancelledBy === 'CUSTOMER' && p.cancelledAt && p.cancelledAt.getTime() <= limite) return true
  return p.rejectReason === 'PAYMENT_FAILED' && !p.staffAnsweredAt && !!p.rejectedAt && p.rejectedAt.getTime() <= limite
}

export interface LecturaPausaSola {
  /** La segunda falla de la primera pareja (hora límite y pedido), o `null` si no hay pausa. */
  pausa: { at: Date; onlineOrderId: string } | null
  /**
   * Hasta dónde puede subir el corte sin cambiar ninguna lectura futura, o `null` (hay pausa, o no se sabe). Es lo más tarde de:
   * 30 s antes de ahora (lo de antes ya es definitivo), y justo antes de la primera falla que siga sin respuesta detrás (si la hay);
   * con una página llena, además, justo antes de la última hora límite leída (lo que sigue no se ha visto).
   */
  corteSeguro: Date | null
}

/**
 * D662 parte 2 (founder, 19-nov, «a»; v3 del 20-nov): la pausa sola se LEE, no se lleva. Una línea de tiempo de dos sucesos:
 * - FALLA: un pedido llegó a su hora límite sin que una persona lo tocara a más tardar en ella (`staffAnsweredAt <= hora límite`).
 *   No se borra después: un rechazo tardío, la clienta que cancela tarde o un cobro no la quitan (Codex p2-r1 #4, p2-r2 #2).
 * - RESPUESTA: una persona tocó un pedido A TIEMPO, a la hora en que lo hizo (aunque su hora límite sea después; p2-r1 #2). Una
 *   respuesta tardía no es respuesta: su pedido ya es falla.
 * Pausada si hay 2 FALLAS seguidas sin RESPUESTA en medio, y se queda así aunque después llegue una respuesta (p2-r1 #1). A la misma
 * hora, la respuesta va primero; las fallas a la misma hora, por `id`. Lo que terminó solo antes de su hora límite no cuenta.
 * Sólo crece hacia adelante: lo que pasó hace más de 30 s ya no cambia, y por eso el corte puede avanzar (`corteSeguro`).
 * Techos aceptados: T1 (quien ya estaba pagando termina) y T2 (la respuesta a tiempo que todavía se guarda): aquí no hay candados.
 * [completa]: la lectura trae TODO lo que hay después del corte (si no, el corte no pasa de lo leído).
 */
export function leerLineaDeTiempo(pedidos: PedidoDeLaPausa[], now: Date, completa = true): LecturaPausaSola {
  type Suceso = { t: number; falla: boolean; id: string }
  const sucesos: Suceso[] = []
  const ahora = now.getTime()
  let ultimaLeida = -Infinity
  for (const p of pedidos) {
    const limite = p.acceptDeadlineAt.getTime()
    ultimaLeida = Math.max(ultimaLeida, limite)
    if (terminoSoloATiempo(p)) continue
    const toque = p.staffAnsweredAt?.getTime() ?? null
    const aTiempo = toque !== null && toque <= limite
    if (aTiempo && toque <= ahora) sucesos.push({ t: toque, falla: false, id: p.id })
    if (!aTiempo && limite <= ahora) sucesos.push({ t: limite, falla: true, id: p.id })
  }
  sucesos.sort((a, b) => a.t - b.t || Number(a.falla) - Number(b.falla) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let seguidas = 0
  let fallaSuelta: number | null = null
  for (const s of sucesos) {
    if (!s.falla) {
      seguidas = 0
      fallaSuelta = null
      continue
    }
    seguidas += 1
    if (seguidas >= 2) return { pausa: { at: new Date(s.t), onlineOrderId: s.id }, corteSeguro: null }
    fallaSuelta = s.t
  }
  let corte = ahora - MARGEN_DEFINITIVO_MS
  if (fallaSuelta !== null) corte = Math.min(corte, fallaSuelta - 1)
  if (!completa) corte = Math.min(corte, ultimaLeida - 1)
  return { pausa: null, corteSeguro: Number.isFinite(corte) ? new Date(corte) : null }
}

/** Compatibilidad con las pruebas de la v2: la hora de la pausa (ISO) o `null`. */
export function pausaSolaDesde(pedidos: PedidoDeLaPausa[], now: Date): string | null {
  return leerLineaDeTiempo(pedidos, now).pausa?.at.toISOString() ?? null
}

/** Sube el corte a [nuevo] sólo si eso lo sube (nunca lo baja; un corte vacío es la gracia pendiente y no se toca aquí). */
async function subirCorte(venueId: string, nuevo: Date): Promise<boolean> {
  const r = await prisma.onlineOrderingSettings.updateMany({
    where: { venueId, autoPauseResumedAt: { lt: nuevo } },
    data: { autoPauseResumedAt: nuevo },
  })
  return r.count === 1
}

/** Lo mismo, sin esperar ni lanzar: la lectura nunca se frena ni falla por esto. */
function subirCorteSinEsperar(venueId: string, nuevo: Date): void {
  void Promise.resolve()
    .then(() => subirCorte(venueId, nuevo))
    .catch(error =>
      logger.warn('[OnlineOrdering] no se pudo subir el corte de la pausa sola (la lectura sigue exacta)', {
        venueId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
}

/** Una página de la lectura: los pedidos de «Mi equipo» con hora límite después del corte, del más viejo al más nuevo. */
async function leerPagina(venueId: string, corte: Date): Promise<PedidoDeLaPausa[]> {
  // Lo que terminó solo con 30 s de anticipación no se lee (Codex p2-r3 #5): no es suceso y, si se acumulara, la lectura crecería.
  // `COALESCE(…, false)`: con un campo nulo la condición es «no», nunca «desconocido» que dejaría fuera un pedido normal.
  const margen = Prisma.raw(`(oo."acceptDeadlineAt" - interval '${MARGEN_DEFINITIVO_MS / 1000} seconds')`) // constante, no viene de fuera
  return prisma.$queryRaw<PedidoDeLaPausa[]>`
    SELECT oo.id, oo."acceptDeadlineAt", oo."staffAnsweredAt", oo."rejectedAt", oo."rejectReason", oo."cancelledAt", oo."cancelledBy"
    FROM "OnlineOrder" oo
    WHERE oo."venueId" = ${venueId}
      AND oo."requiresAcceptance" = true
      AND oo."acceptDeadlineAt" > ${utcTs(corte)}
      AND NOT COALESCE(oo."cancelledBy" = 'CUSTOMER' AND oo."cancelledAt" <= ${margen}, false)
      AND NOT COALESCE(oo."rejectReason" = 'PAYMENT_FAILED' AND oo."staffAnsweredAt" IS NULL AND oo."rejectedAt" <= ${margen}, false)
    ORDER BY oo."acceptDeadlineAt" ASC, oo.id ASC
    LIMIT ${PAUSA_SOLA_TOPE}`
}

/**
 * La pausa sola de un negocio, desde su corte. Exacta: lee TODO lo que hay después del corte, por páginas del más viejo al más nuevo;
 * si una página se llena, sube el corte hasta lo que esa página permite y lee la siguiente (Codex p2-r4 #1: mil anulaciones no
 * esconden la pareja que sigue). Si no hay pausa y el corte puede subir bastante, lo sube sin esperar: así la lectura de mañana es
 * corta aunque nadie conteste (p2-r4 #5).
 * Corte vacío (la fila de antes del cambio, o una nueva): es la GRACIA del despliegue (p2-r4 #3). La primera lectura del SERVIDOR
 * nuevo lo pone 20 min adelante y, mientras, no hay pausa sola: lo que contestó el servidor anterior (sin `staffAnsweredAt`) nunca
 * cuenta, aunque el despliegue falle y se repita horas después.
 */
async function leerPausaSola(venueId: string, now: Date, corteGuardado: Date | null, avance = AVANCE_MINIMO_MS): Promise<LecturaPausaSola> {
  if (!corteGuardado) {
    const gracia = new Date(now.getTime() + GRACIA_DESPLIEGUE_MS)
    void Promise.resolve()
      .then(() =>
        prisma.onlineOrderingSettings.updateMany({ where: { venueId, autoPauseResumedAt: null }, data: { autoPauseResumedAt: gracia } }),
      )
      .catch(() => undefined)
    return { pausa: null, corteSeguro: null }
  }
  let corte = corteGuardado
  for (let pagina = 1; ; pagina++) {
    const pedidos = await leerPagina(venueId, corte)
    const completa = pedidos.length < PAUSA_SOLA_TOPE
    const lectura = leerLineaDeTiempo(pedidos, now, completa)
    if (lectura.pausa) return lectura
    const sube = lectura.corteSeguro && lectura.corteSeguro.getTime() > corte.getTime() ? lectura.corteSeguro : null
    if (completa) {
      if (sube && sube.getTime() - corteGuardado.getTime() >= avance) subirCorteSinEsperar(venueId, sube)
      return lectura
    }
    if (!sube || pagina >= PAUSA_SOLA_PAGINAS) {
      logger.warn('[OnlineOrdering] la lectura de la pausa sola no alcanzó a leer todo: el corte no está avanzando', {
        venueId,
        tope: PAUSA_SOLA_TOPE,
        paginas: pagina,
      })
      return lectura
    }
    await subirCorte(venueId, sube)
    corte = sube
  }
}

/**
 * D662 parte 2 (v3): sube el corte (`autoPauseResumedAt`) hasta donde la lectura lo permite (`corteSeguro`), SÓLO si la tienda no está
 * pausada sola. Nunca lo baja, nunca lanza: si falla, la lectura sólo sale más larga. La llaman, después del commit, las respuestas de
 * una persona (aceptar, rechazar, aceptar con tarjeta); la lectura de la tienda también lo sube sola cada pocos minutos.
 */
export async function avanzarCortePausaSola(venueId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const fila = await prisma.onlineOrderingSettings.findUnique({
      where: { venueId },
      select: { enabled: true, requiresAcceptance: true, autoPauseResumedAt: true },
    })
    if (!fila || fila.requiresAcceptance === false || !fila.autoPauseResumedAt) return false
    const lectura = await leerPausaSola(venueId, now, fila.autoPauseResumedAt, Infinity)
    if (lectura.pausa || !lectura.corteSeguro || lectura.corteSeguro.getTime() <= fila.autoPauseResumedAt.getTime()) return false
    return await subirCorte(venueId, lectura.corteSeguro)
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
