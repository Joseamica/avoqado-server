import express from 'express'
import request from 'supertest'
import type { NextFunction, Request, Response } from 'express'

const mockSteps: string[] = []
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (_req: Request, _res: Response, next: NextFunction) => {
    mockSteps.push('auth')
    next()
  },
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (permission: string) =>
    Object.assign(
      (_req: Request, _res: Response, next: NextFunction) => {
        mockSteps.push(permission)
        next()
      },
      { requiredPermission: permission },
    ),
}))
jest.mock('@/services/mobile/recentSales.mobile.service', () => ({ listRecentSales: jest.fn() }))

import mobileRouter from '@/routes/mobile.routes'
import * as service from '@/services/mobile/recentSales.mobile.service'
import * as controller from '@/controllers/mobile/transaction.mobile.controller'
import { validateRequest } from '@/middlewares/validation'
import { recentSalesQuerySchema, encodeSalesCursor } from '@/schemas/mobile/recentSales.mobile.schema'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'

const venueId = 'c1234567890123456789012345'
const url = `/api/v1/mobile/venues/${venueId}/sales/recent`
const app = express()
app.use('/api/v1/mobile', mobileRouter)
app.use((error: { statusCode?: number; message: string }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.statusCode ?? 500).json({ message: error.message })
})
const result = { sales: [{ orderId: 'sale' }], removed: ['old'], meta: { mode: 'FULL', total: 1, limit: 100, hasMore: false } }
beforeEach(() => {
  jest.clearAllMocks()
  mockSteps.length = 0
  jest.mocked(service.listRecentSales).mockResolvedValue(result as never)
})

describe('mobile recent sales route', () => {
  it('runs authentication, payments:read, validation and the recent sales controller in order', async () => {
    const route = (mobileRouter as any).stack.find((layer: any) => layer.route?.path === '/venues/:venueId/sales/recent')?.route
    expect(route).toBeDefined()
    const handlers = route.stack.map((layer: any) => layer.handle)
    expect(handlers).toHaveLength(4)
    expect(handlers[0]).toBe(authenticateTokenMiddleware)
    expect(handlers[1].requiredPermission).toBe('payments:read')
    expect(handlers[2].toString()).toBe(validateRequest(recentSalesQuerySchema).toString())
    expect(handlers[3]).toBe(controller.listRecentSales)
    await request(app).get(url).expect(200)
    expect(mockSteps).toEqual(['auth', 'payments:read'])
  })
  it('answers 200 with the service payload and parsed bounded query', async () => {
    const response = await request(app).get(`${url}?limit=500`).expect(200)
    expect(response.body).toEqual({ success: true, data: { sales: result.sales, removed: result.removed }, meta: result.meta })
    expect(service.listRecentSales).toHaveBeenCalledWith({ venueId, limit: 100 })
  })
  it('rejects since and cursor together without calling the service', async () => {
    const cursor = encodeSalesCursor({ v: 1, m: 'F', t0: 1, ws: 1, w: null, ws0: null, total: 1, at: 1, id: 'id' })
    const response = await request(app).get(url).query({ since: 'stamp', cursor }).expect(400)
    expect(response.body.message).toContain('Manda since o cursor, no los dos.')
    expect(service.listRecentSales).not.toHaveBeenCalled()
  })
  it('forwards service errors to the application error handler', async () => {
    jest.mocked(service.listRecentSales).mockRejectedValue(Object.assign(new Error('No se encontró la sucursal.'), { statusCode: 404 }))
    expect((await request(app).get(url).expect(404)).body.message).toBe('No se encontró la sucursal.')
  })
})
