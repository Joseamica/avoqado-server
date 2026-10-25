import { type Payment, type OrderSource } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { loadSaleForExchange, loadSalesForExchange, MAX_EXCHANGE_SALE_PAYMENTS } from '@/services/exchanges/exchangeSale'
import {
  exchangeDetailFields,
  saleExchangeFields,
  paymentExchangeFields,
  loadExchangeLinksForOrders,
} from '@/services/exchanges/exchangeDetail'
import { TOPES_POR_ORDEN } from '@/services/fiscal/librosDeOrdenes'
import { MAX_ORDER_LOCK_SCOPE } from '@/services/shared/paymentShiftClaim'
import { seedClothingSale } from './seedExchange'
import { clienteQueCuenta } from './contarConsultas'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))
jest.setTimeout(90000)

let s: Awaited<ReturnType<typeof seedClothingSale>>
let ids: string[]
let credit: Payment
let refundId: string
let sequence = 0
const counter = clienteQueCuenta()
async function sale(source: OrderSource = 'AVOQADO_IOS', quantity = 1) {
  return prisma.order.create({
    data: {
      venueId: s.venueId,
      orderNumber: `B2-${s.venueId}-${++sequence}`,
      source,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: 100 * quantity,
      total: 100 * quantity,
      taxAmount: 0,
      items: {
        create: { productId: s.products[0].id, productName: 'Skirt', quantity, unitPrice: 100, total: 100 * quantity, taxAmount: 0 },
      },
      payments: {
        create: {
          venueId: s.venueId,
          amount: 100 * quantity,
          netAmount: 100 * quantity,
          feeAmount: 0,
          feePercentage: 0,
          method: 'CASH',
          source: 'POS',
          fundsFlow: 'CASH_DRAWER',
          status: 'COMPLETED',
          type: 'REGULAR',
        },
      },
    },
    include: { items: true, payments: true },
  })
}
async function exchangeRow(originalOrderId: string, newOrderId: string, originalPaymentId = s.payments[0].id) {
  return prisma.exchange.create({
    data: {
      venueId: s.venueId,
      originalOrderId,
      newOrderId,
      originalPaymentId,
      idempotencyKey: `batch-${++sequence}`,
      requestHash: 'batch-fixture',
      status: 'COMPLETED',
      returnedAmount: 100,
      takenAmount: 100,
      differenceAmount: 0,
      settlementKind: 'EVEN',
      lines: {},
      staffId: s.staffId,
      createdAt: new Date('2026-10-20T12:00:00Z'),
    },
  })
}
async function refund(orderId: string, originalPaymentId: string, lineId: string, status: 'COMPLETED' | 'PENDING' = 'COMPLETED') {
  return prisma.payment.create({
    data: {
      venueId: s.venueId,
      orderId,
      amount: 100,
      netAmount: 100,
      tipAmount: 0,
      feeAmount: 0,
      feePercentage: 0,
      method: 'CASH',
      type: 'REFUND',
      status,
      processorData: {
        originalPaymentId,
        salesRefundCents: 10000,
        tipRefundCents: 0,
        refundedItems: [{ orderItemId: lineId, quantity: 1, amountCents: 10000 }],
      },
    },
  })
}
beforeAll(async () => {
  const u = new URL(process.env.TEST_DATABASE_URL!)
  expect(['localhost', '127.0.0.1']).toContain(u.hostname)
  expect(u.pathname).toBe('/avoqado_cambio_test_20261020')
  s = await seedClothingSale({ list: 100, quantity: 10, payments: [400, 600] })
  await prisma.payment.update({
    where: { id: s.payments[1].id },
    data: { method: 'CREDIT_CARD', source: 'TPV', fundsFlow: 'AVOQADO_PROCESSED', tenderLabel: 'Visa', tipAmount: 12 },
  })
  refundId = (await refund(s.order.id, s.payments[1].id, s.order.items[0].id)).id
  const cash = await sale()
  const original = await sale()
  const { exchange } = await createExchange(
    s.input(
      s.body({
        originalPaymentId: original.payments[0].id,
        returned: [{ orderItemId: original.items[0].id, quantity: 1, restock: true, reason: 'SIZE' }],
        taken: [{ productId: s.products[1].id, quantity: 1 }],
      }),
    ),
  )
  credit = await prisma.payment.findUniqueOrThrow({ where: { id: exchange.paymentIds[0] } })
  const uber = await sale('UBER_EATS')
  const lesson = await sale()
  await prisma.product.update({ where: { id: s.products[3].id }, data: { type: 'CLASS' } })
  await prisma.orderItem.update({ where: { id: lesson.items[0].id }, data: { productId: s.products[3].id } })
  const promo = await sale('AVOQADO_IOS', 2)
  const promotion = await prisma.promotion.create({ data: { venueId: s.venueId, name: '2x1', type: 'BUNDLE', pricingMode: 'FIXED_TOTAL' } })
  const instance = await prisma.orderPromotion.create({
    data: {
      orderId: promo.id,
      promotionId: promotion.id,
      instanceId: promo.id,
      snapshotJson: { name: '2x1' },
      grossCents: 20000,
      discountCents: 10000,
      netCents: 10000,
    },
  })
  await prisma.orderItem.update({ where: { id: promo.items[0].id }, data: { orderPromotionId: instance.id, discountAmount: 100 } })
  await prisma.order.update({ where: { id: promo.id }, data: { total: 100, discountAmount: 100 } })
  ids = [cash.id, s.order.id, original.id, exchange.newOrderId, uber.id, lesson.id, promo.id]
})
afterAll(async () => {
  await counter.cerrar()
  if (s?.venueId) await s.cleanup()
  await prisma.$disconnect()
})

describe('exchange reads in batch (B)', () => {
  it('matches the real single-sale loader, including catalog products and charged discounts', async () => {
    const batch = await loadSalesForExchange(prisma, s.venueId, ids)
    expect(batch.size).toBe(ids.length)
    for (const id of ids) expect(batch.get(id)).toEqual(await loadSaleForExchange(prisma, s.venueId, id))
  })
  it('rebuilds the existing detail for every completed payment without changing its output', async () => {
    const batch = await loadSalesForExchange(prisma, s.venueId, ids)
    const links = await loadExchangeLinksForOrders(prisma, s.venueId, ids)
    for (const [id, data] of batch) {
      for (const payment of data.payments) {
        const result = saleExchangeFields(data, links.get(id)!)
        expect({ fields: { ...result.fields, ...paymentExchangeFields(data, payment.id) }, itemExtras: result.itemExtras }).toEqual(
          await exchangeDetailFields(prisma, s.venueId, payment.id),
        )
      }
    }
    expect((await exchangeDetailFields(prisma, s.venueId, refundId)).fields.notExchangeableReason).toBe('NOT_A_SALE')
  })
  it('exposes the original tender label, tip and the same effective payment capacity as A', async () => {
    const data = (await loadSalesForExchange(prisma, s.venueId, [s.order.id])).get(s.order.id)!
    expect(data.payments.find(p => p.id === s.payments[1].id)).toMatchObject({
      tenderLabel: 'Visa',
      tipCents: 1200,
      saleRemainingCents: 50000,
    })
    const extra = saleExchangeFields(data, { asOriginal: [], asOriginalTotal: 0, asNew: null }).itemExtras.get(s.order.items[0].id)
    expect(extra).toMatchObject({
      chargedTotalCents: 100000,
      quantity: 10,
      returnedQtyOrder: 1,
      returnedCentsOrder: 10000,
      remainingQtyOrder: 9,
    })
    expect(extra).not.toHaveProperty('remainingPieceValuesCents')
  })
  it('keeps cross-order monetary refunds separate from order-wide quantities in every status', async () => {
    const original = await sale('AVOQADO_IOS', 5)
    const historical = await sale()
    await refund(historical.id, original.payments[0].id, original.items[0].id)
    await refund(original.id, historical.payments[0].id, original.items[0].id, 'PENDING')
    const data = (await loadSalesForExchange(prisma, s.venueId, [original.id])).get(original.id)!
    expect(data).toEqual(await loadSaleForExchange(prisma, s.venueId, original.id))
    expect(data.payments[0].saleRemainingCents).toBe(40000)
    expect(data.returnedByLine.get(original.items[0].id)).toMatchObject({ quantity: 1, amountCents: 10000 })
  })
  it('preserves the opened REFUNDED credit context and its payment veto separately from sale eligibility', async () => {
    await prisma.payment.update({ where: { id: credit.id }, data: { status: 'REFUNDED' } })
    try {
      const batch = await loadSalesForExchange(prisma, s.venueId, [credit.orderId], [credit.id])
      const data = batch.get(credit.orderId)!
      expect(data).toEqual(await loadSaleForExchange(prisma, s.venueId, credit.orderId, credit.id))
      expect(paymentExchangeFields(data, credit.id)).toMatchObject({ tenderSystemKind: 'EXCHANGE_CREDIT', chainRefundMethod: 'CASH' })
      expect((await exchangeDetailFields(prisma, s.venueId, credit.id)).fields).toMatchObject({
        exchangeable: false,
        notExchangeableReason: 'NOT_PAID',
        chainRefundMethod: 'CASH',
      })
    } finally {
      await prisma.payment.update({ where: { id: credit.id }, data: { status: 'COMPLETED' } })
    }
  })
  it('keeps missing credit roots in the map as a business refusal rather than dropping the sale', async () => {
    const link = await prisma.exchangeCreditLink.findUniqueOrThrow({ where: { creditPaymentId: credit.id } })
    await prisma.exchangeCreditLink.delete({ where: { id: link.id } })
    try {
      const data = (await loadSalesForExchange(prisma, s.venueId, [credit.orderId])).get(credit.orderId)!
      expect(data).toBeDefined()
      expect(saleExchangeFields(data, { asOriginal: [], asOriginalTotal: 0, asNew: null }).fields).toMatchObject({
        exchangeable: false,
        notExchangeableReason: 'NOT_ATTRIBUTABLE',
      })
      expect(paymentExchangeFields(data, credit.id).chainRefundBlockedCode).toBe('EXCHANGE_SETTLEMENT_UNAVAILABLE')
    } finally {
      await prisma.exchangeCreditLink.create({ data: link })
    }
  })
  it('preserves the known tender kind and blocked reason for a REFUNDED credit with no root link', async () => {
    const link = await prisma.exchangeCreditLink.findUniqueOrThrow({ where: { creditPaymentId: credit.id } })
    await prisma.payment.update({ where: { id: credit.id }, data: { status: 'REFUNDED' } })
    await prisma.exchangeCreditLink.delete({ where: { id: link.id } })
    try {
      expect((await exchangeDetailFields(prisma, s.venueId, credit.id)).fields).toMatchObject({
        tenderSystemKind: 'EXCHANGE_CREDIT',
        chainRefundMethod: null,
        chainRefundBlockedCode: 'EXCHANGE_SETTLEMENT_UNAVAILABLE',
        chainRefundBlockedReason: null,
        exchangeable: false,
        notExchangeableReason: 'NOT_PAID',
      })
    } finally {
      await prisma.exchangeCreditLink.create({ data: link })
      await prisma.payment.update({ where: { id: credit.id }, data: { status: 'COMPLETED' } })
    }
  })
  it('omits size overflow but keeps exactly 50 payments and a grouped line of 201 pieces', async () => {
    const exact = await sale('AVOQADO_IOS', 201)
    const overflow = await sale()
    const lines = await sale()
    const discounts = await sale()
    const movements = await sale()
    for (const [order, count] of [
      [exact, MAX_EXCHANGE_SALE_PAYMENTS - 1],
      [overflow, MAX_EXCHANGE_SALE_PAYMENTS],
    ] as const)
      await prisma.payment.createMany({
        data: Array.from({ length: count }, () => ({
          venueId: s.venueId,
          orderId: order.id,
          amount: 0,
          netAmount: 0,
          feeAmount: 0,
          feePercentage: 0,
          method: 'CASH' as const,
          status: 'COMPLETED' as const,
          type: 'REGULAR' as const,
        })),
      })
    await prisma.orderItem.createMany({
      data: Array.from({ length: TOPES_POR_ORDEN.renglones }, () => ({
        orderId: lines.id,
        quantity: 1,
        unitPrice: 0,
        total: 0,
        taxAmount: 0,
      })),
    })
    await prisma.orderDiscount.createMany({
      data: Array.from({ length: TOPES_POR_ORDEN.descuentos + 1 }, () => ({
        orderId: discounts.id,
        type: 'FIXED_AMOUNT' as const,
        name: 'Zero',
        value: 0,
        amount: 0,
      })),
    })
    await prisma.payment.createMany({
      data: Array.from({ length: TOPES_POR_ORDEN.movimientos + 1 }, () => ({
        venueId: s.venueId,
        orderId: movements.id,
        amount: 0,
        netAmount: 0,
        feeAmount: 0,
        feePercentage: 0,
        method: 'CASH' as const,
        status: 'PENDING' as const,
        type: 'REFUND' as const,
      })),
    })
    const batch = await loadSalesForExchange(prisma, s.venueId, [exact.id, overflow.id, lines.id, discounts.id, movements.id])
    expect([...batch.keys()]).toEqual([exact.id])
    expect(batch.get(exact.id)!.lines[0].quantity).toBe(201)
    expect(batch.get(exact.id)!.payments).toHaveLength(50)
    expect(saleExchangeFields(batch.get(exact.id)!, { asOriginal: [], asOriginalTotal: 0, asNew: null }).fields.exchangeable).toBe(true)
  })
  it('reads the top 50 links per order with exact totals and deterministic ties', async () => {
    const first = await sale()
    const second = await sale()
    const rows = []
    for (let i = 0; i < 53; i++) rows.push(await exchangeRow(first.id, (await sale()).id))
    const only = await exchangeRow(second.id, (await sale()).id)
    const links = await loadExchangeLinksForOrders(prisma, s.venueId, [first.id, second.id, rows[0].newOrderId, s.order.id])
    expect(links.get(first.id)?.asOriginalTotal).toBe(53)
    expect(links.get(first.id)?.asOriginal.map(e => e.exchangeId)).toEqual(
      rows
        .map(e => e.id)
        .sort()
        .reverse()
        .slice(0, 50),
    )
    expect(links.get(second.id)?.asOriginal.map(e => e.exchangeId)).toEqual([only.id])
    expect(links.get(rows[0].newOrderId)?.asNew).toEqual({ exchangeId: rows[0].id, originalOrderNumber: first.orderNumber })
    expect(links.get(s.order.id)).toEqual({ asOriginal: [], asOriginalTotal: 0, asNew: null })
  })
  it('keeps A parity at the exact refund row cap without counting the original payment twice', async () => {
    const original = await sale()
    await prisma.payment.createMany({
      data: Array.from({ length: TOPES_POR_ORDEN.movimientos }, () => ({
        venueId: s.venueId,
        orderId: original.id,
        amount: 0,
        netAmount: 0,
        feeAmount: 0,
        feePercentage: 0,
        method: 'CASH' as const,
        type: 'REFUND' as const,
        status: 'PENDING' as const,
      })),
    })
    const single = await loadSaleForExchange(prisma, s.venueId, original.id)
    expect(single.payments).toHaveLength(1)
    expect((await loadSalesForExchange(prisma, s.venueId, [original.id])).get(original.id)).toEqual(single)
  })
  it('retains an oversized ancestor scope as a read-only business refusal, including the exact boundary', async () => {
    const target = await sale()
    await prisma.payment.deleteMany({ where: { venueId: s.venueId, orderId: target.id } })
    for (let i = 0; i < MAX_ORDER_LOCK_SCOPE; i++) {
      const root = await sale()
      const payment = await prisma.payment.create({
        data: {
          venueId: s.venueId,
          orderId: target.id,
          tenderTypeId: credit.tenderTypeId,
          amount: 0,
          netAmount: 0,
          feeAmount: 0,
          feePercentage: 0,
          method: 'OTHER',
          status: 'COMPLETED',
          type: 'REGULAR',
        },
      })
      const row = await exchangeRow(root.id, root.id)
      await prisma.exchangeCreditLink.create({
        data: {
          venueId: s.venueId,
          exchangeId: row.id,
          originPaymentId: root.payments[0].id,
          creditPaymentId: payment.id,
          creditRefundPaymentId: root.payments[0].id,
          amount: 0,
        },
      })
      if (i === MAX_ORDER_LOCK_SCOPE - 2) {
        const data = (await loadSalesForExchange(prisma, s.venueId, [target.id])).get(target.id)!
        expect(saleExchangeFields(data, { asOriginal: [], asOriginalTotal: 0, asNew: null }).fields.exchangeable).toBe(true)
      }
    }
    const data = (await loadSalesForExchange(prisma, s.venueId, [target.id])).get(target.id)!
    expect(data).toBeDefined()
    expect(saleExchangeFields(data, { asOriginal: [], asOriginalTotal: 0, asNew: null }).fields).toMatchObject({
      exchangeable: false,
      notExchangeableReason: 'ORDER_LOCK_SCOPE_TOO_LARGE',
    })
  })
  it('runs the same SQL count for one credit sale with refunds and a heterogeneous page, with cheaper empty relations', async () => {
    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: credit.orderId, order: { venueId: s.venueId } } })
    const returned = await refund(credit.orderId, credit.id, line.id)
    const read = async (orderIds: string[]) => {
      counter.reiniciar()
      await loadSalesForExchange(counter.db, s.venueId, orderIds)
      await loadExchangeLinksForOrders(counter.db, s.venueId, orderIds)
      return counter.consultas()
    }
    try {
      const simple = await read([ids[0]])
      const one = await read([credit.orderId])
      const page = await read(ids)
      console.log('Batch SQL counts', { simple, oneCreditWithRefund: one, page, sales: ids.length })
      expect(simple).toBeGreaterThan(0)
      expect(simple).toBeLessThanOrEqual(one)
      expect(page).toBe(one)
    } finally {
      await prisma.payment.delete({ where: { id: returned.id } })
    }
  })
  it('isolates tenants and handles empty input without reading the database', async () => {
    expect(await loadSalesForExchange(prisma, s.organizationId, ids)).toEqual(new Map())
    expect(await loadExchangeLinksForOrders(prisma, s.organizationId, ids)).toEqual(new Map())
    counter.reiniciar()
    expect(await loadSalesForExchange(counter.db, s.venueId, [])).toEqual(new Map())
    expect(await loadExchangeLinksForOrders(counter.db, s.venueId, [])).toEqual(new Map())
    expect(counter.consultas()).toBe(0)
  })
})
