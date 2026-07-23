import { VenueStatus, VerificationStatus } from '@prisma/client'

export interface InitialVenueState {
  status: VenueStatus
  active: boolean
  /** Staff who set the status — only when we activate immediately (mirrors approveVenue). */
  statusChangedBy: string | null
  /** KYC pre-approval — the wizard checkbox says "Pre-aprobar KYC", so mirror approveKyc's fields. */
  kycStatus: VerificationStatus
  kycCompletedAt: Date | null
  kycVerifiedBy: string | null
}

/**
 * Decides the initial state of a venue created through the superadmin onboarding wizard.
 *
 * When the operator ticks "Pre-aprobar KYC y activar", the venue is created directly in `ACTIVE`
 * in the SAME request. We can't reuse `POST /venues/:id/approve` for this: that route requires the
 * venue to already be in `PENDING_ACTIVATION`, but the wizard creates it in `ONBOARDING`, so the
 * approve call always threw "Cannot approve venue in ONBOARDING status".
 *
 * The pre-approval also marks KYC as `VERIFIED` (kycStatus/kycCompletedAt/kycVerifiedBy), mirroring
 * `approveKyc` — without it the venue came out ACTIVE but `NOT_SUBMITTED`, still showing as KYC
 * pending and forcing a second manual approval (bug: venue "Wu junlin", 2026-07-22).
 *
 * Default (no flag): the normal path — `ONBOARDING`, inactive, awaiting KYC.
 */
export function resolveInitialVenueState(activateImmediately: boolean | undefined, staffId: string): InitialVenueState {
  if (activateImmediately === true) {
    return {
      status: VenueStatus.ACTIVE,
      active: true,
      statusChangedBy: staffId,
      kycStatus: VerificationStatus.VERIFIED,
      kycCompletedAt: new Date(),
      kycVerifiedBy: staffId,
    }
  }
  return {
    status: VenueStatus.ONBOARDING,
    active: false,
    statusChangedBy: null,
    kycStatus: VerificationStatus.NOT_SUBMITTED,
    kycCompletedAt: null,
    kycVerifiedBy: null,
  }
}
