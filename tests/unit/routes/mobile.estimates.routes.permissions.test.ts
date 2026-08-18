/**
 * Presupuestos del anfitrión — caso #16 de la auditoría de permisos de piso.
 *
 * La recepcionista (HOST) cotiza un servicio completo con el cliente enfrente y al
 * guardar le piden `orders:create`: el permiso de TOMAR COMANDAS. Tampoco podía enviar
 * ni marcar aceptado el presupuesto. Un presupuesto no mueve dinero ni abre comanda —
 * es una promesa de precio.
 *
 * 🔴 El atajo fácil (darle `orders:create` al HOST) le abriría de golpe las rutas de
 * comanda: agregar líneas, cortesías, cargos por servicio, separar. Por eso nace un
 * permiso propio y acotado, `estimates:create`, exactamente como propuso el informe.
 *
 * CONVERTIR a orden se queda en `orders:create` a propósito: ahí sí nace una comanda con
 * líneas. Es la frontera entre cotizar y vender.
 *
 * Leer presupuestos se queda en `orders:read`, que satisfacen los 9 roles: no se inventa
 * un `estimates:read` que habría que espejar en tres clientes para no cambiar a nadie.
 */

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { DEFAULT_PERMISSIONS, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, hasPermission, resolvePermissions } from '@/lib/permissions'

function permissionOf(router: any, method: string, path: string): string | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    const permissionLayer = routeLayers.find(rl => typeof (rl.handle as any)?.requiredPermission === 'string')
    return (permissionLayer?.handle as any)?.requiredPermission
  }
  return undefined
}

function hasAuth(router: any, method: string, path: string): boolean {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    return routeLayers.map(rl => rl.handle).includes(authenticateTokenMiddleware)
  }
  return false
}

const COTIZAR: Array<[string, string]> = [
  ['post', '/venues/:venueId/estimates'],
  ['put', '/venues/:venueId/estimates/:estimateId/status'],
]
const LEER: Array<[string, string]> = [
  ['get', '/venues/:venueId/estimates'],
  ['get', '/venues/:venueId/estimates/:estimateId'],
]

describe('Cotizar tiene permiso propio, no el de tomar comandas', () => {
  it.each(COTIZAR)('%s %s exige estimates:create', (method, path) => {
    expect(hasAuth(mobileRouter, method, path)).toBe(true)
    expect(permissionOf(mobileRouter, method, path)).toBe('estimates:create')
  })

  it.each(LEER)('%s %s se queda en orders:read (lo tienen los 9 roles)', (method, path) => {
    expect(permissionOf(mobileRouter, method, path)).toBe('orders:read')
  })

  it('🔴 CONVERTIR a orden se queda en orders:create: ahí sí nace una comanda', () => {
    expect(permissionOf(mobileRouter, 'post', '/venues/:venueId/estimates/:estimateId/convert')).toBe('orders:create')
  })
})

describe('HOST cotiza; sigue sin poder tomar comandas', () => {
  it('HOST puede crear y mover de estado un presupuesto', () => {
    for (const [method, path] of COTIZAR) {
      expect(hasPermission(StaffRole.HOST, null, permissionOf(mobileRouter, method, path)!)).toBe(true)
    }
  })

  it('HOST lo trae explícito en sus defaults, no heredado de un wildcard', () => {
    expect(DEFAULT_PERMISSIONS[StaffRole.HOST]).toContain('estimates:create')
  })

  it('🔴 HOST NO gana tomar comandas ni convertir el presupuesto en venta', () => {
    expect(hasPermission(StaffRole.HOST, null, 'orders:create')).toBe(false)
    expect(hasPermission(StaffRole.HOST, null, 'orders:update')).toBe(false)
    expect(hasPermission(StaffRole.HOST, null, 'orders:comp')).toBe(false)
    expect(hasPermission(StaffRole.HOST, null, permissionOf(mobileRouter, 'post', '/venues/:venueId/estimates/:estimateId/convert')!)).toBe(
      false,
    )
  })

  it('HOST sí puede LEER los presupuestos que cotizó', () => {
    for (const [method, path] of LEER) {
      expect(hasPermission(StaffRole.HOST, null, permissionOf(mobileRouter, method, path)!)).toBe(true)
    }
  })
})

describe('Nadie que ya cotizaba pierde nada', () => {
  it.each([StaffRole.CASHIER, StaffRole.WAITER, StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])(
    '%s conserva crear y mover de estado un presupuesto',
    role => {
      for (const [method, path] of COTIZAR) {
        expect(hasPermission(role, null, permissionOf(mobileRouter, method, path)!)).toBe(true)
      }
    },
  )

  it('orders:create implica estimates:create (el puente)', () => {
    expect(Array.from(resolvePermissions(['orders:create']))).toContain('estimates:create')
  })

  it('🔴 el puente NO va al revés: cotizar no regala tomar comandas', () => {
    const desdeCotizar = Array.from(resolvePermissions(['estimates:create']))
    expect(desdeCotizar).not.toContain('orders:create')
    expect(desdeCotizar).not.toContain('orders:update')
  })

  it('cotizar arrastra lo que la pantalla necesita: menú, cliente y lectura de la lista', () => {
    const desdeCotizar = Array.from(resolvePermissions(['estimates:create']))
    expect(desdeCotizar).toEqual(expect.arrayContaining(['menu:read', 'customers:read', 'orders:read']))
  })

  it('KITCHEN y VIEWER siguen sin cotizar', () => {
    expect(hasPermission(StaffRole.KITCHEN, null, 'estimates:create')).toBe(false)
    expect(hasPermission(StaffRole.VIEWER, null, 'estimates:create')).toBe(false)
  })

  it('el permiso es asignable uno por uno desde el editor de roles', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['estimates']).toContain('estimates:create')
  })
})
