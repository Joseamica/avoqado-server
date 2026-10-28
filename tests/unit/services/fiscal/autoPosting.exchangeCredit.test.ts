import { OrderStatus, PaymentMethod, PaymentType, Prisma } from '@prisma/client'
import { isEligible } from '@/services/fiscal/autoPosting.service'
const row = (kind: string | null, type: PaymentType = PaymentType.REGULAR) => ({
  id: 'caaaaaaaaaaaaaaaaaaaaaaaa',
  amount: new Prisma.Decimal(type === 'REFUND' ? -500 : 500),
  tipAmount: new Prisma.Decimal(0),
  feeAmount: new Prisma.Decimal(0),
  method: PaymentMethod.CASH,
  type,
  createdAt: new Date(),
  merchantAccount: null,
  ecommerceMerchant: null,
  tenderType: { systemKind: kind },
  order: { status: OrderStatus.COMPLETED, orderNumber: '1' },
})
describe('exchange credit auto posting', () => {
  it.each([PaymentType.REGULAR, PaymentType.REFUND])('excludes the EC %s row', type => {
    expect(isEligible(row('EXCHANGE_CREDIT', type))).toBe(false)
  })
  it('retains ordinary cash eligibility', () => expect(isEligible(row(null))).toBe(true))
})
