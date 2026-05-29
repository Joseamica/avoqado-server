import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

/**
 * Handles Stripe `checkout.session.completed` events that belong to a
 * TerminalOrder (identified by metadata.terminalOrderId).
 *
 * Idempotent: if the order is already PAID, this is a no-op. Stripe retries
 * webhooks aggressively, and the same event can also be received from
 * different listeners, so we must not double-process.
 *
 * Emails (#4 customer + #5 sales) are fired by the SERVICE LAYER after the
 * status update. In Plan 1 those email methods exist on emailService —
 * `sendTerminalOrderPaymentConfirmed` and `sendTerminalOrderSerialAssignmentRequest`.
 * We swallow email failures so they don't roll back the status update.
 */
export async function handleTerminalOrderCheckoutCompleted(session: Stripe.Checkout.Session) {
  const orderId = session.metadata?.terminalOrderId
  if (!orderId) {
    // Not a terminal-order session — handled elsewhere
    return
  }

  const order = await prisma.terminalOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  })
  if (!order) {
    logger.warn('Stripe webhook: TerminalOrder not found', { orderId, sessionId: session.id })
    return
  }

  if (order.paymentStatus === 'PAID') {
    logger.info('Stripe webhook: order already PAID, skipping (idempotent)', { orderId })
    return
  }

  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null)

  const { signSerialAssignmentToken } = await import('@/services/dashboard/terminalOrder/token.service')
  const serialToken = signSerialAssignmentToken(order.id)
  const tokenExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  const updated = await prisma.terminalOrder.update({
    where: { id: order.id },
    data: {
      paymentStatus: 'PAID',
      stripePaymentIntentId: paymentIntentId ?? undefined,
      fulfillmentStatus: 'AWAITING_SERIALS',
      serialAssignmentToken: serialToken,
      serialAssignmentTokenExpiresAt: tokenExpires,
    },
  })

  logger.info('Stripe webhook: TerminalOrder marked PAID', {
    orderId: order.id,
    orderNumber: order.orderNumber,
  })

  // Dynamic import to avoid circular dependencies (email.service imports many things)
  try {
    const { default: emailService } = await import('@/services/email.service')
    if (typeof (emailService as any).sendTerminalOrderPaymentConfirmed === 'function') {
      await (emailService as any).sendTerminalOrderPaymentConfirmed({
        order: updated as any,
        items: order.items,
      })
    } else {
      logger.warn('emailService.sendTerminalOrderPaymentConfirmed not defined (Task 12 not done yet?)')
    }
  } catch (err) {
    logger.error('Failed to send payment-confirmed email', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  try {
    const { default: emailService } = await import('@/services/email.service')
    if (typeof (emailService as any).sendTerminalOrderSerialAssignmentRequest === 'function') {
      const { buildSerialAssignmentUrls } = await import('@/services/dashboard/terminalOrder/urls')
      const urls = buildSerialAssignmentUrls(updated.id, serialToken)
      await (emailService as any).sendTerminalOrderSerialAssignmentRequest({
        order: updated as any,
        items: order.items,
        serialAssignmentUrl: urls.serialAssignmentUrl,
        adminUiUrl: urls.adminUiUrl,
      })
    } else {
      logger.warn('emailService.sendTerminalOrderSerialAssignmentRequest not defined (Task 13 not done yet?)')
    }
  } catch (err) {
    logger.error('Failed to send serial-assignment email', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
