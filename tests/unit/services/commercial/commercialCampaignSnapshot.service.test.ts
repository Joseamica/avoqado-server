import { buildCommercialCampaignV2 } from '@/services/commercial/commercialCampaignV2Builder.service'
import type { CommercialCampaignDraftView } from '@/types/commercialQuote'

const draft: CommercialCampaignDraftView = {
  id: 'campaign-draft-1',
  code: 'POS_INTRO_2026',
  name: 'POS introducción',
  description: 'Precio temporal auditable',
  revision: 3,
  offerSchemaVersion: 2,
  status: 'ACTIVE',
  startsAt: '2026-08-22T06:00:00.000Z',
  endsAt: '2026-09-22T06:00:00.000Z',
  stackingGroups: [
    {
      code: 'POS_MODULE_INTRO',
      steps: [
        { position: 1, ruleCode: 'POS_FIFTY' },
        { position: 2, ruleCode: 'MODULE_TEN' },
      ],
    },
  ],
  rules: [
    {
      code: 'MODULE_TEN',
      type: 'PERCENT_OFF',
      priority: 10,
      target: { productCodes: ['MODULE_KDS', 'MODULE_TABLES'] },
      percentBasisPoints: 1000,
      cycles: 3,
    },
    {
      code: 'POS_FIFTY',
      type: 'FIXED_PRICE',
      priority: 20,
      target: { productCodes: ['POS'] },
      amount: '50.00',
      cycles: 3,
    },
  ],
}

describe('commercial campaign snapshot', () => {
  it('creates one immutable normalized and branded v2 body with a canonical checksum', () => {
    const first = buildCommercialCampaignV2(draft, {
      campaignVersionId: 'campaign-version-1',
      publishedAt: new Date('2026-08-22T15:00:00.000Z'),
    })
    const reordered: CommercialCampaignDraftView = {
      ...draft,
      rules: [...draft.rules].reverse(),
      stackingGroups: [
        {
          code: 'POS_MODULE_INTRO',
          steps: [
            { position: 2, ruleCode: 'MODULE_TEN' },
            { position: 1, ruleCode: 'POS_FIFTY' },
          ],
        },
      ],
    }
    const second = buildCommercialCampaignV2(reordered, {
      campaignVersionId: 'campaign-version-1',
      publishedAt: new Date('2026-08-22T15:00:00.000Z'),
    })

    expect(first).toMatchObject({ kind: 'CAMPAIGN', schemaVersion: 2, mode: 'READ_WRITE' })
    expect(first.snapshot).toEqual({
      schemaVersion: 2,
      contractVersion: '2.0.0',
      campaignVersionId: 'campaign-version-1',
      campaignCode: 'POS_INTRO_2026',
      version: 3,
      status: 'ACTIVE',
      publishedAt: '2026-08-22T15:00:00.000Z',
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      stackingGroups: draft.stackingGroups,
      rules: [draft.rules[0], draft.rules[1]],
    })
    expect(first.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(second).toEqual(first)
  })

  it('rejects an archived or malformed draft instead of publishing a campaign', () => {
    expect(() =>
      buildCommercialCampaignV2(
        { ...draft, status: 'ARCHIVED' },
        {
          campaignVersionId: 'campaign-version-2',
          publishedAt: new Date('2026-08-22T15:00:00.000Z'),
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_CAMPAIGN_DRAFT_INVALID' }))

    expect(() =>
      buildCommercialCampaignV2(
        {
          ...draft,
          stackingGroups: [
            {
              code: 'POS_MODULE_INTRO',
              steps: [
                { position: 1, ruleCode: 'POS_FIFTY' },
                { position: 2, ruleCode: 'UNKNOWN' },
              ],
            },
          ],
        },
        {
          campaignVersionId: 'campaign-version-2',
          publishedAt: new Date('2026-08-22T15:00:00.000Z'),
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_CAMPAIGN_DRAFT_INVALID' }))
  })
})
