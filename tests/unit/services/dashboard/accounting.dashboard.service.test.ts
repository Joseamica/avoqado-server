/**
 * Unit tests (mock-first) for los read-models de Capa A (gerencial, NO fiscal):
 *  - getIncomeStatement (estado de resultados): IVA-incluido split, refunds, TEST, propinas aparte.
 *  - getBusinessSummary (resumen del negocio): revenue, propinas, colección, comisiones, facturación %.
 *  - getBankAndCashSummary (bancos y cajas): bucketing caja/banco + net-to-bank (venta + propina − comisión).
 *
 * Prisma mockeado: filas fijas in, matemática determinista out (cuadró al centavo en /full-testing).
 */
import { OrderStatus, PaymentMethod, PaymentType, TransactionStatus } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    cfdi: { aggregate: jest.fn(), groupBy: jest.fn() },
    bankStatement: { count: jest.fn(), aggregate: jest.fn() },
  },
}))
// COGS se prueba en cogs.service.test; aquí lo mockeamos para no pegar a prisma de inventario.
jest.mock('../../../../src/services/fiscal/cogs.service', () => ({ computePeriodCogsCents: jest.fn() }))

import prisma from '../../../../src/utils/prismaClient'
import { computePeriodCogsCents } from '../../../../src/services/fiscal/cogs.service'
import {
  getBankAndCashSummary,
  getBusinessSummary,
  getIncomeStatement,
} from '../../../../src/services/dashboard/accounting.dashboard.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  payment: { findMany: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  cfdi: { aggregate: jest.Mock; groupBy: jest.Mock }
  bankStatement: { count: jest.Mock; aggregate: jest.Mock }
}
const mCogs = computePeriodCogsCents as jest.Mock

const VENUE = 'venue_1'
const FILTERS = { from: '2026-06-01', to: '2026-06-16' }

/** Fila de Payment simple (montos en pesos; refunds negativos). Para los tests de getIncomeStatement. */
const row = (amount: number, type: string | null = 'REGULAR', tipAmount = 0) => ({ amount, tipAmount, type })

// 3 ventas (2 tarjeta, 1 efectivo) + 1 devolución (tarjeta) + 1 TEST (debe excluirse). Con propina de
// tarjeta (10 + 5). Alimenta getBusinessSummary y getBankAndCashSummary vía el beforeEach.
const ROWS = [
  { amount: 100, tipAmount: 10, type: PaymentType.REGULAR, method: PaymentMethod.CREDIT_CARD, feeAmount: 3 },
  { amount: 50, tipAmount: 5, type: PaymentType.REGULAR, method: PaymentMethod.DEBIT_CARD, feeAmount: 1.5 },
  { amount: 200, tipAmount: 0, type: PaymentType.REGULAR, method: PaymentMethod.CASH, feeAmount: 0 },
  { amount: -30, tipAmount: 0, type: PaymentType.REFUND, method: PaymentMethod.CREDIT_CARD, feeAmount: 0 },
  { amount: 999, tipAmount: 99, type: PaymentType.TEST, method: PaymentMethod.CASH, feeAmount: 0 },
]

beforeEach(() => {
  jest.clearAllMocks()
  p.venue.findUnique.mockResolvedValue({ name: 'Test', timezone: 'America/Mexico_City' })
  p.fiscalEmisor.findFirst.mockResolvedValue(null) // sin emisor → includeCashInAccounting=false (default)
  p.payment.findMany.mockResolvedValue(ROWS)
  p.cfdi.aggregate.mockResolvedValue({ _sum: { totalCents: 10000 }, _count: { _all: 1 } })
  p.cfdi.groupBy.mockResolvedValue([{ isGlobal: false, _count: { _all: 1 } }])
  p.bankStatement.count.mockResolvedValue(2)
  p.bankStatement.aggregate.mockResolvedValue({ _sum: { lineCount: 10, matchedCount: 4 } })
  mCogs.mockResolvedValue(0) // sin costo de ventas por default
})

describe('getIncomeStatement (Capa A — estado de resultados)', () => {
  // ---------- NEW FEATURE ----------
  it('splits IVA-included revenue: gross 116.00 → base 100.00 + IVA 16.00', async () => {
    p.payment.findMany.mockResolvedValue([row(116)])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(11600)
    expect(r.revenue.netRevenueCents).toBe(11600)
    expect(r.revenue.taxableBaseCents).toBe(10000)
    expect(r.revenue.ivaCents).toBe(1600)
    expect(r.taxRateAssumed).toBe(0.16)
    expect(r.metrics.salesCount).toBe(1)
  })

  it('subtracts refunds (type=REFUND, negative amount) and counts them', async () => {
    p.payment.findMany.mockResolvedValue([row(100, 'REGULAR'), row(-50, 'REFUND')])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000)
    expect(r.revenue.refundsCents).toBe(5000)
    expect(r.revenue.netRevenueCents).toBe(5000)
    expect(r.metrics.salesCount).toBe(1)
    expect(r.metrics.refundCount).toBe(1)
  })

  it('excludes TEST payments entirely', async () => {
    p.payment.findMany.mockResolvedValue([row(100, 'REGULAR'), row(999, 'TEST')])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000)
    expect(r.metrics.salesCount).toBe(1)
  })

  it('counts legacy null-type payments as sales (notIn would have dropped them)', async () => {
    p.payment.findMany.mockResolvedValue([row(100, null)])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000)
    expect(r.metrics.salesCount).toBe(1)
  })

  it('returns zeros (no divide-by-zero) for an empty period', async () => {
    p.payment.findMany.mockResolvedValue([])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(0)
    expect(r.revenue.ivaCents).toBe(0)
    expect(r.metrics.averageTicketCents).toBe(0)
  })

  // ---------- ALCANCE FISCAL CONFIGURABLE ----------
  it('fiscalRevenue EXCLUYE el efectivo por default; revenue (gerencial) lo incluye', async () => {
    p.payment.findMany.mockResolvedValue([
      { amount: 116, tipAmount: 0, type: 'REGULAR', method: PaymentMethod.CREDIT_CARD },
      { amount: 200, tipAmount: 0, type: 'REGULAR', method: PaymentMethod.CASH },
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(31600) // gerencial: todo
    expect(r.fiscalRevenue.grossSalesCents).toBe(11600) // fiscal: solo la tarjeta
  })

  it('fiscalRevenue INCLUYE el efectivo cuando el emisor optó (includeCashInAccounting=true)', async () => {
    p.fiscalEmisor.findFirst.mockResolvedValue({ includeCashInAccounting: true })
    p.payment.findMany.mockResolvedValue([
      { amount: 116, tipAmount: 0, type: 'REGULAR', method: PaymentMethod.CREDIT_CARD },
      { amount: 200, tipAmount: 0, type: 'REGULAR', method: PaymentMethod.CASH },
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.fiscalRevenue.grossSalesCents).toBe(31600)
  })

  it('fiscalRevenue EXCLUYE un merchant con includeInAccounting=false; revenue lo incluye', async () => {
    p.payment.findMany.mockResolvedValue([
      { amount: 116, tipAmount: 0, type: 'REGULAR', method: PaymentMethod.CREDIT_CARD },
      {
        amount: 232,
        tipAmount: 0,
        type: 'REGULAR',
        method: PaymentMethod.CREDIT_CARD,
        merchantAccount: { fiscalConfig: { includeInAccounting: false } },
      },
    ])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(34800) // gerencial: ambos
    expect(r.fiscalRevenue.grossSalesCents).toBe(11600) // fiscal: solo el merchant incluido
  })

  // ---------- REGRESSION / INVARIANTS ----------
  it('never includes tips in revenue (reported separately)', async () => {
    p.payment.findMany.mockResolvedValue([row(100, 'REGULAR', 20)])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000) // NOT 12000
    expect(r.tips.totalCents).toBe(2000)
  })

  it('always isolates by venueId + COMPLETED + non-cancelled orders', async () => {
    p.payment.findMany.mockResolvedValue([])
    await getIncomeStatement(VENUE, FILTERS)
    const where = p.payment.findMany.mock.calls[0][0].where
    expect(where.venueId).toBe(VENUE)
    expect(where.status).toBe(TransactionStatus.COMPLETED)
    expect(where.order).toEqual({ status: { not: OrderStatus.CANCELLED } })
  })
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

  it('computes gross profit = net revenue − COGS (utilidad bruta)', async () => {
    mCogs.mockResolvedValue(12000) // costo de ventas $120.00
    const r = await getBusinessSummary('venue-1', FILTERS)
    expect(r.result.cogsCents).toBe(12000)
    expect(r.result.grossProfitCents).toBe(20000) // 32000 net − 12000 COGS
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
    expect(card.inflowCents).toBe(12000) // 100+50-30 (venta, SIN propina)
    expect(card.count).toBe(2) // refund no cuenta
    expect(card.methods.sort()).toEqual(['CREDIT_CARD', 'DEBIT_CARD'])
  })

  it('totals: net-to-bank = electrónico + propina − comisiones', async () => {
    const r = await getBankAndCashSummary('venue-1', FILTERS)
    expect(r.totals.cashInflowCents).toBe(20000)
    expect(r.totals.electronicInflowCents).toBe(12000)
    expect(r.totals.electronicTipsCents).toBe(1500) // propina de tarjeta (10+5); la de efectivo/refund no
    expect(r.totals.feesCents).toBe(450)
    expect(r.totals.netToBankCents).toBe(13050) // 12000 + 1500 − 450 (la propina de tarjeta SÍ se deposita)
  })

  it('matches getBusinessSummary collection (single source of truth)', async () => {
    const summary = await getBusinessSummary('venue-1', FILTERS)
    const banks = await getBankAndCashSummary('venue-1', FILTERS)
    expect(summary.collection.cashCents).toBe(banks.totals.cashInflowCents)
    expect(summary.collection.electronicCents).toBe(banks.totals.electronicInflowCents)
  })
})
