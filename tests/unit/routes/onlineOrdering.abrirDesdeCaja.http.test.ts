// tests/unit/routes/onlineOrdering.abrirDesdeCaja.http.test.ts
/**
 * D661 (3A, entradas): abrir un apartado de tarjeta de «Nadie» COBRA. Sólo lo abre una caja actualizada: por las rutas de la TPV y del
 * POS, con el cuerpo explícito `{ abrirPagadoEnLinea: true }`. El panel (aun con el campo), las apps viejas (sin él) y el MCP reciben
 * 409 OPEN_FROM_CAJA y nada se cobra. Aquí corre el camino REAL: ruta → validación (`acceptSchema`) → controlador → `acceptOnlineOrder`;
 * sólo se sueltan la sesión y el permiso (sus pruebas viven en `onlineOrdering.restaurant`) y la captura queda espiada (si se llama,
 * se cobraría).
 */
import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  __esModule: true,
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    req.authContext = { userId: 'staff1', venueId: 'v1' }
    next()
  },
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  __esModule: true,
  checkPermission: (perm: string) => (req: any, _res: any, next: any) => {
    req.perms = [...(req.perms ?? []), perm]
    next()
  },
  resolveUserRoleForVenue: jest.fn(),
  evaluateRolePermission: jest.fn(),
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  __esModule: true,
  checkFeatureAccess: () => (_req: any, _res: any, next: any) => next(),
}))
// La captura: si se llama, se cobraría la tarjeta.
const mockCapturar = jest.fn()
jest.mock('@/services/online-ordering/card/capture.service', () => ({
  __esModule: true,
  acceptCardOnlineOrder: (...a: unknown[]) => mockCapturar(...a),
}))

import mobileRouter from '@/routes/mobile/onlineOrders.mobile.routes'
import tpvRouter from '@/routes/tpv/onlineOrders.tpv.routes'
import dashboardRouter from '@/routes/dashboard/onlineOrdering.dashboard.routes'

const app = express()
app.use(express.json())
app.use('/m/venues/:venueId/online-orders', mobileRouter)
app.use('/t/venues/:venueId/online-orders', tpvRouter)
app.use(
  '/d/venues/:venueId/online-ordering',
  (req: any, _res, next) => {
    req.authContext = { userId: 'staff1', venueId: 'v1' } // el panel se monta tras la sesión de `dashboard.routes`
    next()
  },
  dashboardRouter,
)
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ code: err.code, error: err.message }))

const MOVIL = '/m/venues/v1/online-orders/ord1/accept'
const TPV = '/t/venues/v1/online-orders/ord1/accept'
const PANEL = '/d/venues/v1/online-ordering/orders/ord1/accept'
const ABRIR = { abrirPagadoEnLinea: true }

/** Los conteos de `acceptOnlineOrder` contestan como la fila del pedido: ¿es tarjeta?, ¿es de «Nadie» (sin aceptación)? */
const pedidoQue = (o: { tarjeta: boolean; nadie: boolean }) =>
  prismaMock.onlineOrder.count.mockImplementation((async ({ where }: any) => {
    if (where.paymentMode === 'CARD_ONLINE' && !o.tarjeta) return 0
    if (where.requiresAcceptance === false && !o.nadie) return 0
    return 1
  }) as any)

beforeEach(() => {
  mockCapturar.mockReset()
  mockCapturar.mockResolvedValue({ outcome: 'OK', status: 'ACCEPTED', estimatedReadyAt: '2026-11-20T18:15:00.000Z' })
})
afterAll(() => prismaMock.onlineOrder.count.mockReset())

describe('D661 · abrir (= cobrar) un apartado de «Nadie»: sólo desde una caja actualizada', () => {
  it('aceptar un pedido «Nadie» CARD_ONLINE exige la apertura explícita de una caja actualizada (cuerpo { abrirPagadoEnLinea: true }); sin ella → 409 OPEN_FROM_CAJA, nada se cobra', async () => {
    pedidoQue({ tarjeta: true, nadie: true })
    // Apps viejas (TPV y POS): la ruta de siempre sin el campo.
    for (const ruta of [MOVIL, TPV]) {
      const r = await request(app).post(ruta).send({})
      expect({ ruta, status: r.status, code: r.body.code }).toEqual({ ruta, status: 409, code: 'OPEN_FROM_CAJA' })
      expect(r.body.error).toMatch(/caja/)
    }
    // Un valor que no es el `true` explícito tampoco abre (el esquema sólo deja pasar booleanos).
    expect((await request(app).post(MOVIL).send({ abrirPagadoEnLinea: false })).body.code).toBe('OPEN_FROM_CAJA')
    expect((await request(app).post(MOVIL).send({ abrirPagadoEnLinea: 'true' })).status).toBe(400)
    expect(mockCapturar).not.toHaveBeenCalled()

    // Una caja actualizada, por su ruta y con el campo: abre y cobra (la captura de siempre), con orders:update.
    for (const ruta of [MOVIL, TPV]) {
      const r = await request(app)
        .post(ruta)
        .send({ ...ABRIR, estimatedMinutes: 12 })
      expect({ ruta, status: r.status, data: r.body.data }).toEqual({
        ruta,
        status: 200,
        data: { status: 'ACCEPTED', estimatedReadyAt: '2026-11-20T18:15:00.000Z' },
      })
    }
    expect(mockCapturar).toHaveBeenCalledTimes(2)
    expect(mockCapturar).toHaveBeenCalledWith({
      venueId: 'v1',
      orderId: 'ord1',
      staffId: 'staff1',
      estimatedMinutes: 12,
      abrirPagadoEnLinea: true,
    })
  })

  it('abrirPagadoEnLinea sólo vale en las rutas de caja (móvil y TPV); por la ruta del DASHBOARD, aun con el campo → 409 OPEN_FROM_CAJA', async () => {
    pedidoQue({ tarjeta: true, nadie: true })
    for (const cuerpo of [ABRIR, {}]) {
      const r = await request(app).post(PANEL).send(cuerpo)
      expect(r.status).toBe(409)
      expect(r.body).toMatchObject({ success: false, code: 'OPEN_FROM_CAJA' })
    }
    expect(mockCapturar).not.toHaveBeenCalled()
  })

  it('«Mi equipo» con tarjeta sigue igual: se acepta (y cobra) sin el campo por el panel y por las apps', async () => {
    pedidoQue({ tarjeta: true, nadie: false })
    for (const ruta of [PANEL, MOVIL, TPV]) {
      const r = await request(app).post(ruta).send({})
      expect({ ruta, status: r.status }).toEqual({ ruta, status: 200 })
    }
    expect(mockCapturar).toHaveBeenCalledTimes(3)
    expect(mockCapturar).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1', staffId: 'staff1', estimatedMinutes: undefined })
  })

  it('una apertura D661 no se registra como «el personal contestó» de «Mi equipo», aunque el negocio haya cambiado de modo entre pagar y abrir', async () => {
    // Pagó en «Nadie»; hoy la tienda está en «Mi equipo». Decide el modo del PEDIDO (guardado al confirmar), no el de hoy.
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ venueId: 'v1', requiresAcceptance: true } as any)
    pedidoQue({ tarjeta: true, nadie: true })
    // «Aceptar» de «Mi equipo» (el panel o una app sin el campo) no lo abre.
    expect((await request(app).post(PANEL).send({})).body.code).toBe('OPEN_FROM_CAJA')
    expect((await request(app).post(MOVIL).send({})).body.code).toBe('OPEN_FROM_CAJA')
    // La caja lo abre.
    expect((await request(app).post(TPV).send(ABRIR)).status).toBe(200)
    // Hoy no existe ningún registro de «el personal contestó» ni contador de pausa (D662 parte 2 no está en la base): abrir no escribe
    // nada en los ajustes de la tienda (ni latidos, ni pausas), ni consulta el modo de hoy.
    for (const escribir of ['update', 'updateMany', 'upsert', 'create'] as const) {
      expect(prismaMock.onlineOrderingSettings[escribir]).not.toHaveBeenCalled()
    }
    expect(prismaMock.onlineOrderingSettings.findUnique).not.toHaveBeenCalled()
  })
})
