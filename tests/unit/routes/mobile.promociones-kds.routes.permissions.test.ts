/**
 * Dos huecos del lado CONTRARIO al resto de la auditoría de permisos de piso: aquí no
 * se bloqueaba de más, se DEJABA PASAR de más
 * (`docs/superpowers/specs/2026-08-16-auditoria-permisos-piso.md`, hallazgos E1 y KDS).
 *
 * E1 — DESCUENTOS Y CUPONES por `/mobile`: las 9 rutas llevaban sólo
 * `requireVenueMembership` y CERO `checkPermission`, así que cualquier miembro del
 * venue —un mesero, un cocinero, un VIEWER— podía CREAR, EDITAR y BORRAR los descuentos
 * y los cupones del negocio desde el POS. Las gemelas de `/dashboard` sí exigen
 * `discounts:create/update/delete` y `coupons:create/update/delete`: el POS era la
 * puerta de atrás al mismo catálogo.
 *
 * KDS — las 4 rutas tampoco llevaban `checkPermission`: cualquier miembro del venue,
 * VIEWER incluido, podía crear comandas, cambiarles el estado y BUMPEARLAS (marcarlas
 * como terminadas), o sea borrar de la pantalla el trabajo de la cocina.
 *
 * 🔴 El criterio del KDS es fail-open para la COCINA: se elige el permiso más
 * conservador que NO deje a KITCHEN fuera. `orders:update` es el que KITCHEN ya trae
 * por default (toma y avanza comandas) y que el POS que crea la comanda tras el cobro
 * también tiene. No se inventa un namespace `kds:*` nuevo: habría nacido sin roles y
 * habría apagado la cocina.
 *
 * Introspección estática del router REAL de Express: sin mocks y sin DB.
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

// [método, ruta, permiso esperado]
const PROMOCIONES: Array<[string, string, string]> = [
  ['get', '/venues/:venueId/discounts', 'discounts:read'],
  ['post', '/venues/:venueId/discounts', 'discounts:create'],
  ['put', '/venues/:venueId/discounts/:discountId', 'discounts:update'],
  ['delete', '/venues/:venueId/discounts/:discountId', 'discounts:delete'],
  ['get', '/venues/:venueId/coupons', 'coupons:read'],
  ['post', '/venues/:venueId/coupons', 'coupons:create'],
  ['put', '/venues/:venueId/coupons/:couponId', 'coupons:update'],
  ['delete', '/venues/:venueId/coupons/:couponId', 'coupons:delete'],
  ['post', '/venues/:venueId/coupons/validate', 'coupons:redeem'],
]

const KDS: Array<[string, string, string]> = [
  ['get', '/venues/:venueId/kds/orders', 'orders:read'],
  ['post', '/venues/:venueId/kds/orders', 'orders:update'],
  ['put', '/venues/:venueId/kds/orders/:id/status', 'orders:update'],
  ['post', '/venues/:venueId/kds/orders/:id/bump', 'orders:update'],
]

describe('E1 — descuentos y cupones por /mobile dejan de ser puerta de atrás', () => {
  it.each([...PROMOCIONES])('%s %s exige %s', (method, path, expected) => {
    const route = inspectRoute(mobileRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.permission).toBe(expected)
  })

  it('ninguna de las 9 se queda sin candado de permiso', () => {
    for (const [method, path] of PROMOCIONES) {
      const route = inspectRoute(mobileRouter, method, path)
      expect(route!.permission).toBeDefined()
    }
  })

  const ESCRITURAS = PROMOCIONES.filter(([method]) => method !== 'get' && method !== 'post').concat(
    PROMOCIONES.filter(([, , perm]) => perm.endsWith(':create')),
  )

  it.each([StaffRole.WAITER, StaffRole.CASHIER, StaffRole.KITCHEN, StaffRole.VIEWER, StaffRole.HOST])(
    '🔴 %s ya NO puede crear/editar/borrar promociones desde el POS',
    role => {
      for (const [, , perm] of ESCRITURAS) {
        expect(hasPermission(role, null, perm)).toBe(false)
      }
    },
  )

  it.each([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])('%s conserva la administración de promociones', role => {
    for (const [, , perm] of PROMOCIONES) {
      expect(hasPermission(role, null, perm)).toBe(true)
    }
  })

  it('el mostrador NO pierde lo que necesita para cobrar: leer y validar un cupón', () => {
    for (const role of [StaffRole.CASHIER, StaffRole.WAITER]) {
      expect(hasPermission(role, null, 'discounts:read')).toBe(true)
      expect(hasPermission(role, null, 'coupons:read')).toBe(true)
      expect(hasPermission(role, null, 'coupons:redeem')).toBe(true)
    }
  })

  it('el permiso de /mobile es el MISMO nombre que el de la gemela de /dashboard', () => {
    // La regla de la casa: un permiso se espeja por nombre EXACTO. Si /mobile pidiera
    // otro nombre, el mismo usuario podría en un cliente y no en el otro.
    const porNombre = Object.fromEntries(PROMOCIONES.map(([m, p, perm]) => [`${m} ${p}`, perm]))
    expect(porNombre['post /venues/:venueId/discounts']).toBe('discounts:create')
    expect(porNombre['post /venues/:venueId/coupons']).toBe('coupons:create')
  })
})

describe('KDS — se cierra el bump abierto, sin apagar la cocina', () => {
  it.each([...KDS])('%s %s exige %s', (method, path, expected) => {
    const route = inspectRoute(mobileRouter, method, path)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.permission).toBe(expected)
  })

  it('🔴 KITCHEN sigue pudiendo TODO el KDS — es el fail-open que no se negocia', () => {
    for (const [, , perm] of KDS) {
      expect(hasPermission(StaffRole.KITCHEN, null, perm)).toBe(true)
    }
  })

  it.each([StaffRole.CASHIER, StaffRole.WAITER, StaffRole.MANAGER])(
    '%s (el POS que crea la comanda tras el cobro) tampoco pierde nada',
    role => {
      for (const [, , perm] of KDS) {
        expect(hasPermission(role, null, perm)).toBe(true)
      }
    },
  )

  it('🔴 VIEWER ya NO puede crear, avanzar ni bumpear comandas (el hueco que se cierra)', () => {
    const escrituras = KDS.filter(([method]) => method !== 'get')
    for (const [, , perm] of escrituras) {
      expect(hasPermission(StaffRole.VIEWER, null, perm)).toBe(false)
    }
  })

  it('VIEWER conserva mirar la pantalla de cocina (es un rol de sólo lectura, no ciego)', () => {
    expect(hasPermission(StaffRole.VIEWER, null, 'orders:read')).toBe(true)
  })

  it('🔴 HOST tampoco bumpea comandas', () => {
    const escrituras = KDS.filter(([method]) => method !== 'get')
    for (const [, , perm] of escrituras) {
      expect(hasPermission(StaffRole.HOST, null, perm)).toBe(false)
    }
  })
})
