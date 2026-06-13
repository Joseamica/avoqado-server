import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { hasPermission } from '@/services/access/access.service'
import type { McpScope } from '../scope'
import { ScopeError } from '../guard'
import { text } from '../respond'
import {
  getOrgSalesSummary,
  getSalesByMonth,
  getSalesByCity,
  getSalesByStore,
  getSalesBySupervisor,
  getSalesByPromoter,
  getSalesByPromoterDaily,
  parseRange,
} from '@/services/dashboard/sale-verification.org.dashboard.service'

/**
 * Org-level CONFIRMED-sales reporting (PlayTelecom / serialized-inventory
 * back-office). Mirrors the dashboard "Ventas" executive view: every grouping
 * counts only SaleVerification.status=COMPLETED ("ventas confirmadas") — sales
 * still under review never inflate these numbers.
 */
export function registerSaleVerificationTools(server: McpServer, scope: McpScope) {
  /** Same gate as the dashboard routes: `sale-verifications:review` on at least one venue of the active org. */
  function requireReviewAccess(): void {
    for (const access of scope.perVenueAccess.values()) {
      if (access.organizationId === scope.activeOrg && hasPermission(access, 'sale-verifications:review')) return
    }
    throw new ScopeError('Missing permission sale-verifications:review in this organization')
  }

  server.tool(
    'org_confirmed_sales_report',
    'CONFIRMED sales report for the connected organization (serialized-inventory / PlayTelecom back-office). Only counts sales whose back-office verification is COMPLETED ("venta correcta") — sales "en revisión" or without evidence are EXCLUDED from every figure. groupBy: "summary" (KPIs incl. confirmedRevenue + pending/failed counters), "month", "city", "store", "supervisor" (the venue MANAGER responsible), "promoter" (the staff who sold, monthly), or "promoterDaily" (CURRENT MONTH only — per promoter per day, plus a `toReview` count of FAILED sales the promoter must fix on the TPV, which are NOT in the total). Answers "¿cuántas ventas confirmadas llevamos por ciudad/tienda/promotor? ¿cuáles tiene que corregir cada promotor?". Optional fromDate/toDate (YYYY-MM-DD) limit the window (ignored for promoterDaily); omit for full history.',
    {
      groupBy: z
        .enum(['summary', 'month', 'city', 'store', 'supervisor', 'promoter', 'promoterDaily'])
        .describe('Aggregation: summary KPIs, or confirmed sales grouped by month / city / store / supervisor / promoter / promoterDaily (current month, per day + toReview)'),
      fromDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Window start (YYYY-MM-DD, venue timezone). Omit for full history'),
      toDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Window end (YYYY-MM-DD, venue timezone). Omit for full history'),
    },
    async ({ groupBy, fromDate, toDate }) => {
      requireReviewAccess()
      const orgId = scope.activeOrg
      const range = parseRange(fromDate, toDate)

      switch (groupBy) {
        case 'summary':
          return text(await getOrgSalesSummary(orgId, range))
        case 'month':
          return text(await getSalesByMonth(orgId, range))
        case 'city':
          return text(await getSalesByCity(orgId, range))
        case 'store':
          return text(await getSalesByStore(orgId, range))
        case 'supervisor':
          return text(await getSalesBySupervisor(orgId, range))
        case 'promoter':
          return text(await getSalesByPromoter(orgId, range))
        case 'promoterDaily':
          return text(await getSalesByPromoterDaily(orgId))
      }
    },
  )
}
