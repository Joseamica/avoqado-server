'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')

const repoRoot = path.resolve(__dirname, '../../..')
const migrationPath = path.join(repoRoot, 'prisma/migrations/20260822050000_add_commercial_catalog_phase1/migration.sql')
const commercialTables = [
  'CommercialDraft',
  'CommercialProductDraft',
  'CommercialPricebookDraft',
  'CommercialPriceDraft',
  'CommercialBundleDraft',
  'CommercialBundleItemDraft',
  'CommercialFeatureBindingDraft',
  'CommercialPublication',
  'CommercialPublicationActivation',
  'CommercialPublicationOutbox',
]

function assertDisposableDatabase(connectionString) {
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required')
  const url = new URL(connectionString)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`Migration replay refuses non-local host ${url.hostname}`)
  }
  if (!url.pathname.startsWith('/avoqado_')) {
    throw new Error(`Migration replay refuses database ${url.pathname}`)
  }
  return url
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z][A-Za-z0-9_]{2,62}$/.test(value)) throw new Error(`Unsafe identifier ${value}`)
  return `"${value}"`
}

async function createLegacySchema(client, schema, populated) {
  const identifier = quoteIdentifier(schema)
  await client.query(`CREATE SCHEMA ${identifier}`)
  await client.query(`SET search_path TO ${identifier}, public`)
  await client.query(`
    CREATE TYPE "PlanTier" AS ENUM ('GRATIS', 'PRO', 'PREMIUM', 'ENTERPRISE');
    CREATE TABLE "Staff" (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "Feature" (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "VenueFeature" (
      id TEXT PRIMARY KEY,
      "venueId" TEXT NOT NULL,
      "featureId" TEXT NOT NULL REFERENCES "Feature"(id),
      active BOOLEAN NOT NULL DEFAULT true,
      settings JSONB,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "Venue" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      "planTier" "PlanTier",
      "seatCapExempt" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "OrganizationEntitlement" (
      id TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      "featureCode" TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      "grantedById" TEXT NOT NULL REFERENCES "Staff"(id),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "CatalogItem" (
      id TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      sku TEXT NOT NULL,
      "normalizedSku" TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "CatalogItemPrice" (
      id TEXT PRIMARY KEY,
      "catalogItemId" TEXT NOT NULL REFERENCES "CatalogItem"(id),
      currency TEXT NOT NULL,
      "salePrice" DECIMAL(12,2) NOT NULL,
      "taxRate" DECIMAL(5,4) NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  await client.query(`
    INSERT INTO "Staff" (id, email, "createdAt")
    VALUES ('staff-legacy', 'legacy@example.test', '2026-08-20T00:00:00.000Z')
  `)
  if (populated) {
    await client.query(`
      INSERT INTO "Feature" (id, code, name, description, enabled, "createdAt")
      VALUES
        ('feature-pos', 'POS_CORE', 'Punto de venta', 'Autoridad legacy: ñ, IVA 16%', true, '2026-08-20T01:00:00.000Z'),
        ('feature-kyc', 'KYC', 'KYC legacy', NULL, false, '2026-08-20T02:00:00.000Z');
      INSERT INTO "VenueFeature" (id, "venueId", "featureId", active, settings, "createdAt")
      VALUES
        ('venue-feature-pos', 'venue-legacy', 'feature-pos', true, '{"devices":"UNLIMITED","rate":"249.00"}'::jsonb, '2026-08-20T03:00:00.000Z'),
        ('venue-feature-kyc', 'venue-legacy', 'feature-kyc', false, '{"reason":"software access must survive"}'::jsonb, '2026-08-20T04:00:00.000Z');
      INSERT INTO "Venue" (id, name, "planTier", "seatCapExempt", "createdAt")
      VALUES ('venue-legacy', 'Restaurante legado', 'PREMIUM', true, '2026-08-20T05:00:00.000Z');
      INSERT INTO "OrganizationEntitlement" (
        id, "organizationId", "featureCode", status, source, reason, "grantedById", "createdAt"
      ) VALUES (
        'entitlement-legacy', 'org-legacy', 'CFDI', 'ACTIVE', 'CONTRACT',
        'Contrato previo al catálogo comercial', 'staff-legacy', '2026-08-20T06:00:00.000Z'
      );
      INSERT INTO "CatalogItem" (
        id, "organizationId", sku, "normalizedSku", name, status, revision, "createdAt"
      ) VALUES (
        'catalog-item-legacy', 'org-legacy', 'LEGACY-SKU-POS', 'legacy-sku-pos',
        'Terminal PAX legacy', 'ACTIVE', 7, '2026-08-20T07:00:00.000Z'
      );
      INSERT INTO "CatalogItemPrice" (
        id, "catalogItemId", currency, "salePrice", "taxRate", "createdAt"
      ) VALUES (
        'catalog-price-legacy', 'catalog-item-legacy', 'MXN', 3499.00, 0.1600, '2026-08-20T08:00:00.000Z'
      );
    `)
  }
}

async function legacyBytes(client) {
  const result = await client.query(`
    SELECT jsonb_build_object(
      'Staff', COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id) FROM "Staff" AS row), '[]'::jsonb),
      'Feature', COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id) FROM "Feature" AS row), '[]'::jsonb),
      'VenueFeature', COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id) FROM "VenueFeature" AS row), '[]'::jsonb),
      'Venue', COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id) FROM "Venue" AS row), '[]'::jsonb),
      'OrganizationEntitlement', COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id) FROM "OrganizationEntitlement" AS row), '[]'::jsonb),
      'CatalogItem', COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id) FROM "CatalogItem" AS row), '[]'::jsonb),
      'CatalogItemPrice', COALESCE((SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id) FROM "CatalogItemPrice" AS row), '[]'::jsonb)
    )::text AS bytes
  `)
  return result.rows[0].bytes
}

async function commercialState(client, schema) {
  const tables = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1
        AND table_name = ANY($2::text[])
      ORDER BY table_name`,
    [schema, commercialTables],
  )
  const counts = {}
  for (const table of commercialTables) {
    const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(table)}`)
    counts[table] = result.rows[0].count
  }
  const taxConstraint = await client.query(
    `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
       JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = $1
        AND table_row.relname = 'CommercialPriceDraft'
        AND constraint_row.conname = 'CommercialPriceDraft_tax_check'`,
    [schema],
  )
  const bundleQuantityConstraint = await client.query(
    `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
       JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = $1
        AND table_row.relname = 'CommercialBundleItemDraft'
        AND constraint_row.conname = 'CommercialBundleItemDraft_quantity_check'`,
    [schema],
  )
  return {
    tables: tables.rows.map(row => row.table_name),
    counts,
    taxConstraint: taxConstraint.rows[0]?.definition,
    bundleQuantityConstraint: bundleQuantityConstraint.rows[0]?.definition,
  }
}

async function replayScenario(client, migrationSql, schema, populated) {
  await createLegacySchema(client, schema, populated)
  const before = await legacyBytes(client)
  await client.query(migrationSql)
  const after = await legacyBytes(client)
  return {
    before,
    after,
    commercial: await commercialState(client, schema),
  }
}

async function main() {
  const database = assertDisposableDatabase(process.env.TEST_DATABASE_URL)
  const migrationSql = fs.readFileSync(migrationPath, 'utf8')
  const suffix = `${process.pid}_${Date.now()}`
  const emptySchema = `commercial_empty_${suffix}`
  const legacySchema = `commercial_legacy_${suffix}`
  const client = new Client({ connectionString: database.toString() })
  await client.connect()
  try {
    const empty = await replayScenario(client, migrationSql, emptySchema, false)
    const legacy = await replayScenario(client, migrationSql, legacySchema, true)
    process.stdout.write(
      JSON.stringify({
        database: { host: database.hostname, pathname: database.pathname },
        migration: path.basename(path.dirname(migrationPath)),
        empty,
        legacy,
      }),
    )
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(emptySchema)} CASCADE`)
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(legacySchema)} CASCADE`)
    await client.end()
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
