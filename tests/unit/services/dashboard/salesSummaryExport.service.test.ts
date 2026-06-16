/**
 * Sales-summary export service: summary flattening + detailed where-clause.
 * getSalesSummary is mocked so we test the flattener shape, not the aggregation.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { payment: { count: jest.fn(), findMany: jest.fn() } },
}))
import prisma from '../../../../src/utils/prismaClient'
import * as svc from '../../../../src/services/dashboard/sales-summary.dashboard.service'

const paymentCount = (prisma as any).payment.count as jest.Mock
const paymentFindMany = (prisma as any).payment.findMany as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('flattenSalesSummaryForExport', () => {
  const report: svc.SalesSummaryResponse = {
    dateRange: { startDate: new Date('2026-06-01'), endDate: new Date('2026-06-07') },
    reportType: 'summary',
    summary: {
      grossSales: 1000,
      items: 50,
      serviceCosts: 0,
      discounts: 100,
      refunds: 25,
      netSales: 875,
      deferredSales: 0,
      taxes: 140,
      tips: 60,
      platformFees: 12,
      staffCommissions: 0,
      commissions: 12,
      totalCollected: 935,
      netProfit: 863,
      transactionCount: 42,
    },
    byPaymentMethod: [{ method: 'CARD', amount: 700, count: 30, percentage: 70 }],
    filtered: false,
  }

  it('emits totals rows and the payment-method section when requested', () => {
    const { rows } = svc.flattenSalesSummaryForExport(report, ['totals', 'paymentMethods'])
    expect(rows.some(r => r.label === 'Ventas brutas' && r.amount === 1000)).toBe(true)
    expect(rows.some(r => r.section === 'paymentMethods' && r.label === 'CARD')).toBe(true)
  })

  it('omits sections the user did not request', () => {
    const { rows } = svc.flattenSalesSummaryForExport(report, ['totals'])
    expect(rows.some(r => r.section === 'paymentMethods')).toBe(false)
  })
})

describe('detailed rows where-clause + cap', () => {
  it('countSalesSummaryDetailRows scopes to venue+date+COMPLETED and honors payment filter', async () => {
    paymentCount.mockResolvedValue(5)
    const total = await svc.countSalesSummaryDetailRows('v1', {
      startDate: '2026-06-01',
      endDate: '2026-06-07',
      paymentMethod: 'CASH',
    })
    expect(total).toBe(5)
    const where = paymentCount.mock.calls[0][0].where
    expect(where.venueId).toBe('v1')
    expect(where.status).toBe('COMPLETED')
    expect(where.method).toBe('CASH') // from buildPaymentWhereFilter('CASH')
    expect(where.createdAt.gte).toBeInstanceOf(Date)
  })

  it('fetchSalesSummaryDetailRows passes take=limit and a stable orderBy', async () => {
    paymentFindMany.mockResolvedValue([])
    await svc.fetchSalesSummaryDetailRows('v1', { startDate: '2026-06-01', endDate: '2026-06-07' }, 1000)
    const arg = paymentFindMany.mock.calls[0][0]
    expect(arg.take).toBe(1000)
    expect(arg.orderBy).toEqual({ createdAt: 'desc' })
    expect(arg.where.status).toBe('COMPLETED')
  })

  it('threads staff (processedById) + shift (shiftId) + merchant into the WHERE when provided', async () => {
    paymentFindMany.mockResolvedValue([])
    await svc.fetchSalesSummaryDetailRows(
      'v1',
      {
        startDate: '2026-06-01',
        endDate: '2026-06-07',
        staffIds: ['staff-1', 'staff-2'],
        shiftId: 'shift-9',
        merchantAccountId: 'ma-7',
      },
      1000,
    )
    const where = paymentFindMany.mock.calls[0][0].where
    expect(where.processedById).toEqual({ in: ['staff-1', 'staff-2'] })
    expect(where.shiftId).toBe('shift-9')
    expect(where.merchantAccountId).toBe('ma-7')
  })

  it('omits staff/shift/merchant from the WHERE when not provided', async () => {
    paymentFindMany.mockResolvedValue([])
    await svc.fetchSalesSummaryDetailRows('v1', { startDate: '2026-06-01', endDate: '2026-06-07' }, 1000)
    const where = paymentFindMany.mock.calls[0][0].where
    expect(where.processedById).toBeUndefined()
    expect(where.shiftId).toBeUndefined()
    expect(where.merchantAccountId).toBeUndefined()
  })
})
