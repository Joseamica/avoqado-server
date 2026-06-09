import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { createDiscount } from '@/services/dashboard/discount.dashboard.service'
import { DiscountType } from '@prisma/client'

const DISCOUNT_TYPE_MAP: Record<string, DiscountType> = {
  percentage: DiscountType.PERCENTAGE,
  fixed_amount: DiscountType.FIXED_AMOUNT,
  comp: DiscountType.COMP,
}

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

  server.tool(
    'create_discount',
    'Create a NEW discount / promotion in a venue you can access: name, type (percentage / fixed_amount / comp) and value — for percentage 0–100, for fixed_amount the money off, comp = full comp. Optionally a minimum purchase, a maximum discount cap, and whether it applies automatically. This WRITES — requires discounts:create. (Creating the promo is config; APPLYING it to a live order is a separate money-touching action.)',
    {
      venueId: z.string().describe('Venue to create the discount in (must be in your scope)'),
      name: z.string().min(1).describe('Promotion name, e.g. "2x1 martes"'),
      type: z.enum(['percentage', 'fixed_amount', 'comp']).describe('How the discount works'),
      value: z.number().min(0).describe('For percentage: 0–100. For fixed_amount: money off. For comp: ignored.'),
      description: z.string().optional().describe('Description'),
      minPurchase: z.number().min(0).optional().describe('Minimum purchase amount to qualify'),
      maxDiscount: z.number().min(0).optional().describe('Maximum discount amount (cap)'),
      automatic: z.boolean().optional().describe('Apply automatically when conditions are met'),
    },
    async ({ venueId, name, type, value, description, minPurchase, maxDiscount, automatic }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('discounts:create', venueId) // write gate (per-venue role)
      try {
        const d = await createDiscount(
          venueId,
          {
            name,
            type: DISCOUNT_TYPE_MAP[type],
            value,
            ...(description ? { description } : {}),
            ...(minPurchase !== undefined ? { minPurchaseAmount: minPurchase } : {}),
            ...(maxDiscount !== undefined ? { maxDiscountAmount: maxDiscount } : {}),
            ...(automatic !== undefined ? { isAutomatic: automatic } : {}),
          },
          scope.staffId,
        )
        await auditMcpWrite(scope, {
          action: 'DISCOUNT_CREATED',
          entity: 'Discount',
          entityId: d.id,
          venueId,
          data: { name, type: DISCOUNT_TYPE_MAP[type], value },
        })
        return text({ ok: true, discount: { id: d.id, name: d.name, type: DISCOUNT_TYPE_MAP[type], value } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
