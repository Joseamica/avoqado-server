import { evaluateCommercialSubscriptionPeriodCoverage } from '@/services/commercial/billing/subscriptionPeriod.service'

const dueAt = new Date('2026-09-05T05:59:59.999Z')
const graceEndsAt = new Date('2026-09-10T05:59:59.999Z')

describe('evaluateCommercialSubscriptionPeriodCoverage', () => {
  it('keeps a partial payment OPEN before its due date', () => {
    expect(
      evaluateCommercialSubscriptionPeriodCoverage({
        previousStatus: 'OPEN',
        amountDueMinor: 28_884n,
        activeAllocatedMinor: 10_000n,
        dueAt,
        graceEndsAt,
        now: new Date('2026-09-03T12:00:00.000Z'),
      }),
    ).toEqual({
      status: 'OPEN',
      outstandingMinor: 18_884n,
      transition: 'NONE',
    })
  })

  it('moves to PAID only when active cash allocations cover the full period', () => {
    expect(
      evaluateCommercialSubscriptionPeriodCoverage({
        previousStatus: 'OPEN',
        amountDueMinor: 28_884n,
        activeAllocatedMinor: 28_884n,
        dueAt,
        graceEndsAt,
        now: new Date('2026-09-03T12:00:00.000Z'),
      }),
    ).toEqual({
      status: 'PAID',
      outstandingMinor: 0n,
      transition: 'PAYMENT_RECONCILED',
    })
  })

  it('reports PAST_DUE during the grace window without granting paid coverage', () => {
    expect(
      evaluateCommercialSubscriptionPeriodCoverage({
        previousStatus: 'OPEN',
        amountDueMinor: 28_884n,
        activeAllocatedMinor: 0n,
        dueAt,
        graceEndsAt,
        now: new Date('2026-09-07T12:00:00.000Z'),
      }),
    ).toMatchObject({ status: 'PAST_DUE', transition: 'NONE' })
  })

  it('expires after grace without treating a proof or provider attempt as cash', () => {
    expect(
      evaluateCommercialSubscriptionPeriodCoverage({
        previousStatus: 'PAST_DUE',
        amountDueMinor: 28_884n,
        activeAllocatedMinor: 0n,
        dueAt,
        graceEndsAt,
        now: new Date('2026-09-11T12:00:00.000Z'),
      }),
    ).toEqual({
      status: 'EXPIRED',
      outstandingMinor: 28_884n,
      transition: 'NONE',
    })
  })

  it('produces a compensating transition when refund or reversal removes paid coverage', () => {
    expect(
      evaluateCommercialSubscriptionPeriodCoverage({
        previousStatus: 'PAID',
        amountDueMinor: 28_884n,
        activeAllocatedMinor: 20_000n,
        dueAt,
        graceEndsAt,
        now: new Date('2026-09-07T12:00:00.000Z'),
      }),
    ).toEqual({
      status: 'PAST_DUE',
      outstandingMinor: 8_884n,
      transition: 'PAYMENT_COVERAGE_REVERSED',
    })
  })
})
