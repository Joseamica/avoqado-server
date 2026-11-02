import cuid from 'cuid'
import express from 'express'
import request from 'supertest'
import prisma from '@/utils/prismaClient'
import socketManager from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { terminalPaymentService } from '@/services/terminal-payment.service'
import { sendTerminalPayment } from '@/controllers/mobile/terminal-payment.mobile.controller'
import { seedCardSale } from './seedExchange'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

let s: Awaited<ReturnType<typeof seedCardSale>>
const emit = jest.fn()
const app = express()
app.use(express.json())
app.post('/venues/:venueId/terminal-payment', (req, res) => {
  ;(req as any).authContext = { userId: s.staffId }
  return sendTerminalPayment(req, res)
})
beforeAll(async () => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
  s = await seedCardSale({ provider: 'BLUMON', amounts: [500] })
  process.env.TERMINAL_PAYMENT_LONG_POLL_MS = '150'
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(terminalRegistry.getTerminal as jest.Mock).mockImplementation((terminalId: string) => ({
    terminalId,
    venueId: s.venueId,
    socketId: 'exchange-socket',
    terminalPaymentAckVersion: 0,
  }))
  ;(socketManager.getServer as jest.Mock).mockReturnValue({
    sockets: { sockets: new Map([['exchange-socket', { emit }]]) },
    to: () => ({ emit }),
  })
})
afterEach(async () => {
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId: s.venueId } })
})
afterAll(async () => {
  delete process.env.TERMINAL_PAYMENT_LONG_POLL_MS
  if (s) await s.cleanup()
})
const body = (orderId: string, extra: Record<string, unknown> = {}) => ({
  requestId: cuid(),
  orderId,
  terminalId: s.terminal.serialNumber,
  amountCents: 10000,
  tipCents: 0,
  ...extra,
})
const send = (b: ReturnType<typeof body>) => request(app).post(`/venues/${s.venueId}/terminal-payment`).send(b)
async function assertTombstone(b: ReturnType<typeof body>, httpStatus: number, code: string) {
  const first = await send(b)
  expect(first.status).toBe(httpStatus)
  expect(first.body).toMatchObject({ code, details: { requestId: b.requestId } })
  const row = await prisma.terminalPaymentRequest.findUnique({ where: { requestId: b.requestId } })
  expect(row).toMatchObject({ status: 'FAILED', failureCode: `REJECTED_${code}`, deliveryProvenance: { deliveries: [] } })
  const replay = await send(b)
  expect(replay.status).toBe(httpStatus)
  expect(replay.body).toEqual(first.body)
  expect(await terminalPaymentService.getPaymentStatus(b.requestId, s.venueId)).toMatchObject({
    status: 'FAILED',
    outcome: 'NOT_CHARGED',
    outcomeEvidence: 'REJECTED_AT_ADMISSION',
  })
  expect(emit).not.toHaveBeenCalled()
}

describe('exchange charge admission and durable replay', () => {
  it.each([{ amountCents: 10001 }, { tipCents: 1 }])(
    'rejects an incorrect difference or tip (%j) and replays the same HTTP error',
    async extra => {
      const { order } = await s.pendingExchange(500)
      await assertTombstone(body(order.id, extra), 400, 'EXCHANGE_CHARGE_MISMATCH')
    },
  )
  it('admits the exact difference without a tip and persists its PENDING row before delivery', async () => {
    const { order } = await s.pendingExchange(500)
    const b = body(order.id)
    const res = await send(b)
    expect(res.status).toBe(504)
    expect(await prisma.terminalPaymentRequest.findUnique({ where: { requestId: b.requestId } })).toMatchObject({ status: 'PENDING' })
    expect(emit).toHaveBeenCalledWith('terminal:payment_request', expect.objectContaining({ requestId: b.requestId, amountCents: 10000 }))
  })
  it('admits an ordinary order with its existing contract', async () => {
    const order = await s.newOrder()
    const b = body(order.id, { amountCents: 5000, tipCents: 500 })
    expect((await send(b)).status).toBe(504)
    expect(await prisma.terminalPaymentRequest.findUnique({ where: { requestId: b.requestId } })).toMatchObject({ status: 'PENDING' })
  })
  it.each([0, 500])(
    'a second terminal request between the first card charge and complete is 409 EXCHANGE_DIFFERENCE_ALREADY_CHARGED (credit %i)',
    async credit => {
      const { order, exchange } = await s.pendingExchange(credit)
      const p = await s.terminalCharge(order.id, 10000)
      // The stamp is advisory: simulate its failure, while the real captured Payment stays durable.
      await prisma.exchange.update({ where: { id: exchange.id }, data: { chargePaymentId: null } })
      await assertTombstone(body(order.id), 409, 'EXCHANGE_DIFFERENCE_ALREADY_CHARGED')
      expect(await prisma.payment.findUnique({ where: { id: p.id } })).toMatchObject({ status: 'COMPLETED' })
    },
  )
  it('a positive request without an accreditable Payment also vetoes another authorization, including behind twenty negatives', async () => {
    const { order } = await s.pendingExchange(500)
    for (let n = 0; n < 21; n++) await s.seedRequest(order.id, { status: 'FAILED', failureCode: 'BANK_DECLINED' })
    const positive = await s.seedRequest(order.id, { status: 'COMPLETED', paymentId: 'missing-payment' })
    await assertTombstone(body(order.id), 409, 'EXCHANGE_DIFFERENCE_ALREADY_CHARGED')
    expect(await terminalPaymentService.getPaymentStatus(positive.requestId, s.venueId)).toMatchObject({ outcome: 'CHARGED' })
  })
  it('replays the SAME positive request before considering a new authorization', async () => {
    const { order } = await s.pendingExchange(500)
    const r = await s.seedRequest(order.id, {
      status: 'COMPLETED',
      paymentId: 'recorded-payment',
      resultJson: {
        requestId: 'stored',
        status: 'success',
        paymentId: 'recorded-payment',
      },
    })
    const result = await terminalPaymentService.sendPaymentToTerminal({
      ...body(order.id, { requestId: r.requestId }),
      venueId: s.venueId,
      requestedBy: s.staffId,
    })
    expect(result).toMatchObject({ status: 'success', paymentId: 'recorded-payment' })
    expect(emit).not.toHaveBeenCalled()
  })
})
