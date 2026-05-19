/**
 * Terminal TPV controller — AngelPay config filter + angelpayAuth payload tests.
 *
 * Covers validation point #4 of the AngelPay multi-merchant migration plan
 * (spec §4.4 — runtime gate / defense in depth) and the angelpayAuth payload
 * extension (spec §4.5 + §4.5b).
 *
 * Mocks @/utils/prismaClient and the helpers used by the controller so the
 * test exercises ONLY the new filter + payload assembly logic.
 */

import type { NextFunction, Request, Response } from 'express'

import prisma from '@/utils/prismaClient'
import { getTerminalConfig } from '@/controllers/tpv/terminal.tpv.controller'
import { isProviderCompatibleWithBrand } from '@/lib/providerDeviceCompatibility'
import { decryptCredentials } from '@/services/superadmin/merchantAccount.service'
import { getAngelPayUserAccountForTerminal, getAngelPayUserAccountsForTerminal } from '@/services/superadmin/angelpayUserAccount.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findFirst: jest.fn() },
    merchantAccount: { findMany: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
  },
}))

jest.mock('@/lib/providerDeviceCompatibility', () => ({
  isProviderCompatibleWithBrand: jest.fn(),
}))

jest.mock('@/services/superadmin/merchantAccount.service', () => ({
  decryptCredentials: jest.fn(),
}))

jest.mock('@/services/superadmin/angelpayUserAccount.service', () => ({
  // Multi-account per venue (2026-05-18): controller now prefers the
  // plural variant and only falls back to the singular when the venue
  // has no accounts at all. Mock both so the controller can take either
  // branch deterministically.
  getAngelPayUserAccountForTerminal: jest.fn(),
  getAngelPayUserAccountsForTerminal: jest.fn(),
}))

// Fallback path (org→venue inheritance) is not exercised in these tests
// because we always provide assignedMerchantIds. Mock to be safe.
jest.mock('@/services/organization-payment-config.service', () => ({
  getEffectivePaymentConfig: jest.fn().mockResolvedValue(null),
}))

const mockedPrisma = prisma as unknown as {
  terminal: { findFirst: jest.Mock }
  merchantAccount: { findMany: jest.Mock }
  venueSettings: { findUnique: jest.Mock }
}

const mockedIsCompat = isProviderCompatibleWithBrand as jest.Mock
const mockedDecrypt = decryptCredentials as jest.Mock
const mockedGetAngelPayAccount = getAngelPayUserAccountForTerminal as jest.Mock
const mockedGetAngelPayAccounts = getAngelPayUserAccountsForTerminal as jest.Mock

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

describe('GET /tpv/terminals/:serialNumber/config — Task 13 (AngelPay)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPrisma.venueSettings.findUnique.mockResolvedValue({ enableShifts: false })
    // Multi-account per venue (2026-05-18): default the plural variant to []
    // so each existing test continues to exercise the legacy single-account
    // code path (which uses `getAngelPayUserAccountForTerminal`). Tests that
    // want the multi-account branch override this to return a non-empty array.
    mockedGetAngelPayAccounts.mockResolvedValue([])
  })

  // ----------------------------------------------------------------
  // 1. Filter merchants by terminal.brand compatibility
  // ----------------------------------------------------------------
  it('filters merchants[] to providers compatible with terminal.brand (NEXGO → only ANGELPAY)', async () => {
    mockedPrisma.terminal.findFirst.mockResolvedValue({
      id: 'term-1',
      serialNumber: 'SN-NEXGO-1',
      brand: 'NEXGO',
      model: 'N86',
      status: 'ACTIVE',
      venueId: 'venue-1',
      assignedMerchantIds: ['ma-blumon', 'ma-angelpay'],
      config: {},
      venue: { id: 'venue-1', name: 'V', type: 'RESTAURANT', timezone: 'America/Mexico_City' },
    })

    mockedPrisma.merchantAccount.findMany.mockResolvedValue([
      {
        id: 'ma-blumon',
        displayName: 'Blumon Account',
        active: true,
        blumonSerialNumber: 'BLU-1',
        blumonPosId: '376',
        blumonEnvironment: 'SANDBOX',
        blumonMerchantId: 'BLU-MID',
        credentialsEncrypted: { encrypted: 'x', iv: 'y' },
        providerConfig: null,
        externalMerchantId: 'EXT-BLU',
        angelpayAffiliation: null,
        angelpayMerchantName: null,
        provider: { code: 'BLUMON' },
      },
      {
        id: 'ma-angelpay',
        displayName: 'AngelPay Account',
        active: true,
        blumonSerialNumber: null,
        blumonPosId: null,
        blumonEnvironment: null,
        blumonMerchantId: null,
        credentialsEncrypted: { encrypted: 'x', iv: 'y' },
        providerConfig: null,
        externalMerchantId: 'EXT-AP',
        angelpayAffiliation: 'AFFIL-1',
        angelpayMerchantName: 'AngelPay MX',
        provider: { code: 'ANGELPAY' },
      },
    ])

    // Mocked compat: ANGELPAY compatible with NEXGO, BLUMON not
    mockedIsCompat.mockImplementation((providerCode: string, brand: string) => {
      if (providerCode === 'ANGELPAY' && brand === 'NEXGO') return true
      if (providerCode === 'BLUMON' && brand === 'NEXGO') return false
      return true
    })
    mockedGetAngelPayAccount.mockResolvedValue(null) // no account → angelpayAuth null

    const res = makeRes()
    await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

    expect(res.__status).toBe(200)
    const merchants = res.__body.data.merchantAccounts
    expect(merchants).toHaveLength(1)
    expect(merchants[0].id).toBe('ma-angelpay')
    expect(merchants[0].providerCode).toBe('ANGELPAY')
    // Verify compat helper called with the right args
    expect(mockedIsCompat).toHaveBeenCalledWith('BLUMON', 'NEXGO')
    expect(mockedIsCompat).toHaveBeenCalledWith('ANGELPAY', 'NEXGO')
  })

  // ----------------------------------------------------------------
  // 2. NEXGO + ACTIVE account → angelpayAuth with DECRYPTED PIN
  // ----------------------------------------------------------------
  it('includes angelpayAuth with decrypted PIN when terminal is NEXGO and account is ACTIVE', async () => {
    mockedPrisma.terminal.findFirst.mockResolvedValue({
      id: 'term-1',
      serialNumber: 'SN-NEXGO-1',
      brand: 'NEXGO',
      model: 'N86',
      status: 'ACTIVE',
      venueId: 'venue-1',
      assignedMerchantIds: ['ma-angelpay'],
      config: {},
      venue: { id: 'venue-1', name: 'V', type: 'RESTAURANT', timezone: 'America/Mexico_City' },
    })

    mockedPrisma.merchantAccount.findMany.mockResolvedValue([
      {
        id: 'ma-angelpay',
        displayName: 'AngelPay Account',
        active: true,
        blumonSerialNumber: null,
        blumonPosId: null,
        blumonEnvironment: null,
        blumonMerchantId: null,
        credentialsEncrypted: null,
        providerConfig: null,
        externalMerchantId: 'EXT-AP',
        angelpayAffiliation: 'AFFIL-1',
        angelpayMerchantName: 'AngelPay MX',
        provider: { code: 'ANGELPAY' },
      },
    ])

    mockedIsCompat.mockReturnValue(true)

    mockedGetAngelPayAccount.mockResolvedValue({
      id: 'apa-1',
      venueId: 'venue-1',
      email: 'ops@avoqado.io',
      pinEncrypted: { encrypted: 'enc(123456)', iv: 'iv-hex' },
      environment: 'QA',
      status: 'ACTIVE',
    })

    mockedDecrypt.mockReturnValue('123456')

    const res = makeRes()
    await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

    expect(res.__status).toBe(200)
    const angelpayAuth = res.__body.data.angelpayAuth
    expect(angelpayAuth).not.toBeNull()
    expect(angelpayAuth).toEqual({
      accountId: 'apa-1',
      email: 'ops@avoqado.io',
      pin: '123456',
      environment: 'QA',
    })
    expect(mockedDecrypt).toHaveBeenCalledWith({ encrypted: 'enc(123456)', iv: 'iv-hex' })
    expect(mockedGetAngelPayAccount).toHaveBeenCalledWith('SN-NEXGO-1')
  })

  // ----------------------------------------------------------------
  // 3. NEXGO + non-ACTIVE account → angelpayAuth is null
  // ----------------------------------------------------------------
  it('returns angelpayAuth = null when AngelPayUserAccount status !== ACTIVE', async () => {
    mockedPrisma.terminal.findFirst.mockResolvedValue({
      id: 'term-1',
      serialNumber: 'SN-NEXGO-1',
      brand: 'NEXGO',
      model: 'N86',
      status: 'ACTIVE',
      venueId: 'venue-1',
      assignedMerchantIds: ['ma-angelpay'],
      config: {},
      venue: { id: 'venue-1', name: 'V', type: 'RESTAURANT', timezone: 'America/Mexico_City' },
    })

    mockedPrisma.merchantAccount.findMany.mockResolvedValue([
      {
        id: 'ma-angelpay',
        displayName: 'AngelPay Account',
        active: true,
        blumonSerialNumber: null,
        blumonPosId: null,
        blumonEnvironment: null,
        blumonMerchantId: null,
        credentialsEncrypted: null,
        providerConfig: null,
        externalMerchantId: 'EXT-AP',
        angelpayAffiliation: 'AFFIL-1',
        angelpayMerchantName: 'AngelPay MX',
        provider: { code: 'ANGELPAY' },
      },
    ])

    mockedIsCompat.mockReturnValue(true)

    mockedGetAngelPayAccount.mockResolvedValue({
      id: 'apa-1',
      venueId: 'venue-1',
      email: 'ops@avoqado.io',
      pinEncrypted: { encrypted: 'enc(123456)', iv: 'iv-hex' },
      environment: 'QA',
      status: 'PIN_ROTATION_REQUIRED',
    })

    const res = makeRes()
    await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

    expect(res.__status).toBe(200)
    expect(res.__body.data.angelpayAuth).toBeNull()
    expect(mockedDecrypt).not.toHaveBeenCalled()
  })

  // ----------------------------------------------------------------
  // 4. PAX terminal → angelpayAuth is null even if account exists
  // ----------------------------------------------------------------
  it('returns angelpayAuth = null on PAX terminal even if venue has ACTIVE AngelPayUserAccount', async () => {
    mockedPrisma.terminal.findFirst.mockResolvedValue({
      id: 'term-1',
      serialNumber: 'SN-PAX-1',
      brand: 'PAX',
      model: 'A910S',
      status: 'ACTIVE',
      venueId: 'venue-1',
      assignedMerchantIds: ['ma-blumon'],
      config: {},
      venue: { id: 'venue-1', name: 'V', type: 'RESTAURANT', timezone: 'America/Mexico_City' },
    })

    mockedPrisma.merchantAccount.findMany.mockResolvedValue([
      {
        id: 'ma-blumon',
        displayName: 'Blumon Account',
        active: true,
        blumonSerialNumber: 'BLU-1',
        blumonPosId: '376',
        blumonEnvironment: 'SANDBOX',
        blumonMerchantId: 'BLU-MID',
        credentialsEncrypted: { encrypted: 'x', iv: 'y' },
        providerConfig: null,
        externalMerchantId: 'EXT-BLU',
        angelpayAffiliation: null,
        angelpayMerchantName: null,
        provider: { code: 'BLUMON' },
      },
    ])

    mockedIsCompat.mockImplementation((providerCode: string, brand: string) => {
      if (providerCode === 'BLUMON' && brand === 'PAX') return true
      return false
    })

    // Even though the helper would return an ACTIVE account, controller must
    // not look it up on PAX terminals.
    mockedGetAngelPayAccount.mockResolvedValue({
      id: 'apa-1',
      venueId: 'venue-1',
      email: 'ops@avoqado.io',
      pinEncrypted: { encrypted: 'enc(123456)', iv: 'iv-hex' },
      environment: 'QA',
      status: 'ACTIVE',
    })

    const res = makeRes()
    await getTerminalConfig({ params: { serialNumber: 'SN-PAX-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

    expect(res.__status).toBe(200)
    expect(res.__body.data.angelpayAuth).toBeNull()
    expect(mockedGetAngelPayAccount).not.toHaveBeenCalled()
    expect(mockedDecrypt).not.toHaveBeenCalled()
  })
})
