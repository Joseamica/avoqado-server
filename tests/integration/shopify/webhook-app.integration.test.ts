// tests/integration/shopify/webhook-app.integration.test.ts
/**
 * S1 y L3 (C3): por la app REAL (supertest contra `app`, con su orden de montaje) y Postgres real.
 * - Un aviso firmado deja exactamente UN `ShopifyInboundEvent`; repetido, sigue siendo uno (dedup por X-Shopify-Webhook-Id).
 *   Mal firmado: 401 y ninguna fila.
 * - El callback recibe `req.query` sin tocar (T7): un parámetro repetido ⇒ `?error=FIRMA` por el `handleShopifyCallback`
 *   real, y el intent no se gasta.
 * - L1: un callback con la forma del piloto (`host` terminado en `==`, firmado como la biblioteca oficial de Shopify)
 *   pasa la firma y llega al canje.
 */
import crypto from 'crypto'
import request from 'supertest'
import app from '@/app'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import * as graphql from '@/services/commerce-channels/shopify/shopify.graphql'
import { signIntentId } from '@/services/commerce-channels/shopify/shopify.crypto'
import { assertTestDatabase, crearEscenarioShopify, type EscenarioShopify, limpiarEscenarioShopify } from './fixtures'

jest.setTimeout(120_000)
const SECRETO = 'secreto-app-piloto'
const HOST = 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYXZvcWFkby1wcnVlYmEtc3luYw==' // base64 de admin.shopify.com/store/avoqado-prueba-sync
const CALLBACK = '/api/v1/shopify/oauth/callback'

let e: EscenarioShopify
beforeAll(async () => {
  assertTestDatabase()
  Object.assign(process.env, {
    SHOPIFY_PILOTO_CLIENT_ID: 'cliente',
    SHOPIFY_PILOTO_CLIENT_SECRET: SECRETO,
    OAUTH_STATE_SECRET: 'estado-de-prueba',
  })
  e = await crearEscenarioShopify()
})
afterAll(async () => {
  if (e) await limpiarEscenarioShopify(e)
})
afterEach(() => jest.restoreAllMocks())

const eventos = (webhookId: string) => prisma.shopifyInboundEvent.count({ where: { dedupKey: webhookId } })
// Espacios y orden raros A PROPÓSITO: si algo re-serializara el cuerpo antes de la firma, el HMAC dejaría de cuadrar.
const CUERPO = '{ "inventory_item_id":1,   "location_id":1, "available":7 }'
const avisar = (webhookId: string, hmac: string) =>
  request(app)
    .post('/api/v1/webhooks/shopify/piloto')
    .set('Content-Type', 'application/json')
    .set('X-Shopify-Topic', 'inventory_levels/update')
    .set('X-Shopify-Shop-Domain', e.shopDomain)
    .set('X-Shopify-Webhook-Id', webhookId)
    .set('X-Shopify-Hmac-SHA256', hmac)
    .send(CUERPO)

describe('S1: el webhook de Shopify por la app real', () => {
  it('🔴 firmado ⇒ 200 y exactamente UN evento guardado con lo que el procesador lee del cuerpo (M7); repetido, sigue siendo uno', async () => {
    const id = crypto.randomUUID()
    const firma = crypto.createHmac('sha256', SECRETO).update(CUERPO).digest('base64')
    expect((await avisar(id, firma)).status).toBe(200)
    expect(await eventos(id)).toBe(1)
    const fila = await prisma.shopifyInboundEvent.findUniqueOrThrow({ where: { dedupKey: id } })
    expect(fila).toMatchObject({ appKey: 'PILOTO', topic: 'inventory_levels/update', shopDomain: e.shopDomain, status: 'RECEIVED' })
    expect(fila.payload).toEqual({ inventory_item_id: 1, location_id: 1 }) // `available` no lo lee nadie: se relee de Shopify

    expect((await avisar(id, firma)).status).toBe(200)
    expect(await eventos(id)).toBe(1)
  })

  it('mal firmado ⇒ 401 y ninguna fila', async () => {
    const id = crypto.randomUUID()
    const ajena = crypto.createHmac('sha256', 'otro-secreto').update(CUERPO).digest('base64')
    expect((await avisar(id, ajena)).status).toBe(401)
    expect(await eventos(id)).toBe(0)
  })
})

describe('L3 / L1: el callback OAuth por la app real', () => {
  async function intent(): Promise<{ id: string; state: string }> {
    const i = await prisma.shopifyConnectIntent.create({
      data: {
        venueId: e.venueId,
        authUserId: e.staffId,
        shopDomain: e.shopDomain,
        appKey: 'PILOTO',
        purpose: 'CONNECT',
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
      select: { id: true },
    })
    return { id: i.id, state: signIntentId(i.id) }
  }
  /** Firma como la biblioteca oficial de Shopify: valores codificados (el `==` del host va como `%3D%3D`). */
  const firmaOficial = (state: string) =>
    crypto
      .createHmac('sha256', SECRETO)
      .update(`code=c1&host=${HOST.replace(/=/g, '%3D')}&shop=${e.shopDomain}&state=${state}&timestamp=1700000000`)
      .digest('hex')
  const consulta = (state: string, hmac: string) =>
    `code=c1&host=${encodeURIComponent(HOST)}&shop=${e.shopDomain}&state=${encodeURIComponent(state)}&timestamp=1700000000&hmac=${hmac}`
  const estado = async (id: string) => (await prisma.shopifyConnectIntent.findUniqueOrThrow({ where: { id } })).status

  // El segundo caso es el que muerde (preflight-C D2): si la ruta descartara los arreglos, `locale` repetido —que nadie
  // firmó— desaparecería y el resto de la consulta cuadraría.
  it.each([
    ['shop repetido', '&shop=otra.myshopify.com'],
    ['un parámetro sin firmar, repetido', '&locale=es&locale=en'],
  ])('🔴 T7: %s ⇒ ?error=FIRMA por el servicio real; el intent no se gasta ni se canjea nada', async (_caso, extra) => {
    // Con implementación propia: si una regresión dejara pasar la firma, nunca se sale a la red real de Shopify.
    const canje = jest
      .spyOn(graphql, 'exchangeOAuthCode')
      .mockResolvedValue({ ok: false, code: 'HTTP_4XX', retryable: false, ambiguous: false, message: 'prueba' })
    const { id, state } = await intent()
    const r = await request(app).get(`${CALLBACK}?${consulta(state, firmaOficial(state))}${extra}`)
    expect(r.status).toBe(303)
    expect(r.headers.location).toContain('?error=FIRMA')
    expect(await estado(id)).toBe('CREATED')
    expect(canje).not.toHaveBeenCalled()
  })

  it('🔴 L1: host con == firmado en la forma oficial pasa la firma y llega al canje (que aquí falla a propósito)', async () => {
    const canje = jest
      .spyOn(graphql, 'exchangeOAuthCode')
      .mockResolvedValue({ ok: false, code: 'HTTP_4XX', retryable: false, ambiguous: false, message: 'prueba' })
    const { id, state } = await intent()
    ;(logger.info as jest.Mock).mockClear()
    const r = await request(app).get(`${CALLBACK}?${consulta(state, firmaOficial(state))}`)
    expect(r.status).toBe(303)
    expect(r.headers.location).toContain('?error=INTERCAMBIO') // pasó FIRMA y TIENDA
    expect(canje).toHaveBeenCalledWith(e.shopDomain, 'PILOTO', 'c1')
    expect(await estado(id)).toBe('FAILED')
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).toContain('forma codificada')
  })
})
