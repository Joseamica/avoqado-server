/**
 * daily_sales window timezone. 2026-07-03 fix: when focusing ONE venue, the day window must be
 * built in THAT venue's timezone (a Cancún/Tijuana venue's "today" differs from Mexico City).
 * The all-venues roll-up must build one UTC range per venue timezone, because there is no single
 * UTC interval representing the same local calendar day everywhere. Verified under TZ=UTC.
 */
import { registerSalesTools } from '../../../src/mcp/tools/sales'
import type { McpScope } from '../../../src/mcp/scope'

const mockFindMany = jest.fn()
const mockVenueFind = jest.fn()
const mockVenuesFind = jest.fn()

jest.mock('@/services/access/access.service', () => ({
  hasPermission: () => true,
  getUserAccess: jest.fn(),
  createAccessCache: jest.fn(() => ({})),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => (v ? { venueId: { in: [v] } } : { venueId: { in: ['v1', 'v2'] } }),
    requirePermission: jest.fn(),
  }),
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
    payment: { findMany: (...a: unknown[]) => mockFindMany(...(a as [])) },
    venue: {
      findUnique: (...a: unknown[]) => mockVenueFind(...(a as [])),
      findMany: (...a: unknown[]) => mockVenuesFind(...(a as [])),
    },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1', 'v2'],
  perVenueAccess: new Map([
    ['v1', { role: 'OWNER' }],
    ['v2', { role: 'OWNER' }],
  ]),
} as unknown as McpScope
const call = (args: Record<string, unknown>) => handlers.get('daily_sales')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerSalesTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockFindMany.mockResolvedValue([])
})

describe('daily_sales — day window in the VENUE timezone', () => {
  it('single venue in Cancún (UTC-5): the day window uses the venue tz, not hardcoded CDMX', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Cancun' })
    const out = parse(await call({ venueId: 'v1', date: '2026-06-15' }))

    // Cancún has no DST → 2026-06-15 00:00 local = 05:00Z; 23:59:59.999 local = jun-16 04:59:59.999Z.
    expect(out.window.timezone).toBe('America/Cancun')
    expect(out.window.start).toBe('2026-06-15T05:00:00.000Z')
    expect(out.window.end).toBe('2026-06-16T04:59:59.999Z')
    // and the query used those same boundaries
    const arg = mockFindMany.mock.calls[0][0] as { where: { createdAt: { gte: Date; lte: Date } } }
    expect(arg.where.createdAt.gte.toISOString()).toBe('2026-06-15T05:00:00.000Z')
  })

  it('single venue with no timezone set: falls back to Mexico City (UTC-6)', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: null })
    const out = parse(await call({ venueId: 'v1', date: '2026-06-15' }))
    expect(out.window.timezone).toBe('America/Mexico_City')
    expect(out.window.start).toBe('2026-06-15T06:00:00.000Z') // -6, an hour later than Cancún
  })

  it('all-venues roll-up uses each venue local day instead of one CDMX range', async () => {
    mockVenuesFind.mockResolvedValueOnce([
      { id: 'v1', timezone: 'America/Cancun' },
      { id: 'v2', timezone: 'America/Tijuana' },
    ])
    const out = parse(await call({ date: '2026-06-15' }))

    expect(mockVenueFind).not.toHaveBeenCalled()
    expect(mockVenuesFind).toHaveBeenCalledWith({
      where: { id: { in: ['v1', 'v2'] } },
      select: { id: true, timezone: true },
    })
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.OR).toEqual([
      {
        venueId: 'v1',
        createdAt: { gte: new Date('2026-06-15T05:00:00.000Z'), lte: new Date('2026-06-16T04:59:59.999Z') },
      },
      {
        venueId: 'v2',
        createdAt: { gte: new Date('2026-06-15T07:00:00.000Z'), lte: new Date('2026-06-16T06:59:59.999Z') },
      },
    ])
    expect(out.window).toMatchObject({ date: '2026-06-15', timezone: 'PER_VENUE' })
    expect(out.window.byVenue).toHaveLength(2)
  })
})
