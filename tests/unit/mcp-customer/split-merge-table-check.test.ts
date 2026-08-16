/**
 * MCP tools closing the Plan B Task 6 gap: Task 4 mounted split-by-seat and
 * merge under /tpv (SPLIT_BY_SEAT / MERGE_ORDERS in the offline reducer) but
 * the customer MCP had no way to reach either — only the plain item-based
 * split (`split_table_check`) existed. `split_table_check_by_seat` and
 * `merge_table_check` close that gap.
 */
import { registerTableTools } from '../../../src/mcp/tools/tables'
import type { McpScope } from '../../../src/mcp/scope'

const mockTableFindFirst = jest.fn()
const mockAudit = jest.fn()
const mockSplitOrderBySeat = jest.fn()
const mockMergeOrders = jest.fn()
/** Permisos que los tools pidieron, en orden. Ver el mock de `requirePermission`. */
const requiredPermissions: string[] = []

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    // 🔴 Registra QUÉ permiso pidió cada tool. Antes se ignoraba el argumento,
    // así que revertir el guard a `orders:update` seguía pasando el test — el
    // candado del MCP no estaba protegido por nada.
    requirePermission: (perm: string, v: string) => {
      requiredPermissions.push(perm)
      if (v === 'no-perm') throw new Error(`Forbidden: missing ${perm}`)
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    table: {
      findMany: jest.fn(),
      findFirst: (...a: unknown[]) => mockTableFindFirst(...(a as [])),
      update: jest.fn(),
    },
    area: { findMany: jest.fn() },
  },
}))
jest.mock('@/services/tpv/table.tpv.service', () => ({ moveOrderToTable: jest.fn(), assignOrderWaiter: jest.fn() }))
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({ compWholeOrder: jest.fn() }))
jest.mock('@/services/mobile/order.mobile.service', () => ({
  updateOrderDetails: jest.fn(),
  splitOrderItems: jest.fn(),
  splitOrderBySeat: (...a: unknown[]) => mockSplitOrderBySeat(...(a as [])),
  mergeOrders: (...a: unknown[]) => mockMergeOrders(...(a as [])),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (tool: string, args: Record<string, unknown>) => handlers.get(tool)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerTableTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  requiredPermissions.length = 0
})

describe('split_table_check_by_seat', () => {
  it('rejects a venue outside the caller scope', async () => {
    await expect(call('split_table_check_by_seat', { venueId: 'foreign', number: '5' })).rejects.toThrow('out of scope')
    expect(mockSplitOrderBySeat).not.toHaveBeenCalled()
  })

  it('rejects when the caller lacks orders:update', async () => {
    await expect(call('split_table_check_by_seat', { venueId: 'no-perm', number: '5' })).rejects.toThrow('Forbidden')
    expect(mockSplitOrderBySeat).not.toHaveBeenCalled()
  })

  it('errors (no write) when the table has no open check', async () => {
    mockTableFindFirst.mockResolvedValueOnce({ id: 't1', currentOrderId: null })
    const out = parse(await call('split_table_check_by_seat', { venueId: 'v1', number: '8' }))
    expect(out.ok).toBe(false)
    expect(mockSplitOrderBySeat).not.toHaveBeenCalled()
  })

  it('splits by seat and audits on success', async () => {
    mockTableFindFirst.mockResolvedValueOnce({ id: 't1', currentOrderId: 'ord-1' })
    mockSplitOrderBySeat.mockResolvedValueOnce({
      source: { id: 'ord-1', orderNumber: 'ORD-1', total: 100, seat: 1 },
      created: [{ id: 'ord-2', orderNumber: 'ORD-2', seat: 2, total: 50 }],
    })

    const out = parse(await call('split_table_check_by_seat', { venueId: 'v1', number: '8' }))

    expect(mockSplitOrderBySeat).toHaveBeenCalledWith('v1', 'ord-1', 's1')
    expect(out.ok).toBe(true)
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'TABLE_CHECK_SPLIT_BY_SEAT',
      entity: 'Order',
      entityId: 'ord-1',
      venueId: 'v1',
      data: { table: '8', checksCreated: 1, seats: [2] },
    })
  })

  it('surfaces a business-rule rejection (e.g. discounts present) without auditing', async () => {
    mockTableFindFirst.mockResolvedValueOnce({ id: 't1', currentOrderId: 'ord-1' })
    mockSplitOrderBySeat.mockRejectedValueOnce(new Error('Quita los descuentos antes de dividir por puesto.'))

    const out = parse(await call('split_table_check_by_seat', { venueId: 'v1', number: '8' }))
    expect(out.ok).toBe(false)
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('merge_table_check', () => {
  it('rejects a venue outside the caller scope', async () => {
    await expect(call('merge_table_check', { venueId: 'foreign', targetNumber: '12', sourceNumber: '8' })).rejects.toThrow('out of scope')
    expect(mockMergeOrders).not.toHaveBeenCalled()
  })

  it('rejects when the caller lacks orders:merge', async () => {
    await expect(call('merge_table_check', { venueId: 'no-perm', targetNumber: '12', sourceNumber: '8' })).rejects.toThrow('Forbidden')
    expect(mockMergeOrders).not.toHaveBeenCalled()
    // 🔴 El permiso EXACTO, no uno cualquiera: fusionar tiene el suyo desde
    // 2026-08 y por las rutas HTTP ya se exige. Sin esta aserción, revertir el
    // guard a `orders:update` volvía a abrir el atajo por el MCP sin que ningún
    // test se quejara.
    expect(requiredPermissions).toContain('orders:merge')
    expect(requiredPermissions).not.toContain('orders:update')
  })

  it('errors (no write) when the target table has no open check', async () => {
    mockTableFindFirst.mockResolvedValueOnce({ id: 't-target', currentOrderId: null })
    const out = parse(await call('merge_table_check', { venueId: 'v1', targetNumber: '12', sourceNumber: '8' }))
    expect(out.ok).toBe(false)
    expect(mockMergeOrders).not.toHaveBeenCalled()
  })

  it('errors (no write) when the source table has no open check', async () => {
    mockTableFindFirst.mockResolvedValueOnce({ id: 't-target', currentOrderId: 'ord-target' })
    mockTableFindFirst.mockResolvedValueOnce({ id: 't-source', currentOrderId: null })
    const out = parse(await call('merge_table_check', { venueId: 'v1', targetNumber: '12', sourceNumber: '8' }))
    expect(out.ok).toBe(false)
    expect(mockMergeOrders).not.toHaveBeenCalled()
  })

  it('merges the source check into the target and audits on success', async () => {
    mockTableFindFirst.mockResolvedValueOnce({ id: 't-target', currentOrderId: 'ord-target' })
    mockTableFindFirst.mockResolvedValueOnce({ id: 't-source', currentOrderId: 'ord-source' })
    mockMergeOrders.mockResolvedValueOnce({
      target: { id: 'ord-target', orderNumber: 'ORD-TGT', total: 250, version: 2 },
      merged: { id: 'ord-source', orderNumber: 'ORD-SRC', items: 3 },
      tableFreed: true,
    })

    const out = parse(await call('merge_table_check', { venueId: 'v1', targetNumber: '12', sourceNumber: '8' }))

    expect(mockMergeOrders).toHaveBeenCalledWith('v1', 'ord-target', 'ord-source', 's1')
    expect(out.ok).toBe(true)
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'TABLE_CHECKS_MERGED',
      entity: 'Order',
      entityId: 'ord-target',
      venueId: 'v1',
      data: { target: '12', source: '8', items: 3 },
    })
  })

  it('surfaces a business-rule rejection (e.g. source already paid) without auditing', async () => {
    mockTableFindFirst.mockResolvedValueOnce({ id: 't-target', currentOrderId: 'ord-target' })
    mockTableFindFirst.mockResolvedValueOnce({ id: 't-source', currentOrderId: 'ord-source' })
    mockMergeOrders.mockRejectedValueOnce(new Error('La cuenta origen ya tiene pagos; no se puede fusionar'))

    const out = parse(await call('merge_table_check', { venueId: 'v1', targetNumber: '12', sourceNumber: '8' }))
    expect(out.ok).toBe(false)
    expect(mockAudit).not.toHaveBeenCalled()
  })
})
