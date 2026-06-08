import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PaymentLinkStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

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
}
