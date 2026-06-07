import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'
import { auditMcpWrite } from '../audit'

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Find products in scope by (partial, case-insensitive) name — shared by the menu tools. */
async function matchProductsByName(venueWhere: { venueId: { in: string[] } }, name: string) {
  return prisma.product.findMany({
    where: { ...venueWhere, name: { contains: name, mode: 'insensitive' } },
    select: { id: true, name: true, active: true, price: true },
    take: 10,
  })
}

export function registerMenuTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_menu',
    'List the menu items of a venue you can access: name, price, whether it is active ("86" = disabled), category and type. Optionally filter by name or only available items. Pass venueId. Handy to look up exact names/prices before changing them.',
    {
      venueId: z.string().describe('Venue whose menu to list (must be in your scope)'),
      search: z.string().optional().describe('Filter by item name (partial, case-insensitive)'),
      activeOnly: z.boolean().optional().describe('Only available items (exclude "86"/disabled)'),
      limit: z.number().int().positive().max(200).optional().describe('Max items to return (default 100)'),
    },
    async ({ venueId, search, activeOnly, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const products = await prisma.product.findMany({
        where: {
          ...where,
          ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
          ...(activeOnly ? { active: true } : {}),
        },
        select: { name: true, price: true, active: true, type: true, category: { select: { name: true } } },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        take: limit ?? 100,
      })
      return text({
        venueId,
        count: products.length,
        items: products.map(p => ({
          name: p.name,
          price: Number(p.price),
          active: p.active,
          type: p.type,
          category: p.category?.name ?? null,
        })),
      })
    },
  )

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
      const matches = await matchProductsByName(where, name)
      if (matches.length === 0) return text({ ok: false, error: `No menu item matching "${name}" in that venue.` })
      if (matches.length > 1)
        return text({
          ok: false,
          ambiguous: true,
          error: `"${name}" matches several items — be more specific.`,
          matches: matches.map(m => m.name),
        })
      try {
        const updated = await updateProduct(venueId, matches[0].id, { active })
        await auditMcpWrite(scope, {
          action: 'MENU_ITEM_ACTIVE_SET',
          entity: 'Product',
          entityId: matches[0].id,
          venueId,
          data: { name: updated.name, active: updated.active },
        })
        return text({ ok: true, item: { name: updated.name, active: updated.active } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'set_menu_item_price',
    'Change the price of a menu item in a venue you can access, found by name. Price is in the venue currency (major units, e.g. 120 = $120.00). This WRITES — it changes the price; requires products:update. If the name matches several items it returns the matches so you can be specific.',
    {
      venueId: z.string().describe('Venue that owns the item (must be in your scope)'),
      name: z.string().min(1).describe('Menu item name or part of it, e.g. "Carnitas"'),
      price: z.number().positive().describe('New price in major units (e.g. 120 for $120.00)'),
    },
    async ({ venueId, name, price }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if out of scope
      guard.requirePermission('products:update', venueId) // write gate (per-venue role)
      const matches = await matchProductsByName(where, name)
      if (matches.length === 0) return text({ ok: false, error: `No menu item matching "${name}" in that venue.` })
      if (matches.length > 1)
        return text({
          ok: false,
          ambiguous: true,
          error: `"${name}" matches several items — be more specific.`,
          matches: matches.map(m => m.name),
        })
      try {
        const updated = await updateProduct(venueId, matches[0].id, { price })
        await auditMcpWrite(scope, {
          action: 'MENU_ITEM_PRICE_SET',
          entity: 'Product',
          entityId: matches[0].id,
          venueId,
          data: { name: updated.name, price: Number(updated.price) },
        })
        return text({ ok: true, item: { name: updated.name, price: Number(updated.price) } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'menu_item_detail',
    'Full detail of ONE menu item in a venue you can access, found by name: description, category, type, price, cost & margin (ONLY if a real cost is set on the item — never estimated), prep time, calories, whether it is active ("86"), how its stock is tracked, and its modifier/option groups (each option with its extra price). The drill-down after list_menu — answers "¿qué lleva / qué opciones tiene / cuánto me deja la X?". If the name matches several items it returns them so you can be specific.',
    {
      venueId: z.string().describe('Venue that owns the item (must be in your scope)'),
      name: z.string().min(1).describe('Menu item name or part of it, e.g. "Hamburguesa"'),
    },
    async ({ venueId, name }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if out of scope
      const matches = await matchProductsByName(where, name)
      if (matches.length === 0) return text({ found: false, error: `No menu item matching "${name}" in that venue.` })
      if (matches.length > 1)
        return text({
          found: false,
          ambiguous: true,
          error: `"${name}" matches several items — be more specific.`,
          matches: matches.map(m => m.name),
        })

      const p = await prisma.product.findFirst({
        where: { id: matches[0].id, ...where },
        select: {
          name: true,
          sku: true,
          description: true,
          type: true,
          price: true,
          cost: true,
          active: true,
          prepTime: true,
          calories: true,
          imageUrl: true,
          trackInventory: true,
          inventoryMethod: true,
          category: { select: { name: true } },
          modifierGroups: {
            select: {
              group: {
                select: {
                  name: true,
                  required: true,
                  allowMultiple: true,
                  minSelections: true,
                  maxSelections: true,
                  modifiers: { where: { active: true }, select: { name: true, price: true }, orderBy: { name: 'asc' } },
                },
              },
            },
            orderBy: { displayOrder: 'asc' },
          },
        },
      })
      if (!p) return text({ found: false, error: 'Item not found, or it is outside your venues' })

      const price = Number(p.price)
      const cost = p.cost == null ? null : Number(p.cost)
      return text({
        found: true,
        item: {
          name: p.name,
          sku: p.sku,
          description: p.description,
          type: p.type,
          category: p.category?.name ?? null,
          price,
          cost, // real stored cost, or null if none is set — NEVER estimated
          margin: cost != null && price > 0 ? { amount: round2(price - cost), percent: round2(((price - cost) / price) * 100) } : null,
          active: p.active,
          prepTimeMinutes: p.prepTime,
          calories: p.calories,
          hasImage: !!p.imageUrl,
          inventoryTracking: p.trackInventory ? p.inventoryMethod : null,
          modifierGroups: p.modifierGroups.map(mg => ({
            name: mg.group.name,
            required: mg.group.required,
            allowMultiple: mg.group.allowMultiple,
            min: mg.group.minSelections,
            max: mg.group.maxSelections,
            options: mg.group.modifiers.map(m => ({ name: m.name, extraPrice: Number(m.price) })),
          })),
        },
      })
    },
  )

  server.tool(
    'menu_categories',
    'The menu categories of a venue you can access: name, description, whether active, and how many products are in each. Defaults to active categories. Answers "¿qué categorías de menú tengo?". Pass venueId. (For the items themselves use list_menu.)',
    {
      venueId: z.string().describe('Venue whose menu categories to list (must be in your scope)'),
      includeInactive: z.boolean().optional().describe('Also include inactive categories'),
    },
    async ({ venueId, includeInactive }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const cats = await prisma.menuCategory.findMany({
        where: { ...where, ...(includeInactive ? {} : { active: true }) },
        select: { name: true, description: true, active: true, _count: { select: { products: true } } },
        orderBy: { displayOrder: 'asc' },
      })
      return text({
        venueId,
        count: cats.length,
        categories: cats.map(c => ({ name: c.name, description: c.description, active: c.active, products: c._count.products })),
      })
    },
  )
}
