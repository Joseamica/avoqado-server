import { BusinessType, VenueOperationalRole } from '@prisma/client'
import { CATALOG_VALIDATION_BASELINE_V1, resolveCatalogRequiredFieldsV1 } from '@/services/master-catalog/catalogValidation.service'

describe('catalog validation baseline and additive profiles', () => {
  it('keeps every approved H1 field required even with no profiles', () => {
    expect(CATALOG_VALIDATION_BASELINE_V1).toEqual(
      expect.arrayContaining([
        'sku',
        'imageUrl',
        'name',
        'description',
        'brandId',
        'manufacturerId',
        'familyId',
        'subfamily',
        'presentationLabel',
        'unit',
        'kind',
        'productType',
        'organizationSalePrice',
        'organizationPurchaseCost',
        'currency',
        'taxRate',
        'ieps',
        'satProductKey',
        'satUnitKey',
        'objetoImp',
        'createdById',
        'createdAt',
        'updatedById',
        'updatedAt',
        'businessTypes',
      ]),
    )
  })

  it('unions global and matching scoped requirements without letting profiles relax baseline', () => {
    const required = resolveCatalogRequiredFieldsV1({
      businessTypes: [BusinessType.RESTAURANT],
      operationalRole: VenueOperationalRole.STORE,
      profiles: [
        {
          rulesSchemaVersion: 1,
          businessType: null,
          operationalRole: null,
          requiredFields: ['supplierCode'],
        },
        {
          rulesSchemaVersion: 1,
          businessType: BusinessType.RESTAURANT,
          operationalRole: VenueOperationalRole.STORE,
          requiredFields: ['shelfLifeDays'],
        },
        {
          rulesSchemaVersion: 1,
          businessType: BusinessType.RETAIL_STORE,
          operationalRole: null,
          requiredFields: ['retailOnly'],
        },
      ],
    })

    expect(required).toEqual(expect.arrayContaining([...CATALOG_VALIDATION_BASELINE_V1, 'supplierCode', 'shelfLifeDays']))
    expect(required).not.toContain('retailOnly')
  })

  it('fails closed on an unknown persisted rules schema', () => {
    expect(() =>
      resolveCatalogRequiredFieldsV1({
        businessTypes: [],
        operationalRole: null,
        profiles: [{ rulesSchemaVersion: 2, businessType: null, operationalRole: null, requiredFields: [] }],
      }),
    ).toThrow('CATALOG_VALIDATION_RULES_SCHEMA_UNSUPPORTED')
  })
})
