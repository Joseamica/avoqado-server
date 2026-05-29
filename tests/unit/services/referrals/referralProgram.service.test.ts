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
  venue: { findUnique: jest.Mock }
  customer: { findMany: jest.Mock; update: jest.Mock }
  activityLog: { create: jest.Mock }
}

const { generateReferralCode } = require('@/services/referrals/referralCode.service')

describe('referralProgram.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // The interactive transaction must ONLY touch config + activityLog. The tx
    // client we hand the callback deliberately omits `customer` and `venue`, so
    // if activation ever moves per-customer work back INTO the transaction, the
    // callback throws (tx.customer is undefined) and the test fails. This is the
    // structural guard for the 2026-05-29 production incident (txn 5s timeout).
    mockedPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        referralProgramConfig: mockedPrisma.referralProgramConfig,
        activityLog: mockedPrisma.activityLog,
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
      tier1RewardPercent: 15,
      tier2ReferralsRequired: 12,
      tier2RewardPercent: 20,
      tier3ReferralsRequired: 20,
      tier3RewardPercent: 25,
      rewardCouponExpiryDays: 90,
      codePrefix: 'TESTMF',
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
      await expect(activateReferralProgram({ ...input, tier1RewardPercent: -5 })).rejects.toThrow(/non-negative/i)
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
      expect(mockedPrisma.venue.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'venue_1' } }),
      )
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
        patch: { tier1RewardPercent: 18 },
      })
      expect(mockedPrisma.referralProgramConfig.update).toHaveBeenCalledWith({
        where: { venueId: 'venue_1' },
        data: { tier1RewardPercent: 18 },
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
  })
})
