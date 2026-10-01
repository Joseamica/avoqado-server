import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { FEATURE_CATALOG } from '@/config/featureCatalog'
import { elPlanConcede, PAID_PLAN_TIER_CODES, FREE_TIER_CODES } from '@/services/access/basePlan.service'
import { inventarioDeObligaciones, type InventarioDeObligaciones } from '@/services/access/inventarioDeObligaciones'
import { evaluarCompatibilidad, type Proyeccion } from '@/services/access/obligacionesDeCobro'
import { getOrCreateStripeCustomer, stripe, STRIPE_DENTRO_DEL_CANDADO } from '@/services/stripe.service'
import { autorizarObligacionNueva } from '@/services/access/autorizarObligacionNueva'
import { fromStripeAmount } from '@/services/payments/providers/money'
import { hybridOfferDefinition } from './hybridOffer.schema'
import { lineCoverage, projectionCodes, retainedCoverage } from './hybridCoverage'
import { assertDependencyTerms } from './hybridDependencies'
import { buildHybridQuote, type QuoteLine } from './hybridQuote'
import { hybridHash } from './hybridProvider'
import { readHybridCreditSource } from './hybridSources'
import { assertHybridBalanceUsable } from './hybridFundingGraph'
import { audienceIncludes, hybridOfferBlocker, type HybridOfferBlocker } from './hybridOfferEligibility'
import { lockProducts, productKeyOf, promotionWindow } from './hybridProduct'
import { assertKeepSelection } from '@/services/dashboard/seatReconciliation.service'

const errorMap: z.ZodErrorMap = () => ({ message: 'Valor requerido o formato no válido' })
const codes = z
  .array(z.string({ errorMap }).regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'Función no válida'), { errorMap })
  .max(100, 'Máximo 100 funciones')
export const hybridQuoteBody = z
  .object(
    {
      lines: z
        .array(
          z
            .object(
              {
                publicationId: z.string({ errorMap }).cuid('Oferta no válida'),
                selectedFeatureCodes: codes.default([]),
              },
              { errorMap },
            )
            .strict('Campo no admitido'),
          { errorMap },
        )
        .min(1, 'Elige una oferta')
        .max(8, 'Máximo ocho ofertas'),
      replaceSubscriptionIds: z
        .array(z.string({ errorMap }).regex(/^sub_[A-Za-z0-9]+$/, 'Suscripción no válida'), { errorMap })
        .max(8, 'Máximo ocho suscripciones')
        .default([]),
      dropFeatureCodes: codes.default([]),
      // "Who stays" if this purchase leaves the venue on Free (spec §4.3), applied once its first invoice is paid.
      // Optional with NO default: a quote without it keeps the exact input, and therefore its hash.
      keepStaffVenueIds: z
        .array(z.string({ errorMap }).min(1, 'Usuario no válido'), { errorMap })
        .max(50, 'Máximo 50 usuarios')
        .optional()
        .describe('Si la compra deja al negocio en Gratis: quién conserva su acceso (máximo 2, incluido el dueño)'),
    },
    { errorMap },
  )
  .strict('Campo no admitido')

export function assertHybridSalesOpen() {
  if (process.env.HYBRID_BILLING_ENABLED !== 'true')
    throw new ConflictError('Las nuevas ofertas aún no están disponibles para contratar.', 'HYBRID_SALES_CLOSED')
}

export function hybridProjections(lines: ReturnType<typeof buildHybridQuote>['lines']): Proyeccion[] {
  return lines.map(line =>
    line.planTier
      ? { tipo: 'PLAN', tier: line.planTier, featureCodes: line.featureCodes }
      : { tipo: 'PAQUETE', featureCodes: line.featureCodes },
  )
}

const accessUnverified = () => new ConflictError('No pudimos revisar todos los accesos del negocio.', 'HYBRID_ACCESS_UNVERIFIED')
const isPlanRow = (row: { feature: { code: string } }) => (PAID_PLAN_TIER_CODES as readonly string[]).includes(row.feature.code)

/**
 * Everything the venue keeps besides what it replaces: read for the quote and AGAIN under the purchase lock, where the
 * dated dependency check is repeated (spec §4.2 rule 5) — a contract's `cancelAt` is not part of the inventory hash.
 */
async function readRetained(
  db: Prisma.TransactionClient,
  venueId: string,
  inventory: InventarioDeObligaciones,
  replaceSubscriptionIds: string[],
  now: Date,
) {
  const keptIds = inventory.vivas.map(source => source.subscriptionId).filter(id => !replaceSubscriptionIds.includes(id))
  const [legacy, replacedContracts, contracts] = await Promise.all([
    db.venueFeature.findMany({
      where: {
        venueId,
        active: true,
        suspendedAt: null,
        AND: [
          { OR: [{ endDate: null }, { endDate: { gte: now } }] },
          { OR: [{ stripeSubscriptionId: null }, { stripeSubscriptionId: { notIn: replaceSubscriptionIds } }] },
        ],
      },
      select: { stripeSubscriptionId: true, endDate: true, feature: { select: { code: true } } },
      orderBy: { id: 'asc' },
      take: 201,
    }),
    db.hybridContract.findMany({
      where: { venueId, stripeSubscriptionId: { in: replaceSubscriptionIds } },
      select: { id: true, stripeSubscriptionId: true },
      take: 65,
      orderBy: { id: 'asc' },
    }),
    db.hybridContract.findMany({
      where: { venueId, endedAt: null, stripeSubscriptionId: { in: keptIds } },
      select: {
        stripeSubscriptionId: true,
        featureCodes: true,
        startsAt: true,
        cancelAt: true,
        publication: { select: { definition: true } },
      },
      take: 65,
      orderBy: { id: 'asc' },
    }),
  ])
  if (legacy.length > 200 || replacedContracts.length > 64 || contracts.length > 64) throw accessUnverified()
  const grants = await db.capabilityGrant.findMany({
    where: {
      venueId,
      OR: [{ contractId: null }, { contractId: { notIn: replacedContracts.map(c => c.id) } }],
      revokedAt: null,
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    select: { featureCode: true, endsAt: true, contractId: true },
    take: 1001,
    orderBy: { id: 'asc' },
  })
  if (grants.length > 1000) throw accessUnverified()
  return { legacy, replacedContracts, contracts, grants }
}

/**
 * Spec §4.5 (option A): a function of a new line that the venue paid in a REPLACED contract moves to today's offer. The
 * quote says so: `from` is what that contract charged in its last paid period, `to` the line's price; equal is no change.
 */
async function repricedFunctions(venueId: string, subscriptionIds: string[], lines: QuoteLine[]) {
  const periods = await Promise.all(
    subscriptionIds.map(stripeSubscriptionId =>
      prisma.hybridPaymentPeriod.findFirst({
        where: { venueId, stripeSubscriptionId },
        orderBy: [{ endsAt: 'desc' }, { id: 'desc' }],
        select: { composition: true },
      }),
    ),
  )
  const paid = new Map<string, Prisma.Decimal>()
  for (const period of periods)
    for (const line of Array.isArray(period?.composition) ? (period.composition as Array<{ featureCodes: string[]; amount: string }>) : [])
      for (const code of line.featureCodes) paid.set(code, new Prisma.Decimal(line.amount))
  return lines.flatMap(line =>
    line.featureCodes.flatMap(featureCode => {
      const from = paid.get(featureCode)
      const to = new Prisma.Decimal(line.terms.price)
      return from && !from.eq(to) ? [{ featureCode, from: from.toFixed(2), to: to.toFixed(2) }] : []
    }),
  )
}

function assertAudience(
  campaign: { audience: string; startsAt: Date; eligibleOrganizationIds: string[] },
  organization: { id: string; createdAt: Date },
) {
  if (!audienceIncludes(campaign, organization))
    throw new ConflictError('Esta oferta no está disponible para tu organización.', 'HYBRID_OFFER_INELIGIBLE')
}

const OFFER_BLOCKED: Record<HybridOfferBlocker, () => ConflictError> = {
  UNAVAILABLE: () => new ConflictError('La oferta cambió o terminó. Revisa las condiciones vigentes.', 'HYBRID_OFFER_UNAVAILABLE'),
  FULL: () => new ConflictError('Se agotaron los lugares de la oferta.', 'HYBRID_OFFER_FULL'),
  INELIGIBLE: () => new ConflictError('Esta oferta no está disponible para tu organización.', 'HYBRID_OFFER_INELIGIBLE'),
  PREPARING: () => new ConflictError('La oferta todavía está preparando su cobro.', 'HYBRID_OFFER_UNAVAILABLE'),
}
const offerChanged = () => new ConflictError('La oferta cambió; revisa una cotización nueva.', 'HYBRID_OFFER_UNAVAILABLE')

/** Re-read at acceptance with the same effective timestamp; changes require a new human-reviewed quote. */
export async function observeHybridQuote(venueId: string, body: z.output<typeof hybridQuoteBody>, effectiveAt: number) {
  const now = new Date()
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, include: { organization: true } })
  if (!venue) throw new NotFoundError('Negocio no encontrado.')
  const publications = await prisma.hybridOfferPublication.findMany({
    where: { id: { in: body.lines.map(line => line.publicationId) } },
    take: 8,
    orderBy: { id: 'asc' },
    include: { campaign: true },
  })
  if (publications.length !== body.lines.length || new Set(publications.map(p => p.campaignId)).size !== publications.length)
    throw new BadRequestError('La selección contiene una oferta desconocida o repetida.')
  const parentListKeys: string[] = []
  for (const publication of publications) {
    const definition = hybridOfferDefinition.parse(publication.definition)
    const blocker = hybridOfferBlocker(
      { ...publication.campaign, latestPublicationId: publication.campaign.currentPublicationId ?? undefined },
      { ...publication, renewalKind: definition.terms.renewal.kind },
      venue.organization,
      now,
    )
    if (blocker) throw OFFER_BLOCKED[blocker]()
    if (publication.campaign.promotionGroupId) {
      const key = productKeyOf(definition)
      if (!key) throw OFFER_BLOCKED.UNAVAILABLE()
      parentListKeys.push(key)
    }
  }
  // A generated promotion sells only while the LIST of its product does, also through its own link (spec §4.2).
  if (
    parentListKeys.length &&
    (await prisma.hybridCampaign.count({ where: { purpose: 'LIST', status: 'ACTIVE', listProductKey: { in: parentListKeys } } })) !==
      new Set(parentListKeys).size
  )
    throw OFFER_BLOCKED.UNAVAILABLE()
  // Single use is a promotion rule: a LIST is bought again freely and never holds a redemption.
  const redeemed = await prisma.hybridRedemption.findMany({
    where: {
      organizationId: venue.organizationId,
      campaignId: { in: publications.filter(p => p.campaign.purpose !== 'LIST').map(p => p.campaignId) },
      status: { not: 'RELEASED' },
    },
    take: 8,
    orderBy: { id: 'asc' },
  })
  if (redeemed.length)
    throw new ConflictError('Tu organización ya utilizó esta campaña o tiene una aceptación pendiente.', 'HYBRID_OFFER_REDEEMED')
  const inventory = await inventarioDeObligaciones(venueId, { limite: Date.now() + 45000 })
  if (inventory.conCambiosProgramados.length)
    throw new ConflictError('Resuelve los cambios de suscripción pendientes antes de continuar.', 'CAMBIOS_PROGRAMADOS')
  const replaced = inventory.vivas.filter(source => body.replaceSubscriptionIds.includes(source.subscriptionId))
  if (replaced.length !== new Set(body.replaceSubscriptionIds).size)
    throw new BadRequestError('No encontramos una suscripción de origen en este negocio.')
  if (replaced.some(source => source.proyecciones.some(p => p.tipo === 'AJENO' || p.tipo === 'DESCONOCIDO')))
    throw new ConflictError('Una suscripción de origen requiere revisión.', 'OBLIGACION_DESCONOCIDA')
  const retained = await readRetained(prisma, venueId, inventory, body.replaceSubscriptionIds, now)
  const retainedCodes = [
    ...new Set([
      ...inventory.vivas
        .filter(source => !body.replaceSubscriptionIds.includes(source.subscriptionId))
        .flatMap(source => source.proyecciones.flatMap(projectionCodes)),
      // Plan rows only feed the dated coverage below; what counts as already paid stays as it was.
      ...retained.legacy.filter(row => !isPlanRow(row)).map(row => row.feature.code),
      ...retained.grants.map(grant => grant.featureCode),
    ]),
  ]
  const composition = buildHybridQuote({
    lines: body.lines.map(line => {
      const pub = publications.find(p => p.id === line.publicationId)!
      return {
        publication: { ...pub, definition: hybridOfferDefinition.parse(pub.definition) },
        selectedFeatureCodes: line.selectedFeatureCodes,
      }
    }),
    retainedFeatureCodes: retainedCodes,
    existing: replaced.map(source => ({
      subscriptionId: source.subscriptionId,
      featureCodes: source.proyecciones.flatMap(projectionCodes),
    })),
    dropFeatureCodes: body.dropFeatureCodes,
  })
  assertDependencyTerms([
    ...retainedCoverage({ inventory, replaceSubscriptionIds: body.replaceSubscriptionIds, ...retained }),
    ...lineCoverage(composition.lines, now),
  ])
  const compatible = evaluarCompatibilidad(
    inventory.vivas,
    { tipo: 'HYBRID', proyecciones: hybridProjections(composition.lines), reemplaza: composition.replaces },
    elPlanConcede,
  )
  if (!compatible.ok)
    throw new ConflictError('La compra se superpone con una obligación vigente. Revisa qué suscripciones reemplazarás.', compatible.codigo)
  const sources: Awaited<ReturnType<typeof readHybridCreditSource>>[] = []
  // Provider fan-out is bounded to the eight explicitly selected source subscriptions.
  for (const source of replaced) {
    const customerId = inventory.detalle[source.subscriptionId]?.customerId
    if (!customerId) throw new ConflictError('No pudimos verificar al titular del cobro de origen.')
    sources.push(await readHybridCreditSource(venueId, source.subscriptionId, customerId, effectiveAt))
  }
  const customer = venue.stripeCustomerId ? await stripe.customers.retrieve(venue.stripeCustomerId, {}, STRIPE_DENTRO_DEL_CANDADO) : null
  if (customer?.deleted) throw new ConflictError('El perfil de facturación necesita actualizarse.')
  const balance = customer && !customer.deleted ? customer.balance : 0
  if (customer && !customer.deleted) await assertHybridBalanceUsable(venueId, customer.id, balance)
  const credit = sources.reduce((sum, source) => sum.add(source.amount), new Prisma.Decimal(0))
  const net = new Prisma.Decimal(composition.total).sub(credit).add(new Prisma.Decimal(balance).div(100))
  const repriced = await repricedFunctions(
    venueId,
    [...new Set(retained.replacedContracts.map(contract => contract.stripeSubscriptionId))],
    composition.lines,
  )
  const quote = {
    ...composition,
    // Hashed with the rest: acceptance re-derives it from the same rows. Omitted when empty, so a quote without a
    // repricing keeps the hash shape it had before this field existed.
    ...(repriced.length ? { repriced } : {}),
    input: body,
    effectiveAt,
    credit: credit.toFixed(2),
    dueNow: Prisma.Decimal.max(0, net).toFixed(2),
    creditBalanceAfter: Prisma.Decimal.max(0, net.negated()).toFixed(2),
    existingBalance: balance < 0 ? fromStripeAmount(-balance).negated().toFixed(2) : fromStripeAmount(balance).toFixed(2),
    sources,
    campaigns: publications.map(p => ({ id: p.campaignId, publicationId: p.id })),
    inventoryHash: hybridHash({
      vivas: [...inventory.vivas].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId)),
      detalle: inventory.detalle,
    }),
  }
  return { quote, venue, publications }
}

export async function createHybridQuote(venueId: string, staffId: string, input: unknown) {
  assertHybridSalesOpen()
  const parsed = hybridQuoteBody.safeParse(input)
  if (!parsed.success) throw new BadRequestError(parsed.error.issues.map(issue => issue.message).join('. '))
  if (parsed.data.keepStaffVenueIds?.length) await assertKeepSelection(venueId, parsed.data.keepStaffVenueIds)
  const observed = await observeHybridQuote(venueId, parsed.data, Math.floor(Date.now() / 1000))
  // A LIST never ends: only promotion lines can cap the review window below five minutes.
  const quoteExpiresAt = new Date(
    Math.min(Date.now() + 5 * 60000, ...observed.publications.flatMap(p => promotionWindow(p.campaign)?.endsAt.getTime() ?? [])),
  )
  return prisma.hybridPurchase.create({
    data: {
      venueId,
      quotedById: staffId,
      quote: observed.quote as Prisma.InputJsonValue,
      quoteHash: hybridHash(observed.quote),
      quoteExpiresAt,
      status: 'QUOTED',
    },
  })
}

const acceptanceBody = z
  .object(
    {
      quoteHash: z.string({ errorMap }).regex(/^[a-f0-9]{64}$/, 'Cotización no válida'),
      clientKey: z
        .string({ errorMap })
        .min(8, 'La llave de intento está incompleta')
        .max(120, 'La llave de intento es demasiado larga')
        .regex(/^[A-Za-z0-9_-]+$/, 'Llave de intento no válida'),
    },
    { errorMap },
  )
  .strict('Campo no admitido')
export type HybridQuoteSnapshot = Awaited<ReturnType<typeof observeHybridQuote>>['quote']

/** Commits the reservation and accepted terms BEFORE any subscription can be created. */
export async function acceptHybridQuote(venueId: string, staffId: string, quoteId: string, input: unknown) {
  const parsed = acceptanceBody.safeParse(input)
  if (!parsed.success) throw new BadRequestError(parsed.error.issues.map(issue => issue.message).join('. '))
  const { quoteHash, clientKey } = parsed.data
  const purchase = await prisma.hybridPurchase.findUnique({ where: { id: quoteId, venueId } })
  if (!purchase) throw new NotFoundError('Cotización no encontrada.')
  if (quoteHash !== purchase.quoteHash) throw new ConflictError('La cotización no coincide con la que revisaste.', 'HYBRID_QUOTE_STALE')
  if (purchase.status !== 'QUOTED') {
    if (purchase.status === 'EXPIRED' || purchase.status === 'CANCELLED')
      throw new ConflictError('Este intento terminó. Solicita una cotización nueva.')
    return purchase
  }
  assertHybridSalesOpen()
  if (purchase.quoteExpiresAt <= new Date())
    throw new ConflictError('La cotización venció. Revisa una nueva antes de aceptar.', 'HYBRID_QUOTE_EXPIRED')
  const existingKey = await prisma.hybridPurchase.findUnique({ where: { venueId_clientKey: { venueId, clientKey } } })
  if (existingKey && existingKey.id !== quoteId) throw new ConflictError('Esta llave ya corresponde a otro intento.', 'HYBRID_KEY_REUSED')
  const saved = purchase.quote as unknown as HybridQuoteSnapshot
  if (saved.schemaVersion !== 1) throw new ConflictError('La cotización requiere una versión compatible.')
  const observed = await observeHybridQuote(venueId, hybridQuoteBody.parse(saved.input), saved.effectiveAt)
  if (hybridHash(observed.quote) !== quoteHash)
    throw new ConflictError('Cambió tu acceso, saldo u oferta. Revisa una cotización nueva.', 'HYBRID_QUOTE_STALE')
  const customerId =
    observed.venue.stripeCustomerId ??
    (await getOrCreateStripeCustomer(venueId, observed.venue.organization.email, observed.venue.organization.name))
  return autorizarObligacionNueva(
    venueId,
    customerId,
    {
      tipo: 'HYBRID',
      proyecciones: hybridProjections(saved.lines),
      reemplaza: saved.replaces,
    },
    async (tx, inventory) => {
      if (
        hybridHash({
          vivas: [...inventory.vivas].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId)),
          detalle: inventory.detalle,
        }) !== saved.inventoryHash
      )
        throw new ConflictError('Cambió una suscripción antes de aceptar. Revisa la cotización.', 'HYBRID_QUOTE_STALE')
      const now = new Date()
      // Spec §4.2 rule 5: a cancellation scheduled after the re-observation above only shows up here, under the lock.
      // Reads only: no campaign row is written before lockProducts below.
      const retained = await readRetained(tx, venueId, inventory, saved.replaces, now)
      assertDependencyTerms([
        ...retainedCoverage({ inventory, replaceSubscriptionIds: saved.replaces, ...retained }),
        ...lineCoverage(saved.lines, now),
      ])
      const claimed = await tx.hybridPurchase.updateMany({
        where: { id: quoteId, venueId, status: 'QUOTED', quoteExpiresAt: { gt: now } },
        data: {
          status: 'ACCEPTED',
          acceptedAt: now,
          paymentExpiresAt: new Date(now.getTime() + 23 * 3600000),
          stripeCustomerId: customerId,
          clientKey,
        },
      })
      if (claimed.count !== 1)
        throw new ConflictError('La cotización cambió o ya fue aceptada. Consulta el mismo intento.', 'HYBRID_QUOTE_STALE')
      // Invariant: every transaction that writes product-keyed campaign rows takes the sorted precio:<key> locks first, so
      // mirror carts and catalog operations (list price, promotion group) never wait on each other in opposite orders.
      await lockProducts(
        tx,
        observed.publications.flatMap(p => {
          if (p.campaign.purpose === 'LIST') return p.campaign.listProductKey ?? []
          return p.campaign.promotionGroupId ? (productKeyOf(hybridOfferDefinition.parse(p.definition)) ?? []) : []
        }),
      )
      for (const offer of [...observed.publications].sort((a, b) => a.campaignId.localeCompare(b.campaignId))) {
        const campaign = await tx.hybridCampaign.findUniqueOrThrow({ where: { id: offer.campaignId } })
        const window = promotionWindow(campaign)
        if (
          campaign.status !== 'ACTIVE' ||
          campaign.startsAt > now ||
          (campaign.purpose !== 'LIST' && (!window || window.endsAt <= now)) ||
          campaign.currentPublicationId !== offer.id
        )
          throw offerChanged()
        if (window && campaign.reservedCount + campaign.redeemedCount >= window.capacity)
          throw new ConflictError('La oferta ya no tiene lugares disponibles.', 'HYBRID_OFFER_FULL')
        assertAudience(campaign, observed.venue.organization)
        if (campaign.promotionGroupId) {
          // Its parent LIST must still be on sale; this write serializes the acceptance against pausing that list.
          const key = productKeyOf(hybridOfferDefinition.parse(offer.definition))
          const parent = key
            ? await tx.hybridCampaign.updateMany({
                where: { purpose: 'LIST', listProductKey: key, status: 'ACTIVE' },
                data: { updatedAt: now },
              })
            : { count: 0 }
          if (parent.count !== 1) throw offerChanged()
        }
        if (!window) {
          // A LIST: no redemption and no capacity. Same revision, still ACTIVE and still pointing at the quoted price is
          // what serializes this acceptance against a pause or a new price committed after the read above.
          const touched = await tx.hybridCampaign.updateMany({
            where: { id: campaign.id, revision: campaign.revision, status: 'ACTIVE', currentPublicationId: offer.id },
            data: { updatedAt: now },
          })
          if (touched.count !== 1) throw offerChanged()
          continue
        }
        const held = await tx.hybridCampaign.updateMany({
          where: {
            id: campaign.id,
            revision: campaign.revision,
            status: 'ACTIVE',
            reservedCount: campaign.reservedCount,
            redeemedCount: campaign.redeemedCount,
          },
          data: { reservedCount: { increment: 1 } },
        })
        if (held.count !== 1) throw offerChanged()
        const old = await tx.hybridRedemption.findUnique({
          where: { campaignId_organizationId: { campaignId: campaign.id, organizationId: observed.venue.organizationId } },
        })
        if (old && old.status !== 'RELEASED') throw new ConflictError('Tu organización ya utilizó esta campaña.', 'HYBRID_OFFER_REDEEMED')
        if (old) await tx.hybridRedemption.update({ where: { id: old.id }, data: { purchaseId: quoteId, status: 'RESERVED' } })
        else
          await tx.hybridRedemption.create({
            data: { campaignId: campaign.id, organizationId: observed.venue.organizationId, purchaseId: quoteId },
          })
      }
      const credits = saved.sources.filter(source => new Prisma.Decimal(source.amount).gt(0))
      if (credits.length)
        await tx.hybridCreditAllocation.createMany({
          data: credits.map(source => ({
            purchaseId: quoteId,
            sourceInvoiceId: source.sourceInvoiceId,
            sourceSubscriptionId: source.sourceSubscriptionId,
            amount: new Prisma.Decimal(source.amount),
          })),
        })
      await tx.activityLog.create({
        data: {
          staffId,
          venueId,
          action: 'HYBRID_PURCHASE_ACCEPTED',
          entity: 'HybridPurchase',
          entityId: quoteId,
          data: { quoteHash, dueNow: saved.dueNow, credit: saved.credit, publicationIds: saved.lines.map(line => line.publicationId) },
        },
      })
      return tx.hybridPurchase.findUniqueOrThrow({ where: { id: quoteId, venueId } })
    },
  )
}

export function hybridPurchaseView(purchase: Prisma.HybridPurchaseGetPayload<Record<string, never>>) {
  return {
    id: purchase.id,
    status: purchase.status,
    quote: purchase.quote,
    quoteHash: purchase.quoteHash,
    quoteExpiresAt: purchase.quoteExpiresAt,
    acceptedAt: purchase.acceptedAt,
    paymentExpiresAt: purchase.paymentExpiresAt,
    lastIssue: purchase.lastIssue,
  }
}

export async function getHybridPurchaseStatus(venueId: string, purchaseId: string) {
  const purchase = await prisma.hybridPurchase.findUnique({ where: { id: purchaseId, venueId } })
  if (!purchase) throw new NotFoundError('Compra no encontrada.')
  return hybridPurchaseView(purchase)
}

/** Cross-tab recovery works even if browser storage was cleared after acceptance. */
export async function getCurrentHybridPurchase(venueId: string) {
  const purchase = await prisma.hybridPurchase.findFirst({
    where: { venueId, status: { notIn: ['QUOTED', 'COMPLETED', 'CANCELLED', 'EXPIRED'] } },
    orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
  })
  return purchase ? hybridPurchaseView(purchase) : null
}

export async function assertHybridOnboardingPurchase(organizationId: string, purchaseId?: string, tx: Prisma.TransactionClient = prisma) {
  const pending = await tx.hybridPurchase.findFirst({
    where: { venue: { organizationId }, status: { notIn: ['QUOTED', 'COMPLETED', 'CANCELLED', 'EXPIRED'] } },
    select: { id: true },
  })
  if (pending)
    throw new ConflictError('Tienes una compra sin confirmar. Retoma el mismo intento antes de terminar.', 'HYBRID_ACTIVATION_PENDING')
  if (!purchaseId) return
  const purchase = await tx.hybridPurchase.findFirst({
    where: { id: purchaseId, status: 'COMPLETED', venue: { organizationId } },
    select: { id: true },
  })
  if (!purchase)
    throw new ConflictError('Tu compra aún no está activa. Retoma el mismo intento antes de terminar.', 'HYBRID_ACTIVATION_PENDING')
}

/** The inventory already enforces provider traversal ceilings; inability to observe is an explicit error. */
export async function getHybridReplacementOptions(venueId: string) {
  const inventory = await inventarioDeObligaciones(venueId, { limite: Date.now() + 45000 })
  const now = new Date()
  const [manual, grants] = await Promise.all([
    prisma.venueFeature.findMany({
      where: { venueId, stripeSubscriptionId: null, active: true, suspendedAt: null, OR: [{ endDate: null }, { endDate: { gt: now } }] },
      select: { feature: { select: { code: true } } },
      orderBy: { id: 'asc' },
      take: 201,
    }),
    prisma.capabilityGrant.groupBy({
      by: ['featureCode'],
      where: {
        venueId,
        contractId: null,
        revokedAt: null,
        startsAt: { lte: now },
        endsAt: { gt: now },
        featureCode: { in: FEATURE_CATALOG.flatMap(row => (row.featureCode ? [row.featureCode] : [])) },
      },
      orderBy: { featureCode: 'asc' },
      take: FEATURE_CATALOG.length,
    }),
  ])
  if (manual.length > 200) throw new ConflictError('No pudimos revisar todos los accesos del negocio.', 'HYBRID_ACCESS_UNVERIFIED')
  const manualCodes = manual.flatMap(row => {
    const code = row.feature.code
    if (code === 'PLAN_PRO' || code === 'PLAN_PREMIUM')
      return projectionCodes({ tipo: 'PLAN', tier: code === 'PLAN_PRO' ? 'PRO' : 'PREMIUM' })
    return [code]
  })
  return {
    standaloneFeatureCodes: [...new Set([...FREE_TIER_CODES, ...manualCodes, ...grants.map(row => row.featureCode)])].sort(),
    total: inventory.vivas.length,
    items: inventory.vivas.map(source => ({
      subscriptionId: source.subscriptionId,
      featureCodes: [...new Set(source.proyecciones.flatMap(projectionCodes))],
      replaceable:
        !inventory.conCambiosProgramados.includes(source.subscriptionId) &&
        source.proyecciones.every(p => p.tipo !== 'AJENO' && p.tipo !== 'DESCONOCIDO'),
    })),
  }
}
