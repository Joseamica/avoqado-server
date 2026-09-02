import { checksumCommercialBillingContractSnapshotV1 } from '@/services/commercial/billing/subscriptionContract.service'
import type { CommercialSubscriptionContractSnapshotV1 } from '@/types/commercialBilling'
import {
  getCommercialBillingDashboardOverview,
  listCommercialBillingDashboardReceipts,
} from '@/services/commercial/billing/commercialBillingDashboardRead.service'

const hugeMinor = 900719925474099301n

function billingSnapshot(): CommercialSubscriptionContractSnapshotV1 {
  return {
    schemaVersion: 1,
    contractVersion: '1.0.0',
    acceptanceId: 'acceptance-1',
    quoteId: 'quote-1',
    quoteChecksum: 'a'.repeat(64),
    organizationId: 'org-1',
    venueId: 'venue-1',
    currency: 'MXN',
    timezone: 'America/Mexico_City',
    startsAt: '2026-09-01T18:00:00.000Z',
    cadence: 'MONTHLY',
    schedules: [
      {
        scheduleKey: 'SAAS_MONTHLY',
        cadence: 'MONTHLY',
        firstPeriodAmountMinor: hugeMinor.toString(),
        renewalAmountMinor: '28884',
      },
    ],
    entitlements: [
      { featureCode: 'POS_CORE', requiredScheduleKeys: ['SAAS_MONTHLY'] },
      { featureCode: 'KITCHEN_DISPLAY', requiredScheduleKeys: ['SAAS_MONTHLY'] },
    ],
  }
}

function quoteSnapshot() {
  return {
    schemaVersion: 3,
    contractVersion: '3.0.0',
    quoteId: 'quote-1',
    subject: { kind: 'VENUE', organizationId: 'org-1', venueId: 'venue-1', actorId: 'staff-1' },
    currency: 'MXN',
    saasLines: [
      {
        lineKey: 'pos',
        targetType: 'PRODUCT',
        targetCode: 'POS',
        priceCode: 'POS_MONTHLY',
        quantity: 1,
        productKind: 'POS',
        name: 'Punto de venta',
        billingUnit: 'VENUE_MONTH',
        currency: 'MXN',
        listUnitAmountMinor: hugeMinor.toString(),
        listSubtotalMinor: hugeMinor.toString(),
        discountMinor: '0',
        subtotalMinor: hugeMinor.toString(),
        taxMinor: '0',
        totalMinor: hugeMinor.toString(),
        promotionalCycles: null,
        renewalSubtotalMinor: '24900',
        renewalTaxMinor: '3984',
        renewalTotalMinor: '28884',
      },
    ],
    totals: {
      recurringCurrent: {
        listSubtotalMinor: hugeMinor.toString(),
        discountMinor: '0',
        subtotalMinor: hugeMinor.toString(),
        taxMinor: '0',
        totalMinor: hugeMinor.toString(),
      },
      oneTime: {
        listSubtotalMinor: '100',
        discountMinor: '0',
        subtotalMinor: '100',
        taxMinor: '16',
        totalMinor: '116',
      },
      dueNow: {
        listSubtotalMinor: (hugeMinor + 100n).toString(),
        discountMinor: '0',
        subtotalMinor: (hugeMinor + 100n).toString(),
        taxMinor: '16',
        totalMinor: (hugeMinor + 116n).toString(),
      },
    },
    renewal: {
      listSubtotalMinor: '24900',
      discountMinor: '0',
      subtotalMinor: '24900',
      taxMinor: '3984',
      totalMinor: '28884',
    },
  }
}

function readyContract() {
  const snapshot = billingSnapshot()
  return {
    id: 'contract-1',
    quoteAcceptanceId: 'acceptance-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    schemaVersion: 1,
    snapshot,
    checksum: checksumCommercialBillingContractSnapshotV1(snapshot),
    status: 'PENDING_PAYMENT',
    cadence: 'MONTHLY',
    currency: 'MXN',
    timezone: 'America/Mexico_City',
    startsAt: new Date('2026-09-01T18:00:00.000Z'),
    endedAt: null,
    quoteAcceptance: {
      quote: {
        id: 'quote-1',
        schemaVersion: 3,
        checksum: 'a'.repeat(64),
        snapshot: quoteSnapshot(),
        listSubtotalMinor: hugeMinor + 100n,
        discountMinor: 0n,
        subtotalMinor: hugeMinor + 100n,
        taxMinor: 16n,
        totalMinor: hugeMinor + 116n,
        renewalSubtotalMinor: 24900n,
        renewalTaxMinor: 3984n,
        renewalTotalMinor: 28884n,
      },
    },
  }
}

function transactionalClient(overrides: Record<string, unknown> = {}) {
  const tx = {
    commercialSubscriptionContract: { findFirst: jest.fn().mockResolvedValue(readyContract()) },
    commercialSubscriptionPeriod: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'period-open-1',
            scheduleKey: 'SAAS_MONTHLY',
            cadence: 'MONTHLY',
            sequence: 1,
            startsAt: new Date('2026-09-01T18:00:00.000Z'),
            endsAt: new Date('2026-10-01T18:00:00.000Z'),
            dueAt: new Date('2026-09-01T18:00:00.000Z'),
            graceEndsAt: new Date('2026-09-06T18:00:00.000Z'),
            amountDueMinor: hugeMinor,
            currency: 'MXN',
            status: 'OPEN',
            paidAt: null,
            receivable: {
              id: 'receivable-1',
              reference: 'AVQ-REFERENCE-1',
              amountDueMinor: hugeMinor,
              currency: 'MXN',
              dueAt: new Date('2026-09-01T18:00:00.000Z'),
              status: 'PARTIALLY_PAID',
              paymentAttempts: [
                {
                  provider: 'MANUAL_SPEI',
                  status: 'PENDING',
                  updatedAt: new Date('2026-09-01T19:00:00.000Z'),
                  manualSpeiCase: { status: 'PENDING_REVIEW' },
                },
              ],
            },
          },
        ])
        .mockResolvedValueOnce([]),
    },
    commercialBillingAllocation: {
      groupBy: jest.fn().mockResolvedValue([
        { receivableId: 'receivable-1', direction: 'CREDIT', _sum: { amountMinor: 300n } },
        { receivableId: 'receivable-1', direction: 'DEBIT', _sum: { amountMinor: 100n } },
      ]),
    },
    commercialCashReceipt: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'receipt-1',
          provider: 'MANUAL_SPEI',
          entryType: 'PAYMENT',
          amountMinor: 300n,
          currency: 'MXN',
          observedAt: new Date('2026-09-01T19:00:00.000Z'),
          createdAt: new Date('2026-09-01T19:01:00.000Z'),
        },
      ]),
    },
    ...overrides,
  }
  const client = {
    $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  }
  return { client, tx }
}

describe('commercial billing Dashboard read model', () => {
  it('projects exact immutable terms, net allocation and review state without Number conversion or private fields', async () => {
    const { client, tx } = transactionalClient()

    const result = await getCommercialBillingDashboardOverview({ organizationId: 'org-1', venueId: 'venue-1' }, { client: client as never })

    expect(result).toMatchObject({
      schemaVersion: 1,
      state: 'READY',
      collectionState: 'PAYMENT_UNDER_REVIEW',
      contract: {
        id: 'contract-1',
        quoteId: 'quote-1',
        today: { totalMinor: hugeMinor.toString() },
        renewal: { totalMinor: '28884' },
        lines: [
          expect.objectContaining({
            targetCode: 'POS',
            name: 'Punto de venta',
            totalMinor: hugeMinor.toString(),
          }),
        ],
        entitlements: ['POS_CORE', 'KITCHEN_DISPLAY'],
      },
      obligations: [
        expect.objectContaining({
          receivableId: 'receivable-1',
          amountDueMinor: hugeMinor.toString(),
          allocatedMinor: '200',
          outstandingMinor: (hugeMinor - 200n).toString(),
          paymentState: 'UNDER_REVIEW',
        }),
      ],
      recentReceipts: [expect.objectContaining({ id: 'receipt-1', amountMinor: '300' })],
    })
    expect(JSON.stringify(result)).not.toMatch(/storageObjectKey|receivingAccountFingerprint|providerEventId|reconciledById/)
    expect(tx.commercialSubscriptionContract.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', venueId: 'venue-1' } }),
    )
    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' }))
  })

  it('returns a neutral no-contract state so legacy customers keep their current billing surface', async () => {
    const { client } = transactionalClient({
      commercialSubscriptionContract: { findFirst: jest.fn().mockResolvedValue(null) },
    })

    await expect(
      getCommercialBillingDashboardOverview({ organizationId: 'org-1', venueId: 'venue-1' }, { client: client as never }),
    ).resolves.toEqual({ schemaVersion: 1, state: 'NO_COMMERCIAL_CONTRACT' })
  })

  it('fails closed with no money projection when the persisted contract or Quote schema is unsupported', async () => {
    const incompatible = readyContract()
    incompatible.schemaVersion = 2
    const { client, tx } = transactionalClient({
      commercialSubscriptionContract: { findFirst: jest.fn().mockResolvedValue(incompatible) },
    })

    const result = await getCommercialBillingDashboardOverview({ organizationId: 'org-1', venueId: 'venue-1' }, { client: client as never })

    expect(result).toEqual({
      schemaVersion: 1,
      state: 'INCOMPATIBLE',
      supportCode: 'COMMERCIAL_BILLING_SCHEMA_UNSUPPORTED',
    })
    expect(tx.commercialSubscriptionPeriod.findMany).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(hugeMinor.toString())
  })

  it('paginates receipt history by cursor and scopes it through the current tenant contract', async () => {
    const receipts = [
      {
        id: 'receipt-3',
        provider: 'STRIPE',
        entryType: 'PAYMENT',
        amountMinor: 28884n,
        currency: 'MXN',
        observedAt: new Date('2026-09-03T18:00:00.000Z'),
        createdAt: new Date('2026-09-03T18:01:00.000Z'),
      },
      {
        id: 'receipt-2',
        provider: 'STRIPE',
        entryType: 'REFUND',
        amountMinor: 1000n,
        currency: 'MXN',
        observedAt: new Date('2026-09-02T18:00:00.000Z'),
        createdAt: new Date('2026-09-02T18:01:00.000Z'),
      },
      {
        id: 'receipt-1',
        provider: 'MANUAL_SPEI',
        entryType: 'PAYMENT',
        amountMinor: 24900n,
        currency: 'MXN',
        observedAt: new Date('2026-09-01T18:00:00.000Z'),
        createdAt: new Date('2026-09-01T18:01:00.000Z'),
      },
    ]
    const { client, tx } = transactionalClient()
    tx.commercialCashReceipt.findMany.mockResolvedValue(receipts)

    const result = await listCommercialBillingDashboardReceipts(
      { organizationId: 'org-1', venueId: 'venue-1', cursor: 'receipt-4', limit: 2 },
      { client: client as never },
    )

    expect(result).toEqual({
      schemaVersion: 1,
      state: 'READY',
      items: [
        expect.objectContaining({ id: 'receipt-3', amountMinor: '28884' }),
        expect.objectContaining({ id: 'receipt-2', amountMinor: '1000' }),
      ],
      nextCursor: 'receipt-2',
    })
    expect(tx.commercialCashReceipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          venueId: 'venue-1',
          allocations: { some: { receivable: { subscriptionPeriod: { contractId: 'contract-1' } } } },
        }),
        cursor: { id: 'receipt-4' },
        skip: 1,
        take: 3,
      }),
    )
  })

  it('fails receipt history closed before reading money when the current contract schema is unsupported', async () => {
    const incompatible = readyContract()
    incompatible.quoteAcceptance.quote.schemaVersion = 4
    const { client, tx } = transactionalClient({
      commercialSubscriptionContract: { findFirst: jest.fn().mockResolvedValue(incompatible) },
    })

    const result = await listCommercialBillingDashboardReceipts(
      { organizationId: 'org-1', venueId: 'venue-1', limit: 25 },
      { client: client as never },
    )

    expect(result).toEqual({
      schemaVersion: 1,
      state: 'INCOMPATIBLE',
      supportCode: 'COMMERCIAL_BILLING_SCHEMA_UNSUPPORTED',
    })
    expect(tx.commercialCashReceipt.findMany).not.toHaveBeenCalled()
  })
})
