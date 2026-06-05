import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

const round1 = (n: number | null): number | null => (n == null ? null : Math.round(n * 10) / 10)

export function registerReviewTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_reviews',
    'Customer reviews & ratings for a venue you can access: an overall summary (how many + average stars, plus food/service/ambience averages) and the most recent reviews (stars, comment, who served, date, source). Optionally filter by minimum rating. Answers "¿cómo están mis reseñas / calificaciones?". Pass venueId.',
    {
      venueId: z.string().describe('Venue whose reviews to read (must be in your scope)'),
      minRating: z.number().int().min(1).max(5).optional().describe('Only reviews with overall rating ≥ this (1–5)'),
      limit: z.number().int().positive().max(50).optional().describe('How many recent reviews to return (default 10)'),
    },
    async ({ venueId, minRating, limit }) => {
      const where = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const reviewWhere = { ...where, ...(minRating ? { overallRating: { gte: minRating } } : {}) }
      const [agg, recent] = await Promise.all([
        prisma.review.aggregate({
          where: reviewWhere,
          _count: { _all: true },
          _avg: { overallRating: true, foodRating: true, serviceRating: true, ambienceRating: true },
        }),
        prisma.review.findMany({
          where: reviewWhere,
          select: {
            overallRating: true,
            foodRating: true,
            serviceRating: true,
            ambienceRating: true,
            comment: true,
            customerName: true,
            source: true,
            createdAt: true,
            servedBy: { select: { firstName: true, lastName: true } },
            responseText: true,
          },
          orderBy: { createdAt: 'desc' },
          take: limit ?? 10,
        }),
      ])
      return text({
        venueId,
        summary: {
          count: agg._count._all,
          avgOverall: round1(agg._avg.overallRating),
          avgFood: round1(agg._avg.foodRating),
          avgService: round1(agg._avg.serviceRating),
          avgAmbience: round1(agg._avg.ambienceRating),
        },
        recent: recent.map(r => ({
          stars: r.overallRating,
          food: r.foodRating,
          service: r.serviceRating,
          ambience: r.ambienceRating,
          comment: r.comment,
          customer: r.customerName,
          servedBy: r.servedBy ? `${r.servedBy.firstName} ${r.servedBy.lastName}`.trim() : null,
          source: r.source,
          responded: !!r.responseText,
          date: r.createdAt.toISOString(),
        })),
      })
    },
  )
}
