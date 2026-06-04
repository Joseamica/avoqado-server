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
  deactivateReferralProgram,
  updateReferralConfig,
  ActivateInput,
} from '@/services/referrals/referralProgram.service'

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
    // By default $transaction passes the same prisma proxy as the tx client.
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma))
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
      mockedPrisma.customer.findMany.mockResolvedValue([])
      await activateReferralProgram(input)
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

    it('generates codes for legacy customers without referralCode', async () => {
      mockedPrisma.referralProgramConfig.upsert.mockResolvedValue({
        id: 'cfg_1',
        codePrefix: 'TESTMF',
      })
      mockedPrisma.customer.findMany.mockResolvedValue([
        { id: 'cust_1', firstName: 'María', lastName: 'López' },
        { id: 'cust_2', firstName: 'Jose', lastName: 'Pérez' },
      ])
      mockedPrisma.customer.update.mockResolvedValue({})
      await activateReferralProgram(input)
      expect(mockedPrisma.customer.update).toHaveBeenCalledTimes(2)
      expect(generateReferralCode).toHaveBeenCalledTimes(2)
    })

    it('is idempotent — no updates when customers already have codes', async () => {
      mockedPrisma.referralProgramConfig.upsert.mockResolvedValue({
        id: 'cfg_1',
        codePrefix: 'TESTMF',
      })
      mockedPrisma.customer.findMany.mockResolvedValue([])
      await activateReferralProgram(input)
      expect(mockedPrisma.customer.update).not.toHaveBeenCalled()
    })

    it('validates tier requirements are strictly ascending', async () => {
      await expect(activateReferralProgram({ ...input, tier2ReferralsRequired: 5 })).rejects.toThrow(/ascending/i)
    })

    it('rejects negative numbers', async () => {
      await expect(activateReferralProgram({ ...input, tier1RewardPercent: -5 })).rejects.toThrow(/non-negative/i)
    })

    it('writes activity log entry on activation', async () => {
      mockedPrisma.referralProgramConfig.upsert.mockResolvedValue({
        id: 'cfg_1',
        codePrefix: 'TESTMF',
      })
      mockedPrisma.customer.findMany.mockResolvedValue([{ id: 'c1', firstName: 'X', lastName: null }])
      await activateReferralProgram(input)
      expect(mockedPrisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'REFERRAL_PROGRAM_ACTIVATED',
            venueId: 'venue_1',
            entity: 'ReferralProgramConfig',
            entityId: 'cfg_1',
            data: expect.objectContaining({ legacyCustomersMigrated: 1 }),
          }),
        }),
      )
    })

    it('derives codePrefix from venue.slug when codePrefix is undefined', async () => {
      mockedPrisma.referralProgramConfig.upsert.mockResolvedValue({
        id: 'cfg_1',
        codePrefix: null,
      })
      mockedPrisma.venue.findUnique.mockResolvedValue({ slug: 'avoqado-wellness' })
      mockedPrisma.customer.findMany.mockResolvedValue([{ id: 'c1', firstName: 'María', lastName: null }])
      await activateReferralProgram({ ...input, codePrefix: undefined })
      expect(generateReferralCode).toHaveBeenCalledWith(expect.objectContaining({ venuePrefix: 'avoqado-wellness' }))
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
