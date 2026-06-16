/**
 * Unit tests (mock-first) for the Capa A read-models — Resumen del negocio
 * (getBusinessSummary) + Bancos y cajas (getBankAndCashSummary).
 *
 * Prisma is mocked: fixed Payment/Cfdi/BankStatement rows in, deterministic math out.
 * Locks the bucketing (cash vs electrónico), IVA-incluido split, facturación %, comisiones
 * y net-after-fees that /full-testing verified live against the DB (cuadró al centavo).
 */
import { PaymentMethod, PaymentType } from '@prisma/client'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
    cfdi: { aggregate: jest.fn(), groupBy: jest.fn() },
    bankStatement: { count: jest.fn(), aggregate: jest.fn() },
  },
}))

import prisma from '../../../src/utils/prismaClient'
import { getBankAndCashSummary, getBusinessSummary } from '../../../src/services/dashboard/accounting.dashboard.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  payment: { findMany: jest.Mock }
  cfdi: { aggregate: jest.Mock; groupBy: jest.Mock }
  bankStatement: { count: jest.Mock; aggregate: jest.Mock }
}

// 3 ventas (2 tarjeta, 1 efectivo) + 1 devolución (tarjeta) + 1 TEST (debe excluirse).
const ROWS = [
  { amount: 100, tipAmount: 10, type: PaymentType.REGULAR, method: PaymentMethod.CREDIT_CARD, feeAmount: 3 },
  { amount: 50, tipAmount: 5, type: PaymentType.REGULAR, method: PaymentMethod.DEBIT_CARD, feeAmount: 1.5 },
  { amount: 200, tipAmount: 0, type: PaymentType.REGULAR, method: PaymentMethod.CASH, feeAmount: 0 },
  { amount: -30, tipAmount: 0, type: PaymentType.REFUND, method: PaymentMethod.CREDIT_CARD, feeAmount: 0 },
  { amount: 999, tipAmount: 99, type: PaymentType.TEST, method: PaymentMethod.CASH, feeAmount: 0 },
]

const FILTERS = { from: '2026-06-01', to: '2026-06-16' }

beforeEach(() => {
  jest.clearAllMocks()
  p.venue.findUnique.mockResolvedValue({ name: 'Test', timezone: 'America/Mexico_City' })
  p.payment.findMany.mockResolvedValue(ROWS)
  p.cfdi.aggregate.mockResolvedValue({ _sum: { totalCents: 10000 }, _count: { _all: 1 } })
  p.cfdi.groupBy.mockResolvedValue([{ isGlobal: false, _count: { _all: 1 } }])
  p.bankStatement.count.mockResolvedValue(2)
  p.bankStatement.aggregate.mockResolvedValue({ _sum: { lineCount: 10, matchedCount: 4 } })
})

describe('getBusinessSummary (Resumen del negocio)', () => {
  it('computes revenue with IVA-incluido split, refunds excluded from gross', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.revenue.grossSalesCents).toBe(35000) // 100+50+200 (TEST excluido)
    expect(r.revenue.refundsCents).toBe(3000)
    expect(r.revenue.netRevenueCents).toBe(32000)
    // splitIvaIncluded(32000, 0.16): net=round(32000/1.16)=27586, iva=4414
    expect(r.revenue.taxableBaseCents).toBe(27586)
    expect(r.revenue.ivaCents).toBe(4414)
    expect(r.revenue.taxableBaseCents + r.revenue.ivaCents).toBe(r.revenue.netRevenueCents)
  })

  it('tips exclude TEST + refunds; metrics count only real sales', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.tips.totalCents).toBe(1500) // 10+5 (cash 0, refund 0, TEST excluido)
    expect(r.metrics.salesCount).toBe(3)
    expect(r.metrics.refundCount).toBe(1)
    expect(r.metrics.averageTicketCents).toBe(11667) // round(35000/3)
  })

  it('splits collection cash vs electrónico (refund reduces the card bucket)', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.collection.cashCents).toBe(20000)
    expect(r.collection.electronicCents).toBe(12000) // 100+50-30
    expect(r.collection.cashPct).toBe(63) // round(20000/32000*100)
  })

  it('sums processing fees (non-refund) and net-after-fees', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.costs.processingFeesCents).toBe(450) // 300+150
    expect(r.result.netAfterFeesCents).toBe(31550) // 32000-450
  })

  it('reports invoicing from stamped CFDIs (approx capped at net revenue)', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.invoicing.stampedCount).toBe(1)
    expect(r.invoicing.nominativeCount).toBe(1)
    expect(r.invoicing.globalCount).toBe(0)
    expect(r.invoicing.invoicedApproxCents).toBe(10000)
    expect(r.invoicing.uninvoicedApproxCents).toBe(22000) // 32000-10000
    expect(r.invoicing.invoicedPct).toBe(31) // round(10000/32000*100)
  })

  it('passes through reconciliation status', async () => {
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.reconciliation).toEqual({ statements: 2, lineCount: 10, matchedCount: 4 })
  })

  it('invoicedPct is 0 when there is no net revenue (no division by zero)', async () => {
    p.payment.findMany.mockResolvedValue([])
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.revenue.netRevenueCents).toBe(0)
    expect(r.invoicing.invoicedPct).toBe(0)
    expect(r.collection.cashPct).toBe(0)
  })
})

describe('getBankAndCashSummary (Bancos y cajas)', () => {
  it('buckets methods into caja (cash) vs banco (electrónico), sorted by inflow', async () => {
    const r = await getBankAndCashSummary('venue-1', FILTERS)
    expect(r.accounts.map(a => a.key)).toEqual(['cash', 'card']) // cash 20000 > card 12000
    const cash = r.accounts.find(a => a.key === 'cash')!
    const card = r.accounts.find(a => a.key === 'card')!
    expect(cash.kind).toBe('cash')
    expect(cash.inflowCents).toBe(20000)
    expect(cash.count).toBe(1)
    expect(card.kind).toBe('bank')
    expect(card.inflowCents).toBe(12000) // 100+50-30
    expect(card.count).toBe(2) // refund no cuenta
    expect(card.methods.sort()).toEqual(['CREDIT_CARD', 'DEBIT_CARD'])
  })

  it('totals: net-to-bank = electrónico − comisiones', async () => {
    const r = await getBankAndCashSummary('venue-1', FILTERS)
    expect(r.totals.cashInflowCents).toBe(20000)
    expect(r.totals.electronicInflowCents).toBe(12000)
    expect(r.totals.feesCents).toBe(450)
    expect(r.totals.netToBankCents).toBe(11550) // 12000-450
  })

  it('matches getBusinessSummary collection (single source of truth)', async () => {
    const summary = await getBusinessSummary('venue-1', FILTERS)
    const banks = await getBankAndCashSummary('venue-1', FILTERS)
    expect(summary.collection.cashCents).toBe(banks.totals.cashInflowCents)
    expect(summary.collection.electronicCents).toBe(banks.totals.electronicInflowCents)
  })
})
