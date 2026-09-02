import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'
import catalogV2FixtureJson from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'

const repoRoot = path.resolve(__dirname, '../../..')
const migrationChain = [
  {
    name: '20260822050000_add_commercial_catalog_phase1',
    sha256: 'e36bcaf99264e7c56d78b5f648ddf48c695e2f4ab924e8f5c87335dd142b4783',
  },
  {
    name: '20260822090000_add_commercial_campaigns_quotes_phase2',
    sha256: '1a8168b1ec612064d2d1010be8356ed06072955fc73eb037b49d8d2ad858ab52',
  },
  {
    name: '20260824150000_expand_commercial_contract_v2',
    sha256: '07bba581a1c546cf7c927de169d2c4aa34dbd59ad22d15bd0f7314428676224d',
  },
  {
    name: '20260826170000_add_commercial_campaign_stacking_groups_v2',
    sha256: '099bb23d818dee9643e9f80ec2ea36e06edf6fb985b89d15183154f9fd439ad7',
  },
] as const
const rollbackSqlSha = '70b8044020bfe25bace7a95fe7bf60f5e83f3c333f9d3be1899248493e041a69'
const quotePreviewBridgeMigration = {
  name: '20260828120000_add_commercial_quote_preview_bridge',
  sha256: 'ffa06f19d79f0197a4e208af9b0229b2ee3c232708683ee690795b2f0b213984',
} as const

interface LocalServer {
  host: string
  port: number
  user: string
  password: string
}

function localTestServer(raw: string | undefined): LocalServer {
  if (!raw) throw new Error('COMMERCIAL_P3_2C_TEST_DATABASE_URL_REQUIRED')
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) {
    throw new Error('COMMERCIAL_P3_2C_TEST_DATABASE_URL_REJECTED')
  }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('COMMERCIAL_P3_2C_NON_LOOPBACK_REJECTED')
  const database = decodeURIComponent(url.pathname.slice(1))
  if (!/(?:-|_)test$/u.test(database) && !/^avoqado_h1a_test_[0-9]{8}$/u.test(database)) {
    throw new Error('COMMERCIAL_P3_2C_TEMPLATE_DATABASE_REJECTED')
  }
  const port = url.port ? Number(url.port) : 5432
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !user || !password) {
    throw new Error('COMMERCIAL_P3_2C_TEST_DATABASE_URL_REJECTED')
  }
  return { host: url.hostname, port, user, password }
}

function quoteIdentifier(value: string): string {
  if (!/^avoqado_p3_2c_[0-9]+_[0-9]+_[a-f0-9]{8}$/u.test(value)) {
    throw new Error('COMMERCIAL_P3_2C_DATABASE_NAME_REJECTED')
  }
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

function migrationSource(name: string): string {
  return readFileSync(path.join(repoRoot, 'prisma/migrations', name, 'migration.sql'), 'utf8')
}

async function createPrerequisites(client: Client): Promise<void> {
  await client.query(`
    CREATE TYPE "ActivityActorType" AS ENUM ('HUMAN', 'SERVICE');
    CREATE TYPE "StaffRole" AS ENUM ('SUPERADMIN', 'OWNER', 'ADMIN', 'MANAGER', 'WAITER', 'CASHIER', 'KITCHEN', 'HOST', 'VIEWER');
    CREATE TABLE "Staff" ("id" TEXT PRIMARY KEY, "active" BOOLEAN NOT NULL DEFAULT true);
    CREATE TABLE "Organization" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "Venue" ("id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES "Organization"("id"));
    CREATE TABLE "PermissionSet" (
      "id" TEXT PRIMARY KEY,
      "venueId" TEXT NOT NULL REFERENCES "Venue"("id"),
      "permissions" TEXT[] NOT NULL
    );
    CREATE TABLE "StaffVenue" (
      "id" TEXT PRIMARY KEY,
      "staffId" TEXT NOT NULL REFERENCES "Staff"("id"),
      "posStaffId" TEXT,
      "venueId" TEXT NOT NULL REFERENCES "Venue"("id"),
      "pin" TEXT,
      "role" "StaffRole" NOT NULL,
      "permissions" JSONB,
      "permissionSetId" TEXT REFERENCES "PermissionSet"("id") ON DELETE SET NULL,
      "totalSales" NUMERIC(12,2) NOT NULL DEFAULT 0,
      "totalTips" NUMERIC(10,2) NOT NULL DEFAULT 0,
      "averageRating" NUMERIC(3,2) NOT NULL DEFAULT 0,
      "totalOrders" INTEGER NOT NULL DEFAULT 0,
      "active" BOOLEAN NOT NULL DEFAULT true,
      "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "endDate" TIMESTAMP(3),
      "deactivatedBySeatCap" BOOLEAN NOT NULL DEFAULT false,
      CONSTRAINT "StaffVenue_staffId_venueId_key" UNIQUE ("staffId", "venueId")
    );
    CREATE TABLE "VenueRolePermission" (
      "id" TEXT PRIMARY KEY,
      "venueId" TEXT NOT NULL REFERENCES "Venue"("id"),
      "role" "StaffRole" NOT NULL,
      "permissions" TEXT[] NOT NULL,
      "deniedPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      CONSTRAINT "VenueRolePermission_venueId_role_key" UNIQUE ("venueId", "role")
    );
    CREATE TABLE "ActivityLog" (
      "id" TEXT PRIMARY KEY,
      "staffId" TEXT,
      "actorStaffId" TEXT,
      "venueId" TEXT,
      "organizationId" TEXT,
      "actorType" "ActivityActorType",
      "servicePrincipalId" TEXT,
      "action" TEXT NOT NULL,
      "entity" TEXT,
      "entityId" TEXT,
      "data" JSONB,
      "ipAddress" TEXT,
      "userAgent" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO "Staff" ("id") VALUES ('staff-p3-2c');
    INSERT INTO "Organization" ("id") VALUES ('org-p3-2c');
    INSERT INTO "Venue" ("id", "organizationId") VALUES ('venue-p3-2c', 'org-p3-2c');
    INSERT INTO "StaffVenue" ("id", "staffId", "venueId", "role")
      VALUES ('staff-venue-p3-2c', 'staff-p3-2c', 'venue-p3-2c', 'OWNER');
  `)
}

/**
 * This suite freezes the exact C2 migration bytes while exercising the current
 * Prisma client against that historical schema. Prisma returns every model
 * scalar by default, including nullable columns introduced after C2. Add only
 * those read-shape columns here; this is a disposable-test adapter, not an
 * applied migration and not evidence that a C2 database can run current code.
 */
async function addCurrentPrismaReadShape(client: Client): Promise<void> {
  await client.query(`
    ALTER TABLE "CommercialCampaignDraft"
      ADD COLUMN "offerSchemaVersion" INTEGER NOT NULL DEFAULT 2;
    ALTER TABLE "CommercialCampaignClaim"
      ADD COLUMN "offerVersionId" TEXT,
      ADD COLUMN "offerSchemaVersion" INTEGER;
    ALTER TABLE "CommercialAcquisitionContext"
      ADD COLUMN "offerVersionId" TEXT,
      ADD COLUMN "offerSchemaVersion" INTEGER,
      ADD COLUMN "reservedCatalogPublicationId" TEXT,
      ADD COLUMN "reservedCatalogSchemaVersion" INTEGER;
    ALTER TABLE "CommercialQuote"
      ADD COLUMN "offerVersionId" TEXT,
      ADD COLUMN "offerSchemaVersion" INTEGER;
  `)
}

async function seedLegacyDraft(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO "CommercialCampaignDraft" (
      "id", "code", "name", "description", "status", "revision", "startsAt", "endsAt",
      "allowedRuleCodeGroups", "createdById", "updatedById", "createdAt", "updatedAt"
    ) VALUES (
      'legacy-draft-p3-2c', 'LEGACY_POS', 'Campaña histórica', NULL, 'ACTIVE', 1,
      '2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '[ ["LEGACY_FIXED"] ]'::jsonb,
      'staff-p3-2c', 'staff-p3-2c', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO "CommercialCampaignRuleDraft" (
      "id", "campaignDraftId", "code", "type", "priority", "target", "amountMinor",
      "percentBasisPoints", "cycles", "createdAt", "updatedAt"
    ) VALUES (
      'legacy-rule-p3-2c', 'legacy-draft-p3-2c', 'LEGACY_FIXED', 'FIXED_PRICE', 100,
      '{"productCodes":["POS"]}'::jsonb, 5000, NULL, 3,
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
  `)
}

interface C2DatabaseContext {
  sql: Client
  prisma: Awaited<ReturnType<typeof importPrisma>>
  databaseName: string
  appliedCommercialMigrations: Array<{ ordinal: number; name: string; sha256: string }>
  preflight: { invalidLegacyGroups: number; invalidAmounts: number }
  legacyBytesBefore: string
}

async function importPrisma() {
  return (await import('@/utils/prismaClient')).default
}

async function withC2Database<T>(
  run: (context: C2DatabaseContext) => Promise<T>,
  options: { currentPrismaReadShape?: boolean } = { currentPrismaReadShape: true },
) {
  const server = localTestServer(process.env.TEST_DATABASE_URL)
  const databaseName = `avoqado_p3_2c_${process.pid}_${Date.now()}_${randomBytes(4).toString('hex')}`
  const admin = new Client({ ...server, database: 'postgres', ssl: false })
  let sql: Client | undefined
  let prisma: Awaited<ReturnType<typeof importPrisma>> | undefined
  let created = false
  let result: T | undefined
  let primaryError: unknown
  const originalDatabaseUrl = process.env.DATABASE_URL
  const originalConnectionLimit = process.env.DATABASE_CONNECTION_LIMIT

  await admin.connect()
  try {
    const adminIdentity = await admin.query(`SELECT current_database() AS database, host(inet_server_addr()) AS address`)
    if (adminIdentity.rows[0]?.database !== 'postgres' || !['127.0.0.1', '::1'].includes(adminIdentity.rows[0]?.address)) {
      throw new Error('COMMERCIAL_P3_2C_MAINTENANCE_IDENTITY_REJECTED')
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    created = true
    sql = new Client({ ...server, database: databaseName, ssl: false })
    await sql.connect()
    const targetIdentity = await sql.query(`SELECT current_database() AS database, host(inet_server_addr()) AS address`)
    if (targetIdentity.rows[0]?.database !== databaseName || !['127.0.0.1', '::1'].includes(targetIdentity.rows[0]?.address)) {
      throw new Error('COMMERCIAL_P3_2C_TARGET_IDENTITY_REJECTED')
    }

    await createPrerequisites(sql)
    const appliedCommercialMigrations: C2DatabaseContext['appliedCommercialMigrations'] = []
    for (const [index, expected] of migrationChain.entries()) {
      const source = migrationSource(expected.name)
      const sha256 = createHash('sha256').update(source).digest('hex')
      if (sha256 !== expected.sha256) throw new Error(`COMMERCIAL_P3_2C_MIGRATION_SHA_MISMATCH:${expected.name}`)
      if (index === 2) await seedLegacyDraft(sql)
      await sql.query(source)
      appliedCommercialMigrations.push({ ordinal: index + 1, name: expected.name, sha256 })
    }
    if (new Set(appliedCommercialMigrations.map(entry => entry.name)).size !== migrationChain.length) {
      throw new Error('COMMERCIAL_P3_2C_MIGRATION_CHAIN_INVALID')
    }
    const preflightResult = await sql.query<{ invalidLegacyGroups: number; invalidAmounts: number }>(`
      SELECT
        (SELECT count(*)::integer FROM "CommercialCampaignDraft"
          WHERE "stackingGroups" IS NULL
            AND jsonb_typeof("allowedRuleCodeGroups") IS DISTINCT FROM 'array') AS "invalidLegacyGroups",
        (SELECT count(*)::integer FROM "CommercialCampaignRuleDraft"
          WHERE "amountMinor" IS NOT NULL AND "amountMinor" NOT BETWEEN 0 AND 999999999999) AS "invalidAmounts"
    `)
    const legacyBytes = await sql.query<{ value: string }>(`
      SELECT "allowedRuleCodeGroups"::text AS value FROM "CommercialCampaignDraft" WHERE "id" = 'legacy-draft-p3-2c'
    `)

    if (options.currentPrismaReadShape !== false) await addCurrentPrismaReadShape(sql)

    await sql.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} SET timezone TO 'Pacific/Auckland'`)
    await sql.query(`SET TIME ZONE 'Pacific/Auckland'`)

    process.env.DATABASE_URL = databaseUrl(server, databaseName)
    process.env.DATABASE_CONNECTION_LIMIT = '2'
    jest.resetModules()
    prisma = await importPrisma()
    result = await run({
      sql,
      prisma,
      databaseName,
      appliedCommercialMigrations,
      preflight: preflightResult.rows[0],
      legacyBytesBefore: legacyBytes.rows[0].value,
    })
  } catch (error) {
    primaryError = error
  } finally {
    await prisma?.$disconnect()
    await sql?.end()
    process.env.DATABASE_URL = originalDatabaseUrl
    process.env.DATABASE_CONNECTION_LIMIT = originalConnectionLimit
    jest.resetModules()
    if (created) await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`)
  }

  const cleanup = await admin.query<{ dropped: boolean }>('SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS dropped', [
    databaseName,
  ])
  await admin.end()
  if (primaryError) throw primaryError
  return { result: result as T, cleanupConfirmed: cleanup.rows[0].dropped }
}

interface PreC2DatabaseContext {
  client: Client
  server: LocalServer
  databaseName: string
}

async function withPreC2Database<T>(run: (context: PreC2DatabaseContext) => Promise<T>) {
  const server = localTestServer(process.env.TEST_DATABASE_URL)
  const databaseName = `avoqado_p3_2c_${process.pid}_${Date.now()}_${randomBytes(4).toString('hex')}`
  const admin = new Client({ ...server, database: 'postgres', ssl: false })
  let client: Client | undefined
  let created = false
  let result: T | undefined
  let primaryError: unknown
  await admin.connect()
  try {
    const identity = await admin.query(`SELECT current_database() AS database, host(inet_server_addr()) AS address`)
    if (identity.rows[0]?.database !== 'postgres' || !['127.0.0.1', '::1'].includes(identity.rows[0]?.address)) {
      throw new Error('COMMERCIAL_P3_2C_MAINTENANCE_IDENTITY_REJECTED')
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    created = true
    client = new Client({ ...server, database: databaseName, ssl: false })
    await client.connect()
    await createPrerequisites(client)
    for (const [index, migration] of migrationChain.slice(0, 3).entries()) {
      const source = migrationSource(migration.name)
      const digest = createHash('sha256').update(source).digest('hex')
      if (digest !== migration.sha256) throw new Error(`COMMERCIAL_P3_2C_MIGRATION_SHA_MISMATCH:${migration.name}`)
      if (index === 2) await seedLegacyDraft(client)
      await client.query(source)
    }
    result = await run({ client, server, databaseName })
  } catch (error) {
    primaryError = error
  } finally {
    await client?.end()
    if (created) await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`)
  }
  const cleanup = await admin.query<{ dropped: boolean }>('SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS dropped', [
    databaseName,
  ])
  await admin.end()
  if (primaryError) throw primaryError
  return { result: result as T, cleanupConfirmed: cleanup.rows[0].dropped }
}

async function preC2Fingerprint(client: Client): Promise<string> {
  const result = await client.query<{ value: string }>(`
    SELECT jsonb_build_object(
      'columns', (SELECT jsonb_agg(row_to_json(columns_row) ORDER BY columns_row.table_name, columns_row.column_name)
        FROM (SELECT table_name, column_name, data_type, is_nullable, column_default
                FROM information_schema.columns WHERE table_schema = 'public') AS columns_row),
      'constraints', (SELECT jsonb_agg(row_to_json(constraint_row) ORDER BY constraint_row.name)
        FROM (SELECT conname AS name, pg_get_constraintdef(oid, true) AS definition
                FROM pg_constraint WHERE connamespace = 'public'::regnamespace) AS constraint_row),
      'legacyDraft', (SELECT row_to_json(draft_row) FROM (
        SELECT "id", "allowedRuleCodeGroups", "revision" FROM "CommercialCampaignDraft"
         WHERE "id" = 'legacy-draft-p3-2c') AS draft_row),
      'legacyRule', (SELECT row_to_json(rule_row) FROM (
        SELECT "id", "amountMinor" FROM "CommercialCampaignRuleDraft"
         WHERE "id" = 'legacy-rule-p3-2c') AS rule_row)
    )::text AS value
  `)
  return createHash('sha256').update(result.rows[0].value).digest('hex')
}

function rollbackArguments(databaseName: string): string[] {
  return [
    `--database-name=${databaseName}`,
    `--acknowledge-read-write-outage=I_ACKNOWLEDGE_READ_WRITE_OUTAGE:${databaseName}`,
    '--operator-id=p3-2c-disposable-test',
    `--expected-sql-sha=${rollbackSqlSha}`,
  ]
}

describe('P3-2C unique Campaign v2 emitter — disposable PostgreSQL', () => {
  jest.setTimeout(180_000)

  it('migrates legacy draft storage and publishes only branded schema v2', async () => {
    const completed = await withC2Database(
      async ({ sql, prisma, databaseName, appliedCommercialMigrations, preflight, legacyBytesBefore }) => {
        expect(databaseName).toMatch(/^avoqado_p3_2c_[0-9]+_[0-9]+_[a-f0-9]{8}$/u)
        expect(appliedCommercialMigrations).toEqual(
          migrationChain.map((entry, index) => ({ ordinal: index + 1, name: entry.name, sha256: entry.sha256 })),
        )
        expect(preflight).toEqual({ invalidLegacyGroups: 0, invalidAmounts: 0 })
        await expect(sql.query(`SELECT count(*)::integer AS count FROM "_prisma_migrations"`)).rejects.toMatchObject({ code: '42P01' })

        const [draftModule, publicationModule, claimModule] = await Promise.all([
          import('@/services/commercial/commercialCampaignDraft.service'),
          import('@/services/commercial/commercialCampaignPublication.service'),
          import('@/services/commercial/commercialCampaignClaim.service'),
        ])
        const actor = {
          staffId: 'staff-p3-2c',
          reason: 'Prueba C2 en PostgreSQL desechable',
          permissions: ['commercial:publish'],
        }
        const draftActor = { staffId: actor.staffId, reason: actor.reason }

        const legacyAfterMigration = await sql.query<{
          groups: string
          stackingIsSqlNull: boolean
          amountType: string
        }>(`
        SELECT draft."allowedRuleCodeGroups"::text AS groups,
               draft."stackingGroups" IS NULL AS "stackingIsSqlNull",
               pg_typeof(rule."amountMinor")::text AS "amountType"
          FROM "CommercialCampaignDraft" AS draft
          JOIN "CommercialCampaignRuleDraft" AS rule ON rule."campaignDraftId" = draft."id"
         WHERE draft."id" = 'legacy-draft-p3-2c'
      `)
        expect(legacyAfterMigration.rows).toEqual([{ groups: legacyBytesBefore, stackingIsSqlNull: true, amountType: 'bigint' }])
        await expect(draftModule.commercialCampaignDraftService.getDraft('legacy-draft-p3-2c')).rejects.toMatchObject({
          statusCode: 409,
          code: 'COMMERCIAL_CAMPAIGN_DRAFT_UPGRADE_REQUIRED',
          details: {
            upgradeSource: {
              sourceFormat: 'LEGACY_ALLOWED_RULE_CODE_GROUPS_V1',
              draftId: 'legacy-draft-p3-2c',
              revision: 1,
              legacyAllowedRuleCodeGroups: [['LEGACY_FIXED']],
              rules: [{ code: 'LEGACY_FIXED', type: 'FIXED_PRICE', amount: '50.00' }],
            },
          },
        })
        const upgradedLegacy = await draftModule.commercialCampaignDraftService.replaceDraft(
          'legacy-draft-p3-2c',
          {
            code: 'LEGACY_POS',
            name: 'Campaña histórica actualizada',
            description: null,
            startsAt: '2026-08-01T00:00:00.000Z',
            endsAt: '2026-10-01T00:00:00.000Z',
            stackingGroups: [],
            rules: [
              {
                code: 'LEGACY_FIXED',
                type: 'FIXED_PRICE',
                priority: 100,
                target: { productCodes: ['POS'] },
                amount: '50.00',
                cycles: 3,
              },
            ],
          },
          1,
          draftActor,
        )
        expect(upgradedLegacy).toMatchObject({ revision: 2, stackingGroups: [] })
        const upgradedStorage = await sql.query<{ legacyIsSqlNull: boolean; stacking: unknown }>(`
        SELECT "allowedRuleCodeGroups" IS NULL AS "legacyIsSqlNull", "stackingGroups" AS stacking
          FROM "CommercialCampaignDraft" WHERE "id" = 'legacy-draft-p3-2c'
      `)
        expect(upgradedStorage.rows).toEqual([{ legacyIsSqlNull: true, stacking: [] }])

        const now = new Date()
        const startsAt = new Date(now.getTime() - 60_000).toISOString()
        const endsAt = new Date(now.getTime() + 60 * 60_000).toISOString()
        const draft = await draftModule.commercialCampaignDraftService.createDraft(
          {
            code: 'POS_C2_TEST',
            name: 'Campaña C2 completa',
            startsAt,
            endsAt,
            stackingGroups: [
              {
                code: 'POS_STACK',
                steps: [
                  { position: 1, ruleCode: 'A_FIXED' },
                  { position: 2, ruleCode: 'B_PERCENT' },
                  { position: 3, ruleCode: 'C_AMOUNT' },
                ],
              },
            ],
            rules: [
              {
                code: 'E_BUNDLE',
                type: 'BUNDLE_PRICE',
                priority: 50,
                target: { bundleCodes: ['FULL_SUITE'] },
                amount: '1999.00',
                cycles: 3,
              },
              {
                code: 'D_FREE',
                type: 'FREE_PERIOD',
                priority: 60,
                target: { productCodes: ['POS'] },
                cycles: 2,
              },
              {
                code: 'C_AMOUNT',
                type: 'AMOUNT_OFF',
                priority: 70,
                target: { productCodes: ['POS'] },
                amount: '1.79',
                cycles: 3,
              },
              {
                code: 'B_PERCENT',
                type: 'PERCENT_OFF',
                priority: 80,
                target: { productCodes: ['POS'] },
                percentBasisPoints: 1000,
                cycles: 3,
              },
              {
                code: 'A_FIXED',
                type: 'FIXED_PRICE',
                priority: 90,
                target: { productCodes: ['POS'] },
                amount: '50.00',
                cycles: 3,
              },
            ],
          },
          draftActor,
        )
        expect(draft.revision).toBe(1)
        await expect(draftModule.commercialCampaignDraftService.getDraft(draft.id)).resolves.toEqual(draft)

        const publicationService = publicationModule.createCommercialCampaignPublicationService({
          ...publicationModule.prismaCommercialCampaignPublicationDependencies,
          now: () => new Date(now.getTime() + 1_000),
          randomId: (() => {
            const ids = ['campaign-v2-p3-2c', 'campaign-activation-p3-2c']
            return () => ids.shift() ?? 'unexpected-id'
          })(),
        })
        const publishInput = {
          draftId: draft.id,
          expectedDraftRevision: 1,
          expectedActivationRevision: null,
          reason: actor.reason,
          confirm: true as const,
        }
        const published = await publicationService.publishAndActivate(publishInput, actor)
        expect(published.version).toMatchObject({ id: 'campaign-v2-p3-2c', schemaVersion: 2 })
        expect(published.activation).toMatchObject({ campaignVersionId: 'campaign-v2-p3-2c', revision: 1 })

        const beforeReplay = {
          versions: await prisma.commercialCampaignVersion.count(),
          activation: await prisma.commercialCampaignActivation.findFirstOrThrow({ where: { campaignCode: draft.code } }),
          audits: await prisma.activityLog.count({
            where: { action: { in: ['COMMERCIAL_CAMPAIGN_PUBLISHED', 'COMMERCIAL_CAMPAIGN_ACTIVATED'] } },
          }),
        }
        const replay = await publicationService.publishAndActivate(publishInput, actor)
        expect(replay).toEqual(published)
        expect(await prisma.commercialCampaignVersion.count()).toBe(beforeReplay.versions)
        expect(await prisma.commercialCampaignActivation.findFirstOrThrow({ where: { campaignCode: draft.code } })).toEqual(
          beforeReplay.activation,
        )
        expect(
          await prisma.activityLog.count({
            where: { action: { in: ['COMMERCIAL_CAMPAIGN_PUBLISHED', 'COMMERCIAL_CAMPAIGN_ACTIVATED'] } },
          }),
        ).toBe(beforeReplay.audits)

        const coexistence = await prisma.commercialCampaignVersion.findMany({
          where: { sourceDraftId: draft.id, sourceRevision: draft.revision },
          orderBy: { schemaVersion: 'asc' },
        })
        expect(coexistence.map(row => row.schemaVersion)).toEqual([2])

        const v2Claim = await claimModule.commercialCampaignClaimService.issue(
          {
            campaignCode: draft.code,
            campaignVersionId: published.version.id,
            channel: 'PAID_META',
            sourceRef: 'meta-v2-p3-2c',
            expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
            confirm: true,
          },
          actor,
          now,
        )
        expect(v2Claim.claim).toMatch(/^[A-Za-z0-9_-]{43}$/)
        await expect(
          prisma.commercialCampaignClaim.count({
            where: { campaignVersionId: published.version.id, sourceRef: 'meta-v2-p3-2c' },
          }),
        ).resolves.toBe(1)
        await expect(
          prisma.activityLog.count({
            where: {
              action: 'COMMERCIAL_ACQUISITION_CLAIM_ISSUED',
              entity: 'CommercialCampaignClaim',
              entityId: (
                await prisma.commercialCampaignClaim.findFirstOrThrow({
                  where: { campaignVersionId: published.version.id, sourceRef: 'meta-v2-p3-2c' },
                  select: { id: true },
                })
              ).id,
            },
          }),
        ).resolves.toBe(1)
        await expect(prisma.commercialAcquisitionContext.count()).resolves.toBe(0)
        await expect(prisma.commercialQuote.count()).resolves.toBe(0)
        await expect(
          prisma.activityLog.groupBy({
            by: ['action'],
            where: { action: { in: ['COMMERCIAL_CAMPAIGN_PUBLISHED', 'COMMERCIAL_CAMPAIGN_ACTIVATED'] } },
            _count: { _all: true },
            orderBy: { action: 'asc' },
          }),
        ).resolves.toEqual([
          { action: 'COMMERCIAL_CAMPAIGN_ACTIVATED', _count: { _all: 1 } },
          { action: 'COMMERCIAL_CAMPAIGN_PUBLISHED', _count: { _all: 1 } },
        ])

        const rangeDrafts = []
        for (const [code, amount] of [
          ['INT4_PLUS_ONE', '21474836.48'],
          ['UNIT_MAX', '9999999999.99'],
        ] as const) {
          rangeDrafts.push(
            await draftModule.commercialCampaignDraftService.createDraft(
              {
                code,
                name: code,
                startsAt,
                endsAt,
                stackingGroups: [],
                rules: [
                  {
                    code: `${code}_RULE`,
                    type: 'FIXED_PRICE',
                    priority: 1,
                    target: { productCodes: ['POS'] },
                    amount,
                    cycles: 1,
                  },
                ],
              },
              draftActor,
            ),
          )
        }
        expect(rangeDrafts.map(item => (item.rules[0] as { amount: string }).amount)).toEqual(['21474836.48', '9999999999.99'])
        await expect(
          draftModule.commercialCampaignDraftService.createDraft(
            {
              code: 'UNIT_OVERFLOW',
              name: 'UNIT_OVERFLOW',
              startsAt,
              endsAt,
              stackingGroups: [],
              rules: [
                {
                  code: 'UNIT_OVERFLOW_RULE',
                  type: 'FIXED_PRICE',
                  priority: 1,
                  target: { productCodes: ['POS'] },
                  amount: '10000000000.00',
                  cycles: 1,
                },
              ],
            },
            draftActor,
          ),
        ).rejects.toMatchObject({ statusCode: 409, code: 'COMMERCIAL_CAMPAIGN_DRAFT_INVALID' })
        const maxRule = await prisma.commercialCampaignRuleDraft.findFirstOrThrow({ where: { campaignDraftId: rangeDrafts[1].id } })
        await expect(
          prisma.$executeRaw`UPDATE "CommercialCampaignRuleDraft" SET "amountMinor" = 1000000000000 WHERE "id" = ${maxRule.id}`,
        ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '23514' }) })
        await sql.query('CREATE TEMP TABLE commercial_p3_2c_bigint_probe (value BIGINT NOT NULL)')
        await sql.query('INSERT INTO commercial_p3_2c_bigint_probe (value) VALUES ($1::bigint)', ['9223372036854775807'])
        const bigintProbe = await sql.query<{ value: string }>('SELECT value::text AS value FROM commercial_p3_2c_bigint_probe')
        expect(bigintProbe.rows).toEqual([{ value: '9223372036854775807' }])

        for (const invalidMutation of [
          'UPDATE "CommercialCampaignDraft" SET "allowedRuleCodeGroups" = NULL, "stackingGroups" = NULL WHERE "id" = \'legacy-draft-p3-2c\'',
          'UPDATE "CommercialCampaignDraft" SET "allowedRuleCodeGroups" = \'[]\'::jsonb, "stackingGroups" = \'[]\'::jsonb WHERE "id" = \'legacy-draft-p3-2c\'',
          'UPDATE "CommercialCampaignDraft" SET "allowedRuleCodeGroups" = NULL, "stackingGroups" = \'null\'::jsonb WHERE "id" = \'legacy-draft-p3-2c\'',
          'UPDATE "CommercialCampaignDraft" SET "allowedRuleCodeGroups" = NULL, "stackingGroups" = \'{}\'::jsonb WHERE "id" = \'legacy-draft-p3-2c\'',
        ]) {
          await expect(sql.query(invalidMutation)).rejects.toMatchObject({ code: '23514' })
        }

        await prisma.commercialCampaignDraft.update({
          where: { id: rangeDrafts[0].id },
          data: {
            stackingGroups: [
              {
                code: 'BAD_STACK',
                steps: [
                  { position: 1, ruleCode: 'INT4_PLUS_ONE_RULE' },
                  { position: 2, ruleCode: 'UNKNOWN_RULE' },
                ],
              },
            ],
          },
        })
        await expect(draftModule.commercialCampaignDraftService.getDraft(rangeDrafts[0].id)).rejects.toMatchObject({
          statusCode: 409,
          code: 'COMMERCIAL_CAMPAIGN_DRAFT_STORAGE_INVALID',
        })
        await expect(
          publicationService.publishAndActivate(
            {
              draftId: rangeDrafts[0].id,
              expectedDraftRevision: 1,
              expectedActivationRevision: null,
              reason: actor.reason,
              confirm: true,
            },
            actor,
          ),
        ).rejects.toMatchObject({ statusCode: 409, code: 'COMMERCIAL_CAMPAIGN_DRAFT_STORAGE_INVALID' })

        const constraints = await sql.query<{ name: string }>(`
        SELECT conname AS name FROM pg_constraint WHERE conname = ANY(ARRAY[
          'CommercialCampaignRuleDraft_amount_unit_check',
          'CommercialCampaignDraft_stacking_storage_check'
        ]::text[]) ORDER BY conname
      `)
        expect(constraints.rows.map(row => row.name)).toEqual([
          'CommercialCampaignDraft_stacking_storage_check',
          'CommercialCampaignRuleDraft_amount_unit_check',
        ])

        const roundTripInput = {
          code: 'ROUNDTRIP_C2',
          name: 'Cinco promociones antes de editar',
          description: null,
          startsAt,
          endsAt,
          stackingGroups: draft.stackingGroups,
          rules: draft.rules,
        }
        const roundTripCreated = await draftModule.commercialCampaignDraftService.createDraft(roundTripInput, draftActor)
        await expect(draftModule.commercialCampaignDraftService.getDraft(roundTripCreated.id)).resolves.toEqual(roundTripCreated)
        const roundTripReplaced = await draftModule.commercialCampaignDraftService.replaceDraft(
          roundTripCreated.id,
          { ...roundTripInput, name: 'Cinco promociones después de editar' },
          roundTripCreated.revision,
          draftActor,
        )
        expect(roundTripReplaced).toMatchObject({ revision: 2, name: 'Cinco promociones después de editar' })
        await expect(draftModule.commercialCampaignDraftService.getDraft(roundTripCreated.id)).resolves.toEqual(roundTripReplaced)
        const roundTripPublication = publicationModule.createCommercialCampaignPublicationService({
          ...publicationModule.prismaCommercialCampaignPublicationDependencies,
          now: () => new Date(now.getTime() + 2_000),
          randomId: (() => {
            const ids = ['roundtrip-v2-p3-2c', 'roundtrip-activation-p3-2c']
            return () => ids.shift() ?? 'unexpected-roundtrip-id'
          })(),
        })
        await expect(
          roundTripPublication.publishAndActivate(
            {
              draftId: roundTripReplaced.id,
              expectedDraftRevision: roundTripReplaced.revision,
              expectedActivationRevision: null,
              reason: actor.reason,
              confirm: true,
            },
            actor,
          ),
        ).resolves.toMatchObject({
          version: { id: 'roundtrip-v2-p3-2c', schemaVersion: 2, sourceRevision: 2 },
          activation: { campaignVersionId: 'roundtrip-v2-p3-2c', revision: 1 },
        })
        return { versions: coexistence.length, migrationCount: appliedCommercialMigrations.length }
      },
    )

    expect(completed).toEqual({
      result: { versions: 1, migrationCount: 4 },
      cleanupConfirmed: true,
    })
  })

  it('persists direct and preview-bridged v2 quotes atomically under a non-UTC PostgreSQL clock', async () => {
    const completed = await withC2Database(async ({ sql, prisma }) => {
      const bridgeMigration = migrationSource(quotePreviewBridgeMigration.name)
      expect(createHash('sha256').update(bridgeMigration).digest('hex')).toBe(quotePreviewBridgeMigration.sha256)
      await sql.query(bridgeMigration)

      const [codecModule, publicationModule, activationModule, acquisitionModule, previewModule, bridgeModule, directModule] =
        await Promise.all([
          import('@/services/commercial/commercialArtifactCodecRegistry.service'),
          import('@/services/commercial/commercialPublication.service'),
          import('@/services/commercial/commercialActivation.service'),
          import('@/services/commercial/commercialAcquisitionContext.service'),
          import('@/services/commercial/commercialPublicQuotePreviewV2.service'),
          import('@/services/commercial/commercialQuotePreviewBridge.service'),
          import('@/services/commercial/commercialDirectVenueQuote.service'),
        ])
      const actor = {
        staffId: 'staff-p3-2c',
        reason: 'C6 quote bridge disposable PostgreSQL',
        permissions: ['commercial:publish'],
      }
      const catalogSnapshot = JSON.parse(JSON.stringify(catalogV2FixtureJson)) as CommercialCatalogSnapshotV2
      const catalog = codecModule.emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: catalogSnapshot })
      await prisma.commercialDraft.create({
        data: {
          id: 'commercial-draft-quote-bridge-p3-2c',
          sourceKey: 'commercial-draft-quote-bridge-p3-2c',
          name: 'C6 quote bridge catalog',
          createdById: actor.staffId,
          updatedById: actor.staffId,
        },
      })
      await publicationModule.prismaCommercialPublicationDependencies.runInTransaction(tx =>
        tx.createPublicationIfAbsent({
          id: catalogSnapshot.publicationId,
          sourceDraftId: 'commercial-draft-quote-bridge-p3-2c',
          sourceRevision: 1,
          artifact: catalog,
          reason: actor.reason,
          publishedById: actor.staffId,
          publishedAt: new Date(catalogSnapshot.publishedAt),
        }),
      )
      await activationModule.activateCommercialPublication(
        {
          publicationId: catalogSnapshot.publicationId,
          expectedActivationRevision: 0,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      )

      const lines = [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }]
      const direct = await directModule.commercialDirectVenueQuoteService.create({
        organizationId: 'org-p3-2c',
        venueId: 'venue-p3-2c',
        actorId: actor.staffId,
        lines,
      })
      const acquisition = await acquisitionModule.commercialAcquisitionContextService.issue(
        { channel: 'DIRECT', utmSource: 'c6-disposable-postgres' },
        new Date(),
      )
      const preview = await previewModule.commercialPublicQuotePreviewV2Service.preview({
        market: 'MX',
        currency: 'MXN',
        acquisitionToken: acquisition.token,
        lines,
      })
      const bridgeInput = {
        organizationId: 'org-p3-2c',
        venueId: 'venue-p3-2c',
        actorId: actor.staffId,
        acquisitionBearer: acquisition.token,
        previewToken: preview.previewToken,
        normalizedLines: lines,
      }
      const concurrent = await Promise.all([
        bridgeModule.commercialQuotePreviewBridgeService.bridge(bridgeInput),
        bridgeModule.commercialQuotePreviewBridgeService.bridge(bridgeInput),
      ])
      expect(concurrent.map(result => result.outcome).sort()).toEqual(['CREATED', 'REPLAYED'])
      expect(concurrent[0].quote.snapshot).toEqual(concurrent[1].quote.snapshot)
      expect(concurrent[0].quote.checksum).toBe(concurrent[1].quote.checksum)
      const replayedConcurrent = concurrent.find(result => result.outcome === 'REPLAYED')
      expect(replayedConcurrent).toBeDefined()
      const replay = await bridgeModule.commercialQuotePreviewBridgeService.bridge(bridgeInput)
      expect(replay).toEqual({ outcome: 'REPLAYED', quote: replayedConcurrent?.quote })

      const quoteRows = await sql.query<{
        id: string
        schemaVersion: number
        snapshotMatches: boolean
        sessionTimezone: string
      }>(`
        SELECT
          quote."id",
          quote."schemaVersion" AS "schemaVersion",
          public.commercial_quote_snapshot_matches_v2_row(
            quote."snapshot", quote."id", quote."catalogPublicationId", quote."campaignVersionId",
            quote."acquisitionContextId", quote."organizationId", quote."venueId", quote."createdById",
            quote."market", quote."currency", quote."quotedAt", quote."expiresAt",
            quote."listSubtotalMinor", quote."discountMinor", quote."subtotalMinor", quote."taxMinor", quote."totalMinor",
            quote."renewalSubtotalMinor", quote."renewalTaxMinor", quote."renewalTotalMinor"
          ) AS "snapshotMatches",
          current_setting('TimeZone') AS "sessionTimezone"
        FROM "CommercialQuote" AS quote
        ORDER BY quote."id"
      `)
      expect(quoteRows.rows).toHaveLength(2)
      expect(quoteRows.rows.every(row => row.schemaVersion === 2 && row.snapshotMatches)).toBe(true)
      expect(quoteRows.rows.every(row => row.sessionTimezone === 'Pacific/Auckland')).toBe(true)
      expect(quoteRows.rows.map(row => row.id)).toContain(direct.id)

      const evidence = await sql.query<{
        bindings: number
        quotes: number
        audits: number
        previewConstraint: string
        restrictForeignKeys: number
      }>(`
        SELECT
          (SELECT count(*)::integer FROM "CommercialQuotePreviewBridge") AS bindings,
          (SELECT count(*)::integer FROM "CommercialQuote") AS quotes,
          (SELECT count(*)::integer FROM "ActivityLog" WHERE action = 'COMMERCIAL_QUOTE_CREATED') AS audits,
          (SELECT conname FROM pg_constraint
            WHERE conrelid = '"CommercialQuotePreviewBridge"'::regclass AND contype = 'u'
              AND conname = 'CommercialQuotePreviewBridge_previewQuoteId_key') AS "previewConstraint",
          (SELECT count(*)::integer FROM pg_constraint
            WHERE conrelid = '"CommercialQuotePreviewBridge"'::regclass AND contype = 'f' AND confdeltype = 'r') AS "restrictForeignKeys"
      `)
      expect(evidence.rows).toEqual([
        {
          bindings: 1,
          quotes: 2,
          audits: 2,
          previewConstraint: 'CommercialQuotePreviewBridge_previewQuoteId_key',
          restrictForeignKeys: 5,
        },
      ])

      const persistedBinding = await prisma.commercialQuotePreviewBridge.findUniqueOrThrow({
        where: { venueQuoteId: replay.quote.snapshot.quoteId },
      })

      let realPreviewUniqueError: unknown
      try {
        await prisma.commercialQuotePreviewBridge.create({
          data: {
            previewQuoteId: persistedBinding.previewQuoteId,
            previewChecksum: persistedBinding.previewChecksum,
            acquisitionContextId: persistedBinding.acquisitionContextId,
            organizationId: bridgeInput.organizationId,
            venueId: bridgeInput.venueId,
            actorId: bridgeInput.actorId,
            selectionFingerprint: persistedBinding.selectionFingerprint,
            venueQuoteId: direct.id,
          },
        })
      } catch (error) {
        realPreviewUniqueError = error
      }
      expect(realPreviewUniqueError).toMatchObject({
        code: 'P2002',
        meta: { modelName: 'CommercialQuotePreviewBridge' },
      })
      expect(bridgeModule.isPreviewQuoteBindingUniqueConflict(realPreviewUniqueError)).toBe(true)

      let realOtherBridgeUniqueError: unknown
      try {
        await prisma.commercialQuotePreviewBridge.create({
          data: {
            previewQuoteId: 'preview-other-unique-control',
            previewChecksum: 'a'.repeat(64),
            acquisitionContextId: persistedBinding.acquisitionContextId,
            organizationId: bridgeInput.organizationId,
            venueId: bridgeInput.venueId,
            actorId: bridgeInput.actorId,
            selectionFingerprint: 'b'.repeat(64),
            venueQuoteId: replay.quote.snapshot.quoteId,
          },
        })
      } catch (error) {
        realOtherBridgeUniqueError = error
      }
      expect(realOtherBridgeUniqueError).toMatchObject({
        code: 'P2002',
        meta: { modelName: 'CommercialQuotePreviewBridge' },
      })
      expect(bridgeModule.isPreviewQuoteBindingUniqueConflict(realOtherBridgeUniqueError)).toBe(false)
      expect(await prisma.commercialQuotePreviewBridge.count()).toBe(1)

      const expectAuthorityRequired = async (candidate: typeof bridgeInput) => {
        await expect(bridgeModule.commercialQuotePreviewBridgeService.bridge(candidate)).rejects.toMatchObject({
          statusCode: 403,
          code: 'COMMERCIAL_PREVIEW_BRIDGE_AUTHORITY_REQUIRED',
        })
      }

      await expectAuthorityRequired({ ...bridgeInput, organizationId: 'organization-cross-target' })
      await sql.query(`INSERT INTO "Staff" ("id") VALUES ('staff-without-membership-p3-2c')`)
      await expectAuthorityRequired({ ...bridgeInput, actorId: 'staff-without-membership-p3-2c' })

      await sql.query(`UPDATE "Staff" SET "active" = false WHERE "id" = 'staff-p3-2c'`)
      await expectAuthorityRequired(bridgeInput)
      await sql.query(`UPDATE "Staff" SET "active" = true WHERE "id" = 'staff-p3-2c'`)

      await sql.query(`UPDATE "StaffVenue" SET "active" = false WHERE "id" = 'staff-venue-p3-2c'`)
      await expectAuthorityRequired(bridgeInput)
      await sql.query(`UPDATE "StaffVenue" SET "active" = true WHERE "id" = 'staff-venue-p3-2c'`)

      await sql.query(`
        INSERT INTO "Venue" ("id", "organizationId") VALUES ('venue-other-scope-p3-2c', 'org-p3-2c');
        INSERT INTO "PermissionSet" ("id", "venueId", "permissions")
          VALUES ('permission-set-other-scope-p3-2c', 'venue-other-scope-p3-2c', ARRAY['billing:subscriptions:manage']);
        UPDATE "StaffVenue" SET "permissionSetId" = 'permission-set-other-scope-p3-2c'
          WHERE "id" = 'staff-venue-p3-2c';
      `)
      await expectAuthorityRequired(bridgeInput)
      await sql.query(`UPDATE "StaffVenue" SET "permissionSetId" = NULL WHERE "id" = 'staff-venue-p3-2c'`)

      await sql.query(`UPDATE "StaffVenue" SET "role" = 'VIEWER' WHERE "id" = 'staff-venue-p3-2c'`)
      await expectAuthorityRequired(bridgeInput)
      await sql.query(`UPDATE "StaffVenue" SET "role" = 'OWNER' WHERE "id" = 'staff-venue-p3-2c'`)

      const staffVenueDelegate = prisma.staffVenue as unknown as {
        findUnique(args: unknown): Promise<unknown>
      }
      const originalFindUnique = staffVenueDelegate.findUnique.bind(staffVenueDelegate)
      const preflightRace = jest.spyOn(staffVenueDelegate, 'findUnique').mockImplementation(async args => {
        const membership = await originalFindUnique(args)
        await sql.query(`UPDATE "StaffVenue" SET "active" = false WHERE "id" = 'staff-venue-p3-2c'`)
        return membership
      })
      try {
        await expectAuthorityRequired(bridgeInput)
      } finally {
        preflightRace.mockRestore()
        await sql.query(`UPDATE "StaffVenue" SET "active" = true WHERE "id" = 'staff-venue-p3-2c'`)
      }

      const retryAcquisition = await acquisitionModule.commercialAcquisitionContextService.issue(
        { channel: 'DIRECT', utmSource: 'c6-retry-authority' },
        new Date(),
      )
      const retryPreview = await previewModule.commercialPublicQuotePreviewV2Service.preview({
        market: 'MX',
        currency: 'MXN',
        acquisitionToken: retryAcquisition.token,
        lines,
      })
      const retryInput = {
        ...bridgeInput,
        acquisitionBearer: retryAcquisition.token,
        previewToken: retryPreview.previewToken,
      }
      const productionDependencies = bridgeModule.prismaCommercialQuotePreviewBridgeDependencies
      const productionRunInReadCommitted = productionDependencies.runInReadCommitted
      let injectedUnique = false
      const retryAuthorityService = bridgeModule.createCommercialQuotePreviewBridgeService({
        ...productionDependencies,
        async runInReadCommitted(operation) {
          try {
            return await productionRunInReadCommitted(operation)
          } catch (error) {
            if (injectedUnique && bridgeModule.isPreviewQuoteBindingUniqueConflict(error)) {
              await sql.query(`UPDATE "StaffVenue" SET "active" = false WHERE "id" = 'staff-venue-p3-2c'`)
            }
            throw error
          }
        },
        async insertBinding() {
          injectedUnique = true
          throw {
            code: 'P2002',
            meta: { modelName: 'CommercialQuotePreviewBridge', target: ['previewQuoteId'] },
          }
        },
      })
      try {
        await expect(retryAuthorityService.bridge(retryInput)).rejects.toMatchObject({
          statusCode: 403,
          code: 'COMMERCIAL_PREVIEW_BRIDGE_AUTHORITY_REQUIRED',
        })
      } finally {
        await sql.query(`UPDATE "StaffVenue" SET "active" = true WHERE "id" = 'staff-venue-p3-2c'`)
      }
      expect(injectedUnique).toBe(true)
      expect(await prisma.commercialQuotePreviewBridge.count()).toBe(1)
      expect(await prisma.commercialQuote.count()).toBe(2)

      const lockTimeoutService = bridgeModule.createCommercialQuotePreviewBridgeService({
        ...productionDependencies,
        runInReadCommitted: operation =>
          productionRunInReadCommitted(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '250ms'`)
            return operation(tx)
          }),
      })
      const createFreshBridgeInput = async (utmSource: string) => {
        const freshAcquisition = await acquisitionModule.commercialAcquisitionContextService.issue(
          { channel: 'DIRECT', utmSource },
          new Date(),
        )
        const freshPreview = await previewModule.commercialPublicQuotePreviewV2Service.preview({
          market: 'MX',
          currency: 'MXN',
          acquisitionToken: freshAcquisition.token,
          lines,
        })
        return {
          ...bridgeInput,
          acquisitionBearer: freshAcquisition.token,
          previewToken: freshPreview.previewToken,
        }
      }

      const activationLockInput = await createFreshBridgeInput('c6-activation-lock-order')
      await sql.query('BEGIN')
      await sql.query(`
        SELECT "id" FROM "CommercialPublicationActivation"
        WHERE "environment" = 'PRODUCTION'
        FOR UPDATE
      `)
      try {
        await expect(lockTimeoutService.bridge(activationLockInput)).rejects.toBeDefined()
      } finally {
        await sql.query('ROLLBACK')
      }
      await expect(bridgeModule.commercialQuotePreviewBridgeService.bridge(activationLockInput)).resolves.toMatchObject({
        outcome: 'CREATED',
      })

      const venueWriterLockInput = await createFreshBridgeInput('c6-venue-writer-lock-order')
      await sql.query('BEGIN')
      await sql.query(`SELECT "id" FROM "Venue" WHERE "id" = 'venue-p3-2c' FOR UPDATE`)
      try {
        await expect(lockTimeoutService.bridge(venueWriterLockInput)).rejects.toBeDefined()
      } finally {
        await sql.query('ROLLBACK')
      }
      await expect(bridgeModule.commercialQuotePreviewBridgeService.bridge(venueWriterLockInput)).resolves.toMatchObject({
        outcome: 'CREATED',
      })
      expect(await prisma.commercialQuotePreviewBridge.count()).toBe(3)
      expect(await prisma.commercialQuote.count()).toBe(4)
      return true
    })

    expect(completed).toEqual({ result: true, cleanupConfirmed: true })
  })

  it.each(['legacy-json', 'unit-amount'] as const)(
    'fails C2 migration preflight on dirty %s before the first ALTER and rolls back without drift',
    async dirtyKind => {
      const completed = await withPreC2Database(async ({ client }) => {
        if (dirtyKind === 'legacy-json') {
          await client.query(`
            UPDATE "CommercialCampaignDraft" SET "allowedRuleCodeGroups" = '{}'::jsonb
             WHERE "id" = 'legacy-draft-p3-2c'
          `)
        } else {
          await client.query(`
            ALTER TABLE "CommercialCampaignRuleDraft"
              DROP CONSTRAINT "CommercialCampaignRuleDraft_v1_amount_int4_check";
            UPDATE "CommercialCampaignRuleDraft" SET "amountMinor" = 1000000000000
             WHERE "id" = 'legacy-rule-p3-2c';
          `)
        }
        const before = await preC2Fingerprint(client)
        let failure: unknown
        try {
          await client.query(migrationSource(migrationChain[3].name))
        } catch (error) {
          failure = error
        }
        await client.query('ROLLBACK')
        expect(failure).toMatchObject({ code: '23514', message: 'COMMERCIAL_CAMPAIGN_C2_LEGACY_PREFLIGHT_FAILED' })
        expect(await preC2Fingerprint(client)).toBe(before)
        const shape = await client.query<{ stackingColumn: number; oldConstraint: number; newConstraint: number }>(`
          SELECT
            (SELECT count(*)::integer FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'CommercialCampaignDraft' AND column_name = 'stackingGroups') AS "stackingColumn",
            (SELECT count(*)::integer FROM pg_constraint
              WHERE conname = 'CommercialCampaignRuleDraft_v1_amount_int4_check') AS "oldConstraint",
            (SELECT count(*)::integer FROM pg_constraint
              WHERE conname = 'CommercialCampaignRuleDraft_amount_unit_check') AS "newConstraint"
        `)
        expect(shape.rows).toEqual([
          {
            stackingColumn: 0,
            oldConstraint: dirtyKind === 'unit-amount' ? 0 : 1,
            newConstraint: 0,
          },
        ])
        return true
      })
      expect(completed).toEqual({ result: true, cleanupConfirmed: true })
    },
  )

  it('holds both ACCESS EXCLUSIVE locks through verified predicates and deterministically blocks a conforming writer', async () => {
    const completed = await withPreC2Database(async ({ client, server, databaseName }) => {
      const source = migrationSource(migrationChain[3].name)
      const firstAlterMarker = '\nALTER TABLE "CommercialCampaignDraft"\n  ADD COLUMN "stackingGroups" JSONB'
      expect(source.split(firstAlterMarker)).toHaveLength(2)
      const lockedPredicatePrefix = source.slice(0, source.indexOf(firstAlterMarker))
      expect(createHash('sha256').update(lockedPredicatePrefix).digest('hex')).toBe(
        'f79f8061c31f9492d6edd0ef301823635dd5efcb6912db9e8a66bff9888dd378',
      )
      await client.query(lockedPredicatePrefix)
      const migrationPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const writer = new Client({ ...server, database: databaseName, ssl: false })
      await writer.connect()
      try {
        await writer.query('BEGIN')
        const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        const writing = writer.query(`
          UPDATE "CommercialCampaignDraft" SET "updatedAt" = "updatedAt"
           WHERE "id" = 'legacy-draft-p3-2c'
        `)
        let blockers: number[] = []
        for (let attempt = 0; attempt < 1_000 && !blockers.includes(migrationPid); attempt += 1) {
          blockers = (await client.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1)::integer[] AS blockers', [writerPid])).rows[0]
            .blockers
          if (!blockers.includes(migrationPid)) await new Promise<void>(resolve => setImmediate(resolve))
        }
        expect(blockers).toContain(migrationPid)
        await client.query('ROLLBACK')
        await expect(writing).resolves.toBeDefined()
        await writer.query('ROLLBACK')
      } finally {
        await writer.end()
      }
      const shape = await client.query<{ count: number }>(`
        SELECT count(*)::integer AS count FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'CommercialCampaignDraft' AND column_name = 'stackingGroups'
      `)
      expect(shape.rows).toEqual([{ count: 0 }])
      return true
    })
    expect(completed).toEqual({ result: true, cleanupConfirmed: true })
  })

  it('returns wholly revision N from an open RepeatableRead snapshot while a writer commits N+1', async () => {
    const completed = await withC2Database(async ({ prisma }) => {
      const [{ commercialCampaignDraftService }, { loadCommercialCampaignDraftGraph }, { Prisma }] = await Promise.all([
        import('@/services/commercial/commercialCampaignDraft.service'),
        import('@/services/commercial/commercialCampaignDraftGraph.service'),
        import('@prisma/client'),
      ])
      const actor = { staffId: 'staff-p3-2c', reason: 'Prueba determinista de snapshot' }
      const baseInput = {
        code: 'SNAPSHOT_C2',
        name: 'Revisión N',
        startsAt: '2026-08-01T00:00:00.000Z',
        endsAt: '2026-10-01T00:00:00.000Z',
        stackingGroups: [],
        rules: [
          {
            code: 'SNAPSHOT_FIXED',
            type: 'FIXED_PRICE' as const,
            priority: 1,
            target: { productCodes: ['POS'] },
            amount: '50.00',
            cycles: 1,
          },
        ],
      }
      const created = await commercialCampaignDraftService.createDraft(baseInput, actor)
      let signalParentRead!: () => void
      let releaseChildRead!: () => void
      const parentRead = new Promise<void>(resolve => (signalParentRead = resolve))
      const childMayRead = new Promise<void>(resolve => (releaseChildRead = resolve))

      const reading = prisma.$transaction(
        async tx => {
          let parentQueries = 0
          const delegated = {
            $queryRaw: async (...args: Parameters<typeof tx.$queryRaw>) => {
              const rows = await tx.$queryRaw(...args)
              parentQueries += 1
              if (parentQueries === 1) {
                signalParentRead()
                await childMayRead
              }
              return rows
            },
            commercialCampaignRuleDraft: {
              findMany: tx.commercialCampaignRuleDraft.findMany.bind(tx.commercialCampaignRuleDraft),
            },
          }
          return loadCommercialCampaignDraftGraph(delegated as never, created.id, { consistency: 'SNAPSHOT' })
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 5_000,
          timeout: 30_000,
        },
      )

      await parentRead
      const replaced = await commercialCampaignDraftService.replaceDraft(
        created.id,
        {
          ...baseInput,
          name: 'Revisión N más uno',
          rules: [{ ...baseInput.rules[0], amount: '22.00' }],
        },
        created.revision,
        actor,
      )
      releaseChildRead()
      const snapshotN = await reading
      const snapshotNPlusOne = await commercialCampaignDraftService.getDraft(created.id)

      expect(snapshotN).toMatchObject({ revision: 1, name: 'Revisión N', rules: [{ amount: '50.00' }] })
      expect(replaced).toMatchObject({ revision: 2, name: 'Revisión N más uno', rules: [{ amount: '22.00' }] })
      expect(snapshotNPlusOne).toEqual(replaced)
      return true
    })
    expect(completed).toEqual({ result: true, cleanupConfirmed: true })
  })

  it('rejects rollback with INT4_RANGE from an expanded unpublished draft without inventing history', async () => {
    const completed = await withC2Database(async ({ sql, prisma, databaseName }) => {
      const [{ commercialCampaignDraftService }, rollbackModule] = await Promise.all([
        import('@/services/commercial/commercialCampaignDraft.service'),
        import('../../../scripts/commercial/rollback-contract-v2'),
      ])
      const actor = { staffId: 'staff-p3-2c', reason: 'Rollback floor INT4' }
      const startsAt = '2026-08-01T00:00:00.000Z'
      const endsAt = '2026-10-01T00:00:00.000Z'
      const draft = await commercialCampaignDraftService.createDraft(
        {
          code: 'ROLLBACK_INT4',
          name: 'Rollback INT4',
          startsAt,
          endsAt,
          stackingGroups: [],
          rules: [
            {
              code: 'ROLLBACK_INT4_RULE',
              type: 'FIXED_PRICE',
              priority: 1,
              target: { productCodes: ['POS'] },
              amount: '21474836.48',
              cycles: 1,
            },
          ],
        },
        actor,
      )
      expect(draft.rules).toEqual([expect.objectContaining({ amount: '21474836.48' })])
      expect(await prisma.commercialCampaignVersion.findMany({ select: { schemaVersion: true } })).toEqual([])
      expect(await prisma.commercialCampaignActivation.count()).toBe(0)
      const before = await preC2Fingerprint(sql)
      let failure: unknown
      try {
        await rollbackModule.runCommercialContractV2Rollback({
          databaseUrl: process.env.DATABASE_URL,
          argv: rollbackArguments(databaseName),
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({
        outcome: 'REJECTED',
        code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_INT4_RANGE',
        sqlSha256: rollbackSqlSha,
      })
      expect(await preC2Fingerprint(sql)).toBe(before)
      return true
    })
    expect(completed).toEqual({ result: true, cleanupConfirmed: true })
  })

  it('gives v2 schema rollback rejection precedence over scanning an expanded draft amount', async () => {
    const completed = await withC2Database(async ({ sql, prisma, databaseName }) => {
      const [draftModule, publicationModule, rollbackModule] = await Promise.all([
        import('@/services/commercial/commercialCampaignDraft.service'),
        import('@/services/commercial/commercialCampaignPublication.service'),
        import('../../../scripts/commercial/rollback-contract-v2'),
      ])
      const actor = {
        staffId: 'staff-p3-2c',
        reason: 'Rollback floor schema v2',
        permissions: ['commercial:publish'],
      }
      const draft = await draftModule.commercialCampaignDraftService.createDraft(
        {
          code: 'ROLLBACK_SCHEMA_V2',
          name: 'Rollback schema v2',
          startsAt: '2026-08-01T00:00:00.000Z',
          endsAt: '2026-10-01T00:00:00.000Z',
          stackingGroups: [],
          rules: [
            {
              code: 'ROLLBACK_SCHEMA_RULE',
              type: 'FIXED_PRICE',
              priority: 1,
              target: { productCodes: ['POS'] },
              amount: '21474836.48',
              cycles: 1,
            },
          ],
        },
        { staffId: actor.staffId, reason: actor.reason },
      )
      const publication = publicationModule.createCommercialCampaignPublicationService({
        ...publicationModule.prismaCommercialCampaignPublicationDependencies,
        now: () => new Date('2026-08-26T18:00:00.000Z'),
        randomId: (() => {
          const ids = ['rollback-schema-v2', 'rollback-schema-activation']
          return () => ids.shift() ?? 'unexpected-rollback-id'
        })(),
      })
      await publication.publishAndActivate(
        {
          draftId: draft.id,
          expectedDraftRevision: draft.revision,
          expectedActivationRevision: null,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      )
      expect(await prisma.commercialCampaignRuleDraft.findFirstOrThrow({ where: { campaignDraftId: draft.id } })).toMatchObject({
        amountMinor: 2147483648n,
      })
      const before = await preC2Fingerprint(sql)
      let failure: unknown
      try {
        await rollbackModule.runCommercialContractV2Rollback({
          databaseUrl: process.env.DATABASE_URL,
          argv: rollbackArguments(databaseName),
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({
        outcome: 'REJECTED',
        code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SCHEMA_UNSUPPORTED',
        sqlSha256: rollbackSqlSha,
      })
      expect(await preC2Fingerprint(sql)).toBe(before)
      return true
    })
    expect(completed).toEqual({ result: true, cleanupConfirmed: true })
  })

  it('proves the clean C2 rollback floor through the frozen tool and exact six-statement causal replay', async () => {
    const completed = await withC2Database(async ({ sql, databaseName }) => {
      const rollbackModule = await import('../../../scripts/commercial/rollback-contract-v2')
      const preconditions = await sql.query<{ constraints: string[]; indexes: string[]; oldConstraint: number }>(`
        SELECT
          (SELECT to_jsonb(array_agg(conname ORDER BY conname)) FROM pg_constraint WHERE conname = ANY(ARRAY[
            'CommercialQuote_snapshot_totals_check',
            'CommercialPublication_snapshot_schema_version_check',
            'CommercialCampaignVersion_snapshot_schema_version_check',
            'CommercialQuote_snapshot_schema_version_check'
          ]::text[])) AS constraints,
          (SELECT to_jsonb(array_agg(indexname ORDER BY indexname)) FROM pg_indexes WHERE schemaname = 'public'
            AND indexname = 'CommercialCampaignVersion_sourceDraft_revision_schema_key') AS indexes,
          (SELECT count(*)::integer FROM pg_constraint
            WHERE conname = 'CommercialCampaignRuleDraft_v1_amount_int4_check') AS "oldConstraint"
      `)
      expect(preconditions.rows).toEqual([
        {
          constraints: [
            'CommercialCampaignVersion_snapshot_schema_version_check',
            'CommercialPublication_snapshot_schema_version_check',
            'CommercialQuote_snapshot_schema_version_check',
            'CommercialQuote_snapshot_totals_check',
          ],
          indexes: ['CommercialCampaignVersion_sourceDraft_revision_schema_key'],
          oldConstraint: 0,
        },
      ])
      const before = await preC2Fingerprint(sql)
      let toolFailure: unknown
      try {
        await rollbackModule.runCommercialContractV2Rollback({
          databaseUrl: process.env.DATABASE_URL,
          argv: rollbackArguments(databaseName),
        })
      } catch (error) {
        toolFailure = error
      }
      expect(toolFailure).toMatchObject({
        outcome: 'REJECTED',
        code: 'COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_FAILURE',
        sqlSha256: rollbackSqlSha,
      })
      expect((toolFailure as { code?: string }).code).not.toBe('COMMERCIAL_CONTRACT_V2_ROLLBACK_SQL_SHA_MISMATCH')
      expect(await preC2Fingerprint(sql)).toBe(before)

      const rollbackSource = readFileSync(path.join(repoRoot, 'scripts/commercial/rollback-contract-v2.sql'), 'utf8')
      expect(createHash('sha256').update(rollbackSource).digest('hex')).toBe(rollbackSqlSha)
      const marker = '\nALTER TABLE "CommercialPublication"\n  DROP CONSTRAINT "CommercialPublication_schema_version_check"'
      expect(rollbackSource.split(marker)).toHaveLength(2)
      const prefix = rollbackSource.slice(0, rollbackSource.indexOf(marker))
      const spans: string[] = []
      let cursor = 0
      while (true) {
        const semicolon = prefix.indexOf(';', cursor)
        if (semicolon < 0) break
        spans.push(prefix.slice(cursor, semicolon + 1))
        cursor = semicolon + 1
      }
      const tail = prefix.slice(cursor)
      expect(spans).toHaveLength(6)
      expect(tail.trim()).toBe('')
      expect(`${spans.join('')}${tail}`).toBe(prefix)

      await sql.query('BEGIN')
      for (const statement of spans.slice(0, 5)) await expect(sql.query(statement.trim())).resolves.toBeDefined()
      let sixthFailure: unknown
      try {
        await sql.query(spans[5].trim())
      } catch (error) {
        sixthFailure = error
      }
      expect(sixthFailure).toMatchObject({ code: '42704' })
      expect((sixthFailure as Error).message).toContain('CommercialCampaignRuleDraft_v1_amount_int4_check')
      await sql.query('ROLLBACK')
      expect(await preC2Fingerprint(sql)).toBe(before)
      return true
    }, { currentPrismaReadShape: false })
    expect(completed).toEqual({ result: true, cleanupConfirmed: true })
  })

  it('distinguishes JSON null from SQL NULL through the real provenance adapter in an always-rolled-back bypass', async () => {
    const completed = await withC2Database(async ({ prisma, sql }) => {
      const [{ commercialCampaignDraftService }, { loadCommercialCampaignDraftGraph }] = await Promise.all([
        import('@/services/commercial/commercialCampaignDraft.service'),
        import('@/services/commercial/commercialCampaignDraftGraph.service'),
      ])
      const draft = await commercialCampaignDraftService.createDraft(
        {
          code: 'JSON_NULL_C2',
          name: 'JSON null provenance',
          startsAt: '2026-08-01T00:00:00.000Z',
          endsAt: '2026-10-01T00:00:00.000Z',
          stackingGroups: [],
          rules: [
            {
              code: 'JSON_NULL_RULE',
              type: 'FREE_PERIOD',
              priority: 1,
              target: { productCodes: ['POS'] },
              cycles: 1,
            },
          ],
        },
        { staffId: 'staff-p3-2c', reason: 'Prueba de procedencia JSON null' },
      )
      const rollbackSignal = 'COMMERCIAL_P3_2C_EXPECTED_JSON_NULL_ROLLBACK'
      await expect(
        prisma.$transaction(async tx => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE "CommercialCampaignDraft" DROP CONSTRAINT "CommercialCampaignDraft_stacking_storage_check"',
          )
          await tx.$executeRaw`
            UPDATE "CommercialCampaignDraft"
               SET "allowedRuleCodeGroups" = NULL, "stackingGroups" = 'null'::jsonb
             WHERE "id" = ${draft.id}
          `
          const provenance = await tx.$queryRaw<Array<{ legacyIsSqlNull: boolean; stackingKind: string }>>`
            SELECT "allowedRuleCodeGroups" IS NULL AS "legacyIsSqlNull",
                   jsonb_typeof("stackingGroups") AS "stackingKind"
              FROM "CommercialCampaignDraft" WHERE "id" = ${draft.id}
          `
          expect(provenance).toEqual([{ legacyIsSqlNull: true, stackingKind: 'null' }])
          await expect(loadCommercialCampaignDraftGraph(tx, draft.id, { consistency: 'FOR_UPDATE' })).rejects.toMatchObject({
            statusCode: 409,
            code: 'COMMERCIAL_CAMPAIGN_DRAFT_STORAGE_INVALID',
          })
          throw new Error(rollbackSignal)
        }),
      ).rejects.toThrow(rollbackSignal)
      const preserved = await sql.query<{ stacking: unknown; constraintCount: number }>(
        `
        SELECT draft."stackingGroups" AS stacking,
               (SELECT count(*)::integer FROM pg_constraint
                 WHERE conname = 'CommercialCampaignDraft_stacking_storage_check') AS "constraintCount"
          FROM "CommercialCampaignDraft" AS draft WHERE draft."id" = $1
      `,
        [draft.id],
      )
      expect(preserved.rows).toEqual([{ stacking: [], constraintCount: 1 }])
      return true
    })
    expect(completed).toEqual({ result: true, cleanupConfirmed: true })
  })
})
