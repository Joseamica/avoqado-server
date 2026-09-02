import {
  buildCommercialSubscriptionPeriodDrafts,
  createCommercialSubscriptionContract,
} from '@/services/commercial/billing/subscriptionContract.service'
import type { CommercialSubscriptionContractSnapshotV1 } from '@/types/commercialBilling'

describe('buildCommercialSubscriptionPeriodDrafts', () => {
  it('keeps a monthly anniversary anchored across a short month', () => {
    const periods = buildCommercialSubscriptionPeriodDrafts({
      cadence: 'MONTHLY',
      startsAt: new Date('2027-01-31T18:00:00.000Z'),
      timezone: 'America/Mexico_City',
      firstPeriodAmountMinor: 5_800n,
      renewalAmountMinor: 28_884n,
      periodCount: 2,
      graceDays: 5,
    })

    expect(periods).toEqual([
      {
        sequence: 1,
        startsAt: new Date('2027-01-31T18:00:00.000Z'),
        endsAt: new Date('2027-02-28T18:00:00.000Z'),
        dueAt: new Date('2027-01-31T18:00:00.000Z'),
        graceEndsAt: new Date('2027-02-05T18:00:00.000Z'),
        amountDueMinor: 5_800n,
      },
      {
        sequence: 2,
        startsAt: new Date('2027-02-28T18:00:00.000Z'),
        endsAt: new Date('2027-03-31T18:00:00.000Z'),
        dueAt: new Date('2027-02-28T18:00:00.000Z'),
        graceEndsAt: new Date('2027-03-05T18:00:00.000Z'),
        amountDueMinor: 28_884n,
      },
    ])
  })

  it('builds an annual period from the same local anniversary', () => {
    const [period] = buildCommercialSubscriptionPeriodDrafts({
      cadence: 'ANNUAL',
      startsAt: new Date('2028-02-29T18:00:00.000Z'),
      timezone: 'America/Mexico_City',
      firstPeriodAmountMinor: 115_884n,
      renewalAmountMinor: 115_884n,
      periodCount: 1,
      graceDays: 5,
    })

    expect(period).toMatchObject({
      sequence: 1,
      startsAt: new Date('2028-02-29T18:00:00.000Z'),
      endsAt: new Date('2029-02-28T18:00:00.000Z'),
      amountDueMinor: 115_884n,
    })
  })

  it('rejects invalid timezone and count instead of using host-local dates', () => {
    const base = {
      cadence: 'MONTHLY' as const,
      startsAt: new Date('2027-01-31T18:00:00.000Z'),
      timezone: 'America/Mexico_City',
      firstPeriodAmountMinor: 28_884n,
      renewalAmountMinor: 28_884n,
      periodCount: 1,
      graceDays: 5,
    }

    expect(() => buildCommercialSubscriptionPeriodDrafts({ ...base, timezone: 'not/a-zone' })).toThrow(
      'COMMERCIAL_BILLING_TIMEZONE_INVALID',
    )
    expect(() => buildCommercialSubscriptionPeriodDrafts({ ...base, periodCount: 0 })).toThrow(
      'COMMERCIAL_BILLING_PERIOD_COUNT_INVALID',
    )
  })
})

describe('createCommercialSubscriptionContract zero-priced schedule', () => {
  it('activates a zero period through the explicit non-cash authority inside the contract transaction', async () => {
    const startsAt = new Date('2026-09-01T06:00:00.000Z')
    const snapshot: CommercialSubscriptionContractSnapshotV1 = {
      schemaVersion: 1,
      contractVersion: '1.0.0',
      acceptanceId: 'acceptance-free-1',
      quoteId: 'quote-free-1',
      quoteChecksum: 'a'.repeat(64),
      organizationId: 'org-1',
      venueId: 'venue-1',
      currency: 'MXN',
      timezone: 'America/Mexico_City',
      startsAt: startsAt.toISOString(),
      cadence: 'MONTHLY',
      schedules: [
        {
          scheduleKey: 'SAAS_MONTHLY',
          cadence: 'MONTHLY',
          firstPeriodAmountMinor: '0',
          renewalAmountMinor: '0',
        },
      ],
      entitlements: [{ featureCode: 'POS_FREE', requiredScheduleKeys: ['SAAS_MONTHLY'] }],
    }
    const tx = {
      commercialSubscriptionContract: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'contract-free-1', checksum: 'checksum-free-1' }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          acceptanceId: 'acceptance-free-1',
          quoteId: 'quote-free-1',
          quoteChecksum: 'a'.repeat(64),
          organizationId: 'org-1',
          venueId: 'venue-1',
          acceptedById: 'staff-1',
          startsAtMatches: true,
          status: 'ACCEPTED',
        },
      ]),
      commercialSubscriptionPeriod: {
        create: jest.fn().mockResolvedValue({ id: 'period-free-1' }),
      },
      commercialAccountReceivable: {
        create: jest.fn().mockResolvedValue({ id: 'receivable-free-1' }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-contract-free-1' }) },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }
    const activateZeroAmountPeriod = jest.fn().mockResolvedValue({
      decision: 'ACTIVATED',
      periodId: 'period-free-1',
      sourceRevision: 2,
      eventId: 'b'.repeat(64),
    })

    await createCommercialSubscriptionContract(
      { snapshot, idempotencyKey: 'contract:free:1', graceDays: 5 },
      { host: host as never, activateZeroAmountPeriod },
    )

    expect(activateZeroAmountPeriod).toHaveBeenCalledWith(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        periodId: 'period-free-1',
        now: startsAt,
      },
      { host: expect.objectContaining({ $transaction: expect.any(Function) }) },
    )
  })
})
