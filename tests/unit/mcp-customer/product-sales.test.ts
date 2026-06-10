import { registerProductTools } from '../../../src/mcp/tools/products'
import type { McpScope } from '../../../src/mcp/scope'

const mockVenueFind = jest.fn()
const mockProductFind = jest.fn()
const mockItemAgg = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: (...a: unknown[]) => mockVenueFind(...(a as [])) },
    product: { findMany: (...a: unknown[]) => mockProductFind(...(a as [])) },
    orderItem: { aggregate: (...a: unknown[]) => mockItemAgg(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('product_sales')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerProductTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('product_sales', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign', name: 'x' })).rejects.toThrow('out of scope')
    expect(mockProductFind).not.toHaveBeenCalled()
  })

  it('returns the candidates (no aggregate) when the name is ambiguous', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockProductFind.mockResolvedValueOnce([
      { id: 'p1', name: 'Hamburguesa Clásica' },
      { id: 'p2', name: 'Hamburguesa BBQ' },
    ])
    const out = parse(await call({ venueId: 'v1', name: 'hamburguesa' }))
    expect(out.found).toBe(false)
    expect(out.ambiguous).toBe(true)
    expect(mockItemAgg).not.toHaveBeenCalled()
  })

  it('aggregates units + revenue for a single match, excluding cancelled/deleted orders', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockProductFind.mockResolvedValueOnce([{ id: 'p2', name: 'Hamburguesa BBQ' }])
    mockItemAgg.mockResolvedValueOnce({ _sum: { quantity: 87, total: 13050 }, _count: { _all: 61 } })

    const out = parse(await call({ venueId: 'v1', name: 'bbq' }))

    expect(out).toMatchObject({ found: true, product: 'Hamburguesa BBQ', unitsSold: 87, revenue: 13050, timesOrdered: 61 })
    const where = (mockItemAgg.mock.calls[0][0] as { where: { productId: string; order: Record<string, unknown> } }).where
    expect(where.productId).toBe('p2')
    expect(where.order).toMatchObject({ venueId: { in: ['v1'] }, status: { notIn: ['CANCELLED', 'DELETED'] } })
  })

  it('reports zero (not NaN) for a product that never sold', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockProductFind.mockResolvedValueOnce([{ id: 'p3', name: 'Sopa rara' }])
    mockItemAgg.mockResolvedValueOnce({ _sum: { quantity: null, total: null }, _count: { _all: 0 } })
    const out = parse(await call({ venueId: 'v1', name: 'sopa' }))
    expect(out).toMatchObject({ found: true, unitsSold: 0, revenue: 0, timesOrdered: 0 })
  })
})
