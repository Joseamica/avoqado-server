/**
 * Rutas de paquetes/membresías del POS (`/mobile`) — el permiso tiene que ser de
 * OPERAR, no de ADMINISTRAR el catálogo (decisión del founder, 2026-08-16).
 *
 * Lo que estaba mal:
 *   - VENDER un paquete exigía `creditPacks:create`, que en el dashboard es la llave
 *     de `POST /dashboard/venues/:venueId/credit-packs` — crear un paquete NUEVO en el
 *     catálogo, con su precio y sus sesiones.
 *   - CANJEAR una sesión exigía `creditPacks:update`, la llave de editar ese catálogo.
 * O sea: para entregarle al socio la clase que ya pagó, había que poder cambiarle el
 * precio al paquete. El founder decidió justo lo contrario ("vender y canjear, sin
 * editar catálogo"), así que estas dos rutas pasan a permisos acotados —espejo de
 * `coupons:redeem`, que estos roles ya tienen.
 *
 * Introspección ESTÁTICA del router real de Express (mismo patrón que
 * `mobile.terminalsOnline.routes.permissions.test.ts`): sin supertest y sin DB.
 */

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { hasPermission } from '@/lib/permissions'

interface RouteInspection {
  hasAuthenticateToken: boolean
  permission?: string
}

function inspectRoute(router: any, method: string, path: string): RouteInspection | undefined {
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

const SELL_PATH = '/venues/:venueId/credit-packs/:packId/sell'
const REDEEM_PATH = '/venues/:venueId/credit-balances/:balanceId/redeem'
const LIST_PATH = '/venues/:venueId/credit-packs'
const BALANCE_PATH = '/venues/:venueId/customers/:customerId/credit-balance'
const CREATE_CUSTOMER_PATH = '/venues/:venueId/customers'

describe('mobile.routes — paquetes: el gate es operar, no administrar', () => {
  const cases: Array<[string, string, string]> = [
    ['get', LIST_PATH, 'creditPacks:read'],
    ['get', BALANCE_PATH, 'creditPacks:read'],
    ['post', SELL_PATH, 'creditPacks:sell'],
    ['post', REDEEM_PATH, 'creditPacks:redeem'],
  ]

  it.each(cases)('%s %s → sigue autenticada', (method, path) => {
    const route = inspectRoute(mobileRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
  })

  it.each(cases)('%s %s → exige %s (string EXACTO)', (method, path, expected) => {
    const route = inspectRoute(mobileRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.permission).toBe(expected)
  })

  it('🔴 ninguna ruta del POS exige una llave de ADMINISTRAR el catálogo', () => {
    for (const [method, path] of cases) {
      const route = inspectRoute(mobileRouter, method, path)
      expect(['creditPacks:create', 'creditPacks:update', 'creditPacks:delete']).not.toContain(route!.permission)
    }
  })

  it.each([StaffRole.CASHIER, StaffRole.WAITER])('un %s con permisos default pasa las 4 rutas', role => {
    for (const [method, path] of cases) {
      const route = inspectRoute(mobileRouter, method, path)
      expect(hasPermission(role, null, route!.permission!)).toBe(true)
    }
  })

  it.each([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])('%s no pierde acceso con los permisos nuevos', role => {
    for (const [method, path] of cases) {
      const route = inspectRoute(mobileRouter, method, path)
      expect(hasPermission(role, null, route!.permission!)).toBe(true)
    }
  })
})

describe('mobile.routes — alta de cliente desde el cobro', () => {
  it('POST /venues/:venueId/customers sigue exigiendo customers:create', () => {
    const route = inspectRoute(mobileRouter, 'post', CREATE_CUSTOMER_PATH)
    expect(route).toBeDefined()
    expect(route!.permission).toBe('customers:create')
  })

  it.each([StaffRole.CASHIER, StaffRole.WAITER, StaffRole.HOST])('%s la pasa (la regresión que se cierra)', role => {
    const route = inspectRoute(mobileRouter, 'post', CREATE_CUSTOMER_PATH)
    expect(hasPermission(role, null, route!.permission!)).toBe(true)
  })
})
