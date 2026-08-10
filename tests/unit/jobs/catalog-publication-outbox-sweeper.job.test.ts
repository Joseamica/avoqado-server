import { CatalogPublicationOutboxSweeperJob } from '@/jobs/catalog-publication-outbox-sweeper.job'

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

describe('catalog-publication-outbox-sweeper.job', () => {
  it('starts, stops and delegates one bounded sweep with a stable worker id', async () => {
    const cron = { start: jest.fn(), stop: jest.fn() }
    const sweepOnce = jest.fn().mockResolvedValue({ claimed: 2, delivered: 2, failed: 0 })
    const job = new CatalogPublicationOutboxSweeperJob({
      cron: cron as never,
      sweepOnce,
      workerId: 'catalog-outbox-worker-1',
      entryRead: jest.fn().mockResolvedValue(true),
    })

    job.start()
    await expect(job.runNow()).resolves.toEqual({ claimed: 2, delivered: 2, failed: 0 })
    job.stop()

    expect(cron.start).toHaveBeenCalledTimes(1)
    expect(cron.stop).toHaveBeenCalledTimes(1)
    expect(sweepOnce).toHaveBeenCalledWith({ workerId: 'catalog-outbox-worker-1', limit: 100 })
  })

  it('does not overlap a slow delivery pass', async () => {
    let release!: () => void
    const sweepOnce = jest.fn(
      () =>
        new Promise<{ claimed: number; delivered: number; failed: number }>(resolve => {
          release = () => resolve({ claimed: 1, delivered: 1, failed: 0 })
        }),
    )
    const job = new CatalogPublicationOutboxSweeperJob({
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      sweepOnce,
      workerId: 'worker-1',
      entryRead: jest.fn().mockResolvedValue(true),
    })

    const first = job.runNow()
    await expect(job.runNow()).resolves.toEqual({ claimed: 0, delivered: 0, failed: 0, skipped: true })
    release()
    await expect(first).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0 })
    expect(sweepOnce).toHaveBeenCalledTimes(1)
  })

  it('retries only the pure entry read after P1001 and skips delivery when no row is ready', async () => {
    const entryRead = jest.fn().mockRejectedValueOnce({ code: 'P1001' }).mockResolvedValueOnce(false)
    const sweepOnce = jest.fn()
    const job = new CatalogPublicationOutboxSweeperJob({
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      sweepOnce,
      workerId: 'worker-1',
      entryRead,
      retryEntry: retryConnectionFailureOnce as never,
    })

    await expect(job.runNow()).resolves.toEqual({ claimed: 0, delivered: 0, failed: 0 })
    expect(entryRead).toHaveBeenCalledTimes(2)
    expect(sweepOnce).not.toHaveBeenCalled()
  })
})
