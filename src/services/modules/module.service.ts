import { PrismaClient, Module, VenueModule, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'

// ==========================================
// MODULE CODES
// Define all available modules in the system.
// Add new modules here as constants.
// ==========================================
export const MODULE_CODES = {
  SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY',
  ATTENDANCE_TRACKING: 'ATTENDANCE_TRACKING',
  // Add more modules here as needed
} as const

export type ModuleCode = (typeof MODULE_CODES)[keyof typeof MODULE_CODES]

// ==========================================
// MODULE SERVICE
// Manages module enablement and configuration per venue.
// USE THIS instead of conditional checks by venue/industry.
// ==========================================
export class ModuleService {
  constructor(private db: PrismaClient = prisma) {}

  /**
   * Verifies if a module is enabled for a venue.
   * USE THIS METHOD instead of conditionals by venue/industry.
   *
   * @example
   * const isEnabled = await moduleService.isModuleEnabled(venueId, 'SERIALIZED_INVENTORY');
   * if (isEnabled) {
   *   // Module functionality
   * }
   */
  async isModuleEnabled(venueId: string, moduleCode: ModuleCode): Promise<boolean> {
    const venueModule = await this.db.venueModule.findFirst({
      where: {
        venueId,
        enabled: true,
        module: {
          code: moduleCode,
          active: true, // Module must be globally active
        },
      },
    })
    return !!venueModule
  }

  /**
   * Gets the merged configuration of a module for a venue.
   * Merges Module.defaultConfig with VenueModule.config (custom overrides).
   *
   * @returns null if module is not enabled
   * @example
   * const config = await moduleService.getModuleConfig(venueId, 'SERIALIZED_INVENTORY');
   * const itemLabel = config?.labels?.item; // "SIM" or "Piedra" or "Producto"
   */
  async getModuleConfig<T = Record<string, unknown>>(venueId: string, moduleCode: ModuleCode): Promise<T | null> {
    const venueModule = await this.db.venueModule.findFirst({
      where: {
        venueId,
        enabled: true,
        module: {
          code: moduleCode,
          active: true, // Module must be globally active
        },
      },
      include: { module: true },
    })

    if (!venueModule) return null

    // Merge defaultConfig with custom config
    const defaultConfig = venueModule.module.defaultConfig as Record<string, unknown>
    const customConfig = (venueModule.config as Record<string, unknown>) || {}

    return this.deepMerge(defaultConfig, customConfig) as T
  }

  /**
   * Gets all enabled modules for a venue.
   * Useful for TPV at login time.
   *
   * @example
   * const modules = await moduleService.getEnabledModules(venueId);
   * // modules: [{ code: 'SERIALIZED_INVENTORY', config: { labels: { item: 'SIM' } } }]
   */
  async getEnabledModules(venueId: string): Promise<Array<{ code: string; config: Record<string, unknown> }>> {
    const venueModules = await this.db.venueModule.findMany({
      where: {
        venueId,
        enabled: true,
        module: { active: true }, // Module must be globally active
      },
      include: { module: true },
    })

    return venueModules.map(vm => ({
      code: vm.module.code,
      config: this.deepMerge(vm.module.defaultConfig as Record<string, unknown>, (vm.config as Record<string, unknown>) || {}),
    }))
  }

  /**
   * Gets all enabled module codes for a venue (simple array).
   * Useful for quick checks.
   *
   * @example
   * const codes = await moduleService.getEnabledModuleCodes(venueId);
   * if (codes.includes('SERIALIZED_INVENTORY')) { ... }
   */
  async getEnabledModuleCodes(venueId: string): Promise<string[]> {
    const venueModules = await this.db.venueModule.findMany({
      where: {
        venueId,
        enabled: true,
        module: { active: true }, // Module must be globally active
      },
      include: { module: { select: { code: true } } },
    })
    return venueModules.map(vm => vm.module.code)
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
      finalConfig = presets[preset]
    }

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

  /**
   * Deep merge utility for configuration objects.
   */
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
