import { FEATURE_CATALOG } from '@/config/featureCatalog'
import { Prisma, StaffRole, type LaunchCampaignStatus } from '@prisma/client'
import { SocketEventType } from '@/communication/sockets/types'
import logger from '@/config/logger'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { compileHybridPublication, previewHybridOffer } from './hybridOffer.service'
import { hybridOfferDefinition, type HybridOfferDefinition } from './hybridOffer.schema'
import { activePromotionOverlaps, assertPromotionBelowList } from './hybridPriceRule'
import { lockProducts, priceTransaction, productKeyOf } from './hybridProduct'

const errorMap: z.ZodErrorMap = () => ({ message: 'Valor requerido o formato no válido' })
export const hybridCampaignBody = z
  .object(
    {
      code: z
        .string({ errorMap })
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/, 'Código no válido'),
      slug: z
        .string({ errorMap })
        .trim()
        .min(3, 'Mínimo 3 caracteres')
        .max(60, 'Máximo 60 caracteres')
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Dirección no válida'),
      name: z.string({ errorMap }).trim().min(3, 'Mínimo 3 caracteres').max(120, 'Máximo 120 caracteres'),
      startsAt: z.string({ errorMap }).datetime({ offset: true, message: 'Indica fecha, hora y zona' }),
      endsAt: z.string({ errorMap }).datetime({ offset: true, message: 'Indica fecha, hora y zona' }),
      capacity: z.number({ errorMap }).int('El cupo debe ser entero').min(1, 'Mínimo un lugar').max(100000, 'Máximo 100,000 lugares'),
      audience: z.enum(['ALL', 'NEW_ORGANIZATIONS', 'ORGANIZATIONS'], { errorMap }),
      eligibleOrganizationIds: z
        .array(z.string({ errorMap }).cuid('Organización no válida'), { errorMap })
        .max(100, 'Máximo 100 organizaciones')
        .default([]),
      listed: z.boolean({ errorMap }).default(false),
      definition: hybridOfferDefinition,
    },
    { errorMap },
  )
  .strict('Campo no admitido')

export const hybridCampaignUpdateBody = hybridCampaignBody.extend({ expectedRevision: z.number({ errorMap }).int().positive() })
export const hybridCampaignListQuery = z
  .object(
    {
      page: z.coerce.number({ errorMap }).int().min(1).max(1000000).default(1),
      pageSize: z.coerce.number({ errorMap }).int().min(1).max(100).default(25),
      q: z.string({ errorMap }).trim().max(120).optional(),
      status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'], { errorMap }).optional(),
    },
    { errorMap },
  )
  .strict('Filtro no admitido')

// The window under review travels in the query string: the shared preview body stays strict and unchanged, and an older
// server simply ignores it.
const reviewWindowQuery = z
  .object(
    {
      campaignId: z.string({ errorMap }).min(1).max(64).optional(),
      startsAt: z.string({ errorMap }).datetime({ offset: true, message: 'Indica fecha, hora y zona' }).optional(),
      endsAt: z.string({ errorMap }).datetime({ offset: true, message: 'Indica fecha, hora y zona' }).optional(),
    },
    { errorMap },
  )
  .strict('Filtro no admitido')

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new BadRequestError(
      result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('. '),
      'HYBRID_CAMPAIGN_INVALID',
    )
  return result.data
}

function draftData(input: z.infer<typeof hybridCampaignBody>) {
  if (Date.parse(input.startsAt) >= Date.parse(input.endsAt)) throw new BadRequestError('La vigencia debe terminar después de empezar.')
  if (input.audience === 'ORGANIZATIONS' && input.eligibleOrganizationIds.length === 0)
    throw new BadRequestError('Selecciona al menos una organización para esta oferta.')
  // Creating/editing is not publishing, but malformed pricing and unsupported compositions never persist.
  compileHybridPublication(input.definition)
  const { definition, ...data } = input
  return {
    ...data,
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    draftDefinition: definition as Prisma.InputJsonValue,
  }
}

/**
 * The editor's «Revisar oferta»: the shared offer preview plus, for a single-product offer reviewed with its window, the
 * ACTIVE promotions of that product whose window meets it, without the campaign under review (spec §4.4: the promotions
 * screen warns of the overlap; it never blocks it).
 */
export async function reviewHybridCampaignOffer(body: unknown, query: unknown) {
  const preview = previewHybridOffer(body)
  const { campaignId, startsAt, endsAt } = parse(reviewWindowQuery, query ?? {})
  const key = startsAt && endsAt ? productKeyOf(hybridOfferDefinition.parse((body as { offer: unknown }).offer)) : null
  const overlaps = key ? ((await activePromotionOverlaps([key], new Date(startsAt!), new Date(endsAt!), campaignId)).get(key) ?? []) : []
  return { ...preview, overlaps }
}

export async function audit(tx: Prisma.TransactionClient, id: string, staffId: string, action: string, data: Prisma.InputJsonObject) {
  await tx.activityLog.create({ data: { staffId, action, entity: 'HybridCampaign', entityId: id, data } })
}

export function changed(): never {
  throw new ConflictError('La ficha cambió. Actualiza la página y revisa la nueva versión.', 'HYBRID_CAMPAIGN_STALE')
}

/** A «% de descuento» member is managed only through its group: editing one alone breaks the group (`loadGroup`). */
function assertNotGrouped(campaign: { promotionGroupId: string | null }) {
  if (campaign.promotionGroupId)
    throw new ConflictError('Esta promoción pertenece a un descuento %: cámbiala desde su grupo.', 'HYBRID_CAMPAIGN_GROUPED')
}

/**
 * A promotion price goes on sale only under its product lock and below its list (spec §4.4). Called before any campaign
 * row write, so a concurrent list change and this promotion serialize on the product, never pass on a stale read.
 */
async function lockAndCheckListRule(tx: Prisma.TransactionClient, definition: HybridOfferDefinition) {
  const key = productKeyOf(definition)
  if (!key) return
  await lockProducts(tx, [key])
  await assertPromotionBelowList(tx, definition)
}

export async function notifyCampaign(id: string) {
  try {
    const { socketManager } = await import('@/communication/sockets/managers/socketManager')
    socketManager.broadcastToRole(StaffRole.SUPERADMIN, SocketEventType.HYBRID_CAMPAIGN_UPDATED, { id })
  } catch (error) {
    logger.warn('Campaign invalidation unavailable', { campaignId: id, error: error instanceof Error ? error.message : String(error) })
  }
}

export async function createHybridCampaign(input: unknown, staffId: string) {
  const data = draftData(parse(hybridCampaignBody, input))
  return prisma
    .$transaction(async tx => {
      const row = await tx.hybridCampaign.create({ data: { ...data, createdById: staffId, revision: 1, status: 'DRAFT' } })
      await audit(tx, row.id, staffId, 'HYBRID_CAMPAIGN_CREATED', { code: row.code })
      return row
    })
    .then(async row => {
      await notifyCampaign(row.id)
      return row
    })
}

export async function updateHybridCampaign(id: string, input: unknown, staffId: string) {
  const { expectedRevision, ...body } = parse(hybridCampaignUpdateBody, input)
  const data = draftData(body)
  return priceTransaction(async tx => {
    const current = await tx.hybridCampaign.findUnique({ where: { id } })
    // A LIST is priced only from «Precios» (spec §4.2): to this editor it does not exist.
    if (!current || current.purpose === 'LIST') throw new NotFoundError('Oferta no encontrada.')
    assertNotGrouped(current)
    if (current.revision !== expectedRevision) changed()
    if (current.status === 'ENDED') throw new ConflictError('Esta oferta terminó. Duplica la ficha para crear otra.')
    if (current.code !== data.code || current.slug !== data.slug)
      throw new BadRequestError('El código y la dirección no cambian. Duplica la oferta.')
    if (data.capacity < current.reservedCount + current.redeemedCount)
      throw new ConflictError('El cupo no puede ser menor a los lugares ya comprometidos.')
    // An ACTIVE promotion keeps selling its publication: a window (or capacity) that reopens puts that price on sale again,
    // and its list may have dropped while it was out of its window (the list rule skips promotions no longer in force).
    if (current.status === 'ACTIVE' && data.endsAt > new Date()) {
      const onSale = await loadCurrentPublication(tx, current)
      if (onSale) await lockAndCheckListRule(tx, hybridOfferDefinition.parse(onSale.definition))
    }
    const result = await tx.hybridCampaign.updateMany({
      where: { id, revision: expectedRevision, reservedCount: current.reservedCount, redeemedCount: current.redeemedCount },
      data: { ...data, revision: { increment: 1 } },
    })
    if (result.count !== 1) changed()
    await audit(tx, id, staffId, 'HYBRID_CAMPAIGN_UPDATED', { revision: expectedRevision + 1 })
    return tx.hybridCampaign.findUniqueOrThrow({ where: { id } })
  }).then(async row => {
    await notifyCampaign(id)
    return row
  })
}

/**
 * Publishing inside the caller's transaction (the «% de descuento» generator publishes many in one). The product lock and
 * the list rule come before the first write to the campaign row.
 */
export async function publishWithin(
  tx: Prisma.TransactionClient,
  id: string,
  expectedRevision: number,
  staffId: string,
  { allowGrouped = false }: { allowGrouped?: boolean } = {},
) {
  const campaign = await tx.hybridCampaign.findUnique({ where: { id } })
  if (!campaign || campaign.purpose === 'LIST') throw new NotFoundError('Oferta no encontrada.')
  if (!allowGrouped) assertNotGrouped(campaign)
  if (campaign.revision !== expectedRevision) changed()
  // PROMOTION: CHECK guarantees non-null
  if (campaign.status === 'ENDED' || campaign.endsAt! <= new Date())
    throw new ConflictError('La oferta terminó; duplica la ficha para publicar otra.')
  const publication = compileHybridPublication(campaign.draftDefinition)
  await lockAndCheckListRule(tx, publication.definition)
  // Claim the revision first: a concurrent publish of the same revision then fails as stale, not on the version index.
  const claimed = await tx.hybridCampaign.updateMany({
    where: { id, revision: expectedRevision },
    data: { revision: { increment: 1 }, status: 'PAUSED' },
  })
  if (claimed.count !== 1) changed()
  const row = await tx.hybridOfferPublication.create({
    data: {
      ...publication,
      definition: publication.definition as Prisma.InputJsonValue,
      campaignId: id,
      version: expectedRevision,
      name: campaign.name,
      createdById: staffId,
    },
  })
  // The new publication is the one on sale (once activated); the pointer only ever names this campaign's own row.
  await tx.hybridCampaign.update({ where: { id }, data: { currentPublicationId: row.id } })
  await audit(tx, id, staffId, 'HYBRID_OFFER_PUBLISHED', {
    publicationId: row.id,
    version: row.version,
    definitionHash: row.definitionHash,
  })
  return row
}

export async function publishHybridCampaign(id: string, expectedRevision: number, staffId: string) {
  return priceTransaction(tx => publishWithin(tx, id, expectedRevision, staffId)).then(async row => {
    await notifyCampaign(id)
    return row
  })
}

// Superadmin's «Campañas» list leaves out the campaigns a «% de descuento» group owns (they show once, as their group).
// Only this list takes the filter: the public listing and the MCP tool keep the shared query unchanged.
const hybridCampaignAdminListQuery = hybridCampaignListQuery
  .extend({ excludeGrouped: z.enum(['true', 'false'], { errorMap }).optional() })
  .strict('Filtro no admitido')

export async function listHybridCampaigns(input: unknown) {
  const { page, pageSize, q, status, excludeGrouped } = parse(hybridCampaignAdminListQuery, input)
  const where: Prisma.HybridCampaignWhereInput = {
    purpose: 'PROMOTION',
    ...(status ? { status } : {}),
    ...(excludeGrouped === 'true' ? { promotionGroupId: null } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] } : {}),
  }
  const [items, total] = await Promise.all([
    prisma.hybridCampaign.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.hybridCampaign.count({ where }),
  ])
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
}

/** Finite registry metadata for this offer only; every eligible capability is shown. */
function publicHybridFeatures(publication: { definition: unknown; includedFeatureCodes: string[] }) {
  const definition = hybridOfferDefinition.parse(publication.definition)
  const codes = definition.kind === 'CHOICE_BUNDLE' ? definition.eligibleFeatureCodes : publication.includedFeatureCodes
  return FEATURE_CATALOG.filter(feature => feature.featureCode && codes.includes(feature.featureCode)).map(feature => ({
    code: feature.featureCode!,
    names: feature.names,
  }))
}

/**
 * The product keys, among these, whose LIST is on sale: a generated promotion sells only while its parent does (quote and
 * accept refuse it otherwise, spec §4.2). One bounded read for a whole page; a LIST is unique per product key.
 */
async function parentListsOnSale(keys: string[]): Promise<Set<string>> {
  const unique = [...new Set(keys)]
  if (!unique.length) return new Set()
  const lists = await prisma.hybridCampaign.findMany({
    where: { purpose: 'LIST', status: 'ACTIVE', listProductKey: { in: unique } },
    select: { listProductKey: true },
    take: unique.length,
  })
  return new Set(lists.flatMap(list => list.listProductKey ?? []))
}

/** The parent product of a generated promotion (null for one that is not single-product, which never sells). */
function parentKeyOf(campaign: { promotionGroupId: string | null }, publication: { definition: unknown }): string | null {
  return campaign.promotionGroupId ? productKeyOf(hybridOfferDefinition.parse(publication.definition)) : null
}

/** The publication that is on sale: the explicit pointer, never "the highest version". */
export async function loadCurrentPublication(
  tx: Prisma.TransactionClient | typeof prisma,
  campaign: { currentPublicationId: string | null },
) {
  return campaign.currentPublicationId ? tx.hybridOfferPublication.findUnique({ where: { id: campaign.currentPublicationId } }) : null
}

export async function getPublicHybridOffer(slug: string) {
  const campaign = await prisma.hybridCampaign.findUnique({ where: { slug } })
  // A LIST never has a public page; past that check, the CHECK guarantees a PROMOTION's non-null window.
  if (
    !campaign ||
    campaign.purpose === 'LIST' ||
    campaign.status !== 'ACTIVE' ||
    campaign.startsAt > new Date() ||
    campaign.endsAt! <= new Date()
  )
    throw new NotFoundError('Esta oferta no está disponible.')
  if (campaign.reservedCount + campaign.redeemedCount >= campaign.capacity!)
    throw new ConflictError('Se agotaron los lugares de esta oferta.', 'HYBRID_OFFER_FULL')
  const publication = await loadCurrentPublication(prisma, campaign)
  if (!publication) throw new NotFoundError('Esta oferta no está disponible.')
  const parentKey = parentKeyOf(campaign, publication)
  const parentOnSale = !campaign.promotionGroupId || (parentKey !== null && (await parentListsOnSale([parentKey])).has(parentKey))
  return {
    schemaVersion: 1,
    id: publication.id,
    version: publication.version,
    code: campaign.code,
    slug: campaign.slug,
    name: publication.name,
    definition: publication.definition,
    definitionHash: publication.definitionHash,
    includedFeatureCodes: publication.includedFeatureCodes,
    features: publicHybridFeatures(publication),
    startsAt: campaign.startsAt,
    endsAt: campaign.endsAt,
    audience: campaign.audience,
    // PROMOTION: CHECK guarantees non-null
    placesRemaining: campaign.capacity! - campaign.reservedCount - campaign.redeemedCount,
    purchaseAvailable: process.env.HYBRID_BILLING_ENABLED === 'true' && parentOnSale,
  }
}

import { assertHybridSalesOpen } from './hybridPurchase.service'
import { ensureHybridPublicationPrices } from './hybridPrices'

/** `publications` keeps its response shape (superadmin and MCP read `publications[0]`): the pointer's publication, or empty. */
export async function getHybridCampaign(id: string) {
  const row = await prisma.hybridCampaign.findUnique({ where: { id } })
  if (!row || row.purpose === 'LIST') throw new NotFoundError('Oferta no encontrada.')
  const publication = await loadCurrentPublication(prisma, row)
  return { ...row, publications: publication ? [publication] : [] }
}

export const hybridStatusBody = z
  .object(
    {
      status: z.enum(['ACTIVE', 'PAUSED', 'ENDED'], { errorMap }),
      expectedRevision: z.number({ errorMap }).int().positive(),
      publicationId: z.string({ errorMap }).min(1).optional(),
    },
    { errorMap },
  )
  .strict('Campo no admitido')

/**
 * The status write alone, inside the caller's transaction: no Stripe and no checks beyond the conditional write. Callers
 * validate first and, when going ACTIVE, hold the product lock and checked the list rule (a «% de descuento» group changes
 * all its campaigns in one transaction with this).
 */
export async function setCampaignStatusWithin(
  tx: Prisma.TransactionClient,
  campaign: { id: string; revision: number; status: LaunchCampaignStatus },
  status: 'ACTIVE' | 'PAUSED' | 'ENDED',
  staffId: string,
  publicationId: string | null = null,
) {
  const changedRow = await tx.hybridCampaign.updateMany({
    where: { id: campaign.id, revision: campaign.revision, status: campaign.status },
    data: { status, revision: { increment: 1 } },
  })
  if (changedRow.count !== 1) changed()
  await audit(tx, campaign.id, staffId, 'HYBRID_CAMPAIGN_STATUS_CHANGED', { previous: campaign.status, status, publicationId })
  return tx.hybridCampaign.findUniqueOrThrow({ where: { id: campaign.id } })
}

export async function setHybridCampaignStatus(id: string, input: unknown, staffId: string) {
  const body = parse(hybridStatusBody, input)
  const current = await prisma.hybridCampaign.findUnique({ where: { id } })
  if (!current || current.purpose === 'LIST') throw new NotFoundError('Oferta no encontrada.')
  // The group path writes statuses through `setCampaignStatusWithin` directly; this entry point is the editor's.
  assertNotGrouped(current)
  if (current.revision !== body.expectedRevision) changed()
  if (current.status === 'ENDED') throw new ConflictError('Esta campaña terminó. Duplica la ficha para crear otra.')
  let goingOnSale: HybridOfferDefinition | null = null
  if (body.status === 'ACTIVE') {
    assertHybridSalesOpen()
    const publication = await loadCurrentPublication(prisma, current)
    if (
      !publication ||
      publication.id !== body.publicationId ||
      publication.definitionHash !== compileHybridPublication(current.draftDefinition).definitionHash
    )
      throw new ConflictError('Publica y revisa la versión vigente antes de activarla.', 'HYBRID_PUBLICATION_REQUIRED')
    // PROMOTION: CHECK guarantees non-null
    if (current.endsAt! <= new Date() || current.reservedCount + current.redeemedCount >= current.capacity!)
      throw new ConflictError('La campaña terminó o no tiene lugares disponibles.', 'HYBRID_OFFER_UNAVAILABLE')
    await ensureHybridPublicationPrices(publication.id)
    goingOnSale = hybridOfferDefinition.parse(publication.definition)
  }
  return priceTransaction(async tx => {
    // (Re)activating puts the price on sale again: its list may have dropped since it was published.
    if (goingOnSale) await lockAndCheckListRule(tx, goingOnSale)
    return setCampaignStatusWithin(tx, current, body.status, staffId, body.publicationId ?? null)
  }).then(async row => {
    await notifyCampaign(id)
    return row
  })
}

/** Public data only; private cohort identifiers and editable draft terms never leave the server. */
export async function listPublicHybridOffers(input: unknown) {
  const { page, pageSize, q } = parse(hybridCampaignListQuery.omit({ status: true }), input)
  const now = new Date()
  const where: Prisma.HybridCampaignWhereInput = {
    purpose: 'PROMOTION',
    status: 'ACTIVE',
    listed: true,
    startsAt: { lte: now },
    endsAt: { gt: now },
    audience: { in: ['ALL', 'NEW_ORGANIZATIONS'] },
    ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.hybridCampaign.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize,
      skip: (page - 1) * pageSize,
      select: {
        code: true,
        slug: true,
        startsAt: true,
        endsAt: true,
        audience: true,
        capacity: true,
        reservedCount: true,
        redeemedCount: true,
        currentPublicationId: true,
        promotionGroupId: true,
      },
    }),
    prisma.hybridCampaign.count({ where }),
  ])
  // One query for the whole page's pointers (bounded by pageSize), joined in memory.
  const ids = rows.flatMap(row => (row.currentPublicationId ? [row.currentPublicationId] : []))
  const publications = ids.length
    ? await prisma.hybridOfferPublication.findMany({
        where: { id: { in: ids } },
        take: ids.length,
        select: { id: true, name: true, version: true, definition: true, definitionHash: true, includedFeatureCodes: true },
      })
    : []
  const onSale = new Map(publications.map(publication => [publication.id, publication]))
  const pointed = rows.flatMap(row => {
    const publication = row.currentPublicationId ? onSale.get(row.currentPublicationId) : undefined
    return publication ? [{ row, publication, parentKey: parentKeyOf(row, publication) }] : []
  })
  // A generated promotion of a paused (or missing) list stays listed (the total is exact) but says it cannot be bought.
  const parents = await parentListsOnSale(pointed.flatMap(({ parentKey }) => parentKey ?? []))
  const items = pointed.map(({ row, publication, parentKey }) => {
    const parentOnSale = !row.promotionGroupId || (parentKey !== null && parents.has(parentKey))
    return {
      schemaVersion: 1,
      id: publication.id,
      version: publication.version,
      code: row.code,
      slug: row.slug,
      name: publication.name,
      definition: publication.definition,
      definitionHash: publication.definitionHash,
      includedFeatureCodes: publication.includedFeatureCodes,
      features: publicHybridFeatures(publication),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      audience: row.audience,
      // PROMOTION: CHECK guarantees non-null
      placesRemaining: row.capacity! - row.reservedCount - row.redeemedCount,
      purchaseAvailable:
        process.env.HYBRID_BILLING_ENABLED === 'true' && parentOnSale && row.reservedCount + row.redeemedCount < row.capacity!,
    }
  })
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
}

export const hybridRedemptionsQuery = hybridCampaignListQuery
  .pick({ page: true, pageSize: true, q: true })
  .extend({ status: z.enum(['RESERVED', 'REDEEMED', 'RELEASED'], { errorMap }).optional() })
  .strict('Filtro no admitido')
export async function listHybridRedemptions(campaignId: string, input: unknown) {
  const query = parse(hybridRedemptionsQuery, input)
  const campaign = await prisma.hybridCampaign.findUnique({ where: { id: campaignId }, select: { purpose: true } })
  if (!campaign || campaign.purpose === 'LIST') throw new NotFoundError('Campaña no encontrada.')
  const where: Prisma.HybridRedemptionWhereInput = {
    campaignId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.q ? { purchase: { venue: { name: { contains: query.q, mode: 'insensitive' } } } } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.hybridRedemption.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        status: true,
        createdAt: true,
        purchase: {
          select: {
            id: true,
            venueId: true,
            venue: { select: { name: true } },
            status: true,
            paymentExpiresAt: true,
            lastIssue: true,
            quote: true,
          },
        },
      },
    }),
    prisma.hybridRedemption.count({ where }),
  ])
  return {
    items: rows.map(row => ({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      purchaseId: row.purchase.id,
      venueId: row.purchase.venueId,
      venueName: row.purchase.venue?.name,
      purchaseStatus: row.purchase.status,
      paymentExpiresAt: row.purchase.paymentExpiresAt,
      lastIssue: row.purchase.lastIssue,
      dueNow: (row.purchase.quote as Prisma.JsonObject).dueNow,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  }
}
