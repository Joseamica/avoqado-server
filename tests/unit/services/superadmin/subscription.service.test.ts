import { monthlyMrrFromPrice, buildOverviewCounts } from '@/services/superadmin/subscription.service'
import type { SuperadminVenueSubscription } from '@/services/superadmin/subscription.service'
import { prismaMock } from '../../../__helpers__/setup'
import {
  getSubscriptionsForSuperadmin,
  getSubscriptionOverview,
  adjustVenuePlanEndDate,
  getVenueSubscription,
} from '@/services/superadmin/subscription.service'

// Stripe is mocked module-wide; resolve subs/prices deterministically.
jest.mock('stripe')

describe('monthlyMrrFromPrice', () => {
  it('monthly price: cents → pesos as-is', () => {
    expect(monthlyMrrFromPrice({ unit_amount: 115884, recurring: { interval: 'month', interval_count: 1 } })).toBe(1158.84)
  })
  it('annual price: divides by 12', () => {
    // 11588.40 / yr → 965.70 / mo
    expect(monthlyMrrFromPrice({ unit_amount: 1158840, recurring: { interval: 'year', interval_count: 1 } })).toBeCloseTo(965.7, 2)
  })
  it('multi-month interval normalizes by interval_count', () => {
    // 3-month price of $300 → $100/mo
    expect(monthlyMrrFromPrice({ unit_amount: 30000, recurring: { interval: 'month', interval_count: 3 } })).toBe(100)
  })
  it('returns 0 for null/odd input', () => {
    expect(monthlyMrrFromPrice(null)).toBe(0)
    expect(monthlyMrrFromPrice({ unit_amount: null, recurring: { interval: 'month', interval_count: 1 } })).toBe(0)
  })
})

describe('buildOverviewCounts', () => {
  const rows = (states: SuperadminVenueSubscription['state'][]): SuperadminVenueSubscription[] =>
    states.map((state, i) => ({
      venueId: `v${i}`,
      name: `V${i}`,
      slug: `v${i}`,
      planTier: 'PRO',
      state,
      trialEndsAt: null,
      currentPeriodEnd: null,
      mrr: state === 'active' || state === 'trial' ? 1000 : 0,
      stripeSubscriptionId: null,
      owner: { name: null, email: null },
    }))

  it('tallies each state + total', () => {
    const c = buildOverviewCounts(rows(['active', 'active', 'trial', 'suspended', 'none', 'canceling']))
    expect(c).toMatchObject({ active: 2, trial: 1, suspended: 1, none: 1, canceling: 1, past_due: 0, canceled: 0, total: 6 })
  })
  it('empty fleet → all zeros', () => {
    expect(buildOverviewCounts([])).toEqual({
      active: 0,
      trial: 0,
      canceling: 0,
      past_due: 0,
      suspended: 0,
      canceled: 0,
      none: 0,
      total: 0,
    })
  })
})

const future = new Date(Date.now() + 5 * 86400_000)

function venueRow(over: Partial<any> = {}) {
  return {
    id: 'cven1',
    name: 'Lagree HQ',
    slug: 'lagree-hq',
    planTier: 'PRO',
    features: [
      {
        active: true,
        endDate: null,
        suspendedAt: null,
        gracePeriodEndsAt: null,
        stripeSubscriptionId: 'sub_1',
        stripePriceId: 'price_m',
        monthlyPrice: { toString: () => '1158.84' },
      },
    ],
    staff: [{ role: 'OWNER', staff: { firstName: 'Ana', lastName: 'Ruiz', email: 'ana@x.mx' } }],
    ...over,
  }
}

describe('getSubscriptionsForSuperadmin', () => {
  beforeEach(() => {
    prismaMock.venue.findMany.mockResolvedValue([venueRow()])
    prismaMock.venue.count.mockResolvedValue(1)
    // Stripe sub: active, monthly, current_period_end in 30d
    const Stripe = require('stripe')
    Stripe.prototype.subscriptions = {
      retrieve: jest.fn().mockResolvedValue({
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: Math.floor(future.getTime() / 1000),
        items: { data: [{ price: { id: 'price_m', unit_amount: 115884, recurring: { interval: 'month', interval_count: 1 } } }] },
      }),
    }
  })

  it('maps a venue with active PLAN_PRO to state=active + MRR from Stripe price', async () => {
    const { items, total } = await getSubscriptionsForSuperadmin({ page: 1, pageSize: 25 })
    expect(total).toBe(1)
    expect(items[0]).toMatchObject({
      venueId: 'cven1',
      name: 'Lagree HQ',
      planTier: 'PRO',
      state: 'active',
      mrr: 1158.84,
      stripeSubscriptionId: 'sub_1',
      owner: { name: 'Ana Ruiz', email: 'ana@x.mx' },
    })
  })

  it('filters by state (server re-derives, then filters)', async () => {
    const { items } = await getSubscriptionsForSuperadmin({ page: 1, pageSize: 25, state: 'suspended' })
    expect(items).toHaveLength(0) // the one venue is active
  })

  it('venue with NO PLAN_PRO feature → state=none, mrr=0, currentPeriodEnd=null', async () => {
    prismaMock.venue.findMany.mockResolvedValue([venueRow({ features: [] })])
    const { items } = await getSubscriptionsForSuperadmin({ page: 1, pageSize: 25 })
    expect(items[0]).toMatchObject({ state: 'none', mrr: 0, currentPeriodEnd: null, stripeSubscriptionId: null })
  })

  it('DB-only trial (no Stripe sub) → MRR from VenueFeature.monthlyPrice', async () => {
    prismaMock.venue.findMany.mockResolvedValue([
      venueRow({
        features: [
          {
            active: true,
            endDate: future,
            suspendedAt: null,
            gracePeriodEndsAt: null,
            stripeSubscriptionId: null,
            stripePriceId: null,
            monthlyPrice: { toString: () => '1158.84' },
          },
        ],
      }),
    ])
    const { items } = await getSubscriptionsForSuperadmin({ page: 1, pageSize: 25 })
    expect(items[0]).toMatchObject({ state: 'trial', mrr: 1158.84, stripeSubscriptionId: null, currentPeriodEnd: null })
    expect(items[0].trialEndsAt).toBe(future.toISOString())
  })
})

describe('getSubscriptionOverview', () => {
  it('aggregates counts + total MRR + trialsEndingSoon', async () => {
    prismaMock.venue.findMany.mockResolvedValue([
      venueRow(), // active, mrr 1158.84 (Stripe mock from beforeEach is per-describe; re-stub here)
    ])
    const Stripe = require('stripe')
    Stripe.prototype.subscriptions = {
      retrieve: jest.fn().mockResolvedValue({
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: Math.floor(future.getTime() / 1000),
        items: { data: [{ price: { id: 'price_m', unit_amount: 115884, recurring: { interval: 'month', interval_count: 1 } } }] },
      }),
    }
    const ov = await getSubscriptionOverview()
    expect(ov.counts.active).toBe(1)
    expect(ov.counts.total).toBe(1)
    expect(ov.mrr).toEqual({ total: 1158.84, currency: 'MXN' })
  })

  it('annual subscription normalizes into MRR (annual/12)', async () => {
    prismaMock.venue.findMany.mockResolvedValue([
      venueRow({
        features: [
          {
            active: true,
            endDate: null,
            suspendedAt: null,
            gracePeriodEndsAt: null,
            stripeSubscriptionId: 'sub_y',
            stripePriceId: 'price_y',
            monthlyPrice: { toString: () => '0' },
          },
        ],
      }),
    ])
    const Stripe = require('stripe')
    Stripe.prototype.subscriptions = {
      retrieve: jest.fn().mockResolvedValue({
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: Math.floor(future.getTime() / 1000),
        items: { data: [{ price: { id: 'price_y', unit_amount: 1158840, recurring: { interval: 'year', interval_count: 1 } } }] },
      }),
    }
    const ov = await getSubscriptionOverview()
    expect(ov.mrr.total).toBeCloseTo(965.7, 1)
  })
})

describe('getVenueSubscription', () => {
  beforeEach(() => {
    const Stripe = require('stripe')
    Stripe.prototype.subscriptions = {
      retrieve: jest.fn().mockResolvedValue({
        status: 'active',
        cancel_at_period_end: false,
        current_period_end: Math.floor(future.getTime() / 1000),
        items: { data: [{ price: { id: 'price_m', unit_amount: 115884, recurring: { interval: 'month', interval_count: 1 } } }] },
      }),
    }
  })

  it('maps a single venue using the same mapping as the list', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(venueRow())
    const row = await getVenueSubscription('cven1')
    expect(row).toMatchObject({
      venueId: 'cven1',
      name: 'Lagree HQ',
      planTier: 'PRO',
      state: 'active',
      mrr: 1158.84,
      stripeSubscriptionId: 'sub_1',
      owner: { name: 'Ana Ruiz', email: 'ana@x.mx' },
    })
  })

  it('returns null when venue does not exist', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(null)
    expect(await getVenueSubscription('nope')).toBeNull()
  })
})

describe('adjustVenuePlanEndDate', () => {
  // Fixed base so the +/- assertion is deterministic regardless of wall clock.
  const baseEnd = new Date('2026-06-30T00:00:00.000Z')

  beforeEach(() => {
    const Stripe = require('stripe')
    // DB-only plan (no Stripe sub) keeps mapping deterministic — state derived from endDate.
    Stripe.prototype.subscriptions = { retrieve: jest.fn() }
  })

  function planVenueRow(endDate: Date | null) {
    return venueRow({
      features: [
        {
          active: true,
          endDate,
          suspendedAt: null,
          gracePeriodEndsAt: null,
          stripeSubscriptionId: null,
          stripePriceId: null,
          monthlyPrice: { toString: () => '1158.84' },
        },
      ],
    })
  }

  it('extends the plan by +N days and returns the updated row', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue({ id: 'vf1', endDate: baseEnd })
    prismaMock.venueFeature.update.mockResolvedValue({ id: 'vf1' })
    // After the update, the single-venue fetch reflects the new endDate (+10d).
    const newEnd = new Date('2026-07-10T00:00:00.000Z')
    prismaMock.venue.findFirst.mockResolvedValue(planVenueRow(newEnd))

    const row = await adjustVenuePlanEndDate('cven1', 10)

    expect(prismaMock.venueFeature.update).toHaveBeenCalledWith({
      where: { id: 'vf1' },
      data: { endDate: newEnd },
    })
    expect(row?.trialEndsAt).toBe(newEnd.toISOString())
  })

  it('removes days with a negative delta', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue({ id: 'vf1', endDate: baseEnd })
    prismaMock.venueFeature.update.mockResolvedValue({ id: 'vf1' })
    const newEnd = new Date('2026-06-23T00:00:00.000Z') // -7 days
    prismaMock.venue.findFirst.mockResolvedValue(planVenueRow(newEnd))

    await adjustVenuePlanEndDate('cven1', -7)

    expect(prismaMock.venueFeature.update).toHaveBeenCalledWith({
      where: { id: 'vf1' },
      data: { endDate: newEnd },
    })
  })

  it('falls back to now() as the base when endDate is null', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue({ id: 'vf1', endDate: null })
    prismaMock.venueFeature.update.mockResolvedValue({ id: 'vf1' })
    prismaMock.venue.findFirst.mockResolvedValue(planVenueRow(new Date()))

    await adjustVenuePlanEndDate('cven1', 5)

    const arg = prismaMock.venueFeature.update.mock.calls[0][0]
    const days = Math.round((arg.data.endDate.getTime() - Date.now()) / 86400_000)
    expect(days).toBe(5)
  })

  it('throws BadRequestError when the venue has no PLAN_PRO feature', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue(null)
    await expect(adjustVenuePlanEndDate('cven1', 10)).rejects.toThrow('El venue no tiene un plan PLAN_PRO')
    expect(prismaMock.venueFeature.update).not.toHaveBeenCalled()
  })
})
