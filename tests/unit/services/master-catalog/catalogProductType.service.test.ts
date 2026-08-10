import { CatalogItemKind, ProductType } from '@prisma/client'
import { validateCatalogProductTypeV1 } from '../../../../src/services/master-catalog/catalogProductType.service'

// This exhaustive enum matrix catches newly-added or legacy ProductType values
// accidentally becoming vendible H1 catalog types without a reviewed mapping.
describe('catalogProductType.service', () => {
  it.each([
    [CatalogItemKind.PREPARED_DISH, ProductType.FOOD_AND_BEV],
    [CatalogItemKind.RETAIL_PRODUCT, ProductType.REGULAR],
    [CatalogItemKind.RETAIL_PRODUCT, ProductType.FOOD_AND_BEV],
  ])('accepts the frozen v1 pair %s -> %s', (kind, productType) => {
    expect(validateCatalogProductTypeV1({ kind, productType })).toBe(productType)
  })

  it.each(
    Object.values(CatalogItemKind).flatMap(kind =>
      Object.values(ProductType)
        .filter(
          productType =>
            !(
              (kind === CatalogItemKind.PREPARED_DISH && productType === ProductType.FOOD_AND_BEV) ||
              (kind === CatalogItemKind.RETAIL_PRODUCT && (productType === ProductType.REGULAR || productType === ProductType.FOOD_AND_BEV))
            ),
        )
        .map(productType => [kind, productType] as const),
    ),
  )('rejects the unapproved v1 pair %s -> %s', (kind, productType) => {
    expect(() => validateCatalogProductTypeV1({ kind, productType })).toThrow('CATALOG_PRODUCT_TYPE_INVALID')
  })
})
