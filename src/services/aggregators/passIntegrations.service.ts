import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { env } from '@/config/env'
import { BadRequestError, ConflictError, InternalServerError, ServiceUnavailableError } from '@/errors/AppError'
import { withSerializableRetry } from '@/utils/serializableRetry'
import { utcTs } from '@/utils/sqlDates'
import { logAction } from '@/services/dashboard/activity-log.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { adapterFor } from './core/adapterRegistry'
import { encryptCredential, newWebhookToken } from './core/credentials'
import { autoConfirmVisit } from './core/visit.service'
import { countLiveFutureSessions, enqueueHorizonSessionsSync, enqueueLiveSessionsSync } from './passSessionSync'

export type PassProvider = 'TOTALPASS' | 'WELLHUB'
export type PassPlan = { id: string; name: string | null; code: string | null }
export type PassConnectionView = {
  provider: PassProvider
  available: boolean
  status: 'PENDING' | 'ACTIVE' | 'PAUSED' | 'REVOKED' | null
  externalPlaceName: string | null
  confirmMode: 'AUTO' | 'ON_VENUE_CHECKIN'
  lastError: string | null
  plans: PassPlan[]
  /** `productArchived`: la clase ya está archivada o dejó de ser clase; la liga sólo se puede conservar tal cual o quitar. */
  productLinks: Array<{
    productId: string
    productName: string
    externalPlanId: string
    externalPlanName: string | null
    productArchived: boolean
  }>
  updatedAt: string | null
}
export type PassIntegrationsOverview = {
  /** ¿El plan del negocio incluye los pases? Sin él (pausa suave) no se publican clases nuevas; lo ya publicado sigue. */
  planActive: boolean
  /** Siempre TOTALPASS y WELLHUB, en ese orden. */
  connections: PassConnectionView[]
  classProducts: { items: Array<{ id: string; name: string }>; total: number }
}

const PROVIDERS: PassProvider[] = ['TOTALPASS', 'WELLHUB']
/** Wellhub se conecta cuando exista su adaptador (Plan 4). */
const CONNECTABLE: Record<PassProvider, boolean> = { TOTALPASS: true, WELLHUB: false }
/** ponytail: un negocio con más de 200 clases ve el total y las primeras 200; ninguno llega hoy. */
const CLASS_PRODUCTS_TAKE = 200
const LINKS_TAKE = 200
/** Cambio a AUTO: tandas de 200 hasta que no quede ninguna; el tope (2,000) sólo protege de un volumen patológico. */
const AUTO_BATCH = 200
const AUTO_MAX_BATCHES = 10
const LIVE_RESERVATION = ['PENDING', 'CONFIRMED', 'CHECKED_IN'] as const

/** Lo que sale hacia el dashboard: nunca la credencial ni el token del webhook. */
const CONNECTION_SELECT = {
  id: true,
  provider: true,
  status: true,
  externalPlaceName: true,
  confirmMode: true,
  lastError: true,
  config: true,
  updatedAt: true,
  productLinks: {
    // También las de clases archivadas (o que dejaron de ser CLASS), marcadas: el worker las sigue publicando, así que el
    // estudio tiene que verlas para poder quitarlas.
    where: { active: true },
    select: { productId: true, externalPlanId: true, product: { select: { name: true, type: true, deletedAt: true } } },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: LINKS_TAKE,
  },
} satisfies Prisma.AggregatorConnectionSelect

type ConnectionRow = Prisma.AggregatorConnectionGetPayload<{ select: typeof CONNECTION_SELECT }>

/** Planes de la sucursal, sólo id (como texto), nombre y código: la respuesta de TotalPass repite la llave. */
export function normalizePlans(raw: unknown): PassPlan[] {
  const list = Array.isArray(raw) ? (raw as Array<{ id: unknown; name: unknown; code: unknown } | null>) : []
  return list
    .filter((p): p is { id: unknown; name: unknown; code: unknown } => !!p && (typeof p.id === 'number' || typeof p.id === 'string'))
    .map(p => ({ id: String(p.id), name: typeof p.name === 'string' ? p.name : null, code: typeof p.code === 'string' ? p.code : null }))
}

/**
 * Un error del proveedor puede repetir lo que le mandamos (la URL del webhook lleva su token; la llave pegada): sin URLs,
 * sin los secretos (también como ruta suelta o en JSON con barras escapadas, donde la expresión de URLs no los ve) y acotado.
 */
export function sanitizeProviderError(s: string, ...secrets: Array<string | null | undefined>): string {
  const noUrls = s.replace(/https?:\/\/\S+/gi, '<url>')
  return secrets.reduce<string>((acc, x) => (x ? acc.split(x).join('<secreto>') : acc), noUrls).slice(0, 300)
}

const label = (p: PassProvider) => (p === 'TOTALPASS' ? 'TotalPass' : 'Wellhub')
/** Una clase archivada o que dejó de ser CLASS: su liga se conserva tal cual o se quita, nunca se crea ni cambia de plan. */
const isArchived = (p: { type: string; deletedAt: Date | null }) => p.deletedAt !== null || p.type !== 'CLASS'
const plansOf = (config: Prisma.JsonValue | null): PassPlan[] => normalizePlans(((config ?? {}) as { plans?: unknown }).plans)

function viewOf(provider: PassProvider, row: ConnectionRow | null): PassConnectionView {
  const plans = row ? plansOf(row.config) : []
  const planName = new Map(plans.map(p => [p.id, p.name]))
  return {
    provider,
    available: CONNECTABLE[provider],
    status: row?.status ?? null,
    externalPlaceName: row?.externalPlaceName ?? null,
    confirmMode: row?.confirmMode ?? 'AUTO',
    lastError: row?.lastError ?? null,
    plans,
    productLinks: (row?.productLinks ?? []).map(l => ({
      productId: l.productId,
      productName: l.product.name,
      externalPlanId: l.externalPlanId,
      externalPlanName: planName.get(l.externalPlanId) ?? null,
      productArchived: isArchived(l.product),
    })),
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  }
}

const loadConnection = (venueId: string, provider: PassProvider): Promise<ConnectionRow | null> =>
  prisma.aggregatorConnection.findUnique({ where: { venueId_provider: { venueId, provider } }, select: CONNECTION_SELECT })

async function requireActive(venueId: string, provider: PassProvider): Promise<ConnectionRow> {
  const row = await loadConnection(venueId, provider)
  if (!row || row.status !== 'ACTIVE') throw new ConflictError(`Primero conecta ${label(provider)}.`, 'PASS_NOT_CONNECTED')
  return row
}

/** Rastro en ActivityLog, ya fuera de cualquier transacción (`logAction` nunca lanza). Nunca lleva la llave ni el token. */
function trail(venueId: string, staffId: string | null, action: string, data: Prisma.InputJsonObject): void {
  void logAction({ staffId: staffId ?? undefined, venueId, action, entity: 'AggregatorConnection', data })
}

export async function getPassIntegrationsOverview(venueId: string): Promise<PassIntegrationsOverview> {
  const rows = await prisma.aggregatorConnection.findMany({
    where: { venueId },
    select: CONNECTION_SELECT,
    orderBy: { provider: 'asc' },
    take: PROVIDERS.length,
  })
  const byProvider = new Map(rows.map(r => [r.provider as PassProvider, r]))
  const productWhere = { venueId, type: 'CLASS' as const, deletedAt: null }
  const [items, total, planActive] = await Promise.all([
    prisma.product.findMany({
      where: productWhere,
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: CLASS_PRODUCTS_TAKE,
    }),
    prisma.product.count({ where: productWhere }),
    venueHasFeatureAccess(venueId, 'AGGREGATOR_PASSES'),
  ])
  return { planActive, connections: PROVIDERS.map(p => viewOf(p, byProvider.get(p) ?? null)), classProducts: { items, total } }
}

/**
 * Traduce el fallo del proveedor a un error en español que dice qué pasó de verdad; si ya hay conexión, le deja el motivo
 * SANEADO en `lastError` (sin la llave pegada ni el token del webhook, `secrets`).
 */
async function failConnect(
  venueId: string,
  connectionId: string | null,
  r: { code: string; message: string },
  secrets: Array<string | null> = [],
): Promise<never> {
  if (connectionId) {
    await prisma.aggregatorConnection.update({
      where: { id: connectionId },
      data: { lastError: sanitizeProviderError(`${r.code}: ${r.message}`, ...secrets) },
    })
  }
  logger.warn(`[PASES] conectar TotalPass falló (venue ${venueId}): ${r.code}`)
  if (r.code === 'UNAUTHORIZED') {
    throw new BadRequestError(
      'TotalPass no reconoce esa llave. Revisa que sea la «place_api_key» de esta sucursal y vuelve a pegarla.',
      'PASS_KEY_REJECTED',
    )
  }
  if (r.code === 'PARTNER_KEY_MISSING')
    throw new InternalServerError('Falta la llave de integrador de Avoqado en el servidor. Avísanos a soporte.')
  // TotalPass sí respondió, pero sin lo que hace falta (sucursal o token de sesión).
  if (r.code === 'NO_PLACE_ID' || r.code === 'BAD_AUTH_RESPONSE') {
    throw new ServiceUnavailableError(
      'TotalPass respondió sin los datos de la sucursal. Intenta de nuevo; si sigue, avísanos a soporte.',
      'PASS_PROVIDER_BAD_RESPONSE',
    )
  }
  // Un 4xx (que no es 401 ni 429) es una negativa de TotalPass, no una caída: reintentar no lo arregla.
  if (/^HTTP_4\d\d$/.test(r.code) && r.code !== 'HTTP_429') {
    throw new BadRequestError(`TotalPass rechazó la conexión: ${sanitizeProviderError(r.message, ...secrets)}`, 'PASS_PROVIDER_REJECTED')
  }
  // Timeouts, red y 5xx.
  throw new ServiceUnavailableError('TotalPass no respondió. Intenta de nuevo en unos minutos.', 'PASS_PROVIDER_UNAVAILABLE')
}

/** Reserva la sucursal (índice único: frena a otro negocio aquí) como PENDING con la llave nueva. */
async function reservePlace(venueId: string, placeId: string, key: string, token: string): Promise<{ id: string; webhookToken: string }> {
  try {
    return await prisma.aggregatorConnection.upsert({
      where: { venueId_provider: { venueId, provider: 'TOTALPASS' } },
      create: {
        venueId,
        provider: 'TOTALPASS',
        externalPlaceId: placeId,
        credentialCiphertext: encryptCredential(key),
        webhookToken: token,
        status: 'PENDING',
      },
      // Sin `webhookToken`: el que ya está guardado es el que se suscribe (dos «conectar» a la vez no se pisan el secreto).
      update: {
        externalPlaceId: placeId,
        credentialCiphertext: encryptCredential(key),
        status: 'PENDING',
        lastError: null,
      },
      select: { id: true, webhookToken: true },
    })
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Prisma da el índice como columnas (['venueId','provider']) o como su nombre (…_venueId_provider_key).
      const target = err.meta?.target
      const fields = Array.isArray(target) ? target.join(',') : String(target ?? '')
      if (fields.includes('venueId')) {
        throw new ConflictError(
          'Ya se está conectando TotalPass desde otra ventana. Espera unos segundos y recarga.',
          'PASS_CONNECT_IN_PROGRESS',
        )
      }
      throw new ConflictError(
        'Esa sucursal de TotalPass ya está conectada a otro negocio de Avoqado. Desconéctala allá primero.',
        'PASS_PLACE_TAKEN',
      )
    }
    throw err
  }
}

/**
 * Conecta este negocio con su sucursal de TotalPass pegando la `place_api_key`. Orden (nadie le quita los webhooks a otro
 * negocio y un reintento no deja secretos distintos a cada lado): identificar la sucursal sin tocar nada allá → rechazar
 * si este negocio está ligado a OTRA sucursal → reservar la sucursal (índice único) reutilizando el token del webhook →
 * suscribir webhooks → ACTIVE con los planes, y volver a publicar lo que ya estaba ligado. Una conexión ya ACTIVE de esa
 * misma sucursal se refresca sin apagarla: la llave nueva sólo se guarda si `setup` sale bien.
 */
export async function connectTotalPass(venueId: string, placeApiKey: string, staffId: string | null): Promise<PassConnectionView> {
  const key = placeApiKey.trim()
  if (!key) throw new BadRequestError('Pega la llave de tu sucursal de TotalPass.')
  const baseUrl = env.BASE_URL?.replace(/\/+$/, '')
  if (!baseUrl) throw new InternalServerError('Falta BASE_URL en el servidor: TotalPass no tendría a dónde mandar las reservas.')
  const adapter = adapterFor('TOTALPASS')

  // 1) Identificar la sucursal SIN tocar sus webhooks.
  const who = await adapter.identify({
    id: `identify:${venueId}`,
    venueId,
    provider: 'TOTALPASS',
    externalPlaceId: null,
    credential: key,
    config: {},
  })
  if (!who.ok) return failConnect(venueId, null, who, [key])
  const placeId = who.externalPlaceId ?? null
  if (!placeId) return failConnect(venueId, null, { code: 'NO_PLACE_ID', message: 'TotalPass no devolvió la sucursal' })

  // 2) Este negocio ya está ligado a OTRA sucursal: sus clases, reservas y visitas son de aquélla. Primero desconectar.
  const existing = await prisma.aggregatorConnection.findUnique({
    where: { venueId_provider: { venueId, provider: 'TOTALPASS' } },
    select: { id: true, status: true, externalPlaceId: true, webhookToken: true },
  })
  if (existing?.externalPlaceId && existing.externalPlaceId !== placeId) {
    throw new ConflictError('Este negocio ya está conectado a otra sucursal de TotalPass. Desconéctala primero.', 'PASS_OTHER_PLACE')
  }

  // 3) Ya conectada y sana con esta misma sucursal («volver a pegar la llave» para refrescar los planes): no se apaga
  //    mientras se prueba la llave nueva. Sigue ACTIVE con la credencial anterior hasta que `setup` salga bien; si falla,
  //    el error se devuelve tal cual y nada cambia. PENDING queda sólo para una conexión que aún no se ha establecido.
  const refresh = existing?.status === 'ACTIVE' && existing.externalPlaceId === placeId
  // 3') Si no: reservar la sucursal ANTES de suscribir webhooks (el índice único frena a otro negocio aquí) y reutilizar el
  //    token: un reintento del mismo negocio no deja a TotalPass con un secreto y a Avoqado con otro.
  const conn = refresh
    ? { id: existing.id, webhookToken: existing.webhookToken }
    : await reservePlace(venueId, placeId, key, existing?.webhookToken ?? newWebhookToken())

  // 4) Suscribir webhooks y activar.
  const urls = {
    booking: `${baseUrl}/api/v1/webhooks/aggregators/totalpass/${conn.webhookToken}/booking`,
    checkin: `${baseUrl}/api/v1/webhooks/aggregators/totalpass/${conn.webhookToken}/checkin`,
  }
  const r = await adapter.setup(
    { id: conn.id, venueId, provider: 'TOTALPASS', externalPlaceId: placeId, credential: key, config: {} },
    urls,
  )
  // Al refrescar no se anota el fallo en la conexión: sigue sana con la credencial anterior.
  if (!r.ok) return failConnect(venueId, refresh ? null : conn.id, r, [conn.webhookToken, key])

  await prisma.$transaction(async tx => {
    const data = {
      externalPlaceName: r.externalPlaceName ?? who.externalPlaceName ?? null,
      config: { hasSlotConfirmation: true, plans: normalizePlans((r.data as { plans?: unknown } | undefined)?.plans) },
      lastError: null,
    }
    // Con candado de estado: un desconectar mientras corría `setup` la dejó REVOKED sin llave ni sucursal, y revivirla
    // como ACTIVE (o ponerle la llave nueva) mentiría («Conectado») y dejaría la bandeja fallando con un 401 que no pasó.
    const activated = refresh
      ? await tx.aggregatorConnection.updateMany({
          where: { id: conn.id, status: 'ACTIVE', externalPlaceId: placeId },
          data: { ...data, credentialCiphertext: encryptCredential(key) },
        })
      : await tx.aggregatorConnection.updateMany({ where: { id: conn.id, status: 'PENDING' }, data: { ...data, status: 'ACTIVE' } })
    if (activated.count === 0) {
      throw new ConflictError('La conexión cambió mientras se conectaba. Recarga y vuelve a intentar.', 'PASS_CONNECT_INTERRUPTED')
    }
    // Reconectar: lo que ya estaba ligado se vuelve a publicar con la credencial nueva.
    const links = await tx.aggregatorProductLink.findMany({
      where: { connectionId: conn.id, active: true },
      select: { productId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: LINKS_TAKE,
    })
    await enqueueHorizonSessionsSync(
      tx,
      venueId,
      links.map(l => l.productId),
      new Date(),
    )
  })
  trail(venueId, staffId, 'PASS_INTEGRATION_CONNECTED', { provider: 'TOTALPASS', externalPlaceName: r.externalPlaceName ?? null })
  return viewOf('TOTALPASS', await loadConnection(venueId, 'TOTALPASS'))
}

/**
 * Cuándo se le dice al proveedor «sí vino». Pasar a AUTO confirma solas las visitas en plazo que esperaban a la recepción
 * (registra la asistencia de su reserva y valida), igual que un check-in que llega en AUTO.
 */
export async function setPassConfirmMode(
  venueId: string,
  provider: PassProvider,
  mode: 'AUTO' | 'ON_VENUE_CHECKIN',
  staffId: string | null,
  now: Date = new Date(),
): Promise<PassConnectionView> {
  const row = await requireActive(venueId, provider)
  if (row.confirmMode === mode) return viewOf(provider, row)
  // Todo en una transacción: o cambia el modo con TODAS sus pendientes confirmadas, o no cambia nada (si se cortara a la
  // mitad, las que faltaran sólo las validaría el barrido, sin registrar su asistencia).
  await prisma.$transaction(
    async tx => {
      await tx.aggregatorConnection.update({ where: { id: row.id }, data: { confirmMode: mode } })
      if (mode !== 'AUTO') return
      // Cursor por id: reclamar una visita no la saca de PENDING, así que sin cursor se leerían las mismas otra vez.
      let after: string | null = null
      for (let batch = 1; ; batch++) {
        const pending: Array<{ id: string; venueId: string; connectionId: string; provider: string; reservationId: string | null }> =
          await tx.aggregatorVisit.findMany({
            where: { connectionId: row.id, status: 'PENDING', deadlineAt: { gt: now }, ...(after ? { id: { gt: after } } : {}) },
            select: { id: true, venueId: true, connectionId: true, provider: true, reservationId: true },
            orderBy: { id: 'asc' },
            take: AUTO_BATCH,
          })
        for (const v of pending) await autoConfirmVisit(tx, v, now)
        if (pending.length < AUTO_BATCH) return
        if (batch === AUTO_MAX_BATCHES) {
          logger.error(
            `[PASES] cambio a AUTO de la conexión ${row.id}: se alcanzó el tope de ${AUTO_BATCH * AUTO_MAX_BATCHES} visitas pendientes; ` +
              'las que queden las valida el barrido sin registrar su asistencia',
          )
          return
        }
        after = pending[pending.length - 1].id
      }
    },
    { timeout: 60_000 },
  )
  trail(venueId, staffId, 'PASS_INTEGRATION_CONFIRM_MODE', { provider, from: row.confirmMode, to: mode })
  return viewOf(provider, await loadConnection(venueId, provider))
}

/**
 * Deja ligadas exactamente estas clases (producto → plan del proveedor). Lo nuevo se publica en el horizonte; lo que sale
 * se da de baja allá. No desliga una clase con socios próximos o en curso, ni cambia el plan de una clase ya publicada.
 */
export async function setPassProductLinks(
  venueId: string,
  provider: PassProvider,
  links: Array<{ productId: string; externalPlanId: string }>,
  staffId: string | null,
  now: Date = new Date(),
): Promise<PassConnectionView> {
  const row = await requireActive(venueId, provider)
  const plans = plansOf(row.config)
  const ids = links.map(l => l.productId)

  // Sin filtrar por tipo ni archivo: una clase archivada ya ligada se puede conservar (se revisa en la transacción).
  const products = ids.length
    ? await prisma.product.findMany({
        where: { id: { in: ids }, venueId },
        select: { id: true, name: true, type: true, deletedAt: true },
        take: ids.length,
      })
    : []
  const productOf = new Map(products.map(p => [p.id, p]))
  const missing = ids.filter(id => !productOf.has(id))
  if (missing.length) throw new BadRequestError('Sólo se pueden ligar clases de este negocio.', 'PASS_NOT_A_CLASS', { productIds: missing })
  const knownPlans = new Set(plans.map(p => p.id))
  const codeOf = new Map(plans.map(p => [p.id, p.code]))
  const wanted = new Map(links.map(l => [l.productId, l.externalPlanId]))

  let removedCount = 0
  // SERIALIZABLE: la aceptación de reservas lee el vínculo en su propia transacción SERIALIZABLE (`decideTx`); si una
  // reserva entra mientras se desliga, una de las dos se reintenta y ya ve lo de la otra.
  await withSerializableRetry(async tx => {
    // La lectura de arriba pudo quedar vieja frente a un Desconectar: se relee aquí (SERIALIZABLE hace que uno de los dos se
    // reintente y vea al otro), para no dejar ligas activas sobre una conexión ya revocada.
    const stillActive = await tx.aggregatorConnection.findFirst({ where: { id: row.id, status: 'ACTIVE' }, select: { id: true } })
    if (!stillActive) throw new ConflictError(`Primero conecta ${label(provider)}.`, 'PASS_NOT_CONNECTED')
    const current = await tx.aggregatorProductLink.findMany({
      where: { connectionId: row.id, active: true },
      select: { productId: true, externalPlanId: true, product: { select: { name: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: LINKS_TAKE,
    })
    // Una clase archivada (o que ya no es CLASS) sólo se conserva con su liga tal cual; ligarla o cambiarle el plan, no.
    for (const l of links) {
      const p = productOf.get(l.productId)
      if (p && isArchived(p) && current.find(c => c.productId === l.productId)?.externalPlanId !== l.externalPlanId) {
        throw new BadRequestError(
          `«${p.name}» está archivada o ya no es una clase: no se puede ligar ni cambiarle el plan. Quítala de la lista.`,
          'PASS_NOT_A_CLASS',
          { productIds: [l.productId] },
        )
      }
    }
    // Sólo lo que CAMBIA (liga nueva o cambio de plan) se valida contra los planes de la sucursal: una liga que se conserva
    // tal cual pasa aunque su plan ya no aparezca (p. ej. una clase archivada), y sin planes se pueden quitar ligas. Sin
    // planes conocidos, un plan nuevo moriría en el proveedor (BAD_PLAN_ID) sin que el estudio lo vea.
    const changed = links.filter(l => current.find(c => c.productId === l.productId)?.externalPlanId !== l.externalPlanId)
    if (changed.length && !plans.length) {
      throw new BadRequestError(
        `No pudimos leer tus planes de ${label(provider)}. Vuelve a conectar la llave para actualizarlos.`,
        'PASS_PLANS_UNKNOWN',
      )
    }
    const unknown = changed.filter(l => !knownPlans.has(l.externalPlanId)).map(l => l.externalPlanId)
    if (unknown.length) {
      const available = plans.map(p => `${p.id} «${p.name ?? '?'}»`).join(', ')
      throw new BadRequestError(
        `Tu sucursal no tiene ese plan (${unknown.join(', ')}). Planes disponibles: ${available}.`,
        'PASS_UNKNOWN_PLAN',
      )
    }
    const removed = current.filter(c => !wanted.has(c.productId))
    for (const r of removed) {
      // Desligar la da de baja en el proveedor, que cancela a sus socios (incluso a quien ya se registró en una clase que
      // no ha terminado): primero que pasen o se cancelen aquí.
      const live = await tx.aggregatorBooking.count({
        where: {
          connectionId: row.id,
          decision: 'ACCEPTED',
          reservation: { productId: r.productId, status: { in: [...LIVE_RESERVATION] }, endsAt: { gt: now } },
        },
      })
      if (live > 0) {
        throw new ConflictError(
          `«${r.product.name}» tiene ${live} reserva(s) de ${label(provider)} próximas o en curso. Cancélalas desde la clase o espera a que terminen para desligarla.`,
          'PASS_PRODUCT_HAS_BOOKINGS',
        )
      }
    }
    for (const l of changed) {
      // También una liga ya desactivada: sus ocurrencias siguen vivas con el plan viejo hasta que el worker las da de baja.
      const prev =
        current.find(c => c.productId === l.productId) ??
        (await tx.aggregatorProductLink.findUnique({
          where: { connectionId_productId: { connectionId: row.id, productId: l.productId } },
          select: { externalPlanId: true, product: { select: { name: true } } },
        }))
      if (prev && prev.externalPlanId !== l.externalPlanId) {
        // El proveedor no cambia el plan de una ocurrencia ya publicada: hay que desligar (da de baja) y volver a ligar.
        const published = await countLiveFutureSessions(tx, venueId, row.id, l.productId, now)
        if (published > 0) {
          throw new ConflictError(
            `«${prev.product.name}» tiene clases publicadas con otro plan. Para cambiarlo, primero desliga la clase, espera unos minutos a que se den de baja y vuelve a ligarla.`,
            'PASS_PLAN_CHANGE_NEEDS_UNLINK',
          )
        }
      }
    }
    // Lo que se conserva tal cual no se reescribe (si su plan ya no está en la lista, se perdería su código).
    for (const l of changed) {
      const externalPlanCode = codeOf.get(l.externalPlanId) ?? null
      await tx.aggregatorProductLink.upsert({
        where: { connectionId_productId: { connectionId: row.id, productId: l.productId } },
        create: { connectionId: row.id, venueId, productId: l.productId, externalPlanId: l.externalPlanId, externalPlanCode },
        update: { externalPlanId: l.externalPlanId, externalPlanCode, active: true },
      })
    }
    if (removed.length) {
      await tx.aggregatorProductLink.updateMany({
        where: { connectionId: row.id, productId: { in: removed.map(r => r.productId) } },
        data: { active: false },
      })
      await enqueueLiveSessionsSync(
        tx,
        venueId,
        row.id,
        removed.map(r => r.productId),
        now,
      )
    }
    await enqueueHorizonSessionsSync(
      tx,
      venueId,
      changed.map(l => l.productId),
      now,
    )
    removedCount = removed.length
  })
  trail(venueId, staffId, 'PASS_INTEGRATION_PRODUCTS_UPDATED', { provider, linked: links.length, removed: removedCount })
  return viewOf(provider, await loadConnection(venueId, provider))
}

/**
 * Ocurrencias vivas a futuro de la conexión cuya baja el worker ya dio por perdida: tienen una fila SYNC_SESSION en
 * DEAD_LETTER y ninguna otra en camino. La llave repite el formato de `enqueuePassOutbox`.
 */
async function countAbandonedUnpublish(tx: Prisma.TransactionClient, connectionId: string, now: Date): Promise<number> {
  const [r] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM "AggregatorSessionLink" l
    WHERE l."connectionId" = ${connectionId}
      AND l.live = true
      AND l."publishedStartsAt" > ${utcTs(now)}
      AND EXISTS (
        SELECT 1 FROM "AggregatorOutbox" o
        WHERE o."coalesceKey" = 'SYNC_SESSION:' || l."connectionId" || ':' || l."classSessionId" AND o.status = 'DEAD_LETTER'
      )
      AND NOT EXISTS (
        SELECT 1 FROM "AggregatorOutbox" o
        WHERE o."coalesceKey" = 'SYNC_SESSION:' || l."connectionId" || ':' || l."classSessionId"
          AND o.status IN ('PENDING', 'FAILED', 'IN_PROGRESS')
      )
  `
  return r?.n ?? 0
}

/**
 * Desconecta una conexión ACTIVE sin reservas de socios próximas o en curso, sin check-ins por confirmar en plazo y sin
 * ocurrencias vivas a futuro (nadie pierde un cobro ni queda una clase publicada huérfana). Si aún tiene clases ligadas,
 * las desliga sola, encola su baja allá (la llave todavía sirve) y pide volver a presionar en unos minutos (R65). Una que
 * no está ACTIVE (REVOKED por un 401, PENDING tras reconectar mal, PAUSED) se desconecta siempre: desliga todo y deja dicho
 * lo que quedó publicado allá. En los dos casos borra la credencial y libera la sucursal.
 */
export async function disconnectPassProvider(
  venueId: string,
  provider: PassProvider,
  staffId: string | null,
  now: Date = new Date(),
): Promise<void> {
  const row = await prisma.aggregatorConnection.findUnique({
    where: { venueId_provider: { venueId, provider } },
    select: { id: true, status: true, credentialCiphertext: true, externalPlaceId: true },
  })
  // Nada que limpiar: nunca conectado, o ya desconectado. (Una conexión REVOKED por un 401 todavía guarda la sucursal y la
  // credencial: ésa SÍ se limpia.)
  if (!row || (row.status === 'REVOKED' && !row.credentialCiphertext && !row.externalPlaceId)) return
  const livePublished = { connectionId: row.id, live: true, publishedStartsAt: { gt: now } }
  const liveBookings = {
    connectionId: row.id,
    decision: 'ACCEPTED' as const,
    reservation: { status: { in: [...LIVE_RESERVATION] }, endsAt: { gt: now } },
  }
  const revoke = { status: 'REVOKED' as const, credentialCiphertext: null, externalPlaceId: null, lastError: null }

  if (row.status !== 'ACTIVE') {
    // R41: sin una llave que funcione no se puede dar de baja nada allá, así que bloquear sólo dejaría al estudio atado a la
    // sucursal. Se desliga todo aquí; lo que quedó publicado allá lo quita el estudio desde el portal del proveedor. Las
    // ocurrencias quedan sin vida: al reconectar este registro (aun a otra sucursal) el worker no las toma por suyas.
    const [leftPublished, futureBookings] = await Promise.all([
      prisma.aggregatorSessionLink.count({ where: livePublished }),
      prisma.aggregatorBooking.count({ where: liveBookings }),
    ])
    logger.warn(
      `[PASES] desconexión de ${provider} sin llave válida (venue ${venueId}, conexión ${row.status}): ` +
        `${leftPublished} clases quedan publicadas allá y ${futureBookings} reservas de socios próximas; se quitan desde el portal del proveedor`,
    )
    await prisma.$transaction(async tx => {
      await tx.aggregatorProductLink.updateMany({ where: { connectionId: row.id, active: true }, data: { active: false } })
      await tx.aggregatorSessionLink.updateMany({ where: { connectionId: row.id, live: true }, data: { live: false } })
      await tx.aggregatorConnection.update({ where: { id: row.id }, data: revoke })
    })
    trail(venueId, staffId, 'PASS_INTEGRATION_DISCONNECTED', { provider, forced: true, leftPublished, futureBookings })
    return
  }

  const blocked = (blockers: string[]) =>
    new ConflictError(`Todavía no se puede desconectar ${label(provider)}: ${blockers.join(' · ')}.`, 'PASS_DISCONNECT_BLOCKED')
  // SERIALIZABLE, como desligar a mano (`setPassProductLinks`): una reserva que entra a la vez se reintenta y ya ve la liga
  // apagada, y una liga que se prende a la vez no se queda viva con la conexión ya revocada. Lo que se encola aquí sólo
  // cuenta si la transacción termina: por eso los «todavía no» de los pasos 2 y 3 se lanzan ya fuera.
  const outcome = await withSerializableRetry(async (tx): Promise<{ unlinked: number } | { live: number; abandoned: number } | null> => {
    // 1) Esas clases sí van a ocurrir: no se toca nada.
    const [futureBookings, pendingVisits] = await Promise.all([
      tx.aggregatorBooking.count({ where: liveBookings }),
      tx.aggregatorVisit.count({ where: { connectionId: row.id, status: 'PENDING', deadlineAt: { gt: now } } }),
    ])
    const blockers: string[] = []
    if (futureBookings > 0)
      blockers.push(
        futureBookings === 1 ? '1 reserva de socio próxima o en curso' : `${futureBookings} reservas de socios próximas o en curso`,
      )
    // «Sin resolver», no «por confirmar»: algunas ya las confirmó el estudio y sólo esperan al proveedor.
    if (pendingVisits > 0)
      blockers.push(
        pendingVisits === 1
          ? `1 check-in todavía sin resolver con ${label(provider)} (espera a que se confirme o venza)`
          : `${pendingVisits} check-ins todavía sin resolver con ${label(provider)} (espera a que se confirmen o venzan)`,
      )
    if (blockers.length) throw blocked(blockers)
    // 2) Clases ligadas: se desligan aquí y el worker las da de baja allá (la conexión sigue ACTIVE).
    const links = await tx.aggregatorProductLink.findMany({
      where: { connectionId: row.id, active: true },
      select: { productId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: LINKS_TAKE,
    })
    if (links.length) {
      const productIds = links.map(l => l.productId)
      await tx.aggregatorProductLink.updateMany({ where: { connectionId: row.id, productId: { in: productIds } }, data: { active: false } })
      await enqueueLiveSessionsSync(tx, venueId, row.id, productIds, now)
      return { unlinked: links.length }
    }
    // 3) Ya sin ligas, pero quedan clases publicadas allá. Se vuelve a encolar su baja: una que el worker ya dio por perdida
    //    (DEAD_LETTER) no se junta con nada, así que nace otra y se reintenta; sin esto, el siguiente clic esperaría para
    //    siempre algo que nadie hará. Antes se cuentan las abandonadas (DEAD_LETTER sin otra baja en camino).
    const live = await tx.aggregatorSessionLink.count({ where: livePublished })
    if (live > 0) {
      const abandoned = await countAbandonedUnpublish(tx, row.id, now)
      await enqueueLiveSessionsSync(tx, venueId, row.id, null, now)
      return { live, abandoned }
    }
    // 4) Nada pendiente.
    await tx.aggregatorConnection.update({ where: { id: row.id }, data: revoke })
    return null
  })
  if (outcome && 'unlinked' in outcome) {
    const { unlinked } = outcome
    trail(venueId, staffId, 'PASS_INTEGRATION_PRODUCTS_UPDATED', { provider, linked: 0, removed: unlinked, reason: 'disconnect' })
    const clases = unlinked === 1 ? 'tu 1 clase' : `tus ${unlinked} clases`
    throw new ConflictError(
      `Estamos quitando ${clases} de ${label(provider)}. Vuelve a presionar Desconectar en unos minutos.`,
      'PASS_DISCONNECT_UNLINKING',
    )
  }
  if (outcome) {
    if (outcome.abandoned > 0) {
      logger.warn(`[PASES] desconectar ${provider} (venue ${venueId}): ${outcome.abandoned} bajas habían fallado; se re-encolaron`)
      const [clases, la, borrala] =
        outcome.abandoned === 1 ? ['1 clase', 'la', 'bórrala'] : [`${outcome.abandoned} clases`, 'las', 'bórralas']
      throw new ConflictError(
        `No pudimos quitar ${clases} de ${label(provider)}; ${la} volvimos a intentar. Si sigue, ${borrala} desde su portal y vuelve a presionar Desconectar.`,
        'PASS_DISCONNECT_BLOCKED',
      )
    }
    throw blocked([
      outcome.live === 1
        ? '1 clase todavía publicada (espera unos minutos a que se dé de baja)'
        : `${outcome.live} clases todavía publicadas (espera unos minutos a que se den de baja)`,
    ])
  }
  trail(venueId, staffId, 'PASS_INTEGRATION_DISCONNECTED', { provider })
}
