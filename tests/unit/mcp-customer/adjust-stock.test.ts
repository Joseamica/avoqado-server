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
const mockPlanGate = jest.fn()
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: jest.fn(async (ids: string[]) => ids) }))
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
const perVenueAccess = new Map<string, unknown>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess } as unknown as McpScope
const acceso = (o: Record<string, unknown> = {}) => ({
  role: 'MANAGER',
  whiteLabelEnabled: false,
  enabledFeatures: [],
  featureAccess: {},
  ...o,
})
const call = (args: Record<string, unknown>) => handlers.get('adjust_stock')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const dataArg = () => mockAdjust.mock.calls[0] as unknown as [string, string, Record<string, unknown>, string]

beforeAll(() => {
  registerInventoryTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockProductFindMany.mockReset().mockResolvedValue([])
  mockPlanGate.mockResolvedValue(null) // Premium salvo que la prueba diga otra cosa
  perVenueAccess.set('v1', acceso())
})

describe('adjust_stock', () => {
  it('without confirm → preview (current → new), NO service call', async () => {
    mockProductFindMany.mockResolvedValueOnce([{ id: 'p1', name: 'Coca Cola', inventory: { currentStock: 45 } }])
    const out = parse(await call({ venueId: 'v1', name: 'coca', delta: -5 }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.change).toMatchObject({ product: 'Coca Cola', from: 45, delta: -5, to: 40 })
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('adjusts a single match by delta (default ADJUSTMENT) WITH confirm, audits, returns new stock', async () => {
    mockProductFindMany.mockResolvedValueOnce([{ id: 'p1', name: 'Coca Cola', inventory: { currentStock: 45 } }])
    const out = parse(await call({ venueId: 'v1', name: 'coca', delta: -5, reason: 'merma', confirm: true }))

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

  it("maps type 'loss' → LOSS and 'purchase' → PURCHASE (with confirm)", async () => {
    mockProductFindMany.mockResolvedValue([{ id: 'p1', name: 'X', inventory: { currentStock: 20 } }])
    await call({ venueId: 'v1', name: 'x', delta: -2, type: 'loss', confirm: true })
    expect(dataArg()[2].type).toBe('LOSS')
    mockAdjust.mockClear()
    await call({ venueId: 'v1', name: 'x', delta: 10, type: 'purchase', confirm: true })
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

// D2b (hz:0fc8a35f:D2, 18-nov): sin Premium, el MCP deja el AJUSTE simple de piezas, como «Ajustar existencias» del panel.
describe('adjust_stock sin Premium (Gratis/Pro)', () => {
  const SIN_PLAN = 'El control de inventario no está incluido en el plan actual de este local (requiere INVENTORY_TRACKING).'
  beforeEach(() => mockPlanGate.mockResolvedValue(SIN_PLAN))
  const unProducto = () => mockProductFindMany.mockResolvedValue([{ id: 'p1', name: 'Coca Cola', inventory: { currentStock: 45 } }])

  it('el ajuste (tipo por default) da vista previa y se aplica con confirm', async () => {
    unProducto()
    const vista = parse(await call({ venueId: 'v1', name: 'coca', delta: 5 }))
    expect(vista.requiresConfirmation).toBe(true)
    expect(vista.change).toMatchObject({ from: 45, to: 50 })
    const out = parse(await call({ venueId: 'v1', name: 'coca', delta: 5, confirm: true }))
    expect(out.ok).toBe(true)
    expect(dataArg()[2].type).toBe('ADJUSTMENT')
  })

  it("type 'adjustment' explícito también pasa", async () => {
    unProducto()
    const out = parse(await call({ venueId: 'v1', name: 'coca', delta: -2, type: 'adjustment', confirm: true }))
    expect(out.ok).toBe(true)
  })

  it.each(['purchase', 'loss'])("type '%s' sigue pidiendo Premium, sin vista previa ni servicio", async tipo => {
    unProducto()
    for (const confirm of [undefined, true]) {
      const out = parse(await call({ venueId: 'v1', name: 'coca', delta: 3, type: tipo, confirm }))
      expect(out).toMatchObject({ ok: false, planRequired: true, error: SIN_PLAN })
    }
    expect(mockProductFindMany).not.toHaveBeenCalled()
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('marca blanca sin el módulo de inventario → no, ni vista previa', async () => {
    unProducto()
    perVenueAccess.set('v1', acceso({ whiteLabelEnabled: true, enabledFeatures: ['AVOQADO_DASHBOARD'] }))
    for (const confirm of [undefined, true]) {
      const out = parse(await call({ venueId: 'v1', name: 'coca', delta: 5, confirm }))
      expect(out.ok).toBe(false)
      expect(out.requiresConfirmation).toBeUndefined()
    }
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('marca blanca con el módulo pero sin acceso de su rol → no', async () => {
    unProducto()
    perVenueAccess.set(
      'v1',
      acceso({
        whiteLabelEnabled: true,
        enabledFeatures: ['AVOQADO_INVENTORY'],
        featureAccess: { AVOQADO_INVENTORY: { allowed: false, reason: 'ROLE_NOT_ALLOWED', dataScope: 'venue' } },
      }),
    )
    const out = parse(await call({ venueId: 'v1', name: 'coca', delta: 5, confirm: true }))
    expect(out.ok).toBe(false)
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('marca blanca con el módulo y su rol con acceso → pasa', async () => {
    unProducto()
    perVenueAccess.set(
      'v1',
      acceso({
        whiteLabelEnabled: true,
        enabledFeatures: ['AVOQADO_INVENTORY'],
        featureAccess: { AVOQADO_INVENTORY: { allowed: true, dataScope: 'venue' } },
      }),
    )
    const out = parse(await call({ venueId: 'v1', name: 'coca', delta: 5, confirm: true }))
    expect(out.ok).toBe(true)
  })
})

describe('adjust_stock con Premium', () => {
  it('no revisa la marca blanca (igual que el panel con Premium)', async () => {
    mockProductFindMany.mockResolvedValue([{ id: 'p1', name: 'X', inventory: { currentStock: 20 } }])
    perVenueAccess.set('v1', acceso({ whiteLabelEnabled: true, enabledFeatures: [] }))
    const out = parse(await call({ venueId: 'v1', name: 'x', delta: -2, type: 'loss', confirm: true }))
    expect(out.ok).toBe(true)
  })
})
