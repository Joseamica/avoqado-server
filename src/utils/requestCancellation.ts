/**
 * Cooperative cancellation of READS — the brake from the 2026-09-23 incident.
 *
 * That night one customer's AI assistant (through the MCP) kept the server's only thread busy ~40 s per
 * request, in ~20 slices separated by database queries. The client gave up and retried, the retries piled
 * up, /health stopped answering and Render killed the instance. JavaScript cannot be interrupted in the
 * middle of synchronous work, but the work CAN be stopped at its next query once nobody is waiting for
 * the answer (deadline passed or client gone). That is what this module does.
 *
 * The rule that protects the data: only READS are refused, and only while the unit of work has not
 * written anything. A write is never interrupted, and once something was written nothing is cut
 * afterwards — a sequence of writes is never left half-done. And the other way round: once a read was
 * refused, EVERY later operation of that unit of work is refused too, writes included. A tool that swallows
 * the refusal in a `catch` (the classic `.catch(() => null)` followed by a `create`) can therefore never
 * write from a read it did not get. Outside a cancellable unit of work (every request that is not an MCP
 * request, every job) there is no `cancellation` in the context and this is a no-op.
 */
import { Prisma } from '@prisma/client'
import { getContext, runWithContext, type RequestCancellation } from '@/observability/executionContext'
import { isReadOnlySql } from './readOnlySql'

export { isReadOnlySql }

/**
 * Why a unit of work stopped: the deadline passed, the client hung up, or the tool already answered and a branch
 * it left running (a `Promise.all` sibling that outlived a rejection) tried to keep reading.
 */
export type CancellationReason = 'timeout' | 'client-closed' | 'tool-finished'

function messageFor(reason: CancellationReason, timeoutMs?: number): string {
  if (reason === 'tool-finished') return 'La consulta ya había respondido; esta parte que siguió corriendo sola se detuvo.'
  if (reason === 'timeout') {
    const seconds = Math.round((timeoutMs ?? 0) / 1000)
    return (
      `La consulta tardó más de ${seconds} s y se detuvo para no frenar el servicio de las tiendas. ` +
      'Intenta con un periodo más corto o con una sola tienda.'
    )
  }
  return 'La consulta se detuvo porque ya nadie esperaba la respuesta (se cerró la conexión).'
}

/**
 * Operational on purpose: the MCP's `sanitizeThrownError` lets operational errors reach the client
 * verbatim, so the assistant reads WHY and can retry with a narrower question.
 */
export class RequestCancelledError extends Error {
  readonly isOperational = true
  readonly statusCode = 503
  readonly reason: CancellationReason

  constructor(reason: CancellationReason, timeoutMs?: number) {
    super(messageFor(reason, timeoutMs))
    this.name = 'RequestCancelledError'
    this.reason = reason
  }
}

export function isRequestCancelledError(error: unknown): error is RequestCancelledError {
  return error instanceof RequestCancelledError
}

/**
 * Prisma ORM operation names that only READ. Everything else — including an operation Prisma may add in
 * the future — is treated as a write: the conservative side is "never cut what we do not know". Raw
 * queries are NOT here: `$queryRaw` also runs mutations in this repo (`UPDATE … RETURNING`,
 * `INSERT … ON CONFLICT`), so a raw query is a read only when its SQL says so (`isReadOnlySql`).
 */
export const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'findRaw',
  'aggregateRaw',
])

/** Raw operations whose read-or-write nature is decided by their SQL text. */
const RAW_QUERY_OPERATIONS: ReadonlySet<string> = new Set(['$queryRaw', '$queryRawUnsafe'])

/**
 * The SQL text of a raw query as Prisma 6.19 hands it to a query extension (verified live): `$queryRaw`
 * arrives as `{ strings, values }` and `$queryRawUnsafe` as `[sql, ...params]`. Null for any other shape.
 */
function rawSqlText(args: unknown): string | null {
  if (Array.isArray(args)) return typeof args[0] === 'string' ? args[0] : null
  const strings = (args as { strings?: unknown } | null)?.strings
  if (Array.isArray(strings) && strings.every(s => typeof s === 'string')) return strings.join(' $1 ')
  return null
}

/** Whether a Prisma operation only reads: by name for the ORM, by its SQL text for raw queries. */
export function isReadOperation(operation: string, args?: unknown): boolean {
  if (READ_OPERATIONS.has(operation)) return true
  if (!RAW_QUERY_OPERATIONS.has(operation)) return false
  const sql = rawSqlText(args)
  return sql !== null && isReadOnlySql(sql)
}

/** The error that describes why `signal` aborted (a foreign abort reason reads as "client gone"). */
export function cancellationError(signal: AbortSignal): RequestCancelledError {
  return isRequestCancelledError(signal.reason) ? signal.reason : new RequestCancelledError('client-closed')
}

/**
 * Pure decision for one database operation:
 * - once a read was refused, everything is refused (nothing is written from a swallowed refusal);
 * - a write always passes and marks the unit of work as "has written";
 * - a read is refused only when the work was cancelled and has not written yet — and that poisons the rest.
 */
export function checkCancellation(operation: string, cancellation: RequestCancellation | undefined, args?: unknown): void {
  if (!cancellation) return
  if (cancellation.refused) throw cancellationError(cancellation.signal)
  if (!isReadOperation(operation, args)) {
    cancellation.hasWritten = true
    return
  }
  if (!cancellation.signal.aborted || cancellation.hasWritten) return
  cancellation.refused = true
  throw cancellationError(cancellation.signal)
}

/**
 * For code about to START a new piece of work (a tool): if the unit of work was cancelled and has not
 * written, refuse it now — and poison the rest of the unit — returning the error to throw. Null otherwise.
 */
export function refuseNewWork(): RequestCancelledError | null {
  const cancellation = getContext()?.cancellation
  if (!cancellation) return null
  if (cancellation.refused) return cancellationError(cancellation.signal)
  if (!cancellation.signal.aborted || cancellation.hasWritten) return null
  cancellation.refused = true
  return cancellationError(cancellation.signal)
}

/**
 * Declares that the unit of work finished a complete, idempotent write sequence (e.g. one venue's ledger
 * materialization): nothing is left half-done, so the brake may cut again at the next read. Only code that
 * knows its writes are complete and safe to resume may call it — and whatever that sequence left running on its own
 * (an audit row: `void logAction(...)`) must run outside the brake (`runWithoutCancellation`). Prisma runs it later:
 * inside the brake it would mark the unit as written again after this reset, or be refused once the unit is cut, and
 * the audit row would be lost (Codex, round 5).
 */
export function endOfWriteUnit(): void {
  const cancellation = getContext()?.cancellation
  if (cancellation && !cancellation.refused) cancellation.hasWritten = false
}

/**
 * Marks one piece of work (the MCP handler, each tool) as running for the current unit, returning its
 * idempotent end. When the last piece ends, `onIdle` fires: the MCP guard frees the person's slot there,
 * because a closed connection does not stop a running tool.
 */
export function beginWork(): () => void {
  const cancellation = getContext()?.cancellation
  if (!cancellation) return () => {}
  cancellation.activeWork = (cancellation.activeWork ?? 0) + 1
  cancellation.lastActivityAt = Date.now()
  if (cancellation.activeWork === 1) cancellation.onBusy?.()
  let ended = false
  return () => {
    if (ended) return
    ended = true
    cancellation.activeWork = Math.max(0, (cancellation.activeWork ?? 1) - 1)
    cancellation.lastActivityAt = Date.now()
    if (cancellation.activeWork === 0) cancellation.onIdle?.()
  }
}

/**
 * Called by the MCP tool wrapper when the tool has answered (resolved or rejected). Anything of this unit that
 * still tries to READ from now on is a branch the tool left running — e.g. a `Promise.all` sibling that outlived
 * the rejection — whose result nobody will use: its next read is refused. Writes are unaffected (a unit that
 * already wrote is never cut), so a legitimate post-commit write finishes.
 */
export function settleTool(): void {
  getContext()?.cancellation?.cancel?.(new RequestCancelledError('tool-finished'))
}

/**
 * For code about to HAND BACK a result: the error to raise if one of this unit's reads was refused — a
 * `catch` along the way may have swallowed it, so the result can be partial. A unit whose reads all
 * finished before the deadline returns its result (late, but complete).
 */
export function pendingCancellation(): RequestCancelledError | null {
  const cancellation = getContext()?.cancellation
  return cancellation?.refused ? cancellationError(cancellation.signal) : null
}

/**
 * Runs `fn` in a copy of the current context WITHOUT the cancellation: for bookkeeping writes (the MCP's
 * own call audit) that must never be refused by the brake nor count as the unit of work's write. Keeps
 * everything else (correlation id, entry point, tenant) so its logs still say what and who.
 *
 * Prisma queries are LAZY thenables: they only run — and only reach the brake's extension — when `.then`
 * is called. Awaited by the caller, that `.then` would happen back in the caller's context, WITH the brake
 * (found end-to-end: the audit row of a cancelled call was refused). So a thenable result is started here,
 * inside the context without the brake.
 */
export function runWithoutCancellation<T>(fn: () => T): T {
  const context = getContext()
  if (!context?.cancellation) return fn()
  const { cancellation: _dropped, ...rest } = context
  return runWithContext(rest, () => {
    const result = fn()
    if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      const lazy = result as unknown as PromiseLike<unknown>
      return new Promise((resolve, reject) => lazy.then(resolve, reject)) as T
    }
    return result
  })
}

/**
 * EVERY `$transaction` of a cancellable unit, as ONE piece of work from start to settle (Codex, rounds 4 and 5) — also
 * one opened inside the callback of another: sharing the async context is not sharing the PostgreSQL transaction, and
 * the inner one can outlive the outer one. So:
 * - a unit that already gave the person's slot back takes it again BEFORE the transaction begins. Every live transaction
 *   of the unit is counted, so a unit without its slot has none open: the wait never holds a row lock or a connection,
 *   and can never deadlock against the request that holds the slot;
 * - while it runs, the transaction is counted as running work, so the unit cannot let go of the slot halfway through it
 *   (not even between two of its operations, or while its callback computes);
 * - a BATCH (`$transaction([…])`) runs marked `prismaBatch`: its operations are not counted apart and never ask for the
 *   slot (see `extensionCancellableReads`). Prisma leaves a batch item waiting forever at its internal barrier when
 *   another item fails before reaching it, and that must not keep the person's slot taken: the one count ends when the
 *   batch settles. The operations of an INTERACTIVE transaction are counted one by one, like any other: its callback
 *   runs arbitrary code, and whatever it leaves running is still work of the unit.
 * `beforeStart` runs first — the batch check (`assertBatchOfPrismaQueries`) — so a malformed batch starts nothing.
 * Outside a cancellable unit — the rest of the platform — it hands back Prisma's own promise untouched.
 */
export function runCancellableTransaction<T>(
  start: () => Promise<T>,
  options: { batch?: boolean; beforeStart?: () => void } = {},
): Promise<T> {
  const context = getContext()
  const cancellation = context?.cancellation
  if (!context || !cancellation) return start()
  return (async () => {
    options.beforeStart?.()
    if (cancellation.attached === false && cancellation.reattach) await cancellation.reattach()
    const endWork = beginWork()
    try {
      return await (options.batch ? runWithContext({ ...context, prismaBatch: true }, start) : start())
    } finally {
      endWork()
    }
  })()
}

/**
 * Prisma client extension: every operation (model operations, raw queries and operations inside an
 * interactive transaction — verified on Prisma 6.19.3) passes through `checkCancellation` first and, inside a
 * cancellable unit, counts as running work while in flight. `async` on purpose: a refusal must reach Prisma as a
 * REJECTED promise, never as a synchronous throw. Outside a cancellable unit it hands back `query(args)` as is.
 *
 * A unit that already gave the person's slot back (`attached === false`) takes it again before the operation runs
 * (Codex, round 3): a branch that outlived its tool never touches the database alongside the person's next request.
 * That wait never holds a transaction open: every live transaction of the unit is counted, so a unit without its slot
 * has none. An operation of one of the unit's BATCHES only goes through the brake — the batch is the counted work, took
 * the slot back before starting, and may leave this operation waiting forever at Prisma's barrier.
 */
export const extensionCancellableReads = {
  name: 'cancellable-reads',
  query: {
    async $allOperations({
      operation,
      args,
      query,
    }: {
      model?: string
      operation: string
      args: unknown
      query: (args: unknown) => Promise<unknown>
    }) {
      const context = getContext()
      const cancellation = context?.cancellation
      if (!cancellation) return query(args)
      // Every operation of a cancellable unit — even one about to be refused — is activity, and one in flight is
      // running work: the MCP guard holds the person's slot until all of it has gone quiet.
      cancellation.lastActivityAt = Date.now()
      checkCancellation(operation, cancellation, args)
      if (context?.prismaBatch) return query(args)
      if (cancellation.attached === false && cancellation.reattach) {
        await cancellation.reattach()
        // The wait may have outlasted a refused read of this unit: nothing is written from a swallowed refusal.
        checkCancellation(operation, cancellation, args)
      }
      const endWork = beginWork()
      try {
        return await query(args)
      } finally {
        endWork()
      }
    },
  },
} as const

/**
 * `$transaction([…])` with an element that is not a Prisma query: Prisma 6.19 PREPARES the elements before it and only
 * then throws, and each prepared element starts in a later microtask — after the transaction already settled — to wait
 * forever at the batch barrier (Codex, round 4). A HOLE in the array does the same, and `Array.every` (like Prisma's own
 * `map`) skips holes (Codex, round 5): every position is checked by index. Inside a cancellable unit the whole batch is
 * refused before anything is prepared, with Prisma's own message; outside one, Prisma's own check runs as always.
 */
export function assertBatchOfPrismaQueries(first: unknown): void {
  if (!Array.isArray(first)) return
  for (let index = 0; index < first.length; index++) {
    const element = first[index] as { [Symbol.toStringTag]?: unknown } | null | undefined
    if (element?.[Symbol.toStringTag] !== 'PrismaPromise') {
      throw new Error(
        'All elements of the array need to be Prisma Client promises. Hint: Please make sure you are not awaiting the Prisma client calls you intended to pass in the $transaction function.',
      )
    }
  }
}

/**
 * Prisma client extension that wraps `$transaction` in `runCancellableTransaction` (Prisma 6.19 lets a client
 * extension override it; the original is reached through `$parent`, verified live with batches and interactive
 * transactions). Chain it LAST in `prismaClient.ts`, so every caller of the shared client goes through it.
 */
export const extensionCancellableTransactions = {
  name: 'cancellable-transactions',
  client: {
    $transaction(this: unknown, ...args: unknown[]): Promise<unknown> {
      const { $parent } = Prisma.getExtensionContext(this) as unknown as {
        $parent: { $transaction: (...transactionArgs: unknown[]) => Promise<unknown> }
      }
      return runCancellableTransaction(() => $parent.$transaction(...args), {
        batch: Array.isArray(args[0]),
        beforeStart: () => assertBatchOfPrismaQueries(args[0]),
      })
    },
  },
} as const
