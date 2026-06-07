import { registerOrderTools } from '../../../src/mcp/tools/orders'
import type { McpScope } from '../../../src/mcp/scope'

const mockVenueFind = jest.fn()
const mockAggregate = jest.fn()
const mockFindMany = jest.fn()

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
    venue: { findUnique: (...a: unknown[]) => mockVenueFind(...(a as [])) },
    order: {
      aggregate: (...a: unknown[]) => mockAggregate(...(a as [])),
      findMany: (...a: unknown[]) => mockFindMany(...(a as [])),
    },
    serializedItem: { findFirst: jest.fn() }, // find_order also registers from this module
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1', 'v2'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('search_orders')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerOrderTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('search_orders', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockAggregate).not.toHaveBeenCalled()
  })

  it('maps status/type filters to enums and returns a count+total summary', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockAggregate.mockResolvedValueOnce({ _count: { _all: 2 }, _sum: { total: 920 } })
    mockFindMany.mockResolvedValueOnce([
      {
        orderNumber: 'A-1001',
        type: 'DELIVERY',
        status: 'CANCELLED',
        paymentStatus: 'PENDING',
        total: 420,
        createdAt: new Date('2026-06-06T18:00:00Z'),
        venue: { name: 'Centro' },
        table: null,
      },
    ])
    const out = parse(await call({ venueId: 'v1', status: 'cancelled', type: 'delivery' }))

    const where = (mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where).toMatchObject({ venueId: { in: ['v1'] }, status: 'CANCELLED', type: 'DELIVERY' })
    expect(where.createdAt).toBeDefined() // default 7-day window applied
    expect(out.summary).toEqual({ count: 2, total: 920 })
    expect(out.orders[0]).toMatchObject({ orderNumber: 'A-1001', type: 'DELIVERY', status: 'CANCELLED', table: null })
  })

  it('omits status/type from the WHERE when "all" (or unset), spanning all scoped venues', async () => {
    mockAggregate.mockResolvedValueOnce({ _count: { _all: 0 }, _sum: { total: null } })
    mockFindMany.mockResolvedValueOnce([])
    const out = parse(await call({})) // no venueId → all scoped venues, no venue tz lookup

    expect(mockVenueFind).not.toHaveBeenCalled()
    const where = (mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where).toMatchObject({ venueId: { in: ['v1', 'v2'] } })
    expect(where.status).toBeUndefined()
    expect(where.type).toBeUndefined()
    expect(out.summary).toEqual({ count: 0, total: 0 })
  })
})
