import { registerCustomerTools } from '../../../src/mcp/tools/customers'
import type { McpScope } from '../../../src/mcp/scope'

const mockCreate = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing customers:create')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({ createCustomer: (...a: unknown[]) => mockCreate(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { customer: { findMany: jest.fn(), update: jest.fn() }, order: { findMany: jest.fn() } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('create_customer')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCustomerTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('create_customer (write)', () => {
  it('rejects a venue outside the caller scope', async () => {
    await expect(call({ venueId: 'foreign', email: 'a@b.com' })).rejects.toThrow('out of scope')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects when the caller lacks customers:create', async () => {
    await expect(call({ venueId: 'no-perm', email: 'a@b.com' })).rejects.toThrow('Forbidden')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('requires an email or a phone — no service call otherwise', async () => {
    const out = parse(await call({ venueId: 'v1', firstName: 'Ana' }))
    expect(out.ok).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates the customer, audits it, and returns the new record', async () => {
    mockCreate.mockResolvedValueOnce({ id: 'c-new', firstName: 'Ana', lastName: 'López', email: 'ana@x.com', phone: null })
    const out = parse(await call({ venueId: 'v1', firstName: 'Ana', lastName: 'López', email: 'ana@x.com', tags: ['VIP'] }))

    expect(mockCreate).toHaveBeenCalledWith('v1', expect.objectContaining({ firstName: 'Ana', email: 'ana@x.com', tags: ['VIP'] }))
    expect(out).toMatchObject({ ok: true, customer: { id: 'c-new', name: 'Ana López', email: 'ana@x.com' } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'CUSTOMER_CREATED', entity: 'Customer', entityId: 'c-new', venueId: 'v1' })
  })

  it('surfaces a duplicate error from the service as ok:false (no crash)', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Customer with email ana@x.com already exists in this venue'))
    const out = parse(await call({ venueId: 'v1', email: 'ana@x.com' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/already exists/)
  })
})
