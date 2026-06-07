import { registerCustomerTools } from '../../../src/mcp/tools/customers'
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
    order: { findMany: jest.fn() }, // sibling customer tools register from this module
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('add_customer_note')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCustomerTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('add_customer_note (safe T1 write)', () => {
  it('rejects a venue outside the caller scope (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign', search: 'juan', note: 'hi' })).rejects.toThrow('out of scope')
    expect(mockCustomerFind).not.toHaveBeenCalled()
  })

  it('rejects when the caller lacks customers:update (write gate)', async () => {
    await expect(call({ venueId: 'no-perm', search: 'juan', note: 'hi' })).rejects.toThrow('Forbidden')
    expect(mockCustomerUpdate).not.toHaveBeenCalled()
  })

  it('appends to an existing note (never overwrites) and audits', async () => {
    mockCustomerFind.mockResolvedValueOnce([{ id: 'c1', firstName: 'Juan', lastName: 'Pérez', notes: 'Cliente frecuente' }])
    mockCustomerUpdate.mockResolvedValueOnce({ firstName: 'Juan', lastName: 'Pérez', notes: 'Cliente frecuente\nPrefiere ventana' })

    const out = parse(await call({ venueId: 'v1', search: 'juan', note: 'Prefiere ventana' }))

    expect(mockCustomerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' }, data: { notes: 'Cliente frecuente\nPrefiere ventana' } }),
    )
    expect(out).toMatchObject({ ok: true, customer: { name: 'Juan Pérez', notes: 'Cliente frecuente\nPrefiere ventana' } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'CUSTOMER_NOTE_ADDED',
      entity: 'Customer',
      entityId: 'c1',
      venueId: 'v1',
      data: { note: 'Prefiere ventana' },
    })
  })

  it('sets the note directly when the customer had none', async () => {
    mockCustomerFind.mockResolvedValueOnce([{ id: 'c2', firstName: 'Ana', lastName: 'Ruiz', notes: null }])
    mockCustomerUpdate.mockResolvedValueOnce({ firstName: 'Ana', lastName: 'Ruiz', notes: 'Alérgica a mariscos' })
    await call({ venueId: 'v1', search: 'ana', note: 'Alérgica a mariscos' })
    expect(mockCustomerUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { notes: 'Alérgica a mariscos' } }))
  })

  it('returns candidates (no write) when ambiguous', async () => {
    mockCustomerFind.mockResolvedValueOnce([
      { id: 'c1', firstName: 'Juan', lastName: 'Pérez', notes: null },
      { id: 'c2', firstName: 'Juana', lastName: 'Ruiz', notes: null },
    ])
    const out = parse(await call({ venueId: 'v1', search: 'ju', note: 'x' }))
    expect(out.ambiguous).toBe(true)
    expect(mockCustomerUpdate).not.toHaveBeenCalled()
  })
})
