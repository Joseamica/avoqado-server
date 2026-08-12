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
