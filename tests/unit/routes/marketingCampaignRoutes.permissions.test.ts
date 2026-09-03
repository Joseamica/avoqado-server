/**
 * Candados de las rutas de campañas de correo a clientes (Fase 1C-A, Task 6).
 *
 * Introspección estática del router REAL de Express — mismo molde que
 * `attendanceRoutes.permissions.test.ts`: sin mocks, sin DB, se lee el atributo
 * `requiredPermission` que `checkPermission()` estampa en su middleware.
 *
 * La ruta vive en un sub-router propio (`src/routes/dashboard/marketingCampaign.routes.ts`),
 * montado bajo `/venues/:venueId/campaigns` en `dashboard.routes.ts` — por eso este
 * archivo introspecciona el sub-router directamente en vez del router del dashboard
 * completo, y los paths que ve son relativos ('/', '/:id', '/:id/publish'…).
 *
 * 🔴 La regla dura que este archivo protege: `marketing:send` NO se hereda de
 * `marketing:manage`. Quien puede editar una campaña no puede necesariamente
 * mandarla — mandar es irreversible y le llega a los clientes del negocio.
 *
 * 🔴 Y la segunda regla, fix ronda final (revisor): leer (listar/detalle) exige
 * `marketing:manage`, NO `marketing:read` — ese permiso lo tienen roles de PISO
 * (CASHIER, WAITER…) con un propósito distinto y explícito en `src/lib/permissions.ts`
 * ("ver el aviso de privacidad"). Dejarlas en `:read` le abría a un cajero el listado
 * completo de borradores y destinatarios.
 */
import fs from 'fs'
import path from 'path'
import router from '@/routes/dashboard/marketingCampaign.routes'

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

describe('rutas de campañas de correo — candados', () => {
  const audited = collectAuditedRoutes(router)
  const find = (method: string, routePath: string) => audited.find(r => r.method === method && r.path === routePath)

  // 🔴 Fix ronda final: leer (listar/detalle) exige `marketing:manage`, NO
  // `marketing:read` — ese permiso lo tienen roles de piso con OTRO propósito.
  it.each([
    ['get', '/'],
    ['get', '/:id'],
  ])('leer (%s %s) exige marketing:manage (NO marketing:read — eso lo tiene el piso)', (method, routePath) => {
    expect(find(method, routePath)?.permission).toBe('marketing:manage')
  })

  it.each([
    ['post', '/'],
    ['put', '/:id'],
  ])('crear/editar (%s %s) exige marketing:manage', (method, routePath) => {
    expect(find(method, routePath)?.permission).toBe('marketing:manage')
  })

  it('publicar (POST /:id/publish) exige marketing:send', () => {
    expect(find('post', '/:id/publish')?.permission).toBe('marketing:send')
  })

  // 🔴 La prueba que más importa de este archivo: enviar NO se hereda de editar.
  it('🔴 publicar NUNCA se conforma con marketing:manage — enviar no se hereda de editar', () => {
    const publish = find('post', '/:id/publish')
    expect(publish?.permission).not.toBe('marketing:manage')
    expect(publish?.permission).toBe('marketing:send')
  })

  it('ninguna ruta de campañas se queda sin permiso (todas están auditadas)', () => {
    // Barre TODAS las rutas registradas en el router, no sólo las que este archivo nombra
    // arriba — si se agrega una ruta nueva sin `checkPermission`, `collectAuditedRoutes`
    // simplemente no la ve, así que se cuenta cuántas rutas conoce Express de verdad.
    const rutasDeclaradas = new Set<string>()
    for (const layer of (router as any).stack ?? []) {
      if (!layer.route) continue
      for (const method of Object.keys(layer.route.methods ?? {})) {
        rutasDeclaradas.add(`${method}:${layer.route.path}`)
      }
    }
    const rutasAuditadas = new Set(audited.map(r => `${r.method}:${r.path}`))
    expect(rutasAuditadas).toEqual(rutasDeclaradas)
  })

  it('está montada bajo /venues/:venueId/campaigns en el router del dashboard', () => {
    const padre = fs.readFileSync(path.join(__dirname, '../../../src/routes/dashboard.routes.ts'), 'utf8')
    expect(padre).toMatch(
      /router\.use\(\s*'\/venues\/:venueId\/campaigns',\s*authenticateTokenMiddleware,\s*marketingCampaignRoutes,?\s*\)/,
    )
  })
})
