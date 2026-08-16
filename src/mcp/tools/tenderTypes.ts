/**
 * TENDER TYPES — tipos de pago personalizados (VenueTenderType, catálogo core/FREE).
 *
 * Read-only in slice A1 (list_tender_types). Creating/editing is done from the
 * dashboard; when writes are exposed here they will be two-step confirm-gated
 * (MCP invariant #4). Money reporting per tender (commission report) is slice B.
 * Scoped to the operator's venues + requirePermission('tender-types:read').
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listTenderTypes } from '@/services/dashboard/tenderType.dashboard.service'
import { createGuard } from '../guard'
import { text } from '../respond'
import type { McpScope } from '../scope'

export function registerTenderTypeTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)

  server.tool(
    'list_tender_types',
    'List the tender-type catalog of a venue (tipos de pago): the system rows (Efectivo, Tarjetas, Transferencia) plus any custom types the business created (e.g. "Uber Eats", "Vale de despensa"). Shows for each: whether it physically enters the cash drawer (countsAsPhysicalCash), whether the POS captures a tip with it, its POS section (PRIMARY = first-level, MORE = behind "Más"), its commercial commission percent (what the platform/issuer keeps — informational, not a processor fee), its SAT c_FormaPago code for invoicing (null = not individually invoiceable), and whether it is active (disabled rows stay listed on purpose). Read-only — requires tender-types:read.',
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('tender-types:read', venueId)
      const tenderTypes = await listTenderTypes(venueId)
      return text({
        ok: true,
        tenderTypes: tenderTypes.map(t => ({
          id: t.id,
          name: t.name,
          isSystem: t.isSystem,
          baseMethod: t.baseMethod,
          countsAsPhysicalCash: t.countsAsPhysicalCash,
          captureTip: t.captureTip,
          showOnPos: t.showOnPos,
          posSection: t.posSection,
          displayOrder: t.displayOrder,
          commissionPercent: t.commissionPercent ? Number(t.commissionPercent) : null,
          satFormaPago: t.satFormaPago,
          active: t.active,
          revision: t.revision,
        })),
        nota: 'Los tipos personalizados registran el cobro con method=OTHER; el nombre es la capa de reporte (paridad Square). Los POS aún no los muestran (slice B pendiente).',
      })
    },
  )
}
