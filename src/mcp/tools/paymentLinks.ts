import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PaymentLinkStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { createPaymentLink } from '@/services/dashboard/paymentLink.service'

const STATUS_MAP: Record<string, PaymentLinkStatus> = {
  active: PaymentLinkStatus.ACTIVE,
  paused: PaymentLinkStatus.PAUSED,
  expired: PaymentLinkStatus.EXPIRED,
  archived: PaymentLinkStatus.ARCHIVED,
}

export function registerPaymentLinkTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_payment_links',
    'Payment links (checkout links via pay.avoqado.io) of a venue you can access: title, purpose (generic payment / item sale / donation), fixed or open amount, currency, status (active/paused/expired/archived), short code and expiry. Defaults to active links. Answers "¿qué links de pago tengo? ¿cuáles siguen activos / ya expiraron?". Pass venueId.',
    {
      venueId: z.string().describe('Venue whose payment links to list (must be in your scope)'),
      status: z.enum(['active', 'paused', 'expired', 'archived', 'all']).optional().describe("Filter by status (default 'active')"),
      limit: z.number().int().positive().max(100).optional().describe('Max links to return (default 50, newest first)'),
    },
    async ({ venueId, status, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('payment-link:read', venueId) // read gate — mirror the dashboard's checkPermission
      const statusFilter = !status ? { status: PaymentLinkStatus.ACTIVE } : status === 'all' ? {} : { status: STATUS_MAP[status] }
      const links = await prisma.paymentLink.findMany({
        where: { ...where, ...statusFilter },
        select: {
          shortCode: true,
          title: true,
          description: true,
          purpose: true,
          amountType: true,
          amount: true,
          currency: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      })
      return text({
        venueId,
        count: links.length,
        links: links.map(l => ({
          shortCode: l.shortCode,
          title: l.title,
          description: l.description,
          purpose: l.purpose, // PAYMENT | ITEM | DONATION
          amount: l.amountType === 'OPEN' ? 'open' : l.amount != null ? Number(l.amount) : null,
          currency: l.currency,
          status: l.status, // ACTIVE | PAUSED | EXPIRED | ARCHIVED
          expiresAt: l.expiresAt?.toISOString() ?? null,
          createdAt: l.createdAt.toISOString(),
        })),
      })
    },
  )

  server.tool(
    'create_payment_link',
    'Create a NEW payment link (pay.avoqado.io) in a venue you can access — a shareable link to collect a payment. Set a title and either a fixed amount (in PESOS, e.g. 150.50) or leave it open (the payer chooses how much). Optionally a description, purpose (payment / donation) and an expiry. Because it mints a PUBLIC, shareable checkout that anyone can pay, by DEFAULT it only PREVIEWS the link; call again with confirm:true to actually create it. Returns the short code. This WRITES — requires payment-link:create. (Item-based links with product line items are not created here — use the dashboard.)',
    {
      venueId: z.string().describe('Venue to create the link in (must be in your scope)'),
      title: z.string().min(1).describe('What the payment is for, e.g. "Anticipo boda"'),
      amount: z
        .number()
        .positive()
        .optional()
        .describe('Fixed amount to charge in PESOS (e.g. 150.50); omit for an OPEN amount the payer chooses'),
      purpose: z.enum(['payment', 'donation']).optional().describe("'payment' (default) or 'donation'"),
      description: z.string().optional().describe('Description shown to the payer'),
      currency: z.string().optional().describe('Currency (default the venue currency, usually MXN)'),
      expiresAt: z.string().optional().describe('Expiry, ISO 8601 (e.g. 2026-07-01T00:00:00.000Z)'),
      confirm: z.boolean().optional().describe('Must be true to actually create the link; without it you get a preview'),
    },
    async ({ venueId, title, amount, purpose, description, currency, expiresAt, confirm }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('payment-link:create', venueId) // write gate (per-venue role)

      // A payment link is a PUBLIC, shareable checkout carrying a money amount —
      // a wrong-magnitude amount (150 vs 150000) from a vague request would mint
      // a live link anyone could pay. Preview before creating (confirm-gate).
      if (!confirm) {
        const amountLabel =
          amount !== undefined ? `monto fijo $${amount.toFixed(2)} ${currency ?? 'MXN'}` : 'monto ABIERTO (el pagador elige cuánto)'
        const purposeLabel = purpose === 'donation' ? 'donativo' : 'pago'
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            title,
            amountType: amount !== undefined ? 'FIXED' : 'OPEN',
            amount: amount ?? null,
            purpose: purpose === 'donation' ? 'DONATION' : 'PAYMENT',
            currency: currency ?? 'MXN',
            expiresAt: expiresAt ?? null,
          },
          message: `Voy a CREAR un link de cobro público (pay.avoqado.io): "${title}" — ${amountLabel}, ${purposeLabel}${expiresAt ? `, vence ${expiresAt}` : ', sin expiración'}. Cualquiera con el link podrá pagar. Vuelve a llamar con confirm:true para crearlo.`,
        })
      }

      try {
        const link = await createPaymentLink(
          venueId,
          {
            title,
            amountType: amount !== undefined ? 'FIXED' : 'OPEN',
            purpose: purpose === 'donation' ? 'DONATION' : 'PAYMENT',
            ...(amount !== undefined ? { amount } : {}),
            ...(description ? { description } : {}),
            ...(currency ? { currency } : {}),
            ...(expiresAt ? { expiresAt } : {}),
          },
          scope.staffId,
        )
        await auditMcpWrite(scope, {
          action: 'PAYMENT_LINK_CREATED',
          entity: 'PaymentLink',
          entityId: link.id,
          venueId,
          data: { title, amountType: amount !== undefined ? 'FIXED' : 'OPEN', amount: amount ?? null },
        })
        return text({
          ok: true,
          paymentLink: {
            id: link.id,
            shortCode: link.shortCode,
            title: link.title,
            amountType: link.amountType,
            amount: link.amount != null ? Number(link.amount) : null,
            status: link.status,
          },
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
