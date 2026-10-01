import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TransactionStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { venuesWithFeatureAccess } from '@/services/access/basePlan.service'
import { hasPermission } from '@/services/access/access.service'

const num = (d: { toString(): string } | null): number => (d == null ? 0 : Number(d))
const round2 = (n: number): number => Math.round(n * 100) / 100

export function registerTrendTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  // Read gate for cross-venue revenue reports: only venues where the caller holds analytics:read
  // (per-venue role) participate — so a low-role staffer can't read revenue the dashboard would 403.
  const canRead = (venueId: string): boolean => {
    const access = scope.perVenueAccess.get(venueId)
    return !!access && hasPermission(access, 'analytics:read')
  }

  const reportScope = async (venueId?: string) => {
    guard.venueFilter(venueId)
    if (venueId) guard.requirePermission('analytics:read', venueId)
    const requested = venueId ? [venueId] : scope.allowedVenueIds
    const readable = requested.filter(canRead)
    const readableSet = new Set(readable)
    const ids = readable.length ? [...(await venuesWithFeatureAccess(readable, 'ADVANCED_REPORTS'))].filter(id => readableSet.has(id)) : []
    return {
      ids,
      coverage: {
        organizationId: scope.activeOrg,
        requestedVenueCount: requested.length,
        includedVenueCount: ids.length,
        excludedVenueCount: requested.length - ids.length,
        excludedByPermission: requested.length - readable.length,
        excludedByPlan: readable.length - ids.length,
        complete: ids.length === requested.length,
        ...(ids.length < requested.length
          ? { message: 'Total parcial: sólo incluye sucursales con permiso analytics:read y acceso a ADVANCED_REPORTS.' }
          : {}),
      },
      error:
        readable.length === 0
          ? { ok: false, permissionDenied: true, error: 'No tienes permiso analytics:read en ninguna sucursal de esta conexión.' }
          : {
              ok: false,
              planRequired: true,
              error: 'Los reportes avanzados no están incluidos en el plan actual (requiere ADVANCED_REPORTS / plan PRO).',
            },
    }
  }

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
      const { ids, coverage, error } = await reportScope(venueId)
      if (!ids.length) return text({ ...error, coverage })
      const base = { venueId: { in: ids } }
      const windowDays = days ?? 7 // zod applies the default in prod; stay robust if called raw
      const ms = windowDays * 24 * 60 * 60 * 1000
      const now = new Date()
      const curStart = new Date(now.getTime() - ms)
      const prevStart = new Date(now.getTime() - 2 * ms)
      const completed = { status: TransactionStatus.COMPLETED }

      const [cur, prev, venues] = await Promise.all([
        prisma.payment.groupBy({
          by: ['venueId'],
          where: { ...base, ...completed, createdAt: { gte: curStart, lte: now } },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        prisma.payment.groupBy({
          by: ['venueId'],
          where: { ...base, ...completed, createdAt: { gte: prevStart, lt: curStart } },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        prisma.venue.findMany({ where: { id: { in: ids } }, select: { id: true, currency: true }, take: ids.length }),
      ])
      if (venues.length !== ids.length)
        return text({
          ok: false,
          contextChanged: true,
          error: 'Cambió el conjunto de sucursales. Vuelve a consultar; no se calculó un total parcial.',
        })
      const currencyByVenue = new Map(venues.map(v => [v.id, (v.currency || 'UNKNOWN').toUpperCase()]))
      const summarize = (groups: typeof cur, currency?: string) => {
        const matching = currency ? groups.filter(g => currencyByVenue.get(g.venueId) === currency) : groups
        return {
          gross: round2(matching.reduce((total, g) => total + num(g._sum.amount), 0)),
          transactions: matching.reduce((total, g) => total + g._count._all, 0),
        }
      }
      const compare = (currency?: string) => {
        const current = summarize(cur, currency),
          previous = summarize(prev, currency)
        const delta = round2(current.gross - previous.gross)
        return {
          current: { from: curStart.toISOString(), to: now.toISOString(), ...current },
          previous: { from: prevStart.toISOString(), to: curStart.toISOString(), ...previous },
          change: {
            amount: delta,
            percent: previous.gross > 0 ? round2((delta / previous.gross) * 100) : null,
            direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
          },
        }
      }
      const byCurrency = [...new Set(currencyByVenue.values())].sort().map(currency => ({ currency, ...compare(currency) }))
      const totals = compare()
      return text({
        venueId: venueId ?? null,
        coverage,
        days: windowDays,
        ...totals,
        byCurrency,
        currency: byCurrency.length === 1 ? byCurrency[0].currency : null,
        ...(byCurrency.length > 1
          ? {
              current: { ...totals.current, gross: null },
              previous: { ...totals.previous, gross: null },
              change: null,
              currencyNote:
                'Compara los importes y porcentajes por moneda en byCurrency. No se mezclan monedas ni se convierte automáticamente.',
            }
          : {}),
      })
    },
  )

  server.tool(
    'revenue_by_venue',
    'Completed sales broken down BY VENUE across all the venues you can access, over the last N days (default 30): each venue\'s gross and transaction count, ranked highest first, plus the combined total. For multi-venue operators — answers "¿cuál de mis locales vende más? ¿cómo se comparan mis sucursales?". A single-venue operator just sees one row. days defaults to 30.',
    {
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
      days: z.number().int().min(1).max(365).default(30).describe('Window length in days (default 30)'),
    },
    async ({ days, limit = 50, offset = 0 }) => {
      const { ids: entitledIds, coverage, error } = await reportScope()
      if (!entitledIds.length) return text({ ...error, coverage })
      const base = { venueId: { in: entitledIds } }
      const windowDays = days ?? 30
      const start = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

      const [groups, venues] = await Promise.all([
        prisma.payment.groupBy({
          by: ['venueId'],
          where: { ...base, status: TransactionStatus.COMPLETED, createdAt: { gte: start } },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        prisma.venue.findMany({
          where: { id: { in: entitledIds } },
          select: { id: true, name: true, currency: true },
          take: entitledIds.length,
        }),
      ])

      if (venues.length !== entitledIds.length)
        return text({
          ok: false,
          contextChanged: true,
          error: 'Cambió el conjunto de sucursales. Vuelve a consultar; no se calculó un total parcial.',
        })
      const byVenue = new Map(groups.map(g => [g.venueId, g]))
      // Build from the full scoped venue list so venues with zero sales still show (ranked last).
      const rows = venues
        .map(v => {
          const g = byVenue.get(v.id)
          return {
            venueId: v.id,
            venue: v.name,
            currency: (v.currency || 'UNKNOWN').toUpperCase(),
            gross: round2(num(g?._sum.amount ?? null)),
            transactions: g?._count._all ?? 0,
          }
        })
        .sort((a, b) => a.currency.localeCompare(b.currency) || b.gross - a.gross || a.venueId.localeCompare(b.venueId))
      const totalsByCurrency = [...new Set(rows.map(r => r.currency))].sort().map(currency => ({
        currency,
        total: round2(rows.filter(r => r.currency === currency).reduce((s, r) => s + r.gross, 0)),
      }))
      const total = totalsByCurrency.length === 1 ? totalsByCurrency[0].total : null

      const page = rows.slice(offset, offset + limit)
      const hasMore = offset + page.length < rows.length
      return text({
        days: windowDays,
        since: start.toISOString(),
        venueCount: rows.length,
        total,
        coverage,
        totalsByCurrency,
        ...(totalsByCurrency.length > 1
          ? { currencyNote: 'Importes separados y ordenados por moneda; no se suman monedas distintas.' }
          : {}),
        count: page.length,
        hasMore,
        nextOffset: hasMore ? offset + page.length : null,
        venues: page,
      })
    },
  )
}
