/**
 * TENDER TYPES — tipos de pago personalizados (VenueTenderType, catálogo core/FREE).
 *
 * Read-only: `list_tender_types` (catálogo) y `tender_commissions` (cuánto costó cada tipo).
 * Crear/editar se hace desde el dashboard; cuando se expongan escrituras aquí irán
 * confirm-gated en dos pasos (invariante #4 del MCP).
 * Scoped to the operator's venues + requirePermission('tender-types:read').
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listTenderTypes, getTenderCommissionsReport } from '@/services/dashboard/tenderType.dashboard.service'
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
        nota: 'Los tipos personalizados registran el cobro con method=OTHER; el nombre es la capa de reporte (paridad Square). El POS ya los muestra al cobrar.',
      })
    },
  )

  server.tool(
    'tender_commissions',
    "Report how much commission the business PAID per tender type over a date range — answers \"how much did Uber Eats charge me this month?\". Returns, per tender: number of charges, gross sales (tip excluded), commission paid, and net kept. Amounts are in PESOS (major units). The commission is the amount FROZEN on each charge at the time it was taken, never recalculated with today's percentage — so changing a tender's commission does not rewrite last month's cost. Counts every completed charge that is not a refund — INCLUDING the counter quick-sale (FAST), which is where these tender types are used most; refunds are excluded because they do not carry a commission today. Dates are VENUE-LOCAL (YYYY-MM-DD); omit them for the last 30 days. Read-only — requires tender-types:read.",
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
      from: z.string().optional().describe('Start date YYYY-MM-DD, venue-local. Omit for the last 30 days.'),
      to: z.string().optional().describe('End date YYYY-MM-DD, venue-local (inclusive).'),
    },
    async ({ venueId, from, to }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('tender-types:read', venueId)
      const report = await getTenderCommissionsReport(venueId, { from, to })
      return text({
        ok: true,
        desde: report.from.toISOString(),
        hasta: report.to.toISOString(),
        tipos: report.rows.map(r => ({
          tipo: r.tenderLabel,
          cobros: r.count,
          ventaBruta: r.gross,
          comisionPagada: r.commission,
          neto: r.net,
        })),
        totales: { ventaBruta: report.totalGross, comisionPagada: report.totalCommission, neto: report.totalNet },
        nota: 'Montos en PESOS. La comisión es la CONGELADA en cada cobro, no un recálculo con el porcentaje actual. No incluye reembolsos.',
      })
    },
  )
}
