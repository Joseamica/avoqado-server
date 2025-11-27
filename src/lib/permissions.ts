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

/**
 * Permission Dependencies System
 *
 * This defines implicit permissions that are automatically granted when a user has a base permission.
 * This prevents breaking API calls when endpoints need data from multiple resources.
 *
 * ⚠️ CRITICAL: This must match the frontend dependencies in:
 * `avoqado-web-dashboard/src/lib/permissions/permissionDependencies.ts`
 *
 * Example:
 * - User has "orders:read" permission
 * - API endpoint needs to return product names, payment info
 * - Instead of requiring 3 separate permissions, orders:read implicitly includes:
 *   - products:read (to show product names)
 *   - payments:read (to show payment summary)
 *
 * Approach inspired by GitHub, Linear, and Notion's permission systems.
 */
const PERMISSION_DEPENDENCIES: Record<string, string[]> = {
  // ===========================
  // ORDERS - Viewing and Managing
  // ===========================
  'orders:read': [
    'orders:read',
    'products:read', // Need to see what products are in the order
    'payments:read', // Need to see payment status/method (basic info)
  ],
  'orders:create': [
    'orders:read', // Inherit read capabilities
    'orders:create',
    'products:read', // Need to select products
    'menu:read', // Need to browse menu
    'inventory:read', // Need to check stock availability
  ],
  'orders:update': [
    'orders:read',
    'orders:update',
    'products:read',
    'inventory:read', // May need to update stock when modifying order
  ],
  'orders:cancel': [
    'orders:read',
    'orders:cancel',
    'payments:read', // Need to see if refund is needed
  ],

  // ===========================
  // MENU - Products and Categories
  // ===========================
  'menu:read': ['menu:read'],
  'menu:create': [
    'menu:read', // Need to see existing menu structure
    'menu:create',
  ],
  'menu:update': ['menu:read', 'menu:update'],
  'menu:delete': ['menu:read', 'menu:delete'],

  // ===========================
  // PAYMENTS
  // ===========================
  'payments:read': [
    'payments:read',
    'orders:read', // Payments are tied to orders
  ],
  'payments:create': [
    'payments:read',
    'payments:create',
    'orders:read', // Need to see order being paid
  ],
  'payments:refund': [
    'payments:read',
    'payments:refund',
    'orders:read', // Need to see original order
  ],

  // ===========================
  // SHIFTS
  // ===========================
  'shifts:read': [
    'shifts:read',
    'teams:read', // Need to see team members in shift
    'payments:read', // Need to see shift revenue
  ],
  'shifts:create': [
    'shifts:read',
    'shifts:create',
    'teams:read', // Need to assign team members
  ],
  'shifts:update': ['shifts:read', 'shifts:update', 'teams:read'],
  'shifts:close': [
    'shifts:read',
    'shifts:close',
    'payments:read', // Need to see all payments to close shift
    'orders:read', // Need to see all orders in shift
  ],

  // ===========================
  // INVENTORY
  // ===========================
  'inventory:read': [
    'inventory:read',
    'products:read', // Inventory items are linked to products
  ],
  'inventory:create': ['inventory:read', 'inventory:create', 'products:read'],
  'inventory:update': ['inventory:read', 'inventory:update', 'products:read'],
  'inventory:adjust': ['inventory:read', 'inventory:adjust', 'products:read'],
  'inventory:delete': ['inventory:read', 'inventory:delete', 'products:read'],

  // ===========================
  // TEAMS - Staff Management
  // ===========================
  'teams:read': ['teams:read'],
  'teams:create': ['teams:read', 'teams:create'],
  'teams:update': ['teams:read', 'teams:update'],
  'teams:delete': ['teams:read', 'teams:delete'],
  'teams:invite': ['teams:read', 'teams:invite'],

  // ===========================
  // TPV (Point of Sale)
  // ===========================
  'tpv:read': [
    'tpv:read',
    'orders:read', // TPV creates orders
    'products:read', // Need to see products to sell
    'payments:read', // Need to process payments
  ],
  'tpv:create': [
    'tpv:read',
    'tpv:create',
    'orders:create', // TPV creates orders
    'payments:create', // TPV processes payments
  ],
  'tpv:command': ['tpv:read', 'tpv:command', 'orders:read'],
  'tpv:delete': ['tpv:read', 'tpv:delete'],

  // ===========================
  // REVIEWS
  // ===========================
  'reviews:read': [
    'reviews:read',
    'orders:read', // Reviews are linked to orders
  ],
  'reviews:respond': ['reviews:read', 'reviews:respond'],

  // ===========================
  // ANALYTICS
  // ===========================
  'analytics:read': [
    'analytics:read',
    'orders:read', // Analytics show order data
    'payments:read', // Analytics show payment data
    'products:read', // Analytics show product performance
  ],
  'analytics:export': ['analytics:read', 'analytics:export', 'orders:read', 'payments:read'],

  // ===========================
  // SETTLEMENTS - Available Balance
  // ===========================
  'settlements:read': [
    'settlements:read',
    'payments:read', // Settlements show payment data
    'analytics:read', // Settlements use analytics for projections
  ],
  'settlements:simulate': ['settlements:read', 'settlements:simulate'],

  // ===========================
  // VENUES - Settings
  // ===========================
  'venues:read': ['venues:read'],
  'venues:update': ['venues:read', 'venues:update'],

  // ===========================
  // FEATURES - Venue Features
  // ===========================
  'features:read': ['features:read'],
  'features:write': ['features:read', 'features:write'],

  // ===========================
  // HOME - Dashboard
  // ===========================
  'home:read': [
    'home:read',
    'orders:read', // Dashboard shows order stats
    'payments:read', // Dashboard shows payment stats
    'analytics:read', // Dashboard uses analytics data
  ],

  // ===========================
  // TABLES - Restaurant Tables
  // ===========================
  'tables:read': [
    'tables:read',
    'orders:read', // Tables show active orders
  ],
  'tables:update': ['tables:read', 'tables:update'],

  // ===========================
  // RESERVATIONS
  // ===========================
  'reservations:read': [
    'reservations:read',
    'tables:read', // Reservations are for tables
  ],
  'reservations:create': ['reservations:read', 'reservations:create', 'tables:read'],
  'reservations:update': ['reservations:read', 'reservations:update'],
  'reservations:cancel': [
    'reservations:read',
    'reservations:cancel',
    'tables:read', // Need to see table when canceling
  ],

  // ===========================
  // SETTINGS
  // ===========================
  'settings:read': ['settings:read'],
  'settings:manage': ['settings:read', 'settings:manage'],
}

/**
 * Resolves a list of permissions to include all implicit dependencies.
 *
 * @param permissions - Array of explicit permissions the user has
 * @returns Set of all permissions including implicit dependencies
 *
 * @example
 * ```typescript
 * const userPermissions = ['orders:read', 'orders:create']
 * const resolved = resolvePermissions(userPermissions)
 * // resolved contains: orders:read, orders:create, products:read,
 * //                    payments:read, menu:read, inventory:read
 * ```
 */
function resolvePermissions(permissions: string[]): Set<string> {
  const resolved = new Set<string>()

  // Handle wildcard permission
  if (permissions.includes('*:*')) {
    resolved.add('*:*')
    return resolved
  }

  for (const permission of permissions) {
    // Add the base permission
    resolved.add(permission)

    // Add implicit dependencies
    const dependencies = PERMISSION_DEPENDENCIES[permission]
    if (dependencies) {
      dependencies.forEach(dep => {
        // Avoid infinite loops - don't resolve dependencies of dependencies
        resolved.add(dep)
      })
    }
  }

  return resolved
}
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
    'customers:read', // Phase 1: Customer System
    'loyalty:read', // Phase 1b: Loyalty System
    'features:read',
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
    'reservations:cancel',
    'customers:read', // Phase 1: Customer System
    'loyalty:read', // Phase 1b: Loyalty System
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
    'customers:read', // Phase 1: Customer System
    'loyalty:read', // Phase 1b: Loyalty System
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
    'customers:read', // Phase 1: Customer System
    'loyalty:read', // Phase 1b: Loyalty System
    'teams:read',
  ],

  /**
   * MANAGER: Operational management
   */
  [StaffRole.MANAGER]: [
    'home:read',
    'analytics:read',
    'analytics:export',
    'settlements:read',
    'settlements:simulate',
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
    'tpv:delete',
    'tpv:command',
    'inventory:read',
    'inventory:create',
    'inventory:update',
    'inventory:delete',
    'inventory:adjust',
    'reviews:read',
    'reviews:respond',
    'teams:read',
    'teams:create',
    'teams:update',
    'teams:delete',
    'teams:invite',
    'customers:*', // Phase 1: Customer System
    'customer-groups:*', // Phase 1: Customer System
    'loyalty:*', // Phase 1b: Loyalty System
    'features:read',
    'features:write',
  ],

  /**
   * ADMIN: Full venue management (excluding system-level permissions)
   */
  [StaffRole.ADMIN]: [
    'home:*',
    'analytics:*',
    'menu:*',
    'orders:*',
    'payments:*',
    'shifts:*',
    'reviews:*',
    'teams:*',
    'customers:*', // Phase 1: Customer System
    'customer-groups:*', // Phase 1: Customer System
    'loyalty:*', // Phase 1b: Loyalty System
    'features:*',
    'venues:*', // Can manage venue settings, billing, payment methods
    'tpv:*',
    'tables:*',
    'reservations:*',
    'inventory:*',
    'products:*',
    'settings:manage', // Can manage role permissions
  ],

  /**
   * OWNER: Full organization access (excluding system-level permissions)
   */
  [StaffRole.OWNER]: [
    'home:*',
    'analytics:*',
    'menu:*',
    'orders:*',
    'payments:*',
    'shifts:*',
    'reviews:*',
    'teams:*',
    'customers:*', // Phase 1: Customer System
    'customer-groups:*', // Phase 1: Customer System
    'loyalty:*', // Phase 1b: Loyalty System
    'features:*',
    'venues:*', // Can manage venue settings, billing, payment methods
    'tpv:*',
    'tables:*',
    'reservations:*',
    'inventory:*',
    'products:*',
    'settings:manage', // Can manage role permissions
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
 * 1. SUPERADMIN EXCEPTION: Always has all permissions (no custom restrictions)
 * 2. OVERRIDE MODE (wildcard roles with custom permissions):
 *    If role has "*:*" in defaults AND custom permissions exist,
 *    use ONLY custom permissions (allows removing permissions from OWNER/ADMIN)
 * 3. MERGE MODE (non-wildcard roles):
 *    Merge default + custom permissions (allows adding extra permissions to lower roles)
 * 4. DEPENDENCY RESOLUTION: Expand permissions to include implicit dependencies
 *
 * Example:
 * - User has "orders:read" permission
 * - System automatically grants: "products:read", "payments:read" (implicit)
 * - API calls for products and payments succeed without explicit grants
 *
 * @param role User's role
 * @param customPermissions Custom permissions from VenueRolePermission (optional)
 * @param requiredPermission Permission to check (format: "resource:action")
 * @returns true if user has permission
 */
export function hasPermission(role: StaffRole, customPermissions: string[] | null | undefined, requiredPermission: string): boolean {
  // SUPERADMIN EXCEPTION: Always use wildcard, never custom permissions
  // This prevents accidental lockout if SUPERADMIN permissions are customized
  if (role === StaffRole.SUPERADMIN) {
    return true // SUPERADMIN always has all permissions
  }

  // Get default permissions for role
  const defaultPermissions = DEFAULT_PERMISSIONS[role] || []

  // Determine which base permissions to use (before dependency resolution)
  let basePermissions: string[]

  // OVERRIDE MODE for wildcard roles (OWNER, ADMIN)
  // If role has wildcard (*:*) in defaults AND custom permissions exist,
  // use ONLY custom permissions (complete override, not merge)
  // This allows removing permissions from high-level roles
  const hasWildcardDefaults = defaultPermissions.includes('*:*')
  const hasCustomPermissions = customPermissions && customPermissions.length > 0

  if (hasWildcardDefaults && hasCustomPermissions) {
    // Override mode: custom permissions replace defaults entirely
    basePermissions = customPermissions
  } else {
    // MERGE MODE for non-wildcard roles
    // Merge default + custom permissions
    // Custom permissions can add new permissions on top of defaults
    basePermissions = [...defaultPermissions, ...(customPermissions || [])]
  }

  // RESOLVE IMPLICIT DEPENDENCIES
  // Expand base permissions to include their implicit dependencies
  // Example: 'orders:read' automatically includes 'products:read', 'payments:read'
  const resolvedSet = resolvePermissions(basePermissions)
  const allPermissions = Array.from(resolvedSet)

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

/**
 * Get all valid permissions in the system
 * Extracts unique permissions from DEFAULT_PERMISSIONS and PERMISSION_DEPENDENCIES
 *
 * @returns Array of all valid permission strings
 */
export function getAllValidPermissions(): string[] {
  const permissions = new Set<string>()

  // Add all permissions from DEFAULT_PERMISSIONS
  Object.values(DEFAULT_PERMISSIONS).forEach(perms => {
    perms.forEach(p => {
      if (p !== '*:*') permissions.add(p)
    })
  })

  // Add all permissions from PERMISSION_DEPENDENCIES keys
  Object.keys(PERMISSION_DEPENDENCIES).forEach(p => {
    permissions.add(p)
  })

  // Add all dependency permissions
  Object.values(PERMISSION_DEPENDENCIES).forEach(deps => {
    deps.forEach(p => {
      if (p !== '*:*') permissions.add(p)
    })
  })

  return Array.from(permissions).sort()
}

/**
 * Check if a permission string is valid (exists in the system)
 *
 * @param permission Permission string to validate
 * @returns true if permission is valid, false if unknown/typo
 */
export function isValidPermission(permission: string): boolean {
  // Wildcard is always valid
  if (permission === '*:*') return true

  // Check if it's a resource:* or *:action wildcard
  if (permission.includes('*')) {
    const [resource, action] = permission.split(':')
    if (resource === '*' || action === '*') {
      // Validate the non-wildcard part exists in some permission
      const allPerms = getAllValidPermissions()
      return allPerms.some(p => {
        const [r, a] = p.split(':')
        if (resource === '*') return a === action
        if (action === '*') return r === resource
        return false
      })
    }
  }

  // Check exact match
  const allPerms = getAllValidPermissions()
  return allPerms.includes(permission)
}

/**
 * Validate permission format
 * Returns error message if invalid, null if valid
 *
 * @param permission Permission string to validate
 * @returns Error message or null
 */
export function validatePermissionFormat(permission: string): string | null {
  // Allow wildcard
  if (permission === '*:*') return null

  // Check format: "resource:action"
  const parts = permission.split(':')
  if (parts.length !== 2) {
    return `Invalid format: "${permission}". Expected format: "resource:action"`
  }

  const [resource, action] = parts
  if (!resource || !action) {
    return `Invalid format: "${permission}". Both resource and action are required`
  }

  // Check if permission exists in system
  if (!isValidPermission(permission)) {
    return `Unknown permission: "${permission}". This may be a typo or deprecated permission`
  }

  return null
}
