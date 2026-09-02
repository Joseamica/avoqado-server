import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { decodeAndVerifyCommercialArtifact } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import {
  COMMERCIAL_ARTIFACT_CODEC_REGISTRY,
  resolveCommercialArtifactCodec,
} from '@/services/commercial/commercialArtifactCodecRegistryDefinition.service'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'

describe('Commercial Offer v3 authority boundaries', () => {
  it('keeps schema 3 outside the certified Catalog/Campaign/Quote registry and fails closed', () => {
    expect(COMMERCIAL_ARTIFACT_CODEC_REGISTRY).toHaveLength(6)
    expect(COMMERCIAL_ARTIFACT_CODEC_REGISTRY.some(entry => Number(entry.schemaVersion) === 3)).toBe(false)
    expect(resolveCommercialArtifactCodec('CAMPAIGN', 3)).toBeUndefined()

    const emitted = emitCommercialOfferV3(offerFixture)
    expect(() =>
      decodeAndVerifyCommercialArtifact({
        kind: 'CAMPAIGN',
        rowSchemaVersion: 3,
        snapshot: emitted.snapshot,
        checksum: emitted.checksum,
        rowContext: {
          kind: 'CAMPAIGN',
          id: emitted.snapshot.campaignVersionId,
          campaignCode: emitted.snapshot.campaignCode,
          sourceRevision: emitted.snapshot.version,
          schemaVersion: 3,
          publishedAt: new Date(emitted.snapshot.publishedAt),
        },
      } as never),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_CAMPAIGN_SCHEMA_UNSUPPORTED' }))
  })

  it('keeps the v3 writer publish-only with no operational authority dependency', () => {
    const source = readFileSync(join(process.cwd(), 'src/services/commercial/offers/commercialOfferPublication.service.ts'), 'utf8')
    for (const forbidden of [
      'commercialCampaignActivation',
      'commercialCampaignClaim',
      'commercialAcquisitionContext',
      'commercialQuote.',
      'createActivation',
      'moveActivationIfRevision',
      'Stripe',
    ]) {
      expect(source).not.toContain(forbidden)
    }
  })

  it('keeps the Offer resolver pure and independent from mutable runtime authorities', () => {
    const source = readFileSync(join(process.cwd(), 'src/services/commercial/offers/commercialOfferStacking.service.ts'), 'utf8')
    for (const forbidden of ['prisma', 'Date.now(', 'new Date(', 'process.env', 'TPV_CATALOG', 'fetch(', 'axios']) {
      expect(source).not.toContain(forbidden)
    }
  })
})
