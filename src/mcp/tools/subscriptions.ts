import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getVenueSubscription, type SuperadminVenueSubscription, type SubscriptionState } from '@/services/superadmin/subscription.service'

/** Empty per-state tally — also the shape returned when no venue rows are in scope. */
const zeroCounts = (): Record<SubscriptionState, number> & { total: number } => ({
  active: 0,
  trial: 0,
  canceling: 0,
  past_due: 0,
  suspended: 0,
  canceled: 0,
  none: 0,
  total: 0,
})

export interface SubscriptionStatusSummary {
  counts: Record<SubscriptionState, number> & { total: number }
  mrrTotal: number
  currency: 'MXN'
}

/**
 * Pure roll-up of per-venue PLAN_PRO subscription rows for the LLM: how many of
 * the caller's venues sit in each state, plus total monthly-normalized MRR
 * (pesos, rounded to cents). An empty list yields a fully zeroed overview.
 */
export function summarizeSubscriptions(rows: SuperadminVenueSubscription[]): SubscriptionStatusSummary {
  const counts = zeroCounts()
  let mrrTotal = 0
  for (const r of rows) {
    counts[r.state] += 1
    counts.total += 1
    mrrTotal += r.mrr
  }
  return { counts, mrrTotal: Math.round(mrrTotal * 100) / 100, currency: 'MXN' }
}

export function registerSubscriptionTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'subscription_status',
    "PLAN_PRO base-subscription status for your venues (or one venue). Returns each venue's plan state (trial/active/canceling/past_due/suspended/canceled/none), trial-end or renewal date, monthly price, and a roll-up of how many of your venues are in each state plus total MRR. Pass venueId to focus one venue (must be in your scope); omit for all your venues.",
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
    },
    async ({ venueId }) => {
      // Resolve target venue IDs through the guard: throws ScopeError if venueId is out of scope.
      const where = guard.venueFilter(venueId)
      const venueIds = where.venueId.in

      const loaded = await Promise.all(venueIds.map(id => getVenueSubscription(id)))
      const rows = loaded.filter((r): r is SuperadminVenueSubscription => r !== null)

      const overview = summarizeSubscriptions(rows)
      return text({
        venuesInScope: venueIds.length,
        overview: { counts: overview.counts, mrrTotal: overview.mrrTotal, currency: overview.currency },
        venues: rows,
      })
    },
  )
}
