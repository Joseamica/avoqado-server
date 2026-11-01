/**
 * «Clientes» and what is live in Avoqado for one account (spec 2026-10-30 §5.5, plan task 9, ruling 35).
 *
 * A client is an Organization — never the sales team's own (ruling 14) — with a REAL venue that charged real money or
 * pays a plan, or one a seller linked when winning it. «Real money» and «real venue» are the sweep's own `MONEY` and
 * `REAL_VENUE`, so «cliente» and «primer dinero» say the same thing: a demo's sample sales never make anyone a client.
 *
 * The list reads no client's live data (spec §5.12); the ficha reads it for ONE account — or, for a client without a CRM
 * account, ONE Organization (ruling 47) — when it is opened. Nothing is copied into the CRM.
 */
import { OrgRole, Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import { NotFoundError } from '../../errors/AppError'
import { enParaleloAcotado } from '../../utils/concurrencyLimiter'
import { DEFAULT_TIMEZONE, formatInVenueTimezone } from '../../utils/datetime'
import prisma from '../../utils/prismaClient'
import { utcTs } from '../../utils/sqlDates'
import { PAID_PLAN_TIER_CODES } from '../access/basePlan.service'
import { logAction } from '../dashboard/activity-log.service'
import { getPlanState, type PlanState } from '../dashboard/planState.service'
import { scopeWhere, type CrmAccess } from './access.service'
import { teamOrganizationId } from './inbound.service'
import { MONEY, REAL_VENUE, REAL_VENUE_SQL, VENUE_HAS_MONEY_SQL } from './sweep.service'

const DEFAULT_PAGE = 50
const MAX_PAGE = 100
// ponytail: the ficha shows an organization's first 20 venues (plan read per venue, Stripe included) and says how many
// there are; page them if a client with more ever needs the rest in the ficha.
const VENUES_CAP = 20
/** `getPlanState` can go to Stripe with retries: at most this many venues of the ficha at once (ruling 41). */
const PLANS_AT_ONCE = 4
/** The steps of the signup, the same count as `getOnboardingCompletionPercentage`. */
const ONBOARDING_STEPS = 8

/**
 * Ruling 35: who is a client — over an Organization aliased `o`, in ONE bounded query over the tables `getPlanState`
 * reads, never `getPlanState` per row: a REAL venue that charged real money, holds a paid plan in force (the classic row
 * without a trial end, as `endDate` means in the schema) or a commercial contract in force (the same rule as
 * `planContractOrigin`); or a CRM account a seller won. Never the sales team's own organization (ruling 14).
 *
 * Raw SQL with correlated EXISTS (ruling 51): as Prisma relation filters inside this OR, «charged real money» became a
 * hashed subplan over every completed payment of the platform, on every page and every total. Each EXISTS here stops at
 * the first row, on `Payment(venueId, status, createdAt)`, `VenueFeature(venueId)` and `HybridContract(venueId, …)`.
 */
function clientSql(teamOrgId: string | null, now: Date): Prisma.Sql {
  return Prisma.sql`${teamOrgId ? Prisma.sql`o."id" <> ${teamOrgId} AND ` : Prisma.empty}(
    EXISTS (
      SELECT 1 FROM "Venue" v
      WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL}
        AND (
          ${VENUE_HAS_MONEY_SQL}
          OR EXISTS (
            SELECT 1 FROM "VenueFeature" vf JOIN "Feature" f ON f."id" = vf."featureId"
            WHERE vf."venueId" = v."id" AND f."code" IN (${Prisma.join(PAID_PLAN_TIER_CODES)})
              AND vf."active" = true AND vf."suspendedAt" IS NULL AND vf."endDate" IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM "HybridContract" hc
            WHERE hc."venueId" = v."id" AND hc."endedAt" IS NULL AND hc."planTier" IN ('PRO', 'PREMIUM')
              AND (hc."cancelAt" IS NULL OR hc."cancelAt" > ${utcTs(now)})
          )
        )
    )
    OR EXISTS (
      SELECT 1 FROM "CrmAccount" ca JOIN "CrmStage" cs ON cs."id" = ca."stageId"
      WHERE ca."organizationId" = o."id" AND cs."kind" = 'GANADA'
    )
  )`
}

/** A typed «%» or «_» is a letter, not a wildcard: `ILIKE`'s default escape is the backslash. */
const likeContaining = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`

/**
 * The clients «Clientes» lists, as a filter over `o`: the client rule, the hidden ones out — or only them (ruling 39) —
 * and the name search, all in the database, before the page and in the total.
 */
function clientsFilter(teamOrgId: string | null, now: Date, opts: { onlyHidden: boolean; q?: string }): Prisma.Sql {
  const hidden = Prisma.sql`EXISTS (SELECT 1 FROM "CrmHiddenClient" h WHERE h."organizationId" = o."id")`
  return Prisma.sql`${clientSql(teamOrgId, now)}
    AND ${opts.onlyHidden ? hidden : Prisma.sql`NOT ${hidden}`}${opts.q ? Prisma.sql` AND o."name" ILIKE ${likeContaining(opts.q)}` : Prisma.empty}`
}

export interface ClientFilters {
  q?: string
  cursor?: string
  limit?: number
  /** Only the hidden ones (ruling 39), to bring one back. Only with «Administrar»; for anyone else it is ignored. */
  ocultos?: boolean
}

const fullName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`.trim()

/**
 * «Clientes», a page at a time: filters and search in the database, the page capped at 100 by the server, the real total.
 * Every client is listed for whoever has «Ver negocios» — they are Avoqado's clients, not anybody's prospects — but a
 * linked CRM account shows its owner and stage only inside the caller's scope (`cuentaAjena` says there is one).
 * `yaCobro` is «Ya cobró» / «Aún no cobra». An organization marked hidden (Prime, or any internal or test one, ruling 39)
 * never takes a slot of the page nor counts in the total; `ocultos` with «Administrar» lists only those.
 */
export async function listClients(access: CrmAccess, filters: ClientFilters = {}, now = new Date()) {
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_PAGE, 1), MAX_PAGE)
  const filter = clientsFilter(await teamOrganizationId(), now, { onlyHidden: !!(filters.ocultos && access.admin), q: filters.q })
  // After the cursor's row in the same (createdAt DESC, id DESC) order; an unknown cursor leaves nothing after it.
  const after = filters.cursor
    ? Prisma.sql` AND (o."createdAt", o."id") < (SELECT c."createdAt", c."id" FROM "Organization" c WHERE c."id" = ${filters.cursor})`
    : Prisma.empty

  const [found, [{ total }]] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; name: string; createdAt: Date; crmAccountId: string | null; yaCobro: boolean }>>(Prisma.sql`
      SELECT o."id", o."name", o."createdAt",
        (SELECT ca."id" FROM "CrmAccount" ca WHERE ca."organizationId" = o."id") AS "crmAccountId",
        EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL} AND ${VENUE_HAS_MONEY_SQL}) AS "yaCobro"
      FROM "Organization" o
      WHERE ${filter}${after}
      ORDER BY o."createdAt" DESC, o."id" DESC
      LIMIT ${limit + 1}`),
    // One more than the page says whether there is a next one; the total counts the same filter, without the cursor.
    prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT COUNT(*)::int AS "total" FROM "Organization" o WHERE ${filter}`),
  ])
  const page = found.slice(0, limit)

  // The page's CRM accounts the caller may see, in one query through the same scope as every account list.
  const linked = page.filter(organization => organization.crmAccountId).map(organization => organization.id)
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
        yaCobro: organization.yaCobro,
        cuenta: account
          ? {
              id: account.id,
              owner: account.owner ? { id: account.owner.id, name: fullName(account.owner) } : null,
              stage: account.stage,
            }
          : null,
        cuentaAjena: !!organization.crmAccountId && !account,
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
 * The ficha's live part (spec §5.5): for an account linked to an Organization, its venues with their effective plan and
 * status (KYC only for «Administrar», ruling 40); the signup's progress; the owner's last sign-in; how many venues and
 * terminals. What it sells only with «Ver ventas». An account without an Organization answers `{ ligada: false }` so the
 * ficha can say why there is nothing live; one outside the caller's scope is a 404, as in `getAccount`.
 */
export async function getLive(access: CrmAccess, accountId: string, now = new Date()) {
  const account = await prisma.crmAccount.findFirst({
    where: { AND: [{ id: accountId }, scopeWhere(access, 'ver')] },
    select: { organizationId: true },
  })
  if (!account) throw new NotFoundError('No encontramos ese negocio', 'CRM_ACCOUNT_NOT_FOUND')
  if (!account.organizationId) return { ligada: false as const }
  return liveOf(access, account.organizationId, now)
}

/**
 * Ruling 47 — `GET /crm/clients/:organizationId/live`: the same live part, with the same locks, for an Organization that
 * is a client by the rule of «Clientes» (not hidden, never the team's own), so a client without a CRM account — signed
 * up by another path — is seen without creating one. Anything else is a 404.
 *
 * Ruling 56: an Organization linked to a CRM account outside the caller's «Ver» (a «propios» seller and a colleague's
 * client) answers the same 404 as `GET /accounts/:id/live` — this route never goes around the account scope.
 */
export async function getClientLive(access: CrmAccess, organizationId: string, now = new Date()) {
  const filter = clientsFilter(await teamOrganizationId(), now, { onlyHidden: false })
  const [client] = await prisma.$queryRaw<Array<{ id: string; crmAccountId: string | null }>>(Prisma.sql`
    SELECT o."id", (SELECT ca."id" FROM "CrmAccount" ca WHERE ca."organizationId" = o."id") AS "crmAccountId"
    FROM "Organization" o WHERE o."id" = ${organizationId} AND ${filter}`)
  if (!client) throw new NotFoundError('Esa organización no es cliente', 'CRM_NO_ES_CLIENTE')
  if (client.crmAccountId) {
    const visible = await prisma.crmAccount.findFirst({
      where: { AND: [{ id: client.crmAccountId }, scopeWhere(access, 'ver')] },
      select: { id: true },
    })
    if (!visible) throw new NotFoundError('No encontramos ese negocio', 'CRM_ACCOUNT_NOT_FOUND')
  }
  return liveOf(access, organizationId, now)
}

/** What is live in Avoqado for one Organization, read when the ficha opens (see `getLive`). */
async function liveOf(access: CrmAccess, organizationId: string, now: Date) {
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
  const plans = await enParaleloAcotado(venues, PLANS_AT_ONCE, venue => getPlanState(venue.id))
  const steps = onboarding?.completedSteps
  const done = Array.isArray(steps) ? steps.length : 0

  return {
    ligada: true as const,
    organizationId,
    venues: venues.map((venue, i) => ({
      id: venue.id,
      name: venue.name,
      status: venue.status,
      // Spec §5.10 (ruling 40): the seller never sees KYC, not even its status.
      ...(access.admin ? { kycStatus: venue.kycStatus } : {}),
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

// ── Hidden organizations (ruling 39) ──────────────────────────────────────────────────────────────────────────────────

/**
 * «Ocultar de Clientes» (`crm:admin`): Prime or any internal or test organization stops being listed as a client. Hiding
 * twice is a no-op, and only a real change leaves its ActivityLog with who did it.
 */
export async function hideClient(access: CrmAccess, organizationId: string) {
  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } })
  if (!organization) throw new NotFoundError('No encontramos esa organización', 'CRM_ORGANIZACION_NO_EXISTE')
  const { count } = await prisma.crmHiddenClient.createMany({ data: [{ organizationId }], skipDuplicates: true })
  if (count) {
    await logAction({
      staffId: access.staffId,
      venueId: null,
      organizationId,
      action: 'CRM_CLIENT_HIDDEN',
      entity: 'Organization',
      entityId: organizationId,
      data: { organizationName: organization.name },
    })
  }
  return { organizationId, oculta: true }
}

/** Back into «Clientes» (`crm:admin`). Unhiding one that is not hidden is a no-op. */
export async function unhideClient(access: CrmAccess, organizationId: string) {
  const { count } = await prisma.crmHiddenClient.deleteMany({ where: { organizationId } })
  if (count) {
    await logAction({
      staffId: access.staffId,
      venueId: null,
      organizationId,
      action: 'CRM_CLIENT_UNHIDDEN',
      entity: 'Organization',
      entityId: organizationId,
    })
  }
  return { organizationId, oculta: false }
}
