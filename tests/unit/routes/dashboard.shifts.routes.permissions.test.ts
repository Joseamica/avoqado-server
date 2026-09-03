/**
 * 🔴 EL BACK-OFFICE DE TURNOS: EDITAR SÍ, BORRAR NO — y el comentario que mentía.
 *
 * `dashboard.routes.ts` montaba la edición de un turno con `checkPermission('shifts:update'), //
 * SUPERADMIN only`, y NO era cierto: MANAGER lo tiene explícito y ADMIN/OWNER por el comodín
 * `shifts:*`. Lo único que parecía superadmin-only era el botón del dashboard, que se esconde con
 * `user?.role === StaffRole.SUPERADMIN` — un candado de CLIENTE. Por la pantalla no lo veía nadie;
 * por la API lo hacía cualquier gerente con `curl`.
 *
 * Es la familia `modelo-de-seguridad-escrito-solo-en-el-comentario`: quien leyera el router asumía
 * una protección que no existía, y `updateShift` es justo la ruta que reescribe el descuadre que
 * el cierre firmó contra la gaveta.
 *
 * DECISIÓN DEL FOUNDER (3-sep-2026): **editar sí, borrar no.**
 *  - `shifts:update` → gerente para arriba. Corregir un número de un corte es trabajo de gerencia.
 *  - `shifts:delete` → ADMIN/OWNER. El borrado es DURO: la fila se va y las órdenes, pagos,
 *    comisiones y la sesión de gaveta quedan sueltas (`onDelete: SetNull`), o sea que el dinero
 *    sobrevive sin nada que lo firme.
 *
 * Introspección estática del router REAL de Express: sin mocks y sin DB.
 */

import fs from 'fs'
import path from 'path'
import { StaffRole } from '@prisma/client'
import dashboardRouter from '@/routes/dashboard.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { DEFAULT_PERMISSIONS, hasPermission } from '@/lib/permissions'

interface RouteInspection {
  hasAuthenticateToken: boolean
  permission?: string
}

function inspectRoute(router: any, method: string, routePath: string): RouteInspection | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== routePath) continue
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

const SHIFT_PATH = '/venues/:venueId/shifts/:shiftId'

/** Quien opera el piso: nunca toca el back-office de turnos. */
const PISO = [StaffRole.CASHIER, StaffRole.WAITER, StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER]

describe('PUT /dashboard/venues/:venueId/shifts/:shiftId — corregir un turno', () => {
  it('sigue autenticada y gateada por shifts:update', () => {
    const route = inspectRoute(dashboardRouter, 'put', SHIFT_PATH)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.permission).toBe('shifts:update')
  })

  it.each([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])('%s puede corregir un turno (gerente para arriba)', role => {
    expect(hasPermission(role, null, 'shifts:update')).toBe(true)
  })

  it.each(PISO)('🔴 %s NO puede corregir un turno', role => {
    expect(hasPermission(role, null, 'shifts:update')).toBe(false)
  })
})

describe('DELETE /dashboard/venues/:venueId/shifts/:shiftId — hacer desaparecer el corte', () => {
  it('sigue autenticada y gateada por shifts:delete', () => {
    const route = inspectRoute(dashboardRouter, 'delete', SHIFT_PATH)
    expect(route).toBeDefined()
    expect(route!.hasAuthenticateToken).toBe(true)
    expect(route!.permission).toBe('shifts:delete')
  })

  it('🔴 MANAGER puede EDITAR pero NO BORRAR — es toda la decisión, en una línea', () => {
    expect(hasPermission(StaffRole.MANAGER, null, 'shifts:update')).toBe(true)
    expect(hasPermission(StaffRole.MANAGER, null, 'shifts:delete')).toBe(false)
    expect(DEFAULT_PERMISSIONS[StaffRole.MANAGER]).not.toContain('shifts:delete')
  })

  it.each([StaffRole.ADMIN, StaffRole.OWNER])('%s sí puede borrar (por el comodín shifts:*)', role => {
    expect(hasPermission(role, null, 'shifts:delete')).toBe(true)
  })

  it.each(PISO)('%s NO puede borrar', role => {
    expect(hasPermission(role, null, 'shifts:delete')).toBe(false)
  })

  it('🔴 un override guardado GANA sobre el default — por eso hizo falta una migración de datos', () => {
    // P1.1 de la auditoría de Codex (3-sep-2026), y es el hallazgo que más importaba: quitar el
    // permiso de `DEFAULT_PERMISSIONS` NO se lo quita a nadie que ya lo tenga guardado, porque
    // `VenueRolePermission.permissions` es ADITIVO y el editor guarda la lista ya EXPANDIDA. O sea
    // que la decisión del founder sólo se cumplía en los venues que nunca personalizaron el rol.
    // La otra mitad del arreglo es la migración `20260903160000_manager_no_borra_turnos`.
    //
    // Esta aserción es LAS DOS COSAS a la vez: documenta el hueco, y fija que la puerta no quedó
    // tapiada — un venue que de verdad lo quiera se lo concede explícito desde el editor.
    expect(hasPermission(StaffRole.MANAGER, ['shifts:delete'], 'shifts:delete')).toBe(true)
  })
})

describe('Ningún router puede AFIRMAR «SUPERADMIN only» sobre un permiso que no lo es', () => {
  // El guard de la FAMILIA, no del caso: si mañana alguien vuelve a escribir esa promesa junto a
  // un permiso que un rol normal satisface, esta prueba lo caza. Un comentario no es un guardrail
  // — pero un comentario FALSO es peor que ninguno, porque el siguiente que lo lea confiará.
  const ROLES_NORMALES = Object.values(StaffRole).filter(r => r !== StaffRole.SUPERADMIN)

  function archivosDeRutas(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return archivosDeRutas(full)
      return e.name.endsWith('.ts') ? [full] : []
    })
  }

  /**
   * 🔴 El comentario cuenta esté DONDE esté, no sólo al final de la línea del `checkPermission`.
   * La primera versión de esta prueba sólo miraba el comentario de arrastre — y el arreglo de hoy
   * dejó los comentarios buenos en su PROPIA línea, encima de la ruta. O sea que la forma que este
   * repo va a escribir de ahora en adelante era justo la que el guard no veía: habría pasado en
   * verde sobre la siguiente mentira. Se mira la línea y las 3 anteriores no vacías.
   */
  function permisoAfirmadoComoSuperadmin(lineas: string[], i: number): string | null {
    const enLaLinea = lineas[i].match(/checkPermission\(\s*'([^']+)'\s*\)/)
    if (!enLaLinea) return null
    const afirma = (t: string) => /\/\/|\*/.test(t) && /SUPERADMIN\s+only/i.test(t)
    if (afirma(lineas[i])) return enLaLinea[1]
    let vistas = 0
    for (let j = i - 1; j >= 0 && vistas < 3; j--) {
      const t = lineas[j].trim()
      if (!t) continue
      vistas++
      if (afirma(t)) return enLaLinea[1]
      // Una línea que no es comentario corta la búsqueda: el comentario ya no habla de esta ruta.
      if (!/^(\/\/|\*|\/\*)/.test(t)) break
    }
    return null
  }

  it('cada `checkPermission(...)` anunciado como SUPERADMIN only dice la verdad', () => {
    const raiz = path.join(__dirname, '../../../src/routes')
    const mentiras: string[] = []
    let revisados = 0

    for (const archivo of archivosDeRutas(raiz)) {
      const lineas = fs.readFileSync(archivo, 'utf-8').split('\n')
      lineas.forEach((_, i) => {
        const permiso = permisoAfirmadoComoSuperadmin(lineas, i)
        if (!permiso) return
        revisados++
        if (ROLES_NORMALES.some(role => hasPermission(role, null, permiso))) {
          mentiras.push(`${path.relative(raiz, archivo)}:${i + 1} → '${permiso}' NO es SUPERADMIN only`)
        }
      })
    }

    expect(mentiras).toEqual([])
    // 🔴 Y que el guard no se vuelva VACUO en silencio (P2.4 de Codex): si un día nadie escribe ya
    // esa afirmación en ningún router, `mentiras` queda vacío por no encontrar NADA que revisar y
    // esta prueba seguiría verde sin vigilar una sola línea. Hoy el corpus tiene al menos un caso
    // legítimo (`system:manage` en `dashboard/superadmin.routes.ts`). Si esto falla, no "arregles"
    // el número: comprueba si de verdad ya no queda ninguna afirmación, y entonces retira el guard.
    expect(revisados).toBeGreaterThan(0)
  })

  it('🔴 el guard ve el comentario en su PROPIA línea, no sólo el de arrastre', () => {
    // Sin esto, la prueba de arriba puede estar viva y no vigilar nada: basta con que alguien
    // escriba el comentario encima, que es como quedó escrito el arreglo de hoy.
    const conArrastre = ["  checkPermission('shifts:update'), // SUPERADMIN only"]
    const enSuLinea = ['  // SUPERADMIN only', "  checkPermission('shifts:update'),"]
    const conEstorbo = ['  // SUPERADMIN only', '  authenticateTokenMiddleware,', "  checkPermission('shifts:update'),"]

    expect(permisoAfirmadoComoSuperadmin(conArrastre, 0)).toBe('shifts:update')
    expect(permisoAfirmadoComoSuperadmin(enSuLinea, 1)).toBe('shifts:update')
    // Un comentario separado por código NO habla de esta ruta: no se le atribuye.
    expect(permisoAfirmadoComoSuperadmin(conEstorbo, 2)).toBeNull()
  })
})
