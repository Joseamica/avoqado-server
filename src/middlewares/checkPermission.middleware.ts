import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '@prisma/client'
import { hasPermission } from '@/lib/permissions'
import logger from '@/config/logger'

/**
 * Middleware to check if user has required permission
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
  return (req: Request, res: Response, next: NextFunction) => {
    // authContext should be attached by authenticateToken middleware
    const authContext = (req as any).authContext

    if (!authContext || !authContext.role) {
      logger.warn('checkPermission: No authContext found in request')
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      })
    }

    // Get user's role from authContext
    const userRole = authContext.role as StaffRole

    // Note: Custom permissions from StaffVenue.permissions are not in JWT token
    // For now, we only check against default role-based permissions
    // TODO: Add custom permissions to JWT payload or fetch from database
    const customPermissions: string[] = []

    // Check if user has permission
    const authorized = hasPermission(userRole, customPermissions, requiredPermission)

    if (!authorized) {
      logger.warn(`checkPermission: User ${authContext.userId} (${userRole}) denied access to '${requiredPermission}'`)

      return res.status(403).json({
        error: 'Forbidden',
        message: `Permission '${requiredPermission}' required`,
        required: requiredPermission,
        userRole,
      })
    }

    // Permission granted, continue
    logger.debug(`checkPermission: User ${authContext.userId} (${userRole}) granted '${requiredPermission}'`)
    next()
  }
}

/**
 * Middleware to check if user has ANY of the required permissions
 *
 * @param requiredPermissions Array of permission strings
 * @returns Express middleware function
 */
export const checkAnyPermission = (requiredPermissions: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const authContext = (req as any).authContext

    if (!authContext || !authContext.role) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      })
    }

    const userRole = authContext.role as StaffRole
    const customPermissions: string[] = [] // TODO: Add custom permissions support

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
  }
}

/**
 * Middleware to check if user has ALL of the required permissions
 *
 * @param requiredPermissions Array of permission strings
 * @returns Express middleware function
 */
export const checkAllPermissions = (requiredPermissions: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const authContext = (req as any).authContext

    if (!authContext || !authContext.role) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      })
    }

    const userRole = authContext.role as StaffRole
    const customPermissions: string[] = [] // TODO: Add custom permissions support

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
  }
}
