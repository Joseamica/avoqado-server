import {
  catalogCommandBodySchemas,
  catalogCommandRequestSchemas,
  catalogActivityLogQuerySchema,
  catalogItemListQuerySchema,
  catalogPublicationListQuerySchema,
  catalogReferenceListQuerySchema,
  catalogVenueChangesQuerySchema,
} from '@/schemas/dashboard/masterCatalog.schema'

describe('master catalog HTTP query boundary', () => {
  it('coerces bounded numeric query strings for item and venue lists', () => {
    expect(catalogItemListQuerySchema.parse({ pageSize: '2' })).toEqual({ pageSize: 2 })
    expect(catalogVenueChangesQuerySchema.parse({ pageSize: '2' })).toEqual({ pageSize: 2 })
    expect(catalogReferenceListQuerySchema.parse({ pageSize: '2' })).toEqual({ pageSize: 2 })
  })

  it('rejects unbounded audit pages and closed-enum violations', () => {
    expect(catalogActivityLogQuerySchema.safeParse({ pageSize: '1000000' }).success).toBe(false)
    expect(catalogPublicationListQuerySchema.safeParse({ state: 'BOGUS' }).success).toBe(false)
    expect(catalogReferenceListQuerySchema.safeParse({ organizationId: 'org-foreign' }).success).toBe(false)
  })

  it('keeps every accepted command route behind an explicit composed schema', () => {
    expect(Object.keys(catalogCommandBodySchemas).sort()).toEqual(
      [
        'createItem',
        'updateItem',
        'retireItem',
        'previewValidationProfile',
        'confirmValidationProfile',
        'createBrand',
        'updateBrand',
        'retireBrand',
        'createManufacturer',
        'updateManufacturer',
        'retireManufacturer',
        'createFamily',
        'updateFamily',
        'retireFamily',
        'confirmImport',
        'previewBindings',
        'confirmBindings',
        'previewPublication',
        'confirmPublication',
        'previewPublicationReversal',
        'previewVenueOverride',
        'confirmVenueOverride',
      ].sort(),
    )
    expect(Object.keys(catalogCommandRequestSchemas).sort()).toEqual(['confirmImport', 'previewImport'])
  })
})

describe('D15 · alta y edición de artículos sin IVA', () => {
  const base = {
    sku: 'SKU-1',
    kind: 'RETAIL_PRODUCT',
    name: 'Jarabe',
    description: 'Botella',
    imageUrl: 'https://example.test/jarabe.png',
    brandId: 'brand-1',
    manufacturerId: 'maker-1',
    familyId: 'family-1',
    presentationLabel: '1 L',
    unit: 'LITER',
    satProductKey: '50192100',
    satUnitKey: 'H87',
    productType: 'REGULAR',
    iepsMode: 'NONE',
    iepsRate: null,
    iepsQuota: null,
    iepsQuotaUnit: null,
    businessTypes: ['RESTAURANT'],
    organizationValues: [
      { kind: 'SALE_PRICE', amount: '10.00', currency: 'MXN' },
      { kind: 'PURCHASE_COST', amount: '5.00', currency: 'MXN' },
    ],
  }

  it('un cliente nuevo puede omitir taxRate y objetoImp', () => {
    expect(catalogCommandBodySchemas.createItem.safeParse(base).success).toBe(true)
    expect(
      catalogCommandBodySchemas.updateItem.safeParse({ ...base, expectedRevision: 1, organizationValueDeactivations: [] }).success,
    ).toBe(true)
  })

  it('un cliente viejo que los manda sigue siendo válido', () => {
    expect(catalogCommandBodySchemas.createItem.safeParse({ ...base, taxRate: '0.1600', objetoImp: '02' }).success).toBe(true)
  })

  it('la forma se sigue revisando cuando vienen', () => {
    expect(catalogCommandBodySchemas.createItem.safeParse({ ...base, taxRate: 0.16 }).success).toBe(false)
    expect(catalogCommandBodySchemas.createItem.safeParse({ ...base, objetoImp: '' }).success).toBe(false)
  })
})
