import express from 'express'
import request from 'supertest'
import prisma from '@/utils/prismaClient'
import { createExchange, completeExchange } from '@/services/exchanges/exchange.service'
import { createExchange as createController } from '@/controllers/mobile/exchange.mobile.controller'
import { validateRequest } from '@/middlewares/validation'
import { createExchangeSchema } from '@/schemas/mobile/exchange.mobile.schema'
import { generateAndStoreReceipt } from '@/services/dashboard/receipt.dashboard.service'
import { seedCardSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(90000)
let s: Awaited<ReturnType<typeof seedCardSale>>
beforeAll(() =>
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(
    /^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/,
  ),
)
afterEach(async () => {
  jest.restoreAllMocks()
  jest.mocked(generateAndStoreReceipt).mockReset()
  if (s) await s.cleanup()
})
async function reserve() {
  s = await seedCardSale({ provider: 'BLUMON', amounts: [350] })
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 450 } })
  const input = s.input(
    s.body({
      taken: [{ productId: s.products[3].id, quantity: 1 }],
      settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: 10000 },
    }),
  )
  const { exchange } = await createExchange(input)
  const charge = await s.terminalCharge(exchange.newOrderId, 10000)
  return { input, exchange, charge }
}

it('a real HTTP replay wins g+1 while an old post-commit patch loses CAS without deleting its receipt or charge', async () => {
  const { input, exchange: e, charge } = await reserve()
  let entered!: () => void
  let release!: () => void
  const ready = new Promise<void>(r => {
    entered = r
  })
  const gate = new Promise<void>(r => {
    release = r
  })
  jest
    .mocked(generateAndStoreReceipt)
    .mockResolvedValueOnce({ accessKey: 'old-receipt' } as any)
    .mockResolvedValue({ accessKey: 'replay-receipt' } as any)
  const update = prisma.exchange.updateMany.bind(prisma.exchange)
  const counts: number[] = []
  let held = false
  jest.spyOn(prisma.exchange, 'updateMany').mockImplementation((async (args: any) => {
    const hold = !held && args.data.status === undefined && args.data.result
    if (hold) {
      held = true
      entered()
      await gate
    }
    const result = await update(args)
    if (hold) counts.push(result.count)
    return result
  }) as any)
  const complete = completeExchange({ venueId: s.venueId, exchangeId: e.id, actorStaffId: s.staffId })
  await ready
  const committed = await prisma.exchange.findUniqueOrThrow({ where: { id: e.id } })
  expect(committed).toMatchObject({ status: 'COMPLETED', chargePaymentId: charge.id })
  expect(await prisma.activityLog.count({ where: { entityId: e.id, action: 'EXCHANGE_CREATED' } })).toBe(1)
  const app = express()
  app.use(express.json())
  app.post(
    '/venues/:venueId/exchanges',
    (req, _res, next) => {
      ;(req as any).authContext = { userId: s.staffId }
      next()
    },
    validateRequest(createExchangeSchema),
    createController,
  )
  let response: request.Response
  try {
    response = await request(app).post(`/venues/${s.venueId}/exchanges`).send(input.body)
  } finally {
    release()
  }
  expect(response!.status).toBe(200)
  const replay = await prisma.exchange.findUniqueOrThrow({ where: { id: e.id } })
  expect(replay.resultRevision).toBe(committed.resultRevision + 1)
  expect((replay.result as any).receiptUrl).toContain('replay-receipt')
  const final = await complete
  expect(counts).toEqual([0])
  expect(final.receiptUrl).toContain('replay-receipt')
  expect(final.chargePaymentId).toBe(charge.id)
  expect((await prisma.exchange.findUniqueOrThrow({ where: { id: e.id } })).result).toEqual(final)
  expect(await prisma.activityLog.count({ where: { entityId: e.id, action: 'EXCHANGE_CREATED' } })).toBe(1)
})

it('a stopped post-commit continuation leaves the committed result and audit coherent', async () => {
  const { exchange: e, charge } = await reserve()
  const { executeExchangeInTransaction } = await import('@/services/mobile/order.mobile.service')
  // Invoke exactly the durable opener and intentionally never run its continuation.
  const outcome = await executeExchangeInTransaction({
    mode: 'SETTLE_CARD_CHARGE',
    venueId: s.venueId,
    exchangeId: e.id,
    actorStaffId: null,
  })
  expect('postCommit' in outcome).toBe(true)
  const row = await prisma.exchange.findUniqueOrThrow({ where: { id: e.id } })
  expect(row).toMatchObject({
    status: 'COMPLETED',
    chargePaymentId: charge.id,
    result: { status: 'COMPLETED', chargePaymentId: charge.id },
  })
  expect(await prisma.activityLog.findFirst({ where: { entityId: e.id, action: 'EXCHANGE_CREATED' } })).toMatchObject({
    staffId: null,
    data: { origin: 'SWEEP', originalStaffId: s.staffId },
  })
})
