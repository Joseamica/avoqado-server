import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import {
  COMMERCIAL_WRITER_ADVISORY_LOCK_KEY,
  COMMERCIAL_WRITER_LOCK_DOMAIN,
} from '@/services/commercial/commercialWriterTransaction.service'

const root = resolve(__dirname, '../../..')

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')
}

function typescriptFiles(directory: string): string[] {
  const absolute = resolve(root, directory)
  return readdirSync(absolute).flatMap(entry => {
    const path = resolve(absolute, entry)
    if (statSync(path).isDirectory()) return typescriptFiles(relative(root, path))
    return path.endsWith('.ts') ? [relative(root, path)] : []
  })
}

describe('Commercial Task 5 entry architecture boundaries', () => {
  it('derives the shared signed-bigint lock key from the canonical domain', () => {
    const derived = createHash('sha256').update(COMMERCIAL_WRITER_LOCK_DOMAIN, 'utf8').digest().readBigInt64BE(0)

    expect(COMMERCIAL_WRITER_LOCK_DOMAIN).toBe('avoqado:commercial:catalog-offer-publication:v1')
    expect(derived).toBe(-2896351599520032041n)
    expect(COMMERCIAL_WRITER_ADVISORY_LOCK_KEY).toBe(derived)
  })

  it.each([
    'src/services/commercial/commercialPublication.service.ts',
    'src/services/commercial/commercialActivation.service.ts',
  ])('keeps %s behind the prepared snapshot runner and the one shared writer lock', path => {
    const body = source(path)

    expect(body).toContain('createCommercialWriterTransactionRunner')
    expect(body).toMatch(/createCommercialWriterTransactionRunner\(\{ host: prisma \}\)/)
    expect(body).toContain('createCommercialEligibleOfferWriterSnapshotRunner')
    expect(body).toContain('runWithEligibleOffers:')
    expect(body).toMatch(/EligibilityRunner\.run\(now,/)
    expect(body).toMatch(/runWithEligibleOffers<T>\s*\(/)
    expect(body).not.toMatch(/runWithEligibleOffers\?<T>\s*\(/)
    expect(body).not.toMatch(/dependencies\.runWithEligibleOffers\s*\?/)
    expect(body).not.toMatch(/prisma\.\$transaction\s*\(/)
  })

  it('keeps Offer publication behind the same shared writer transaction wrapper', () => {
    const body = source('src/services/commercial/offers/commercialOfferPublication.service.ts')

    expect(body).toContain('createCommercialWriterTransactionRunner')
    expect(body).toMatch(/createCommercialWriterTransactionRunner\(\{ host: prisma \}\)/)
    expect(body).toMatch(/WriterTransaction\.run\(async prismaTx =>/)
    expect(body).not.toMatch(/prisma\.\$transaction\s*\(/)
  })

  it('fully verifies immutable Offers before serialization and rechecks their lightweight fingerprint under the lock', () => {
    const body = source('src/services/commercial/offers/commercialEligibleOfferWriterSnapshot.service.ts')
    const preparation = body.indexOf('prepareEligibleCommercialOffersV3(dependencies.reader, now)')
    const serialization = body.indexOf('dependencies.runSerialized(async transaction =>')
    const fingerprint = body.indexOf('assertCommercialOfferEligibilitySnapshotUnchangedV3(transaction, prepared)')

    expect(preparation).toBeGreaterThan(-1)
    expect(serialization).toBeGreaterThan(preparation)
    expect(fingerprint).toBeGreaterThan(serialization)
  })

  it('limits immutable Catalog and Offer v3 writes to their authorized publishers', () => {
    const files = typescriptFiles('src/services/commercial')
    const catalogWriters = files.filter(path => /commercialPublication\.create(?:Many)?\s*\(/.test(source(path)))
    const campaignVersionWriters = files.filter(path => /commercialCampaignVersion\.create(?:Many)?\s*\(/.test(source(path)))

    expect(catalogWriters).toEqual(['src/services/commercial/commercialPublication.service.ts'])
    expect(campaignVersionWriters.sort()).toEqual([
      'src/services/commercial/commercialCampaignPublication.service.ts',
      'src/services/commercial/offers/commercialOfferPublication.service.ts',
    ])
    expect(source('src/services/commercial/commercialCampaignPublication.service.ts')).toContain('schemaVersion: 2')
    expect(source('src/services/commercial/commercialCampaignPublication.service.ts')).not.toContain('schemaVersion: 3')
    expect(source('src/services/commercial/offers/commercialOfferPublication.service.ts')).toContain('schemaVersion: 3')

    const forbiddenPrismaMutators = files.filter(path =>
      /commercialCampaignVersion\.(?:update|updateMany|upsert|delete|deleteMany)\s*\(/.test(source(path)),
    )
    const rawVersionMutators = files.filter(path =>
      /(?:UPDATE|DELETE\s+FROM)\s+["'`]CommercialCampaignVersion["'`]/i.test(source(path)),
    )
    expect(forbiddenPrismaMutators).toEqual([])
    expect(rawVersionMutators).toEqual([])

    const immutableMigration = source(
      'prisma/migrations/20260822090000_add_commercial_campaigns_quotes_phase2/migration.sql',
    )
    const immutableIntegration = source('tests/integration/commercial/commercial-offer-v3.integration.test.ts')
    expect(immutableMigration).toMatch(
      /CREATE TRIGGER commercial_campaign_version_immutable\s+BEFORE UPDATE OR DELETE ON "CommercialCampaignVersion"/,
    )
    expect(immutableIntegration).toContain(
      'UPDATE "CommercialCampaignVersion" SET "reason" = \'mutated\'',
    )
    expect(immutableIntegration).toContain('DELETE FROM "CommercialCampaignVersion"')
  })

  it('keeps the frozen revision-2 resolver behind the permanent version registry', () => {
    const consumers = typescriptFiles('src/services/commercial').filter(path =>
      source(path).includes("from './commercialOfferStacking.service'"),
    )

    expect(consumers).toEqual(['src/services/commercial/offers/commercialOfferResolutionRegistry.service.ts'])
    for (const path of [
      'src/services/commercial/quotes-v3/commercialQuoteV3Contract.service.ts',
      'src/services/commercial/quotes-v3/commercialQuoteV3Engine.service.ts',
      'src/services/commercial/offers/commercialCatalogOfferCompatibility.service.ts',
    ]) {
      expect(source(path)).toContain('commercialOfferResolutionRegistry.service')
      expect(source(path)).not.toContain('commercialOfferStacking.service')
    }
  })

  it('keeps the revision-2 alias private to the registry for every production commercial consumer', () => {
    const consumers = typescriptFiles('src').filter(path =>
      source(path).includes('resolveCommercialOfferV3Revision2'),
    )

    expect(consumers).toEqual(['src/services/commercial/offers/commercialOfferResolutionRegistry.service.ts'])
  })

  it('pins revision-2 decision branches to the resolver and its one audited proof classifier', () => {
    const files = typescriptFiles('src/services/commercial')
    const semanticDecisionOwners = files.filter(path =>
      /(?:exactStackingGroups|exactGroups)\.length > 1/.test(source(path)) ||
      /(?:ordered\[0\]\.rule\.priority === ordered\[1\]\.rule\.priority|priorities\[0\] === priorities\[1\])/.test(source(path)),
    )

    expect(semanticDecisionOwners.sort()).toEqual([
      'src/services/commercial/offers/commercialCatalogOfferCompatibility.service.ts',
      'src/services/commercial/offers/commercialOfferStacking.service.ts',
    ])
    expect(source('src/services/commercial/offers/commercialCatalogOfferCompatibility.service.ts')).toContain(
      'resolutionRevision2ProofClass(',
    )
  })

  it('wraps every pair-compatibility writer door in the shared outside-transaction observer', () => {
    for (const path of [
      'src/services/commercial/commercialPublication.service.ts',
      'src/services/commercial/commercialActivation.service.ts',
      'src/services/commercial/offers/commercialOfferPublication.service.ts',
    ]) {
      expect(source(path)).toContain('commercialCompatibilityObservability.service')
      expect(source(path)).toContain('runWithCommercialCompatibilityObservation(')
    }
  })

  it('keeps one Quote v3 rule-to-line matcher for Contract, Engine and pair validation', () => {
    const matcherPath = 'src/services/commercial/quotes-v3/commercialQuoteV3RuleMatcher.service.ts'
    const matchingImplementations = typescriptFiles('src/services/commercial').filter(path =>
      source(path).includes('rule.target.productCodes?.includes(line.targetCode)'),
    )

    expect(matchingImplementations).toEqual([
      'src/services/commercial/commercialQuoteContractV2.service.ts',
      matcherPath,
    ])
    for (const path of [
      'src/services/commercial/quotes-v3/commercialQuoteV3Contract.service.ts',
      'src/services/commercial/quotes-v3/commercialQuoteV3Engine.service.ts',
      'src/services/commercial/offers/commercialCatalogOfferCompatibility.service.ts',
    ]) {
      expect(source(path)).toContain('commercialQuoteV3RuleMatcher.service')
    }
  })
})
