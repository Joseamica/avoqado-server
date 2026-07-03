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
import { getTerminalConfig } from '@/controllers/tpv/terminal.tpv.controller'

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
})
