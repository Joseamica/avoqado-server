import { aggregateStaffTips, registerSalesTools } from '../../../src/mcp/tools/sales'
import type { McpScope } from '../../../src/mcp/scope'

// ── Pure aggregation helper ────────────────────────────────────────────────
// No mocks needed: aggregateStaffTips is pure (mirrors aggregateStaffCommission's test).
describe('aggregateStaffTips', () => {
  it('attributes each tip to the payment PROCESSOR (corte-de-caja rule), ranked by tips desc', () => {
    // Ana created the orders, but Fátima charged them on her session — the tip
    // follows the PROCESSOR, exactly like the cash-closeout report.
    const rows = [
      { tipAmount: 50, processedById: 'fatima', processedByName: 'Fatima Flores' },
      { tipAmount: '25.50', processedById: 'fatima', processedByName: 'Fatima Flores' },
      { tipAmount: 10, processedById: 'ana', processedByName: 'Ana Sofia Gonzalez' },
    ]

    const out = aggregateStaffTips(rows)

    expect(out.staff.map(s => s.staffId)).toEqual(['fatima', 'ana']) // 75.50 > 10
    expect(out.staff[0]).toEqual({ staffId: 'fatima', name: 'Fatima Flores', tips: 75.5, payments: 2 })
    expect(out.staff[1]).toEqual({ staffId: 'ana', name: 'Ana Sofia Gonzalez', tips: 10, payments: 1 })
    expect(out.total).toBe(85.5)
    expect(out.count).toBe(3)
    expect(out.unattributed).toEqual({ tips: 0, payments: 0 })
  })

  it('buckets processor-less payments (QR/self-serve/legacy) as unattributed but keeps them in the total', () => {
    const out = aggregateStaffTips([
      { tipAmount: 30, processedById: 'f', processedByName: 'F' },
      { tipAmount: 20, processedById: null, processedByName: null },
      { tipAmount: 5 }, // legacy shape without the fields at all
    ])

    expect(out.staff).toHaveLength(1)
    expect(out.unattributed).toEqual({ tips: 25, payments: 2 })
    expect(out.total).toBe(55) // == tips_over_time for the same window
  })

  it('counts only payments that actually carried a tip (mirrors summarizeTipsByDay)', () => {
    const out = aggregateStaffTips([
      { tipAmount: 0, processedById: 'f', processedByName: 'F' },
      { tipAmount: null, processedById: 'f', processedByName: 'F' },
      { tipAmount: 12.345, processedById: 'f', processedByName: 'F' },
    ])
    expect(out.staff).toEqual([{ staffId: 'f', name: 'F', tips: 12.35, payments: 1 }]) // rounded to cents
    expect(out.count).toBe(1)
  })

  it('returns empty shape for no rows', () => {
    expect(aggregateStaffTips([])).toEqual({ total: 0, count: 0, staff: [], unattributed: { tips: 0, payments: 0 } })
  })
})

// ── Tool handler (gating + wiring) ─────────────────────────────────────────
const mockFetchPayments = jest.fn()
const mockVenueFindUnique = jest.fn()
const mockPlanGate = jest.fn()
const mockRequirePermission = jest.fn()

// Avoid ts-jest compiling the huge access.service graph (imported transitively).
jest.mock('@/services/access/access.service', () => ({
  hasPermission: () => true,
  getUserAccess: jest.fn(),
  createAccessCache: jest.fn(() => ({})),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }
    },
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/legacy/mergedPayments.service', () => ({
  fetchPaymentsForAnalytics: (...a: unknown[]) => mockFetchPayments(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) },
  },
}))

type ZodLike = { safeParse: (v: unknown) => { success: boolean } }
const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const schemas = new Map<string, Record<string, ZodLike>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { role: 'OWNER' }]]),
} as unknown as McpScope
const call = (args: Record<string, unknown>) => handlers.get('staff_tips')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerSalesTools(
    {
      tool: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as never)
        schemas.set(a[0] as string, a[2] as never)
      },
    } as never,
    scope,
  )
})
beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null)
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

describe('staff_tips tool', () => {
  it('rejects a venue outside the caller scope (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockFetchPayments).not.toHaveBeenCalled()
  })

  it('hard-denies when the caller lacks analytics:read (permission gate)', async () => {
    mockRequirePermission.mockImplementationOnce(() => {
      throw new Error('ScopeError: Missing permission analytics:read for venue v1')
    })
    await expect(call({ venueId: 'v1' })).rejects.toThrow('analytics:read')
    expect(mockRequirePermission).toHaveBeenCalledWith('analytics:read', 'v1')
    expect(mockFetchPayments).not.toHaveBeenCalled()
  })

  it('rejects malformed and calendar-invalid dates at the schema layer', () => {
    const shape = schemas.get('staff_tips')!
    expect(shape.fromDate.safeParse('06/01/2026').success).toBe(false)
    expect(shape.fromDate.safeParse('2026-6-1').success).toBe(false)
    expect(shape.fromDate.safeParse('2026-06-01').success).toBe(true)
    expect(shape.toDate.safeParse('hoy').success).toBe(false)
    expect(shape.toDate.safeParse(undefined).success).toBe(true) // optional
    // Calendar validity — not just shape: Feb 30 would silently roll to Mar 2,
    // month 13 would throw RangeError deeper in the handler.
    expect(shape.fromDate.safeParse('2026-02-30').success).toBe(false)
    expect(shape.fromDate.safeParse('2026-13-01').success).toBe(false)
    expect(shape.fromDate.safeParse('2026-02-29').success).toBe(false) // 2026 is not a leap year
    expect(shape.fromDate.safeParse('2028-02-29').success).toBe(true) // 2028 is
  })

  it('gates on the ADVANCED_REPORTS plan (PRO) before touching payments', async () => {
    mockPlanGate.mockResolvedValue('Los reportes avanzados requieren plan PRO')
    const out = parse(await call({ venueId: 'v1' }))
    expect(out).toMatchObject({ ok: false, planRequired: true })
    expect(mockPlanGate).toHaveBeenCalledWith('v1', 'ADVANCED_REPORTS', expect.any(String))
    expect(mockFetchPayments).not.toHaveBeenCalled()
  })

  it('queries venue-local day boundaries (host-tz independent) and returns processor-attributed tips', async () => {
    mockFetchPayments.mockResolvedValue([
      { tipAmount: 50, processedById: 'fatima', processedByName: 'Fatima Flores' },
      { tipAmount: 20, processedById: null, processedByName: null }, // QR
    ])
    const out = parse(await call({ venueId: 'v1', fromDate: '2026-06-01', toDate: '2026-06-02' }))

    // Mexico City (UTC-6, no DST): jun-1 00:00 local → 06:00Z; jun-2 23:59:59.999 local → jun-3 05:59:59.999Z
    expect(out.window).toEqual({ from: '2026-06-01T06:00:00.000Z', to: '2026-06-03T05:59:59.999Z', timezone: 'America/Mexico_City' })
    const [, filters] = mockFetchPayments.mock.calls[0]
    expect(filters.fromDate.toISOString()).toBe('2026-06-01T06:00:00.000Z')
    expect(filters.toDate.toISOString()).toBe('2026-06-03T05:59:59.999Z')

    expect(out.staff).toEqual([{ staffId: 'fatima', name: 'Fatima Flores', tips: 50, payments: 1 }])
    expect(out.unattributed).toEqual({ tips: 20, payments: 1 })
    expect(out.total).toBe(70) // == tips_over_time for the same window
    expect(out.note).toContain('corte de caja')
  })

  it('staffId narrows the staff list but keeps the venue-wide total for context', async () => {
    mockFetchPayments.mockResolvedValue([
      { tipAmount: 50, processedById: 'fatima', processedByName: 'Fatima Flores' },
      { tipAmount: 10, processedById: 'ana', processedByName: 'Ana Sofia Gonzalez' },
    ])
    const out = parse(await call({ venueId: 'v1', staffId: 'ana' }))

    expect(out.staff).toEqual([{ staffId: 'ana', name: 'Ana Sofia Gonzalez', tips: 10, payments: 1 }])
    expect(out.total).toBe(60)
  })
})
