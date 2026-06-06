import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export function registerTableTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'tables_status',
    'Live table/floor status for a venue you can access: every table with its number, area/section, capacity, status (available/occupied/reserved/cleaning) and — when occupied — the live order on it (order number, total, paid, remaining balance, payment status, opened-at). Plus a count by status. Answers "¿qué mesas tengo ocupadas / libres ahorita? ¿cuánto lleva la mesa 12?". Pass venueId; optionally filter by area. (Dine-in venues; appointment/retail venues may simply have no tables.)',
    {
      venueId: z.string().describe('Venue whose tables to read (must be in your scope)'),
      area: z.string().optional().describe('Filter to one area/section by name (partial, case-insensitive)'),
      includeInactive: z.boolean().optional().describe('Include inactive/archived tables (default: only active)'),
    },
    async ({ venueId, area, includeInactive }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const tables = await prisma.table.findMany({
        where: {
          ...base,
          ...(includeInactive ? {} : { active: true }),
          ...(area ? { area: { name: { contains: area, mode: 'insensitive' as const } } } : {}),
        },
        select: {
          number: true,
          capacity: true,
          status: true,
          area: { select: { name: true } },
          currentOrder: {
            select: { orderNumber: true, total: true, paidAmount: true, remainingBalance: true, paymentStatus: true, createdAt: true },
          },
        },
        orderBy: { number: 'asc' },
      })

      const byStatus: Record<string, number> = {}
      for (const t of tables) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1

      return text({
        venueId,
        total: tables.length,
        byStatus, // { AVAILABLE: n, OCCUPIED: n, RESERVED: n, CLEANING: n }
        tables: tables.map(t => ({
          number: t.number,
          area: t.area?.name ?? null,
          capacity: t.capacity,
          status: t.status,
          order: t.currentOrder
            ? {
                orderNumber: t.currentOrder.orderNumber,
                total: Number(t.currentOrder.total),
                paid: Number(t.currentOrder.paidAmount),
                balance: Number(t.currentOrder.remainingBalance),
                paymentStatus: t.currentOrder.paymentStatus,
                openedAt: t.currentOrder.createdAt.toISOString(),
              }
            : null,
        })),
      })
    },
  )
}
