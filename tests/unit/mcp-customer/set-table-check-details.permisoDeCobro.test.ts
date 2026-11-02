/**
 * La tool delega al mismo servicio que POS con actor MCP confiable y autoridad
 * histórica separada del permiso de recibo. Los rechazos no auditan una escritura.
 */
import { registerTableTools } from '../../../src/mcp/tools/tables'
import type { McpScope } from '../../../src/mcp/scope'

const mockTableFindFirst = jest.fn()
const mockAudit = jest.fn()
const mockUpdateOrderDetails = jest.fn()
const permisos = new Set<string>()
const mockCustomerActor = { staffId: 's1', canAssignHistorical: false, canAttachAtReceipt: false }

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: () => undefined,
    tienePermiso: (perm: string) => permisos.has(perm),
    customerAttributionActor: () => ({ ...mockCustomerActor }),
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    table: { findMany: jest.fn(), findFirst: (...a: unknown[]) => mockTableFindFirst(...(a as [])), update: jest.fn() },
    area: { findMany: jest.fn() },
  },
}))
jest.mock('@/services/tpv/table.tpv.service', () => ({ moveOrderToTable: jest.fn(), assignOrderWaiter: jest.fn() }))
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({ compWholeOrder: jest.fn() }))
jest.mock('@/services/mobile/order.mobile.service', () => ({
  updateOrderDetails: (...a: unknown[]) => mockUpdateOrderDetails(...(a as [])),
  splitOrderItems: jest.fn(),
  splitOrderBySeat: jest.fn(),
  mergeOrders: jest.fn(),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (tool: string, args: Record<string, unknown>) => handlers.get(tool)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerTableTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})

beforeEach(() => {
  permisos.clear()
  mockCustomerActor.canAssignHistorical = false
  mockCustomerActor.canAttachAtReceipt = false
  mockAudit.mockClear()
  mockTableFindFirst.mockReset().mockResolvedValue({ id: 't8', currentOrderId: 'ord-8' })
  mockUpdateOrderDetails.mockReset().mockResolvedValue({ name: null, notes: null, covers: 2, customerId: 'cust-K', orderType: 'DINE_IN' })
})

describe('set_table_check_details — transporta autoridad MCP de atribución', () => {
  it('🔴 sin payments:create ⇒ puedeCambiarClienteEnVentaCobrada: false', async () => {
    permisos.add('orders:update')
    await call('set_table_check_details', { venueId: 'v1', number: '8', customerId: 'cust-K' })
    expect(mockUpdateOrderDetails).toHaveBeenCalledWith('v1', 'ord-8', expect.objectContaining({ customerId: 'cust-K' }), {
      puedeCambiarClienteEnVentaCobrada: false,
      customerAttribution: mockCustomerActor,
    })
  })

  it('con payments:create ⇒ true', async () => {
    permisos.add('orders:update').add('payments:create')
    mockCustomerActor.canAttachAtReceipt = true
    await call('set_table_check_details', { venueId: 'v1', number: '8', customerId: 'cust-K' })
    expect(mockUpdateOrderDetails).toHaveBeenCalledWith('v1', 'ord-8', expect.any(Object), {
      puedeCambiarClienteEnVentaCobrada: true,
      customerAttribution: mockCustomerActor,
    })
  })

  it('gerente autorizado conserva actor MCP y autoridad histórica al delegar', async () => {
    permisos.add('orders:update').add('payments:create').add('orders:attach-customer')
    mockCustomerActor.canAttachAtReceipt = true
    mockCustomerActor.canAssignHistorical = true
    await call('set_table_check_details', { venueId: 'v1', number: '8', customerId: 'cust-K', staffId: 'otro' })
    expect(mockUpdateOrderDetails).toHaveBeenCalledWith('v1', 'ord-8', expect.any(Object), {
      puedeCambiarClienteEnVentaCobrada: true,
      customerAttribution: { staffId: 's1', canAssignHistorical: true, canAttachAtReceipt: true },
    })
  })

  it('el 403 del servicio sale como `ok: false` con su mensaje en español (sin auditar una escritura que no ocurrió)', async () => {
    mockUpdateOrderDetails.mockRejectedValueOnce(
      Object.assign(new Error('Sólo un gerente o superior con permiso puede asignar un cliente a esta venta.'), { statusCode: 403 }),
    )
    const r = parse(await call('set_table_check_details', { venueId: 'v1', number: '8', customerId: 'cust-K' }))
    expect(r).toEqual({ ok: false, error: 'Sólo un gerente o superior con permiso puede asignar un cliente a esta venta.' })
    expect(mockAudit).not.toHaveBeenCalled()
  })
})
