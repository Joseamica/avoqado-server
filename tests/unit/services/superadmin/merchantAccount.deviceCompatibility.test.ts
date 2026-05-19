/**
 * createMerchantAccount — device-compatibility gate + AngelPay branch tests.
 *
 * Verifies the wiring of `assertVenueHasCompatibleTerminal` (Task 8) into the
 * merchant account creation path, plus the new ANGELPAY-specific validations:
 *   - externalMerchantId must be a numeric string (AngelPay merchant IDs are Int)
 *   - The venue must have an ACTIVE AngelPayUserAccount
 *   - Placeholder credentials get encrypted via encryptCredentials({})
 *   - BLUMON path is left untouched (regression guard)
 *
 * Spec: §3.1 (point 1), §4.4 (point 2a)
 * Plan: Task 10
 */

import prisma from '@/utils/prismaClient'
import { createMerchantAccount } from '@/services/superadmin/merchantAccount.service'
import { assertVenueHasCompatibleTerminal } from '@/lib/providerDeviceCompatibility'
import { IncompatibleDeviceError, ValidationError } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    paymentProvider: {
      findUnique: jest.fn(),
    },
    merchantAccount: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    angelPayUserAccount: {
      findUnique: jest.fn(),
      // Multi-account per venue (2026-05-18) — service migrated to `findFirst`
      // because venueId is no longer unique on its own (the unique key is
      // (venueId, email) compound). The findUnique mock is kept to preserve
      // the BLUMON regression test (`expect(...findUnique).not.toHaveBeenCalled()`)
      // — neither call should fire on Blumon-only paths.
      findFirst: jest.fn(),
    },
  },
}))

jest.mock('@/lib/providerDeviceCompatibility', () => ({
  assertVenueHasCompatibleTerminal: jest.fn(),
}))

const mockedPrisma = prisma as unknown as {
  paymentProvider: { findUnique: jest.Mock }
  merchantAccount: { findFirst: jest.Mock; create: jest.Mock }
  angelPayUserAccount: { findUnique: jest.Mock; findFirst: jest.Mock }
}

const mockedAssert = assertVenueHasCompatibleTerminal as jest.Mock

describe('createMerchantAccount — device compatibility + AngelPay branch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Default happy paths for plumbing not under test
    mockedPrisma.merchantAccount.findFirst.mockResolvedValue(null)
    mockedPrisma.merchantAccount.create.mockImplementation(async ({ data, include }) => ({
      id: 'acct-1',
      ...data,
      provider: include?.provider ? { id: data.providerId, code: 'X', name: 'X' } : undefined,
    }))
    mockedAssert.mockResolvedValue(undefined)
  })

  it('with provider=ANGELPAY calls assertVenueHasCompatibleTerminal(venueId, "ANGELPAY") and bubbles IncompatibleDeviceError', async () => {
    mockedPrisma.paymentProvider.findUnique.mockResolvedValue({
      id: 'prov-angelpay',
      code: 'ANGELPAY',
      name: 'AngelPay',
      configSchema: null,
    })
    mockedAssert.mockRejectedValue(
      new IncompatibleDeviceError('Provider ANGELPAY requires at least one ACTIVE NEXGO terminal in this venue'),
    )

    await expect(
      createMerchantAccount({
        providerId: 'prov-angelpay',
        externalMerchantId: '12345',
        venueId: 'venue-1',
      } as any),
    ).rejects.toThrow(IncompatibleDeviceError)

    expect(mockedAssert).toHaveBeenCalledWith('venue-1', 'ANGELPAY')
    expect(mockedPrisma.merchantAccount.create).not.toHaveBeenCalled()
  })

  it('with provider=ANGELPAY rejects non-numeric externalMerchantId', async () => {
    mockedPrisma.paymentProvider.findUnique.mockResolvedValue({
      id: 'prov-angelpay',
      code: 'ANGELPAY',
      name: 'AngelPay',
      configSchema: null,
    })
    mockedAssert.mockResolvedValue(undefined)
    mockedPrisma.angelPayUserAccount.findFirst.mockResolvedValue({ status: 'ACTIVE' })

    await expect(
      createMerchantAccount({
        providerId: 'prov-angelpay',
        externalMerchantId: 'not-a-number',
        venueId: 'venue-1',
      } as any),
    ).rejects.toThrow(/numeric/)

    expect(mockedPrisma.merchantAccount.create).not.toHaveBeenCalled()
  })

  it('with provider=ANGELPAY requires AngelPayUserAccount status=ACTIVE (rejects when only non-ACTIVE accounts exist)', async () => {
    mockedPrisma.paymentProvider.findUnique.mockResolvedValue({
      id: 'prov-angelpay',
      code: 'ANGELPAY',
      name: 'AngelPay',
      configSchema: null,
    })
    mockedAssert.mockResolvedValue(undefined)
    // Multi-account per venue (2026-05-18): the service now `findFirst`s
    // pre-filtered by `status: 'ACTIVE'`, so the "no usable account" case
    // surfaces as a null result (not as a row with status=PENDING_PIN).
    // The error message changed to "Venue has no ACTIVE AngelPay user
    // account" — `/ACTIVE/` matches it; the old `/PENDING_PIN/` pattern
    // no longer reflects the wording or the call shape.
    mockedPrisma.angelPayUserAccount.findFirst.mockResolvedValue(null)

    await expect(
      createMerchantAccount({
        providerId: 'prov-angelpay',
        externalMerchantId: '12345',
        venueId: 'venue-1',
      } as any),
    ).rejects.toThrow(/ACTIVE AngelPay/)

    expect(mockedPrisma.merchantAccount.create).not.toHaveBeenCalled()
  })

  it('with provider=ANGELPAY + ACTIVE account + numeric ID + NEXGO terminal succeeds and stores encrypted placeholder credentials', async () => {
    mockedPrisma.paymentProvider.findUnique.mockResolvedValue({
      id: 'prov-angelpay',
      code: 'ANGELPAY',
      name: 'AngelPay',
      configSchema: null,
    })
    mockedAssert.mockResolvedValue(undefined)
    mockedPrisma.angelPayUserAccount.findFirst.mockResolvedValue({ status: 'ACTIVE' })

    const result = await createMerchantAccount({
      providerId: 'prov-angelpay',
      externalMerchantId: '7654321',
      alias: 'Main',
      venueId: 'venue-1',
    } as any)

    expect(mockedAssert).toHaveBeenCalledWith('venue-1', 'ANGELPAY')
    expect(mockedPrisma.merchantAccount.create).toHaveBeenCalledTimes(1)

    const createCall = mockedPrisma.merchantAccount.create.mock.calls[0][0]
    expect(createCall.data.providerId).toBe('prov-angelpay')
    expect(createCall.data.externalMerchantId).toBe('7654321')
    // Placeholder credentials should be encrypted via encryptCredentials({}) → { encrypted, iv }
    expect(createCall.data.credentialsEncrypted).toEqual(
      expect.objectContaining({
        encrypted: expect.any(String),
        iv: expect.any(String),
      }),
    )
    expect(result).toBeDefined()
  })

  it('with provider=BLUMON does NOT touch the AngelPay branch (regression guard)', async () => {
    mockedPrisma.paymentProvider.findUnique.mockResolvedValue({
      id: 'prov-blumon',
      code: 'BLUMON',
      name: 'Blumon',
      configSchema: null,
    })
    mockedAssert.mockResolvedValue(undefined)

    await createMerchantAccount({
      providerId: 'prov-blumon',
      externalMerchantId: 'BLUMON-MERCH-1',
      credentials: { merchantId: 'm1', apiKey: 'k1' },
      venueId: 'venue-1',
    } as any)

    expect(mockedAssert).toHaveBeenCalledWith('venue-1', 'BLUMON')
    // AngelPay-only lookup must not run for BLUMON
    expect(mockedPrisma.angelPayUserAccount.findUnique).not.toHaveBeenCalled()
    expect(mockedPrisma.angelPayUserAccount.findFirst).not.toHaveBeenCalled()
    expect(mockedPrisma.merchantAccount.create).toHaveBeenCalledTimes(1)
  })
})
