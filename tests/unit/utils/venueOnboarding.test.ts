/**
 * resolveInitialVenueState — decides the venue's initial status in the superadmin
 * onboarding wizard.
 *
 * Regression guard for the "Pre-aprobar KYC" bugs:
 * 1. The wizard used to always create the venue in ONBOARDING and then rely on a 2nd call to
 *    /venues/:id/approve, which REQUIRES PENDING_ACTIVATION and therefore always failed.
 *    Immediate activation now happens in-band: activateImmediately → ACTIVE in the same request.
 * 2. The in-band activation only set status/active but NOT kycStatus, so the venue landed
 *    ACTIVE + NOT_SUBMITTED — still showing as KYC pending and forcing a second manual
 *    KYC approval (venue "Wu junlin", 2026-07-22). Pre-approval now mirrors approveKyc:
 *    kycStatus=VERIFIED + kycCompletedAt + kycVerifiedBy.
 */

import { resolveInitialVenueState } from '@/utils/venueOnboarding'
import { VenueStatus, VerificationStatus } from '@prisma/client'

describe('resolveInitialVenueState', () => {
  it('activateImmediately=true → ACTIVE + active + statusChangedBy=staff', () => {
    expect(resolveInitialVenueState(true, 'staff_1')).toEqual({
      status: VenueStatus.ACTIVE,
      active: true,
      statusChangedBy: 'staff_1',
      kycStatus: VerificationStatus.VERIFIED,
      kycCompletedAt: expect.any(Date),
      kycVerifiedBy: 'staff_1',
    })
  })

  it('activateImmediately=true → KYC queda VERIFIED (no NOT_SUBMITTED) — regresión bug #2', () => {
    const state = resolveInitialVenueState(true, 'staff_1')
    expect(state.kycStatus).toBe(VerificationStatus.VERIFIED)
    expect(state.kycVerifiedBy).toBe('staff_1')
    expect(state.kycCompletedAt).toBeInstanceOf(Date)
  })

  it('activateImmediately=false/undefined → ONBOARDING + inactivo + KYC NOT_SUBMITTED', () => {
    const expected = {
      status: VenueStatus.ONBOARDING,
      active: false,
      statusChangedBy: null,
      kycStatus: VerificationStatus.NOT_SUBMITTED,
      kycCompletedAt: null,
      kycVerifiedBy: null,
    }
    expect(resolveInitialVenueState(false, 'staff_1')).toEqual(expected)
    expect(resolveInitialVenueState(undefined, 'staff_1')).toEqual(expected)
  })
})
