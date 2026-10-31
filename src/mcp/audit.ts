import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { runWithoutCancellation } from '@/utils/requestCancellation'
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
  // `venueId: null` only for platform records that belong to no venue (superadmin price lists and promotions).
  params: {
    action: string
    entity: string
    entityId: string
    venueId: string | null
    organizationId?: string
    data?: Record<string, unknown>
  },
): Promise<void> {
  await logAction({
    staffId: scope.staffId,
    venueId: params.venueId,
    organizationId: params.organizationId,
    action: params.action,
    entity: params.entity,
    entityId: params.entityId,
    data: { ...params.data, ...(await mcpProvenance(scope)) },
  })
}

/**
 * La procedencia MCP de una escritura (`source` + la app): para la escritura que ya deja su PROPIA entrada de bitácora y no
 * debe dejar otra (`cancel_unpaid_order`, Codex «Cancelar orden» código r2 #2). Va al final de sus datos, como aquí.
 */
export async function mcpProvenance(scope: McpScope): Promise<Record<string, string>> {
  return { source: 'customer-mcp', ...(await mcpClientStamp(scope.clientId)) }
}

/**
 * Qué app hizo la escritura (founder, 15-oct-2026: evidencia si un cliente dice «yo no fui»): su id, que se verifica
 * contra su registro OAuth (`mcp_oauth_clients`, con sus redirect URIs), y el nombre con el que se registró, leído
 * ahora. Va DESPUÉS de los datos de la herramienta: ninguna puede declarar otra app. Best effort: si la lectura falla
 * queda el id, y nunca tumba la herramienta.
 */
async function mcpClientStamp(clientId: string | undefined): Promise<Record<string, string>> {
  if (!clientId) return {}
  try {
    // Contabilidad, no trabajo de la herramienta: fuera del freno (como la fila de McpToolCall). Si el freno la
    // rechazara, este catch se tragaría el corte y la respuesta de una escritura YA hecha saldría como cancelada.
    const row = await runWithoutCancellation(() => prisma.mcpOAuthClient.findUnique({ where: { clientId }, select: { clientName: true } }))
    return row?.clientName ? { mcpClientId: clientId, mcpClientName: row.clientName } : { mcpClientId: clientId }
  } catch {
    return { mcpClientId: clientId }
  }
}
