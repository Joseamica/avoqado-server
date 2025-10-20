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
 *   - "settings:manage" = Can manage role permissions (OWNER/ADMIN only)
 *   - "system:manage" = Can access superadmin features (SUPERADMIN only)
 *   - "system:config" = Can configure system settings (SUPERADMIN only)
 *   - "system:test" = Can access testing endpoints (SUPERADMIN only)
 *   - "*:*" = All permissions (wildcard)
 *
 * Special permissions (not in default arrays, covered by *:*):
 *   - "settings:manage" = Role permission management (OWNER/ADMIN)
 *   - "system:manage" = Superadmin features (venue mgmt, features, revenue, costs)
 *   - "system:config" = Payment provider configuration (SUPERADMIN)
 *   - "system:test" = Testing payment endpoints (SUPERADMIN)
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
   * - Can VIEW menu (read-only) to take orders
   * - Cannot create/edit menu items (MANAGER+ only)
   */
  [StaffRole.WAITER]: [
    'home:read',
    'menu:read', // Read-only access to menus, categories, products, modifiers
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
 * Role hierarchy levels (higher number = more permissions)
 * Used for determining which roles can modify other roles
 */
export const ROLE_HIERARCHY: Record<StaffRole, number> = {
  [StaffRole.VIEWER]: 1,
  [StaffRole.HOST]: 2,
  [StaffRole.KITCHEN]: 3,
  [StaffRole.WAITER]: 4,
  [StaffRole.CASHIER]: 5,
  [StaffRole.MANAGER]: 6,
  [StaffRole.ADMIN]: 7,
  [StaffRole.OWNER]: 8,
  [StaffRole.SUPERADMIN]: 9,
}

/**
 * Defines which roles can modify permissions for which other roles
 *
 * Rules:
 * - OWNER can modify: OWNER, ADMIN, MANAGER, CASHIER, WAITER, KITCHEN, HOST, VIEWER
 * - ADMIN can modify: ADMIN, MANAGER, CASHIER, WAITER, KITCHEN, HOST, VIEWER (NOT OWNER)
 * - Both can modify their own role permissions (with self-lockout protection)
 */
export const MODIFIABLE_ROLES_BY_LEVEL: Record<StaffRole, StaffRole[]> = {
  [StaffRole.SUPERADMIN]: [
    StaffRole.SUPERADMIN,
    StaffRole.OWNER,
    StaffRole.ADMIN,
    StaffRole.MANAGER,
    StaffRole.CASHIER,
    StaffRole.WAITER,
    StaffRole.KITCHEN,
    StaffRole.HOST,
    StaffRole.VIEWER,
  ],
  [StaffRole.OWNER]: [
    StaffRole.OWNER,
    StaffRole.ADMIN,
    StaffRole.MANAGER,
    StaffRole.CASHIER,
    StaffRole.WAITER,
    StaffRole.KITCHEN,
    StaffRole.HOST,
    StaffRole.VIEWER,
  ],
  [StaffRole.ADMIN]: [
    StaffRole.ADMIN,
    StaffRole.MANAGER,
    StaffRole.CASHIER,
    StaffRole.WAITER,
    StaffRole.KITCHEN,
    StaffRole.HOST,
    StaffRole.VIEWER,
  ],
  [StaffRole.MANAGER]: [],
  [StaffRole.CASHIER]: [],
  [StaffRole.WAITER]: [],
  [StaffRole.KITCHEN]: [],
  [StaffRole.HOST]: [],
  [StaffRole.VIEWER]: [],
}

/**
 * Critical permissions that should NOT be removed from a user's own role
 * Prevents self-lockout scenarios
 *
 * Example: ADMIN removing 'settings:manage' from ADMIN role would lock themselves out
 */
export const CRITICAL_PERMISSIONS = ['settings:manage', 'settings:read', 'teams:read', 'teams:update']

/**
 * Check if a user has permission based on role and custom permissions
 *
 * ⚠️ CRITICAL: This logic must match the frontend in:
 * `avoqado-web-dashboard/src/hooks/usePermissions.ts`
 *
 * Permission Resolution Strategy:
 * - OVERRIDE MODE (wildcard roles with custom permissions):
 *   If role has "*:*" in defaults AND custom permissions exist,
 *   use ONLY custom permissions (allows removing permissions from OWNER/ADMIN/SUPERADMIN)
 *
 * - MERGE MODE (non-wildcard roles):
 *   Merge default + custom permissions (allows adding extra permissions to lower roles)
 *
 * @param role User's role
 * @param customPermissions Custom permissions from VenueRolePermission (optional)
 * @param requiredPermission Permission to check (format: "resource:action")
 * @returns true if user has permission
 */
export function hasPermission(role: StaffRole, customPermissions: string[] | null | undefined, requiredPermission: string): boolean {
  // Get default permissions for role
  const defaultPermissions = DEFAULT_PERMISSIONS[role] || []

  // Determine which permissions to use
  let allPermissions: string[]

  // OVERRIDE MODE for wildcard roles (OWNER, ADMIN, SUPERADMIN)
  // If role has wildcard (*:*) in defaults AND custom permissions exist,
  // use ONLY custom permissions (complete override, not merge)
  // This allows removing permissions from high-level roles
  const hasWildcardDefaults = defaultPermissions.includes('*:*')
  const hasCustomPermissions = customPermissions && customPermissions.length > 0

  if (hasWildcardDefaults && hasCustomPermissions) {
    // Override mode: custom permissions replace defaults entirely
    allPermissions = customPermissions
  } else {
    // MERGE MODE for non-wildcard roles
    // Merge default + custom permissions
    // Custom permissions can add new permissions on top of defaults
    allPermissions = [...defaultPermissions, ...(customPermissions || [])]
  }

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

/**
 * Check if a role can modify permissions for another role
 *
 * @param modifierRole The role attempting to modify permissions
 * @param targetRole The role being modified
 * @returns true if modifierRole can modify targetRole
 */
export function canModifyRole(modifierRole: StaffRole, targetRole: StaffRole): boolean {
  const modifiableRoles = MODIFIABLE_ROLES_BY_LEVEL[modifierRole] || []
  return modifiableRoles.includes(targetRole)
}

/**
 * Check if a permission is critical (should not be removed from own role)
 *
 * @param permission Permission string (e.g., "settings:manage")
 * @returns true if permission is critical
 */
export function isCriticalPermission(permission: string): boolean {
  return CRITICAL_PERMISSIONS.includes(permission)
}

/**
 * Get the numeric hierarchy level of a role
 *
 * @param role StaffRole
 * @returns Numeric level (1-9, higher = more permissions)
 */
export function getRoleHierarchyLevel(role: StaffRole): number {
  return ROLE_HIERARCHY[role] || 0
}
