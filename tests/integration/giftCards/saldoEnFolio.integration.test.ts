/** S12: rutas, servicios y libreta reales; sólo autenticación de ensayo y proveedores externos simulados. */
import '../../__helpers__/integration-setup'
import 'express-async-errors'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { decryptGiftCardCode, generateGiftCardCode } from '@/services/giftCards/giftCardCode'
import { crearNegocioDePrueba, limpiarNegocioDePrueba, sembrarVentaDeTarjetas } from './sembrarTarjetasDeRegalo'
import { abrirTurno } from '../dashboard/sembrarCobroParaReembolso'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    if (req.headers['x-test-auth-context']) req.authContext = JSON.parse(req.headers['x-test-auth-context'])
    next()
  },
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/online-ordering/notifications.service', () => ({ notifyOrderEvent: jest.fn() }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(),
}))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import tpvRouter from '@/routes/tpv.routes'
import mobileRouter from '@/routes/mobile.routes'

let organizationId: string
let venueId: string
let staffId: string
const app = express()
app.use(express.json())
app.use('/tpv', tpvRouter)
app.use('/mobile', mobileRouter)
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.statusCode ?? 500).json({ code: error.code, message: error.message })
})

const auth = () => ({ 'x-test-auth-context': JSON.stringify({ venueId, userId: staffId, orgId: organizationId, role: 'CASHIER' }) })
const payPath = (channel: 'tpv' | 'mobile', orderId: string) =>
  channel === 'tpv'
    ? `/tpv/venues/${venueId}/gift-cards/orders/${orderId}/pay`
    : `/mobile/venues/${venueId}/orders/${orderId}/pay-gift-card`

beforeAll(async () => {
  ;({ organizationId, venueId, staffId } = await crearNegocioDePrueba('saldo-folio-tpv'))
  await abrirTurno(venueId, staffId)
  await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [100] } })
  await prisma.loyaltyConfig.create({
    data: {
      venueId,
      active: true,
      pointsPerDollar: 0,
      stampsEnabled: true,
      stampsRequired: 100,
      maxStampsPerDay: 1,
    },
  })
})
afterAll(async () => {
  if (!venueId) return
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await limpiarNegocioDePrueba(venueId)
  await prisma.shift.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.$disconnect()
})

async function folioConTarjeta() {
  const customer = await prisma.customer.create({ data: { venueId, firstName: 'Lucía S12' } })
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: cuid(),
      source: 'WEB',
      type: 'PICKUP',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      customerId: customer.id,
      subtotal: 134,
      taxAmount: 0,
      total: 134,
      remainingBalance: 134,
      createdById: staffId,
      items: { create: { productName: 'Playera', quantity: 1, unitPrice: 134, taxAmount: 0, total: 134 } },
      orderCustomers: { create: { customerId: customer.id, isPrimary: true } },
    },
  })
  const online = await prisma.onlineOrder.create({
    data: {
      venueId,
      orderId: order.id,
      trackingToken: cuid(),
      paymentMode: 'PAY_AT_PICKUP',
      requiresAcceptance: false,
      status: 'PENDING_ACCEPTANCE',
      acceptDeadlineAt: new Date(Date.now() + 30 * 60000),
    },
  })
  const sale = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [100], metodo: 'CASH' })
  const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: sale.giftCardIds[0] } })
  return { orderId: order.id, onlineId: online.id, customerId: customer.id, cardId: card.id, code: decryptGiftCardCode(card.codeEnc) }
}

describe('saldo dentro del folio · Postgres real', () => {
  it.each(['tpv', 'mobile'] as const)(
    '%s:134=100saldo+34efectivo; primer PAID marca, Por entregar y un sello, replay no consume otra vez',
    async channel => {
      const s = await folioConTarjeta()
      const key = cuid()
      const body = { idempotencyKey: key, proof: { kind: 'CODE', code: s.code }, amount: 100 }
      let payment = request(app).post(payPath(channel, s.orderId)).set(auth())
      if (channel === 'tpv') payment = payment.set('X-Device-Id', 'N86-S12')
      const partial = await payment.send(body)
      expect(partial.status).toBe(200)
      expect(partial.body.data).toMatchObject({
        amount: 100,
        tipAmount: 0,
        orderPaymentStatus: 'PARTIAL',
        orderRemaining: 34,
        replay: false,
      })
      const beforeCash = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })
      expect(beforeCash).toMatchObject({ paymentStatus: 'PARTIAL', loyaltyEligibleAt: null })
      expect(await prisma.stampEvent.count({ where: { venueId, orderId: s.orderId, type: 'EARN' } })).toBe(0)
      const cash = await payCashOrder(venueId, s.orderId, { amount: 3400, tip: 0, staffId, idempotencyKey: cuid() })
      expect(cash.status).toBe('COMPLETED')
      const paid = await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })
      expect(paid.paymentStatus).toBe('PAID')
      expect(paid.loyaltyEligibleAt).toBeInstanceOf(Date)
      expect(paid.loyaltyStaffId).toBe(staffId)
      // La lista real de la caja sincroniza los folios pagados antes de enseñar «Por entregar».
      const folios = await request(app).get(`/tpv/venues/${venueId}/online-orders/to-pay?section=toDeliver`).set(auth())
      expect(folios.status).toBe(200)
      expect((await prisma.onlineOrder.findUniqueOrThrow({ where: { id: s.onlineId } })).status).toBe('ACCEPTED')
      const money = await prisma.payment.aggregate({
        where: { venueId, orderId: s.orderId, status: 'COMPLETED' },
        _sum: { amount: true },
        _count: true,
      })
      expect(money._sum.amount?.toFixed(2)).toBe('134.00')
      expect(money._count).toBe(2)
      expect(await prisma.stampEvent.count({ where: { venueId, orderId: s.orderId, type: 'EARN' } })).toBe(1)
      let retry = request(app).post(payPath(channel, s.orderId)).set(auth())
      if (channel === 'tpv') retry = retry.set('X-Device-Id', 'N86-S12')
      const replay = await retry.send(body)
      expect(replay.status).toBe(200)
      expect(replay.body.data).toMatchObject({ paymentId: partial.body.data.paymentId, amount: 100, replay: true })
      const recovery = await request(app).get(`/tpv/venues/${venueId}/gift-cards/payments/${key}`).set(auth())
      expect(recovery.status).toBe(200)
      expect(recovery.body.data).toMatchObject({ found: true, payment: { paymentId: partial.body.data.paymentId, amount: 100 } })
      const entries = await prisma.giftCardActivity.findMany({
        where: { venueId, giftCardId: s.cardId },
        orderBy: { createdAt: 'asc' },
        take: 10,
      })
      expect(entries.map(e => [e.type, e.amount.toFixed(2), e.balanceAfter.toFixed(2)])).toEqual([
        ['ACTIVATE', '100.00', '100.00'],
        ['REDEEM', '100.00', '0.00'],
      ])
      expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: s.cardId } })).balance.toFixed(2)).toBe('0.00')
      expect(await prisma.payment.count({ where: { venueId, idempotencyKey: key } })).toBe(1)
      expect(await prisma.stampEvent.count({ where: { venueId, orderId: s.orderId, type: 'EARN' } })).toBe(1)
      expect((await prisma.order.findUniqueOrThrow({ where: { id: s.orderId } })).loyaltyEligibleAt).toEqual(paid.loyaltyEligibleAt)
    },
  )

  it('lookup TPV permite aparato ausente; pay sin aparato da400exacto sin Payment/REDEEM', async () => {
    const s = await folioConTarjeta()
    const lookup = await request(app).post(`/tpv/venues/${venueId}/gift-cards/lookup`).set(auth()).send({ code: s.code })
    expect(lookup.status).toBe(200)
    expect(lookup.body.data.usableBalance).toBe(100)
    const key = cuid()
    const res = await request(app)
      .post(payPath('tpv', s.orderId))
      .set(auth())
      .send({
        idempotencyKey: key,
        proof: { kind: 'CODE', code: s.code },
        amount: 100,
      })
    expect([res.status, res.body.code]).toEqual([400, 'GIFT_CARD_DEVICE_ID_REQUIRED'])
    expect(await prisma.payment.count({ where: { venueId, idempotencyKey: key } })).toBe(0)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: s.cardId, type: 'REDEEM' } })).toBe(0)
  })

  it('código equivocado da404 y ambos intentos gastan el mismo contador de fallos de cobro', async () => {
    const s = await folioConTarjeta()
    const code = generateGiftCardCode().display
    const attempt = () =>
      request(app)
        .post(payPath('tpv', s.orderId))
        .set(auth())
        .set('X-Device-Id', 'N86-S12-ERROR')
        .send({
          idempotencyKey: cuid(),
          proof: { kind: 'CODE', code },
          amount: 100,
        })
    const first = await attempt()
    const second = await attempt()
    expect([first.status, first.body.code, second.status, second.body.code]).toEqual([
      404,
      'GIFT_CARD_NOT_FOUND',
      404,
      'GIFT_CARD_NOT_FOUND',
    ])
    expect(Number(first.headers['ratelimit-remaining']) - Number(second.headers['ratelimit-remaining'])).toBe(1)
    expect(await prisma.payment.count({ where: { venueId, orderId: s.orderId } })).toBe(0)
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: s.cardId, type: 'REDEEM' } })).toBe(0)
  })
})
