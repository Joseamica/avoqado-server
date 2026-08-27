import type { PermissionSet, StaffRole } from '@prisma/client'
import { getEffectiveRolePermissions, resolvePermissions } from './permissions'

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

/**
 * Los permisos EFECTIVOS de una persona en un local, ya resueltos.
 *
 * Es la regla completa en un solo lugar: si tiene un Conjunto de Permisos
 * asignado, mandan sus permisos; si no, los del rol con lo que el local le
 * agregó y le quitó. En los dos casos se expanden las dependencias implícitas.
 *
 * 🔴 Existe porque la MISMA regla estaba escrita tres veces —el middleware de
 * autorización, el endpoint de la terminal y el login móvil— y la del login
 * móvil se había quedado atrás: no miraba el Conjunto ni las exclusiones. El
 * síntoma no era un error sino una asimetría silenciosa: el negocio armaba un
 * permiso a la medida, la terminal lo obedecía y el iPad seguía igual. Cada
 * copia nueva de esta regla es otra oportunidad de que un cliente vuelva a
 * quedarse atrás, así que los llamadores nuevos usan esto y no lo reimplementan.
 */
export function resolveStaffVenuePermissions(
  staffVenue: { role: StaffRole; permissionSetId?: string | null; permissionSet?: PermissionSet | null },
  customRolePermission?: { permissions?: string[] | null; deniedPermissions?: string[] | null } | null,
): string[] {
  if (staffVenue.permissionSetId && staffVenue.permissionSet) {
    return Array.from(resolvePermissions(staffVenue.permissionSet.permissions))
  }

  return getEffectiveRolePermissions(
    staffVenue.role,
    customRolePermission?.permissions ?? null,
    customRolePermission?.deniedPermissions ?? null,
  )
}
