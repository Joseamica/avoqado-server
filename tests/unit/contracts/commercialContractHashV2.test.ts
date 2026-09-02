import checkoutRequestFingerprint from '@/contracts/commercial/vectors/v2/checkout-request-fingerprint.json'
import selectionFingerprint from '@/contracts/commercial/vectors/v2/selection-fingerprint.json'
import catalogSchemaAlias from '@/contracts/commercial/commercial-catalog-v2.schema.json'
import catalogFixtureAlias from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import pricingVectorsAlias from '@/contracts/commercial/fixtures/v2/pricing-vectors.json'
import quotePos50Acquisition from '@/contracts/commercial/fixtures/v2/quote-pos-50-acquisition.json'
import quotePos50Venue from '@/contracts/commercial/fixtures/v2/quote-pos-50-venue.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { COMMERCIAL_CONTRACT_HASH } from '@/contracts/commercial/contractHash'
import {
  COMMERCIAL_CONTRACT_V2_ARTIFACT_HASHES,
  COMMERCIAL_CONTRACT_V2_BUNDLE_HASH,
  buildCommercialContractArtifactPreimageV2,
  buildCommercialContractBundlePreimageV2,
  computeCommercialContractArtifactHashV2,
  computeCommercialContractBundleHashV2,
  parseCommercialContractControlledJsonV2,
} from '@/contracts/commercial/commercialContractHashV2'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'

describe('commercial contract hashes v2', () => {
  it('freezes individual artifact and bundle digests', () => {
    expect(COMMERCIAL_CONTRACT_V2_ARTIFACT_HASHES).toEqual({
      CATALOG: 'd7380618527c005635b1f4098f929e4ee942aa2cc6fb81cc02baf7334276db91',
      CAMPAIGN: 'c086841a458e2b6cfd3ec26b094e55f6ba4486b038481624699a51c22c6081fd',
      QUOTE: 'c7283f2ac358fc8d169c5c130647d5796a9f8ecb4db85adc5ed9ddd9d01b670e',
      ENTITLEMENTS: '68c272adbb9d7cb4b2a982fb04a12165f3b753f0617100cfe816c8b58cc3109b',
      LIFECYCLE: '73220924b3239bbe7aab393511a260c4ebe907cb77737fb06386c38f4d655c7f',
    })
    expect(COMMERCIAL_CONTRACT_V2_BUNDLE_HASH).toBe('a1755221256332250bb43a8e2130a62b25309c5a3917e555b0261dd652cb334d')
  })

  it('uses the exact artifact fixture mapping and logical bundle key sets', () => {
    expect(Object.keys(buildCommercialContractArtifactPreimageV2('CATALOG').fixtures)).toEqual(['catalogBase'])
    expect(Object.keys(buildCommercialContractArtifactPreimageV2('CAMPAIGN').fixtures)).toEqual(['campaignPos50'])
    expect(Object.keys(buildCommercialContractArtifactPreimageV2('QUOTE').fixtures)).toEqual(['quotePos50Acquisition', 'quotePos50Venue'])
    expect(Object.keys(buildCommercialContractArtifactPreimageV2('ENTITLEMENTS').fixtures)).toEqual(['entitlementPos'])
    expect(Object.keys(buildCommercialContractArtifactPreimageV2('LIFECYCLE').fixtures)).toEqual(['lifecycleVocabulary'])

    const bundle = buildCommercialContractBundlePreimageV2()
    expect(Object.keys(bundle.schemas)).toEqual(['catalog', 'campaign', 'quote', 'entitlements', 'lifecycle'])
    expect(Object.keys(bundle.fixtures)).toEqual([
      'catalogBase',
      'campaignPos50',
      'quotePos50Acquisition',
      'quotePos50Venue',
      'entitlementPos',
      'lifecycleVocabulary',
    ])
    expect(Object.keys(bundle.vectors)).toEqual([
      'pricing',
      'moneyLimits',
      'migration',
      'rfc8785Official',
      'rfc8785Adversarial',
      'selectionFingerprint',
      'checkoutRequestFingerprint',
    ])
  })

  it('changes only the digest whose preimage changes', () => {
    const catalog = buildCommercialContractArtifactPreimageV2('CATALOG')
    const changedCatalog = JSON.parse(JSON.stringify(catalog)) as any
    changedCatalog.fixtures.catalogBase.publicationId = 'changed'
    expect(computeCommercialContractArtifactHashV2('CATALOG', changedCatalog)).not.toBe(
      computeCommercialContractArtifactHashV2('CATALOG', catalog),
    )
    expect(computeCommercialContractArtifactHashV2('CAMPAIGN')).toBe(COMMERCIAL_CONTRACT_V2_ARTIFACT_HASHES.CAMPAIGN)

    const bundle = buildCommercialContractBundlePreimageV2()
    const changedBundle = JSON.parse(JSON.stringify(bundle)) as any
    changedBundle.vectors.migration.cases[0].identity = 'changed'
    expect(computeCommercialContractBundleHashV2(changedBundle)).not.toBe(COMMERCIAL_CONTRACT_V2_BUNDLE_HASH)
  })

  it('preserves v1 and A1 sentinels exactly', () => {
    expect(COMMERCIAL_CONTRACT_HASH).toBe('aaee77e19f7cf51bcd9087c6e4f043bef759fa53857b80f3ee2d84a20317eb12')
    expect(selectionFingerprint.digestSha256).toBe('934a31d9b6495822a10bb8d4d07b17920982dcf13583eea0b1f8e9e6184d9eea')
    expect(checkoutRequestFingerprint.digestSha256).toBe('f62be01898cc507240e3e6ae496b1f7544c5780151a257b4a629a34f3b923673')
  })

  it('binds the derived VENUE fixture to the exact acquisition preview checksum and selection fingerprint', () => {
    expect(quotePos50Venue.derivedFromPreview.previewQuoteId).toBe(quotePos50Acquisition.quoteId)
    expect(quotePos50Venue.derivedFromPreview.previewChecksum).toBe(hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.QUOTE, quotePos50Acquisition))
    expect(quotePos50Venue.derivedFromPreview.selectionFingerprint).toBe(selectionFingerprint.digestSha256)
    expect(Date.parse(quotePos50Venue.quotedAt)).toBeLessThanOrEqual(Date.parse(quotePos50Acquisition.expiresAt))
  })

  it('strict-parses controlled source text and rejects duplicate root or nested keys', () => {
    expect(() => parseCommercialContractControlledJsonV2('{"schemaVersion":2,"schemaVersion":2}')).toThrow(
      'COMMERCIAL_JSON_TEXT_V2_INVALID',
    )
    expect(() => parseCommercialContractControlledJsonV2('{"root":{"code":"A","code":"B"}}')).toThrow('COMMERCIAL_JSON_TEXT_V2_INVALID')
  })

  it('keeps private controlled inputs isolated from JSON module-cache aliases', () => {
    const originalSchemaId = catalogSchemaAlias.$id
    const originalPublicationId = catalogFixtureAlias.publicationId
    const originalVectorCode = pricingVectorsAlias.vectors[0].code
    try {
      catalogSchemaAlias.$id = 'caller-mutated-schema'
      catalogFixtureAlias.publicationId = 'caller-mutated-fixture'
      pricingVectorsAlias.vectors[0].code = 'CALLER_MUTATED_VECTOR'

      const catalog = buildCommercialContractArtifactPreimageV2('CATALOG') as any
      const bundle = buildCommercialContractBundlePreimageV2() as any
      expect(catalog.schema.$id).toBe('https://api.avoqado.io/contracts/commercial/catalog-v2.schema.json')
      expect(catalog.fixtures.catalogBase.publicationId).toBe('commercial-catalog-initial-v2')
      expect(bundle.vectors.pricing.vectors[0].code).toBe('POS_BASE')
      expect(computeCommercialContractArtifactHashV2('CATALOG')).toBe(COMMERCIAL_CONTRACT_V2_ARTIFACT_HASHES.CATALOG)
      expect(computeCommercialContractBundleHashV2()).toBe(COMMERCIAL_CONTRACT_V2_BUNDLE_HASH)
    } finally {
      catalogSchemaAlias.$id = originalSchemaId
      catalogFixtureAlias.publicationId = originalPublicationId
      pricingVectorsAlias.vectors[0].code = originalVectorCode
    }
  })

  it('returns fresh deeply frozen preimages without exposing private controlled inputs', () => {
    expect(Object.isFrozen(COMMERCIAL_CONTRACT_V2_ARTIFACT_HASHES)).toBe(true)

    const artifact = buildCommercialContractArtifactPreimageV2('CATALOG') as any
    expect(Object.isFrozen(artifact)).toBe(true)
    expect(Object.isFrozen(artifact.schema)).toBe(true)
    expect(Object.isFrozen(artifact.fixtures.catalogBase.products[0])).toBe(true)
    expect(() => {
      artifact.fixtures.catalogBase.publicationId = 'caller-mutation'
    }).toThrow(TypeError)
    expect((buildCommercialContractArtifactPreimageV2('CATALOG').fixtures.catalogBase as any).publicationId).toBe(
      'commercial-catalog-initial-v2',
    )

    const bundle = buildCommercialContractBundlePreimageV2() as any
    expect(Object.isFrozen(bundle)).toBe(true)
    expect(Object.isFrozen(bundle.vectors.pricing.vectors[0])).toBe(true)
    expect(() => {
      bundle.fixtures.catalogBase.publicationId = 'caller-mutation'
    }).toThrow(TypeError)
    expect((buildCommercialContractBundlePreimageV2().fixtures.catalogBase as any).publicationId).toBe('commercial-catalog-initial-v2')
  })
})
