import { aggregateStaffCommission, registerCommissionTools } from '../../../src/mcp/tools/commissions'
import type { McpScope } from '../../../src/mcp/scope'

// ── Pure aggregation helper ────────────────────────────────────────────────
// No mocks needed: aggregateStaffCommission is pure (mirrors formatScheme's test).
describe('aggregateStaffCommission', () => {
  it("reproduces Ana Sofía's real June commission: $1,340 base at 3% = $40.20 (Lagree + Merch)", () => {
    // These are the REAL engine rows (CommissionCalculation) — the source of truth.
    const rows = [
      {
        staffId: 'ana',
        staff: { firstName: 'Ana Sofia', lastName: 'Gonzalez' },
        configId: 'cfg-lagree',
        config: { name: 'Lagree + Merch', calcType: 'PERCENTAGE' },
        baseAmount: '960.00',
        grossCommission: '28.80',
        netCommission: '28.80',
        effectiveRate: '0.0300',
        tier: null,
        tierName: null,
        status: 'AGGREGATED',
      },
      {
        staffId: 'ana',
        staff: { firstName: 'Ana Sofia', lastName: 'Gonzalez' },
        configId: 'cfg-lagree',
        config: { name: 'Lagree + Merch', calcType: 'PERCENTAGE' },
        baseAmount: '380.00',
        grossCommission: '11.40',
        netCommission: '11.40',
        effectiveRate: '0.0300',
        tier: null,
        tierName: null,
        status: 'AGGREGATED',
      },
    ]

    const [ana] = aggregateStaffCommission(rows as never)

    expect(ana.name).toBe('Ana Sofia Gonzalez')
    expect(ana.totalBase).toBe(1340) // Lagree 380 + Merch 960 — NOT the $7,512.50 sales figure
    expect(ana.totalCommission).toBe(40.2) // the truth, not the $329.30 the model guessed
    expect(ana.count).toBe(2)
    expect(ana.byStatus).toEqual({ AGGREGATED: 2 })
    expect(ana.byScheme).toHaveLength(1)
    expect(ana.byScheme[0]).toMatchObject({ config: 'Lagree + Merch', base: 1340, commission: 40.2, count: 2 })
    // Per-rate breakdown proves which rate hit which base — replaces the model's freehand math.
    expect(ana.byScheme[0].byRate).toEqual([{ rate: 0.03, tier: null, tierName: null, count: 2, base: 1340, commission: 40.2 }])
  })

  it('groups a tiered scheme by rate/tier and ranks staff by total commission desc', () => {
    const rows = [
      // Staff A: tiered scheme, two tiers hit
      {
        staffId: 'a',
        staff: { firstName: 'A', lastName: '' },
        configId: 'cT',
        config: { name: 'Hidrógeno + Iyashi', calcType: 'TIERED' },
        baseAmount: '20000.00',
        grossCommission: '800.00',
        netCommission: '800.00',
        effectiveRate: '0.0400',
        tier: 1,
        tierName: '4% (0 a 30k)',
        status: 'CALCULATED',
      },
      {
        staffId: 'a',
        staff: { firstName: 'A', lastName: '' },
        configId: 'cT',
        config: { name: 'Hidrógeno + Iyashi', calcType: 'TIERED' },
        baseAmount: '5000.00',
        grossCommission: '300.00',
        netCommission: '300.00',
        effectiveRate: '0.0600',
        tier: 2,
        tierName: '6% (30k a meta)',
        status: 'CALCULATED',
      },
      // Staff B: smaller flat
      {
        staffId: 'b',
        staff: { firstName: 'B', lastName: '' },
        configId: 'cF',
        config: { name: 'Lagree + Merch', calcType: 'PERCENTAGE' },
        baseAmount: '1000.00',
        grossCommission: '30.00',
        netCommission: '30.00',
        effectiveRate: '0.0300',
        tier: null,
        tierName: null,
        status: 'CALCULATED',
      },
    ]

    const out = aggregateStaffCommission(rows as never)

    expect(out.map(s => s.staffId)).toEqual(['a', 'b']) // ranked by totalCommission desc (1100 > 30)
    const a = out[0]
    expect(a.totalCommission).toBe(1100)
    expect(a.byScheme[0].byRate).toEqual([
      { rate: 0.04, tier: 1, tierName: '4% (0 a 30k)', count: 1, base: 20000, commission: 800 },
      { rate: 0.06, tier: 2, tierName: '6% (30k a meta)', count: 1, base: 5000, commission: 300 },
    ])
  })

  it('returns [] for no rows', () => {
    expect(aggregateStaffCommission([])).toEqual([])
  })
})

// ── Tool handler (gating + DB wiring) ──────────────────────────────────────
const mockFindMany = jest.fn()
const mockVenueFindUnique = jest.fn()
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
jest.mock('@/services/access/basePlan.service', () => ({
  venuesWithCommissionsAccess: (...a: unknown[]) => mockVenuesWithCommissionsAccess(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    commissionCalculation: { findMany: (...a: unknown[]) => mockFindMany(...(a as [])) },
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { role: 'OWNER' }]]),
} as unknown as McpScope
const call = (args: Record<string, unknown>) => handlers.get('staff_commission')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCommissionTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockVenuesWithCommissionsAccess.mockImplementation(async (ids: string[]) => new Set(ids))
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

describe('staff_commission tool', () => {
  it('rejects a venue outside the caller scope (cross-tenant guard)', async () => {
    mockHasPermission.mockReturnValue(true)
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('reads nothing when the caller lacks commissions:read', async () => {
    mockHasPermission.mockReturnValue(false)
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.venuesInScope).toBe(0)
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('reads nothing when the venue plan/module does not include commissions', async () => {
    mockHasPermission.mockReturnValue(true)
    mockVenuesWithCommissionsAccess.mockResolvedValue(new Set())
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.venuesInScope).toBe(0)
    expect(out.note).toContain('plan/módulo')
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('excludes voided calcs, filters by staff, and returns engine-truth totals', async () => {
    mockHasPermission.mockReturnValue(true)
    mockFindMany.mockResolvedValueOnce([
      {
        staffId: 'ana',
        staff: { firstName: 'Ana Sofia', lastName: 'Gonzalez' },
        configId: 'cfg',
        config: { name: 'Lagree + Merch', calcType: 'PERCENTAGE' },
        baseAmount: '1340.00',
        grossCommission: '40.20',
        netCommission: '40.20',
        effectiveRate: '0.0300',
        tier: null,
        tierName: null,
        status: 'AGGREGATED',
      },
    ])
    const out = parse(await call({ venueId: 'v1', staffId: 'ana' }))

    // voided rows are excluded at the query level
    expect(mockFindMany).toHaveBeenCalledTimes(1)
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.voidedAt).toBeNull()
    expect(where.staffId).toBe('ana')
    expect(where.venueId).toEqual({ in: ['v1'] })
    expect(where.calculatedAt).toHaveProperty('gte')
    expect(where.calculatedAt).toHaveProperty('lte')

    expect(out.staff[0].totalCommission).toBe(40.2)
    expect(out.window.timezone).toBe('America/Mexico_City')
    expect(out.note).toMatch(/motor real|CommissionCalculation/i)
  })

  it('honors an explicit venue-local date range', async () => {
    mockHasPermission.mockReturnValue(true)
    mockFindMany.mockResolvedValueOnce([])
    const out = parse(await call({ venueId: 'v1', fromDate: '2026-06-01', toDate: '2026-06-30' }))
    expect(out.staff).toEqual([])
    const range = mockFindMany.mock.calls[0][0].where.calculatedAt
    // America/Mexico_City is UTC-6: Jun 1 00:00 local -> 06:00Z; Jun 30 end-of-day -> Jul 1 05:59:59Z
    expect(range.gte.toISOString()).toBe('2026-06-01T06:00:00.000Z')
    expect(range.lte.toISOString()).toBe('2026-07-01T05:59:59.999Z')
  })
})
