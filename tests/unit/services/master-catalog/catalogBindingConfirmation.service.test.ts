import { CatalogItemKind, ProductType, Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { hashCatalogManagedFieldsV1 } from '@/services/master-catalog/catalogHash.service'
import { hashCanonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import { CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1, CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 } from '@/types/master-catalog'
import {
  NOW,
  bindingHarness,
  bindingTransaction,
  catalogItem,
  configureAppliedLinkReplay,
  context,
  preparedRecipe,
  recipeLine,
  stageConfirmablePreview,
} from './catalogBindingTestHarness'

describe('catalogBinding.service — atomic confirm', () => {
  it('LINK creates provenance only and preserves the captured inactive Product byte-for-byte', async () => {
    const h = bindingHarness()
    const { preview } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })

    const result = await h.service.confirm(context, {
      bindingBatchId: preview.bindingBatchId as string,
      previewToken: preview.previewToken as string,
      confirm: true,
      idempotencyKey: 'binding-confirm-link-1',
    })

    expect(result.lines).toEqual([
      expect.objectContaining({ decision: 'LINK', status: 'APPLIED', productId: 'product-1', bindingId: 'binding-1' }),
    ])
    expect(h.tx.product.create).not.toHaveBeenCalled()
    expect(h.tx.product.update).not.toHaveBeenCalled()
    expect(h.tx.product.updateMany).not.toHaveBeenCalled()
    const bindingData = h.tx.catalogVenueBinding.create.mock.calls[0]?.[0].data
    expect(h.tx.catalogVenueBinding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        catalogItemId: 'item-1',
        venueId: 'venue-1',
        productId: 'product-1',
        status: 'LINKED',
        managedFieldMask: CATALOG_RETAIL_MANAGED_FIELD_MASK_V1,
        managedHashVersion: null,
        lastPublishedCatalogRevision: null,
        lastPublishedManagedHash: null,
        productUpdatedAtObserved: NOW,
        createdById: 'staff-1',
        updatedById: 'staff-1',
      }),
      select: expect.objectContaining({ id: true }),
    })
    expect(bindingData).not.toHaveProperty('lastPublishedManagedSnapshot')
    expect(h.dependencies.writeCatalogAudit).toHaveBeenCalledTimes(1)
  })

  it('CREATE writes the exact private Product allowlist and the Task 5 managed snapshot/hash', async () => {
    const tx = bindingTransaction()
    tx.product.findMany.mockResolvedValue([])
    const h = bindingHarness(tx)
    const { preview } = await stageConfirmablePreview(h, {
      decision: 'CREATE',
      create: { categoryId: 'category-1', localSku: ' local-create ', initialPrice: '25.00' },
    })

    const result = await h.service.confirm(context, {
      bindingBatchId: preview.bindingBatchId as string,
      previewToken: preview.previewToken as string,
      confirm: true,
      idempotencyKey: 'binding-confirm-create-1',
    })

    const createData = h.tx.product.create.mock.calls[0]?.[0].data
    expect(createData).toEqual({
      venueId: 'venue-1',
      sku: 'LOCAL-CREATE',
      gtin: null,
      name: 'Producto maestro',
      description: 'Descripción maestra',
      categoryId: 'category-1',
      type: ProductType.REGULAR,
      price: new Decimal('25.00'),
      cost: new Decimal('12.50'),
      taxRate: new Decimal('0.1600'),
      satProductKey: '50192100',
      satUnitKey: 'H87',
      objetoImp: '02',
      imageUrl: 'https://example.test/item.png',
      tags: [],
      allergens: [],
      unit: Unit.PIECE,
      active: false,
      createdById: 'staff-1',
    })
    expect(createData).not.toHaveProperty('id')
    expect(createData).not.toHaveProperty('inventory')
    expect(createData).not.toHaveProperty('recipe')
    expect(createData).not.toHaveProperty('modifierGroups')
    expect(result.lines[0]).toMatchObject({ decision: 'CREATE', productId: 'product-created', bindingId: 'binding-1' })

    const snapshot = {
      cost: '12.50',
      description: 'Descripción maestra',
      imageUrl: 'https://example.test/item.png',
      name: 'Producto maestro',
      objetoImp: '02',
      satProductKey: '50192100',
      satUnitKey: 'H87',
      taxRate: '0.1600',
      type: ProductType.REGULAR,
      unit: Unit.PIECE,
    }
    const managed = hashCatalogManagedFieldsV1({
      hashVersion: 1,
      fieldMask: CATALOG_RETAIL_MANAGED_FIELD_MASK_V1,
      values: snapshot,
      decimalScales: { cost: 2, taxRate: 4 },
    })
    expect(h.tx.catalogVenueBinding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        lastPublishedCatalogRevision: 7,
        lastPublishedManagedSnapshot: snapshot,
        managedFieldMask: managed.fieldMask,
        managedHashVersion: 1,
        lastPublishedManagedHash: managed.hash,
      }),
      select: expect.objectContaining({ id: true }),
    })
  })

  it('CREATE PREPARED_DISH keeps cost null and evaluates Task 6 only after LINKED provenance exists', async () => {
    const tx = bindingTransaction()
    tx.product.findMany.mockResolvedValue([])
    tx.catalogItem.findFirst.mockResolvedValue(
      catalogItem({ kind: CatalogItemKind.PREPARED_DISH, productType: ProductType.FOOD_AND_BEV, prices: [] }),
    )
    const h = bindingHarness(tx)
    const readiness = {
      state: 'INVALID' as const,
      findings: [{ code: 'MISSING_RECIPE' as const }],
      dependencies: {
        bindingId: 'binding-1',
        bindingRevision: 1,
        catalogItemId: 'item-1',
        catalogItemRevision: 7,
        productId: 'product-created',
        recipeId: null,
        recipeUpdatedAt: null,
        recipeLineHash: null,
      },
    }
    h.dependencies.evaluatePreparedDishBinding.mockResolvedValue(readiness)
    const { preview } = await stageConfirmablePreview(h, {
      decision: 'CREATE',
      create: { categoryId: 'category-1', localSku: 'prepared-local', initialPrice: '30.00' },
    })

    const result = await h.service.confirm(context, {
      bindingBatchId: preview.bindingBatchId as string,
      previewToken: preview.previewToken as string,
      confirm: true,
      idempotencyKey: 'binding-prepared-create',
    })

    expect(preview.lines[0].readiness).toBe('MISSING_RECIPE')
    expect(tx.product.create.mock.calls[0]?.[0].data).toMatchObject({
      sku: 'PREPARED-LOCAL',
      type: ProductType.FOOD_AND_BEV,
      cost: null,
      active: false,
    })
    const bindingData = tx.catalogVenueBinding.create.mock.calls[0]?.[0].data
    expect(bindingData.managedFieldMask).toEqual(CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1)
    expect(bindingData.lastPublishedManagedSnapshot).not.toHaveProperty('cost')
    expect(h.dependencies.evaluatePreparedDishBinding).toHaveBeenCalledWith(tx, {
      organizationId: 'org-1',
      venueId: 'venue-1',
      productId: 'product-created',
    })
    expect(tx.catalogVenueBinding.create.mock.invocationCallOrder[0]).toBeLessThan(
      h.dependencies.evaluatePreparedDishBinding.mock.invocationCallOrder[0] as number,
    )
    expect(tx.recipe.findFirst).not.toHaveBeenCalled()
    expect(result.lines[0].readiness).toEqual(readiness)
  })

  it('SKIP applies only its durable batch-line outcome and creates no Product or binding', async () => {
    const tx = bindingTransaction()
    tx.catalogVenueBinding.findFirst.mockResolvedValue({
      id: 'existing-binding',
      productId: 'product-1',
      revision: 4,
      status: 'LINKED',
      updatedAt: NOW,
    })
    const h = bindingHarness(tx)
    const { preview } = await stageConfirmablePreview(h, { decision: 'SKIP' })

    const result = await h.service.confirm(context, {
      bindingBatchId: preview.bindingBatchId as string,
      previewToken: preview.previewToken as string,
      confirm: true,
      idempotencyKey: 'binding-confirm-skip-1',
    })

    expect(result.lines).toEqual([expect.objectContaining({ decision: 'SKIP', status: 'SKIPPED', productId: null, bindingId: null })])
    expect(h.tx.product.create).not.toHaveBeenCalled()
    expect(h.tx.product.update).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
    expect(h.tx.catalogBindingLine.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: 'READY' }),
      data: expect.objectContaining({ status: 'SKIPPED', productId: null }),
    })
  })

  it('propagates the single transactional audit failure before either state machine can become APPLIED', async () => {
    const h = bindingHarness()
    const { preview } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    h.dependencies.writeCatalogAudit.mockRejectedValueOnce(new Error('audit unavailable'))

    await expect(
      h.service.confirm(context, {
        bindingBatchId: preview.bindingBatchId as string,
        previewToken: preview.previewToken as string,
        confirm: true,
        idempotencyKey: 'binding-confirm-audit-1',
      }),
    ).rejects.toThrow('audit unavailable')

    expect(h.dependencies.writeCatalogAudit).toHaveBeenCalledTimes(1)
    expect(h.tx.catalogBindingBatch.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'APPLIED' }) }),
    )
    expect(h.tx.catalogIdempotencyRecord.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'APPLIED' }) }),
    )
  })

  it('rejects PREPARED_DISH LINK when captured Recipe inputs change before the org-locked confirm', async () => {
    const tx = bindingTransaction()
    tx.catalogItem.findFirst.mockResolvedValue(
      catalogItem({ kind: CatalogItemKind.PREPARED_DISH, productType: ProductType.FOOD_AND_BEV, prices: [] }),
    )
    tx.recipe.findFirst.mockResolvedValue(preparedRecipe())
    const h = bindingHarness(tx)
    const { preview } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    tx.recipe.findFirst.mockResolvedValue(preparedRecipe({ lines: [recipeLine({ quantity: new Decimal('2.000') })] }))

    await expect(
      h.service.confirm(context, {
        bindingBatchId: preview.bindingBatchId as string,
        previewToken: preview.previewToken as string,
        confirm: true,
        idempotencyKey: 'binding-prepared-recipe-stale',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_STALE' })

    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
    expect(h.dependencies.evaluatePreparedDishBinding).not.toHaveBeenCalled()
  })
})

describe('catalogBinding.service — recovery and exact Prisma mapping', () => {
  it('fails closed when matching APPLIED JSON has no tenant-relational line or binding evidence', async () => {
    const h = bindingHarness()
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    const forged = { bindingBatchId: preview.bindingBatchId as string, state: 'APPLIED' as const, lines: [] }
    h.tx.catalogBindingBatch.findFirst.mockResolvedValue({ ...storedBatch, state: 'APPLIED', result: forged })
    h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue({
      organizationId: 'org-1',
      operation: 'CATALOG_BINDING',
      idempotencyKey: 'binding-recover-forged',
      requestHash: storedBatch.requestHash,
      targetHash: storedBatch.targetHash,
      dependencies: storedBatch.dependencies,
      resourceId: preview.bindingBatchId,
      resourceType: 'CatalogBindingBatch',
      actorType: 'HUMAN',
      staffId: 'staff-1',
      state: 'APPLIED',
      result: forged,
    })
    h.tx.catalogBindingLine.findMany.mockResolvedValue([])

    await expect(
      h.service.confirm(context, {
        bindingBatchId: preview.bindingBatchId as string,
        previewToken: preview.previewToken as string,
        confirm: true,
        idempotencyKey: 'binding-recover-forged',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_RESULT_INVALID' })
  })

  it('recovers a relationally coherent winner after the idempotency unique uses field-array metadata', async () => {
    const h = bindingHarness()
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    const readyLines = h.tx.catalogBindingLine.create.mock.calls.map((call, index) => ({
      id: `line-${index + 1}`,
      ...call[0].data,
      createdAt: NOW,
      updatedAt: NOW,
    }))
    const result = {
      bindingBatchId: preview.bindingBatchId as string,
      state: 'APPLIED' as const,
      lines: [
        {
          catalogItemId: 'item-1',
          venueId: 'venue-1',
          decision: 'LINK' as const,
          status: 'APPLIED' as const,
          productId: 'product-1',
          bindingId: 'binding-1',
          readiness: null,
        },
      ],
    }
    const appliedBatch = { ...storedBatch, state: 'APPLIED', result }
    h.tx.catalogBindingBatch.findFirst
      .mockReset()
      .mockResolvedValueOnce(storedBatch)
      .mockResolvedValueOnce(storedBatch)
      .mockResolvedValue(appliedBatch)
    h.tx.catalogBindingLine.findMany
      .mockReset()
      .mockResolvedValueOnce(readyLines)
      .mockResolvedValue(
        readyLines.map((line: Record<string, unknown>) => ({
          ...line,
          status: 'APPLIED',
          productId: 'product-1',
          after: { bindingId: 'binding-1', productId: 'product-1' },
        })),
      )
    h.tx.catalogVenueBinding.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.id === 'binding-1'
        ? {
            id: 'binding-1',
            organizationId: 'org-1',
            catalogItemId: 'item-1',
            venueId: 'venue-1',
            productId: 'product-1',
            status: 'LINKED',
            product: { id: 'product-1', venueId: 'venue-1' },
          }
        : null,
    )
    h.tx.catalogIdempotencyRecord.create.mockRejectedValueOnce({
      code: 'P2002',
      meta: { target: ['organizationId', 'operation', 'idempotencyKey'] },
    })
    h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue({
      organizationId: 'org-1',
      operation: 'CATALOG_BINDING',
      idempotencyKey: 'binding-array-race',
      requestHash: storedBatch.requestHash,
      requestHashVersion: 1,
      targetHash: storedBatch.targetHash,
      dependencies: storedBatch.dependencies,
      resourceId: preview.bindingBatchId,
      resourceType: 'CatalogBindingBatch',
      actorType: 'HUMAN',
      staffId: 'staff-1',
      state: 'APPLIED',
      result,
    })

    await expect(
      h.service.confirm(context, {
        bindingBatchId: preview.bindingBatchId as string,
        previewToken: preview.previewToken as string,
        confirm: true,
        idempotencyKey: 'binding-array-race',
      }),
    ).resolves.toEqual(result)
  })

  it.each([
    ['P2002', { code: 'P2002', meta: { target: 'ActivityLog_unrelated_key' } }],
    ['P2004', { code: 'P2004', meta: { constraint: 'unrelated_check' } }],
  ])('rethrows an unrelated %s instead of laundering it as a binding conflict', async (_label, prismaError) => {
    const h = bindingHarness()
    const { preview } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    h.tx.catalogIdempotencyRecord.create.mockRejectedValueOnce(prismaError)

    await expect(
      h.service.confirm(context, {
        bindingBatchId: preview.bindingBatchId as string,
        previewToken: preview.previewToken as string,
        confirm: true,
        idempotencyKey: `binding-unrelated-${_label}`,
      }),
    ).rejects.toBe(prismaError)
  })

  it('rejects matching batch/record dependencies whose closed target authority was injected after preview', async () => {
    const h = bindingHarness()
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    const rows = configureAppliedLinkReplay(h, storedBatch, 'binding-injected-deps')
    const dependencies = { ...storedBatch.dependencies, injected: true }
    h.tx.catalogBindingBatch.findFirst.mockResolvedValue({ ...rows.appliedBatch, dependencies })
    h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue({ ...rows.record, dependencies })

    await expect(
      h.service.confirm(context, {
        bindingBatchId: preview.bindingBatchId as string,
        previewToken: preview.previewToken as string,
        confirm: true,
        idempotencyKey: 'binding-injected-deps',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_RESULT_INVALID' })
  })

  it('rejects an opaque readiness object instead of reflecting unverified APPLIED JSON', async () => {
    const h = bindingHarness()
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    const rows = configureAppliedLinkReplay(h, storedBatch, 'binding-forged-readiness')
    const result = { ...rows.result, lines: [{ ...rows.result.lines[0], readiness: {} }] }
    h.tx.catalogBindingBatch.findFirst.mockResolvedValue({ ...rows.appliedBatch, result })
    h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue({ ...rows.record, result })

    await expect(
      h.service.confirm(context, {
        bindingBatchId: preview.bindingBatchId as string,
        previewToken: preview.previewToken as string,
        confirm: true,
        idempotencyKey: 'binding-forged-readiness',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_RESULT_INVALID' })
  })

  it('rejects recovery when durable line after points at a different binding than the result', async () => {
    const h = bindingHarness()
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    const rows = configureAppliedLinkReplay(h, storedBatch, 'binding-forged-after')
    h.tx.catalogBindingLine.findMany.mockResolvedValue(
      rows.durableLines.map(line => ({ ...line, after: { bindingId: 'binding-forged', productId: 'product-1' } })),
    )

    await expect(
      h.service.confirm(context, {
        bindingBatchId: preview.bindingBatchId as string,
        previewToken: preview.previewToken as string,
        confirm: true,
        idempotencyKey: 'binding-forged-after',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_RESULT_INVALID' })
  })

  it('rejects hash-consistent nested and decision keys outside the frozen dependency schema', async () => {
    const h = bindingHarness()
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    const rows = configureAppliedLinkReplay(h, storedBatch, 'binding-nested-injection')
    const original = storedBatch.dependencies.lines[0]
    const dependency = {
      ...original,
      injected: true,
      catalogItem: { ...original.catalogItem, injected: true },
      decision: { ...original.decision, injected: true },
    }
    const dependencies = { schemaVersion: 1, lines: [dependency] }
    const targetHash = hashCanonicalJsonV1('catalog-binding-target', dependencies.lines)
    const requestHash = hashCanonicalJsonV1('catalog-binding-request', {
      organizationId: 'org-1',
      staffId: 'staff-1',
      targetHash,
    })
    h.tx.catalogBindingBatch.findFirst.mockResolvedValue({ ...rows.appliedBatch, dependencies, targetHash, requestHash })
    h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue({ ...rows.record, dependencies, targetHash, requestHash })

    await expect(
      h.service.confirm(context, {
        bindingBatchId: preview.bindingBatchId as string,
        previewToken: preview.previewToken as string,
        confirm: true,
        idempotencyKey: 'binding-nested-injection',
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_RESULT_INVALID' })
  })
})
