import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ShiftStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const money = (d: { toString(): string } | null): number | null => (d == null ? null : Number(d))

export function registerShiftTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_shifts',
    'Cash-register shifts (turnos de caja) for a venue you can access: who opened it, since when, sales/tips/orders so far, cash vs card collected, starting/ending cash and the difference, and status. Defaults to currently open shifts. Answers "¿cómo va la caja? ¿quién está en turno? ¿cuánto llevan en efectivo?". Pass venueId.',
    {
      venueId: z.string().describe('Venue whose shifts to read (must be in your scope)'),
      status: z.enum(['open', 'closed', 'all']).optional().describe("Which shifts: 'open' (default — open or closing), 'closed', or 'all'"),
      limit: z.number().int().positive().max(50).optional().describe('Max shifts to return (default 20)'),
    },
    async ({ venueId, status, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const statusFilter =
        status === 'closed'
          ? { status: ShiftStatus.CLOSED }
          : status === 'all'
            ? {}
            : { status: { in: [ShiftStatus.OPEN, ShiftStatus.CLOSING] } }
      const shifts = await prisma.shift.findMany({
        where: { ...where, ...statusFilter },
        select: {
          startTime: true,
          endTime: true,
          status: true,
          startingCash: true,
          endingCash: true,
          cashDifference: true,
          totalSales: true,
          totalTips: true,
          totalOrders: true,
          totalCashPayments: true,
          totalCardPayments: true,
          staff: { select: { firstName: true, lastName: true } },
        },
        orderBy: { startTime: 'desc' },
        take: limit ?? 20,
      })
      return text({
        venueId,
        count: shifts.length,
        shifts: shifts.map(s => ({
          staff: `${s.staff.firstName} ${s.staff.lastName}`.trim(),
          status: s.status,
          openedAt: s.startTime.toISOString(),
          closedAt: s.endTime?.toISOString() ?? null,
          sales: money(s.totalSales),
          tips: money(s.totalTips),
          orders: s.totalOrders,
          cash: money(s.totalCashPayments),
          card: money(s.totalCardPayments),
          startingCash: money(s.startingCash),
          endingCash: money(s.endingCash),
          cashDifference: money(s.cashDifference),
        })),
      })
    },
  )
}
