import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomBytes } from 'crypto'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { ScopeError, genericErrorMessage, looksInternal } from './errors'

/** Identity behind an MCP request — for attributing tool calls in the logs. */
interface ToolCallContext {
  staffId: string
  org: string
  /** Platform SUPERADMIN connection → thrown errors are passed through RAW (useful for debugging). */
  isSuperAdmin?: boolean
}

/**
 * Errors whose message was WRITTEN for the operator and is safe to hand to the AI client:
 * ScopeError (guard: out of scope / read-only connection / permission) and the app's operational
 * errors (AppError subclasses: BadRequest / NotFound / Conflict… — Spanish, user-facing by design).
 */
function isUserFacingError(err: unknown): boolean {
  if (err instanceof ScopeError) return true
  return typeof err === 'object' && err !== null && (err as { isOperational?: unknown }).isOperational === true
}

/**
 * Replace an UNEXPECTED exception with a generic message + reference id for non-superadmin
 * connections. The MCP SDK forwards `error.message` of anything a handler throws straight to the
 * client as `isError` content — so a Prisma validation error ("Invalid `prisma.venue.findMany()`
 * invocation… Argument `id`…"), a provider SDK failure or a TypeError would otherwise hand a
 * customer's assistant table/column names and stack internals. Someone probing the tools with odd
 * parameters on purpose is exactly the caller who must NOT get that. The full message stays in our
 * logs (BetterStack) and in McpToolCall.detail, keyed by the same `ref` we give the client.
 */
export function sanitizeThrownError(err: unknown, toolName: string, ctx: ToolCallContext): { error: Error; ref: string | null } {
  if (ctx.isSuperAdmin || isUserFacingError(err)) return { error: err as Error, ref: null }
  const ref = randomBytes(4).toString('hex')
  return { error: new Error(genericErrorMessage(toolName, ref)), ref }
}

/**
 * Second half of the same guarantee, for the OTHER error path: ~68 tools `catch` and RETURN
 * `text({ ok: false, error: (err as Error).message })` instead of throwing. Those never reach
 * `sanitizeThrownError`, so an ORM failure inside such a tool would still hand a customer's
 * assistant table/column names. Here we inspect the RESULT and rewrite only when the message
 * carries an internal shape (`looksInternal`) — operator-facing Spanish messages pass untouched,
 * and a result we do not rewrite is returned by IDENTITY (tools' output is never altered).
 */
export function sanitizeToolResult(result: unknown, toolName: string, ctx: ToolCallContext): { result: unknown; ref: string | null } {
  if (ctx.isSuperAdmin) return { result, ref: null }
  const r = result as { content?: Array<{ type?: string; text?: string }> } | null
  const idx = r?.content?.findIndex(c => c?.type === 'text' || typeof c?.text === 'string') ?? -1
  if (!r?.content || idx < 0) return { result, ref: null }
  const raw = r.content[idx].text
  if (typeof raw !== 'string') return { result, ref: null }
  let parsed: { ok?: boolean; error?: unknown }
  try {
    parsed = JSON.parse(raw) as { ok?: boolean; error?: unknown }
  } catch {
    return { result, ref: null } // prose content — tools only put internals in the JSON `error`
  }
  if (parsed?.ok !== false || typeof parsed.error !== 'string' || !looksInternal(parsed.error)) return { result, ref: null }
  const ref = randomBytes(4).toString('hex')
  const content = [...r.content]
  content[idx] = { ...content[idx], text: JSON.stringify({ ...parsed, error: genericErrorMessage(toolName, ref) }, null, 2) }
  return { result: { ...r, content }, ref }
}

type ToolFn = (...args: unknown[]) => unknown

/**
 * Classify a tool result: our tools return `text({ ok: true|false, ... })`, so a
 * logical failure (out of scope, permission denied, not found, ambiguous match)
 * lives as `ok:false` inside the JSON text — not the MCP `isError` flag. Detect both.
 */
function resultOutcome(result: unknown): { ok: boolean; detail?: string } {
  const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | null
  if (r?.isError) return { ok: false, detail: 'isError' }
  const firstText = r?.content?.find(c => c?.type === 'text')?.text
  if (typeof firstText === 'string') {
    try {
      const parsed = JSON.parse(firstText) as { ok?: boolean; error?: string }
      if (parsed && parsed.ok === false) return { ok: false, detail: parsed.error ?? 'ok:false' }
    } catch {
      // non-JSON prose content → treat as success
    }
  }
  return { ok: true }
}

/**
 * Persist ONE tool call to `McpToolCall` for the 12h audit cron. Fire-and-forget:
 * this is best-effort observability and must NEVER affect (block, delay past its
 * own await, or throw into) the actual tool call. METADATA ONLY — no arguments or
 * results (they carry venue/PII data), same privacy stance as the BetterStack logs.
 */
async function recordMcpCall(row: {
  toolName: string
  staffId: string | null
  orgId: string | null
  venueId: string | null
  outcome: 'ok' | 'error' | 'threw'
  detail: string | null
  durationMs: number
}): Promise<void> {
  try {
    await prisma.mcpToolCall.create({
      data: { ...row, detail: row.detail ? row.detail.slice(0, 500) : null },
    })
  } catch (err) {
    logger.warn('mcp.audit persist failed', { mcp: true, tool: row.toolName, error: (err as Error).message })
  }
}

/**
 * Wrap every `server.tool(...)` handler with structured logging so we keep a
 * record of what each operator's AI actually called and whether it worked.
 *
 * Monkey-patches `.tool` once, BEFORE the tool modules register — so current AND
 * future tools get observability for free (kept in lockstep, never an afterthought).
 *
 * We log: tool name, caller identity (staffId/org), venueId, duration, and outcome —
 * `ok` (ran fine), `returned error` (handed the AI a failure: out of scope /
 * permission denied / not found), or `threw` (unexpected exception). In production
 * this is JSON on stdout → shipped to BetterStack, queryable by `tool`/`mcp:true`.
 *
 * `venueId` is the ONLY argument we keep — it's an opaque id (already in
 * ActivityLog/logs), NOT venue data, and it lets us segment usage by `venue.type`
 * (sector) downstream, the raw material for the product/moat signal. We still
 * deliberately do NOT log other tool arguments or full results (they carry venue
 * data) — only the tool name and a short error detail. What the LLM ultimately
 * tells the user happens in their client and is not visible to us; this captures
 * everything the server itself sees.
 */
export function instrumentTools(server: McpServer, ctx: ToolCallContext): void {
  // Patch BOTH registration APIs. `tool()` (legacy) and `registerTool()` (modern)
  // are INDEPENDENT in the SDK — each calls `_createRegisteredTool()` directly, so
  // neither delegates to the other. That means (a) patching both is safe (no
  // double-wrapping / double audit rows), and (b) patching only `tool()` would let
  // any future `registerTool()` tool — e.g. what MCP Apps' registerAppTool wraps —
  // register with ZERO logging and ZERO McpToolCall rows: invisible to the 12h
  // audit, failing silently. All 221 tools use `tool()` today; this keeps the
  // audit airtight the day one doesn't.
  const patchMethod = (method: 'tool' | 'registerTool'): void => {
    const host = server as unknown as Record<string, unknown>
    if (typeof host[method] !== 'function') return // not on this SDK version → nothing to patch
    const original = (host[method] as ToolFn).bind(server) as ToolFn
    host[method] = makePatched(original, ctx)
  }
  patchMethod('tool')
  patchMethod('registerTool')
}

/**
 * Build the logging/persisting wrapper around one registration function.
 * Works for both `tool(name, ...args, cb)` and `registerTool(name, config, cb)`:
 * in BOTH signatures the tool name is the FIRST argument and the handler is the
 * LAST, which is all this needs to know.
 */
function makePatched(original: ToolFn, ctx: ToolCallContext): ToolFn {
  return (...toolArgs: unknown[]) => {
    const name = typeof toolArgs[0] === 'string' ? toolArgs[0] : 'unknown'
    const cbIndex = toolArgs.length - 1
    const cb = toolArgs[cbIndex] as ToolFn
    const base = { mcp: true as const, tool: name, staffId: ctx.staffId, org: ctx.org }
    const wrapped: ToolFn = async (...cbArgs: unknown[]) => {
      const start = Date.now()
      // The handler is called (params, extra); pull venueId from params when present.
      const params = cbArgs[0] as { venueId?: unknown } | undefined
      const venueId = typeof params?.venueId === 'string' ? params.venueId : null
      const meta = venueId ? { ...base, venueId } : base
      const audit = { toolName: name, staffId: ctx.staffId, orgId: ctx.org, venueId }
      try {
        const result = await cb(...cbArgs)
        const ms = Date.now() - start
        const { ok, detail } = resultOutcome(result)
        // Redact an internal error the tool RETURNED (ok:false) before it reaches the client.
        const { result: safe, ref } = ok ? { result, ref: null } : sanitizeToolResult(result, name, ctx)
        if (ok) logger.info(`mcp.tool ${name} ok`, { ...meta, ms })
        else logger.warn(`mcp.tool ${name} returned error`, { ...meta, ms, detail, ...(ref ? { ref } : {}) })
        void recordMcpCall({
          ...audit,
          outcome: ok ? 'ok' : 'error',
          detail: ok ? null : ref ? `[${ref}] ${detail ?? ''}` : (detail ?? null),
          durationMs: ms,
        })
        return safe
      } catch (err) {
        const ms = Date.now() - start
        const message = (err as Error).message
        const { error, ref } = sanitizeThrownError(err, name, ctx)
        logger.error(`mcp.tool ${name} threw`, { ...meta, ms, error: message, ...(ref ? { ref } : {}) })
        void recordMcpCall({ ...audit, outcome: 'threw', detail: (ref ? `[${ref}] ${message}` : message) ?? null, durationMs: ms })
        throw error
      }
    }
    toolArgs[cbIndex] = wrapped
    return original(...toolArgs)
  }
}
