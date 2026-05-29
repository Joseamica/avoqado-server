import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { prisma, text, formatMoney } from '../context'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'

export interface SalesInput {
  amount: number | { toString(): string }
  method: string
  type: string | null
  status: string
}

export interface SalesSummary {
  completedCount: number
  gross: number
  byMethod: Record<string, number>
  byType: Record<string, number>
}

/** Pure aggregation over payment rows. Only COMPLETED payments count toward totals. */
export function summarizeSales(payments: SalesInput[]): SalesSummary {
  const summary: SalesSummary = { completedCount: 0, gross: 0, byMethod: {}, byType: {} }
  for (const p of payments) {
    if (p.status !== 'COMPLETED') continue
    const amt = Number(p.amount)
    summary.completedCount += 1
    summary.gross += amt
    summary.byMethod[p.method] = (summary.byMethod[p.method] ?? 0) + amt
    const t = p.type ?? 'UNKNOWN'
    summary.byType[t] = (summary.byType[t] ?? 0) + amt
  }
  return summary
}

export function registerSalesTools(server: McpServer) {
  server.tool(
    'daily_sales',
    "Sales summary for a venue over a day (default: today in the venue's timezone). Returns completed-payment count, gross total, and breakdowns by payment method and by payment type (REGULAR/FAST/etc).",
    {
      venueId: z.string().describe('Venue id (use list_venues to resolve)'),
      date: z.string().optional().describe('ISO date YYYY-MM-DD; defaults to today in the venue timezone'),
    },
    async ({ venueId, date }) => {
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true, timezone: true } })
      if (!venue) return text({ error: `Venue ${venueId} not found` })

      const ref = date ? new Date(`${date}T12:00:00`) : undefined
      const start = venueStartOfDay(venue.timezone, ref)
      const end = venueEndOfDay(venue.timezone, ref)

      const payments = await prisma.payment.findMany({
        where: { venueId, createdAt: { gte: start, lte: end } },
        select: { amount: true, method: true, type: true, status: true },
      })

      const summary = summarizeSales(payments as SalesInput[])
      return text({
        venue: venue.name,
        window: { start: start.toISOString(), end: end.toISOString() },
        grossFormatted: formatMoney(summary.gross),
        ...summary,
      })
    },
  )
}
