/**
 * D661 · tarea 2: pedir con tarjeta en «Nadie» por la ruta REAL (esquema → controlador → borrador), con `getAcceptingStatus`, el folio
 * para pagar en caja y `/info` también reales sobre una base en memoria: los topes cuentan FILAS con el filtro de verdad.
 */
import express from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { contar, cumpleWhere } from '@tests/__helpers__/baseEnMemoria'

jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: () => (_req: any, _res: any, next: any) => next(),
  rateLimit: () => (_req: any, _res: any, next: any) => next(),
}))
const ponerNegocio = (req: any, _res: any, next: any) => {
  req.publicVenue = { id: 'v1', slug: req.params.venueSlug }
  next()
}
jest.mock('@/middlewares/resolveOperationalVenueBySlug.middleware', () => ({
  __esModule: true,
  resolveOperationalVenueBySlug: (req: any, res: any, next: any) => ponerNegocio(req, res, next),
  assertOperationalVenue: async () => {},
}))
jest.mock('@/middlewares/resolveVenueBySlug.middleware', () => ({
  __esModule: true,
  resolveVenueBySlug: (req: any, res: any, next: any) => ponerNegocio(req, res, next),
  resolveVenueBySlugIncludingInactive: (req: any, res: any, next: any) => ponerNegocio(req, res, next),
}))
jest.mock('@/middlewares/requirePublicVenueFeatureStrict.middleware', () => ({
  __esModule: true,
  ORDERING_UNAVAILABLE_MESSAGE: 'Pedidos no disponibles',
  requirePublicVenueFeatureStrict: () => (_req: any, _res: any, next: any) => next(),
  assertOrderingPlan: async () => {},
}))
jest.mock('@/middlewares/customerAuth.middleware', () => ({
  __esModule: true,
  ...jest.requireActual('@/middlewares/customerAuth.middleware'),
  // Una sesión por clienta (`x-test-clienta`), probada por correo: `clientaDeLaSesion` la reconoce y no trae teléfono.
  authenticateOrderingCustomerOptional: (req: any, _res: any, next: any) => {
    const id = req.headers['x-test-clienta']
    req.customerAuth = id
      ? {
          customerId: id,
          venueId: 'v1',
          tipo: 'SESION',
          contactos: [{ tipo: 'EMAIL', valor: `${id}@test.com`, metodo: 'EMAIL_CODE', probadoEn: 1 }],
          accountActivatedAt: null,
        }
      : null
    next()
  },
}))
jest.mock('@/services/online-ordering/quote.service', () => ({
  __esModule: true,
  quoteCart: jest.fn(),
  toPublicQuote: jest.fn((q: any) => q),
}))
jest.mock('@/services/online-ordering/beneficios.service', () => ({
  __esModule: true,
  BENEFIT_UNAVAILABLE: 'BENEFIT_UNAVAILABLE',
  simularBeneficios: jest.fn(),
  cedeLaSimulacion: jest.fn(() => false),
  aplicarBeneficiosEnTx: jest.fn(),
  cotizarConBeneficios: jest.fn(),
}))
jest.mock('@/services/online-ordering/folios.service', () => ({
  __esModule: true,
  prepararCierreEnCero: jest.fn(),
  cerrarFolioEnCeroEnTx: jest.fn(),
  trasCerrarFolioEnCero: jest.fn(),
}))
jest.mock('@/services/online-ordering/cuentaConBeneficios', () => ({ __esModule: true, cuentaConBeneficios: jest.fn(async () => false) }))
jest.mock('@/services/online-ordering/menu.service', () => ({ __esModule: true, getPublicMenu: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({ __esModule: true, socketManager: { broadcastToVenue: jest.fn() } }))
jest.mock('@/services/superadmin/platformSettings.service', () => ({ __esModule: true, getVatRateBps: jest.fn(async () => 1600) }))
const createAuthorizationCheckout = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: jest.fn(() => ({ createAuthorizationCheckout })),
}))

import router from '@/routes/public/onlineOrdering.public.routes'
import { quoteCart } from '@/services/online-ordering/quote.service'
import { simularBeneficios } from '@/services/online-ordering/beneficios.service'

const app = express()
app.use(express.json())
app.use('/venues/:venueSlug/ordering', router)

const D = (v: string) => new Prisma.Decimal(v)
const QUOTE_OK = {
  ok: true,
  issues: [],
  subtotal: D('250.00'),
  total: D('250.00'),
  minOrderAmount: D('0'),
  lines: [
    {
      productId: 'p1',
      productName: 'Flautas',
      productSku: 'FLA-1',
      categoryName: 'Flautas',
      quantity: 1,
      unitPrice: D('250.00'),
      modifiers: [],
      note: null,
      lineTotal: D('250.00'),
    },
  ],
}
const MERCHANT = {
  id: 'em1',
  active: true,
  chargesEnabled: true,
  platformFeeBps: 100,
  sandboxMode: true,
  providerCredentials: { connectAccountId: 'acct_123' },
  provider: { code: 'STRIPE_CONNECT' },
}
const hace = (ms: number) => new Date(Date.now() - ms)
/** La fila de ajustes: «Nadie» con su interruptor, la caja que cobra folios y la que avisa tarjetas, hace 30 s. */
const ajustes = (o: Record<string, unknown> = {}) => ({
  venueId: 'v1',
  enabled: true,
  requiresAcceptance: false,
  acceptsPayAtPickup: true,
  acceptsCardOnline: false,
  cardOnlineNadie: true,
  manualPause: false,
  pausedUntil: null,
  minOrderAmount: 0,
  defaultPrepMinutes: 15,
  hours: null,
  lastToPayPollAt: hace(30_000),
  lastInboxPollAt: hace(30_000),
  lastCardAlertPollAt: hace(30_000),
  ...o,
})

let n = 0
const llave = () => `${String(++n).padStart(4, '0')}${'k'.repeat(32)}`
const pedido = (o: { clienta?: string; paymentMode?: string; customer?: Record<string, unknown> } = {}) => {
  let r = request(app).post('/venues/flautas/ordering/orders').set('Idempotency-Key', llave())
  if (o.clienta) r = r.set('x-test-clienta', o.clienta)
  return r.send({
    items: [{ productId: 'p1', quantity: 1 }],
    paymentMode: o.paymentMode ?? 'CARD_ONLINE',
    expectedTotal: '250.00',
    customer: o.customer ?? { name: 'María G.' },
  })
}
const info = () => request(app).get('/venues/flautas/ordering/info')

let cargos: any[]
let pedidos: any[]
const borradorNadie = (clienta: string) => ({
  venueId: 'v1',
  status: 'PENDING_AUTH',
  customerPhone: '',
  checkoutExpiresAt: new Date(Date.now() + 30 * 60_000),
  request: { nadie: true, customerId: clienta },
})
const apartadoNadie = (clienta: string) => ({
  venueId: 'v1',
  status: 'PENDING_ACCEPTANCE',
  requiresAcceptance: false,
  paymentMode: 'CARD_ONLINE',
  order: { customerId: clienta, paymentStatus: 'PENDING' },
})

beforeEach(() => {
  n = 0
  cargos = []
  pedidos = []
  process.env.ORDERING_STOREFRONT_BASE_URL = 'https://pedidos.test'
  ;(quoteCart as jest.Mock).mockResolvedValue(QUOTE_OK)
  ;(simularBeneficios as jest.Mock).mockResolvedValue({ total: D('250.00'), aplicados: [], descartados: [] })
  createAuthorizationCheckout.mockImplementation(async (_m: unknown, p: { metadata: { chargeId: string } }) => ({
    id: `cs_${p.metadata.chargeId}`,
    url: `https://checkout.stripe.test/${p.metadata.chargeId}`,
  }))
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(ajustes() as any)
  prismaMock.venue.findUnique.mockResolvedValue({ name: 'Flautas', timezone: 'America/Mexico_City', currency: 'MXN' } as any)
  prismaMock.ecommerceMerchant.findMany.mockResolvedValue([MERCHANT] as any)
  prismaMock.idempotencyRequest = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) }
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.findFirst.mockResolvedValue(null)
  prismaMock.order.create.mockImplementation((async () => ({ id: `ord${pedidos.length + 1}` })) as any)
  prismaMock.onlineOrder.create.mockImplementation((async ({ data }: any) => {
    const fila = { id: `oo${pedidos.length + 1}`, ...data, order: { customerId: null, paymentStatus: 'PENDING' } }
    pedidos.push(fila)
    return fila
  }) as any)
  prismaMock.onlineOrder.count.mockImplementation(contar(pedidos) as any)
  prismaMock.onlineOrderCharge.count.mockImplementation(contar(cargos) as any)
  prismaMock.onlineOrderCharge.create.mockImplementation((async ({ data }: any) => {
    const fila = {
      id: `ch${cargos.length + 1}`,
      status: 'PENDING_AUTH',
      checkoutAttempt: 1,
      checkoutSessionId: null,
      checkoutUrl: null,
      ...data,
    }
    cargos.push(fila)
    return { ...fila }
  }) as any)
  prismaMock.onlineOrderCharge.findUnique.mockImplementation((async ({ where }: any) => {
    const k = where.venueId_idempotencyKey
    const fila = cargos.find(c => (k ? c.venueId === k.venueId && c.idempotencyKey === k.idempotencyKey : c.id === where.id))
    return fila ? { ...fila } : null
  }) as any)
  prismaMock.onlineOrderCharge.updateMany.mockImplementation((async ({ where, data }: any) => {
    const filas = cargos.filter(c => cumpleWhere(c, where))
    filas.forEach(c => Object.assign(c, data))
    return { count: filas.length }
  }) as any)
})

describe('D661 · pedir con tarjeta en «Nadie» por HTTP', () => {
  it('HTTP: cuatro clientas distintas sin número crean su borrador cada una', async () => {
    for (const clienta of ['cust1', 'cust2', 'cust3', 'cust4']) {
      const r = await pedido({ clienta })
      expect(r.status).toBe(201)
      expect(r.body.data).toMatchObject({
        status: 'AWAITING_PAYMENT',
        replay: false,
        checkoutUrl: expect.stringContaining('checkout.stripe.test'),
      })
    }
    expect(cargos).toHaveLength(4)
    expect(cargos.map(c => c.request.customerId)).toEqual(['cust1', 'cust2', 'cust3', 'cust4'])
    expect(cargos.every(c => c.request.nadie === true && c.customerPhone === '')).toBe(true)
  })

  it('HTTP: sin sesión en «Nadie» es 401 PHONE_VERIFICATION_REQUIRED y no se crea nada', async () => {
    const r = await pedido()
    expect(r.status).toBe(401)
    expect(r.body).toMatchObject({ success: false, code: 'PHONE_VERIFICATION_REQUIRED' })
    expect(cargos).toHaveLength(0)
  })

  it('HTTP: «Mi equipo» con tarjeta y sin teléfono sigue en 400 «Escribe tu teléfono» (la regla pasó del esquema al servicio)', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(ajustes({ requiresAcceptance: true, acceptsCardOnline: true }) as any)
    const r = await pedido()
    expect(r.status).toBe(400)
    expect(r.body.error ?? r.text).toMatch(/Escribe tu teléfono/)
    expect(cargos).toHaveLength(0)
  })

  it('r6 #6: con el cupo de tarjeta de «Nadie» lleno (borradores y apartados) la tarjeta se frena, pero /info sigue OPEN y el folio para pagar en caja se crea; igual tras cambiar de modo, y «Mi equipo» conserva su saturación', async () => {
    const tarjetaFrenadaYCajaAbierta = async () => {
      const tarjeta = await pedido({ clienta: 'nueva' })
      expect(tarjeta.status).toBe(409)
      expect(tarjeta.body.code).toBe('CARD_ONLINE_QUEUE_FULL')
      const i = await info()
      expect(i.status).toBe(200)
      expect(i.body.data).toMatchObject({ status: 'OPEN', reason: null })
      const folio = await pedido({ paymentMode: 'PAY_AT_PICKUP' })
      expect(folio.status).toBe(201)
      expect(folio.body.data).toMatchObject({ status: 'PENDING_ACCEPTANCE', replay: false })
    }

    // 30 borradores vivos de «Nadie»: antes, la tienda entera se pausaba (TOO_BUSY) y el folio se rechazaba.
    for (let i = 0; i < 30; i++) cargos.push(borradorNadie(`c${i}`))
    await tarjetaFrenadaYCajaAbierta()

    // La mezcla: 12 de esos borradores ya se apartaron (sin abrir).
    cargos.splice(0, 12)
    for (let i = 0; i < 12; i++) pedidos.push(apartadoNadie(`a${i}`))
    await tarjetaFrenadaYCajaAbierta()

    // El negocio pasa a «Mi equipo»: lo de «Nadie» no lo satura; su tarjeta (con teléfono) entra.
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(ajustes({ requiresAcceptance: true, acceptsCardOnline: true }) as any)
    expect((await info()).body.data).toMatchObject({ status: 'OPEN' })
    expect((await pedido({ customer: { name: 'Ana', phone: '55 4345 3965' } })).status).toBe(201)
    // Su propia regla sigue: 30 por aceptar de «Mi equipo» la pausan.
    const deMiEquipo = Array.from({ length: 30 }, () => ({ venueId: 'v1', status: 'PENDING_ACCEPTANCE', requiresAcceptance: true }))
    pedidos.push(...deMiEquipo)
    expect((await info()).body.data).toMatchObject({ status: 'PAUSED', reason: 'TOO_BUSY' })
    pedidos.splice(pedidos.length - deMiEquipo.length)

    // De vuelta a «Nadie»: el cupo de tarjeta sigue lleno y pagar en caja sigue abierto.
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(ajustes() as any)
    await tarjetaFrenadaYCajaAbierta()
  })
})
