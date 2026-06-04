import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export interface VenueFeatureInput {
  active: boolean
  endDate: Date | null
  trialEndDate: Date | null
  suspendedAt: Date | null
  gracePeriodEndsAt: Date | null
}

/** Pure: derive a human subscription state from a VenueFeature's billing fields. */
export function subscriptionState(f: VenueFeatureInput, now: Date): string {
  if (f.suspendedAt) return 'SUSPENDED'
  if (f.gracePeriodEndsAt && f.gracePeriodEndsAt.getTime() > now.getTime()) return 'GRACE_PERIOD'
  if (f.trialEndDate && f.trialEndDate.getTime() > now.getTime()) return 'TRIAL'
  if (!f.active) return 'INACTIVE'
  return 'ACTIVE'
}

export function registerBillingTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'subscription_status',
    "Your venues' paid features / subscriptions: which features are active, each one's billing state (ACTIVE / TRIAL / GRACE_PERIOD / SUSPENDED / INACTIVE), its monthly price, and trial/grace dates. Surfaces anything that needs attention (suspended or in grace period). Pass venueId to focus one venue.",
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
    },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId) // throws if out of scope
      const now = new Date()
      const rows = await prisma.venueFeature.findMany({
        where,
        select: {
          active: true,
          monthlyPrice: true,
          endDate: true,
          trialEndDate: true,
          suspendedAt: true,
          gracePeriodEndsAt: true,
          feature: { select: { code: true, name: true } },
          venue: { select: { name: true } },
        },
        orderBy: { startDate: 'desc' },
      })

      const features = rows.map(r => ({
        feature: r.feature?.name ?? r.feature?.code,
        state: subscriptionState(r as VenueFeatureInput, now),
        monthlyPrice: Number(r.monthlyPrice),
        trialEndDate: r.trialEndDate,
        gracePeriodEndsAt: r.gracePeriodEndsAt,
        venue: r.venue?.name,
      }))
      const needsAttention = features.filter(f => f.state === 'SUSPENDED' || f.state === 'GRACE_PERIOD')

      return text({
        venuesInScope: venueId ? 1 : scope.allowedVenueIds.length,
        count: features.length,
        needsAttention: needsAttention.length,
        features,
      })
    },
  )
}
