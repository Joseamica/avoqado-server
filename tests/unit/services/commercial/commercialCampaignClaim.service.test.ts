import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import campaignFixtureV1 from '@/contracts/commercial/fixtures/campaign-pos-50-v1.json'
import campaignFixtureV2 from '@/contracts/commercial/fixtures/v2/campaign-pos-50.json'
import { COMMERCIAL_V2_DOMAINS } from '@/contracts/commercial/commercialContractV2.constants'
import { hashCanonicalJsonV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import {
  createCommercialCampaignClaimService,
  prismaCommercialCampaignClaimRepository,
  type CommercialCampaignClaimRepository,
} from '@/services/commercial/commercialCampaignClaim.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'

const now = new Date('2026-08-22T15:00:00.000Z')
const rawToken = 'C'.repeat(43)
const actor = {
  staffId: 'staff-publisher',
  reason: 'Crear enlace para Meta CDMX',
  permissions: ['commercial:publish'],
}

function fakeAuthority(schemaVersion: 1 | 2 = 1) {
  return {
    artifact: { kind: 'CAMPAIGN', schemaVersion } as never,
    campaignVersionId: 'campaign-version-1',
    campaignCode: 'POS_INTRO_2026',
    schemaVersion,
    status: 'ACTIVE' as const,
    startsAt: '2026-08-01T06:00:00.000Z',
    endsAt: '2026-09-01T06:00:00.000Z',
  }
}

function storedCampaignVersion(schemaVersion: 1 | 2) {
  if (schemaVersion === 1) {
    const snapshot = {
      ...campaignFixtureV1,
      campaignVersionId: 'campaign-version-1',
      campaignCode: 'POS_INTRO_2026',
    }
    return {
      id: snapshot.campaignVersionId,
      campaignCode: snapshot.campaignCode,
      sourceRevision: snapshot.version,
      schemaVersion,
      snapshot,
      checksum: hashCanonicalJsonV1('commercial-campaign-snapshot-v1', snapshot),
      publishedAt: new Date('2026-07-31T06:00:00.000Z'),
    }
  }
  const snapshot = {
    ...campaignFixtureV2,
    campaignVersionId: 'campaign-version-1',
    campaignCode: 'POS_INTRO_2026',
  }
  return {
    id: snapshot.campaignVersionId,
    campaignCode: snapshot.campaignCode,
    sourceRevision: snapshot.version,
    schemaVersion,
    snapshot,
    checksum: hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.CAMPAIGN_SNAPSHOT, snapshot),
    publishedAt: new Date(snapshot.publishedAt),
  }
}

function harness() {
  const rows = new Map<string, any>()
  const repository = {
    findActiveCampaign: jest.fn<
      ReturnType<CommercialCampaignClaimRepository['findActiveCampaign']>,
      Parameters<CommercialCampaignClaimRepository['findActiveCampaign']>
    >(async () => ({
      campaignVersionId: 'campaign-version-1',
      campaignCode: 'POS_INTRO_2026',
      authority: fakeAuthority(),
    })),
    createWithAudit: jest.fn(async (record, _audit) => {
      rows.set(record.tokenHash, record)
    }),
    findByTokenHash: jest.fn(async tokenHash => {
      const row = rows.get(tokenHash)
      return row
        ? {
            ...row,
            activeCampaignVersionId: row.campaignVersionId,
            campaignAuthority: fakeAuthority(),
          }
        : null
    }),
  }
  const service = createCommercialCampaignClaimService({
    repository,
    randomToken: () => rawToken,
    randomId: () => 'campaign-claim-1',
  })
  return { repository, rows, service }
}

describe('commercial campaign acquisition claims', () => {
  it('issues a one-time-visible opaque claim and stores only its hash with fixed attribution', async () => {
    const { repository, service } = harness()

    await expect(
      service.issue(
        {
          campaignCode: 'POS_INTRO_2026',
          campaignVersionId: 'campaign-version-1',
          channel: 'PAID_META',
          sourceRef: 'adset-cdmx-restaurants',
          expiresAt: '2026-08-30T06:00:00.000Z',
          confirm: true,
        },
        actor,
        now,
      ),
    ).resolves.toEqual({ claim: rawToken, expiresAt: '2026-08-30T06:00:00.000Z' })

    expect(repository.createWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'campaign-claim-1',
        tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        campaignVersionId: 'campaign-version-1',
        campaignCode: 'POS_INTRO_2026',
        channel: 'PAID_META',
        sourceRef: 'adset-cdmx-restaurants',
        issuedById: actor.staffId,
      }),
      expect.objectContaining({ action: 'COMMERCIAL_ACQUISITION_CLAIM_ISSUED', staffId: actor.staffId }),
    )
    expect(JSON.stringify(repository.createWithAudit.mock.calls)).not.toContain(rawToken)
  })

  it('rejects missing publisher permission, inactive versions and unsafe expiry windows', async () => {
    const { repository, service } = harness()
    const input = {
      campaignCode: 'POS_INTRO_2026',
      campaignVersionId: 'campaign-version-1',
      channel: 'PAID_META' as const,
      sourceRef: 'adset-cdmx-restaurants',
      expiresAt: '2026-08-30T06:00:00.000Z',
      confirm: true as const,
    }

    await expect(service.issue(input, { ...actor, permissions: [] }, now)).rejects.toMatchObject({
      code: 'COMMERCIAL_CAMPAIGN_CLAIM_FORBIDDEN',
    })
    repository.findActiveCampaign.mockResolvedValueOnce(null)
    await expect(service.issue(input, actor, now)).rejects.toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_NOT_ACTIVE' })
    await expect(service.issue({ ...input, expiresAt: '2026-09-02T06:00:00.000Z' }, actor, now)).rejects.toMatchObject({
      code: 'COMMERCIAL_CAMPAIGN_CLAIM_EXPIRY_INVALID',
    })
    expect(repository.createWithAudit).not.toHaveBeenCalled()
  })

  it('fails closed when an internal caller forges the acquisition channel or audit reason', async () => {
    const { repository, service } = harness()
    const input = {
      campaignCode: 'POS_INTRO_2026',
      campaignVersionId: 'campaign-version-1',
      channel: 'PAID_META' as const,
      sourceRef: 'adset-cdmx-restaurants',
      expiresAt: '2026-08-30T06:00:00.000Z',
      confirm: true as const,
    }

    await expect(service.issue({ ...input, channel: 'ORGANIC' } as unknown as typeof input, actor, now)).rejects.toMatchObject({
      code: 'COMMERCIAL_CAMPAIGN_CLAIM_INVALID',
    })
    await expect(service.issue(input, { ...actor, reason: ' x ' }, now)).rejects.toMatchObject({
      code: 'COMMERCIAL_CAMPAIGN_CLAIM_INVALID',
    })
    await expect(service.issue(input, { ...actor, reason: 'x'.repeat(501) }, now)).rejects.toMatchObject({
      code: 'COMMERCIAL_CAMPAIGN_CLAIM_INVALID',
    })
    expect(repository.findActiveCampaign).not.toHaveBeenCalled()
    expect(repository.createWithAudit).not.toHaveBeenCalled()
  })

  it('resolves only an unexpired claim whose exact campaign version is still active', async () => {
    const { repository, service } = harness()
    await service.issue(
      {
        campaignCode: 'POS_INTRO_2026',
        campaignVersionId: 'campaign-version-1',
        channel: 'DISTRIBUTOR',
        sourceRef: 'partner-cdmx-01',
        expiresAt: '2026-08-30T06:00:00.000Z',
        confirm: true,
      },
      actor,
      now,
    )

    await expect(service.resolve(rawToken, new Date('2026-08-23T15:00:00.000Z'))).resolves.toEqual({
      campaignVersionId: 'campaign-version-1',
      campaignCode: 'POS_INTRO_2026',
      channel: 'DISTRIBUTOR',
      sourceRef: 'partner-cdmx-01',
    })

    repository.findByTokenHash.mockImplementationOnce(async tokenHash => ({
      ...repository.createWithAudit.mock.calls[0][0],
      tokenHash,
      activeCampaignVersionId: 'campaign-version-2',
      campaignAuthority: fakeAuthority(),
    }))
    await expect(service.resolve(rawToken, new Date('2026-08-23T15:00:00.000Z'))).rejects.toMatchObject({
      code: 'COMMERCIAL_CAMPAIGN_NOT_ACTIVE',
    })
  })

  it('fails closed for malformed, unknown and expired claims', async () => {
    const { service } = harness()
    await service.issue(
      {
        campaignCode: 'POS_INTRO_2026',
        campaignVersionId: 'campaign-version-1',
        channel: 'PAID_GOOGLE',
        sourceRef: 'google-pos-01',
        expiresAt: '2026-08-30T06:00:00.000Z',
        confirm: true,
      },
      actor,
      now,
    )

    await expect(service.resolve('short', now)).rejects.toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_CLAIM_INVALID' })
    await expect(service.resolve('D'.repeat(43), now)).rejects.toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_CLAIM_NOT_FOUND' })
    await expect(service.resolve(rawToken, new Date('2026-08-30T06:00:00.000Z'))).rejects.toMatchObject({
      code: 'COMMERCIAL_CAMPAIGN_CLAIM_EXPIRED',
    })
  })

  it('rejects resolution when the joined stored campaign authority is invalid', async () => {
    const { repository, service } = harness()
    await service.issue(
      {
        campaignCode: 'POS_INTRO_2026',
        campaignVersionId: 'campaign-version-1',
        channel: 'PAID_GOOGLE',
        sourceRef: 'google-pos-01',
        expiresAt: '2026-08-30T06:00:00.000Z',
        confirm: true,
      },
      actor,
      now,
    )
    repository.findByTokenHash.mockImplementationOnce(async tokenHash => ({
      ...repository.createWithAudit.mock.calls[0][0],
      tokenHash,
      activeCampaignVersionId: 'campaign-version-1',
      campaignAuthority: null,
    }))

    await expect(service.resolve(rawToken, new Date('2026-08-23T15:00:00.000Z'))).rejects.toMatchObject({
      statusCode: 409,
      code: 'COMMERCIAL_CAMPAIGN_NOT_ACTIVE',
    })
  })

  it.each([1, 2] as const)('registry-verifies an exact active schema-v%s artifact before issue', async schemaVersion => {
    const campaignVersion = storedCampaignVersion(schemaVersion)
    prismaMock.commercialCampaignActivation = {
      findUnique: jest.fn(async () => ({
        id: 'activation-1',
        campaignCode: campaignVersion.campaignCode,
        campaignVersionId: campaignVersion.id,
        revision: 1,
        campaignVersion,
      })),
    }

    await expect(
      prismaCommercialCampaignClaimRepository.findActiveCampaign(
        campaignVersion.campaignCode,
        campaignVersion.id,
        new Date('2026-08-22T15:00:00.000Z'),
      ),
    ).resolves.toMatchObject({
      campaignVersionId: campaignVersion.id,
      campaignCode: campaignVersion.campaignCode,
      authority: { schemaVersion, status: 'ACTIVE' },
    })
  })

  it('fails closed before issue when the active stored artifact is tampered', async () => {
    const campaignVersion = { ...storedCampaignVersion(2), checksum: '0'.repeat(64) }
    prismaMock.commercialCampaignActivation = {
      findUnique: jest.fn(async () => ({
        id: 'activation-1',
        campaignCode: campaignVersion.campaignCode,
        campaignVersionId: campaignVersion.id,
        revision: 1,
        campaignVersion,
      })),
    }

    await expect(
      prismaCommercialCampaignClaimRepository.findActiveCampaign(
        campaignVersion.campaignCode,
        campaignVersion.id,
        new Date('2026-08-22T15:00:00.000Z'),
      ),
    ).resolves.toBeNull()
  })

  it('resolves claim, joined version and production pointer in one repeatable-read snapshot', async () => {
    const campaignVersion = storedCampaignVersion(2)
    const persisted = {
      id: 'campaign-claim-1',
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      campaignVersionId: campaignVersion.id,
      campaignCode: campaignVersion.campaignCode,
      channel: 'PAID_META',
      sourceRef: 'adset-cdmx-restaurants',
      issuedById: actor.staffId,
      reason: actor.reason,
      createdAt: now,
      expiresAt: new Date('2026-08-30T06:00:00.000Z'),
      campaignVersion,
    }
    prismaMock.commercialCampaignClaim = { findUnique: jest.fn(async () => persisted) }
    prismaMock.commercialCampaignActivation = {
      findUnique: jest.fn(async () => ({ campaignVersionId: campaignVersion.id })),
    }
    prismaMock.$transaction = jest.fn(async operation => operation(prismaMock))

    await expect(prismaCommercialCampaignClaimRepository.findByTokenHash(persisted.tokenHash)).resolves.toMatchObject({
      id: persisted.id,
      activeCampaignVersionId: campaignVersion.id,
      campaignAuthority: { schemaVersion: 2, campaignVersionId: campaignVersion.id },
    })
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 30_000,
    })
    expect(prismaMock.commercialCampaignClaim.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: persisted.tokenHash },
      include: { campaignVersion: true },
    })
    expect(prismaMock.commercialCampaignActivation.findUnique).toHaveBeenCalledTimes(1)
  })

  it('fails closed before the legacy activation lookup for a dedicated-lineage Offer v3 claim', async () => {
    const dedicatedClaim = {
      id: 'offer-claim-v3-dedicated',
      tokenHash: 'f'.repeat(64),
      campaignVersionId: null,
      campaignCode: null,
      campaignVersion: null,
      offerVersionId: 'commercial-offer-version-summer-2026-v3',
      offerSchemaVersion: 3,
      channel: 'PAID_META',
      sourceRef: 'meta:cdmx:restaurants',
      issuedById: actor.staffId,
      reason: actor.reason,
      createdAt: now,
      expiresAt: new Date('2026-08-30T06:00:00.000Z'),
    }
    prismaMock.commercialCampaignClaim = { findUnique: jest.fn(async () => dedicatedClaim) }
    prismaMock.commercialCampaignActivation = { findUnique: jest.fn() }
    prismaMock.$transaction = jest.fn(async operation => operation(prismaMock))

    await expect(prismaCommercialCampaignClaimRepository.findByTokenHash(dedicatedClaim.tokenHash)).resolves.toBeNull()
    expect(prismaMock.commercialCampaignActivation.findUnique).not.toHaveBeenCalled()
  })
})
