import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getCustomerGroups, getCustomerGroupById } from '@/services/dashboard/customerGroup.dashboard.service'

// Customer groups (segments) are core customer data — no plan/feature gate, only the
// customer-groups:read permission (exactly like the dashboard route). Money in PESOS, 1:1.
const round2 = (n: number) => Math.round(n * 100) / 100

export function registerCustomerGroupTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_customer_groups',
    'Customer SEGMENTS / groups (grupos de clientes) of a venue you can access — e.g. "VIP", "Frecuentes", "Cumpleañeros del mes": each with its name, description, color, whether active, and HOW MANY customers are in it. Optionally filter by a name/description search. Answers "¿qué segmentos / grupos de clientes tengo? ¿cuántos clientes en cada uno?". This is about GROUPS, not individual customers — for one person use find_customer. Pass venueId. Requires customer-groups:read.',
    {
      venueId: z.string().describe('Venue whose customer groups to list (must be in your scope)'),
      search: z.string().optional().describe('Filter by name / description (partial, case-insensitive)'),
      limit: z.number().int().positive().max(100).optional().describe('Max groups to return (default 20)'),
    },
    async ({ venueId, search, limit }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('customer-groups:read', venueId) // mirrors the dashboard route gate
      const result = await getCustomerGroups(venueId, { pageSize: limit ?? 20, ...(search ? { search } : {}) })
      return text({
        venueId,
        count: result.data.length,
        total: result.meta.totalCount,
        groups: result.data.map(g => ({
          id: g.id,
          name: g.name,
          description: g.description,
          color: g.color,
          active: g.active,
          customerCount: g.customerCount,
          autoAssignRules: g.autoAssignRules ?? null, // e.g. { minSpent, minVisits }
        })),
      })
    },
  )

  server.tool(
    'customer_group_detail',
    'Full detail of ONE customer segment in a venue you can access, by its groupId (from list_customer_groups): its name/description, plus aggregate VALUE — how many customers, their combined and average spend (pesos) and visits, total loyalty points — and the MEMBERS (name, contact, total spent, visits, points) ranked by spend. Answers "¿quiénes están en el segmento VIP? ¿cuánto vale ese grupo? ¿quién gasta más?". Pass venueId + groupId. Requires customer-groups:read.',
    {
      venueId: z.string().describe('Venue that owns the group (must be in your scope)'),
      groupId: z.string().min(1).describe('Customer group id (from list_customer_groups)'),
    },
    async ({ venueId, groupId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('customer-groups:read', venueId) // mirrors the dashboard route gate
      try {
        // Service scopes by venueId (own venues only — already proven by venueFilter).
        const g = await getCustomerGroupById(venueId, groupId)
        return text({
          found: true,
          group: { id: g.id, name: g.name, description: g.description, color: g.color, active: g.active },
          stats: {
            totalCustomers: g.stats.totalCustomers,
            totalSpent: round2(g.stats.totalSpent), // pesos
            totalVisits: g.stats.totalVisits,
            totalLoyaltyPoints: g.stats.totalLoyaltyPoints,
            avgSpentPerCustomer: round2(g.stats.avgSpentPerCustomer), // pesos
            avgVisitsPerCustomer: round2(g.stats.avgVisitsPerCustomer),
          },
          customers: g.customers.map(c => ({
            name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || null,
            email: c.email,
            phone: c.phone,
            totalSpent: round2(c.totalSpent), // pesos (already a number from the service)
            totalVisits: c.totalVisits,
            loyaltyPoints: c.loyaltyPoints,
          })),
        })
      } catch {
        return text({ found: false, error: `No encontré el segmento "${groupId}" en este local.` })
      }
    },
  )
}
