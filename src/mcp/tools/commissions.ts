import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { hasPermission } from '@/services/access/access.service'
import { venuesWithCommissionsAccess } from '@/services/access/basePlan.service'
import { getCalendarMonth, venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import { resolveCommissionBase } from '@/services/dashboard/commission/commission-base'
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
  includeDiscount: boolean
  includeTax: boolean
  filterByCategories: boolean
  categoryIds: string[]
  /** D-ELEGIDOS: «sólo personas elegidas». Opcionales: un esquema anterior se lee como «todo el equipo». */
  filterByStaff?: boolean
  staffIds?: string[]
  useGoalAsTier: boolean
  goalBonusRate: { toString(): string } | null
  attendanceLinked: boolean
  attendanceLatePenaltyRate: { toString(): string } | null
  tiers: TierRow[]
}

/**
 * Pure shaping of a commission config row for the LLM. A STAFF_GOAL tier
 * boundary is surfaced as the string 'EMPLOYEE_GOAL' (it resolves to each
 * staff member's own sales goal at calculation time); a FIXED boundary is the
 * numeric amount (null max = open-ended).
 *
 * `commissionBase` responde la pregunta que el operador SÍ hace —"¿un descuento
 * le baja la comisión al vendedor?"— ya traducida: la bandera de la DB se llama
 * `includeDiscount` y significa lo contrario de lo que suena, así que el MCP
 * nunca la expone cruda. Traducción única en `commission-base.ts`.
 */
export function formatScheme(config: SchemeRow, categoryName: Map<string, string>, staffName: Map<string, string> = new Map()) {
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
    // LO_COBRADO = neto de descuentos y promociones; PRECIO_DE_LISTA = catálogo.
    commissionBase: resolveCommissionBase(config),
    // Decisión D5 enmendada (spec §9-1): SIN_IVA (de fábrica) = la venta sin IVA, separada con la regla de tasas de la
    // contabilidad (final-fix I1: la tasa de cada renglón, ya facturado o la de su producto); CON_IVA = lo que pagó el cliente.
    taxBase: config.includeTax ? 'CON_IVA' : 'SIN_IVA',
    appliesTo: config.filterByCategories ? config.categoryIds.map(id => categoryName.get(id) ?? id) : 'ALL_CATEGORIES',
    // D-ELEGIDOS: a quién le paga el esquema — todo el equipo, o SÓLO las personas elegidas (por nombre).
    appliesToStaff: config.filterByStaff ? (config.staffIds ?? []).map(id => staffName.get(id) ?? id) : 'ALL_STAFF',
    useGoalAsTier: config.useGoalAsTier,
    goalBonusRate: config.goalBonusRate == null ? null : Number(config.goalBonusRate),
    // Asistencia → comisiones: prendida, un día con retardo pierde este porcentaje del día.
    attendanceLinked: config.attendanceLinked,
    attendanceLatePenaltyRate: config.attendanceLatePenaltyRate == null ? null : Number(config.attendanceLatePenaltyRate),
    tiers: config.tiers.map(t => ({
      level: t.tierLevel,
      name: t.tierName,
      from: boundary(t.minThreshold, t.minThresholdType),
      to: boundary(t.maxThreshold, t.maxThresholdType),
      rate: Number(t.rate),
    })),
  }
}

/** D-ELEGIDOS: el nombre de cada persona elegida por algún esquema «sólo personas elegidas» (una consulta, acotada por ids). */
async function nombresDeLasPersonasElegidas(configs: SchemeRow[]): Promise<Map<string, string>> {
  const elegidos = [...new Set(configs.flatMap(c => (c.filterByStaff ? (c.staffIds ?? []) : [])))]
  if (elegidos.length === 0) return new Map()
  const personas = await prisma.staff.findMany({
    where: { id: { in: elegidos } },
    select: { id: true, firstName: true, lastName: true },
    take: elegidos.length,
  })
  return new Map(personas.map(p => [p.id, `${p.firstName} ${p.lastName ?? ''}`.trim()]))
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
  calculationCount?: number
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
    staff.count += r.calculationCount ?? 1
    staff.totalBase += base
    staff.totalCommission += commission
    staff.byStatus[r.status] = (staff.byStatus[r.status] ?? 0) + (r.calculationCount ?? 1)

    let scheme = staff.schemes.get(r.configId)
    if (!scheme) {
      scheme = { config: r.config.name, calcType: r.config.calcType, count: 0, base: 0, commission: 0, rates: new Map() }
      staff.schemes.set(r.configId, scheme)
    }
    scheme.count += r.calculationCount ?? 1
    scheme.base += base
    scheme.commission += commission

    const rateKey = `${r.effectiveRate}|${r.tier ?? ''}`
    let rateBucket = scheme.rates.get(rateKey)
    if (!rateBucket) {
      rateBucket = { rate, tier: r.tier, tierName: r.tierName, count: 0, base: 0, commission: 0 }
      scheme.rates.set(rateKey, rateBucket)
    }
    rateBucket.count += r.calculationCount ?? 1
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
    'List active staff commission schemes for your venues — the CONFIG only (rates, tiers, categories), NOT what anyone earned. Each scheme shows how commission is calculated (flat %, tiered, or fixed amount — with calcType FIXED, `defaultRate` is the fixed amount in PESOS paid per sale, not a rate), which product categories it applies to (multiple schemes can run per venue, each on its own categories), who earns from it (`appliesToStaff`: "ALL_STAFF" or the names of the only people the scheme pays), and its tiers. `commissionBase` says what the commission is calculated ON: "LO_COBRADO" (default — net of order AND line discounts/promotions, i.e. what the customer actually paid; tips never count) or "PRECIO_DE_LISTA" (the catalog price, ignoring discounts). `taxBase` says whether IVA counts: "SIN_IVA" (default — the sale without IVA, exactly the net sale of the accounting entry: each line at its own rate — 16 %, 8 %, nothing for 0 % or exempt — after line-targeted discounts and courtesies, with non-taxable service charges carrying no IVA) or "CON_IVA" (what the customer paid, IVA included). With "PRECIO_DE_LISTA" the base is the list price of the order lines plus the service charge. A tier boundary can be a fixed amount or "EMPLOYEE_GOAL" — the staff member\'s own sales goal. ⚠️ Do NOT use these rates to hand-compute a person\'s commission by multiplying their sales — that is wrong (only some categories carry a scheme, commission is attributed to the SERVER not the order creator, and tiers are monthly-cumulative). To answer "¿cuánto de comisión ganó X?" use the staff_commission tool, which reads the real engine. Requires commissions:read.',
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
      const staffName = await nombresDeLasPersonasElegidas(configs)

      return text({ venuesInScope: venueIds.length, schemes: configs.map(c => formatScheme(c, categoryName, staffName)) })
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
    'History of staff commission payouts registered with the PREVIOUS payout flow (most businesses have none): staff member, amount, payment method, status and paid date, plus totals paid and pending. Since October 2026 commissions are paid inside each person\'s staff pay statement («Pago al personal»): to answer "¿cuánto le pagué / le debo de comisiones a X?" use staff_service_pay_summary or staff_service_pay_detail, which include commissions and tips. Requires commissions:payout. Pass venueId to focus one venue; optionally status.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      status: z.enum(['pending', 'paid', 'all']).optional().describe("Filter: 'pending' (not yet paid), 'paid', or 'all' (default)"),
      limit: z.number().int().positive().max(100).optional().describe('Max payouts to list (default 50, newest first)'),
    },
    async ({ venueId, status, limit }) => {
      // El historial de pagos viejos exige `commissions:payout` como su API, también al consultar varias sedes (spec §8).
      const venueIds = (await readableVenues(venueId)).filter(id => hasPermission(scope.perVenueAccess.get(id)!, 'commissions:payout'))
      if (venueIds.length === 0)
        return text({
          venuesInScope: 0,
          payouts: [],
          note: 'Ningún venue en tu alcance tiene commissions:payout Y el plan/módulo de comisiones. Desde octubre de 2026 las comisiones se pagan en el recibo de Pago al personal.',
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

      const groups = await prisma.commissionCalculation.groupBy({
        by: ['staffId', 'configId', 'effectiveRate', 'tier', 'tierName', 'status'],
        where: {
          venueId: { in: venueIds },
          ...(staffId ? { staffId } : {}),
          voidedAt: null,
          calculatedAt: { gte: from, lte: to },
        },
        _sum: { baseAmount: true, grossCommission: true, netCommission: true },
        _count: { _all: true },
      })
      const staffIds = [...new Set(groups.map(g => g.staffId))]
      const configIds = [...new Set(groups.map(g => g.configId))]
      const [people, configs] = groups.length
        ? await Promise.all([
            prisma.staff.findMany({
              where: { id: { in: staffIds } },
              select: { id: true, firstName: true, lastName: true },
              take: staffIds.length,
            }),
            prisma.commissionConfig.findMany({
              where: { id: { in: configIds } },
              select: { id: true, name: true, calcType: true },
              take: configIds.length,
            }),
          ])
        : [[], []]
      const peopleById = new Map(people.map(p => [p.id, p]))
      const configsById = new Map(configs.map(c => [c.id, c]))
      const rows: CommissionCalcRow[] = groups.map(g => ({
        ...g,
        staff: peopleById.get(g.staffId) ?? { firstName: 'Sin nombre', lastName: null },
        config: configsById.get(g.configId) ?? { name: 'Sin nombre', calcType: 'UNKNOWN' },
        baseAmount: g._sum.baseAmount ?? '0',
        grossCommission: g._sum.grossCommission ?? '0',
        netCommission: g._sum.netCommission ?? '0',
        calculationCount: g._count._all,
      }))

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
