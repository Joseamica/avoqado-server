import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const schemaPath = path.join(root, 'prisma/schema.prisma')
const addMigrationPath = path.join(root, 'prisma/migrations/20260829100000_add_commercial_quote_v3_shape/migration.sql')
const validateMigrationPath = path.join(root, 'prisma/migrations/20260829110000_validate_commercial_quote_v3/migration.sql')
const runbookPath = path.join(root, 'docs/runbooks/commercial-quote-v3-migration-recovery.md')
const rollbackSqlPath = path.join(root, 'docs/runbooks/sql/commercial-quote-v3-pre-evidence-rollback.sql')
const acquisitionAddMigrationPath = path.join(
  root,
  'prisma/migrations/20260831100000_add_commercial_quote_v3_acquisition/migration.sql',
)
const acquisitionValidateMigrationPath = path.join(
  root,
  'prisma/migrations/20260831110000_validate_commercial_quote_v3_acquisition/migration.sql',
)

describe('Commercial Quote v3 additive persistence architecture', () => {
  const schema = readFileSync(schemaPath, 'utf8')

  it('uses two ordered migrations so NOT VALID and validation never share a transaction', () => {
    expect(existsSync(addMigrationPath)).toBe(true)
    expect(existsSync(validateMigrationPath)).toBe(true)

    const addSql = readFileSync(addMigrationPath, 'utf8')
    const validateSql = readFileSync(validateMigrationPath, 'utf8')

    expect(addSql).toContain('NOT VALID')
    expect(addSql).not.toContain('VALIDATE CONSTRAINT')
    expect(validateSql).toContain('VALIDATE CONSTRAINT')
    expect(validateSql).not.toContain('ADD COLUMN')
    expect(validateSql).not.toContain('CREATE TABLE')
  })

  it('models independent legacy-campaign and Offer-v3 quote authorities in Prisma', () => {
    expect(schema).toMatch(/offerVersionId\s+String\?/)
    expect(schema).toMatch(/offerSchemaVersion\s+Int\?/)
    expect(schema).toContain('@relation("CommercialQuoteCampaignV1V2"')
    expect(schema).toContain('@relation("CommercialQuoteOfferV3"')
    expect(schema).toContain('fields: [offerVersionId, offerSchemaVersion]')
    expect(schema).toContain('references: [id, schemaVersion]')
    expect(schema).toContain('@@unique([id, schemaVersion], map: "CommercialCampaignVersion_id_schemaVersion_key")')
    expect(schema).toContain('@@index([offerVersionId])')
    expect(schema).toContain('map: "CommercialCampaignActivation_campaignVersionId_campaignCode_fke"')
  })

  it('adds an immutable append-only Offer control ledger with a schema-3 composite authority', () => {
    expect(schema).toContain('enum CommercialOfferControlAction {')
    expect(schema).toContain('SUSPEND_NEW_CLAIMS')
    expect(schema).toContain('SUSPEND_ALL_PENDING')
    expect(schema).toContain('RESUME')
    expect(schema).toContain('model CommercialOfferControlEvent {')
    expect(schema).toMatch(/offerSchemaVersion\s+Int\s+@default\(3\)/)
    expect(schema).toContain('@@unique([offerVersionId, revision]')
    expect(schema).toContain('@relation("CommercialOfferControlEventConfirmedBy"')
  })

  it('installs paired-column and schema-shape constraints as NOT VALID before validation', () => {
    const sql = readFileSync(addMigrationPath, 'utf8')

    for (const constraint of [
      'CommercialQuote_offer_pair_check_v3_pending',
      'CommercialQuote_authority_shape_v3_pending',
      'CommercialQuote_schema_version_v3_pending',
      'CommercialQuote_snapshot_schema_version_v3_pending',
      'CommercialQuote_legacy_totals_v3_pending',
      'CommercialQuote_snapshot_totals_v3_pending',
      'CommercialQuote_snapshot_size_v3_pending',
      'CommercialQuote_offerVersionId_offerSchemaVersion_fkey',
      'CommercialQuote_v3_totals_pending',
    ]) {
      expect(sql).toContain(`CONSTRAINT "${constraint}"`)
    }

    expect(sql.match(/NOT VALID/g)?.length).toBeGreaterThanOrEqual(9)
    expect(sql).toContain('("offerVersionId" IS NULL) = ("offerSchemaVersion" IS NULL)')
    expect(sql).toContain('MATCH SIMPLE')
    expect(sql).toContain('AND "acquisitionContextId" IS NULL')
    expect(sql).toContain('p_acquisition_context_id IS NOT NULL')
  })

  it('preserves literal v1/v2 validation and dispatches v3 through a separate fail-closed function', () => {
    const sql = readFileSync(addMigrationPath, 'utf8')

    expect(sql).toContain('CREATE FUNCTION public.commercial_quote_snapshot_matches_v3_row(')
    expect(sql).toContain('EXCEPTION WHEN OTHERS THEN')
    expect(sql).toContain('RETURN false;')
    expect(sql).toContain('commercial_quote_snapshot_matches_v1_row(')
    expect(sql).toContain('commercial_quote_snapshot_matches_v2_row(')
    expect(sql).toContain('commercial_quote_snapshot_matches_v3_row(')
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.commercial_quote_snapshot_matches_v[12]_row/)
    expect(sql).not.toMatch(/DROP FUNCTION public\.commercial_quote_snapshot_matches_v[12]_row/)
    expect(sql.match(/SET search_path = pg_catalog, public/g)?.length).toBe(2)
    expect(sql.match(/ORDER BY ordinality/g)?.length).toBeGreaterThanOrEqual(4)
    expect(sql).toContain("jsonb_typeof(p_snapshot #> '{resolution,schemaVersion}') IS DISTINCT FROM 'number'")
    expect(sql).toContain("jsonb_typeof(p_snapshot #> '{resolution,resolutionVersion}') IS DISTINCT FROM 'number'")
    expect(sql).toContain("jsonb_typeof(line #> '{skuSnapshot,taxRateBasisPoints}') IS DISTINCT FROM 'number'")
    expect(sql).toContain("jsonb_typeof(line->'catalogKey') IS DISTINCT FROM 'string'")
    expect(sql).toContain("jsonb_typeof(line #> '{skuSnapshot,catalogKey}') IS DISTINCT FROM 'string'")
  })

  it('uses NUMERIC arithmetic for canonical v3 minor-unit strings and enforces the 4 MiB wall', () => {
    const sql = readFileSync(addMigrationPath, 'utf8')

    expect(sql).toContain('max_int8 CONSTANT NUMERIC := 9223372036854775807')
    expect(sql).toContain('::NUMERIC')
    expect(sql).not.toContain('money_text::INTEGER')
    expect(sql).not.toContain('line_list::INTEGER')
    expect(sql).not.toContain('line_subtotal::INTEGER')
    expect(sql.match(/div\(/g)?.length).toBe(4)
    expect(sql).not.toMatch(/floor\([^\n]+\/ 10000\)/)
    expect(sql).toContain('octet_length("snapshot"::text) <= 4194304')
  })

  it('locks and verifies both immutable source rows before allowing a schema-3 quote', () => {
    const sql = readFileSync(addMigrationPath, 'utf8')

    expect(sql).toContain('CREATE FUNCTION public.enforce_commercial_quote_v3_sources()')
    expect(sql).toContain('FROM "CommercialCampaignVersion"')
    expect(sql).toContain('FROM "CommercialPublication"')
    expect(sql.match(/FOR KEY SHARE/g)?.length).toBeGreaterThanOrEqual(2)
    expect(sql).toContain('commercial_quote_v3_sources')
    expect(sql).toContain("USING ERRCODE = '23514'")
  })

  it('keeps all existing immutable and Offer operational-reference barriers installed', () => {
    const addSql = readFileSync(addMigrationPath, 'utf8')
    const validateSql = readFileSync(validateMigrationPath, 'utf8')
    const combined = `${addSql}\n${validateSql}`

    for (const trigger of [
      'commercial_campaign_version_immutable',
      'commercial_publication_immutable_update',
      'commercial_publication_immutable_delete',
      'commercial_quote_immutable',
      'commercial_campaign_activation_reject_offer_v3',
      'commercial_campaign_claim_reject_offer_v3',
      'commercial_acquisition_context_reject_offer_v3',
      'commercial_quote_reject_offer_v3',
    ]) {
      expect(combined).not.toMatch(new RegExp(`DROP TRIGGER(?: IF EXISTS)? ${trigger}`, 'i'))
    }
    expect(addSql).toContain('commercial_offer_control_event_immutable')
    expect(addSql).toContain('commercial_offer_control_event_truncate_immutable')
    expect(addSql).toContain("WHERE trigger_row.tgname = 'commercial_quote_immutable'")
    expect(addSql).toContain("legacy_trigger_mode IS DISTINCT FROM 'O'")
    expect(addSql).toContain('Commercial Quote v3 requires commercial_quote_immutable in origin mode')
    expect(addSql.indexOf("WHERE trigger_row.tgname = 'commercial_quote_immutable'")).toBeLessThan(
      addSql.indexOf('ADD COLUMN "offerVersionId" TEXT'),
    )
    expect(addSql).toContain('ENABLE ALWAYS TRIGGER commercial_quote_v3_sources')
    expect(addSql).toContain('ENABLE ALWAYS TRIGGER commercial_quote_immutable')
    expect(addSql).toContain('ENABLE ALWAYS TRIGGER commercial_offer_control_event_immutable')
    expect(addSql).toContain('ENABLE ALWAYS TRIGGER commercial_offer_control_event_truncate_immutable')
  })

  it('validates under the measured 2-second lock and 30-second statement budgets before swapping names', () => {
    const sql = readFileSync(validateMigrationPath, 'utf8')

    expect(sql).toContain("SET LOCAL lock_timeout = '2s'")
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'")
    expect(sql.indexOf('VALIDATE CONSTRAINT "CommercialQuote_schema_version_v3_pending"')).toBeLessThan(
      sql.indexOf('DROP CONSTRAINT "CommercialQuote_schema_version_check"'),
    )
    expect(sql.indexOf('VALIDATE CONSTRAINT "CommercialQuote_legacy_totals_v3_pending"')).toBeLessThan(
      sql.indexOf('DROP CONSTRAINT "CommercialQuote_totals_check"'),
    )
    expect(sql.indexOf('VALIDATE CONSTRAINT "CommercialQuote_snapshot_totals_v3_pending"')).toBeLessThan(
      sql.indexOf('DROP CONSTRAINT "CommercialQuote_snapshot_totals_check"'),
    )
  })

  it('documents pre-v3 rollback, post-v3 forward-only recovery and the abort thresholds', () => {
    expect(existsSync(runbookPath)).toBe(true)
    expect(existsSync(rollbackSqlPath)).toBe(true)
    const runbook = readFileSync(runbookPath, 'utf8')
    const rollbackSql = readFileSync(rollbackSqlPath, 'utf8')

    expect(runbook).toContain('2 segundos')
    expect(runbook).toContain('30 segundos')
    expect(runbook).toContain('rollback antes de Quote v3')
    expect(runbook).toContain('recuperación forward-only')
    expect(runbook).toContain('CommercialQuote')
    expect(runbook).toContain('schemaVersion = 3')
    expect(runbook).toContain('CommercialQuote_offerVersionId_idx')
    expect(runbook).toContain('ACCESS EXCLUSIVE` sobre `CommercialQuote`')
    expect(runbook).toContain('bloquea lecturas y escrituras')
    expect(runbook).toContain('SHARE ROW EXCLUSIVE` sobre `CommercialCampaignVersion`')
    expect(runbook).toMatch(/`SHARE ROW EXCLUSIVE` sobre\s+`Staff`/)
    expect(runbook).toMatch(
      /swap de nombres toma `ACCESS EXCLUSIVE` sobre `CommercialQuote`[\s\S]*bloquea lecturas y escrituras hasta el `COMMIT`/,
    )
    expect(runbook).toContain('Q3-A admite únicamente cotizaciones v3 directas')
    expect(runbook).toContain('Offer (`CommercialCampaignVersion`) → Catalog')
    expect(runbook).toContain('(`CommercialPublication`) → Venue')
    expect(runbook).toContain('presupuesto total')
    expect(runbook).toContain('0.0610303125 ms/fila')
    expect(runbook).toContain('491,558 filas')
    expect(runbook).toContain('Prisma no queda con progreso parcial')
    expect(runbook).toMatch(/los 11\.990834 ms sobre 2,000\s+filas sintéticas no autorizan una ventana real/)
    expect(runbook).toMatch(/falla con `55000` antes de cambiar el\s+modo/)
    expect(runbook).toContain('función versionada nueva')
    expect(runbook).toContain('con 2,000 filas legacy')
    expect(runbook).toContain('conserva toda la evidencia')
    expect(runbook).toContain('decodeAndVerifyStoredCommercialQuoteV3')
    expect(runbook).toContain('congelada en 15 minutos')
    expect(runbook).toContain('commercial-quote-v3-pre-evidence-rollback.sql')
    expect(rollbackSql).toContain('DROP FUNCTION IF EXISTS public.commercial_quote_snapshot_matches_v3_row')
    expect(rollbackSql).toContain('CommercialQuote_offer_pair_check_v3_pending')
    expect(rollbackSql).toContain('CommercialQuote_snapshot_totals_v3_pending')
    expect(rollbackSql).toContain('UPDATE "_prisma_migrations"')
    expect(rollbackSql).toContain("'20260829100000_add_commercial_quote_v3_shape'")
    expect(rollbackSql).toContain("'20260829110000_validate_commercial_quote_v3'")
    expect(rollbackSql).toContain('rolled_back_at = COALESCE(rolled_back_at, CURRENT_TIMESTAMP)')
    expect(rollbackSql).toContain('Commercial Quote v3 evidence exists; recovery is forward-only')
    expect(rollbackSql).toContain('Commercial Offer control evidence exists; recovery is forward-only')
    expect(rollbackSql).toContain('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(rollbackSql).toContain('SET LOCAL search_path = pg_catalog, public')
    expect(rollbackSql.indexOf('LOCK TABLE "CommercialQuote" IN ACCESS EXCLUSIVE MODE')).toBeLessThan(
      rollbackSql.indexOf('DO $evidence_guard$'),
    )
    expect(rollbackSql.indexOf('LOCK TABLE public."CommercialOfferControlEvent" IN ACCESS EXCLUSIVE MODE')).toBeLessThan(
      rollbackSql.indexOf('DO $evidence_guard$'),
    )
    expect(rollbackSql.indexOf('DO $evidence_guard$')).toBeLessThan(
      rollbackSql.indexOf('DROP TRIGGER IF EXISTS commercial_quote_v3_sources'),
    )
    expect(rollbackSql).toContain('ENABLE TRIGGER commercial_quote_immutable')
    expect(rollbackSql).not.toContain('CASCADE')
  })
})

describe('Commercial Quote v3 acquisition handoff architecture', () => {
  const schema = readFileSync(schemaPath, 'utf8')

  it('uses dedicated Offer-v3 lineage while preserving every legacy rejection trigger', () => {
    expect(existsSync(acquisitionAddMigrationPath)).toBe(true)
    expect(existsSync(acquisitionValidateMigrationPath)).toBe(true)

    const addSql = readFileSync(acquisitionAddMigrationPath, 'utf8')
    const validateSql = readFileSync(acquisitionValidateMigrationPath, 'utf8')

    expect(addSql).toContain('ALTER COLUMN "campaignVersionId" DROP NOT NULL')
    expect(addSql).toContain('ALTER COLUMN "campaignCode" DROP NOT NULL')
    expect(addSql).toContain('"offerVersionId" TEXT')
    expect(addSql).toContain('"offerSchemaVersion" INTEGER')
    expect(addSql).toContain('"reservedCatalogPublicationId" TEXT')
    expect(addSql).toContain('"reservedCatalogSchemaVersion" INTEGER')
    expect(addSql).toContain('CommercialPublication_id_schemaVersion_key')
    expect(addSql).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+"Commercial|DELETE\s+FROM)\b/iu)
    expect(addSql).not.toContain('VALIDATE CONSTRAINT')
    expect(validateSql).toContain('VALIDATE CONSTRAINT')
    expect(validateSql).not.toContain('ADD COLUMN')

    for (const trigger of [
      'commercial_campaign_activation_reject_offer_v3',
      'commercial_campaign_claim_reject_offer_v3',
      'commercial_acquisition_context_reject_offer_v3',
      'commercial_quote_reject_offer_v3',
    ]) {
      expect(`${addSql}\n${validateSql}`).not.toMatch(new RegExp(`DROP TRIGGER(?: IF EXISTS)? "?${trigger}"?`, 'iu'))
    }
  })

  it('models named v1/v2 and v3 claim/context authorities plus reserved Catalog v2', () => {
    expect(schema).toContain('@relation("CommercialCampaignClaimCampaignV1V2"')
    expect(schema).toContain('@relation("CommercialCampaignClaimOfferV3"')
    expect(schema).toContain('@relation("CommercialAcquisitionContextCampaignV1V2"')
    expect(schema).toContain('@relation("CommercialAcquisitionContextOfferV3"')
    expect(schema).toContain('@relation("CommercialAcquisitionContextReservedCatalogV2"')
    expect(schema).toContain('@@unique([id, schemaVersion], map: "CommercialPublication_id_schemaVersion_key")')
    expect(schema).toContain('model CommercialAcquisitionContextBinding {')
    expect(schema).toContain('@@unique([staffId, purpose]')
    expect(schema).toContain('@@unique([organizationId, purpose]')
    expect(schema).toContain('model CommercialAcquisitionRedemption {')
    expect(schema).toContain('@relation(fields: [venueId, organizationId], references: [id, organizationId]')
  })

  it('adds a future-only Staff creation marker without backfilling legacy identities', () => {
    const addSql = readFileSync(acquisitionAddMigrationPath, 'utf8')

    expect(schema).toContain('commercialCreatedAt')
    expect(schema).toMatch(/commercialCreatedAt\s+DateTime\?\s+@default\(now\(\)\)/u)
    expect(addSql).toContain('ADD COLUMN "commercialCreatedAt" TIMESTAMP(3)')
    expect(addSql).toContain('ALTER COLUMN "commercialCreatedAt" SET DEFAULT CURRENT_TIMESTAMP')
    expect(addSql).not.toMatch(/ADD COLUMN "commercialCreatedAt" TIMESTAMP\(3\)\s+DEFAULT/iu)
    expect(addSql).not.toMatch(/UPDATE\s+"Staff"[\s\S]{0,200}"commercialCreatedAt"/iu)
  })

  it('adds independent redemption uniqueness and immutable binding/redemption ledgers', () => {
    const addSql = readFileSync(acquisitionAddMigrationPath, 'utf8')
    const redemptionLookupIndex = 'CommercialAcqRedemption_org_venue_redeemed_idx'

    for (const uniqueIndex of [
      'CommercialAcquisitionContextBinding_acquisitionContextId_key',
      'CommercialAcquisitionContextBinding_staffId_purpose_key',
      'CommercialAcquisitionContextBinding_organizationId_purpose_key',
      'CommercialAcquisitionRedemption_acquisitionContextId_key',
      'CommercialAcquisitionRedemption_quoteId_key',
      'CommercialAcquisitionRedemption_acceptanceId_key',
    ]) {
      expect(addSql).toContain(uniqueIndex)
    }
    expect(addSql).toContain('commercial_acquisition_context_binding_immutable')
    expect(addSql).toContain('commercial_acquisition_context_binding_truncate_immutable')
    expect(addSql).toContain('commercial_quote_preview_bridge_immutable')
    expect(addSql).toContain('commercial_quote_preview_bridge_truncate_immutable')
    expect(addSql).toContain('commercial_acquisition_redemption_immutable')
    expect(addSql).toContain('commercial_acquisition_redemption_truncate_immutable')
    expect(addSql).toContain('parent_context_exists')
    expect(addSql).toContain("USING ERRCODE = '55000'")
    expect(Buffer.byteLength(redemptionLookupIndex)).toBeLessThanOrEqual(63)
    expect(schema).toContain(
      `@@index([organizationId, venueId, redeemedAt], map: "${redemptionLookupIndex}")`,
    )
    expect(addSql).toContain(`CREATE INDEX "${redemptionLookupIndex}"`)
    expect(addSql).not.toContain('CommercialAcquisitionRedemption_organizationId_venueId_redeemedAt_idx')
  })

  it('separates NOT VALID creation from bounded validation for every new row-shape and source FK', () => {
    const addSql = readFileSync(acquisitionAddMigrationPath, 'utf8')
    const validateSql = readFileSync(acquisitionValidateMigrationPath, 'utf8')
    const constraints = [
      'CommercialCampaignClaim_authority_shape_v3_pending',
      'CommercialCampaignClaim_offerVersionId_offerSchemaVersion_fkey',
      'CommercialAcquisitionContext_authority_shape_v3_pending',
      'CommercialAcqContext_offerVersion_schemaVersion_fkey',
      'CommercialAcqContext_reservedCatalog_schemaVersion_fkey',
      'CommercialQuote_authority_shape_q3b_pending',
      'CommercialQuote_v3_totals_q3b_pending',
    ]

    for (const constraint of constraints) {
      expect(addSql).toContain(`CONSTRAINT "${constraint}"`)
      expect(addSql).toMatch(new RegExp(`CONSTRAINT "${constraint}"[\\s\\S]{0,500}NOT VALID`, 'u'))
      expect(validateSql).toContain(`VALIDATE CONSTRAINT "${constraint}"`)
    }
    expect(validateSql).toContain("SET LOCAL lock_timeout = '2s'")
    expect(validateSql).toContain("SET LOCAL statement_timeout = '30s'")
  })

  it('widens Quote v3 only for verified preview lineage while retaining direct validation', () => {
    const addSql = readFileSync(acquisitionAddMigrationPath, 'utf8')
    const validateSql = readFileSync(acquisitionValidateMigrationPath, 'utf8')

    expect(addSql).toContain('CREATE FUNCTION public.commercial_quote_snapshot_matches_v3_row_q3b(')
    expect(addSql).toContain('public.commercial_quote_snapshot_matches_v3_row(')
    expect(addSql).toContain("p_snapshot->>'acquisitionContextId' IS DISTINCT FROM p_acquisition_context_id")
    expect(addSql).toContain("jsonb_typeof(p_snapshot->'derivedFromPreview') IS DISTINCT FROM 'object'")
    expect(addSql).toContain("NEW.\"snapshot\" #>> '{resolution,resolvedAt}' IS DISTINCT FROM context_created_at")
    expect(addSql).toContain('FROM "CommercialAcquisitionContext"')
    expect(addSql).toContain('reservedCatalogPublicationId')
    expect(addSql).toContain('offerVersionId')
    expect(validateSql.indexOf('VALIDATE CONSTRAINT "CommercialQuote_authority_shape_q3b_pending"')).toBeLessThan(
      validateSql.indexOf('DROP CONSTRAINT "CommercialQuote_authority_shape_check"'),
    )
    expect(validateSql.indexOf('VALIDATE CONSTRAINT "CommercialQuote_v3_totals_q3b_pending"')).toBeLessThan(
      validateSql.indexOf('DROP CONSTRAINT "CommercialQuote_v3_totals_check"'),
    )
    expect(validateSql).toContain('RENAME CONSTRAINT "CommercialQuote_authority_shape_q3b_pending"')
    expect(validateSql).toContain('RENAME CONSTRAINT "CommercialQuote_v3_totals_q3b_pending"')
  })
})
