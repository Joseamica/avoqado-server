import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { createCatalogImportConfirmationService } from '@/services/master-catalog/catalogImportConfirmation.service'
import { getCatalogImportPreviewItemDetail, listCatalogImportPreviewPage } from '@/services/master-catalog/catalogImport.service'
import {
  calculateCatalogImportConfirmCapacityV1,
  markCatalogImportConfirmDeactivationOverflowV1,
} from '@/services/master-catalog/catalogImportCapacity.service'
import { persistCatalogImportPreviewTx } from '@/services/master-catalog/catalogImportStagingPersistence.service'
import type { CatalogImportBatchRowV1 } from '@/services/master-catalog/catalogImportStagedPayload.service'
import type { CatalogCommandContext } from '@/types/master-catalog'
import {
  context,
  durableJsonFixture,
  makeHarness,
  row,
  text,
  upload,
  validDurableReviewLines,
  validStagedPayload,
  validWorkbook,
} from './catalogImportTestHarness'

const token = 'capacity-preview-token'
const targetHash = 'b'.repeat(64)
const requestHash = 'a'.repeat(64)
const confirmInput = {
  importBatchId: 'capacity-batch',
  previewToken: token,
  confirm: true as const,
  idempotencyKey: 'capacity-key',
}

type DurableBatchFixtureV1 = Omit<CatalogImportBatchRowV1, 'dependencies'> & {
  dependencies: {
    schemaVersion: 1
    capacity: Prisma.JsonValue
    items: Prisma.JsonArray
    priceDependentItemIds: string[]
    organizationValues: Prisma.JsonArray
    references: Prisma.JsonArray
    mappings: Prisma.JsonArray
    profiles: Prisma.JsonArray
  }
}

function durableBatch(
  state: 'PREVIEWED' | 'FAILED',
  capacity: ReturnType<typeof calculateCatalogImportConfirmCapacityV1>,
): DurableBatchFixtureV1 {
  return {
    id: confirmInput.importBatchId,
    organizationId: context.organizationId,
    state,
    schemaVersion: 1,
    requestHash,
    requestHashVersion: 1,
    targetHash,
    previewTokenHash: createHash('sha256').update(token).digest('hex'),
    previewExpiresAt: new Date('2026-08-08T20:30:00.000Z'),
    dependencies: {
      schemaVersion: 1,
      capacity: durableJsonFixture(capacity),
      items: [],
      priceDependentItemIds: [],
      organizationValues: [],
      references: [],
      mappings: [],
      profiles: [],
    },
    staffId: 'staff-owner',
    result: null,
    failureCode: state === 'FAILED' ? 'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED' : null,
    failureMessage: state === 'FAILED' ? 'La importación excede el límite V1.' : null,
    completedAt: state === 'FAILED' ? new Date('2026-08-08T20:00:00.000Z') : null,
    createdAt: new Date('2026-08-08T19:00:00.000Z'),
    updatedAt: new Date('2026-08-08T19:00:00.000Z'),
  }
}

function confirmationHarness(lines: unknown[], batch: ReturnType<typeof durableBatch>) {
  const tx = {
    catalogImportBatch: { findFirst: jest.fn().mockResolvedValue(batch), updateMany: jest.fn() },
    catalogImportLine: { findMany: jest.fn().mockResolvedValue(lines), updateMany: jest.fn() },
    catalogIdempotencyRecord: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  }
  const acquireMutationLockTx = jest.fn()
  const applyCatalogItemAggregateTx = jest.fn()
  const service = createCatalogImportConfirmationService({
    prisma: { $transaction: jest.fn(async work => work(tx)) } as never,
    assertLiveAccessTx: jest.fn(),
    acquireMutationLockTx,
    revalidateDependenciesTx: jest.fn(),
    canonicalizeRows: jest.fn().mockResolvedValue({ hash: targetHash }),
    applyCatalogReferenceProposalsTx: jest.fn(),
    applyCatalogItemAggregateTx,
    writeCatalogAudit: jest.fn(),
    now: () => new Date('2026-08-08T20:00:00.000Z'),
    randomAttemptId: () => 'attempt-capacity',
  })
  return { service, tx, acquireMutationLockTx, applyCatalogItemAggregateTx }
}

describe('catalog import capacity integration', () => {
  it('exposes bounded review reads through the catalog-import facade', () => {
    expect(typeof listCatalogImportPreviewPage).toBe('function')
    expect(typeof getCatalogImportPreviewItemDetail).toBe('function')
  })

  it('stages a full over-limit workbook as FAILED lower-bound without a bearer or partial writes', async () => {
    const workbook = validWorkbook()
    const itemTemplate = workbook.sheets.Items.rows[0]!.values
    const itemCount = 1_197
    workbook.sheets.Items.rows = Array.from({ length: itemCount }, (_, index) =>
      row(index + 2, { ...itemTemplate, corporate_sku: text(`SKU-${index}`) }),
    )
    workbook.sheets.OrganizationValues.rows = Array.from({ length: itemCount }, (_, index) => [
      row(index * 2 + 2, {
        corporate_sku: text(`SKU-${index}`),
        value_type: text('SALE_PRICE'),
        amount: { kind: 'NUMBER' as const, value: '10.00' },
        currency: text('MXN'),
        expected_rule_revision: { kind: 'BLANK' as const, value: '' },
      }),
      row(index * 2 + 3, {
        corporate_sku: text(`SKU-${index}`),
        value_type: text('PURCHASE_COST'),
        amount: { kind: 'NUMBER' as const, value: '5.00' },
        currency: text('MXN'),
        expected_rule_revision: { kind: 'BLANK' as const, value: '' },
      }),
    ]).flat()
    workbook.sheets.BusinessTypes.rows = Array.from({ length: itemCount }, (_, index) =>
      row(index + 2, { corporate_sku: text(`SKU-${index}`), business_type: text('RETAIL_STORE') }),
    )
    const harness = makeHarness(workbook)

    const result = await harness.service.preview(context, upload)

    expect(result).toMatchObject({
      canConfirm: false,
      previewToken: null,
      capacity: { measurement: 'LOWER_BOUND', workUnits: 12_001, withinLimit: false },
      blockingReasons: [expect.objectContaining({ code: 'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED' })],
    })
    expect(harness.tx.catalogImportBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'FAILED',
          failureCode: 'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED',
          completedAt: new Date('2026-08-08T20:00:00.000Z'),
        }),
      }),
    )
    expect(harness.tx.catalogImportLine.createMany.mock.calls.flatMap(call => call[0].data)).toHaveLength(itemCount * 4)
    expect(harness.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
  }, 20_000)

  it('rejects a 50,001-line durable envelope before creating a batch or inserting any chunk', async () => {
    const lowerBound = markCatalogImportConfirmDeactivationOverflowV1(calculateCatalogImportConfirmCapacityV1([]))
    const line = {
      sourceSheet: 'Items',
      sourceRow: 2,
      status: 'READY',
      payload: validStagedPayload(),
      errors: [],
      catalogItemId: null,
    }
    const tx = {
      catalogImportBatch: { create: jest.fn() },
      catalogImportLine: { createMany: jest.fn() },
    }

    await expect(
      persistCatalogImportPreviewTx(tx as never, {
        organizationId: context.organizationId,
        staffId: 'staff-owner',
        fileSha256: 'd'.repeat(64),
        requestHash,
        targetHash,
        previewToken: token,
        expiresAt: new Date('2026-08-08T20:30:00.000Z'),
        now: new Date('2026-08-08T20:00:00.000Z'),
        dependencies: {
          schemaVersion: 1,
          capacity: lowerBound,
          items: [],
          priceDependentItemIds: [],
          organizationValues: [],
          references: [],
          mappings: [],
          profiles: [],
        },
        staged: Array(50_001).fill(line),
        errors: [],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_IMPORT_STAGING_INVALID' })
    expect(tx.catalogImportBatch.create).not.toHaveBeenCalled()
    expect(tx.catalogImportLine.createMany).not.toHaveBeenCalled()
  })

  it('returns stable 413 for a durable FAILED overflow before checking an absent bearer', async () => {
    const lowerBound = markCatalogImportConfirmDeactivationOverflowV1(calculateCatalogImportConfirmCapacityV1([]))
    const harness = confirmationHarness([], durableBatch('FAILED', lowerBound))

    await expect(harness.service.confirm(context, { ...confirmInput, previewToken: 'not-issued' })).rejects.toMatchObject({
      statusCode: 413,
      code: 'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED',
    })
    expect(harness.tx.catalogImportLine.findMany).not.toHaveBeenCalled()
    expect(harness.acquireMutationLockTx).not.toHaveBeenCalled()
  })

  it('recomputes an over-limit command set cooperatively before lock, idempotency, or Task 5', async () => {
    const payloads = Array.from({ length: 1_995 }, (_, index) => ({
      schemaVersion: 1,
      command: { operation: 'RETIRE', input: { catalogItemId: `item-${index}`, expectedRevision: 1 } },
      referenceProposals: [],
      venueBindingRequests: [],
    }))
    const lines = payloads.map((payload, index) => ({
      id: `line-${index}`,
      status: 'READY',
      sourceSheet: 'Items',
      sourceRow: index + 2,
      payload,
      errors: null,
      catalogItemId: `item-${index}`,
    }))
    const captured = calculateCatalogImportConfirmCapacityV1([])
    const harness = confirmationHarness(lines, durableBatch('PREVIEWED', captured))

    await expect(harness.service.confirm(context as CatalogCommandContext, confirmInput)).rejects.toMatchObject({
      statusCode: 413,
      code: 'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED',
    })
    expect(harness.acquireMutationLockTx).not.toHaveBeenCalled()
    expect(harness.tx.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
    expect(harness.applyCatalogItemAggregateTx).not.toHaveBeenCalled()
  }, 20_000)

  it('rejects an exact captured capacity that does not match the hash-bound commands', async () => {
    const line = {
      id: 'item-line',
      status: 'READY',
      sourceSheet: 'Items',
      sourceRow: 2,
      payload: validStagedPayload(),
      errors: null,
      catalogItemId: null,
    }
    const captured = calculateCatalogImportConfirmCapacityV1([])
    const harness = confirmationHarness([line, ...validDurableReviewLines()], durableBatch('PREVIEWED', captured))

    await expect(harness.service.confirm(context, confirmInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_STAGING_INVALID',
    })
    expect(harness.acquireMutationLockTx).not.toHaveBeenCalled()
    expect(harness.tx.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
  })

  it('rejects SQL-like capacity coercions in durable JSON before line reads or locks', async () => {
    const exact = calculateCatalogImportConfirmCapacityV1([])
    const batch = durableBatch('PREVIEWED', exact)
    batch.dependencies.capacity = { ...exact, schemaVersion: '1', withinLimit: 'true' }
    const harness = confirmationHarness([], batch)

    await expect(harness.service.confirm(context, confirmInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_STAGING_INVALID',
    })
    expect(harness.tx.catalogImportLine.findMany).not.toHaveBeenCalled()
    expect(harness.acquireMutationLockTx).not.toHaveBeenCalled()
    expect(harness.tx.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
  })

  it('binds the explicit UPDATE price dependency set to the staged operations before locking', async () => {
    const payload = validStagedPayload()
    const line = {
      id: 'item-line',
      status: 'READY',
      sourceSheet: 'Items',
      sourceRow: 2,
      payload,
      errors: null,
      catalogItemId: null,
    }
    const captured = calculateCatalogImportConfirmCapacityV1([payload])
    const batch = durableBatch('PREVIEWED', captured)
    batch.dependencies.priceDependentItemIds = ['forged-update-item']
    const harness = confirmationHarness([line, ...validDurableReviewLines()], batch)

    await expect(harness.service.confirm(context, confirmInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATALOG_IMPORT_STAGING_INVALID',
    })
    expect(harness.acquireMutationLockTx).not.toHaveBeenCalled()
    expect(harness.tx.catalogIdempotencyRecord.create).not.toHaveBeenCalled()
  })
})
