/**
 * Stores Analysis Routes (WHITE-LABEL)
 * Provides organization-wide store analytics at the VENUE level.
 *
 * These endpoints fetch organization data based on the venue's organizationId,
 * allowing white-label role-based access control to work properly.
 *
 * Middleware: verifyAccess with requireWhiteLabel
 * - Validates JWT authentication
 * - Ensures WHITE_LABEL_DASHBOARD module is enabled
 * - Role-based access handled by verifyAccess middleware
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { verifyAccess } from '../../middlewares/verifyAccess.middleware'
import { organizationDashboardService } from '../../services/organization-dashboard/organizationDashboard.service'
import { commandCenterService } from '../../services/command-center/commandCenter.service'
import { serializedInventoryService } from '../../services/serialized-inventory/serializedInventory.service'
import { moduleService, MODULE_CODES } from '../../services/modules/module.service'
import * as salesGoalService from '../../services/dashboard/commission/sales-goal.service'
import prisma from '../../utils/prismaClient'

// mergeParams: true allows access to :venueId from parent route
const router = Router({ mergeParams: true })

// Unified middleware for white-label stores analysis routes
const whiteLabelAccess = [authenticateTokenMiddleware, verifyAccess({ requireWhiteLabel: true })]

/**
 * Helper to get organizationId from venueId
 */
async function getOrgIdFromVenue(venueId: string): Promise<string | null> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { organizationId: true },
  })
  return venue?.organizationId || null
}

/**
 * GET /dashboard/venues/:venueId/stores-analysis/overview
 * Returns: Organization overview with aggregated metrics from all venues
 * Query: timeRange (7d|30d|90d|ytd|all), from, to
 */
router.get('/overview', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined
    const filterVenueId = typeof req.query.filterVenueId === 'string' ? req.query.filterVenueId : undefined

    const summary = await organizationDashboardService.getVisionGlobalSummary(orgId, undefined, startDate, endDate, filterVenueId)

    res.json({
      success: true,
      data: summary,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/venues
 * Returns: All venues in the organization with their metrics
 */
router.get('/venues', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const performance = await organizationDashboardService.getStorePerformance(orgId, 100)

    res.json({
      success: true,
      data: {
        venues: performance,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/stock-summary
 * Returns: Organization-wide stock summary
 */
router.get('/stock-summary', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const stockSummary = await organizationDashboardService.getOrgStockSummary(orgId)

    res.json({
      success: true,
      data: stockSummary,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/anomalies
 * Returns: Cross-store operational anomalies
 */
router.get('/anomalies', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const anomalies = await organizationDashboardService.getCrossStoreAnomalies(orgId)

    res.json({
      success: true,
      data: {
        anomalies,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/charts/revenue-vs-target
 * Returns: Revenue vs target chart data for current week
 */
router.get('/charts/revenue-vs-target', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const filterVenueId = typeof req.query.venueId === 'string' ? req.query.venueId : undefined
    const chartData = await organizationDashboardService.getRevenueVsTarget(orgId, filterVenueId)

    res.json({
      success: true,
      data: chartData,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/charts/volume-vs-target
 * Returns: Volume vs target chart data for current week
 */
router.get('/charts/volume-vs-target', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const filterVenueId = typeof req.query.venueId === 'string' ? req.query.venueId : undefined
    const chartData = await organizationDashboardService.getVolumeVsTarget(orgId, filterVenueId)

    res.json({
      success: true,
      data: chartData,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/insights/top-promoter
 * Returns: Top promoter by sales count today
 */
router.get('/insights/top-promoter', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const topPromoter = await organizationDashboardService.getTopPromoter(orgId)

    res.json({
      success: true,
      data: topPromoter,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/insights/worst-attendance
 * Returns: Store with worst attendance (lowest percentage of active staff)
 */
router.get('/insights/worst-attendance', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const worstAttendance = await organizationDashboardService.getWorstAttendance(orgId)

    res.json({
      success: true,
      data: worstAttendance,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/staff/online
 * Returns: Online staff count and details (staff with active TimeEntry)
 */
router.get('/staff/online', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const onlineStaff = await organizationDashboardService.getOnlineStaff(orgId)

    res.json({
      success: true,
      data: onlineStaff,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/activity-feed
 * Returns: Real-time activity feed (sales, check-ins, alerts)
 * Query: limit (default 50)
 */
router.get('/activity-feed', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const { limit = '50' } = req.query
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined
    const filterVenueId = typeof req.query.filterVenueId === 'string' ? req.query.filterVenueId : undefined
    const activityFeed = await organizationDashboardService.getActivityFeed(
      orgId,
      parseInt(limit as string, 10),
      startDate,
      endDate,
      filterVenueId,
    )

    res.json({
      success: true,
      data: activityFeed,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/store-performance
 * Returns: Store performance ranking with sales metrics
 * Query: limit (default 10)
 */
router.get('/store-performance', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const { limit = '10' } = req.query
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined
    const storePerformance = await organizationDashboardService.getStorePerformance(
      orgId,
      parseInt(limit as string, 10),
      undefined,
      startDate,
      endDate,
    )

    res.json({
      success: true,
      data: {
        stores: storePerformance,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/staff-attendance
 * Returns: Staff attendance with TimeEntry data
 * Query: date (ISO string), venueId (filter specific venue), status (ACTIVE|INACTIVE)
 */
router.get('/staff-attendance', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const { date, venueId: filterVenueId, status, startDate, endDate } = req.query
    const attendance = await organizationDashboardService.getStaffAttendance(
      orgId,
      date as string | undefined,
      filterVenueId as string | undefined,
      status as string | undefined,
      startDate as string | undefined,
      endDate as string | undefined,
    )

    res.json({
      success: true,
      data: attendance,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /dashboard/venues/:venueId/stores-analysis/time-entry/:timeEntryId/validate
 * Validates a time entry (approve/reject)
 * Body: { status: 'APPROVED' | 'REJECTED', note?: string }
 */
router.post('/time-entry/:timeEntryId/validate', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { timeEntryId } = req.params
    const { userId } = (req as any).authContext
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const { status, note, depositAmount } = req.body

    if (!status || !['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'invalid_status',
        message: 'Status must be APPROVED or REJECTED',
      })
    }

    const result = await organizationDashboardService.validateTimeEntry(
      timeEntryId,
      orgId,
      userId,
      status,
      note,
      depositAmount != null ? Number(depositAmount) : undefined,
    )

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /dashboard/venues/:venueId/stores-analysis/time-entry/:timeEntryId/reset-validation
 * Resets a time entry validation back to PENDING
 */
router.post('/time-entry/:timeEntryId/reset-validation', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { timeEntryId } = req.params
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const result = await organizationDashboardService.resetTimeEntryValidation(timeEntryId, orgId)

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/closing-report
 * Returns: Closing report data for Excel-style view
 * Query: date (ISO string), filterVenueId (optional)
 */
router.get('/closing-report', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const { date, venueId: filterVenueId } = req.query
    const reportData = await organizationDashboardService.getClosingReportData(
      orgId,
      date as string | undefined,
      filterVenueId as string | undefined,
    )

    res.json({
      success: true,
      data: reportData,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/closing-report/download
 * Returns: Excel file for closing report
 * Query: date (ISO string), filterVenueId (optional)
 */
router.get('/closing-report/download', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const { date, venueId: filterVenueId } = req.query
    const buffer = await organizationDashboardService.exportClosingReport(
      orgId,
      date as string | undefined,
      filterVenueId as string | undefined,
    )

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename=reporte-cierre-${new Date().toISOString().split('T')[0]}.xlsx`)
    res.send(buffer)
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/zones
 * Returns: Organization zones with their venues
 */
router.get('/zones', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const zones = await organizationDashboardService.getZones(orgId)

    res.json({
      success: true,
      data: zones,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/team
 * Returns: Organization team members
 */
router.get('/team', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    // Get all staff in the organization with their venue assignments
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
      status: 'ACTIVE', // Staff model doesn't have status field - default to active
      orgRole: so.role,
      venues: so.staff.venues.map((v: any) => ({
        id: v.venue.id,
        staffVenueId: v.id,
        name: v.venue.name,
        slug: v.venue.slug,
        role: v.role,
        active: v.active,
      })),
    }))

    res.json({
      success: true,
      data: team,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /dashboard/venues/:venueId/stores-analysis/admin/reset-password/:userId
 * Admin reset password for a user
 */
router.post('/admin/reset-password/:userId', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { userId } = req.params
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    const result = await organizationDashboardService.resetUserPassword(orgId, userId)

    // Audit log
    const authContext = (req as any).authContext
    await prisma.activityLog.create({
      data: {
        staffId: authContext?.userId || null,
        venueId,
        action: 'PASSWORD_RESET',
        entity: 'Staff',
        entityId: userId,
      },
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
 * PATCH /dashboard/venues/:venueId/stores-analysis/team/:staffId/venues
 * Sync venue assignments for a staff member within the organization.
 * Adds new assignments and deactivates removed ones.
 */
router.patch('/team/:staffId/venues', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { staffId } = req.params
    const { venueIds } = req.body as { venueIds: string[] }
    const authContext = (req as any).authContext

    if (!Array.isArray(venueIds)) {
      return res.status(400).json({ success: false, error: 'venueIds must be an array' })
    }

    const orgId = await getOrgIdFromVenue(venueId)
    if (!orgId) {
      return res.status(404).json({ success: false, error: 'Organization not found' })
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

    // Get the user's role from the requesting venue (use as default for new assignments)
    const currentVenueAssignment = currentAssignments.find(a => a.venueId === venueId)
    const defaultRole = currentVenueAssignment?.role || 'VIEWER'

    // Add new venue assignments
    for (const addVenueId of toAdd) {
      await prisma.staffVenue.upsert({
        where: { staffId_venueId: { staffId, venueId: addVenueId } },
        update: { active: true, role: defaultRole },
        create: { staffId, venueId: addVenueId, role: defaultRole, active: true },
      })

      const venueName = orgVenues.find(v => v.id === addVenueId)?.name || addVenueId
      await prisma.activityLog.create({
        data: {
          staffId: authContext?.userId || null,
          venueId,
          action: 'VENUE_ASSIGNED',
          entity: 'Staff',
          entityId: staffId,
          data: { venueId: addVenueId, venueName },
        },
      })
    }

    // Remove (deactivate) venue assignments
    for (const removeVenueId of toRemove) {
      await prisma.staffVenue.update({
        where: { staffId_venueId: { staffId, venueId: removeVenueId } },
        data: { active: false },
      })

      const venueName = orgVenues.find(v => v.id === removeVenueId)?.name || removeVenueId
      await prisma.activityLog.create({
        data: {
          staffId: authContext?.userId || null,
          venueId,
          action: 'VENUE_REMOVED',
          entity: 'Staff',
          entityId: staffId,
          data: { venueId: removeVenueId, venueName },
        },
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
 * GET /dashboard/venues/:venueId/stores-analysis/team/:staffId/activity
 * Returns activity log entries for a specific staff member
 */
router.get('/team/:staffId/activity', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { staffId } = req.params

    const logs = await prisma.activityLog.findMany({
      where: {
        entity: 'Staff',
        entityId: staffId,
        venueId,
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

// =============================================================================
// STORE-SPECIFIC ENDPOINTS
// These endpoints provide data for a specific store (venue) within the org.
// They are centralized here so STORES_ANALYSIS feature provides ALL data needed.
// =============================================================================

/**
 * GET /dashboard/venues/:venueId/stores-analysis/store/:storeId/summary
 * Returns: Sales summary for a specific store (KPIs, top sellers, category breakdown)
 * This endpoint provides the same data as /command-center/summary but under STORES_ANALYSIS access.
 */
router.get('/store/:storeId/summary', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { storeId } = req.params
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    // Verify the storeId belongs to the same organization
    const storeVenue = await prisma.venue.findUnique({
      where: { id: storeId },
      select: { organizationId: true },
    })

    if (!storeVenue || storeVenue.organizationId !== orgId) {
      return res.status(403).json({
        success: false,
        error: 'forbidden',
        message: 'Store does not belong to this organization',
      })
    }

    // Get summary using commandCenterService (same logic, centralized access)
    const summary = await commandCenterService.getSummary(storeId)

    res.json({
      success: true,
      data: summary,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/store/:storeId/sales-trend
 * Returns: Sales trend for a specific store for chart visualization
 * Query: days (default 7), startDate, endDate
 * This endpoint provides the same data as /command-center/stock-vs-sales but under STORES_ANALYSIS access.
 */
router.get('/store/:storeId/sales-trend', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { storeId } = req.params
    const { days = '7', startDate, endDate } = req.query
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    // Verify the storeId belongs to the same organization
    const storeVenue = await prisma.venue.findUnique({
      where: { id: storeId },
      select: { organizationId: true },
    })

    if (!storeVenue || storeVenue.organizationId !== orgId) {
      return res.status(403).json({
        success: false,
        error: 'forbidden',
        message: 'Store does not belong to this organization',
      })
    }

    // Get sales trend using commandCenterService (same logic, centralized access)
    const salesTrend = await commandCenterService.getStockVsSales(storeId, {
      days: parseInt(days as string, 10),
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
    })

    res.json({
      success: true,
      data: salesTrend,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/venues/:venueId/stores-analysis/store/:storeId/inventory-summary
 * Returns: Inventory summary for a specific store (categories with stock counts)
 * This endpoint provides the same data as /serialized-inventory/summary but under STORES_ANALYSIS access.
 */
router.get('/store/:storeId/inventory-summary', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { storeId } = req.params
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Organization not found for this venue',
      })
    }

    // Verify the storeId belongs to the same organization
    const storeVenue = await prisma.venue.findUnique({
      where: { id: storeId },
      select: { organizationId: true },
    })

    if (!storeVenue || storeVenue.organizationId !== orgId) {
      return res.status(403).json({
        success: false,
        error: 'forbidden',
        message: 'Store does not belong to this organization',
      })
    }

    // Check if serialized inventory module is enabled for this store
    const isEnabled = await moduleService.isModuleEnabled(storeId, MODULE_CODES.SERIALIZED_INVENTORY)
    if (!isEnabled) {
      // Return empty data instead of 403 - module may not be enabled but that's ok
      return res.json({
        success: true,
        data: {
          categories: [],
          totals: {
            available: 0,
            sold: 0,
            returned: 0,
            damaged: 0,
            total: 0,
          },
        },
      })
    }

    // Get categories with item counts (same logic as serialized-inventory/summary)
    const categories = await serializedInventoryService.getCategories(storeId)

    const summary = await Promise.all(
      categories.map(async category => {
        const { total: available } = await serializedInventoryService.listItems({
          venueId: storeId,
          categoryId: category.id,
          status: 'AVAILABLE',
          take: 0,
        })
        const { total: sold } = await serializedInventoryService.listItems({
          venueId: storeId,
          categoryId: category.id,
          status: 'SOLD',
          take: 0,
        })
        const { total: returned } = await serializedInventoryService.listItems({
          venueId: storeId,
          categoryId: category.id,
          status: 'RETURNED',
          take: 0,
        })
        const { total: damaged } = await serializedInventoryService.listItems({
          venueId: storeId,
          categoryId: category.id,
          status: 'DAMAGED',
          take: 0,
        })

        return {
          id: category.id,
          name: category.name,
          available,
          sold,
          returned,
          damaged,
          total: available + sold + returned + damaged,
        }
      }),
    )

    // Calculate totals
    const totals = summary.reduce(
      (acc, cat) => ({
        available: acc.available + cat.available,
        sold: acc.sold + cat.sold,
        returned: acc.returned + cat.returned,
        damaged: acc.damaged + cat.damaged,
        total: acc.total + cat.total,
      }),
      { available: 0, sold: 0, returned: 0, damaged: 0, total: 0 },
    )

    res.json({
      success: true,
      data: {
        categories: summary,
        totals,
      },
    })
  } catch (error) {
    next(error)
  }
})

// =============================================================================
// STORE GOAL ENDPOINTS
// These endpoints manage sales goals for child stores via the parent venue.
// They reuse salesGoalService and validate that the store belongs to the org.
// =============================================================================

/**
 * GET /dashboard/venues/:venueId/stores-analysis/store/:storeId/goals
 * Returns: Sales goals for a specific store
 */
router.get('/store/:storeId/goals', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { storeId } = req.params
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Organization not found for this venue' })
    }

    const storeVenue = await prisma.venue.findUnique({ where: { id: storeId }, select: { organizationId: true } })
    if (!storeVenue || storeVenue.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Store does not belong to this organization' })
    }

    const goals = await salesGoalService.getSalesGoals(storeId)
    res.json({ success: true, data: goals })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /dashboard/venues/:venueId/stores-analysis/store/:storeId/goals
 * Creates a new sales goal for a specific store
 */
router.post('/store/:storeId/goals', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { storeId } = req.params
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Organization not found for this venue' })
    }

    const storeVenue = await prisma.venue.findUnique({ where: { id: storeId }, select: { organizationId: true } })
    if (!storeVenue || storeVenue.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Store does not belong to this organization' })
    }

    const { staffId, goal, goalType, period } = req.body
    const created = await salesGoalService.createSalesGoal(storeId, {
      staffId: staffId ?? null,
      goal: Number(goal),
      goalType,
      period,
    })
    res.status(201).json({ success: true, data: created })
  } catch (error) {
    next(error)
  }
})

/**
 * PATCH /dashboard/venues/:venueId/stores-analysis/store/:storeId/goals/:goalId
 * Updates an existing sales goal for a specific store
 */
router.patch('/store/:storeId/goals/:goalId', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { storeId, goalId } = req.params
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Organization not found for this venue' })
    }

    const storeVenue = await prisma.venue.findUnique({ where: { id: storeId }, select: { organizationId: true } })
    if (!storeVenue || storeVenue.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Store does not belong to this organization' })
    }

    const { goal, goalType, period, active } = req.body
    const updated = await salesGoalService.updateSalesGoal(storeId, goalId, {
      ...(goal !== undefined && { goal: Number(goal) }),
      ...(goalType !== undefined && { goalType }),
      ...(period !== undefined && { period }),
      ...(active !== undefined && { active }),
    })
    res.json({ success: true, data: updated })
  } catch (error) {
    next(error)
  }
})

/**
 * DELETE /dashboard/venues/:venueId/stores-analysis/store/:storeId/goals/:goalId
 * Deletes a sales goal for a specific store
 */
router.delete('/store/:storeId/goals/:goalId', whiteLabelAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId || (req as any).authContext?.venueId
    const { storeId, goalId } = req.params
    const orgId = await getOrgIdFromVenue(venueId)

    if (!orgId) {
      return res.status(404).json({ success: false, error: 'not_found', message: 'Organization not found for this venue' })
    }

    const storeVenue = await prisma.venue.findUnique({ where: { id: storeId }, select: { organizationId: true } })
    if (!storeVenue || storeVenue.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'forbidden', message: 'Store does not belong to this organization' })
    }

    await salesGoalService.deleteSalesGoal(storeId, goalId)
    res.json({ success: true, data: { message: 'Goal deleted' } })
  } catch (error) {
    next(error)
  }
})

export default router
