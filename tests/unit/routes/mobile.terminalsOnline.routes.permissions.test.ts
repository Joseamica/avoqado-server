/**
 * GET /mobile/venues/:venueId/terminals/online — el permiso correcto es de COBRO,
 * no de administración de terminales (2026-08-16).
 *
 * Bug medido en hardware: un CASHIER cobrando veía en la pantalla de propina el
 * modal global «No tienes permiso — Pídele a un administrador que te active
 * «tpv:read»». La app consulta sola esta ruta para saber qué terminal PAX está
 * conectada, y la ruta exigía `tpv:read` — el permiso de ADMINISTRAR terminales
 * (listarlas y ver su salud desde el dashboard). CASHIER tiene `payments:create`
 * pero NO `tpv:read`; a WAITER sí se le dio y a CASHIER se le olvidó.
 *
 * Saber qué terminal está prendida es parte de COBRAR: sus rutas hermanas del
 * mismo flujo (mandar el cobro, cancelarlo, imprimir el recibo) ya exigen
 * `payments:create`, el status `payments:read` y la devolución `payments:refund`.
 * Ésta era la única desalineada.
 *
 * El test hace introspección estática del router REAL de Express (mismo patrón
 * que `tpv.tables.routes.permissions.test.ts`): sin mocks y sin DB. Si alguien
 * vuelve a poner un permiso de administración en el flujo de cobro, truena aquí
 * y no en la pantalla de propina de un cajero con fila.
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

const ONLINE_TERMINALS_PATH = '/venues/:venueId/terminals/online'

describe('GET /mobile/venues/:venueId/terminals/online — permiso del flujo de cobro', () => {
  it('sigue autenticada', () => {
    const route = inspectRoute(mobileRouter, 'get', ONLINE_TERMINALS_PATH)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
  })

  it('exige payments:create, no un permiso de administrar terminales', () => {
    const route = inspectRoute(mobileRouter, 'get', ONLINE_TERMINALS_PATH)
    expect(route).toBeDefined()
    expect(route!.permission).toBe('payments:create')
  })

  it('un CASHIER con los permisos default LA PASA (la regresión que se cierra)', () => {
    const route = inspectRoute(mobileRouter, 'get', ONLINE_TERMINALS_PATH)
    expect(route).toBeDefined()
    expect(hasPermission(StaffRole.CASHIER, null, route!.permission!)).toBe(true)
  })

  it('CASHIER NO satisface tpv:read — por eso el permiso viejo le sacaba el modal', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'tpv:read')).toBe(false)
  })

  it.each([StaffRole.WAITER, StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])(
    '%s no pierde acceso con el permiso nuevo (hoy entraba por tpv:read)',
    role => {
      const route = inspectRoute(mobileRouter, 'get', ONLINE_TERMINALS_PATH)
      expect(hasPermission(role, null, route!.permission!)).toBe(true)
    },
  )
})

describe('todo el flujo de terminal vive en el namespace payments:*', () => {
  // [method, path, permiso esperado] — el flujo completo que corre un cajero.
  const cases: Array<[string, string, string]> = [
    ['post', '/venues/:venueId/terminal-payment', 'payments:create'],
    ['post', '/venues/:venueId/terminal-payment/cancel', 'payments:create'],
    ['post', '/venues/:venueId/terminals/:terminalId/print-receipt', 'payments:create'],
    ['post', '/venues/:venueId/terminals/:terminalId/refund-request', 'payments:refund'],
    ['get', '/venues/:venueId/terminal-payment/:requestId', 'payments:read'],
    ['get', ONLINE_TERMINALS_PATH, 'payments:create'],
  ]

  it.each(cases)('%s %s → exige %s', (method, path, expectedPermission) => {
    const route = inspectRoute(mobileRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.permission).toBe(expectedPermission)
  })

  it('ninguna ruta del flujo de cobro exige un permiso de administrar terminales', () => {
    for (const [method, path] of cases) {
      const route = inspectRoute(mobileRouter, method, path)
      expect(route!.permission!.startsWith('tpv')).toBe(false)
    }
  })
})
