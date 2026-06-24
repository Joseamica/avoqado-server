import { ConcurrencyLimiter, analyticsLimiter } from '@/utils/concurrencyLimiter'

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ConcurrencyLimiter', () => {
  // ----- NEW BEHAVIOR (the cap + correctness this hotfix relies on) -----

  it('returns the resolved value of the wrapped fn', async () => {
    const limiter = new ConcurrencyLimiter(2)
    await expect(limiter.run(async () => 42)).resolves.toBe(42)
  })

  it('never runs more than `max` tasks concurrently (all submitted at once)', async () => {
    const max = 3
    const limiter = new ConcurrencyLimiter(max)
    let active = 0
    let peak = 0

    const tasks = Array.from({ length: 20 }, () =>
      limiter.run(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise<void>(resolve => setTimeout(resolve, Math.floor(Math.random() * 4)))
        active--
      }),
    )

    await Promise.all(tasks)
    expect(peak).toBe(max) // reaches the cap (uses full capacity)...
    expect(peak).toBeLessThanOrEqual(max) // ...but never exceeds it
    expect(active).toBe(0)
  })

  it('never exceeds `max` when callers arrive continuously (staggered) — regression for non-atomic admission', async () => {
    // This is the adversarial pattern the safety audit flagged: fresh callers
    // arriving while slots are being handed off must NOT slip past the cap.
    const max = 3
    const limiter = new ConcurrencyLimiter(max)
    let active = 0
    let peak = 0

    const tasks: Promise<void>[] = []
    for (let i = 0; i < 40; i++) {
      tasks.push(
        limiter.run(async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise<void>(resolve => setTimeout(resolve, Math.floor(Math.random() * 4)))
          active--
        }),
      )
      // Stagger submissions so new callers arrive mid-flight (the race window).
      if (i % 3 === 0) await tick()
    }

    await Promise.all(tasks)
    expect(peak).toBeLessThanOrEqual(max)
    expect(active).toBe(0)
  })

  it('preserves FIFO order among queued callers (no barging)', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const order: number[] = []
    const gates = [deferred(), deferred(), deferred()]

    const tasks = [0, 1, 2].map(i =>
      limiter.run(async () => {
        order.push(i)
        await gates[i].promise
      }),
    )

    await tick() // task 0 running; 1 and 2 queued in order
    gates[0].resolve()
    await tick() // slot handed to task 1
    gates[1].resolve()
    await tick() // slot handed to task 2
    gates[2].resolve()
    await Promise.all(tasks)

    expect(order).toEqual([0, 1, 2])
  })

  it('propagates the rejection unchanged AND releases the slot (no leak/deadlock)', async () => {
    const limiter = new ConcurrencyLimiter(1)

    await expect(limiter.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')

    // If the slot leaked on throw, this would hang forever (test would time out).
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('drains a burst that mixes successes and failures without deadlocking', async () => {
    const limiter = new ConcurrencyLimiter(2)

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        limiter.run(async () => {
          await new Promise<void>(resolve => setTimeout(resolve, Math.floor(Math.random() * 3)))
          if (i % 3 === 0) throw new Error(`fail ${i}`)
          return i
        }),
      ),
    )

    expect(results).toHaveLength(10)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(4) // i = 0,3,6,9
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(6)
    // Limiter still usable afterwards.
    await expect(limiter.run(async () => 'done')).resolves.toBe('done')
  })

  it('runs strictly sequentially when max=1', async () => {
    const limiter = new ConcurrencyLimiter(1)
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          active++
          peak = Math.max(peak, active)
          await tick()
          active--
        }),
      ),
    )
    expect(peak).toBe(1)
  })

  // ----- REGRESSION (shared singleton stays functional) -----

  it('exports a working shared analyticsLimiter', async () => {
    expect(analyticsLimiter).toBeInstanceOf(ConcurrencyLimiter)
    await expect(analyticsLimiter.run(async () => 'alive')).resolves.toBe('alive')
  })
})
