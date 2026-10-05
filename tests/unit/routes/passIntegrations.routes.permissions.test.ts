// tests/unit/routes/passIntegrations.routes.permissions.test.ts
import express from 'express'
import request from 'supertest'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    req.authContext = { userId: 'u1', venueId: 'v1', role: 'ADMIN' }
    next()
  },
}))
// Registra también el venue que ve el permiso: corre DESPUÉS de validateRequest, que reasigna req.params; si un esquema
// perdiera venueId, el permiso real caería al venue del token y el servicio recibiría undefined.
const mockCheckPermission = jest.fn()
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (perm: string) => (req: any, res: any, next: any) => {
    mockCheckPermission(perm, req.params.venueId)
    const allowed = req.headers['x-test-allow-permission']
    if (allowed === perm || allowed === '*') return next()
    return res.status(403).json({ error: 'Forbidden', required: perm })
  },
}))
const order: string[] = []
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  checkFeatureAccess: (code: string) => (req: any, res: any, next: any) => {
    order.push(`feature:${code}`)
    // Para probar el mensaje del plan: simula el 403 real de checkFeatureAccess (inglés, con featureCode).
    const denied = req.headers['x-test-feature-denied']
    if (denied) {
      return res.status(403).json({
        error: 'Feature not available',
        message: 'Please subscribe to enable this feature.',
        featureCode: code,
        ...(denied === 'trial' ? { trialExpired: true } : {}),
        ...(denied === 'suspended' ? { suspended: true } : {}),
      })
    }
    next()
  },
}))
jest.mock(
  '@/controllers/dashboard/passIntegrations.controller',
  () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === '__esModule' ? true : (req: any, res: any) => res.json({ handler: String(prop), venueId: req.params.venueId }),
      },
    ),
)
import passIntegrationsRouter from '@/routes/dashboard/passIntegrations.routes'

const app = express()
app.use(express.json())
app.use('/venues/:venueId/pass-integrations', passIntegrationsRouter)
const KEY = '11111111-2222-4333-8444-555555555555'

describe('rutas de pases: permiso exacto por acción', () => {
  beforeEach(() => {
    mockCheckPermission.mockClear()
    order.length = 0
  })
  it.each([
    ['get', '/venues/v1/pass-integrations', undefined, 'reservations:read', 'getOverview', false],
    [
      'post',
      '/venues/v1/pass-integrations/totalpass/connect',
      { placeApiKey: KEY },
      'reservations:manage-passes',
      'connectTotalPass',
      true,
    ],
    [
      'put',
      '/venues/v1/pass-integrations/totalpass/confirm-mode',
      { confirmMode: 'AUTO' },
      'reservations:manage-passes',
      'setConfirmMode',
      true,
    ],
    ['put', '/venues/v1/pass-integrations/totalpass/products', { links: [] }, 'reservations:manage-passes', 'setProductLinks', true],
    ['post', '/venues/v1/pass-integrations/totalpass/disconnect', {}, 'reservations:manage-passes', 'disconnect', false],
    ['get', '/venues/v1/pass-integrations/capacity', undefined, 'reservations:read', 'getCapacity', true],
    ['put', '/venues/v1/pass-integrations/capacity/default', { maxSpots: 3 }, 'reservations:manage-passes', 'setDefaultCap', true],
    [
      'post',
      '/venues/v1/pass-integrations/capacity/weekly',
      { weekday: 6, startMinute: 540, maxSpots: 1 },
      'reservations:manage-passes',
      'upsertWeeklyCap',
      true,
    ],
    ['delete', '/venues/v1/pass-integrations/capacity/rules/r1', undefined, 'reservations:manage-passes', 'deleteRule', true],
    ['put', '/venues/v1/pass-integrations/capacity/sessions/s1', { maxSpots: null }, 'reservations:manage-passes', 'setSessionCap', true],
    // C1 (pausa suave): las visitas que ya existen se ven y se resuelven sin el plan; sólo el permiso.
    ['get', '/venues/v1/pass-integrations/visits?status=PENDING', undefined, 'reservations:read', 'listVisits', false],
    ['get', '/venues/v1/pass-integrations/visits/summary?month=2030-01', undefined, 'reservations:read', 'visitsSummary', false],
    ['post', '/venues/v1/pass-integrations/visits/vis1/confirm', {}, 'reservations:update', 'confirmVisit', false],
    ['post', '/venues/v1/pass-integrations/visits/vis1/reject', {}, 'reservations:update', 'rejectVisit', false],
  ])('%s %s %j exige %s (→ %s; plan AGGREGATOR_PASSES después del permiso: %s)', async (method, url, body, perm, handler, plan) => {
    const ok = await (request(app) as any)[method](url).set('x-test-allow-permission', perm).send(body)
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ handler, venueId: 'v1' }) // el controller recibe el venue de la URL ya validado
    expect(mockCheckPermission).toHaveBeenCalledWith(perm, 'v1')
    // revisión final — F3: desconectar no pasa por el candado del plan (quien lo perdió siempre puede apagarlo)
    expect(order).toEqual(plan ? ['feature:AGGREGATOR_PASSES'] : [])
    order.length = 0
    const denied = await (request(app) as any)[method](url).set('x-test-allow-permission', 'otro:permiso').send(body)
    expect(denied.status).toBe(403)
    expect(order).toEqual([]) // un no autorizado no llega al gate de plan (no se filtra el estado del plan)
  })
  // revisión final — F3: un negocio que perdió el plan (bajó a Gratis, prueba vencida, pago fallido) aún puede apagar la
  // integración; si no, TotalPass le seguiría mandando socios y la única salida sería el portal del proveedor
  it('sin el plan, desconectar igual llega al controller (con el permiso de administrar pases)', async () => {
    const r = await request(app)
      .post('/venues/v1/pass-integrations/totalpass/disconnect')
      .set('x-test-allow-permission', 'reservations:manage-passes')
      .set('x-test-feature-denied', 'plan')
      .send({})
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ handler: 'disconnect', venueId: 'v1' })
    const sinPermiso = await request(app)
      .post('/venues/v1/pass-integrations/totalpass/disconnect')
      .set('x-test-allow-permission', 'reservations:read')
      .send({})
    expect(sinPermiso.status).toBe(403)
  })
  // nuevo — R62 (pausa suave): sin el plan el resumen se sigue leyendo, para que el estudio vea que sus clases ya no se
  // publican (`planActive: false`) y tenga a la mano Desconectar; el permiso de lectura sigue exigiéndose
  it('sin el plan, el resumen igual llega al controller (con el permiso de lectura)', async () => {
    const r = await request(app)
      .get('/venues/v1/pass-integrations')
      .set('x-test-allow-permission', 'reservations:read')
      .set('x-test-feature-denied', 'plan')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ handler: 'getOverview', venueId: 'v1' })
    const sinPermiso = await request(app).get('/venues/v1/pass-integrations').set('x-test-allow-permission', 'otro:permiso')
    expect(sinPermiso.status).toBe(403)
    expect(sinPermiso.body).toEqual({ error: 'Forbidden', required: 'reservations:read' })
  })
  // C1 (P1-1) — decisión del founder: al perder el plan «lo ya reservado se respeta y se valida». En ON_VENUE_CHECKIN una
  // visita sin reserva sólo se confirma a mano: con el candado se perdía ese cobro.
  it.each([
    ['get', '/venues/v1/pass-integrations/visits?status=PENDING', 'reservations:read', 'listVisits'],
    ['get', '/venues/v1/pass-integrations/visits/summary?month=2030-01', 'reservations:read', 'visitsSummary'],
    ['post', '/venues/v1/pass-integrations/visits/vis1/confirm', 'reservations:update', 'confirmVisit'],
    ['post', '/venues/v1/pass-integrations/visits/vis1/reject', 'reservations:update', 'rejectVisit'],
  ])('sin el plan, %s %s igual llega al controller (con %s)', async (method, url, perm, handler) => {
    const r = await (request(app) as any)[method](url).set('x-test-allow-permission', perm).set('x-test-feature-denied', 'plan').send({})
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ handler, venueId: 'v1' })
    const sinPermiso = await (request(app) as any)[method](url).set('x-test-allow-permission', 'otro:permiso').send({})
    expect(sinPermiso.status).toBe(403)
    expect(sinPermiso.body).toEqual({ error: 'Forbidden', required: perm })
  })
  // C1 — la configuración conserva el candado: sin el plan no se liga ni se cambia el modo
  it.each([
    ['put', '/venues/v1/pass-integrations/totalpass/products', { links: [] }],
    ['put', '/venues/v1/pass-integrations/totalpass/confirm-mode', { confirmMode: 'AUTO' }],
  ])('sin el plan, %s %s sigue con el candado (403 PLAN_REQUIRED)', async (method, url, body) => {
    const send = (request(app) as any)[method](url)
    const r = await send.set('x-test-allow-permission', 'reservations:manage-passes').set('x-test-feature-denied', 'plan').send(body)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('PLAN_REQUIRED')
  })
  // nuevo — Review Focus «Gerente intenta conectar»
  it('con sólo reservations:read no se puede conectar', async () => {
    const r = await request(app)
      .post('/venues/v1/pass-integrations/totalpass/connect')
      .set('x-test-allow-permission', 'reservations:read')
      .send({ placeApiKey: KEY })
    expect(r.status).toBe(403)
  })

  // nuevo — el 403 del plan dice en español qué falta y cuánto cuesta; quien lo ve puede ser un gerente que no cambia el
  // plan, así que le dice a quién pedírselo (mismo patrón que Delivery)
  const DUENO = 'Pídele al dueño del negocio que'
  it.each([
    [
      'plan',
      'PLAN_REQUIRED',
      `Los pases de TotalPass y Wellhub vienen en el plan Pro, o como función suelta a $199 MXN al mes. ${DUENO} los active desde el dashboard (Configuración → Plan).`,
    ],
    [
      'trial',
      'TRIAL_EXPIRED',
      `La prueba de los pases de TotalPass y Wellhub ya terminó. ${DUENO} los active desde el dashboard (Configuración → Plan).`,
    ],
    [
      'suspended',
      'SUBSCRIPTION_SUSPENDED',
      `Los pases están suspendidos por un pago fallido del plan. ${DUENO} actualice el método de pago desde el dashboard (Configuración → Plan).`,
    ],
  ])('sin el plan (%s) responde %s en español', async (denied, code, message) => {
    // El resumen ya no pasa por el candado (R62): el mensaje se prueba en otra lectura que sí lo lleva.
    const r = await request(app)
      .get('/venues/v1/pass-integrations/capacity')
      .set('x-test-allow-permission', 'reservations:read')
      .set('x-test-feature-denied', denied)
    expect(r.status).toBe(403)
    expect(r.body).toEqual({
      error: code,
      code,
      message,
      featureCode: 'AGGREGATOR_PASSES',
      requiredPlan: 'PRO',
    })
  })
})
