import { PrismaClient, Module, VenueModule, OrganizationModule, Prisma } from '@prisma/client'
import Ajv from 'ajv'
import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

// ==========================================
// MODULE CODES
// Define all available modules in the system.
// Add new modules here as constants.
// ==========================================
export const MODULE_CODES = {
  SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY',
  ATTENDANCE_TRACKING: 'ATTENDANCE_TRACKING',
  WHITE_LABEL_DASHBOARD: 'WHITE_LABEL_DASHBOARD',
} as const

export type ModuleCode = (typeof MODULE_CODES)[keyof typeof MODULE_CODES]

// ==========================================
// MODULE INHERITANCE
// ==========================================
// Modules can be enabled at two levels:
// 1. Organization level (OrganizationModule) - applies to ALL venues in the org
// 2. Venue level (VenueModule) - specific to ONE venue
//
// Resolution order:
// 1. Check VenueModule first (explicit venue-level setting wins)
// 2. If no VenueModule, fallback to OrganizationModule (inherited)
//
// Config merging:
// - Module.defaultConfig (base)
// - OrganizationModule.config (org customization, if org-level)
// - VenueModule.config (venue override, if venue-level)
// ==========================================

// ==========================================
// MODULE SERVICE
// Manages module enablement and configuration per venue.
// USE THIS instead of conditional checks by venue/industry.
// ==========================================
export class ModuleService {
  private readonly ajv: any

  constructor(private db: PrismaClient = prisma) {
    this.ajv = new Ajv({ allErrors: true })
  }

  /**
   * Verifies if a module is enabled for a venue.
   * USE THIS METHOD instead of conditionals by venue/industry.
   *
   * Resolution order:
   * 1. Check VenueModule (venue-level override)
   * 2. If no VenueModule, check OrganizationModule (inherited from org)
   *
   * @example
   * const isEnabled = await moduleService.isModuleEnabled(venueId, 'SERIALIZED_INVENTORY');
   * if (isEnabled) {
   *   // Module functionality
   * }
   */
  async isModuleEnabled(venueId: string, moduleCode: ModuleCode): Promise<boolean> {
    // First check if VenueModule EXISTS (regardless of enabled state)
    // This allows venues to explicitly override/disable inherited modules
    const venueModule = await this.db.venueModule.findFirst({
      where: {
        venueId,
        module: {
          code: moduleCode,
          active: true, // Module must be globally active
        },
      },
    })

    // If VenueModule exists, IT is the source of truth (explicit override)
    if (venueModule) return venueModule.enabled

    // Fallback: check organization-level (inherited) only if NO VenueModule exists
    const venue = await this.db.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    if (!venue) return false

    const orgModule = await this.db.organizationModule.findFirst({
      where: {
        organizationId: venue.organizationId,
        enabled: true,
        module: {
          code: moduleCode,
          active: true,
        },
      },
    })

    return !!orgModule
  }

  /**
   * Gets the merged configuration of a module for a venue.
   * Merges configs in priority order:
   * 1. Module.defaultConfig (base)
   * 2. OrganizationModule.config (org-level customization)
   * 3. VenueModule.config (venue-level override)
   *
   * @returns null if module is not enabled at any level
   * @example
   * const config = await moduleService.getModuleConfig(venueId, 'SERIALIZED_INVENTORY');
   * const itemLabel = config?.labels?.item; // "SIM" or "Piedra" or "Producto"
   */
  async getModuleConfig<T = Record<string, unknown>>(venueId: string, moduleCode: ModuleCode): Promise<T | null> {
    // Get the module definition first
    const module = await this.db.module.findFirst({
      where: {
        code: moduleCode,
        active: true,
      },
    })

    if (!module) return null

    // Get venue with org info
    const venue = await this.db.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    if (!venue) return null

    // Check venue-level first (highest priority)
    const venueModule = await this.db.venueModule.findFirst({
      where: {
        venueId,
        moduleId: module.id,
        enabled: true,
      },
    })

    // Check org-level (inherited)
    const orgModule = await this.db.organizationModule.findFirst({
      where: {
        organizationId: venue.organizationId,
        moduleId: module.id,
        enabled: true,
      },
    })

    // If neither level has the module enabled, return null
    if (!venueModule && !orgModule) return null

    // Merge configs: defaultConfig -> orgConfig -> venueConfig
    let config = module.defaultConfig as Record<string, unknown>

    if (orgModule?.config) {
      config = this.deepMerge(config, orgModule.config as Record<string, unknown>)
    }

    if (venueModule?.config) {
      config = this.deepMerge(config, venueModule.config as Record<string, unknown>)
    }

    return config as T
  }

  /**
   * Gets all enabled modules for a venue (venue-level + org-level inherited).
   * Useful for TPV at login time.
   *
   * Returns merged configs with venue-level overriding org-level.
   *
   * @example
   * const modules = await moduleService.getEnabledModules(venueId);
   * // modules: [{ code: 'SERIALIZED_INVENTORY', config: { labels: { item: 'SIM' } }, source: 'organization' }]
   */
  async getEnabledModules(
    venueId: string,
  ): Promise<Array<{ code: string; config: Record<string, unknown>; source: 'venue' | 'organization' }>> {
    // Get venue with org info
    const venue = await this.db.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    if (!venue) return []

    // Get venue-level modules
    const venueModules = await this.db.venueModule.findMany({
      where: {
        venueId,
        enabled: true,
        module: { active: true },
      },
      include: { module: true },
    })

    // Get org-level modules
    const orgModules = await this.db.organizationModule.findMany({
      where: {
        organizationId: venue.organizationId,
        enabled: true,
        module: { active: true },
      },
      include: { module: true },
    })

    // Collect modules, venue-level takes priority
    const moduleMap = new Map<string, { code: string; config: Record<string, unknown>; source: 'venue' | 'organization' }>()

    // First add org-level modules
    for (const om of orgModules) {
      const config = this.deepMerge(om.module.defaultConfig as Record<string, unknown>, (om.config as Record<string, unknown>) || {})
      moduleMap.set(om.module.code, { code: om.module.code, config, source: 'organization' })
    }

    // Then override with venue-level (if exists)
    for (const vm of venueModules) {
      const baseConfig = moduleMap.get(vm.module.code)?.config || (vm.module.defaultConfig as Record<string, unknown>)
      const config = this.deepMerge(baseConfig, (vm.config as Record<string, unknown>) || {})
      moduleMap.set(vm.module.code, { code: vm.module.code, config, source: 'venue' })
    }

    return Array.from(moduleMap.values())
  }

  /**
   * Gets all enabled module codes for a venue (venue-level + org-level inherited).
   * Useful for quick checks.
   *
   * @example
   * const codes = await moduleService.getEnabledModuleCodes(venueId);
   * if (codes.includes('SERIALIZED_INVENTORY')) { ... }
   */
  async getEnabledModuleCodes(venueId: string): Promise<string[]> {
    // Get venue with org info
    const venue = await this.db.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    if (!venue) return []

    // Get venue-level module codes
    const venueModules = await this.db.venueModule.findMany({
      where: {
        venueId,
        enabled: true,
        module: { active: true },
      },
      include: { module: { select: { code: true } } },
    })

    // Get org-level module codes
    const orgModules = await this.db.organizationModule.findMany({
      where: {
        organizationId: venue.organizationId,
        enabled: true,
        module: { active: true },
      },
      include: { module: { select: { code: true } } },
    })

    // Combine and deduplicate
    const codes = new Set<string>()
    orgModules.forEach(om => codes.add(om.module.code))
    venueModules.forEach(vm => codes.add(vm.module.code))

    return Array.from(codes)
  }

  /**
   * Enables a module for a venue (Superadmin).
   *
   * @param venueId - Venue ID
   * @param moduleCode - Module code to enable
   * @param enabledBy - Staff ID enabling the module
   * @param config - Custom configuration (optional)
   * @param preset - Industry preset name (optional, e.g., 'telecom', 'jewelry')
   */
  async enableModule(
    venueId: string,
    moduleCode: ModuleCode,
    enabledBy: string,
    config?: Record<string, unknown>,
    preset?: string,
  ): Promise<VenueModule> {
    const module = await this.db.module.findUnique({
      where: { code: moduleCode },
    })

    if (!module) throw new Error(`Module ${moduleCode} not found`)

    // If preset specified, use preset configuration
    let finalConfig: Prisma.InputJsonValue | undefined = config as Prisma.InputJsonValue | undefined
    if (preset && module.presets) {
      const presets = module.presets as Record<string, Prisma.InputJsonValue>
      if (!(preset in presets)) {
        throw new BadRequestError(`Preset ${preset} not found for module ${moduleCode}`)
      }
      finalConfig = presets[preset]
    }

    this.validateModuleConfig(module, finalConfig)

    return this.db.venueModule.upsert({
      where: { venueId_moduleId: { venueId, moduleId: module.id } },
      create: {
        venueId,
        moduleId: module.id,
        enabled: true,
        config: finalConfig ?? Prisma.JsonNull,
        enabledBy,
      },
      update: {
        enabled: true,
        config: finalConfig ?? Prisma.JsonNull,
      },
    })
  }

  /**
   * Disables a module for a venue.
   */
  async disableModule(venueId: string, moduleCode: ModuleCode): Promise<VenueModule | null> {
    const module = await this.db.module.findUnique({
      where: { code: moduleCode },
    })

    if (!module) return null

    const venueModule = await this.db.venueModule.findUnique({
      where: { venueId_moduleId: { venueId, moduleId: module.id } },
    })

    if (!venueModule) return null

    return this.db.venueModule.update({
      where: { id: venueModule.id },
      data: { enabled: false },
    })
  }

  /**
   * Updates module configuration for a venue.
   */
  async updateModuleConfig(venueId: string, moduleCode: ModuleCode, config: Record<string, unknown>): Promise<VenueModule | null> {
    const module = await this.db.module.findUnique({
      where: { code: moduleCode },
    })

    if (!module) return null

    const venueModule = await this.db.venueModule.findUnique({
      where: { venueId_moduleId: { venueId, moduleId: module.id } },
    })

    if (!venueModule) return null

    this.validateModuleConfig(module, config as Prisma.InputJsonValue)

    return this.db.venueModule.update({
      where: { id: venueModule.id },
      data: { config: config as Prisma.InputJsonValue },
    })
  }

  /**
   * Gets all available modules (for Superadmin).
   */
  async getAllModules(): Promise<Module[]> {
    return this.db.module.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    })
  }

  /**
   * Creates a new module definition (Superadmin setup).
   */
  async createModule(data: {
    code: string
    name: string
    description?: string
    defaultConfig: Record<string, unknown>
    presets?: Record<string, unknown>
    configSchema?: Record<string, unknown>
  }): Promise<Module> {
    return this.db.module.create({
      data: {
        code: data.code,
        name: data.name,
        description: data.description,
        defaultConfig: data.defaultConfig as Prisma.InputJsonValue,
        presets: data.presets as Prisma.InputJsonValue | undefined,
        configSchema: data.configSchema as Prisma.InputJsonValue | undefined,
      },
    })
  }

  // ==========================================
  // ORGANIZATION-LEVEL MODULE MANAGEMENT
  // ==========================================

  /**
   * Enables a module for ALL venues in an organization.
   * This is inherited by all venues in the org.
   *
   * @param organizationId - Organization ID
   * @param moduleCode - Module code to enable
   * @param enabledBy - Staff ID enabling the module
   * @param config - Custom configuration (optional)
   * @param preset - Industry preset name (optional, e.g., 'telecom', 'jewelry')
   */
  async enableModuleForOrganization(
    organizationId: string,
    moduleCode: ModuleCode,
    enabledBy: string,
    config?: Record<string, unknown>,
    preset?: string,
  ): Promise<OrganizationModule> {
    const module = await this.db.module.findUnique({
      where: { code: moduleCode },
    })

    if (!module) throw new Error(`Module ${moduleCode} not found`)

    // If preset specified, use preset configuration
    let finalConfig: Prisma.InputJsonValue | undefined = config as Prisma.InputJsonValue | undefined
    if (preset && module.presets) {
      const presets = module.presets as Record<string, Prisma.InputJsonValue>
      if (!(preset in presets)) {
        throw new BadRequestError(`Preset ${preset} not found for module ${moduleCode}`)
      }
      finalConfig = presets[preset]
    }

    this.validateModuleConfig(module, finalConfig)

    return this.db.organizationModule.upsert({
      where: { organizationId_moduleId: { organizationId, moduleId: module.id } },
      create: {
        organizationId,
        moduleId: module.id,
        enabled: true,
        config: finalConfig ?? Prisma.JsonNull,
        enabledBy,
      },
      update: {
        enabled: true,
        config: finalConfig ?? Prisma.JsonNull,
      },
    })
  }

  /**
   * Disables a module for an organization.
   * Note: This removes inheritance. Venues with explicit VenueModule will still have access.
   */
  async disableModuleForOrganization(organizationId: string, moduleCode: ModuleCode): Promise<OrganizationModule | null> {
    const module = await this.db.module.findUnique({
      where: { code: moduleCode },
    })

    if (!module) return null

    const orgModule = await this.db.organizationModule.findUnique({
      where: { organizationId_moduleId: { organizationId, moduleId: module.id } },
    })

    if (!orgModule) return null

    return this.db.organizationModule.update({
      where: { id: orgModule.id },
      data: { enabled: false },
    })
  }

  /**
   * Updates module configuration for an organization.
   * This affects all venues that inherit from org (don't have venue-level override).
   */
  async updateOrganizationModuleConfig(
    organizationId: string,
    moduleCode: ModuleCode,
    config: Record<string, unknown>,
  ): Promise<OrganizationModule | null> {
    const module = await this.db.module.findUnique({
      where: { code: moduleCode },
    })

    if (!module) return null

    const orgModule = await this.db.organizationModule.findUnique({
      where: { organizationId_moduleId: { organizationId, moduleId: module.id } },
    })

    if (!orgModule) return null

    this.validateModuleConfig(module, config as Prisma.InputJsonValue)

    return this.db.organizationModule.update({
      where: { id: orgModule.id },
      data: { config: config as Prisma.InputJsonValue },
    })
  }

  /**
   * Gets all modules enabled at organization level.
   */
  async getOrganizationModules(
    organizationId: string,
  ): Promise<Array<{ code: string; config: Record<string, unknown>; enabled: boolean }>> {
    const orgModules = await this.db.organizationModule.findMany({
      where: {
        organizationId,
        module: { active: true },
      },
      include: { module: true },
    })

    return orgModules.map(om => ({
      code: om.module.code,
      config: this.deepMerge(om.module.defaultConfig as Record<string, unknown>, (om.config as Record<string, unknown>) || {}),
      enabled: om.enabled,
    }))
  }

  /**
   * Checks if a module is enabled at organization level.
   */
  async isModuleEnabledForOrganization(organizationId: string, moduleCode: ModuleCode): Promise<boolean> {
    const orgModule = await this.db.organizationModule.findFirst({
      where: {
        organizationId,
        enabled: true,
        module: {
          code: moduleCode,
          active: true,
        },
      },
    })
    return !!orgModule
  }

  /**
   * Deep merge utility for configuration objects.
   */
  private validateModuleConfig(module: Module, config?: Prisma.InputJsonValue): void {
    if (config === undefined || (config as unknown) === (Prisma.JsonNull as unknown) || !module.configSchema) {
      return
    }

    if (typeof module.configSchema !== 'object' || module.configSchema === null || Array.isArray(module.configSchema)) {
      throw new BadRequestError(`Invalid config schema for module ${module.code}`)
    }

    try {
      const validator = this.ajv.compile(module.configSchema as Record<string, unknown>)
      const isValid = validator(config as unknown)

      if (!isValid) {
        throw new BadRequestError(this.formatConfigErrors(module.code, validator.errors ?? []))
      }
    } catch (error) {
      if (error instanceof BadRequestError) {
        throw error
      }
      throw new BadRequestError(`Could not validate config for module ${module.code}`)
    }
  }

  private formatConfigErrors(moduleCode: string, errors: Array<{ dataPath?: string; message?: string }>): string {
    const details = errors
      .slice(0, 5)
      .map(error => `${error.dataPath || '/'} ${error.message || 'invalid'}`)
      .join('; ')

    return `Invalid config for module ${moduleCode}: ${details}`
  }

  private deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target }
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge((result[key] as Record<string, unknown>) || {}, source[key] as Record<string, unknown>)
      } else {
        result[key] = source[key]
      }
    }
    return result
  }
}

// Export singleton instance
export const moduleService = new ModuleService()
