import { projectCatalogImportPreviewRowV1 } from '@/services/master-catalog/catalogImportPreviewProjection.service'

describe('catalogImportPreviewProjection.service semantic validation', () => {
  it.each([
    [
      'item operation',
      'ITEMS' as const,
      {
        sourceSheet: 'Items',
        sourceRow: 2,
        ordinal: 0,
        durableShapeValid: true,
        status: 'READY',
        operation: 'UPSERT',
        catalogItemId: null,
        proofCorporateSku: 'SKU-2',
        name: 'Producto',
        itemKind: 'RETAIL_PRODUCT',
        organizationValueCount: 0,
        businessTypeCount: 0,
        referenceProposalCount: 0,
        venueBindingRequestCount: 0,
        errorCount: 0,
      },
    ],
    [
      'organization-value kind',
      'ORGANIZATION_VALUES' as const,
      {
        sourceSheet: 'OrganizationValues',
        sourceRow: 8,
        ordinal: 0,
        durableShapeValid: true,
        status: 'READY',
        action: 'UPSERT',
        proofCorporateSku: 'SKU-8',
        kind: 'WAT',
        currency: 'MXN',
        amount: '10.00',
        expectedRuleRevision: null,
      },
    ],
    [
      'organization-value currency',
      'ORGANIZATION_VALUES' as const,
      {
        sourceSheet: 'OrganizationValues',
        sourceRow: 8,
        ordinal: 0,
        durableShapeValid: true,
        status: 'READY',
        action: 'UPSERT',
        proofCorporateSku: 'SKU-8',
        kind: 'SALE_PRICE',
        currency: 'wat',
        amount: '10.00',
        expectedRuleRevision: null,
      },
    ],
    [
      'organization-value money',
      'ORGANIZATION_VALUES' as const,
      {
        sourceSheet: 'OrganizationValues',
        sourceRow: 8,
        ordinal: 0,
        durableShapeValid: true,
        status: 'READY',
        action: 'UPSERT',
        proofCorporateSku: 'SKU-8',
        kind: 'SALE_PRICE',
        currency: 'MXN',
        amount: 'NaN',
        expectedRuleRevision: null,
      },
    ],
    [
      'business type',
      'BUSINESS_TYPES' as const,
      {
        sourceSheet: 'BusinessTypes',
        sourceRow: 10,
        ordinal: 0,
        durableShapeValid: true,
        status: 'READY',
        proofCorporateSku: 'SKU-10',
        businessType: 'WAT',
      },
    ],
    [
      'reference capacity marker',
      'REFERENCE_PROPOSALS' as const,
      {
        sourceSheet: 'Items',
        sourceRow: 11,
        ordinal: 1,
        durableShapeValid: true,
        status: 'READY',
        operation: 'CREATE',
        referenceType: 'BRAND',
        proofName: 'Café',
        proofParentId: null,
        proofParentName: null,
        proofMarkerBaseHash: '0'.repeat(64),
        proofParentBindingValid: true,
      },
    ],
    [
      'impossible binding action shape',
      'VENUE_BINDING_REQUESTS' as const,
      {
        sourceSheet: 'VenueBindingRequests',
        sourceRow: 12,
        ordinal: 0,
        durableShapeValid: true,
        status: 'READY',
        proofCorporateSku: 'SKU-12',
        venueId: 'venue-1',
        requestedAction: 'LINK',
        productId: null,
        proofLocalSku: 'LOCAL',
        categoryId: 'category-1',
        initialPrice: '10.00',
        currency: 'MXN',
      },
    ],
  ])('fails closed on semantically invalid projected %s', (_label, section, row) => {
    // WHY: Exact JSON keys are insufficient authority; every visible leaf is
    // checked against the same closed enum/money/action semantics as confirm.
    expect(() => projectCatalogImportPreviewRowV1(section, row)).toThrow(
      expect.objectContaining({ code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID' }),
    )
  })

  it('rejects an oversized marker proof without exposing or reflecting it', () => {
    const hostile = 'f'.repeat(100_000)
    expect(() =>
      projectCatalogImportPreviewRowV1('REFERENCE_PROPOSALS', {
        sourceSheet: 'Items',
        sourceRow: 14,
        ordinal: 1,
        durableShapeValid: true,
        status: 'READY',
        operation: 'CREATE',
        referenceType: 'BRAND',
        proofName: 'Marca',
        proofParentId: null,
        proofParentName: null,
        proofMarkerBaseHash: hostile,
        proofParentBindingValid: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID' }))
  })
})
