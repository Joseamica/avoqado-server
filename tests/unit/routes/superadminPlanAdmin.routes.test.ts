/**
 * Superadmin plan-admin ROUTE tests — exercises the REAL Zod schemas + the superadmin guard.
 *
 * Mounts the actual superadmin router behind a mini Express app, mocking only:
 *  - authenticateTokenMiddleware  (injects authContext from a test header)
 *  - checkPermission              (gate on 'system:manage' — superadmin only)
 *  - the 3 plan-admin service fns  (so we assert wire-through + envelope, not DB writes)
 *
 * Focus: the route-level Zod validation (Spanish messages) — especially that the trial
 * endpoint rejects days 0 and 400 — and the happy-path envelope `{ success, data: PlanState }`.
 *
 * Mirrors tests/unit/routes/organizationConfig.routes.test.ts.
 */

import express from 'express'
import request from 'supertest'

// Inject authContext from a JSON header; default to a superadmin context.
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    req.authContext = ctx ? JSON.parse(ctx as string) : { userId: 'superadmin-1', role: 'SUPERADMIN' }
    next()
  },
}))

// Gate on system:manage — allow SUPERADMIN, 403 otherwise (mirrors the real guard's effect).
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: () => (req: any, res: any, next: any) => {
    if (req.authContext?.role === 'SUPERADMIN') return next()
    return res.status(403).json({ success: false, message: 'Forbidden' })
  },
}))

// Mock the plan-admin service fns used by the controller (other superadmin service fns are
// untouched — the router only invokes these three for the plan routes under test).
jest.mock('@/services/dashboard/superadmin.service', () => {
  const actual = jest.requireActual('@/services/dashboard/superadmin.service')
  return {
    ...actual,
    setVenueGrandfathered: jest.fn(),
    assignCompPlan: jest.fn(),
    extendPlanTrial: jest.fn(),
  }
})

import superadminRouter from '@/routes/dashboard/superadmin.routes'
import * as superadminService from '@/services/dashboard/superadmin.service'

const mockedSetGrandfathered = superadminService.setVenueGrandfathered as jest.Mock
const mockedAssignComp = superadminService.assignCompPlan as jest.Mock
const mockedExtendTrial = superadminService.extendPlanTrial as jest.Mock

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/dashboard/superadmin', superadminRouter)
  // Minimal error handler mirroring the app's envelope for BadRequestError (status 400).
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message })
  })
  return app
}

const VENUE_ID = 'venue-test-1'
const SUPER = JSON.stringify({ userId: 'superadmin-1', role: 'SUPERADMIN' })
const CASHIER = JSON.stringify({ userId: 'cashier-1', role: 'CASHIER' })

function planState(overrides: Record<string, any> = {}) {
  return {
    hasPlan: false,
    state: 'none',
    planTier: null,
    trialEndsAt: null,
    grandfathered: false,
    stripeSubscriptionId: null,
    ...overrides,
  }
}

beforeEach(() => jest.clearAllMocks())

describe('POST /plan/grandfathered', () => {
  it('superadmin: toggles grandfathered=true and returns PlanState', async () => {
    mockedSetGrandfathered.mockResolvedValue(planState({ grandfathered: true }))
    const res = await request(createApp())
      .post(`/api/v1/dashboard/superadmin/venues/${VENUE_ID}/plan/grandfathered`)
      .set('x-test-auth-context', SUPER)
      .send({ grandfathered: true })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.grandfathered).toBe(true)
    expect(mockedSetGrandfathered).toHaveBeenCalledWith(VENUE_ID, true)
  })

  it('non-superadmin (CASHIER) → 403', async () => {
    const res = await request(createApp())
      .post(`/api/v1/dashboard/superadmin/venues/${VENUE_ID}/plan/grandfathered`)
      .set('x-test-auth-context', CASHIER)
      .send({ grandfathered: true })

    expect(res.status).toBe(403)
    expect(mockedSetGrandfathered).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean grandfathered with 400 (Spanish message)', async () => {
    const res = await request(createApp())
      .post(`/api/v1/dashboard/superadmin/venues/${VENUE_ID}/plan/grandfathered`)
      .set('x-test-auth-context', SUPER)
      .send({ grandfathered: 'yes' })

    expect(res.status).toBe(400)
    expect(res.body.message).toContain('booleano')
    expect(mockedSetGrandfathered).not.toHaveBeenCalled()
  })
})

describe('POST /plan/comp', () => {
  it('comp PRO → PlanState.planTier PRO, no stripe sub', async () => {
    mockedAssignComp.mockResolvedValue(planState({ hasPlan: true, state: 'active', planTier: 'PRO' }))
    const res = await request(createApp())
      .post(`/api/v1/dashboard/superadmin/venues/${VENUE_ID}/plan/comp`)
      .set('x-test-auth-context', SUPER)
      .send({ tier: 'PRO' })

    expect(res.status).toBe(200)
    expect(res.body.data.planTier).toBe('PRO')
    expect(res.body.data.stripeSubscriptionId).toBeNull()
    expect(mockedAssignComp).toHaveBeenCalledWith(VENUE_ID, 'PRO')
  })

  it('comp FREE → PlanState.planTier null', async () => {
    mockedAssignComp.mockResolvedValue(planState({ planTier: null }))
    const res = await request(createApp())
      .post(`/api/v1/dashboard/superadmin/venues/${VENUE_ID}/plan/comp`)
      .set('x-test-auth-context', SUPER)
      .send({ tier: 'FREE' })

    expect(res.status).toBe(200)
    expect(res.body.data.planTier).toBeNull()
    expect(mockedAssignComp).toHaveBeenCalledWith(VENUE_ID, 'FREE')
  })

  it('rejects an unknown tier with 400 (Spanish message)', async () => {
    const res = await request(createApp())
      .post(`/api/v1/dashboard/superadmin/venues/${VENUE_ID}/plan/comp`)
      .set('x-test-auth-context', SUPER)
      .send({ tier: 'GOLD' })

    expect(res.status).toBe(400)
    expect(res.body.message).toContain('FREE')
    expect(mockedAssignComp).not.toHaveBeenCalled()
  })
})

describe('POST /plan/trial', () => {
  it('extends a PRO trial → PlanState state trial, trialEndsAt set', async () => {
    const ends = new Date(Date.now() + 30 * 86400000).toISOString()
    mockedExtendTrial.mockResolvedValue(planState({ hasPlan: true, state: 'trial', planTier: 'PRO', trialEndsAt: ends }))
    const res = await request(createApp())
      .post(`/api/v1/dashboard/superadmin/venues/${VENUE_ID}/plan/trial`)
      .set('x-test-auth-context', SUPER)
      .send({ tier: 'PRO', days: 30 })

    expect(res.status).toBe(200)
    expect(res.body.data.state).toBe('trial')
    expect(res.body.data.trialEndsAt).toBe(ends)
    expect(mockedExtendTrial).toHaveBeenCalledWith(VENUE_ID, 'PRO', 30)
  })

  it('rejects days = 0 with 400 (Spanish message), service NOT called', async () => {
    const res = await request(createApp())
      .post(`/api/v1/dashboard/superadmin/venues/${VENUE_ID}/plan/trial`)
      .set('x-test-auth-context', SUPER)
      .send({ tier: 'PRO', days: 0 })

    expect(res.status).toBe(400)
    expect(res.body.message).toContain('al menos 1 día')
    expect(mockedExtendTrial).not.toHaveBeenCalled()
  })

  it('rejects days = 400 with 400 (Spanish message), service NOT called', async () => {
    const res = await request(createApp())
      .post(`/api/v1/dashboard/superadmin/venues/${VENUE_ID}/plan/trial`)
      .set('x-test-auth-context', SUPER)
      .send({ tier: 'PRO', days: 400 })

    expect(res.status).toBe(400)
    expect(res.body.message).toContain('365')
    expect(mockedExtendTrial).not.toHaveBeenCalled()
  })

  it('rejects a non-integer days with 400', async () => {
    const res = await request(createApp())
      .post(`/api/v1/dashboard/superadmin/venues/${VENUE_ID}/plan/trial`)
      .set('x-test-auth-context', SUPER)
      .send({ tier: 'PRO', days: 14.5 })

    expect(res.status).toBe(400)
    expect(mockedExtendTrial).not.toHaveBeenCalled()
  })

  it('rejects FREE tier on the trial endpoint (only PRO/PREMIUM)', async () => {
    const res = await request(createApp())
      .post(`/api/v1/dashboard/superadmin/venues/${VENUE_ID}/plan/trial`)
      .set('x-test-auth-context', SUPER)
      .send({ tier: 'FREE', days: 14 })

    expect(res.status).toBe(400)
    expect(mockedExtendTrial).not.toHaveBeenCalled()
  })
})
