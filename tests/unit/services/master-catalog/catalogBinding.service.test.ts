import { CatalogItemKind, ProductType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { hashCatalogRecipeLinesV1 } from '@/services/master-catalog/catalogRecipeCost.service'
import {
  NOW,
  bindingHarness,
  bindingTransaction,
  catalogItem,
  context,
  preparedRecipe,
  product,
  recipeLine,
} from './catalogBindingTestHarness'

describe('catalogBinding.service — explicit preview', () => {
  it('discovers raw case-sensitive SKU/GTIN candidates with one bounded ordered findMany and cannot confirm without decisions', async () => {
    const { service, tx } = bindingHarness()

    const preview = await service.preview(context, { lines: [{ catalogItemId: 'item-1', venueId: 'venue-1' }] })

    expect(tx.product.findMany).toHaveBeenCalledWith({
      where: { venueId: 'venue-1', OR: [{ sku: 'Corp-SKU' }, { gtin: 'Corp-SKU' }] },
      select: expect.objectContaining({ id: true, sku: true, gtin: true, active: true, deletedAt: true }),
      orderBy: { id: 'asc' },
      take: 101,
    })
    expect(preview.canConfirm).toBe(false)
    expect(preview).toMatchObject({ bindingBatchId: null, previewToken: null, expiresAt: null })
    expect(tx.catalogBindingBatch.create).not.toHaveBeenCalled()
    expect(preview.lines[0]).toMatchObject({
      catalogItemId: 'item-1',
      venueId: 'venue-1',
      proposal: 'LINK',
      decision: null,
      candidates: [expect.objectContaining({ id: 'product-1', active: false, deletedAt: null })],
    })
  })

  it('deduplicates a Product returned through both exact fields and keeps inactive/deleted reservations visible', async () => {
    const tx = bindingTransaction()
    tx.product.findMany.mockResolvedValue([
      product({ id: 'product-2', sku: 'Corp-SKU', gtin: 'Corp-SKU', deletedAt: NOW }),
      product({ id: 'product-2', sku: 'Corp-SKU', gtin: 'Corp-SKU', deletedAt: NOW }),
      product({ id: 'product-3', active: false }),
    ])
    const { service } = bindingHarness(tx)

    const preview = await service.preview(context, { lines: [{ catalogItemId: 'item-1', venueId: 'venue-1' }] })

    expect(preview.lines[0].candidates.map(candidate => candidate.id)).toEqual(['product-2', 'product-3'])
    expect(preview.lines[0].candidates[0]).toMatchObject({ active: false, deletedAt: NOW.toISOString() })
  })

  it('rejects LINK to a case-folded/noncaptured Product rather than inferring a match', async () => {
    const { service } = bindingHarness()

    const preview = await service.preview(context, {
      lines: [{ catalogItemId: 'item-1', venueId: 'venue-1', decision: { decision: 'LINK', productId: 'product-other' } }],
    })

    expect(preview.canConfirm).toBe(false)
    expect(preview.lines[0]).toMatchObject({ status: 'INVALID', errorCode: 'CATALOG_BINDING_LINK_NOT_CANDIDATE' })
  })

  it('keeps an explicit SKIP confirmable even when the item or matching Product is already bound', async () => {
    const tx = bindingTransaction()
    tx.catalogVenueBinding.findFirst.mockResolvedValue({
      id: 'existing-binding',
      productId: 'product-1',
      revision: 4,
      status: 'LINKED',
      updatedAt: NOW,
    })
    tx.catalogVenueBinding.findMany.mockResolvedValue([
      { id: 'other-binding', catalogItemId: 'item-other', productId: 'product-1', revision: 2, status: 'LINKED' },
    ])
    const { service } = bindingHarness(tx)

    const preview = await service.preview(context, {
      lines: [{ catalogItemId: 'item-1', venueId: 'venue-1', decision: { decision: 'SKIP' } }],
    })

    expect(preview).toMatchObject({ canConfirm: true, bindingBatchId: 'batch-1', previewToken: 'preview-token' })
    expect(preview.lines[0]).toMatchObject({ proposal: 'SKIP', status: 'READY', errorCode: null })
    expect(tx.catalogBindingLine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ decision: 'SKIP', proposal: 'SKIP', productId: null, status: 'READY' }),
    })
    expect(tx.product.create).not.toHaveBeenCalled()
    expect(tx.product.update).not.toHaveBeenCalled()
    expect(tx.catalogVenueBinding.create).not.toHaveBeenCalled()
  })

  it('captures a selected PREPARED_DISH Recipe input hash without requiring pre-existing provenance', async () => {
    const tx = bindingTransaction()
    const recipe = preparedRecipe()
    tx.catalogItem.findFirst.mockResolvedValue(
      catalogItem({ kind: CatalogItemKind.PREPARED_DISH, productType: ProductType.FOOD_AND_BEV, prices: [] }),
    )
    tx.recipe.findFirst.mockResolvedValue(recipe)
    const { service } = bindingHarness(tx)

    const preview = await service.preview(context, {
      lines: [{ catalogItemId: 'item-1', venueId: 'venue-1', decision: { decision: 'LINK', productId: 'product-1' } }],
    })

    expect(preview.lines[0]).toMatchObject({ readiness: 'READY', status: 'READY' })
    expect(tx.recipe.findFirst).toHaveBeenCalledWith({
      where: { productId: 'product-1', product: { venueId: 'venue-1' } },
      select: expect.objectContaining({
        id: true,
        portionYield: true,
        prepTime: true,
        totalCost: true,
        updatedAt: true,
        lines: expect.any(Object),
      }),
    })
    const batchData = tx.catalogBindingBatch.create.mock.calls[0]?.[0].data
    expect(batchData.dependencies.lines[0].readinessDependency).toEqual({
      schemaVersion: 1,
      state: 'READY',
      productId: 'product-1',
      recipeId: 'recipe-1',
      recipeUpdatedAt: NOW.toISOString(),
      recipeLineHash: hashCatalogRecipeLinesV1(recipe.lines),
      portionYield: 8,
      prepTime: 10,
      totalCost: '62.5000',
    })
  })

  it.each([
    ['SERVICE', { organizationId: 'org-1', actor: { type: 'SERVICE' as const, servicePrincipalId: 'svc-1' } }],
    ['impersonating HUMAN', { organizationId: 'org-1', actor: { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: true } }],
  ])('rejects %s before opening a preview transaction', async (_label, rejectedContext) => {
    const h = bindingHarness()

    await expect(h.service.preview(rejectedContext, { lines: [{ catalogItemId: 'item-1', venueId: 'venue-1' }] })).rejects.toMatchObject({
      statusCode: 403,
    })
    expect(h.prisma.$transaction).not.toHaveBeenCalled()
  })

  it('permits explicit LINK to inactive but never soft-deleted exact candidates', async () => {
    const inactive = bindingTransaction()
    inactive.product.findMany.mockResolvedValue([product({ active: false })])
    const inactivePreview = await bindingHarness(inactive).service.preview(context, {
      lines: [{ catalogItemId: 'item-1', venueId: 'venue-1', decision: { decision: 'LINK', productId: 'product-1' } }],
    })
    expect(inactivePreview).toMatchObject({ canConfirm: true, lines: [{ status: 'READY', errorCode: null }] })

    const deleted = bindingTransaction()
    deleted.product.findMany.mockResolvedValue([product({ active: false, deletedAt: NOW })])
    const deletedPreview = await bindingHarness(deleted).service.preview(context, {
      lines: [{ catalogItemId: 'item-1', venueId: 'venue-1', decision: { decision: 'LINK', productId: 'product-1' } }],
    })
    expect(deletedPreview).toMatchObject({
      canConfirm: false,
      bindingBatchId: null,
      previewToken: null,
      lines: [{ status: 'INVALID', errorCode: 'CATALOG_BINDING_PRODUCT_DELETED' }],
    })
  })

  it.each([
    [
      'foreign category',
      (tx: ReturnType<typeof bindingTransaction>) => tx.menuCategory.findFirst.mockResolvedValue(null),
      'CATALOG_BINDING_CATEGORY_NOT_FOUND',
    ],
    [
      'different PURCHASE_COST currency',
      (tx: ReturnType<typeof bindingTransaction>) =>
        tx.catalogItem.findFirst.mockResolvedValue(catalogItem({ prices: [{ ...catalogItem().prices[0], currency: 'USD' }] })),
      'CATALOG_BINDING_PURCHASE_COST_MISSING',
    ],
    [
      'missing PURCHASE_COST',
      (tx: ReturnType<typeof bindingTransaction>) => tx.catalogItem.findFirst.mockResolvedValue(catalogItem({ prices: [] })),
      'CATALOG_BINDING_PURCHASE_COST_MISSING',
    ],
    [
      'Task 5 kind/ProductType mismatch',
      (tx: ReturnType<typeof bindingTransaction>) =>
        tx.catalogItem.findFirst.mockResolvedValue(catalogItem({ productType: ProductType.SERVICE })),
      'CATALOG_BINDING_PRODUCT_TYPE_INVALID',
    ],
  ])('keeps CREATE nonconfirmable for %s', async (_label, arrange, errorCode) => {
    const tx = bindingTransaction()
    tx.product.findMany.mockResolvedValue([])
    arrange(tx)
    const preview = await bindingHarness(tx).service.preview(context, {
      lines: [
        {
          catalogItemId: 'item-1',
          venueId: 'venue-1',
          decision: { decision: 'CREATE', create: { categoryId: 'category-1', localSku: 'local-new', initialPrice: '20.00' } },
        },
      ],
    })

    expect(preview).toMatchObject({ canConfirm: false, bindingBatchId: null, previewToken: null })
    expect(preview.lines[0]).toMatchObject({ status: 'INVALID', errorCode })
    expect(tx.catalogBindingBatch.create).not.toHaveBeenCalled()
  })

  it('blocks CREATE when deleted/inactive Products reserve the normalized SKU through either local field', async () => {
    const tx = bindingTransaction()
    tx.product.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([product({ id: 'reservation-1', sku: 'OTHER', gtin: 'LOCAL-NEW', active: false, deletedAt: NOW })])
    const preview = await bindingHarness(tx).service.preview(context, {
      lines: [
        {
          catalogItemId: 'item-1',
          venueId: 'venue-1',
          decision: { decision: 'CREATE', create: { categoryId: 'category-1', localSku: ' local-new ', initialPrice: '20.00' } },
        },
      ],
    })

    expect(tx.product.findMany).toHaveBeenNthCalledWith(2, {
      where: { venueId: 'venue-1', OR: [{ sku: 'LOCAL-NEW' }, { gtin: 'LOCAL-NEW' }] },
      select: expect.any(Object),
      orderBy: { id: 'asc' },
      take: 2,
    })
    expect(preview).toMatchObject({
      canConfirm: false,
      lines: [{ status: 'CONFLICT', errorCode: 'CATALOG_BINDING_LOCAL_SKU_RESERVED' }],
    })
  })

  it('fails closed without hashing foreign RawMaterial costs in prospective PREPARED_DISH readiness', async () => {
    async function previewWithForeignCost(costPerUnit: string) {
      const tx = bindingTransaction()
      tx.catalogItem.findFirst.mockResolvedValue(
        catalogItem({ kind: CatalogItemKind.PREPARED_DISH, productType: ProductType.FOOD_AND_BEV, prices: [] }),
      )
      tx.recipe.findFirst.mockResolvedValue(
        preparedRecipe({
          lines: [
            recipeLine({
              rawMaterial: {
                id: 'raw-foreign',
                venueId: 'venue-foreign',
                unit: 'GRAM',
                costPerUnit: new Decimal(costPerUnit),
                active: true,
                deletedAt: null,
              },
            }),
          ],
        }),
      )
      const preview = await bindingHarness(tx).service.preview(context, {
        lines: [{ catalogItemId: 'item-1', venueId: 'venue-1', decision: { decision: 'LINK', productId: 'product-1' } }],
      })
      return { preview, dependency: tx.catalogBindingBatch.create.mock.calls[0]?.[0].data.dependencies.lines[0].readinessDependency }
    }

    const lowCost = await previewWithForeignCost('1.0000')
    const highCost = await previewWithForeignCost('9.0000')

    expect(lowCost.preview.lines[0].readiness).toBe('INVALID')
    expect(lowCost.dependency).toEqual({
      schemaVersion: 1,
      state: 'INVALID',
      productId: 'product-1',
      recipeId: null,
      recipeUpdatedAt: null,
      recipeLineHash: null,
      portionYield: null,
      prepTime: null,
      totalCost: null,
    })
    expect(highCost.preview.targetHash).toBe(lowCost.preview.targetHash)
  })
})
