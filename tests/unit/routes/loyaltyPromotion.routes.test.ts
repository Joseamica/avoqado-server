/**
 * Rutas del panel de promociones de lealtad (Task 9): permiso EXACTO por ruta (introspección del router REAL del dashboard) y el
 * candado de plan: cuelgan del mismo `router.use('/venues/:venueId/loyalty', …, checkFeatureAccess('LOYALTY_PROGRAM'))` que el
 * resto de lealtad, así que un negocio sin PRO recibe el MISMO 403 que en `/loyalty/config`.
 */
import express from 'express'
import request from 'supertest'
import { prismaMock } from '../../__helpers__/setup'
import dashboardRouter from '@/routes/dashboard.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'

const P = '/venues/:venueId/loyalty/promotions'
const stack: any[] = (dashboardRouter as any).stack

const capaDe = (method: string, path: string) => stack.findIndex(l => l.route?.path === path && l.route.methods[method])

describe('rutas de promociones de lealtad', () => {
  it.each([
    ['get', P, 'loyalty:read'],
    ['post', P, 'loyalty:update'],
    ['patch', `${P}/:id`, 'loyalty:update'],
    ['post', `${P}/:id/end`, 'loyalty:update'],
  ])('%s %s exige sesión y %s', (method, path, permiso) => {
    const i = capaDe(method, path)
    expect(i).toBeGreaterThan(-1)
    const handlers = stack[i].route.stack.map((l: any) => l.handle)
    expect(handlers).toContain(authenticateTokenMiddleware)
    expect(handlers.find((h: any) => h.requiredPermission)?.requiredPermission).toBe(permiso)
  })

  it('sin plan PRO → 403 con el mensaje de plan (el mismo que el resto de lealtad)', async () => {
    // El candado de plan es la capa `use` (no ruta, no sub-router) que cubre la URL y va ANTES de las rutas de promociones.
    const capas = [
      ['get', P],
      ['post', P],
      ['patch', `${P}/:id`],
      ['post', `${P}/:id/end`],
    ].map(([m, p]) => capaDe(m, p))
    expect(Math.min(...capas)).toBeGreaterThan(-1)
    const primera = Math.min(...capas)
    const candados = stack
      .slice(0, primera)
      .filter(l => !l.route && !l.handle.stack && l.handle !== authenticateTokenMiddleware && l.match('/venues/v1/loyalty/promotions'))
    expect(candados).toHaveLength(1)

    const app = express()
    app.use((req: any, _res, next) => {
      req.authContext = { userId: 'u1', venueId: 'v1', orgId: 'o1', role: 'OWNER' }
      next()
    })
    app.use('/venues/:venueId/loyalty', candados[0].handle)
    app.use((_req, res) => res.json({ ok: true }))

    prismaMock.staffVenue.findFirst.mockResolvedValue(null) // no es superadmin
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
    prismaMock.venueFeature.findFirst.mockResolvedValue(null)
    prismaMock.venueFeature.findMany.mockResolvedValue([]) // sin plan

    const promos = await request(app).get('/venues/v1/loyalty/promotions')
    const config = await request(app).get('/venues/v1/loyalty/config')
    expect(promos.status).toBe(403)
    expect(promos.body).toMatchObject({ featureCode: 'LOYALTY_PROGRAM', subscriptionRequired: true })
    expect(promos.body).toEqual(config.body)

    // Control: con PRO pasa (es el candado de LOYALTY_PROGRAM, no otro).
    prismaMock.venueFeature.findMany.mockResolvedValue([{ active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }])
    expect((await request(app).post('/venues/v1/loyalty/promotions/x/end')).status).toBe(200)
  })
})
