import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export function registerLoyaltyTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'loyalty_status',
    'The loyalty / rewards program settings for a venue you can access: whether it is active, points earned per dollar spent and per visit, the redemption rate (money value of one point), the minimum points needed to redeem, and after how many days points expire. Answers "¿cómo funciona mi programa de recompensas? ¿cuántos puntos doy por compra?". Pass venueId. (A specific customer\'s point balance is in find_customer.)',
    {
      venueId: z.string().describe('Venue whose loyalty program to read (must be in your scope)'),
    },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      // Read the config directly (NOT the get-or-create service) so this read never writes a default row.
      const cfg = await prisma.loyaltyConfig.findFirst({
        where,
        select: {
          active: true,
          pointsPerDollar: true,
          pointsPerVisit: true,
          redemptionRate: true,
          minPointsRedeem: true,
          pointsExpireDays: true,
        },
      })
      return text({
        venueId,
        configured: !!cfg,
        program: cfg
          ? {
              active: cfg.active,
              pointsPerDollar: Number(cfg.pointsPerDollar),
              pointsPerVisit: cfg.pointsPerVisit,
              redemptionRate: Number(cfg.redemptionRate), // money value of 1 point
              minPointsToRedeem: cfg.minPointsRedeem,
              pointsExpireDays: cfg.pointsExpireDays, // null = never expire
            }
          : null,
      })
    },
  )
}
