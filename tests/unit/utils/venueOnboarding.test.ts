/**
 * resolveInitialVenueState — decides the venue's initial status in the superadmin
 * onboarding wizard.
 *
 * Regression guard for the "Pre-aprobar KYC" bug: the wizard used to always create
 * the venue in ONBOARDING and then rely on a 2nd call to /venues/:id/approve, which
 * REQUIRES PENDING_ACTIVATION and therefore always failed. Immediate activation now
 * happens in-band: activateImmediately → ACTIVE in the same request.
 */

import { resolveInitialVenueState } from '@/utils/venueOnboarding'
import { VenueStatus } from '@prisma/client'

describe('resolveInitialVenueState', () => {
  it('activateImmediately=true → ACTIVE + active + statusChangedBy=staff', () => {
    expect(resolveInitialVenueState(true, 'staff_1')).toEqual({
      status: VenueStatus.ACTIVE,
      active: true,
      statusChangedBy: 'staff_1',
    })
  })

  it('activateImmediately=false/undefined → ONBOARDING + inactivo + sin statusChangedBy', () => {
    const expected = { status: VenueStatus.ONBOARDING, active: false, statusChangedBy: null }
    expect(resolveInitialVenueState(false, 'staff_1')).toEqual(expected)
    expect(resolveInitialVenueState(undefined, 'staff_1')).toEqual(expected)
  })
})
