import { registerTableTools } from '../../../src/mcp/tools/tables'
import type { McpScope } from '../../../src/mcp/scope'

const mockTableFindFirst = jest.fn()
const mockTableUpdate = jest.fn()
const mockAudit = jest.fn()
const mockTransaction = jest.fn()
const mockRaw = jest.fn()
const mockTableFindMany = jest.fn()
const mockOrderFindMany = jest.fn()
let mockCommitted = false
const mockTx = {
  $queryRaw: mockRaw,
  table: { findMany: mockTableFindMany, update: mockTableUpdate },
  order: { findMany: mockOrderFindMany },
}

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing tables:update')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    table: {
      findMany: jest.fn(), // tables_status + list_areas register from this module
      findFirst: (...a: unknown[]) => mockTableFindFirst(...(a as [])),
      update: (...a: unknown[]) => mockTableUpdate(...(a as [])),
    },
    area: { findMany: jest.fn() },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('set_table_status')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerTableTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockCommitted = false
  mockTransaction.mockImplementation(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
    const result = await callback(mockTx)
    mockCommitted = true
    return result
  })
  mockAudit.mockImplementation(async () => {
    expect(mockCommitted).toBe(true)
  })
})

function topology(table: { id: string; number: string; status: string; currentOrderId: string | null }, live = false) {
  const rows = live
    ? [{ id: 'ord-9', tableId: table.id, status: 'PENDING', paymentStatus: 'PENDING', createdAt: new Date('2026-10-01T00:00:00Z') }]
    : []
  mockTableFindMany.mockResolvedValue([table])
  mockOrderFindMany.mockResolvedValue(rows)
  mockRaw.mockImplementation(async (query: unknown) => {
    const sql = Array.isArray(query)
      ? query.join(' ')
      : query && typeof query === 'object' && 'strings' in query && Array.isArray(query.strings)
        ? query.strings.join(' ')
        : ''
    if (sql.includes('FROM "Venue"')) return [{ id: 'v1' }]
    if (sql.includes('FROM "Order"')) return rows.map(row => ({ id: row.id }))
    if (sql.includes('FROM "Table"')) return [{ id: table.id }]
    throw new Error('Unexpected MCP topology SQL')
  })
}

describe('set_table_status (safe T1 write)', () => {
  it('rejects a venue outside the caller scope', async () => {
    await expect(call({ venueId: 'foreign', number: '5', status: 'cleaning' })).rejects.toThrow('out of scope')
    expect(mockTableFindFirst).not.toHaveBeenCalled()
  })

  it('rejects when the caller lacks tables:update', async () => {
    await expect(call({ venueId: 'no-perm', number: '5', status: 'cleaning' })).rejects.toThrow('Forbidden')
    expect(mockTableUpdate).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('refuses to free a table that has a live order (no write)', async () => {
    topology({ id: 't1', number: '12', status: 'OCCUPIED', currentOrderId: 'ord-9' }, true)
    mockTableFindFirst.mockResolvedValueOnce({ id: 't1', number: '12', status: 'OCCUPIED', currentOrderId: 'ord-9' })
    const out = parse(await call({ venueId: 'v1', number: '12', status: 'available' }))
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15000, maxWait: 5000 })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/cuenta abierta/)
    expect(mockTableUpdate).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('sets the status and audits when there is no conflict', async () => {
    topology({ id: 't1', number: '12', status: 'OCCUPIED', currentOrderId: null })
    mockTableFindFirst.mockResolvedValueOnce({ id: 't1', number: '12', status: 'OCCUPIED', currentOrderId: null })
    mockTableUpdate.mockResolvedValueOnce({ number: '12', status: 'CLEANING' })

    const out = parse(await call({ venueId: 'v1', number: '12', status: 'cleaning' }))

    expect(mockTableUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't1' }, data: { status: 'CLEANING' } }))
    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15000, maxWait: 5000 })
    expect(mockTableFindMany).toHaveBeenCalledTimes(2)
    expect(mockRaw.mock.invocationCallOrder[mockRaw.mock.invocationCallOrder.length - 1]).toBeLessThan(
      mockTableUpdate.mock.invocationCallOrder[0],
    )
    expect(out).toMatchObject({ ok: true, table: { number: '12', status: 'CLEANING' } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'TABLE_STATUS_SET',
      entity: 'Table',
      entityId: 't1',
      venueId: 'v1',
      data: { from: 'OCCUPIED', to: 'CLEANING' },
    })
  })
})
