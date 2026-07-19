/**
 * delivery_channels (Task 12): Feature-gated MCP tool (DELIVERY_CHANNELS, PREMIUM) — mirrors
 * the dashboard's delivery-channels:read gate + the shared planGateMessage() helper (repo-wide
 * planRequired:true shape; Feature resolver underneath, NEVER the Module resolver — see
 * feature-gating.md). The basePlan.service mock below intercepts planGateMessage's resolver.
 */
import { registerDeliveryChannelTools } from '../../../src/mcp/tools/deliveryChannels'
import type { McpScope } from '../../../src/mcp/scope'

const mockHasFeatureAccess = jest.fn()
const mockLinkFindMany = jest.fn()
const mockOrderGroupBy = jest.fn()
const mockRequirePermission = jest.fn()
const mockVenueFindUnique = jest.fn()
const mockVenueStartOfDay = jest.fn()

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: (...a: unknown[]) => mockHasFeatureAccess(...(a as [])),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (...a: unknown[]) => mockRequirePermission(...(a as [])),
  }),
}))
// I1 fix: "today" boundary must resolve the VENUE's timezone (venueStartOfDay), never
// server/host tz (bare `setHours(0,0,0,0)` was UTC in prod → "today" leaked yesterday's
// dinner). Mocked deterministically here (repo pattern, see organizationDashboard test) —
// the real venueStartOfDay is unit-tested on its own in tests/unit/utils/datetime*.
jest.mock('@/utils/datetime', () => ({
  venueStartOfDay: (...a: unknown[]) => mockVenueStartOfDay(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    deliveryChannelLink: { findMany: (...a: unknown[]) => mockLinkFindMany(...(a as [])) },
    order: { groupBy: (...a: unknown[]) => mockOrderGroupBy(...(a as [])) },
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('delivery_channels')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerDeliveryChannelTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockVenueStartOfDay.mockReturnValue(new Date('2026-07-18T06:00:00.000Z'))
})

describe('delivery_channels', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockHasFeatureAccess).not.toHaveBeenCalled()
    expect(mockLinkFindMany).not.toHaveBeenCalled()
  })

  it('returns planRequired:true (repo-wide gate shape) and reads NOTHING when the venue lacks the feature', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(false)
    const out = parse(await call({ venueId: 'v1' }))

    expect(out.ok).toBe(false)
    expect(out.planRequired).toBe(true)
    expect(out.feature).toBe('DELIVERY_CHANNELS')
    expect(out.error).toMatch(/DELIVERY_CHANNELS/)
    expect(out.error).toMatch(/plan/)
    expect(mockHasFeatureAccess).toHaveBeenCalledWith('v1', 'DELIVERY_CHANNELS')
    expect(mockLinkFindMany).not.toHaveBeenCalled()
    expect(mockOrderGroupBy).not.toHaveBeenCalled()
  })

  it('enforces delivery-channels:read via the guard', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(false)
    await call({ venueId: 'v1' })
    expect(mockRequirePermission).toHaveBeenCalledWith('delivery-channels:read', 'v1')
  })

  it('lists channels + today-by-channel totals (Decimal -> pesos Number) when entitled', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockLinkFindMany.mockResolvedValueOnce([
      {
        id: 'link1',
        provider: 'UBER_EATS',
        status: 'ACTIVE',
        orderAcceptanceMode: 'AUTO',
        autoSyncMenu: true,
        lastMenuSyncAt: new Date('2026-07-18T10:00:00Z'),
        externalLocationId: 'loc-123',
      },
      {
        id: 'link2',
        provider: 'RAPPI',
        status: 'PAUSED',
        orderAcceptanceMode: 'MANUAL',
        autoSyncMenu: false,
        lastMenuSyncAt: null,
        externalLocationId: 'loc-456',
      },
    ])
    mockOrderGroupBy.mockResolvedValueOnce([
      // Prisma Decimal in real life; a plain number stands in fine since Number(x) is idempotent on it —
      // the point under test is that the value stays in PESOS major units (452.50), never *100 to cents.
      { source: 'UBER_EATS', _count: { id: 3 }, _sum: { total: 452.5 } },
      { source: 'RAPPI', _count: { id: 1 }, _sum: { total: 99 } },
    ])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.venueId).toBe('v1')
    expect(out.channels).toHaveLength(2)
    expect(out.channels[0]).toMatchObject({ id: 'link1', provider: 'UBER_EATS', status: 'ACTIVE' })
    expect(out.channels[0].lastMenuSyncAt).toBe('2026-07-18T10:00:00.000Z')
    expect(out.channels[1].lastMenuSyncAt).toBeNull()

    expect(out.todayByChannel).toEqual([
      { channel: 'UBER_EATS', orders: 3, totalPesos: 452.5 },
      { channel: 'RAPPI', orders: 1, totalPesos: 99 },
    ])
    // money stays in pesos major units, never cents
    expect(typeof out.todayByChannel[0].totalPesos).toBe('number')
  })

  it('handles zero delivery orders today (no groupBy rows) without throwing', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockLinkFindMany.mockResolvedValueOnce([])
    mockOrderGroupBy.mockResolvedValueOnce([])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.channels).toEqual([])
    expect(out.todayByChannel).toEqual([])
  })

  // ============================================================
  // I1 (IMPORTANT): "today" boundary must be the VENUE's local midnight, never host/server tz
  // ============================================================
  it('I1: resolves the "today" boundary via venueStartOfDay(venue.timezone) — never a bare host-tz setHours(0,0,0,0)', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: 'America/Cancun' })
    mockLinkFindMany.mockResolvedValueOnce([])
    mockOrderGroupBy.mockResolvedValueOnce([])

    await call({ venueId: 'v1' })

    expect(mockVenueFindUnique).toHaveBeenCalledWith({ where: { id: 'v1' }, select: { timezone: true } })
    expect(mockVenueStartOfDay).toHaveBeenCalledWith('America/Cancun')
    const groupByArg = mockOrderGroupBy.mock.calls[0][0] as { where: { createdAt: { gte: Date } } }
    expect(groupByArg.where.createdAt.gte).toBe(mockVenueStartOfDay.mock.results[0].value)
  })

  it('I1: falls back to America/Mexico_City when the venue has no timezone set (never crashes)', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockVenueFindUnique.mockResolvedValueOnce({ timezone: null })
    mockLinkFindMany.mockResolvedValueOnce([])
    mockOrderGroupBy.mockResolvedValueOnce([])

    await call({ venueId: 'v1' })

    expect(mockVenueStartOfDay).toHaveBeenCalledWith('America/Mexico_City')
  })

  it('I1: a venue lacking the feature never reaches the venue.findUnique call (reads NOTHING, gate short-circuits first)', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(false)
    await call({ venueId: 'v1' })
    expect(mockVenueFindUnique).not.toHaveBeenCalled()
  })
})
