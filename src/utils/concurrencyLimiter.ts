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

/** B4b (Codex r5 R5-9): cuántos estados de resultados de un RFC corren a la vez; cada uno ocupa una conexión toda su foto. */
export const ESTADOS_DE_RESULTADOS_A_LA_VEZ = 2

/**
 * `fn` sobre cada elemento, con a lo más `limite` a la vez y el resultado en el orden de `items`. Si una falla, rechaza con su error
 * y no arranca ninguna más (las que ya corrían terminan solas; nadie usa su resultado). Para trabajo que ocupa una conexión larga.
 * T6 M2 (revisión final): `limite` debe ser un entero ≥ 1; con 0, negativo o NaN no arrancaría ningún trabajador y el arreglo
 * volvería con huecos (un $0 en silencio en el IVA en flujo), así que se rechaza antes de correr nada.
 */
export async function enParaleloAcotado<T, R>(items: T[], limite: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limite) || limite < 1) throw new RangeError(`enParaleloAcotado: el límite debe ser un entero ≥ 1 (llegó ${limite})`)
  const resultados = new Array<R>(items.length)
  let siguiente = 0
  let fallo = false
  const trabajador = async () => {
    while (!fallo && siguiente < items.length) {
      const i = siguiente++
      try {
        resultados[i] = await fn(items[i])
      } catch (e) {
        fallo = true
        throw e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, items.length) }, trabajador))
  return resultados
}
