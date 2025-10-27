/*
  API tests for Superadmin routes under /api/v1/dashboard/superadmin
  Verifies:
  - 401 for unauthenticated requests
  - 403 for authenticated non-SUPERADMIN roles
  - 200/204 for SUPERADMIN when controller is mocked
*/

import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'

let app: Express
const TEST_SECRET = 'test-secret'

beforeAll(async () => {
  // Ensure required env vars are set BEFORE importing any module that relies on them
  process.env.NODE_ENV = process.env.NODE_ENV || 'test'
  process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || TEST_SECRET
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session'
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie'
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb'

  // Reset modules to apply mocks cleanly
  jest.resetModules()

  // Mock session middleware to avoid touching a real database/session store
  jest.mock('@/config/session', () => ({
    __esModule: true,
    default: (_req: any, _res: any, next: any) => next(),
  }))

  // Mock the superadmin controller to avoid DB/service dependencies
  jest.mock('@/controllers/dashboard/superadmin.controller', () => ({
    __esModule: true,
    getDashboardData: (_req: any, res: any) => res.status(200).json({ ok: true, route: 'dashboard' }),
    getAllVenues: (_req: any, res: any) => res.status(200).json({ ok: true, route: 'venues' }),
    getVenuesListSimple: (_req: any, res: any) => res.status(200).json({ ok: true, route: 'venues-list' }),
    getVenueDetails: (_req: any, res: any) => res.status(200).json({ ok: true, route: 'venue-details' }),
    approveVenue: (_req: any, res: any) => res.status(200).json({ ok: true, action: 'approve' }),
    suspendVenue: (_req: any, res: any) => res.status(200).json({ ok: true, action: 'suspend' }),
    getAllFeatures: (_req: any, res: any) => res.status(200).json({ ok: true, route: 'features' }),
    createFeature: (_req: any, res: any) => res.status(201).json({ ok: true, action: 'create-feature' }),
    enableFeatureForVenue: (_req: any, res: any) => res.status(200).json({ ok: true, action: 'enable-feature' }),
    disableFeatureForVenue: (_req: any, res: any) => res.status(204).send(),
    getRevenueMetrics: (_req: any, res: any) => res.status(200).json({ ok: true, route: 'revenue-metrics' }),
    getRevenueBreakdown: (_req: any, res: any) => res.status(200).json({ ok: true, route: 'revenue-breakdown' }),
    getProvidersList: (_req: any, res: any) => res.status(200).json({ ok: true, route: 'providers' }),
    getMerchantAccountsList: (_req: any, res: any) => res.status(200).json({ ok: true, route: 'merchant-accounts' }),
  }))

  // Dynamically import the app after setting env and mocks
  const mod = await import('@/app')
  app = mod.default
})

const makeToken = (role: string) =>
  jwt.sign({ sub: 'test-user', orgId: 'test-org', venueId: 'test-venue', role }, process.env.ACCESS_TOKEN_SECRET || TEST_SECRET)

describe('Superadmin routes - authentication and authorization', () => {
  test('should return 401 when no token is provided', async () => {
    const res = await request(app).get('/api/v1/dashboard/superadmin/venues')
    expect(res.status).toBe(401)
    expect(res.body).toHaveProperty('error', 'Unauthorized')
  })

  test('should return 403 for non-SUPERADMIN roles', async () => {
    const adminToken = makeToken('ADMIN')
    const res = await request(app).get('/api/v1/dashboard/superadmin/venues').set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('error', 'Forbidden')
  })

  test('should allow SUPERADMIN to access superadmin endpoints', async () => {
    const superadminToken = makeToken('SUPERADMIN')
    const res = await request(app).get('/api/v1/dashboard/superadmin/venues').set('Authorization', `Bearer ${superadminToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, route: 'venues' })
  })

  test('should return 401 for malformed/invalid token with message', async () => {
    const res = await request(app).get('/api/v1/dashboard/superadmin/venues').set('Authorization', 'Bearer invalid.token.here')

    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ error: 'Unauthorized', message: 'Invalid token' })
  })

  test('routes are mounted under /dashboard/superadmin', async () => {
    const token = makeToken('SUPERADMIN')
    const res = await request(app).get('/api/v1/dashboard/superadmin/dashboard').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, route: 'dashboard' })
  })

  test('DELETE disable feature route returns 204 for SUPERADMIN', async () => {
    const token = makeToken('SUPERADMIN')
    const res = await request(app)
      .delete('/api/v1/dashboard/superadmin/venues/venue-1/features/ordering/disable')
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(204)
  })

  test('cookie-based accessToken works for SUPERADMIN', async () => {
    const token = makeToken('SUPERADMIN')
    const res = await request(app)
      .get('/api/v1/dashboard/superadmin/venues')
      .set('Cookie', [`accessToken=${token}`])

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, route: 'venues' })
  })
})
