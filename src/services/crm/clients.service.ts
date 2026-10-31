/**
 * «Clientes» and what is live in Avoqado for one account (spec 2026-10-30 §5.5, plan task 9, ruling 35).
 *
 * A client is an Organization — never the sales team's own (ruling 14) — with a REAL venue that charged real money or
 * pays a plan, or one a seller linked when winning it. «Real money» and «real venue» are the sweep's own `MONEY` and
 * `REAL_VENUE`, so «cliente» and «primer dinero» say the same thing: a demo's sample sales never make anyone a client.
 *
 * The list reads no client's live data (spec §5.12); the ficha reads it for ONE account, when it is opened. Nothing is
 * copied into the CRM.
 */
import { OrgRole, Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import { NotFoundError } from '../../errors/AppError'
import { DEFAULT_TIMEZONE, formatInVenueTimezone } from '../../utils/datetime'
import prisma from '../../utils/prismaClient'
import { PAID_PLAN_TIER_CODES } from '../access/basePlan.service'
import { getPlanState, type PlanState } from '../dashboard/planState.service'
import { scopeWhere, type CrmAccess } from './access.service'
import { teamOrganizationId } from './inbound.service'
import { MONEY, REAL_VENUE } from './sweep.service'

const DEFAULT_PAGE = 50
const MAX_PAGE = 100
// ponytail: the ficha shows an organization's first 20 venues (plan read per venue, Stripe included) and says how many
// there are; page them if a client with more ever needs the rest in the ficha.
const VENUES_CAP = 20
/** The steps of the signup, the same count as `getOnboardingCompletionPercentage`. */
const ONBOARDING_STEPS = 8

/** A paid plan in force: the classic row without a trial end, as `endDate` means in the schema. */
const PAID_PLAN_ROW = {
  feature: { code: { in: [...PAID_PLAN_TIER_CODES] } },
  active: true,
  suspendedAt: null,
  endDate: null,
} satisfies Prisma.VenueFeatureWhereInput

/** A commercial contract in force, by the same rule `getPlanState` reads it (`planContractOrigin`). */
const liveContract = (now: Date) =>
  ({
    endedAt: null,
    planTier: { in: ['PRO', 'PREMIUM'] },
    OR: [{ cancelAt: null }, { cancelAt: { gt: now } }],
  }) satisfies Prisma.HybridContractWhereInput

/** Ruling 35: who is a client, in ONE bounded query over the tables `getPlanState` reads — never `getPlanState` per row. */
function clientWhere(teamOrgId: string | null, now: Date): Prisma.OrganizationWhereInput[] {
  return [
    ...(teamOrgId ? [{ id: { not: teamOrgId } }] : []),
    {
      OR: [
        {
          venues: {
            some: {
              ...REAL_VENUE,
              OR: [{ payments: { some: MONEY } }, { features: { some: PAID_PLAN_ROW } }, { hybridContracts: { some: liveContract(now) } }],
            },
          },
        },
        { crmAccount: { is: { stage: { kind: 'GANADA' } } } },
      ],
    },
  ]
}

export interface ClientFilters {
  q?: string
  cursor?: string
  limit?: number
}

const fullName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`.trim()

/**
 * «Clientes», a page at a time: filters and search in the database, the page capped at 100 by the server, the real total.
 * Every client is listed for whoever has «Ver negocios» — they are Avoqado's clients, not anybody's prospects — but a
 * linked CRM account shows its owner and stage only inside the caller's scope (`cuentaAjena` says there is one).
 * `yaCobro` is «Ya cobró» / «Aún no cobra».
 */
export async function listClients(access: CrmAccess, filters: ClientFilters = {}, now = new Date()) {
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_PAGE, 1), MAX_PAGE)
  const and = clientWhere(await teamOrganizationId(), now)
  if (filters.q) and.push({ name: { contains: filters.q, mode: 'insensitive' } })
  const where: Prisma.OrganizationWhereInput = { AND: and }

  const [found, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      select: {
        id: true,
        name: true,
        createdAt: true,
        crmAccount: { select: { id: true } },
        _count: { select: { venues: { where: { ...REAL_VENUE, payments: { some: MONEY } } } } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One more than the page says whether there is a next one.
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    }),
    prisma.organization.count({ where }),
  ])
  const page = found.slice(0, limit)

  // The page's CRM accounts the caller may see, in one query through the same scope as every account list.
  const linked = page.filter(organization => organization.crmAccount).map(organization => organization.id)
  const visible = linked.length
    ? await prisma.crmAccount.findMany({
        where: { AND: [{ organizationId: { in: linked } }, scopeWhere(access, 'ver')] },
        select: {
          id: true,
          organizationId: true,
          owner: { select: { id: true, firstName: true, lastName: true } },
          stage: { select: { id: true, name: true, kind: true } },
        },
        orderBy: [{ id: 'asc' }],
        take: linked.length,
      })
    : []
  const byOrganization = new Map(visible.map(account => [account.organizationId, account]))

  return {
    rows: page.map(organization => {
      const account = byOrganization.get(organization.id)
      return {
        id: organization.id,
        name: organization.name,
        createdAt: organization.createdAt,
        yaCobro: organization._count.venues > 0,
        cuenta: account
          ? {
              id: account.id,
              owner: account.owner ? { id: account.owner.id, name: fullName(account.owner) } : null,
              stage: account.stage,
            }
          : null,
        cuentaAjena: !!organization.crmAccount && !account,
      }
    }),
    nextCursor: found.length > limit ? page[page.length - 1].id : null,
    total,
  }
}

/**
 * The effective plan of a venue: `planTier`, or the contract's tier when a commercial contract has no classic row
 * (`planTier` null, Codex plan r1 #8). Built field by field: a card or a Stripe id never leaves here.
 */
function effectivePlan(state: PlanState) {
  return { tier: state.planTier ?? state.origin?.tier ?? null, origen: state.origin?.kind ?? 'NONE', estado: state.state }
}

/** This month on Mexico City's calendar: from day 1 at 00:00 up to — not including — day 1 of the next one. */
function teamMonth(now: Date): { gte: Date; lt: Date } {
  const [year, month] = formatInVenueTimezone(now, DEFAULT_TIMEZONE, 'yyyy-MM').split('-').map(Number)
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
  const first = (y: number, m: number) => fromZonedTime(`${y}-${String(m).padStart(2, '0')}-01T00:00:00.000`, DEFAULT_TIMEZONE)
  return { gte: first(year, month), lt: first(next.year, next.month) }
}

/** What the organization charged for real this month, in pesos. */
async function monthSales(organizationId: string, now: Date): Promise<Prisma.Decimal> {
  const { _sum } = await prisma.payment.aggregate({
    where: { ...MONEY, createdAt: teamMonth(now), venue: { organizationId, ...REAL_VENUE } },
    _sum: { amount: true },
  })
  return _sum.amount ?? new Prisma.Decimal(0)
}

/**
 * The ficha's live part (spec §5.5): for an account linked to an Organization, its venues with their effective plan,
 * status and KYC; the signup's progress; the owner's last sign-in; how many venues and terminals. What it sells only
 * with «Ver ventas». An account without an Organization answers `{ ligada: false }` so the ficha can say why there is
 * nothing live; one outside the caller's scope is a 404, as in `getAccount`.
 */
export async function getLive(access: CrmAccess, accountId: string, now = new Date()) {
  const account = await prisma.crmAccount.findFirst({
    where: { AND: [{ id: accountId }, scopeWhere(access, 'ver')] },
    select: { organizationId: true },
  })
  if (!account) throw new NotFoundError('No encontramos ese negocio', 'CRM_ACCOUNT_NOT_FOUND')
  const { organizationId } = account
  if (!organizationId) return { ligada: false as const }

  const [venues, sucursales, owner, onboarding, terminales, ventasMes] = await Promise.all([
    prisma.venue.findMany({
      where: { organizationId },
      select: { id: true, name: true, status: true, kycStatus: true, _count: { select: { terminals: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: VENUES_CAP,
    }),
    prisma.venue.count({ where: { organizationId } }),
    prisma.staffOrganization.findFirst({
      where: { organizationId, role: OrgRole.OWNER, isActive: true },
      select: { staff: { select: { firstName: true, lastName: true, lastLoginAt: true } } },
      orderBy: [{ isPrimary: 'desc' }, { joinedAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.onboardingProgress.findUnique({ where: { organizationId }, select: { completedSteps: true, completedAt: true } }),
    prisma.terminal.count({ where: { venue: { organizationId } } }),
    access.ventas ? monthSales(organizationId, now) : null,
  ])
  const plans = await Promise.all(venues.map(venue => getPlanState(venue.id)))
  const steps = onboarding?.completedSteps
  const done = Array.isArray(steps) ? steps.length : 0

  return {
    ligada: true as const,
    organizationId,
    venues: venues.map((venue, i) => ({
      id: venue.id,
      name: venue.name,
      status: venue.status,
      kycStatus: venue.kycStatus,
      terminales: venue._count.terminals,
      plan: effectivePlan(plans[i]),
    })),
    sucursales,
    terminales,
    dueno: owner ? { nombre: fullName(owner.staff), ultimoAcceso: owner.staff.lastLoginAt } : null,
    alta: onboarding
      ? {
          hechos: onboarding.completedAt ? ONBOARDING_STEPS : Math.min(done, ONBOARDING_STEPS),
          totales: ONBOARDING_STEPS,
          terminada: !!onboarding.completedAt,
        }
      : null,
    ventasMes,
    ventasBloqueadas: !access.ventas,
  }
}
