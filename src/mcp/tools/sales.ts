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
import { getSettlementsLandingInWeek, venueWeekBounds } from '@/services/dashboard/settlementCalendar.dashboard.service'
import { hasPermission } from '@/services/access/access.service'

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
  // WHY: the dashboard "Métodos de Pago" panel sums amount+tipAmount, so any tool
  // claiming to match it must be able to fold tips in. Optional so amount-only
  // callers (net sales) are unaffected.
  tipAmount?: number | { toString(): string } | null
  method: string
}

export interface PaymentMethodTotal {
  method: string
  total: number
  count: number
}

/**
 * Aggregate per-payment analytics rows into per-method totals (desc by total), money rounded to cents.
 * WHY includeTips: the dashboard payment-methods panel is tips-INCLUSIVE (sales-summary
 * .dashboard.service.ts:1041 sums amount+tipAmount). "grossCollected" must pass includeTips=true
 * to actually reconcile with that panel; "netSales" leaves it false because tips are not sales.
 */
export function summarizeByPaymentMethod(payments: AnalyticsPaymentRow[], includeTips = false): PaymentMethodTotal[] {
  const map = new Map<string, { total: number; count: number }>()
  for (const p of payments) {
    const method = p.method || 'UNKNOWN'
    const existing = map.get(method) || { total: 0, count: 0 }
    existing.total += Number(p.amount) + (includeTips ? Number(p.tipAmount ?? 0) : 0)
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

export interface StaffTipPaymentRow {
  tipAmount: number | { toString(): string } | null
  processedById?: string | null
  processedByName?: string | null
}

export interface StaffTipsRow {
  staffId: string
  name: string
  tips: number
  payments: number
}

/**
 * Attribute each payment's tip to the staff who PROCESSED it (Payment.processedById) —
 * the SAME rule the cash-closeout (corte de caja) uses — ranked by tips desc. Payments
 * nobody processed (QR/self-serve, legacy) land in `unattributed`, so `total` still
 * matches tips_over_time to the cent. Counts only payments that actually carried a tip
 * (mirrors summarizeTipsByDay).
 */
export function aggregateStaffTips(payments: StaffTipPaymentRow[]): {
  total: number
  count: number
  staff: StaffTipsRow[]
  unattributed: { tips: number; payments: number }
} {
  const map = new Map<string, { name: string; tips: number; payments: number }>()
  const unattributed = { tips: 0, payments: 0 }
  let total = 0
  let count = 0
  for (const p of payments) {
    const tip = Number(p.tipAmount ?? 0)
    if (tip <= 0) continue
    total += tip
    count += 1
    if (!p.processedById) {
      unattributed.tips += tip
      unattributed.payments += 1
      continue
    }
    const existing = map.get(p.processedById) || { name: p.processedByName || 'Sin nombre', tips: 0, payments: 0 }
    existing.tips += tip
    existing.payments += 1
    map.set(p.processedById, existing)
  }
  const staff = Array.from(map.entries())
    .map(([staffId, s]) => ({ staffId, name: s.name, tips: round2(s.tips), payments: s.payments }))
    .sort((a, b) => b.tips - a.tips)
  return { total: round2(total), count, staff, unattributed: { tips: round2(unattributed.tips), payments: unattributed.payments } }
}

/**
 * YYYY-MM-DD that exists on the calendar — rejects rollover traps like 2026-02-30
 * (JS Date silently becomes March 2) and 2026-13-01 (Invalid Date → RangeError).
 * Component math only (no Date-parsing of the string), so it is host-tz-independent.
 */
const isoVenueDay = () =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido: usa YYYY-MM-DD')
    .refine(s => {
      const [y, m, d] = s.split('-').map(Number)
      return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
    }, 'Fecha inválida: no existe en el calendario')

export function registerSalesTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'daily_sales',
    'Sales for a local calendar day across your venues (or one venue). Each venue is evaluated in its own timezone, so an all-venues total does not shift Cancún/Tijuana edge-of-day payments into the wrong day. Returns completed-payment count, gross total, and a breakdown by payment method, type (REGULAR/FAST), and merchant account (card money by merchantAccountId; cash excluded). Defaults to today; pass venueId to focus one venue (must be in your scope).',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      date: z.string().optional().describe("ISO date YYYY-MM-DD; defaults to today, evaluated independently in each venue's timezone"),
    },
    async ({ venueId, date }) => {
      const where = guard.venueFilter(venueId) // throws if venueId is out of scope
      if (venueId) guard.requirePermission('analytics:read', venueId) // single-venue focus: hard-deny if the role lacks it
      // All-venues path: restrict to venues where the caller holds analytics:read (mirror the dashboard read gate),
      // so a low-role staffer can't read revenue across the org that the dashboard would 403.
      const readable = venueId
        ? [venueId]
        : scope.allowedVenueIds.filter(v => {
            const access = scope.perVenueAccess.get(v)
            return !!access && hasPermission(access, 'analytics:read')
          })
      where.venueId = { in: readable }
      // A local calendar day is a different UTC range in Cancún, CDMX and Tijuana. A focused
      // venue needs one range; an all-venues roll-up needs one (venueId + range) OR branch per
      // venue. A single CDMX range silently shifts edge-of-day sales for other Mexican zones.
      const venueRows = venueId
        ? [
            {
              id: venueId,
              timezone:
                (await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone || 'America/Mexico_City',
            },
          ]
        : await prisma.venue.findMany({ where: { id: { in: readable } }, select: { id: true, timezone: true } })
      const windows = venueRows.map(v => {
        const timezone = v.timezone || 'America/Mexico_City'
        const ref = date ? new Date(`${date}T12:00:00`) : undefined
        const start = venueStartOfDay(timezone, ref)
        const end = venueEndOfDay(timezone, ref)
        return { venueId: v.id, timezone, start, end }
      })
      const paymentWhere = venueId
        ? { ...where, createdAt: { gte: windows[0].start, lte: windows[0].end } }
        : windows.length
          ? { ...where, OR: windows.map(w => ({ venueId: w.venueId, createdAt: { gte: w.start, lte: w.end } })) }
          : { venueId: { in: [] as string[] } }
      const payments = await prisma.payment.findMany({
        where: paymentWhere,
        select: { amount: true, tipAmount: true, method: true, type: true, status: true, merchantAccountId: true },
      })
      const summary = summarizeSales(payments as SalesInput[])
      const window = venueId
        ? { start: windows[0].start.toISOString(), end: windows[0].end.toISOString(), timezone: windows[0].timezone }
        : {
            date: date ?? null,
            timezone: 'PER_VENUE',
            byVenue: windows.map(w => ({
              venueId: w.venueId,
              timezone: w.timezone,
              start: w.start.toISOString(),
              end: w.end.toISOString(),
            })),
          }
      return text({
        window,
        venuesInScope: readable.length,
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
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
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
    'Who sells the most — staff ranked by revenue in a venue you can access, over a date range (default last 7 days). Each entry: name, revenue, orders, tips, average ticket. Answers "¿quién vende más / mejor vendedor?". Revenue here is attributed to the order CREATOR and is total sales — it is NOT a commission base. ⚠️ To answer anything about COMMISSIONS ("¿cuánto de comisión le toca a X?") do NOT multiply this revenue by a rate — use the staff_commission tool (commission is paid to the SERVER, only over commissionable categories, at the tiered rate). The `tips` column is ALSO creator-attributed — for what an employee actually COLLECTED in tips ("¿cuánta propina le toca a X?") use the staff_tips tool (tips follow the payment PROCESSOR, same rule as the cash-closeout), never this column. Pass venueId; optionally fromDate/toDate (YYYY-MM-DD) and a limit.',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      limit: z.number().int().positive().max(50).optional().describe('How many top staff to return (default 10)'),
    },
    async ({ venueId, fromDate, toDate, limit }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
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
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const rows = (await getVenueChartData(venueId, 'category-mix', { fromDate, toDate })) as CategoryMixRow[]
      const categories = rankCategories(rows, limit ?? 20)
      return text({ venueId, count: categories.length, categories })
    },
  )

  server.tool(
    'sales_by_payment_method',
    'Sales by payment method (cash, card, etc.) in a venue you can access, over a date range (default last 7 days). Returns TWO figures per method: `grossCollected` = everything that landed by method INCLUDING tips, net of refunds (refunds are negative Payment rows) and including cancelled orders — this is the figure that reconciles 1:1 with the dashboard "Métodos de Pago" panel. `netSales` = net SALES: sale value minus refunds, EXCLUDING cancelled orders and EXCLUDING tips. The difference is net tips plus the net contribution of cancelled-order payments; do not assume either figure is always greater. Answers "¿cuánto en efectivo vs tarjeta?". Dates are venue-LOCAL and the full toDate day is included. Pass venueId; optionally fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD venue-local (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD venue-local, INCLUSIVE of the whole day (default: today)'),
    },
    async ({ venueId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      // Venue-local day boundaries in real UTC — fromDate→start, toDate→END of day (inclusive).
      const tz = (await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone || 'America/Mexico_City'
      const from = fromDate
        ? venueStartOfDay(tz, new Date(`${fromDate}T12:00:00`))
        : venueStartOfDay(tz, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      const to = toDate ? venueEndOfDay(tz, new Date(`${toDate}T12:00:00`)) : venueEndOfDay(tz)

      // Two passes with DIFFERENT filters, one per figure — WHY each flag is set this way:
      // - grossCollected: includeRefunds=true (subtract refund negatives) + includeCancelled
      //   (excludeCancelledOrders=false) EXACTLY mirrors the dashboard panel query
      //   (COMPLETED, no order-status filter), so the two reconcile 1:1.
      // - netSales: includeRefunds=true too — the OLD code left this false, which meant
      //   "netSales" never actually subtracted refunds (the bug: a field labeled "net of
      //   refunds" that ignored them). excludeCancelledOrders=true keeps it a clean sales figure.
      const [grossRows, netRows] = await Promise.all([
        fetchPaymentsForAnalytics(venueId, { fromDate: from, toDate: to, includeRefunds: true, excludeCancelledOrders: false }),
        fetchPaymentsForAnalytics(venueId, { fromDate: from, toDate: to, includeRefunds: true, excludeCancelledOrders: true }),
      ])
      // grossCollected is tips-INCLUSIVE (true) to match the dashboard panel; netSales is
      // amount-only (false) because tips are not sales revenue.
      const grossByMethod = summarizeByPaymentMethod(grossRows as unknown as AnalyticsPaymentRow[], true)
      const netByMethod = summarizeByPaymentMethod(netRows as unknown as AnalyticsPaymentRow[], false)

      return text({
        venueId,
        window: { from: from.toISOString(), to: to.toISOString(), timezone: tz },
        grossCollected: { total: round2(grossByMethod.reduce((s, m) => s + m.total, 0)), byMethod: grossByMethod },
        netSales: { total: round2(netByMethod.reduce((s, m) => s + m.total, 0)), byMethod: netByMethod },
        note: 'grossCollected = todo lo que entró por método INCLUYENDO propinas, ya neteados los reembolsos (filas negativas) e incluyendo órdenes canceladas — cuadra 1:1 con el panel "Métodos de Pago" del dashboard. netSales = ventas netas: valor de venta menos reembolsos, SIN canceladas y SIN propinas.',
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
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
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
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Los reportes avanzados') // PRO tier
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const rows = (await getVenueChartData(venueId, 'peak-hours', { fromDate, toDate })) as PeakHourRow[]
      const hours = summarizePeakHours(rows)
      return text({ venueId, hours })
    },
  )

  server.tool(
    'tips_over_time',
    'Tips collected in a venue you can access, bucketed by day (venue timezone), over a date range (default last 7 days): per-day tip total + tipped-transaction count, plus the period total. Answers "¿cómo van las propinas?". VENUE-level only — for tips PER EMPLOYEE ("¿cuánta propina le toca a X?") use the staff_tips tool, never split this total yourself. Pass venueId; optionally fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
    },
    async ({ venueId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
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
    'staff_tips',
    'Tips each employee COLLECTED in a venue you can access, over a date range (default last 7 days) — the SOURCE OF TRUTH for per-employee tips. Attribution rule: each payment\'s tip goes to the staff who PROCESSED that payment (Payment.processedById), the SAME rule as the cash-closeout ("corte de caja"), so figures match what the venue already reviews there. Per staff: total tips + tipped-payment count; QR/self-serve payments nobody processed appear under `unattributed`; `total` equals tips_over_time for the same window. Answers "¿cuánta propina le toca a X? / propinas por empleado". ⚠️ Do NOT answer per-employee tip questions from staff_ranking — its `tips` column is attributed to the order CREATOR (a different rule) and is NOT what an employee collected. Pass venueId; optionally staffId, fromDate/toDate (YYYY-MM-DD, venue-local, toDate inclusive).',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      staffId: z.string().optional().describe('Focus one employee; omit for all staff'),
      fromDate: isoVenueDay().optional().describe('Start date YYYY-MM-DD venue-local (default: 7 days ago)'),
      toDate: isoVenueDay().optional().describe('End date YYYY-MM-DD venue-local, INCLUSIVE of the whole day (default: today)'),
    },
    async ({ venueId, staffId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'Las propinas por empleado') // PRO tier — same family as staff_ranking/tips_over_time
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const tz = (await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone || 'America/Mexico_City'
      // Explicit dates: venue-local day boundaries (noon anchor — same construction as
      // getVenueChartData). Omitted dates: rolling last-7-days instants, mirroring
      // tips_over_time's parseDateRange fall-through — so `total == tips_over_time`
      // holds with AND without dates.
      const from = fromDate ? venueStartOfDay(tz, new Date(`${fromDate}T12:00:00`)) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const to = toDate ? venueEndOfDay(tz, new Date(`${toDate}T12:00:00`)) : new Date()
      // Same payment universe as tips_over_time (COMPLETED, no refunds, no cancelled orders,
      // MindForm legacy QR included) so both tools cuadran to the cent.
      const payments = await fetchPaymentsForAnalytics(venueId, { fromDate: from, toDate: to })
      const result = aggregateStaffTips(payments)
      const staff = staffId ? result.staff.filter(s => s.staffId === staffId) : result.staff
      return text({
        venueId,
        window: { from: from.toISOString(), to: to.toISOString(), timezone: tz },
        total: result.total, // venue total for the window (== tips_over_time), even when staffId narrows `staff`
        tippedPayments: result.count,
        staff,
        unattributed: result.unattributed,
        note: 'Propina atribuida a quien COBRÓ cada pago (Payment.processedById) — la misma regla que el corte de caja. `unattributed` = pagos sin cajero (QR/autoservicio). NO uses los "tips" de staff_ranking para esta pregunta (ésos van al creador de la orden).',
      })
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
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
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
    'settlement_week',
    'How much card money LANDS in the bank on each day of a Monday–Sunday week ("¿cuánto me cae cada día esta semana?") for a venue you can access. By SETTLEMENT date: a Friday sale that settles Monday shows on Monday, regardless of when it was sold. Recomputed live via the corrected settlement engine (business days + Mexican holidays incl. Semana Santa + cutoff, in the venue timezone). Cash is excluded (immediate). Returns the Monday–Sunday days with gross/commission/net + breakdown by merchant and by card type, plus the week total. Pass venueId; optionally weekStart (YYYY-MM-DD, any day in the target week; default: current week). PRO feature (ADVANCED_REPORTS) — the server enforces plan access.',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      weekStart: z.string().optional().describe('Any date YYYY-MM-DD in the target week (default: current week)'),
    },
    async ({ venueId, weekStart }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
      const gate = await planGateMessage(venueId, 'ADVANCED_REPORTS', 'El calendario semanal de liquidación')
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      const bounds = venueWeekBounds(weekStart, tz)
      const week = await getSettlementsLandingInWeek(venueId, bounds.weekStart, bounds.weekEnd, tz)
      return text({ venueId, timezone: tz, ...week })
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
        // Card money counted but not cost (no TransactionCost). byCardType excludes
        // these, so this is the reconciling term: Σ byCardType.netAmount + uncosted ≈ balance.
        uncostedCount: summary.uncostedCount,
        uncostedAmount: summary.uncostedAmount,
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
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
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
        const rawRows = await fetchSalesSummaryDetailRows(venueId, filters, 200) // cap MCP payload
        // SECURITY (H2): never hand raw card / processor data to the LLM vendor. guard.redact strips
        // maskedPan (a SENSITIVE_PAYMENT_FIELD); processorData is a nested processor blob it does NOT
        // cover (auth/reference numbers, operation ids), so drop it explicitly. Same redaction policy
        // the platform applies everywhere card data could leave the building.
        const rows = guard.redact(rawRows).map(r => {
          const copy = { ...(r as Record<string, unknown>) }
          delete copy.processorData
          return copy
        })
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
