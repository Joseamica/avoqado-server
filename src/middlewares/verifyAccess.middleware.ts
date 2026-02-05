/**
 * Verify Access Middleware
 *
 * Unified middleware for checking both core permissions and white-label feature access.
 * Uses the access service for consistent permission resolution with request-level caching.
 *
 * This middleware:
 * 1. Uses request-level cache to avoid duplicate DB queries
 * 2. Validates venue membership when accessing different venues
 * 3. Supports checking permissions, features, or both
 * 4. Attaches UserAccess to request for use in controllers
 * 5. Is FAIL-CLOSED on errors (denies access if checks fail)
 *
 * Usage:
 * ```typescript
 * // Check a core permission
 * router.get('/terminals', verifyAccess({ permission: 'tpv:read' }), controller)
 *
 * // Check a white-label feature
 * router.get('/stores', verifyAccess({ featureCode: 'STORES_ANALYSIS' }), controller)
 *
 * // Check both (AND logic)
 * router.post('/stores', verifyAccess({
 *   permission: 'analytics:write',
 *   featureCode: 'STORES_ANALYSIS',
 *   requireBoth: true
 * }), controller)
 * ```
 *
 * @see docs/PERMISSIONS_SYSTEM.md for architecture details
 */
import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client'
import {
  getUserAccess,
  hasPermission,
  canAccessFeature,
  createAccessCache,
  UserAccess,
  AccessCache,
} from '@/services/access/access.service'
import { ForbiddenError } from '@/errors/AppError'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

/**
 * Options for verifyAccess middleware
 */
export interface VerifyAccessOptions {
  /** Core permission to check (e.g., 'tpv:read') */
  permission?: string
  /** White-label feature code to check (e.g., 'STORES_ANALYSIS') */
  featureCode?: string
  /**
   * If true, requires BOTH permission AND feature access (AND logic)
   * If false, requires EITHER permission OR feature access (OR logic)
   * Default: true (AND logic) when both are specified
   */
  requireBoth?: boolean
  /**
   * If true, requires WHITE_LABEL_DASHBOARD module to be enabled.
   * Use for routes that are EXCLUSIVE to white-label venues.
   * Default: false (routes work for both normal and white-label venues)
   */
  requireWhiteLabel?: boolean
}

// Extend Express Request to include access-related properties
// Using module augmentation pattern (ES2015 compliant)
declare module 'express-serve-static-core' {
  interface Request {
    /** Request-level cache for access data */
    accessCache?: AccessCache
    /** User's access information for the target venue */
    access?: UserAccess
    /** White-label feature code (if accessing a feature route) */
    whiteLabelFeatureCode?: string
    /** Data scope for the feature (if white-label) */
    whiteLabelDataScope?: 'venue' | 'user-venues' | 'organization'
  }
}

/**
 * Verify access middleware factory
 *
 * @param options - Access check options
 * @returns Express middleware function
 */
export const verifyAccess = (options: VerifyAccessOptions = {}) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authContext = (req as any).authContext

      // Validate auth context exists
      if (!authContext || !authContext.userId) {
        logger.warn('verifyAccess: No authContext found in request')
        throw new ForbiddenError('Authentication required')
      }

      const { userId } = authContext

      // Initialize request-level cache if not exists
      if (!req.accessCache) {
        req.accessCache = createAccessCache()
      }

      // Check if user is SUPERADMIN (they have access to ALL venues)
      // SUPERADMIN is determined by having ANY StaffVenue with role = SUPERADMIN
      const superAdminVenue = await prisma.staffVenue.findFirst({
        where: {
          staffId: userId,
          role: StaffRole.SUPERADMIN,
        },
        select: { id: true },
      })

      // SUPERADMIN always passes through - they have access to ALL venues
      if (superAdminVenue) {
        logger.debug(`verifyAccess: SUPERADMIN bypass for user ${userId}`)
        return next()
      }

      // Determine target venueId
      // Priority: URL params > JWT token venue
      const targetVenueId = req.params.venueId || authContext.venueId

      if (!targetVenueId) {
        logger.warn('verifyAccess: No venueId found in URL params or authContext')
        throw new ForbiddenError('Venue ID required')
      }

      // Get user access (with caching)
      let access: UserAccess
      try {
        access = await getUserAccess(userId, targetVenueId, req.accessCache)
      } catch (error) {
        // User doesn't have access to this venue
        logger.warn(`verifyAccess: User ${userId} denied access to venue ${targetVenueId}`, error)
        throw new ForbiddenError('No access to this venue')
      }

      // Attach access to request for use in controllers
      req.access = access

      // Check if white-label is required for this route
      if (options.requireWhiteLabel && !access.whiteLabelEnabled) {
        logger.warn(`verifyAccess: User ${userId} denied - route requires white-label but venue ${targetVenueId} doesn't have it enabled`)
        throw new ForbiddenError('This feature requires white-label dashboard to be enabled', 'MODULE_DISABLED')
      }

      // If no specific checks requested, just validate venue access
      if (!options.permission && !options.featureCode) {
        logger.debug(`verifyAccess: Venue access granted for ${userId} in ${targetVenueId}`)
        return next()
      }

      // Perform permission/feature checks
      const permissionResult = options.permission ? hasPermission(access, options.permission) : null
      const featureResult = options.featureCode ? canAccessFeature(access, options.featureCode) : null

      // Determine if access is granted
      let accessGranted: boolean

      if (options.permission && options.featureCode) {
        // Both specified - use requireBoth logic (default: AND)
        const useAndLogic = options.requireBoth !== false
        if (useAndLogic) {
          accessGranted = permissionResult === true && featureResult?.allowed === true
        } else {
          accessGranted = permissionResult === true || featureResult?.allowed === true
        }
      } else if (options.permission) {
        // Only permission specified
        accessGranted = permissionResult === true
      } else if (options.featureCode) {
        // Only feature specified
        accessGranted = featureResult?.allowed === true
      } else {
        // Should not reach here, but fail-closed
        accessGranted = false
      }

      if (!accessGranted) {
        // Build detailed error message
        let errorMessage = 'Access denied'
        let errorCode = 'ACCESS_DENIED'

        if (options.permission && permissionResult === false) {
          errorMessage = `Permission '${options.permission}' required`
          errorCode = 'PERMISSION_DENIED'
        } else if (options.featureCode && featureResult && !featureResult.allowed) {
          if (featureResult.reason === 'FEATURE_NOT_ENABLED') {
            errorMessage = `Feature '${options.featureCode}' is not enabled`
            errorCode = 'FEATURE_NOT_ENABLED'
          } else if (featureResult.reason === 'ROLE_NOT_ALLOWED') {
            errorMessage = `Your role '${access.role}' does not have access to this feature`
            errorCode = 'ROLE_NOT_ALLOWED'
          }
        }

        logger.warn(`verifyAccess: User ${userId} (${access.role}) denied. ${errorMessage}`, {
          venueId: targetVenueId,
          permission: options.permission,
          featureCode: options.featureCode,
        })

        throw new ForbiddenError(errorMessage, errorCode)
      }

      // Attach feature info to request if checking a feature
      if (options.featureCode && featureResult) {
        req.whiteLabelFeatureCode = options.featureCode
        req.whiteLabelDataScope = featureResult.dataScope
      }

      logger.debug(
        `verifyAccess: User ${userId} (${access.role}) granted access. ` +
          `Permission: ${options.permission || 'N/A'}, Feature: ${options.featureCode || 'N/A'}`,
      )

      next()
    } catch (error) {
      // Re-throw ForbiddenError to be handled by error middleware
      if (error instanceof ForbiddenError) {
        return next(error)
      }

      // SECURITY: Fail-closed on unexpected errors
      // If we can't verify access, deny rather than allow
      logger.error('verifyAccess: Unexpected error - denying access', error)
      return next(new ForbiddenError('Access verification failed'))
    }
  }
}

/**
 * Middleware to verify only venue membership (no permission/feature check)
 * Useful for endpoints that just need to confirm user has access to the venue
 */
export const verifyVenueAccess = verifyAccess({})

/**
 * Convenience function to create a permission-only middleware
 *
 * @param permission - Permission to check
 * @returns Express middleware
 */
export const verifyPermission = (permission: string) => verifyAccess({ permission })

/**
 * Convenience function to create a feature-only middleware
 *
 * @param featureCode - Feature code to check
 * @returns Express middleware
 */
export const verifyFeature = (featureCode: string) => verifyAccess({ featureCode })

/**
 * Export individual functions for flexibility
 */
export { verifyAccess as default }
