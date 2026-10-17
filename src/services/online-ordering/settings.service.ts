import { Prisma, type OnlineOrderingSettings } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import type { HorarioSemanal } from '@/services/delivery-channels/core/deliveryHours.service'
import { isValidOrderingHours } from './hours'
import type { FloorPauseMinutes, OnlineOrderingConfig, OnlineOrderingSettingsPatch } from './types'

export const DEFAULT_CONFIG: OnlineOrderingConfig = {
  enabled: false,
  minOrderAmount: 0,
  defaultPrepMinutes: 15,
  acceptsPayAtPickup: true,
  manualPause: false,
  pausedUntil: null,
  hours: null,
}

function rowToConfig(row: OnlineOrderingSettings): OnlineOrderingConfig & { lastInboxPollAt: Date | null } {
  return {
    enabled: row.enabled,
    minOrderAmount: Number(row.minOrderAmount),
    defaultPrepMinutes: row.defaultPrepMinutes,
    acceptsPayAtPickup: row.acceptsPayAtPickup,
    manualPause: row.manualPause,
    pausedUntil: row.pausedUntil ? row.pausedUntil.toISOString() : null,
    hours: (row.hours as unknown as HorarioSemanal | null) ?? null,
    lastInboxPollAt: row.lastInboxPollAt ?? null,
  }
}

/** Ajustes del venue; sin fila devuelve los defaults (apagado). */
export async function getSettings(venueId: string): Promise<OnlineOrderingConfig & { lastInboxPollAt: Date | null }> {
  const row = await prisma.onlineOrderingSettings.findUnique({ where: { venueId } })
  return row ? rowToConfig(row) : { ...DEFAULT_CONFIG, lastInboxPollAt: null }
}

export async function updateSettings(
  venueId: string,
  patch: OnlineOrderingSettingsPatch,
  actorStaffId: string | null,
): Promise<OnlineOrderingConfig> {
  const existing = await prisma.onlineOrderingSettings.findUnique({ where: { venueId } })
  const current = existing ? rowToConfig(existing) : { ...DEFAULT_CONFIG, lastInboxPollAt: null }
  const merged = { ...current, ...patch }
  if (merged.enabled && !merged.acceptsPayAtPickup) {
    throw new BadRequestError('Activa al menos un medio de pago para recibir pedidos.', 'NO_PAYMENT_MODE')
  }

  const data: Prisma.OnlineOrderingSettingsUncheckedUpdateInput = {}
  if (patch.enabled !== undefined) data.enabled = patch.enabled
  if (patch.minOrderAmount !== undefined) data.minOrderAmount = patch.minOrderAmount
  if (patch.defaultPrepMinutes !== undefined) data.defaultPrepMinutes = patch.defaultPrepMinutes
  if (patch.acceptsPayAtPickup !== undefined) data.acceptsPayAtPickup = patch.acceptsPayAtPickup
  if (patch.manualPause !== undefined) data.manualPause = patch.manualPause
  if (patch.pausedUntil !== undefined) data.pausedUntil = patch.pausedUntil ? new Date(patch.pausedUntil) : null
  if (patch.hours !== undefined) data.hours = patch.hours === null ? Prisma.DbNull : (patch.hours as unknown as Prisma.InputJsonValue)

  // R16: la primera vez, el horario arranca con el de reservas si existe y es válido. Sin horario la tienda abriría 24 h; la
  // casa ya decidió lo contrario para reparto (`deliveryHours.service.ts`: equivocarse hacia 24/7 mete pedidos de madrugada).
  // H5 (r2): con la validación de PEDIDOS (admite 22:00–02:00), no la de reparto, que descartaría un horario nocturno.
  let preloadHours: Prisma.InputJsonValue | undefined
  if (!existing && patch.hours === undefined) {
    const reservas = await prisma.reservationSettings.findUnique({ where: { venueId }, select: { operatingHours: true } })
    if (isValidOrderingHours(reservas?.operatingHours)) preloadHours = reservas!.operatingHours as unknown as Prisma.InputJsonValue
  }

  const row = await prisma.onlineOrderingSettings.upsert({
    where: { venueId },
    create: { ...(data as Prisma.OnlineOrderingSettingsUncheckedCreateInput), venueId, ...(preloadHours ? { hours: preloadHours } : {}) },
    update: data,
  })

  void logAction({
    staffId: actorStaffId,
    venueId,
    action: 'ONLINE_ORDERING_SETTINGS_UPDATED',
    entity: 'OnlineOrderingSettings',
    entityId: row.id,
    data: {
      changed: Object.keys(patch),
      patch: JSON.parse(JSON.stringify(patch)),
      ...(preloadHours ? { horarioPrecargadoDeReservas: true } : {}),
    },
  })

  return rowToConfig(row)
}

/**
 * R12: se frena la tienda 15, 30 o 60 minutos —o se reanuda con `null`— con el permiso `online-orders:pause` (D7, founder
 * 16-oct: gerente para arriba por default, otorgable; en el POS, con el PIN del gerente). Sólo toca `pausedUntil`; la pausa del
 * gerente (`manualPause`) sigue en ajustes, y la respuesta la incluye (M-8): reanudar con ella puesta deja la tienda frenada.
 * No crea la fila: pausar una tienda que nunca se configuró no tiene sentido (y crearla aquí se saltaría la precarga del horario).
 */
export async function pauseOnlineOrdering(
  venueId: string,
  minutes: FloorPauseMinutes | null,
  actorStaffId: string | null,
  now: Date = new Date(),
): Promise<{ pausedUntil: string | null; manualPause: boolean }> {
  const pausedUntil = minutes === null ? null : new Date(now.getTime() + minutes * 60_000)
  const r = await prisma.onlineOrderingSettings.updateMany({ where: { venueId }, data: { pausedUntil } })
  if (r.count === 0) {
    throw new BadRequestError('La tienda en línea de este negocio todavía no está configurada.', 'ONLINE_ORDERING_NOT_CONFIGURED')
  }
  const current = await prisma.onlineOrderingSettings.findUnique({ where: { venueId }, select: { manualPause: true } })
  void logAction({
    staffId: actorStaffId,
    venueId,
    action: minutes === null ? 'ONLINE_ORDERING_RESUMED' : 'ONLINE_ORDERING_PAUSED',
    entity: 'OnlineOrderingSettings',
    entityId: venueId,
    data: { minutes, pausedUntil: pausedUntil ? pausedUntil.toISOString() : null },
  })
  return { pausedUntil: pausedUntil ? pausedUntil.toISOString() : null, manualPause: current?.manualPause ?? false }
}
