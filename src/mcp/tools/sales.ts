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

const round2 = (n: number): number => Math.round(n * 100) / 100

export interface StaffRankingRow {
  name: string
  revenue: number
  orders: number
  tips: number
  averageTicket: number
}

/** Take the top N staff by revenue (service already sorts; re-sort defensively) and round money to cents. */
export function rankTopStaff(rows: StaffRankingRow[], limit = 10): StaffRankingRow[] {
  return [...rows]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit)
    .map(s => ({
      name: s.name,
      revenue: round2(s.revenue),
      orders: s.orders,
      tips: round2(s.tips),
      averageTicket: round2(s.averageTicket),
    }))
}

export interface CategoryMixRow {
  category: string
  revenue: number
  quantity: number
  percentage: number
}

/** Top categories by revenue (desc), rounded. The service already sorts; we re-sort defensively. */
export function rankCategories(rows: CategoryMixRow[], limit = 20): CategoryMixRow[] {
  return [...rows]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit)
    .map(c => ({ category: c.category, revenue: round2(c.revenue), quantity: c.quantity, percentage: round2(c.percentage) }))
}

export interface AnalyticsPaymentRow {
  amount: number | { toString(): string }
  method: string
}

export interface PaymentMethodTotal {
  method: string
  total: number
  count: number
}

/** Aggregate per-payment analytics rows into per-method totals (desc by total), money rounded to cents. */
export function summarizeByPaymentMethod(payments: AnalyticsPaymentRow[]): PaymentMethodTotal[] {
  const map = new Map<string, { total: number; count: number }>()
  for (const p of payments) {
    const method = p.method || 'UNKNOWN'
    const existing = map.get(method) || { total: 0, count: 0 }
    existing.total += Number(p.amount)
    existing.count += 1
    map.set(method, existing)
  }
  return Array.from(map.entries())
    .map(([method, d]) => ({ method, total: round2(d.total), count: d.count }))
    .sort((a, b) => b.total - a.total)
}

export interface ChannelMixRow {
  channel: string
  revenue: number
  count: number
  percentage: number
}

/** Top channels by revenue (desc), rounded. The service already sorts; we re-sort defensively. */
export function rankChannels(rows: ChannelMixRow[], limit = 20): ChannelMixRow[] {
  return [...rows]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit)
    .map(c => ({ channel: c.channel, revenue: round2(c.revenue), count: c.count, percentage: round2(c.percentage) }))
}

export interface PeakHourRow {
  hour: number
  sales: number
  transactions: number
}

/** Order peak-hour buckets by hour ascending (0–23, venue tz) for a readable daily profile; round sales. */
export function summarizePeakHours(rows: PeakHourRow[]): PeakHourRow[] {
  return [...rows].sort((a, b) => a.hour - b.hour).map(h => ({ hour: h.hour, sales: round2(h.sales), transactions: h.transactions }))
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

  server.tool(
    'staff_ranking',
    'Who sells the most — staff ranked by revenue in a venue you can access, over a date range (default last 7 days). Each entry: name, revenue, orders, tips, average ticket. Answers "¿quién vende más / mejor vendedor?". Pass venueId; optionally fromDate/toDate (YYYY-MM-DD) and a limit.',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      limit: z.number().int().positive().max(50).optional().describe('How many top staff to return (default 10)'),
    },
    async ({ venueId, fromDate, toDate, limit }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const ranking = (await getChartData(venueId, 'staff-ranking', { fromDate, toDate })) as StaffRankingRow[]
      const top = rankTopStaff(ranking, limit ?? 10)
      return text({ venueId, count: top.length, staff: top })
    },
  )

  server.tool(
    'category_mix',
    'Sales mix by menu category in a venue you can access, over a date range (default last 7 days): revenue, units, and % of revenue per category, ranked by revenue. Answers "¿qué categorías venden más?". Pass venueId; optionally fromDate/toDate (YYYY-MM-DD) and a limit.',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      limit: z.number().int().positive().max(50).optional().describe('How many categories to return (default 20)'),
    },
    async ({ venueId, fromDate, toDate, limit }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const rows = (await getChartData(venueId, 'category-mix', { fromDate, toDate })) as CategoryMixRow[]
      const categories = rankCategories(rows, limit ?? 20)
      return text({ venueId, count: categories.length, categories })
    },
  )

  server.tool(
    'sales_by_payment_method',
    'Sales totals grouped by payment method (cash, card, etc.) in a venue you can access, over a date range (default last 7 days): total and transaction count per method, ranked by total. Answers "¿cuánto en efectivo vs tarjeta?". Pass venueId; optionally fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
    },
    async ({ venueId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const data = (await getChartData(venueId, 'sales-by-payment-method', { fromDate, toDate })) as {
        payments: AnalyticsPaymentRow[]
      }
      const byMethod = summarizeByPaymentMethod(data.payments)
      const gross = round2(byMethod.reduce((s, m) => s + m.total, 0))
      return text({ venueId, gross, byMethod })
    },
  )

  server.tool(
    'channel_mix',
    'Sales by order channel/type (dine-in, takeout, delivery, etc.) in a venue you can access, over a date range (default last 7 days): revenue, order count, and % of revenue per channel, ranked by revenue. Pass venueId; optionally fromDate/toDate (YYYY-MM-DD) and a limit.',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      limit: z.number().int().positive().max(50).optional().describe('How many channels to return (default 20)'),
    },
    async ({ venueId, fromDate, toDate, limit }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const rows = (await getChartData(venueId, 'channel-mix', { fromDate, toDate })) as ChannelMixRow[]
      const channels = rankChannels(rows, limit ?? 20)
      return text({ venueId, count: channels.length, channels })
    },
  )

  server.tool(
    'peak_hours',
    'Busiest hours of the day in a venue you can access, over a date range (default last 7 days): sales and transaction count per hour of day (0–23, venue timezone), ordered by hour. Answers "¿cuáles son mis horas pico?". Pass venueId; optionally fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
    },
    async ({ venueId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const rows = (await getChartData(venueId, 'peak-hours', { fromDate, toDate })) as PeakHourRow[]
      const hours = summarizePeakHours(rows)
      return text({ venueId, hours })
    },
  )
}
