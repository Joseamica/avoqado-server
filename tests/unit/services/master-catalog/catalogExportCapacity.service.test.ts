import { BusinessType, CatalogItemKind, CatalogVenueBindingStatus, ProductType, Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { createCatalogExportService } from '@/services/master-catalog/catalogExport.service'

const context = {
  organizationId: 'org-pits',
  actor: { type: 'HUMAN' as const, staffId: 'staff-reader', impersonating: false },
}

function nearCapRecipeDb() {
  const item = {
    id: 'item-dish',
    sku: '0001',
    kind: CatalogItemKind.PREPARED_DISH,
    name: 'Dish',
    description: 'Dish description',
    imageUrl: 'https://cdn.example.test/dish',
    presentationLabel: 'Plate',
    unit: Unit.UNIT,
    productType: ProductType.FOOD_AND_BEV,
    taxRate: new Decimal('0.1600'),
    satProductKey: '90101501',
    satUnitKey: 'E48',
    objetoImp: '02',
    iepsMode: 'NONE',
    iepsRate: null,
    iepsQuota: null,
    iepsQuotaUnit: null,
    status: 'ACTIVE',
    createdById: 'staff-1',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedById: 'staff-1',
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    brand: { name: 'Brand' },
    manufacturer: { name: 'Maker' },
    family: {
      name: 'Prepared',
      status: 'ACTIVE',
      parentId: 'family-root',
      parent: { name: 'Food', status: 'ACTIVE', parentId: null },
      children: [],
    },
  }
  const recipe = { id: 'recipe-1', portionYield: 1, prepTime: 1, totalCost: new Decimal('4998.0000') }
  const binding = {
    id: 'binding-1',
    catalogItemId: item.id,
    venueId: 'venue-1',
    status: CatalogVenueBindingStatus.LINKED,
    lastPublishedCatalogRevision: 1,
    venue: { id: 'venue-1', name: 'Kitchen', currency: 'MXN' },
    product: { id: 'product-1', venueId: 'venue-1', sku: '0001', categoryId: 'category-1', recipe },
  }
  const lines = Array.from({ length: 4_998 }, (_, index) => ({
    id: `line-${index}`,
    recipeId: recipe.id,
    displayOrder: index,
    quantity: new Decimal('1.0000'),
    unit: Unit.UNIT,
    rawMaterial: {
      venueId: binding.venueId,
      unit: Unit.UNIT,
      costPerUnit: new Decimal('1.0000'),
      active: true,
      deletedAt: null,
    },
  }))
  const tx = {
    catalogItem: {
      findMany: jest.fn(async (args: any) => (Object.keys(args.select).length === 2 ? [{ id: item.id, kind: item.kind }] : [item])),
    },
    catalogValidationProfile: { findMany: jest.fn().mockResolvedValue([]) },
    catalogItemPrice: { findMany: jest.fn().mockResolvedValue([]) },
    catalogItemBusinessType: { findMany: jest.fn().mockResolvedValue([]) },
    catalogVenueBinding: { findMany: jest.fn().mockResolvedValue([binding]) },
    catalogIdentifier: { findMany: jest.fn().mockResolvedValue([]) },
    recipeLine: {
      findMany: jest.fn(async (args: any) => (Object.keys(args.select).length === 1 ? lines.map(line => ({ id: line.id })) : lines)),
    },
  }
  return { $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) }
}

describe('catalogExport bounded hydration', () => {
  it('yields while grouping a near-cap recipe before rendering', async () => {
    let eventLoopProgressed = false
    setImmediate(() => {
      eventLoopProgressed = true
    })
    const writeWorkbook = jest.fn(async () => {
      expect(eventLoopProgressed).toBe(true)
      return Buffer.from('xlsx')
    })

    await createCatalogExportService({ prisma: nearCapRecipeDb() as never, writeWorkbook }).catalogMaster(context)
  })

  it('rejects the item probe cap before hydrating any relation', async () => {
    const tx = {
      catalogItem: {
        findMany: jest
          .fn()
          .mockResolvedValue(Array.from({ length: 5_001 }, (_, index) => ({ id: `item-${index}`, kind: 'RETAIL_PRODUCT' }))),
      },
      catalogItemPrice: { findMany: jest.fn() },
    }
    const prisma = { $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) }

    await expect(createCatalogExportService({ prisma: prisma as never }).catalogMaster(context)).rejects.toMatchObject({
      statusCode: 413,
      code: 'CATALOG_EXPORT_CAP_EXCEEDED',
    })
    expect(tx.catalogItemPrice.findMany).not.toHaveBeenCalled()
  })

  it('rejects the business-profile probe cap before requesting profile rules or required fields', async () => {
    const catalogValidationProfile = {
      findMany: jest.fn(async (args: any) => {
        if (args.select.requiredFields || args.select.rulesSchemaVersion) throw new Error('profile rules hydrated before capacity')
        return Array.from({ length: 5_000 }, (_, index) => ({ id: `profile-${index}`, profileVersion: index + 1 }))
      }),
    }
    const tx = {
      catalogItem: { findMany: jest.fn().mockResolvedValue([{ id: 'item-1', kind: CatalogItemKind.RETAIL_PRODUCT }]) },
      catalogValidationProfile,
      catalogItemPrice: { findMany: jest.fn() },
    }
    const prisma = { $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) }

    await expect(
      createCatalogExportService({ prisma: prisma as never }).catalogByBusinessType(context, BusinessType.RESTAURANT),
    ).rejects.toMatchObject({ statusCode: 413, code: 'CATALOG_EXPORT_CAP_EXCEEDED' })

    expect(catalogValidationProfile.findMany).toHaveBeenCalledTimes(1)
    expect(catalogValidationProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, profileVersion: true }, take: 5_000 }),
    )
    expect(tx.catalogItemPrice.findMany).not.toHaveBeenCalled()
  })

  it('rejects the template profile probe cap before rendering metadata', async () => {
    const catalogValidationProfile = {
      findMany: jest
        .fn()
        .mockResolvedValue(Array.from({ length: 5_001 }, (_, index) => ({ id: `profile-${index}`, profileVersion: index + 1 }))),
    }
    const tx = { catalogValidationProfile }
    const prisma = { $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) }
    const writeWorkbook = jest.fn().mockResolvedValue(Buffer.from('not-used'))

    await expect(
      createCatalogExportService({ prisma: prisma as never, writeWorkbook }).catalogImportTemplate(context),
    ).rejects.toMatchObject({ statusCode: 413, code: 'CATALOG_EXPORT_CAP_EXCEEDED' })

    expect(catalogValidationProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, profileVersion: true }, take: 5_001 }),
    )
    expect(writeWorkbook).not.toHaveBeenCalled()
  })
})
