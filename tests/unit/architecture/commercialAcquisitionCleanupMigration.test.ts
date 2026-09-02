import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const read = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')

describe('commercial acquisition context cleanup migration', () => {
  it('keeps the certified phase-2 bytes unchanged', () => {
    const historical = read('prisma/migrations/20260822090000_add_commercial_campaigns_quotes_phase2/migration.sql')
    expect(createHash('sha256').update(historical).digest('hex')).toBe('1a8168b1ec612064d2d1010be8356ed06072955fc73eb037b49d8d2ad858ab52')
  })

  it('adds one dedicated expiry-aware function and recreates only the acquisition trigger', () => {
    const migration = read('prisma/migrations/20260827120000_enable_commercial_acquisition_context_cleanup/migration.sql')

    expect(migration).toContain('CREATE FUNCTION reject_commercial_acquisition_context_unsafe_mutation() RETURNS trigger')
    expect(migration).toContain(
      `IF TG_OP = 'UPDATE' OR (TG_OP = 'DELETE' AND OLD."expiresAt" > (pg_catalog.now() AT TIME ZONE 'UTC') - interval '20 minutes') THEN`,
    )
    expect(migration).toContain("USING ERRCODE = '55000';")
    expect(migration).toContain('DROP TRIGGER "commercial_acquisition_context_immutable" ON "CommercialAcquisitionContext";')
    expect(migration).not.toContain('DROP TRIGGER IF EXISTS')
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "CommercialAcquisitionContext"')
    expect(migration).toContain('EXECUTE FUNCTION reject_commercial_acquisition_context_unsafe_mutation();')
    expect(migration).not.toMatch(/DROP\s+(?:FUNCTION|TRIGGER)[\s\S]*reject_commercial_immutable_mutation/i)
  })

  it('couples deletion eligibility to the preview-token grace period and UTC DB time', () => {
    const service = read('src/services/commercial/commercialAcquisitionContextCleanup.service.ts')

    expect(service).toContain("pg_catalog.now() AT TIME ZONE 'UTC'")
    expect(service.match(/interval '20 minutes'/g)).toHaveLength(3)
    expect(service).not.toMatch(/"expiresAt"\s*<=\s*pg_catalog\.now\(\)/)
  })

  it('preserves a context referenced by either a quote or a durable preview bridge', () => {
    const service = read('src/services/commercial/commercialAcquisitionContextCleanup.service.ts')
    const preservedExpression = service.match(
      /EXISTS \([\s\S]*?\)\s+OR\s+EXISTS \([\s\S]*?CommercialQuotePreviewBridge[\s\S]*?\)\s+AS "preservedReferenced"/,
    )

    expect(preservedExpression).not.toBeNull()
    expect(preservedExpression?.[0]).toContain('FROM "CommercialQuote" AS quote')
    expect(preservedExpression?.[0]).toContain('bridge."acquisitionContextId" = acquisition."id"')
  })
})
