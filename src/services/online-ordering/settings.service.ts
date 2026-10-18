import { Prisma, type OnlineOrderingSettings } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { getCurrentPrivacyNotice } from '@/services/customer/consent.service'
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

export interface VenueContact {
  address: string | null
  phone: string | null
}

type VenueContactFields = {
  address?: string | null
  city?: string | null
  state?: string | null
  zipCode?: string | null
  phone?: string | null
}

/** Domicilio y teléfono del negocio como los ve el comensal: partes no vacías unidas con «, »; en blanco ⇒ `null`. */
export function buildVenueContact(venue: VenueContactFields): VenueContact {
  const address = [venue.address, venue.city, venue.state, venue.zipCode]
    .map(part => part?.trim())
    .filter(Boolean)
    .join(', ')
  return { address: address || null, phone: venue.phone?.trim() || null }
}

export type StoreRequirement = 'address' | 'phone' | 'privacyNotice'

/**
 * R18: encender exige domicilio (la CALLE: ciudad, estado o CP solos no bastan), teléfono y aviso de privacidad PUBLICADO (LFPC
 * 76 Bis y LFPDPPP: el responsable frente al comensal es el restaurante). La plantilla de precarga (`esPlantilla: true`) no es un
 * aviso publicado.
 */
export async function storeRequirements(venueId: string): Promise<Record<StoreRequirement, boolean>> {
  const [venue, notice] = await Promise.all([
    prisma.venue.findUnique({ where: { id: venueId }, select: { address: true, phone: true } }),
    getCurrentPrivacyNotice(venueId),
  ])
  return { address: !!venue?.address?.trim(), phone: !!venue?.phone?.trim(), privacyNotice: notice.esPlantilla === false }
}

const REQUIREMENT_LABEL: Record<StoreRequirement, string> = {
  address: 'el domicilio del negocio',
  phone: 'el teléfono del negocio',
  privacyNotice: 'el aviso de privacidad publicado',
}
/** «a», «a y b», «a, b y c» (el `lib` del tsconfig no trae `Intl.ListFormat`). */
const enLista = (xs: string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`)

async function assertStoreRequirements(venueId: string): Promise<void> {
  const met = await storeRequirements(venueId)
  const missing = (Object.keys(REQUIREMENT_LABEL) as StoreRequirement[]).filter(r => !met[r])
  if (missing.length === 0) return
  throw new BadRequestError(
    `Para encender la tienda ${missing.length === 1 ? 'falta' : 'faltan'} ${enLista(missing.map(r => REQUIREMENT_LABEL[r]))}.`,
    'STORE_REQUIREMENTS_MISSING',
    { missing },
  )
}

/**
 * A6 (P1-05): leer, combinar, validar y escribir van en UNA transacción con el candado del negocio (`pg_advisory_xact_lock`, sin
 * Redis): dos cambios simultáneos («encender» y «quitar pagar al recoger») se serializan y el segundo valida sobre el primero, así
 * nunca queda encendida sin medio de pago. El candado cubre también la primera creación (sin fila todavía). La bitácora va después.
 */
export async function updateSettings(
  venueId: string,
  patch: OnlineOrderingSettingsPatch,
  actorStaffId: string | null,
): Promise<OnlineOrderingConfig & { lastInboxPollAt: Date | null }> {
  const { row, preloadHours } = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'online-ordering-settings:' + venueId}))`

    const existing = await tx.onlineOrderingSettings.findUnique({ where: { venueId } })
    const current = existing ? rowToConfig(existing) : { ...DEFAULT_CONFIG, lastInboxPollAt: null }
    // R18: sólo al PASAR de apagada (o sin fila) a encendida; apagar, otros campos o repetir `enabled: true` nunca lo exigen. Se
    // decide sobre el estado leído bajo el candado; los requisitos son datos del negocio (fuera de este candado) y si falta algo
    // la transacción se deshace sin escribir.
    if (!current.enabled && patch.enabled === true) await assertStoreRequirements(venueId)
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
      const reservas = await tx.reservationSettings.findUnique({ where: { venueId }, select: { operatingHours: true } })
      if (isValidOrderingHours(reservas?.operatingHours)) preloadHours = reservas!.operatingHours as unknown as Prisma.InputJsonValue
    }

    const row = await tx.onlineOrderingSettings.upsert({
      where: { venueId },
      create: { ...(data as Prisma.OnlineOrderingSettingsUncheckedCreateInput), venueId, ...(preloadHours ? { hours: preloadHours } : {}) },
      update: data,
    })
    return { row, preloadHours }
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
