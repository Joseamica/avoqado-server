import prisma from '@/utils/prismaClient'
import { getTransactionDetail } from '@/services/mobile/transaction.mobile.service'
import { createExchange } from '@/services/exchanges/exchange.service'
import { pieceValuesCents } from '@/services/exchanges/exchangeCalculator'
import { parteDeUnidades } from '@/services/shared/parteDeUnidades'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import { TOPES_POR_ORDEN } from '@/services/fiscal/librosDeOrdenes'
import { seedClothingSale } from './seedExchange'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))
jest.setTimeout(60000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
const seed = async (opts?: Parameters<typeof seedClothingSale>[0]) => {
  const s = await seedClothingSale(opts)
  fixtures.push(s)
  return s
}
const detail = (s: Seed, paymentId = s.payments[0].id) => getTransactionDetail(s.venueId, paymentId)
async function refund(s: Seed, paymentId: string, quantity: number, cents: number) {
  return prisma.$transaction(tx =>
    writeRefundInTx(tx, {
      venueId: s.venueId,
      originalPaymentId: paymentId,
      salesRefundCents: cents,
      tipRefundCents: 0,
      refundedItems: [{ orderItemId: s.order.items[0].id, quantity, amountCents: cents }],
      reason: 'RETURNED_GOODS',
      staffId: s.staffId,
      tenderCommission: 'NONE',
      shift: 'CLAIM_LIVE',
    }),
  )
}
beforeAll(() => expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toBe('/avoqado_cambio_test_20261020'))
afterAll(async () => {
  for (const s of fixtures) await s.cleanup()
  await prisma.$disconnect()
})

describe('exchange transaction detail', () => {
  it('RF3: returnedQtyOrder counts a unit refunded through ANOTHER payment while legacy refundedQty stays per payment', async () => {
    const s = await seed({ quantity: 2, payments: [500, 500] })
    await refund(s, s.payments[1].id, 1, 50000)
    const d = await detail(s)
    expect(d.items[0]).toMatchObject({
      refundedQty: 0,
      remainingQty: 2,
      returnedQtyOrder: 1,
      remainingQtyOrder: 1,
      returnedCentsOrder: 50000,
      chargedTotalCents: 100000,
      quantity: 2,
    })
    expect(d.exchangeable).toBe(true)
  })

  it('the value of the next k pieces computed from the four numbers equals what a real exchange of those pieces charges', async () => {
    const s = await seed({ quantity: 3, paid: 350.01, payments: [700.02, 350.01] })
    await refund(s, s.payments[1].id, 1, 35001)
    const l = (await detail(s)).items[0]
    const values = pieceValuesCents(l.chargedTotalCents!, l.quantity, l.returnedQtyOrder!, l.returnedCentsOrder!, 2)
    expect(values).toEqual([35001, 35001])
    const b = s.body({ returned: [{ ...s.body().returned[0], quantity: 2 }], taken: [{ productId: s.products[1].id, quantity: 2 }] })
    const { exchange } = await createExchange(s.input(b))
    expect(exchange.lines.returned[0].pieceValuesCents).toEqual(values)
  })

  it('a line of 1,000,000 pieces serializes in O(1) and the value of the next 2 pieces matches parteDeUnidades', async () => {
    const s = await seed({ quantity: 1000000, paid: 0.01, list: 0.01 })
    const l = (await detail(s)).items[0]
    expect(l).not.toHaveProperty('remainingPieceValuesCents')
    expect(JSON.stringify(l).length).toBeLessThan(2000)
    const values = pieceValuesCents(l.chargedTotalCents!, l.quantity, l.returnedQtyOrder!, l.returnedCentsOrder!, 2)
    expect(values).toEqual([1, 1])
    expect(values.reduce((sum, v) => sum + v, 0)).toBe(parteDeUnidades(1000000, 1000000, 0, 2))
  })

  it('clips the next pieces against returned cents even when those cents exceed their quantity share', async () => {
    const s = await seed({ quantity: 3 })
    await refund(s, s.payments[0].id, 1, 120000)
    const l = (await detail(s)).items[0]
    expect(pieceValuesCents(l.chargedTotalCents!, l.quantity, l.returnedQtyOrder!, l.returnedCentsOrder!, 2)).toEqual([30000, 0])
  })

  it('after an exchange the original detail lists asOriginal and the new sale detail shows asNew', async () => {
    const s = await seed()
    const { exchange } = await createExchange(s.input())
    expect((await detail(s)).exchange).toEqual({
      asOriginal: [{ exchangeId: exchange.id, newOrderNumber: exchange.newOrderNumber, status: 'COMPLETED' }],
      asNew: null,
    })
    expect((await detail(s, exchange.paymentIds[0])).exchange).toEqual({
      asOriginal: [],
      asNew: { exchangeId: exchange.id, originalOrderNumber: s.order.orderNumber },
    })
  })

  it('an EC payment from cash cannot choose a refund method and inherits CASH', async () => {
    const s = await seed()
    const { exchange } = await createExchange(s.input())
    expect(await detail(s, exchange.paymentIds[0])).toMatchObject({
      tenderSystemKind: 'EXCHANGE_CREDIT',
      canChooseRefundMethod: false,
      chainRefundMethod: 'CASH',
      chainRefundLabel: expect.any(String),
      chainRefundBlockedCode: null,
      payoutOptions: [{ method: 'CASH', maxCents: 50000, maxSameCents: 50000, needsRefundToCash: false }],
    })
  })

  it('an EC from a terminal card shows the root as unavailable with EXCHANGE_CHAIN_NEEDS_TERMINAL', async () => {
    const s = await seed({ card: true })
    const { exchange } = await createExchange(s.input())
    expect(await detail(s, exchange.paymentIds[0])).toMatchObject({
      tenderSystemKind: 'EXCHANGE_CREDIT',
      chainRefundMethod: null,
      chainRefundBlockedCode: 'EXCHANGE_CHAIN_NEEDS_TERMINAL',
      chainRefundBlockedReason: 'PROCESSOR_ROOT',
      payoutOptions: [],
    })
  })

  it.each(['BANK_TRANSFER', 'OTHER'] as const)('EC from %s never offers CASH', async method => {
    const s = await seed()
    await prisma.payment.update({ where: { id: s.payments[0].id }, data: { method, fundsFlow: 'EXTERNAL_RECORDED' } })
    const { exchange } = await createExchange(s.input())
    const d = await detail(s, exchange.paymentIds[0])
    expect(d.chainRefundMethod).toBe(method)
    expect(d.payoutOptions.map(p => p.method)).not.toContain('CASH')
    expect(d.payoutOptions).toEqual(
      method === 'BANK_TRANSFER' ? [{ method: 'BANK_TRANSFER', maxCents: 50000, maxSameCents: 50000, needsRefundToCash: false }] : [],
    )
  })

  it('a missing EC root link leaves the detail readable with null chain fields', async () => {
    const s = await seed()
    const { exchange } = await createExchange(s.input())
    await prisma.exchangeCreditLink.deleteMany({ where: { venueId: s.venueId } })
    expect(await detail(s, exchange.paymentIds[0])).toMatchObject({
      chainRefundMethod: null,
      chainRefundLabel: null,
      exchangeable: false,
      chainRefundBlockedCode: 'EXCHANGE_SETTLEMENT_UNAVAILABLE',
    })
  })

  it('an EC from a gift-card root shows EXCHANGE_CHAIN_GIFT_CARD_PENDING without offering a payout', async () => {
    const s = await seed()
    const tender = await ensureGiftCardTender(prisma, s.venueId)
    await prisma.payment.update({
      where: { id: s.payments[0].id },
      data: { method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: tender.id },
    })
    const { exchange } = await createExchange(s.input())
    expect(await detail(s, exchange.paymentIds[0])).toMatchObject({
      chainRefundMethod: null,
      chainRefundLabel: null,
      chainRefundBlockedCode: 'EXCHANGE_CHAIN_GIFT_CARD_PENDING',
      chainRefundBlockedReason: null,
      payoutOptions: [],
    })
  })

  it('a cash 400 plus card 600 sale shows payoutOptions CASH 40000 and BANK_TRANSFER 40000', async () => {
    const s = await seed({ quantity: 2, payments: [400, 600] })
    await prisma.payment.update({
      where: { id: s.payments[1].id },
      data: { method: 'CREDIT_CARD', source: 'TPV', fundsFlow: 'AVOQADO_PROCESSED' },
    })
    expect((await detail(s)).payoutOptions).toEqual([
      { method: 'CASH', maxCents: 40000, maxSameCents: 40000, needsRefundToCash: false },
      { method: 'BANK_TRANSFER', maxCents: 40000, maxSameCents: 0, needsRefundToCash: false },
    ])
  })

  it('a fully returned sale is ALREADY_RETURNED and a REFUND row is NOT_A_SALE', async () => {
    const s = await seed()
    const r = await refund(s, s.payments[0].id, 1, 50000)
    expect(await detail(s)).toMatchObject({ exchangeable: false, notExchangeableReason: 'ALREADY_RETURNED' })
    expect(await detail(s, r.refundPaymentId)).toMatchObject({ exchangeable: false, notExchangeableReason: 'NOT_A_SALE' })
  })

  it('uses quantities of merchandise rather than the first non-merchandise block reason', async () => {
    const s = await seed()
    await prisma.product.update({ where: { id: s.products[3].id }, data: { type: 'CLASS' } })
    await prisma.orderItem.update({
      where: { id: s.order.items[0].id },
      data: { productId: s.products[3].id, productName: 'Clase', unitPrice: 0, total: 0 },
    })
    const merchandise = await prisma.orderItem.create({
      data: {
        orderId: s.order.id,
        productId: s.products[0].id,
        productName: 'Falda',
        quantity: 1,
        unitPrice: 500,
        taxAmount: 0,
        total: 500,
      },
    })
    await prisma.$transaction(tx =>
      writeRefundInTx(tx, {
        venueId: s.venueId,
        originalPaymentId: s.payments[0].id,
        salesRefundCents: 50000,
        tipRefundCents: 0,
        refundedItems: [
          { orderItemId: s.order.items[0].id, quantity: 1, amountCents: 0 },
          { orderItemId: merchandise.id, quantity: 1, amountCents: 50000 },
        ],
        reason: 'RETURNED_GOODS',
        staffId: s.staffId,
        tenderCommission: 'NONE',
        shift: 'CLAIM_LIVE',
      }),
    )
    const d = await detail(s)
    expect(d.items.find(l => l.id === s.order.items[0].id)?.notExchangeableReason).toBe('NOT_MERCHANDISE')
    expect(d).toMatchObject({ exchangeable: false, notExchangeableReason: 'ALREADY_RETURNED' })
  })

  it('a platform sale is blocked with DELIVERY_PLATFORM', async () => {
    const s = await seed()
    await prisma.order.update({ where: { id: s.order.id }, data: { source: 'UBER_EATS' } })
    expect(await detail(s)).toMatchObject({ exchangeable: false, notExchangeableReason: 'DELIVERY_PLATFORM' })
  })

  it('includes variant, inventory and current list price without changing legacy prices', async () => {
    const s = await seed({ paid: 350 })
    const d = await detail(s)
    expect(d.items[0]).toMatchObject({
      productId: s.products[0].id,
      productGroupId: expect.any(String),
      variantOptions: [expect.objectContaining({ name: 'Talla', value: 'M' })],
      restockable: true,
      chargedTotalCents: 35000,
      currentListPriceCents: 50000,
      total: 500,
      chargedTotal: 350,
      notExchangeableReason: null,
    })
    await prisma.inventory.deleteMany({ where: { venueId: s.venueId, productId: s.products[0].id } })
    expect((await detail(s)).items[0].restockable).toBe(false)
  })

  it('an oversized order returns NOT_ATTRIBUTABLE and still renders legacy items', async () => {
    const s = await seed()
    await prisma.orderItem.createMany({
      data: Array.from({ length: TOPES_POR_ORDEN.renglones }, () => ({
        orderId: s.order.id,
        productId: s.products[0].id,
        productName: 'Falda',
        quantity: 1,
        unitPrice: 0,
        taxAmount: 0,
        total: 0,
      })),
    })
    const d = await detail(s)
    expect(d).toMatchObject({ exchangeable: false, notExchangeableReason: 'NOT_ATTRIBUTABLE' })
    expect(d.items).toHaveLength(TOPES_POR_ORDEN.renglones + 1)
  })

  it('cannot read a payment from another venue', async () => {
    const s = await seed()
    const other = await seed()
    await expect(getTransactionDetail(other.venueId, s.payments[0].id)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('a processor root cannot offer cash even when its recorded method is CASH', async () => {
    const s = await seed({ card: true })
    const { exchange } = await createExchange(s.input())
    await prisma.payment.update({ where: { id: s.payments[0].id }, data: { method: 'CASH', source: 'POS', fundsFlow: 'CASH_DRAWER' } })
    expect(await detail(s, exchange.paymentIds[0])).toMatchObject({
      chainRefundMethod: null,
      chainRefundBlockedCode: 'EXCHANGE_CHAIN_NEEDS_TERMINAL',
      chainRefundBlockedReason: 'PROCESSOR_ROOT',
      payoutOptions: [],
    })
  })

  it('a fully returned payment keeps ALREADY_RETURNED even with status REFUNDED', async () => {
    const s = await seed()
    await refund(s, s.payments[0].id, 1, 50000)
    await prisma.payment.update({ where: { id: s.payments[0].id }, data: { status: 'REFUNDED' } })
    expect(await detail(s)).toMatchObject({ exchangeable: false, notExchangeableReason: 'ALREADY_RETURNED' })
  })

  it('caps original exchanges at the newest 50 with a deterministic order', async () => {
    const s = await seed()
    const { exchange } = await createExchange(s.input())
    const template = await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } })
    const ids: string[] = []
    const at = new Date()
    for (let i = 0; i < 51; i++) {
      const order = await prisma.order.create({
        data: { venueId: s.venueId, orderNumber: `new-${i}`, type: 'TAKEOUT', subtotal: 0, taxAmount: 0, total: 0 },
      })
      const e = await prisma.exchange.create({
        data: {
          venueId: s.venueId,
          idempotencyKey: `detail-${i}`,
          requestHash: template.requestHash,
          status: 'COMPLETED',
          originalOrderId: s.order.id,
          originalPaymentId: s.payments[0].id,
          newOrderId: order.id,
          returnedAmount: 0,
          takenAmount: 0,
          differenceAmount: 0,
          settlementKind: 'EVEN',
          lines: {},
          staffId: s.staffId,
          createdAt: at,
        },
      })
      ids.push(e.id)
    }
    const expected = ids.sort().reverse().slice(0, 50)
    expect((await detail(s)).exchange.asOriginal.map(e => e.exchangeId)).toEqual(expected)
    expect((await detail(s)).exchange.asOriginal.map(e => e.exchangeId)).toEqual(expected)
  })
})
