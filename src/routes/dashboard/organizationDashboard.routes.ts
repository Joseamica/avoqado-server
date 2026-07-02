/**
 * Organization Dashboard Routes
 * Provides organization-level aggregate metrics and vision global
 * for the PlayTelecom/White-Label dashboard.
 */
import { Router, Request, Response, NextFunction } from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { validateRequest } from '../../middlewares/validation'
import { organizationDashboardService } from '../../services/organization-dashboard/organizationDashboard.service'
import * as orgTerminalsService from '../../services/organization-dashboard/orgTerminals.service'
import * as orgVenueAccessService from '../../services/organization-dashboard/orgVenueAccess.service'
import { grantVenueAccessSchema, listCandidatesSchema } from '../superadmin/venue-access.schemas'
import * as orgMessagesService from '../../services/organization-dashboard/orgMessages.service'
import * as activityLogService from '../../services/dashboard/activity-log.service'
import {
  GetOrgTerminalSchema,
  CreateOrgTerminalSchema,
  UpdateOrgTerminalSchema,
  DeleteOrgTerminalSchema,
  GenerateActivationCodeSchema,
  RemoteActivateSchema,
  SendOrgCommandSchema,
  BulkCommandSchema,
  AssignMerchantsSchema,
  GetOrgMerchantAccountsSchema,
  orgMigratePreflightSchema,
  orgMigrateExecuteSchema,
  orgMigrateStatusSchema,
  orgMigrateCancelSchema,
} from '../../schemas/dashboard/orgTerminals.schema'
import prisma from '../../utils/prismaClient'

const router = Router()

/**
 * Middleware to verify user has access to the organization
 */
async function checkOrgAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const { orgId, role } = (req as any).authContext
    const requestedOrgId = req.params.orgId

    // SUPERADMIN has access to all organizations
    if (role === 'SUPERADMIN') {
      return next()
    }

    // User must belong to the organization they're querying
    if (orgId !== requestedOrgId) {
      return res.status(403).json({
        success: false,
        error: 'access_denied',
        message: 'You do not have access to this organization',
      })
    }

    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Middleware to verify the requester is an OWNER of the organization.
 *
 * MUST be placed AFTER `checkOrgAccess` — that middleware proves org membership,
 * this one tightens it to OWNER for money-critical / destructive operations
 * (e.g. terminal migration, which factory-resets a payment terminal).
 *
 * SUPERADMIN bypasses (same as `checkOrgAccess`). For everyone else we require
 * an explicit, active OWNER row in `StaffOrganization` for this exact org — the
 * org-level `OrgRole`, not a venue role. This is the authoritative OWNER check;
 * the service-layer venue-in-org validators are the defense-in-depth behind it.
 */
export async function requireOrgOwner(req: Request, res: Response, next: NextFunction) {
  try {
    const authContext = (req as any).authContext
    const orgId = req.params.orgId

    // SUPERADMIN has full access to all organizations.
    if (authContext?.role === 'SUPERADMIN') {
      return next()
    }

    const ownership = await prisma.staffOrganization.findFirst({
      where: {
        staffId: authContext?.userId,
        organizationId: orgId,
        isActive: true,
        role: 'OWNER',
      },
      select: { id: true },
    })

    if (!ownership) {
      return res.status(403).json({
        success: false,
        error: 'owner_required',
        message: 'Solo el propietario de la organización puede migrar terminales.',
      })
    }

    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Middleware: require a SUPERVISOR-or-above role for the target organization.
 * Used for fleet-affecting terminal operations (create/delete terminal, bulk
 * commands, org-wide broadcast/message). `checkOrgAccess` alone only proves
 * membership, which would let a floor employee (cashier/waiter/promoter) provision
 * terminals or message the whole fleet.
 *
 * "Supervisor or above" = holds StaffRole MANAGER/ADMIN/OWNER/SUPERADMIN in ANY
 * venue of the org (supervisors are venue-level MANAGER but org-level MEMBER, so an
 * OrgRole-only check would wrongly block them), OR is an org-level OWNER/ADMIN.
 * SUPERADMIN bypasses. Floor staff (WAITER, CASHIER, HOST, VIEWER) are blocked.
 */
async function requireOrgManager(req: Request, res: Response, next: NextFunction) {
  try {
    const authContext = (req as any).authContext
    const orgId = req.params.orgId

    if (authContext?.role === 'SUPERADMIN') return next()

    const [venueRole, orgRole] = await Promise.all([
      prisma.staffVenue.findFirst({
        where: {
          staffId: authContext?.userId,
          active: true,
          venue: { organizationId: orgId },
          role: { in: ['SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER'] },
        },
        select: { id: true },
      }),
      prisma.staffOrganization.findFirst({
        where: {
          staffId: authContext?.userId,
          organizationId: orgId,
          isActive: true,
          role: { in: ['OWNER', 'ADMIN'] },
        },
        select: { id: true },
      }),
    ])

    if (!venueRole && !orgRole) {
      return res.status(403).json({ success: false, error: 'insufficient_role', message: 'Se requiere rol de supervisor o superior' })
    }

    next()
  } catch (error) {
    next(error)
  }
}

/**
 * Middleware: require an ADMIN-or-above role for the target organization — a
 * STRICTER floor than requireOrgManager (which also allows supervisors/MANAGER).
 * Used for the most destructive fleet op: DELETING a payment terminal. Supervisors
 * may message / command / create terminals, but only admins/owners may delete one.
 *
 * "Admin or above" = holds StaffRole ADMIN/OWNER/SUPERADMIN in ANY venue of the
 * org, OR is an org-level OWNER/ADMIN. SUPERADMIN bypasses. MANAGER (supervisor)
 * and floor staff are blocked.
 */
async function requireOrgAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const authContext = (req as any).authContext
    const orgId = req.params.orgId

    if (authContext?.role === 'SUPERADMIN') return next()

    const [venueRole, orgRole] = await Promise.all([
      prisma.staffVenue.findFirst({
        where: {
          staffId: authContext?.userId,
          active: true,
          venue: { organizationId: orgId },
          role: { in: ['SUPERADMIN', 'OWNER', 'ADMIN'] },
        },
        select: { id: true },
      }),
      prisma.staffOrganization.findFirst({
        where: {
          staffId: authContext?.userId,
          organizationId: orgId,
          isActive: true,
          role: { in: ['OWNER', 'ADMIN'] },
        },
        select: { id: true },
      }),
    ])

    if (!venueRole && !orgRole) {
      return res.status(403).json({ success: false, error: 'admin_required', message: 'Se requiere rol de administrador o superior' })
    }

    next()
  } catch (error) {
    next(error)
  }
}

/**
 * GET /dashboard/organizations/:orgId/vision-global
 * Returns: Aggregate KPIs across all venues in the organization
 */
router.get(
  '/:orgId/vision-global',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params

      const summary = await organizationDashboardService.getVisionGlobalSummary(orgId)

      res.json({
        success: true,
        data: summary,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/store-performance
 * Returns: Store performance ranking
 * Query: limit (default 10)
 */
router.get(
  '/:orgId/store-performance',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const { limit = '10' } = req.query

      const performance = await organizationDashboardService.getStorePerformance(orgId, parseInt(limit as string, 10))

      res.json({
        success: true,
        data: {
          stores: performance,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/anomalies
 * Returns: Cross-store operational anomalies
 */
router.get('/:orgId/anomalies', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params

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
 * GET /dashboard/organizations/:orgId/managers
 * Returns: List of managers in the organization
 */
router.get('/:orgId/managers', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params

    const managers = await organizationDashboardService.getOrgManagers(orgId)

    res.json({
      success: true,
      data: {
        managers,
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/organizations/:orgId/managers/:managerId
 * Returns: Manager dashboard with assigned stores and metrics
 */
router.get(
  '/:orgId/managers/:managerId',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, managerId } = req.params

      const dashboard = await organizationDashboardService.getManagerDashboard(orgId, managerId)

      if (!dashboard) {
        return res.status(404).json({
          success: false,
          error: 'not_found',
          message: 'Manager not found in this organization',
        })
      }

      res.json({
        success: true,
        data: dashboard,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/staff/online
 * Returns: Online staff count and details (staff with active TimeEntry)
 */
router.get('/:orgId/staff/online', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params

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
 * GET /dashboard/organizations/:orgId/activity-feed
 * Returns: Real-time activity feed (sales, check-ins, alerts)
 * Query: limit (default 50)
 */
router.get(
  '/:orgId/activity-feed',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const { limit = '50' } = req.query

      const activityFeed = await organizationDashboardService.getActivityFeed(orgId, parseInt(limit as string, 10))

      res.json({
        success: true,
        data: activityFeed,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/stock-summary
 * Returns: Organization-wide stock summary
 */
router.get(
  '/:orgId/stock-summary',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params

      const stockSummary = await organizationDashboardService.getOrgStockSummary(orgId)

      res.json({
        success: true,
        data: stockSummary,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/charts/revenue-vs-target
 * Returns: Revenue vs target chart data for current week
 */
router.get(
  '/:orgId/charts/revenue-vs-target',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const venueId = typeof req.query.venueId === 'string' ? req.query.venueId : undefined
      const chartData = await organizationDashboardService.getRevenueVsTarget(orgId, venueId)

      res.json({
        success: true,
        data: chartData,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/charts/volume-vs-target
 * Returns: Volume vs target chart data for current week
 */
router.get(
  '/:orgId/charts/volume-vs-target',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const venueId = typeof req.query.venueId === 'string' ? req.query.venueId : undefined
      const chartData = await organizationDashboardService.getVolumeVsTarget(orgId, venueId)

      res.json({
        success: true,
        data: chartData,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/insights/top-promoter
 * Returns: Top promoter by sales count today
 */
router.get(
  '/:orgId/insights/top-promoter',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params

      const topPromoter = await organizationDashboardService.getTopPromoter(orgId)

      res.json({
        success: true,
        data: topPromoter,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/insights/worst-attendance
 * Returns: Store with worst attendance (lowest percentage of active staff)
 */
router.get(
  '/:orgId/insights/worst-attendance',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params

      const worstAttendance = await organizationDashboardService.getWorstAttendance(orgId)

      res.json({
        success: true,
        data: worstAttendance,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * PUT /dashboard/organizations/:orgId/goals
 * Update or create goals for a specific period
 * Body: { period, periodDate, salesTarget, volumeTarget }
 */
router.put('/:orgId/goals', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const { period, periodDate, salesTarget, volumeTarget } = req.body

    if (!period || !periodDate || !salesTarget || !volumeTarget) {
      return res.status(400).json({
        success: false,
        error: 'missing_fields',
        message: 'period, periodDate, salesTarget, and volumeTarget are required',
      })
    }

    const goal = await organizationDashboardService.updateOrganizationGoal(orgId, period, new Date(periodDate), salesTarget, volumeTarget)

    res.json({
      success: true,
      data: goal,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/organizations/:orgId/staff/attendance
 * Returns: Staff attendance with TimeEntry data for audit
 * Query: date (ISO date), venueId (optional), status (optional: ACTIVE/INACTIVE)
 */
router.get(
  '/:orgId/staff/attendance',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const { date, venueId, status, startDate, endDate } = req.query

      const attendance = await organizationDashboardService.getStaffAttendance(
        orgId,
        date as string | undefined,
        venueId as string | undefined,
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
  },
)

/**
 * GET /dashboard/organizations/:orgId/staff/:staffId/sales-trend
 * Returns: Sales trend for staff member (last 7 days)
 */
router.get(
  '/:orgId/staff/:staffId/sales-trend',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, staffId } = req.params

      const salesTrend = await organizationDashboardService.getStaffSalesTrend(orgId, staffId)

      res.json({
        success: true,
        data: salesTrend,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/staff/:staffId/sales-mix
 * Returns: Sales mix by category for staff member
 */
router.get(
  '/:orgId/staff/:staffId/sales-mix',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, staffId } = req.params

      const salesMix = await organizationDashboardService.getStaffSalesMix(orgId, staffId)

      res.json({
        success: true,
        data: salesMix,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/staff/:staffId/attendance-calendar
 * Returns: Attendance calendar for current month
 */
router.get(
  '/:orgId/staff/:staffId/attendance-calendar',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, staffId } = req.params

      const calendar = await organizationDashboardService.getStaffAttendanceCalendar(orgId, staffId)

      res.json({
        success: true,
        data: calendar,
      })
    } catch (error) {
      next(error)
    }
  },
)

// ==========================================
// TIME ENTRY VALIDATION (Manager approve/reject)
// ==========================================

/**
 * PATCH /dashboard/organizations/:orgId/time-entries/:timeEntryId/validate
 * Body: { status: 'APPROVED' | 'REJECTED', note?: string }
 */
router.patch(
  '/:orgId/time-entries/:timeEntryId/validate',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, timeEntryId } = req.params
      const { status, note } = req.body
      const { userId } = (req as any).authContext

      if (!status || !['APPROVED', 'REJECTED'].includes(status)) {
        return res.status(400).json({
          success: false,
          error: 'invalid_status',
          message: 'status must be APPROVED or REJECTED',
        })
      }

      const updated = await organizationDashboardService.validateTimeEntry(timeEntryId, orgId, userId, status, note)

      res.json({
        success: true,
        data: updated,
      })
    } catch (error) {
      next(error)
    }
  },
)

// ==========================================
// ZONES CRUD (Geographic grouping of venues)
// ==========================================

/**
 * GET /dashboard/organizations/:orgId/zones
 */
router.get('/:orgId/zones', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const zones = await organizationDashboardService.getZones(orgId)
    res.json({ success: true, data: { zones } })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /dashboard/organizations/:orgId/zones
 * Body: { name: string, slug: string }
 */
router.post('/:orgId/zones', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const { name, slug } = req.body

    if (!name || !slug) {
      return res.status(400).json({ success: false, error: 'missing_fields', message: 'name and slug are required' })
    }

    const zone = await organizationDashboardService.createZone(orgId, name, slug)
    res.status(201).json({ success: true, data: zone })
  } catch (error) {
    next(error)
  }
})

/**
 * PUT /dashboard/organizations/:orgId/zones/:zoneId
 * Body: { name?: string, slug?: string }
 */
router.put(
  '/:orgId/zones/:zoneId',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zoneId } = req.params
      const { name, slug } = req.body

      const zone = await organizationDashboardService.updateZone(zoneId, { name, slug })
      res.json({ success: true, data: zone })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * DELETE /dashboard/organizations/:orgId/zones/:zoneId
 */
router.delete(
  '/:orgId/zones/:zoneId',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { zoneId } = req.params
      await organizationDashboardService.deleteZone(zoneId)
      res.json({ success: true })
    } catch (error) {
      next(error)
    }
  },
)

// ==========================================
// TERMINALS (Read-Only Fleet View)
// ==========================================

/**
 * GET /dashboard/organizations/:orgId/terminals
 * Returns: All terminals across org venues with filters, sort, and pagination.
 *
 * Query:
 *   page, pageSize
 *   venueId    comma-separated list of venue ids
 *   status     comma-separated list of TerminalStatus values
 *   type       comma-separated list of TerminalType values
 *   versionStatus  comma-separated list of: upToDate | outdated | unknown
 *   search     case-insensitive contains on name, serial, brand, model, venue.name
 *   sortBy     one of: name | lastHeartbeat | status | type | brand | createdAt | latestHealthScore | venue.name
 *   sortOrder  asc | desc
 */
const SORT_BY_WHITELIST = new Set(['name', 'lastHeartbeat', 'status', 'type', 'brand', 'createdAt', 'latestHealthScore', 'venue.name'])

function parseListParam(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const items = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

router.get('/:orgId/terminals', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const { page, pageSize, venueId, status, type, versionStatus, search, sortBy, sortOrder } = req.query

    const sortByValue = typeof sortBy === 'string' && SORT_BY_WHITELIST.has(sortBy) ? sortBy : undefined
    const sortOrderValue = sortOrder === 'asc' || sortOrder === 'desc' ? sortOrder : undefined

    const result = await organizationDashboardService.getOrgTerminals(orgId, {
      page: page ? parseInt(page as string, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize as string, 10) : undefined,
      venueIds: parseListParam(venueId),
      statuses: parseListParam(status),
      types: parseListParam(type),
      versionStatuses: parseListParam(versionStatus),
      search: typeof search === 'string' ? search : undefined,
      sortBy: sortByValue,
      sortOrder: sortOrderValue,
    })

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
})

// ==========================================
// TERMINAL MANAGEMENT (Org-Level CRUD + Commands)
// ==========================================

/**
 * GET /dashboard/organizations/:orgId/terminals/app-versions?environment=PRODUCTION
 * Lists active TPV app versions for the given environment (newest first) so an
 * OWNER can pick a version to push via the "Actualizar" action in the drawer.
 *
 * MUST be declared before the '/:terminalId' route below, otherwise Express
 * matches "app-versions" as a terminalId.
 */
router.get(
  '/:orgId/terminals/app-versions',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = typeof req.query.environment === 'string' ? req.query.environment.toUpperCase() : 'PRODUCTION'
      const environment: orgTerminalsService.AppEnvironmentParam = raw === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION'
      const versions = await orgTerminalsService.listAppVersionsForOrg(environment)
      res.json({ success: true, data: versions })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/terminals/:terminalId
 * Returns: Single terminal detail
 */
router.get(
  '/:orgId/terminals/:terminalId',
  authenticateTokenMiddleware,
  checkOrgAccess,
  validateRequest(GetOrgTerminalSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, terminalId } = req.params

      const terminal = await orgTerminalsService.getTerminalForOrg(orgId, terminalId)

      res.json({
        success: true,
        data: terminal,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /dashboard/organizations/:orgId/terminals
 * Creates a new terminal for a venue within the organization
 */
router.post(
  '/:orgId/terminals',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgManager,
  validateRequest(CreateOrgTerminalSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const { userId } = (req as any).authContext

      const result = await orgTerminalsService.createTerminalForOrg(orgId, req.body, userId)

      res.status(201).json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * PATCH /dashboard/organizations/:orgId/terminals/:terminalId
 * Updates terminal metadata
 */
router.patch(
  '/:orgId/terminals/:terminalId',
  authenticateTokenMiddleware,
  checkOrgAccess,
  validateRequest(UpdateOrgTerminalSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, terminalId } = req.params
      const { userId } = (req as any).authContext

      const terminal = await orgTerminalsService.updateTerminalForOrg(orgId, terminalId, req.body, userId)

      res.json({
        success: true,
        data: terminal,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * DELETE /dashboard/organizations/:orgId/terminals/:terminalId
 * Deletes a terminal (only if not active)
 */
router.delete(
  '/:orgId/terminals/:terminalId',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgAdmin,
  validateRequest(DeleteOrgTerminalSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, terminalId } = req.params
      const { userId } = (req as any).authContext

      await orgTerminalsService.deleteTerminalForOrg(orgId, terminalId, userId)

      res.json({
        success: true,
        data: { deleted: true },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /dashboard/organizations/:orgId/terminals/:terminalId/generate-activation-code
 * Generates activation code for a terminal
 */
router.post(
  '/:orgId/terminals/:terminalId/generate-activation-code',
  authenticateTokenMiddleware,
  checkOrgAccess,
  validateRequest(GenerateActivationCodeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, terminalId } = req.params
      const { userId } = (req as any).authContext

      const result = await orgTerminalsService.generateActivationCodeForOrg(orgId, terminalId, userId)

      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /dashboard/organizations/:orgId/terminals/:terminalId/remote-activate
 * Sends remote activation command
 */
router.post(
  '/:orgId/terminals/:terminalId/remote-activate',
  authenticateTokenMiddleware,
  checkOrgAccess,
  validateRequest(RemoteActivateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, terminalId } = req.params
      const { userId } = (req as any).authContext

      const result = await orgTerminalsService.sendRemoteActivationForOrg(orgId, terminalId, userId)

      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /dashboard/organizations/:orgId/terminals/:terminalId/command
 * Sends a remote command to a terminal (org-level safe commands only)
 */
router.post(
  '/:orgId/terminals/:terminalId/command',
  authenticateTokenMiddleware,
  checkOrgAccess,
  validateRequest(SendOrgCommandSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, terminalId } = req.params
      const { userId } = (req as any).authContext
      const { command, versionCode } = req.body

      // Get staff name for audit trail
      const staff = await (
        await import('../../utils/prismaClient')
      ).default.staff.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true },
      })
      const staffName = staff ? `${staff.firstName} ${staff.lastName}`.trim() : undefined

      const result = await orgTerminalsService.sendCommandForOrg(orgId, terminalId, command, userId, staffName, versionCode)

      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /dashboard/organizations/:orgId/terminals/bulk-command
 * Run one safe command across many terminals in a single request.
 * Response: 207 Multi-Status when any row failed, 200 otherwise.
 * Body: { terminalIds: string[] (1..100), command: SafeBulkCommand }
 */
router.post(
  '/:orgId/terminals/bulk-command',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgManager,
  validateRequest(BulkCommandSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const { userId } = (req as any).authContext
      const { terminalIds, command } = req.body as { terminalIds: string[]; command: orgTerminalsService.SafeBulkCommand }

      const staff = await (
        await import('../../utils/prismaClient')
      ).default.staff.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true },
      })
      const staffName = staff ? `${staff.firstName} ${staff.lastName}`.trim() : undefined

      const result = await orgTerminalsService.bulkCommandForOrg(orgId, terminalIds, command, userId, staffName)

      const status = result.failed > 0 ? 207 : 200
      res.status(status).json({
        success: result.failed === 0,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * PUT /dashboard/organizations/:orgId/terminals/:terminalId/merchants
 * Assigns merchant accounts to a terminal
 */
router.put(
  '/:orgId/terminals/:terminalId/merchants',
  authenticateTokenMiddleware,
  checkOrgAccess,
  validateRequest(AssignMerchantsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, terminalId } = req.params
      const { userId } = (req as any).authContext
      const { merchantIds } = req.body

      const terminal = await orgTerminalsService.assignMerchantsForOrg(orgId, terminalId, merchantIds, userId)

      res.json({
        success: true,
        data: terminal,
      })
    } catch (error) {
      next(error)
    }
  },
)

// ==========================================
// TERMINAL MIGRATION (Org OWNER-only)
// ==========================================
//
// An org OWNER can migrate a terminal ONLY from a venue they own TO another
// venue within the SAME org they own. Every route is gated:
//   checkOrgAccess   → requester belongs to (or is SUPERADMIN of) the org
//   requireOrgOwner  → requester is an active OWNER of THIS org
//   *ForOrg service  → source terminal ∈ org, dest venue ∈ org, merchants ∈ org
// The two DB-backed venue-in-org checks inside the service are the real
// security guarantee (defense in depth behind requireOrgOwner). We intentionally
// do NOT add a per-route checkPermission here — requireOrgOwner is the explicit,
// unambiguous gate and avoids the evaluation-venue fragility of permission
// checks on org-scoped routes.

/**
 * POST /dashboard/organizations/:orgId/terminals/:terminalId/migrate-preflight
 * Body: { toVenueId }
 * Returns: PreflightResult (blockers/warnings, canProceed)
 */
router.post(
  '/:orgId/terminals/:terminalId/migrate-preflight',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgOwner,
  validateRequest(orgMigratePreflightSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, terminalId } = req.params
      const { toVenueId } = req.body

      const data = await orgTerminalsService.migratePreflightForOrg(orgId, terminalId, toVenueId)

      res.json({
        success: true,
        data,
        message: 'Verificación de migración completada',
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /dashboard/organizations/:orgId/terminals/:terminalId/migrate-execute
 * Body: { toVenueId, assignedMerchantIds? }
 * Re-parents the terminal to the destination venue and queues the factory reset.
 */
router.post(
  '/:orgId/terminals/:terminalId/migrate-execute',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgOwner,
  validateRequest(orgMigrateExecuteSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, terminalId } = req.params
      const { toVenueId, assignedMerchantIds } = req.body
      const authContext = (req as any).authContext

      const actor = {
        staffId: authContext.userId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      }

      const data = await orgTerminalsService.migrateExecuteForOrg(orgId, terminalId, toVenueId, actor, assignedMerchantIds)

      res.json({
        success: true,
        data,
        message: 'Migración iniciada',
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/terminals/:terminalId/migrate-status?commandId=...
 * Returns: migration progress (delivered, rebound after wipe, confirmed).
 */
router.get(
  '/:orgId/terminals/:terminalId/migrate-status',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgOwner,
  validateRequest(orgMigrateStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, terminalId } = req.params
      const commandId = req.query.commandId as string

      const data = await orgTerminalsService.migrateStatusForOrg(orgId, terminalId, commandId)

      res.json({
        success: true,
        data,
        message: 'Estado de migración',
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /dashboard/organizations/:orgId/terminals/:terminalId/migrate-cancel
 * Cancels an in-flight migration (only while the factory reset is still PENDING/QUEUED).
 */
router.post(
  '/:orgId/terminals/:terminalId/migrate-cancel',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgOwner,
  validateRequest(orgMigrateCancelSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, terminalId } = req.params
      const authContext = (req as any).authContext

      const actor = {
        staffId: authContext.userId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      }

      const data = await orgTerminalsService.migrateCancelForOrg(orgId, terminalId, actor)

      res.json({
        success: true,
        data,
        message: 'Migración cancelada',
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/venues/:venueId/staff-access/candidates?sourceVenueId=
 * Owner-only. Lists org staff with their current role at the source venue (for
 * pre-select) + existing PIN (for auto-fill), so the owner can carry people over.
 */
router.get(
  '/:orgId/venues/:venueId/staff-access/candidates',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgOwner,
  validateRequest(listCandidatesSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, venueId } = req.params
      const { sourceVenueId } = req.query as { sourceVenueId?: string }
      const data = await orgVenueAccessService.listVenueAccessCandidatesForOrg(orgId, venueId, sourceVenueId)
      res.json({ success: true, data, message: 'Candidates listed' })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /dashboard/organizations/:orgId/venues/:venueId/staff-access
 * Owner-only. Body: { grants: [{ staffId, role, pin? }] }. Atomic batch grant —
 * gives the selected people access at the venue (role + PIN) BEFORE a terminal moves.
 */
router.post(
  '/:orgId/venues/:venueId/staff-access',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgOwner,
  validateRequest(grantVenueAccessSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, venueId } = req.params
      const { grants } = req.body
      const authContext = (req as any).authContext

      const actor = {
        staffId: authContext.userId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      }

      const data = await orgVenueAccessService.grantVenueAccessForOrg(orgId, venueId, grants, actor)

      res.json({ success: true, data, message: 'Acceso otorgado' })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/merchant-accounts
 * Returns: Merchant accounts available to the organization
 */
router.get(
  '/:orgId/merchant-accounts',
  authenticateTokenMiddleware,
  checkOrgAccess,
  validateRequest(GetOrgMerchantAccountsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params

      const merchants = await orgTerminalsService.getOrgMerchantAccounts(orgId)

      res.json({
        success: true,
        data: { merchants },
      })
    } catch (error) {
      next(error)
    }
  },
)

// ==========================================
// CLOSING REPORT EXPORT
// ==========================================

/**
 * GET /dashboard/organizations/:orgId/reports/closing-report
 * Query: date (ISO), venueId (optional)
 * Returns: XLSX file
 */
router.get(
  '/:orgId/reports/closing-report',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const { date, venueId } = req.query

      const report = await organizationDashboardService.getClosingReportData(
        orgId,
        date as string | undefined,
        venueId as string | undefined,
      )

      res.json({
        success: true,
        data: report,
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * GET /dashboard/organizations/:orgId/reports/closing-report/export
 * Query: date (ISO), venueId (optional)
 * Returns: XLSX file download
 */
router.get(
  '/:orgId/reports/closing-report/export',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const { date, venueId } = req.query

      const buffer = await organizationDashboardService.exportClosingReport(
        orgId,
        date as string | undefined,
        venueId as string | undefined,
      )

      const dateStr = (date as string) || new Date().toISOString().split('T')[0]
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename=reporte-cierre-${dateStr}.xlsx`)
      res.send(buffer)
    } catch (error) {
      next(error)
    }
  },
)

// ==========================================
// ADMIN PASSWORD RESET
// ==========================================

/**
 * POST /dashboard/organizations/:orgId/users/:userId/reset-password
 * Admin resets a user's password
 */
router.post(
  '/:orgId/users/:userId/reset-password',
  authenticateTokenMiddleware,
  checkOrgAccess,
  // Owner-only: resetting another user's password returns a temporary password and
  // is a full account-takeover primitive. checkOrgAccess alone only proves org
  // membership, so without this ANY member (a cashier/waiter) could reset the OWNER.
  requireOrgOwner,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const authContext = (req as any).authContext

      const result = await organizationDashboardService.resetUserPassword(orgId, req.params.userId, authContext?.userId)

      res.json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  },
)

// ─── Activity Log ───────────────────────────────────────────────────────────

/**
 * GET /dashboard/organizations/:orgId/activity-log
 * Query activity logs with filters and pagination
 */
router.get('/:orgId/activity-log', authenticateTokenMiddleware, checkOrgAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params
    const { venueId, staffId, action, entity, search, startDate, endDate, page, pageSize } = req.query

    const result = await activityLogService.queryActivityLogs({
      organizationId: orgId,
      venueId: venueId as string | undefined,
      staffId: staffId as string | undefined,
      action: action as string | undefined,
      entity: entity as string | undefined,
      search: search as string | undefined,
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
      page: page ? parseInt(page as string, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize as string, 10) : undefined,
    })

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /dashboard/organizations/:orgId/activity-log/actions
 * Returns distinct action types for filter dropdowns
 */
router.get(
  '/:orgId/activity-log/actions',
  authenticateTokenMiddleware,
  checkOrgAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params

      const actions = await activityLogService.getDistinctActions(orgId)

      res.json({
        success: true,
        data: actions,
      })
    } catch (error) {
      next(error)
    }
  },
)

// ==========================================
// ORG-LEVEL MESSAGE BROADCAST
// ==========================================

/**
 * POST /dashboard/organizations/:orgId/messages/broadcast
 * Broadcasts a message to ALL terminals across ALL venues in the organization
 */
router.post(
  '/:orgId/messages/broadcast',
  authenticateTokenMiddleware,
  checkOrgAccess,
  requireOrgManager,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId } = req.params
      const {
        type,
        title,
        body,
        priority,
        requiresAck,
        surveyOptions,
        surveyMultiSelect,
        actionLabel,
        actionType,
        actionPayload,
        targetType,
        targetTerminalIds,
        expiresAt,
      } = req.body

      if (!type || !title || !body || !targetType) {
        return res.status(400).json({
          success: false,
          error: 'missing_fields',
          message: 'type, title, body, and targetType are required',
        })
      }

      // Get creator info from auth context (same pattern as tpv-message controller)
      const createdBy = (req as any).user?.staffId || (req as any).user?.id || (req as any).authContext?.userId || 'unknown'
      const createdByName = (req as any).user?.firstName
        ? `${(req as any).user.firstName} ${(req as any).user.lastName || ''}`.trim()
        : 'Admin'

      const result = await orgMessagesService.broadcastOrgMessage(orgId, {
        type,
        title,
        body,
        priority,
        requiresAck,
        surveyOptions,
        surveyMultiSelect,
        actionLabel,
        actionType,
        actionPayload,
        targetType,
        targetTerminalIds,
        expiresAt,
        createdBy,
        createdByName,
      })

      res.status(201).json({
        success: true,
        data: result,
      })
    } catch (error) {
      next(error)
    }
  },
)

export default router
