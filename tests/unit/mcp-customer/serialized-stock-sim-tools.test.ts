/**
 * serialized_low_stock / serialized_stock_movements / serialized_stock_trend /
 * serialized_stock_metrics — module-gated (SERIALIZED_INVENTORY) stock-dashboard reads.
 * sim_pending_approvals — org-level gate (sim-custody:approve-registration in the active org).
 */
import { registerSerializedTools } from '../../../src/mcp/tools/serialized'
import type { McpScope } from '../../../src/mcp/scope'

const mockIsEnabled = jest.fn()
const mockGetLowStockAlerts = jest.fn()
const mockGetRecentMovements = jest.fn()
const mockGetStockVsSales = jest.fn()
const mockGetStockMetrics = jest.fn()
const mockListPending = jest.fn()
const mockCountPending = jest.fn()
const mockListPendingStockApprovals = jest.fn()
const mockCountPendingStockApprovals = jest.fn()

// Plain (non jest.fn) toggle for hasPermission — must be prefixed "mock" so
// babel-plugin-jest-hoist allows the jest.mock() factory below to close over it.
let mockAllow = true

jest.mock('@/services/modules/module.service', () => ({
  moduleService: { isModuleEnabled: (...a: unknown[]) => mockIsEnabled(...(a as [])) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

jest.mock('@/services/stock-dashboard/stockDashboard.service', () => ({
  stockDashboardService: {
    getLowStockAlerts: (...a: unknown[]) => mockGetLowStockAlerts(...(a as [])),
    getRecentMovements: (...a: unknown[]) => mockGetRecentMovements(...(a as [])),
    getStockVsSales: (...a: unknown[]) => mockGetStockVsSales(...(a as [])),
    getStockMetrics: (...a: unknown[]) => mockGetStockMetrics(...(a as [])),
  },
}))

jest.mock('@/services/serialized-inventory/simRegistration.service', () => ({
  simRegistrationService: {
    listPending: (...a: unknown[]) => mockListPending(...(a as [])),
    countPending: (...a: unknown[]) => mockCountPending(...(a as [])),
    listPendingStockApprovals: (...a: unknown[]) => mockListPendingStockApprovals(...(a as [])),
    countPendingStockApprovals: (...a: unknown[]) => mockCountPendingStockApprovals(...(a as [])),
  },
}))

jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  serializedInventoryService: {
    getOrgStockByCategory: jest.fn(),
    listOrgItems: jest.fn(),
    markAsReturned: jest.fn(),
    markAsDamaged: jest.fn(),
  },
}))

jest.mock('@/services/serialized-inventory/custody.service', () => ({ simCustodyService: {} }))

jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    serializedItem: { groupBy: jest.fn(), findFirst: jest.fn() },
    serializedItemCustodyEvent: { findMany: jest.fn() },
    itemCategory: { findMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    staff: { findMany: jest.fn() },
  },
}))

// `hasPermission` drives requireOrgApprovalAccess() inside sim_pending_approvals — controllable
// per-test via mockAllow so we can exercise both the granted and denied paths.
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (...args: unknown[]) => mockAllow,
}))

// sim_pending_approvals throws the REAL ScopeError (imported from '../guard' inside serialized.ts).
// Since '@/mcp/guard' and '../guard' resolve to the same file, mocking '@/mcp/guard' here also
// mocks what serialized.ts imports — so the mock must re-export a ScopeError class too.
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: jest.fn(), requirePermission: jest.fn() }),
  ScopeError: class extends Error {},
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { organizationId: 'o1' }]]),
} as unknown as McpScope

const call = (n: string, a: Record<string, unknown>) => handlers.get(n)!(a, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() =>
  registerSerializedTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => {
  jest.clearAllMocks()
  mockAllow = true
})

describe('serialized_low_stock', () => {
  it('module OFF → moduleRequired, no service call', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call('serialized_low_stock', { venueId: 'v1' }))
    expect(out.moduleRequired).toBe(true)
    expect(mockGetLowStockAlerts).not.toHaveBeenCalled()
  })

  it('module ON → returns alerts mapped from the service', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetLowStockAlerts.mockResolvedValue([{ categoryName: 'SIM de Evento', currentStock: 2, minimumStock: 5, alertLevel: 'LOW' }])
    const out = parse(await call('serialized_low_stock', { venueId: 'v1' }))
    expect(mockGetLowStockAlerts).toHaveBeenCalledWith('v1')
    expect(out).toMatchObject({
      venueId: 'v1',
      count: 1,
      alerts: [{ category: 'SIM de Evento', currentStock: 2, minimumStock: 5, alertLevel: 'LOW' }],
    })
  })
})

describe('serialized_stock_movements', () => {
  it('module OFF → moduleRequired, no service call', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call('serialized_stock_movements', { venueId: 'v1' }))
    expect(out.moduleRequired).toBe(true)
    expect(mockGetRecentMovements).not.toHaveBeenCalled()
  })

  it('module ON, no options → default limit 20, no date/staff filters', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetRecentMovements.mockResolvedValue([])
    await call('serialized_stock_movements', { venueId: 'v1' })
    expect(mockGetRecentMovements).toHaveBeenCalledWith('v1', 20, {})
  })

  it('module ON + limit/fromDate/toDate/responsibleStaffId → dates converted to Date in opts', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetRecentMovements.mockResolvedValue([
      {
        serialNumber: 'ICC1',
        categoryName: 'SIM de Evento',
        type: 'SALE',
        timestamp: '2026-07-01T10:00:00.000Z',
        venueName: 'BAE Centro',
        userName: 'Ana',
        soldByName: 'Ana',
        soldAtVenueName: 'BAE Centro',
        itemCount: 1,
        responsible: 'Ana',
      },
    ])
    const out = parse(
      await call('serialized_stock_movements', {
        venueId: 'v1',
        limit: 5,
        fromDate: '2026-07-01',
        toDate: '2026-07-08',
        responsibleStaffId: 'staff-9',
      }),
    )
    expect(mockGetRecentMovements).toHaveBeenCalledWith('v1', 5, {
      dateFrom: new Date('2026-07-01'),
      dateTo: new Date('2026-07-08'),
      responsibleStaffId: 'staff-9',
    })
    expect(out.count).toBe(1)
    expect(out.movements[0]).toMatchObject({ serialNumber: 'ICC1', type: 'SALE', registeredBy: 'Ana' })
  })
})

describe('serialized_stock_trend', () => {
  it('module OFF → moduleRequired, no service call', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call('serialized_stock_trend', { venueId: 'v1' }))
    expect(out.moduleRequired).toBe(true)
    expect(mockGetStockVsSales).not.toHaveBeenCalled()
  })

  it('module ON, no days → defaults to 14', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetStockVsSales.mockResolvedValue([{ date: '2026-07-01', stock: 10, sales: 2 }])
    const out = parse(await call('serialized_stock_trend', { venueId: 'v1' }))
    expect(mockGetStockVsSales).toHaveBeenCalledWith('v1', 14)
    expect(out).toMatchObject({ venueId: 'v1', days: 14 })
    expect(out.trend).toHaveLength(1)
  })

  it('module ON + days → passed through to the service and echoed back', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetStockVsSales.mockResolvedValue([])
    const out = parse(await call('serialized_stock_trend', { venueId: 'v1', days: 30 }))
    expect(mockGetStockVsSales).toHaveBeenCalledWith('v1', 30)
    expect(out.days).toBe(30)
  })
})

describe('serialized_stock_metrics', () => {
  it('module OFF → moduleRequired, no service call', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call('serialized_stock_metrics', { venueId: 'v1' }))
    expect(out.moduleRequired).toBe(true)
    expect(mockGetStockMetrics).not.toHaveBeenCalled()
  })

  it('module ON → returns metrics merged with venueId', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetStockMetrics.mockResolvedValue({ totalPieces: 100, totalValue: 5000, available: 40, soldToday: 3, soldThisWeek: 12 })
    const out = parse(await call('serialized_stock_metrics', { venueId: 'v1' }))
    expect(mockGetStockMetrics).toHaveBeenCalledWith('v1')
    expect(out).toMatchObject({ venueId: 'v1', totalPieces: 100, soldToday: 3, soldThisWeek: 12 })
  })
})

describe('sim_pending_approvals', () => {
  it('without sim-custody:approve-registration in the active org → throws ScopeError, no service calls', async () => {
    mockAllow = false
    await expect(call('sim_pending_approvals', { queue: 'registration' })).rejects.toThrow(
      'Missing permission sim-custody:approve-registration in this organization',
    )
    expect(mockListPending).not.toHaveBeenCalled()
    expect(mockCountPending).not.toHaveBeenCalled()
    expect(mockListPendingStockApprovals).not.toHaveBeenCalled()
    expect(mockCountPendingStockApprovals).not.toHaveBeenCalled()
  })

  it('queue="registration", permitted → lists + counts pending registration requests', async () => {
    mockListPending.mockResolvedValue([{ id: 'r1' }])
    mockCountPending.mockResolvedValue(1)
    const out = parse(await call('sim_pending_approvals', { queue: 'registration' }))
    expect(mockListPending).toHaveBeenCalledWith('o1')
    expect(mockCountPending).toHaveBeenCalledWith('o1')
    expect(mockListPendingStockApprovals).not.toHaveBeenCalled()
    expect(out).toMatchObject({ queue: 'registration', orgId: 'o1', count: 1 })
    expect(out.requests).toEqual([{ id: 'r1' }])
  })

  it('queue="stock", permitted → lists + counts pending stock approvals, forwards paging params', async () => {
    mockListPendingStockApprovals.mockResolvedValue({ items: [{ serialNumber: 'ICC9' }], nextCursor: 'c2' })
    mockCountPendingStockApprovals.mockResolvedValue(9)
    const out = parse(await call('sim_pending_approvals', { queue: 'stock', limit: 10, cursor: 'c1', search: 'ICC' }))
    expect(mockListPendingStockApprovals).toHaveBeenCalledWith('o1', { cursor: 'c1', limit: 10, search: 'ICC' })
    expect(mockCountPendingStockApprovals).toHaveBeenCalledWith('o1')
    expect(mockListPending).not.toHaveBeenCalled()
    expect(out).toMatchObject({ queue: 'stock', orgId: 'o1', count: 9, nextCursor: 'c2' })
    expect(out.items).toEqual([{ serialNumber: 'ICC9' }])
  })
})
