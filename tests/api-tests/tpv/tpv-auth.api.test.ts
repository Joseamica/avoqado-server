/*
  tests/api-tests/tpv/tpv-auth.api.test.ts
  Verifies authentication (401) and authorization (403) enforcement on TPV GET endpoints.
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

// Import the real Express app after env + mocks are set
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../../../src/app').default

const API_PREFIX = '/api/v1/tpv'
const venueId = 'venue_test_123' // not validated on 401/403 paths (blocked before zod)
const orderId = 'order_test_123'

function makeToken(role: string) {
  const payload = {
    sub: 'user_test',
    orgId: 'org_test',
    venueId,
    role,
  }
  return jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })
}

describe('TPV GET routes - authentication and authorization', () => {
  const routes: string[] = [
    `${API_PREFIX}/venues/${venueId}`,
    `${API_PREFIX}/venues/${venueId}/orders`,
    `${API_PREFIX}/venues/${venueId}/orders/${orderId}`,
    `${API_PREFIX}/venues/${venueId}/payments`,
    `${API_PREFIX}/venues/${venueId}/shift`,
    `${API_PREFIX}/venues/${venueId}/shifts`,
    `${API_PREFIX}/venues/${venueId}/shifts-summary`,
  ]

  const viewerToken = makeToken('VIEWER') // not allowed by authorizeRole
  const cashierToken = makeToken('CASHIER') // allowed

  describe('401 Unauthorized when token is missing or invalid', () => {
    it.each(routes.map(p => [p]))('GET %s -> 401 without Authorization header', async path => {
      const res = await request(app).get(path)
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it.each(routes.map(p => [p]))('GET %s -> 401 with malformed Bearer token', async path => {
      const res = await request(app).get(path).set('Authorization', 'Bearer invalid.token.here')
      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })
  })

  describe('403 Forbidden when role is not permitted', () => {
    it.each(routes.map(p => [p]))('GET %s -> 403 with VIEWER role', async path => {
      const res = await request(app).get(path).set('Authorization', `Bearer ${viewerToken}`)
      expect(res.status).toBe(403)
      expect(res.body).toHaveProperty('error', 'Forbidden')
    })
  })

  // Note: 200 OK happy-path tests are intentionally omitted here to avoid DB dependencies.
  // If needed, controller modules (e.g., order.tpv.controller) can be mocked to return stubbed data
  // and then we can assert 200 for an allowed role such as CASHIER.
})
