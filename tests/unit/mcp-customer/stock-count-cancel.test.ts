import { registerInventoryTools } from '../../../src/mcp/tools/inventory'
import type { McpScope } from '../../../src/mcp/scope'

const mockCancel = jest.fn(async () => ({ id: 'c1', status: 'CANCELLED', cancelledAt: '2026-09-08T01:00:00.000Z' }))
const mockLogAction = jest.fn()
const mockStockCountFindFirst = jest.fn()
const mockPlanGate = jest.fn(async () => null)
const mockRequirePermission = jest.fn()

jest.mock('@/services/mobile/inventory.mobile.service', () => ({ cancelStockCount: (...a: unknown[]) => mockCancel(...(a as [])) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...(a as [])) }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: mockRequirePermission }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    stockCount: { findFirst: (...a: unknown[]) => mockStockCountFindFirst(...(a as [])), findMany: jest.fn() },
    product: { findMany: jest.fn() },
    inventory: { findMany: jest.fn() },
    rawMaterial: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('cancel_stock_count')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerInventoryTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('cancel_stock_count', () => {
  it('está registrada', () => {
    expect(handlers.has('cancel_stock_count')).toBe(true)
  })

  it('sin confirm → vista previa con el conteo y NO cancela', async () => {
    mockStockCountFindFirst.mockResolvedValueOnce({
      id: 'c1',
      status: 'IN_PROGRESS',
      type: 'FULL',
      createdAt: new Date('2026-09-07T22:51:23.142Z'),
      _count: { items: 137 },
    })
    const out = parse(await call({ venueId: 'v1', countId: 'c1' }))
    // El filtro del alcance llega a la consulta: sin el spread, un conteo ajeno se leería igual.
    expect(mockStockCountFindFirst.mock.calls[0][0].where).toMatchObject({ venueId: { in: ['v1'] }, id: 'c1' })
    expect(out.requiresConfirmation).toBe(true)
    expect(out.change).toMatchObject({ label: 'Estado', from: 'IN_PROGRESS', to: 'CANCELLED' })
    expect(mockCancel).not.toHaveBeenCalled()
  })

  it('confirm:true → cancela con el staff conectado y audita', async () => {
    mockStockCountFindFirst.mockResolvedValueOnce({
      id: 'c1',
      status: 'IN_PROGRESS',
      type: 'FULL',
      createdAt: new Date(),
      _count: { items: 137 },
    })
    const out = parse(await call({ venueId: 'v1', countId: 'c1', confirm: true }))
    // Los dos candados de esta escritura, comprobados y no supuestos: permiso de ESCRITURA...
    expect(mockRequirePermission).toHaveBeenCalledWith('inventory:update', 'v1')
    // ...y el alcance del venue dentro del where.
    expect(mockStockCountFindFirst.mock.calls[0][0].where).toMatchObject({ venueId: { in: ['v1'] }, id: 'c1' })
    expect(mockCancel).toHaveBeenCalledWith('c1', 'v1', 'staff-1')
    expect(out.ok).toBe(true)
    expect(mockLogAction.mock.calls[0][0]).toMatchObject({
      action: 'STOCK_COUNT_CANCELLED_MCP',
      entity: 'StockCount',
      entityId: 'c1',
      venueId: 'v1',
      staffId: 'staff-1',
      data: { source: 'customer-mcp' },
    })
  })

  it('un conteo fuera del alcance no se toca', async () => {
    mockStockCountFindFirst.mockResolvedValueOnce(null)
    const out = parse(await call({ venueId: 'v1', countId: 'ajeno', confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockCancel).not.toHaveBeenCalled()
  })

  it('un conteo que no está en progreso lo dice sin llamar al servicio', async () => {
    mockStockCountFindFirst.mockResolvedValueOnce({
      id: 'c1',
      status: 'COMPLETED',
      type: 'FULL',
      createdAt: new Date(),
      _count: { items: 3 },
    })
    const out = parse(await call({ venueId: 'v1', countId: 'c1', confirm: true }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/completado/i)
    expect(mockCancel).not.toHaveBeenCalled()
  })
})
