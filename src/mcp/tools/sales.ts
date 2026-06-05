import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getChartData } from '@/services/dashboard/generalStats.dashboard.service'

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

export interface BestSellingProduct {
  id: string
  name: string
  type: string
  quantity: number
  price: number
}

export interface RankedProduct {
  name: string
  unitsSold: number
  unitPrice: number
  type: string
}

/** Rank best-selling products by units sold (desc) and take the top N (default 10). */
export function rankTopProducts(products: BestSellingProduct[], limit = 10): RankedProduct[] {
  return [...products]
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, limit)
    .map(p => ({ name: p.name, unitsSold: p.quantity, unitPrice: p.price, type: p.type }))
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

  server.tool(
    'top_products',
    'Best-selling menu items in a venue you can access, over a date range (defaults to the last 7 days), ranked by units sold. Answers "what sells the most?". Pass venueId; optionally fromDate/toDate (YYYY-MM-DD) and a limit.',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      limit: z.number().int().positive().max(50).optional().describe('How many top items to return (default 10)'),
    },
    async ({ venueId, fromDate, toDate, limit }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const data = (await getChartData(venueId, 'best-selling-products', { fromDate, toDate })) as {
        products: BestSellingProduct[]
      }
      const top = rankTopProducts(data.products, limit ?? 10)
      return text({ venueId, count: top.length, topProducts: top })
    },
  )
}
