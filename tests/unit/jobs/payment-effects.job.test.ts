import { PaymentEffectsJob } from '@/jobs/payment-effects.job'
import { PaymentEffectClaim } from '@/services/tpv/paymentEffects.service'

const now = new Date('2026-09-09T23:00:00Z')
const row = (id: string) =>
  ({
    id,
    claimToken: id,
    venueId: 'venue',
    orderId: 'order',
    paymentId: id,
    kind: 'REVIEW',
    dedupeKey: id,
    payload: { rating: 5 },
    attempts: 1,
    leaseUntil: new Date(now.getTime() + 120000),
  }) as PaymentEffectClaim
const setup = () => ({
  now: () => now,
  claim: jest.fn().mockResolvedValue([row('a'), row('b')]),
  apply: jest.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue(true),
  fail: jest.fn().mockResolvedValue(true),
  cron: { start: jest.fn(), stop: jest.fn() },
})

describe('payment effects job lifecycle', () => {
  it('takes one bounded batch and records a failure without skipping subsequent independent work', async () => {
    const dependencies = setup()
    const job = new PaymentEffectsJob(dependencies)
    expect(await job.runNow()).toEqual({ applied: 1, failed: 1, skipped: 0 })
    expect(dependencies.claim).toHaveBeenCalledTimes(1)
    expect(dependencies.claim).toHaveBeenCalledWith({ now, limit: 25 })
    expect(dependencies.apply).toHaveBeenCalledTimes(2)
    expect(dependencies.fail).toHaveBeenCalledWith(row('a'), now, expect.any(Error))
  })
  it('prevents overlapping local sweeps, releases the guard after failure, and wires lifecycle', async () => {
    const dependencies = setup()
    let resolve!: (value: PaymentEffectClaim[]) => void
    dependencies.claim.mockReturnValueOnce(
      new Promise<PaymentEffectClaim[]>(done => {
        resolve = done
      }),
    )
    const job = new PaymentEffectsJob(dependencies)
    job.start()
    const first = job.runNow()
    expect(await job.runNow()).toEqual({ applied: 0, failed: 0, skipped: 1 })
    resolve([])
    await first
    dependencies.claim.mockRejectedValueOnce(new Error('DB_DOWN'))
    await expect(job.runNow()).rejects.toThrow('DB_DOWN')
    expect(await job.runNow()).toEqual({ applied: 1, failed: 1, skipped: 0 })
    job.stop()
    expect(dependencies.cron.start).toHaveBeenCalledTimes(1)
    expect(dependencies.cron.stop).toHaveBeenCalledTimes(1)
  })
})
