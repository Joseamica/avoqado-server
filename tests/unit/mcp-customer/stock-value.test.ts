import { registerInventoryTools } from '../../../src/mcp/tools/inventory'
import type { McpScope } from '../../../src/mcp/scope'

const mockInventoryFind = jest.fn()
const mockQuery = jest.fn()

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
// sibling inventory tools import these at module load — stub so registration doesn't blow up
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({ serializedInventoryService: {} }))
jest.mock('@/services/dashboard/productInventory.service', () => ({ adjustInventoryStock: jest.fn() }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $queryRaw: (...a: unknown[]) => mockQuery(...a),
    inventory: { findMany: (...a: unknown[]) => mockInventoryFind(...(a as [])) },
    product: { findMany: jest.fn() },
    serializedItem: { groupBy: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('stock_value')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerInventoryTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('stock_value', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockInventoryFind).not.toHaveBeenCalled()
  })

  it('sums cost & retail value, counts items without cost, and ranks by cost value', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        productsInStock: 3,
        itemsWithoutCost: 1,
        totalCostValue: 520,
        totalRetailValue: 1380,
        potentialMargin: 860,
        topItems: [
          { product: 'Vino', costValue: 400 },
          { product: 'Cerveza', costValue: 120 },
          { product: 'Servilletas', unitCost: null, costValue: null },
        ],
      },
    ])
    const out = parse(await call({ venueId: 'v1' }))

    expect(out.productsInStock).toBe(3)
    expect(out.itemsWithoutCost).toBe(1)
    expect(out.totalCostValue).toBe(520) // 120 + 400 (no-cost item excluded)
    expect(out.totalRetailValue).toBe(1380) // 350 + 1000 + 30
    expect(out.potentialMargin).toBe(860) // 1380 - 520
    // ranked by cost value desc; no-cost item (costValue null) ranks last
    expect(out.topItems.map((i: { product: string }) => i.product)).toEqual(['Vino', 'Cerveza', 'Servilletas'])
    expect(out.topItems[2].unitCost).toBeNull()
    expect(out.topItems[2].costValue).toBeNull()
  })
})

it('pagina el detalle sin recortar la valoración total y nunca carga todas las existencias', async () => {
  mockQuery.mockResolvedValueOnce([
    {
      productsInStock: 10001,
      itemsWithoutCost: 2,
      totalCostValue: 500000,
      totalRetailValue: 900000,
      potentialMargin: 400000,
      topItems: [{ product: 'Último', costValue: 10 }],
    },
  ])
  const out = parse(await call({ venueId: 'v1', limit: 1, offset: 10000 }))
  expect(out).toMatchObject({ productsInStock: 10001, totalCostValue: 500000, count: 1, hasMore: false, nextOffset: null })
  expect(mockInventoryFind).not.toHaveBeenCalled()
  expect(mockQuery).toHaveBeenCalledTimes(1)
})

it('low_stock pagina en SQL sin ocultar el total ni devolver otros venues', async () => {
  mockQuery.mockResolvedValueOnce([{ total: 101, lowStock: [{ product: 'Café', shortBy: 20 }] }])
  const out = parse(await handlers.get('low_stock')!({ venueId: 'v1', limit: 1, offset: 99 }, {}))
  expect(out).toMatchObject({ total: 101, count: 1, hasMore: true, nextOffset: 100 })
  expect(mockInventoryFind).not.toHaveBeenCalled()
  const [sql, ...values] = mockQuery.mock.calls[0]
  expect(values).toEqual(['v1', 1, 99])
  expect(sql.join('?')).toContain('i."venueId" = ?')
})
