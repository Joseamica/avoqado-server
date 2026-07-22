/**
 * Referral Program — end-to-end integration tests.
 *
 * Codifies the Phase B Part 3 smoke flow as a Jest integration suite.
 * The suite creates and removes its own organization, venue, and staff
 * fixtures so it also runs on a clean `prisma migrate deploy` database.
 *
 * Test customers are tagged via two safe identifiers:
 *   - referralCode prefix `TESTSMOKE-` (so cleanup never touches real data)
 *   - phone prefix `5599999`             (catch unreferred test customers too)
 *
 * Order cleanup is scoped to the fixture venue and the `TEST-REF-` prefix.
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
// The referrer's tier reward is a plain CouponCode, so it must redeem through
// Avoqado's EXISTING coupon engine — no referral-specific redemption code.
import { validateCouponCode, recordCouponRedemption } from '@/services/dashboard/coupon.dashboard.service'

jest.setTimeout(60000)

describe('Referral Program — end-to-end integration', () => {
  let venueId: string
  let organizationId: string
  let waiterStaffVenueId: string
  let managerStaffVenueId: string
  const fixtureStaffIds: string[] = []
  const fixtureKey = `${process.pid}-${Date.now()}`

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
    await prisma.order.deleteMany({
      where: { venueId, orderNumber: { startsWith: 'TEST-REF-' } },
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
      throw new Error('Connected test DB is missing Discount.source. Run prisma migrate deploy before integration tests.')
    }

    const organization = await prisma.organization.create({
      data: {
        name: `Referral Integration ${fixtureKey}`,
        slug: `referral-integration-${fixtureKey}`,
        email: `referrals-${fixtureKey}@example.test`,
        phone: '5500000000',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: `Referral Integration ${fixtureKey}`,
        slug: `referral-integration-${fixtureKey}`,
      },
    })
    venueId = venue.id

    for (const [index, role] of ['WAITER', 'MANAGER'].entries()) {
      const staff = await prisma.staff.create({
        data: {
          email: `task1-referrals-${fixtureKey}-${index}@example.test`,
          firstName: index === 0 ? 'Waiter' : 'Manager',
          lastName: 'Integration',
        },
      })
      fixtureStaffIds.push(staff.id)
      await prisma.staffOrganization.create({
        data: { staffId: staff.id, organizationId },
      })
      const staffVenue = await prisma.staffVenue.create({
        data: { staffId: staff.id, venueId, role: role as 'WAITER' | 'MANAGER' },
      })
      if (index === 0) {
        waiterStaffVenueId = staffVenue.id
      } else {
        managerStaffVenueId = staffVenue.id
      }
    }
  })

  beforeEach(async () => {
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await prisma.venue.delete({ where: { id: venueId } })
    await prisma.staff.deleteMany({ where: { id: { in: fixtureStaffIds } } })
    await prisma.organization.delete({ where: { id: organizationId } })
    await prisma.$disconnect()
  })

  it('happy path: activate → capture → pay → TIER_1 unlock → reward emitted', async () => {
    await activateReferralProgram({
      venueId,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 1, // tier-up immediately on first qualified referral
      tier2ReferralsRequired: 2,
      tier3ReferralsRequired: 3,
      // NEW config API (Task 3): rewards are configured via `tiers`, not
      // the deprecated flat `tier{N}RewardPercent` fields — those are
      // type-compat only and are never written/read by the service anymore.
      tiers: [
        { tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 },
        { tierLevel: 2, rewardType: 'PERCENT_COUPON', rewardPercent: 20 },
        { tierLevel: 3, rewardType: 'PERCENT_COUPON', rewardPercent: 25 },
      ],
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
    // Prefix is normalized + capped at 8 chars to stay consistent with the
    // customer-code generator (normalizeVenuePrefix). 'TESTSMOKE' (9) → 'TESTSMOK'.
    // Real venue prefixes are ≤8 ('MINDFORM', 'AVOQADOW') so they pass through whole.
    expect(couponCode?.code).toMatch(/^TESTSMOK-TIER1-/)
    expect(couponCode?.active).toBe(true)

    const customerDiscount = await prisma.customerDiscount.findFirst({
      where: { discountId: qualified!.rewardDiscountId! },
    })
    expect(customerDiscount?.customerId).toBe(referrer.id)
    expect(customerDiscount?.active).toBe(true)

    // Per-test order cleanup — avoid leaving Order rows around.
    await prisma.order.delete({ where: { id: order.id } })
  })

  it('redeem cycle: referrer USES the earned tier coupon → 15% applies, redemption recorded, double-use blocked', async () => {
    // ── Earn the reward (capture → pay → tier-up) ─────────────────────────
    await activateReferralProgram({
      venueId,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 1,
      tier2ReferralsRequired: 2,
      tier3ReferralsRequired: 3,
      // NEW config API (Task 3): rewards are configured via `tiers`, not
      // the deprecated flat `tier{N}RewardPercent` fields — those are
      // type-compat only and are never written/read by the service anymore.
      tiers: [
        { tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 },
        { tierLevel: 2, rewardType: 'PERCENT_COUPON', rewardPercent: 20 },
        { tierLevel: 3, rewardType: 'PERCENT_COUPON', rewardPercent: 25 },
      ],
      rewardCouponExpiryDays: 90,
      codePrefix: 'TESTSMOKE',
    })

    const referrer = await prisma.customer.create({
      data: { venueId, firstName: 'Jose', lastName: 'Test', phone: '5599999011', referralCode: 'TESTSMOKE-JOSE011' },
    })
    const newCustomer = await prisma.customer.create({
      data: { venueId, firstName: 'María', lastName: 'Test', phone: '5599999012' },
    })

    const referral = await captureReferral({
      venueId,
      referralCode: 'TESTSMOKE-JOSE011',
      newCustomerId: newCustomer.id,
      capturedByStaffVenueId: waiterStaffVenueId,
    })
    const referredOrder = await prisma.order.create({
      data: {
        venueId,
        customerId: newCustomer.id,
        orderNumber: `TEST-REF-EARN-${Date.now()}`,
        status: 'PENDING',
        subtotal: 500,
        taxAmount: 0,
        total: 500,
        paidAmount: 0,
        remainingBalance: 500,
        discountAmount: 0,
        tipAmount: 0,
      },
    })
    await prisma.referral.update({ where: { id: referral.id }, data: { qualifyingOrderId: referredOrder.id } })
    await prisma.order.update({ where: { id: referredOrder.id }, data: { status: 'COMPLETED' } })
    await onOrderPaid({ orderId: referredOrder.id, venueId })

    const qualified = await prisma.referral.findUnique({ where: { id: referral.id } })
    const tierCoupon = await prisma.couponCode.findFirst({
      where: { discountId: qualified!.rewardDiscountId! },
    })
    expect(tierCoupon).toBeTruthy()
    expect(tierCoupon!.currentUses).toBe(0)

    // ── Redeem the reward (referrer makes a NEW purchase) ─────────────────
    const redeemOrder = await prisma.order.create({
      data: {
        venueId,
        customerId: referrer.id,
        orderNumber: `TEST-REF-REDEEM-${Date.now()}`,
        status: 'PENDING',
        subtotal: 500,
        taxAmount: 0,
        total: 500,
        paidAmount: 0,
        remainingBalance: 500,
        discountAmount: 0,
        tipAmount: 0,
      },
    })

    // 1. Validate through Avoqado's REAL coupon engine — must accept our coupon.
    const validation = await validateCouponCode(venueId, tierCoupon!.code, 500, referrer.id)
    expect(validation.valid).toBe(true)
    expect(validation.coupon?.discount.type).toBe('PERCENTAGE')
    expect(Number(validation.coupon?.discount.value)).toBe(15)

    // 2. Apply the 15% + record the redemption (what checkout/payment does).
    const amountSaved = 500 * 0.15 // 75
    await prisma.order.update({
      where: { id: redeemOrder.id },
      data: { discountAmount: amountSaved, total: 500 - amountSaved, remainingBalance: 500 - amountSaved },
    })
    await recordCouponRedemption(venueId, tierCoupon!.id, redeemOrder.id, amountSaved, referrer.id)

    const settled = await prisma.order.findUnique({ where: { id: redeemOrder.id } })
    expect(Number(settled?.discountAmount)).toBe(75)
    expect(Number(settled?.total)).toBe(425)

    const afterUse = await prisma.couponCode.findUnique({ where: { id: tierCoupon!.id } })
    expect(afterUse?.currentUses).toBe(1)

    const redemption = await prisma.couponRedemption.findUnique({ where: { orderId: redeemOrder.id } })
    expect(redemption).toBeTruthy()
    expect(Number(redemption?.amountSaved)).toBe(75)
    expect(redemption?.customerId).toBe(referrer.id)

    // 3. Single-use enforcement — a second redeem attempt must be rejected.
    const secondAttempt = await validateCouponCode(venueId, tierCoupon!.code, 500, referrer.id)
    expect(secondAttempt.valid).toBe(false)
    expect(secondAttempt.errorCode).toBe('USAGE_LIMIT')

    // Cleanup the two orders (redemption row cascades via cleanup()).
    await prisma.couponRedemption.deleteMany({ where: { orderId: redeemOrder.id } })
    await prisma.order.delete({ where: { id: redeemOrder.id } })
    await prisma.order.delete({ where: { id: referredOrder.id } })
  })

  it('refund flow: tier drops, reward revoked when unredeemed', async () => {
    await activateReferralProgram({
      venueId,
      newCustomerDiscountPercent: 10,
      tier1ReferralsRequired: 1,
      tier2ReferralsRequired: 2,
      tier3ReferralsRequired: 3,
      // NEW config API (Task 3): rewards are configured via `tiers`, not
      // the deprecated flat `tier{N}RewardPercent` fields — those are
      // type-compat only and are never written/read by the service anymore.
      tiers: [
        { tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 },
        { tierLevel: 2, rewardType: 'PERCENT_COUPON', rewardPercent: 20 },
        { tierLevel: 3, rewardType: 'PERCENT_COUPON', rewardPercent: 25 },
      ],
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
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
      // NEW config API (Task 3): rewards are configured via `tiers`, not
      // the deprecated flat `tier{N}RewardPercent` fields — those are
      // type-compat only and are never written/read by the service anymore.
      tiers: [
        { tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 },
        { tierLevel: 2, rewardType: 'PERCENT_COUPON', rewardPercent: 20 },
        { tierLevel: 3, rewardType: 'PERCENT_COUPON', rewardPercent: 25 },
      ],
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
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
      // NEW config API (Task 3): rewards are configured via `tiers`, not
      // the deprecated flat `tier{N}RewardPercent` fields — those are
      // type-compat only and are never written/read by the service anymore.
      tiers: [
        { tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 },
        { tierLevel: 2, rewardType: 'PERCENT_COUPON', rewardPercent: 20 },
        { tierLevel: 3, rewardType: 'PERCENT_COUPON', rewardPercent: 25 },
      ],
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
      tier2ReferralsRequired: 12,
      tier3ReferralsRequired: 20,
      // NEW config API (Task 3): rewards are configured via `tiers`, not
      // the deprecated flat `tier{N}RewardPercent` fields — those are
      // type-compat only and are never written/read by the service anymore.
      tiers: [
        { tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 },
        { tierLevel: 2, rewardType: 'PERCENT_COUPON', rewardPercent: 20 },
        { tierLevel: 3, rewardType: 'PERCENT_COUPON', rewardPercent: 25 },
      ],
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
      tier2ReferralsRequired: 2,
      tier3ReferralsRequired: 3,
      // NEW config API (Task 3): rewards are configured via `tiers`, not
      // the deprecated flat `tier{N}RewardPercent` fields — those are
      // type-compat only and are never written/read by the service anymore.
      tiers: [
        { tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 },
        { tierLevel: 2, rewardType: 'PERCENT_COUPON', rewardPercent: 20 },
        { tierLevel: 3, rewardType: 'PERCENT_COUPON', rewardPercent: 25 },
      ],
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
