import { OnlineOrderStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { isWithinHours } from './hours'
import { MAX_PENDING_PER_VENUE, PRESENCE_WINDOW_MS, PRESENCE_WRITE_DEBOUNCE_MS } from './constants'
import { getSettings } from './settings.service'
import type { AcceptingReason, AcceptingState, AcceptingStatus } from './types'

// En memoria a propósito (una sola instancia): amortigua la escritura; la verdad es la columna.
const lastWrite = new Map<string, number>()

export function __resetPresenceDebounceForTests(): void {
  lastWrite.clear()
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
  const { lastInboxPollAt, ...config } = settings
  const timezone = venue?.timezone || 'America/Mexico_City'
  const done = (status: AcceptingStatus, reason: AcceptingReason): AcceptingState => ({ status, reason, config })

  if (!config.enabled) return done('DISABLED', 'NOT_ENABLED')
  if (config.manualPause || (config.pausedUntil && new Date(config.pausedUntil) > now)) return done('PAUSED', 'MANUAL_PAUSE')
  if (!isWithinHours(config.hours, now, timezone)) return done('CLOSED', 'OUTSIDE_HOURS')
  if (!lastInboxPollAt || now.getTime() - lastInboxPollAt.getTime() > PRESENCE_WINDOW_MS) return done('OFFLINE', 'NO_DEVICE')

  const pending = await prisma.onlineOrder.count({ where: { venueId, status: OnlineOrderStatus.PENDING_ACCEPTANCE } })
  if (pending >= MAX_PENDING_PER_VENUE) return done('PAUSED', 'TOO_BUSY')

  return done('OPEN', null)
}
