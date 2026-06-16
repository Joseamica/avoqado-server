/**
 * Permission guards for the venue plan/seat endpoints the dashboard tier-gate depends on.
 *
 * Prod incident 2026-06-13 (+ follow-up audit): gating SIGNALS were guarded by
 * billing:subscriptions:read (ADMIN/OWNER only), so sub-ADMIN staff (MANAGER/CASHIER/…) 403'd and
 * the UI mis-gated (wrong inventory paywall; the Free seat-cap upsell silently hidden on Teams).
 * The non-sensitive gating signals must be readable by the operational roles that reach those
 * surfaces — while the billing DETAIL endpoint (price + Stripe) stays ADMIN/OWNER-only.
 *
 * These assertions fail with the old guards and pass with the fix.
 */
import router from '@/routes/dashboard.routes'

type AuditedRoute = { method: string; path: string; permission: string }

function collectAuditedRoutes(r: any): AuditedRoute[] {
  const routes: AuditedRoute[] = []
  for (const layer of r.stack ?? []) {
    if (!layer.route) continue
    const path: string = layer.route.path
    for (const routeLayer of layer.route.stack ?? []) {
      const method: string | undefined = routeLayer.method
      const permission: string | undefined = (routeLayer.handle as any)?.requiredPermission
      if (!method || !permission) continue
      routes.push({ method, path, permission })
    }
  }
  return routes
}

describe('venue plan/seat routes — permission guards', () => {
  const audited = collectAuditedRoutes(router)
  const find = (method: string, path: string) => audited.find(r => r.method === method && r.path === path)

  it('GET /venues/:venueId/plan-tier → home:read (the ONLY read perm held by EVERY venue role)', () => {
    // The minimal { tier, grandfathered, exempt } gating signal — no price/Stripe. The gate hook
    // runs on every page for every role, so the guard must be universal: features:read is missing on
    // HOST/KITCHEN/WAITER/CASHIER and teams:read is missing on KITCHEN — only home:read covers all.
    expect(find('get', '/venues/:venueId/plan-tier')?.permission).toBe('home:read')
  })

  it('GET /venues/:venueId/plan/seat-status → teams:read (NOT billing — the Free seat-cap upsell)', () => {
    // Drives the proactive seat-cap paywall on the Teams "Invitar" CTA, which MANAGER reaches.
    // Was billing:subscriptions:read → MANAGER 403'd → upsell silently hidden.
    expect(find('get', '/venues/:venueId/plan/seat-status')?.permission).toBe('teams:read')
  })

  it('GET /venues/:venueId/plan → billing:subscriptions:read (billing DETAIL stays ADMIN/OWNER-only)', () => {
    // The full PlanState (price + Stripe ids) must NOT be broadened — the gating signal lives on
    // /plan-tier instead. This guards against accidentally leaking billing detail to all roles.
    expect(find('get', '/venues/:venueId/plan')?.permission).toBe('billing:subscriptions:read')
  })
})
