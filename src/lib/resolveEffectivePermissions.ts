import type { PermissionSet } from '@prisma/client'

/**
 * Resolves effective permissions for a staff member.
 * If a permission set is assigned, its permissions are used directly.
 * Otherwise, falls back to role-based permissions.
 */
export function getEffectivePermissions(
  staffVenue: { permissionSetId?: string | null; permissionSet?: PermissionSet | null },
  rolePermissions: string[],
): string[] {
  if (staffVenue.permissionSetId && staffVenue.permissionSet) {
    return staffVenue.permissionSet.permissions
  }
  return rolePermissions
}
