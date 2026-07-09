/**
 * Terminal TPV controller — venue-level trackPromoterLocation flag on tpvSettings.
 *
 * "Cambaceo" (2026-07): the TPV PromoterLocationWorker self-gates on
 * tpvSettings.trackPromoterLocation (hourly location pings 11:00–18:00
 * venue-local). The flag lives in VenueSettings and ships ADDITIVELY on the
 * terminal-config payload — old TPV versions ignore it, and a missing
 * VenueSettings row must default to false (never undefined).
 */
import type { NextFunction, Request, Response } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'
import { getTerminalConfig, updateTpvSettings } from '@/controllers/tpv/terminal.tpv.controller'

// Same mock set as terminal.tpv.planInfo.test.ts — isolate tpvSettings assembly.
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

function makeRes(): Response & { __status: number; __body: any } {
  const res: any = { __status: 0, __body: null }
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

const makeReq = () => ({ params: { serialNumber } }) as unknown as Request

describe('GET /tpv/terminals/:serialNumber/config — trackPromoterLocation', () => {
  beforeEach(() => {
    prismaMock.terminal.findFirst.mockResolvedValue(paxTerminal)
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
  })

  it('is true when the venue enabled it in VenueSettings', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true, trackPromoterLocation: true })

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getTerminalConfig(makeReq(), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.__status).toBe(200)
    expect(res.__body.data.tpvSettings.trackPromoterLocation).toBe(true)
  })

  it('defaults to false when VenueSettings has it off', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true, trackPromoterLocation: false })

    const res = makeRes()
    await getTerminalConfig(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__status).toBe(200)
    expect(res.__body.data.tpvSettings.trackPromoterLocation).toBe(false)
  })

  it('defaults to false when the VenueSettings row is missing (REGRESSION: additive, contract intact)', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue(null)

    const res = makeRes()
    await getTerminalConfig(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__status).toBe(200)
    expect(res.__body.data.tpvSettings.trackPromoterLocation).toBe(false)
    // Existing contract fields untouched (old TPVs depend on them)
    expect(res.__body.data.tpvSettings.enableShifts).toBeDefined()
    expect(res.__body.data.terminal.serialNumber).toBe(serialNumber)
    expect(res.__body.data.merchantAccounts).toEqual([])
  })

  // Per-terminal override (Terminal.configOverrides.trackPromoterLocation) — tri-state:
  // an explicit terminal-level true/false wins over the venue flag; absent = inherit.
  it('resolves true when the terminal override is true even though the venue flag is off', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ ...paxTerminal, configOverrides: { trackPromoterLocation: true } })
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true, trackPromoterLocation: false })

    const res = makeRes()
    await getTerminalConfig(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__status).toBe(200)
    expect(res.__body.data.tpvSettings.trackPromoterLocation).toBe(true)
  })

  it('resolves false when the terminal override is false even though the venue flag is on', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ ...paxTerminal, configOverrides: { trackPromoterLocation: false } })
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true, trackPromoterLocation: true })

    const res = makeRes()
    await getTerminalConfig(makeReq(), res, jest.fn() as NextFunction)

    expect(res.__status).toBe(200)
    expect(res.__body.data.tpvSettings.trackPromoterLocation).toBe(false)
  })
})

// ── Device settings push must never wipe or write the tri-state override ──────
// PUT /tpv/terminals/:serialNumber/settings full-replaces configOverrides with a
// recomputed diff. The trackPromoterLocation override is dashboard-only: a device
// push with unrelated settings must carry the existing override forward, and a
// device echoing back the resolved trackPromoterLocation value must never bake a
// new override in.
describe('PUT /tpv/terminals/:serialNumber/settings — trackPromoterLocation override preservation', () => {
  // organizationId: null → getOrgDefaultsForTerminal returns {} without a prisma call
  const deviceTerminal = {
    id: 'term-1',
    config: { settings: {} },
    configOverrides: null as any,
    venueId,
    venue: { organizationId: null },
  }

  const makePutReq = (body: Record<string, any>) => ({ params: { serialNumber }, body }) as unknown as Request

  beforeEach(() => {
    prismaMock.terminal.update.mockResolvedValue({})
  })

  it('preserves an existing explicit override (false) when the device pushes unrelated settings', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      ...deviceTerminal,
      configOverrides: { trackPromoterLocation: false },
    })

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await updateTpvSettings(makePutReq({ showTipScreen: false }), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.__status).toBe(200)
    const written = prismaMock.terminal.update.mock.calls[0][0].data.configOverrides
    expect(written.trackPromoterLocation).toBe(false) // NOT wiped by the full-replace
    expect(written.showTipScreen).toBe(false) // unrelated diff still stored
  })

  it('preserves an existing explicit override (true) when the device echoes trackPromoterLocation back', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      ...deviceTerminal,
      configOverrides: { trackPromoterLocation: true },
    })

    const res = makeRes()
    // Device echoes the resolved value (false) — must NOT overwrite the explicit true
    await updateTpvSettings(makePutReq({ showTipScreen: false, trackPromoterLocation: false }), res, jest.fn() as NextFunction)

    const written = prismaMock.terminal.update.mock.calls[0][0].data.configOverrides
    expect(written.trackPromoterLocation).toBe(true)
  })

  it('does not invent an override when none exists, even if the device sends trackPromoterLocation', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ ...deviceTerminal, configOverrides: null })

    const res = makeRes()
    await updateTpvSettings(makePutReq({ showTipScreen: false, trackPromoterLocation: true }), res, jest.fn() as NextFunction)

    const written = prismaMock.terminal.update.mock.calls[0][0].data.configOverrides
    expect(written.showTipScreen).toBe(false)
    expect(written).not.toHaveProperty('trackPromoterLocation') // stays "inherit"
    // The device's value was stripped before it could reach config.settings: the stored
    // settings blob carries the DEFAULT (false), not the echoed true.
    expect(prismaMock.terminal.update.mock.calls[0][0].data.config.settings.trackPromoterLocation).toBe(false)
  })
})
