/**
 * Task 7 (plan `docs/superpowers/plans/2026-08-20-delivery-nucleo-unico.md`, §8.1):
 * delivery directo es PREMIUM (decisión founder 2026-08-20).
 *
 * El candado en sí YA existía: `checkFeatureAccess('DELIVERY_CHANNELS')` en
 * delivery-channels.routes.ts, con 'DELIVERY_CHANNELS' ya en PREMIUM_ONLY_CODES
 * (basePlan.service.ts, comentario "2026-07-18") — así que ya usa el resolver de
 * FEATURE (`venueHasFeatureAccess`/tier), JAMÁS el de Module
 * (`moduleService.isModuleEnabled`), que es la trampa que documenta
 * `.claude/rules/feature-gating.md` (cruzarlos "pasa" en silencio para casi todos
 * los venues de prod, que están grandfathered).
 *
 * Lo que faltaba y es lo que prueba este archivo: el 403 que hoy produce
 * `checkFeatureAccess` es inglés genérico ("Please subscribe to enable this
 * feature"), sin decir QUÉ plan hace falta ni CÓMO activarlo, y sin un `code`
 * máquina-legible — y seis clientes distintos (dashboard, superadmin, TPV,
 * Android, iOS, desktop) consumen esta API y cada uno tendría que inventarse el
 * texto. `delivery-channels.routes.ts` ahora envuelve `checkFeatureAccess` con
 * `withDeliveryPremiumMessage`, que reescribe SOLO el cuerpo del 403 — el gate en
 * sí (SUPERADMIN, exención grandfathered/demo, tier) sigue siendo 100% de
 * `checkFeatureAccess`, sin reimplementarlo.
 *
 * Patrón de test: mini Express app montando el router REAL (mirrors
 * tests/unit/routes/deliveryChannels.routes.permissions.test.ts), con
 * checkFeatureAccess MOCKEADO de forma controlable por test para simular sus
 * CUATRO ramas reales (permitido, no-activa, trial vencido, suspendido) sin
 * depender de los defaults del mock global de Prisma — lo que se prueba aquí es
 * la envoltura que reescribe la respuesta, no el resolver de tier en sí.
 */

import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

// 1. Auth: siempre autenticado (no es lo que se prueba aquí).
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    req.authContext = { userId: 'user-1', orgId: 'org-1', venueId: 'venue-test-1', role: 'ADMIN' }
    next()
  },
}))

// 2. Permisos: siempre permitidos (no es lo que se prueba aquí; ver
//    deliveryChannels.routes.permissions.test.ts para eso).
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))

// 3. Feature gate: controlable por test vía `featureGateBehavior`, con los
//    cuerpos EXACTOS que hoy produce checkFeatureAccess.middleware.ts para cada
//    rama (ver src/middlewares/checkFeatureAccess.middleware.ts:117-190).
type GateBehavior = 'ALLOW' | 'DENY' | 'TRIAL_EXPIRED' | 'SUSPENDED'
let featureGateBehavior: GateBehavior = 'ALLOW'

jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  checkFeatureAccess: (featureCode: string) => (_req: any, res: any, next: any) => {
    if (featureGateBehavior === 'ALLOW') return next()

    if (featureGateBehavior === 'TRIAL_EXPIRED') {
      return res.status(403).json({
        error: 'Feature trial expired',
        message: `Your trial for Delivery Channels has expired. Please add a payment method to continue using this feature.`,
        featureCode,
        featureName: 'Delivery Channels',
        trialExpired: true,
        expirationDate: new Date('2026-01-01').toISOString(),
      })
    }

    if (featureGateBehavior === 'SUSPENDED') {
      return res.status(403).json({
        error: 'Subscription suspended',
        message: `Your subscription for Delivery Channels has been suspended due to payment failure. Please update your payment method to restore access.`,
        featureCode,
        featureName: 'Delivery Channels',
        suspended: true,
        suspendedAt: new Date('2026-01-01').toISOString(),
        gracePeriodEndsAt: null,
        paymentFailureCount: 3,
      })
    }

    // DENY plano — el cuerpo REAL que produce hoy checkFeatureAccess.middleware.ts
    // cuando el venue no tiene la feature ni por tier.
    return res.status(403).json({
      error: 'Feature not available',
      message: `This venue does not have access to the ${featureCode} feature. Please subscribe to enable this feature.`,
      featureCode,
      subscriptionRequired: true,
    })
  },
}))

// 4. Controllers: no es lo que se prueba — cada handler responde 200 con un marcador.
const controllerProxy = () =>
  new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : (_req: any, res: any) => res.json({ handler: String(prop) })) })
jest.mock('@/controllers/delivery-channels/deliveryChannels.controller', () => controllerProxy())

// ─── Import router DESPUÉS de los mocks ────────────────────────────────────────
import deliveryChannelsRouter from '@/routes/delivery-channels.routes'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/delivery-channels', deliveryChannelsRouter)
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.statusCode || 500).json({ error: err?.message || 'error' })
  })
  return app
}

const VENUE_ID = 'venue-test-1'
const LINK_ID = 'link-test-1'

// UN server para todo el archivo — mismo motivo que deliveryChannels.routes.permissions.test.ts:
// pasarle la *app* a supertest hace bind/close de un puerto efímero por request.
let server: Server

beforeAll(() => {
  server = createApp().listen(0)
})

afterAll(done => {
  server.close(done)
})

beforeEach(() => {
  featureGateBehavior = 'ALLOW'
})

describe('delivery-channels.routes — Task 7: gating PREMIUM con 403 accionable en español', () => {
  it('un venue SIN PREMIUM recibe 403 con mensaje en ESPAÑOL que menciona PREMIUM, y un `code`', async () => {
    featureGateBehavior = 'DENY'
    const res = await request(server).get(`/delivery-channels/venues/${VENUE_ID}/channels`)

    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/PREMIUM/)
    expect(res.body.code).toBeDefined()
    expect(res.body.code).toBe('PLAN_REQUIRED')
    // Ya no es el genérico en inglés — si esto falla, el mensaje no se reescribió.
    expect(res.body.message).not.toMatch(/subscribe/i)
  })

  it('el mensaje dice CÓMO activarlo: quién lo hace y dónde', async () => {
    featureGateBehavior = 'DENY'
    const res = await request(server).get(`/delivery-channels/venues/${VENUE_ID}/channels`)

    expect(res.body.message).toMatch(/dashboard/i)
    expect(res.body.message).toMatch(/dueñ[oa]/i)
  })

  it('conserva featureCode para no romper a clientes que ya lean ese campo', async () => {
    featureGateBehavior = 'DENY'
    const res = await request(server).get(`/delivery-channels/venues/${VENUE_ID}/channels`)
    expect(res.body.featureCode).toBe('DELIVERY_CHANNELS')
  })

  it('trial vencido: también en español, con su propio `code`', async () => {
    featureGateBehavior = 'TRIAL_EXPIRED'
    const res = await request(server).get(`/delivery-channels/venues/${VENUE_ID}/channels`)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('TRIAL_EXPIRED')
    expect(res.body.message).toMatch(/PREMIUM|prueba/i)
    expect(res.body.message).not.toMatch(/Please add a payment method/i)
  })

  it('suscripción suspendida: también en español, con su propio `code`', async () => {
    featureGateBehavior = 'SUSPENDED'
    const res = await request(server).get(`/delivery-channels/venues/${VENUE_ID}/channels`)

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('SUBSCRIPTION_SUSPENDED')
    expect(res.body.message).toMatch(/pago|suspend/i)
    expect(res.body.message).not.toMatch(/Please update your payment method/i)
  })

  it('REGRESIÓN: un venue CON PREMIUM sigue recibiendo 200 normal — la envoltura no toca el camino feliz', async () => {
    featureGateBehavior = 'ALLOW'
    const res = await request(server).get(`/delivery-channels/venues/${VENUE_ID}/channels`)
    expect(res.status).toBe(200)
  })

  it('aplica igual en las otras rutas del router (POST/PATCH channels, pause, activation-request, summary)', async () => {
    featureGateBehavior = 'DENY'
    const calls: Array<[string, string, object?]> = [
      ['post', `/delivery-channels/venues/${VENUE_ID}/channels`, { provider: 'DELIVERECT', externalLocationId: 'loc-123' }],
      ['patch', `/delivery-channels/venues/${VENUE_ID}/channels/${LINK_ID}`, { orderAcceptanceMode: 'MANUAL' }],
      ['post', `/delivery-channels/venues/${VENUE_ID}/channels/${LINK_ID}/pause`, { paused: true }],
      ['post', `/delivery-channels/venues/${VENUE_ID}/activation-request`, { requestedChannels: ['RAPPI'] }],
      ['get', `/delivery-channels/venues/${VENUE_ID}/activation-request`],
      ['get', `/delivery-channels/venues/${VENUE_ID}/delivery/summary`],
    ]

    for (const [method, path, body] of calls) {
      const req = (request(server) as any)[method](path)
      const res = await (body ? req.send(body) : req)
      expect(res.status).toBe(403)
      expect(res.body.code).toBeDefined()
      expect(res.body.message).toMatch(/PREMIUM/)
    }
  })
})
