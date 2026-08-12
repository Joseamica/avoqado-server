import { BusinessType, CatalogItemKind, CatalogVenueBindingStatus, ProductType, Unit, VenueOperationalRole } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import * as XLSX from 'xlsx'

export function readCatalogExportRows(buffer: Buffer, sheetName: string): unknown[][] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellNF: true })
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null }) as unknown[][]
}

export const catalogExportGeneratedAt = new Date('2026-08-09T12:34:56.000Z')
export const catalogExportContext = {
  organizationId: 'org-pits',
  actor: { type: 'HUMAN' as const, staffId: 'staff-reader', impersonating: false },
}

export type CatalogExportRecipeVariant =
  | 'COMPLETE'
  | 'MISSING_RECIPE'
  | 'INVALID_PORTION_YIELD'
  | 'MISSING_PREP_TIME'
  | 'EMPTY_LINES'
  | 'COST_STALE'
  | 'UNSUPPORTED'
  | 'UNSUPPORTED_BAD_YIELD'
  | 'UNSUPPORTED_INACTIVE_PREP'
  | 'UNSUPPORTED_DELETED_PREP'
  | 'RECIPE_COST_OVERFLOW'
  | 'INVALID_HIERARCHY'
  | 'NON_LEAF'

function catalogFixture() {
  const items: any[] = [
    {
      id: 'item-retail',
      sku: '0002',
      kind: CatalogItemKind.RETAIL_PRODUCT,
      name: '+Retail',
      description: 'Desc retail',
      imageUrl: 'https://img/retail',
      presentationLabel: 'Caja',
      unit: Unit.UNIT,
      productType: ProductType.REGULAR,
      taxRate: new Decimal('0.1600'),
      satProductKey: '01010101',
      satUnitKey: 'H87',
      objetoImp: '02',
      iepsMode: 'NONE',
      iepsRate: null,
      iepsQuota: null,
      iepsQuotaUnit: null,
      status: 'RETIRED',
      createdById: 'staff-001',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      updatedById: 'staff-002',
      updatedAt: new Date('2026-08-02T11:00:00.000Z'),
      brand: { name: '@Brand' },
      manufacturer: { name: 'Maker' },
      family: {
        name: 'Retail child',
        status: 'ACTIVE',
        parentId: 'family-retail',
        parent: { name: 'Retail family', status: 'ACTIVE', parentId: null },
        children: [] as Array<{ id: string }>,
      },
    },
    {
      id: 'item-dish',
      sku: '0001',
      kind: CatalogItemKind.PREPARED_DISH,
      name: '=Dish',
      description: 'Desc dish',
      imageUrl: 'https://img/dish',
      presentationLabel: 'Plato',
      unit: Unit.UNIT,
      productType: ProductType.FOOD_AND_BEV,
      taxRate: new Decimal('0.0800'),
      satProductKey: '90101501',
      satUnitKey: 'E48',
      objetoImp: '02',
      iepsMode: 'RATE',
      iepsRate: new Decimal('0.080000'),
      iepsQuota: null,
      iepsQuotaUnit: null,
      status: 'ACTIVE',
      createdById: 'staff-003',
      createdAt: new Date('2026-07-01T10:00:00.000Z'),
      updatedById: 'staff-004',
      updatedAt: new Date('2026-07-02T11:00:00.000Z'),
      brand: { name: 'Dish brand' },
      manufacturer: { name: 'Kitchen' },
      family: {
        name: 'Subfamily',
        status: 'ACTIVE',
        parentId: 'family-food',
        parent: { name: 'Food', status: 'ACTIVE', parentId: null },
        children: [] as Array<{ id: string }>,
      },
    },
  ]
  const prices = [
    {
      id: 'price-2',
      catalogItemId: 'item-retail',
      kind: 'PURCHASE_COST',
      amount: new Decimal('4.50'),
      currency: 'MXN',
      revision: 2,
      active: false,
    },
    {
      id: 'price-1',
      catalogItemId: 'item-dish',
      kind: 'SALE_PRICE',
      amount: new Decimal('120.00'),
      currency: 'MXN',
      revision: 1,
      active: true,
    },
  ]
  const businessTypes = [
    { id: 'bt-2', catalogItemId: 'item-retail', businessType: BusinessType.RETAIL_STORE },
    { id: 'bt-1b', catalogItemId: 'item-dish', businessType: BusinessType.CAFE },
    { id: 'bt-1a', catalogItemId: 'item-dish', businessType: BusinessType.RESTAURANT },
  ]
  const bindings: any[] = [
    {
      id: 'binding-retail',
      catalogItemId: 'item-retail',
      venueId: 'venue-2',
      status: CatalogVenueBindingStatus.PENDING,
      lastPublishedCatalogRevision: null,
      venue: { id: 'venue-2', name: '-Venue retail', currency: 'MXN' },
      product: null,
    },
    {
      id: 'binding-dish',
      catalogItemId: 'item-dish',
      venueId: 'venue-1',
      status: CatalogVenueBindingStatus.LINKED,
      lastPublishedCatalogRevision: 4,
      venue: { id: 'venue-1', name: 'Venue kitchen', currency: 'MXN' },
      product: {
        id: 'product-001',
        venueId: 'venue-1',
        sku: '000009',
        categoryId: 'category-001',
        recipe: { id: 'recipe-1', portionYield: 3, prepTime: 12, totalCost: new Decimal('6.0000') },
      },
    },
  ]
  const identifiers = [
    {
      id: 'identifier-1',
      catalogItemId: 'item-dish',
      code: '0001',
      status: 'ACTIVE',
      createdById: 'staff-003',
      createdAt: new Date('2026-07-01T10:00:00.000Z'),
    },
    {
      id: 'identifier-2',
      catalogItemId: 'item-retail',
      code: '0002',
      status: 'RETIRED',
      createdById: 'staff-001',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    },
  ]
  const recipeLines: any[] = [
    {
      id: 'line-1',
      recipeId: 'recipe-1',
      displayOrder: 1,
      quantity: new Decimal('6.000'),
      unit: Unit.UNIT,
      rawMaterial: {
        venueId: 'venue-1',
        unit: Unit.UNIT,
        costPerUnit: new Decimal('3.0000'),
        active: true,
        deletedAt: null,
      },
    },
  ]
  const profiles = [
    {
      id: 'profile-role',
      profileVersion: 9,
      rulesSchemaVersion: 1,
      businessType: BusinessType.RESTAURANT,
      operationalRole: VenueOperationalRole.CEDIS,
      requiredFields: ['roleOnly'],
      active: true,
    },
    {
      id: 'profile-global',
      profileVersion: 3,
      rulesSchemaVersion: 1,
      businessType: null,
      operationalRole: null,
      requiredFields: ['supplierCode', ...Array.from({ length: 64 }, (_, index) => `profileField${index + 1}`)],
      active: true,
    },
    {
      id: 'profile-restaurant',
      profileVersion: 2,
      rulesSchemaVersion: 1,
      businessType: BusinessType.RESTAURANT,
      operationalRole: null,
      requiredFields: ['shelfLifeDays'],
      active: true,
    },
    {
      id: 'profile-inactive',
      profileVersion: 99,
      rulesSchemaVersion: 1,
      businessType: null,
      operationalRole: null,
      requiredFields: [],
      active: false,
    },
  ]
  return { items, prices, businessTypes, bindings, identifiers, recipeLines, profiles }
}

export function buildCatalogExportDb(recipeVariant: CatalogExportRecipeVariant = 'COMPLETE') {
  const rows = catalogFixture()
  const recipe = rows.bindings[1].product!.recipe!
  if (recipeVariant === 'MISSING_RECIPE') rows.bindings[1].product!.recipe = null
  if (recipeVariant === 'INVALID_PORTION_YIELD') {
    recipe.portionYield = 0
    recipe.prepTime = null
    rows.recipeLines = []
  }
  if (recipeVariant === 'MISSING_PREP_TIME') recipe.prepTime = null
  if (recipeVariant === 'EMPTY_LINES') rows.recipeLines = []
  if (recipeVariant === 'COST_STALE') recipe.totalCost = new Decimal('5.0000')
  if (recipeVariant === 'UNSUPPORTED') rows.recipeLines[0].rawMaterial.venueId = 'venue-foreign'
  if (recipeVariant === 'UNSUPPORTED_BAD_YIELD') {
    recipe.portionYield = 0
    rows.recipeLines[0].rawMaterial.venueId = 'venue-foreign'
  }
  if (recipeVariant === 'UNSUPPORTED_INACTIVE_PREP') {
    recipe.prepTime = null
    rows.recipeLines[0].rawMaterial.active = false
  }
  if (recipeVariant === 'UNSUPPORTED_DELETED_PREP') {
    recipe.prepTime = null
    rows.recipeLines[0].rawMaterial.deletedAt = new Date('2026-08-01T00:00:00.000Z')
  }
  if (recipeVariant === 'RECIPE_COST_OVERFLOW') {
    recipe.portionYield = 2
    recipe.totalCost = new Decimal('500000.0000')
    rows.recipeLines[0].quantity = new Decimal('2.000')
    rows.recipeLines[0].rawMaterial.costPerUnit = new Decimal('500000.0000')
  }
  if (recipeVariant === 'INVALID_HIERARCHY') {
    rows.items[0].family = { name: 'Broken root', status: 'ACTIVE', parentId: null, parent: null, children: [] }
  }
  if (recipeVariant === 'NON_LEAF') rows.items[0].family.children = [{ id: 'grandchild' }]

  const idsFor = (args: any) => {
    if (args.where?.id?.in) return args.where.id.in
    const businessType = args.where?.businessTypes?.some?.businessType
    return rows.items.filter(item => !businessType || item.id === 'item-dish').map(item => item.id)
  }
  const filterRelation = (all: any[], args: any) => {
    const ids = args.where?.catalogItemId?.in ?? idsFor(args)
    return all.filter(
      row =>
        ids.includes(row.catalogItemId) &&
        (args.where.active === undefined || row.active === args.where.active) &&
        (!args.where.status || row.status === args.where.status),
    )
  }
  const catalogItemFindMany = jest.fn(async (args: any) => {
    const selected = rows.items.filter(item => idsFor(args).includes(item.id))
    return Object.keys(args.select ?? {}).length <= 2 ? selected.map(({ id, kind }) => ({ id, kind })) : selected
  })
  const relation = (all: any[]) =>
    jest.fn(async (args: any) => {
      const selected = filterRelation(all, args)
      return Object.keys(args.select ?? {}).length === 1 ? selected.map(row => ({ id: row.id })) : selected
    })
  const catalogVenueBindingFindMany = jest.fn(async (args: any) => {
    const selected = filterRelation(rows.bindings, args)
    return Object.keys(args.select ?? {}).length <= 2
      ? selected.map(row => ({ id: row.id, catalogItemId: row.catalogItemId, product: row.product }))
      : selected
  })
  const recipeLineFindMany = jest.fn(async (args: any) =>
    Object.keys(args.select ?? {}).length === 1
      ? rows.recipeLines.filter(row => args.where.recipeId.in.includes(row.recipeId)).map(row => ({ id: row.id }))
      : rows.recipeLines.filter(row => args.where.recipeId.in.includes(row.recipeId)),
  )
  const tx = {
    catalogItem: { findMany: catalogItemFindMany },
    catalogItemPrice: { findMany: relation(rows.prices) },
    catalogItemBusinessType: { findMany: relation(rows.businessTypes) },
    catalogVenueBinding: { findMany: catalogVenueBindingFindMany },
    catalogIdentifier: { findMany: relation(rows.identifiers) },
    recipeLine: { findMany: recipeLineFindMany },
    catalogValidationProfile: { findMany: jest.fn(async () => rows.profiles) },
  }
  const prisma = { $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) }
  return { prisma, tx }
}
