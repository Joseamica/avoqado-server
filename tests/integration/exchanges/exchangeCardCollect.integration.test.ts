import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { seedCardSale, seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(90000)
let s: Awaited<ReturnType<typeof seedCardSale>>
beforeAll(() =>
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(
    /^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/,
  ),
)
beforeEach(async () => {
  s = await seedCardSale({ provider: 'BLUMON', amounts: [350] })
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: new Prisma.Decimal(450) } })
})
afterEach(async () => {
  if (s) await s.cleanup()
})
const input = () =>
  s.input(
    s.body({
      taken: [{ productId: s.products[3].id, quantity: 1 }],
      settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: 10000 },
    }),
  )

describe('card exchange reservation', () => {
  it('keeps 201 replacement pieces grouped in one order item', async () => {
    const many = await seedClothingSale({ list: 1, paid: 1, quantity: 201 })
    try {
      await prisma.product.update({ where: { id: many.products[3].id }, data: { price: 2 } })
      const { exchange: e } = await createExchange(
        many.input(
          many.body({
            returned: [{ orderItemId: many.order.items[0].id, quantity: 201, restock: true, reason: 'SIZE' }],
            taken: [{ productId: many.products[3].id, quantity: 201 }],
            settlement: { kind: 'COLLECT', method: 'CARD_TERMINAL', expectedDifferenceCents: 20100 },
          }),
        ),
      )
      const rows = await prisma.orderItem.findMany({ where: { orderId: e.newOrderId }, take: 202 })
      expect(rows).toHaveLength(1)
      expect(rows[0].quantity).toBe(201)
      expect(e.lines.taken[0].newOrderItemIds).toEqual([rows[0].id])
    } finally {
      await many.cleanup()
    }
  })
  it('reserves V4 with frozen lines, a pending grouped sale and an atomic audit, without money or stock effects', async () => {
    const i = input()
    const { exchange: e, replay } = await createExchange(i)
    expect(replay).toBe(false)
    expect(e).toMatchObject({
      status: 'PENDING_PAYMENT',
      amountToChargeCents: 10000,
      differenceCents: 10000,
      paymentIds: [],
      refundPaymentIds: [],
      receiptUrl: null,
      settlement: { sources: [] },
    })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })
    expect(order).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PENDING' })
    expect(Number(order.total)).toBe(450)
    expect(await prisma.payment.count({ where: { venueId: s.venueId } })).toBe(1)
    expect(await prisma.exchangeCreditLink.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await prisma.cashDrawerEvent.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await prisma.activityLog.count({ where: { venueId: s.venueId, entityId: e.id, action: 'EXCHANGE_RESERVED' } })).toBe(1)
    expect(await createExchange(i)).toEqual({ exchange: e, replay: true })
    expect(
      (await prisma.inventory.findMany({ where: { venueId: s.venueId }, take: 10 })).every(row => Number(row.currentStock) === 10),
    ).toBe(true)
  })
  it('rejects card replay without a connection before any reservation', async () => {
    const i = input()
    i.body.isOfflineReplay = true
    await expect(createExchange(i)).rejects.toMatchObject({
      code: 'EXCHANGE_SETTLEMENT_UNAVAILABLE',
      details: { reason: 'CARD_NEEDS_CONNECTION' },
    })
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(0)
  })
  it('retains A capacity validation before creating a tender or reservation', async () => {
    await prisma.payment.update({ where: { id: s.payments[0].id }, data: { processorData: { refundedAmount: 350 } } })
    await expect(createExchange(input())).rejects.toMatchObject({ code: 'EXCHANGE_ITEM_NOT_RETURNABLE' })
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await prisma.venueTenderType.count({ where: { venueId: s.venueId, systemKind: 'EXCHANGE_CREDIT' } })).toBe(0)
  })
})
