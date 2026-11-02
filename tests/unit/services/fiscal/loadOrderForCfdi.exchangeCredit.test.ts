import { Prisma } from '@prisma/client'
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn() },
    fiscalEmisor: { findMany: jest.fn() },
    merchantFiscalConfig: { findUnique: jest.fn() },
    orderDiscount: { findMany: jest.fn().mockResolvedValue([]) },
  },
}))
import prisma from '@/utils/prismaClient'
import { loadOrderForCfdiFromDb } from '@/services/fiscal/cfdi.service'
import { mapFormaPago } from '@/services/fiscal/satCatalog'

const db = prisma as any
const D = (n: number) => new Prisma.Decimal(n)
const emisor = { id: 'caaaaaaaaaaaaaaaaaaaaaaaa', venueId: 'cbbbbbbbbbbbbbbbbbbbbbbbb', invoiceCashSales: true }
const root: { venueId: string; method: string; merchantAccountId: string | null; ecommerceMerchantId: string | null } = {
  venueId: emisor.venueId,
  method: 'CASH',
  merchantAccountId: null,
  ecommerceMerchantId: null,
}
const payment = (amount: number, kind: string | null, method = 'OTHER', origin = root) => ({
  amount: D(amount),
  type: 'REGULAR',
  method,
  merchantAccountId: null,
  ecommerceMerchantId: null,
  tenderSatFormaPago: kind === 'EXCHANGE_CREDIT' ? '17' : null,
  tenderType: { systemKind: kind },
  exchangeCreditAsCredit: kind === 'EXCHANGE_CREDIT' ? { venueId: emisor.venueId, originPayment: { ...origin } } : null,
})
beforeEach(() => {
  jest.clearAllMocks()
  db.fiscalEmisor.findMany.mockResolvedValue([{ ...emisor, merchantConfigs: [{ facturacionEnabled: true, autofacturaEnabled: true }] }])
  db.order.findUnique.mockResolvedValue({
    venueId: emisor.venueId,
    venue: { slug: 'ropa', type: 'CLOTHING' },
    subtotal: D(500),
    total: D(500),
    taxAmount: D(0),
    discountAmount: D(0),
    tipAmount: D(0),
    items: [],
    payments: [payment(500, 'EXCHANGE_CREDIT')],
  })
})
describe('individual invoice with exchange credit', () => {
  it('loads an EC-only sale with FormaPago 17', async () => {
    const b = await loadOrderForCfdiFromDb('ccccccccccccccccccccccccc')
    expect(b).not.toBeNull()
    expect(mapFormaPago(b!.paymentMethod, b!.tenderSatFormaPago)).toBe('17')
  })
  it.each<[number, number, string, string]>([
    [450, 50, 'CASH', '17'],
    [100, 400, 'CREDIT_CARD', '04'],
    [100, 400, 'DEBIT_CARD', '28'],
  ])('uses the largest form for credit %i and difference %i by %s', async (credit, difference, method, expected) => {
    const o = await db.order.findUnique()
    o.payments = [payment(credit as number, 'EXCHANGE_CREDIT'), payment(difference as number, null, method)]
    const b = await loadOrderForCfdiFromDb('ccccccccccccccccccccccccc', { permitirEfectivo: true })
    expect(b).not.toBeNull()
    expect(mapFormaPago(b!.paymentMethod, b!.tenderSatFormaPago)).toBe(expected)
  })
  it('keeps unrelated OTHER tenders without a merchant unsupported', async () => {
    const o = await db.order.findUnique()
    o.payments = [payment(500, null)]
    expect(await loadOrderForCfdiFromDb('ccccccccccccccccccccccccc')).toBeNull()
  })
})

describe('issuer through the credit root', () => {
  it('selects the root merchant instead of guessing between issuers', async () => {
    const o = await db.order.findUnique()
    o.payments = [
      payment(500, 'EXCHANGE_CREDIT', 'OTHER', { ...root, merchantAccountId: 'cdddddddddddddddddddddddd', method: 'CREDIT_CARD' }),
    ]
    db.fiscalEmisor.findMany.mockResolvedValue([])
    db.merchantFiscalConfig.findUnique.mockResolvedValue({ fiscalEmisor: emisor, facturacionEnabled: true, autofacturaEnabled: true })
    expect((await loadOrderForCfdiFromDb('ccccccccccccccccccccccccc'))?.emisor.id).toBe(emisor.id)
    expect(db.merchantFiscalConfig.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { merchantAccountId: 'cdddddddddddddddddddddddd' } }),
    )
  })
})

describe('unverifiable exchange issuer', () => {
  it.each(['missing', 'foreign'])('does not guess the issuer for a %s credit origin', async state => {
    const o = await db.order.findUnique()
    if (state === 'missing') o.payments[0].exchangeCreditAsCredit = null
    else o.payments[0].exchangeCreditAsCredit.originPayment.venueId = 'ceeeeeeeeeeeeeeeeeeeeeeee'
    expect(await loadOrderForCfdiFromDb('ccccccccccccccccccccccccc')).toBeNull()
    expect(db.merchantFiscalConfig.findUnique).not.toHaveBeenCalled()
  })
})
