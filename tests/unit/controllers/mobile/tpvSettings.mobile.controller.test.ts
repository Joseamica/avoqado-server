/**
 * Mobile TPV Settings controller — plan-tier info on the venue-settings payload.
 *
 * Context (2026-06): POS apps (iOS + Android) call GET /api/v1/mobile/venues/:venueId/settings
 * at venue-select and need the venue's plan tier to gate UI by plan. The dashboard plan
 * endpoint requires `billing:subscriptions:read`, which POS staff don't have, so the plan
 * info ships here as an ADDITIVE, OPTIONAL `plan` field:
 *
 *   plan: { tier: 'FREE'|'PRO'|'PREMIUM'|'ENTERPRISE', grandfathered: boolean, exempt: boolean }
 *
 * Guarantees under test:
 *   1. tier derives from the active base plan (PLAN_PRO → 'PRO'; none → 'FREE').
 *   2. grandfathered (Venue.seatCapExempt) implies exempt:true (apps skip ALL gating).
 *   3. RESILIENCE: a plan-lookup failure must NEVER break venue-select — the settings
 *      payload is returned WITHOUT the plan field (apps fail open) and the error is logged.
 *   4. Existing fields (terminals/settings/activeTerminalId) are never removed (old apps).
 */

import type { NextFunction, Request, Response } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'

const venueId = 'venue-123'

function makeRes(): Response & { __json: any } {
  const res: any = {}
  res.__json = undefined
  res.status = jest.fn(() => res)
  res.json = jest.fn((body: any) => {
    res.__json = body
    return res
  })
  return res
}

function makeReq(): Request {
  return { params: { venueId } } as unknown as Request
}

/** Active PLAN_PRO VenueFeature row as returned by getVenueBaseTier's findMany select. */
const activeProRow = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }

describe('getVenueTpvSettings (mobile) — plan-tier info', () => {
  beforeEach(() => {
    // No terminals → settings null, no per-terminal settings lookup. Keeps the focus on `plan`.
    prismaMock.terminal.findMany.mockResolvedValue([])
  })

  it('includes plan.tier "PRO" for a venue with an active PLAN_PRO base plan', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([activeProRow])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getVenueTpvSettings(makeReq(), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.__json.success).toBe(true)
    expect(res.__json.data.plan).toEqual({ tier: 'PRO', grandfathered: false, exempt: false })
    // Existing contract fields are untouched (additive change only)
    expect(res.__json.data.terminals).toEqual([])
    expect(res.__json.data.settings).toBeNull()
    expect(res.__json.data.activeTerminalId).toBeNull()
  })

  it('reports grandfathered:true → exempt:true (and tier FREE when no base plan)', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([]) // no active base plan
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: true, status: 'ACTIVE' })

    const res = makeRes()
    await getVenueTpvSettings(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__json.data.plan).toEqual({ tier: 'FREE', grandfathered: true, exempt: true })
  })

  it('reports exempt:true for demo-status venues (TRIAL) even when not grandfathered', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'TRIAL' })

    const res = makeRes()
    await getVenueTpvSettings(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__json.data.plan).toEqual({ tier: 'FREE', grandfathered: false, exempt: true })
  })

  it('still returns the settings payload WITHOUT plan when the plan lookup throws (fail open)', async () => {
    prismaMock.venueFeature.findMany.mockRejectedValue(new Error('db exploded'))
    prismaMock.venue.findUnique.mockRejectedValue(new Error('db exploded'))

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getVenueTpvSettings(makeReq(), res, next)

    // Venue-select on the POS must survive: 200 payload, no error propagation
    expect(next).not.toHaveBeenCalled()
    expect(res.__json.success).toBe(true)
    expect(res.__json.data).not.toHaveProperty('plan')
    expect(res.__json.data.terminals).toEqual([])
    expect(res.__json.data.settings).toBeNull()
    expect(res.__json.data.activeTerminalId).toBeNull()
    // ...and the failure is observable in logs
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('plan info'), expect.objectContaining({ venueId }))
  })
})
