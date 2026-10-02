import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { z } from 'zod'
import { FEATURE_CATALOG } from '@/config/featureCatalog'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { changed, notifyCampaign, publishWithin, setCampaignStatusWithin } from './hybridCampaign.service'
import { HYBRID_DEPENDENCIES } from './hybridDependencies'
import { LISTABLE_FEATURE_CODES } from './hybridListPrice.service'
import { compileHybridPublication } from './hybridOffer.service'
import { hybridOfferDefinition, MINIMUM_PRICE } from './hybridOffer.schema'
import { assertPromotionBelowList, listPriceOf } from './hybridPriceRule'
import { ensureHybridPublicationPrices } from './hybridPrices'
import { LOCK_WAIT, lockProducts, productKeyOf, type ProductKey } from './hybridProduct'
import { assertHybridSalesOpen } from './hybridPurchase.service'

const errorMap: z.ZodErrorMap = () => ({ message: 'Valor requerido o formato no válido' })
// A group holds at most one campaign per listable function (31 today); the cap only guards the read.
const MAX_MEMBERS = 100

const CATEGORIES = new Set<string>(FEATURE_CATALOG.map(entry => entry.category))
const catalogByCode = new Map(FEATURE_CATALOG.filter(entry => entry.featureCode).map(entry => [entry.featureCode!, entry]))
const datetime = z.string({ errorMap }).datetime({ offset: true, message: 'Indica fecha, hora y zona' })
const percentTarget = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('ALL_FEATURES', { errorMap }) }, { errorMap }).strict('Campo de objetivo no admitido'),
    z
      .object(
        {
          kind: z.literal('CATEGORIES', { errorMap }),
          categories: z
            .array(
              z.string({ errorMap }).refine(category => CATEGORIES.has(category), 'Categoría no válida'),
              { errorMap },
            )
            .min(1, 'Selecciona al menos una categoría')
            .max(20, 'Se permiten hasta 20 categorías'),
        },
        { errorMap },
      )
      .strict('Campo de objetivo no admitido'),
    z
      .object(
        {
          kind: z.literal('FEATURES', { errorMap }),
          featureCodes: z
            .array(
              z
                .string({ errorMap })
                .trim()
                .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'Código de función no válido'),
              { errorMap },
            )
            .min(1, 'Selecciona al menos una función')
            .max(100, 'Se permiten hasta 100 funciones'),
        },
        { errorMap },
      )
      .strict('Campo de objetivo no admitido'),
  ],
  { errorMap },
)

export const percentPromotionBody = z
  .object(
    {
      name: z.string({ errorMap }).trim().min(3, 'Mínimo 3 caracteres').max(120, 'Máximo 120 caracteres'),
      percentOff: z.number({ errorMap }).int('El porcentaje debe ser entero').min(1, 'Mínimo 1 %').max(90, 'Máximo 90 %'),
      target: percentTarget,
      startsAt: datetime,
      endsAt: datetime,
      promotionCycles: z
        .number({ errorMap })
        .int('Los ciclos deben ser enteros')
        .min(1, 'Se requiere al menos un ciclo')
        .max(24, 'Máximo 24 ciclos')
        .nullable(),
      capacityPerFeature: z
        .number({ errorMap })
        .int('El cupo debe ser entero')
        .min(1, 'Mínimo un lugar')
        .max(100000, 'Máximo 100,000 lugares'),
    },
    { errorMap },
  )
  .strict('Campo no admitido')
type PercentPromotion = z.output<typeof percentPromotionBody>

const promotionGroupStatusBody = z
  .object(
    {
      status: z.enum(['ACTIVE', 'PAUSED', 'ENDED'], { errorMap }),
      expectedRevision: z.number({ errorMap }).int().positive(),
    },
    { errorMap },
  )
  .strict('Campo no admitido')

export const promotionGroupListQuery = z
  .object(
    {
      page: z.coerce.number({ errorMap }).int().min(1).max(10_000).default(1),
      pageSize: z.coerce.number({ errorMap }).int().min(1).max(100).default(25),
      status: z.enum(['ACTIVE', 'PAUSED', 'ENDED'], { errorMap }).optional(),
    },
    { errorMap },
  )
  .strict('Filtro no admitido')

export interface PercentPreviewRow {
  featureCode: string
  name: string
  listPrice: number | null
  price: number | null
  renewalPrice: number | null
  status: 'OK' | 'NO_LIST' | 'BELOW_MINIMUM'
  requires: string[]
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new BadRequestError(
      result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('. '),
      'HYBRID_PROMOTION_INVALID',
    )
  return result.data
}

/** Pure: the discounted price, in exact decimal and rounded half-up to the cent (Review Focus 3: 599 × 0.8 = 479.20). */
export function discounted(listPrice: number, percentOff: number): number {
  return new Decimal(listPrice)
    .mul(100 - percentOff)
    .div(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber()
}

/** Pure: the listable functions a target names, deduplicated and in productKey order (the order locks and ordinals use). */
export function targetFeatureCodes(target: PercentPromotion['target']): string[] {
  const codes =
    target.kind === 'ALL_FEATURES'
      ? LISTABLE_FEATURE_CODES
      : target.kind === 'CATEGORIES'
        ? FEATURE_CATALOG.filter(entry => target.categories.includes(entry.category)).flatMap(entry => entry.featureCode ?? [])
        : target.featureCodes
  return [...new Set(codes.filter(code => LISTABLE_FEATURE_CODES.includes(code)))].sort()
}

const keyOf = (featureCode: string): ProductKey => `FEATURE:${featureCode}`

/**
 * One row per function, priced from its list as read through `db` (inside the product locks when creating). Generating
 * reads only lists on sale (`onSaleOnly`: a paused one is NO_LIST, spec §4.3); recalculating reads the «lista vigente»,
 * ACTIVE or PAUSED (§4.4), which reactivating checks again.
 * ponytail: one listPriceOf per function (≤ 31, two indexed reads each); batch it if the catalog grows a lot.
 */
async function previewRows(
  db: Prisma.TransactionClient,
  codes: string[],
  terms: Pick<PercentPromotion, 'percentOff' | 'promotionCycles'>,
  onSaleOnly: boolean,
): Promise<PercentPreviewRow[]> {
  const rows: PercentPreviewRow[] = []
  for (const featureCode of codes) {
    const listPrice = await listPriceOf(db, keyOf(featureCode), onSaleOnly)
    const price = listPrice === null ? null : discounted(listPrice, terms.percentOff)
    rows.push({
      featureCode,
      name: catalogByCode.get(featureCode)?.name ?? featureCode,
      listPrice,
      price,
      renewalPrice: listPrice !== null && terms.promotionCycles !== null ? listPrice : null,
      status: price === null ? 'NO_LIST' : price < MINIMUM_PRICE ? 'BELOW_MINIMUM' : 'OK',
      requires: [...(HYBRID_DEPENDENCIES[featureCode] ?? [])],
    })
  }
  return rows
}

/** One function under $10 blocks the group, never rounded up (spec §4.3, audit P2-15). */
function assertAboveMinimum(rows: PercentPreviewRow[]) {
  const below = rows.filter(row => row.status === 'BELOW_MINIMUM')
  if (below.length)
    throw new BadRequestError(
      `Con este descuento quedarían por debajo de $10.00 MXN: ${below.map(row => row.name).join(', ')}. Quítalas o baja el porcentaje.`,
      'HYBRID_PROMOTION_BELOW_MINIMUM',
      below,
    )
}

/** Functions without a list on sale are omitted (the preview says so); one under $10 blocks the group. */
function creatableRows(rows: PercentPreviewRow[]): PercentPreviewRow[] {
  assertAboveMinimum(rows)
  const ok = rows.filter(row => row.status === 'OK')
  if (!ok.length) throw new BadRequestError('Ninguna de estas funciones tiene precio de lista.', 'HYBRID_PROMOTION_EMPTY')
  return ok
}

/** The promotion of one function: % off its list, renewing to that list after N cycles, or the same price forever. */
function promotionDefinition(featureCode: string, listPrice: number, terms: Pick<PercentPromotion, 'percentOff' | 'promotionCycles'>) {
  return compileHybridPublication({
    schemaVersion: 1,
    kind: 'FEATURES',
    featureCodes: [featureCode],
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: discounted(listPrice, terms.percentOff),
      taxIncluded: true,
      promotionCycles: terms.promotionCycles,
      renewal: terms.promotionCycles === null ? { kind: 'SAME_PRICE' } : { kind: 'REPRICE', price: listPrice },
    },
  }).definition as Prisma.InputJsonValue
}

async function auditGroup(tx: Prisma.TransactionClient, id: string, staffId: string, action: string, data: Prisma.InputJsonObject) {
  await tx.activityLog.create({ data: { staffId, action, entity: 'HybridPromotionGroup', entityId: id, data } })
}

export async function previewPercentPromotion(input: unknown): Promise<{ rows: PercentPreviewRow[]; creatable: boolean }> {
  const body = parse(percentPromotionBody, input)
  const rows = await prisma.$transaction(tx => previewRows(tx, targetFeatureCodes(body.target), body, true))
  return {
    rows,
    creatable: rows.some(row => row.status === 'OK') && rows.every(row => row.status !== 'BELOW_MINIMUM'),
  }
}

/** Spec §4.3: one transaction creates the group and one published PROMOTION per listed function, all PAUSED. */
export async function createPercentPromotion(input: unknown, staffId: string): Promise<{ groupId: string; campaignIds: string[] }> {
  const body = parse(percentPromotionBody, input)
  const startsAt = new Date(body.startsAt)
  const endsAt = new Date(body.endsAt)
  if (startsAt >= endsAt) throw new BadRequestError('La vigencia debe terminar después de empezar.', 'HYBRID_PROMOTION_INVALID')
  // The preview outside the lock only decides which functions take part; prices come from the lists read under it.
  const codes = creatableRows(await prisma.$transaction(tx => previewRows(tx, targetFeatureCodes(body.target), body, true))).map(
    row => row.featureCode,
  )
  const created = await prisma.$transaction(async tx => {
    await lockProducts(tx, codes.map(keyOf))
    const rows = await previewRows(tx, codes, body, true)
    assertAboveMinimum(rows)
    // Never a smaller group than the preview promised: a function whose list stopped selling meanwhile fails it all.
    if (rows.some(row => row.status !== 'OK'))
      throw new ConflictError('El precio de lista de una función cambió; vuelve a la vista previa.', 'HYBRID_PROMOTION_CHANGED')
    const group = await tx.hybridPromotionGroup.create({
      data: {
        name: body.name,
        percentOff: body.percentOff,
        target: body.target as Prisma.InputJsonValue,
        startsAt,
        endsAt,
        promotionCycles: body.promotionCycles,
        capacityPerFeature: body.capacityPerFeature,
        status: 'PAUSED',
        revision: 1,
        createdById: staffId,
      },
    })
    const campaignIds: string[] = []
    for (const [index, row] of rows.entries()) {
      // The ordinal follows productKey order; the cuid keeps codes unique across groups (≤ 29 of the 32 characters).
      const ordinal = index + 1
      const campaign = await tx.hybridCampaign.create({
        data: {
          code: `G${group.id.toUpperCase()}_${String(ordinal).padStart(2, '0')}`,
          slug: `promo-${group.id}-${ordinal}`,
          name: `${body.name} · ${row.name}`,
          draftDefinition: promotionDefinition(row.featureCode, row.listPrice!, body),
          startsAt,
          endsAt,
          capacity: body.capacityPerFeature,
          audience: 'ALL',
          listed: true,
          purpose: 'PROMOTION',
          promotionGroupId: group.id,
          status: 'DRAFT',
          revision: 1,
          createdById: staffId,
        },
      })
      await publishWithin(tx, campaign.id, 1, staffId, { allowGrouped: true })
      campaignIds.push(campaign.id)
    }
    await auditGroup(tx, group.id, staffId, 'HYBRID_PROMOTION_GROUP_CREATED', {
      name: body.name,
      percentOff: body.percentOff,
      prices: rows.map(row => ({ featureCode: row.featureCode, listPrice: row.listPrice, price: row.price })),
      campaignIds,
    })
    return { groupId: group.id, campaignIds }
  }, LOCK_WAIT)
  for (const id of created.campaignIds) await notifyCampaign(id)
  return created
}

/** Superadmin's «Descuentos %»: one row per group, newest first, paginated by the server with the exact total (audit #12). */
export async function listPromotionGroups(input: unknown) {
  const { page, pageSize, status } = parse(promotionGroupListQuery, input)
  const where: Prisma.HybridPromotionGroupWhereInput = status ? { status } : {}
  const [rows, total] = await Promise.all([
    prisma.hybridPromotionGroup.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { campaigns: true } } },
    }),
    prisma.hybridPromotionGroup.count({ where }),
  ])
  const items = rows.map(({ _count, ...group }) => ({ ...group, functions: _count.campaigns }))
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
}

/** A group with every campaign (ENDED ones too) in ordinal order, each with the publication on sale or null. */
export async function getPromotionGroup(groupId: string) {
  const group = await prisma.hybridPromotionGroup.findUnique({ where: { id: groupId } })
  if (!group) throw new NotFoundError('Descuento no encontrado.', 'HYBRID_PROMOTION_GROUP_NOT_FOUND')
  // Codes are `G<GROUP>_<NN>`: code order is the ordinal (productKey) order, and codes are unique.
  const campaigns = await prisma.hybridCampaign.findMany({
    where: { promotionGroupId: groupId },
    orderBy: { code: 'asc' },
    take: MAX_MEMBERS,
  })
  const ids = campaigns.flatMap(campaign => (campaign.currentPublicationId ? [campaign.currentPublicationId] : []))
  const publications = ids.length ? await prisma.hybridOfferPublication.findMany({ where: { id: { in: ids } }, take: ids.length }) : []
  const byId = new Map(publications.map(publication => [publication.id, publication]))
  return {
    ...group,
    campaigns: campaigns.map(campaign => ({
      ...campaign,
      publication: (campaign.currentPublicationId && byId.get(campaign.currentPublicationId)) || null,
    })),
  }
}

/** The group and its campaigns still in play (an ENDED one is terminal and left alone), in productKey order. */
async function loadGroup(groupId: string, expectedRevision: number) {
  const group = await prisma.hybridPromotionGroup.findUnique({ where: { id: groupId } })
  if (!group) throw new NotFoundError('Descuento no encontrado.', 'HYBRID_PROMOTION_GROUP_NOT_FOUND')
  if (group.revision !== expectedRevision) changed()
  if (group.status === 'ENDED') throw new ConflictError('Este descuento terminó. Crea otro.', 'HYBRID_PROMOTION_GROUP_ENDED')
  const campaigns = await prisma.hybridCampaign.findMany({
    where: { promotionGroupId: groupId, status: { not: 'ENDED' } },
    orderBy: { id: 'asc' },
    take: MAX_MEMBERS,
  })
  const ids = campaigns.flatMap(campaign => (campaign.currentPublicationId ? [campaign.currentPublicationId] : []))
  const publications = ids.length ? await prisma.hybridOfferPublication.findMany({ where: { id: { in: ids } }, take: ids.length }) : []
  const members = campaigns.map(campaign => {
    const publication = publications.find(p => p.id === campaign.currentPublicationId) ?? null
    const definition = hybridOfferDefinition.parse(publication?.definition ?? campaign.draftDefinition)
    const key = productKeyOf(definition)
    if (!key || definition.kind !== 'FEATURES')
      throw new ConflictError('Una promoción de este descuento ya no es de una sola función.', 'HYBRID_PROMOTION_GROUP_INVALID')
    return { campaign, publication, definition, key, featureCode: definition.featureCodes[0] }
  })
  return { group, members: members.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) }
}

/**
 * Pausing, activating or ending a group changes all its campaigns together (spec §4.3), atomically: Stripe is prepared
 * first, then ONE transaction takes every product lock, checks the list rule of each (going ACTIVE), writes each campaign
 * and the group conditionally. If any of it fails, nothing changes.
 */
export async function setPromotionGroupStatus(
  groupId: string,
  input: { status: 'ACTIVE' | 'PAUSED' | 'ENDED'; expectedRevision: number },
  staffId: string,
) {
  const { status, expectedRevision } = parse(promotionGroupStatusBody, input)
  const { group, members } = await loadGroup(groupId, expectedRevision)
  if (status === 'ACTIVE') {
    assertHybridSalesOpen()
    if (group.endsAt <= new Date()) throw new ConflictError('La vigencia de este descuento ya terminó.', 'HYBRID_OFFER_UNAVAILABLE')
    // A sold-out promotion may go ACTIVE with the others (the quote says it is full); an unpublished draft may not.
    for (const { campaign, publication } of members)
      if (!publication || publication.definitionHash !== compileHybridPublication(campaign.draftDefinition).definitionHash)
        throw new ConflictError('Publica y revisa la versión vigente antes de activarla.', 'HYBRID_PUBLICATION_REQUIRED')
    for (const { publication } of members) await ensureHybridPublicationPrices(publication!.id)
  }
  const row = await prisma.$transaction(async tx => {
    await lockProducts(
      tx,
      members.map(member => member.key),
    )
    if (status === 'ACTIVE') for (const { definition } of members) await assertPromotionBelowList(tx, definition)
    for (const { campaign, publication } of members)
      await setCampaignStatusWithin(tx, campaign, status, staffId, status === 'ACTIVE' ? publication!.id : null)
    const moved = await tx.hybridPromotionGroup.updateMany({
      where: { id: groupId, revision: expectedRevision, status: group.status },
      data: { status, revision: { increment: 1 } },
    })
    if (moved.count !== 1) changed()
    await auditGroup(tx, groupId, staffId, 'HYBRID_PROMOTION_GROUP_STATUS_CHANGED', {
      previous: group.status,
      status,
      campaignIds: members.map(member => member.campaign.id),
    })
    return tx.hybridPromotionGroup.findUniqueOrThrow({ where: { id: groupId } })
  }, LOCK_WAIT)
  for (const { campaign } of members) await notifyCampaign(campaign.id)
  return row
}

/**
 * Spec §4.3, after a list changed: new versions of the paused group's campaigns at % off the CURRENT lists, renewing to
 * them (or the same price forever when the group has no cycles). Same campaigns, capacity and redemptions. Never automatic.
 */
export async function recalculatePromotionGroup(groupId: string, expectedRevision: number, staffId: string) {
  const { group, members } = await loadGroup(groupId, expectedRevision)
  if (group.status !== 'PAUSED') throw new ConflictError('Pausa el descuento antes de recalcularlo.', 'HYBRID_PROMOTION_GROUP_NOT_PAUSED')
  const row = await prisma.$transaction(async tx => {
    await lockProducts(
      tx,
      members.map(member => member.key),
    )
    const moved = await tx.hybridPromotionGroup.updateMany({
      where: { id: groupId, revision: expectedRevision, status: 'PAUSED' },
      data: { revision: { increment: 1 } },
    })
    if (moved.count !== 1) changed()
    const rows = await previewRows(
      tx,
      members.map(member => member.featureCode),
      group,
      false,
    )
    if (rows.some(r => r.status === 'NO_LIST'))
      throw new ConflictError('Una función de este descuento ya no tiene precio de lista.', 'HYBRID_PROMOTION_NO_LIST')
    assertAboveMinimum(rows)
    for (const [index, { campaign, featureCode }] of members.entries()) {
      const drafted = await tx.hybridCampaign.updateMany({
        where: { id: campaign.id, revision: campaign.revision },
        data: { draftDefinition: promotionDefinition(featureCode, rows[index].listPrice!, group) },
      })
      if (drafted.count !== 1) changed()
      await publishWithin(tx, campaign.id, campaign.revision, staffId, { allowGrouped: true })
    }
    await auditGroup(tx, groupId, staffId, 'HYBRID_PROMOTION_GROUP_RECALCULATED', {
      revision: expectedRevision + 1,
      prices: rows.map(r => ({ featureCode: r.featureCode, listPrice: r.listPrice, price: r.price })),
    })
    return tx.hybridPromotionGroup.findUniqueOrThrow({ where: { id: groupId } })
  }, LOCK_WAIT)
  for (const { campaign } of members) await notifyCampaign(campaign.id)
  return row
}
