import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'

/** Pure: merge tag changes onto a customer's current tags — add, remove, dedupe (case-insensitive, keeps first-seen casing & order). */
export function applyTagChanges(current: string[], add: string[] = [], remove: string[] = []): string[] {
  const removeSet = new Set(remove.map(t => t.toLowerCase()))
  const seen = new Set<string>()
  const result: string[] = []
  for (const t of [...current, ...add]) {
    const key = t.toLowerCase()
    if (removeSet.has(key) || seen.has(key)) continue
    seen.add(key)
    result.push(t)
  }
  return result
}

export function registerCustomerTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'find_customer',
    'Find customers of a venue you can access by name, email or phone (partial, case-insensitive), OR omit the search term to list your top customers by total spent. Returns each with visits, total spent, loyalty points, tags (e.g. VIP), and contact — ranked by total spent. Answers "busca al cliente X / ¿es VIP? / ¿cuánto ha gastado?" and "¿quiénes son mis mejores clientes?". Pass venueId.',
    {
      venueId: z.string().describe('Venue whose customers to search (must be in your scope)'),
      search: z.string().optional().describe('Name, email or phone (partial). Omit to list your top customers by spend.'),
      limit: z.number().int().positive().max(25).optional().describe('Max results (default 10)'),
    },
    async ({ venueId, search, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const customers = await prisma.customer.findMany({
        where: {
          ...where,
          ...(search
            ? {
                OR: [
                  { firstName: { contains: search, mode: 'insensitive' as const } },
                  { lastName: { contains: search, mode: 'insensitive' as const } },
                  { email: { contains: search, mode: 'insensitive' as const } },
                  { phone: { contains: search } },
                ],
              }
            : {}),
        },
        select: {
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          totalVisits: true,
          totalSpent: true,
          loyaltyPoints: true,
          tags: true,
          createdAt: true,
        },
        orderBy: { totalSpent: 'desc' },
        take: limit ?? 10,
      })
      return text({
        venueId,
        count: customers.length,
        customers: customers.map(c => ({
          name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || null,
          email: c.email,
          phone: c.phone,
          visits: c.totalVisits,
          totalSpent: Number(c.totalSpent),
          loyaltyPoints: c.loyaltyPoints,
          tags: c.tags,
          since: c.createdAt.toISOString(),
        })),
      })
    },
  )

  server.tool(
    'customer_history',
    'Order history for ONE customer of a venue you can access: find them by name, email or phone, then see their recent orders (number, total, status, date) plus their lifetime summary (visits, total & average spend, loyalty points, tags). The natural drill-down after find_customer — answers "¿qué ha pedido Juan?", "¿cuándo vino por última vez?", "¿cuánto gasta por visita?". Pass venueId + a search term.',
    {
      venueId: z.string().describe('Venue whose customer to look up (must be in your scope)'),
      search: z.string().min(1).describe('Customer name, email or phone (partial, case-insensitive)'),
      limit: z.number().int().positive().max(50).optional().describe('Max recent orders to return (default 20, newest first)'),
    },
    async ({ venueId, search, limit }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const matches = await prisma.customer.findMany({
        where: {
          ...base,
          OR: [
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search } },
          ],
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          totalVisits: true,
          totalSpent: true,
          averageOrderValue: true,
          loyaltyPoints: true,
          tags: true,
          createdAt: true,
        },
        orderBy: { totalSpent: 'desc' },
        take: 5,
      })
      if (matches.length === 0) {
        return text({ found: false, message: `No encontré ningún cliente que coincida con "${search}" en este local.` })
      }

      const c = matches[0]
      const orders = await prisma.order.findMany({
        where: { ...base, customerId: c.id },
        select: { orderNumber: true, total: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 20,
      })
      return text({
        found: true,
        venueId,
        customer: {
          name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || null,
          email: c.email,
          phone: c.phone,
          visits: c.totalVisits,
          totalSpent: Number(c.totalSpent),
          averageOrderValue: Number(c.averageOrderValue),
          loyaltyPoints: c.loyaltyPoints,
          tags: c.tags,
          since: c.createdAt.toISOString(),
        },
        // If the search was ambiguous, surface the runners-up so the model can disambiguate.
        ...(matches.length > 1
          ? { otherMatches: matches.slice(1).map(m => `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || m.email || m.phone) }
          : {}),
        orderCount: orders.length,
        orders: orders.map(o => ({
          orderNumber: o.orderNumber,
          total: Number(o.total),
          status: o.status, // PENDING | CONFIRMED | PREPARING | READY | COMPLETED | CANCELLED | DELETED
          date: o.createdAt.toISOString(),
        })),
      })
    },
  )

  server.tool(
    'set_customer_tags',
    'Add and/or remove tags on a customer of a venue you can access — e.g. mark VIP, flag an allergy, note a birthday month. Find them by name/email/phone, then pass tags to add and/or remove (tags are free-text segmentation labels, merged onto their existing ones). This WRITES — it changes the customer; requires customers:update. If the search matches several customers it returns them so you can be specific. Does NOT touch money, balances or loyalty points.',
    {
      venueId: z.string().describe('Venue that owns the customer (must be in your scope)'),
      search: z.string().min(1).describe('Customer name, email or phone (partial, case-insensitive)'),
      add: z.array(z.string().min(1)).optional().describe('Tags to add, e.g. ["VIP","Alergico-Nueces"]'),
      remove: z.array(z.string().min(1)).optional().describe('Tags to remove (case-insensitive)'),
    },
    async ({ venueId, search, add, remove }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('customers:update', venueId) // write gate (per-venue role; custom roles honored)
      if (!add?.length && !remove?.length) return text({ ok: false, error: 'Pasa al menos un tag en add o remove.' })

      const matches = await prisma.customer.findMany({
        where: {
          ...base,
          OR: [
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search } },
          ],
        },
        select: { id: true, firstName: true, lastName: true, tags: true },
        orderBy: { totalSpent: 'desc' },
        take: 5,
      })
      if (matches.length === 0) {
        return text({ ok: false, error: `No encontré ningún cliente que coincida con "${search}" en este local.` })
      }
      if (matches.length > 1) {
        return text({
          ok: false,
          ambiguous: true,
          error: `"${search}" coincide con varios clientes — sé más específico.`,
          matches: matches.map(m => `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || '(sin nombre)'),
        })
      }

      const c = matches[0]
      const newTags = applyTagChanges(c.tags, add ?? [], remove ?? [])
      try {
        // Customer was resolved from a venue-scoped query, so update-by-id stays in-tenant.
        const updated = await prisma.customer.update({
          where: { id: c.id },
          data: { tags: newTags },
          select: { firstName: true, lastName: true, tags: true },
        })
        await auditMcpWrite(scope, {
          action: 'CUSTOMER_TAGS_SET',
          entity: 'Customer',
          entityId: c.id,
          venueId,
          data: { added: add ?? [], removed: remove ?? [], tags: updated.tags },
        })
        return text({
          ok: true,
          customer: { name: `${updated.firstName ?? ''} ${updated.lastName ?? ''}`.trim() || null, tags: updated.tags },
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
