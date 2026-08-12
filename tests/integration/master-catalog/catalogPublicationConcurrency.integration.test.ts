/** Prepared PostgreSQL proof for confirm serialization and single apply. */
import type { CatalogCommandContext } from '@/types/master-catalog'
import {
  assertDisposableCatalogPublicationDatabase,
  cleanupCatalogPublicationFixture,
  createCatalogPublicationFixture,
  createCatalogPublicationIntegrationHarness,
  type CatalogPublicationFixture,
  type CatalogPublicationIntegrationHarness,
} from './catalogPublicationIntegrationHarness'

jest.unmock('@/utils/prismaClient')
jest.unmock('@/services/master-catalog/catalogAudit.service')
jest.setTimeout(60_000)

let harness: CatalogPublicationIntegrationHarness | null = null
let fixture: CatalogPublicationFixture | null = null
let createCatalogPublicationPreviewService: typeof import('@/services/master-catalog/catalogPublicationPreview.service').createCatalogPublicationPreviewService
let createCatalogPublicationConfirmationService: typeof import('@/services/master-catalog/catalogPublicationConfirmation.service').createCatalogPublicationConfirmationService
let acquireAttemptLock: typeof import('@/services/master-catalog/catalogPublicationConfirmation.service').acquireCatalogPublicationAttemptLockTx

function h(): CatalogPublicationIntegrationHarness {
  if (!harness) throw new Error('Concurrency harness was not initialized')
  return harness
}

function f(): CatalogPublicationFixture {
  if (!fixture) throw new Error('Concurrency fixture was not initialized')
  return fixture
}

function context(): CatalogCommandContext {
  return {
    organizationId: f().organizationId,
    actor: { type: 'HUMAN', staffId: f().staffId, impersonating: false },
    orgRole: 'OWNER',
  }
}

beforeAll(async () => {
  assertDisposableCatalogPublicationDatabase()
  harness = await createCatalogPublicationIntegrationHarness('confirm-race')
  fixture = await createCatalogPublicationFixture(h().primary, 'confirm-race')
  ;({ createCatalogPublicationPreviewService } = await import('@/services/master-catalog/catalogPublicationPreview.service'))
  ;({ createCatalogPublicationConfirmationService, acquireCatalogPublicationAttemptLockTx: acquireAttemptLock } = await import(
    '@/services/master-catalog/catalogPublicationConfirmation.service'
  ))
})

afterAll(async () => {
  try {
    if (harness) await cleanupCatalogPublicationFixture(harness.primary, fixture)
  } finally {
    await harness?.disconnect()
  }
})

describe('CatalogPublication — real concurrent confirmation', () => {
  it('shows both waiters on the attempt advisory lock and commits Product/outbox exactly once', async () => {
    const key = `confirm-race-${f().key}`
    const previewService = createCatalogPublicationPreviewService({ prisma: h().primary as never })
    const preview = await previewService.preview(context(), {
      operation: 'CATALOG_FIELDS_PUBLISH',
      idempotencyKey: key,
      targets: [{ catalogItemId: f().catalogItemId, venueId: f().venueId, productId: f().productId }],
    })
    const confirmInput = {
      publicationBatchId: preview.publicationBatchId,
      previewToken: preview.previewToken,
      idempotencyKey: key,
      confirm: true as const,
    }
    const confirmationOne = createCatalogPublicationConfirmationService({ prisma: h().writerOne as never })
    const confirmationTwo = createCatalogPublicationConfirmationService({ prisma: h().writerTwo as never })
    let held!: () => void
    let release!: () => void
    const isHeld = new Promise<void>(resolve => (held = resolve))
    const released = new Promise<void>(resolve => (release = resolve))
    const blocker = h().blocker.$transaction(async tx => {
      await acquireAttemptLock(tx, f().organizationId, preview.publicationBatchId)
      held()
      await released
    })
    await isHeld

    const confirms = [confirmationOne.confirm(context(), confirmInput), confirmationTwo.confirm(context(), confirmInput)]
    try {
      // WHY: Both named application pools must be visible as advisory waiters;
      // Promise overlap without server wait evidence is not concurrency proof.
      await h().waitForLockWaiter(h().names.writerOne, 'advisory')
      await h().waitForLockWaiter(h().names.writerTwo, 'advisory')
    } finally {
      release()
      await blocker
    }
    const results = await Promise.all(confirms)
    expect(results.map(result => result.state).sort()).toEqual(['APPLIED', 'IN_PROGRESS'])

    const [batch, record, product, lines, outbox] = await Promise.all([
      h().primary.catalogPublicationBatch.findUniqueOrThrow({ where: { id: preview.publicationBatchId } }),
      h().primary.catalogIdempotencyRecord.findUniqueOrThrow({
        where: {
          organizationId_operation_idempotencyKey: {
            organizationId: f().organizationId,
            operation: 'CATALOG_FIELDS_PUBLISH',
            idempotencyKey: key,
          },
        },
      }),
      h().primary.product.findUniqueOrThrow({ where: { id: f().productId } }),
      h().primary.catalogPublicationLine.findMany({ where: { batchId: preview.publicationBatchId }, include: { decisions: true } }),
      h().primary.catalogPublicationOutbox.findMany({ where: { batchId: preview.publicationBatchId } }),
    ])
    expect(batch).toMatchObject({ state: 'APPLIED', attemptId: null, leaseExpiresAt: null })
    expect(record.result).toEqual(batch.result)
    expect(product.name).toBe('Corporate name')
    expect(lines).toHaveLength(1)
    expect(lines[0].decisions).toHaveLength(lines[0].fieldMask.length)
    expect(outbox).toHaveLength(1)
  })

  it('rejects catalog authority drift after preview before any Product write', async () => {
    const isolated = await createCatalogPublicationFixture(h().primary, 'confirm-drift')
    try {
      const driftContext: CatalogCommandContext = {
        organizationId: isolated.organizationId,
        actor: { type: 'HUMAN', staffId: isolated.staffId, impersonating: false },
        orgRole: 'OWNER',
      }
      const key = `confirm-drift-${isolated.key}`
      const preview = await createCatalogPublicationPreviewService({ prisma: h().primary as never }).preview(driftContext, {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: key,
        targets: [{ catalogItemId: isolated.catalogItemId, venueId: isolated.venueId, productId: isolated.productId }],
      })
      await h().primary.catalogItem.update({
        where: { id: isolated.catalogItemId },
        data: { revision: { increment: 1 }, updatedById: isolated.staffId },
      })

      await expect(
        createCatalogPublicationConfirmationService({ prisma: h().writerOne as never }).confirm(driftContext, {
          publicationBatchId: preview.publicationBatchId,
          previewToken: preview.previewToken,
          idempotencyKey: key,
          confirm: true,
        }),
      ).rejects.toMatchObject({ statusCode: 409 })
      await expect(
        h().primary.product.findUniqueOrThrow({
          where: { id: isolated.productId },
          select: { name: true },
        }),
      ).resolves.toEqual({ name: 'Local name' })
    } finally {
      await cleanupCatalogPublicationFixture(h().primary, isolated)
    }
  })
})
