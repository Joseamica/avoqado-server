import type Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import { ConflictError, NotFoundError } from '@/errors/AppError'
import { stripe, STRIPE_DENTRO_DEL_CANDADO as options } from '@/services/stripe.service'
import { recordedStripeWrite } from './hybridProvider'
import { provisionHybridPurchase } from './hybridProvision.service'
import { reconcileHybridInvoice } from './hybridDelivery.service'
import { endLapsedHybridContracts } from './hybridSeats'

const idOf = (value: string | { id: string } | null | undefined) => (typeof value === 'string' ? value : value?.id)
const unknown = () =>
  new ConflictError('Aún estamos verificando el resultado del pago. Conservamos el mismo intento y tu lugar.', 'HYBRID_PROVIDER_UNKNOWN')

export async function cancelHybridPurchase(venueId: string, purchaseId: string, staffId: string, expired = false) {
  const purchase = await prisma.hybridPurchase.findUnique({ where: { id: purchaseId, venueId } })
  if (!purchase) throw new NotFoundError('Compra no encontrada.')
  if (['CANCELLED', 'EXPIRED'].includes(purchase.status)) return { status: purchase.status }
  if (['COMPLETED', 'PAID', 'DELIVERING'].includes(purchase.status))
    throw new ConflictError('El pago ya fue confirmado. Puedes gestionar la renovación desde tus suscripciones.', 'HYBRID_ALREADY_PAID')
  const operation = await prisma.hybridBillingOperation.findUnique({ where: { purchaseId_step: { purchaseId, step: 'SUBSCRIPTION' } } })
  const subscriptionId = purchase.stripeSubscriptionId ?? operation?.providerId
  let providerClosed = false
  if (subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, {}, options)
    if (
      idOf(sub.customer) !== purchase.stripeCustomerId ||
      sub.metadata.hybridPurchaseId !== purchaseId ||
      sub.metadata.venueId !== venueId
    )
      throw unknown()
    const invoiceId = purchase.initialInvoiceId ?? idOf(sub.latest_invoice)
    if (!invoiceId) throw unknown()
    const readInvoice = async () => {
      const invoice = await stripe.invoices.retrieve(invoiceId, {}, options)
      if (idOf(invoice.customer) !== purchase.stripeCustomerId || idOf(invoice.parent?.subscription_details?.subscription) !== sub.id)
        throw unknown()
      return invoice
    }
    const invoice = await readInvoice()
    if (invoice.status === 'paid') {
      await reconcileHybridInvoice(venueId, purchaseId, invoiceId)
      throw new ConflictError('El pago ya fue confirmado. Estamos entregando tus accesos.', 'HYBRID_ALREADY_PAID')
    }
    await recordedStripeWrite(
      purchaseId,
      'VOID_INITIAL_INVOICE',
      { invoiceId },
      async (saved, idempotencyKey) => {
        const current = await readInvoice()
        if (current.status !== 'open') throw unknown()
        const closed = await stripe.invoices.voidInvoice(saved.invoiceId, {}, { ...options, idempotencyKey })
        if (closed.status !== 'void') throw unknown()
        return closed
      },
      async () => {
        const current = await readInvoice()
        return current.status === 'void' ? current : null
      },
    )
    await recordedStripeWrite(
      purchaseId,
      'CANCEL_UNPAID_SUBSCRIPTION',
      { subscriptionId },
      async (saved, idempotencyKey) => {
        const canceled = await stripe.subscriptions.cancel(
          saved.subscriptionId,
          { invoice_now: false, prorate: false },
          { ...options, idempotencyKey },
        )
        if (canceled.status !== 'canceled') throw unknown()
        return canceled
      },
      async () => {
        const current = await stripe.subscriptions.retrieve(subscriptionId, {}, options)
        if (idOf(current.customer) !== purchase.stripeCustomerId) throw unknown()
        return ['canceled', 'incomplete_expired'].includes(current.status) ? current : null
      },
    )
    providerClosed = true
  } else if (operation) throw unknown()
  return prisma.$transaction(async tx => {
    // Same row lock taken by the operation INSERT trigger: no create may start after this releases the place.
    await tx.$queryRaw`SELECT id FROM "HybridPurchase" WHERE id = ${purchaseId} FOR UPDATE`
    const current = await tx.hybridPurchase.findUniqueOrThrow({ where: { id: purchaseId, venueId } })
    if (['CANCELLED', 'EXPIRED'].includes(current.status)) return { status: current.status }
    if (['PAID', 'DELIVERING', 'COMPLETED'].includes(current.status))
      throw new ConflictError('El pago ya fue confirmado.', 'HYBRID_ALREADY_PAID')
    const prepared = await tx.hybridBillingOperation.findUnique({ where: { purchaseId_step: { purchaseId, step: 'SUBSCRIPTION' } } })
    if (!providerClosed && (prepared || current.stripeSubscriptionId)) throw unknown()
    const redemptions = await tx.hybridRedemption.findMany({
      where: { purchaseId, status: 'RESERVED' },
      orderBy: { campaignId: 'asc' },
      take: 9,
    })
    if (redemptions.length > 8) throw unknown()
    for (const redemption of redemptions) {
      const changed = await tx.hybridCampaign.updateMany({
        where: { id: redemption.campaignId, reservedCount: { gt: 0 } },
        data: { reservedCount: { decrement: 1 } },
      })
      if (!changed.count) throw unknown()
    }
    await tx.hybridRedemption.updateMany({ where: { purchaseId, status: 'RESERVED' }, data: { status: 'RELEASED' } })
    await tx.hybridCreditAllocation.updateMany({ where: { purchaseId, status: 'RESERVED' }, data: { status: 'RELEASED' } })
    await tx.hybridContract.updateMany({ where: { purchaseId, venueId, endedAt: null }, data: { endedAt: new Date() } })
    const status = expired ? 'EXPIRED' : 'CANCELLED'
    await tx.hybridPurchase.update({ where: { id: purchaseId }, data: { status, lastIssue: null } })
    await tx.activityLog.create({
      data: {
        venueId,
        staffId,
        entity: 'HybridPurchase',
        entityId: purchaseId,
        action: `HYBRID_PURCHASE_${status}`,
        data: { providerClosed },
      },
    })
    return { status }
  })
}

export async function reconcileHybridPurchase(venueId: string, purchaseId: string) {
  let purchase = await prisma.hybridPurchase.findUnique({ where: { id: purchaseId, venueId } })
  if (!purchase) throw new NotFoundError('Compra no encontrada.')
  if (['QUOTED', 'EXPIRED', 'CANCELLED'].includes(purchase.status)) return { status: purchase.status }
  if (!purchase.initialInvoiceId) {
    const provisioned = await provisionHybridPurchase(venueId, purchaseId)
    if (provisioned.status === 'EXPIRED') return { status: 'EXPIRED' }
    purchase = await prisma.hybridPurchase.findUniqueOrThrow({ where: { id: purchaseId, venueId } })
  }
  let invoiceId = purchase.initialInvoiceId!
  if (purchase.status === 'COMPLETED' && purchase.stripeSubscriptionId) {
    const unfinished = await prisma.hybridBillingOperation.findFirst({
      where: {
        purchaseId,
        resultHash: null,
        OR: [{ step: { startsWith: 'SCHEDULE_CONFIGURE:' } }, { step: { startsWith: 'SCHEDULE_CANCEL_CREATE:' } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { step: true },
    })
    if (unfinished) {
      const [, contractId, revision] = unfinished.step.split(':')
      const { cancelHybridContract } = await import('./hybridManagement.service')
      await cancelHybridContract(venueId, contractId, purchase.quotedById, { expectedRevision: Number(revision) })
    }
    const sub = await stripe.subscriptions.retrieve(purchase.stripeSubscriptionId, {}, options)
    invoiceId = idOf(sub.latest_invoice) ?? invoiceId
  }
  const result = await reconcileHybridInvoice(venueId, purchaseId, invoiceId)
  // A contract whose cancellation took effect ends here even when its subscription lives on (spec §4.3). After the
  // delivery, so a seat failure never delays paid access; a failure propagates and the sweep retries.
  if (purchase.status === 'COMPLETED') await endLapsedHybridContracts(venueId, purchaseId)
  if (purchase.status === 'COMPLETED' && result.status === 'PAYMENT_PENDING') return { status: 'RENEWAL_PENDING' }
  if (
    ['PAYMENT_PENDING', 'ENDED'].includes(result.status) &&
    purchase.status !== 'COMPLETED' &&
    purchase.paymentExpiresAt &&
    purchase.paymentExpiresAt <= new Date()
  )
    return cancelHybridPurchase(venueId, purchaseId, purchase.quotedById, true)
  return result
}

/** A refunded legacy invoice may have funded several later purchases or customer-balance uses. */
async function queueCustomerFundingReview(invoice: Stripe.Invoice) {
  const customerId = idOf(invoice.customer)
  if (!customerId) return
  // The existing worker claims ten at a time; no unbounded webhook fan-out or new recurring job.
  await prisma.hybridPurchase.updateMany({
    where: { stripeCustomerId: customerId, status: 'COMPLETED', contracts: { some: { endedAt: null } } },
    data: { nextAttemptAt: new Date() },
  })
}

/** Returns true only for saved hybrid purchases; the common webhook wrapper retains its success/failure journal. */
export async function handleHybridStripeEvent(event: Stripe.Event): Promise<boolean> {
  if (event.type === 'charge.refunded' || event.type.startsWith('charge.dispute.')) {
    const chargeId =
      event.type === 'charge.refunded' ? (event.data.object as Stripe.Charge).id : idOf((event.data.object as Stripe.Dispute).charge)
    if (!chargeId) return false
    const charge = await stripe.charges.retrieve(chargeId, {}, options)
    const intentId = idOf(charge.payment_intent)
    if (!intentId) return false
    const payments = await stripe.invoicePayments.list(
      { payment: { type: 'payment_intent', payment_intent: intentId }, limit: 100 },
      options,
    )
    if (payments.has_more) throw unknown()
    let handled = false
    for (const invoiceId of new Set(payments.data.map(p => idOf(p.invoice)).filter((id): id is string => Boolean(id)))) {
      const invoice = await stripe.invoices.retrieve(invoiceId, {}, options)
      await queueCustomerFundingReview(invoice)
      const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription)
      if (!subscriptionId) continue
      const purchase = await prisma.hybridPurchase.findUnique({ where: { stripeSubscriptionId: subscriptionId } })
      if (!purchase) continue
      if (!['QUOTED', 'CANCELLED', 'EXPIRED'].includes(purchase.status))
        await reconcileHybridInvoice(purchase.venueId, purchase.id, invoiceId)
      handled = true
    }
    return handled
  }
  let invoiceId: string | undefined
  let subscriptionId: string | undefined
  let purchaseId: string | undefined
  if (event.type.startsWith('invoice.')) {
    const invoice = event.data.object as Stripe.Invoice
    invoiceId = invoice.id
    subscriptionId = idOf(invoice.parent?.subscription_details?.subscription)
    purchaseId = invoice.parent?.subscription_details?.metadata?.hybridPurchaseId
  } else if (event.type.startsWith('customer.subscription.')) {
    const sub = event.data.object as Stripe.Subscription
    subscriptionId = sub.id
    purchaseId = sub.metadata?.hybridPurchaseId
  } else if (event.type.startsWith('credit_note.')) {
    const note = event.data.object as Stripe.CreditNote
    invoiceId = idOf(note.invoice)
    if (invoiceId) {
      const invoice = await stripe.invoices.retrieve(invoiceId, {}, options)
      await queueCustomerFundingReview(invoice)
      subscriptionId = idOf(invoice.parent?.subscription_details?.subscription)
    }
  } else return false
  if (!subscriptionId && !purchaseId) return false
  const purchase = await prisma.hybridPurchase.findUnique({
    where: purchaseId ? { id: purchaseId } : { stripeSubscriptionId: subscriptionId! },
  })
  if (!purchase) return false
  if (['CANCELLED', 'EXPIRED', 'QUOTED'].includes(purchase.status)) return true
  if (!purchase.initialInvoiceId) await provisionHybridPurchase(purchase.venueId, purchase.id)
  if (invoiceId) await reconcileHybridInvoice(purchase.venueId, purchase.id, invoiceId)
  else await reconcileHybridPurchase(purchase.venueId, purchase.id)
  return true
}

import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import logger from '@/config/logger'

/** Shares the platform reconciliation clock; a venue's pending attempt survives paused sales and process restarts. */
export async function reconcileHybridBatch() {
  const rows = await retry(
    () =>
      prisma.hybridPurchase.findMany({
        where: {
          nextAttemptAt: { lte: new Date() },
          OR: [
            { status: { in: ['ACCEPTED', 'PROVISIONING', 'PAYMENT_PENDING', 'PAID', 'DELIVERING', 'REQUIRES_REVIEW'] } },
            { status: 'COMPLETED', contracts: { some: { endedAt: null } } },
          ],
        },
        select: { id: true, venueId: true, status: true, nextAttemptAt: true, attemptCount: true },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: 10,
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'hybrid-reconciliation.findDue' },
  )
  const deadline = Date.now() + 55000
  for (const row of rows) {
    if (Date.now() >= deadline) break
    const claimed = await prisma.hybridPurchase.updateMany({
      where: { id: row.id, nextAttemptAt: row.nextAttemptAt, status: row.status },
      data: { nextAttemptAt: new Date(Date.now() + 300000), attemptCount: { increment: 1 } },
    })
    if (!claimed.count) continue
    try {
      const result = await reconcileHybridPurchase(row.venueId, row.id)
      await prisma.hybridPurchase.update({
        where: { id: row.id },
        data: {
          lastIssue: 'issue' in result && typeof result.issue === 'string' ? result.issue : null,
          nextAttemptAt: new Date(Date.now() + 15 * 60000),
        },
      })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'HYBRID_RECONCILIATION_PENDING'
      await prisma.hybridPurchase.update({
        where: { id: row.id },
        data: { lastIssue: code, nextAttemptAt: new Date(Date.now() + Math.min(60, 2 ** Math.min(row.attemptCount, 6)) * 60000) },
      })
      logger.warn('Hybrid purchase awaiting reconciliation', {
        venueId: row.venueId,
        purchaseId: row.id,
        code,
        attempt: row.attemptCount + 1,
      })
    }
  }
}
