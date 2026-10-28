import { PaymentMethod } from '@prisma/client'
import { formaPagoDeLaNota, type LoadedRefundForCreditNote } from '@/services/fiscal/cfdiCreditNote.service'

describe('exchange credit note payment form', () => {
  it.each([
    ['CREDIT', PaymentMethod.OTHER, '17', '17'],
    ['DIFFERENCE', PaymentMethod.CASH, null, '01'],
    ['DIFFERENCE', PaymentMethod.DEBIT_CARD, null, '28'],
    ['CHAIN', PaymentMethod.CASH, null, '01'],
  ])('keeps the actual %s refund form', (role, method, tenderSatFormaPago, expected) => {
    const loaded = {
      original: { formaPago: '04' },
      refund: { method, tenderSatFormaPago, processorData: { exchange: { role } } },
    } as LoadedRefundForCreditNote
    expect(formaPagoDeLaNota(loaded)).toBe(expected)
  })
})
