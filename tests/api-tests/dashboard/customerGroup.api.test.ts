/*
  API tests for Customer Group routes under /api/v1/dashboard/venues/:venueId/customer-groups
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
const GROUP_ID = 'cltestgroupid1234567890123'
const CUSTOMER_ID_1 = 'cltestcustomer01234567890'
const CUSTOMER_ID_2 = 'cltestcustomer12345678901'

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

  // Mock customerGroup controller
  jest.mock('@/controllers/dashboard/customerGroup.dashboard.controller', () => ({
    __esModule: true,
    getCustomerGroups: (_req: any, res: any) => res.status(200).json({ data: [], meta: { totalCount: 0 } }),
    getCustomerGroupStats: (_req: any, res: any) => res.status(200).json({ groups: [] }),
    getCustomerGroupById: (_req: any, res: any) => res.status(200).json({ id: GROUP_ID, name: 'VIP' }),
    createCustomerGroup: (_req: any, res: any) => res.status(201).json({ id: GROUP_ID, name: 'New Group' }),
    updateCustomerGroup: (_req: any, res: any) => res.status(200).json({ id: GROUP_ID, name: 'Updated Group' }),
    deleteCustomerGroup: (_req: any, res: any) => res.status(204).send(),
    assignCustomersToGroup: (_req: any, res: any) => res.status(200).json({ assignedCount: 5 }),
    removeCustomersFromGroup: (_req: any, res: any) => res.status(200).json({ removedCount: 3 }),
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

describe('Customer Group API - Authentication & Authorization', () => {
  describe('GET /api/v1/dashboard/venues/:venueId/customer-groups', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups`)

      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when user lacks customer-groups:read permission', async () => {
      // KITCHEN role doesn't have customer-groups:read by default
      const token = makeToken('KITCHEN', [])
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups`).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when user has customer-groups:read permission', async () => {
      const token = makeToken('MANAGER', ['customer-groups:read'])
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups`).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('data')
      expect(res.body).toHaveProperty('meta')
    })

    it('should work with cookie-based accessToken', async () => {
      const token = makeToken('ADMIN', ['customer-groups:read'])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups`)
        .set('Cookie', [`accessToken=${token}`])

      expect(res.status).toBe(200)
    })
  })

  describe('GET /api/v1/dashboard/venues/:venueId/customer-groups/stats', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/stats`)

      expect(res.status).toBe(401)
    })

    it('should return 403 without customer-groups:read permission', async () => {
      // KITCHEN role doesn't have customer-groups:read by default
      const token = makeToken('KITCHEN', [])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/stats`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
    })

    it('should return 200 with customer-groups:read permission', async () => {
      const token = makeToken('MANAGER', ['customer-groups:read'])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/stats`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('groups')
    })
  })

  describe('GET /api/v1/dashboard/venues/:venueId/customer-groups/:groupId', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}`)

      expect(res.status).toBe(401)
    })

    it('should return 403 without customer-groups:read permission', async () => {
      // KITCHEN role doesn't have customer-groups:read by default
      const token = makeToken('KITCHEN', [])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
    })

    it('should return 200 with customer-groups:read permission', async () => {
      const token = makeToken('MANAGER', ['customer-groups:read'])
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('id', GROUP_ID)
    })
  })

  describe('POST /api/v1/dashboard/venues/:venueId/customer-groups', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).post(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups`).send({
        name: 'New Group',
      })

      expect(res.status).toBe(401)
    })

    it('should return 403 without customer-groups:create permission', async () => {
      // KITCHEN role doesn't have customer-groups:create by default
      const token = makeToken('KITCHEN', ['customer-groups:read'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'New Group',
        })

      expect(res.status).toBe(403)
    })

    it('should return 201 with customer-groups:create permission', async () => {
      const token = makeToken('MANAGER', ['customer-groups:create'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'New Group',
        })

      expect(res.status).toBe(201)
      expect(res.body).toHaveProperty('id')
    })
  })

  describe('PUT /api/v1/dashboard/venues/:venueId/customer-groups/:groupId', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).put(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}`).send({
        name: 'Updated Group',
      })

      expect(res.status).toBe(401)
    })

    it('should return 403 without customer-groups:update permission', async () => {
      // KITCHEN role doesn't have customer-groups:update by default
      const token = makeToken('KITCHEN', ['customer-groups:read'])
      const res = await request(app)
        .put(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Updated Group',
        })

      expect(res.status).toBe(403)
    })

    it('should return 200 with customer-groups:update permission', async () => {
      const token = makeToken('MANAGER', ['customer-groups:update'])
      const res = await request(app)
        .put(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Updated Group',
        })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('id', GROUP_ID)
    })
  })

  describe('DELETE /api/v1/dashboard/venues/:venueId/customer-groups/:groupId', () => {
    it('should return 401 without token', async () => {
      const res = await request(app).delete(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}`)

      expect(res.status).toBe(401)
    })

    it('should return 403 without customer-groups:delete permission', async () => {
      // KITCHEN role doesn't have customer-groups:delete by default
      const token = makeToken('KITCHEN', ['customer-groups:read', 'customer-groups:update'])
      const res = await request(app)
        .delete(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(403)
    })

    it('should return 204 with customer-groups:delete permission', async () => {
      const token = makeToken('ADMIN', ['customer-groups:delete'])
      const res = await request(app)
        .delete(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(204)
    })
  })

  describe('POST /api/v1/dashboard/venues/:venueId/customer-groups/:groupId/assign', () => {
    it('should return 401 without token', async () => {
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}/assign`)
        .send({
          customerIds: [CUSTOMER_ID_1, CUSTOMER_ID_2],
        })

      expect(res.status).toBe(401)
    })

    it('should return 403 without customer-groups:update permission', async () => {
      // KITCHEN role doesn't have customer-groups:update by default
      const token = makeToken('KITCHEN', ['customer-groups:read'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}/assign`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          customerIds: [CUSTOMER_ID_1, CUSTOMER_ID_2],
        })

      expect(res.status).toBe(403)
    })

    it('should return 200 with customer-groups:update permission', async () => {
      const token = makeToken('MANAGER', ['customer-groups:update'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}/assign`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          customerIds: [CUSTOMER_ID_1, CUSTOMER_ID_2],
        })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('assignedCount')
    })
  })

  describe('POST /api/v1/dashboard/venues/:venueId/customer-groups/:groupId/remove', () => {
    it('should return 401 without token', async () => {
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}/remove`)
        .send({
          customerIds: [CUSTOMER_ID_1, CUSTOMER_ID_2],
        })

      expect(res.status).toBe(401)
    })

    it('should return 403 without customer-groups:update permission', async () => {
      // KITCHEN role doesn't have customer-groups:update by default
      const token = makeToken('KITCHEN', ['customer-groups:read'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}/remove`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          customerIds: [CUSTOMER_ID_1, CUSTOMER_ID_2],
        })

      expect(res.status).toBe(403)
    })

    it('should return 200 with customer-groups:update permission', async () => {
      const token = makeToken('MANAGER', ['customer-groups:update'])
      const res = await request(app)
        .post(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups/${GROUP_ID}/remove`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          customerIds: [CUSTOMER_ID_1, CUSTOMER_ID_2],
        })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('removedCount')
    })
  })

  describe('Route mounting and malformed tokens', () => {
    it('should return 401 for malformed JWT token', async () => {
      const res = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups`)
        .set('Authorization', 'Bearer invalid.token.here')

      expect(res.status).toBe(401)
      expect(res.body).toMatchObject({ error: 'Unauthorized', message: 'Invalid token' })
    })

    it('should verify routes are mounted under correct path', async () => {
      const token = makeToken('ADMIN', ['customer-groups:read'])

      // Verify correct path works
      const validRes = await request(app)
        .get(`/api/v1/dashboard/venues/${VENUE_ID}/customer-groups`)
        .set('Authorization', `Bearer ${token}`)
      expect(validRes.status).toBe(200)

      // Verify incorrect path returns 404
      const invalidRes = await request(app).get('/api/v1/wrong/path/customer-groups').set('Authorization', `Bearer ${token}`)
      expect(invalidRes.status).toBe(404)
    })
  })
})
