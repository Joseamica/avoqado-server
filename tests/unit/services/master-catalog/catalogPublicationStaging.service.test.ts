import { createCatalogPublicationStagingService } from '@/services/master-catalog/catalogPublicationStaging.service'

const context = {
  organizationId: 'org-1',
  actor: { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false },
}

function harness() {
  const tx = {
    catalogPublicationBatch: { create: jest.fn().mockResolvedValue({ id: 'batch-1' }) },
    catalogIdempotencyRecord: { create: jest.fn().mockResolvedValue({ id: 'record-1' }) },
    catalogPublicationLine: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  }
  const prisma = { $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) }
  const service = createCatalogPublicationStagingService({
    prisma: prisma as never,
    now: () => new Date('2026-08-09T12:00:00.000Z'),
    randomToken: () => 'raw-token',
    randomId: jest.fn().mockReturnValueOnce('batch-1').mockReturnValueOnce('record-1').mockReturnValue('line-1'),
  })
  return { tx, prisma, service }
}

describe('catalogPublicationStaging.service', () => {
  it.each([
    ['CATALOG_FIELDS_PUBLISH', ['name'], 'PUBLICATION'],
    ['CATALOG_PRODUCT_ACTIVATION', ['active'], 'PUBLICATION'],
    ['CATALOG_FIELDS_REVERSION', ['name'], 'REVERSION'],
  ] as const)('stages dual PREVIEWED authority and one nonterminal line for %s', async (operation, fieldMask, changeKind) => {
    const h = harness()

    const staged = await h.service.stage(context, {
      operation,
      idempotencyKey: `key-${operation}`,
      request: { operation, target: 'item-1' },
      prepare: jest.fn().mockResolvedValue({
        output: { canConfirm: true },
        targets: [
          {
            catalogItemId: 'item-1',
            venueId: 'venue-1',
            productId: 'product-1',
            bindingId: 'binding-1',
            sourceCatalogRevision: 7,
            sourceCatalogInvariantVersion: '12',
            bindingRevision: 4,
            dependencies: { projection: {}, decisions: [] },
            line: {
              status: 'READY',
              fieldMask: [...fieldMask],
              changeKind,
              canonicalTargetHash: 'a'.repeat(64),
              before: {},
              after: {},
            },
          },
        ],
      }),
    })

    expect(staged).toMatchObject({ publicationBatchId: 'batch-1', previewToken: 'raw-token', output: { canConfirm: true } })
    expect(h.tx.catalogPublicationBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ operation, state: 'PREVIEWED', schemaVersion: 1 }),
    })
    expect(h.tx.catalogIdempotencyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ operation, idempotencyKey: `key-${operation}`, resourceId: 'batch-1' }),
    })
    expect(h.tx.catalogPublicationLine.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ id: 'line-1', fieldMask: [...fieldMask], changeKind, status: 'READY' })],
    })
  })
})
