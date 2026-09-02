import { randomUUID } from 'node:crypto'
import AppError from '@/errors/AppError'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import type { CommercialQuoteV1 } from '@/types/commercialQuote'
import prisma from '@/utils/prismaClient'

export interface CommercialStripeGateway {
  createCheckoutSession(input: {
    acceptanceId: string
    quoteId: string
    organizationId: string
    venueId: string
    idempotencyKey: string
    frozenQuote: unknown
  }): Promise<{ checkoutSessionId: string; checkoutUrl: string }>
}

interface AcceptedQuoteRecord {
  id: string
  quoteId: string
  organizationId: string
  venueId: string
  status: string
  revision: number
  quote: { schemaVersion: number; offerVersionId: string | null; snapshot: unknown; checksum: string }
}

interface StripeOperationRecord {
  id: string
  acceptanceId: string
  type: 'CHECKOUT_SESSION'
  status: 'PENDING' | 'SUCCEEDED' | 'OUTCOME_UNKNOWN' | 'FAILED'
  idempotencyKey: string
  requestFingerprint: string
  stripeCheckoutSessionId?: string | null
  stripeCheckoutUrl?: string | null
}

interface ReserveStripeOperationInput {
  id: string
  acceptanceId: string
  type: 'CHECKOUT_SESSION'
  idempotencyKey: string
  requestFingerprint: string
}

export interface CommercialStripeCheckoutRepository {
  loadAcceptance(id: string): Promise<AcceptedQuoteRecord | null>
  reserveOperation(input: ReserveStripeOperationInput): Promise<StripeOperationRecord>
  markSucceeded(id: string, result: { stripeCheckoutSessionId: string; stripeCheckoutUrl: string }): Promise<StripeOperationRecord>
  markOutcomeUnknown(id: string, message: string): Promise<void>
  markFailed(id: string, message: string): Promise<void>
}

interface CommercialStripeCheckoutDependencies {
  repository: CommercialStripeCheckoutRepository
  gateway: CommercialStripeGateway
  assertCheckoutAllowed: () => void
  randomId?: () => string
}

function stripeError(code: string, message: string, statusCode = 409): AppError {
  return new AppError(message, statusCode, true, code)
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Stripe request failed with an unknown outcome'
  return message.slice(0, 1000)
}

function completedCheckout(operation: StripeOperationRecord): { checkoutSessionId: string; checkoutUrl: string } | null {
  return operation.status === 'SUCCEEDED' && operation.stripeCheckoutSessionId && operation.stripeCheckoutUrl
    ? { checkoutSessionId: operation.stripeCheckoutSessionId, checkoutUrl: operation.stripeCheckoutUrl }
    : null
}

const DETERMINISTIC_GATEWAY_ERRORS = new Set([
  'COMMERCIAL_STRIPE_QUOTE_INVALID',
  'COMMERCIAL_STRIPE_QUOTE_NOT_REPRESENTABLE',
  'COMMERCIAL_STRIPE_BILLING_SCOPE_MISMATCH',
  'COMMERCIAL_STRIPE_BILLING_EMAIL_REQUIRED',
  'COMMERCIAL_STRIPE_NOT_CONFIGURED',
])

function isDeterministicGatewayError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && DETERMINISTIC_GATEWAY_ERRORS.has(String(error.code))
}

export function createCommercialStripeCheckoutService(dependencies: CommercialStripeCheckoutDependencies) {
  const randomId = dependencies.randomId ?? randomUUID
  return {
    async createCheckout(input: { acceptanceId: string; organizationId: string; venueId: string }): Promise<{
      checkoutSessionId: string
      checkoutUrl: string
    }> {
      dependencies.assertCheckoutAllowed()
      if (!input.acceptanceId || !input.organizationId || !input.venueId) {
        throw stripeError('COMMERCIAL_STRIPE_INPUT_INVALID', 'La solicitud de checkout no es válida.', 422)
      }
      const acceptance = await dependencies.repository.loadAcceptance(input.acceptanceId)
      if (!acceptance) throw stripeError('COMMERCIAL_STRIPE_ACCEPTANCE_NOT_FOUND', 'La aceptación no existe.', 404)
      if (acceptance.organizationId !== input.organizationId || acceptance.venueId !== input.venueId) {
        throw stripeError('COMMERCIAL_STRIPE_SCOPE_MISMATCH', 'La aceptación no pertenece a esta organización.', 403)
      }
      if (acceptance.quote.schemaVersion !== 2 || acceptance.quote.offerVersionId !== null) {
        throw stripeError(
          'COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED',
          'Esta versión de la cotización requiere el flujo comercial nuevo.',
        )
      }
      if (!['ACCEPTED', 'STRIPE_PENDING', 'FAILED'].includes(acceptance.status)) {
        throw stripeError('COMMERCIAL_STRIPE_ACCEPTANCE_NOT_PAYABLE', 'La aceptación no admite un nuevo checkout.')
      }
      const parsedQuote = acceptance.quote.snapshot as Partial<CommercialQuoteV1>
      if (parsedQuote.quoteId !== acceptance.quoteId || parsedQuote.schemaVersion !== 1) {
        throw stripeError('COMMERCIAL_STRIPE_QUOTE_INVALID', 'La cotización congelada no coincide con su aceptación.', 500)
      }
      const idempotencyKey = `commercial:${acceptance.id}:checkout-session`
      const requestFingerprint = hashCanonicalJsonV1('commercial-stripe-checkout-v1', {
        acceptanceId: acceptance.id,
        quoteId: acceptance.quoteId,
        quoteChecksum: acceptance.quote.checksum,
      })
      const operation = await dependencies.repository.reserveOperation({
        id: randomId(),
        acceptanceId: acceptance.id,
        type: 'CHECKOUT_SESSION',
        idempotencyKey,
        requestFingerprint,
      })
      if (operation.requestFingerprint !== requestFingerprint || operation.idempotencyKey !== idempotencyKey) {
        throw stripeError('COMMERCIAL_STRIPE_IDEMPOTENCY_CONFLICT', 'La operación Stripe existente no corresponde a esta cotización.', 500)
      }
      const completed = completedCheckout(operation)
      if (completed) return completed
      try {
        const result = await dependencies.gateway.createCheckoutSession({
          acceptanceId: acceptance.id,
          quoteId: acceptance.quoteId,
          organizationId: acceptance.organizationId,
          venueId: acceptance.venueId,
          idempotencyKey,
          frozenQuote: acceptance.quote.snapshot,
        })
        const saved = await dependencies.repository.markSucceeded(operation.id, {
          stripeCheckoutSessionId: result.checkoutSessionId,
          stripeCheckoutUrl: result.checkoutUrl,
        })
        return completedCheckout(saved) ?? result
      } catch (error) {
        const message = safeErrorMessage(error)
        if (isDeterministicGatewayError(error)) {
          await dependencies.repository.markFailed(operation.id, message)
          throw error
        }
        await dependencies.repository.markOutcomeUnknown(operation.id, message)
        throw stripeError(
          'COMMERCIAL_STRIPE_OUTCOME_UNKNOWN',
          'Stripe no confirmó el resultado. Reintentar reutilizará la misma operación sin duplicar el cobro.',
          503,
        )
      }
    },
  }
}

export const prismaCommercialStripeCheckoutRepository: CommercialStripeCheckoutRepository = {
  loadAcceptance: id =>
    prisma.commercialQuoteAcceptance.findUnique({
      where: { id },
      include: { quote: { select: { schemaVersion: true, offerVersionId: true, snapshot: true, checksum: true } } },
    }),
  async reserveOperation(input) {
    return prisma.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "CommercialQuoteAcceptance" WHERE "id" = ${input.acceptanceId} FOR UPDATE
      `
      if (locked.length === 0) throw stripeError('COMMERCIAL_STRIPE_ACCEPTANCE_NOT_FOUND', 'La aceptación no existe.', 404)
      const acceptance = await tx.commercialQuoteAcceptance.findUniqueOrThrow({ where: { id: input.acceptanceId } })
      const existing = await tx.commercialStripeOperation.findUnique({
        where: { acceptanceId_type: { acceptanceId: input.acceptanceId, type: input.type } },
      })
      if (existing) return existing as StripeOperationRecord
      const moved = await tx.commercialQuoteAcceptance.updateMany({
        where: { id: input.acceptanceId, revision: acceptance.revision, status: 'ACCEPTED' },
        data: { status: 'STRIPE_PENDING', revision: { increment: 1 } },
      })
      if (moved.count !== 1 && acceptance.status !== 'STRIPE_PENDING') {
        throw stripeError('COMMERCIAL_STRIPE_ACCEPTANCE_CONFLICT', 'La aceptación cambió antes de iniciar Stripe.')
      }
      return tx.commercialStripeOperation.create({ data: input }) as unknown as StripeOperationRecord
    })
  },
  markSucceeded: (id, result) =>
    prisma.$transaction(async tx => {
      const operation = await tx.commercialStripeOperation.update({
        where: { id },
        data: {
          status: 'SUCCEEDED',
          stripeCheckoutSessionId: result.stripeCheckoutSessionId,
          stripeCheckoutUrl: result.stripeCheckoutUrl,
          lastError: null,
        },
      })
      await tx.commercialQuoteAcceptance.updateMany({
        where: { id: operation.acceptanceId, status: { in: ['ACCEPTED', 'FAILED'] } },
        data: { status: 'STRIPE_PENDING', revision: { increment: 1 } },
      })
      return operation as unknown as StripeOperationRecord
    }),
  async markOutcomeUnknown(id, message) {
    await prisma.commercialStripeOperation.update({
      where: { id },
      data: { status: 'OUTCOME_UNKNOWN', lastError: message },
    })
  },
  async markFailed(id, message) {
    await prisma.$transaction(async tx => {
      const operation = await tx.commercialStripeOperation.update({
        where: { id },
        data: { status: 'FAILED', lastError: message },
        select: { acceptanceId: true },
      })
      await tx.commercialQuoteAcceptance.update({
        where: { id: operation.acceptanceId },
        data: { status: 'FAILED', revision: { increment: 1 } },
      })
    })
  },
}
