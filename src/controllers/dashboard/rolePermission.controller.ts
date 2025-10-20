import { NextFunction, Request, Response } from 'express'
import * as rolePermissionService from '../../services/dashboard/rolePermission.service'
import { StaffRole } from '@prisma/client'
import { AuthenticationError } from '../../errors/AppError'
import logger from '@/config/logger'

/**
 * Get all role permissions for a venue
 * Returns both custom and default permissions for each role
 */
export async function getAllRolePermissions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    if (!venueId) {
      res.status(400).json({ error: 'venueId is required' })
      return
    }

    const rolePermissions = await rolePermissionService.getAllRolePermissions(venueId)

    res.status(200).json({
      success: true,
      data: rolePermissions,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get permissions for a specific role
 */
export async function getRolePermissions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, role } = req.params

    if (!venueId || !role) {
      res.status(400).json({ error: 'venueId and role are required' })
      return
    }

    // Validate role enum
    if (!Object.values(StaffRole).includes(role as StaffRole)) {
      res.status(400).json({ error: 'Invalid role' })
      return
    }

    const rolePermission = await rolePermissionService.getRolePermissions(venueId, role as StaffRole)

    res.status(200).json({
      success: true,
      data: rolePermission,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Update permissions for a specific role
 * Includes hierarchy and self-lockout validation
 */
export async function updateRolePermissions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, role } = req.params
    const { permissions } = req.body
    const modifiedById = req.authContext?.userId
    const modifierRole = req.authContext?.role

    if (!modifiedById || !modifierRole) {
      throw new AuthenticationError('Authentication context missing')
    }

    if (!venueId || !role) {
      res.status(400).json({ error: 'venueId and role are required' })
      return
    }

    if (!permissions || !Array.isArray(permissions)) {
      res.status(400).json({ error: 'permissions array is required' })
      return
    }

    // Validate role enum
    if (!Object.values(StaffRole).includes(role as StaffRole)) {
      res.status(400).json({ error: 'Invalid role' })
      return
    }

    const result = await rolePermissionService.updateRolePermissions(
      venueId,
      role as StaffRole,
      permissions,
      modifiedById,
      modifierRole as StaffRole,
    )

    logger.info(`Role permissions updated`, {
      venueId,
      role,
      modifiedById,
      modifierRole,
      permissionsCount: permissions.length,
      isCustom: result.isCustom,
    })

    res.status(200).json({
      success: true,
      message: 'Role permissions updated successfully',
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Delete custom permissions for a role (revert to defaults)
 */
export async function deleteRolePermissions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, role } = req.params
    const modifierRole = req.authContext?.role

    if (!modifierRole) {
      throw new AuthenticationError('Authentication context missing')
    }

    if (!venueId || !role) {
      res.status(400).json({ error: 'venueId and role are required' })
      return
    }

    // Validate role enum
    if (!Object.values(StaffRole).includes(role as StaffRole)) {
      res.status(400).json({ error: 'Invalid role' })
      return
    }

    const result = await rolePermissionService.deleteRolePermissions(venueId, role as StaffRole, modifierRole as StaffRole)

    logger.info(`Role permissions deleted (reverted to defaults)`, {
      venueId,
      role,
      modifierRole,
    })

    res.status(200).json({
      success: true,
      message: 'Custom permissions deleted, reverted to defaults',
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get role hierarchy information
 * Returns which roles can modify which other roles, critical permissions, etc.
 */
export async function getRoleHierarchyInfo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const modifierRole = req.authContext?.role

    if (!modifierRole) {
      throw new AuthenticationError('Authentication context missing')
    }

    const hierarchyInfo = rolePermissionService.getRoleHierarchyInfo()
    const modifiableRoles = rolePermissionService.getModifiableRoles(modifierRole as StaffRole)

    res.status(200).json({
      success: true,
      data: {
        ...hierarchyInfo,
        userRole: modifierRole,
        modifiableRoles,
      },
    })
  } catch (error) {
    next(error)
  }
}
