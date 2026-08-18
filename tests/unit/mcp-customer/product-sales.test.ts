import { registerProductTools } from '../../../src/mcp/tools/products'
import type { McpScope } from '../../../src/mcp/scope'

const mockVenueFind = jest.fn()
const mockProductFind = jest.fn()

/**
 * Revenue used to come from `prisma.orderItem.aggregate({ _sum: { total } })`.
 * `OrderItem.total` disagrees with what the dashboard reports (it carries tax
 * INCLUDED on some rows and ON TOP on others, and excludes modifiers on most),
 * so the MCP answered a different number than the dashboard for the same
 * product. It now runs the shared `lineRevenueSql()` in raw SQL — which Prisma's
 * aggregate cannot express — hence this mock moved from `aggregate` to
 * `$queryRaw`.
 */
const mockQueryRaw = jest.fn()

/**
 * The SQL text of the last $queryRaw call. The literal parts arrive as the
 * tagged-template `strings`, but fragments injected with `Prisma.raw(...)` come
 * through as VALUES (a `Prisma.Sql`, whose own text is in `.strings`) — so both
 * have to be folded in, or the assertions below silently read half the query.
 */
const lastSql = () => {
  const call: unknown[] = mockQueryRaw.mock.calls[0] ?? []
  const literal = ((call[0] as string[]) ?? []).join(' ')
  const injected = call
    .slice(1)
    .map((v: unknown) => (v && typeof v === 'object' && 'strings' in v ? (v as { strings: string[] }).strings.join(' ') : ''))
    .join(' ')
  return `${literal} ${injected}`
}
/** The interpolated values of the last $queryRaw call. */
const lastValues = () => (mockQueryRaw.mock.calls[0] ?? []).slice(1)

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
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...(a as [])),
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
    expect(mockQueryRaw).not.toHaveBeenCalled()
  })

  it('aggregates units + revenue for a single match, excluding cancelled/deleted orders', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockProductFind.mockResolvedValueOnce([{ id: 'p2', name: 'Hamburguesa BBQ' }])
    mockQueryRaw.mockResolvedValueOnce([{ units: 87, revenue: 13050, lines: 61n }])

    const out = parse(await call({ venueId: 'v1', name: 'bbq' }))

    expect(out).toMatchObject({ found: true, product: 'Hamburguesa BBQ', unitsSold: 87, revenue: 13050, timesOrdered: 61 })
  })

  it('TENANT + status scoping survives the move to raw SQL', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockProductFind.mockResolvedValueOnce([{ id: 'p2', name: 'Hamburguesa BBQ' }])
    mockQueryRaw.mockResolvedValueOnce([{ units: 1, revenue: 1, lines: 1n }])

    await call({ venueId: 'v1', name: 'bbq' })

    const sql = lastSql()
    // Raw SQL loses Prisma's automatic scoping, so these are now the ONLY thing
    // standing between one tenant and another's sales.
    expect(sql).toContain('o."venueId" =')
    expect(sql).toContain('o.status NOT IN')
    // Both the venue and the product arrive as bound PARAMETERS, never inlined.
    expect(lastValues()).toEqual(expect.arrayContaining(['v1', 'p2']))
  })

  it('uses the shared revenue definition, not OrderItem.total', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockProductFind.mockResolvedValueOnce([{ id: 'p2', name: 'Hamburguesa BBQ' }])
    mockQueryRaw.mockResolvedValueOnce([{ units: 1, revenue: 1, lines: 1n }])

    await call({ venueId: 'v1', name: 'bbq' })

    const sql = lastSql()
    expect(sql).toContain('FROM "OrderItemModifier"') // modifiers counted
    expect(sql).toContain('COALESCE(oi."weightQuantity", oi."quantity")') // weight-aware
    expect(sql).toContain('- oi."discountAmount"') // discount subtracted
    expect(sql).not.toMatch(/SUM\(\s*oi\."total"\s*\)/) // never the ambiguous column
  })

  it('reports zero (not NaN) for a product that never sold', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockProductFind.mockResolvedValueOnce([{ id: 'p3', name: 'Sopa rara' }])
    mockQueryRaw.mockResolvedValueOnce([{ units: null, revenue: null, lines: 0n }])
    const out = parse(await call({ venueId: 'v1', name: 'sopa' }))
    expect(out).toMatchObject({ found: true, unitsSold: 0, revenue: 0, timesOrdered: 0 })
  })
})
