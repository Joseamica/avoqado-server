import { COMMERCIAL_V2_DOMAINS } from './commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  loadCommercialContractControlledJsonV2,
  materializeCommercialContractV2Json,
} from '@/services/commercial/commercialContractV2Materialization.service'

export { parseCommercialContractControlledJsonV2 } from '@/services/commercial/commercialContractV2Materialization.service'

export type CommercialContractArtifactKindV2 = 'CATALOG' | 'CAMPAIGN' | 'QUOTE' | 'ENTITLEMENTS' | 'LIFECYCLE'

const controlledPath = (relativePath: string) => require.resolve(`./${relativePath}`)
const load = (relativePath: string): any => loadCommercialContractControlledJsonV2(controlledPath(relativePath))

const catalogSchema = load('commercial-catalog-v2.schema.json')
const campaignSchema = load('commercial-campaign-v2.schema.json')
const quoteSchema = load('commercial-quote-v2.schema.json')
const entitlementsSchema = load('commercial-entitlements-v2.schema.json')
const lifecycleSchema = load('commercial-lifecycle-v2.schema.json')
const catalogBase = load('fixtures/v2/catalog-base.json')
const campaignPos50 = load('fixtures/v2/campaign-pos-50.json')
const quotePos50Acquisition = load('fixtures/v2/quote-pos-50-acquisition.json')
const quotePos50Venue = load('fixtures/v2/quote-pos-50-venue.json')
const entitlementPos = load('fixtures/v2/entitlement-pos.json')
const lifecycleVocabulary = load('fixtures/v2/lifecycle-vocabulary.json')
const pricing = load('fixtures/v2/pricing-vectors.json')
const migration = load('fixtures/v2/migration-vectors.json')
const moneyLimits = load('vectors/v2/money-limits.json')
const rfc8785Official = load('vectors/v2/rfc8785-official.json')
const rfc8785Adversarial = load('vectors/v2/rfc8785-adversarial.json')
const selectionFingerprint = load('vectors/v2/selection-fingerprint.json')
const checkoutRequestFingerprint = load('vectors/v2/checkout-request-fingerprint.json')

const ARTIFACTS = {
  CATALOG: { schema: catalogSchema, fixtures: { catalogBase }, domain: COMMERCIAL_V2_DOMAINS.CONTRACT_CATALOG },
  CAMPAIGN: { schema: campaignSchema, fixtures: { campaignPos50 }, domain: COMMERCIAL_V2_DOMAINS.CONTRACT_CAMPAIGN },
  QUOTE: {
    schema: quoteSchema,
    fixtures: { quotePos50Acquisition, quotePos50Venue },
    domain: COMMERCIAL_V2_DOMAINS.CONTRACT_QUOTE,
  },
  ENTITLEMENTS: {
    schema: entitlementsSchema,
    fixtures: { entitlementPos },
    domain: COMMERCIAL_V2_DOMAINS.CONTRACT_ENTITLEMENTS,
  },
  LIFECYCLE: {
    schema: lifecycleSchema,
    fixtures: { lifecycleVocabulary },
    domain: COMMERCIAL_V2_DOMAINS.CONTRACT_LIFECYCLE,
  },
} as const

export function buildCommercialContractArtifactPreimageV2<Kind extends CommercialContractArtifactKindV2>(kind: Kind) {
  const artifact = ARTIFACTS[kind]
  return materializeCommercialContractV2Json<{
    schemaVersion: 2
    contractVersion: '2.0.0'
    artifactKind: Kind
    schema: (typeof ARTIFACTS)[Kind]['schema']
    fixtures: (typeof ARTIFACTS)[Kind]['fixtures']
  }>({
    schemaVersion: 2,
    contractVersion: '2.0.0',
    artifactKind: kind,
    schema: artifact.schema,
    fixtures: artifact.fixtures,
  })
}

export function computeCommercialContractArtifactHashV2(
  kind: CommercialContractArtifactKindV2,
  preimage: unknown = buildCommercialContractArtifactPreimageV2(kind),
): string {
  return hashCanonicalJsonV2(ARTIFACTS[kind].domain, preimage)
}

export function buildCommercialContractBundlePreimageV2() {
  return materializeCommercialContractV2Json<{
    schemaVersion: 2
    contractVersion: '2.0.0'
    schemas: Record<string, any>
    fixtures: Record<string, any>
    vectors: Record<string, any>
  }>({
    schemaVersion: 2,
    contractVersion: '2.0.0',
    schemas: {
      catalog: catalogSchema,
      campaign: campaignSchema,
      quote: quoteSchema,
      entitlements: entitlementsSchema,
      lifecycle: lifecycleSchema,
    },
    fixtures: {
      catalogBase,
      campaignPos50,
      quotePos50Acquisition,
      quotePos50Venue,
      entitlementPos,
      lifecycleVocabulary,
    },
    vectors: {
      pricing,
      moneyLimits,
      migration,
      rfc8785Official,
      rfc8785Adversarial,
      selectionFingerprint,
      checkoutRequestFingerprint,
    },
  })
}

export function computeCommercialContractBundleHashV2(preimage: unknown = buildCommercialContractBundlePreimageV2()): string {
  return hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CONTRACT_BUNDLE, preimage)
}

export const COMMERCIAL_CONTRACT_V2_ARTIFACT_HASHES = Object.freeze({
  CATALOG: computeCommercialContractArtifactHashV2('CATALOG'),
  CAMPAIGN: computeCommercialContractArtifactHashV2('CAMPAIGN'),
  QUOTE: computeCommercialContractArtifactHashV2('QUOTE'),
  ENTITLEMENTS: computeCommercialContractArtifactHashV2('ENTITLEMENTS'),
  LIFECYCLE: computeCommercialContractArtifactHashV2('LIFECYCLE'),
})

export const COMMERCIAL_CONTRACT_V2_BUNDLE_HASH = computeCommercialContractBundleHashV2()
