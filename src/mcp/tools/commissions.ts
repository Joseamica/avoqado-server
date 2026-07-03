import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { hasPermission } from '@/services/access/access.service'
import { venuesWithCommissionsAccess } from '@/services/access/basePlan.service'
import { getCalendarMonth, venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { CommissionPayoutStatus } from '@prisma/client'

// COMMISSIONS module code (mirrors MODULE_CODES.COMMISSIONS in module.service —
// hardcoded here to keep this tool module's import graph light for unit tests).
const COMMISSIONS_MODULE_CODE = 'COMMISSIONS'

const num = (d: { toString(): string } | null): number => (d == null ? 0 : Number(d))
const round2 = (n: number): number => Math.round(n * 100) / 100

interface TierRow {
  tierLevel: number
  tierName: string
  minThreshold: { toString(): string }
  maxThreshold: { toString(): string } | null
  minThresholdType: string
  maxThresholdType: string
  rate: { toString(): string }
}

interface SchemeRow {
  id: string
  venueId: string | null
  name: string
  priority: number
  recipient: string
  calcType: string
  defaultRate: { toString(): string }
  filterByCategories: boolean
  categoryIds: string[]
  useGoalAsTier: boolean
  goalBonusRate: { toString(): string } | null
  tiers: TierRow[]
}

/**
 * Pure shaping of a commission config row for the LLM. A STAFF_GOAL tier
 * boundary is surfaced as the string 'EMPLOYEE_GOAL' (it resolves to each
 * staff member's own sales goal at calculation time); a FIXED boundary is the
 * numeric amount (null max = open-ended).
 */
export function formatScheme(config: SchemeRow, categoryName: Map<string, string>) {
  const boundary = (value: { toString(): string } | null, type: string): number | 'EMPLOYEE_GOAL' | null => {
    if (type === 'STAFF_GOAL') return 'EMPLOYEE_GOAL'
    return value == null ? null : Number(value)
  }
  return {
    id: config.id,
    venueId: config.venueId,
    name: config.name,
    priority: config.priority,
    paidTo: config.recipient,
    calcType: config.calcType,
    defaultRate: Number(config.defaultRate),
    appliesTo: config.filterByCategories ? config.categoryIds.map(id => categoryName.get(id) ?? id) : 'ALL_CATEGORIES',
    useGoalAsTier: config.useGoalAsTier,
    goalBonusRate: config.goalBonusRate == null ? null : Number(config.goalBonusRate),
    tiers: config.tiers.map(t => ({
      level: t.tierLevel,
      name: t.tierName,
      from: boundary(t.minThreshold, t.minThresholdType),
      to: boundary(t.maxThreshold, t.maxThresholdType),
      rate: Number(t.rate),
    })),
  }
}

/**
 * A single row from the real commission engine (CommissionCalculation), shaped
 * for aggregation. Amounts are Prisma Decimals in PESOS (1:1, major units).
 */
interface CommissionCalcRow {
  staffId: string
  staff: { firstName: string; lastName: string | null }
  configId: string
  config: { name: string; calcType: string }
  baseAmount: { toString(): string }
  grossCommission: { toString(): string }
  netCommission: { toString(): string }
  effectiveRate: { toString(): string }
  tier: number | null
  tierName: string | null
  status: string
}

/**
 * Aggregate raw engine rows into per-staff EARNED commission, broken down by
 * scheme and by the rate/tier that actually applied. This is the source of
 * truth for what each seller earned (attributed to the SERVER via the engine,
 * only over commissionable categories) — it must NEVER be re-derived by
 * multiplying a sales figure by a scheme rate. Pure + deterministic (sorted by
 * total commission desc) so it is unit-testable in isolation. Money stays in
 * pesos 1:1 (no cents conversion — these are Decimal(x,2) peso fields).
 */
export function aggregateStaffCommission(rows: CommissionCalcRow[]) {
  interface RateBucket {
    rate: number
    tier: number | null
    tierName: string | null
    count: number
    base: number
    commission: number
  }
  interface SchemeBucket {
    config: string
    calcType: string
    count: number
    base: number
    commission: number
    rates: Map<string, RateBucket>
  }
  interface StaffBucket {
    staffId: string
    name: string
    count: number
    totalBase: number
    totalCommission: number
    byStatus: Record<string, number>
    schemes: Map<string, SchemeBucket>
  }

  const byStaff = new Map<string, StaffBucket>()

  for (const r of rows) {
    const base = Number(r.baseAmount)
    const commission = Number(r.netCommission)
    const rate = Number(r.effectiveRate)

    let staff = byStaff.get(r.staffId)
    if (!staff) {
      staff = {
        staffId: r.staffId,
        name: `${r.staff.firstName} ${r.staff.lastName ?? ''}`.trim(),
        count: 0,
        totalBase: 0,
        totalCommission: 0,
        byStatus: {},
        schemes: new Map(),
      }
      byStaff.set(r.staffId, staff)
    }
    staff.count += 1
    staff.totalBase += base
    staff.totalCommission += commission
    staff.byStatus[r.status] = (staff.byStatus[r.status] ?? 0) + 1

    let scheme = staff.schemes.get(r.configId)
    if (!scheme) {
      scheme = { config: r.config.name, calcType: r.config.calcType, count: 0, base: 0, commission: 0, rates: new Map() }
      staff.schemes.set(r.configId, scheme)
    }
    scheme.count += 1
    scheme.base += base
    scheme.commission += commission

    const rateKey = `${r.effectiveRate}|${r.tier ?? ''}`
    let rateBucket = scheme.rates.get(rateKey)
    if (!rateBucket) {
      rateBucket = { rate, tier: r.tier, tierName: r.tierName, count: 0, base: 0, commission: 0 }
      scheme.rates.set(rateKey, rateBucket)
    }
    rateBucket.count += 1
    rateBucket.base += base
    rateBucket.commission += commission
  }

  return Array.from(byStaff.values())
    .map(s => ({
      staffId: s.staffId,
      name: s.name,
      count: s.count,
      totalBase: round2(s.totalBase),
      totalCommission: round2(s.totalCommission),
      byStatus: s.byStatus,
      byScheme: Array.from(s.schemes.values())
        .map(sc => ({
          config: sc.config,
          calcType: sc.calcType,
          count: sc.count,
          base: round2(sc.base),
          commission: round2(sc.commission),
          byRate: Array.from(sc.rates.values())
            .map(rb => ({
              rate: rb.rate,
              tier: rb.tier,
              tierName: rb.tierName,
              count: rb.count,
              base: round2(rb.base),
              commission: round2(rb.commission),
            }))
            .sort((a, b) => a.rate - b.rate),
        }))
        .sort((a, b) => b.commission - a.commission),
    }))
    .sort((a, b) => b.totalCommission - a.totalCommission)
}

export function registerCommissionTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  /**
   * Venues in scope where the caller can read commissions AND the venue is plan-entitled.
   * Throws if a requested venue is out of scope. Plan gate mirrors the dashboard commission
   * routes exactly (venuesWithCommissionsAccess: COMMISSIONS module grant OR tier access —
   * grandfathered/demo → own VenueFeature → PLAN_PREMIUM) so the MCP can never read what the
   * dashboard paywalls.
   */
  const readableVenues = async (requestedVenueId?: string): Promise<string[]> => {
    guard.venueFilter(requestedVenueId) // throws on out-of-scope venue
    const ids = (requestedVenueId ? [requestedVenueId] : scope.allowedVenueIds).filter(id => {
      const access = scope.perVenueAccess.get(id)
      return !!access && hasPermission(access, 'commissions:read')
    })
    const entitled = await venuesWithCommissionsAccess(ids)
    return ids.filter(id => entitled.has(id))
  }

  server.tool(
    'list_commission_schemes',
    'List active staff commission schemes for your venues — the CONFIG only (rates, tiers, categories), NOT what anyone earned. Each scheme shows how commission is calculated (flat %, tiered, or fixed amount), which product categories it applies to (multiple schemes can run per venue, each on its own categories), and its tiers. A tier boundary can be a fixed amount or "EMPLOYEE_GOAL" — the staff member\'s own sales goal. ⚠️ Do NOT use these rates to hand-compute a person\'s commission by multiplying their sales — that is wrong (only some categories carry a scheme, commission is attributed to the SERVER not the order creator, and tiers are monthly-cumulative). To answer "¿cuánto de comisión ganó X?" use the staff_commission tool, which reads the real engine. Requires commissions:read.',
    { venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues') },
    async ({ venueId }) => {
      const venueIds = await readableVenues(venueId)
      if (venueIds.length === 0)
        return text({
          schemes: [],
          note: 'Ningún venue en tu alcance tiene commissions:read Y el plan/módulo de comisiones (requiere Premium o el módulo COMMISSIONS).',
        })

      const configs = (await prisma.commissionConfig.findMany({
        where: { venueId: { in: venueIds }, active: true, deletedAt: null },
        include: { tiers: { where: { active: true }, orderBy: { tierLevel: 'asc' } } },
        orderBy: [{ priority: 'desc' }],
      })) as unknown as SchemeRow[]

      const catIds = [...new Set(configs.flatMap(c => c.categoryIds))]
      const cats = catIds.length
        ? await prisma.menuCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } })
        : []
      const categoryName = new Map(cats.map(c => [c.id, c.name]))

      return text({ venuesInScope: venueIds.length, schemes: configs.map(c => formatScheme(c, categoryName)) })
    },
  )

  server.tool(
    'list_commission_goals',
    'List staff sales goals (metas) for your venues — per-employee or venue-wide targets with their period (DAILY/WEEKLY/MONTHLY). These goals also drive any commission tier whose boundary is EMPLOYEE_GOAL. Requires commissions:read.',
    { venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues') },
    async ({ venueId }) => {
      const venueIds = await readableVenues(venueId)
      if (venueIds.length === 0)
        return text({
          goals: [],
          note: 'Ningún venue en tu alcance tiene commissions:read Y el plan/módulo de comisiones (requiere Premium o el módulo COMMISSIONS).',
        })

      const venues = await Promise.all(
        venueIds.map(async vId => {
          const vm = await prisma.venueModule.findFirst({
            where: { venueId: vId, module: { code: COMMISSIONS_MODULE_CODE } },
            select: { config: true },
          })
          const stored =
            (
              vm?.config as {
                salesGoals?: Array<{ staffId: string | null; goal: number; goalType?: string; period: string; active: boolean }>
              } | null
            )?.salesGoals ?? []
          const active = stored.filter(g => g.active)
          const staffIds = active.map(g => g.staffId).filter((s): s is string => !!s)
          const staff = staffIds.length
            ? await prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, lastName: true } })
            : []
          const staffName = new Map(staff.map(s => [s.id, `${s.firstName} ${s.lastName}`]))
          return {
            venueId: vId,
            goals: active.map(g => ({
              who: g.staffId ? (staffName.get(g.staffId) ?? g.staffId) : 'VENUE_WIDE',
              goal: g.goal,
              goalType: g.goalType ?? 'AMOUNT',
              period: g.period,
            })),
          }
        }),
      )
      return text({ venuesInScope: venueIds.length, venues })
    },
  )

  server.tool(
    'commission_payouts',
    'Staff commission payouts for your venues: each shows the staff member, amount, payment method (cash/transfer/payroll), status (pending/approved/processing/paid/failed/cancelled) and when it was paid — plus totals already paid vs still pending. Defaults to all statuses. Answers "¿cuánto he pagado de comisiones? ¿qué comisiones están pendientes? ¿cuánto le debo a X?". Requires commissions:read. Pass venueId to focus one venue; optionally status.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      status: z.enum(['pending', 'paid', 'all']).optional().describe("Filter: 'pending' (not yet paid), 'paid', or 'all' (default)"),
      limit: z.number().int().positive().max(100).optional().describe('Max payouts to list (default 50, newest first)'),
    },
    async ({ venueId, status, limit }) => {
      const venueIds = await readableVenues(venueId)
      if (venueIds.length === 0)
        return text({
          venuesInScope: 0,
          payouts: [],
          note: 'Ningún venue en tu alcance tiene commissions:read Y el plan/módulo de comisiones (requiere Premium o el módulo COMMISSIONS).',
        })

      const statusFilter =
        status === 'paid'
          ? { status: CommissionPayoutStatus.PAID }
          : status === 'pending'
            ? { status: { in: [CommissionPayoutStatus.PENDING, CommissionPayoutStatus.APPROVED, CommissionPayoutStatus.PROCESSING] } }
            : {}

      const [summary, payouts] = await Promise.all([
        prisma.commissionPayout.groupBy({
          by: ['status'],
          where: { venueId: { in: venueIds } },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        prisma.commissionPayout.findMany({
          where: { venueId: { in: venueIds }, ...statusFilter },
          select: {
            amount: true,
            paymentMethod: true,
            status: true,
            paidAt: true,
            processedAt: true,
            createdAt: true,
            notes: true,
            staff: { select: { firstName: true, lastName: true } },
            venue: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: limit ?? 50,
        }),
      ])

      const byStatus: Record<string, { count: number; amount: number }> = {}
      for (const g of summary) byStatus[g.status] = { count: g._count._all, amount: round2(num(g._sum.amount)) }
      const totalPending = round2(['PENDING', 'APPROVED', 'PROCESSING'].reduce((s, k) => s + (byStatus[k]?.amount ?? 0), 0))

      return text({
        venuesInScope: venueIds.length,
        totals: { paid: byStatus.PAID?.amount ?? 0, pending: totalPending },
        byStatus,
        count: payouts.length,
        payouts: payouts.map(p => ({
          staff: `${p.staff.firstName} ${p.staff.lastName}`.trim(),
          venue: p.venue?.name ?? null,
          amount: num(p.amount),
          method: p.paymentMethod, // CASH | BANK_TRANSFER | PAYROLL
          status: p.status,
          paidAt: p.paidAt?.toISOString() ?? null,
          processedAt: p.processedAt?.toISOString() ?? null,
          createdAt: p.createdAt.toISOString(),
          notes: p.notes,
        })),
      })
    },
  )

  server.tool(
    'staff_commission',
    'How much commission each staff member EARNED in a venue you can access, over a date range (default: the current calendar month, venue-local). This is the SOURCE OF TRUTH — it reads what the commission engine actually calculated (CommissionCalculation), attributed to the seller and applied ONLY to commissionable categories at the correct tier/rate. Per staff it returns totalCommission, totalBase, a per-scheme breakdown, and within each scheme a per-rate/tier breakdown (which rate hit which base). Answers "¿cuánto de comisión le toca a X? / ¿cuánto llevo de comisiones este mes?". ⚠️ NEVER estimate commission yourself by multiplying a sales figure (e.g. from staff_ranking) by a scheme rate — that is wrong (sales tools attribute by order CREATOR, commissions pay the SERVER; most categories may carry no scheme; tiers are monthly-cumulative). Always use THIS tool. Requires commissions:read. Pass venueId; optionally staffId, fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue to analyze (must be in your scope)'),
      staffId: z.string().optional().describe('Focus one employee; omit for all staff'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD venue-local (default: first day of current month)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD venue-local, INCLUSIVE of the whole day (default: today / end of month)'),
    },
    async ({ venueId, staffId, fromDate, toDate }) => {
      const venueIds = await readableVenues(venueId) // gating: scope + commissions:read + plan/module entitlement
      if (venueIds.length === 0)
        return text({
          venuesInScope: 0,
          staff: [],
          note: 'Ningún venue en tu alcance tiene commissions:read Y el plan/módulo de comisiones (requiere Premium o el módulo COMMISSIONS).',
        })

      const tz = (await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }))?.timezone || 'America/Mexico_City'
      const month = getCalendarMonth(tz)
      const from = fromDate ? venueStartOfDay(tz, new Date(`${fromDate}T12:00:00`)) : month.from
      const to = toDate ? venueEndOfDay(tz, new Date(`${toDate}T12:00:00`)) : month.to

      const rows = (await prisma.commissionCalculation.findMany({
        where: {
          venueId: { in: venueIds },
          ...(staffId ? { staffId } : {}),
          voidedAt: null, // exclude reversed calcs (e.g. from refunds)
          calculatedAt: { gte: from, lte: to },
        },
        select: {
          staffId: true,
          staff: { select: { firstName: true, lastName: true } },
          configId: true,
          config: { select: { name: true, calcType: true } },
          baseAmount: true,
          grossCommission: true,
          netCommission: true,
          effectiveRate: true,
          tier: true,
          tierName: true,
          status: true,
        },
      })) as unknown as CommissionCalcRow[]

      const staff = aggregateStaffCommission(rows)
      return text({
        venueId,
        window: { from: from.toISOString(), to: to.toISOString(), timezone: tz },
        count: staff.length,
        staff,
        note: 'Comisión GANADA leída del motor real (CommissionCalculation): atribuida al vendedor (servedById) y solo sobre categorías con esquema, al tier/tasa correctos. Excluye calcs anulados (reembolsos). NO estimes multiplicando ventas × tasa.',
      })
    },
  )
}
