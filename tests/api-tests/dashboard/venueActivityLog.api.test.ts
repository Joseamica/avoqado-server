/*
  API tests for the venue Activity Log endpoints:
    GET /api/v1/dashboard/venues/:venueId/activity-log
    GET /api/v1/dashboard/venues/:venueId/activity-log/actions
    GET /api/v1/dashboard/venues/:venueId/activity-log/entities

  Covers:
  1. PRO venue (VenueFeature VENUE_AUDIT_LOG active) + OWNER token → 200, data.logs is array
  2. FREE venue (no VENUE_AUDIT_LOG feature, no PRO plan)  + OWNER token → 403 (checkFeatureAccess)
  3. PRO venue + CASHIER token → 403 (checkPermission, activity:read not in CASHIER defaults)
  4. /actions and /entities on PRO+OWNER → 200, data is array

  Pattern follows sibling tests (manualPayment.api.test.ts, creditPack.api.test.ts):
  Prisma is globally mocked via tests/__helpers__/setup.ts (prismaMock).
  Real controller + real service run against prismaMock.

  checkFeatureAccess resolution order:
    1. venueIsExemptFromPlanGating → prisma.venue.findUnique (seatCapExempt + status)
    2. prisma.venueFeature.findFirst (active VenueFeature row for featureCode)
    3. getVenueBaseTier → prisma.venueFeature.findFirst (base plan tier code)
*/

import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'

let app: Express
const TEST_SECRET = 'test-secret'

const VENUE_ID = 'cltestvenueaudit1234567890'
const STAFF_ID = 'cltestuseridaudit123456789'
const ORG_ID = 'cltestorgidaudit1234567890'

const BASE = `/api/v1/dashboard/venues/${VENUE_ID}/activity-log`

beforeAll(async () => {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test'
  process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || TEST_SECRET
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session'
  process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie'
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb'

  jest.resetModules()

  // Bypass express-session middleware (not relevant to these routes).
  jest.mock('@/config/session', () => ({
    __esModule: true,
    default: (_req: any, _res: any, next: any) => next(),
  }))

  const mod = await import('@/app')
  app = mod.default
})

/**
 * Generate a JWT token matching AvoqadoJwtPayload shape.
 * The token venueId matches the URL param so checkPermission resolves
 * the role without an extra prisma.staffVenue.findUnique call.
 */
const makeToken = (role: string) =>
  jwt.sign(
    {
      sub: STAFF_ID,
      orgId: ORG_ID,
      venueId: VENUE_ID,
      role,
    },
    process.env.ACCESS_TOKEN_SECRET || TEST_SECRET,
  )

/**
 * Prevent accidental SUPERADMIN fallthrough: checkPermission probes
 * staffVenue.findFirst({ role: SUPERADMIN }) before evaluating role perms.
 * Default to null in every test so only the token role drives access.
 */
beforeEach(() => {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
})

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Mock prisma.venue.findUnique to return a non-exempt, non-demo venue.
 * venueIsExemptFromPlanGating calls this (seatCapExempt + status).
 * Also used by queryVenueActivityLogs to fetch the venue name.
 */
function mockNonExemptVenue() {
  prismaMock.venue.findUnique.mockResolvedValue({
    id: VENUE_ID,
    name: 'Test Venue',
    seatCapExempt: false,
    status: 'ACTIVE',
  } as any)
}

/**
 * Wire prismaMock so checkFeatureAccess('VENUE_AUDIT_LOG') passes.
 * Returns an active VenueFeature row (no trial expiry, not suspended).
 */
function mockFeatureEnabled() {
  mockNonExemptVenue()
  prismaMock.venueFeature.findFirst.mockResolvedValue({
    id: 'clf_audit_01',
    venueId: VENUE_ID,
    featureId: 'feat_audit_01',
    active: true,
    status: 'ACTIVE',
    startDate: new Date('2026-01-01'),
    endDate: null,
    trialEndsAt: null,
    isTrial: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    stripeSubscriptionId: null,
    gracePeriodEndsAt: null,
    suspendedAt: null,
    paymentFailureCount: 0,
    feature: { id: 'feat_audit_01', code: 'VENUE_AUDIT_LOG', name: 'Venue Audit Log' },
  } as any)
}

/**
 * Wire prismaMock so checkFeatureAccess('VENUE_AUDIT_LOG') returns 403.
 * venueFeature.findFirst = null (no active feature row).
 * venueFeature.findFirst for base plan tier also = null (no PRO plan).
 * This drives the middleware down the 403 path.
 */
function mockFeatureDisabled() {
  mockNonExemptVenue()
  // Both VenueFeature lookups (feature-specific + base-plan tier) return null.
  prismaMock.venueFeature.findFirst.mockResolvedValue(null)
}

/**
 * Stub activityLog queries so the real service doesn't fail on empty mocks.
 * queryVenueActivityLogs calls count + findMany in parallel.
 */
function mockActivityLogData() {
  prismaMock.activityLog.findMany.mockResolvedValue([])
  prismaMock.activityLog.count.mockResolvedValue(0)
}

// ---------------------------------------------------------------------------
// GET /activity-log
// ---------------------------------------------------------------------------

describe('GET /api/v1/dashboard/venues/:venueId/activity-log', () => {
  it('200: PRO venue + OWNER token → success, data.logs is array', async () => {
    mockFeatureEnabled()
    mockActivityLogData()

    const token = makeToken('OWNER')
    const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toBeDefined()
    expect(Array.isArray(res.body.data.logs)).toBe(true)
  })

  it('403: FREE venue (no VENUE_AUDIT_LOG feature) + OWNER token → checkFeatureAccess blocks', async () => {
    mockFeatureDisabled()

    const token = makeToken('OWNER')
    const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
    // The controller must never be reached.
    expect(prismaMock.activityLog.findMany).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.count).not.toHaveBeenCalled()
  })

  it('403: PRO venue + CASHIER token → checkPermission blocks (activity:read not in CASHIER defaults)', async () => {
    mockFeatureEnabled()

    const token = makeToken('CASHIER')
    const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('error', 'Forbidden')
    // The controller must never be reached.
    expect(prismaMock.activityLog.findMany).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /activity-log/actions
// ---------------------------------------------------------------------------

describe('GET /api/v1/dashboard/venues/:venueId/activity-log/actions', () => {
  it('200: PRO venue + OWNER token → success, data is array', async () => {
    mockFeatureEnabled()
    // getVenueDistinctActions uses findMany with distinct on the action field.
    prismaMock.activityLog.findMany.mockResolvedValue([{ action: 'PAYMENT_CREATED' } as any])

    const token = makeToken('OWNER')
    const res = await request(app).get(`${BASE}/actions`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(Array.isArray(res.body.data)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// GET /activity-log/entities
// ---------------------------------------------------------------------------

describe('GET /api/v1/dashboard/venues/:venueId/activity-log/entities', () => {
  it('200: PRO venue + OWNER token → success, data is array', async () => {
    mockFeatureEnabled()
    prismaMock.activityLog.findMany.mockResolvedValue([{ entity: 'Payment' } as any])

    const token = makeToken('OWNER')
    const res = await request(app).get(`${BASE}/entities`).set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(Array.isArray(res.body.data)).toBe(true)
  })
})
