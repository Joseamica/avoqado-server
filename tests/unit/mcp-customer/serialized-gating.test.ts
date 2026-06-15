/**
 * Serialized-inventory MCP gating (2026-06-15): SERIALIZED_INVENTORY is a MODULE
 * (VenueModule), gated platform-wide via moduleService.isModuleEnabled (incl. its
 * org-level fallback) — NOT the Feature/tier resolver. Only module-on venues
 * (e.g. PlayTelecom) may read/write serialized inventory through the MCP.
 */
import { registerInventoryTools } from '../../../src/mcp/tools/inventory'
import type { McpScope } from '../../../src/mcp/scope'

const mockIsEnabled = jest.fn()
const mockGroupBy = jest.fn()
const mockReturned = jest.fn()
const mockDamaged = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/services/modules/module.service', () => ({
  moduleService: { isModuleEnabled: (...a: unknown[]) => mockIsEnabled(...(a as [])) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  serializedInventoryService: {
    markAsReturned: (...a: unknown[]) => mockReturned(...(a as [])),
    markAsDamaged: (...a: unknown[]) => mockDamaged(...(a as [])),
  },
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/productInventory.service', () => ({ adjustInventoryStock: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: jest.fn(async (ids: string[]) => ids) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => (v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }),
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    serializedItem: { groupBy: (...a: unknown[]) => mockGroupBy(...(a as [])) },
    product: { findMany: jest.fn() },
    inventory: { findMany: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerInventoryTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('serialized_inventory (read) — module-gated', () => {
  it('module OFF → moduleRequired, queries NOTHING (checks isModuleEnabled, not the tier resolver)', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call('serialized_inventory', { venueId: 'v1' }))
    expect(out.moduleRequired).toBe(true)
    expect(mockIsEnabled).toHaveBeenCalledWith('v1', 'SERIALIZED_INVENTORY')
    expect(mockGroupBy).not.toHaveBeenCalled()
  })

  it('module ON → returns the status counts', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGroupBy.mockResolvedValueOnce([
      { status: 'AVAILABLE', _count: { _all: 5 } },
      { status: 'SOLD', _count: { _all: 2 } },
    ])
    const out = parse(await call('serialized_inventory', { venueId: 'v1' }))
    expect(out).toMatchObject({ available: 5, sold: 2, total: 7 })
  })
})

describe('mark_serialized_item (write) — module-gated', () => {
  const base = { venueId: 'v1', serialNumber: 'ICC123', action: 'returned' }

  it('module OFF → moduleRequired, NO service call (no state change)', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call('mark_serialized_item', base))
    expect(out.moduleRequired).toBe(true)
    expect(mockReturned).not.toHaveBeenCalled()
    expect(mockDamaged).not.toHaveBeenCalled()
  })

  it('module ON → marks returned + audits as customer-mcp', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockReturned.mockResolvedValueOnce({ id: 'si1', serialNumber: 'ICC123', status: 'RETURNED', custodyState: 'IN_STOCK' })
    const out = parse(await call('mark_serialized_item', base))
    expect(mockReturned).toHaveBeenCalledWith('v1', 'ICC123')
    expect(out).toMatchObject({ ok: true, item: { status: 'RETURNED' } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'SERIALIZED_ITEM_MARKED', entityId: 'si1' })
  })
})
