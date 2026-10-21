import { registerCommissionTools } from '../../../src/mcp/tools/commissions'
import type { McpScope } from '../../../src/mcp/scope'

const mockGroupBy = jest.fn()
const mockFindMany = jest.fn()
const mockHasPermission = jest.fn()
const mockVenuesWithCommissionsAccess = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: (...a: unknown[]) => mockHasPermission(...(a as [])) }))
// Plan gate (dual grant: COMMISSIONS module OR tier) — mocked; its own semantics are covered by
// basePlan tests + commissionRoutes.featureGate.test.ts. Default (beforeEach): all venues entitled.
jest.mock('@/services/access/basePlan.service', () => ({
  venuesWithCommissionsAccess: (...a: unknown[]) => mockVenuesWithCommissionsAccess(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    commissionPayout: {
      groupBy: (...a: unknown[]) => mockGroupBy(...(a as [])),
      findMany: (...a: unknown[]) => mockFindMany(...(a as [])),
    },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { role: 'OWNER' }]]),
} as unknown as McpScope
const call = (args: Record<string, unknown>) => handlers.get('commission_payouts')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCommissionTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockVenuesWithCommissionsAccess.mockImplementation(async (ids: string[]) => new Set(ids))
})

describe('commission_payouts', () => {
  it('rejects a venue outside the caller scope (cross-tenant guard)', async () => {
    mockHasPermission.mockReturnValue(true)
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockGroupBy).not.toHaveBeenCalled()
  })

  it('returns nothing (no DB read) when the caller lacks commissions:read', async () => {
    mockHasPermission.mockReturnValue(false)
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.venuesInScope).toBe(0)
    expect(mockGroupBy).not.toHaveBeenCalled()
  })

  it('returns nothing (no DB read) when the venue plan/module does not include commissions (plan gate)', async () => {
    mockHasPermission.mockReturnValue(true)
    mockVenuesWithCommissionsAccess.mockResolvedValue(new Set()) // not entitled: no module, no PREMIUM
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.venuesInScope).toBe(0)
    expect(out.note).toContain('plan/módulo')
    expect(mockGroupBy).not.toHaveBeenCalled()
  })

  it('computes paid vs pending totals across statuses for permitted venues', async () => {
    mockHasPermission.mockReturnValue(true)
    mockGroupBy.mockResolvedValueOnce([
      { status: 'PAID', _count: { _all: 3 }, _sum: { amount: 900 } },
      { status: 'PENDING', _count: { _all: 2 }, _sum: { amount: 400 } },
      { status: 'APPROVED', _count: { _all: 1 }, _sum: { amount: 150 } },
    ])
    mockFindMany.mockResolvedValueOnce([
      {
        amount: 300,
        paymentMethod: 'BANK_TRANSFER',
        status: 'PAID',
        paidAt: new Date('2026-06-01T10:00:00Z'),
        processedAt: new Date('2026-06-01T09:00:00Z'),
        createdAt: new Date('2026-05-31T10:00:00Z'),
        notes: null,
        staff: { firstName: 'Luis', lastName: 'Gómez' },
        venue: { name: 'Centro' },
      },
    ])
    const out = parse(await call({ venueId: 'v1' }))

    expect(out.totals).toEqual({ paid: 900, pending: 550 }) // 400 PENDING + 150 APPROVED
    expect(out.byStatus.PAID).toEqual({ count: 3, amount: 900 })
    expect(out.payouts[0]).toMatchObject({ staff: 'Luis Gómez', amount: 300, method: 'BANK_TRANSFER', status: 'PAID' })
  })

  it('sin commissions:payout no ve nada aunque tenga commissions:read (spec §8, Codex r1-15)', async () => {
    mockHasPermission.mockImplementation((_acc: unknown, p: string) => p === 'commissions:read')
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.venuesInScope).toBe(0)
    expect(mockGroupBy).not.toHaveBeenCalled()
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('al consultar varias sedes, sólo lee las que tienen commissions:payout', async () => {
    const multi = {
      ...scope,
      allowedVenueIds: ['v1', 'v2'],
      perVenueAccess: new Map([
        ['v1', { role: 'OWNER' }],
        ['v2', { role: 'MANAGER' }],
      ]),
    } as unknown as McpScope
    const hs = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
    registerCommissionTools({ tool: (...a: unknown[]) => hs.set(a[0] as string, a[a.length - 1] as never) } as never, multi)
    mockHasPermission.mockImplementation((acc: { role: string }, p: string) => p === 'commissions:read' || acc.role === 'OWNER')
    mockGroupBy.mockResolvedValueOnce([])
    mockFindMany.mockResolvedValueOnce([])
    const out = parse(await hs.get('commission_payouts')!({}, {}))
    expect(out.venuesInScope).toBe(1)
    expect(mockGroupBy.mock.calls[0][0].where).toEqual({ venueId: { in: ['v1'] } })
  })
})
