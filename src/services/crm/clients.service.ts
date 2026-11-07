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
import { ConflictError, InternalServerError, NotFoundError } from '../../errors/AppError'
import { isProductionVenue } from '../../lib/venueStatus.constants'
import { enParaleloAcotado } from '../../utils/concurrencyLimiter'
import { DEFAULT_TIMEZONE, formatInVenueTimezone } from '../../utils/datetime'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { getPlanState, type PlanState } from '../dashboard/planState.service'
import { ensureCrmDefaults, lockEditableTx, touchNoEarlierTx } from './accounts.service'
import { cambioAlEditar, mismoTexto } from './loQueSeVio'
import { scopeWhere, type CrmAccess } from './access.service'
import type { MotivoDelAlta, Nivel, UsaEscrito } from './clientCodes'
import { altaPendienteSql, monedaDelPagoSql } from './clientFacts'
import { REAL_VENUE_SQL } from './realVenueSql'
import { utcTs } from '../../utils/sqlDates'
import {
  altaDeLaFila,
  altaFactsOf,
  aparatosDe,
  autoresDelUsa,
  conteosDe,
  ingresoDeLaFila,
  type IngresoDeLaFila,
  planDeLaFila,
  planDeLaPagina,
  ultimosComentarios,
  usaDeLaFila,
  type UsaDeLaFila,
} from './clientPage'
import {
  checkDueno,
  clientSql,
  clientsFilter,
  clientsQueries,
  hechosDeUnaOrganizacion,
  ingresoDeOrganizacionSql,
  pageSize,
  type ClientFilters,
} from './clientsSql'
import { teamOrganizationId } from './inbound.service'
import { addEvent } from './timeline.service'

// The SQL lives in the leaf `clientsSql.ts`; these were imported from here before it existed.
export { clientSql, clientsFilter, clientsQueries, planVigenteSql, scopeSql, type ClientFilters, type PaidPlan } from './clientsSql'

// ponytail: the ficha shows an organization's first 20 venues (plan read per venue, Stripe included) and says how many
// there are; page them if a client with more ever needs the rest in the ficha.
const VENUES_CAP = 20
/** `getPlanState` can go to Stripe with retries: at most this many venues of the ficha at once (ruling 41). */
const PLANS_AT_ONCE = 4
/** The steps of the signup, the same count as `getOnboardingCompletionPercentage`. */
const ONBOARDING_STEPS = 8

const fullName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`.trim()

type PageRow = IngresoDeLaFila & {
  id: string
  name: string
  createdAt: Date
  crmAccountId: string | null
  yaCobro: boolean
  usaMedido: string
  usaVisto: string
  usaAviso: boolean
  usaEscrito: boolean
  nivel: Nivel
  estado: string
  ultimoCobroAt: Date | null
}

/**
 * «Clientes», a page at a time: filters and search in the database, the page capped at 100 by the server, the real total.
 * Every client is listed for whoever has «Ver negocios» — they are Avoqado's clients, not anybody's prospects — but a
 * linked CRM account shows its owner and stage only inside the caller's scope (`cuentaAjena` says there is one).
 * `yaCobro` is «Ya cobró» / «Aún no cobra». An organization marked hidden (Prime, or any internal or test one, ruling 39)
 * never takes a slot of the page nor counts in the total; `ocultos` with «Configurar el CRM» lists only those.
 * `legible: 1` tells a client this server filters and paints the C1 columns (Usa, Plan, Estado). Each row also carries, read
 * for the page only (task 5): its devices, its plan's condition by the platform's own rules, a 🟠's signup and the newest
 * note of an account the caller sees; `conteos` counts the 🟠 by reason, only when the request lists them (`altas=true`).
 */
export async function listClients(access: CrmAccess, filters: ClientFilters = {}, now = new Date()) {
  checkDueno(access, filters.dueno)
  const limit = pageSize(filters.limit)
  const queries = clientsQueries(access, filters, now, await teamOrganizationId())
  // The count of 🟠 only for whoever lists the signups (`altas=true`): an old SUPERADMIN never sends it nor reads it.
  const conAltas = filters.altas === true
  const [found, [{ total }], conteo] = await Promise.all([
    prisma.$queryRaw<PageRow[]>(queries.page),
    prisma.$queryRaw<Array<{ total: number }>>(queries.total),
    conAltas ? prisma.$queryRaw<Array<Record<string, number>>>(queries.conteos) : null,
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
          usaManual: true,
          usaManualPorque: true,
          usaManualById: true,
          usaManualAt: true,
          altaMotivo: true,
          altaMotivoTexto: true,
          altaPerdido: true,
        },
        orderBy: [{ id: 'asc' }],
        take: linked.length,
      })
    : []
  const byOrganization = new Map(visible.map(account => [account.organizationId, account]))
  // What the page adds (task 5), each in ONE query for the whole page and only for its ids: who wrote the ✋, the plan by
  // the platform's own rules, the devices, the signup of the 🟠 rows and the newest note of the accounts the caller sees.
  const ids = page.map(organization => organization.id)
  const [autores, planes, aparatos, altas, comentarios] = await Promise.all([
    autoresDelUsa(visible),
    planDeLaPagina(ids, now),
    aparatosDe(ids),
    altaFactsOf(page.filter(organization => organization.estado === 'ALTA_SIN_TARJETA').map(organization => organization.id)),
    ultimosComentarios(visible.map(account => account.id)),
  ])

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
        usa: { ...usaDeLaFila(organization, account, autores), aparatos: aparatos.get(organization.id) ?? { terminales: 0, pos: 0 } },
        plan: planDeLaFila(organization.id, organization.nivel, planes.get(organization.id)),
        estado: { codigo: organization.estado, ultimoCobroAt: organization.ultimoCobroAt },
        // Only a 🟠: what the signup left; its reason and «Perdido» only for an account the caller sees.
        alta: organization.estado === 'ALTA_SIN_TARJETA' ? altaDeLaFila(altas.get(organization.id), account) : null,
        ultimoComentario: (account && comentarios.get(account.id)) ?? null,
        // C1b: from the same lateral the filter reads; the amount only with «Ver ventas».
        ingreso: ingresoDeLaFila(organization, access.ventas),
      }
    }),
    nextCursor: found.length > limit ? page[page.length - 1].id : null,
    total,
    ...(conteo ? { conteos: conteosDe(conteo[0]) } : {}),
    legible: 1 as const,
    /** C1b: this server paints and filters «Ingreso»; a new SUPERADMIN sends no `ingreso` filter before seeing it. */
    ingreso: 1 as const,
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

/**
 * What the organization charged for real this month, in MXN pesos (`MONEY` and `REAL_VENUE` in SQL), and whether it also charged
 * in another currency: currencies are never added up (Codex r2 #3, the rule of «Ingreso», `monedaDelPagoSql`).
 */
async function monthSales(organizationId: string, now: Date): Promise<{ total: Prisma.Decimal; otraMoneda: boolean }> {
  const { gte, lt } = teamMonth(now)
  const [row] = await prisma.$queryRaw<Array<{ ventasMXN: Prisma.Decimal | null; otraMoneda: boolean }>>(Prisma.sql`
    SELECT SUM(p."amount") FILTER (WHERE ${monedaDelPagoSql} = 'MXN') AS "ventasMXN",
      COALESCE(BOOL_OR(${monedaDelPagoSql} <> 'MXN'), false) AS "otraMoneda"
    FROM "Venue" v JOIN "Payment" p ON p."venueId" = v."id"
    WHERE v."organizationId" = ${organizationId} AND ${REAL_VENUE_SQL}
      AND p."status" = 'COMPLETED' AND p."amount" > 0 AND p."createdAt" >= ${utcTs(gte)} AND p."createdAt" < ${utcTs(lt)}`)
  return { total: row?.ventasMXN ?? new Prisma.Decimal(0), otraMoneda: row?.otraMoneda ?? false }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * C2 Tarea 5 — «Cobrado · 30 días»: every real charge of its real venues since 30 × 24 h ago (inclusive), with the SAME rules
 * as «Cobrado este mes» (`monthSales`): only MXN is added; another currency is only flagged, never converted.
 */
async function cobradoEn30Dias(organizationId: string, now: Date): Promise<{ total: Prisma.Decimal; otraMoneda: boolean }> {
  const desde = new Date(now.getTime() - 30 * DAY_MS)
  const [row] = await prisma.$queryRaw<Array<{ cobradoMXN: Prisma.Decimal | null; otraMoneda: boolean }>>(Prisma.sql`
    SELECT SUM(p."amount") FILTER (WHERE ${monedaDelPagoSql} = 'MXN') AS "cobradoMXN",
      COALESCE(BOOL_OR(${monedaDelPagoSql} <> 'MXN'), false) AS "otraMoneda"
    FROM "Venue" v JOIN "Payment" p ON p."venueId" = v."id"
    WHERE v."organizationId" = ${organizationId} AND ${REAL_VENUE_SQL}
      AND p."status" = 'COMPLETED' AND p."amount" > 0 AND p."createdAt" >= ${utcTs(desde)}`)
  return { total: row?.cobradoMXN ?? new Prisma.Decimal(0), otraMoneda: row?.otraMoneda ?? false }
}

const FISCAL_CAP = 5

/**
 * C2 Tarea 5 (Duda 3): RFC and business name from the invoice issuer (`FiscalEmisor`) of its first venues, never
 * `Venue.rfc`/`legalName` (KYC, ruling 40). No repeated RFC, at most 5.
 */
async function fiscalDe(venueIds: string[]): Promise<Array<{ rfc: string; razonSocial: string }>> {
  if (!venueIds.length) return []
  const emisores = await prisma.fiscalEmisor.findMany({
    where: { venueId: { in: venueIds } },
    select: { rfc: true, legalName: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: venueIds.length * 2,
  })
  const unicos = new Map<string, string>()
  for (const emisor of emisores) if (!unicos.has(emisor.rfc)) unicos.set(emisor.rfc, emisor.legalName)
  return [...unicos].slice(0, FISCAL_CAP).map(([rfc, razonSocial]) => ({ rfc, razonSocial }))
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
  const filter = clientsFilter(await teamOrganizationId(), now, { onlyHidden: false, conAltas: true })
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
  const [venues, sucursales, owner, onboarding, terminales, ventasMes, altaFacts, org, [ingreso]] = await Promise.all([
    prisma.venue.findMany({
      where: { organizationId },
      select: { id: true, name: true, status: true, kycStatus: true, demoExpiresAt: true, _count: { select: { terminals: true } } },
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
    altaFactsOf([organizationId]),
    prisma.organization.findUnique({ where: { id: organizationId }, select: { seatCapExempt: true } }),
    // C1b: «Ingreso» with the same lateral and columns as the row of «Clientes».
    prisma.$queryRaw<IngresoDeLaFila[]>(ingresoDeOrganizacionSql(organizationId, now, access.ventas)),
  ])
  // C2 Tarea 5: «Usa» and «Estado» as the list paints them, the money of 30 days and the RFC — a fixed number of queries.
  const [plans, [hechos], visibles, aparatos, cobrado30, fiscal] = await Promise.all([
    enParaleloAcotado(venues, PLANS_AT_ONCE, venue => getPlanState(venue.id)),
    prisma.$queryRaw<Array<UsaDeLaFila & { estado: string; ultimoCobroAt: Date | null }>>(hechosDeUnaOrganizacion(organizationId, now)),
    // Who wrote the ✋ and why, only from an account in the caller's «Ver» (as the list).
    prisma.crmAccount.findMany({
      where: { AND: [{ organizationId }, scopeWhere(access, 'ver')] },
      select: { usaManual: true, usaManualPorque: true, usaManualById: true, usaManualAt: true },
      orderBy: [{ id: 'asc' }],
      take: 1,
    }),
    aparatosDe([organizationId]),
    access.ventas ? cobradoEn30Dias(organizationId, now) : null,
    fiscalDe(venues.map(venue => venue.id)),
  ])
  const autores = await autoresDelUsa(visibles)
  const steps = onboarding?.completedSteps
  const done = Array.isArray(steps) ? steps.length : 0

  return {
    ligada: true as const,
    organizationId,
    // «Cliente de antes» is the organization's mark (what `plan/grandfathered` writes), not a plan condition of one store.
    deAntes: org?.seatCapExempt === true,
    venues: venues.map((venue, i) => ({
      id: venue.id,
      name: venue.name,
      status: venue.status,
      // Not a real store (the `REAL_VENUE` rule of the list): a plan is never offered on it (the drawer «Plan…» hides it).
      demo: !isProductionVenue(venue.status) || venue.demoExpiresAt !== null,
      // Spec §5.10 (ruling 40): the seller never sees KYC, not even its status. Sólo «Configurar el CRM» (L7).
      ...(access.configurar ? { kycStatus: venue.kycStatus } : {}),
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
          // An unfinished signup also says what the database knows of it (the same facts as the 🟠 row of the list).
          ...(onboarding.completedAt ? {} : altaFacts.get(organizationId)),
        }
      : null,
    ventasMes: ventasMes?.total ?? null,
    /** C1b (Codex r2 #3): it also charged in another currency this month (not added to `ventasMes`). Only with «Ver ventas». */
    ventasMesOtraMoneda: ventasMes?.otraMoneda ?? null,
    ventasBloqueadas: !access.ventas,
    ingreso: ingreso ? ingresoDeLaFila(ingreso, access.ventas) : null,
    usa: hechos
      ? { ...usaDeLaFila(hechos, visibles[0], autores), aparatos: aparatos.get(organizationId) ?? { terminales: 0, pos: 0 } }
      : null,
    estado: hechos ? { codigo: hechos.estado, ultimoCobroAt: hechos.ultimoCobroAt } : null,
    /** C2: everything charged in 30 days (MXN); only with «Ver ventas». */
    cobrado30: cobrado30?.total ?? null,
    cobrado30OtraMoneda: cobrado30?.otraMoneda ?? null,
    fiscal,
  }
}

/**
 * Task 6 — `POST /crm/clients/:organizationId/cuenta`: the CRM account of a client that has none, made once (the «Usa» ✋ and
 * the signup's reason are written on it). The organization must be listed in «Clientes» (altas sin tarjeta included) or it is
 * a 404. A real client opens as «Ganado» (source `CLIENTE`); a stalled signup in the first open stage (source `ALTA`) — never
 * «Ganado», which would make it a client for the campaigns. Neither has an owner nor `wonAt`.
 *
 * Insert first (`skipDuplicates`: the Organization is unique) and ONE read after it, through the caller's «Ver» scope
 * (Codex r1 #5): an account somebody else made and took is a 404, never handed back. A tombstone of D7 does not stop it:
 * this is a person asking on purpose (§5.2).
 */
export async function ensureClientAccount(access: CrmAccess, organizationId: string): Promise<{ accountId: string; creada: boolean }> {
  const teamOrgId = await teamOrganizationId()
  const now = new Date()
  const [client] = await prisma.$queryRaw<Array<{ id: string; name: string; esCliente: boolean }>>(Prisma.sql`
    SELECT o."id", o."name", ${clientSql(teamOrgId, now)} AS "esCliente"
    FROM "Organization" o WHERE o."id" = ${organizationId} AND ${clientsFilter(teamOrgId, now, { onlyHidden: false, conAltas: true })}`)
  if (!client) throw new NotFoundError('Esa organización no es cliente', 'CRM_NO_ES_CLIENTE')

  const [kind, source] = client.esCliente ? (['GANADA', 'CLIENTE'] as const) : (['ABIERTA', 'ALTA'] as const)
  await ensureCrmDefaults()
  const stage = await prisma.crmStage.findFirst({ where: { kind }, orderBy: [{ order: 'asc' }, { id: 'asc' }], select: { id: true } })
  if (!stage) throw new InternalServerError(`El CRM no tiene la etapa ${kind === 'GANADA' ? 'Ganado' : 'abierta'}`)

  const result = await prisma.$transaction(async tx => {
    const { count } = await tx.crmAccount.createMany({
      data: [{ name: client.name, source, stageId: stage.id, organizationId }],
      skipDuplicates: true,
    })
    const account = await tx.crmAccount.findFirst({
      where: { AND: [{ organizationId }, scopeWhere(access, 'ver')] },
      select: { id: true },
    })
    if (!account) throw new NotFoundError('No encontramos ese negocio', 'CRM_ACCOUNT_NOT_FOUND')
    if (count === 1) {
      await addEvent(tx, { accountId: account.id, kind: 'SYSTEM', actorStaffId: access.staffId, data: { event: 'CLIENT_ACCOUNT_OPENED' } })
    }
    return { accountId: account.id, creada: count === 1 }
  })
  if (result.creada) {
    void logAction({
      staffId: access.staffId,
      venueId: null,
      organizationId,
      action: 'CRM_CLIENT_ACCOUNT_CREATED',
      entity: 'CrmAccount',
      entityId: result.accountId,
      data: { organizationId, source },
    })
  }
  return result
}

/**
 * «✋ a mano» en Usa (C1, tarea 7): a seller with «Editar» writes what the client uses, with the reason, or clears it
 * (`valor: null`, «Leerlo solo»). The reason lives only in the timeline event: the ActivityLog never carries it. Clearing
 * what is already clear, or writing the same value with the same reason, writes nothing (no event, no touch).
 * `vio` is what the editor saw when opening it: if what is saved is something else, 409 `CRM_CAMBIO_AL_EDITAR` and nothing is
 * written. Asking for what is already saved stays a no-op even then (a retry of one's own save is never a conflict).
 */
export async function setUsa(
  access: CrmAccess,
  accountId: string,
  input: { valor: UsaEscrito | null; porque?: string; vio?: { valor: UsaEscrito | null; porque: string | null } },
): Promise<{ accountId: string; usaManual: UsaEscrito | null }> {
  const now = new Date()
  const { valor } = input
  const changed = await prisma.$transaction(async tx => {
    await lockEditableTx(tx, access, accountId)
    const before = await tx.crmAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { usaManual: true, usaManualPorque: true, organizationId: true },
    })
    // The same thing again (clear on clear, or the same value with the same reason) writes nothing, as `setAltaMotivo`.
    if (before.usaManual === valor && (valor === null || before.usaManualPorque === input.porque)) return null
    const { vio } = input
    if (vio && (vio.valor !== before.usaManual || (vio.valor !== null && !mismoTexto(vio.porque, before.usaManualPorque))))
      throw cambioAlEditar()
    await touchNoEarlierTx(tx, accountId, now)
    await tx.crmAccount.update({
      where: { id: accountId },
      data:
        valor === null
          ? { usaManual: null, usaManualPorque: null, usaManualById: null, usaManualAt: null }
          : { usaManual: valor, usaManualPorque: input.porque, usaManualById: access.staffId, usaManualAt: now },
    })
    await addEvent(tx, {
      accountId,
      kind: 'USA_CHANGE',
      actorStaffId: access.staffId,
      data: valor === null ? { valor: null } : { valor, porque: input.porque! },
    })
    return before
  })
  if (changed) {
    void logAction({
      staffId: access.staffId,
      venueId: null,
      organizationId: changed.organizationId,
      action: valor === null ? 'CRM_CLIENT_USA_CLEARED' : 'CRM_CLIENT_USA_SET',
      entity: 'CrmAccount',
      entityId: accountId,
      data: valor === null ? {} : { valor },
    })
  }
  return { accountId, usaManual: valor }
}

/**
 * «¿Por qué se quedó?» (C1, tarea 8): a seller with «Editar» writes why a stalled signup stopped (from the fixed list, with
 * text for «Otro») and/or marks it «Perdido» (its own flag, not the Embudo's «Perder»). «Terminó el alta» is never written:
 * once the organization stops being a pending signup (`altaPendienteSql`, the rule that paints the 🟠) it is a 409 and
 * nothing is written. The text lives only in the timeline event: the ActivityLog never carries it. The same value again
 * writes nothing. `lockEditableTx` locks the row without touching it (a no-op never resets «Estancado»), so the pending check and the write see the same account.
 * `vio` is what the editor saw when opening it: if what is saved is something else, 409 `CRM_CAMBIO_AL_EDITAR` and nothing is
 * written (as in `setUsa`, the same value again stays a no-op).
 */
export async function setAltaMotivo(
  access: CrmAccess,
  accountId: string,
  input: {
    motivo: MotivoDelAlta | null
    texto?: string
    perdido: boolean
    vio?: { motivo: MotivoDelAlta | null; texto: string | null; perdido: boolean }
  },
): Promise<{ accountId: string; motivo: MotivoDelAlta | null; texto: string | null; perdido: boolean }> {
  const now = new Date()
  const { motivo, perdido } = input
  const texto = motivo === 'OTRO' ? (input.texto ?? null) : null
  const changed = await prisma.$transaction(async tx => {
    await lockEditableTx(tx, access, accountId)
    const before = await tx.crmAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { altaMotivo: true, altaMotivoTexto: true, altaPerdido: true, organizationId: true },
    })
    if (!before.organizationId) throw new ConflictError('Este cliente no tiene un alta pendiente', 'CRM_NO_ES_ALTA')
    const pendiente = await tx.$queryRaw<Array<{ pendiente: number }>>(
      Prisma.sql`SELECT 1 AS "pendiente" FROM "Organization" o WHERE o."id" = ${before.organizationId} AND ${altaPendienteSql()} LIMIT 1`,
    )
    if (!pendiente.length) throw new ConflictError('Ya terminó su alta: ya no hace falta el motivo', 'CRM_ALTA_TERMINADA')
    if (before.altaMotivo === motivo && before.altaMotivoTexto === texto && before.altaPerdido === perdido) return null
    const { vio } = input
    if (vio && (vio.motivo !== before.altaMotivo || !mismoTexto(vio.texto, before.altaMotivoTexto) || vio.perdido !== before.altaPerdido))
      throw cambioAlEditar()
    await touchNoEarlierTx(tx, accountId, now)
    await tx.crmAccount.update({ where: { id: accountId }, data: { altaMotivo: motivo, altaMotivoTexto: texto, altaPerdido: perdido } })
    await addEvent(tx, {
      accountId,
      kind: 'ALTA_MOTIVO',
      actorStaffId: access.staffId,
      data: texto ? { motivo, texto, perdido } : { motivo, perdido },
    })
    return before
  })
  if (changed) {
    void logAction({
      staffId: access.staffId,
      venueId: null,
      organizationId: changed.organizationId,
      action: 'CRM_CLIENT_ALTA_MOTIVO_SET',
      entity: 'CrmAccount',
      entityId: accountId,
      data: { motivo, perdido },
    })
  }
  return { accountId, motivo, texto, perdido }
}

// ── Hidden organizations (ruling 39) ──────────────────────────────────────────────────────────────────────────────────

/**
 * «Ocultar de Clientes» (`crm:configurar`): Prime or any internal or test organization stops being listed as a client. Hiding
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

/** Back into «Clientes» (`crm:configurar`). Unhiding one that is not hidden is a no-op. */
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
