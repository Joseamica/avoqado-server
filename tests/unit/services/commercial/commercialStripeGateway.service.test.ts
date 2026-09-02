import type Stripe from 'stripe'
import { createCommercialStripeGateway } from '@/services/commercial/commercialStripeGateway.service'
import type { CommercialQuoteV1 } from '@/types/commercialQuote'

const promotionalQuote: CommercialQuoteV1 = {
  schemaVersion: 1,
  quoteId: 'quote-1',
  catalogPublicationId: 'publication-1',
  campaignVersionId: 'campaign-version-1',
  campaignCode: 'POS_50',
  market: 'MX',
  currency: 'MXN',
  quotedAt: '2026-08-22T12:00:00.000Z',
  expiresAt: '2026-08-22T12:30:00.000Z',
  lines: [
    {
      targetType: 'PRODUCT',
      targetCode: 'POS',
      priceCode: 'POS_MONTHLY',
      quantity: 1,
      productKind: 'POS',
      name: 'Punto de venta',
      billingUnit: 'VENUE_MONTH',
      currency: 'MXN',
      taxRateBasisPoints: 1600,
      unitAmountMinor: 24900,
      listSubtotalMinor: 24900,
      adjustments: [
        {
          ruleCode: 'POS_FIXED_50',
          type: 'FIXED_PRICE',
          beforeMinor: 24900,
          afterMinor: 5000,
          discountMinor: 19900,
          cycles: 3,
        },
      ],
      discountMinor: 19900,
      subtotalMinor: 5000,
      taxMinor: 800,
      totalMinor: 5800,
      promotionalCycles: 3,
      renewalSubtotalMinor: 24900,
      renewalTaxMinor: 3984,
      renewalTotalMinor: 28884,
    },
  ],
  totals: {
    listSubtotalMinor: 24900,
    discountMinor: 19900,
    subtotalMinor: 5000,
    taxMinor: 800,
    totalMinor: 5800,
  },
  renewal: { subtotalMinor: 24900, taxMinor: 3984, totalMinor: 28884 },
}

function harness(overrides?: { customerId?: string | null; quote?: CommercialQuoteV1 }) {
  const stripe = {
    taxRates: {
      create: jest.fn(async () => ({ id: 'txr-iva-16' })),
    },
    coupons: {
      create: jest.fn(async () => ({ id: 'coupon-1' })),
    },
    checkout: {
      sessions: {
        create: jest.fn(async (_params: Stripe.Checkout.SessionCreateParams, _options?: Stripe.RequestOptions) => ({
          id: 'cs_test_1',
          url: 'https://checkout.stripe.test/cs_test_1',
        })),
      },
    },
  }
  const loadBillingContext = jest.fn(async () => ({
    venueId: 'venue-1',
    venueName: 'Café Centro',
    venueSlug: 'cafe-centro',
    organizationId: 'org-1',
    billingEmail: 'owner@example.com',
    stripeCustomerId: overrides?.customerId ?? null,
  }))
  const gateway = createCommercialStripeGateway({
    stripe,
    loadBillingContext,
    frontendUrl: 'https://dashboard.avoqado.test',
  })
  const input = {
    acceptanceId: 'acceptance-1',
    quoteId: 'quote-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    idempotencyKey: 'commercial:acceptance-1:checkout-session',
    frozenQuote: overrides?.quote ?? promotionalQuote,
  }
  return { stripe, loadBillingContext, gateway, input }
}

describe('commercial Stripe gateway', () => {
  it('turns a frozen $249 → $50 quote into an exact 3-cycle subscription discount', async () => {
    const { stripe, gateway, input } = harness()

    await expect(gateway.createCheckoutSession(input)).resolves.toEqual({
      checkoutSessionId: 'cs_test_1',
      checkoutUrl: 'https://checkout.stripe.test/cs_test_1',
    })

    expect(stripe.coupons.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount_off: 23084,
        currency: 'mxn',
        duration: 'repeating',
        duration_in_months: 3,
        metadata: expect.objectContaining({ acceptanceId: 'acceptance-1', quoteId: 'quote-1' }),
      }),
      { idempotencyKey: 'commercial:acceptance-1:checkout-session:coupon' },
    )
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer_email: 'owner@example.com',
        allow_promotion_codes: false,
        discounts: [{ coupon: 'coupon-1' }],
        line_items: [
          {
            quantity: 1,
            tax_rates: ['txr-iva-16'],
            price_data: expect.objectContaining({
              currency: 'mxn',
              unit_amount: 28884,
              tax_behavior: 'inclusive',
              recurring: { interval: 'month', interval_count: 1 },
            }),
          },
        ],
        metadata: expect.objectContaining({
          type: 'commercial_subscription_v1',
          acceptanceId: 'acceptance-1',
          quoteId: 'quote-1',
          venueId: 'venue-1',
        }),
      }),
      { idempotencyKey: 'commercial:acceptance-1:checkout-session:session' },
    )
  })

  it('uses the existing Stripe customer and omits coupon creation for a base quote', async () => {
    const baseQuote: CommercialQuoteV1 = {
      ...promotionalQuote,
      campaignVersionId: null,
      campaignCode: null,
      lines: promotionalQuote.lines.map(line => ({
        ...line,
        adjustments: [],
        discountMinor: 0,
        subtotalMinor: 24900,
        taxMinor: 3984,
        totalMinor: 28884,
        promotionalCycles: null,
      })),
      totals: {
        listSubtotalMinor: 24900,
        discountMinor: 0,
        subtotalMinor: 24900,
        taxMinor: 3984,
        totalMinor: 28884,
      },
    }
    const { stripe, gateway, input } = harness({ customerId: 'cus_existing', quote: baseQuote })

    await gateway.createCheckoutSession(input)

    expect(stripe.coupons.create).not.toHaveBeenCalled()
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_existing',
        discounts: undefined,
      }),
      expect.any(Object),
    )
    expect(stripe.checkout.sessions.create.mock.calls[0][0]).not.toHaveProperty('customer_email')
  })

  it('fails closed before contacting Stripe when the frozen quote cannot be represented exactly', async () => {
    const mixedQuote: CommercialQuoteV1 = {
      ...promotionalQuote,
      lines: [
        promotionalQuote.lines[0],
        { ...promotionalQuote.lines[0], targetCode: 'PRO', priceCode: 'PRO_ANNUAL', billingUnit: 'VENUE_YEAR' },
      ],
      totals: {
        listSubtotalMinor: 49800,
        discountMinor: 39800,
        subtotalMinor: 10000,
        taxMinor: 1600,
        totalMinor: 11600,
      },
      renewal: { subtotalMinor: 49800, taxMinor: 7968, totalMinor: 57768 },
    }
    const { stripe, gateway, input } = harness({ quote: mixedQuote })

    await expect(gateway.createCheckoutSession(input)).rejects.toMatchObject({
      code: 'COMMERCIAL_STRIPE_QUOTE_NOT_REPRESENTABLE',
    })
    expect(stripe.coupons.create).not.toHaveBeenCalled()
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('rejects a quote or tenant mismatch before contacting Stripe', async () => {
    const { stripe, gateway, input } = harness()

    await expect(gateway.createCheckoutSession({ ...input, quoteId: 'quote-other' })).rejects.toMatchObject({
      code: 'COMMERCIAL_STRIPE_QUOTE_INVALID',
    })
    await expect(gateway.createCheckoutSession({ ...input, organizationId: 'org-other' })).rejects.toMatchObject({
      code: 'COMMERCIAL_STRIPE_BILLING_SCOPE_MISMATCH',
    })
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('rejects a frozen Quote v3 before loading billing data or contacting Stripe', async () => {
    const { stripe, loadBillingContext, gateway, input } = harness()

    await expect(
      gateway.createCheckoutSession({
        ...input,
        frozenQuote: { ...promotionalQuote, schemaVersion: 3 },
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_STRIPE_QUOTE_INVALID' })

    expect(loadBillingContext).not.toHaveBeenCalled()
    expect(stripe.taxRates.create).not.toHaveBeenCalled()
    expect(stripe.coupons.create).not.toHaveBeenCalled()
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })
})
