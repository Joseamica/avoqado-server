import catalogFixture from '@/contracts/commercial/fixtures/v2/catalog-base.json'
import offerFixture from '@/contracts/commercial/fixtures/v3/commercial-offer-v3.json'
import { emitCommercialArtifactV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import {
  previewCommercialConfigurator,
  type CommercialConfiguratorPreviewInput,
} from '@/services/commercial/configurator/commercialConfiguratorPreview.service'
import { emitCommercialOfferV3 } from '@/services/commercial/offers/commercialOfferV3.service'
import type { CommercialCatalogSnapshotV2 } from '@/types/commercialV2'
import type { CommercialOfferSnapshotV3 } from '@/types/commercialOfferV3'
import type { CommercialQuoteV3OfferAuthority } from '@/types/commercialQuoteV3'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function offerAuthority(source = clone(offerFixture) as CommercialOfferSnapshotV3): CommercialQuoteV3OfferAuthority {
  const emitted = emitCommercialOfferV3(source)
  return {
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
}

function catalogAuthority(source = clone(catalogFixture) as CommercialCatalogSnapshotV2) {
  return emitCommercialArtifactV2({ kind: 'CATALOG', schemaVersion: 2, domainValue: source })
}

function catalogMissingSelectedCapability(): CommercialCatalogSnapshotV2 {
  const source = clone(catalogFixture) as CommercialCatalogSnapshotV2
  for (const productCode of ['PREMIUM', 'ENTERPRISE']) {
    const product = source.products.find(candidate => candidate.code === productCode)!
    product.capabilityBindings = product.capabilityBindings.filter(binding => binding.capabilityCode !== 'KITCHEN_DISPLAY')
  }
  return source
}

const allModuleCodes = (catalogFixture as CommercialCatalogSnapshotV2).products
  .filter(product => product.kind === 'MODULE')
  .map(product => product.code)

function preview(overrides: Partial<CommercialConfiguratorPreviewInput> = {}) {
  return previewCommercialConfigurator({
    catalogAuthority: catalogAuthority(),
    offerAuthority: null,
    selection: { mode: 'CUSTOM', billingUnit: 'VENUE_MONTH', moduleCodes: allModuleCodes },
    resolvedAt: new Date('2026-08-15T12:00:00.000Z'),
    ...overrides,
  })
}

describe('Commercial configurator preview', () => {
  it('keeps package and custom selections mutually exclusive and validates published choices', () => {
    expect(() =>
      preview({
        selection: {
          mode: 'CUSTOM',
          billingUnit: 'VENUE_MONTH',
          moduleCodes: ['CFDI_MODULE', 'CFDI_MODULE'],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_CONFIGURATOR_SELECTION_INVALID' }))

    expect(() =>
      preview({ selection: { mode: 'CUSTOM', billingUnit: 'VENUE_YEAR', moduleCodes: [] } as never }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_CONFIGURATOR_SELECTION_INVALID' }))

    expect(() =>
      preview({ selection: { mode: 'PACKAGE', billingUnit: 'VENUE_MONTH', packageCode: 'POS' } }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_CONFIGURATOR_SELECTION_INVALID' }))

    expect(() =>
      preview({
        selection: {
          mode: 'CUSTOM',
          billingUnit: 'VENUE_MONTH',
          moduleCodes: ['NOT_PUBLISHED'],
          packageCode: 'PREMIUM',
        } as never,
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_CONFIGURATOR_SELECTION_INVALID' }))
  })

  it('quotes POS plus modules and recommends only a cheaper entitlement-equivalent package', () => {
    const result = preview()

    expect(result.selection).toEqual({ mode: 'CUSTOM', billingUnit: 'VENUE_MONTH', moduleCodes: [...allModuleCodes].sort() })
    expect(result.quote.today).toEqual({
      listSubtotalMinor: '213000',
      discountMinor: '0',
      subtotalMinor: '213000',
      taxMinor: '34080',
      totalMinor: '247080',
    })
    expect(result.quote.renewal.totalMinor).toBe('247080')
    expect(result.recommendation).toMatchObject({
      reason: 'CHEAPER_TODAY_AND_RENEWAL',
      selection: { mode: 'PACKAGE', packageCode: 'PREMIUM', billingUnit: 'VENUE_MONTH' },
      savingsTodayMinor: '49996',
      savingsRenewalMinor: '49996',
      quote: { today: { totalMinor: '197084' }, renewal: { totalMinor: '197084' } },
    })
  })

  it('applies the claimed Server offer and communicates its cycles and list-price renewal', () => {
    const result = preview({ offerAuthority: offerAuthority() })
    const pos = result.quote.lines.find(line => line.targetCode === 'POS')

    expect(result.offer).toEqual({
      offerVersionId: 'commercial-offer-version-summer-2026-v3',
      offerCode: 'SUMMER_2026',
    })
    expect(pos).toMatchObject({
      listSubtotalMinor: '24900',
      discountMinor: '19900',
      subtotalMinor: '5000',
      totalMinor: '5800',
      promotionalCycles: 3,
      renewalTotalMinor: '28884',
      appliedDiscounts: [{ type: 'FIXED_PRICE', cycles: 3, discountMinor: '19900' }],
    })
    expect(result.quote.today.totalMinor).toBe('223996')
    expect(result.quote.renewal.totalMinor).toBe('247080')
    expect(result.recommendation).toMatchObject({
      reason: 'CHEAPER_TODAY_AND_RENEWAL',
      savingsTodayMinor: '26912',
      savingsRenewalMinor: '49996',
    })
  })

  it('never calls a cheaper package equivalent when it omits a selected capability', () => {
    const result = preview({ catalogAuthority: catalogAuthority(catalogMissingSelectedCapability()) })

    expect(result.recommendation).toBeNull()
  })

  it('distinguishes renewal savings from an offer that keeps custom cheaper today', () => {
    const source = clone(offerFixture) as CommercialOfferSnapshotV3
    const saas = source.benefits.find(benefit => benefit.kind === 'SAAS_PRICE')!
    if (saas.kind !== 'SAAS_PRICE') throw new Error('Expected SAAS_PRICE')
    saas.rules = [
      {
        code: 'ALL_CUSTOM_HALF_OFF',
        type: 'PERCENT_OFF',
        priority: 100,
        target: { productKinds: ['POS', 'MODULE'] },
        cycles: 1,
        percentBasisPoints: 5000,
      },
    ]

    const result = preview({ offerAuthority: offerAuthority(source) })

    expect(BigInt(result.quote.today.totalMinor)).toBeLessThan(BigInt(result.recommendation!.quote.today.totalMinor))
    expect(result.recommendation).toMatchObject({
      reason: 'LOWER_RENEWAL',
      savingsTodayMinor: '0',
      savingsRenewalMinor: '49996',
    })
  })

  it('does not describe an equal promotional total as cheaper today', () => {
    const source = clone(offerFixture) as CommercialOfferSnapshotV3
    const saas = source.benefits.find(benefit => benefit.kind === 'SAAS_PRICE')!
    if (saas.kind !== 'SAAS_PRICE') throw new Error('Expected SAAS_PRICE')
    saas.rules = [
      {
        code: 'KITCHEN_DISPLAY_17',
        type: 'FIXED_PRICE',
        priority: 100,
        target: { productCodes: ['KITCHEN_DISPLAY_MODULE'] },
        cycles: 1,
        amount: '17.00',
      },
      {
        code: 'TABLE_SERVICE_FREE',
        type: 'FIXED_PRICE',
        priority: 100,
        target: { productCodes: ['TABLE_SERVICE_MODULE'] },
        cycles: 1,
        amount: '0.00',
      },
    ]

    const result = preview({ offerAuthority: offerAuthority(source) })

    expect(result.quote.today.totalMinor).toBe(result.recommendation!.quote.today.totalMinor)
    expect(result.recommendation).toMatchObject({
      reason: 'LOWER_RENEWAL',
      savingsTodayMinor: '0',
      savingsRenewalMinor: '49996',
    })
  })
})
