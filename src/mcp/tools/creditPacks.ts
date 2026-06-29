import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getCreditPacks, getCustomerPurchases } from '@/services/dashboard/creditPack.dashboard.service'
import { CreditPurchaseStatus } from '@prisma/client'

// Credit packs ("paquete de 10 clases / 10 masajes" — buy N, redeem over time): core to the
// appointment-services ICP. Gated by creditPacks:read (mirrors the dashboard route). Money PESOS.
const num = (v: unknown): number | null => (v == null ? null : Number(v))

export function registerCreditPackTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_credit_packs',
    'Prepaid credit packs / bundles (paquetes) a venue you can access sells — e.g. "Paquete 10 clases", "5 masajes": each with its name, price (pesos), what it INCLUDES (each product/service + how many credits, e.g. 10 classes), whether active, and how many have been SOLD. Answers "¿qué paquetes vendo? ¿cuánto cuesta el de 10 clases? ¿qué incluye?". Pass venueId. Requires creditPacks:read. For one customer\'s remaining balance use customer_credit_balance.',
    {
      venueId: z.string().describe('Venue whose credit packs to list (must be in your scope)'),
      includeInactive: z.boolean().optional().describe('Also include inactive packs (default: all packs are returned)'),
    },
    async ({ venueId, includeInactive }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('creditPacks:read', venueId) // mirrors the dashboard route gate
      const packs = await getCreditPacks(venueId)
      const rows = includeInactive ? packs : packs.filter(p => p.active)
      return text({
        venueId,
        count: rows.length,
        creditPacks: rows.map(p => ({
          id: p.id,
          name: p.name,
          description: p.description,
          price: num(p.price), // pesos
          currency: p.currency,
          active: p.active,
          sold: p._count.purchases,
          includes: p.items.map(it => ({ product: it.product?.name ?? null, credits: it.quantity })),
        })),
      })
    },
  )

  server.tool(
    'customer_credit_balance',
    'A customer\'s remaining prepaid CREDITS / pack balance in a venue you can access — answers "¿cuántas clases/sesiones le quedan a Juan de su paquete?". Find them by name/email/phone; returns each pack they bought with its status (active/exhausted/expired/refunded), purchase + expiry dates, amount paid (pesos), and per item how many credits REMAIN vs the original. Defaults to ACTIVE packs. If the search matches several customers it returns them so you can be specific. Pass venueId + a search term. Requires creditPacks:read.',
    {
      venueId: z.string().describe('Venue that owns the customer (must be in your scope)'),
      search: z.string().min(1).describe('Customer name, email or phone (partial, case-insensitive)'),
      includeInactive: z.boolean().optional().describe('Also include exhausted/expired/refunded packs (default: only ACTIVE)'),
    },
    async ({ venueId, search, includeInactive }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('creditPacks:read', venueId) // mirrors the dashboard route gate

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
        select: { id: true, firstName: true, lastName: true },
        orderBy: { totalSpent: 'desc' },
        take: 5,
      })
      if (matches.length === 0) {
        return text({ found: false, error: `No encontré ningún cliente que coincida con "${search}" en este local.` })
      }
      if (matches.length > 1) {
        return text({
          found: false,
          ambiguous: true,
          error: `"${search}" coincide con varios clientes — sé más específico.`,
          matches: matches.map(m => `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || '(sin nombre)'),
        })
      }

      const c = matches[0]
      const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || '(sin nombre)'
      const result = await getCustomerPurchases(venueId, {
        customerId: c.id,
        ...(includeInactive ? {} : { status: CreditPurchaseStatus.ACTIVE }),
        limit: 50,
      })
      return text({
        found: true,
        venueId,
        customer: name,
        count: result.purchases.length,
        purchases: result.purchases.map(p => ({
          pack: (p as { creditPack?: { name?: string } }).creditPack?.name ?? null,
          status: p.status, // ACTIVE | EXHAUSTED | EXPIRED | REFUNDED
          purchasedAt: p.purchasedAt.toISOString(),
          expiresAt: p.expiresAt?.toISOString() ?? null,
          amountPaid: num(p.amountPaid), // pesos
          items:
            (
              p as { itemBalances?: Array<{ product?: { name?: string } | null; remainingQuantity: number; originalQuantity: number }> }
            ).itemBalances?.map(b => ({
              product: b.product?.name ?? null,
              remaining: b.remainingQuantity,
              original: b.originalQuantity,
            })) ?? [],
        })),
      })
    },
  )
}
