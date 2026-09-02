import { createCommercialQuoteAuthorityService } from '@/services/commercial/commercialQuoteAuthority.service'
import catalog from '@/contracts/commercial/fixtures/catalog-v1.json'
import type { CommercialCampaignVersionV1 } from '@/types/commercialQuote'

const now = new Date('2026-08-22T15:00:00.000Z')
const acquisitionToken = 'A'.repeat(43)
const campaign: CommercialCampaignVersionV1 = {
  schemaVersion: 1,
  campaignVersionId: 'campaign-version-1',
  campaignCode: 'POS_INTRO_2026',
  version: 1,
  status: 'ACTIVE',
  startsAt: '2026-08-22T06:00:00.000Z',
  endsAt: '2026-09-22T06:00:00.000Z',
  allowedRuleCodeGroups: [],
  rules: [
    {
      code: 'POS_FIFTY',
      type: 'FIXED_PRICE',
      priority: 100,
      target: { productCodes: ['POS'] },
      amountMinor: 5000,
      cycles: 3,
    },
  ],
}

function request(withAcquisition = true) {
  return {
    market: 'MX' as const,
    currency: 'MXN' as const,
    ...(withAcquisition ? { acquisitionToken } : {}),
    lines: [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
  }
}

function harness() {
  const dependencies = {
    now: jest.fn(() => now),
    randomId: jest.fn(() => 'quote-1'),
    quoteTtlMs: 15 * 60 * 1000,
    loadActiveCatalog: jest.fn(async () => ({ id: 'commercial-publication-v1', snapshot: catalog })),
    resolveAcquisition: jest.fn(async () => ({
      id: 'acquisition-1',
      campaignVersionId: 'campaign-version-1',
      channel: 'PAID_META' as const,
      attribution: { campaignCode: 'POS_INTRO_2026' },
      createdAt: now,
      expiresAt: new Date('2026-08-22T16:00:00.000Z'),
    })),
    loadCampaignVersion: jest.fn(async () => campaign),
    isCampaignVersionActive: jest.fn(async () => true),
  }
  return { service: createCommercialQuoteAuthorityService(dependencies), dependencies }
}

describe('commercial quote authority', () => {
  it('keeps the legacy v1 surface preview-only after the authenticated writer is retired', () => {
    const { service } = harness()

    expect(service).toEqual({ previewQuote: expect.any(Function) })
  })

  it('creates a public preview without persisting or inventing a campaign', async () => {
    const { service, dependencies } = harness()

    const result = await service.previewQuote(request(false))

    expect(result.quote.campaignVersionId).toBeNull()
    expect(result.quote.totals.totalMinor).toBe(28884)
    expect(dependencies.resolveAcquisition).not.toHaveBeenCalled()
    expect(dependencies.loadCampaignVersion).not.toHaveBeenCalled()
  })

  it('rejects browser amounts without reintroducing an authenticated persistence path', async () => {
    const { service } = harness()

    await expect(service.previewQuote({ ...request(), amountMinor: 22 } as never)).rejects.toMatchObject({
      code: 'COMMERCIAL_QUOTE_REQUEST_INVALID',
    })
  })

  it('fails closed when the active publication or pinned campaign cannot be reloaded', async () => {
    const { service, dependencies } = harness()
    dependencies.loadActiveCatalog.mockResolvedValueOnce(null as never)
    await expect(service.previewQuote(request(false))).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_UNAVAILABLE' })

    dependencies.loadCampaignVersion.mockResolvedValueOnce(null as never)
    await expect(service.previewQuote(request())).rejects.toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_VERSION_UNAVAILABLE' })

    dependencies.isCampaignVersionActive.mockResolvedValueOnce(false)
    await expect(service.previewQuote(request())).rejects.toMatchObject({ code: 'COMMERCIAL_CAMPAIGN_SUPERSEDED' })
  })
})
