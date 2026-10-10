// tests/integration/shopify/conexion.integration.test.ts
/**
 * La conexión (B3): OAuth de un solo uso, ubicación verificada con el token, confirmar con las reglas de generación y las
 * barreras de envío en camino, vista previa con lo que quedará, aplicar por tandas (RF1 desde un producto sin pareja),
 * webhooks de uno en uno, pausa y reanudación durables, y desconexión que descarta lo que nunca salió y deja cerrarse lo
 * que iba en camino sin mover el espejo (§9.1). Postgres real; Shopify por deps.
 */
jest.mock('@/config/env', () => {
  const real = jest.requireActual('@/config/env')
  return { ...real, env: { ...real.env, BASE_URL: 'https://api.test', FRONTEND_URL: 'https://dash.test' } }
})

import crypto from 'crypto'
import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { SHOPIFY_SCOPES, SHOPIFY_WEBHOOK_TOPICS } from '@/services/commerce-channels/shopify/shopify.constants'
import { encryptShopifyToken, signIntentId, verifyOAuthQueryHmac } from '@/services/commerce-channels/shopify/shopify.crypto'
import { claimShopifyOutbox, runShopifyOutboxRow } from '@/services/commerce-channels/shopify/shopify.outbox.service'
import { importCatalogPage } from '@/services/commerce-channels/shopify/shopify.catalog.service'
import { requeueDeferredEvents } from '@/services/commerce-channels/shopify/shopify.inbound.service'
import {
  applyConnectPage,
  confirmShopifyConnect,
  disconnectShopify,
  getConnectReview,
  handleShopifyCallback,
  listIntentLocations,
  pauseShopifyLink,
  registerShopifyWebhooks,
  requestApplyShopifyConnect,
  resumeShopifyLink,
  startShopifyConnect,
} from '@/services/commerce-channels/shopify/shopify.connect.service'
import {
  agregarProductoShopify,
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  graphqlFalso,
  huecoDelInvariante,
  limpiarEscenarioShopify,
  TOKEN_DE_PRUEBA,
  UBICACION_PRUEBA,
} from './fixtures'
import {
  conPlan,
  dormir,
  falla,
  graphqlConEfecto,
  limpiarOtraSucursal,
  nivel,
  nivelesFalsos,
  otraSucursalDeLaTienda,
  paginaDeVariantes,
  variante,
} from './fixturesB'
import { MIN_HTTP_MS } from '@/services/commerce-channels/shopify/shopify.store.service'

jest.setTimeout(120_000)
const SECRETO = 'secreto-app-piloto'

let escenarios: EscenarioShopify[] = []
let otras: EscenarioShopify[] = []
async function escenario(o?: Parameters<typeof crearEscenarioShopify>[0]): Promise<EscenarioShopify> {
  const e = await crearEscenarioShopify(o)
  escenarios.push(e)
  process.env.SHOPIFY_PILOTO_SHOPS = [process.env.SHOPIFY_PILOTO_SHOPS, e.shopDomain].filter(Boolean).join(',')
  return e
}
beforeAll(() => {
  assertTestDatabase()
  Object.assign(process.env, {
    SHOPIFY_PILOTO_CLIENT_ID: 'cliente',
    SHOPIFY_PILOTO_CLIENT_SECRET: SECRETO,
    OAUTH_STATE_SECRET: 'estado-de-prueba',
  })
})
beforeEach(() => {
  process.env.SHOPIFY_PILOTO_SHOPS = 'mi-tienda.myshopify.com'
  ;(logAction as jest.Mock).mockClear()
})
afterEach(async () => {
  for (const s of otras) await limpiarOtraSucursal(s) // antes que el dueño de la tienda
  otras = []
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
})

/** Firma una consulta como Shopify; devuelve los MISMOS campos que recibió (con su tipo) más `hmac`. */
const firmarConsulta = <Q extends Record<string, string>>(q: Q): Q & { hmac: string } => {
  const msg = Object.keys(q)
    .sort()
    .map(k => `${k}=${q[k]}`)
    .join('&')
  return { ...q, hmac: crypto.createHmac('sha256', SECRETO).update(msg).digest('hex') }
}
const sinConexion = async (e: EscenarioShopify) => {
  await prisma.shopifyVariantLink.deleteMany({ where: { venueId: e.venueId } })
  await prisma.shopifyLocationLink.deleteMany({ where: { venueId: e.venueId } })
}
async function intentAutorizado(e: EscenarioShopify, dominio: string): Promise<string> {
  const i = await prisma.shopifyConnectIntent.create({
    data: {
      venueId: e.venueId,
      authUserId: e.staffId,
      shopDomain: dominio,
      appKey: 'PILOTO',
      status: 'EXCHANGED',
      tokenCiphertext: encryptShopifyToken(TOKEN_DE_PRUEBA),
      scopes: SHOPIFY_SCOPES,
      expiresAt: new Date(Date.now() + 600_000),
    },
  })
  return signIntentId(i.id)
}
const confirmacion = (o: { id?: string; name?: string; isActive?: boolean; nula?: boolean } = {}) =>
  graphqlFalso((_q, vars) => ({
    ok: true,
    data: { location: o.nula ? null : { id: o.id ?? vars.id, name: o.name ?? 'México Centro', isActive: o.isActive ?? true } },
  }))
const exitoCanje = () => jest.fn(async () => ({ ok: true as const, data: { accessToken: 'shpat_nuevo', scope: SHOPIFY_SCOPES } }))
const sucursal = (e: EscenarioShopify) => prisma.shopifyLocationLink.findUniqueOrThrow({ where: { venueId: e.venueId } })
const slugDe = async (e: EscenarioShopify) =>
  (await prisma.venue.findUniqueOrThrow({ where: { id: e.venueId }, select: { slug: true } })).slug
const enVuelo = (e: EscenarioShopify, generation = 1) =>
  prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation,
      productId: e.productId,
      delta: -1,
      status: 'IN_PROGRESS',
      claimToken: 'mensajero',
      leaseUntil: new Date(Date.now() + 60_000),
    },
  })
const exito = () =>
  graphqlFalso(() => ({ ok: true, data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: 'g1' }, userErrors: [] } } }))

describe('iniciar', () => {
  it('dominio inválido ⇒ 400; tienda fuera del piloto ⇒ 409 SHOPIFY_SOLO_PILOTO', async () => {
    const e = await escenario()
    const i = { venueId: e.venueId, authUserId: e.staffId, purpose: 'CONNECT' as const }
    await expect(startShopifyConnect({ ...i, shopDomain: 'evil.com' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'SHOPIFY_DOMINIO_INVALIDO',
    })
    await expect(startShopifyConnect({ ...i, shopDomain: 'otra.myshopify.com' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_SOLO_PILOTO',
    })
  })

  it('arma la URL con los scopes, el redirect_uri de BASE_URL (#34) y el state firmado; el intent queda CREATED', async () => {
    const e = await escenario()
    const { url } = await startShopifyConnect({
      venueId: e.venueId,
      authUserId: e.staffId,
      shopDomain: ' Mi-Tienda.myshopify.com ',
      purpose: 'CONNECT',
    })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://mi-tienda.myshopify.com/admin/oauth/authorize')
    expect(u.searchParams.get('client_id')).toBe('cliente')
    expect(u.searchParams.get('scope')).toBe(SHOPIFY_SCOPES)
    expect(u.searchParams.get('redirect_uri')).toBe('https://api.test/api/v1/shopify/oauth/callback')
    expect(u.searchParams.get('state')).toMatch(/^c[a-z0-9]+\.[0-9a-f]{64}$/)
    expect(await prisma.shopifyConnectIntent.findFirstOrThrow({ where: { venueId: e.venueId } })).toMatchObject({
      shopDomain: 'mi-tienda.myshopify.com',
      status: 'CREATED',
      purpose: 'CONNECT',
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHOPIFY_CONNECT_STARTED',
        venueId: e.venueId,
        organizationId: e.organizationId,
        staffId: e.staffId,
      }),
    )
  })

  it('reautorizar una tienda que esta sucursal no tiene ⇒ 409', async () => {
    const e = await escenario()
    await expect(
      startShopifyConnect({ venueId: e.venueId, authUserId: e.staffId, shopDomain: 'mi-tienda.myshopify.com', purpose: 'REAUTHORIZE' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_REAUTORIZAR_SIN_TIENDA' })
  })
})

describe('callback (#26)', () => {
  async function iniciado(e: EscenarioShopify, purpose: 'CONNECT' | 'REAUTHORIZE' = 'CONNECT', dominio = 'mi-tienda.myshopify.com') {
    const { url } = await startShopifyConnect({ venueId: e.venueId, authUserId: e.staffId, shopDomain: dominio, purpose })
    return firmarConsulta({ code: 'c1', shop: dominio, state: new URL(url).searchParams.get('state')!, timestamp: '1700000000' })
  }

  it('hmac inválido ⇒ ?error=FIRMA y no canjea', async () => {
    const e = await escenario()
    const q = await iniciado(e)
    const exchange = exitoCanje()
    expect(await handleShopifyCallback({ ...q, hmac: '0'.repeat(64) }, { exchange })).toContain('?error=FIRMA')
    expect(exchange).not.toHaveBeenCalled()
  })

  it('válido ⇒ EXCHANGED con el token cifrado y regresa a la página con el intent; el mismo state otra vez ⇒ usado', async () => {
    const e = await escenario()
    const q = await iniciado(e)
    const exchange = exitoCanje()
    const destino = await handleShopifyCallback(q, { exchange })
    expect(destino).toBe(`https://dash.test/venues/${await slugDe(e)}/settings/integrations/shopify?intent=${encodeURIComponent(q.state)}`)
    const intent = await prisma.shopifyConnectIntent.findFirstOrThrow({ where: { venueId: e.venueId } })
    expect(intent.status).toBe('EXCHANGED')
    expect(Buffer.from(intent.tokenCiphertext!).toString('utf8')).not.toContain('shpat_nuevo')
    expect(await handleShopifyCallback(q, { exchange })).toContain('?error=USADO')
    expect(exchange).toHaveBeenCalledTimes(1)
  })

  it('dos callbacks a la vez con el mismo state ⇒ UN solo canje', async () => {
    const e = await escenario()
    const q = await iniciado(e)
    const exchange = jest.fn(async () => {
      await new Promise(r => setTimeout(r, 50))
      return { ok: true as const, data: { accessToken: 'shpat_x', scope: SHOPIFY_SCOPES } }
    })
    const destinos = await Promise.all([handleShopifyCallback(q, { exchange }), handleShopifyCallback(q, { exchange })])
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(destinos.filter(d => d.includes('?intent=')).length).toBe(1)
    expect(destinos.filter(d => d.includes('?error=USADO')).length).toBe(1)
  })

  it('canje fallido ⇒ ?error=INTERCAMBIO; sin los permisos pedidos ⇒ ?error=DENEGADO; los dos quedan FAILED', async () => {
    const e = await escenario()
    const q1 = await iniciado(e)
    const fallo = jest.fn(async () => ({ ok: false as const, code: 'HTTP_4XX' as const, retryable: false, ambiguous: false, message: 'x' }))
    expect(await handleShopifyCallback(q1, { exchange: fallo })).toContain('?error=INTERCAMBIO')
    const q2 = await iniciado(e)
    const corto = jest.fn(async () => ({ ok: true as const, data: { accessToken: 'shpat_y', scope: 'read_products' } }))
    expect(await handleShopifyCallback(q2, { exchange: corto })).toContain('?error=DENEGADO')
    expect(await prisma.shopifyConnectIntent.count({ where: { venueId: e.venueId, status: 'FAILED' } })).toBe(2)
  })

  it('REAUTHORIZE: token nuevo, tokenVersion + 1, autorización sellada, FALTA_PERMISO limpio, webhooks otra vez y, en la MISMA tx, requeuePending y cuadre pedido', async () => {
    const e = await escenario()
    await prisma.shopifyStore.update({
      where: { id: e.storeId },
      data: { status: 'REVOKED', revokedAt: new Date(), authorizedAt: new Date('2026-01-01T00:00:00Z') },
    })
    await prisma.shopifyLocationLink.update({
      where: { id: e.locationLinkId },
      data: { webhooksAt: new Date(), importError: 'FALTA_PERMISO' },
    })
    const cat = await prisma.shopifyInboundEvent.create({
      data: {
        dedupKey: crypto.randomUUID(),
        appKey: 'PILOTO',
        topic: 'products/update',
        shopDomain: e.shopDomain,
        payload: { id: 1 },
        status: 'DEFERRED',
      },
    })
    const q = await iniciado(e, 'REAUTHORIZE', e.shopDomain)
    expect(await handleShopifyCallback(q, { exchange: exitoCanje() })).toContain('?reautorizada=1')
    const tienda = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
    expect(tienda).toMatchObject({ status: 'ACTIVE', revokedAt: null, tokenVersion: 2 })
    expect(tienda.authorizedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(await sucursal(e)).toMatchObject({
      status: 'ACTIVE',
      generation: 1,
      webhooksAt: null,
      reconcileVersion: 1,
      requeuePending: true,
      importError: null,
    })
    expect((await prisma.shopifyInboundEvent.findUniqueOrThrow({ where: { id: cat.id } })).status).toBe('DEFERRED') // lo reabre el drenado
    expect(await requeueDeferredEvents(e.locationLinkId)).toMatchObject({ reabiertos: 1, terminado: true })
    expect((await prisma.shopifyConnectIntent.findFirstOrThrow({ where: { venueId: e.venueId } })).status).toBe('CONSUMED')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SHOPIFY_REAUTHORIZED', venueId: e.venueId, organizationId: e.organizationId, staffId: e.staffId }),
    )
  })
})

describe('ubicaciones y confirmar (#22, #27, #8, N03, N06)', () => {
  it('lista TODAS las páginas de ubicaciones activas; el intent de otra persona ⇒ 403', async () => {
    const e = await escenario()
    const intent = await intentAutorizado(e, 'mi-tienda.myshopify.com')
    const graphql = graphqlFalso((_q, vars) =>
      vars.after
        ? {
            ok: true,
            data: {
              locations: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: 'gid://shopify/Location/3', name: 'Monterrey', isActive: true, address: { countryCode: 'MX' } }],
              },
            },
          }
        : {
            ok: true,
            data: {
              locations: {
                pageInfo: { hasNextPage: true, endCursor: 'u1' },
                nodes: [
                  { id: 'gid://shopify/Location/1', name: 'CDMX', isActive: true, address: { countryCode: 'MX' } },
                  { id: 'gid://shopify/Location/2', name: 'Cerrada', isActive: false, address: null },
                ],
              },
            },
          },
    )
    expect(await listIntentLocations({ venueId: e.venueId, authUserId: e.staffId, intent }, { graphql })).toEqual([
      { id: 'gid://shopify/Location/1', name: 'CDMX', countryCode: 'MX' },
      { id: 'gid://shopify/Location/3', name: 'Monterrey', countryCode: 'MX' },
    ])
    await expect(listIntentLocations({ venueId: e.venueId, authUserId: 'otra-persona', intent }, { graphql })).rejects.toMatchObject({
      statusCode: 403,
      code: 'SHOPIFY_INTENT_DE_OTRA_PERSONA',
    })
  })

  it('N06: una ubicación con forma rara o un cursor que no avanza ⇒ 503 SHOPIFY_NO_RESPONDE', async () => {
    const e = await escenario()
    const intent = await intentAutorizado(e, 'mi-tienda.myshopify.com')
    const sinNombre = graphqlFalso(() => ({
      ok: true,
      data: {
        locations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'gid://shopify/Location/1', isActive: true }] },
      },
    }))
    await expect(listIntentLocations({ venueId: e.venueId, authUserId: e.staffId, intent }, { graphql: sinNombre })).rejects.toMatchObject({
      statusCode: 503,
      code: 'SHOPIFY_NO_RESPONDE',
    })
    const atorado = graphqlFalso(() => ({ ok: true, data: { locations: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } }))
    await expect(listIntentLocations({ venueId: e.venueId, authUserId: e.staffId, intent }, { graphql: atorado })).rejects.toMatchObject({
      statusCode: 503,
      code: 'SHOPIFY_NO_RESPONDE',
    })
  })

  it('N20: falta un permiso (403, o ACCESS_DENIED en un 200) ⇒ 403 SHOPIFY_FALTA_PERMISO al listar y al confirmar; nada se crea', async () => {
    const e = await escenario()
    await sinConexion(e)
    const intent = await intentAutorizado(e, 'mi-tienda.myshopify.com')
    const graphql = graphqlFalso(() => falla('FORBIDDEN', false, false))
    await expect(listIntentLocations({ venueId: e.venueId, authUserId: e.staffId, intent }, { graphql })).rejects.toMatchObject({
      statusCode: 403,
      code: 'SHOPIFY_FALTA_PERMISO',
    })
    await expect(
      confirmShopifyConnect({ venueId: e.venueId, authUserId: e.staffId, intent, locationId: 'gid://shopify/Location/9' }, { graphql }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'SHOPIFY_FALTA_PERMISO' })
    expect(await prisma.shopifyLocationLink.count({ where: { venueId: e.venueId } })).toBe(0)
  })

  it('nueva: ubicación verificada con el token y nombre del servidor; CONNECTING; el intent no sirve dos veces', async () => {
    const e = await escenario()
    await sinConexion(e)
    const intent = await intentAutorizado(e, 'mi-tienda.myshopify.com')
    const graphql = confirmacion({ name: 'México Centro' })
    const { locationLinkId } = await confirmShopifyConnect(
      { venueId: e.venueId, authUserId: e.staffId, intent, locationId: 'gid://shopify/Location/9' },
      { graphql },
    )
    expect(graphql.mock.calls[0][3]).toEqual({ id: 'gid://shopify/Location/9' })
    expect(await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: locationLinkId } })).toMatchObject({
      status: 'CONNECTING',
      shopifyLocationId: 'gid://shopify/Location/9',
      locationName: 'México Centro',
      generation: 1,
      webhooksAt: null,
      connectedById: e.staffId,
    })
    await expect(
      confirmShopifyConnect({ venueId: e.venueId, authUserId: e.staffId, intent, locationId: 'gid://shopify/Location/9' }, { graphql }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_INTENT_YA_USADO',
    })
  })

  it('ubicación inexistente o desactivada ⇒ 409; una respuesta con OTRA ubicación ⇒ 503 (N06); nada se crea', async () => {
    const e = await escenario()
    await sinConexion(e)
    const i = {
      venueId: e.venueId,
      authUserId: e.staffId,
      intent: await intentAutorizado(e, 'mi-tienda.myshopify.com'),
      locationId: 'gid://shopify/Location/404',
    }
    await expect(confirmShopifyConnect(i, { graphql: confirmacion({ nula: true }) })).rejects.toMatchObject({
      code: 'SHOPIFY_UBICACION_INVALIDA',
    })
    await expect(confirmShopifyConnect(i, { graphql: confirmacion({ isActive: false }) })).rejects.toMatchObject({
      code: 'SHOPIFY_UBICACION_INVALIDA',
    })
    await expect(confirmShopifyConnect(i, { graphql: confirmacion({ id: 'gid://shopify/Location/5' }) })).rejects.toMatchObject({
      statusCode: 503,
      code: 'SHOPIFY_NO_RESPONDE',
    })
    expect(await prisma.shopifyLocationLink.count({ where: { venueId: e.venueId } })).toBe(0)
  })

  it('la tienda ya es de OTRA organización ⇒ 409 y no mezcla nada', async () => {
    const e = await escenario()
    await sinConexion(e)
    const otra = await prisma.organization.create({
      data: { name: `otra-${e.venueId}`, email: `otra-${e.venueId}@example.test`, phone: '5500000000' },
    })
    await prisma.shopifyStore.create({
      data: {
        organizationId: otra.id,
        shopDomain: 'mi-tienda.myshopify.com',
        appKey: 'PILOTO',
        accessTokenCiphertext: encryptShopifyToken('x'),
        scopes: SHOPIFY_SCOPES,
      },
    })
    const i = {
      venueId: e.venueId,
      authUserId: e.staffId,
      intent: await intentAutorizado(e, 'mi-tienda.myshopify.com'),
      locationId: 'gid://shopify/Location/9',
    }
    await expect(confirmShopifyConnect(i, { graphql: confirmacion() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_TIENDA_DE_OTRA_EMPRESA',
    })
    expect(await prisma.shopifyLocationLink.count({ where: { venueId: e.venueId } })).toBe(0)
    await prisma.organization.delete({ where: { id: otra.id } }) // la tienda cae en cascada
  })

  it('una sucursal ya conectada ⇒ 409 SHOPIFY_YA_CONECTADA', async () => {
    const e = await escenario()
    const i = { venueId: e.venueId, authUserId: e.staffId, intent: await intentAutorizado(e, e.shopDomain), locationId: UBICACION_PRUEBA }
    await expect(confirmShopifyConnect(i, { graphql: confirmacion({ id: UBICACION_PRUEBA }) })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_YA_CONECTADA',
    })
  })

  it('reconectar la MISMA tienda y ubicación tras desconectar: conserva las parejas sin iniciar, sube la generación y sella la autorización', async () => {
    const e = await escenario({ linkStatus: 'DISCONNECTED' })
    await prisma.shopifyImportIssue.create({
      data: {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/77',
        shopifyProductId: 'gid://shopify/Product/77',
        title: 'x',
        reason: 'SIN_SKU',
      },
    })
    const revision = await prisma.shopifyReviewItem.create({
      data: {
        venueId: e.venueId,
        productId: e.productId,
        reason: 'DIFERENCIA',
        avoqadoQty: 9,
        shopifyQty: 10,
        offset: 1,
        suggestion: 'SHOPIFY',
      },
    })
    const i = { venueId: e.venueId, authUserId: e.staffId, intent: await intentAutorizado(e, e.shopDomain), locationId: UBICACION_PRUEBA }
    await confirmShopifyConnect(i, { graphql: confirmacion({ name: 'Tienda México' }) })
    expect(await sucursal(e)).toMatchObject({
      status: 'CONNECTING',
      generation: 2,
      importCursor: null,
      webhooksAt: null,
      requeuePending: false,
    })
    // K18 / B-6: la revisión de la conexión anterior se cierra con su rastro (offset 0), no se borra.
    expect(await prisma.shopifyReviewItem.findUniqueOrThrow({ where: { id: revision.id } })).toMatchObject({ status: 'RESOLVED' })
    expect((await prisma.shopifyReviewItem.findUniqueOrThrow({ where: { id: revision.id } })).offset.toString()).toBe('0')
    for (const action of ['SHOPIFY_CREDENTIAL_RENEWED', 'SHOPIFY_CONNECTED']) {
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action, venueId: e.venueId, organizationId: e.organizationId, staffId: e.staffId }),
      )
    }
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).toMatchObject({
      initializedAt: null,
      suspendedReason: null,
      createdProduct: false,
    })
    expect(await prisma.shopifyImportIssue.count({ where: { venueId: e.venueId } })).toBe(0)
    const tienda = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
    expect(tienda.tokenVersion).toBe(2)
    expect(tienda.authorizedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  it('§9.1: reconectar con un envío de la conexión anterior en camino ⇒ 409 SHOPIFY_ENVIO_EN_CAMINO y nada cambia; ya resuelto, conecta', async () => {
    const e = await escenario({ linkStatus: 'DISCONNECTED' })
    const fila = await enVuelo(e)
    const i = { venueId: e.venueId, authUserId: e.staffId, intent: await intentAutorizado(e, e.shopDomain), locationId: UBICACION_PRUEBA }
    const graphql = confirmacion({ name: 'Tienda México' })
    await expect(confirmShopifyConnect(i, { graphql })).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_ENVIO_EN_CAMINO' })
    expect(await sucursal(e)).toMatchObject({ status: 'DISCONNECTED', generation: 1 })
    expect((await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: fila.id } })).status).toBe('IN_PROGRESS')
    await prisma.shopifyStockOutbox.update({
      where: { id: fila.id },
      data: { status: 'SENT', processedAt: new Date(), claimToken: null, leaseUntil: null },
    })
    await confirmShopifyConnect(i, { graphql })
    expect(await sucursal(e)).toMatchObject({ status: 'CONNECTING', generation: 2 })
  })

  it('otra ubicación: borra las parejas viejas; una sucursal AJENA desconectada que ocupaba esa ubicación se borra', async () => {
    const e = await escenario({ linkStatus: 'DISCONNECTED' })
    const ajena = await prisma.venue.create({
      data: {
        organizationId: e.organizationId,
        name: `ajena-${e.venueId}`,
        slug: `ajena-${e.venueId}`,
        timezone: 'America/Mexico_City',
        currency: 'MXN',
      },
    })
    const vieja = await prisma.shopifyLocationLink.create({
      data: {
        storeId: e.storeId,
        venueId: ajena.id,
        shopifyLocationId: 'gid://shopify/Location/9',
        locationName: 'Vieja',
        status: 'DISCONNECTED',
      },
    })
    // Fix round 1 (Minor 3): lo que la ajena nunca mandó se descarta antes de borrarla, no se queda vivo para siempre.
    const nuncaSalio = await prisma.shopifyStockOutbox.create({
      data: { venueId: ajena.id, locationLinkId: vieja.id, generation: 1, productId: e.productId, delta: -1 },
    })
    try {
      const i = {
        venueId: e.venueId,
        authUserId: e.staffId,
        intent: await intentAutorizado(e, e.shopDomain),
        locationId: 'gid://shopify/Location/9',
      }
      await confirmShopifyConnect(i, { graphql: confirmacion() })
      expect(await sucursal(e)).toMatchObject({ shopifyLocationId: 'gid://shopify/Location/9', status: 'CONNECTING' })
      expect(await prisma.shopifyVariantLink.count({ where: { venueId: e.venueId } })).toBe(0)
      expect(await prisma.shopifyLocationLink.count({ where: { venueId: ajena.id } })).toBe(0)
      expect(await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: nuncaSalio.id } })).toMatchObject({
        status: 'DISCARDED',
        lastError: 'GENERACION_VIEJA',
      })
    } finally {
      // Aunque la prueba falle: la sucursal ajena no es de ningún escenario y bloquearía la limpieza de los siguientes.
      await prisma.shopifyStockOutbox.deleteMany({ where: { venueId: ajena.id } })
      await prisma.shopifyLocationLink.deleteMany({ where: { venueId: ajena.id } })
      await prisma.venue.delete({ where: { id: ajena.id } })
    }
  })

  it('R02 (§11.4): conectar OTRA sucursal de la misma tienda renueva la credencial de TODAS: la que tenía FALTA_PERMISO vuelve a trabajar', async () => {
    const x = await escenario()
    await prisma.shopifyLocationLink.update({
      where: { id: x.locationLinkId },
      data: { webhooksAt: new Date(), importError: 'FALTA_PERMISO' },
    })
    const y = await otraSucursalDeLaTienda(x, { sinEnlace: true })
    otras.push(y)
    // Un envío en camino de X no detiene la conexión de Y: la barrera sólo mira la propia y la que ocupaba la ubicación.
    await enVuelo(x)
    const intent = await intentAutorizado(y, x.shopDomain)
    await confirmShopifyConnect(
      { venueId: y.venueId, authUserId: y.staffId, intent, locationId: 'gid://shopify/Location/2' },
      { graphql: confirmacion({ name: 'Tienda 2' }) },
    )
    expect(await prisma.shopifyStore.findUniqueOrThrow({ where: { id: x.storeId } })).toMatchObject({ status: 'ACTIVE', tokenVersion: 2 })
    expect(await sucursal(x)).toMatchObject({
      status: 'ACTIVE',
      generation: 1,
      importError: null,
      webhooksAt: null,
      requeuePending: true,
      reconcileVersion: 1,
    })
    expect(await sucursal(y)).toMatchObject({ status: 'CONNECTING', storeId: x.storeId, locationName: 'Tienda 2' })
  })

  it('N03: la sucursal AJENA que ocupaba la ubicación tiene un envío en camino ⇒ 409 SHOPIFY_ENVIO_EN_CAMINO y no se borra', async () => {
    const e = await escenario({ linkStatus: 'DISCONNECTED' })
    const ajena = await prisma.venue.create({
      data: {
        organizationId: e.organizationId,
        name: `ajena-${e.venueId}`,
        slug: `ajena-${e.venueId}`,
        timezone: 'America/Mexico_City',
        currency: 'MXN',
      },
    })
    const vieja = await prisma.shopifyLocationLink.create({
      data: {
        storeId: e.storeId,
        venueId: ajena.id,
        shopifyLocationId: 'gid://shopify/Location/9',
        locationName: 'Vieja',
        status: 'DISCONNECTED',
        generation: 3,
      },
    })
    const fila = await prisma.shopifyStockOutbox.create({
      data: {
        venueId: ajena.id,
        locationLinkId: vieja.id,
        generation: 2,
        productId: e.productId,
        delta: -1,
        status: 'FAILED',
        ambiguous: true,
        attempts: 1,
      },
    })
    const i = {
      venueId: e.venueId,
      authUserId: e.staffId,
      intent: await intentAutorizado(e, e.shopDomain),
      locationId: 'gid://shopify/Location/9',
    }
    await expect(confirmShopifyConnect(i, { graphql: confirmacion() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_ENVIO_EN_CAMINO',
    })
    expect(await prisma.shopifyLocationLink.count({ where: { id: vieja.id } })).toBe(1)
    expect(await sucursal(e)).toMatchObject({ status: 'DISCONNECTED', shopifyLocationId: UBICACION_PRUEBA })
    await prisma.shopifyStockOutbox.delete({ where: { id: fila.id } })
    await prisma.shopifyLocationLink.delete({ where: { id: vieja.id } })
    await prisma.venue.delete({ where: { id: ajena.id } })
  })
})

describe('webhooks, vista previa y aplicar (#6, 12 bis.3, N13, N20, N25)', () => {
  const URI = 'https://api.test/api/v1/webhooks/shopify/piloto'
  it('webhooks de uno en uno: lista los de su app, crea el primero que falta y, cuando están los 9, marca webhooksAt', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    const existentes = SHOPIFY_WEBHOOK_TOPICS.slice(0, 8).map((t, i) => ({
      id: `gid://shopify/WebhookSubscription/${i}`,
      topic: t,
      uri: URI,
    }))
    const creados: Array<{ id: string; topic: string; uri: string }> = []
    const graphql = graphqlFalso((q, vars) => {
      if (!q.includes('webhookSubscriptionCreate'))
        return { ok: true, data: { webhookSubscriptions: { nodes: [...existentes, ...creados] } } }
      const s = { id: 'gid://shopify/WebhookSubscription/99', topic: vars.topic, uri: vars.uri }
      creados.push(s)
      return { ok: true, data: { webhookSubscriptionCreate: { webhookSubscription: s, userErrors: [] } } }
    })
    expect(await registerShopifyWebhooks(e.locationLinkId, { graphql })).toEqual({ done: false })
    expect(graphql.mock.calls[0][3]).toEqual({ uri: URI })
    expect(graphql.mock.calls[1][3]).toEqual({ topic: 'APP_UNINSTALLED', uri: URI })
    expect((await sucursal(e)).webhooksAt).toBeNull()
    expect(await registerShopifyWebhooks(e.locationLinkId, { graphql })).toEqual({ done: true })
    expect((await sucursal(e)).webhooksAt).toBeInstanceOf(Date)
  })

  it('N25 (§11.6): sin tiempo para crear después de listar, no crea, no marca webhooksAt y no gasta nada', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    const lista = graphqlFalso(() => ({ ok: true, data: { webhookSubscriptions: { nodes: [] } } }))
    const graphql = jest.fn(async (...a: unknown[]) => {
      await dormir(150)
      return lista(...a)
    })
    expect(await registerShopifyWebhooks(e.locationLinkId, { graphql: graphql as never, vence: Date.now() + MIN_HTTP_MS + 100 })).toEqual({
      error: 'SIN_TIEMPO',
      retry: true,
    })
    expect(graphql).toHaveBeenCalledTimes(1) // sólo la lista; la creación ya no salió
    expect(graphql.mock.calls[0][4]).toMatchObject({ timeoutMs: expect.any(Number) })
    expect((await sucursal(e)).webhooksAt).toBeNull()
  })

  it('N05: una lista leída con la credencial vieja no marca webhooksAt si la tienda se reautorizó mientras viajaba', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    const todos = SHOPIFY_WEBHOOK_TOPICS.map((t, i) => ({ id: `gid://shopify/WebhookSubscription/${i}`, topic: t, uri: URI }))
    const graphql = graphqlConEfecto(
      () => prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: { increment: 1 } } }).then(() => undefined),
      () => ({ ok: true, data: { webhookSubscriptions: { nodes: todos } } }),
    )
    expect(await registerShopifyWebhooks(e.locationLinkId, { graphql })).toEqual({ error: 'CONTEXTO_CAMBIO', retry: false })
    expect((await sucursal(e)).webhooksAt).toBeNull()
  })

  it('una falla no marca webhooksAt; sin permiso ⇒ FALTA_PERMISO; N06: una suscripción creada para OTRO tema ⇒ BAD_RESPONSE', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    expect(await registerShopifyWebhooks(e.locationLinkId, { graphql: graphqlFalso(() => falla('HTTP_5XX', true, true)) })).toEqual({
      error: 'HTTP_5XX',
      retry: true,
    })
    expect(await registerShopifyWebhooks(e.locationLinkId, { graphql: graphqlFalso(() => falla('FORBIDDEN', false, false)) })).toEqual({
      error: 'FALTA_PERMISO',
      retry: false,
    })
    expect(await sucursal(e)).toMatchObject({ webhooksAt: null, importError: 'FALTA_PERMISO' })

    const e2 = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    const raro = graphqlFalso((q, vars) =>
      q.includes('webhookSubscriptionCreate')
        ? {
            ok: true,
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1', topic: 'SHOP_UPDATE', uri: vars.uri },
                userErrors: [],
              },
            },
          }
        : { ok: true, data: { webhookSubscriptions: { nodes: [] } } },
    )
    expect(await registerShopifyWebhooks(e2.locationLinkId, { graphql: raro })).toEqual({ error: 'BAD_RESPONSE', retry: true })
    expect((await sucursal(e2)).webhooksAt).toBeNull()
  })

  it('N13: vista previa paginada con lo que QUEDARÁ (Shopify + lo pendiente): resumen, CAMBIAN, NUEVOS y TODOS', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    // Avoqado 10, Shopify 10, pero una venta en caja durante la importación: quedará 9 ⇒ CAMBIA aunque S = A.
    await prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { importedAvailable: 10 } })
    await prisma.shopifyStockOutbox.create({
      data: { venueId: e.venueId, locationLinkId: e.locationLinkId, generation: 1, productId: e.productId, delta: -1 },
    })
    const nuevo = await agregarProductoShopify(e, { stock: 0, initialized: false, createdProduct: true })
    await prisma.shopifyVariantLink.update({ where: { id: nuevo.variantLinkId! }, data: { importedAvailable: 4 } })
    const igual = await agregarProductoShopify(e, { stock: 5, initialized: false })
    await prisma.shopifyVariantLink.update({ where: { id: igual.variantLinkId! }, data: { importedAvailable: 5 } })
    await prisma.shopifyImportIssue.create({
      data: {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/99',
        shopifyProductId: 'gid://shopify/Product/99',
        title: 'Sin SKU',
        reason: 'SIN_SKU',
      },
    })
    const cambian = await getConnectReview({ venueId: e.venueId, offset: 0, limit: 20, filtro: 'CAMBIAN' })
    expect(cambian.resumen).toEqual({ emparejados: 3, cambian: 1, nuevos: 1, sinPareja: 1 })
    expect(cambian).toMatchObject({ total: 1, nextOffset: null })
    expect(cambian.items[0]).toEqual({
      variantLinkId: e.variantLinkId,
      productId: e.productId,
      name: 'Camisa · M',
      sku: expect.any(String),
      avoqadoQty: '10',
      shopifyQty: 10,
      nuevo: false,
      quedara: '9',
    })
    expect((await getConnectReview({ venueId: e.venueId, offset: 0, limit: 20, filtro: 'NUEVOS' })).items.map(i => i.productId)).toEqual([
      nuevo.productId,
    ])
    const todos = await getConnectReview({ venueId: e.venueId, offset: 0, limit: 2, filtro: 'TODOS' })
    expect(todos).toMatchObject({ total: 3, nextOffset: 2 })
    expect(todos.items).toHaveLength(2)
    expect((await getConnectReview({ venueId: e.venueId, offset: 0, limit: 1000, filtro: 'TODOS' })).items).toHaveLength(3)
  })

  it('aplicar sólo se pide en REVIEWING con plan; pedirlo dos veces no cambia la fecha', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    await expect(
      requestApplyShopifyConnect({ venueId: e.venueId, staffId: e.staffId }, { hasAccess: async () => false }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'SHOPIFY_SIN_PLAN',
      message: 'El conector con Shopify no está activo en este local (piloto por invitación).', // M2: sin «plan» ni «actívalo»
    })
    await expect(requestApplyShopifyConnect({ venueId: e.venueId, staffId: e.staffId }, { hasAccess: conPlan })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_NO_EN_REVISION',
    })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'REVIEWING' } })
    const a = await requestApplyShopifyConnect({ venueId: e.venueId, staffId: e.staffId }, { hasAccess: conPlan })
    const b = await requestApplyShopifyConnect({ venueId: e.venueId, staffId: e.staffId }, { hasAccess: conPlan })
    expect(b.applyRequestedAt.getTime()).toBe(a.applyRequestedAt.getTime())
    expect((await sucursal(e)).applyRequestedById).toBe(e.staffId)
    const otro = await escenario()
    await sinConexion(otro)
    await expect(
      requestApplyShopifyConnect({ venueId: otro.venueId, staffId: otro.staffId }, { hasAccess: conPlan }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_SIN_CONEXION',
    })
  })

  it('🔴 P2-4: aplicar o desconectar con la generación que se VIO: si la conexión ya es otra, 409 y no se escribe nada', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    const vista = { linkId: e.locationLinkId, generation: 1 }
    // Mientras tanto, alguien desconectó y volvió a conectar la MISMA tienda y ubicación: la conexión nueva es la generación 2.
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { generation: 2 } })
    await expect(
      requestApplyShopifyConnect({ venueId: e.venueId, staffId: e.staffId, expected: vista }, { hasAccess: conPlan }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_CONEXION_CAMBIO' })
    expect(await sucursal(e)).toMatchObject({ status: 'REVIEWING', applyRequestedAt: null })
    await expect(disconnectShopify({ venueId: e.venueId, staffId: e.staffId, expected: vista })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_CONEXION_CAMBIO',
    })
    expect(await sucursal(e)).toMatchObject({ status: 'REVIEWING', generation: 2 })
    // Otro enlace (misma generación) tampoco sirve.
    await expect(
      requestApplyShopifyConnect(
        { venueId: e.venueId, staffId: e.staffId, expected: { linkId: 'otro', generation: 2 } },
        { hasAccess: conPlan },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_CONEXION_CAMBIO' })
    // Con la vigente sí, y la del dashboard (sin esperada) sigue igual.
    const vigente = { linkId: e.locationLinkId, generation: 2 }
    const a = await requestApplyShopifyConnect({ venueId: e.venueId, staffId: e.staffId, expected: vigente }, { hasAccess: conPlan })
    expect(a.applyRequestedAt).toBeInstanceOf(Date)
    expect(await disconnectShopify({ venueId: e.venueId, staffId: e.staffId, expected: vigente })).toEqual({ desconectada: true })
    expect(await sucursal(e)).toMatchObject({ status: 'DISCONNECTED', generation: 3 })
  })

  it('RF1: un producto SIN pareja vende 1 mientras se importa; la importación lo liga; al aplicar Avoqado = S − 1 y la fila sale con el espejo cuadrado', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    const p = await agregarProductoShopify(e, { sku: 'RF1-SKU', stock: 10, pareja: false })
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${p.inventoryId}` // venta en caja
    expect((await prisma.shopifyStockOutbox.findMany({ where: { productId: p.productId }, take: 5 })).map(f => f.delta.toString())).toEqual(
      ['-1'],
    )

    const pagina = graphqlFalso(() => paginaDeVariantes([variante(1, { sku: 'RF1-SKU', barcode: null, available: 7 })], null))
    // B1 (fix round 1, Minor 5): sin `hasAccess` la importación mira el plan real, y el escenario de A no lo trae.
    expect(await importCatalogPage(e.locationLinkId, { graphql: pagina, hasAccess: conPlan })).toEqual({ done: true, procesadas: 1 })
    expect((await sucursal(e)).status).toBe('REVIEWING')
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { productId: p.productId } })).toMatchObject({
      importedAvailable: 7,
      initializedAt: null,
    })

    await requestApplyShopifyConnect({ venueId: e.venueId, staffId: e.staffId }, { hasAccess: conPlan })
    const fetchLevels = nivelesFalsos(item => (item === variante(1).inventoryItem.id ? nivel(7) : nivel(10)))
    for (let i = 0; i < 5 && (await sucursal(e)).status !== 'ACTIVE'; i++)
      await applyConnectPage(e.locationLinkId, { fetchLevels, hasAccess: conPlan })
    expect(await sucursal(e)).toMatchObject({ status: 'ACTIVE', requeuePending: true, needsReconcile: true })
    expect((await prisma.inventory.findUniqueOrThrow({ where: { id: p.inventoryId } })).currentStock.toString()).toBe('6') // S + pendientes

    const c = await claimShopifyOutbox(new Date())
    if (c.kind !== 'FILA') throw new Error(`se esperaba FILA y llegó ${c.kind}`)
    expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: exito(), hasAccess: conPlan })).toBe('SENT')
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { productId: p.productId } })).mirrorAvailable).toBe(6) // = Avoqado
    expect(await huecoDelInvariante(p.productId)).toBe('0')
  })

  it('al terminar: lo de productos sin pareja se descarta SIN_PAREJA; ACTIVE con requeuePending en la misma tx; sin nivel ⇒ suspendida, nunca cero', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    const suelto = await agregarProductoShopify(e, { pareja: false, stock: 3 })
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${suelto.inventoryId}`
    const sinNivel = await agregarProductoShopify(e, { stock: 4, initialized: false })
    const fetchLevels = nivelesFalsos(item => (item === 'gid://shopify/InventoryItem/1' ? nivel(8) : { kind: 'SIN_NIVEL' }))
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels, hasAccess: conPlan })).toEqual({ done: false, procesadas: 2 })
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels, hasAccess: conPlan })).toEqual({ done: true, procesadas: 0 })
    expect(await sucursal(e)).toMatchObject({ status: 'ACTIVE', requeuePending: true })
    expect(await prisma.shopifyStockOutbox.findFirstOrThrow({ where: { productId: suelto.productId } })).toMatchObject({
      status: 'DISCARDED',
      lastError: 'SIN_PAREJA',
    })
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: sinNivel.variantLinkId! } })).suspendedReason).toBe(
      'NIVEL_INEXISTENTE',
    )
    expect((await prisma.inventory.findUniqueOrThrow({ where: { id: sinNivel.inventoryId } })).currentStock.toString()).toBe('4')
  })

  it('N19 (§11.2): el lease vence mientras se leen los niveles ⇒ al volver no se inicia nada ni se pasa a ACTIVE', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date(), workToken: 'w1' } })
    const fetchLevels = jest.fn(async (_s: unknown, items: Array<{ inventoryItemId: string; shopifyLocationId: string }>) => {
      // El servicio sigue esperando a Shopify y otro worker ya tomó la sucursal.
      await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { workToken: 'w2' } })
      return nivelesFalsos(() => nivel(7))(_s as never, items)
    })
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels: fetchLevels as never, hasAccess: conPlan, workToken: 'w1' })).toEqual({
      done: false,
      procesadas: 0,
      error: 'CONTEXTO_CAMBIO',
    })
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).initializedAt).toBeNull()
    expect((await prisma.inventory.findUniqueOrThrow({ where: { id: e.inventoryId } })).currentStock.toString()).toBe('10')
    expect((await sucursal(e)).status).toBe('REVIEWING')
  })

  it('N19 · R09: terminar la aplicación revalida bajo candado: sin plan no pasa a ACTIVE; con la tienda revocada DESPUÉS de la primera lectura, tampoco', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING' }) // la única pareja ya está iniciada: la tanda viene vacía
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    expect(await applyConnectPage(e.locationLinkId, { hasAccess: async () => false })).toEqual({ done: false, procesadas: 0 })
    expect((await sucursal(e)).status).toBe('REVIEWING')
    // applyConnectPage ya leyó la sucursal con la tienda ACTIVE; la tienda se revoca mientras se pregunta por el plan,
    // dentro de la tx de terminarAplicacion y antes del cerco.
    const revocaYContesta = jest.fn(async () => {
      await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED', revokedAt: new Date() } })
      return true
    })
    expect(await applyConnectPage(e.locationLinkId, { hasAccess: revocaYContesta })).toEqual({ done: false, procesadas: 0 })
    expect(revocaYContesta).toHaveBeenCalledTimes(1)
    expect((await sucursal(e)).status).toBe('REVIEWING')
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'ACTIVE', revokedAt: null } })
    expect(await applyConnectPage(e.locationLinkId, { hasAccess: conPlan })).toEqual({ done: true, procesadas: 0 })
    expect((await sucursal(e)).status).toBe('ACTIVE')
  })

  it('N20: falta un permiso al leer los niveles ⇒ FALTA_PERMISO en la sucursal y la tanda no avanza', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    const sinPermiso = jest.fn(async () => falla('FORBIDDEN', false, false))
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels: sinPermiso as never, hasAccess: conPlan })).toEqual({
      done: false,
      procesadas: 0,
      error: 'FALTA_PERMISO',
    })
    expect((await sucursal(e)).importError).toBe('FALTA_PERMISO')
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).initializedAt).toBeNull()
  })
})

describe('pausa y desconexión (#8, #15, N10)', () => {
  it('pausar conserva la fase y pide cuadre; reanudar a ACTIVE deja requeuePending en la MISMA escritura; a CONNECTING, no', async () => {
    const sinPlan = { hasAccess: async () => false }
    const e = await escenario()
    const g = (await sucursal(e)).generation
    expect(await pauseShopifyLink(e.locationLinkId, 'ACTIVE', { generation: g }, sinPlan)).toBe(true)
    expect(await sucursal(e)).toMatchObject({ status: 'PAUSED', pausedFrom: 'ACTIVE', needsReconcile: true })
    expect(await resumeShopifyLink(e.locationLinkId, { generation: g }, { hasAccess: conPlan })).toBe('ACTIVE')
    expect(await sucursal(e)).toMatchObject({ status: 'ACTIVE', pausedFrom: null, requeuePending: true })
    for (const action of ['SHOPIFY_PAUSED', 'SHOPIFY_RESUMED']) {
      expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action, venueId: e.venueId, organizationId: e.organizationId }))
    }

    const c = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    const gc = (await sucursal(c)).generation
    await pauseShopifyLink(c.locationLinkId, 'CONNECTING', { generation: gc }, sinPlan)
    expect(await resumeShopifyLink(c.locationLinkId, { generation: gc }, { hasAccess: conPlan })).toBe('CONNECTING')
    expect((await sucursal(c)).requeuePending).toBe(false)
  })

  it('N19 (§12.7): pausar y reanudar llevan dueño: con otro lease u otra generación no hacen nada; el plan se vuelve a mirar bajo candado', async () => {
    const sinPlan = { hasAccess: async () => false }
    const e = await escenario()
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { workToken: 'w2' } })
    const g = (await sucursal(e)).generation
    expect(await pauseShopifyLink(e.locationLinkId, 'ACTIVE', { generation: g, workToken: 'w1' }, sinPlan)).toBe(false) // el lease es de otro
    expect(await pauseShopifyLink(e.locationLinkId, 'ACTIVE', { generation: g + 1, workToken: 'w2' }, sinPlan)).toBe(false) // otra conexión
    expect(await pauseShopifyLink(e.locationLinkId, 'ACTIVE', { generation: g, workToken: 'w2' }, { hasAccess: conPlan })).toBe(false) // el plan volvió
    expect((await sucursal(e)).status).toBe('ACTIVE')
    expect(await pauseShopifyLink(e.locationLinkId, 'ACTIVE', { generation: g, workToken: 'w2' }, sinPlan)).toBe(true)
    expect(await resumeShopifyLink(e.locationLinkId, { generation: g, workToken: 'w1' }, { hasAccess: conPlan })).toBeNull()
    expect(await resumeShopifyLink(e.locationLinkId, { generation: g, workToken: 'w2' }, sinPlan)).toBeNull()
    expect((await sucursal(e)).status).toBe('PAUSED')
    expect(await resumeShopifyLink(e.locationLinkId, { generation: g, workToken: 'w2' }, { hasAccess: conPlan })).toBe('ACTIVE')
  })

  it('desconectar: lo que nunca salió se descarta; lo que va en camino se queda y, al resolverse, no mueve el espejo (§9.1); generación + 1 y revisiones cerradas (K18)', async () => {
    const e = await escenario()
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}`
    const revision = await prisma.shopifyReviewItem.create({
      data: {
        venueId: e.venueId,
        productId: e.productId,
        reason: 'DIFERENCIA',
        avoqadoQty: 9,
        shopifyQty: 10,
        offset: 1,
        suggestion: 'SHOPIFY',
      },
    })
    const c = await claimShopifyOutbox(new Date())
    if (c.kind !== 'FILA') throw new Error(`se esperaba FILA y llegó ${c.kind}`)
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}` // otra venta: PENDING
    expect(await disconnectShopify({ venueId: e.venueId, staffId: e.staffId })).toEqual({ desconectada: true })
    expect(await sucursal(e)).toMatchObject({ status: 'DISCONNECTED', generation: 2, requeuePending: false })
    expect(await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: 'IN_PROGRESS',
      claimToken: c.claimToken,
    })
    expect(
      await prisma.shopifyStockOutbox.findMany({
        where: { productId: e.productId, id: { not: c.id } },
        select: { status: true, lastError: true },
        take: 5,
      }),
    ).toEqual([{ status: 'DISCARDED', lastError: 'DESCONECTADO' }])
    expect(await prisma.shopifyReviewItem.count({ where: { venueId: e.venueId, status: 'OPEN' } })).toBe(0)
    // K18 / B-6: la revisión se CIERRA (con su rastro), no se borra.
    const cerrada = await prisma.shopifyReviewItem.findUniqueOrThrow({ where: { id: revision.id } })
    expect(cerrada).toMatchObject({ status: 'RESOLVED' })
    expect(cerrada.offset.toString()).toBe('0')
    expect(cerrada.resolvedAt).toBeInstanceOf(Date)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SHOPIFY_DISCONNECTED', venueId: e.venueId, organizationId: e.organizationId, staffId: e.staffId }),
    )
    // La fila reclamada nunca salió (sin parámetros congelados ni duda): el mensajero la descarta por ser de la generación
    // vieja (A7-5) y el espejo no se mueve. Una que sí salió se cierra con su llave: la prueba §11.7 de abajo.
    expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: exito(), hasAccess: conPlan })).toBe('DISCARDED')
    expect(await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: 'DISCARDED',
      lastError: 'GENERACION_VIEJA',
    })
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).mirrorAvailable).toBe(10)
    expect(await disconnectShopify({ venueId: e.venueId, staffId: e.staffId })).toEqual({ desconectada: false })
  })

  it('§11.7: desconectar mientras el mensajero espera a Shopify ⇒ el envío cierra con su llave y no mueve el espejo; a la vez, nadie se traba', async () => {
    const e = await escenario()
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}`
    const c = await claimShopifyOutbox(new Date())
    if (c.kind !== 'FILA') throw new Error(`se esperaba FILA y llegó ${c.kind}`)
    const graphql = graphqlConEfecto(
      () => disconnectShopify({ venueId: e.venueId, staffId: e.staffId }).then(() => undefined),
      () => ({ ok: true, data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: 'g1' }, userErrors: [] } } }),
    )
    expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql, hasAccess: conPlan })).toBe('SENT')
    expect(await sucursal(e)).toMatchObject({ status: 'DISCONNECTED', generation: 2 })
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).mirrorAvailable).toBe(10)

    for (let ronda = 0; ronda < 5; ronda++) {
      const r = await escenario()
      await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${r.inventoryId}`
      const fila = await claimShopifyOutbox(new Date())
      if (fila.kind !== 'FILA') throw new Error(`se esperaba FILA y llegó ${fila.kind}`)
      const ambos = await Promise.allSettled([
        runShopifyOutboxRow(fila.id, fila.claimToken, new Date(), { graphql: exito(), hasAccess: conPlan }),
        disconnectShopify({ venueId: r.venueId, staffId: r.staffId }),
      ])
      expect(ambos.map(x => x.status)).toEqual(['fulfilled', 'fulfilled'])
      const espejo = (await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: r.variantLinkId } })).mirrorAvailable
      const estado = (await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: fila.id } })).status
      // Salió antes de desconectar: SENT, y confirmó antes de subir la generación (9) o después (10). Desconectar ganó antes
      // de que saliera: nunca salió, el mensajero la descarta (A7-5) y el espejo se queda en 10. Nunca un espejo a medias.
      if (estado === 'SENT') expect([9, 10]).toContain(espejo)
      else expect([estado, espejo]).toEqual(['DISCARDED', 10])
    }
  })
})

// ─── Decisiones vinculantes de B3 (preflight-B K8–K18, ledger BR-1..BR-4, B-6, R3..R8, S2..S6) ─────────────────────────

const URI_WEBHOOKS = 'https://api.test/api/v1/webhooks/shopify/piloto'
async function callbackDe(e: EscenarioShopify, purpose: 'CONNECT' | 'REAUTHORIZE', dominio: string) {
  const { url } = await startShopifyConnect({ venueId: e.venueId, authUserId: e.staffId, shopDomain: dominio, purpose })
  return firmarConsulta({ code: 'c1', shop: dominio, state: new URL(url).searchParams.get('state')!, timestamp: '1700000000' })
}
const DEAD_FRESCA = { inventario: 'gid://shopify/InventoryItem/1', ubicacion: UBICACION_PRUEBA }
const dead = (
  e: EscenarioShopify,
  o: { generation: number; lastError?: string; ambiguous?: boolean; attempts?: number; firstAttemptAt?: Date },
) =>
  prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: o.generation,
      productId: e.productId,
      delta: -1,
      status: 'DEAD_LETTER',
      ambiguous: o.ambiguous ?? false,
      attempts: o.attempts ?? 1,
      lastError: o.lastError ?? 'FALTA_PERMISO: Shopify contestó 403',
      firstAttemptAt: o.firstAttemptAt ?? new Date(Date.now() - 3_600_000),
      processedAt: new Date(Date.now() - 1_800_000),
      scheduledAt: new Date(Date.now() - 3_600_000),
      sentInventoryItemId: o.ambiguous ? DEAD_FRESCA.inventario : null,
      sentLocationId: o.ambiguous ? DEAD_FRESCA.ubicacion : null,
    },
  })
const ambiguaEnCamino = (e: EscenarioShopify, generation: number) =>
  prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation,
      productId: e.productId,
      delta: -1,
      status: 'FAILED',
      ambiguous: true,
      attempts: 1,
      sentInventoryItemId: DEAD_FRESCA.inventario,
      sentLocationId: DEAD_FRESCA.ubicacion,
      firstAttemptAt: new Date(),
      scheduledAt: new Date(Date.now() - 60_000),
    },
  })

describe('decisiones vinculantes de B3', () => {
  it('K8: los permisos que se piden incluyen read_fulfillments (FULFILLMENTS_CREATE lo exige)', () => {
    expect(SHOPIFY_SCOPES.split(',')).toContain('read_fulfillments')
    expect(SHOPIFY_WEBHOOK_TOPICS).toContain('FULFILLMENTS_CREATE')
  })

  it('K8: un webhook rechazado (que no sea «ya existe») ⇒ FALTA_PERMISO terminal y a la vista; después ya no sale nada a Shopify', async () => {
    const e = await escenario({ linkStatus: 'CONNECTING', initialized: false })
    const respuesta = (message: string) =>
      graphqlFalso(q =>
        q.includes('webhookSubscriptionCreate')
          ? { ok: true, data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ['topic'], message }] } } }
          : { ok: true, data: { webhookSubscriptions: { nodes: [] } } },
      )
    expect(
      await registerShopifyWebhooks(e.locationLinkId, { graphql: respuesta('Address for this topic has already been taken') }),
    ).toEqual({
      done: false,
    })
    expect((await sucursal(e)).importError).toBeNull()

    const rechazo = respuesta('You do not have permission to create webhooks with orders/create topic')
    expect(await registerShopifyWebhooks(e.locationLinkId, { graphql: rechazo })).toEqual({ error: 'FALTA_PERMISO', retry: false })
    expect(rechazo.mock.calls[1][3]).toEqual({ topic: 'INVENTORY_LEVELS_UPDATE', uri: URI_WEBHOOKS })
    expect(await sucursal(e)).toMatchObject({ importError: 'FALTA_PERMISO', webhooksAt: null })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'SHOPIFY_PERMISSION_MISSING', venueId: e.venueId }))

    const despues = respuesta('no debería salir')
    expect(await registerShopifyWebhooks(e.locationLinkId, { graphql: despues })).toEqual({ error: 'FALTA_PERMISO', retry: false })
    expect(despues).not.toHaveBeenCalled()
  })

  it('K9: tienda REVOCADA + envío ambiguo + desconectar ⇒ confirmar renueva la credencial ANTES del 409, el mensajero resuelve con el token nuevo y después conecta', async () => {
    const e = await escenario()
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { accessTokenCiphertext: encryptShopifyToken('shpat_viejo') } })
    const fila = await ambiguaEnCamino(e, 1)
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED', revokedAt: new Date() } })
    expect(await disconnectShopify({ venueId: e.venueId, staffId: e.staffId })).toEqual({ desconectada: true })
    // El atolladero (D3): reautorizar ya no se ofrece (desconectada) y, con la tienda revocada, nadie resuelve la fila.
    await expect(
      startShopifyConnect({ venueId: e.venueId, authUserId: e.staffId, shopDomain: e.shopDomain, purpose: 'REAUTHORIZE' }),
    ).rejects.toMatchObject({ code: 'SHOPIFY_REAUTORIZAR_SIN_TIENDA' })
    expect(await claimShopifyOutbox(new Date())).toEqual({ kind: 'VACIO' })

    const i = { venueId: e.venueId, authUserId: e.staffId, intent: await intentAutorizado(e, e.shopDomain), locationId: UBICACION_PRUEBA }
    const graphql = confirmacion({ name: 'Tienda México' })
    await expect(confirmShopifyConnect(i, { graphql })).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_ENVIO_EN_CAMINO' })
    // La credencial nueva YA quedó (su propia tx); la conexión no cambió y el intent sirve para reintentar.
    expect(await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).toMatchObject({
      status: 'ACTIVE',
      revokedAt: null,
      tokenVersion: 2,
    })
    expect(await sucursal(e)).toMatchObject({ status: 'DISCONNECTED', generation: 2 })
    expect((await prisma.shopifyConnectIntent.findFirstOrThrow({ where: { venueId: e.venueId } })).status).toBe('EXCHANGED')

    const c = await claimShopifyOutbox(new Date())
    expect(c).toMatchObject({ kind: 'FILA', id: fila.id })
    if (c.kind !== 'FILA') throw new Error('sin fila')
    const envio = exito()
    expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: envio, hasAccess: conPlan })).toBe('SENT')
    expect(envio.mock.calls[0][1]).toBe(TOKEN_DE_PRUEBA) // el token del intent, no el viejo
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).mirrorAvailable).toBe(10) // generación vieja

    await confirmShopifyConnect(i, { graphql })
    expect(await sucursal(e)).toMatchObject({ status: 'CONNECTING', generation: 3 })
  })

  it('K10 / BR-8: reautorizar limpia FALTA_PERMISO en TODAS las sucursales y reabre lo que murió por permiso en la generación vigente', async () => {
    const e = await escenario({ generation: 2, stock: 7, mirrorAvailable: 10 })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: 'FALTA_PERMISO' } })
    const hermana = await otraSucursalDeLaTienda(e, { linkStatus: 'DISCONNECTED' })
    otras.push(hermana)
    await prisma.shopifyLocationLink.update({ where: { id: hermana.locationLinkId }, data: { importError: 'FALTA_PERMISO' } })
    const t0 = new Date(Date.now() - 7_200_000)
    const t1 = new Date(Date.now() - 5_400_000)
    const a = await dead(e, { generation: 2, firstAttemptAt: t0 })
    const b = await dead(e, { generation: 2, ambiguous: true, attempts: 2, firstAttemptAt: t1 })
    const vieja = await dead(e, { generation: 1 })
    const otra = await dead(e, { generation: 2, lastError: 'VENTANA_24H' })
    expect(await huecoDelInvariante(e.productId)).toBe('0') // 7 = 10 − 3 (las tres DEAD_LETTER de la generación 2)

    const q = await callbackDe(e, 'REAUTHORIZE', e.shopDomain)
    expect(await handleShopifyCallback(q, { exchange: exitoCanje() })).toContain('?reautorizada=1')
    const fila = (id: string) => prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id } })
    const fa = await fila(a.id)
    expect(fa).toMatchObject({ status: 'PENDING', ambiguous: false, attempts: 1, firstAttemptAt: t0, processedAt: null })
    expect(fa.scheduledAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(await fila(b.id)).toMatchObject({
      status: 'FAILED',
      ambiguous: true,
      attempts: 2,
      firstAttemptAt: t1,
      processedAt: null,
      sentInventoryItemId: DEAD_FRESCA.inventario,
      sentLocationId: DEAD_FRESCA.ubicacion,
    })
    expect((await fila(vieja.id)).status).toBe('DEAD_LETTER') // generación vieja: nunca revive (BR-3, BR-4, K16)
    expect((await fila(otra.id)).status).toBe('DEAD_LETTER') // no murió por permiso
    expect(await huecoDelInvariante(e.productId)).toBe('0')
    expect(await sucursal(e)).toMatchObject({ importError: null, requeuePending: true })
    expect(await sucursal(hermana)).toMatchObject({ status: 'DISCONNECTED', importError: null, requeuePending: false })
  })

  it('R3 (B-4): una tanda de aplicar pregunta por el plan UNA sola vez, aunque inicie varias parejas', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    await agregarProductoShopify(e, { stock: 3, initialized: false })
    await agregarProductoShopify(e, { stock: 4, initialized: false })
    const hasAccess = jest.fn(async () => true)
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels: nivelesFalsos(() => nivel(5)), hasAccess })).toEqual({
      done: false,
      procesadas: 3,
    })
    expect(hasAccess).toHaveBeenCalledTimes(1)
  })

  it('§12.8: sin tiempo para escribir después de leer los niveles, la tanda se detiene sin iniciar nada', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    const lenta = jest.fn(async (s: unknown, items: Array<{ inventoryItemId: string; shopifyLocationId: string }>) => {
      await dormir(2_700) // la lectura se come el plazo: quedan menos de MIN_ESCRITURA_MS
      return nivelesFalsos(() => nivel(7))(s as never, items)
    })
    const vence = Date.now() + MIN_HTTP_MS + 1_500
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels: lenta as never, hasAccess: conPlan, vence })).toEqual({
      done: false,
      procesadas: 0,
      error: 'SIN_TIEMPO',
    })
    expect(lenta).toHaveBeenCalledTimes(1)
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).initializedAt).toBeNull()
    expect((await prisma.inventory.findUniqueOrThrow({ where: { id: e.inventoryId } })).currentStock.toString()).toBe('10')
  })

  it('BR-3: aplicar una generación nueva espera mientras una fila de la generación anterior todavía puede llegar', async () => {
    const e = await escenario({ linkStatus: 'REVIEWING', initialized: false, generation: 2 })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { applyRequestedAt: new Date() } })
    await ambiguaEnCamino(e, 1)
    const fetchLevels = nivelesFalsos(() => nivel(7))
    expect(await applyConnectPage(e.locationLinkId, { fetchLevels, hasAccess: conPlan })).toEqual({
      done: false,
      procesadas: 0,
      error: 'ENVIO_EN_CAMINO',
    })
    expect(fetchLevels).not.toHaveBeenCalled()
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).initializedAt).toBeNull()
    expect((await sucursal(e)).status).toBe('REVIEWING')
  })

  it.each([
    ['la tienda vieja REVOCADA', 'REVOCADA'],
    ['la sucursal con FALTA_PERMISO', 'FALTA_PERMISO'],
  ])(
    'BR-4: con %s y envíos atorados, ligar la sucursal a OTRA tienda conecta (generación + 1) y lo atorado queda DEAD_LETTER como evidencia',
    async (_c, causa) => {
      const e = await escenario()
      const congelada = { sentInventoryItemId: DEAD_FRESCA.inventario, sentLocationId: DEAD_FRESCA.ubicacion, firstAttemptAt: new Date() }
      const fila = (o: Partial<Prisma.ShopifyStockOutboxUncheckedCreateInput>) =>
        prisma.shopifyStockOutbox.create({
          data: { venueId: e.venueId, locationLinkId: e.locationLinkId, generation: 1, productId: e.productId, delta: -1, ...o },
        })
      const ambigua = await ambiguaEnCamino(e, 1)
      const abandonada = await fila({
        status: 'IN_PROGRESS',
        attempts: 1,
        claimToken: 'viejo',
        leaseUntil: new Date(Date.now() - 60_000),
        ...congelada,
      })
      const enHttp = await fila({
        status: 'IN_PROGRESS',
        attempts: 0,
        claimToken: 'mensajero',
        leaseUntil: new Date(Date.now() + 60_000),
        ...congelada,
      })
      if (causa === 'REVOCADA')
        await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED', revokedAt: new Date() } })
      else await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: 'FALTA_PERMISO' } })
      expect(await disconnectShopify({ venueId: e.venueId, staffId: e.staffId })).toEqual({ desconectada: true })
      // Nadie puede resolverlas: el reclamo exige la tienda vieja ACTIVE y la sucursal sin error terminal.
      expect(await claimShopifyOutbox(new Date())).toEqual({ kind: 'VACIO' })

      const i = {
        venueId: e.venueId,
        authUserId: e.staffId,
        intent: await intentAutorizado(e, 'mi-tienda.myshopify.com'),
        locationId: 'gid://shopify/Location/9',
      }
      const { locationLinkId } = await confirmShopifyConnect(i, { graphql: confirmacion({ name: 'Tienda B' }) })
      const nueva = await prisma.shopifyStore.findUniqueOrThrow({ where: { shopDomain: 'mi-tienda.myshopify.com' } })
      expect(locationLinkId).toBe(e.locationLinkId)
      expect(await sucursal(e)).toMatchObject({
        status: 'CONNECTING',
        generation: 3,
        storeId: nueva.id,
        shopifyLocationId: 'gid://shopify/Location/9',
      })
      expect(nueva.id).not.toBe(e.storeId)
      for (const f of [ambigua, abandonada, enHttp]) {
        const ahora = await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: f.id } })
        expect(ahora).toMatchObject({
          status: 'DEAD_LETTER',
          ambiguous: true,
          lastError: 'RELIGADA_A_OTRA_TIENDA',
          claimToken: null,
          leaseUntil: null,
          sentInventoryItemId: DEAD_FRESCA.inventario,
          sentLocationId: DEAD_FRESCA.ubicacion,
        })
        expect(ahora.processedAt).toBeInstanceOf(Date)
      }
      // El mensajero que volvía de Shopify con la del lease vivo ya no escribe nada.
      expect(await runShopifyOutboxRow(enHttp.id, 'mensajero', new Date(), { graphql: exito(), hasAccess: conPlan })).toBe('SKIPPED')
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SHOPIFY_CONNECTED', data: expect.objectContaining({ religadas: 3 }) }),
      )
    },
  )

  it('BR-4: la MISMA tienda con algo en camino sigue esperando (409) y nada se manda a DEAD_LETTER', async () => {
    const e = await escenario({ linkStatus: 'DISCONNECTED' })
    const fila = await enVuelo(e)
    const i = {
      venueId: e.venueId,
      authUserId: e.staffId,
      intent: await intentAutorizado(e, e.shopDomain),
      locationId: 'gid://shopify/Location/9',
    }
    await expect(confirmShopifyConnect(i, { graphql: confirmacion() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_ENVIO_EN_CAMINO',
    })
    expect(await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: fila.id } })).toMatchObject({
      status: 'IN_PROGRESS',
      claimToken: 'mensajero',
    })
    expect(await sucursal(e)).toMatchObject({ storeId: e.storeId, shopifyLocationId: UBICACION_PRUEBA, status: 'DISCONNECTED' })
  })

  it('Minor 1 + 4: reintentar con el MISMO intent no vuelve a renovar; lo que la sucursal tiene en camino se reprograma para ya', async () => {
    const e = await escenario()
    const hermana = await otraSucursalDeLaTienda(e)
    otras.push(hermana)
    const enCamino = await ambiguaEnCamino(e, 1)
    expect(await disconnectShopify({ venueId: e.venueId, staffId: e.staffId })).toEqual({ desconectada: true })
    const enSeisHoras = () =>
      prisma.shopifyStockOutbox.update({ where: { id: enCamino.id }, data: { scheduledAt: new Date(Date.now() + 6 * 3_600_000) } })
    const programada = async () => (await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: enCamino.id } })).scheduledAt.getTime()
    const i = { venueId: e.venueId, authUserId: e.staffId, intent: await intentAutorizado(e, e.shopDomain), locationId: UBICACION_PRUEBA }
    const graphql = confirmacion({ name: 'Tienda México' })
    const version = async () => (await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).tokenVersion

    await enSeisHoras()
    await expect(confirmShopifyConnect(i, { graphql })).rejects.toMatchObject({ code: 'SHOPIFY_ENVIO_EN_CAMINO' })
    expect(await version()).toBe(2)
    expect(await programada()).toBeLessThanOrEqual(Date.now())
    expect(await sucursal(hermana)).toMatchObject({ webhooksAt: null, reconcileVersion: 1 })
    // El worker vuelve a registrar los webhooks de la hermana…
    await prisma.shopifyLocationLink.update({ where: { id: hermana.locationLinkId }, data: { webhooksAt: new Date() } })

    await enSeisHoras() // falló otra vez y volvió a esperar
    await expect(confirmShopifyConnect(i, { graphql })).rejects.toMatchObject({ code: 'SHOPIFY_ENVIO_EN_CAMINO' })
    expect(await version()).toBe(2) // el mismo intent: no se renueva otra vez
    // …y el reintento no se los vuelve a pedir ni le pide otra vuelta del cuadre.
    expect(await sucursal(hermana)).toMatchObject({ webhooksAt: expect.any(Date), reconcileVersion: 1 })
    expect(await programada()).toBeLessThanOrEqual(Date.now()) // pero sí se reprograma

    await prisma.shopifyStockOutbox.update({
      where: { id: enCamino.id },
      data: { status: 'SENT', ambiguous: false, processedAt: new Date() },
    })
    await confirmShopifyConnect(i, { graphql })
    expect(await version()).toBe(2)
    expect(await sucursal(e)).toMatchObject({ status: 'CONNECTING', generation: 3 })
    expect((logAction as jest.Mock).mock.calls.filter(([p]) => p.action === 'SHOPIFY_CREDENTIAL_RENEWED')).toHaveLength(1)
  })

  it('S6: desconectar deja el drenado pedido a las hermanas ACTIVE (lo diferido no se vara); sin hermanas vivas, lo diferido se cierra', async () => {
    const x = await escenario()
    const y = await otraSucursalDeLaTienda(x)
    otras.push(y)
    const ev = await prisma.shopifyInboundEvent.create({
      data: {
        dedupKey: crypto.randomUUID(),
        appKey: 'PILOTO',
        topic: 'products/update',
        shopDomain: x.shopDomain,
        payload: { id: 1 },
        status: 'DEFERRED',
      },
    })
    expect(await disconnectShopify({ venueId: y.venueId, staffId: y.staffId })).toEqual({ desconectada: true })
    expect(await sucursal(x)).toMatchObject({ status: 'ACTIVE', requeuePending: true })
    expect(await requeueDeferredEvents(x.locationLinkId)).toMatchObject({ reabiertos: 1, terminado: true })

    await prisma.shopifyInboundEvent.update({ where: { id: ev.id }, data: { status: 'DEFERRED' } })
    expect(await disconnectShopify({ venueId: x.venueId, staffId: x.staffId })).toEqual({ desconectada: true })
    expect(await prisma.shopifyInboundEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({
      status: 'SKIPPED',
      error: 'DESCONECTADO',
    })
  })

  it('BR-1 · R6/S4: desconectar mientras otro proceso toma las sucursales de la tienda por id ⇒ nadie se traba', async () => {
    for (let ronda = 0; ronda < 4; ronda++) {
      const x = await escenario()
      const y = await otraSucursalDeLaTienda(x)
      otras.push(y)
      // Alterna cuál se desconecta (la de id menor o la de id mayor) contra el drenado de la otra (sucursales por id).
      const [sale, queda] = ronda % 2 === 0 ? [y, x] : [x, y]
      await prisma.shopifyLocationLink.update({ where: { id: queda.locationLinkId }, data: { requeuePending: true } })
      const r = await Promise.allSettled([
        disconnectShopify({ venueId: sale.venueId, staffId: sale.staffId }),
        requeueDeferredEvents(queda.locationLinkId),
      ])
      expect(r.map(z => z.status)).toEqual(['fulfilled', 'fulfilled'])
      expect((await sucursal(sale)).status).toBe('DISCONNECTED')
      expect((await sucursal(queda)).status).toBe('ACTIVE')
    }
  })

  it('seguridad: el vector de Shopify (secreto «hush») verifica con el helper de A', () => {
    const q = {
      code: '0907a61c0c8d55e99db179b68161bc00',
      hmac: '700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf',
      shop: 'some-shop.myshopify.com',
      state: '0.6784241404160823',
      timestamp: '1337178173',
    }
    expect(verifyOAuthQueryHmac(q, 'hush')).toBe(true)
    expect(verifyOAuthQueryHmac({ ...q, shop: 'otra.myshopify.com' }, 'hush')).toBe(false)
  })

  it('seguridad: un parámetro repetido ⇒ FIRMA sin tronar; sin secreto de la app ⇒ INTENT; nunca canjea ni registra el token', async () => {
    const e = await escenario()
    const q = await callbackDe(e, 'CONNECT', 'mi-tienda.myshopify.com')
    const exchange = exitoCanje()
    expect(await handleShopifyCallback({ ...q, shop: [q.shop, 'otra.myshopify.com'] } as never, { exchange })).toContain('?error=FIRMA')
    expect(await handleShopifyCallback({ ...q, state: [q.state, q.state] } as never, { exchange })).toContain('?error=INTENT')
    const secreto = process.env.SHOPIFY_PILOTO_CLIENT_SECRET
    process.env.SHOPIFY_PILOTO_CLIENT_SECRET = ''
    try {
      expect(await handleShopifyCallback(q, { exchange })).toContain('?error=INTENT')
    } finally {
      process.env.SHOPIFY_PILOTO_CLIENT_SECRET = secreto
    }
    expect(exchange).not.toHaveBeenCalled()
    // El intent sigue sin usar: con todo en orden, canjea una vez.
    expect(await handleShopifyCallback(q, { exchange })).toContain('?intent=')
    const registrado = JSON.stringify([
      ...(logger.warn as jest.Mock).mock.calls,
      ...(logger.error as jest.Mock).mock.calls,
      ...(logger.info as jest.Mock).mock.calls,
    ])
    expect(registrado).not.toContain('shpat_nuevo')
  })

  it('seguridad: un intent con un dominio que no es de Shopify nunca sale a la red', async () => {
    const e = await escenario()
    const intent = await intentAutorizado(e, 'evil.com')
    const graphql = graphqlFalso(() => ({ ok: true, data: {} }))
    await expect(listIntentLocations({ venueId: e.venueId, authUserId: e.staffId, intent }, { graphql })).rejects.toMatchObject({
      statusCode: 404,
      code: 'SHOPIFY_INTENT_NO_EXISTE',
    })
    await expect(
      confirmShopifyConnect({ venueId: e.venueId, authUserId: e.staffId, intent, locationId: 'gid://shopify/Location/9' }, { graphql }),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(graphql).not.toHaveBeenCalled()
  })
})
