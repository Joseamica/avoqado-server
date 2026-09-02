import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import Ajv from 'ajv'
import { Client, type ClientConfig } from 'pg'
import { PrismaClient } from '@prisma/client'

import catalogV2Fixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import quoteV2Schema from '@/contracts/commercial/commercial-quote-v2.schema.json'
import quoteV3Schema from '@/contracts/commercial/commercial-quote-v3.schema.json'
import resolutionSchema from '@/contracts/commercial/commercial-offer-resolution-v2.schema.json'
import {
  MAX_QUOTE_LIST_SUBTOTAL_MINOR,
  MAX_QUOTE_TAX_MINOR,
  MAX_QUOTE_TOTAL_MINOR,
  MAX_UNIT_AMOUNT_MINOR,
} from '@/contracts/commercial/commercialContractV2.constants'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { canonicalJsonBytesV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { decodeAndVerifyStoredCommercialOfferV3, emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import {
  createCommercialOfferReleasePreflightService,
  createPrismaCommercialOfferReleasePreflightDependencies,
} from '@/services/commercial/offers/commercialOfferReleasePreflight.service'
import { createCommercialQuoteAcceptanceService } from '@/services/commercial/commercialQuoteAcceptance.service'
import { assertCommercialV2CheckoutActive } from '@/services/commercial/commercialV2CheckoutPolicy.service'
import { buildCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Builder.service'
import { COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES } from '@/services/commercial/quotes-v3/commercialQuoteV3Contract.service'
import { evaluateCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Engine.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'
import type { CommercialQuoteV3Authorities, EmittedCommercialQuoteV3 } from '@/types/commercialQuoteV3'

jest.setTimeout(600_000)

const repoRoot = path.resolve(__dirname, '../../..')
const currentChain = [
  '20260822050000_add_commercial_catalog_phase1',
  '20260822090000_add_commercial_campaigns_quotes_phase2',
  '20260824150000_expand_commercial_contract_v2',
  '20260826170000_add_commercial_campaign_stacking_groups_v2',
  '20260827120000_enable_commercial_acquisition_context_cleanup',
  '20260828120000_add_commercial_quote_preview_bridge',
  '20260828200000_add_commercial_offer_v3',
] as const
const quoteV3Migrations = ['20260829100000_add_commercial_quote_v3_shape', '20260829110000_validate_commercial_quote_v3'] as const
const quoteV3PrismaBaseline = '20260829090000_commercial_quote_v3_test_baseline'
const legacyQuoteConstraintNames = [
  'CommercialQuote_schema_version_check',
  'CommercialQuote_snapshot_schema_version_check',
  'CommercialQuote_snapshot_totals_check',
  'CommercialQuote_totals_check',
] as const
const quoteV1Fixture = JSON.parse(
  readFileSync(path.join(repoRoot, 'src/contracts/commercial/fixtures/quote-pos-50-v1.json'), 'utf8'),
) as Record<string, any>
const quoteV2Fixture = JSON.parse(
  readFileSync(path.join(repoRoot, 'src/contracts/commercial/fixtures/v2/quote-pos-50-venue.json'), 'utf8'),
) as Record<string, any>
const quoteV3Fixture = JSON.parse(
  readFileSync(path.join(repoRoot, 'src/contracts/commercial/fixtures/v3/commercial-quote-v3-direct.json'), 'utf8'),
) as Record<string, any>
const offerV3Fixture = JSON.parse(
  readFileSync(path.join(repoRoot, 'src/contracts/commercial/fixtures/v3/commercial-offer-v3.json'), 'utf8'),
) as Record<string, any>

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const catalogV2Authority = emitCommercialArtifactV2({
  kind: 'CATALOG',
  schemaVersion: 2,
  domainValue: cloneJson(catalogV2Fixture) as CommercialCatalogSnapshotV2,
})

interface BaselineRelation {
  relation: string
  rows: number
  totalBytes: number
}

interface MigrationReceipt {
  relations: BaselineRelation[]
  legacyV1Verified: number
  legacyV2Verified: number
  jsonbVectorBytes: {
    direct: number
    exactMoneyBoundary: number
    canonicalCeilingCanonical: number
    canonicalCeilingJsonb: number
    canonicalToJsonbExpansion: number
    canonicalCeilingJsonbMargin: number
  }
  addDurationMs: number
  validationDurationMs: number
  rollbackFinalDurationMs: number
  rollbackExpandOnlyDurationMs: number
  rollbackPrismaLedgerDurationMs: number
  pendingConstraintsUnvalidated: string[]
}

interface DisposableDatabase {
  admin: Client
  client: Client
  name: string
  url: string
}

interface ExactMoneyBoundaryVector {
  offer: CommercialQuoteV3Authorities['offer']
  quote: EmittedCommercialQuoteV3
}

function exactMoneyBoundaryVector(): ExactMoneyBoundaryVector {
  const offerSource: CommercialOfferSnapshotV3 = {
    schemaVersion: 3,
    contractVersion: '3.0.0',
    campaignVersionId: 'commercial-offer-version-boundary-v3',
    campaignCode: 'BOUNDARY_V3',
    version: 1,
    status: 'ACTIVE',
    publishedAt: '2026-08-01T06:00:00.000Z',
    claimStartsAt: '2026-08-01T06:00:00.000Z',
    claimEndsAt: '2026-09-01T06:00:00.000Z',
    benefits: Array.from({ length: 50 }, (_, index) => {
      const suffix = index.toString().padStart(2, '0')
      const catalogKey = `BOUNDARY_SKU_${suffix}`
      return {
        benefitCode: `BOUNDARY_BENEFIT_${suffix}`,
        kind: 'HARDWARE_PERCENT_OFF' as const,
        skuSnapshot: {
          catalogKey,
          catalogContentHash: createHash('sha256').update(catalogKey).digest('hex'),
          brand: 'Avoqado',
          model: suffix,
          name: `Boundary ${suffix}`,
          listUnitAmountMinor: MAX_UNIT_AMOUNT_MINOR.toString(),
          currency: 'MXN' as const,
          taxRateBasisPoints: 1600 as const,
        },
        percentBasisPoints: 1,
        quantityLimit: 1000,
        benefitStartsAt: '2026-08-20T06:00:00.000Z',
        benefitEndsAt: '2026-08-25T06:00:00.000Z',
      }
    }),
  }
  const emittedOffer = emitCommercialOfferV3(offerSource)
  const offer: CommercialQuoteV3Authorities['offer'] = {
    rowSchemaVersion: 3,
    snapshot: emittedOffer.snapshot,
    checksum: emittedOffer.checksum,
    rowContext: {
      id: emittedOffer.snapshot.campaignVersionId,
      campaignCode: emittedOffer.snapshot.campaignCode,
      sourceRevision: emittedOffer.snapshot.version,
      schemaVersion: 3,
      publishedAt: new Date(emittedOffer.snapshot.publishedAt),
    },
  }
  decodeAndVerifyStoredCommercialOfferV3(offer)
  const evaluation = evaluateCommercialQuoteV3({
    authorities: { catalog: catalogV2Authority, offer },
    saasSelections: [],
    hardwareSelections: offer.snapshot.benefits.map(benefit => {
      if (benefit.kind !== 'HARDWARE_PERCENT_OFF') throw new Error('EXPECTED_BOUNDARY_HARDWARE_BENEFIT')
      return { catalogKey: benefit.skuSnapshot.catalogKey, quantity: 1000 }
    }),
    rateBlockers: [],
    resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
  })
  const quote = buildCommercialQuoteV3({
    quoteId: 'commercial-quote-v3-exact-money-boundary',
    subject: {
      kind: 'VENUE',
      organizationId: 'organization-direct-v3',
      venueId: 'venue-direct-v3',
      actorId: 'staff-direct-v3',
    },
    acquisitionContextId: null,
    derivedFromPreview: null,
    quotedAt: new Date('2026-08-15T12:00:00.000Z'),
    expiresAt: new Date('2026-08-15T12:15:00.000Z'),
    evaluation,
    authorities: { catalog: catalogV2Authority, offer, acquisitionContext: null },
  })
  return { offer, quote }
}

function canonicalCeilingMaxStructureVector(): Record<string, any> {
  const value = structuredClone(quoteV3Fixture)
  const maxCode = `C${'X'.repeat(63)}`
  const maxLineKey = 'l'.repeat(128)
  const maxId = 'i'.repeat(128)
  const maxMinor = '9'.repeat(19)
  const origin = {
    kind: 'CAMPAIGN',
    sourceCode: maxCode,
    sourceId: maxId,
    lineKey: maxLineKey,
  }
  value.quoteId = maxId
  value.subject = { kind: 'VENUE', organizationId: maxId, venueId: maxId, actorId: maxId }
  value.catalogPublicationId = maxId
  value.offerVersionId = maxId
  value.offerCode = maxCode
  value.saasLines = Array.from({ length: 50 }, (_, lineIndex) => {
    const line = structuredClone(value.saasLines[0])
    const suffix = lineIndex.toString().padStart(2, '0')
    line.lineKey = `${'l'.repeat(126)}${suffix}`
    line.targetType = 'BUNDLE'
    line.targetCode = maxCode
    line.priceCode = maxCode
    line.quantity = 1000
    line.productKind = 'BUNDLE'
    line.name = 'n'.repeat(120)
    line.billingUnit = 'VENUE_MONTH'
    line.listUnitAmountMinor = maxMinor
    line.listSubtotalMinor = maxMinor
    line.appliedOfferSteps = Array.from({ length: 10 }, (_, index) => ({
      ...structuredClone(line.appliedOfferSteps[0]),
      benefitCode: maxCode,
      ruleCode: maxCode,
      type: 'BUNDLE_PRICE',
      position: index + 1,
      inputAmountMinor: maxMinor,
      discountAmountMinor: maxMinor,
      outputAmountMinor: maxMinor,
      cycles: 120,
    }))
    line.discountMinor = maxMinor
    line.subtotalMinor = maxMinor
    line.taxMinor = maxMinor
    line.totalMinor = maxMinor
    line.promotionalCycles = 120
    line.renewalSubtotalMinor = maxMinor
    line.renewalTaxMinor = maxMinor
    line.renewalTotalMinor = maxMinor
    return line
  })
  value.hardwareLines = []
  value.entitlementGrants = Array.from({ length: 128 }, () => ({
    capabilityCode: maxCode,
    capabilityKind: 'FEATURE',
    origins: Array.from({ length: 32 }, () => structuredClone(origin)),
    activationRequirement: { mode: 'VENUE_SETTING', settingKey: maxLineKey, defaultState: 'OFF' },
  }))
  value.resolution.applied = Array.from({ length: 600 }, () => ({
    subjectKind: 'SAAS_LINE',
    subjectKey: 's'.repeat(128),
    benefitCode: maxCode,
    ruleCode: maxCode,
  }))
  value.resolution.exclusions = Array.from({ length: 5050 }, () => ({
    subjectKind: 'SAAS_LINE',
    subjectKey: 's',
    benefitCode: 'CX',
    ruleCode: 'CX',
    accountingEffect: 'EXPLANATORY',
    reasonCode: 'SAAS_STACKING_NOT_ALLOWED',
  }))
  value.resolution.campaignVersionId = maxId
  for (const breakdown of [value.totals.recurringCurrent, value.totals.oneTime, value.totals.dueNow, value.renewal]) {
    breakdown.listSubtotalMinor = maxMinor
    breakdown.discountMinor = maxMinor
    breakdown.subtotalMinor = maxMinor
    breakdown.taxMinor = maxMinor
    breakdown.totalMinor = maxMinor
  }

  // Exercise the maximum runtime structure (50 total lines, every bounded
  // collection at max cardinality), then consume the canonical 3 MiB budget
  // exactly through schema-valid subject keys. This measures canonical bytes
  // and PostgreSQL jsonb::text bytes independently instead of inferring one
  // representation from the other.
  const normalized = cloneJson(value)
  const baseBytes = canonicalJsonBytesV2(normalized).byteLength
  const availableSubjectBytes = COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES - baseBytes
  const maxAdditionalSubjectBytes = normalized.resolution.exclusions.length * 127
  if (availableSubjectBytes < 0 || availableSubjectBytes > maxAdditionalSubjectBytes) {
    throw new Error(`COMMERCIAL_QUOTE_V3_CANONICAL_CEILING_VECTOR_UNREPRESENTABLE:${baseBytes}:${availableSubjectBytes}`)
  }
  const commonExtra = Math.floor(availableSubjectBytes / normalized.resolution.exclusions.length)
  const remainder = availableSubjectBytes % normalized.resolution.exclusions.length
  normalized.resolution.exclusions.forEach((exclusion: Record<string, any>, index: number) => {
    exclusion.subjectKey = 's'.repeat(1 + commonExtra + (index < remainder ? 1 : 0))
  })
  return normalized
}

const exactBoundary = exactMoneyBoundaryVector()

function safeMaintenanceTarget(raw: string | undefined): { raw: string; config: ClientConfig } {
  if (!raw?.trim()) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_URL_REQUIRED')
  const url = new URL(raw)
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_PROTOCOL_REJECTED')
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_MUST_BE_LOCAL')
  }
  if (!url.pathname.slice(1)) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NAME_REQUIRED')
  return { raw, config: { connectionString: raw } }
}

function quoteIdentifier(value: string): string {
  if (!/^avoqado_quote_v3_[a-z0-9_]+$/.test(value)) {
    throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NAME_REJECTED')
  }
  return `"${value}"`
}

function databaseUrl(maintenanceUrl: string, databaseName: string): string {
  const url = new URL(maintenanceUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

async function createDisposableDatabase(): Promise<DisposableDatabase> {
  const target = safeMaintenanceTarget(process.env.TEST_DATABASE_URL)
  const name = `avoqado_quote_v3_${process.pid}_${randomBytes(6).toString('hex')}`
  const admin = new Client(target.config)
  await admin.connect()
  const collision = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  if (collision.rowCount) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_COLLISION')
  await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`)

  const client = new Client({ connectionString: databaseUrl(target.raw, name) })
  await client.connect()
  return { admin, client, name, url: databaseUrl(target.raw, name) }
}

async function cleanupDisposableDatabase(database: DisposableDatabase): Promise<void> {
  await database.client.end().catch(() => undefined)
  await database.admin.query(`DROP DATABASE ${quoteIdentifier(database.name)} WITH (FORCE)`).catch(() => undefined)
  await database.admin.end().catch(() => undefined)
}

async function installCurrentChain(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE "Staff" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "Organization" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "Venue" (
      "id" TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "Venue_id_organizationId_key" UNIQUE ("id", "organizationId")
    );
  `)
  for (const migration of currentChain) {
    const sql = readFileSync(path.join(repoRoot, 'prisma/migrations', migration, 'migration.sql'), 'utf8')
    await client.query(sql)
  }
}

async function applyMigrations(client: Client, migrations: readonly string[]): Promise<void> {
  for (const migration of migrations) {
    const sql = readFileSync(path.join(repoRoot, 'prisma/migrations', migration, 'migration.sql'), 'utf8')
    await client.query(sql)
  }
}

async function seedMeasuredCurrentChain(
  client: Client,
): Promise<
  Omit<
    MigrationReceipt,
    | 'addDurationMs'
    | 'validationDurationMs'
    | 'rollbackFinalDurationMs'
    | 'rollbackExpandOnlyDurationMs'
    | 'rollbackPrismaLedgerDurationMs'
    | 'pendingConstraintsUnvalidated'
  >
> {
  await client.query(
    `INSERT INTO "Staff" ("id") VALUES
      ('staff-publisher-v3'), ('staff-direct-v3'), ('staff-pos-50-v2')`,
  )
  await client.query(
    `INSERT INTO "Organization" ("id") VALUES
      ('organization-direct-v3'), ('organization-other-v3'), ('organization-pos-50-v2')`,
  )
  await client.query(
    `INSERT INTO "Venue" ("id", "organizationId") VALUES
      ('venue-direct-v3', 'organization-direct-v3'),
      ('venue-other-v3', 'organization-other-v3'),
      ('venue-pos-50-v2', 'organization-pos-50-v2')`,
  )

  await client.query(`
    INSERT INTO "CommercialDraft" (
      "id", "sourceKey", "name", "revision", "createdById", "updatedById", "updatedAt"
    ) VALUES (
      'catalog-draft-quote-v3', 'catalog-draft-quote-v3', 'Catalog Quote v3', 2,
      'staff-publisher-v3', 'staff-publisher-v3', CURRENT_TIMESTAMP
    )
  `)
  await client.query(
    `INSERT INTO "CommercialPublication" (
      "id", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById"
    ) VALUES
      ($1, 'catalog-draft-quote-v3', 1, 1, '{"schemaVersion":1}'::jsonb, $2, 'legacy catalog', 'staff-publisher-v3'),
      ($3, 'catalog-draft-quote-v3', 2, 2, '{"schemaVersion":2}'::jsonb, $4, 'catalog v2', 'staff-publisher-v3')`,
    [quoteV1Fixture.catalogPublicationId, '1'.repeat(64), quoteV3Fixture.catalogPublicationId, quoteV3Fixture.catalogChecksum],
  )

  await client.query(`
    INSERT INTO "CommercialCampaignDraft" (
      "id", "code", "name", "revision", "offerSchemaVersion", "startsAt", "endsAt",
      "allowedRuleCodeGroups", "stackingGroups", "createdById", "updatedById", "updatedAt"
    ) VALUES
      ('campaign-draft-pos50', 'POS_50', 'POS 50', 1, 2,
       '2026-08-01T00:00:00.000', '2026-09-30T00:00:00.000', '[]'::jsonb, NULL,
       'staff-publisher-v3', 'staff-publisher-v3', CURRENT_TIMESTAMP),
      ('offer-draft-summer', 'SUMMER_2026', 'Summer 2026', 1, 3,
       '2026-08-01T00:00:00.000', '2026-09-30T00:00:00.000', NULL, '[]'::jsonb,
       'staff-publisher-v3', 'staff-publisher-v3', CURRENT_TIMESTAMP)
  `)
  await client.query(
    `INSERT INTO "CommercialCampaignVersion" (
      "id", "campaignCode", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById"
    ) VALUES
      ($1, 'POS_50', 'campaign-draft-pos50', 1, 1, '{"schemaVersion":1}'::jsonb, $2, 'legacy campaign', 'staff-publisher-v3'),
      ($3, 'POS_50', 'campaign-draft-pos50', 1, 2, '{"schemaVersion":2}'::jsonb, $4, 'campaign v2', 'staff-publisher-v3'),
      ($5, 'SUMMER_2026', 'offer-draft-summer', 1, 3, $6::jsonb, $7, 'offer v3', 'staff-publisher-v3')`,
    [
      quoteV1Fixture.campaignVersionId,
      '2'.repeat(64),
      quoteV2Fixture.campaignVersionId,
      '3'.repeat(64),
      quoteV3Fixture.offerVersionId,
      JSON.stringify(offerV3Fixture),
      quoteV3Fixture.offerChecksum,
    ],
  )
  await client.query(
    `INSERT INTO "CommercialAcquisitionContext" (
      "id", "tokenHash", "campaignVersionId", "channel", "attribution", "createdAt", "expiresAt"
    ) VALUES ($1, $2, $3, 'DIRECT', '{}'::jsonb, '2026-08-24T12:00:00.000', '2026-08-31T12:00:00.000')`,
    [quoteV2Fixture.acquisitionContextId, '4'.repeat(64), quoteV2Fixture.campaignVersionId],
  )

  await client.query(
    `INSERT INTO "CommercialQuote" (
      "id", "catalogPublicationId", "campaignVersionId", "schemaVersion", "market", "currency", "snapshot", "checksum",
      "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
      "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
    )
    SELECT
      'legacy-v1-' || value,
      $1,
      $2,
      1,
      'MX',
      'MXN',
      jsonb_set($3::jsonb, '{quoteId}', to_jsonb('legacy-v1-' || value)),
      md5('legacy-v1-' || value) || md5('legacy-v1-' || value),
      24900, 19900, 5000, 800, 5800, 24900, 3984, 28884,
      '2026-08-22T12:00:00.000', '2026-08-22T12:30:00.000'
    FROM generate_series(1, 1500) AS values(value)`,
    [quoteV1Fixture.catalogPublicationId, quoteV1Fixture.campaignVersionId, JSON.stringify(quoteV1Fixture)],
  )
  await client.query(
    `INSERT INTO "CommercialQuote" (
      "id", "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
      "schemaVersion", "market", "currency", "snapshot", "checksum",
      "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
      "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
    )
    SELECT
      'legacy-v2-' || value,
      $1, $2, $3, $4, $5, $6,
      2, 'MX', 'MXN',
      jsonb_set($7::jsonb, '{quoteId}', to_jsonb('legacy-v2-' || value)),
      md5('legacy-v2-' || value) || md5('legacy-v2-' || value),
      24900, 19900, 5000, 800, 5800, 24900, 3984, 28884,
      '2026-08-24T12:10:00.000', '2026-08-24T12:25:00.000'
    FROM generate_series(1, 500) AS values(value)`,
    [
      quoteV2Fixture.catalogPublicationId,
      quoteV2Fixture.campaignVersionId,
      quoteV2Fixture.acquisitionContextId,
      quoteV2Fixture.subject.organizationId,
      quoteV2Fixture.subject.venueId,
      quoteV2Fixture.subject.actorId,
      JSON.stringify(quoteV2Fixture),
    ],
  )

  const relations = await client.query<{ relation: string; rows: string; total_bytes: string }>(`
    SELECT 'CommercialQuote' AS relation, count(*)::text AS rows,
           pg_total_relation_size('"CommercialQuote"')::text AS total_bytes
    FROM "CommercialQuote"
    UNION ALL
    SELECT 'CommercialCampaignVersion', count(*)::text,
           pg_total_relation_size('"CommercialCampaignVersion"')::text
    FROM "CommercialCampaignVersion"
    UNION ALL
    SELECT 'CommercialAcquisitionContext', count(*)::text,
           pg_total_relation_size('"CommercialAcquisitionContext"')::text
    FROM "CommercialAcquisitionContext"
    ORDER BY relation
  `)
  const verified = await client.query<{ v1: string; v2: string }>(`
    SELECT
      count(*) FILTER (
        WHERE "schemaVersion" = 1 AND public.commercial_quote_snapshot_matches_v1_row(
          "snapshot", "id", "market", "currency", "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
          "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor"
        )
      )::text AS v1,
      count(*) FILTER (
        WHERE "schemaVersion" = 2 AND public.commercial_quote_snapshot_matches_v2_row(
          "snapshot", "id", "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
          "market", "currency", "quotedAt", "expiresAt", "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
          "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor"
        )
      )::text AS v2
    FROM "CommercialQuote"
  `)
  const canonicalCeiling = canonicalCeilingMaxStructureVector()
  const canonicalCeilingCanonicalBytes = canonicalJsonBytesV2(canonicalCeiling).byteLength
  const vectorBytes = await client.query<{
    directBytes: number
    exactMoneyBoundaryBytes: number
    canonicalCeilingJsonbBytes: number
  }>(
    `SELECT
       octet_length($1::jsonb::text) AS "directBytes",
       octet_length($2::jsonb::text) AS "exactMoneyBoundaryBytes",
       octet_length($3::jsonb::text) AS "canonicalCeilingJsonbBytes"`,
    [JSON.stringify(quoteV3Fixture), JSON.stringify(exactBoundary.quote.snapshot), JSON.stringify(canonicalCeiling)],
  )
  const canonicalCeilingJsonbBytes = Number(vectorBytes.rows[0].canonicalCeilingJsonbBytes)
  return {
    relations: relations.rows.map(row => ({
      relation: row.relation,
      rows: Number(row.rows),
      totalBytes: Number(row.total_bytes),
    })),
    legacyV1Verified: Number(verified.rows[0].v1),
    legacyV2Verified: Number(verified.rows[0].v2),
    jsonbVectorBytes: {
      direct: Number(vectorBytes.rows[0].directBytes),
      exactMoneyBoundary: Number(vectorBytes.rows[0].exactMoneyBoundaryBytes),
      canonicalCeilingCanonical: canonicalCeilingCanonicalBytes,
      canonicalCeilingJsonb: canonicalCeilingJsonbBytes,
      canonicalToJsonbExpansion: canonicalCeilingJsonbBytes - canonicalCeilingCanonicalBytes,
      canonicalCeilingJsonbMargin: 4_194_304 - canonicalCeilingJsonbBytes,
    },
  }
}

function quoteChecksum(id: string, snapshot: Record<string, any>): string {
  return createHash('sha256')
    .update(`${id}:${JSON.stringify(snapshot)}`)
    .digest('hex')
}

async function insertBoundaryOfferV3(client: Client, offer: CommercialQuoteV3Authorities['offer']): Promise<void> {
  await client.query(
    `INSERT INTO "CommercialCampaignDraft" (
      "id", "code", "name", "revision", "offerSchemaVersion", "startsAt", "endsAt",
      "allowedRuleCodeGroups", "stackingGroups", "createdById", "updatedById", "updatedAt"
    ) VALUES ($1, $2, 'Quote v3 exact money boundary', 1, 3,
      '2026-08-01T00:00:00.000', '2026-09-30T00:00:00.000', NULL, '[]'::jsonb,
      'staff-publisher-v3', 'staff-publisher-v3', CURRENT_TIMESTAMP)`,
    [`${offer.snapshot.campaignVersionId}-draft`, offer.snapshot.campaignCode],
  )
  await client.query(
    `INSERT INTO "CommercialCampaignVersion" (
      "id", "campaignCode", "sourceDraftId", "sourceRevision", "schemaVersion", "snapshot", "checksum", "reason", "publishedById"
    ) VALUES ($1, $2, $3, 1, 3, $4::jsonb, $5, 'exact money boundary', 'staff-publisher-v3')`,
    [
      offer.snapshot.campaignVersionId,
      offer.snapshot.campaignCode,
      `${offer.snapshot.campaignVersionId}-draft`,
      JSON.stringify(offer.snapshot),
      offer.checksum,
    ],
  )
}

async function insertQuoteV3(
  client: Client,
  snapshotInput: Record<string, any>,
  options: {
    id?: string
    campaignVersionId?: string | null
    offerVersionId?: string | null
    offerSchemaVersion?: number | null
    acquisitionContextId?: string | null
    organizationId?: string | null
    venueId?: string | null
    createdById?: string | null
    listSubtotalMinor?: string
    discountMinor?: string
    subtotalMinor?: string
    taxMinor?: string
    totalMinor?: string
    renewalSubtotalMinor?: string
    renewalTaxMinor?: string
    renewalTotalMinor?: string
    checksum?: string
  } = {},
): Promise<void> {
  const snapshot = structuredClone(snapshotInput)
  const id = options.id ?? snapshot.quoteId
  snapshot.quoteId = id
  const dueNow = snapshot.totals.dueNow
  const renewal = snapshot.renewal
  await client.query(
    `INSERT INTO "CommercialQuote" (
      "id", "catalogPublicationId", "campaignVersionId", "offerVersionId", "offerSchemaVersion", "acquisitionContextId",
      "organizationId", "venueId", "createdById", "schemaVersion", "market", "currency", "snapshot", "checksum",
      "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
      "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, 3, 'MX', 'MXN', $10::jsonb, $11,
      $12::bigint, $13::bigint, $14::bigint, $15::bigint, $16::bigint,
      $17::bigint, $18::bigint, $19::bigint, $20::timestamp, $21::timestamp
    )`,
    [
      id,
      snapshot.catalogPublicationId,
      options.campaignVersionId ?? null,
      options.offerVersionId === undefined ? snapshot.offerVersionId : options.offerVersionId,
      options.offerSchemaVersion === undefined ? 3 : options.offerSchemaVersion,
      options.acquisitionContextId === undefined ? snapshot.acquisitionContextId : options.acquisitionContextId,
      options.organizationId === undefined ? snapshot.subject.organizationId : options.organizationId,
      options.venueId === undefined ? snapshot.subject.venueId : options.venueId,
      options.createdById === undefined ? snapshot.subject.actorId : options.createdById,
      JSON.stringify(snapshot),
      options.checksum ?? quoteChecksum(id, snapshot),
      options.listSubtotalMinor ?? dueNow.listSubtotalMinor,
      options.discountMinor ?? dueNow.discountMinor,
      options.subtotalMinor ?? dueNow.subtotalMinor,
      options.taxMinor ?? dueNow.taxMinor,
      options.totalMinor ?? dueNow.totalMinor,
      options.renewalSubtotalMinor ?? renewal.subtotalMinor,
      options.renewalTaxMinor ?? renewal.taxMinor,
      options.renewalTotalMinor ?? renewal.totalMinor,
      snapshot.quotedAt.replace('Z', ''),
      snapshot.expiresAt.replace('Z', ''),
    ],
  )
}

function createLabQuoteAcceptanceService(client: Client, checkoutMode: 'OFF' | 'ACTIVE' = 'ACTIVE') {
  return createCommercialQuoteAcceptanceService({
    assertCheckoutAllowed: () => assertCommercialV2CheckoutActive(checkoutMode),
    now: () => new Date('2026-08-15T12:10:00.000Z'),
    randomId: () => 'acceptance-q3a-direct-lab',
    async runInTransaction(operation) {
      await client.query('BEGIN')
      try {
        const result = await operation({
          async lockQuote(id) {
            const selected = await client.query<{
              id: string
              organizationId: string | null
              venueId: string | null
              schemaVersion: number
              offerVersionId: string | null
              catalogPublicationId: string
              campaignVersionId: string | null
              expiresAt: Date
            }>(
              `SELECT "id", "organizationId", "venueId", "schemaVersion", "offerVersionId",
                      "catalogPublicationId", "campaignVersionId", "expiresAt"
                 FROM "CommercialQuote"
                WHERE "id" = $1
                FOR UPDATE`,
              [id],
            )
            return selected.rows[0] ?? null
          },
          async findAcceptanceByQuoteId(quoteId) {
            const selected = await client.query(
              `SELECT "id", "quoteId", "idempotencyKey", "organizationId", "venueId", "acceptedById", "status", "revision", "acceptedAt"
                 FROM "CommercialQuoteAcceptance"
                WHERE "quoteId" = $1`,
              [quoteId],
            )
            return (selected.rows[0] as any) ?? null
          },
          isQuoteAuthorityCurrent: async () => true,
          async createAcceptance(input) {
            const inserted = await client.query(
              `INSERT INTO "CommercialQuoteAcceptance" (
                 "id", "quoteId", "idempotencyKey", "organizationId", "venueId", "acceptedById", "acceptedAt", "updatedAt"
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
               RETURNING "id", "quoteId", "idempotencyKey", "organizationId", "venueId", "acceptedById", "status", "revision", "acceptedAt"`,
              [
                input.id,
                input.quoteId,
                input.idempotencyKey,
                input.organizationId,
                input.venueId,
                input.acceptedById,
                input.acceptedAt,
              ],
            )
            return inserted.rows[0] as any
          },
          writeAudit: async () => undefined,
        })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    },
  })
}

async function expectSqlCode(
  operation: Promise<unknown>,
  expectedCodes: readonly string[],
  expectedDetails: { constraint?: string; messageIncludes?: string } = {},
): Promise<void> {
  try {
    await operation
  } catch (error) {
    const failure = error as { code?: string; constraint?: string; message?: string }
    expect(expectedCodes).toContain(failure.code)
    if (expectedDetails.constraint) expect(failure.constraint).toBe(expectedDetails.constraint)
    if (expectedDetails.messageIncludes) expect(failure.message).toContain(expectedDetails.messageIncludes)
    return
  }
  throw new Error(`EXPECTED_SQL_REJECTION:${expectedCodes.join('|')}`)
}

async function rollbackQuoteV3BeforeEvidence(client: Client): Promise<void> {
  await client.query(readFileSync(path.join(repoRoot, 'docs/runbooks/sql/commercial-quote-v3-pre-evidence-rollback.sql'), 'utf8'))
}

async function expectPopulatedLegacyFixture(client: Client): Promise<void> {
  const counts = await client.query<{ total: string; v1: string; v2: string; verifiedV1: string; verifiedV2: string }>(`
    SELECT
      count(*)::text AS total,
      count(*) FILTER (WHERE "schemaVersion" = 1)::text AS v1,
      count(*) FILTER (WHERE "schemaVersion" = 2)::text AS v2,
      count(*) FILTER (
        WHERE "schemaVersion" = 1 AND public.commercial_quote_snapshot_matches_v1_row(
          "snapshot", "id", "market", "currency", "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
          "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor"
        )
      )::text AS "verifiedV1",
      count(*) FILTER (
        WHERE "schemaVersion" = 2 AND public.commercial_quote_snapshot_matches_v2_row(
          "snapshot", "id", "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
          "market", "currency", "quotedAt", "expiresAt", "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
          "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor"
        )
      )::text AS "verifiedV2"
    FROM "CommercialQuote"
  `)
  expect(counts.rows).toEqual([{ total: '2000', v1: '1500', v2: '500', verifiedV1: '1500', verifiedV2: '500' }])
}

async function expectLegacyRegressionAfterRollback(client: Client, suffix: string): Promise<void> {
  await expectPopulatedLegacyFixture(client)
  const immutableTrigger = await client.query<{ tgenabled: string }>(`
    SELECT tgenabled
      FROM pg_trigger
     WHERE tgrelid = '"CommercialQuote"'::regclass
       AND tgname = 'commercial_quote_immutable'
  `)
  expect(immutableTrigger.rows).toEqual([{ tgenabled: 'O' }])

  const v1 = structuredClone(quoteV1Fixture)
  v1.quoteId = `post-rollback-${suffix}-v1`
  await client.query(
    `INSERT INTO "CommercialQuote" (
      "id", "catalogPublicationId", "campaignVersionId", "schemaVersion", "market", "currency", "snapshot", "checksum",
      "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
      "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
    ) VALUES ($1, $2, $3, 1, 'MX', 'MXN', $4::jsonb, $5,
      24900, 19900, 5000, 800, 5800, 24900, 3984, 28884,
      '2026-08-22T12:00:00.000', '2026-08-22T12:30:00.000')`,
    [v1.quoteId, v1.catalogPublicationId, v1.campaignVersionId, JSON.stringify(v1), quoteChecksum(v1.quoteId, v1)],
  )

  const v2 = structuredClone(quoteV2Fixture)
  v2.quoteId = `post-rollback-${suffix}-v2`
  await client.query(
    `INSERT INTO "CommercialQuote" (
      "id", "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
      "schemaVersion", "market", "currency", "snapshot", "checksum",
      "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
      "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 2, 'MX', 'MXN', $8::jsonb, $9,
      24900, 19900, 5000, 800, 5800, 24900, 3984, 28884,
      '2026-08-24T12:10:00.000', '2026-08-24T12:25:00.000')`,
    [
      v2.quoteId,
      v2.catalogPublicationId,
      v2.campaignVersionId,
      v2.acquisitionContextId,
      v2.subject.organizationId,
      v2.subject.venueId,
      v2.subject.actorId,
      JSON.stringify(v2),
      quoteChecksum(v2.quoteId, v2),
    ],
  )

  const invalid = structuredClone(v1)
  invalid.quoteId = `post-rollback-${suffix}-invalid-v1`
  await expectSqlCode(
    client.query(
      `INSERT INTO "CommercialQuote" (
        "id", "catalogPublicationId", "campaignVersionId", "schemaVersion", "market", "currency", "snapshot", "checksum",
        "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
        "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
      ) VALUES ($1, $2, $3, 1, 'MX', 'MXN', $4::jsonb, $5,
        24900, 19900, 5000, 800, 5801, 24900, 3984, 28884,
        '2026-08-22T12:00:00.000', '2026-08-22T12:30:00.000')`,
      [invalid.quoteId, invalid.catalogPublicationId, invalid.campaignVersionId, JSON.stringify(invalid), quoteChecksum(invalid.quoteId, invalid)],
    ),
    ['23514'],
    { constraint: 'CommercialQuote_snapshot_totals_check' },
  )
}

async function legacyQuoteConstraintDefinitions(client: Client): Promise<Array<{ conname: string; definition: string }>> {
  const result = await client.query<{ conname: string; definition: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = '"CommercialQuote"'::regclass
        AND conname = ANY($1::text[])
      ORDER BY conname`,
    [legacyQuoteConstraintNames],
  )
  expect(result.rows).toHaveLength(legacyQuoteConstraintNames.length)
  return result.rows
}

async function waitForBackendLock(observer: Client, backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await observer.query<{ wait_event_type: string | null }>(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
      [backendPid],
    )
    if (state.rows[0]?.wait_event_type === 'Lock') return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('COMMERCIAL_QUOTE_V3_ROLLBACK_DID_NOT_WAIT_FOR_CONCURRENT_WRITER')
}

function createQuoteV3PrismaMigrationFixture(): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'avoqado-quote-v3-prisma-'))
  const migrationsRoot = path.join(fixtureRoot, 'migrations')
  mkdirSync(migrationsRoot)
  writeFileSync(
    path.join(fixtureRoot, 'schema.prisma'),
    `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`,
    { mode: 0o600 },
  )
  writeFileSync(path.join(migrationsRoot, 'migration_lock.toml'), 'provider = "postgresql"\n', { mode: 0o600 })
  const baselineDestination = path.join(migrationsRoot, quoteV3PrismaBaseline)
  mkdirSync(baselineDestination)
  writeFileSync(
    path.join(baselineDestination, 'migration.sql'),
    '-- The integration harness installs the exact pre-Quote-v3 current chain before Prisma records this baseline.\n',
    { mode: 0o600 },
  )
  for (const migration of quoteV3Migrations) {
    const destination = path.join(migrationsRoot, migration)
    mkdirSync(destination)
    copyFileSync(path.join(repoRoot, 'prisma/migrations', migration, 'migration.sql'), path.join(destination, 'migration.sql'))
  }
  return fixtureRoot
}

function runPrismaMigrationCommand(databaseUrl: string, fixtureRoot: string, args: string[]): void {
  const result = spawnSync(
    path.join(repoRoot, 'node_modules/.bin/prisma'),
    [...args, '--schema', path.join(fixtureRoot, 'schema.prisma')],
    {
      // The repository-level prisma.config.ts pins the production migration
      // directory. Run from the isolated fixture so this test sees only the
      // two Quote-v3 migrations copied from their canonical source files.
      cwd: fixtureRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      timeout: 120_000,
    },
  )
  if (result.error || result.status !== 0) {
    throw new Error(
      `COMMERCIAL_QUOTE_V3_PRISMA_COMMAND_FAILED:${args.join(':')}:${result.status ?? 'NO_STATUS'}:${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    )
  }
}

function prismaMigrateDeploy(databaseUrl: string, fixtureRoot: string): void {
  runPrismaMigrationCommand(databaseUrl, fixtureRoot, ['migrate', 'deploy'])
}

function prismaMigrateResolveBaseline(databaseUrl: string, fixtureRoot: string): void {
  runPrismaMigrationCommand(databaseUrl, fixtureRoot, ['migrate', 'resolve', '--applied', quoteV3PrismaBaseline])
}

function prismaMigrationParity(databaseUrl: string): { status: number; output: string } {
  const result = spawnSync(
    path.join(repoRoot, 'node_modules/.bin/prisma'),
    [
      'migrate',
      'diff',
      '--from-migrations',
      'prisma/migrations',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--shadow-database-url',
      databaseUrl,
      '--exit-code',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  const output = `${result.stdout}${result.stderr}`.split(databaseUrl).join('[REDACTED_DATABASE_URL]')
  if (result.error || ![0, 2].includes(result.status ?? -1)) {
    throw new Error(
      `COMMERCIAL_QUOTE_V3_PRISMA_PARITY_FAILED:${result.status ?? 'NO_STATUS'}:${result.error?.message ?? ''}:${output.slice(-2_000)}`,
    )
  }
  return { status: result.status as number, output }
}

describe('Commercial Quote v3 PostgreSQL migration', () => {
  let database: DisposableDatabase | undefined
  let receipt: MigrationReceipt | undefined

  beforeAll(async () => {
    database = await createDisposableDatabase()
    await installCurrentChain(database.client)
    const baseline = await seedMeasuredCurrentChain(database.client)
    const addStartedAt = performance.now()
    await applyMigrations(database.client, [quoteV3Migrations[0]])
    const addDurationMs = performance.now() - addStartedAt
    const pending = await database.client.query<{ conname: string; convalidated: boolean }>(`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conrelid = '"CommercialQuote"'::regclass
        AND (conname LIKE '%_pending' OR conname = 'CommercialQuote_offerVersionId_offerSchemaVersion_fkey')
      ORDER BY conname
    `)
    const validationStartedAt = performance.now()
    await applyMigrations(database.client, [quoteV3Migrations[1]])
    const validationDurationMs = performance.now() - validationStartedAt
    receipt = {
      ...baseline,
      addDurationMs,
      validationDurationMs,
      rollbackFinalDurationMs: 0,
      rollbackExpandOnlyDurationMs: 0,
      rollbackPrismaLedgerDurationMs: 0,
      pendingConstraintsUnvalidated: pending.rows.filter(row => !row.convalidated).map(row => row.conname),
    }
  })

  afterAll(async () => {
    if (!database) return
    let captureError: Error | undefined
    if (receipt) {
      const renderedReceipt = `COMMERCIAL_QUOTE_V3_PREFLIGHT_RECEIPT ${JSON.stringify({
        databaseKind: 'SYNTHETIC_DISPOSABLE',
        ...receipt,
      })}`
      console.log(renderedReceipt)
      if (process.env.COMMERCIAL_QUOTE_V3_CAPTURE_PREFLIGHT === '1') captureError = new Error(renderedReceipt)
    }
    await cleanupDisposableDatabase(database)
    if (captureError) throw captureError
  })

  it('adds the Quote-v3 authority columns and Offer control ledger', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    const columns = await database.client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'CommercialQuote'
        AND column_name IN ('offerVersionId', 'offerSchemaVersion')
      ORDER BY column_name
    `)
    const controlLedger = await database.client.query<{ present: boolean }>(`
      SELECT to_regclass('public."CommercialOfferControlEvent"') IS NOT NULL AS present
    `)

    expect(columns.rows.map(row => row.column_name)).toEqual(['offerSchemaVersion', 'offerVersionId'])
    expect(controlLedger.rows[0].present).toBe(true)
  })

  it('records a synthetic baseline and keeps every measured v1/v2 row valid', async () => {
    expect(receipt).toBeDefined()
    expect(receipt?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: 'CommercialQuote', rows: 2000 }),
        expect.objectContaining({ relation: 'CommercialCampaignVersion', rows: 3 }),
        expect.objectContaining({ relation: 'CommercialAcquisitionContext', rows: 1 }),
      ]),
    )
    expect(receipt?.relations.every(relation => relation.totalBytes > 0)).toBe(true)
    expect(receipt?.legacyV1Verified).toBe(1500)
    expect(receipt?.legacyV2Verified).toBe(500)
    expect(receipt?.pendingConstraintsUnvalidated).toHaveLength(9)
    expect(receipt?.addDurationMs).toBeLessThan(30_000)
    expect(receipt?.validationDurationMs).toBeLessThan(30_000)
  })

  it('leaves every Quote constraint validated and preserves all immutable and operational barriers', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    const constraints = await database.client.query<{ conname: string; convalidated: boolean }>(`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conrelid = '"CommercialQuote"'::regclass
      ORDER BY conname
    `)
    const triggers = await database.client.query<{ tgname: string }>(`
      SELECT tgname
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN (
          'commercial_campaign_version_immutable',
          'commercial_publication_immutable_update',
          'commercial_publication_immutable_delete',
          'commercial_quote_immutable',
          'commercial_campaign_activation_reject_offer_v3',
          'commercial_campaign_claim_reject_offer_v3',
          'commercial_acquisition_context_reject_offer_v3',
          'commercial_quote_reject_offer_v3',
          'commercial_quote_v3_sources',
          'commercial_offer_control_event_immutable',
          'commercial_offer_control_event_truncate_immutable'
        )
      ORDER BY tgname
    `)
    const acceptanceTriggers = await database.client.query<{ tgname: string }>(`
      SELECT tgname
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgrelid = '"CommercialQuoteAcceptance"'::regclass
      ORDER BY tgname
    `)
    const task4Functions = await database.client.query<{ proname: string }>(`
      SELECT proname
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('commercial_quote_snapshot_matches_v3_row', 'enforce_commercial_quote_v3_sources')
      ORDER BY proname
    `)

    expect(constraints.rows.every(row => row.convalidated)).toBe(true)
    expect(constraints.rows.map(row => row.conname)).toEqual(
      expect.arrayContaining([
        'CommercialQuote_offer_pair_check',
        'CommercialQuote_authority_shape_check',
        'CommercialQuote_schema_version_check',
        'CommercialQuote_snapshot_schema_version_check',
        'CommercialQuote_totals_check',
        'CommercialQuote_snapshot_totals_check',
        'CommercialQuote_v3_totals_check',
        'CommercialQuote_snapshot_size_v3_check',
        'CommercialQuote_offerVersionId_offerSchemaVersion_fkey',
      ]),
    )
    expect(triggers.rows.map(row => row.tgname)).toHaveLength(11)
    expect(acceptanceTriggers.rows).toEqual([])
    expect(task4Functions.rows.map(row => row.proname)).toEqual([
      'commercial_quote_snapshot_matches_v3_row',
      'enforce_commercial_quote_v3_sources',
    ])
    const alwaysTriggers = await database.client.query<{ tgname: string }>(`
      SELECT tgname
      FROM pg_trigger
      WHERE tgenabled = 'A'
        AND tgname IN (
          'commercial_quote_immutable',
          'commercial_quote_v3_sources',
          'commercial_offer_control_event_immutable',
          'commercial_offer_control_event_truncate_immutable'
        )
      ORDER BY tgname
    `)
    expect(alwaysTriggers.rows.map(row => row.tgname)).toEqual([
      'commercial_offer_control_event_immutable',
      'commercial_offer_control_event_truncate_immutable',
      'commercial_quote_immutable',
      'commercial_quote_v3_sources',
    ])
  })

  it('accepts fresh v1/v2 rows after migration and still rejects invalid legacy arithmetic', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    const postV1 = structuredClone(quoteV1Fixture)
    postV1.quoteId = 'post-migration-v1'
    await database.client.query(
      `INSERT INTO "CommercialQuote" (
        "id", "catalogPublicationId", "campaignVersionId", "schemaVersion", "market", "currency", "snapshot", "checksum",
        "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
        "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
      ) VALUES ($1, $2, $3, 1, 'MX', 'MXN', $4::jsonb, $5,
        24900, 19900, 5000, 800, 5800, 24900, 3984, 28884,
        '2026-08-22T12:00:00.000', '2026-08-22T12:30:00.000')`,
      [
        postV1.quoteId,
        postV1.catalogPublicationId,
        postV1.campaignVersionId,
        JSON.stringify(postV1),
        quoteChecksum(postV1.quoteId, postV1),
      ],
    )

    const postV2 = structuredClone(quoteV2Fixture)
    postV2.quoteId = 'post-migration-v2'
    await database.client.query(
      `INSERT INTO "CommercialQuote" (
        "id", "catalogPublicationId", "campaignVersionId", "acquisitionContextId", "organizationId", "venueId", "createdById",
        "schemaVersion", "market", "currency", "snapshot", "checksum",
        "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
        "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 2, 'MX', 'MXN', $8::jsonb, $9,
        24900, 19900, 5000, 800, 5800, 24900, 3984, 28884,
        '2026-08-24T12:10:00.000', '2026-08-24T12:25:00.000')`,
      [
        postV2.quoteId,
        postV2.catalogPublicationId,
        postV2.campaignVersionId,
        postV2.acquisitionContextId,
        postV2.subject.organizationId,
        postV2.subject.venueId,
        postV2.subject.actorId,
        JSON.stringify(postV2),
        quoteChecksum(postV2.quoteId, postV2),
      ],
    )

    const invalidV1 = structuredClone(postV1)
    invalidV1.quoteId = 'post-migration-invalid-v1'
    await expectSqlCode(
      database.client.query(
        `INSERT INTO "CommercialQuote" (
          "id", "catalogPublicationId", "campaignVersionId", "schemaVersion", "market", "currency", "snapshot", "checksum",
          "listSubtotalMinor", "discountMinor", "subtotalMinor", "taxMinor", "totalMinor",
          "renewalSubtotalMinor", "renewalTaxMinor", "renewalTotalMinor", "quotedAt", "expiresAt"
        ) VALUES ($1, $2, $3, 1, 'MX', 'MXN', $4::jsonb, $5,
          24900, 19900, 5000, 800, 5801, 24900, 3984, 28884,
          '2026-08-22T12:00:00.000', '2026-08-22T12:30:00.000')`,
        [
          invalidV1.quoteId,
          invalidV1.catalogPublicationId,
          invalidV1.campaignVersionId,
          JSON.stringify(invalidV1),
          quoteChecksum(invalidV1.quoteId, invalidV1),
        ],
      ),
      ['23514'],
      { constraint: 'CommercialQuote_snapshot_totals_check' },
    )
  })

  it('accepts a valid direct Quote v3 with mixed SaaS and hardware arithmetic', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    await insertQuoteV3(database.client, quoteV3Fixture)
    const stored = await database.client.query<{
      schemaVersion: number
      campaignVersionId: string | null
      offerVersionId: string
      offerSchemaVersion: number
      totalMinor: string
    }>(
      `SELECT "schemaVersion", "campaignVersionId", "offerVersionId", "offerSchemaVersion", "totalMinor"::text
       FROM "CommercialQuote" WHERE "id" = $1`,
      [quoteV3Fixture.quoteId],
    )
    expect(stored.rows).toEqual([
      {
        schemaVersion: 3,
        campaignVersionId: null,
        offerVersionId: quoteV3Fixture.offerVersionId,
        offerSchemaVersion: 3,
        totalMinor: quoteV3Fixture.totals.dueNow.totalMinor,
      },
    ])
  })

  it('accepts the exact engine-emitted 50-line commercial money boundary', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    await insertBoundaryOfferV3(database.client, exactBoundary.offer)
    await insertQuoteV3(database.client, exactBoundary.quote.snapshot as Record<string, any>, {
      checksum: exactBoundary.quote.checksum,
    })

    const stored = await database.client.query<{
      lineCount: string
      listSubtotalMinor: string
      taxMinor: string
      totalMinor: string
    }>(
      `SELECT
         (jsonb_array_length("snapshot"->'saasLines') + jsonb_array_length("snapshot"->'hardwareLines'))::text AS "lineCount",
         "listSubtotalMinor"::text AS "listSubtotalMinor",
         "taxMinor"::text AS "taxMinor",
         "totalMinor"::text AS "totalMinor"
       FROM "CommercialQuote" WHERE "id" = $1`,
      [exactBoundary.quote.snapshot.quoteId],
    )
    expect(stored.rows).toEqual([
      {
        lineCount: '50',
        listSubtotalMinor: MAX_QUOTE_LIST_SUBTOTAL_MINOR.toString(),
        taxMinor: MAX_QUOTE_TAX_MINOR.toString(),
        totalMinor: MAX_QUOTE_TOTAL_MINOR.toString(),
      },
    ])
  })

  it('rejects raw counterfeit arithmetic, source checksums, authority pairs and cross-tenant lineage', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')

    const arithmetic = structuredClone(quoteV3Fixture)
    arithmetic.saasLines[0].subtotalMinor = '18001'
    await expectSqlCode(insertQuoteV3(database.client, arithmetic, { id: 'quote-v3-bad-arithmetic' }), ['23514'], {
      constraint: 'CommercialQuote_v3_totals_check',
    })

    const sourceChecksum = structuredClone(quoteV3Fixture)
    sourceChecksum.offerChecksum = 'f'.repeat(64)
    await expectSqlCode(insertQuoteV3(database.client, sourceChecksum, { id: 'quote-v3-bad-source' }), ['23514'], {
      messageIncludes: 'Commercial Quote v3 Offer source mismatch',
    })

    await expectSqlCode(
      insertQuoteV3(database.client, quoteV3Fixture, {
        id: 'quote-v3-partial-authority',
        offerSchemaVersion: null,
      }),
      ['23514'],
    )

    const crossTenant = structuredClone(quoteV3Fixture)
    crossTenant.subject.organizationId = 'organization-other-v3'
    await expectSqlCode(insertQuoteV3(database.client, crossTenant, { id: 'quote-v3-cross-tenant' }), ['23514'])

    const prematureAcquisition = structuredClone(quoteV3Fixture)
    prematureAcquisition.acquisitionContextId = quoteV2Fixture.acquisitionContextId
    prematureAcquisition.derivedFromPreview = {
      previewQuoteId: 'preview-not-authorized-in-q3-a',
      previewChecksum: '7'.repeat(64),
      selectionFingerprint: '8'.repeat(64),
    }
    await expectSqlCode(insertQuoteV3(database.client, prematureAcquisition, { id: 'quote-v3-premature-acquisition' }), ['23514'], {
      constraint: 'CommercialQuote_authority_shape_check',
    })

    const fabricatedPreview = structuredClone(quoteV3Fixture)
    fabricatedPreview.derivedFromPreview = {
      previewQuoteId: 'preview-not-authorized-in-q3-a',
      previewChecksum: '7'.repeat(64),
      selectionFingerprint: '8'.repeat(64),
    }
    await expectSqlCode(insertQuoteV3(database.client, fabricatedPreview, { id: 'quote-v3-fabricated-preview' }), ['23514'], {
      constraint: 'CommercialQuote_v3_totals_check',
    })

    const missingResolutionSchema = structuredClone(quoteV3Fixture)
    delete missingResolutionSchema.resolution.schemaVersion
    await expectSqlCode(
      insertQuoteV3(database.client, missingResolutionSchema, { id: 'quote-v3-missing-resolution-schema' }),
      ['23514'],
      { constraint: 'CommercialQuote_v3_totals_check' },
    )

    const missingResolutionVersion = structuredClone(quoteV3Fixture)
    delete missingResolutionVersion.resolution.resolutionVersion
    await expectSqlCode(
      insertQuoteV3(database.client, missingResolutionVersion, { id: 'quote-v3-missing-resolution-version' }),
      ['23514'],
      { constraint: 'CommercialQuote_v3_totals_check' },
    )

    const missingHardwareTaxRate = structuredClone(quoteV3Fixture)
    delete missingHardwareTaxRate.hardwareLines[0].skuSnapshot.taxRateBasisPoints
    await expectSqlCode(
      insertQuoteV3(database.client, missingHardwareTaxRate, { id: 'quote-v3-missing-hardware-tax-rate' }),
      ['23514'],
      { constraint: 'CommercialQuote_v3_totals_check' },
    )

    const missingHardwareCatalogKey = structuredClone(quoteV3Fixture)
    delete missingHardwareCatalogKey.hardwareLines[0].catalogKey
    delete missingHardwareCatalogKey.hardwareLines[0].skuSnapshot.catalogKey
    await expectSqlCode(
      insertQuoteV3(database.client, missingHardwareCatalogKey, { id: 'quote-v3-missing-hardware-catalog-key' }),
      ['23514'],
      { constraint: 'CommercialQuote_v3_totals_check' },
    )

    await expectSqlCode(
      insertQuoteV3(database.client, quoteV3Fixture, {
        id: 'quote-v3-through-legacy-campaign',
        campaignVersionId: quoteV3Fixture.offerVersionId,
      }),
      ['23514'],
    )
  })

  it('measures canonical and PostgreSQL bytes independently at the 3 MiB application ceiling', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    const canonicalCeiling = canonicalCeilingMaxStructureVector()
    expect(canonicalCeiling.saasLines).toHaveLength(50)
    expect(canonicalCeiling.hardwareLines).toHaveLength(0)
    expect(canonicalCeiling.entitlementGrants).toHaveLength(128)
    expect(canonicalCeiling.resolution.applied).toHaveLength(600)
    expect(canonicalCeiling.resolution.exclusions).toHaveLength(5050)
    const ajv = new Ajv({ allErrors: true, jsonPointers: true })
    ajv.addSchema(quoteV2Schema as object)
    ajv.addSchema(resolutionSchema as object)
    expect(ajv.compile(quoteV3Schema as object)(canonicalCeiling)).toBe(true)
    expect(receipt?.jsonbVectorBytes.direct).toBeLessThanOrEqual(4_194_304)
    expect(receipt?.jsonbVectorBytes.exactMoneyBoundary).toBeLessThanOrEqual(4_194_304)
    expect(receipt?.jsonbVectorBytes.canonicalCeilingCanonical).toBe(COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES)
    expect(receipt?.jsonbVectorBytes.canonicalCeilingJsonb).toBeGreaterThan(COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES)
    expect(receipt?.jsonbVectorBytes.canonicalCeilingJsonb).toBeLessThanOrEqual(4_194_304)
    expect(receipt?.jsonbVectorBytes.canonicalToJsonbExpansion).toBeGreaterThan(0)
    expect(receipt?.jsonbVectorBytes.canonicalCeilingJsonbMargin).toBeGreaterThan(0)

    await expectSqlCode(
      insertQuoteV3(database.client, quoteV3Fixture, {
        id: 'quote-v3-int8-overflow',
        totalMinor: '9223372036854775808',
      }),
      ['22003'],
    )

    const oversized = structuredClone(quoteV3Fixture)
    oversized.padding = 'x'.repeat(4_194_304)
    const measured = await database.client.query<{ bytes: number }>('SELECT octet_length($1::jsonb::text) AS bytes', [
      JSON.stringify(oversized),
    ])
    expect(Number(measured.rows[0].bytes)).toBeGreaterThan(4_194_304)
    await expectSqlCode(insertQuoteV3(database.client, oversized, { id: 'quote-v3-oversized' }), ['23514'], {
      constraint: 'CommercialQuote_snapshot_size_v3_check',
    })
  })

  it('preserves millisecond precision at the .999 timestamp boundary', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    const millisecondBoundary = structuredClone(quoteV3Fixture)
    millisecondBoundary.quotedAt = '2026-08-15T12:00:00.999Z'
    millisecondBoundary.expiresAt = '2026-08-15T12:15:00.999Z'
    millisecondBoundary.resolution.resolvedAt = millisecondBoundary.quotedAt
    await insertQuoteV3(database.client, millisecondBoundary, { id: 'quote-v3-millisecond-boundary' })
    const stored = await database.client.query<{ quotedAt: string; expiresAt: string }>(
      `SELECT to_char("quotedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "quotedAt",
              to_char("expiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "expiresAt"
       FROM "CommercialQuote" WHERE "id" = 'quote-v3-millisecond-boundary'`,
    )
    expect(stored.rows).toEqual([{ quotedAt: '2026-08-15T12:00:00.999', expiresAt: '2026-08-15T12:15:00.999' }])
  })

  it('keeps Offer control events schema-3-only, monotonic and immutable', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    await database.client.query(
      `INSERT INTO "CommercialOfferControlEvent" (
        "id", "offerVersionId", "offerSchemaVersion", "revision", "action", "reason", "confirmedById"
      ) VALUES ('offer-control-1', $1, 3, 1, 'SUSPEND_NEW_CLAIMS', 'incident rehearsal', 'staff-publisher-v3')`,
      [quoteV3Fixture.offerVersionId],
    )
    await expectSqlCode(
      database.client.query(`UPDATE "CommercialOfferControlEvent" SET "reason" = 'changed' WHERE "id" = 'offer-control-1'`),
      ['55000'],
    )
    await expectSqlCode(database.client.query(`DELETE FROM "CommercialOfferControlEvent" WHERE "id" = 'offer-control-1'`), ['55000'])
    await expectSqlCode(database.client.query('TRUNCATE "CommercialOfferControlEvent"'), ['55000'])
    await expectSqlCode(
      database.client.query(
        `INSERT INTO "CommercialOfferControlEvent" (
          "id", "offerVersionId", "offerSchemaVersion", "revision", "action", "reason", "confirmedById"
        ) VALUES ('offer-control-v2', $1, 3, 1, 'RESUME', 'wrong source', 'staff-publisher-v3')`,
        [quoteV2Fixture.campaignVersionId],
      ),
      ['23503'],
    )
    await expectSqlCode(
      database.client.query(
        `INSERT INTO "CommercialOfferControlEvent" (
          "id", "offerVersionId", "offerSchemaVersion", "revision", "action", "reason", "confirmedById"
        ) VALUES ('offer-control-duplicate', $1, 3, 1, 'RESUME', 'duplicate revision', 'staff-publisher-v3')`,
        [quoteV3Fixture.offerVersionId],
      ),
      ['23505'],
    )
    await expectSqlCode(
      database.client.query(
        `INSERT INTO "CommercialOfferControlEvent" (
          "id", "offerVersionId", "offerSchemaVersion", "revision", "action", "reason", "confirmedById"
        ) VALUES ('offer-control-zero-revision', $1, 3, 0, 'RESUME', 'invalid revision', 'staff-publisher-v3')`,
        [quoteV3Fixture.offerVersionId],
      ),
      ['23514'],
    )
    await expectSqlCode(
      database.client.query(
        `INSERT INTO "CommercialOfferControlEvent" (
          "id", "offerVersionId", "offerSchemaVersion", "revision", "action", "reason", "confirmedById"
        ) VALUES ('offer-control-short-reason', $1, 3, 2, 'RESUME', 'x', 'staff-publisher-v3')`,
        [quoteV3Fixture.offerVersionId],
      ),
      ['23514'],
    )
    await expectSqlCode(
      database.client.query(
        `INSERT INTO "CommercialOfferControlEvent" (
          "id", "offerVersionId", "offerSchemaVersion", "revision", "action", "reason", "confirmedById"
        ) VALUES ('offer-control-schema-v2', $1, 2, 2, 'RESUME', 'wrong schema version', 'staff-publisher-v3')`,
        [quoteV3Fixture.offerVersionId],
      ),
      ['23503', '23514'],
    )
  })

  it('preserves immutable sources and still forbids legacy Campaign operational references to Offer v3', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    await expectSqlCode(
      database.client.query(`UPDATE "CommercialQuote" SET "checksum" = $2 WHERE "id" = $1`, [quoteV3Fixture.quoteId, 'f'.repeat(64)]),
      ['55000'],
    )
    await expectSqlCode(database.client.query(`DELETE FROM "CommercialQuote" WHERE "id" = $1`, [quoteV3Fixture.quoteId]), ['55000'])
    await expectSqlCode(
      database.client.query(`UPDATE "CommercialPublication" SET "reason" = 'mutated' WHERE "id" = $1`, [
        quoteV3Fixture.catalogPublicationId,
      ]),
      ['55000'],
    )
    await expectSqlCode(
      database.client.query(`UPDATE "CommercialCampaignVersion" SET "reason" = 'mutated' WHERE "id" = $1`, [quoteV3Fixture.offerVersionId]),
      ['55000'],
    )
    await expectSqlCode(
      database.client.query(
        `INSERT INTO "CommercialCampaignActivation" (
          "id", "environment", "campaignCode", "campaignVersionId", "reason", "updatedById", "updatedAt"
        ) VALUES ('activation-offer-v3', 'PREVIEW', 'SUMMER_2026', $1, 'must remain blocked', 'staff-publisher-v3', CURRENT_TIMESTAMP)`,
        [quoteV3Fixture.offerVersionId],
      ),
      ['23514'],
    )
    await expectSqlCode(
      database.client.query(
        `INSERT INTO "CommercialCampaignClaim" (
          "id", "tokenHash", "campaignVersionId", "campaignCode", "channel", "sourceRef", "issuedById", "reason", "createdAt", "expiresAt"
        ) VALUES (
          'claim-offer-v3', $1, $2, 'SUMMER_2026', 'SELLER', 'seller-boundary', 'staff-publisher-v3',
          'must remain blocked', '2026-08-15T12:00:00.000', '2026-08-16T12:00:00.000'
        )`,
        ['5'.repeat(64), quoteV3Fixture.offerVersionId],
      ),
      ['23514'],
    )
    await expectSqlCode(
      database.client.query(
        `INSERT INTO "CommercialAcquisitionContext" (
          "id", "tokenHash", "campaignVersionId", "channel", "attribution", "createdAt", "expiresAt"
        ) VALUES (
          'acquisition-offer-v3', $1, $2, 'DIRECT', '{}'::jsonb,
          '2026-08-15T12:00:00.000', '2026-08-22T12:00:00.000'
        )`,
        ['6'.repeat(64), quoteV3Fixture.offerVersionId],
      ),
      ['23514'],
    )
  })

  it('keeps the real checkout policy fail-closed before the disposable acceptance transaction', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    const before = await database.client.query<{ acceptances: string }>(
      'SELECT count(*)::text AS acceptances FROM "CommercialQuoteAcceptance"',
    )
    const acceptanceService = createLabQuoteAcceptanceService(database.client, 'OFF')

    await expect(
      acceptanceService.accept({
        quoteId: quoteV3Fixture.quoteId,
        organizationId: quoteV3Fixture.subject.organizationId,
        venueId: quoteV3Fixture.subject.venueId,
        acceptedById: quoteV3Fixture.subject.actorId,
        idempotencyKey: 'q3a-direct-checkout-off-001',
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_V2_CHECKOUT_DISABLED', statusCode: 503 })

    const after = await database.client.query<{ acceptances: string }>(
      'SELECT count(*)::text AS acceptances FROM "CommercialQuoteAcceptance"',
    )
    expect(after.rows).toEqual(before.rows)
  })

  it('classifies populated Q3-A Quotes and control events while the legacy v2 acceptance boundary rejects schema 3', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    const acceptanceService = createLabQuoteAcceptanceService(database.client)
    const before = await database.client.query<{ acceptances: string; stripe: string; subscriptions: string }>(`
      SELECT
        (SELECT count(*)::text FROM "CommercialQuoteAcceptance") AS acceptances,
        (SELECT count(*)::text FROM "CommercialStripeOperation") AS stripe,
        (SELECT count(*)::text FROM "CommercialSubscriptionEvent") AS subscriptions
    `)
    expect(before.rows).toEqual([{ acceptances: '0', stripe: '0', subscriptions: '0' }])

    await expect(
      acceptanceService.accept({
        quoteId: quoteV3Fixture.quoteId,
        organizationId: quoteV3Fixture.subject.organizationId,
        venueId: quoteV3Fixture.subject.venueId,
        acceptedById: quoteV3Fixture.subject.actorId,
        idempotencyKey: 'q3a-direct-acceptance-lab-001',
      }),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_QUOTE_SCHEMA_UNSUPPORTED' })

    const after = await database.client.query<{ acceptances: string; stripe: string; subscriptions: string }>(`
      SELECT
        (SELECT count(*)::text FROM "CommercialQuoteAcceptance") AS acceptances,
        (SELECT count(*)::text FROM "CommercialStripeOperation") AS stripe,
        (SELECT count(*)::text FROM "CommercialSubscriptionEvent") AS subscriptions
    `)
    expect(after.rows).toEqual([{ acceptances: '0', stripe: '0', subscriptions: '0' }])

    const preflightPrisma = new PrismaClient({ datasources: { db: { url: database.url } } })
    try {
      await preflightPrisma.$connect()
      const dependencies = createPrismaCommercialOfferReleasePreflightDependencies(preflightPrisma)
      const preflight = createCommercialOfferReleasePreflightService({
        ...dependencies,
        now: () => new Date('2026-08-29T18:00:00.000Z'),
      })
      const receipt = await preflight.run()

      expect(receipt).toEqual({
        status: 'PASS',
        schemaVersion: 3,
        publishedVersions: 2,
        q3a: {
          allowed: { offerControlEvents: 1, directQuotes: 3, directQuoteAcceptances: 0 },
          prohibited: {
            campaignActivations: 0,
            campaignClaims: 0,
            acquisitionContexts: 0,
            legacyCampaignLinkedQuotes: 0,
            invalidOfferQuoteShapes: 0,
            previewBridges: 0,
            stripeOperations: 0,
            subscriptionEvents: 0,
          },
        },
        checkedAt: '2026-08-29T18:00:00.000Z',
      })
    } finally {
      await preflightPrisma.$disconnect()
    }
  })

  it('fails closed on a post-v3 contraction and therefore requires forward-only recovery', async () => {
    if (!database) throw new Error('COMMERCIAL_QUOTE_V3_TEST_DATABASE_NOT_READY')
    const before = await database.client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "CommercialQuote" WHERE "schemaVersion" = 3',
    )
    await expectSqlCode(
      database.client.query(`
        ALTER TABLE "CommercialQuote"
          DROP CONSTRAINT "CommercialQuote_schema_version_check",
          ADD CONSTRAINT "CommercialQuote_schema_version_check" CHECK ("schemaVersion" IN (1, 2))
      `),
      ['23514'],
    )
    const preserved = await database.client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "CommercialQuote" WHERE "schemaVersion" = 3',
    )
    expect(Number(preserved.rows[0].count)).toBe(Number(before.rows[0].count))
    expect(Number(preserved.rows[0].count)).toBeGreaterThan(0)
  })

  it('refuses to overwrite an unknown historical CommercialQuote trigger mode', async () => {
    const triggerModeDatabase = await createDisposableDatabase()
    try {
      await installCurrentChain(triggerModeDatabase.client)
      await triggerModeDatabase.client.query(
        'ALTER TABLE "CommercialQuote" ENABLE ALWAYS TRIGGER commercial_quote_immutable',
      )

      await expectSqlCode(
        applyMigrations(triggerModeDatabase.client, [quoteV3Migrations[0]]),
        ['55000'],
        { messageIncludes: 'requires commercial_quote_immutable in origin mode' },
      )
      await triggerModeDatabase.client.query('ROLLBACK')

      const rolledBack = await triggerModeDatabase.client.query<{
        columns: string
        ledger: boolean
        triggerMode: string
      }>(`
        SELECT
          count(*) FILTER (WHERE column_name IN ('offerVersionId', 'offerSchemaVersion'))::text AS columns,
          to_regclass('public."CommercialOfferControlEvent"') IS NOT NULL AS ledger,
          (
            SELECT tgenabled
              FROM pg_trigger
             WHERE tgrelid = '"CommercialQuote"'::regclass
               AND tgname = 'commercial_quote_immutable'
          ) AS "triggerMode"
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'CommercialQuote'
      `)
      expect(rolledBack.rows[0]).toEqual({ columns: '0', ledger: false, triggerMode: 'A' })

      await triggerModeDatabase.client.query(
        'ALTER TABLE "CommercialQuote" ENABLE TRIGGER commercial_quote_immutable',
      )
      await applyMigrations(triggerModeDatabase.client, quoteV3Migrations)
      const recovered = await triggerModeDatabase.client.query<{ present: boolean }>(
        `SELECT to_regclass('public."CommercialOfferControlEvent"') IS NOT NULL AS present`,
      )
      expect(recovered.rows[0].present).toBe(true)
    } finally {
      await cleanupDisposableDatabase(triggerModeDatabase)
    }
  })

  it('aborts the expand migration after the real two-second lock budget and rolls back atomically', async () => {
    const lockedDatabase = await createDisposableDatabase()
    const blocker = new Client({ connectionString: lockedDatabase.url })
    try {
      await installCurrentChain(lockedDatabase.client)
      await blocker.connect()
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE "CommercialCampaignVersion" IN ROW EXCLUSIVE MODE')

      const startedAt = performance.now()
      await expectSqlCode(applyMigrations(lockedDatabase.client, [quoteV3Migrations[0]]), ['55P03'])
      const durationMs = performance.now() - startedAt
      await lockedDatabase.client.query('ROLLBACK')
      expect(durationMs).toBeGreaterThanOrEqual(1_700)
      expect(durationMs).toBeLessThan(5_000)

      const rolledBack = await lockedDatabase.client.query<{ columns: string; ledger: boolean }>(`
        SELECT
          count(*) FILTER (WHERE column_name IN ('offerVersionId', 'offerSchemaVersion'))::text AS columns,
          to_regclass('public."CommercialOfferControlEvent"') IS NOT NULL AS ledger
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'CommercialQuote'
      `)
      expect(rolledBack.rows[0]).toEqual({ columns: '0', ledger: false })

      await blocker.query('ROLLBACK')
      await applyMigrations(lockedDatabase.client, quoteV3Migrations)
      const recovered = await lockedDatabase.client.query<{ present: boolean }>(
        `SELECT to_regclass('public."CommercialOfferControlEvent"') IS NOT NULL AS present`,
      )
      expect(recovered.rows[0].present).toBe(true)
    } finally {
      await blocker.end().catch(() => undefined)
      await cleanupDisposableDatabase(lockedDatabase)
    }
  })

  it('rehearses a complete pre-evidence rollback and clean roll-forward without CASCADE', async () => {
    const rollbackDatabase = await createDisposableDatabase()
    try {
      await installCurrentChain(rollbackDatabase.client)
      await seedMeasuredCurrentChain(rollbackDatabase.client)
      const legacyConstraintDefinitions = await legacyQuoteConstraintDefinitions(rollbackDatabase.client)
      await applyMigrations(rollbackDatabase.client, quoteV3Migrations)
      await expectPopulatedLegacyFixture(rollbackDatabase.client)
      const rollbackStartedAt = performance.now()
      await rollbackQuoteV3BeforeEvidence(rollbackDatabase.client)
      if (!receipt) throw new Error('COMMERCIAL_QUOTE_V3_TEST_RECEIPT_NOT_READY')
      receipt.rollbackFinalDurationMs = performance.now() - rollbackStartedAt
      expect(await legacyQuoteConstraintDefinitions(rollbackDatabase.client)).toEqual(legacyConstraintDefinitions)
      await expectLegacyRegressionAfterRollback(rollbackDatabase.client, 'final')

      const contracted = await rollbackDatabase.client.query<{ columns: string; ledger: boolean; schema_definition: string }>(`
        SELECT
          count(*) FILTER (WHERE columns.column_name IN ('offerVersionId', 'offerSchemaVersion'))::text AS columns,
          to_regclass('public."CommercialOfferControlEvent"') IS NOT NULL AS ledger,
          pg_get_constraintdef(constraints.oid) AS schema_definition
        FROM information_schema.columns AS columns
        CROSS JOIN pg_constraint AS constraints
        WHERE columns.table_schema = 'public'
          AND columns.table_name = 'CommercialQuote'
          AND constraints.conname = 'CommercialQuote_schema_version_check'
        GROUP BY constraints.oid
      `)
      expect(contracted.rows[0].columns).toBe('0')
      expect(contracted.rows[0].ledger).toBe(false)
      expect(contracted.rows[0].schema_definition).not.toContain('3')

      await applyMigrations(rollbackDatabase.client, quoteV3Migrations)
      const rolledForward = await rollbackDatabase.client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'CommercialQuote'
          AND column_name IN ('offerVersionId', 'offerSchemaVersion')
      `)
      expect(rolledForward.rows[0].count).toBe('2')
    } finally {
      await cleanupDisposableDatabase(rollbackDatabase)
    }
  })

  it('rehearses the same rollback from the expand-only pending state', async () => {
    const rollbackDatabase = await createDisposableDatabase()
    try {
      await installCurrentChain(rollbackDatabase.client)
      await seedMeasuredCurrentChain(rollbackDatabase.client)
      const legacyConstraintDefinitions = await legacyQuoteConstraintDefinitions(rollbackDatabase.client)
      await applyMigrations(rollbackDatabase.client, [quoteV3Migrations[0]])
      await expectPopulatedLegacyFixture(rollbackDatabase.client)
      await expectSqlCode(insertQuoteV3(rollbackDatabase.client, quoteV3Fixture, { id: 'quote-v3-expand-only-rejected' }), ['23514'], {
        constraint: 'CommercialQuote_schema_version_check',
      })
      const rollbackStartedAt = performance.now()
      await rollbackQuoteV3BeforeEvidence(rollbackDatabase.client)
      if (!receipt) throw new Error('COMMERCIAL_QUOTE_V3_TEST_RECEIPT_NOT_READY')
      receipt.rollbackExpandOnlyDurationMs = performance.now() - rollbackStartedAt
      expect(await legacyQuoteConstraintDefinitions(rollbackDatabase.client)).toEqual(legacyConstraintDefinitions)
      await expectLegacyRegressionAfterRollback(rollbackDatabase.client, 'expand-only')

      const contracted = await rollbackDatabase.client.query<{ columns: string; ledger: boolean; pending: string }>(`
        SELECT
          (SELECT count(*)::text
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'CommercialQuote'
              AND column_name IN ('offerVersionId', 'offerSchemaVersion')) AS columns,
          to_regclass('public."CommercialOfferControlEvent"') IS NOT NULL AS ledger,
          (SELECT count(*)::text
             FROM pg_constraint
            WHERE conrelid = '"CommercialQuote"'::regclass
              AND conname LIKE '%_v3_pending') AS pending
      `)
      expect(contracted.rows).toEqual([{ columns: '0', ledger: false, pending: '0' }])

      await applyMigrations(rollbackDatabase.client, quoteV3Migrations)
      const recovered = await rollbackDatabase.client.query<{ columns: string; validated: string }>(`
        SELECT
          (SELECT count(*)::text
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'CommercialQuote'
              AND column_name IN ('offerVersionId', 'offerSchemaVersion')) AS columns,
          (SELECT count(*)::text
             FROM pg_constraint
            WHERE conrelid = '"CommercialQuote"'::regclass
              AND convalidated
              AND conname LIKE 'CommercialQuote_%') AS validated
      `)
      expect(recovered.rows[0].columns).toBe('2')
      expect(Number(recovered.rows[0].validated)).toBeGreaterThan(0)
    } finally {
      await cleanupDisposableDatabase(rollbackDatabase)
    }
  })

  it('reconciles the real Prisma ledger across deploy, rollback and redeploy', async () => {
    const ledgerDatabase = await createDisposableDatabase()
    const fixtureRoot = createQuoteV3PrismaMigrationFixture()
    try {
      await installCurrentChain(ledgerDatabase.client)
      await seedMeasuredCurrentChain(ledgerDatabase.client)
      const legacyConstraintDefinitions = await legacyQuoteConstraintDefinitions(ledgerDatabase.client)
      prismaMigrateResolveBaseline(ledgerDatabase.url, fixtureRoot)
      prismaMigrateDeploy(ledgerDatabase.url, fixtureRoot)
      await expectPopulatedLegacyFixture(ledgerDatabase.client)

      const firstDeploy = await ledgerDatabase.client.query<{ active: string; rolledBack: string }>(
        `
        SELECT
          count(*) FILTER (WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL)::text AS active,
          count(*) FILTER (WHERE rolled_back_at IS NOT NULL)::text AS "rolledBack"
        FROM "_prisma_migrations"
        WHERE migration_name = ANY($1::text[])
      `,
        [quoteV3Migrations],
      )
      expect(firstDeploy.rows).toEqual([{ active: '2', rolledBack: '0' }])

      const rollbackStartedAt = performance.now()
      await rollbackQuoteV3BeforeEvidence(ledgerDatabase.client)
      if (!receipt) throw new Error('COMMERCIAL_QUOTE_V3_TEST_RECEIPT_NOT_READY')
      receipt.rollbackPrismaLedgerDurationMs = performance.now() - rollbackStartedAt
      expect(await legacyQuoteConstraintDefinitions(ledgerDatabase.client)).toEqual(legacyConstraintDefinitions)
      await expectLegacyRegressionAfterRollback(ledgerDatabase.client, 'prisma-ledger')
      const afterRollback = await ledgerDatabase.client.query<{ active: string; rolledBack: string }>(
        `
        SELECT
          count(*) FILTER (WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL)::text AS active,
          count(*) FILTER (WHERE rolled_back_at IS NOT NULL)::text AS "rolledBack"
        FROM "_prisma_migrations"
        WHERE migration_name = ANY($1::text[])
      `,
        [quoteV3Migrations],
      )
      expect(afterRollback.rows).toEqual([{ active: '0', rolledBack: '2' }])

      prismaMigrateDeploy(ledgerDatabase.url, fixtureRoot)
      const secondDeploy = await ledgerDatabase.client.query<{ active: string; rolledBack: string }>(
        `
        SELECT
          count(*) FILTER (WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL)::text AS active,
          count(*) FILTER (WHERE rolled_back_at IS NOT NULL)::text AS "rolledBack"
        FROM "_prisma_migrations"
        WHERE migration_name = ANY($1::text[])
      `,
        [quoteV3Migrations],
      )
      expect(secondDeploy.rows).toEqual([{ active: '2', rolledBack: '2' }])

      const restored = await ledgerDatabase.client.query<{ columns: string; controlLedger: boolean }>(`
        SELECT
          (SELECT count(*)::text
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'CommercialQuote'
              AND column_name IN ('offerVersionId', 'offerSchemaVersion')) AS columns,
          to_regclass('public."CommercialOfferControlEvent"') IS NOT NULL AS "controlLedger"
      `)
      expect(restored.rows).toEqual([{ columns: '2', controlLedger: true }])
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
      await cleanupDisposableDatabase(ledgerDatabase)
    }
  })

  it('refuses physical rollback when Quote-v3 or control evidence exists', async () => {
    const quoteEvidenceDatabase = await createDisposableDatabase()
    const controlEvidenceDatabase = await createDisposableDatabase()
    try {
      await installCurrentChain(quoteEvidenceDatabase.client)
      await seedMeasuredCurrentChain(quoteEvidenceDatabase.client)
      await applyMigrations(quoteEvidenceDatabase.client, quoteV3Migrations)
      await insertQuoteV3(quoteEvidenceDatabase.client, quoteV3Fixture, { id: 'quote-v3-rollback-guard' })
      await expectSqlCode(rollbackQuoteV3BeforeEvidence(quoteEvidenceDatabase.client), ['55000'], {
        messageIncludes: 'Commercial Quote v3 evidence exists; recovery is forward-only',
      })
      await quoteEvidenceDatabase.client.query('ROLLBACK')
      const quoteEvidencePreserved = await quoteEvidenceDatabase.client.query<{ count: string; columns: string }>(`
        SELECT
          (SELECT count(*)::text FROM "CommercialQuote" WHERE "schemaVersion" = 3) AS count,
          (SELECT count(*)::text
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'CommercialQuote'
              AND column_name IN ('offerVersionId', 'offerSchemaVersion')) AS columns
      `)
      expect(quoteEvidencePreserved.rows).toEqual([{ count: '1', columns: '2' }])

      await installCurrentChain(controlEvidenceDatabase.client)
      await seedMeasuredCurrentChain(controlEvidenceDatabase.client)
      await applyMigrations(controlEvidenceDatabase.client, quoteV3Migrations)
      await controlEvidenceDatabase.client.query(
        `INSERT INTO "CommercialOfferControlEvent" (
          "id", "offerVersionId", "offerSchemaVersion", "revision", "action", "reason", "confirmedById"
        ) VALUES ('offer-control-rollback-guard', $1, 3, 1, 'SUSPEND_NEW_CLAIMS', 'preserve this evidence', 'staff-publisher-v3')`,
        [quoteV3Fixture.offerVersionId],
      )
      await expectSqlCode(rollbackQuoteV3BeforeEvidence(controlEvidenceDatabase.client), ['55000'], {
        messageIncludes: 'Commercial Offer control evidence exists; recovery is forward-only',
      })
      await controlEvidenceDatabase.client.query('ROLLBACK')
      const controlEvidencePreserved = await controlEvidenceDatabase.client.query<{ count: string; columns: string }>(`
        SELECT
          (SELECT count(*)::text FROM "CommercialOfferControlEvent") AS count,
          (SELECT count(*)::text
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'CommercialQuote'
              AND column_name IN ('offerVersionId', 'offerSchemaVersion')) AS columns
      `)
      expect(controlEvidencePreserved.rows).toEqual([{ count: '1', columns: '2' }])
    } finally {
      await cleanupDisposableDatabase(quoteEvidenceDatabase)
      await cleanupDisposableDatabase(controlEvidenceDatabase)
    }
  })

  it.each(['READ COMMITTED', 'REPEATABLE READ'] as const)(
    'rechecks control evidence after waiting for a concurrent writer under %s',
    async isolationLevel => {
    const concurrentDatabase = await createDisposableDatabase()
    const writer = new Client({ connectionString: concurrentDatabase.url })
    try {
      await installCurrentChain(concurrentDatabase.client)
      await seedMeasuredCurrentChain(concurrentDatabase.client)
      await applyMigrations(concurrentDatabase.client, quoteV3Migrations)
      await writer.connect()
      await concurrentDatabase.client.query(
        `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ${isolationLevel}`,
      )

      const backend = await concurrentDatabase.client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await writer.query('BEGIN')
      await writer.query(
        `INSERT INTO "CommercialOfferControlEvent" (
          "id", "offerVersionId", "offerSchemaVersion", "revision", "action", "reason", "confirmedById"
        ) VALUES ('offer-control-concurrent-rollback', $1, 3, 1, 'SUSPEND_NEW_CLAIMS',
          'must survive a concurrent rollback', 'staff-publisher-v3')`,
        [quoteV3Fixture.offerVersionId],
      )

      const rollbackRejection = expectSqlCode(rollbackQuoteV3BeforeEvidence(concurrentDatabase.client), ['55000'], {
        messageIncludes: 'Commercial Offer control evidence exists; recovery is forward-only',
      })
      await waitForBackendLock(writer, backend.rows[0].pid)
      await writer.query('COMMIT')
      await rollbackRejection
      await concurrentDatabase.client.query('ROLLBACK')

      const preserved = await concurrentDatabase.client.query<{ count: string; columns: string }>(`
        SELECT
          (SELECT count(*)::text FROM "CommercialOfferControlEvent"
            WHERE "id" = 'offer-control-concurrent-rollback') AS count,
          (SELECT count(*)::text
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'CommercialQuote'
              AND column_name IN ('offerVersionId', 'offerSchemaVersion')) AS columns
      `)
      expect(preserved.rows).toEqual([{ count: '1', columns: '2' }])
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      await writer.end().catch(() => undefined)
      await cleanupDisposableDatabase(concurrentDatabase)
    }
    },
  )

  it('records populated rollback timings below the declared statement budget', () => {
    expect(receipt?.rollbackFinalDurationMs).toBeGreaterThan(0)
    expect(receipt?.rollbackFinalDurationMs).toBeLessThan(30_000)
    expect(receipt?.rollbackExpandOnlyDurationMs).toBeGreaterThan(0)
    expect(receipt?.rollbackExpandOnlyDurationMs).toBeLessThan(30_000)
    expect(receipt?.rollbackPrismaLedgerDurationMs).toBeGreaterThan(0)
    expect(receipt?.rollbackPrismaLedgerDurationMs).toBeLessThan(30_000)
  })

  it('classifies full migration-to-Prisma drift without any Task-4 object', async () => {
    const parityDatabase = await createDisposableDatabase()
    try {
      const parity = prismaMigrationParity(parityDatabase.url)
      expect(parity.status).toBe(2)
      for (const knownPreexistingObject of [
        'CommercialSubscriptionEvent',
        'StripeObjectBinding',
        'WebhookDispatchObservation',
        'WebhookEvent',
        'WebhookManualRetryResultOutbox',
        'WebhookOperationalAlert',
      ]) {
        expect(parity.output).toContain(knownPreexistingObject)
      }
      for (const task4Object of [
        'CommercialOfferControlEvent',
        'CommercialOfferControlAction',
        'CommercialQuote_offerVersionId_idx',
        'CommercialCampaignVersion_id_schemaVersion_key',
      ]) {
        expect(parity.output).not.toContain(task4Object)
      }
    } finally {
      await cleanupDisposableDatabase(parityDatabase)
    }
  })
})
