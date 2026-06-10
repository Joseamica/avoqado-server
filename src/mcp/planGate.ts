import { venueHasFeatureAccess } from '@/services/access/basePlan.service'

/**
 * Tier/plan gate for MCP tools — mirrors the dashboard's FeatureGate using the
 * SAME authoritative resolver (venueHasFeatureAccess: grandfathered → allowed;
 * explicit VenueFeature grant → allowed; PLAN_PREMIUM → all; PLAN_PRO → all
 * except premium-only differentiators; FREE → explicit grants only).
 *
 * Returns null when the venue is entitled, or a friendly upsell message the
 * tool should surface as { ok:false, planRequired:true, error } — consistent
 * with cfdi_status. Feature CODES per capability follow the pricing catalog
 * (avoqado-web-dashboard/src/config/plan-catalog.ts):
 *   PRO     → ADVANCED_REPORTS · LOYALTY_PROGRAM · PROMOTIONS · RESERVATIONS
 *   PREMIUM → CFDI · INVENTORY_TRACKING · SERIALIZED_INVENTORY · COMMISSIONS
 */
export async function planGateMessage(venueId: string, featureCode: string, capability: string): Promise<string | null> {
  const entitled = await venueHasFeatureAccess(venueId, featureCode)
  if (entitled) return null
  return `${capability} no está incluido en el plan actual de este local (requiere ${featureCode}). El dueño puede subir de plan en el dashboard (Configuración → Plan).`
}
