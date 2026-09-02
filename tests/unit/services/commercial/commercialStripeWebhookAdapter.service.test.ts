import {
  createCommercialStripeWebhookAdapter,
  type CommercialStripeReference,
} from '@/services/commercial/commercialStripeWebhookAdapter.service'
import type { CommercialLifecycleEvent } from '@/services/commercial/commercialSubscriptionLifecycle.service'

function stripeEvent(type: string, object: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_12345',
    type,
    created: 1787400000,
    data: { object },
    ...overrides,
  } as any
}

function harness(reference: CommercialStripeReference | null = null) {
  const lifecycle = {
    reconcile: jest.fn(async (_event: CommercialLifecycleEvent) => ({ matched: true, applied: true, status: 'ACTIVE' })),
  }
  const resolver = {
    fromInvoice: jest.fn(async () => reference),
    fromCharge: jest.fn(async () => reference),
  }
  const adapter = createCommercialStripeWebhookAdapter({ lifecycle, resolver })
  return { lifecycle, resolver, adapter }
}

describe('commercial Stripe webhook adapter', () => {
  it('maps completed commercial Checkout without trusting any amount metadata', async () => {
    const { adapter, lifecycle } = harness()
    const event = stripeEvent('checkout.session.completed', {
      id: 'cs_1',
      subscription: 'sub_1',
      payment_status: 'paid',
      amount_total: 1,
      metadata: { type: 'commercial_subscription_v1', acceptanceId: 'acceptance-1', totalMinor: '1' },
    })

    await expect(adapter.reconcile(event)).resolves.toMatchObject({ matched: true })
    expect(lifecycle.reconcile).toHaveBeenCalledWith({
      stripeEventId: 'evt_12345',
      type: 'CHECKOUT_COMPLETED',
      effectiveAt: new Date(1787400000 * 1000),
      acceptanceId: 'acceptance-1',
      stripeCheckoutSessionId: 'cs_1',
      stripeSubscriptionId: 'sub_1',
    })
  })

  it('does not activate an unpaid completed Checkout and activates its later async success', async () => {
    const { adapter, lifecycle } = harness()
    const session = {
      id: 'cs_delayed',
      subscription: 'sub_delayed',
      payment_status: 'unpaid',
      metadata: { type: 'commercial_subscription_v1', acceptanceId: 'acceptance-delayed' },
    }

    await expect(adapter.reconcile(stripeEvent('checkout.session.completed', session))).resolves.toEqual({
      matched: false,
      applied: false,
    })
    await expect(
      adapter.reconcile(
        stripeEvent('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' }, { id: 'evt_async_paid' }),
      ),
    ).resolves.toMatchObject({ matched: true, applied: true })
    expect(lifecycle.reconcile).toHaveBeenCalledTimes(1)
    expect(lifecycle.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeEventId: 'evt_async_paid',
        type: 'CHECKOUT_COMPLETED',
        acceptanceId: 'acceptance-delayed',
        stripeCheckoutSessionId: 'cs_delayed',
        stripeSubscriptionId: 'sub_delayed',
      }),
    )
  })

  it.each([
    ['invoice.payment_succeeded', 'INVOICE_PAID'],
    ['invoice.payment_failed', 'INVOICE_FAILED'],
  ] as const)('maps %s through subscription metadata', async (stripeType, lifecycleType) => {
    const { adapter, lifecycle } = harness()
    await adapter.reconcile(
      stripeEvent(stripeType, {
        id: 'in_1',
        parent: {
          subscription_details: {
            subscription: 'sub_1',
            metadata: { type: 'commercial_subscription_v1', acceptanceId: 'acceptance-1' },
          },
        },
      }),
    )

    expect(lifecycle.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        type: lifecycleType,
        acceptanceId: 'acceptance-1',
        stripeSubscriptionId: 'sub_1',
      }),
    )
  })

  it('maps cancellation and dispute outcomes to explicit lifecycle events', async () => {
    const { adapter, lifecycle } = harness({ acceptanceId: 'acceptance-1', stripeSubscriptionId: 'sub_1' })
    await adapter.reconcile(
      stripeEvent('customer.subscription.deleted', {
        id: 'sub_1',
        metadata: { type: 'commercial_subscription_v1', acceptanceId: 'acceptance-1' },
      }),
    )
    await adapter.reconcile(stripeEvent('charge.dispute.created', { id: 'dp_1', charge: 'ch_1' }, { id: 'evt_dispute_open' }))
    await adapter.reconcile(stripeEvent('charge.dispute.closed', { id: 'dp_1', charge: 'ch_1', status: 'won' }, { id: 'evt_dispute_won' }))

    expect(lifecycle.reconcile.mock.calls.map(call => call[0].type)).toEqual(['SUBSCRIPTION_CANCELED', 'DISPUTE_OPENED', 'DISPUTE_WON'])
  })

  it('distinguishes full and partial refunds without revoking access for a partial refund', async () => {
    const { adapter, lifecycle } = harness({ acceptanceId: 'acceptance-1', stripeSubscriptionId: 'sub_1' })
    await adapter.reconcile(
      stripeEvent(
        'charge.refunded',
        {
          id: 'ch_partial',
          invoice: 'in_1',
          amount: 10000,
          amount_refunded: 2000,
        },
        { id: 'evt_partial' },
      ),
    )
    await adapter.reconcile(
      stripeEvent(
        'charge.refunded',
        {
          id: 'ch_full',
          invoice: 'in_2',
          amount: 10000,
          amount_refunded: 10000,
        },
        { id: 'evt_full' },
      ),
    )

    expect(lifecycle.reconcile.mock.calls.map(call => call[0].type)).toEqual(['PARTIAL_REFUND', 'REFUND_SUCCEEDED'])
  })

  it('ignores unrelated Stripe events and unresolved non-commercial charges', async () => {
    const { adapter, lifecycle } = harness(null)

    await expect(
      adapter.reconcile(
        stripeEvent('checkout.session.completed', {
          id: 'cs_other',
          metadata: { type: 'terminal_order' },
        }),
      ),
    ).resolves.toEqual({ matched: false, applied: false })
    await expect(
      adapter.reconcile(
        stripeEvent('charge.refunded', {
          id: 'ch_other',
          invoice: 'in_other',
          amount: 100,
          amount_refunded: 100,
        }),
      ),
    ).resolves.toEqual({ matched: false, applied: false })
    expect(lifecycle.reconcile).not.toHaveBeenCalled()
  })
})
