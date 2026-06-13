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
    'CONFIRMED sales report for the connected organization (serialized-inventory / PlayTelecom back-office). Only counts sales whose back-office verification is COMPLETED ("venta correcta") — sales "en revisión" or without evidence are EXCLUDED from every figure. groupBy: "summary" (KPIs incl. confirmedRevenue + pending/failed counters), "month", "city", "store", "supervisor" (the venue MANAGER responsible), or "promoter" (the staff who sold). Monthly buckets per row where applicable. Answers "¿cuántas ventas confirmadas llevamos por ciudad/tienda/promotor mes a mes?". Optional fromDate/toDate (YYYY-MM-DD) limit the window; omit for full history.',
    {
      groupBy: z
        .enum(['summary', 'month', 'city', 'store', 'supervisor', 'promoter'])
        .describe('Aggregation: summary KPIs, or confirmed sales grouped by month / city / store / supervisor / promoter'),
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
      }
    },
  )
}
