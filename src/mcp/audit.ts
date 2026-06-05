import { logAction } from '@/services/dashboard/activity-log.service'
import type { McpScope } from './scope'

/**
 * Audit a write performed through the customer MCP.
 *
 * Attributes the mutation to the connected staff (`scope.staffId` — a real Staff
 * id, so the FK holds) and tags it `source: 'customer-mcp'` so AI-driven changes
 * are distinguishable from dashboard/TPV writes in the audit trail. Every MCP
 * write tool MUST call this on success — same lockstep rule as permissions.
 *
 * Non-blocking by contract: `logAction` swallows its own errors, so a failed
 * audit write never fails the tool call.
 */
export async function auditMcpWrite(
  scope: McpScope,
  params: { action: string; entity: string; entityId: string; venueId: string; data?: Record<string, unknown> },
): Promise<void> {
  await logAction({
    staffId: scope.staffId,
    venueId: params.venueId,
    action: params.action,
    entity: params.entity,
    entityId: params.entityId,
    data: { ...params.data, source: 'customer-mcp' },
  })
}
