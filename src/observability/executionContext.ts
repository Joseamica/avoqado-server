import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Where a unit of work started. Lets an investigation filter "everything that came from a
 * cron tick" apart from "everything that came from a terminal".
 */
export type ContextSource = 'http' | 'job' | 'rabbit' | 'socket'

/**
 * Cooperative cancellation of one unit of work (today: one MCP request — incident 2026-09-23).
 *
 * `signal` aborts when nobody is waiting for the answer anymore (deadline passed, client gone). The
 * Prisma extension in `src/utils/requestCancellation.ts` then refuses the NEXT read of this unit of work,
 * so the work stops at its next query instead of burning the only thread for minutes. `hasWritten` flips
 * on the first write: from then on nothing is cut, so a sequence of writes is never left half-done.
 * `refused` flips on the first refused read: from then on EVERY operation is refused, writes included, so
 * nothing is ever written from a read that a `catch` swallowed. The two are mutually exclusive.
 * `activeWork`/`onIdle` count the work still running for this unit (the handler, each tool and every database
 * operation in flight), and `lastActivityAt` stamps the last start or end of any of it, so the MCP guard frees
 * the person's slot only when the WORK has gone quiet — a closed connection does not stop a running tool, and
 * a `Promise.all` branch can outlive the tool that started it. `cancel` lets the tool wrapper stop the unit's
 * pending reads once the tool has answered.
 * `attached` is false once the unit gave the person's slot back: a branch that is still alive after that must take
 * the slot again (`reattach`) before its next database operation, so it never runs alongside the person's next
 * request (Codex, round 3).
 * Never logged — `logContext.ts` only injects whitelisted fields.
 */
export interface RequestCancellation {
  signal: AbortSignal
  hasWritten: boolean
  refused: boolean
  activeWork?: number
  lastActivityAt?: number
  onIdle?: () => void
  /** Called when work starts again after the unit was idle (`activeWork` goes from 0 to 1). */
  onBusy?: () => void
  cancel?: (reason: Error) => void
  attached?: boolean
  reattach?: () => Promise<void>
}

export interface ExecutionContext {
  /** Shared by every step of one logical operation, and with the client that started it. */
  correlationId: string
  source: ContextSource
  /** Human-readable entry point: 'POST /api/v1/tpv/payments', 'money-integrity-watchdog', 'socket:join-room'. */
  entrypoint: string
  venueId?: string
  /**
   * The venue's name. A cuid identifies the tenant for a query; the name is what lets a
   * human read an alert and know which business it is. Resolved from an in-memory cache
   * (`venueNames.ts`), so it is absent when the venue is not known yet.
   */
  venueName?: string
  userId?: string
  role?: string
  terminalSerial?: string
  /** Present only for work that can be cancelled (the MCP guard sets it). See `RequestCancellation`. */
  cancellation?: RequestCancellation
  /**
   * Set only while Prisma prepares and runs the operations of a `$transaction([…])` BATCH of a cancellable unit
   * (`runCancellableTransaction`): the batch as a whole is the counted work, and Prisma can leave one of its operations
   * waiting forever at its internal barrier when a sibling fails — that operation must never keep the person's slot
   * taken. Nothing but Prisma's own batch machinery runs in this context (a batch has no callback, and every element
   * is checked to be a Prisma query first), so it never marks an operation that is not part of the batch. The callback
   * of an INTERACTIVE transaction gets no mark on purpose: it runs arbitrary code — root-client queries, a new
   * `$transaction` — that shares the context but not the transaction (Codex, round 5).
   */
  prismaBatch?: true
}

const storage = new AsyncLocalStorage<ExecutionContext>()

/**
 * Runs `fn` with `ctx` visible to everything it calls — across awaits, and inside callbacks
 * registered while it runs.
 *
 * Deliberately transparent: it returns whatever `fn` returns and NEVER catches. A context
 * wrapper that swallows an error would turn observability into the cause of the next
 * invisible bug. Capturing errors is a separate responsibility, handled where each path
 * already decides what to do with a failure.
 */
export function runWithContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

/** The context of the operation currently running, or undefined outside of one. */
export function getContext(): ExecutionContext | undefined {
  return storage.getStore()
}

/**
 * Runs `fn` with NO context. For process-wide machinery (a registry's alarm timer) created while some request
 * happens to be running: a timer inherits the context it was created in, and its callbacks would otherwise carry
 * that request's correlation id — and its cancellation — forever.
 */
export function runOutsideContext<T>(fn: () => T): T {
  return storage.exit(fn)
}

/**
 * Adds fields to the context that is already active.
 *
 * Mutates the stored object on purpose: authentication runs AFTER the request logger opened
 * the context, so the tenant can only be known later. That is safe because every
 * `runWithContext` call gets its own object — one request can never write into another's.
 *
 * A no-op when there is no active context, so shared services called from a script or a
 * test do not have to care whether they are inside one.
 */
export function enrichContext(patch: Partial<ExecutionContext>): void {
  const store = storage.getStore()
  if (store) Object.assign(store, patch)
}
