import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { Client } from 'pg'

type CicWriterAcceptance = {
  mode: 'lock-safety'
  database: { host: string; pathname: string }
  snapshot: {
    heldOpenDuringWriter: boolean
    updatedProductVisible: boolean
    insertedActivityVisible: boolean
  }
  deployment: {
    concurrentIndexObserved: boolean
    waitingOnOldSnapshot: boolean
    pendingAfterWriterCommit: boolean
  }
  writer: {
    productUpdateCount: number
    activityInsertCount: number
    lockTimeoutMs: number
  }
  indexes: Array<{ name: string; valid: boolean; ready: boolean }>
  productCicPhase: {
    snapshot: {
      heldOpenDuringWriter: boolean
      updatedProductVisible: boolean
      insertedActivityVisible: boolean
    }
    deployment: {
      concurrentIndexObserved: boolean
      waitingOnOldSnapshot: boolean
      pendingAfterWriterCommit: boolean
    }
    writer: {
      productUpdateCount: number
      activityInsertCount: number
      lockTimeoutMs: number
    }
  }
  hotParentFkPhase: {
    blockerTable: string
    deployment: {
      addConstraintObserved: boolean
      waitingOnChildRelation: boolean
      pendingAfterWriterCommit: boolean
    }
    writer: {
      organizationUpdateCount: number
      staffUpdateCount: number
      venueUpdateCount: number
      productUpdateCount: number
      lockTimeoutMs: number
    }
  }
}

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
] as const

const concurrentLegacyIndexes = [
  'ActivityLog_actorStaffId_idx',
  'ActivityLog_actorType_idx',
  'ActivityLog_organizationId_idx',
  'ActivityLog_servicePrincipalId_idx',
  'Product_createdById_idx',
  'Product_id_venueId_key',
  'Venue_id_organizationId_key',
] as const

describe('H1A deployed lock-safe migration chain', () => {
  let client: Client
  let cicWriterAcceptance: CicWriterAcceptance

  beforeAll(async () => {
    // The helper owns the destructive reset before this Jest process opens a
    // database connection, then leaves a fully deployed H1A database behind.
    const harness = spawnSync(process.execPath, [path.resolve(__dirname, 'h1a-migration-harness.cjs'), '--lock-safety'], {
      cwd: path.resolve(__dirname, '../../..'),
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 180_000,
    })
    if (harness.status !== 0) {
      throw new Error(`H1A lock-safety harness failed\n${harness.stdout}\n${harness.stderr}`)
    }
    const outputLines = harness.stdout.trim().split('\n')
    cicWriterAcceptance = JSON.parse(outputLines[outputLines.length - 1]) as CicWriterAcceptance

    client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
  }, 190_000)

  afterAll(async () => {
    await client?.end()
  })

  it('keeps legacy Product/ActivityLog writes live while CIC waits on an old snapshot', () => {
    expect(cicWriterAcceptance).toMatchObject({
      mode: 'lock-safety',
      database: { pathname: '/avoqado_h1a_test_20260808' },
      snapshot: {
        heldOpenDuringWriter: true,
        updatedProductVisible: false,
        insertedActivityVisible: false,
      },
      deployment: {
        concurrentIndexObserved: true,
        waitingOnOldSnapshot: true,
        pendingAfterWriterCommit: true,
      },
      writer: {
        productUpdateCount: 1,
        activityInsertCount: 1,
        lockTimeoutMs: 750,
      },
    })
    expect(cicWriterAcceptance.indexes).toEqual(concurrentLegacyIndexes.map(name => ({ name, valid: true, ready: true })))
  })

  it('keeps hot-parent writers live while an atomic NOT VALID FK migration waits on its child', () => {
    expect(cicWriterAcceptance.hotParentFkPhase).toEqual({
      blockerTable: 'OrganizationEntitlement',
      deployment: {
        addConstraintObserved: true,
        waitingOnChildRelation: true,
        pendingAfterWriterCommit: true,
      },
      writer: {
        organizationUpdateCount: 1,
        staffUpdateCount: 1,
        venueUpdateCount: 1,
        productUpdateCount: 1,
        lockTimeoutMs: 750,
      },
    })
  })

  it('keeps Product and ActivityLog writes live during the Product-specific CIC phase', () => {
    expect(cicWriterAcceptance.productCicPhase).toEqual({
      snapshot: {
        heldOpenDuringWriter: true,
        updatedProductVisible: false,
        insertedActivityVisible: false,
      },
      deployment: {
        concurrentIndexObserved: true,
        waitingOnOldSnapshot: true,
        pendingAfterWriterCommit: true,
      },
      writer: {
        productUpdateCount: 1,
        activityInsertCount: 1,
        lockTimeoutMs: 750,
      },
    })
  })

  it('fails a second harness while the maintenance session lock is held and leaves the deployment untouched', async () => {
    const before = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    )
    const maintenanceUrl = new URL(process.env.TEST_DATABASE_URL!)
    maintenanceUrl.pathname = '/postgres'
    const lockHolder = new Client({ connectionString: maintenanceUrl.toString() })
    await lockHolder.connect()
    try {
      const lock = await lockHolder.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(20260808, 120000) AS locked`)
      expect(lock.rows).toEqual([{ locked: true }])

      const secondHarness = spawnSync(process.execPath, [path.resolve(__dirname, 'h1a-migration-harness.cjs'), '--lock-safety'], {
        cwd: path.resolve(__dirname, '../../..'),
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      })
      expect(secondHarness.status).not.toBe(0)
      expect(`${secondHarness.stdout}\n${secondHarness.stderr}`).toContain('another H1 replay owns the advisory lock')
    } finally {
      await lockHolder.query(`SELECT pg_advisory_unlock(20260808, 120000)`).catch(() => undefined)
      await lockHolder.end()
    }

    const after = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    )
    expect(after.rows).toEqual(before.rows)
  })

  it('runs only on the asserted disposable database and records the exact chain once', async () => {
    const target = await client.query<{ database: string }>(`SELECT current_database() AS database`)
    expect(target.rows).toEqual([{ database: 'avoqado_h1a_test_20260808' }])

    const applied = await client.query<{ migration_name: string; count: number }>(
      `SELECT migration_name, COUNT(*)::int AS count
         FROM "_prisma_migrations"
        WHERE migration_name = ANY($1::text[])
          AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL
        GROUP BY migration_name
        ORDER BY migration_name`,
      [h1aChain],
    )
    expect(applied.rows).toEqual(h1aChain.map(migration_name => ({ migration_name, count: 1 })))
  })

  it('builds the exact partial/concurrent legacy indexes without full substitutes', async () => {
    const result = await client.query<{
      name: string
      definition: string
      predicate: string | null
      valid: boolean
      ready: boolean
    }>(
      `
      SELECT index_rel.relname AS name,
             pg_get_indexdef(pg_index.indexrelid) AS definition,
             pg_get_expr(pg_index.indpred, pg_index.indrelid) AS predicate,
             pg_index.indisvalid AS valid,
             pg_index.indisready AS ready
        FROM pg_index
        JOIN pg_class index_rel ON index_rel.oid = pg_index.indexrelid
       WHERE index_rel.relname = ANY($1::text[])
       ORDER BY index_rel.relname
    `,
      [
        [
          'ActivityLog_actorType_idx',
          'ActivityLog_organizationId_idx',
          'ActivityLog_servicePrincipalId_idx',
          'ActivityLog_actorStaffId_idx',
          'Product_createdById_idx',
          'Product_id_venueId_key',
          'Venue_id_organizationId_key',
        ],
      ],
    )

    expect(result.rows).toEqual([
      expect.objectContaining({
        name: 'ActivityLog_actorStaffId_idx',
        predicate: '("actorStaffId" IS NOT NULL)',
        valid: true,
        ready: true,
      }),
      expect.objectContaining({ name: 'ActivityLog_actorType_idx', predicate: '("actorType" IS NOT NULL)', valid: true, ready: true }),
      expect.objectContaining({
        name: 'ActivityLog_organizationId_idx',
        predicate: '("organizationId" IS NOT NULL)',
        valid: true,
        ready: true,
      }),
      expect.objectContaining({
        name: 'ActivityLog_servicePrincipalId_idx',
        predicate: '("servicePrincipalId" IS NOT NULL)',
        valid: true,
        ready: true,
      }),
      expect.objectContaining({ name: 'Product_createdById_idx', predicate: '("createdById" IS NOT NULL)', valid: true, ready: true }),
      expect.objectContaining({ name: 'Product_id_venueId_key', predicate: null, valid: true, ready: true }),
      expect.objectContaining({ name: 'Venue_id_organizationId_key', predicate: null, valid: true, ready: true }),
    ])
    expect(result.rows.find(row => row.name === 'Product_id_venueId_key')?.definition).toContain('CREATE UNIQUE INDEX')
    expect(result.rows.find(row => row.name === 'Venue_id_organizationId_key')?.definition).toContain('CREATE UNIQUE INDEX')
  })

  it('keeps the exact raw partial-index allowlist without full-column substitutes', async () => {
    const result = await client.query<{
      tableName: string
      name: string
      columns: string[]
      unique: boolean
      predicate: string | null
      definition: string
      valid: boolean
      ready: boolean
    }>(
      `
      SELECT table_rel.relname AS "tableName",
             index_rel.relname AS name,
             ARRAY(
               SELECT pg_get_indexdef(pg_index.indexrelid, key_position, true)
                 FROM generate_series(1, pg_index.indnkeyatts) AS key_position
                ORDER BY key_position
             ) AS columns,
             pg_index.indisunique AS unique,
             pg_get_expr(pg_index.indpred, pg_index.indrelid) AS predicate,
             pg_get_indexdef(pg_index.indexrelid) AS definition,
             pg_index.indisvalid AS valid,
             pg_index.indisready AS ready
        FROM pg_index
        JOIN pg_class index_rel ON index_rel.oid = pg_index.indexrelid
        JOIN pg_class table_rel ON table_rel.oid = pg_index.indrelid
       WHERE table_rel.relname = ANY($1::text[])
       ORDER BY table_rel.relname, index_rel.relname
    `,
      [['CatalogProductTypeMapping', 'CatalogIdentifier', 'CatalogValidationProfile', 'CatalogVenueOverride', 'CatalogPublicationLine']],
    )

    const allowlist = [
      {
        tableName: 'CatalogProductTypeMapping',
        name: 'CatalogProductTypeMapping_one_active_alias_key',
        columns: ['"organizationId"', '"catalogProductType"'],
        predicate: 'active',
      },
      {
        tableName: 'CatalogIdentifier',
        name: 'CatalogIdentifier_one_corporate_sku_per_item_key',
        columns: ['"catalogItemId"'],
        predicate: '(type = \'CORPORATE_SKU\'::"CatalogIdentifierType")',
      },
      {
        tableName: 'CatalogValidationProfile',
        name: 'CatalogValidationProfile_one_active_scope_key',
        columns: [
          '"organizationId"',
          'name',
          '("businessType" IS NULL)',
          'COALESCE("businessType", \'RESTAURANT\'::"BusinessType")',
          '("operationalRole" IS NULL)',
          'COALESCE("operationalRole", \'STORE\'::"VenueOperationalRole")',
        ],
        predicate: 'active',
      },
      {
        tableName: 'CatalogVenueOverride',
        name: 'CatalogVenueOverride_one_requested_field_key',
        columns: ['"organizationId"', '"bindingId"', 'field'],
        predicate: '(status = \'REQUESTED\'::"CatalogVenueOverrideStatus")',
      },
      {
        tableName: 'CatalogVenueOverride',
        name: 'CatalogVenueOverride_one_approved_field_key',
        columns: ['"organizationId"', '"bindingId"', 'field'],
        predicate: '(status = \'APPROVED\'::"CatalogVenueOverrideStatus")',
      },
      {
        tableName: 'CatalogPublicationLine',
        name: 'CatalogPublicationLine_one_applied_successor_key',
        columns: ['"organizationId"', '"supersedesLineId"'],
        predicate: `((status = 'APPLIED'::"CatalogPublicationLineStatus") AND ("supersedesLineId" IS NOT NULL))`,
      },
      {
        tableName: 'CatalogPublicationLine',
        name: 'CatalogPublicationLine_one_applied_reversal_key',
        columns: ['"organizationId"', '"reversesLineId"'],
        predicate: `((status = 'APPLIED'::"CatalogPublicationLineStatus") AND ("reversesLineId" IS NOT NULL))`,
      },
    ]

    const rawRows = result.rows
      .filter(row => allowlist.some(expected => expected.name === row.name))
      .map(({ tableName, name, columns, unique, predicate, valid, ready }) => ({
        tableName,
        name,
        columns,
        unique,
        predicate,
        valid,
        ready,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    expect(rawRows).toEqual(
      allowlist
        .map(expected => ({ ...expected, unique: true, valid: true, ready: true }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    )

    // A full index over the exact same key would be the drift-prone Prisma
    // substitute forbidden by H1A, whether Prisma emitted it unique or plain.
    const fullSubstitutes = result.rows.filter(
      row =>
        row.predicate === null &&
        allowlist.some(
          expected => expected.tableName === row.tableName && JSON.stringify(expected.columns) === JSON.stringify(row.columns),
        ),
    )
    expect(fullSubstitutes).toEqual([])
  })

  it('finishes validation separately for every legacy FK/CHECK installed NOT VALID', async () => {
    const result = await client.query<{ conname: string; convalidated: boolean }>(`
      SELECT conname, convalidated
        FROM pg_constraint
       WHERE conname IN (
         'Product_createdById_fkey',
         'ActivityLog_actorStaffId_fkey',
         'ActivityLog_organizationId_fkey',
         'ActivityLog_actor_identity_check'
       )
       ORDER BY conname
    `)

    expect(result.rows).toEqual([
      { conname: 'ActivityLog_actorStaffId_fkey', convalidated: true },
      { conname: 'ActivityLog_actor_identity_check', convalidated: true },
      { conname: 'ActivityLog_organizationId_fkey', convalidated: true },
      { conname: 'Product_createdById_fkey', convalidated: true },
    ])
  })
})
