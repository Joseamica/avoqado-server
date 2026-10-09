import express from 'express'
import request from 'supertest'

// Registra el orden real: permiso (con el venue que ve, tras validateRequest) y luego el plan.
const order: string[] = []
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (perm: string) => (req: any, res: any, next: any) => {
    order.push(`perm:${perm}:${req.params.venueId}`)
    const allowed = req.headers['x-test-allow-permission']
    if (allowed === perm || allowed === '*') return next()
    return res.status(403).json({ error: 'Forbidden', required: perm })
  },
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  checkFeatureAccess: (code: string) => (_req: any, _res: any, next: any) => {
    order.push(`plan:${code}`)
    next()
  },
}))
jest.mock(
  '@/controllers/dashboard/shopify.controller',
  () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === '__esModule' ? true : (req: any, res: any) => res.json({ handler: String(prop), venueId: req.params.venueId }),
      },
    ),
)
import shopifyRouter from '@/routes/dashboard/shopify.routes'

const app = express()
app.use(express.json())
app.use('/venues/:venueId/shopify', shopifyRouter)
const INTENT = 'intent-firmado-0123456789'

describe('rutas de Shopify: permiso exacto por acción y el plan DESPUÉS del permiso', () => {
  beforeEach(() => {
    order.length = 0
  })

  it.each([
    ['get', '/', undefined, 'inventory:read', 'getOverview', false],
    ['post', '/connect/start', { shopDomain: 'mi-tienda.myshopify.com' }, 'settings:manage', 'startConnect', true],
    ['post', '/reauthorize/start', undefined, 'settings:manage', 'startReauthorize', true],
    ['get', `/connect/locations?intent=${INTENT}`, undefined, 'settings:manage', 'listLocations', true],
    ['post', '/connect/confirm', { intent: INTENT, locationId: 'gid://shopify/Location/1' }, 'settings:manage', 'confirmConnect', true],
    ['get', '/connect/review?filtro=TODOS', undefined, 'settings:manage', 'getConnectReview', false],
    ['post', '/connect/apply', undefined, 'settings:manage', 'applyConnect', true],
    ['post', '/disconnect', undefined, 'settings:manage', 'disconnect', false],
    ['post', '/resync', undefined, 'settings:manage', 'resync', true],
    ['get', '/reviews?q=camisa', undefined, 'inventory:read', 'listReviews', false],
    ['get', '/reviews/envios?ids=r1,r2', undefined, 'inventory:read', 'listReviewEnvios', false],
    [
      'post',
      '/reviews/r1/resolve',
      { choice: 'SHOPIFY', expectedAvoqadoQty: '5', expectedShopifyQty: 4 },
      'inventory:adjust',
      'resolveReview',
      true,
    ],
    ['get', '/issues?reason=SIN_SKU', undefined, 'inventory:read', 'listIssues', false],
  ] as const)('%s %s → %s', async (method, path, body, perm, handler, plan) => {
    const agent = request(app) as any
    const res = await agent[method](`/venues/v1/shopify${path}`)
      .set('x-test-allow-permission', perm)
      .send(body ?? {})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ handler, venueId: 'v1' })
    expect(order).toEqual(plan ? [`perm:${perm}:v1`, 'plan:SHOPIFY_INTEGRATION'] : [`perm:${perm}:v1`])
  })

  it('sin el permiso exacto: 403 y el plan ni se consulta (no se sondea el plan por los 403)', async () => {
    const res = await request(app)
      .post('/venues/v1/shopify/reviews/r1/resolve')
      .set('x-test-allow-permission', 'inventory:read')
      .send({ choice: 'SHOPIFY', expectedAvoqadoQty: '5', expectedShopifyQty: 4 })
    expect(res.status).toBe(403)
    expect(order).toEqual(['perm:inventory:adjust:v1'])
  })
})
