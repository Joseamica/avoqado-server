import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { OrderStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const num = (d: { toString(): string } | null): number => (d == null ? 0 : Number(d))
const round2 = (n: number): number => Math.round(n * 100) / 100

export function registerProductTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'product_sales',
    'How much of ONE product / menu item a venue you can access has sold over a period (default last 30 days): units sold, revenue, and how many times it was ordered — counting line items on real (non-cancelled) orders. Find it by name. The targeted complement to top_products (which ranks the best sellers) — answers "¿cuántas hamburguesas vendí esta semana? ¿cuánto facturé de X?". If the name matches several products it returns them so you can be specific. Pass venueId + name; optionally fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue that owns the product (must be in your scope)'),
      name: z.string().min(1).describe('Product / menu item name or part of it, e.g. "Hamburguesa"'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 30 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
    },
    async ({ venueId, name, fromDate, toDate }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      const start = venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
      const end = venueEndOfDay(tz, toDate ? new Date(`${toDate}T12:00:00`) : undefined)

      const matches = await prisma.product.findMany({
        where: { ...base, name: { contains: name, mode: 'insensitive' as const } },
        select: { id: true, name: true },
        take: 10,
      })
      if (matches.length === 0) return text({ found: false, error: `No product matching "${name}" in that venue.` })
      if (matches.length > 1) {
        return text({
          found: false,
          ambiguous: true,
          error: `"${name}" matches several products — be more specific.`,
          matches: matches.map(m => m.name),
        })
      }

      const agg = await prisma.orderItem.aggregate({
        where: {
          productId: matches[0].id,
          // scope + date + "real sale" all enforced through the parent order
          order: { ...base, createdAt: { gte: start, lte: end }, status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] } },
        },
        _sum: { quantity: true, total: true },
        _count: { _all: true },
      })

      return text({
        found: true,
        product: matches[0].name,
        venueId,
        window: { start: start.toISOString(), end: end.toISOString() },
        timezone: tz,
        unitsSold: agg._sum.quantity ?? 0,
        revenue: round2(num(agg._sum.total)),
        timesOrdered: agg._count._all, // line-item appearances across orders
      })
    },
  )
}
