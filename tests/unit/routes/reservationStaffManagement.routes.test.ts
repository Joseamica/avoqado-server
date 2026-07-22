import express from 'express'
import request from 'supertest'

const checkedPermissions: string[] = []
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (permission: string) => (req: any, res: any, next: any) => {
    checkedPermissions.push(permission)
    if (req.headers['x-test-permission'] === permission) return next()
    return res.status(403).json({ permission })
  },
}))

jest.mock(
  '@/controllers/dashboard/reservation.dashboard.controller',
  () =>
    new Proxy(
      {},
      {
        get: (_target, property) =>
          property === '__esModule'
            ? true
            : (req: any, res: any) => res.json({ handler: String(property), params: req.params, body: req.body }),
      },
    ),
)
jest.mock('@/services/dashboard/reservationWaitlist.service', () => new Proxy({}, { get: () => jest.fn() }))
jest.mock('@/services/dashboard/reservationSettings.service', () => new Proxy({}, { get: () => jest.fn() }))

import reservationRoutes from '@/routes/dashboard/reservation.routes'

const weekly = {
  monday: { enabled: false, ranges: [] },
  tuesday: { enabled: false, ranges: [] },
  wednesday: { enabled: false, ranges: [] },
  thursday: { enabled: false, ranges: [] },
  friday: { enabled: false, ranges: [] },
  saturday: { enabled: false, ranges: [] },
  sunday: { enabled: false, ranges: [] },
}

function app() {
  const server = express()
  server.use(express.json())
  server.use('/venues/:venueId/reservations', reservationRoutes)
  server.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode ?? 400).json({ message: error.message }))
  return server
}

describe('reservation staff-management routes', () => {
  beforeEach(() => {
    checkedPermissions.length = 0
  })

  it.each([
    ['get', '/venues/venue-1/reservations/staff/sv-1/schedule', 'teams:read', undefined, 'getStaffSchedule'],
    ['put', '/venues/venue-1/reservations/staff/sv-1/schedule', 'teams:update', { weekly, exceptions: [] }, 'replaceStaffSchedule'],
    ['get', '/venues/venue-1/reservations/products/product-1/staff', 'menu:read', undefined, 'getProductStaff'],
    ['put', '/venues/venue-1/reservations/products/product-1/staff', 'menu:update', { staffVenueIds: [] }, 'replaceProductStaff'],
  ])('%s %s uses exact existing permission and is not shadowed by /:id', async (method, url, permission, body, handler) => {
    const call = (request(app()) as any)[method](url).set('x-test-permission', permission)
    const response = body === undefined ? await call : await call.send(body)
    expect(response.status).toBe(200)
    expect(response.body.handler).toBe(handler)
    expect(checkedPermissions).toEqual([permission])
  })

  it('validates PUT params and bodies before the handler', async () => {
    const missingBody = await request(app())
      .put('/venues/venue-1/reservations/staff/sv-1/schedule')
      .set('x-test-permission', 'teams:update')
      .send({ exceptions: [] })
    const emptyMembership = await request(app())
      .put('/venues/venue-1/reservations/products/product-1/staff')
      .set('x-test-permission', 'menu:update')
      .send({ staffVenueIds: [''] })
    expect(missingBody.status).toBe(400)
    expect(emptyMembership.status).toBe(400)
  })
})
