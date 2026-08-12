import { Request, Response, NextFunction } from 'express'
import { ModuleScope } from '@prisma/client'
import { moduleService, ModuleCode, lockModuleScope } from '../../services/modules/module.service'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'

/**
 * Modules Superadmin Controller
 * Manages global modules and venue module assignments.
 *
 * Base path: /api/v1/dashboard/superadmin/modules
 */

/**
 * POST /modules
 * Create a new global module.
 */
export async function createModule(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, name, description, defaultConfig, presets, configSchema, scope } = req.body

    // Check if module with code already exists
    const existingModule = await prisma.module.findUnique({
      where: { code },
    })

    if (existingModule) {
      return res.status(400).json({ error: `Module with code ${code} already exists` })
    }

    // BOTH preserves every existing caller; only an explicit control-plane
    // request may narrow a new definition to one assignment level.
    const module = await prisma.module.create({
      data: {
        code,
        name,
        description: description || null,
        defaultConfig: defaultConfig || {},
        presets: presets || {},
        configSchema: configSchema || undefined,
        scope: scope ?? ModuleScope.BOTH,
      },
    })

    logger.info(`[MODULES] Created new module: ${code}`, { moduleId: module.id })
    return res.status(201).json({ module })
  } catch (error) {
    logger.error('[MODULES] Error creating module', { error })
    next(error)
  }
}

/**
 * PATCH /modules/:moduleId
 * Update a global module.
 */
export async function updateModule(req: Request, res: Response, next: NextFunction) {
  try {
    const { moduleId } = req.params
    const { name, description, defaultConfig, presets, configSchema, scope } = req.body

    const module = await prisma.$transaction(async tx => {
      const existingModule = await lockModuleScope(tx, { id: moduleId })
      if (!existingModule) return null

      // Count every assignment, including disabled rows: otherwise narrowing
      // would hide a dormant override that could later resurrect.
      if (scope === ModuleScope.ORGANIZATION_ONLY && existingModule.scope !== scope) {
        const venueAssignments = await tx.venueModule.count({ where: { moduleId } })
        if (venueAssignments > 0) {
          throw new BadRequestError('No se puede cambiar a ORGANIZATION_ONLY mientras existan filas VenueModule')
        }
      }
      if (scope === ModuleScope.VENUE_ONLY && existingModule.scope !== scope) {
        const organizationAssignments = await tx.organizationModule.count({ where: { moduleId } })
        if (organizationAssignments > 0) {
          throw new BadRequestError('No se puede cambiar a VENUE_ONLY mientras existan filas OrganizationModule')
        }
      }

      return tx.module.update({
        where: { id: moduleId },
        data: {
          name: name ?? existingModule.name,
          description: description !== undefined ? description : existingModule.description,
          defaultConfig: defaultConfig ?? existingModule.defaultConfig,
          presets: presets ?? existingModule.presets,
          configSchema: configSchema ?? existingModule.configSchema,
          scope: scope ?? existingModule.scope,
        },
      })
    })

    if (!module) {
      return res.status(404).json({ error: `Module ${moduleId} not found` })
    }

    logger.info(`[MODULES] Updated module: ${module.code}`, { moduleId: module.id })
    return res.status(200).json({ module })
  } catch (error) {
    logger.error('[MODULES] Error updating module', { error })
    next(error)
  }
}

/**
 * DELETE /modules/:moduleId
 * Delete a global module (only if not enabled for any venue).
 */
export async function deleteModule(req: Request, res: Response, next: NextFunction) {
  try {
    const { moduleId } = req.params

    const deletion = await prisma.$transaction(async tx => {
      const existingModule = await lockModuleScope(tx, { id: moduleId })
      if (!existingModule) return { kind: 'missing' as const }

      // Deletion never performs partial cleanup: any active or dormant assignment
      // must be resolved explicitly before the shared definition can disappear.
      const [venueAssignments, organizationAssignments] = await Promise.all([
        tx.venueModule.count({ where: { moduleId } }),
        tx.organizationModule.count({ where: { moduleId } }),
      ])
      if (venueAssignments > 0 || organizationAssignments > 0) {
        return { kind: 'assigned' as const, existingModule }
      }

      await tx.module.delete({ where: { id: moduleId } })
      return { kind: 'deleted' as const, existingModule }
    })

    if (deletion.kind === 'missing') {
      return res.status(404).json({ error: `Module ${moduleId} not found` })
    }

    if (deletion.kind === 'assigned') {
      return res.status(400).json({
        error: 'No se puede eliminar un módulo con assignments VenueModule u OrganizationModule existentes.',
      })
    }

    logger.info(`[MODULES] Deleted module: ${deletion.existingModule.code}`, { moduleId })
    return res.status(200).json({
      success: true,
      message: `Module ${deletion.existingModule.code} deleted`,
    })
  } catch (error) {
    logger.error('[MODULES] Error deleting module', { error })
    next(error)
  }
}

/**
 * GET /modules
 * Get all global modules with their configurations and presets.
 */
export async function getAllModules(req: Request, res: Response, next: NextFunction) {
  try {
    const modules = await prisma.module.findMany({
      orderBy: { code: 'asc' },
    })

    // Add enabled venue count for each module
    const modulesWithStats = await Promise.all(
      modules.map(async module => {
        const enabledCount = await prisma.venueModule.count({
          where: { moduleId: module.id, enabled: true },
        })
        return {
          ...module,
          enabledVenueCount: enabledCount,
        }
      }),
    )

    logger.info(`[MODULES] Retrieved ${modules.length} global modules`)
    return res.status(200).json({ modules: modulesWithStats })
  } catch (error) {
    logger.error('[MODULES] Error getting all modules', { error })
    next(error)
  }
}

/**
 * GET /modules/:moduleCode/venues
 * Get all venues with their enablement status for a specific module.
 * Supports ?grouped=true to return venues grouped by organization with org-level module status.
 */
export async function getVenuesForModule(req: Request, res: Response, next: NextFunction) {
  try {
    const { moduleCode } = req.params
    const grouped = req.query.grouped === 'true'

    const module = await prisma.module.findUnique({
      where: { code: moduleCode },
    })

    if (!module) {
      return res.status(404).json({ error: `Module ${moduleCode} not found` })
    }

    // This endpoint enumerates venue assignments in both flat/grouped modes;
    // organization-only modules must stay on organization control-plane APIs.
    if (module.scope === ModuleScope.ORGANIZATION_ONLY) {
      return res.status(400).json({ error: `Module ${moduleCode} is ORGANIZATION_ONLY and has no venue listing` })
    }

    if (grouped) {
      // Return venues grouped by organization with org-level module status
      const organizations = await prisma.organization.findMany({
        select: {
          id: true,
          name: true,
          slug: true,
          organizationModules: {
            // Grouped venue state inherits only BOTH definitions. This relation
            // guard suppresses any stale VENUE_ONLY organization assignment.
            where: { moduleId: module.id, module: { scope: ModuleScope.BOTH } },
            select: {
              enabled: true,
              config: true,
              enabledAt: true,
            },
          },
          venues: {
            select: {
              id: true,
              name: true,
              slug: true,
              venueModules: {
                where: { moduleId: module.id },
                select: {
                  enabled: true,
                  config: true,
                  enabledAt: true,
                },
              },
            },
            orderBy: { name: 'asc' },
          },
        },
        orderBy: { name: 'asc' },
      })

      const orgGroups = organizations.map(org => {
        const orgModule = org.organizationModules[0] || null
        const orgModuleEnabled = orgModule?.enabled ?? false

        const venues = org.venues.map(venue => {
          const venueModule = venue.venueModules[0] || null
          const hasExplicitOverride = venueModule !== null
          const isInherited = !hasExplicitOverride && orgModuleEnabled
          const moduleEnabled = hasExplicitOverride ? venueModule.enabled : orgModuleEnabled

          return {
            id: venue.id,
            name: venue.name,
            slug: venue.slug,
            moduleEnabled,
            hasExplicitOverride,
            isInherited,
            venueModuleConfig: venueModule?.config || null,
            enabledAt: venueModule?.enabledAt || orgModule?.enabledAt || null,
          }
        })

        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          venueCount: org.venues.length,
          orgModuleEnabled,
          orgModuleConfig: orgModule?.config || null,
          orgModuleEnabledAt: orgModule?.enabledAt || null,
          venues,
        }
      })

      logger.info(`[MODULES] Retrieved ${organizations.length} orgs (grouped) for module ${moduleCode}`)
      return res.status(200).json({
        module,
        organizations: orgGroups,
      })
    }

    // Default: flat venue list (legacy behavior)
    const venues = await prisma.venue.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        venueModules: {
          where: { moduleId: module.id },
          select: {
            id: true,
            enabled: true,
            config: true,
            enabledAt: true,
            enabledBy: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    })

    const venuesWithStatus = venues.map(venue => ({
      id: venue.id,
      name: venue.name,
      slug: venue.slug,
      moduleEnabled: venue.venueModules.length > 0 && venue.venueModules[0].enabled,
      moduleConfig: venue.venueModules[0]?.config || null,
      enabledAt: venue.venueModules[0]?.enabledAt || null,
    }))

    logger.info(`[MODULES] Retrieved ${venues.length} venues for module ${moduleCode}`)
    return res.status(200).json({
      module,
      venues: venuesWithStatus,
    })
  } catch (error) {
    logger.error('[MODULES] Error getting venues for module', { error })
    next(error)
  }
}

/**
 * DELETE /modules/venue-override
 * Delete the VenueModule record so the venue falls back to org-level inheritance.
 */
export async function deleteVenueModuleOverride(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, moduleCode } = req.body

    const module = await prisma.module.findUnique({
      where: { code: moduleCode },
      select: { id: true },
    })

    if (!module) {
      return res.status(404).json({ error: `Module ${moduleCode} not found` })
    }

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, name: true },
    })

    if (!venue) {
      return res.status(404).json({ error: `Venue ${venueId} not found` })
    }

    // Repair exception: stale rows must remain deletable even after a module is
    // organization-only, because disabled rows also block a safe scope transition.
    const venueModule = await prisma.venueModule.findFirst({
      where: { venueId, moduleId: module.id },
    })

    if (!venueModule) {
      return res.status(404).json({ error: `No venue module override found for ${moduleCode} on venue ${venueId}` })
    }

    await prisma.venueModule.delete({
      where: { id: venueModule.id },
    })

    logger.info(`[MODULES] Deleted venue override for ${moduleCode} on venue ${venue.name}`, {
      venueId,
      moduleCode,
    })

    return res.status(200).json({
      success: true,
      message: `Override eliminado para ${moduleCode} en ${venue.name}. Ahora hereda configuración de la organización.`,
    })
  } catch (error) {
    logger.error('[MODULES] Error deleting venue module override', { error })
    next(error)
  }
}

/**
 * GET /modules/venues/:venueId
 * Get all modules with their enablement status for a specific venue.
 */
export async function getModulesForVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, name: true, slug: true },
    })

    if (!venue) {
      return res.status(404).json({ error: `Venue ${venueId} not found` })
    }

    // Get all modules with venue's enablement status
    const modules = await prisma.module.findMany({
      where: { scope: { in: [ModuleScope.BOTH, ModuleScope.VENUE_ONLY] } },
      include: {
        venueModules: {
          where: { venueId },
        },
      },
      orderBy: { code: 'asc' },
    })

    const modulesWithStatus = modules.map(module => ({
      id: module.id,
      code: module.code,
      name: module.name,
      description: module.description,
      defaultConfig: module.defaultConfig,
      presets: module.presets,
      configSchema: module.configSchema,
      scope: module.scope,
      enabled: module.venueModules.length > 0 && module.venueModules[0].enabled,
      config: module.venueModules[0]?.config || null,
      enabledAt: module.venueModules[0]?.enabledAt || null,
    }))

    logger.info(`[MODULES] Retrieved ${modules.length} modules for venue ${venue.name}`)
    return res.status(200).json({
      venue,
      modules: modulesWithStatus,
    })
  } catch (error) {
    logger.error('[MODULES] Error getting modules for venue', { error })
    next(error)
  }
}

/**
 * POST /modules/enable
 * Enable a module for a venue with optional preset.
 */
export async function enableModuleForVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, moduleCode, preset } = req.body
    const authContext = (req as any).authContext
    const enabledBy = authContext?.userId || 'system'

    // Validate module exists in database (dynamic validation instead of hardcoded list)
    const moduleExists = await prisma.module.findUnique({
      where: { code: moduleCode },
      select: { id: true, active: true, scope: true },
    })

    if (!moduleExists) {
      return res.status(400).json({ error: `Invalid module code: ${moduleCode}` })
    }

    if (!moduleExists.active) {
      return res.status(400).json({ error: `Module ${moduleCode} is not active` })
    }

    if (moduleExists.scope === ModuleScope.ORGANIZATION_ONLY) {
      return res.status(400).json({ error: `Module ${moduleCode} is ORGANIZATION_ONLY and cannot be enabled for a venue` })
    }

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, name: true },
    })

    if (!venue) {
      return res.status(404).json({ error: `Venue ${venueId} not found` })
    }

    const venueModule = await moduleService.enableModule(venueId, moduleCode as ModuleCode, enabledBy, undefined, preset)

    logger.info(`[MODULES] Enabled ${moduleCode} for venue ${venue.name}`, {
      venueId,
      moduleCode,
      preset,
      enabledBy,
    })

    return res.status(200).json({
      success: true,
      message: `Module ${moduleCode} enabled for ${venue.name}`,
      venueModule,
    })
  } catch (error) {
    logger.error('[MODULES] Error enabling module for venue', { error })
    next(error)
  }
}

/**
 * POST /modules/disable
 * Disable a module for a venue.
 */
export async function disableModuleForVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, moduleCode } = req.body

    // Validate module exists in database (dynamic validation)
    const moduleExists = await prisma.module.findUnique({
      where: { code: moduleCode },
      select: { id: true, scope: true },
    })

    if (!moduleExists) {
      return res.status(400).json({ error: `Invalid module code: ${moduleCode}` })
    }

    if (moduleExists.scope === ModuleScope.ORGANIZATION_ONLY) {
      return res.status(400).json({ error: `Module ${moduleCode} is ORGANIZATION_ONLY and cannot be disabled for a venue` })
    }

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, name: true },
    })

    if (!venue) {
      return res.status(404).json({ error: `Venue ${venueId} not found` })
    }

    const venueModule = await moduleService.disableModule(venueId, moduleCode as ModuleCode)

    if (!venueModule) {
      return res.status(404).json({ error: `Module ${moduleCode} not found for venue` })
    }

    logger.info(`[MODULES] Disabled ${moduleCode} for venue ${venue.name}`, {
      venueId,
      moduleCode,
    })

    return res.status(200).json({
      success: true,
      message: `Module ${moduleCode} disabled for ${venue.name}`,
      venueModule,
    })
  } catch (error) {
    logger.error('[MODULES] Error disabling module for venue', { error })
    next(error)
  }
}

/**
 * PATCH /modules/config
 * Update module configuration for a venue.
 */
export async function updateModuleConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, moduleCode, config } = req.body

    // Validate module exists in database (dynamic validation)
    const moduleExists = await prisma.module.findUnique({
      where: { code: moduleCode },
      select: { id: true, scope: true },
    })

    if (!moduleExists) {
      return res.status(400).json({ error: `Invalid module code: ${moduleCode}` })
    }

    if (moduleExists.scope === ModuleScope.ORGANIZATION_ONLY) {
      return res.status(400).json({ error: `Module ${moduleCode} is ORGANIZATION_ONLY and has no venue config` })
    }

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, name: true },
    })

    if (!venue) {
      return res.status(404).json({ error: `Venue ${venueId} not found` })
    }

    const venueModule = await moduleService.updateModuleConfig(venueId, moduleCode as ModuleCode, config)

    if (!venueModule) {
      return res.status(404).json({ error: `Module ${moduleCode} not enabled for venue` })
    }

    logger.info(`[MODULES] Updated config for ${moduleCode} on venue ${venue.name}`, {
      venueId,
      moduleCode,
    })

    return res.status(200).json({
      success: true,
      message: `Module ${moduleCode} config updated for ${venue.name}`,
      venueModule,
    })
  } catch (error) {
    logger.error('[MODULES] Error updating module config', { error })
    next(error)
  }
}
