import Stripe from 'stripe'
import prisma from '@/utils/prismaClient'
import type { TerminalOrder, TerminalOrderItem } from '@prisma/client'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

interface CreateCheckoutSessionInput {
  order: TerminalOrder & { items: TerminalOrderItem[] }
  successUrl: string
  cancelUrl: string
}

/**
 * Creates a Stripe Checkout Session for a TerminalOrder. The session uses
 * `mode: 'payment'` (one-shot charge — no subscription). Metadata carries
 * `terminalOrderId` so the webhook handler can find the order when
 * `checkout.session.completed` fires.
 *
 * Persists `stripeCheckoutSessionId` on the order. Returns the redirect URL
 * the frontend uses for `window.location.href`.
 */
export async function createCheckoutSessionForOrder(
  input: CreateCheckoutSessionInput,
): Promise<{ sessionId: string; redirectUrl: string }> {
  const { order, successUrl, cancelUrl } = input

  // One Stripe line_item per order item (price_data inline — no Stripe Product needed).
  // Add a separate line_item for IVA so the customer sees the breakdown.
  const itemLines = order.items.map(item => ({
    quantity: item.quantity,
    price_data: {
      currency: order.currency.toLowerCase(),
      product_data: { name: item.productName },
      unit_amount: item.unitPriceCents,
    },
  }))

  const taxLine = {
    quantity: 1,
    price_data: {
      currency: order.currency.toLowerCase(),
      product_data: { name: 'IVA (16%)' },
      unit_amount: order.taxCents,
    },
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: order.contactEmail,
    line_items: [...itemLines, taxLine],
    metadata: {
      terminalOrderId: order.id,
      venueId: order.venueId,
      orderNumber: order.orderNumber,
    },
    payment_intent_data: {
      receipt_email: order.contactEmail,
      description: `Pedido ${order.orderNumber} — Terminales Avoqado`,
      metadata: {
        terminalOrderId: order.id,
        venueId: order.venueId,
      },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  })

  await prisma.terminalOrder.update({
    where: { id: order.id },
    data: { stripeCheckoutSessionId: session.id },
  })

  return { sessionId: session.id, redirectUrl: session.url! }
}
