import {
  applyCatalogProductActivationTx,
  createCatalogProductActivationPreviewService,
  evaluateCatalogProductActivationAuthority,
  projectCatalogProductActivation,
} from '@/services/master-catalog/catalogPublicationActivation.service'

const context = {
  organizationId: 'org-1',
  actor: { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false },
}

function target(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    venueId: 'venue-1',
    catalogItemId: 'item-1',
    productId: 'product-1',
    bindingId: 'binding-1',
    itemStatus: 'ACTIVE',
    itemRevision: 7,
    itemInvariantVersion: '12',
    bindingRevision: 4,
    productActive: false,
    productDeletedAt: null,
    bindingStatus: 'LINKED',
    lastPublishedCatalogRevision: 7,
    managedHashVersion: 1,
    lastPublishedManagedHash: 'a'.repeat(64),
    publicationAuthorityValid: true,
    profileEvaluationValid: true,
    readiness: { state: 'READY', dependencies: { recipeLineHash: 'ready-hash' } },
    ...overrides,
  }
}

describe('catalogPublicationActivation.service', () => {
  it('rejects a SHA-shaped provenance hash that does not match the published managed snapshot', () => {
    expect(
      evaluateCatalogProductActivationAuthority({
        managedHashVersion: 1,
        managedFieldMask: ['name'],
        lastPublishedManagedSnapshot: { name: 'Corporate' },
        lastPublishedManagedHash: 'f'.repeat(64),
        projection: {
          fieldMask: ['name'],
          fields: [{ field: 'name', before: 'Corporate', proposed: 'Corporate', changed: false, diverged: false }],
        },
        approvedOverrides: [],
      } as never),
    ).toBe(false)
  })

  it('accepts a hash-valid published local value only with its exact current approved override', () => {
    const { hashCatalogManagedFieldsV1 } = jest.requireActual('@/services/master-catalog/catalogHash.service')
    const snapshot = { name: 'Local approved' }
    const hash = hashCatalogManagedFieldsV1({ hashVersion: 1, fieldMask: ['name'], values: snapshot }).hash
    const authority = {
      managedHashVersion: 1,
      managedFieldMask: ['name'],
      lastPublishedManagedSnapshot: snapshot,
      lastPublishedManagedHash: hash,
      projection: {
        fieldMask: ['name'],
        fields: [{ field: 'name', before: 'Local approved', proposed: 'Corporate', changed: true, diverged: false }],
      },
    }

    expect(evaluateCatalogProductActivationAuthority({ ...authority, approvedOverrides: [] } as never)).toBe(false)
    expect(
      evaluateCatalogProductActivationAuthority({
        ...authority,
        approvedOverrides: [{ field: 'name', localValue: 'Local approved', status: 'APPROVED' }],
      } as never),
    ).toBe(true)
  })

  it('stages activation through dual idempotent authority with an exact operation-only line', async () => {
    const tx = {
      catalogPublicationBatch: { create: jest.fn().mockResolvedValue({ id: 'batch-activation' }) },
      catalogIdempotencyRecord: { create: jest.fn().mockResolvedValue({ id: 'record-activation' }) },
      catalogPublicationLine: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      catalogPublicationFieldDecision: { createMany: jest.fn() },
    }
    const prisma = { $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) }
    const service = createCatalogProductActivationPreviewService({
      prisma: prisma as never,
      assertAccessTx: jest.fn().mockResolvedValue(undefined),
      revalidate: jest.fn().mockResolvedValue(target()),
      now: () => new Date('2026-08-09T12:00:00.000Z'),
      randomToken: () => 'activation-token',
      randomId: jest
        .fn()
        .mockReturnValueOnce('batch-activation')
        .mockReturnValueOnce('record-activation')
        .mockReturnValue('line-activation'),
    } as never)

    const preview = await service.preview(context, {
      operation: 'CATALOG_PRODUCT_ACTIVATION',
      idempotencyKey: 'activation-key',
      targets: [{ catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1' }],
    })

    expect(preview).toMatchObject({
      publicationBatchId: 'batch-activation',
      operation: 'CATALOG_PRODUCT_ACTIVATION',
      canConfirm: true,
      lines: [
        expect.objectContaining({
          fieldMask: ['active'],
          fields: [
            expect.objectContaining({
              field: 'active',
              before: false,
              proposed: true,
              after: true,
              decision: 'PUBLISH_CORPORATE',
            }),
          ],
        }),
      ],
    })
    expect(tx.catalogPublicationLine.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          fieldMask: ['active'],
          before: { active: false },
          after: { active: true },
          status: 'READY',
        }),
      ],
    })
    expect(tx.catalogPublicationFieldDecision.createMany).not.toHaveBeenCalled()
  })

  it('projects only active with a dedicated operation-namespaced hash', () => {
    const result = projectCatalogProductActivation(target() as never)

    expect(result).toMatchObject({
      fieldMask: ['active'],
      changeKind: 'PUBLICATION',
      before: { active: false },
      proposed: { active: true },
      after: { active: true },
    })
    expect(result.canonicalTargetHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.canonicalTargetHash).not.toBe(
      projectCatalogProductActivation(target({ productId: 'product-2' }) as never).canonicalTargetHash,
    )
  })

  it.each([
    ['retired item', { itemStatus: 'RETIRED' }],
    ['already active', { productActive: true }],
    ['deleted Product', { productDeletedAt: new Date() }],
    ['unlinked binding', { bindingStatus: 'UNLINKED' }],
    ['stale publication revision', { lastPublishedCatalogRevision: 6 }],
    ['missing managed provenance', { lastPublishedManagedHash: null }],
    ['local drift without exact approved overrides', { publicationAuthorityValid: false }],
    ['unsupported profile', { profileEvaluationValid: false }],
    ['stale Recipe dependency', { readiness: { state: 'STALE', dependencies: {} } }],
  ])('rejects activation when %s', (_label, overrides) => {
    expect(() => projectCatalogProductActivation(target(overrides) as never)).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'CATALOG_ACTIVATION_PREREQUISITE_FAILED' }),
    )
  })

  it('takes the shared fence and changes only Product.active plus operation line/audit/outbox', async () => {
    const tx = {
      product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      catalogPublicationLine: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      catalogPublicationFieldDecision: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      catalogVenueBinding: { update: jest.fn(), updateMany: jest.fn() },
    }
    const dependencies = {
      acquireFence: jest.fn().mockResolvedValue({
        id: 'venue-1',
        organizationId: 'org-1',
        catalogGovernanceEnforcedAt: new Date('2026-08-09T00:00:00.000Z'),
      }),
      revalidate: jest.fn().mockResolvedValue(target()),
      writeAudit: jest.fn().mockResolvedValue(undefined),
      enqueueOutbox: jest.fn().mockResolvedValue(undefined),
    }

    await expect(
      applyCatalogProductActivationTx(
        tx as never,
        {
          organizationId: 'org-1',
          venueId: 'venue-1',
          productId: 'product-1',
          catalogItemId: 'item-1',
          bindingId: 'binding-1',
          publicationBatchId: 'batch-1',
          lineId: 'line-1',
          expectedSourceCatalogRevision: 7,
          expectedSourceCatalogInvariantVersion: '12',
          expectedBindingRevision: 4,
          expectedCanonicalTargetHash: projectCatalogProductActivation(target() as never).canonicalTargetHash,
          expectedReadiness: target().readiness,
          actor: { type: 'HUMAN', staffId: 'staff-1', impersonating: false },
        },
        dependencies as never,
      ),
    ).resolves.toEqual({ lineId: 'line-1', catalogItemId: 'item-1', venueId: 'venue-1', productId: 'product-1', status: 'APPLIED' })

    expect(dependencies.acquireFence).toHaveBeenCalledWith(tx, { organizationId: 'org-1', venueId: 'venue-1' })
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: 'product-1', venueId: 'venue-1', active: false, deletedAt: null },
      data: { active: true },
    })
    expect(tx.catalogPublicationFieldDecision.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          organizationId: 'org-1',
          lineId: 'line-1',
          bindingId: 'binding-1',
          field: 'active',
          decision: 'PUBLISH_CORPORATE',
          before: false,
          proposed: true,
          after: true,
        }),
      ],
    })
    expect(tx.catalogPublicationFieldDecision.createMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.catalogPublicationLine.updateMany.mock.invocationCallOrder[0],
    )
    expect(tx.catalogVenueBinding.update).not.toHaveBeenCalled()
    expect(tx.catalogVenueBinding.updateMany).not.toHaveBeenCalled()
    expect(dependencies.writeAudit).toHaveBeenCalled()
    expect(dependencies.enqueueOutbox).toHaveBeenCalled()
  })

  it('revalidates publication authority before Product activation', async () => {
    const tx = {
      product: { updateMany: jest.fn() },
      catalogPublicationLine: { updateMany: jest.fn() },
      catalogPublicationFieldDecision: { createMany: jest.fn() },
    }
    const dependencies = {
      acquireFence: jest.fn().mockResolvedValue({ id: 'venue-1', organizationId: 'org-1', catalogGovernanceEnforcedAt: new Date() }),
      revalidate: jest.fn().mockResolvedValue(target({ publicationAuthorityValid: false })),
      writeAudit: jest.fn(),
      enqueueOutbox: jest.fn(),
    }

    await expect(
      applyCatalogProductActivationTx(
        tx as never,
        {
          organizationId: 'org-1',
          venueId: 'venue-1',
          productId: 'product-1',
          catalogItemId: 'item-1',
          bindingId: 'binding-1',
          publicationBatchId: 'batch-1',
          lineId: 'line-1',
          expectedSourceCatalogRevision: 7,
          expectedSourceCatalogInvariantVersion: '12',
          expectedBindingRevision: 4,
          expectedCanonicalTargetHash: projectCatalogProductActivation(target() as never).canonicalTargetHash,
          expectedReadiness: target().readiness,
          actor: { type: 'HUMAN', staffId: 'staff-1', impersonating: false },
        },
        dependencies as never,
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_ACTIVATION_PREREQUISITE_FAILED' })
    expect(tx.product.updateMany).not.toHaveBeenCalled()
    expect(tx.catalogPublicationFieldDecision.createMany).not.toHaveBeenCalled()
  })

  it('rejects live revision drift against the exact staged activation authority', async () => {
    const tx = {
      product: { updateMany: jest.fn() },
      catalogPublicationLine: { updateMany: jest.fn() },
      catalogPublicationFieldDecision: { createMany: jest.fn() },
    }
    const dependencies = {
      acquireFence: jest.fn().mockResolvedValue({ id: 'venue-1', organizationId: 'org-1', catalogGovernanceEnforcedAt: new Date() }),
      revalidate: jest.fn().mockResolvedValue(target()),
      writeAudit: jest.fn(),
      enqueueOutbox: jest.fn(),
    }

    await expect(
      applyCatalogProductActivationTx(
        tx as never,
        {
          organizationId: 'org-1',
          venueId: 'venue-1',
          productId: 'product-1',
          catalogItemId: 'item-1',
          bindingId: 'binding-1',
          publicationBatchId: 'batch-1',
          lineId: 'line-1',
          actor: context.actor,
          expectedSourceCatalogRevision: 999,
          expectedSourceCatalogInvariantVersion: '12',
          expectedBindingRevision: 4,
          expectedCanonicalTargetHash: projectCatalogProductActivation(target() as never).canonicalTargetHash,
          expectedReadiness: target().readiness,
        } as never,
        dependencies as never,
      ),
    ).rejects.toMatchObject({ code: 'STALE_PREVIEW' })
    expect(tx.product.updateMany).not.toHaveBeenCalled()
  })

  it('rejects forged staged readiness dependencies before Product activation', async () => {
    const tx = {
      product: { updateMany: jest.fn() },
      catalogPublicationLine: { updateMany: jest.fn() },
      catalogPublicationFieldDecision: { createMany: jest.fn() },
    }
    const dependencies = {
      acquireFence: jest.fn().mockResolvedValue({ id: 'venue-1', organizationId: 'org-1', catalogGovernanceEnforcedAt: new Date() }),
      revalidate: jest.fn().mockResolvedValue(target()),
      writeAudit: jest.fn(),
      enqueueOutbox: jest.fn(),
    }
    await expect(
      applyCatalogProductActivationTx(
        tx as never,
        {
          organizationId: 'org-1',
          venueId: 'venue-1',
          productId: 'product-1',
          catalogItemId: 'item-1',
          bindingId: 'binding-1',
          publicationBatchId: 'batch-1',
          lineId: 'line-1',
          actor: context.actor,
          expectedSourceCatalogRevision: 7,
          expectedSourceCatalogInvariantVersion: '12',
          expectedBindingRevision: 4,
          expectedCanonicalTargetHash: projectCatalogProductActivation(target() as never).canonicalTargetHash,
          expectedReadiness: { state: 'READY', dependencies: { forged: true } },
        },
        dependencies as never,
      ),
    ).rejects.toMatchObject({ code: 'STALE_PREVIEW' })
    expect(tx.product.updateMany).not.toHaveBeenCalled()
  })
})
