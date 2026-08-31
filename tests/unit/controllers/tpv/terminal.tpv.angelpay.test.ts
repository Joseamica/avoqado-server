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
    // Plan-tier info (2026-06): getTerminalConfig now resolves the venue's plan
    // via basePlan.service (venueFeature + venue lookups). These tests don't
    // assert on `plan`, but the models must exist so the lookup resolves
    // instead of crashing the worker with an unhandled rejection.
    venueFeature: { findMany: jest.fn() },
    venue: { findUnique: jest.fn() },
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

// getTerminalConfig now checks the SERIALIZED_INVENTORY module flag. Mock the
// module service so its real impl (which queries unmocked prisma models) doesn't
// throw — these tests don't exercise the serialized-inventory branch.
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

const mockedPrisma = prisma as unknown as {
  terminal: { findFirst: jest.Mock }
  merchantAccount: { findMany: jest.Mock }
  venueSettings: { findUnique: jest.Mock }
  venueFeature: { findMany: jest.Mock }
  venue: { findUnique: jest.Mock }
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
    // Plan lookup defaults: no base plan, regular venue → plan { FREE, false, false }.
    // Additive field — none of these tests assert on it.
    mockedPrisma.venueFeature.findMany.mockResolvedValue([])
    mockedPrisma.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
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
      email: 'hola@avoqado.io',
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
      email: 'hola@avoqado.io',
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
      email: 'hola@avoqado.io',
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
      email: 'hola@avoqado.io',
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
  // ----------------------------------------------------------------
  // 5. Multi-account venue: angelpayAuth must follow the terminal's
  //    ASSIGNED merchant, not the venue's oldest account.
  //
  //    Real incident (2026-08-29, terminal AVQD-N860W173080): the venue had
  //    two AngelPay accounts. The terminal was assigned ONLY the merchant of
  //    the newer account, but the config handed it the OLDER account's
  //    credentials. The SDK then authenticated as the wrong account, its
  //    merchant list never intersected the assigned merchant, and the TPV
  //    hard-blocked every charge ("Sin merchants válidos compartidos").
  // ----------------------------------------------------------------
  describe('multi-account venue — credential follows the assigned merchant', () => {
    const OLD_ACCOUNT = {
      id: 'apa-old',
      venueId: 'venue-1',
      email: 'old@venue.com',
      pin: '111111',
      pinEncrypted: null,
      environment: 'PROD',
      status: 'ACTIVE',
    }
    const NEW_ACCOUNT = {
      id: 'apa-new',
      venueId: 'venue-1',
      email: 'new@venue.com',
      pin: '222222',
      pinEncrypted: null,
      environment: 'PROD',
      status: 'ACTIVE',
    }

    function angelpayMerchant(id: string, externalMerchantId: string, accountId: string | null) {
      return {
        id,
        displayName: `Merchant ${id}`,
        active: true,
        blumonSerialNumber: null,
        blumonPosId: null,
        blumonEnvironment: null,
        blumonMerchantId: null,
        credentialsEncrypted: { encrypted: 'x', iv: 'y' },
        providerConfig: null,
        externalMerchantId,
        angelpayAffiliation: `AFFIL-${id}`,
        angelpayMerchantName: `Name ${id}`,
        angelpayUserAccountId: accountId,
        provider: { code: 'ANGELPAY' },
      }
    }

    function blumonMerchant(id: string) {
      return {
        id,
        displayName: `Blumon ${id}`,
        active: true,
        blumonSerialNumber: `SN-${id}`,
        blumonPosId: '376',
        blumonEnvironment: 'PROD',
        blumonMerchantId: `MID-${id}`,
        credentialsEncrypted: { encrypted: 'x', iv: 'y' },
        providerConfig: null,
        externalMerchantId: `EXT-${id}`,
        angelpayAffiliation: null,
        angelpayMerchantName: null,
        angelpayUserAccountId: null,
        provider: { code: 'BLUMON' },
      }
    }

    function mockNexgoTerminal(assignedMerchantIds: string[]) {
      mockedPrisma.terminal.findFirst.mockResolvedValue({
        id: 'term-1',
        serialNumber: 'SN-NEXGO-1',
        brand: 'NEXGO',
        model: 'N86',
        status: 'ACTIVE',
        venueId: 'venue-1',
        assignedMerchantIds,
        config: {},
        venue: { id: 'venue-1', name: 'V', type: 'CLINIC', timezone: 'America/Mexico_City' },
      })
    }

    beforeEach(() => {
      mockedIsCompat.mockReturnValue(true)
      // Service returns accounts oldest-first (createdAt asc) — the order the
      // controller must NOT blindly trust when picking the primary credential.
      mockedGetAngelPayAccounts.mockResolvedValue([OLD_ACCOUNT, NEW_ACCOUNT])
    })

    it("hands the assigned merchant's account as angelpayAuth, not the oldest one", async () => {
      mockNexgoTerminal(['ma-new'])
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([angelpayMerchant('ma-new', '1272', NEW_ACCOUNT.id)])

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      expect(res.__status).toBe(200)
      expect(res.__body.data.angelpayAuth.accountId).toBe(NEW_ACCOUNT.id)
      expect(res.__body.data.angelpayAuth.email).toBe(NEW_ACCOUNT.email)
      // The list still carries EVERY account so switchAccount() keeps working.
      expect(res.__body.data.angelpayAccounts.map((a: any) => a.accountId)).toEqual(
        expect.arrayContaining([OLD_ACCOUNT.id, NEW_ACCOUNT.id]),
      )
      // ...and the assigned account leads it, since clients read index 0.
      expect(res.__body.data.angelpayAccounts[0].accountId).toBe(NEW_ACCOUNT.id)
    })

    it('keeps the oldest account when the assigned merchant belongs to it', async () => {
      mockNexgoTerminal(['ma-old'])
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([angelpayMerchant('ma-old', '974', OLD_ACCOUNT.id)])

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      expect(res.__body.data.angelpayAuth.accountId).toBe(OLD_ACCOUNT.id)
      expect(res.__body.data.angelpayAccounts[0].accountId).toBe(OLD_ACCOUNT.id)
    })

    it('falls back to the existing order when no assigned merchant names an account', async () => {
      // Legacy/un-backfilled merchant: angelpayUserAccountId is null. Nothing
      // to key on, so the previous behavior (oldest first) must be preserved.
      mockNexgoTerminal(['ma-legacy'])
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([angelpayMerchant('ma-legacy', '555', null)])

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      expect(res.__body.data.angelpayAuth.accountId).toBe(OLD_ACCOUNT.id)
      expect(res.__body.data.angelpayAccounts[0].accountId).toBe(OLD_ACCOUNT.id)
    })

    it('ignores a merchant whose account is not among the venue ACTIVE accounts', async () => {
      // Assigned merchant points at an account that is INACTIVE/deleted, so it
      // never made it into the payload list. Must not blank out angelpayAuth.
      mockNexgoTerminal(['ma-orphan'])
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([angelpayMerchant('ma-orphan', '999', 'apa-gone')])

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      expect(res.__body.data.angelpayAuth.accountId).toBe(OLD_ACCOUNT.id)
      expect(res.__body.data.angelpayAccounts).toHaveLength(2)
    })

    it('honors the ORDER of assignedMerchantIds, not the order the DB returns', async () => {
      // A venue's payment slots are shared across providers and terminals: a
      // Blumon/PAX merchant can hold slot 1, so an AngelPay merchant lands on
      // slot 3 — and a terminal can carry TWO AngelPay merchants owned by two
      // different logins (Amaena in prod). `merchantAccount.findMany({ id: { in
      // } })` has no ORDER BY, so Postgres may hand them back in any order:
      // picking "the first AngelPay merchant" off that list would make the
      // charging credential non-deterministic. The operator's intent lives in
      // the ORDER of assignedMerchantIds, so that is what must win.
      mockNexgoTerminal(['ma-new', 'ma-old'])
      // DB returns them REVERSED on purpose.
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([
        angelpayMerchant('ma-old', '974', OLD_ACCOUNT.id),
        angelpayMerchant('ma-new', '1272', NEW_ACCOUNT.id),
      ])

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      expect(res.__body.data.angelpayAuth.accountId).toBe(NEW_ACCOUNT.id)
      expect(res.__body.data.merchantAccounts.map((m: any) => m.id)).toEqual(['ma-new', 'ma-old'])
    })

    it('slot 1 Blumon (PAX) + slot 3 AngelPay: the AngelPay login follows slot 3', async () => {
      // A venue's slots are shared across providers. A Blumon/PAX merchant can
      // sit in slot 1 and the terminal's AngelPay merchant in slot 3. The
      // compat filter drops Blumon for NEXGO; the credential must follow the
      // AngelPay merchant that survives, wherever it sits.
      mockNexgoTerminal(['ma-blumon', 'ma-old', 'ma-new'])
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([
        angelpayMerchant('ma-new', '1272', NEW_ACCOUNT.id),
        blumonMerchant('ma-blumon'),
        angelpayMerchant('ma-old', '974', OLD_ACCOUNT.id),
      ])
      mockedIsCompat.mockImplementation((providerCode: string) => providerCode === 'ANGELPAY')

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      expect(res.__body.data.merchantAccounts.map((m: any) => m.id)).toEqual(['ma-old', 'ma-new'])
      // First AngelPay merchant in slot order is ma-old → OLD leads.
      expect(res.__body.data.angelpayAuth.accountId).toBe(OLD_ACCOUNT.id)
    })

    it('legacy merchant (no account) FIRST + related merchant second: keeps the previous credential', async () => {
      // The operator put the legacy merchant in slot 1. We cannot tell which
      // login owns it, so we must not let slot 2's login override slot 1 —
      // that would silently change the credential the terminal had until now.
      mockNexgoTerminal(['ma-legacy', 'ma-new'])
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([
        angelpayMerchant('ma-new', '1272', NEW_ACCOUNT.id),
        angelpayMerchant('ma-legacy', '555', null),
      ])

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      expect(res.__body.data.angelpayAuth.accountId).toBe(OLD_ACCOUNT.id)
      expect(res.__body.data.angelpayAccounts[0].accountId).toBe(OLD_ACCOUNT.id)
    })

    it('orphan merchant (unknown account) FIRST + valid merchant second: keeps the previous credential', async () => {
      mockNexgoTerminal(['ma-orphan', 'ma-new'])
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([
        angelpayMerchant('ma-new', '1272', NEW_ACCOUNT.id),
        angelpayMerchant('ma-orphan', '999', 'apa-gone'),
      ])

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      expect(res.__body.data.angelpayAuth.accountId).toBe(OLD_ACCOUNT.id)
    })

    it('no assignedMerchantIds: the effective-config slot order decides, not the DB order', async () => {
      const { getEffectivePaymentConfig } = jest.requireMock('@/services/organization-payment-config.service')
      mockNexgoTerminal([])
      ;(getEffectivePaymentConfig as jest.Mock).mockResolvedValueOnce({
        source: 'venue',
        config: { primaryAccount: { id: 'ma-new' }, secondaryAccount: { id: 'ma-old' }, tertiaryAccount: null },
      })
      // DB returns them REVERSED on purpose.
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([
        angelpayMerchant('ma-old', '974', OLD_ACCOUNT.id),
        angelpayMerchant('ma-new', '1272', NEW_ACCOUNT.id),
      ])

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      expect(res.__body.data.merchantAccounts.map((m: any) => m.id)).toEqual(['ma-new', 'ma-old'])
      expect(res.__body.data.angelpayAuth.accountId).toBe(NEW_ACCOUNT.id)
    })

    it('PAX terminal: merchantAccounts order is left exactly as the DB returned it', async () => {
      // On PAX/Blumon every merchant carries its own credentials — order is
      // cosmetic and that contract must not move as a side effect of this fix.
      mockedPrisma.terminal.findFirst.mockResolvedValue({
        id: 'term-pax',
        serialNumber: 'SN-PAX-1',
        brand: 'PAX',
        model: 'A910S',
        status: 'ACTIVE',
        venueId: 'venue-1',
        assignedMerchantIds: ['ma-b2', 'ma-b1'],
        config: {},
        venue: { id: 'venue-1', name: 'V', type: 'CLINIC', timezone: 'America/Mexico_City' },
      })
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([blumonMerchant('ma-b1'), blumonMerchant('ma-b2')])
      mockedGetAngelPayAccounts.mockResolvedValue([])
      mockedGetAngelPayAccount.mockResolvedValue(null)

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-PAX-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      expect(res.__body.data.merchantAccounts.map((m: any) => m.id)).toEqual(['ma-b1', 'ma-b2'])
      expect(res.__body.data.angelpayAuth).toBeNull()
      expect(res.__body.data.angelpayAccounts).toBeUndefined()
    })

    it('ACTIVE account without pin/pinEncrypted never leads, even if it owns the assigned merchant', async () => {
      const NO_PIN = { ...NEW_ACCOUNT, id: 'apa-nopin', email: 'nopin@venue.com', pin: null, pinEncrypted: null }
      mockedGetAngelPayAccounts.mockResolvedValue([OLD_ACCOUNT, NO_PIN])
      mockNexgoTerminal(['ma-nopin'])
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([angelpayMerchant('ma-nopin', '777', NO_PIN.id)])

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      // The no-pin account is not in the payload at all, so nothing to key on → previous order.
      expect(res.__body.data.angelpayAccounts.map((a: any) => a.accountId)).toEqual([OLD_ACCOUNT.id])
      expect(res.__body.data.angelpayAuth.accountId).toBe(OLD_ACCOUNT.id)
    })

    it('does not drop any account from the payload when reordering', async () => {
      mockNexgoTerminal(['ma-new'])
      mockedPrisma.merchantAccount.findMany.mockResolvedValue([angelpayMerchant('ma-new', '1272', NEW_ACCOUNT.id)])

      const res = makeRes()
      await getTerminalConfig({ params: { serialNumber: 'SN-NEXGO-1' } } as unknown as Request, res, jest.fn() as unknown as NextFunction)

      expect(res.__body.data.angelpayAccounts).toHaveLength(2)
    })
  })
})
