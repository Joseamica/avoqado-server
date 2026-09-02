import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { Client } from 'pg'
import quoteFixtureJson from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-direct.json'
import { reconcileCommercialCashAdjustment } from '@/services/commercial/billing/cashAdjustment.service'
import { reconcileCommercialCashReceipt } from '@/services/commercial/billing/cashReceipt.service'
import {
  projectCommercialPaidEntitlements,
  projectCommercialReversedEntitlements,
} from '@/services/commercial/billing/entitlementProjection.service'
import {
  approveCommercialManualSpeiCase,
  createCommercialManualSpeiCase,
  registerCommercialManualSpeiEvidence,
  reviewCommercialManualSpeiEvidence,
  supersedeCommercialManualSpeiEvidence,
} from '@/services/commercial/billing/manualSpei.service'
import {
  buildCommercialSubscriptionContractSnapshotV1,
  createCommercialSubscriptionContract,
} from '@/services/commercial/billing/subscriptionContract.service'
import {
  getCommercialBillingDashboardOverview,
  listCommercialBillingDashboardReceipts,
} from '@/services/commercial/billing/commercialBillingDashboardRead.service'
import {
  createPrismaStripePaymentProviderRepository,
  createStripePaymentProviderAdapter,
} from '@/services/commercial/billing/stripePaymentProvider.adapter'
import type { CommercialQuoteSnapshotV3 } from '@/types/commercialQuoteV3'

jest.setTimeout(120_000)

const repoRoot = path.resolve(__dirname, '../../..')
const migrationPath = path.join(repoRoot, 'prisma/migrations/20260901130000_add_commercial_billing_core/migration.sql')
const migrationSql = readFileSync(migrationPath, 'utf8')
const manualSpeiMigrationSql = readFileSync(
  path.join(repoRoot, 'prisma/migrations/20260901150000_add_commercial_manual_spei/migration.sql'),
  'utf8',
)
const cashAdjustmentMigrationSql = readFileSync(
  path.join(repoRoot, 'prisma/migrations/20260901170000_harden_commercial_cash_adjustments/migration.sql'),
  'utf8',
)
const nonCashActivationMigrationSql = readFileSync(
  path.join(repoRoot, 'prisma/migrations/20260901190000_add_commercial_non_cash_activation/migration.sql'),
  'utf8',
)
const providerObjectIdentityMigrationSql = readFileSync(
  path.join(repoRoot, 'prisma/migrations/20260901200000_add_commercial_provider_object_identity/migration.sql'),
  'utf8',
)
const schemaName = `commercial_p3b_${process.pid}_${randomBytes(4).toString('hex')}`

function connectionString(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('DATABASE_URL is required for the commercial billing integration test')
  const url = new URL(raw)
  url.searchParams.delete('schema')
  return url.toString()
}

function schemaConnectionString(): string {
  const url = new URL(connectionString())
  url.searchParams.set('schema', schemaName)
  return url.toString()
}

async function expectConstraint(promise: Promise<unknown>, constraint: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: '23514', constraint })
}

describe('commercial billing core migration', () => {
  const client = new Client({ connectionString: connectionString() })
  let billingPrisma: PrismaClient

  beforeAll(async () => {
    await client.connect()
    await client.query(`CREATE SCHEMA "${schemaName}"`)
    await client.query(`SET search_path TO "${schemaName}"`)
    await client.query(`
      CREATE TABLE "Organization" ("id" text PRIMARY KEY);
      CREATE TABLE "Venue" (
        "id" text PRIMARY KEY,
        "organizationId" text NOT NULL REFERENCES "Organization"("id"),
        UNIQUE ("id", "organizationId")
      );
      CREATE TABLE "Staff" ("id" text PRIMARY KEY);
      CREATE TYPE "ActivityActorType" AS ENUM ('HUMAN', 'SERVICE');
      CREATE TYPE "OrganizationEntitlementStatus" AS ENUM ('ACTIVE', 'REVOKED');
      CREATE TYPE "OrganizationEntitlementSource" AS ENUM ('CONTRACT', 'CUSTOM');
      CREATE TYPE "CommercialQuoteAcceptanceStatus" AS ENUM (
        'ACCEPTED', 'STRIPE_PENDING', 'ACTIVE', 'FAILED', 'CANCELED', 'REFUNDED', 'DISPUTED'
      );
      CREATE TABLE "ActivityLog" (
        "id" text PRIMARY KEY,
        "staffId" text,
        "actorStaffId" text,
        "venueId" text,
        "organizationId" text,
        "actorType" "ActivityActorType",
        "servicePrincipalId" text,
        "action" text NOT NULL,
        "entity" text,
        "entityId" text,
        "data" jsonb,
        "ipAddress" text,
        "userAgent" text,
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE "OrganizationEntitlement" (
        "id" text PRIMARY KEY,
        "organizationId" text NOT NULL REFERENCES "Organization"("id"),
        "featureCode" text NOT NULL,
        "status" "OrganizationEntitlementStatus" NOT NULL DEFAULT 'REVOKED',
        "source" "OrganizationEntitlementSource" NOT NULL,
        "startsAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "endsAt" timestamp(3),
        "grantedById" text NOT NULL REFERENCES "Staff"("id"),
        "reason" text NOT NULL,
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamp(3) NOT NULL,
        UNIQUE ("organizationId", "featureCode")
      );
      CREATE TABLE "CommercialQuote" (
        "id" text PRIMARY KEY,
        "schemaVersion" integer NOT NULL DEFAULT 3,
        "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "checksum" char(64) NOT NULL UNIQUE,
        "listSubtotalMinor" bigint NOT NULL DEFAULT 0,
        "discountMinor" bigint NOT NULL DEFAULT 0,
        "subtotalMinor" bigint NOT NULL DEFAULT 0,
        "taxMinor" bigint NOT NULL DEFAULT 0,
        "totalMinor" bigint NOT NULL DEFAULT 0,
        "renewalSubtotalMinor" bigint NOT NULL DEFAULT 0,
        "renewalTaxMinor" bigint NOT NULL DEFAULT 0,
        "renewalTotalMinor" bigint NOT NULL DEFAULT 0
      );
      CREATE TABLE "CommercialQuoteAcceptance" (
        "id" text PRIMARY KEY,
        "quoteId" text NOT NULL UNIQUE REFERENCES "CommercialQuote"("id"),
        "idempotencyKey" text NOT NULL UNIQUE,
        "organizationId" text NOT NULL REFERENCES "Organization"("id"),
        "venueId" text NOT NULL REFERENCES "Venue"("id"),
        "acceptedById" text NOT NULL REFERENCES "Staff"("id"),
        "status" "CommercialQuoteAcceptanceStatus" NOT NULL DEFAULT 'ACCEPTED',
        "revision" integer NOT NULL DEFAULT 1,
        "acceptedAt" timestamp(3) NOT NULL,
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE ("id", "organizationId", "venueId")
      );
      CREATE TABLE "TerminalOrder" (
        "id" text PRIMARY KEY,
        "venueId" text NOT NULL REFERENCES "Venue"("id")
      );
    `)
    await client.query(migrationSql)
    await client.query(manualSpeiMigrationSql)
    await client.query(cashAdjustmentMigrationSql)
    await client.query(nonCashActivationMigrationSql)
    await client.query(providerObjectIdentityMigrationSql)
    await client.query(`
      INSERT INTO "Organization" ("id") VALUES ('org-1');
      INSERT INTO "Venue" ("id", "organizationId") VALUES ('venue-1', 'org-1');
      INSERT INTO "Staff" ("id") VALUES ('finance-1');
      INSERT INTO "CommercialQuote" ("id", "checksum") VALUES ('quote-1', repeat('9', 64));
      INSERT INTO "CommercialQuoteAcceptance" (
        "id", "quoteId", "idempotencyKey", "organizationId", "venueId", "acceptedById",
        "status", "acceptedAt"
      ) VALUES (
        'acceptance-1', 'quote-1', 'acceptance-key-1', 'org-1', 'venue-1', 'finance-1',
        'ACCEPTED', '2026-09-01T06:00:00Z'
      );

      INSERT INTO "CommercialSubscriptionContract" (
        "id", "quoteAcceptanceId", "idempotencyKey", "organizationId", "venueId",
        "schemaVersion", "snapshot", "checksum", "status", "cadence", "currency",
        "timezone", "startsAt", "createdAt", "updatedAt"
      ) VALUES (
        'contract-1', 'acceptance-1', 'contract-key-1', 'org-1', 'venue-1', 1,
        '{}'::jsonb, repeat('a', 64), 'ACTIVE', 'MONTHLY', 'MXN',
        'America/Mexico_City', '2026-09-01T06:00:00Z', now(), now()
      );

      INSERT INTO "CommercialSubscriptionPeriod" (
        "id", "contractId", "sequence", "startsAt", "endsAt", "dueAt", "graceEndsAt",
        "amountDueMinor", "currency", "status", "statusRevision", "createdAt", "updatedAt"
      ) VALUES (
        'period-1', 'contract-1', 1, '2026-09-01T06:00:00Z', '2026-10-01T06:00:00Z',
        '2026-09-01T06:00:00Z', '2026-09-06T06:00:00Z', 28884, 'MXN', 'OPEN', 1, now(), now()
      );

      INSERT INTO "CommercialAccountReceivable" (
        "id", "organizationId", "venueId", "subjectType", "subscriptionPeriodId",
        "reference", "amountDueMinor", "currency", "dueAt", "status", "createdAt", "updatedAt"
      ) VALUES (
        'ar-1', 'org-1', 'venue-1', 'SUBSCRIPTION_PERIOD', 'period-1',
        'AVQ-AR-1', 28884, 'MXN', '2026-09-01T06:00:00Z', 'OPEN', now(), now()
      );

      INSERT INTO "CommercialCashReceipt" (
        "id", "organizationId", "venueId", "provider", "providerEventId", "idempotencyKey",
        "entryType", "amountMinor", "currency", "receivingAccountFingerprint", "observedAt", "createdAt"
      ) VALUES (
        'receipt-1', 'org-1', 'venue-1', 'STRIPE', 'evt-1', 'receipt-key-1',
        'PAYMENT', 30000, 'MXN', repeat('b', 64), '2026-09-01T06:01:00Z', now()
      );
    `)
    billingPrisma = new PrismaClient({ datasources: { db: { url: schemaConnectionString() } } })
    await billingPrisma.$connect()
  })

  afterAll(async () => {
    await billingPrisma.$disconnect()
    await client.query('SET search_path TO public')
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    await client.end()
  })

  it('installs the provider-neutral billing authorities', async () => {
    const result = await client.query<{ table_name: string }>(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_name LIKE 'Commercial%'
      ORDER BY table_name
    `,
      [schemaName],
    )

    expect(result.rows.map(row => row.table_name)).toEqual(
      expect.arrayContaining([
        'CommercialSubscriptionContract',
        'CommercialAccountReceivable',
        'CommercialBillingPaymentAttempt',
        'CommercialCashReceipt',
        'CommercialBillingAllocation',
        'CommercialSubscriptionPeriod',
        'CommercialEventOutbox',
        'CommercialEntitlementProjection',
        'CommercialManualSpeiPolicyVersion',
        'CommercialManualSpeiPolicyActivation',
        'CommercialManualSpeiCase',
        'CommercialManualSpeiEvidence',
        'CommercialManualSpeiEvidenceReview',
        'CommercialManualSpeiApproval',
      ]),
    )
  })

  it('persists an accepted quote as a pending contract, period and receivable without granting access', async () => {
    const acceptedAt = new Date('2027-02-01T06:00:00.000Z')
    const quoteChecksum = 'f'.repeat(64)
    const quote = structuredClone(quoteFixtureJson) as CommercialQuoteSnapshotV3
    quote.quoteId = 'quote-contract-real-1'
    quote.subject.organizationId = 'org-1'
    quote.subject.venueId = 'venue-1'
    quote.subject.actorId = 'finance-1'
    const snapshot = buildCommercialSubscriptionContractSnapshotV1({
      acceptanceId: 'acceptance-contract-real-1',
      quoteChecksum,
      quote,
      timezone: 'America/Mexico_City',
      startsAt: acceptedAt,
    })

    await client.query(
      `INSERT INTO "CommercialQuote" (
         "id", "schemaVersion", "snapshot", "checksum",
         "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
         "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor"
       ) VALUES ($1, 3, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        quote.quoteId,
        JSON.stringify(quote),
        quoteChecksum,
        quote.totals.dueNow.listSubtotalMinor,
        quote.totals.dueNow.discountMinor,
        quote.totals.dueNow.subtotalMinor,
        quote.totals.dueNow.taxMinor,
        quote.totals.dueNow.totalMinor,
        quote.renewal.subtotalMinor,
        quote.renewal.taxMinor,
        quote.renewal.totalMinor,
      ],
    )
    await client.query(
      `INSERT INTO "CommercialQuoteAcceptance" (
         "id", "quoteId", "idempotencyKey", "organizationId", "venueId", "acceptedById",
         "status", "acceptedAt"
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACCEPTED', $7)`,
      [
        snapshot.acceptanceId,
        quote.quoteId,
        'acceptance-contract-real-key-1',
        'org-1',
        'venue-1',
        'finance-1',
        acceptedAt.toISOString().replace(/Z$/u, ''),
      ],
    )

    const input = {
      snapshot,
      idempotencyKey: 'contract-real-key-1',
      graceDays: 5,
    }
    const created = await createCommercialSubscriptionContract(input, { host: billingPrisma })
    const replay = await createCommercialSubscriptionContract(input, { host: billingPrisma })

    expect(created).toMatchObject({
      decision: 'CREATED',
      periods: [
        {
          scheduleKey: 'SAAS_MONTHLY',
          amountDueMinor: 20_880n,
        },
      ],
    })
    expect(replay).toEqual({ ...created, decision: 'REPLAY' })

    const evidence = await client.query<{
      contracts: string
      periods: string
      receivables: string
      events: string
      audits: string
      contractStatus: string
      periodStatus: string
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text FROM "CommercialSubscriptionContract" WHERE "quoteAcceptanceId" = $1) AS contracts,
        (SELECT COUNT(*)::text FROM "CommercialSubscriptionPeriod" WHERE "contractId" = $2) AS periods,
        (SELECT COUNT(*)::text
           FROM "CommercialAccountReceivable" AS ar
           JOIN "CommercialSubscriptionPeriod" AS period ON period."id" = ar."subscriptionPeriodId"
          WHERE period."contractId" = $2) AS receivables,
        (SELECT COUNT(*)::text FROM "CommercialEventOutbox" WHERE "organizationId" = 'org-1') AS events,
        (SELECT COUNT(*)::text FROM "ActivityLog" WHERE "entityId" = $2) AS audits,
        (SELECT "status"::text FROM "CommercialSubscriptionContract" WHERE "id" = $2) AS "contractStatus",
        (SELECT "status"::text FROM "CommercialSubscriptionPeriod" WHERE "contractId" = $2) AS "periodStatus"
    `,
      [snapshot.acceptanceId, created.contractId],
    )
    expect(evidence.rows[0]).toEqual({
      contracts: '1',
      periods: '1',
      receivables: '1',
      events: '0',
      audits: '1',
      contractStatus: 'PENDING_PAYMENT',
      periodStatus: 'OPEN',
    })

    const [firstPeriod] = created.periods
    if (!firstPeriod) throw new Error('COMMERCIAL_BILLING_TEST_PERIOD_MISSING')
    await client.query(
      `INSERT INTO "CommercialBillingPaymentAttempt" (
         "id", "receivableId", "provider", "providerAttemptId", "idempotencyKey", "status",
         "amountMinor", "currency", "requestFingerprint", "createdAt", "updatedAt"
       ) VALUES (
         'attempt-contract-real-1', $1, 'STRIPE', 'in_contract_real_1',
         'attempt-contract-real-key-1', 'PENDING', 20880, 'MXN', repeat('7', 64), now(), now()
       )`,
      [firstPeriod.receivableId],
    )
    const reconciliation = await reconcileCommercialCashReceipt(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivableId: firstPeriod.receivableId,
        paymentAttemptId: 'attempt-contract-real-1',
        idempotencyKey: 'receipt-contract-real-key-1',
        observation: {
          provider: 'STRIPE',
          providerEventId: 'evt-contract-real-paid-1',
          amountMinor: 20_880n,
          currency: 'MXN',
          receivingAccountFingerprint: '8'.repeat(64),
          observedAt: new Date('2027-02-01T06:01:00.000Z'),
        },
        now: new Date('2027-02-01T06:01:01.000Z'),
      },
      { host: billingPrisma },
    )
    if (!reconciliation.eventId) throw new Error('COMMERCIAL_BILLING_TEST_EVENT_MISSING')

    // The synthetic baseline contract exercises only ledger primitives and has
    // no canonical snapshot. It must not participate in organization coverage.
    await client.query(`UPDATE "CommercialSubscriptionContract" SET "status" = 'CANCELED' WHERE "id" = 'contract-1'`)

    const projected = await projectCommercialPaidEntitlements(
      { eventId: reconciliation.eventId, now: new Date('2027-02-01T06:01:02.000Z') },
      { host: billingPrisma },
    )
    const projectionReplay = await projectCommercialPaidEntitlements(
      { eventId: reconciliation.eventId, now: new Date('2027-02-01T06:01:03.000Z') },
      { host: billingPrisma },
    )

    expect(projected).toEqual({
      decision: 'PROJECTED',
      eventId: reconciliation.eventId,
      grants: [
        {
          featureCode: 'POS_CORE',
          coverageStartsAt: acceptedAt,
          coverageEndsAt: new Date('2027-03-01T06:00:00.000Z'),
        },
      ],
    })
    expect(projectionReplay).toEqual({ ...projected, decision: 'REPLAY' })

    const paidEvidence = await client.query<{
      receipts: string
      events: string
      projections: string
      entitlements: string
      entitlementStatus: string
      entitlementSource: string
      entitlementEndsAt: string
      contractStatus: string
      attemptStatus: string
      receiptAttemptId: string
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text FROM "CommercialCashReceipt" WHERE "providerEventId" = 'evt-contract-real-paid-1') AS receipts,
        (SELECT COUNT(*)::text FROM "CommercialEventOutbox" WHERE "eventId" = $1) AS events,
        (SELECT COUNT(*)::text FROM "CommercialEntitlementProjection" WHERE "eventId" = $1) AS projections,
        (SELECT COUNT(*)::text FROM "OrganizationEntitlement" WHERE "organizationId" = 'org-1' AND "featureCode" = 'POS_CORE') AS entitlements,
        (SELECT "status"::text FROM "OrganizationEntitlement" WHERE "organizationId" = 'org-1' AND "featureCode" = 'POS_CORE') AS "entitlementStatus",
        (SELECT "source"::text FROM "OrganizationEntitlement" WHERE "organizationId" = 'org-1' AND "featureCode" = 'POS_CORE') AS "entitlementSource",
        (SELECT to_char("endsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           FROM "OrganizationEntitlement"
          WHERE "organizationId" = 'org-1' AND "featureCode" = 'POS_CORE') AS "entitlementEndsAt"
        ,(SELECT "status"::text FROM "CommercialSubscriptionContract" WHERE "id" = $2) AS "contractStatus"
        ,(SELECT "status"::text FROM "CommercialBillingPaymentAttempt" WHERE "id" = 'attempt-contract-real-1') AS "attemptStatus"
        ,(SELECT "paymentAttemptId" FROM "CommercialCashReceipt" WHERE "providerEventId" = 'evt-contract-real-paid-1') AS "receiptAttemptId"
    `,
      [reconciliation.eventId, created.contractId],
    )
    expect(paidEvidence.rows[0]).toEqual({
      receipts: '1',
      events: '1',
      projections: '1',
      entitlements: '1',
      entitlementStatus: 'ACTIVE',
      entitlementSource: 'CONTRACT',
      entitlementEndsAt: '2027-03-01T06:00:00.000Z',
      contractStatus: 'ACTIVE',
      attemptStatus: 'SUCCEEDED',
      receiptAttemptId: 'attempt-contract-real-1',
    })

    const customerOverview = await getCommercialBillingDashboardOverview(
      { organizationId: 'org-1', venueId: 'venue-1' },
      { client: billingPrisma },
    )
    expect(customerOverview).toMatchObject({
      schemaVersion: 1,
      state: 'READY',
      collectionState: 'CURRENT',
      contract: {
        id: created.contractId,
        status: 'ACTIVE',
        today: { totalMinor: '20880' },
        renewal: { totalMinor: '28884' },
        entitlements: ['POS_CORE'],
      },
      obligations: [],
      recentReceipts: [expect.objectContaining({ amountMinor: '20880', provider: 'STRIPE' })],
    })
    const customerReceipts = await listCommercialBillingDashboardReceipts(
      { organizationId: 'org-1', venueId: 'venue-1', limit: 25 },
      { client: billingPrisma },
    )
    expect(customerReceipts).toMatchObject({
      schemaVersion: 1,
      state: 'READY',
      items: [expect.objectContaining({ amountMinor: '20880', provider: 'STRIPE' })],
      nextCursor: null,
    })

    await expectConstraint(
      client.query(`UPDATE "CommercialEntitlementProjection" SET "coverageEndsAt" = now() WHERE "eventId" = $1`, [reconciliation.eventId]),
      'CommercialEntitlementProjection_append_only_check',
    )
  })

  it('activates an accepted zero-priced period without cash and projects its entitlement from a distinct event', async () => {
    const acceptedAt = new Date('2027-03-01T06:00:00.000Z')
    const quoteId = 'quote-free-real-1'
    const quoteChecksum = '8'.repeat(64)
    const snapshot = {
      schemaVersion: 1 as const,
      contractVersion: '1.0.0' as const,
      acceptanceId: 'acceptance-free-real-1',
      quoteId,
      quoteChecksum,
      organizationId: 'org-1',
      venueId: 'venue-1',
      currency: 'MXN' as const,
      timezone: 'America/Mexico_City',
      startsAt: acceptedAt.toISOString(),
      cadence: 'MONTHLY' as const,
      schedules: [
        {
          scheduleKey: 'SAAS_MONTHLY' as const,
          cadence: 'MONTHLY' as const,
          firstPeriodAmountMinor: '0',
          renewalAmountMinor: '0',
        },
      ],
      entitlements: [{ featureCode: 'POS_FREE', requiredScheduleKeys: ['SAAS_MONTHLY' as const] }],
    }

    await client.query(`INSERT INTO "CommercialQuote" ("id", "checksum") VALUES ($1, $2)`, [quoteId, quoteChecksum])
    await client.query(
      `INSERT INTO "CommercialQuoteAcceptance" (
         "id", "quoteId", "idempotencyKey", "organizationId", "venueId", "acceptedById",
         "status", "acceptedAt"
       ) VALUES ($1, $2, $3, 'org-1', 'venue-1', 'finance-1', 'ACCEPTED', $4)`,
      [snapshot.acceptanceId, quoteId, 'acceptance-free-real-key-1', acceptedAt.toISOString().replace(/Z$/u, '')],
    )

    const created = await createCommercialSubscriptionContract(
      { snapshot, idempotencyKey: 'contract-free-real-key-1', graceDays: 5 },
      { host: billingPrisma },
    )
    const zeroPeriod = created.periods[0]!
    const period = await billingPrisma.commercialSubscriptionPeriod.findUniqueOrThrow({
      where: { id: zeroPeriod.periodId },
      select: { status: true, statusRevision: true, paidAt: true },
    })
    const receivable = await billingPrisma.commercialAccountReceivable.findUniqueOrThrow({
      where: { id: zeroPeriod.receivableId },
      select: { status: true },
    })
    const event = await billingPrisma.commercialEventOutbox.findFirstOrThrow({
      where: {
        sourceId: zeroPeriod.periodId,
        eventType: 'SUBSCRIPTION_NON_CASH_ACTIVATED',
      },
      select: { eventId: true, sourceRevision: true, payload: true },
    })

    expect(period).toEqual({ status: 'PAID', statusRevision: 2, paidAt: acceptedAt })
    expect(receivable.status).toBe('PAID')
    expect(event).toMatchObject({
      sourceRevision: 2,
      payload: expect.objectContaining({ activationBasis: 'ZERO_AMOUNT_ACCEPTED_OFFER', amountDueMinor: '0' }),
    })
    await expect(billingPrisma.commercialCashReceipt.count({ where: { organizationId: 'org-1', observedAt: acceptedAt } })).resolves.toBe(0)
    await expect(billingPrisma.commercialBillingAllocation.count({ where: { receivableId: zeroPeriod.receivableId } })).resolves.toBe(0)
    await expect(billingPrisma.commercialBillingPaymentAttempt.count({ where: { receivableId: zeroPeriod.receivableId } })).resolves.toBe(0)

    await expect(
      projectCommercialPaidEntitlements({ eventId: event.eventId, now: acceptedAt }, { host: billingPrisma }),
    ).resolves.toMatchObject({
      decision: 'PROJECTED',
      grants: [{ featureCode: 'POS_FREE' }],
    })
    await expect(
      billingPrisma.organizationEntitlement.findUnique({
        where: { organizationId_featureCode: { organizationId: 'org-1', featureCode: 'POS_FREE' } },
        select: { status: true, source: true },
      }),
    ).resolves.toEqual({ status: 'ACTIVE', source: 'CONTRACT' })
  })

  it('rejects a forged non-cash event for a positive receivable at the database boundary', async () => {
    await expectConstraint(
      client.query(
        `INSERT INTO "CommercialEventOutbox" (
           "id", "eventId", "organizationId", "venueId", "sourceType", "sourceId",
           "sourceRevision", "eventType", "payload", "createdAt", "updatedAt"
         ) VALUES ($1, $2, 'org-1', 'venue-1', 'SUBSCRIPTION_PERIOD', 'period-1', 1,
                   'SUBSCRIPTION_NON_CASH_ACTIVATED', $3::jsonb, now(), now())`,
        [
          'forged-non-cash-outbox-1',
          '7'.repeat(64),
          JSON.stringify({
            schemaVersion: 1,
            contractId: 'contract-1',
            periodId: 'period-1',
            sourceRevision: 1,
            activationBasis: 'ZERO_AMOUNT_ACCEPTED_OFFER',
            amountDueMinor: '0',
          }),
        ],
      ),
      'CommercialEventOutbox_non_cash_source_check',
    )
  })

  it('resolves a signed Stripe refund through immutable provider aliases and the neutral reversal ledger', async () => {
    await client.query(`
      INSERT INTO "CommercialQuote" ("id", "checksum") VALUES ('quote-stripe-refund-1', repeat('6', 64));
      INSERT INTO "CommercialQuoteAcceptance" (
        "id", "quoteId", "idempotencyKey", "organizationId", "venueId", "acceptedById", "status", "acceptedAt"
      ) VALUES (
        'acceptance-stripe-refund-1', 'quote-stripe-refund-1', 'acceptance-stripe-refund-key-1',
        'org-1', 'venue-1', 'finance-1', 'ACCEPTED', '2027-04-01T06:00:00Z'
      );
      INSERT INTO "CommercialSubscriptionContract" (
        "id", "quoteAcceptanceId", "idempotencyKey", "organizationId", "venueId", "schemaVersion",
        "snapshot", "checksum", "status", "cadence", "currency", "timezone", "startsAt", "createdAt", "updatedAt"
      ) VALUES (
        'contract-stripe-refund-1', 'acceptance-stripe-refund-1', 'contract-stripe-refund-key-1',
        'org-1', 'venue-1', 1, '{}'::jsonb, repeat('5', 64), 'PENDING_PAYMENT', 'MONTHLY', 'MXN',
        'America/Mexico_City', '2027-04-01T06:00:00Z', now(), now()
      );
      INSERT INTO "CommercialSubscriptionPeriod" (
        "id", "contractId", "sequence", "startsAt", "endsAt", "dueAt", "graceEndsAt",
        "amountDueMinor", "currency", "status", "statusRevision", "createdAt", "updatedAt"
      ) VALUES (
        'period-stripe-refund-1', 'contract-stripe-refund-1', 1, '2027-04-01T06:00:00Z', '2027-05-01T06:00:00Z',
        '2027-04-01T06:00:00Z', '2027-04-06T06:00:00Z', 10000, 'MXN', 'OPEN', 1, now(), now()
      );
      INSERT INTO "CommercialAccountReceivable" (
        "id", "organizationId", "venueId", "subjectType", "subscriptionPeriodId", "reference",
        "amountDueMinor", "currency", "dueAt", "status", "createdAt", "updatedAt"
      ) VALUES (
        'ar-stripe-refund-1', 'org-1', 'venue-1', 'SUBSCRIPTION_PERIOD', 'period-stripe-refund-1',
        'AVQ-STRIPE-REFUND-1', 10000, 'MXN', '2027-04-01T06:00:00Z', 'OPEN', now(), now()
      );
      INSERT INTO "CommercialBillingPaymentAttempt" (
        "id", "receivableId", "provider", "idempotencyKey", "status", "amountMinor", "currency",
        "requestFingerprint", "createdAt", "updatedAt"
      ) VALUES (
        'attempt-stripe-refund-1', 'ar-stripe-refund-1', 'STRIPE', 'attempt-stripe-refund-key-1',
        'PENDING', 10000, 'MXN', repeat('4', 64), now(), now()
      );
    `)

    const paid = await reconcileCommercialCashReceipt(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivableId: 'ar-stripe-refund-1',
        paymentAttemptId: 'attempt-stripe-refund-1',
        paymentAttemptProviderId: 'in_stripe_refund_real_1',
        idempotencyKey: 'receipt-stripe-refund-key-1',
        observation: {
          provider: 'STRIPE',
          providerEventId: 'evt_invoice_paid_refund_real_1',
          amountMinor: 10_000n,
          currency: 'MXN',
          receivingAccountFingerprint: '3'.repeat(64),
          observedAt: new Date('2027-04-01T06:01:00.000Z'),
        },
        providerObjectReferences: [
          { objectType: 'INVOICE', objectId: 'in_stripe_refund_real_1' },
          { objectType: 'PAYMENT_INTENT', objectId: 'pi_stripe_refund_real_1' },
          { objectType: 'CHARGE', objectId: 'ch_stripe_refund_real_1' },
        ],
        now: new Date('2027-04-01T06:01:01.000Z'),
      },
      { host: billingPrisma },
    )
    await expect(billingPrisma.commercialBillingProviderObject.count({ where: { cashReceiptId: paid.receiptId } })).resolves.toBe(3)

    const adapter = createStripePaymentProviderAdapter({
      repository: createPrismaStripePaymentProviderRepository(billingPrisma),
      reconcileCash: input => reconcileCommercialCashReceipt(input, { host: billingPrisma }),
      reconcileAdjustment: input => reconcileCommercialCashAdjustment(input, { host: billingPrisma }),
      receivingAccountFingerprint: '3'.repeat(64),
      now: () => new Date('2027-04-02T06:01:01.000Z'),
    })
    const result = await adapter.reconcile({
      id: 'evt_refund_real_1',
      type: 'refund.updated',
      created: Math.floor(new Date('2027-04-02T06:01:00.000Z').getTime() / 1000),
      data: {
        object: {
          id: 're_stripe_refund_real_1',
          object: 'refund',
          amount: 4_000,
          currency: 'mxn',
          status: 'succeeded',
          charge: 'ch_stripe_refund_real_1',
          payment_intent: 'pi_stripe_refund_real_1',
        },
      },
    } as never)

    expect(result).toMatchObject({ matched: true, applied: true })
    await expect(
      billingPrisma.commercialCashReceipt.findUniqueOrThrow({
        where: { id: result.matched ? result.receiptId : '' },
        select: { entryType: true, relatedReceiptId: true, amountMinor: true },
      }),
    ).resolves.toEqual({ entryType: 'REFUND', relatedReceiptId: paid.receiptId, amountMinor: 4_000n })
    await expect(
      billingPrisma.commercialSubscriptionPeriod.findUniqueOrThrow({
        where: { id: 'period-stripe-refund-1' },
        select: { status: true, statusRevision: true },
      }),
    ).resolves.toEqual({ status: 'PAST_DUE', statusRevision: 3 })

    // This adapter-only fixture bypasses the canonical contract writer and has
    // an intentionally empty snapshot. Retire it before the entitlement rebuild
    // scenario so that the fail-closed projector never treats synthetic state as
    // a real active commercial contract.
    await billingPrisma.commercialSubscriptionContract.update({
      where: { id: 'contract-stripe-refund-1' },
      data: { status: 'CANCELED' },
    })
  })

  it('projects a refund reversal into immutable evidence and revokes the rebuilt paid entitlement', async () => {
    const originalReceipt = await billingPrisma.commercialCashReceipt.findUnique({
      where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: 'evt-contract-real-paid-1' } },
      select: { id: true },
    })
    if (!originalReceipt) throw new Error('COMMERCIAL_BILLING_TEST_ORIGINAL_RECEIPT_MISSING')

    const adjustment = await reconcileCommercialCashAdjustment(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        originalReceiptId: originalReceipt.id,
        idempotencyKey: 'refund-contract-real-key-1',
        observation: {
          provider: 'STRIPE',
          providerEventId: 'evt-contract-real-refund-1',
          entryType: 'REFUND',
          amountMinor: 10_000n,
          currency: 'MXN',
          receivingAccountFingerprint: '8'.repeat(64),
          observedAt: new Date('2027-02-02T06:01:00.000Z'),
        },
        now: new Date('2027-02-02T06:01:01.000Z'),
      },
      { host: billingPrisma },
    )
    if (!adjustment.eventId) throw new Error('COMMERCIAL_BILLING_TEST_REVERSAL_EVENT_MISSING')

    // The synthetic baseline contract exists only to test the ledger primitives
    // and intentionally has no canonical snapshot. It is not a current paid
    // commercial contract and must not participate in the rebuilt summary.
    await client.query(`UPDATE "CommercialSubscriptionContract" SET "status" = 'CANCELED' WHERE "id" = 'contract-1'`)
    const projected = await projectCommercialReversedEntitlements(
      { eventId: adjustment.eventId, now: new Date('2027-02-02T06:01:02.000Z') },
      { host: billingPrisma },
    )
    const replay = await projectCommercialReversedEntitlements(
      { eventId: adjustment.eventId, now: new Date('2027-02-02T06:01:03.000Z') },
      { host: billingPrisma },
    )
    expect(projected).toEqual({
      decision: 'PROJECTED',
      eventId: adjustment.eventId,
      revocations: [
        {
          featureCode: 'POS_CORE',
          coverageStartsAt: new Date('2027-02-01T06:00:00.000Z'),
          coverageEndsAt: new Date('2027-03-01T06:00:00.000Z'),
        },
      ],
    })
    expect(replay).toEqual({ ...projected, decision: 'REPLAY' })
    const reversalEvent = await billingPrisma.commercialEventOutbox.findUnique({
      where: { eventId: adjustment.eventId },
      select: { sourceId: true },
    })
    if (!reversalEvent) throw new Error('COMMERCIAL_BILLING_TEST_REVERSAL_OUTBOX_MISSING')

    const evidence = await client.query<{
      revocations: string
      entitlementStatus: string
      entitlementEndsAt: string
      contractStatus: string
      periodStatus: string
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text FROM "CommercialEntitlementProjection"
          WHERE "eventId" = $1 AND "action" = 'REVOKE') AS revocations,
        (SELECT "status"::text FROM "OrganizationEntitlement"
          WHERE "organizationId" = 'org-1' AND "featureCode" = 'POS_CORE') AS "entitlementStatus",
        (SELECT to_char("endsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM "OrganizationEntitlement"
          WHERE "organizationId" = 'org-1' AND "featureCode" = 'POS_CORE') AS "entitlementEndsAt",
        (SELECT "status"::text FROM "CommercialSubscriptionContract"
          WHERE "id" = (SELECT "contractId" FROM "CommercialSubscriptionPeriod" WHERE "id" = $2)) AS "contractStatus",
        (SELECT "status"::text FROM "CommercialSubscriptionPeriod" WHERE "id" = $2) AS "periodStatus"
    `,
      [adjustment.eventId, reversalEvent.sourceId],
    )
    expect(evidence.rows[0]).toEqual({
      revocations: '1',
      entitlementStatus: 'REVOKED',
      entitlementEndsAt: '2027-02-02T06:01:02.000Z',
      contractStatus: 'PAUSED',
      periodStatus: 'PAST_DUE',
    })
  })

  it('reactivates the same contract and entitlement when reversed coverage is paid again', async () => {
    const receivable = await billingPrisma.commercialAccountReceivable.findFirstOrThrow({
      where: {
        subscriptionPeriod: { contract: { quoteAcceptanceId: 'acceptance-contract-real-1' } },
      },
      select: { id: true },
    })
    const reinstated = await reconcileCommercialCashReceipt(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivableId: receivable.id,
        idempotencyKey: 'receipt-contract-real-reinstated-key-1',
        observation: {
          provider: 'STRIPE',
          providerEventId: 'evt-contract-real-reinstated-1',
          amountMinor: 10_000n,
          currency: 'MXN',
          receivingAccountFingerprint: '8'.repeat(64),
          observedAt: new Date('2027-02-03T06:01:00.000Z'),
        },
        now: new Date('2027-02-03T06:01:01.000Z'),
      },
      { host: billingPrisma },
    )
    if (!reinstated.eventId) throw new Error('COMMERCIAL_BILLING_TEST_REINSTATEMENT_EVENT_MISSING')

    await expect(
      projectCommercialPaidEntitlements(
        { eventId: reinstated.eventId, now: new Date('2027-02-03T06:01:02.000Z') },
        { host: billingPrisma },
      ),
    ).resolves.toEqual({
      decision: 'PROJECTED',
      eventId: reinstated.eventId,
      grants: [
        {
          featureCode: 'POS_CORE',
          coverageStartsAt: new Date('2027-02-01T06:00:00.000Z'),
          coverageEndsAt: new Date('2027-03-01T06:00:00.000Z'),
        },
      ],
    })

    const evidence = await client.query<{
      grants: string
      entitlementStatus: string
      entitlementEndsAt: string
      contractStatus: string
      periodStatus: string
      periodRevision: number
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text FROM "CommercialEntitlementProjection"
          WHERE "eventId" = $1 AND "action" = 'GRANT') AS grants,
        (SELECT "status"::text FROM "OrganizationEntitlement"
          WHERE "organizationId" = 'org-1' AND "featureCode" = 'POS_CORE') AS "entitlementStatus",
        (SELECT to_char("endsAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM "OrganizationEntitlement"
          WHERE "organizationId" = 'org-1' AND "featureCode" = 'POS_CORE') AS "entitlementEndsAt",
        (SELECT "status"::text FROM "CommercialSubscriptionContract"
          WHERE "quoteAcceptanceId" = 'acceptance-contract-real-1') AS "contractStatus",
        (SELECT "status"::text FROM "CommercialSubscriptionPeriod"
          WHERE "id" = (SELECT "subscriptionPeriodId" FROM "CommercialAccountReceivable" WHERE "id" = $2)) AS "periodStatus",
        (SELECT "statusRevision" FROM "CommercialSubscriptionPeriod"
          WHERE "id" = (SELECT "subscriptionPeriodId" FROM "CommercialAccountReceivable" WHERE "id" = $2)) AS "periodRevision"
    `,
      [reinstated.eventId, receivable.id],
    )
    expect(evidence.rows[0]).toEqual({
      grants: '1',
      entitlementStatus: 'ACTIVE',
      entitlementEndsAt: '2027-03-01T06:00:00.000Z',
      contractStatus: 'ACTIVE',
      periodStatus: 'PAID',
      periodRevision: 4,
    })
  })

  it('rejects a receivable with no exact billing subject', async () => {
    await expectConstraint(
      client.query(`
        INSERT INTO "CommercialAccountReceivable" (
          "id", "organizationId", "venueId", "subjectType", "reference", "amountDueMinor",
          "currency", "dueAt", "status", "createdAt", "updatedAt"
        ) VALUES (
          'ar-invalid', 'org-1', 'venue-1', 'SUBSCRIPTION_PERIOD', 'AVQ-AR-INVALID',
          10000, 'MXN', now(), 'OPEN', now(), now()
        )
      `),
      'CommercialAccountReceivable_subject_check',
    )
  })

  it('refunds overpayment first, then reverses paid coverage once and replays safely', async () => {
    await client.query(`
      INSERT INTO "CommercialSubscriptionPeriod" (
        "id", "contractId", "sequence", "startsAt", "endsAt", "dueAt", "graceEndsAt",
        "amountDueMinor", "currency", "status", "statusRevision", "createdAt", "updatedAt"
      ) VALUES (
        'period-adjustment-1', 'contract-1', 6,
        '2027-02-01T06:00:00Z', '2027-03-01T06:00:00Z',
        '2027-02-01T06:00:00Z', '2027-02-06T06:00:00Z',
        28884, 'MXN', 'OPEN', 1, now(), now()
      );
      INSERT INTO "CommercialAccountReceivable" (
        "id", "organizationId", "venueId", "subjectType", "subscriptionPeriodId",
        "reference", "amountDueMinor", "currency", "dueAt", "status", "createdAt", "updatedAt"
      ) VALUES (
        'ar-adjustment-1', 'org-1', 'venue-1', 'SUBSCRIPTION_PERIOD', 'period-adjustment-1',
        'AVQ-AR-ADJUSTMENT-1', 28884, 'MXN', '2027-02-01T06:00:00Z', 'OPEN', now(), now()
      );
    `)
    const payment = await reconcileCommercialCashReceipt(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivableId: 'ar-adjustment-1',
        idempotencyKey: 'adjustment-payment-key-1',
        observation: {
          provider: 'STRIPE',
          providerEventId: 'evt-adjustment-payment-1',
          amountMinor: 30_000n,
          currency: 'MXN',
          receivingAccountFingerprint: '2'.repeat(64),
          observedAt: new Date('2027-02-01T06:01:00.000Z'),
        },
        now: new Date('2027-02-01T06:01:01.000Z'),
      },
      { host: billingPrisma },
    )
    expect(payment).toMatchObject({
      decision: 'RECONCILED',
      allocatedMinor: 28_884n,
      periodStatus: 'PAID',
    })

    const overpaymentRefund = await reconcileCommercialCashAdjustment(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        originalReceiptId: payment.receiptId,
        idempotencyKey: 'adjustment-refund-overpayment-key-1',
        observation: {
          provider: 'STRIPE',
          providerEventId: 'evt-adjustment-refund-overpayment-1',
          entryType: 'REFUND',
          amountMinor: 1_116n,
          currency: 'MXN',
          receivingAccountFingerprint: '2'.repeat(64),
          observedAt: new Date('2027-02-01T06:02:00.000Z'),
        },
        now: new Date('2027-02-01T06:02:01.000Z'),
      },
      { host: billingPrisma },
    )
    expect(overpaymentRefund).toMatchObject({
      debitMinor: 0n,
      receivableStatus: 'PAID',
      periodStatus: 'PAID',
      eventId: null,
    })

    const adjustmentInput = {
      organizationId: 'org-1',
      venueId: 'venue-1',
      originalReceiptId: payment.receiptId,
      idempotencyKey: 'adjustment-refund-coverage-key-1',
      observation: {
        provider: 'STRIPE' as const,
        providerEventId: 'evt-adjustment-refund-coverage-1',
        entryType: 'REFUND' as const,
        amountMinor: 10_000n,
        currency: 'MXN' as const,
        receivingAccountFingerprint: '2'.repeat(64),
        observedAt: new Date('2027-02-01T06:03:00.000Z'),
      },
      now: new Date('2027-02-01T06:03:01.000Z'),
    }
    const coverageRefund = await reconcileCommercialCashAdjustment(adjustmentInput, { host: billingPrisma })
    const replay = await reconcileCommercialCashAdjustment(adjustmentInput, { host: billingPrisma })
    expect(coverageRefund).toMatchObject({
      decision: 'ADJUSTED',
      debitMinor: 10_000n,
      receivableStatus: 'PARTIALLY_PAID',
      periodStatus: 'PAST_DUE',
      eventId: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(replay).toEqual({ ...coverageRefund, decision: 'REPLAY' })

    const evidence = await client.query<{
      adjustments: string
      debits: string
      events: string
      activeAllocatedMinor: string
      periodRevision: number
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text FROM "CommercialCashReceipt" WHERE "relatedReceiptId" = $1) AS adjustments,
        (SELECT COUNT(*)::text
           FROM "CommercialBillingAllocation" AS allocation
           JOIN "CommercialCashReceipt" AS receipt ON receipt."id" = allocation."cashReceiptId"
          WHERE receipt."relatedReceiptId" = $1 AND allocation."direction" = 'DEBIT') AS debits,
        (SELECT COUNT(*)::text FROM "CommercialEventOutbox"
          WHERE "sourceId" = 'period-adjustment-1'
            AND "eventType" = 'SUBSCRIPTION_PAYMENT_COVERAGE_REVERSED') AS events,
        (SELECT SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountMinor" ELSE -"amountMinor" END)::text
           FROM "CommercialBillingAllocation" WHERE "receivableId" = 'ar-adjustment-1') AS "activeAllocatedMinor",
        (SELECT "statusRevision" FROM "CommercialSubscriptionPeriod" WHERE "id" = 'period-adjustment-1') AS "periodRevision"
    `,
      [payment.receiptId],
    )
    expect(evidence.rows[0]).toEqual({
      adjustments: '2',
      debits: '1',
      events: '1',
      activeAllocatedMinor: '18884',
      periodRevision: 3,
    })
  })

  it('refunds a fully unallocated provider receipt through its immutable payment-attempt subject', async () => {
    await client.query(`
      INSERT INTO "CommercialSubscriptionPeriod" (
        "id", "contractId", "sequence", "startsAt", "endsAt", "dueAt", "graceEndsAt",
        "amountDueMinor", "currency", "status", "statusRevision", "createdAt", "updatedAt"
      ) VALUES (
        'period-unallocated-refund-1', 'contract-1', 7,
        '2027-03-01T06:00:00Z', '2027-04-01T06:00:00Z',
        '2027-03-01T06:00:00Z', '2027-03-06T06:00:00Z',
        10000, 'MXN', 'OPEN', 1, now(), now()
      );
      INSERT INTO "CommercialAccountReceivable" (
        "id", "organizationId", "venueId", "subjectType", "subscriptionPeriodId",
        "reference", "amountDueMinor", "currency", "dueAt", "status", "createdAt", "updatedAt"
      ) VALUES (
        'ar-unallocated-refund-1', 'org-1', 'venue-1', 'SUBSCRIPTION_PERIOD', 'period-unallocated-refund-1',
        'AVQ-AR-UNALLOCATED-REFUND-1', 10000, 'MXN', '2027-03-01T06:00:00Z', 'OPEN', now(), now()
      );
      INSERT INTO "CommercialBillingPaymentAttempt" (
        "id", "receivableId", "provider", "idempotencyKey", "status", "amountMinor", "currency",
        "requestFingerprint", "createdAt", "updatedAt"
      ) VALUES
        ('attempt-unallocated-primary-1', 'ar-unallocated-refund-1', 'STRIPE',
         'attempt-unallocated-primary-key-1', 'PENDING', 10000, 'MXN', repeat('1', 64), now(), now()),
        ('attempt-unallocated-extra-1', 'ar-unallocated-refund-1', 'STRIPE',
         'attempt-unallocated-extra-key-1', 'PENDING', 4000, 'MXN', repeat('2', 64), now(), now());
    `)

    await reconcileCommercialCashReceipt(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivableId: 'ar-unallocated-refund-1',
        paymentAttemptId: 'attempt-unallocated-primary-1',
        idempotencyKey: 'receipt-unallocated-primary-key-1',
        observation: {
          provider: 'STRIPE',
          providerEventId: 'evt-unallocated-primary-1',
          amountMinor: 10_000n,
          currency: 'MXN',
          receivingAccountFingerprint: '9'.repeat(64),
          observedAt: new Date('2027-03-01T06:01:00.000Z'),
        },
        now: new Date('2027-03-01T06:01:01.000Z'),
      },
      { host: billingPrisma },
    )
    const unallocated = await reconcileCommercialCashReceipt(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivableId: 'ar-unallocated-refund-1',
        paymentAttemptId: 'attempt-unallocated-extra-1',
        idempotencyKey: 'receipt-unallocated-extra-key-1',
        observation: {
          provider: 'STRIPE',
          providerEventId: 'evt-unallocated-extra-1',
          amountMinor: 4_000n,
          currency: 'MXN',
          receivingAccountFingerprint: '9'.repeat(64),
          observedAt: new Date('2027-03-01T06:02:00.000Z'),
        },
        now: new Date('2027-03-01T06:02:01.000Z'),
      },
      { host: billingPrisma },
    )
    expect(unallocated).toMatchObject({ allocatedMinor: 0n, receivableStatus: 'PAID', periodStatus: 'PAID' })

    const adjustmentInput = {
      organizationId: 'org-1',
      venueId: 'venue-1',
      originalReceiptId: unallocated.receiptId,
      idempotencyKey: 'refund-unallocated-extra-key-1',
      observation: {
        provider: 'STRIPE' as const,
        providerEventId: 'evt-refund-unallocated-extra-1',
        entryType: 'REFUND' as const,
        amountMinor: 4_000n,
        currency: 'MXN' as const,
        receivingAccountFingerprint: '9'.repeat(64),
        observedAt: new Date('2027-03-01T06:03:00.000Z'),
      },
      now: new Date('2027-03-01T06:03:01.000Z'),
    }
    const adjusted = await reconcileCommercialCashAdjustment(adjustmentInput, { host: billingPrisma })
    const replay = await reconcileCommercialCashAdjustment(adjustmentInput, { host: billingPrisma })

    expect(adjusted).toMatchObject({
      decision: 'ADJUSTED',
      debitMinor: 0n,
      receivableStatus: 'PAID',
      periodStatus: 'PAID',
      eventId: null,
    })
    expect(replay).toEqual({ ...adjusted, decision: 'REPLAY' })
  })

  it('serializes allocation capacity on both receipt and receivable', async () => {
    await client.query(`
      INSERT INTO "CommercialBillingAllocation" (
        "id", "cashReceiptId", "receivableId", "direction", "amountMinor", "idempotencyKey", "createdAt"
      ) VALUES ('allocation-1', 'receipt-1', 'ar-1', 'CREDIT', 28884, 'allocation-key-1', now())
    `)

    await expectConstraint(
      client.query(`
        INSERT INTO "CommercialBillingAllocation" (
          "id", "cashReceiptId", "receivableId", "direction", "amountMinor", "idempotencyKey", "createdAt"
        ) VALUES ('allocation-over', 'receipt-1', 'ar-1', 'CREDIT', 1, 'allocation-key-over', now())
      `),
      'CommercialBillingAllocation_receivable_capacity_check',
    )
  })

  it('deduplicates provider observations and stable outbox sources', async () => {
    await expect(
      client.query(`
        INSERT INTO "CommercialCashReceipt" (
          "id", "organizationId", "venueId", "provider", "providerEventId", "idempotencyKey",
          "entryType", "amountMinor", "currency", "receivingAccountFingerprint", "observedAt", "createdAt"
        ) VALUES (
          'receipt-duplicate', 'org-1', 'venue-1', 'STRIPE', 'evt-1', 'receipt-key-duplicate',
          'PAYMENT', 30000, 'MXN', repeat('b', 64), now(), now()
        )
      `),
    ).rejects.toMatchObject({ code: '23505' })

    await client.query(`
      INSERT INTO "CommercialEventOutbox" (
        "id", "eventId", "sourceType", "sourceId", "sourceRevision", "eventType",
        "payload", "status", "attemptCount", "availableAt", "createdAt"
      ) VALUES (
        'outbox-1', 'event-1', 'SUBSCRIPTION_PERIOD', 'period-1', 1,
        'SUBSCRIPTION_PAYMENT_RECONCILED', '{}'::jsonb, 'PENDING', 0, now(), now()
      )
    `)
    await expect(
      client.query(`
        INSERT INTO "CommercialEventOutbox" (
          "id", "eventId", "sourceType", "sourceId", "sourceRevision", "eventType",
          "payload", "status", "attemptCount", "availableAt", "createdAt"
        ) VALUES (
          'outbox-duplicate', 'event-2', 'SUBSCRIPTION_PERIOD', 'period-1', 1,
          'SUBSCRIPTION_PAYMENT_RECONCILED', '{}'::jsonb, 'PENDING', 0, now(), now()
        )
      `),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('forbids mutation or deletion of cash and allocation ledger rows', async () => {
    await expectConstraint(
      client.query(`UPDATE "CommercialCashReceipt" SET "amountMinor" = 1 WHERE "id" = 'receipt-1'`),
      'CommercialCashReceipt_append_only_check',
    )
    await expectConstraint(
      client.query(`DELETE FROM "CommercialBillingAllocation" WHERE "id" = 'allocation-1'`),
      'CommercialBillingAllocation_append_only_check',
    )
  })

  it('rejects direct cumulative adjustments above the original payment at the database boundary', async () => {
    await client.query(`
      INSERT INTO "CommercialCashReceipt" (
        "id", "organizationId", "venueId", "provider", "providerEventId", "idempotencyKey",
        "entryType", "relatedReceiptId", "amountMinor", "currency",
        "receivingAccountFingerprint", "observedAt", "createdAt"
      ) VALUES (
        'refund-capacity-1', 'org-1', 'venue-1', 'STRIPE', 'evt-refund-capacity-1',
        'refund-capacity-key-1', 'REFUND', 'receipt-1', 20000, 'MXN', repeat('b', 64), now(), now()
      )
    `)

    await expectConstraint(
      client.query(`
        INSERT INTO "CommercialCashReceipt" (
          "id", "organizationId", "venueId", "provider", "providerEventId", "idempotencyKey",
          "entryType", "relatedReceiptId", "amountMinor", "currency",
          "receivingAccountFingerprint", "observedAt", "createdAt"
        ) VALUES (
          'refund-capacity-over', 'org-1', 'venue-1', 'STRIPE', 'evt-refund-capacity-over',
          'refund-capacity-key-over', 'REVERSAL', 'receipt-1', 10001, 'MXN', repeat('b', 64), now(), now()
        )
      `),
      'CommercialCashReceipt_adjustment_capacity_check',
    )

    await expectConstraint(
      client.query(`
        INSERT INTO "CommercialCashReceipt" (
          "id", "organizationId", "venueId", "provider", "providerEventId", "idempotencyKey",
          "entryType", "relatedReceiptId", "amountMinor", "currency",
          "receivingAccountFingerprint", "observedAt", "createdAt"
        ) VALUES (
          'refund-chain-invalid', 'org-1', 'venue-1', 'STRIPE', 'evt-refund-chain-invalid',
          'refund-chain-key-invalid', 'REFUND', 'refund-capacity-1', 1, 'MXN', repeat('b', 64), now(), now()
        )
      `),
      'CommercialCashReceipt_adjustment_original_check',
    )
  })

  it('commits receipt, allocation, paid period, outbox and audit atomically and replays once', async () => {
    await client.query(`
      INSERT INTO "CommercialSubscriptionPeriod" (
        "id", "contractId", "sequence", "startsAt", "endsAt", "dueAt", "graceEndsAt",
        "amountDueMinor", "currency", "status", "statusRevision", "createdAt", "updatedAt"
      ) VALUES (
        'period-service-1', 'contract-1', 2, '2026-10-01T06:00:00Z', '2026-11-01T06:00:00Z',
        '2026-10-01T06:00:00Z', '2026-10-06T06:00:00Z', 28884, 'MXN', 'OPEN', 1, now(), now()
      );
      INSERT INTO "CommercialAccountReceivable" (
        "id", "organizationId", "venueId", "subjectType", "subscriptionPeriodId",
        "reference", "amountDueMinor", "currency", "dueAt", "status", "createdAt", "updatedAt"
      ) VALUES (
        'ar-service-1', 'org-1', 'venue-1', 'SUBSCRIPTION_PERIOD', 'period-service-1',
        'AVQ-AR-SERVICE-1', 28884, 'MXN', '2026-10-01T06:00:00Z', 'OPEN', now(), now()
      );
    `)

    const input = {
      organizationId: 'org-1',
      venueId: 'venue-1',
      receivableId: 'ar-service-1',
      idempotencyKey: 'service-receipt-key-1',
      observation: {
        provider: 'STRIPE' as const,
        providerEventId: 'evt-service-1',
        amountMinor: 28_884n,
        currency: 'MXN' as const,
        receivingAccountFingerprint: 'c'.repeat(64),
        observedAt: new Date('2026-10-01T06:01:00.000Z'),
      },
      now: new Date('2026-10-01T06:01:01.000Z'),
    }

    if (!billingPrisma.commercialCashReceipt) {
      throw new Error(
        `PRISMA_CLIENT_MISSING_BILLING:${require.resolve('@prisma/client')}:${Prisma.dmmf.datamodel.models
          .filter(model => model.name.startsWith('Commercial'))
          .map(model => model.name)
          .join(',')}`,
      )
    }
    expect(
      await billingPrisma.$transaction(async tx => ({
        receipt: Boolean(tx.commercialCashReceipt),
        allocation: Boolean(tx.commercialBillingAllocation),
      })),
    ).toEqual({ receipt: true, allocation: true })

    const first = await reconcileCommercialCashReceipt(input, { host: billingPrisma })
    const replay = await reconcileCommercialCashReceipt(input, { host: billingPrisma })

    expect(first).toMatchObject({
      decision: 'RECONCILED',
      allocatedMinor: 28_884n,
      receivableStatus: 'PAID',
      periodStatus: 'PAID',
      eventId: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(replay).toEqual({ ...first, decision: 'REPLAY' })

    const evidence = await client.query<{
      receipts: string
      allocations: string
      events: string
      audits: string
      periodStatus: string
      receivableStatus: string
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text FROM "CommercialCashReceipt" WHERE "providerEventId" = 'evt-service-1') AS receipts,
        (SELECT COUNT(*)::text FROM "CommercialBillingAllocation" WHERE "receivableId" = 'ar-service-1') AS allocations,
        (SELECT COUNT(*)::text FROM "CommercialEventOutbox" WHERE "sourceId" = 'period-service-1') AS events,
        (SELECT COUNT(*)::text FROM "ActivityLog" WHERE "entityId" = $1) AS audits,
        (SELECT "status"::text FROM "CommercialSubscriptionPeriod" WHERE "id" = 'period-service-1') AS "periodStatus",
        (SELECT "status"::text FROM "CommercialAccountReceivable" WHERE "id" = 'ar-service-1') AS "receivableStatus"
    `,
      [first.receiptId],
    )
    expect(evidence.rows[0]).toEqual({
      receipts: '1',
      allocations: '1',
      events: '1',
      audits: '1',
      periodStatus: 'PAID',
      receivableStatus: 'PAID',
    })
  })

  it('rolls the whole reconciliation back when its canonical outbox insert fails', async () => {
    await client.query(`
      INSERT INTO "CommercialSubscriptionPeriod" (
        "id", "contractId", "sequence", "startsAt", "endsAt", "dueAt", "graceEndsAt",
        "amountDueMinor", "currency", "status", "statusRevision", "createdAt", "updatedAt"
      ) VALUES (
        'period-rollback-1', 'contract-1', 3, '2026-11-01T06:00:00Z', '2026-12-01T06:00:00Z',
        '2026-11-01T06:00:00Z', '2026-11-06T06:00:00Z', 28884, 'MXN', 'OPEN', 1, now(), now()
      );
      INSERT INTO "CommercialAccountReceivable" (
        "id", "organizationId", "venueId", "subjectType", "subscriptionPeriodId",
        "reference", "amountDueMinor", "currency", "dueAt", "status", "createdAt", "updatedAt"
      ) VALUES (
        'ar-rollback-1', 'org-1', 'venue-1', 'SUBSCRIPTION_PERIOD', 'period-rollback-1',
        'AVQ-AR-ROLLBACK-1', 28884, 'MXN', '2026-11-01T06:00:00Z', 'OPEN', now(), now()
      );
      INSERT INTO "CommercialEventOutbox" (
        "id", "eventId", "sourceType", "sourceId", "sourceRevision", "eventType",
        "payload", "status", "attemptCount", "availableAt", "createdAt", "updatedAt"
      ) VALUES (
        'outbox-preconflict', 'event-preconflict', 'SUBSCRIPTION_PERIOD', 'period-rollback-1', 2,
        'SUBSCRIPTION_PAYMENT_RECONCILED', '{}'::jsonb, 'PENDING', 0, now(), now(), now()
      );
    `)

    await expect(
      reconcileCommercialCashReceipt(
        {
          organizationId: 'org-1',
          venueId: 'venue-1',
          receivableId: 'ar-rollback-1',
          idempotencyKey: 'receipt-rollback-key-1',
          observation: {
            provider: 'STRIPE',
            providerEventId: 'evt-rollback-1',
            amountMinor: 28_884n,
            currency: 'MXN',
            receivingAccountFingerprint: 'd'.repeat(64),
            observedAt: new Date('2026-11-01T06:01:00.000Z'),
          },
          now: new Date('2026-11-01T06:01:01.000Z'),
        },
        { host: billingPrisma },
      ),
    ).rejects.toMatchObject({ code: 'P2002' })

    const rollback = await client.query<{
      receipts: string
      allocations: string
      periodStatus: string
      periodRevision: number
      receivableStatus: string
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM "CommercialCashReceipt" WHERE "providerEventId" = 'evt-rollback-1') AS receipts,
        (SELECT COUNT(*)::text FROM "CommercialBillingAllocation" WHERE "receivableId" = 'ar-rollback-1') AS allocations,
        (SELECT "status"::text FROM "CommercialSubscriptionPeriod" WHERE "id" = 'period-rollback-1') AS "periodStatus",
        (SELECT "statusRevision" FROM "CommercialSubscriptionPeriod" WHERE "id" = 'period-rollback-1') AS "periodRevision",
        (SELECT "status"::text FROM "CommercialAccountReceivable" WHERE "id" = 'ar-rollback-1') AS "receivableStatus"
    `)
    expect(rollback.rows[0]).toEqual({
      receipts: '0',
      allocations: '0',
      periodStatus: 'OPEN',
      periodRevision: 1,
      receivableStatus: 'OPEN',
    })
  })

  it('serializes concurrent receipts into one paid-period transition', async () => {
    await client.query(`
      INSERT INTO "CommercialSubscriptionPeriod" (
        "id", "contractId", "sequence", "startsAt", "endsAt", "dueAt", "graceEndsAt",
        "amountDueMinor", "currency", "status", "statusRevision", "createdAt", "updatedAt"
      ) VALUES (
        'period-concurrent-1', 'contract-1', 4, '2026-12-01T06:00:00Z', '2027-01-01T06:00:00Z',
        '2026-12-01T06:00:00Z', '2026-12-06T06:00:00Z', 28884, 'MXN', 'OPEN', 1, now(), now()
      );
      INSERT INTO "CommercialAccountReceivable" (
        "id", "organizationId", "venueId", "subjectType", "subscriptionPeriodId",
        "reference", "amountDueMinor", "currency", "dueAt", "status", "createdAt", "updatedAt"
      ) VALUES (
        'ar-concurrent-1', 'org-1', 'venue-1', 'SUBSCRIPTION_PERIOD', 'period-concurrent-1',
        'AVQ-AR-CONCURRENT-1', 28884, 'MXN', '2026-12-01T06:00:00Z', 'OPEN', now(), now()
      );
      CREATE FUNCTION commercial_billing_test_pause_first_receipt()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."providerEventId" = 'evt-concurrent-a' THEN PERFORM pg_sleep(0.2); END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER "zz_commercial_billing_test_pause"
      BEFORE INSERT ON "CommercialCashReceipt"
      FOR EACH ROW EXECUTE FUNCTION commercial_billing_test_pause_first_receipt();
    `)

    const cashInput = (suffix: 'a' | 'b') => ({
      organizationId: 'org-1',
      venueId: 'venue-1',
      receivableId: 'ar-concurrent-1',
      idempotencyKey: `receipt-concurrent-key-${suffix}`,
      observation: {
        provider: 'STRIPE' as const,
        providerEventId: `evt-concurrent-${suffix}`,
        amountMinor: 28_884n,
        currency: 'MXN' as const,
        receivingAccountFingerprint: 'e'.repeat(64),
        observedAt: new Date(`2026-12-01T06:01:0${suffix === 'a' ? '0' : '1'}.000Z`),
      },
      now: new Date(`2026-12-01T06:01:1${suffix === 'a' ? '0' : '1'}.000Z`),
    })

    const firstPromise = reconcileCommercialCashReceipt(cashInput('a'), { host: billingPrisma })
    await new Promise(resolve => setTimeout(resolve, 25))
    const secondPromise = reconcileCommercialCashReceipt(cashInput('b'), { host: billingPrisma })
    const results = await Promise.all([firstPromise, secondPromise])

    expect(results.map(result => result.allocatedMinor).sort((a, b) => Number(a - b))).toEqual([0n, 28_884n])
    expect(results.filter(result => result.eventId !== null)).toHaveLength(1)

    const counts = await client.query<{ receipts: string; allocations: string; events: string; revision: number }>(`
      SELECT
        (SELECT COUNT(*)::text FROM "CommercialCashReceipt" WHERE "providerEventId" LIKE 'evt-concurrent-%') AS receipts,
        (SELECT COUNT(*)::text FROM "CommercialBillingAllocation" WHERE "receivableId" = 'ar-concurrent-1') AS allocations,
        (SELECT COUNT(*)::text FROM "CommercialEventOutbox" WHERE "sourceId" = 'period-concurrent-1') AS events,
        (SELECT "statusRevision" FROM "CommercialSubscriptionPeriod" WHERE "id" = 'period-concurrent-1') AS revision
    `)
    expect(counts.rows[0]).toEqual({ receipts: '2', allocations: '1', events: '1', revision: 2 })
  })

  it('keeps manual SPEI proof non-monetary until two independent approvals reconcile it once', async () => {
    await client.query(`
      INSERT INTO "Staff" ("id") VALUES ('finance-2'), ('finance-3'), ('seller-1'), ('owner-1');
      INSERT INTO "CommercialManualSpeiPolicyVersion" (
        "id", "market", "version", "dualApprovalThresholdMinor", "currency", "checksum", "publishedById"
      ) VALUES (
        'spei-policy-mx-v1', 'MX', 1, 2500000, 'MXN', repeat('6', 64), 'finance-1'
      );
      INSERT INTO "CommercialManualSpeiPolicyActivation" (
        "market", "policyVersionId", "activatedById", "updatedAt"
      ) VALUES ('MX', 'spei-policy-mx-v1', 'finance-1', now());
      INSERT INTO "CommercialSubscriptionPeriod" (
        "id", "contractId", "sequence", "startsAt", "endsAt", "dueAt", "graceEndsAt",
        "amountDueMinor", "currency", "status", "statusRevision", "createdAt", "updatedAt"
      ) VALUES (
        'period-spei-dual-1', 'contract-1', 5,
        '2027-01-01T06:00:00Z', '2027-02-01T06:00:00Z',
        '2027-01-01T06:00:00Z', '2027-01-06T06:00:00Z',
        2500000, 'MXN', 'OPEN', 1, now(), now()
      );
      INSERT INTO "CommercialAccountReceivable" (
        "id", "organizationId", "venueId", "subjectType", "subscriptionPeriodId",
        "reference", "amountDueMinor", "currency", "dueAt", "status", "createdAt", "updatedAt"
      ) VALUES (
        'ar-spei-dual-1', 'org-1', 'venue-1', 'SUBSCRIPTION_PERIOD', 'period-spei-dual-1',
        'AVQ-AR-SPEI-DUAL-1', 2500000, 'MXN', '2027-01-01T06:00:00Z', 'OPEN', now(), now()
      );
      INSERT INTO "CommercialBillingPaymentAttempt" (
        "id", "receivableId", "provider", "idempotencyKey", "status",
        "amountMinor", "currency", "requestFingerprint", "createdAt", "updatedAt"
      ) VALUES (
        'attempt-spei-dual-1', 'ar-spei-dual-1', 'MANUAL_SPEI',
        'attempt-spei-dual-key-1', 'PENDING', 2500000, 'MXN', repeat('5', 64), now(), now()
      );
    `)

    const speiCase = await createCommercialManualSpeiCase(
      {
        organizationId: 'org-1',
        venueId: 'venue-1',
        receivableId: 'ar-spei-dual-1',
        paymentAttemptId: 'attempt-spei-dual-1',
        observedAmountMinor: 2_500_000n,
        bankReference: 'SPEI-REF-DUAL-1',
        receivingAccountFingerprint: '4'.repeat(64),
        observedAt: new Date('2027-01-01T06:01:00.000Z'),
        attributedCommercialActorIds: ['seller-1'],
        createdById: 'owner-1',
      },
      { host: billingPrisma },
    )
    expect(speiCase).toMatchObject({
      decision: 'CREATED',
      status: 'PENDING_REVIEW',
      policyVersionId: 'spei-policy-mx-v1',
      requiredApprovals: 2,
      exceptionReasons: ['DUAL_APPROVAL_THRESHOLD'],
    })

    const evidence = await registerCommercialManualSpeiEvidence(
      {
        caseId: speiCase.caseId,
        organizationId: 'org-1',
        venueId: 'venue-1',
        uploadedById: 'owner-1',
        storageObjectKey: `private/commercial-spei/org-1/${speiCase.caseId}/proof.pdf`,
        contentSha256: '3'.repeat(64),
        mimeType: 'application/pdf',
        sizeBytes: 50_000,
      },
      { host: billingPrisma },
    )
    await expect(
      reviewCommercialManualSpeiEvidence(
        {
          evidenceId: evidence.evidenceId,
          organizationId: 'org-1',
          venueId: 'venue-1',
          actorId: 'finance-1',
          action: 'REJECT',
          reason: 'El comprobante no permite verificar la referencia.',
        },
        { host: billingPrisma },
      ),
    ).resolves.toMatchObject({ status: 'REJECTED' })
    await expect(
      supersedeCommercialManualSpeiEvidence(
        {
          evidenceId: evidence.evidenceId,
          organizationId: 'org-1',
          venueId: 'venue-1',
          actorId: 'finance-2',
          reason: 'El cliente entregará un comprobante corregido.',
        },
        { host: billingPrisma },
      ),
    ).resolves.toMatchObject({ status: 'PENDING_REVIEW' })
    const replacementEvidence = await registerCommercialManualSpeiEvidence(
      {
        caseId: speiCase.caseId,
        organizationId: 'org-1',
        venueId: 'venue-1',
        uploadedById: 'owner-1',
        storageObjectKey: `private/commercial-spei/org-1/${speiCase.caseId}/proof-corrected.pdf`,
        contentSha256: '2'.repeat(64),
        mimeType: 'application/pdf',
        sizeBytes: 51_000,
      },
      { host: billingPrisma },
    )
    expect(replacementEvidence.sequence).toBe(2)
    await reviewCommercialManualSpeiEvidence(
      {
        evidenceId: replacementEvidence.evidenceId,
        organizationId: 'org-1',
        venueId: 'venue-1',
        actorId: 'finance-1',
        action: 'ACCEPT',
        reason: null,
      },
      { host: billingPrisma },
    )

    const beforeApproval = await client.query<{ receipts: string; caseStatus: string }>(
      `
      SELECT
        (SELECT COUNT(*)::text FROM "CommercialCashReceipt" WHERE "providerEventId" = $1) AS receipts,
        (SELECT "status"::text FROM "CommercialManualSpeiCase" WHERE "id" = $2) AS "caseStatus"
    `,
      [`manual-spei:${speiCase.caseId}`, speiCase.caseId],
    )
    expect(beforeApproval.rows[0]).toEqual({ receipts: '0', caseStatus: 'AWAITING_APPROVAL' })

    await expectConstraint(
      client.query(
        `INSERT INTO "CommercialManualSpeiApproval" (
           "id", "caseId", "actorId", "policyVersionId", "exceptionReasons"
         ) VALUES ('approval-seller-invalid', $1, 'seller-1', 'spei-policy-mx-v1', '[]'::jsonb)`,
        [speiCase.caseId],
      ),
      'CommercialManualSpeiApproval_independence_check',
    )
    await expectConstraint(
      client.query(
        `INSERT INTO "CommercialManualSpeiApproval" (
           "id", "caseId", "actorId", "policyVersionId", "exceptionReasons"
         ) VALUES ('approval-creator-invalid', $1, 'owner-1', 'spei-policy-mx-v1', '[]'::jsonb)`,
        [speiCase.caseId],
      ),
      'CommercialManualSpeiApproval_independence_check',
    )
    await expectConstraint(
      client.query(
        `INSERT INTO "CommercialManualSpeiApproval" (
           "id", "caseId", "actorId", "policyVersionId", "exceptionReasons"
         ) VALUES ('approval-reviewer-invalid', $1, 'finance-1', 'spei-policy-mx-v1', '[]'::jsonb)`,
        [speiCase.caseId],
      ),
      'CommercialManualSpeiApproval_independence_check',
    )

    const firstApproval = await approveCommercialManualSpeiCase(
      {
        caseId: speiCase.caseId,
        organizationId: 'org-1',
        venueId: 'venue-1',
        actorId: 'finance-2',
        now: new Date('2027-01-01T06:02:00.000Z'),
      },
      { host: billingPrisma },
    )
    expect(firstApproval).toMatchObject({
      decision: 'PENDING_SECOND_APPROVAL',
      validApprovals: 1,
      requiredApprovals: 2,
      receiptId: null,
    })

    const secondApproval = await approveCommercialManualSpeiCase(
      {
        caseId: speiCase.caseId,
        organizationId: 'org-1',
        venueId: 'venue-1',
        actorId: 'finance-3',
        now: new Date('2027-01-01T06:03:00.000Z'),
      },
      { host: billingPrisma },
    )
    const replay = await approveCommercialManualSpeiCase(
      {
        caseId: speiCase.caseId,
        organizationId: 'org-1',
        venueId: 'venue-1',
        actorId: 'finance-3',
        now: new Date('2027-01-01T06:04:00.000Z'),
      },
      { host: billingPrisma },
    )
    expect(secondApproval).toMatchObject({
      decision: 'RECONCILED',
      validApprovals: 2,
      requiredApprovals: 2,
      receiptId: expect.any(String),
      eventId: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(replay).toMatchObject({
      decision: 'REPLAY',
      validApprovals: 2,
      requiredApprovals: 2,
      receiptId: secondApproval.receiptId,
    })

    const reconciled = await client.query<{
      receipts: string
      allocations: string
      approvals: string
      events: string
      caseStatus: string
      attemptStatus: string
      periodStatus: string
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text FROM "CommercialCashReceipt" WHERE "providerEventId" = $1) AS receipts,
        (SELECT COUNT(*)::text FROM "CommercialBillingAllocation" WHERE "receivableId" = 'ar-spei-dual-1') AS allocations,
        (SELECT COUNT(*)::text FROM "CommercialManualSpeiApproval" WHERE "caseId" = $2) AS approvals,
        (SELECT COUNT(*)::text FROM "CommercialEventOutbox" WHERE "sourceId" = 'period-spei-dual-1') AS events,
        (SELECT "status"::text FROM "CommercialManualSpeiCase" WHERE "id" = $2) AS "caseStatus",
        (SELECT "status"::text FROM "CommercialBillingPaymentAttempt" WHERE "id" = 'attempt-spei-dual-1') AS "attemptStatus",
        (SELECT "status"::text FROM "CommercialSubscriptionPeriod" WHERE "id" = 'period-spei-dual-1') AS "periodStatus"
    `,
      [`manual-spei:${speiCase.caseId}`, speiCase.caseId],
    )
    expect(reconciled.rows[0]).toEqual({
      receipts: '1',
      allocations: '1',
      approvals: '2',
      events: '1',
      caseStatus: 'RECONCILED',
      attemptStatus: 'SUCCEEDED',
      periodStatus: 'PAID',
    })

    await expectConstraint(
      client.query(`UPDATE "CommercialManualSpeiEvidence" SET "sizeBytes" = 1 WHERE "id" = $1`, [evidence.evidenceId]),
      'CommercialManualSpeiEvidence_append_only_check',
    )
    await expectConstraint(
      client.query(`DELETE FROM "CommercialManualSpeiApproval" WHERE "caseId" = $1`, [speiCase.caseId]),
      'CommercialManualSpeiApproval_append_only_check',
    )
  })
})
