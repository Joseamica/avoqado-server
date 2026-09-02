import { CommercialPublicationOutboxSweeperJob } from '@/jobs/commercial-publication-outbox-sweeper.job'

type RetryEntry = typeof import('@/utils/retry').retry

function retryMock(): jest.MockedFunction<RetryEntry> {
  return jest.fn(async operation => operation()) as unknown as jest.MockedFunction<RetryEntry>
}

describe('CommercialPublicationOutboxSweeperJob', () => {
  it('retries only the readiness read and invokes the sweep once', async () => {
    const sweepOnce = jest.fn().mockResolvedValue({ claimed: 1, delivered: 1, failed: 0 })
    const entryRead = jest.fn().mockResolvedValue(true)
    const retryEntry = retryMock()
    const job = new CommercialPublicationOutboxSweeperJob({
      cron: { start: jest.fn(), stop: jest.fn() },
      workerId: 'worker-a',
      sweepOnce,
      entryRead,
      retryEntry,
    })

    await expect(job.runNow()).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0 })
    expect(retryEntry).toHaveBeenCalledTimes(1)
    expect(sweepOnce).toHaveBeenCalledTimes(1)
  })

  it('does not overlap runs in the same process', async () => {
    let release!: () => void
    const sweepOnce = jest.fn(
      () =>
        new Promise<{ claimed: number; delivered: number; failed: number }>(resolve => {
          release = () => resolve({ claimed: 0, delivered: 0, failed: 0 })
        }),
    )
    const job = new CommercialPublicationOutboxSweeperJob({
      cron: { start: jest.fn(), stop: jest.fn() },
      workerId: 'worker-a',
      sweepOnce,
      entryRead: jest.fn().mockResolvedValue(true),
      retryEntry: retryMock(),
    })

    const first = job.runNow()
    await Promise.resolve()
    await expect(job.runNow()).resolves.toEqual({ claimed: 0, delivered: 0, failed: 0, skipped: true })
    release()
    await first
  })
})
