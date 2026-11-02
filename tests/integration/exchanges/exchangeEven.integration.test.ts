import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import socketManager from '@/communication/sockets'
import { SocketEventType } from '@/communication/sockets/types'
import { keptMarkdownDiscountRow } from '@/services/shared/discount.service'
import * as receiptService from '@/services/dashboard/receipt.dashboard.service'
import { createExchange } from '@/services/exchanges/exchange.service'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import { leerCobradoDeLaOrden } from '@/services/fiscal/cobradoDeLaOrden'
import { refundedItemsOfOrder, issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { defaults as giftCardReview } from '@/jobs/giftCardReconciliation.job'
import { mezclaDeLaOrden } from '@/services/fiscal/mezclaDeOrden'
import { libroDeLaOrden } from '@/services/fiscal/libroDeLaOrden'
import { loadSaleForExchange } from '@/services/exchanges/exchangeSale'
import { modesForExchangeCreditRoot } from '@/services/exchanges/exchangeRules'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))
jest.mock('@/services/shared/writeRefundInTx', () => ({
  ...jest.requireActual('@/services/shared/writeRefundInTx'),
  writeRefundInTx: jest.fn((...args: unknown[]) => jest.requireActual('@/services/shared/writeRefundInTx').writeRefundInTx(...args)),
}))

jest.setTimeout(60000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
const seed = async (opts?: Parameters<typeof seedClothingSale>[0]) => {
  const s = await seedClothingSale(opts)
  fixtures.push(s)
  return s
}
const stock = async (id: string) => Number((await prisma.inventory.findUniqueOrThrow({ where: { productId: id } })).currentStock)
beforeAll(() => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
})
afterAll(async () => {
  for (const s of fixtures) await s.cleanup()
  await prisma.$disconnect()
})
beforeEach(() => jest.clearAllMocks())
afterEach(() => jest.restoreAllMocks())

describe('even exchange (E1)', () => {
  it('V1: M to L completes with one credit refund, a PAID sale and the root link', async () => {
    const s = await seed()
    const { exchange: e, replay } = await createExchange(s.input())
    expect(replay).toBe(false)
    expect(e).toMatchObject({
      status: 'COMPLETED',
      returnedCents: 50000,
      takenCents: 50000,
      differenceCents: 0,
      settlement: { kind: 'EVEN', method: null, amountCents: 0 },
      pendingCardRefundCents: 0,
    })
    const refund = await prisma.payment.findUniqueOrThrow({ where: { id: e.refundPaymentIds[0] }, include: { tenderType: true } })
    expect(refund).toMatchObject({
      type: 'REFUND',
      method: 'OTHER',
      fundsFlow: 'EXTERNAL_RECORDED',
      merchantAccountId: null,
      tenderSatFormaPago: '17',
      tenderType: { systemKind: 'EXCHANGE_CREDIT' },
    })
    expect(Number(refund.amount)).toBe(-500)
    expect(refund.processorData).toMatchObject({
      refundedItems: [{ orderItemId: s.order.items[0].id, quantity: 1, amountCents: 50000 }],
      exchange: { role: 'CREDIT' },
    })
    const sale = await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId }, include: { payments: true, orderCustomers: true } })
    expect(sale).toMatchObject({
      paymentStatus: 'PAID',
      servedById: s.seller.id,
      createdById: s.seller.id,
      customerId: s.customer.id,
      orderCustomers: [expect.objectContaining({ customerId: s.customer.id, isPrimary: true })],
    })
    expect(sale.payments).toHaveLength(1)
    expect(sale.payments[0]).toMatchObject({ processedById: s.staffId, method: 'OTHER', tenderTypeId: refund.tenderTypeId })
    const link = await prisma.exchangeCreditLink.findUniqueOrThrow({ where: { creditPaymentId: sale.payments[0].id } })
    expect(link).toMatchObject({ originPaymentId: s.payments[0].id, creditRefundPaymentId: refund.id })
    expect(Number(link.amount)).toBe(500)
    const txs = await prisma.venueTransaction.findMany({ where: { venueId: s.venueId }, take: 10 })
    expect(txs).toHaveLength(2)
    expect(txs.reduce((sum, t) => sum.plus(t.grossAmount), new Prisma.Decimal(0)).toString()).toBe('0')
  })

  it('applies CUSTOMER_RETURN and SALE after commit, M plus one and L minus one', async () => {
    const s = await seed()
    await createExchange(s.input())
    expect(await stock(s.products[0].id)).toBe(11)
    expect(await stock(s.products[1].id)).toBe(9)
    const postings = await prisma.inventoryPosting.findMany({ where: { venueId: s.venueId }, take: 10 })
    expect(postings.map(p => [p.effectKind, p.status]).sort()).toEqual([
      ['CUSTOMER_RETURN', 'APPLIED'],
      ['SALE', 'APPLIED'],
    ])
  })

  it.each([false, true])('RF6: leaves real money, commission and loyalty untouched (card=%s)', async card => {
    const s = await seed({ card })
    const { exchange: e } = await createExchange(s.input())
    expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: s.shift.id } })).totalSales)).toBe(500)
    expect(await prisma.cashDrawerEvent.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await prisma.commissionCalculation.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await prisma.transactionCost.count({ where: { payment: { venueId: s.venueId } } })).toBe(0)
    expect(
      await prisma.paymentEffect.count({
        where: {
          venueId: s.venueId,
          kind: { in: ['COMMISSION', 'REFERRAL', 'TRANSACTION_COST'] },
          paymentId: { in: [...e.paymentIds, ...e.refundPaymentIds] },
        },
      }),
    ).toBe(0)
    if (card)
      expect(
        (await prisma.paymentEffect.findMany({ where: { venueId: s.venueId, kind: 'TRANSACTION_COST' }, take: 10 })).map(p => p.status),
      ).toEqual(['DONE'])
    expect(await prisma.stampEvent.count({ where: { venueId: s.venueId } })).toBe(0)
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } })
    expect([c.totalVisits, c.loyaltyPoints, Number(c.totalSpent)]).toEqual([3, 20, 500])
  })

  it('V2: preserves the 150 peso markdown as a mirror OrderDiscount and charges 350', async () => {
    const s = await seed({ paid: 350 })
    const { exchange: e } = await createExchange(s.input())
    expect(e.takenCents).toBe(35000)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId }, include: { items: true, orderDiscounts: true } })
    expect([o.subtotal, o.discountAmount, o.total].map(Number)).toEqual([500, 150, 350])
    expect([o.items[0].unitPrice, o.items[0].discountAmount, o.items[0].total].map(Number)).toEqual([500, 150, 500])
    expect(o.orderDiscounts).toEqual([
      expect.objectContaining({
        name: 'Rebaja conservada (cambio)',
        discountId: null,
        type: 'FIXED_AMOUNT',
        isAutomatic: true,
        appliedToItemIds: [o.items[0].id],
      }),
    ])
    expect((await leerCobradoDeLaOrden(prisma, o.id)).cobradoCents.get(o.items[0].id)).toBe(35000)
  })

  it('writes multiple refund slices in the same order consumed by the real fiscal ledger', async () => {
    const s = await seed({ quantity: 3, payments: [200, 600, 700] })
    const body = s.body({
      returned: [{ orderItemId: s.order.items[0].id, quantity: 3, reason: 'SIZE', restock: true }],
      taken: [{ productId: s.products[1].id, quantity: 3 }],
    })
    const { exchange: e } = await createExchange(s.input(body))
    const movements = await prisma.payment.findMany({
      where: { venueId: s.venueId, orderId: s.order.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 20,
    })
    expect(movements.filter(m => m.type === 'REFUND').map(m => m.id)).toEqual(e.refundPaymentIds)
    const charged = await leerCobradoDeLaOrden(prisma, s.order.id)
    const comp = mezclaDeLaOrden(charged.renglones, s.order)
    const book = libroDeLaOrden(
      comp,
      movements.map(m => ({ id: m.id, type: m.type, amountCents: m.amount.mul(100).toNumber(), processorData: m.processorData })),
    )
    for (const refund of movements.filter(m => m.type === 'REFUND')) {
      const part = book.get(refund.id)!
      expect(part.aproximada).toBe(false)
      expect(part.netCents + part.taxCents).toBe(refund.amount.mul(100).toNumber())
    }
    expect((await refundedItemsOfOrder(prisma, s.venueId, s.order.id)).get(s.order.items[0].id)).toMatchObject({
      quantity: 3,
      amountCents: 150000,
    })
    expect(await stock(s.products[0].id)).toBe(13)
    expect(await stock(s.products[1].id)).toBe(7)
  })

  it.each([
    [499.99, 0.01],
    [0.01, 499.99],
  ])('closes only after both credit slices when one slice is one cent (%j)', async (a, b) => {
    const s = await seed({ payments: [a, b] })
    const { exchange: e } = await createExchange(s.input())
    expect(e.paymentIds).toHaveLength(2)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })).toMatchObject({ paymentStatus: 'PAID' })
    expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId, effectKind: 'SALE' } })).toBe(1)
    const payments = await prisma.payment.findMany({ where: { venueId: s.venueId, orderId: e.newOrderId }, take: 5 })
    expect(payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0)).toString()).toBe('500')
  })

  it('the gift card nightly queries report neither the EC refund nor the EC charge', async () => {
    const s = await seed()
    await createExchange(s.input())
    const page = { desde: new Date(0), limite: 10000, despuesDe: null }
    expect((await giftCardReview.buscarCobrosConSaldoSinCanje(page)).filter(p => p.venueId === s.venueId)).toEqual([])
    expect((await giftCardReview.buscarReembolsosSinReverso(page)).filter(p => p.venueId === s.venueId)).toEqual([])
  })

  it.each(['BANK_TRANSFER', 'OTHER'] as const)('an EC capacity from a %s root never offers CASH', async method => {
    const s = await seed()
    await prisma.payment.update({ where: { id: s.payments[0].id }, data: { method, source: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED' } })
    const { exchange: e } = await createExchange(s.input())
    const sale = await loadSaleForExchange(prisma, s.venueId, e.newOrderId)
    expect(sale.payments[0].rootPaymentId).toBe(s.payments[0].id)
    expect(modesForExchangeCreditRoot(sale.payments[0].rootMoney)).not.toHaveProperty('CASH')
  })

  // 28-oct («regresa lo que salió menos lo que ya regresó»): la prenda dañada queda RESUELTA en una línea NO_REPONER (SKIPPED),
  // para que una devolución posterior de la terminal no la regrese al estante; el stock no se mueve.
  it('DEFECT without restock leaves the original stock unchanged and only records it as resolved', async () => {
    const s = await seed()
    const b = s.body({ returned: [{ orderItemId: s.order.items[0].id, quantity: 1, restock: false, reason: 'DEFECT' }] })
    await createExchange(s.input(b))
    expect(await stock(s.products[0].id)).toBe(10)
    const lineas = await prisma.inventoryPostingLine.findMany({
      where: { posting: { venueId: s.venueId, effectKind: 'CUSTOMER_RETURN' } },
      select: { effectKey: true, status: true, reason: true, expectedQuantityBase: true },
    })
    expect(lineas).toEqual([
      { effectKey: s.order.items[0].id + '#NO_REPONER', status: 'SKIPPED', reason: 'NOT_RESTOCKED', expectedQuantityBase: new Prisma.Decimal(1) },
    ])
  })

  it('rolls everything back when the SECOND refund slice fails', async () => {
    const s = await seed({ payments: [200, 300] })
    const real = jest.requireActual('@/services/shared/writeRefundInTx').writeRefundInTx
    jest.mocked(writeRefundInTx).mockImplementationOnce(real).mockRejectedValueOnce(new Error('SECOND_REFUND_FAILURE'))
    await expect(createExchange(s.input())).rejects.toThrow('SECOND_REFUND_FAILURE')
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND' } })).toBe(0)
    expect(await prisma.order.count({ where: { venueId: s.venueId } })).toBe(1)
    expect(await prisma.inventoryPosting.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await stock(s.products[0].id)).toBe(10)
    expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: s.shift.id } })).totalSales)).toBe(500)
  })

  it('broadcasts the standard new sale payload and updates both orders only once', async () => {
    const s = await seed()
    const broadcasting = { broadcastToVenue: jest.fn() }
    jest.mocked(socketManager.getBroadcastingService).mockReturnValueOnce(broadcasting as any)
    const input = s.input()
    const { exchange: e } = await createExchange(input)
    expect(broadcasting.broadcastToVenue).toHaveBeenCalledWith(s.venueId, SocketEventType.ORDER_CREATED, {
      orderId: e.newOrderId,
      orderNumber: e.newOrderNumber,
      orderType: s.order.type,
      source: s.order.source,
      total: 500,
    })
    for (const orderId of [s.order.id, e.newOrderId])
      expect(broadcasting.broadcastToVenue).toHaveBeenCalledWith(s.venueId, SocketEventType.ORDER_UPDATED, { orderId })
    await createExchange(input)
    expect(broadcasting.broadcastToVenue).toHaveBeenCalledTimes(3)
  })

  it('logs EXCHANGE_CREATED with amounts in pesos', async () => {
    const s = await seed()
    const { exchange: e } = await createExchange(s.input())
    const logs = await prisma.activityLog.findMany({ where: { venueId: s.venueId, entityId: e.id, action: 'EXCHANGE_CREATED' }, take: 2 })
    expect(logs).toEqual([
      expect.objectContaining({
        action: 'EXCHANGE_CREATED',
        staffId: s.staffId,
        venueId: s.venueId,
        data: expect.objectContaining({
          returnedAmount: 500,
          takenAmount: 500,
          differenceAmount: 0,
          deviceId: 'caja-prueba',
          isOfflineReplay: false,
        }),
      }),
    ])
  })

  it('an all-free exchange has a zero anchor, closes the new sale and restocks only once', async () => {
    const s = await seed({ paid: 0 })
    const input = s.input()
    const { exchange: e } = await createExchange(input)
    expect([e.returnedCents, e.takenCents, e.differenceCents]).toEqual([0, 0, 0])
    expect(e.refundPaymentIds).toHaveLength(1)
    expect(await prisma.exchangeCreditLink.count({ where: { exchangeId: e.id } })).toBe(0)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })).toMatchObject({ paymentStatus: 'PAID' })
    expect(await stock(s.products[0].id)).toBe(11)
    await createExchange(input)
    expect(await stock(s.products[0].id)).toBe(11)
    const returned = await refundedItemsOfOrder(prisma, s.venueId, s.order.id)
    expect(returned.get(s.order.items[0].id)).toMatchObject({ quantity: 1, amountCents: 0 })
    await expect(createExchange(s.input())).rejects.toMatchObject({
      statusCode: 422,
      code: 'EXCHANGE_ITEM_NOT_RETURNABLE',
      details: expect.objectContaining({ reason: 'ALREADY_RETURNED' }),
    })
    expect(await prisma.inventoryPostingLine.count({ where: { posting: { venueId: s.venueId, effectKind: 'CUSTOMER_RETURN' } } })).toBe(1)
    expect(await prisma.paymentEffect.count({ where: { venueId: s.venueId, kind: { in: ['COMMISSION', 'REFERRAL'] } } })).toBe(0)
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: s.customer.id } })).toMatchObject({ totalVisits: 3, loyaltyPoints: 20 })
  })

  it('counts a free piece in a mixed return exactly once, including its inventory return', async () => {
    const s = await seed()
    const free = await prisma.orderItem.create({
      data: {
        orderId: s.order.id,
        productId: s.products[3].id,
        productName: 'Blusa gratis',
        quantity: 1,
        unitPrice: 500,
        discountAmount: 500,
        total: 500,
        taxAmount: 0,
      },
    })
    await prisma.order.update({ where: { id: s.order.id }, data: { subtotal: 1000, discountAmount: 500 } })
    await prisma.orderDiscount.create({
      data: keptMarkdownDiscountRow({ orderId: s.order.id, itemId: free.id, discountAmountPesos: 500, appliedById: null }),
    })
    const body = s.body({
      returned: [
        { orderItemId: free.id, quantity: 1, reason: 'SIZE', restock: true },
        { orderItemId: s.order.items[0].id, quantity: 1, reason: 'SIZE', restock: true },
      ],
      taken: [
        { productId: s.products[3].id, quantity: 1 },
        { productId: s.products[1].id, quantity: 1 },
      ],
    })
    const { exchange: e } = await createExchange(s.input(body))
    const refunds = await prisma.payment.findMany({ where: { id: { in: e.refundPaymentIds }, venueId: s.venueId }, take: 5 })
    const entries = refunds
      .flatMap(
        r => (r.processorData as { refundedItems: Array<{ orderItemId: string; quantity: number; amountCents: number }> }).refundedItems,
      )
      .filter(i => i.orderItemId === free.id)
    expect(entries).toEqual([{ orderItemId: free.id, quantity: 1, amountCents: 0 }])
    expect(await stock(s.products[3].id)).toBe(10)
    expect(
      await prisma.inventoryPostingLine.count({
        where: { posting: { venueId: s.venueId, effectKind: 'CUSTOMER_RETURN' }, orderItemId: free.id },
      }),
    ).toBe(1)
    await expect(
      createExchange(s.input(s.body({ returned: [{ orderItemId: free.id, quantity: 1, restock: true, reason: 'SIZE' }] }))),
    ).rejects.toMatchObject({ code: 'EXCHANGE_ITEM_NOT_RETURNABLE', details: expect.objectContaining({ reason: 'ALREADY_RETURNED' }) })
  })

  it('a receipt failure after commit does not undo the exchange and a replay recovers the receipt', async () => {
    const s = await seed()
    const input = s.input()
    jest.spyOn(receiptService, 'generateAndStoreReceipt').mockRejectedValueOnce(new Error('RECEIPT_DOWN'))
    const a = await createExchange(input)
    expect(a.exchange.receiptUrl).toBeNull()
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(1)
    const b = await createExchange(input)
    const receipt = await prisma.digitalReceipt.findFirstOrThrow({ where: { paymentId: b.exchange.paymentIds[0] } })
    expect(b).toMatchObject({ replay: true, exchange: { id: a.exchange.id, receiptUrl: expect.stringContaining(receipt.accessKey) } })
    expect(await stock(s.products[0].id)).toBe(11)
  })

  it('RF1: concurrent replays recover exactly one real receipt and return its canonical URL', async () => {
    const s = await seed()
    const input = s.input()
    const first = await createExchange(input)
    const paymentId = first.exchange.paymentIds[0]
    expect(await prisma.digitalReceipt.count({ where: { paymentId } })).toBe(1)
    // Se deja el recibo ausente sin repetir la operación financiera ya confirmada.
    await prisma.digitalReceipt.deleteMany({ where: { paymentId } })
    await prisma.exchange.update({
      where: { id: first.exchange.id, venueId: s.venueId },
      data: { result: { ...first.exchange, receiptUrl: null } as unknown as Prisma.InputJsonValue },
    })

    const [a, b] = await Promise.all([createExchange(input), createExchange(input)])

    expect(await prisma.digitalReceipt.count({ where: { paymentId } })).toBe(1)
    const receipt = await prisma.digitalReceipt.findFirstOrThrow({ where: { paymentId } })
    expect(a.replay).toBe(true)
    expect(b.replay).toBe(true)
    expect(a.exchange.receiptUrl).toEqual(expect.stringContaining(receipt.accessKey))
    expect(b.exchange.receiptUrl).toBe(a.exchange.receiptUrl)
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(1)
  })

  it('replays return the oldest receipt URL while preserving historical duplicates', async () => {
    const s = await seed()
    const input = s.input()
    const first = await createExchange(input)
    const paymentId = first.exchange.paymentIds[0]
    const existing = await prisma.digitalReceipt.findFirstOrThrow({ where: { paymentId } })
    const canonical = await prisma.digitalReceipt.create({
      data: { paymentId, dataSnapshot: {}, createdAt: new Date(existing.createdAt.getTime() - 1000) },
    })

    const [a, b] = await Promise.all([createExchange(input), createExchange(input)])

    expect(first.exchange.receiptUrl).toEqual(expect.stringContaining(existing.accessKey))
    expect(a.exchange.receiptUrl).toEqual(expect.stringContaining(canonical.accessKey))
    expect(b.exchange.receiptUrl).toBe(a.exchange.receiptUrl)
    expect(await prisma.digitalReceipt.count({ where: { paymentId } })).toBe(2)
  })

  it('actor mismatch is 400 and disabled exchanges reject before creating an order', async () => {
    const s = await seed()
    await expect(createExchange({ ...s.input(), actorStaffId: s.seller.id })).rejects.toMatchObject({
      code: 'ACTOR_MISMATCH',
      statusCode: 400,
    })
    await prisma.venueSettings.upsert({
      where: { venueId: s.venueId },
      create: { venueId: s.venueId, exchangesEnabled: false },
      update: { exchangesEnabled: false },
    })
    await expect(createExchange(s.input())).rejects.toMatchObject({ code: 'EXCHANGES_DISABLED', statusCode: 422 })
    expect(await prisma.order.count({ where: { venueId: s.venueId } })).toBe(1)
  })

  it('still rejects a zero refund outside the internal exchange path', async () => {
    const s = await seed()
    await expect(
      issueRefund({ venueId: s.venueId, paymentId: s.payments[0].id, amount: 0, reason: 'RETURNED_GOODS', staffId: s.staffId }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('requires the opened payment itself to be a completed charge', async () => {
    const s = await seed({ quantity: 2, payments: [500, 500] })
    await prisma.payment.update({ where: { id: s.payments[0].id }, data: { status: 'FAILED' } })
    await expect(createExchange(s.input())).rejects.toMatchObject({ code: 'EXCHANGE_ITEM_NOT_RETURNABLE', statusCode: 422 })
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(0)
  })

  it('rejects a stale expected difference before writing', async () => {
    const s = await seed()
    await expect(
      createExchange(s.input(s.body({ settlement: { kind: 'EVEN', method: null, expectedDifferenceCents: 1 } }))),
    ).rejects.toMatchObject({ code: 'EXCHANGE_DIFFERENCE_CHANGED', statusCode: 409 })
    expect(await prisma.order.count({ where: { venueId: s.venueId } })).toBe(1)
  })

  it.each(['COLLECT', 'PAYOUT'] as const)('rejects a %s request when the calculated difference is EVEN', async kind => {
    const s = await seed()
    await expect(
      createExchange(s.input(s.body({ settlement: { kind, method: 'CASH', expectedDifferenceCents: 0 } }))),
    ).rejects.toMatchObject({ code: 'EXCHANGE_SETTLEMENT_UNAVAILABLE', statusCode: 422 })
  })
})

describe('idempotency (RF1)', () => {
  it('replays the same key and body, including a changed offline transport flag, without new writes', async () => {
    const s = await seed()
    const input = s.input()
    const a = await createExchange(input)
    const b = await createExchange({ ...input, body: { ...input.body, isOfflineReplay: true } })
    expect(b).toEqual({ exchange: a.exchange, replay: true })
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(1)
    expect(await prisma.payment.count({ where: { venueId: s.venueId } })).toBe(3)
  })
  it('rejects a reused key when tenderRevision changes', async () => {
    const s = await seed()
    const input = s.input()
    await createExchange(input)
    await expect(
      createExchange({ ...input, body: { ...input.body, settlement: { ...input.body.settlement, tenderRevision: 2 } } }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
  })
  it('serializes two identical simultaneous requests into exactly one exchange and one replay', async () => {
    const s = await seed()
    const input = s.input()
    const results = await Promise.all([createExchange(input), createExchange(input)])
    expect(results.map(r => r.replay).sort()).toEqual([false, true])
    expect(results[0].exchange.id).toBe(results[1].exchange.id)
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(1)
  })
  it('enforces newOrderId uniqueness in Postgres', async () => {
    const s = await seed()
    const { exchange } = await createExchange(s.input())
    const x = await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } })
    const data = { ...x }
    delete (data as Partial<typeof data>).id
    await expect(
      prisma.exchange.create({
        data: { ...data, lines: data.lines as Prisma.InputJsonValue, result: Prisma.JsonNull, idempotencyKey: `${x.idempotencyKey}-other` },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })
})
