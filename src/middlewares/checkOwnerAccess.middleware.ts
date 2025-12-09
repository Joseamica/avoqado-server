import { Request, Response, NextFunction } from 'express'
import { StaffRole } from '../security'

/**
 * Middleware to check if the user has OWNER access to the requested organization.
 *
 * This middleware validates:
 * - SUPERADMIN can access any organization
 * - OWNER can only access their own organization (tokenOrgId === requestedOrgId)
 *
 * Expects `req.authContext` to be populated by authentication middleware
 * and `req.params.orgId` to contain the requested organization ID.
 */
export const checkOwnerAccess = (req: Request, res: Response, next: NextFunction): void => {
  // Ensure authContext exists (should be set by authentication middleware)
  if (!req.authContext || !req.authContext.role) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication context not found. Ensure authentication middleware runs first.',
    })
    return
  }

  const { orgId: tokenOrgId, role } = req.authContext
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

  // OWNER can only access their own organization
  if (role === StaffRole.OWNER && tokenOrgId === requestedOrgId) {
    return next()
  }

  // Deny access for all other cases
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
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authContext || !req.authContext.role) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication context not found.',
      })
      return
    }

    const { orgId: tokenOrgId, role } = req.authContext
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

    // OWNER always has access to their org
    if (role === StaffRole.OWNER && tokenOrgId === requestedOrgId) {
      return next()
    }

    // Optionally allow ADMIN (for future extension)
    if (allowAdmin && role === StaffRole.ADMIN && tokenOrgId === requestedOrgId) {
      return next()
    }

    res.status(403).json({
      error: 'Forbidden',
      message: `Access denied. Required role: ${allowAdmin ? 'OWNER or ADMIN' : 'OWNER'}.`,
    })
  }
}
