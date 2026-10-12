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
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError } from '@/errors/AppError'
import { DEMO_VENUE_STATUSES, isActiveWindow, venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { assertLegacyCatalogGovernanceForVenue } from '@/services/master-catalog/catalogGovernance.service'
import { utcTs } from '@/utils/sqlDates'
import {
  motivoAvoqadoNoSeManda,
  SHOPIFY_FEATURE,
  SHOPIFY_SCOPES,
  SHOPIFY_SERVICE_ACTOR,
  SHOPIFY_WEBHOOK_TOPICS,
  TEXTO_SIN_ACCESO,
} from './shopify.constants'
import { appCredentials, encryptShopifyToken, isValidShopDomain, readIntentId, signIntentId, verifyOAuthQueryHmac } from './shopify.crypto'
import { exchangeOAuthCode, shopifyGraphql, type ShopifyFailure, type ShopifyResult } from './shopify.graphql'
import { pedirLlaveDelComercio, RENOVAR_ANTES_MS, type LlaveDelComercio } from './shopify.llave-comercio'
import {
  cercoVigente,
  fetchLevels,
  initializePair,
  levelKey,
  refrescarLoImportado,
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
/** BR-4: `lastError` de lo que iba en camino a la tienda anterior de una sucursal que se ligó a otra. */
export const RELIGADA_A_OTRA_TIENDA = 'RELIGADA_A_OTRA_TIENDA'
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

/**
 * 5a (spec 2026-10-11 §3.1): el candado de la app del comercio. `venueHasFeatureAccess` deja pasar a los negocios con trato
 * preferente y a las demos (casi todo producción); aquí SÓLO la fila `VenueFeature` de `SHOPIFY_INTEGRATION` en su ventana activa
 * (`isActiveWindow`, la misma del resolver): la cortesía de superadmin. Una capability grant sola no basta (la lista de funciones
 * concedidas del dashboard no incluye Shopify; ruling de la auditoría). Nunca una demo: trae la fila sola y su stock es de mentira.
 * El plan Premium no basta todavía (la Fase 1 no se vende): encenderlo para Premium es esta función.
 */
export async function puedeConectarConAppPropia(venueId: string): Promise<boolean> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { status: true } })
  if (!venue || (DEMO_VENUE_STATUSES as readonly string[]).includes(venue.status)) return false
  const vf = await prisma.venueFeature.findFirst({
    where: { venueId, feature: { code: SHOPIFY_FEATURE } },
    select: { active: true, endDate: true, suspendedAt: true },
  })
  return !!vf && isActiveWindow(vf)
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
    // 5a: quien tiene la invitación conecta con SU app (el dashboard abre ese bloque); los demás, el piloto de siempre.
    if (await puedeConectarConAppPropia(i.venueId)) {
      throw new ConflictError(
        'Esta tienda se conecta con una app que creas en tu Shopify: pega su Client ID y su Client Secret.',
        'SHOPIFY_USA_APP_PROPIA',
      )
    }
    throw new ConflictError(
      'La conexión con Shopify está en piloto y por ahora sólo se abre para tiendas invitadas. Escríbenos y te sumamos.',
      'SHOPIFY_SOLO_PILOTO',
    )
  }
  const creds = appCredentials(APP_KEY)
  if (!creds) throw new ServiceUnavailableError('Falta configurar la app de Shopify en el servidor', 'SHOPIFY_SIN_CREDENCIALES')
  const venue = await prisma.venue.findUnique({ where: { id: i.venueId }, select: { organizationId: true } })
  if (!venue) throw new NotFoundError('Sucursal no encontrada')
  await validarProposito(i.venueId, shop, i.purpose)
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
 * Lo que cada propósito exige ANTES de mandar al dueño a Shopify (o de mandar las llaves de su app): REAUTHORIZE, la MISMA tienda
 * ya conectada; CONNECT, el catálogo maestro (spec §3, «no se soporta»).
 */
async function validarProposito(venueId: string, shop: string, purpose: ShopifyIntentPurpose): Promise<void> {
  if (purpose === 'REAUTHORIZE') {
    const link = await prisma.shopifyLocationLink.findUnique({
      where: { venueId },
      select: { status: true, store: { select: { shopDomain: true } } },
    })
    if (!link || link.status === 'DISCONNECTED' || link.store.shopDomain !== shop) {
      throw new ConflictError('Esta sucursal no está conectada a esa tienda; usa «Conectar»', 'SHOPIFY_REAUTORIZAR_SIN_TIENDA')
    }
    return
  }
  await prisma.$transaction(tx =>
    assertLegacyCatalogGovernanceForVenue(tx, {
      venueId,
      operation: 'CREATE',
      willBeVendable: true,
      actor: SHOPIFY_SERVICE_ACTOR,
    }),
  )
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
      return (await reautorizar(intent, venue.organizationId, r.data)) ? `${pagina}?reautorizada=1` : error('TIENDA')
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

/** 5a: lo de la app del comercio que viaja del intent a la tienda; en PILOTO todo es null (cambiar de método limpia lo otro). */
type CredencialesDelComercio = { clientId: string | null; clientSecretCiphertext: Uint8Array | null; accessTokenExpiresAt: Date | null }
const credencialesDe = (intent: ShopifyConnectIntent): CredencialesDelComercio => ({
  clientId: intent.clientId,
  clientSecretCiphertext: intent.clientSecretCiphertext,
  accessTokenExpiresAt: intent.tokenExpiresAt,
})

/**
 * §11.4: la ÚNICA forma de dejar una credencial nueva en una tienda que ya existe (CONNECT y REAUTHORIZE), dentro de la
 * tx de quien llama.
 * - Candados (R6/S4, §10.3): TODAS las sucursales de la tienda por id —también las desconectadas, K10 les limpia
 *   FALTA_PERMISO— y después la tienda. `FOR NO KEY UPDATE`: choca con el FOR SHARE de diferir, del drenado y del cerco
 *   (S5), y no frena a quien inserte una pareja con llave a la sucursal.
 * - Tienda: token, permisos, las llaves de la app del comercio (5a: null al volver a PILOTO), `authorizedAt` (en la MISMA
 *   tx que `tokenVersion++`: la desinstalación por hora de origen depende de eso, S3, §10.6) y ACTIVE.
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
  d: { tokenCiphertext: Uint8Array; scopes: string; appKey: ShopifyAppKey } & CredencialesDelComercio,
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
      clientId: d.clientId,
      clientSecretCiphertext: d.clientSecretCiphertext,
      accessTokenExpiresAt: d.accessTokenExpiresAt,
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

/**
 * Token nuevo para una tienda ya conectada (§3 tienda: REVOKED → ACTIVE con tokenVersion++), vía `renovarCredencial`, con las
 * llaves del intent. `false` = la tienda no es de esta organización (el intent queda FAILED).
 */
async function reautorizar(
  intent: ShopifyConnectIntent,
  organizationId: string,
  datos: { accessToken: string; scope: string },
): Promise<boolean> {
  const store = await prisma.shopifyStore.findUnique({
    where: { shopDomain: intent.shopDomain },
    select: { id: true, organizationId: true },
  })
  if (!store || store.organizationId !== organizationId) {
    await prisma.shopifyConnectIntent.updateMany({ where: { id: intent.id, status: 'EXCHANGING' }, data: { status: 'FAILED' } })
    return false
  }
  const r = await prisma.$transaction(async tx => {
    const renovada = await renovarCredencial(tx, store.id, {
      tokenCiphertext: encryptShopifyToken(datos.accessToken),
      scopes: datos.scope,
      appKey: intent.appKey,
      ...credencialesDe(intent),
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
  return true
}

/** 5a: lo que Shopify dijo de las llaves, con su código y qué hacer (spec §3.3). El secret nunca va en el texto. */
function llavesRechazadas(r: Extract<LlaveDelComercio, { ok: false }>): never {
  switch (r.motivo) {
    case 'TRANSITORIO':
      throw new ServiceUnavailableError('Shopify no respondió; intenta de nuevo', 'SHOPIFY_NO_RESPONDE')
    case 'SECRET_INVALIDO':
      throw new ValidationError(
        'Shopify no reconoce ese Client Secret. Cópialo otra vez desde tu app en Shopify y pégalo completo.',
        'SHOPIFY_APP_SECRET_INVALIDO',
      )
    case 'CLIENT_ID_INVALIDO':
      throw new ValidationError(
        'Shopify no encuentra una app con ese Client ID. Cópialo otra vez desde tu app en Shopify.',
        'SHOPIFY_APP_CLIENT_ID_INVALIDO',
      )
    case 'APP_DE_OTRA_ORGANIZACION':
      throw new ValidationError(
        'Esa app no es de la misma organización de Shopify que tu tienda: créala con la cuenta dueña de la tienda y vuelve a pegar sus llaves.',
        'SHOPIFY_APP_OTRA_ORGANIZACION',
      )
    case 'TIENDA_NO_EXISTE':
      throw new ValidationError(
        'Shopify no encuentra esa tienda. Revisa el dominio: termina en .myshopify.com.',
        'SHOPIFY_TIENDA_NO_EXISTE',
      )
    default:
      throw new ValidationError(
        `Shopify rechazó las llaves de tu app (${r.codigoShopify ?? 'sin código'}). Revisa que la app esté instalada en tu tienda y vuelve a intentar.`,
        'SHOPIFY_APP_RECHAZADA',
      )
  }
}

/**
 * 5a (spec 2026-10-11 §3): conectar (CONNECT) o cambiar las llaves (REAUTHORIZE) con la app que el comercio creó en SU Dev
 * Dashboard. Antes de crear nada: el candado propio, el dominio y el propósito (los de hoy) y la llave de 24 h con sus permisos. El
 * intent nace con las llaves cifradas y el vencimiento de 15 min de hoy; de ahí sigue el camino de siempre: CONNECT devuelve el
 * intent (ubicación → confirmar, como tras el callback); REAUTHORIZE sigue en el acto el del callback (`reautorizar`). Nunca registra,
 * guarda en claro ni devuelve el secret ni la llave.
 */
export async function conectarConAppDelComercio(i: {
  venueId: string
  authUserId: string
  shopDomain: string
  clientId: string
  clientSecret: string
  purpose: ShopifyIntentPurpose
}): Promise<{ intent: string } | { reautorizada: true }> {
  const shop = String(i.shopDomain ?? '')
    .trim()
    .toLowerCase()
  if (!isValidShopDomain(shop))
    throw new BadRequestError('Escribe el dominio de tu tienda, el que termina en .myshopify.com', 'SHOPIFY_DOMINIO_INVALIDO')
  if (!(await puedeConectarConAppPropia(i.venueId))) {
    throw new ForbiddenError(
      'Conectar con la app de tu tienda todavía es por invitación. Escríbenos y la activamos para este negocio.',
      'SHOPIFY_APP_PROPIA_SIN_INVITACION',
    )
  }
  const venue = await prisma.venue.findUnique({ where: { id: i.venueId }, select: { organizationId: true } })
  if (!venue) throw new NotFoundError('Sucursal no encontrada')
  await validarProposito(i.venueId, shop, i.purpose)
  const clientId = i.clientId.trim()
  const clientSecret = i.clientSecret.trim()
  const r = await pedirLlaveDelComercio({ shop, clientId, clientSecret })
  if (!r.ok) llavesRechazadas(r)
  const faltan = faltanPermisos(r.scope)
  if (faltan.length > 0) {
    throw new ValidationError(
      `A tu app le faltan estos permisos: ${faltan.join(', ')}. Agrégalos a tu app, publica una versión y apruébala en tu tienda; después vuelve a conectar.`,
      'SHOPIFY_APP_FALTAN_PERMISOS',
      { faltan },
    )
  }
  const ahora = Date.now()
  const intent = await prisma.shopifyConnectIntent.create({
    data: {
      venueId: i.venueId,
      authUserId: i.authUserId,
      shopDomain: shop,
      appKey: 'COMERCIO',
      purpose: i.purpose,
      // CONNECT queda como tras el callback (listo para elegir la ubicación); REAUTHORIZE, como a media vuelta del callback.
      status: i.purpose === 'REAUTHORIZE' ? 'EXCHANGING' : 'EXCHANGED',
      tokenCiphertext: encryptShopifyToken(r.token),
      scopes: r.scope,
      clientId,
      clientSecretCiphertext: encryptShopifyToken(clientSecret),
      tokenExpiresAt: new Date(ahora + r.expiresIn * 1000),
      expiresAt: new Date(ahora + SELECCION_TTL_MS),
    },
  })
  logAction({
    venueId: i.venueId,
    organizationId: venue.organizationId,
    staffId: i.authUserId,
    action: 'SHOPIFY_CONNECT_STARTED',
    entity: 'ShopifyConnectIntent',
    entityId: intent.id,
    data: { metodo: 'APP_DEL_COMERCIO', shopDomain: shop },
  })
  if (i.purpose === 'CONNECT') return { intent: signIntentId(intent.id) }
  let reautorizada: boolean
  try {
    reautorizada = await reautorizar(intent, venue.organizationId, { accessToken: r.token, scope: r.scope })
  } catch (err) {
    // Como en el callback: un intent EXCHANGING para siempre es un callejón. Queda FAILED y el error sigue a quien llamó.
    await prisma.shopifyConnectIntent.updateMany({ where: { id: intent.id, status: 'EXCHANGING' }, data: { status: 'FAILED' } })
    throw err
  }
  if (!reautorizada) {
    throw new ConflictError('Esta sucursal no está conectada a esa tienda; usa «Conectar»', 'SHOPIFY_REAUTORIZAR_SIN_TIENDA')
  }
  return { reautorizada: true }
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

/**
 * 5a (ruling P2-4 de la auditoría): la llave del intent para leer ubicaciones o confirmar. La de la app del comercio dura 24 h y el
 * asistente puede quedarse abierto: si le queda menos de `RENOVAR_ANTES_MS` (o `forzar`, tras un 401) se pide otra con las llaves
 * del PROPIO intent y se guarda en él (en la base y en memoria: confirmar la copia a la tienda). El piloto, como siempre.
 */
async function tokenDelIntent(intent: IntentListo, forzar = false): Promise<string> {
  if (intent.appKey !== 'COMERCIO') return tokenDe(intent)
  if (!forzar && intent.tokenExpiresAt && intent.tokenExpiresAt.getTime() > Date.now() + RENOVAR_ANTES_MS) return tokenDe(intent)
  const secreto = intent.clientSecretCiphertext ? leerToken({ id: intent.id, accessTokenCiphertext: intent.clientSecretCiphertext }) : null
  if (!intent.clientId || secreto === null) {
    throw new ServiceUnavailableError('Falta configurar la app de Shopify en el servidor', 'SHOPIFY_SIN_CREDENCIALES')
  }
  const r = await pedirLlaveDelComercio({ shop: intent.shopDomain, clientId: intent.clientId, clientSecret: secreto })
  if (!r.ok) llavesRechazadas(r)
  const tokenCiphertext = encryptShopifyToken(r.token)
  const tokenExpiresAt = new Date(Date.now() + r.expiresIn * 1000)
  await prisma.shopifyConnectIntent.updateMany({ where: { id: intent.id, status: 'EXCHANGED' }, data: { tokenCiphertext, tokenExpiresAt } })
  intent.tokenCiphertext = tokenCiphertext
  intent.tokenExpiresAt = tokenExpiresAt
  return r.token
}

/**
 * 5a: una lectura de Shopify con la llave del intent. Con la app del comercio un 401 puede ser sólo la llave de 24 h vencida a media
 * vuelta: se pide otra UNA vez y se repite la misma lectura; un segundo 401 ya no se repite (sale como hoy).
 */
async function conTokenDelIntent<T>(intent: IntentListo, leer: (token: string) => Promise<ShopifyResult<T>>): Promise<ShopifyResult<T>> {
  const r = await leer(await tokenDelIntent(intent))
  if (r.ok || r.code !== 'UNAUTHORIZED' || intent.appKey !== 'COMERCIO') return r
  return leer(await tokenDelIntent(intent, true))
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
  const out: Array<{ id: string; name: string; countryCode: string | null }> = []
  let after: string | null = null
  for (let pagina = 0; pagina < MAX_PAGINAS_UBICACIONES; pagina++) {
    // Tipo explícito: `after` sale de `r` en la vuelta anterior y TS no puede inferirlo (TS7022).
    const r: ShopifyResult<PaginaUbicaciones> = await conTokenDelIntent(intent, token =>
      graphql<PaginaUbicaciones>(intent.shopDomain, token, QUERY_UBICACIONES, { after }, { validate: paginaUbicacionesDe(after) }),
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
 *   ocupada, tienda ajena, catálogo maestro) se dice antes, para no renovar en vano. Un reintento con el MISMO intent no
 *   renueva otra vez (mismos bytes cifrados, tienda ACTIVE). Lo que la sucursal que se reconecta tiene en camino se
 *   reprograma para ya.
 * - Después, en UNA tx: candado del catálogo maestro (#29), intent consumido, por id y ANTES de la tienda la sucursal
 *   propia y la que ocupaba esa ubicación (§10.3, N03), la barrera de envíos en camino (§9.1, §10.14, K16: B-8 rige aquí;
 *   una DEAD_LETTER ambigua ya no puede llegar y K10 nunca la revive) de la que ocupaba la ubicación y de la propia si
 *   sigue en la MISMA tienda, la tienda (otra organización ⇒ 409), sus parejas por id (BR-1), lo que la propia tenía en
 *   camino a OTRA tienda a DEAD_LETTER (BR-4) y la sucursal en CONNECTING con las reglas de generación del índice §3 (#8).
 */
export async function confirmShopifyConnect(
  i: { venueId: string; authUserId: string; intent: string; locationId: string },
  deps: { graphql?: typeof shopifyGraphql } = {},
): Promise<{ locationLinkId: string }> {
  const intent = await intentListo(i)
  const graphql = deps.graphql ?? shopifyGraphql
  const r = await conTokenDelIntent(intent, token =>
    graphql<Confirmacion>(intent.shopDomain, token, QUERY_CONFIRMAR, { id: i.locationId }, { validate: confirmacionDe(i.locationId) }),
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
    prisma.shopifyLocationLink.findUnique({
      where: { venueId: i.venueId },
      select: { id: true, status: true, storeId: true, generation: true },
    }),
    prisma.shopifyStore.findUnique({
      where: { shopDomain: intent.shopDomain },
      select: { id: true, organizationId: true, status: true, accessTokenCiphertext: true, clientSecretCiphertext: true },
    }),
  ])
  if (propia && propia.status !== 'DISCONNECTED') throw YA_CONECTADA()
  if (tienda && tienda.organizationId !== venue.organizationId) throw DE_OTRA_EMPRESA()
  if (tienda) {
    const ocupante = await prisma.shopifyLocationLink.findUnique({
      where: { storeId_shopifyLocationId: { storeId: tienda.id, shopifyLocationId: ubicacion.id } },
      select: { venueId: true, status: true },
    })
    if (ocupante && ocupante.venueId !== i.venueId && ocupante.status !== 'DISCONNECTED') throw UBICACION_YA_LIGADA()
    // Este MISMO intent ya dejó su credencial (los mismos bytes cifrados) y la tienda sigue ACTIVE: un reintento tras un
    // 409 no vuelve a subir `tokenVersion` ni a pedir webhooks y cuadre a todas las hermanas. Con la app del comercio la credencial
    // son sus llaves (el secret cifrado del intent): la llave de 24 h del intent se vuelve a cifrar cada vez que se renueva, así que
    // compararla subiría `tokenVersion` dos veces en un reintento tras un 409.
    const yaRenovada =
      tienda.status === 'ACTIVE' &&
      (intent.appKey === 'COMERCIO'
        ? !!intent.clientSecretCiphertext &&
          !!tienda.clientSecretCiphertext &&
          Buffer.from(tienda.clientSecretCiphertext).equals(Buffer.from(intent.clientSecretCiphertext))
        : Buffer.from(tienda.accessTokenCiphertext).equals(Buffer.from(intent.tokenCiphertext)))
    // La sucursal que se reconecta a ESTA tienda: lo que tenga en camino de su conexión anterior se reintenta ya, no al
    // cabo de su espera (hasta 6 h), que dura más que los 15 minutos del intent.
    const reconecta = propia?.storeId === tienda.id ? propia : null
    const r = await prisma.$transaction(async tx => {
      await gobierno(tx)
      const renovada = yaRenovada
        ? null
        : await renovarCredencial(tx, tienda.id, {
            tokenCiphertext: intent.tokenCiphertext,
            scopes: intent.scopes ?? '',
            appKey: intent.appKey,
            ...credencialesDe(intent),
          })
      if (!reconecta) return { renovada, reprogramadas: 0 }
      // Sucursal antes que sus filas (§10.3); `renovarCredencial` ya la bloqueó con las demás de la tienda.
      if (yaRenovada) await tx.$queryRaw`SELECT id FROM "ShopifyLocationLink" WHERE id = ${reconecta.id} FOR SHARE`
      const reprogramadas = await tx.shopifyStockOutbox.updateMany({
        where: { locationLinkId: reconecta.id, generation: { lt: reconecta.generation }, status: 'FAILED', ambiguous: true },
        data: { scheduledAt: new Date() },
      })
      return { renovada, reprogramadas: reprogramadas.count }
    }, TX_LARGA)
    if (r.renovada) {
      logAction({
        venueId: i.venueId,
        organizationId: venue.organizationId,
        staffId: i.authUserId,
        action: 'SHOPIFY_CREDENTIAL_RENEWED',
        entity: 'ShopifyStore',
        entityId: tienda.id,
        data: { ...r.renovada, reprogramadas: r.reprogramadas },
      })
    }
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
      // §9.1, BR-3: con las sucursales bloqueadas nadie las reclama. Si algo de la MISMA tienda todavía puede llegar a
      // Shopify (de cualquier generación), no se sube la generación: con la credencial ya renovada (K9) y FALTA_PERMISO
      // limpio (K10), el mensajero lo resuelve y el siguiente intento entra. La que ocupaba la ubicación es siempre de
      // esta tienda. La propia, ligada a OTRA tienda, no espera: ver abajo (BR-4).
      const mismaTienda = !!previo && previa?.id === previo.storeId
      for (const a of [mismaTienda ? previo : null, ajena]) {
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
      const religadas = previo && previo.storeId !== storeId ? await aCuarentenaPorReligar(tx, previo.id) : 0
      if (ajena) {
        // Lo que la sucursal que ocupaba la ubicación nunca mandó ya no tiene a dónde ir (nada suyo está en camino: barrera).
        await tx.shopifyStockOutbox.updateMany({
          where: { locationLinkId: ajena.id, status: { in: ['PENDING', 'FAILED'] }, ambiguous: false },
          data: { status: 'DISCARDED', lastError: 'GENERACION_VIEJA', processedAt: new Date(), claimToken: null, leaseUntil: null },
        })
        await tx.shopifyLocationLink.delete({ where: { id: ajena.id } })
      }
      const ligada = await dejarConectando(tx, previo, {
        venueId: i.venueId,
        storeId,
        shopifyLocationId: ubicacion.id,
        locationName: ubicacion.name,
        connectedById: i.authUserId,
      })
      return { ...ligada, religadas }
    }, TX_LARGA)
    if (link.religadas > 0) {
      logger.warn(
        `[SHOPIFY] sucursal ${link.id} religada a ${intent.shopDomain}: ${link.religadas} envío(s) de la tienda anterior a DEAD_LETTER`,
      )
    }
    logAction({
      venueId: i.venueId,
      organizationId: venue.organizationId,
      staffId: i.authUserId,
      action: 'SHOPIFY_CONNECTED',
      entity: 'ShopifyLocationLink',
      entityId: link.id,
      data: { tienda: intent.shopDomain, ubicacion: ubicacion.name, generation: link.generation, religadas: link.religadas },
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
          ...credencialesDe(intent),
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
 * BR-4 («mandar antes a DEAD_LETTER sus ambiguas»): la sucursal se liga a OTRA tienda y lo que todavía estaba en camino a
 * la anterior (IN_PROGRESS, o vivo y ambiguo) no puede esperar: el reclamo sólo lo tomaría con la tienda vieja ACTIVE y
 * esta sucursal sin error terminal, y la sucursal ya apunta a la tienda nueva, así que la espera no terminaría nunca. Se
 * cierra como evidencia: DEAD_LETTER con su duda (un IN_PROGRESS con parámetros congelados pudo haber salido) y sus
 * parámetros congelados, sin reclamo. Es seguro: la generación nueva lee la tienda nueva, K10 nunca la revive (generación
 * y `lastError`), y un mensajero que vuelva de Shopify la encuentra ajena y no escribe nada (SKIPPED). Va con la sucursal
 * y sus parejas ya bloqueadas (§10.3).
 */
async function aCuarentenaPorReligar(tx: Prisma.TransactionClient, locationLinkId: string): Promise<number> {
  return tx.$executeRaw`
    UPDATE "ShopifyStockOutbox"
       SET status = 'DEAD_LETTER',
           ambiguous = (ambiguous OR (status = 'IN_PROGRESS' AND "sentInventoryItemId" IS NOT NULL)),
           "lastError" = ${RELIGADA_A_OTRA_TIENDA}, "processedAt" = ${utcTs(new Date())}, "claimToken" = NULL, "leaseUntil" = NULL
     WHERE "locationLinkId" = ${locationLinkId}
       AND (status = 'IN_PROGRESS' OR (status IN ('PENDING', 'FAILED') AND ambiguous))`
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
    const a = await atenderFalla(link.store, r, enlace, null, deps.vence)
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

/** P2-4: la conexión que se vio en una vista previa: el enlace y su generación (reconectar sube la generación). */
export type ConexionVista = { linkId: string; generation: number }
const conexionCambio = () =>
  new ConflictError('La conexión con Shopify cambió desde la vista previa; pide la vista previa otra vez.', 'SHOPIFY_CONEXION_CAMBIO')

export type FiltroVistaPrevia = 'CAMBIAN' | 'NUEVOS' | 'TODOS'
export type EleccionConexion = 'AVOQADO' | 'SHOPIFY'
/** D1: la conexión que una pantalla VIO; guardar la exige y la compara bajo candado (una pantalla vieja no guarda). */
export type VistaConexion = { linkId: string; generation: number; tokenVersion: number }
/** Tope por llamada (ruta, MCP e ids de la vista previa): una página. */
export const MAX_ELECCIONES = 50
/** Forma que consume C (`ShopifyConnectReviewItem`) más `quedara` (aditivo, §10.12) y, desde D1, la decisión del dueño. */
type FilaVista = {
  variantLinkId: string
  productId: string
  name: string
  sku: string | null
  avoqadoQty: string
  shopifyQty: number | null
  nuevo: boolean
  quedara: string | null
  /** D1: hay que elegir qué número se queda (ya existía, sin iniciar, con Inventory, y su stock no es `quedara`). */
  requiereDecision: boolean
  /** La elección guardada que sigue en pie; null = falta (o la de antes ya no vale: cambió un número, la generación o la credencial). */
  eleccion: EleccionConexion | null
}
type ContextoVista = { id: string; generation: number; tokenVersion: number }

/**
 * D1: las piezas de SQL que la vista previa, guardar y contar lo que falta leen IGUAL.
 * - QUEDARA: lo que deja «Usar el de Shopify» = lo de Shopify al importar + lo pendiente (TOMAR_SHOPIFY, §10.12, N13).
 * - DECIDE: hay una decisión real: el producto ya existía (no lo creó la importación), sin iniciar ni suspendido, con
 *   Inventory, y su stock no es QUEDARA. Incluye el cero (tener cero no es carecer de inventario).
 * - VIGENTE: la elección guardada es de ESTA generación y credencial, y Avoqado y lo de Shopify al importar siguen en los
 *   números que se vieron. Una venta en caja durante la vista previa la invalida sola.
 */
function sqlDeVista(link: ContextoVista) {
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
  const DECIDE = Prisma.sql`(${CAMBIA} AND v."initializedAt" IS NULL AND v."suspendedReason" IS NULL AND inv.id IS NOT NULL)`
  const VIGENTE = Prisma.sql`COALESCE(v."connectChoice" IS NOT NULL
    AND v."connectChoiceGeneration" = ${link.generation}
    AND v."connectChoiceTokenVersion" = ${link.tokenVersion}
    AND v."connectSeenAvoqadoQty" = inv."currentStock"
    AND v."connectSeenShopifyQty" = v."importedAvailable", false)`
  return { DESDE, QUEDARA, CAMBIA, DECIDE, VIGENTE }
}

/**
 * «Así quedará tu stock», paginado en la base. `quedara` = lo que Shopify tenía al importar + lo que la caja vendió
 * mientras tanto (§10.12, N13): es lo que deja «Usar el de Shopify». `cambian` = existentes cuyo stock de hoy no es el que
 * quedará; `porDecidir` (D1) = los que piden elegir sin una elección vigente, en TODAS las páginas (también con `ids`). `ids`
 * (≤ 50, para el MCP) limita las filas, nunca el resumen. `conexion` es lo que la pantalla devuelve al guardar.
 */
export async function getConnectReview(i: { venueId: string; offset: unknown; limit: unknown; filtro: FiltroVistaPrevia; ids?: string[] }) {
  const limit = Math.min(50, Math.max(1, Math.floor(Number(i.limit) || 20)))
  const offset = Math.max(0, Math.floor(Number(i.offset) || 0))
  const resumenVacio = { emparejados: 0, cambian: 0, nuevos: 0, sinPareja: 0, porDecidir: 0 }
  const link = await prisma.shopifyLocationLink.findUnique({
    where: { venueId: i.venueId },
    select: { id: true, generation: true, store: { select: { tokenVersion: true } } },
  })
  if (!link) {
    return {
      items: [] as FilaVista[],
      total: 0,
      nextOffset: null as number | null,
      resumen: resumenVacio,
      conexion: null as VistaConexion | null,
    }
  }
  const conexion: VistaConexion = { linkId: link.id, generation: link.generation, tokenVersion: link.store.tokenVersion }
  const { DESDE, QUEDARA, CAMBIA, DECIDE, VIGENTE } = sqlDeVista({
    id: link.id,
    generation: link.generation,
    tokenVersion: link.store.tokenVersion,
  })
  const porFiltro =
    i.filtro === 'NUEVOS' ? Prisma.sql`AND v."createdProduct" = true` : i.filtro === 'CAMBIAN' ? Prisma.sql`AND ${CAMBIA}` : Prisma.empty
  const ids = (i.ids ?? []).slice(0, MAX_ELECCIONES)
  const filtro = ids.length > 0 ? Prisma.sql`${porFiltro} AND v.id IN (${Prisma.join(ids)})` : porFiltro
  const [filas, [cuenta], [res], sinPareja] = await Promise.all([
    prisma.$queryRaw<Array<Omit<FilaVista, 'avoqadoQty'> & { avoqadoQty: string | null }>>`
      SELECT v.id AS "variantLinkId", v."productId", p.name, p.sku, inv."currentStock"::text AS "avoqadoQty",
             v."importedAvailable" AS "shopifyQty", v."createdProduct" AS nuevo, ${QUEDARA}::text AS quedara,
             ${DECIDE} AS "requiereDecision",
             CASE WHEN ${DECIDE} AND ${VIGENTE} THEN v."connectChoice"::text END AS eleccion
        ${DESDE}
        JOIN "Product" p ON p.id = v."productId"
       WHERE v."locationLinkId" = ${link.id} ${filtro}
       ORDER BY p.name ASC, v.id ASC
       LIMIT ${limit} OFFSET ${offset}`,
    prisma.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total ${DESDE} WHERE v."locationLinkId" = ${link.id} ${filtro}`,
    prisma.$queryRaw<Array<{ emparejados: number; nuevos: number; cambian: number; porDecidir: number }>>`
      SELECT count(*)::int AS emparejados,
             (count(*) FILTER (WHERE v."createdProduct"))::int AS nuevos,
             (count(*) FILTER (WHERE ${CAMBIA}))::int AS cambian,
             (count(*) FILTER (WHERE ${DECIDE} AND NOT ${VIGENTE}))::int AS "porDecidir"
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
    resumen: {
      emparejados: res?.emparejados ?? 0,
      cambian: res?.cambian ?? 0,
      nuevos: res?.nuevos ?? 0,
      sinPareja,
      porDecidir: res?.porDecidir ?? 0,
    },
    conexion,
  }
}

/** D1: cuántos productos piden elegir y no tienen una elección vigente (todas las páginas). Agregado: acotado por diseño. */
export async function contarPorDecidir(db: Prisma.TransactionClient, link: ContextoVista): Promise<number> {
  const { DESDE, DECIDE, VIGENTE } = sqlDeVista(link)
  const [r] = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n ${DESDE} WHERE v."locationLinkId" = ${link.id} AND ${DECIDE} AND NOT ${VIGENTE}`
  return r?.n ?? 0
}

const faltanDecisiones = (n: number) =>
  new ValidationError(
    `Falta elegir en ${n === 1 ? '1 producto' : `${n} productos`} qué número se queda: en «Cambian», elige «Usar el de Avoqado» o «Usar el de Shopify» en cada uno (o «Usar Avoqado en los que faltan» / «Usar Shopify en los que faltan») y vuelve a aplicar.`,
    'SHOPIFY_FALTAN_DECISIONES',
  )
const revisionCambio = () =>
  new ConflictError(
    'Los números cambiaron desde que los viste: ya se muestran los de ahora; revísalos y vuelve a elegir',
    'SHOPIFY_REVISION_CAMBIO',
  )
const vistaVieja = () =>
  new ConflictError(
    'La conexión con Shopify cambió desde que viste la lista (se reconectó o se volvió a dar permiso): vuelve a cargar la vista previa y elige otra vez.',
    'SHOPIFY_CONEXION_CAMBIO',
  )

export type EleccionVista = { variantLinkId: string; choice: EleccionConexion; expectedAvoqadoQty: string; expectedShopifyQty: number }

/**
 * D1: guarda la elección del dueño en cada pareja, con los números que VIO, o con `todos` la misma opción en TODOS los
 * productos que todavía no tienen una elección vigente (todas las páginas; los ya elegidos se quedan; con «AVOQADO» se
 * saltan los que no darían piezas enteras). La forma la valida Zod (ruta y MCP); aquí: pertenencia, repetidos, la conexión
 * vista (P1-2), las cantidades vigentes y el ajuste entero.
 * UNA tx con los candados en orden (§10.3): sucursal FOR SHARE (con ella tomada, «Aplicar», que la escribe, espera) → tienda
 * FOR SHARE → la vista comparada → las parejas por id FOR UPDATE. Guardar no toca stock ni espejo: aplicar lo revalida.
 */
export async function saveConnectChoices(
  i: { venueId: string; staffId: string; vista: VistaConexion; elecciones?: EleccionVista[]; todos?: EleccionConexion },
  deps: { hasAccess?: (venueId: string) => Promise<boolean> } = {},
): Promise<{ guardadas: number; porDecidir: number }> {
  if (!(await (deps.hasAccess ?? accesoReal)(i.venueId))) throw new ForbiddenError(TEXTO_SIN_ACCESO, 'SHOPIFY_SIN_PLAN')
  const elecciones = i.todos ? [] : (i.elecciones ?? [])
  const ids = [...new Set(elecciones.map(e => e.variantLinkId))]
  if (ids.length !== elecciones.length) {
    throw new BadRequestError('Un producto viene dos veces: recarga la vista previa y vuelve a elegir', 'SHOPIFY_CANTIDAD_INVALIDA')
  }
  const r = await prisma.$transaction(async tx => {
    const [l] = await tx.$queryRaw<
      Array<{ id: string; status: string; generation: number; applyRequestedAt: Date | null; storeId: string }>
    >`
      SELECT id, status::text AS status, generation, "applyRequestedAt", "storeId"
        FROM "ShopifyLocationLink" WHERE "venueId" = ${i.venueId} FOR SHARE`
    if (!l || l.status === 'DISCONNECTED')
      throw new ConflictError('Esta sucursal no tiene una tienda Shopify conectada', 'SHOPIFY_SIN_CONEXION')
    const [s] = await tx.$queryRaw<Array<{ tokenVersion: number; organizationId: string }>>`
      SELECT "tokenVersion", "organizationId" FROM "ShopifyStore" WHERE id = ${l.storeId} FOR SHARE`
    // P1-2: lo que la pantalla vio debe ser la conexión de AHORA (reconectar sube la generación; reautorizar, la credencial).
    if (!s || l.id !== i.vista.linkId || l.generation !== i.vista.generation || s.tokenVersion !== i.vista.tokenVersion) throw vistaVieja()
    if (l.status !== 'REVIEWING' || l.applyRequestedAt) {
      throw new ConflictError('La vista previa todavía no está lista, o ya se aplicó', 'SHOPIFY_NO_EN_REVISION')
    }
    const ctx = { id: l.id, generation: l.generation, tokenVersion: s.tokenVersion }
    const { DESDE, QUEDARA, DECIDE, VIGENTE } = sqlDeVista(ctx)

    if (i.todos) {
      // Las candidatas por id (§10.3) y, en UNA sentencia, la misma opción con lo que hay AHORA como «lo que se vio».
      // Explícito del dueño, sobre su catálogo de esta sucursal (tope del catálogo: CATALOGO_MUY_GRANDE).
      await tx.$queryRaw`
        SELECT count(*) FROM (
          SELECT id FROM "ShopifyVariantLink"
           WHERE "locationLinkId" = ${l.id} AND "initializedAt" IS NULL AND "suspendedReason" IS NULL
           ORDER BY id FOR UPDATE
        ) candidatas`
      // P2-a: el mismo predicado que `motivoAvoqadoNoSeManda`, en SQL: Avoqado entero Y la diferencia con lo que quedará, entera.
      const entero =
        i.todos === 'AVOQADO'
          ? Prisma.sql`AND inv."currentStock" = trunc(inv."currentStock") AND (inv."currentStock" - ${QUEDARA}) = trunc(inv."currentStock" - ${QUEDARA})`
          : Prisma.empty
      const guardadas = await tx.$executeRaw`
        UPDATE "ShopifyVariantLink" w
           SET "connectChoice" = ${i.todos}::"ShopifyReviewChoice",
               "connectChoiceGeneration" = ${l.generation},
               "connectChoiceTokenVersion" = ${s.tokenVersion},
               "connectSeenAvoqadoQty" = x.a,
               "connectSeenShopifyQty" = x.s,
               "connectChoiceById" = ${i.staffId}
          FROM (SELECT v.id, inv."currentStock" AS a, v."importedAvailable" AS s ${DESDE}
                 WHERE v."locationLinkId" = ${l.id} AND ${DECIDE} AND NOT ${VIGENTE} ${entero}) x
         WHERE w.id = x.id`
      return { linkId: l.id, organizationId: s.organizationId, ctx, guardadas, data: { todos: i.todos, guardadas } }
    }

    await tx.$queryRaw`
      SELECT id FROM "ShopifyVariantLink" WHERE id IN (${Prisma.join(ids)}) AND "locationLinkId" = ${l.id} ORDER BY id FOR UPDATE`
    const filas = await tx.$queryRaw<
      Array<{ id: string; productId: string; decide: boolean; avoqado: string | null; shopify: number | null; quedara: string | null }>
    >`
      SELECT v.id, v."productId", ${DECIDE} AS decide, inv."currentStock"::text AS avoqado,
             v."importedAvailable" AS shopify, ${QUEDARA}::text AS quedara
        ${DESDE}
       WHERE v."locationLinkId" = ${l.id} AND v.id IN (${Prisma.join(ids)})`
    const porId = new Map(filas.map(f => [f.id, f]))
    const hechas: Array<{ productId: string; eleccion: EleccionConexion; avoqado: string; shopify: number }> = []
    for (const e of elecciones) {
      const f = porId.get(e.variantLinkId)
      if (!f) throw new ConflictError('Ese producto ya no está ligado a Shopify: recarga la lista', 'SHOPIFY_SIN_PAREJA')
      const visto = new Prisma.Decimal(e.expectedAvoqadoQty)
      if (
        !f.decide ||
        f.avoqado === null ||
        f.quedara === null ||
        !new Prisma.Decimal(f.avoqado).equals(visto) ||
        f.shopify !== e.expectedShopifyQty
      ) {
        throw revisionCambio()
      }
      // «Avoqado» manda a Shopify A − S − pendientes = A − QUEDARA, y a Shopify sólo viajan piezas enteras: hace falta Avoqado entero
      // Y la diferencia entera (P2-a: con 4.5, 6 y −0.5 pendiente la diferencia es entera, pero Shopify no terminaría en 4.5).
      const noSeManda = e.choice === 'AVOQADO' ? motivoAvoqadoNoSeManda(visto, f.quedara) : null
      if (noSeManda) {
        throw new ValidationError(
          noSeManda === 'AVOQADO_CON_DECIMALES'
            ? `El stock de Avoqado (${visto}) tiene decimales y Shopify sólo cuenta piezas enteras, así que no podría quedar igual que Avoqado. Corrige el stock de Avoqado a piezas enteras y vuelve a elegir, o usa el de Shopify`
            : 'La diferencia no es de piezas enteras: corrige el stock de Avoqado a piezas enteras y vuelve a elegir',
          'SHOPIFY_DIFERENCIA_NO_ENTERA',
        )
      }
      await tx.shopifyVariantLink.update({
        where: { id: f.id },
        data: {
          connectChoice: e.choice,
          connectChoiceGeneration: l.generation,
          connectChoiceTokenVersion: s.tokenVersion,
          connectSeenAvoqadoQty: visto,
          connectSeenShopifyQty: e.expectedShopifyQty,
          connectChoiceById: i.staffId,
        },
      })
      hechas.push({ productId: f.productId, eleccion: e.choice, avoqado: visto.toString(), shopify: e.expectedShopifyQty })
    }
    return { linkId: l.id, organizationId: s.organizationId, ctx, guardadas: hechas.length, data: { elecciones: hechas } }
  }, TX_LARGA)
  // Un «en todos» que no encontró a nadie no cambió nada: un no-op no se registra.
  if (r.guardadas > 0) {
    logAction({
      venueId: i.venueId,
      organizationId: r.organizationId,
      staffId: i.staffId,
      action: 'SHOPIFY_CONNECT_CHOICES_SAVED',
      entity: 'ShopifyLocationLink',
      entityId: r.linkId,
      data: r.data,
    })
  }
  return { guardadas: r.guardadas, porDecidir: await contarPorDecidir(prisma, r.ctx) }
}

export async function requestApplyShopifyConnect(
  i: { venueId: string; staffId: string; expected?: ConexionVista },
  deps: { hasAccess?: (venueId: string) => Promise<boolean> } = {},
): Promise<{ applyRequestedAt: Date }> {
  if (!(await (deps.hasAccess ?? accesoReal)(i.venueId))) {
    throw new ForbiddenError(TEXTO_SIN_ACCESO, 'SHOPIFY_SIN_PLAN')
  }
  // D1: no se aplica mientras falte una elección, también de páginas que nadie abrió. La carrera con una venta que la
  // invalide después de contar la cierra la tx de cada producto al aplicar (`initializePair`).
  const vigente = await prisma.shopifyLocationLink.findUnique({
    where: { venueId: i.venueId },
    select: { id: true, status: true, generation: true, applyRequestedAt: true, store: { select: { tokenVersion: true } } },
  })
  if (vigente && i.expected && (vigente.id !== i.expected.linkId || vigente.generation !== i.expected.generation)) throw conexionCambio()
  if (vigente?.status === 'REVIEWING' && !vigente.applyRequestedAt) {
    const faltan = await contarPorDecidir(prisma, {
      id: vigente.id,
      generation: vigente.generation,
      tokenVersion: vigente.store.tokenVersion,
    })
    if (faltan > 0) throw faltanDecisiones(faltan)
  }
  // P2-4: con `expected` (la confirmación del MCP), la conexión vista va DENTRO del `where`: si entre la vista previa y el
  // confirm alguien desconectó y reconectó (aunque sea la misma tienda y ubicación), no se aplica la conexión nueva.
  const r = await prisma.shopifyLocationLink.updateMany({
    where: {
      venueId: i.venueId,
      status: 'REVIEWING',
      applyRequestedAt: null,
      ...(i.expected ? { id: i.expected.linkId, generation: i.expected.generation } : {}),
    },
    data: { applyRequestedAt: new Date(), applyRequestedById: i.staffId },
  })
  const link = await prisma.shopifyLocationLink.findUnique({
    where: { venueId: i.venueId },
    select: { id: true, status: true, generation: true, applyRequestedAt: true, store: { select: { organizationId: true } } },
  })
  if (link && i.expected && (link.id !== i.expected.linkId || link.generation !== i.expected.generation)) throw conexionCambio()
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
): Promise<{ done: boolean; procesadas: number; error?: string; devuelta?: boolean }> {
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
    const a = await atenderFalla(link.store, r, [{ id: link.id, generation: link.generation }], null, deps.vence)
    return { done: false, procesadas: 0, error: a === 'SIN_PERMISO' ? FALTA_PERMISO : r.code }
  }
  let procesadas = 0
  for (const p of tanda) {
    if (restante(deps.vence) < MIN_ESCRITURA_MS) return { done: false, procesadas, error: 'SIN_TIEMPO' } // §12.8: lo que falta, otra vuelta
    const nivel = r.data.get(levelKey(link.shopifyLocationId, p.inventoryItemId)) ?? { kind: 'SIN_NIVEL' as const }
    const o = await initializePair({ variantLinkId: p.id, nivel, fetchedAt, mode: 'TOMAR_SHOPIFY' }, { hasAccess, cerco })
    if (o === 'CONTEXTO_CAMBIO') return { done: false, procesadas, error: 'CONTEXTO_CAMBIO' } // otro tiene la sucursal: nada más
    if (o === 'NO_APLICA') break // cambió la fase, la tienda o el plan: el worker lo verá en la siguiente vuelta
    // D1 (P1-3): al primer producto cuya elección ya no vale, la conexión regresa a la vista previa y la tanda TERMINA (lo
    // aplicado se queda). Seguir con las demás dejaría las mismas primeras filas para cada vuelta y la conexión en
    // «Aplicando» para siempre. Si el regreso no pudo (otro cerco), la siguiente vuelta lo vuelve a intentar con el suyo.
    if (o === 'POR_DECIDIR') {
      if (!(await devolverAVistaPrevia(link.id, cerco, p.id))) return { done: false, procesadas }
      // Ya de regreso: las DEMÁS filas de esta tanda (ya leída) cuyo nivel cambió toman el número nuevo, para que UN regreso
      // enseñe todo lo que hay que volver a elegir. Sin aplicar nada ni tocar stock; lo que no alcance el tiempo lo vuelve a
      // ver el siguiente «Aplicar», fila por fila.
      for (const otra of tanda) {
        if (otra.id === p.id) continue
        if (restante(deps.vence) < MIN_ESCRITURA_MS) break
        const n = r.data.get(levelKey(link.shopifyLocationId, otra.inventoryItemId))
        if (n?.kind !== 'OK') continue
        // Mejor esfuerzo, A PROPÓSITO: el regreso a la vista previa ya se confirmó (y es lo único que movió algo). Si el refresco de
        // UNA fila falla, la unidad no debe contarse como fallida (el worker esperaría `ESPERA_FALLA_MS` por un regreso que sí
        // ocurrió): se avisa en el log y se sigue con las demás; la fila sin refrescar la vuelve a ver el siguiente «Aplicar».
        // (Un envoltorio de contexto nunca se traga errores; éste es un paso aparte, posterior al trabajo ya confirmado.)
        try {
          await refrescarLoImportado(otra.id, n.available, cerco)
        } catch (err) {
          logger.warn(
            `[SHOPIFY] sucursal ${link.id}: no se pudo refrescar lo importado de la pareja ${otra.id} al regresar a la vista previa; ` +
              `el siguiente «Aplicar» la vuelve a ver: ${(err as Error).message}`,
          )
        }
      }
      return { done: false, procesadas, devuelta: true }
    }
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

/**
 * D1: «Aplicar» encontró un producto cuya elección ya no es la que se vio (una venta, un cambio en Shopify, una credencial
 * nueva). No se adivina: la conexión vuelve a «Así quedará tu stock» (REVIEWING sin «Aplicar» pedido), lo ya aplicado se
 * queda, y la página lo dice al volver. Como `terminarAplicacion`: la sucursal FOR UPDATE (§10.3), la aplicación todavía
 * pedida, y el MISMO cerco de quien aplicó (P2-4: generación, tienda ACTIVE, ubicación, credencial, lease, sin error
 * terminal). Si algo no coincide, no toca nada.
 */
export async function devolverAVistaPrevia(linkId: string, cerco: CercoShopify, variantLinkId: string): Promise<boolean> {
  const r = await prisma.$transaction(async tx => {
    const [l] = await tx.$queryRaw<Array<{ status: string; applyRequestedAt: Date | null; venueId: string; organizationId: string }>>`
      SELECT l.status::text AS status, l."applyRequestedAt", l."venueId", s."organizationId"
        FROM "ShopifyLocationLink" l JOIN "ShopifyStore" s ON s.id = l."storeId"
       WHERE l.id = ${linkId}
       FOR UPDATE OF l`
    if (!l || l.status !== 'REVIEWING' || !l.applyRequestedAt) return null
    if (!(await cercoVigente(tx, linkId, cerco))) return null
    await tx.shopifyLocationLink.update({ where: { id: linkId }, data: { applyRequestedAt: null, applyRequestedById: null } })
    return l
  })
  if (!r) return false
  logAction({
    venueId: r.venueId,
    organizationId: r.organizationId,
    action: 'SHOPIFY_APPLY_RETURNED',
    entity: 'ShopifyLocationLink',
    entityId: linkId,
    data: { variantLinkId },
  })
  return true
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
export async function disconnectShopify(i: {
  venueId: string
  staffId: string | null
  /** P2-4: la conexión que se VIO (confirmación del MCP); se compara con la sucursal ya bloqueada. */
  expected?: ConexionVista
}): Promise<{ desconectada: boolean }> {
  const r = await prisma.$transaction(async tx => {
    const [yo] = await tx.$queryRaw<Array<{ id: string; storeId: string }>>`
      SELECT id, "storeId" FROM "ShopifyLocationLink" WHERE "venueId" = ${i.venueId}`
    if (!yo) return null
    // ponytail: las sucursales de UNA tienda son un puñado; el tope es defensa (el mismo de A).
    const antes = await tx.$queryRaw<Hermana[]>`
      SELECT id, status::text AS status FROM "ShopifyLocationLink"
       WHERE "storeId" = ${yo.storeId} AND id < ${yo.id} ORDER BY id LIMIT 1000 FOR NO KEY UPDATE`
    const [l] = await tx.$queryRaw<Array<{ id: string; status: string; storeId: string; generation: number }>>`
      SELECT id, status::text AS status, "storeId", generation FROM "ShopifyLocationLink" WHERE id = ${yo.id} FOR UPDATE`
    const despues = await tx.$queryRaw<Hermana[]>`
      SELECT id, status::text AS status FROM "ShopifyLocationLink"
       WHERE "storeId" = ${yo.storeId} AND id > ${yo.id} ORDER BY id LIMIT 1000 FOR NO KEY UPDATE`
    // P2-4: bajo el candado de la sucursal, ¿es la conexión que se vio? Si no, nada se escribe (la tx se deshace).
    if (l && i.expected && (l.id !== i.expected.linkId || l.generation !== i.expected.generation)) throw conexionCambio()
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
