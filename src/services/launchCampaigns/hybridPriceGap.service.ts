import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { PRODUCT_KEYS } from './hybridBestOffer'
import { productKeySql } from './hybridProduct'

export type GapReason = 'OLD_LIST' | 'PROMO_FOREVER' | 'PROMO_TEMPORARY' | 'RENEWED_OLD_LIST' | 'PROMO_ENDING'
export interface PriceGapSummaryRow {
  productKey: string
  venues: number
  /** Pesos, 2 decimals: a difference of RATES (list − rate), not cash collected (spec §6.3). */
  monthlyGap: string
  aboveListVenues: number
  bundleVenues: number
}
export interface PriceGapVenueRow {
  /** Rows are per contract (a venue may hold two): the stable key of a row. */
  contractId: string
  venueId: string
  venueName: string
  organizationName: string
  rate: string
  listPrice: string
  gap: string
  since: string
  reason: GapReason
  reasonUntil: string | null
}

const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 50
// A bound for OFFSET: a non-finite or absurd page reads an empty page instead of failing the query.
const MAX_PAGE = 10_000
const money = (value: Prisma.Decimal) => value.toFixed(2)

/**
 * SQL twin of the delivery's paid criterion over a HybridPaymentPeriod alias: NOT `hybridPeriodInvalid`
 * (`hybridDelivery.service.ts`) — no open dispute, not fully refunded, funded for at least the sum of its lines. The
 * integration test `hybrid-price-gap` checks both agree row by row.
 */
export function periodFundedSql(alias: string): Prisma.Sql {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`Invalid SQL alias: ${alias}`)
  const pp = Prisma.raw(alias)
  return Prisma.sql`(NOT ${pp}.disputed AND ${pp}."refundedAmount" < ${pp}."fundedAmount"
    AND ${pp}."fundedAmount" >= (SELECT COALESCE(SUM((e->>'amount')::numeric), 0) FROM jsonb_array_elements(${pp}.composition) e))`
}

/**
 * The CTEs both reads share (spec §6.3):
 * - `lists`: today's list price per product — the LIST's current publication, ACTIVE or PAUSED, like `listPriceOf`;
 * - `lines`: one row per counted contract — not ended, with a live unrevoked grant, and its line (matched by contract AND
 *   Price) in a funded period of its subscription that covers `now`; the rate is that line's amount;
 * - `singles`: the lines of single-product offers (`productKeySql` not null) whose product has a list.
 * Columns hold UTC: `now` is bound with `utcTs`, never NOW() (the local session zone is America/Mexico_City).
 */
function countedSql(now: Date): Prisma.Sql {
  return Prisma.sql`
    lists AS (
      SELECT l."listProductKey" AS "productKey", (lp.definition->'terms'->>'price')::numeric AS "listPrice"
      FROM "HybridCampaign" l
      JOIN "HybridOfferPublication" lp ON lp.id = l."currentPublicationId"
      WHERE l.purpose = 'LIST' AND l."listProductKey" = ANY(${PRODUCT_KEYS}::text[])),
    lines AS (
      SELECT DISTINCT ON (k.id) k.id AS "contractId", k."venueId", k."startsAt", c.purpose, p.definition,
        p."stripePriceId", p."stripeRenewalPriceId", line->>'priceId' AS "priceId", (line->>'amount')::numeric AS rate,
        line->'featureCodes' AS "featureCodes"
      FROM "HybridContract" k
      JOIN "HybridOfferPublication" p ON p.id = k."publicationId"
      JOIN "HybridCampaign" c ON c.id = p."campaignId"
      JOIN "HybridPaymentPeriod" pp ON pp."venueId" = k."venueId" AND pp."stripeSubscriptionId" = k."stripeSubscriptionId"
      CROSS JOIN LATERAL jsonb_array_elements(pp.composition) line
      WHERE k."endedAt" IS NULL
        AND EXISTS (
          SELECT 1 FROM "CapabilityGrant" g
          WHERE g."contractId" = k.id AND g."revokedAt" IS NULL AND g."startsAt" <= ${utcTs(now)} AND g."endsAt" > ${utcTs(now)})
        AND pp."startsAt" <= ${utcTs(now)} AND pp."endsAt" > ${utcTs(now)} AND ${periodFundedSql('pp')}
        AND line->>'contractId' = k.id AND line->>'priceId' IN (p."stripePriceId", p."stripeRenewalPriceId")
      ORDER BY k.id, pp."startsAt" DESC, pp.id DESC),
    singles AS (
      SELECT x.*, lst."productKey", lst."listPrice"
      FROM lines x JOIN lists lst ON lst."productKey" = ${productKeySql('x')})`
}

/**
 * One row per product with a LIST (spec §6.3): venues paying LESS than today's list (counted once per venue), the
 * monthly difference of rates (sum over those contracts), venues paying MORE (own line, outside the sum), and venues
 * holding the function inside a bundle or choice (own line, outside the sum). Exact aggregate, one bounded query.
 */
export async function priceGapSummary(): Promise<PriceGapSummaryRow[]> {
  const rows = await prisma.$queryRaw<
    { productKey: string; venues: bigint; monthlyGap: Prisma.Decimal; aboveListVenues: bigint; bundleVenues: bigint }[]
  >`
    WITH ${countedSql(new Date())},
    bundles AS (
      SELECT x."venueId", 'FEATURE:' || code AS "productKey"
      FROM lines x CROSS JOIN LATERAL jsonb_array_elements_text(x."featureCodes") code
      WHERE ${productKeySql('x')} IS NULL)
    SELECT l."productKey",
      COUNT(DISTINCT s."venueId") FILTER (WHERE s.rate < s."listPrice") AS venues,
      COALESCE(SUM(s."listPrice" - s.rate) FILTER (WHERE s.rate < s."listPrice"), 0) AS "monthlyGap",
      COUNT(DISTINCT s."venueId") FILTER (WHERE s.rate > s."listPrice") AS "aboveListVenues",
      COALESCE(MAX(b.venues), 0) AS "bundleVenues"
    FROM lists l
    LEFT JOIN singles s ON s."productKey" = l."productKey"
    LEFT JOIN (SELECT "productKey", COUNT(DISTINCT "venueId") AS venues FROM bundles GROUP BY "productKey") b
      ON b."productKey" = l."productKey"
    GROUP BY l."productKey"
    ORDER BY l."productKey"`
  return rows.map(row => ({
    productKey: row.productKey,
    venues: Number(row.venues),
    monthlyGap: money(row.monthlyGap),
    aboveListVenues: Number(row.aboveListVenues),
    bundleVenues: Number(row.bundleVenues),
  }))
}

/**
 * «Ver quiénes»: one row per contract paying less than the list of `productKey`, biggest gap first (contract id breaks
 * ties), paginated with the exact total. The REPRICE phase is decided by the line's Price, never its amount.
 */
export async function priceGapVenues(
  productKey: string,
  page: number,
  pageSize: number,
): Promise<{ items: PriceGapVenueRow[]; total: number }> {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(pageSize) || DEFAULT_PAGE_SIZE))
  const offset = (Math.min(MAX_PAGE, Math.max(1, Math.trunc(page) || 1)) - 1) * size
  const rows = await prisma.$queryRaw<
    {
      total: bigint
      contractId: string | null
      venueId: string | null
      venueName: string
      organizationName: string
      rate: Prisma.Decimal
      listPrice: Prisma.Decimal
      gap: Prisma.Decimal
      since: Date
      reason: GapReason
      reasonUntil: Date | null
    }[]
  >`
    WITH ${countedSql(new Date())},
    gaps AS (
      SELECT s.*, s."listPrice" - s.rate AS gap,
        CASE
          WHEN s.purpose = 'LIST' THEN 'OLD_LIST'
          WHEN s.definition->'terms'->'renewal'->>'kind' = 'SAME_PRICE' THEN 'PROMO_FOREVER'
          WHEN s.definition->'terms'->'renewal'->>'kind' = 'END' THEN 'PROMO_ENDING'
          WHEN s."priceId" = s."stripeRenewalPriceId" THEN 'RENEWED_OLD_LIST'
          WHEN s."priceId" = s."stripePriceId" THEN 'PROMO_TEMPORARY'
        END AS reason
      FROM singles s
      WHERE s."productKey" = ${productKey} AND s.rate < s."listPrice")
    SELECT t.total, g."contractId", g."venueId", v.name AS "venueName", o.name AS "organizationName", g.rate,
      g."listPrice", g.gap, g."startsAt" AS since, g.reason,
      CASE WHEN g.reason IN ('PROMO_TEMPORARY', 'PROMO_ENDING')
        THEN g."startsAt" + make_interval(months => (g.definition->'terms'->>'promotionCycles')::int) END AS "reasonUntil"
    FROM (SELECT COUNT(*) AS total FROM gaps) t
    LEFT JOIN LATERAL (SELECT * FROM gaps ORDER BY gap DESC, "contractId" LIMIT ${size} OFFSET ${offset}) g ON TRUE
    LEFT JOIN "Venue" v ON v.id = g."venueId"
    LEFT JOIN "Organization" o ON o.id = v."organizationId"
    ORDER BY g.gap DESC, g."contractId"`
  return {
    total: Number(rows[0]?.total ?? 0),
    items: rows.flatMap(row =>
      row.venueId === null || row.contractId === null
        ? []
        : [
            {
              contractId: row.contractId,
              venueId: row.venueId,
              venueName: row.venueName,
              organizationName: row.organizationName,
              rate: money(row.rate),
              listPrice: money(row.listPrice),
              gap: money(row.gap),
              since: row.since.toISOString(),
              reason: row.reason,
              reasonUntil: row.reasonUntil?.toISOString() ?? null,
            },
          ],
    ),
  }
}
