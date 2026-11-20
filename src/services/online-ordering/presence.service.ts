import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { closesAt, isWithinHours } from './hours'
import {
  CANCELLED_ELSEWHERE,
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
 * D662 parte 2: cuántos pedidos de «Mi equipo» (los más recientes por hora límite) mira la lectura de la pausa sola. Basta con
 * que quepan los que pueden tener hora límite DESPUÉS de la pausa: con la tienda pausada no entran pedidos nuevos (salvo el techo
 * T1), así que sólo quedan los que ya existían (a lo más `MAX_PENDING_PER_VENUE` por aceptar más los ya contestados de esos 10 min).
 */
export const PAUSA_SOLA_VENTANA = 100

/** Lo que la lectura de la pausa sola necesita de cada pedido. */
const PEDIDO_DE_LA_PAUSA = {
  acceptDeadlineAt: true,
  staffAnsweredAt: true,
  acceptedAt: true,
  rejectedAt: true,
  rejectReason: true,
  cancelledAt: true,
  cancelledBy: true,
  order: { select: { updatedAt: true } },
} satisfies Prisma.OnlineOrderSelect
type PedidoDeLaPausa = Prisma.OnlineOrderGetPayload<{ select: typeof PEDIDO_DE_LA_PAUSA }>

const minFecha = (xs: Array<Date | null | undefined>): Date | null =>
  xs.reduce<Date | null>((m, d) => (d && (!m || d.getTime() < m.getTime()) ? d : m), null)

/**
 * La PRIMERA vez que una persona hizo algo con este pedido (aceptar, rechazar, cancelar desde la caja o el panel), o `null`. Sólo
 * datos que escriben sus propias transiciones:
 * - `staffAnsweredAt` (D662 parte 2: el toque de una persona; con tarjeta, el paso a «cobrando»);
 * - `acceptedAt`: en «Mi equipo» toda aceptación la empieza una persona (cubre los pedidos de antes del cambio);
 * - `rejectedAt` con un motivo que elige una persona (el rechazo por pago, `PAYMENT_FAILED`, lo pone el sistema);
 * - la cancelación que no es de la clienta; si la cuenta se canceló desde la caja, la hora real es la de la cuenta (`updatedAt`): la
 *   sincronización del pedido la sella hasta la siguiente lectura (Codex p2-r1 #3).
 */
function horaDeLaPersona(p: PedidoDeLaPausa): Date | null {
  const cancelo = p.cancelledAt && p.cancelledBy !== 'CUSTOMER' ? minFecha([p.cancelledAt, p.cancelledBy === CANCELLED_ELSEWHERE ? p.order.updatedAt : null]) : null
  return minFecha([p.staffAnsweredAt, p.acceptedAt, p.rejectReason !== 'PAYMENT_FAILED' ? p.rejectedAt : null, cancelo])
}

/** El pedido terminó solo ANTES de su hora límite y sin una persona (la clienta lo canceló, o el sistema lo rechazó por pago). */
function terminoSoloATiempo(p: PedidoDeLaPausa): boolean {
  const limite = p.acceptDeadlineAt.getTime()
  if (p.cancelledBy === 'CUSTOMER' && p.cancelledAt && p.cancelledAt.getTime() <= limite) return true
  return p.rejectReason === 'PAYMENT_FAILED' && !p.staffAnsweredAt && !!p.rejectedAt && p.rejectedAt.getTime() <= limite
}

/**
 * D662 parte 2 (founder, 19-nov, «a»): la pausa sola se LEE, no se lleva. Es una línea de tiempo de dos clases de sucesos desde el
 * último «Reanudar» (`autoPauseResumedAt`):
 * - FALLA: un pedido llegó a su hora límite sin que una persona lo tocara (a la hora límite);
 * - RESPUESTA: una persona tocó un pedido (a la hora en que lo hizo, aunque su hora límite sea después; Codex p2-r1 #2).
 * La tienda está pausada si en algún momento hubo 2 FALLAS seguidas sin una RESPUESTA en medio, y se queda así hasta «Reanudar»
 * aunque después llegue una respuesta (Codex p2-r1 #1). Devuelve la hora de la segunda falla de la primera pareja (ISO) o `null`.
 * Los pedidos que terminaron solos antes de su hora límite no son ni falla ni respuesta. A la misma hora, la respuesta va primero.
 * Techos aceptados: T1 (quien ya estaba pagando termina) y T2 (la respuesta a tiempo que todavía se guarda): aquí no hay candados.
 */
export function pausaSolaDesde(pedidos: PedidoDeLaPausa[], now: Date): string | null {
  type Suceso = { t: number; falla: boolean }
  const sucesos: Suceso[] = []
  for (const p of pedidos) {
    if (terminoSoloATiempo(p)) continue
    const limite = p.acceptDeadlineAt.getTime()
    const persona = horaDeLaPersona(p)
    if (persona && persona.getTime() <= now.getTime()) sucesos.push({ t: persona.getTime(), falla: false })
    if (limite <= now.getTime() && !(persona && persona.getTime() <= limite)) sucesos.push({ t: limite, falla: true })
  }
  sucesos.sort((a, b) => a.t - b.t || Number(a.falla) - Number(b.falla))
  let seguidas = 0
  for (const s of sucesos) {
    seguidas = s.falla ? seguidas + 1 : 0
    if (seguidas >= 2) return new Date(s.t).toISOString()
  }
  return null
}

/** Los pedidos de «Mi equipo» con hora límite después del último «Reanudar» (los más recientes, acotados) y su lectura. */
async function leerPausaSola(venueId: string, now: Date, reanudadaEn: Date | null): Promise<string | null> {
  const pedidos = await prisma.onlineOrder.findMany({
    where: { venueId, requiresAcceptance: true, ...(reanudadaEn ? { acceptDeadlineAt: { gt: reanudadaEn } } : {}) },
    orderBy: [{ acceptDeadlineAt: 'desc' }, { id: 'desc' }],
    take: PAUSA_SOLA_VENTANA,
    select: PEDIDO_DE_LA_PAUSA,
  })
  return pausaSolaDesde(pedidos, now)
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
  if (config.requiresAcceptance !== false) autoPausedAt = await leerPausaSola(venueId, now, autoPauseResumedAt ?? null)
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
 * el vencimiento de un pedido después de su commit: si la tienda quedó pausada sola y ESTE pedido es el que la pausó (su hora límite es
 * `autoPausedAt`), escribe una fila. El CAS de vencer gana una sola vez por pedido, así que no se repite. Si el pedido que la pausó no
 * vence (la clienta lo canceló tarde, un rechazo tardío), no hay fila: aceptado. Nunca lanza.
 */
export async function registrarSiLaPausoSola(venueId: string, onlineOrderId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const st = await getAcceptingStatus(venueId, now)
    if (!st.autoPausedAt) return false
    const pedido = await prisma.onlineOrder.findFirst({
      where: { id: onlineOrderId, venueId },
      select: { acceptDeadlineAt: true, order: { select: { orderNumber: true } } },
    })
    if (!pedido || pedido.acceptDeadlineAt.toISOString() !== st.autoPausedAt) return false
    void logAction({
      staffId: null,
      venueId,
      action: 'ONLINE_ORDERING_AUTO_PAUSED',
      entity: 'OnlineOrderingSettings',
      entityId: venueId,
      data: { autoPausedAt: st.autoPausedAt, orderNumber: pedido.order.orderNumber, reason: '2 pedidos seguidos sin aceptar' },
    })
    return true
  } catch {
    return false
  }
}
