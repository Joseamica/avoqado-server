// tests/unit/routes/shopify.webhook.app.test.ts
/**
 * 🔴 Un products/update con muchas variantes pasa de los 100 KB del router genérico de webhooks: si la ruta de Shopify no
 * va ANTES con su propio `express.raw` de 1 MB, el aviso muere con 413 y Shopify lo reintenta 8 veces en 4 h sin éxito.
 * La prueba firma el cuerpo como Shopify (HMAC-SHA256 base64) y el manejador lo verifica con la función real de A: si
 * alguien re-serializara el cuerpo o lo parseara como JSON, la firma dejaría de cuadrar.
 * Contra la app REAL: el orden de montaje es lo que se prueba (#35). La persistencia real va en
 * tests/integration/shopify/webhook-app.integration.test.ts (S1).
 */
import crypto from 'crypto'
import request from 'supertest'

const mockHandle = jest.fn()
jest.mock('@/services/commerce-channels/shopify/shopify.inbound.service', () => ({
  ...jest.requireActual('@/services/commerce-channels/shopify/shopify.inbound.service'),
  handleShopifyWebhook: (req: any, res: any) => mockHandle(req, res),
}))
const mockCallback = jest.fn()
jest.mock('@/services/commerce-channels/shopify/shopify.connect.service', () => ({
  ...jest.requireActual('@/services/commerce-channels/shopify/shopify.connect.service'),
  handleShopifyCallback: (...a: unknown[]) => mockCallback(...a),
}))

import app from '../../../src/app'
import { verifyWebhookHmac } from '@/services/commerce-channels/shopify/shopify.crypto'

const SECRETO = 'shpss_prueba_de_firma'
const firma = (cuerpo: string) => crypto.createHmac('sha256', SECRETO).update(cuerpo, 'utf8').digest('base64')
/** Un producto con N variantes, como lo manda Shopify (JSON con su propio orden de campos). */
function productoCon(bytes: number): string {
  const variantes = Array.from({ length: Math.ceil(bytes / 50) }, (_, i) => ({ id: 1_000_000 + i, sku: `CAM-${i}`, title: 'Talla M' }))
  return JSON.stringify({ id: 42, title: 'Camisa', variants: variantes })
}
const avisar = (cuerpo: string) =>
  request(app)
    .post('/api/v1/webhooks/shopify/piloto')
    .set('Content-Type', 'application/json')
    .set('X-Shopify-Topic', 'products/update')
    .set('X-Shopify-Shop-Domain', 'mi-tienda.myshopify.com')
    .set('X-Shopify-Webhook-Id', 'wh-prueba-1')
    .set('X-Shopify-Hmac-SHA256', firma(cuerpo))
    .send(cuerpo)

beforeEach(() => {
  jest.clearAllMocks()
  mockHandle.mockImplementation((req: any, res: any) => {
    const integro = Buffer.isBuffer(req.body) && verifyWebhookHmac(req.body, req.get('X-Shopify-Hmac-SHA256'), SECRETO)
    res.status(integro ? 200 : 401).json({ integro, bytes: Buffer.isBuffer(req.body) ? req.body.length : null, appKey: req.params.appKey })
  })
})

describe('webhook y callback públicos de Shopify', () => {
  it('🔴 un aviso firmado de más de 100 KB llega entero y crudo (no lo corta el router genérico)', async () => {
    const cuerpo = productoCon(150 * 1024)
    expect(Buffer.byteLength(cuerpo)).toBeGreaterThan(100 * 1024)
    const r = await avisar(cuerpo)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ integro: true, bytes: Buffer.byteLength(cuerpo), appKey: 'piloto' })
    expect(mockHandle).toHaveBeenCalledTimes(1)
    expect(r.headers['x-correlation-id']).toBeTruthy() // bajo el logger de /api/v1/webhooks (contexto §7)
  })

  it('más de 1 MB ⇒ 413 sin llegar al manejador', async () => {
    const r = await avisar(productoCon(1100 * 1024))
    expect(r.status).toBe(413)
    expect(r.body.code).toBe('PAYLOAD_TOO_LARGE')
    expect(mockHandle).not.toHaveBeenCalled()
  })

  it('callback: 303 a la URL que decide el servicio, con el query tal cual llegó', async () => {
    mockCallback.mockResolvedValue('https://dashboard.test/venues/tienda/settings/integrations/shopify?intent=abc')
    const r = await request(app).get('/api/v1/shopify/oauth/callback?code=c1&shop=mi-tienda.myshopify.com&state=s1&hmac=h1&timestamp=1')
    expect(r.status).toBe(303)
    expect(r.headers.location).toBe('https://dashboard.test/venues/tienda/settings/integrations/shopify?intent=abc')
    expect(mockCallback).toHaveBeenCalledWith({ code: 'c1', shop: 'mi-tienda.myshopify.com', state: 's1', hmac: 'h1', timestamp: '1' })
    expect(r.headers['x-correlation-id']).toBeTruthy() // logger explícito: la ruta va antes de configureCoreMiddlewares
  })

  it('🔴 T7: un parámetro repetido llega SIN TOCAR al servicio (es él quien lo rechaza con FIRMA)', async () => {
    mockCallback.mockResolvedValue('https://dashboard.test/?error=FIRMA')
    await request(app).get('/api/v1/shopify/oauth/callback?code=c1&shop=a.myshopify.com&shop=b.myshopify.com&state=s1&hmac=h1')
    expect(mockCallback).toHaveBeenCalledWith({ code: 'c1', shop: ['a.myshopify.com', 'b.myshopify.com'], state: 's1', hmac: 'h1' })
  })

  it('callback: si el servicio truena, página en español con 500 y sin filtrar el error', async () => {
    mockCallback.mockRejectedValue(new Error('detalle interno que no debe salir'))
    const r = await request(app).get('/api/v1/shopify/oauth/callback?code=c1&state=s1')
    expect(r.status).toBe(500)
    expect(r.text).toContain('No pudimos terminar la conexión con Shopify')
    expect(r.text).not.toContain('detalle interno')
  })
})
