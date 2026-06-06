import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export function registerDiscountTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_discounts',
    'Discounts & promotions configured in a venue you can access: name, type (PERCENTAGE = % off, FIXED_AMOUNT = money off, COMP = comp), value, conditions (minimum purchase, max discount, uses per customer), whether active, and how many coupon codes it has. Defaults to active ones. Answers "¿qué promociones / descuentos tengo activos?". Pass venueId.',
    {
      venueId: z.string().describe('Venue whose discounts to list (must be in your scope)'),
      includeInactive: z.boolean().optional().describe('Also include inactive/deactivated discounts'),
      limit: z.number().int().positive().max(100).optional().describe('Max to return (default 50)'),
    },
    async ({ venueId, includeInactive, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const discounts = await prisma.discount.findMany({
        where: { ...where, ...(includeInactive ? {} : { active: true }) },
        select: {
          name: true,
          type: true,
          value: true,
          minPurchaseAmount: true,
          maxDiscountAmount: true,
          maxUsesPerCustomer: true,
          active: true,
          deactivatedReason: true,
          _count: { select: { couponCodes: true } },
        },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        take: limit ?? 50,
      })
      return text({
        venueId,
        count: discounts.length,
        discounts: discounts.map(d => ({
          name: d.name,
          type: d.type, // PERCENTAGE | FIXED_AMOUNT | COMP
          value: Number(d.value), // % (0–100) for PERCENTAGE, else money amount
          minPurchase: d.minPurchaseAmount != null ? Number(d.minPurchaseAmount) : null,
          maxDiscount: d.maxDiscountAmount != null ? Number(d.maxDiscountAmount) : null,
          maxUsesPerCustomer: d.maxUsesPerCustomer,
          active: d.active,
          couponCodes: d._count.couponCodes,
          ...(d.deactivatedReason ? { deactivatedReason: d.deactivatedReason } : {}),
        })),
      })
    },
  )
}
