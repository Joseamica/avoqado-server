/**
 * daily_sales window timezone. 2026-07-03 fix: when focusing ONE venue, the day window must be
 * built in THAT venue's timezone (a Cancún/Tijuana venue's "today" differs from Mexico City).
 * The all-venues roll-up must build one UTC range per venue timezone, because there is no single
 * UTC interval representing the same local calendar day everywhere. Verified under TZ=UTC.
 */
import { registerSalesTools } from '../../../src/mcp/tools/sales'
import type { McpScope } from '../../../src/mcp/scope'

const mockFindMany = jest.fn()
const mockGroupBy = jest.fn()
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
    payment: { findMany: (...a: unknown[]) => mockFindMany(...(a as [])), groupBy: (...a: unknown[]) => mockGroupBy(...(a as [])) },
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
  mockGroupBy.mockResolvedValue([])
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
    const arg = mockGroupBy.mock.calls[0][0] as { where: { createdAt: { gte: Date; lte: Date } } }
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
      select: { id: true, timezone: true, currency: true },
      take: 2,
    })
    const where = mockGroupBy.mock.calls[0][0].where
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

it('agrega cien mil pagos en DB sin cargarlos en memoria y conserva la cantidad y propinas', async () => {
  mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
  mockGroupBy.mockResolvedValueOnce([
    { method: 'CASH', type: 'REGULAR', merchantAccountId: null, _sum: { amount: 100, tipAmount: 10 }, _count: { _all: 2 } },
    {
      method: 'CREDIT_CARD',
      type: 'FAST',
      merchantAccountId: 'merchant',
      _sum: { amount: 2000000, tipAmount: 50000 },
      _count: { _all: 100000 },
    },
  ])
  const out = parse(await call({ venueId: 'v1', date: '2026-06-15' }))
  expect(mockFindMany).not.toHaveBeenCalled()
  expect(mockGroupBy).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'COMPLETED' }) }))
  expect(out).toMatchObject({
    completedCount: 100002,
    gross: 2000100,
    byMethod: { CASH: 100, CREDIT_CARD: 2000000 },
    byMerchantAccount: { merchant: 2050000 },
  })
})

it('explica la cobertura parcial cuando falta permiso en otro venue, sin sumar sus pagos', async () => {
  // The real guard is exercised in read-permissions.test.ts; here the aggregate receives a restricted principal.
  const access = scope.perVenueAccess.get('v2')!
  scope.perVenueAccess.delete('v2')
  mockVenuesFind.mockResolvedValueOnce([{ id: 'v1', timezone: 'America/Mexico_City' }])
  try {
    const out = parse(await call({ date: '2026-06-15' }))
    expect(out.coverage).toMatchObject({ requestedVenueCount: 2, includedVenueCount: 1, excludedVenueCount: 1, complete: false })
    expect(mockGroupBy.mock.calls[0][0].where.venueId.in).toEqual(['v1'])
  } finally {
    scope.perVenueAccess.set('v2', access)
  }
})

it('separa monedas en el resumen general sin inventar conversión ni sumar MXN con USD', async () => {
  mockVenuesFind.mockResolvedValueOnce([
    { id: 'v1', timezone: 'America/Mexico_City', currency: 'MXN' },
    { id: 'v2', timezone: 'America/Tijuana', currency: 'USD' },
  ])
  mockGroupBy.mockResolvedValueOnce([
    { venueId: 'v1', method: 'CASH', type: 'REGULAR', merchantAccountId: null, _sum: { amount: 1000, tipAmount: 0 }, _count: { _all: 2 } },
    { venueId: 'v2', method: 'CASH', type: 'REGULAR', merchantAccountId: null, _sum: { amount: 50, tipAmount: 0 }, _count: { _all: 1 } },
  ])
  const out = parse(await call({ date: '2026-06-15' }))
  expect(out.gross).toBeNull()
  expect(out.totalsByCurrency).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ currency: 'MXN', gross: 1000 }),
      expect.objectContaining({ currency: 'USD', gross: 50 }),
    ]),
  )
  expect(mockGroupBy).toHaveBeenCalledTimes(1)
  expect(out.completedCount).toBe(3)
})
