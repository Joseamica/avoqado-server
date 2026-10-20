/**
 * collect_sims_from_supervisor (customer MCP) — bulk collect SIMs from their
 * supervisors back to the admin warehouse (Asana 1219467533602693).
 *
 * Same guarantees as the dashboard endpoint: SERIALIZED_INVENTORY module gate
 * (isModuleEnabled, never the tier resolver), the exact permission, two-step
 * confirm, MCP audit, and Isaac's "opción A" (only SUPERVISOR_HELD moves — the
 * service enforces it; the preview has to say so).
 */
import { registerSerializedTools } from '../../../src/mcp/tools/serialized'
import type { McpScope } from '../../../src/mcp/scope'

const mockIsEnabled = jest.fn()
const mockCollectBulk = jest.fn()
const mockAudit = jest.fn()
const mockRequirePermission = jest.fn()

jest.mock('@/services/modules/module.service', () => ({
  moduleService: { isModuleEnabled: (...a: unknown[]) => mockIsEnabled(...(a as [])) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))
jest.mock('@/services/serialized-inventory/custody.service', () => ({
  simCustodyService: { collectFromSupervisorBulk: (...a: unknown[]) => mockCollectBulk(...(a as [])) },
}))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({ serializedInventoryService: {} }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/productInventory.service', () => ({ adjustInventoryStock: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: jest.fn(async (ids: string[]) => ids) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v && v !== 'v1') throw new Error('Venue fuera de tu alcance')
      return { venueId: { in: ['v1'] } }
    },
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 'staff-1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { role: 'OWNER', organizationId: 'o1' }]]),
} as unknown as McpScope
const call = (args: Record<string, unknown>) => handlers.get('collect_sims_from_supervisor')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const RESULT = {
  summary: { total: 2, succeeded: 1, failed: 1 },
  results: [
    { serialNumber: 'SIM-1', status: 'ok', event: 'COLLECTED_FROM_SUPERVISOR' },
    { serialNumber: 'SIM-2', status: 'error', code: 'HAS_DOWNSTREAM_CUSTODY', message: 'Recolecta primero del Promotor.' },
  ],
}

beforeAll(() => {
  registerSerializedTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockIsEnabled.mockResolvedValue(true)
  mockCollectBulk.mockResolvedValue(RESULT)
})

describe('collect_sims_from_supervisor', () => {
  it('is registered', () => {
    expect(handlers.has('collect_sims_from_supervisor')).toBe(true)
  })

  it('module OFF → moduleRequired, collects NOTHING (isModuleEnabled, not the tier resolver)', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call({ venueId: 'v1', serialNumbers: ['SIM-1'], confirm: true }))
    expect(out.moduleRequired).toBe(true)
    expect(mockIsEnabled).toHaveBeenCalledWith('v1', 'SERIALIZED_INVENTORY')
    expect(mockCollectBulk).not.toHaveBeenCalled()
  })

  it('requires the exact single-SIM collect permission', async () => {
    await call({ venueId: 'v1', serialNumbers: ['SIM-1'] })
    expect(mockRequirePermission).toHaveBeenCalledWith('sim-custody:collect-from-supervisor', 'v1')
  })

  it('without confirm → preview that states the promoter rule, NO write', async () => {
    const out = parse(await call({ venueId: 'v1', serialNumbers: ['SIM-1', 'SIM-2'] }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.change).toMatchObject({ serialCount: 2 })
    expect(out.message).toMatch(/promotor/i)
    expect(mockCollectBulk).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('confirm → collects with the actor and reason, audits, and returns per-SIM results', async () => {
    const out = parse(await call({ venueId: 'v1', serialNumbers: ['SIM-1', 'SIM-2'], reason: 'STAFF_TERMINATED', confirm: true }))

    expect(mockCollectBulk).toHaveBeenCalledWith({
      actor: { staffId: 'staff-1', organizationId: 'o1', role: 'OWNER' },
      serialNumbers: ['SIM-1', 'SIM-2'],
      reason: 'STAFF_TERMINATED',
    })
    expect(mockAudit).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ action: 'SIM_CUSTODY_COLLECTED_FROM_SUPERVISOR_BULK', venueId: 'v1' }),
    )
    expect(out).toMatchObject({ ok: false, summary: RESULT.summary })
    expect(out.results).toHaveLength(2)
  })

  it('defaults the reason to "Recolección de Supervisor"', async () => {
    await call({ venueId: 'v1', serialNumbers: ['SIM-1'], confirm: true })
    expect(mockCollectBulk).toHaveBeenCalledWith(expect.objectContaining({ reason: 'SUPERVISOR_COLLECTION' }))
  })

  it('out-of-scope venue → throws before any service call', async () => {
    await expect(call({ venueId: 'v-other', serialNumbers: ['SIM-1'], confirm: true })).rejects.toThrow()
    expect(mockCollectBulk).not.toHaveBeenCalled()
  })
})
