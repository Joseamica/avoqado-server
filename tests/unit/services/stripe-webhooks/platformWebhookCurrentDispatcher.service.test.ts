import type Stripe from 'stripe'
import {
  EFFECTIVE_ROUTE_RESULT_TABLE,
  createCurrentStripeWebhookDispatcher,
  getDispatchFailureContext,
} from '@/services/stripe-webhooks/platformWebhookCurrentDispatcher.service'

function event(type: string, object: Record<string, unknown> = {}): Stripe.Event {
  return { id: 'evt_dispatch', type, data: { object } } as unknown as Stripe.Event
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const order: string[] = []
  const deps = {
    commercialAdapter: jest.fn(async () => {
      order.push('adapter')
      return { matched: false, applied: false }
    }),
    enrichVenue: jest.fn(async () => {
      order.push('enrichment')
      return 'NOT_APPLICABLE' as const
    }),
    handlers: {
      subscriptionUpdated: jest.fn(async () => {
        order.push('subscription-updated')
        return 'APPLIED' as const
      }),
      subscriptionDeleted: jest.fn(async () => {
        order.push('subscription-deleted')
        return 'APPLIED' as const
      }),
      invoicePaymentSucceeded: jest.fn(
        async (): Promise<
          'SUBSCRIPTION_INVOICE_APPLIED' | 'SUBSCRIPTION_INVOICE_MATCHED_NO_CHANGE' | 'INVOICE_NOOP_VENUE_NOT_OPERATIONAL'
        > => {
          order.push('invoice-succeeded')
          return 'SUBSCRIPTION_INVOICE_APPLIED'
        },
      ),
      invoicePaymentFailed: jest.fn(async () => {
        order.push('invoice-failed')
        return 'SUBSCRIPTION_INVOICE_APPLIED' as const
      }),
      subscriptionTrialWillEnd: jest.fn(async () => {
        order.push('trial-end')
        return 'APPLIED' as const
      }),
      customerDeleted: jest.fn(async () => {
        order.push('customer-deleted')
        return 'APPLIED' as const
      }),
      paymentMethodAttached: jest.fn(async () => {
        order.push('payment-method')
        return 'APPLIED' as const
      }),
      paymentIntentSucceeded: jest.fn(async () => {
        order.push('payment-intent-succeeded')
        return 'TOKEN_PAYMENT_INTENT_APPLIED' as const
      }),
      paymentIntentFailed: jest.fn(async () => {
        order.push('payment-intent-failed')
        return 'TOKEN_PAYMENT_INTENT_APPLIED' as const
      }),
      creditPackCheckout: jest.fn(async () => {
        order.push('credit-pack')
        return 'MATCHED' as const
      }),
      terminalOrderCheckout: jest.fn(async () => {
        order.push('terminal-order')
        return 'APPLIED' as const
      }),
      legacyPlanCheckout: jest.fn(async () => {
        order.push('legacy-plan')
        return 'APPLIED' as const
      }),
    },
    logUnhandled: jest.fn(),
    ...overrides,
  }
  return { deps, order }
}

describe('current Stripe platform effect dispatcher', () => {
  it('runs adapter, venue enrichment and the legacy switch in the frozen order', async () => {
    const { deps, order } = dependencies()
    const dispatch = createCurrentStripeWebhookDispatcher(deps as any)

    const trace = await dispatch(event('customer.subscription.updated'), 'whe_1')

    expect(order).toEqual(['adapter', 'enrichment', 'subscription-updated'])
    expect(trace.steps).toEqual([
      { step: 'COMMERCIAL_ADAPTER', outcome: 'NOT_MATCHED' },
      { step: 'VENUE_ENRICHMENT', outcome: 'NOT_APPLICABLE' },
      { step: 'SUBSCRIPTION_UPDATED', outcome: 'ATTEMPTED' },
      { step: 'SUBSCRIPTION_UPDATED', outcome: 'COMPLETED' },
    ])
    expect(trace.effectiveRouteKeys).toEqual(['LEGACY_SUBSCRIPTION_LIFECYCLE'])
  })

  it('rethrows the same adapter error and records a closed partial failure context', async () => {
    const failure = new Error('adapter failed')
    const { deps, order } = dependencies({
      commercialAdapter: jest.fn(async () => {
        order.push('adapter')
        throw failure
      }),
    })
    const dispatch = createCurrentStripeWebhookDispatcher(deps as any)

    await expect(dispatch(event('invoice.payment_succeeded'), 'whe_1')).rejects.toBe(failure)
    expect(order).toEqual(['adapter'])
    expect(getDispatchFailureContext(failure)).toEqual({
      failureStep: 'COMMERCIAL_ADAPTER',
      steps: [],
      effectiveRouteKeys: [],
    })
  })

  it('records ATTEMPTED without COMPLETED and rethrows the identical legacy handler error', async () => {
    const failure = new Error('invoice failed')
    const { deps } = dependencies()
    deps.handlers.invoicePaymentSucceeded.mockRejectedValue(failure as never)
    const dispatch = createCurrentStripeWebhookDispatcher(deps as any)

    await expect(dispatch(event('invoice.payment_succeeded'), 'whe_1')).rejects.toBe(failure)
    expect(getDispatchFailureContext(failure)).toEqual({
      failureStep: 'INVOICE_PAYMENT_SUCCEEDED',
      steps: [
        { step: 'COMMERCIAL_ADAPTER', outcome: 'NOT_MATCHED' },
        { step: 'VENUE_ENRICHMENT', outcome: 'NOT_APPLICABLE' },
        { step: 'INVOICE_PAYMENT_SUCCEEDED', outcome: 'ATTEMPTED' },
      ],
      effectiveRouteKeys: [],
    })
  })

  it('keeps checkout subroutes independent and in credit pack → terminal → plan order', async () => {
    const { deps, order } = dependencies()
    const dispatch = createCurrentStripeWebhookDispatcher(deps as any)

    const trace = await dispatch(
      event('checkout.session.completed', {
        id: 'cs_all',
        metadata: {
          type: 'credit_pack_purchase',
          terminalOrderId: 'terminal-order-1',
          tierCode: 'PLAN_PRO',
          venueId: 'venue-1',
        },
      }),
      'whe_1',
    )

    expect(order).toEqual(['adapter', 'enrichment', 'credit-pack', 'terminal-order', 'legacy-plan'])
    expect(trace.effectiveRouteKeys).toEqual(['CREDIT_PACK_CHECKOUT', 'TERMINAL_ORDER_CHECKOUT', 'LEGACY_PLAN_CHECKOUT'])
    expect(trace.steps.slice(2)).toEqual([
      { step: 'CHECKOUT_CREDIT_PACK', outcome: 'ATTEMPTED' },
      { step: 'CHECKOUT_CREDIT_PACK', outcome: 'COMPLETED' },
      { step: 'CHECKOUT_TERMINAL_ORDER', outcome: 'ATTEMPTED' },
      { step: 'CHECKOUT_TERMINAL_ORDER', outcome: 'COMPLETED' },
      { step: 'CHECKOUT_LEGACY_PLAN', outcome: 'ATTEMPTED' },
      { step: 'CHECKOUT_LEGACY_PLAN', outcome: 'COMPLETED' },
    ])
  })

  it('leaves invoice.paid adapter-only after enrichment and does not enter the legacy switch', async () => {
    const { deps, order } = dependencies({
      commercialAdapter: jest.fn(async () => {
        order.push('adapter')
        return { matched: true, applied: false }
      }),
    })
    const dispatch = createCurrentStripeWebhookDispatcher(deps as any)

    const trace = await dispatch(event('invoice.paid'), 'whe_1')

    expect(order).toEqual(['adapter', 'enrichment'])
    expect(trace.steps).toEqual([
      { step: 'COMMERCIAL_ADAPTER', outcome: 'MATCHED_NOOP' },
      { step: 'VENUE_ENRICHMENT', outcome: 'NOT_APPLICABLE' },
    ])
    expect(trace.effectiveRouteKeys).toEqual(['COMMERCIAL_SUBSCRIPTION_LIFECYCLE'])
  })

  it.each([
    ['invoice.payment_succeeded', 'INVOICE_PAYMENT_SUCCEEDED', 'TOKEN_INVOICE_APPLIED', 'TOKEN_INVOICE'],
    ['invoice.payment_failed', 'INVOICE_PAYMENT_FAILED', 'SUBSCRIPTION_INVOICE_MATCHED_NO_CHANGE', 'LEGACY_SUBSCRIPTION_LIFECYCLE'],
    ['payment_intent.succeeded', 'PAYMENT_INTENT_SUCCEEDED', 'TOKEN_PAYMENT_INTENT_APPLIED', 'TOKEN_PAYMENT_INTENT'],
    ['payment_intent.payment_failed', 'PAYMENT_INTENT_FAILED', 'PAYMENT_INTENT_NOOP_NOT_TOKEN', null],
  ])('maps the effective internal result for %s', async (type, step, result, route) => {
    const { deps } = dependencies()
    const key =
      type === 'invoice.payment_succeeded'
        ? 'invoicePaymentSucceeded'
        : type === 'invoice.payment_failed'
          ? 'invoicePaymentFailed'
          : type === 'payment_intent.succeeded'
            ? 'paymentIntentSucceeded'
            : 'paymentIntentFailed'
    ;(deps.handlers as any)[key].mockResolvedValue(result)
    const dispatch = createCurrentStripeWebhookDispatcher(deps as any)

    const trace = await dispatch(event(type), 'whe_1')

    expect(trace.steps.slice(-2)).toEqual([
      { step, outcome: 'ATTEMPTED' },
      { step, outcome: 'COMPLETED' },
    ])
    expect(trace.effectiveRouteKeys).toEqual(route ? [route] : [])
  })

  it('logs an unknown type without fabricating a current business route', async () => {
    const { deps } = dependencies()
    const dispatch = createCurrentStripeWebhookDispatcher(deps as any)

    const trace = await dispatch(event('invoice.upcoming'), 'whe_1')

    expect(deps.logUnhandled).toHaveBeenCalledWith('invoice.upcoming')
    expect(trace.effectiveRouteKeys).toEqual([])
  })

  it('freezes a result-effective mapping for all eight route keys', () => {
    expect(Object.keys(EFFECTIVE_ROUTE_RESULT_TABLE).sort()).toEqual(
      [
        'COMMERCIAL_SUBSCRIPTION_LIFECYCLE',
        'LEGACY_PLAN_CHECKOUT',
        'LEGACY_SUBSCRIPTION_LIFECYCLE',
        'TERMINAL_ORDER_CHECKOUT',
        'TOKEN_PAYMENT_INTENT',
        'TOKEN_INVOICE',
        'CREDIT_PACK_CHECKOUT',
        'VENUE_BILLING_PROFILE',
      ].sort(),
    )
    expect(EFFECTIVE_ROUTE_RESULT_TABLE).toEqual({
      COMMERCIAL_SUBSCRIPTION_LIFECYCLE: ['MATCHED_APPLIED', 'MATCHED_NOOP'],
      LEGACY_PLAN_CHECKOUT: ['APPLIED', 'MATCHED_NO_CHANGE'],
      LEGACY_SUBSCRIPTION_LIFECYCLE: [
        'APPLIED',
        'MATCHED_NO_CHANGE',
        'SUBSCRIPTION_INVOICE_APPLIED',
        'SUBSCRIPTION_INVOICE_MATCHED_NO_CHANGE',
      ],
      TERMINAL_ORDER_CHECKOUT: ['APPLIED', 'MATCHED_NO_CHANGE'],
      TOKEN_PAYMENT_INTENT: ['TOKEN_PAYMENT_INTENT_APPLIED'],
      TOKEN_INVOICE: ['TOKEN_INVOICE_APPLIED'],
      CREDIT_PACK_CHECKOUT: ['MATCHED'],
      VENUE_BILLING_PROFILE: ['APPLIED', 'MATCHED_NO_CHANGE'],
    })
  })

  it('does not fabricate checkout routes when metadata is absent', async () => {
    const { deps } = dependencies()
    const dispatch = createCurrentStripeWebhookDispatcher(deps as any)

    const trace = await dispatch(event('checkout.session.completed', { id: 'cs_without_metadata' }), 'whe_1')

    expect(trace.effectiveRouteKeys).toEqual([])
    expect(deps.handlers.creditPackCheckout).not.toHaveBeenCalled()
    expect(deps.handlers.terminalOrderCheckout).not.toHaveBeenCalled()
    expect(deps.handlers.legacyPlanCheckout).not.toHaveBeenCalled()
  })

  it.each([
    ['customer.subscription.updated', 'subscriptionUpdated', {}, 'LEGACY_SUBSCRIPTION_LIFECYCLE'],
    ['customer.subscription.deleted', 'subscriptionDeleted', {}, 'LEGACY_SUBSCRIPTION_LIFECYCLE'],
    ['customer.subscription.trial_will_end', 'subscriptionTrialWillEnd', {}, 'LEGACY_SUBSCRIPTION_LIFECYCLE'],
    ['customer.deleted', 'customerDeleted', {}, 'VENUE_BILLING_PROFILE'],
    ['payment_method.attached', 'paymentMethodAttached', {}, 'VENUE_BILLING_PROFILE'],
  ] as const)('derives %s only from the effective %s result', async (type, handler, object, route) => {
    const { deps } = dependencies()
    const dispatch = createCurrentStripeWebhookDispatcher(deps as any)
    ;(deps.handlers[handler] as jest.Mock).mockResolvedValueOnce('NOOP_SUBJECT_NOT_FOUND')
    await expect(dispatch(event(type, object), 'whe_1')).resolves.toMatchObject({ effectiveRouteKeys: [] })
    ;(deps.handlers[handler] as jest.Mock).mockResolvedValueOnce('MATCHED_NO_CHANGE')
    await expect(dispatch(event(type, object), 'whe_2')).resolves.toMatchObject({ effectiveRouteKeys: [route] })
  })

  it('derives each checkout subroute independently from its closed handler result, not metadata alone', async () => {
    const { deps } = dependencies()
    deps.handlers.creditPackCheckout.mockResolvedValueOnce('NOOP_SUBJECT_NOT_FOUND' as any)
    deps.handlers.terminalOrderCheckout.mockResolvedValueOnce('MATCHED_NO_CHANGE' as any)
    deps.handlers.legacyPlanCheckout.mockResolvedValueOnce('NOOP_NOT_APPLICABLE' as any)
    const dispatch = createCurrentStripeWebhookDispatcher(deps as any)

    const trace = await dispatch(
      event('checkout.session.completed', {
        id: 'cs_conflicting_metadata',
        metadata: {
          type: 'credit_pack_purchase',
          terminalOrderId: 'terminal-order-1',
          tierCode: 'PLAN_PRO',
          venueId: 'venue-1',
        },
      }),
      'whe_1',
    )

    expect(trace.effectiveRouteKeys).toEqual(['TERMINAL_ORDER_CHECKOUT'])
  })

  it.each([
    ['INVOICE_NOOP_VENUE_NOT_OPERATIONAL', null],
    ['SUBSCRIPTION_INVOICE_MATCHED_NO_CHANGE', 'LEGACY_SUBSCRIPTION_LIFECYCLE'],
  ] as const)('does not infer invoice authority from the outer type for %s', async (result, route) => {
    const { deps } = dependencies()
    deps.handlers.invoicePaymentSucceeded.mockResolvedValueOnce(result)
    const dispatch = createCurrentStripeWebhookDispatcher(deps as any)

    const trace = await dispatch(event('invoice.payment_succeeded'), 'whe_1')

    expect(trace.effectiveRouteKeys).toEqual(route ? [route] : [])
  })
})
