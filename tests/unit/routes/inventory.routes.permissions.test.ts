/**
 * Auditoría de permisos de las rutas de inventario.
 *
 * Bug (auditoría FIFO 2026-06-11): ~13 endpoints de ESCRITURA (ajustar stock,
 * crear/editar/borrar órdenes de compra, proveedores, recetas…) estaban gated
 * con `inventory:read`. Como `inventory:read` se hereda implícitamente vía
 * `orders:create`/`orders:update` (PERMISSION_DEPENDENCIES), cualquier mesero
 * podía ajustar inventario.
 *
 * Estos tests fallan con las rutas mal gated y pasan con el fix. La regla
 * general además protege contra regresiones futuras: ningún método de
 * escritura puede exigir solo `inventory:read`.
 */

import inventoryRouter from '@/routes/dashboard/inventory.routes'

type AuditedRoute = { method: string; path: string; permission: string }

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete'])

/**
 * POSTs que NO mutan estado (POST-as-query): generación de PDFs de etiquetas y
 * consulta masiva de benchmarks. Mantienen inventory:read deliberadamente.
 */
const READONLY_POST_ALLOWLIST = new Set([
  'post /purchase-orders/:purchaseOrderId/labels',
  'post /product-labels',
  'post /market-benchmark/bulk',
])

function collectAuditedRoutes(router: any): AuditedRoute[] {
  const routes: AuditedRoute[] = []
  for (const layer of router.stack ?? []) {
    if (!layer.route) continue
    const path: string = layer.route.path
    const seen = new Set<string>()
    for (const routeLayer of layer.route.stack ?? []) {
      const method: string | undefined = routeLayer.method
      const permission: string | undefined = (routeLayer.handle as any)?.requiredPermission
      if (!method || !permission) continue
      const key = `${method} ${path}`
      if (seen.has(key)) continue
      seen.add(key)
      routes.push({ method, path, permission })
    }
  }
  return routes
}

describe('inventory.routes — permisos por endpoint', () => {
  const audited = collectAuditedRoutes(inventoryRouter)

  it('el router expone permisos auditables (marcador requiredPermission)', () => {
    expect(audited.length).toBeGreaterThan(10)
  })

  it('ningún endpoint de ESCRITURA exige solo inventory:read', () => {
    const offenders = audited
      .filter(r => WRITE_METHODS.has(r.method) && r.permission === 'inventory:read')
      .filter(r => !READONLY_POST_ALLOWLIST.has(`${r.method} ${r.path}`))
      .map(r => `${r.method.toUpperCase()} ${r.path}`)

    expect(offenders).toEqual([])
  })

  it.each([
    ['post', '/raw-materials/:rawMaterialId/adjust-stock', 'inventory:update'],
    ['post', '/suppliers', 'inventory:create'],
    ['post', '/purchase-orders', 'inventory:create'],
    ['put', '/purchase-orders/:purchaseOrderId', 'inventory:update'],
    ['delete', '/purchase-orders/:purchaseOrderId', 'inventory:delete'],
    ['post', '/purchase-orders/:purchaseOrderId/approve', 'inventory:update'],
    ['post', '/purchase-orders/:purchaseOrderId/cancel', 'inventory:update'],
    ['get', '/inter-venue-transfers', 'inventory-transfers:read'],
    ['post', '/inter-venue-transfers', 'inventory-transfers:request'],
    ['post', '/inter-venue-transfers/:transferId/approve', 'inventory-transfers:approve'],
    ['post', '/inter-venue-transfers/:transferId/reject', 'inventory-transfers:approve'],
    ['post', '/inter-venue-transfers/:transferId/cancel', 'inventory-transfers:approve|inventory-transfers:request'],
    ['post', '/inter-venue-transfers/:transferId/dispatch', 'inventory-transfers:dispatch'],
    ['post', '/inter-venue-transfers/:transferId/receive', 'inventory-transfers:receive'],
    ['post', '/inter-venue-transfers/:transferId/resolve-variance', 'inventory-transfers:receive'],
  ])('%s %s exige %s', (method, path, expectedPermission) => {
    const route = audited.find(r => r.method === method && r.path === path)
    expect(route).toBeDefined()
    expect(route!.permission).toBe(expectedPermission)
  })
})
