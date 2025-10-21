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

      if (!authContext || !authContext.role || !authContext.venueId) {
        logger.warn('checkPermission: No authContext found in request')
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        })
      }

      // Get user's role and venue from authContext
      const userRole = authContext.role as StaffRole
      const venueId = authContext.venueId

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

      if (!authContext || !authContext.role || !authContext.venueId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        })
      }

      const userRole = authContext.role as StaffRole
      const venueId = authContext.venueId

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

      if (!authContext || !authContext.role || !authContext.venueId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        })
      }

      const userRole = authContext.role as StaffRole
      const venueId = authContext.venueId

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
