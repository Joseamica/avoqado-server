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

export default router
