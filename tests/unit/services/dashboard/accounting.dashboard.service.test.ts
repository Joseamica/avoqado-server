import { OrderStatus, TransactionStatus } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
    bankStatement: { count: jest.fn(), aggregate: jest.fn() },
  },
}))

import prisma from '../../../../src/utils/prismaClient'
import { getBankAndCashSummary, getIncomeStatement } from '../../../../src/services/dashboard/accounting.dashboard.service'

const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const paymentFindMany = (prisma as any).payment.findMany as jest.Mock

const VENUE = 'venue_1'
const FILTERS = { from: '2026-06-01', to: '2026-06-15' }

/** Build a fake Payment row (amount in pesos; refunds are negative). */
const row = (amount: number, type: string | null = 'REGULAR', tipAmount = 0) => ({ amount, tipAmount, type })

beforeEach(() => {
  jest.clearAllMocks()
  venueFindUnique.mockResolvedValue({ name: 'Demo Venue', timezone: 'America/Mexico_City' })
})

describe('getIncomeStatement (Capa A — estado de resultados)', () => {
  // ---------- NEW FEATURE ----------
  it('splits IVA-included revenue: gross 116.00 → base 100.00 + IVA 16.00', async () => {
    paymentFindMany.mockResolvedValue([row(116)])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(11600)
    expect(r.revenue.netRevenueCents).toBe(11600)
    expect(r.revenue.taxableBaseCents).toBe(10000)
    expect(r.revenue.ivaCents).toBe(1600)
    expect(r.taxRateAssumed).toBe(0.16)
    expect(r.metrics.salesCount).toBe(1)
  })

  it('subtracts refunds (type=REFUND, negative amount) and counts them', async () => {
    paymentFindMany.mockResolvedValue([row(100, 'REGULAR'), row(-50, 'REFUND')])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000)
    expect(r.revenue.refundsCents).toBe(5000)
    expect(r.revenue.netRevenueCents).toBe(5000)
    expect(r.metrics.salesCount).toBe(1)
    expect(r.metrics.refundCount).toBe(1)
  })

  it('excludes TEST payments entirely', async () => {
    paymentFindMany.mockResolvedValue([row(100, 'REGULAR'), row(999, 'TEST')])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000)
    expect(r.metrics.salesCount).toBe(1)
  })

  it('counts legacy null-type payments as sales (notIn would have dropped them)', async () => {
    paymentFindMany.mockResolvedValue([row(100, null)])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000)
    expect(r.metrics.salesCount).toBe(1)
  })

  it('returns zeros (no divide-by-zero) for an empty period', async () => {
    paymentFindMany.mockResolvedValue([])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(0)
    expect(r.revenue.ivaCents).toBe(0)
    expect(r.metrics.averageTicketCents).toBe(0)
  })

  // ---------- REGRESSION / INVARIANTS ----------
  it('never includes tips in revenue (reported separately)', async () => {
    paymentFindMany.mockResolvedValue([row(100, 'REGULAR', 20)])
    const r = await getIncomeStatement(VENUE, FILTERS)
    expect(r.revenue.grossSalesCents).toBe(10000) // NOT 12000
    expect(r.tips.totalCents).toBe(2000)
  })

  it('always isolates by venueId + COMPLETED + non-cancelled orders', async () => {
    paymentFindMany.mockResolvedValue([])
    await getIncomeStatement(VENUE, FILTERS)
    const where = paymentFindMany.mock.calls[0][0].where
    expect(where.venueId).toBe(VENUE)
    expect(where.status).toBe(TransactionStatus.COMPLETED)
    expect(where.order).toEqual({ status: { not: OrderStatus.CANCELLED } })
  })
})

describe('getBankAndCashSummary (Capa A — bancos y cajas)', () => {
  beforeEach(() => {
    ;(prisma as any).bankStatement.count.mockResolvedValue(0)
    ;(prisma as any).bankStatement.aggregate.mockResolvedValue({ _sum: { lineCount: 0, matchedCount: 0 } })
  })

  it('netToBank = venta electrónica + propina − comisión; la propina en EFECTIVO no llega al banco', async () => {
    // El procesador liquida venta + propina − comisión; el neto al banco debe reflejar lo mismo.
    paymentFindMany.mockResolvedValue([
      { amount: 100, tipAmount: 20, type: 'REGULAR', method: 'CREDIT_CARD', feeAmount: 3 }, // tarjeta → banco
      { amount: 50, tipAmount: 10, type: 'REGULAR', method: 'CASH', feeAmount: 0 }, // efectivo → caja
    ])
    const r = await getBankAndCashSummary(VENUE, FILTERS)
    expect(r.totals.electronicInflowCents).toBe(10000) // venta de tarjeta, SIN propina
    expect(r.totals.electronicTipsCents).toBe(2000) // sólo la propina de tarjeta
    expect(r.totals.feesCents).toBe(300)
    expect(r.totals.netToBankCents).toBe(11700) // 100 + 20 − 3 (la propina en efectivo de 10 NO entra)
  })
})
