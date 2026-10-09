// src/services/commerce-channels/shopify/shopify.connect.service.ts
/**
 * La llave (spec §4 ①, 12 bis.3, 12 bis.6, 12 bis.15; plan v2 B3): OAuth de un solo uso, ubicación verificada con el
 * token, confirmar con el candado del catálogo maestro, las reglas de generación del índice §3 y las barreras de envío en
 * camino, vista previa paginada con lo que quedará, aplicar por tandas, webhooks de uno en uno, pausar/reanudar por plan
 * y desconectar.
 * Orden de candados (§10.3): cerca de gobierno → sucursales (por id) → tienda → pareja → Inventory → buzón/revisión →
 * evento. Una credencial nueva entra SÓLO por `renovarCredencial` (§11.4), que toma TODAS las sucursales de la tienda por
 * id antes de la tienda (R6/S4): tomar la tienda primero se traba con diferir, el drenado y `cercoVigente`.
 */
import { Prisma, type ShopifyAppKey, type ShopifyConnectIntent, type ShopifyIntentPurpose, type ShopifyLinkStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { env } from '@/config/env'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '@/errors/AppError'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { assertLegacyCatalogGovernanceForVenue } from '@/services/master-catalog/catalogGovernance.service'
import { utcTs } from '@/utils/sqlDates'
import { SHOPIFY_FEATURE, SHOPIFY_SCOPES, SHOPIFY_SERVICE_ACTOR, SHOPIFY_WEBHOOK_TOPICS } from './shopify.constants'
import { appCredentials, encryptShopifyToken, isValidShopDomain, readIntentId, signIntentId, verifyOAuthQueryHmac } from './shopify.crypto'
import { exchangeOAuthCode, shopifyGraphql, type ShopifyFailure } from './shopify.graphql'
import {
  cercoVigente,
  fetchLevels,
  initializePair,
  levelKey,
  SHOPIFY_IMPORT_ERRORES_TERMINALES,
  type CercoShopify,
} from './shopify.mirror.service'
import { shopifyWebhookPath } from './shopify.inbound.service'
import {
  atenderFalla,
  conCerco,
  conVencimiento,
  envioEnCamino,
  FALTA_PERMISO,
  leerNiveles,
  leerToken,
  MIN_ESCRITURA_MS,
  restante,
  SIN_TIEMPO,
  TOKEN_ILEGIBLE,
} from './shopify.store.service'

export const SHOPIFY_OAUTH_CALLBACK_PATH = '/api/v1/shopify/oauth/callback'
// ponytail: una sola app hasta la App 2 pública (Fase 5); la tienda guarda con cuál se conectó.
const APP_KEY = 'PILOTO' as const
const INTENT_TTL_MS = 10 * 60_000
const SELECCION_TTL_MS = 15 * 60_000
const TANDA_APLICAR = 50
const MAX_PAGINAS_UBICACIONES = 40
/** BR-3: lo que devuelve una unidad que espera a que termine un envío de una conexión anterior. */
const ENVIO_EN_CAMINO = 'ENVIO_EN_CAMINO'
/** K13: estas tx bloquean todas las sucursales de una tienda, o una sucursal con sus parejas; 5 s se quedan cortos con carga. */
const TX_LARGA = { timeout: 15_000 }
const apiBase = () => (env.BASE_URL ?? 'https://api.avoqado.io').replace(/\/+$/, '')
const panel = () => env.FRONTEND_URL.replace(/\/+$/, '')
/** Fase 1 (12 bis.15): sólo las tiendas invitadas. Se lee en cada llamada para poder sumar una sin reiniciar el proceso. */
const tiendasPiloto = () =>
  new Set(
    (process.env.SHOPIFY_PILOTO_SHOPS ?? '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  )
const accesoReal = (venueId: string) => venueHasFeatureAccess(venueId, SHOPIFY_FEATURE)
const terminal = (e: string | null): e is string => e !== null && SHOPIFY_IMPORT_ERRORES_TERMINALES.includes(e)
/** R3 / B-4: el plan UNA vez por unidad; la primera pregunta se hace donde toca (dentro de la tx que lo revalida). */
function unaVez(f: (venueId: string) => Promise<boolean>): (venueId: string) => Promise<boolean> {
  let r: Promise<boolean> | undefined
  return venueId => (r ??= f(venueId))
}

/** `write_x` implica `read_x`, y Shopify puede devolver sólo el de escritura. */
function faltanPermisos(scope: string): string[] {
  const dados = new Set(
    scope
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  )
  return SHOPIFY_SCOPES.split(',').filter(s => !dados.has(s) && !(s.startsWith('read_') && dados.has(`write_${s.slice(5)}`)))
}

// ─── Iniciar y callback ─────────────────────────────────────────────────────────────────────────────────────

export async function startShopifyConnect(i: {
  venueId: string
  authUserId: string
  shopDomain: string
  purpose: ShopifyIntentPurpose
}): Promise<{ url: string }> {
  const shop = String(i.shopDomain ?? '')
    .trim()
    .toLowerCase()
  if (!isValidShopDomain(shop))
    throw new BadRequestError('Escribe el dominio de tu tienda, el que termina en .myshopify.com', 'SHOPIFY_DOMINIO_INVALIDO')
  if (!tiendasPiloto().has(shop)) {
    throw new ConflictError(
      'La conexión con Shopify está en piloto y por ahora sólo se abre para tiendas invitadas. Escríbenos y te sumamos.',
      'SHOPIFY_SOLO_PILOTO',
    )
  }
  const creds = appCredentials(APP_KEY)
  if (!creds) throw new ServiceUnavailableError('Falta configurar la app de Shopify en el servidor', 'SHOPIFY_SIN_CREDENCIALES')
  const venue = await prisma.venue.findUnique({ where: { id: i.venueId }, select: { organizationId: true } })
  if (!venue) throw new NotFoundError('Sucursal no encontrada')
  if (i.purpose === 'REAUTHORIZE') {
    const link = await prisma.shopifyLocationLink.findUnique({
      where: { venueId: i.venueId },
      select: { status: true, store: { select: { shopDomain: true } } },
    })
    if (!link || link.status === 'DISCONNECTED' || link.store.shopDomain !== shop) {
      throw new ConflictError('Esta sucursal no está conectada a esa tienda; usa «Conectar»', 'SHOPIFY_REAUTORIZAR_SIN_TIENDA')
    }
  } else {
    // Catálogo maestro (spec §3, «no se soporta»): se dice ANTES de mandar al dueño a Shopify.
    await prisma.$transaction(tx =>
      assertLegacyCatalogGovernanceForVenue(tx, {
        venueId: i.venueId,
        operation: 'CREATE',
        willBeVendable: true,
        actor: SHOPIFY_SERVICE_ACTOR,
      }),
    )
  }
  const intent = await prisma.shopifyConnectIntent.create({
    data: {
      venueId: i.venueId,
      authUserId: i.authUserId,
      shopDomain: shop,
      appKey: APP_KEY,
      purpose: i.purpose,
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
    },
    select: { id: true },
  })
  logAction({
    venueId: i.venueId,
    organizationId: venue.organizationId,
    staffId: i.authUserId,
    action: 'SHOPIFY_CONNECT_STARTED',
    entity: 'ShopifyConnectIntent',
    entityId: intent.id,
    data: { tienda: shop, purpose: i.purpose },
  })
  const u = new URL(`https://${shop}/admin/oauth/authorize`)
  u.searchParams.set('client_id', creds.clientId)
  u.searchParams.set('scope', SHOPIFY_SCOPES)
  u.searchParams.set('redirect_uri', `${apiBase()}${SHOPIFY_OAUTH_CALLBACK_PATH}`)
  u.searchParams.set('state', signIntentId(intent.id))
  return { url: u.toString() }
}

/**
 * GET del callback (sin sesión: depende sólo del `state` firmado, nunca de una cookie del dashboard). Devuelve la URL a
 * la que se redirige. El intent se reclama ANTES del HTTP (#26). Nada de aquí registra el código, el token ni el secreto.
 */
export async function handleShopifyCallback(
  query: Record<string, string>,
  deps: { exchange?: typeof exchangeOAuthCode } = {},
): Promise<string> {
  const exchange = deps.exchange ?? exchangeOAuthCode
  const state = typeof query.state === 'string' ? query.state : null
  const intentId = state ? readIntentId(state) : null
  const intent = intentId ? await prisma.shopifyConnectIntent.findUnique({ where: { id: intentId } }) : null
  const venue = intent
    ? await prisma.venue.findUnique({ where: { id: intent.venueId }, select: { slug: true, organizationId: true } })
    : null
  const pagina = venue ? `${panel()}/venues/${venue.slug}/settings/integrations/shopify` : `${panel()}/`
  // Plan C: ?intent=<firmado> (CONNECT), ?reautorizada=1 (REAUTHORIZE) o ?error=<FIRMA|INTENT|USADO|EXPIRADO|TIENDA|INTERCAMBIO|DENEGADO>.
  const error = (codigo: 'FIRMA' | 'INTENT' | 'USADO' | 'EXPIRADO' | 'TIENDA' | 'INTERCAMBIO' | 'DENEGADO') => `${pagina}?error=${codigo}`
  const creds = intent ? appCredentials(intent.appKey) : null
  // A4 (minor diferido): sin secreto no se verifica nada, y un dominio que no es de Shopify nunca sale a la red.
  if (!intent || !venue || !creds?.clientSecret || !isValidShopDomain(intent.shopDomain)) return error('INTENT')
  // Un parámetro repetido llega como arreglo: no es una consulta que Shopify haya firmado.
  if (!Object.values(query).every(v => typeof v === 'string') || !verifyOAuthQueryHmac(query, creds.clientSecret)) return error('FIRMA')
  if ((query.shop ?? '').toLowerCase() !== intent.shopDomain) return error('TIENDA')
  const reclamo = await prisma.shopifyConnectIntent.updateMany({
    where: { id: intent.id, status: 'CREATED', expiresAt: { gt: new Date() } },
    data: { status: 'EXCHANGING' },
  })
  if (reclamo.count !== 1) {
    const ahora = await prisma.shopifyConnectIntent.findUnique({ where: { id: intent.id }, select: { status: true } })
    return error(ahora?.status === 'CREATED' ? 'EXPIRADO' : 'USADO')
  }
  const fallido = () =>
    prisma.shopifyConnectIntent.updateMany({ where: { id: intent.id, status: 'EXCHANGING' }, data: { status: 'FAILED' } })
  const r = await exchange(intent.shopDomain, intent.appKey, query.code ?? '')
  const faltan = r.ok ? faltanPermisos(r.data.scope) : []
  if (!r.ok || faltan.length > 0) {
    await fallido()
    logger.warn(`[SHOPIFY] callback ${intent.shopDomain}: ${r.ok ? `faltan permisos ${faltan.join(',')}` : `canje falló (${r.code})`}`)
    return error(r.ok ? 'DENEGADO' : 'INTERCAMBIO')
  }
  if (intent.purpose === 'REAUTHORIZE') {
    try {
      return await reautorizar(intent, venue.organizationId, r.data, pagina)
    } catch (err) {
      // Un intent EXCHANGING para siempre es un callejón: queda FAILED y el dueño vuelve a empezar.
      logger.error(`[SHOPIFY] reautorizar ${intent.shopDomain}: ${(err as Error).message}`)
      await fallido()
      return error('INTERCAMBIO')
    }
  }
  await prisma.shopifyConnectIntent.updateMany({
    where: { id: intent.id, status: 'EXCHANGING' },
    data: {
      status: 'EXCHANGED',
      tokenCiphertext: encryptShopifyToken(r.data.accessToken),
      scopes: r.data.scope,
      expiresAt: new Date(Date.now() + SELECCION_TTL_MS),
    },
  })
  return `${pagina}?intent=${encodeURIComponent(query.state)}`
}

/**
 * §11.4: la ÚNICA forma de dejar una credencial nueva en una tienda que ya existe (CONNECT y REAUTHORIZE), dentro de la
 * tx de quien llama.
 * - Candados (R6/S4, §10.3): TODAS las sucursales de la tienda por id —también las desconectadas, K10 les limpia
 *   FALTA_PERMISO— y después la tienda. `FOR NO KEY UPDATE`: choca con el FOR SHARE de diferir, del drenado y del cerco
 *   (S5), y no frena a quien inserte una pareja con llave a la sucursal.
 * - Tienda: token, permisos, `authorizedAt` (en la MISMA tx que `tokenVersion++`: la desinstalación por hora de origen
 *   depende de eso, S3, §10.6) y ACTIVE.
 * - Sucursales vivas: webhooks otra vez (tras desinstalar, Shopify borró las suscripciones), el drenado de lo diferido
 *   (§10.5, S2) y una vuelta del cuadre. La fase y la generación no se tocan.
 * - K10 / BR-8: lo que murió por falta de permiso EN LA GENERACIÓN VIGENTE de su sucursal vuelve a salir (no ambiguo ⇒
 *   PENDING; ambiguo ⇒ FAILED, para resolverse con su llave), conservando parámetros congelados, `firstAttemptAt` e
 *   intentos. Sin candado de pareja: todo otro escritor de esas filas toma antes la sucursal FOR SHARE. El filtro de
 *   generación es lo que impide revivir una fila de una conexión que ya no existe (BR-3, BR-4, K16).
 */
async function renovarCredencial(
  tx: Prisma.TransactionClient,
  storeId: string,
  d: { tokenCiphertext: Uint8Array; scopes: string; appKey: ShopifyAppKey },
): Promise<{ tokenVersion: number; sucursales: number; reencoladas: number }> {
  const ahora = new Date()
  // ponytail: las sucursales de UNA tienda son un puñado; el tope es defensa (el mismo de A). Por tandas si alguna pasa de 1000.
  const enlaces = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "ShopifyLocationLink" WHERE "storeId" = ${storeId} ORDER BY id LIMIT 1000 FOR NO KEY UPDATE`
  const tienda = await tx.shopifyStore.update({
    where: { id: storeId },
    data: {
      accessTokenCiphertext: d.tokenCiphertext,
      scopes: d.scopes,
      appKey: d.appKey,
      status: 'ACTIVE',
      revokedAt: null,
      authorizedAt: ahora,
      tokenVersion: { increment: 1 },
    },
    select: { tokenVersion: true },
  })
  await tx.shopifyLocationLink.updateMany({ where: { storeId, importError: FALTA_PERMISO }, data: { importError: null } })
  await tx.shopifyLocationLink.updateMany({
    where: { storeId, status: { not: 'DISCONNECTED' } },
    data: { webhooksAt: null, requeuePending: true, reconcileVersion: { increment: 1 } },
  })
  const reencoladas = await tx.$executeRaw`
    UPDATE "ShopifyStockOutbox" o
       SET status = CASE WHEN o.ambiguous THEN 'FAILED'::"ShopifyOutboxStatus" ELSE 'PENDING'::"ShopifyOutboxStatus" END,
           "scheduledAt" = ${utcTs(ahora)}, "processedAt" = NULL, "claimToken" = NULL, "leaseUntil" = NULL
      FROM "ShopifyLocationLink" l
     WHERE l.id = o."locationLinkId" AND l."storeId" = ${storeId} AND o.generation = l.generation
       AND o.status = 'DEAD_LETTER' AND o."lastError" LIKE ${`${FALTA_PERMISO}%`}`
  return { tokenVersion: tienda.tokenVersion, sucursales: enlaces.length, reencoladas }
}

/** Token nuevo para una tienda ya conectada (§3 tienda: REVOKED → ACTIVE con tokenVersion++), vía `renovarCredencial`. */
async function reautorizar(
  intent: ShopifyConnectIntent,
  organizationId: string,
  datos: { accessToken: string; scope: string },
  pagina: string,
): Promise<string> {
  const store = await prisma.shopifyStore.findUnique({
    where: { shopDomain: intent.shopDomain },
    select: { id: true, organizationId: true },
  })
  if (!store || store.organizationId !== organizationId) {
    await prisma.shopifyConnectIntent.updateMany({ where: { id: intent.id, status: 'EXCHANGING' }, data: { status: 'FAILED' } })
    return `${pagina}?error=TIENDA`
  }
  const r = await prisma.$transaction(async tx => {
    const renovada = await renovarCredencial(tx, store.id, {
      tokenCiphertext: encryptShopifyToken(datos.accessToken),
      scopes: datos.scope,
      appKey: intent.appKey,
    })
    await tx.shopifyConnectIntent.updateMany({ where: { id: intent.id, status: 'EXCHANGING' }, data: { status: 'CONSUMED' } })
    return renovada
  }, TX_LARGA)
  logAction({
    venueId: intent.venueId,
    organizationId,
    staffId: intent.authUserId,
    action: 'SHOPIFY_REAUTHORIZED',
    entity: 'ShopifyStore',
    entityId: store.id,
    data: r,
  })
  return `${pagina}?reautorizada=1`
}

type IntentListo = ShopifyConnectIntent & { tokenCiphertext: Uint8Array }

async function intentListo(i: { venueId: string; authUserId: string; intent: string }): Promise<IntentListo> {
  const id = readIntentId(i.intent)
  const intent = id ? await prisma.shopifyConnectIntent.findUnique({ where: { id } }) : null
  // Un dominio que no es de Shopify nunca sale a la red con el token (A4, minor diferido).
  if (!intent || intent.venueId !== i.venueId || !isValidShopDomain(intent.shopDomain)) {
    throw new NotFoundError('La conexión con Shopify ya no existe; vuelve a empezar', 'SHOPIFY_INTENT_NO_EXISTE')
  }
  if (intent.authUserId !== i.authUserId) throw new ForbiddenError('Esta conexión la empezó otra persona', 'SHOPIFY_INTENT_DE_OTRA_PERSONA')
  if (intent.status === 'CONSUMED') throw new ConflictError('Esta conexión ya se usó', 'SHOPIFY_INTENT_YA_USADO')
  if (intent.status !== 'EXCHANGED' || !intent.tokenCiphertext) {
    throw new ConflictError('Shopify todavía no autoriza esta conexión', 'SHOPIFY_INTENT_SIN_AUTORIZAR')
  }
  if (intent.expiresAt < new Date()) throw new ConflictError('La conexión venció; vuelve a conectar', 'SHOPIFY_INTENT_EXPIRADO')
  return intent as IntentListo
}

/** B-7: el token del intent, o 503 si no se puede descifrar (llave mal puesta); nunca lanza el error crudo ni lo registra. */
function tokenDe(intent: IntentListo): string {
  const token = leerToken({ id: intent.id, accessTokenCiphertext: intent.tokenCiphertext })
  if (token === null) throw new ServiceUnavailableError('Falta configurar la app de Shopify en el servidor', 'SHOPIFY_SIN_CREDENCIALES')
  return token
}

/** Con el token de un intent todavía no hay tienda que avisar: falta un permiso ⇒ 403 que la página explica (§9.5). */
function fallaDeIntent(r: ShopifyFailure): never {
  if (r.code === 'FORBIDDEN') {
    throw new ForbiddenError(
      'A la app le falta un permiso en Shopify: vuelve a conectar y acepta todos los permisos que pide',
      'SHOPIFY_FALTA_PERMISO',
    )
  }
  throw new ServiceUnavailableError('Shopify no respondió; intenta de nuevo', 'SHOPIFY_NO_RESPONDE')
}

// ─── Ubicaciones y confirmar ────────────────────────────────────────────────────────────────────────────────

type Ubicacion = { id: string; name: string; isActive: boolean; address: { countryCode: string | null } | null }
type PaginaUbicaciones = { locations: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Ubicacion[] } }
const QUERY_UBICACIONES = `query Ubicaciones($after: String) {
  locations(first: 50, after: $after, includeInactive: false) {
    pageInfo { hasNextPage endCursor }
    nodes { id name isActive address { countryCode } }
  }
}`
const ubicacionValida = (n: unknown): n is Ubicacion => {
  const u = n as Partial<Ubicacion> | null
  const cc = (u?.address as { countryCode?: unknown } | null | undefined)?.countryCode
  return (
    !!u &&
    typeof u.id === 'string' &&
    u.id.startsWith('gid://shopify/Location/') &&
    typeof u.name === 'string' &&
    typeof u.isActive === 'boolean' &&
    (u.address === null || (typeof u.address === 'object' && (cc === null || typeof cc === 'string')))
  )
}
/** N06: forma completa y cursor que avanza; si no, BAD_RESPONSE y no se lista nada. */
const paginaUbicacionesDe =
  (after: string | null) =>
  (d: unknown): d is PaginaUbicaciones => {
    const l = (d as { locations?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } } | null)?.locations
    if (!l || !Array.isArray(l.nodes) || !l.nodes.every(ubicacionValida) || typeof l.pageInfo?.hasNextPage !== 'boolean') return false
    return (
      !l.pageInfo.hasNextPage || (typeof l.pageInfo.endCursor === 'string' && l.pageInfo.endCursor !== '' && l.pageInfo.endCursor !== after)
    )
  }

/** Todas las ubicaciones activas de la tienda, recorriendo `pageInfo` (#27). */
export async function listIntentLocations(
  i: { venueId: string; authUserId: string; intent: string },
  deps: { graphql?: typeof shopifyGraphql } = {},
): Promise<Array<{ id: string; name: string; countryCode: string | null }>> {
  const intent = await intentListo(i)
  const graphql = deps.graphql ?? shopifyGraphql
  const token = tokenDe(intent)
  const out: Array<{ id: string; name: string; countryCode: string | null }> = []
  let after: string | null = null
  for (let pagina = 0; pagina < MAX_PAGINAS_UBICACIONES; pagina++) {
    const r = await graphql<PaginaUbicaciones>(
      intent.shopDomain,
      token,
      QUERY_UBICACIONES,
      { after },
      { validate: paginaUbicacionesDe(after) },
    )
    if (!r.ok) fallaDeIntent(r)
    for (const l of r.data.locations.nodes)
      if (l.isActive) out.push({ id: l.id, name: l.name, countryCode: l.address?.countryCode ?? null })
    if (!r.data.locations.pageInfo.hasNextPage) return out
    after = r.data.locations.pageInfo.endCursor
  }
  throw new ConflictError('Tu tienda tiene demasiadas ubicaciones para mostrarlas aquí; escríbenos', 'SHOPIFY_DEMASIADAS_UBICACIONES')
}

type Confirmacion = { location: { id: string; name: string; isActive: boolean } | null }
const QUERY_CONFIRMAR = `query Confirmar($id: ID!) {
  location(id: $id) { id name isActive }
}`
/** N06: `null` (no existe) o ESA ubicación con su forma completa; otra ubicación es una respuesta inválida. */
const confirmacionDe =
  (id: string) =>
  (d: unknown): d is Confirmacion => {
    if (!d || typeof d !== 'object' || !('location' in d)) return false
    const l = (d as { location: unknown }).location as { id?: unknown; name?: unknown; isActive?: unknown } | null
    return l === null || (l.id === id && typeof l.name === 'string' && typeof l.isActive === 'boolean')
  }

type FilaSucursal = { id: string; venueId: string; status: string; storeId: string; shopifyLocationId: string; generation: number }
const YA_CONECTADA = () => new ConflictError('Esta sucursal ya está conectada a Shopify; desconéctala primero', 'SHOPIFY_YA_CONECTADA')
const UBICACION_YA_LIGADA = () =>
  new ConflictError('Esa ubicación de Shopify ya está ligada a otra sucursal', 'SHOPIFY_UBICACION_YA_LIGADA')
const DE_OTRA_EMPRESA = () => new ConflictError('Esa tienda de Shopify ya está conectada a otra empresa', 'SHOPIFY_TIENDA_DE_OTRA_EMPRESA')

/**
 * Confirma la ubicación elegida. Con el token del intent verifica que exista, esté activa y sea de ESA tienda, y toma su
 * nombre del servidor (#22).
 * - K9: si la tienda ya existe (misma organización), la credencial nueva se guarda ANTES y en su propia tx
 *   (`renovarCredencial`). Así, si la barrera de abajo contesta 409, las filas que esperaba pueden resolverse con el token
 *   nuevo y el siguiente intento entra: sin eso, una tienda revocada con un envío ambiguo y la sucursal desconectada no
 *   se podía reconectar nunca. El intent sigue EXCHANGED. Lo que ya se sabe que va a fallar (sucursal conectada, ubicación
 *   ocupada, tienda ajena, catálogo maestro) se dice antes, para no renovar en vano.
 * - Después, en UNA tx: candado del catálogo maestro (#29), intent consumido, por id y ANTES de la tienda la sucursal
 *   propia y la que ocupaba esa ubicación (§10.3, N03), la barrera de envíos en camino de las dos (§9.1, §10.14, K16:
 *   B-8 rige aquí; una DEAD_LETTER ambigua ya no puede llegar y K10 nunca la revive), la tienda (otra organización ⇒ 409),
 *   sus parejas por id (BR-1) y la sucursal en CONNECTING con las reglas de generación del índice §3 (#8).
 */
export async function confirmShopifyConnect(
  i: { venueId: string; authUserId: string; intent: string; locationId: string },
  deps: { graphql?: typeof shopifyGraphql } = {},
): Promise<{ locationLinkId: string }> {
  const intent = await intentListo(i)
  const graphql = deps.graphql ?? shopifyGraphql
  const r = await graphql<Confirmacion>(
    intent.shopDomain,
    tokenDe(intent),
    QUERY_CONFIRMAR,
    { id: i.locationId },
    { validate: confirmacionDe(i.locationId) },
  )
  if (!r.ok) fallaDeIntent(r)
  const ubicacion = r.data.location
  if (!ubicacion || !ubicacion.isActive)
    throw new ConflictError('Esa ubicación no existe o está desactivada en tu tienda', 'SHOPIFY_UBICACION_INVALIDA')
  const venue = await prisma.venue.findUniqueOrThrow({ where: { id: i.venueId }, select: { organizationId: true } })
  const gobierno = (tx: Prisma.TransactionClient) =>
    assertLegacyCatalogGovernanceForVenue(tx, {
      venueId: i.venueId,
      operation: 'CREATE',
      willBeVendable: true,
      actor: SHOPIFY_SERVICE_ACTOR,
    })

  const [propia, tienda] = await Promise.all([
    prisma.shopifyLocationLink.findUnique({ where: { venueId: i.venueId }, select: { status: true } }),
    prisma.shopifyStore.findUnique({ where: { shopDomain: intent.shopDomain }, select: { id: true, organizationId: true } }),
  ])
  if (propia && propia.status !== 'DISCONNECTED') throw YA_CONECTADA()
  if (tienda && tienda.organizationId !== venue.organizationId) throw DE_OTRA_EMPRESA()
  if (tienda) {
    const ocupante = await prisma.shopifyLocationLink.findUnique({
      where: { storeId_shopifyLocationId: { storeId: tienda.id, shopifyLocationId: ubicacion.id } },
      select: { venueId: true, status: true },
    })
    if (ocupante && ocupante.venueId !== i.venueId && ocupante.status !== 'DISCONNECTED') throw UBICACION_YA_LIGADA()
    const renovada = await prisma.$transaction(async tx => {
      await gobierno(tx)
      return renovarCredencial(tx, tienda.id, {
        tokenCiphertext: intent.tokenCiphertext,
        scopes: intent.scopes ?? '',
        appKey: intent.appKey,
      })
    }, TX_LARGA)
    logAction({
      venueId: i.venueId,
      organizationId: venue.organizationId,
      staffId: i.authUserId,
      action: 'SHOPIFY_CREDENTIAL_RENEWED',
      entity: 'ShopifyStore',
      entityId: tienda.id,
      data: renovada,
    })
  }

  try {
    const link = await prisma.$transaction(async tx => {
      await gobierno(tx)
      const consumido = await tx.shopifyConnectIntent.updateMany({
        where: { id: intent.id, status: 'EXCHANGED', expiresAt: { gt: new Date() } },
        data: { status: 'CONSUMED' },
      })
      if (consumido.count !== 1) throw new ConflictError('Esta conexión ya se usó', 'SHOPIFY_INTENT_YA_USADO')
      const previa = await tx.shopifyStore.findUnique({ where: { shopDomain: intent.shopDomain }, select: { id: true } })
      const afectadas = await tx.$queryRaw<FilaSucursal[]>`
        SELECT id, "venueId", status::text AS status, "storeId", "shopifyLocationId", generation
          FROM "ShopifyLocationLink"
         WHERE "venueId" = ${i.venueId} OR ("storeId" = ${previa?.id ?? ''} AND "shopifyLocationId" = ${ubicacion.id})
         ORDER BY id
         FOR UPDATE`
      const previo = afectadas.find(a => a.venueId === i.venueId) ?? null
      const ajena = afectadas.find(a => a.venueId !== i.venueId) ?? null
      if (previo && previo.status !== 'DISCONNECTED') throw YA_CONECTADA()
      if (ajena && ajena.status !== 'DISCONNECTED') throw UBICACION_YA_LIGADA()
      // §9.1, BR-3, BR-4: con las dos sucursales bloqueadas nadie las reclama; si algo de ellas todavía puede llegar a
      // Shopify (de cualquier generación), ni se sube la generación ni la sucursal cambia de tienda o ubicación.
      for (const a of [previo, ajena]) {
        if (a && (await envioEnCamino(tx, { locationLinkId: a.id }))) {
          throw new ConflictError(
            'Un cambio de stock de la conexión anterior todavía va en camino a Shopify; intenta en unos minutos',
            'SHOPIFY_ENVIO_EN_CAMINO',
          )
        }
      }
      const storeId = await tiendaDe(tx, intent, venue.organizationId, previa?.id ?? null)
      const conParejas = [previo?.id, ajena?.id].filter((x): x is string => !!x)
      if (conParejas.length > 0) {
        await tx.$queryRaw`SELECT id FROM "ShopifyVariantLink" WHERE "locationLinkId" IN (${Prisma.join(conParejas)}) ORDER BY id FOR UPDATE`
      }
      if (ajena) await tx.shopifyLocationLink.delete({ where: { id: ajena.id } })
      return dejarConectando(tx, previo, {
        venueId: i.venueId,
        storeId,
        shopifyLocationId: ubicacion.id,
        locationName: ubicacion.name,
        connectedById: i.authUserId,
      })
    }, TX_LARGA)
    logAction({
      venueId: i.venueId,
      organizationId: venue.organizationId,
      staffId: i.authUserId,
      action: 'SHOPIFY_CONNECTED',
      entity: 'ShopifyLocationLink',
      entityId: link.id,
      data: { tienda: intent.shopDomain, ubicacion: ubicacion.name, generation: link.generation },
    })
    return { locationLinkId: link.id }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw UBICACION_YA_LIGADA()
    throw e
  }
}

/**
 * La tienda de la conexión, bloqueada FOR SHARE después de las sucursales (§10.3). Si ya existía, su credencial ya se
 * renovó (K9). Si no, se crea con el token del intent; si otra conexión de la MISMA organización la creó mientras tanto,
 * se usa ésa (su token es igual de válido); si es de otra, 409.
 */
async function tiendaDe(
  tx: Prisma.TransactionClient,
  intent: IntentListo,
  organizationId: string,
  previaId: string | null,
): Promise<string> {
  if (!previaId) {
    await tx.shopifyStore.createMany({
      data: [
        {
          organizationId,
          shopDomain: intent.shopDomain,
          appKey: intent.appKey,
          accessTokenCiphertext: intent.tokenCiphertext,
          scopes: intent.scopes ?? '',
          authorizedAt: new Date(),
        },
      ],
      skipDuplicates: true,
    })
  }
  const [s] = await tx.$queryRaw<Array<{ id: string; organizationId: string }>>`
    SELECT id, "organizationId" FROM "ShopifyStore" WHERE "shopDomain" = ${intent.shopDomain} FOR SHARE`
  if (!s || s.organizationId !== organizationId) throw DE_OTRA_EMPRESA()
  return s.id
}

/**
 * Índice §3, (nada) o DISCONNECTED → CONNECTING. La sucursal y sus parejas ya vienen bloqueadas (BR-1) y sin nada en
 * camino. Misma tienda y ubicación: las parejas se quedan sin iniciar (se vuelven a importar y a aplicar). Otra tienda u
 * otra ubicación: las parejas se borran. Siempre generación nueva; lo que nunca salió se descarta (GENERACION_VIEJA,
 * BR-2), las revisiones abiertas se CIERRAN (K18, B-6) y las incidencias de la sucursal se van (R7: también los
 * ERROR_IMPORTACION, que no van por generación).
 */
async function dejarConectando(
  tx: Prisma.TransactionClient,
  previo: FilaSucursal | null,
  d: { venueId: string; storeId: string; shopifyLocationId: string; locationName: string; connectedById: string },
): Promise<{ id: string; generation: number }> {
  const ahora = new Date()
  const fase = {
    storeId: d.storeId,
    shopifyLocationId: d.shopifyLocationId,
    locationName: d.locationName,
    status: 'CONNECTING' as const,
    pausedFrom: null,
    importCursor: null,
    importAttempts: 0,
    importError: null,
    importedAt: null,
    applyRequestedAt: null,
    applyRequestedById: null,
    webhooksAt: null,
    needsReconcile: false,
    reconcileCursor: null,
    catalogSweepCursor: null,
    requeuePending: false,
    nextWorkAt: null,
    connectedById: d.connectedById,
  }
  const cerrarLoAnterior = async () => {
    await tx.shopifyReviewItem.updateMany({
      where: { venueId: d.venueId, status: 'OPEN' },
      data: { status: 'RESOLVED', offset: new Prisma.Decimal(0), resolvedAt: ahora },
    })
    await tx.shopifyImportIssue.deleteMany({ where: { venueId: d.venueId } })
  }
  if (!previo) {
    await cerrarLoAnterior()
    return tx.shopifyLocationLink.create({ data: { ...fase, venueId: d.venueId }, select: { id: true, generation: true } })
  }
  if (previo.storeId === d.storeId && previo.shopifyLocationId === d.shopifyLocationId) {
    // `mirrorAt` en el epoch = «nunca leída» (B1): la pareja vuelve a nacer sin iniciar.
    await tx.shopifyVariantLink.updateMany({
      where: { locationLinkId: previo.id },
      data: {
        initializedAt: null,
        suspendedReason: null,
        suspendedAt: null,
        importedAvailable: null,
        importedAt: null,
        createdProduct: false,
        mirrorAt: new Date(0),
      },
    })
  } else {
    await tx.shopifyVariantLink.deleteMany({ where: { locationLinkId: previo.id } })
  }
  await tx.shopifyStockOutbox.updateMany({
    where: { locationLinkId: previo.id, status: { in: ['PENDING', 'FAILED'] }, ambiguous: false },
    data: { status: 'DISCARDED', lastError: 'GENERACION_VIEJA', processedAt: ahora, claimToken: null, leaseUntil: null },
  })
  await cerrarLoAnterior()
  return tx.shopifyLocationLink.update({
    where: { id: previo.id },
    data: { ...fase, generation: previo.generation + 1 },
    select: { id: true, generation: true },
  })
}

// ─── Webhooks: una unidad por llamada (§10.1) ───────────────────────────────────────────────────────────────

type Suscripcion = { id: string; topic: string; uri: string }
const QUERY_SUSCRIPCIONES = `query Suscripciones($uri: String!) {
  webhookSubscriptions(first: 50, uri: $uri) { nodes { id topic uri } }
}`
const MUTATION_WEBHOOK = `mutation Suscribir($topic: WebhookSubscriptionTopic!, $uri: String!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
    webhookSubscription { id topic uri }
    userErrors { field message }
  }
}`
type RespuestaWebhook = { webhookSubscriptionCreate: { webhookSubscription: Suscripcion | null; userErrors: Array<{ message: string }> } }
const suscripcionValida = (s: unknown): s is Suscripcion => {
  const x = s as Partial<Suscripcion> | null
  return (
    !!x &&
    typeof x.id === 'string' &&
    x.id.startsWith('gid://shopify/WebhookSubscription/') &&
    typeof x.topic === 'string' &&
    typeof x.uri === 'string'
  )
}
const listaValida = (d: unknown): d is { webhookSubscriptions: { nodes: Suscripcion[] } } => {
  const n = (d as { webhookSubscriptions?: { nodes?: unknown } } | null)?.webhookSubscriptions?.nodes
  return Array.isArray(n) && n.every(suscripcionValida)
}
/** N06: con errores no hay suscripción; sin errores, la suscripción creada es la de ESTE tema y ESTA uri. */
const creacionValidaDe =
  (topic: string, uri: string) =>
  (d: unknown): d is RespuestaWebhook => {
    const c = (d as { webhookSubscriptionCreate?: { webhookSubscription?: unknown; userErrors?: unknown } } | null)
      ?.webhookSubscriptionCreate
    if (!c || !Array.isArray(c.userErrors) || !c.userErrors.every(u => typeof (u as { message?: unknown } | null)?.message === 'string'))
      return false
    if (c.userErrors.length > 0) return c.webhookSubscription === null || c.webhookSubscription === undefined
    return suscripcionValida(c.webhookSubscription) && c.webhookSubscription.topic === topic && c.webhookSubscription.uri === uri
  }

/**
 * UNA unidad: lista las suscripciones de ESTA app a la uri de su receptor y crea la primera que falta. Cuando están los
 * nueve temas, marca `webhooksAt` (cercado con la tienda y la credencial con que se listó, y el lease, N05). Idempotente:
 * «ya existe» cuenta como hecho. Cualquier otro rechazo de Shopify es permanente (K8: casi siempre un permiso o un acceso
 * de la app que falta): queda FALTA_PERMISO, terminal y a la vista, en vez de reintentar para siempre con la importación
 * detenida detrás.
 */
export async function registerShopifyWebhooks(
  locationLinkId: string,
  deps: { graphql?: typeof shopifyGraphql; workToken?: string | null; vence?: number } = {},
): Promise<{ done: boolean } | { error: string; retry: boolean }> {
  const link = await prisma.shopifyLocationLink.findUnique({ where: { id: locationLinkId }, include: { store: true } })
  if (!link || link.status === 'DISCONNECTED' || link.store.status !== 'ACTIVE') return { error: 'SIN_CONEXION', retry: false }
  if (terminal(link.importError)) return { error: link.importError, retry: false } // §11.3: no se vuelve a llamar a Shopify
  if (link.webhooksAt) return { done: true }
  if (deps.workToken && link.workToken !== deps.workToken) return { error: 'SIN_LEASE', retry: false }
  const token = leerToken(link.store)
  if (token === null) return { error: TOKEN_ILEGIBLE, retry: true } // B-7: no salió nada
  const graphql = conVencimiento(deps.graphql ?? shopifyGraphql, deps.vence)
  const uri = `${apiBase()}${shopifyWebhookPath(link.store.appKey)}`
  const enlace = [{ id: link.id, generation: link.generation }] // R8: sólo esta sucursal
  const fallo = async (r: ShopifyFailure) => {
    const a = await atenderFalla(link.store, r, enlace)
    return a === 'SIN_PERMISO' ? { error: FALTA_PERMISO, retry: false } : { error: r.code, retry: a === 'REINTENTAR' }
  }
  const lista = await graphql<{ webhookSubscriptions: { nodes: Suscripcion[] } }>(
    link.store.shopDomain,
    token,
    QUERY_SUSCRIPCIONES,
    { uri },
    { validate: listaValida },
  )
  if (lista === SIN_TIEMPO) return { error: 'SIN_TIEMPO', retry: true }
  if (!lista.ok) return fallo(lista)
  const faltan = SHOPIFY_WEBHOOK_TOPICS.filter(t => !lista.data.webhookSubscriptions.nodes.some(n => n.topic === t && n.uri === uri))
  if (faltan.length === 0) {
    // N05, §11.2: la lista vale para ESA tienda y ESA credencial; si se reautorizó o revocó mientras viajaba, no se marca.
    const cerco: CercoShopify = {
      generation: link.generation,
      storeId: link.storeId,
      shopifyLocationId: link.shopifyLocationId,
      tokenVersion: link.store.tokenVersion,
      workToken: deps.workToken ?? undefined, // §12.6: nunca null
    }
    const r = await conCerco(link.id, cerco, tx =>
      tx.shopifyLocationLink.updateMany({
        where: { id: link.id, webhooksAt: null, status: { not: 'DISCONNECTED' } },
        data: { webhooksAt: new Date() },
      }),
    )
    return r !== 'CONTEXTO_CAMBIO' && r.count === 1 ? { done: true } : { error: 'CONTEXTO_CAMBIO', retry: false }
  }
  const topic = faltan[0]
  const c = await graphql<RespuestaWebhook>(
    link.store.shopDomain,
    token,
    MUTATION_WEBHOOK,
    { topic, uri },
    { validate: creacionValidaDe(topic, uri) },
  )
  if (c === SIN_TIEMPO) return { error: 'SIN_TIEMPO', retry: true } // sin tiempo después de listar: no se crea nada
  if (!c.ok) return fallo(c)
  const errores = c.data.webhookSubscriptionCreate.userErrors.filter(u => !/already been taken/i.test(u.message))
  if (errores.length > 0) {
    const detalle = errores
      .map(u => u.message)
      .join(' · ')
      .slice(0, 300)
    logger.error(`[SHOPIFY] webhook ${topic} de ${link.store.shopDomain} rechazado: ${detalle}`)
    const a = await atenderFalla(
      link.store,
      { ok: false, code: 'FORBIDDEN', retryable: false, ambiguous: false, message: `webhook ${topic}: ${detalle}` },
      enlace,
    )
    // Si la credencial cambió mientras tanto, el rechazo era de la vieja: se reintenta con la nueva.
    return a === 'SIN_PERMISO' ? { error: FALTA_PERMISO, retry: false } : { error: 'WEBHOOK_RECHAZADO', retry: true }
  }
  return { done: false }
}

// ─── Vista previa y aplicar (12 bis.3) ──────────────────────────────────────────────────────────────────────

export type FiltroVistaPrevia = 'CAMBIAN' | 'NUEVOS' | 'TODOS'
/** Forma que consume C (`ShopifyConnectReviewItem`) más `quedara` (aditivo, §10.12). */
type FilaVista = {
  variantLinkId: string
  productId: string
  name: string
  sku: string | null
  avoqadoQty: string
  shopifyQty: number | null
  nuevo: boolean
  quedara: string | null
}

/**
 * «Así quedará tu stock», paginado en la base. `quedara` = lo que Shopify tenía al importar + lo que la caja vendió
 * mientras tanto (§10.12, N13): es exactamente lo que deja «Aplicar» (TOMAR_SHOPIFY = S + pendientes). `cambian` =
 * existentes cuyo stock de hoy no es el que quedará.
 */
export async function getConnectReview(i: { venueId: string; offset: unknown; limit: unknown; filtro: FiltroVistaPrevia }) {
  const limit = Math.min(50, Math.max(1, Math.floor(Number(i.limit) || 20)))
  const offset = Math.max(0, Math.floor(Number(i.offset) || 0))
  const resumenVacio = { emparejados: 0, cambian: 0, nuevos: 0, sinPareja: 0 }
  const link = await prisma.shopifyLocationLink.findUnique({ where: { venueId: i.venueId }, select: { id: true, generation: true } })
  if (!link) return { items: [] as FilaVista[], total: 0, nextOffset: null as number | null, resumen: resumenVacio }
  const DESDE = Prisma.sql`
    FROM "ShopifyVariantLink" v
    LEFT JOIN "Inventory" inv ON inv."productId" = v."productId"
    LEFT JOIN LATERAL (
      SELECT sum(o.delta) AS suma FROM "ShopifyStockOutbox" o
       WHERE o."productId" = v."productId" AND o."locationLinkId" = v."locationLinkId" AND o.generation = ${link.generation}
         AND o.status IN ('PENDING', 'IN_PROGRESS', 'FAILED')
    ) pend ON true`
  const QUEDARA = Prisma.sql`(v."importedAvailable" + COALESCE(pend.suma, 0))`
  const CAMBIA = Prisma.sql`v."createdProduct" = false AND v."importedAvailable" IS NOT NULL AND inv."currentStock" IS DISTINCT FROM ${QUEDARA}`
  const filtro =
    i.filtro === 'NUEVOS' ? Prisma.sql`AND v."createdProduct" = true` : i.filtro === 'CAMBIAN' ? Prisma.sql`AND ${CAMBIA}` : Prisma.empty
  const [filas, [cuenta], [res], sinPareja] = await Promise.all([
    prisma.$queryRaw<Array<Omit<FilaVista, 'avoqadoQty'> & { avoqadoQty: string | null }>>`
      SELECT v.id AS "variantLinkId", v."productId", p.name, p.sku, inv."currentStock"::text AS "avoqadoQty",
             v."importedAvailable" AS "shopifyQty", v."createdProduct" AS nuevo, ${QUEDARA}::text AS quedara
        ${DESDE}
        JOIN "Product" p ON p.id = v."productId"
       WHERE v."locationLinkId" = ${link.id} ${filtro}
       ORDER BY p.name ASC, v.id ASC
       LIMIT ${limit} OFFSET ${offset}`,
    prisma.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total ${DESDE} WHERE v."locationLinkId" = ${link.id} ${filtro}`,
    prisma.$queryRaw<Array<{ emparejados: number; nuevos: number; cambian: number }>>`
      SELECT count(*)::int AS emparejados,
             (count(*) FILTER (WHERE v."createdProduct"))::int AS nuevos,
             (count(*) FILTER (WHERE ${CAMBIA}))::int AS cambian
        ${DESDE}
       WHERE v."locationLinkId" = ${link.id}`,
    prisma.shopifyImportIssue.count({ where: { venueId: i.venueId } }),
  ])
  // Sin fila de Inventory (pareja que se suspenderá al aplicar) se muestra 0: la forma de C no admite null.
  const items: FilaVista[] = filas.map(f => ({
    ...f,
    avoqadoQty: new Prisma.Decimal(f.avoqadoQty ?? 0).toString(),
    quedara: f.quedara === null ? null : new Prisma.Decimal(f.quedara).toString(),
  }))
  const total = cuenta?.total ?? 0
  return {
    items,
    total,
    nextOffset: offset + items.length < total ? offset + items.length : null,
    resumen: { emparejados: res?.emparejados ?? 0, cambian: res?.cambian ?? 0, nuevos: res?.nuevos ?? 0, sinPareja },
  }
}

export async function requestApplyShopifyConnect(
  i: { venueId: string; staffId: string },
  deps: { hasAccess?: (venueId: string) => Promise<boolean> } = {},
): Promise<{ applyRequestedAt: Date }> {
  if (!(await (deps.hasAccess ?? accesoReal)(i.venueId))) {
    throw new ForbiddenError('Shopify está en pausa porque el plan de esta sucursal no lo incluye', 'SHOPIFY_SIN_PLAN')
  }
  const r = await prisma.shopifyLocationLink.updateMany({
    where: { venueId: i.venueId, status: 'REVIEWING', applyRequestedAt: null },
    data: { applyRequestedAt: new Date(), applyRequestedById: i.staffId },
  })
  const link = await prisma.shopifyLocationLink.findUnique({
    where: { venueId: i.venueId },
    select: { id: true, status: true, applyRequestedAt: true, store: { select: { organizationId: true } } },
  })
  // 409 como el `reauthorizeShopDomain` de C: el mismo código sale siempre con el mismo estado.
  if (!link || link.status === 'DISCONNECTED')
    throw new ConflictError('Esta sucursal no tiene una tienda Shopify conectada', 'SHOPIFY_SIN_CONEXION')
  if (link.status !== 'REVIEWING' || !link.applyRequestedAt) {
    throw new ConflictError('La vista previa todavía no está lista, o ya se aplicó', 'SHOPIFY_NO_EN_REVISION')
  }
  if (r.count === 1) {
    logAction({
      venueId: i.venueId,
      organizationId: link.store.organizationId,
      staffId: i.staffId,
      action: 'SHOPIFY_APPLY_REQUESTED',
      entity: 'ShopifyLocationLink',
      entityId: link.id,
    })
  }
  return { applyRequestedAt: link.applyRequestedAt }
}

/**
 * Una tanda de «Aplicar y sincronizar» (la llama el worker): lee el número VIGENTE de Shopify y deja cada pareja con
 * TOMAR_SHOPIFY (Inventory = S + pendientes, espejo = S), con el cerco de la sucursal y el lease (§11.2, N19), el plan
 * resuelto UNA vez (R3) y el vencimiento antes de cada lectura y cada escritura (§11.6, §12.8). Cuando ya no quedan,
 * `terminarAplicacion` la pasa a ACTIVE revalidando todo bajo candado. BR-3: mientras algo de una conexión anterior
 * todavía pueda llegar a Shopify, no se inicia nada (su número podría no ser el que se leyó).
 */
export async function applyConnectPage(
  locationLinkId: string,
  deps: {
    fetchLevels?: typeof fetchLevels
    hasAccess?: (venueId: string) => Promise<boolean>
    workToken?: string | null
    vence?: number
  } = {},
): Promise<{ done: boolean; procesadas: number; error?: string }> {
  const link = await prisma.shopifyLocationLink.findUnique({ where: { id: locationLinkId }, include: { store: true } })
  if (!link || link.status !== 'REVIEWING' || !link.applyRequestedAt || link.store.status !== 'ACTIVE')
    return { done: false, procesadas: 0 }
  if (terminal(link.importError)) return { done: false, procesadas: 0, error: link.importError }
  if (deps.workToken && link.workToken !== deps.workToken) return { done: false, procesadas: 0, error: 'SIN_LEASE' }
  if (await envioEnCamino(prisma, { locationLinkId })) return { done: false, procesadas: 0, error: ENVIO_EN_CAMINO }
  const hasAccess = unaVez(deps.hasAccess ?? accesoReal)
  const cerco: CercoShopify = {
    generation: link.generation,
    storeId: link.storeId,
    shopifyLocationId: link.shopifyLocationId,
    tokenVersion: link.store.tokenVersion,
    workToken: deps.workToken ?? undefined, // §12.6: nunca null
  }
  const tanda = await prisma.shopifyVariantLink.findMany({
    where: { locationLinkId, initializedAt: null, suspendedReason: null },
    select: { id: true, inventoryItemId: true },
    orderBy: { id: 'asc' },
    take: TANDA_APLICAR,
  })
  if (tanda.length === 0) return terminarAplicacion(link.id, cerco, hasAccess)
  const fetchedAt = new Date() // B-1: antes de la petición
  const r = await leerNiveles(
    deps.fetchLevels ?? fetchLevels,
    link.store,
    tanda.map(p => ({ inventoryItemId: p.inventoryItemId, shopifyLocationId: link.shopifyLocationId })),
    deps.vence,
  )
  if (r === SIN_TIEMPO) return { done: false, procesadas: 0, error: 'SIN_TIEMPO' }
  if (!r.ok) {
    const a = await atenderFalla(link.store, r, [{ id: link.id, generation: link.generation }])
    return { done: false, procesadas: 0, error: a === 'SIN_PERMISO' ? FALTA_PERMISO : r.code }
  }
  let procesadas = 0
  for (const p of tanda) {
    if (restante(deps.vence) < MIN_ESCRITURA_MS) return { done: false, procesadas, error: 'SIN_TIEMPO' } // §12.8: lo que falta, otra vuelta
    const nivel = r.data.get(levelKey(link.shopifyLocationId, p.inventoryItemId)) ?? { kind: 'SIN_NIVEL' as const }
    const o = await initializePair({ variantLinkId: p.id, nivel, fetchedAt, mode: 'TOMAR_SHOPIFY' }, { hasAccess, cerco })
    if (o === 'CONTEXTO_CAMBIO') return { done: false, procesadas, error: 'CONTEXTO_CAMBIO' } // otro tiene la sucursal: nada más
    if (o === 'NO_APLICA') break // cambió la fase, la tienda o el plan: el worker lo verá en la siguiente vuelta
    if (o !== 'REINTENTAR') procesadas += 1
  }
  return { done: false, procesadas }
}

/**
 * REVIEWING → ACTIVE (§3), con la sucursal bloqueada: el plan vigente (N19) y después el MISMO contexto de quien aplicó
 * (generación, tienda, ubicación, credencial, lease), la tienda ACTIVE y ningún error terminal (§12.2, cerco de A). El
 * cerco va DESPUÉS del plan: lo que cambie mientras se pregunta (una tienda revocada, R09) también lo ve. BR-3 otra vez,
 * ya bajo candado. Si algo cambió, no pasa nada y el worker lo reintenta.
 */
async function terminarAplicacion(
  linkId: string,
  cerco: CercoShopify,
  hasAccess: (venueId: string) => Promise<boolean>,
): Promise<{ done: boolean; procesadas: number }> {
  const r = await prisma.$transaction(async tx => {
    const [l] = await tx.$queryRaw<
      Array<{ generation: number; status: string; applyRequestedAt: Date | null; venueId: string; organizationId: string }>
    >`
      SELECT l.generation, l.status::text AS status, l."applyRequestedAt", l."venueId", s."organizationId"
        FROM "ShopifyLocationLink" l JOIN "ShopifyStore" s ON s.id = l."storeId"
       WHERE l.id = ${linkId}
       FOR UPDATE OF l`
    if (!l || l.status !== 'REVIEWING' || !l.applyRequestedAt) return null
    if (!(await hasAccess(l.venueId))) return null
    if (!(await cercoVigente(tx, linkId, cerco))) return null // el mismo cerco que A: tienda ACTIVE, credencial, lease (N19)
    if ((await tx.shopifyVariantLink.count({ where: { locationLinkId: linkId, initializedAt: null, suspendedReason: null } })) > 0)
      return null
    if (await envioEnCamino(tx, { locationLinkId: linkId })) return null
    // 12 bis.2: lo que el guardia anotó de productos que nunca tuvieron pareja iniciada no viaja.
    await tx.$executeRaw`
      UPDATE "ShopifyStockOutbox" o
         SET status = 'DISCARDED', "lastError" = 'SIN_PAREJA', "processedAt" = ${utcTs(new Date())}, "claimToken" = NULL, "leaseUntil" = NULL
       WHERE o."locationLinkId" = ${linkId} AND o.generation = ${l.generation} AND o.status IN ('PENDING', 'FAILED') AND o.ambiguous = false
         AND NOT EXISTS (SELECT 1 FROM "ShopifyVariantLink" v
                          WHERE v."productId" = o."productId" AND v."locationLinkId" = ${linkId}
                            AND v."initializedAt" IS NOT NULL AND v."suspendedReason" IS NULL)`
    // §10.5, S2: el drenado de lo diferido y una vuelta del cuadre quedan pedidos en ESTA transacción.
    await tx.shopifyLocationLink.update({
      where: { id: linkId },
      data: { status: 'ACTIVE', requeuePending: true, needsReconcile: true, reconcileVersion: { increment: 1 } },
    })
    return { venueId: l.venueId, organizationId: l.organizationId }
  })
  if (!r) return { done: false, procesadas: 0 }
  logAction({
    venueId: r.venueId,
    organizationId: r.organizationId,
    action: 'SHOPIFY_SYNC_STARTED',
    entity: 'ShopifyLocationLink',
    entityId: linkId,
  })
  return { done: true, procesadas: 0 }
}

// ─── Pausa por plan y desconexión ───────────────────────────────────────────────────────────────────────────

/**
 * Quien pausa o reanuda (§12.7, N19): la generación que leyó y, si trabaja con lease, su `workToken`. Un worker que perdió
 * la sucursal mientras preguntaba por el plan no puede pausar ni reanudar a la que ya es de otro.
 */
export type DuenoSucursal = { generation: number; workToken?: string }
type SucursalBloqueada = {
  status: string
  pausedFrom: ShopifyLinkStatus | null
  generation: number
  workToken: string | null
  venueId: string
  organizationId: string
}
/** La sucursal FOR UPDATE (S5: toda escritura de su fase choca con el FOR SHARE de diferir) y la organización de su tienda. */
async function bloquearSucursal(tx: Prisma.TransactionClient, id: string): Promise<SucursalBloqueada | null> {
  const [l] = await tx.$queryRaw<SucursalBloqueada[]>`
    SELECT l.status::text AS status, l."pausedFrom"::text AS "pausedFrom", l.generation, l."workToken", l."venueId", s."organizationId"
      FROM "ShopifyLocationLink" l JOIN "ShopifyStore" s ON s.id = l."storeId"
     WHERE l.id = ${id}
     FOR UPDATE OF l`
  return l ?? null
}

/**
 * Pierde el plan: PAUSED guardando la fase de antes (#15). El guardia sigue anotando con la fase de antes. Bajo el candado
 * de la sucursal: la fase, la generación y el lease esperados, y el plan otra vez (si volvió mientras se esperaba, no se
 * pausa).
 */
export async function pauseShopifyLink(
  id: string,
  desde: 'CONNECTING' | 'REVIEWING' | 'ACTIVE',
  dueno: DuenoSucursal,
  deps: { hasAccess?: (venueId: string) => Promise<boolean> } = {},
): Promise<boolean> {
  const hasAccess = deps.hasAccess ?? accesoReal
  const r = await prisma.$transaction(async tx => {
    const l = await bloquearSucursal(tx, id)
    if (!l || l.status !== desde || l.generation !== dueno.generation) return null
    if (dueno.workToken !== undefined && l.workToken !== dueno.workToken) return null
    if (await hasAccess(l.venueId)) return null
    await tx.shopifyLocationLink.update({
      where: { id },
      data: { status: 'PAUSED', pausedFrom: desde, needsReconcile: true, reconcileVersion: { increment: 1 } },
    })
    return l
  })
  if (!r) return false
  logAction({
    venueId: r.venueId,
    organizationId: r.organizationId,
    action: 'SHOPIFY_PAUSED',
    entity: 'ShopifyLocationLink',
    entityId: id,
    data: { desde },
  })
  return true
}

/**
 * Recupera el plan: vuelve a la fase de antes, y si es ACTIVE deja `requeuePending` en la MISMA escritura (§10.5, N10,
 * S2): el catálogo diferido lo reabre el worker aunque el proceso muera aquí. CONNECTING sigue importando; REVIEWING
 * espera su «Aplicar». El inventario lo arregla el cuadre (`needsReconcile` quedó arriba al pausar). Igual que pausar
 * (§12.7): bajo el candado de la sucursal, la generación y el lease esperados, y el plan otra vez.
 */
export async function resumeShopifyLink(
  id: string,
  dueno: DuenoSucursal,
  deps: { hasAccess?: (venueId: string) => Promise<boolean> } = {},
): Promise<ShopifyLinkStatus | null> {
  const hasAccess = deps.hasAccess ?? accesoReal
  const r = await prisma.$transaction(async tx => {
    const l = await bloquearSucursal(tx, id)
    if (!l || l.status !== 'PAUSED' || l.generation !== dueno.generation) return null
    if (dueno.workToken !== undefined && l.workToken !== dueno.workToken) return null
    if (!(await hasAccess(l.venueId))) return null
    const destino: ShopifyLinkStatus =
      l.pausedFrom && l.pausedFrom !== 'PAUSED' && l.pausedFrom !== 'DISCONNECTED' ? l.pausedFrom : 'ACTIVE'
    await tx.shopifyLocationLink.update({
      where: { id },
      data: { status: destino, pausedFrom: null, requeuePending: destino === 'ACTIVE' },
    })
    return { ...l, destino }
  })
  if (!r) return null
  logAction({
    venueId: r.venueId,
    organizationId: r.organizationId,
    action: 'SHOPIFY_RESUMED',
    entity: 'ShopifyLocationLink',
    entityId: id,
    data: { a: r.destino },
  })
  return r.destino
}

type Hermana = { id: string; status: string }

/**
 * Cualquiera → DISCONNECTED (índice §3, #8, §9.1). Sube la generación SIN esperar a lo que va en camino (K16: B-8 rige
 * sólo al confirmar; BR-1, BR-2 y §9.1 ganan aquí):
 * - Candados (§11.7, BR-1, R6/S4): las sucursales de la tienda por id —la propia FOR UPDATE, las hermanas FOR NO KEY
 *   UPDATE porque S6 les escribe—, nunca la propia y después una hermana de id menor (se cruzaría con quien las toma por
 *   id: el drenado, diferir, renovar la credencial); después sus parejas por id, después las filas, y sólo entonces la
 *   generación. Un mensajero que confirma tiene la pareja y termina antes, o espera y ya ve la generación nueva (no
 *   mueve el espejo).
 * - BR-2: lo que nunca salió (PENDING/FAILED no ambiguo) se descarta; lo que va en camino (IN_PROGRESS, o ambiguo) se
 *   queda para cerrarse con su misma llave.
 * - K18, B-6: las revisiones abiertas se CIERRAN (offset 0), con su rastro.
 * - S6: las hermanas ACTIVE quedan con el drenado pedido (un aviso que esperaba a ESTA sucursal ya no espera a nadie);
 *   sin hermanas vivas, lo diferido de la tienda ya no tiene a quién esperar y se cierra.
 * Las parejas se quedan: reconectar la MISMA tienda y ubicación las vuelve a usar (cuando lo que iba en camino terminó).
 */
export async function disconnectShopify(i: { venueId: string; staffId: string | null }): Promise<{ desconectada: boolean }> {
  const r = await prisma.$transaction(async tx => {
    const [yo] = await tx.$queryRaw<Array<{ id: string; storeId: string }>>`
      SELECT id, "storeId" FROM "ShopifyLocationLink" WHERE "venueId" = ${i.venueId}`
    if (!yo) return null
    // ponytail: las sucursales de UNA tienda son un puñado; el tope es defensa (el mismo de A).
    const antes = await tx.$queryRaw<Hermana[]>`
      SELECT id, status::text AS status FROM "ShopifyLocationLink"
       WHERE "storeId" = ${yo.storeId} AND id < ${yo.id} ORDER BY id LIMIT 1000 FOR NO KEY UPDATE`
    const [l] = await tx.$queryRaw<Array<{ id: string; status: string; storeId: string }>>`
      SELECT id, status::text AS status, "storeId" FROM "ShopifyLocationLink" WHERE id = ${yo.id} FOR UPDATE`
    const despues = await tx.$queryRaw<Hermana[]>`
      SELECT id, status::text AS status FROM "ShopifyLocationLink"
       WHERE "storeId" = ${yo.storeId} AND id > ${yo.id} ORDER BY id LIMIT 1000 FOR NO KEY UPDATE`
    if (!l || l.status === 'DISCONNECTED') return null
    await tx.$queryRaw`SELECT id FROM "ShopifyVariantLink" WHERE "locationLinkId" = ${l.id} ORDER BY id FOR UPDATE`
    const ahora = new Date()
    const descartadas = await tx.shopifyStockOutbox.updateMany({
      where: { locationLinkId: l.id, status: { in: ['PENDING', 'FAILED'] }, ambiguous: false },
      data: { status: 'DISCARDED', lastError: 'DESCONECTADO', processedAt: ahora, claimToken: null, leaseUntil: null },
    })
    const cerradas = await tx.shopifyReviewItem.updateMany({
      where: { venueId: i.venueId, status: 'OPEN' },
      data: { status: 'RESOLVED', offset: new Prisma.Decimal(0), resolvedAt: ahora },
    })
    await tx.shopifyLocationLink.update({
      where: { id: l.id },
      data: {
        status: 'DISCONNECTED',
        pausedFrom: null,
        generation: { increment: 1 },
        importCursor: null,
        importAttempts: 0,
        applyRequestedAt: null,
        applyRequestedById: null,
        needsReconcile: false,
        reconcileCursor: null,
        catalogSweepCursor: null,
        requeuePending: false,
      },
    })
    const store = await tx.shopifyStore.findUniqueOrThrow({ where: { id: l.storeId }, select: { shopDomain: true, organizationId: true } })
    // ponytail: si la sucursal cambió de tienda entre la primera lectura y el candado (desconectar y reconectar en ese
    // instante), las hermanas bloqueadas son de la tienda vieja: no se toca a nadie más. El drenado lo vuelve a pedir la
    // siguiente activación, reanudación o reautorización de la tienda nueva.
    if (l.storeId === yo.storeId) {
      const vivas = [...antes, ...despues].filter(h => h.status !== 'DISCONNECTED')
      const activas = vivas.filter(h => h.status === 'ACTIVE').map(h => h.id)
      if (activas.length > 0) await tx.shopifyLocationLink.updateMany({ where: { id: { in: activas } }, data: { requeuePending: true } })
      if (vivas.length === 0) {
        await tx.shopifyInboundEvent.updateMany({
          where: { shopDomain: store.shopDomain, status: 'DEFERRED' },
          data: { status: 'SKIPPED', error: 'DESCONECTADO', processedAt: ahora },
        })
      }
    }
    return { id: l.id, organizationId: store.organizationId, descartadas: descartadas.count, revisionesCerradas: cerradas.count }
  }, TX_LARGA)
  if (!r) return { desconectada: false }
  logAction({
    venueId: i.venueId,
    organizationId: r.organizationId,
    staffId: i.staffId ?? undefined,
    action: 'SHOPIFY_DISCONNECTED',
    entity: 'ShopifyLocationLink',
    entityId: r.id,
    data: { descartadas: r.descartadas, revisionesCerradas: r.revisionesCerradas },
  })
  return { desconectada: true }
}
