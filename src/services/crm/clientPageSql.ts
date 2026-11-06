/**
 * The SQL of what «Clientes» adds to ONE page (plan C1, task 5): every statement reads only the ids of the page, one
 * statement per thing for the whole page (never per row). A LEAF like `clientsSql.ts` — it builds `Prisma.Sql` and reads
 * nothing — so `clientPage.ts` runs these and `scripts/crm/explain-clientes.ts --ids` prints the very same ones (C3).
 *
 * Every caller passes a non-empty list: `IN ()` is not SQL, and an empty page asks nothing.
 */
import { Prisma } from '@prisma/client'
import { utcTs } from '../../utils/sqlDates'
import { altaPendienteSql, concesionComercialSql } from './clientFacts'
import { REAL_VENUE_SQL } from './realVenueSql'

/** The plan of the list reads the first 20 real venues of each organization, as the ficha does. */
export const SUCURSALES_LEIDAS = 20

/** A comment longer than this travels cut, with «…», so the page never carries a long note. */
export const LARGO_DEL_COMENTARIO = 140

/**
 * The first 20 real venues of each organization (`createdAt`, `id`), with its grandfather flags and the organization's,
 * whether it holds a commercial grant of each tier (`concesionComercialSql`, the parity-tested twin of
 * `getContractBaseTier`) and how many real venues the organization has in total.
 */
export function sucursalesSql(organizationIds: string[], now: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT s."id", s."organizationId", s."seatCapExempt", s."orgSeatCapExempt", s."total",
      ${concesionComercialSql('s', now, 'PRO')} AS "concesionPro", ${concesionComercialSql('s', now, 'PREMIUM')} AS "concesionPremium"
    FROM (
      SELECT v."id", v."organizationId", v."seatCapExempt", o."seatCapExempt" AS "orgSeatCapExempt",
        ROW_NUMBER() OVER (PARTITION BY v."organizationId" ORDER BY v."createdAt", v."id") AS "n",
        COUNT(*) OVER (PARTITION BY v."organizationId")::int AS "total"
      FROM "Venue" v JOIN "Organization" o ON o."id" = v."organizationId"
      WHERE v."organizationId" IN (${Prisma.join(organizationIds)}) AND ${REAL_VENUE_SQL}
    ) s
    WHERE s."n" <= ${SUCURSALES_LEIDAS}::int
    ORDER BY s."organizationId", s."n"`
}

/**
 * The contract that sets each venue's commercial plan: the `where` and the order of `planContractOrigin`
 * (`planState.service.ts`) — not ended, PRO or PREMIUM, its cancellation not in effect, Premium over Pro (text order), the
 * newest — one per venue (so at most one row per id: the `LIMIT` says it), with the name of its publication.
 */
export function contratosSql(venueIds: string[], now: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT ON (hc."venueId") hc."venueId", hc."planTier", p."name"
    FROM "HybridContract" hc JOIN "HybridOfferPublication" p ON p."id" = hc."publicationId"
    WHERE hc."venueId" IN (${Prisma.join(venueIds)}) AND hc."endedAt" IS NULL AND hc."planTier" IN ('PRO', 'PREMIUM')
      AND (hc."cancelAt" IS NULL OR hc."cancelAt" > ${utcTs(now)})
    ORDER BY hc."venueId", hc."planTier" ASC, hc."createdAt" DESC, hc."id" DESC
    LIMIT ${venueIds.length}::int`
}

/**
 * The newest launch-campaign redemption that was CHARGED (`APPLIED`) of each organization, with what it accepted (a copy
 * kept on the redemption) and WHEN it accepted it (`reservedAt`; `appliedAt` moves when a recovery closes it, Codex r4 #2).
 * One per organization, so the `LIMIT` is the page's size.
 */
export function canjesSql(organizationIds: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT ON (r."organizationId") r."organizationId", c."name", r."advertisedPriceCents", r."discountMonths", r."reservedAt"
    FROM "LaunchCampaignRedemption" r JOIN "LaunchCampaign" c ON c."id" = r."campaignId"
    WHERE r."organizationId" IN (${Prisma.join(organizationIds)}) AND r."status" = 'APPLIED'
    ORDER BY r."organizationId", r."reservedAt" DESC, r."id" DESC
    LIMIT ${organizationIds.length}::int`
}

/** The devices of each organization's real venues, not retired: terminals (TPV) and POS. Printers and KDS do not count. */
export function aparatosSql(organizationIds: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT v."organizationId",
      COUNT(*) FILTER (WHERE t."type" IN ('TPV_ANDROID', 'TPV_IOS'))::int AS "terminales",
      COUNT(*) FILTER (WHERE t."type" IN ('POS_ANDROID', 'POS_IOS', 'POS_DESKTOP'))::int AS "pos"
    FROM "Terminal" t JOIN "Venue" v ON v."id" = t."venueId"
    WHERE v."organizationId" IN (${Prisma.join(organizationIds)}) AND ${REAL_VENUE_SQL} AND t."status" <> 'RETIRED'
    GROUP BY v."organizationId"`
}

/**
 * What the database knows of each signup: when it created its business (its oldest real venue), the last time it moved
 * (`OnboardingProgress.updatedAt`), the offer it came with, where it came from and how far it got with the card. Why the
 * bank declined is NOT stored (`planActivation.service.ts` returns it to the browser only): it is never made up here.
 * Only an organization that is a 🟠 (`altaPendienteSql`, the rule that paints the row): one that pays or charges with an
 * unfinished `OnboardingProgress` (made by hand, old) never reads «No intentó poner tarjeta».
 */
export function altaSql(organizationIds: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT op."organizationId", op."updatedAt" AS "ultimaVezAt", lc."name" AS "campana",
      op."v2SetupData" #>> '{hybrid,hybridOfferSlug}' AS "ofertaSlug", op."acquisitionSource",
      op."planActivationStatus"::text AS "planActivationStatus", op."planActivationAttempt",
      (SELECT MIN(v."createdAt") FROM "Venue" v WHERE v."organizationId" = op."organizationId" AND ${REAL_VENUE_SQL}) AS "negocioCreadoAt"
    FROM "OnboardingProgress" op LEFT JOIN "LaunchCampaign" lc ON lc."id" = op."launchCampaignId"
      JOIN "Organization" o ON o."id" = op."organizationId"
    WHERE op."organizationId" IN (${Prisma.join(organizationIds)}) AND ${altaPendienteSql()}`
}

/**
 * The newest note of each account, one index probe per account on `CrmTimelineEvent(accountId, createdAt)`; the text
 * travels cut at one more than it is shown, so the server knows whether to add «…».
 */
export function comentariosSql(accountIds: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT a."id" AS "accountId", e."actorStaffId", e."createdAt", LEFT(e."data"->>'text', ${LARGO_DEL_COMENTARIO + 1}::int) AS "texto"
    FROM unnest(ARRAY[${Prisma.join(accountIds)}]::text[]) AS a("id")
    CROSS JOIN LATERAL (
      SELECT ev."actorStaffId", ev."createdAt", ev."data" FROM "CrmTimelineEvent" ev
      WHERE ev."accountId" = a."id" AND ev."kind" = 'NOTE'
      ORDER BY ev."createdAt" DESC, ev."id" DESC
      LIMIT 1
    ) e`
}
