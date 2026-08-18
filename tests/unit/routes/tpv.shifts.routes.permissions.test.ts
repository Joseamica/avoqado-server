/**
 * Turno de la TPV — abrir y cerrar MI turno es OPERAR, no administrar turnos ajenos.
 * Auditoría de permisos de piso, casos #1 y #2
 * (`docs/superpowers/specs/2026-08-16-auditoria-permisos-piso.md`).
 *
 * 🔴 El peor caso de toda la auditoría, y es dinero parado: con la configuración de
 * fábrica un CASHIER (y un WAITER) NO podía abrir ni cerrar su turno en la terminal,
 * porque las dos rutas exigían `shifts:create` / `shifts:close` — los permisos de
 * back-office para crear y corregir turnos DE OTROS. Y con turnos activos el POS deja
 * "Cobrar", "Pago rápido", "Órdenes" y "Mesas" apagados: sin turno, la terminal no
 * cobra. No existe ninguna otra puerta para abrirlo —tampoco desde el dashboard— así
 * que un gerente tenía que ir FÍSICAMENTE a la terminal.
 *
 * La solución ya estaba escrita y sin cablear: `tpv-shifts:create` y `tpv-shifts:close`
 * vivían en el catálogo con CERO rutas y CERO roles. Aquí se enchufan.
 *
 * Alias BIDIRECCIONAL, no rename a ciegas (patrón de `.claude/rules/permissions-policy.md`):
 * hacia adelante para que MANAGER/ADMIN/OWNER —y los roles personalizados que guardaron
 * la lista EXPANDIDA sin wildcard— no pierdan nada; y hacia atrás porque los APK de TPV
 * en la calle gatean sus botones con los nombres viejos, y sin esa dirección el server
 * autorizaría y la app seguiría escondiendo el botón.
 *
 * Introspección estática del router REAL de Express: sin mocks y sin DB.
 */

import fs from 'fs'
import path from 'path'
import { StaffRole } from '@prisma/client'
import tpvRouter from '@/routes/tpv.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { DEFAULT_PERMISSIONS, INDIVIDUAL_PERMISSIONS_BY_RESOURCE, hasPermission, resolvePermissions } from '@/lib/permissions'

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

const OPEN_PATH = '/venues/:venueId/shifts/open'
const CLOSE_PATH = '/venues/:venueId/shifts/:shiftId/close'

/** Los dos roles que se quedaban parados delante de una terminal que no cobra. */
const PISO = [StaffRole.CASHIER, StaffRole.WAITER]
/** Los que ya podían y NO pueden perderlo. */
const JEFES = [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]

describe('POST /tpv/venues/:venueId/shifts/open — abrir MI turno', () => {
  it('sigue autenticada', () => {
    const route = inspectRoute(tpvRouter, 'post', OPEN_PATH)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
  })

  it('exige tpv-shifts:create, no el permiso de administrar turnos ajenos', () => {
    const route = inspectRoute(tpvRouter, 'post', OPEN_PATH)
    expect(route!.permission).toBe('tpv-shifts:create')
  })

  it.each(PISO)('%s puede abrir su turno (la regresión que se cierra)', role => {
    const route = inspectRoute(tpvRouter, 'post', OPEN_PATH)
    expect(hasPermission(role, null, route!.permission!)).toBe(true)
  })

  it.each(JEFES)('%s no pierde acceso (entraba por shifts:create)', role => {
    const route = inspectRoute(tpvRouter, 'post', OPEN_PATH)
    expect(hasPermission(role, null, route!.permission!)).toBe(true)
  })

  it('KITCHEN y VIEWER siguen fuera: no operan caja', () => {
    const route = inspectRoute(tpvRouter, 'post', OPEN_PATH)
    expect(hasPermission(StaffRole.KITCHEN, null, route!.permission!)).toBe(false)
    expect(hasPermission(StaffRole.VIEWER, null, route!.permission!)).toBe(false)
  })
})

describe('POST /tpv/venues/:venueId/shifts/:shiftId/close — cerrar MI turno (el corte)', () => {
  it('sigue autenticada', () => {
    const route = inspectRoute(tpvRouter, 'post', CLOSE_PATH)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
  })

  it('exige tpv-shifts:close', () => {
    const route = inspectRoute(tpvRouter, 'post', CLOSE_PATH)
    expect(route!.permission).toBe('tpv-shifts:close')
  })

  it.each(PISO)('%s puede hacer su corte y entregar caja', role => {
    const route = inspectRoute(tpvRouter, 'post', CLOSE_PATH)
    expect(hasPermission(role, null, route!.permission!)).toBe(true)
  })

  it.each(JEFES)('%s no pierde acceso (entraba por shifts:close)', role => {
    const route = inspectRoute(tpvRouter, 'post', CLOSE_PATH)
    expect(hasPermission(role, null, route!.permission!)).toBe(true)
  })

  it('KITCHEN y VIEWER siguen fuera', () => {
    const route = inspectRoute(tpvRouter, 'post', CLOSE_PATH)
    expect(hasPermission(StaffRole.KITCHEN, null, route!.permission!)).toBe(false)
    expect(hasPermission(StaffRole.VIEWER, null, route!.permission!)).toBe(false)
  })
})

describe('El piso opera SU turno; el back-office de turnos se queda arriba', () => {
  it.each(PISO)('🔴 %s NO puede editar ni borrar turnos', role => {
    expect(hasPermission(role, null, 'shifts:update')).toBe(false)
    expect(hasPermission(role, null, 'shifts:delete')).toBe(false)
  })

  it.each(PISO)('%s lo trae explícito en sus defaults, no heredado de un wildcard', role => {
    expect(DEFAULT_PERMISSIONS[role]).toContain('tpv-shifts:create')
    expect(DEFAULT_PERMISSIONS[role]).toContain('tpv-shifts:close')
  })

  it('los dos permisos siguen siendo asignables uno por uno desde el editor de roles', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE['tpv-shifts']).toEqual(expect.arrayContaining(['tpv-shifts:create', 'tpv-shifts:close']))
  })
})

describe('Puente para no romper a quien YA podía (roles personalizados incluidos)', () => {
  it('shifts:create implica tpv-shifts:create', () => {
    expect(Array.from(resolvePermissions(['shifts:create']))).toContain('tpv-shifts:create')
  })

  it('shifts:close implica tpv-shifts:close', () => {
    expect(Array.from(resolvePermissions(['shifts:close']))).toContain('tpv-shifts:close')
  })

  it('el alias es BIDIRECCIONAL para que el APK viejo de TPV siga viendo su botón', () => {
    // `ShiftViewModel.kt` gatea con los nombres viejos. Sin esta dirección el server
    // autoriza y la app esconde el botón: la "Forma C" de la auditoría.
    const desdePiso = Array.from(resolvePermissions(['tpv-shifts:create', 'tpv-shifts:close']))
    expect(desdePiso).toContain('shifts:create')
    expect(desdePiso).toContain('shifts:close')
  })

  it('🔴 pero el alias NO alcanza a editar ni borrar turnos ajenos', () => {
    const desdePiso = Array.from(resolvePermissions(['tpv-shifts:create', 'tpv-shifts:close']))
    expect(desdePiso).not.toContain('shifts:update')
    expect(desdePiso).not.toContain('shifts:delete')
  })

  it.each(PISO)('🔴 %s sigue sin poder editar ni borrar turnos pese al alias', role => {
    expect(hasPermission(role, null, 'shifts:update')).toBe(false)
    expect(hasPermission(role, null, 'shifts:delete')).toBe(false)
  })
})

describe('🔴 El alias sólo es seguro mientras shifts:create/close no abran ninguna puerta', () => {
  // Si alguien cablea un endpoint a `shifts:create` o `shifts:close`, el alias se lo
  // regala de rebote a CASHIER y WAITER. Este test obliga a re-decidir en ese momento
  // en vez de descubrirlo en producción.
  const ROUTES_DIR = path.join(__dirname, '../../../src/routes')

  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return walk(full)
      return e.isFile() && full.endsWith('.ts') ? [full] : []
    })
  }

  it.each(['shifts:create', 'shifts:close'])('ninguna ruta gatea con %s', perm => {
    const offenders = walk(ROUTES_DIR).filter(f => fs.readFileSync(f, 'utf8').includes(`checkPermission('${perm}')`))
    expect(offenders).toEqual([])
  })

  it('un rol personalizado con la lista EXPANDIDA de shifts:create sigue abriendo turno', () => {
    // El editor de roles guarda la lista expandida sin wildcard: es el caso que
    // rompía el rename a ciegas.
    const expandido = Array.from(resolvePermissions(['shifts:read', 'shifts:create', 'teams:read']))
    expect(expandido).toContain('tpv-shifts:create')
  })
})
