// tests/unit/services/fiscal/loadOrderForCfdi.test.ts
// Real-path tests for the DB-backed loader that resolves the emisor via the payment's merchant.
// Critical: the tenant guard (emisor.venueId MUST equal order.venueId) — a shared MerchantAccount
// must never let venue B stamp a CFDI under venue A's RFC.
import { Prisma } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn() },
    merchantFiscalConfig: { findUnique: jest.fn() },
  },
}))
jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import prisma from '../../../../src/utils/prismaClient'
import { loadOrderForCfdiFromDb } from '../../../../src/services/fiscal/cfdi.service'

const D = (n: number) => new Prisma.Decimal(n)
const orderMock = prisma.order.findUnique as jest.Mock
const cfgMock = prisma.merchantFiscalConfig.findUnique as jest.Mock

function anOrder(over: Record<string, any> = {}) {
  return {
    venueId: 'venueB',
    subtotal: D(100),
    taxAmount: D(16),
    total: D(116),
    tipAmount: D(0),
    venue: { slug: 'demo', type: 'RESTAURANT' },
    payments: [{ method: 'CREDIT_CARD', merchantAccountId: 'm1', ecommerceMerchantId: null }],
    items: [
      {
        productName: 'X',
        quantity: 1,
        unitPrice: D(100),
        discountAmount: D(0),
        product: { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null },
      },
    ],
    ...over,
  }
}

function aConfig(over: Record<string, any> = {}) {
  return {
    facturacionEnabled: true,
    autofacturaEnabled: false,
    fiscalEmisor: { id: 'e1', venueId: 'venueB', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'F' },
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('loadOrderForCfdiFromDb', () => {
  it('resolves the emisor via the merchant config when the emisor belongs to the order venue', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle).not.toBeNull()
    expect(bundle!.venueId).toBe('venueB')
    expect(bundle!.emisor.id).toBe('e1')
    expect(bundle!.facturacionEnabled).toBe(true)
    expect(bundle!.autofacturaEnabled).toBe(false)
    expect(bundle!.subtotalCents).toBe(10000)
    expect(bundle!.taxCents).toBe(1600)
    expect(bundle!.totalCents).toBe(11600)
    // resolved by merchantAccountId (in-person), not ecommerce
    expect(cfgMock).toHaveBeenCalledWith(expect.objectContaining({ where: { merchantAccountId: 'm1' } }))
  })

  it('SECURITY: refuses to stamp when the merchant emisor belongs to a DIFFERENT venue', async () => {
    orderMock.mockResolvedValue(anOrder({ venueId: 'venueB' }))
    // shared MerchantAccount whose fiscal config points at venue A's emisor
    cfgMock.mockResolvedValue(aConfig({ fiscalEmisor: { ...aConfig().fiscalEmisor, venueId: 'venueA' } }))

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle).toBeNull() // never returns another venue's emisor
  })

  it('returns null when the order does not exist', async () => {
    orderMock.mockResolvedValue(null)
    expect(await loadOrderForCfdiFromDb('missing')).toBeNull()
    expect(cfgMock).not.toHaveBeenCalled()
  })

  it('returns null when no settled payment carries a merchant (e.g. cash only)', async () => {
    orderMock.mockResolvedValue(anOrder({ payments: [] }))
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
    expect(cfgMock).not.toHaveBeenCalled()
  })

  it('returns null when the payment has no merchant FK', async () => {
    orderMock.mockResolvedValue(anOrder({ payments: [{ method: 'CASH', merchantAccountId: null, ecommerceMerchantId: null }] }))
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
    expect(cfgMock).not.toHaveBeenCalled()
  })

  it('returns null when the merchant has no fiscal config', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue(null)
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
  })

  it('returns null when the fiscal config has no linked emisor', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue(aConfig({ fiscalEmisor: null }))
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
  })

  it('resolves via ecommerceMerchantId for an online payment', async () => {
    orderMock.mockResolvedValue(anOrder({ payments: [{ method: 'CREDIT_CARD', merchantAccountId: null, ecommerceMerchantId: 'ec9' }] }))
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle).not.toBeNull()
    expect(cfgMock).toHaveBeenCalledWith(expect.objectContaining({ where: { ecommerceMerchantId: 'ec9' } }))
  })

  it('only considers COMPLETED payments (settled merchant), not refunds', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue(aConfig())
    await loadOrderForCfdiFromDb('o1')
    // the query must filter payments by status COMPLETED
    const arg = orderMock.mock.calls[0][0]
    expect(arg.select.payments.where).toEqual({ status: 'COMPLETED' })
  })
})
