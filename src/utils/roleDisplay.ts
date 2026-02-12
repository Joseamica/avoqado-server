/**
 * Role Display Utility
 *
 * WHY: Quick synchronous access to role display names without database calls.
 *
 * PATTERN: Use this utility when you already have role configs loaded
 * (e.g., from API response, cached data, or fetched earlier in the request).
 *
 * For async database lookups, use the service:
 * - venueRoleConfigService.getRoleDisplayName(venueId, role)
 * - venueRoleConfigService.getRoleDisplayNames(venueId, roles)
 *
 * Example usage:
 * ```typescript
 * // In API response transformer
 * const displayName = getRoleDisplayName(StaffRole.CASHIER, venueRoleConfigs)
 * // Returns "Promotor" if custom, or "Cajero" if default
 * ```
 */

import { StaffRole, BusinessType } from '@prisma/client'

import { RoleConfigResponse } from '@/schemas/dashboard/venueRoleConfig.schema'
import { getBusinessCategory, type BusinessCategory } from '@/utils/businessCategory'

/**
 * Default display names for each role (Spanish)
 *
 * Used when no custom config is available.
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
 * Default English display names (for reference/fallback)
 */
export const DEFAULT_ROLE_DISPLAY_NAMES_EN: Record<StaffRole, string> = {
  [StaffRole.SUPERADMIN]: 'Super Admin',
  [StaffRole.OWNER]: 'Owner',
  [StaffRole.ADMIN]: 'Administrator',
  [StaffRole.MANAGER]: 'Manager',
  [StaffRole.CASHIER]: 'Cashier',
  [StaffRole.WAITER]: 'Waiter',
  [StaffRole.KITCHEN]: 'Kitchen',
  [StaffRole.HOST]: 'Host',
  [StaffRole.VIEWER]: 'Viewer',
}

/**
 * Sector-aware role display name defaults.
 * Only includes roles that differ from the generic defaults.
 */
export const SECTOR_ROLE_DEFAULTS: Record<BusinessCategory, Record<'es' | 'en', Partial<Record<StaffRole, string>>>> = {
  FOOD_SERVICE: {
    es: {}, // Uses generic defaults
    en: {},
  },
  RETAIL: {
    es: {
      [StaffRole.WAITER]: 'Vendedor',
      [StaffRole.KITCHEN]: 'Almacen',
      [StaffRole.HOST]: 'Recepcionista',
    },
    en: {
      [StaffRole.WAITER]: 'Sales Associate',
      [StaffRole.KITCHEN]: 'Warehouse',
      [StaffRole.HOST]: 'Receptionist',
    },
  },
  SERVICES: {
    es: {
      [StaffRole.WAITER]: 'Especialista',
      [StaffRole.CASHIER]: 'Recepcionista',
      [StaffRole.KITCHEN]: 'Area de Servicio',
      [StaffRole.HOST]: 'Recepcionista',
    },
    en: {
      [StaffRole.WAITER]: 'Specialist',
      [StaffRole.CASHIER]: 'Receptionist',
      [StaffRole.KITCHEN]: 'Service Area',
      [StaffRole.HOST]: 'Receptionist',
    },
  },
  HOSPITALITY: {
    es: {
      [StaffRole.WAITER]: 'Concierge',
      [StaffRole.CASHIER]: 'Recepcionista',
      [StaffRole.KITCHEN]: 'Servicio a Cuartos',
      [StaffRole.HOST]: 'Recepcionista',
    },
    en: {
      [StaffRole.WAITER]: 'Concierge',
      [StaffRole.CASHIER]: 'Receptionist',
      [StaffRole.KITCHEN]: 'Room Service',
      [StaffRole.HOST]: 'Receptionist',
    },
  },
  ENTERTAINMENT: {
    es: {
      [StaffRole.WAITER]: 'Staff',
      [StaffRole.CASHIER]: 'Taquillero',
      [StaffRole.KITCHEN]: 'Backstage',
      [StaffRole.HOST]: 'Recepcionista',
    },
    en: {
      [StaffRole.WAITER]: 'Staff',
      [StaffRole.CASHIER]: 'Ticket Agent',
      [StaffRole.KITCHEN]: 'Backstage',
      [StaffRole.HOST]: 'Receptionist',
    },
  },
  OTHER: {
    es: {
      [StaffRole.WAITER]: 'Asistente',
      [StaffRole.KITCHEN]: 'Almacen',
      [StaffRole.HOST]: 'Recepcionista',
    },
    en: {
      [StaffRole.WAITER]: 'Assistant',
      [StaffRole.KITCHEN]: 'Storage',
      [StaffRole.HOST]: 'Receptionist',
    },
  },
}

/**
 * Get display name for a role (synchronous)
 *
 * Resolution: VenueRoleConfig > sector default for locale > generic Spanish default
 *
 * @param role - StaffRole enum value
 * @param configs - Optional array of venue role configs
 * @param options - Optional sector-aware options
 * @returns Display name (custom or default)
 *
 * @example
 * ```typescript
 * // Basic usage (backward-compatible)
 * const displayName = getRoleDisplayName(StaffRole.CASHIER, venueConfigs)
 *
 * // Sector-aware usage
 * const displayName = getRoleDisplayName(StaffRole.WAITER, venueConfigs, {
 *   businessType: BusinessType.RETAIL_STORE,
 *   locale: 'es',
 * })
 * ```
 */
export function getRoleDisplayName(
  role: StaffRole,
  configs?: RoleConfigResponse[] | null,
  options?: { businessType?: BusinessType; locale?: 'es' | 'en' },
): string {
  // Priority 1: VenueRoleConfig override
  if (configs && configs.length > 0) {
    const config = configs.find(c => c.role === role)
    if (config?.displayName) {
      return config.displayName
    }
  }

  // Priority 2: Sector default for locale
  if (options?.businessType) {
    const category = getBusinessCategory(options.businessType)
    const locale = options.locale || 'es'
    const sectorDefaults = SECTOR_ROLE_DEFAULTS[category]?.[locale]
    if (sectorDefaults?.[role]) {
      return sectorDefaults[role]!
    }
  }

  // Priority 3: Locale-aware generic default
  if (options?.locale === 'en') {
    return DEFAULT_ROLE_DISPLAY_NAMES_EN[role] || role
  }

  // Priority 4: Generic Spanish default
  return DEFAULT_ROLE_DISPLAY_NAMES[role] || role
}

/**
 * Get display names for multiple roles (synchronous)
 *
 * More efficient than calling getRoleDisplayName multiple times.
 *
 * @param roles - Array of StaffRole values
 * @param configs - Optional array of venue role configs
 * @returns Map of role → display name
 */
export function getRoleDisplayNames(roles: StaffRole[], configs?: RoleConfigResponse[] | null): Map<StaffRole, string> {
  const result = new Map<StaffRole, string>()

  // Create config lookup map
  const configMap = new Map<StaffRole, string>()
  if (configs) {
    for (const config of configs) {
      if (config.displayName) {
        configMap.set(config.role, config.displayName)
      }
    }
  }

  // Build result with custom or default names
  for (const role of roles) {
    result.set(role, configMap.get(role) || DEFAULT_ROLE_DISPLAY_NAMES[role] || role)
  }

  return result
}

/**
 * Get color for a role (from config or null)
 *
 * @param role - StaffRole enum value
 * @param configs - Optional array of venue role configs
 * @returns Hex color string or null
 */
export function getRoleColor(role: StaffRole, configs?: RoleConfigResponse[] | null): string | null {
  if (configs && configs.length > 0) {
    const config = configs.find(c => c.role === role)
    return config?.color || null
  }
  return null
}

/**
 * Get icon for a role (from config or null)
 *
 * @param role - StaffRole enum value
 * @param configs - Optional array of venue role configs
 * @returns Icon name string or null
 */
export function getRoleIcon(role: StaffRole, configs?: RoleConfigResponse[] | null): string | null {
  if (configs && configs.length > 0) {
    const config = configs.find(c => c.role === role)
    return config?.icon || null
  }
  return null
}

/**
 * Check if a role is active for a venue
 *
 * Inactive roles can be hidden from UI (e.g., KITCHEN for events business).
 *
 * @param role - StaffRole enum value
 * @param configs - Optional array of venue role configs
 * @returns true if role is active (default: true)
 */
export function isRoleActive(role: StaffRole, configs?: RoleConfigResponse[] | null): boolean {
  if (configs && configs.length > 0) {
    const config = configs.find(c => c.role === role)
    return config?.isActive ?? true
  }
  return true // All roles active by default
}

/**
 * Get active roles for a venue
 *
 * Filters out roles marked as inactive in configs.
 *
 * @param configs - Optional array of venue role configs
 * @returns Array of active StaffRole values
 */
export function getActiveRoles(configs?: RoleConfigResponse[] | null): StaffRole[] {
  const allRoles = Object.values(StaffRole) as StaffRole[]

  if (!configs || configs.length === 0) {
    return allRoles // All roles active by default
  }

  return allRoles.filter(role => {
    const config = configs.find(c => c.role === role)
    return config?.isActive ?? true
  })
}
