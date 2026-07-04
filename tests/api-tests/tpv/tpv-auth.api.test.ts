/*
  tests/api-tests/tpv/tpv-auth.api.test.ts
  Verifies authentication (401) and authorization (403) enforcement on TPV endpoints.

  Middleware order on every route under test (src/routes/tpv.routes.ts):
    authenticateTokenMiddleware -> checkPermission -> validateRequest -> controller
  so 401/403 short-circuit BEFORE Zod validation and before any controller/DB work.

  History of intentional behavior changes these tests track:
  - Commit 9feae86a migrated these routes from authorizeRole to checkPermission.
    Under DEFAULT_PERMISSIONS + PERMISSION_DEPENDENCIES (src/lib/permissions.ts),
    VIEWER is a read-only role that legitimately holds home:read / orders:read /
    payments:read / shifts:read, so the old "VIEWER -> 403 everywhere" cases no
    longer reflect intentional behavior (VIEWER passes authorization and the old
    non-cuid venueId then failed Zod with 400).
  - Commit 11962d82 changed /venues/:venueId/payments from GET to POST (same
    auth chain: authenticateTokenMiddleware + checkPermission('payments:read')).

  Which 403s are even possible by ROLE (after PERMISSION_DEPENDENCIES resolution):
  - home:read    -> held by EVERY role (explicit in all DEFAULT_PERMISSIONS blocks).
  - orders:read  -> held by EVERY role (explicitly, or implied by home:read).
  - payments:read-> held by EVERY role (implied by home:read AND by orders:read).
  - shifts:read  -> NOT held by KITCHEN or HOST (nothing in their defaults implies
    it), so those roles genuinely 403 on the shift routes.
  For routes whose permission every role holds, the real authorization perimeter
  is tenant isolation: a token for a venue the user has no access to is rejected
  by checkPermission's resolveUserRoleForVenue with 403 "No access to this venue".
*/

// Ensure required env vars exist before importing app/config
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
// DATABASE_URL required by env.ts, but we mock session middleware to avoid real DB usage
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

// Mock session middleware to avoid DB/session store in tests
jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})

// Mock Swagger setup to avoid extra middleware complexity in tests
jest.mock('../../../src/config/swagger', () => ({
  __esModule: true,
  setupSwaggerUI: jest.fn(),
}))

import request from 'supertest'
import jwt from 'jsonwebtoken'
import { prismaMock } from '@tests/__helpers__/setup'

// Import the real Express app after env + mocks are set

const app = require('../../../src/app').default

const API_PREFIX = '/api/v1/tpv'
// cuid-format ids so requests would survive Zod param validation if a test ever
// reached validateRequest (401/403 paths stop earlier, but keep them valid).
const venueId = 'clvenuetpvauth00000000001'
const otherVenueId = 'clvenuetpvauth00000000002' // venue the token holder does NOT belong to
const orderId = 'clordertpvauth00000000001'

function makeToken(role: string, tokenVenueId: string = venueId) {
  const payload = {
    sub: 'user_test',
    orgId: 'org_test',
    venueId: tokenVenueId,
    role,
  }
  return jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })
}

beforeEach(() => {
  // Deterministic checkPermission behavior:
  // - staffVenue.findFirst -> null: SUPERADMIN probe finds nothing (no bypass).
  // - staffVenue.findUnique / venue.findUnique -> null: cross-venue lookups find
  //   no membership and no venue -> resolveUserRoleForVenue returns role=null.
  // - venueRolePermission.findUnique -> null: roles evaluate against
  //   DEFAULT_PERMISSIONS only (no custom overrides).
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
})

describe('TPV routes - authentication and authorization', () => {
  // [method, path] — POST for /payments since commit 11962d82 (GET was removed -> 404).
  const routes: Array<[method: 'get' | 'post', path: string]> = [
    ['get', `${API_PREFIX}/venues/${venueId}`],
    ['get', `${API_PREFIX}/venues/${venueId}/orders`],
    ['get', `${API_PREFIX}/venues/${venueId}/orders/${orderId}`],
    ['post', `${API_PREFIX}/venues/${venueId}/payments`],
    ['get', `${API_PREFIX}/venues/${venueId}/shift`],
    ['get', `${API_PREFIX}/venues/${venueId}/shifts`],
    ['get', `${API_PREFIX}/venues/${venueId}/shifts-summary`],
  ]

  describe('401 Unauthorized when token is missing or invalid', () => {
    it.each(routes)('%s %s -> 401 without Authorization header', async (method, path) => {
      const res = await request(app)[method](path)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it.each(routes)('%s %s -> 401 with malformed Bearer token', async (method, path) => {
      const res = await request(app)[method](path).set('Authorization', 'Bearer invalid.token.here')
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })
  })

  describe('403 Forbidden on cross-venue access (tenant isolation)', () => {
    // Token venueId != URL venueId and the user has no StaffVenue membership in
    // the target venue (and the venue itself resolves to nothing) -> checkPermission
    // denies with "No access to this venue" BEFORE any permission evaluation.
    it.each(routes)('%s %s -> 403 when token belongs to another venue', async (method, path) => {
      const crossVenueToken = makeToken('OWNER', otherVenueId)
      const res = await request(app)[method](path).set('Authorization', `Bearer ${crossVenueToken}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
      expect(res.body).toHaveProperty('message', 'No access to this venue')
    })
  })

  describe('403 Forbidden when role lacks the required permission', () => {
    // Only the shift routes have a role that GENUINELY lacks their permission:
    // KITCHEN's defaults (home:read, orders:read, orders:update, menu:read,
    // calendar:connect_self) neither contain nor imply shifts:read.
    //
    // No role-based 403 case exists for the other routes — intentional, not a gap:
    // - GET /venues/:venueId requires home:read, which EVERY role holds.
    // - GET /orders and /orders/:orderId require orders:read, which every role
    //   holds (explicitly or implied by home:read via PERMISSION_DEPENDENCIES).
    // - POST /payments requires payments:read, which every role holds (implied
    //   by both home:read and orders:read).
    // For those, the authorization perimeter is tenant isolation (tested above).
    const shiftRoutes: Array<[method: 'get' | 'post', path: string]> = [
      ['get', `${API_PREFIX}/venues/${venueId}/shift`],
      ['get', `${API_PREFIX}/venues/${venueId}/shifts`],
      ['get', `${API_PREFIX}/venues/${venueId}/shifts-summary`],
    ]

    it.each(shiftRoutes)('%s %s -> 403 with KITCHEN role (lacks shifts:read)', async (method, path) => {
      const kitchenToken = makeToken('KITCHEN')
      const res = await request(app)[method](path).set('Authorization', `Bearer ${kitchenToken}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
      expect(res.body).toHaveProperty('required', 'shifts:read')
    })
  })

  // Note: 200 OK happy-path tests are intentionally omitted here to avoid DB dependencies.
  // If needed, controller modules (e.g., order.tpv.controller) can be mocked to return stubbed data
  // and then we can assert 200 for an allowed role such as CASHIER.
})
