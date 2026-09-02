import { StaffRole } from '@prisma/client'

import {
  assertLockedCommercialQuoteV3ActorAuthority,
  type LockedCommercialQuoteV3ActorAuthority,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Authority.service'

const permission = 'billing:subscriptions:manage' as const

function authority(overrides: Partial<LockedCommercialQuoteV3ActorAuthority> = {}): LockedCommercialQuoteV3ActorAuthority {
  return {
    organizationId: 'organization-direct-v3',
    venueOrganizationId: 'organization-direct-v3',
    staffActive: true,
    membershipActive: true,
    role: StaffRole.OWNER,
    permissionSet: null,
    roleOverride: null,
    ...overrides,
  }
}

describe('locked Commercial Quote v3 actor authority', () => {
  it('allows the role-only path when no PermissionSet or role override exists', () => {
    expect(() => assertLockedCommercialQuoteV3ActorAuthority(authority(), permission)).not.toThrow()
  })

  it('treats a present PermissionSet as the only authority and never unions the role grant', () => {
    expect(() =>
      assertLockedCommercialQuoteV3ActorAuthority(authority({ permissionSet: { permissions: ['orders:read'] } }), permission),
    ).toThrow(expect.objectContaining({ statusCode: 403, code: 'COMMERCIAL_QUOTE_V3_PERMISSION_REQUIRED' }))

    expect(() =>
      assertLockedCommercialQuoteV3ActorAuthority(
        authority({
          role: StaffRole.VIEWER,
          permissionSet: { permissions: [permission] },
          roleOverride: { permissions: [], deniedPermissions: [permission] },
        }),
        permission,
      ),
    ).not.toThrow()
  })

  it('applies role additions and denials only when no PermissionSet exists', () => {
    expect(() =>
      assertLockedCommercialQuoteV3ActorAuthority(
        authority({
          role: StaffRole.VIEWER,
          roleOverride: { permissions: [permission], deniedPermissions: [] },
        }),
        permission,
      ),
    ).not.toThrow()

    expect(() =>
      assertLockedCommercialQuoteV3ActorAuthority(
        authority({
          role: StaffRole.VIEWER,
          roleOverride: { permissions: [], deniedPermissions: [permission] },
        }),
        permission,
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403, code: 'COMMERCIAL_QUOTE_V3_PERMISSION_REQUIRED' }))
  })

  it.each([
    ['cross-tenant venue', { venueOrganizationId: 'organization-other' }, 'COMMERCIAL_QUOTE_V3_TENANT_MISMATCH'],
    ['inactive Staff', { staffActive: false }, 'COMMERCIAL_QUOTE_V3_ACTOR_INACTIVE'],
    ['inactive StaffVenue', { membershipActive: false }, 'COMMERCIAL_QUOTE_V3_MEMBERSHIP_INACTIVE'],
  ])('rejects %s before permission evaluation', (_label, overrides, code) => {
    expect(() => assertLockedCommercialQuoteV3ActorAuthority(authority(overrides), permission)).toThrow(
      expect.objectContaining({ statusCode: 403, code }),
    )
  })
})
