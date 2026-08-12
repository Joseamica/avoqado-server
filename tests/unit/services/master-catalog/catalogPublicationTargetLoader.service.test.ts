import { BusinessType, CatalogItemKind, ProductType, Unit, VenueOperationalRole } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { loadCatalogPublicationTargetsTx } from '@/services/master-catalog/catalogPublicationTargetLoader.service'

const context = {
  organizationId: 'org-1',
  actor: { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false },
}

function retiredRetailBinding() {
  return {
    id: 'binding-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    productId: 'product-1',
    revision: 1,
    managedFieldMask: [],
    lastPublishedCatalogRevision: null,
    lastPublishedManagedSnapshot: null,
    lastPublishedManagedHash: null,
    venue: {
      id: 'venue-1',
      organizationId: 'org-1',
      currency: 'MXN',
      operationalRole: VenueOperationalRole.STORE,
    },
    product: {
      id: 'product-1',
      venueId: 'venue-1',
      name: 'Local',
      description: 'Local',
      imageUrl: 'https://example.test/local.png',
      type: ProductType.REGULAR,
      cost: new Decimal('10.00'),
      taxRate: new Decimal('0.1600'),
      satProductKey: '50192100',
      satUnitKey: 'H87',
      objetoImp: '02',
      unit: Unit.PIECE,
      categoryId: 'category-1',
      price: new Decimal('20.00'),
      active: false,
      deletedAt: null,
      updatedAt: new Date('2026-08-08T00:00:00.000Z'),
    },
    catalogItem: {
      id: 'item-1',
      organizationId: 'org-1',
      sku: 'SKU-1',
      kind: CatalogItemKind.RETAIL_PRODUCT,
      status: 'RETIRED',
      revision: 1,
      invariantVersion: 1n,
      name: 'Corporativo',
      description: 'Corporativo',
      imageUrl: 'https://example.test/corp.png',
      brandId: 'brand-1',
      manufacturerId: 'maker-1',
      familyId: 'family-1',
      presentationLabel: 'Caja',
      unit: Unit.PIECE,
      taxRate: new Decimal('0.1600'),
      satProductKey: '50192100',
      satUnitKey: 'H87',
      objetoImp: '02',
      productType: ProductType.REGULAR,
      iepsMode: 'NONE',
      iepsRate: null,
      iepsQuota: null,
      iepsQuotaUnit: null,
      createdById: 'staff-1',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedById: 'staff-1',
      updatedAt: new Date('2026-08-02T00:00:00.000Z'),
      family: { parentId: 'parent-1' },
      businessTypes: [{ businessType: BusinessType.RETAIL_STORE }],
      prices: [
        { kind: 'SALE_PRICE', scope: 'ORGANIZATION', amount: new Decimal('20'), currency: 'MXN', active: true, revision: 1 },
        { kind: 'PURCHASE_COST', scope: 'ORGANIZATION', amount: new Decimal('10'), currency: 'MXN', active: true, revision: 1 },
      ],
    },
  }
}

describe('catalogPublicationTargetLoader.service', () => {
  it('captures the unique current managed leaf while excluding activation history', async () => {
    const binding = retiredRetailBinding()
    binding.catalogItem.status = 'ACTIVE'
    const tx = {
      catalogValidationProfile: { findMany: jest.fn().mockResolvedValue([]) },
      catalogVenueBinding: { findMany: jest.fn().mockResolvedValue([binding]) },
      catalogPublicationLine: { findMany: jest.fn().mockResolvedValue([{ id: 'managed-leaf-2', bindingId: 'binding-1' }]) },
    }

    const [target] = await loadCatalogPublicationTargetsTx(tx as never, context, [
      { catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1' },
    ])

    expect(target.dependencies).toMatchObject({ currentPublicationLineId: 'managed-leaf-2' })
    expect(tx.catalogPublicationLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          batch: { operation: { in: ['CATALOG_FIELDS_PUBLISH', 'CATALOG_FIELDS_REVERSION'] } },
          supersededByLines: {
            none: expect.objectContaining({ batch: { operation: { in: ['CATALOG_FIELDS_PUBLISH', 'CATALOG_FIELDS_REVERSION'] } } }),
          },
        }),
      }),
    )
  })

  it('never stages a retired retail CatalogItem as a publishable target', async () => {
    const tx = {
      catalogValidationProfile: { findMany: jest.fn().mockResolvedValue([]) },
      catalogVenueBinding: { findMany: jest.fn().mockResolvedValue([retiredRetailBinding()]) },
    }

    await expect(
      loadCatalogPublicationTargetsTx(tx as never, context, [{ catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1' }]),
    ).resolves.toEqual([])
    expect(tx.catalogVenueBinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1' }),
        select: expect.objectContaining({
          catalogItem: expect.objectContaining({ select: expect.objectContaining({ invariantVersion: true }) }),
        }),
      }),
    )
  })
})
