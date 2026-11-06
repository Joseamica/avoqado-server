import prisma from '@/utils/prismaClient'
import { isWithinHours } from './hours'
import { MAX_PENDING_PER_VENUE, PRESENCE_WINDOW_MS, PRESENCE_WRITE_DEBOUNCE_MS, awaitingAcceptanceWhere, liveCardDraftsWhere } from './constants'
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

/** Lo que el panel, la bandeja y el MCP muestran del estado de la tienda: un solo armado. */
export function storeView(state: AcceptingState) {
  return { status: state.status, reason: state.reason, pausedUntil: state.config.pausedUntil, manualPause: state.config.manualPause }
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
  const { lastInboxPollAt, lastToPayPollAt, ...config } = settings
  const timezone = venue?.timezone || 'America/Mexico_City'
  const done = (status: AcceptingStatus, reason: AcceptingReason): AcceptingState => ({ status, reason, config })

  if (!config.enabled) return done('DISABLED', 'NOT_ENABLED')
  if (config.manualPause || (config.pausedUntil && new Date(config.pausedUntil) > now)) return done('PAUSED', 'MANUAL_PAUSE')
  if (!isWithinHours(config.hours, now, timezone)) return done('CLOSED', 'OUTSIDE_HOURS')
  // «Nadie» (`=== false`: una fila sin el campo no lo es) cuenta a quien puede cobrar folios; «Mi equipo», a la Bandeja abierta.
  const latido = config.requiresAcceptance === false ? lastToPayPollAt : lastInboxPollAt
  if (!latido || now.getTime() - latido.getTime() > PRESENCE_WINDOW_MS) return done('OFFLINE', 'NO_DEVICE')

  // Fase 2: los borradores de tarjeta vigentes también ocupan lugar (el tope de admisión los cuenta igual).
  const pending =
    (await prisma.onlineOrder.count({ where: awaitingAcceptanceWhere(venueId) })) +
    (await prisma.onlineOrderCharge.count({ where: liveCardDraftsWhere(venueId, now) }))
  if (pending >= MAX_PENDING_PER_VENUE) return done('PAUSED', 'TOO_BUSY')

  return done('OPEN', null)
}
