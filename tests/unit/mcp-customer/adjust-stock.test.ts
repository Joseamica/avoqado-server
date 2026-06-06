import { registerInventoryTools } from '../../../src/mcp/tools/inventory'
import type { McpScope } from '../../../src/mcp/scope'

// Verify adjust_stock wiring (name match, MovementType mapping, service args, audit) without DB.
const mockAdjust = jest.fn(async () => ({ currentStock: 40, minimumStock: 10, reservedStock: 0 }))
const mockProductFindMany = jest.fn()
const mockLogAction = jest.fn()

jest.mock('@/services/dashboard/productInventory.service', () => ({ adjustInventoryStock: (...a: unknown[]) => mockAdjust(...(a as [])) }))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  serializedInventoryService: { markAsReturned: jest.fn(), markAsDamaged: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: { findMany: (...a: unknown[]) => mockProductFindMany(...(a as [])) },
    inventory: { findMany: jest.fn() },
    serializedItem: { groupBy: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('adjust_stock')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const dataArg = () => mockAdjust.mock.calls[0] as unknown as [string, string, Record<string, unknown>, string]

beforeAll(() => {
  registerInventoryTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('adjust_stock', () => {
  it('adjusts a single match by delta (default ADJUSTMENT), audits, returns new stock', async () => {
    mockProductFindMany.mockResolvedValueOnce([{ id: 'p1', name: 'Coca Cola' }])
    const out = parse(await call({ venueId: 'v1', name: 'coca', delta: -5, reason: 'merma' }))

    expect(mockAdjust).toHaveBeenCalledTimes(1)
    const [venueId, productId, data, staffId] = dataArg()
    expect(venueId).toBe('v1')
    expect(productId).toBe('p1')
    expect(staffId).toBe('staff-1')
    expect(data.quantity).toBe(-5)
    expect(data.type).toBe('ADJUSTMENT')
    expect(out.ok).toBe(true)
    expect(out.newStock).toBe(40)
    expect(mockLogAction.mock.calls[0][0]).toMatchObject({
      action: 'INVENTORY_STOCK_ADJUSTED',
      entity: 'Product',
      entityId: 'p1',
      data: { source: 'customer-mcp' },
    })
  })

  it("maps type 'loss' → LOSS and 'purchase' → PURCHASE", async () => {
    mockProductFindMany.mockResolvedValue([{ id: 'p1', name: 'X' }])
    await call({ venueId: 'v1', name: 'x', delta: -2, type: 'loss' })
    expect(dataArg()[2].type).toBe('LOSS')
    mockAdjust.mockClear()
    await call({ venueId: 'v1', name: 'x', delta: 10, type: 'purchase' })
    expect(dataArg()[2].type).toBe('PURCHASE')
  })

  it('no match → ok:false and no service call', async () => {
    mockProductFindMany.mockResolvedValueOnce([])
    const out = parse(await call({ venueId: 'v1', name: 'nope', delta: 1 }))
    expect(out.ok).toBe(false)
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('multiple matches → ambiguous, no service call', async () => {
    mockProductFindMany.mockResolvedValueOnce([
      { id: 'p1', name: 'Agua 1L' },
      { id: 'p2', name: 'Agua 600ml' },
    ])
    const out = parse(await call({ venueId: 'v1', name: 'agua', delta: 1 }))
    expect(out.ambiguous).toBe(true)
    expect(mockAdjust).not.toHaveBeenCalled()
  })
})
