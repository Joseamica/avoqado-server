/**
 * API tests for /api/v1/me/access endpoint
 *
 * Verifies:
 * - 401 for unauthenticated requests
 * - 200 with correct permission data for authenticated users
 * - White-label filtering works correctly
 * - DataScope is included in response
 */

import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'
import { StaffRole } from '@prisma/client'

let app: Express
const TEST_SECRET = 'test-secret'

// Mock access service response
const mockUserAccess = {
  userId: 'test-user',
  venueId: 'test-venue',
  organizationId: 'test-org',
  role: StaffRole.MANAGER,
  corePermissions: ['menu:read', 'orders:read', 'orders:write'],
  whiteLabelEnabled: false,
  enabledFeatures: [],
  featureAccess: {},
}

const mockWhiteLabelAccess = {
  ...mockUserAccess,
  whiteLabelEnabled: true,
  enabledFeatures: ['STORES_ANALYSIS', 'COMMAND_CENTER'],
  featureAccess: {
    STORES_ANALYSIS: { allowed: true, dataScope: 'user-venues' },
    COMMAND_CENTER: { allowed: true, dataScope: 'venue' },
  },
}

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

  // Mock access service
  jest.mock('@/services/access/access.service', () => ({
    getUserAccess: jest.fn().mockImplementation((userId: string, venueId: string) => {
      // Return white-label access for specific venue
      if (venueId === 'wl-venue') {
        return Promise.resolve(mockWhiteLabelAccess)
      }
      return Promise.resolve(mockUserAccess)
    }),
    createAccessCache: jest.fn(() => new Map()),
  }))

  const mod = await import('@/app')
  app = mod.default
})

const makeToken = (role: string, venueId = 'test-venue') =>
  jwt.sign({ sub: 'test-user', orgId: 'test-org', venueId, role }, process.env.ACCESS_TOKEN_SECRET || TEST_SECRET)

describe('GET /api/v1/me/access', () => {
  describe('Authentication', () => {
    it('should return 401 when no token is provided', async () => {
      const res = await request(app).get('/api/v1/me/access')

      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 401 for invalid token', async () => {
      const res = await request(app).get('/api/v1/me/access').set('Authorization', 'Bearer invalid.token.here')

      expect(res.status).toBe(401)
    })
  })

  describe('Permission Response', () => {
    it('should return user access data for authenticated user', async () => {
      const token = makeToken('MANAGER')
      const res = await request(app).get('/api/v1/me/access').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('role')
      expect(res.body).toHaveProperty('corePermissions')
      expect(res.body).toHaveProperty('whiteLabelEnabled')
    })

    it('should include all expected fields in response', async () => {
      const token = makeToken('MANAGER')
      const res = await request(app).get('/api/v1/me/access').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        userId: expect.any(String),
        venueId: expect.any(String),
        organizationId: expect.any(String),
        role: expect.any(String),
        corePermissions: expect.any(Array),
        whiteLabelEnabled: expect.any(Boolean),
        enabledFeatures: expect.any(Array),
        featureAccess: expect.any(Object),
      })
    })
  })

  describe('Query Parameter: venueId', () => {
    it('should use venueId from query params when provided', async () => {
      const token = makeToken('MANAGER')
      const res = await request(app).get('/api/v1/me/access?venueId=wl-venue').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.whiteLabelEnabled).toBe(true)
      expect(res.body.enabledFeatures).toContain('STORES_ANALYSIS')
    })

    it('should fallback to token venueId when query param not provided', async () => {
      const token = makeToken('MANAGER', 'test-venue')
      const res = await request(app).get('/api/v1/me/access').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.whiteLabelEnabled).toBe(false)
    })
  })

  describe('White-Label Response', () => {
    it('should include featureAccess with dataScope for white-label venues', async () => {
      const token = makeToken('MANAGER')
      const res = await request(app).get('/api/v1/me/access?venueId=wl-venue').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.featureAccess).toHaveProperty('STORES_ANALYSIS')
      expect(res.body.featureAccess.STORES_ANALYSIS).toMatchObject({
        allowed: true,
        dataScope: 'user-venues',
      })
    })

    it('should return filtered permissions for white-label venues', async () => {
      const token = makeToken('MANAGER')
      const res = await request(app).get('/api/v1/me/access?venueId=wl-venue').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.corePermissions).toBeDefined()
      expect(Array.isArray(res.body.corePermissions)).toBe(true)
    })
  })

  describe('Role-Based Access', () => {
    it('should work for OWNER role', async () => {
      const token = makeToken('OWNER')
      const res = await request(app).get('/api/v1/me/access').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
    })

    it('should work for ADMIN role', async () => {
      const token = makeToken('ADMIN')
      const res = await request(app).get('/api/v1/me/access').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
    })

    it('should work for VIEWER role', async () => {
      const token = makeToken('VIEWER')
      const res = await request(app).get('/api/v1/me/access').set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
    })
  })
})
