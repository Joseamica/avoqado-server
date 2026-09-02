import { createHash } from 'node:crypto'
import { createCommercialAcquisitionContextService } from '@/services/commercial/commercialAcquisitionContext.service'

const now = new Date('2026-08-22T15:00:00.000Z')
const token = 'A'.repeat(43)

function harness() {
  const rows = new Map<string, any>()
  const repository = {
    create: jest.fn(async row => {
      rows.set(row.tokenHash, row)
    }),
    findByTokenHash: jest.fn(async tokenHash => rows.get(tokenHash) ?? null),
  }
  const resolveCampaignClaim = jest.fn(async (claim: string) =>
    claim === 'C'.repeat(43)
      ? {
          campaignVersionId: 'campaign-version-1',
          campaignCode: 'POS_INTRO_2026',
          channel: 'PAID_META' as const,
          sourceRef: 'adset-cdmx-restaurants',
        }
      : null,
  )
  const service = createCommercialAcquisitionContextService({
    repository,
    resolveCampaignClaim,
    randomToken: () => token,
    randomId: () => 'acq-context-1',
  })
  return { service, repository, resolveCampaignClaim, rows }
}

describe('commercial acquisition context', () => {
  it('issues an opaque bearer token and persists only its SHA-256 hash', async () => {
    const { service, repository, resolveCampaignClaim } = harness()

    const issued = await service.issue(
      {
        campaignClaim: 'C'.repeat(43),
        utmSource: 'facebook',
        fbclid: 'fbclid-123',
      },
      now,
    )

    expect(issued).toEqual({ token, expiresAt: '2026-08-29T15:00:00.000Z' })
    expect(resolveCampaignClaim).toHaveBeenCalledWith('C'.repeat(43), now)
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'acq-context-1',
        tokenHash: createHash('sha256').update(token).digest('hex'),
        campaignVersionId: 'campaign-version-1',
        channel: 'PAID_META',
        attribution: {
          campaignCode: 'POS_INTRO_2026',
          sourceRef: 'adset-cdmx-restaurants',
          utmSource: 'facebook',
          fbclid: 'fbclid-123',
        },
      }),
    )
    expect(JSON.stringify(repository.create.mock.calls)).not.toContain(token)
    expect(JSON.stringify(repository.create.mock.calls)).not.toMatch(/amount|price|discount/i)
  })

  it('rejects browser price injection before campaign resolution or persistence', async () => {
    const { service, repository, resolveCampaignClaim } = harness()

    await expect(service.issue({ campaignClaim: 'C'.repeat(43), amountMinor: 2200 } as never, now)).rejects.toMatchObject({
      code: 'COMMERCIAL_ACQUISITION_INVALID',
    })
    expect(resolveCampaignClaim).not.toHaveBeenCalled()
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('fails explicitly for an unknown or inactive claimed campaign', async () => {
    const { service, repository } = harness()

    await expect(service.issue({ campaignClaim: 'E'.repeat(43) }, now)).rejects.toMatchObject({
      code: 'COMMERCIAL_CAMPAIGN_NOT_ACTIVE',
    })
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('allows organic attribution without inventing a campaign', async () => {
    const { service, repository, resolveCampaignClaim } = harness()

    await expect(service.issue({ channel: 'ORGANIC', utmSource: 'google' }, now)).resolves.toEqual({
      token,
      expiresAt: '2026-08-29T15:00:00.000Z',
    })
    expect(resolveCampaignClaim).not.toHaveBeenCalled()
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ campaignVersionId: null }))
  })

  it('resolves a valid context without exposing or trusting browser fields', async () => {
    const { service, rows } = harness()
    await service.issue({ campaignClaim: 'C'.repeat(43), utmCampaign: 'pos-agosto' }, now)
    const stored = rows.get(createHash('sha256').update(token).digest('hex'))
    rows.set(createHash('sha256').update(token).digest('hex'), {
      ...stored,
      offerVersionId: null,
      offerSchemaVersion: null,
      reservedCatalogPublicationId: null,
      reservedCatalogSchemaVersion: null,
    })

    await expect(service.resolve(token, new Date('2026-08-22T15:30:00.000Z'))).resolves.toEqual({
      id: 'acq-context-1',
      campaignVersionId: 'campaign-version-1',
      channel: 'PAID_META',
      attribution: {
        campaignCode: 'POS_INTRO_2026',
        sourceRef: 'adset-cdmx-restaurants',
        utmCampaign: 'pos-agosto',
      },
      createdAt: now,
      expiresAt: new Date('2026-08-29T15:00:00.000Z'),
    })
  })

  it('fails closed for an Offer v3 context even when its token hash deliberately collides with the legacy domain', async () => {
    const { rows, service } = harness()
    rows.set(createHash('sha256').update(token).digest('hex'), {
      id: 'offer-context-v3-collision',
      tokenHash: createHash('sha256').update(token).digest('hex'),
      campaignVersionId: null,
      offerVersionId: 'offer-version-v3',
      offerSchemaVersion: 3,
      reservedCatalogPublicationId: 'catalog-v2',
      reservedCatalogSchemaVersion: 2,
      channel: 'PAID_META',
      attribution: {},
      createdAt: now,
      expiresAt: new Date('2026-08-29T15:00:00.000Z'),
    })

    await expect(service.resolve(token, new Date('2026-08-22T15:30:00.000Z'))).rejects.toMatchObject({
      statusCode: 404,
      code: 'COMMERCIAL_ACQUISITION_NOT_FOUND',
    })
  })

  it('rejects forged, malformed and expired tokens with stable codes', async () => {
    const { service } = harness()
    await service.issue({ channel: 'ORGANIC' }, now)

    await expect(service.resolve('short', now)).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_TOKEN_INVALID' })
    await expect(service.resolve('B'.repeat(43), now)).rejects.toMatchObject({ code: 'COMMERCIAL_ACQUISITION_NOT_FOUND' })
    await expect(service.resolve(token, new Date('2026-08-29T15:00:00.000Z'))).rejects.toMatchObject({
      code: 'COMMERCIAL_ACQUISITION_EXPIRED',
    })
  })
})
