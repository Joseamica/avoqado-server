import { registerTrendTools } from '../../../src/mcp/tools/trends'
import type { McpScope } from '../../../src/mcp/scope'

const mockAgg = jest.fn()
const mockVenues = jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map(id => ({ id, currency: 'MXN' })))

jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: jest.fn(async (ids: string[]) => ids) }))
jest.mock('@/services/access/access.service', () => ({ hasPermission: () => true })) // caller holds analytics:read at every venue
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return v ? { venueId: { in: [v] } } : { venueId: { in: ['v1', 'v2'] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { aggregate: (...a: unknown[]) => mockAgg(...(a as [])), groupBy: (...a: unknown[]) => mockAgg(...a) },
    venue: { findMany: (args: Parameters<typeof mockVenues>[0]) => mockVenues(args) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1', 'v2'],
  // Populated so canRead's `access &&` passes; hasPermission is mocked true (caller holds analytics:read).
  perVenueAccess: new Map([
    ['v1', {} as never],
    ['v2', {} as never],
  ]),
} as McpScope
const call = (args: Record<string, unknown>) => handlers.get('sales_comparison')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerTrendTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('sales_comparison', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockAgg).not.toHaveBeenCalled()
  })

  it('computes the up/down change vs the previous equal window', async () => {
    mockAgg
      .mockResolvedValueOnce([{ venueId: 'v1', _sum: { amount: 12000 }, _count: { _all: 80 } }]) // current
      .mockResolvedValueOnce([{ venueId: 'v1', _sum: { amount: 10000 }, _count: { _all: 70 } }]) // previous
    const out = parse(await call({ venueId: 'v1', days: 7 }))

    expect(out.current.gross).toBe(12000)
    expect(out.previous.gross).toBe(10000)
    expect(out.change).toEqual({ amount: 2000, percent: 20, direction: 'up' })
    // two equal windows queried, only COMPLETED
    expect(mockAgg).toHaveBeenCalledTimes(2)
    expect((mockAgg.mock.calls[0][0] as { where: Record<string, unknown> }).where).toMatchObject({
      venueId: { in: ['v1'] },
      status: 'COMPLETED',
    })
  })

  it('returns percent: null (not Infinity) when the previous period had zero sales', async () => {
    mockAgg
      .mockResolvedValueOnce([{ venueId: 'v1', _sum: { amount: 500 }, _count: { _all: 4 } }])
      .mockResolvedValueOnce([{ venueId: 'v1', _sum: { amount: null }, _count: { _all: 0 } }])
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.change.percent).toBeNull()
    expect(out.change.direction).toBe('up')
    expect(out.change.amount).toBe(500)
  })
})

it('compara por moneda sin crear un crecimiento combinado engañoso', async () => {
  mockVenues.mockResolvedValueOnce([
    { id: 'v1', currency: 'MXN' },
    { id: 'v2', currency: 'USD' },
  ])
  mockAgg
    .mockResolvedValueOnce([
      { venueId: 'v1', _sum: { amount: 100 }, _count: { _all: 1 } },
      { venueId: 'v2', _sum: { amount: 50 }, _count: { _all: 1 } },
    ])
    .mockResolvedValueOnce([
      { venueId: 'v1', _sum: { amount: 50 }, _count: { _all: 1 } },
      { venueId: 'v2', _sum: { amount: 100 }, _count: { _all: 1 } },
    ])
  const out = parse(await call({ days: 7 }))
  expect(out.change).toBeNull()
  expect(out.current.gross).toBeNull()
  expect(out.byCurrency).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ currency: 'MXN', change: { amount: 50, percent: 100, direction: 'up' } }),
      expect.objectContaining({ currency: 'USD', change: { amount: -50, percent: -50, direction: 'down' } }),
    ]),
  )
  expect(mockAgg).toHaveBeenCalledTimes(2)
})
