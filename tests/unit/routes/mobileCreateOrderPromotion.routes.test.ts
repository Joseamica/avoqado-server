/**
 * POST /mobile/venues/:venueId/orders — los candados que dependen del BODY.
 *
 * La venta rápida puede traer `items[].promotionRef`. Aplicar una promoción
 * regala mercancía, así que exige `discounts:apply` (espejo online del guard del
 * reducer offline, sync.mobile.service.ts → requiredPermissionsForIntent) y el
 * plan PRO `PROMOTIONS` (mismo candado que el catálogo del POS y que
 * assertPromotionsFeature). Sin ellos, la venta rápida sería la puerta de atrás
 * de ambos.
 *
 * Su gemelo offline SÍ tiene test (syncPromotionPermission / sync.mobile.service);
 * este camino no tenía ninguno: un reordenamiento de middlewares o un cambio en
 * el predicado devolvería el boundary a cero EN SILENCIO, con todo en verde.
 *
 * Se monta el router REAL y se introspecciona su stack (misma técnica que
 * tpv.sync.routes.test.ts), mockeando sólo las dos fábricas de middleware para
 * poder observar QUÉ se exige y en QUÉ orden.
 */

const mockState = {
  /** Lo que se EXIGE al correr el request (el candado que depende del body). */
  calls: [] as string[],
  /** Lo que se declara al MONTAR la ruta (fábricas invocadas al importar). */
  mounted: [] as string[],
  denyPermission: false,
  denyFeature: false,
}

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  checkPermission: (permission: string) => {
    mockState.mounted.push(`permission:${permission}`)
    return (_req: any, res: any, next: any) => {
      mockState.calls.push(`permission:${permission}`)
      if (mockState.denyPermission) return res.status(403).json({ message: 'sin permiso' })
      return next()
    }
  },
}))

jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkFeatureAccess.middleware'),
  checkFeatureAccess: (featureCode: string) => (_req: any, res: any, next: any) => {
    mockState.calls.push(`feature:${featureCode}`)
    if (mockState.denyFeature) return res.status(403).json({ message: 'plan requerido' })
    return next()
  },
}))

import mobileRouter from '@/routes/mobile.routes'
import * as orderMobileController from '@/controllers/mobile/order.mobile.controller'

// Lo que se exigió al MONTAR las rutas (fuera del body): congelado al importar.
const loadTimeCalls = [...mockState.mounted]

const ORDERS_PATH = '/venues/:venueId/orders'

function routeHandlers(method: string, path: string): any[] {
  for (const layer of (mobileRouter as any).stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (!routeLayers.some(rl => rl.method === method)) continue
    return routeLayers.map(rl => rl.handle)
  }
  return []
}

function buildRes() {
  const res: any = {}
  res.status = jest.fn().mockImplementation((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn().mockReturnValue(res)
  return res
}

const promotionRef = { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] }

describe('POST /mobile/venues/:venueId/orders — candados de promoción', () => {
  const handlers = routeHandlers('post', ORDERS_PATH)
  // El guard va justo ANTES del controller (último handler).
  const guard = handlers[handlers.length - 2]

  beforeEach(() => {
    mockState.calls = []
    mockState.denyPermission = false
    mockState.denyFeature = false
  })

  // ── Cableado de la ruta ──

  it('la ruta termina en createOrder y sigue exigiendo orders:create al montarse', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(4)
    expect(handlers[handlers.length - 1]).toBe(orderMobileController.createOrder)
    expect(loadTimeCalls).toContain('permission:orders:create')
    // El candado de promoción NO se resuelve al montar: depende del body.
    expect(loadTimeCalls).not.toContain('permission:discounts:apply')
    expect(typeof guard).toBe('function')
  })

  // ── El candado sólo aparece si la venta trae promoción ──

  it('una venta SIN promotionRef pasa de largo: ni permiso ni plan extra', async () => {
    const next = jest.fn()
    await guard({ body: { items: [{ productId: 'p1', quantity: 1 }] } } as any, buildRes(), next)

    expect(mockState.calls).toEqual([])
    expect(next).toHaveBeenCalled()
  })

  it('una venta CON promotionRef exige discounts:apply y el plan PROMOTIONS, en ese orden', async () => {
    const next = jest.fn()
    await guard({ body: { items: [{ productId: 'p1', quantity: 1 }, { promotionRef }] } } as any, buildRes(), next)

    // El permiso ANTES del plan: a quien no puede aplicar promociones no se le
    // revela el plan del negocio.
    expect(mockState.calls).toEqual(['permission:discounts:apply', 'feature:PROMOTIONS'])
    expect(next).toHaveBeenCalled()
  })

  it('sin discounts:apply NO llega al controller — y el plan del negocio nunca se consulta', async () => {
    mockState.denyPermission = true
    const next = jest.fn()
    const res = buildRes()

    await guard({ body: { items: [{ promotionRef }] } } as any, res, next)

    expect(mockState.calls).toEqual(['permission:discounts:apply'])
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('sin el plan PROMOTIONS NO llega al controller (un venue FREE no aplica combos por aquí)', async () => {
    mockState.denyFeature = true
    const next = jest.fn()
    const res = buildRes()

    await guard({ body: { items: [{ promotionRef }] } } as any, res, next)

    expect(mockState.calls).toEqual(['permission:discounts:apply', 'feature:PROMOTIONS'])
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  // ── Bordes: el guard nunca puede tronar antes de la validación del controller ──

  it('un body sin items (o con items que no son arreglo) pasa de largo sin romperse', async () => {
    const next = jest.fn()
    await guard({ body: {} } as any, buildRes(), next)
    await guard({ body: { items: 'no-soy-arreglo' } } as any, buildRes(), next)
    await guard({} as any, buildRes(), next)

    expect(mockState.calls).toEqual([])
    expect(next).toHaveBeenCalledTimes(3)
  })
})
