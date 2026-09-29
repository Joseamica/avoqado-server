import { Prisma } from '@prisma/client'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { getVenueBaseTier } from '@/services/access/basePlan.service'
import { FEATURE_CATALOG } from '@/config/featureCatalog'
import { hybridOfferDefinition } from './hybridOffer.schema'
import { previewHybridOffer } from './hybridOffer.service'

export const hybridContractListQuery = z
  .object({ page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) })
  .strict()
export const hybridSelectionBody = z
  .object({
    expectedRevision: z.number().int().positive(),
    featureCodes: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
      .max(100)
      .nullable(),
  })
  .strict()
const stale = () => new ConflictError('El contrato cambió. Recarga sus condiciones antes de continuar.', 'HYBRID_CONTRACT_STALE')
const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> => {
  const result = schema.safeParse(value)
  if (!result.success) {
    // The owner's own reason/comment get their field's message; any other shape error is a stale or tampered request.
    const owner = result.error.issues.find(issue => issue.path[0] === 'reason' || issue.path[0] === 'comment')
    throw new BadRequestError(owner?.message ?? 'Revisa la selección y versión del contrato.', 'HYBRID_CONTRACT_INVALID')
  }
  return result.data
}
function hybridContractView(
  row: Prisma.HybridContractGetPayload<{ include: { publication: true; purchase: { select: { lastIssue: true } } } }>,
) {
  const definition = hybridOfferDefinition.parse(row.publication.definition)
  return {
    id: row.id,
    purchaseId: row.purchaseId,
    name: row.publication.name,
    kind: definition.kind,
    planTier: row.planTier,
    featureCodes: row.featureCodes,
    definition,
    price: definition.terms.price,
    startsAt: row.startsAt,
    paidThrough: row.paidThrough,
    cancelAt: row.cancelAt,
    endedAt: row.endedAt,
    revision: row.revision,
    pendingFeatureCodes: row.pendingFeatureCodes,
    pendingEffectiveAt: row.pendingEffectiveAt,
    paymentIssue: row.purchase?.lastIssue ?? null,
  }
}

export async function getHybridContract(venueId: string, contractId: string) {
  const contract = await prisma.hybridContract.findUnique({
    where: { id: contractId, venueId },
    include: { publication: true, purchase: { select: { lastIssue: true } } },
  })
  if (!contract) throw new NotFoundError('Contrato no encontrado.')
  return hybridContractView(contract)
}

export async function listHybridContracts(venueId: string, input: unknown) {
  const { page, pageSize } = parse(hybridContractListQuery, input)
  const where = { venueId }
  const [total, rows] = await Promise.all([
    prisma.hybridContract.count({ where }),
    prisma.hybridContract.findMany({
      where,
      include: { publication: true, purchase: { select: { lastIssue: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
  ])
  return {
    total,
    page,
    pageSize,
    items: rows.map(hybridContractView),
  }
}

/** Changes only the next paid period; invoice delivery freezes each period's selection separately. */
export async function scheduleHybridSelection(venueId: string, contractId: string, staffId: string, input: unknown) {
  const body = parse(hybridSelectionBody, input)
  return prisma.$transaction(async tx => {
    const [lock] = await tx.$queryRaw<
      { taken: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtext(${`stripe-obligaciones:${venueId}`})) AS taken`
    if (!lock?.taken) throw stale()
    const contract = await tx.hybridContract.findUnique({ where: { id: contractId, venueId }, include: { publication: true } })
    if (!contract) throw new NotFoundError('Contrato no encontrado.')
    if (contract.revision !== body.expectedRevision) throw stale()
    if (
      contract.endedAt ||
      contract.cancelAt ||
      !contract.paidThrough ||
      contract.paidThrough <= new Date() ||
      (contract.pendingEffectiveAt && contract.pendingEffectiveAt <= new Date())
    )
      throw new ConflictError('Resuelve la renovación pendiente antes de cambiar la selección.', 'HYBRID_RENEWAL_PENDING')
    const pending = await tx.hybridPurchase.findFirst({
      where: { venueId, status: { notIn: ['QUOTED', 'COMPLETED', 'CANCELLED', 'EXPIRED'] } },
      select: { id: true },
    })
    const operation = await tx.hybridBillingOperation.findFirst({
      where: {
        purchaseId: contract.purchaseId,
        OR: [{ step: { startsWith: 'SCHEDULE_CONFIGURE:' } }, { step: { startsWith: 'SCHEDULE_CANCEL_CREATE:' } }],
        resultHash: null,
      },
      select: { id: true },
    })
    if (pending || operation)
      throw new ConflictError('Hay otro cambio pendiente. Retómalo antes de modificar este contrato.', 'HYBRID_PROVIDER_UNKNOWN')
    const definition = hybridOfferDefinition.parse(contract.publication.definition)
    if (definition.kind !== 'CHOICE_BUNDLE') throw new BadRequestError('Esta oferta tiene funciones fijas.', 'HYBRID_OFFER_FIXED_SELECTION')
    {
      const codes = FEATURE_CATALOG.flatMap(row => (row.featureCode ? [row.featureCode] : []))
      const [tier, grants, legacy, continuing] = await Promise.all([
        getVenueBaseTier(venueId, { legacyOnly: true }),
        tx.capabilityGrant.groupBy({
          by: ['featureCode'],
          where: {
            venueId,
            featureCode: { in: codes },
            revokedAt: null,
            startsAt: { lte: contract.paidThrough },
            endsAt: { gt: contract.paidThrough },
            OR: [{ contractId: null }, { contractId: { not: contractId } }],
          },
          orderBy: { featureCode: 'asc' },
          take: codes.length,
        }),
        tx.venueFeature.findMany({
          where: { venueId, active: true, suspendedAt: null, OR: [{ endDate: null }, { endDate: { gt: contract.paidThrough } }] },
          select: { feature: { select: { code: true } } },
          orderBy: { id: 'asc' },
          take: 201,
        }),
        tx.hybridContract.findMany({
          where: {
            venueId,
            id: { not: contractId },
            endedAt: null,
            startsAt: { lte: contract.paidThrough },
            paidThrough: { not: null },
            OR: [{ cancelAt: null }, { cancelAt: { gt: contract.paidThrough } }],
            purchase: { status: 'COMPLETED' },
          },
          select: { featureCodes: true, pendingFeatureCodes: true, pendingEffectiveAt: true },
          orderBy: { id: 'asc' },
          take: 201,
        }),
      ])
      if (legacy.length > 200 || continuing.length > 200)
        throw new ConflictError('No pudimos revisar todos los accesos.', 'HYBRID_ACCESS_UNVERIFIED')
      // Paid grants stop at the boundary; renewing commercial commitments continue beyond it.
      const continuingCodes = continuing.flatMap(row => {
        if (!row.pendingEffectiveAt || !Array.isArray(row.pendingFeatureCodes)) return row.featureCodes
        const pending = row.pendingFeatureCodes.filter((code): code is string => typeof code === 'string')
        return row.pendingEffectiveAt <= contract.paidThrough! ? pending : [...row.featureCodes, ...pending]
      })
      const included = [
        ...new Set([
          ...grants.map(g => g.featureCode),
          ...legacy.map(row => row.feature.code).filter(code => codes.includes(code)),
          ...continuingCodes,
        ]),
      ]
      const preview = previewHybridOffer({
        offer: definition,
        selectedFeatureCodes: body.featureCodes ?? contract.featureCodes,
        scenario: { planTier: tier ?? 'FREE', grantedFeatureCodes: included },
      })
      if (!preview.selection.valid)
        throw new BadRequestError(preview.selection.issues.map(issue => issue.message).join(' '), 'HYBRID_OFFER_COMPOSITION')
    }
    const selected = body.featureCodes?.slice().sort() ?? null
    const changed = await tx.hybridContract.updateMany({
      where: { id: contractId, venueId, revision: body.expectedRevision },
      data: {
        pendingFeatureCodes: selected ?? Prisma.DbNull,
        pendingEffectiveAt: selected ? contract.paidThrough : null,
        revision: { increment: 1 },
      },
    })
    if (!changed.count) throw stale()
    await tx.activityLog.create({
      data: {
        venueId,
        staffId,
        entity: 'HybridContract',
        entityId: contractId,
        action: selected ? 'HYBRID_SELECTION_SCHEDULED' : 'HYBRID_SELECTION_WITHDRAWN',
        data: { featureCodes: selected, effectiveAt: selected ? contract.paidThrough.toISOString() : null },
      },
    })
    return {
      contractId,
      revision: contract.revision + 1,
      pendingFeatureCodes: selected,
      effectiveAt: selected ? contract.paidThrough.toISOString() : null,
    }
  })
}

import type Stripe from 'stripe'
import { stripe, STRIPE_DENTRO_DEL_CANDADO as stripeOptions } from '@/services/stripe.service'
import { hybridHash, recordedStripeWrite } from './hybridProvider'
import { buildHybridCancellationPhases, hybridScheduleReceipt } from './hybridSchedule'
import logger from '@/config/logger'
import {
  cancellationAuditData,
  cancellationFields,
  toStripeCancellationDetails,
  type CancellationInput,
} from '@/services/shared/cancellationReason'
export const hybridCancellationBody = z.object({ expectedRevision: z.number().int().positive(), ...cancellationFields }).strict()

/**
 * The reason an attempt carries. Once an attempt is saved, its reason wins (even "none", for attempts saved before
 * reasons existed): the recovery replays with only expectedRevision and the saved request must hash the same.
 */
export function cancellationForAttempt(body: CancellationInput, saved: unknown[]): CancellationInput | undefined {
  const first = saved.find(request => request != null) as { cancellation?: CancellationInput } | undefined
  if (first) return first.cancellation
  const given = cancellationAuditData(body)
  return given.reason || given.comment ? given : undefined
}
const idOf = (value: string | { id: string } | null | undefined) => (typeof value === 'string' ? value : value?.id)

export async function cancelHybridContract(venueId: string, contractId: string, staffId: string, input: unknown) {
  const body = parse(hybridCancellationBody, input)
  const deadline = Date.now() + 120000
  const outcome = await prisma.$transaction(
    async tx => {
      const [lock] = await tx.$queryRaw<
        { taken: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtext(${`stripe-obligaciones:${venueId}`})) AS taken`
      if (!lock?.taken) throw stale()
      const contract = await tx.hybridContract.findUnique({
        where: { id: contractId, venueId },
        include: { publication: true, purchase: true },
      })
      if (!contract) throw new NotFoundError('Contrato no encontrado.')
      if (contract.cancelAt)
        return {
          contractId,
          revision: contract.revision,
          cancelAt: contract.cancelAt.toISOString(),
          endsSubscription: false as boolean,
          subscriptionId: contract.stripeSubscriptionId,
          cancellation: undefined as CancellationInput | undefined,
        }
      if (
        contract.revision !== body.expectedRevision ||
        contract.endedAt ||
        !contract.paidThrough ||
        contract.purchase.status !== 'COMPLETED'
      )
        throw stale()
      const [deliveryLock] = await tx.$queryRaw<
        { taken: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtext(${`hybrid-delivery:${contract.purchaseId}`})) AS taken`
      if (!deliveryLock?.taken) throw new ConflictError('Estamos revisando un pago. Inténtalo en un momento.', 'HYBRID_PROVIDER_UNKNOWN')
      const pending = await tx.hybridPurchase.findFirst({
        where: { venueId, status: { notIn: ['QUOTED', 'COMPLETED', 'CANCELLED', 'EXPIRED'] } },
        select: { id: true },
      })
      if (pending) throw new ConflictError('Resuelve primero la compra pendiente.', 'HYBRID_PROVIDER_UNKNOWN')
      const step = `SCHEDULE_CONFIGURE:${contractId}:${body.expectedRevision}`
      const createStep = `SCHEDULE_CANCEL_CREATE:${contractId}:${body.expectedRevision}`
      const unfinished = await tx.hybridBillingOperation.findFirst({
        where: {
          purchaseId: contract.purchaseId,
          OR: [{ step: { startsWith: 'SCHEDULE_CONFIGURE:' } }, { step: { startsWith: 'SCHEDULE_CANCEL_CREATE:' } }],
          step: { notIn: [step, createStep] },
          resultHash: null,
        },
        select: { id: true },
      })
      if (unfinished)
        throw new ConflictError('Hay otra cancelación pendiente. Retómala antes de cambiar este contrato.', 'HYBRID_PROVIDER_UNKNOWN')
      const savedOperation = await tx.hybridBillingOperation.findUnique({
        where: { purchaseId_step: { purchaseId: contract.purchaseId, step } },
      })
      const savedCreate = await tx.hybridBillingOperation.findUnique({
        where: { purchaseId_step: { purchaseId: contract.purchaseId, step: createStep } },
      })
      const cancellation = cancellationForAttempt(body, [savedCreate?.request, savedOperation?.request])
      const sub = await stripe.subscriptions.retrieve(contract.stripeSubscriptionId, {}, stripeOptions)
      const certify = (schedule: Stripe.SubscriptionSchedule) => {
        if (idOf(schedule.customer) !== contract.purchase.stripeCustomerId || idOf(schedule.subscription) !== sub.id) throw stale()
        return schedule
      }
      if (
        idOf(sub.customer) !== contract.purchase.stripeCustomerId ||
        sub.metadata.hybridPurchaseId !== contract.purchaseId ||
        sub.items.has_more ||
        !['active', 'past_due'].includes(sub.status)
      )
        throw stale()
      const effectiveAt = contract.paidThrough.getTime() / 1000
      if (!savedOperation && (effectiveAt <= Date.now() / 1000 || sub.pending_update))
        throw new ConflictError('Resuelve la renovación pendiente antes de cancelar.', 'HYBRID_RENEWAL_PENDING')
      const schedule = await recordedStripeWrite(
        contract.purchaseId,
        createStep,
        { from_subscription: sub.id, ...(cancellation ? { cancellation } : {}) },
        async (saved, idempotencyKey) =>
          certify(
            await stripe.subscriptionSchedules.create({ from_subscription: saved.from_subscription }, { ...stripeOptions, idempotencyKey }),
          ),
        async providerId => {
          const live = await stripe.subscriptions.retrieve(sub.id, {}, stripeOptions)
          const scheduleId = providerId ?? idOf(live.schedule)
          return scheduleId ? certify(await stripe.subscriptionSchedules.retrieve(scheduleId, {}, stripeOptions)) : null
        },
      )
      type Request = {
        scheduleId: string
        effectiveAt: number
        params: Stripe.SubscriptionScheduleUpdateParams
        cancellation?: CancellationInput
      }
      let request: Request
      if (savedOperation) request = savedOperation.request as unknown as Request
      else {
        const prior = await tx.hybridBillingOperation.findFirst({
          where: { purchaseId: contract.purchaseId, step: { startsWith: 'SCHEDULE_CONFIGURE' }, resultHash: { not: null } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
        if (prior && prior.resultHash !== hybridScheduleReceipt(schedule)) throw stale()
        if (
          !prior &&
          schedule.phases.some(
            phase =>
              phase.discounts?.length ||
              phase.default_tax_rates?.length ||
              phase.automatic_tax?.enabled ||
              phase.items.some(item => item.discounts?.length || item.tax_rates?.length),
          )
        )
          throw stale()
        const recipe = buildHybridCancellationPhases(
          schedule,
          Math.floor(Date.now() / 1000),
          effectiveAt,
          [contract.publication.stripePriceId!, contract.publication.stripeRenewalPriceId!].filter(Boolean),
        )
        request = {
          scheduleId: schedule.id,
          effectiveAt,
          params: {
            ...recipe,
            proration_behavior: 'none',
            metadata: {
              hybridPurchaseId: contract.purchaseId,
              venueId,
              changeHash: hybridHash({ contractId, revision: body.expectedRevision, recipe }),
            },
          },
          ...(cancellation ? { cancellation } : {}),
        }
      }
      const hash = (request.params.metadata as Record<string, string>).changeHash
      const configured = await recordedStripeWrite(
        contract.purchaseId,
        step,
        request,
        async (saved, idempotencyKey) =>
          certify(await stripe.subscriptionSchedules.update(saved.scheduleId, saved.params, { ...stripeOptions, idempotencyKey })),
        async () => {
          const live = certify(await stripe.subscriptionSchedules.retrieve(request.scheduleId, {}, stripeOptions))
          return live.metadata?.changeHash === hash ? live : null
        },
      )
      if (configured.metadata?.changeHash !== hash || Date.now() >= deadline) throw stale()
      const changed = await tx.hybridContract.updateMany({
        where: { id: contractId, venueId, revision: body.expectedRevision },
        data: {
          cancelAt: new Date(request.effectiveAt * 1000),
          pendingFeatureCodes: Prisma.DbNull,
          pendingEffectiveAt: null,
          revision: { increment: 1 },
        },
      })
      if (!changed.count) throw stale()
      await tx.hybridBillingOperation.update({
        where: { purchaseId_step: { purchaseId: contract.purchaseId, step } },
        data: { resultHash: hybridScheduleReceipt(configured) },
      })
      await tx.hybridBillingOperation.update({
        where: { purchaseId_step: { purchaseId: contract.purchaseId, step: createStep } },
        data: { resultHash: hybridScheduleReceipt(configured) },
      })
      await tx.activityLog.create({
        data: {
          venueId,
          staffId,
          entity: 'HybridContract',
          entityId: contractId,
          action: 'HYBRID_RENEWAL_CANCELLED',
          data: { cancelAt: new Date(request.effectiveAt * 1000).toISOString(), ...(request.cancellation ?? {}) },
        },
      })
      return {
        contractId,
        revision: contract.revision + 1,
        cancelAt: new Date(request.effectiveAt * 1000).toISOString(),
        endsSubscription: request.params.end_behavior === 'cancel',
        subscriptionId: sub.id,
        cancellation: request.cancellation,
      }
    },
    { timeout: 150000, maxWait: 5000 },
  )
  // Stripe hears the reason only when this cancellation ends the whole subscription (other contracts may keep it alive).
  // Best effort after the commit: the audit row above is the record; a refused update never undoes the cancellation.
  const details = outcome.cancellation && toStripeCancellationDetails(outcome.cancellation)
  if (outcome.endsSubscription && details) {
    try {
      await stripe.subscriptions.update(
        outcome.subscriptionId,
        { cancellation_details: details },
        { ...stripeOptions, idempotencyKey: `hybrid-cancel-reason:${contractId}:${body.expectedRevision}` },
      )
    } catch (error) {
      logger.warn('Hybrid contract cancelled; Stripe did not take the reason (kept in ActivityLog)', {
        venueId,
        contractId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }
  return { contractId: outcome.contractId, revision: outcome.revision, cancelAt: outcome.cancelAt }
}
