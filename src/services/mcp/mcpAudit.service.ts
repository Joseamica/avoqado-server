/**
 * MCP audit service — turns the raw `McpToolCall` rows (persisted by
 * `src/mcp/instrument.ts`) into a "bad MCP experience" report.
 *
 * WHAT WE CAN SEE vs CANNOT (important — this is the honest ceiling):
 *  - We DO NOT receive the user's natural-language question, nor the model's
 *    natural-language answer. Those live in the operator's ChatGPT/Claude and
 *    never touch our server. So we CANNOT grade "the answer text was wrong".
 *  - We DO receive every structured tool call + its outcome. So we CAN infer a
 *    bad experience from SIGNALS: the tool erred / threw, permission was denied,
 *    the tool returned "not found / out of scope" (our tools encode that as
 *    `ok:false`, captured here as outcome 'error'), or the caller hammered a
 *    failing tool (retry burst).
 *
 * This service is pure/deterministic (easy to unit-test); the cron
 * (`src/jobs/mcp-conversation-audit.job.ts`) does the DB read + notification.
 */

import prisma from '../../utils/prismaClient'

/** One persisted MCP tool call (mirrors the `McpToolCall` Prisma model). */
export interface McpCallRow {
  toolName: string
  staffId: string | null
  orgId: string | null
  venueId: string | null
  outcome: string // 'ok' | 'error' | 'threw'
  detail: string | null
  durationMs: number
  createdAt: Date
}

export interface ToolFailureGroup {
  toolName: string
  count: number
  /** Distinct short reasons seen for this tool's failures (deduped). */
  reasons: string[]
}

export interface RetryBurst {
  staffId: string | null
  toolName: string
  count: number
  /** The (deduped) failure reasons seen during the burst. */
  reasons: string[]
}

export interface BadMcpExperienceReport {
  windowHours: number
  totalCalls: number
  okCalls: number
  failedCalls: number // outcome 'error' + 'threw'
  errorRate: number // failedCalls / totalCalls, 0..1 (0 when no calls)
  permissionDenied: ToolFailureGroup[]
  failuresByTool: ToolFailureGroup[]
  retryBursts: RetryBurst[]
  affectedVenueIds: string[]
  affectedStaffIds: string[]
  /** True when there is at least one bad signal worth surfacing to the founder. */
  hasSignal: boolean
}

const OK = 'ok'

/** A tool call is a "bad experience" candidate when it did not run cleanly. */
function isFailure(call: McpCallRow): boolean {
  return call.outcome !== OK
}

/** Heuristic: does the failure reason look like a permission/authorization denial? */
function looksLikePermissionDenied(detail: string | null): boolean {
  if (!detail) return false
  const d = detail.toLowerCase()
  return (
    d.includes('permission') ||
    d.includes('permiso') ||
    d.includes('denied') ||
    d.includes('denegad') ||
    d.includes('no autoriz') ||
    d.includes('unauthorized') ||
    d.includes('forbidden') ||
    d.includes('403')
  )
}

function dedupeReasons(reasons: Array<string | null>): string[] {
  return [...new Set(reasons.filter((r): r is string => !!r))]
}

/**
 * Detect bad MCP experiences from a flat list of tool calls (one audit window).
 *
 * @param calls  the tool calls in the window
 * @param opts.windowHours          the window these calls were pulled from (for reporting)
 * @param opts.retryBurstThreshold  N failures of the same (staff, tool) to count as a burst (default 4)
 */
export function detectBadMcpExperiences(
  calls: McpCallRow[],
  opts?: { windowHours?: number; retryBurstThreshold?: number },
): BadMcpExperienceReport {
  const windowHours = opts?.windowHours ?? 12
  const retryBurstThreshold = opts?.retryBurstThreshold ?? 4

  const totalCalls = calls.length
  const failures = calls.filter(isFailure)
  const failedCalls = failures.length
  const okCalls = totalCalls - failedCalls
  const errorRate = totalCalls === 0 ? 0 : failedCalls / totalCalls

  // Failures grouped by tool (top offenders first).
  const byTool = new Map<string, McpCallRow[]>()
  for (const f of failures) {
    const list = byTool.get(f.toolName) ?? []
    list.push(f)
    byTool.set(f.toolName, list)
  }
  const failuresByTool: ToolFailureGroup[] = [...byTool.entries()]
    .map(([toolName, list]) => ({ toolName, count: list.length, reasons: dedupeReasons(list.map(c => c.detail)) }))
    .sort((a, b) => b.count - a.count)

  // Permission-denied subset (a distinct, high-signal "the MCP couldn't help them").
  const permByTool = new Map<string, McpCallRow[]>()
  for (const f of failures) {
    if (!looksLikePermissionDenied(f.detail)) continue
    const list = permByTool.get(f.toolName) ?? []
    list.push(f)
    permByTool.set(f.toolName, list)
  }
  const permissionDenied: ToolFailureGroup[] = [...permByTool.entries()]
    .map(([toolName, list]) => ({ toolName, count: list.length, reasons: dedupeReasons(list.map(c => c.detail)) }))
    .sort((a, b) => b.count - a.count)

  // Retry bursts: same caller hammering the same failing tool → likely frustration.
  const byStaffTool = new Map<string, McpCallRow[]>()
  for (const f of failures) {
    const key = `${f.staffId ?? 'unknown'}::${f.toolName}`
    const list = byStaffTool.get(key) ?? []
    list.push(f)
    byStaffTool.set(key, list)
  }
  const retryBursts: RetryBurst[] = [...byStaffTool.values()]
    .filter(list => list.length >= retryBurstThreshold)
    .map(list => ({
      staffId: list[0].staffId,
      toolName: list[0].toolName,
      count: list.length,
      reasons: dedupeReasons(list.map(c => c.detail)),
    }))
    .sort((a, b) => b.count - a.count)

  const affectedVenueIds = [...new Set(failures.map(f => f.venueId).filter((v): v is string => !!v))]
  const affectedStaffIds = [...new Set(failures.map(f => f.staffId).filter((s): s is string => !!s))]

  return {
    windowHours,
    totalCalls,
    okCalls,
    failedCalls,
    errorRate,
    permissionDenied,
    failuresByTool,
    retryBursts,
    affectedVenueIds,
    affectedStaffIds,
    hasSignal: failedCalls > 0,
  }
}

/**
 * Human-readable summary lines for the audit log / (future) email. Pure formatter.
 * Returns a single "todo bien" line when there is no signal.
 */
export function summarizeBadMcpReport(report: BadMcpExperienceReport): string[] {
  if (!report.hasSignal) {
    return [`✅ MCP sano en las últimas ${report.windowHours}h — ${report.totalCalls} llamadas, 0 fallos.`]
  }
  const pct = (report.errorRate * 100).toFixed(0)
  const lines: string[] = [
    `⚠️ Experiencias malas del MCP en las últimas ${report.windowHours}h — ${report.failedCalls}/${report.totalCalls} llamadas fallaron (${pct}%).`,
  ]
  if (report.permissionDenied.length > 0) {
    const tools = report.permissionDenied.map(g => `${g.toolName} (${g.count})`).join(', ')
    lines.push(`  • Permiso denegado: ${tools}`)
  }
  if (report.failuresByTool.length > 0) {
    const top = report.failuresByTool
      .slice(0, 5)
      .map(g => `${g.toolName} ×${g.count} [${g.reasons.slice(0, 3).join(' | ') || 'sin detalle'}]`)
      .join('; ')
    lines.push(`  • Tools con fallos: ${top}`)
  }
  if (report.retryBursts.length > 0) {
    const bursts = report.retryBursts.map(b => `${b.toolName}×${b.count} (staff ${b.staffId ?? '?'})`).join('; ')
    lines.push(`  • Reintentos/frustración: ${bursts}`)
  }
  if (report.affectedVenueIds.length > 0) {
    lines.push(`  • Venues afectados: ${report.affectedVenueIds.length} (${report.affectedVenueIds.slice(0, 10).join(', ')})`)
  }
  return lines
}

/**
 * Read the MCP tool calls from the last `hoursBack` hours. Pure DB read (no
 * side effects) so the cron can wrap it with `retry(shouldRetryDbConnectionError)`.
 */
export async function getRecentMcpCalls(hoursBack: number): Promise<McpCallRow[]> {
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000)
  return prisma.mcpToolCall.findMany({
    where: { createdAt: { gte: since } },
    select: { toolName: true, staffId: true, orgId: true, venueId: true, outcome: true, detail: true, durationMs: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
}
