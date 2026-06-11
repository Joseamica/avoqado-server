/**
 * Terminal TPV controller — plan-tier info on the terminal-config payload.
 *
 * Context (2026-06): the TPV (PAX) caches GET /api/v1/tpv/terminals/:serialNumber/config
 * at startup/login (TpvSettingsRepository) and needs the venue's plan tier to gate UI by
 * plan (REFERRAL_PROGRAM / PROMOTIONS / ADVANCED_REPORTS / SERIALIZED_INVENTORY teasers).
 * The plan info ships as an ADDITIVE, OPTIONAL `plan` field:
 *
 *   plan: { tier: 'FREE'|'PRO'|'PREMIUM'|'ENTERPRISE', grandfathered: boolean, exempt: boolean }
 *
 * Guarantees under test (mirrors tests/unit/controllers/mobile/tpvSettings.mobile.controller.test.ts):
 *   1. tier derives from the active base plan (PLAN_PRO → 'PRO'; none → 'FREE').
 *   2. grandfathered (Venue.seatCapExempt) implies exempt:true (the TPV skips ALL gating).
 *   3. exempt:true for demo-status venues (TRIAL/LIVE_DEMO) even when not grandfathered.
 *   4. RESILIENCE: a plan-lookup failure must NEVER break terminal config fetch — the
 *      payload is returned WITHOUT the plan field (the TPV fails open) and the error is
 *      logged. Existing fields (terminal/merchantAccounts/tpvSettings) are never removed.
 */

import type { NextFunction, Request, Response } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { getTerminalConfig } from '@/controllers/tpv/terminal.tpv.controller'

// Mock the helpers the controller pulls in so the test exercises ONLY the
// plan-info assembly (same mock set as terminal.tpv.angelpay.test.ts, minus
// the prismaClient override — we use the global prismaMock so the REAL
// basePlan.service runs against mocked venueFeature/venue models).
jest.mock('@/lib/providerDeviceCompatibility', () => ({
  isProviderCompatibleWithBrand: jest.fn().mockReturnValue(true),
}))

jest.mock('@/services/superadmin/merchantAccount.service', () => ({
  decryptCredentials: jest.fn(),
}))

jest.mock('@/services/superadmin/angelpayUserAccount.service', () => ({
  getAngelPayUserAccountForTerminal: jest.fn().mockResolvedValue(null),
  getAngelPayUserAccountsForTerminal: jest.fn().mockResolvedValue([]),
}))

jest.mock('@/services/organization-payment-config.service', () => ({
  getEffectivePaymentConfig: jest.fn().mockResolvedValue(null),
}))

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

const venueId = 'venue-123'
const serialNumber = 'SN-PAX-1'

/** PAX terminal with no merchant assignments — keeps the focus on `plan`. */
const paxTerminal = {
  id: 'term-1',
  serialNumber,
  brand: 'PAX',
  model: 'A910S',
  status: 'ACTIVE',
  venueId,
  assignedMerchantIds: [],
  config: {},
  venue: { id: venueId, name: 'V', type: 'RESTAURANT', timezone: 'America/Mexico_City' },
}

/** Active PLAN_PRO VenueFeature row as returned by getVenueBaseTier's findMany select. */
const activeProRow = { active: true, suspendedAt: null, endDate: null, feature: { code: 'PLAN_PRO' } }

function makeRes(): Response & { __status: number; __body: any } {
  const res: any = {}
  res.__status = 0
  res.__body = null
  res.status = jest.fn((code: number) => {
    res.__status = code
    return res
  })
  res.json = jest.fn((body: any) => {
    res.__body = body
    return res
  })
  return res
}

function makeReq(): Request {
  return { params: { serialNumber } } as unknown as Request
}

describe('GET /tpv/terminals/:serialNumber/config — plan-tier info', () => {
  beforeEach(() => {
    prismaMock.terminal.findFirst.mockResolvedValue(paxTerminal)
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true })
  })

  it('includes plan.tier "PRO" for a venue with an active PLAN_PRO base plan', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([activeProRow])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getTerminalConfig(makeReq(), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.__status).toBe(200)
    expect(res.__body.success).toBe(true)
    expect(res.__body.data.plan).toEqual({ tier: 'PRO', grandfathered: false, exempt: false })
    // Existing contract fields are untouched (additive change only)
    expect(res.__body.data.terminal.serialNumber).toBe(serialNumber)
    expect(res.__body.data.merchantAccounts).toEqual([])
    expect(res.__body.data.tpvSettings).toBeDefined()
  })

  it('reports grandfathered:true → exempt:true (and tier FREE when no base plan)', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([]) // no active base plan
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: true, status: 'ACTIVE' })

    const res = makeRes()
    await getTerminalConfig(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__status).toBe(200)
    expect(res.__body.data.plan).toEqual({ tier: 'FREE', grandfathered: true, exempt: true })
  })

  it('reports exempt:true for demo-status venues (TRIAL) even when not grandfathered', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'TRIAL' })

    const res = makeRes()
    await getTerminalConfig(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__status).toBe(200)
    expect(res.__body.data.plan).toEqual({ tier: 'FREE', grandfathered: false, exempt: true })
  })

  it('still returns the terminal config WITHOUT plan when the plan lookup throws (fail open)', async () => {
    prismaMock.venueFeature.findMany.mockRejectedValue(new Error('db exploded'))
    prismaMock.venue.findUnique.mockRejectedValue(new Error('db exploded'))

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getTerminalConfig(makeReq(), res, next)

    // Terminal startup on the TPV must survive: 200 payload, no error propagation
    expect(next).not.toHaveBeenCalled()
    expect(res.__status).toBe(200)
    expect(res.__body.success).toBe(true)
    expect(res.__body.data).not.toHaveProperty('plan')
    expect(res.__body.data.terminal.serialNumber).toBe(serialNumber)
    expect(res.__body.data.merchantAccounts).toEqual([])
    expect(res.__body.data.tpvSettings).toBeDefined()
    // ...and the failure is observable in logs
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('plan info'), expect.objectContaining({ venueId }))
  })
})
