import { prismaMock } from '../../../__helpers__/setup'
const retrieveSub = jest.fn(),
  retrieveInvoice = jest.fn(),
  cancelSub = jest.fn(),
  voidInvoice = jest.fn()
const deliver = jest.fn(),
  provision = jest.fn()
const invoicePayments = jest.fn(),
  chargeRetrieve = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    subscriptions: { retrieve: (...args: unknown[]) => retrieveSub(...args), cancel: (...args: unknown[]) => cancelSub(...args) },
    invoices: { retrieve: (...args: unknown[]) => retrieveInvoice(...args), voidInvoice: (...args: unknown[]) => voidInvoice(...args) },
    invoicePayments: { list: (...args: unknown[]) => invoicePayments(...args) },
    charges: { retrieve: (...args: unknown[]) => chargeRetrieve(...args) },
  },
  STRIPE_DENTRO_DEL_CANDADO: {},
}))
jest.mock('@/services/launchCampaigns/hybridDelivery.service', () => ({ reconcileHybridInvoice: (...args: unknown[]) => deliver(...args) }))
jest.mock('@/services/launchCampaigns/hybridProvision.service', () => ({
  provisionHybridPurchase: (...args: unknown[]) => provision(...args),
}))
const endLapsed = jest.fn()
jest.mock('@/services/launchCampaigns/hybridSeats', () => ({ endLapsedHybridContracts: (...args: unknown[]) => endLapsed(...args) }))
import {
  cancelHybridPurchase,
  reconcileHybridPurchase,
  handleHybridStripeEvent,
  reconcileHybridBatch,
} from '@/services/launchCampaigns/hybridLifecycle.service'
const purchase = {
  id: 'purchase',
  venueId: 'venue',
  quotedById: 'staff',
  status: 'ACCEPTED',
  stripeCustomerId: 'cus',
  stripeSubscriptionId: null,
  initialInvoiceId: null,
}
beforeEach(() => {
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.hybridPurchase.findUnique.mockResolvedValue(purchase)
  prismaMock.hybridPurchase.findUniqueOrThrow.mockResolvedValue(purchase)
  prismaMock.hybridBillingOperation.findUnique.mockResolvedValue(null)
  prismaMock.hybridRedemption.findMany.mockResolvedValue([{ id: 'redemption', campaignId: 'campaign' }])
  prismaMock.hybridCampaign.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.hybridBillingOperation.upsert.mockImplementation(async ({ create: data }: any) => ({
    id: data.step,
    ...data,
    createdAt: new Date(),
    providerId: null,
  }))
  retrieveSub.mockReset()
  retrieveInvoice.mockReset()
  cancelSub.mockReset()
  voidInvoice.mockReset()
  deliver.mockReset()
  provision.mockReset()
  invoicePayments.mockReset()
  chargeRetrieve.mockReset()
  endLapsed.mockReset().mockResolvedValue(0)
})
describe('safe purchase recovery and abandonment', () => {
  it('after reconciling a completed purchase, ends contracts whose cancellation took effect', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({
      ...purchase,
      status: 'COMPLETED',
      stripeSubscriptionId: 'sub',
      initialInvoiceId: 'in_first',
    })
    retrieveSub.mockResolvedValue({ latest_invoice: 'in_renewal' })
    const order: string[] = []
    deliver.mockImplementation(async () => {
      order.push('deliver')
      return { status: 'ACTIVE' }
    })
    endLapsed.mockImplementation(async () => {
      order.push('lapsed')
      return 1
    })
    await reconcileHybridPurchase('venue', 'purchase')
    expect(endLapsed).toHaveBeenCalledWith('venue', 'purchase')
    expect(order).toEqual(['deliver', 'lapsed'])
  })

  it('a purchase still being paid never ends contracts', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({ ...purchase, status: 'PAYMENT_PENDING', initialInvoiceId: 'in_first' })
    deliver.mockResolvedValue({ status: 'PAYMENT_PENDING' })
    await reconcileHybridPurchase('venue', 'purchase')
    expect(endLapsed).not.toHaveBeenCalled()
  })

  it('keeps an unpaid renewal separate from provisioning the already completed first purchase', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({
      ...purchase,
      status: 'COMPLETED',
      stripeSubscriptionId: 'sub',
      initialInvoiceId: 'in_first',
    })
    retrieveSub.mockResolvedValue({ latest_invoice: 'in_renewal' })
    deliver.mockResolvedValue({ status: 'PAYMENT_PENDING' })
    await expect(reconcileHybridPurchase('venue', 'purchase')).resolves.toEqual({ status: 'RENEWAL_PENDING' })
    expect(provision).not.toHaveBeenCalled()
  })
  it('resolves direct refunds and disputes through all invoices actually funded by the charge', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({
      ...purchase,
      status: 'COMPLETED',
      stripeSubscriptionId: 'sub',
      initialInvoiceId: 'in_first',
    })
    chargeRetrieve.mockResolvedValue({ id: 'ch', payment_intent: 'pi' })
    invoicePayments.mockResolvedValue({ data: [{ invoice: 'in_first' }, { invoice: 'in_second' }], has_more: false })
    retrieveInvoice.mockImplementation(async (id: string) => ({ id, parent: { subscription_details: { subscription: 'sub' } } }))
    for (const type of ['charge.refunded', 'charge.dispute.created', 'charge.dispute.closed']) {
      await expect(
        handleHybridStripeEvent({ type, data: { object: type === 'charge.refunded' ? { id: 'ch' } : { charge: 'ch' } } } as any),
      ).resolves.toBe(true)
    }
    expect(deliver).toHaveBeenCalledWith('venue', 'purchase', 'in_first')
    expect(deliver).toHaveBeenCalledWith('venue', 'purchase', 'in_second')
    invoicePayments.mockResolvedValue({ data: [], has_more: true })
    await expect(handleHybridStripeEvent({ type: 'charge.refunded', data: { object: { id: 'ch' } } } as any)).rejects.toMatchObject({
      code: 'HYBRID_PROVIDER_UNKNOWN',
    })
  })
  it('queues customers whose transferred legacy payment was refunded without swallowing the legacy webhook', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue(null)
    chargeRetrieve.mockResolvedValue({ id: 'ch_legacy', payment_intent: 'pi_legacy' })
    invoicePayments.mockResolvedValue({ data: [{ invoice: 'in_legacy' }], has_more: false })
    retrieveInvoice.mockResolvedValue({
      id: 'in_legacy',
      customer: 'cus',
      parent: { subscription_details: { subscription: 'sub_legacy' } },
    })
    await expect(handleHybridStripeEvent({ type: 'charge.refunded', data: { object: { id: 'ch_legacy' } } } as any)).resolves.toBe(false)
    expect(prismaMock.hybridPurchase.updateMany).toHaveBeenCalledWith({
      where: { stripeCustomerId: 'cus', status: 'COMPLETED', contracts: { some: { endedAt: null } } },
      data: { nextAttemptAt: expect.any(Date) },
    })
  })
  it('releases an accepted intent only while no provider operation has been prepared', async () => {
    await expect(cancelHybridPurchase('venue', 'purchase', 'staff')).resolves.toMatchObject({ status: 'CANCELLED' })
    expect(prismaMock.$queryRaw).toHaveBeenCalled()
    expect(prismaMock.hybridCreditAllocation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'RELEASED' } }))
    expect(prismaMock.hybridCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reservedCount: { decrement: 1 } } }),
    )
  })
  it('never frees a prepared unknown request or creates a subscription while cancelling', async () => {
    prismaMock.hybridBillingOperation.findUnique.mockResolvedValue({ providerId: null, status: 'UNKNOWN' })
    await expect(cancelHybridPurchase('venue', 'purchase', 'staff')).rejects.toMatchObject({ code: 'HYBRID_PROVIDER_UNKNOWN' })
    expect(prismaMock.hybridRedemption.updateMany).not.toHaveBeenCalled()
    expect(provision).not.toHaveBeenCalled()
  })
  it('voids the unpaid invoice before cancelling its subscription and freeing the place', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({ ...purchase, stripeSubscriptionId: 'sub', initialInvoiceId: 'in' })
    const invoice = { id: 'in', status: 'open', customer: 'cus', parent: { subscription_details: { subscription: 'sub' } } }
    let canceled = false,
      voided = false
    retrieveSub.mockImplementation(async () => ({
      id: 'sub',
      customer: 'cus',
      status: canceled ? 'canceled' : 'incomplete',
      metadata: { hybridPurchaseId: 'purchase', venueId: 'venue' },
      latest_invoice: 'in',
    }))
    retrieveInvoice.mockImplementation(async () => ({ ...invoice, status: voided ? 'void' : 'open' }))
    voidInvoice.mockImplementation(async () => {
      voided = true
      return { ...invoice, status: 'void' }
    })
    cancelSub.mockImplementation(async () => {
      canceled = true
      return { id: 'sub', status: 'canceled' }
    })
    await cancelHybridPurchase('venue', 'purchase', 'staff')
    expect(voidInvoice.mock.invocationCallOrder[0]).toBeLessThan(cancelSub.mock.invocationCallOrder[0])
    expect(cancelSub.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.hybridCampaign.updateMany.mock.invocationCallOrder[0])
  })
  it('does not cancel a paid invoice; it resumes paid access delivery instead', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({ ...purchase, stripeSubscriptionId: 'sub', initialInvoiceId: 'in' })
    retrieveSub.mockResolvedValue({
      id: 'sub',
      customer: 'cus',
      metadata: { hybridPurchaseId: 'purchase', venueId: 'venue' },
      latest_invoice: 'in',
    })
    retrieveInvoice.mockResolvedValue({
      id: 'in',
      customer: 'cus',
      status: 'paid',
      parent: { subscription_details: { subscription: 'sub' } },
    })
    await expect(cancelHybridPurchase('venue', 'purchase', 'staff')).rejects.toMatchObject({ code: 'HYBRID_ALREADY_PAID' })
    expect(deliver).toHaveBeenCalledWith('venue', 'purchase', 'in')
    expect(cancelSub).not.toHaveBeenCalled()
  })
  it('recovers a saved initial invoice rather than starting a second checkout', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({ ...purchase, stripeSubscriptionId: 'sub', initialInvoiceId: 'in' })
    deliver.mockResolvedValue({ status: 'ACTIVE' })
    await expect(reconcileHybridPurchase('venue', 'purchase')).resolves.toMatchObject({ status: 'ACTIVE' })
    expect(provision).not.toHaveBeenCalled()
  })
  it('routes modern invoice events by their saved subscription, preserving legacy events', async () => {
    prismaMock.hybridPurchase.findUnique.mockResolvedValueOnce({ ...purchase, stripeSubscriptionId: 'sub' }).mockResolvedValueOnce(null)
    await expect(
      handleHybridStripeEvent({
        type: 'invoice.paid',
        data: { object: { id: 'in', parent: { subscription_details: { subscription: 'sub' } } } },
      } as any),
    ).resolves.toBe(true)
    expect(deliver).toHaveBeenCalledWith('venue', 'purchase', 'in')
    await expect(
      handleHybridStripeEvent({
        type: 'invoice.paid',
        data: { object: { id: 'in_legacy', parent: { subscription_details: { subscription: 'sub_legacy' } } } },
      } as any),
    ).resolves.toBe(false)
  })
})

describe('bounded intent recovery', () => {
  it('claims only a bounded due batch and schedules the next observation without clearing unknown intents', async () => {
    prismaMock.hybridPurchase.findMany.mockResolvedValue([
      { id: 'purchase', venueId: 'venue', status: 'PAYMENT_PENDING', nextAttemptAt: new Date(0), attemptCount: 1 },
    ])
    prismaMock.hybridPurchase.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.hybridPurchase.findUnique.mockResolvedValue({
      ...purchase,
      status: 'PAYMENT_PENDING',
      stripeSubscriptionId: 'sub',
      initialInvoiceId: 'in',
    })
    deliver.mockRejectedValue(new Error('Provider unavailable'))
    await reconcileHybridBatch()
    expect(prismaMock.hybridPurchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }] }),
    )
    expect(prismaMock.hybridPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastIssue: 'HYBRID_RECONCILIATION_PENDING', nextAttemptAt: expect.any(Date) }),
      }),
    )
    expect(prismaMock.hybridRedemption.updateMany).not.toHaveBeenCalled()
  })
})
