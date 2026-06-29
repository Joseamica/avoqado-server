/**
 * Customer-group (segment) read tools (coverage-gap sweep, 2026-06-29): segments shipped on
 * the dashboard (customer-groups routes) with no MCP coverage.
 *
 *   - list_customer_groups   — segments with customerCount
 *   - customer_group_detail  — one segment: aggregate value + member roster
 *
 * Reads, venue-scoped, gated by customer-groups:read (mirrors the dashboard route). Money in PESOS.
 */
import { registerCustomerGroupTools } from '../../../src/mcp/tools/customerGroups'
import type { McpScope } from '../../../src/mcp/scope'

const mockGetGroups = jest.fn()
const mockGetGroupById = jest.fn()

jest.mock('@/services/dashboard/customerGroup.dashboard.service', () => ({
  getCustomerGroups: (...a: unknown[]) => mockGetGroups(...(a as [])),
  getCustomerGroupById: (...a: unknown[]) => mockGetGroupById(...(a as [])),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing customer-groups:read')
    },
  }),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCustomerGroupTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('list_customer_groups (read, customer-groups:read)', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call('list_customer_groups', { venueId: 'foreign' })).rejects.toThrow('out of scope')
    await expect(call('list_customer_groups', { venueId: 'no-perm' })).rejects.toThrow('Forbidden')
    expect(mockGetGroups).not.toHaveBeenCalled()
  })

  it('maps groups with customerCount and forwards search + limit', async () => {
    mockGetGroups.mockResolvedValueOnce({
      data: [
        {
          id: 'g1',
          name: 'VIP',
          description: 'Los mejores',
          color: '#FF0',
          active: true,
          autoAssignRules: { minSpent: 1000 },
          customerCount: 12,
        },
      ],
      meta: { totalCount: 1 },
    })
    const out = parse(await call('list_customer_groups', { venueId: 'v1', search: 'vip', limit: 5 }))
    expect(mockGetGroups).toHaveBeenCalledWith('v1', { pageSize: 5, search: 'vip' })
    expect(out).toMatchObject({ count: 1, total: 1 })
    expect(out.groups[0]).toMatchObject({ id: 'g1', name: 'VIP', customerCount: 12, autoAssignRules: { minSpent: 1000 } })
  })
})

describe('customer_group_detail (read, customer-groups:read)', () => {
  it('returns group stats (pesos) + member roster ranked by spend', async () => {
    mockGetGroupById.mockResolvedValueOnce({
      id: 'g1',
      name: 'VIP',
      description: 'Los mejores',
      color: '#FF0',
      active: true,
      stats: {
        totalCustomers: 2,
        totalSpent: 3000.5,
        totalVisits: 40,
        totalLoyaltyPoints: 500,
        avgSpentPerCustomer: 1500.25,
        avgVisitsPerCustomer: 20,
      },
      customers: [
        { firstName: 'Ana', lastName: 'Ruiz', email: 'a@x.com', phone: '55', totalSpent: 2000.5, totalVisits: 25, loyaltyPoints: 300 },
        { firstName: 'Luis', lastName: null, email: null, phone: '77', totalSpent: 1000, totalVisits: 15, loyaltyPoints: 200 },
      ],
    })
    const out = parse(await call('customer_group_detail', { venueId: 'v1', groupId: 'g1' }))
    expect(out.found).toBe(true)
    expect(out.group).toMatchObject({ id: 'g1', name: 'VIP' })
    expect(out.stats).toMatchObject({ totalCustomers: 2, totalSpent: 3000.5, avgSpentPerCustomer: 1500.25 })
    expect(out.customers[0]).toEqual({
      name: 'Ana Ruiz',
      email: 'a@x.com',
      phone: '55',
      totalSpent: 2000.5,
      totalVisits: 25,
      loyaltyPoints: 300,
    })
    expect(out.customers[1].name).toBe('Luis')
  })

  it('returns found:false when the group is not in this venue', async () => {
    mockGetGroupById.mockRejectedValueOnce(new Error('Customer group not found'))
    const out = parse(await call('customer_group_detail', { venueId: 'v1', groupId: 'nope' }))
    expect(out.found).toBe(false)
    expect(mockGetGroupById).toHaveBeenCalledWith('v1', 'nope')
  })

  it('rejects no-perm before reading', async () => {
    await expect(call('customer_group_detail', { venueId: 'no-perm', groupId: 'g1' })).rejects.toThrow('Forbidden')
    expect(mockGetGroupById).not.toHaveBeenCalled()
  })
})
