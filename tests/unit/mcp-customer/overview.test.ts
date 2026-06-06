import { registerOverviewTools } from '../../../src/mcp/tools/overview'
import type { McpScope } from '../../../src/mcp/scope'

const mockVenueFind = jest.fn()
const mockPaymentAgg = jest.fn()
const mockOrderAgg = jest.fn()
const mockInventoryFind = jest.fn()
const mockShiftCount = jest.fn()
const mockReservationCount = jest.fn()
const mockReservationFirst = jest.fn()

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
    venue: { findUnique: (...a: unknown[]) => mockVenueFind(...(a as [])) },
    payment: { aggregate: (...a: unknown[]) => mockPaymentAgg(...(a as [])) },
    order: { aggregate: (...a: unknown[]) => mockOrderAgg(...(a as [])) },
    inventory: { findMany: (...a: unknown[]) => mockInventoryFind(...(a as [])) },
    shift: { count: (...a: unknown[]) => mockShiftCount(...(a as [])) },
    reservation: {
      count: (...a: unknown[]) => mockReservationCount(...(a as [])),
      findFirst: (...a: unknown[]) => mockReservationFirst(...(a as [])),
    },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('today_overview')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerOverviewTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('today_overview', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockPaymentAgg).not.toHaveBeenCalled()
  })

  it('composes today sales, open tabs, low-stock (in-memory), shifts and reservations into one snapshot', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City', name: 'Centro' })
    mockPaymentAgg.mockResolvedValueOnce({ _sum: { amount: 12500.5, tipAmount: 980 }, _count: { _all: 42 } })
    mockOrderAgg.mockResolvedValueOnce({ _sum: { remainingBalance: 1340 }, _count: { _all: 3 } })
    mockInventoryFind.mockResolvedValueOnce([
      { currentStock: 2, minimumStock: 5 }, // low
      { currentStock: 5, minimumStock: 5 }, // low (at minimum)
      { currentStock: 20, minimumStock: 5 }, // ok
    ])
    mockShiftCount.mockResolvedValueOnce(1)
    mockReservationCount.mockResolvedValueOnce(4)
    mockReservationFirst.mockResolvedValueOnce({
      startsAt: new Date('2026-06-06T20:00:00Z'),
      partySize: 2,
      guestName: 'Ana',
      confirmationCode: 'XYZ9',
    })

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.venue).toBe('Centro')
    expect(out.salesToday).toEqual({ gross: 12500.5, tips: 980, payments: 42 })
    expect(out.openTabs).toEqual({ count: 3, owed: 1340 })
    expect(out.lowStockItems).toBe(2) // only the two at/below minimum
    expect(out.openShifts).toBe(1)
    expect(out.reservationsToday.count).toBe(4)
    expect(out.reservationsToday.next).toMatchObject({ partySize: 2, guest: 'Ana', code: 'XYZ9' })
  })

  it('handles an empty venue (no sales, no tabs, no next reservation) without NaN/null crashes', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City', name: 'Nuevo' })
    mockPaymentAgg.mockResolvedValueOnce({ _sum: { amount: null, tipAmount: null }, _count: { _all: 0 } })
    mockOrderAgg.mockResolvedValueOnce({ _sum: { remainingBalance: null }, _count: { _all: 0 } })
    mockInventoryFind.mockResolvedValueOnce([])
    mockShiftCount.mockResolvedValueOnce(0)
    mockReservationCount.mockResolvedValueOnce(0)
    mockReservationFirst.mockResolvedValueOnce(null)

    const out = parse(await call({ venueId: 'v1' }))
    expect(out.salesToday).toEqual({ gross: 0, tips: 0, payments: 0 })
    expect(out.openTabs).toEqual({ count: 0, owed: 0 })
    expect(out.lowStockItems).toBe(0)
    expect(out.reservationsToday.next).toBeNull()
  })
})
