import prisma from '../../utils/prismaClient'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../errors/AppError'
import { StaffRole } from '@prisma/client'
import { DEFAULT_PERMISSIONS, canModifyRole, MODIFIABLE_ROLES_BY_LEVEL, CRITICAL_PERMISSIONS, ROLE_HIERARCHY } from '../../lib/permissions'
import logger from '@/config/logger'

/**
 * Get custom role permissions for a specific role in a venue
 * Returns null if no custom permissions are set (uses defaults)
 */
export async function getRolePermissions(venueId: string, role: StaffRole) {
  const rolePermission = await prisma.venueRolePermission.findUnique({
    where: {
      venueId_role: {
        venueId,
        role,
      },
    },
    include: {
      modifier: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  })

  return rolePermission
}

/**
 * Get all role permissions for a venue
 * Returns both custom and default permissions for each role
 */
export async function getAllRolePermissions(venueId: string) {
  // Verify venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found')
  }

  // Get custom permissions
  const customPermissions = await prisma.venueRolePermission.findMany({
    where: { venueId },
    include: {
      modifier: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  })

  // Build response with all roles
  const roles = Object.values(StaffRole)
  return roles.map(role => {
    const custom = customPermissions.find(cp => cp.role === role)

    return {
      role,
      permissions: custom ? custom.permissions : DEFAULT_PERMISSIONS[role],
      isCustom: !!custom,
      modifiedBy: custom?.modifier || null,
      modifiedAt: custom?.updatedAt || null,
    }
  })
}

/**
 * Update permissions for a specific role in a venue
 * Includes validation for hierarchy and self-lockout protection
 */
export async function updateRolePermissions(
  venueId: string,
  role: StaffRole,
  permissions: string[],
  modifiedById: string,
  modifierRole: StaffRole,
) {
  // 1. Verify venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found')
  }

  // 2. Verify modifier exists
  const modifier = await prisma.staff.findUnique({
    where: { id: modifiedById },
  })

  if (!modifier) {
    throw new NotFoundError('Modifier staff not found')
  }

  // 3. Check hierarchy: can modifier modify target role?
  if (!canModifyRole(modifierRole, role)) {
    throw new ForbiddenError(
      `${modifierRole} cannot modify permissions for ${role}. ` +
        `You can only modify: ${MODIFIABLE_ROLES_BY_LEVEL[modifierRole].join(', ')}`,
    )
  }

  // 4. Self-lockout protection: if modifying own role, ensure critical permissions remain
  if (modifierRole === role) {
    const hasCriticalPermissions = CRITICAL_PERMISSIONS.every(cp => permissions.includes(cp) || permissions.includes('*:*'))

    if (!hasCriticalPermissions) {
      const missingCritical = CRITICAL_PERMISSIONS.filter(cp => !permissions.includes(cp) && !permissions.includes('*:*'))

      throw new BadRequestError(
        `Cannot remove critical permissions from your own role: ${missingCritical.join(', ')}. ` +
          `This would lock you out of the settings.`,
      )
    }
  }

  // 5. Validate permission format
  const invalidPermissions = permissions.filter(p => {
    // Allow wildcard
    if (p === '*:*') return false

    // Check format: "resource:action"
    const parts = p.split(':')
    if (parts.length !== 2) return true
    if (!parts[0] || !parts[1]) return true

    return false
  })

  if (invalidPermissions.length > 0) {
    throw new BadRequestError(`Invalid permission format: ${invalidPermissions.join(', ')}. Expected format: "resource:action"`)
  }

  // 6. Check if reverting to defaults (same as default permissions)
  const defaultPermissions = DEFAULT_PERMISSIONS[role] || []
  const isSameAsDefault = permissions.length === defaultPermissions.length && permissions.every(p => defaultPermissions.includes(p))

  // If same as default, delete custom permissions (revert to defaults)
  if (isSameAsDefault) {
    await prisma.venueRolePermission.deleteMany({
      where: {
        venueId,
        role,
      },
    })

    logger.info(`Reverted ${role} permissions to defaults for venue ${venueId}`, {
      venueId,
      role,
      modifiedById,
    })

    return {
      role,
      permissions: defaultPermissions,
      isCustom: false,
    }
  }

  // 7. Upsert custom permissions
  const rolePermission = await prisma.venueRolePermission.upsert({
    where: {
      venueId_role: {
        venueId,
        role,
      },
    },
    create: {
      venueId,
      role,
      permissions,
      modifiedBy: modifiedById,
    },
    update: {
      permissions,
      modifiedBy: modifiedById,
    },
    include: {
      modifier: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  })

  logger.info(`Updated ${role} permissions for venue ${venueId}`, {
    venueId,
    role,
    permissionsCount: permissions.length,
    modifiedById,
  })

  return {
    role: rolePermission.role,
    permissions: rolePermission.permissions,
    isCustom: true,
    modifiedBy: rolePermission.modifier,
    modifiedAt: rolePermission.updatedAt,
  }
}

/**
 * Delete custom permissions for a role (revert to defaults)
 */
export async function deleteRolePermissions(venueId: string, role: StaffRole, modifierRole: StaffRole) {
  // Check hierarchy
  if (!canModifyRole(modifierRole, role)) {
    throw new ForbiddenError(`${modifierRole} cannot modify permissions for ${role}`)
  }

  // Delete custom permissions
  await prisma.venueRolePermission.deleteMany({
    where: {
      venueId,
      role,
    },
  })

  logger.info(`Deleted custom ${role} permissions for venue ${venueId} (reverted to defaults)`, {
    venueId,
    role,
  })

  return {
    role,
    permissions: DEFAULT_PERMISSIONS[role],
    isCustom: false,
  }
}

/**
 * Get modifiable roles for a user based on their role
 */
export function getModifiableRoles(modifierRole: StaffRole): StaffRole[] {
  return MODIFIABLE_ROLES_BY_LEVEL[modifierRole] || []
}

/**
 * Get role hierarchy information for UI display
 */
export function getRoleHierarchyInfo() {
  return {
    hierarchy: ROLE_HIERARCHY,
    modifiableRoles: MODIFIABLE_ROLES_BY_LEVEL,
    criticalPermissions: CRITICAL_PERMISSIONS,
    defaultPermissions: DEFAULT_PERMISSIONS,
  }
}
