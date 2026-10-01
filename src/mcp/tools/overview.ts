import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { OrderStatus, PaymentStatus, ShiftStatus, TransactionStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'

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

      const restrictions: Record<string, { permission?: string; planRequired?: boolean; message: string }> = {}
      const canRead = async (section: string, permission: string, feature?: string): Promise<boolean> => {
        if (!guard.tienePermiso(permission, venueId)) {
          restrictions[section] = { permission, message: `Tu rol no permite consultar esta sección (${permission}).` }
          return false
        }
        const gate = feature ? await planGateMessage(venueId, feature, 'Esta sección') : null
        if (gate) {
          restrictions[section] = { planRequired: true, message: gate }
          return false
        }
        return true
      }
      const [canOrders, canInventory, canShifts, canReservations] = await Promise.all([
        canRead('openTabs', 'orders:read'),
        canRead('lowStockItems', 'inventory:read', 'INVENTORY_TRACKING'),
        canRead('openShifts', 'shifts:read'),
        canRead('reservationsToday', 'reservations:read', 'RESERVATIONS'),
      ])

      const [sales, tabs, lowStockItems, openShifts, reservationsToday, nextReservation] = await Promise.all([
        prisma.payment.aggregate({
          where: { ...base, status: TransactionStatus.COMPLETED, createdAt: { gte: dayStart, lte: dayEnd } },
          _sum: { amount: true, tipAmount: true },
          _count: { _all: true },
        }),
        canOrders
          ? prisma.order.aggregate({
              where: {
                ...base,
                paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
                status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] },
              },
              _sum: { remainingBalance: true },
              _count: { _all: true },
            })
          : null,
        canInventory
          ? prisma.inventory.count({
              where: { ...base, minimumStock: { gt: 0 }, currentStock: { lte: prisma.inventory.fields.minimumStock } },
            })
          : null,
        canShifts ? prisma.shift.count({ where: { ...base, status: { in: [ShiftStatus.OPEN, ShiftStatus.CLOSING] } } }) : null,
        canReservations ? prisma.reservation.count({ where: { ...base, startsAt: { gte: dayStart, lte: dayEnd } } }) : null,
        canReservations
          ? prisma.reservation.findFirst({
              where: { ...base, startsAt: { gte: now, lte: dayEnd } },
              select: { startsAt: true, partySize: true, guestName: true, confirmationCode: true },
              orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
            })
          : null,
      ])

      return text({
        venue: venue?.name ?? null,
        venueId,
        asOf: now.toISOString(),
        timezone: tz,
        salesToday: { gross: round2(num(sales._sum.amount)), tips: round2(num(sales._sum.tipAmount)), payments: sales._count._all },
        openTabs: tabs ? { count: tabs._count._all, owed: round2(num(tabs._sum.remainingBalance)) } : null,
        reservationsToday: canReservations
          ? {
              count: reservationsToday,
              next: nextReservation
                ? {
                    at: nextReservation.startsAt.toISOString(),
                    partySize: nextReservation.partySize,
                    guest: nextReservation.guestName,
                    code: nextReservation.confirmationCode,
                  }
                : null,
            }
          : null,
        lowStockItems,
        restrictions,
        openShifts,
      })
    },
  )
}
