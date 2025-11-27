/*
  API tests for Loyalty routes under /api/v1/dashboard/venues/:venueId/loyalty
  Verifies:
  - 401 for unauthenticated requests
  - 403 for insufficient permissions (must have customers:read, customers:update)
  - 200/201/204 for valid requests with proper permissions
*/

import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'

let app: Express
const TEST_SECRET = 'test-secret'
// Use valid CUID format for IDs (required by Zod validation schemas)
const VENUE_ID = 'cltestvenueid12345678901'
const CUSTOMER_ID = 'cltestcustomerid12345678'
const ORDER_ID = 'cltestorderid123456789012'

beforeAll(async () => {
  // Set required env vars BEFORE importing app
  process.env.NODE_ENV = process.env.NODE_ENV || 'test'
  process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || TEST_SECRET
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session'
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie'
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb'

  jest.resetModules()

  // Mock session middleware
  jest.mock('@/config/session', () => ({
    __esModule: true,
    default: (_req: any, _res: any, next: any) => next(),
  }))

  // Mock loyalty controller (function names MUST match actual controller exports)
  jest.mock('@/controllers/dashboard/loyalty.dashboard.controller', () => ({
    __esModule: true,
    getLoyaltyConfig: (_req: any, res: any) =>
      res.status(200).json({
        venueId: VENUE_ID,
        pointsPerDollar: 1,
        pointsPerVisit: 10,
        redemptionRate: 0.01,
        minPointsRedeem: 100,
        active: true,
      }),
    updateLoyaltyConfig: (_req: any, res: any) =>
      res.status(200).json({
        venueId: VENUE_ID,
        pointsPerDollar: 2,
        active: true,
      }),
    calculatePoints: (_req: any, res: any) => res.status(200).json({ points: 100 }),
    calculateDiscount: (_req: any, res: any) => res.status(200).json({ discount: 5.0 }),
    getPointsBalance: (_req: any, res: any) => res.status(200).json({ customerId: CUSTOMER_ID, loyaltyPoints: 500 }),
    redeemPoints: (_req: any, res: any) => res.status(200).json({ pointsRedeemed: 100, discountAmount: 1.0, newBalance: 400 }),
    adjustPoints: (_req: any, res: any) => res.status(200).json({ pointsAdjusted: 50, newBalance: 550 }),
    getLoyaltyTransactions: (_req: any, res: any) => res.status(200).json({ data: [], meta: { totalCount: 0 }, currentBalance: 500 }),
    expireOldPoints: (_req: any, res: any) => res.status(200).json({ customersAffected: 5, pointsExpired: 200 }),
  }))

  // Import app after mocks
  const mod = await import('@/app')
  app = mod.default
})

/**
 * Generate JWT token with specified role and permissions
 */
const makeToken = (role: string, permissions: string[] = []) =>
  jwt.sign(
    {
      sub: 'test-user',
      orgId: 'test-org',
      venueId: VENUE_ID,
      role,
      permissions,
    },
    process.env.ACCESS_TOKEN_SECRET || TEST_SECRET,
  )

describe('Loyalty API - Authentication & Authorization', () => {
  describe('GET /api/v1/dashboard/venues/:venueId/loyalty/config', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/config`)

      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when user lacks loyalty:read permission', async () => {
      // KITCHEN role doesn't have loyalty:read by default
      const token = makeToken('KITCHEN', [])
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/config`).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when user has loyalty:read permission', async () => {
      const token = makeToken('MANAGER', ['loyalty:read'])
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/config`).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('venueId', VENUE_ID)
      expect(res.body).toHaveProperty('pointsPerDollar')
    })

    it('should work with cookie-based accessToken', async () => {
      const token = makeToken('ADMIN', ['loyalty:read'])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/config`)
        .set('Cookie', [`accessToken=${token}`])

      expect(res.status).toBe(200)
    })
  })

  describe('PUT /api/v1/dashboard/venues/:venueId/loyalty/config', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).put(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/config`).send({
        pointsPerDollar: 2,
      })

      expect(res.status).toBe(401)
    })

    it('should return 403 without loyalty:update permission', async () => {
      // KITCHEN role doesn't have loyalty:update by default
      const token = makeToken('KITCHEN', ['loyalty:read'])
      const res = await request(app)
        .put(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/config`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          pointsPerDollar: 2,
        })

      expect(res.status).toBe(403)
    })

    it('should return 200 with loyalty:update permission', async () => {
      const token = makeToken('MANAGER', ['loyalty:update'])
      const res = await request(app)
        .put(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/config`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          pointsPerDollar: 2,
        })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('pointsPerDollar', 2)
    })
  })

  describe('POST /api/v1/dashboard/venues/:venueId/loyalty/calculate-points', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).post(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/calculate-points`).send({ amount: 100 })

      expect(res.status).toBe(401)
    })

    it('should return 403 without loyalty:read permission', async () => {
      // KITCHEN role doesn't have loyalty:read by default
      const token = makeToken('KITCHEN', [])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/calculate-points`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 100 })

      expect(res.status).toBe(403)
    })

    it('should return 200 with loyalty:read permission', async () => {
      const token = makeToken('MANAGER', ['loyalty:read'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/calculate-points`)
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 100 })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('points')
    })
  })

  describe('POST /api/v1/dashboard/venues/:venueId/loyalty/calculate-discount', () => {
    it('should return 401 without token', async () => {
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/calculate-discount`)
        .send({ points: 100, orderTotal: 50 })

      expect(res.status).toBe(401)
    })

    it('should return 403 without loyalty:read permission', async () => {
      // KITCHEN role doesn't have loyalty:read by default
      const token = makeToken('KITCHEN', [])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/calculate-discount`)
        .set('Authorization', `Bearer ${token}`)
        .send({ points: 100, orderTotal: 50 })

      expect(res.status).toBe(403)
    })

    it('should return 200 with loyalty:read permission', async () => {
      const token = makeToken('MANAGER', ['loyalty:read'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/calculate-discount`)
        .set('Authorization', `Bearer ${token}`)
        .send({ points: 100, orderTotal: 50 })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('discount')
    })
  })

  describe('GET /api/v1/dashboard/venues/:venueId/customers/:customerId/loyalty/balance', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/balance`)

      expect(res.status).toBe(401)
    })

    it('should return 403 without loyalty:read permission', async () => {
      // KITCHEN role doesn't have loyalty:read by default
      const token = makeToken('KITCHEN', [])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/balance`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
    })

    it('should return 200 with loyalty:read permission', async () => {
      const token = makeToken('MANAGER', ['loyalty:read'])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/balance`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('customerId', CUSTOMER_ID)
      expect(res.body).toHaveProperty('loyaltyPoints')
    })
  })

  describe('POST /api/v1/dashboard/venues/:venueId/customers/:customerId/loyalty/redeem', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).post(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/redeem`).send({
        points: 100,
        orderId: ORDER_ID,
      })

      expect(res.status).toBe(401)
    })

    it('should return 403 without loyalty:redeem permission', async () => {
      // KITCHEN role doesn't have loyalty:redeem by default
      const token = makeToken('KITCHEN', ['loyalty:read'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/redeem`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          points: 100,
          orderId: ORDER_ID,
        })

      expect(res.status).toBe(403)
    })

    it('should return 200 with loyalty:redeem permission', async () => {
      const token = makeToken('MANAGER', ['loyalty:redeem'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/redeem`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          points: 100,
          orderId: ORDER_ID,
        })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('pointsRedeemed')
      expect(res.body).toHaveProperty('discountAmount')
    })
  })

  describe('POST /api/v1/dashboard/venues/:venueId/customers/:customerId/loyalty/adjust', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).post(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/adjust`).send({
        points: 50,
        reason: 'Bonus points',
      })

      expect(res.status).toBe(401)
    })

    it('should return 403 without loyalty:adjust permission', async () => {
      // KITCHEN role doesn't have loyalty:adjust by default
      const token = makeToken('KITCHEN', ['loyalty:read'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          points: 50,
          reason: 'Bonus points',
        })

      expect(res.status).toBe(403)
    })

    it('should return 200 with loyalty:adjust permission', async () => {
      const token = makeToken('MANAGER', ['loyalty:adjust'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          points: 50,
          reason: 'Bonus points',
        })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('pointsAdjusted')
      expect(res.body).toHaveProperty('newBalance')
    })
  })

  describe('GET /api/v1/dashboard/venues/:venueId/customers/:customerId/loyalty/transactions', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/transactions`)

      expect(res.status).toBe(401)
    })

    it('should return 403 without loyalty:read permission', async () => {
      // KITCHEN role doesn't have loyalty:read by default
      const token = makeToken('KITCHEN', [])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/transactions`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
    })

    it('should return 200 with loyalty:read permission', async () => {
      const token = makeToken('MANAGER', ['loyalty:read'])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}/loyalty/transactions`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('data')
      expect(res.body).toHaveProperty('meta')
      expect(res.body).toHaveProperty('currentBalance')
    })
  })

  describe('POST /api/v1/dashboard/venues/:venueId/loyalty/expire-old-points', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).post(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/expire-old-points`)

      expect(res.status).toBe(401)
    })

    it('should return 403 without loyalty:expire permission', async () => {
      // KITCHEN role doesn't have loyalty:expire by default
      const token = makeToken('KITCHEN', ['loyalty:read'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/expire-old-points`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
    })

    it('should return 200 with loyalty:expire permission', async () => {
      const token = makeToken('ADMIN', ['loyalty:expire'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/expire-old-points`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('customersAffected')
      expect(res.body).toHaveProperty('pointsExpired')
    })
  })

  describe('Route mounting and malformed tokens', () => {
    it('should return 401 for malformed JWT token', async () => {
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/config`)
        .set('Authorization', 'Bearer invalid.token.here')

      expect(res.status).toBe(401)
      expect(res.body).toMatchObject({ error: 'Unauthorized', message: 'Invalid token' })
    })

    it('should verify routes are mounted under correct path', async () => {
      const token = makeToken('ADMIN', ['loyalty:read'])

      // Verify correct path works
      const validRes = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/loyalty/config`).set('Authorization', `Bearer ${token}`)
      expect(validRes.status).toBe(200)

      // Verify incorrect path returns 404
      const invalidRes = await request(app).get('/api/v1/wrong/path/loyalty/config').set('Authorization', `Bearer ${token}`)
      expect(invalidRes.status).toBe(404)
    })
  })
})
