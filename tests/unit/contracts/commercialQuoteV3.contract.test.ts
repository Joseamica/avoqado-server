import { createHash } from 'node:crypto'
import Ajv from 'ajv'

import quoteV2Schema from '@/contracts/commercial/commercial-quote-v2.schema.json'
import quoteV3Schema from '@/contracts/commercial/commercial-quote-v3.schema.json'
import resolutionSchema from '@/contracts/commercial/commercial-offer-resolution-v2.schema.json'
import {
  MAX_LINE_LIST_SUBTOTAL_MINOR,
  MAX_QUOTE_DISCOUNT_MINOR,
  MAX_QUOTE_LIST_SUBTOTAL_MINOR,
  MAX_QUOTE_TAX_MINOR,
  MAX_QUOTE_TOTAL_MINOR,
  MAX_UNIT_AMOUNT_MINOR,
  COMMERCIAL_JSON_TEXT_V2_MAX_BYTES,
} from '@/contracts/commercial/commercialContractV2.constants'
import anonymousFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-anonymous-preview.json'
import bridgedFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-bridged.json'
import directFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-direct.json'
import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { canonicalJsonBytesV2 } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import {
  COMMERCIAL_ARTIFACT_CODEC_REGISTRY,
  resolveCommercialArtifactCodec,
} from '@/services/commercial/commercialArtifactCodecRegistryDefinition.service'
import { evaluateCommercialQuoteV2 } from '@/services/commercial/commercialQuoteEngineV2.service'
import { assertCommercialMoneyLimitV2, parseCommercialMoneyV2 } from '@/services/commercial/commercialMoneyV2.service'
import {
  COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES,
  COMMERCIAL_QUOTE_V3_JSONB_TEXT_UPPER_BOUND_ESTIMATE_BYTES,
  COMMERCIAL_QUOTE_V3_CHECKSUM_DOMAIN,
  CommercialQuoteV3Error,
  decodeAndVerifyStoredCommercialQuoteV3,
  emitCommercialQuoteV3,
  validateCommercialQuoteV3,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Contract.service'
import { decodeAndVerifyStoredCommercialOfferV3, emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import { resolveCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferStacking.service'
import type { CommercialCampaignRuleV2, CommercialCampaignSnapshotV2, CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialBenefitV3, CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'
import type { CommercialQuoteSnapshotV3, CommercialQuoteV3Authorities, CommercialQuoteV3DecodeInput } from '@/types/commercialQuoteV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
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

function verifiedOffer(source: CommercialOfferSnapshotV3): CommercialQuoteV3Authorities['offer'] {
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
const offer = verifiedOffer(stackedOfferSource())
const acquisitionContext = Object.freeze({ id: 'acquisition-context-summer-2026', createdAt: '2026-08-15T11:55:00.000Z' })

function authoritiesFor(value: CommercialQuoteSnapshotV3): CommercialQuoteV3Authorities {
  return {
    catalog,
    offer,
    acquisitionContext: value.acquisitionContextId === null ? null : acquisitionContext,
  }
}

function expectInvalid(value: unknown, rule?: string, authorities = authoritiesFor(value as CommercialQuoteSnapshotV3)): void {
  try {
    validateCommercialQuoteV3(value, authorities)
    throw new Error('EXPECTED_COMMERCIAL_QUOTE_V3_FAILURE')
  } catch (error) {
    expect(error).toBeInstanceOf(CommercialQuoteV3Error)
    expect(error).toMatchObject({ code: 'COMMERCIAL_QUOTE_V3_INVALID', ...(rule ? { rule } : {}) })
  }
}

function sum(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString()
}

function minor(value: string): string {
  return parseCommercialMoneyV2(value).toString()
}

function shaWithDomain(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(domain, 'ascii'), canonicalJsonBytesV2(value)]))
    .digest('hex')
}

function zeroBreakdown() {
  return { listSubtotalMinor: '0', discountMinor: '0', subtotalMinor: '0', taxMinor: '0', totalMinor: '0' }
}

function storedRowContext(fixture: CommercialQuoteSnapshotV3): CommercialQuoteV3DecodeInput['rowContext'] {
  const venue = fixture.subject.kind === 'VENUE' ? fixture.subject : null
  return {
    id: fixture.quoteId,
    schemaVersion: 3,
    catalogPublicationId: fixture.catalogPublicationId,
    offerVersionId: fixture.offerVersionId,
    acquisitionContextId: fixture.acquisitionContextId,
    organizationId: venue?.organizationId ?? null,
    venueId: venue?.venueId ?? null,
    createdById: venue?.actorId ?? null,
    venueOrganizationId: venue?.organizationId ?? null,
    market: fixture.market,
    currency: fixture.currency,
    quotedAt: new Date(fixture.quotedAt),
    expiresAt: new Date(fixture.expiresAt),
    listSubtotalMinor: BigInt(fixture.totals.dueNow.listSubtotalMinor),
    discountMinor: BigInt(fixture.totals.dueNow.discountMinor),
    subtotalMinor: BigInt(fixture.totals.dueNow.subtotalMinor),
    taxMinor: BigInt(fixture.totals.dueNow.taxMinor),
    totalMinor: BigInt(fixture.totals.dueNow.totalMinor),
    renewalSubtotalMinor: BigInt(fixture.renewal.subtotalMinor),
    renewalTaxMinor: BigInt(fixture.renewal.taxMinor),
    renewalTotalMinor: BigInt(fixture.renewal.totalMinor),
  }
}

function hardwareOnlyQuote(
  hardwareLine: CommercialQuoteSnapshotV3['hardwareLines'][number],
  hardwareOffer = offer,
): CommercialQuoteSnapshotV3 {
  const oneTime = {
    listSubtotalMinor: hardwareLine.listSubtotalMinor,
    discountMinor: hardwareLine.discountMinor,
    subtotalMinor: hardwareLine.subtotalMinor,
    taxMinor: hardwareLine.taxMinor,
    totalMinor: hardwareLine.totalMinor,
  }
  return {
    schemaVersion: 3,
    contractVersion: '3.0.0',
    quoteId: `hardware-only-${hardwareLine.catalogKey.toLowerCase()}`,
    subject: { kind: 'VENUE', organizationId: 'organization-hardware', venueId: 'venue-hardware', actorId: 'staff-hardware' },
    acquisitionContextId: null,
    derivedFromPreview: null,
    catalogPublicationId: catalog.snapshot.publicationId,
    catalogChecksum: catalog.checksum,
    offerVersionId: hardwareOffer.snapshot.campaignVersionId,
    offerCode: hardwareOffer.snapshot.campaignCode,
    offerChecksum: hardwareOffer.checksum,
    market: 'MX',
    currency: 'MXN',
    quotedAt: '2026-08-15T12:00:00.000Z',
    expiresAt: '2026-08-15T12:15:00.000Z',
    saasLines: [],
    hardwareLines: [hardwareLine],
    entitlementGrants: [],
    resolution: resolveCommercialOfferV3({
      offer: hardwareOffer.snapshot,
      resolvedAt: '2026-08-15T12:00:00.000Z',
      saasMatches: [],
      hardwareSelections: [{ catalogKey: hardwareLine.catalogKey, quantity: hardwareLine.quantity }],
      rateBlockers: [],
    }),
    totals: { recurringCurrent: zeroBreakdown(), oneTime, dueNow: oneTime },
    renewal: zeroBreakdown(),
  }
}

function saasOnlyQuoteFromV2(
  evaluated: ReturnType<typeof evaluateCommercialQuoteV2>,
  quoteOffer: CommercialQuoteV3Authorities['offer'],
  quoteId: string,
  saasMatches: Array<{ lineKey: string; ruleCodes: string[] }>,
): CommercialQuoteSnapshotV3 {
  const saasBenefits = quoteOffer.snapshot.benefits.filter(
    (benefit): benefit is Extract<CommercialBenefitV3, { kind: 'SAAS_PRICE' }> => benefit.kind === 'SAAS_PRICE',
  )
  const lines = evaluated.lines.map(line => ({
    lineKey: line.lineKey,
    targetType: line.targetType,
    targetCode: line.targetCode,
    priceCode: line.priceCode,
    quantity: line.quantity,
    productKind: line.productKind,
    name: line.name,
    billingUnit: line.billingUnit,
    currency: line.currency,
    taxRateBasisPoints: line.taxRateBasisPoints,
    listUnitAmountMinor: minor(line.unitAmount),
    listSubtotalMinor: minor(line.listSubtotal),
    appliedOfferSteps: line.appliedCampaigns.map(step => {
      const benefit = saasBenefits.find(candidate => candidate.rules.some(rule => rule.code === step.ruleCode))
      if (!benefit) throw new Error(`Missing Offer benefit for ${step.ruleCode}`)
      return {
        benefitCode: benefit.benefitCode,
        ruleCode: step.ruleCode,
        type: step.type,
        position: step.position,
        inputAmountMinor: minor(step.inputAmount),
        discountAmountMinor: minor(step.discountAmount),
        outputAmountMinor: minor(step.outputAmount),
        cycles: step.cycles,
      }
    }),
    discountMinor: minor(line.discount),
    subtotalMinor: minor(line.subtotal),
    taxMinor: minor(line.tax),
    totalMinor: minor(line.total),
    promotionalCycles: line.promotionalCycles,
    renewalSubtotalMinor: minor(line.renewalSubtotal),
    renewalTaxMinor: minor(line.renewalTax),
    renewalTotalMinor: minor(line.renewalTotal),
  }))
  const recurring = {
    listSubtotalMinor: minor(evaluated.totals.listSubtotal),
    discountMinor: minor(evaluated.totals.discount),
    subtotalMinor: minor(evaluated.totals.subtotal),
    taxMinor: minor(evaluated.totals.tax),
    totalMinor: minor(evaluated.totals.total),
  }
  const renewalSubtotal = minor(evaluated.renewal.subtotal)
  return {
    schemaVersion: 3,
    contractVersion: '3.0.0',
    quoteId,
    subject: { kind: 'VENUE', organizationId: 'organization-saas', venueId: 'venue-saas', actorId: 'staff-saas' },
    acquisitionContextId: null,
    derivedFromPreview: null,
    catalogPublicationId: catalog.snapshot.publicationId,
    catalogChecksum: catalog.checksum,
    offerVersionId: quoteOffer.snapshot.campaignVersionId,
    offerCode: quoteOffer.snapshot.campaignCode,
    offerChecksum: quoteOffer.checksum,
    market: 'MX',
    currency: 'MXN',
    quotedAt: '2026-08-15T12:00:00.000Z',
    expiresAt: '2026-08-15T12:15:00.000Z',
    saasLines: lines,
    hardwareLines: [],
    entitlementGrants: evaluated.entitlementGrants,
    resolution: resolveCommercialOfferV3({
      offer: quoteOffer.snapshot,
      resolvedAt: '2026-08-15T12:00:00.000Z',
      saasMatches,
      hardwareSelections: [],
      rateBlockers: [],
    }),
    totals: { recurringCurrent: recurring, oneTime: zeroBreakdown(), dueNow: recurring },
    renewal: {
      listSubtotalMinor: renewalSubtotal,
      discountMinor: '0',
      subtotalMinor: renewalSubtotal,
      taxMinor: minor(evaluated.renewal.tax),
      totalMinor: minor(evaluated.renewal.total),
    },
  }
}

describe('Commercial Quote v3 contract', () => {
  it('ships a strict composed schema with frozen line and resolution bounds', () => {
    const ajv = new Ajv({ allErrors: true, jsonPointers: true })
    ajv.addSchema(quoteV2Schema as object)
    ajv.addSchema(resolutionSchema as object)
    const validate = ajv.compile(quoteV3Schema as object)

    expect(quoteV3Schema.properties.saasLines.maxItems).toBe(50)
    expect(quoteV3Schema.properties.hardwareLines.maxItems).toBe(50)
    expect(quoteV3Schema.properties.entitlementGrants.maxItems).toBe(128)
    expect(quoteV3Schema.definitions.lineKey.maxLength).toBe(128)
    expect(validate(directFixture)).toBe(true)

    const unknown = clone(directFixture) as any
    unknown.saasLines[0].surprise = true
    expect(validate(unknown)).toBe(false)
  })

  it.each([
    ['direct venue', directFixture, true],
    ['anonymous acquisition preview', anonymousFixture, false],
    ['bridged venue', bridgedFixture, true],
  ])('round-trips the %s golden fixture and enforces stored-subject policy', (_label, source, persistable) => {
    const fixture = clone(source) as CommercialQuoteSnapshotV3
    const authorities = authoritiesFor(fixture)
    const validated = validateCommercialQuoteV3(fixture, authorities)
    const emitted = emitCommercialQuoteV3(fixture, authorities)

    expect(validated).toEqual(source)
    expect(Object.isFrozen(validated)).toBe(true)
    expect(Object.isFrozen(validated.resolution.applied)).toBe(true)
    expect(emitted.snapshot).toEqual(validated)
    expect(emitted.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(emitCommercialQuoteV3(clone(fixture), authorities).checksum).toBe(emitted.checksum)

    const decodeInput = {
      rowSchemaVersion: 3,
      snapshot: emitted.snapshot,
      checksum: emitted.checksum,
      rowContext: storedRowContext(fixture),
      authorities,
    }
    if (!persistable) {
      try {
        decodeAndVerifyStoredCommercialQuoteV3(decodeInput)
        throw new Error('EXPECTED_ANONYMOUS_STORED_QUOTE_FAILURE')
      } catch (error) {
        expect(error).toMatchObject({ code: 'COMMERCIAL_QUOTE_V3_INVALID', rule: 'STORED_SUBJECT' })
      }
      return
    }
    const decoded = decodeAndVerifyStoredCommercialQuoteV3(decodeInput)
    expect(decoded).toMatchObject({ kind: 'COMMERCIAL_QUOTE', schemaVersion: 3, mode: 'READ_WRITE', verified: true })
    expect(decoded.snapshot).toEqual(source)
  })

  it('uses the dedicated Quote v3 checksum domain and fails cross-domain decoding', () => {
    const fixture = clone(directFixture) as CommercialQuoteSnapshotV3
    const emitted = emitCommercialQuoteV3(fixture, authoritiesFor(fixture))
    expect(COMMERCIAL_QUOTE_V3_CHECKSUM_DOMAIN).toBe('avoqado.commercial.quote@3\0')
    expect(COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES).toBe(3_145_728)
    expect(emitted.checksum).not.toBe(shaWithDomain('avoqado.commercial.quote@2\0', emitted.snapshot))
    expect(emitted.checksum).not.toBe(shaWithDomain('avoqado.commercial.quote-preview-token@3\0', emitted.snapshot))
    expect(() =>
      decodeAndVerifyStoredCommercialQuoteV3({
        rowSchemaVersion: 3,
        snapshot: emitted.snapshot,
        checksum: shaWithDomain('avoqado.commercial.quote-preview-token@3\0', emitted.snapshot),
        rowContext: storedRowContext(fixture),
        authorities: authoritiesFor(fixture),
      }),
    ).toThrow(CommercialQuoteV3Error)
    try {
      decodeAndVerifyStoredCommercialQuoteV3({
        rowSchemaVersion: 3,
        snapshot: emitted.snapshot,
        checksum: shaWithDomain('avoqado.commercial.quote-preview-token@3\0', emitted.snapshot),
        rowContext: storedRowContext(fixture),
        authorities: authoritiesFor(fixture),
      })
    } catch (error) {
      expect(error).toMatchObject({ code: 'COMMERCIAL_QUOTE_V3_CHECKSUM_MISMATCH' })
    }
  })

  it('pins bridged fixture lineage to the emitted anonymous preview checksum', () => {
    const anonymous = clone(anonymousFixture) as CommercialQuoteSnapshotV3
    const preview = emitCommercialQuoteV3(anonymous, authoritiesFor(anonymous))
    expect(bridgedFixture.derivedFromPreview).toMatchObject({
      previewQuoteId: anonymous.quoteId,
      previewChecksum: preview.checksum,
    })
  })

  it('rejects a merely emitted Offer and accepts only a row-verified Offer authority', () => {
    const fixture = clone(directFixture) as CommercialQuoteSnapshotV3
    const emittedOffer = emitCommercialOfferV3(stackedOfferSource())
    expectInvalid(fixture, 'OFFER_AUTHORITY', {
      catalog,
      offer: emittedOffer as unknown as CommercialQuoteV3Authorities['offer'],
      acquisitionContext: null,
    })
  })

  it('rejects a caller-forged verified flag without Offer row identity evidence', () => {
    const fixture = clone(directFixture) as CommercialQuoteSnapshotV3
    const emittedOffer = emitCommercialOfferV3(stackedOfferSource())
    const forged = { ...emittedOffer, verified: true as const }
    expectInvalid(fixture, 'OFFER_AUTHORITY', {
      catalog,
      offer: forged as unknown as CommercialQuoteV3Authorities['offer'],
      acquisitionContext: null,
    })
  })

  it('maps a malformed Offer authority to the Quote v3 error vocabulary', () => {
    const fixture = clone(directFixture) as CommercialQuoteSnapshotV3
    expectInvalid(fixture, 'OFFER_AUTHORITY', {
      catalog,
      offer: null as unknown as CommercialQuoteV3Authorities['offer'],
      acquisitionContext: null,
    })
  })

  it('leaves the general v1/v2 registry byte-for-byte unchanged and rejects Quote schema 3', () => {
    expect(COMMERCIAL_ARTIFACT_CODEC_REGISTRY).toEqual([
      { kind: 'CATALOG', schemaVersion: 1, mode: 'READ_ONLY' },
      { kind: 'CATALOG', schemaVersion: 2, mode: 'READ_WRITE' },
      { kind: 'CAMPAIGN', schemaVersion: 1, mode: 'READ_ONLY' },
      { kind: 'CAMPAIGN', schemaVersion: 2, mode: 'READ_WRITE' },
      { kind: 'QUOTE', schemaVersion: 1, mode: 'READ_ONLY' },
      { kind: 'QUOTE', schemaVersion: 2, mode: 'READ_WRITE' },
    ])
    expect(resolveCommercialArtifactCodec('QUOTE', 3)).toBeUndefined()
  })

  it('freezes numeric stacking order even when ASCII rule-code order differs', () => {
    const fixture = clone(directFixture) as CommercialQuoteSnapshotV3
    const steps = fixture.saasLines[0].appliedOfferSteps
    expect(steps.map(step => step.ruleCode)).toEqual(['Z_FIXED_200', 'A_TEN_PERCENT'])
    expect(steps.map(step => step.position)).toEqual([1, 2])
    expect(fixture.resolution.applied.filter(item => item.subjectKind === 'SAAS_LINE').map(item => item.ruleCode)).toEqual([
      'Z_FIXED_200',
      'A_TEN_PERCENT',
    ])
    expect(validateCommercialQuoteV3(fixture, authoritiesFor(fixture))).toEqual(fixture)
  })

  it('rejects a jointly reordered SaaS stack even when its alternate arithmetic is internally exact', () => {
    const value = clone(directFixture) as any
    value.saasLines[0].appliedOfferSteps = [
      {
        benefitCode: 'SAAS_POS_50',
        ruleCode: 'A_TEN_PERCENT',
        type: 'PERCENT_OFF',
        position: 1,
        inputAmountMinor: '24900',
        discountAmountMinor: '2490',
        outputAmountMinor: '22410',
        cycles: 3,
      },
      {
        benefitCode: 'SAAS_POS_50',
        ruleCode: 'Z_FIXED_200',
        type: 'FIXED_PRICE',
        position: 2,
        inputAmountMinor: '22410',
        discountAmountMinor: '2410',
        outputAmountMinor: '20000',
        cycles: 3,
      },
    ]
    value.saasLines[0].discountMinor = '4900'
    value.saasLines[0].subtotalMinor = '20000'
    value.saasLines[0].taxMinor = '3200'
    value.saasLines[0].totalMinor = '23200'
    const saasApplied = value.resolution.applied.filter((item: { subjectKind: string }) => item.subjectKind === 'SAAS_LINE')
    saasApplied.reverse()
    value.resolution.applied = [value.resolution.applied[0], ...saasApplied]
    expectInvalid(value, 'RESOLUTION_COMPLETENESS')
  })

  it('freezes partial hardware pricing and explicit list-price excess', () => {
    const fixture = clone(directFixture) as CommercialQuoteSnapshotV3
    const line = fixture.hardwareLines[0]
    expect(line).toMatchObject({ quantity: 5, benefitedQuantity: 2, listPriceQuantity: 3 })
    expect(line.appliedBenefit).toMatchObject({ benefitCode: 'HARDWARE_N62_FIXED', appliedQuantity: 2 })
    expect(fixture.resolution.exclusions).toContainEqual({
      subjectKind: 'HARDWARE_SKU',
      subjectKey: 'NEXGO_N62',
      benefitCode: 'HARDWARE_N62_FIXED',
      excludedQuantity: 3,
      accountingEffect: 'LIST_PRICE_EXCESS',
      reasonCode: 'HARDWARE_QUANTITY_EXCEEDED',
    })
  })

  it('uses one line-level rounding for a partial hardware percent benefit', () => {
    const source = clone(offerFixture) as CommercialOfferSnapshotV3
    const percent = source.benefits.find(benefit => benefit.kind === 'HARDWARE_PERCENT_OFF')!
    if (percent.kind !== 'HARDWARE_PERCENT_OFF') throw new Error('Expected percent hardware benefit')
    source.benefits = source.benefits.filter(benefit => benefit.kind !== 'SAAS_PRICE')
    const percentOffer = verifiedOffer(source)
    const line: CommercialQuoteSnapshotV3['hardwareLines'][number] = {
      lineKey: 'HARDWARE_SKU:PAX_A910S',
      catalogKey: 'PAX_A910S',
      skuSnapshot: percent.skuSnapshot,
      quantity: 2,
      benefitedQuantity: 1,
      listPriceQuantity: 1,
      appliedBenefit: {
        kind: 'HARDWARE_PERCENT_OFF',
        benefitCode: percent.benefitCode,
        percentBasisPoints: percent.percentBasisPoints,
        appliedQuantity: 1,
      },
      currency: 'MXN',
      taxRateBasisPoints: 1600,
      listSubtotalMinor: '800000',
      discountMinor: '40000',
      subtotalMinor: '760000',
      taxMinor: '121600',
      totalMinor: '881600',
    }
    const quote = hardwareOnlyQuote(line, percentOffer)
    expect(validateCommercialQuoteV3(quote, { catalog, offer: percentOffer, acquisitionContext: null })).toEqual(quote)
  })

  it('prices every hardware unit at frozen list when the benefit window is inactive', () => {
    const source = clone(offerFixture) as CommercialOfferSnapshotV3
    const percent = source.benefits.find(benefit => benefit.kind === 'HARDWARE_PERCENT_OFF')!
    if (percent.kind !== 'HARDWARE_PERCENT_OFF') throw new Error('Expected percent hardware benefit')
    percent.benefitStartsAt = '2026-08-20T06:00:00.000Z'
    percent.benefitEndsAt = '2026-08-25T06:00:00.000Z'
    source.benefits = source.benefits.filter(benefit => benefit.kind !== 'SAAS_PRICE')
    const inactiveOffer = verifiedOffer(source)
    const line: CommercialQuoteSnapshotV3['hardwareLines'][number] = {
      lineKey: 'HARDWARE_SKU:PAX_A910S',
      catalogKey: 'PAX_A910S',
      skuSnapshot: percent.skuSnapshot,
      quantity: 2,
      benefitedQuantity: 0,
      listPriceQuantity: 2,
      appliedBenefit: null,
      currency: 'MXN',
      taxRateBasisPoints: 1600,
      listSubtotalMinor: '800000',
      discountMinor: '0',
      subtotalMinor: '800000',
      taxMinor: '128000',
      totalMinor: '928000',
    }
    const quote = hardwareOnlyQuote(line, inactiveOffer)
    const validated = validateCommercialQuoteV3(quote, { catalog, offer: inactiveOffer, acquisitionContext: null })
    expect(validated.hardwareLines[0]).toMatchObject({ benefitedQuantity: 0, listPriceQuantity: 2, appliedBenefit: null })
    expect(validated.resolution.exclusions).toContainEqual({
      subjectKind: 'HARDWARE_SKU',
      subjectKey: 'PAX_A910S',
      benefitCode: percent.benefitCode,
      accountingEffect: 'EXPLANATORY',
      reasonCode: 'HARDWARE_WINDOW_INACTIVE',
    })
  })

  it('rejects CONTACT products even when a future catalog publication gives them a price', () => {
    const source = clone(catalogFixture) as CommercialCatalogSnapshotV2
    const enterprise = source.products.find(product => product.code === 'ENTERPRISE')!
    enterprise.prices = [
      {
        code: 'ENTERPRISE_MONTHLY',
        billingUnit: 'VENUE_MONTH',
        amount: '1000.00',
        currency: 'MXN',
        taxBehavior: 'EXCLUSIVE',
        taxRateBasisPoints: 1600,
      },
    ]
    const contactCatalog = emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: source })
    const value = clone(directFixture) as any
    value.catalogChecksum = contactCatalog.checksum
    value.saasLines[0] = {
      ...value.saasLines[0],
      lineKey: 'PRODUCT:ENTERPRISE:ENTERPRISE_MONTHLY',
      targetCode: 'ENTERPRISE',
      priceCode: 'ENTERPRISE_MONTHLY',
      productKind: 'PLAN',
      name: 'Enterprise',
      listUnitAmountMinor: '100000',
      listSubtotalMinor: '100000',
      appliedOfferSteps: [],
      discountMinor: '0',
      subtotalMinor: '100000',
      taxMinor: '16000',
      totalMinor: '116000',
      promotionalCycles: null,
      renewalSubtotalMinor: '100000',
      renewalTaxMinor: '16000',
      renewalTotalMinor: '116000',
    }
    expectInvalid(value, 'CATALOG_LINE_AUTHORITY', { catalog: contactCatalog, offer, acquisitionContext: null })
  })

  it.each([
    ['unknown root property', (value: any) => Object.assign(value, { surprise: true }), 'SCHEMA'],
    ['unknown line property', (value: any) => Object.assign(value.saasLines[0], { surprise: true }), 'SCHEMA'],
    ['unknown benefit kind', (value: any) => Object.assign(value.hardwareLines[0].appliedBenefit, { kind: 'MYSTERY' }), 'SCHEMA'],
    ['non-canonical money', (value: any) => Object.assign(value.saasLines[0], { subtotalMinor: '018000' }), 'SCHEMA'],
    ['inverted timestamps', (value: any) => Object.assign(value, { expiresAt: value.quotedAt }), 'QUOTE_TIMESTAMP_ORDER'],
    ['wrong SaaS line key', (value: any) => Object.assign(value.saasLines[0], { lineKey: 'PRODUCT:WRONG:POS_MONTHLY' }), 'QUOTE_LINE_KEY'],
    ['unordered line collections', (value: any) => value.hardwareLines.unshift(clone(value.hardwareLines[0])), 'QUOTE_LINE_UNIQUE'],
  ])('rejects %s', (_label, mutate: (value: any) => void, rule) => {
    const value = clone(directFixture)
    mutate(value)
    expectInvalid(value, rule)
  })

  it('enforces the combined 1..50 line bound before downstream line validation', () => {
    const empty = clone(directFixture) as any
    empty.saasLines = []
    empty.hardwareLines = []
    empty.entitlementGrants = []
    expectInvalid(empty, 'QUOTE_LINE_COUNT')

    const over = clone(directFixture) as any
    over.hardwareLines = Array.from({ length: 50 }, () => clone(over.hardwareLines[0]))
    expectInvalid(over, 'QUOTE_LINE_COUNT')
  })

  it('rejects unique lines that are not strictly ASCII-sorted', () => {
    const value = clone(directFixture) as any
    const pax = clone(value.hardwareLines[0])
    pax.lineKey = 'HARDWARE_SKU:PAX_A910S'
    pax.catalogKey = 'PAX_A910S'
    pax.skuSnapshot.catalogKey = 'PAX_A910S'
    value.hardwareLines.unshift(pax)
    expectInvalid(value, 'QUOTE_LINE_ORDER')
  })

  it('rejects invented entitlements and incomplete authoritative origins', () => {
    const invented = clone(directFixture) as any
    invented.entitlementGrants.push({
      ...clone(invented.entitlementGrants[0]),
      capabilityCode: 'ZZZ_INVENTED',
    })
    expectInvalid(invented, 'ENTITLEMENT_AUTHORITY')

    const incomplete = clone(directFixture) as any
    incomplete.entitlementGrants[0].origins = incomplete.entitlementGrants[0].origins.filter(
      (origin: { kind: string }) => origin.kind !== 'CAMPAIGN',
    )
    expectInvalid(incomplete, 'ENTITLEMENT_AUTHORITY')
  })

  it('validates the embedded resolution with its frozen strict validator before Quote schema errors', () => {
    const value = clone(directFixture) as any
    value.resolution.applied[0].surprise = true
    expectInvalid(value, 'RESOLUTION_SCHEMA')
  })

  it('rejects line keys that the frozen resolution-v2 contract cannot represent', () => {
    const productCode = `P${'X'.repeat(63)}`
    const priceCode = `R${'Y'.repeat(63)}`
    const catalogSource = clone(catalogFixture) as CommercialCatalogSnapshotV2
    const pos = catalogSource.products.find(product => product.code === 'POS')!
    pos.code = productCode
    pos.prices[0].code = priceCode
    const longCatalog = emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: catalogSource })

    const offerSource: CommercialOfferSnapshotV3 = {
      schemaVersion: 3,
      contractVersion: '3.0.0',
      campaignVersionId: 'commercial-offer-version-long-line-v3',
      campaignCode: 'LONG_LINE_V3',
      version: 1,
      status: 'ACTIVE',
      publishedAt: '2026-08-01T06:00:00.000Z',
      claimStartsAt: '2026-08-01T06:00:00.000Z',
      claimEndsAt: '2026-09-01T06:00:00.000Z',
      benefits: [
        {
          benefitCode: 'LONG_LINE_SAAS',
          kind: 'SAAS_PRICE',
          stackingGroups: [],
          rules: [
            {
              code: 'LONG_LINE_TEN_PERCENT',
              type: 'PERCENT_OFF',
              priority: 100,
              target: { productCodes: [productCode] },
              cycles: 3,
              percentBasisPoints: 1000,
            },
          ],
        },
      ],
    }
    const longOffer = verifiedOffer(offerSource)
    const value = clone(directFixture) as any
    value.catalogChecksum = longCatalog.checksum
    value.offerVersionId = longOffer.snapshot.campaignVersionId
    value.offerCode = longOffer.snapshot.campaignCode
    value.offerChecksum = longOffer.checksum
    value.resolution.campaignVersionId = longOffer.snapshot.campaignVersionId
    value.saasLines[0] = {
      ...value.saasLines[0],
      lineKey: `PRODUCT:${productCode}:${priceCode}`,
      targetCode: productCode,
      priceCode,
      appliedOfferSteps: [
        {
          benefitCode: 'LONG_LINE_SAAS',
          ruleCode: 'LONG_LINE_TEN_PERCENT',
          type: 'PERCENT_OFF',
          position: 1,
          inputAmountMinor: '24900',
          discountAmountMinor: '2490',
          outputAmountMinor: '22410',
          cycles: 3,
        },
      ],
      discountMinor: '2490',
      subtotalMinor: '22410',
      taxMinor: '3586',
      totalMinor: '25996',
    }
    value.hardwareLines = []
    value.totals.recurringCurrent = {
      listSubtotalMinor: '24900',
      discountMinor: '2490',
      subtotalMinor: '22410',
      taxMinor: '3586',
      totalMinor: '25996',
    }
    value.totals.oneTime = zeroBreakdown()
    value.totals.dueNow = clone(value.totals.recurringCurrent)
    expect(value.saasLines[0].lineKey.length).toBeGreaterThan(128)
    expectInvalid(value, 'QUOTE_LINE_KEY_LENGTH', {
      catalog: longCatalog,
      offer: longOffer,
      acquisitionContext: null,
    })
  })

  it('turns cyclic and hostile object graphs into a stable materialization error', () => {
    const cyclic = clone(directFixture) as any
    cyclic.self = cyclic
    expectInvalid(cyclic, 'MATERIALIZATION')

    const hostile = new Proxy(clone(directFixture), {
      ownKeys() {
        throw new Error('hostile ownKeys')
      },
    })
    expectInvalid(hostile, 'MATERIALIZATION')
  })

  it('rejects hardware bytes that do not match the frozen Offer SKU snapshot', () => {
    const value = clone(directFixture) as any
    value.hardwareLines[0].skuSnapshot.brand = 'INVENTED'
    expectInvalid(value, 'HARDWARE_AUTHORITY')
  })

  it('rejects an Offer rule that would raise a published SaaS price', () => {
    const source = stackedOfferSource()
    const saas = source.benefits.find(benefit => benefit.kind === 'SAAS_PRICE')!
    if (saas.kind !== 'SAAS_PRICE') throw new Error('Expected SaaS benefit')
    saas.rules = [
      {
        code: 'POS_FIXED_300',
        type: 'FIXED_PRICE',
        priority: 100,
        target: { productCodes: ['POS'] },
        cycles: 3,
        amount: '300.00',
      },
    ]
    saas.stackingGroups = []
    const increasingOffer = verifiedOffer(source)
    const value = clone(directFixture) as any
    value.offerChecksum = increasingOffer.checksum
    value.saasLines[0].appliedOfferSteps = [
      {
        benefitCode: saas.benefitCode,
        ruleCode: 'POS_FIXED_300',
        type: 'FIXED_PRICE',
        position: 1,
        inputAmountMinor: '24900',
        discountAmountMinor: '0',
        outputAmountMinor: '24900',
        cycles: 3,
      },
    ]
    expectInvalid(value, 'OFFER_INCREASES_PRICE', {
      catalog,
      offer: increasingOffer,
      acquisitionContext: null,
    })
  })

  it.each([
    ['SaaS list multiplication', (value: any) => (value.saasLines[0].listSubtotalMinor = '24901')],
    ['SaaS discount identity', (value: any) => (value.saasLines[0].discountMinor = '24901')],
    ['SaaS step chain', (value: any) => (value.saasLines[0].appliedOfferSteps[1].inputAmountMinor = '19999')],
    ['SaaS exact rule calculation', (value: any) => (value.saasLines[0].appliedOfferSteps[1].outputAmountMinor = '18001')],
    ['SaaS line tax', (value: any) => (value.saasLines[0].taxMinor = '2881')],
    ['SaaS renewal', (value: any) => (value.saasLines[0].renewalTotalMinor = '28885')],
    ['hardware quantity identity', (value: any) => (value.hardwareLines[0].listPriceQuantity = 2)],
    ['hardware list multiplication', (value: any) => (value.hardwareLines[0].listSubtotalMinor = '899999')],
    ['hardware fixed-price calculation', (value: any) => (value.hardwareLines[0].subtotalMinor = '840001')],
    ['hardware line tax', (value: any) => (value.hardwareLines[0].taxMinor = '134401')],
    ['recurring aggregate', (value: any) => (value.totals.recurringCurrent.totalMinor = '20881')],
    ['one-time aggregate', (value: any) => (value.totals.oneTime.totalMinor = '974401')],
    ['due-now aggregate', (value: any) => (value.totals.dueNow.totalMinor = '995281')],
    ['root renewal aggregate', (value: any) => (value.renewal.totalMinor = '28885')],
  ])('rejects broken %s', (_label, mutate: (value: any) => void) => {
    const value = clone(directFixture)
    mutate(value)
    expectInvalid(value, 'QUOTE_ARITHMETIC')
  })

  it('rejects provenance, resolution omissions, invented entries and reordered resolver bytes', () => {
    const wrongCatalog = clone(directFixture) as any
    wrongCatalog.catalogChecksum = '0'.repeat(64)
    expectInvalid(wrongCatalog, 'CATALOG_AUTHORITY')

    const wrongOffer = clone(directFixture) as any
    wrongOffer.offerChecksum = '0'.repeat(64)
    expectInvalid(wrongOffer, 'OFFER_AUTHORITY')

    const omitted = clone(directFixture) as any
    omitted.resolution.exclusions.pop()
    expectInvalid(omitted, 'RESOLUTION_COMPLETENESS')

    const reordered = clone(directFixture) as any
    reordered.resolution.applied.reverse()
    expectInvalid(reordered, 'RESOLUTION_COMPLETENESS')
  })

  it('preserves a PAYMENTS_RATE resolution item byte-for-byte without a line or money effect', () => {
    const fixture = clone(directFixture) as CommercialQuoteSnapshotV3
    const rateItems = fixture.resolution.exclusions.filter(item => item.subjectKind === 'PAYMENTS_RATE')
    expect(rateItems).toEqual([
      {
        subjectKind: 'PAYMENTS_RATE',
        subjectKey: 'payments-rate-schedule-version-starter-2026-v1',
        benefitCode: 'PAYMENTS_STARTER_RATE',
        accountingEffect: 'EXPLANATORY',
        reasonCode: 'RATE_SCHEDULE_AUTHORITY_UNAVAILABLE',
      },
    ])
    expect(fixture.hardwareLines).toHaveLength(1)
    expect(fixture.saasLines).toHaveLength(1)
  })

  it('enforces all three distinct lineage states against the acquisition authority', () => {
    const anonymous = clone(anonymousFixture) as any
    anonymous.subject.acquisitionContextId = 'wrong-acquisition'
    expectInvalid(anonymous, 'QUOTE_LINEAGE')

    const direct = clone(directFixture) as any
    direct.acquisitionContextId = acquisitionContext.id
    direct.derivedFromPreview = {
      previewQuoteId: 'preview-direct-lineage-test',
      previewChecksum: '1'.repeat(64),
      selectionFingerprint: '2'.repeat(64),
    }
    expectInvalid(direct, 'QUOTE_LINEAGE', { catalog, offer, acquisitionContext })

    const bridged = clone(bridgedFixture) as any
    bridged.resolution.resolvedAt = bridged.quotedAt
    expectInvalid(bridged, 'QUOTE_LINEAGE')

    expectInvalid(clone(anonymousFixture), 'ACQUISITION_AUTHORITY', { catalog, offer, acquisitionContext: null })
  })

  it('normalizes the acquisition row Date before comparing lineage timestamps', () => {
    const fixture = clone(anonymousFixture) as CommercialQuoteSnapshotV3
    expect(
      validateCommercialQuoteV3(fixture, {
        catalog,
        offer,
        acquisitionContext: {
          id: acquisitionContext.id,
          createdAt: new Date(acquisitionContext.createdAt),
        },
      }),
    ).toEqual(fixture)
  })

  it('binds stored Quote bytes to schema version and immutable row identity', () => {
    const fixture = clone(directFixture) as CommercialQuoteSnapshotV3
    const emitted = emitCommercialQuoteV3(fixture, authoritiesFor(fixture))
    const base = {
      rowSchemaVersion: 3,
      snapshot: emitted.snapshot,
      checksum: emitted.checksum,
      rowContext: storedRowContext(fixture),
      authorities: authoritiesFor(fixture),
    }

    expect(() => decodeAndVerifyStoredCommercialQuoteV3({ ...base, rowSchemaVersion: 4 })).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_QUOTE_V3_INVALID', rule: 'SCHEMA_VERSION' }),
    )
    expect(() =>
      decodeAndVerifyStoredCommercialQuoteV3({
        ...base,
        rowContext: { ...base.rowContext, id: 'different-quote' },
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_QUOTE_V3_IDENTITY_MISMATCH', rule: 'ROW_CONTEXT' }))
    const tamperedRows: Array<typeof base.rowContext> = [
      { ...base.rowContext, catalogPublicationId: 'different-catalog' },
      { ...base.rowContext, offerVersionId: 'different-offer' },
      { ...base.rowContext, acquisitionContextId: 'different-acquisition' },
      { ...base.rowContext, organizationId: 'different-organization' },
      { ...base.rowContext, venueId: 'different-venue' },
      { ...base.rowContext, createdById: 'different-actor' },
      { ...base.rowContext, venueOrganizationId: 'different-venue-organization' },
      { ...base.rowContext, market: 'US' },
      { ...base.rowContext, currency: 'USD' },
      { ...base.rowContext, quotedAt: new Date('2026-08-15T12:00:01.000Z') },
      { ...base.rowContext, expiresAt: new Date('2026-08-15T12:15:01.000Z') },
      { ...base.rowContext, listSubtotalMinor: BigInt(base.rowContext.listSubtotalMinor) + 1n },
      { ...base.rowContext, discountMinor: BigInt(base.rowContext.discountMinor) + 1n },
      { ...base.rowContext, subtotalMinor: BigInt(base.rowContext.subtotalMinor) + 1n },
      { ...base.rowContext, taxMinor: BigInt(base.rowContext.taxMinor) + 1n },
      { ...base.rowContext, totalMinor: BigInt(base.rowContext.totalMinor) + 1n },
      { ...base.rowContext, totalMinor: Number(BigInt(base.rowContext.totalMinor)) },
      { ...base.rowContext, renewalSubtotalMinor: BigInt(base.rowContext.renewalSubtotalMinor) + 1n },
      { ...base.rowContext, renewalTaxMinor: BigInt(base.rowContext.renewalTaxMinor) + 1n },
      { ...base.rowContext, renewalTotalMinor: BigInt(base.rowContext.renewalTotalMinor) + 1n },
    ]
    for (const rowContext of tamperedRows) {
      expect(() => decodeAndVerifyStoredCommercialQuoteV3({ ...base, rowContext })).toThrow(
        expect.objectContaining({ code: 'COMMERCIAL_QUOTE_V3_IDENTITY_MISMATCH', rule: 'ROW_CONTEXT' }),
      )
    }
  })

  it('rejects a canonical snapshot larger than the independent 3 MiB hashing guard', () => {
    const value = clone(directFixture) as any
    value.saasLines[0].name = 'x'.repeat(COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES)
    expectInvalid(value, 'CANONICAL_SIZE')
  })

  it('rejects a schema-valid maximized structural vector above the canonical guard', () => {
    const value = clone(directFixture) as any
    const maxCode = `C${'X'.repeat(63)}`
    const maxLineKey = 'l'.repeat(128)
    const maxRateKey = `payments-rate-schedule-version-${'x'.repeat(90)}-v1`
    const origin = {
      kind: 'CAMPAIGN',
      sourceCode: maxCode,
      sourceId: 'i'.repeat(128),
      lineKey: maxLineKey,
    }
    value.saasLines = Array.from({ length: 50 }, () => {
      const line = clone(value.saasLines[0])
      line.name = 'n'.repeat(120)
      line.appliedOfferSteps = Array.from({ length: 10 }, (_, index) => ({
        ...clone(line.appliedOfferSteps[0]),
        benefitCode: maxCode,
        ruleCode: maxCode,
        position: index + 1,
      }))
      return line
    })
    value.hardwareLines = Array.from({ length: 50 }, () => clone(value.hardwareLines[0]))
    value.entitlementGrants = Array.from({ length: 128 }, () => ({
      capabilityCode: maxCode,
      capabilityKind: 'FEATURE',
      origins: Array.from({ length: 32 }, () => clone(origin)),
      activationRequirement: { mode: 'NOT_REQUIRED' },
    }))
    value.resolution.applied = Array.from({ length: 600 }, () => ({
      subjectKind: 'SAAS_LINE',
      subjectKey: 's'.repeat(128),
      benefitCode: maxCode,
      ruleCode: maxCode,
    }))
    value.resolution.exclusions = Array.from({ length: 5050 }, () => ({
      subjectKind: 'PAYMENTS_RATE',
      subjectKey: maxRateKey,
      benefitCode: maxCode,
      accountingEffect: 'EXPLANATORY',
      reasonCode: 'RATE_SCHEDULE_AUTHORITY_UNAVAILABLE',
    }))

    const ajv = new Ajv({ allErrors: true, jsonPointers: true })
    ajv.addSchema(quoteV2Schema as object)
    ajv.addSchema(resolutionSchema as object)
    expect(ajv.compile(quoteV3Schema as object)(value)).toBe(true)
    expect(canonicalJsonBytesV2(value).byteLength).toBeGreaterThan(COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES)
    expectInvalid(value, 'CANONICAL_SIZE')
  })

  it('documents but does not pretend to measure the later PostgreSQL JSONB guard', () => {
    expect(COMMERCIAL_QUOTE_V3_JSONB_TEXT_UPPER_BOUND_ESTIMATE_BYTES).toBe(4_194_304)
    expect(COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES).toBeGreaterThan(COMMERCIAL_JSON_TEXT_V2_MAX_BYTES)
    expect(canonicalJsonBytesV2(directFixture).byteLength).toBeLessThan(COMMERCIAL_QUOTE_V3_MAX_CANONICAL_BYTES)
  })

  it.each([
    ['unit amount', (value: any) => (value.saasLines[0].listUnitAmountMinor = (MAX_UNIT_AMOUNT_MINOR + 1n).toString())],
    ['line subtotal', (value: any) => (value.saasLines[0].listSubtotalMinor = (MAX_LINE_LIST_SUBTOTAL_MINOR + 1n).toString())],
    ['quote discount', (value: any) => (value.totals.dueNow.discountMinor = (MAX_QUOTE_DISCOUNT_MINOR + 1n).toString())],
    ['quote subtotal', (value: any) => (value.totals.dueNow.subtotalMinor = (MAX_QUOTE_LIST_SUBTOTAL_MINOR + 1n).toString())],
    ['quote tax', (value: any) => (value.totals.dueNow.taxMinor = (MAX_QUOTE_TAX_MINOR + 1n).toString())],
    ['quote total', (value: any) => (value.totals.dueNow.totalMinor = (MAX_QUOTE_TOTAL_MINOR + 1n).toString())],
    ['renewal subtotal', (value: any) => (value.renewal.subtotalMinor = (MAX_QUOTE_LIST_SUBTOTAL_MINOR + 1n).toString())],
    ['renewal tax', (value: any) => (value.renewal.taxMinor = (MAX_QUOTE_TAX_MINOR + 1n).toString())],
    ['renewal total', (value: any) => (value.renewal.totalMinor = (MAX_QUOTE_TOTAL_MINOR + 1n).toString())],
  ])('rejects one-unit overflow for %s', (_label, mutate: (value: any) => void) => {
    const value = clone(directFixture)
    mutate(value)
    expectInvalid(value, 'QUOTE_ARITHMETIC')
  })

  it.each([
    ['UNIT_AMOUNT', MAX_UNIT_AMOUNT_MINOR],
    ['LINE_LIST_SUBTOTAL', MAX_LINE_LIST_SUBTOTAL_MINOR],
    ['QUOTE_LIST_SUBTOTAL', MAX_QUOTE_LIST_SUBTOTAL_MINOR],
    ['QUOTE_DISCOUNT', MAX_QUOTE_DISCOUNT_MINOR],
    ['QUOTE_TAX', MAX_QUOTE_TAX_MINOR],
    ['QUOTE_TOTAL', MAX_QUOTE_TOTAL_MINOR],
    ['RENEWAL_SUBTOTAL', MAX_QUOTE_LIST_SUBTOTAL_MINOR],
    ['RENEWAL_TAX', MAX_QUOTE_TAX_MINOR],
    ['RENEWAL_TOTAL', MAX_QUOTE_TOTAL_MINOR],
  ] as const)('accepts the exact %s primitive boundary used by Quote v3', (kind, boundary) => {
    expect(assertCommercialMoneyLimitV2(kind, boundary)).toBe(boundary)
  })

  it('accepts a complete Quote v3 vector exactly at every hardware and aggregate maximum', () => {
    const offerSource: CommercialOfferSnapshotV3 = {
      schemaVersion: 3,
      contractVersion: '3.0.0',
      campaignVersionId: 'commercial-offer-version-boundary-v3',
      campaignCode: 'BOUNDARY_V3',
      version: 1,
      status: 'ACTIVE',
      publishedAt: '2026-08-01T06:00:00.000Z',
      claimStartsAt: '2026-08-01T06:00:00.000Z',
      claimEndsAt: '2026-09-01T06:00:00.000Z',
      benefits: Array.from({ length: 50 }, (_, index) => {
        const suffix = index.toString().padStart(2, '0')
        const catalogKey = `BOUNDARY_SKU_${suffix}`
        return {
          benefitCode: `BOUNDARY_BENEFIT_${suffix}`,
          kind: 'HARDWARE_PERCENT_OFF' as const,
          skuSnapshot: {
            catalogKey,
            catalogContentHash: createHash('sha256').update(catalogKey).digest('hex'),
            brand: 'Avoqado',
            model: suffix,
            name: `Boundary ${suffix}`,
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
    const boundaryOffer = verifiedOffer(offerSource)
    const lineTax = (MAX_LINE_LIST_SUBTOTAL_MINOR * 1600n) / 10_000n
    const lineTotal = MAX_LINE_LIST_SUBTOTAL_MINOR + lineTax
    const hardwareLines: CommercialQuoteSnapshotV3['hardwareLines'] = boundaryOffer.snapshot.benefits.map(benefit => {
      if (benefit.kind !== 'HARDWARE_PERCENT_OFF') throw new Error('Expected hardware benefit')
      return {
        lineKey: `HARDWARE_SKU:${benefit.skuSnapshot.catalogKey}`,
        catalogKey: benefit.skuSnapshot.catalogKey,
        skuSnapshot: benefit.skuSnapshot,
        quantity: 1000,
        benefitedQuantity: 0,
        listPriceQuantity: 1000,
        appliedBenefit: null,
        currency: 'MXN',
        taxRateBasisPoints: 1600,
        listSubtotalMinor: MAX_LINE_LIST_SUBTOTAL_MINOR.toString(),
        discountMinor: '0',
        subtotalMinor: MAX_LINE_LIST_SUBTOTAL_MINOR.toString(),
        taxMinor: lineTax.toString(),
        totalMinor: lineTotal.toString(),
      }
    })
    const oneTime = {
      listSubtotalMinor: MAX_QUOTE_LIST_SUBTOTAL_MINOR.toString(),
      discountMinor: '0',
      subtotalMinor: MAX_QUOTE_LIST_SUBTOTAL_MINOR.toString(),
      taxMinor: MAX_QUOTE_TAX_MINOR.toString(),
      totalMinor: MAX_QUOTE_TOTAL_MINOR.toString(),
    }
    const snapshot: CommercialQuoteSnapshotV3 = {
      schemaVersion: 3,
      contractVersion: '3.0.0',
      quoteId: 'quote-v3-exact-boundary',
      subject: { kind: 'VENUE', organizationId: 'organization-boundary', venueId: 'venue-boundary', actorId: 'staff-boundary' },
      acquisitionContextId: null,
      derivedFromPreview: null,
      catalogPublicationId: catalog.snapshot.publicationId,
      catalogChecksum: catalog.checksum,
      offerVersionId: boundaryOffer.snapshot.campaignVersionId,
      offerCode: boundaryOffer.snapshot.campaignCode,
      offerChecksum: boundaryOffer.checksum,
      market: 'MX',
      currency: 'MXN',
      quotedAt: '2026-08-15T12:00:00.000Z',
      expiresAt: '2026-08-15T12:15:00.000Z',
      saasLines: [],
      hardwareLines,
      entitlementGrants: [],
      resolution: resolveCommercialOfferV3({
        offer: boundaryOffer.snapshot,
        resolvedAt: '2026-08-15T12:00:00.000Z',
        saasMatches: [],
        hardwareSelections: hardwareLines.map(line => ({ catalogKey: line.catalogKey, quantity: line.quantity })),
        rateBlockers: [],
      }),
      totals: { recurringCurrent: zeroBreakdown(), oneTime, dueNow: oneTime },
      renewal: zeroBreakdown(),
    }

    const validated = validateCommercialQuoteV3(snapshot, { catalog, offer: boundaryOffer, acquisitionContext: null })
    expect(validated.hardwareLines).toHaveLength(50)
    expect(validated.hardwareLines[0].listSubtotalMinor).toBe(MAX_LINE_LIST_SUBTOTAL_MINOR.toString())
    expect(validated.totals.dueNow).toEqual(oneTime)
  })

  it('quotes the ALL_MODULES bundle and derives every BUNDLE_COMPONENT entitlement origin', () => {
    const source = clone(offerFixture) as CommercialOfferSnapshotV3
    source.benefits = source.benefits.filter(benefit => benefit.kind !== 'SAAS_PRICE')
    const neutralOffer = verifiedOffer(source)
    const evaluated = evaluateCommercialQuoteV2({
      catalog: catalog.snapshot,
      campaign: null,
      lines: [{ targetType: 'BUNDLE', targetCode: 'ALL_MODULES', priceCode: 'ALL_MODULES_MONTHLY', quantity: 1 }],
      now: new Date('2026-08-15T12:00:00.000Z'),
    })
    const snapshot = saasOnlyQuoteFromV2(evaluated, neutralOffer, 'quote-v3-bundle', [])

    const validated = validateCommercialQuoteV3(snapshot, { catalog, offer: neutralOffer, acquisitionContext: null })
    expect(validated.saasLines[0]).toMatchObject({
      targetType: 'BUNDLE',
      targetCode: 'ALL_MODULES',
      productKind: 'BUNDLE',
      listUnitAmountMinor: '199900',
    })
    expect(validated.entitlementGrants).toEqual(evaluated.entitlementGrants)
    expect(validated.entitlementGrants).toHaveLength(13)
    for (const grant of validated.entitlementGrants) {
      expect(grant.origins).toEqual([
        expect.objectContaining({
          kind: 'BUNDLE_COMPONENT',
          parentSourceCode: 'ALL_MODULES',
          lineKey: 'BUNDLE:ALL_MODULES:ALL_MODULES_MONTHLY',
        }),
      ])
    }
  })

  it('matches Quote v2 per-unit AMOUNT_OFF economics when SaaS quantity is greater than one', () => {
    const rule: CommercialCampaignRuleV2 = {
      code: 'POS_AMOUNT_25_MULTI',
      type: 'AMOUNT_OFF',
      priority: 100,
      target: { productCodes: ['POS'] },
      cycles: 3,
      amount: '25.00',
    }
    const campaign: CommercialCampaignSnapshotV2 = {
      schemaVersion: 2,
      contractVersion: '2.0.0',
      campaignVersionId: 'commercial-offer-version-quantity-v3',
      campaignCode: 'QUANTITY_V3',
      version: 1,
      status: 'ACTIVE',
      publishedAt: '2026-08-01T06:00:00.000Z',
      startsAt: '2026-08-01T06:00:00.000Z',
      endsAt: '2026-09-01T06:00:00.000Z',
      stackingGroups: [],
      rules: [rule],
    }
    const quantityOffer = verifiedOffer({
      schemaVersion: 3,
      contractVersion: '3.0.0',
      campaignVersionId: campaign.campaignVersionId,
      campaignCode: campaign.campaignCode,
      version: campaign.version,
      status: 'ACTIVE',
      publishedAt: campaign.publishedAt,
      claimStartsAt: campaign.startsAt,
      claimEndsAt: campaign.endsAt,
      benefits: [{ benefitCode: 'SAAS_QUANTITY', kind: 'SAAS_PRICE', stackingGroups: [], rules: [rule] }],
    })
    const evaluated = evaluateCommercialQuoteV2({
      catalog: catalog.snapshot,
      campaign,
      lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 3 }],
      now: new Date('2026-08-15T12:00:00.000Z'),
    })
    const snapshot = saasOnlyQuoteFromV2(evaluated, quantityOffer, 'quote-v3-quantity', [
      { lineKey: evaluated.lines[0].lineKey, ruleCodes: [rule.code] },
    ])

    const validated = validateCommercialQuoteV3(snapshot, { catalog, offer: quantityOffer, acquisitionContext: null })
    expect(validated.saasLines[0]).toMatchObject({
      quantity: 3,
      listSubtotalMinor: '74700',
      discountMinor: '7500',
      subtotalMinor: '67200',
      taxMinor: '10752',
      totalMinor: '77952',
    })
  })

  it('aggregates two undiscounted SaaS lines and rejects mixed promotional cycles', () => {
    const neutralSource = clone(offerFixture) as CommercialOfferSnapshotV3
    neutralSource.benefits = neutralSource.benefits.filter(benefit => benefit.kind !== 'SAAS_PRICE')
    const neutralOffer = verifiedOffer(neutralSource)
    const evaluated = evaluateCommercialQuoteV2({
      catalog: catalog.snapshot,
      campaign: null,
      lines: [
        { targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 },
        { targetType: 'PRODUCT', targetCode: 'CFDI_MODULE', priceCode: 'CFDI_MONTHLY', quantity: 1 },
      ],
      now: new Date('2026-08-15T12:00:00.000Z'),
    })
    const valid = saasOnlyQuoteFromV2(evaluated, neutralOffer, 'quote-v3-two-saas-lines', [])
    const validated = validateCommercialQuoteV3(valid, { catalog, offer: neutralOffer, acquisitionContext: null })
    expect(validated.saasLines).toHaveLength(2)
    expect(validated.totals.recurringCurrent).toEqual({
      listSubtotalMinor: minor(evaluated.totals.listSubtotal),
      discountMinor: minor(evaluated.totals.discount),
      subtotalMinor: minor(evaluated.totals.subtotal),
      taxMinor: minor(evaluated.totals.tax),
      totalMinor: minor(evaluated.totals.total),
    })

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
    const campaign: CommercialCampaignSnapshotV2 = {
      schemaVersion: 2,
      contractVersion: '2.0.0',
      campaignVersionId: 'commercial-offer-version-mixed-cycles-v3',
      campaignCode: 'MIXED_CYCLES_V3',
      version: 1,
      status: 'ACTIVE',
      publishedAt: '2026-08-01T06:00:00.000Z',
      startsAt: '2026-08-01T06:00:00.000Z',
      endsAt: '2026-09-01T06:00:00.000Z',
      stackingGroups: [],
      rules,
    }
    const mixedOffer = verifiedOffer({
      schemaVersion: 3,
      contractVersion: '3.0.0',
      campaignVersionId: campaign.campaignVersionId,
      campaignCode: campaign.campaignCode,
      version: campaign.version,
      status: 'ACTIVE',
      publishedAt: campaign.publishedAt,
      claimStartsAt: campaign.startsAt,
      claimEndsAt: campaign.endsAt,
      benefits: [{ benefitCode: 'SAAS_MIXED_CYCLES', kind: 'SAAS_PRICE', stackingGroups: [], rules }],
    })
    const evaluateOne = (targetCode: 'CFDI_MODULE' | 'POS', priceCode: 'CFDI_MONTHLY' | 'POS_MONTHLY') =>
      evaluateCommercialQuoteV2({
        catalog: catalog.snapshot,
        campaign,
        lines: [{ targetType: 'PRODUCT', targetCode, priceCode, quantity: 1 }],
        now: new Date('2026-08-15T12:00:00.000Z'),
      })
    const cfdi = evaluateOne('CFDI_MODULE', 'CFDI_MONTHLY')
    const pos = evaluateOne('POS', 'POS_MONTHLY')
    const mixed = saasOnlyQuoteFromV2(pos, mixedOffer, 'quote-v3-mixed-cycles', [
      { lineKey: pos.lines[0].lineKey, ruleCodes: ['POS_CYCLE_3'] },
    ])
    mixed.saasLines = [
      ...saasOnlyQuoteFromV2(cfdi, mixedOffer, 'quote-v3-cfdi-cycle', [{ lineKey: cfdi.lines[0].lineKey, ruleCodes: ['CFDI_CYCLE_6'] }])
        .saasLines,
      ...mixed.saasLines,
    ]
    mixed.resolution = resolveCommercialOfferV3({
      offer: mixedOffer.snapshot,
      resolvedAt: mixed.quotedAt,
      saasMatches: [
        { lineKey: cfdi.lines[0].lineKey, ruleCodes: ['CFDI_CYCLE_6'] },
        { lineKey: pos.lines[0].lineKey, ruleCodes: ['POS_CYCLE_3'] },
      ],
      hardwareSelections: [],
      rateBlockers: [],
    })
    expectInvalid(mixed, 'QUOTE_ARITHMETIC', { catalog, offer: mixedOffer, acquisitionContext: null })
  })

  it.each([
    ['FIXED_PRICE', { amount: '200.00' }],
    ['BUNDLE_PRICE', { amount: '200.00' }],
    ['PERCENT_OFF', { percentBasisPoints: 1000 }],
    ['AMOUNT_OFF', { amount: '25.00' }],
    ['FREE_PERIOD', {}],
  ] as const)('matches Quote v2 exact economics for %s', (type, value) => {
    const rule: CommercialCampaignRuleV2 = {
      code: `PARITY_${type}`,
      type,
      priority: 100,
      target: { productCodes: ['POS'] },
      cycles: 3,
      ...value,
    } as CommercialCampaignRuleV2
    const campaign: CommercialCampaignSnapshotV2 = {
      schemaVersion: 2,
      contractVersion: '2.0.0',
      campaignVersionId: `parity-campaign-${type.toLowerCase()}`,
      campaignCode: `PARITY_${type}`,
      version: 1,
      status: 'ACTIVE',
      publishedAt: '2026-08-01T06:00:00.000Z',
      startsAt: '2026-08-01T06:00:00.000Z',
      endsAt: '2026-09-01T06:00:00.000Z',
      stackingGroups: [],
      rules: [rule],
    }
    const evaluated = evaluateCommercialQuoteV2({
      catalog: catalog.snapshot,
      campaign,
      lines: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      now: new Date('2026-08-15T12:00:00.000Z'),
    })
    const offerSource: CommercialOfferSnapshotV3 = {
      schemaVersion: 3,
      contractVersion: '3.0.0',
      campaignVersionId: campaign.campaignVersionId,
      campaignCode: campaign.campaignCode,
      version: campaign.version,
      status: 'ACTIVE',
      publishedAt: campaign.publishedAt,
      claimStartsAt: campaign.startsAt,
      claimEndsAt: campaign.endsAt,
      benefits: [{ benefitCode: 'SAAS_PARITY', kind: 'SAAS_PRICE', stackingGroups: [], rules: [rule] }],
    }
    const parityOffer = verifiedOffer(offerSource)
    const v2Line = evaluated.lines[0]
    const zero = { listSubtotalMinor: '0', discountMinor: '0', subtotalMinor: '0', taxMinor: '0', totalMinor: '0' }
    const recurring = {
      listSubtotalMinor: minor(evaluated.totals.listSubtotal),
      discountMinor: minor(evaluated.totals.discount),
      subtotalMinor: minor(evaluated.totals.subtotal),
      taxMinor: minor(evaluated.totals.tax),
      totalMinor: minor(evaluated.totals.total),
    }
    const snapshot: CommercialQuoteSnapshotV3 = {
      schemaVersion: 3,
      contractVersion: '3.0.0',
      quoteId: `quote-parity-${type.toLowerCase()}`,
      subject: { kind: 'VENUE', organizationId: 'organization-parity', venueId: 'venue-parity', actorId: 'staff-parity' },
      acquisitionContextId: null,
      derivedFromPreview: null,
      catalogPublicationId: catalog.snapshot.publicationId,
      catalogChecksum: catalog.checksum,
      offerVersionId: parityOffer.snapshot.campaignVersionId,
      offerCode: parityOffer.snapshot.campaignCode,
      offerChecksum: parityOffer.checksum,
      market: 'MX',
      currency: 'MXN',
      quotedAt: '2026-08-15T12:00:00.000Z',
      expiresAt: '2026-08-15T12:15:00.000Z',
      saasLines: [
        {
          lineKey: v2Line.lineKey,
          targetType: v2Line.targetType,
          targetCode: v2Line.targetCode,
          priceCode: v2Line.priceCode,
          quantity: v2Line.quantity,
          productKind: v2Line.productKind,
          name: v2Line.name,
          billingUnit: v2Line.billingUnit,
          currency: 'MXN',
          taxRateBasisPoints: v2Line.taxRateBasisPoints,
          listUnitAmountMinor: minor(v2Line.unitAmount),
          listSubtotalMinor: minor(v2Line.listSubtotal),
          appliedOfferSteps: v2Line.appliedCampaigns.map(step => ({
            benefitCode: 'SAAS_PARITY',
            ruleCode: step.ruleCode,
            type: step.type,
            position: step.position,
            inputAmountMinor: minor(step.inputAmount),
            discountAmountMinor: minor(step.discountAmount),
            outputAmountMinor: minor(step.outputAmount),
            cycles: step.cycles,
          })),
          discountMinor: minor(v2Line.discount),
          subtotalMinor: minor(v2Line.subtotal),
          taxMinor: minor(v2Line.tax),
          totalMinor: minor(v2Line.total),
          promotionalCycles: v2Line.promotionalCycles,
          renewalSubtotalMinor: minor(v2Line.renewalSubtotal),
          renewalTaxMinor: minor(v2Line.renewalTax),
          renewalTotalMinor: minor(v2Line.renewalTotal),
        },
      ],
      hardwareLines: [],
      entitlementGrants: evaluated.entitlementGrants,
      resolution: resolveCommercialOfferV3({
        offer: parityOffer.snapshot,
        resolvedAt: '2026-08-15T12:00:00.000Z',
        saasMatches: [{ lineKey: v2Line.lineKey, ruleCodes: [rule.code] }],
        hardwareSelections: [],
        rateBlockers: [],
      }),
      totals: { recurringCurrent: recurring, oneTime: zero, dueNow: recurring },
      renewal: {
        listSubtotalMinor: minor(evaluated.renewal.subtotal),
        discountMinor: '0',
        subtotalMinor: minor(evaluated.renewal.subtotal),
        taxMinor: minor(evaluated.renewal.tax),
        totalMinor: minor(evaluated.renewal.total),
      },
    }
    const validated = validateCommercialQuoteV3(snapshot, { catalog, offer: parityOffer, acquisitionContext: null })
    const v3Line = validated.saasLines[0]
    expect(v3Line).toMatchObject({
      listUnitAmountMinor: minor(v2Line.unitAmount),
      listSubtotalMinor: minor(v2Line.listSubtotal),
      discountMinor: minor(v2Line.discount),
      subtotalMinor: minor(v2Line.subtotal),
      taxMinor: minor(v2Line.tax),
      totalMinor: minor(v2Line.total),
      promotionalCycles: v2Line.promotionalCycles,
      renewalSubtotalMinor: minor(v2Line.renewalSubtotal),
      renewalTaxMinor: minor(v2Line.renewalTax),
      renewalTotalMinor: minor(v2Line.renewalTotal),
    })
    expect(v3Line.appliedOfferSteps).toEqual(
      v2Line.appliedCampaigns.map(step => ({
        benefitCode: 'SAAS_PARITY',
        ruleCode: step.ruleCode,
        type: step.type,
        position: step.position,
        inputAmountMinor: minor(step.inputAmount),
        discountAmountMinor: minor(step.discountAmount),
        outputAmountMinor: minor(step.outputAmount),
        cycles: step.cycles,
      })),
    )
  })

  it('proves due-now is recurring plus hardware without re-rounding aggregate IVA', () => {
    const fixture = clone(directFixture) as CommercialQuoteSnapshotV3
    expect(fixture.totals.dueNow.taxMinor).toBe(sum(fixture.totals.recurringCurrent.taxMinor, fixture.totals.oneTime.taxMinor))
    expect(fixture.totals.dueNow.totalMinor).toBe(sum(fixture.totals.recurringCurrent.totalMinor, fixture.totals.oneTime.totalMinor))
  })
})
