import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PaymentLinkStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { createPaymentLink, updatePaymentLink } from '@/services/dashboard/paymentLink.service'
import { paymentLinkDiscountInput } from '@/schemas/dashboard/paymentLink.schema'
import {
  BASE_LIGA_ABIERTA,
  cargarRegla,
  desgloseDeLiga,
  rechazarDescuentoEnDonacion,
  resolverDescuentoDeEntrada,
  resumenDeDescuento,
} from '@/services/dashboard/paymentLinkDiscount'
import type { EntradaDescuento } from '@/services/dashboard/paymentLinkDiscount'

const STATUS_MAP: Record<string, PaymentLinkStatus> = {
  active: PaymentLinkStatus.ACTIVE,
  paused: PaymentLinkStatus.PAUSED,
  expired: PaymentLinkStatus.EXPIRED,
  archived: PaymentLinkStatus.ARCHIVED,
}

const mxn = (n: number) => `$${n.toLocaleString('es-MX', { maximumFractionDigits: 2 })}`

/**
 * Vista previa del descuento de una liga: valida igual que el servicio (compatibilidad, vigencia, que quepa en la base)
 * y devuelve el renglón «$1,000 − $150 = $850». `amount` undefined = importe abierto (se calcula al pagar).
 */
async function previewDeDescuento(venueId: string, discount: EntradaDescuento, amount: number | undefined, isReusable: boolean) {
  const { foto } = await resolverDescuentoDeEntrada(prisma, venueId, discount, { isReusable, base: amount ?? null })
  if (!foto) return null
  const [regla, venue] = await Promise.all([
    cargarRegla(prisma, foto),
    prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }),
  ])
  const d = desgloseDeLiga(amount ?? BASE_LIGA_ABIERTA, foto, regla, new Date(), venue?.timezone ?? 'America/Mexico_City')
  const valor = foto.type === 'PERCENTAGE' ? `${foto.value} %` : mxn(foto.value)
  const resumen =
    amount === undefined
      ? `descuento "${foto.name}" de ${valor} sobre el importe que escriba el pagador`
      : d.aplica
        ? `descuento "${foto.name}": ${mxn(d.base)} − ${mxn(d.descuento)} = ${mxn(d.neto)}`
        : `descuento "${foto.name}" (${valor}) NO aplica hoy (${d.motivo ?? 'sin motivo'}): se cobrarían ${mxn(d.base)}`
  return {
    resumen,
    detalle: {
      name: foto.name,
      base: amount ?? null,
      discount: amount === undefined ? null : d.descuento,
      net: amount === undefined ? null : d.neto,
    },
  }
}

/** El descuento exige permisos propios: estas tools llaman al servicio directo y se saltan las rutas que los revisan. */
function exigirPermisosDeDescuento(guard: ReturnType<typeof createGuard>, venueId: string, discount: EntradaDescuento | null | undefined) {
  if (!discount) return
  guard.requirePermission('discounts:apply', venueId)
  if (discount.mode === 'CATALOG') guard.requirePermission('discounts:read', venueId)
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
    'Create a NEW payment link (pay.avoqado.io) in a venue you can access — a shareable link to collect a payment. Set a title and either a fixed amount (in PESOS, e.g. 150.50) or leave it open (the payer chooses how much). Optionally a description, purpose (payment / donation) and an expiry. Because it mints a PUBLIC, shareable checkout that anyone can pay, by DEFAULT it only PREVIEWS the link; call again with confirm:true to actually create it. Returns the short code. Optionally a discount (manual % or fixed amount, or one from the venue catalog; not valid for donations): the payer is charged amount minus the discount; this additionally requires discounts:apply (and discounts:read for a catalog discount). This WRITES — requires payment-link:create. (Item-based links with product line items are not created here — use the dashboard.)',
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
      discount: paymentLinkDiscountInput.describe(
        'Optional discount: {mode:"MANUAL",type:"PERCENTAGE"|"FIXED_AMOUNT",value,name?} or {mode:"CATALOG",discountId}. Not valid for donations.',
      ),
      confirm: z.boolean().optional().describe('Must be true to actually create the link; without it you get a preview'),
    },
    async ({ venueId, title, amount, purpose, description, currency, expiresAt, discount, confirm }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('payment-link:create', venueId) // write gate (per-venue role)
      exigirPermisosDeDescuento(guard, venueId, discount) // antes del preview y del confirm

      // A payment link is a PUBLIC, shareable checkout carrying a money amount —
      // a wrong-magnitude amount (150 vs 150000) from a vague request would mint
      // a live link anyone could pay. Preview before creating (confirm-gate).
      if (!confirm) {
        const amountLabel =
          amount !== undefined ? `monto fijo $${amount.toFixed(2)} ${currency ?? 'MXN'}` : 'monto ABIERTO (el pagador elige cuánto)'
        const purposeLabel = purpose === 'donation' ? 'donativo' : 'pago'
        let descuento: Awaited<ReturnType<typeof previewDeDescuento>> = null
        if (discount) {
          try {
            rechazarDescuentoEnDonacion(purpose === 'donation' ? 'DONATION' : 'PAYMENT', discount)
            descuento = await previewDeDescuento(venueId, discount, amount, false)
          } catch (err) {
            return text({ ok: false, error: (err as Error).message })
          }
        }
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
            ...(descuento ? { discount: descuento.detalle } : {}),
          },
          message: `Voy a CREAR un link de cobro público (pay.avoqado.io): "${title}" — ${amountLabel}${descuento ? `, ${descuento.resumen}` : ''}, ${purposeLabel}${expiresAt ? `, vence ${expiresAt}` : ', sin expiración'}. Cualquiera con el link podrá pagar. Vuelve a llamar con confirm:true para crearlo.`,
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
            ...(discount ? { discount } : {}),
          },
          scope.staffId,
        )
        await auditMcpWrite(scope, {
          action: 'PAYMENT_LINK_CREATED',
          entity: 'PaymentLink',
          entityId: link.id,
          venueId,
          data: {
            title,
            amountType: amount !== undefined ? 'FIXED' : 'OPEN',
            amount: amount ?? null,
            discount: resumenDeDescuento(link.discount),
          },
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
    'Create a payment link attributed to an existing customer of this venue. Payer contacts stay separate. Preview first, then human confirmation. Reusable links attribute every payment to this customer. Optional discount (manual or from the catalog; not valid for donations) also requires discounts:apply (and discounts:read for a catalog one). Requires payment-link:create and customers:read. Customer creation remains in create_customer. A creationKey makes retries return the same link.',
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
      discount: paymentLinkDiscountInput,
      creationKey: z.string().min(1).max(128).optional(),
      confirm: z.boolean().optional(),
    },
    async ({
      venueId,
      customerId,
      title,
      amount,
      purpose,
      description,
      currency,
      expiresAt,
      isReusable = false,
      discount,
      creationKey,
      confirm,
    }) => {
      const where = guard.venueFilter(venueId)
      guard.requirePermission('payment-link:create', venueId)
      guard.requirePermission('customers:read', venueId)
      exigirPermisosDeDescuento(guard, venueId, discount) // antes del preview y del confirm
      if (!confirm) {
        const customer = await prisma.customer.findFirst({
          where: { ...where, id: customerId, active: true },
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        })
        if (!customer) return text({ ok: false, error: 'El cliente no existe, está inactivo o no pertenece al negocio' })
        let descuento: Awaited<ReturnType<typeof previewDeDescuento>> = null
        if (discount) {
          try {
            rechazarDescuentoEnDonacion(purpose === 'donation' ? 'DONATION' : 'PAYMENT', discount)
            descuento = await previewDeDescuento(venueId, discount, amount, isReusable)
          } catch (error) {
            return text({ ok: false, error: (error as Error).message })
          }
        }
        return text({
          requiresConfirmation: true,
          preview: {
            venueId,
            customerId,
            customer,
            title,
            amount: amount ?? null,
            isReusable,
            ...(descuento ? { discount: descuento.detalle } : {}),
          },
          message: `Confirma crear la liga${descuento ? ` (${descuento.resumen})` : ''}. Todos sus pagos se atribuirán a este cliente.`,
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
            ...(discount ? { discount } : {}),
          },
          scope.staffId,
          creationKey,
          async created =>
            auditMcpWrite(scope, {
              action: 'PAYMENT_LINK_CREATED',
              entity: 'PaymentLink',
              entityId: created.id,
              venueId,
              data: { customerId, title, amount: amount ?? null, isReusable, discount: resumenDeDescuento(created.discount) },
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
    'add_customer_to_payment_link',
    'Add an existing customer to a payment link that has NO customer yet (the operator forgot it when creating it). Only adds: a link that already has a customer is never changed or cleared. Counts for payments that start after this; past payments keep their owner. Preview first, then human confirmation with confirm:true. Requires payment-link:update and customers:read.',
    {
      venueId: z.string(),
      linkId: z.string().min(1),
      customerId: z.string().cuid('ID de cliente inválido'),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, linkId, customerId, confirm }) => {
      const where = guard.venueFilter(venueId)
      guard.requirePermission('payment-link:update', venueId)
      guard.requirePermission('customers:read', venueId)
      if (!confirm) {
        const link = await prisma.paymentLink.findFirst({
          where: { ...where, id: linkId },
          select: { id: true, title: true, customerId: true, status: true, isReusable: true },
        })
        if (!link) return text({ ok: false, error: 'Liga de pago no encontrada' })
        if (link.customerId && link.customerId !== customerId)
          return text({ ok: false, error: 'Esta liga ya tiene un cliente y no se puede cambiar' })
        const customer = await prisma.customer.findFirst({
          where: { ...where, id: customerId, active: true },
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        })
        if (!customer) return text({ ok: false, error: 'El cliente no existe, está inactivo o no pertenece al negocio' })
        return text({
          requiresConfirmation: true,
          preview: { venueId, linkId, title: link.title, status: link.status, isReusable: link.isReusable, customer },
          message: 'Confirma agregar el cliente. Contará para los pagos que empiecen después; no se podrá cambiar.',
        })
      }
      try {
        const link = await updatePaymentLink(venueId, linkId, { customerId }, scope.staffId, () =>
          auditMcpWrite(scope, {
            action: 'PAYMENT_LINK_CUSTOMER_ADDED',
            entity: 'PaymentLink',
            entityId: linkId,
            venueId,
            data: { customerId },
          }),
        )
        return text({
          ok: true,
          paymentLink: { id: link.id, shortCode: link.shortCode, title: link.title, customer: link.customer, status: link.status },
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
