import { Request, Response, NextFunction } from 'express'
import { OrgRole, StaffRole } from '@prisma/client'
import { hasPermission } from '@/lib/permissions'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

type RoleResolutionSource = 'token' | 'staffVenue' | 'orgOwner' | 'none'

interface ResolvedUserRole {
  role: StaffRole | null
  source: RoleResolutionSource
}

/**
 * Resolve effective role for a target venue.
 *
 * Priority:
 * 1) Token role when target venue matches token venue
 * 2) Active StaffVenue role in target venue
 * 3) Active Org OWNER membership for target venue's organization
 */
async function resolveUserRoleForVenue(params: {
  userId: string
  targetVenueId: string
  tokenVenueId?: string
  tokenRole?: string
}): Promise<ResolvedUserRole> {
  const { userId, targetVenueId, tokenVenueId, tokenRole } = params

  if (tokenVenueId && tokenVenueId === targetVenueId && tokenRole) {
    return {
      role: tokenRole as StaffRole,
      source: 'token',
    }
  }

  const staffVenue = await prisma.staffVenue.findUnique({
    where: {
      staffId_venueId: {
        staffId: userId,
        venueId: targetVenueId,
      },
    },
    select: {
      role: true,
      active: true,
    },
  })

  if (staffVenue?.active) {
    return {
      role: staffVenue.role,
      source: 'staffVenue',
    }
  }

  const targetVenue = await prisma.venue.findUnique({
    where: { id: targetVenueId },
    select: { organizationId: true },
  })

  if (!targetVenue) {
    return {
      role: null,
      source: 'none',
    }
  }

  const orgMembership = await prisma.staffOrganization.findUnique({
    where: {
      staffId_organizationId: {
        staffId: userId,
        organizationId: targetVenue.organizationId,
      },
    },
    select: {
      role: true,
      isActive: true,
    },
  })

  if (orgMembership?.isActive && orgMembership.role === OrgRole.OWNER) {
    return {
      role: StaffRole.OWNER,
      source: 'orgOwner',
    }
  }

  return {
    role: null,
    source: 'none',
  }
}

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

      // Check if user is SUPERADMIN (they have access to ALL venues)
      // SUPERADMIN is determined by having ANY StaffVenue with role = SUPERADMIN
      const superAdminVenue = await prisma.staffVenue.findFirst({
        where: {
          staffId: authContext.userId,
          role: StaffRole.SUPERADMIN,
        },
        select: { id: true },
      })

      const isSuperAdmin = !!superAdminVenue

      // SUPERADMIN has all permissions - skip further checks
      if (isSuperAdmin) {
        logger.debug(`checkPermission: SUPERADMIN ${authContext.userId} granted '${requiredPermission}' in venue ${venueId}`)
        return next()
      }

      const { role: userRole, source: roleSource } = await resolveUserRoleForVenue({
        userId: authContext.userId,
        targetVenueId: venueId,
        tokenVenueId: authContext.venueId,
        tokenRole: authContext.role,
      })

      if (!userRole) {
        logger.warn(`checkPermission: User ${authContext.userId} has no access to venue ${venueId}`)
        return res.status(403).json({
          error: 'Forbidden',
          message: 'No access to this venue',
        })
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
      logger.debug(
        `checkPermission: User ${authContext.userId} (${userRole}) granted '${requiredPermission}' in venue ${venueId} [source=${roleSource}]`,
      )
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

      const { role: userRole } = await resolveUserRoleForVenue({
        userId: authContext.userId,
        targetVenueId: venueId,
        tokenVenueId: authContext.venueId,
        tokenRole: authContext.role,
      })

      if (!userRole) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'No access to this venue',
        })
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

      const { role: userRole } = await resolveUserRoleForVenue({
        userId: authContext.userId,
        targetVenueId: venueId,
        tokenVenueId: authContext.venueId,
        tokenRole: authContext.role,
      })

      if (!userRole) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'No access to this venue',
        })
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
