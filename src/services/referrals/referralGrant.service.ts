import prisma from '@/utils/prismaClient'
import { ReferralRewardGrant } from '@prisma/client'

export interface FulfillGrantInput {
  grantId: string
  venueId: string
  /**
   * Identifier of the staff member handing the courtesy over, already
   * resolved to a `StaffVenue.id` by the caller (the controller resolves
   * the authenticated `Staff.id` into a `StaffVenue.id` for THIS venue —
   * mirrors `referralCapture.service`'s `resolveStaffVenueId` — before
   * calling this service). Stored verbatim into `fulfilledByStaffVenueId`,
   * which is NOT a foreign key (same tolerance as
   * `Referral.capturedByStaffVenueId`), so an unresolved id is safe here.
   */
  performedBy: string
  /**
   * The authenticated `Staff.id` (from authContext.userId), threaded into
   * ActivityLog.staffId for audit accountability. Distinct from `performedBy`
   * (StaffVenue.id) — this is the real FK the audit trail expects.
   */
  staffId?: string
}

/**
 * Mark a `MANUAL_PENDING` FREE_PRODUCT grant as handed over to the referrer
 * (`MANUAL_FULFILLED`). This is the ONLY way a manual-fulfillment grant
 * leaves `MANUAL_PENDING` outside of a refund reversal
 * (`referralRefund.service`'s `REVOKED` path — see spec §6).
 *
 * Tenant isolation: the grant must belong to `venueId`. A grant that exists
 * but belongs to a different venue throws the SAME `GRANT_NOT_FOUND` error
 * as a missing grant, so this endpoint never leaks whether a `grantId`
 * exists in another tenant.
 */
export async function fulfillGrant(input: FulfillGrantInput): Promise<ReferralRewardGrant> {
  const grant = await prisma.referralRewardGrant.findUnique({ where: { id: input.grantId } })
  if (!grant || grant.venueId !== input.venueId) {
    throw new Error('GRANT_NOT_FOUND')
  }
  if (grant.status !== 'MANUAL_PENDING') {
    throw new Error('GRANT_NO_PENDIENTE')
  }

  // Update + audit log are wrapped in ONE transaction (mirrors onOrderPaid's
  // tx.activityLog.create pattern in referralQualification.service) so a
  // transient DB blip between the two can never leave the grant flipped to
  // MANUAL_FULFILLED with no ActivityLog row to show for it.
  const updated = await prisma.$transaction(async tx => {
    const result = await tx.referralRewardGrant.update({
      where: { id: input.grantId },
      data: {
        status: 'MANUAL_FULFILLED',
        fulfilledAt: new Date(),
        fulfilledByStaffVenueId: input.performedBy,
      },
    })

    await tx.activityLog.create({
      data: {
        venueId: input.venueId,
        action: 'REFERRAL_COURTESY_FULFILLED',
        entity: 'ReferralRewardGrant',
        entityId: grant.id,
        staffId: input.staffId ?? null,
        data: {
          rewardProductId: grant.rewardProductId,
          rewardQuantity: grant.rewardQuantity,
          customerId: grant.customerId,
          fulfilledByStaffVenueId: input.performedBy,
        },
      },
    })

    return result
  })

  return updated
}
