// tests/integration/shopify/app-del-comercio.integration.test.ts
/**
 * 5a, «la app es del comercio» (spec docs/superpowers/specs/2026-10-11-conector-shopify-app-del-comercio-design.md del workspace):
 * el candado propio, conectar y cambiar las llaves con la app que el comercio creó, el cambio de método y los avisos firmados con
 * el secret de cada tienda. Postgres real; Shopify por deps o por `global.fetch`.
 */
jest.mock('@/config/env', () => {
  const real = jest.requireActual('@/config/env')
  return { ...real, env: { ...real.env, BASE_URL: 'https://api.test', FRONTEND_URL: 'https://dash.test' } }
})

import crypto from 'crypto'
import type { Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { SHOPIFY_SCOPES } from '@/services/commerce-channels/shopify/shopify.constants'
import { decryptShopifyToken, encryptShopifyToken } from '@/services/commerce-channels/shopify/shopify.crypto'
import {
  conectarConAppDelComercio,
  confirmShopifyConnect,
  handleShopifyCallback,
  listIntentLocations,
  puedeConectarConAppPropia,
  registerShopifyWebhooks,
  startShopifyConnect,
} from '@/services/commerce-channels/shopify/shopify.connect.service'
import { handleShopifyWebhook, persistShopifyWebhook } from '@/services/commerce-channels/shopify/shopify.inbound.service'
import {
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  graphqlFalso,
  limpiarEscenarioShopify,
  UBICACION_PRUEBA,
} from './fixtures'
import {
  aComercio,
  CLIENT_ID_PRUEBA,
  dormir,
  falla,
  limpiarOtraSucursal,
  LLAVE_OK,
  otraSucursalDeLaTienda,
  quitarFetch,
  SECRET_MALO,
  SECRET_PRUEBA,
  shopifyPorFetch,
} from './fixturesB'

jest.setTimeout(120_000)
const SECRETO = 'secreto-app-piloto'
const D = (v: number) => new Prisma.Decimal(v)

let escenarios: EscenarioShopify[] = []
async function escenario(o?: Parameters<typeof crearEscenarioShopify>[0]): Promise<EscenarioShopify> {
  const e = await crearEscenarioShopify(o)
  escenarios.push(e)
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
  process.env.SHOPIFY_PILOTO_SHOPS = ''
  ;(logAction as jest.Mock).mockClear()
})
afterEach(async () => {
  quitarFetch()
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
})

/** Una función concedida al negocio con su fila `VenueFeature` (la cortesía de superadmin, o un plan). */
async function conFuncion(venueId: string, code: string, o: { endDate?: Date | null } = {}) {
  const feature = await prisma.feature.upsert({
    where: { code },
    create: { code, name: code, category: 'INTEGRATIONS', monthlyPrice: D(0) },
    update: {},
  })
  return prisma.venueFeature.create({
    data: { venueId, featureId: feature.id, active: true, monthlyPrice: D(0), endDate: o.endDate ?? null },
  })
}
/** La invitación a la app propia: la cortesía explícita y vigente de SHOPIFY_INTEGRATION. */
const conCortesia = (e: EscenarioShopify) => conFuncion(e.venueId, 'SHOPIFY_INTEGRATION')

describe('5a · el candado propio (riesgo 4)', () => {
  it('🔴 deja pasar SÓLO con la fila de cortesía explícita y vigente; el trato preferente, el Premium, una capability grant sola, la fila vencida o suspendida y la demo con su fila automática, no', async () => {
    const e = await escenario()
    const puede = () => puedeConectarConAppPropia(e.venueId)
    expect(await puede()).toBe(false) // nada
    await prisma.venue.update({ where: { id: e.venueId }, data: { seatCapExempt: true } })
    expect(await puede()).toBe(false) // trato preferente sin fila
    await prisma.venue.update({ where: { id: e.venueId }, data: { seatCapExempt: false } })
    await conFuncion(e.venueId, 'PLAN_PREMIUM')
    expect(await puede()).toBe(false) // Premium sin fila
    await prisma.capabilityGrant.create({
      data: {
        venueId: e.venueId,
        featureCode: 'SHOPIFY_INTEGRATION',
        sourceId: 'grant-sola',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 86_400_000),
      },
    })
    expect(await puede()).toBe(false) // una capability grant sola no es la cortesía
    const vf = await conFuncion(e.venueId, 'SHOPIFY_INTEGRATION', { endDate: new Date(Date.now() - 86_400_000) })
    expect(await puede()).toBe(false) // fila vencida
    await prisma.venueFeature.update({ where: { id: vf.id }, data: { endDate: null } })
    expect(await puede()).toBe(true) // la cortesía: fila vigente
    await prisma.venueFeature.update({ where: { id: vf.id }, data: { suspendedAt: new Date() } })
    expect(await puede()).toBe(false) // suspendida
    await prisma.venueFeature.update({ where: { id: vf.id }, data: { suspendedAt: null } })
    for (const status of ['LIVE_DEMO', 'TRIAL'] as const) {
      await prisma.venue.update({ where: { id: e.venueId }, data: { status } })
      expect(await puede()).toBe(false) // una demo trae su fila sola: no cuenta
    }
  })

  it('🔴 el piloto no cambia: fuera de SHOPIFY_PILOTO_SHOPS y con la cortesía ⇒ 409 SHOPIFY_USA_APP_PROPIA; sin ella ⇒ SHOPIFY_SOLO_PILOTO; una del piloto sigue a OAuth', async () => {
    const e = await escenario()
    const i = { venueId: e.venueId, authUserId: e.staffId, purpose: 'CONNECT' as const }
    await expect(startShopifyConnect({ ...i, shopDomain: 'otra.myshopify.com' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_SOLO_PILOTO',
    })
    await conCortesia(e)
    await expect(startShopifyConnect({ ...i, shopDomain: 'otra.myshopify.com' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_USA_APP_PROPIA',
    })
    process.env.SHOPIFY_PILOTO_SHOPS = 'otra.myshopify.com'
    expect((await startShopifyConnect({ ...i, shopDomain: 'otra.myshopify.com' })).url).toContain(
      'https://otra.myshopify.com/admin/oauth/authorize',
    )
  })
})

/** Lo que manda la página: las llaves de la app de la tienda para conectar (o, con REAUTHORIZE, para cambiarlas). */
const llaves = (e: EscenarioShopify, o: { dominio?: string; purpose?: 'CONNECT' | 'REAUTHORIZE' } = {}) => ({
  venueId: e.venueId,
  authUserId: e.staffId,
  shopDomain: o.dominio ?? e.shopDomain,
  clientId: CLIENT_ID_PRUEBA,
  clientSecret: SECRET_PRUEBA,
  purpose: o.purpose ?? ('CONNECT' as const),
})
const sinConexion = async (e: EscenarioShopify) => {
  await prisma.shopifyVariantLink.deleteMany({ where: { venueId: e.venueId } })
  await prisma.shopifyLocationLink.deleteMany({ where: { venueId: e.venueId } })
}
const tienda = (e: EscenarioShopify) => prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
const sucursal = (e: EscenarioShopify) => prisma.shopifyLocationLink.findUniqueOrThrow({ where: { venueId: e.venueId } })
const intents = (e: EscenarioShopify) => prisma.shopifyConnectIntent.count({ where: { venueId: e.venueId } })
const registros = () => JSON.stringify([logger.info, logger.warn, logger.error, logger.debug].map(f => (f as jest.Mock).mock.calls))
const comoError = (err: { message: string; code?: string; details?: unknown }) => ({
  message: err.message,
  code: err.code,
  details: err.details,
})
/** Firma una consulta del callback como Shopify (los mismos campos más `hmac`). */
const firmarConsulta = <Q extends Record<string, string>>(q: Q): Q & { hmac: string } => {
  const msg = Object.keys(q)
    .sort()
    .map(k => `${k}=${q[k]}`)
    .join('&')
  return { ...q, hmac: crypto.createHmac('sha256', SECRETO).update(msg).digest('hex') }
}
const ubicaciones = () =>
  graphqlFalso((q, vars) =>
    q.includes('Ubicaciones')
      ? {
          ok: true,
          data: {
            locations: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: UBICACION_PRUEBA, name: 'Centro', isActive: true, address: { countryCode: 'MX' } }],
            },
          },
        }
      : { ok: true, data: { location: { id: vars.id, name: 'Centro', isActive: true } } },
  )

describe('5a · conectar con las llaves de la app de la tienda', () => {
  it('🔴 CONNECT (Review Focus 1: espacios y mayúsculas): pide la llave con las llaves recortadas, deja el intent EXCHANGED con todo cifrado y sigue como tras el callback; la tienda nace COMERCIO con sus llaves', async () => {
    const e = await escenario()
    await sinConexion(e)
    await conCortesia(e)
    const dominio = `nueva-${e.venueId.slice(-10)}.myshopify.com`
    const f = shopifyPorFetch({ llave: () => LLAVE_OK('shpat_conectar') })
    const r = await conectarConAppDelComercio({
      ...llaves(e),
      shopDomain: `  ${dominio.toUpperCase()} `,
      clientId: ` ${CLIENT_ID_PRUEBA}\n`,
      clientSecret: `  ${SECRET_PRUEBA} `,
    })
    if (!('intent' in r)) throw new Error('se esperaba el intent')
    expect(r.intent).toMatch(/^c[a-z0-9]+\.[0-9a-f]{64}$/)
    expect(f.mock.calls[0][0]).toBe(`https://${dominio}/admin/oauth/access_token`)
    expect(Object.fromEntries(new URLSearchParams(f.mock.calls[0][1].body))).toEqual({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID_PRUEBA,
      client_secret: SECRET_PRUEBA,
    })
    const intent = await prisma.shopifyConnectIntent.findFirstOrThrow({ where: { venueId: e.venueId } })
    expect(intent).toMatchObject({
      appKey: 'COMERCIO',
      purpose: 'CONNECT',
      status: 'EXCHANGED',
      shopDomain: dominio,
      clientId: CLIENT_ID_PRUEBA,
    })
    expect(decryptShopifyToken(intent.clientSecretCiphertext!)).toBe(SECRET_PRUEBA)
    expect(decryptShopifyToken(intent.tokenCiphertext!)).toBe('shpat_conectar')
    expect(intent.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 86_000_000)
    expect(intent.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHOPIFY_CONNECT_STARTED',
        entityId: intent.id,
        staffId: e.staffId,
        data: { metodo: 'APP_DEL_COMERCIO', shopDomain: dominio },
      }),
    )
    // De aquí, el camino de siempre: las ubicaciones con la llave del intent y confirmar crea la tienda con sus llaves.
    const graphql = ubicaciones()
    expect(await listIntentLocations({ venueId: e.venueId, authUserId: e.staffId, intent: r.intent }, { graphql })).toEqual([
      { id: UBICACION_PRUEBA, name: 'Centro', countryCode: 'MX' },
    ])
    expect(graphql.mock.calls[0][1]).toBe('shpat_conectar')
    await confirmShopifyConnect({ venueId: e.venueId, authUserId: e.staffId, intent: r.intent, locationId: UBICACION_PRUEBA }, { graphql })
    const nueva = await prisma.shopifyStore.findUniqueOrThrow({ where: { shopDomain: dominio } })
    expect(nueva).toMatchObject({ appKey: 'COMERCIO', clientId: CLIENT_ID_PRUEBA, status: 'ACTIVE', tokenVersion: 1 })
    expect(decryptShopifyToken(nueva.clientSecretCiphertext!)).toBe(SECRET_PRUEBA)
    expect(decryptShopifyToken(nueva.accessTokenCiphertext)).toBe('shpat_conectar')
    expect(nueva.accessTokenExpiresAt!.getTime()).toBe(intent.tokenExpiresAt!.getTime())
  })

  it.each([
    ['secret malo', 422, 'SHOPIFY_APP_SECRET_INVALIDO', SECRET_MALO],
    [
      'Client ID malo',
      422,
      'SHOPIFY_APP_CLIENT_ID_INVALIDO',
      {
        status: 400,
        body: {
          error: 'application_cannot_be_found',
          error_description: 'Could not find Shopify API application with api_key 00000000000000000000000000000000',
        },
      },
    ],
    [
      'app de otra organización',
      422,
      'SHOPIFY_APP_OTRA_ORGANIZACION',
      { status: 400, body: 'Oauth error shop_not_permitted: Client credentials cannot be performed on this shop.' },
    ],
    ['tienda inexistente', 422, 'SHOPIFY_TIENDA_NO_EXISTE', { status: 404, body: { errors: 'Not Found' } }],
    ['otro rechazo', 422, 'SHOPIFY_APP_RECHAZADA', { status: 400, body: { error: 'invalid_scope' } }],
    ['Shopify sin contestar', 503, 'SHOPIFY_NO_RESPONDE', { status: 503, body: 'x' }],
  ] as const)('🔴 %s ⇒ %i %s y no se crea nada', async (_caso, statusCode, code, contesta) => {
    const e = await escenario()
    await conCortesia(e)
    shopifyPorFetch({ llave: () => contesta })
    await expect(conectarConAppDelComercio(llaves(e))).rejects.toMatchObject({ statusCode, code })
    expect(await intents(e)).toBe(0)
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SHOPIFY_CONNECT_STARTED' }))
  })

  it('🔴 faltan permisos ⇒ 422 SHOPIFY_APP_FALTAN_PERMISOS con la lista y qué hacer; no se crea nada', async () => {
    const e = await escenario()
    await conCortesia(e)
    shopifyPorFetch({ llave: () => ({ status: 200, body: { access_token: 'shpat_x', scope: 'read_products', expires_in: 86399 } }) })
    await expect(conectarConAppDelComercio(llaves(e))).rejects.toMatchObject({
      statusCode: 422,
      code: 'SHOPIFY_APP_FALTAN_PERMISOS',
      message: expect.stringContaining('publica una versión y apruébala en tu tienda'),
      details: { faltan: ['write_products', 'read_inventory', 'write_inventory', 'read_locations', 'read_orders', 'read_fulfillments'] },
    })
    expect(await intents(e)).toBe(0)
  })

  it('🔴 Review Focus 2: sin la invitación vigente ⇒ 403 SHOPIFY_APP_PROPIA_SIN_INVITACION que dice a quién pedirla, y nada sale a Shopify; un dominio que no es de Shopify ⇒ 400', async () => {
    const e = await escenario()
    const f = shopifyPorFetch({ llave: () => LLAVE_OK() })
    await expect(conectarConAppDelComercio(llaves(e))).rejects.toMatchObject({
      statusCode: 403,
      code: 'SHOPIFY_APP_PROPIA_SIN_INVITACION',
      message: expect.stringContaining('Escríbenos'),
    })
    await expect(conectarConAppDelComercio(llaves(e, { purpose: 'REAUTHORIZE' }))).rejects.toMatchObject({
      code: 'SHOPIFY_APP_PROPIA_SIN_INVITACION',
    })
    await conCortesia(e)
    await expect(conectarConAppDelComercio(llaves(e, { dominio: 'evil.com' }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'SHOPIFY_DOMINIO_INVALIDO',
    })
    expect(f).not.toHaveBeenCalled()
  })

  it('🔴 Review Focus 5: «Cambiar llaves» con el dominio de OTRA tienda ⇒ 409 SHOPIFY_REAUTORIZAR_SIN_TIENDA y el secret no viaja', async () => {
    const e = await escenario()
    await conCortesia(e)
    const f = shopifyPorFetch({ llave: () => LLAVE_OK() })
    await expect(
      conectarConAppDelComercio(llaves(e, { dominio: 'otra-tienda.myshopify.com', purpose: 'REAUTHORIZE' })),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_REAUTORIZAR_SIN_TIENDA',
    })
    expect(f).not.toHaveBeenCalled()
    expect(await intents(e)).toBe(0)
  })

  it('🔴 riesgo 6: el secret (ni la llave) no sale en ninguna respuesta, ni en ActivityLog, ni en el log', async () => {
    const e = await escenario()
    await conCortesia(e)
    for (const f of [logger.info, logger.warn, logger.error, logger.debug]) (f as jest.Mock).mockClear()
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_no_se_ve') })
    const bien = await conectarConAppDelComercio(llaves(e))
    shopifyPorFetch({ llave: () => SECRET_MALO })
    const mal = await conectarConAppDelComercio(llaves(e)).catch(comoError)
    shopifyPorFetch({ llave: () => ({ status: 200, body: { access_token: 'shpat_no_se_ve', scope: 'read_products', expires_in: 86399 } }) })
    const permisos = await conectarConAppDelComercio(llaves(e)).catch(comoError)
    for (const visto of [JSON.stringify([bien, mal, permisos]), JSON.stringify((logAction as jest.Mock).mock.calls), registros()]) {
      expect(visto).not.toContain(SECRET_PRUEBA)
      expect(visto).not.toContain('shpat_no_se_ve')
    }
    const intent = await prisma.shopifyConnectIntent.findFirstOrThrow({ where: { venueId: e.venueId } })
    expect(Buffer.from(intent.clientSecretCiphertext!).toString('utf8')).not.toContain(SECRET_PRUEBA)
    expect(Buffer.from(intent.tokenCiphertext!).toString('utf8')).not.toContain('shpat_no_se_ve')
  })

  it('🔴 ruling P2-4: la llave del intent vence a medio asistente: ubicaciones y confirmar piden otra con las llaves del intent, la guardan y la tienda nace con la vigente; un 401 se repite UNA vez', async () => {
    const e = await escenario()
    await sinConexion(e)
    await conCortesia(e)
    const dominio = `vence-${e.venueId.slice(-10)}.myshopify.com`
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_primera') })
    const r = await conectarConAppDelComercio({ ...llaves(e), shopDomain: dominio })
    if (!('intent' in r)) throw new Error('se esperaba el intent')
    // El dueño se tardó: a la llave del intent le queda menos de un minuto.
    await prisma.shopifyConnectIntent.updateMany({ where: { venueId: e.venueId }, data: { tokenExpiresAt: new Date(Date.now() + 30_000) } })
    const pide = shopifyPorFetch({ llave: () => LLAVE_OK('shpat_segunda') })
    const lista = ubicaciones()
    await listIntentLocations({ venueId: e.venueId, authUserId: e.staffId, intent: r.intent }, { graphql: lista })
    expect(lista.mock.calls[0][1]).toBe('shpat_segunda')
    expect(Object.fromEntries(new URLSearchParams(pide.mock.calls[0][1].body))).toMatchObject({
      client_id: CLIENT_ID_PRUEBA,
      client_secret: SECRET_PRUEBA,
    })
    const intent = await prisma.shopifyConnectIntent.findFirstOrThrow({ where: { venueId: e.venueId } })
    expect(decryptShopifyToken(intent.tokenCiphertext!)).toBe('shpat_segunda')
    expect(intent.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 86_000_000)
    // Se vuelve a tardar entre elegir y confirmar: confirmar pide otra antes de usarla; y si Shopify aun así dice 401 (la llave
    // venció justo ahí), se pide otra UNA vez, se repite y la tienda nace con la última.
    await prisma.shopifyConnectIntent.updateMany({ where: { venueId: e.venueId }, data: { tokenExpiresAt: new Date(Date.now() + 30_000) } })
    const otras = ['shpat_tercera', 'shpat_cuarta']
    shopifyPorFetch({ llave: () => LLAVE_OK(otras.shift()) })
    let vez = 0
    const con401 = graphqlFalso((_q, vars) =>
      vez++ === 0 ? falla('UNAUTHORIZED', false, false) : { ok: true, data: { location: { id: vars.id, name: 'Centro', isActive: true } } },
    )
    await confirmShopifyConnect(
      { venueId: e.venueId, authUserId: e.staffId, intent: r.intent, locationId: UBICACION_PRUEBA },
      { graphql: con401 },
    )
    expect(con401.mock.calls.map(c => c[1])).toEqual(['shpat_tercera', 'shpat_cuarta'])
    const nueva = await prisma.shopifyStore.findUniqueOrThrow({ where: { shopDomain: dominio } })
    expect(decryptShopifyToken(nueva.accessTokenCiphertext)).toBe('shpat_cuarta')
    expect(nueva.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 86_000_000)
  })

  it('un segundo 401 al confirmar ya no se repite: 503 SHOPIFY_NO_RESPONDE y no nace ninguna tienda', async () => {
    const e = await escenario()
    await sinConexion(e)
    await conCortesia(e)
    const dominio = `otro401-${e.venueId.slice(-10)}.myshopify.com`
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_primera') })
    const r = await conectarConAppDelComercio({ ...llaves(e), shopDomain: dominio })
    if (!('intent' in r)) throw new Error('se esperaba el intent')
    const siempre401 = graphqlFalso(() => falla('UNAUTHORIZED', false, false))
    await expect(
      confirmShopifyConnect(
        { venueId: e.venueId, authUserId: e.staffId, intent: r.intent, locationId: UBICACION_PRUEBA },
        { graphql: siempre401 },
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: 'SHOPIFY_NO_RESPONDE' })
    expect(siempre401).toHaveBeenCalledTimes(2)
    expect(await prisma.shopifyStore.findUnique({ where: { shopDomain: dominio } })).toBeNull()
  })

  it('🔴 fix final (I2): confirmar reintentado tras un 409, con la llave del intent renovada en medio, sube tokenVersion UNA sola vez (con la app del comercio se comparan las llaves de la app, no la llave de 24 h)', async () => {
    const e = await escenario({ linkStatus: 'DISCONNECTED' })
    await conCortesia(e)
    // Un envío de la conexión anterior a la MISMA tienda sigue en camino: confirmar contesta 409 hasta que llegue (K9: la credencial ya
    // quedó guardada antes del 409).
    const enCamino = await prisma.shopifyStockOutbox.create({
      data: {
        venueId: e.venueId,
        locationLinkId: e.locationLinkId,
        generation: 1,
        productId: e.productId,
        delta: -1,
        status: 'IN_PROGRESS',
        claimToken: 'mensajero',
        leaseUntil: new Date(Date.now() + 60_000),
      },
    })
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_primera') })
    const r = await conectarConAppDelComercio(llaves(e))
    if (!('intent' in r)) throw new Error('se esperaba el intent')
    const i = { venueId: e.venueId, authUserId: e.staffId, intent: r.intent, locationId: UBICACION_PRUEBA }
    const graphql = ubicaciones()
    await expect(confirmShopifyConnect(i, { graphql })).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_ENVIO_EN_CAMINO' })
    expect(await tienda(e)).toMatchObject({ appKey: 'COMERCIO', tokenVersion: 2 })
    // El dueño se tarda: a la llave del intent le queda menos de un minuto y el reintento pide otra. Shopify da la MISMA llave, que el
    // intent vuelve a cifrar con otros bytes.
    const delIntent = () => prisma.shopifyConnectIntent.findFirstOrThrow({ where: { venueId: e.venueId } })
    await prisma.shopifyConnectIntent.updateMany({ where: { venueId: e.venueId }, data: { tokenExpiresAt: new Date(Date.now() + 30_000) } })
    const antes = Buffer.from((await delIntent()).tokenCiphertext!)
    const pide = shopifyPorFetch({ llave: () => LLAVE_OK('shpat_primera') })
    await expect(confirmShopifyConnect(i, { graphql })).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_ENVIO_EN_CAMINO' })
    expect(pide).toHaveBeenCalledTimes(1)
    expect(Buffer.from((await delIntent()).tokenCiphertext!).equals(antes)).toBe(false)
    expect((await tienda(e)).tokenVersion).toBe(2)
    // Ya llegó lo que iba en camino: confirmar entra sin renovar otra vez.
    await prisma.shopifyStockOutbox.update({
      where: { id: enCamino.id },
      data: { status: 'SENT', processedAt: new Date(), claimToken: null, leaseUntil: null },
    })
    await confirmShopifyConnect(i, { graphql })
    expect(await tienda(e)).toMatchObject({ appKey: 'COMERCIO', tokenVersion: 2, status: 'ACTIVE' })
    expect((await sucursal(e)).status).toBe('CONNECTING')
    expect((logAction as jest.Mock).mock.calls.filter(([p]) => p.action === 'SHOPIFY_CREDENTIAL_RENEWED')).toHaveLength(1)
  })
})

describe('5a · un asistente abierto antes de «Cambiar llaves» (Codex C2)', () => {
  it('🔴 la otra sucursal confirma con un intent de ANTES del último cambio de llaves: 409 SHOPIFY_LLAVES_CAMBIARON, la tienda se queda con las llaves nuevas, tokenVersion no sube y la sucursal no se liga', async () => {
    const e = await escenario()
    await conCortesia(e)
    await aComercio(e)
    const otra = await otraSucursalDeLaTienda(e, { sinEnlace: true })
    try {
      await conCortesia(otra)
      // La otra sucursal abre su asistente con las llaves de hoy y lo deja abierto en la elección de ubicación.
      shopifyPorFetch({ llave: () => LLAVE_OK('shpat_vieja') })
      const r = await conectarConAppDelComercio(llaves(otra))
      if (!('intent' in r)) throw new Error('se esperaba el intent')
      await dormir(5)
      // Mientras tanto, el dueño rota el Client Secret con «Cambiar llaves» desde la primera sucursal.
      const NUEVO = 'shpss_secreto_rotado_0123456789abcdef'
      shopifyPorFetch({ llave: () => LLAVE_OK('shpat_nueva') })
      expect(await conectarConAppDelComercio({ ...llaves(e, { purpose: 'REAUTHORIZE' }), clientSecret: NUEVO })).toEqual({
        reautorizada: true,
      })
      const antes = await tienda(e)
      expect(decryptShopifyToken(antes.clientSecretCiphertext!)).toBe(NUEVO)
      // La otra sucursal vuelve y elige su ubicación con el intent viejo: no puede restaurar el secret de antes.
      const i = { venueId: otra.venueId, authUserId: otra.staffId, intent: r.intent, locationId: 'gid://shopify/Location/2' }
      await expect(confirmShopifyConnect(i, { graphql: ubicaciones() })).rejects.toMatchObject({
        statusCode: 409,
        code: 'SHOPIFY_LLAVES_CAMBIARON',
        message: 'Las llaves de esta tienda cambiaron mientras conectabas; vuelve a empezar.',
      })
      const despues = await tienda(e)
      expect(decryptShopifyToken(despues.clientSecretCiphertext!)).toBe(NUEVO)
      expect(decryptShopifyToken(despues.accessTokenCiphertext)).toBe('shpat_nueva')
      expect(despues.tokenVersion).toBe(antes.tokenVersion)
      expect(despues.authorizedAt).toEqual(antes.authorizedAt)
      expect(await prisma.shopifyLocationLink.findUnique({ where: { venueId: otra.venueId } })).toBeNull()
      expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SHOPIFY_CREDENTIAL_RENEWED' }))
      // Con un intent nuevo (las llaves de hoy) sí entra.
      shopifyPorFetch({ llave: () => LLAVE_OK('shpat_nueva') })
      const r2 = await conectarConAppDelComercio({ ...llaves(otra), clientSecret: NUEVO })
      if (!('intent' in r2)) throw new Error('se esperaba el intent')
      await confirmShopifyConnect({ ...i, intent: r2.intent }, { graphql: ubicaciones() })
      expect(decryptShopifyToken((await tienda(e)).clientSecretCiphertext!)).toBe(NUEVO)
      expect((await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { venueId: otra.venueId } })).status).toBe('CONNECTING')
    } finally {
      await limpiarOtraSucursal(otra)
    }
  })
})

describe('5a · cambiar de método por REAUTHORIZE (riesgo 7)', () => {
  it('🔴 PILOTO → COMERCIO → PILOTO: credenciales coherentes en cada paso, tokenVersion sube y los avisos se vuelven a pedir en la ruta de su app', async () => {
    const e = await escenario()
    await conCortesia(e)
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { webhooksAt: new Date() } })
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_comercio') })
    expect(await conectarConAppDelComercio(llaves(e, { purpose: 'REAUTHORIZE' }))).toEqual({ reautorizada: true })
    let t = await tienda(e)
    expect(t).toMatchObject({ appKey: 'COMERCIO', clientId: CLIENT_ID_PRUEBA, tokenVersion: 2, status: 'ACTIVE' })
    expect(decryptShopifyToken(t.accessTokenCiphertext)).toBe('shpat_comercio')
    expect(decryptShopifyToken(t.clientSecretCiphertext!)).toBe(SECRET_PRUEBA)
    expect(t.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 86_000_000)
    expect((await sucursal(e)).webhooksAt).toBeNull()
    expect(await prisma.shopifyConnectIntent.findFirstOrThrow({ where: { venueId: e.venueId } })).toMatchObject({
      appKey: 'COMERCIO',
      purpose: 'REAUTHORIZE',
      status: 'CONSUMED',
    })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'SHOPIFY_REAUTHORIZED', entityId: e.storeId }))
    // Los avisos se vuelven a pedir con la llave de 24 h y en la ruta de la app del comercio.
    const avisos = graphqlFalso((q, vars) =>
      q.includes('Suscripciones')
        ? { ok: true, data: { webhookSubscriptions: { nodes: [] } } }
        : {
            ok: true,
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1', topic: vars.topic, uri: vars.uri },
                userErrors: [],
              },
            },
          },
    )
    expect(await registerShopifyWebhooks(e.locationLinkId, { graphql: avisos })).toEqual({ done: false })
    expect(avisos.mock.calls.map(c => c[1])).toEqual(['shpat_comercio', 'shpat_comercio'])
    expect(avisos.mock.calls.map(c => c[3].uri)).toEqual([
      'https://api.test/api/v1/webhooks/shopify/comercio',
      'https://api.test/api/v1/webhooks/shopify/comercio',
    ])
    // Y de vuelta al piloto por OAuth: las llaves del comercio se borran de la tienda.
    process.env.SHOPIFY_PILOTO_SHOPS = e.shopDomain
    const { url } = await startShopifyConnect({
      venueId: e.venueId,
      authUserId: e.staffId,
      shopDomain: e.shopDomain,
      purpose: 'REAUTHORIZE',
    })
    const q = firmarConsulta({ code: 'c1', shop: e.shopDomain, state: new URL(url).searchParams.get('state')!, timestamp: '1700000000' })
    const exchange = jest.fn(async () => ({ ok: true as const, data: { accessToken: 'shpat_piloto', scope: SHOPIFY_SCOPES } }))
    expect(await handleShopifyCallback(q, { exchange })).toContain('?reautorizada=1')
    t = await tienda(e)
    expect(t).toMatchObject({ appKey: 'PILOTO', clientId: null, clientSecretCiphertext: null, accessTokenExpiresAt: null, tokenVersion: 3 })
    expect(decryptShopifyToken(t.accessTokenCiphertext)).toBe('shpat_piloto')
  })

  it('🔴 ruling preflight: si `reautorizar` truena a media vuelta, el intent queda FAILED (no EXCHANGING para siempre), el error sale tal cual y la tienda no cambia', async () => {
    const e = await escenario()
    await conCortesia(e)
    const antes = await tienda(e)
    shopifyPorFetch({ llave: () => LLAVE_OK('shpat_comercio') })
    // La primera tx de esta vuelta es la de `reautorizar` (REAUTHORIZE no pasa por el candado del catálogo maestro).
    const espia = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('base caída a media vuelta'))
    try {
      await expect(conectarConAppDelComercio(llaves(e, { purpose: 'REAUTHORIZE' }))).rejects.toThrow('base caída a media vuelta')
    } finally {
      espia.mockRestore()
    }
    expect(await prisma.shopifyConnectIntent.findFirstOrThrow({ where: { venueId: e.venueId } })).toMatchObject({
      appKey: 'COMERCIO',
      purpose: 'REAUTHORIZE',
      status: 'FAILED',
    })
    expect(await tienda(e)).toMatchObject({
      appKey: antes.appKey,
      tokenVersion: antes.tokenVersion,
      clientId: null,
      clientSecretCiphertext: null,
    })
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SHOPIFY_REAUTHORIZED' }))
  })
})

describe('5a · avisos con el secret de cada tienda (riesgo 5)', () => {
  const firmarCon = (secreto: string, b: Buffer) => crypto.createHmac('sha256', secreto).update(b).digest('base64')
  const CUERPO = Buffer.from(JSON.stringify({ inventory_item_id: 1, location_id: 1 }))
  const guardar = (appKey: 'COMERCIO' | 'PILOTO', shopDomain: string, hmac: string) =>
    persistShopifyWebhook({ rawBody: CUERPO, appKey, hmac, topic: 'inventory_levels/update', shopDomain, webhookId: crypto.randomUUID() })

  it('🔴 un aviso COMERCIO se verifica con el secret de SU tienda; con el de otra, con el viejo o sin tienda COMERCIO ⇒ 401; PILOTO sigue con el de env', async () => {
    const a = await escenario()
    await aComercio(a)
    const b = await escenario()
    await aComercio(b)
    await prisma.shopifyStore.update({
      where: { id: b.storeId },
      data: { clientSecretCiphertext: encryptShopifyToken('shpss_de_la_otra_tienda') },
    })
    expect((await guardar('COMERCIO', a.shopDomain, firmarCon(SECRET_PRUEBA, CUERPO))).outcome).toBe('PERSISTED')
    // La firma de OTRA tienda con el dominio de ésta: el encabezado sólo elige el secret; la firma decide.
    expect(await guardar('COMERCIO', a.shopDomain, firmarCon('shpss_de_la_otra_tienda', CUERPO))).toEqual({ outcome: 'INVALID_SIGNATURE' })
    // El secret viejo, después de «Cambiar llaves».
    await prisma.shopifyStore.update({ where: { id: a.storeId }, data: { clientSecretCiphertext: encryptShopifyToken('shpss_nuevo') } })
    expect(await guardar('COMERCIO', a.shopDomain, firmarCon(SECRET_PRUEBA, CUERPO))).toEqual({ outcome: 'INVALID_SIGNATURE' })
    expect((await guardar('COMERCIO', ` ${a.shopDomain.toUpperCase()} `, firmarCon('shpss_nuevo', CUERPO))).outcome).toBe('PERSISTED')
    // Sin tienda, un dominio que no es de Shopify, o una tienda PILOTO por la ruta de COMERCIO.
    expect(await guardar('COMERCIO', 'no-existe-5a.myshopify.com', firmarCon(SECRET_PRUEBA, CUERPO))).toEqual({
      outcome: 'INVALID_SIGNATURE',
    })
    expect(await guardar('COMERCIO', 'evil.com', firmarCon(SECRET_PRUEBA, CUERPO))).toEqual({ outcome: 'INVALID_SIGNATURE' })
    const p = await escenario()
    expect(await guardar('COMERCIO', p.shopDomain, firmarCon(SECRETO, CUERPO))).toEqual({ outcome: 'INVALID_SIGNATURE' })
    // El piloto no cambia.
    expect((await guardar('PILOTO', p.shopDomain, firmarCon(SECRETO, CUERPO))).outcome).toBe('PERSISTED')
    expect(await prisma.shopifyInboundEvent.count({ where: { shopDomain: a.shopDomain, appKey: 'COMERCIO' } })).toBe(2)
  })

  it('la ruta /webhooks/shopify/comercio guarda el aviso como COMERCIO; otra sigue en 404', async () => {
    const a = await escenario()
    await aComercio(a)
    const respuesta = () => {
      const res = { status: jest.fn(), end: jest.fn() }
      res.status.mockReturnValue(res)
      return res
    }
    const peticion = (appKey: string, headers: Record<string, string>) =>
      ({ params: { appKey }, body: CUERPO, get: (h: string) => headers[h.toLowerCase()] }) as unknown as Request
    const cabeceras = {
      'x-shopify-hmac-sha256': firmarCon(SECRET_PRUEBA, CUERPO),
      'x-shopify-topic': 'inventory_levels/update',
      'x-shopify-shop-domain': a.shopDomain,
      'x-shopify-webhook-id': `w-comercio-${a.venueId}`,
    }
    const ok = respuesta()
    await handleShopifyWebhook(peticion('comercio', cabeceras), ok as unknown as Response)
    expect(ok.status).toHaveBeenCalledWith(200)
    expect(await prisma.shopifyInboundEvent.findUniqueOrThrow({ where: { dedupKey: `w-comercio-${a.venueId}` } })).toMatchObject({
      appKey: 'COMERCIO',
      shopDomain: a.shopDomain,
    })
    const otra = respuesta()
    await handleShopifyWebhook(peticion('otra', cabeceras), otra as unknown as Response)
    expect(otra.status).toHaveBeenCalledWith(404)
  })
})
