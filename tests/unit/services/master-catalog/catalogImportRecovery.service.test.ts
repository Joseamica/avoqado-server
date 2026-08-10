import {
  isCatalogImportIdempotencyUniqueConflict,
  recoverCatalogImportAppliedTx,
} from '@/services/master-catalog/catalogImportRecovery.service'
import { calculateCatalogImportConfirmCapacityV1 } from '@/services/master-catalog/catalogImportCapacity.service'
import type { CatalogCommandContext } from '@/types/master-catalog'

const context: CatalogCommandContext = {
  organizationId: 'org-pits',
  actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
  orgRole: 'OWNER',
}
const input = {
  importBatchId: 'batch-1',
  previewToken: 'token',
  confirm: true as const,
  idempotencyKey: 'key-1',
}
const result = { importBatchId: 'batch-1', state: 'APPLIED', appliedItemIds: ['item-1', 'item-2'] }
const capacity = calculateCatalogImportConfirmCapacityV1([])
const dependencies = {
  schemaVersion: 1,
  capacity,
  items: [],
  priceDependentItemIds: [],
  organizationValues: [],
  references: [],
  mappings: [],
  profiles: [],
}

function recoveryTx() {
  return {
    catalogIdempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue({
        organizationId: context.organizationId,
        operation: 'CATALOG_IMPORT',
        idempotencyKey: input.idempotencyKey,
        requestHash: 'a'.repeat(64),
        targetHash: 'b'.repeat(64),
        state: 'APPLIED',
        resourceType: 'CatalogImportBatch',
        resourceId: 'batch-1',
        dependencies,
        result,
      }),
    },
    catalogImportBatch: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'batch-1',
        organizationId: context.organizationId,
        state: 'APPLIED',
        schemaVersion: 1,
        requestHash: 'a'.repeat(64),
        requestHashVersion: 1,
        targetHash: 'b'.repeat(64),
        previewTokenHash: 'c'.repeat(64),
        previewExpiresAt: new Date(),
        dependencies,
        staffId: 'staff-owner',
        result,
        createdAt: new Date('2026-08-08T19:00:00.000Z'),
        updatedAt: new Date('2026-08-08T20:00:00.000Z'),
      }),
    },
    catalogImportLine: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'line-1', status: 'APPLIED', catalogItemId: 'item-1', sourceSheet: 'Items', sourceRow: 2 },
        { id: 'line-2', status: 'APPLIED', catalogItemId: 'item-2', sourceSheet: 'Items', sourceRow: 3 },
      ]),
    },
  }
}

describe('catalog import APPLIED recovery authority', () => {
  it('returns only the exact dual result proven by ordered APPLIED lines', async () => {
    const tx = recoveryTx()
    await expect(recoverCatalogImportAppliedTx(tx as never, context, input, 'a'.repeat(64))).resolves.toEqual(result)
    expect(tx.catalogImportLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { batchId: 'batch-1', organizationId: context.organizationId, sourceSheet: 'Items' },
        orderBy: [{ sourceSheet: 'asc' }, { sourceRow: 'asc' }],
        take: 20_001,
      }),
    )
  })

  it('rejects a corrupt batch above the Items envelope without trusting its hydrated result', async () => {
    const tx = recoveryTx()
    const line = { id: 'line', status: 'APPLIED', catalogItemId: 'item', sourceSheet: 'Items', sourceRow: 2 }
    tx.catalogImportLine.findMany.mockResolvedValue(Array(20_001).fill(line))

    await expect(recoverCatalogImportAppliedTx(tx as never, context, input, 'a'.repeat(64))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_RESULT_INVALID',
    })
    expect(tx.catalogImportLine.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20_001 }))
  })

  it.each([
    ['empty', []],
    ['subset', ['item-1']],
    ['extra', ['item-1', 'item-2', 'item-3']],
  ])('rejects coherently corrupt %s record+batch results against line authority', async (_label, ids) => {
    const tx = recoveryTx()
    const corrupt = { ...result, appliedItemIds: ids }
    tx.catalogIdempotencyRecord.findUnique.mockResolvedValue({
      ...(await tx.catalogIdempotencyRecord.findUnique()),
      result: corrupt,
    })
    tx.catalogImportBatch.findFirst.mockResolvedValue({ ...(await tx.catalogImportBatch.findFirst()), result: corrupt })

    await expect(recoverCatalogImportAppliedTx(tx as never, context, input, 'a'.repeat(64))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_RESULT_INVALID',
    })
  })

  it('rejects extra durable result fields instead of re-exposing them in replay', async () => {
    const tx = recoveryTx()
    const leaked = { ...result, leaked: 'durable-secret' }
    tx.catalogIdempotencyRecord.findUnique.mockResolvedValue({
      ...(await tx.catalogIdempotencyRecord.findUnique()),
      result: leaked,
    })
    tx.catalogImportBatch.findFirst.mockResolvedValue({ ...(await tx.catalogImportBatch.findFirst()), result: leaked })

    await expect(recoverCatalogImportAppliedTx(tx as never, context, input, 'a'.repeat(64))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_RESULT_INVALID',
    })
  })

  it('rejects APPLIED replay when its durable exact capacity is missing or inconsistent', async () => {
    const missing = recoveryTx()
    missing.catalogImportBatch.findFirst.mockResolvedValue({
      ...(await missing.catalogImportBatch.findFirst()),
      dependencies: {},
    })
    await expect(recoverCatalogImportAppliedTx(missing as never, context, input, 'a'.repeat(64))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_RESULT_INVALID',
    })

    const overflow = recoveryTx()
    overflow.catalogImportBatch.findFirst.mockResolvedValue({
      ...(await overflow.catalogImportBatch.findFirst()),
      dependencies: {
        ...dependencies,
        capacity: {
          ...capacity,
          measurement: 'LOWER_BOUND',
          workUnits: 12_001,
          withinLimit: false,
          breakdown: { ...capacity.breakdown, createItems: 11_969 },
        },
      },
    })
    await expect(recoverCatalogImportAppliedTx(overflow as never, context, input, 'a'.repeat(64))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_RESULT_INVALID',
    })
  })

  it.each(['schemaVersion', 'items'] as const)('rejects replay when the complete dependency snapshot omits %s', async key => {
    const tx = recoveryTx()
    const { [key]: omitted, ...incomplete } = dependencies
    expect(omitted).toBeDefined()
    tx.catalogImportBatch.findFirst.mockResolvedValue({ ...(await tx.catalogImportBatch.findFirst()), dependencies: incomplete })
    tx.catalogIdempotencyRecord.findUnique.mockResolvedValue({
      ...(await tx.catalogIdempotencyRecord.findUnique()),
      dependencies: incomplete,
    })

    await expect(recoverCatalogImportAppliedTx(tx as never, context, input, 'a'.repeat(64))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_RESULT_INVALID',
    })
  })

  it('rejects two individually valid dependency snapshots that disagree', async () => {
    const tx = recoveryTx()
    tx.catalogIdempotencyRecord.findUnique.mockResolvedValue({
      ...(await tx.catalogIdempotencyRecord.findUnique()),
      dependencies: {
        ...dependencies,
        references: [{ type: 'BRAND', id: 'brand-injected', revision: 1 }],
      },
    })

    await expect(recoverCatalogImportAppliedTx(tx as never, context, input, 'a'.repeat(64))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_RESULT_INVALID',
    })
  })

  it('recovers only the exact idempotency unique constraint and never another P2002', () => {
    expect(
      isCatalogImportIdempotencyUniqueConflict(
        Object.assign(new Error('unique'), {
          code: 'P2002',
          meta: { target: 'CatalogIdempotencyRecord_organizationId_operation_idemp_key' },
        }),
      ),
    ).toBe(true)
    expect(
      isCatalogImportIdempotencyUniqueConflict(
        Object.assign(new Error('audit unique'), { code: 'P2002', meta: { target: 'ActivityLog_some_key' } }),
      ),
    ).toBe(false)
    expect(isCatalogImportIdempotencyUniqueConflict(Object.assign(new Error('unknown'), { code: 'P2002' }))).toBe(false)
  })
})
