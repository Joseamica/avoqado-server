import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

export type CommercialLifecycleEventType =
  | 'CHECKOUT_COMPLETED'
  | 'INVOICE_PAID'
  | 'INVOICE_FAILED'
  | 'SUBSCRIPTION_CANCELED'
  | 'REFUND_SUCCEEDED'
  | 'PARTIAL_REFUND'
  | 'DISPUTE_OPENED'
  | 'DISPUTE_WON'
  | 'DISPUTE_LOST'

export type CommercialAcceptanceStatus = 'ACCEPTED' | 'STRIPE_PENDING' | 'ACTIVE' | 'FAILED' | 'CANCELED' | 'REFUNDED' | 'DISPUTED'

export interface CommercialLifecycleEvent {
  stripeEventId: string
  type: CommercialLifecycleEventType
  effectiveAt: Date
  acceptanceId?: string
  stripeCheckoutSessionId?: string
  stripeSubscriptionId?: string
}

interface LockedAcceptance {
  id: string
  organizationId: string
  venueId: string
  status: CommercialAcceptanceStatus
  revision: number
  lastStripeEventId: string | null
  lastStripeEventCreatedAt: Date | null
  quoteSchemaVersion: number
  offerVersionId: string | null
}

interface StoredLifecycleEvent {
  stripeEventId: string
  acceptanceId: string
  applied: boolean
  toStatus: CommercialAcceptanceStatus
}

interface CommercialLifecycleTransaction {
  findEvent(stripeEventId: string): Promise<StoredLifecycleEvent | null>
  lockAcceptance(reference: {
    acceptanceId?: string
    stripeCheckoutSessionId?: string
    stripeSubscriptionId?: string
  }): Promise<LockedAcceptance | null>
  createEvent(input: {
    acceptanceId: string
    stripeEventId: string
    type: CommercialLifecycleEventType
    effectiveAt: Date
    fromStatus: CommercialAcceptanceStatus
    toStatus: CommercialAcceptanceStatus
    applied: boolean
    stripeCheckoutSessionId?: string
    stripeSubscriptionId?: string
  }): Promise<StoredLifecycleEvent>
  updateAcceptance(input: {
    acceptanceId: string
    status: CommercialAcceptanceStatus
    lastStripeEventId: string
    lastStripeEventCreatedAt: Date
  }): Promise<LockedAcceptance>
  bindStripeReferences(input: { acceptanceId: string; stripeCheckoutSessionId?: string; stripeSubscriptionId?: string }): Promise<void>
  writeAudit(input: {
    action: string
    acceptanceId: string
    organizationId: string
    venueId: string
    stripeEventId: string
    type: CommercialLifecycleEventType
    fromStatus: CommercialAcceptanceStatus
    toStatus: CommercialAcceptanceStatus
  }): Promise<void>
}

interface CommercialLifecycleRepository {
  runInTransaction<T>(operation: (tx: CommercialLifecycleTransaction) => Promise<T>): Promise<T>
}

function lifecycleError(code: string, message: string, statusCode = 422): AppError {
  return new AppError(message, statusCode, true, code)
}

function validateEvent(event: CommercialLifecycleEvent): void {
  const referenceCount = [event.acceptanceId, event.stripeCheckoutSessionId, event.stripeSubscriptionId].filter(
    value => typeof value === 'string' && value.length > 0,
  ).length
  if (!/^evt_[A-Za-z0-9_:-]{3,250}$/.test(event.stripeEventId) || !Number.isFinite(event.effectiveAt.getTime()) || referenceCount === 0) {
    throw lifecycleError('COMMERCIAL_STRIPE_EVENT_INVALID', 'El evento comercial de Stripe no es válido.')
  }
}

function desiredStatus(current: CommercialAcceptanceStatus, type: CommercialLifecycleEventType): CommercialAcceptanceStatus {
  if (current === 'REFUNDED') return 'REFUNDED'
  if (current === 'CANCELED') return type === 'REFUND_SUCCEEDED' ? 'REFUNDED' : 'CANCELED'
  if (
    current === 'DISPUTED' &&
    !['DISPUTE_WON', 'DISPUTE_LOST', 'REFUND_SUCCEEDED', 'INVOICE_FAILED', 'SUBSCRIPTION_CANCELED'].includes(type)
  ) {
    return 'DISPUTED'
  }
  switch (type) {
    case 'CHECKOUT_COMPLETED':
    case 'INVOICE_PAID':
      return 'ACTIVE'
    case 'DISPUTE_WON':
      return current === 'DISPUTED' ? 'ACTIVE' : current
    case 'INVOICE_FAILED':
      return 'FAILED'
    case 'SUBSCRIPTION_CANCELED':
      return 'CANCELED'
    case 'REFUND_SUCCEEDED':
      return 'REFUNDED'
    case 'PARTIAL_REFUND':
      return current
    case 'DISPUTE_OPENED':
    case 'DISPUTE_LOST':
      return 'DISPUTED'
  }
}

function transitionAllowed(current: CommercialAcceptanceStatus, type: CommercialLifecycleEventType): boolean {
  if (current === 'REFUNDED') return false
  if (current === 'CANCELED') return type === 'REFUND_SUCCEEDED'
  if (current === 'DISPUTED') {
    return ['DISPUTE_WON', 'DISPUTE_LOST', 'REFUND_SUCCEEDED', 'INVOICE_FAILED', 'SUBSCRIPTION_CANCELED'].includes(type)
  }
  // FAILED is an independent loss-of-access state. A later dispute event may
  // still be recorded in the immutable ledger, but it cannot replace that
  // state and a subsequent dispute win must never restore access.
  if (current === 'FAILED' && ['DISPUTE_OPENED', 'DISPUTE_WON', 'DISPUTE_LOST'].includes(type)) return false
  return true
}

function eventPrecedence(type: CommercialLifecycleEventType): number {
  switch (type) {
    case 'CHECKOUT_COMPLETED':
    case 'INVOICE_PAID':
    case 'DISPUTE_WON':
      return 10
    case 'PARTIAL_REFUND':
      return 20
    case 'INVOICE_FAILED':
      // A failed renewal removes access independently from a dispute. It must
      // beat DISPUTED (40) when Stripe emits both events in the same second.
      return 45
    case 'DISPUTE_OPENED':
    case 'DISPUTE_LOST':
      return 40
    case 'SUBSCRIPTION_CANCELED':
      return 50
    case 'REFUND_SUCCEEDED':
      return 60
  }
}

function statusPrecedence(status: CommercialAcceptanceStatus): number {
  switch (status) {
    case 'ACCEPTED':
    case 'STRIPE_PENDING':
      return 0
    case 'ACTIVE':
      return 10
    case 'FAILED':
      return 30
    case 'DISPUTED':
      return 40
    case 'CANCELED':
      return 50
    case 'REFUNDED':
      return 60
  }
}

function newerThanLast(event: CommercialLifecycleEvent, acceptance: LockedAcceptance): boolean {
  if (!acceptance.lastStripeEventCreatedAt) return true
  const difference = event.effectiveAt.getTime() - acceptance.lastStripeEventCreatedAt.getTime()
  if (difference !== 0) return difference > 0
  // Stripe event ids are opaque and are not an ordering primitive. Its created
  // timestamp is second-granularity, so ties use a conservative business
  // precedence: risk-reducing states beat access-granting states.
  return eventPrecedence(event.type) > statusPrecedence(acceptance.status)
}

export function createCommercialSubscriptionLifecycleService(dependencies: { repository: CommercialLifecycleRepository }) {
  return {
    async reconcile(
      event: CommercialLifecycleEvent,
    ): Promise<
      | { matched: false; applied: false }
      | { matched: true; applied: boolean; status: CommercialAcceptanceStatus; duplicate?: true; stale?: true }
    > {
      validateEvent(event)
      return dependencies.repository.runInTransaction(async tx => {
        const duplicate = await tx.findEvent(event.stripeEventId)
        if (duplicate) {
          return { matched: true, applied: false, duplicate: true, status: duplicate.toStatus }
        }
        const acceptance = await tx.lockAcceptance({
          acceptanceId: event.acceptanceId,
          stripeCheckoutSessionId: event.stripeCheckoutSessionId,
          stripeSubscriptionId: event.stripeSubscriptionId,
        })
        if (!acceptance) return { matched: false, applied: false }
        if (acceptance.quoteSchemaVersion !== 2 || acceptance.offerVersionId !== null) {
          return { matched: false, applied: false }
        }

        const isNewer = newerThanLast(event, acceptance)
        const nextStatus = isNewer ? desiredStatus(acceptance.status, event.type) : acceptance.status
        const applied = isNewer && transitionAllowed(acceptance.status, event.type)

        await tx.createEvent({
          acceptanceId: acceptance.id,
          stripeEventId: event.stripeEventId,
          type: event.type,
          effectiveAt: event.effectiveAt,
          fromStatus: acceptance.status,
          toStatus: applied ? nextStatus : acceptance.status,
          applied,
          stripeCheckoutSessionId: event.stripeCheckoutSessionId,
          stripeSubscriptionId: event.stripeSubscriptionId,
        })
        if (!applied) {
          return {
            matched: true,
            applied: false,
            ...(isNewer ? {} : { stale: true as const }),
            status: acceptance.status,
          }
        }

        await tx.bindStripeReferences({
          acceptanceId: acceptance.id,
          stripeCheckoutSessionId: event.stripeCheckoutSessionId,
          stripeSubscriptionId: event.stripeSubscriptionId,
        })
        const updated = await tx.updateAcceptance({
          acceptanceId: acceptance.id,
          status: nextStatus,
          lastStripeEventId: event.stripeEventId,
          lastStripeEventCreatedAt: event.effectiveAt,
        })
        await tx.writeAudit({
          action: `COMMERCIAL_SUBSCRIPTION_${nextStatus}`,
          acceptanceId: acceptance.id,
          organizationId: acceptance.organizationId,
          venueId: acceptance.venueId,
          stripeEventId: event.stripeEventId,
          type: event.type,
          fromStatus: acceptance.status,
          toStatus: nextStatus,
        })
        return { matched: true, applied: true, status: updated.status }
      })
    },
  }
}

export const prismaCommercialLifecycleRepository: CommercialLifecycleRepository = {
  runInTransaction: operation =>
    prisma.$transaction(async prismaTx => {
      const tx: CommercialLifecycleTransaction = {
        findEvent: stripeEventId => prismaTx.commercialSubscriptionEvent.findUnique({ where: { stripeEventId } }),
        async lockAcceptance(reference) {
          let acceptanceId = reference.acceptanceId
          if (!acceptanceId) {
            const stripeOperation = await prismaTx.commercialStripeOperation.findFirst({
              where: {
                OR: [
                  ...(reference.stripeCheckoutSessionId ? [{ stripeCheckoutSessionId: reference.stripeCheckoutSessionId }] : []),
                  ...(reference.stripeSubscriptionId ? [{ stripeSubscriptionId: reference.stripeSubscriptionId }] : []),
                ],
              },
              select: { acceptanceId: true },
            })
            acceptanceId = stripeOperation?.acceptanceId
          }
          if (!acceptanceId) return null
          const rows = await prismaTx.$queryRaw<LockedAcceptance[]>`
          SELECT acceptance."id", acceptance."organizationId", acceptance."venueId",
                 acceptance."status", acceptance."revision", acceptance."lastStripeEventId",
                 acceptance."lastStripeEventCreatedAt", quote."schemaVersion" AS "quoteSchemaVersion",
                 quote."offerVersionId"
          FROM "CommercialQuoteAcceptance" acceptance
          JOIN "CommercialQuote" quote ON quote."id" = acceptance."quoteId"
          WHERE acceptance."id" = ${acceptanceId}
          FOR UPDATE OF acceptance
        `
          return rows[0] ?? null
        },
        createEvent: input => prismaTx.commercialSubscriptionEvent.create({ data: input }),
        updateAcceptance: input =>
          prismaTx.commercialQuoteAcceptance.update({
            where: { id: input.acceptanceId },
            data: {
              status: input.status,
              revision: { increment: 1 },
              lastStripeEventId: input.lastStripeEventId,
              lastStripeEventCreatedAt: input.lastStripeEventCreatedAt,
            },
          }) as unknown as Promise<LockedAcceptance>,
        async bindStripeReferences(input) {
          const stripeOperation = await prismaTx.commercialStripeOperation.findUnique({
            where: { acceptanceId_type: { acceptanceId: input.acceptanceId, type: 'CHECKOUT_SESSION' } },
          })
          if (!stripeOperation) {
            throw lifecycleError('COMMERCIAL_STRIPE_OPERATION_NOT_FOUND', 'No existe la operación Stripe de la aceptación.', 500)
          }
          if (
            (input.stripeCheckoutSessionId &&
              stripeOperation.stripeCheckoutSessionId &&
              input.stripeCheckoutSessionId !== stripeOperation.stripeCheckoutSessionId) ||
            (input.stripeSubscriptionId &&
              stripeOperation.stripeSubscriptionId &&
              input.stripeSubscriptionId !== stripeOperation.stripeSubscriptionId)
          ) {
            throw lifecycleError('COMMERCIAL_STRIPE_REFERENCE_CONFLICT', 'El evento Stripe no coincide con la operación comercial.', 409)
          }
          await prismaTx.commercialStripeOperation.update({
            where: { id: stripeOperation.id },
            data: {
              stripeCheckoutSessionId: stripeOperation.stripeCheckoutSessionId ?? input.stripeCheckoutSessionId,
              stripeSubscriptionId: stripeOperation.stripeSubscriptionId ?? input.stripeSubscriptionId,
            },
          })
        },
        async writeAudit(input) {
          await prismaTx.activityLog.create({
            data: {
              organizationId: input.organizationId,
              venueId: input.venueId,
              actorType: 'SERVICE',
              servicePrincipalId: 'STRIPE_COMMERCIAL_WEBHOOK',
              action: input.action,
              entity: 'CommercialQuoteAcceptance',
              entityId: input.acceptanceId,
              data: {
                stripeEventId: input.stripeEventId,
                type: input.type,
                fromStatus: input.fromStatus,
                toStatus: input.toStatus,
              },
            },
          })
        },
      }
      return operation(tx)
    }),
}

export const commercialSubscriptionLifecycleService = createCommercialSubscriptionLifecycleService({
  repository: prismaCommercialLifecycleRepository,
})
