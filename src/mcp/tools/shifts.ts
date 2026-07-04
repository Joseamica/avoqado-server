import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ShiftStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getExpectedCashAmount, getCloseoutHistory } from '@/services/dashboard/cashCloseout.dashboard.service'

const money = (d: { toString(): string } | null): number | null => (d == null ? null : Number(d))
const round2 = (n: number): number => Math.round(n * 100) / 100

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
      guard.requirePermission('shifts:read', venueId) // WHY: mirror the dashboard's shifts:read gate — shift rows expose drawer cash (starting/ending/difference)
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

  server.tool(
    'cash_closeout',
    'Cash register closeout (corte de caja) for a venue you can access. Two parts: (1) the cash EXPECTED in the drawer RIGHT NOW since the last cut — the sum of completed cash payments minus cash refunds — with how many cash transactions and whether a cut is due; and (2) the history of past closeouts, each showing expected vs the actual counted amount, the variance (faltante if negative / sobrante if positive), the deposit method, who closed it and when. Answers "¿cuánto efectivo debería haber en caja?", "¿cuál fue el corte de hoy/ayer?", "¿hubo faltante o sobrante?". Pass venueId. Read-only; requires the settlements:read permission.',
    {
      venueId: z.string().describe('Venue whose cash closeout to read (must be in your scope)'),
      limit: z.number().int().positive().max(50).optional().describe('How many past closeouts to list (default 10)'),
    },
    async ({ venueId, limit }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('settlements:read', venueId) // same gate as the dashboard cash-closeouts endpoints
      const [expected, history] = await Promise.all([getExpectedCashAmount(venueId), getCloseoutHistory(venueId, 1, limit ?? 10)])
      return text({
        venueId,
        // What SHOULD be in the drawer now, before the next cut.
        currentDrawer: {
          expectedCash: round2(expected.expectedAmount),
          cashTransactions: expected.transactionCount,
          sinceLastCloseout: expected.periodStart.toISOString(),
          daysSinceLastCloseout: expected.daysSinceLastCloseout,
          hasPriorCloseouts: expected.hasCloseouts,
          needsCloseout: expected.needsCloseout, // true only when there is real cash activity to cut
        },
        totalCloseouts: history.pagination.total,
        recentCloseouts: history.data.map(c => ({
          id: c.id,
          periodStart: c.periodStart.toISOString(),
          periodEnd: c.periodEnd.toISOString(),
          expected: money(c.expectedAmount),
          actual: money(c.actualAmount),
          variance: money(c.variance), // negative = faltante, positive = sobrante
          variancePercent: money(c.variancePercent),
          depositMethod: c.depositMethod,
          closedBy: c.closedBy ? `${c.closedBy.firstName} ${c.closedBy.lastName}`.trim() : null,
          notes: c.notes ?? null,
          at: c.createdAt.toISOString(),
        })),
      })
    },
  )
}
