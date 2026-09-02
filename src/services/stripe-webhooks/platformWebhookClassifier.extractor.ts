import type { StripeObjectType } from './platformWebhookInbox.service'

export interface SignedPlatformEvent {
  webhookEventId: string
  stripeEventId: string
  type: string
  object: unknown
}

export interface StripeBindingReference {
  objectType: StripeObjectType
  stripeObjectId: string
}

export interface ExtractedSignedReferences {
  rootId: string
  subscriptionIds: string[]
  invoiceIds: string[]
  paymentIntentIds: string[]
  chargeIds: string[]
  customerIds: string[]
}

export type PlatformWebhookEventFamily =
  | 'CHECKOUT'
  | 'SUBSCRIPTION'
  | 'INVOICE'
  | 'PAYMENT_INTENT'
  | 'CHARGE_REFUND'
  | 'DISPUTE'
  | 'CUSTOMER_DELETED'
  | 'PAYMENT_METHOD_ATTACHED'

export type ExtractedSignedPlatformEvent =
  | { kind: 'IGNORED'; code: 'EVENT_TYPE_NOT_HANDLED' }
  | {
      kind: 'UNRESOLVED'
      code: 'SIGNED_REFERENCE_MISSING' | 'SIGNED_EVENT_SHAPE_INVALID'
    }
  | {
      kind: 'EXTRACTED'
      family: PlatformWebhookEventFamily
      event: SignedPlatformEvent
      references: ExtractedSignedReferences
      lookupBindings: StripeBindingReference[]
    }

const EVENT_FAMILIES = new Map<string, PlatformWebhookEventFamily>([
  ['checkout.session.completed', 'CHECKOUT'],
  ['checkout.session.async_payment_succeeded', 'CHECKOUT'],
  ['checkout.session.async_payment_failed', 'CHECKOUT'],
  ['customer.subscription.created', 'SUBSCRIPTION'],
  ['customer.subscription.updated', 'SUBSCRIPTION'],
  ['customer.subscription.deleted', 'SUBSCRIPTION'],
  ['customer.subscription.trial_will_end', 'SUBSCRIPTION'],
  ['invoice.paid', 'INVOICE'],
  ['invoice.payment_succeeded', 'INVOICE'],
  ['invoice.payment_failed', 'INVOICE'],
  ['payment_intent.succeeded', 'PAYMENT_INTENT'],
  ['payment_intent.payment_failed', 'PAYMENT_INTENT'],
  ['charge.refunded', 'CHARGE_REFUND'],
  ['charge.dispute.created', 'DISPUTE'],
  ['charge.dispute.closed', 'DISPUTE'],
  ['customer.deleted', 'CUSTOMER_DELETED'],
  ['payment_method.attached', 'PAYMENT_METHOD_ATTACHED'],
])

type ParsedId = { state: 'ABSENT' } | { state: 'INVALID' } | { state: 'PRESENT'; id: string; expanded?: UnknownRecord }
type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseId(value: unknown, expectedObject?: string): ParsedId {
  if (value === undefined || value === null) return { state: 'ABSENT' }
  if (typeof value === 'string') return value.trim() ? { state: 'PRESENT', id: value } : { state: 'INVALID' }
  if (!isRecord(value)) return { state: 'INVALID' }
  if (typeof value.id !== 'string' || !value.id.trim()) return { state: 'INVALID' }
  if (
    expectedObject &&
    value.object !== undefined &&
    value.object !== null &&
    (typeof value.object !== 'string' || value.object !== expectedObject)
  ) {
    return { state: 'INVALID' }
  }
  return { state: 'PRESENT', id: value.id, expanded: value }
}

function addParsedId(target: Set<string>, parsed: ParsedId): boolean {
  if (parsed.state === 'INVALID') return false
  if (parsed.state === 'PRESENT') target.add(parsed.id)
  return true
}

function parseNestedOptionalId(root: UnknownRecord, path: string[], expectedObject: string): ParsedId {
  let current: unknown = root
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!isRecord(current)) return { state: 'INVALID' }
    const next = current[path[index]]
    if (next === undefined || next === null) return { state: 'ABSENT' }
    if (!isRecord(next)) return { state: 'INVALID' }
    current = next
  }
  if (!isRecord(current)) return { state: 'INVALID' }
  return parseId(current[path[path.length - 1]], expectedObject)
}

function sorted(values: Set<string>): string[] {
  return [...values].sort()
}

function unresolved(code: 'SIGNED_REFERENCE_MISSING' | 'SIGNED_EVENT_SHAPE_INVALID'): ExtractedSignedPlatformEvent {
  return { kind: 'UNRESOLVED', code }
}

export function extractSignedPlatformEvent(event: SignedPlatformEvent): ExtractedSignedPlatformEvent {
  const family = EVENT_FAMILIES.get(event.type)
  if (!family) return { kind: 'IGNORED', code: 'EVENT_TYPE_NOT_HANDLED' }
  if (!isRecord(event.object)) return unresolved('SIGNED_EVENT_SHAPE_INVALID')

  const root = event.object
  const rootObjects: Record<PlatformWebhookEventFamily, string> = {
    CHECKOUT: 'checkout.session',
    SUBSCRIPTION: 'subscription',
    INVOICE: 'invoice',
    PAYMENT_INTENT: 'payment_intent',
    CHARGE_REFUND: 'charge',
    DISPUTE: 'dispute',
    CUSTOMER_DELETED: 'customer',
    PAYMENT_METHOD_ATTACHED: 'payment_method',
  }
  if (root.object !== undefined && root.object !== null && (typeof root.object !== 'string' || root.object !== rootObjects[family])) {
    return unresolved('SIGNED_EVENT_SHAPE_INVALID')
  }
  if (root.id === undefined || root.id === null) return unresolved('SIGNED_REFERENCE_MISSING')
  if (typeof root.id !== 'string' || !root.id.trim()) return unresolved('SIGNED_EVENT_SHAPE_INVALID')
  const rootId = root.id

  const subscriptions = new Set<string>()
  const invoices = new Set<string>()
  const paymentIntents = new Set<string>()
  const charges = new Set<string>()
  const customers = new Set<string>()

  if (family === 'CHECKOUT') {
    if (!addParsedId(subscriptions, parseId(root.subscription, 'subscription'))) {
      return unresolved('SIGNED_EVENT_SHAPE_INVALID')
    }
  }

  if (family === 'SUBSCRIPTION') subscriptions.add(rootId)

  if (family === 'INVOICE') {
    invoices.add(rootId)
    const subscriptionReferences = [
      parseId(root.subscription, 'subscription'),
      parseNestedOptionalId(root, ['subscription_details', 'subscription'], 'subscription'),
      parseNestedOptionalId(root, ['parent', 'subscription_details', 'subscription'], 'subscription'),
    ]
    if (subscriptionReferences.some(reference => !addParsedId(subscriptions, reference))) {
      return unresolved('SIGNED_EVENT_SHAPE_INVALID')
    }
    if (!addParsedId(paymentIntents, parseId(root.payment_intent, 'payment_intent'))) {
      return unresolved('SIGNED_EVENT_SHAPE_INVALID')
    }
    if (!addParsedId(charges, parseId(root.charge, 'charge'))) return unresolved('SIGNED_EVENT_SHAPE_INVALID')

    if (root.payments !== undefined && root.payments !== null) {
      if (!isRecord(root.payments) || !Array.isArray(root.payments.data)) return unresolved('SIGNED_EVENT_SHAPE_INVALID')
      for (const entry of root.payments.data) {
        if (!isRecord(entry) || !isRecord(entry.payment)) return unresolved('SIGNED_EVENT_SHAPE_INVALID')
        const payment = entry.payment
        if (payment.type !== undefined && (typeof payment.type !== 'string' || !payment.type.trim())) {
          return unresolved('SIGNED_EVENT_SHAPE_INVALID')
        }
        const paymentIntent = parseId(payment.payment_intent, 'payment_intent')
        const charge = parseId(payment.charge, 'charge')
        if (!addParsedId(paymentIntents, paymentIntent) || !addParsedId(charges, charge)) {
          return unresolved('SIGNED_EVENT_SHAPE_INVALID')
        }
        if (payment.type === 'payment_intent' && paymentIntent.state !== 'PRESENT') {
          return unresolved('SIGNED_EVENT_SHAPE_INVALID')
        }
        if (payment.type === 'charge' && charge.state !== 'PRESENT') return unresolved('SIGNED_EVENT_SHAPE_INVALID')
      }
    }
  }

  if (family === 'PAYMENT_INTENT') {
    paymentIntents.add(rootId)
    if (!addParsedId(charges, parseId(root.latest_charge, 'charge'))) return unresolved('SIGNED_EVENT_SHAPE_INVALID')
  }

  if (family === 'CHARGE_REFUND') {
    charges.add(rootId)
    if (!addParsedId(invoices, parseId(root.invoice, 'invoice'))) return unresolved('SIGNED_EVENT_SHAPE_INVALID')
    if (!addParsedId(paymentIntents, parseId(root.payment_intent, 'payment_intent'))) {
      return unresolved('SIGNED_EVENT_SHAPE_INVALID')
    }
  }

  if (family === 'DISPUTE') {
    const charge = parseId(root.charge, 'charge')
    if (charge.state === 'ABSENT') return unresolved('SIGNED_REFERENCE_MISSING')
    if (charge.state === 'INVALID') return unresolved('SIGNED_EVENT_SHAPE_INVALID')
    charges.add(charge.id)
    if (charge.expanded && !addParsedId(paymentIntents, parseId(charge.expanded.payment_intent, 'payment_intent'))) {
      return unresolved('SIGNED_EVENT_SHAPE_INVALID')
    }
  }

  if (family === 'CUSTOMER_DELETED') customers.add(rootId)

  if (family === 'PAYMENT_METHOD_ATTACHED') {
    const customer = parseId(root.customer, 'customer')
    if (customer.state === 'ABSENT') return unresolved('SIGNED_REFERENCE_MISSING')
    if (customer.state === 'INVALID') return unresolved('SIGNED_EVENT_SHAPE_INVALID')
    customers.add(customer.id)
  }

  const references: ExtractedSignedReferences = {
    rootId,
    subscriptionIds: sorted(subscriptions),
    invoiceIds: sorted(invoices),
    paymentIntentIds: sorted(paymentIntents),
    chargeIds: sorted(charges),
    customerIds: sorted(customers),
  }

  const lookupBindings: StripeBindingReference[] = []
  const addLookup = (objectType: StripeObjectType, values: string[]) => {
    values.forEach(stripeObjectId => lookupBindings.push({ objectType, stripeObjectId }))
  }
  if (family === 'CHECKOUT') addLookup('CHECKOUT_SESSION', [rootId])
  if (family === 'SUBSCRIPTION') addLookup('SUBSCRIPTION', [rootId])
  if (family === 'INVOICE') {
    addLookup('INVOICE', [rootId])
    addLookup('SUBSCRIPTION', references.subscriptionIds)
  }
  if (family === 'PAYMENT_INTENT') addLookup('PAYMENT_INTENT', [rootId])
  if (family === 'CHARGE_REFUND') {
    addLookup('CHARGE', [rootId])
    addLookup('INVOICE', references.invoiceIds)
    addLookup('PAYMENT_INTENT', references.paymentIntentIds)
  }
  if (family === 'DISPUTE') {
    addLookup('CHARGE', references.chargeIds)
    addLookup('PAYMENT_INTENT', references.paymentIntentIds)
  }

  return { kind: 'EXTRACTED', family, event, references, lookupBindings }
}
