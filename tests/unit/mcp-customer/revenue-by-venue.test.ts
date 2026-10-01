import { registerTrendTools } from '../../../src/mcp/tools/trends'
import { venuesWithFeatureAccess } from '@/services/access/basePlan.service'
import type { McpScope } from '../../../src/mcp/scope'

const mockGroupBy = jest.fn()
const mockVenueFind = jest.fn()

jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: jest.fn(async (ids: string[]) => ids) }))
jest.mock('@/services/access/access.service', () => ({ hasPermission: () => true })) // caller holds analytics:read at every venue
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => (v ? { venueId: { in: [v] } } : { venueId: { in: ['v1', 'v2', 'v3'] } }),
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { aggregate: jest.fn(), groupBy: (...a: unknown[]) => mockGroupBy(...(a as [])) },
    venue: { findMany: (...a: unknown[]) => mockVenueFind(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1', 'v2', 'v3'],
  // Populated so canRead's `access &&` passes; hasPermission is mocked true (caller holds analytics:read).
  perVenueAccess: new Map([
    ['v1', {} as never],
    ['v2', {} as never],
    ['v3', {} as never],
  ]),
} as McpScope
const call = (args: Record<string, unknown>) => handlers.get('revenue_by_venue')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerTrendTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('revenue_by_venue', () => {
  it('ranks venues by gross, includes zero-sale venues, and sums the total', async () => {
    mockGroupBy.mockResolvedValueOnce([
      { venueId: 'v2', _sum: { amount: 3000 }, _count: { _all: 25 } },
      { venueId: 'v1', _sum: { amount: 5000 }, _count: { _all: 40 } },
    ])
    mockVenueFind.mockResolvedValueOnce([
      { id: 'v1', name: 'Centro' },
      { id: 'v2', name: 'Norte' },
      { id: 'v3', name: 'Sur' }, // no sales in window
    ])

    const out = parse(await call({ days: 30 }))

    expect(out.venueCount).toBe(3)
    expect(out.total).toBe(8000)
    expect(out.venues).toEqual([
      { venueId: 'v1', venue: 'Centro', currency: 'UNKNOWN', gross: 5000, transactions: 40 },
      { venueId: 'v2', venue: 'Norte', currency: 'UNKNOWN', gross: 3000, transactions: 25 },
      { venueId: 'v3', venue: 'Sur', currency: 'UNKNOWN', gross: 0, transactions: 0 },
    ])
    // only COMPLETED payments across the caller's whole scope
    expect((mockGroupBy.mock.calls[0][0] as { where: Record<string, unknown> }).where).toMatchObject({
      venueId: { in: ['v1', 'v2', 'v3'] },
      status: 'COMPLETED',
    })
    // venue names looked up by primary key, not venueId
    expect((mockVenueFind.mock.calls[0][0] as { where: Record<string, unknown> }).where).toEqual({ id: { in: ['v1', 'v2', 'v3'] } })
  })
})

it('explica exclusiones por rol y por plan en vez de presentar un total global incompleto', async () => {
  const saved = scope.perVenueAccess.get('v3')!
  scope.perVenueAccess.delete('v3')
  ;(venuesWithFeatureAccess as jest.Mock).mockResolvedValueOnce(new Set(['v1']))
  mockGroupBy.mockResolvedValueOnce([{ venueId: 'v1', _sum: { amount: 100 }, _count: { _all: 1 } }])
  mockVenueFind.mockResolvedValueOnce([{ id: 'v1', name: 'Centro' }])
  try {
    const out = parse(await call({ days: 30 }))
    expect(out.coverage).toMatchObject({
      requestedVenueCount: 3,
      includedVenueCount: 1,
      excludedVenueCount: 2,
      complete: false,
      excludedByPermission: 1,
      excludedByPlan: 1,
    })
    expect(out.coverage.message).toMatch(/parcial/)
  } finally {
    scope.perVenueAccess.set('v3', saved)
  }
})

it('pagina sucursales manteniendo el total de todo el conjunto autorizado', async () => {
  mockGroupBy.mockResolvedValueOnce([{ venueId: 'v1', _sum: { amount: 100 }, _count: { _all: 1 } }])
  mockVenueFind.mockResolvedValueOnce([
    { id: 'v1', name: 'Centro' },
    { id: 'v2', name: 'Norte' },
    { id: 'v3', name: 'Sur' },
  ])
  const out = parse(await call({ limit: 1, offset: 1 }))
  expect(out).toMatchObject({ total: 100, venueCount: 3, hasMore: true, nextOffset: 2 })
  expect(out.venues).toHaveLength(1)
})

it('no suma importes de distintas monedas y mantiene cada total aunque pagine el detalle', async () => {
  mockGroupBy.mockResolvedValueOnce([
    { venueId: 'v1', _sum: { amount: 1000 }, _count: { _all: 10 } },
    { venueId: 'v2', _sum: { amount: 50 }, _count: { _all: 1 } },
  ])
  mockVenueFind.mockResolvedValueOnce([
    { id: 'v1', name: 'Centro', currency: 'MXN' },
    { id: 'v2', name: 'Norte', currency: 'USD' },
    { id: 'v3', name: 'Sur', currency: 'MXN' },
  ])
  const out = parse(await call({ limit: 1 }))
  expect(out.total).toBeNull()
  expect(out.totalsByCurrency).toEqual([
    { currency: 'MXN', total: 1000 },
    { currency: 'USD', total: 50 },
  ])
  expect(out.venues).toHaveLength(1)
})
