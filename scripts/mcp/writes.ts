import fs from 'fs'
import path from 'path'
import { text, describeDbTarget } from './context'

/**
 * Resolve the acting staff id for a write:
 *   explicit `performedBy` param → env `MCP_ADMIN_STAFF_ID` → throw.
 * The staff id is per-DB, so it must live in the same .env as DATABASE_URL.
 */
export function resolveActor(performedBy?: string): string {
  const id = performedBy ?? process.env.MCP_ADMIN_STAFF_ID
  if (!id) {
    throw new Error('No actor staff id. Pass performedBy, or set MCP_ADMIN_STAFF_ID in the .env that matches your DATABASE_URL.')
  }
  return id
}

const AUDIT_LOG = path.resolve(process.cwd(), 'logs/mcp-admin-audit.log')

/** Append a one-line JSON record of a mutation to the local audit log (best-effort). */
export function auditWrite(entry: { tool: string; actor: string; args: unknown; result: unknown }): void {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true })
    const line = JSON.stringify({ ts: new Date().toISOString(), dbTarget: describeDbTarget(), ...entry })
    fs.appendFileSync(AUDIT_LOG, line + '\n')
  } catch {
    // never block the operation on an audit-logging failure
  }
}

/**
 * Two-phase write gate.
 * - confirm=false → return a PREVIEW (what will change + DB target); mutate nothing.
 * - confirm=true  → run execute(), append an audit line, return the result.
 */
export async function confirmGuard(opts: {
  tool: string
  actor: string
  confirm: boolean
  preview: Record<string, unknown>
  args: unknown
  execute: () => Promise<unknown>
}) {
  if (!opts.confirm) {
    return text({
      status: 'PREVIEW — nothing changed',
      dbTarget: describeDbTarget(),
      willChange: opts.preview,
      note: 'Re-run this tool with confirm:true to execute.',
    })
  }
  const result = await opts.execute()
  auditWrite({ tool: opts.tool, actor: opts.actor, args: opts.args, result })
  return text({ status: 'DONE', dbTarget: describeDbTarget(), result })
}
