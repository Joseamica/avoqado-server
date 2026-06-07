import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TransactionStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const num = (d: { toString(): string } | null): number => (d == null ? 0 : Number(d))
const round2 = (n: number): number => Math.round(n * 100) / 100

export function registerTrendTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'sales_comparison',
    'Compare a venue\'s completed sales over the last N days against the previous N days — gross, transaction count, and the change (absolute + %). Tells you at a glance whether business is up or down. Answers "¿vendí más que la semana pasada? ¿voy mejor o peor que el mes pasado?". Pass venueId to focus one venue (omit for all yours); days defaults to 7 (this week vs last week).',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .default(7)
        .describe('Length of each window in days (7 = this week vs last; 30 = this month vs last)'),
    },
    async ({ venueId, days }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const windowDays = days ?? 7 // zod applies the default in prod; stay robust if called raw
      const ms = windowDays * 24 * 60 * 60 * 1000
      const now = new Date()
      const curStart = new Date(now.getTime() - ms)
      const prevStart = new Date(now.getTime() - 2 * ms)
      const completed = { status: TransactionStatus.COMPLETED }

      const [cur, prev] = await Promise.all([
        prisma.payment.aggregate({
          where: { ...base, ...completed, createdAt: { gte: curStart, lte: now } },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        prisma.payment.aggregate({
          where: { ...base, ...completed, createdAt: { gte: prevStart, lt: curStart } },
          _sum: { amount: true },
          _count: { _all: true },
        }),
      ])

      const curGross = round2(num(cur._sum.amount))
      const prevGross = round2(num(prev._sum.amount))
      const delta = round2(curGross - prevGross)
      // % needs a non-zero base; null (not Infinity/NaN) when the previous period had no sales.
      const pct = prevGross > 0 ? round2((delta / prevGross) * 100) : null

      return text({
        venueId: venueId ?? null,
        days: windowDays,
        current: { from: curStart.toISOString(), to: now.toISOString(), gross: curGross, transactions: cur._count._all },
        previous: { from: prevStart.toISOString(), to: curStart.toISOString(), gross: prevGross, transactions: prev._count._all },
        change: { amount: delta, percent: pct, direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat' },
      })
    },
  )
}
