/**
 * Mercado Pago IPN (webhook) payment-flow handler.
 *
 * Pipeline:
 *   1. Atomic dedupe insert into MercadoPagoWebhookEvent. The unique
 *      constraint (mpUserId, dataId, requestId) means duplicate deliveries
 *      raise P2002 — we short-circuit on that.
 *   2. Resolve the seller's EcommerceMerchant via providerMerchantId == mpUserId.
 *   3. Load + decrypt the seller's access_token.
 *   4. Fetch the authoritative payment state from MP API (the IPN body is
 *      just a notification trigger; status truth comes from /v1/payments/:id).
 *   5. Find the CheckoutSession by external_reference (which we set to our
 *      CheckoutSession.sessionId at preference/payment creation time).
 *   6. Update CheckoutSession.mpPaymentId, mpMerchantOrderId, status, completedAt.
 *   7. Mark the webhook event row processed.
 *
 * All branches end by marking the webhook event's `processingStatus` so the
 * row serves as both dedupe key AND audit log.
 */
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { getPayment } from './payment.service'
import { loadCredentials } from './connection.service'
import type { MercadoPagoWebhookPayload } from './types'

export interface HandleIpnParams {
  payload: MercadoPagoWebhookPayload
  /** x-request-id from the IPN HTTP request — part of the dedupe key. */
  requestId: string
}

export type HandleIpnResult =
  | { status: 'processed'; checkoutSessionId: string; paymentId: string }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: string }
  | { status: 'error'; reason: string }

/**
 * Map MP payment statuses to our internal CheckoutStatus enum.
 *   approved | authorized → COMPLETED
 *   pending | in_process | in_mediation → PENDING
 *   rejected | cancelled → CANCELLED
 *   refunded | charged_back → FAILED (was successful, now reversed)
 */
function mpToCheckoutStatus(mpStatus: string): 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' {
  switch (mpStatus) {
    case 'approved':
    case 'authorized':
      return 'COMPLETED'
    case 'pending':
    case 'in_process':
    case 'in_mediation':
      return 'PENDING'
    case 'rejected':
    case 'cancelled':
      return 'CANCELLED'
    case 'refunded':
    case 'charged_back':
      return 'FAILED'
    default:
      // Unknown status — preserve PENDING so caller can investigate
      return 'PENDING'
  }
}

export async function handleIpn(p: HandleIpnParams): Promise<HandleIpnResult> {
  const mpUserId = String(p.payload.user_id)
  const dataId = String(p.payload.data.id)
  const eventType = p.payload.type
  const action = p.payload.action

  // 1. Atomic dedupe. The unique constraint on (mpUserId, dataId, requestId)
  //    is our O(1) "have we seen this?" check.
  try {
    await prisma.mercadoPagoWebhookEvent.create({
      data: {
        mpUserId,
        dataId,
        requestId: p.requestId,
        eventType,
        action,
        // Cast to any because Prisma's Json input type is broad and the MP
        // payload shape isn't worth fighting the compiler over.
        payload: p.payload as unknown as object,
        processingStatus: 'pending',
      },
    })
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return { status: 'duplicate' }
    }
    throw err
  }

  // 2. Only "payment" events are processed in v1. Other types (merchant_order,
  //    claim, chargeback) are logged for future handling but not acted on.
  if (eventType !== 'payment') {
    await markStatus(mpUserId, dataId, p.requestId, 'ignored', `unsupported event type ${eventType}`)
    return { status: 'ignored', reason: `unsupported event type ${eventType}` }
  }

  // 3. Find the seller (the EcommerceMerchant who owns this mpUserId).
  const merchant = await prisma.ecommerceMerchant.findFirst({
    where: { providerMerchantId: mpUserId, provider: { code: 'MERCADO_PAGO' } },
  })
  if (!merchant) {
    await markStatus(mpUserId, dataId, p.requestId, 'error', `no merchant matches mpUserId ${mpUserId}`)
    return { status: 'error', reason: 'merchant_not_found' }
  }

  // 4. Load + decrypt the seller's access_token.
  const creds = await loadCredentials(merchant.id)
  if (!creds) {
    await markStatus(mpUserId, dataId, p.requestId, 'error', 'merchant credentials missing')
    return { status: 'error', reason: 'credentials_missing' }
  }

  // 5. Fetch the authoritative payment state from MP.
  let payment
  try {
    payment = await getPayment(creds.accessToken, dataId)
  } catch (err: any) {
    await markStatus(mpUserId, dataId, p.requestId, 'error', err.message)
    return { status: 'error', reason: 'fetch_failed' }
  }

  // 6. Resolve the CheckoutSession by external_reference (we set this to
  //    CheckoutSession.sessionId at payment creation time).
  const externalRef = payment.external_reference
  if (!externalRef) {
    await markStatus(mpUserId, dataId, p.requestId, 'ignored', 'no external_reference on payment')
    return { status: 'ignored', reason: 'no_external_reference' }
  }

  const session = await prisma.checkoutSession.findFirst({
    where: { sessionId: externalRef, ecommerceMerchantId: merchant.id },
  })
  if (!session) {
    await markStatus(mpUserId, dataId, p.requestId, 'ignored', `session_not_found for ${externalRef}`)
    return { status: 'ignored', reason: 'session_not_found' }
  }

  // 7. Update CheckoutSession with MP fields + mapped status.
  const checkoutStatus = mpToCheckoutStatus(payment.status)
  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: {
      mpPaymentId: String(payment.id),
      mpMerchantOrderId: payment.order?.id ? String(payment.order.id) : null,
      status: checkoutStatus,
      // Only set completedAt the first time we mark it COMPLETED, never
      // overwrite (so retries don't move the timestamp).
      completedAt: checkoutStatus === 'COMPLETED' && !session.completedAt ? new Date() : session.completedAt,
    },
  })

  // Record the Order + Payment once MP confirms approval. This is the
  // authoritative path; the optimistic mp-pay endpoint also calls this, both
  // idempotent (unique Payment.idempotencyKey = mpPaymentId). Dynamic import
  // avoids a static cycle between the MP module and paymentLink.service.
  let finalizeError: string | null = null
  if (checkoutStatus === 'COMPLETED') {
    const { finalizeMercadoPagoCheckout } = await import('@/services/dashboard/paymentLink.service')
    try {
      await finalizeMercadoPagoCheckout({ sessionId: session.sessionId, mpPaymentId: payment.id })
    } catch (err) {
      // The charge succeeded on MP but we failed to record the local
      // Order/Payment. Mark the webhook event 'error' (not 'processed') so it's
      // queryable for reconciliation instead of silently lost. A sweep of
      // COMPLETED sessions with paymentId=null is the recommended follow-up.
      finalizeError = err instanceof Error ? err.message : String(err)
      logger.error('[MP IPN] finalizeMercadoPagoCheckout failed — charged on MP but no local Order/Payment', {
        sessionId: session.sessionId,
        mpPaymentId: String(payment.id),
        error: finalizeError,
      })
    }
  }

  await markStatus(mpUserId, dataId, p.requestId, finalizeError ? 'error' : 'processed', finalizeError)
  logger.info('[MP] IPN processed', {
    checkoutSessionId: session.id,
    paymentId: payment.id,
    mpStatus: payment.status,
    requestId: p.requestId,
  })

  return {
    status: 'processed',
    checkoutSessionId: session.id,
    paymentId: String(payment.id),
  }
}

/**
 * Update the webhook event row's processingStatus + errorMessage. Uses
 * updateMany so it's safe even if the row doesn't exist (no exception).
 */
async function markStatus(
  mpUserId: string,
  dataId: string,
  requestId: string,
  status: 'processed' | 'ignored' | 'error',
  errorMessage: string | null,
): Promise<void> {
  await prisma.mercadoPagoWebhookEvent.updateMany({
    where: { mpUserId, dataId, requestId },
    data: { processingStatus: status, errorMessage },
  })
}
