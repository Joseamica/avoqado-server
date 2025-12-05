/**
 * Venue Role Config Service (HTTP-Agnostic Business Logic)
 *
 * WHY: Allows venues to customize role display names while keeping
 * the internal StaffRole enum for type safety.
 *
 * PATTERN: Thin Controller + Fat Service Architecture
 * - This service contains ALL business logic
 * - Controllers only orchestrate HTTP (extract params, call service, return response)
 * - Services know NOTHING about Express (req, res, next)
 *
 * Example: Events/concerts business wants "CASHIER" → "Promotor"
 *
 * World-class pattern (Salesforce, Toast, Square):
 * - Internal: StaffRole.CASHIER (enum - type-safe)
 * - Display: "Promotor" (per-venue customizable)
 */

import { StaffRole, VenueRoleConfig } from '@prisma/client'

import logger from '@/config/logger'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { RoleConfigItem, RoleConfigResponse } from '@/schemas/dashboard/venueRoleConfig.schema'
import prisma from '@/utils/prismaClient'

/**
 * Default display names for each role (Spanish)
 *
 * These are used when a venue hasn't customized their role display names.
 */
export const DEFAULT_ROLE_DISPLAY_NAMES: Record<StaffRole, string> = {
  [StaffRole.SUPERADMIN]: 'Super Administrador',
  [StaffRole.OWNER]: 'Propietario',
  [StaffRole.ADMIN]: 'Administrador',
  [StaffRole.MANAGER]: 'Gerente',
  [StaffRole.CASHIER]: 'Cajero',
  [StaffRole.WAITER]: 'Mesero',
  [StaffRole.KITCHEN]: 'Cocina',
  [StaffRole.HOST]: 'Host',
  [StaffRole.VIEWER]: 'Observador',
}

/**
 * Default sort order for roles (for UI display)
 */
const DEFAULT_ROLE_SORT_ORDER: Record<StaffRole, number> = {
  [StaffRole.SUPERADMIN]: 0,
  [StaffRole.OWNER]: 1,
  [StaffRole.ADMIN]: 2,
  [StaffRole.MANAGER]: 3,
  [StaffRole.CASHIER]: 4,
  [StaffRole.WAITER]: 5,
  [StaffRole.KITCHEN]: 6,
  [StaffRole.HOST]: 7,
  [StaffRole.VIEWER]: 8,
}

/**
 * Roles that cannot be renamed (system roles)
 * SUPERADMIN should always show as SUPERADMIN for consistency
 */
const NON_RENAMEABLE_ROLES: StaffRole[] = [StaffRole.SUPERADMIN]

/**
 * Get all role configs for a venue (with defaults for unconfigured roles)
 *
 * Returns ALL roles, using:
 * - Custom config if venue has configured it
 * - Default values if not configured
 *
 * @param venueId - Venue ID to get configs for
 * @returns Array of role configs for all roles
 */
export async function getVenueRoleConfigs(venueId: string): Promise<RoleConfigResponse[]> {
  // Verify venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Get all custom configs for this venue
  const customConfigs = await prisma.venueRoleConfig.findMany({
    where: { venueId },
  })

  // Create a map for quick lookup
  const configMap = new Map<StaffRole, VenueRoleConfig>()
  for (const config of customConfigs) {
    configMap.set(config.role, config)
  }

  // Build response with all roles (custom or default)
  const allRoles = Object.values(StaffRole) as StaffRole[]
  const configs: RoleConfigResponse[] = allRoles.map(role => {
    const customConfig = configMap.get(role)

    if (customConfig) {
      return {
        role: customConfig.role,
        displayName: customConfig.displayName,
        description: customConfig.description,
        icon: customConfig.icon,
        color: customConfig.color,
        isActive: customConfig.isActive,
        sortOrder: customConfig.sortOrder,
      }
    }

    // Return defaults for unconfigured roles
    return {
      role,
      displayName: DEFAULT_ROLE_DISPLAY_NAMES[role],
      description: null,
      icon: null,
      color: null,
      isActive: true,
      sortOrder: DEFAULT_ROLE_SORT_ORDER[role],
    }
  })

  // Sort by sortOrder
  configs.sort((a, b) => a.sortOrder - b.sortOrder)

  return configs
}

/**
 * Update role configs for a venue (bulk upsert)
 *
 * Creates new configs or updates existing ones.
 * Non-renameable roles (SUPERADMIN) are skipped with a warning.
 *
 * @param venueId - Venue ID to update configs for
 * @param configs - Array of role configs to upsert
 * @returns Updated role configs
 */
export async function updateVenueRoleConfigs(venueId: string, configs: RoleConfigItem[]): Promise<RoleConfigResponse[]> {
  // Verify venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { id: true },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Filter out non-renameable roles
  const renameable = configs.filter(config => {
    if (NON_RENAMEABLE_ROLES.includes(config.role as StaffRole)) {
      // Log warning but don't fail
      logger.warn(`Attempted to rename non-renameable role: ${config.role}`)
      return false
    }
    return true
  })

  if (renameable.length === 0) {
    throw new BadRequestError('No valid role configs to update. SUPERADMIN cannot be renamed.')
  }

  // Perform bulk upsert
  await prisma.$transaction(
    renameable.map(config =>
      prisma.venueRoleConfig.upsert({
        where: {
          venueId_role: {
            venueId,
            role: config.role as StaffRole,
          },
        },
        create: {
          venueId,
          role: config.role as StaffRole,
          displayName: config.displayName,
          description: config.description ?? null,
          icon: config.icon ?? null,
          color: config.color ?? null,
          isActive: config.isActive ?? true,
          sortOrder: config.sortOrder ?? DEFAULT_ROLE_SORT_ORDER[config.role as StaffRole],
        },
        update: {
          displayName: config.displayName,
          description: config.description ?? undefined,
          icon: config.icon ?? undefined,
          color: config.color ?? undefined,
          isActive: config.isActive ?? undefined,
          sortOrder: config.sortOrder ?? undefined,
        },
      }),
    ),
  )

  // Return updated configs
  return getVenueRoleConfigs(venueId)
}

/**
 * Get display name for a specific role at a venue
 *
 * Useful for rendering in emails, UI, etc.
 *
 * @param venueId - Venue ID
 * @param role - StaffRole enum value
 * @returns Custom display name or default
 */
export async function getRoleDisplayName(venueId: string, role: StaffRole): Promise<string> {
  const config = await prisma.venueRoleConfig.findUnique({
    where: {
      venueId_role: {
        venueId,
        role,
      },
    },
    select: { displayName: true },
  })

  return config?.displayName ?? DEFAULT_ROLE_DISPLAY_NAMES[role]
}

/**
 * Get display names for multiple roles at a venue (batch)
 *
 * More efficient than calling getRoleDisplayName multiple times.
 *
 * @param venueId - Venue ID
 * @param roles - Array of StaffRole values
 * @returns Map of role → display name
 */
export async function getRoleDisplayNames(venueId: string, roles: StaffRole[]): Promise<Map<StaffRole, string>> {
  const configs = await prisma.venueRoleConfig.findMany({
    where: {
      venueId,
      role: { in: roles },
    },
    select: { role: true, displayName: true },
  })

  const result = new Map<StaffRole, string>()

  // First, set all defaults
  for (const role of roles) {
    result.set(role, DEFAULT_ROLE_DISPLAY_NAMES[role])
  }

  // Override with custom configs
  for (const config of configs) {
    result.set(config.role, config.displayName)
  }

  return result
}

/**
 * Reset a specific role config to defaults (delete custom config)
 *
 * @param venueId - Venue ID
 * @param role - Role to reset
 */
export async function resetRoleConfig(venueId: string, role: StaffRole): Promise<void> {
  await prisma.venueRoleConfig.deleteMany({
    where: {
      venueId,
      role,
    },
  })
}

/**
 * Reset ALL role configs for a venue to defaults
 *
 * @param venueId - Venue ID
 */
export async function resetAllRoleConfigs(venueId: string): Promise<void> {
  await prisma.venueRoleConfig.deleteMany({
    where: { venueId },
  })
}
