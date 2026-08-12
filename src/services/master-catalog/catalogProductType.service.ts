import { CatalogItemKind, ProductType } from '@prisma/client'

export interface CatalogProductTypeV1Input {
  kind: CatalogItemKind
  productType: ProductType
}

/**
 * WHY: This closed matrix prevents deprecated, service, and newly-added ProductType
 * values from silently acquiring H1 catalog or Recipe semantics.
 */
export function validateCatalogProductTypeV1(input: CatalogProductTypeV1Input): ProductType {
  const allowed =
    (input.kind === CatalogItemKind.PREPARED_DISH && input.productType === ProductType.FOOD_AND_BEV) ||
    (input.kind === CatalogItemKind.RETAIL_PRODUCT &&
      (input.productType === ProductType.REGULAR || input.productType === ProductType.FOOD_AND_BEV))

  if (!allowed) throw new Error('CATALOG_PRODUCT_TYPE_INVALID')
  return input.productType
}
