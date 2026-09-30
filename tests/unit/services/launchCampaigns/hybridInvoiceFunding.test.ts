import { invoiceFunding } from '@/services/launchCampaigns/hybridInvoiceFunding'
const invoice = {
  status: 'paid',
  currency: 'mxn',
  total: 10000,
  starting_balance: 0,
  ending_balance: 0,
  post_payment_credit_notes_amount: 0,
}
const charge = { id: 'ch_test', amount: 10000, amount_refunded: 0, disputed: false, paid: true, currency: 'mxn' }
const payment = { status: 'paid', amount_paid: 10000, currency: 'mxn', payment: { type: 'charge', charge } }
describe('confirmed invoice funding in pesos', () => {
  it('requires actually observed funding rather than a paid status alone', () => {
    expect(invoiceFunding(invoice as any, [], [], '0')).toMatchObject({ funded: '0.00', refunded: '0.00' })
    expect(invoiceFunding(invoice as any, [payment as any], [], '0')).toMatchObject({ funded: '100.00' })
  })
  it('includes applied prepaid balance and transferred credit without attributing inherited debt to new service', () => {
    expect(
      invoiceFunding(
        { ...invoice, total: 7000, starting_balance: -2000, ending_balance: 0 } as any,
        [{ ...payment, amount_paid: 5000, payment: { type: 'charge', charge: { ...charge, amount: 5000 } } } as any],
        [],
        '30',
      ),
    ).toMatchObject({ funded: '100.00' })
    expect(
      invoiceFunding(
        { ...invoice, starting_balance: 1000 } as any,
        [{ ...payment, amount_paid: 11000, payment: { type: 'charge', charge: { ...charge, amount: 11000 } } } as any],
        [],
        '0',
      ),
    ).toMatchObject({ funded: '100.00' })
  })
  it('counts a refund linked to a credit note once and adds balance credits separately', () => {
    const refundedPayment = { ...payment, payment: { type: 'charge', charge: { ...charge, amount_refunded: 2500 } } }
    const note = { status: 'issued', post_payment_amount: 4000, refunds: [{ amount_refunded: 2500 }] }
    expect(
      invoiceFunding({ ...invoice, post_payment_credit_notes_amount: 4000 } as any, [refundedPayment as any], [note as any], '0'),
    ).toMatchObject({ refunded: '40.00' })
  })
  it('rejects a disputed, unresolved or split charge rather than guessing credit allocation', () => {
    expect(() =>
      invoiceFunding(invoice as any, [{ ...payment, payment: { type: 'charge', charge: { ...charge, disputed: true } } } as any], [], '0'),
    ).toThrow()
    expect(() =>
      invoiceFunding(invoice as any, [{ ...payment, payment: { type: 'charge', charge: 'ch_unexpanded' } } as any], [], '0'),
    ).toThrow()
    expect(() => invoiceFunding(invoice as any, [{ ...payment, amount_paid: 9000 } as any], [], '0')).toThrow()
  })
  it('gives no credit for an unpaid invoice and rejects currency mismatch', () => {
    expect(invoiceFunding({ ...invoice, status: 'open' } as any, [payment as any], [], '0')).toMatchObject({ funded: '0.00' })
    expect(() => invoiceFunding({ ...invoice, currency: 'usd' } as any, [payment as any], [], '0')).toThrow()
  })
})
