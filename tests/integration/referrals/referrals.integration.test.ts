/**
 * Referral Program — end-to-end integration tests.
 *
 * Codifies the Phase B Part 3 smoke flow as a Jest integration suite.
 * Runs against the LIVE local DB `av-db-25` (which carries the latest
 * Prisma schema including `Discount.source` and `Venue.reservationBranding`).
 *
 * The shared `tests/__helpers__/integration-setup.ts` prefers
 * `TEST_DATABASE_URL` over `DATABASE_URL`, so to run THIS suite against
 * `av-db-25` you must either:
 *
 *   1. Override at the CLI:
 *        TEST_DATABASE_URL="postgresql://postgres:exitosoy777@localhost:5432/av-db-25" \
 *        npx jest tests/integration/referrals/ --testTimeout=30000
 *
 *   2. Or temporarily point `TEST_DATABASE_URL` in your local `.env`
 *      at `av-db-25` (do not commit).
 *
 * The test asserts schema presence in `beforeAll` so an out-of-date
 * `av-db-25-test` DB fails fast with a clear message instead of confusing
 * column-missing errors deep in `cleanup`.
 *
 * Uses the seeded `avoqado-wellness` venue + its existing StaffVenues.
 *
 * Test customers are tagged via two safe identifiers:
 *   - referralCode prefix `TESTSMOKE-` (so cleanup never touches real data)
 *   - phone prefix `5599999`             (catch unreferred test customers too)
 *
 * Order cleanup is per-test (each test deletes the order it created) so
 * we never accidentally delete production orders during teardown.
 */

import prisma from '@/utils/prismaClient'
import { activateReferralProgram } from '@/services/referrals/referralProgram.service'
import {
  captureReferral,
  forceOverrideReferral,
  manualVoidReferral,
  validateReferralCode,
} from '@/services/referrals/referralCapture.service'
import { onOrderPaid } from '@/services/referrals/referralQualification.service'
import { onOrderRefunded } from '@/services/referrals/referralRefund.service'

jest.setTimeout(60000)

describe('Referral Program — end-to-end integration', () => {
  let venueId: string
  let waiterStaffVenueId: string
  let managerStaffVenueId: string

  async function cleanup() {
    // Order matters: child tables first. Scope EVERYTHING by venueId +
    // `source: REFERRAL_TIER` so we cannot touch unrelated discounts.
    await prisma.couponRedemption.deleteMany({
      where: { couponCode: { discount: { venueId, source: 'REFERRAL_TIER' } } },
    })
    await prisma.couponCode.deleteMany({
      where: { discount: { venueId, source: 'REFERRAL_TIER' } },
    })
    await prisma.customerDiscount.deleteMany({
      where: { discount: { venueId, source: 'REFERRAL_TIER' } },
    })
    await prisma.discount.deleteMany({ where: { venueId, source: 'REFERRAL_TIER' } })
    await prisma.referral.deleteMany({ where: { venueId } })
    await prisma.activityLog.deleteMany({
      where: { venueId, action: { startsWith: 'REFERRAL_' } },
    })
    // Test customers only — identified by referralCode prefix OR phone prefix.
    await prisma.customer.deleteMany({
      where: { venueId, referralCode: { startsWith: 'TESTSMOKE-' } },
    })
    await prisma.customer.deleteMany({
      where: { venueId, phone: { startsWith: '5599999' } },
    })
    await prisma.referralProgramConfig.deleteMany({ where: { venueId } })
  }

  beforeAll(async () => {
    // Fail fast if the DB is missing fields added by the referral migration.
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'Discount' AND column_name = 'source'
    `
    if (cols.length === 0) {
      throw new Error(
        'Connected DB is missing Discount.source. Override TEST_DATABASE_URL to point at av-db-25 (see file header).',
      )
    }

    const venue = await prisma.venue.findFirst({ where: { slug: 'avoqado-wellness' } })
    if (!venue) {
      throw new Error('Test venue avoqado-wellness not found in av-db-25')
    }
    venueId = venue.id

    const staffVenues = await prisma.staffVenue.findMany({ where: { venueId }, take: 5 })
    if (staffVenues.length < 2) {
      throw new Error('Need at least 2 StaffVenues in avoqado-wellness for integration tests')
    }
    waiterStaffVenueId = staffVenues[0].id
    managerStaffVenueId = staffVenues[1]?.id ?? staffVenues[0].id
  })

  beforeEach(async () => {
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it('happy path: activate → capture → pay → TIER_1 unlock → reward emitted', async () => {
    await activateReferralProgram({
      venueId,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 1, // tier-up immediately on first qualified referral
      tier1RewardPercent: 15,
      tier2ReferralsRequired: 2,
      tier2RewardPercent: 20,
      tier3ReferralsRequired: 3,
      tier3RewardPercent: 25,
      rewardCouponExpiryDays: 90,
      codePrefix: 'TESTSMOKE',
    })

    const referrer = await prisma.customer.create({
      data: {
        venueId,
        firstName: 'Jose',
        lastName: 'Test',
        phone: '5599999001',
        referralCode: 'TESTSMOKE-JOSE001',
      },
    })
    const newCustomer = await prisma.customer.create({
      data: { venueId, firstName: 'María', lastName: 'Test', phone: '5599999002' },
    })

    // Capture BEFORE Order creation — EXISTING_CUSTOMER check counts any
    // prior Order, so creating the order first would block the capture.
    const referral = await captureReferral({
      venueId,
      referralCode: 'TESTSMOKE-JOSE001',
      newCustomerId: newCustomer.id,
      capturedByStaffVenueId: waiterStaffVenueId,
    })
    expect(referral.status).toBe('PENDING')

    // Now create the order and link the referral to it.
    const order = await prisma.order.create({
      data: {
        venueId,
        customerId: newCustomer.id,
        orderNumber: `TEST-REF-HAPPY-${Date.now()}`,
        status: 'PENDING',
        subtotal: 500,
        taxAmount: 80,
        total: 580,
        paidAmount: 0,
        remainingBalance: 580,
        discountAmount: 0,
        tipAmount: 0,
      },
    })
    await prisma.referral.update({
      where: { id: referral.id },
      data: { qualifyingOrderId: order.id },
    })

    // Simulate the payment-settled webhook hand-off.
    await prisma.order.update({ where: { id: order.id }, data: { status: 'COMPLETED' } })
    await onOrderPaid({ orderId: order.id, venueId })

    const qualified = await prisma.referral.findUnique({ where: { id: referral.id } })
    expect(qualified?.status).toBe('QUALIFIED')
    expect(qualified?.qualifiedAt).toBeTruthy()
    expect(qualified?.rewardDiscountId).toBeTruthy()

    const updatedReferrer = await prisma.customer.findUnique({ where: { id: referrer.id } })
    expect(updatedReferrer?.referralCount).toBe(1)
    expect(updatedReferrer?.referralTier).toBe('TIER_1')

    const discount = await prisma.discount.findUnique({
      where: { id: qualified!.rewardDiscountId! },
    })
    expect(discount?.source).toBe('REFERRAL_TIER')
    expect(Number(discount?.value)).toBe(15)
    expect(discount?.active).toBe(true)

    const couponCode = await prisma.couponCode.findFirst({
      where: { discountId: qualified!.rewardDiscountId! },
    })
    expect(couponCode?.code).toMatch(/^TESTSMOKE-TIER1-/)
    expect(couponCode?.active).toBe(true)

    const customerDiscount = await prisma.customerDiscount.findFirst({
      where: { discountId: qualified!.rewardDiscountId! },
    })
    expect(customerDiscount?.customerId).toBe(referrer.id)
    expect(customerDiscount?.active).toBe(true)

    // Per-test order cleanup — avoid leaving Order rows around.
    await prisma.order.delete({ where: { id: order.id } })
  })

  it('refund flow: tier drops, reward revoked when unredeemed', async () => {
    await activateReferralProgram({
      venueId,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 1,
      tier1RewardPercent: 15,
      tier2ReferralsRequired: 2,
      tier2RewardPercent: 20,
      tier3ReferralsRequired: 3,
      tier3RewardPercent: 25,
      rewardCouponExpiryDays: 90,
      codePrefix: 'TESTSMOKE',
    })

    const referrer = await prisma.customer.create({
      data: {
        venueId,
        firstName: 'Jose',
        lastName: 'Test',
        phone: '5599999003',
        referralCode: 'TESTSMOKE-JOSE003',
      },
    })
    const newCustomer = await prisma.customer.create({
      data: { venueId, firstName: 'María', lastName: 'Test', phone: '5599999004' },
    })

    const ref = await captureReferral({
      venueId,
      referralCode: 'TESTSMOKE-JOSE003',
      newCustomerId: newCustomer.id,
      capturedByStaffVenueId: waiterStaffVenueId,
    })
    const order = await prisma.order.create({
      data: {
        venueId,
        customerId: newCustomer.id,
        orderNumber: `TEST-REF-REFUND-${Date.now()}`,
        status: 'PENDING',
        subtotal: 500,
        taxAmount: 80,
        total: 580,
        paidAmount: 0,
        remainingBalance: 580,
        discountAmount: 0,
        tipAmount: 0,
      },
    })
    await prisma.referral.update({
      where: { id: ref.id },
      data: { qualifyingOrderId: order.id },
    })
    await prisma.order.update({ where: { id: order.id }, data: { status: 'COMPLETED' } })
    await onOrderPaid({ orderId: order.id, venueId })

    // Pre-refund sanity check: referrer is at TIER_1.
    const preRefundRefer = await prisma.customer.findUnique({ where: { id: referrer.id } })
    expect(preRefundRefer?.referralTier).toBe('TIER_1')

    // Refund — should reverse tier + revoke unredeemed reward bundle.
    await onOrderRefunded({ orderId: order.id, venueId })

    const voided = await prisma.referral.findUnique({ where: { id: ref.id } })
    expect(voided?.status).toBe('VOID')
    expect(voided?.voidReason).toBe('ORDER_REFUNDED')

    const postRefundRefer = await prisma.customer.findUnique({ where: { id: referrer.id } })
    expect(postRefundRefer?.referralCount).toBe(0)
    expect(postRefundRefer?.referralTier).toBeNull()

    const revokedDiscount = await prisma.discount.findUnique({
      where: { id: voided!.rewardDiscountId! },
    })
    expect(revokedDiscount?.active).toBe(false)
    expect(revokedDiscount?.deactivatedReason).toBe('TIER_REVERSED_BY_REFUND')

    const revokedCC = await prisma.couponCode.findFirst({
      where: { discountId: voided!.rewardDiscountId! },
    })
    expect(revokedCC?.active).toBe(false)

    await prisma.order.delete({ where: { id: order.id } })
  })

  it('anti-fraud: rejects self-referral', async () => {
    await activateReferralProgram({
      venueId,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 7,
      tier1RewardPercent: 15,
      tier2ReferralsRequired: 12,
      tier2RewardPercent: 20,
      tier3ReferralsRequired: 20,
      tier3RewardPercent: 25,
      rewardCouponExpiryDays: 90,
      codePrefix: 'TESTSMOKE',
    })

    const self = await prisma.customer.create({
      data: {
        venueId,
        firstName: 'Self',
        lastName: 'Test',
        phone: '5599999005',
        referralCode: 'TESTSMOKE-SELF005',
      },
    })

    const result = await validateReferralCode({
      venueId,
      referralCode: 'TESTSMOKE-SELF005',
      newCustomerId: self.id,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('SELF_REFERRAL')
  })

  it('anti-fraud: rejects code from another venue / unknown code', async () => {
    await activateReferralProgram({
      venueId,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 7,
      tier1RewardPercent: 15,
      tier2ReferralsRequired: 12,
      tier2RewardPercent: 20,
      tier3ReferralsRequired: 20,
      tier3RewardPercent: 25,
      rewardCouponExpiryDays: 90,
      codePrefix: 'TESTSMOKE',
    })

    const newCustomer = await prisma.customer.create({
      data: { venueId, firstName: 'A', lastName: 'B', phone: '5599999006' },
    })

    const result = await validateReferralCode({
      venueId,
      referralCode: 'BOGUS-FAKEXX',
      newCustomerId: newCustomer.id,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('CODE_NOT_FOUND')
  })

  it('manager force-override: bypasses EXISTING_CUSTOMER + writes ActivityLog with managerStaffVenueId', async () => {
    await activateReferralProgram({
      venueId,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 7,
      tier1RewardPercent: 15,
      tier2ReferralsRequired: 12,
      tier2RewardPercent: 20,
      tier3ReferralsRequired: 20,
      tier3RewardPercent: 25,
      rewardCouponExpiryDays: 90,
      codePrefix: 'TESTSMOKE',
    })

    await prisma.customer.create({
      data: {
        venueId,
        firstName: 'Jose',
        lastName: 'Test',
        phone: '5599999007',
        referralCode: 'TESTSMOKE-JOSE007',
      },
    })
    const existingCustomer = await prisma.customer.create({
      data: { venueId, firstName: 'María', lastName: 'Existing', phone: '5599999008' },
    })

    const overridden = await forceOverrideReferral({
      venueId,
      referralCode: 'TESTSMOKE-JOSE007',
      existingCustomerId: existingCustomer.id,
      capturedByStaffVenueId: waiterStaffVenueId,
      managerStaffVenueId,
      reason: 'Cliente histórica, no se le había mencionado el programa antes',
    })
    expect(overridden.forcedOverride).toBe(true)

    const auditLog = await prisma.activityLog.findFirst({
      where: { venueId, action: 'REFERRAL_FORCE_OVERRIDE', entityId: overridden.id },
    })
    expect(auditLog).toBeTruthy()
    expect((auditLog?.data as any)?.managerStaffVenueId).toBe(managerStaffVenueId)
    expect((auditLog?.data as any)?.reason).toContain('Cliente histórica')
  })

  it('manual void: rejects on QUALIFIED Referral (use refund instead)', async () => {
    await activateReferralProgram({
      venueId,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 1,
      tier1RewardPercent: 15,
      tier2ReferralsRequired: 2,
      tier2RewardPercent: 20,
      tier3ReferralsRequired: 3,
      tier3RewardPercent: 25,
      rewardCouponExpiryDays: 90,
      codePrefix: 'TESTSMOKE',
    })

    await prisma.customer.create({
      data: {
        venueId,
        firstName: 'Jose',
        lastName: 'Test',
        phone: '5599999009',
        referralCode: 'TESTSMOKE-JOSE009',
      },
    })
    const newCustomer = await prisma.customer.create({
      data: { venueId, firstName: 'María', lastName: 'Test', phone: '5599999010' },
    })

    const ref = await captureReferral({
      venueId,
      referralCode: 'TESTSMOKE-JOSE009',
      newCustomerId: newCustomer.id,
      capturedByStaffVenueId: waiterStaffVenueId,
    })
    const order = await prisma.order.create({
      data: {
        venueId,
        customerId: newCustomer.id,
        orderNumber: `TEST-REF-VOID-${Date.now()}`,
        status: 'PENDING',
        subtotal: 500,
        taxAmount: 80,
        total: 580,
        paidAmount: 0,
        remainingBalance: 580,
        discountAmount: 0,
        tipAmount: 0,
      },
    })
    await prisma.referral.update({
      where: { id: ref.id },
      data: { qualifyingOrderId: order.id },
    })
    await prisma.order.update({ where: { id: order.id }, data: { status: 'COMPLETED' } })
    await onOrderPaid({ orderId: order.id, venueId })

    await expect(
      manualVoidReferral({
        referralId: ref.id,
        reason: 'fraud test',
        staffVenueId: managerStaffVenueId,
      }),
    ).rejects.toThrow(/already qualified/i)

    await prisma.order.delete({ where: { id: order.id } })
  })
})
