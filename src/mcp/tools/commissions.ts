import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { hasPermission } from '@/services/access/access.service'
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

export function registerCommissionTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  /** Venues in scope where the caller can read commissions. Throws if a requested venue is out of scope. */
  const readableVenues = (requestedVenueId?: string): string[] => {
    guard.venueFilter(requestedVenueId) // throws on out-of-scope venue
    const ids = requestedVenueId ? [requestedVenueId] : scope.allowedVenueIds
    return ids.filter(id => {
      const access = scope.perVenueAccess.get(id)
      return !!access && hasPermission(access, 'commissions:read')
    })
  }

  server.tool(
    'list_commission_schemes',
    'List active staff commission schemes for your venues. Each scheme shows how commission is calculated (flat %, tiered, or fixed amount), which product categories it applies to (multiple schemes can run per venue, each on its own categories), and its tiers. A tier boundary can be a fixed amount or "EMPLOYEE_GOAL" — the staff member\'s own sales goal. Requires commissions:read.',
    { venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues') },
    async ({ venueId }) => {
      const venueIds = readableVenues(venueId)
      if (venueIds.length === 0) return text({ schemes: [], note: 'No venues in scope with commissions:read.' })

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
      const venueIds = readableVenues(venueId)
      if (venueIds.length === 0) return text({ goals: [], note: 'No venues in scope with commissions:read.' })

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
      const venueIds = readableVenues(venueId)
      if (venueIds.length === 0) return text({ venuesInScope: 0, payouts: [], note: 'No tienes acceso de comisiones en este alcance.' })

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
}
