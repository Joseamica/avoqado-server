/**
 * "Forma B" de la auditoría de permisos de piso: acciones de MESA gateadas con permisos
 * de ORDEN (`docs/superpowers/specs/2026-08-16-auditoria-permisos-piso.md`, §3 y caso #17).
 *
 * Consecuencia medida: `tables:update` era un permiso MUERTO. Se le daba a HOST y a
 * WAITER —y CASHIER lo heredaba vía `tpv-tables:assign`— y NINGUNA ruta HTTP lo leía
 * (sólo el MCP `set_table_status`). Le prometíamos "gestión de sala" al anfitrión y no
 * había una sola puerta que ese permiso abriera: abrir mesa, liberar mesa y mover cuenta
 * pedían `orders:create` / `orders:update`, que el HOST no tiene.
 *
 * Veredicto: se CABLEA, no se declara muerto. Abrir, liberar y mover son actos de SALA
 * —cambian el estado del piso—, y la orden DINE_IN vacía que abrir crea es un detalle de
 * implementación: nace sin líneas y sin dinero. `tables:update` pasa a ser el permiso de
 * las tres. El MCP ya usaba ese mismo nombre para `set_table_status`, así que HTTP y MCP
 * por fin dicen lo mismo.
 *
 * 🔴 Quien gana: HOST (que es de quien hablaba el caso #17). Quien pierde: KITCHEN, que
 * hoy mueve cuentas porque tiene `orders:update` — y mover la cuenta de una mesa no es
 * trabajo de cocina. Se declara, no se esconde.
 *
 * ASIGNAR MESERO se queda a propósito en `orders:update` (ver el bloque final).
 *
 * El espejo offline va en el MISMO cambio: el reducer de intents mapea cada tipo al
 * permiso de su ruta online, y desalinearlos convierte apagar el WiFi en la puerta de
 * atrás.
 */

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import tpvRouter from '@/routes/tpv.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { hasPermission } from '@/lib/permissions'
import { requiredPermissionForIntent } from '@/services/mobile/sync.mobile.service'

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

/** [router, método, ruta] de las acciones de SALA. */
const SALA: Array<[string, any, string, string]> = [
  ['mobile', mobileRouter, 'post', '/venues/:venueId/tables/:tableId/open'],
  ['mobile', mobileRouter, 'post', '/venues/:venueId/tables/:tableId/clear'],
  ['mobile', mobileRouter, 'post', '/venues/:venueId/orders/:orderId/move'],
  ['tpv', tpvRouter, 'post', '/venues/:venueId/tables/:tableId/open'],
  ['tpv', tpvRouter, 'post', '/venues/:venueId/tables/:tableId/clear'],
  ['tpv', tpvRouter, 'post', '/venues/:venueId/tables/assign'],
]

describe('Abrir, liberar y mover mesa exigen el permiso de MESA, no el de ORDEN', () => {
  it.each(SALA)('[%s] %s %s exige tables:update', (_ns, router, method, path) => {
    const route = inspectRoute(router, method, path)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.permission).toBe('tables:update')
  })

  it('ninguna de las seis se queda sin candado (dos de /tpv no tenían NINGUNO)', () => {
    for (const [, router, method, path] of SALA) {
      expect(inspectRoute(router, method, path)!.permission).toBeDefined()
    }
  })
})

describe('🔴 tables:update deja de ser un permiso muerto', () => {
  it('HOST —a quien se le prometió gestión de sala— por fin abre, libera y mueve', () => {
    expect(hasPermission(StaffRole.HOST, null, 'tables:update')).toBe(true)
    for (const [, router, method, path] of SALA) {
      expect(hasPermission(StaffRole.HOST, null, inspectRoute(router, method, path)!.permission!)).toBe(true)
    }
  })

  it('HOST sigue SIN los permisos de comanda que el atajo fácil le habría regalado', () => {
    // El "arreglo" tentador era darle orders:create/orders:update, que abre de golpe
    // las rutas de descuento, cortesía, cargo por servicio, separar y fusionar.
    expect(hasPermission(StaffRole.HOST, null, 'orders:create')).toBe(false)
    expect(hasPermission(StaffRole.HOST, null, 'orders:update')).toBe(false)
    expect(hasPermission(StaffRole.HOST, null, 'orders:cancel')).toBe(false)
    expect(hasPermission(StaffRole.HOST, null, 'orders:comp')).toBe(false)
    expect(hasPermission(StaffRole.HOST, null, 'discounts:apply')).toBe(false)
  })

  it.each([StaffRole.WAITER, StaffRole.CASHIER, StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])(
    '%s no pierde ninguna de las tres acciones de sala',
    role => {
      for (const [, router, method, path] of SALA) {
        expect(hasPermission(role, null, inspectRoute(router, method, path)!.permission!)).toBe(true)
      }
    },
  )

  it('🔴 KITCHEN deja de mover cuentas — se declara, no se esconde', () => {
    // Hoy puede porque `move` pedía orders:update. Mover la cuenta de una mesa no es
    // trabajo de cocina; KITCHEN conserva su KDS y sus comandas.
    expect(hasPermission(StaffRole.KITCHEN, null, 'orders:update')).toBe(true)
    expect(hasPermission(StaffRole.KITCHEN, null, 'tables:update')).toBe(false)
  })

  it('VIEWER sigue sin tocar el piso', () => {
    expect(hasPermission(StaffRole.VIEWER, null, 'tables:update')).toBe(false)
  })
})

describe('El espejo offline va en el MISMO cambio: el replay no es puerta trasera', () => {
  it.each([
    ['OPEN_TABLE', 'tables:update'],
    ['CLEAR_TABLE', 'tables:update'],
    ['MOVE_ORDER', 'tables:update'],
  ])('intent %s → %s (mismo permiso que su ruta online)', (type, permission) => {
    expect(requiredPermissionForIntent(type)).toBe(permission)
  })

  it('ADD_ITEMS se queda en orders:create: meter líneas a una cuenta SÍ es comanda', () => {
    expect(requiredPermissionForIntent('ADD_ITEMS')).toBe('orders:create')
  })

  it('el offline no le regala a KITCHEN lo que el online le quitó', () => {
    for (const type of ['OPEN_TABLE', 'CLEAR_TABLE', 'MOVE_ORDER']) {
      expect(hasPermission(StaffRole.KITCHEN, null, requiredPermissionForIntent(type)!)).toBe(false)
    }
  })
})

describe('ASIGNAR MESERO se queda en orders:update — a propósito, y aquí está el porqué', () => {
  it('POST /mobile/venues/:venueId/orders/:orderId/assign sigue exigiendo orders:update', () => {
    const route = inspectRoute(mobileRouter, 'post', '/venues/:venueId/orders/:orderId/assign')
    expect(route!.permission).toBe('orders:update')
  })

  it('intent ASSIGN_ORDER sigue espejando esa misma ruta', () => {
    expect(requiredPermissionForIntent('ASSIGN_ORDER')).toBe('orders:update')
  })

  it('moverlo dejaría al HOST con media función: el selector de mesero pide orders:update', () => {
    // `GET /tpv/venues/:venueId/staff/assignable` (tpv.routes.ts) está gateado con
    // orders:update. Darle a HOST el permiso de asignar sin abrirle también ese
    // selector lo dejaría con un botón que no puede llenar — media función es peor
    // que ninguna. Queda como decisión pendiente, no como olvido.
    const picker = inspectRoute(tpvRouter, 'get', '/venues/:venueId/staff/assignable')
    expect(picker!.permission).toBe('orders:update')
    expect(hasPermission(StaffRole.HOST, null, picker!.permission!)).toBe(false)
  })
})
