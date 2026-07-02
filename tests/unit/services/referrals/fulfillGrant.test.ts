/**
 * fulfillGrant tests — Task 8 (FREE_PRODUCT manual fulfillment endpoint)
 *
 * `FREE_PRODUCT` tier rewards never carry a Discount/CouponCode artifact —
 * they're emitted `MANUAL_PENDING` (referralQualification.service) and stay
 * that way until a staff member physically hands the product over. This
 * covers the ONLY transition out of `MANUAL_PENDING` on the happy path:
 * `MANUAL_PENDING` -> `MANUAL_FULFILLED` (the other exit, `REVOKED` via
 * refund, is covered by `referralRefund.service.test.ts`).
 *
 * Uses the SHARED `prismaMock` (tests/__helpers__/setup.ts) — same
 * convention as `onOrderPaid.test.ts` — since `referralRewardGrant` and
 * `staffVenue` are already registered there.
 */

import { prismaMock } from '@tests/__helpers__/setup'
import { fulfillGrant } from '@/services/referrals/referralGrant.service'

describe('fulfillGrant', () => {
  const venueId = 'venue_1'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ==========================================
  // NEW FEATURE
  // ==========================================

  it('marks a MANUAL_PENDING grant as MANUAL_FULFILLED', async () => {
    prismaMock.referralRewardGrant.findUnique.mockResolvedValue({ id: 'g1', status: 'MANUAL_PENDING', venueId } as any)
    await fulfillGrant({ grantId: 'g1', venueId, performedBy: 'sv1' })
    expect(prismaMock.referralRewardGrant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'g1' },
        data: expect.objectContaining({ status: 'MANUAL_FULFILLED', fulfilledByStaffVenueId: 'sv1' }),
      }),
    )
  })

  it('stamps fulfilledAt with a Date on the update', async () => {
    prismaMock.referralRewardGrant.findUnique.mockResolvedValue({ id: 'g1', status: 'MANUAL_PENDING', venueId } as any)
    await fulfillGrant({ grantId: 'g1', venueId, performedBy: 'sv1' })
    const call = prismaMock.referralRewardGrant.update.mock.calls[0][0]
    expect(call.data.fulfilledAt).toBeInstanceOf(Date)
  })

  it('rejects fulfilling a non-pending grant with GRANT_NO_PENDIENTE', async () => {
    prismaMock.referralRewardGrant.findUnique.mockResolvedValue({ id: 'g1', status: 'ISSUED', venueId } as any)
    await expect(fulfillGrant({ grantId: 'g1', venueId, performedBy: 'sv1' })).rejects.toThrow('GRANT_NO_PENDIENTE')
    expect(prismaMock.referralRewardGrant.update).not.toHaveBeenCalled()
  })

  it('rejects an already MANUAL_FULFILLED grant with GRANT_NO_PENDIENTE', async () => {
    prismaMock.referralRewardGrant.findUnique.mockResolvedValue({ id: 'g1', status: 'MANUAL_FULFILLED', venueId } as any)
    await expect(fulfillGrant({ grantId: 'g1', venueId, performedBy: 'sv1' })).rejects.toThrow('GRANT_NO_PENDIENTE')
    expect(prismaMock.referralRewardGrant.update).not.toHaveBeenCalled()
  })

  it('throws GRANT_NOT_FOUND when the grant belongs to a different venue (tenant isolation)', async () => {
    prismaMock.referralRewardGrant.findUnique.mockResolvedValue({
      id: 'g1',
      status: 'MANUAL_PENDING',
      venueId: 'other_venue',
    } as any)
    await expect(fulfillGrant({ grantId: 'g1', venueId, performedBy: 'sv1' })).rejects.toThrow('GRANT_NOT_FOUND')
    expect(prismaMock.referralRewardGrant.update).not.toHaveBeenCalled()
  })

  it('throws GRANT_NOT_FOUND when the grant does not exist', async () => {
    prismaMock.referralRewardGrant.findUnique.mockResolvedValue(null)
    await expect(fulfillGrant({ grantId: 'missing', venueId, performedBy: 'sv1' })).rejects.toThrow('GRANT_NOT_FOUND')
    expect(prismaMock.referralRewardGrant.update).not.toHaveBeenCalled()
  })

  it('writes an ActivityLog row tagged REFERRAL_COURTESY_FULFILLED', async () => {
    prismaMock.referralRewardGrant.findUnique.mockResolvedValue({
      id: 'g1',
      status: 'MANUAL_PENDING',
      venueId,
      rewardProductId: 'prod_1',
      rewardQuantity: 2,
      customerId: 'cust_1',
    } as any)
    await fulfillGrant({ grantId: 'g1', venueId, performedBy: 'sv1' })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: {
        venueId,
        action: 'REFERRAL_COURTESY_FULFILLED',
        entity: 'ReferralRewardGrant',
        entityId: 'g1',
        data: {
          rewardProductId: 'prod_1',
          rewardQuantity: 2,
          customerId: 'cust_1',
          fulfilledByStaffVenueId: 'sv1',
        },
      },
    })
  })

  // ==========================================
  // REGRESSION — doesn't touch unrelated grant statuses/paths
  // ==========================================

  it('does not write ActivityLog when validation fails before the update', async () => {
    prismaMock.referralRewardGrant.findUnique.mockResolvedValue({ id: 'g1', status: 'REVOKED', venueId } as any)
    await expect(fulfillGrant({ grantId: 'g1', venueId, performedBy: 'sv1' })).rejects.toThrow('GRANT_NO_PENDIENTE')
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})
