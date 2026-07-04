/**
 * settlement_week MCP tool (2026-07-04): "¿cuánto me cae cada día esta semana?".
 * A thin wrapper over getSettlementsLandingInWeek (settlementCalendar service) —
 * its job is the right gates (scope + PRO plan) + faithful passthrough of the
 * weekly landing shape (days by settlement date + week total).
 *
 * ⚠️ LOCKSTEP NOTE: this tool gates on `analytics:read` to mirror its sibling
 * `settlement_calendar` MCP tool. The dashboard settlement-week ENDPOINT, however,
 * gates on `settlements:read` (like available_balance). This mismatch is
 * pre-existing (settlement_calendar has it too) and is flagged for Jose to
 * reconcile — do NOT silently "fix" one side, since MCP operators may hold one
 * permission but not the other. This test pins the CURRENT value so any change is
 * a deliberate, reviewed one.
 */
import { registerSalesTools } from '../../../src/mcp/tools/sales'
import type { McpScope } from '../../../src/mcp/scope'

const mockGetWeek = jest.fn()
const mockBounds = jest.fn()
const mockRequirePermission = jest.fn()
const mockPlanGate = jest.fn()

jest.mock('@/services/dashboard/settlementCalendar.dashboard.service', () => ({
  getSettlementsLandingInWeek: (...a: unknown[]) => mockGetWeek(...(a as [])),
  venueWeekBounds: (...a: unknown[]) => mockBounds(...(a as [])),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/dashboard/availableBalance.dashboard.service', () => ({
  getAvailableBalance: jest.fn(),
  getBalanceByCardType: jest.fn(),
}))
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

const WEEK = {
  weekStart: '2026-07-06',
  weekEnd: '2026-07-12',
  days: [
    {
      date: '2026-07-06',
      status: 'settled',
      gross: 1000,
      commission: 35,
      net: 965,
      count: 1,
      byMerchant: [{ merchantAccountId: 'm1', displayName: 'Amaena - B', provider: 'AngelPay', gross: 1000, commission: 35, net: 965, count: 1 }],
      byCardType: [{ cardType: 'CREDIT', gross: 1000, commission: 35, net: 965, count: 1 }],
    },
  ],
  weekTotal: { gross: 1000, commission: 35, net: 965, count: 1 },
}

beforeAll(() => {
  registerSalesTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null) // entitled (PRO) by default
  mockBounds.mockReturnValue({ weekStart: new Date('2026-07-06T06:00:00Z'), weekEnd: new Date('2026-07-13T05:59:59Z') })
  mockGetWeek.mockResolvedValue(WEEK)
})

describe('settlement_week — faithful passthrough', () => {
  it('returns venueId + timezone + the full weekly landing shape', async () => {
    const out = parse(await call('settlement_week', { venueId: 'v1' }))
    expect(out.venueId).toBe('v1')
    expect(out.timezone).toBe('America/Mexico_City')
    expect(out.weekStart).toBe('2026-07-06')
    expect(out.weekEnd).toBe('2026-07-12')
    expect(out.weekTotal).toEqual({ gross: 1000, commission: 35, net: 965, count: 1 })
    expect(out.days[0]).toMatchObject({ date: '2026-07-06', net: 965 })
    expect(out.days[0].byMerchant[0].displayName).toBe('Amaena - B')
  })

  it('forwards weekStart through venueWeekBounds to the service', async () => {
    await call('settlement_week', { venueId: 'v1', weekStart: '2026-07-08' })
    expect(mockBounds).toHaveBeenCalledWith('2026-07-08', 'America/Mexico_City')
    const [venueId, ws, we, tz] = mockGetWeek.mock.calls[0]
    expect(venueId).toBe('v1')
    expect(ws).toBeInstanceOf(Date)
    expect(we).toBeInstanceOf(Date)
    expect(tz).toBe('America/Mexico_City')
  })
})

describe('settlement_week — gates', () => {
  it('requires the read permission for the venue (pinned: analytics:read — see LOCKSTEP NOTE)', async () => {
    await call('settlement_week', { venueId: 'v1' })
    expect(mockRequirePermission).toHaveBeenCalledWith('analytics:read', 'v1')
  })

  it('is PRO-gated: not entitled (ADVANCED_REPORTS) → planRequired, no week read', async () => {
    mockPlanGate.mockResolvedValue('El calendario semanal de liquidación requiere el plan PRO.')
    const out = parse(await call('settlement_week', { venueId: 'v1' }))
    expect(out.planRequired).toBe(true)
    expect(mockPlanGate).toHaveBeenCalledWith('v1', 'ADVANCED_REPORTS', expect.any(String))
    expect(mockGetWeek).not.toHaveBeenCalled()
  })

  it('throws on an out-of-scope venue before reading anything', async () => {
    await expect(call('settlement_week', { venueId: 'other' })).rejects.toThrow()
    expect(mockGetWeek).not.toHaveBeenCalled()
  })
})
