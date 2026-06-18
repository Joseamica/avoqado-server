import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DateTime } from 'luxon'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getVenueChartData } from '../chartData'
import { fetchPaymentsForAnalytics } from '@/services/legacy/mergedPayments.service'
import { planGateMessage } from '../planGate'
import {
  computeSettlementProjection,
  getSalesSummary,
  flattenSalesSummaryForExport,
  countSalesSummaryDetailRows,
  fetchSalesSummaryDetailRows,
  type SalesSummaryExportSection,
} from '@/services/dashboard/sales-summary.dashboard.service'
import { getAvailableBalance, getBalanceByCardType } from '@/services/dashboard/availableBalance.dashboard.service'

export interface SalesInput {
  amount: number | { toString(): string }
  tipAmount?: number | { toString(): string } | null
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
  // Card money grouped by merchant account id (cash/null excluded), INCLUDING tips
  // — what actually lands in the merchant's bank. Lockstep with the dashboard's
  // per-merchant breakdown (tip-inclusive since 2026-06-10). `gross`/`byMethod`
  // stay amount-only (sale value; tips are reported by tips_over_time).
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
      const withTip = amt + Number(p.tipAmount ?? 0)
      s.byMerchantAccount[p.merchantAccountId] = (s.byMerchantAccount[p.merchantAccountId] ?? 0) + withTip
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

export interface TipPaymentRow {
  createdAt: string
  tips: Array<{ amount: number | { toString(): string } | null }>
}

export interface DailyTips {
  date: string
  tips: number
  count: number
}

/**
 * Aggregate per-payment tip rows into venue-local daily buckets (date in `timezone`),
 * plus a period total. Counts only payments that actually carried a tip; days with no
 * tips don't appear. Money rounded to cents.
 */
export function summarizeTipsByDay(payments: TipPaymentRow[], timezone: string): { total: number; count: number; byDay: DailyTips[] } {
  const map = new Map<string, { tips: number; count: number }>()
  let total = 0
  let count = 0
  for (const p of payments) {
    const tipSum = p.tips.reduce((s, t) => s + Number(t.amount), 0)
    if (tipSum <= 0) continue
    const date = DateTime.fromISO(p.createdAt, { zone: 'utc' }).setZone(timezone).toISODate() ?? 'unknown'
    const existing = map.get(date) || { tips: 0, count: 0 }
    existing.tips += tipSum
    existing.count += 1
    map.set(date, existing)
    total += tipSum
    count += 1
  }
  const byDay = Array.from(map.entries())
    .map(([date, d]) => ({ date, tips: round2(d.tips), count: d.count }))
    .sort((a, b) => a.date.localeCompare(b.date))
  return { total: round2(total), count, byDay }
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
        select: { amount: true, tipAmount: true, method: true, type: true, status: true, merchantAccountId: true },
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
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const data = (await getVenueChartData(venueId, 'best-selling-products', { fromDate, toDate })) as {
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
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const ranking = (await getVenueChartData(venueId, 'staff-ranking', { fromDate, toDate })) as StaffRankingRow[]
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
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const rows = (await getVenueChartData(venueId, 'category-mix', { fromDate, toDate })) as CategoryMixRow[]
      const categories = rankCategories(rows, limit ?? 20)
      return text({ venueId, count: categories.length, categories })
    },
  )

  server.tool(
    'sales_by_payment_method',
    'Sales by payment method (cash, card, etc.) in a venue you can access, over a date range (default last 7 days). Returns TWO figures per method so the operator can reconcile with the dashboard: `grossCollected` = everything collected (INCLUDES refunds + cancelled orders) — matches the dashboard "Métodos de Pago" panel; and `netSales` = net of refunds + cancelled orders. Answers "¿cuánto en efectivo vs tarjeta?". Dates are venue-LOCAL and the full toDate day is included. Pass venueId; optionally fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD venue-local (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD venue-local, INCLUSIVE of the whole day (default: today)'),
    },
    async ({ venueId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      // Venue-local day boundaries in real UTC — fromDate→start, toDate→END of day (inclusive).
      const tz = (await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone || 'America/Mexico_City'
      const from = fromDate
        ? venueStartOfDay(tz, new Date(`${fromDate}T12:00:00`))
        : venueStartOfDay(tz, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      const to = toDate ? venueEndOfDay(tz, new Date(`${toDate}T12:00:00`)) : venueEndOfDay(tz)

      // Two passes: gross (everything collected, incl. refunds + cancelled = dashboard panel) and net.
      const [grossRows, netRows] = await Promise.all([
        fetchPaymentsForAnalytics(venueId, { fromDate: from, toDate: to, includeRefunds: true, excludeCancelledOrders: false }),
        fetchPaymentsForAnalytics(venueId, { fromDate: from, toDate: to, includeRefunds: false, excludeCancelledOrders: true }),
      ])
      const grossByMethod = summarizeByPaymentMethod(grossRows as unknown as AnalyticsPaymentRow[])
      const netByMethod = summarizeByPaymentMethod(netRows as unknown as AnalyticsPaymentRow[])

      return text({
        venueId,
        window: { from: from.toISOString(), to: to.toISOString(), timezone: tz },
        grossCollected: { total: round2(grossByMethod.reduce((s, m) => s + m.total, 0)), byMethod: grossByMethod },
        netSales: { total: round2(netByMethod.reduce((s, m) => s + m.total, 0)), byMethod: netByMethod },
        note: 'grossCollected = todo lo cobrado por método (incluye reembolsos y órdenes canceladas) — coincide con el panel "Métodos de Pago" del dashboard. netSales = ventas netas (excluye reembolsos y canceladas).',
      })
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
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const rows = (await getVenueChartData(venueId, 'channel-mix', { fromDate, toDate })) as ChannelMixRow[]
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
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const rows = (await getVenueChartData(venueId, 'peak-hours', { fromDate, toDate })) as PeakHourRow[]
      const hours = summarizePeakHours(rows)
      return text({ venueId, hours })
    },
  )

  server.tool(
    'tips_over_time',
    'Tips collected in a venue you can access, bucketed by day (venue timezone), over a date range (default last 7 days): per-day tip total + tipped-transaction count, plus the period total. Answers "¿cómo van las propinas?". Pass venueId; optionally fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
    },
    async ({ venueId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const data = (await getVenueChartData(venueId, 'tips-over-time', { fromDate, toDate })) as { payments: TipPaymentRow[] }
      const result = summarizeTipsByDay(data.payments, tz)
      return text({ venueId, ...result })
    },
  )

  server.tool(
    'settlement_calendar',
    'When your card money lands ("¿cuándo cae mi dinero?") for a venue you can access, over a date range (default last 7 days). Estimate based on each merchant account\'s settlement rule (business days + Mexican holidays + cutoff); cash is excluded because it is immediate. Returns a per-day calendar (settlement date + status settled/pending/projected, grouped by merchant with net-to-receive and commission) plus each merchant\'s soonest settlement date. Answers "¿cuándo me depositan / cuándo cae el dinero de tarjeta?". Pass venueId; optionally fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
    },
    async ({ venueId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'El calendario de liquidación') // PRO tier (same code as the dashboard reconciliation block)
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      const start = venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      const end = venueEndOfDay(tz, toDate ? new Date(`${toDate}T12:00:00`) : undefined)
      const { calendar, nextByMerchant } = await computeSettlementProjection(venueId, start, end, tz)
      return text({
        venueId,
        window: { start: start.toISOString(), end: end.toISOString() },
        timezone: tz,
        calendar,
        nextByMerchant: Array.from(nextByMerchant.entries()).map(([merchantAccountId, v]) => ({ merchantAccountId, ...v })),
      })
    },
  )

  server.tool(
    'available_balance',
    'How much money a venue you can access actually has — "¿cuánto tengo disponible? ¿cuánto pendiente? ¿cuándo y cuánto me depositan?". Returns: availableNow (already settled, withdrawable), pendingSettlement (card money still in transit), the estimated NEXT settlement (date + amount), plus the period totalSales and totalFees. Also a per-card-type breakdown (debit/credit/amex/cash) with how much is settled vs pending and the typical settlement days — so you can see which card is slow. Cash counts as instant (0 fees) and only since the last cash closeout. Pass venueId; optionally fromDate/toDate (YYYY-MM-DD) to bound the period (default: all time). Read-only. PRO feature (ADVANCED_REPORTS) — the server enforces plan access and returns a clear message if the venue is not entitled, so do NOT pre-judge plan eligibility yourself.',
    {
      venueId: z.string().describe('Venue whose balance to read (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: all time)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
    },
    async ({ venueId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('settlements:read', venueId) // mirrors the dashboard available-balance permission gate
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'El saldo disponible') // PRO tier (same as the dashboard available-balance feature gate)
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      // Only bound the period when the operator gives a date; otherwise it's an all-time balance.
      const dateRange =
        fromDate || toDate
          ? {
              from: venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(0)),
              to: venueEndOfDay(tz, toDate ? new Date(`${toDate}T12:00:00`) : undefined),
            }
          : undefined
      const [summary, byCard] = await Promise.all([getAvailableBalance(venueId, dateRange), getBalanceByCardType(venueId, dateRange)])
      return text({
        venueId,
        timezone: tz,
        window: dateRange ? { from: dateRange.from.toISOString(), to: dateRange.to.toISOString() } : 'all-time',
        availableNow: summary.availableNow, // already settled — withdrawable
        pendingSettlement: summary.pendingSettlement, // card money still in transit
        estimatedNextSettlement: {
          date: summary.estimatedNextSettlement.date ? summary.estimatedNextSettlement.date.toISOString() : null,
          amount: summary.estimatedNextSettlement.amount,
        },
        totalSales: summary.totalSales,
        totalFees: summary.totalFees,
        byCardType: byCard.map(c => ({
          cardType: c.cardType,
          totalSales: c.totalSales,
          fees: c.fees,
          netAmount: c.netAmount,
          settledAmount: c.settledAmount,
          pendingAmount: c.pendingAmount,
          settlementDays: c.settlementDays,
          transactionCount: c.transactionCount,
        })),
      })
    },
  )

  server.tool(
    'export_sales_summary',
    'Export the sales summary for a venue you can access ("exporta mis ventas"). mode=summary returns the flattened totals + chosen sections; mode=detailed returns the matching per-transaction rows. Honors the same date range + payment-method/card-type/merchant filters as the dashboard report. Pass venueId; optionally fromDate/toDate (YYYY-MM-DD), mode, sections (comma list), paymentMethod, cardType, merchantAccountId. The server enforces plan access and returns a clear message if the venue is not entitled — do NOT pre-judge plan eligibility yourself.',
    {
      venueId: z.string().describe('Venue to export (must be in your scope)'),
      mode: z
        .enum(['summary', 'detailed'])
        .optional()
        .describe('summary totals (default) or detailed per-transaction rows (the server enforces plan access)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      sections: z
        .string()
        .optional()
        .describe('Summary sections, comma-separated: totals,paymentMethods,cardTypes,merchantAccounts,byPeriod'),
      paymentMethod: z.enum(['CASH', 'CARD', 'QR_LEGACY', 'OTHER']).optional().describe('Filter to one payment bucket'),
      cardType: z.enum(['CREDIT', 'DEBIT', 'AMEX', 'INTERNATIONAL']).optional().describe('Card sub-filter (only when paymentMethod=CARD)'),
      merchantAccountId: z.string().optional().describe('Filter to one merchant account'),
    },
    async ({ venueId, mode, fromDate, toDate, sections, paymentMethod, cardType, merchantAccountId }) => {
      guard.venueFilter(venueId) // throws ScopeError if out of scope
      const reportGate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'La exportación de ventas')
      if (reportGate) return text({ ok: false, planRequired: true, error: reportGate })

      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      const start = venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      const end = venueEndOfDay(tz, toDate ? new Date(`${toDate}T12:00:00`) : undefined)
      const range = { startDate: start.toISOString(), endDate: end.toISOString() }

      if (mode === 'detailed') {
        const detailGate = await planGateMessage(venueId, 'TRANSACTION_EXPORT', 'La exportación detallada de transacciones')
        if (detailGate) return text({ ok: false, planRequired: true, error: detailGate })
        // QR_LEGACY has no per-payment representation in the Payment table (legacy QR rows live in
        // the legacy store). Letting it through would reach buildPaymentWhereFilter('QR_LEGACY'),
        // which THROWS. Mirror the HTTP controller's guard (salesSummaryExport) and reject cleanly.
        if (paymentMethod === 'QR_LEGACY') {
          return text({ ok: false, error: 'QR_LEGACY no tiene representación por transacción; usa mode=summary.' })
        }
        const filters = { ...range, paymentMethod, cardType, merchantAccountId }
        const total = await countSalesSummaryDetailRows(venueId, filters)
        const rows = await fetchSalesSummaryDetailRows(venueId, filters, 200) // cap MCP payload
        return text({ venueId, mode: 'detailed', window: range, timezone: tz, total, returned: rows.length, rows })
      }

      const requested = (sections ?? 'totals,paymentMethods')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean) as SalesSummaryExportSection[]
      // includeMerchantBreakdown: true is SAFE here (no tier leak) — the whole tool already
      // gated on ADVANCED_REPORTS via `reportGate` at the top and returned early if the venue
      // is not entitled. So by this line the venue holds ADVANCED_REPORTS (the same code that
      // unlocks byMerchantAccount). This is the MCP analogue of the report controller's
      // reconciliationAllowed gate — kept in lockstep, never an afterthought.
      const report = await getSalesSummary(venueId, {
        ...range,
        groupBy: 'paymentMethod',
        reportType: 'summary',
        timezone: tz,
        paymentMethod,
        cardType,
        merchantAccountId,
        includeMerchantBreakdown: true,
      })
      const { rows } = flattenSalesSummaryForExport(report, requested)
      return text({ venueId, mode: 'summary', window: range, timezone: tz, sections: requested, rows })
    },
  )
}
