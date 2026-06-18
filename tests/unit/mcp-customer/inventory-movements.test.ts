/**
 * get_inventory_movements MCP tool (2026-06-17): the kardex / bitácora read tool.
 * A PlayTelecom operator asked the MCP "did someone manually lower inventory to
 * hide purchases?" and the MCP had no movement-history reader — only adjust_stock
 * (write). This tool closes that gap over InventoryMovement (products) +
 * RawMaterialMovement (raw materials). PREMIUM (INVENTORY_TRACKING), same gate as
 * its siblings (low_stock / stock_value / adjust_stock).
 *
 * Tests: tier gate fires, both sources merge newest-first with the staff name
 * resolved, and the `type` union routes per-source (SALE = products only, USAGE =
 * raw materials only) so a type that only exists in one enum never leaks the other.
 */
import { registerInventoryTools } from '../../../src/mcp/tools/inventory'
import type { McpScope } from '../../../src/mcp/scope'

const mockPlanGate = jest.fn()
const mockInvFindMany = jest.fn()
const mockRawFindMany = jest.fn()
const mockStaffFindMany = jest.fn()
const mockVenueFindUnique = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: jest.fn(async (ids: string[]) => ids) }))
jest.mock('@/services/modules/module.service', () => ({
  moduleService: { isModuleEnabled: jest.fn() },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({ serializedInventoryService: {} }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/services/dashboard/productInventory.service', () => ({ adjustInventoryStock: jest.fn() }))
jest.mock('@/services/dashboard/rawMaterial.service', () => ({ createRawMaterial: jest.fn() }))
jest.mock('@/services/dashboard/autoReorder.service', () => ({
  getReorderSuggestions: jest.fn(),
  getAutoReorderConfig: jest.fn(),
  setAutoReorderConfig: jest.fn(),
}))
jest.mock('@/mcp/guard', () => ({
  ScopeError: class ScopeError extends Error {},
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v && v !== 'v1') throw new Error('out of scope')
      return { venueId: { in: ['v1'] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    inventoryMovement: { findMany: (...a: unknown[]) => mockInvFindMany(...(a as [])) },
    rawMaterialMovement: { findMany: (...a: unknown[]) => mockRawFindMany(...(a as [])) },
    staff: { findMany: (...a: unknown[]) => mockStaffFindMany(...(a as [])) },
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const dec = (n: number) => ({ toString: () => String(n), valueOf: () => n }) as unknown // mimic Prisma.Decimal for Number()

beforeAll(() => {
  registerInventoryTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null) // entitled by default
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  mockInvFindMany.mockResolvedValue([])
  mockRawFindMany.mockResolvedValue([])
  mockStaffFindMany.mockResolvedValue([])
})

describe('get_inventory_movements — tier gate', () => {
  it('not entitled → planRequired, no DB read', async () => {
    mockPlanGate.mockResolvedValue('El control de inventario requiere el plan PREMIUM.')
    const out = parse(await call('get_inventory_movements', { venueId: 'v1' }))
    expect(out.planRequired).toBe(true)
    expect(mockInvFindMany).not.toHaveBeenCalled()
    expect(mockRawFindMany).not.toHaveBeenCalled()
  })
})

describe('get_inventory_movements — merge + who/when', () => {
  it('merges both sources newest-first and resolves the staff name', async () => {
    mockInvFindMany.mockResolvedValue([
      {
        type: 'ADJUSTMENT',
        quantity: dec(-8),
        previousStock: dec(20),
        newStock: dec(12),
        reason: 'corrección',
        reference: null,
        createdBy: 'staff-9',
        createdAt: new Date('2026-06-15T10:00:00Z'),
        inventory: { product: { name: 'SIM Telcel', sku: 'SIM-1' } },
      },
    ])
    mockRawFindMany.mockResolvedValue([
      {
        type: 'PURCHASE',
        quantity: dec(50),
        unit: 'PIECE',
        previousStock: dec(0),
        newStock: dec(50),
        reason: null,
        reference: 'PO-1',
        createdBy: null,
        createdAt: new Date('2026-06-16T10:00:00Z'),
        rawMaterial: { name: 'Cable', sku: 'CAB-1' },
      },
    ])
    mockStaffFindMany.mockResolvedValue([{ id: 'staff-9', firstName: 'María', lastName: 'López' }])

    const out = parse(await call('get_inventory_movements', { venueId: 'v1' }))
    expect(out.count).toBe(2)
    // newest first: the jun-16 raw PURCHASE precedes the jun-15 product ADJUSTMENT
    expect(out.movements[0].kind).toBe('rawMaterial')
    expect(out.movements[1].kind).toBe('product')
    expect(out.movements[1].by).toBe('María López') // resolved
    expect(out.movements[0].by).toBeNull() // null createdBy stays null
    expect(out.movements[1].quantity).toBe(-8) // negative = stock down
    // anti-fraud summary
    expect(out.adjustmentCount).toBe(1)
    expect(out.netAdjustmentQuantity).toBe(-8)
  })
})

describe('get_inventory_movements — type union routes per source', () => {
  it('type=SALE queries products with the type filter and SKIPS raw materials', async () => {
    await call('get_inventory_movements', { venueId: 'v1', type: 'SALE' })
    expect(mockInvFindMany).toHaveBeenCalledTimes(1)
    expect(mockInvFindMany.mock.calls[0][0].where.type).toBe('SALE')
    expect(mockRawFindMany).not.toHaveBeenCalled() // SALE is not a RawMaterialMovementType
  })

  it('type=USAGE queries raw materials and SKIPS products', async () => {
    await call('get_inventory_movements', { venueId: 'v1', type: 'USAGE' })
    expect(mockRawFindMany).toHaveBeenCalledTimes(1)
    expect(mockRawFindMany.mock.calls[0][0].where.type).toBe('USAGE')
    expect(mockInvFindMany).not.toHaveBeenCalled() // USAGE is not a MovementType
  })

  it('type=ADJUSTMENT (in both enums) queries BOTH sources', async () => {
    await call('get_inventory_movements', { venueId: 'v1', type: 'ADJUSTMENT' })
    expect(mockInvFindMany).toHaveBeenCalledTimes(1)
    expect(mockRawFindMany).toHaveBeenCalledTimes(1)
    expect(mockInvFindMany.mock.calls[0][0].where.type).toBe('ADJUSTMENT')
    expect(mockRawFindMany.mock.calls[0][0].where.type).toBe('ADJUSTMENT')
  })

  it('no type → both sources, no type filter', async () => {
    await call('get_inventory_movements', { venueId: 'v1' })
    expect(mockInvFindMany.mock.calls[0][0].where.type).toBeUndefined()
    expect(mockRawFindMany.mock.calls[0][0].where.type).toBeUndefined()
  })
})

describe('get_inventory_movements — date window', () => {
  it('passes a venue-local createdAt range to both queries', async () => {
    await call('get_inventory_movements', { venueId: 'v1', fromDate: '2026-06-01', toDate: '2026-06-15' })
    const w = mockInvFindMany.mock.calls[0][0].where
    expect(w.createdAt.gte).toBeInstanceOf(Date)
    expect(w.createdAt.lte).toBeInstanceOf(Date)
    // Mexico (UTC-6): jun-01 00:00 local = jun-01 06:00Z
    expect(w.createdAt.gte.toISOString()).toBe('2026-06-01T06:00:00.000Z')
  })
})
