import anonymousFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-anonymous-preview.json'
import bridgedFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-bridged.json'
import directFixture from '@/contracts/commercial/fixtures/v3/commercial-quote-v3-direct.json'
import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { decodeAndVerifyStoredCommercialOfferV3, emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import { buildCommercialQuoteV3, type BuildCommercialQuoteV3Input } from '@/services/commercial/quotes-v3/commercialQuoteV3Builder.service'
import {
  evaluateCommercialQuoteV3,
  type CommercialQuoteEvaluationV3,
} from '@/services/commercial/quotes-v3/commercialQuoteV3Engine.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'
import type { CommercialQuoteSnapshotV3, CommercialQuoteV3Authorities } from '@/types/commercialQuoteV3'

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

function directEvaluation(): CommercialQuoteEvaluationV3 {
  return evaluateCommercialQuoteV3({
    authorities: { catalog, offer },
    saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
    hardwareSelections: [{ catalogKey: 'NEXGO_N62', quantity: 5 }],
    rateBlockers: [],
    resolvedAt: new Date(directFixture.resolution.resolvedAt),
  })
}

function directBuildInput(evaluation: CommercialQuoteEvaluationV3 = directEvaluation()): BuildCommercialQuoteV3Input {
  return {
    quoteId: directFixture.quoteId,
    subject: directFixture.subject as CommercialQuoteSnapshotV3['subject'],
    acquisitionContextId: directFixture.acquisitionContextId,
    derivedFromPreview: directFixture.derivedFromPreview,
    quotedAt: new Date(directFixture.quotedAt),
    expiresAt: new Date(directFixture.expiresAt),
    evaluation,
    authorities: { catalog, offer, acquisitionContext: null },
  }
}

describe('Commercial Quote v3 builder', () => {
  it.each([
    ['direct', directFixture],
    ['anonymous', anonymousFixture],
    ['bridged', bridgedFixture],
  ])('builds and emits the %s golden fixture from one deterministic evaluation', (_label, fixtureSource) => {
    const fixture = clone(fixtureSource) as CommercialQuoteSnapshotV3
    const acquisitionContext =
      fixture.acquisitionContextId === null
        ? null
        : { id: fixture.acquisitionContextId, createdAt: new Date(fixture.resolution.resolvedAt) }
    const evaluation = evaluateCommercialQuoteV3({
      authorities: { catalog, offer },
      saasSelections: fixture.saasLines.map(line => ({
        targetType: line.targetType,
        targetCode: line.targetCode,
        priceCode: line.priceCode,
        quantity: line.quantity,
      })),
      hardwareSelections: fixture.hardwareLines.map(line => ({ catalogKey: line.catalogKey, quantity: line.quantity })),
      rateBlockers: [],
      resolvedAt: new Date(fixture.resolution.resolvedAt),
    })
    const emitted = buildCommercialQuoteV3({
      quoteId: fixture.quoteId,
      subject: fixture.subject,
      acquisitionContextId: fixture.acquisitionContextId,
      derivedFromPreview: fixture.derivedFromPreview,
      quotedAt: new Date(fixture.quotedAt),
      expiresAt: new Date(fixture.expiresAt),
      evaluation,
      authorities: { catalog, offer, acquisitionContext },
    })

    expect(emitted.snapshot).toEqual(fixture)
    expect(emitted.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic and rejects post-evaluation arithmetic or provenance tampering', () => {
    const first = buildCommercialQuoteV3(directBuildInput())
    const second = buildCommercialQuoteV3(directBuildInput())
    expect(second).toEqual(first)

    const arithmetic = clone(directEvaluation())
    arithmetic.totals.dueNow.totalMinor = '1'
    expect(() => buildCommercialQuoteV3(directBuildInput(arithmetic))).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_QUOTE_V3_INVALID', rule: 'QUOTE_ARITHMETIC' }),
    )

    const provenance = clone(directEvaluation())
    provenance.catalogChecksum = '0'.repeat(64)
    expect(() => buildCommercialQuoteV3(directBuildInput(provenance))).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_QUOTE_V3_INVALID', rule: 'CATALOG_AUTHORITY' }),
    )
  })

  it('rejects invalid or non-forward quote windows before emission', () => {
    expect(() => buildCommercialQuoteV3({ ...directBuildInput(), quotedAt: new Date(Number.NaN) })).toThrow(
      expect.objectContaining({ code: 'COMMERCIAL_QUOTE_V3_QUOTED_AT_INVALID' }),
    )
    expect(() =>
      buildCommercialQuoteV3({
        ...directBuildInput(),
        expiresAt: new Date(directFixture.quotedAt),
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_QUOTE_V3_WINDOW_INVALID' }))
    expect(() =>
      buildCommercialQuoteV3({
        ...directBuildInput(),
        expiresAt: new Date('2026-08-15T12:16:00.000Z'),
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_QUOTE_V3_WINDOW_INVALID' }))
  })

  it('seals the strongest explanatory payments-rate blocker through contract reconstruction', () => {
    const evaluation = evaluateCommercialQuoteV3({
      authorities: { catalog, offer },
      saasSelections: [{ targetType: 'PRODUCT', targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }],
      hardwareSelections: [],
      rateBlockers: ['ENTERPRISE_RATE', 'NEGOTIATED_RATE'],
      resolvedAt: new Date(directFixture.resolution.resolvedAt),
    })
    const emitted = buildCommercialQuoteV3(directBuildInput(evaluation))

    expect(emitted.snapshot.resolution.exclusions).toContainEqual(
      expect.objectContaining({ subjectKind: 'PAYMENTS_RATE', reasonCode: 'NEGOTIATED_RATE_PRESENT' }),
    )
  })
})
