import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const schemaPath = path.join(root, 'prisma/schema.prisma')
const migrationPath = path.join(root, 'prisma/migrations/20260828120000_add_commercial_quote_preview_bridge/migration.sql')

describe('CommercialQuotePreviewBridge additive schema', () => {
  it('declares the exact durable binding and all five inverse relations', () => {
    const schema = fs.readFileSync(schemaPath, 'utf8')

    expect(schema).toContain('model CommercialQuotePreviewBridge {')
    expect(schema).toMatch(/previewQuoteId\s+String\s+@unique @db\.VarChar\(128\)/)
    expect(schema).toMatch(/previewChecksum\s+String\s+@db\.Char\(64\)/)
    expect(schema).toMatch(/venueQuoteId\s+String\s+@unique/)
    expect(schema).toContain('@relation("CommercialPreviewVenueQuote"')
    expect(schema.match(/commercialQuotePreviewBridges/g) ?? []).toHaveLength(4)
    expect(schema).toContain('commercialQuotePreviewBridge CommercialQuotePreviewBridge? @relation("CommercialPreviewVenueQuote")')
  })

  it('creates only the new table with exact RESTRICT FKs, uniques, indexes and checks', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8')

    expect(migration).toContain('CREATE TABLE "CommercialQuotePreviewBridge"')
    expect(migration).toContain('"CommercialQuotePreviewBridge_previewQuoteId_key" UNIQUE ("previewQuoteId")')
    expect(migration).toContain('"CommercialQuotePreviewBridge_venueQuoteId_key" UNIQUE ("venueQuoteId")')
    expect(migration.match(/ON DELETE RESTRICT ON UPDATE CASCADE/g)).toHaveLength(5)
    expect(migration).toContain('char_length("previewQuoteId") BETWEEN 1 AND 128')
    expect(migration).toContain('"previewChecksum" ~ \'^[0-9a-f]{64}$\'')
    expect(migration).toContain('"selectionFingerprint" ~ \'^[0-9a-f]{64}$\'')
    expect(migration).toContain('CREATE INDEX "CommercialQuotePreviewBridge_organizationId_venueId_created_idx"')
    expect(migration).toContain('CREATE INDEX "CommercialQuotePreviewBridge_actorId_createdAt_idx"')
    expect(migration).toContain('CREATE INDEX "CommercialQuotePreviewBridge_acquisitionContextId_createdAt_idx"')
    expect(migration).not.toMatch(/ALTER TABLE "(CommercialQuote|CommercialAcquisitionContext|Organization|Venue|Staff)"/)
  })
})
