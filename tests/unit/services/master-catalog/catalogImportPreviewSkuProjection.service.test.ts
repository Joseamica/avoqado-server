import {
  projectCatalogImportPreviewItemDetailV1,
  projectCatalogImportPreviewRowV1,
} from '@/services/master-catalog/catalogImportPreviewProjection.service'

function itemRow(proofCorporateSku: string) {
  return {
    sourceSheet: 'Items',
    sourceRow: 2,
    ordinal: 0,
    durableShapeValid: true,
    status: 'READY',
    operation: 'CREATE',
    catalogItemId: null,
    proofCorporateSku,
    name: 'Producto',
    itemKind: 'RETAIL_PRODUCT',
    organizationValueCount: 0,
    businessTypeCount: 0,
    referenceProposalCount: 0,
    venueBindingRequestCount: 0,
    errorCount: 0,
  }
}

function itemDetail(proofCorporateSku: string) {
  return {
    ...itemRow(proofCorporateSku),
    description: 'Descripción',
    imageUrl: 'https://cdn.example.test/item.png',
    brandId: 'brand-1',
    manufacturerId: 'manufacturer-1',
    familyId: 'family-1',
    presentationLabel: 'Pieza',
    unit: 'UNIT',
    productType: 'REGULAR',
    taxRate: '0.1600',
    satProductKey: '50161509',
    satUnitKey: 'H87',
    objetoImp: '02',
    iepsMode: 'NONE',
    iepsRate: null,
    iepsQuota: null,
    iepsQuotaUnit: null,
  }
}

describe('catalogImport preview corporate SKU proof projection', () => {
  it('validates a padded raw Item SKU before returning a meaningful bounded list excerpt', () => {
    const rawSku = `${' '.repeat(2_047)}A${' '.repeat(2_048)}`
    const result = projectCatalogImportPreviewRowV1('ITEMS', itemRow(rawSku))

    expect(result.corporateSku).toBe('A')
    expect(result.truncatedFields).toContain('corporateSku')
    expect(result).not.toHaveProperty('proofCorporateSku')
  })

  it('uses the same full raw proof for Item detail instead of validating its excerpt', () => {
    const rawSku = `${' '.repeat(2_047)}A${' '.repeat(2_048)}`
    const result = projectCatalogImportPreviewItemDetailV1(itemDetail(rawSku))

    expect(result.corporateSku).toBe('A')
    expect(result.truncatedFields).toContain('corporateSku')
    expect(result).not.toHaveProperty('proofCorporateSku')
  })

  it('keeps a deactivation tied to the meaningful excerpt of its raw Item SKU', () => {
    const result = projectCatalogImportPreviewRowV1('ORGANIZATION_VALUES', {
      sourceSheet: 'Items',
      sourceRow: 9,
      ordinal: 2,
      durableShapeValid: true,
      status: 'READY',
      action: 'DEACTIVATE',
      proofCorporateSku: `${' '.repeat(2_047)}A${' '.repeat(2_048)}`,
      kind: 'SALE_PRICE',
      currency: 'MXN',
      amount: null,
      expectedRuleRevision: 7,
    })

    expect(result.corporateSku).toBe('A')
    expect(result.truncatedFields).toContain('corporateSku')
  })

  it('accepts 4096 raw Unicode scalars when the normalized SKU is exactly 1024 bytes', () => {
    const rawSku = `${'\u3000'.repeat(3_840)}${'😀'.repeat(256)}`
    const list = projectCatalogImportPreviewRowV1('ITEMS', itemRow(rawSku))
    const detail = projectCatalogImportPreviewItemDetailV1(itemDetail(rawSku))

    expect(Array.from(rawSku)).toHaveLength(4_096)
    expect((list.corporateSku as string).trim()).toContain('😀')
    expect((detail.corporateSku as string).trim()).toContain('😀')
  })

  it.each([
    ['4097 raw scalars', `A${' '.repeat(4_095)}B`],
    ['257 normalized scalars', 'S'.repeat(257)],
  ])('rejects a raw Item SKU beyond %s', (_label, proofCorporateSku) => {
    expect(() => projectCatalogImportPreviewRowV1('ITEMS', itemRow(proofCorporateSku))).toThrow(
      expect.objectContaining({ code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID' }),
    )
  })

  it.each([
    [
      'OrganizationValues',
      'ORGANIZATION_VALUES' as const,
      {
        sourceSheet: 'OrganizationValues',
        action: 'UPSERT',
        kind: 'SALE_PRICE',
        currency: 'MXN',
        amount: '10.00',
        expectedRuleRevision: null,
      },
    ],
    ['BusinessTypes', 'BUSINESS_TYPES' as const, { sourceSheet: 'BusinessTypes', businessType: 'RETAIL_STORE' }],
    [
      'VenueBindingRequests',
      'VENUE_BINDING_REQUESTS' as const,
      {
        sourceSheet: 'VenueBindingRequests',
        venueId: 'venue-1',
        requestedAction: 'SKIP',
        productId: null,
        proofLocalSku: null,
        categoryId: null,
        initialPrice: null,
        currency: null,
      },
    ],
  ])('rejects a noncanonical corporate SKU in %s review staging', (_label, section, extra) => {
    expect(() =>
      projectCatalogImportPreviewRowV1(section, {
        sourceRow: 10,
        ordinal: 0,
        durableShapeValid: true,
        status: 'READY',
        proofCorporateSku: 'sku-lowercase',
        ...extra,
      }),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID' }))
  })

  it.each(['local-lowercase', ' LOCAL-PADDED ', 'L'.repeat(257)])(
    'rejects a noncanonical or oversized binding local SKU proof: %s',
    proofLocalSku => {
      expect(() =>
        projectCatalogImportPreviewRowV1('VENUE_BINDING_REQUESTS', {
          sourceSheet: 'VenueBindingRequests',
          sourceRow: 12,
          ordinal: 0,
          durableShapeValid: true,
          status: 'READY',
          proofCorporateSku: 'SKU-12',
          venueId: 'venue-1',
          requestedAction: 'CREATE',
          productId: null,
          proofLocalSku,
          categoryId: 'category-1',
          initialPrice: '10.00',
          currency: 'MXN',
        }),
      ).toThrow(expect.objectContaining({ code: 'CATALOG_IMPORT_PREVIEW_DATA_INVALID' }))
    },
  )
})
