import {
  assertCatalogImportReviewLinesMatchItemsV1,
  parseCatalogImportReviewLinesV1,
} from '@/services/master-catalog/catalogImportReviewLines.service'
import {
  parseCatalogImportStagedPayloadsV1,
  type CatalogImportLineRowV1,
} from '@/services/master-catalog/catalogImportStagedPayload.service'
import { expectCatalogImportEventLoopBudgetV1, startCatalogImportEventLoopProbeV1 } from './catalogImportEventLoopTestHarness'
import { durableJsonFixture, validStagedPayload } from './catalogImportTestHarness'

describe('catalog import durable confirm event-loop budget', () => {
  it('yields through maximum nested bindings, item parsing, and review cross-checks', async () => {
    const itemCount = 1_196
    const bindingCount = 20_000
    const base = validStagedPayload()
    const bindings = Array.from({ length: bindingCount }, () => ({
      corporateSku: 'SKU-00000',
      venueId: 'venue-1',
      requestedAction: 'SKIP' as const,
      productId: null,
      localSku: null,
      categoryId: null,
      initialPrice: null,
      currency: null,
    }))
    const itemLines: CatalogImportLineRowV1[] = []
    const reviewLines: CatalogImportLineRowV1[] = []
    for (let index = 0; index < itemCount; index += 1) {
      const sku = `SKU-${String(index).padStart(5, '0')}`
      itemLines.push({
        id: `item-${index}`,
        status: 'READY',
        sourceSheet: 'Items',
        sourceRow: index + 2,
        errors: null,
        catalogItemId: null,
        payload: durableJsonFixture({
          ...base,
          command: { operation: 'CREATE', input: { ...base.command.input, sku } },
          venueBindingRequests: index === 0 ? bindings : [],
        }),
      })
      for (let valueIndex = 0; valueIndex < base.command.input.organizationValues.length; valueIndex += 1) {
        const value = base.command.input.organizationValues[valueIndex]!
        reviewLines.push({
          id: `value-${index}-${valueIndex}`,
          status: 'READY',
          sourceSheet: 'OrganizationValues',
          sourceRow: 2 + index * 2 + valueIndex,
          errors: null,
          catalogItemId: null,
          payload: {
            schemaVersion: 1,
            section: 'ORGANIZATION_VALUES',
            corporateSku: sku,
            ...value,
            expectedRuleRevision: null,
          },
        })
      }
      reviewLines.push({
        id: `business-${index}`,
        status: 'READY',
        sourceSheet: 'BusinessTypes',
        sourceRow: index + 2,
        errors: null,
        catalogItemId: null,
        payload: {
          schemaVersion: 1,
          section: 'BUSINESS_TYPES',
          corporateSku: sku,
          businessType: base.command.input.businessTypes[0],
        },
      })
    }
    for (let index = 0; index < bindings.length; index += 1) {
      reviewLines.push({
        id: `binding-${index}`,
        status: 'READY',
        sourceSheet: 'VenueBindingRequests',
        sourceRow: index + 2,
        errors: null,
        catalogItemId: null,
        payload: { schemaVersion: 1, section: 'VENUE_BINDING_REQUESTS', ...bindings[index] },
      })
    }

    const probe = startCatalogImportEventLoopProbeV1()
    let samples: readonly number[] = []
    try {
      // WHY: This reproduces the maximum physical binding envelope alongside
      // 11,992 work units; confirm must remain cooperative before any writer.
      const payloads = await parseCatalogImportStagedPayloadsV1(itemLines)
      const reviews = await parseCatalogImportReviewLinesV1(reviewLines)
      await assertCatalogImportReviewLinesMatchItemsV1(payloads, reviews)
      await new Promise<void>(resolve => setImmediate(resolve))
    } finally {
      samples = probe.stop()
    }

    expectCatalogImportEventLoopBudgetV1(samples)
  }, 20_000)
})
