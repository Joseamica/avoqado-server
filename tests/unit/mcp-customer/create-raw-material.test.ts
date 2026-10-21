import { registerInventoryTools } from '../../../src/mcp/tools/inventory'
import type { McpScope } from '../../../src/mcp/scope'

const mockCreate = jest.fn()
const mockAudit = jest.fn()
const mockFind = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing inventory:create')
    },
  }),
}))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({ serializedInventoryService: {} }))
jest.mock('@/services/dashboard/productInventory.service', () => ({ adjustInventoryStock: jest.fn() }))
jest.mock('@/services/dashboard/rawMaterial.service', () => ({ createRawMaterial: (...a: unknown[]) => mockCreate(...(a as [])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    rawMaterial: { findFirst: (...a: unknown[]) => mockFind(...a) },
    inventory: { findMany: jest.fn() },
    product: { findMany: jest.fn() },
    serializedItem: { groupBy: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('create_raw_material')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const ok = {
  venueId: 'v1',
  name: 'Harina',
  category: 'grains',
  unit: 'kilogram',
  currentStock: 50,
  minimumStock: 10,
  reorderPoint: 15,
  costPerUnit: 20,
}

beforeAll(() => {
  registerInventoryTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockFind.mockResolvedValue(null)
})
afterEach(() => jest.restoreAllMocks())

describe('create_raw_material (write)', () => {
  it('rejects out-of-scope venue', async () => {
    await expect(call({ ...ok, venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockCreate).not.toHaveBeenCalled()
  })
  it('rejects without inventory:create', async () => {
    await expect(call({ ...ok, venueId: 'no-perm' })).rejects.toThrow('Forbidden')
    expect(mockCreate).not.toHaveBeenCalled()
  })
  it('rejects an invalid category (no create)', async () => {
    const out = parse(await call({ ...ok, category: 'NOPE' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/inválida/)
    expect(mockCreate).not.toHaveBeenCalled()
  })
  it('rejects an invalid unit', async () => {
    const out = parse(await call({ ...ok, unit: 'BARRELS' }))
    expect(out.ok).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
  })
  it('rejects when minimumStock > reorderPoint', async () => {
    const out = parse(await call({ ...ok, minimumStock: 30, reorderPoint: 15 }))
    expect(out.ok).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
  })
  it('creates with uppercased enums + auto SKU + audit', async () => {
    mockCreate.mockResolvedValueOnce({ id: 'rm1', name: 'Harina', sku: 'HARINA-XX' })
    const out = parse(await call(ok))
    const dto = mockCreate.mock.calls[0][1] as Record<string, unknown>
    expect(dto).toMatchObject({ name: 'Harina', category: 'GRAINS', unit: 'KILOGRAM', currentStock: 50, costPerUnit: 20 })
    expect(typeof dto.sku).toBe('string')
    expect(out.ok).toBe(true)
    expect(mockCreate.mock.calls[0][2]).toEqual({ staffId: 's1', source: 'customer-mcp' })
    expect(mockAudit).not.toHaveBeenCalled()
  })
  it('un reintento conserva el SKU generado aunque transcurra tiempo', async () => {
    mockCreate.mockResolvedValue({ id: 'rm1', name: 'Harina', sku: 'HARINA-XX' })
    const now = jest.spyOn(Date, 'now').mockReturnValue(101000)
    await call(ok)
    now.mockReturnValue(201000)
    await call(ok)
    expect(mockCreate.mock.calls[0][1].sku).toBe(mockCreate.mock.calls[1][1].sku)
  })
  it('identifica un insumo existente con el mismo nombre antes de crear otro', async () => {
    mockFind.mockResolvedValue({
      id: 'existing',
      name: 'Harina',
      sku: 'LEGACY',
      unit: 'KILOGRAM',
      currentStock: 82,
      active: true,
      deletedAt: null,
    })
    expect(parse(await call(ok))).toMatchObject({ ok: false, existingRawMaterial: { id: 'existing', sku: 'LEGACY', currentStock: 82 } })
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
