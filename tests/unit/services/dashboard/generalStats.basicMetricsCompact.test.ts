import { getBasicMetricsData, getBasicMetricsDetailsPage } from '@/services/dashboard/generalStats.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

const mockFetchPaymentsForAnalytics = jest.fn()

jest.mock('@/services/legacy/mergedPayments.service', () => ({
  fetchPaymentsForAnalytics: (...args: unknown[]) => mockFetchPaymentsForAnalytics(...args),
}))

const VENUE_ID = 'venue-compact'
const RANGE = {
  fromDate: '2026-08-01T00:00:00.000Z',
  toDate: '2026-08-31T23:59:59.999Z',
}

describe('getBasicMetricsData — aggregated-v1 is bounded and legacy-compatible', () => {
  beforeEach(() => {
    ;(prismaMock.$queryRaw as jest.Mock).mockReset()
    ;(prismaMock.payment.findMany as jest.Mock).mockReset()
    ;(prismaMock.review.findMany as jest.Mock).mockReset()
    ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ id: VENUE_ID, timezone: 'UTC' })
    mockFetchPaymentsForAnalytics.mockReset()
  })

  it('returns server aggregates without materializing payment or review rows', async () => {
    ;(prismaMock.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([
        { method: 'Efectivo', weekday: 1, total: 120, count: 2, tips: 10, tipPercentageSum: 15 },
        { method: 'Tarjeta', weekday: 1, total: 80, count: 1, tips: 5, tipPercentageSum: 5 },
        { method: 'Tarjeta', weekday: 5, total: 300, count: 2, tips: 15, tipPercentageSum: 20 },
      ])
      .mockResolvedValueOnce([{ total: 7, fiveStar: 4 }])

    const data = await getBasicMetricsData(VENUE_ID, { ...RANGE, responseMode: 'aggregated-v1' })

    expect(data).toEqual({
      responseMode: 'aggregated-v1',
      payments: [],
      reviews: [],
      paymentMethodsData: [
        { method: 'Efectivo', total: 120, count: 2 },
        { method: 'Tarjeta', total: 380, count: 3 },
      ],
      summary: {
        totalAmount: 500,
        totalTransactions: 5,
        totalTips: 30,
        avgTipPercentage: 8,
      },
      reviewStats: { total: 7, fiveStar: 4 },
      performanceByWeekday: [0, 200, 0, 0, 0, 300, 0],
      meta: {
        paymentsTruncated: true,
        paymentsTotal: 5,
        reviewsTruncated: true,
        reviewsTotal: 7,
      },
    })
    expect(prismaMock.payment.findMany).not.toHaveBeenCalled()
    expect(prismaMock.review.findMany).not.toHaveBeenCalled()
    expect(mockFetchPaymentsForAnalytics).not.toHaveBeenCalled()
  })

  it('keeps bounded compatibility rows when responseMode is absent', async () => {
    ;(prismaMock.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([{ method: 'Efectivo', weekday: 6, total: 25, count: 1, tips: 3, tipPercentageSum: 12 }])
      .mockResolvedValueOnce([{ total: 1, fiveStar: 1 }])
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 'p1', amount: 25, tipAmount: 3, method: 'CASH', createdAt: new Date('2026-08-01T12:00:00Z') },
    ])
    ;(prismaMock.review.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 'r1', overallRating: 5, createdAt: new Date('2026-08-01T13:00:00Z') },
    ])

    const data = await getBasicMetricsData(VENUE_ID, RANGE)

    expect(data.payments).toHaveLength(1)
    expect(data.reviews).toHaveLength(1)
    expect(data).not.toHaveProperty('responseMode')
    expect(data.performanceByWeekday).toEqual([0, 0, 0, 0, 0, 0, 25])
    expect(prismaMock.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5000 }))
    expect(mockFetchPaymentsForAnalytics).not.toHaveBeenCalled()
  })
})

describe('getBasicMetricsDetailsPage — explicit exports page through all rows', () => {
  beforeEach(() => {
    ;(prismaMock.payment.findMany as jest.Mock).mockReset()
    ;(prismaMock.review.findMany as jest.Mock).mockReset()
    ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ id: VENUE_ID, timezone: 'UTC' })
  })

  it('returns at most 500 transformed payments plus a cursor for the next page', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `payment-${index.toString().padStart(3, '0')}`,
      amount: index + 1,
      tipAmount: 1,
      method: 'CREDIT_CARD',
      createdAt: new Date(`2026-08-${String(31 - (index % 28)).padStart(2, '0')}T12:00:00Z`),
    }))
    ;(prismaMock.payment.findMany as jest.Mock).mockResolvedValueOnce(rows)

    const page = await getBasicMetricsDetailsPage(VENUE_ID, {
      ...RANGE,
      kind: 'payments',
      limit: 500,
    })

    expect(page.items).toHaveLength(500)
    expect(page.nextCursor).toBe('payment-499')
    expect(prismaMock.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 501,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    )
  })

  it('applies the supplied cursor and bounds review export pages too', async () => {
    ;(prismaMock.review.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 'review-2', overallRating: 4, createdAt: new Date('2026-08-02T12:00:00Z') },
    ])

    const page = await getBasicMetricsDetailsPage(VENUE_ID, {
      ...RANGE,
      kind: 'reviews',
      cursor: 'review-1',
      limit: 500,
    })

    expect(page.nextCursor).toBeNull()
    expect(page.items).toEqual([{ id: 'review-2', stars: 4, createdAt: '2026-08-02T12:00:00.000Z' }])
    expect(prismaMock.review.findMany).toHaveBeenCalledWith(expect.objectContaining({ cursor: { id: 'review-1' }, skip: 1, take: 501 }))
  })
})
