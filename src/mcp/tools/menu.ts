import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'

export function registerMenuTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'set_menu_item_active',
    'Enable or disable ("86") a menu item in a venue you can access, found by name. Disabled items stop showing/selling. This WRITES — it changes the menu; requires products:update. If the name matches several items it returns the matches so you can be specific.',
    {
      venueId: z.string().describe('Venue that owns the item (must be in your scope)'),
      name: z.string().min(1).describe('Menu item name or part of it, e.g. "Carnitas"'),
      active: z.boolean().describe('true = available; false = "86" (disabled / out of stock)'),
    },
    async ({ venueId, name, active }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if out of scope
      guard.requirePermission('products:update', venueId) // write gate (per-venue role)
      const matches = await prisma.product.findMany({
        where: { ...where, name: { contains: name, mode: 'insensitive' } },
        select: { id: true, name: true, active: true },
        take: 10,
      })
      if (matches.length === 0) {
        return text({ ok: false, error: `No menu item matching "${name}" in that venue.` })
      }
      if (matches.length > 1) {
        return text({ ok: false, ambiguous: true, error: `"${name}" matches several items — be more specific.`, matches: matches.map(m => m.name) })
      }
      try {
        const updated = await updateProduct(venueId, matches[0].id, { active })
        return text({ ok: true, item: { name: updated.name, active: updated.active } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
