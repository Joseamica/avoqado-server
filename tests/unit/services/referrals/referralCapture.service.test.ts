/**
 * referralCapture.service tests — Phase B2, Tasks 10 + 11
 *
 * Schema notes:
 *   - `Customer` stores `firstName` / `lastName` (no unified `name`).
 *   - `Customer.referralCode` is unique per venue (composite uniqueness
 *     enforced upstream; we lookup with `findFirst` scoped by venueId).
 *   - Audit log model is `ActivityLog`; its JSON payload column is `data`,
 *     not `metadata`. The outer `data:` is Prisma's create-call argument,
 *     and the inner `data:` is the JSON column.
 *   - `Order.customerId` + `Order.venueId` count tells us whether the
 *     "new" customer is actually a returning customer.
 */

import {
  validateReferralCode,
  captureReferral,
  forceOverrideReferral,
  manualVoidReferral,
} from '@/services/referrals/referralCapture.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    referralProgramConfig: { findUnique: jest.fn() },
    customer: { findFirst: jest.fn(), findUnique: jest.fn() },
    referral: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    order: { count: jest.fn() },
    activityLog: { create: jest.fn() },
  },
}))

const mockedPrisma = prisma as any

describe('referralCapture.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Default: the supplied staff id resolves directly as a StaffVenue id.
    mockedPrisma.staffVenue.findFirst.mockResolvedValue({ id: 'sv_1' })
  })

  describe('validateReferralCode', () => {
    const ctx = { venueId: 'venue_1', referralCode: 'TESTMF-JOSE2K7', newCustomerId: 'cust_new' }

    it('rejects when program inactive', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: false })
      const result = await validateReferralCode(ctx)
      expect(result).toMatchObject({ valid: false, reason: 'PROGRAM_INACTIVE' })
    })

    it('rejects when no config exists', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue(null)
      const result = await validateReferralCode(ctx)
      expect(result).toMatchObject({ valid: false, reason: 'PROGRAM_INACTIVE' })
    })

    it('rejects when code does not exist in this venue', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue(null)
      const result = await validateReferralCode(ctx)
      expect(result).toMatchObject({ valid: false, reason: 'CODE_NOT_FOUND' })
    })

    it('rejects self-referral', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_new', firstName: 'X', lastName: 'Y' })
      const result = await validateReferralCode(ctx)
      expect(result).toMatchObject({ valid: false, reason: 'SELF_REFERRAL' })
    })

    it('rejects existing customer (has prior Orders)', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.order.count.mockResolvedValue(3)
      const result = await validateReferralCode(ctx)
      expect(result).toMatchObject({ valid: false, reason: 'EXISTING_CUSTOMER' })
    })

    it('returns valid + referrer + discountPercent when all checks pass', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({
        active: true,
        newCustomerDiscountPercent: 10,
      })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'Pérez' })
      mockedPrisma.order.count.mockResolvedValue(0)
      const result = await validateReferralCode(ctx)
      expect(result.valid).toBe(true)
      expect(result.referrer?.id).toBe('cust_ref')
      expect(result.discountPercent).toBe(10)
    })
  })

  describe('captureReferral', () => {
    it('creates Referral with PENDING status', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.order.count.mockResolvedValue(0)
      mockedPrisma.referral.create.mockResolvedValue({ id: 'ref_1', status: 'PENDING' })
      await captureReferral({
        venueId: 'venue_1',
        referralCode: 'TESTMF-JOSE2K7',
        newCustomerId: 'cust_new',
        capturedByStaffVenueId: 'sv_1',
        intendedOrderId: 'order_pending',
      })
      expect(mockedPrisma.referral.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          venueId: 'venue_1',
          referrerCustomerId: 'cust_ref',
          referredCustomerId: 'cust_new',
          status: 'PENDING',
          capturedByStaffVenueId: 'sv_1',
          qualifyingOrderId: 'order_pending',
        }),
      })
    })

    it('resolves a raw Staff.id into the StaffVenue.id (mobile clients send Staff.id) — regression for FK violation', async () => {
      // Live-discovered bug: mobile apps persist Staff.id (userId), not the
      // StaffVenue join-row id the FK requires. Passing Staff.id straight to
      // the insert crashed capture with a 500 FK violation. The service now
      // resolves it: first findFirst({id}) misses, then findFirst({staffId}) hits.
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.order.count.mockResolvedValue(0)
      mockedPrisma.referral.create.mockResolvedValue({ id: 'ref_1', status: 'PENDING' })
      mockedPrisma.staffVenue.findFirst
        .mockResolvedValueOnce(null) // not a StaffVenue.id
        .mockResolvedValueOnce({ id: 'sv_resolved' }) // but matches a Staff.id at this venue
      await captureReferral({
        venueId: 'venue_1',
        referralCode: 'TESTMF-JOSE2K7',
        newCustomerId: 'cust_new',
        capturedByStaffVenueId: 'staff_raw_id',
      })
      expect(mockedPrisma.referral.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ capturedByStaffVenueId: 'sv_resolved' }),
      })
    })

    it('falls back to null capturedByStaffVenueId when the staff id cannot be resolved (no FK crash)', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: true, newCustomerDiscountPercent: 10 })
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.order.count.mockResolvedValue(0)
      mockedPrisma.referral.create.mockResolvedValue({ id: 'ref_1', status: 'PENDING' })
      mockedPrisma.staffVenue.findFirst.mockResolvedValue(null) // neither StaffVenue.id nor Staff.id
      await captureReferral({
        venueId: 'venue_1',
        referralCode: 'TESTMF-JOSE2K7',
        newCustomerId: 'cust_new',
        capturedByStaffVenueId: 'totally_unknown_id',
      })
      expect(mockedPrisma.referral.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ capturedByStaffVenueId: null }),
      })
    })

    it('throws with reason when validation fails', async () => {
      mockedPrisma.referralProgramConfig.findUnique.mockResolvedValue({ active: false })
      await expect(
        captureReferral({
          venueId: 'venue_1',
          referralCode: 'X',
          newCustomerId: 'cust_new',
          capturedByStaffVenueId: 'sv_1',
        }),
      ).rejects.toThrow(/PROGRAM_INACTIVE/)
    })
  })

  describe('forceOverrideReferral', () => {
    it('creates Referral with forcedOverride=true and writes activity log', async () => {
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_ref', firstName: 'Jose', lastName: 'P' })
      mockedPrisma.referral.create.mockResolvedValue({
        id: 'ref_force',
        venueId: 'venue_1',
        forcedOverride: true,
      })
      await forceOverrideReferral({
        venueId: 'venue_1',
        referralCode: 'TESTMF-JOSE2K7',
        existingCustomerId: 'cust_existing',
        capturedByStaffVenueId: 'sv_waiter',
        managerStaffVenueId: 'sv_manager',
        reason: 'Cliente histórica, no se le había mencionado el programa',
      })
      expect(mockedPrisma.referral.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          forcedOverride: true,
          overrideReason: expect.stringContaining('Cliente histórica'),
        }),
      })
      expect(mockedPrisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'REFERRAL_FORCE_OVERRIDE',
            entity: 'Referral',
            entityId: 'ref_force',
            venueId: 'venue_1',
            data: expect.objectContaining({
              reason: expect.any(String),
              managerStaffVenueId: 'sv_manager',
            }),
          }),
        }),
      )
    })

    it('rejects when code does not exist', async () => {
      mockedPrisma.customer.findFirst.mockResolvedValue(null)
      await expect(
        forceOverrideReferral({
          venueId: 'venue_1',
          referralCode: 'BOGUS-X',
          existingCustomerId: 'cust_existing',
          capturedByStaffVenueId: 'sv_1',
          managerStaffVenueId: 'sv_manager',
          reason: 'X',
        }),
      ).rejects.toThrow(/CODE_NOT_FOUND/)
    })

    it('rejects self-referral even with override', async () => {
      mockedPrisma.customer.findFirst.mockResolvedValue({ id: 'cust_existing', firstName: 'Jose', lastName: 'P' })
      await expect(
        forceOverrideReferral({
          venueId: 'venue_1',
          referralCode: 'TESTMF-JOSE2K7',
          existingCustomerId: 'cust_existing',
          capturedByStaffVenueId: 'sv_1',
          managerStaffVenueId: 'sv_manager',
          reason: 'X',
        }),
      ).rejects.toThrow(/SELF_REFERRAL/)
    })
  })

  describe('manualVoidReferral', () => {
    it('sets status VOID, voidedAt, voidReason + activity log', async () => {
      mockedPrisma.referral.findUnique.mockResolvedValue({ id: 'ref_1', status: 'PENDING', venueId: 'venue_1' })
      mockedPrisma.referral.update.mockResolvedValue({ id: 'ref_1', status: 'VOID' })
      await manualVoidReferral({ referralId: 'ref_1', reason: 'Fraude detectado', staffVenueId: 'sv_manager' })
      expect(mockedPrisma.referral.update).toHaveBeenCalledWith({
        where: { id: 'ref_1' },
        data: expect.objectContaining({
          status: 'VOID',
          voidedAt: expect.any(Date),
          voidReason: 'Fraude detectado',
        }),
      })
      expect(mockedPrisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'REFERRAL_MANUAL_VOID',
            entity: 'Referral',
            entityId: 'ref_1',
          }),
        }),
      )
    })

    it('rejects when Referral is already QUALIFIED (must use refund flow)', async () => {
      mockedPrisma.referral.findUnique.mockResolvedValue({ id: 'ref_1', status: 'QUALIFIED', venueId: 'venue_1' })
      await expect(manualVoidReferral({ referralId: 'ref_1', reason: 'X', staffVenueId: 'sv_1' })).rejects.toThrow(/already qualified/i)
    })

    it('rejects when Referral does not exist', async () => {
      mockedPrisma.referral.findUnique.mockResolvedValue(null)
      await expect(manualVoidReferral({ referralId: 'ghost', reason: 'X', staffVenueId: 'sv_1' })).rejects.toThrow(/not found/i)
    })
  })
})
