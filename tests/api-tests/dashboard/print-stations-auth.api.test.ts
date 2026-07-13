/*
  tests/api-tests/dashboard/print-stations-auth.api.test.ts

  Verifies the HTTP layer of PRINT_STATIONS: that every route is actually wired,
  requires authentication (401), enforces its permission gate (403), and enforces
  tenant isolation (403 cross-venue). These short-circuit BEFORE any DB/controller
  work, so no real DB is needed (Prisma is mocked via the api-tests setup).

  Middleware order (dashboard sub-router mounted with authenticateTokenMiddleware):
    authenticateTokenMiddleware -> checkPermission('printers:read'|'printers:manage') -> validateRequest -> controller
  Mobile routes: authenticateTokenMiddleware -> checkPermission('orders:read'|'orders:update') -> validateRequest -> controller

  Permission facts (src/lib/permissions.ts):
  - printers:read / printers:manage → MANAGER (explicit) + ADMIN/OWNER (via 'printers:*') + SUPERADMIN.
    WAITER's defaults do NOT contain or imply either → WAITER genuinely 403s on every print-stations route.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))

import request from 'supertest'
import jwt from 'jsonwebtoken'
import { prismaMock } from '@tests/__helpers__/setup'

const app = require('../../../src/app').default

const DASH = '/api/v1/dashboard'
const MOBILE = '/api/v1/mobile'
const venueId = 'clvenueprint0000000000001'
const otherVenueId = 'clvenueprint0000000000002' // venue the token holder does NOT belong to
const printerId = 'clprinterprint0000000001'
const stationId = 'clstationprint0000000001'

function makeToken(role: string, tokenVenueId: string = venueId) {
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: tokenVenueId, role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

// [method, path, requiredPermission]
const dashRoutes: Array<['get' | 'post' | 'put' | 'delete', string, string]> = [
  ['get', `${DASH}/venues/${venueId}/print-stations/printers`, 'printers:read'],
  ['post', `${DASH}/venues/${venueId}/print-stations/printers`, 'printers:manage'],
  ['put', `${DASH}/venues/${venueId}/print-stations/printers/${printerId}`, 'printers:manage'],
  ['delete', `${DASH}/venues/${venueId}/print-stations/printers/${printerId}`, 'printers:manage'],
  ['get', `${DASH}/venues/${venueId}/print-stations/gateway`, 'printers:read'],
  ['put', `${DASH}/venues/${venueId}/print-stations/gateway`, 'printers:manage'],
  ['get', `${DASH}/venues/${venueId}/print-stations/routing`, 'printers:read'],
  ['put', `${DASH}/venues/${venueId}/print-stations/routing`, 'printers:manage'],
  ['post', `${DASH}/venues/${venueId}/print-stations/routing/preview`, 'printers:read'],
  ['get', `${DASH}/venues/${venueId}/print-stations`, 'printers:read'],
  ['post', `${DASH}/venues/${venueId}/print-stations`, 'printers:manage'],
  ['put', `${DASH}/venues/${venueId}/print-stations/${stationId}`, 'printers:manage'],
  ['delete', `${DASH}/venues/${venueId}/print-stations/${stationId}`, 'printers:manage'],
]

const mobileRoutes: Array<['get' | 'post', string]> = [
  ['get', `${MOBILE}/venues/${venueId}/print-config`],
  ['post', `${MOBILE}/venues/${venueId}/print-jobs/sync`],
  ['post', `${MOBILE}/venues/${venueId}/print-gateway/heartbeat`],
]

const allRoutes: Array<['get' | 'post' | 'put' | 'delete', string]> = [
  ...dashRoutes.map(([m, p]) => [m, p] as ['get' | 'post' | 'put' | 'delete', string]),
  ...mobileRoutes.map(([m, p]) => [m, p] as ['get' | 'post', string]),
]

beforeEach(() => {
  // Deterministic checkPermission: no SUPERADMIN bypass, no cross-venue membership, no custom overrides.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
})

describe('PRINT_STATIONS routes — authentication & authorization (HTTP layer)', () => {
  describe('401 Unauthorized when the token is missing/invalid', () => {
    it.each(allRoutes)('%s %s → 401 without Authorization header', async (method, path) => {
      const res = await request(app)[method](path)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it.each(allRoutes)('%s %s → 401 with a malformed Bearer token', async (method, path) => {
      const res = await request(app)[method](path).set('Authorization', 'Bearer not.a.jwt')
      expect(res.status).toBe(401)
    })
  })

  describe('403 Forbidden on cross-venue access (tenant isolation)', () => {
    it.each(allRoutes)('%s %s → 403 when the token belongs to another venue', async (method, path) => {
      const crossVenueToken = makeToken('OWNER', otherVenueId)
      const res = await request(app)[method](path).set('Authorization', `Bearer ${crossVenueToken}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('message', 'No access to this venue')
    })
  })

  describe('403 Forbidden when the role lacks the printers permission (WAITER)', () => {
    it.each(dashRoutes)('%s %s → 403 with WAITER (lacks %s)', async (method, path, requiredPerm) => {
      const waiterToken = makeToken('WAITER')
      const res = await request(app)[method](path).set('Authorization', `Bearer ${waiterToken}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
      expect(res.body).toHaveProperty('required', requiredPerm)
    })
  })
})
