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

// CAPABILITY NOTE (MCP sync): the backend exposes a self-serve base-plan checkout
// endpoint — POST /api/v1/dashboard/venues/:venueId/plan/checkout (controller
// venueDashboardService.createVenuePlanCheckoutSession). It accepts { interval,
// tier } where tier is 'PRO' | 'PREMIUM' (PLAN_PRO / PLAN_PREMIUM), creates a Stripe
// Checkout Session in mode 'subscription' for that tier, and returns { success, url }
// for the browser to redirect to. It is intentionally NOT exposed as an MCP tool yet:
// every tool here is read-only, whereas this is a payment/write action that mints a
// live Stripe redirect URL. Exposing it to agents needs a deliberate decision
// (confirmation UX, idempotency, scope, tier selection). TODO: add a
// `start_plan_checkout` action tool once the MCP gains a vetted action/write surface.
// Read state via `subscription_status` below in the meantime.
//
// CAPABILITY NOTE (MCP sync): the backend also exposes a cancellation-retention action —
// POST /api/v1/dashboard/venues/:venueId/plan/retention-offer (controller
// venueDashboardService → planStateService.applyRetentionOffer). It accepts
// { offer: 'discount' | 'pause' } and either applies the RETENTION_30_3M coupon (30% off,
// 3 months) to the live base-plan subscription or pauses collection for ~2 months. Like
// plan/checkout it is intentionally NOT exposed as an MCP tool yet: it is a billing WRITE
// that mutates a live Stripe subscription's price/collection and is gated by anti-abuse
// eligibility (the DISCOUNT offer requires a live Stripe sub, ≥30-day subscription tenure, and
// no discount already active — so a brand-new subscriber can't buy → cancel → farm the
// discount) — exposing it to agents needs a vetted action/write surface (confirmation UX,
// idempotency, scope). TODO: add an `apply_retention_offer` action tool alongside
// `start_plan_checkout` once that surface lands. Read state (incl. retentionOfferEligible) via
// the plan endpoint / `subscription_status` below in the meantime.
//
// CAPABILITY NOTE (MCP sync): the backend also exposes the Pro→Free DOWNGRADE seat-reconciliation
// flow — GET /api/v1/dashboard/venues/:venueId/plan/downgrade-preview (read) and
// POST /api/v1/dashboard/venues/:venueId/plan/downgrade (write, body { keepStaffVenueIds }),
// backed by seatReconciliation.service (scheduleDowngradeToFree → planStateService.cancelPlan +
// pendingSeatReconciliation; executeSeatReconciliation runs on the paid→Free Stripe webhook).
// The downgrade POST is a billing WRITE that schedules a cancel-at-period-end AND captures which
// seats get deactivated at period end — intentionally NOT an MCP tool yet for the same reason as
// plan/checkout and retention-offer (needs a vetted action/write surface: confirmation UX,
// idempotency, scope). The READ side IS exposed: `get_venue_seat_status` (tools/seats.ts) returns
// the venue's seat cap / current count / allowed / exempt, read-only.
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
