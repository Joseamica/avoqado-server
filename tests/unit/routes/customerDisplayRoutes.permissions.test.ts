import { hasPermission, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, PERMISSION_DEPENDENCIES } from '@/lib/permissions'
import { StaffRole } from '@prisma/client'
import customerDisplayRoutes, { customerDisplayDevicesRoutes } from '@/routes/dashboard/customerDisplay.routes'

const puede = (rol: StaffRole, permiso: string) => hasPermission(rol, null, permiso)

/**
 * El CABLEADO del permiso en las tres estructuras. Que un cajero reciba un 403 de verdad lo prueba la capa HTTP
 * (`tests/api-tests/dashboard/customer-display.api.test.ts`); aquí se prueba que el permiso exista donde el editor de
 * roles y el resolvedor lo buscan.
 */
describe('permiso customer-display — cableado en las TRES estructuras', () => {
  it('está en el catálogo por recurso (si no, no se puede asignar individualmente)', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['customer-display']).toEqual(['customer-display:read', 'customer-display:update'])
  })

  it('update implica read (quien edita la pantalla puede ver lo que edita)', () => {
    expect(PERMISSION_DEPENDENCIES['customer-display:update']).toEqual(['customer-display:update', 'customer-display:read'])
    expect(PERMISSION_DEPENDENCIES['customer-display:read']).toEqual(['customer-display:read'])
  })

  // Se prueba la CAPACIDAD por el resolvedor real, no la representación (comodín o literal).
  it('🔴 MANAGER, ADMIN y OWNER leen y editan — decisión del founder (spec §5.8): la pantalla es trabajo del local', () => {
    for (const rol of [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]) {
      expect(puede(rol, 'customer-display:read')).toBe(true)
      expect(puede(rol, 'customer-display:update')).toBe(true)
    }
  })

  it('🔴 ningún rol de piso puede, ni leer ni escribir', () => {
    for (const rol of [StaffRole.CASHIER, StaffRole.WAITER, StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER]) {
      expect(puede(rol, 'customer-display:read')).toBe(false)
      expect(puede(rol, 'customer-display:update')).toBe(false)
    }
  })

  // Los PASOS del cobro siguen en `tpv-settings:*` con la matriz de hoy (spec §13): este permiso no los abre.
  it('el permiso nuevo no concede `tpv-settings:*` a nadie que no lo tuviera', () => {
    expect(PERMISSION_DEPENDENCIES['customer-display:update'].some(p => p.startsWith('tpv-settings'))).toBe(false)
  })
})

/**
 * 🔴 El permiso de CADA ruta, leído del router REAL de Express (introspección estática, sin DB ni mocks de red) — molde:
 * `dashboard.shifts.routes.permissions.test.ts`. La prueba HTTP ejercita varias, pero no fija `preview`, `copy` ni `reset`:
 * cambiar `copy` o `reset` a `customer-display:read` pasaba todo. Revisión de la Task 11, hallazgo menor 4.
 */
function permisosDeLaRuta(router: any, method: string, routePath: string): string[] | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== routePath) continue
    const capas: any[] = layer.route.stack ?? []
    if (!capas.some(c => c.method === method)) continue
    // TODAS las capas con permiso, no la primera: una segunda de lectura colada en la cadena también se ve aquí.
    return capas.map(c => (c.handle as any)?.requiredPermission).filter((p): p is string => typeof p === 'string')
  }
  return undefined
}

describe('el permiso de cada una de las 7 rutas, en el router real', () => {
  it.each([
    ['get', '/', 'customer-display:read'],
    ['post', '/preview', 'customer-display:read'],
    ['put', '/', 'customer-display:update'],
    ['post', '/copy', 'customer-display:update'],
    ['post', '/reset', 'customer-display:update'],
    ['post', '/assets', 'customer-display:update'],
  ])('%s %s (una terminal) exige exactamente %s', (method, ruta, permiso) => {
    expect(permisosDeLaRuta(customerDisplayRoutes, method, ruta)).toEqual([permiso])
  })

  it('get /devices (la lista del negocio) exige exactamente customer-display:read', () => {
    expect(permisosDeLaRuta(customerDisplayDevicesRoutes, 'get', '/devices')).toEqual(['customer-display:read'])
  })

  it('no hay una octava ruta sin revisar: el router de la terminal tiene exactamente esas 6', () => {
    const rutas = (customerDisplayRoutes as any).stack
      .filter((l: any) => l.route)
      .flatMap((l: any) => Object.keys(l.route.methods).map(m => `${m} ${l.route.path}`))
      .sort()
    expect(rutas).toEqual(['get /', 'post /assets', 'post /copy', 'post /preview', 'post /reset', 'put /'])
  })
})
