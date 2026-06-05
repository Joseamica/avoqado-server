import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

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
      const where = guard.venueFilter(venueId) // throws if out of scope
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
        venuesInScope: venueId ? 1 : scope.allowedVenueIds.length,
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
