import { PlanRenewalReminderJob } from '@/jobs/plan-renewal-reminder.job'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import * as planNotification from '@/services/access/planNotification.service'

// Make retry transparent: just invoke the wrapped fn (deterministic, no backoff).
jest.mock('@/utils/retry', () => ({
  __esModule: true,
  retry: (fn: () => unknown) => fn(),
  shouldRetryDbConnectionError: jest.fn(),
}))

// Stripe is constructed at module load (`new Stripe(...)`). Mock the constructor so
// `stripe.subscriptions.retrieve` is a controllable jest fn. The fn is created
// INSIDE the factory (jest hoists the factory above imports) and re-exposed on the
// mock constructor so the test body can drive it.
jest.mock('stripe', () => {
  const retrieve = jest.fn()
  const ctor = jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve },
  })) as jest.Mock & { __retrieve: jest.Mock }
  ctor.__retrieve = retrieve
  return ctor
})

const mockRetrieve = (require('stripe') as jest.Mock & { __retrieve: jest.Mock }).__retrieve

jest.mock('@/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn(),
}))

const mockPrisma = prisma as unknown as {
  venueFeature: { findMany: jest.Mock; update: jest.Mock }
}

const DAY = 86400000

// Build a Stripe subscription stub renewing `daysOut` days from now.
const stripeSub = (daysOut: number, overrides: Record<string, unknown> = {}) => {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    status: 'active',
    current_period_start: nowSec - 27 * 24 * 3600,
    current_period_end: nowSec + Math.round(daysOut * 24 * 3600),
    items: { data: [{ price: { recurring: { interval: 'month' }, unit_amount: 115884 } }] },
    ...overrides,
  }
}

// The REAL shape the pinned API (2025-09-30.clover) returns: the period lives ONLY on the item.
const cloverSub = (daysOut: number) => {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    status: 'active',
    items: {
      data: [
        {
          current_period_start: nowSec - 27 * 24 * 3600,
          current_period_end: nowSec + Math.round(daysOut * 24 * 3600),
          price: { recurring: { interval: 'month' }, unit_amount: 115884 },
        },
      ],
    },
  }
}

describe('PlanRenewalReminderJob.runNow', () => {
  let sendSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    sendSpy = jest.spyOn(emailService, 'sendPlanRenewalReminderEmail').mockResolvedValue(true)
    ;(planNotification.resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({
      email: 'owner@x.com',
      locale: 'es',
      venueName: 'Bar',
      ownerName: 'Ana',
    })
    mockPrisma.venueFeature.update.mockResolvedValue({})
  })

  afterEach(() => sendSpy.mockRestore())

  it('queries only active PLAN_PRO features with a Stripe subscription', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([])

    await new PlanRenewalReminderJob().runNow()

    expect(mockPrisma.venueFeature.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          active: true,
          stripeSubscriptionId: { not: null },
          feature: { code: 'PLAN_PRO' },
        }),
      }),
    )
  })

  // 1. NEW FEATURE TESTS
  it('renewing in ~3 days and not yet reminded → sends + stamps renewalReminderSentAt', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', venueId: 'v1', stripeSubscriptionId: 'sub_1', renewalReminderSentAt: null },
    ])
    mockRetrieve.mockResolvedValue(stripeSub(3))

    await new PlanRenewalReminderJob().runNow()

    expect(mockRetrieve).toHaveBeenCalledWith('sub_1')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const [to, data] = sendSpy.mock.calls[0]
    expect(to).toBe('owner@x.com')
    expect(data).toMatchObject({ locale: 'es', venueName: 'Bar', interval: 'monthly', amountCents: 115884 })
    expect(data.renewalDate).toBeInstanceOf(Date)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledWith({
      where: { id: 'vf1' },
      data: { renewalReminderSentAt: expect.any(Date) },
    })
  })

  it('maps annual interval from price.recurring.interval=year', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', venueId: 'v1', stripeSubscriptionId: 'sub_1', renewalReminderSentAt: null },
    ])
    mockRetrieve.mockResolvedValue(
      stripeSub(3, { items: { data: [{ price: { recurring: { interval: 'year' }, unit_amount: 1158840 } }] } }),
    )

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy.mock.calls[0][1]).toMatchObject({ interval: 'annual', amountCents: 1158840 })
  })

  it('sends for a trialing subscription about to convert', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', venueId: 'v1', stripeSubscriptionId: 'sub_1', renewalReminderSentAt: null },
    ])
    mockRetrieve.mockResolvedValue(stripeSub(3, { status: 'trialing' }))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
  })

  // 2. SKIP / EDGE CASES
  it('renewing in ~10 days → skip (outside 2-4 day window)', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', venueId: 'v1', stripeSubscriptionId: 'sub_1', renewalReminderSentAt: null },
    ])
    mockRetrieve.mockResolvedValue(stripeSub(10))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('already reminded this billing period → skip', async () => {
    // Reminder was sent AFTER current_period_start → already reminded this period.
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      {
        id: 'vf1',
        venueId: 'v1',
        stripeSubscriptionId: 'sub_1',
        renewalReminderSentAt: new Date(Date.now() - 1 * DAY), // within current period
      },
    ])
    mockRetrieve.mockResolvedValue(stripeSub(3))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('reminded in a PREVIOUS period (older than current_period_start) → re-sends', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      {
        id: 'vf1',
        venueId: 'v1',
        stripeSubscriptionId: 'sub_1',
        renewalReminderSentAt: new Date(Date.now() - 40 * DAY), // before current_period_start (-27d)
      },
    ])
    mockRetrieve.mockResolvedValue(stripeSub(3))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledTimes(1)
  })

  it('canceled/past_due subscription status → skip', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', venueId: 'v1', stripeSubscriptionId: 'sub_1', renewalReminderSentAt: null },
    ])
    mockRetrieve.mockResolvedValue(stripeSub(3, { status: 'past_due' }))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('null recipient → skip, no throw, no stamp', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', venueId: 'v1', stripeSubscriptionId: 'sub_1', renewalReminderSentAt: null },
    ])
    mockRetrieve.mockResolvedValue(stripeSub(3))
    ;(planNotification.resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({
      email: null,
      locale: 'es',
      venueName: 'Bar',
      ownerName: null,
    })

    await expect(new PlanRenewalReminderJob().runNow()).resolves.toBeUndefined()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  // 🔴 Real defect (2026-09-27): the job read the period from the subscription, which the clover API no longer
  // carries → NaN → NaN slipped past BOTH the window and the dedup checks → a daily email saying "Invalid Date".
  it('🔴 clover shape (period only on the item): sends with the real renewal date', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', venueId: 'v1', stripeSubscriptionId: 'sub_1', renewalReminderSentAt: null },
    ])
    const sub = cloverSub(3)
    mockRetrieve.mockResolvedValue(sub)

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0][1].renewalDate.getTime()).toBe(sub.items.data[0].current_period_end * 1000)
  })

  it('🔴 clover shape renewing in ~10 days → skip (the window still applies)', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', venueId: 'v1', stripeSubscriptionId: 'sub_1', renewalReminderSentAt: null },
    ])
    mockRetrieve.mockResolvedValue(cloverSub(10))

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('🔴 no period anywhere → skip: never an "Invalid Date" email, no stamp', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', venueId: 'v1', stripeSubscriptionId: 'sub_1', renewalReminderSentAt: null },
    ])
    mockRetrieve.mockResolvedValue({ status: 'active', items: { data: [{ price: { recurring: { interval: 'month' } } }] } })

    await new PlanRenewalReminderJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  // REGRESSION: one failing row must not abort the batch
  it('isolates a per-venue Stripe failure so the rest of the batch still sends', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', venueId: 'v1', stripeSubscriptionId: 'sub_1', renewalReminderSentAt: null },
      { id: 'vf2', venueId: 'v2', stripeSubscriptionId: 'sub_2', renewalReminderSentAt: null },
    ])
    mockRetrieve.mockRejectedValueOnce(new Error('Stripe 503')).mockResolvedValueOnce(stripeSub(3))

    await expect(new PlanRenewalReminderJob().runNow()).resolves.toBeUndefined()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledWith({
      where: { id: 'vf2' },
      data: { renewalReminderSentAt: expect.any(Date) },
    })
  })
})
