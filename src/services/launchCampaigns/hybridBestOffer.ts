import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { FEATURE_CATALOG } from '@/config/featureCatalog'
import { utcTs } from '@/utils/sqlDates'
import { hybridOfferDefinition, type HybridOfferDefinition } from './hybridOffer.schema'
import { productKeySql, type ProductKey } from './hybridProduct'
import type { FeatureGridOffer } from './hybridFeatureGrid.service'

export interface BestOffers {
  /** Cheapest offer this organization can buy now per product, PROMOTION or LIST. */
  best: Map<ProductKey, FeatureGridOffer>
  /** The product's LIST offer, only while ACTIVE and purchasable. */
  list: Map<ProductKey, FeatureGridOffer>
}

/** Every product the grid can show: the bound of both queries (one row per product at most). */
const PRODUCT_KEYS: ProductKey[] = [
  ...FEATURE_CATALOG.flatMap(entry => (entry.featureCode ? [`FEATURE:${entry.featureCode}` as const] : [])),
  'PLAN:PRO',
  'PLAN:PREMIUM',
]

/**
 * FROM + WHERE of the offers this organization can buy now: the SQL twin of `hybridOfferBlocker` plus the rest of the purchase
 * path (`observeHybridQuote`): a promotion is used once per organization, and a generated promotion sells only while the LIST of
 * its product is ACTIVE. The integration test `hybrid-best-offer` checks it row by row against the TypeScript rules.
 * Columns hold UTC: every instant is bound with `utcTs`, never NOW() (the local session zone is America/Mexico_City).
 */
export function eligibleOffersSql(organization: { id: string; createdAt: Date }, now: Date): Prisma.Sql {
  const key = productKeySql('p')
  return Prisma.sql`
    FROM "HybridCampaign" c
    JOIN "HybridOfferPublication" p ON p.id = c."currentPublicationId"
    WHERE c.status = 'ACTIVE' AND c.listed AND c."startsAt" <= ${utcTs(now)}
      AND ${key} = ANY(${PRODUCT_KEYS}::text[])
      AND (c.purpose = 'LIST' OR (c."endsAt" > ${utcTs(now)} AND c."reservedCount" + c."redeemedCount" < c.capacity))
      AND CASE c.audience
        WHEN 'ORGANIZATIONS' THEN ${organization.id} = ANY(c."eligibleOrganizationIds")
        WHEN 'NEW_ORGANIZATIONS' THEN c."startsAt" <= ${utcTs(organization.createdAt)}
        ELSE TRUE END
      AND p."stripePriceId" <> '' AND p."stripeProductId" <> ''
      AND (p.definition->'terms'->'renewal'->>'kind' IS DISTINCT FROM 'REPRICE' OR p."stripeRenewalPriceId" <> '')
      AND (c.purpose = 'LIST' OR NOT EXISTS (
        SELECT 1 FROM "HybridRedemption" r
        WHERE r."campaignId" = c.id AND r."organizationId" = ${organization.id} AND r.status <> 'RELEASED'))
      AND (c."promotionGroupId" IS NULL OR EXISTS (
        SELECT 1 FROM "HybridCampaign" l WHERE l.purpose = 'LIST' AND l.status = 'ACTIVE' AND l."listProductKey" = ${key}))`
}

interface OfferRow {
  campaignId: string
  publicationId: string
  name: string
  definition: unknown
  includedFeatureCodes: string[]
  productKey: ProductKey
}

function offerView(row: OfferRow, definition: HybridOfferDefinition, listPrice: number | null): FeatureGridOffer {
  return {
    publicationId: row.publicationId,
    campaignId: row.campaignId,
    name: row.name,
    kind: definition.kind === 'PLAN' ? 'PLAN' : 'FEATURES',
    planTier: definition.kind === 'PLAN' ? definition.planTier : null,
    price: definition.terms.price,
    listPrice,
    renewal: definition.terms.renewal.kind,
    renewalPrice: definition.terms.renewal.kind === 'REPRICE' ? definition.terms.renewal.price : null,
    promotionCycles: definition.terms.promotionCycles,
    includedFeatureCodes: row.includedFeatureCodes,
  }
}

function views(rows: OfferRow[], listPriceOf: (key: ProductKey, price: number) => number | null) {
  const byProduct = new Map<ProductKey, FeatureGridOffer>()
  for (const row of rows) {
    const parsed = hybridOfferDefinition.safeParse(row.definition)
    if (!parsed.success) {
      logger.warn('best-offer: stored offer definition is invalid; offer skipped', {
        campaignId: row.campaignId,
        publicationId: row.publicationId,
      })
      continue
    }
    byProduct.set(row.productKey, offerView(row, parsed.data, listPriceOf(row.productKey, parsed.data.terms.price)))
  }
  return byProduct
}

/**
 * Spec §4.4 «selección exacta»: per product, the cheapest offer this organization can buy now, over ALL eligible campaigns.
 * Ties: price, then the LIST, then the newest campaign, then id (deterministic). Each query returns at most one row per
 * product (PRODUCT_KEYS bounds it; one LIST per product is a unique index). `listPrice` is the ACTIVE list's price.
 */
export async function bestOffersByProduct(organization: { id: string; createdAt: Date }, now: Date): Promise<BestOffers> {
  const eligible = eligibleOffersSql(organization, now)
  const columns = Prisma.sql`c.id AS "campaignId", p.id AS "publicationId", p.name, p.definition, p."includedFeatureCodes",
    ${productKeySql('p')} AS "productKey"`
  const [bestRows, listRows] = await Promise.all([
    prisma.$queryRaw<OfferRow[]>`
      SELECT DISTINCT ON ("productKey") ${columns} ${eligible}
      ORDER BY "productKey", (p.definition->'terms'->>'price')::numeric, (c.purpose = 'LIST') DESC, c."createdAt" DESC, c.id DESC`,
    prisma.$queryRaw<OfferRow[]>`SELECT ${columns} ${eligible} AND c.purpose = 'LIST'`,
  ])
  const list = views(listRows, (_key, price) => price)
  return { best: views(bestRows, key => list.get(key)?.price ?? null), list }
}
