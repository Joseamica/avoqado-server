/**
 * Candados de las rutas de asistencia del dashboard.
 *
 * El checador ya existia y lo consumian la TPV, Android e iOS; estas rutas abren la
 * REVISION al dueno de un negocio normal, que antes solo existia en el panel de
 * organizacion tras el acceso white-label.
 *
 * Permiso PROPIO `attendance:read` / `:manage` (OWNER, ADMIN, MANAGER). La primera version
 * reusaba `tpv-time-entries:*`, y `:write` lo tienen CASHIER y WAITER para checarse a si
 * mismos: eso convertia a cualquier mesero en administrador de la asistencia de sus
 * companeros (auditoria Codex 2026-08-26, P1). Un permiso de piso nunca gobierna
 * administracion — si alguien vuelve a "simplificar" esto, estas pruebas lo cazan.
 */
import router from '@/routes/dashboard.routes'

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

describe('rutas de asistencia — candados', () => {
  const audited = collectAuditedRoutes(router)
  const find = (method: string, path: string) => audited.find(r => r.method === method && r.path === path)

  it.each([
    ['/venues/:venueId/time-entries'],
    ['/venues/:venueId/time-entries/active'],
    ['/venues/:venueId/time-entries/summary/:staffId'],
    ['/venues/:venueId/attendance/report'],
    ['/venues/:venueId/team/:staffVenueId/work-schedule'],
  ])('leer %s exige attendance:read', path => {
    expect(find('get', path)?.permission).toBe('attendance:read')
  })

  it.each([['put', '/venues/:venueId/team/:staffVenueId/work-schedule']])('%s %s exige attendance:manage', (method, path) => {
    expect(find(method, path)?.permission).toBe('attendance:manage')
  })

  it('🔴 ninguna ruta de asistencia se conforma con un permiso de piso', () => {
    // `tpv-time-entries:write` lo tienen CASHIER y WAITER para checarse. Si vuelve aquí,
    // un mesero puede editar el cuadrante de sus companeros.
    const floor = audited.filter(r => /time-entries|attendance|work-schedule/.test(r.path) && r.permission.startsWith('tpv-time-entries:'))
    expect(floor).toEqual([])
  })

  it('el dashboard NO expone marcar entrada ni salida', () => {
    // Checar solo pasa en el aparato del negocio, donde la foto y el GPS significan algo.
    // Si alguien agrega aqui un clock-in, esta prueba lo caza.
    const clockRoutes = audited.filter(r => /time-entries\/(clock-in|clock-out)|time-clock/.test(r.path))
    expect(clockRoutes).toEqual([])
  })
})

/**
 * Candados del expediente del personal.
 *
 * 🔴 Aquí viven identificación, CURP, número de seguro social y contratos. El permiso es
 * PROPIO a propósito: `teams:read` lo tiene MANAGER, y un gerente no debe poder abrir la
 * identificación de sus compañeros. Si alguien "simplifica" esto a `teams:read`, estas
 * pruebas lo cazan.
 */
describe('rutas del expediente del personal — candados', () => {
  const audited = collectAuditedRoutes(router)
  const find = (method: string, path: string) => audited.find(r => r.method === method && r.path === path)

  it('leer el expediente exige staff-documents:read, NUNCA teams:read', () => {
    expect(find('get', '/venues/:venueId/team/:staffId/documents')?.permission).toBe('staff-documents:read')
  })

  it('abrir un documento (URL firmada) exige staff-documents:read', () => {
    expect(find('get', '/venues/:venueId/staff-documents/:documentId/url')?.permission).toBe('staff-documents:read')
  })

  it('subir un documento exige staff-documents:write', () => {
    expect(find('post', '/venues/:venueId/team/:staffId/documents')?.permission).toBe('staff-documents:write')
  })

  it('dar de baja un documento exige staff-documents:write', () => {
    expect(find('delete', '/venues/:venueId/staff-documents/:documentId')?.permission).toBe('staff-documents:write')
  })

  it('ninguna ruta del expediente se conforma con un permiso de equipo', () => {
    const docRoutes = audited.filter(r => /documents/.test(r.path))
    expect(docRoutes.length).toBeGreaterThan(0)
    expect(docRoutes.every(r => r.permission.startsWith('staff-documents:'))).toBe(true)
  })
})

describe('la pantalla genérica NO aprueba checadas', () => {
  const audited = collectAuditedRoutes(router)
  it('no existe ruta de validar en el dashboard genérico — eso es flujo de PlayTelecom', () => {
    // Square no aprueba checadas (aprueba solicitudes de corrección del empleado). Validar
    // cada checada es la operación de PT, que vive en storesAnalysis con gate white-label.
    expect(audited.find(r => /time-entries\/:timeEntryId\/validate/.test(r.path))).toBeUndefined()
  })
})
