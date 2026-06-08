import { registerTableTools } from '../../../src/mcp/tools/tables'
import type { McpScope } from '../../../src/mcp/scope'

const mockTableFindFirst = jest.fn()
const mockTableUpdate = jest.fn()
const mockAudit = jest.fn()

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
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('set_table_status')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerTableTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('set_table_status (safe T1 write)', () => {
  it('rejects a venue outside the caller scope', async () => {
    await expect(call({ venueId: 'foreign', number: '5', status: 'cleaning' })).rejects.toThrow('out of scope')
    expect(mockTableFindFirst).not.toHaveBeenCalled()
  })

  it('rejects when the caller lacks tables:update', async () => {
    await expect(call({ venueId: 'no-perm', number: '5', status: 'cleaning' })).rejects.toThrow('Forbidden')
    expect(mockTableUpdate).not.toHaveBeenCalled()
  })

  it('refuses to free a table that has a live order (no write)', async () => {
    mockTableFindFirst.mockResolvedValueOnce({ id: 't1', number: '12', status: 'OCCUPIED', currentOrderId: 'ord-9' })
    const out = parse(await call({ venueId: 'v1', number: '12', status: 'available' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/cuenta abierta/)
    expect(mockTableUpdate).not.toHaveBeenCalled()
  })

  it('sets the status and audits when there is no conflict', async () => {
    mockTableFindFirst.mockResolvedValueOnce({ id: 't1', number: '12', status: 'OCCUPIED', currentOrderId: null })
    mockTableUpdate.mockResolvedValueOnce({ number: '12', status: 'CLEANING' })

    const out = parse(await call({ venueId: 'v1', number: '12', status: 'cleaning' }))

    expect(mockTableUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't1' }, data: { status: 'CLEANING' } }))
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
