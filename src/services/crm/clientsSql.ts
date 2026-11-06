/**
 * The SQL of «Clientes» (plan C1): who is a client, the list's filters and EVERY statement that walks the universe
 * (`clientsQueries`). A LEAF: it builds `Prisma.Sql` and reads nothing — no Prisma client, logger, env or Stripe — so
 * `clients.service.ts` runs these statements and `scripts/crm/explain-clientes.ts` prints the very same ones without a
 * `.env`. `clients.service.ts` re-exports what other modules already imported from it.
 */
import { Prisma } from '@prisma/client'
import { BadRequestError } from '../../errors/AppError'
import { utcTs } from '../../utils/sqlDates'
import type { PAID_PLAN_TIER_CODES } from '../access/basePlan.service'
import type { CrmAccess } from './access.service'
import { altaPropiaPendienteSql, clientFactsLateral } from './clientFacts'
import { MOTIVOS_DEL_ALTA, type Estado, type MotivoDelAlta, type Nivel, type Usa } from './clientCodes'
import { REAL_VENUE_SQL, VENUE_HAS_MONEY_SQL } from './realVenueSql'

const DEFAULT_PAGE = 50
const MAX_PAGE = 100

/** The paid plans, with the `Feature.code` of its classic row and the `HybridContract.planTier` of a commercial contract. */
const PAID_PLANS = {
  PRO: { featureCode: 'PLAN_PRO', contractTier: Prisma.sql`'PRO'` },
  PREMIUM: { featureCode: 'PLAN_PREMIUM', contractTier: Prisma.sql`'PREMIUM'` },
} as const satisfies Record<string, { featureCode: (typeof PAID_PLAN_TIER_CODES)[number]; contractTier: Prisma.Sql }>
export type PaidPlan = keyof typeof PAID_PLANS

/**
 * The «paid plan in force» rule over a venue aliased `v`, shared by «Clientes» (who is a client) and the campaign
 * audiences (which plan a client has), so the two never say different things. A venue holds a paid plan when it has the
 * classic row in force without a trial end (as `endDate` means in the schema) or a commercial contract in force (the same
 * rule as `planContractOrigin`, whose `planTier` can exist with no classic row). `plans` narrows which tiers count; the
 * default is any paid one. GRATIS is the absence of it: `NOT planVigenteSql(now)`.
 *
 * Two correlated EXISTS (ruling 51), each stopping at its first row on `VenueFeature(venueId)` and
 * `HybridContract(venueId, …)`.
 */
export function planVigenteSql(now: Date, plans: readonly PaidPlan[] = ['PRO', 'PREMIUM']): Prisma.Sql {
  return Prisma.sql`(
          EXISTS (
            SELECT 1 FROM "VenueFeature" vf JOIN "Feature" f ON f."id" = vf."featureId"
            WHERE vf."venueId" = v."id" AND f."code" IN (${Prisma.join(plans.map(plan => PAID_PLANS[plan].featureCode))})
              AND vf."active" = true AND vf."suspendedAt" IS NULL AND vf."endDate" IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM "HybridContract" hc
            WHERE hc."venueId" = v."id" AND hc."endedAt" IS NULL AND hc."planTier" IN (${Prisma.join(
              plans.map(plan => PAID_PLANS[plan].contractTier),
              ', ',
            )})
              AND (hc."cancelAt" IS NULL OR hc."cancelAt" > ${utcTs(now)})
          )
        )`
}

/**
 * Ruling 35: who is a client — over an Organization aliased `o`, in ONE bounded query over the tables `getPlanState`
 * reads, never `getPlanState` per row: a REAL venue that charged real money, holds a paid plan in force (`planVigenteSql`)
 * or a commercial contract in force; or a CRM account a seller won. Never the sales team's own organization (ruling 14).
 *
 * Raw SQL with correlated EXISTS (ruling 51): as Prisma relation filters inside this OR, «charged real money» became a
 * hashed subplan over every completed payment of the platform, on every page and every total. Each EXISTS here stops at
 * the first row, on `Payment(venueId, status, createdAt)`, `VenueFeature(venueId)` and `HybridContract(venueId, …)`.
 */
export function clientSql(teamOrgId: string | null, now: Date): Prisma.Sql {
  return Prisma.sql`${teamOrgId ? Prisma.sql`o."id" <> ${teamOrgId} AND ` : Prisma.empty}(
    EXISTS (
      SELECT 1 FROM "Venue" v
      WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL}
        AND (
          ${VENUE_HAS_MONEY_SQL}
          OR ${planVigenteSql(now)}
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
export function clientsFilter(
  teamOrgId: string | null,
  now: Date,
  opts: { onlyHidden: boolean; q?: string; conAltas?: boolean },
): Prisma.Sql {
  const hidden = Prisma.sql`EXISTS (SELECT 1 FROM "CrmHiddenClient" h WHERE h."organizationId" = o."id")`
  // The stalled signups (P1 = A) join only when the request asks; `clientSql` itself never changes (campaigns read it).
  const universe = opts.conAltas
    ? Prisma.sql`(${clientSql(teamOrgId, now)} OR (${teamOrgId ? Prisma.sql`o."id" <> ${teamOrgId} AND ` : Prisma.empty}${altaPropiaPendienteSql()}))`
    : clientSql(teamOrgId, now)
  return Prisma.sql`${universe}
    AND ${opts.onlyHidden ? hidden : Prisma.sql`NOT ${hidden}`}${opts.q ? Prisma.sql` AND o."name" ILIKE ${likeContaining(opts.q)}` : Prisma.empty}`
}

export interface ClientFilters {
  q?: string
  cursor?: string
  limit?: number
  /** Only the hidden ones (ruling 39), to bring one back. Only with «Configurar el CRM» (L7); for anyone else it is ignored. */
  ocultos?: boolean
  /** Also list the signups that stopped before giving a card (P1 = A). Only the new SUPERADMIN and the MCP ask. */
  altas?: boolean
  /** What it uses, as seen (✋ ?? measured); `AVISO` = a ✋ that differs from the measure. */
  usa?: Usa | 'AVISO'
  /** The canonical plan level (`f."nivel"`). There is no «condición» filter (redesign r3). */
  nivel?: Nivel
  estado?: Estado
  /** `MIOS`, `SIN_DUENO` (no account or an account nobody owns) or an owner's id (only with «Ver: todos»). */
  dueno?: 'MIOS' | 'SIN_DUENO' | string
  /** Why a 🟠 stalled — only on accounts in the caller's «Ver». Implies `estado = ALTA_SIN_TARJETA`. */
  motivo?: MotivoDelAlta | 'SIN_MOTIVO'
}

/** The page size the server allows: 50 by default, never above 100. */
export const pageSize = (limit?: number) => Math.min(Math.max(limit ?? DEFAULT_PAGE, 1), MAX_PAGE)

/**
 * `scopeWhere(access, 'ver')` in SQL over the CRM account aliased `alias` (LEFT-joined: with no account, `ownerStaffId` is
 * null and «propios» matches, as an account nobody owns). Its integration test compares it with `scopeWhere` row by row.
 */
export function scopeSql(access: CrmAccess, alias: string): Prisma.Sql {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`Alias SQL inválido: ${alias}`)
  const a = Prisma.raw(alias)
  if (access.ver === 'todos') return Prisma.sql`TRUE`
  if (access.ver === 'propios') return Prisma.sql`(${a}."ownerStaffId" = ${access.staffId} OR ${a}."ownerStaffId" IS NULL)`
  return Prisma.sql`FALSE`
}

/** «Usa» as the cell paints it and the filter reads it: a person's ✋ over the measure, and the warning when they differ. */
const USA_VISTO = Prisma.sql`COALESCE(ca."usaManual", f."usaMedido")`
const USA_AVISO = Prisma.sql`(ca."usaManual" IS NOT NULL AND ca."usaManual" <> f."usaMedido")`
const ES_ALTA = Prisma.sql`f."estado" = 'ALTA_SIN_TARJETA'`

/** The caller's own id is «Míos»: the same filter, whatever the scope. */
const duenoDe = (access: CrmAccess, dueno: string | undefined) => (dueno === access.staffId ? 'MIOS' : dueno)

/** A «propios» seller filters only «Míos» or «Sin dueño»: another owner's id would tell who owns what (Review Focus 2). */
export function checkDueno(access: CrmAccess, dueno: string | undefined) {
  const own = duenoDe(access, dueno)
  if (own && own !== 'MIOS' && own !== 'SIN_DUENO' && access.ver !== 'todos')
    throw new BadRequestError('Con «Ver: propios» sólo puedes filtrar «Míos» o «Sin dueño»', 'CRM_FILTRO_DE_DUENO')
}

/** A reason of a 🟠, only on accounts the caller sees; «Sin hablarle» = no account, or a visible one without a reason. */
function motivoSql(access: CrmAccess, motivo: MotivoDelAlta | 'SIN_MOTIVO'): Prisma.Sql {
  const visible = scopeSql(access, 'ca')
  return motivo === 'SIN_MOTIVO'
    ? Prisma.sql`(${ES_ALTA} AND (ca."id" IS NULL OR (${visible} AND ca."altaMotivo" IS NULL)))`
    : Prisma.sql`(${ES_ALTA} AND ${visible} AND ca."altaMotivo" = ${motivo})`
}

/** The filters over `f.*` and `ca.*`, in the `WHERE` of the page and of the total. */
function filtrosSql(access: CrmAccess, filters: ClientFilters): Prisma.Sql {
  checkDueno(access, filters.dueno)
  const dueno = duenoDe(access, filters.dueno)
  const parts: Prisma.Sql[] = []
  if (filters.usa) parts.push(filters.usa === 'AVISO' ? USA_AVISO : Prisma.sql`${USA_VISTO} = ${filters.usa}`)
  if (filters.nivel) parts.push(Prisma.sql`f."nivel" = ${filters.nivel}`)
  if (filters.estado) parts.push(Prisma.sql`f."estado" = ${filters.estado}`)
  if (dueno === 'MIOS') parts.push(Prisma.sql`ca."ownerStaffId" = ${access.staffId}`)
  else if (dueno === 'SIN_DUENO') parts.push(Prisma.sql`(ca."id" IS NULL OR ca."ownerStaffId" IS NULL)`)
  else if (dueno) parts.push(Prisma.sql`ca."ownerStaffId" = ${dueno}`)
  if (filters.motivo) parts.push(motivoSql(access, filters.motivo))
  return parts.length ? Prisma.sql` AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty
}

/**
 * EVERY statement of «Clientes» that walks the universe (Codex r2 #3): the page, its total and the count of 🟠 by reason.
 * In the count, a 🟠 whose account the caller does not see is `DE_OTRO` (whatever its reason, lost or not) and `perdidos`
 * counts only the caller's own (Codex r1 #3), so the reasons of a 🟠 always add up to `altaSinTarjeta`.
 * `listClients` runs exactly these (a test pins it) and `scripts/crm/explain-clientes.ts` measures exactly these. The page
 * and the total share one `FROM … WHERE` (filters before the cursor); the count is always over the widened universe
 * (`altas`) with the search and «Ocultos» only, so the header never moves when filtering (C16).
 */
export function clientsQueries(access: CrmAccess, filters: ClientFilters, now: Date, teamOrgId: string | null) {
  const from = (conAltas: boolean) => Prisma.sql`FROM "Organization" o
      LEFT JOIN "CrmAccount" ca ON ca."organizationId" = o."id"
      ${clientFactsLateral(now)}
      WHERE ${clientsFilter(teamOrgId, now, { onlyHidden: !!(filters.ocultos && access.configurar), q: filters.q, conAltas })}`
  const listed = Prisma.sql`${from(filters.altas === true)}${filtrosSql(access, filters)}`
  // After the cursor's row in the same (createdAt DESC, id DESC) order; an unknown cursor leaves nothing after it.
  const after = filters.cursor
    ? Prisma.sql` AND (o."createdAt", o."id") < (SELECT c."createdAt", c."id" FROM "Organization" c WHERE c."id" = ${filters.cursor})`
    : Prisma.empty
  const porMotivo = MOTIVOS_DEL_ALTA.map(
    motivo => Prisma.sql`COUNT(*) FILTER (WHERE ${motivoSql(access, motivo)})::int AS ${Prisma.raw(`"${motivo}"`)}`,
  )
  return {
    page: Prisma.sql`
      SELECT o."id", o."name", o."createdAt", ca."id" AS "crmAccountId",
        EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL} AND ${VENUE_HAS_MONEY_SQL}) AS "yaCobro",
        f."usaMedido", ${USA_VISTO} AS "usaVisto", ${USA_AVISO} AS "usaAviso", ca."usaManual" IS NOT NULL AS "usaEscrito",
        f."nivel", f."estado", f."ultimoCobroAt"
      ${listed}${after}
      ORDER BY o."createdAt" DESC, o."id" DESC
      LIMIT ${pageSize(filters.limit) + 1}`,
    // One more than the page says whether there is a next one; the total counts the same filter, without the cursor.
    total: Prisma.sql`SELECT COUNT(*)::int AS "total" ${listed}`,
    conteos: Prisma.sql`
      SELECT COUNT(*) FILTER (WHERE ${ES_ALTA})::int AS "altaSinTarjeta", ${Prisma.join(porMotivo, ', ')},
        COUNT(*) FILTER (WHERE ${motivoSql(access, 'SIN_MOTIVO')})::int AS "SIN_MOTIVO",
        COUNT(*) FILTER (WHERE ${ES_ALTA} AND ca."id" IS NOT NULL AND NOT ${scopeSql(access, 'ca')})::int AS "DE_OTRO",
        COUNT(*) FILTER (WHERE ${ES_ALTA} AND ${scopeSql(access, 'ca')} AND ca."altaPerdido")::int AS "perdidos"
      ${from(true)}`,
  }
}
