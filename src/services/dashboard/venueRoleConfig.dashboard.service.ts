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
import { getBusinessCategory } from '@/utils/businessCategory'
import { SECTOR_ROLE_DEFAULTS } from '@/utils/roleDisplay'
import { logAction } from './activity-log.service'

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
 * Currently empty — all roles including SUPERADMIN are renameable per venue.
 */
const NON_RENAMEABLE_ROLES: StaffRole[] = []

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
    select: { id: true, type: true },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // 🔴 Los nombres por defecto salen del GIRO, no de una lista fija de restaurante.
  // Sin esto una estetica veia «Mesero» y una tienda tambien. Y NO se puede arreglar en el
  // dashboard: este endpoint devuelve SIEMPRE una fila por rol, asi que el front las trata
  // como personalizacion del venue y ganan sobre cualquier default suyo.
  const sectorNames = sectorRoleDefaults(venue.type)

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
      displayName: sectorNames[role] ?? DEFAULT_ROLE_DISPLAY_NAMES[role],
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

  logAction({
    venueId,
    action: 'ROLE_CONFIGS_UPDATED',
    entity: 'VenueRoleConfig',
    entityId: venueId,
  })

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
 * Get display names for (venueId, role) pairs spanning many venues (batch)
 *
 * Used by login responses, where one staff member belongs to many venues:
 * one findMany instead of one findUnique per venue.
 *
 * @param pairs - Array of { venueId, role }
 * @returns Map keyed by `${venueId}:${role}` → display name
 */
export async function getRoleDisplayNamesForVenues(pairs: { venueId: string; role: StaffRole }[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (pairs.length === 0) return result

  for (const { venueId, role } of pairs) {
    result.set(`${venueId}:${role}`, DEFAULT_ROLE_DISPLAY_NAMES[role])
  }

  const configs = await prisma.venueRoleConfig.findMany({
    where: { OR: pairs.map(p => ({ venueId: p.venueId, role: p.role })) },
    select: { venueId: true, role: true, displayName: true },
  })

  for (const config of configs) {
    result.set(`${config.venueId}:${config.role}`, config.displayName)
  }

  return result
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

  logAction({
    venueId,
    action: 'ROLE_CONFIG_RESET',
    entity: 'VenueRoleConfig',
    entityId: venueId,
    data: { role },
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

  logAction({
    venueId,
    action: 'ALL_ROLE_CONFIGS_RESET',
    entity: 'VenueRoleConfig',
    entityId: venueId,
  })
}

/**
 * Nombres de rol por defecto para el giro de un venue.
 *
 * 🔴 `Venue.type` es un `VenueType`, que NO es el mismo enum que `BusinessType`:
 * TELECOMUNICACIONES, HOTEL_RESTAURANT y FITNESS_STUDIO existen solo en el primero y hacen
 * fallar a `getBusinessCategory`. Por eso se traducen antes, y todo va dentro de un try:
 * un giro desconocido debe degradar al default generico, nunca tumbar la consulta.
 */
function sectorRoleDefaults(venueType: string | null | undefined): Partial<Record<StaffRole, string>> {
  if (!venueType) return {}
  const equivalencias: Record<string, string> = {
    HOTEL_RESTAURANT: 'RESTAURANT',
    FITNESS_STUDIO: 'FITNESS',
    TELECOMUNICACIONES: 'RETAIL_STORE',
  }
  const tipo = equivalencias[venueType] ?? venueType
  try {
    return SECTOR_ROLE_DEFAULTS[getBusinessCategory(tipo as never)]?.es ?? {}
  } catch {
    return {}
  }
}
