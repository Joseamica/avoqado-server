/**
 * Tiny dependency-free concurrency limiter (counting semaphore).
 *
 * Caps how many wrapped async operations run at once; the rest queue FIFO and
 * start as slots free. Two invariants make it a reliable cap:
 *
 *  1. Admission is atomic. Taking a free slot is a single synchronous step
 *     (`active < max` → `active++`) with no `await` in between, so under Node's
 *     single-threaded event loop no interleaving caller can ever push `active`
 *     above `max`.
 *  2. Slots are handed off, not re-counted. On release, if someone is waiting
 *     the freed slot is handed DIRECTLY to the next waiter (we do NOT decrement
 *     `active`, and the resumed waiter does NOT re-increment it). Only when the
 *     queue is empty do we decrement. This keeps `active <= max` at all times
 *     and preserves strict FIFO fairness (no barging).
 *
 * Used so the org sale-verification analytics endpoints — the dashboard fires
 * ~9 of them in parallel — can't monopolize the single Prisma connection pool
 * and starve the rest of the app. Incident 2026-06-23 (P2024 pool exhaustion).
 */
export class ConcurrencyLimiter {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Atomic admission: either take a free slot now, or park until one is handed
    // to us. A parked caller does NOT re-increment `active` — the releasing task
    // kept the slot reserved for us when it invoked our resolver.
    if (this.active < this.max) {
      this.active++
    } else {
      await new Promise<void>(resolve => this.queue.push(resolve))
    }

    try {
      return await fn()
    } finally {
      const next = this.queue.shift()
      if (next) {
        next() // hand our slot straight to the next waiter (keep `active` as-is)
      } else {
        this.active-- // no one waiting → free the slot
      }
    }
  }
}

/**
 * Shared limiter for the heavy org-analytics aggregations. Default 4: well below
 * the Prisma pool so analytics can never hold more than 4 connections at once,
 * leaving the rest for normal traffic. Tunable via env; never raise it above
 * roughly pool/2 or it re-opens the exhaustion door.
 */
export const analyticsLimiter = new ConcurrencyLimiter(Number(process.env.ANALYTICS_MAX_CONCURRENCY) || 4)
