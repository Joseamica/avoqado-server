/**
 * sales_by_payment_method: returns BOTH grossCollected (tips-INCLUSIVE, net of
 * refunds, incl cancelled = the dashboard "Métodos de Pago" panel 1:1) and
 * netSales (sale value net of refunds, EXCL cancelled + EXCL tips), over a
 * venue-LOCAL window whose toDate day is fully included.
 *
 * 2026-07-03 fix (this file): the OLD net pass used includeRefunds:false, so a
 * field labeled "net of refunds" never subtracted them; and gross summed amount
 * only, so it did NOT match the tips-inclusive dashboard panel. Both corrected.
 * Regression preserved: the bare-date path used to drop the last day + shift ~6h.
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

  it('runs TWO analytics passes and correctly labels gross (tips-incl, net of refunds) vs net sales', async () => {
    // Same sale+refund rows on BOTH passes (the mock controls each return). A sale of
    // $100 + $15 tip, and a partial refund of -$10 + -$2 tip (refunds are negative rows).
    const rows = [
      { method: 'CASH', amount: 100, tipAmount: 15, type: 'REGULAR', status: 'COMPLETED' },
      { method: 'CASH', amount: -10, tipAmount: -2, type: 'REFUND', status: 'COMPLETED' },
    ]
    mockFetch.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows)

    const out = parse(await call('sales_by_payment_method', { venueId: 'v1', fromDate: '2026-06-02', toDate: '2026-06-15' }))

    expect(mockFetch).toHaveBeenCalledTimes(2)
    // gross pass mirrors the dashboard panel: refunds subtracted (includeRefunds) + cancelled kept.
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ includeRefunds: true, excludeCancelledOrders: false })
    // net pass MUST also include refunds so "net of refunds" actually subtracts them (the bug was false here).
    expect(mockFetch.mock.calls[1][1]).toMatchObject({ includeRefunds: true, excludeCancelledOrders: true })
    // both passes get real Date boundaries (not the buggy bare-date path)
    expect(mockFetch.mock.calls[0][1].fromDate).toBeInstanceOf(Date)
    const to = mockFetch.mock.calls[0][1].toDate as Date
    expect(to.getTime()).toBeGreaterThan((mockFetch.mock.calls[0][1].fromDate as Date).getTime())
    expect(to.toISOString()).toMatch(/59:59\.999Z$/) // whole last day included

    // gross is tips-INCLUSIVE and nets the refund: (100+15) + (-10-2) = 103
    expect(out.grossCollected.byMethod[0]).toMatchObject({ method: 'CASH', total: 103, count: 2 })
    // net is amount-only (tips excluded) and nets the refund: 100 + (-10) = 90
    expect(out.netSales.byMethod[0]).toMatchObject({ method: 'CASH', total: 90, count: 2 })
    // the whole point: gross > net by exactly the net tips (13), and net actually subtracted the refund
    expect(out.grossCollected.total - out.netSales.total).toBeCloseTo(13, 2)
    expect(out.window).toMatchObject({ timezone: 'America/Mexico_City' })
    expect(out.note).toMatch(/propinas/)
  })
})
