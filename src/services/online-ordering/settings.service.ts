import { Prisma, type OnlineOrderingSettings } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { normalizeLegacyActivityActor } from '@/lib/activityAuditActor'
import { logAction } from '@/services/dashboard/activity-log.service'
import type { HorarioSemanal } from '@/services/delivery-channels/core/deliveryHours.service'
import { isValidOrderingHours } from './hours'
import { findCardMerchant } from './card/merchant'
import { FOLIO_DEVICE_WINDOW_MS } from './constants'
import type { FloorPauseMinutes, OnlineOrderingConfig, OnlineOrderingSettingsPatch } from './types'

export const DEFAULT_CONFIG: OnlineOrderingConfig = {
  enabled: false,
  minOrderAmount: 0,
  defaultPrepMinutes: 15,
  acceptsPayAtPickup: true,
  // A (founder, 2-nov): la tarjeta viene PRENDIDA; cobra en cuanto el negocio tenga su Stripe listo (`findCardMerchant`).
  acceptsCardOnline: true,
  manualPause: false,
  pausedUntil: null,
  hours: null,
  // R37: toda fila nueva nace en «Mi equipo»; «Nadie» sólo lo pone quien lo manda.
  requiresAcceptance: true,
}

export type OnlineOrderingSettingsRead = OnlineOrderingConfig & { lastInboxPollAt: Date | null; lastToPayPollAt: Date | null }

function rowToConfig(row: OnlineOrderingSettings): OnlineOrderingSettingsRead {
  return {
    enabled: row.enabled,
    minOrderAmount: Number(row.minOrderAmount),
    defaultPrepMinutes: row.defaultPrepMinutes,
    acceptsPayAtPickup: row.acceptsPayAtPickup,
    acceptsCardOnline: row.acceptsCardOnline,
    manualPause: row.manualPause,
    pausedUntil: row.pausedUntil ? row.pausedUntil.toISOString() : null,
    hours: (row.hours as unknown as HorarioSemanal | null) ?? null,
    requiresAcceptance: row.requiresAcceptance,
    lastInboxPollAt: row.lastInboxPollAt ?? null,
    lastToPayPollAt: row.lastToPayPollAt ?? null,
  }
}

/** Ajustes del venue; sin fila devuelve los defaults (apagado). */
export async function getSettings(venueId: string): Promise<OnlineOrderingSettingsRead> {
  const row = await prisma.onlineOrderingSettings.findUnique({ where: { venueId } })
  return row ? rowToConfig(row) : { ...DEFAULT_CONFIG, lastInboxPollAt: null, lastToPayPollAt: null }
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
 * 76 Bis y LFPDPPP: el responsable frente al comensal es el restaurante). La plantilla de precarga no es un aviso publicado: «publicado»
 * ⇔ el negocio tiene al menos UNA versión propia (`getCurrentPrivacyNotice` devuelve `esPlantilla: false` justo entonces).
 *
 * r5: `db` es la conexión con la que se lee. `updateSettings` pasa su `tx`: leer con el cliente raíz mientras la transacción retiene
 * su conexión pedía una segunda por solicitud, y con el pool lleno de esperas del candado se atoraba hasta el timeout.
 */
export async function storeRequirements(
  venueId: string,
  db: Pick<Prisma.TransactionClient, 'venue' | 'privacyNoticeVersion'> = prisma,
): Promise<Record<StoreRequirement, boolean>> {
  const [venue, notice] = await Promise.all([
    db.venue.findUnique({ where: { id: venueId }, select: { address: true, phone: true } }),
    db.privacyNoticeVersion.findFirst({ where: { venueId }, select: { id: true } }),
  ])
  return { address: !!venue?.address?.trim(), phone: !!venue?.phone?.trim(), privacyNotice: !!notice }
}

const REQUIREMENT_LABEL: Record<StoreRequirement, string> = {
  address: 'el domicilio del negocio',
  phone: 'el teléfono del negocio',
  privacyNotice: 'el aviso de privacidad publicado',
}
/** «a», «a y b», «a, b y c» (el `lib` del tsconfig no trae `Intl.ListFormat`). */
const enLista = (xs: string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`)

async function assertStoreRequirements(
  venueId: string,
  db: Pick<Prisma.TransactionClient, 'venue' | 'privacyNoticeVersion'>,
): Promise<void> {
  const met = await storeRequirements(venueId, db)
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
  rawPatch: OnlineOrderingSettingsPatch,
  actorStaffId: string | null,
): Promise<OnlineOrderingSettingsRead> {
  // R9: «Nadie» se paga en caja, así que en el mismo parche `requiresAcceptance:false` gana sobre `acceptsPayAtPickup:false`.
  const patch: OnlineOrderingSettingsPatch = rawPatch.requiresAcceptance === false ? { ...rawPatch, acceptsPayAtPickup: true } : rawPatch
  const { row, bitacora, expresoLaTarjeta, cardFrom } = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'online-ordering-settings:' + venueId}))`

    const existing = await tx.onlineOrderingSettings.findUnique({ where: { venueId } })
    const current = existing ? rowToConfig(existing) : { ...DEFAULT_CONFIG, lastInboxPollAt: null, lastToPayPollAt: null }
    // R18: sólo al PASAR de apagada (o sin fila) a encendida; apagar, otros campos o repetir `enabled: true` nunca lo exigen. Se
    // decide sobre el estado leído bajo el candado; los requisitos son datos del negocio (fuera de este candado) pero se leen con
    // el `tx` (r5: nunca el cliente raíz aquí dentro) y si falta algo la transacción se deshace sin escribir.
    if (!current.enabled && patch.enabled === true) await assertStoreRequirements(venueId, tx)
    // A (founder, 2-nov): el switch de tarjeta es la PREFERENCIA del negocio y viene prendido; prenderlo no exige Stripe (la tienda
    // ofrece tarjeta sólo con un comercio cobrable, `getInfo`). Lo que sí se exige es no dejar la tienda sin cómo cobrar.
    // R16: la primera vez, el horario arranca con el de reservas si existe y es válido. Sin horario la tienda abriría 24 h; la
    // casa ya decidió lo contrario para reparto (`deliveryHours.service.ts`: equivocarse hacia 24/7 mete pedidos de madrugada).
    // H5 (r2): con la validación de PEDIDOS (admite 22:00–02:00), no la de reparto, que descartaría un horario nocturno.
    let preloadHours: Prisma.InputJsonValue | undefined
    if (!existing && patch.hours === undefined) {
      const reservas = await tx.reservationSettings.findUnique({ where: { venueId }, select: { operatingHours: true } })
      if (isValidOrderingHours(reservas?.operatingHours)) preloadHours = reservas!.operatingHours as unknown as Prisma.InputJsonValue
    }

    const merged = {
      ...current,
      ...patch,
      hours: patch.hours !== undefined ? patch.hours : (current.hours ?? (preloadHours as unknown as HorarioSemanal | undefined) ?? null),
    }
    // Tienda híbrida, sobre el estado COMBINADO (lo leído bajo el candado + el parche). `=== false` y no `!`: una fila sin el campo no es «Nadie».
    if (merged.requiresAcceptance === false) {
      if (!merged.acceptsPayAtPickup) throw new BadRequestError('Con "Nadie" se paga en caja', 'PAY_AT_PICKUP_REQUIRED')
      if (merged.enabled && !merged.hours) {
        throw new BadRequestError('Pon tu horario: con "Nadie", los folios se cancelan al cierre', 'HOURS_REQUIRED')
      }
      // Sólo al ENTRAR a «Nadie» con la tienda encendida (encender, o pasar a «Nadie» ya encendida); quien ya está ahí no lo repite.
      const yaEstabaAsi = current.enabled && current.requiresAcceptance === false
      const hayLatido = !!current.lastToPayPollAt && Date.now() - current.lastToPayPollAt.getTime() <= FOLIO_DEVICE_WINDOW_MS
      if (merged.enabled && !yaEstabaAsi && !hayLatido) {
        throw new ConflictError('Ningún aparato puede cobrar folios todavía: actualiza la terminal o el POS', 'NO_FOLIO_DEVICE')
      }
    }

    if (merged.enabled && !merged.acceptsPayAtPickup) {
      if (!merged.acceptsCardOnline) throw new BadRequestError('Activa al menos un medio de pago para recibir pedidos.', 'NO_PAYMENT_MODE')
      // Sólo tarjeta: se consulta Stripe al ENCENDER la tienda o al QUITAR pagar al recoger (R31: el panel manda sólo lo que cambió
      // —`buildPatch`— y el MCP lo que quiera; repetir los mismos valores con la cuenta caída no bloquea otros cambios, porque se
      // compara contra lo leído bajo el candado; la tienda ya se ve en pausa por sí sola).
      const llegaASoloTarjeta =
        (patch.enabled === true && !current.enabled) || (patch.acceptsPayAtPickup === false && current.acceptsPayAtPickup)
      if (llegaASoloTarjeta && !(await findCardMerchant(tx, venueId))) {
        throw new BadRequestError(
          'Sin «Pagar al recoger» la tienda sólo cobraría con tarjeta, y tu cuenta de Stripe todavía no puede cobrar: déjalo prendido o conecta tu Stripe en Ligas de pago.',
          'NO_PAYMENT_MODE',
        )
      }
    }

    const data: Prisma.OnlineOrderingSettingsUncheckedUpdateInput = {}
    if (patch.enabled !== undefined) data.enabled = patch.enabled
    if (patch.minOrderAmount !== undefined) data.minOrderAmount = patch.minOrderAmount
    if (patch.defaultPrepMinutes !== undefined) data.defaultPrepMinutes = patch.defaultPrepMinutes
    if (patch.acceptsPayAtPickup !== undefined) data.acceptsPayAtPickup = patch.acceptsPayAtPickup
    if (patch.acceptsCardOnline !== undefined) data.acceptsCardOnline = patch.acceptsCardOnline
    if (patch.requiresAcceptance !== undefined) data.requiresAcceptance = patch.requiresAcceptance
    if (patch.manualPause !== undefined) data.manualPause = patch.manualPause
    if (patch.pausedUntil !== undefined) data.pausedUntil = patch.pausedUntil ? new Date(patch.pausedUntil) : null
    if (patch.hours !== undefined) data.hours = patch.hours === null ? Prisma.DbNull : (patch.hours as unknown as Prisma.InputJsonValue)

    const row = await tx.onlineOrderingSettings.upsert({
      where: { venueId },
      create: { ...(data as Prisma.OnlineOrderingSettingsUncheckedCreateInput), venueId, ...(preloadHours ? { hours: preloadHours } : {}) },
      update: data,
    })
    const bitacora = {
      changed: Object.keys(patch),
      patch: JSON.parse(JSON.stringify(patch)),
      ...(patch.requiresAcceptance !== undefined && patch.requiresAcceptance !== current.requiresAcceptance
        ? { requiresAcceptance: { de: current.requiresAcceptance, a: patch.requiresAcceptance } }
        : {}),
      ...(preloadHours ? { horarioPrecargadoDeReservas: true } : {}),
    }
    // La tarjeta viene prendida para quien nunca expresó el switch, y eso se decide por esta entrada: va en la MISMA transacción,
    // para que el relleno nunca la adelante y no se pierda si falla. Lo demás sigue como auditoría de mejor esfuerzo, afuera.
    const expresoLaTarjeta = patch.acceptsCardOnline !== undefined
    if (expresoLaTarjeta) {
      const actor = normalizeLegacyActivityActor(actorStaffId, bitacora)
      await tx.activityLog.create({
        data: {
          staffId: actor.staffId,
          venueId,
          action: 'ONLINE_ORDERING_SETTINGS_UPDATED',
          entity: 'OnlineOrderingSettings',
          entityId: row.id,
          data: actor.data,
        },
      })
    }
    return { row, bitacora, expresoLaTarjeta, cardFrom: current.acceptsCardOnline }
  })

  if (!expresoLaTarjeta) {
    void logAction({
      staffId: actorStaffId,
      venueId,
      action: 'ONLINE_ORDERING_SETTINGS_UPDATED',
      entity: 'OnlineOrderingSettings',
      entityId: row.id,
      data: bitacora,
    })
  }

  if (row.acceptsCardOnline !== cardFrom) {
    void logAction({
      staffId: actorStaffId,
      venueId,
      action: 'ONLINE_ORDERING_CARD_TOGGLED',
      entity: 'OnlineOrderingSettings',
      entityId: row.id,
      data: { from: cardFrom, to: row.acceptsCardOnline },
    })
  }

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
