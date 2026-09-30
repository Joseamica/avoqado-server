import type { McpScope } from '@/mcp/scope'

const getPlanState = jest.fn()
jest.mock('@/services/dashboard/planState.service', () => ({ getPlanState: (...a: unknown[]) => getPlanState(...a) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: (scope: McpScope) => ({
    venueFilter: (id: string) => {
      if (!scope.allowedVenueIds.includes(id)) throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [id] } }
    },
    requirePermission: jest.fn(),
  }),
}))
import { registerPlanAdminTools } from '@/mcp/tools/planAdmin'

const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const tools = new Map<string, { desc: string; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>()
registerPlanAdminTools({ tool: (...a: any[]) => tools.set(a[0], { desc: a[1], handler: a[a.length - 1] }) } as never, scope)
const call = (venueId: string) => tools.get('get_venue_plan_status')!.handler({ venueId })
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeEach(() => jest.clearAllMocks())

describe('get_venue_plan_status', () => {
  it('rejects a venue outside the caller scope without reading the plan', async () => {
    await expect(call('foreign')).rejects.toThrow('out of scope')
    expect(getPlanState).not.toHaveBeenCalled()
  })

  it('a venue that pays Premium by contract answers with that origin, not «sin plan»', async () => {
    getPlanState.mockResolvedValue({
      hasPlan: false,
      state: 'none',
      planTier: null,
      trialEndsAt: null,
      grandfathered: false,
      origin: {
        kind: 'CONTRACT',
        tier: 'PREMIUM',
        price: { base: 1723.28, gross: 1999, currency: 'MXN' },
        interval: 'month',
        currentPeriodEnd: '2026-10-28T00:00:00.000Z',
        cancelAt: null,
        contractId: 'contract_1',
        contractRevision: 3,
        subscriptionId: 'sub_hybrid',
        paymentIssue: null,
      },
      pauseOfferEligible: false,
    })

    const result = parse(await call('v1'))

    expect(getPlanState).toHaveBeenCalledWith('v1')
    // Exactly these origin fields, money in pesos; the internal ones (revision, subscription, payment issue) stay out.
    expect(result.origin).toEqual({
      kind: 'CONTRACT',
      tier: 'PREMIUM',
      price: { base: 1723.28, gross: 1999, currency: 'MXN' },
      interval: 'month',
      currentPeriodEnd: '2026-10-28T00:00:00.000Z',
      cancelAt: null,
      contractId: 'contract_1',
    })
    expect(result.pauseOfferEligible).toBe(false)
    expect(result).toMatchObject({ venueId: 'v1', planTier: null, state: 'none' })
  })

  it('tells the assistant the plan can come from a subscription, a contract or a courtesy', () => {
    const desc = tools.get('get_venue_plan_status')!.desc
    expect(desc).toMatch(/suscripci/i)
    expect(desc).toMatch(/contrato/i)
    expect(desc).toMatch(/cortes/i)
  })
})
