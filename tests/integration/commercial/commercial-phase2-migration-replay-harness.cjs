'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')

const repoRoot = path.resolve(__dirname, '../../..')
const phaseOnePath = path.join(repoRoot, 'prisma/migrations/20260822050000_add_commercial_catalog_phase1/migration.sql')
const phaseTwoPath = path.join(repoRoot, 'prisma/migrations/20260822090000_add_commercial_campaigns_quotes_phase2/migration.sql')
const phaseTwoTables = [
  'CommercialCampaignDraft',
  'CommercialCampaignRuleDraft',
  'CommercialCampaignVersion',
  'CommercialCampaignActivation',
  'CommercialCampaignClaim',
  'CommercialAcquisitionContext',
  'CommercialQuote',
  'CommercialQuoteAcceptance',
  'CommercialStripeOperation',
  'CommercialSubscriptionEvent',
]

function disposableDatabase(connectionString) {
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required')
  const url = new URL(connectionString)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error(`Replay refuses non-local host ${url.hostname}`)
  if (!url.pathname.startsWith('/avoqado_')) throw new Error(`Replay refuses database ${url.pathname}`)
  return url
}

function identifier(value) {
  if (!/^[A-Za-z][A-Za-z0-9_]{2,62}$/.test(value)) throw new Error(`Unsafe identifier ${value}`)
  return `"${value}"`
}

async function createPrerequisites(client, schema) {
  await client.query(`CREATE SCHEMA ${identifier(schema)}`)
  await client.query(`SET search_path TO ${identifier(schema)}, public`)
  await client.query(`
    CREATE TABLE "Staff" (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "Organization" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "Venue" (
      id TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL REFERENCES "Organization"(id),
      name TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "LegacyOffer" (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      "priceMinor" INTEGER NOT NULL,
      metadata JSONB NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL
    );
    INSERT INTO "Staff" (id, email, "createdAt")
      VALUES ('staff-legacy', 'legacy@example.test', '2026-08-20T00:00:00.000Z');
    INSERT INTO "Organization" (id, name, "createdAt")
      VALUES ('org-legacy', 'Organización legacy', '2026-08-20T00:00:00.000Z');
    INSERT INTO "Venue" (id, "organizationId", name, "createdAt")
      VALUES ('venue-legacy', 'org-legacy', 'Venue legacy', '2026-08-20T00:00:00.000Z');
    INSERT INTO "LegacyOffer" (id, code, "priceMinor", metadata, "createdAt")
      VALUES ('legacy-offer-1', 'legacy-pos-249', 24900, '{"iva":1600,"devices":"UNLIMITED"}', '2026-08-20T01:00:00.000Z');
  `)
}

async function existingTables(client, schema) {
  const result = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
    [schema],
  )
  return result.rows.map(row => row.table_name)
}

async function tableBytes(client, tables) {
  const bytes = {}
  for (const table of tables) {
    const result = await client.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY to_jsonb(row_value)::text), '[]'::jsonb)::text AS bytes
         FROM ${identifier(table)} AS row_value`,
    )
    bytes[table] = result.rows[0].bytes
  }
  return bytes
}

async function phaseTwoState(client, schema) {
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name`,
    [schema, phaseTwoTables],
  )
  const counts = {}
  for (const table of phaseTwoTables) {
    const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${identifier(table)}`)
    counts[table] = result.rows[0].count
  }
  const constraint = await client.query(
    `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
       JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = $1
        AND constraint_row.conname = 'CommercialQuote_snapshot_totals_check'`,
    [schema],
  )
  const triggers = await client.query(
    `SELECT trigger_row.tgname AS name
       FROM pg_trigger AS trigger_row
       JOIN pg_class AS table_row ON table_row.oid = trigger_row.tgrelid
       JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = $1
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgname LIKE 'commercial_%_immutable'
      ORDER BY trigger_row.tgname`,
    [schema],
  )
  return {
    tables: tables.rows.map(row => row.table_name),
    counts,
    snapshotConstraint: constraint.rows[0]?.definition,
    immutableTriggers: triggers.rows.map(row => row.name),
  }
}

async function main() {
  const database = disposableDatabase(process.env.TEST_DATABASE_URL)
  const schema = `commercial_phase2_replay_${process.pid}_${Date.now()}`
  const phaseOneSql = fs.readFileSync(phaseOnePath, 'utf8')
  const phaseTwoSql = fs.readFileSync(phaseTwoPath, 'utf8')
  const client = new Client({ connectionString: database.toString() })
  await client.connect()
  try {
    await createPrerequisites(client, schema)
    await client.query(phaseOneSql)
    await client.query(`
      INSERT INTO "CommercialDraft" (
        "id", "sourceKey", "name", "description", "status", "revision", "createdById", "updatedById", "createdAt", "updatedAt"
      ) VALUES (
        'phase-one-draft', 'phase-one-draft', 'Phase one preserved', 'Must survive Phase 2 byte-for-byte',
        'ACTIVE', 1, 'staff-legacy', 'staff-legacy', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z'
      )
    `)
    const priorTables = await existingTables(client, schema)
    const before = await tableBytes(client, priorTables)
    await client.query(phaseTwoSql)
    const after = await tableBytes(client, priorTables)
    process.stdout.write(
      JSON.stringify({
        migration: path.basename(path.dirname(phaseTwoPath)),
        before,
        after,
        phaseTwo: await phaseTwoState(client, schema),
      }),
    )
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`)
    await client.end()
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
