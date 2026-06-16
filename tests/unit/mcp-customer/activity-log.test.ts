import { registerActivityLogTools } from '../../../src/mcp/tools/activity-log'
import type { McpScope } from '../../../src/mcp/scope'

const mockFindMany = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }
    },
    requirePermission: jest.fn(),
  }),
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
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('get_activity_log')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerActivityLogTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('get_activity_log', () => {
  it('returns logs scoped to the requested venue', async () => {
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

  it('returns logs for all venues when no venueId is given', async () => {
    mockFindMany.mockResolvedValueOnce([])
    await call({ limit: 5 })
    const whereArg = (mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(whereArg).toEqual({ venueId: { in: ['v1'] } })
  })

  it('applies action filter when provided', async () => {
    mockFindMany.mockResolvedValueOnce([])
    await call({ action: 'SIM_CUSTODY_ASSIGNED_TO_PROMOTER', limit: 25 })
    const whereArg = (mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(whereArg.action).toBe('SIM_CUSTODY_ASSIGNED_TO_PROMOTER')
  })

  it('applies date range filter when startDate and endDate are given', async () => {
    mockFindMany.mockResolvedValueOnce([])
    await call({ startDate: '2026-06-01', endDate: '2026-06-15', limit: 25 })
    const whereArg = (mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(whereArg.createdAt).toMatchObject({
      gte: new Date('2026-06-01'),
      lte: new Date('2026-06-15'),
    })
  })

  it('throws when the requested venueId is outside the caller scope (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign', limit: 10 })).rejects.toThrow('out of scope')
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
