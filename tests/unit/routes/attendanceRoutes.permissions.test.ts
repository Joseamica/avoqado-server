/**
 * Candados de las rutas de asistencia del dashboard.
 *
 * El checador ya existia y lo consumian la TPV, Android e iOS; estas rutas abren la
 * REVISION al dueno de un negocio normal, que antes solo existia en el panel de
 * organizacion tras el acceso white-label.
 *
 * Se reusan `tpv-time-entries:read` / `:write` en vez de inventar un permiso nuevo,
 * porque ya distinguen exactamente a quien revisa (OWNER, ADMIN, MANAGER) de quien solo
 * checa (CASHIER, WAITER). Un permiso mal puesto aqui no truena: falla en silencio —
 * o el gerente ve un 403 sin explicacion, o un cajero puede aprobarse sus propias horas.
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
  ])('leer %s exige tpv-time-entries:read', path => {
    expect(find('get', path)?.permission).toBe('tpv-time-entries:read')
  })

  it('aprobar una checada exige tpv-time-entries:write, no solo :read', () => {
    // Con :read bastaria, un cajero — que tiene :write pero no :read — quedaria fuera y
    // un VIEWER quedaria dentro. La escritura es la que decide si unas horas se pagan.
    expect(find('post', '/venues/:venueId/time-entries/:timeEntryId/validate')?.permission).toBe('tpv-time-entries:write')
  })

  it('el dashboard NO expone marcar entrada ni salida', () => {
    // Checar solo pasa en el aparato del negocio, donde la foto y el GPS significan algo.
    // Si alguien agrega aqui un clock-in, esta prueba lo caza.
    const clockRoutes = audited.filter(r => /time-entries\/(clock-in|clock-out)|time-clock/.test(r.path))
    expect(clockRoutes).toEqual([])
  })
})
