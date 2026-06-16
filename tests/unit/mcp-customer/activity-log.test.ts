import { registerActivityLogTools } from '../../../src/mcp/tools/activity-log'
import type { McpScope } from '../../../src/mcp/scope'

const mockFindMany = jest.fn()

// Guard: requirePermission throws unless the venue is 'v1' (the only one the caller may audit).
// This models BOTH out-of-scope and lacking-activity:read for an explicitly requested venue.
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    requirePermission: (_perm: string, venueId: string) => {
      if (venueId !== 'v1') throw new Error(`Missing permission activity:read for venue ${venueId}`)
    },
  }),
}))
// hasPermission drives the all-venues filtering: only access objects flagged { canRead: true } pass.
jest.mock('@/services/access/access.service', () => ({
  hasPermission: (access: { canRead?: boolean } | undefined) => access?.canRead === true,
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    activityLog: {
      findMany: (...a: unknown[]) => mockFindMany(...(a as [])),
    },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
// v1 has activity:read; v2 is in scope but LACKS it (canRead:false).
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1', 'v2'],
  perVenueAccess: new Map<string, { canRead: boolean }>([
    ['v1', { canRead: true }],
    ['v2', { canRead: false }],
  ]),
} as unknown as McpScope
const call = (args: Record<string, unknown>) => handlers.get('get_activity_log')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerActivityLogTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('get_activity_log', () => {
  it('returns logs scoped to the requested venue (caller has activity:read)', async () => {
    mockFindMany.mockResolvedValueOnce([
      {
        id: 'log-1',
        action: 'PAYMENT_COMPLETED',
        entity: 'Payment',
        entityId: 'pay-1',
        data: { amount: 500 },
        createdAt: new Date('2026-06-15T18:00:00Z'),
        venueId: 'v1',
        staff: { firstName: 'Ana', lastName: 'Lopez' },
      },
    ])

    const out = parse(await call({ venueId: 'v1', limit: 10 }))

    const whereArg = (mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(whereArg).toMatchObject({ venueId: { in: ['v1'] } })
    expect(out.count).toBe(1)
    expect(out.logs[0].action).toBe('PAYMENT_COMPLETED')
    expect(out.logs[0].staff).toEqual({ firstName: 'Ana', lastName: 'Lopez' })
  })

  it('all-venues query returns ONLY venues where the caller has activity:read', async () => {
    mockFindMany.mockResolvedValueOnce([])
    await call({ limit: 5 })
    const whereArg = (mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    // v2 is in scope but lacks activity:read → excluded. Only v1 remains.
    expect(whereArg).toEqual({ venueId: { in: ['v1'] } })
  })

  it('applies action filter when provided', async () => {
    mockFindMany.mockResolvedValueOnce([])
    await call({ action: 'SIM_CUSTODY_ASSIGNED_TO_PROMOTER', limit: 25 })
    const whereArg = (mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(whereArg.action).toBe('SIM_CUSTODY_ASSIGNED_TO_PROMOTER')
  })

  it('applies a venue-tz date range filter (parsed as Dates, not host-tz bare dates)', async () => {
    mockFindMany.mockResolvedValueOnce([])
    await call({ venueId: 'v1', startDate: '2026-06-01', endDate: '2026-06-15', limit: 25 })
    const whereArg = (mockFindMany.mock.calls[0][0] as { where: { createdAt: { gte: Date; lte: Date } } }).where
    expect(whereArg.createdAt.gte).toBeInstanceOf(Date)
    expect(whereArg.createdAt.lte).toBeInstanceOf(Date)
    // America/Mexico_City is UTC-6 → 2026-06-01 local 00:00 = 06:00Z (NOT 00:00Z, which the old bare-date bug produced)
    expect(whereArg.createdAt.gte.toISOString()).toBe('2026-06-01T06:00:00.000Z')
  })

  it('throws for an explicit venueId the caller cannot audit (out-of-scope OR no activity:read)', async () => {
    await expect(call({ venueId: 'v2', limit: 10 })).rejects.toThrow('Missing permission activity:read')
    await expect(call({ venueId: 'foreign', limit: 10 })).rejects.toThrow('Missing permission activity:read')
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('response is text-content shaped', async () => {
    mockFindMany.mockResolvedValueOnce([])
    const result = await call({ limit: 1 })
    expect(result.content).toHaveLength(1)
    expect((result.content[0] as Record<string, unknown>).type).toBe('text')
    expect(typeof result.content[0].text).toBe('string')
  })
})
