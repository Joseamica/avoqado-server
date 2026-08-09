/**
 * H1A transactional audit writer.
 *
 * The transaction client is a deliberate seam: a future catalog mutation must
 * lose both domain state and audit state when either side fails.
 */
import { createHash } from 'node:crypto'
import { writeCatalogAudit } from '@/services/master-catalog/catalogAudit.service'

const ORGANIZATION_ID = 'org-pits'
const VENUE_ID = 'venue-pits-store-1'
const STAFF_ID = 'staff-owner'

const venueFindFirst = jest.fn()
const activityLogCreate = jest.fn()
const tx = {
  venue: { findFirst: venueFindFirst },
  activityLog: { create: activityLogCreate },
}

beforeEach(() => {
  jest.clearAllMocks()
  venueFindFirst.mockResolvedValue({ id: VENUE_ID })
  activityLogCreate.mockResolvedValue({ id: 'activity-1' })
})

describe('writeCatalogAudit', () => {
  it('validates venue tenancy and writes HUMAN actor provenance plus only optional audit detail', async () => {
    const idempotencyKeyHash = createHash('sha256').update('catalog-confirm-secret-key').digest('hex')

    await writeCatalogAudit(tx as never, {
      organizationId: ORGANIZATION_ID,
      venueId: VENUE_ID,
      actor: { type: 'HUMAN', staffId: STAFF_ID, impersonating: false },
      action: 'CATALOG_ITEM_CREATED',
      entity: 'CatalogItem',
      entityId: 'catalog-item-1',
      batchId: 'batch-1',
      idempotencyKeyHash,
      reason: 'Alta corporativa confirmada',
      before: { status: 'ABSENT' },
      after: { status: 'ACTIVE' },
      metadata: { affectedItems: 1 },
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
    })

    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: VENUE_ID, organizationId: ORGANIZATION_ID },
      select: { id: true },
    })
    expect(activityLogCreate).toHaveBeenCalledWith({
      data: {
        organizationId: ORGANIZATION_ID,
        venueId: VENUE_ID,
        actorType: 'HUMAN',
        staffId: STAFF_ID,
        actorStaffId: STAFF_ID,
        servicePrincipalId: null,
        action: 'CATALOG_ITEM_CREATED',
        entity: 'CatalogItem',
        entityId: 'catalog-item-1',
        data: {
          batchId: 'batch-1',
          idempotencyKeyHash,
          reason: 'Alta corporativa confirmada',
          before: { status: 'ABSENT' },
          after: { status: 'ACTIVE' },
          metadata: { affectedItems: 1 },
        },
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      },
    })
    expect(JSON.stringify(activityLogCreate.mock.calls[0][0])).not.toContain('catalog-confirm-secret-key')
  })

  it('preserves an already-computed lowercase SHA-256 hash without hashing it twice', async () => {
    const hash = createHash('sha256').update('already-hashed-key').digest('hex')

    await writeCatalogAudit(tx as never, {
      organizationId: ORGANIZATION_ID,
      actor: { type: 'HUMAN', staffId: STAFF_ID, impersonating: false },
      action: 'CATALOG_ITEM_UPDATED',
      entity: 'CatalogItem',
      idempotencyKeyHash: hash,
    })

    expect(activityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ data: { idempotencyKeyHash: hash } }) }),
    )
  })

  it.each(['catalog-confirm-raw-key', 'A'.repeat(64), '0'.repeat(63)])(
    'rejects a raw or malformed idempotency digest before persistence (%s)',
    async idempotencyKeyHash => {
      await expect(
        writeCatalogAudit(tx as never, {
          organizationId: ORGANIZATION_ID,
          actor: { type: 'HUMAN', staffId: STAFF_ID, impersonating: false },
          action: 'CATALOG_ITEM_UPDATED',
          entity: 'CatalogItem',
          idempotencyKeyHash,
        }),
      ).rejects.toMatchObject({ statusCode: 422 })

      expect(activityLogCreate).not.toHaveBeenCalled()
    },
  )

  it('writes SERVICE provenance with both Staff columns null and no invented identity', async () => {
    await writeCatalogAudit(tx as never, {
      organizationId: ORGANIZATION_ID,
      actor: { type: 'SERVICE', servicePrincipalId: 'catalog-publication-worker' },
      action: 'CATALOG_PUBLICATION_APPLIED',
      entity: 'CatalogPublicationBatch',
      entityId: 'publication-1',
    })

    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(activityLogCreate).toHaveBeenCalledWith({
      data: {
        organizationId: ORGANIZATION_ID,
        venueId: null,
        actorType: 'SERVICE',
        staffId: null,
        actorStaffId: null,
        servicePrincipalId: 'catalog-publication-worker',
        action: 'CATALOG_PUBLICATION_APPLIED',
        entity: 'CatalogPublicationBatch',
        entityId: 'publication-1',
        data: undefined,
        ipAddress: null,
        userAgent: null,
      },
    })
  })

  it('rejects a missing or foreign venue with the same scoped 404 before writing audit', async () => {
    venueFindFirst.mockResolvedValue(null)

    await expect(
      writeCatalogAudit(tx as never, {
        organizationId: ORGANIZATION_ID,
        venueId: 'venue-foreign-or-missing',
        actor: { type: 'HUMAN', staffId: STAFF_ID, impersonating: false },
        action: 'CATALOG_ITEM_UPDATED',
        entity: 'CatalogItem',
      }),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Sucursal no encontrada' })

    expect(activityLogCreate).not.toHaveBeenCalled()
  })

  it('does not catch an ActivityLog insertion failure', async () => {
    const insertionFailure = new Error('ActivityLog FK rejected')
    activityLogCreate.mockRejectedValue(insertionFailure)

    await expect(
      writeCatalogAudit(tx as never, {
        organizationId: ORGANIZATION_ID,
        actor: { type: 'HUMAN', staffId: STAFF_ID, impersonating: false },
        action: 'CATALOG_ITEM_UPDATED',
        entity: 'CatalogItem',
      }),
    ).rejects.toBe(insertionFailure)
  })

  it.each(['   ', '\u2003\u2009'])('rejects blank service principals before persistence (%j)', async servicePrincipalId => {
    await expect(
      writeCatalogAudit(tx as never, {
        organizationId: ORGANIZATION_ID,
        actor: { type: 'SERVICE', servicePrincipalId },
        action: 'CATALOG_JOB_RUN',
        entity: 'CatalogImportBatch',
      }),
    ).rejects.toMatchObject({ statusCode: 422 })

    expect(activityLogCreate).not.toHaveBeenCalled()
  })

  it('rejects a Unicode-whitespace-only HUMAN staffId before any database access', async () => {
    await expect(
      writeCatalogAudit(tx as never, {
        organizationId: ORGANIZATION_ID,
        venueId: VENUE_ID,
        actor: { type: 'HUMAN', staffId: '\u2003\u2009', impersonating: false },
        action: 'CATALOG_ITEM_UPDATED',
        entity: 'CatalogItem',
      }),
    ).rejects.toMatchObject({ statusCode: 422 })

    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(activityLogCreate).not.toHaveBeenCalled()
  })

  it.each(['organizationId', 'action', 'entity'] as const)('rejects Unicode-whitespace-only %s before any database access', async field => {
    const input = {
      organizationId: ORGANIZATION_ID,
      venueId: VENUE_ID,
      actor: { type: 'HUMAN' as const, staffId: STAFF_ID, impersonating: false },
      action: 'CATALOG_ITEM_UPDATED',
      entity: 'CatalogItem',
      [field]: '\u2003\u2009',
    }

    await expect(writeCatalogAudit(tx as never, input)).rejects.toMatchObject({ statusCode: 422 })
    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(activityLogCreate).not.toHaveBeenCalled()
  })

  it('rejects a supplied Unicode-whitespace-only reason instead of recording meaningless evidence', async () => {
    await expect(
      writeCatalogAudit(tx as never, {
        organizationId: ORGANIZATION_ID,
        actor: { type: 'HUMAN', staffId: STAFF_ID, impersonating: false },
        action: 'CATALOG_ITEM_UPDATED',
        entity: 'CatalogItem',
        reason: '\u2003\u2009',
      }),
    ).rejects.toMatchObject({ statusCode: 422 })

    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(activityLogCreate).not.toHaveBeenCalled()
  })
})
