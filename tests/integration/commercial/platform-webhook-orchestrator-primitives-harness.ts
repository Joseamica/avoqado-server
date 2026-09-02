import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { PrismaClient } from '@prisma/client'

const repoRoot = path.resolve(__dirname, '../../..')
const migrations = [
  '20260823150000_add_stripe_checkout_origin',
  '20260823180000_add_platform_webhook_inbox',
  '20260823210000_add_platform_webhook_orchestrator_primitives',
  '20260824120000_add_webhook_manual_retry_result_outbox',
]
const databasePrefix = 'avoqado_p3_1a1c_a_'

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

async function initializeBaseSchema(client: Client) {
  await client.query(`
    CREATE TYPE "WebhookEventStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'RETRYING');
    CREATE TYPE "ActivityActorType" AS ENUM ('HUMAN', 'SERVICE');
    CREATE TABLE "Staff" (id TEXT PRIMARY KEY);
    CREATE TABLE "Venue" (id TEXT PRIMARY KEY, "stripeCustomerId" TEXT UNIQUE);
    CREATE TABLE "Feature" (id TEXT PRIMARY KEY);
    CREATE TABLE "VenueFeature" (id TEXT PRIMARY KEY, "stripeSubscriptionId" TEXT UNIQUE);
    CREATE TABLE "CommercialQuoteAcceptance" (id TEXT PRIMARY KEY);
    CREATE TABLE "CommercialStripeOperation" (
      id TEXT PRIMARY KEY,
      "acceptanceId" TEXT NOT NULL REFERENCES "CommercialQuoteAcceptance"(id),
      "stripeCheckoutSessionId" TEXT,
      "stripeSubscriptionId" TEXT
    );
    CREATE TABLE "TerminalOrder" (id TEXT PRIMARY KEY, "stripeCheckoutSessionId" TEXT);
    CREATE TABLE "TokenPurchase" (id TEXT PRIMARY KEY, "stripeInvoiceId" TEXT, "stripePaymentIntentId" TEXT UNIQUE);
    CREATE TABLE "CreditPackPurchase" (id TEXT PRIMARY KEY, "stripeCheckoutSessionId" TEXT UNIQUE);
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
    CREATE TABLE "ActivityLog" (
      id TEXT PRIMARY KEY,
      "staffId" TEXT,
      "actorStaffId" TEXT,
      "venueId" TEXT,
      "organizationId" TEXT,
      "actorType" "ActivityActorType",
      "servicePrincipalId" TEXT,
      action TEXT NOT NULL,
      entity TEXT,
      "entityId" TEXT,
      data JSONB,
      "ipAddress" TEXT,
      "userAgent" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ActivityLog_staffId_fkey"
        FOREIGN KEY ("staffId") REFERENCES "Staff"(id) ON DELETE SET NULL ON UPDATE CASCADE
    );
    INSERT INTO "Venue" (id, "stripeCustomerId") VALUES ('venue-1', 'cus_venue_1'), ('venue-2', 'cus_venue_2');
    INSERT INTO "Feature" (id) VALUES ('feature-1'), ('feature-2');
    INSERT INTO "Staff" (id) VALUES ('staff-root');
  `)
  for (const migration of migrations.slice(0, 2)) {
    await client.query(fs.readFileSync(path.join(repoRoot, 'prisma/migrations', migration, 'migration.sql'), 'utf8'))
  }
}

export interface OrchestratorPrimitivesHarnessClients {
  first: PrismaClient
  second: PrismaClient
  sql: Client
  databaseUrl: string
  applyA1cMigration(): Promise<void>
  applyA1cCManualRetryMigration(): Promise<void>
}

export async function withOrchestratorPrimitivesDatabase<T>(run: (clients: OrchestratorPrimitivesHarnessClients) => Promise<T>) {
  const server = localTestServer(process.env.TEST_DATABASE_URL)
  const databaseName = `${databasePrefix}${process.pid}_${Date.now()}_${randomUUID().split('-').join('').slice(0, 8)}`
  if (!/^avoqado_p3_1a1c_a_[0-9]+_[0-9]+_[a-f0-9]{8}$/.test(databaseName)) throw new Error(`Unsafe target ${databaseName}`)
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
    await initializeBaseSchema(sql)
    first = new PrismaClient({ datasources: { db: { url } } })
    second = new PrismaClient({ datasources: { db: { url } } })
    result = await run({
      first,
      second,
      sql,
      databaseUrl: url,
      applyA1cMigration: async () => {
        await sql!.query(fs.readFileSync(path.join(repoRoot, 'prisma/migrations', migrations[2], 'migration.sql'), 'utf8'))
      },
      applyA1cCManualRetryMigration: async () => {
        await sql!.query(fs.readFileSync(path.join(repoRoot, 'prisma/migrations', migrations[3], 'migration.sql'), 'utf8'))
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
