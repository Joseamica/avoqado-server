import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client'
import { hasPermission } from '@/lib/permissions'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

/**
 * Middleware to check if user has required permission
 *
 * ⚠️ CRITICAL: Must match frontend permission logic in:
 * `avoqado-web-dashboard/src/routes/PermissionProtectedRoute.tsx`
 * `avoqado-web-dashboard/src/hooks/usePermissions.ts`
 *
 * This middleware:
 * 1. Loads custom role permissions from VenueRolePermission table
 * 2. Uses override mode for wildcard roles (OWNER/ADMIN/SUPERADMIN)
 * 3. Uses merge mode for other roles
 *
 * Usage in routes:
 * ```typescript
 * router.post(
 *   '/venues/:venueId/tpvs',
 *   authenticateTokenMiddleware,
 *   checkPermission('tpv:create'),
 *   tpvController.createTerminal
 * )
 * ```
 *
 * @param requiredPermission Permission string (format: "resource:action")
 * @returns Express middleware function
 */
export const checkPermission = (requiredPermission: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // authContext should be attached by authenticateToken middleware
      const authContext = (req as any).authContext

      if (!authContext || !authContext.userId) {
        logger.warn('checkPermission: No authContext found in request')
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        })
      }

      // MULTI-VENUE FIX: Use venueId from URL params if available, fallback to authContext
      // This allows users to navigate between venues without calling switchVenue
      const urlVenueId = req.params.venueId
      const venueId = urlVenueId || authContext.venueId

      if (!venueId) {
        logger.warn('checkPermission: No venueId found in request params or authContext')
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Venue ID required',
        })
      }

      // If venueId from URL differs from token, look up user's actual role in that venue
      let userRole: StaffRole
      if (urlVenueId && urlVenueId !== authContext.venueId) {
        // Look up user's role in the target venue
        const staffVenue = await prisma.staffVenue.findUnique({
          where: {
            staffId_venueId: {
              staffId: authContext.userId,
              venueId: urlVenueId,
            },
          },
          select: { role: true },
        })

        if (!staffVenue) {
          logger.warn(`checkPermission: User ${authContext.userId} has no access to venue ${urlVenueId}`)
          return res.status(403).json({
            error: 'Forbidden',
            message: 'No access to this venue',
          })
        }

        userRole = staffVenue.role
      } else {
        // Use role from token (same venue)
        userRole = authContext.role as StaffRole
      }

      // Load custom permissions from VenueRolePermission table
      let customPermissions: string[] | null = null

      const venueRolePermission = await prisma.venueRolePermission.findUnique({
        where: {
          venueId_role: {
            venueId,
            role: userRole,
          },
        },
        select: {
          permissions: true,
        },
      })

      if (venueRolePermission) {
        customPermissions = venueRolePermission.permissions as string[]
      }

      // Check if user has permission (uses override mode for wildcard roles)
      const authorized = hasPermission(userRole, customPermissions, requiredPermission)

      if (!authorized) {
        logger.warn(
          `checkPermission: User ${authContext.userId} (${userRole}) denied access to '${requiredPermission}' in venue ${venueId}`,
        )

        return res.status(403).json({
          error: 'Forbidden',
          message: `Permission '${requiredPermission}' required`,
          required: requiredPermission,
          userRole,
        })
      }

      // Permission granted, continue
      logger.debug(`checkPermission: User ${authContext.userId} (${userRole}) granted '${requiredPermission}' in venue ${venueId}`)
      next()
    } catch (error) {
      logger.error('checkPermission: Error checking permission', error)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to verify permissions',
      })
    }
  }
}

/**
 * Middleware to check if user has ANY of the required permissions
 *
 * @param requiredPermissions Array of permission strings
 * @returns Express middleware function
 */
export const checkAnyPermission = (requiredPermissions: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authContext = (req as any).authContext

      if (!authContext || !authContext.userId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        })
      }

      // MULTI-VENUE FIX: Use venueId from URL params if available
      const urlVenueId = req.params.venueId
      const venueId = urlVenueId || authContext.venueId

      if (!venueId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Venue ID required',
        })
      }

      // Dynamic role lookup if URL venue differs from token
      let userRole: StaffRole
      if (urlVenueId && urlVenueId !== authContext.venueId) {
        const staffVenue = await prisma.staffVenue.findUnique({
          where: {
            staffId_venueId: {
              staffId: authContext.userId,
              venueId: urlVenueId,
            },
          },
          select: { role: true },
        })

        if (!staffVenue) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'No access to this venue',
          })
        }
        userRole = staffVenue.role
      } else {
        userRole = authContext.role as StaffRole
      }

      // Load custom permissions
      let customPermissions: string[] | null = null

      const venueRolePermission = await prisma.venueRolePermission.findUnique({
        where: {
          venueId_role: {
            venueId,
            role: userRole,
          },
        },
        select: {
          permissions: true,
        },
      })

      if (venueRolePermission) {
        customPermissions = venueRolePermission.permissions as string[]
      }

      // Check if user has ANY of the permissions
      const authorized = requiredPermissions.some(perm => hasPermission(userRole, customPermissions, perm))

      if (!authorized) {
        logger.warn(
          `checkAnyPermission: User ${authContext.userId} (${userRole}) denied access. Required one of: ${requiredPermissions.join(', ')}`,
        )

        return res.status(403).json({
          error: 'Forbidden',
          message: `One of these permissions required: ${requiredPermissions.join(', ')}`,
          required: requiredPermissions,
          userRole,
        })
      }

      logger.debug(`checkAnyPermission: User ${authContext.userId} (${userRole}) granted access`)
      next()
    } catch (error) {
      logger.error('checkAnyPermission: Error checking permissions', error)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to verify permissions',
      })
    }
  }
}

/**
 * Middleware to check if user has ALL of the required permissions
 *
 * @param requiredPermissions Array of permission strings
 * @returns Express middleware function
 */
export const checkAllPermissions = (requiredPermissions: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authContext = (req as any).authContext

      if (!authContext || !authContext.userId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        })
      }

      // MULTI-VENUE FIX: Use venueId from URL params if available
      const urlVenueId = req.params.venueId
      const venueId = urlVenueId || authContext.venueId

      if (!venueId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Venue ID required',
        })
      }

      // Dynamic role lookup if URL venue differs from token
      let userRole: StaffRole
      if (urlVenueId && urlVenueId !== authContext.venueId) {
        const staffVenue = await prisma.staffVenue.findUnique({
          where: {
            staffId_venueId: {
              staffId: authContext.userId,
              venueId: urlVenueId,
            },
          },
          select: { role: true },
        })

        if (!staffVenue) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'No access to this venue',
          })
        }
        userRole = staffVenue.role
      } else {
        userRole = authContext.role as StaffRole
      }

      // Load custom permissions
      let customPermissions: string[] | null = null

      const venueRolePermission = await prisma.venueRolePermission.findUnique({
        where: {
          venueId_role: {
            venueId,
            role: userRole,
          },
        },
        select: {
          permissions: true,
        },
      })

      if (venueRolePermission) {
        customPermissions = venueRolePermission.permissions as string[]
      }

      // Check if user has ALL of the permissions
      const authorized = requiredPermissions.every(perm => hasPermission(userRole, customPermissions, perm))

      if (!authorized) {
        logger.warn(
          `checkAllPermissions: User ${authContext.userId} (${userRole}) denied access. Required all of: ${requiredPermissions.join(', ')}`,
        )

        return res.status(403).json({
          error: 'Forbidden',
          message: `All of these permissions required: ${requiredPermissions.join(', ')}`,
          required: requiredPermissions,
          userRole,
        })
      }

      logger.debug(`checkAllPermissions: User ${authContext.userId} (${userRole}) granted access`)
      next()
    } catch (error) {
      logger.error('checkAllPermissions: Error checking permissions', error)
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to verify permissions',
      })
    }
  }
}
