import { registerSalesTools } from '../../../src/mcp/tools/sales'
import type { McpScope } from '../../../src/mcp/scope'

const mockGroupBy = jest.fn()
const mockVenueFind = jest.fn()
const mockTenders = jest.fn()

jest.mock('@/services/access/access.service', () => ({
  hasPermission: () => true,
  getUserAccess: jest.fn(),
  createAccessCache: jest.fn(() => ({})),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v?: string) => ({ venueId: { in: [v ?? 'v1'] } }), requirePermission: jest.fn() }),
}))
jest.mock('@/mcp/chartData', () => ({ getVenueChartData: jest.fn() }))
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  computeSettlementProjection: jest.fn(),
  getSalesSummary: jest.fn(),
  flattenSalesSummaryForExport: jest.fn(),
  countSalesSummaryDetailRows: jest.fn(),
  fetchSalesSummaryDetailRows: jest.fn(),
}))
jest.mock('@/services/legacy/mergedPayments.service', () => ({ fetchPaymentsForAnalytics: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { groupBy: (...a: unknown[]) => mockGroupBy(...(a as [])) },
    venue: { findUnique: (...a: unknown[]) => mockVenueFind(...(a as [])), findMany: jest.fn() },
    venueTenderType: { findMany: (...a: unknown[]) => mockTenders(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { role: 'OWNER' }]]),
} as unknown as McpScope
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerSalesTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})

it('🔴 daily_sales: la venta de tarjetas sale de gross (va en giftCardLoads) y lo pagado con saldo es GIFT_CARD, no OTHER', async () => {
  mockVenueFind.mockResolvedValue({ timezone: 'America/Mexico_City', currency: 'MXN' })
  mockGroupBy
    .mockResolvedValueOnce([
      {
        venueId: 'v1',
        method: 'CASH',
        type: 'REGULAR',
        merchantAccountId: null,
        tenderTypeId: null,
        _sum: { amount: 300, tipAmount: 0 },
        _count: { _all: 1 },
      },
      {
        venueId: 'v1',
        method: 'OTHER',
        type: 'REGULAR',
        merchantAccountId: null,
        tenderTypeId: 'tender-gc',
        _sum: { amount: 200, tipAmount: 0 },
        _count: { _all: 1 },
      },
    ])
    .mockResolvedValueOnce([{ venueId: 'v1', _sum: { amount: 500 } }])
  mockTenders.mockResolvedValue([{ id: 'tender-gc' }])
  const out = parse(await handlers.get('daily_sales')!({ venueId: 'v1', date: '2026-10-14' }, {}))
  expect(out.gross).toBe(500)
  expect(out.byMethod).toEqual({ CASH: 300, GIFT_CARD: 200 })
  expect(out.giftCardLoads).toBe(500)
  expect(out.totalsByCurrency[0]).toMatchObject({ currency: 'MXN', gross: 500, giftCardLoads: 500 })
  expect(mockGroupBy.mock.calls[0][0].where.AND).toEqual([{ order: { items: { none: { giftCardId: { not: null } } } } }])
  expect(mockGroupBy.mock.calls[1][0].where.AND).toEqual([{ order: { items: { some: { giftCardId: { not: null } } } } }])
})
