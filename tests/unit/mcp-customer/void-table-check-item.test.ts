/**
 * `void_table_check_item` (MCP): «Anular producto» de la cuenta de una mesa, la misma regla que el POS (Flautas, 20-nov-2026).
 * Pide `orders:void` y `mcp:write`, enseña la vista previa sin confirm, no adivina entre productos parecidos y usa el MISMO
 * servicio que la ruta móvil (pagos y último producto se revisan bajo el candado).
 */
import { registerTableTools } from '../../../src/mcp/tools/tables'
import type { McpScope } from '../../../src/mcp/scope'
import { TOOL_EFFECTS } from '../../../src/mcp/catalog'

const mockRequirePermission = jest.fn()
const mockVoidOrderItem = jest.fn()
const mockLineas = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/services/mobile/void-item.mobile.service', () => ({
  voidOrderItem: (...a: unknown[]) => mockVoidOrderItem(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    table: { findFirst: jest.fn().mockResolvedValue({ id: 't1', currentOrderId: 'o1' }) },
    orderItem: { findMany: (...a: unknown[]) => mockLineas(...(a as [])) },
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

const linea = (id: string, productName: string) => ({
  id,
  productName,
  quantity: 1,
  total: 35,
  sentToKitchenAt: new Date(),
  isCortesia: false,
})

beforeAll(() => {
  registerTableTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockLineas.mockResolvedValue([linea('l1', 'Agua de pepino'), linea('l2', 'Agua de horchata'), linea('l3', 'Flautas de pollo')])
  mockVoidOrderItem.mockResolvedValue({ total: 70 })
})

describe('void_table_check_item', () => {
  it('es de escritura y pide orders:void', async () => {
    expect(TOOL_EFFECTS.void_table_check_item).toBe('write')
    await llamar({ item: 'pepino' })
    expect(mockRequirePermission).toHaveBeenCalledWith('orders:void', 'v1')
  })

  it('sin confirm sólo enseña qué se anularía', async () => {
    const r = await llamar({ item: 'pepino' })
    expect(r).toMatchObject({ requiresConfirmation: true, preview: { mesa: '8', producto: { id: 'l1', producto: 'Agua de pepino' } } })
    expect(mockVoidOrderItem).not.toHaveBeenCalled()
  })

  it('no adivina: dos productos que coinciden ⇒ pide elegir', async () => {
    const r = await llamar({ item: 'agua', confirm: true })
    expect(r).toMatchObject({ ok: false, ambiguous: true })
    expect(r.productos.map((p: { id: string }) => p.id)).toEqual(['l1', 'l2'])
    expect(mockVoidOrderItem).not.toHaveBeenCalled()
  })

  it('con confirm anula ese renglón con el servicio de la mesa, firmado por quien está conectado', async () => {
    const r = await llamar({ item: 'l1', confirm: true })
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
    await expect(llamar({ item: 'l1', confirm: true })).rejects.toThrow('Forbidden')
    expect(mockVoidOrderItem).not.toHaveBeenCalled()
  })
})
