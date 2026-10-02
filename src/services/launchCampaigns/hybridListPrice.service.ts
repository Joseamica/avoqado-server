import { Prisma } from '@prisma/client'
import { FEATURE_CATALOG, type FeatureCatalogEntry } from '@/config/featureCatalog'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { FREE_TIER_CODES } from '@/services/access/basePlan.service'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { audit, changed } from './hybridCampaign.service'
import { compileHybridPublication } from './hybridOffer.service'
import { hybridOfferDefinition } from './hybridOffer.schema'
import { assertPriceRuleForList } from './hybridPriceRule'
import { ensureHybridPublicationPrices } from './hybridPrices'
import { LOCK_WAIT, lockProducts, productKeySql, type ProductKey } from './hybridProduct'

export interface ListPriceRow {
  productKey: string
  featureCode: string | null
  planTier: 'PRO' | 'PREMIUM' | null
  name: string
  category: string
  minimumTier: string | null
  editable: boolean
  notEditableReason: 'FREE' | 'CONTACT' | 'SYSTEM' | 'PLAN_PHASE_2' | null
  campaignId: string | null
  revision: number | null
  status: 'ACTIVE' | 'PAUSED' | null
  price: number | null
  pendingPrice: number | null
  /** «% de descuento» groups on sale over this product (spec §6.1): after a list change they need «Recalcular». */
  activeGroups: { id: string; name: string; revision: number }[]
}
type ProductRow = Pick<ListPriceRow, 'productKey' | 'featureCode' | 'planTier' | 'name' | 'category' | 'minimumTier' | 'notEditableReason'>

function notEditableReason(entry: FeatureCatalogEntry): ListPriceRow['notEditableReason'] {
  if (entry.offering === 'CONTACT') return 'CONTACT'
  if (!entry.featureCode) return 'SYSTEM'
  if (entry.offering === 'INCLUDED' || (FREE_TIER_CODES as readonly string[]).includes(entry.featureCode)) return 'FREE'
  return null
}

/** Every product of the «Precios» screen: the 40 catalog entries, then both plans (their price is phase 2). */
const PRODUCTS: readonly ProductRow[] = [
  ...FEATURE_CATALOG.map(entry => ({
    productKey: `FEATURE:${entry.featureCode ?? entry.id}`,
    featureCode: entry.featureCode,
    planTier: null,
    name: entry.name,
    category: entry.category,
    minimumTier: entry.minimumTier,
    notEditableReason: notEditableReason(entry),
  })),
  ...(['PRO', 'PREMIUM'] as const).map(tier => ({
    productKey: `PLAN:${tier}`,
    featureCode: null,
    planTier: tier,
    name: tier === 'PRO' ? 'Pro' : 'Premium',
    category: 'plan',
    minimumTier: tier,
    notEditableReason: 'PLAN_PHASE_2' as const,
  })),
]

/** The 31 CONFIGURABLE functions with a code: the only products whose list price is edited here (spec §4.2). */
export const LISTABLE_FEATURE_CODES: string[] = PRODUCTS.filter(p => p.featureCode && !p.notEditableReason).map(p => p.featureCode!)

const priceOf = (definition: Prisma.JsonValue) => hybridOfferDefinition.parse(definition).terms.price

/**
 * The groups with an ACTIVE, still-in-force generated promotion over each product, in creation order: one bounded query for
 * the whole board, filtered by product in SQL (`productKeySql`, as the list-price rule does).
 * ponytail: LIMIT 1000 (≈ 31 functions × 32 groups on sale at once); page it per product if that ever gets close.
 */
async function activeGroupsByKey(keys: string[]): Promise<Map<string, ListPriceRow['activeGroups']>> {
  const rows = await prisma.$queryRaw<{ productKey: string; id: string; name: string; revision: number }[]>`
    SELECT DISTINCT ${productKeySql('p')} AS "productKey", g.id, g.name, g.revision, g."createdAt"
    FROM "HybridCampaign" c
    JOIN "HybridOfferPublication" p ON p.id = c."currentPublicationId"
    JOIN "HybridPromotionGroup" g ON g.id = c."promotionGroupId"
    WHERE c.purpose = 'PROMOTION' AND c.status = 'ACTIVE' AND c."endsAt" > ${utcTs(new Date())}
      AND ${productKeySql('p')} IN (${Prisma.join(keys)})
    ORDER BY g."createdAt", g.id
    LIMIT 1000`
  const byKey = new Map<string, ListPriceRow['activeGroups']>()
  for (const { productKey, id, name, revision } of rows) byKey.set(productKey, [...(byKey.get(productKey) ?? []), { id, name, revision }])
  return byKey
}

/** Rows for these products, reading only their lists, those lists' current/pending publications and the groups over them. */
async function rowsFor(products: readonly ProductRow[]): Promise<ListPriceRow[]> {
  const lists = await prisma.hybridCampaign.findMany({
    where: { purpose: 'LIST', listProductKey: { in: products.map(p => p.productKey) } },
    select: { id: true, listProductKey: true, revision: true, status: true, currentPublicationId: true, pendingPublicationId: true },
    take: 64,
  })
  const ids = lists.flatMap(list => [list.currentPublicationId, list.pendingPublicationId].filter((id): id is string => !!id))
  const publications = ids.length
    ? await prisma.hybridOfferPublication.findMany({ where: { id: { in: ids } }, select: { id: true, definition: true }, take: ids.length })
    : []
  const prices = new Map(publications.map(publication => [publication.id, priceOf(publication.definition)]))
  const priceAt = (id: string | null | undefined) => (id ? (prices.get(id) ?? null) : null)
  const byKey = new Map(lists.map(list => [list.listProductKey, list]))
  const groups = await activeGroupsByKey(products.map(p => p.productKey))
  return products.map(product => {
    const list = byKey.get(product.productKey)
    return {
      ...product,
      editable: product.notEditableReason === null,
      campaignId: list?.id ?? null,
      revision: list?.revision ?? null,
      status: list?.status === 'ACTIVE' || list?.status === 'PAUSED' ? list.status : null,
      price: priceAt(list?.currentPublicationId),
      pendingPrice: priceAt(list?.pendingPublicationId),
      activeGroups: groups.get(product.productKey) ?? [],
    }
  })
}

async function rowOf(productKey: string): Promise<ListPriceRow> {
  const product = PRODUCTS.find(p => p.productKey === productKey)
  if (!product) throw new NotFoundError('Producto no encontrado.', 'HYBRID_LIST_NOT_FOUND')
  return (await rowsFor([product]))[0]
}

export async function listPriceBoard(): Promise<ListPriceRow[]> {
  return rowsFor(PRODUCTS)
}

/**
 * Step 4 of spec §4.2: the pointer moves only if the list is still at the revision that created this pending publication.
 * A newer save bumped it, so a late finalize of an older price fails and the pointer never goes back. Only the first price
 * activates the list: one someone paused stays paused.
 */
async function finalizeListPublication(key: ProductKey, listId: string, publicationId: string, expectedRevision: number, staffId: string) {
  await prisma.$transaction(async tx => {
    await lockProducts(tx, [key])
    const list = await tx.hybridCampaign.findUniqueOrThrow({ where: { id: listId } })
    const moved = await tx.hybridCampaign.updateMany({
      where: { id: listId, purpose: 'LIST', revision: expectedRevision, pendingPublicationId: publicationId },
      data: {
        currentPublicationId: publicationId,
        pendingPublicationId: null,
        revision: { increment: 1 },
        ...(list.currentPublicationId === null && list.status === 'DRAFT' ? { status: 'ACTIVE' as const } : {}),
      },
    })
    if (moved.count !== 1) {
      // A double-clicked retry: the other one already put this very price on sale.
      if (list.currentPublicationId === publicationId) return
      throw new ConflictError('Hay un cambio de precio más reciente.', 'HYBRID_LIST_SUPERSEDED')
    }
    // Promotions activated since the save were checked against the old price: the new one must hold for them too.
    const after = priceOf((await tx.hybridOfferPublication.findUniqueOrThrow({ where: { id: publicationId } })).definition)
    await assertPriceRuleForList(tx, key, after)
    const before = list.currentPublicationId
      ? priceOf((await tx.hybridOfferPublication.findUniqueOrThrow({ where: { id: list.currentPublicationId } })).definition)
      : null
    await audit(tx, listId, staffId, 'HYBRID_LIST_PRICE_SAVED', { productKey: key, before, after, publicationId })
  }, LOCK_WAIT)
}

/** Steps 3–4: prepare Stripe outside any transaction; on failure the old price keeps selling and the new one stays pending. */
async function prepareAndFinalize(key: ProductKey, listId: string, publicationId: string, revision: number, staffId: string) {
  try {
    await ensureHybridPublicationPrices(publicationId)
  } catch (error) {
    logger.warn('List price preparation failed', {
      productKey: key,
      publicationId,
      error: error instanceof Error ? error.message : String(error),
    })
    // The row is a convenience for the screen: failing to read it must not replace the Stripe error the caller acts on.
    let row: ListPriceRow | undefined
    try {
      row = await rowOf(key)
    } catch {
      row = undefined
    }
    throw new ConflictError(
      'No pudimos preparar el precio en Stripe. El precio anterior se sigue vendiendo; reintenta.',
      'HYBRID_LIST_PREPARING',
      row,
    )
  }
  await finalizeListPublication(key, listId, publicationId, revision, staffId)
  return rowOf(key)
}

/** Steps 1–2 of spec §4.2 under the product lock: create the LIST if missing, then a publication marked pending. */
async function saveList(product: ProductRow, definition: unknown, expectedRevision: number | null, staffId: string) {
  const key = product.productKey as ProductKey
  const compiled = compileHybridPublication(definition)
  const pending = await prisma.$transaction(async tx => {
    await lockProducts(tx, [key])
    const found = await tx.hybridCampaign.findFirst({ where: { purpose: 'LIST', listProductKey: key } })
    if ((found?.revision ?? null) !== expectedRevision) changed()
    await assertPriceRuleForList(tx, key, compiled.definition.terms.price)
    const tail = product.featureCode ?? `PLAN_${product.planTier}`
    const list =
      found ??
      (await tx.hybridCampaign.create({
        data: {
          purpose: 'LIST',
          listProductKey: key,
          code: `L_${tail}`.slice(0, 32),
          slug: `lista-${tail.toLowerCase().replace(/_/g, '-')}`,
          // The publication (and so the Stripe Product, whose name is permanent) takes this name: a plan list is never
          // named like the classic plan products «Pro» / «Premium».
          name: product.planTier ? `Lista ${product.name}` : product.name,
          startsAt: new Date(),
          endsAt: null,
          capacity: null,
          audience: 'ALL',
          listed: true,
          status: 'DRAFT',
          draftDefinition: compiled.definition as Prisma.InputJsonValue,
          createdById: staffId,
        },
      }))
    // version = revision: every publication bumps the revision in this same transaction, so (campaignId, version) stays unique.
    const publication = await tx.hybridOfferPublication.create({
      data: {
        ...compiled,
        definition: compiled.definition as Prisma.InputJsonValue,
        campaignId: list.id,
        version: list.revision,
        name: list.name,
        createdById: staffId,
      },
    })
    const claimed = await tx.hybridCampaign.updateMany({
      where: { id: list.id, revision: list.revision },
      data: {
        pendingPublicationId: publication.id,
        revision: { increment: 1 },
        draftDefinition: compiled.definition as Prisma.InputJsonValue,
      },
    })
    if (claimed.count !== 1) changed()
    return { listId: list.id, publicationId: publication.id, revision: list.revision + 1 }
  }, LOCK_WAIT)
  return prepareAndFinalize(key, pending.listId, pending.publicationId, pending.revision, staffId)
}

/** Saving a list price never needs HYBRID_BILLING_ENABLED: that flag closes quoting and accepting, not the catalog. */
export async function saveListPrice(
  input: { productKey: string; price: number; expectedRevision: number | null },
  staffId: string,
): Promise<ListPriceRow> {
  const product = PRODUCTS.find(p => p.productKey === input.productKey)
  if (!product?.featureCode || product.notEditableReason)
    throw new BadRequestError('Este producto no admite precio de lista en esta pantalla.', 'HYBRID_LIST_NOT_EDITABLE')
  const parsed = hybridOfferDefinition.safeParse({
    schemaVersion: 1,
    kind: 'FEATURES',
    featureCodes: [product.featureCode],
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: input.price,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    },
  })
  if (!parsed.success) throw new BadRequestError(parsed.error.issues.map(issue => issue.message).join('. '), 'HYBRID_LIST_INVALID')
  return saveList(product, parsed.data, input.expectedRevision, staffId)
}

/** Finishes a pending price (preparation failed earlier); with nothing pending it returns the row unchanged. */
export async function retryListPrice(productKey: string, staffId: string): Promise<ListPriceRow> {
  const list = await prisma.hybridCampaign.findFirst({
    where: { purpose: 'LIST', listProductKey: productKey },
    select: { id: true, revision: true, pendingPublicationId: true },
  })
  if (!list?.pendingPublicationId) return rowOf(productKey)
  return prepareAndFinalize(productKey as ProductKey, list.id, list.pendingPublicationId, list.revision, staffId)
}

export type PlanSeedOutcome = 'CREATE' | 'EXISTS' | 'DIFFERENT_PRICE' | 'PENDING'

/** What seeding a plan list at `price` does to its row. A plan list that already has a price is never changed here. */
export function planSeedOutcome(row: Pick<ListPriceRow, 'price' | 'pendingPrice'>, price: number): PlanSeedOutcome {
  if (row.price !== null) return row.price === price ? 'EXISTS' : 'DIFFERENT_PRICE'
  return row.pendingPrice !== null ? 'PENDING' : 'CREATE'
}

/**
 * Spec §4.2 «listas de los planes»: the LIST of a plan at the classic monthly price, through the same flow as
 * `saveListPrice` (product lock first, then a pending publication, Stripe, finalize) with a PLAN definition. Internal to
 * the seed script, never exposed over HTTP. Idempotent: a priced plan list is reported, never changed (phase 2 decides
 * plan prices); a price left pending by a failed Stripe preparation is finished.
 */
export async function seedPlanList(
  tier: 'PRO' | 'PREMIUM',
  price: number,
  staffId: string,
): Promise<{ outcome: PlanSeedOutcome; row: ListPriceRow }> {
  const product = PRODUCTS.find(p => p.planTier === tier)!
  const before = await rowOf(product.productKey)
  const outcome = planSeedOutcome(before, price)
  if (outcome === 'EXISTS' || outcome === 'DIFFERENT_PRICE') return { outcome, row: before }
  if (outcome === 'PENDING') return { outcome, row: await retryListPrice(product.productKey, staffId) }
  const definition = {
    schemaVersion: 1,
    kind: 'PLAN',
    planTier: tier,
    terms: { currency: 'MXN', interval: 'MONTHLY', price, taxIncluded: true, promotionCycles: null, renewal: { kind: 'SAME_PRICE' } },
  }
  return { outcome, row: await saveList(product, definition, before.revision, staffId) }
}

/** ACTIVE ↔ PAUSED. Pausing takes the function off loose sale; contracts already accepted keep their price. */
export async function setListPriceStatus(
  input: { productKey: string; status: 'ACTIVE' | 'PAUSED'; expectedRevision: number },
  staffId: string,
): Promise<ListPriceRow> {
  if (input.status !== 'ACTIVE' && input.status !== 'PAUSED') throw new BadRequestError('Estado no válido.', 'HYBRID_LIST_INVALID')
  // A plan list is read-only in phase 1: pausing it would take the self-service upgrade off sale.
  if (PRODUCTS.find(p => p.productKey === input.productKey)?.notEditableReason)
    throw new BadRequestError('Este producto no admite precio de lista en esta pantalla.', 'HYBRID_LIST_NOT_EDITABLE')
  const key = input.productKey as ProductKey
  await prisma.$transaction(async tx => {
    await lockProducts(tx, [key])
    const list = await tx.hybridCampaign.findFirst({ where: { purpose: 'LIST', listProductKey: key } })
    if (!list) throw new NotFoundError('Este producto no tiene precio de lista.', 'HYBRID_LIST_NOT_FOUND')
    if (list.revision !== input.expectedRevision) changed()
    if (list.status === input.status) return
    if (input.status === 'ACTIVE') {
      if (!list.currentPublicationId) throw new ConflictError('Guarda un precio antes de ponerlo en venta.', 'HYBRID_LIST_PRICE_REQUIRED')
      const current = await tx.hybridOfferPublication.findUniqueOrThrow({ where: { id: list.currentPublicationId } })
      await assertPriceRuleForList(tx, key, priceOf(current.definition))
    }
    const updated = await tx.hybridCampaign.updateMany({
      where: { id: list.id, purpose: 'LIST', revision: list.revision },
      data: { status: input.status, revision: { increment: 1 } },
    })
    if (updated.count !== 1) changed()
    await audit(tx, list.id, staffId, 'HYBRID_LIST_STATUS_CHANGED', { productKey: key, previous: list.status, status: input.status })
  }, LOCK_WAIT)
  return rowOf(key)
}
