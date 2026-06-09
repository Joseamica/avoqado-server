import { registerLoyaltyTools } from '../../../src/mcp/tools/loyalty'
import type { McpScope } from '../../../src/mcp/scope'

const mockFind = jest.fn()

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
  default: { loyaltyConfig: { findFirst: (...a: unknown[]) => mockFind(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('loyalty_status')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerLoyaltyTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('loyalty_status', () => {
  it('rejects a venue outside the caller scope', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockFind).not.toHaveBeenCalled()
  })

  it('returns the program settings when configured', async () => {
    mockFind.mockResolvedValueOnce({
      active: true,
      pointsPerDollar: 2,
      pointsPerVisit: 10,
      redemptionRate: 0.05,
      minPointsRedeem: 100,
      pointsExpireDays: 365,
    })
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.configured).toBe(true)
    expect(out.program).toEqual({
      active: true,
      pointsPerDollar: 2,
      pointsPerVisit: 10,
      redemptionRate: 0.05,
      minPointsToRedeem: 100,
      pointsExpireDays: 365,
    })
  })

  it('returns configured:false / program:null when no program exists (read never creates one)', async () => {
    mockFind.mockResolvedValueOnce(null)
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.configured).toBe(false)
    expect(out.program).toBeNull()
  })
})
