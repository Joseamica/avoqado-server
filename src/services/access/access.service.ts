/**
 * Access Service
 *
 * Unified service for checking user permissions and feature access.
 * This is the SINGLE SOURCE OF TRUTH for permission resolution.
 *
 * Key responsibilities:
 * 1. Resolve core permissions (VenueRolePermission + defaults)
 * 2. Check white-label feature access
 * 3. Provide request-level caching to avoid duplicate queries
 *
 * @see docs/PERMISSIONS_SYSTEM.md for architecture details
 */
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { DEFAULT_PERMISSIONS, resolvePermissions } from '@/lib/permissions'
import logger from '@/config/logger'

/**
 * Feature access configuration from white-label module config
 */
export interface FeatureAccess {
  allowedRoles: StaffRole[]
  dataScope: 'venue' | 'user-venues' | 'organization'
}

/**
 * Individual feature access result
 */
export interface FeatureAccessResult {
  allowed: boolean
  reason?: 'FEATURE_NOT_ENABLED' | 'ROLE_NOT_ALLOWED' | 'MODULE_DISABLED'
  dataScope: 'venue' | 'user-venues' | 'organization'
}

/**
 * Complete user access information for a specific venue
 */
export interface UserAccess {
  userId: string
  venueId: string
  organizationId: string
  role: StaffRole
  /** Resolved core permissions (merged defaults + custom from VenueRolePermission) */
  corePermissions: string[]
  /** Whether WHITE_LABEL_DASHBOARD module is enabled for this venue */
  whiteLabelEnabled: boolean
  /** List of enabled feature codes (if white-label is enabled) */
  enabledFeatures: string[]
  /** Access status for each enabled feature */
  featureAccess: Record<string, FeatureAccessResult>
}

/**
 * Default feature access when not specified in white-label config
 * This is the SINGLE place for these defaults - do not duplicate elsewhere
 */
const DEFAULT_FEATURE_ACCESS: FeatureAccess = {
  allowedRoles: [StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER],
  dataScope: 'user-venues',
}

/**
 * Map core Avoqado permissions to white-label feature codes
 *
 * CENTRALIZED MAPPING: This is the SINGLE SOURCE OF TRUTH for permission-to-feature mapping.
 * When white-label is enabled, permissions are filtered based on feature access.
 *
 * Example: User has 'tpv:read' permission, but if AVOQADO_TPVS feature is disabled
 * or user's role doesn't have access to it, the permission is removed.
 */
const PERMISSION_TO_FEATURE_MAP: Record<string, string> = {
  // TPV Management
  'tpv:read': 'AVOQADO_TPVS',
  'tpv:write': 'AVOQADO_TPVS',
  'tpv:create': 'AVOQADO_TPVS',
  'tpv:delete': 'AVOQADO_TPVS',

  // Team Management
  'teams:read': 'AVOQADO_TEAM',
  'teams:write': 'AVOQADO_TEAM',
  'teams:invite': 'AVOQADO_TEAM',
  'teams:delete': 'AVOQADO_TEAM',

  // Menu Management
  'menu:read': 'AVOQADO_MENU',
  'menu:write': 'AVOQADO_MENU',
  'menu:create': 'AVOQADO_MENU',
  'menu:delete': 'AVOQADO_MENU',
  'menu:import': 'AVOQADO_MENU',

  // Orders
  'orders:read': 'AVOQADO_ORDERS',
  'orders:write': 'AVOQADO_ORDERS',
  'orders:create': 'AVOQADO_ORDERS',
  'orders:delete': 'AVOQADO_ORDERS',

  // Payments
  'payments:read': 'AVOQADO_PAYMENTS',
  'payments:write': 'AVOQADO_PAYMENTS',
  'payments:refund': 'AVOQADO_PAYMENTS',

  // Inventory
  'inventory:read': 'AVOQADO_INVENTORY',
  'inventory:write': 'AVOQADO_INVENTORY',

  // Customers
  'customers:read': 'AVOQADO_CUSTOMERS',
  'customers:write': 'AVOQADO_CUSTOMERS',

  // Reviews
  'reviews:read': 'AVOQADO_REVIEWS',
  'reviews:write': 'AVOQADO_REVIEWS',

  // Reports
  'reports:read': 'AVOQADO_REPORTS',
  'reports:export': 'AVOQADO_REPORTS',

  // Shifts
  'shifts:read': 'AVOQADO_SHIFTS',
  'shifts:write': 'AVOQADO_SHIFTS',

  // Commissions
  'commissions:read': 'AVOQADO_COMMISSIONS',
  'commissions:write': 'AVOQADO_COMMISSIONS',
  'commissions:approve': 'AVOQADO_COMMISSIONS',
  'commissions:payout': 'AVOQADO_COMMISSIONS',

  // Promotions (Discounts & Coupons)
  'discounts:read': 'AVOQADO_PROMOTIONS',
  'discounts:write': 'AVOQADO_PROMOTIONS',
  'coupons:read': 'AVOQADO_PROMOTIONS',
  'coupons:write': 'AVOQADO_PROMOTIONS',

  // Balance/Settlements
  'settlements:read': 'AVOQADO_BALANCE',
  'settlements:write': 'AVOQADO_BALANCE',
}

/**
 * Request-level cache type
 * Use Map<string, UserAccess> to cache access per userId:venueId
 */
export type AccessCache = Map<string, UserAccess>

/**
 * Create a new access cache for a request
 * Attach this to req object to reuse across middlewares
 */
export function createAccessCache(): AccessCache {
  return new Map()
}

/**
 * Get user access for a specific venue
 *
 * This function:
 * 1. Fetches user's role in the target venue
 * 2. Fetches custom permissions from VenueRolePermission
 * 3. Fetches white-label module config
 * 4. Resolves all permissions and feature access
 *
 * Uses request-level cache to avoid duplicate queries within same request.
 *
 * @param userId - Staff member ID
 * @param venueId - Target venue ID
 * @param cache - Optional request-level cache (recommended for performance)
 * @returns Complete UserAccess object
 * @throws Error if user has no access to venue
 */
export async function getUserAccess(userId: string, venueId: string, cache?: AccessCache): Promise<UserAccess> {
  const cacheKey = `${userId}:${venueId}`

  // Check cache first
  if (cache?.has(cacheKey)) {
    logger.debug(`accessService.getUserAccess: Cache hit for ${cacheKey}`)
    return cache.get(cacheKey)!
  }

  logger.debug(`accessService.getUserAccess: Fetching access for user ${userId} in venue ${venueId}`)

  // First, check if user is SUPERADMIN (they have access to ALL venues)
  // SUPERADMIN is determined by having ANY StaffVenue with role = SUPERADMIN
  const superAdminVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId: userId,
      role: StaffRole.SUPERADMIN,
    },
    select: { id: true },
  })

  const isSuperAdmin = !!superAdminVenue

  // Parallel queries for performance
  const [staffVenueData, venueData, whiteLabelModule, rolePermissions] = await Promise.all([
    // 1. Get user's role in this venue (may be null for SUPERADMIN)
    prisma.staffVenue.findUnique({
      where: {
        staffId_venueId: {
          staffId: userId,
          venueId: venueId,
        },
      },
      select: {
        role: true,
        venue: {
          select: {
            organizationId: true,
          },
        },
      },
    }),

    // 2. Get venue data (needed for SUPERADMIN who may not have StaffVenue)
    isSuperAdmin
      ? prisma.venue.findUnique({
          where: { id: venueId },
          select: { organizationId: true },
        })
      : null,

    // 3. Get white-label module config (if enabled)
    prisma.venueModule.findFirst({
      where: {
        venueId: venueId,
        enabled: true,
        module: {
          code: 'WHITE_LABEL_DASHBOARD',
        },
      },
      select: {
        config: true,
      },
    }),

    // 4. Get custom permissions for this venue+role combo
    // Note: We query by venueId first, then filter by role after we know it
    prisma.venueRolePermission.findMany({
      where: {
        venueId: venueId,
      },
      select: {
        role: true,
        permissions: true,
      },
    }),
  ])

  // Determine role and organizationId
  let role: StaffRole
  let organizationId: string

  if (isSuperAdmin) {
    // SUPERADMIN has access to all venues
    role = StaffRole.SUPERADMIN
    organizationId = staffVenueData?.venue?.organizationId || venueData?.organizationId || ''

    if (!organizationId) {
      throw new Error(`Venue ${venueId} not found`)
    }
  } else if (staffVenueData) {
    // Regular user with StaffVenue record
    role = staffVenueData.role
    organizationId = staffVenueData.venue.organizationId
  } else {
    // User has no access to this venue
    throw new Error(`User ${userId} has no access to venue ${venueId}`)
  }

  // Find custom permissions for this role
  const customPerms = rolePermissions.find(rp => rp.role === role)
  const customPermissions = customPerms?.permissions || null

  // Resolve core permissions (using existing hasPermission logic for consistency)
  // Get base permissions first
  const defaultPerms = DEFAULT_PERMISSIONS[role] || []
  let basePermissions: string[]

  // OVERRIDE MODE for wildcard roles (OWNER, ADMIN)
  const hasWildcardDefaults = defaultPerms.includes('*:*')
  const hasCustomPermissions = customPermissions && customPermissions.length > 0

  if (hasWildcardDefaults && hasCustomPermissions) {
    basePermissions = customPermissions
  } else {
    basePermissions = [...defaultPerms, ...(customPermissions || [])]
  }

  // Resolve dependencies
  const resolvedPermissions = Array.from(resolvePermissions(basePermissions))

  // Process white-label config
  const whiteLabelEnabled = !!whiteLabelModule
  const enabledFeatures: string[] = []
  const featureAccess: Record<string, FeatureAccessResult> = {}

  if (whiteLabelEnabled && whiteLabelModule.config) {
    const config = whiteLabelModule.config as {
      enabledFeatures?: Array<{
        code: string
        source: string
        access?: FeatureAccess
      }>
    }

    if (config.enabledFeatures) {
      for (const feature of config.enabledFeatures) {
        enabledFeatures.push(feature.code)

        // Get access config (use defaults if not specified)
        const accessConfig: FeatureAccess = feature.access || DEFAULT_FEATURE_ACCESS

        // Check if user's role is allowed
        const isRoleAllowed = role === StaffRole.SUPERADMIN || accessConfig.allowedRoles.map(r => String(r)).includes(String(role))

        featureAccess[feature.code] = {
          allowed: isRoleAllowed,
          reason: isRoleAllowed ? undefined : 'ROLE_NOT_ALLOWED',
          dataScope: accessConfig.dataScope,
        }
      }
    }
  }

  // CENTRALIZED PERMISSION FILTERING FOR WHITE-LABEL
  // When white-label is enabled, filter permissions based on feature access.
  // This ensures frontend just calls can('permission') without needing to know about features.
  let finalPermissions = resolvedPermissions

  if (whiteLabelEnabled && role !== StaffRole.SUPERADMIN) {
    finalPermissions = resolvedPermissions.filter(permission => {
      const featureCode = PERMISSION_TO_FEATURE_MAP[permission]

      // If permission doesn't map to a feature, keep it (e.g., system permissions)
      if (!featureCode) {
        return true
      }

      // Check if the feature is enabled AND user has access
      const access = featureAccess[featureCode]
      return access?.allowed === true
    })

    logger.debug(`accessService.getUserAccess: Filtered permissions for white-label`, {
      original: resolvedPermissions.length,
      filtered: finalPermissions.length,
      removed: resolvedPermissions.length - finalPermissions.length,
    })
  }

  const access: UserAccess = {
    userId,
    venueId,
    organizationId,
    role,
    corePermissions: finalPermissions,
    whiteLabelEnabled,
    enabledFeatures,
    featureAccess,
  }

  // Store in cache
  if (cache) {
    cache.set(cacheKey, access)
  }

  logger.debug(`accessService.getUserAccess: Resolved access for ${cacheKey}`, {
    role,
    permissionCount: resolvedPermissions.length,
    whiteLabelEnabled,
    featureCount: enabledFeatures.length,
  })

  return access
}

/**
 * Check if user has a specific core permission
 *
 * @param access - UserAccess object from getUserAccess()
 * @param permission - Permission to check (e.g., 'tpv:read')
 * @returns true if user has permission
 */
export function hasPermission(access: UserAccess, permission: string): boolean {
  // SUPERADMIN always has all permissions
  if (access.role === StaffRole.SUPERADMIN) {
    return true
  }

  // Check for wildcard
  if (access.corePermissions.includes('*:*')) {
    return true
  }

  // Check exact permission
  if (access.corePermissions.includes(permission)) {
    return true
  }

  // Check wildcard patterns (e.g., 'tpv:*' matches 'tpv:create')
  const [resource, action] = permission.split(':')
  if (access.corePermissions.includes(`${resource}:*`)) return true
  if (access.corePermissions.includes(`*:${action}`)) return true

  return false
}

/**
 * Check if user can access a white-label feature
 *
 * @param access - UserAccess object from getUserAccess()
 * @param featureCode - Feature code to check (e.g., 'STORES_ANALYSIS')
 * @returns FeatureAccessResult with allowed status and reason
 */
export function canAccessFeature(access: UserAccess, featureCode: string): FeatureAccessResult {
  // SUPERADMIN always has access
  if (access.role === StaffRole.SUPERADMIN) {
    return {
      allowed: true,
      dataScope: 'organization',
    }
  }

  // If white-label is not enabled, all features are accessible (normal Avoqado behavior)
  if (!access.whiteLabelEnabled) {
    return {
      allowed: true,
      dataScope: 'venue',
    }
  }

  // Check if feature is in enabled list
  if (!access.enabledFeatures.includes(featureCode)) {
    return {
      allowed: false,
      reason: 'FEATURE_NOT_ENABLED',
      dataScope: 'venue',
    }
  }

  // Return the computed access for this feature
  return (
    access.featureAccess[featureCode] || {
      allowed: false,
      reason: 'FEATURE_NOT_ENABLED',
      dataScope: 'venue',
    }
  )
}

/**
 * Get the data scope for a feature
 * Falls back to 'venue' if feature not found or white-label not enabled
 *
 * @param access - UserAccess object from getUserAccess()
 * @param featureCode - Feature code
 * @returns DataScope for the feature
 */
export function getFeatureDataScope(access: UserAccess, featureCode: string): 'venue' | 'user-venues' | 'organization' {
  if (!access.whiteLabelEnabled) {
    return 'venue'
  }

  return access.featureAccess[featureCode]?.dataScope || 'venue'
}

/**
 * Export for use in other services
 */
export const accessService = {
  getUserAccess,
  hasPermission,
  canAccessFeature,
  getFeatureDataScope,
  createAccessCache,
}
