import { readFileSync } from 'node:fs'
import path from 'node:path'

const migrationPath = path.resolve(
  __dirname,
  '../../../prisma/migrations/20260828200000_add_commercial_offer_v3/migration.sql',
)
const schemaPath = path.resolve(__dirname, '../../../prisma/schema.prisma')

describe('Commercial Offer v3 additive migration', () => {
  const sql = readFileSync(migrationPath, 'utf8')
  const schema = readFileSync(schemaPath, 'utf8')

  it('adds an explicit v2/v3 draft discriminator and normalized v3 benefit storage', () => {
    expect(sql).toContain('CREATE TYPE "CommercialOfferBenefitDraftKind"')
    expect(sql).toContain('ADD COLUMN "offerSchemaVersion" INTEGER NOT NULL DEFAULT 2')
    expect(sql).toContain('CREATE TABLE "CommercialOfferBenefitDraft"')
    expect(sql).toContain('CHECK ("offerSchemaVersion" = 3)')
    expect(sql).toContain('CHECK ("offerSchemaVersion" IN (2, 3))')
    expect(sql).toContain('FOREIGN KEY ("campaignDraftId", "offerSchemaVersion")')
    expect(sql).toContain('REFERENCES "CommercialCampaignDraft"("id", "offerSchemaVersion")')
    expect(sql).toContain('CommercialOfferBenefitDraft_shape_check')

    expect(schema).toMatch(/offerSchemaVersion\s+Int\s+@default\(2\)/)
    expect(schema).toContain('model CommercialOfferBenefitDraft {')
    expect(schema).toContain('@@unique([id, offerSchemaVersion]')
    expect(sql).toContain('FOR KEY SHARE')
    expect(sql.match(/EXECUTE FUNCTION reject_commercial_offer_v3_operational_reference\(\)/g)).toHaveLength(4)
    expect(sql).not.toMatch(/DROP TRIGGER\s+commercial_campaign_version_immutable/i)
  })

  it('extends only campaign-version persistence to schema 3 and leaves quotes/catalogs v1/v2', () => {
    expect(sql).toContain('"CommercialCampaignVersion_schema_version_check" CHECK ("schemaVersion" IN (1, 2, 3))')
    expect(sql).toContain('"snapshot"->>\'schemaVersion\')::NUMERIC BETWEEN 1 AND 3')
    expect(sql).not.toMatch(/ALTER TABLE "CommercialQuote"/)
    expect(sql).not.toMatch(/ALTER TABLE "CommercialPublication"/)
    expect(sql).not.toMatch(/COMMERCIAL_ARTIFACT_CODEC_REGISTRY/)
  })

  it('is additive and does not rewrite existing business rows or certified migrations', () => {
    expect(sql).toMatch(/^BEGIN;/)
    expect(sql).toMatch(/COMMIT;\s*$/)
    expect(sql).not.toMatch(/\bUPDATE\s+"[^"]+"\s+SET\b/i)
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(sql).not.toMatch(/\bTRUNCATE\b/i)
    expect(sql).not.toMatch(/DROP TABLE/i)
    expect(sql).not.toMatch(/DROP TYPE/i)
  })

  it('uses exact integer constraints for quantities, basis points, money and windows', () => {
    expect(sql).toContain('"percentBasisPoints" BETWEEN 1 AND 10000')
    expect(sql).toContain('"quantityLimit" BETWEEN 1 AND 1000')
    expect(sql).toContain('"unitAmountMinor" BETWEEN 0 AND 999999999999')
    expect(sql).toContain('"benefitStartsAt" < "benefitEndsAt"')
  })
})
