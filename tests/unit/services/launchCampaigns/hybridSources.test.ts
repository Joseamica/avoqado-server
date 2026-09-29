import { prismaMock } from '../../../__helpers__/setup'
const retrieve = jest.fn()
const payments = jest.fn()
const notes = jest.fn()
const invoiceRetrieve = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    invoices: { retrieve: (...args: unknown[]) => invoiceRetrieve(...args) },
    subscriptions: { retrieve: (...args: unknown[]) => retrieve(...args) },
    invoicePayments: { list: (...args: unknown[]) => payments(...args) },
    creditNotes: { list: (...args: unknown[]) => notes(...args) },
  },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
import { readHybridCreditSource } from '@/services/launchCampaigns/hybridSources'
const now = Math.floor(Date.now() / 1000)
const invoice = {
  id: 'in_source',
  customer: 'cus_test',
  status: 'paid',
  currency: 'mxn',
  total: 10000,
  starting_balance: 0,
  ending_balance: 0,
  post_payment_credit_notes_amount: 0,
  lines: {
    has_more: false,
    data: [
      {
        amount: 10000,
        parent: { subscription_item_details: { subscription_item: 'si_test' } },
        period: { start: now - 86400 * 10, end: now + 86400 * 10 },
      },
    ],
  },
}
beforeEach(() => {
  retrieve.mockReset().mockResolvedValue({
    id: 'sub_source',
    customer: 'cus_test',
    status: 'active',
    latest_invoice: invoice,
    items: { data: [{ id: 'si_test', current_period_start: now - 86400 * 10, current_period_end: now + 86400 * 10 }], has_more: false },
  })
  payments.mockReset().mockResolvedValue({
    has_more: false,
    data: [
      {
        status: 'paid',
        amount_paid: 10000,
        currency: 'mxn',
        payment: {
          type: 'charge',
          charge: { id: 'ch_test', amount: 10000, amount_refunded: 0, disputed: false, paid: true, currency: 'mxn' },
        },
      },
    ],
  })
  notes.mockReset().mockResolvedValue({ has_more: false, data: [] })
  prismaMock.hybridCreditAllocation.aggregate.mockResolvedValue({ _sum: { amount: null } })
  prismaMock.hybridPurchase.findUnique.mockResolvedValue(null)
})
describe('credit source verification', () => {
  it('does not prorate a one-time invoice fee as unused recurring service', async () => {
    const sub = await retrieve()
    retrieve.mockResolvedValue({
      ...sub,
      latest_invoice: {
        ...invoice,
        total: 20000,
        lines: { ...invoice.lines, data: [...invoice.lines.data, { amount: 10000, period: invoice.lines.data[0].period }] },
      },
    })
    payments.mockResolvedValue({
      has_more: false,
      data: [
        {
          status: 'paid',
          amount_paid: 20000,
          currency: 'mxn',
          payment: {
            type: 'charge',
            charge: { id: 'ch', amount: 20000, amount_refunded: 0, disputed: false, paid: true, currency: 'mxn' },
          },
        },
      ],
    })
    await expect(readHybridCreditSource('venue', 'sub_source', 'cus_test', now)).resolves.toMatchObject({
      funded: '100.00',
      amount: '50.00',
    })
  })
  it('quotes only confirmed, funded unused coverage from the expected customer', async () => {
    await expect(readHybridCreditSource('venue', 'sub_source', 'cus_test', now)).resolves.toMatchObject({
      sourceInvoiceId: 'in_source',
      amount: '50.00',
      funded: '100.00',
    })
  })
  it('does not transfer an unpaid invoice or another customer balance', async () => {
    retrieve.mockResolvedValueOnce({ customer: 'other', latest_invoice: invoice })
    await expect(readHybridCreditSource('venue', 'sub_source', 'cus_test', now)).rejects.toThrow()
    retrieve.mockResolvedValueOnce({ id: 'sub_source', customer: 'cus_test', latest_invoice: { ...invoice, status: 'open' } })
    await expect(readHybridCreditSource('venue', 'sub_source', 'cus_test', now)).rejects.toMatchObject({ code: 'HYBRID_SOURCE_UNPAID' })
  })
  it('fails closed if payments are truncated or a renewal can happen inside the payment window', async () => {
    payments.mockResolvedValueOnce({ data: [], has_more: true })
    await expect(readHybridCreditSource('venue', 'sub_source', 'cus_test', now)).rejects.toThrow()
    await expect(readHybridCreditSource('venue', 'sub_source', 'cus_test', now + 86400 * 10 - 3600)).rejects.toMatchObject({
      code: 'HYBRID_SOURCE_RENEWING',
    })
  })
  it('excludes this accepted attempt when rechecking its reserved credit', async () => {
    await readHybridCreditSource('venue', 'sub_source', 'cus_test', now, 'purchase')
    expect(prismaMock.hybridCreditAllocation.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ purchaseId: { not: 'purchase' } }) }),
    )
  })

  it('does not re-credit prepaid value already left in the customer balance', async () => {
    const source = await retrieve()
    retrieve.mockResolvedValue({ ...source, latest_invoice: { ...invoice, total: -5000, ending_balance: -5000 } })
    payments.mockResolvedValue({ has_more: false, data: [] })
    const oldInvoice = { ...invoice, id: 'in_origin', total: 30000 }
    invoiceRetrieve.mockResolvedValue(oldInvoice)
    const originPayment = {
      status: 'paid',
      currency: 'mxn',
      amount_paid: 30000,
      payment: {
        type: 'charge',
        charge: { id: 'ch_origin', amount: 30000, amount_refunded: 0, disputed: false, paid: true, currency: 'mxn' },
      },
    }
    payments.mockImplementation(async ({ invoice: id }: any) => ({ has_more: false, data: id === 'in_origin' ? [originPayment] : [] }))
    prismaMock.hybridPurchase.findUnique.mockImplementation(async ({ where }: any) =>
      where.initialInvoiceId === 'in_source'
        ? {
            id: 'previous',
            venueId: 'venue',
            stripeCustomerId: 'cus_test',
            quote: {
              credit: '150.00',
              effectiveAt: now,
              sources: [
                {
                  sourceInvoiceId: 'in_origin',
                  sourceCustomerId: 'cus_test',
                  amount: '150.00',
                  funded: '300.00',
                  alreadyCredited: '0.00',
                  startsAt: new Date((now - 86400 * 10) * 1000).toISOString(),
                  endsAt: new Date((now + 86400 * 10) * 1000).toISOString(),
                },
              ],
            },
          }
        : null,
    )
    prismaMock.hybridCreditAllocation.aggregate.mockImplementation(async ({ where }: any) => ({
      _sum: { amount: where.purchaseId === 'previous' ? '150' : null },
    }))
    await expect(readHybridCreditSource('venue', 'sub_source', 'cus_test', now)).resolves.toMatchObject({
      funded: '100.00',
      amount: '50.00',
    })
    originPayment.payment.charge.amount_refunded = 30000
    await expect(readHybridCreditSource('venue', 'sub_source', 'cus_test', now)).resolves.toMatchObject({ funded: '0.00', amount: '0.00' })
  })
})
