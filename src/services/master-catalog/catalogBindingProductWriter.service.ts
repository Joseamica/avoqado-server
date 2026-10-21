import { CatalogItemKind, IvaTratamiento, Prisma } from '@prisma/client'
import { ConflictError } from '../../errors/AppError'
import type { CatalogBindingDecisionInput, CatalogManagedFieldV1 } from '../../types/master-catalog'
import { CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V2, CATALOG_RETAIL_MANAGED_FIELD_MASK_V2 } from '../../types/master-catalog'
import type { EvaluatedBindingLine } from './catalogBindingPreview.service'
import { hashCatalogManagedFieldsV1 } from './catalogHash.service'

export interface MaterializedCatalogProduct {
  product: { id: string; updatedAt: Date }
  published: {
    revision: number
    snapshot: Prisma.InputJsonObject
    hashVersion: 1
    hash: string
  }
}

export function managedFieldMaskForCatalogKind(kind: CatalogItemKind): readonly CatalogManagedFieldV1[] {
  return kind === CatalogItemKind.RETAIL_PRODUCT ? CATALOG_RETAIL_MANAGED_FIELD_MASK_V2 : CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V2
}

// D15: la instantánea lleva sólo los campos que el catálogo administra (V2, sin IVA).
function managedSnapshot(line: EvaluatedBindingLine): Prisma.InputJsonObject {
  const item = line.application.item
  const common: Prisma.InputJsonObject = {
    description: item.description,
    imageUrl: item.imageUrl,
    name: item.name,
    satProductKey: item.satProductKey,
    satUnitKey: item.satUnitKey,
    type: item.productType,
    unit: item.unit,
  }
  return item.kind === CatalogItemKind.RETAIL_PRODUCT ? { cost: item.purchaseCost, ...common } : common
}

export async function createPrivateCatalogProductTx(
  tx: Prisma.TransactionClient,
  input: {
    staffId: string
    venueId: string
    decision: Extract<CatalogBindingDecisionInput, { decision: 'CREATE' }>
    evaluated: EvaluatedBindingLine
  },
): Promise<MaterializedCatalogProduct> {
  const item = input.evaluated.application.item
  if (item.kind === CatalogItemKind.RETAIL_PRODUCT && item.purchaseCost === null) {
    throw new ConflictError('Costo corporativo no disponible', 'CATALOG_BINDING_STALE')
  }
  const product = await tx.product.create({
    // WHY: This private allowlist materializes only managed fields plus DB-required
    // empty arrays; no operational relation or activation side effect is nested.
    data: {
      venueId: input.venueId,
      sku: input.decision.create.localSku,
      gtin: null,
      name: item.name,
      description: item.description,
      categoryId: input.decision.create.categoryId,
      type: item.productType,
      price: new Prisma.Decimal(input.decision.create.initialPrice),
      cost: item.kind === CatalogItemKind.RETAIL_PRODUCT ? new Prisma.Decimal(item.purchaseCost as string) : null,
      // D15: nace al 16 % EXPLÍCITO, sin importar lo que diga el artículo; el IVA lo decide cada negocio después.
      ivaTratamiento: IvaTratamiento.IVA_16,
      taxRate: new Prisma.Decimal('0.1600'),
      satProductKey: item.satProductKey,
      satUnitKey: item.satUnitKey,
      objetoImp: '02',
      imageUrl: item.imageUrl,
      tags: [],
      allergens: [],
      unit: item.unit,
      active: false,
      createdById: input.staffId,
    },
    select: { id: true, updatedAt: true },
  })
  const snapshot = managedSnapshot(input.evaluated)
  const managed = hashCatalogManagedFieldsV1({
    hashVersion: 1,
    fieldMask: managedFieldMaskForCatalogKind(item.kind),
    values: snapshot,
    decimalScales: { cost: 2 },
  })
  return {
    product,
    published: { revision: item.revision, snapshot, hashVersion: managed.hashVersion, hash: managed.hash },
  }
}
