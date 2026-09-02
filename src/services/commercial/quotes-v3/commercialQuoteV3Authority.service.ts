import { StaffRole } from '@prisma/client'

import AppError from '@/errors/AppError'
import { evaluatePermissionList, hasPermission } from '@/lib/permissions'

export interface LockedCommercialQuoteV3ActorAuthority {
  organizationId: string
  venueOrganizationId: string
  staffActive: boolean
  membershipActive: boolean
  role: StaffRole
  permissionSet: { permissions: readonly string[] } | null
  roleOverride: {
    permissions: readonly string[] | null
    deniedPermissions: readonly string[] | null
  } | null
}

function authorityError(code: string): never {
  throw new AppError('No tienes autoridad para crear esta cotización.', 403, true, code)
}

/**
 * Evaluates only rows already locked by the caller. A PermissionSet is a
 * replacement authority: when one is assigned, role defaults and role
 * overrides must never leak back into the decision.
 */
export function assertLockedCommercialQuoteV3ActorAuthority(
  authority: LockedCommercialQuoteV3ActorAuthority,
  requiredPermission: 'billing:subscriptions:manage',
): void {
  if (authority.organizationId !== authority.venueOrganizationId) {
    authorityError('COMMERCIAL_QUOTE_V3_TENANT_MISMATCH')
  }
  if (!authority.staffActive) {
    authorityError('COMMERCIAL_QUOTE_V3_ACTOR_INACTIVE')
  }
  if (!authority.membershipActive) {
    authorityError('COMMERCIAL_QUOTE_V3_MEMBERSHIP_INACTIVE')
  }

  const allowed = authority.permissionSet
    ? evaluatePermissionList([...authority.permissionSet.permissions], requiredPermission)
    : hasPermission(
        authority.role,
        authority.roleOverride?.permissions ? [...authority.roleOverride.permissions] : null,
        requiredPermission,
        authority.roleOverride?.deniedPermissions ? [...authority.roleOverride.deniedPermissions] : null,
      )
  if (!allowed) authorityError('COMMERCIAL_QUOTE_V3_PERMISSION_REQUIRED')
}
