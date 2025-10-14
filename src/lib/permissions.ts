import { StaffRole } from '@prisma/client'

/**
 * Default permissions matrix by role
 *
 * ⚠️ CRITICAL: This must match the frontend permissions in:
 * `avoqado-web-dashboard/src/lib/permissions/defaultPermissions.ts`
 *
 * Permission format: "resource:action"
 * Examples:
 *   - "tpv:read" = Can view TPV terminals
 *   - "tpv:create" = Can create TPV terminals
 *   - "analytics:export" = Can export analytics data
 *   - "*:*" = All permissions (wildcard)
 */
export const DEFAULT_PERMISSIONS: Record<StaffRole, string[]> = {
  /**
   * VIEWER: Read-only access to most features
   */
  [StaffRole.VIEWER]: [
    'home:read',
    'analytics:read',
    'menu:read',
    'orders:read',
    'payments:read',
    'shifts:read',
    'reviews:read',
    'teams:read',
  ],

  /**
   * HOST: Seating and reservations management
   */
  [StaffRole.HOST]: [
    'home:read',
    'menu:read',
    'orders:read',
    'tables:read',
    'tables:update',
    'reservations:read',
    'reservations:create',
    'reservations:update',
    'teams:read',
  ],

  /**
   * KITCHEN: Kitchen operations only
   */
  [StaffRole.KITCHEN]: ['home:read', 'orders:read', 'orders:update', 'menu:read'],

  /**
   * WAITER: Order and table management
   */
  [StaffRole.WAITER]: [
    'home:read',
    'menu:read',
    'menu:create',
    'menu:update',
    'orders:read',
    'orders:create',
    'orders:update',
    'payments:read',
    'payments:create',
    'shifts:read',
    'tables:read',
    'tables:update',
    'reviews:read',
    'teams:read',
    'tpv:read', // Can view TPV terminals (but not create/edit/command)
  ],

  /**
   * CASHIER: Payment processing
   */
  [StaffRole.CASHIER]: [
    'home:read',
    'menu:read',
    'orders:read',
    'orders:update',
    'payments:read',
    'payments:create',
    'payments:refund',
    'shifts:read',
    'reviews:read',
    'teams:read',
  ],

  /**
   * MANAGER: Operational management
   */
  [StaffRole.MANAGER]: [
    'home:read',
    'analytics:read',
    'analytics:export',
    'menu:read',
    'menu:create',
    'menu:update',
    'menu:delete',
    'orders:read',
    'orders:create',
    'orders:update',
    'orders:cancel',
    'payments:read',
    'payments:create',
    'payments:refund',
    'shifts:read',
    'shifts:create',
    'shifts:update',
    'shifts:delete',
    'shifts:close',
    'tpv:read',
    'tpv:create',
    'tpv:update',
    'tpv:command',
    'reviews:read',
    'reviews:respond',
    'teams:read',
    'teams:update',
  ],

  /**
   * ADMIN: Full venue management
   */
  [StaffRole.ADMIN]: [
    '*:*', // All permissions
  ],

  /**
   * OWNER: Full organization access
   */
  [StaffRole.OWNER]: [
    '*:*', // All permissions
  ],

  /**
   * SUPERADMIN: System-wide access
   */
  [StaffRole.SUPERADMIN]: [
    '*:*', // All permissions
  ],
}

/**
 * Check if a user has permission based on role and custom permissions
 *
 * @param role User's role
 * @param customPermissions Custom permissions from StaffVenue.permissions (optional)
 * @param requiredPermission Permission to check (format: "resource:action")
 * @returns true if user has permission
 */
export function hasPermission(role: StaffRole, customPermissions: string[] | null | undefined, requiredPermission: string): boolean {
  // Get default permissions for role
  const defaultPermissions = DEFAULT_PERMISSIONS[role] || []

  // Merge with custom permissions
  const allPermissions = [...defaultPermissions, ...(customPermissions || [])]

  // Check for wildcard (all permissions)
  if (allPermissions.includes('*:*')) return true

  // Check exact permission
  if (allPermissions.includes(requiredPermission)) return true

  // Check wildcard permissions (e.g., 'tpv:*' matches 'tpv:create')
  const [resource, action] = requiredPermission.split(':')
  if (allPermissions.includes(`${resource}:*`)) return true
  if (allPermissions.includes(`*:${action}`)) return true

  return false
}
