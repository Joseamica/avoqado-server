import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const migrationsRoot = path.resolve(__dirname, '../../../prisma/migrations')
const prismaSchemaPath = path.resolve(__dirname, '../../../prisma/schema.prisma')
// WHY `scripts/` and not `.superpowers/`: this is a tracked test asserting a
// production-safety guard (the wrapper refuses a remote DATABASE_URL and blanks
// every Render alias). `.superpowers/` is gitignored, so the wrapper existed on
// the authoring machine and nowhere else — the test passed locally and failed on
// every CI run. A tracked test may only depend on tracked files.
const h1TestWrapper = path.resolve(__dirname, '../../../scripts/run-with-h1-test-db.cjs')
const migrationHarness = path.resolve(__dirname, '../../integration/master-catalog/h1a-migration-harness.cjs')

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

const concurrentMigrations = h1aChain.filter(name => name.includes('_concurrently'))
const hotParentFkMigrations = h1aChain.slice(13, 39)
const hotParentFkValidation = '20260808121150_validate_h1a_hot_parent_fks'
const shortLegacyAlterMigrations = [
  '20260808120100_add_h1a_activity_log_columns',
  '20260808120200_add_h1a_module_scope',
  '20260808120300_add_h1a_product_creator',
  '20260808120400_add_h1a_venue_governance_fence',
] as const
const boundedLegacyConstraintMigrations = [
  '20260808121200_add_product_creator_fk_not_valid',
  '20260808121300_add_activity_log_constraints_not_valid',
  '20260808121400_add_activity_log_tenant_guard',
  '20260808121500_add_venue_governance_write_once_trigger',
] as const

function readMigration(name: string): string {
  return fs.readFileSync(path.join(migrationsRoot, name, 'migration.sql'), 'utf8')
}

function sourceLineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

// Comments may explain recovery, but they are not executable statements and
// must not make a safe one-statement concurrent migration look unsafe.
function executableStatements(sql: string): string[] {
  const withoutComments = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '')

  return withoutComments
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean)
}

describe('H1A migration lock-safety architecture', () => {
  it('holds one maintenance advisory lock across each complete destructive harness run', () => {
    const source = fs.readFileSync(migrationHarness, 'utf8')
    const resetBody = source.match(/async function resetDatabase[\s\S]*?\n}\n/)?.[0]

    expect(source).toMatch(/async function acquireHarnessLock\(/)
    expect(source.match(/await acquireHarnessLock\(url\)/g)).toHaveLength(2)
    expect(source.match(/await releaseHarnessLock\(harnessLock\)/g)).toHaveLength(2)
    expect(resetBody).not.toMatch(/pg_try_advisory_lock|pg_advisory_unlock/)
  })

  it('waits a bounded interval for prior test sessions to leave without terminating them', () => {
    const source = fs.readFileSync(migrationHarness, 'utf8')
    const resetBody = source.match(/async function resetDatabase[\s\S]*?\n}\n/)?.[0]

    expect(source).toMatch(/async function waitForDatabaseQuiescence\(/)
    expect(source).toMatch(/DATABASE_QUIESCENCE_TIMEOUT_MS\s*=\s*5_000/)
    expect(source).toMatch(/DATABASE_QUIESCENCE_POLL_MS\s*=\s*50/)
    expect(resetBody).toMatch(/await waitForDatabaseQuiescence\(databaseName, harnessLock\)/)
    expect(source).not.toMatch(/pg_terminate_backend/)
  })
  it('scrubs Render selectors before spawning any disposable-database command', () => {
    const probe = spawnSync(
      process.execPath,
      [
        h1TestWrapper,
        process.execPath,
        '-e',
        `const u = new URL(process.env.DATABASE_URL); console.log(JSON.stringify({
          host: u.hostname,
          pathname: u.pathname,
          useRenderDb: process.env.USE_RENDER_DB,
          renderDatabaseUrl: process.env.RENDER_DATABASE_URL
        }))`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://local:local@127.0.0.1:5432/shared_dev',
          USE_RENDER_DB: 'true',
          RENDER_DATABASE_URL: 'postgresql://remote:secret@render.example/db',
        },
      },
    )

    expect(probe.status).toBe(0)
    expect(JSON.parse(probe.stdout.trim())).toEqual({
      host: '127.0.0.1',
      pathname: '/avoqado_h1a_test_20260808',
      useRenderDb: 'false',
      renderDatabaseUrl: '',
    })
  })

  it('replaces the rejected monolith with the complete ordered migration chain', () => {
    const migrationNames = new Set(fs.readdirSync(migrationsRoot))

    expect(migrationNames.has('20260808120000_add_master_catalog_core')).toBe(false)
    expect(h1aChain).toHaveLength(48)
    expect([...migrationNames].filter(name => name.startsWith('2026080812')).sort()).toEqual([...h1aChain].sort())
  })

  it.each(concurrentMigrations)('%s contains exactly one bare concurrent index statement', name => {
    const sql = readMigration(name)
    const statements = executableStatements(sql)

    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE (?:UNIQUE )?INDEX CONCURRENTLY\b/i)
    expect(statements[0]).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i)
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|SET\s+(?:LOCAL\s+)?lock_timeout|DO\s+\$)\b/i)
  })

  it.each(shortLegacyAlterMigrations)('%s bounds only its legacy ALTER lock', name => {
    const statements = executableStatements(readMigration(name))

    expect(statements[0]).toBe('BEGIN')
    expect(statements[1]).toMatch(/^SET LOCAL lock_timeout\s*=\s*'5s'$/i)
    expect(statements.at(-1)).toBe('COMMIT')
    expect(statements.filter(statement => /^ALTER TABLE\b/i.test(statement))).toHaveLength(1)
    expect(statements).toHaveLength(4)
  })

  it.each(hotParentFkMigrations)('%s installs one child table hot-parent FK set in a bounded NOT VALID phase', name => {
    const statements = executableStatements(readMigration(name))

    expect(statements[0]).toBe('BEGIN')
    expect(statements[1]).toMatch(/^SET LOCAL lock_timeout\s*=\s*'5s'$/i)
    expect(statements[2]).toMatch(/^ALTER TABLE\b/i)
    expect(statements[2]).toMatch(/REFERENCES "(?:Organization|Staff|Venue|Product)"/)
    expect(statements[2]).not.toMatch(/VALIDATE CONSTRAINT/i)
    expect(statements[2].match(/FOREIGN KEY/gi)?.length).toBeGreaterThan(0)
    expect(statements[2].match(/NOT VALID/gi)).toHaveLength(statements[2].match(/FOREIGN KEY/gi)?.length ?? 0)
    expect(statements[3]).toBe('COMMIT')
    expect(statements).toHaveLength(4)
  })

  it('keeps hot-parent references out of core and validates all 68 phased constraints later', () => {
    expect(readMigration('20260808121100_add_h1a_master_catalog_core')).not.toMatch(/REFERENCES "(?:Organization|Staff|Venue|Product)"/)

    const installedConstraintNames = hotParentFkMigrations.flatMap(name =>
      [...readMigration(name).matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map(match => match[1]),
    )
    const validationStatements = executableStatements(readMigration(hotParentFkValidation))
    const validatedConstraintNames = validationStatements.flatMap(statement =>
      [...statement.matchAll(/VALIDATE CONSTRAINT "([^"]+)"/g)].map(match => match[1]),
    )

    expect(validationStatements[0]).toBe('BEGIN')
    expect(validationStatements[1]).toMatch(/^SET LOCAL lock_timeout\s*=\s*'5s'$/i)
    expect(validationStatements[2]).toMatch(/^SET LOCAL statement_timeout\s*=\s*'10min'$/i)
    expect(validationStatements.at(-1)).toBe('COMMIT')
    expect(installedConstraintNames).toHaveLength(68)
    expect(validatedConstraintNames).toHaveLength(68)
    expect(validatedConstraintNames.sort()).toEqual(installedConstraintNames.sort())
  })

  it('deduplicates publication lineage reachability instead of enumerating convergent paths', () => {
    const core = readMigration('20260808121100_add_h1a_master_catalog_core')
    const functionBody = core.match(/CREATE FUNCTION "assert_catalog_publication_line_decisions"[\s\S]*?\n\$\$;/)?.[0]
    const reachability = functionBody?.match(
      /WITH RECURSIVE reachable_line\(line_id\) AS \([\s\S]*?SELECT 1 FROM reachable_line WHERE line_id = publication_line_id/,
    )?.[0]

    expect(reachability).toBeDefined()
    expect(reachability).toMatch(/\n\s+UNION\s*\n/)
    expect(reachability).not.toMatch(/UNION ALL|\bpath\b/i)
  })

  it('keeps every H1A SQL identifier and Prisma mapped name within PostgreSQL 63-byte limits', () => {
    const names: Array<{ path: string; line: number; name: string; bytes: number }> = []

    // PostgreSQL truncates identifiers by bytes, not JavaScript characters.
    // Scanning source locations prevents two long names from silently becoming
    // the same catalog object even when the deployed trigger set still exists.
    for (const migration of h1aChain) {
      const filePath = path.join(migrationsRoot, migration, 'migration.sql')
      const sql = fs.readFileSync(filePath, 'utf8')
      for (const match of sql.matchAll(/"((?:[^"]|"")+)"/g)) {
        const name = match[1].replace(/""/g, '"')
        names.push({
          path: path.relative(process.cwd(), filePath),
          line: sourceLineAt(sql, match.index ?? 0),
          name,
          bytes: Buffer.byteLength(name, 'utf8'),
        })
      }
    }

    const schema = fs.readFileSync(prismaSchemaPath, 'utf8')
    for (const match of schema.matchAll(/\bmap\s*:\s*"([^"]+)"/g)) {
      const name = match[1]
      names.push({
        path: path.relative(process.cwd(), prismaSchemaPath),
        line: sourceLineAt(schema, match.index ?? 0),
        name,
        bytes: Buffer.byteLength(name, 'utf8'),
      })
    }
    for (const match of schema.matchAll(/@@?map\(\s*"([^"]+)"\s*\)/g)) {
      const name = match[1]
      names.push({
        path: path.relative(process.cwd(), prismaSchemaPath),
        line: sourceLineAt(schema, match.index ?? 0),
        name,
        bytes: Buffer.byteLength(name, 'utf8'),
      })
    }

    expect(names.length).toBeGreaterThan(0)
    expect(names.filter(identifier => identifier.bytes > 63)).toEqual([])
  })

  it.each(boundedLegacyConstraintMigrations)('%s bounds hot legacy FK/check/trigger installation with a five-second lock timeout', name => {
    const sql = readMigration(name)
    const withoutLeadingComments = sql.replace(/^(?:\s*--.*(?:\r?\n|$))+/, '')

    expect(withoutLeadingComments).toMatch(/^\s*BEGIN;\s*SET LOCAL lock_timeout\s*=\s*'5s';/i)
    expect(sql).toMatch(/COMMIT;\s*$/i)
  })

  it('installs legacy foreign keys and actor checks NOT VALID before isolated validation', () => {
    expect(readMigration('20260808121200_add_product_creator_fk_not_valid')).toMatch(
      /FOREIGN KEY[\s\S]*ON DELETE SET NULL[\s\S]*NOT VALID/i,
    )

    const activityConstraints = readMigration('20260808121300_add_activity_log_constraints_not_valid')
    expect(activityConstraints.match(/FOREIGN KEY[\s\S]*?NOT VALID/gi)).toHaveLength(2)
    const organizationFk = activityConstraints.match(/ADD CONSTRAINT "ActivityLog_organizationId_fkey"[\s\S]*?(?=,\s*ADD CONSTRAINT)/i)?.[0]
    const actorStaffFk = activityConstraints.match(/ADD CONSTRAINT "ActivityLog_actorStaffId_fkey"[\s\S]*?(?=,\s*ADD CONSTRAINT)/i)?.[0]
    expect(organizationFk).toMatch(/ON DELETE RESTRICT[\s\S]*NOT VALID/i)
    expect(actorStaffFk).toMatch(/ON DELETE RESTRICT[\s\S]*NOT VALID/i)
    expect(activityConstraints).toMatch(/CHECK[\s\S]*NOT VALID/i)

    for (const name of [
      '20260808121600_validate_product_creator_fk',
      '20260808121700_validate_activity_log_organization_fk',
      '20260808121750_validate_activity_log_actor_staff_fk',
      '20260808121800_validate_activity_log_actor_check',
    ]) {
      const statements = executableStatements(readMigration(name))
      expect(statements).toHaveLength(1)
      expect(statements[0]).toMatch(/^ALTER TABLE[\s\S]*VALIDATE CONSTRAINT/i)
    }
  })
})
