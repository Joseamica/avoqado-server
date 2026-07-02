import { Request, Response, NextFunction } from 'express'
import { OrgRole, StaffRole, PermissionSet } from '@prisma/client'
import { evaluatePermissionList, hasPermission } from '@/lib/permissions'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'

type RoleResolutionSource = 'token' | 'staffVenue' | 'orgOwner' | 'none'

interface ResolvedUserRole {
  role: StaffRole | null
  source: RoleResolutionSource
  permissionSet?: PermissionSet | null
}

/**
 * Resolve effective role for a target venue.
 *
 * Priority:
 * 1) Token role when target venue matches token venue
 * 2) Active StaffVenue role in target venue
 * 3) Active Org OWNER membership for target venue's organization
 */
/**
 * Resolve the active venueId for a permission check.
 *
 * Priority:
 * 1) `:venueId` path param (venue-scoped routes like /venues/:venueId/...)
 * 2) `x-venue-id` request header (sent by the dashboard for org-scoped routes
 *    so the user's active venue context follows their navigation, not the
 *    stale JWT venue from their last switchVenue call)
 * 3) `authContext.venueId` from the JWT (fallback for legacy clients)
 *
 * Security note: this only picks which venue to evaluate the role *in*. The
 * actual role lookup goes against the StaffVenue table (`resolveUserRoleForVenue`),
 * so a client that lies about the header still gets denied if they don't hold
 * the role in that venue.
 */
export function resolveRequestVenueId(req: Request, authContext: { venueId?: string }): string | undefined {
  const fromParams = req.params?.venueId
  if (fromParams) return fromParams
  const fromHeader = req.headers?.['x-venue-id']
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader
  return authContext.venueId
}

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
      permissionSetId: true,
      permissionSet: true,
    },
  })

  if (staffVenue?.active) {
    return {
      role: staffVenue.role,
      source: 'staffVenue',
      permissionSet: staffVenue.permissionSetId ? staffVenue.permissionSet : null,
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
  const middleware = async (req: Request, res: Response, next: NextFunction) => {
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

      const venueId = resolveRequestVenueId(req, authContext)

      if (!venueId) {
        logger.warn('checkPermission: No venueId found in request params, x-venue-id header, or authContext')
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Venue ID required',
        })
      }

      // Check if user is SUPERADMIN (they have access to ALL venues)
      // SUPERADMIN is determined by having ANY StaffVenue with role = SUPERADMIN
      //
      // IMPERSONATION: bypass is disabled while impersonating so the middleware
      // evaluates permissions against the effective (target) role, not the real
      // SUPERADMIN's. The impersonation guard already enforces read-only so
      // writes never reach here in practice, but this also keeps GET-route
      // permission checks (e.g., checkPermission for a read-only dashboard API)
      // behaving consistently with what the target would see.
      const superAdminVenue = authContext.isImpersonating
        ? null
        : await prisma.staffVenue.findFirst({
            where: {
              staffId: authContext.userId,
              role: StaffRole.SUPERADMIN,
            },
            select: { id: true },
          })

      const isSuperAdmin = !!superAdminVenue

      // SUPERADMIN has all permissions - skip further checks
      if (isSuperAdmin) {
        // Expose the effective role for downstream controllers (role assignment /
        // permission editing) — additive, does not affect this authorization.
        ;(req as any).resolvedRole = StaffRole.SUPERADMIN
        logger.debug(`checkPermission: SUPERADMIN ${authContext.userId} granted '${requiredPermission}' in venue ${venueId}`)
        return next()
      }

      const {
        role: userRole,
        source: roleSource,
        permissionSet,
      } = await resolveUserRoleForVenue({
        userId: authContext.userId,
        targetVenueId: venueId,
        tokenVenueId: authContext.venueId,
        tokenRole: authContext.role,
      })

      if (!userRole) {
        logger.warn(`checkPermission: User ${authContext.userId} has no access to venue ${venueId}`)

        // Audit: cross-venue access attempt. Wrapped in try/catch so a mocked
        // req without .get() (in unit tests) can't break the response path.
        try {
          void logAction({
            staffId: authContext.userId,
            venueId,
            action: 'PERMISSION_DENIED',
            entity: 'venue-access',
            entityId: requiredPermission,
            data: {
              permission: requiredPermission,
              reason: 'no_venue_access',
              method: req.method,
              path: req.originalUrl,
            },
            ipAddress: req.ip,
            userAgent: typeof req.get === 'function' ? req.get('user-agent') : undefined,
          })
        } catch (auditErr) {
          logger.error('checkPermission: audit log construction failed (non-fatal)', auditErr)
        }

        return res.status(403).json({
          error: 'Forbidden',
          message: 'No access to this venue',
        })
      }

      // Expose the venue-resolved role so downstream controllers authorize role
      // assignments / permission edits against the caller's role IN THIS VENUE,
      // never their raw JWT role (which may belong to a different venue).
      ;(req as any).resolvedRole = userRole

      // If a permission set is assigned, evaluate that effective list directly.
      let authorized: boolean
      if (permissionSet) {
        authorized = evaluatePermissionList(permissionSet.permissions, requiredPermission)
      } else {
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
        authorized = hasPermission(userRole, customPermissions, requiredPermission)
      }

      if (!authorized) {
        logger.warn(
          `checkPermission: User ${authContext.userId} (${userRole}) denied access to '${requiredPermission}' in venue ${venueId}`,
        )

        // Persist the denial to ActivityLog for post-deploy monitoring + audit.
        // Wrapped in try/catch so a mocked req without .get() (in unit tests)
        // or any unexpected synchronous failure can't leak as a 500 response.
        // logAction() itself is also fire-and-forget + try/catch internally.
        try {
          void logAction({
            staffId: authContext.userId,
            venueId,
            action: 'PERMISSION_DENIED',
            entity: 'permission',
            entityId: requiredPermission,
            data: {
              permission: requiredPermission,
              userRole,
              roleSource,
              method: req.method,
              path: req.originalUrl,
              hasPermissionSet: !!permissionSet,
            },
            ipAddress: req.ip,
            userAgent: typeof req.get === 'function' ? req.get('user-agent') : undefined,
          })
        } catch (auditErr) {
          logger.error('checkPermission: audit log construction failed (non-fatal)', auditErr)
        }

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

  // Expuesto para tests de auditoría de rutas: permite afirmar qué permiso
  // exige cada endpoint sin ejecutar el middleware.
  ;(middleware as any).requiredPermission = requiredPermission
  return middleware
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

      const venueId = resolveRequestVenueId(req, authContext)

      if (!venueId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Venue ID required',
        })
      }

      const { role: userRole, permissionSet } = await resolveUserRoleForVenue({
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

      // Check permission set first, then fall back to role-based
      let authorized: boolean
      if (permissionSet) {
        authorized = requiredPermissions.some(perm => evaluatePermissionList(permissionSet.permissions, perm))
      } else {
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

        authorized = requiredPermissions.some(perm => hasPermission(userRole, customPermissions, perm))
      }

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

      const venueId = resolveRequestVenueId(req, authContext)

      if (!venueId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Venue ID required',
        })
      }

      const { role: userRole, permissionSet } = await resolveUserRoleForVenue({
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

      // Check permission set first, then fall back to role-based
      let authorized: boolean
      if (permissionSet) {
        authorized = requiredPermissions.every(perm => evaluatePermissionList(permissionSet.permissions, perm))
      } else {
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

        authorized = requiredPermissions.every(perm => hasPermission(userRole, customPermissions, perm))
      }

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
