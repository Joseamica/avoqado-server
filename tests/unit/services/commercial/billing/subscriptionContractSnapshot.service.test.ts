import Ajv from 'ajv'
import quoteFixtureJson from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-direct.json'
import billingSchema from '@/contracts/commercial/commercial-billing-v1.schema.json'
import {
  buildCommercialSubscriptionContractSnapshotV1,
  createCommercialSubscriptionContract,
} from '@/services/commercial/billing/subscriptionContract.service'
import type { CommercialQuoteSnapshotV3 } from '@/types/commercialQuoteV3'

const quote = quoteFixtureJson as CommercialQuoteSnapshotV3
const validate = new Ajv({ allErrors: true, jsonPointers: true }).compile(billingSchema as object)

function build(source: CommercialQuoteSnapshotV3) {
  return buildCommercialSubscriptionContractSnapshotV1({
    acceptanceId: 'acceptance-contract-1',
    quoteChecksum: 'a'.repeat(64),
    quote: source,
    timezone: 'America/Mexico_City',
    startsAt: new Date('2026-09-01T18:00:00.000Z'),
  })
}

describe('buildCommercialSubscriptionContractSnapshotV1', () => {
  it('freezes one monthly schedule and its paid entitlement requirements', () => {
    const snapshot = build(quote)

    expect(validate(snapshot)).toBe(true)
    expect(snapshot.cadence).toBe('MONTHLY')
    expect(snapshot.schedules).toEqual([
      {
        scheduleKey: 'SAAS_MONTHLY',
        cadence: 'MONTHLY',
        firstPeriodAmountMinor: '20880',
        renewalAmountMinor: '28884',
      },
    ])
    expect(snapshot.entitlements).toEqual([
      { featureCode: 'POS_CORE', requiredScheduleKeys: ['SAAS_MONTHLY'] },
    ])
  })

  it('supports monthly and annual obligations without making either cadence unlock the other', () => {
    const mixed = structuredClone(quote)
    const annual = structuredClone(mixed.saasLines[0]!)
    annual.lineKey = 'PRODUCT:ANNUAL_MODULE:ANNUAL_MODULE_YEARLY'
    annual.targetCode = 'ANNUAL_MODULE'
    annual.priceCode = 'ANNUAL_MODULE_YEARLY'
    annual.billingUnit = 'VENUE_YEAR'
    annual.totalMinor = '115884'
    annual.renewalTotalMinor = '115884'
    mixed.saasLines.push(annual)
    mixed.entitlementGrants.push({
      capabilityCode: 'ANNUAL_CAPABILITY',
      capabilityKind: 'ADD_ON',
      origins: [{ kind: 'PRODUCT', sourceCode: 'ANNUAL_MODULE', lineKey: annual.lineKey }],
      activationRequirement: { mode: 'NOT_REQUIRED' },
    })

    const snapshot = build(mixed)

    expect(validate(snapshot)).toBe(true)
    expect(snapshot.cadence).toBe('MIXED')
    expect(snapshot.schedules).toEqual([
      expect.objectContaining({ scheduleKey: 'SAAS_MONTHLY', cadence: 'MONTHLY' }),
      expect.objectContaining({
        scheduleKey: 'SAAS_ANNUAL',
        cadence: 'ANNUAL',
        firstPeriodAmountMinor: '115884',
        renewalAmountMinor: '115884',
      }),
    ])
    expect(snapshot.entitlements).toEqual(
      expect.arrayContaining([
        { featureCode: 'POS_CORE', requiredScheduleKeys: ['SAAS_MONTHLY'] },
        { featureCode: 'ANNUAL_CAPABILITY', requiredScheduleKeys: ['SAAS_ANNUAL'] },
      ]),
    )
  })

  it('fails closed when an entitlement cannot be traced to a billed SaaS line', () => {
    const invalid = structuredClone(quote)
    invalid.entitlementGrants[0]!.origins = [
      { kind: 'PRODUCT', sourceCode: 'MISSING', lineKey: 'PRODUCT:MISSING:MISSING_MONTHLY' },
    ]

    expect(() => build(invalid)).toThrow('COMMERCIAL_BILLING_ENTITLEMENT_LINEAGE_INVALID')
  })
})

describe('createCommercialSubscriptionContract', () => {
  it('creates contract, first period and receivable without granting an entitlement', async () => {
    const snapshot = build(quote)
    const tx = {
      commercialSubscriptionContract: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'contract-created', checksum: 'b'.repeat(64) }),
      },
      commercialSubscriptionPeriod: {
        create: jest.fn().mockResolvedValue({ id: 'period-created' }),
      },
      commercialAccountReceivable: {
        create: jest.fn().mockResolvedValue({ id: 'receivable-created' }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-created' }) },
      organizationEntitlement: { upsert: jest.fn() },
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        {
          acceptanceId: snapshot.acceptanceId,
          quoteId: snapshot.quoteId,
          quoteChecksum: snapshot.quoteChecksum,
          organizationId: snapshot.organizationId,
          venueId: snapshot.venueId,
          acceptedById: 'staff-owner-1',
          startsAtMatches: true,
          status: 'ACCEPTED',
        },
      ]),
    }
    const host = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
    }

    const result = await createCommercialSubscriptionContract(
      { snapshot, idempotencyKey: 'contract-idempotency-1', graceDays: 5 },
      { host: host as never },
    )

    expect(result).toMatchObject({
      decision: 'CREATED',
      contractId: 'contract-created',
      periods: [
        {
          periodId: 'period-created',
          receivableId: 'receivable-created',
          scheduleKey: 'SAAS_MONTHLY',
          amountDueMinor: 20_880n,
        },
      ],
    })
    expect(tx.organizationEntitlement.upsert).not.toHaveBeenCalled()
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
  })
})
