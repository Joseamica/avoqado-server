import { prismaMock } from '../../../__helpers__/setup'
const create = jest.fn()
const list = jest.fn()
const retrieve = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    subscriptions: {
      create: (...args: unknown[]) => create(...args),
      list: (...args: unknown[]) => list(...args),
      retrieve: (...args: unknown[]) => retrieve(...args),
    },
  },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
import { provisionHybridPurchase } from '@/services/launchCampaigns/hybridProvision.service'
const pub = { id: 'pub', definitionHash: 'pub-hash', stripePriceId: 'price_test', stripeProductId: 'prod_test' }
const purchase = {
  id: 'purchase',
  venueId: 'venue',
  status: 'ACCEPTED',
  acceptedAt: new Date(),
  stripeCustomerId: 'cus_test',
  stripeSubscriptionId: null,
  quoteHash: 'quote-hash',
  quote: {
    schemaVersion: 1,
    total: '379.50',
    credit: '0.00',
    dueNow: '379.50',
    sources: [],
    lines: [{ publicationId: 'pub', definitionHash: 'pub-hash', planTier: null, featureCodes: ['CFDI', 'LOYALTY_PROGRAM'] }],
  },
}
const sub = {
  id: 'sub_test',
  customer: 'cus_test',
  status: 'incomplete',
  metadata: { kind: 'HYBRID_PURCHASE', hybridPurchaseId: 'purchase', venueId: 'venue', quoteHash: 'quote-hash' },
  items: {
    has_more: false,
    data: [{ id: 'si_test', quantity: 1, price: { id: 'price_test' }, current_period_start: 100, current_period_end: 200 }],
  },
  latest_invoice: {
    id: 'in_test',
    customer: 'cus_test',
    currency: 'mxn',
    total: 37950,
    amount_due: 37950,
    status: 'open',
    auto_advance: false,
    attempted: false,
    hosted_invoice_url: 'https://invoice.stripe.com/i/test',
  },
}
beforeEach(() => {
  prismaMock.hybridPurchase.findUnique.mockResolvedValue(purchase)
  prismaMock.hybridPurchase.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.hybridOfferPublication.findMany.mockResolvedValue([pub])
  prismaMock.hybridBillingOperation.upsert.mockImplementation(async ({ create: data }: any) => ({
    id: 'op',
    ...data,
    createdAt: new Date(),
    providerId: null,
  }))
  prismaMock.hybridBillingOperation.update.mockResolvedValue({})
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.hybridContract.createMany.mockResolvedValue({ count: 1 })
  prismaMock.hybridContract.findMany.mockResolvedValue([
    { publicationId: 'pub', stripeItemId: 'si_test', featureCodes: ['CFDI', 'LOYALTY_PROGRAM'], planTier: null },
  ])
  prismaMock.activityLog.create.mockResolvedValue({})
  list.mockReset().mockResolvedValue({ data: [], has_more: false })
  retrieve.mockReset().mockResolvedValue(sub)
  create.mockReset().mockResolvedValue(sub)
})
describe('provisioning the accepted intent', () => {
  it('expires an untouched accepted purchase before recording any provider operation', async () => {
    const expired = { ...purchase, quotedById: 'staff', paymentExpiresAt: new Date(Date.now() - 1) }
    prismaMock.hybridPurchase.findUnique.mockResolvedValue(expired)
    prismaMock.hybridPurchase.findUniqueOrThrow.mockResolvedValue(expired)
    prismaMock.hybridBillingOperation.findUnique.mockResolvedValue(null)
    prismaMock.hybridRedemption.findMany.mockResolvedValue([{ campaignId: 'campaign' }])
    prismaMock.hybridCampaign.updateMany.mockResolvedValue({ count: 1 })
    await expect(provisionHybridPurchase('venue', 'purchase')).resolves.toMatchObject({ purchaseId: 'purchase', status: 'EXPIRED' })
    expect(prismaMock.hybridBillingOperation.upsert).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(prismaMock.hybridRedemption.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'RELEASED' } }))
  })
  it('recovers a provider operation after the payment window instead of freeing uncertain payment', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({ ...purchase, paymentExpiresAt: new Date(Date.now() - 1) })
    prismaMock.hybridBillingOperation.findUnique.mockResolvedValue({ providerId: null, status: 'UNKNOWN' })
    list.mockResolvedValue({ data: [sub], has_more: false })
    await expect(provisionHybridPurchase('venue', 'purchase')).resolves.toMatchObject({ status: 'PAYMENT_PENDING' })
    expect(create).not.toHaveBeenCalled()
    expect(prismaMock.hybridRedemption.updateMany).not.toHaveBeenCalled()
  })
  it('opens one human-confirmed invoice for N grants without enabling them before payment', async () => {
    const result = await provisionHybridPurchase('venue', 'purchase')
    expect(result).toMatchObject({ status: 'PAYMENT_PENDING', paymentUrl: sub.latest_invoice.hosted_invoice_url })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_behavior: 'default_incomplete',
        customer: 'cus_test',
        payment_settings: { save_default_payment_method: 'on_subscription', payment_method_types: ['card'] },
      }),
      expect.objectContaining({ idempotencyKey: 'hybrid:op' }),
    )
    expect(prismaMock.hybridBillingOperation.upsert.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0])
    expect(prismaMock.capabilityGrant.createMany).not.toHaveBeenCalled()
  })
  it('recovers the same subscription after a lost create response', async () => {
    list.mockResolvedValue({ data: [sub], has_more: false })
    await provisionHybridPurchase('venue', 'purchase')
    expect(create).not.toHaveBeenCalled()
    expect(retrieve).toHaveBeenCalledWith('sub_test', expect.anything(), expect.anything())
  })
  it('does not expose a payable link if Stripe changed the total or customer', async () => {
    create.mockResolvedValueOnce({ ...sub, latest_invoice: { ...sub.latest_invoice, amount_due: 37951 } })
    await expect(provisionHybridPurchase('venue', 'purchase')).rejects.toThrow()
    expect(prismaMock.hybridContract.createMany).not.toHaveBeenCalled()
  })
  it('does not start a subscription for a quote that was never accepted', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValueOnce({ ...purchase, status: 'QUOTED' })
    await expect(provisionHybridPurchase('venue', 'purchase')).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })
  it('continues an accepted purchase even when new sales are paused', async () => {
    process.env.HYBRID_BILLING_ENABLED = 'false'
    await expect(provisionHybridPurchase('venue', 'purchase')).resolves.toMatchObject({ purchaseId: 'purchase' })
    delete process.env.HYBRID_BILLING_ENABLED
  })
  it('rejects duplicated provider prices that omit another purchased offer', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({
      ...purchase,
      quote: {
        ...purchase.quote,
        lines: [...purchase.quote.lines, { ...purchase.quote.lines[0], publicationId: 'pub2', definitionHash: 'pub2-hash' }],
      },
    })
    prismaMock.hybridOfferPublication.findMany.mockResolvedValue([
      pub,
      { ...pub, id: 'pub2', definitionHash: 'pub2-hash', stripePriceId: 'price_second' },
    ])
    create.mockResolvedValue({
      ...sub,
      items: { has_more: false, data: [...sub.items.data, { ...sub.items.data[0], id: 'si_duplicate' }] },
    })
    await expect(provisionHybridPurchase('venue', 'purchase')).rejects.toMatchObject({ cause: { code: 'HYBRID_INVOICE_MISMATCH' } })
    expect(prismaMock.hybridContract.createMany).not.toHaveBeenCalled()
  })
  it('does not silently accept a conflicting contract after an idempotent insert', async () => {
    prismaMock.hybridContract.findMany.mockResolvedValue([])
    await expect(provisionHybridPurchase('venue', 'purchase')).rejects.toThrow()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
  it('does not audit unchanged payment-status polling', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({
      ...purchase,
      status: 'PAYMENT_PENDING',
      stripeSubscriptionId: sub.id,
      initialInvoiceId: sub.latest_invoice.id,
    })
    await provisionHybridPurchase('venue', 'purchase')
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})
