/**
 * 🔴 R4-2 (ronda 4 post-QA de sellos tardíos; decisión «A» del founder): la tool `set_table_check_details` del MCP (modo libre
 * `/mcp`; pide `orders:update`) usa el MISMO servicio que el «detalle de la cuenta» del POS, que escribe `Order.customerId`. Le
 * dice al servicio si quien está conectado tiene `payments:create` (`guard.tienePermiso`, el mismo `hasPermission` que
 * `requirePermission`): en una venta COBRADA, sin él, el servicio no cambia el cliente (403 ⇒ la tool contesta `ok: false` con
 * el mensaje en español).
 */
import { registerTableTools } from '../../../src/mcp/tools/tables'
import type { McpScope } from '../../../src/mcp/scope'

const mockTableFindFirst = jest.fn()
const mockAudit = jest.fn()
const mockUpdateOrderDetails = jest.fn()
const permisos = new Set<string>()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: () => undefined,
    tienePermiso: (perm: string) => permisos.has(perm),
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
  mockTableFindFirst.mockReset().mockResolvedValue({ id: 't8', currentOrderId: 'ord-8' })
  mockUpdateOrderDetails.mockReset().mockResolvedValue({ name: null, notes: null, covers: 2, customerId: 'cust-K', orderType: 'DINE_IN' })
})

describe('🔴 R4-2: set_table_check_details le dice al servicio si quien está conectado puede cobrar', () => {
  it('🔴 sin payments:create ⇒ puedeCambiarClienteEnVentaCobrada: false', async () => {
    permisos.add('orders:update')
    await call('set_table_check_details', { venueId: 'v1', number: '8', customerId: 'cust-K' })
    expect(mockUpdateOrderDetails).toHaveBeenCalledWith('v1', 'ord-8', expect.objectContaining({ customerId: 'cust-K' }), {
      puedeCambiarClienteEnVentaCobrada: false,
    })
  })

  it('con payments:create ⇒ true', async () => {
    permisos.add('orders:update').add('payments:create')
    await call('set_table_check_details', { venueId: 'v1', number: '8', customerId: 'cust-K' })
    expect(mockUpdateOrderDetails).toHaveBeenCalledWith('v1', 'ord-8', expect.any(Object), { puedeCambiarClienteEnVentaCobrada: true })
  })

  it('el 403 del servicio sale como `ok: false` con su mensaje en español (sin auditar una escritura que no ocurrió)', async () => {
    mockUpdateOrderDetails.mockRejectedValueOnce(
      Object.assign(new Error('Para cambiar el cliente de una venta ya cobrada necesitas el permiso de cobrar.'), { statusCode: 403 }),
    )
    const r = parse(await call('set_table_check_details', { venueId: 'v1', number: '8', customerId: 'cust-K' }))
    expect(r).toEqual({ ok: false, error: 'Para cambiar el cliente de una venta ya cobrada necesitas el permiso de cobrar.' })
    expect(mockAudit).not.toHaveBeenCalled()
  })
})
