import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { PrismaClient } from '@prisma/client'
import {
  StaleWebhookLeaseError,
  StripeObjectBindingConflictError,
  WebhookEventConflictError,
  createPlatformWebhookInboxService,
  createPrismaPlatformWebhookRepository,
} from '@/services/stripe-webhooks/platformWebhookInbox.service'

const repoRoot = path.resolve(__dirname, '../../..')
const a0Migration = path.join(repoRoot, 'prisma/migrations/20260823150000_add_stripe_checkout_origin/migration.sql')
const a1aMigration = path.join(repoRoot, 'prisma/migrations/20260823180000_add_platform_webhook_inbox/migration.sql')
const a1cMigration = path.join(repoRoot, 'prisma/migrations/20260823210000_add_platform_webhook_orchestrator_primitives/migration.sql')
const databasePrefix = 'avoqado_p3_1a1a_'

interface LocalServer {
  host: string
  port: number
  user: string
  password: string
  database: string
}

function localTestServer(connectionString: string | undefined): LocalServer {
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required')
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`Harness refuses protocol ${url.protocol}`)
  if (url.search) throw new Error('Harness refuses connection-string query parameters')
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error(`Harness refuses non-local host ${url.hostname}`)
  const database = decodeURIComponent(url.pathname.slice(1))
  if (!/(?:-|_)test$/.test(database)) throw new Error(`Harness refuses non-test database ${database}`)
  const port = url.port ? Number(url.port) : 5432
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Harness refuses invalid port ${url.port}`)
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (!user || !password) throw new Error('Harness requires explicit database user and password')
  return { host: url.hostname, port, user, password, database }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{2,62}$/.test(value)) throw new Error(`Unsafe identifier ${value}`)
  return `"${value}"`
}

function databaseUrl(server: LocalServer, database: string): string {
  const url = new URL('postgresql://localhost')
  url.username = server.user
  url.password = server.password
  url.hostname = server.host
  url.port = String(server.port)
  url.pathname = `/${database}`
  return url.toString()
}

function isLoopbackAddress(address: string | null): boolean {
  return address === '127.0.0.1' || address === '::1'
}

async function initializeLegacySchema(client: Client) {
  await client.query(`
    CREATE TYPE "WebhookEventStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'RETRYING');
    CREATE TABLE "Venue" (id TEXT PRIMARY KEY);
    CREATE TABLE "Feature" (id TEXT PRIMARY KEY);
    CREATE TABLE "TerminalOrder" (id TEXT PRIMARY KEY, "stripeCheckoutSessionId" TEXT);
    CREATE TABLE "TokenPurchase" (id TEXT PRIMARY KEY, "stripeInvoiceId" TEXT);
    CREATE TABLE "WebhookEvent" (
      id TEXT PRIMARY KEY,
      "stripeEventId" TEXT NOT NULL UNIQUE,
      "eventType" TEXT NOT NULL,
      payload JSONB NOT NULL,
      status "WebhookEventStatus" NOT NULL DEFAULT 'PENDING',
      "errorMessage" TEXT,
      "processingTime" INTEGER,
      "retryCount" INTEGER NOT NULL DEFAULT 0,
      "venueId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "processedAt" TIMESTAMP(3),
      CONSTRAINT "WebhookEvent_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"(id) ON DELETE SET NULL ON UPDATE CASCADE
    );
    INSERT INTO "Venue" (id) VALUES ('venue-1'), ('venue-2');
    INSERT INTO "Feature" (id) VALUES ('feature-1'), ('feature-2');
    INSERT INTO "WebhookEvent" (id, "stripeEventId", "eventType", payload, status, "retryCount") VALUES
      ('historic-success', 'evt_historic_success', 'invoice.paid', '{}', 'SUCCESS', 2),
      ('historic-pending', 'evt_historic_pending', 'invoice.paid', '{}', 'PENDING', 0),
      ('historic-failed-below', 'evt_historic_failed_below', 'invoice.paid', '{}', 'FAILED', 4),
      ('historic-failed-at', 'evt_historic_failed_at', 'invoice.paid', '{}', 'FAILED', 5),
      ('historic-retrying', 'evt_historic_retrying', 'invoice.paid', '{}', 'RETRYING', 1);
  `)
  await client.query(fs.readFileSync(a0Migration, 'utf8'))
  await client.query(`
    INSERT INTO "StripeCheckoutOrigin" (
      "stripeCheckoutSessionId", "ownerKind", "routeKey", "venueId", "featureId",
      "stripeCustomerId", "billingInterval"
    ) VALUES (
      'cs_a0_before_a1a', 'LEGACY', 'LEGACY_PLAN_CHECKOUT', 'venue-1', 'feature-1',
      'cus_a0', 'MONTHLY'
    )
  `)
  await client.query(fs.readFileSync(a1aMigration, 'utf8'))
}

async function withDisposableDatabase<T>(
  run: (clients: { first: PrismaClient; second: PrismaClient; sql: Client; applyRuntimeMigration(): Promise<void> }) => Promise<T>,
) {
  const server = localTestServer(process.env.TEST_DATABASE_URL)
  const databaseName = `${databasePrefix}${process.pid}_${Date.now()}_${randomUUID().split('-').join('').slice(0, 8)}`
  if (!/^avoqado_p3_1a1a_[0-9]+_[0-9]+_[a-f0-9]{8}$/.test(databaseName)) throw new Error(`Unsafe target ${databaseName}`)
  const admin = new Client({ ...server, database: 'postgres', ssl: false })
  let sql: Client | undefined
  let first: PrismaClient | undefined
  let second: PrismaClient | undefined
  let created = false
  let result: T | undefined
  let runError: unknown

  await admin.connect()
  try {
    const adminIdentity = await admin.query(`SELECT current_database() AS database_name, host(inet_server_addr()) AS server_address`)
    if (adminIdentity.rows[0].database_name !== 'postgres' || !isLoopbackAddress(adminIdentity.rows[0].server_address)) {
      throw new Error('Unsafe maintenance connection')
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    created = true
    const url = databaseUrl(server, databaseName)
    sql = new Client({ ...server, database: databaseName, ssl: false })
    await sql.connect()
    const targetIdentity = await sql.query(`SELECT current_database() AS database_name, host(inet_server_addr()) AS server_address`)
    if (targetIdentity.rows[0].database_name !== databaseName || !isLoopbackAddress(targetIdentity.rows[0].server_address)) {
      throw new Error('Unsafe disposable target')
    }
    await initializeLegacySchema(sql)
    first = new PrismaClient({ datasources: { db: { url } } })
    second = new PrismaClient({ datasources: { db: { url } } })
    result = await run({
      first,
      second,
      sql,
      // The first test deliberately inspects the A1a migration in isolation.
      // Runtime tests then advance the same disposable DB to A1c because the
      // current repository is deployed only after its expand-first migration.
      applyRuntimeMigration: async () => {
        await sql!.query(fs.readFileSync(a1cMigration, 'utf8'))
      },
    })
  } catch (error) {
    runError = error
  } finally {
    await Promise.allSettled([first?.$disconnect(), second?.$disconnect()])
    await sql?.end()
    if (created) await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`)
  }

  const dropped = await admin.query(`SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS dropped`, [databaseName])
  const residual = await admin.query(`SELECT count(*)::integer AS count FROM pg_database WHERE datname LIKE $1`, [`${databasePrefix}%`])
  await admin.end()
  if (runError) throw runError
  return { result: result as T, cleanupConfirmed: dropped.rows[0].dropped, residualCount: residual.rows[0].count }
}

describe('P3-1A1a platform webhook inbox — real PostgreSQL', () => {
  it('migrates history without metadata inference and enforces the state/tuple/lease matrix', async () => {
    const proof = await withDisposableDatabase(async ({ sql }) => {
      const rows = await sql.query(`
        SELECT id, "classificationState", "classificationNextAttemptAt", "classificationResolvedAt",
               "ownerKind", "routeKey", "subjectKind", "subjectId", "effectAttempts", "effectNextAttemptAt", "retryCount"
        FROM "WebhookEvent" ORDER BY id
      `)
      const rejected = async (statement: string, code: string) => {
        try {
          await sql.query(statement)
          return false
        } catch (error: any) {
          return error.code === code
        }
      }
      await sql.query(`
        INSERT INTO "WebhookEvent" (id, "stripeEventId", "eventType", payload)
        VALUES ('new-default', 'evt_new_default', 'invoice.paid', '{}')
      `)
      const fresh = await sql.query(
        `SELECT "classificationState", "classificationNextAttemptAt", "effectNextAttemptAt" FROM "WebhookEvent" WHERE id = 'new-default'`,
      )
      await sql.query(`
        INSERT INTO "TerminalOrder" (id, "stripeCheckoutSessionId")
        VALUES ('terminal-duplicate-1', 'cs_duplicate_allowed'), ('terminal-duplicate-2', 'cs_duplicate_allowed');
        INSERT INTO "TokenPurchase" (id, "stripeInvoiceId")
        VALUES ('token-duplicate-1', 'in_duplicate_allowed'), ('token-duplicate-2', 'in_duplicate_allowed');
      `)
      const classifierLookupIndexes = await sql.query(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname IN ('TerminalOrder_stripeCheckoutSessionId_idx', 'TokenPurchase_stripeInvoiceId_idx')
        ORDER BY indexname
      `)
      const duplicateLookupCounts = await sql.query(`
        SELECT
          (SELECT count(*)::integer FROM "TerminalOrder" WHERE "stripeCheckoutSessionId" = 'cs_duplicate_allowed') AS terminal_count,
          (SELECT count(*)::integer FROM "TokenPurchase" WHERE "stripeInvoiceId" = 'in_duplicate_allowed') AS token_count
      `)

      const partialTupleRejected = await rejected(`UPDATE "WebhookEvent" SET "ownerKind" = 'LEGACY' WHERE id = 'new-default'`, '23514')
      const classifiedWithoutTupleRejected = await rejected(
        `UPDATE "WebhookEvent" SET "classificationState" = 'CLASSIFIED', "classificationResolvedAt" = timezone('UTC', CURRENT_TIMESTAMP), "classificationNextAttemptAt" = NULL WHERE id = 'new-default'`,
        '23514',
      )
      const incompleteLeaseRejected = await rejected(
        `UPDATE "WebhookEvent" SET "claimPhase" = 'CLASSIFICATION' WHERE id = 'new-default'`,
        '23514',
      )
      const invalidLeaseExpiryRejected = await rejected(
        `UPDATE "WebhookEvent" SET "claimPhase" = 'CLASSIFICATION', "claimToken" = 'token', "claimedBy" = 'worker', "claimedAt" = timezone('UTC', CURRENT_TIMESTAMP), "claimExpiresAt" = timezone('UTC', CURRENT_TIMESTAMP) WHERE id = 'new-default'`,
        '23514',
      )
      const reservedCreditPackRejected = await rejected(
        `UPDATE "WebhookEvent" SET "classificationState" = 'CLASSIFIED', "classificationResolvedAt" = timezone('UTC', CURRENT_TIMESTAMP), "classificationNextAttemptAt" = NULL, "ownerKind" = 'LEGACY', "routeKey" = 'CREDIT_PACK_CHECKOUT', "subjectKind" = 'TOKEN_PURCHASE', "subjectId" = 'purchase_1' WHERE id = 'new-default'`,
        '23514',
      )
      const legacyOriginSubscriptionEventRejected = await rejected(
        `INSERT INTO "WebhookEvent" (id, "stripeEventId", "eventType", payload) VALUES ('legacy-origin-subscription-event', 'evt_legacy_origin_subscription', 'invoice.paid', '{}');
         UPDATE "WebhookEvent" SET "classificationState" = 'CLASSIFIED', "classificationResolvedAt" = timezone('UTC', CURRENT_TIMESTAMP), "classificationNextAttemptAt" = NULL, "ownerKind" = 'LEGACY', "routeKey" = 'LEGACY_SUBSCRIPTION_LIFECYCLE', "subjectKind" = 'STRIPE_CHECKOUT_ORIGIN', "subjectId" = 'origin_1' WHERE id = 'legacy-origin-subscription-event'`,
        '23514',
      )
      const legacyOriginSubscriptionBindingRejected = await rejected(
        `INSERT INTO "StripeObjectBinding" ("objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId") VALUES ('SUBSCRIPTION', 'sub_legacy_origin', 'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'STRIPE_CHECKOUT_ORIGIN', 'origin_1')`,
        '23514',
      )
      const bindingObjectTypeMismatchResults = await Promise.all(
        [
          `INSERT INTO "StripeObjectBinding" ("objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId") VALUES ('CHECKOUT_SESSION', 'bad_checkout_vf', 'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE', 'venue-feature-bad')`,
          `INSERT INTO "StripeObjectBinding" ("objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId") VALUES ('SUBSCRIPTION', 'bad_subscription_origin', 'LEGACY', 'LEGACY_PLAN_CHECKOUT', 'STRIPE_CHECKOUT_ORIGIN', 'origin-bad')`,
          `INSERT INTO "StripeObjectBinding" ("objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId") VALUES ('INVOICE', 'bad_invoice_token_pi', 'INDEPENDENT', 'TOKEN_PAYMENT_INTENT', 'TOKEN_PURCHASE', 'token-bad')`,
          `INSERT INTO "StripeObjectBinding" ("objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId") VALUES ('PAYMENT_INTENT', 'bad_pi_token_invoice', 'INDEPENDENT', 'TOKEN_INVOICE', 'TOKEN_PURCHASE', 'token-bad')`,
          `INSERT INTO "StripeObjectBinding" ("objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId") VALUES ('CHARGE', 'bad_charge_token', 'INDEPENDENT', 'TOKEN_INVOICE', 'TOKEN_PURCHASE', 'token-bad')`,
          `INSERT INTO "StripeObjectBinding" ("objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId") VALUES ('INVOICE', 'bad_invoice_venue', 'LEGACY', 'VENUE_BILLING_PROFILE', 'VENUE', 'venue-1')`,
        ].map(statement => rejected(statement, '23514')),
      )
      const unresolvedWithoutReasonRejected = await rejected(
        `UPDATE "WebhookEvent" SET "classificationState" = 'UNRESOLVED', "classificationResolvedAt" = timezone('UTC', CURRENT_TIMESTAMP), "classificationNextAttemptAt" = NULL WHERE id = 'new-default'`,
        '23514',
      )
      const emptySubjectRejected = await rejected(
        `UPDATE "WebhookEvent" SET "classificationState" = 'CLASSIFIED', "classificationResolvedAt" = timezone('UTC', CURRENT_TIMESTAMP), "classificationNextAttemptAt" = NULL, "ownerKind" = 'LEGACY', "routeKey" = 'VENUE_BILLING_PROFILE', "subjectKind" = 'VENUE', "subjectId" = '   ' WHERE id = 'new-default'`,
        '23514',
      )
      const emptyClaimTokenRejected = await rejected(
        `UPDATE "WebhookEvent" SET "claimPhase" = 'CLASSIFICATION', "claimToken" = '', "claimedBy" = 'worker', "claimedAt" = timezone('UTC', CURRENT_TIMESTAMP), "claimExpiresAt" = timezone('UTC', CURRENT_TIMESTAMP) + interval '1 minute' WHERE id = 'new-default'`,
        '23514',
      )
      const emptyClaimedByRejected = await rejected(
        `UPDATE "WebhookEvent" SET "claimPhase" = 'CLASSIFICATION', "claimToken" = 'token', "claimedBy" = '  ', "claimedAt" = timezone('UTC', CURRENT_TIMESTAMP), "claimExpiresAt" = timezone('UTC', CURRENT_TIMESTAMP) + interval '1 minute' WHERE id = 'new-default'`,
        '23514',
      )
      const emptyBindingObjectIdRejected = await rejected(
        `INSERT INTO "StripeObjectBinding" ("objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId") VALUES ('SUBSCRIPTION', '  ', 'LEGACY', 'VENUE_BILLING_PROFILE', 'VENUE', 'venue-1')`,
        '23514',
      )

      const allowedAuthorityMatrix = [
        ['COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
        ['LEGACY', 'LEGACY_PLAN_CHECKOUT', 'STRIPE_CHECKOUT_ORIGIN'],
        ['LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE'],
        ['INDEPENDENT', 'TERMINAL_ORDER_CHECKOUT', 'TERMINAL_ORDER'],
        ['INDEPENDENT', 'TOKEN_PAYMENT_INTENT', 'TOKEN_PURCHASE'],
        ['INDEPENDENT', 'TOKEN_INVOICE', 'TOKEN_PURCHASE'],
        ['LEGACY', 'VENUE_BILLING_PROFILE', 'VENUE'],
      ] as const
      for (const [index, [ownerKind, routeKey, subjectKind]] of allowedAuthorityMatrix.entries()) {
        await sql.query(`INSERT INTO "WebhookEvent" (id, "stripeEventId", "eventType", payload) VALUES ($1, $2, 'invoice.paid', '{}')`, [
          `matrix-event-${index}`,
          `evt_matrix_${index}`,
        ])
        await sql.query(
          `UPDATE "WebhookEvent"
           SET "classificationState" = 'CLASSIFIED', "classificationResolvedAt" = timezone('UTC', CURRENT_TIMESTAMP),
               "classificationNextAttemptAt" = NULL, "ownerKind" = $1::"StripeEventOwnerKind",
               "routeKey" = $2::"StripeEventRouteKey", "subjectKind" = $3::"StripeEventSubjectKind", "subjectId" = $4
           WHERE id = $5`,
          [ownerKind, routeKey, subjectKind, `subject-${index}`, `matrix-event-${index}`],
        )
      }
      const allowedBindingMatrix = [
        ['CHECKOUT_SESSION', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
        ['CHECKOUT_SESSION', 'LEGACY', 'LEGACY_PLAN_CHECKOUT', 'STRIPE_CHECKOUT_ORIGIN'],
        ['CHECKOUT_SESSION', 'INDEPENDENT', 'TERMINAL_ORDER_CHECKOUT', 'TERMINAL_ORDER'],
        ['SUBSCRIPTION', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
        ['SUBSCRIPTION', 'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE'],
        ['INVOICE', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
        ['INVOICE', 'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE'],
        ['INVOICE', 'INDEPENDENT', 'TOKEN_INVOICE', 'TOKEN_PURCHASE'],
        ['PAYMENT_INTENT', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
        ['PAYMENT_INTENT', 'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE'],
        ['PAYMENT_INTENT', 'INDEPENDENT', 'TOKEN_PAYMENT_INTENT', 'TOKEN_PURCHASE'],
        ['CHARGE', 'COMMERCIAL_V2', 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE', 'COMMERCIAL_ACCEPTANCE'],
        ['CHARGE', 'LEGACY', 'LEGACY_SUBSCRIPTION_LIFECYCLE', 'VENUE_FEATURE'],
      ] as const
      for (const [index, [objectType, ownerKind, routeKey, subjectKind]] of allowedBindingMatrix.entries()) {
        await sql.query(
          `INSERT INTO "StripeObjectBinding" ("objectType", "stripeObjectId", "ownerKind", "routeKey", "subjectKind", "subjectId")
           VALUES ($1::"StripeObjectType", $2, $3::"StripeEventOwnerKind", $4::"StripeEventRouteKey", $5::"StripeEventSubjectKind", $6)`,
          [objectType, `object-${index}`, ownerKind, routeKey, subjectKind, `binding-subject-${index}`],
        )
      }
      const classifiedMatrixCount = await sql.query(`SELECT count(*)::integer AS count FROM "WebhookEvent" WHERE id LIKE 'matrix-event-%'`)
      const bindingMatrixCount = await sql.query(
        `SELECT count(*)::integer AS count FROM "StripeObjectBinding" WHERE "stripeObjectId" LIKE 'object-%'`,
      )
      const webhookAuthorityUpdateRejected = await rejected(
        `UPDATE "WebhookEvent" SET "subjectId" = 'changed' WHERE id = 'matrix-event-0'`,
        '55000',
      )
      const webhookAuthorityClearRejected = await rejected(
        `UPDATE "WebhookEvent" SET "ownerKind" = NULL, "routeKey" = NULL, "subjectKind" = NULL, "subjectId" = NULL WHERE id = 'matrix-event-0'`,
        '55000',
      )
      const webhookAuthorityStillPresent = await sql.query(`SELECT "subjectId" FROM "WebhookEvent" WHERE id = 'matrix-event-0'`)
      const bindingUpdateRejected = await rejected(
        `UPDATE "StripeObjectBinding" SET "subjectId" = 'changed' WHERE "objectType" = 'CHECKOUT_SESSION' AND "stripeObjectId" = 'object-0'`,
        '55000',
      )
      const bindingDeleteRejected = await rejected(
        `DELETE FROM "StripeObjectBinding" WHERE "objectType" = 'CHECKOUT_SESSION' AND "stripeObjectId" = 'object-0'`,
        '55000',
      )
      const bindingStillPresent = await sql.query(
        `SELECT "subjectId" FROM "StripeObjectBinding" WHERE "objectType" = 'CHECKOUT_SESSION' AND "stripeObjectId" = 'object-0'`,
      )
      const a0Origin = await sql.query(
        `SELECT "stripeCheckoutSessionId", "ownerKind", "routeKey", "venueId", "featureId", "stripeCustomerId", "billingInterval"
         FROM "StripeCheckoutOrigin" WHERE "stripeCheckoutSessionId" = 'cs_a0_before_a1a'`,
      )
      const a0OriginUpdateRejected = await rejected(
        `UPDATE "StripeCheckoutOrigin" SET "stripeCustomerId" = 'cus_changed' WHERE "stripeCheckoutSessionId" = 'cs_a0_before_a1a'`,
        '55000',
      )
      const a0OriginTrigger = await sql.query(`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = '"StripeCheckoutOrigin"'::regclass
          AND tgname = 'stripe_checkout_origin_immutable'
          AND NOT tgisinternal
      `)
      const constraintNames = await sql.query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid IN ('"WebhookEvent"'::regclass, '"StripeObjectBinding"'::regclass)
      `)
      const triggerNames = await sql.query(`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid IN ('"WebhookEvent"'::regclass, '"StripeObjectBinding"'::regclass) AND NOT tgisinternal
      `)

      return {
        rows: rows.rows,
        fresh: fresh.rows[0],
        classifierLookupIndexes: classifierLookupIndexes.rows.map(row => row.indexname),
        duplicateLookupCounts: duplicateLookupCounts.rows[0],
        partialTupleRejected,
        classifiedWithoutTupleRejected,
        incompleteLeaseRejected,
        invalidLeaseExpiryRejected,
        reservedCreditPackRejected,
        legacyOriginSubscriptionEventRejected,
        legacyOriginSubscriptionBindingRejected,
        bindingObjectTypeMismatchResults,
        unresolvedWithoutReasonRejected,
        emptySubjectRejected,
        emptyClaimTokenRejected,
        emptyClaimedByRejected,
        emptyBindingObjectIdRejected,
        classifiedMatrixCount: classifiedMatrixCount.rows[0].count,
        bindingMatrixCount: bindingMatrixCount.rows[0].count,
        webhookAuthorityUpdateRejected,
        webhookAuthorityClearRejected,
        webhookAuthorityStillPresent: webhookAuthorityStillPresent.rows[0],
        bindingUpdateRejected,
        bindingDeleteRejected,
        bindingStillPresent: bindingStillPresent.rows[0],
        a0Origin: a0Origin.rows[0],
        a0OriginUpdateRejected,
        a0OriginTriggerPresent: a0OriginTrigger.rowCount === 1,
        constraintNames: constraintNames.rows.map(row => row.conname),
        triggerNames: triggerNames.rows.map(row => row.tgname),
      }
    })

    expect(proof.result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'historic-success',
          classificationState: 'LEGACY_UNCLASSIFIED',
          effectAttempts: 2,
          effectNextAttemptAt: null,
        }),
        expect.objectContaining({
          id: 'historic-pending',
          classificationState: 'LEGACY_UNCLASSIFIED',
          effectAttempts: 0,
          effectNextAttemptAt: expect.any(Date),
        }),
        expect.objectContaining({ id: 'historic-failed-below', effectAttempts: 4, effectNextAttemptAt: expect.any(Date) }),
        expect.objectContaining({ id: 'historic-failed-at', effectAttempts: 5, effectNextAttemptAt: expect.any(Date) }),
        expect.objectContaining({ id: 'historic-retrying', effectAttempts: 1, effectNextAttemptAt: expect.any(Date) }),
      ]),
    )
    for (const row of proof.result.rows) {
      expect(row).toMatchObject({
        classificationNextAttemptAt: null,
        classificationResolvedAt: null,
        ownerKind: null,
        routeKey: null,
        subjectKind: null,
        subjectId: null,
        effectAttempts: row.retryCount,
      })
    }
    expect(proof.result.fresh).toMatchObject({
      classificationState: 'PENDING_CLASSIFICATION',
      classificationNextAttemptAt: expect.any(Date),
      effectNextAttemptAt: expect.any(Date),
    })
    expect(proof.result.classifierLookupIndexes).toEqual(['TerminalOrder_stripeCheckoutSessionId_idx', 'TokenPurchase_stripeInvoiceId_idx'])
    expect(proof.result.duplicateLookupCounts).toEqual({ terminal_count: 2, token_count: 2 })
    expect(proof.result).toMatchObject({
      partialTupleRejected: true,
      classifiedWithoutTupleRejected: true,
      incompleteLeaseRejected: true,
      invalidLeaseExpiryRejected: true,
      reservedCreditPackRejected: true,
      legacyOriginSubscriptionEventRejected: true,
      legacyOriginSubscriptionBindingRejected: true,
      bindingObjectTypeMismatchResults: [true, true, true, true, true, true],
      unresolvedWithoutReasonRejected: true,
      emptySubjectRejected: true,
      emptyClaimTokenRejected: true,
      emptyClaimedByRejected: true,
      emptyBindingObjectIdRejected: true,
      classifiedMatrixCount: 7,
      bindingMatrixCount: 13,
      webhookAuthorityUpdateRejected: true,
      webhookAuthorityClearRejected: true,
      webhookAuthorityStillPresent: { subjectId: 'subject-0' },
      bindingUpdateRejected: true,
      bindingDeleteRejected: true,
      bindingStillPresent: { subjectId: 'binding-subject-0' },
      a0Origin: {
        stripeCheckoutSessionId: 'cs_a0_before_a1a',
        ownerKind: 'LEGACY',
        routeKey: 'LEGACY_PLAN_CHECKOUT',
        venueId: 'venue-1',
        featureId: 'feature-1',
        stripeCustomerId: 'cus_a0',
        billingInterval: 'MONTHLY',
      },
      a0OriginUpdateRejected: true,
      a0OriginTriggerPresent: true,
    })
    expect(proof.result.constraintNames).toEqual(
      expect.arrayContaining([
        'WebhookEvent_authority_tuple_complete_check',
        'WebhookEvent_classification_state_tuple_check',
        'WebhookEvent_classification_schedule_check',
        'WebhookEvent_attempts_nonnegative_check',
        'WebhookEvent_unresolved_reason_check',
        'WebhookEvent_lease_complete_check',
        'WebhookEvent_lease_expiry_check',
        'WebhookEvent_authority_matrix_check',
        'StripeObjectBinding_object_id_nonempty_check',
        'StripeObjectBinding_subject_nonempty_check',
        'StripeObjectBinding_authority_matrix_check',
        'StripeObjectBinding_object_type_authority_check',
      ]),
    )
    expect(proof.result.triggerNames).toEqual(
      expect.arrayContaining(['webhook_event_authority_immutable', 'stripe_object_binding_immutable']),
    )
    expect(proof).toMatchObject({ cleanupConfirmed: true, residualCount: 0 })
  })

  it('lets one worker own a live lease, recovers expiry with a new token, and rejects the stale worker CAS', async () => {
    const proof = await withDisposableDatabase(async ({ first, second, sql, applyRuntimeMigration }) => {
      await applyRuntimeMigration()
      let now = new Date('2026-08-23T18:00:00.000Z')
      const repositoryA = createPrismaPlatformWebhookRepository(first)
      const repositoryB = createPrismaPlatformWebhookRepository(second)
      let tokenA = 0
      const workerA = createPlatformWebhookInboxService({
        repository: repositoryA,
        now: () => now,
        workerId: 'worker-a',
        newClaimToken: () => `token-a-${++tokenA}`,
        leaseMs: 30_000,
        maxAttempts: { classification: 5, effect: 5 },
        retryBackoff: { baseMs: 2_000, maxMs: 30_000 },
      })
      let tokenB = 0
      const workerB = createPlatformWebhookInboxService({
        repository: repositoryB,
        now: () => now,
        workerId: 'worker-b',
        newClaimToken: () => `token-b-${++tokenB}`,
        leaseMs: 30_000,
        maxAttempts: { classification: 5, effect: 5 },
        retryBackoff: { baseMs: 2_000, maxMs: 30_000 },
      })
      const concurrentObserved = await workerA.observe({
        stripeEventId: 'evt_live_lease_race',
        eventType: 'invoice.paid',
        payload: { id: 'evt_live_lease_race' },
      })
      const raceWorkerA = createPlatformWebhookInboxService({
        repository: repositoryA,
        now: () => now,
        workerId: 'race-worker-a',
        newClaimToken: () => 'race-token-a',
        leaseMs: 30_000,
        maxAttempts: { classification: 5, effect: 5 },
        retryBackoff: { baseMs: 2_000, maxMs: 30_000 },
      })
      const raceWorkerB = createPlatformWebhookInboxService({
        repository: repositoryB,
        now: () => now,
        workerId: 'race-worker-b',
        newClaimToken: () => 'race-token-b',
        leaseMs: 30_000,
        maxAttempts: { classification: 5, effect: 5 },
        retryBackoff: { baseMs: 2_000, maxMs: 30_000 },
      })
      const concurrentClaims = await Promise.all([
        raceWorkerA.acquire(concurrentObserved.event.id, 'CLASSIFICATION'),
        raceWorkerB.acquire(concurrentObserved.event.id, 'CLASSIFICATION'),
      ])
      const observed = await workerA.observe({ stripeEventId: 'evt_race', eventType: 'invoice.paid', payload: { id: 'evt_race' } })
      const firstLease = await workerA.acquire(observed.event.id, 'CLASSIFICATION')
      const blocked = await workerB.acquire(observed.event.id, 'EFFECT')
      now = new Date(now.getTime() + 30_001)
      const recovered = await workerB.acquire(observed.event.id, 'CLASSIFICATION')
      let stale = false
      try {
        await workerA.release(firstLease!)
      } catch (error) {
        stale = error instanceof StaleWebhookLeaseError
      }
      let staleFinalize = false
      try {
        await workerA.finalizeClassification(firstLease!, { state: 'IGNORED', code: 'STALE' })
      } catch (error) {
        staleFinalize = error instanceof StaleWebhookLeaseError
      }
      let staleRetry = false
      try {
        await workerA.retry(firstLease!, { code: 'STALE', message: 'old worker must not reschedule' })
      } catch (error) {
        staleRetry = error instanceof StaleWebhookLeaseError
      }
      await workerB.finalizeClassification(recovered!, {
        state: 'CLASSIFIED',
        authority: {
          ownerKind: 'COMMERCIAL_V2',
          routeKey: 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE',
          subjectKind: 'COMMERCIAL_ACCEPTANCE',
          subjectId: 'acceptance_1',
        },
      })
      const effectObserved = await workerA.observe({
        stripeEventId: 'evt_effect_stale_complete',
        eventType: 'invoice.paid',
        payload: { id: 'evt_effect_stale_complete' },
      })
      const effectLeaseA = await workerA.acquire(effectObserved.event.id, 'EFFECT')
      now = new Date(now.getTime() + 30_001)
      const effectLeaseB = await workerB.acquire(effectObserved.event.id, 'EFFECT')
      let staleCompleteEffect = false
      try {
        await workerA.completeEffect(effectLeaseA!, { processingTime: 99 })
      } catch (error) {
        staleCompleteEffect = error instanceof StaleWebhookLeaseError
      }
      await workerB.completeEffect(effectLeaseB!, { processingTime: 42 })
      const effectRow = await first.webhookEvent.findUniqueOrThrow({ where: { id: effectObserved.event.id } })
      const authorityUpdateRejected = await (async () => {
        try {
          await sql.query(`UPDATE "WebhookEvent" SET "subjectId" = 'acceptance_changed' WHERE id = $1`, [observed.event.id])
          return false
        } catch (error: any) {
          return error.code === '55000'
        }
      })()
      const authorityClearRejected = await (async () => {
        try {
          await sql.query(
            `UPDATE "WebhookEvent" SET "ownerKind" = NULL, "routeKey" = NULL, "subjectKind" = NULL, "subjectId" = NULL WHERE id = $1`,
            [observed.event.id],
          )
          return false
        } catch (error: any) {
          return error.code === '55000'
        }
      })()
      const row = await first.webhookEvent.findUniqueOrThrow({ where: { id: observed.event.id } })
      return {
        concurrentClaims,
        firstLease,
        blocked,
        recovered,
        stale,
        staleFinalize,
        staleRetry,
        effectLeaseA,
        effectLeaseB,
        staleCompleteEffect,
        effectRow,
        authorityUpdateRejected,
        authorityClearRejected,
        row,
      }
    })

    expect(proof.result.concurrentClaims.filter(Boolean)).toHaveLength(1)
    expect(proof.result.concurrentClaims.filter(claim => claim === null)).toHaveLength(1)
    expect(proof.result.firstLease).toMatchObject({ claimToken: 'token-a-1', attempt: 1 })
    expect(proof.result.blocked).toBeNull()
    expect(proof.result.recovered).toMatchObject({ claimToken: 'token-b-2', attempt: 2 })
    expect(proof.result.stale).toBe(true)
    expect(proof.result.staleFinalize).toBe(true)
    expect(proof.result.staleRetry).toBe(true)
    expect(proof.result.effectLeaseA).toMatchObject({ phase: 'EFFECT', claimToken: 'token-a-2', attempt: 1 })
    expect(proof.result.effectLeaseB).toMatchObject({ phase: 'EFFECT', claimToken: 'token-b-3', attempt: 2 })
    expect(proof.result.staleCompleteEffect).toBe(true)
    expect(proof.result.effectRow).toMatchObject({
      status: 'SUCCESS',
      effectAttempts: 2,
      retryCount: 2,
      effectNextAttemptAt: null,
      processingTime: 42,
      claimPhase: null,
      claimToken: null,
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
    })
    expect(proof.result.authorityUpdateRejected).toBe(true)
    expect(proof.result.authorityClearRejected).toBe(true)
    expect(proof.result.row).toMatchObject({
      classificationState: 'CLASSIFIED',
      classificationAttempts: 2,
      effectAttempts: 0,
      retryCount: 0,
      ownerKind: 'COMMERCIAL_V2',
      routeKey: 'COMMERCIAL_SUBSCRIPTION_LIFECYCLE',
      subjectKind: 'COMMERCIAL_ACCEPTANCE',
      subjectId: 'acceptance_1',
      claimPhase: null,
      claimToken: null,
      claimedBy: null,
      claimedAt: null,
      claimExpiresAt: null,
    })
    expect(proof).toMatchObject({ cleanupConfirmed: true, residualCount: 0 })
  })

  it('increments effectAttempts and retryCount together, schedules bounded retry, and refuses an exhausted final-attempt lease', async () => {
    const proof = await withDisposableDatabase(async ({ first, sql, applyRuntimeMigration }) => {
      await applyRuntimeMigration()
      let now = new Date('2026-08-23T18:00:00.000Z')
      const service = createPlatformWebhookInboxService({
        repository: createPrismaPlatformWebhookRepository(first),
        now: () => now,
        workerId: 'effect-worker',
        newClaimToken: () => randomUUID(),
        leaseMs: 30_000,
        maxAttempts: { classification: 5, effect: 2 },
        retryBackoff: { baseMs: 2_000, maxMs: 30_000 },
      })
      const observed = await service.observe({ stripeEventId: 'evt_effect', eventType: 'invoice.paid', payload: { id: 'evt_effect' } })
      const firstLease = await service.acquire(observed.event.id, 'EFFECT')
      await service.retry(firstLease!, { code: 'TEMPORARY', message: 'temporary provider error with details' })
      const afterRetry = await first.webhookEvent.findUniqueOrThrow({ where: { id: observed.event.id } })
      await sql.query(`UPDATE "WebhookEvent" SET "effectNextAttemptAt" = $1::timestamp WHERE id = $2`, [
        now.toISOString(),
        observed.event.id,
      ])
      const secondLease = await service.acquire(observed.event.id, 'EFFECT')
      now = new Date(now.getTime() + 30_001)
      const exhausted = await service.acquire(observed.event.id, 'EFFECT')
      const finalRow = await first.webhookEvent.findUniqueOrThrow({ where: { id: observed.event.id } })
      return { firstLease, afterRetry, secondLease, exhausted, finalRow }
    })

    expect(proof.result.firstLease).toMatchObject({ phase: 'EFFECT', attempt: 1 })
    expect(proof.result.afterRetry).toMatchObject({
      status: 'FAILED',
      effectAttempts: 1,
      retryCount: 1,
      effectNextAttemptAt: new Date('2026-08-23T18:00:02.000Z'),
      claimPhase: null,
    })
    expect(proof.result.secondLease).toMatchObject({ phase: 'EFFECT', attempt: 2 })
    expect(proof.result.exhausted).toBeNull()
    expect(proof.result.finalRow).toMatchObject({ effectAttempts: 2, retryCount: 2, claimPhase: 'EFFECT' })
    expect(proof).toMatchObject({ cleanupConfirmed: true, residualCount: 0 })
  })

  it('keeps original event payload JSON and first binding provenance while returning typed authority conflicts', async () => {
    const proof = await withDisposableDatabase(async ({ first, second, applyRuntimeMigration }) => {
      await applyRuntimeMigration()
      const now = new Date('2026-08-23T18:00:00.000Z')
      const service = createPlatformWebhookInboxService({
        repository: createPrismaPlatformWebhookRepository(first),
        now: () => now,
        workerId: 'binding-worker',
        newClaimToken: () => randomUUID(),
        leaseMs: 30_000,
        maxAttempts: { classification: 5, effect: 5 },
        retryBackoff: { baseMs: 2_000, maxMs: 30_000 },
      })
      const secondService = createPlatformWebhookInboxService({
        repository: createPrismaPlatformWebhookRepository(second),
        now: () => now,
        workerId: 'binding-worker-2',
        newClaimToken: () => randomUUID(),
        leaseMs: 30_000,
        maxAttempts: { classification: 5, effect: 5 },
        retryBackoff: { baseMs: 2_000, maxMs: 30_000 },
      })
      const concurrentEvents = await Promise.all([
        service.observe({ stripeEventId: 'evt_concurrent', eventType: 'invoice.paid', payload: { canonical: true } }),
        secondService.observe({ stripeEventId: 'evt_concurrent', eventType: 'invoice.paid', payload: { canonical: true } }),
      ])
      const firstEvent = await service.observe({ stripeEventId: 'evt_original', eventType: 'invoice.paid', payload: { original: true } })
      const duplicate = await service.observe({ stripeEventId: 'evt_original', eventType: 'invoice.paid', payload: { original: true } })
      let payloadConflict = false
      try {
        await service.observe({ stripeEventId: 'evt_original', eventType: 'invoice.paid', payload: { original: false } })
      } catch (error) {
        payloadConflict = error instanceof WebhookEventConflictError
      }
      let eventConflict = false
      try {
        await service.observe({ stripeEventId: 'evt_original', eventType: 'charge.refunded', payload: { manipulated: true } })
      } catch (error) {
        eventConflict = error instanceof WebhookEventConflictError
      }
      const authority = {
        ownerKind: 'LEGACY' as const,
        routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE' as const,
        subjectKind: 'VENUE_FEATURE' as const,
        subjectId: 'venue-feature-1',
      }
      const created = await service.bind({
        objectType: 'SUBSCRIPTION',
        stripeObjectId: 'sub_1',
        authority,
        sourceWebhookEventId: firstEvent.event.id,
      })
      const sameAuthority = await service.bind({
        objectType: 'SUBSCRIPTION',
        stripeObjectId: 'sub_1',
        authority,
        sourceWebhookEventId: null,
      })
      const concurrentBindings = await Promise.all([
        service.bind({ objectType: 'INVOICE', stripeObjectId: 'in_concurrent', authority, sourceWebhookEventId: null }),
        secondService.bind({ objectType: 'INVOICE', stripeObjectId: 'in_concurrent', authority, sourceWebhookEventId: null }),
      ])
      let bindingConflict = false
      try {
        await service.bind({
          objectType: 'SUBSCRIPTION',
          stripeObjectId: 'sub_1',
          authority: { ...authority, subjectId: 'venue-feature-2' },
          sourceWebhookEventId: null,
        })
      } catch (error) {
        bindingConflict = error instanceof StripeObjectBindingConflictError
      }
      const binding = await first.stripeObjectBinding.findUniqueOrThrow({
        where: { objectType_stripeObjectId: { objectType: 'SUBSCRIPTION', stripeObjectId: 'sub_1' } },
      })
      const persistedEvent = await first.webhookEvent.findUniqueOrThrow({ where: { id: firstEvent.event.id } })
      return {
        concurrentEvents,
        firstEvent,
        duplicate,
        payloadConflict,
        eventConflict,
        created,
        sameAuthority,
        concurrentBindings,
        bindingConflict,
        binding,
        persistedEvent,
      }
    })

    expect(proof.result.firstEvent.created).toBe(true)
    expect(proof.result.concurrentEvents.map(result => result.created).sort()).toEqual([false, true])
    expect(proof.result.duplicate.created).toBe(false)
    expect(proof.result.payloadConflict).toBe(true)
    expect(proof.result.eventConflict).toBe(true)
    expect(proof.result.persistedEvent).toMatchObject({ eventType: 'invoice.paid', payload: { original: true } })
    expect(proof.result.created.status).toBe('CREATED')
    expect(proof.result.sameAuthority.status).toBe('EXISTING')
    expect(proof.result.concurrentBindings.map(result => result.status).sort()).toEqual(['CREATED', 'EXISTING'])
    expect(proof.result.bindingConflict).toBe(true)
    expect(proof.result.binding).toMatchObject({
      ownerKind: 'LEGACY',
      routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE',
      subjectKind: 'VENUE_FEATURE',
      subjectId: 'venue-feature-1',
      sourceWebhookEventId: proof.result.firstEvent.event.id,
    })
    expect(proof).toMatchObject({ cleanupConfirmed: true, residualCount: 0 })
  })
})
