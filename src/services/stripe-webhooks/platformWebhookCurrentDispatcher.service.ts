import type Stripe from 'stripe'
import type { StripeEventRouteKey } from './platformWebhookInbox.service'

export type LegacyBranchCode =
  | 'SUBSCRIPTION_CREATED'
  | 'SUBSCRIPTION_UPDATED'
  | 'SUBSCRIPTION_DELETED'
  | 'SUBSCRIPTION_TRIAL_WILL_END'
  | 'INVOICE_PAYMENT_SUCCEEDED'
  | 'INVOICE_PAYMENT_FAILED'
  | 'CUSTOMER_DELETED'
  | 'PAYMENT_METHOD_ATTACHED'
  | 'PAYMENT_INTENT_SUCCEEDED'
  | 'PAYMENT_INTENT_FAILED'
  | 'CHECKOUT_CREDIT_PACK'
  | 'CHECKOUT_TERMINAL_ORDER'
  | 'CHECKOUT_LEGACY_PLAN'

export type DispatchFailureStepCode = 'COMMERCIAL_ADAPTER' | 'VENUE_ENRICHMENT' | LegacyBranchCode

export type DispatchStep =
  | { step: 'COMMERCIAL_ADAPTER'; outcome: 'MATCHED_APPLIED' | 'MATCHED_NOOP' | 'NOT_MATCHED' }
  | { step: 'VENUE_ENRICHMENT'; outcome: 'APPLIED' | 'NOT_APPLICABLE' | 'SKIPPED_INVALID' | 'FAILED_NON_FATAL' }
  | { step: LegacyBranchCode; outcome: 'ATTEMPTED' | 'COMPLETED' }

export type InvoiceEffectResult =
  | 'TOKEN_INVOICE_APPLIED'
  | 'SUBSCRIPTION_INVOICE_APPLIED'
  | 'SUBSCRIPTION_INVOICE_MATCHED_NO_CHANGE'
  | 'INVOICE_NOOP_NO_SUBSCRIPTION'
  | 'INVOICE_NOOP_SUBJECT_NOT_FOUND'
  | 'INVOICE_NOOP_VENUE_NOT_OPERATIONAL'

export type PaymentIntentEffectResult = 'TOKEN_PAYMENT_INTENT_APPLIED' | 'PAYMENT_INTENT_NOOP_NOT_TOKEN'

export type CurrentHandlerEffectResult =
  | 'APPLIED'
  | 'MATCHED'
  | 'MATCHED_NO_CHANGE'
  | 'NOOP_NOT_APPLICABLE'
  | 'NOOP_SUBJECT_NOT_FOUND'
  | 'NOOP_VENUE_NOT_OPERATIONAL'
  | 'NOOP_INVALID_INPUT'
  | 'NOOP_PROCESSING_FAILED'

export const EFFECTIVE_ROUTE_RESULT_TABLE = Object.freeze({
  COMMERCIAL_SUBSCRIPTION_LIFECYCLE: ['MATCHED_APPLIED', 'MATCHED_NOOP'],
  LEGACY_PLAN_CHECKOUT: ['APPLIED', 'MATCHED_NO_CHANGE'],
  LEGACY_SUBSCRIPTION_LIFECYCLE: ['APPLIED', 'MATCHED_NO_CHANGE', 'SUBSCRIPTION_INVOICE_APPLIED', 'SUBSCRIPTION_INVOICE_MATCHED_NO_CHANGE'],
  TERMINAL_ORDER_CHECKOUT: ['APPLIED', 'MATCHED_NO_CHANGE'],
  TOKEN_PAYMENT_INTENT: ['TOKEN_PAYMENT_INTENT_APPLIED'],
  TOKEN_INVOICE: ['TOKEN_INVOICE_APPLIED'],
  CREDIT_PACK_CHECKOUT: ['MATCHED'],
  VENUE_BILLING_PROFILE: ['APPLIED', 'MATCHED_NO_CHANGE'],
} satisfies Record<StripeEventRouteKey, readonly string[]>)

export interface CurrentDispatchTrace {
  steps: DispatchStep[]
  effectiveRouteKeys: StripeEventRouteKey[]
}

export interface CurrentDispatchFailureContext extends CurrentDispatchTrace {
  failureStep: DispatchFailureStepCode
}

interface CurrentDispatcherDependencies {
  commercialAdapter(event: Stripe.Event): Promise<{ matched: boolean; applied: boolean }>
  enrichVenue(event: Stripe.Event, localWebhookEventId: string): Promise<Extract<DispatchStep, { step: 'VENUE_ENRICHMENT' }>['outcome']>
  handlers: {
    subscriptionUpdated(subscription: Stripe.Subscription): Promise<CurrentHandlerEffectResult>
    subscriptionDeleted(subscription: Stripe.Subscription): Promise<CurrentHandlerEffectResult>
    invoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<InvoiceEffectResult>
    invoicePaymentFailed(invoice: Stripe.Invoice): Promise<InvoiceEffectResult>
    subscriptionTrialWillEnd(subscription: Stripe.Subscription): Promise<CurrentHandlerEffectResult>
    customerDeleted(customer: Stripe.Customer): Promise<CurrentHandlerEffectResult>
    paymentMethodAttached(paymentMethod: Stripe.PaymentMethod): Promise<CurrentHandlerEffectResult>
    paymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<PaymentIntentEffectResult>
    paymentIntentFailed(paymentIntent: Stripe.PaymentIntent): Promise<PaymentIntentEffectResult>
    creditPackCheckout(session: Stripe.Checkout.Session): Promise<CurrentHandlerEffectResult>
    terminalOrderCheckout(session: Stripe.Checkout.Session): Promise<CurrentHandlerEffectResult>
    legacyPlanCheckout(session: Stripe.Checkout.Session): Promise<CurrentHandlerEffectResult>
  }
  isLegacyPaidPlanTier?(tierCode: string): boolean
  logUnhandled(type: string): void
}

const failureContexts = new WeakMap<object, CurrentDispatchFailureContext>()

export function getDispatchFailureContext(error: unknown): CurrentDispatchFailureContext | undefined {
  return typeof error === 'object' && error !== null ? failureContexts.get(error) : undefined
}

function rememberFailure(error: unknown, context: CurrentDispatchFailureContext) {
  if (typeof error === 'object' && error !== null) failureContexts.set(error, context)
}

function uniqueRoutes(routes: StripeEventRouteKey[]): StripeEventRouteKey[] {
  return [...new Set(routes)]
}

function invoiceRoute(result: InvoiceEffectResult): StripeEventRouteKey | null {
  if (result === 'TOKEN_INVOICE_APPLIED') return 'TOKEN_INVOICE'
  if (result === 'SUBSCRIPTION_INVOICE_APPLIED' || result === 'SUBSCRIPTION_INVOICE_MATCHED_NO_CHANGE') {
    return 'LEGACY_SUBSCRIPTION_LIFECYCLE'
  }
  return null
}

function hasEffectiveResult(route: StripeEventRouteKey, result: string): boolean {
  return EFFECTIVE_ROUTE_RESULT_TABLE[route].includes(result as never)
}

export function createCurrentStripeWebhookDispatcher(dependencies: CurrentDispatcherDependencies) {
  return async function dispatchCurrentStripeWebhookEffects(
    event: Stripe.Event,
    localWebhookEventId: string,
  ): Promise<CurrentDispatchTrace> {
    const steps: DispatchStep[] = []
    const routes: StripeEventRouteKey[] = []

    try {
      const result = await dependencies.commercialAdapter(event)
      steps.push({
        step: 'COMMERCIAL_ADAPTER',
        outcome: result.matched ? (result.applied ? 'MATCHED_APPLIED' : 'MATCHED_NOOP') : 'NOT_MATCHED',
      })
      if (result.matched) routes.push('COMMERCIAL_SUBSCRIPTION_LIFECYCLE')
    } catch (error) {
      rememberFailure(error, { failureStep: 'COMMERCIAL_ADAPTER', steps: [...steps], effectiveRouteKeys: uniqueRoutes(routes) })
      throw error
    }

    try {
      steps.push({ step: 'VENUE_ENRICHMENT', outcome: await dependencies.enrichVenue(event, localWebhookEventId) })
    } catch (error) {
      rememberFailure(error, { failureStep: 'VENUE_ENRICHMENT', steps: [...steps], effectiveRouteKeys: uniqueRoutes(routes) })
      throw error
    }

    async function runBranch<T>(step: LegacyBranchCode, work: () => Promise<T>): Promise<T> {
      steps.push({ step, outcome: 'ATTEMPTED' })
      try {
        const result = await work()
        steps.push({ step, outcome: 'COMPLETED' })
        return result
      } catch (error) {
        rememberFailure(error, { failureStep: step, steps: [...steps], effectiveRouteKeys: uniqueRoutes(routes) })
        throw error
      }
    }

    const object = event.data.object as any
    switch (event.type) {
      case 'customer.subscription.created':
        if (
          hasEffectiveResult(
            'LEGACY_SUBSCRIPTION_LIFECYCLE',
            await runBranch('SUBSCRIPTION_CREATED', () => dependencies.handlers.subscriptionUpdated(object)),
          )
        ) {
          routes.push('LEGACY_SUBSCRIPTION_LIFECYCLE')
        }
        break
      case 'customer.subscription.updated':
        if (
          hasEffectiveResult(
            'LEGACY_SUBSCRIPTION_LIFECYCLE',
            await runBranch('SUBSCRIPTION_UPDATED', () => dependencies.handlers.subscriptionUpdated(object)),
          )
        ) {
          routes.push('LEGACY_SUBSCRIPTION_LIFECYCLE')
        }
        break
      case 'customer.subscription.deleted':
        if (
          hasEffectiveResult(
            'LEGACY_SUBSCRIPTION_LIFECYCLE',
            await runBranch('SUBSCRIPTION_DELETED', () => dependencies.handlers.subscriptionDeleted(object)),
          )
        ) {
          routes.push('LEGACY_SUBSCRIPTION_LIFECYCLE')
        }
        break
      case 'invoice.payment_succeeded': {
        const result = await runBranch('INVOICE_PAYMENT_SUCCEEDED', () => dependencies.handlers.invoicePaymentSucceeded(object))
        const route = invoiceRoute(result)
        if (route) routes.push(route)
        break
      }
      case 'invoice.payment_failed': {
        const result = await runBranch('INVOICE_PAYMENT_FAILED', () => dependencies.handlers.invoicePaymentFailed(object))
        const route = invoiceRoute(result)
        if (route) routes.push(route)
        break
      }
      case 'customer.subscription.trial_will_end':
        if (
          hasEffectiveResult(
            'LEGACY_SUBSCRIPTION_LIFECYCLE',
            await runBranch('SUBSCRIPTION_TRIAL_WILL_END', () => dependencies.handlers.subscriptionTrialWillEnd(object)),
          )
        ) {
          routes.push('LEGACY_SUBSCRIPTION_LIFECYCLE')
        }
        break
      case 'customer.deleted':
        if (
          hasEffectiveResult(
            'VENUE_BILLING_PROFILE',
            await runBranch('CUSTOMER_DELETED', () => dependencies.handlers.customerDeleted(object)),
          )
        ) {
          routes.push('VENUE_BILLING_PROFILE')
        }
        break
      case 'payment_method.attached':
        if (
          hasEffectiveResult(
            'VENUE_BILLING_PROFILE',
            await runBranch('PAYMENT_METHOD_ATTACHED', () => dependencies.handlers.paymentMethodAttached(object)),
          )
        ) {
          routes.push('VENUE_BILLING_PROFILE')
        }
        break
      case 'payment_intent.succeeded': {
        const result = await runBranch('PAYMENT_INTENT_SUCCEEDED', () => dependencies.handlers.paymentIntentSucceeded(object))
        if (result === 'TOKEN_PAYMENT_INTENT_APPLIED') routes.push('TOKEN_PAYMENT_INTENT')
        break
      }
      case 'payment_intent.payment_failed': {
        const result = await runBranch('PAYMENT_INTENT_FAILED', () => dependencies.handlers.paymentIntentFailed(object))
        if (result === 'TOKEN_PAYMENT_INTENT_APPLIED') routes.push('TOKEN_PAYMENT_INTENT')
        break
      }
      case 'checkout.session.completed': {
        const session = object as Stripe.Checkout.Session
        if (session.metadata?.type === 'credit_pack_purchase') {
          const result = await runBranch('CHECKOUT_CREDIT_PACK', () => dependencies.handlers.creditPackCheckout(session))
          if (hasEffectiveResult('CREDIT_PACK_CHECKOUT', result)) routes.push('CREDIT_PACK_CHECKOUT')
        }
        if (session.metadata?.terminalOrderId) {
          const result = await runBranch('CHECKOUT_TERMINAL_ORDER', () => dependencies.handlers.terminalOrderCheckout(session))
          if (hasEffectiveResult('TERMINAL_ORDER_CHECKOUT', result)) routes.push('TERMINAL_ORDER_CHECKOUT')
        }
        const tierCode = session.metadata?.tierCode
        const paidTier = tierCode && (dependencies.isLegacyPaidPlanTier?.(tierCode) ?? ['PLAN_PRO', 'PLAN_PREMIUM'].includes(tierCode))
        if (paidTier && session.metadata?.venueId) {
          const result = await runBranch('CHECKOUT_LEGACY_PLAN', () => dependencies.handlers.legacyPlanCheckout(session))
          if (hasEffectiveResult('LEGACY_PLAN_CHECKOUT', result)) routes.push('LEGACY_PLAN_CHECKOUT')
        }
        break
      }
      case 'invoice.paid':
        break
      default:
        dependencies.logUnhandled(event.type)
    }

    return { steps, effectiveRouteKeys: uniqueRoutes(routes) }
  }
}
