import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { text } from '../respond'
import type { McpScope } from '../scope'
import { createGuard, ScopeError } from '../guard'
import { hasPermission } from '@/services/access/access.service'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'
import { commandCenterService } from '@/services/command-center/commandCenter.service'
import { promotersService } from '@/services/promoters/promoters.service'
import { ROLE_HIERARCHY } from '@/lib/permissions'
import { StaffRole } from '@prisma/client'

const WL_OFF_MSG = 'Esta función es solo para locales white-label (módulo WHITE_LABEL_DASHBOARD apagado).'

export function registerWhiteLabelOpsTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  /** Same gate as the dashboard's org-level attendance/team screens: teams:read on at least one venue of the active org. */
  function requireOrgTeamsRead(): string {
    for (const access of scope.perVenueAccess.values()) {
      if (access.organizationId === scope.activeOrg && hasPermission(access, 'teams:read')) return scope.activeOrg
    }
    throw new ScopeError('Missing permission teams:read in this organization')
  }

  // Highest role the caller holds in the active org (for services that role-scope visibility).
  function callerOrgRole(): string {
    if (scope.isSuperAdmin) return StaffRole.SUPERADMIN
    let best: StaffRole | null = null
    for (const access of scope.perVenueAccess.values()) {
      if (access.organizationId !== scope.activeOrg) continue
      if (best === null || ROLE_HIERARCHY[access.role] > ROLE_HIERARCHY[best]) best = access.role
    }
    return best ?? StaffRole.VIEWER
  }

  server.tool(
    'promoter_deposits',
    'Depósitos de efectivo de un promotor (para validación). Filtra por status (PENDING = pendientes de aprobar). Solo white-label. Pass venueId + promoterId.',
    {
      venueId: z.string().describe('Venue where the promoter works (must be in your scope)'),
      promoterId: z.string().describe('Staff id of the promoter'),
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional().describe('Filter deposits by status'),
    },
    async ({ venueId, promoterId, status }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('teams:read', venueId)

      const whiteLabelActive = await moduleService.isModuleEnabled(venueId, MODULE_CODES.WHITE_LABEL_DASHBOARD)
      if (!whiteLabelActive) return text({ ok: false, moduleRequired: true, error: WL_OFF_MSG })

      const deposits = await promotersService.getPromoterDeposits(venueId, promoterId, status)
      return text({ ok: true, venueId, promoterId, deposits })
    },
  )

  server.tool(
    'promoter_detail',
    'Perfil de un promotor con métricas de hoy, check-in de asistencia y calendario de asistencia. Solo white-label. Pass venueId + promoterId.',
    {
      venueId: z.string().describe('Venue where the promoter works (must be in your scope)'),
      promoterId: z.string().describe('Staff id of the promoter'),
    },
    async ({ venueId, promoterId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('teams:read', venueId)

      const whiteLabelActive = await moduleService.isModuleEnabled(venueId, MODULE_CODES.WHITE_LABEL_DASHBOARD)
      if (!whiteLabelActive) return text({ ok: false, moduleRequired: true, error: WL_OFF_MSG })

      const detail = await promotersService.getPromoterDetail(venueId, promoterId)
      if (!detail) return text({ ok: false, error: 'Promotor no encontrado en este local.' })
      return text({ ok: true, venueId, promoterId, ...detail })
    },
  )

  server.tool(
    'staff_attendance',
    'Asistencia del personal (check-in/out, tarde/ausente, ventas del día) de tu organización, opcionalmente filtrada por venueId/día/status. Responde "¿quién llegó/faltó/llegó tarde hoy?". White-label.',
    {
      venueId: z.string().optional().describe('Limit to one venue; omit for the whole organization'),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Single venue-local day (YYYY-MM-DD); omit for today unless fromDate/toDate given'),
      statusFilter: z.string().optional().describe('Filter by status'),
      fromDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Range start (YYYY-MM-DD); use with toDate instead of date'),
      toDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Range end (YYYY-MM-DD); use with fromDate instead of date'),
    },
    async ({ venueId, date, statusFilter, fromDate, toDate }) => {
      const orgId = requireOrgTeamsRead()
      if (venueId) {
        // The service uses a caller-supplied venueId verbatim (no org re-check), so an
        // unvalidated id would read ANOTHER tenant's attendance PII. Scope-gate it here.
        guard.venueFilter(venueId)
        guard.requirePermission('teams:read', venueId)
      }
      const result = await organizationDashboardService.getStaffAttendance(orgId, date, venueId, statusFilter, fromDate, toDate)
      return text({ ok: true, ...result })
    },
  )

  server.tool(
    'staff_online',
    'Personal actualmente en turno (con check-in y sin check-out hoy) por tienda. Responde "¿quién está trabajando ahora?". Nota: cuenta solo promotores (CASHIER/WAITER) y usa medianoche del servidor. White-label.',
    {},
    async () => {
      const orgId = requireOrgTeamsRead()
      const result = await organizationDashboardService.getOnlineStaff(orgId)
      return text({ ok: true, ...result })
    },
  )

  server.tool(
    'attendance_heatmap',
    'Matriz de asistencia (personal × día: presente/tarde/ausente) de tu organización en un rango (máx 90 días). White-label.',
    {
      fromDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Range start (YYYY-MM-DD)'),
      toDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Range end (YYYY-MM-DD); max 90 days after fromDate'),
      venueId: z.string().optional().describe('Limit to one venue; omit for the whole organization'),
    },
    async ({ fromDate, toDate, venueId }) => {
      const orgId = requireOrgTeamsRead()
      try {
        const result = await organizationDashboardService.getAttendanceHeatmap(
          orgId,
          fromDate,
          toDate,
          callerOrgRole(),
          scope.staffId,
          venueId,
        )
        return text({ ok: true, ...result })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'sales_vs_target',
    'Actual vs meta de la semana (Lun–Dom), por día. metric="revenue" (ingresos) o "volume" (número de ventas). Opcional venueId para una tienda. Responde "¿cómo vamos contra la meta esta semana?". White-label.',
    {
      metric: z.enum(['revenue', 'volume']).describe('Which metric to compare against target: revenue or volume'),
      venueId: z.string().optional().describe('Limit to one venue; omit for the whole organization'),
    },
    async ({ metric, venueId }) => {
      const orgId = requireOrgTeamsRead()
      const data =
        metric === 'revenue'
          ? await organizationDashboardService.getRevenueVsTarget(orgId, venueId)
          : await organizationDashboardService.getVolumeVsTarget(orgId, venueId)
      return text({ metric, orgId, venueId: venueId ?? null, ...data })
    },
  )

  server.tool(
    'store_anomalies',
    'Anomalías operativas por tienda hoy (sin check-ins, stock bajo, depósitos pendientes, check-in fuera de geocerca), con severidad. Responde "¿alguna tienda con algo raro?". White-label.',
    {},
    async () => {
      const orgId = requireOrgTeamsRead()
      return text({ orgId, anomalies: await organizationDashboardService.getCrossStoreAnomalies(orgId) })
    },
  )

  server.tool(
    'org_insights',
    'Tarjetas de insight del día: mejor promotor por ventas y tienda con peor asistencia. Responde "¿quién va ganando hoy? ¿qué tienda tiene peor asistencia?". White-label.',
    {},
    async () => {
      const orgId = requireOrgTeamsRead()
      const [topPromoter, worstAttendance] = await Promise.all([
        organizationDashboardService.getTopPromoter(orgId),
        organizationDashboardService.getWorstAttendance(orgId),
      ])
      return text({ orgId, topPromoter, worstAttendance })
    },
  )

  server.tool(
    'store_sales_trend',
    'Tendencia de ventas de UNA tienda en los últimos N días (ventas, unidades, transacciones por día) + comparación con el periodo previo. Responde "¿cómo va la venta de esta tienda?". White-label. Pass venueId; opcional days (default 14). (Distinto de serialized_stock_trend, que es stock de SIMs.)',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      days: z.number().int().positive().max(90).optional().describe('Number of days to look back; default 14'),
    },
    async ({ venueId, days }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('teams:read', venueId)

      const whiteLabelActive = await moduleService.isModuleEnabled(venueId, MODULE_CODES.WHITE_LABEL_DASHBOARD)
      if (!whiteLabelActive) return text({ ok: false, moduleRequired: true, error: WL_OFF_MSG })

      const result = await commandCenterService.getStockVsSales(venueId, { days: days ?? 14 })
      return text({ venueId, days: days ?? 14, ...result })
    },
  )
}
