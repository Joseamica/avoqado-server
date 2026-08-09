const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { Client } = require('pg')

const repoRoot = path.resolve(__dirname, '../../..')
const migrationsRoot = path.join(repoRoot, 'prisma/migrations')
const fixturePath = path.join(repoRoot, 'tests/fixtures/master-catalog/h1a-legacy-graph.sql')
const cutoff = '20260808010000_add_cash_reconciliation_opt_in'
const rejectedMonolith = '20260808120000_add_master_catalog_core'
const h1aChain = [
  '20260808120000_add_h1a_catalog_types',
  '20260808120100_add_h1a_activity_log_columns',
  '20260808120200_add_h1a_module_scope',
  '20260808120300_add_h1a_product_creator',
  '20260808120400_add_h1a_venue_governance_fence',
  '20260808120500_index_activity_log_organization_concurrently',
  '20260808120600_index_activity_log_actor_type_concurrently',
  '20260808120700_index_activity_log_service_principal_concurrently',
  '20260808120750_index_activity_log_actor_staff_concurrently',
  '20260808120800_index_product_creator_concurrently',
  '20260808120900_index_product_venue_key_concurrently',
  '20260808121000_index_venue_organization_key_concurrently',
  '20260808121100_add_h1a_master_catalog_core',
  '20260808121101_add_organization_entitlement_hot_parent_fks_not_valid',
  '20260808121102_add_catalog_brand_hot_parent_fks_not_valid',
  '20260808121103_add_catalog_manufacturer_hot_parent_fks_not_valid',
  '20260808121104_add_catalog_family_hot_parent_fks_not_valid',
  '20260808121105_add_catalog_item_hot_parent_fks_not_valid',
  '20260808121106_add_catalog_item_business_type_hot_parent_fks_not_valid',
  '20260808121107_add_catalog_product_type_mapping_hot_parent_fks_not_valid',
  '20260808121108_add_catalog_identifier_hot_parent_fks_not_valid',
  '20260808121109_add_catalog_validation_profile_hot_parent_fks_not_valid',
  '20260808121110_add_catalog_item_price_hot_parent_fks_not_valid',
  '20260808121111_add_catalog_venue_rollout_hot_parent_fks_not_valid',
  '20260808121112_add_catalog_venue_client_requirement_hot_parent_fks_not_valid',
  '20260808121113_add_catalog_client_observation_hot_parent_fks_not_valid',
  '20260808121114_add_catalog_client_readiness_override_hot_parent_fks_not_valid',
  '20260808121115_add_catalog_venue_binding_hot_parent_fks_not_valid',
  '20260808121116_add_catalog_venue_override_hot_parent_fks_not_valid',
  '20260808121117_add_catalog_idempotency_record_hot_parent_fks_not_valid',
  '20260808121118_add_catalog_import_batch_hot_parent_fks_not_valid',
  '20260808121119_add_catalog_import_line_hot_parent_fks_not_valid',
  '20260808121120_add_catalog_binding_batch_hot_parent_fks_not_valid',
  '20260808121121_add_catalog_binding_line_hot_parent_fks_not_valid',
  '20260808121122_add_catalog_publication_batch_hot_parent_fks_not_valid',
  '20260808121123_add_catalog_publication_line_hot_parent_fks_not_valid',
  '20260808121124_add_catalog_publication_field_decision_hot_parent_fks_not_valid',
  '20260808121125_add_catalog_venue_event_sequence_hot_parent_fks_not_valid',
  '20260808121126_add_catalog_publication_outbox_hot_parent_fks_not_valid',
  '20260808121150_validate_h1a_hot_parent_fks',
  '20260808121200_add_product_creator_fk_not_valid',
  '20260808121300_add_activity_log_constraints_not_valid',
  '20260808121400_add_activity_log_tenant_guard',
  '20260808121500_add_venue_governance_write_once_trigger',
  '20260808121600_validate_product_creator_fk',
  '20260808121700_validate_activity_log_organization_fk',
  '20260808121750_validate_activity_log_actor_staff_fk',
  '20260808121800_validate_activity_log_actor_check',
]
const legacyExpansionChain = h1aChain.slice(0, 5)
const activityConcurrentIndexChain = h1aChain.slice(5, 9)
const productConcurrentIndexChain = h1aChain.slice(9, 11)
const venueConcurrentIndexChain = h1aChain.slice(11, 12)
const coreMigration = h1aChain[12]
const hotParentFkChain = h1aChain.slice(13, 39)
const hotParentFkValidation = h1aChain[39]
const postHotParentChain = h1aChain.slice(40)
const concurrentLegacyIndexes = [
  'ActivityLog_actorStaffId_idx',
  'ActivityLog_actorType_idx',
  'ActivityLog_organizationId_idx',
  'ActivityLog_servicePrincipalId_idx',
  'Product_createdById_idx',
  'Product_id_venueId_key',
  'Venue_id_organizationId_key',
]

// Expand-only replay must prove that no H1 row was synthesized anywhere, not
// just in the six aggregates used by early acceptance drafts.
const h1aEmptyTables = [
  'OrganizationEntitlement',
  'CatalogBrand',
  'CatalogManufacturer',
  'CatalogFamily',
  'CatalogItem',
  'CatalogItemBusinessType',
  'CatalogProductTypeMapping',
  'CatalogIdentifier',
  'CatalogValidationProfile',
  'CatalogItemPrice',
  'CatalogVenueRollout',
  'CatalogVenueClientRequirement',
  'CatalogClientObservation',
  'CatalogClientReadinessOverride',
  'CatalogVenueBinding',
  'CatalogVenueOverride',
  'CatalogIdempotencyRecord',
  'CatalogImportBatch',
  'CatalogImportLine',
  'CatalogBindingBatch',
  'CatalogBindingLine',
  'CatalogPublicationBatch',
  'CatalogPublicationLine',
  'CatalogPublicationFieldDecision',
  'CatalogVenueEventSequence',
  'CatalogPublicationOutbox',
]

function assertedTestUrl() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('DATABASE_URL is required')
  const url = new URL(raw)
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error(`H1 replay refuses non-local host ${url.hostname}`)
  }
  if (url.pathname !== '/avoqado_h1a_test_20260808') {
    throw new Error(`H1 replay refuses database ${url.pathname}`)
  }
  if (process.env.USE_RENDER_DB !== 'false' || process.env.RENDER_DATABASE_URL) {
    throw new Error('H1 replay requires scrubbed Render selectors')
  }
  return url
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: process.env,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout || ''}\n${result.stderr || ''}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

function runAsync(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', chunk => {
    stderr += chunk.toString()
  })
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', status => resolve({ status, stdout, stderr }))
  })
  return { child, completion }
}

function createStaging(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const tempPrisma = path.join(tempRoot, 'prisma')
  const tempMigrations = path.join(tempPrisma, 'migrations')
  const tempConfig = path.join(tempRoot, 'prisma.config.ts')
  fs.mkdirSync(tempMigrations, { recursive: true })
  fs.copyFileSync(path.join(repoRoot, 'prisma/schema.prisma'), path.join(tempPrisma, 'schema.prisma'))
  fs.copyFileSync(path.join(migrationsRoot, 'migration_lock.toml'), path.join(tempMigrations, 'migration_lock.toml'))
  // Staging never imports dotenv: the scrubbed wrapper environment remains the
  // only datasource authority even when repository secrets exist locally.
  fs.writeFileSync(
    tempConfig,
    `export default ${JSON.stringify(
      {
        schema: path.join(tempPrisma, 'schema.prisma'),
        migrations: { path: tempMigrations },
      },
      null,
      2,
    )}\n`,
  )
  return { tempRoot, tempMigrations, tempConfig }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function observeConcurrentIndexWait(client, deployment, indexName, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let observed = null
  while (Date.now() < deadline) {
    const result = await client.query(
      `
      SELECT wait_event_type AS "waitEventType", wait_event AS "waitEvent"
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND state <> 'idle'
         AND query ILIKE '%CREATE%INDEX%CONCURRENTLY%'
         AND query ILIKE $1
       ORDER BY query_start
       LIMIT 1
    `,
      [`%${indexName}%`],
    )
    if (result.rows.length > 0) {
      observed = result.rows[0]
      if (observed.waitEvent === 'virtualxid') return observed
    }
    if (deployment.child.exitCode !== null) return observed
    await delay(25)
  }
  throw new Error('timed out waiting to observe CREATE INDEX CONCURRENTLY')
}

async function observeHotParentFkWait(client, deployment, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let observed = null
  while (Date.now() < deadline) {
    const result = await client.query(`
      SELECT wait_event_type AS "waitEventType", wait_event AS "waitEvent"
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND state <> 'idle'
         AND query ILIKE '%OrganizationEntitlement%'
         AND query ILIKE '%ADD CONSTRAINT%'
       ORDER BY query_start
       LIMIT 1
    `)
    if (result.rows.length > 0) {
      observed = result.rows[0]
      if (observed.waitEvent === 'relation') return observed
    }
    if (deployment.child.exitCode !== null) return observed
    await delay(25)
  }
  throw new Error('timed out waiting to observe the hot-parent FK migration')
}

function validateSourceChain() {
  const names = fs
    .readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
  const nameSet = new Set(names)

  if (!nameSet.has(cutoff)) throw new Error(`missing pre-H1 cutoff ${cutoff}`)
  if (nameSet.has(rejectedMonolith)) throw new Error(`rejected duplicate migration ${rejectedMonolith}`)
  const missing = h1aChain.filter(name => !nameSet.has(name))
  if (missing.length) throw new Error(`missing H1A migrations: ${missing.join(', ')}`)

  const unexpected = names.filter(name => name > cutoff && name.startsWith('2026080812') && !h1aChain.includes(name))
  if (unexpected.length) throw new Error(`unexpected H1A migration(s): ${unexpected.join(', ')}`)

  const legacy = names.filter(name => name <= cutoff).sort()
  if (legacy.length !== 375) throw new Error(`expected 375 legacy migrations, found ${legacy.length}`)
  return legacy
}

function copyMigration(tempMigrations, name) {
  fs.cpSync(path.join(migrationsRoot, name), path.join(tempMigrations, name), {
    recursive: true,
    errorOnExist: true,
  })
}

async function snapshot(client) {
  const counts = await client.query(`
    SELECT 'Product' AS entity, COUNT(*)::int AS count FROM "Product" WHERE "venueId" = 'h1a-legacy-venue'
    UNION ALL SELECT 'ActivityLog', COUNT(*)::int FROM "ActivityLog" WHERE "venueId" = 'h1a-legacy-venue'
    UNION ALL SELECT 'Inventory', COUNT(*)::int FROM "Inventory" WHERE "productId" = 'h1a-legacy-product'
    UNION ALL SELECT 'Recipe', COUNT(*)::int FROM "Recipe" WHERE "productId" = 'h1a-legacy-product'
    UNION ALL SELECT 'ProductModifierGroup', COUNT(*)::int FROM "ProductModifierGroup" WHERE "productId" = 'h1a-legacy-product'
    UNION ALL SELECT 'PricingPolicy', COUNT(*)::int FROM "PricingPolicy" WHERE "productId" = 'h1a-legacy-product'
    UNION ALL SELECT 'OrderItem', COUNT(*)::int FROM "OrderItem" WHERE "productId" = 'h1a-legacy-product'
    UNION ALL SELECT 'VenueModule', COUNT(*)::int FROM "VenueModule" WHERE "id" = 'h1a-legacy-venue-module'
    UNION ALL SELECT 'OrderItemModifier', COUNT(*)::int FROM "OrderItemModifier" WHERE "id" = 'h1a-legacy-order-item-modifier'
  `)
  const graph = await client.query(`
    SELECT p."id" AS "productId", p."venueId", p."categoryId",
           inventory."id" AS "inventoryId", recipe."id" AS "recipeId",
           product_modifier."id" AS "productModifierId",
           pricing."id" AS "pricingPolicyId", order_item."id" AS "orderItemId",
           order_modifier."id" AS "orderItemModifierId"
      FROM "Product" p
      JOIN "Inventory" inventory ON inventory."productId" = p."id"
      JOIN "Recipe" recipe ON recipe."productId" = p."id"
      JOIN "ProductModifierGroup" product_modifier ON product_modifier."productId" = p."id"
      JOIN "PricingPolicy" pricing ON pricing."productId" = p."id"
      JOIN "OrderItem" order_item ON order_item."productId" = p."id"
      JOIN "OrderItemModifier" order_modifier ON order_modifier."orderItemId" = order_item."id"
     WHERE p."id" = 'h1a-legacy-product'
  `)
  return {
    counts: Object.fromEntries(counts.rows.map(row => [row.entity, row.count])),
    graph: graph.rows[0],
  }
}

async function acquireHarnessLock(url) {
  const maintenance = new URL(url)
  maintenance.pathname = '/postgres'
  const client = new Client({ connectionString: maintenance.toString() })
  await client.connect()
  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock(20260808, 120000) AS locked`)
    if (!lock.rows[0]?.locked) throw new Error('another H1 replay owns the advisory lock')
    return client
  } catch (error) {
    await client.end().catch(() => undefined)
    throw error
  }
}

async function releaseHarnessLock(client) {
  await client.query(`SELECT pg_advisory_unlock(20260808, 120000)`).catch(() => undefined)
  await client.end().catch(() => undefined)
}

async function resetDatabase(url, harnessLock) {
  const databaseName = url.pathname.slice(1)

  // Verify the target through PostgreSQL itself before any destructive step;
  // URL parsing alone is not enough when local proxies or config overrides exist.
  const targetClient = new Client({ connectionString: url.toString() })
  await targetClient.connect()
  try {
    const target = await targetClient.query(`SELECT current_database() AS database`)
    if (target.rows[0]?.database !== databaseName) {
      throw new Error(`effective database mismatch: ${target.rows[0]?.database}`)
    }
  } finally {
    await targetClient.end()
  }

  // The caller owns this maintenance session for its entire replay. Keeping
  // the session lock outside reset closes the zero-session copy/deploy window.
  const active = await harnessLock.query(`SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = $1`, [databaseName])
  if (active.rows[0]?.count !== 0) {
    throw new Error(`H1 replay refuses reset while ${active.rows[0]?.count} session(s) use the database`)
  }

  await harnessLock.query(`DROP DATABASE IF EXISTS "avoqado_h1a_test_20260808"`)
  await harnessLock.query(`CREATE DATABASE "avoqado_h1a_test_20260808"`)
}

async function lockSafetyMain() {
  const url = assertedTestUrl()
  const legacyMigrations = validateSourceChain()
  const { tempRoot, tempMigrations, tempConfig } = createStaging('avoqado-h1a-lock-safety-')
  const prismaBin = path.join(repoRoot, 'node_modules/.bin/prisma')
  let snapshotClient
  let observerClient
  let writerClient
  let cicDeployment
  let productCicDeployment
  let hotParentDeployment
  let snapshotOpen = false
  let blockerOpen = false
  let harnessLock

  try {
    harnessLock = await acquireHarnessLock(url)
    await resetDatabase(url, harnessLock)
    for (const name of [...legacyMigrations, ...legacyExpansionChain]) {
      copyMigration(tempMigrations, name)
    }
    run(prismaBin, ['migrate', 'deploy', '--config', tempConfig], { cwd: tempRoot })
    run('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-f', fixturePath])

    snapshotClient = new Client({ connectionString: url.toString() })
    observerClient = new Client({ connectionString: url.toString() })
    writerClient = new Client({ connectionString: url.toString() })
    await Promise.all([snapshotClient.connect(), observerClient.connect(), writerClient.connect()])

    // A repeatable-read snapshot that touches both hot legacy tables forces a
    // concurrent build to exercise PostgreSQL's old-snapshot wait phase.
    await snapshotClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    snapshotOpen = true
    const beforeSnapshot = await snapshotClient.query(`
      SELECT txid_current_snapshot()::text AS snapshot,
             EXISTS (
               SELECT 1 FROM "Product" WHERE "id" = 'h1a-legacy-product'
             ) AS "hasProduct",
             EXISTS (
               SELECT 1 FROM "ActivityLog" WHERE "id" = 'h1a-legacy-activity'
             ) AS "hasActivity"
    `)
    if (!beforeSnapshot.rows[0]?.hasProduct || !beforeSnapshot.rows[0]?.hasActivity) {
      throw new Error('legacy fixture did not establish the expected old snapshot')
    }

    for (const name of activityConcurrentIndexChain) copyMigration(tempMigrations, name)
    cicDeployment = runAsync(prismaBin, ['migrate', 'deploy', '--config', tempConfig], { cwd: tempRoot })
    const observedWait = await observeConcurrentIndexWait(observerClient, cicDeployment, 'ActivityLog_organizationId_idx')

    // A low lock timeout turns any accidental table-locking DDL into a
    // deterministic failure instead of allowing the acceptance to hang.
    await writerClient.query('BEGIN')
    let productUpdateCount
    let activityInsertCount
    try {
      await writerClient.query(`SET LOCAL lock_timeout = '750ms'`)
      await writerClient.query(`SET LOCAL statement_timeout = '5s'`)
      const productUpdate = await writerClient.query(`
        UPDATE "Product"
           SET "name" = 'Legacy bulk product changed during CIC',
               "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'h1a-legacy-product-bulk-0250'
      `)
      const activityInsert = await writerClient.query(`
        INSERT INTO "ActivityLog" ("id", "staffId", "venueId", "action")
        VALUES (
          'h1a-cic-writer-activity',
          'h1a-legacy-staff',
          'h1a-legacy-venue',
          'LEGACY_H1A_CIC_WRITER'
        )
      `)
      productUpdateCount = productUpdate.rowCount
      activityInsertCount = activityInsert.rowCount
      await writerClient.query('COMMIT')
    } catch (error) {
      await writerClient.query('ROLLBACK').catch(() => undefined)
      throw error
    }

    const afterWriterSnapshot = await snapshotClient.query(`
      SELECT txid_current_snapshot()::text AS snapshot,
             EXISTS (
               SELECT 1
                 FROM "Product"
                WHERE "id" = 'h1a-legacy-product-bulk-0250'
                  AND "name" = 'Legacy bulk product changed during CIC'
             ) AS "updatedProductVisible",
             EXISTS (
               SELECT 1
                 FROM "ActivityLog"
                WHERE "id" = 'h1a-cic-writer-activity'
             ) AS "insertedActivityVisible"
    `)
    const snapshotHeldOpen = beforeSnapshot.rows[0].snapshot === afterWriterSnapshot.rows[0].snapshot
    const pendingAfterWriterCommit = cicDeployment.child.exitCode === null

    // Release only after the writer committed; the CIC process can now finish
    // its validation phase without any test process terminating DB sessions.
    await snapshotClient.query('COMMIT')
    snapshotOpen = false
    const cicResult = await cicDeployment.completion
    if (cicResult.status !== 0) {
      throw new Error(`concurrent-index deploy failed (${cicResult.status})\n${cicResult.stdout}\n${cicResult.stderr}`)
    }

    // Repeat the old-snapshot race at the Product CIC boundary itself. This
    // prevents an ActivityLog-only wait from standing in for Product evidence.
    await snapshotClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    snapshotOpen = true
    const beforeProductSnapshot = await snapshotClient.query(`
      SELECT txid_current_snapshot()::text AS snapshot,
             EXISTS (
               SELECT 1 FROM "Product" WHERE "id" = 'h1a-legacy-product'
             ) AS "hasProduct",
             EXISTS (
               SELECT 1 FROM "ActivityLog" WHERE "id" = 'h1a-legacy-activity'
             ) AS "hasActivity"
    `)
    if (!beforeProductSnapshot.rows[0]?.hasProduct || !beforeProductSnapshot.rows[0]?.hasActivity) {
      throw new Error('legacy fixture did not establish the Product CIC snapshot')
    }

    for (const name of productConcurrentIndexChain) copyMigration(tempMigrations, name)
    productCicDeployment = runAsync(prismaBin, ['migrate', 'deploy', '--config', tempConfig], { cwd: tempRoot })
    const observedProductWait = await observeConcurrentIndexWait(observerClient, productCicDeployment, 'Product_createdById_idx')

    await writerClient.query('BEGIN')
    let productCicUpdateCount
    let productCicActivityInsertCount
    try {
      await writerClient.query(`SET LOCAL lock_timeout = '750ms'`)
      await writerClient.query(`SET LOCAL statement_timeout = '5s'`)
      const productUpdate = await writerClient.query(`
        UPDATE "Product"
           SET "name" = 'Legacy bulk product changed during Product CIC',
               "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'h1a-legacy-product-bulk-0248'
      `)
      const activityInsert = await writerClient.query(`
        INSERT INTO "ActivityLog" ("id", "staffId", "venueId", "action")
        VALUES (
          'h1a-product-cic-writer-activity',
          'h1a-legacy-staff',
          'h1a-legacy-venue',
          'LEGACY_H1A_PRODUCT_CIC_WRITER'
        )
      `)
      productCicUpdateCount = productUpdate.rowCount
      productCicActivityInsertCount = activityInsert.rowCount
      await writerClient.query('COMMIT')
    } catch (error) {
      await writerClient.query('ROLLBACK').catch(() => undefined)
      throw error
    }

    const afterProductWriterSnapshot = await snapshotClient.query(`
      SELECT txid_current_snapshot()::text AS snapshot,
             EXISTS (
               SELECT 1
                 FROM "Product"
                WHERE "id" = 'h1a-legacy-product-bulk-0248'
                  AND "name" = 'Legacy bulk product changed during Product CIC'
             ) AS "updatedProductVisible",
             EXISTS (
               SELECT 1
                 FROM "ActivityLog"
                WHERE "id" = 'h1a-product-cic-writer-activity'
             ) AS "insertedActivityVisible"
    `)
    const productSnapshotHeldOpen = beforeProductSnapshot.rows[0].snapshot === afterProductWriterSnapshot.rows[0].snapshot
    const productCicPendingAfterWriterCommit = productCicDeployment.child.exitCode === null

    await snapshotClient.query('COMMIT')
    snapshotOpen = false
    const productCicResult = await productCicDeployment.completion
    if (productCicResult.status !== 0) {
      throw new Error(
        `Product concurrent-index deploy failed (${productCicResult.status})\n${productCicResult.stdout}\n${productCicResult.stderr}`,
      )
    }

    for (const name of venueConcurrentIndexChain) copyMigration(tempMigrations, name)
    run(prismaBin, ['migrate', 'deploy', '--config', tempConfig], { cwd: tempRoot })

    copyMigration(tempMigrations, coreMigration)
    run(prismaBin, ['migrate', 'deploy', '--config', tempConfig], { cwd: tempRoot })

    // Block only the first new child table. The pending ADD FK remains visible
    // while the four legacy parent tables must continue accepting writes.
    await snapshotClient.query('BEGIN')
    blockerOpen = true
    await snapshotClient.query('LOCK TABLE "OrganizationEntitlement" IN ROW EXCLUSIVE MODE')
    for (const name of hotParentFkChain) copyMigration(tempMigrations, name)
    hotParentDeployment = runAsync(prismaBin, ['migrate', 'deploy', '--config', tempConfig], { cwd: tempRoot })
    const observedHotParentWait = await observeHotParentFkWait(observerClient, hotParentDeployment)

    await writerClient.query('BEGIN')
    let organizationUpdateCount
    let staffUpdateCount
    let venueUpdateCount
    let hotParentProductUpdateCount
    try {
      await writerClient.query(`SET LOCAL lock_timeout = '750ms'`)
      await writerClient.query(`SET LOCAL statement_timeout = '5s'`)
      const organizationUpdate = await writerClient.query(`
        UPDATE "Organization"
           SET "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'h1a-legacy-org'
      `)
      const staffUpdate = await writerClient.query(`
        UPDATE "Staff"
           SET "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'h1a-legacy-staff'
      `)
      const venueUpdate = await writerClient.query(`
        UPDATE "Venue"
           SET "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'h1a-legacy-venue'
      `)
      const productUpdate = await writerClient.query(`
        UPDATE "Product"
           SET "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = 'h1a-legacy-product-bulk-0249'
      `)
      organizationUpdateCount = organizationUpdate.rowCount
      staffUpdateCount = staffUpdate.rowCount
      venueUpdateCount = venueUpdate.rowCount
      hotParentProductUpdateCount = productUpdate.rowCount
      await writerClient.query('COMMIT')
    } catch (error) {
      await writerClient.query('ROLLBACK').catch(() => undefined)
      throw error
    }
    const hotParentPendingAfterWriterCommit = hotParentDeployment.child.exitCode === null

    await snapshotClient.query('COMMIT')
    blockerOpen = false
    const hotParentResult = await hotParentDeployment.completion
    if (hotParentResult.status !== 0) {
      throw new Error(`hot-parent FK deploy failed (${hotParentResult.status})\n${hotParentResult.stdout}\n${hotParentResult.stderr}`)
    }

    copyMigration(tempMigrations, hotParentFkValidation)
    run(prismaBin, ['migrate', 'deploy', '--config', tempConfig], { cwd: tempRoot })
    for (const name of postHotParentChain) copyMigration(tempMigrations, name)
    run(prismaBin, ['migrate', 'deploy', '--config', tempConfig], { cwd: tempRoot })

    const indexes = await observerClient.query(
      `
      SELECT index_rel.relname AS name,
             pg_index.indisvalid AS valid,
             pg_index.indisready AS ready
        FROM pg_index
        JOIN pg_class index_rel ON index_rel.oid = pg_index.indexrelid
       WHERE index_rel.relname = ANY($1::text[])
       ORDER BY index_rel.relname
    `,
      [concurrentLegacyIndexes],
    )

    process.stdout.write(
      `${JSON.stringify({
        mode: 'lock-safety',
        database: { host: url.hostname, pathname: url.pathname },
        snapshot: {
          heldOpenDuringWriter: snapshotHeldOpen,
          updatedProductVisible: afterWriterSnapshot.rows[0].updatedProductVisible,
          insertedActivityVisible: afterWriterSnapshot.rows[0].insertedActivityVisible,
        },
        deployment: {
          concurrentIndexObserved: observedWait !== null,
          waitingOnOldSnapshot: observedWait?.waitEvent === 'virtualxid',
          pendingAfterWriterCommit,
        },
        writer: {
          productUpdateCount,
          activityInsertCount,
          lockTimeoutMs: 750,
        },
        indexes: indexes.rows,
        productCicPhase: {
          snapshot: {
            heldOpenDuringWriter: productSnapshotHeldOpen,
            updatedProductVisible: afterProductWriterSnapshot.rows[0].updatedProductVisible,
            insertedActivityVisible: afterProductWriterSnapshot.rows[0].insertedActivityVisible,
          },
          deployment: {
            concurrentIndexObserved: observedProductWait !== null,
            waitingOnOldSnapshot: observedProductWait?.waitEvent === 'virtualxid',
            pendingAfterWriterCommit: productCicPendingAfterWriterCommit,
          },
          writer: {
            productUpdateCount: productCicUpdateCount,
            activityInsertCount: productCicActivityInsertCount,
            lockTimeoutMs: 750,
          },
        },
        hotParentFkPhase: {
          blockerTable: 'OrganizationEntitlement',
          deployment: {
            addConstraintObserved: observedHotParentWait !== null,
            waitingOnChildRelation: observedHotParentWait?.waitEvent === 'relation',
            pendingAfterWriterCommit: hotParentPendingAfterWriterCommit,
          },
          writer: {
            organizationUpdateCount,
            staffUpdateCount,
            venueUpdateCount,
            productUpdateCount: hotParentProductUpdateCount,
            lockTimeoutMs: 750,
          },
        },
      })}\n`,
    )
  } finally {
    if (snapshotOpen && snapshotClient) {
      await snapshotClient.query('ROLLBACK').catch(() => undefined)
    }
    if (blockerOpen && snapshotClient) {
      await snapshotClient.query('ROLLBACK').catch(() => undefined)
    }
    // If setup failed while CIC was waiting, releasing the owned snapshot lets
    // the owned migration process exit naturally; no process or DB session is killed.
    if (cicDeployment && cicDeployment.child.exitCode === null) {
      await cicDeployment.completion.catch(() => undefined)
    }
    if (productCicDeployment && productCicDeployment.child.exitCode === null) {
      await productCicDeployment.completion.catch(() => undefined)
    }
    if (hotParentDeployment && hotParentDeployment.child.exitCode === null) {
      await hotParentDeployment.completion.catch(() => undefined)
    }
    await Promise.all([
      snapshotClient?.end().catch(() => undefined),
      observerClient?.end().catch(() => undefined),
      writerClient?.end().catch(() => undefined),
    ])
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } finally {
      if (harnessLock) await releaseHarnessLock(harnessLock)
    }
  }
}

async function main() {
  const url = assertedTestUrl()
  const legacyMigrations = validateSourceChain()
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avoqado-h1a-replay-'))
  const tempPrisma = path.join(tempRoot, 'prisma')
  const tempMigrations = path.join(tempPrisma, 'migrations')
  const tempConfig = path.join(tempRoot, 'prisma.config.ts')
  fs.mkdirSync(tempMigrations, { recursive: true })
  fs.copyFileSync(path.join(repoRoot, 'prisma/schema.prisma'), path.join(tempPrisma, 'schema.prisma'))
  fs.copyFileSync(path.join(migrationsRoot, 'migration_lock.toml'), path.join(tempMigrations, 'migration_lock.toml'))
  // The staging config deliberately imports no dotenv module; the hardened
  // wrapper's already-scrubbed DATABASE_URL is the only datasource authority.
  fs.writeFileSync(
    tempConfig,
    `export default ${JSON.stringify(
      {
        schema: path.join(tempPrisma, 'schema.prisma'),
        migrations: { path: tempMigrations },
      },
      null,
      2,
    )}\n`,
  )

  let harnessLock
  try {
    harnessLock = await acquireHarnessLock(url)
    await resetDatabase(url, harnessLock)
    for (const name of legacyMigrations) copyMigration(tempMigrations, name)

    const prismaBin = path.join(repoRoot, 'node_modules/.bin/prisma')
    const version = run(prismaBin, ['-v'], { cwd: tempRoot }).stdout.trim()
    const legacyStarted = performance.now()
    run(prismaBin, ['migrate', 'deploy', '--config', tempConfig], { cwd: tempRoot })
    const legacyDeployMs = Math.round(performance.now() - legacyStarted)

    run('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-f', fixturePath])
    const beforeClient = new Client({ connectionString: url.toString() })
    await beforeClient.connect()
    const before = await snapshot(beforeClient)
    await beforeClient.end()

    for (const name of h1aChain) copyMigration(tempMigrations, name)
    const h1aStarted = performance.now()
    run(prismaBin, ['migrate', 'deploy', '--config', tempConfig], { cwd: tempRoot })
    const h1aDeployMs = Math.round(performance.now() - h1aStarted)

    const afterClient = new Client({ connectionString: url.toString() })
    await afterClient.connect()
    const after = await snapshot(afterClient)
    const versions = await afterClient.query(`SELECT current_setting('server_version') AS postgres_version`)
    const defaults = await afterClient.query(
      h1aEmptyTables.map(table => `SELECT '${table}' AS entity, COUNT(*)::int AS count FROM "${table}"`).join('\nUNION ALL\n'),
    )
    const legacyDefaults = await afterClient.query(`
      SELECT
        (SELECT COUNT(*)::int FROM "Product" WHERE "createdById" IS NOT NULL) AS products_with_creator,
        (SELECT COUNT(*)::int FROM "Venue" WHERE "catalogGovernanceEnforcedAt" IS NOT NULL) AS governed_venues,
        (SELECT COUNT(*)::int FROM "ActivityLog" WHERE "actorType" IS NOT NULL OR "organizationId" IS NOT NULL OR "actorStaffId" IS NOT NULL OR "servicePrincipalId" IS NOT NULL) AS classified_logs,
        (SELECT COUNT(*)::int FROM "Module" WHERE "scope" <> 'BOTH') AS non_default_modules
    `)
    const indexes = await afterClient.query(
      `
      SELECT index_rel.relname AS name, pg_index.indisvalid AS valid, pg_index.indisready AS ready
        FROM pg_index
        JOIN pg_class index_rel ON index_rel.oid = pg_index.indexrelid
       WHERE index_rel.relname = ANY($1::text[])
       ORDER BY index_rel.relname
    `,
      [
        [
          'ActivityLog_organizationId_idx',
          'ActivityLog_actorType_idx',
          'ActivityLog_servicePrincipalId_idx',
          'ActivityLog_actorStaffId_idx',
          'Product_createdById_idx',
          'Product_id_venueId_key',
          'Venue_id_organizationId_key',
        ],
      ],
    )
    const appliedH1 = await afterClient.query(
      `
      SELECT migration_name FROM "_prisma_migrations"
       WHERE migration_name = ANY($1::text[])
         AND finished_at IS NOT NULL
         AND rolled_back_at IS NULL
       ORDER BY migration_name
    `,
      [h1aChain],
    )
    const migrationCounts = await afterClient.query(
      `
      SELECT
        (COUNT(*) FILTER (WHERE migration_name <> ALL($1::text[])))::int AS legacy,
        (COUNT(*) FILTER (WHERE migration_name = ANY($1::text[])))::int AS h1a,
        COUNT(*)::int AS total
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `,
      [h1aChain],
    )
    await afterClient.end()

    process.stdout.write(
      `${JSON.stringify({
        database: { host: url.hostname, pathname: url.pathname },
        cutoff,
        before,
        after,
        defaultOffCounts: Object.fromEntries(defaults.rows.map(row => [row.entity, row.count])),
        legacyDefaults: legacyDefaults.rows[0],
        indexes: indexes.rows,
        appliedH1: appliedH1.rows.map(row => row.migration_name),
        migrationCounts: migrationCounts.rows[0],
        versions: { postgres: versions.rows[0].postgres_version, prisma: version },
        timingsMs: { legacyDeploy: legacyDeployMs, h1aDeploy: h1aDeployMs },
      })}\n`,
    )
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } finally {
      if (harnessLock) await releaseHarnessLock(harnessLock)
    }
  }
}

const selectedMain = process.argv[2] === '--lock-safety' ? lockSafetyMain : main
selectedMain().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exit(1)
})
