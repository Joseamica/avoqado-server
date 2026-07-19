/**
 * delivery_activation_requests (Task 6, delivery-activation-backend): read-only MCP view of
 * DeliveryActivationRequest. listActivationRequests (Task 4) is cross-venue/cross-org BY DESIGN
 * (backs the superadmin ops REST queue) — the critical property under test here is that this
 * customer-facing tool NEVER leaks a row belonging to a venue outside the caller's scope, even
 * though the mocked service returns rows for other venues too.
 */
import { registerDeliveryActivationTools } from '../../../src/mcp/tools/deliveryActivation'
import type { McpScope } from '../../../src/mcp/scope'

const mockHasFeatureAccess = jest.fn()
const mockRequirePermission = jest.fn()
const mockListActivationRequests = jest.fn()

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: (...a: unknown[]) => mockHasFeatureAccess(...(a as [])),
}))
// hasPermission drives the all-venues filtering (multi-venue branch): only access objects
// flagged { canRead: true } pass — same shape/convention as activity-log.test.ts.
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (access: { canRead?: boolean } | undefined) => access?.canRead === true,
}))
jest.mock('@/services/delivery-channels/core/deliveryActivation.service', () => ({
  listActivationRequests: (...a: unknown[]) => mockListActivationRequests(...(a as [])),
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

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
// v1 has delivery-channels:read (canRead:true); v2 is in scope but LACKS it (canRead:false) —
// mirrors activity-log.test.ts's convention for testing the "expose only what scope permits" filter.
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1', 'v2'],
  perVenueAccess: new Map<string, { canRead: boolean }>([
    ['v1', { canRead: true }],
    ['v2', { canRead: false }],
  ]),
} as unknown as McpScope
const call = (args: Record<string, unknown>) => handlers.get('delivery_activation_requests')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'req-1',
  venueId: 'v1',
  venue: { name: 'Venue Uno', slug: 'venue-uno' },
  status: 'PENDING',
  requestedChannels: ['UBER_EATS', 'RAPPI'],
  note: 'Quiero activar cuanto antes',
  createdAt: new Date('2026-07-10T12:00:00Z'),
  contactedAt: null,
  connectedAt: null,
  ...overrides,
})

beforeAll(() => {
  registerDeliveryActivationTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('delivery_activation_requests', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockHasFeatureAccess).not.toHaveBeenCalled()
    expect(mockListActivationRequests).not.toHaveBeenCalled()
  })

  it('enforces delivery-channels:read via the guard for an explicit venueId', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockListActivationRequests.mockResolvedValueOnce([])
    await call({ venueId: 'v1' })
    expect(mockRequirePermission).toHaveBeenCalledWith('delivery-channels:read', 'v1')
  })

  it('returns planRequired:true (repo-wide gate shape) and reads NOTHING when the venue lacks DELIVERY_CHANNELS', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(false)
    const out = parse(await call({ venueId: 'v1' }))

    expect(out.ok).toBe(false)
    expect(out.planRequired).toBe(true)
    expect(out.feature).toBe('DELIVERY_CHANNELS')
    expect(out.error).toMatch(/DELIVERY_CHANNELS/)
    expect(mockHasFeatureAccess).toHaveBeenCalledWith('v1', 'DELIVERY_CHANNELS')
    expect(mockListActivationRequests).not.toHaveBeenCalled()
  })

  it("single-venue call: returns only that venue's requests, mapped to the response shape", async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockListActivationRequests.mockResolvedValueOnce([
      row(),
      row({ id: 'req-foreign', venueId: 'other-venue', venue: { name: 'Otro Venue', slug: 'otro-venue' } }),
    ])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.count).toBe(1)
    expect(out.requests).toEqual([
      {
        id: 'req-1',
        venueId: 'v1',
        venueName: 'Venue Uno',
        venueSlug: 'venue-uno',
        status: 'PENDING',
        requestedChannels: ['UBER_EATS', 'RAPPI'],
        note: 'Quiero activar cuanto antes',
        createdAt: '2026-07-10T12:00:00.000Z',
        contactedAt: null,
        connectedAt: null,
      },
    ])
  })

  it('passes the status filter through to listActivationRequests', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockListActivationRequests.mockResolvedValueOnce([])
    await call({ venueId: 'v1', status: 'CONTACTED' })
    expect(mockListActivationRequests).toHaveBeenCalledWith({ status: 'CONTACTED' })
  })

  it('serializes contactedAt/connectedAt when present', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockListActivationRequests.mockResolvedValueOnce([
      row({
        status: 'CONNECTED',
        contactedAt: new Date('2026-07-11T09:00:00Z'),
        connectedAt: new Date('2026-07-12T15:30:00Z'),
      }),
    ])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.requests[0].contactedAt).toBe('2026-07-11T09:00:00.000Z')
    expect(out.requests[0].connectedAt).toBe('2026-07-12T15:30:00.000Z')
  })

  // ============================================================
  // Cross-venue call (no venueId) — the "expose only what scope permits" branch
  // ============================================================
  describe('all-venues call (no venueId)', () => {
    it('never throws for a broad call — filters instead', async () => {
      mockHasFeatureAccess.mockResolvedValueOnce(true)
      mockListActivationRequests.mockResolvedValueOnce([])
      await expect(call({})).resolves.toBeDefined()
    })

    it('includes ONLY venues where the caller has delivery-channels:read AND the feature is entitled', async () => {
      mockHasFeatureAccess.mockResolvedValueOnce(true) // v1 entitled
      mockListActivationRequests.mockResolvedValueOnce([
        row({ id: 'req-v1', venueId: 'v1' }),
        row({ id: 'req-v2', venueId: 'v2', venue: { name: 'Venue Dos', slug: 'venue-dos' } }),
        row({ id: 'req-foreign', venueId: 'foreign-org-venue', venue: { name: 'Ajeno', slug: 'ajeno' } }),
      ])

      const out = parse(await call({}))

      // v2 lacks delivery-channels:read (canRead:false) and 'foreign-org-venue' is not even in
      // allowedVenueIds — neither may leak into the response despite listActivationRequests
      // (mocked as a cross-tenant ops query) returning both.
      expect(out.count).toBe(1)
      expect(out.requests.map((r: { id: string }) => r.id)).toEqual(['req-v1'])
      // Only the permitted venue (v1) is checked for feature entitlement — v2 never reaches it.
      expect(mockHasFeatureAccess).toHaveBeenCalledTimes(1)
      expect(mockHasFeatureAccess).toHaveBeenCalledWith('v1', 'DELIVERY_CHANNELS')
    })

    it('excludes a permitted venue that lacks the DELIVERY_CHANNELS feature entitlement', async () => {
      mockHasFeatureAccess.mockResolvedValueOnce(false) // v1 has the permission but not the plan
      const out = parse(await call({}))

      expect(out.count).toBe(0)
      expect(out.requests).toEqual([])
      expect(mockListActivationRequests).not.toHaveBeenCalled()
    })

    it('short-circuits with an empty result and NO DB read when zero venues qualify', async () => {
      const scopedEmpty = {
        staffId: 's1',
        activeOrg: 'o1',
        allowedVenueIds: ['v2'],
        perVenueAccess: new Map([['v2', { canRead: false }]]),
      } as unknown as McpScope
      const localHandlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
      registerDeliveryActivationTools(
        { tool: (...a: unknown[]) => localHandlers.set(a[0] as string, a[a.length - 1] as never) } as never,
        scopedEmpty,
      )

      const out = parse(await localHandlers.get('delivery_activation_requests')!({}, {}))

      expect(out).toEqual({ count: 0, requests: [] })
      expect(mockHasFeatureAccess).not.toHaveBeenCalled()
      expect(mockListActivationRequests).not.toHaveBeenCalled()
    })

    it('applies the status filter across the all-venues call too', async () => {
      mockHasFeatureAccess.mockResolvedValueOnce(true)
      mockListActivationRequests.mockResolvedValueOnce([])
      await call({ status: 'DISMISSED' })
      expect(mockListActivationRequests).toHaveBeenCalledWith({ status: 'DISMISSED' })
    })
  })

  it('response is text-content shaped', async () => {
    mockHasFeatureAccess.mockResolvedValueOnce(true)
    mockListActivationRequests.mockResolvedValueOnce([])
    const result = await call({ venueId: 'v1' })
    expect(result.content).toHaveLength(1)
    expect((result.content[0] as Record<string, unknown>).type).toBe('text')
    expect(typeof result.content[0].text).toBe('string')
  })
})
