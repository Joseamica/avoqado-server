import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getPlanState } from '@/services/dashboard/planState.service'

/**
 * MCP tools for the venue base-plan (tier) lifecycle — READ-ONLY for now.
 *  - get_venue_plan_status (read) — planTier / grandfathered / trialEndsAt / state, plus WHERE the plan comes from
 *    (origin: classic subscription, campaign contract or courtesy) and whether the pause offer applies
 *
 * The WRITE actions (set grandfathered, comp plan, extend trial) stay dashboard-superadmin-only
 * for now and are intentionally NOT exposed here. Kept in lockstep with the dashboard plan portal
 * + planState.service / superadmin plan-admin endpoints.
 */
export function registerPlanAdminTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'get_venue_plan_status',
    'Estado del plan de un negocio al que tienes acceso. El plan puede venir de una suscripción clásica, de un contrato de campaña o de una cortesía (prueba o plan regalado): origin dice cuál (kind CLASSIC, CONTRACT, COMP o NONE si no hay plan), con su nivel (tier PRO o PREMIUM), su precio mensual en pesos con IVA (gross) y sin IVA (base), su intervalo, hasta cuándo está pagado (currentPeriodEnd), cuándo deja de renovarse si ya se programó (cancelAt) y el contrato (contractId) cuando viene de uno. Lee origin primero: planTier y state no cuentan los contratos, así que un negocio que paga Premium por contrato trae planTier null y state none, pero origin CONTRACT con tier PREMIUM. También dice si el negocio es GRANDFATHERED (exento del tope de usuarios de Gratis y de todos los muros de pago), cuándo termina una prueba (trialEndsAt) y si hoy se le puede ofrecer pausar el plan en vez de cancelarlo (pauseOfferEligible). Responde «¿en qué plan está este negocio? ¿cuánto paga y hasta cuándo? ¿está grandfathered? ¿cuándo termina su prueba?». Pasa venueId. Sólo lectura: no cambia el plan, la exención ni la prueba.',
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
        // Where the plan comes from: a contract-paid Premium has planTier null / state 'none' but origin CONTRACT PREMIUM.
        // Only the customer-facing fields; price is already in pesos.
        origin: state.origin
          ? {
              kind: state.origin.kind,
              tier: state.origin.tier,
              price: state.origin.price,
              interval: state.origin.interval,
              currentPeriodEnd: state.origin.currentPeriodEnd,
              cancelAt: state.origin.cancelAt,
              contractId: state.origin.contractId,
            }
          : null,
        pauseOfferEligible: state.pauseOfferEligible ?? false,
      })
    },
  )
}
