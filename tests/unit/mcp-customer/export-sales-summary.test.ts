/**
 * export_sales_summary MCP tool: summary gates on ADVANCED_REPORTS, detailed additionally on
 * TRANSACTION_EXPORT (Premium). Mirrors serialized-gating.test.ts handler-capture style.
 */
import { registerSalesTools } from '../../../src/mcp/tools/sales'
import type { McpScope } from '../../../src/mcp/scope'

const mockPlanGate = jest.fn()
const mockGetSalesSummary = jest.fn()
const mockFlatten = jest.fn()
const mockCount = jest.fn()
const mockFetch = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  computeSettlementProjection: jest.fn(),
  getSalesSummary: (...a: unknown[]) => mockGetSalesSummary(...(a as [])),
  flattenSalesSummaryForExport: (...a: unknown[]) => mockFlatten(...(a as [])),
  countSalesSummaryDetailRows: (...a: unknown[]) => mockCount(...(a as [])),
  fetchSalesSummaryDetailRows: (...a: unknown[]) => mockFetch(...(a as [])),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v?: string) => (v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }) }),
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
beforeEach(() => jest.clearAllMocks())

describe('export_sales_summary — plan gating', () => {
  it('detailed mode is DENIED for a non-Premium (no TRANSACTION_EXPORT) venue', async () => {
    // ADVANCED_REPORTS allowed (null) but TRANSACTION_EXPORT denied (returns a message).
    mockPlanGate.mockImplementation(async (_v: string, code: string) =>
      code === 'TRANSACTION_EXPORT' ? 'La exportación detallada de transacciones requiere el plan Premium.' : null,
    )
    const out = parse(await call('export_sales_summary', { venueId: 'v1', mode: 'detailed' }))
    expect(out.planRequired).toBe(true)
    expect(out.ok).toBe(false)
    expect(mockCount).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('detailed mode + QR_LEGACY is rejected cleanly (no throw, no count/fetch)', async () => {
    // Entitled venue (gate allows everything) — the QR_LEGACY guard must fire before counting,
    // mirroring the HTTP controller. Otherwise buildPaymentWhereFilter('QR_LEGACY') would throw.
    mockPlanGate.mockResolvedValue(null)
    const out = parse(await call('export_sales_summary', { venueId: 'v1', mode: 'detailed', paymentMethod: 'QR_LEGACY' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/QR_LEGACY/)
    expect(mockCount).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('summary mode returns flattened rows for an entitled venue', async () => {
    mockPlanGate.mockResolvedValue(null) // ADVANCED_REPORTS granted
    mockGetSalesSummary.mockResolvedValue({ summary: { grossSales: 100, transactionCount: 3 }, byPaymentMethod: [] })
    mockFlatten.mockReturnValue({ rows: [{ section: 'totals', label: 'Ventas brutas', amount: 100, count: 3, percentage: null }] })
    const out = parse(await call('export_sales_summary', { venueId: 'v1', mode: 'summary' }))
    expect(out.mode).toBe('summary')
    expect(out.rows).toHaveLength(1)
    expect(mockGetSalesSummary).toHaveBeenCalled()
  })
})
