import catalogFixtureJson from '@/contracts/commercial/fixtures/catalog-v1.json'
import pricingVectors from '@/contracts/commercial/fixtures/pricing-vectors-v1.json'
import { assertCommercialContractV1 } from '@/services/commercial/commercialContract.service'
import { evaluateCommercialQuote } from '@/services/commercial/commercialQuoteEngine.service'
import type { CommercialCatalogSnapshotV1 } from '@/types/commercial'
import type { CommercialCampaignVersionV1, CommercialQuoteRequestV1 } from '@/types/commercialQuote'

const now = new Date('2026-08-22T15:00:00.000Z')
const expiresAt = new Date('2026-08-22T15:15:00.000Z')

function assertCatalogFixtureV1(value: unknown): asserts value is CommercialCatalogSnapshotV1 {
  assertCommercialContractV1(value)
}

assertCatalogFixtureV1(catalogFixtureJson)
const catalogFixture = catalogFixtureJson

function request(lines: CommercialQuoteRequestV1['lines']): CommercialQuoteRequestV1 {
  return { market: 'MX', currency: 'MXN', lines }
}

function campaign(rules: CommercialCampaignVersionV1['rules'], allowedRuleCodeGroups: string[][] = []): CommercialCampaignVersionV1 {
  return {
    schemaVersion: 1,
    campaignVersionId: 'campaign-version-1',
    campaignCode: 'SUMMER_2026',
    version: 1,
    status: 'ACTIVE',
    startsAt: '2026-08-01T06:00:00.000Z',
    endsAt: '2026-09-01T06:00:00.000Z',
    allowedRuleCodeGroups,
    rules,
  }
}

const posLine = { targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }
const moduleLine = {
  targetType: 'PRODUCT' as const,
  targetCode: 'KITCHEN_DISPLAY_MODULE',
  priceCode: 'KITCHEN_DISPLAY_MONTHLY',
  quantity: 1,
}

describe('evaluateCommercialQuote', () => {
  it.each(pricingVectors)('matches the canonical pricing vector $code across current and renewal MXN amounts', vector => {
    const quote = evaluateCommercialQuote({
      quoteId: `quote-${vector.code.toLowerCase()}`,
      catalog: catalogFixture,
      campaign: vector.campaign as CommercialCampaignVersionV1,
      request: request(vector.lines as CommercialQuoteRequestV1['lines']),
      now,
      expiresAt,
    })

    expect(quote.totals).toEqual(vector.expected.totals)
    expect(quote.renewal).toEqual(vector.expected.renewal)
  })

  it('quotes POS base at $249 + $39.84 IVA = $288.84 and preserves the same renewal', () => {
    const quote = evaluateCommercialQuote({
      quoteId: 'quote-base',
      catalog: catalogFixture,
      request: request([posLine]),
      now,
      expiresAt,
    })

    expect(quote.totals).toEqual({ listSubtotalMinor: 24900, discountMinor: 0, subtotalMinor: 24900, taxMinor: 3984, totalMinor: 28884 })
    expect(quote.renewal).toEqual({ subtotalMinor: 24900, taxMinor: 3984, totalMinor: 28884 })
    expect(quote.lines[0].adjustments).toEqual([])
  })

  it.each([
    { amountMinor: 5000, subtotalMinor: 5000, taxMinor: 800, totalMinor: 5800 },
    { amountMinor: 2200, subtotalMinor: 2200, taxMinor: 352, totalMinor: 2552 },
  ])('models POS $249 → $amountMinor as a temporary FIXED_PRICE campaign', expected => {
    const quote = evaluateCommercialQuote({
      quoteId: `quote-fixed-${expected.amountMinor}`,
      catalog: catalogFixture,
      campaign: campaign([
        {
          code: 'POS_INTRO',
          type: 'FIXED_PRICE',
          priority: 100,
          target: { productCodes: ['POS'] },
          amountMinor: expected.amountMinor,
          cycles: 3,
        },
      ]),
      request: request([posLine]),
      now,
      expiresAt,
    })

    expect(quote.totals).toEqual({
      listSubtotalMinor: 24900,
      discountMinor: 24900 - expected.amountMinor,
      subtotalMinor: expected.subtotalMinor,
      taxMinor: expected.taxMinor,
      totalMinor: expected.totalMinor,
    })
    expect(quote.lines[0].promotionalCycles).toBe(3)
    expect(quote.renewal.totalMinor).toBe(28884)
  })

  it('applies 10% to POS with deterministic half-up IVA rounding', () => {
    const quote = evaluateCommercialQuote({
      quoteId: 'quote-pos-ten-percent',
      catalog: catalogFixture,
      campaign: campaign([
        {
          code: 'TEN_PERCENT_POS',
          type: 'PERCENT_OFF',
          priority: 100,
          target: { productCodes: ['POS'] },
          percentBasisPoints: 1000,
          cycles: 2,
        },
      ]),
      request: request([posLine]),
      now,
      expiresAt,
    })

    expect(quote.totals).toEqual({ listSubtotalMinor: 24900, discountMinor: 2490, subtotalMinor: 22410, taxMinor: 3586, totalMinor: 25996 })
  })

  it('can target only modules without discounting POS', () => {
    const quote = evaluateCommercialQuote({
      quoteId: 'quote-modules-ten-percent',
      catalog: catalogFixture,
      campaign: campaign([
        {
          code: 'TEN_PERCENT_MODULES',
          type: 'PERCENT_OFF',
          priority: 100,
          target: { productKinds: ['MODULE'] },
          percentBasisPoints: 1000,
          cycles: 12,
        },
      ]),
      request: request([posLine, moduleLine]),
      now,
      expiresAt,
    })

    expect(quote.lines.find(line => line.targetCode === 'POS')?.discountMinor).toBe(0)
    expect(quote.lines.find(line => line.targetCode === 'KITCHEN_DISPLAY_MODULE')?.discountMinor).toBe(1790)
  })

  it('defaults to one highest-priority promotion per line', () => {
    const quote = evaluateCommercialQuote({
      quoteId: 'quote-one-rule',
      catalog: catalogFixture,
      campaign: campaign([
        {
          code: 'TEN_PERCENT',
          type: 'PERCENT_OFF',
          priority: 10,
          target: { productCodes: ['POS'] },
          percentBasisPoints: 1000,
          cycles: 1,
        },
        {
          code: 'POS_FIFTY',
          type: 'FIXED_PRICE',
          priority: 100,
          target: { productCodes: ['POS'] },
          amountMinor: 5000,
          cycles: 1,
        },
      ]),
      request: request([posLine]),
      now,
      expiresAt,
    })

    expect(quote.lines[0].adjustments.map(adjustment => adjustment.ruleCode)).toEqual(['POS_FIFTY'])
    expect(quote.lines[0].subtotalMinor).toBe(5000)
  })

  it('stacks only an explicitly allowlisted exact rule group in priority order', () => {
    const quote = evaluateCommercialQuote({
      quoteId: 'quote-explicit-stack',
      catalog: catalogFixture,
      campaign: campaign(
        [
          {
            code: 'TEN_PERCENT',
            type: 'PERCENT_OFF',
            priority: 100,
            target: { productCodes: ['POS'] },
            percentBasisPoints: 1000,
            cycles: 1,
          },
          {
            code: 'TEN_PESOS_MORE',
            type: 'AMOUNT_OFF',
            priority: 90,
            target: { productCodes: ['POS'] },
            amountMinor: 1000,
            cycles: 1,
          },
        ],
        [['TEN_PERCENT', 'TEN_PESOS_MORE']],
      ),
      request: request([posLine]),
      now,
      expiresAt,
    })

    expect(quote.lines[0].adjustments.map(adjustment => adjustment.ruleCode)).toEqual(['TEN_PERCENT', 'TEN_PESOS_MORE'])
    expect(quote.lines[0].subtotalMinor).toBe(21410)
  })

  it('supports FREE_PERIOD and never produces negative money', () => {
    const quote = evaluateCommercialQuote({
      quoteId: 'quote-free-period',
      catalog: catalogFixture,
      campaign: campaign([
        {
          code: 'ONE_MONTH_FREE',
          type: 'FREE_PERIOD',
          priority: 100,
          target: { productCodes: ['POS'] },
          cycles: 1,
        },
      ]),
      request: request([posLine]),
      now,
      expiresAt,
    })

    expect(quote.lines[0]).toMatchObject({ subtotalMinor: 0, discountMinor: 24900, taxMinor: 0, totalMinor: 0 })
  })

  it('supports an immutable BUNDLE_PRICE on the published nine-module bundle', () => {
    const quote = evaluateCommercialQuote({
      quoteId: 'quote-bundle',
      catalog: catalogFixture,
      campaign: campaign([
        {
          code: 'BUNDLE_INTRO',
          type: 'BUNDLE_PRICE',
          priority: 100,
          target: { bundleCodes: ['ALL_MODULES'] },
          amountMinor: 149900,
          cycles: 2,
        },
      ]),
      request: request([{ targetType: 'BUNDLE', targetCode: 'ALL_MODULES', priceCode: 'ALL_MODULES_MONTHLY', quantity: 1 }]),
      now,
      expiresAt,
    })

    expect(quote.totals.subtotalMinor).toBe(149900)
    expect(quote.renewal.subtotalMinor).toBe(199900)
  })

  it('rejects different promotional durations across lines before checkout can diverge from disclosure', () => {
    expect(() =>
      evaluateCommercialQuote({
        quoteId: 'quote-cycle-mismatch',
        catalog: catalogFixture,
        campaign: campaign([
          {
            code: 'POS_TWO_MONTHS',
            type: 'PERCENT_OFF',
            priority: 100,
            target: { productCodes: ['POS'] },
            percentBasisPoints: 1000,
            cycles: 2,
          },
          {
            code: 'MODULE_THREE_MONTHS',
            type: 'PERCENT_OFF',
            priority: 100,
            target: { productKinds: ['MODULE'] },
            percentBasisPoints: 1000,
            cycles: 3,
          },
        ]),
        request: request([posLine, moduleLine]),
        now,
        expiresAt,
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_CAMPAIGN_QUOTE_CYCLE_MISMATCH' }))
  })

  it.each([new Date('2026-08-01T05:59:59.999Z'), new Date('2026-09-01T06:00:00.000Z')])(
    'fails explicitly when a claimed campaign is not active at %s',
    invalidNow => {
      expect(() =>
        evaluateCommercialQuote({
          quoteId: 'quote-inactive',
          catalog: catalogFixture,
          campaign: campaign([]),
          request: request([posLine]),
          now: invalidNow,
          expiresAt: new Date(invalidNow.getTime() + 15 * 60 * 1000),
        }),
      ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_CAMPAIGN_NOT_ACTIVE' }))
    },
  )

  it('sorts output deterministically and rejects duplicate or unknown selections', () => {
    const left = evaluateCommercialQuote({
      quoteId: 'quote-order',
      catalog: catalogFixture,
      request: request([posLine, moduleLine]),
      now,
      expiresAt,
    })
    const right = evaluateCommercialQuote({
      quoteId: 'quote-order',
      catalog: catalogFixture,
      request: request([moduleLine, posLine]),
      now,
      expiresAt,
    })

    expect(left).toEqual(right)
    expect(() =>
      evaluateCommercialQuote({
        quoteId: 'quote-duplicate',
        catalog: catalogFixture,
        request: request([posLine, posLine]),
        now,
        expiresAt,
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_QUOTE_DUPLICATE_LINE' }))
    expect(() =>
      evaluateCommercialQuote({
        quoteId: 'quote-unknown',
        catalog: catalogFixture,
        request: request([{ ...posLine, priceCode: 'CLIENT_PRICE_22' }]),
        now,
        expiresAt,
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_QUOTE_PRICE_NOT_FOUND' }))
  })
})
