import type { SuperadminVenueSubscription, SubscriptionState } from '@/services/superadmin/subscription.service'

// The tool module imports the superadmin subscription service, which at module-eval
// constructs a Stripe client and pulls in the heavy basePlan graph. Mock it so this
// pure-helper test stays fast and isolated (mirrors how tools.test.ts mocks access.service).
jest.mock('@/services/superadmin/subscription.service', () => ({
  getVenueSubscription: jest.fn(),
}))
// The guard (imported transitively) drags in access.service; the pure fn doesn't use it.
jest.mock('@/services/access/access.service', () => ({
  hasPermission: () => true,
  getUserAccess: jest.fn(),
  createAccessCache: jest.fn(() => ({})),
}))

import { summarizeSubscriptions } from '../../../src/mcp/tools/subscriptions'

const row = (state: SubscriptionState, mrr: number, i = 0): SuperadminVenueSubscription => ({
  venueId: `v${i}`,
  name: `V${i}`,
  slug: `v${i}`,
  planTier: 'PRO',
  state,
  trialEndsAt: null,
  currentPeriodEnd: null,
  mrr,
  stripeSubscriptionId: null,
  owner: { name: null, email: null },
})

describe('summarizeSubscriptions', () => {
  it('empty venue list -> fully zeroed overview, MXN', () => {
    expect(summarizeSubscriptions([])).toEqual({
      counts: { active: 0, trial: 0, canceling: 0, past_due: 0, suspended: 0, canceled: 0, none: 0, total: 0 },
      mrrTotal: 0,
      currency: 'MXN',
    })
  })

  it('mixed states -> correct per-state counts + summed MRR', () => {
    const rows = [
      row('active', 1158.84, 0),
      row('active', 965.7, 1),
      row('trial', 0, 2),
      row('canceling', 500, 3),
      row('past_due', 0, 4),
      row('suspended', 0, 5),
      row('canceled', 0, 6),
      row('none', 0, 7),
    ]
    const s = summarizeSubscriptions(rows)

    expect(s.counts).toEqual({
      active: 2,
      trial: 1,
      canceling: 1,
      past_due: 1,
      suspended: 1,
      canceled: 1,
      none: 1,
      total: 8,
    })
    // 1158.84 + 965.70 + 500 = 2624.54, rounded to cents
    expect(s.mrrTotal).toBe(2624.54)
    expect(s.currency).toBe('MXN')
  })

  it('rounds floating-point MRR drift to cents', () => {
    const s = summarizeSubscriptions([row('active', 0.1, 0), row('active', 0.2, 1)])
    expect(s.mrrTotal).toBe(0.3) // not 0.30000000000000004
    expect(s.counts.active).toBe(2)
    expect(s.counts.total).toBe(2)
  })
})
