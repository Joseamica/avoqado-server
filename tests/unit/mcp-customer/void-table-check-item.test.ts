/**
 * `void_table_check_item` (MCP): «Anular producto» de la cuenta de una mesa, la misma regla que el POS (Flautas, 20-nov-2026).
 * Pide `orders:void` y `mcp:write`, enseña la vista previa sin confirm, no adivina entre productos parecidos y usa el MISMO
 * servicio que la ruta móvil (pagos y último producto se revisan bajo el candado). Codex r1: la confirmación anula EXACTAMENTE
 * el renglón que mostró (#5), respeta al dueño de la mesa (#3) y no toca piezas de una promoción (#2).
 */
import { registerTableTools } from '../../../src/mcp/tools/tables'
import type { McpScope } from '../../../src/mcp/scope'
import { TOOL_EFFECTS } from '../../../src/mcp/catalog'

const mockRequirePermission = jest.fn()
const mockVoidOrderItem = jest.fn()
const mockLineas = jest.fn()
const mockPropiedad = jest.fn()
const mockAdministraTodas = jest.fn()
const mockCuenta = jest.fn()
const mockPlan = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlan(...(a as [])) }))
jest.mock('@/services/mobile/void-item.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/void-item.mobile.service'),
  voidOrderItem: (...a: unknown[]) => mockVoidOrderItem(...(a as [])),
}))
jest.mock('@/middlewares/checkTableOwnership.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkTableOwnership.middleware'),
  isTableOwnershipEnforced: (...a: unknown[]) => mockPropiedad(...(a as [])),
  staffCanManageAllTables: (...a: unknown[]) => mockAdministraTodas(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    table: { findFirst: jest.fn().mockResolvedValue({ id: 't1', currentOrderId: 'o1' }) },
    orderItem: { findMany: (...a: unknown[]) => mockLineas(...(a as [])) },
    order: { findFirst: (...a: unknown[]) => mockCuenta(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'org1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map(),
  scopes: ['mcp:write'],
} as unknown as McpScope
const llamar = async (args: Record<string, unknown>) =>
  JSON.parse(
    (await handlers.get('void_table_check_item')!({ venueId: 'v1', number: '8', reason: 'Error de entrada', ...args }, {})).content[0].text,
  )

const linea = (id: string, productName: string, orderPromotionId: string | null = null) => ({
  id,
  productName,
  quantity: 1,
  total: 35,
  sentToKitchenAt: new Date(),
  isCortesia: false,
  orderPromotionId,
})

beforeAll(() => {
  registerTableTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockLineas.mockResolvedValue([linea('l1', 'Agua de pepino'), linea('l2', 'Agua de horchata'), linea('l3', 'Flautas de pollo')])
  mockVoidOrderItem.mockResolvedValue({ total: 70 })
  mockPropiedad.mockResolvedValue(false)
  mockAdministraTodas.mockResolvedValue(false)
  mockPlan.mockResolvedValue(null)
  mockCuenta.mockResolvedValue({ version: 3, servedById: null, servedBy: null })
})

describe('void_table_check_item', () => {
  it('es de escritura y pide orders:void', async () => {
    expect(TOOL_EFFECTS.void_table_check_item).toBe('write')
    await llamar({ item: 'pepino' })
    expect(mockRequirePermission).toHaveBeenCalledWith('orders:void', 'v1')
  })

  it('sin confirm sólo enseña qué se anularía, y ata el renglón que mostró', async () => {
    const r = await llamar({ item: 'pepino' })
    expect(r).toMatchObject({
      requiresConfirmation: true,
      resolvedOrderItemId: 'l1',
      expectedVersion: 3,
      preview: { mesa: '8', producto: { id: 'l1', producto: 'Agua de pepino' } },
    })
    expect(mockVoidOrderItem).not.toHaveBeenCalled()
  })

  it('no adivina: dos productos que coinciden ⇒ pide elegir', async () => {
    const r = await llamar({ item: 'agua' })
    expect(r).toMatchObject({ ok: false, ambiguous: true })
    expect(r.productos.map((p: { id: string }) => p.id)).toEqual(['l1', 'l2'])
    expect(mockVoidOrderItem).not.toHaveBeenCalled()
  })

  it('#5: al confirmar sólo vale el renglón de la vista previa; si ya no está en la cuenta, no anula otro parecido', async () => {
    // La mesa ya tiene otra cuenta con OTRA agua de pepino (l9); lo que se VIO fue l1.
    mockLineas.mockResolvedValue([linea('l9', 'Agua de pepino')])
    const r = await llamar({ item: 'pepino', confirm: true, resolvedOrderItemId: 'l1' })
    expect(r).toEqual({ ok: false, error: 'La cuenta cambió desde la vista previa: vuelve a pedirla.' })
    // Y sin el renglón atado, tampoco (nunca se vuelve a buscar por nombre al confirmar).
    expect(await llamar({ item: 'pepino', confirm: true })).toMatchObject({ ok: false })
    expect(mockVoidOrderItem).not.toHaveBeenCalled()
  })

  it('#2: una pieza de una promoción no se anula suelta', async () => {
    mockLineas.mockResolvedValue([linea('l1', 'Agua de pepino', 'promo-1'), linea('l3', 'Flautas de pollo')])
    const r = await llamar({ item: 'pepino' })
    expect(r).toMatchObject({ ok: false, code: 'ORDER_ITEM_VOID_PROMOTION' })
    expect(mockVoidOrderItem).not.toHaveBeenCalled()
  })

  it('#3: con la regla de dueño, la mesa de otro mesero no se toca (salvo quien administra todas)', async () => {
    mockPropiedad.mockResolvedValue(true)
    mockCuenta.mockResolvedValue({ servedById: 'otro', servedBy: { firstName: 'Beto', lastName: 'Ruiz' } })
    const r = await llamar({ item: 'l1', confirm: true, resolvedOrderItemId: 'l1' })
    expect(r).toEqual({
      ok: false,
      error: 'La mesa 8 es de Beto Ruiz: sólo su mesero o quien administra todas las mesas anula sus productos.',
    })
    expect(mockVoidOrderItem).not.toHaveBeenCalled()
    mockAdministraTodas.mockResolvedValue(true)
    expect(await llamar({ item: 'l1', confirm: true, resolvedOrderItemId: 'l1' })).toMatchObject({ ok: true })
    expect(mockAdministraTodas).toHaveBeenCalledWith('s1', 'v1')
  })

  it('r2 #5: sin el plan de mesas no anula (como la ruta del POS)', async () => {
    mockPlan.mockResolvedValue('El servicio de mesas no está incluido en el plan actual de este local.')
    const r = await llamar({ item: 'l1', confirm: true, resolvedOrderItemId: 'l1', expectedVersion: 3 })
    expect(r).toMatchObject({ ok: false, planRequired: true })
    expect(mockPlan).toHaveBeenCalledWith('v1', 'TABLE_SERVICE', 'El servicio de mesas')
    expect(mockVoidOrderItem).not.toHaveBeenCalled()
  })

  it('r2 #4: confirma sobre la versión que se VIO; si otra caja cambió la cuenta (409), pide otra vista previa', async () => {
    await llamar({ item: 'pepino', confirm: true, resolvedOrderItemId: 'l1', expectedVersion: 3 })
    expect(mockVoidOrderItem).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'l1', expectedVersion: 3 }))
    const { ConflictError } = jest.requireActual('@/errors/AppError')
    mockVoidOrderItem.mockRejectedValueOnce(new ConflictError('Order was modified by another request.'))
    const r = await llamar({ item: 'pepino', confirm: true, resolvedOrderItemId: 'l1', expectedVersion: 3 })
    expect(r).toEqual({ ok: false, error: 'La cuenta cambió desde la vista previa: vuelve a pedirla.', code: 'ORDER_CHANGED' })
  })

  it('r3 #3: un cobro en curso (409 con código) NO se disfraza de «la cuenta cambió»: dice esperar o cancelar el cobro', async () => {
    const { ConflictError } = jest.requireActual('@/errors/AppError')
    const ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE = 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE'
    const MENSAJE_COBRO_VIVO = 'Hay un cobro en curso en la terminal: espera a que termine o cancélalo.'
    mockVoidOrderItem.mockRejectedValueOnce(
      new ConflictError(MENSAJE_COBRO_VIVO, ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE, { requestId: 'req-1' }),
    )
    const r = await llamar({ item: 'pepino', confirm: true, resolvedOrderItemId: 'l1', expectedVersion: 3 })
    expect(r).toEqual({ ok: false, error: MENSAJE_COBRO_VIVO, code: ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE })
  })

  it('r3 #3: otro 409 con su propio código (vales) también pasa con su texto', async () => {
    const { ConflictError } = jest.requireActual('@/errors/AppError')
    mockVoidOrderItem.mockRejectedValueOnce(new ConflictError('Esta cuenta tiene vales: …', 'AREA_TICKET_PARTIAL_VOID_NOT_ALLOWED'))
    const r = await llamar({ item: 'pepino', confirm: true, resolvedOrderItemId: 'l1', expectedVersion: 3 })
    expect(r).toEqual({ ok: false, error: 'Esta cuenta tiene vales: …', code: 'AREA_TICKET_PARTIAL_VOID_NOT_ALLOWED' })
  })

  it('con confirm anula ese renglón con el servicio de la mesa, firmado por quien está conectado', async () => {
    const r = await llamar({ item: 'pepino', confirm: true, resolvedOrderItemId: 'l1' })
    expect(mockVoidOrderItem).toHaveBeenCalledWith({
      venueId: 'v1',
      orderId: 'o1',
      itemId: 'l1',
      reason: 'Error de entrada',
      actorId: 's1',
    })
    expect(r).toEqual({ ok: true, anulado: { mesa: '8', producto: 'Agua de pepino', nuevoTotal: 70 } })
  })

  it('sin el permiso no anula nada', async () => {
    mockRequirePermission.mockImplementationOnce(() => {
      throw new Error('Forbidden: missing orders:void')
    })
    await expect(llamar({ item: 'l1', confirm: true, resolvedOrderItemId: 'l1' })).rejects.toThrow('Forbidden')
    expect(mockVoidOrderItem).not.toHaveBeenCalled()
  })
})
