import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getPlanState } from '@/services/dashboard/planState.service'

/**
 * MCP tools for the venue base-plan (tier) lifecycle — READ-ONLY for now.
 *  - get_venue_plan_status (read) — planTier / grandfathered / trialEndsAt / state
 *
 * The WRITE actions (set grandfathered, comp plan, extend trial) stay dashboard-superadmin-only
 * for now and are intentionally NOT exposed here. Kept in lockstep with the dashboard plan portal
 * + planState.service / superadmin plan-admin endpoints.
 */
export function registerPlanAdminTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'get_venue_plan_status',
    'Base-plan (tier) status for a venue you can access. Returns the current planTier (GRATIS/PRO/PREMIUM/ENTERPRISE or null when on no paid plan), whether the venue is GRANDFATHERED (exempt from BOTH the Free seat cap AND every feature paywall — it operates as it did before tier monetization, so the dashboard suppresses all upsells), when any active trial ends (trialEndsAt, ISO string or null), and the lifecycle state (none/trial/active/canceling/past_due/suspended/canceled). Answers "¿en qué plan está este venue? ¿está grandfathered? ¿cuándo termina su prueba?". Pass venueId. Read-only — does not change the plan, grandfather flag, or trial.',
    {
      venueId: z.string().describe('Venue whose plan status to read (must be in your scope)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const state = await getPlanState(venueId)
      return text({
        venueId,
        planTier: state.planTier, // 'GRATIS' | 'PRO' | 'PREMIUM' | 'ENTERPRISE' | null
        grandfathered: state.grandfathered, // exempt from seat cap + every feature paywall
        trialEndsAt: state.trialEndsAt, // ISO string or null
        state: state.state, // none | trial | active | canceling | past_due | suspended | canceled
      })
    },
  )
}
