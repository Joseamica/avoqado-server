import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export interface SalesInput {
  amount: number | { toString(): string }
  method: string
  type: string | null
  status: string
  merchantAccountId?: string | null
}

export interface SalesSummary {
  completedCount: number
  gross: number
  byMethod: Record<string, number>
  byType: Record<string, number>
  // Card money grouped by merchant account id (cash/null excluded). Labels by id;
  // the dashboard resolves display names. Keeps the MCP in sync with the
  // sales-summary per-merchant breakdown.
  byMerchantAccount: Record<string, number>
}

/** Pure aggregation over payment rows. Only COMPLETED payments count toward totals. */
export function summarizeSales(payments: SalesInput[]): SalesSummary {
  const s: SalesSummary = { completedCount: 0, gross: 0, byMethod: {}, byType: {}, byMerchantAccount: {} }
  for (const p of payments) {
    if (p.status !== 'COMPLETED') continue
    const amt = Number(p.amount)
    s.completedCount += 1
    s.gross += amt
    s.byMethod[p.method] = (s.byMethod[p.method] ?? 0) + amt
    const t = p.type ?? 'UNKNOWN'
    s.byType[t] = (s.byType[t] ?? 0) + amt
    if (p.merchantAccountId) {
      s.byMerchantAccount[p.merchantAccountId] = (s.byMerchantAccount[p.merchantAccountId] ?? 0) + amt
    }
  }
  return s
}

export function registerSalesTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'daily_sales',
    'Sales for a day across your venues (or one venue). Returns completed-payment count, gross total, and a breakdown by payment method, type (REGULAR/FAST), and merchant account (card money by merchantAccountId; cash excluded). Defaults to today; pass venueId to focus one venue (must be in your scope).',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      date: z.string().optional().describe('ISO date YYYY-MM-DD; defaults to today (Mexico City)'),
    },
    async ({ venueId, date }) => {
      const where = guard.venueFilter(venueId) // throws if venueId is out of scope
      const ref = date ? new Date(`${date}T12:00:00`) : undefined
      const start = venueStartOfDay('America/Mexico_City', ref)
      const end = venueEndOfDay('America/Mexico_City', ref)
      const payments = await prisma.payment.findMany({
        where: { ...where, createdAt: { gte: start, lte: end } },
        select: { amount: true, method: true, type: true, status: true, merchantAccountId: true },
      })
      const summary = summarizeSales(payments as SalesInput[])
      return text({
        window: { start: start.toISOString(), end: end.toISOString() },
        venuesInScope: venueId ? 1 : scope.allowedVenueIds.length,
        ...summary,
      })
    },
  )
}
