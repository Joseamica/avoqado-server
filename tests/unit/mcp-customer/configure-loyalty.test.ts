import { registerLoyaltyTools } from '../../../src/mcp/tools/loyalty'
import type { McpScope } from '../../../src/mcp/scope'

const mockUpdate = jest.fn()
const mockGetConfig = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing loyalty:update')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  adjustPoints: jest.fn(),
  updateLoyaltyConfig: (...a: unknown[]) => mockUpdate(...(a as [])),
  getLoyaltyConfig: (...a: unknown[]) => mockGetConfig(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { loyaltyConfig: { findFirst: jest.fn() }, customer: { findMany: jest.fn() } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('configure_loyalty')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerLoyaltyTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('configure_loyalty (config write)', () => {
  it('rejects out-of-scope / no-perm / empty payload', async () => {
    await expect(call({ venueId: 'foreign', pointsPerDollar: 2 })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', pointsPerDollar: 2 })).rejects.toThrow('Forbidden')
    const empty = parse(await call({ venueId: 'v1' }))
    expect(empty.ok).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('without confirm → previews current → new (money economics), does NOT write', async () => {
    mockGetConfig.mockResolvedValueOnce({ pointsPerDollar: 1, redemptionRate: 0.01, minPointsRedeem: 100 })
    const out = parse(await call({ venueId: 'v1', redemptionRate: 100, pointsPerDollar: 50 }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.changes).toEqual(
      expect.arrayContaining([
        { label: 'Valor de 1 punto ($)', from: 0.01, to: 100 },
        { label: 'Puntos por $1', from: 1, to: 50 },
      ]),
    )
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('confirm:true passes only supplied fields (mapping minPointsToRedeem) and audits', async () => {
    mockUpdate.mockResolvedValueOnce({
      id: 'lc1',
      active: true,
      pointsPerDollar: 2,
      pointsPerVisit: 0,
      redemptionRate: 0.05,
      minPointsRedeem: 200,
      pointsExpireDays: null,
    })
    const out = parse(await call({ venueId: 'v1', pointsPerDollar: 2, redemptionRate: 0.05, minPointsToRedeem: 200, confirm: true }))

    expect(mockUpdate).toHaveBeenCalledWith('v1', { pointsPerDollar: 2, redemptionRate: 0.05, minPointsRedeem: 200 })
    expect(out).toMatchObject({
      ok: true,
      program: { pointsPerDollar: 2, redemptionRate: 0.05, minPointsToRedeem: 200, pointsExpireDays: null },
    })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'LOYALTY_CONFIG_UPDATED', venueId: 'v1' })
  })
})
