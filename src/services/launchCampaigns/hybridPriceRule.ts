import type { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { ConflictError } from '@/errors/AppError'
import { hybridOfferDefinition, type HybridOfferDefinition } from './hybridOffer.schema'
import { productKeyOf, productKeySql, type ProductKey } from './hybridProduct'

/** An ACTIVE promotion a list price would break, with what superadmin needs to pause it by conditional write. */
export interface RuleViolation {
  campaignId: string
  campaignName: string
  price: number
  renewalPrice: number | null
  listPrice: number
  revision: number
  promotionGroupId: string | null
  groupRevision: number | null
}

/** Pure: the only inequality of spec §4.4 — initial price strictly below the list, a known renewal at most the list. */
export function violatesListRule(terms: { price: number; renewal: { kind: string; price?: number } }, listPrice: number): boolean {
  return new Decimal(terms.price).gte(listPrice) || (terms.renewal.kind === 'REPRICE' && new Decimal(terms.renewal.price!).gt(listPrice))
}

/** List price of a product: its LIST's current publication, ACTIVE or PAUSED (pausing never lifts the rule); null without a LIST. */
export async function listPriceOf(tx: Prisma.TransactionClient, key: ProductKey): Promise<number | null> {
  const list = await tx.hybridCampaign.findFirst({
    where: { purpose: 'LIST', listProductKey: key },
    select: { currentPublicationId: true },
  })
  if (!list?.currentPublicationId) return null
  const publication = await tx.hybridOfferPublication.findUniqueOrThrow({
    where: { id: list.currentPublicationId },
    select: { definition: true },
  })
  return hybridOfferDefinition.parse(publication.definition).terms.price
}

/** Promotion side: throws HYBRID_PRICE_ABOVE_LIST if this single-product promotion breaks the rule. Caller holds the product lock. */
export async function assertPromotionBelowList(tx: Prisma.TransactionClient, definition: HybridOfferDefinition): Promise<void> {
  const key = productKeyOf(definition)
  if (!key) return
  const list = await listPriceOf(tx, key)
  if (list === null) return
  if (violatesListRule(definition.terms, list))
    throw new ConflictError(
      `Una promoción debe costar menos que su precio de lista (${list}) y renovar a lo más a ese precio.`,
      'HYBRID_PRICE_ABOVE_LIST',
    )
}

/** List side: the ACTIVE single-product promotions a list price would break (for the save dialog). Caller holds the product lock. */
export async function promotionsBrokenByList(tx: Prisma.TransactionClient, key: ProductKey, listPrice: number): Promise<RuleViolation[]> {
  // Filtered by product in SQL, so the set is one product's active promotions, never a global page (index purpose+status).
  const rows = await tx.$queryRaw<
    { id: string; name: string; revision: number; promotionGroupId: string | null; groupRevision: number | null; definition: unknown }[]
  >`
    SELECT c.id, c.name, c.revision, c."promotionGroupId", g.revision AS "groupRevision", p.definition
    FROM "HybridCampaign" c
    JOIN "HybridOfferPublication" p ON p.id = c."currentPublicationId"
    LEFT JOIN "HybridPromotionGroup" g ON g.id = c."promotionGroupId"
    WHERE c.purpose = 'PROMOTION' AND c.status = 'ACTIVE' AND ${productKeySql('p')} = ${key}
    ORDER BY c."createdAt", c.id`
  return rows.flatMap(row => {
    const { terms } = hybridOfferDefinition.parse(row.definition)
    if (!violatesListRule(terms, listPrice)) return []
    return [
      {
        campaignId: row.id,
        campaignName: row.name,
        price: terms.price,
        renewalPrice: terms.renewal.kind === 'REPRICE' ? terms.renewal.price : null,
        listPrice,
        revision: row.revision,
        promotionGroupId: row.promotionGroupId,
        groupRevision: row.groupRevision,
      },
    ]
  })
}

/** List side guard: throws HYBRID_LIST_BREAKS_PROMOTIONS with details = RuleViolation[] when the list would break active promotions. */
export async function assertPriceRuleForList(tx: Prisma.TransactionClient, key: ProductKey, listPrice: number): Promise<void> {
  const broken = await promotionsBrokenByList(tx, key, listPrice)
  if (broken.length)
    throw new ConflictError(
      'Hay promociones activas que costarían lo mismo o más que este precio de lista. Páusalas antes de guardarlo.',
      'HYBRID_LIST_BREAKS_PROMOTIONS',
      broken,
    )
}
