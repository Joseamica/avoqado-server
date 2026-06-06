import { registerCustomerTools } from '../../../src/mcp/tools/customers'
import type { McpScope } from '../../../src/mcp/scope'

const mockCustomerFind = jest.fn()
const mockOrderFind = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customer: { findMany: (...a: unknown[]) => mockCustomerFind(...(a as [])) },
    order: { findMany: (...a: unknown[]) => mockOrderFind(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('customer_history')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCustomerTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('customer_history', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign', search: 'juan' })).rejects.toThrow('out of scope')
    expect(mockCustomerFind).not.toHaveBeenCalled()
  })

  it('returns not-found and never queries orders when nobody matches', async () => {
    mockCustomerFind.mockResolvedValueOnce([])
    const out = parse(await call({ venueId: 'v1', search: 'zzz' }))
    expect(out.found).toBe(false)
    expect(mockOrderFind).not.toHaveBeenCalled()
  })

  it('resolves the top-spending match, returns their summary + recent orders, flags other matches', async () => {
    mockCustomerFind.mockResolvedValueOnce([
      {
        id: 'cust1',
        firstName: 'Juan',
        lastName: 'Pérez',
        email: 'juan@x.com',
        phone: '555',
        totalVisits: 12,
        totalSpent: 4800,
        averageOrderValue: 400,
        loyaltyPoints: 120,
        tags: ['VIP'],
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
      {
        id: 'cust2',
        firstName: 'Juana',
        lastName: 'Ruiz',
        email: null,
        phone: '556',
        totalVisits: 1,
        totalSpent: 200,
        averageOrderValue: 200,
        loyaltyPoints: 0,
        tags: [],
        createdAt: new Date(),
      },
    ])
    mockOrderFind.mockResolvedValueOnce([
      { orderNumber: 'A-1009', total: 520, status: 'COMPLETED', createdAt: new Date('2026-06-04T20:00:00Z') },
      { orderNumber: 'A-0921', total: 280, status: 'COMPLETED', createdAt: new Date('2026-05-30T19:00:00Z') },
    ])
    const out = parse(await call({ venueId: 'v1', search: 'juan' }))

    expect(out.found).toBe(true)
    expect(out.customer).toMatchObject({ name: 'Juan Pérez', visits: 12, totalSpent: 4800, averageOrderValue: 400, tags: ['VIP'] })
    expect(out.otherMatches).toEqual(['Juana Ruiz'])
    expect(out.orderCount).toBe(2)
    expect(out.orders[0]).toEqual({ orderNumber: 'A-1009', total: 520, status: 'COMPLETED', date: '2026-06-04T20:00:00.000Z' })
    // orders are scoped to the resolved customer AND the venue
    expect(mockOrderFind).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: { in: ['v1'] }, customerId: 'cust1' } }))
  })
})
