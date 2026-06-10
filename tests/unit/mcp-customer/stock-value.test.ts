import { registerInventoryTools } from '../../../src/mcp/tools/inventory'
import type { McpScope } from '../../../src/mcp/scope'

const mockInventoryFind = jest.fn()

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
    mockInventoryFind.mockResolvedValueOnce([
      { currentStock: 10, product: { name: 'Cerveza', sku: 'BEER', cost: 12, price: 35 } }, // cost 120, retail 350
      { currentStock: 4, product: { name: 'Vino', sku: 'WINE', cost: 100, price: 250 } }, // cost 400, retail 1000
      { currentStock: 6, product: { name: 'Servilletas', sku: 'NAP', cost: null, price: 5 } }, // no cost, retail 30
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
