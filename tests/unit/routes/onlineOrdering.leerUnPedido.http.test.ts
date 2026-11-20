// tests/unit/routes/onlineOrdering.leerUnPedido.http.test.ts
/**
 * D661 (Ruling 14): la caja (POS y TPV) lee UN pedido en línea por su propio camino, `GET …/online-orders/:orderId`: el MISMO lector
 * y el MISMO manejador del panel (`getInboxOrder`), con `orderActionSchema` y `orders:read`, sin candado de plan y sin latir. Así imprime
 * la comanda de un pedido de `comandasPorImprimir` que el cierre del día ya sacó de «Por entregar». Aquí corre el camino REAL: ruta →
 * validación → permiso (el `hasPermission` real del rol, con lo que el negocio le quite) → manejador → lector, sobre `prismaMock`.
 */
import express from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  __esModule: true,
  // La sesión es de una cajera del negocio v1 (la TPV exige que el :venueId de la URL sea el del token).
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    req.authContext = { userId: 'staff1', venueId: 'v1', role: 'CASHIER' }
    next()
  },
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  __esModule: true,
  // La evaluación REAL de permisos: una cajera con los de su rol, o (`x-test-lista-propia`) con la lista propia del empleado, que
  // REEMPLAZA a la del rol (`StaffVenue.permissionSetId`): el único camino del producto para quitarle `orders:read` a alguien.
  checkPermission: (perm: string) => (req: any, res: any, next: any) => {
    const { hasPermission, evaluatePermissionList } = jest.requireActual('@/lib/permissions')
    const lista = req.headers['x-test-lista-propia']
    const puede =
      typeof lista === 'string' ? evaluatePermissionList(lista.split(',').filter(Boolean), perm) : hasPermission('CASHIER', null, perm)
    if (!puede) return res.status(403).json({ error: 'Forbidden', required: perm })
    next()
  },
  resolveUserRoleForVenue: jest.fn(),
  evaluateRolePermission: jest.fn(),
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  __esModule: true,
  checkFeatureAccess: () => (_req: any, _res: any, next: any) => next(),
}))
// «Por pagar» responde una marca: así se ve qué manejador contestó `GET …/to-pay` (el orden de las rutas).
jest.mock('@/services/online-ordering/folios.service', () => ({
  __esModule: true,
  listFolios: jest.fn(async () => ({ lista: 'por-pagar' })),
}))
jest.mock('@/services/online-ordering/presence.service', () => ({
  __esModule: true,
  touchInboxPoll: jest.fn(),
  touchToPayPoll: jest.fn(),
  getAcceptingStatus: jest.fn(async () => null),
  storeView: jest.fn(),
}))
jest.mock('@/services/online-ordering/cardAlertPresence', () => ({
  __esModule: true,
  CARD_ALERT_HEADER: 'x-online-orders-card-alert',
  touchCardAlertPoll: jest.fn(),
}))

import mobileRouter from '@/routes/mobile/onlineOrders.mobile.routes'
import tpvRouter from '@/routes/tpv/onlineOrders.tpv.routes'
import dashboardRouter from '@/routes/dashboard/onlineOrdering.dashboard.routes'
import * as panel from '@/controllers/dashboard/onlineOrdering.dashboard.controller'
import { touchToPayPoll } from '@/services/online-ordering/presence.service'
import { touchCardAlertPoll } from '@/services/online-ordering/cardAlertPresence'

const app = express()
app.use(express.json())
app.use('/m/venues/:venueId/online-orders', mobileRouter)
app.use('/t/venues/:venueId/online-orders', tpvRouter)
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ code: err.code, error: err.message }))

const CAMINOS = { POS: '/m/venues/v1/online-orders', TPV: '/t/venues/v1/online-orders' }
const D = (v: string) => new Prisma.Decimal(v)
/** Un pedido con tarjeta de «Nadie» ya cobrado que el cierre del día pasó a COMPLETED, con su comanda pendiente. */
const cerradoPorElDia = {
  id: 'oo1',
  status: 'COMPLETED',
  paymentMode: 'CARD_ONLINE',
  rejectReason: null,
  requiresAcceptance: false,
  channel: 'LINK',
  acceptDeadlineAt: new Date('2026-11-20T09:58:00.000Z'),
  estimatedReadyAt: new Date('2026-11-20T10:05:00.000Z'),
  printClaimedAt: null,
  printedAt: null,
  // D661 (Task 4): el corte del día lo deja «No lo recogió»; sólo ése sigue pidiendo su comanda (uno entregado por una persona, no).
  notPickedUpAt: new Date('2026-11-21T10:00:05.000Z'),
  refundRequestedAt: null,
  refundedAt: null,
  createdAt: new Date('2026-11-20T09:48:00.000Z'),
  charge: { status: 'CAPTURED', amount: D('250.50'), capturedAmount: D('250.50'), authorizedAt: null, capturedAt: null },
  order: {
    id: 'ord1',
    orderNumber: 'T-0042',
    total: D('250.50'),
    remainingBalance: D('0'),
    paymentStatus: 'PAID',
    customerName: 'Ana N.',
    customerPhone: null,
    specialRequests: 'Sin cebolla',
    items: [
      {
        productName: 'Flautas',
        productId: 'p1',
        product: { categoryId: 'cat1' },
        quantity: 2,
        notes: 'Bien doradas',
        unitPrice: D('125.25'),
        total: D('250.50'),
        modifiers: [{ name: 'Salsa verde', quantity: 1 }],
      },
    ],
    payments: [],
  },
}

beforeEach(() => {
  prismaMock.onlineOrder.findFirst.mockReset()
  prismaMock.onlineOrder.findFirst.mockResolvedValue(null)
})

describe('D661 (Ruling 14): la caja lee UN pedido por su propio camino', () => {
  it('POS y TPV: 200 con los renglones para imprimir de un pedido con tarjeta de «Nadie» que el cierre del día ya pasó a COMPLETED', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(cerradoPorElDia as any)
    for (const [caja, base] of Object.entries(CAMINOS)) {
      const r = await request(app).get(`${base}/ord1`)
      expect({ caja, status: r.status }).toEqual({ caja, status: 200 })
      expect(r.body.data).toMatchObject({
        orderId: 'ord1',
        orderNumber: 'T-0042',
        status: 'COMPLETED',
        needsPrint: true,
        note: 'Sin cebolla',
        items: [{ name: 'Flautas', quantity: 2, note: 'Bien doradas', modifiers: [{ name: 'Salsa verde', quantity: 1 }] }],
      })
    }
    // El lector del panel, acotado al negocio de la URL y a la cuenta pedida.
    for (const [args] of prismaMock.onlineOrder.findFirst.mock.calls as any[][]) {
      expect(args.where).toEqual({ venueId: 'v1', orderId: 'ord1' })
    }
    // Es una lectura: no late como caja viva ni como caja que avisa.
    expect(touchToPayPoll).not.toHaveBeenCalled()
    expect(touchCardAlertPoll).not.toHaveBeenCalled()
  })

  it('aislamiento: un pedido de OTRO negocio contesta lo mismo que «no existe» hoy (404, sin nada del otro negocio)', async () => {
    // Bajo `venueId: 'v1'` la cuenta de otro negocio no aparece: el lector contesta null.
    for (const [caja, base] of Object.entries(CAMINOS)) {
      const r = await request(app).get(`${base}/ordDeOtroNegocio`)
      expect({ caja, status: r.status, body: r.body }).toEqual({
        caja,
        status: 404,
        body: { error: 'Esta cuenta no es un pedido en línea.' },
      })
    }
    for (const [args] of prismaMock.onlineOrder.findFirst.mock.calls as any[][]) {
      expect(args.where).toEqual({ venueId: 'v1', orderId: 'ordDeOtroNegocio' })
    }
    // Y en la TPV, una URL de otro negocio ni siquiera llega al lector (la sesión es de v1).
    prismaMock.onlineOrder.findFirst.mockClear()
    expect((await request(app).get('/t/venues/vOtro/online-orders/ord1')).status).toBe(403)
    expect(prismaMock.onlineOrder.findFirst).not.toHaveBeenCalled()
  })

  it('sin orders:read → 403 y no se lee nada', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(cerradoPorElDia as any)
    for (const [caja, base] of Object.entries(CAMINOS)) {
      const r = await request(app).get(`${base}/ord1`).set('x-test-lista-propia', 'menu:read,inventory:log-waste') // sin orders:read
      expect({ caja, status: r.status, required: r.body.required }).toEqual({ caja, status: 403, required: 'orders:read' })
    }
    expect(prismaMock.onlineOrder.findFirst).not.toHaveBeenCalled()
  })

  it('el orden de las rutas: GET …/to-pay sigue contestando la lista en los dos caminos (nunca se lee «to-pay» como un pedido)', async () => {
    for (const [caja, base] of Object.entries(CAMINOS)) {
      const r = await request(app).get(`${base}/to-pay`)
      expect({ caja, status: r.status, data: r.body.data }).toEqual({ caja, status: 200, data: { lista: 'por-pagar', store: null } })
    }
    expect(prismaMock.onlineOrder.findFirst).not.toHaveBeenCalled()
    // La bandeja y el efectivo de plataformas del POS: `onlineOrdering.restaurant.routes.test.ts` (cada una con su esquema).
  })

  it('los tres caminos (POS, TPV y panel) usan UN solo manejador', () => {
    const manejador = (router: any, path: string) => {
      const capa = router.stack.find((l: any) => l.route?.path === path && l.route.methods.get)
      return capa.route.stack[capa.route.stack.length - 1].handle
    }
    expect(manejador(mobileRouter, '/:orderId')).toBe(panel.getOnlineOrderHandler)
    expect(manejador(tpvRouter, '/:orderId')).toBe(panel.getOnlineOrderHandler)
    expect(manejador(dashboardRouter, '/orders/:orderId')).toBe(panel.getOnlineOrderHandler)
  })
})
