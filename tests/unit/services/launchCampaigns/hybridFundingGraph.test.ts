import type Stripe from 'stripe'
import { prismaMock } from '../../../__helpers__/setup'
const invoices = new Map<string, any>()
const paid = new Map<string, any[]>()
const purchases = new Map<string, any>()
let balance: any[] = []
let truncated = false
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    invoices: { retrieve: async (id: string) => invoices.get(id) },
    invoicePayments: { list: async ({ invoice }: any) => ({ data: paid.get(invoice) ?? [], has_more: false }) },
    creditNotes: { list: async () => ({ data: [], has_more: false }) },
    customers: { listBalanceTransactions: async () => ({ data: [...balance].reverse(), has_more: truncated }) },
  },
  STRIPE_DENTRO_DEL_CANDADO: {},
}))
import { hybridFundingReader } from '@/services/launchCampaigns/hybridFundingGraph'
function invoice(id: string, total: number, charge = total) {
  const value = {
    id,
    customer: 'cus',
    currency: 'mxn',
    status: 'paid',
    total,
    starting_balance: 0,
    ending_balance: 0,
    post_payment_credit_notes_amount: 0,
  } as Stripe.Invoice
  invoices.set(id, value)
  paid.set(
    id,
    charge > 0
      ? [
          {
            status: 'paid',
            currency: 'mxn',
            amount_paid: charge,
            payment: {
              type: 'charge',
              charge: { id: `ch_${id}`, paid: true, currency: 'mxn', amount: charge, amount_refunded: 0, disputed: false },
            },
          },
        ]
      : [],
  )
  return value
}
function transfer(target: string, source: string, amount: string) {
  purchases.set(target, {
    venueId: 'venue',
    stripeCustomerId: 'cus',
    quote: {
      credit: amount,
      effectiveAt: 100,
      sources: [
        {
          sourceInvoiceId: source,
          sourceCustomerId: 'cus',
          amount,
          funded: String(Number(amount) * 2),
          alreadyCredited: '0.00',
          startsAt: new Date(0).toISOString(),
          endsAt: new Date(200_000).toISOString(),
        },
      ],
    },
  })
}
beforeEach(() => {
  invoices.clear()
  paid.clear()
  purchases.clear()
  balance = []
  truncated = false
  prismaMock.hybridPurchase.findUnique.mockImplementation(async ({ where }: any) => purchases.get(where.initialInvoiceId) ?? null)
})
it('revalidates transferred money through multiple invoices after a partial or full source refund', async () => {
  invoice('source', 20000)
  const target = invoice('target', 0)
  transfer('target', 'source', '100.00')
  expect(await hybridFundingReader('venue').invoice(target)).toMatchObject({ funded: '100.00', impaired: false })
  paid.get('source')![0].payment.charge.amount_refunded = 10000
  expect(await hybridFundingReader('venue').invoice(target)).toMatchObject({ funded: '50.00', impaired: true })
  const descendant = invoice('descendant', 0)
  transfer('descendant', 'target', '50.00')
  expect(await hybridFundingReader('venue').invoice(descendant)).toMatchObject({ funded: '25.00', impaired: true })
  paid.get('source')![0].payment.charge.amount_refunded = 20000
  expect(await hybridFundingReader('venue').invoice(descendant)).toMatchObject({ funded: '0.00', impaired: true })
})
it('tracks overflow credit into a later invoice while preserving service and unrelated cash-funded coverage', async () => {
  invoice('source', 30000)
  const overflow = invoice('overflow', -5000)
  overflow.ending_balance = -5000
  transfer('overflow', 'source', '150.00')
  const renewal = invoice('renewal', 8000, 3000)
  renewal.starting_balance = -5000
  balance = [
    {
      id: 'credit',
      customer: 'cus',
      currency: 'mxn',
      type: 'invoice_too_small',
      amount: -5000,
      ending_balance: -5000,
      invoice: 'overflow',
    },
    { id: 'use', customer: 'cus', currency: 'mxn', type: 'applied_to_invoice', amount: 5000, ending_balance: 0, invoice: 'renewal' },
  ]
  expect(await hybridFundingReader('venue').invoice(renewal)).toMatchObject({ funded: '80.00', impaired: false })
  paid.get('source')![0].payment.charge.amount_refunded = 6000
  expect(await hybridFundingReader('venue').invoice(overflow)).toMatchObject({ funded: '100.00', impaired: true })
  expect(await hybridFundingReader('venue').invoice(renewal)).toMatchObject({ funded: '50.00', impaired: true })
  expect(await hybridFundingReader('venue').invoice(invoice('cash', 8000))).toMatchObject({ funded: '80.00', impaired: false })
})
it('rejects cross-tenant, cyclic, and incomplete balance evidence rather than manufacturing funding', async () => {
  const target = invoice('target', 0)
  transfer('target', 'target', '100.00')
  await expect(hybridFundingReader('venue').invoice(target)).rejects.toMatchObject({ code: 'HYBRID_FUNDING_UNVERIFIED' })
  purchases.get('target').venueId = 'other'
  await expect(hybridFundingReader('venue').invoice(target)).rejects.toMatchObject({ code: 'HYBRID_FUNDING_UNVERIFIED' })
  const renewal = invoice('renewal', 5000, 0)
  renewal.starting_balance = -5000
  balance = [
    { id: 'use', customer: 'cus', currency: 'mxn', type: 'applied_to_invoice', amount: 5000, ending_balance: 0, invoice: 'renewal' },
  ]
  truncated = true
  await expect(hybridFundingReader('venue').invoice(renewal)).rejects.toMatchObject({ code: 'HYBRID_FUNDING_UNVERIFIED' })
})
