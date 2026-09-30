import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { FEATURE_CATALOG } from '@/config/featureCatalog'
import { elPlanConcede, PAID_PLAN_TIER_CODES, FREE_TIER_CODES } from '@/services/access/basePlan.service'
import { inventarioDeObligaciones } from '@/services/access/inventarioDeObligaciones'
import { evaluarCompatibilidad, type Proyeccion } from '@/services/access/obligacionesDeCobro'
import { getOrCreateStripeCustomer, stripe, STRIPE_DENTRO_DEL_CANDADO } from '@/services/stripe.service'
import { autorizarObligacionNueva } from '@/services/access/autorizarObligacionNueva'
import { fromStripeAmount } from '@/services/payments/providers/money'
import { hybridOfferDefinition } from './hybridOffer.schema'
import { planIncludes } from './hybridOffer.service'
import { buildHybridQuote } from './hybridQuote'
import { hybridHash } from './hybridProvider'
import { readHybridCreditSource } from './hybridSources'
import { assertHybridBalanceUsable } from './hybridFundingGraph'
import { audienceIncludes, hybridOfferBlocker, type HybridOfferBlocker } from './hybridOfferEligibility'
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
const projectionCodes = (projection: Proyeccion): string[] => {
  if (projection.tipo === 'FUNCION') return [projection.featureCode]
  if (projection.tipo === 'PAQUETE') return projection.featureCodes
  if (projection.tipo === 'PLAN')
    return (
      projection.featureCodes ??
      FEATURE_CATALOG.flatMap(entry => (entry.featureCode && planIncludes(projection.tier, entry) ? [entry.featureCode] : []))
    )
  return []
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

/** Re-read at acceptance with the same effective timestamp; changes require a new human-reviewed quote. */
export async function observeHybridQuote(venueId: string, body: z.output<typeof hybridQuoteBody>, effectiveAt: number) {
  const now = new Date()
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, include: { organization: true } })
  if (!venue) throw new NotFoundError('Negocio no encontrado.')
  const publications = await prisma.hybridOfferPublication.findMany({
    where: { id: { in: body.lines.map(line => line.publicationId) } },
    take: 8,
    orderBy: { id: 'asc' },
    include: { campaign: { include: { publications: { select: { id: true }, orderBy: { version: 'desc' }, take: 1 } } } },
  })
  if (publications.length !== body.lines.length || new Set(publications.map(p => p.campaignId)).size !== publications.length)
    throw new BadRequestError('La selección contiene una oferta desconocida o repetida.')
  for (const publication of publications) {
    const definition = hybridOfferDefinition.parse(publication.definition)
    const blocker = hybridOfferBlocker(
      { ...publication.campaign, latestPublicationId: publication.campaign.publications[0]?.id },
      { ...publication, renewalKind: definition.terms.renewal.kind },
      venue.organization,
      now,
    )
    if (blocker) throw OFFER_BLOCKED[blocker]()
  }
  const redeemed = await prisma.hybridRedemption.findMany({
    where: { organizationId: venue.organizationId, campaignId: { in: publications.map(p => p.campaignId) }, status: { not: 'RELEASED' } },
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
  const [legacy, contracts] = await Promise.all([
    prisma.venueFeature.findMany({
      where: {
        venueId,
        active: true,
        suspendedAt: null,
        AND: [
          { OR: [{ endDate: null }, { endDate: { gte: now } }] },
          { OR: [{ stripeSubscriptionId: null }, { stripeSubscriptionId: { notIn: body.replaceSubscriptionIds } }] },
        ],
        feature: { code: { notIn: [...PAID_PLAN_TIER_CODES] } },
      },
      select: { feature: { select: { code: true } } },
      orderBy: { id: 'asc' },
      take: 201,
    }),
    prisma.hybridContract.findMany({
      where: { venueId, stripeSubscriptionId: { in: body.replaceSubscriptionIds } },
      select: { id: true },
      take: 65,
      orderBy: { id: 'asc' },
    }),
  ])
  if (legacy.length > 200 || contracts.length > 64)
    throw new ConflictError('No pudimos revisar todos los accesos del negocio.', 'HYBRID_ACCESS_UNVERIFIED')
  const grants = await prisma.capabilityGrant.findMany({
    where: {
      venueId,
      OR: [{ contractId: null }, { contractId: { notIn: contracts.map(c => c.id) } }],
      revokedAt: null,
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    select: { featureCode: true },
    take: 1001,
    orderBy: { id: 'asc' },
  })
  if (grants.length > 1000) throw new ConflictError('No pudimos revisar todos los accesos del negocio.', 'HYBRID_ACCESS_UNVERIFIED')
  const retainedCodes = [
    ...new Set([
      ...inventory.vivas
        .filter(source => !body.replaceSubscriptionIds.includes(source.subscriptionId))
        .flatMap(source => source.proyecciones.flatMap(projectionCodes)),
      ...legacy.map(row => row.feature.code),
      ...grants.map(grant => grant.featureCode),
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
  const quote = {
    ...composition,
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
  const quoteExpiresAt = new Date(Math.min(Date.now() + 5 * 60000, ...observed.publications.map(p => p.campaign.endsAt.getTime())))
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
      for (const offer of [...observed.publications].sort((a, b) => a.campaignId.localeCompare(b.campaignId))) {
        const campaign = await tx.hybridCampaign.findUniqueOrThrow({
          where: { id: offer.campaignId },
          include: { publications: { select: { id: true }, orderBy: { version: 'desc' }, take: 1 } },
        })
        if (
          campaign.status !== 'ACTIVE' ||
          campaign.startsAt > now ||
          campaign.endsAt <= now ||
          campaign.publications[0]?.id !== offer.id ||
          campaign.reservedCount + campaign.redeemedCount >= campaign.capacity
        )
          throw new ConflictError('La oferta ya no tiene lugares disponibles.', 'HYBRID_OFFER_FULL')
        assertAudience(campaign, observed.venue.organization)
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
        if (held.count !== 1)
          throw new ConflictError('El cupo cambió; consulta el mismo intento antes de volver a aceptar.', 'HYBRID_OFFER_FULL')
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
