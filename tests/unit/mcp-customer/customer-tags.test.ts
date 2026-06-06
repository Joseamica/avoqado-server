import { registerCustomerTools, applyTagChanges } from '../../../src/mcp/tools/customers'
import type { McpScope } from '../../../src/mcp/scope'

const mockCustomerFind = jest.fn()
const mockCustomerUpdate = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing customers:update')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customer: {
      findMany: (...a: unknown[]) => mockCustomerFind(...(a as [])),
      update: (...a: unknown[]) => mockCustomerUpdate(...(a as [])),
    },
    order: { findMany: jest.fn() }, // find_customer/customer_history also register from this module
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('set_customer_tags')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCustomerTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('applyTagChanges (pure)', () => {
  it('adds new tags, removes (case-insensitive), and dedupes keeping first-seen casing/order', () => {
    expect(applyTagChanges(['VIP'], ['Birthday-Dec'], [])).toEqual(['VIP', 'Birthday-Dec'])
    expect(applyTagChanges(['VIP', 'Old'], [], ['old'])).toEqual(['VIP'])
    expect(applyTagChanges(['VIP'], ['vip', 'New'], [])).toEqual(['VIP', 'New'])
    expect(applyTagChanges([], [], ['anything'])).toEqual([])
  })
})

describe('set_customer_tags (safe T1 write)', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign', search: 'juan', add: ['VIP'] })).rejects.toThrow('out of scope')
    expect(mockCustomerFind).not.toHaveBeenCalled()
  })

  it('rejects when the caller lacks customers:update (write gate)', async () => {
    await expect(call({ venueId: 'no-perm', search: 'juan', add: ['VIP'] })).rejects.toThrow('Forbidden')
    expect(mockCustomerFind).not.toHaveBeenCalled()
    expect(mockCustomerUpdate).not.toHaveBeenCalled()
  })

  it('requires at least one of add/remove — no write otherwise', async () => {
    const out = parse(await call({ venueId: 'v1', search: 'juan' }))
    expect(out.ok).toBe(false)
    expect(mockCustomerFind).not.toHaveBeenCalled()
  })

  it('returns the candidates (no write) when the search is ambiguous', async () => {
    mockCustomerFind.mockResolvedValueOnce([
      { id: 'c1', firstName: 'Juan', lastName: 'Pérez', tags: [] },
      { id: 'c2', firstName: 'Juana', lastName: 'Ruiz', tags: [] },
    ])
    const out = parse(await call({ venueId: 'v1', search: 'ju', add: ['VIP'] }))
    expect(out.ok).toBe(false)
    expect(out.ambiguous).toBe(true)
    expect(mockCustomerUpdate).not.toHaveBeenCalled()
  })

  it('merges tags onto the single match, persists, and audits the write', async () => {
    mockCustomerFind.mockResolvedValueOnce([{ id: 'c1', firstName: 'Juan', lastName: 'Pérez', tags: ['Old'] }])
    mockCustomerUpdate.mockResolvedValueOnce({ firstName: 'Juan', lastName: 'Pérez', tags: ['Old', 'VIP'] })

    const out = parse(await call({ venueId: 'v1', search: 'juan perez', add: ['VIP'], remove: ['stale'] }))

    expect(mockCustomerUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1' }, data: { tags: ['Old', 'VIP'] } }))
    expect(out).toMatchObject({ ok: true, customer: { name: 'Juan Pérez', tags: ['Old', 'VIP'] } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'CUSTOMER_TAGS_SET',
      entity: 'Customer',
      entityId: 'c1',
      venueId: 'v1',
      data: { added: ['VIP'], removed: ['stale'], tags: ['Old', 'VIP'] },
    })
  })
})
