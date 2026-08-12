import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Where a unit of work started. Lets an investigation filter "everything that came from a
 * cron tick" apart from "everything that came from a terminal".
 */
export type ContextSource = 'http' | 'job' | 'rabbit' | 'socket'

export interface ExecutionContext {
  /** Shared by every step of one logical operation, and with the client that started it. */
  correlationId: string
  source: ContextSource
  /** Human-readable entry point: 'POST /api/v1/tpv/payments', 'money-integrity-watchdog', 'socket:join-room'. */
  entrypoint: string
  venueId?: string
  userId?: string
  role?: string
  terminalSerial?: string
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
