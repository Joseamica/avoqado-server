import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import logger from '@/config/logger'

/** Identity behind an MCP request — for attributing tool calls in the logs. */
interface ToolCallContext {
  staffId: string
  org: string
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
  const original = server.tool.bind(server) as unknown as ToolFn
  const patched: ToolFn = (...toolArgs: unknown[]) => {
    const name = typeof toolArgs[0] === 'string' ? toolArgs[0] : 'unknown'
    const cbIndex = toolArgs.length - 1
    const cb = toolArgs[cbIndex] as ToolFn
    const base = { mcp: true as const, tool: name, staffId: ctx.staffId, org: ctx.org }
    const wrapped: ToolFn = async (...cbArgs: unknown[]) => {
      const start = Date.now()
      // The handler is called (params, extra); pull venueId from params when present.
      const params = cbArgs[0] as { venueId?: unknown } | undefined
      const meta = typeof params?.venueId === 'string' ? { ...base, venueId: params.venueId } : base
      try {
        const result = await cb(...cbArgs)
        const ms = Date.now() - start
        const { ok, detail } = resultOutcome(result)
        if (ok) logger.info(`mcp.tool ${name} ok`, { ...meta, ms })
        else logger.warn(`mcp.tool ${name} returned error`, { ...meta, ms, detail })
        return result
      } catch (err) {
        const ms = Date.now() - start
        logger.error(`mcp.tool ${name} threw`, { ...meta, ms, error: (err as Error).message })
        throw err
      }
    }
    toolArgs[cbIndex] = wrapped
    return original(...toolArgs)
  }
  ;(server as unknown as { tool: ToolFn }).tool = patched
}
