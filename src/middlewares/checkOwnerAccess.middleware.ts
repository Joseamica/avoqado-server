import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '../security'
import prisma from '@/utils/prismaClient'

/**
 * Middleware to check if the user has OWNER access to the requested organization.
 *
 * This middleware validates:
 * - SUPERADMIN can access any organization
 * - OWNER can access organizations where they have a venue with OWNER role
 *   (supports multi-org scenarios where a user can be OWNER in multiple organizations)
 *
 * Expects `req.authContext` to be populated by authentication middleware
 * and `req.params.orgId` to contain the requested organization ID.
 */
export const checkOwnerAccess = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Ensure authContext exists (should be set by authentication middleware)
  if (!req.authContext || !req.authContext.role) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication context not found. Ensure authentication middleware runs first.',
    })
    return
  }

  const { userId, role } = req.authContext
  const { orgId: requestedOrgId } = req.params

  // Validate that orgId parameter exists
  if (!requestedOrgId) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Organization ID (orgId) parameter is required.',
    })
    return
  }

  // SUPERADMIN can access any organization
  if (role === StaffRole.SUPERADMIN) {
    return next()
  }

  // Check if user has OWNER role in any venue of the requested organization
  // This supports multi-org scenarios where a user can be OWNER in multiple organizations
  // IMPORTANT: We check the database regardless of the token's role, because:
  // - User may have logged in from a venue where they're CASHIER
  // - But they could be OWNER in the organization they're trying to access
  const ownerVenueInOrg = await prisma.staffVenue.findFirst({
    where: {
      staffId: userId,
      role: StaffRole.OWNER,
      venue: {
        organizationId: requestedOrgId,
      },
    },
  })

  if (ownerVenueInOrg) {
    return next()
  }

  // Deny access if user is not OWNER in any venue of the requested organization
  res.status(403).json({
    error: 'Forbidden',
    message: `Access denied. You don't have permission to access this organization.`,
  })
}

/**
 * Factory function to create a middleware that checks owner access with optional ADMIN support.
 *
 * @param allowAdmin - If true, also allows ADMIN role (for future extension)
 */
export const checkOrganizationAccess = (allowAdmin: boolean = false) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.authContext || !req.authContext.role) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication context not found.',
      })
      return
    }

    const { userId, role } = req.authContext
    const { orgId: requestedOrgId } = req.params

    if (!requestedOrgId) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Organization ID (orgId) parameter is required.',
      })
      return
    }

    // SUPERADMIN always has access
    if (role === StaffRole.SUPERADMIN) {
      return next()
    }

    // Check if user has the required role in any venue of the requested organization
    // IMPORTANT: We check the database regardless of the token's role, because:
    // - User may have logged in from a venue where they have a different role
    // - But they could have the required role in the organization they're accessing
    const allowedRoles = allowAdmin ? [StaffRole.OWNER, StaffRole.ADMIN] : [StaffRole.OWNER]

    const staffVenueInOrg = await prisma.staffVenue.findFirst({
      where: {
        staffId: userId,
        role: { in: allowedRoles },
        venue: {
          organizationId: requestedOrgId,
        },
      },
    })

    if (staffVenueInOrg) {
      return next()
    }

    res.status(403).json({
      error: 'Forbidden',
      message: `Access denied. Required role: ${allowAdmin ? 'OWNER or ADMIN' : 'OWNER'}.`,
    })
  }
}
