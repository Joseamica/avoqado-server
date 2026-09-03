import { CommercialSubscriptionExpiryJob } from '@/jobs/commercial-subscription-expiry.job'

describe('CommercialSubscriptionExpiryJob', () => {
  it('runs one bounded expiry sweep and leaves time authority to PostgreSQL', async () => {
    const sweepOnce = jest.fn().mockResolvedValue({ claimed: 2, expired: 2, contractsPaused: 1 })
    const job = new CommercialSubscriptionExpiryJob({
      cron: { start: jest.fn(), stop: jest.fn() },
      sweepOnce,
    })

    await expect(job.runNow()).resolves.toEqual({ claimed: 2, expired: 2, contractsPaused: 1 })
    expect(sweepOnce).toHaveBeenCalledWith({ limit: 100 })
  })

  it('does not overlap expiry transactions in the same process', async () => {
    let release!: () => void
    const sweepOnce = jest.fn(
      () =>
        new Promise<{ claimed: number; expired: number; contractsPaused: number }>(resolve => {
          release = () => resolve({ claimed: 0, expired: 0, contractsPaused: 0 })
        }),
    )
    const job = new CommercialSubscriptionExpiryJob({
      cron: { start: jest.fn(), stop: jest.fn() },
      sweepOnce,
    })

    const first = job.runNow()
    await Promise.resolve()
    await expect(job.runNow()).resolves.toEqual({ claimed: 0, expired: 0, contractsPaused: 0, skipped: true })
    release()
    await first
  })
})
