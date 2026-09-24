/**
 * Guard for every `POST /mcp` request — the brake from the 2026-09-23 incident.
 *
 * That night one customer's AI assistant sent 4 MCP requests in 81 s. Each one kept the server's only
 * thread busy ~40 s, three piled up in parallel, /health stopped answering and Render killed the
 * instance. Nobody could tell WHICH tool it was: /mcp is mounted before the request logger (no execution
 * context) and `instrument.ts` records a tool only when it FINISHES — and nothing finished.
 *
 * What this guard does (founder's decision, option A; hardened after five Codex audits):
 *   1. A per-person cap: at most one tool call running at a time, and at most two MCP requests of any kind
 *      (every request rebuilds the caller's scope — 57 venues for the incident's org). A tool call over the cap is
 *      answered right away (the model reads why); a control request (`tools/list`…) waits for its turn instead.
 *      The handshake (`initialize`, `ping`) takes no slot at all: `handleMcpRequest` answers it without building
 *      the scope, so a new conversation can always connect. Notifications need no answer: 202 without building
 *      anything, exactly when the SDK itself would answer 202.
 *   2. One JSON-RPC message per POST, as MCP 2025-06-18 and 2025-11-25 require: a batch is refused (the SDK
 *      ran its calls in parallel and a `notifications/cancelled` inside it could leave a stream open).
 *   3. The cap follows the WORK, not the connection: a client that hangs up does not stop a running tool. The slot
 *      is freed only when the response is over, nothing of the request is running (handler, tool, database
 *      operations in flight) and the request has been quiet for a moment. What still runs after that is a branch
 *      the tool left behind: its reads are refused, and — if it already wrote, so it must not be cut — every
 *      database operation of it first takes the person's slot back (`reattach`, never going on without it), so it
 *      never runs alongside the person's next request. Every transaction — also one opened inside another — takes the
 *      slot back BEFORE it begins and counts as one piece of work until it settles (`runCancellableTransaction`).
 *   4. A deadline. When it passes — or when the client hangs up — the request is marked CANCELLED; the
 *      Prisma extension in `src/utils/requestCancellation.ts` then stops the work at its next read. The
 *      deadline is never switched off early, so a leftover branch is cut even after the slot was freed.
 *   5. It logs the JSON-RPC method and tool when the request STARTS, inside an execution context so every log
 *      line of the request (including `[query-guard]`) says which tool and who.
 *
 * Honest limit: synchronous CPU work that never touches the database cannot be interrupted in-process — nor can the
 * one slice a leftover branch runs between waking up and its next database operation. Only running the MCP in its
 * own service would (option B, deferred).
 *
 * Mount AFTER `express.json()` (it reads the JSON-RPC body) and BEFORE `handleMcpRequest`.
 */
import type { NextFunction, Request, Response } from 'express'
import { isJSONRPCNotification, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import logger from '@/config/logger'
import { runOutsideContext, runWithContext, type RequestCancellation } from '@/observability/executionContext'
import { newCorrelationId } from '@/observability/correlationId'
import { getVenueName } from '@/observability/venueNames'
import { RequestCancelledError } from '@/utils/requestCancellation'
import { identityOf } from './mcp-rate-limit.middleware'

/** A non-negative integer from the environment, or the fallback. */
const envInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
/** A positive integer from the environment, or the fallback. */
const envPositive = (value: string | undefined, fallback: number): number => envInt(value, fallback) || fallback

/**
 * Deadline for one MCP request. 25 s is 3× the slowest tool call ever recorded (8.2 s over 955 calls since
 * 2026-07-26; p99 2.1 s) and below Cloudflare's origin timeout (125 s by default, longer only on Enterprise).
 */
export const MCP_REQUEST_TIMEOUT_MS = envPositive(process.env.MCP_REQUEST_TIMEOUT_MS, 25_000)

/** Tool calls a single staff member may have running at once. Founder's decision: one. */
export const MCP_STAFF_MAX_CONCURRENT_TOOL_CALLS = envPositive(process.env.MCP_STAFF_MAX_CONCURRENT_TOOL_CALLS, 1)

/** MCP requests of any kind a staff member may have running at once (a tool call plus another request). */
export const MCP_STAFF_MAX_CONCURRENT_REQUESTS = envPositive(process.env.MCP_STAFF_MAX_CONCURRENT_REQUESTS, 2)

/** How long a request must stay quiet (no work starting or ending) after its answer before its slot is freed. */
export const MCP_SLOT_QUIET_MS = envInt(process.env.MCP_SLOT_QUIET_MS, 300)

/**
 * How long a control request (`tools/list`…) waits for its turn before being refused. Longer than a whole tool call
 * (its deadline), so a request waiting behind one outlasts it (Codex, round 3).
 */
export const MCP_CONTROL_WAIT_MS = envInt(process.env.MCP_CONTROL_WAIT_MS, 30_000)

/** How long a tool call waits when the only thing in its way is the previous call finishing its quiet period. */
export const MCP_TOOL_DRAIN_WAIT_MS = envInt(process.env.MCP_TOOL_DRAIN_WAIT_MS, 3_000)

/**
 * How long a leftover branch waits to take the person's slot back before its wait raises an alarm. The wait itself has
 * no exit without the slot (Codex, round 4: a deadline must escalate, never grant work without the slot). It cannot
 * deadlock: a branch only waits OUTSIDE a transaction (every live transaction of the unit is counted, so a unit without
 * its slot has none open), so it holds no row lock; the repo has no in-memory locks, and its only session-level
 * advisory lock (a try-lock in the Google Calendar pull, which may stay held after it returns) is not reachable from the
 * MCP.
 */
export const MCP_REATTACH_ALERT_MS = envPositive(process.env.MCP_REATTACH_ALERT_MS, 30_000)

/** Requests of one staff member that may wait for a turn at the same time; more are refused right away. */
const MCP_MAX_WAITERS_PER_STAFF = 4

/**
 * A slot is NEVER taken away from running work — Codex: age does not prove the work died. A slot held this long
 * only raises an alarm (once, from its own timer), because it means work that outlived its deadline by far.
 */
export const MCP_SLOT_ALERT_MS = envPositive(process.env.MCP_SLOT_ALERT_MS, 120_000)

/**
 * The handshake: answered by `handleMcpRequest` without the caller's scope (one indexed query), so it takes no slot.
 * Codex, round 3: with the person's two slots busy, the real SDK client failed its `connect()` on a 429.
 */
export const MCP_HANDSHAKE_METHODS: ReadonlySet<string> = new Set(['initialize', 'ping'])

const BUSY_TOOL_MESSAGE =
  'Ya tienes otra consulta en proceso en Avoqado. Espera a que termine y vuelve a intentarlo: ' +
  'para cuidar el servicio de las tiendas se atiende una consulta a la vez por persona.'
const BUSY_REQUEST_MESSAGE = 'Tienes demasiadas consultas en proceso en Avoqado. Espera un momento y vuelve a intentarlo.'
const BATCH_MESSAGE = 'Avoqado atiende un mensaje JSON-RPC por petición (MCP 2025-06-18 y posteriores). Envía cada llamada por separado.'

export type McpMessageKind = 'request' | 'notification' | 'batch' | 'invalid'

export interface McpMessageSummary {
  kind: McpMessageKind
  id?: string | number
  method?: string
  tool?: string
  venueId?: string
  /** Only for a batch: each message in it. */
  items?: McpMessageSummary[]
}

function describeSingle(body: unknown): McpMessageSummary {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'invalid' }
  const message = body as Record<string, unknown>
  if (typeof message.method !== 'string') return { kind: 'invalid' }

  const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined
  if (id === undefined) return { kind: 'notification', method: message.method }

  const params = message.params && typeof message.params === 'object' ? (message.params as Record<string, unknown>) : undefined
  const tool = message.method === 'tools/call' && typeof params?.name === 'string' ? params.name : undefined
  const args = params?.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : undefined
  const venueId = typeof args?.venueId === 'string' ? args.venueId : undefined
  return { kind: 'request', id, method: message.method, tool, venueId }
}

/** Reads what a JSON-RPC body asks for, without trusting its shape. Never throws. */
export function describeMcpMessage(body: unknown): McpMessageSummary {
  if (Array.isArray(body)) return { kind: 'batch', items: body.map(describeSingle) }
  return describeSingle(body)
}

/**
 * Whether the MCP SDK itself would answer this body with a bare 202: it checks Accept, Content-Type, the JSON-RPC
 * shape (with its own schema) and the protocol version, in that order. Anything it would reject goes to it, so it
 * answers with its own error (Codex, round 3: a body without `jsonrpc`, with `id: null` or with non-object params
 * got a 202 here and a 400 from the SDK).
 */
function sdkWouldAccept(req: Request): boolean {
  const accept = String(req.headers?.accept ?? '')
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return false
  if (!String(req.headers?.['content-type'] ?? '').includes('application/json')) return false
  if (!isJSONRPCNotification(req.body)) return false
  const version = req.headers?.['mcp-protocol-version']
  if (version === undefined) return true
  return SUPPORTED_PROTOCOL_VERSIONS.includes(Array.isArray(version) ? version.join(', ') : String(version))
}

interface Need {
  requests: number
  tools: number
  label: string
}

interface Hold {
  at: number
  requests: number
  tools: number
  label: string
  /** The answer already went out; the hold only waits for leftover work to go quiet. */
  draining: boolean
  alerted: boolean
  alarm?: NodeJS.Timeout
}

interface Waiter {
  retry: () => void
  /** A leftover branch taking back the slot of work that already started: served before new requests. */
  priority: boolean
}

export interface McpSlot {
  release(): void
  /** The answer is out and nothing is running: a tool call arriving now may wait for the quiet period. */
  markDraining(): void
  /** Work started again: a tool call arriving now is refused, as against any running call. */
  markBusy(): void
}

/**
 * In-memory registry of what each staff member has running (the server runs as ONE instance — see
 * `.claude/rules/una-sola-instancia.md`; with 2+ instances this moves to Redis). A request takes all it needs at
 * once or nothing. Each release is bound to its own hold. A hold is never taken away: an old one only alarms.
 */
class McpRequestSlots {
  private readonly held = new Map<string, Set<Hold>>()
  private readonly waiters = new Map<string, Set<Waiter>>()

  constructor(
    readonly maxRequests: number,
    readonly maxTools: number,
    readonly alertAfterMs: number,
  ) {}

  private alarm(staffId: string, hold: Hold, now: number): void {
    if (hold.alerted) return
    hold.alerted = true
    logger.error('mcp.cupo retenido demasiado tiempo', { mcp: true, staffId, heldMs: now - hold.at, label: hold.label })
  }

  private usage(staffId: string, now: number, excludeDraining = false): { requests: number; tools: number } {
    let requests = 0
    let tools = 0
    for (const hold of this.held.get(staffId) ?? []) {
      if (now - hold.at > this.alertAfterMs) this.alarm(staffId, hold, now)
      if (excludeDraining && hold.draining) continue
      requests += hold.requests
      tools += hold.tools
    }
    return { requests, tools }
  }

  private fits(used: { requests: number; tools: number }, need: Need): boolean {
    return used.requests + need.requests <= this.maxRequests && used.tools + need.tools <= this.maxTools
  }

  /** A slot when there is room for this staff member right now, or null. */
  tryAcquire(staffId: string, need: Need, now: number = Date.now()): McpSlot | null {
    if (!this.fits(this.usage(staffId, now), need)) return null
    const hold: Hold = { at: now, requests: need.requests, tools: need.tools, label: need.label, draining: false, alerted: false }
    const holds = this.held.get(staffId) ?? new Set<Hold>()
    holds.add(hold)
    this.held.set(staffId, holds)
    // Its own timer, so the alarm sounds even if nobody asks the registry again (Codex, round 3). Created outside any
    // request context: it may be created while another request runs, and would carry that request's context.
    hold.alarm = runOutsideContext(() => setTimeout(() => this.alarm(staffId, hold, Date.now()), this.alertAfterMs))
    hold.alarm.unref?.()

    let released = false
    return {
      markDraining: () => {
        hold.draining = true
      },
      markBusy: () => {
        hold.draining = false
      },
      release: () => {
        if (released) return
        released = true
        if (hold.alarm) clearTimeout(hold.alarm)
        const current = this.held.get(staffId)
        current?.delete(hold)
        if (current && current.size === 0) this.held.delete(staffId)
        const waiting = [...(this.waiters.get(staffId) ?? [])]
        for (const waiter of waiting) if (waiter.priority) waiter.retry()
        for (const waiter of waiting) if (!waiter.priority) waiter.retry()
      },
    }
  }

  /** True when the only holds in the way already answered and are just going quiet. */
  blockedOnlyByDraining(staffId: string, need: Need, now: number = Date.now()): boolean {
    return this.fits(this.usage(staffId, now, true), need)
  }

  waitingCount(staffId: string): number {
    return this.waiters.get(staffId)?.size ?? 0
  }

  /** Waits for room up to `timeoutMs`. Null on timeout or when `giveUp` aborts (the client left). */
  waitForRoom(
    staffId: string,
    need: Need,
    timeoutMs: number,
    giveUp?: AbortSignal,
    opts: { priority?: boolean } = {},
  ): Promise<McpSlot | null> {
    return new Promise(resolve => {
      let done = false
      const waiters = this.waiters.get(staffId) ?? new Set<Waiter>()
      this.waiters.set(staffId, waiters)
      const finish = (slot: McpSlot | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        giveUp?.removeEventListener('abort', onGiveUp)
        waiters.delete(waiter)
        if (waiters.size === 0 && this.waiters.get(staffId) === waiters) this.waiters.delete(staffId)
        resolve(slot)
      }
      const waiter: Waiter = {
        priority: opts.priority === true,
        retry: () => {
          if (done) return
          const slot = this.tryAcquire(staffId, need)
          if (slot) finish(slot)
        },
      }
      const onGiveUp = (): void => finish(null)
      const timer = setTimeout(() => finish(null), timeoutMs)
      timer.unref?.()
      giveUp?.addEventListener('abort', onGiveUp, { once: true })
      waiters.add(waiter)
      waiter.retry()
    })
  }

  /** Test hook. */
  reset(): void {
    for (const holds of this.held.values()) for (const hold of holds) if (hold.alarm) clearTimeout(hold.alarm)
    this.held.clear()
    this.waiters.clear()
  }
}

export const mcpRequestSlots = new McpRequestSlots(
  MCP_STAFF_MAX_CONCURRENT_REQUESTS,
  MCP_STAFF_MAX_CONCURRENT_TOOL_CALLS,
  MCP_SLOT_ALERT_MS,
)

/**
 * A `tools/call` is answered with a tool result flagged `isError` — the MCP spec's way of letting the MODEL
 * read why a tool failed, instead of a transport error some clients treat as a broken connection and retry.
 */
const toolErrorBody = (id: string | number | undefined, text: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result: { content: [{ type: 'text', text }], isError: true },
})
const rpcErrorBody = (id: string | number | undefined, message: string, code = -32000) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
})

/** Answers a request that will not reach the MCP server: a tool call as a tool error, anything else as JSON-RPC. */
function answer(res: Response, summary: McpMessageSummary, toolText: string, rpcMessage: string, rpcStatus: number): void {
  if (res.headersSent) return
  if (summary.kind === 'request' && summary.method === 'tools/call') {
    res.status(200).json(toolErrorBody(summary.id, toolText))
    return
  }
  res.status(rpcStatus).json(rpcErrorBody(summary.id, rpcMessage))
}

/**
 * Answers an MCP request whose work was cancelled by the brake BEFORE the MCP transport could answer it
 * (e.g. the deadline passed while resolving the caller's scope). The message is the Spanish reason.
 */
export function respondMcpCancelled(req: Request, res: Response, error: RequestCancelledError): void {
  answer(res, describeMcpMessage(req.body), error.message, error.message, 503)
}

type Outcome = 'ok' | 'cancelada' | 'cliente-se-fue'

async function guard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const summary = describeMcpMessage(req.body)
  const { staffId, activeOrg } = identityOf(req)

  if (summary.kind === 'batch') {
    logger.warn('mcp.request rechazada: lote JSON-RPC', { mcp: true, staffId, org: activeOrg, size: summary.items?.length ?? 0 })
    res.status(400).json(rpcErrorBody(undefined, BATCH_MESSAGE, -32600))
    return
  }
  if (summary.kind === 'notification' && sdkWouldAccept(req)) {
    // In this stateless server a notification changes nothing, and the spec answers it with 202 and no body.
    // Building the caller's scope for it would be pure cost.
    res.status(202).end()
    return
  }

  const isToolCall = summary.kind === 'request' && summary.method === 'tools/call'
  const isHandshake = summary.kind === 'request' && MCP_HANDSHAKE_METHODS.has(summary.method ?? '')
  const label = summary.tool ? `${summary.method} ${summary.tool}` : (summary.method ?? summary.kind)
  const need: Need = { requests: 1, tools: isToolCall ? 1 : 0, label }
  const meta = {
    mcp: true as const,
    staffId,
    org: activeOrg,
    method: summary.method,
    tool: summary.tool,
    venueId: summary.venueId,
    jsonRpcId: summary.id,
  }

  // The client may hang up while this request waits for its turn — even in the instant between being given the
  // turn and resuming (Codex, round 3). Remember it from the start: a slot never goes to a closed connection.
  let clientGone = false
  const onEarlyClose = (): void => {
    clientGone = true
  }
  res.once('close', onEarlyClose)
  const connectionClosed = (): boolean => clientGone || req.socket?.destroyed === true

  let slot: McpSlot | null = null
  if (staffId && !isHandshake) {
    slot = mcpRequestSlots.tryAcquire(staffId, need)
    // A tool call waits only when the previous call already answered and is just going quiet; a control
    // request waits its turn. A tool call against a RUNNING one is refused at once (founder's rule).
    const mayWait = !slot && !connectionClosed() && (!isToolCall || mcpRequestSlots.blockedOnlyByDraining(staffId, need))
    if (mayWait && mcpRequestSlots.waitingCount(staffId) < MCP_MAX_WAITERS_PER_STAFF) {
      const giveUp = new AbortController()
      const onClose = (): void => giveUp.abort()
      res.once('close', onClose)
      slot = await mcpRequestSlots.waitForRoom(staffId, need, isToolCall ? MCP_TOOL_DRAIN_WAIT_MS : MCP_CONTROL_WAIT_MS, giveUp.signal)
      res.off('close', onClose)
    }
  }
  res.off('close', onEarlyClose)
  if (connectionClosed()) {
    slot?.release() // nobody to answer, and nothing ran: the turn goes straight back
    return
  }
  if (staffId && !isHandshake && !slot) {
    logger.warn('mcp.request rechazada: la persona ya tiene consultas en curso', meta)
    if (!isToolCall) res.setHeader('Retry-After', '2')
    answer(res, summary, BUSY_TOOL_MESSAGE, BUSY_REQUEST_MESSAGE, 429)
    return
  }

  const controller = new AbortController()
  const cancellation: RequestCancellation = {
    signal: controller.signal,
    hasWritten: false,
    refused: false,
    activeWork: 0,
    cancel: reason => {
      if (!controller.signal.aborted) controller.abort(reason)
    },
    attached: slot ? true : undefined,
  }
  const startedAt = Date.now()
  // Never cleared early: a branch the tool left running is still cut when the deadline passes.
  const deadline = setTimeout(
    () => cancellation.cancel?.(new RequestCancelledError('timeout', MCP_REQUEST_TIMEOUT_MS)),
    MCP_REQUEST_TIMEOUT_MS,
  )
  deadline.unref?.()

  let responseEndedAt: number | null = null
  let released = false
  let endLogged = false
  let quietCheck: NodeJS.Timeout | null = null
  // The slot is freed when the answer went out, nothing of the request is running, and it has been quiet.
  const finishIfIdle = (): void => {
    if (released || responseEndedAt === null || (cancellation.activeWork ?? 0) > 0) return
    // Answer sent and nothing running: only the quiet period is left. A tool call arriving now waits it out
    // instead of being refused (while the previous call is still RUNNING it is refused).
    slot?.markDraining()
    const quietFor = Date.now() - (cancellation.lastActivityAt ?? 0)
    if (quietFor < MCP_SLOT_QUIET_MS) {
      if (quietCheck) clearTimeout(quietCheck)
      quietCheck = setTimeout(finishIfIdle, MCP_SLOT_QUIET_MS - quietFor)
      quietCheck.unref?.()
      return
    }
    released = true
    if (quietCheck) clearTimeout(quietCheck)
    if (slot) {
      slot.release()
      slot = null
      cancellation.attached = false
    }
    const reason = controller.signal.aborted ? (controller.signal.reason as RequestCancelledError | undefined)?.reason : undefined
    const outcome: Outcome = !res.writableFinished ? 'cliente-se-fue' : reason === 'timeout' ? 'cancelada' : 'ok'
    // The answer is out and nothing of the request is running: whatever of it still tries to READ is a branch the
    // tool left behind, whose result nobody will use (Codex, round 3). One that already wrote is never cut — its
    // database operations take the slot back first (`reattach`).
    cancellation.cancel?.(new RequestCancelledError('tool-finished'))
    if (endLogged) return
    endLogged = true
    logger.info('mcp.request fin', { ...meta, ms: Date.now() - startedAt, respuestaMs: responseEndedAt - startedAt, outcome })
  }
  cancellation.onIdle = finishIfIdle
  cancellation.onBusy = () => slot?.markBusy()

  if (staffId && slot) {
    const reneed: Need = { ...need, label: `${label} (rama sobrante)` }
    let reattaching: Promise<void> | null = null
    cancellation.reattach = () => {
      if (cancellation.attached !== false) return Promise.resolve()
      reattaching ??= (async () => {
        let again = mcpRequestSlots.tryAcquire(staffId, reneed)
        let alerted = false
        while (!again) {
          again = await mcpRequestSlots.waitForRoom(staffId, reneed, MCP_REATTACH_ALERT_MS, undefined, { priority: true })
          if (!again && !alerted) {
            alerted = true
            logger.error('mcp.rama desatada sigue esperando cupo', { ...meta, esperaMs: MCP_REATTACH_ALERT_MS })
          }
        }
        slot = again
        released = false
        cancellation.attached = true
        cancellation.lastActivityAt = Date.now()
        // A tool that leaves work running after it answered is a defect worth fixing: say which one.
        logger.warn('mcp.rama desatada retoma el cupo', meta)
        // If the operation that asked for the slot fails before it starts, nothing else would free the slot: check
        // again once the quiet period passes — by then that operation is running, or never will.
        if (quietCheck) clearTimeout(quietCheck)
        quietCheck = setTimeout(finishIfIdle, MCP_SLOT_QUIET_MS)
        quietCheck.unref?.()
      })().finally(() => {
        reattaching = null
      })
      return reattaching
    }
  }

  const onResponseEnded = (): void => {
    responseEndedAt ??= Date.now()
    finishIfIdle()
  }
  res.on('finish', onResponseEnded)
  res.on('close', () => {
    // The client hung up before getting an answer: nobody is waiting anymore, so stop the work at its
    // next read instead of letting it burn the thread for nothing.
    if (!res.writableFinished) cancellation.cancel?.(new RequestCancelledError('client-closed'))
    onResponseEnded()
  })

  runWithContext(
    {
      correlationId: newCorrelationId(),
      source: 'http',
      entrypoint: `POST /mcp ${label}`,
      userId: staffId,
      venueId: summary.venueId,
      venueName: getVenueName(summary.venueId),
      cancellation,
    },
    () => {
      // Inside the context, so this line carries the same correlationId as everything the request logs after.
      logger.info('mcp.request inicio', meta)
      next()
    },
  )
}

export const mcpRequestGuardMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  let passedOn = false
  const nextOnce: NextFunction = err => {
    if (passedOn) return
    passedOn = true
    next(err)
  }
  guard(req, res, nextOnce).catch(error => {
    // The guard is protection, never the reason the MCP fails: fail open (once).
    logger.error('[MCP] request guard failed', { mcp: true, error: (error as Error)?.message })
    if (!res.headersSent) nextOnce()
  })
}
