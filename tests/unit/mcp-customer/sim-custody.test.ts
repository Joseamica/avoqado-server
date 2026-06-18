/**
 * sim_custody MCP tool (2026-06-18): the chain of custody of one serialized item
 * (SIM / ICCID). Given a serial it returns the current custody state + holder and the
 * full handoff timeline (who → who, when, why), with staff names resolved.
 *
 * SERIALIZED_INVENTORY is a MODULE — gated via moduleService.isModuleEnabled (NOT the
 * Feature/tier resolver), like every other serialized tool. The serial lookup is
 * case-insensitive (legacy lowercase rows exist — the serial bug class).
 *
 * The live test (dev DB) covered the module gate + case-insensitive lookup but had 0
 * custody events; these mocks cover the timeline mapping + staff-name resolution.
 */
import { registerInventoryTools } from '../../../src/mcp/tools/inventory'
import type { McpScope } from '../../../src/mcp/scope'

const mockIsEnabled = jest.fn()
const mockVenueFind = jest.fn()
const mockItemFind = jest.fn()
const mockEventsFind = jest.fn()
const mockStaffFind = jest.fn()

jest.mock('@/services/modules/module.service', () => ({
  moduleService: { isModuleEnabled: (...a: unknown[]) => mockIsEnabled(...(a as [])) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: jest.fn(async (ids: string[]) => ids) }))
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
    venue: { findUnique: (...a: unknown[]) => mockVenueFind(...(a as [])) },
    serializedItem: { findFirst: (...a: unknown[]) => mockItemFind(...(a as [])) },
    serializedItemCustodyEvent: { findMany: (...a: unknown[]) => mockEventsFind(...(a as [])) },
    staff: { findMany: (...a: unknown[]) => mockStaffFind(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('sim_custody')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerInventoryTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockIsEnabled.mockResolvedValue(true)
  mockVenueFind.mockResolvedValue({ organizationId: 'org-1' })
  mockItemFind.mockResolvedValue({
    id: 'item-1',
    serialNumber: 'sim-abc',
    status: 'AVAILABLE',
    custodyState: 'PROMOTER_HELD',
    assignedSupervisor: { firstName: 'Sup', lastName: 'Uno' },
    assignedPromoter: { firstName: 'Promo', lastName: 'Dos' },
  })
  mockEventsFind.mockResolvedValue([
    { createdAt: new Date('2026-06-10T10:00:00Z'), eventType: 'ASSIGN_TO_SUPERVISOR', fromState: 'ADMIN_HELD', toState: 'SUPERVISOR_HELD', fromStaffId: null, toStaffId: 'st-sup', actorStaffId: 'st-admin', reason: null },
    { createdAt: new Date('2026-06-11T10:00:00Z'), eventType: 'ASSIGN_TO_PROMOTER', fromState: 'SUPERVISOR_HELD', toState: 'PROMOTER_HELD', fromStaffId: 'st-sup', toStaffId: 'st-promo', actorStaffId: 'st-sup', reason: null },
  ])
  mockStaffFind.mockResolvedValue([
    { id: 'st-admin', firstName: 'Admin', lastName: 'A' },
    { id: 'st-sup', firstName: 'Sup', lastName: 'Uno' },
    { id: 'st-promo', firstName: 'Promo', lastName: 'Dos' },
  ])
})

describe('sim_custody — module gate', () => {
  it('module OFF → moduleRequired, queries NOTHING (uses isModuleEnabled, not the tier resolver)', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call({ venueId: 'v1', serialNumber: 'sim-abc' }))
    expect(out.moduleRequired).toBe(true)
    expect(mockItemFind).not.toHaveBeenCalled()
  })
})

describe('sim_custody — current state + timeline', () => {
  it('returns current state with a Spanish label and the resolved holders', async () => {
    const out = parse(await call({ venueId: 'v1', serialNumber: 'sim-abc' }))
    expect(out.item.custodyState).toBe('PROMOTER_HELD')
    expect(out.item.custodyStateLabel).toBe('En poder del promotor (vendible)')
    expect(out.item.heldBySupervisor).toBe('Sup Uno')
    expect(out.item.heldByPromoter).toBe('Promo Dos')
  })

  it('maps the chronological timeline with staff names resolved (from → to, actor)', async () => {
    const out = parse(await call({ venueId: 'v1', serialNumber: 'sim-abc' }))
    expect(out.eventCount).toBe(2)
    expect(out.timeline[0]).toMatchObject({ toState: 'SUPERVISOR_HELD', fromStaff: null, toStaff: 'Sup Uno', actor: 'Admin A' })
    expect(out.timeline[1]).toMatchObject({ fromState: 'SUPERVISOR_HELD', toState: 'PROMOTER_HELD', fromStaff: 'Sup Uno', toStaff: 'Promo Dos' })
  })

  it('does a CASE-INSENSITIVE serial lookup, scoped to the venue OR its org', async () => {
    await call({ venueId: 'v1', serialNumber: 'SIM-ABC' })
    const where = mockItemFind.mock.calls[0][0].where
    expect(where.serialNumber).toEqual({ equals: 'SIM-ABC', mode: 'insensitive' })
    expect(where.OR).toEqual(expect.arrayContaining([{ venueId: 'v1' }, { organizationId: 'org-1' }]))
  })
})

describe('sim_custody — not found + scope', () => {
  it('unknown serial → clean error', async () => {
    mockItemFind.mockResolvedValue(null)
    const out = parse(await call({ venueId: 'v1', serialNumber: 'nope' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/No encontré/)
    expect(mockEventsFind).not.toHaveBeenCalled()
  })

  it('throws on an out-of-scope venue before any query', async () => {
    await expect(call({ venueId: 'other', serialNumber: 'sim-abc' })).rejects.toThrow()
    expect(mockIsEnabled).not.toHaveBeenCalled()
  })
})
