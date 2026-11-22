// tests/unit/routes/onlineOrdering.cerradoSinEntregar.http.test.ts
/**
 * D661 (Ruling 71): un POS o una TPV VIEJOS leen `409 ORDER_STATE_CHANGED` + `status: COMPLETED` en «Entregado» como el segundo toque
 * (éxito). Un pedido CERRADO sin entregarse («No lo recogió», «Devolviendo…» o «Devuelto» ya en COMPLETED) contesta con su PROPIO código
 * por las tres puertas (POS, TPV y panel), con el estado y las marcas de siempre; lo demás, el 409 de siempre. Corre el camino REAL
 * ruta → validación → permiso → controlador; sólo se sueltan la sesión y el permiso (sus pruebas viven en `onlineOrdering.restaurant`)
 * y la transición contesta lo que diría la base.
 */
import express from 'express'
import request from 'supertest'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  __esModule: true,
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    req.authContext = { userId: 'staff1', venueId: 'v1' }
    next()
  },
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  __esModule: true,
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
  resolveUserRoleForVenue: jest.fn(),
  evaluateRolePermission: jest.fn(),
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  __esModule: true,
  checkFeatureAccess: () => (_req: any, _res: any, next: any) => next(),
}))
jest.mock('@/services/online-ordering/transitions.service', () => ({
  __esModule: true,
  ...jest.requireActual('@/services/online-ordering/transitions.service'),
  markOnlineOrderDelivered: jest.fn(),
  markOnlineOrderReady: jest.fn(),
}))

import { markOnlineOrderDelivered, markOnlineOrderReady } from '@/services/online-ordering/transitions.service'
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

const PUERTAS = {
  POS: '/m/venues/v1/online-orders/ord1',
  TPV: '/t/venues/v1/online-orders/ord1',
  PANEL: '/d/venues/v1/online-ordering/orders/ord1',
} as const
const CERRADO_SIN_ENTREGAR = 'Este pedido ya se cerró (se devolvió o no lo recogieron). No lo entregues.'
const HORA = '2026-11-20T23:59:00.000Z'

beforeEach(() => {
  ;(markOnlineOrderDelivered as jest.Mock).mockReset()
  ;(markOnlineOrderReady as jest.Mock).mockReset()
})

describe('D661 (Ruling 71) · un pedido cerrado sin entregarse tiene su propio 409 por las tres puertas', () => {
  it('«Entregado» y «Listo» sobre uno COMPLETED con «No lo recogió», «Devolviendo…» o «Devuelto» → 409 ORDER_CLOSED_NOT_DELIVERED con su estado y sus marcas', async () => {
    for (const marcas of [{ notPickedUpAt: HORA }, { refundRequestedAt: HORA }, { refundRequestedAt: HORA, refundedAt: HORA }]) {
      for (const [accion, fn] of [
        ['delivered', markOnlineOrderDelivered],
        ['ready', markOnlineOrderReady],
      ] as const) {
        ;(fn as jest.Mock).mockResolvedValue({ outcome: 'STALE', status: 'COMPLETED', ...marcas })
        for (const [puerta, base] of Object.entries(PUERTAS)) {
          const r = await request(app).post(`${base}/${accion}`).send({})
          expect({ puerta, accion, status: r.status, body: r.body }).toEqual({
            puerta,
            accion,
            status: 409,
            body: { success: false, code: 'ORDER_CLOSED_NOT_DELIVERED', status: 'COMPLETED', ...marcas, error: CERRADO_SIN_ENTREGAR },
          })
        }
      }
    }
    expect(markOnlineOrderDelivered).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1', staffId: 'staff1' })
  })

  it('lo demás sigue como hoy: «Devolviendo…» de uno por entregar y un COMPLETED sin marcas → 409 ORDER_STATE_CHANGED; el segundo toque de «Entregado» → 200', async () => {
    for (const [puerta, base] of Object.entries(PUERTAS)) {
      ;(markOnlineOrderDelivered as jest.Mock).mockResolvedValueOnce({ outcome: 'STALE', status: 'READY', refundRequestedAt: HORA })
      const devolviendo = await request(app).post(`${base}/delivered`).send({})
      expect({ puerta, status: devolviendo.status, body: devolviendo.body }).toEqual({
        puerta,
        status: 409,
        body: {
          success: false,
          code: 'ORDER_STATE_CHANGED',
          status: 'READY',
          refundRequestedAt: HORA,
          error: 'Este pedido se está devolviendo: no se marca entregado. No se aplicó nada.',
        },
      })
      ;(markOnlineOrderReady as jest.Mock).mockResolvedValueOnce({ outcome: 'STALE', status: 'COMPLETED' })
      const sinMarcas = await request(app).post(`${base}/ready`).send({})
      expect({ puerta, status: sinMarcas.status, code: sinMarcas.body.code, estado: sinMarcas.body.status }).toEqual({
        puerta,
        status: 409,
        code: 'ORDER_STATE_CHANGED',
        estado: 'COMPLETED',
      })

      // A12: «Entregado» sobre lo ya entregado (sin marcas) sigue siendo el segundo toque idempotente.
      ;(markOnlineOrderDelivered as jest.Mock).mockResolvedValueOnce({ outcome: 'OK', status: 'COMPLETED', unchanged: true })
      const segundoToque = await request(app).post(`${base}/delivered`).send({})
      expect({ puerta, status: segundoToque.status, body: segundoToque.body }).toEqual({
        puerta,
        status: 200,
        body: { success: true, data: { status: 'COMPLETED', unchanged: true } },
      })
    }
  })
})
