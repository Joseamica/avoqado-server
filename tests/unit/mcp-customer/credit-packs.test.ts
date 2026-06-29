/**
 * Credit-pack read tools (coverage-gap sweep, 2026-06-29): prepaid packs ("paquete de 10
 * clases / masajes") shipped on the dashboard with no MCP coverage — core to the gyms/spas/
 * salons ICP.
 *
 *   - list_credit_packs        — the catalog (price, what's included, sold count)
 *   - customer_credit_balance  — one customer's remaining credits ("¿cuántas le quedan a Juan?")
 *
 * Reads, venue-scoped, gated by creditPacks:read (mirrors the dashboard route). Money in PESOS.
 */
import { registerCreditPackTools } from '../../../src/mcp/tools/creditPacks'
import type { McpScope } from '../../../src/mcp/scope'

const mockGetPacks = jest.fn()
const mockGetPurchases = jest.fn()
const mockCustomerFindMany = jest.fn()

jest.mock('@/services/dashboard/creditPack.dashboard.service', () => ({
  getCreditPacks: (...a: unknown[]) => mockGetPacks(...(a as [])),
  getCustomerPurchases: (...a: unknown[]) => mockGetPurchases(...(a as [])),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing creditPacks:read')
    },
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { customer: { findMany: (...a: unknown[]) => mockCustomerFindMany(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCreditPackTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('list_credit_packs (read, creditPacks:read)', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call('list_credit_packs', { venueId: 'foreign' })).rejects.toThrow('out of scope')
    await expect(call('list_credit_packs', { venueId: 'no-perm' })).rejects.toThrow('Forbidden')
    expect(mockGetPacks).not.toHaveBeenCalled()
  })

  it('maps packs (price pesos, included items, sold count) and defaults to active only', async () => {
    mockGetPacks.mockResolvedValueOnce([
      {
        id: 'cp1',
        name: 'Paquete 10 clases',
        description: 'Yoga',
        price: 1500,
        currency: 'MXN',
        active: true,
        _count: { purchases: 7 },
        items: [{ product: { name: 'Clase Yoga' }, quantity: 10 }],
      },
      { id: 'cp2', name: 'Viejo', price: 100, currency: 'MXN', active: false, _count: { purchases: 0 }, items: [] },
    ])
    const out = parse(await call('list_credit_packs', { venueId: 'v1' }))
    expect(out.count).toBe(1) // inactive dropped by default
    expect(out.creditPacks[0]).toMatchObject({
      id: 'cp1',
      name: 'Paquete 10 clases',
      price: 1500,
      sold: 7,
      includes: [{ product: 'Clase Yoga', credits: 10 }],
    })
  })

  it('includeInactive keeps inactive packs', async () => {
    mockGetPacks.mockResolvedValueOnce([
      { id: 'cp2', name: 'Viejo', price: 100, currency: 'MXN', active: false, _count: { purchases: 0 }, items: [] },
    ])
    const out = parse(await call('list_credit_packs', { venueId: 'v1', includeInactive: true }))
    expect(out.count).toBe(1)
  })
})

describe('customer_credit_balance (read, creditPacks:read)', () => {
  it('resolves the customer and returns remaining credits per item', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'cust1', firstName: 'Juan', lastName: 'Pérez' }])
    mockGetPurchases.mockResolvedValueOnce({
      purchases: [
        {
          creditPack: { name: 'Paquete 10 clases' },
          status: 'ACTIVE',
          purchasedAt: new Date('2026-06-01T10:00:00Z'),
          expiresAt: new Date('2026-12-01T10:00:00Z'),
          amountPaid: 1500,
          itemBalances: [{ product: { name: 'Clase Yoga' }, remainingQuantity: 6, originalQuantity: 10 }],
        },
      ],
      total: 1,
    })
    const out = parse(await call('customer_credit_balance', { venueId: 'v1', search: 'juan' }))
    expect(out.found).toBe(true)
    expect(out.customer).toBe('Juan Pérez')
    // default → only ACTIVE purchases requested
    expect(mockGetPurchases).toHaveBeenCalledWith('v1', { customerId: 'cust1', status: 'ACTIVE', limit: 50 })
    expect(out.purchases[0]).toMatchObject({ pack: 'Paquete 10 clases', status: 'ACTIVE', amountPaid: 1500 })
    expect(out.purchases[0].items[0]).toEqual({ product: 'Clase Yoga', remaining: 6, original: 10 })
  })

  it('includeInactive asks for all statuses', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([{ id: 'cust1', firstName: 'Juan', lastName: 'Pérez' }])
    mockGetPurchases.mockResolvedValueOnce({ purchases: [], total: 0 })
    await call('customer_credit_balance', { venueId: 'v1', search: 'juan', includeInactive: true })
    expect(mockGetPurchases).toHaveBeenCalledWith('v1', { customerId: 'cust1', limit: 50 })
  })

  it('returns ambiguous when several customers match (no balance leaked)', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([
      { id: 'a', firstName: 'Juan', lastName: 'A' },
      { id: 'b', firstName: 'Juan', lastName: 'B' },
    ])
    const out = parse(await call('customer_credit_balance', { venueId: 'v1', search: 'juan' }))
    expect(out.ambiguous).toBe(true)
    expect(mockGetPurchases).not.toHaveBeenCalled()
  })

  it('returns found:false when no customer matches', async () => {
    mockCustomerFindMany.mockResolvedValueOnce([])
    const out = parse(await call('customer_credit_balance', { venueId: 'v1', search: 'zzz' }))
    expect(out.found).toBe(false)
    expect(mockGetPurchases).not.toHaveBeenCalled()
  })
})
