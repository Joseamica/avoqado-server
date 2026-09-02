import { assertCampaignV1Shape } from './commercialArtifactCodecV1.service'
import { assertVerifiedStoredCommercialCampaignV2, decodeAndVerifyCommercialArtifact } from './commercialArtifactCodecRegistry.service'
import { failCommercialArtifactCodec } from './commercialArtifactCodecErrors.service'
import type { CommercialCampaignDecodeInput, DecodedCommercialCampaign } from '@/types/commercialCodec'

export interface VerifiedCommercialCampaignAuthority {
  readonly artifact: DecodedCommercialCampaign
  readonly campaignVersionId: string
  readonly campaignCode: string
  readonly schemaVersion: 1 | 2
  readonly status: 'ACTIVE' | 'INACTIVE'
  readonly startsAt: string
  readonly endsAt: string
}

export function decodeVerifiedCommercialCampaignAuthority(input: CommercialCampaignDecodeInput): VerifiedCommercialCampaignAuthority {
  const artifact = decodeAndVerifyCommercialArtifact(input)
  if (artifact.kind !== 'CAMPAIGN') failCommercialArtifactCodec('COMMERCIAL_ARTIFACT_VERIFICATION_REQUIRED')

  if (artifact.schemaVersion === 1) {
    assertCampaignV1Shape(artifact.snapshot)
    return Object.freeze({
      artifact,
      campaignVersionId: artifact.snapshot.campaignVersionId,
      campaignCode: artifact.snapshot.campaignCode,
      schemaVersion: 1,
      status: artifact.snapshot.status,
      startsAt: artifact.snapshot.startsAt,
      endsAt: artifact.snapshot.endsAt,
    })
  }

  assertVerifiedStoredCommercialCampaignV2(artifact)
  return Object.freeze({
    artifact,
    campaignVersionId: artifact.snapshot.campaignVersionId,
    campaignCode: artifact.snapshot.campaignCode,
    schemaVersion: 2,
    status: artifact.snapshot.status,
    startsAt: artifact.snapshot.startsAt,
    endsAt: artifact.snapshot.endsAt,
  })
}
