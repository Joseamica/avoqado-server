/**
 * Candado de la ruta que CAMBIA una suscripción de función suelta.
 *
 * Auditoría del 21-sep-2026 (hallazgo #9): el PUT exigía `features:write`, que MANAGER tiene por
 * defecto, mientras el alta y la baja de esa MISMA suscripción exigen `billing:subscriptions:manage`,
 * que no tiene. O sea: un gerente no podía contratar ni cancelar, pero sí cambiar el producto y el
 * precio de lo contratado — que mueve dinero igual. Cambiar de producto es facturación, no catálogo.
 * Si alguien vuelve a bajarlo a `features:write`, esta prueba lo caza.
 */
import router from '@/routes/dashboard.routes'

function permisoDe(metodo: string, ruta: string): string | undefined {
  for (const layer of (router as any).stack ?? []) {
    if (!layer.route || layer.route.path !== ruta) continue
    for (const routeLayer of layer.route.stack ?? []) {
      if (routeLayer.method !== metodo) continue
      const permiso = (routeLayer.handle as any)?.requiredPermission
      if (permiso) return permiso
    }
  }
  return undefined
}

const RUTA_PUT = '/venues/:venueId/features/:featureId/subscription'

describe('cambiar una suscripción à-la-carte es facturación', () => {
  it('el PUT exige billing:subscriptions:manage', () => {
    expect(permisoDe('put', RUTA_PUT)).toBe('billing:subscriptions:manage')
  })

  it('NO se conforma con features:write (lo tiene MANAGER)', () => {
    expect(permisoDe('put', RUTA_PUT)).not.toBe('features:write')
  })

  it('pide el MISMO permiso que dar de alta la suscripción', () => {
    expect(permisoDe('put', RUTA_PUT)).toBe(permisoDe('post', '/venues/:venueId/features'))
  })
})
