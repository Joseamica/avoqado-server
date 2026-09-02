'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')

const repoRoot = path.resolve(__dirname, '../../..')
const migrationName = '20260823150000_add_stripe_checkout_origin'
const migrationPath = path.join(repoRoot, 'prisma/migrations', migrationName, 'migration.sql')

function localTestServer(connectionString) {
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required')
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`Harness refuses protocol ${url.protocol}`)
  if (url.search) throw new Error('Harness refuses connection-string query parameters')
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error(`Harness refuses non-local host ${url.hostname}`)
  const database = decodeURIComponent(url.pathname.slice(1))
  if (!/(?:-|_)test$/.test(database)) {
    throw new Error(`Harness refuses non-test database ${database}`)
  }
  const port = url.port ? Number(url.port) : 5432
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Harness refuses invalid port ${url.port}`)
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (!user || !password) throw new Error('Harness requires explicit database user and password')
  return { host: url.hostname, port, user, password, database, ssl: false }
}

function identifier(value) {
  if (!/^[A-Za-z][A-Za-z0-9_]{2,62}$/.test(value)) throw new Error(`Unsafe identifier ${value}`)
  return `"${value}"`
}

async function rejectedWith(client, sql, expectedCode) {
  try {
    await client.query(sql)
    return false
  } catch (error) {
    return error.code === expectedCode
  }
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1'
}

async function connectionIdentity(client) {
  const result = await client.query(`
    SELECT current_database() AS database_name, host(inet_server_addr()) AS server_address
  `)
  return result.rows[0]
}

async function main() {
  const server = localTestServer(process.env.TEST_DATABASE_URL)
  const databaseName = `avoqado_p3_1a0_${process.pid}_${Date.now()}`
  const admin = new Client({ ...server, database: 'postgres' })
  const client = new Client({ ...server, database: databaseName })
  let evidence
  let clientConnected = false
  let databaseCreated = false
  let cleanupConfirmed = false

  await admin.connect()
  try {
    if (!/^avoqado_p3_1a0_[0-9]+_[0-9]+$/.test(databaseName)) throw new Error(`Unsafe target database ${databaseName}`)
    const adminIdentity = await connectionIdentity(admin)
    if (adminIdentity.database_name !== 'postgres' || !isLoopbackAddress(adminIdentity.server_address)) {
      throw new Error(`Unsafe maintenance target ${adminIdentity.database_name}@${adminIdentity.server_address}`)
    }
    await admin.query(`CREATE DATABASE ${identifier(databaseName)}`)
    databaseCreated = true
    await client.connect()
    clientConnected = true
    const targetIdentity = await connectionIdentity(client)
    if (targetIdentity.database_name !== databaseName || !isLoopbackAddress(targetIdentity.server_address)) {
      throw new Error(`Unsafe migration target ${targetIdentity.database_name}@${targetIdentity.server_address}`)
    }
    await client.query(`
      CREATE TABLE "Venue" (id TEXT PRIMARY KEY);
      CREATE TABLE "Feature" (id TEXT PRIMARY KEY);
      INSERT INTO "Venue" (id) VALUES ('venue-1'), ('venue-2');
      INSERT INTO "Feature" (id) VALUES ('feature-1'), ('feature-2');
    `)
    await client.query(fs.readFileSync(migrationPath, 'utf8'))

    const table = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, ['"public"."StripeCheckoutOrigin"'])
    const primaryKey = await client.query(`
      SELECT attribute.attname AS column_name
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      JOIN unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
      JOIN pg_attribute attribute ON attribute.attrelid = table_row.oid AND attribute.attnum = key.attnum
      WHERE namespace_row.nspname = 'public'
        AND table_row.relname = 'StripeCheckoutOrigin'
        AND constraint_row.contype = 'p'
      ORDER BY key.ordinality
    `)
    const pairConstraint = await client.query(`
      SELECT pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND constraint_row.conname = 'StripeCheckoutOrigin_owner_route_check'
    `)

    await client.query(`
      INSERT INTO "StripeCheckoutOrigin" (
        "stripeCheckoutSessionId", "ownerKind", "routeKey", "venueId", "featureId", "stripeCustomerId", "billingInterval"
      ) VALUES (
        'cs_legacy_1', 'LEGACY', 'LEGACY_PLAN_CHECKOUT', 'venue-1', 'feature-1', 'cus_1', 'MONTHLY'
      )
    `)

    const duplicateRejected = await rejectedWith(
      client,
      `
      INSERT INTO "StripeCheckoutOrigin" (
        "stripeCheckoutSessionId", "ownerKind", "routeKey", "venueId", "featureId", "stripeCustomerId", "billingInterval"
      ) VALUES (
        'cs_legacy_1', 'LEGACY', 'LEGACY_PLAN_CHECKOUT', 'venue-2', 'feature-2', 'cus_2', 'ANNUAL'
      )
    `,
      '23505',
    )

    await client.query(`ALTER TYPE "StripeEventOwnerKind" ADD VALUE 'COMMERCIAL_V2'`)
    await client.query(`ALTER TYPE "StripeEventRouteKey" ADD VALUE 'COMMERCIAL_V2_CHECKOUT'`)
    const invalidPairRejected = await rejectedWith(
      client,
      `
      INSERT INTO "StripeCheckoutOrigin" (
        "stripeCheckoutSessionId", "ownerKind", "routeKey", "venueId", "featureId", "stripeCustomerId", "billingInterval"
      ) VALUES (
        'cs_invalid_pair', 'COMMERCIAL_V2', 'LEGACY_PLAN_CHECKOUT', 'venue-2', 'feature-2', 'cus_2', 'ANNUAL'
      )
    `,
      '23514',
    )

    const updateRejected = await rejectedWith(
      client,
      `UPDATE "StripeCheckoutOrigin" SET "stripeCustomerId" = 'cus_changed' WHERE "stripeCheckoutSessionId" = 'cs_legacy_1'`,
      '55000',
    )
    const deleteRejected = await rejectedWith(
      client,
      `DELETE FROM "StripeCheckoutOrigin" WHERE "stripeCheckoutSessionId" = 'cs_legacy_1'`,
      '55000',
    )
    const venueDeleteRestricted = await rejectedWith(client, `DELETE FROM "Venue" WHERE id = 'venue-1'`, '23503')
    const featureDeleteRestricted = await rejectedWith(client, `DELETE FROM "Feature" WHERE id = 'feature-1'`, '23503')

    evidence = {
      migration: migrationName,
      targetValidated:
        ['127.0.0.1', 'localhost'].includes(server.host) &&
        targetIdentity.database_name === databaseName &&
        isLoopbackAddress(targetIdentity.server_address),
      tablePresent: table.rows[0].present,
      primaryKey: primaryKey.rows.map(row => row.column_name),
      exactPairConstraint:
        pairConstraint.rows.length === 1 &&
        pairConstraint.rows[0].definition.includes("'LEGACY'") &&
        pairConstraint.rows[0].definition.includes("'LEGACY_PLAN_CHECKOUT'"),
      duplicateRejected,
      invalidPairRejected,
      updateRejected,
      deleteRejected,
      venueDeleteRestricted,
      featureDeleteRestricted,
    }
  } finally {
    try {
      if (clientConnected) await client.end()
    } finally {
      try {
        if (databaseCreated) {
          await admin.query(`DROP DATABASE ${identifier(databaseName)}`)
          const dropped = await admin.query(`SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS dropped`, [databaseName])
          cleanupConfirmed = dropped.rows[0].dropped
        }
      } finally {
        await admin.end()
      }
    }
  }

  process.stdout.write(JSON.stringify({ ...evidence, cleanupConfirmed }))
}

module.exports = { localTestServer }

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}
