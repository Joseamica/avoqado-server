/**
 * Organization Config Routes
 * Org-level configuration endpoints that receive orgId directly.
 * Used by the Organization Dashboard (/organizations/:orgId) for WL org config.
 *
 * These endpoints mirror the stores-analysis org-* endpoints but accept orgId
 * instead of venueId, eliminating the venue->org lookup hack.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { organizationDashboardService } from '../../services/organization-dashboard/organizationDashboard.service'
import * as goalResolutionService from '../../services/dashboard/commission/goal-resolution.service'
import { logAction } from '../../services/dashboard/activity-log.service'
import prisma from '../../utils/prismaClient'
import { StaffRole } from '@prisma/client'

const router = Router({ mergeParams: true })

/**
 * Middleware: Verify the authenticated user is OWNER+ in the target organization.
 * Uses authContext.userId to check StaffVenue role in any venue of the org.
 */
async function requireOrgOwner(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId, role } = (req as any).authContext
    const { orgId } = req.params

    // SUPERADMIN bypasses
    if (role === 'SUPERADMIN') return next()

    // Check if user is OWNER in any venue of this org
    const ownerVenue = await prisma.staffVenue.findFirst({
      where: {
        staffId: userId,
        venue: { organizationId: orgId },
        role: StaffRole.OWNER,
      },
    })

    if (!ownerVenue) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Owner access required for this organization' })
    }

    next()
  } catch (error) {
    next(error)
  }
}

const orgOwnerAccess = [authenticateTokenMiddleware, requireOrgOwner]

// =============================================================================
// ORG GOALS
// =============================================================================

/**
 * GET /dashboard/organizations/:orgId/org-goals
 */
router.get('/org-goals', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    // goalResolutionService.getOrgGoals expects venueId and does venue->org lookup internally
    // We need to get any venueId from this org to pass to the service
    const venue = await prisma.venue.findFirst({ where: { organizationId: orgId }, select: { id: true } })
    if (!venue) return res.status(404).json({ success: false, error: 'not_found', message: 'No venues found in organization' })

    const goals = await goalResolutionService.getOrgGoals(venue.id)
    res.json({ success: true, data: goals })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /dashboard/organizations/:orgId/org-goals
 */
router.post('/org-goals', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const { goal, goalType, period } = req.body
    const venue = await prisma.venue.findFirst({ where: { organizationId: orgId }, select: { id: true } })
    if (!venue) return res.status(404).json({ success: false, error: 'not_found', message: 'No venues found in organization' })

    const created = await goalResolutionService.createOrgGoal(venue.id, {
      goal: Number(goal),
      goalType: goalType || 'AMOUNT',
      period: period || 'MONTHLY',
    })
    res.json({ success: true, data: created })
  } catch (error) {
    next(error)
  }
})

/**
 * PATCH /dashboard/organizations/:orgId/org-goals/:goalId
 */
router.patch('/org-goals/:goalId', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, goalId } = req.params
    const { goal, goalType, period, active } = req.body
    const venue = await prisma.venue.findFirst({ where: { organizationId: orgId }, select: { id: true } })
    if (!venue) return res.status(404).json({ success: false, error: 'not_found', message: 'No venues found in organization' })

    const updated = await goalResolutionService.updateOrgGoal(venue.id, goalId, {
      goal: goal !== undefined ? Number(goal) : undefined,
      goalType,
      period,
      active,
    })
    res.json({ success: true, data: updated })
  } catch (error) {
    next(error)
  }
})

/**
 * DELETE /dashboard/organizations/:orgId/org-goals/:goalId
 */
router.delete('/org-goals/:goalId', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, goalId } = req.params
    const venue = await prisma.venue.findFirst({ where: { organizationId: orgId }, select: { id: true } })
    if (!venue) return res.status(404).json({ success: false, error: 'not_found', message: 'No venues found in organization' })

    await goalResolutionService.deleteOrgGoal(venue.id, goalId)
    res.json({ success: true, data: { message: 'Org goal deleted' } })
  } catch (error) {
    next(error)
  }
})

// =============================================================================
// ORG ATTENDANCE / TPV CONFIG
// =============================================================================

/**
 * GET /dashboard/organizations/:orgId/org-attendance-config
 */
router.get('/org-attendance-config', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const config = await organizationDashboardService.getOrgAttendanceConfig(orgId)
    res.json({ success: true, data: config })
  } catch (error) {
    next(error)
  }
})

/**
 * PUT /dashboard/organizations/:orgId/org-attendance-config
 */
router.put('/org-attendance-config', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const config = await organizationDashboardService.upsertOrgAttendanceConfig(orgId, req.body)
    res.json({ success: true, data: config })
  } catch (error) {
    next(error)
  }
})

/**
 * DELETE /dashboard/organizations/:orgId/org-attendance-config
 */
router.delete('/org-attendance-config', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    await organizationDashboardService.deleteOrgAttendanceConfig(orgId)
    res.json({ success: true, data: { message: 'Org attendance config deleted' } })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/organizations/:orgId/org-tpv-defaults
 */
router.get('/org-tpv-defaults', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const settings = await organizationDashboardService.getOrgTpvDefaults(orgId)
    res.json({ success: true, data: settings })
  } catch (error) {
    next(error)
  }
})

/**
 * PUT /dashboard/organizations/:orgId/org-tpv-defaults
 */
router.put('/org-tpv-defaults', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const { settings } = req.body
    const result = await organizationDashboardService.upsertOrgTpvDefaults(orgId, settings)
    res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/organizations/:orgId/org-tpv-defaults/stats
 */
router.get('/org-tpv-defaults/stats', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const stats = await organizationDashboardService.getOrgTpvStats(orgId)
    res.json({ success: true, data: stats })
  } catch (error) {
    next(error)
  }
})

// =============================================================================
// ORG ITEM CATEGORIES
// =============================================================================

/**
 * GET /dashboard/organizations/:orgId/org-categories
 */
router.get('/org-categories', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const categories = await prisma.itemCategory.findMany({
      where: { organizationId: orgId },
      orderBy: { sortOrder: 'asc' },
    })
    res.json({ success: true, data: { categories } })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /dashboard/organizations/:orgId/org-categories
 */
router.post('/org-categories', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const { name, description, suggestedPrice } = req.body

    if (!name?.trim()) {
      return res.status(400).json({ success: false, error: 'validation', message: 'El nombre es requerido' })
    }

    // Get max sortOrder for this org
    const maxSort = await prisma.itemCategory.aggregate({
      where: { organizationId: orgId },
      _max: { sortOrder: true },
    })

    const category = await prisma.itemCategory.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        suggestedPrice: suggestedPrice ? parseFloat(suggestedPrice) : null,
        organizationId: orgId,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
    })
    res.json({ success: true, data: category })
  } catch (error) {
    next(error)
  }
})

/**
 * PUT /dashboard/organizations/:orgId/org-categories/:categoryId
 */
router.put('/org-categories/:categoryId', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, categoryId } = req.params
    const { name, description, suggestedPrice } = req.body

    const category = await prisma.itemCategory.update({
      where: { id: categoryId, organizationId: orgId },
      data: {
        ...(name && { name: name.trim() }),
        ...(description !== undefined && { description: description?.trim() || null }),
        ...(suggestedPrice !== undefined && { suggestedPrice: suggestedPrice ? parseFloat(suggestedPrice) : null }),
      },
    })
    res.json({ success: true, data: category })
  } catch (error) {
    next(error)
  }
})

/**
 * DELETE /dashboard/organizations/:orgId/org-categories/:categoryId
 */
router.delete('/org-categories/:categoryId', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, categoryId } = req.params
    await prisma.itemCategory.delete({ where: { id: categoryId, organizationId: orgId } })
    res.json({ success: true, data: { message: 'Category deleted' } })
  } catch (error) {
    next(error)
  }
})

// =============================================================================
// ORG TEAM MANAGEMENT
// =============================================================================

/**
 * GET /dashboard/organizations/:orgId/team
 * List all staff in the org with their venue assignments, roles, and status.
 * Query: scope (optional, default 'org')
 */
router.get('/team', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params

    const staffOrgs = await prisma.staffOrganization.findMany({
      where: { organizationId: orgId },
      include: {
        staff: {
          include: {
            venues: {
              where: {
                venue: { organizationId: orgId },
              },
              include: {
                venue: {
                  select: { id: true, name: true, slug: true },
                },
              },
            },
          },
        },
      },
    })

    const team = staffOrgs.map(so => ({
      id: so.staff.id,
      firstName: so.staff.firstName,
      lastName: so.staff.lastName,
      email: so.staff.email,
      phone: so.staff.phone,
      photoUrl: so.staff.photoUrl,
      status: 'ACTIVE',
      orgRole: so.role,
      venues: so.staff.venues.map((v: any) => ({
        id: v.venue.id,
        staffVenueId: v.id,
        name: v.venue.name,
        slug: v.venue.slug,
        role: v.role,
        active: v.active,
        pin: v.pin || null,
      })),
    }))

    res.json({
      success: true,
      data: team,
      meta: { scope: 'org', canViewAllOrgStaff: true },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * PATCH /dashboard/organizations/:orgId/team/:staffId/role
 * Update a staff member's role across all their venues in this org.
 * Body: { role: StaffRole }
 */
router.patch('/team/:staffId/role', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, staffId } = req.params
    const { role } = req.body as { role: StaffRole }
    const authContext = (req as any).authContext

    if (!role || !Object.values(StaffRole).includes(role)) {
      return res.status(400).json({ success: false, error: 'validation', message: 'Rol inválido' })
    }

    // Verify staff belongs to org
    const staffOrg = await prisma.staffOrganization.findFirst({
      where: { staffId, organizationId: orgId },
    })
    if (!staffOrg) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Staff not found in this organization' })
    }

    // Get all org venue IDs
    const orgVenues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    })
    const orgVenueIds = orgVenues.map(v => v.id)

    // Update role on ALL StaffVenue records for this staff in this org
    await prisma.staffVenue.updateMany({
      where: {
        staffId,
        venueId: { in: orgVenueIds },
      },
      data: { role },
    })

    logAction({
      staffId: authContext?.userId || null,
      venueId: null,
      action: 'ROLE_UPDATED',
      entity: 'Staff',
      entityId: staffId,
      data: { orgId, newRole: role },
    })

    res.json({ success: true, data: { message: 'Role updated across all venues', role } })
  } catch (error) {
    next(error)
  }
})

/**
 * PATCH /dashboard/organizations/:orgId/team/:staffId/status
 * Activate/deactivate a staff member across all venues.
 * Body: { active: boolean }
 */
router.patch('/team/:staffId/status', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, staffId } = req.params
    const { active } = req.body as { active: boolean }
    const authContext = (req as any).authContext

    if (typeof active !== 'boolean') {
      return res.status(400).json({ success: false, error: 'validation', message: 'El campo active debe ser booleano' })
    }

    // Verify staff belongs to org
    const staffOrg = await prisma.staffOrganization.findFirst({
      where: { staffId, organizationId: orgId },
    })
    if (!staffOrg) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Staff not found in this organization' })
    }

    // Get all org venue IDs
    const orgVenues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    })
    const orgVenueIds = orgVenues.map(v => v.id)

    // Update active status on ALL StaffVenue records
    await prisma.staffVenue.updateMany({
      where: {
        staffId,
        venueId: { in: orgVenueIds },
      },
      data: { active },
    })

    logAction({
      staffId: authContext?.userId || null,
      venueId: null,
      action: active ? 'STAFF_ACTIVATED' : 'STAFF_DEACTIVATED',
      entity: 'Staff',
      entityId: staffId,
      data: { orgId, active },
    })

    res.json({ success: true, data: { message: `Staff ${active ? 'activated' : 'deactivated'} across all venues`, active } })
  } catch (error) {
    next(error)
  }
})

/**
 * PATCH /dashboard/organizations/:orgId/team/:staffId/venues
 * Sync venue assignments for a staff member within the organization.
 * Body: { venueIds: string[] }
 * Adds new assignments, deactivates removed ones (soft-delete).
 */
router.patch('/team/:staffId/venues', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, staffId } = req.params
    const { venueIds } = req.body as { venueIds: string[] }
    const authContext = (req as any).authContext

    if (!Array.isArray(venueIds)) {
      return res.status(400).json({ success: false, error: 'validation', message: 'venueIds debe ser un arreglo' })
    }

    // Get all org venues (to validate the requested venueIds belong to this org)
    const orgVenues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
    })
    const orgVenueIds = new Set(orgVenues.map(v => v.id))
    const validVenueIds = venueIds.filter(id => orgVenueIds.has(id))

    // Get current StaffVenue records for this staff in the org
    const currentAssignments = await prisma.staffVenue.findMany({
      where: {
        staffId,
        venueId: { in: Array.from(orgVenueIds) },
      },
      include: { venue: { select: { name: true } } },
    })

    const currentActiveIds = new Set(currentAssignments.filter(a => a.active).map(a => a.venueId))
    const requestedIds = new Set(validVenueIds)

    // Determine what to add and remove
    const toAdd = validVenueIds.filter(id => !currentActiveIds.has(id))
    const toRemove = Array.from(currentActiveIds).filter(id => !requestedIds.has(id))

    // ── Safety checks before removing venues ──
    if (toRemove.length > 0) {
      // 1. Check for active TimeEntries (check-ins without checkout)
      const activeTimeEntries = await prisma.timeEntry.findMany({
        where: {
          staffId,
          venueId: { in: toRemove },
          status: { in: ['CLOCKED_IN', 'ON_BREAK'] },
        },
        include: { venue: { select: { name: true } } },
      })
      if (activeTimeEntries.length > 0) {
        const venueNames = activeTimeEntries.map(te => te.venue.name).join(', ')
        return res.status(409).json({
          success: false,
          error: 'active_time_entry',
          message: `Este usuario tiene un turno activo en: ${venueNames}. Debe hacer checkout antes de ser reasignado.`,
        })
      }

      // 2. Check for open Shifts (cash register sessions)
      const openShifts = await prisma.shift.findMany({
        where: {
          staffId,
          venueId: { in: toRemove },
          status: 'OPEN',
        },
        include: { venue: { select: { name: true } } },
      })
      if (openShifts.length > 0) {
        const venueNames = openShifts.map(s => s.venue.name).join(', ')
        return res.status(409).json({
          success: false,
          error: 'open_shift',
          message: `Este usuario tiene un corte de caja abierto en: ${venueNames}. Debe cerrar su turno antes de ser reasignado.`,
        })
      }
    }

    // Get the user's role from any existing assignment (use as default for new assignments)
    const existingAssignment = currentAssignments.find(a => a.active)
    const defaultRole = existingAssignment?.role || 'VIEWER'

    // Add new venue assignments
    for (const addVenueId of toAdd) {
      await prisma.staffVenue.upsert({
        where: { staffId_venueId: { staffId, venueId: addVenueId } },
        update: { active: true, role: defaultRole },
        create: { staffId, venueId: addVenueId, role: defaultRole, active: true },
      })

      const venueName = orgVenues.find(v => v.id === addVenueId)?.name || addVenueId
      logAction({
        staffId: authContext?.userId || null,
        venueId: addVenueId,
        action: 'VENUE_ASSIGNED',
        entity: 'Staff',
        entityId: staffId,
        data: { venueId: addVenueId, venueName },
      })
    }

    // Remove (deactivate) venue assignments
    for (const removeVenueId of toRemove) {
      await prisma.staffVenue.update({
        where: { staffId_venueId: { staffId, venueId: removeVenueId } },
        data: { active: false },
      })

      const venueName = orgVenues.find(v => v.id === removeVenueId)?.name || removeVenueId
      logAction({
        staffId: authContext?.userId || null,
        venueId: removeVenueId,
        action: 'VENUE_REMOVED',
        entity: 'Staff',
        entityId: staffId,
        data: { venueId: removeVenueId, venueName },
      })
    }

    res.json({
      success: true,
      data: { added: toAdd.length, removed: toRemove.length },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * PATCH /dashboard/organizations/:orgId/team/:staffId/pin
 * Set/update PIN for a staff member across all venues in this org.
 * Body: { pin: string }
 */
router.patch('/team/:staffId/pin', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, staffId } = req.params
    const { pin } = req.body as { pin: string }
    const authContext = (req as any).authContext

    // Validate PIN format: 4-6 digits
    if (!pin || !/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({ success: false, error: 'validation', message: 'El PIN debe ser de 4 a 6 dígitos' })
    }

    // Verify staff belongs to org
    const staffOrg = await prisma.staffOrganization.findFirst({
      where: { staffId, organizationId: orgId },
    })
    if (!staffOrg) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Staff not found in this organization' })
    }

    // Get all org venue IDs
    const orgVenues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    })
    const orgVenueIds = orgVenues.map(v => v.id)

    // Check PIN uniqueness per venue — PIN must be unique within each venue
    for (const venueId of orgVenueIds) {
      const conflict = await prisma.staffVenue.findFirst({
        where: {
          venueId,
          pin,
          staffId: { not: staffId },
          active: true,
        },
      })
      if (conflict) {
        const venueName = orgVenues.find(v => v.id === venueId)?.id || venueId
        return res.status(409).json({
          success: false,
          error: 'conflict',
          message: `El PIN ya está en uso en la sucursal ${venueName}`,
        })
      }
    }

    // Update PIN on ALL StaffVenue records for this staff in this org
    await prisma.staffVenue.updateMany({
      where: {
        staffId,
        venueId: { in: orgVenueIds },
      },
      data: { pin },
    })

    logAction({
      staffId: authContext?.userId || null,
      venueId: null,
      action: 'PIN_UPDATED',
      entity: 'Staff',
      entityId: staffId,
      data: { orgId },
    })

    res.json({ success: true, data: { message: 'PIN updated across all venues' } })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /dashboard/organizations/:orgId/team/:staffId/reset-password
 * Reset password for a staff member and return a temporary password.
 */
router.post('/team/:staffId/reset-password', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, staffId } = req.params
    const authContext = (req as any).authContext

    const result = await organizationDashboardService.resetUserPassword(orgId, staffId)

    logAction({
      staffId: authContext?.userId || null,
      venueId: null,
      action: 'PASSWORD_RESET',
      entity: 'Staff',
      entityId: staffId,
      data: { orgId },
    })

    res.json({
      success: true,
      data: {
        temporaryPassword: result.tempPassword,
        message: result.message,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/organizations/:orgId/team/:staffId/activity
 * Returns activity log entries for a specific staff member across all org venues.
 */
router.get('/team/:staffId/activity', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, staffId } = req.params

    // Get all org venue IDs to query activity across all venues
    const orgVenues = await prisma.venue.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    })
    const orgVenueIds = orgVenues.map(v => v.id)

    const logs = await prisma.activityLog.findMany({
      where: {
        entity: 'Staff',
        entityId: staffId,
        OR: [{ venueId: { in: orgVenueIds } }, { venueId: null }],
      },
      include: {
        staff: {
          select: { firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    const data = logs.map(log => ({
      id: log.id,
      action: log.action,
      performedBy: log.staff ? `${log.staff.firstName} ${log.staff.lastName}`.trim() : 'Sistema',
      data: log.data,
      createdAt: log.createdAt.toISOString(),
    }))

    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/organizations/:orgId/zones
 * Get zones for the org (for venue grouping in UI).
 */
router.get('/zones', orgOwnerAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params

    const zones = await prisma.zone.findMany({
      where: { organizationId: orgId },
      include: {
        venues: {
          select: { id: true, name: true, slug: true },
        },
      },
      orderBy: { name: 'asc' },
    })

    res.json({ success: true, data: zones })
  } catch (error) {
    next(error)
  }
})

export default router
