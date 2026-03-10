/*
  API tests for Credit Pack routes under /api/v1/dashboard/venues/:venueId/credit-packs
  Verifies:
  - 401 for unauthenticated requests
  - 403 for insufficient permissions
  - 200/201/204 for valid requests with proper permissions
  - Zod validation (400) for malformed bodies
  - Cookie-based auth
  - Role-based access (OWNER, ADMIN, MANAGER, CASHIER, WAITER, KITCHEN, VIEWER)

  NOTE: creditPacks permissions are NOT in any default role. They must be injected
  via mocked VenueRolePermission (custom permissions). The prismaMock from setup.ts
  is used to simulate this.
*/

import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'

let app: Express
const TEST_SECRET = 'test-secret'
const VENUE_ID = 'cltestvenuecp12345678901'
const PACK_ID = 'cltestpackid012345678901'
const BALANCE_ID = 'cltestbalanceid1234567890'
const CUSTOMER_ID = 'cltestcustomerid12345678'
const PURCHASE_ID = 'cltestpurchaseid12345678'

const BASE = `/api/v1/dashboard/venues/${VENUE_ID}/credit-packs`

beforeAll(async () => {
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

  // Mock the controller (function names match actual exports from creditPack.dashboard.controller)
  jest.mock('@/controllers/dashboard/creditPack.dashboard.controller', () => ({
    __esModule: true,
    getCreditPacks: (_req: any, res: any) => res.status(200).json([]),
    getCreditPackById: (_req: any, res: any) => res.status(200).json({ id: 'pack-1' }),
    createCreditPack: (_req: any, res: any) => res.status(201).json({ id: 'pack-new' }),
    updateCreditPack: (_req: any, res: any) => res.status(200).json({ id: 'pack-1' }),
    deactivateCreditPack: (_req: any, res: any) => res.status(204).send(),
    getPurchases: (_req: any, res: any) => res.status(200).json({ purchases: [], total: 0 }),
    getCustomerPurchases: (_req: any, res: any) => res.status(200).json({ purchases: [], total: 0 }),
    getTransactions: (_req: any, res: any) => res.status(200).json({ transactions: [], total: 0 }),
    redeemItem: (_req: any, res: any) => res.status(200).json({ type: 'REDEEM' }),
    adjustBalance: (_req: any, res: any) => res.status(200).json({ type: 'ADJUST' }),
    refundPurchase: (_req: any, res: any) => res.status(200).json({ refunded: true }),
  }))

  const mod = await import('@/app')
  app = mod.default
})

/**
 * Generate JWT token with specified role.
 * Note: The `permissions` array in the token payload is NOT used by checkPermission middleware.
 * Actual permission resolution uses role defaults + VenueRolePermission from DB.
 */
const makeToken = (role: string) =>
  jwt.sign(
    {
      sub: 'test-user',
      orgId: 'test-org',
      venueId: VENUE_ID,
      role,
    },
    process.env.ACCESS_TOKEN_SECRET || TEST_SECRET,
  )

/**
 * Configure prismaMock to return custom permissions for a given role.
 * Since creditPacks:* is NOT in any default role, we must inject via VenueRolePermission mock.
 */
const mockCustomPermissions = (permissions: string[]) => {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue({
    permissions,
  })
}

/**
 * Reset permission mocks so no custom permissions are returned (role uses defaults only).
 * Also resets staffVenue.findFirst to prevent SUPERADMIN leakage between tests.
 */
const clearCustomPermissions = () => {
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
}

// Reset mocked return values before each test to prevent leakage.
// jest.clearAllMocks() (from setup.ts) clears calls/results but NOT implementations.
beforeEach(() => {
  clearCustomPermissions()
})

// ==========================================
// CREDIT PACK API TESTS
// ==========================================

describe('Credit Pack API - Authentication, Authorization & Validation', () => {
  // ---- GET /credit-packs (list all) ----

  describe('GET /credit-packs', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).get(BASE)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when KITCHEN role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('KITCHEN')
      const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when WAITER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('WAITER')
      const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when VIEWER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('VIEWER')
      const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when CASHIER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('CASHIER')
      const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when OWNER role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('OWNER')
      const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it('should return 200 when ADMIN role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('ADMIN')
      const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it('should return 200 when MANAGER role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('MANAGER')
      const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it('should work with cookie-based accessToken', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .get(BASE)
        .set('Cookie', [`accessToken=${token}`])
      expect(res.status).toBe(200)
    })
  })

  // ---- POST /credit-packs (create) ----

  describe('POST /credit-packs', () => {
    const validBody = {
      name: 'Pack de Tacos',
      description: 'Un paquete delicioso',
      price: 199.99,
      items: [{ productId: 'prod-1', quantity: 5 }],
    }

    it('should return 401 when no token is provided', async () => {
      const res = await request(app).post(BASE).send(validBody)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when KITCHEN role has no creditPacks:create permission', async () => {
      clearCustomPermissions()
      const token = makeToken('KITCHEN')
      const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send(validBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when WAITER role has no creditPacks:create permission', async () => {
      clearCustomPermissions()
      const token = makeToken('WAITER')
      const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send(validBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when VIEWER role has no creditPacks:create permission', async () => {
      clearCustomPermissions()
      const token = makeToken('VIEWER')
      const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send(validBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when CASHIER role has no creditPacks:create permission', async () => {
      clearCustomPermissions()
      const token = makeToken('CASHIER')
      const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send(validBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 201 when OWNER role has creditPacks:create via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:create'])
      const token = makeToken('OWNER')
      const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send(validBody)
      expect(res.status).toBe(201)
      expect(res.body).toHaveProperty('id', 'pack-new')
    })

    it('should return 201 when ADMIN role has creditPacks:create via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:create'])
      const token = makeToken('ADMIN')
      const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send(validBody)
      expect(res.status).toBe(201)
      expect(res.body).toHaveProperty('id', 'pack-new')
    })

    it('should return 403 when MANAGER role does not have creditPacks:create', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('MANAGER')
      const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send(validBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should work with cookie-based accessToken', async () => {
      mockCustomPermissions(['creditPacks:create'])
      const token = makeToken('ADMIN')
      const res = await request(app)
        .post(BASE)
        .set('Cookie', [`accessToken=${token}`])
        .send(validBody)
      expect(res.status).toBe(201)
    })

    // Zod validation tests
    it('should return 400 when name is missing', async () => {
      mockCustomPermissions(['creditPacks:create'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(BASE)
        .set('Authorization', `Bearer ${token}`)
        .send({ price: 100, items: [{ productId: 'prod-1', quantity: 1 }] })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
      expect(res.body.message).toMatch(/validación/i)
    })

    it('should return 400 when items array is empty', async () => {
      mockCustomPermissions(['creditPacks:create'])
      const token = makeToken('OWNER')
      const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send({ name: 'Pack', price: 100, items: [] })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
      expect(res.body.message).toMatch(/item/i)
    })

    it('should return 400 when price is negative', async () => {
      mockCustomPermissions(['creditPacks:create'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(BASE)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Pack', price: -10, items: [{ productId: 'prod-1', quantity: 1 }] })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
      expect(res.body.message).toMatch(/precio|mayor/i)
    })

    it('should return 400 when items have invalid quantity (0)', async () => {
      mockCustomPermissions(['creditPacks:create'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(BASE)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Pack', price: 100, items: [{ productId: 'prod-1', quantity: 0 }] })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
      expect(res.body.message).toMatch(/cantidad|mayor/i)
    })

    it('should return 400 when items have invalid quantity (negative)', async () => {
      mockCustomPermissions(['creditPacks:create'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(BASE)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Pack', price: 100, items: [{ productId: 'prod-1', quantity: -3 }] })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
      expect(res.body.message).toMatch(/cantidad|mayor/i)
    })

    it('should return 400 when price is zero', async () => {
      mockCustomPermissions(['creditPacks:create'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(BASE)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Pack', price: 0, items: [{ productId: 'prod-1', quantity: 1 }] })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
    })

    it('should return 400 when body is empty', async () => {
      mockCustomPermissions(['creditPacks:create'])
      const token = makeToken('OWNER')
      const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`).send({})
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
    })
  })

  // ---- GET /credit-packs/:packId ----

  describe('GET /credit-packs/:packId', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).get(`${BASE}/${PACK_ID}`)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when KITCHEN role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('KITCHEN')
      const res = await request(app).get(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when WAITER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('WAITER')
      const res = await request(app).get(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when VIEWER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('VIEWER')
      const res = await request(app).get(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when CASHIER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('CASHIER')
      const res = await request(app).get(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when OWNER role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('OWNER')
      const res = await request(app).get(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('id', 'pack-1')
    })

    it('should return 200 when ADMIN role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('ADMIN')
      const res = await request(app).get(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('id', 'pack-1')
    })

    it('should return 200 when MANAGER role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('MANAGER')
      const res = await request(app).get(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('id', 'pack-1')
    })

    it('should work with cookie-based accessToken', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .get(`${BASE}/${PACK_ID}`)
        .set('Cookie', [`accessToken=${token}`])
      expect(res.status).toBe(200)
    })
  })

  // ---- PATCH /credit-packs/:packId ----

  describe('PATCH /credit-packs/:packId', () => {
    const validUpdateBody = { name: 'Pack Actualizado' }

    it('should return 401 when no token is provided', async () => {
      const res = await request(app).patch(`${BASE}/${PACK_ID}`).send(validUpdateBody)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when KITCHEN role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('KITCHEN')
      const res = await request(app).patch(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`).send(validUpdateBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when WAITER role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('WAITER')
      const res = await request(app).patch(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`).send(validUpdateBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when VIEWER role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('VIEWER')
      const res = await request(app).patch(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`).send(validUpdateBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when CASHIER role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('CASHIER')
      const res = await request(app).patch(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`).send(validUpdateBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when OWNER role has creditPacks:update via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app).patch(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`).send(validUpdateBody)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('id', 'pack-1')
    })

    it('should return 200 when ADMIN role has creditPacks:update via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('ADMIN')
      const res = await request(app).patch(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`).send(validUpdateBody)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('id', 'pack-1')
    })

    it('should return 403 when MANAGER role only has creditPacks:read (not update)', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('MANAGER')
      const res = await request(app).patch(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`).send(validUpdateBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should work with cookie-based accessToken', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .patch(`${BASE}/${PACK_ID}`)
        .set('Cookie', [`accessToken=${token}`])
        .send(validUpdateBody)
      expect(res.status).toBe(200)
    })

    // Zod validation tests for PATCH
    it('should return 400 when price is negative', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app).patch(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`).send({ price: -5 })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
      expect(res.body.message).toMatch(/precio|mayor/i)
    })

    it('should return 400 when items array is empty on update', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app).patch(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`).send({ items: [] })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
      expect(res.body.message).toMatch(/item/i)
    })

    it('should return 400 when items have quantity 0 on update', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .patch(`${BASE}/${PACK_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [{ productId: 'prod-1', quantity: 0 }] })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
    })
  })

  // ---- DELETE /credit-packs/:packId ----

  describe('DELETE /credit-packs/:packId', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).delete(`${BASE}/${PACK_ID}`)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when KITCHEN role has no creditPacks:delete permission', async () => {
      clearCustomPermissions()
      const token = makeToken('KITCHEN')
      const res = await request(app).delete(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when WAITER role has no creditPacks:delete permission', async () => {
      clearCustomPermissions()
      const token = makeToken('WAITER')
      const res = await request(app).delete(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when VIEWER role has no creditPacks:delete permission', async () => {
      clearCustomPermissions()
      const token = makeToken('VIEWER')
      const res = await request(app).delete(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when CASHIER role has no creditPacks:delete permission', async () => {
      clearCustomPermissions()
      const token = makeToken('CASHIER')
      const res = await request(app).delete(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 204 when OWNER role has creditPacks:delete via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:delete'])
      const token = makeToken('OWNER')
      const res = await request(app).delete(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(204)
    })

    it('should return 204 when ADMIN role has creditPacks:delete via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:delete'])
      const token = makeToken('ADMIN')
      const res = await request(app).delete(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(204)
    })

    it('should return 403 when MANAGER role only has creditPacks:read (not delete)', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('MANAGER')
      const res = await request(app).delete(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should work with cookie-based accessToken', async () => {
      mockCustomPermissions(['creditPacks:delete'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .delete(`${BASE}/${PACK_ID}`)
        .set('Cookie', [`accessToken=${token}`])
      expect(res.status).toBe(204)
    })
  })

  // ---- GET /credit-packs/purchases ----

  describe('GET /credit-packs/purchases', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).get(`${BASE}/purchases`)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when KITCHEN role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('KITCHEN')
      const res = await request(app).get(`${BASE}/purchases`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when WAITER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('WAITER')
      const res = await request(app).get(`${BASE}/purchases`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when VIEWER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('VIEWER')
      const res = await request(app).get(`${BASE}/purchases`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when CASHIER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('CASHIER')
      const res = await request(app).get(`${BASE}/purchases`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when OWNER role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('OWNER')
      const res = await request(app).get(`${BASE}/purchases`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('purchases')
      expect(res.body).toHaveProperty('total', 0)
    })

    it('should return 200 when ADMIN role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('ADMIN')
      const res = await request(app).get(`${BASE}/purchases`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('purchases')
    })

    it('should return 200 when MANAGER role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('MANAGER')
      const res = await request(app).get(`${BASE}/purchases`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('purchases')
    })

    it('should work with cookie-based accessToken', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .get(`${BASE}/purchases`)
        .set('Cookie', [`accessToken=${token}`])
      expect(res.status).toBe(200)
    })
  })

  // ---- GET /credit-packs/purchases/:customerId ----

  describe('GET /credit-packs/purchases/:customerId', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).get(`${BASE}/purchases/${CUSTOMER_ID}`)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when KITCHEN role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('KITCHEN')
      const res = await request(app).get(`${BASE}/purchases/${CUSTOMER_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when WAITER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('WAITER')
      const res = await request(app).get(`${BASE}/purchases/${CUSTOMER_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when VIEWER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('VIEWER')
      const res = await request(app).get(`${BASE}/purchases/${CUSTOMER_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when CASHIER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('CASHIER')
      const res = await request(app).get(`${BASE}/purchases/${CUSTOMER_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when OWNER role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('OWNER')
      const res = await request(app).get(`${BASE}/purchases/${CUSTOMER_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('purchases')
      expect(res.body).toHaveProperty('total', 0)
    })

    it('should return 200 when ADMIN role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('ADMIN')
      const res = await request(app).get(`${BASE}/purchases/${CUSTOMER_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('purchases')
    })

    it('should return 200 when MANAGER role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('MANAGER')
      const res = await request(app).get(`${BASE}/purchases/${CUSTOMER_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('purchases')
    })

    it('should work with cookie-based accessToken', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .get(`${BASE}/purchases/${CUSTOMER_ID}`)
        .set('Cookie', [`accessToken=${token}`])
      expect(res.status).toBe(200)
    })
  })

  // ---- GET /credit-packs/transactions ----

  describe('GET /credit-packs/transactions', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).get(`${BASE}/transactions`)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when KITCHEN role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('KITCHEN')
      const res = await request(app).get(`${BASE}/transactions`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when WAITER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('WAITER')
      const res = await request(app).get(`${BASE}/transactions`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when VIEWER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('VIEWER')
      const res = await request(app).get(`${BASE}/transactions`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when CASHIER role has no creditPacks:read permission', async () => {
      clearCustomPermissions()
      const token = makeToken('CASHIER')
      const res = await request(app).get(`${BASE}/transactions`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when OWNER role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('OWNER')
      const res = await request(app).get(`${BASE}/transactions`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('transactions')
      expect(res.body).toHaveProperty('total', 0)
    })

    it('should return 200 when ADMIN role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('ADMIN')
      const res = await request(app).get(`${BASE}/transactions`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('transactions')
    })

    it('should return 200 when MANAGER role has creditPacks:read via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('MANAGER')
      const res = await request(app).get(`${BASE}/transactions`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('transactions')
    })

    it('should work with cookie-based accessToken', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .get(`${BASE}/transactions`)
        .set('Cookie', [`accessToken=${token}`])
      expect(res.status).toBe(200)
    })
  })

  // ---- POST /credit-packs/balances/:balanceId/redeem ----

  describe('POST /credit-packs/balances/:balanceId/redeem', () => {
    const redeemBody = { reason: 'Manual redemption' }

    it('should return 401 when no token is provided', async () => {
      const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/redeem`).send(redeemBody)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when KITCHEN role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('KITCHEN')
      const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/redeem`).set('Authorization', `Bearer ${token}`).send(redeemBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when WAITER role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('WAITER')
      const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/redeem`).set('Authorization', `Bearer ${token}`).send(redeemBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when VIEWER role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('VIEWER')
      const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/redeem`).set('Authorization', `Bearer ${token}`).send(redeemBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when CASHIER role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('CASHIER')
      const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/redeem`).set('Authorization', `Bearer ${token}`).send(redeemBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when OWNER role has creditPacks:update via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/redeem`).set('Authorization', `Bearer ${token}`).send(redeemBody)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('type', 'REDEEM')
    })

    it('should return 200 when ADMIN role has creditPacks:update via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('ADMIN')
      const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/redeem`).set('Authorization', `Bearer ${token}`).send(redeemBody)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('type', 'REDEEM')
    })

    it('should return 403 when MANAGER role only has creditPacks:read (not update)', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('MANAGER')
      const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/redeem`).set('Authorization', `Bearer ${token}`).send(redeemBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should work with cookie-based accessToken', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/redeem`)
        .set('Cookie', [`accessToken=${token}`])
        .send(redeemBody)
      expect(res.status).toBe(200)
    })

    it('should return 200 with empty body (reason is optional for redeem)', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/redeem`).set('Authorization', `Bearer ${token}`).send({})
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('type', 'REDEEM')
    })
  })

  // ---- POST /credit-packs/balances/:balanceId/adjust ----

  describe('POST /credit-packs/balances/:balanceId/adjust', () => {
    const validAdjustBody = { quantity: 3, reason: 'Manual adjustment' }

    it('should return 401 when no token is provided', async () => {
      const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/adjust`).send(validAdjustBody)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when KITCHEN role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('KITCHEN')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send(validAdjustBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when WAITER role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('WAITER')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send(validAdjustBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when VIEWER role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('VIEWER')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send(validAdjustBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when CASHIER role has no creditPacks:update permission', async () => {
      clearCustomPermissions()
      const token = makeToken('CASHIER')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send(validAdjustBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when OWNER role has creditPacks:update via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send(validAdjustBody)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('type', 'ADJUST')
    })

    it('should return 200 when ADMIN role has creditPacks:update via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('ADMIN')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send(validAdjustBody)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('type', 'ADJUST')
    })

    it('should return 403 when MANAGER role only has creditPacks:read (not update)', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('MANAGER')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send(validAdjustBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should work with cookie-based accessToken', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Cookie', [`accessToken=${token}`])
        .send(validAdjustBody)
      expect(res.status).toBe(200)
    })

    // Zod validation tests for adjust
    it('should return 400 when quantity is 0', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quantity: 0, reason: 'Test' })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
      expect(res.body.message).toMatch(/cantidad|0/i)
    })

    it('should return 400 when reason is missing', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quantity: 5 })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
      expect(res.body.message).toMatch(/razon|requerida|required/i)
    })

    it('should return 400 when reason is empty string', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quantity: 2, reason: '' })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
    })

    it('should return 400 when body is empty', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/adjust`).set('Authorization', `Bearer ${token}`).send({})
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
    })

    it('should accept negative quantity (for balance decrease)', async () => {
      mockCustomPermissions(['creditPacks:update'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
        .set('Authorization', `Bearer ${token}`)
        .send({ quantity: -2, reason: 'Correction' })
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('type', 'ADJUST')
    })
  })

  // ---- POST /credit-packs/purchases/:purchaseId/refund ----

  describe('POST /credit-packs/purchases/:purchaseId/refund', () => {
    const validRefundBody = { reason: 'Customer requested refund' }

    it('should return 401 when no token is provided', async () => {
      const res = await request(app).post(`${BASE}/purchases/${PURCHASE_ID}/refund`).send(validRefundBody)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 403 when KITCHEN role has no creditPacks:delete permission', async () => {
      clearCustomPermissions()
      const token = makeToken('KITCHEN')
      const res = await request(app)
        .post(`${BASE}/purchases/${PURCHASE_ID}/refund`)
        .set('Authorization', `Bearer ${token}`)
        .send(validRefundBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when WAITER role has no creditPacks:delete permission', async () => {
      clearCustomPermissions()
      const token = makeToken('WAITER')
      const res = await request(app)
        .post(`${BASE}/purchases/${PURCHASE_ID}/refund`)
        .set('Authorization', `Bearer ${token}`)
        .send(validRefundBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when VIEWER role has no creditPacks:delete permission', async () => {
      clearCustomPermissions()
      const token = makeToken('VIEWER')
      const res = await request(app)
        .post(`${BASE}/purchases/${PURCHASE_ID}/refund`)
        .set('Authorization', `Bearer ${token}`)
        .send(validRefundBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 403 when CASHIER role has no creditPacks:delete permission', async () => {
      clearCustomPermissions()
      const token = makeToken('CASHIER')
      const res = await request(app)
        .post(`${BASE}/purchases/${PURCHASE_ID}/refund`)
        .set('Authorization', `Bearer ${token}`)
        .send(validRefundBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should return 200 when OWNER role has creditPacks:delete via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:delete'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(`${BASE}/purchases/${PURCHASE_ID}/refund`)
        .set('Authorization', `Bearer ${token}`)
        .send(validRefundBody)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('refunded', true)
    })

    it('should return 200 when ADMIN role has creditPacks:delete via custom permissions', async () => {
      mockCustomPermissions(['creditPacks:delete'])
      const token = makeToken('ADMIN')
      const res = await request(app)
        .post(`${BASE}/purchases/${PURCHASE_ID}/refund`)
        .set('Authorization', `Bearer ${token}`)
        .send(validRefundBody)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('refunded', true)
    })

    it('should return 403 when MANAGER role only has creditPacks:read (not delete)', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('MANAGER')
      const res = await request(app)
        .post(`${BASE}/purchases/${PURCHASE_ID}/refund`)
        .set('Authorization', `Bearer ${token}`)
        .send(validRefundBody)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })

    it('should work with cookie-based accessToken', async () => {
      mockCustomPermissions(['creditPacks:delete'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(`${BASE}/purchases/${PURCHASE_ID}/refund`)
        .set('Cookie', [`accessToken=${token}`])
        .send(validRefundBody)
      expect(res.status).toBe(200)
    })

    // Zod validation tests for refund
    it('should return 400 when reason is missing', async () => {
      mockCustomPermissions(['creditPacks:delete'])
      const token = makeToken('OWNER')
      const res = await request(app).post(`${BASE}/purchases/${PURCHASE_ID}/refund`).set('Authorization', `Bearer ${token}`).send({})
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
      expect(res.body.message).toMatch(/razon|requerida|required/i)
    })

    it('should return 400 when reason is empty string', async () => {
      mockCustomPermissions(['creditPacks:delete'])
      const token = makeToken('OWNER')
      const res = await request(app)
        .post(`${BASE}/purchases/${PURCHASE_ID}/refund`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: '' })
      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('message')
    })
  })

  // ---- Route mounting and token edge cases ----

  describe('Route mounting and malformed tokens', () => {
    it('should return 401 for malformed JWT token', async () => {
      const res = await request(app).get(BASE).set('Authorization', 'Bearer invalid.token.here')
      expect(res.status).toBe(401)
      expect(res.body).toMatchObject({ error: 'Unauthorized', message: 'Invalid token' })
    })

    it('should verify routes are mounted under correct path', async () => {
      mockCustomPermissions(['creditPacks:read'])
      const token = makeToken('OWNER')

      // Verify correct path works
      const validRes = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
      expect(validRes.status).toBe(200)

      // Verify incorrect path returns 404
      const invalidRes = await request(app).get('/api/v1/wrong/path/credit-packs').set('Authorization', `Bearer ${token}`)
      expect(invalidRes.status).toBe(404)
    })

    it('should return 401 when expired token is used', async () => {
      const expiredToken = jwt.sign(
        {
          sub: 'test-user',
          orgId: 'test-org',
          venueId: VENUE_ID,
          role: 'OWNER',
          exp: Math.floor(Date.now() / 1000) - 60, // expired 60 seconds ago
        },
        process.env.ACCESS_TOKEN_SECRET || TEST_SECRET,
      )
      const res = await request(app).get(BASE).set('Authorization', `Bearer ${expiredToken}`)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 401 when no Authorization header or cookie is set', async () => {
      const res = await request(app).get(BASE)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
      expect(res.body).toHaveProperty('message', 'No authentication token provided')
    })
  })

  // ---- SUPERADMIN bypass tests ----

  describe('SUPERADMIN role bypass', () => {
    it('should grant access to GET /credit-packs for SUPERADMIN via DB lookup', async () => {
      // SUPERADMIN is detected via prisma.staffVenue.findFirst returning a record
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-superadmin' })
      clearCustomPermissions()
      const token = makeToken('SUPERADMIN')
      const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
    })

    it('should grant access to POST /credit-packs for SUPERADMIN via DB lookup', async () => {
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-superadmin' })
      clearCustomPermissions()
      const token = makeToken('SUPERADMIN')
      const res = await request(app)
        .post(BASE)
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'SA Pack',
          price: 100,
          items: [{ productId: 'prod-1', quantity: 1 }],
        })
      expect(res.status).toBe(201)
    })

    it('should grant access to DELETE /credit-packs/:packId for SUPERADMIN via DB lookup', async () => {
      prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-superadmin' })
      clearCustomPermissions()
      const token = makeToken('SUPERADMIN')
      const res = await request(app).delete(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(204)
    })
  })

  // ---- Cross-role access summary ----

  describe('Role access matrix (comprehensive)', () => {
    const rolesWithoutAccess = ['CASHIER', 'WAITER', 'KITCHEN', 'VIEWER']

    rolesWithoutAccess.forEach(role => {
      it(`should deny ${role} access to GET /credit-packs without custom permissions`, async () => {
        clearCustomPermissions()
        const token = makeToken(role)
        const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
        expect(res.status).toBe(403)
      })

      it(`should deny ${role} access to POST /credit-packs without custom permissions`, async () => {
        clearCustomPermissions()
        const token = makeToken(role)
        const res = await request(app)
          .post(BASE)
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: 'Test',
            price: 100,
            items: [{ productId: 'p1', quantity: 1 }],
          })
        expect(res.status).toBe(403)
      })

      it(`should deny ${role} access to PATCH /credit-packs/:packId without custom permissions`, async () => {
        clearCustomPermissions()
        const token = makeToken(role)
        const res = await request(app).patch(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`).send({ name: 'Updated' })
        expect(res.status).toBe(403)
      })

      it(`should deny ${role} access to DELETE /credit-packs/:packId without custom permissions`, async () => {
        clearCustomPermissions()
        const token = makeToken(role)
        const res = await request(app).delete(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
        expect(res.status).toBe(403)
      })

      it(`should deny ${role} access to GET /credit-packs/purchases without custom permissions`, async () => {
        clearCustomPermissions()
        const token = makeToken(role)
        const res = await request(app).get(`${BASE}/purchases`).set('Authorization', `Bearer ${token}`)
        expect(res.status).toBe(403)
      })

      it(`should deny ${role} access to GET /credit-packs/transactions without custom permissions`, async () => {
        clearCustomPermissions()
        const token = makeToken(role)
        const res = await request(app).get(`${BASE}/transactions`).set('Authorization', `Bearer ${token}`)
        expect(res.status).toBe(403)
      })

      it(`should deny ${role} access to POST /balances/:balanceId/redeem without custom permissions`, async () => {
        clearCustomPermissions()
        const token = makeToken(role)
        const res = await request(app).post(`${BASE}/balances/${BALANCE_ID}/redeem`).set('Authorization', `Bearer ${token}`).send({})
        expect(res.status).toBe(403)
      })

      it(`should deny ${role} access to POST /balances/:balanceId/adjust without custom permissions`, async () => {
        clearCustomPermissions()
        const token = makeToken(role)
        const res = await request(app)
          .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
          .set('Authorization', `Bearer ${token}`)
          .send({ quantity: 1, reason: 'test' })
        expect(res.status).toBe(403)
      })

      it(`should deny ${role} access to POST /purchases/:purchaseId/refund without custom permissions`, async () => {
        clearCustomPermissions()
        const token = makeToken(role)
        const res = await request(app)
          .post(`${BASE}/purchases/${PURCHASE_ID}/refund`)
          .set('Authorization', `Bearer ${token}`)
          .send({ reason: 'test' })
        expect(res.status).toBe(403)
      })

      it(`should allow ${role} access to GET /credit-packs WITH creditPacks:read custom permission`, async () => {
        mockCustomPermissions(['creditPacks:read'])
        const token = makeToken(role)
        const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
        expect(res.status).toBe(200)
      })
    })

    const rolesWithCustomWrite = ['OWNER', 'ADMIN']

    rolesWithCustomWrite.forEach(role => {
      it(`should allow ${role} full CRUD access with all creditPacks permissions`, async () => {
        mockCustomPermissions(['creditPacks:read', 'creditPacks:create', 'creditPacks:update', 'creditPacks:delete'])
        const token = makeToken(role)

        // GET list
        const listRes = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
        expect(listRes.status).toBe(200)

        // POST create
        const createRes = await request(app)
          .post(BASE)
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: 'Full Pack',
            price: 200,
            items: [{ productId: 'prod-1', quantity: 3 }],
          })
        expect(createRes.status).toBe(201)

        // GET by id
        const getRes = await request(app).get(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
        expect(getRes.status).toBe(200)

        // PATCH update
        const updateRes = await request(app)
          .patch(`${BASE}/${PACK_ID}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Updated Pack' })
        expect(updateRes.status).toBe(200)

        // DELETE
        const deleteRes = await request(app).delete(`${BASE}/${PACK_ID}`).set('Authorization', `Bearer ${token}`)
        expect(deleteRes.status).toBe(204)

        // GET purchases
        const purchasesRes = await request(app).get(`${BASE}/purchases`).set('Authorization', `Bearer ${token}`)
        expect(purchasesRes.status).toBe(200)

        // GET customer purchases
        const custPurchasesRes = await request(app).get(`${BASE}/purchases/${CUSTOMER_ID}`).set('Authorization', `Bearer ${token}`)
        expect(custPurchasesRes.status).toBe(200)

        // GET transactions
        const txnRes = await request(app).get(`${BASE}/transactions`).set('Authorization', `Bearer ${token}`)
        expect(txnRes.status).toBe(200)

        // POST redeem
        const redeemRes = await request(app).post(`${BASE}/balances/${BALANCE_ID}/redeem`).set('Authorization', `Bearer ${token}`).send({})
        expect(redeemRes.status).toBe(200)

        // POST adjust
        const adjustRes = await request(app)
          .post(`${BASE}/balances/${BALANCE_ID}/adjust`)
          .set('Authorization', `Bearer ${token}`)
          .send({ quantity: 1, reason: 'test' })
        expect(adjustRes.status).toBe(200)

        // POST refund
        const refundRes = await request(app)
          .post(`${BASE}/purchases/${PURCHASE_ID}/refund`)
          .set('Authorization', `Bearer ${token}`)
          .send({ reason: 'test refund' })
        expect(refundRes.status).toBe(200)
      })
    })
  })
})
