// R14 y R15 por ruta: qué permiso exige cada una, dónde va (y dónde NO) el candado de plan, y con qué esquema se valida.
import express from 'express'
import request from 'supertest'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  __esModule: true,
  authenticateTokenMiddleware: (_req: any, _res: any, next: any) => next(),
}))
// Registra QUÉ esquema validó cada ruta (el objeto real de `@/schemas/online-ordering.schema`), sin validar nada.
jest.mock('@/middlewares/validation', () => ({
  __esModule: true,
  validateRequest: (schema: unknown) => (req: any, _res: any, next: any) => {
    req.schemas = [...(req.schemas ?? []), schema]
    next()
  },
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
  const respond = (req: any, res: any) => {
    const schemas = jest.requireActual('@/schemas/online-ordering.schema')
    const nombre = (s: unknown) => Object.keys(schemas).find(k => schemas[k] === s) ?? 'DESCONOCIDO'
    res.json({ perms: req.perms ?? [], plans: req.plans ?? [], schemas: (req.schemas ?? []).map(nombre) })
  }
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
  const respond = (req: any, res: any) => {
    const schemas = jest.requireActual('@/schemas/online-ordering.schema')
    const nombre = (s: unknown) => Object.keys(schemas).find(k => schemas[k] === s) ?? 'DESCONOCIDO'
    res.json({ perms: req.perms ?? [], plans: req.plans ?? [], schemas: (req.schemas ?? []).map(nombre) })
  }
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

describe('API del restaurante: permiso, candado de plan y esquema por ruta', () => {
  it('cancelar exige orders:cancel-unpaid en las apps (R15)', async () => {
    const r = await request(app).post(`${M}/ord1/cancel`)
    expect(r.body).toEqual({ perms: ['orders:cancel-unpaid'], plans: [], schemas: ['orderActionSchema'] })
  })

  it('aceptar, rechazar, listo, entregado e imprimir usan orders:update, sin candado de plan, cada una con su esquema', async () => {
    const casos: Array<[string, string]> = [
      ['ord1/accept', 'acceptSchema'],
      ['ord1/reject', 'rejectSchema'],
      ['ord1/ready', 'orderActionSchema'],
      ['ord1/delivered', 'orderActionSchema'],
      ['ord1/print/claim', 'orderActionSchema'],
      ['ord1/print/confirm', 'orderActionSchema'],
    ]
    for (const [path, schema] of casos) {
      const r = await request(app).post(`${M}/${path}`)
      expect({ path, ...r.body }).toEqual({ path, perms: ['orders:update'], plans: [], schemas: [schema] })
    }
  })

  it('pausar desde el piso exige su propio permiso online-orders:pause (founder, 16-oct), sin candado de plan', async () => {
    const r = await request(app).post(`${M}/pause`)
    expect(r.body).toEqual({ perms: ['online-orders:pause'], plans: [], schemas: ['pauseSchema'] })
  })

  it('la bandeja usa orders:read sin candado de plan: perder el plan no deja varados los pedidos (R14)', async () => {
    const r = await request(app).get(`${M}/inbox`)
    expect(r.body).toEqual({ perms: ['orders:read'], plans: [], schemas: ['inboxSchema'] })
  })

  it('PUT /settings exige online-orders:manage y el plan', async () => {
    const r = await request(app).put(`${P}/settings`)
    expect(r.body).toEqual({ perms: ['online-orders:manage'], plans: ['ONLINE_ORDERING'], schemas: ['settingsPatchSchema'] })
  })

  it('PUT /menu/availability exige online-orders:manage y el plan', async () => {
    const r = await request(app).put(`${P}/menu/availability`)
    expect(r.body).toEqual({ perms: ['online-orders:manage'], plans: ['ONLINE_ORDERING'], schemas: ['menuAvailabilitySchema'] })
  })

  it('GET /settings exige online-orders:manage sin candado de plan', async () => {
    const r = await request(app).get(`${P}/settings`)
    expect(r.body).toEqual({ perms: ['online-orders:manage'], plans: [], schemas: ['settingsGetSchema'] })
  })

  it('en el panel: bandeja y transiciones con su permiso y su esquema, cancelar con orders:cancel-unpaid; ninguna con plan', async () => {
    const casos: Array<['get' | 'post', string, string, string]> = [
      ['get', 'orders', 'orders:read', 'inboxSchema'],
      ['post', 'orders/ord1/accept', 'orders:update', 'acceptSchema'],
      ['post', 'orders/ord1/reject', 'orders:update', 'rejectSchema'],
      ['post', 'orders/ord1/ready', 'orders:update', 'orderActionSchema'],
      ['post', 'orders/ord1/delivered', 'orders:update', 'orderActionSchema'],
      ['post', 'orders/ord1/cancel', 'orders:cancel-unpaid', 'orderActionSchema'],
    ]
    for (const [method, path, perm, schema] of casos) {
      const r = await request(app)[method](`${P}/${path}`)
      expect({ path, ...r.body }).toEqual({ path, perms: [perm], plans: [], schemas: [schema] })
    }
  })

  it('no existe «soltar la impresión» (R20)', async () => {
    expect((await request(app).post(`${M}/ord1/print/release`)).status).toBe(404)
  })
})
