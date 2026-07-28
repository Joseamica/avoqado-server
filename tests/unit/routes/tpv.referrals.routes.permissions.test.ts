/**
 * Middleware-chain audit for the /tpv referrals capture-only surface (superficie /tpv,
 * 2026-07-27) — closes the TPV's last 3 calls into /dashboard
 * (avoqado-tpv ReferralsApiService.kt:41,58,68).
 *
 * Same technique as tests/unit/routes/tpv.tables.routes.permissions.test.ts: static
 * introspection of the REAL router stack (no DB, no mocks) — if someone removes
 * `validateVenueAccess` or changes a route's permission string, these tests fail without
 * touching a database.
 *
 * `checkPermission('X')` tags the returned middleware with `.requiredPermission = X`
 * (checkPermission.middleware.ts), so it can be read straight off the stack.
 */

import { StaffRole } from '@prisma/client'
import tpvRouter from '@/routes/tpv.routes'
import { validateVenueAccess } from '@/middlewares/validateVenueAccess.middleware'
import { hasPermission } from '@/lib/permissions'

interface RouteInspection {
  hasValidateVenueAccess: boolean
  permission?: string
}

function inspectRoute(router: any, method: string, path: string): RouteInspection | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue

    const hasValidateVenueAccess = routeLayers.some(rl => rl.handle === validateVenueAccess)
    const permissionLayer = routeLayers.find(rl => typeof (rl.handle as any)?.requiredPermission === 'string')

    return {
      hasValidateVenueAccess,
      permission: (permissionLayer?.handle as any)?.requiredPermission,
    }
  }
  return undefined
}

describe('tpv.routes — referrals (capture-only surface)', () => {
  // [method, path, expectedPermission] — mirrors dashboard/referrals.routes.ts:94,104,114
  // EXACTLY: validate/capture use referral:read; force-override carries the STRONGER
  // referral:override-existing-customer.
  const cases: Array<[string, string, string]> = [
    ['post', '/venues/:venueId/referrals/validate', 'referral:read'],
    ['post', '/venues/:venueId/referrals/capture', 'referral:read'],
    ['post', '/venues/:venueId/referrals/force-override', 'referral:override-existing-customer'],
  ]

  it.each(cases)('%s %s → validateVenueAccess presente', (method, path) => {
    const route = inspectRoute(tpvRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.hasValidateVenueAccess).toBe(true)
  })

  it.each(cases)('%s %s → exige permiso %s', (method, path, expectedPermission) => {
    const route = inspectRoute(tpvRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.permission).toBe(expectedPermission)
  })

  it('force-override exige un permiso MAS FUERTE que validate/capture (asimetría a propósito, no un descuido)', () => {
    const validateRoute = inspectRoute(tpvRouter, 'post', '/venues/:venueId/referrals/validate')
    const captureRoute = inspectRoute(tpvRouter, 'post', '/venues/:venueId/referrals/capture')
    const overrideRoute = inspectRoute(tpvRouter, 'post', '/venues/:venueId/referrals/force-override')

    expect(validateRoute!.permission).toBe('referral:read')
    expect(captureRoute!.permission).toBe('referral:read')
    expect(overrideRoute!.permission).toBe('referral:override-existing-customer')
    expect(overrideRoute!.permission).not.toBe(validateRoute!.permission)
  })

  // Rutas que NO deben existir bajo /tpv — la superficie es deliberadamente angosta
  // (config/summary/hall-of-fame/listing/manual-void se quedan solo en /dashboard).
  it.each([
    ['get', '/venues/:venueId/referrals/config'],
    ['patch', '/venues/:venueId/referrals/config'],
    ['post', '/venues/:venueId/referrals/activate'],
    ['post', '/venues/:venueId/referrals/deactivate'],
    ['get', '/venues/:venueId/referrals'],
    ['get', '/venues/:venueId/referrals/summary'],
    ['get', '/venues/:venueId/referrals/hall-of-fame'],
    ['post', '/venues/:venueId/referrals/:referralId/manual-void'],
  ])('%s %s → NO existe bajo /tpv (superficie angosta a propósito)', (method, path) => {
    expect(inspectRoute(tpvRouter, method, path)).toBeUndefined()
  })

  // Defensa real: qué rol satisface cada permiso contra el catálogo de verdad
  // (DEFAULT_PERMISSIONS), sin mocks.
  it('WAITER: sí referral:read, NO referral:override-existing-customer', () => {
    expect(hasPermission(StaffRole.WAITER, null, 'referral:read')).toBe(true)
    expect(hasPermission(StaffRole.WAITER, null, 'referral:override-existing-customer')).toBe(false)
  })

  it('CASHIER: sí referral:read, NO referral:override-existing-customer', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'referral:read')).toBe(true)
    expect(hasPermission(StaffRole.CASHIER, null, 'referral:override-existing-customer')).toBe(false)
  })

  it('MANAGER: sí referral:read Y sí referral:override-existing-customer', () => {
    expect(hasPermission(StaffRole.MANAGER, null, 'referral:read')).toBe(true)
    expect(hasPermission(StaffRole.MANAGER, null, 'referral:override-existing-customer')).toBe(true)
  })
})
