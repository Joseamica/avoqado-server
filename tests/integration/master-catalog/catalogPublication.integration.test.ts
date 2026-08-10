/** Prepared real-PostgreSQL proof for publication staging and atomic apply. */
import type { PrismaClient } from '@prisma/client'
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
let previewCatalogFieldsPublication: typeof import('@/services/master-catalog/catalogPublicationPreview.service').previewCatalogFieldsPublication
let createCatalogPublicationPreviewService: typeof import('@/services/master-catalog/catalogPublicationPreview.service').createCatalogPublicationPreviewService
let confirmCatalogFieldsPublication: typeof import('@/services/master-catalog/catalogPublicationConfirmation.service').confirmCatalogFieldsPublication
let createCatalogPublicationConfirmationService: typeof import('@/services/master-catalog/catalogPublicationConfirmation.service').createCatalogPublicationConfirmationService
let getCatalogPublicationByIdempotencyKey: typeof import('@/services/master-catalog/catalogPublicationRecovery.service').getCatalogPublicationByIdempotencyKey

function db(): PrismaClient {
  if (!harness) throw new Error('Publication integration harness was not initialized')
  return harness.primary
}

function context(): CatalogCommandContext {
  if (!fixture) throw new Error('Publication fixture was not initialized')
  return {
    organizationId: fixture.organizationId,
    actor: { type: 'HUMAN', staffId: fixture.staffId, impersonating: false },
    orgRole: 'OWNER',
  }
}

beforeAll(async () => {
  assertDisposableCatalogPublicationDatabase()
  harness = await createCatalogPublicationIntegrationHarness('apply')
  fixture = await createCatalogPublicationFixture(harness.primary, 'apply')
  // WHY: Service imports occur only after the exact URL guard and after every
  // independently named PostgreSQL pool has been constructed from that URL.
  ;({ previewCatalogFieldsPublication, createCatalogPublicationPreviewService } = await import(
    '@/services/master-catalog/catalogPublicationPreview.service'
  ))
  ;({ confirmCatalogFieldsPublication, createCatalogPublicationConfirmationService } = await import(
    '@/services/master-catalog/catalogPublicationConfirmation.service'
  ))
  ;({ getCatalogPublicationByIdempotencyKey } = await import('@/services/master-catalog/catalogPublicationRecovery.service'))
})

afterAll(async () => {
  try {
    if (harness) await cleanupCatalogPublicationFixture(harness.primary, fixture)
  } finally {
    await harness?.disconnect()
  }
})

describe('CatalogPublication — real preview/confirm/recovery', () => {
  it('stages without Product effects, then atomically applies Product, decisions, audit, outbox and dual result', async () => {
    const f = fixture as CatalogPublicationFixture
    const key = `publish-${f.key}`
    const preview = await previewCatalogFieldsPublication(context(), {
      operation: 'CATALOG_FIELDS_PUBLISH',
      idempotencyKey: key,
      targets: [{ catalogItemId: f.catalogItemId, venueId: f.venueId, productId: f.productId }],
    })

    expect(preview.canConfirm).toBe(true)
    expect(preview.lines).toHaveLength(1)
    expect(preview.lines[0]).toMatchObject({ status: 'READY', bindingId: f.bindingId })
    expect(await db().product.findUniqueOrThrow({ where: { id: f.productId }, select: { name: true } })).toEqual({
      name: 'Local name',
    })
    const staged = await db().catalogPublicationBatch.findUniqueOrThrow({ where: { id: preview.publicationBatchId } })
    const stagedRecord = await db().catalogIdempotencyRecord.findUniqueOrThrow({
      where: {
        organizationId_operation_idempotencyKey: {
          organizationId: f.organizationId,
          operation: 'CATALOG_FIELDS_PUBLISH',
          idempotencyKey: key,
        },
      },
    })
    expect(staged.state).toBe('PREVIEWED')
    expect(stagedRecord.state).toBe('PREVIEWED')
    expect(staged.previewTokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify([staged, stagedRecord])).not.toContain(preview.previewToken)
    expect(await db().catalogPublicationFieldDecision.count({ where: { organizationId: f.organizationId } })).toBe(0)

    const result = await confirmCatalogFieldsPublication(context(), {
      publicationBatchId: preview.publicationBatchId,
      previewToken: preview.previewToken,
      idempotencyKey: key,
      confirm: true,
    })

    expect(result).toMatchObject({ state: 'APPLIED', operation: 'CATALOG_FIELDS_PUBLISH' })
    const [product, binding, lines, batch, record, auditCount, outbox] = await Promise.all([
      db().product.findUniqueOrThrow({ where: { id: f.productId } }),
      db().catalogVenueBinding.findUniqueOrThrow({ where: { id: f.bindingId } }),
      db().catalogPublicationLine.findMany({ where: { batchId: preview.publicationBatchId }, include: { decisions: true } }),
      db().catalogPublicationBatch.findUniqueOrThrow({ where: { id: preview.publicationBatchId } }),
      db().catalogIdempotencyRecord.findUniqueOrThrow({
        where: {
          organizationId_operation_idempotencyKey: {
            organizationId: f.organizationId,
            operation: 'CATALOG_FIELDS_PUBLISH',
            idempotencyKey: key,
          },
        },
      }),
      db().activityLog.count({ where: { organizationId: f.organizationId, action: 'CATALOG_PUBLICATION_APPLIED' } }),
      db().catalogPublicationOutbox.findMany({ where: { batchId: preview.publicationBatchId } }),
    ])
    expect(product).toMatchObject({ name: 'Corporate name', description: 'Corporate description', active: false })
    expect(binding.lastPublishedCatalogRevision).toBe(1)
    expect(lines).toHaveLength(1)
    expect(lines[0].status).toBe('APPLIED')
    expect(lines[0].decisions).toHaveLength(lines[0].fieldMask.length)
    expect(batch.result).toEqual(record.result)
    expect(batch).toMatchObject({ state: 'APPLIED', attemptId: null, leaseExpiresAt: null, heartbeatAt: null })
    expect(auditCount).toBe(1)
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ venueId: f.venueId, venueSequence: 1n, status: 'PENDING', attempts: 0 })

    await expect(
      getCatalogPublicationByIdempotencyKey(context(), {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: key,
      }),
    ).resolves.toEqual(result)
  })

  it('rolls back Product, binding, decisions and outbox when publication audit fails', async () => {
    const isolated = await createCatalogPublicationFixture(db(), 'apply-audit-rollback')
    try {
      const isolatedContext: CatalogCommandContext = {
        organizationId: isolated.organizationId,
        actor: { type: 'HUMAN', staffId: isolated.staffId, impersonating: false },
        orgRole: 'OWNER',
      }
      const key = `audit-rollback-${isolated.key}`
      const preview = await createCatalogPublicationPreviewService({ prisma: db() as never }).preview(isolatedContext, {
        operation: 'CATALOG_FIELDS_PUBLISH',
        idempotencyKey: key,
        targets: [{ catalogItemId: isolated.catalogItemId, venueId: isolated.venueId, productId: isolated.productId }],
      })
      const auditFailure = new Error('forced publication audit rollback')
      const confirmation = createCatalogPublicationConfirmationService({
        prisma: db() as never,
        writeAudit: async () => {
          throw auditFailure
        },
      } as never)

      await expect(
        confirmation.confirm(isolatedContext, {
          publicationBatchId: preview.publicationBatchId,
          previewToken: preview.previewToken,
          idempotencyKey: key,
          confirm: true,
        }),
      ).rejects.toBe(auditFailure)

      const [product, binding, line, batch, record, decisions, outbox] = await Promise.all([
        db().product.findUniqueOrThrow({ where: { id: isolated.productId } }),
        db().catalogVenueBinding.findUniqueOrThrow({ where: { id: isolated.bindingId } }),
        db().catalogPublicationLine.findFirstOrThrow({ where: { batchId: preview.publicationBatchId } }),
        db().catalogPublicationBatch.findUniqueOrThrow({ where: { id: preview.publicationBatchId } }),
        db().catalogIdempotencyRecord.findUniqueOrThrow({
          where: {
            organizationId_operation_idempotencyKey: {
              organizationId: isolated.organizationId,
              operation: 'CATALOG_FIELDS_PUBLISH',
              idempotencyKey: key,
            },
          },
        }),
        db().catalogPublicationFieldDecision.count({ where: { organizationId: isolated.organizationId } }),
        db().catalogPublicationOutbox.count({ where: { organizationId: isolated.organizationId } }),
      ])
      expect(product.name).toBe('Local name')
      expect(binding).toMatchObject({ revision: 1, lastPublishedCatalogRevision: null, lastPublishedManagedSnapshot: null })
      expect(line.status).toBe('READY')
      expect(decisions).toBe(0)
      expect(outbox).toBe(0)
      // WHY: Reservation commits before the Product transaction; rollback leaves
      // the exact dual APPLYING tuple for the watchdog instead of replaying work.
      expect(batch).toMatchObject({ state: 'APPLYING', result: null })
      expect(record).toMatchObject({ state: 'APPLYING', result: null })
      expect(batch.attemptId).toBe(record.attemptId)
      expect(batch.leaseExpiresAt).toEqual(record.leaseExpiresAt)
      expect(batch.heartbeatAt).toEqual(record.heartbeatAt)
    } finally {
      await cleanupCatalogPublicationFixture(db(), isolated)
    }
  })
})
