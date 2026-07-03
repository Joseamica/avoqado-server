/**
 * sales_by_payment_method (2026-06-15 fix): returns BOTH grossCollected (incl
 * refunds + cancelled orders = dashboard panel) and netSales (excl), over a
 * venue-LOCAL window whose toDate day is fully included. Two fetchPaymentsForAnalytics
 * passes with the right flags. Regression: the bare-date path used to drop the
 * last day + shift ~6h (Mindform: 17/$6,487.60 instead of 21/$6,634.60).
 */
import { registerSalesTools } from '../../../src/mcp/tools/sales'
import type { McpScope } from '../../../src/mcp/scope'

const mockPlanGate = jest.fn()
const mockFetch = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/legacy/mergedPayments.service', () => ({ fetchPaymentsForAnalytics: (...a: unknown[]) => mockFetch(...(a as [])) }))
jest.mock('@/mcp/chartData', () => ({ getVenueChartData: jest.fn() }))
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  computeSettlementProjection: jest.fn(),
  getSalesSummary: jest.fn(),
  flattenSalesSummaryForExport: jest.fn(),
  countSalesSummaryDetailRows: jest.fn(),
  fetchSalesSummaryDetailRows: jest.fn(),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => (v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }),
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn().mockResolvedValue({ timezone: 'America/Mexico_City' }) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerSalesTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null) // ADVANCED_REPORTS entitled
})

describe('sales_by_payment_method — gross vs net, venue-local window', () => {
  it('denied when ADVANCED_REPORTS gate returns a message', async () => {
    mockPlanGate.mockResolvedValueOnce('Los reportes avanzados no...')
    const out = parse(await call('sales_by_payment_method', { venueId: 'v1', fromDate: '2026-06-02', toDate: '2026-06-15' }))
    expect(out.planRequired).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('runs TWO analytics passes (gross incl refunds/cancelled, net excl) and labels both', async () => {
    // gross pass: a sale + a refund (refunds are negative) → 2 rows, total 90; net pass: sale only
    mockFetch
      .mockResolvedValueOnce([
        { method: 'CASH', amount: 100, type: 'REGULAR', status: 'COMPLETED' },
        { method: 'CASH', amount: -10, type: 'REFUND', status: 'COMPLETED' },
      ])
      .mockResolvedValueOnce([{ method: 'CASH', amount: 100, type: 'REGULAR', status: 'COMPLETED' }])

    const out = parse(await call('sales_by_payment_method', { venueId: 'v1', fromDate: '2026-06-02', toDate: '2026-06-15' }))

    expect(mockFetch).toHaveBeenCalledTimes(2)
    // gross = everything collected (matches the dashboard "Métodos de Pago" panel)
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ includeRefunds: true, excludeCancelledOrders: false })
    // net = excludes refunds + cancelled orders
    expect(mockFetch.mock.calls[1][1]).toMatchObject({ includeRefunds: false, excludeCancelledOrders: true })
    // both passes get real Date boundaries (not the buggy bare-date path)
    expect(mockFetch.mock.calls[0][1].fromDate).toBeInstanceOf(Date)
    expect(mockFetch.mock.calls[0][1].toDate).toBeInstanceOf(Date)
    // the toDate boundary is AFTER fromDate and lands at an end-of-day (…59.999) — the whole last day is in
    const to = mockFetch.mock.calls[0][1].toDate as Date
    expect(to.getTime()).toBeGreaterThan((mockFetch.mock.calls[0][1].fromDate as Date).getTime())
    expect(to.toISOString()).toMatch(/59:59\.999Z$/)

    expect(out.grossCollected.byMethod[0]).toMatchObject({ method: 'CASH', total: 90, count: 2 }) // 100 + (-10)
    expect(out.netSales.byMethod[0]).toMatchObject({ method: 'CASH', total: 100, count: 1 })
    expect(out.window).toMatchObject({ timezone: 'America/Mexico_City' })
    expect(out.note).toMatch(/grossCollected/)
  })
})
