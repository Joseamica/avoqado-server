// R14 y R15 por ruta: qué permiso exige cada una, dónde va (y dónde NO) el candado de plan, y con qué esquema se valida.
import express from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

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

/**
 * 1b: lo que el panel LEE y lo que exige para encender, con el controlador y los servicios REALES (Prisma simulado). El manejador
 * de errores de abajo replica la forma del global de `app.ts` para un `AppError`: `{ message, code, details }`.
 */
describe('panel: GET y PUT /settings (controlador real)', () => {
  const real = jest.requireActual('@/controllers/dashboard/onlineOrdering.dashboard.controller')
  const panel = express()
  panel.use(express.json())
  panel.get('/venues/:venueId/settings', real.getSettingsHandler)
  panel.put('/venues/:venueId/settings', real.updateSettingsHandler)
  panel.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err.statusCode ?? 500).json({ message: err.message, code: err.code, details: err.details }),
  )

  const NOW = Date.now()
  const fila = (o: Record<string, unknown> = {}) => ({
    id: 'set1',
    venueId: 'v1',
    enabled: true,
    minOrderAmount: new Prisma.Decimal('0'),
    defaultPrepMinutes: 15,
    acceptsPayAtPickup: true,
    manualPause: false,
    pausedUntil: null,
    hours: null,
    lastInboxPollAt: new Date(NOW - 10_000),
    ...o,
  })
  const VENUE = {
    timezone: 'America/Mexico_City',
    name: 'Flautas',
    address: 'Av. Coyoacán 123',
    city: 'CDMX',
    state: 'CDMX',
    zipCode: '04000',
    phone: '5512345678',
    email: null,
  }
  const AVISO = { id: 'pnv1', content: 'Aviso', contentHash: 'h', language: 'es', createdAt: new Date() }

  beforeEach(() => {
    prismaMock.venue.findUnique.mockResolvedValue(VENUE as any)
    prismaMock.privacyNoticeVersion.findFirst.mockResolvedValue(AVISO as any)
    prismaMock.onlineOrder.count.mockResolvedValue(0)
  })

  it('GET trae el estado de la tienda (mismo cálculo que /info) con sus pausas, y los requisitos; lee los ajustes UNA vez', async () => {
    const hasta = new Date(NOW + 15 * 60_000)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(fila({ pausedUntil: hasta }) as any)
    prismaMock.privacyNoticeVersion.findFirst.mockResolvedValue(null)

    const r = await request(panel).get('/venues/v1/settings')

    expect(r.status).toBe(200)
    expect(r.body.data.store).toEqual({ status: 'PAUSED', reason: 'MANUAL_PAUSE', pausedUntil: hasta.toISOString(), manualPause: false })
    expect(r.body.data.requirements).toEqual({ address: true, phone: true, privacyNotice: false })
    // Lo de antes sigue (campos aditivos).
    expect(r.body.data).toMatchObject({ enabled: true, minOrderAmount: 0, lastInboxPollAt: new Date(NOW - 10_000).toISOString() })
    expect(prismaMock.onlineOrderingSettings.findUnique).toHaveBeenCalledTimes(1)
  })

  it('GET de una tienda abierta: OPEN sin motivo, sin pausa', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(fila() as any)
    const r = await request(panel).get('/venues/v1/settings')
    expect(r.body.data.store).toEqual({ status: 'OPEN', reason: null, pausedUntil: null, manualPause: false })
    expect(r.body.data.requirements).toEqual({ address: true, phone: true, privacyNotice: true })
  })

  it('PUT {enabled:true} a una tienda APAGADA sin teléfono: 400 STORE_REQUIREMENTS_MISSING con missing:[phone], y no guarda nada', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ ...VENUE, phone: null } as any)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(fila({ enabled: false }) as any)
    const r = await request(panel).put('/venues/v1/settings').send({ enabled: true })
    expect(r.status).toBe(400)
    expect(r.body).toEqual({
      message: 'Para encender la tienda falta el teléfono del negocio.',
      code: 'STORE_REQUIREMENTS_MISSING',
      details: { missing: ['phone'] },
    })
    expect(prismaMock.onlineOrderingSettings.upsert).not.toHaveBeenCalled()
  })

  it('ronda 1: PUT {enabled:true, minOrderAmount:60} a una tienda YA encendida, aunque falte un requisito: 200', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ ...VENUE, phone: null } as any)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(fila() as any)
    prismaMock.onlineOrderingSettings.upsert.mockResolvedValue(fila({ minOrderAmount: new Prisma.Decimal('60') }) as any)
    const r = await request(panel).put('/venues/v1/settings').send({ enabled: true, minOrderAmount: 60 })
    expect(r.status).toBe(200)
    expect(r.body.data.minOrderAmount).toBe(60)
  })

  it('PUT {enabled:true} con todo: 200', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(fila({ enabled: false }) as any)
    prismaMock.onlineOrderingSettings.upsert.mockResolvedValue(fila() as any)
    const r = await request(panel).put('/venues/v1/settings').send({ enabled: true })
    expect(r.status).toBe(200)
    expect(r.body.data.enabled).toBe(true)
  })

  it('PUT {minOrderAmount: 50} y PUT {enabled:false} sin requisitos: 200', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ ...VENUE, address: null, city: null, state: null, zipCode: null, phone: null } as any)
    prismaMock.privacyNoticeVersion.findFirst.mockResolvedValue(null)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(fila() as any)
    prismaMock.onlineOrderingSettings.upsert.mockResolvedValue(fila() as any)
    expect((await request(panel).put('/venues/v1/settings').send({ minOrderAmount: 50 })).status).toBe(200)
    expect((await request(panel).put('/venues/v1/settings').send({ enabled: false })).status).toBe(200)
  })
})
