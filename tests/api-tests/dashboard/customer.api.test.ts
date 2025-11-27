/*
  API tests for Customer routes under /api/v1/dashboard/venues/:venueId/customers
  Verifies:
  - 401 for unauthenticated requests
  - 403 for insufficient permissions (must have customers:read, customers:create, customers:update, customers:delete)
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

  // Mock customer controller to avoid database dependencies
  jest.mock('@/controllers/dashboard/customer.dashboard.controller', () => ({
    __esModule: true,
    getCustomers: (_req: any, res: any) => res.status(200).json({ data: [], meta: { totalCount: 0 } }),
    getCustomerStats: (_req: any, res: any) => res.status(200).json({ totalCustomers: 100, vipCustomers: 10 }),
    getCustomerById: (_req: any, res: any) => res.status(200).json({ id: CUSTOMER_ID, email: 'test@example.com' }),
    createCustomer: (_req: any, res: any) => res.status(201).json({ id: CUSTOMER_ID, email: 'new@example.com' }),
    updateCustomer: (_req: any, res: any) => res.status(200).json({ id: CUSTOMER_ID, email: 'updated@example.com' }),
    deleteCustomer: (_req: any, res: any) => res.status(204).send(),
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
      permissions, // Custom permissions array
    },
    process.env.ACCESS_TOKEN_SECRET || TEST_SECRET,
  )

describe('Customer API - Authentication & Authorization', () => {
  describe('GET /api/v1/dashboard/venues/:venueId/customers', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customers`)

      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when user lacks customers:read permission', async () => {
      // KITCHEN role doesn't have customers:read by default
      const token = makeToken('KITCHEN', [])
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customers`).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when user has customers:read permission', async () => {
      const token = makeToken('MANAGER', ['customers:read'])
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customers`).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('data')
      expect(res.body).toHaveProperty('meta')
    })

    it('should work with cookie-based accessToken', async () => {
      const token = makeToken('ADMIN', ['customers:read'])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customers`)
        .set('Cookie', [`accessToken=${token}`])

      expect(res.status).toBe(200)
    })
  })

  describe('GET /api/v1/dashboard/venues/:venueId/customers/stats', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/stats`)

      expect(res.status).toBe(401)
    })

    it('should return 403 without customers:read permission', async () => {
      // KITCHEN role doesn't have customers:read by default
      const token = makeToken('KITCHEN', [])
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/stats`).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
    })

    it('should return 200 with customers:read permission', async () => {
      const token = makeToken('MANAGER', ['customers:read'])
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/stats`).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('totalCustomers')
    })
  })

  describe('GET /api/v1/dashboard/venues/:venueId/customers/:customerId', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}`)

      expect(res.status).toBe(401)
    })

    it('should return 403 without customers:read permission', async () => {
      // KITCHEN role doesn't have customers:read by default
      const token = makeToken('KITCHEN', [])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
    })

    it('should return 200 with customers:read permission', async () => {
      const token = makeToken('MANAGER', ['customers:read'])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('id', CUSTOMER_ID)
    })
  })

  describe('POST /api/v1/dashboard/venues/:venueId/customers', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).post(`/api/v1/dashboard/venues/${VENUE_ID}/customers`).send({
        email: 'new@example.com',
        firstName: 'John',
      })

      expect(res.status).toBe(401)
    })

    it('should return 403 without customers:create permission', async () => {
      // KITCHEN role doesn't have customers:create by default
      const token = makeToken('KITCHEN', ['customers:read']) // Has read but not create
      const res = await request(app).post(`/api/v1/dashboard/venues/${VENUE_ID}/customers`).set('Authorization', `Bearer ${token}`).send({
        email: 'new@example.com',
        firstName: 'John',
      })

      expect(res.status).toBe(403)
    })

    it('should return 201 with customers:create permission', async () => {
      const token = makeToken('MANAGER', ['customers:create'])
      const res = await request(app).post(`/api/v1/dashboard/venues/${VENUE_ID}/customers`).set('Authorization', `Bearer ${token}`).send({
        email: 'new@example.com',
        firstName: 'John',
      })

      expect(res.status).toBe(201)
      expect(res.body).toHaveProperty('id')
    })
  })

  describe('PUT /api/v1/dashboard/venues/:venueId/customers/:customerId', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).put(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}`).send({
        firstName: 'UpdatedName',
      })

      expect(res.status).toBe(401)
    })

    it('should return 403 without customers:update permission', async () => {
      // KITCHEN role doesn't have customers:update by default
      const token = makeToken('KITCHEN', ['customers:read'])
      const res = await request(app)
        .put(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          firstName: 'UpdatedName',
        })

      expect(res.status).toBe(403)
    })

    it('should return 200 with customers:update permission', async () => {
      const token = makeToken('MANAGER', ['customers:update'])
      const res = await request(app)
        .put(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          firstName: 'UpdatedName',
        })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('id', CUSTOMER_ID)
    })
  })

  describe('DELETE /api/v1/dashboard/venues/:venueId/customers/:customerId', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).delete(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}`)

      expect(res.status).toBe(401)
    })

    it('should return 403 without customers:delete permission', async () => {
      // KITCHEN role doesn't have customers:delete by default
      const token = makeToken('KITCHEN', ['customers:read', 'customers:update'])
      const res = await request(app)
        .delete(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
    })

    it('should return 204 with customers:delete permission', async () => {
      const token = makeToken('ADMIN', ['customers:delete'])
      const res = await request(app)
        .delete(`/api/v1/dashboard/venues/${VENUE_ID}/customers/${CUSTOMER_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(204)
    })
  })

  describe('Route mounting and malformed tokens', () => {
    it('should return 401 for malformed JWT token', async () => {
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customers`).set('Authorization', 'Bearer invalid.token.here')

      expect(res.status).toBe(401)
      expect(res.body).toMatchObject({ error: 'Unauthorized', message: 'Invalid token' })
    })

    it('should verify routes are mounted under correct path', async () => {
      const token = makeToken('ADMIN', ['customers:read'])

      // Verify correct path works
      const validRes = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customers`).set('Authorization', `Bearer ${token}`)
      expect(validRes.status).toBe(200)

      // Verify incorrect path returns 404
      const invalidRes = await request(app).get('/api/v1/wrong/path/customers').set('Authorization', `Bearer ${token}`)
      expect(invalidRes.status).toBe(404)
    })
  })
})
