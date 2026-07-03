import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { OrderStatus, PaymentStatus, ShiftStatus, TransactionStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const num = (d: { toString(): string } | null): number => (d == null ? 0 : Number(d))
const round2 = (n: number): number => Math.round(n * 100) / 100

export function registerOverviewTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'today_overview',
    'A one-call snapshot of how a venue is doing RIGHT NOW (today, venue timezone): completed sales & tips so far, how many open/unpaid tabs there are and how much they owe, reservations left today (+ the next one), how many products are low on stock, and how many cash shifts are open. The fast answer to "¿cómo va el día? ¿cómo va todo? dame un resumen". Pass venueId.',
    {
      venueId: z.string().describe('Venue to snapshot (must be in your scope)'),
    },
    async ({ venueId }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('analytics:read', venueId) // read gate — mirror the dashboard's advanced-reports permission
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true, name: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      const dayStart = venueStartOfDay(tz)
      const dayEnd = venueEndOfDay(tz)
      const now = new Date()

      const [sales, tabs, lowStockRows, openShifts, reservationsToday, nextReservation] = await Promise.all([
        prisma.payment.aggregate({
          where: { ...base, status: TransactionStatus.COMPLETED, createdAt: { gte: dayStart, lte: dayEnd } },
          _sum: { amount: true, tipAmount: true },
          _count: { _all: true },
        }),
        prisma.order.aggregate({
          where: {
            ...base,
            paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
            status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] },
          },
          _sum: { remainingBalance: true },
          _count: { _all: true },
        }),
        // low-stock is an in-memory comparison (currentStock <= minimumStock), mirroring low_stock
        prisma.inventory.findMany({ where: { ...base, minimumStock: { gt: 0 } }, select: { currentStock: true, minimumStock: true } }),
        prisma.shift.count({ where: { ...base, status: { in: [ShiftStatus.OPEN, ShiftStatus.CLOSING] } } }),
        prisma.reservation.count({ where: { ...base, startsAt: { gte: dayStart, lte: dayEnd } } }),
        prisma.reservation.findFirst({
          where: { ...base, startsAt: { gte: now, lte: dayEnd } },
          select: { startsAt: true, partySize: true, guestName: true, confirmationCode: true },
          orderBy: { startsAt: 'asc' },
        }),
      ])

      const lowStockItems = lowStockRows.filter(i => Number(i.currentStock) <= Number(i.minimumStock)).length

      return text({
        venue: venue?.name ?? null,
        venueId,
        asOf: now.toISOString(),
        timezone: tz,
        salesToday: { gross: round2(num(sales._sum.amount)), tips: round2(num(sales._sum.tipAmount)), payments: sales._count._all },
        openTabs: { count: tabs._count._all, owed: round2(num(tabs._sum.remainingBalance)) },
        reservationsToday: {
          count: reservationsToday,
          next: nextReservation
            ? {
                at: nextReservation.startsAt.toISOString(),
                partySize: nextReservation.partySize,
                guest: nextReservation.guestName,
                code: nextReservation.confirmationCode,
              }
            : null,
        },
        lowStockItems,
        openShifts,
      })
    },
  )
}
