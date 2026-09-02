import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import {
  buildCommercialEntitlementProjectionPlan,
  buildCommercialEntitlementReversalPlan,
  projectCommercialPaidEntitlements,
  projectCommercialReversedEntitlements,
} from '@/services/commercial/billing/entitlementProjection.service'
import type { CommercialSubscriptionContractSnapshotV1, CommercialSubscriptionEntitlementPeriod } from '@/types/commercialBilling'

const contractStart = new Date('2026-09-01T06:00:00.000Z')
const october = new Date('2026-10-01T06:00:00.000Z')
const november = new Date('2026-11-01T06:00:00.000Z')
const nextYear = new Date('2027-09-01T06:00:00.000Z')

function snapshot(): CommercialSubscriptionContractSnapshotV1 {
  return {
    schemaVersion: 1,
    contractVersion: '1.0.0',
    acceptanceId: 'acceptance-entitlement-1',
    quoteId: 'quote-entitlement-1',
    quoteChecksum: 'a'.repeat(64),
    organizationId: 'org-1',
    venueId: 'venue-1',
    currency: 'MXN',
    timezone: 'America/Mexico_City',
    startsAt: contractStart.toISOString(),
    cadence: 'MIXED',
    schedules: [
      {
        scheduleKey: 'SAAS_MONTHLY',
        cadence: 'MONTHLY',
        firstPeriodAmountMinor: '28884',
        renewalAmountMinor: '28884',
      },
      {
        scheduleKey: 'SAAS_ANNUAL',
        cadence: 'ANNUAL',
        firstPeriodAmountMinor: '115884',
        renewalAmountMinor: '115884',
      },
    ],
    entitlements: [
      { featureCode: 'POS_CORE', requiredScheduleKeys: ['SAAS_MONTHLY'] },
      { featureCode: 'ANNUAL_REPORTS', requiredScheduleKeys: ['SAAS_ANNUAL'] },
      { featureCode: 'COMBINED_AUTOMATION', requiredScheduleKeys: ['SAAS_MONTHLY', 'SAAS_ANNUAL'] },
    ],
  }
}

function period(
  overrides: Partial<CommercialSubscriptionEntitlementPeriod> &
    Pick<CommercialSubscriptionEntitlementPeriod, 'id' | 'scheduleKey' | 'sequence' | 'startsAt' | 'endsAt'>,
): CommercialSubscriptionEntitlementPeriod {
  return {
    status: 'PAID',
    ...overrides,
  }
}

describe('buildCommercialEntitlementProjectionPlan', () => {
  it('grants only the feature whose own paid schedule is contiguous', () => {
    const plan = buildCommercialEntitlementProjectionPlan({
      snapshot: snapshot(),
      periods: [
        period({
          id: 'period-monthly-1',
          scheduleKey: 'SAAS_MONTHLY',
          sequence: 1,
          startsAt: contractStart,
          endsAt: october,
        }),
      ],
    })

    expect(plan.grants).toEqual([
      {
        featureCode: 'POS_CORE',
        coverageStartsAt: contractStart,
        coverageEndsAt: october,
        requiredScheduleKeys: ['SAAS_MONTHLY'],
        sourcePeriodIds: ['period-monthly-1'],
      },
    ])
  })

  it('waits for every required schedule and limits coverage to their shortest paid window', () => {
    const plan = buildCommercialEntitlementProjectionPlan({
      snapshot: snapshot(),
      periods: [
        period({
          id: 'period-monthly-1',
          scheduleKey: 'SAAS_MONTHLY',
          sequence: 1,
          startsAt: contractStart,
          endsAt: october,
        }),
        period({
          id: 'period-annual-1',
          scheduleKey: 'SAAS_ANNUAL',
          sequence: 1,
          startsAt: contractStart,
          endsAt: nextYear,
        }),
      ],
    })

    expect(plan.grants).toEqual([
      expect.objectContaining({ featureCode: 'ANNUAL_REPORTS', coverageEndsAt: nextYear }),
      expect.objectContaining({ featureCode: 'COMBINED_AUTOMATION', coverageEndsAt: october }),
      expect.objectContaining({ featureCode: 'POS_CORE', coverageEndsAt: october }),
    ])
  })

  it('does not extend access across an unpaid gap', () => {
    const plan = buildCommercialEntitlementProjectionPlan({
      snapshot: snapshot(),
      periods: [
        period({
          id: 'period-monthly-1',
          scheduleKey: 'SAAS_MONTHLY',
          sequence: 1,
          startsAt: contractStart,
          endsAt: october,
        }),
        period({
          id: 'period-monthly-2',
          scheduleKey: 'SAAS_MONTHLY',
          sequence: 2,
          startsAt: october,
          endsAt: november,
          status: 'OPEN',
        }),
      ],
    })

    expect(plan.grants).toEqual([
      expect.objectContaining({
        featureCode: 'POS_CORE',
        coverageEndsAt: october,
        sourcePeriodIds: ['period-monthly-1'],
      }),
    ])
  })
})

describe('buildCommercialEntitlementReversalPlan', () => {
  it('retracts only the paid coverage that disappeared after a refund', () => {
    const currentPlan = buildCommercialEntitlementProjectionPlan({
      snapshot: snapshot(),
      periods: [
        period({
          id: 'period-monthly-1',
          scheduleKey: 'SAAS_MONTHLY',
          sequence: 1,
          startsAt: contractStart,
          endsAt: october,
        }),
        period({
          id: 'period-monthly-2',
          scheduleKey: 'SAAS_MONTHLY',
          sequence: 2,
          startsAt: october,
          endsAt: november,
          status: 'PAST_DUE',
        }),
        period({
          id: 'period-annual-1',
          scheduleKey: 'SAAS_ANNUAL',
          sequence: 1,
          startsAt: contractStart,
          endsAt: nextYear,
        }),
      ],
    })

    expect(
      buildCommercialEntitlementReversalPlan({
        currentPlan,
        previousEffectiveGrants: [
          {
            featureCode: 'POS_CORE',
            coverageStartsAt: contractStart,
            coverageEndsAt: november,
          },
          {
            featureCode: 'ANNUAL_REPORTS',
            coverageStartsAt: contractStart,
            coverageEndsAt: nextYear,
          },
        ],
      }),
    ).toEqual({
      revocations: [
        {
          featureCode: 'POS_CORE',
          coverageStartsAt: october,
          coverageEndsAt: november,
        },
      ],
    })
  })

  it('retracts the whole historical window when no paid coverage remains', () => {
    expect(
      buildCommercialEntitlementReversalPlan({
        currentPlan: { grants: [] },
        previousEffectiveGrants: [
          {
            featureCode: 'POS_CORE',
            coverageStartsAt: contractStart,
            coverageEndsAt: october,
          },
        ],
      }),
    ).toEqual({
      revocations: [
        {
          featureCode: 'POS_CORE',
          coverageStartsAt: contractStart,
          coverageEndsAt: october,
        },
      ],
    })
  })
})

describe('projectCommercialPaidEntitlements', () => {
  it('returns the immutable projection on replay even when a later refund changed current coverage', async () => {
    const contractSnapshot = snapshot()
    const originalProjection = {
      featureCode: 'POS_CORE',
      coverageStartsAt: contractStart,
      coverageEndsAt: october,
    }
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          eventId: 'event-paid-before-refund-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          sourceType: 'SUBSCRIPTION_PERIOD',
          sourceId: 'period-monthly-1',
          sourceRevision: 2,
          eventType: 'SUBSCRIPTION_PAYMENT_RECONCILED',
          periodStatus: 'PAST_DUE',
          periodStatusRevision: 3,
          contractId: 'contract-1',
          contractStatus: 'PAUSED',
          contractSnapshot,
          contractChecksum: hashCanonicalJsonV1('avoqado:commercial-billing:subscription-contract', contractSnapshot),
          acceptedById: 'staff-owner-1',
        },
      ]),
      commercialEntitlementProjection: {
        findMany: jest.fn().mockResolvedValue([originalProjection]),
      },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    await expect(
      projectCommercialPaidEntitlements(
        { eventId: 'event-paid-before-refund-1', now: new Date('2026-09-07T12:00:00.000Z') },
        { host: host as never },
      ),
    ).resolves.toEqual({
      decision: 'REPLAY',
      eventId: 'event-paid-before-refund-1',
      grants: [originalProjection],
    })
  })

  it.each(['SUBSCRIPTION_PAYMENT_RECONCILED', 'SUBSCRIPTION_NON_CASH_ACTIVATED'] as const)(
    'projects only capabilities covered by the paid schedules of the canonical %s event',
    async eventType => {
      const contractSnapshot = snapshot()
      const createdProjections: Array<Record<string, unknown>> = []
      const tx = {
        $queryRawUnsafe: jest.fn().mockResolvedValue([
          {
            eventId: 'event-paid-monthly-1',
            organizationId: 'org-1',
            venueId: 'venue-1',
            sourceType: 'SUBSCRIPTION_PERIOD',
            sourceId: 'period-monthly-1',
            sourceRevision: 2,
            eventType,
            periodStatus: 'PAID',
            periodStatusRevision: 2,
            contractId: 'contract-1',
            contractStatus: 'PENDING_PAYMENT',
            contractSnapshot,
            contractChecksum: hashCanonicalJsonV1('avoqado:commercial-billing:subscription-contract', contractSnapshot),
            acceptedById: 'staff-owner-1',
          },
        ]),
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
        commercialEntitlementProjection: {
          findMany: jest
            .fn()
            .mockResolvedValueOnce([])
            .mockImplementation(async () => createdProjections),
          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            const created = { id: 'projection-pos-1', ...data, createdAt: contractStart }
            createdProjections.push(created)
            return created
          }),
        },
        commercialSubscriptionPeriod: {
          findMany: jest.fn().mockResolvedValue([
            period({
              id: 'period-monthly-1',
              scheduleKey: 'SAAS_MONTHLY',
              sequence: 1,
              startsAt: contractStart,
              endsAt: october,
            }),
            period({
              id: 'period-annual-1',
              scheduleKey: 'SAAS_ANNUAL',
              sequence: 1,
              startsAt: contractStart,
              endsAt: nextYear,
              status: 'OPEN',
            }),
          ]),
        },
        commercialSubscriptionContract: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'contract-1',
              snapshot: contractSnapshot,
              checksum: hashCanonicalJsonV1('avoqado:commercial-billing:subscription-contract', contractSnapshot),
              periods: [
                period({
                  id: 'period-monthly-1',
                  scheduleKey: 'SAAS_MONTHLY',
                  sequence: 1,
                  startsAt: contractStart,
                  endsAt: october,
                }),
                period({
                  id: 'period-annual-1',
                  scheduleKey: 'SAAS_ANNUAL',
                  sequence: 1,
                  startsAt: contractStart,
                  endsAt: nextYear,
                  status: 'OPEN',
                }),
              ],
            },
          ]),
          update: jest.fn().mockResolvedValue({ id: 'contract-1', status: 'ACTIVE' }),
        },
        organizationEntitlement: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({ id: 'organization-entitlement-pos-1' }),
        },
        activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-projection-1' }) },
      }
      const host = {
        $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
      }

      const result = await projectCommercialPaidEntitlements(
        { eventId: 'event-paid-monthly-1', now: new Date('2026-09-01T06:01:00.000Z') },
        { host: host as never },
      )

      expect(result).toEqual({
        decision: 'PROJECTED',
        eventId: 'event-paid-monthly-1',
        grants: [
          {
            featureCode: 'POS_CORE',
            coverageStartsAt: contractStart,
            coverageEndsAt: october,
          },
        ],
      })
      expect(tx.commercialEntitlementProjection.create).toHaveBeenCalledTimes(1)
      expect(tx.organizationEntitlement.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ featureCode: 'POS_CORE', source: 'CONTRACT', status: 'ACTIVE' }),
        }),
      )
    },
  )

  it('reactivates a paused contract after reversed coverage is paid again', async () => {
    const contractSnapshot = snapshot()
    const projectionHistory = [
      {
        featureCode: 'POS_CORE',
        action: 'GRANT',
        coverageStartsAt: contractStart,
        coverageEndsAt: october,
        createdAt: new Date('2026-09-01T06:01:00.000Z'),
      },
      {
        featureCode: 'POS_CORE',
        action: 'REVOKE',
        coverageStartsAt: contractStart,
        coverageEndsAt: october,
        createdAt: new Date('2026-09-07T12:00:00.000Z'),
      },
    ]
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          eventId: 'event-paid-reinstated-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          sourceType: 'SUBSCRIPTION_PERIOD',
          sourceId: 'period-monthly-1',
          sourceRevision: 4,
          eventType: 'SUBSCRIPTION_PAYMENT_RECONCILED',
          periodStatus: 'PAID',
          periodStatusRevision: 4,
          contractId: 'contract-1',
          contractStatus: 'PAUSED',
          contractSnapshot,
          contractChecksum: hashCanonicalJsonV1('avoqado:commercial-billing:subscription-contract', contractSnapshot),
          acceptedById: 'staff-owner-1',
        },
      ]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      commercialEntitlementProjection: {
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.eventId) return []
          if (where.contractId === 'contract-1') return projectionHistory
          return []
        }),
        create: jest.fn().mockResolvedValue({ id: 'projection-reinstated-pos-1' }),
      },
      commercialSubscriptionPeriod: {
        findMany: jest.fn().mockResolvedValue([
          period({
            id: 'period-monthly-1',
            scheduleKey: 'SAAS_MONTHLY',
            sequence: 1,
            startsAt: contractStart,
            endsAt: october,
          }),
        ]),
      },
      commercialSubscriptionContract: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'contract-1',
            snapshot: contractSnapshot,
            checksum: hashCanonicalJsonV1('avoqado:commercial-billing:subscription-contract', contractSnapshot),
            periods: [
              period({
                id: 'period-monthly-1',
                scheduleKey: 'SAAS_MONTHLY',
                sequence: 1,
                startsAt: contractStart,
                endsAt: october,
              }),
            ],
          },
        ]),
        update: jest.fn().mockResolvedValue({ id: 'contract-1', status: 'ACTIVE' }),
      },
      organizationEntitlement: {
        findUnique: jest.fn().mockResolvedValue({
          source: 'CONTRACT',
          startsAt: contractStart,
          endsAt: new Date('2026-09-07T12:00:00.000Z'),
        }),
        upsert: jest.fn().mockResolvedValue({ id: 'organization-entitlement-pos-1' }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-reinstated-1' }) },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    await expect(
      projectCommercialPaidEntitlements(
        { eventId: 'event-paid-reinstated-1', now: new Date('2026-09-08T12:00:00.000Z') },
        { host: host as never },
      ),
    ).resolves.toEqual({
      decision: 'PROJECTED',
      eventId: 'event-paid-reinstated-1',
      grants: [
        {
          featureCode: 'POS_CORE',
          coverageStartsAt: contractStart,
          coverageEndsAt: october,
        },
      ],
    })
    expect(tx.commercialEntitlementProjection.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'GRANT', featureCode: 'POS_CORE' }) }),
    )
    expect(tx.organizationEntitlement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: 'ACTIVE', startsAt: contractStart, endsAt: october }),
      }),
    )
    expect(tx.commercialSubscriptionContract.update).toHaveBeenCalledWith({
      where: { id: 'contract-1' },
      data: { status: 'ACTIVE' },
    })
  })

  it('rebuilds organization coverage from currently paid contracts instead of historical grants', async () => {
    const contractSnapshot = snapshot()
    const historicalProjection = {
      contractId: 'contract-refunded-old',
      coverageStartsAt: contractStart,
      coverageEndsAt: nextYear,
    }
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          eventId: 'event-paid-current-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          sourceType: 'SUBSCRIPTION_PERIOD',
          sourceId: 'period-monthly-1',
          sourceRevision: 2,
          eventType: 'SUBSCRIPTION_PAYMENT_RECONCILED',
          periodStatus: 'PAID',
          periodStatusRevision: 2,
          contractId: 'contract-current',
          contractStatus: 'PENDING_PAYMENT',
          contractSnapshot,
          contractChecksum: hashCanonicalJsonV1('avoqado:commercial-billing:subscription-contract', contractSnapshot),
          acceptedById: 'staff-owner-1',
        },
      ]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      commercialEntitlementProjection: {
        findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.eventId) return []
          if (where.organizationId) return [historicalProjection]
          return []
        }),
        create: jest.fn().mockResolvedValue({ id: 'projection-current-pos-1' }),
      },
      commercialSubscriptionPeriod: {
        findMany: jest.fn().mockResolvedValue([
          period({
            id: 'period-monthly-1',
            scheduleKey: 'SAAS_MONTHLY',
            sequence: 1,
            startsAt: contractStart,
            endsAt: october,
          }),
        ]),
      },
      commercialSubscriptionContract: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'contract-current',
            snapshot: contractSnapshot,
            checksum: hashCanonicalJsonV1('avoqado:commercial-billing:subscription-contract', contractSnapshot),
            periods: [
              period({
                id: 'period-monthly-1',
                scheduleKey: 'SAAS_MONTHLY',
                sequence: 1,
                startsAt: contractStart,
                endsAt: october,
              }),
            ],
          },
        ]),
        update: jest.fn().mockResolvedValue({ id: 'contract-current', status: 'ACTIVE' }),
      },
      organizationEntitlement: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'organization-entitlement-pos-1' }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-current-1' }) },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    await projectCommercialPaidEntitlements(
      { eventId: 'event-paid-current-1', now: new Date('2026-09-01T06:01:00.000Z') },
      { host: host as never },
    )

    expect(tx.organizationEntitlement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ startsAt: contractStart, endsAt: october }),
        update: expect.objectContaining({ startsAt: contractStart, endsAt: october }),
      }),
    )
  })
})

describe('projectCommercialReversedEntitlements', () => {
  it('records immutable REVOKE evidence and rebuilds the organization summary from current paid contracts', async () => {
    const contractSnapshot = snapshot()
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          eventId: 'event-reversed-monthly-1',
          organizationId: 'org-1',
          venueId: 'venue-1',
          sourceType: 'SUBSCRIPTION_PERIOD',
          sourceId: 'period-monthly-1',
          sourceRevision: 3,
          eventType: 'SUBSCRIPTION_PAYMENT_COVERAGE_REVERSED',
          periodStatus: 'PAST_DUE',
          periodStatusRevision: 3,
          contractId: 'contract-1',
          contractStatus: 'ACTIVE',
          contractSnapshot,
          contractChecksum: hashCanonicalJsonV1('avoqado:commercial-billing:subscription-contract', contractSnapshot),
          acceptedById: 'staff-owner-1',
        },
      ]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      commercialEntitlementProjection: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              featureCode: 'POS_CORE',
              action: 'GRANT',
              coverageStartsAt: contractStart,
              coverageEndsAt: october,
              createdAt: new Date('2026-09-01T06:01:00.000Z'),
            },
          ]),
        create: jest.fn().mockResolvedValue({ id: 'projection-revoke-pos-1' }),
      },
      commercialSubscriptionPeriod: {
        findMany: jest.fn().mockResolvedValue([
          period({
            id: 'period-monthly-1',
            scheduleKey: 'SAAS_MONTHLY',
            sequence: 1,
            startsAt: contractStart,
            endsAt: october,
            status: 'PAST_DUE',
          }),
        ]),
      },
      commercialSubscriptionContract: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'contract-1',
            snapshot: contractSnapshot,
            checksum: hashCanonicalJsonV1('avoqado:commercial-billing:subscription-contract', contractSnapshot),
            periods: [
              period({
                id: 'period-monthly-1',
                scheduleKey: 'SAAS_MONTHLY',
                sequence: 1,
                startsAt: contractStart,
                endsAt: october,
                status: 'PAST_DUE',
              }),
            ],
          },
        ]),
        update: jest.fn().mockResolvedValue({ id: 'contract-1', status: 'PAUSED' }),
      },
      organizationEntitlement: {
        findUnique: jest.fn().mockResolvedValue({
          source: 'CONTRACT',
          startsAt: contractStart,
          endsAt: october,
        }),
        update: jest.fn().mockResolvedValue({ id: 'organization-entitlement-pos-1', status: 'REVOKED' }),
        upsert: jest.fn(),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-reversal-1' }) },
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    await expect(
      projectCommercialReversedEntitlements(
        { eventId: 'event-reversed-monthly-1', now: new Date('2026-09-07T12:00:00.000Z') },
        { host: host as never },
      ),
    ).resolves.toEqual({
      decision: 'PROJECTED',
      eventId: 'event-reversed-monthly-1',
      revocations: [
        {
          featureCode: 'POS_CORE',
          coverageStartsAt: contractStart,
          coverageEndsAt: october,
        },
      ],
    })
    expect(tx.commercialEntitlementProjection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'REVOKE', featureCode: 'POS_CORE' }),
      }),
    )
    expect(tx.organizationEntitlement.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVOKED' }) }),
    )
    expect(tx.commercialSubscriptionContract.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'PAUSED' } }))
  })
})
