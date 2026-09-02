import { buildCommercialSnapshot } from '@/services/commercial/commercialSnapshot.service'
import { buildCommercialCatalogV2 } from '@/services/commercial/commercialCatalogV2Builder.service'
import { assertEmittedCommercialCatalogV2 } from '@/services/commercial/commercialArtifactCodecRegistry.service'
import { buildInitialCommercialDraftV1 } from '@/services/commercial/commercialInitialCatalog'
import type { CommercialDraftView } from '@/types/commercial'
import { buildValidCommercialDraft } from '../../../__helpers__/commercialDraft'

describe('buildCommercialSnapshot', () => {
  function expectContractDraftRejection(run: () => unknown): void {
    try {
      run()
      throw new Error('Expected commercial snapshot construction to fail')
    } catch (caught) {
      expect(caught).toMatchObject({
        code: 'COMMERCIAL_DRAFT_INVALID',
        details: { errors: expect.arrayContaining([expect.objectContaining({ code: 'COMMERCIAL_CONTRACT_INVALID' })]) },
      })
    }
  }

  it('orders equivalent drafts deterministically and produces the same checksum', () => {
    const draft = buildValidCommercialDraft()
    const reordered = buildValidCommercialDraft({
      products: [...draft.products].reverse(),
      prices: [...draft.prices].reverse(),
      featureBindings: [...draft.featureBindings].reverse(),
    })
    const context = { publicationId: 'pub_1', publishedAt: new Date('2026-08-21T12:00:00.000Z') }

    const first = buildCommercialSnapshot(draft, context)
    const second = buildCommercialSnapshot(reordered, context)

    expect(first).toEqual(second)
    expect(first.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('allowlists public fields and never leaks draft metadata or commercial internals', () => {
    const draft = buildValidCommercialDraft({ sourceKey: 'internal-seed', description: 'No costs here' }) as ReturnType<
      typeof buildValidCommercialDraft
    > & { payout?: number; commission?: number; cost?: number }
    draft.payout = 2000
    draft.commission = 0.2
    draft.cost = 500

    const result = buildCommercialSnapshot(draft, {
      publicationId: 'pub_1',
      publishedAt: new Date('2026-08-21T12:00:00.000Z'),
    })
    const serialized = JSON.stringify(result.snapshot)

    expect(serialized).not.toMatch(/sourceKey|payout|commission|cost|revision/i)
    expect(result.snapshot.products.find(product => product.code === 'POS')?.prices[0]?.amountMinor).toBe(24900)
  })

  it('rejects a normalized snapshot that violates the frozen public contract', () => {
    expectContractDraftRejection(() =>
      buildCommercialSnapshot(buildValidCommercialDraft({ products: [], prices: [], featureBindings: [] }), {
        publicationId: 'pub_empty',
        publishedAt: new Date('2026-08-21T12:00:00.000Z'),
      }),
    )

    const draft = buildValidCommercialDraft({
      bundles: [
        {
          code: 'EMPTY_BUNDLE',
          slug: 'paquete-vacio',
          name: 'Paquete vacío',
          description: 'No debe publicarse sin productos.',
          active: true,
          sortOrder: 1,
        },
      ],
      bundleItems: [],
      prices: [
        ...buildValidCommercialDraft().prices,
        {
          code: 'EMPTY_BUNDLE_MONTHLY',
          pricebookCode: 'MX_STANDARD',
          bundleCode: 'EMPTY_BUNDLE',
          billingUnit: 'VENUE_MONTH',
          amount: '1999.00',
          taxBehavior: 'EXCLUSIVE',
          active: true,
        },
      ],
    })
    expectContractDraftRejection(() =>
      buildCommercialSnapshot(draft, {
        publicationId: 'pub_bundle',
        publishedAt: new Date('2026-08-21T12:00:00.000Z'),
      }),
    )
  })
})

describe('buildCommercialCatalogV2', () => {
  it('materializes the complete initial catalog when capabilities repeat across products', () => {
    const initial = buildInitialCommercialDraftV1().draft
    const draft: CommercialDraftView = {
      id: 'initial-draft-v2-regression',
      revision: 1,
      status: 'ACTIVE',
      ...initial,
    }

    expect(() =>
      buildCommercialCatalogV2({
        draft,
        publicationId: 'initial-publication-v2-regression',
        publishedAt: new Date('2026-08-28T12:00:00.000Z'),
      }),
    ).not.toThrow()
  })

  it('emits a branded schema-v2 catalog with canonical pesos and complete capability bindings', () => {
    const draft = buildValidCommercialDraft({
      featureBindings: [
        ...buildValidCommercialDraft().featureBindings,
        { productCode: 'PRO', capabilityCode: 'CASH_RECONCILIATION', capabilityKind: 'FEATURE' },
      ],
    })
    const result = buildCommercialCatalogV2({
      draft,
      publicationId: 'pub_v2',
      publishedAt: new Date('2026-08-21T12:00:00.000Z'),
    })

    expect(() => assertEmittedCommercialCatalogV2(result)).not.toThrow()
    expect(result).toMatchObject({ kind: 'CATALOG', schemaVersion: 2, mode: 'READ_WRITE' })
    expect(result.snapshot).toMatchObject({
      schemaVersion: 2,
      contractVersion: '2.0.0',
      publicationId: 'pub_v2',
      publishedAt: '2026-08-21T12:00:00.000Z',
    })
    expect(result.snapshot.products.find(product => product.code === 'POS')?.prices[0]).toMatchObject({
      amount: '249.00',
    })
    expect(JSON.stringify(result.snapshot)).not.toMatch(/amountMinor|capabilityCodes|itemProductCodes/)
    expect(
      result.snapshot.products
        .find(product => product.code === 'PRO')
        ?.capabilityBindings.find(binding => {
          return binding.capabilityCode === 'CASH_RECONCILIATION'
        }),
    ).toEqual({
      capabilityCode: 'CASH_RECONCILIATION',
      capabilityKind: 'FEATURE',
      activationRequirement: {
        mode: 'VENUE_SETTING',
        settingKey: 'cashReconciliationEnabled',
        defaultState: 'OFF',
      },
    })
  })

  it('is deterministic across draft array order and canonicalizes one- and zero-decimal prices', () => {
    const draft = buildValidCommercialDraft()
    draft.prices.find(price => price.code === 'PRO_MONTHLY')!.amount = '999'
    draft.prices.find(price => price.code === 'POS_MONTHLY')!.amount = '249.0'
    const reordered = buildValidCommercialDraft({
      products: [...draft.products].reverse(),
      prices: [...draft.prices].reverse(),
      featureBindings: [...draft.featureBindings].reverse(),
    })
    const context = { publicationId: 'pub_v2', publishedAt: new Date('2026-08-21T12:00:00.000Z') }

    const first = buildCommercialCatalogV2({ draft, ...context })
    const second = buildCommercialCatalogV2({ draft: reordered, ...context })

    expect(first.snapshot).toEqual(second.snapshot)
    expect(first.checksum).toBe(second.checksum)
    expect(first.snapshot.products.find(product => product.code === 'PRO')?.prices[0]?.amount).toBe('999.00')
    expect(first.snapshot.products.find(product => product.code === 'POS')?.prices[0]?.amount).toBe('249.00')
  })

  it('rejects priced products without capabilities before emission', () => {
    const draft = buildValidCommercialDraft({ featureBindings: [] })

    expect(() =>
      buildCommercialCatalogV2({
        draft,
        publicationId: 'pub_v2',
        publishedAt: new Date('2026-08-21T12:00:00.000Z'),
      }),
    ).toThrow(expect.objectContaining({ code: 'COMMERCIAL_DRAFT_INVALID' }))
  })

  it('accepts the exact v2 catalog unit-money ceiling without passing through Number or the v1 int4 limit', () => {
    const draft = buildValidCommercialDraft()
    draft.prices.find(price => price.code === 'POS_MONTHLY')!.amount = '9999999999.99'

    const result = buildCommercialCatalogV2({
      draft,
      publicationId: 'pub_v2_limit',
      publishedAt: new Date('2026-08-21T12:00:00.000Z'),
    })

    expect(result.snapshot.products.find(product => product.code === 'POS')?.prices[0]?.amount).toBe('9999999999.99')
    expect(result.money.prices.find(price => price.priceCode === 'POS_MONTHLY')?.amountMinor).toBe(999_999_999_999n)
  })
})
