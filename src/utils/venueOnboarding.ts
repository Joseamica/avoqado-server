import { VenueStatus } from '@prisma/client'

export interface InitialVenueState {
  status: VenueStatus
  active: boolean
  /** Staff who set the status — only when we activate immediately (mirrors approveVenue). */
  statusChangedBy: string | null
}

/**
 * Decides the initial state of a venue created through the superadmin onboarding wizard.
 *
 * When the operator ticks "Pre-aprobar KYC y activar", the venue is created directly in `ACTIVE`
 * in the SAME request. We can't reuse `POST /venues/:id/approve` for this: that route requires the
 * venue to already be in `PENDING_ACTIVATION`, but the wizard creates it in `ONBOARDING`, so the
 * approve call always threw "Cannot approve venue in ONBOARDING status".
 *
 * Default (no flag): the normal path — `ONBOARDING`, inactive, awaiting KYC.
 */
export function resolveInitialVenueState(activateImmediately: boolean | undefined, staffId: string): InitialVenueState {
  if (activateImmediately === true) {
    return { status: VenueStatus.ACTIVE, active: true, statusChangedBy: staffId }
  }
  return { status: VenueStatus.ONBOARDING, active: false, statusChangedBy: null }
}
