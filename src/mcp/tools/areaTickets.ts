import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { createGuard } from '../guard'
import { text } from '../respond'
import type { McpScope } from '../scope'

const decimal = (value: { toString(): string } | null): string | null => (value == null ? null : value.toString())

export function registerAreaTicketTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)

  server.tool(
    'area_ticket_status',
    'Look up an area ticket or final delivery receipt by its scanned code. Returns payment, claim, print and delivery state without changing anything. Venue-scoped and read-only.',
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
      code: z.string().trim().min(1).max(64).describe('Area-ticket code or final delivery-receipt code'),
    },
    async ({ venueId, code }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('orders:read', venueId)

      const [ticket, order] = await Promise.all([
        prisma.areaTicket.findUnique({
          where: { venueId_code: { venueId, code } },
          select: {
            id: true,
            code: true,
            status: true,
            total: true,
            printStatus: true,
            issuedAt: true,
            claimedAt: true,
            claimExpiresAt: true,
            paidAt: true,
            cancelledAt: true,
            expiresAt: true,
            fulfillmentArea: { select: { id: true, name: true } },
            checkoutSession: { select: { id: true, status: true } },
            order: {
              select: {
                id: true,
                orderNumber: true,
                paymentStatus: true,
                areaDeliveryCode: true,
              },
            },
            fulfillment: {
              select: {
                deliveredAt: true,
                method: true,
                deliveredByStaff: { select: { firstName: true, lastName: true } },
              },
            },
          },
        }),
        prisma.order.findUnique({
          where: { venueId_areaDeliveryCode: { venueId, areaDeliveryCode: code } },
          select: {
            id: true,
            orderNumber: true,
            paymentStatus: true,
            areaDeliveryCode: true,
            areaTickets: {
              select: {
                id: true,
                code: true,
                status: true,
                total: true,
                fulfillmentArea: { select: { id: true, name: true } },
                fulfillment: { select: { deliveredAt: true, method: true } },
              },
              orderBy: { issuedAt: 'asc' },
            },
          },
        }),
      ])

      if (!ticket && !order) return text({ found: false, code })
      if (ticket) {
        return text({
          found: true,
          kind: 'AREA_TICKET',
          ticket: {
            ...ticket,
            total: decimal(ticket.total),
            deliveredBy: ticket.fulfillment?.deliveredByStaff
              ? `${ticket.fulfillment.deliveredByStaff.firstName} ${ticket.fulfillment.deliveredByStaff.lastName}`.trim()
              : null,
          },
        })
      }
      return text({
        found: true,
        kind: 'DELIVERY_RECEIPT',
        order: {
          ...order,
          areaTickets: order!.areaTickets.map(candidate => ({
            ...candidate,
            total: decimal(candidate.total),
          })),
        },
      })
    },
  )

  server.tool(
    'pending_area_ticket_deliveries',
    'List paid area tickets still waiting for physical delivery, oldest first and grouped by emitting area. Read-only; requires area-tickets:deliver.',
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ venueId, limit }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('area-tickets:deliver', venueId)
      const tickets = await prisma.areaTicket.findMany({
        where: { venueId, status: 'PAID', fulfillment: null },
        select: {
          id: true,
          code: true,
          paidAt: true,
          total: true,
          fulfillmentArea: { select: { id: true, name: true } },
          order: { select: { id: true, orderNumber: true, areaDeliveryCode: true } },
          _count: { select: { lines: true } },
        },
        orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
        take: limit,
      })
      return text({
        count: tickets.length,
        tickets: tickets.map(ticket => ({
          ...ticket,
          total: decimal(ticket.total),
          lines: ticket._count.lines,
          _count: undefined,
        })),
      })
    },
  )

  server.tool(
    'area_ticket_reconciliation_queue',
    'List checkout sessions frozen because a payment outcome requires reconciliation. Does not release claims or retry payments. Read-only; requires area-tickets:configure.',
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ venueId, limit }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('area-tickets:configure', venueId)
      const sessions = await prisma.areaTicketCheckoutSession.findMany({
        where: { venueId, status: 'RECONCILIATION_REQUIRED' },
        select: {
          id: true,
          status: true,
          activePaymentAttemptId: true,
          lastHeartbeatAt: true,
          updatedAt: true,
          terminal: { select: { id: true, name: true } },
          order: {
            select: {
              id: true,
              orderNumber: true,
              paymentStatus: true,
              total: true,
              paidAmount: true,
              remainingBalance: true,
            },
          },
          paymentAttempts: {
            select: {
              id: true,
              sequence: true,
              status: true,
              amount: true,
              method: true,
              paymentId: true,
              providerReference: true,
              lastCheckedAt: true,
            },
            orderBy: { sequence: 'asc' },
          },
          _count: { select: { tickets: true } },
        },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      })
      return text({
        count: sessions.length,
        sessions: sessions.map(session => ({
          ...session,
          ticketCount: session._count.tickets,
          _count: undefined,
          order: session.order
            ? {
                ...session.order,
                total: decimal(session.order.total),
                paidAmount: decimal(session.order.paidAmount),
                remainingBalance: decimal(session.order.remainingBalance),
              }
            : null,
          paymentAttempts: session.paymentAttempts.map(attempt => ({
            ...attempt,
            amount: decimal(attempt.amount),
          })),
        })),
        warning: 'No inicies otro cobro ni liberes claims desde esta consulta. Primero verifica el proveedor y el Payment asociado.',
      })
    },
  )
}
