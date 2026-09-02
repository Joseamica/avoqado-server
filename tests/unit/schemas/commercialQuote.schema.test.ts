import {
  commercialAcquisitionRequestSchema,
  commercialCampaignDraftInputSchema,
  commercialCampaignVersionSchema,
  commercialQuoteRequestSchema,
} from '@/schemas/commercialQuote.schema'
import {
  bridgeCommercialQuotePreviewRequestV2Schema,
  commercialDirectVenueQuoteRequestV2Schema,
  commercialPublicQuotePreviewRequestV2Schema,
} from '@/schemas/commercialQuoteV2.schema'

const baseCampaign = {
  schemaVersion: 1,
  campaignVersionId: 'campaign-version-1',
  campaignCode: 'POS_INTRO_2026',
  version: 1,
  status: 'ACTIVE',
  startsAt: '2026-08-01T06:00:00.000Z',
  endsAt: '2026-09-01T06:00:00.000Z',
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

const baseCampaignDraftV2 = {
  code: 'POS_INTRO_2026',
  name: 'POS introductorio',
  description: null,
  startsAt: '2026-08-01T06:00:00.000Z',
  endsAt: '2026-09-01T06:00:00.000Z',
  stackingGroups: [],
  rules: [
    {
      code: 'POS_FIFTY',
      type: 'FIXED_PRICE',
      priority: 100,
      target: { productCodes: ['POS'] },
      amount: '249.00',
      cycles: 3,
    },
  ],
}

describe('commercial acquisition and quote schemas', () => {
  it('accepts canonical peso strings in the mutable campaign v2 draft without changing the historical v1 schema', () => {
    const parsedDraft = commercialCampaignDraftInputSchema.parse(baseCampaignDraftV2)

    expect(parsedDraft.rules[0]).toMatchObject({ type: 'FIXED_PRICE', amount: '249.00' })
    expect(commercialCampaignVersionSchema.parse(baseCampaign)).toEqual(baseCampaign)
  })

  it.each(['21474836.48', '9999999999.99'])(
    'accepts campaign v2 money above the legacy int4 range through the unit maximum: %s',
    amount => {
      const parsed = commercialCampaignDraftInputSchema.parse({
        ...baseCampaignDraftV2,
        rules: [{ ...baseCampaignDraftV2.rules[0], amount }],
      })

      expect(parsed.rules[0]).toMatchObject({ amount })
    },
  )

  it.each([
    { amount: '10000000000.00', message: 'El monto excede el máximo unitario permitido.' },
    { amount: '249', message: 'El monto debe usar formato decimal canónico con dos decimales.' },
    { amount: '0249.00', message: 'El monto debe usar formato decimal canónico con dos decimales.' },
    { amount: 249, message: 'El monto debe usar formato decimal canónico con dos decimales.' },
    { amount: undefined, message: 'El monto debe usar formato decimal canónico con dos decimales.' },
  ])('rejects non-canonical or over-limit campaign v2 money without throwing outside Zod: $amount', ({ amount, message }) => {
    const result = commercialCampaignDraftInputSchema.safeParse({
      ...baseCampaignDraftV2,
      rules: [{ ...baseCampaignDraftV2.rules[0], amount }],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual([expect.objectContaining({ path: ['rules', 0, 'amount'], message })])
    }
  })

  it('rejects the mutable v1 campaign fields instead of silently treating them as v2', () => {
    expect(() =>
      commercialCampaignDraftInputSchema.parse({
        ...baseCampaignDraftV2,
        allowedRuleCodeGroups: [],
      }),
    ).toThrow()
    expect(() =>
      commercialCampaignDraftInputSchema.parse({
        ...baseCampaignDraftV2,
        rules: [{ ...baseCampaignDraftV2.rules[0], amount: undefined, amountMinor: 24_900 }],
      }),
    ).toThrow()
  })

  it('rejects duplicate stacking group codes in a mutable campaign v2 draft', () => {
    const rules = [
      baseCampaignDraftV2.rules[0],
      {
        code: 'TEN_PERCENT',
        type: 'PERCENT_OFF',
        priority: 90,
        target: { productKinds: ['MODULE'] },
        percentBasisPoints: 1000,
        cycles: 3,
      },
    ]
    const steps = [
      { position: 1, ruleCode: 'POS_FIFTY' },
      { position: 2, ruleCode: 'TEN_PERCENT' },
    ]

    expect(
      commercialCampaignDraftInputSchema.safeParse({
        ...baseCampaignDraftV2,
        rules,
        stackingGroups: [
          { code: 'INTRO_STACK', steps },
          { code: 'INTRO_STACK', steps },
        ],
      }).success,
    ).toBe(false)
  })

  it.each([
    {
      label: 'nonconsecutive positions',
      rules: [
        baseCampaignDraftV2.rules[0],
        {
          code: 'TEN_PERCENT',
          type: 'PERCENT_OFF',
          priority: 90,
          target: { productKinds: ['MODULE'] },
          percentBasisPoints: 1000,
          cycles: 3,
        },
      ],
      steps: [
        { position: 1, ruleCode: 'POS_FIFTY' },
        { position: 3, ruleCode: 'TEN_PERCENT' },
      ],
    },
    {
      label: 'percentage before base price',
      rules: [
        baseCampaignDraftV2.rules[0],
        {
          code: 'TEN_PERCENT',
          type: 'PERCENT_OFF',
          priority: 90,
          target: { productKinds: ['MODULE'] },
          percentBasisPoints: 1000,
          cycles: 3,
        },
      ],
      steps: [
        { position: 1, ruleCode: 'TEN_PERCENT' },
        { position: 2, ruleCode: 'POS_FIFTY' },
      ],
    },
    {
      label: 'two base-price rules',
      rules: [
        baseCampaignDraftV2.rules[0],
        {
          code: 'BUNDLE_INTRO',
          type: 'BUNDLE_PRICE',
          priority: 80,
          target: { bundleCodes: ['ALL_MODULES'] },
          amount: '1999.00',
          cycles: 3,
        },
      ],
      steps: [
        { position: 1, ruleCode: 'POS_FIFTY' },
        { position: 2, ruleCode: 'BUNDLE_INTRO' },
      ],
    },
    {
      label: 'free period inside a group',
      rules: [
        baseCampaignDraftV2.rules[0],
        {
          code: 'FREE_MONTH',
          type: 'FREE_PERIOD',
          priority: 80,
          target: { productCodes: ['PRO'] },
          cycles: 3,
        },
      ],
      steps: [
        { position: 1, ruleCode: 'POS_FIFTY' },
        { position: 2, ruleCode: 'FREE_MONTH' },
      ],
    },
    {
      label: 'different cycles inside a group',
      rules: [
        baseCampaignDraftV2.rules[0],
        {
          code: 'TEN_PERCENT',
          type: 'PERCENT_OFF',
          priority: 90,
          target: { productKinds: ['MODULE'] },
          percentBasisPoints: 1000,
          cycles: 2,
        },
      ],
      steps: [
        { position: 1, ruleCode: 'POS_FIFTY' },
        { position: 2, ruleCode: 'TEN_PERCENT' },
      ],
    },
  ])('rejects invalid campaign v2 stacking semantics: $label', ({ rules, steps }) => {
    expect(
      commercialCampaignDraftInputSchema.safeParse({
        ...baseCampaignDraftV2,
        rules,
        stackingGroups: [{ code: 'INTRO_STACK', steps }],
      }).success,
    ).toBe(false)
  })

  it('accepts bounded attribution metadata but no commercial authority', () => {
    expect(
      commercialAcquisitionRequestSchema.parse({
        campaignClaim: 'A'.repeat(43),
        utmSource: 'facebook',
        utmCampaign: 'pos-agosto',
        gclid: 'gclid-123',
        fbclid: 'fbclid-456',
      }),
    ).toMatchObject({ campaignClaim: 'A'.repeat(43) })
  })

  it('never lets a browser campaign code, paid channel or source reference authorize an offer', () => {
    for (const injected of [
      { campaignCode: 'POS_INTRO_2026' },
      { channel: 'PAID_META' },
      { channel: 'SELLER' },
      { sourceRef: 'seller-attacker' },
    ]) {
      expect(() => commercialAcquisitionRequestSchema.parse({ campaignClaim: 'A'.repeat(43), ...injected })).toThrow()
    }
  })

  it('allows campaign-free organic or direct attribution only', () => {
    expect(commercialAcquisitionRequestSchema.parse({ channel: 'ORGANIC', utmSource: 'google' })).toBeTruthy()
    expect(commercialAcquisitionRequestSchema.parse({ channel: 'DIRECT' })).toBeTruthy()
    expect(() => commercialAcquisitionRequestSchema.parse({ channel: 'PAID_GOOGLE', gclid: 'gclid-123' })).toThrow()
  })

  it.each([
    { amount: 22 },
    { amountMinor: 2200 },
    { price: '22.00' },
    { discount: '90%' },
    { stripePriceId: 'price_attacker' },
    { redirectUrl: 'https://attacker.example/?price=22' },
  ])('rejects browser-supplied price authority in acquisition context: %j', injected => {
    expect(() => commercialAcquisitionRequestSchema.parse({ campaignClaim: 'A'.repeat(43), ...injected })).toThrow()
  })

  it('accepts only product selections in quote requests, never amounts or Stripe IDs', () => {
    expect(
      commercialQuoteRequestSchema.parse({
        market: 'MX',
        currency: 'MXN',
        acquisitionToken: 'A'.repeat(43),
        lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      }),
    ).toBeTruthy()

    for (const injected of [{ amountMinor: 2200 }, { unitAmount: 22 }, { stripePriceId: 'price_attacker' }, { tax: 0 }]) {
      expect(() =>
        commercialQuoteRequestSchema.parse({
          market: 'MX',
          currency: 'MXN',
          lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1, ...injected }],
        }),
      ).toThrow()
    }
  })

  it('freezes strict and distinct public, direct-venue and bridge v2 request shapes', () => {
    const lines = [{ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }]
    expect(
      commercialPublicQuotePreviewRequestV2Schema.parse({
        market: 'MX',
        currency: 'MXN',
        acquisitionToken: 'A'.repeat(43),
        lines,
      }),
    ).toEqual({ market: 'MX', currency: 'MXN', acquisitionToken: 'A'.repeat(43), lines })
    expect(commercialDirectVenueQuoteRequestV2Schema.parse({ market: 'MX', currency: 'MXN', lines })).toEqual({
      market: 'MX',
      currency: 'MXN',
      lines,
    })
    expect(
      bridgeCommercialQuotePreviewRequestV2Schema.parse({
        acquisitionBearer: 'B'.repeat(43),
        previewToken: 'v2.payload.signature',
        normalizedLines: lines,
      }),
    ).toEqual({ acquisitionBearer: 'B'.repeat(43), previewToken: 'v2.payload.signature', normalizedLines: lines })
  })

  it.each([
    ['missing acquisition bearer', { market: 'MX', currency: 'MXN', lines: [] }],
    ['root price authority', { market: 'MX', currency: 'MXN', acquisitionToken: 'A'.repeat(43), lines: [], total: '22.00' }],
    [
      'line price authority',
      {
        market: 'MX',
        currency: 'MXN',
        acquisitionToken: 'A'.repeat(43),
        lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1, amount: '22.00' }],
      },
    ],
    [
      'campaign authority',
      {
        market: 'MX',
        currency: 'MXN',
        acquisitionToken: 'A'.repeat(43),
        lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
        campaignVersionId: 'attacker-campaign',
      },
    ],
  ])('rejects forbidden public-v2 input: %s', (_label, value) => {
    expect(commercialPublicQuotePreviewRequestV2Schema.safeParse(value).success).toBe(false)
  })

  it('keeps direct venue requests free of acquisition, campaign and preview lineage', () => {
    const base = {
      market: 'MX',
      currency: 'MXN',
      lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
    }
    for (const injected of [
      { acquisitionToken: 'A'.repeat(43) },
      { campaignVersionId: 'campaign-version-pos-50-v2' },
      { previewToken: 'v2.payload.signature' },
      { acquisitionContextId: 'acquisition-context' },
    ]) {
      expect(commercialDirectVenueQuoteRequestV2Schema.safeParse({ ...base, ...injected }).success).toBe(false)
    }
  })

  it('keeps bridge input limited to bearers and normalized selection, never client quote authority', () => {
    const base = {
      acquisitionBearer: 'B'.repeat(43),
      previewToken: 'v2.payload.signature',
      normalizedLines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
    }
    for (const injected of [
      { quote: { totals: { total: '22.00' } } },
      { totals: { total: '22.00' } },
      { campaignVersionId: 'campaign-version-pos-50-v2' },
      { publicationId: 'catalog' },
      { attribution: { utmSource: 'attacker' } },
    ]) {
      expect(bridgeCommercialQuotePreviewRequestV2Schema.safeParse({ ...base, ...injected }).success).toBe(false)
    }
    expect(
      bridgeCommercialQuotePreviewRequestV2Schema.safeParse({
        ...base,
        normalizedLines: [{ ...base.normalizedLines[0], unitAmount: '22.00' }],
      }).success,
    ).toBe(false)
  })

  it('strictly validates all five promotion kinds and explicit stacking groups', () => {
    const parsed = commercialCampaignVersionSchema.parse({
      ...baseCampaign,
      allowedRuleCodeGroups: [['POS_FIFTY', 'TEN_MORE']],
      rules: [
        baseCampaign.rules[0],
        {
          code: 'TEN_PERCENT',
          type: 'PERCENT_OFF',
          priority: 90,
          target: { productKinds: ['MODULE'] },
          percentBasisPoints: 1000,
          cycles: 3,
        },
        {
          code: 'TEN_MORE',
          type: 'AMOUNT_OFF',
          priority: 80,
          target: { productCodes: ['POS'] },
          amountMinor: 1000,
          cycles: 3,
        },
        {
          code: 'FREE_MONTH',
          type: 'FREE_PERIOD',
          priority: 70,
          target: { productCodes: ['PRO'] },
          cycles: 1,
        },
        {
          code: 'BUNDLE_INTRO',
          type: 'BUNDLE_PRICE',
          priority: 60,
          target: { bundleCodes: ['ALL_MODULES'] },
          amountMinor: 149900,
          cycles: 2,
        },
      ],
    })

    expect(parsed.rules.map(rule => rule.type)).toEqual(['FIXED_PRICE', 'PERCENT_OFF', 'AMOUNT_OFF', 'FREE_PERIOD', 'BUNDLE_PRICE'])
  })

  it.each([
    { patch: { startsAt: '2026-08-01' }, label: 'non-UTC date' },
    { patch: { endsAt: '2026-07-01T00:00:00.000Z' }, label: 'reverse window' },
    { rule: { amountMinor: -1 }, label: 'negative amount' },
    { rule: { amountMinor: 22.5 }, label: 'fractional money' },
    { rule: { cycles: 0 }, label: 'zero cycles' },
    { rule: { extraPrice: 22 }, label: 'unknown rule key' },
  ])('rejects invalid campaign authority: $label', ({ patch, rule }) => {
    expect(() =>
      commercialCampaignVersionSchema.parse({
        ...baseCampaign,
        ...patch,
        rules: [{ ...baseCampaign.rules[0], ...rule }],
      }),
    ).toThrow()
  })
})
