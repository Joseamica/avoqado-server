import { CatalogItemKind, ProductType } from '@prisma/client'
import { isCatalogBindingIdempotencyUniqueConflict } from '@/services/master-catalog/catalogBindingRecovery.service'
import {
  NOW,
  bindingHarness,
  bindingTransaction,
  catalogItem,
  configureAppliedLinkReplay,
  context,
  preparedRecipe,
  product,
  stageConfirmablePreview,
} from './catalogBindingTestHarness'

function confirmInput(bindingBatchId = 'batch-1', previewToken = 'preview-token', idempotencyKey = 'binding-guard-key') {
  return { bindingBatchId, previewToken, confirm: true as const, idempotencyKey }
}

describe('catalogBinding.service — confirm guards', () => {
  it.each([
    ['SERVICE', { organizationId: 'org-1', actor: { type: 'SERVICE' as const, servicePrincipalId: 'svc-1' } }],
    ['impersonating HUMAN', { organizationId: 'org-1', actor: { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: true } }],
  ])('rejects %s before opening a confirm transaction', async (_label, rejectedContext) => {
    const h = bindingHarness()

    await expect(h.service.confirm(rejectedContext, confirmInput())).rejects.toMatchObject({ statusCode: 403 })
    expect(h.prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a different HUMAN actor before acquiring the organization mutation lock', async () => {
    const h = bindingHarness()
    const { preview } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })

    await expect(
      h.service.confirm(
        { organizationId: 'org-1', actor: { type: 'HUMAN', staffId: 'staff-other', impersonating: false } },
        confirmInput(preview.bindingBatchId as string, preview.previewToken as string),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_ACTOR_MISMATCH', statusCode: 403 })
    expect(h.dependencies.acquireMutationLockTx).not.toHaveBeenCalled()
    expect(h.tx.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
  })

  it('rejects a wrong bearer before lock or domain writes', async () => {
    const h = bindingHarness()
    const { preview } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })

    await expect(h.service.confirm(context, confirmInput(preview.bindingBatchId as string, 'wrong-token'))).rejects.toMatchObject({
      code: 'CATALOG_BINDING_PREVIEW_TOKEN_INVALID',
      statusCode: 403,
    })
    expect(h.dependencies.acquireMutationLockTx).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
  })

  it('rejects expiry before lock and never reserves the idempotency key', async () => {
    const h = bindingHarness()
    const { preview } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    h.dependencies.now.mockReturnValue(new Date(NOW.getTime() + 31 * 60 * 1_000))

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string)),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_PREVIEW_EXPIRED' })
    expect(h.dependencies.acquireMutationLockTx).not.toHaveBeenCalled()
    expect(h.tx.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
  })

  it.each(['schemaVersion', 'requestHashVersion'] as const)('rejects unsupported %s before acquiring the lock', async versionField => {
    const h = bindingHarness()
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    h.tx.catalogBindingBatch.findFirst.mockResolvedValue({ ...storedBatch, [versionField]: 2 })

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string)),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_STAGING_INVALID' })
    expect(h.dependencies.acquireMutationLockTx).not.toHaveBeenCalled()
    expect(h.tx.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
    expect(h.tx.product.create).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
    expect(h.dependencies.writeCatalogAudit).not.toHaveBeenCalled()
  })

  it('revalidates live access after the org lock and binds idempotency createdAt to the checked instant', async () => {
    const h = bindingHarness()
    const { preview } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    h.dependencies.assertLiveAccessTx.mockClear()
    h.dependencies.acquireMutationLockTx.mockClear()

    await h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-lock-order'))

    expect(h.dependencies.assertLiveAccessTx).toHaveBeenCalledTimes(2)
    expect(h.dependencies.acquireMutationLockTx).toHaveBeenCalledTimes(1)
    const accessOrder = h.dependencies.assertLiveAccessTx.mock.invocationCallOrder
    const lockOrder = h.dependencies.acquireMutationLockTx.mock.invocationCallOrder[0] as number
    expect(accessOrder[0]).toBeLessThan(lockOrder)
    expect(lockOrder).toBeLessThan(accessOrder[1] as number)
    expect(h.tx.catalogIdempotencyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: 'CATALOG_BINDING',
        state: 'APPLYING',
        actorType: 'HUMAN',
        staffId: 'staff-1',
        createdAt: NOW,
        heartbeatAt: NOW,
      }),
    })
  })

  it('fails stale when CatalogItem revision changes after preview and before any write', async () => {
    const tx = bindingTransaction()
    const h = bindingHarness(tx)
    const { preview } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    tx.catalogItem.findFirst.mockResolvedValue(catalogItem({ revision: 8 }))

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string)),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_STALE' })
    expect(tx.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
    expect(tx.catalogVenueBinding.create).not.toHaveBeenCalled()
  })

  it('fails stale when a cross-field SKU reservation appears while confirm waits for the org lock', async () => {
    const tx = bindingTransaction()
    tx.product.findMany.mockResolvedValue([])
    const h = bindingHarness(tx)
    const { preview } = await stageConfirmablePreview(h, {
      decision: 'CREATE',
      create: { categoryId: 'category-1', localSku: 'local-new', initialPrice: '20.00' },
    })
    tx.product.findMany
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([product({ id: 'reservation-new', sku: 'OTHER', gtin: 'LOCAL-NEW', deletedAt: NOW })])

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string)),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_STALE' })
    expect(tx.product.create).not.toHaveBeenCalled()
    expect(tx.catalogVenueBinding.create).not.toHaveBeenCalled()
  })

  it('confirms CREATE with more than 100 valid Task 5 purchase currencies', async () => {
    const tx = bindingTransaction()
    tx.product.findMany.mockResolvedValue([])
    const currencies = [
      'MXN',
      ...`AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MYR MZN NAD NGN NIO NOK NPR NZD`.split(
        ' ',
      ),
    ].slice(0, 101)
    const basePrice = catalogItem().prices[0]
    tx.catalogItem.findFirst.mockResolvedValue(
      catalogItem({ prices: currencies.map((currency, index) => ({ ...basePrice, id: `cost-${index}`, currency })) }),
    )
    const h = bindingHarness(tx)
    const { preview } = await stageConfirmablePreview(h, {
      decision: 'CREATE',
      create: { categoryId: 'category-1', localSku: 'many-currencies', initialPrice: '20.00' },
    })

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-many-currencies')),
    ).resolves.toMatchObject({ state: 'APPLIED', lines: [{ decision: 'CREATE', status: 'APPLIED' }] })
    expect(currencies).toHaveLength(101)
    expect(tx.product.create).toHaveBeenCalledTimes(1)
  })

  it('confirms the Task 5 CatalogItem text shape without inventing a recovery-only 4096 limit', async () => {
    const tx = bindingTransaction()
    tx.product.findMany.mockResolvedValue([])
    tx.catalogItem.findFirst.mockResolvedValue(catalogItem({ description: 'x'.repeat(4097) }))
    const h = bindingHarness(tx)
    const { preview } = await stageConfirmablePreview(h, {
      decision: 'CREATE',
      create: { categoryId: 'category-1', localSku: 'long-corporate-text', initialPrice: '20.00' },
    })

    await expect(
      h.service.confirm(
        context,
        confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-long-corporate-text'),
      ),
    ).resolves.toMatchObject({ state: 'APPLIED', lines: [{ decision: 'CREATE', status: 'APPLIED' }] })
    expect(tx.product.create).toHaveBeenCalledTimes(1)
  })

  it('returns the same relational APPLIED result without repeating writes or audit', async () => {
    const h = bindingHarness()
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    const { result } = configureAppliedLinkReplay(h, storedBatch, 'binding-replay-key')

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-replay-key')),
    ).resolves.toEqual(result)
    expect(h.tx.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
    expect(h.dependencies.writeCatalogAudit).not.toHaveBeenCalled()
  })

  it('rejects an APPLIED batch when the idempotency key does not own its resource', async () => {
    const h = bindingHarness()
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    configureAppliedLinkReplay(h, storedBatch, 'binding-original-key')
    h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue(null)

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-other-key')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
  })

  it('maps a lost PREVIEWED CAS to stable in-progress and leaves domain writes unaudited', async () => {
    const h = bindingHarness()
    const { preview } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    h.tx.catalogBindingBatch.updateMany.mockResolvedValueOnce({ count: 0 })

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string)),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_IN_PROGRESS' })
    expect(h.tx.product.create).not.toHaveBeenCalled()
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
    expect(h.dependencies.writeCatalogAudit).not.toHaveBeenCalled()
  })

  it('recovers the same batch/key winner after the first SERIALIZABLE transaction aborts with P2034', async () => {
    const h = bindingHarness()
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    const { result } = configureAppliedLinkReplay(h, storedBatch, 'binding-p2034-replay')
    h.prisma.$transaction
      .mockReset()
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce(async (callback: (client: typeof h.tx) => unknown) => callback(h.tx))

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-p2034-replay')),
    ).resolves.toEqual(result)
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
    expect(h.dependencies.writeCatalogAudit).not.toHaveBeenCalled()
  })

  it('does not recover a P2034 winner through a different idempotency key', async () => {
    const h = bindingHarness()
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    configureAppliedLinkReplay(h, storedBatch, 'binding-p2034-owner')
    h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue(null)
    h.prisma.$transaction
      .mockReset()
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce(async (callback: (client: typeof h.tx) => unknown) => callback(h.tx))

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-p2034-other')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
  })

  it('rejects an idempotency P2002 whose durable key belongs to another batch', async () => {
    const h = bindingHarness()
    const { preview } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue({
      organizationId: 'org-1',
      operation: 'CATALOG_BINDING',
      idempotencyKey: 'binding-cross-batch-key',
      resourceType: 'CatalogBindingBatch',
      resourceId: 'batch-other',
      requestHash: 'request-other',
      state: 'APPLIED',
    })
    h.prisma.$transaction
      .mockReset()
      .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['organizationId', 'operation', 'idempotencyKey'] } })
      .mockImplementationOnce(async (callback: (client: typeof h.tx) => unknown) => callback(h.tx))

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-cross-batch-key')),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(h.tx.catalogIdempotencyRecord.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', operation: 'CATALOG_BINDING', idempotencyKey: 'binding-cross-batch-key' },
    })
  })

  it('rejects forged prepared readiness even when batch and record reflect the same JSON', async () => {
    const tx = bindingTransaction()
    tx.catalogItem.findFirst.mockResolvedValue(
      catalogItem({ kind: CatalogItemKind.PREPARED_DISH, productType: ProductType.FOOD_AND_BEV, prices: [] }),
    )
    tx.recipe.findFirst.mockResolvedValue(preparedRecipe())
    const h = bindingHarness(tx)
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    const rows = configureAppliedLinkReplay(h, storedBatch, 'binding-forged-readiness-fields')
    const result = {
      ...rows.result,
      lines: [
        {
          ...rows.result.lines[0],
          readiness: {
            state: 'READY',
            findings: [{ code: 'MISSING_RECIPE', secret: 'reflected' }],
            dependencies: {
              bindingId: 'binding-1',
              bindingRevision: 999,
              catalogItemId: 'item-1',
              catalogItemRevision: 999,
              productId: 'product-1',
              recipeId: 'recipe-forged',
              recipeUpdatedAt: { injected: true },
              recipeLineHash: 'not-a-hash',
            },
          },
        },
      ],
    }
    h.tx.catalogBindingBatch.findFirst.mockResolvedValue({ ...rows.appliedBatch, result })
    h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue({ ...rows.record, result })

    await expect(
      h.service.confirm(
        context,
        confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-forged-readiness-fields'),
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_BINDING_RESULT_INVALID' })
  })

  it('replays prepared APPLIED readiness after later publication advances live revisions', async () => {
    const tx = bindingTransaction()
    tx.catalogItem.findFirst.mockResolvedValue(
      catalogItem({ kind: CatalogItemKind.PREPARED_DISH, productType: ProductType.FOOD_AND_BEV, prices: [] }),
    )
    tx.recipe.findFirst.mockResolvedValue(preparedRecipe())
    const h = bindingHarness(tx)
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    const rows = configureAppliedLinkReplay(h, storedBatch, 'binding-historical-readiness')
    const capturedRecipe = storedBatch.dependencies.lines[0].readinessDependency
    const result = {
      ...rows.result,
      lines: [
        {
          ...rows.result.lines[0],
          readiness: {
            state: 'READY',
            findings: [],
            dependencies: {
              bindingId: 'binding-1',
              bindingRevision: 1,
              catalogItemId: 'item-1',
              catalogItemRevision: 7,
              productId: 'product-1',
              recipeId: capturedRecipe.recipeId,
              recipeUpdatedAt: capturedRecipe.recipeUpdatedAt,
              recipeLineHash: capturedRecipe.recipeLineHash,
            },
            costs: { batchCost: '62.5000', costPerPortion: '7.8125', storedCostPerPortion: '62.5000' },
          },
        },
      ],
    }
    h.tx.catalogBindingBatch.findFirst.mockResolvedValue({ ...rows.appliedBatch, result })
    h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue({ ...rows.record, result })
    h.tx.catalogVenueBinding.findFirst.mockResolvedValue({
      id: 'binding-1',
      revision: 2,
      productId: 'product-1',
      product: { id: 'product-1', venueId: 'venue-1' },
      catalogItem: { id: 'item-1', revision: 8 },
    })

    await expect(
      h.service.confirm(
        context,
        confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-historical-readiness'),
      ),
    ).resolves.toEqual(result)
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
    expect(h.dependencies.writeCatalogAudit).not.toHaveBeenCalled()
  })

  it('replays a raw GTIN LINK candidate whose preserved legacy Product text is empty', async () => {
    const tx = bindingTransaction()
    tx.product.findMany.mockResolvedValue([product({ sku: '', gtin: 'Corp-SKU', description: '', imageUrl: '' })])
    const h = bindingHarness(tx)
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'LINK', productId: 'product-1' })
    const rows = configureAppliedLinkReplay(h, storedBatch, 'binding-legacy-empty-text')

    await expect(
      h.service.confirm(
        context,
        confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-legacy-empty-text'),
      ),
    ).resolves.toEqual(rows.result)
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
  })

  it('replays SKIP when the captured existing binding was PENDING with no Product', async () => {
    const tx = bindingTransaction()
    tx.catalogVenueBinding.findFirst.mockResolvedValue({
      id: 'binding-pending',
      productId: null,
      revision: 1,
      status: 'PENDING',
      updatedAt: NOW,
    })
    const h = bindingHarness(tx)
    const { preview, storedBatch } = await stageConfirmablePreview(h, { decision: 'SKIP' })
    const result = {
      bindingBatchId: storedBatch.id,
      state: 'APPLIED',
      lines: [
        {
          catalogItemId: 'item-1',
          venueId: 'venue-1',
          decision: 'SKIP',
          status: 'SKIPPED',
          productId: null,
          bindingId: null,
          readiness: null,
        },
      ],
    }
    h.tx.catalogBindingBatch.findFirst.mockResolvedValue({ ...storedBatch, state: 'APPLIED', result })
    h.tx.catalogBindingLine.findMany.mockResolvedValue([
      {
        id: 'line-1',
        catalogItemId: 'item-1',
        venueId: 'venue-1',
        decision: 'SKIP',
        proposal: 'SKIP',
        status: 'SKIPPED',
        productId: null,
        after: { decision: 'SKIP', status: 'SKIPPED' },
      },
    ])
    h.tx.catalogIdempotencyRecord.findFirst.mockResolvedValue({
      organizationId: 'org-1',
      operation: 'CATALOG_BINDING',
      idempotencyKey: 'binding-skip-pending',
      requestHash: storedBatch.requestHash,
      requestHashVersion: 1,
      targetHash: storedBatch.targetHash,
      dependencies: storedBatch.dependencies,
      resourceType: 'CatalogBindingBatch',
      resourceId: storedBatch.id,
      actorType: 'HUMAN',
      staffId: 'staff-1',
      state: 'APPLIED',
      result,
    })

    await expect(
      h.service.confirm(context, confirmInput(preview.bindingBatchId as string, preview.previewToken as string, 'binding-skip-pending')),
    ).resolves.toEqual(result)
    expect(h.tx.catalogVenueBinding.create).not.toHaveBeenCalled()
  })

  it('recognizes only exact idempotency constraint metadata across Prisma driver shapes', () => {
    expect(
      isCatalogBindingIdempotencyUniqueConflict({
        code: 'P2002',
        meta: { constraint: 'CatalogIdempotencyRecord_organizationId_operation_idemp_key' },
      }),
    ).toBe(true)
    expect(isCatalogBindingIdempotencyUniqueConflict({ code: 'P2002', meta: { constraint: 'ActivityLog_unrelated_key' } })).toBe(false)
  })
})
