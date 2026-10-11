/**
 * Registro de comandos remotos de la TPV: el servidor y la pantalla piden el MISMO permiso.
 *
 * 🔴 Defecto (7-oct-2026, localhost): en «Comandos remotos» de una terminal, el historial se quedaba
 * girando para el OWNER. El log decía `denied access to 'tpv-commands:read'` y la ruta respondía 403 tres
 * veces seguidas (el cliente reintenta con espera creciente: 1 s, 2 s, 4 s).
 *
 * Causa: el dashboard (`TpvId.tsx`) muestra el panel y el historial a quien tiene `tpv:command`
 * (MANAGER, ADMIN y OWNER), pero las rutas de lectura pedían `tpv-commands:read`, un nombre que ningún rol
 * trae de fábrica: sólo SUPERADMIN, por el comodín `*:*`. Es la discrepancia `tpv-commands:*` contra
 * `tpv:command:*` que la auditoría del 22-may-2026 dejó anotada como TODO en `scripts/audit-permissions.ts`.
 *
 * Alcance deliberado: sólo se abre la LECTURA del registro de comandos de UN negocio (lista, historial y
 * estado de uno), que el controlador ya filtra por `venueId`. ENVIAR, cancelar, reintentar, masivos,
 * programados y geocercas siguen siendo de SUPERADMIN: ahí el permiso debe depender del tipo de comando
 * (`.claude/rules/permissions-policy.md`, «Endpoints with sub-actions») y eso es otro trabajo.
 *
 * Introspección estática del router REAL de Express: sin mocks y sin DB.
 */
import { StaffRole } from '@prisma/client'
import router from '@/routes/dashboard.routes'
import { hasPermission } from '@/lib/permissions'

type AuditedRoute = { method: string; path: string; permission: string }

function collectAuditedRoutes(r: any): AuditedRoute[] {
  const routes: AuditedRoute[] = []
  for (const layer of r.stack ?? []) {
    if (!layer.route) continue
    const path: string = layer.route.path
    for (const routeLayer of layer.route.stack ?? []) {
      const method: string | undefined = routeLayer.method
      const permission: string | undefined = (routeLayer.handle as any)?.requiredPermission
      if (!method || !permission) continue
      routes.push({ method, path, permission })
    }
  }
  return routes
}

/** Lo que pinta la tabla del panel: las filas de comandos de un negocio. */
const LECTURAS_DEL_REGISTRO = [
  '/venues/:venueId/tpv-commands',
  '/venues/:venueId/tpv-commands/history',
  '/venues/:venueId/tpv-commands/:commandId',
]

/** `<PermissionGate permission="tpv:command">` en `avoqado-web-dashboard/src/pages/Tpv/TpvId.tsx`. */
const VEN_EL_PANEL = [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]
const NO_LO_VEN = [StaffRole.CASHIER, StaffRole.WAITER, StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER]

describe('registro de comandos remotos de la TPV — candados de lectura', () => {
  const audited = collectAuditedRoutes(router)
  const find = (method: string, path: string) => audited.find(r => r.method === method && r.path === path)

  it.each(LECTURAS_DEL_REGISTRO)('GET %s exige tpv:command, el mismo permiso que abre el panel', path => {
    expect(find('get', path)?.permission).toBe('tpv:command')
  })

  describe.each(LECTURAS_DEL_REGISTRO)('GET %s', path => {
    it.each(VEN_EL_PANEL)('%s puede leerlo (el defecto: respondía 403)', role => {
      const permission = find('get', path)!.permission
      expect(hasPermission(role, null, permission)).toBe(true)
    })

    it.each(NO_LO_VEN)('%s sigue fuera: ve la tabla de comandos sólo quien puede enviarlos', role => {
      const permission = find('get', path)!.permission
      expect(hasPermission(role, null, permission)).toBe(false)
    })
  })
})

describe('registro de comandos remotos de la TPV — lo que NO se abrió', () => {
  const audited = collectAuditedRoutes(router)
  const find = (method: string, path: string) => audited.find(r => r.method === method && r.path === path)

  // 🔴 Enviar un comando (apagar, borrar de fábrica) no se afloja por arreglar una lectura.
  it.each([
    ['post', '/venues/:venueId/tpv-commands', 'tpv-commands:write'],
    ['post', '/venues/:venueId/tpv-commands/bulk', 'tpv-commands:bulk'],
    ['post', '/venues/:venueId/tpv-commands/:commandId/cancel', 'tpv-commands:write'],
    ['post', '/venues/:venueId/tpv-commands/:commandId/retry', 'tpv-commands:write'],
    ['post', '/venues/:venueId/tpv-commands/scheduled', 'tpv-commands:schedule'],
    ['post', '/venues/:venueId/tpv-commands/geofence', 'tpv-commands:geofence'],
  ])('%s %s sigue exigiendo %s y ningún rol de un negocio lo cumple', (method, path, permission) => {
    expect(find(method, path)?.permission).toBe(permission)
    for (const role of [...VEN_EL_PANEL, ...NO_LO_VEN]) {
      expect(hasPermission(role, null, permission)).toBe(false)
    }
  })
})
