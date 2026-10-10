/**
 * Plano en el POS (spec 2026-10-09 §3.2): las dos rutas nuevas llevan EXACTAMENTE el mismo candado que `/tables`.
 *   npx jest --selectProjects=unit --runTestsByPath tests/unit/routes/mesas.version-y-plano.routes.test.ts
 */
import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { hasPermission } from '@/lib/permissions'

function inspectRoute(router: any, method: string, path: string) {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    const handlers = routeLayers.map(rl => rl.handle)
    const permissionLayer = routeLayers.find(rl => typeof (rl.handle as any)?.requiredPermission === 'string')
    return {
      hasAuthenticateToken: handlers.includes(authenticateTokenMiddleware),
      permission: (permissionLayer?.handle as any)?.requiredPermission,
    }
  }
  return undefined
}

describe('rutas del plano en el POS', () => {
  it.each(['/venues/:venueId/tables/version', '/venues/:venueId/floor-plan'])(
    'GET %s pide token y tables:read, igual que /tables',
    path => {
      const nueva = inspectRoute(mobileRouter, 'get', path)
      const tables = inspectRoute(mobileRouter, 'get', '/venues/:venueId/tables')
      expect(nueva).toBeDefined()
      expect(nueva!.hasAuthenticateToken).toBe(true)
      expect(nueva!.permission).toBe('tables:read')
      expect(nueva!.permission).toBe(tables!.permission)
    },
  )

  it.each([StaffRole.WAITER, StaffRole.CASHIER, StaffRole.HOST, StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])(
    '%s puede ver el plano (tiene tables:read)',
    role => {
      expect(hasPermission(role, null, 'tables:read')).toBe(true)
    },
  )
})
