import Stripe from 'stripe'
import type { CommercialLifecycleEvent, CommercialLifecycleEventType } from './commercialSubscriptionLifecycle.service'
import { commercialSubscriptionLifecycleService } from './commercialSubscriptionLifecycle.service'

export interface CommercialStripeReference {
  acceptanceId?: string
  stripeCheckoutSessionId?: string
  stripeSubscriptionId?: string
}

interface CommercialStripeReferenceResolver {
  fromInvoice(invoiceId: string): Promise<CommercialStripeReference | null>
  fromCharge(chargeId: string): Promise<CommercialStripeReference | null>
}

interface CommercialStripeLifecyclePort {
  reconcile(event: CommercialLifecycleEvent): Promise<{ matched: boolean; applied: boolean; [key: string]: unknown }>
}

interface CommercialStripeWebhookAdapterDependencies {
  lifecycle: CommercialStripeLifecyclePort
  resolver: CommercialStripeReferenceResolver
}

const COMMERCIAL_METADATA_TYPE = 'commercial_subscription_v1'

function stringId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value.id
  return undefined
}

function metadataReference(object: any): CommercialStripeReference | null {
  const metadata = object?.metadata
  if (metadata?.type !== COMMERCIAL_METADATA_TYPE || typeof metadata.acceptanceId !== 'string') return null
  return {
    acceptanceId: metadata.acceptanceId,
    stripeCheckoutSessionId:
      object?.object === 'checkout.session' || String(object?.id ?? '').startsWith('cs_') ? stringId(object) : undefined,
    stripeSubscriptionId: stringId(object?.subscription) ?? (String(object?.id ?? '').startsWith('sub_') ? stringId(object) : undefined),
  }
}

function invoiceReference(invoice: any): CommercialStripeReference | null {
  const direct = metadataReference(invoice)
  if (direct) return direct
  const details = invoice?.parent?.subscription_details ?? invoice?.subscription_details
  const metadata = details?.metadata
  if (metadata?.type !== COMMERCIAL_METADATA_TYPE || typeof metadata.acceptanceId !== 'string') return null
  return {
    acceptanceId: metadata.acceptanceId,
    stripeSubscriptionId: stringId(details?.subscription) ?? stringId(invoice?.subscription),
  }
}

function eventType(event: Stripe.Event, object: any): CommercialLifecycleEventType | null {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return ['paid', 'no_payment_required'].includes(object?.payment_status) ? 'CHECKOUT_COMPLETED' : null
    case 'checkout.session.async_payment_failed':
      return 'INVOICE_FAILED'
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return 'INVOICE_PAID'
    case 'invoice.payment_failed':
      return 'INVOICE_FAILED'
    case 'customer.subscription.deleted':
      return 'SUBSCRIPTION_CANCELED'
    case 'charge.refunded':
      return Number(object?.amount_refunded) >= Number(object?.amount) ? 'REFUND_SUCCEEDED' : 'PARTIAL_REFUND'
    case 'charge.dispute.created':
      return 'DISPUTE_OPENED'
    case 'charge.dispute.closed':
      return object?.status === 'won' ? 'DISPUTE_WON' : 'DISPUTE_LOST'
    default:
      return null
  }
}

async function resolveReference(
  event: Stripe.Event,
  object: any,
  resolver: CommercialStripeReferenceResolver,
): Promise<CommercialStripeReference | null> {
  if (event.type.startsWith('checkout.session.') || event.type === 'customer.subscription.deleted') {
    return metadataReference(object)
  }
  if (event.type.startsWith('invoice.')) {
    return invoiceReference(object)
  }
  if (event.type === 'charge.refunded') {
    const direct = metadataReference(object)
    if (direct) return direct
    const invoiceId = stringId(object?.invoice)
    return invoiceId ? resolver.fromInvoice(invoiceId) : null
  }
  if (event.type.startsWith('charge.dispute.')) {
    const direct = metadataReference(object)
    if (direct) return direct
    const chargeId = stringId(object?.charge)
    return chargeId ? resolver.fromCharge(chargeId) : null
  }
  return null
}

export function createCommercialStripeWebhookAdapter(dependencies: CommercialStripeWebhookAdapterDependencies) {
  return {
    async reconcile(event: Stripe.Event): Promise<{ matched: boolean; applied: boolean; [key: string]: unknown }> {
      const object = event.data.object as any
      const type = eventType(event, object)
      if (!type) return { matched: false, applied: false }
      const reference = await resolveReference(event, object, dependencies.resolver)
      if (!reference) return { matched: false, applied: false }
      return dependencies.lifecycle.reconcile({
        stripeEventId: event.id,
        type,
        effectiveAt: new Date(event.created * 1000),
        ...reference,
        ...(event.type.startsWith('checkout.session.')
          ? {
              stripeCheckoutSessionId: stringId(object),
              stripeSubscriptionId: stringId(object?.subscription),
            }
          : {}),
      })
    },
  }
}

let stripeClient: Stripe | null = null

function stripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY is required to resolve commercial webhook references')
    stripeClient = new Stripe(key)
  }
  return stripeClient
}

export const liveCommercialStripeReferenceResolver: CommercialStripeReferenceResolver = {
  async fromInvoice(invoiceId) {
    const invoice = await stripe().invoices.retrieve(invoiceId)
    return invoiceReference(invoice)
  },
  async fromCharge(chargeId) {
    const charge = await stripe().charges.retrieve(chargeId)
    const direct = metadataReference(charge)
    if (direct) return direct
    const invoiceId = stringId((charge as any).invoice)
    return invoiceId ? this.fromInvoice(invoiceId) : null
  },
}

export const commercialStripeWebhookAdapter = createCommercialStripeWebhookAdapter({
  lifecycle: commercialSubscriptionLifecycleService,
  resolver: liveCommercialStripeReferenceResolver,
})
