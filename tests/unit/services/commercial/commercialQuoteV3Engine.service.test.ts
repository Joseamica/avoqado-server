import { createHash } from 'node:crypto'

import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import directFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-direct.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import {
  MAX_QUOTE_LIST_SUBTOTAL_MINOR,
  MAX_QUOTE_TAX_MINOR,
  MAX_QUOTE_TOTAL_MINOR,
  MAX_UNIT_AMOUNT_MINOR,
} from '@/contracts/commercial/commercialContractV2.constants'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { canonicalJsonBytesV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { evaluateCommercialQuoteV2, type CommercialQuoteSelectionV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import { parseCommercialMoneyV2 } from '@/services/commercial/commercialMoneyV2.service'
import {
  COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS,
  CommercialOfferResolutionError,
  resolveCommercialOfferV3,
} from '@/services/commercial/offers/commercialOfferStacking.service'
import {
  CommercialOfferV3Error,
  decodeAndVerifyStoredCommercialOfferV3,
  emitCommercialOfferV3,
  validateCommercialOfferV3,
} from '@/services/commercial/offers/commercialOfferV3.service'
import { buildCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Builder.service'
import {
  CommercialQuoteV3Error,
  validateCommercialQuoteV3,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Contract.service'
import { evaluateCommercialQuoteV3 } from '@/services/commercial/quotes-v3/commercialQuoteV3Engine.service'
import type { CommercialCampaignRuleV2, CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialBenefitV3, CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'
import type { CommercialQuoteSnapshotV3, CommercialQuoteV3Authorities } from '@/types/commercialQuoteV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function minor(value: string): string {
  return parseCommercialMoneyV2(value).toString()
}

function expectEngineError(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('EXPECTED_COMMERCIAL_QUOTE_V3_ENGINE_FAILURE')
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}

function stackedOfferSource(): CommercialOfferSnapshotV3 {
  const source = clone(offerFixture) as CommercialOfferSnapshotV3
  const saas = source.benefits.find(benefit => benefit.kind === 'SAAS_PRICE')!
  if (saas.kind !== 'SAAS_PRICE') throw new Error('Expected SaaS benefit')
  saas.rules = [
    {
      code: 'A_TEN_PERCENT',
      type: 'PERCENT_OFF',
      priority: 90,
      target: { productCodes: ['POS'] },
      cycles: 3,
      percentBasisPoints: 1000,
    },
    {
      code: 'Z_FIXED_200',
      type: 'FIXED_PRICE',
      priority: 100,
      target: { productCodes: ['POS'] },
      cycles: 3,
      amount: '200.00',
    },
  ]
  saas.stackingGroups = [
    {
      code: 'POS_STACK',
      steps: [
        { position: 1, ruleCode: 'Z_FIXED_200' },
        { position: 2, ruleCode: 'A_TEN_PERCENT' },
      ],
    },
  ]
  return source
}

function neutralOfferSource(): CommercialOfferSnapshotV3 {
  const source = clone(offerFixture) as CommercialOfferSnapshotV3
  source.benefits = source.benefits.filter(benefit => benefit.kind !== 'SAAS_PRICE')
  return source
}

function offerAuthority(source: CommercialOfferSnapshotV3): CommercialQuoteV3Authorities['offer'] {
  const emitted = emitCommercialOfferV3(source)
  const authority: CommercialQuoteV3Authorities['offer'] = {
    rowSchemaVersion: 3,
    snapshot: emitted.snapshot,
    checksum: emitted.checksum,
    rowContext: {
      id: emitted.snapshot.campaignVersionId,
      campaignCode: emitted.snapshot.campaignCode,
      sourceRevision: emitted.snapshot.version,
      schemaVersion: 3,
      publishedAt: new Date(emitted.snapshot.publishedAt),
    },
  }
  decodeAndVerifyStoredCommercialOfferV3(authority)
  return authority
}

const catalog = emitCommercialArtifactV2({
  kind: 'CATALOG',
  schemaVersion: 2,
  domainValue: clone(catalogFixture) as CommercialCatalogSnapshotV2,
})
const offer = offerAuthority(stackedOfferSource())

function boundaryRule(index: number, prefix = 'BOUNDARY_RULE'): CommercialCampaignRuleV2 {
  return {
    code: `${prefix}_${index.toString().padStart(3, '0')}`,
    type: 'PERCENT_OFF',
    priority: 10_000 - index,
    target: { productCodes: ['POS'] },
    cycles: 3,
    percentBasisPoints: 1,
  }
}

function boundaryHardwareBenefit(index: number): Extract<CommercialBenefitV3, { kind: 'HARDWARE_PERCENT_OFF' }> {
  const suffix = index.toString().padStart(3, '0')
  const catalogKey = `BOUNDARY_SKU_${suffix}`
  return {
    benefitCode: `HARDWARE_BOUNDARY_${suffix}`,
    kind: 'HARDWARE_PERCENT_OFF',
    skuSnapshot: {
      catalogKey,
      catalogContentHash: createHash('sha256').update(catalogKey).digest('hex'),
      brand: 'Avoqado',
      model: suffix,
      name: `Boundary ${suffix}`,
      listUnitAmountMinor: '10000',
      currency: 'MXN',
      taxRateBasisPoints: 1600,
    },
    percentBasisPoints: 1,
    quantityLimit: 1,
    benefitStartsAt: '2026-08-01T06:00:00.000Z',
    benefitEndsAt: '2026-09-01T06:00:00.000Z',
  }
}

function boundaryOffer(benefits: CommercialBenefitV3[]): CommercialOfferSnapshotV3 {
  return {
    schemaVersion: 3,
    contractVersion: '3.0.0',
    campaignVersionId: 'commercial-offer-version-aggregate-boundary-v3',
    campaignCode: 'AGGREGATE_BOUNDARY',
    version: 1,
    status: 'ACTIVE',
    publishedAt: '2026-07-31T06:00:00.000Z',
    claimStartsAt: '2026-08-01T06:00:00.000Z',
    claimEndsAt: '2026-09-01T06:00:00.000Z',
    benefits: [...benefits].sort((left, right) =>
      left.benefitCode < right.benefitCode ? -1 : left.benefitCode > right.benefitCode ? 1 : 0,
    ),
  }
}

function expectResolutionBoundaryError(operation: () => unknown): void {
  try {
    operation()
    throw new Error('EXPECTED_COMMERCIAL_OFFER_RESOLUTION_BOUNDARY_FAILURE')
  } catch (error) {
    expect(error).toBeInstanceOf(CommercialOfferResolutionError)
    expect(error).toMatchObject({ code: 'COMMERCIAL_OFFER_RESOLUTION_INVALID', rule: 'INPUT' })
  }
}

describe('Commercial Quote v3 engine', () => {
  it('reconstructs the direct golden economics from verified authorities and selections', () => {
    const evaluation = evaluateCommercialQuoteV3({
      authorities: { catalog, offer },
      saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      hardwareSelections: [{ catalogKey: 'NEXGO_N62', quantity: 5 }],
      rateBlockers: [],
      resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
    })

    expect(evaluation).toMatchObject({
      catalogPublicationId: directFixture.catalogPublicationId,
      catalogChecksum: directFixture.catalogChecksum,
      offerVersionId: directFixture.offerVersionId,
      offerCode: directFixture.offerCode,
      offerChecksum: directFixture.offerChecksum,
      saasLines: directFixture.saasLines,
      hardwareLines: directFixture.hardwareLines,
      entitlementGrants: directFixture.entitlementGrants,
      resolution: directFixture.resolution,
      totals: directFixture.totals,
      renewal: directFixture.renewal,
    })
    expect(Object.isFrozen(evaluation)).toBe(true)
    expect(
      evaluateCommercialQuoteV3({
        authorities: { catalog, offer },
        saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
        hardwareSelections: [{ catalogKey: 'NEXGO_N62', quantity: 5 }],
        rateBlockers: [],
        resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
      }),
    ).toEqual(evaluation)
  })

  it.each([
    ['FIXED_PRICE', { amount: '200.00' }],
    ['BUNDLE_PRICE', { amount: '200.00' }],
    ['PERCENT_OFF', { percentBasisPoints: 1000 }],
    ['AMOUNT_OFF', { amount: '25.00' }],
    ['FREE_PERIOD', {}],
  ] as const)('matches Quote v2 economics and entitlements for %s', (type, value) => {
    const rule: CommercialCampaignRuleV2 = {
      code: `ENGINE_PARITY_${type}`,
      type,
      priority: 100,
      target: { productCodes: ['POS'] },
      cycles: 3,
      ...value,
    } as CommercialCampaignRuleV2
    const campaign: CommercialCampaignSnapshotV2 = {
      schemaVersion: 2,
      contractVersion: '2.0.0',
      campaignVersionId: `engine-parity-${type.toLowerCase()}`,
      campaignCode: `ENGINE_PARITY_${type}`,
      version: 1,
      status: 'ACTIVE',
      publishedAt: '2026-08-01T06:00:00.000Z',
      startsAt: '2026-08-01T06:00:00.000Z',
      endsAt: '2026-09-01T06:00:00.000Z',
      stackingGroups: [],
      rules: [rule],
    }
    const parityOffer = offerAuthority({
      schemaVersion: 3,
      contractVersion: '3.0.0',
      campaignVersionId: campaign.campaignVersionId,
      campaignCode: campaign.campaignCode,
      version: 1,
      status: 'ACTIVE',
      publishedAt: campaign.publishedAt,
      claimStartsAt: campaign.startsAt,
      claimEndsAt: campaign.endsAt,
      benefits: [{ benefitCode: 'SAAS_ENGINE_PARITY', kind: 'SAAS_PRICE', stackingGroups: [], rules: [rule] }],
    })
    const expected = evaluateCommercialQuoteV2({
      catalog: catalog.snapshot,
      campaign,
      lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      now: new Date('2026-08-15T12:00:00.000Z'),
    })
    const actual = evaluateCommercialQuoteV3({
      authorities: { catalog, offer: parityOffer },
      saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      hardwareSelections: [],
      rateBlockers: [],
      resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
    })
    const expectedLine = expected.lines[0]
    expect(actual.saasLines[0]).toMatchObject({
      listUnitAmountMinor: minor(expectedLine.unitAmount),
      listSubtotalMinor: minor(expectedLine.listSubtotal),
      discountMinor: minor(expectedLine.discount),
      subtotalMinor: minor(expectedLine.subtotal),
      taxMinor: minor(expectedLine.tax),
      totalMinor: minor(expectedLine.total),
      promotionalCycles: expectedLine.promotionalCycles,
      renewalSubtotalMinor: minor(expectedLine.renewalSubtotal),
      renewalTaxMinor: minor(expectedLine.renewalTax),
      renewalTotalMinor: minor(expectedLine.renewalTotal),
    })
    expect(actual.entitlementGrants).toEqual(expected.entitlementGrants)
  })

  it('prices active, partial and inactive hardware solely from frozen Offer snapshots', () => {
    const active = evaluateCommercialQuoteV3({
      authorities: { catalog, offer: offerAuthority(clone(offerFixture) as CommercialOfferSnapshotV3) },
      saasSelections: [],
      hardwareSelections: [{ catalogKey: 'PAX_A910S', quantity: 2 }],
      rateBlockers: ['NEGOTIATED_RATE'],
      resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
    })
    expect(active.hardwareLines[0]).toMatchObject({
      quantity: 2,
      benefitedQuantity: 1,
      listPriceQuantity: 1,
      listSubtotalMinor: '800000',
      discountMinor: '40000',
      subtotalMinor: '760000',
      taxMinor: '121600',
      totalMinor: '881600',
    })
    expect(active.resolution.exclusions).toContainEqual(
      expect.objectContaining({ subjectKind: 'PAYMENTS_RATE', reasonCode: 'NEGOTIATED_RATE_PRESENT' }),
    )

    const source = clone(offerFixture) as CommercialOfferSnapshotV3
    const percent = source.benefits.find(benefit => benefit.kind === 'HARDWARE_PERCENT_OFF')!
    if (percent.kind !== 'HARDWARE_PERCENT_OFF') throw new Error('Expected percent benefit')
    percent.benefitStartsAt = '2026-08-20T06:00:00.000Z'
    percent.benefitEndsAt = '2026-08-25T06:00:00.000Z'
    const inactive = evaluateCommercialQuoteV3({
      authorities: { catalog, offer: offerAuthority(source) },
      saasSelections: [],
      hardwareSelections: [{ catalogKey: 'PAX_A910S', quantity: 2 }],
      rateBlockers: [],
      resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
    })
    expect(inactive.hardwareLines[0]).toMatchObject({
      benefitedQuantity: 0,
      listPriceQuantity: 2,
      appliedBenefit: null,
      discountMinor: '0',
      subtotalMinor: '800000',
    })
  })

  it('supports multiple base SaaS lines, quantities and bundles without inventing Offer discounts', () => {
    const neutralOffer = offerAuthority(neutralOfferSource())
    const selections = [
      { targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 3 },
      { targetType: 'PRODUCT' as const, targetCode: 'CFDI_MODULE', priceCode: 'CFDI_MONTHLY', quantity: 2 },
    ]
    const expected = evaluateCommercialQuoteV2({
      catalog: catalog.snapshot,
      campaign: null,
      lines: selections,
      now: new Date('2026-08-15T12:00:00.000Z'),
    })
    const actual = evaluateCommercialQuoteV3({
      authorities: { catalog, offer: neutralOffer },
      saasSelections: selections,
      hardwareSelections: [],
      rateBlockers: [],
      resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
    })

    expect(actual.saasLines).toHaveLength(2)
    for (const line of expected.lines) {
      expect(actual.saasLines.find(candidate => candidate.lineKey === line.lineKey)).toMatchObject({
        quantity: line.quantity,
        appliedOfferSteps: [],
        discountMinor: '0',
        subtotalMinor: minor(line.subtotal),
        taxMinor: minor(line.tax),
        totalMinor: minor(line.total),
        promotionalCycles: null,
      })
    }
    expect(actual.entitlementGrants).toEqual(expected.entitlementGrants)

    const bundle = evaluateCommercialQuoteV3({
      authorities: { catalog, offer: neutralOffer },
      saasSelections: [{ targetType: 'BUNDLE', targetCode: 'ALL_MODULES', priceCode: 'ALL_MODULES_MONTHLY', quantity: 1 }],
      hardwareSelections: [],
      rateBlockers: [],
      resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
    })
    expect(bundle.saasLines[0]).toMatchObject({ targetType: 'BUNDLE', targetCode: 'ALL_MODULES', discountMinor: '0' })
    expect(bundle.entitlementGrants.some(grant => grant.origins.some(origin => origin.kind === 'BUNDLE_COMPONENT'))).toBe(true)
  })

  it('fails closed when line capacity or the branded Catalog authority is forged', () => {
    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: { catalog, offer },
          saasSelections: Array.from({ length: 51 }, () => ({
            targetType: 'PRODUCT' as const,
            targetCode: 'POS',
            priceCode: 'POS_MONTHLY',
            quantity: 1,
          })),
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_INPUT_INVALID',
    )

    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: {
            catalog: { ...catalog, checksum: '0'.repeat(64) } as CommercialQuoteV3Authorities['catalog'],
            offer,
          },
          saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_CATALOG_AUTHORITY_INVALID',
    )
  })

  it('evaluates the exact representable aggregate money boundary without false overflow', () => {
    const boundarySource: CommercialOfferSnapshotV3 = {
      schemaVersion: 3,
      contractVersion: '3.0.0',
      campaignVersionId: 'commercial-offer-version-engine-boundary-v3',
      campaignCode: 'ENGINE_BOUNDARY',
      version: 1,
      status: 'ACTIVE',
      publishedAt: '2026-08-01T06:00:00.000Z',
      claimStartsAt: '2026-08-01T06:00:00.000Z',
      claimEndsAt: '2026-09-01T06:00:00.000Z',
      benefits: Array.from({ length: 50 }, (_, index) => {
        const suffix = index.toString().padStart(2, '0')
        const catalogKey = `ENGINE_BOUNDARY_SKU_${suffix}`
        return {
          benefitCode: `ENGINE_BOUNDARY_BENEFIT_${suffix}`,
          kind: 'HARDWARE_PERCENT_OFF' as const,
          skuSnapshot: {
            catalogKey,
            catalogContentHash: createHash('sha256').update(catalogKey).digest('hex'),
            brand: 'Avoqado',
            model: suffix,
            name: `Engine boundary ${suffix}`,
            listUnitAmountMinor: MAX_UNIT_AMOUNT_MINOR.toString(),
            currency: 'MXN' as const,
            taxRateBasisPoints: 1600 as const,
          },
          percentBasisPoints: 1,
          quantityLimit: 1000,
          benefitStartsAt: '2026-08-20T06:00:00.000Z',
          benefitEndsAt: '2026-08-25T06:00:00.000Z',
        }
      }),
    }
    const evaluation = evaluateCommercialQuoteV3({
      authorities: { catalog, offer: offerAuthority(boundarySource) },
      saasSelections: [],
      hardwareSelections: boundarySource.benefits.map(benefit => {
        if (benefit.kind !== 'HARDWARE_PERCENT_OFF') throw new Error('Expected hardware benefit')
        return { catalogKey: benefit.skuSnapshot.catalogKey, quantity: 1000 }
      }),
      rateBlockers: [],
      resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
    })

    expect(evaluation.totals.oneTime).toEqual({
      listSubtotalMinor: MAX_QUOTE_LIST_SUBTOTAL_MINOR.toString(),
      discountMinor: '0',
      subtotalMinor: MAX_QUOTE_LIST_SUBTOTAL_MINOR.toString(),
      taxMinor: MAX_QUOTE_TAX_MINOR.toString(),
      totalMinor: MAX_QUOTE_TOTAL_MINOR.toString(),
    })
    expect(evaluation.totals.dueNow).toEqual(evaluation.totals.oneTime)
    expect(Object.isFrozen(evaluation.hardwareLines[0].skuSnapshot)).toBe(true)
  })

  it('normalizes non-claimable Offers, invalid selections and ambiguous published stacks to actionable v3 errors', () => {
    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: { catalog, offer },
          saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-09-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_OFFER_NOT_CLAIMABLE',
    )

    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: { catalog, offer },
          saasSelections: [{ targetType: 'PRODUCT', targetCode: 'MISSING', priceCode: 'MISSING_MONTHLY', quantity: 1 }],
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_SELECTION_NOT_FOUND',
    )

    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: { catalog, offer },
          saasSelections: [
            { targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 },
            { targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 },
          ],
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_DUPLICATE_LINE',
    )

    const ambiguousSource = clone(offerFixture) as CommercialOfferSnapshotV3
    const saas = ambiguousSource.benefits.find(benefit => benefit.kind === 'SAAS_PRICE')!
    if (saas.kind !== 'SAAS_PRICE') throw new Error('Expected SaaS benefit')
    saas.rules = [
      {
        code: 'A_PERCENT_10',
        type: 'PERCENT_OFF',
        priority: 300,
        target: { productCodes: ['POS'] },
        cycles: 3,
        percentBasisPoints: 1000,
      },
      {
        code: 'B_AMOUNT_10',
        type: 'AMOUNT_OFF',
        priority: 200,
        target: { productCodes: ['POS'] },
        cycles: 3,
        amount: '10.00',
      },
      {
        code: 'C_PERCENT_05',
        type: 'PERCENT_OFF',
        priority: 100,
        target: { productCodes: ['POS'] },
        cycles: 3,
        percentBasisPoints: 500,
      },
    ]
    saas.stackingGroups = [
      {
        code: 'AMBIGUOUS_SUBSET',
        steps: [
          { position: 1, ruleCode: 'A_PERCENT_10' },
          { position: 2, ruleCode: 'B_AMOUNT_10' },
        ],
      },
    ]
    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: { catalog, offer: offerAuthority(ambiguousSource) },
          saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_OFFER_STACKING_AMBIGUOUS',
    )
  })

  it('maps priority ambiguity and hardware outside the frozen Offer to stable v3 errors', () => {
    const tiedSource = clone(offerFixture) as CommercialOfferSnapshotV3
    const tiedSaas = tiedSource.benefits.find(benefit => benefit.kind === 'SAAS_PRICE')!
    if (tiedSaas.kind !== 'SAAS_PRICE') throw new Error('Expected SaaS benefit')
    tiedSaas.rules = [
      {
        code: 'A_TIED_PERCENT',
        type: 'PERCENT_OFF',
        priority: 100,
        target: { productCodes: ['POS'] },
        cycles: 3,
        percentBasisPoints: 1000,
      },
      {
        code: 'B_TIED_PERCENT',
        type: 'PERCENT_OFF',
        priority: 100,
        target: { productCodes: ['POS'] },
        cycles: 3,
        percentBasisPoints: 500,
      },
    ]
    tiedSaas.stackingGroups = []
    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: { catalog, offer: offerAuthority(tiedSource) },
          saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_OFFER_PRIORITY_AMBIGUOUS',
    )

    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: { catalog, offer },
          saasSelections: [],
          hardwareSelections: [{ catalogKey: 'UNPUBLISHED_SKU', quantity: 1 }],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_HARDWARE_NOT_OFFERED',
    )
  })

  it('rejects heterogeneous promotional cycles inside one published stack', () => {
    const source = stackedOfferSource()
    const saas = source.benefits.find(benefit => benefit.kind === 'SAAS_PRICE')!
    if (saas.kind !== 'SAAS_PRICE') throw new Error('Expected SaaS benefit')
    saas.rules[0].cycles = 6
    saas.rules[1].cycles = 3

    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: { catalog, offer: offerAuthority(source) },
          saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_STACK_CYCLE_MISMATCH',
    )
  })

  it('rejects mixed cycles, price increases, forged authorities and hostile selections', () => {
    const rules: CommercialCampaignRuleV2[] = [
      {
        code: 'CFDI_CYCLE_6',
        type: 'PERCENT_OFF',
        priority: 100,
        target: { productCodes: ['CFDI_MODULE'] },
        cycles: 6,
        percentBasisPoints: 1000,
      },
      {
        code: 'POS_CYCLE_3',
        type: 'PERCENT_OFF',
        priority: 100,
        target: { productCodes: ['POS'] },
        cycles: 3,
        percentBasisPoints: 1000,
      },
    ]
    const mixedOffer = offerAuthority({
      schemaVersion: 3,
      contractVersion: '3.0.0',
      campaignVersionId: 'engine-mixed-cycles-v3',
      campaignCode: 'ENGINE_MIXED_CYCLES',
      version: 1,
      status: 'ACTIVE',
      publishedAt: '2026-08-01T06:00:00.000Z',
      claimStartsAt: '2026-08-01T06:00:00.000Z',
      claimEndsAt: '2026-09-01T06:00:00.000Z',
      benefits: [{ benefitCode: 'SAAS_MIXED', kind: 'SAAS_PRICE', stackingGroups: [], rules }],
    })
    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: { catalog, offer: mixedOffer },
          saasSelections: [
            { targetType: 'PRODUCT', targetCode: 'CFDI_MODULE', priceCode: 'CFDI_MONTHLY', quantity: 1 },
            { targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 },
          ],
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_PROMOTIONAL_CYCLE_MISMATCH',
    )

    const increasingRule: CommercialCampaignRuleV2 = {
      code: 'POS_FIXED_300',
      type: 'FIXED_PRICE',
      priority: 100,
      target: { productCodes: ['POS'] },
      cycles: 3,
      amount: '300.00',
    }
    const increasingOffer = offerAuthority({
      schemaVersion: 3,
      contractVersion: '3.0.0',
      campaignVersionId: 'engine-increasing-v3',
      campaignCode: 'ENGINE_INCREASING',
      version: 1,
      status: 'ACTIVE',
      publishedAt: '2026-08-01T06:00:00.000Z',
      claimStartsAt: '2026-08-01T06:00:00.000Z',
      claimEndsAt: '2026-09-01T06:00:00.000Z',
      benefits: [{ benefitCode: 'SAAS_INCREASE', kind: 'SAAS_PRICE', stackingGroups: [], rules: [increasingRule] }],
    })
    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: { catalog, offer: increasingOffer },
          saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_OFFER_INCREASES_PRICE',
    )

    const emitted = emitCommercialOfferV3(stackedOfferSource())
    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: {
            catalog,
            offer: { ...emitted, verified: true } as unknown as CommercialQuoteV3Authorities['offer'],
          },
          saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_OFFER_AUTHORITY_INVALID',
    )

    const hostile = new Proxy<CommercialQuoteSelectionV2[]>(
      [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      {
        ownKeys() {
          throw new Error('hostile')
        },
      },
    )
    expectEngineError(
      () =>
        evaluateCommercialQuoteV3({
          authorities: { catalog, offer },
          saasSelections: hostile,
          hardwareSelections: [],
          rateBlockers: [],
          resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
        }),
      'COMMERCIAL_QUOTE_V3_INPUT_INVALID',
    )
  })

  describe('COMM-005 aggregate boundary certificate', () => {
    const resolvedAt = '2026-08-15T12:00:00.000Z'

    it('accepts exactly 50 SaaS matches and rejects 51 with the resolver error class', () => {
      const rule = boundaryRule(0)
      const boundary = validateCommercialOfferV3(
        boundaryOffer([{ benefitCode: 'SAAS_BOUNDARY', kind: 'SAAS_PRICE', stackingGroups: [], rules: [rule] }]),
      )
      const matches = Array.from({ length: 51 }, (_, index) => ({
        lineKey: `PRODUCT:POS_${index.toString().padStart(3, '0')}:MONTHLY`,
        ruleCodes: [rule.code],
      }))

      expect(
        resolveCommercialOfferV3({ offer: boundary, resolvedAt, saasMatches: matches.slice(0, 50), hardwareSelections: [], rateBlockers: [] })
          .applied,
      ).toHaveLength(COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxSaasMatches)
      expectResolutionBoundaryError(() =>
        resolveCommercialOfferV3({ offer: boundary, resolvedAt, saasMatches: matches, hardwareSelections: [], rateBlockers: [] }),
      )
    })

    it('accepts exactly 50 hardware selections and rejects 51 with the resolver error class', () => {
      const benefits = Array.from({ length: 51 }, (_, index) => boundaryHardwareBenefit(index))
      const boundary = validateCommercialOfferV3(boundaryOffer(benefits))
      const selections = benefits.map(benefit => ({ catalogKey: benefit.skuSnapshot.catalogKey, quantity: 1 }))

      const accepted = resolveCommercialOfferV3({
        offer: boundary,
        resolvedAt,
        saasMatches: [],
        hardwareSelections: selections.slice(0, 50),
        rateBlockers: [],
      })
      expect(accepted.applied).toHaveLength(COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxHardwareSelections)
      expectResolutionBoundaryError(() =>
        resolveCommercialOfferV3({ offer: boundary, resolvedAt, saasMatches: [], hardwareSelections: selections, rateBlockers: [] }),
      )
    })

    it('keeps the 101-rule fixture Offer-valid and rejects it only at the resolver boundary', () => {
      const firstRules = Array.from({ length: 100 }, (_, index) => boundaryRule(index, 'A_RULE'))
      const lastRule = boundaryRule(100, 'B_RULE')
      const boundary = validateCommercialOfferV3(
        boundaryOffer([
          { benefitCode: 'SAAS_A_RULES', kind: 'SAAS_PRICE', stackingGroups: [], rules: firstRules },
          { benefitCode: 'SAAS_B_RULE', kind: 'SAAS_PRICE', stackingGroups: [], rules: [lastRule] },
        ]),
      )
      expect(boundary.benefits).toHaveLength(2)

      const accepted = resolveCommercialOfferV3({
        offer: boundary,
        resolvedAt,
        saasMatches: [{ lineKey: 'PRODUCT:POS:POS_MONTHLY', ruleCodes: firstRules.map(rule => rule.code) }],
        hardwareSelections: [],
        rateBlockers: [],
      })
      expect(accepted.applied).toHaveLength(1)
      expect(accepted.exclusions).toHaveLength(99)

      expectResolutionBoundaryError(() =>
        resolveCommercialOfferV3({
          offer: boundary,
          resolvedAt,
          saasMatches: [{ lineKey: 'PRODUCT:POS:POS_MONTHLY', ruleCodes: [...firstRules, lastRule].map(rule => rule.code) }],
          hardwareSelections: [],
          rateBlockers: [],
        }),
      )
    })

    it('accepts 100 total benefits and rejects 101 with the Offer schema error class', () => {
      const hundred = boundaryOffer(Array.from({ length: 100 }, (_, index) => boundaryHardwareBenefit(index)))
      expect(validateCommercialOfferV3(hundred).benefits).toHaveLength(100)

      try {
        validateCommercialOfferV3(boundaryOffer(Array.from({ length: 101 }, (_, index) => boundaryHardwareBenefit(index))))
        throw new Error('EXPECTED_COMMERCIAL_OFFER_V3_BENEFIT_BOUNDARY_FAILURE')
      } catch (error) {
        expect(error).toBeInstanceOf(CommercialOfferV3Error)
        expect(error).toMatchObject({ code: 'COMMERCIAL_OFFER_V3_INVALID', rule: 'SCHEMA' })
      }
    })

    it('proves EXACT_STACK emits one applied item per ordered step and reaches 550 general applied items', () => {
      const rules = Array.from({ length: 10 }, (_, index) => boundaryRule(index, 'STACK_RULE'))
      const hardware = Array.from({ length: 50 }, (_, index) => boundaryHardwareBenefit(index))
      const boundary = validateCommercialOfferV3(
        boundaryOffer([
          ...hardware,
          {
            benefitCode: 'SAAS_EXACT_STACK',
            kind: 'SAAS_PRICE',
            rules,
            stackingGroups: [
              {
                code: 'EXACT_STACK',
                steps: rules.map((rule, index) => ({ position: index + 1, ruleCode: rule.code })),
              },
            ],
          },
        ]),
      )
      const result = resolveCommercialOfferV3({
        offer: boundary,
        resolvedAt,
        saasMatches: Array.from({ length: 50 }, (_, index) => ({
          lineKey: `PRODUCT:POS_${index.toString().padStart(3, '0')}:MONTHLY`,
          ruleCodes: rules.map(rule => rule.code).reverse(),
        })),
        hardwareSelections: hardware.map(benefit => ({ catalogKey: benefit.skuSnapshot.catalogKey, quantity: 1 })),
        rateBlockers: [],
      })

      expect(result.applied.filter(item => item.subjectKind === 'SAAS_LINE')).toHaveLength(50 * 10)
      expect(result.applied.filter(item => item.subjectKind === 'HARDWARE_SKU')).toHaveLength(50)
      expect(result.applied).toHaveLength(550)
      expect(result.applied.filter(item => item.subjectKind === 'SAAS_LINE').slice(0, 10).map(item => item.ruleCode)).toEqual(
        rules.map(rule => rule.code),
      )
    })

    it('materializes the reachable maximum of 5,049 exclusions and proves higher defensive branches unreachable', () => {
      const rules = Array.from({ length: 100 }, (_, index) => boundaryRule(index, 'EXCLUSION_RULE'))
      const hardware = Array.from({ length: 99 }, (_, index) => boundaryHardwareBenefit(index))
      const boundary = validateCommercialOfferV3(
        boundaryOffer([
          ...hardware,
          { benefitCode: 'SAAS_EXCLUSIONS', kind: 'SAAS_PRICE', stackingGroups: [], rules },
        ]),
      )
      const result = resolveCommercialOfferV3({
        offer: boundary,
        resolvedAt,
        saasMatches: Array.from({ length: 50 }, (_, index) => ({
          lineKey: `PRODUCT:POS_${index.toString().padStart(3, '0')}:MONTHLY`,
          ruleCodes: rules.map(rule => rule.code),
        })),
        hardwareSelections: [],
        rateBlockers: [],
      })

      const maximumQuoteApplied = 50 * 10
      const maximumGeneralApplied = maximumQuoteApplied + 50
      const maximumSaasExclusions = 50 * (100 - 1)
      const maximumNonSaasExclusions = 100 - 1
      const maximumReachableExclusions = maximumSaasExclusions + maximumNonSaasExclusions

      expect(result.applied).toHaveLength(50)
      expect(result.exclusions).toHaveLength(5_049)
      expect(maximumQuoteApplied).toBe(500)
      expect(maximumGeneralApplied).toBe(550)
      expect(maximumGeneralApplied).toBeLessThan(601)
      expect(maximumGeneralApplied).toBeLessThanOrEqual(COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxAppliedItems)
      expect(maximumReachableExclusions).toBe(5_049)
      expect(maximumReachableExclusions).toBeLessThan(5_050)
      expect(maximumReachableExclusions).toBeLessThan(5_051)
      expect(maximumReachableExclusions).toBeLessThanOrEqual(COMMERCIAL_OFFER_RESOLUTION_V2_LIMITS.maxExcludedItems)
    })

    it('accepts a real 50-line Quote and rejects a 51st combined line with QUOTE_LINE_COUNT', () => {
      const catalogSource = clone(catalogFixture) as CommercialCatalogSnapshotV2
      const pos = catalogSource.products.find(product => product.code === 'POS')!
      const free = catalogSource.products.find(product => product.code === 'FREE')!
      catalogSource.products = Array.from({ length: 50 }, (_, index) => {
        const suffix = index.toString().padStart(2, '0')
        const productCode = `P_${suffix}`
        return {
          ...clone(pos),
          code: productCode,
          slug: `p-${suffix}`,
          name: `Product ${suffix}`,
          sortOrder: index + 1,
          capabilityBindings: [clone(index % 2 === 0 ? pos.capabilityBindings[0] : free.capabilityBindings[0])],
          prices: [{ ...clone(pos.prices[0]), code: `${productCode}_MONTHLY`, amount: '1.00' }],
        }
      })
      catalogSource.bundles = []
      const fiftyCatalog = emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: catalogSource })
      const neutral = offerAuthority(
        boundaryOffer([
          {
            benefitCode: 'PAYMENTS_NEUTRAL',
            kind: 'PAYMENTS_RATE_SCHEDULE',
            paymentsRateScheduleVersionId: 'payments-rate-schedule-version-boundary-v1',
          },
        ]),
      )
      const authorities: CommercialQuoteV3Authorities = { catalog: fiftyCatalog, offer: neutral, acquisitionContext: null }
      const evaluation = evaluateCommercialQuoteV3({
        authorities,
        saasSelections: catalogSource.products.map(product => ({
          targetType: 'PRODUCT' as const,
          targetCode: product.code,
          priceCode: product.prices[0].code,
          quantity: 1,
        })),
        hardwareSelections: [],
        rateBlockers: [],
        resolvedAt: new Date(resolvedAt),
      })
      const emitted = buildCommercialQuoteV3({
        quoteId: 'commercial-quote-fifty-lines-v3',
        subject: { kind: 'VENUE', organizationId: 'organization-fifty', venueId: 'venue-fifty', actorId: 'staff-fifty' },
        acquisitionContextId: null,
        derivedFromPreview: null,
        quotedAt: new Date(resolvedAt),
        expiresAt: new Date('2026-08-15T12:15:00.000Z'),
        evaluation,
        authorities,
      })

      expect(emitted.snapshot.saasLines).toHaveLength(50)
      expect(validateCommercialQuoteV3(emitted.snapshot, authorities)).toEqual(emitted.snapshot)
      const canonicalBytes = canonicalJsonBytesV2(emitted.snapshot).byteLength
      const jsonbTextBytes = Buffer.byteLength(JSON.stringify(emitted.snapshot), 'utf8')
      expect(canonicalBytes).toBeLessThanOrEqual(3_145_728)
      expect(jsonbTextBytes).toBeLessThanOrEqual(4_194_304)

      const over = clone(emitted.snapshot)
      over.hardwareLines.push(
        clone(directFixture.hardwareLines[0]) as CommercialQuoteSnapshotV3['hardwareLines'][number],
      )
      try {
        validateCommercialQuoteV3(over, authorities)
        throw new Error('EXPECTED_COMMERCIAL_QUOTE_V3_LINE_BOUNDARY_FAILURE')
      } catch (error) {
        expect(error).toBeInstanceOf(CommercialQuoteV3Error)
        expect(error).toMatchObject({ code: 'COMMERCIAL_QUOTE_V3_INVALID', rule: 'QUOTE_LINE_COUNT' })
      }
    })
  })
})
