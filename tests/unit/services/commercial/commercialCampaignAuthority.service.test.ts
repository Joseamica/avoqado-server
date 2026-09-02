import campaignFixtureV1 from '@/contracts/commercial/fixtures/campaign-pos-50-v1.json'
import campaignFixtureV2 from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  CommercialArtifactCodecError,
  decodeAndVerifyCommercialArtifact,
} from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { decodeVerifiedCommercialCampaignAuthority } from '@/services/commercial/commercialCampaignAuthority.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import type { CommercialCampaignVersionV1 } from '@/types/commercialQuote'
import type { CommercialCampaignSnapshotV2 } from '@/types/commercialV2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function inputV1(snapshot: CommercialCampaignVersionV1 = clone(campaignFixtureV1) as CommercialCampaignVersionV1) {
  return {
    kind: 'CAMPAIGN' as const,
    rowSchemaVersion: 1,
    snapshot,
    checksum: hashCanonicalJsonV1('commercial-campaign-snapshot-v1', snapshot),
    rowContext: {
      kind: 'CAMPAIGN' as const,
      id: snapshot.campaignVersionId,
      campaignCode: snapshot.campaignCode,
      sourceRevision: snapshot.version,
      schemaVersion: 1,
      publishedAt: new Date('2026-07-31T06:00:00.000Z'),
    },
  }
}

function inputV2(snapshot: CommercialCampaignSnapshotV2 = clone(campaignFixtureV2) as unknown as CommercialCampaignSnapshotV2) {
  return {
    kind: 'CAMPAIGN' as const,
    rowSchemaVersion: 2,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CAMPAIGN_SNAPSHOT, snapshot),
    rowContext: {
      kind: 'CAMPAIGN' as const,
      id: snapshot.campaignVersionId,
      campaignCode: snapshot.campaignCode,
      sourceRevision: snapshot.version,
      schemaVersion: 2,
      publishedAt: new Date(snapshot.publishedAt),
    },
  }
}

function expectCodecCode(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('Expected codec error')
  } catch (error) {
    expect(error).toBeInstanceOf(CommercialArtifactCodecError)
    expect(error).toMatchObject({ code })
  }
}

describe('commercial campaign authority', () => {
  it.each([
    ['historical v1', inputV1(), 1, 'READ_ONLY'],
    ['current v2', inputV2(), 2, 'READ_WRITE'],
  ] as const)('returns one verified %s artifact and only shared identity/window fields', (_label, input, schemaVersion, mode) => {
    const authority = decodeVerifiedCommercialCampaignAuthority(input)

    expect(authority).toMatchObject({
      campaignVersionId: 'campaign-version-pos-50-v' + schemaVersion,
      campaignCode: 'POS_50',
      schemaVersion,
      status: 'ACTIVE',
      startsAt: '2026-08-01T06:00:00.000Z',
      endsAt: '2026-09-01T06:00:00.000Z',
      artifact: { kind: 'CAMPAIGN', schemaVersion, mode },
    })
    expect(Object.keys(authority).sort()).toEqual(
      ['artifact', 'campaignCode', 'campaignVersionId', 'endsAt', 'schemaVersion', 'startsAt', 'status'].sort(),
    )
    expect(Object.isFrozen(authority.artifact)).toBe(true)
  })

  it('returns the same verified artifact semantics as the frozen registry', () => {
    const input = inputV2()
    const authority = decodeVerifiedCommercialCampaignAuthority(input)
    const registryArtifact = decodeAndVerifyCommercialArtifact(input)

    expect(authority.artifact).toEqual(registryArtifact)
    expect(authority.artifact.checksum).toBe(input.checksum)
  })

  it.each([
    ['v1 checksum', () => ({ ...inputV1(), checksum: '0'.repeat(64) }), 'COMMERCIAL_CAMPAIGN_CHECKSUM_INVALID'],
    [
      'v2 row identity',
      () => ({ ...inputV2(), rowContext: { ...inputV2().rowContext, campaignCode: 'OTHER' } }),
      'COMMERCIAL_CAMPAIGN_IDENTITY_MISMATCH',
    ],
  ])('fails closed for invalid %s authority', (_label, createInput, code) => {
    expectCodecCode(() => decodeVerifiedCommercialCampaignAuthority(createInput()), code)
  })
})
