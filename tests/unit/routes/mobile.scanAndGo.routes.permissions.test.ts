/**
 * `tpv-products:write` — el tercer permiso que estaba escrito y sin cablear
 * (auditoría de permisos de piso, §3: "la prueba de que ya alguien lo vio").
 *
 * El catálogo lo declara literal como _"Can create products on-the-fly (Scan & Go)"_ y se
 * lo daba a MANAGER, ADMIN y OWNER... pero NO RESOLVÍA A NADA: la única ruta que crea un
 * producto desde el POS (`POST /mobile/venues/:venueId/products`, la que abre el diálogo
 * "Crear nuevo" del escáner) exigía `menu:create`, y `tpv-products:write` no era puente a
 * ese nombre. Un rol personalizado al que se le encendiera el toggle de Scan & Go seguía
 * recibiendo 403 con la captura ya hecha y la fila esperando.
 *
 * Se cablea al revés de como se hizo con los turnos, y a propósito: la ruta pasa al
 * permiso ACOTADO (`tpv-products:write` abre exactamente una puerta: dar de alta un
 * artículo desde el POS) y `menu:create` lo implica, para que nadie que ya administraba
 * el menú pierda nada.
 *
 * 🔴 Lo que este cambio NO hace, y es deliberado: NO le da al CASHIER la capacidad de
 * crear artículos. El informe fue explícito ("🔴 No. Fix de cliente"), y Square también
 * separa crear artículos del rol de caja. El bug del escáner que ofrece un botón que
 * luego niega se arregla en la app, no aflojando el server.
 *
 * El alta de catálogo desde el back-office (`POST /dashboard/venues/:venueId/products`)
 * se queda en `menu:create`: administrar el menú y dar de alta al vuelo son dos gestos
 * distintos.
 */

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import dashboardRouter from '@/routes/dashboard.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { hasPermission, resolvePermissions } from '@/lib/permissions'

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

const POS_CREATE = '/venues/:venueId/products'

describe('POST /mobile/venues/:venueId/products — el alta al vuelo del escáner', () => {
  it('sigue autenticada', () => {
    expect(hasAuth(mobileRouter, 'post', POS_CREATE)).toBe(true)
  })

  it('exige tpv-products:write, el permiso escrito para esto', () => {
    expect(permissionOf(mobileRouter, 'post', POS_CREATE)).toBe('tpv-products:write')
  })

  it.each([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])('%s no pierde el alta al vuelo', role => {
    expect(hasPermission(role, null, permissionOf(mobileRouter, 'post', POS_CREATE)!)).toBe(true)
  })

  it('🔴 CASHIER y WAITER siguen SIN poder crear artículos — el informe dijo que no', () => {
    for (const role of [StaffRole.CASHIER, StaffRole.WAITER]) {
      expect(hasPermission(role, null, 'tpv-products:write')).toBe(false)
      expect(hasPermission(role, null, 'menu:create')).toBe(false)
    }
  })

  it('CASHIER conserva BUSCAR por código de barras (tpv-products:read), que es su trabajo', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'tpv-products:read')).toBe(true)
  })
})

describe('Puente: quien administra el menú no pierde el alta desde el POS', () => {
  it('menu:create implica tpv-products:write', () => {
    expect(Array.from(resolvePermissions(['menu:create']))).toContain('tpv-products:write')
  })

  it('un rol personalizado con la lista EXPANDIDA de menu:create sigue dando de alta', () => {
    // El editor de roles guarda la lista expandida sin wildcard: es el caso que rompe
    // un rename a ciegas.
    expect(Array.from(resolvePermissions(['menu:read', 'menu:create']))).toContain('tpv-products:write')
  })

  it('🔴 el puente NO va al revés: dar de alta al vuelo no regala administrar el menú', () => {
    const desdePos = Array.from(resolvePermissions(['tpv-products:write']))
    expect(desdePos).not.toContain('menu:create')
    expect(desdePos).not.toContain('menu:update')
    expect(desdePos).not.toContain('menu:delete')
  })
})

describe('El back-office de catálogo se queda donde estaba', () => {
  it('POST /dashboard/venues/:venueId/products sigue exigiendo menu:create', () => {
    expect(permissionOf(dashboardRouter, 'post', '/venues/:venueId/products')).toBe('menu:create')
  })

  it('las categorías del POS tampoco se aflojan', () => {
    expect(permissionOf(mobileRouter, 'post', '/venues/:venueId/categories')).toBe('menu:create')
  })
})
