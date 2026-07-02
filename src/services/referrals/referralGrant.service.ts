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

  const updated = await prisma.referralRewardGrant.update({
    where: { id: input.grantId },
    data: {
      status: 'MANUAL_FULFILLED',
      fulfilledAt: new Date(),
      fulfilledByStaffVenueId: input.performedBy,
    },
  })

  // `staffId` is intentionally left unset (not a top-level ActivityLog
  // column write) — `performedBy` here is a `StaffVenue.id`, but
  // `ActivityLog.staffId` is a real FK to `Staff.id` (different id space).
  // Writing a StaffVenue id there would violate the constraint. The actor
  // is still recorded, just inside `data` — the same precaution already
  // taken by `manualVoidReferral` / `forceOverrideReferral` in
  // `referralCapture.service.ts`, neither of which sets a top-level
  // `staffId` for the same reason.
  await prisma.activityLog.create({
    data: {
      venueId: input.venueId,
      action: 'REFERRAL_COURTESY_FULFILLED',
      entity: 'ReferralRewardGrant',
      entityId: grant.id,
      data: {
        rewardProductId: grant.rewardProductId,
        rewardQuantity: grant.rewardQuantity,
        customerId: grant.customerId,
        fulfilledByStaffVenueId: input.performedBy,
      },
    },
  })

  return updated
}
