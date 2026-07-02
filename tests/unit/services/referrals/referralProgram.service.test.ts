/**
 * referralProgram.service tests — Phase B1, Tasks 8 + 9
 *
 * Schema note: `Customer` in Avoqado stores `firstName` / `lastName`
 * (there is no unified `name` column). The service composes the display
 * name as `firstName + ' ' + lastName` before handing it to the code
 * generator, so the mocks below return those two fields.
 *
 * Audit log model is `ActivityLog`. JSON payload column is `data`,
 * not `metadata`. Per Phase A notes, when an action is not tied to a
 * specific staff member we leave `staffId` null.
 */

import prisma from '@/utils/prismaClient'
import {
  activateReferralProgram,
  backfillLegacyReferralCodes,
  deactivateReferralProgram,
  updateReferralConfig,
  ActivateInput,
} from '@/services/referrals/referralProgram.service'

// Flush pending microtasks so the fire-and-forget backfill kicked off by
// activateReferralProgram settles before a test ends (prevents cross-test bleed).
const flush = () => new Promise(resolve => setImmediate(resolve))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    referralProgramConfig: {
      upsert: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    referralTierReward: {
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    product: { findFirst: jest.fn() },
    venue: { findUnique: jest.fn() },
    customer: { findMany: jest.fn(), update: jest.fn() },
    activityLog: { create: jest.fn() },
  },
}))

jest.mock('@/services/referrals/referralCode.service', () => ({
  generateReferralCode: jest.fn().mockResolvedValue('TESTMF-TEST123'),
}))

const mockedPrisma = prisma as unknown as {
  $transaction: jest.Mock
  referralProgramConfig: {
    upsert: jest.Mock
    update: jest.Mock
    findUnique: jest.Mock
  }
  referralTierReward: {
    create: jest.Mock
    updateMany: jest.Mock
  }
  product: { findFirst: jest.Mock }
  venue: { findUnique: jest.Mock }
  customer: { findMany: jest.Mock; update: jest.Mock }
  activityLog: { create: jest.Mock }
}

const { generateReferralCode } = require('@/services/referrals/referralCode.service')

describe('referralProgram.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // The interactive transaction must ONLY touch config + activityLog (+ tier
    // rewards, for the separate persistTierRewards transaction). The tx client
    // we hand the callback deliberately omits `customer` and `venue`, so if
    // activation ever moves per-customer work back INTO the transaction, the
    // callback throws (tx.customer is undefined) and the test fails. This is the
    // structural guard for the 2026-05-29 production incident (txn 5s timeout).
    mockedPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        referralProgramConfig: mockedPrisma.referralProgramConfig,
        activityLog: mockedPrisma.activityLog,
        referralTierReward: mockedPrisma.referralTierReward,
      }),
    )
    // Default: backfill (fire-and-forget) finds nothing → clean no-op.
    mockedPrisma.customer.findMany.mockResolvedValue([])
  })

  describe('activateReferralProgram', () => {
    const input: ActivateInput = {
      venueId: 'venue_1',
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 7,
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
      rewardCouponExpiryDays: 90,
      codePrefix: 'TESTMF',
      // Mirrors the pre-configurable-rewards behavior (15/20/25% one-time
      // coupons) but now expressed as ReferralTierReward rows instead of
      // the legacy flat tier{N}RewardPercent columns.
      tiers: [
        { tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 },
        { tierLevel: 2, rewardType: 'PERCENT_COUPON', rewardPercent: 20 },
        { tierLevel: 3, rewardType: 'PERCENT_COUPON', rewardPercent: 25 },
      ],
    }

    it('creates config with active=true and activatedAt set', async () => {
      mockedPrisma.referralProgramConfig.upsert.mockResolvedValue({
        id: 'cfg_1',
        active: true,
        codePrefix: 'TESTMF',
      })
      await activateReferralProgram(input)
      await flush()
      expect(mockedPrisma.referralProgramConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { venueId: 'venue_1' },
          create: expect.objectContaining({
            active: true,
            activatedAt: expect.any(Date),
          }),
          update: expect.objectContaining({
            active: true,
            activatedAt: expect.any(Date),
          }),
        }),
      )
    })

    it('REGRESSION: does NOT do per-customer work inside the transaction (prod 5s timeout)', async () => {
      // The tx client (see beforeEach) has no `customer`. If the activation
      // transaction tried any customer op, it would throw here. A clean return
      // proves the config txn is O(1) and the backfill runs outside it.
      mockedPrisma.referralProgramConfig.upsert.mockResolvedValue({ id: 'cfg_1', codePrefix: 'TESTMF' })
      await expect(activateReferralProgram(input)).resolves.toBeUndefined()
      await flush()
    })

    it('validates tier requirements are strictly ascending', async () => {
      await expect(activateReferralProgram({ ...input, tier2ReferralsRequired: 5 })).rejects.toThrow(/ascending/i)
    })

    it('rejects negative numbers', async () => {
      // tier1RewardPercent (etc.) is now deprecated/ignored — the non-negative
      // guard is exercised through a still-live scalar field instead.
      await expect(activateReferralProgram({ ...input, newCustomerDiscountPercent: -5 })).rejects.toThrow(/non-negative/i)
    })

    it('rejects a PERCENT_COUPON tier reward with a negative rewardPercent (PORCENTAJE_INVALIDO)', async () => {
      await expect(
        activateReferralProgram({
          ...input,
          tiers: [{ tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: -5 }],
        }),
      ).rejects.toThrow('PORCENTAJE_INVALIDO')
    })

    it('REGRESSION: does not touch ReferralTierReward when tiers is omitted', async () => {
      mockedPrisma.referralProgramConfig.upsert.mockResolvedValue({ id: 'cfg_1', codePrefix: 'TESTMF' })
      await activateReferralProgram({ ...input, tiers: undefined })
      await flush()
      expect(mockedPrisma.referralTierReward.create).not.toHaveBeenCalled()
      expect(mockedPrisma.referralTierReward.updateMany).not.toHaveBeenCalled()
    })

    it('persists each configured tier as a ReferralTierReward row tied to the new config', async () => {
      mockedPrisma.referralProgramConfig.upsert.mockResolvedValue({ id: 'cfg_1', codePrefix: 'TESTMF' })
      await activateReferralProgram(input)
      await flush()
      expect(mockedPrisma.referralTierReward.create).toHaveBeenCalledTimes(3)
      expect(mockedPrisma.referralTierReward.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ configId: 'cfg_1', tierLevel: 1, rewardType: 'PERCENT_COUPON' }),
        }),
      )
    })

    it('writes activity log entry tagged backfillScheduled', async () => {
      mockedPrisma.referralProgramConfig.upsert.mockResolvedValue({
        id: 'cfg_1',
        codePrefix: 'TESTMF',
      })
      await activateReferralProgram(input)
      await flush()
      expect(mockedPrisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'REFERRAL_PROGRAM_ACTIVATED',
            venueId: 'venue_1',
            entity: 'ReferralProgramConfig',
            entityId: 'cfg_1',
            data: expect.objectContaining({ backfillScheduled: true }),
          }),
        }),
      )
    })

    it('looks up venue.slug for the prefix only when codePrefix is null', async () => {
      mockedPrisma.referralProgramConfig.upsert.mockResolvedValue({ id: 'cfg_1', codePrefix: null })
      mockedPrisma.venue.findUnique.mockResolvedValue({ slug: 'avoqado-wellness' })
      await activateReferralProgram({ ...input, codePrefix: undefined })
      await flush()
      expect(mockedPrisma.venue.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'venue_1' } }))
    })

    it('does NOT look up venue when codePrefix is present', async () => {
      mockedPrisma.referralProgramConfig.upsert.mockResolvedValue({ id: 'cfg_1', codePrefix: 'TESTMF' })
      await activateReferralProgram(input)
      await flush()
      expect(mockedPrisma.venue.findUnique).not.toHaveBeenCalled()
    })
  })

  describe('backfillLegacyReferralCodes', () => {
    it('assigns codes to all null-code customers, draining in batches', async () => {
      mockedPrisma.customer.findMany
        .mockResolvedValueOnce([
          { id: 'cust_1', firstName: 'María', lastName: 'López' },
          { id: 'cust_2', firstName: 'Jose', lastName: 'Pérez' },
        ])
        .mockResolvedValueOnce([]) // second pass: drained
      mockedPrisma.customer.update.mockResolvedValue({})
      const n = await backfillLegacyReferralCodes('venue_1', 'TESTMF')
      expect(n).toBe(2)
      expect(generateReferralCode).toHaveBeenCalledTimes(2)
      expect(generateReferralCode).toHaveBeenCalledWith(expect.objectContaining({ venuePrefix: 'TESTMF' }))
      expect(mockedPrisma.customer.update).toHaveBeenCalledTimes(2)
    })

    it('no-ops (returns 0) when every customer already has a code', async () => {
      mockedPrisma.customer.findMany.mockResolvedValueOnce([])
      const n = await backfillLegacyReferralCodes('venue_1', 'TESTMF')
      expect(n).toBe(0)
      expect(mockedPrisma.customer.update).not.toHaveBeenCalled()
    })
  })

  describe('deactivateReferralProgram', () => {
    it('sets active=false and writes activity log', async () => {
      mockedPrisma.referralProgramConfig.update.mockResolvedValue({
        id: 'cfg_1',
        active: false,
      })
      await deactivateReferralProgram({
        venueId: 'venue_1',
        reason: 'pausing for season',
      })
      expect(mockedPrisma.referralProgramConfig.update).toHaveBeenCalledWith({
        where: { venueId: 'venue_1' },
        data: { active: false },
      })
      expect(mockedPrisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'REFERRAL_PROGRAM_DEACTIVATED',
            venueId: 'venue_1',
            data: expect.objectContaining({ reason: 'pausing for season' }),
          }),
        }),
      )
    })
  })

  describe('updateReferralConfig', () => {
    it('allows partial updates', async () => {
      mockedPrisma.referralProgramConfig.update.mockResolvedValue({})
      await updateReferralConfig({
        venueId: 'venue_1',
        // tier1RewardPercent is retired from the patch shape — this now
        // exercises a still-live scalar field (see REGRESSION note below).
        patch: { newCustomerDiscountPercent: 18 },
      })
      expect(mockedPrisma.referralProgramConfig.update).toHaveBeenCalledWith({
        where: { venueId: 'venue_1' },
        data: { newCustomerDiscountPercent: 18 },
      })
    })

    it('validates tier ordering on patch', async () => {
      await expect(
        updateReferralConfig({
          venueId: 'venue_1',
          patch: { tier2ReferralsRequired: 5, tier1ReferralsRequired: 10 },
        }),
      ).rejects.toThrow(/ascending/i)
    })

    it('REGRESSION: never writes the legacy flat tier{N}RewardPercent columns, even if a caller still sends them', async () => {
      mockedPrisma.referralProgramConfig.update.mockResolvedValue({})
      await updateReferralConfig({
        venueId: 'venue_1',
        // `tier1RewardPercent` is a deprecated field kept ONLY so stale callers
        // still type-check; the service must strip it before writing.
        patch: { newCustomerDiscountPercent: 18, tier1RewardPercent: 99 },
      })
      expect(mockedPrisma.referralProgramConfig.update).toHaveBeenCalledWith({
        where: { venueId: 'venue_1' },
        data: { newCustomerDiscountPercent: 18 },
      })
    })

    it('rejects FREE_PRODUCT whose product belongs to another venue', async () => {
      mockedPrisma.product.findFirst.mockResolvedValue(null) // no existe en este venue
      await expect(
        updateReferralConfig({
          venueId: 'v1',
          tiers: [{ tierLevel: 3, rewardType: 'FREE_PRODUCT', rewardProductId: 'p-other-venue', rewardQuantity: 1 }],
        }),
      ).rejects.toThrow('PRODUCTO_NO_PERTENECE_AL_VENUE')
      expect(mockedPrisma.referralTierReward.create).not.toHaveBeenCalled()
    })

    it('rejects FREE_PRODUCT with a MISSING rewardProductId, even if Prisma would ignore the undefined filter and match an arbitrary product in the venue', async () => {
      // Real Prisma behavior: findFirst({ where: { id: undefined, venueId } }) DROPS the
      // undefined `id` filter and matches an arbitrary product in the venue — simulated
      // here by resolving a truthy row. Without an explicit upfront guard, the missing-id
      // case would slip through validateTierRewards exactly like a valid product would.
      mockedPrisma.product.findFirst.mockResolvedValue({ id: 'arbitrary-product-in-venue' })
      await expect(
        updateReferralConfig({
          venueId: 'v1',
          tiers: [{ tierLevel: 3, rewardType: 'FREE_PRODUCT', rewardQuantity: 1 }],
        }),
      ).rejects.toThrow('PRODUCTO_NO_PERTENECE_AL_VENUE')
      // The guard must fire BEFORE ever querying the DB with an undefined id filter.
      expect(mockedPrisma.product.findFirst).not.toHaveBeenCalled()
      expect(mockedPrisma.referralTierReward.create).not.toHaveBeenCalled()
    })

    it('accepts FREE_PRODUCT whose product belongs to the venue', async () => {
      mockedPrisma.product.findFirst.mockResolvedValue({ id: 'p1' })
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg1', venueId: 'v1' })
      await updateReferralConfig({
        venueId: 'v1',
        tiers: [{ tierLevel: 3, rewardType: 'FREE_PRODUCT', rewardProductId: 'p1', rewardQuantity: 1 }],
      })
      expect(mockedPrisma.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p1', venueId: 'v1' } }))
      expect(mockedPrisma.referralTierReward.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ configId: 'cfg1', tierLevel: 3, rewardType: 'FREE_PRODUCT', rewardProductId: 'p1' }),
        }),
      )
    })

    it('persists a percent reward as a ReferralTierReward row', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg1', venueId: 'v1' })
      await updateReferralConfig({ venueId: 'v1', tiers: [{ tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 }] })
      expect(mockedPrisma.referralTierReward.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tierLevel: 1, rewardType: 'PERCENT_COUPON' }),
        }),
      )
    })

    it('rejects PERCENT_COUPON / PERMANENT_DISCOUNT without a rewardPercent (PORCENTAJE_INVALIDO)', async () => {
      await expect(updateReferralConfig({ venueId: 'v1', tiers: [{ tierLevel: 2, rewardType: 'PERMANENT_DISCOUNT' }] })).rejects.toThrow(
        'PORCENTAJE_INVALIDO',
      )
    })

    it('versioning: deactivates existing active rows for the tier BEFORE creating the replacement row, atomically inside $transaction', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg1', venueId: 'v1' })
      const callOrder: string[] = []
      mockedPrisma.referralTierReward.updateMany.mockImplementation(async () => {
        callOrder.push('updateMany')
        return { count: 1 }
      })
      mockedPrisma.referralTierReward.create.mockImplementation(async () => {
        callOrder.push('create')
        return {}
      })
      await updateReferralConfig({ venueId: 'v1', tiers: [{ tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 20 }] })
      // Atomicity guard: the updateMany + create pair MUST run through
      // prisma.$transaction, not as two independent top-level calls — a
      // transient DB error between them would otherwise leave the tier with
      // zero active rewards (real risk per documented P1001/P2024 blips).
      expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1)
      expect(mockedPrisma.referralTierReward.updateMany).toHaveBeenCalledWith({
        where: { configId: 'cfg1', tierLevel: 1, active: true },
        data: { active: false },
      })
      expect(callOrder).toEqual(['updateMany', 'create'])
    })

    it('supports several rewards for the same tier level in one call (e.g. coupon + free product)', async () => {
      mockedPrisma.product.findFirst.mockResolvedValue({ id: 'p1' })
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ id: 'cfg1', venueId: 'v1' })
      await updateReferralConfig({
        venueId: 'v1',
        tiers: [
          { tierLevel: 3, rewardType: 'PERCENT_COUPON', rewardPercent: 25 },
          { tierLevel: 3, rewardType: 'FREE_PRODUCT', rewardProductId: 'p1', rewardQuantity: 1 },
        ],
      })
      expect(mockedPrisma.referralTierReward.create).toHaveBeenCalledTimes(2)
      // Deactivation of prior tier-3 rows happens exactly once per tier level, not per reward.
      expect(mockedPrisma.referralTierReward.updateMany).toHaveBeenCalledTimes(1)
    })

    it('REGRESSION: does not touch ReferralTierReward when tiers is omitted', async () => {
      mockedPrisma.referralProgramConfig.update.mockResolvedValue({})
      await updateReferralConfig({ venueId: 'venue_1', patch: { newCustomerDiscountPercent: 5 } })
      expect(mockedPrisma.referralTierReward.create).not.toHaveBeenCalled()
      expect(mockedPrisma.referralTierReward.updateMany).not.toHaveBeenCalled()
      expect(mockedPrisma.referralProgramConfig.findUnique).not.toHaveBeenCalled()
    })
  })
})
