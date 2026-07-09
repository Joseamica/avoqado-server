import { registerSerializedTools } from '../../../src/mcp/tools/serialized'
import type { McpScope } from '../../../src/mcp/scope'

const mockIsEnabled = jest.fn()
const mockGetOrgStock = jest.fn()
const mockListOrgItems = jest.fn()

jest.mock('@/services/modules/module.service', () => ({
  moduleService: { isModuleEnabled: (...a: unknown[]) => mockIsEnabled(...(a as [])) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  serializedInventoryService: {
    getOrgStockByCategory: (...a: unknown[]) => mockGetOrgStock(...(a as [])),
    listOrgItems: (...a: unknown[]) => mockListOrgItems(...(a as [])),
  },
}))
jest.mock('@/services/serialized-inventory/custody.service', () => ({ simCustodyService: {} }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { itemCategory: { findMany: jest.fn() } } }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: () => ({ venueId: { in: ['v1'] } }), requirePermission: jest.fn() }),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { organizationId: 'o1' }]]),
} as unknown as McpScope
const call = (n: string, a: Record<string, unknown>) => handlers.get(n)!(a, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => registerSerializedTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope))
beforeEach(() => jest.clearAllMocks())

describe('serialized_stock_by_category', () => {
  it('module OFF → moduleRequired, no service call', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call('serialized_stock_by_category', { venueId: 'v1' }))
    expect(out.moduleRequired).toBe(true)
    expect(mockGetOrgStock).not.toHaveBeenCalled()
  })
  it('module ON → totals per category', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetOrgStock.mockResolvedValue([{ category: { name: 'SIM de Evento' }, available: 4, sold: 1 }])
    const out = parse(await call('serialized_stock_by_category', { venueId: 'v1' }))
    expect(out).toMatchObject({ orgId: 'o1', totalAvailable: 4, totalSold: 1 })
    expect(mockGetOrgStock).toHaveBeenCalledWith('o1', ['v1'])
  })
})

describe('list_serialized_items', () => {
  it('module ON → passes org pool + filters', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockListOrgItems.mockResolvedValue({ items: [{ serialNumber: 'ICC1', status: 'AVAILABLE', custodyState: 'ADMIN_HELD', category: { name: 'SIM de Evento' }, venueId: null }], total: 1 })
    const out = parse(await call('list_serialized_items', { venueId: 'v1', status: 'AVAILABLE' }))
    expect(out.total).toBe(1)
    expect(mockListOrgItems).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'o1', allowedVenueIds: ['v1'], status: 'AVAILABLE' }))
  })
})
