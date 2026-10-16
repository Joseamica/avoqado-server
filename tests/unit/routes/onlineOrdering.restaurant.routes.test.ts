// R14 y R15 por ruta: qué permiso exige cada una y dónde va (y dónde NO) el candado de plan.
import express from 'express'
import request from 'supertest'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  __esModule: true,
  authenticateTokenMiddleware: (_req: any, _res: any, next: any) => next(),
}))
jest.mock('@/middlewares/validation', () => ({
  __esModule: true,
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  __esModule: true,
  checkPermission: (perm: string) => (req: any, _res: any, next: any) => {
    req.perms = [...(req.perms ?? []), perm]
    next()
  },
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  __esModule: true,
  checkFeatureAccess: (code: string) => (req: any, _res: any, next: any) => {
    req.plans = [...(req.plans ?? []), code]
    next()
  },
}))
jest.mock('@/controllers/mobile/onlineOrders.mobile.controller', () => {
  const respond = (req: any, res: any) => res.json({ perms: req.perms ?? [], plans: req.plans ?? [] })
  return {
    __esModule: true,
    inbox: respond,
    accept: respond,
    reject: respond,
    ready: respond,
    delivered: respond,
    cancel: respond,
    printClaim: respond,
    printConfirm: respond,
    pause: respond,
  }
})
jest.mock('@/controllers/dashboard/onlineOrdering.dashboard.controller', () => {
  const respond = (req: any, res: any) => res.json({ perms: req.perms ?? [], plans: req.plans ?? [] })
  return { __esModule: true, getSettingsHandler: respond, updateSettingsHandler: respond, setMenuAvailabilityHandler: respond }
})

import mobileRouter from '@/routes/mobile/onlineOrders.mobile.routes'
import dashboardRouter from '@/routes/dashboard/onlineOrdering.dashboard.routes'

const app = express()
app.use(express.json())
app.use('/m/venues/:venueId/online-orders', mobileRouter)
app.use('/d/venues/:venueId/online-ordering', dashboardRouter)

const M = '/m/venues/v1/online-orders'
const P = '/d/venues/v1/online-ordering'

describe('API del restaurante: permiso por ruta y candado de plan sólo en lo que configura', () => {
  it('cancelar exige orders:cancel-unpaid en las apps (R15)', async () => {
    const r = await request(app).post(`${M}/ord1/cancel`)
    expect(r.body).toEqual({ perms: ['orders:cancel-unpaid'], plans: [] })
  })

  it('aceptar, rechazar, listo, entregado, imprimir y pausar usan orders:update, sin candado de plan', async () => {
    for (const path of ['ord1/accept', 'ord1/reject', 'ord1/ready', 'ord1/delivered', 'ord1/print/claim', 'ord1/print/confirm', 'pause']) {
      const r = await request(app).post(`${M}/${path}`)
      expect({ path, ...r.body }).toEqual({ path, perms: ['orders:update'], plans: [] })
    }
  })

  it('la bandeja usa orders:read sin candado de plan: perder el plan no deja varados los pedidos (R14)', async () => {
    const r = await request(app).get(`${M}/inbox`)
    expect(r.body).toEqual({ perms: ['orders:read'], plans: [] })
  })

  it('PUT /settings exige online-orders:manage y el plan', async () => {
    const r = await request(app).put(`${P}/settings`)
    expect(r.body).toEqual({ perms: ['online-orders:manage'], plans: ['ONLINE_ORDERING'] })
  })

  it('PUT /menu/availability exige online-orders:manage y el plan', async () => {
    const r = await request(app).put(`${P}/menu/availability`)
    expect(r.body).toEqual({ perms: ['online-orders:manage'], plans: ['ONLINE_ORDERING'] })
  })

  it('GET /settings exige online-orders:manage sin candado de plan', async () => {
    const r = await request(app).get(`${P}/settings`)
    expect(r.body).toEqual({ perms: ['online-orders:manage'], plans: [] })
  })

  it('en el panel: bandeja y aceptar con su permiso, cancelar con orders:cancel-unpaid; ninguno con plan', async () => {
    expect((await request(app).get(`${P}/orders`)).body).toEqual({ perms: ['orders:read'], plans: [] })
    expect((await request(app).post(`${P}/orders/ord1/accept`)).body).toEqual({ perms: ['orders:update'], plans: [] })
    expect((await request(app).post(`${P}/orders/ord1/cancel`)).body).toEqual({ perms: ['orders:cancel-unpaid'], plans: [] })
  })

  it('no existe «soltar la impresión» (R20)', async () => {
    expect((await request(app).post(`${M}/ord1/print/release`)).status).toBe(404)
  })
})
