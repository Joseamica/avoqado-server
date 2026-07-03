import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { venuesWithFeatureAccess } from '@/services/access/basePlan.service'
import { hasPermission } from '@/services/access/access.service'

export function registerCfdiTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'cfdi_status',
    'CFDI 4.0 (facturación) status across your venues: invoice count by status (STAMPED = timbrada/issued; plus drafts, validation/stamp failures, and cancellations), the total stamped amount, and your most recent issued invoices (folio, UUID, receptor, amount). Pass venueId to focus one venue.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      limit: z.number().int().min(1).max(20).default(5).describe('Max recent stamped invoices to return'),
    },
    async ({ venueId, limit }) => {
      guard.venueFilter(venueId) // scope check (throws if a given venueId is out of scope)
      // Read gate — mirror the dashboard's checkPermission('cfdi:view'). Single-venue focus throws
      // if the caller lacks it; the all-venues path filters to venues where the caller holds it below.
      if (venueId) guard.requirePermission('cfdi:view', venueId)
      // CFDI is a PAID feature — the dashboard gates its routes with checkFeatureAccess('CFDI').
      // Mirror that so the MCP isn't a billing bypass: only surface venues entitled to CFDI.
      const entitled = await venuesWithFeatureAccess(scope.allowedVenueIds, 'CFDI')
      if (venueId && !entitled.has(venueId)) {
        return text({
          ok: false,
          planRequired: true,
          feature: 'CFDI',
          error: 'CFDI (facturación) no está activo en este local. Requiere la feature CFDI o un plan Avoqado activo.',
        })
      }
      // All-venues path: only venues where the caller actually holds cfdi:view (per-venue role),
      // so a low-role staffer can't read fiscal data org-wide that the dashboard would 403.
      const cfdiVenueIds = venueId
        ? [venueId]
        : [...entitled].filter(v => {
            const access = scope.perVenueAccess.get(v)
            return access && hasPermission(access, 'cfdi:view')
          })
      if (cfdiVenueIds.length === 0) {
        return text({ ok: false, planRequired: true, feature: 'CFDI', error: 'Ninguno de tus locales tiene CFDI (facturación) activo.' })
      }
      const where = { venueId: { in: cfdiVenueIds } }
      const grouped = await prisma.cfdi.groupBy({ by: ['status'], where, _count: { _all: true } })
      const byStatus: Record<string, number> = {}
      for (const g of grouped) byStatus[g.status] = g._count._all

      const stamped = await prisma.cfdi.aggregate({
        where: { ...where, status: 'STAMPED' },
        _sum: { totalCents: true },
        _count: { _all: true },
      })
      const recent = await prisma.cfdi.findMany({
        where: { ...where, status: 'STAMPED' },
        select: {
          serie: true,
          folio: true,
          uuid: true,
          totalCents: true,
          receptorNombre: true,
          stampedAt: true,
          venue: { select: { name: true } },
        },
        orderBy: { stampedAt: 'desc' },
        take: limit,
      })

      return text({
        venuesInScope: cfdiVenueIds.length,
        byStatus,
        stamped: { count: stamped._count._all, totalMxn: (stamped._sum.totalCents ?? 0) / 100 },
        recentStamped: recent.map(r => ({
          folio: `${r.serie ?? ''}${r.folio ?? ''}` || null,
          uuid: r.uuid,
          totalMxn: r.totalCents / 100,
          receptor: r.receptorNombre,
          stampedAt: r.stampedAt,
          venue: r.venue?.name,
        })),
      })
    },
  )
}
