/**
 * getVenuePlanTier controller — the minimal plan-tier gating signal endpoint
 * (GET /api/v1/dashboard/venues/:venueId/plan-tier).
 *
 * Why it exists (prod incident 2026-06-13): the dashboard FeatureGate reads `grandfathered`/tier to
 * decide whether to paywall, but GET /plan is guarded by billing:subscriptions:read (ADMIN/OWNER
 * only, and it returns price + Stripe ids). Sub-ADMIN staff (MANAGER/CASHIER/…) 403'd on it, lost the
 * signal, and were wrongly paywalled (a Mindform MANAGER blocked from editing inventory). This
 * endpoint surfaces ONLY { tier, grandfathered, exempt } from getVenuePlanInfo and is guarded by
 * features:read (held by every role) — no price, no Stripe ids leak.
 */
jest.mock('@/services/access/basePlan.service', () => ({
  getVenuePlanInfo: jest.fn(),
}))

import type { NextFunction, Request, Response } from 'express'
import { getVenuePlanInfo } from '@/services/access/basePlan.service'
import { getVenuePlanTier } from '@/controllers/dashboard/venue.dashboard.controller'

const mockGetVenuePlanInfo = getVenuePlanInfo as jest.Mock

function makeRes(): Response {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as unknown as Response
}

const makeReq = (venueId: string) => ({ params: { venueId } }) as unknown as Request<{ venueId: string }>

beforeEach(() => jest.clearAllMocks())

describe('getVenuePlanTier controller', () => {
  it('returns ONLY the gating signal { tier, grandfathered, exempt } from getVenuePlanInfo', async () => {
    const plan = { tier: 'PREMIUM', grandfathered: false, exempt: false }
    mockGetVenuePlanInfo.mockResolvedValue(plan)
    const res = makeRes()

    await getVenuePlanTier(makeReq('venue-1'), res, jest.fn() as unknown as NextFunction)

    expect(mockGetVenuePlanInfo).toHaveBeenCalledWith('venue-1')
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ success: true, data: plan })
    // The response must NOT carry billing detail (price / Stripe ids) — that's GET /plan's job.
    const body = (res.json as jest.Mock).mock.calls[0][0]
    expect(body.data).not.toHaveProperty('price')
    expect(body.data).not.toHaveProperty('stripeSubscriptionId')
  })

  it('grandfathered venue → exempt:true surfaced (the legacy bypass sub-ADMIN roles can now read)', async () => {
    mockGetVenuePlanInfo.mockResolvedValue({ tier: 'FREE', grandfathered: true, exempt: true })
    const res = makeRes()

    await getVenuePlanTier(makeReq('mindform'), res, jest.fn() as unknown as NextFunction)

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { tier: 'FREE', grandfathered: true, exempt: true } })
  })

  it('forwards service errors to next() (never throws)', async () => {
    const err = new Error('boom')
    mockGetVenuePlanInfo.mockRejectedValue(err)
    const res = makeRes()
    const next = jest.fn() as unknown as NextFunction

    await getVenuePlanTier(makeReq('venue-1'), res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.status).not.toHaveBeenCalled()
  })
})
