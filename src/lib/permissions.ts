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
  'tpv-settings:read': ['tpv:read', 'tpv-settings:read'],
  'tpv-settings:update': ['tpv:read', 'tpv-settings:read', 'tpv-settings:update'],

  // ===========================
  // TPV Remote Commands (Enterprise Feature)
  // ===========================
  // Granular command permissions for remote terminal management
  'tpv:command:lock': ['tpv:read', 'tpv:command', 'tpv:command:lock'], // Lock/unlock terminal (MANAGER+)
  'tpv:command:maintenance': ['tpv:read', 'tpv:command', 'tpv:command:maintenance'], // Maintenance mode (MANAGER+)
  'tpv:command:restart': ['tpv:read', 'tpv:command', 'tpv:command:restart'], // Restart app (MANAGER+)
  'tpv:command:shutdown': ['tpv:read', 'tpv:command', 'tpv:command:shutdown'], // Shutdown terminal (ADMIN+)
  'tpv:command:config': ['tpv:read', 'tpv:command', 'tpv:command:config'], // Update config (MANAGER+)
  'tpv:command:wipe': ['tpv:read', 'tpv:command', 'tpv:command:wipe'], // Factory reset (OWNER+ - Critical!)
  'tpv:command:bulk': ['tpv:read', 'tpv:command', 'tpv:command:bulk'], // Bulk operations (ADMIN+)
  'tpv:command:schedule': ['tpv:read', 'tpv:command', 'tpv:command:schedule'], // Scheduled commands (ADMIN+)
  'tpv:command:geofence': ['tpv:read', 'tpv:command', 'tpv:command:geofence'], // Geofencing (ADMIN+)

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

  // ===========================
  // NOTIFICATIONS
  // ===========================
  'notifications:send': ['notifications:send', 'teams:read'],

  // ===========================
  // DISCOUNTS (Phase 2)
  // ===========================
  'discounts:read': [
    'discounts:read',
    'products:read', // Need to see products for item-level discounts
    'customers:read', // Need to see customers for customer discounts
  ],
  'discounts:create': ['discounts:read', 'discounts:create', 'products:read', 'customers:read'],
  'discounts:update': ['discounts:read', 'discounts:update'],
  'discounts:delete': ['discounts:read', 'discounts:delete'],
  'discounts:apply': [
    'discounts:read', // TPV can read discounts to apply them
    'discounts:apply', // TPV can apply discounts to orders
    'orders:read',
    'orders:update',
  ],

  // ===========================
  // COMMISSIONS (Staff bonus system)
  // ===========================
  'commissions:read': [
    'commissions:read',
    'teams:read', // Need to see staff for commission configs
    'payments:read', // Commissions are based on payments
    'orders:read', // Commissions may be based on orders
  ],
  'commissions:create': ['commissions:read', 'commissions:create'],
  'commissions:update': ['commissions:read', 'commissions:update'],
  'commissions:delete': ['commissions:read', 'commissions:delete'],
  'commissions:view_own': ['commissions:view_own'], // Staff can view their own commissions
  'commissions:approve': ['commissions:read', 'commissions:approve', 'teams:read'],
  'commissions:payout': ['commissions:read', 'commissions:approve', 'commissions:payout'],

  // ===========================
  // COUPONS (Phase 2)
  // ===========================
  'coupons:read': ['coupons:read', 'discounts:read'],
  'coupons:create': ['coupons:read', 'coupons:create', 'discounts:read'],
  'coupons:update': ['coupons:read', 'coupons:update'],
  'coupons:delete': ['coupons:read', 'coupons:delete'],
  'coupons:redeem': ['coupons:read', 'coupons:redeem', 'orders:read', 'orders:update'],

  // ===========================
  // ROLE CONFIG (Custom Role Display Names)
  // ===========================
  'role-config:read': ['role-config:read'],
  'role-config:update': ['role-config:read', 'role-config:update'],

  // ===========================
  // TPV-SPECIFIC PERMISSIONS (Granular TPV Features)
  // ===========================
  // Terminal Configuration
  'tpv-terminal:settings': ['tpv-terminal:settings', 'tpv:read'],

  // Kiosk Mode (Self-service terminal)
  'tpv-kiosk:enable': ['tpv-kiosk:enable', 'tpv:read', 'tpv-terminal:settings'],

  // Orders - TPV-specific actions
  'tpv-orders:comp': ['tpv-orders:comp', 'orders:read', 'orders:update'],
  'tpv-orders:void': ['tpv-orders:void', 'orders:read', 'orders:update'],
  'tpv-orders:discount': ['tpv-orders:discount', 'orders:read', 'orders:update', 'discounts:read'],

  // Time Entries
  'tpv-time-entries:read': ['tpv-time-entries:read', 'teams:read'],
  'tpv-time-entries:write': ['tpv-time-entries:write', 'tpv-time-entries:read', 'teams:read'],

  // Tables & Floor Management
  'tpv-tables:assign': ['tpv-tables:assign', 'tables:read', 'tables:update', 'orders:read'],
  'tpv-tables:write': ['tpv-tables:write', 'tables:read', 'tables:update'],
  'tpv-tables:delete': ['tpv-tables:delete', 'tables:read'],

  'tpv-floor-elements:read': ['tpv-floor-elements:read'],
  'tpv-floor-elements:write': ['tpv-floor-elements:write', 'tpv-floor-elements:read'],
  'tpv-floor-elements:delete': ['tpv-floor-elements:delete', 'tpv-floor-elements:read'],

  // Payments - TPV-specific
  'tpv-payments:send-receipt': ['tpv-payments:send-receipt', 'payments:read'],
  'tpv-payments:pay-later': ['tpv-payments:pay-later', 'orders:read', 'orders:create', 'customers:read', 'payments:create'],

  // Reports
  'tpv-reports:read': ['tpv-reports:read', 'payments:read', 'orders:read', 'analytics:read'],
  'tpv-reports:export': ['tpv-reports:export', 'tpv-reports:read'],
  'tpv-reports:pay-later-aging': ['tpv-reports:pay-later-aging', 'tpv-reports:read', 'customers:read', 'orders:read'],

  // Products (Barcode / Scan & Go)
  'tpv-products:read': ['tpv-products:read', 'products:read'],
  'tpv-products:write': ['tpv-products:write', 'tpv-products:read', 'products:read'],

  // Factory Reset (CRITICAL - Destructive)
  'tpv-factory-reset:execute': ['tpv-factory-reset:execute', 'tpv:read'],
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
export function resolvePermissions(permissions: string[]): Set<string> {
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
    'discounts:read', // Phase 2: Discount System
    'coupons:read', // Phase 2: Coupon System
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
    'discounts:read', // Phase 2: Can view discounts
    'discounts:apply', // Phase 2: Can apply discounts to orders
    'coupons:read', // Phase 2: Can view coupons
    'coupons:redeem', // Phase 2: Can redeem coupons at checkout
    'commissions:view_own', // Can view own commission earnings
    'teams:read',
    'tpv:read', // Can view TPV terminals (but not create/edit/command)
    // TPV-specific permissions
    'tpv-tables:assign', // Can assign tables to orders
    'tpv-time-entries:write', // Can clock in/out, take breaks
    'tpv-payments:pay-later', // Can create pay-later orders
    // Serialized Inventory (SIMs, jewelry, etc.)
    'serialized-inventory:sell', // Can sell serialized items
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
    'discounts:read', // Phase 2: Can view discounts
    'discounts:apply', // Phase 2: Can apply discounts to orders
    'coupons:read', // Phase 2: Can view coupons
    'coupons:redeem', // Phase 2: Can redeem coupons at checkout
    'commissions:view_own', // Can view own commission earnings
    'teams:read',
    // TPV-specific permissions
    'tpv-tables:assign', // Can assign tables
    'tpv-time-entries:write', // Can clock in/out
    'tpv-products:read', // Can search products by barcode
    'tpv-payments:pay-later', // Can create pay-later orders
    // Serialized Inventory (SIMs, jewelry, etc.)
    'serialized-inventory:sell', // Can sell serialized items
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
    'tpv:command:lock', // Lock/unlock terminals
    'tpv:command:maintenance', // Enter/exit maintenance mode
    'tpv:command:restart', // Restart terminal app
    'tpv:command:config', // Update terminal config
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
    'discounts:*', // Phase 2: Full discount management
    'coupons:*', // Phase 2: Full coupon management
    'commissions:read', // Can view commission configs and staff earnings
    'commissions:view_own', // Can view own commission earnings
    'features:read',
    'features:write',
    'role-config:read', // Can view custom role display names
    // TPV-specific permissions
    'tpv-orders:comp', // Can comp items
    'tpv-orders:void', // Can void items
    'tpv-orders:discount', // Can apply custom discounts
    'tpv-tables:assign',
    'tpv-tables:write', // Can create/modify tables
    'tpv-floor-elements:read',
    'tpv-floor-elements:write',
    'tpv-time-entries:read', // Can view time entries
    'tpv-time-entries:write',
    'tpv-payments:send-receipt',
    'tpv-payments:pay-later', // Can create pay-later orders
    'tpv-products:read',
    'tpv-products:write', // Can create products on-the-fly (Scan & Go)
    'tpv-reports:pay-later-aging', // Can view pay-later aging report
    'notifications:send', // Can send push notifications to staff
    // Serialized Inventory (SIMs, jewelry, etc.)
    'serialized-inventory:sell', // Can sell serialized items
    'serialized-inventory:create', // Can register (Alta de Productos)
    // NO: tpv-terminal:settings (ADMIN+ only)
    // NO: tpv-reports (ADMIN+ only - except pay-later-aging)
    // NO: tpv-factory-reset (OWNER only)
    // NO: commissions:create/update/delete/approve/payout (ADMIN+ only)
  ],

  /**
   * ADMIN: Full venue management (excluding system-level permissions)
   */
  [StaffRole.ADMIN]: [
    'home:*',
    'analytics:*',
    'settlements:*', // Available Balance (settlements) - was missing!
    'menu:*',
    'orders:*',
    'payments:*',
    'shifts:*',
    'reviews:*',
    'teams:*',
    'customers:*', // Phase 1: Customer System
    'customer-groups:*', // Phase 1: Customer System
    'loyalty:*', // Phase 1b: Loyalty System
    'discounts:*', // Phase 2: Full discount management
    'coupons:*', // Phase 2: Full coupon management
    'serialized-inventory:*', // Serialized Inventory (SIMs, jewelry, etc.)
    // Commission System (can manage but NOT payout - OWNER only)
    'commissions:read',
    'commissions:create',
    'commissions:update',
    'commissions:delete',
    'commissions:view_own',
    'commissions:approve',
    'features:*',
    'notifications:*', // Can send push notifications
    'venues:*', // Can manage venue settings, billing, payment methods
    'tpv:*',
    'tables:*',
    'reservations:*',
    'inventory:*',
    'products:*',
    'settings:manage', // Can manage role permissions
    'role-config:*', // Can customize role display names
    // TPV-specific permissions (all except factory-reset)
    'tpv-terminal:settings', // Can modify terminal configuration
    'tpv-kiosk:enable', // Can enable/disable kiosk mode
    'tpv-orders:comp',
    'tpv-orders:void',
    'tpv-orders:discount',
    'tpv-tables:assign',
    'tpv-tables:write',
    'tpv-tables:delete',
    'tpv-floor-elements:read',
    'tpv-floor-elements:write',
    'tpv-floor-elements:delete',
    'tpv-time-entries:read',
    'tpv-time-entries:write',
    'tpv-payments:send-receipt',
    'tpv-reports:read', // Can view reports
    'tpv-reports:export', // Can export data
    'tpv-reports:pay-later-aging', // Can view pay-later aging report
    'tpv-products:read',
    'tpv-products:write',
    // NO: tpv-factory-reset:execute (OWNER only - destructive)
    // NO: commissions:payout (OWNER only - financial)
  ],

  /**
   * OWNER: Full organization access (excluding system-level permissions)
   */
  [StaffRole.OWNER]: [
    'home:*',
    'analytics:*',
    'settlements:*', // Available Balance (settlements) - was missing!
    'commissions:*', // Commission system (full control including payout)
    'menu:*',
    'orders:*',
    'payments:*',
    'shifts:*',
    'reviews:*',
    'teams:*',
    'customers:*', // Phase 1: Customer System
    'customer-groups:*', // Phase 1: Customer System
    'loyalty:*', // Phase 1b: Loyalty System
    'discounts:*', // Phase 2: Full discount management
    'coupons:*', // Phase 2: Full coupon management
    'features:*',
    'notifications:*', // Can send push notifications
    'venues:*', // Can manage venue settings, billing, payment methods
    'tpv:*',
    'tables:*',
    'reservations:*',
    'inventory:*',
    'products:*',
    'settings:manage', // Can manage role permissions
    'role-config:*', // Can customize role display names
    // TPV-specific permissions (ALL including factory-reset)
    'tpv-terminal:settings',
    'tpv-kiosk:enable', // Can enable/disable kiosk mode
    'tpv-orders:comp',
    'tpv-orders:void',
    'tpv-orders:discount',
    'tpv-tables:assign',
    'tpv-tables:write',
    'tpv-tables:delete',
    'tpv-floor-elements:read',
    'tpv-floor-elements:write',
    'tpv-floor-elements:delete',
    'tpv-time-entries:read',
    'tpv-time-entries:write',
    'tpv-payments:send-receipt',
    'tpv-reports:read',
    'tpv-reports:export',
    'tpv-reports:pay-later-aging', // Can view pay-later aging report
    'tpv-products:read',
    'tpv-products:write',
    'tpv-factory-reset:execute', // ⚠️ CRITICAL: Can factory reset terminal (destructive)
    // Serialized Inventory (SIMs, jewelry, etc.)
    'serialized-inventory:sell', // Can sell serialized items
    'serialized-inventory:create', // Can register (Alta de Productos)
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

  // Check format: "resource:action" or "resource:action:subaction" (for granular TPV commands)
  const parts = permission.split(':')
  if (parts.length < 2 || parts.length > 3) {
    return `Invalid format: "${permission}". Expected format: "resource:action" or "resource:action:subaction"`
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

/**
 * All individual permissions by resource
 * Used to expand resource wildcards like "home:*" to ["home:read"]
 *
 * ⚠️ CRITICAL: This must match the frontend PERMISSION_CATEGORIES in:
 * `avoqado-web-dashboard/src/lib/permissions/roleHierarchy.ts`
 */
const INDIVIDUAL_PERMISSIONS_BY_RESOURCE: Record<string, string[]> = {
  home: ['home:read'],
  analytics: ['analytics:read', 'analytics:export'],
  settlements: ['settlements:read', 'settlements:simulate'],
  menu: ['menu:read', 'menu:create', 'menu:update', 'menu:delete'],
  orders: ['orders:read', 'orders:create', 'orders:update', 'orders:cancel'],
  payments: ['payments:read', 'payments:create', 'payments:refund'],
  shifts: ['shifts:read', 'shifts:create', 'shifts:update', 'shifts:delete', 'shifts:close'],
  tpv: [
    'tpv:read',
    'tpv:create',
    'tpv:update',
    'tpv:delete',
    'tpv:command',
    'tpv:command:lock',
    'tpv:command:maintenance',
    'tpv:command:restart',
    'tpv:command:shutdown',
    'tpv:command:config',
    'tpv:command:wipe',
    'tpv:command:bulk',
    'tpv:command:schedule',
    'tpv:command:geofence',
  ],
  inventory: ['inventory:read', 'inventory:create', 'inventory:update', 'inventory:delete', 'inventory:adjust'],
  reviews: ['reviews:read', 'reviews:respond'],
  teams: ['teams:read', 'teams:create', 'teams:update', 'teams:delete', 'teams:invite'],
  tables: ['tables:read', 'tables:update'],
  reservations: ['reservations:read', 'reservations:create', 'reservations:update', 'reservations:cancel'],
  settings: ['settings:read', 'settings:manage'],
  venues: ['venues:read', 'venues:update'],
  customers: ['customers:read', 'customers:create', 'customers:update', 'customers:delete', 'customers:settle-balance'],
  'customer-groups': ['customer-groups:read', 'customer-groups:create', 'customer-groups:update', 'customer-groups:delete'],
  loyalty: ['loyalty:read', 'loyalty:create', 'loyalty:update', 'loyalty:delete', 'loyalty:redeem', 'loyalty:adjust'],
  discounts: ['discounts:read', 'discounts:create', 'discounts:update', 'discounts:delete'],
  coupons: ['coupons:read', 'coupons:create', 'coupons:update', 'coupons:delete'],
  features: ['features:read', 'features:update'],
  notifications: ['notifications:send'],
  products: ['products:read', 'products:create', 'products:update', 'products:delete'],
  'role-config': ['role-config:read', 'role-config:update'], // Custom role display names
  // TPV-specific permissions (granular features)
  'tpv-terminal': ['tpv-terminal:settings'],
  'tpv-kiosk': ['tpv-kiosk:enable'], // Kiosk/self-service mode
  'tpv-orders': ['tpv-orders:comp', 'tpv-orders:void', 'tpv-orders:discount'],
  'tpv-payments': ['tpv-payments:send-receipt', 'tpv-payments:pay-later'],
  'tpv-shifts': ['tpv-shifts:create', 'tpv-shifts:close'],
  'tpv-tables': ['tpv-tables:assign', 'tpv-tables:write', 'tpv-tables:delete'],
  'tpv-floor-elements': ['tpv-floor-elements:read', 'tpv-floor-elements:write', 'tpv-floor-elements:delete'],
  'tpv-customers': ['tpv-customers:read', 'tpv-customers:create'],
  'tpv-time-entries': ['tpv-time-entries:read', 'tpv-time-entries:write'],
  'tpv-reports': ['tpv-reports:read', 'tpv-reports:export', 'tpv-reports:pay-later-aging'],
  'tpv-products': ['tpv-products:read', 'tpv-products:write'],
  'tpv-factory-reset': ['tpv-factory-reset:execute'],
  // Serialized Inventory (SIMs, jewelry, etc.)
  'serialized-inventory': ['serialized-inventory:sell', 'serialized-inventory:create'],
  // Commission System (staff bonuses based on sales)
  commissions: [
    'commissions:read',
    'commissions:create',
    'commissions:update',
    'commissions:delete',
    'commissions:view_own',
    'commissions:approve',
    'commissions:payout',
  ],
}

/**
 * Get all individual permissions (expanded from all resources)
 */
export function getAllIndividualPermissions(): string[] {
  return Object.values(INDIVIDUAL_PERMISSIONS_BY_RESOURCE).flat()
}

/**
 * Expand wildcards to individual permissions
 * - "*:*" expands to ALL individual permissions
 * - "resource:*" expands to all actions for that resource
 * - Individual permissions pass through unchanged
 *
 * @param permissions Array of permissions (may contain wildcards)
 * @returns Array of individual permissions (no wildcards)
 */
export function expandWildcards(permissions: string[]): string[] {
  const expanded = new Set<string>()

  for (const permission of permissions) {
    if (permission === '*:*') {
      // Global wildcard: add ALL permissions
      getAllIndividualPermissions().forEach(p => expanded.add(p))
    } else if (permission.endsWith(':*')) {
      // Resource wildcard: expand to all actions for that resource
      const resource = permission.replace(':*', '')
      const resourcePermissions = INDIVIDUAL_PERMISSIONS_BY_RESOURCE[resource]
      if (resourcePermissions) {
        resourcePermissions.forEach(p => expanded.add(p))
      } else {
        // Unknown resource, keep the wildcard as-is (backend will handle)
        expanded.add(permission)
      }
    } else {
      // Individual permission: add as-is
      expanded.add(permission)
    }
  }

  return Array.from(expanded).sort()
}
