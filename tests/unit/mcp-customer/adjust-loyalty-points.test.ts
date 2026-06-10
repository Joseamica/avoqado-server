import { registerLoyaltyTools } from '../../../src/mcp/tools/loyalty'
import type { McpScope } from '../../../src/mcp/scope'

const mockCustomerFind = jest.fn()
const mockAdjust = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing loyalty:adjust')
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({ adjustPoints: (...a: unknown[]) => mockAdjust(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    loyaltyConfig: { findFirst: jest.fn() },
    customer: { findMany: (...a: unknown[]) => mockCustomerFind(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('adjust_loyalty_points')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const ana = { id: 'c1', firstName: 'Ana', lastName: 'López', loyaltyPoints: 80 }

beforeAll(() => {
  registerLoyaltyTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('adjust_loyalty_points (critical write, confirm-gated)', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call({ venueId: 'foreign', search: 'ana', points: 10, reason: 'x' })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm', search: 'ana', points: 10, reason: 'x' })).rejects.toThrow('Forbidden')
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('without confirm: PREVIEWS the balance change and does NOT write', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana])
    const out = parse(await call({ venueId: 'v1', search: 'ana', points: 100, reason: 'compensación' }))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.preview).toEqual({ customer: 'Ana López', currentPoints: 80, change: 100, newBalance: 180, reason: 'compensación' })
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('blocks (even in preview) a change that would go negative', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana])
    const out = parse(await call({ venueId: 'v1', search: 'ana', points: -200, reason: 'x' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/-120/)
    expect(mockAdjust).not.toHaveBeenCalled()
  })

  it('with confirm:true: applies via the service and audits as customer-mcp', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana])
    mockAdjust.mockResolvedValueOnce({ newBalance: 180 })
    const out = parse(await call({ venueId: 'v1', search: 'ana', points: 100, reason: 'compensación', confirm: true }))

    expect(mockAdjust).toHaveBeenCalledWith('v1', 'c1', 100, 'compensación', 's1')
    expect(out).toMatchObject({ ok: true, customer: 'Ana López', change: 100, newBalance: 180 })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'LOYALTY_POINTS_ADJUSTED', entityId: 'c1', venueId: 'v1' })
  })

  it('rejects ambiguous matches and points=0 (no write)', async () => {
    mockCustomerFind.mockResolvedValueOnce([ana, { id: 'c2', firstName: 'Anabel', lastName: 'Ruiz', loyaltyPoints: 5 }])
    const amb = parse(await call({ venueId: 'v1', search: 'an', points: 10, reason: 'x' }))
    expect(amb.ambiguous).toBe(true)
    const zero = parse(await call({ venueId: 'v1', search: 'ana', points: 0, reason: 'x' }))
    expect(zero.ok).toBe(false)
    expect(mockAdjust).not.toHaveBeenCalled()
  })
})
