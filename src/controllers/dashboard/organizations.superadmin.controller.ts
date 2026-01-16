import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { moduleService, ModuleCode } from '../../services/modules/module.service'

/**
 * Organizations Superadmin Controller
 * Manages organizations and organization-level module assignments.
 *
 * Base path: /api/v1/dashboard/superadmin/organizations
 */

/**
 * GET /organizations
 * Get all organizations with venue counts and module stats.
 */
export async function getAllOrganizations(req: Request, res: Response, next: NextFunction) {
  try {
    const organizations = await prisma.organization.findMany({
      include: {
        _count: {
          select: {
            venues: true,
            staff: true,
          },
        },
        organizationModules: {
          where: { enabled: true },
          include: {
            module: {
              select: { code: true, name: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    })

    const orgsWithStats = organizations.map(org => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      email: org.email,
      phone: org.phone,
      type: org.type,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
      venueCount: org._count.venues,
      staffCount: org._count.staff,
      enabledModules: org.organizationModules.map(om => ({
        code: om.module.code,
        name: om.module.name,
      })),
    }))

    logger.info(`[ORGANIZATIONS] Retrieved ${organizations.length} organizations`)
    return res.status(200).json({ organizations: orgsWithStats })
  } catch (error) {
    logger.error('[ORGANIZATIONS] Error getting all organizations', { error })
    next(error)
  }
}

/**
 * GET /organizations/:organizationId
 * Get a single organization with full details.
 */
export async function getOrganizationById(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        venues: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            createdAt: true,
          },
          orderBy: { name: 'asc' },
        },
        organizationModules: {
          include: {
            module: true,
          },
        },
        _count: {
          select: {
            venues: true,
            staff: true,
          },
        },
      },
    })

    if (!organization) {
      return res.status(404).json({ error: `Organization ${organizationId} not found` })
    }

    logger.info(`[ORGANIZATIONS] Retrieved organization: ${organization.name}`)
    return res.status(200).json({ organization })
  } catch (error) {
    logger.error('[ORGANIZATIONS] Error getting organization', { error })
    next(error)
  }
}

/**
 * POST /organizations
 * Create a new organization.
 */
export async function createOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, slug, email, phone, taxId, type } = req.body

    // Check if slug already exists (if provided)
    if (slug) {
      const existingOrg = await prisma.organization.findUnique({
        where: { slug },
      })

      if (existingOrg) {
        return res.status(400).json({ error: `Organization with slug "${slug}" already exists` })
      }
    }

    const organization = await prisma.organization.create({
      data: {
        name,
        slug: slug || null,
        email,
        phone,
        taxId: taxId || null,
        type: type || 'RESTAURANT',
      },
    })

    logger.info(`[ORGANIZATIONS] Created organization: ${name}`, { organizationId: organization.id })
    return res.status(201).json({ organization })
  } catch (error) {
    logger.error('[ORGANIZATIONS] Error creating organization', { error })
    next(error)
  }
}

/**
 * PATCH /organizations/:organizationId
 * Update an organization.
 */
export async function updateOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params
    const { name, slug, email, phone, taxId, type } = req.body

    const existingOrg = await prisma.organization.findUnique({
      where: { id: organizationId },
    })

    if (!existingOrg) {
      return res.status(404).json({ error: `Organization ${organizationId} not found` })
    }

    // Check slug uniqueness if changing
    if (slug && slug !== existingOrg.slug) {
      const slugExists = await prisma.organization.findUnique({
        where: { slug },
      })
      if (slugExists) {
        return res.status(400).json({ error: `Organization with slug "${slug}" already exists` })
      }
    }

    const organization = await prisma.organization.update({
      where: { id: organizationId },
      data: {
        name: name ?? existingOrg.name,
        slug: slug !== undefined ? slug : existingOrg.slug,
        email: email ?? existingOrg.email,
        phone: phone ?? existingOrg.phone,
        taxId: taxId !== undefined ? taxId : existingOrg.taxId,
        type: type ?? existingOrg.type,
      },
    })

    logger.info(`[ORGANIZATIONS] Updated organization: ${organization.name}`, { organizationId })
    return res.status(200).json({ organization })
  } catch (error) {
    logger.error('[ORGANIZATIONS] Error updating organization', { error })
    next(error)
  }
}

/**
 * DELETE /organizations/:organizationId
 * Delete an organization (only if no venues exist).
 */
export async function deleteOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        _count: {
          select: { venues: true },
        },
      },
    })

    if (!organization) {
      return res.status(404).json({ error: `Organization ${organizationId} not found` })
    }

    if (organization._count.venues > 0) {
      return res.status(400).json({
        error: `Cannot delete organization with ${organization._count.venues} venues. Remove all venues first.`,
      })
    }

    // Delete organization modules first
    await prisma.organizationModule.deleteMany({
      where: { organizationId },
    })

    // Delete organization
    await prisma.organization.delete({
      where: { id: organizationId },
    })

    logger.info(`[ORGANIZATIONS] Deleted organization: ${organization.name}`, { organizationId })
    return res.status(200).json({
      success: true,
      message: `Organization "${organization.name}" deleted`,
    })
  } catch (error) {
    logger.error('[ORGANIZATIONS] Error deleting organization', { error })
    next(error)
  }
}

// ===========================================
// ORGANIZATION MODULE MANAGEMENT
// ===========================================

/**
 * GET /organizations/:organizationId/modules
 * Get all modules with their enablement status for an organization.
 */
export async function getModulesForOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, slug: true },
    })

    if (!organization) {
      return res.status(404).json({ error: `Organization ${organizationId} not found` })
    }

    // Get all modules with organization's enablement status
    const modules = await prisma.module.findMany({
      where: { active: true },
      include: {
        organizationModules: {
          where: { organizationId },
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
      enabled: module.organizationModules.length > 0 && module.organizationModules[0].enabled,
      config: module.organizationModules[0]?.config || null,
      enabledAt: module.organizationModules[0]?.enabledAt || null,
    }))

    logger.info(`[ORGANIZATIONS] Retrieved ${modules.length} modules for organization ${organization.name}`)
    return res.status(200).json({
      organization,
      modules: modulesWithStatus,
    })
  } catch (error) {
    logger.error('[ORGANIZATIONS] Error getting modules for organization', { error })
    next(error)
  }
}

/**
 * POST /organizations/:organizationId/modules/enable
 * Enable a module for all venues in an organization.
 */
export async function enableModuleForOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params
    const { moduleCode, preset, config } = req.body
    const authContext = (req as any).authContext
    const enabledBy = authContext?.userId || 'system'

    // Validate module exists in database
    const moduleExists = await prisma.module.findUnique({
      where: { code: moduleCode },
      select: { id: true, active: true },
    })

    if (!moduleExists) {
      return res.status(400).json({ error: `Invalid module code: ${moduleCode}` })
    }

    if (!moduleExists.active) {
      return res.status(400).json({ error: `Module ${moduleCode} is not active` })
    }

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true },
    })

    if (!organization) {
      return res.status(404).json({ error: `Organization ${organizationId} not found` })
    }

    const orgModule = await moduleService.enableModuleForOrganization(organizationId, moduleCode as ModuleCode, enabledBy, config, preset)

    logger.info(`[ORGANIZATIONS] Enabled ${moduleCode} for organization ${organization.name}`, {
      organizationId,
      moduleCode,
      preset,
      enabledBy,
    })

    return res.status(200).json({
      success: true,
      message: `Module ${moduleCode} enabled for all venues in ${organization.name}`,
      organizationModule: orgModule,
    })
  } catch (error) {
    logger.error('[ORGANIZATIONS] Error enabling module for organization', { error })
    next(error)
  }
}

/**
 * POST /organizations/:organizationId/modules/disable
 * Disable a module for an organization.
 */
export async function disableModuleForOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params
    const { moduleCode } = req.body

    // Validate module exists in database
    const moduleExists = await prisma.module.findUnique({
      where: { code: moduleCode },
      select: { id: true },
    })

    if (!moduleExists) {
      return res.status(400).json({ error: `Invalid module code: ${moduleCode}` })
    }

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true },
    })

    if (!organization) {
      return res.status(404).json({ error: `Organization ${organizationId} not found` })
    }

    const orgModule = await moduleService.disableModuleForOrganization(organizationId, moduleCode as ModuleCode)

    if (!orgModule) {
      return res.status(404).json({ error: `Module ${moduleCode} not found for organization` })
    }

    logger.info(`[ORGANIZATIONS] Disabled ${moduleCode} for organization ${organization.name}`, {
      organizationId,
      moduleCode,
    })

    return res.status(200).json({
      success: true,
      message: `Module ${moduleCode} disabled for ${organization.name}`,
      organizationModule: orgModule,
    })
  } catch (error) {
    logger.error('[ORGANIZATIONS] Error disabling module for organization', { error })
    next(error)
  }
}

/**
 * PATCH /organizations/:organizationId/modules/config
 * Update module configuration for an organization.
 */
export async function updateOrganizationModuleConfig(req: Request, res: Response, next: NextFunction) {
  try {
    const { organizationId } = req.params
    const { moduleCode, config } = req.body

    // Validate module exists in database
    const moduleExists = await prisma.module.findUnique({
      where: { code: moduleCode },
      select: { id: true },
    })

    if (!moduleExists) {
      return res.status(400).json({ error: `Invalid module code: ${moduleCode}` })
    }

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true },
    })

    if (!organization) {
      return res.status(404).json({ error: `Organization ${organizationId} not found` })
    }

    const orgModule = await moduleService.updateOrganizationModuleConfig(organizationId, moduleCode as ModuleCode, config)

    if (!orgModule) {
      return res.status(404).json({ error: `Module ${moduleCode} not enabled for organization` })
    }

    logger.info(`[ORGANIZATIONS] Updated config for ${moduleCode} on organization ${organization.name}`, {
      organizationId,
      moduleCode,
    })

    return res.status(200).json({
      success: true,
      message: `Module ${moduleCode} config updated for ${organization.name}`,
      organizationModule: orgModule,
    })
  } catch (error) {
    logger.error('[ORGANIZATIONS] Error updating organization module config', { error })
    next(error)
  }
}

/**
 * GET /organizations/list
 * Get simplified list of organizations for dropdowns.
 */
export async function getOrganizationsListSimple(req: Request, res: Response, next: NextFunction) {
  try {
    const organizations = await prisma.organization.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        _count: {
          select: { venues: true },
        },
      },
      orderBy: { name: 'asc' },
    })

    const list = organizations.map(org => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      venueCount: org._count.venues,
    }))

    logger.info(`[ORGANIZATIONS] Retrieved ${organizations.length} organizations (simple list)`)
    return res.status(200).json({ organizations: list })
  } catch (error) {
    logger.error('[ORGANIZATIONS] Error getting organizations list', { error })
    next(error)
  }
}
