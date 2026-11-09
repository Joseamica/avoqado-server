import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'
import { Prisma } from '@prisma/client'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    if (req.headers['x-test-auth-context']) req.authContext = JSON.parse(req.headers['x-test-auth-context'])
    next()
  },
}))
jest.mock('@/services/mobile/order.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/order.mobile.service'),
  payGiftCardBalanceOnOrder: jest.fn(),
  getGiftCardPaymentByKey: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardLookup.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardLookup.service'),
  lookupGiftCards: jest.fn(),
}))

import tpvRouter from '@/routes/tpv.routes'
import mobileRouter from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { validateVenueAccess } from '@/middlewares/validateVenueAccess.middleware'
import { giftCardLookupRateLimiters, giftCardPayFailureRateLimiters } from '@/middlewares/gift-card-lookup-rate-limit.middleware'
import { PAYMENT_OWNERSHIP_OVERRIDES } from '@/middlewares/checkTableOwnership.middleware'
import * as ctrl from '@/controllers/mobile/giftCard.mobile.controller'
import { payGiftCardBalanceOnOrder, getGiftCardPaymentByKey } from '@/services/mobile/order.mobile.service'
import { lookupGiftCards } from '@/services/giftCards/giftCardLookup.service'

const VENUE = 'cmn3acoxt000mn227k1vdgj95'
const ORDER = 'cmn3a6xr8000kn227eg8zeh41'
const auth = { userId: 'staff-1', venueId: VENUE, orgId: 'org-1', role: 'OWNER' }
const body = { idempotencyKey: 'saldo-prueba-0001', proof: { kind: 'CODE', code: 'K7QZ-ABCD-EFGH-JKMN-P' }, amount: 100 }
const base = `/tpv/venues/${VENUE}/gift-cards`
const app = express()
app.use(express.json())
app.use('/tpv', tpvRouter)
app.use('/mobile', mobileRouter)
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.statusCode ?? 500).json({ code: error.code, message: error.message })
})

const child = () => (tpvRouter as any).stack.find((l: any) => l.handle?.stack && l.regexp.test(`/venues/${VENUE}/gift-cards`))?.handle
const handlers = (path: string) =>
  child()
    ?.stack.find((l: any) => l.route?.path === path)
    ?.route.stack.map((l: any) => l.handle) ?? []
const headers = (ctx = auth) => ({ 'x-test-auth-context': JSON.stringify(ctx) })

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staff.findUnique.mockResolvedValue({ active: true } as never)
  prismaMock.staffVenue.findUnique.mockResolvedValue({ role: 'OWNER', active: true, permissionSetId: null } as never)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.venueSettings.findUnique.mockResolvedValue(null)
  ;(payGiftCardBalanceOnOrder as jest.Mock).mockResolvedValue({ paymentId: 'p1', amount: 100, tipAmount: 0, redeemed: [], replay: true })
  ;(getGiftCardPaymentByKey as jest.Mock).mockResolvedValue(null)
  ;(lookupGiftCards as jest.Mock).mockResolvedValue({ cards: [] })
})

describe('router TPV de saldo, montado en el router real', () => {
  it('conserva mergeParams, autentica y valida el venue del token antes de las tres rutas', () => {
    const router = child()
    expect(router).toBeDefined()
    expect(router.mergeParams).toBe(true)
    expect(router.stack.slice(0, 2).map((l: any) => l.handle)).toEqual([authenticateTokenMiddleware, validateVenueAccess])
  })

  it.each([
    ['/lookup', 'giftCards:read', ctrl.lookup],
    ['/orders/:orderId/pay', 'giftCards:redeem', ctrl.payWithBalance],
    ['/payments/:idempotencyKey', 'giftCards:redeem', ctrl.getPaymentByKey],
  ])('%s usa el permiso %s y el controller compartidos', (path, permission, controller) => {
    const h = handlers(path)
    expect(h.find((f: any) => f.requiredPermission)?.requiredPermission).toBe(permission)
    expect(h[h.length - 1]).toBe(controller)
  })

  it('usa las MISMAS instancias de límites de mobile y ownership de caja, en el mismo orden', () => {
    const pay = handlers('/orders/:orderId/pay')
    const permission = pay.findIndex((f: any) => f.requiredPermission === 'giftCards:redeem')
    expect(permission).toBeGreaterThan(-1)
    expect(pay.slice(permission + 1, permission + 1 + giftCardPayFailureRateLimiters.length)).toEqual(giftCardPayFailureRateLimiters)
    expect(pay.find((f: any) => f.ownershipOverridePermissions)?.ownershipOverridePermissions).toEqual(PAYMENT_OWNERSHIP_OVERRIDES)
    for (const limit of giftCardLookupRateLimiters) expect(handlers('/lookup')).toContain(limit)
    expect(giftCardPayFailureRateLimiters.some(l => handlers('/lookup').includes(l))).toBe(false)
  })

  it('lookup y recuperación llegan al controller sin aparato; el código está en el cuerpo', async () => {
    const lookup = await request(app).post(`${base}/lookup`).set(headers()).send({ code: body.proof.code })
    expect(lookup.status).toBe(200)
    expect(lookupGiftCards).toHaveBeenCalledWith(VENUE, { code: body.proof.code }, expect.objectContaining({ deviceId: undefined }))
    const found = await request(app).get(`${base}/payments/${body.idempotencyKey}`).set(headers())
    expect(found.status).toBe(200)
    expect(found.body).toEqual({ success: true, data: { found: false } })
  })

  it('pay reutiliza el controller, conserva pesos y normaliza X-Device-Id', async () => {
    const res = await request(app).post(`${base}/orders/${ORDER}/pay`).set(headers()).set('X-Device-Id', '  N86  ').send(body)
    expect(res.status).toBe(200)
    expect(payGiftCardBalanceOnOrder).toHaveBeenCalledWith(
      VENUE,
      ORDER,
      expect.objectContaining({
        deviceId: 'N86',
        staffId: auth.userId,
        amount: new Prisma.Decimal(100),
        tip: new Prisma.Decimal(0),
      }),
    )
  })

  it.each([undefined, '   '])(
    'pay con cuerpo válido y aparato %s da exactamente 400/GIFT_CARD_DEVICE_ID_REQUIRED sin cobrar',
    async device => {
      let req = request(app).post(`${base}/orders/${ORDER}/pay`).set(headers())
      if (device !== undefined) req = req.set('X-Device-Id', device)
      const res = await req.send(body)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('GIFT_CARD_DEVICE_ID_REQUIRED')
      expect(payGiftCardBalanceOnOrder).not.toHaveBeenCalled()
    },
  )

  it.each(['lookup', `orders/${ORDER}/pay`, `payments/${body.idempotencyKey}`])(
    'venue ajeno en %s da403 antes de cualquier servicio',
    async path => {
      const req = path.startsWith('payments/') ? request(app).get(`${base}/${path}`) : request(app).post(`${base}/${path}`).send(body)
      const res = await req.set(headers({ ...auth, venueId: 'otro-venue' })).set('X-Device-Id', 'N86')
      expect(res.status).toBe(403)
      expect(payGiftCardBalanceOnOrder).not.toHaveBeenCalled()
      expect(lookupGiftCards).not.toHaveBeenCalled()
      expect(getGiftCardPaymentByKey).not.toHaveBeenCalled()
    },
  )

  it('regresión: mobile CODE sin aparato conserva su contrato', async () => {
    const res = await request(app).post(`/mobile/venues/${VENUE}/orders/${ORDER}/pay-gift-card`).set(headers()).send(body)
    expect(res.status).toBe(200)
    expect(payGiftCardBalanceOnOrder).toHaveBeenCalledWith(VENUE, ORDER, expect.objectContaining({ deviceId: null }))
  })
})
