import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getCreditPacks, getCustomerPurchases, redeemItemManually } from '@/services/dashboard/creditPack.dashboard.service'
import { sellPackInPerson } from '@/services/mobile/creditPack.mobile.service'
import { auditMcpWrite } from '../audit'
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

  server.tool(
    'redeem_credit',
    'Redeem ONE prepaid credit from a customer\'s pack in a venue you can access — e.g. mark that they used a class/session today ("redime una clase a Juan"). Find the customer by name/email/phone; if their pack covers several services pass `product` to pick which credit to use. Because it CONSUMES a prepaid credit (customer value, not trivially reversible), by DEFAULT it only PREVIEWS (remaining → remaining-1); call again with confirm:true to apply. This WRITES — requires creditPacks:update.',
    {
      venueId: z.string().describe('Venue that owns the customer (must be in your scope)'),
      search: z.string().min(1).describe('Customer name, email or phone (partial, case-insensitive)'),
      product: z
        .string()
        .optional()
        .describe('Which credit to redeem, by product/service name — required if the customer has credits for several'),
      reason: z.string().optional().describe('Optional note for the audit trail (e.g. "asistió a clase 7pm")'),
      confirm: z.boolean().optional().describe('Must be true to actually redeem; without it you get a preview'),
    },
    async ({ venueId, search, product, reason, confirm }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('creditPacks:update', venueId) // write gate (per-venue role)

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
      if (matches.length === 0) return text({ ok: false, error: `No encontré ningún cliente que coincida con "${search}" en este local.` })
      if (matches.length > 1) {
        return text({
          ok: false,
          ambiguous: true,
          error: `"${search}" coincide con varios clientes — sé más específico.`,
          matches: matches.map(m => `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || '(sin nombre)'),
        })
      }
      const c = matches[0]
      const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || '(sin nombre)'

      // Available = ACTIVE purchase, credits remaining, optionally filtered to the named product.
      const balances = await prisma.creditItemBalance.findMany({
        where: {
          remainingQuantity: { gt: 0 },
          creditPackPurchase: { venueId, customerId: c.id, status: CreditPurchaseStatus.ACTIVE },
          ...(product ? { product: { name: { contains: product, mode: 'insensitive' as const } } } : {}),
        },
        select: {
          id: true,
          remainingQuantity: true,
          product: { select: { name: true } },
          creditPackPurchase: { select: { expiresAt: true, creditPack: { select: { name: true } } } },
        },
      })
      if (balances.length === 0) {
        return text({
          ok: false,
          error: product
            ? `${name} no tiene créditos disponibles de "${product}".`
            : `${name} no tiene créditos activos disponibles para canjear.`,
        })
      }
      // If no product filter and the customer has credits for several DIFFERENT services, ask which.
      const distinctProducts = [...new Set(balances.map(b => b.product?.name ?? ''))]
      if (!product && distinctProducts.length > 1) {
        return text({
          ok: false,
          ambiguous: true,
          error: `${name} tiene créditos de varios servicios — especifica cuál con "product".`,
          available: distinctProducts,
        })
      }
      // Auto-pick the soonest-expiring matching balance (nulls last) — shown in the preview so the
      // operator confirms the exact pack; never silently picks across services (handled above).
      const target = [...balances].sort((a, b) => {
        const ea = a.creditPackPurchase.expiresAt?.getTime() ?? Infinity
        const eb = b.creditPackPurchase.expiresAt?.getTime() ?? Infinity
        return ea - eb
      })[0]
      const productName = target.product?.name ?? '(servicio)'
      const packName = target.creditPackPurchase.creditPack?.name ?? '(paquete)'

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            customer: name,
            product: productName,
            pack: packName,
            expiresAt: target.creditPackPurchase.expiresAt?.toISOString() ?? null,
            remaining: target.remainingQuantity,
            after: target.remainingQuantity - 1,
          },
          message: `Esto CANJEARÁ 1 crédito de "${productName}" (paquete "${packName}") de ${name}: ${target.remainingQuantity} → ${target.remainingQuantity - 1}. Vuelve a llamar con confirm:true para aplicar.`,
        })
      }

      // CreditTransaction.createdById FKs to StaffVenue.id (NOT Staff.id) — resolve the caller's
      // staff-venue row for attribution, exactly like the dashboard controller (getStaffVenueId).
      // Passing scope.staffId (a Staff.id) would violate the FK and roll the redemption back.
      const sv = await prisma.staffVenue.findFirst({ where: { staffId: scope.staffId, venueId }, select: { id: true } })
      if (!sv) return text({ ok: false, error: 'No pude resolver tu asignación a este local para registrar el canje.' })

      try {
        const tx = await redeemItemManually(venueId, target.id, sv.id, reason) // service re-validates active/expiry/remaining
        await auditMcpWrite(scope, {
          action: 'CREDIT_REDEEMED',
          entity: 'CreditItemBalance',
          entityId: target.id,
          venueId,
          data: { customer: name, product: productName, pack: packName, reason: reason ?? null },
        })
        return text({
          ok: true,
          redeemed: {
            customer: name,
            product: productName,
            pack: packName,
            remaining: target.remainingQuantity - 1,
            transactionId: (tx as { id?: string })?.id ?? null,
          },
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )

  server.tool(
    'sell_credit_pack',
    'Sell a prepaid pack to a customer IN PERSON in a venue you can access — grants the credits after they pay at the POS ("véndele el paquete de 10 clases a Juan"). Find the customer by name/email/phone and the pack by name. Because it CREATES a paid purchase (records amountPaid + grants credits), by DEFAULT it only PREVIEWS; call again with confirm:true to apply. amountPaid defaults to the pack list price. This WRITES — requires creditPacks:create.',
    {
      venueId: z.string().describe('Venue that owns the customer + pack (must be in your scope)'),
      customerSearch: z.string().min(1).describe('Customer name, email or phone (partial, case-insensitive)'),
      packSearch: z.string().min(1).describe('Credit pack name (partial, case-insensitive)'),
      amountPaid: z.number().optional().describe('Amount paid in pesos (defaults to the pack list price)'),
      note: z.string().optional().describe('Optional note for the audit trail'),
      confirm: z.boolean().optional().describe('Must be true to actually sell; without it you get a preview'),
    },
    async ({ venueId, customerSearch, packSearch, amountPaid, note, confirm }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('creditPacks:create', venueId) // write gate (per-venue role)

      const customers = await prisma.customer.findMany({
        where: {
          ...base,
          OR: [
            { firstName: { contains: customerSearch, mode: 'insensitive' as const } },
            { lastName: { contains: customerSearch, mode: 'insensitive' as const } },
            { email: { contains: customerSearch, mode: 'insensitive' as const } },
            { phone: { contains: customerSearch } },
          ],
        },
        select: { id: true, firstName: true, lastName: true },
        orderBy: { totalSpent: 'desc' },
        take: 5,
      })
      if (customers.length === 0) return text({ ok: false, error: `No encontré ningún cliente que coincida con "${customerSearch}".` })
      if (customers.length > 1) {
        return text({
          ok: false,
          ambiguous: true,
          error: `"${customerSearch}" coincide con varios clientes — sé más específico.`,
          matches: customers.map(m => `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || '(sin nombre)'),
        })
      }
      const c = customers[0]
      const customerName = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || '(sin nombre)'

      const packs = await prisma.creditPack.findMany({
        where: { venueId, active: true, name: { contains: packSearch, mode: 'insensitive' as const } },
        select: { id: true, name: true, price: true, items: { select: { quantity: true, product: { select: { name: true } } } } },
        take: 5,
      })
      if (packs.length === 0) return text({ ok: false, error: `No encontré ningún paquete activo que coincida con "${packSearch}".` })
      if (packs.length > 1) {
        return text({ ok: false, ambiguous: true, error: `"${packSearch}" coincide con varios paquetes — sé más específico.`, matches: packs.map(p => p.name) })
      }
      const pack = packs[0]
      const price = amountPaid ?? num(pack.price)

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            customer: customerName,
            pack: pack.name,
            amountPaid: price,
            includes: pack.items.map(it => ({ product: it.product?.name ?? null, credits: it.quantity })),
          },
          message: `Esto VENDERÁ el paquete "${pack.name}" a ${customerName} por $${price} y le otorgará los créditos. Vuelve a llamar con confirm:true para aplicar.`,
        })
      }

      // createdById FKs to StaffVenue.id — resolve the caller's staff-venue row (same as redeem_credit).
      const sv = await prisma.staffVenue.findFirst({ where: { staffId: scope.staffId, venueId }, select: { id: true } })
      if (!sv) return text({ ok: false, error: 'No pude resolver tu asignación a este local para registrar la venta.' })

      try {
        const purchase = await sellPackInPerson(venueId, pack.id, c.id, sv.id, { amountPaid, note })
        await auditMcpWrite(scope, {
          action: 'CREDIT_PACK_SOLD',
          entity: 'CreditPackPurchase',
          entityId: (purchase as { id?: string })?.id ?? '',
          venueId,
          data: { customer: customerName, pack: pack.name, amountPaid: price },
        })
        return text({ ok: true, sold: { customer: customerName, pack: pack.name, amountPaid: price, purchaseId: (purchase as { id?: string })?.id ?? null } })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
