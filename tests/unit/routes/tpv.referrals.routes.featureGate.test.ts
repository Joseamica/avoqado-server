/**
 * checkFeatureAccess('REFERRAL_PROGRAM') gating + venueId plumbing for the /tpv referrals
 * capture-only surface (superficie /tpv, 2026-07-27).
 *
 * Same technique as tests/unit/routes/tpv-table-gating.test.ts: mounts the REAL tpv.routes.ts
 * router with the REAL checkFeatureAccess middleware, mocking only auth (context injector),
 * checkPermission (passthrough — tpv.referrals.routes.permissions.test.ts already covers the
 * exact permission strings + the force-override asymmetry), validateRequest (passthrough),
 * prisma, and the referral-capture SERVICE layer.
 *
 * Deliberately mocks the SERVICE layer (`referralCapture.service`), not the controller: the
 * route wires `referralsTpvController.validate/captureCode/forceOverride`, which
 * `referrals.tpv.controller.ts` re-exports VERBATIM from `dashboard/referrals/referrals.controller`
 * — that real controller code (`{ venueId: req.params.venueId, ...req.body }`) runs unmocked, so
 * asserting the service mock's call args is what actually proves req.params.venueId (the URL
 * segment, not the token's home venue nor some other field) reaches the handler — not just that
 * routing "looks right" on paper.
 */

import express from 'express'
import request from 'supertest'

// 1. Auth: inject authContext from a test header (tpv.routes.ts calls authenticateTokenMiddleware
//    inline per-route, no parent router.use).
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

// 2. checkPermission: passthrough — not under test here (see tpv.referrals.routes.permissions.test.ts).
//    KEEP the real resolveRequestVenueId — checkFeatureAccess.middleware.ts imports it from here.
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))

// 3. validateRequest: passthrough — body/param shape is not under test.
jest.mock('@/middlewares/validation', () => ({
  ...jest.requireActual('@/middlewares/validation'),
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}))

// 4. prisma: only the models checkFeatureAccess touches.
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn() }, // SUPERADMIN bypass (requestIsSuperAdmin)
    venue: { findUnique: jest.fn() }, // venueIsExemptFromPlanGating (grandfathered/demo)
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() }, // own grant + getVenueBaseTier
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// 5. Referral capture SERVICE layer — mocked here (not the controller) so the REAL controller
//    code runs and the assertions below prove the venueId plumbing through it.
jest.mock('@/services/referrals/referralCapture.service', () => ({
  validateReferralCode: jest.fn(),
  captureReferral: jest.fn(),
  forceOverrideReferral: jest.fn(),
  resolveStaffVenueId: jest.fn(),
}))

// ─── Import router AFTER the mocks ─────────────────────────────────────────────
import prisma from '@/utils/prismaClient'
import tpvRouter from '@/routes/tpv.routes'
import * as capture from '@/services/referrals/referralCapture.service'

const staffVenueFindFirst = (prisma as any).staffVenue.findFirst as jest.Mock
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const vfFindFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const vfFindMany = (prisma as any).venueFeature.findMany as jest.Mock
const validateReferralCodeMock = capture.validateReferralCode as jest.Mock
const captureReferralMock = capture.captureReferral as jest.Mock
const forceOverrideReferralMock = capture.forceOverrideReferral as jest.Mock
const resolveStaffVenueIdMock = capture.resolveStaffVenueId as jest.Mock

const VENUE_ID = 'venue-referrals-1'
const OTHER_VENUE_ID = 'venue-referrals-OTHER'

function authHeader(ctx: object): Record<string, string> {
  return { 'x-test-auth-context': JSON.stringify(ctx) }
}

const cashierCtx = { userId: 'user-1', orgId: 'org-1', venueId: VENUE_ID, role: 'CASHIER' }

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/tpv', tpvRouter)
  // Safety net: turns any thrown error into JSON instead of an HTML stack trace.
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.statusCode || 500).json({ error: err?.message || 'error' }))
  return app
}

const FREE_ACTIVE_VENUE = { seatCapExempt: false, status: 'ACTIVE' }
const GRANDFATHERED_VENUE = { seatCapExempt: true, status: 'ACTIVE' }
const PRO_PLAN_ROW = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }

beforeEach(() => {
  jest.clearAllMocks()
  staffVenueFindFirst.mockResolvedValue(null) // not a platform superadmin
  venueFindUnique.mockResolvedValue(FREE_ACTIVE_VENUE)
  vfFindFirst.mockResolvedValue(null) // no explicit own REFERRAL_PROGRAM grant
  vfFindMany.mockResolvedValue([]) // FREE tier by default (no active paid base plan)
  validateReferralCodeMock.mockResolvedValue({ valid: true, referrer: {}, discountPercent: 10 })
  captureReferralMock.mockResolvedValue({ id: 'referral-1' })
  forceOverrideReferralMock.mockResolvedValue({ id: 'referral-2' })
  resolveStaffVenueIdMock.mockResolvedValue('staff-venue-1')
})

describe('POST /tpv/venues/:venueId/referrals/validate', () => {
  it('FREE venue → 403 REFERRAL_PROGRAM, service never reached', async () => {
    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/referrals/validate`)
      .set(authHeader(cashierCtx))
      .send({ referralCode: 'ABC123', newCustomerId: 'cust-1' })

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('REFERRAL_PROGRAM')
    expect(res.body.subscriptionRequired).toBe(true)
    expect(validateReferralCodeMock).not.toHaveBeenCalled()
  })

  it('PRO venue → 200, service reached with venueId taken from the URL', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/referrals/validate`)
      .set(authHeader(cashierCtx))
      .send({ referralCode: 'ABC123', newCustomerId: 'cust-1' })

    expect(res.status).toBe(200)
    expect(validateReferralCodeMock).toHaveBeenCalledTimes(1)
    expect(validateReferralCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: VENUE_ID, referralCode: 'ABC123', newCustomerId: 'cust-1' }),
    )
  })

  it('GRANDFATHERED venue → 200 (exempt from plan gating)', async () => {
    venueFindUnique.mockResolvedValue(GRANDFATHERED_VENUE)

    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/referrals/validate`)
      .set(authHeader(cashierCtx))
      .send({ referralCode: 'ABC123', newCustomerId: 'cust-1' })

    expect(res.status).toBe(200)
  })

  it('cross-tenant probe (URL venueId ≠ token venueId) → 403 from validateVenueAccess; checkFeatureAccess and the service never run', async () => {
    const res = await request(createApp())
      .post(`/tpv/venues/${OTHER_VENUE_ID}/referrals/validate`)
      .set(authHeader(cashierCtx)) // token is scoped to VENUE_ID, not OTHER_VENUE_ID
      .send({ referralCode: 'ABC123', newCustomerId: 'cust-1' })

    expect(res.status).toBe(403)
    expect(res.body.message).toBe('No tienes acceso a este venue')
    expect(res.body.featureCode).toBeUndefined() // proves this is validateVenueAccess's 403, not checkFeatureAccess's
    // requestIsSuperAdmin (prisma.staffVenue.findFirst) is checkFeatureAccess's FIRST call — uncalled means it never started.
    expect(staffVenueFindFirst).not.toHaveBeenCalled()
    expect(venueFindUnique).not.toHaveBeenCalled()
    expect(validateReferralCodeMock).not.toHaveBeenCalled()
  })
})

describe('POST /tpv/venues/:venueId/referrals/capture', () => {
  it('FREE venue → 403 REFERRAL_PROGRAM, service never reached', async () => {
    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/referrals/capture`)
      .set(authHeader(cashierCtx))
      .send({ referralCode: 'ABC123', newCustomerId: 'cust-1', capturedByStaffVenueId: 'sv-1' })

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('REFERRAL_PROGRAM')
    expect(captureReferralMock).not.toHaveBeenCalled()
  })

  it('PRO venue → 201, service reached with venueId taken from the URL', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(createApp())
      .post(`/tpv/venues/${VENUE_ID}/referrals/capture`)
      .set(authHeader(cashierCtx))
      .send({ referralCode: 'ABC123', newCustomerId: 'cust-1', capturedByStaffVenueId: 'sv-1' })

    expect(res.status).toBe(201)
    expect(captureReferralMock).toHaveBeenCalledWith(expect.objectContaining({ venueId: VENUE_ID, capturedByStaffVenueId: 'sv-1' }))
  })

  it('cross-tenant probe → 403 from validateVenueAccess, service never runs', async () => {
    const res = await request(createApp())
      .post(`/tpv/venues/${OTHER_VENUE_ID}/referrals/capture`)
      .set(authHeader(cashierCtx))
      .send({ referralCode: 'ABC123', newCustomerId: 'cust-1', capturedByStaffVenueId: 'sv-1' })

    expect(res.status).toBe(403)
    expect(res.body.message).toBe('No tienes acceso a este venue')
    expect(captureReferralMock).not.toHaveBeenCalled()
  })
})

describe('POST /tpv/venues/:venueId/referrals/force-override', () => {
  const body = {
    referralCode: 'ABC123',
    existingCustomerId: 'cust-1',
    capturedByStaffVenueId: 'sv-1',
    reason: 'cliente ya tenia cuenta activa',
  }

  it('FREE venue → 403 REFERRAL_PROGRAM, service never reached', async () => {
    const res = await request(createApp()).post(`/tpv/venues/${VENUE_ID}/referrals/force-override`).set(authHeader(cashierCtx)).send(body)

    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('REFERRAL_PROGRAM')
    expect(forceOverrideReferralMock).not.toHaveBeenCalled()
  })

  it('PRO venue → 201, service reached with venueId from the URL + the resolved managerStaffVenueId', async () => {
    vfFindMany.mockResolvedValue([PRO_PLAN_ROW])

    const res = await request(createApp()).post(`/tpv/venues/${VENUE_ID}/referrals/force-override`).set(authHeader(cashierCtx)).send(body)

    expect(res.status).toBe(201)
    expect(resolveStaffVenueIdMock).toHaveBeenCalledWith(VENUE_ID, 'user-1')
    expect(forceOverrideReferralMock).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: VENUE_ID, managerStaffVenueId: 'staff-venue-1' }),
    )
  })

  it('cross-tenant probe → 403 from validateVenueAccess, service never runs', async () => {
    const res = await request(createApp())
      .post(`/tpv/venues/${OTHER_VENUE_ID}/referrals/force-override`)
      .set(authHeader(cashierCtx))
      .send(body)

    expect(res.status).toBe(403)
    expect(res.body.message).toBe('No tienes acceso a este venue')
    expect(forceOverrideReferralMock).not.toHaveBeenCalled()
  })
})
