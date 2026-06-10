/**
 * Superadmin plan-admin controller tests — the 3 plan write endpoints.
 *
 * Verifies that the HTTP handlers:
 *   POST /superadmin/venues/:venueId/plan/grandfathered  → setVenueGrandfathered
 *   POST /superadmin/venues/:venueId/plan/comp           → assignCompPlan
 *   POST /superadmin/venues/:venueId/plan/trial          → extendPlanTrial
 * forward their validated params/body to the service and return the fresh PlanState in the
 * standard `{ success, data }` envelope. The service is MOCKED here (service behavior — comp
 * PRO/FREE tier derivation, trial endDate, invalid-days rejection — is covered by the service
 * unit tests + the route-schema tests that reject days 0/400 before the controller runs).
 *
 * Mirrors tests/unit/controllers/superadmin/merchantAccount.controller.test.ts.
 */

import type { NextFunction, Request, Response } from 'express'

import { setVenuePlanGrandfathered, assignVenueCompPlan, extendVenuePlanTrial } from '@/controllers/dashboard/superadmin.controller'
import * as superadminService from '@/services/dashboard/superadmin.service'

jest.mock('@/services/dashboard/superadmin.service', () => ({
  setVenueGrandfathered: jest.fn(),
  assignCompPlan: jest.fn(),
  extendPlanTrial: jest.fn(),
}))

const mockedSetGrandfathered = superadminService.setVenueGrandfathered as jest.Mock
const mockedAssignComp = superadminService.assignCompPlan as jest.Mock
const mockedExtendTrial = superadminService.extendPlanTrial as jest.Mock

interface FakeRes extends Response {
  __status: number
  __json: any
}

function makeRes(): FakeRes {
  const res: any = {}
  res.__status = 200
  res.__json = undefined
  res.status = jest.fn((code: number) => {
    res.__status = code
    return res
  })
  res.json = jest.fn((body: any) => {
    res.__json = body
    return res
  })
  res.send = jest.fn(() => res)
  res.end = jest.fn(() => res)
  return res as FakeRes
}

function makeReq(params: Record<string, any>, body: Record<string, any>): Request {
  return {
    params,
    query: {},
    body,
    authContext: { userId: 'superadmin-1' },
  } as unknown as Request
}

/** A minimal PlanState-shaped object the service would return. */
function planState(overrides: Record<string, any> = {}) {
  return {
    hasPlan: false,
    state: 'none',
    planTier: null,
    planName: null,
    interval: null,
    price: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    suspendedAt: null,
    gracePeriodEndsAt: null,
    paymentMethod: null,
    stripeSubscriptionId: null,
    grandfathered: false,
    retentionOfferEligible: false,
    ...overrides,
  }
}

beforeEach(() => jest.clearAllMocks())

describe('POST /superadmin/venues/:venueId/plan/grandfathered', () => {
  it('forwards venueId + grandfathered=true and returns PlanState in the envelope', async () => {
    mockedSetGrandfathered.mockResolvedValue(planState({ grandfathered: true }))
    const req = makeReq({ venueId: 'venue-1' }, { grandfathered: true })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await setVenuePlanGrandfathered(req, res, next)

    expect(mockedSetGrandfathered).toHaveBeenCalledWith('venue-1', true)
    expect(res.__json.success).toBe(true)
    expect(res.__json.data.grandfathered).toBe(true)
    expect(next).not.toHaveBeenCalled()
  })

  it('forwards grandfathered=false (toggle off)', async () => {
    mockedSetGrandfathered.mockResolvedValue(planState({ grandfathered: false }))
    const req = makeReq({ venueId: 'venue-1' }, { grandfathered: false })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await setVenuePlanGrandfathered(req, res, next)

    expect(mockedSetGrandfathered).toHaveBeenCalledWith('venue-1', false)
    expect(res.__json.data.grandfathered).toBe(false)
  })

  it('passes service errors to next()', async () => {
    mockedSetGrandfathered.mockRejectedValue(new Error('Venue not found'))
    const req = makeReq({ venueId: 'nope' }, { grandfathered: true })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await setVenuePlanGrandfathered(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(Error)
  })
})

describe('POST /superadmin/venues/:venueId/plan/comp', () => {
  it('comp PRO → returns PlanState with planTier PRO (no stripe sub)', async () => {
    mockedAssignComp.mockResolvedValue(planState({ hasPlan: true, state: 'active', planTier: 'PRO', stripeSubscriptionId: null }))
    const req = makeReq({ venueId: 'venue-1' }, { tier: 'PRO' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await assignVenueCompPlan(req, res, next)

    expect(mockedAssignComp).toHaveBeenCalledWith('venue-1', 'PRO')
    expect(res.__json.success).toBe(true)
    expect(res.__json.data.planTier).toBe('PRO')
    expect(res.__json.data.stripeSubscriptionId).toBeNull()
    expect(next).not.toHaveBeenCalled()
  })

  it('comp FREE → returns PlanState with planTier null', async () => {
    mockedAssignComp.mockResolvedValue(planState({ planTier: null }))
    const req = makeReq({ venueId: 'venue-1' }, { tier: 'FREE' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await assignVenueCompPlan(req, res, next)

    expect(mockedAssignComp).toHaveBeenCalledWith('venue-1', 'FREE')
    expect(res.__json.data.planTier).toBeNull()
  })

  it('passes service errors to next()', async () => {
    mockedAssignComp.mockRejectedValue(new Error('Venue not found'))
    const req = makeReq({ venueId: 'nope' }, { tier: 'PRO' })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await assignVenueCompPlan(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('POST /superadmin/venues/:venueId/plan/trial', () => {
  it('extends a PRO trial → returns PlanState with trialEndsAt set', async () => {
    const ends = new Date(Date.now() + 14 * 86400000).toISOString()
    mockedExtendTrial.mockResolvedValue(planState({ hasPlan: true, state: 'trial', planTier: 'PRO', trialEndsAt: ends }))
    const req = makeReq({ venueId: 'venue-1' }, { tier: 'PRO', days: 14 })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await extendVenuePlanTrial(req, res, next)

    expect(mockedExtendTrial).toHaveBeenCalledWith('venue-1', 'PRO', 14)
    expect(res.__json.success).toBe(true)
    expect(res.__json.data.state).toBe('trial')
    expect(res.__json.data.trialEndsAt).toBe(ends)
    expect(next).not.toHaveBeenCalled()
  })

  it('passes a service-level invalid-days rejection to next()', async () => {
    // The route Zod schema rejects days 0/400 BEFORE the controller; the service also re-checks.
    mockedExtendTrial.mockRejectedValue(new Error('Trial days must be an integer between 1 and 365'))
    const req = makeReq({ venueId: 'venue-1' }, { tier: 'PRO', days: 400 })
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await extendVenuePlanTrial(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect((next as jest.Mock).mock.calls[0][0]).toBeInstanceOf(Error)
  })
})
