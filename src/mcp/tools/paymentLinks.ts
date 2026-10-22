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
      offset: z.number().int().min(0).optional().describe('Offset from the previous page'),
    },
    async ({ venueId, status, limit, offset = 0 }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('payment-link:read', venueId) // read gate — mirror the dashboard's checkPermission
      const statusFilter = !status ? { status: PaymentLinkStatus.ACTIVE } : status === 'all' ? {} : { status: STATUS_MAP[status] }
      const filter = { ...where, ...statusFilter }
      const total = await prisma.paymentLink.count({ where: filter })
      const links = await prisma.paymentLink.findMany({
        where: filter,
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
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: offset,
        take: limit ?? 50,
      })
      return text({
        venueId,
        count: links.length,
        total,
        hasMore: offset + links.length < total,
        nextOffset: offset + links.length < total ? offset + links.length : null,
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
  server.tool(
    'create_customer_payment_link',
    'Create a payment link attributed to an existing customer of this venue. Payer contacts stay separate. Preview first, then human confirmation. Reusable links attribute every payment to this customer. Requires payment-link:create and customers:read. Customer creation remains in create_customer. A creationKey makes retries return the same link.',
    {
      venueId: z.string(),
      customerId: z.string().cuid('ID de cliente inválido'),
      title: z.string().min(1).max(100),
      amount: z.number().positive().optional().describe('Amount in PESOS; omit for open amount'),
      purpose: z.enum(['payment', 'donation']).optional(),
      description: z.string().max(400).optional(),
      currency: z.string().optional(),
      expiresAt: z.string().datetime().optional(),
      isReusable: z.boolean().optional(),
      creationKey: z.string().min(1).max(128).optional(),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, customerId, title, amount, purpose, description, currency, expiresAt, isReusable = false, creationKey, confirm }) => {
      const where = guard.venueFilter(venueId)
      guard.requirePermission('payment-link:create', venueId)
      guard.requirePermission('customers:read', venueId)
      if (!confirm) {
        const customer = await prisma.customer.findFirst({
          where: { ...where, id: customerId, active: true },
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        })
        if (!customer) return text({ ok: false, error: 'El cliente no existe, está inactivo o no pertenece al negocio' })
        return text({
          requiresConfirmation: true,
          preview: { venueId, customerId, customer, title, amount: amount ?? null, isReusable },
          message: 'Confirma crear la liga. Todos sus pagos se atribuirán a este cliente.',
        })
      }
      try {
        const link = await createPaymentLink(
          venueId,
          {
            customerId,
            title,
            amountType: amount === undefined ? 'OPEN' : 'FIXED',
            ...(amount !== undefined ? { amount } : {}),
            purpose: purpose === 'donation' ? 'DONATION' : 'PAYMENT',
            ...(description !== undefined ? { description } : {}),
            ...(currency !== undefined ? { currency } : {}),
            ...(expiresAt !== undefined ? { expiresAt } : {}),
            isReusable,
          },
          scope.staffId,
          creationKey,
          async created =>
            auditMcpWrite(scope, {
              action: 'PAYMENT_LINK_CREATED',
              entity: 'PaymentLink',
              entityId: created.id,
              venueId,
              data: { customerId, title, amount: amount ?? null, isReusable },
            }),
        )
        return text({
          ok: true,
          paymentLink: {
            id: link.id,
            shortCode: link.shortCode,
            title: link.title,
            customer: link.customer,
            amount: link.amount == null ? null : Number(link.amount),
            status: link.status,
          },
        })
      } catch (error) {
        return text({ ok: false, error: (error as Error).message })
      }
    },
  )

  server.tool(
    'customer_payment_links',
    'List payment links explicitly attributed to an existing customer, including pagination and total. Requires customers:read and payment-link:read. Only this venue; attribution is separate from payer identity.',
    {
      venueId: z.string(),
      customerId: z.string().cuid('ID de cliente inválido'),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async ({ venueId, customerId, limit = 50, offset = 0 }) => {
      const where = { ...guard.venueFilter(venueId), customerId }
      guard.requirePermission('customers:read', venueId)
      guard.requirePermission('payment-link:read', venueId)
      const take = Math.min(100, Math.max(1, limit))
      const [links, total] = await Promise.all([
        prisma.paymentLink.findMany({
          where,
          select: {
            id: true,
            shortCode: true,
            title: true,
            amountType: true,
            amount: true,
            status: true,
            currency: true,
            isReusable: true,
            createdAt: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: take,
          skip: offset,
        }),
        prisma.paymentLink.count({ where }),
      ])
      return text({
        venueId,
        customerId,
        total,
        limit: take,
        offset,
        hasMore: offset + links.length < total,
        nextOffset: offset + links.length < total ? offset + links.length : null,
        links: links.map(link => ({ ...link, amount: link.amount == null ? null : Number(link.amount) })),
      })
    },
  )
}
