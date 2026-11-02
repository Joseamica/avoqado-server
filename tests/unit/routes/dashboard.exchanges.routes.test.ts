import dashboardRouter from '@/routes/dashboard.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import express from 'express'
import request from 'supertest'

const mockList = jest.fn().mockResolvedValue({ total: 0, items: [] })
const mockReview = jest.fn().mockResolvedValue({ id: 'exchange-id' })
jest.mock('@/services/dashboard/exchange.dashboard.service', () => ({
  listExchangesForReview: (...a: any[]) => mockList(...a),
  markExchangeReviewed: (...a: any[]) => mockReview(...a),
}))

describe('dashboard exchange routes', () => {
  it.each([
    ['get', '/venues/:venueId/exchanges', 'payments:read'],
    ['post', '/venues/:venueId/exchanges/:exchangeId/review', 'payments:refund'],
  ])('requires authentication and %s %s permission %s', (method, path, permission) => {
    const layer = (dashboardRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method])
    expect(layer).toBeDefined()
    const handlers = layer.route.stack.map((l: any) => l.handle)
    expect(handlers).toContain(authenticateTokenMiddleware)
    expect(handlers.find((h: any) => h.requiredPermission)?.requiredPermission).toBe(permission)
  })

  it('mounts real input validation and the controller after the authorization gates', async () => {
    const app = express()
    app.use(express.json())
    for (const method of ['get', 'post']) {
      const path = method === 'get' ? '/venues/:venueId/exchanges' : '/venues/:venueId/exchanges/:exchangeId/review'
      const layer = (dashboardRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method])
      const handlers = layer.route.stack.map((l: any) => l.handle)
      // Auth and permission are inspected above; exercise the mounted validation and controller here.
      ;(app as any)[method](
        path,
        (req: any, _res: any, next: any) => {
          req.authContext = { userId: 'manager-id' }
          next()
        },
        ...handlers.slice(2),
      )
    }
    app.use((e: any, _req: any, res: any, _next: any) => res.status(e.statusCode ?? 500).json({ message: e.message }))
    expect((await request(app).post('/venues/route-venue/exchanges/exchange-id/review').send({ note: 'ab' })).status).toBe(400)
    expect(mockReview).not.toHaveBeenCalled()
    expect((await request(app).post('/venues/route-venue/exchanges/exchange-id/review').send({ note: 'Checked' })).status).toBe(200)
    expect(mockReview).toHaveBeenCalledWith({ venueId: 'route-venue', exchangeId: 'exchange-id', staffId: 'manager-id', note: 'Checked' })
    expect((await request(app).get('/venues/route-venue/exchanges?pendingReview=false&limit=999')).status).toBe(200)
    expect(mockList).toHaveBeenCalledWith({ venueId: 'route-venue', pendingReview: false, limit: 100, offset: 0 })
  })
})
