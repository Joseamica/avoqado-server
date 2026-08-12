import { CatalogPublicationWatchdogJob } from '@/jobs/catalog-publication-watchdog.job'
import { shouldRetryDbConnectionError } from '@/utils/retry'

const NOW = new Date('2026-08-09T12:00:00.000Z')
const expired = {
  id: 'batch-1',
  organizationId: 'org-1',
  operation: 'CATALOG_FIELDS_PUBLISH',
  attemptId: 'attempt-1',
  leaseExpiresAt: new Date('2026-08-09T11:59:00.000Z'),
}

async function retryConnectionFailureOnce<T>(
  operation: () => Promise<T>,
  options: { shouldRetry?: (error: unknown) => boolean },
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!options.shouldRetry?.(error)) throw error
    return operation()
  }
}

function harness(options: { live?: boolean; batchCount?: number; recordCount?: number } = {}) {
  const tx = {
    catalogPublicationBatch: {
      findFirst: jest.fn().mockResolvedValue(options.live === false ? null : expired),
      updateMany: jest.fn().mockResolvedValue({ count: options.batchCount ?? 1 }),
    },
    catalogIdempotencyRecord: {
      updateMany: jest.fn().mockResolvedValue({ count: options.recordCount ?? 1 }),
    },
  }
  const prisma = {
    catalogPublicationBatch: { findMany: jest.fn().mockResolvedValue([expired]) },
    $transaction: jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  }
  const acquireAttemptLockTx = jest.fn().mockResolvedValue(undefined)
  const job = new CatalogPublicationWatchdogJob({
    prisma: prisma as never,
    cron: { start: jest.fn(), stop: jest.fn() } as never,
    now: () => NOW,
    acquireAttemptLockTx,
  })
  return { job, prisma, tx, acquireAttemptLockTx }
}

describe('catalog-publication-watchdog.job', () => {
  it('retries the entry scan after a transient P1001 without retrying candidate transactions', async () => {
    const findMany = jest.fn().mockRejectedValueOnce({ code: 'P1001' }).mockResolvedValueOnce([])
    const transaction = jest.fn()
    const job = new CatalogPublicationWatchdogJob({
      prisma: { catalogPublicationBatch: { findMany }, $transaction: transaction } as never,
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      now: () => NOW,
      acquireAttemptLockTx: jest.fn(),
      retryEntry: retryConnectionFailureOnce as never,
    })

    await expect(job.runNow()).resolves.toEqual({ scanned: 0, failed: 0, skipped: 0, errors: 0 })
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(transaction).not.toHaveBeenCalled()
    expect(shouldRetryDbConnectionError({ code: 'P1001' })).toBe(true)
  })

  it('takes the confirmation attempt lock, rereads, and CAS-fails only the exact expired tuple', async () => {
    const h = harness()

    await expect(h.job.runNow()).resolves.toEqual({ scanned: 1, failed: 1, skipped: 0, errors: 0 })

    expect(h.acquireAttemptLockTx).toHaveBeenCalledWith(expect.anything(), 'org-1', 'batch-1')
    expect(h.acquireAttemptLockTx.mock.invocationCallOrder[0]).toBeLessThan(
      h.tx.catalogPublicationBatch.findFirst.mock.invocationCallOrder[0],
    )
    const exact = expect.objectContaining({
      id: 'batch-1',
      organizationId: 'org-1',
      state: 'APPLYING',
      attemptId: 'attempt-1',
      leaseExpiresAt: expired.leaseExpiresAt,
    })
    expect(h.tx.catalogPublicationBatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: exact }))
    expect(h.tx.catalogIdempotencyRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          operation: 'CATALOG_FIELDS_PUBLISH',
          resourceId: 'batch-1',
          state: 'APPLYING',
          attemptId: 'attempt-1',
          leaseExpiresAt: expired.leaseExpiresAt,
        }),
      }),
    )
  })

  it('leaves an APPLIED winner immutable after waiting on the shared lock', async () => {
    const h = harness({ live: false })

    await expect(h.job.runNow()).resolves.toEqual({ scanned: 1, failed: 0, skipped: 1, errors: 0 })
    expect(h.tx.catalogPublicationBatch.updateMany).not.toHaveBeenCalled()
    expect(h.tx.catalogIdempotencyRecord.updateMany).not.toHaveBeenCalled()
  })

  it('rolls back contradictory dual CAS authority and continues the bounded pass', async () => {
    const h = harness({ recordCount: 0 })

    await expect(h.job.runNow()).resolves.toEqual({ scanned: 1, failed: 0, skipped: 0, errors: 1 })
  })

  it('does not overlap manual or cron passes', async () => {
    let release!: () => void
    const prisma = {
      catalogPublicationBatch: {
        findMany: jest.fn(
          () =>
            new Promise(resolve => {
              release = () => resolve([])
            }),
        ),
      },
    }
    const job = new CatalogPublicationWatchdogJob({
      prisma: prisma as never,
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      now: () => NOW,
      acquireAttemptLockTx: jest.fn(),
    })

    const first = job.runNow()
    await expect(job.runNow()).resolves.toEqual({ scanned: 0, failed: 0, skipped: 1, errors: 0 })
    release()
    await first
    expect(prisma.catalogPublicationBatch.findMany).toHaveBeenCalledTimes(1)
  })
})
