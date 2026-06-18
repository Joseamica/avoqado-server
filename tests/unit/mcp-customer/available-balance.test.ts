/**
 * available_balance MCP tool (2026-06-17): "¿cuánto tengo disponible? ¿cuánto
 * pendiente? ¿cuándo y cuánto me depositan?". A thin wrapper over the dashboard
 * availableBalance service — its job is faithful field mapping + the right gate.
 *
 * The platform gates available-balance by PERMISSION only (settlements:read) — NO
 * feature/tier paywall — so this tool mirrors that: core, permission-gated, no plan
 * gate. (Its sibling settlement_calendar is PRO/ADVANCED_REPORTS because the
 * dashboard reconciliation block is; available-balance is core — each mirrors its
 * own endpoint.)
 *
 * Tests: summary + byCardType are mapped 1:1 (no swapped fields), settlements:read
 * is enforced, and a date range converts to a venue-local window.
 */
import { registerSalesTools } from '../../../src/mcp/tools/sales'
import type { McpScope } from '../../../src/mcp/scope'

const mockBalance = jest.fn()
const mockByCard = jest.fn()
const mockRequirePermission = jest.fn()
const mockPlanGate = jest.fn()

jest.mock('@/services/dashboard/availableBalance.dashboard.service', () => ({
  getAvailableBalance: (...a: unknown[]) => mockBalance(...(a as [])),
  getBalanceByCardType: (...a: unknown[]) => mockByCard(...(a as [])),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/legacy/mergedPayments.service', () => ({ fetchPaymentsForAnalytics: jest.fn() }))
jest.mock('@/mcp/chartData', () => ({ getVenueChartData: jest.fn() }))
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  computeSettlementProjection: jest.fn(),
  getSalesSummary: jest.fn(),
  flattenSalesSummaryForExport: jest.fn(),
  countSalesSummaryDetailRows: jest.fn(),
  fetchSalesSummaryDetailRows: jest.fn(),
}))
jest.mock('@/mcp/guard', () => ({
  ScopeError: class ScopeError extends Error {},
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v && v !== 'v1') throw new Error('out of scope')
      return { venueId: { in: ['v1'] } }
    },
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn().mockResolvedValue({ timezone: 'America/Mexico_City' }) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerSalesTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null) // entitled (PRO) by default
  mockBalance.mockResolvedValue({
    totalSales: 64000,
    totalFees: 2947.6,
    availableNow: 1093.1,
    pendingSettlement: 107543.36,
    estimatedNextSettlement: { date: new Date('2026-06-18T06:00:00Z'), amount: 46651.27 },
  })
  mockByCard.mockResolvedValue([
    {
      cardType: 'DEBIT',
      baseSales: 47881.06,
      tips: 7609.06,
      totalSales: 55490.12,
      fees: 1229.78,
      netAmount: 54260.34,
      settlementDays: 1,
      pendingAmount: 46651.27,
      settledAmount: 0,
      transactionCount: 117,
    },
  ])
})

describe('available_balance — faithful mapping', () => {
  it('maps the summary 1:1 (no swapped fields) and serializes the next-settlement date', async () => {
    const out = parse(await call('available_balance', { venueId: 'v1' }))
    expect(out.availableNow).toBe(1093.1)
    expect(out.pendingSettlement).toBe(107543.36)
    expect(out.totalFees).toBe(2947.6)
    expect(out.estimatedNextSettlement.amount).toBe(46651.27)
    expect(out.estimatedNextSettlement.date).toBe('2026-06-18T06:00:00.000Z')
    expect(out.window).toBe('all-time') // no dates → all time
  })

  it('passes the card breakdown through with pending/settled distinct from net', async () => {
    const out = parse(await call('available_balance', { venueId: 'v1' }))
    const c = out.byCardType[0]
    expect(c.cardType).toBe('DEBIT')
    expect(c.netAmount).toBe(54260.34)
    expect(c.pendingAmount).toBe(46651.27) // distinct basis from netAmount — passthrough, not recomputed
    expect(c.settledAmount).toBe(0)
    expect(c.settlementDays).toBe(1)
  })
})

describe('available_balance — date window + gate', () => {
  it('a date range becomes a venue-local window passed to BOTH service calls', async () => {
    await call('available_balance', { venueId: 'v1', fromDate: '2026-06-01', toDate: '2026-06-15' })
    const range = mockBalance.mock.calls[0][1]
    expect(range.from).toBeInstanceOf(Date)
    expect(range.to).toBeInstanceOf(Date)
    // Mexico UTC-6: jun-01 00:00 local = jun-01 06:00Z
    expect(range.from.toISOString()).toBe('2026-06-01T06:00:00.000Z')
    expect(mockByCard.mock.calls[0][1].from.toISOString()).toBe('2026-06-01T06:00:00.000Z')
  })

  it('requires settlements:read for the venue', async () => {
    await call('available_balance', { venueId: 'v1' })
    expect(mockRequirePermission).toHaveBeenCalledWith('settlements:read', 'v1')
  })

  it('is PRO-gated: not entitled (ADVANCED_REPORTS) → planRequired, no balance read', async () => {
    mockPlanGate.mockResolvedValue('El saldo disponible requiere el plan PRO.')
    const out = parse(await call('available_balance', { venueId: 'v1' }))
    expect(out.planRequired).toBe(true)
    expect(mockPlanGate).toHaveBeenCalledWith('v1', 'ADVANCED_REPORTS', expect.any(String))
    expect(mockBalance).not.toHaveBeenCalled()
    expect(mockByCard).not.toHaveBeenCalled()
  })

  it('throws on an out-of-scope venue before reading anything', async () => {
    await expect(call('available_balance', { venueId: 'other' })).rejects.toThrow()
    expect(mockBalance).not.toHaveBeenCalled()
  })
})
