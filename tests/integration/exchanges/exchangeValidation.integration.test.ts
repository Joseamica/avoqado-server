import { type ProductType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import { seedClothingSale } from './seedExchange'

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
const counts = async (s: Seed) =>
  Promise.all([
    prisma.order.count({ where: { venueId: s.venueId } }),
    prisma.payment.count({ where: { venueId: s.venueId } }),
    prisma.exchange.count({ where: { venueId: s.venueId } }),
    prisma.inventoryPosting.count({ where: { venueId: s.venueId } }),
  ])
const blocked = async (s: Seed, reason: string, message: string, orderItemId: string | null = s.order.items[0].id) => {
  const before = await counts(s)
  await expect(createExchange(s.input())).rejects.toMatchObject({
    statusCode: 422,
    code: 'EXCHANGE_ITEM_NOT_RETURNABLE',
    message,
    details: { orderItemId, reason },
  })
  expect(await counts(s)).toEqual(before)
}
beforeAll(() => expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_cambio_(r5_)?test_202610(20|24)$/))
afterAll(async () => {
  for (const s of fixtures) await s.cleanup()
  await prisma.$disconnect()
})

async function refundOne(s: Seed) {
  return prisma.$transaction(tx =>
    writeRefundInTx(tx, {
      venueId: s.venueId,
      originalPaymentId: s.payments[1].id,
      salesRefundCents: 50000,
      tipRefundCents: 0,
      refundedItems: [{ orderItemId: s.order.items[0].id, quantity: 1, amountCents: 50000 }],
      reason: 'RETURNED_GOODS',
      staffId: s.staffId,
      tenderCommission: 'NONE',
      shift: 'CLAIM_LIVE',
    }),
  )
}
async function promotion(s: Seed) {
  const p = await prisma.promotion.create({ data: { venueId: s.venueId, name: '2x1', type: 'BUNDLE', pricingMode: 'FIXED_TOTAL' } })
  const op = await prisma.orderPromotion.create({
    data: {
      orderId: s.order.id,
      promotionId: p.id,
      instanceId: s.venueId,
      snapshotJson: { name: '2x1' },
      grossCents: 100000,
      discountCents: 0,
      netCents: 100000,
    },
  })
  await prisma.orderItem.update({ where: { id: s.order.items[0].id }, data: { orderPromotionId: op.id } })
  return op
}

describe('exchange validation RF3/RF4', () => {
  it('identifies the partially returned second promotion, not the complete first one', async () => {
    const s = await seed({ quantity: 3 })
    await promotion(s)
    await prisma.orderItem.update({ where: { id: s.order.items[0].id }, data: { quantity: 1, total: 500 } })
    const p = await prisma.promotion.create({ data: { venueId: s.venueId, name: 'Segunda', type: 'BUNDLE', pricingMode: 'FIXED_TOTAL' } })
    const op = await prisma.orderPromotion.create({
      data: {
        orderId: s.order.id,
        promotionId: p.id,
        instanceId: s.venueId + '-B',
        snapshotJson: { name: 'Segunda' },
        grossCents: 100000,
        discountCents: 0,
        netCents: 100000,
      },
    })
    const second = await prisma.orderItem.create({
      data: {
        orderId: s.order.id,
        productId: s.products[0].id,
        productName: 'Segunda promoción',
        quantity: 2,
        unitPrice: 500,
        total: 1000,
        taxAmount: 0,
        orderPromotionId: op.id,
      },
    })
    await expect(
      createExchange(
        s.input(
          s.body({
            returned: [
              s.body().returned[0],
              {
                orderItemId: second.id,
                quantity: 1,
                restock: false,
                reason: 'SIZE',
              },
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'EXCHANGE_ITEM_NOT_RETURNABLE', details: { reason: 'PROMOTION_PARTIAL', orderItemId: second.id } })
  })

  it('RF3: rejects both units after a refund through the other payment, with the remaining quantity', async () => {
    const s = await seed({ quantity: 2, payments: [500, 500] })
    await refundOne(s)
    const b = s.body({ returned: [{ orderItemId: s.order.items[0].id, quantity: 2, restock: true, reason: 'SIZE' }] })
    await expect(createExchange(s.input(b))).rejects.toMatchObject({
      statusCode: 422,
      code: 'EXCHANGE_ITEM_NOT_RETURNABLE',
      message: 'De este artículo sólo quedan 1 por devolver.',
      details: { orderItemId: s.order.items[0].id, reason: 'ALREADY_RETURNED' },
    })
  })
  it('RF3: accepts the remaining unit and draws credit from the opened payment', async () => {
    const s = await seed({ quantity: 2, payments: [500, 500] })
    await refundOne(s)
    const { exchange } = await createExchange(s.input())
    const refund = await prisma.payment.findUniqueOrThrow({ where: { id: exchange.refundPaymentIds[0] } })
    expect(refund.processorData).toMatchObject({ originalPaymentId: s.payments[0].id })
    await blocked(s, 'ALREADY_RETURNED', 'Ya se devolvió todo lo de este artículo.')
  })
  it('RF4: returns the complete new calculation and writes no business rows when a price changed', async () => {
    const s = await seed()
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 550 } })
    const before = await counts(s)
    const b = s.body({ taken: [{ productId: s.products[3].id, quantity: 1 }] })
    await expect(createExchange(s.input(b))).rejects.toMatchObject({
      statusCode: 409,
      code: 'EXCHANGE_DIFFERENCE_CHANGED',
      details: {
        calculation: {
          returnedCents: 50000,
          takenCents: 55000,
          differenceCents: 5000,
          kind: 'COLLECT',
          lines: { returned: [expect.objectContaining({ valueCents: 50000 })], taken: [expect.objectContaining({ priceCents: 55000 })] },
        },
      },
    })
    expect(await counts(s)).toEqual(before)
  })
  it('RF4: recomputes V3 inheritance from 350 at list 500 to XL at list 550 as 385', async () => {
    const s = await seed({ paid: 350 })
    await prisma.product.update({ where: { id: s.products[2].id }, data: { price: 550 } })
    const b = s.body({ taken: [{ productId: s.products[2].id, quantity: 1, displayedUnitPriceCents: 1 }] })
    await expect(createExchange(s.input(b))).rejects.toMatchObject({
      code: 'EXCHANGE_DIFFERENCE_CHANGED',
      details: {
        calculation: { returnedCents: 35000, takenCents: 38500, differenceCents: 3500, kind: 'COLLECT' },
      },
    })
  })
  it('honors a non-inherited piece shown at 45000 while the catalog is 50000 and calculates PAYOUT 5000', async () => {
    const s = await seed()
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 450 } })
    const catalogAt = new Date().toISOString()
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 500 } })
    const taken = [{ productId: s.products[3].id, quantity: 1, displayedUnitPriceCents: 45000, catalogAt }]
    await expect(createExchange(s.input(s.body({ taken })))).rejects.toMatchObject({
      code: 'EXCHANGE_DIFFERENCE_CHANGED',
      details: {
        calculation: { takenCents: 45000, differenceCents: -5000, kind: 'PAYOUT' },
      },
    })
    const { exchange } = await createExchange(
      s.input(s.body({ taken, settlement: { kind: 'PAYOUT', method: 'CASH', expectedDifferenceCents: -5000 } })),
    )
    expect(exchange).toMatchObject({
      status: 'COMPLETED',
      takenCents: 45000,
      differenceCents: -5000,
      settlement: { kind: 'PAYOUT', method: 'CASH', amountCents: 5000 },
    })
  })
  it('persists the honored price on the new non-inherited sale line', async () => {
    const s = await seed({ paid: 450 })
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 450 } })
    const catalogAt = new Date().toISOString()
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 500 } })
    const b = s.body({ taken: [{ productId: s.products[3].id, quantity: 1, displayedUnitPriceCents: 45000, catalogAt }] })
    const { exchange } = await createExchange(s.input(b))
    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: exchange.newOrderId } })
    expect([line.unitPrice, line.total, line.discountAmount].map(Number)).toEqual([450, 450, 0])
  })
  it.each(['expired', 'invented', 'other venue', 'lower current'])('uses the catalog for %s shown prices', async mode => {
    const s = await seed()
    const p = s.products[3]
    let catalogAt = new Date().toISOString()
    if (mode === 'expired') {
      await prisma.product.update({ where: { id: p.id }, data: { price: 450 } })
      await prisma.product.update({ where: { id: p.id }, data: { price: 500 } })
      catalogAt = new Date(Date.now() - 73 * 3600000).toISOString()
    }
    if (mode === 'other venue') {
      const other = await seed()
      await prisma.product.update({ where: { id: other.products[3].id }, data: { price: 450 } })
    }
    if (mode === 'lower current') await prisma.product.update({ where: { id: p.id }, data: { price: 400 } })
    const b = s.body({
      taken: [{ productId: p.id, quantity: 1, displayedUnitPriceCents: 45000, catalogAt }],
      settlement: { kind: 'EVEN', method: null, expectedDifferenceCents: 123 },
    })
    await expect(createExchange(s.input(b))).rejects.toMatchObject({
      code: 'EXCHANGE_DIFFERENCE_CHANGED',
      details: {
        calculation: { takenCents: mode === 'lower current' ? 40000 : 50000 },
      },
    })
  })
  it('sums duplicate return entries before checking the order-wide remaining quantity', async () => {
    const s = await seed()
    const b = s.body({ returned: [s.body().returned[0], s.body().returned[0]] })
    await expect(createExchange(s.input(b))).rejects.toMatchObject({
      code: 'EXCHANGE_ITEM_NOT_RETURNABLE',
      details: { reason: 'ALREADY_RETURNED', orderItemId: s.order.items[0].id },
    })
  })
  it('uses shown price only for the unpaired piece in a mixed inherited line', async () => {
    const s = await seed({ paid: 350 })
    await prisma.product.update({ where: { id: s.products[1].id }, data: { price: 450 } })
    const catalogAt = new Date().toISOString()
    await prisma.product.update({ where: { id: s.products[1].id }, data: { price: 500 } })
    const b = s.body({ taken: [{ productId: s.products[1].id, quantity: 2, displayedUnitPriceCents: 45000, catalogAt }] })
    await expect(createExchange(s.input(b))).rejects.toMatchObject({
      code: 'EXCHANGE_DIFFERENCE_CHANGED',
      details: {
        calculation: {
          returnedCents: 35000,
          takenCents: 80000,
          differenceCents: 45000,
          lines: {
            taken: [
              expect.objectContaining({
                pieces: [
                  { priceCents: 35000, inheritedFromOrderItemId: s.order.items[0].id },
                  { priceCents: 45000, inheritedFromOrderItemId: null },
                ],
              }),
            ],
          },
        },
      },
    })
  })
  it.each([
    ['CLASS', 'NOT_MERCHANDISE', 'Las citas, clases, eventos y productos digitales no se cambian.'],
    ['APPOINTMENTS_SERVICE', 'NOT_MERCHANDISE', 'Las citas, clases, eventos y productos digitales no se cambian.'],
    ['EVENT', 'NOT_MERCHANDISE', 'Las citas, clases, eventos y productos digitales no se cambian.'],
    ['DIGITAL', 'NOT_MERCHANDISE', 'Las citas, clases, eventos y productos digitales no se cambian.'],
    ['WEIGHT', 'SOLD_BY_WEIGHT', 'Los productos por peso no se cambian.'],
    ['UBER', 'DELIVERY_PLATFORM', 'Los pedidos de plataformas se cambian en la plataforma.'],
    ['PROMOTION', 'PROMOTION_PARTIAL', 'Una promoción se cambia completa: incluye todos sus artículos.'],
    ['UNATTRIBUTABLE', 'NOT_ATTRIBUTABLE', 'No se puede saber cuánto se cobró por este artículo; haz una devolución por importe.'],
    ['SERIALIZED', 'SERIALIZED_ITEM', 'Los artículos con número de serie no se cambian.'],
    ['GIFT', 'GIFT_CARD_SALE', 'Las tarjetas de regalo no se cambian; se cancelan desde su propia opción.'],
    ['UNPAID', 'NOT_PAID', 'Esta venta no está cobrada.'],
  ])('%s is rejected with its specific Spanish explanation', async (kind, reason, message) => {
    const s = await seed(kind === 'PROMOTION' ? { quantity: 2 } : undefined)
    if (['CLASS', 'APPOINTMENTS_SERVICE', 'EVENT', 'DIGITAL'].includes(kind)) {
      await prisma.orderItem.update({ where: { id: s.order.items[0].id }, data: { productId: s.products[3].id } })
      await prisma.product.update({ where: { id: s.products[3].id }, data: { type: kind as ProductType } })
    }
    if (kind === 'WEIGHT') await prisma.product.update({ where: { id: s.products[0].id }, data: { soldByWeight: true } })
    if (kind === 'UBER') await prisma.order.update({ where: { id: s.order.id }, data: { source: 'UBER_EATS' } })
    if (kind === 'UNPAID') await prisma.order.update({ where: { id: s.order.id }, data: { paymentStatus: 'PENDING' } })
    if (kind === 'UNATTRIBUTABLE') await prisma.order.update({ where: { id: s.order.id }, data: { discountAmount: 600 } })
    if (kind === 'PROMOTION') await promotion(s)
    if (kind === 'SERIALIZED') {
      const cat = await prisma.itemCategory.create({ data: { venueId: s.venueId, name: 'Serializados' } })
      await prisma.orderItem.update({ where: { id: s.order.items[0].id }, data: { productId: null } })
      await prisma.serializedItem.create({
        data: { venueId: s.venueId, categoryId: cat.id, serialNumber: s.venueId, createdBy: s.staffId, orderItemId: s.order.items[0].id },
      })
    }
    if (kind === 'GIFT') {
      const card = await prisma.giftCard.create({
        data: {
          venueId: s.venueId,
          organizationId: s.organizationId,
          codeHash: s.venueId,
          codeEnc: 'fixture',
          codeLast4: '1234',
          pageToken: s.venueId,
          initialAmount: 500,
          balance: 500,
          termsVersion: 'v1',
          deliveryChannel: 'PRINTED',
        },
      })
      const line = await prisma.orderItem.create({
        data: {
          orderId: s.order.id,
          productName: 'Tarjeta',
          quantity: 1,
          unitPrice: 500,
          total: 500,
          taxAmount: 0,
          giftCardId: card.id,
          ivaTratamiento: 'NO_OBJETO',
        },
      })
      await prisma.orderItem.delete({ where: { id: s.order.items[0].id } })
      s.order.items[0] = line
    }
    await blocked(s, reason, message, ['UBER', 'UNATTRIBUTABLE', 'UNPAID'].includes(kind) ? null : s.order.items[0].id)
  })
  it('rejects a subset of promotion lines and accepts the whole promotion', async () => {
    const s = await seed({ quantity: 2 })
    const op = await promotion(s)
    await prisma.orderItem.update({ where: { id: s.order.items[0].id }, data: { quantity: 1, total: 500 } })
    const second = await prisma.orderItem.create({
      data: {
        orderId: s.order.id,
        productId: s.products[0].id,
        productName: 'Falda M',
        quantity: 1,
        unitPrice: 500,
        total: 500,
        taxAmount: 0,
        orderPromotionId: op.id,
      },
    })
    await blocked(s, 'PROMOTION_PARTIAL', 'Una promoción se cambia completa: incluye todos sus artículos.', null)
    const b = s.body({
      returned: [s.body().returned[0], { orderItemId: second.id, quantity: 1, restock: true, reason: 'SIZE' }],
      taken: [{ productId: s.products[1].id, quantity: 2 }],
    })
    expect((await createExchange(s.input(b))).exchange.returnedCents).toBe(100000)
  })
  it('rejects sales exceeding the bounded payment loader with null orderItemId', async () => {
    const s = await seed({ paid: 1, list: 1, quantity: 51, payments: Array<number>(51).fill(1) })
    await blocked(s, 'NOT_ATTRIBUTABLE', 'No se puede saber cuánto se cobró por este artículo; haz una devolución por importe.', null)
  })
  it('restaurant defaults off and explicit true enables the exchange', async () => {
    const s = await seed()
    await prisma.venue.update({ where: { id: s.venueId }, data: { type: 'RESTAURANT' } })
    await expect(createExchange(s.input())).rejects.toMatchObject({ statusCode: 422, code: 'EXCHANGES_DISABLED' })
    await prisma.venueSettings.upsert({
      where: { venueId: s.venueId },
      create: { venueId: s.venueId, exchangesEnabled: true },
      update: { exchangesEnabled: true },
    })
    expect((await createExchange(s.input())).exchange.status).toBe('COMPLETED')
  })
  it.each(['NOT_FOUND', 'ARCHIVED', 'INACTIVE', 'NOT_MERCHANDISE', 'SOLD_BY_WEIGHT'])(
    'rejects taken merchandise with reason %s',
    async reason => {
      const s = await seed()
      let productId = s.products[3].id
      if (reason === 'NOT_FOUND') productId = s.order.id
      else
        await prisma.product.update({
          where: { id: productId },
          data:
            reason === 'ARCHIVED'
              ? { deletedAt: new Date() }
              : reason === 'INACTIVE'
                ? { active: false }
                : reason === 'NOT_MERCHANDISE'
                  ? { type: 'CLASS' }
                  : { soldByWeight: true },
        })
      await expect(createExchange(s.input(s.body({ taken: [{ productId, quantity: 1 }] })))).rejects.toMatchObject({
        statusCode: 422,
        code: 'EXCHANGE_TAKEN_NOT_SELLABLE',
        message: 'Este producto no se puede vender ahora (archivado, apagado o no es mercancía).',
        details: { productId, reason },
      })
    },
  )
  it('returns 404 for a REFUND row passed as the original payment', async () => {
    const s = await seed({ quantity: 2, payments: [500, 500] })
    const refund = await refundOne(s)
    await expect(createExchange(s.input(s.body({ originalPaymentId: refund.refundPaymentId })))).rejects.toMatchObject({ statusCode: 404 })
  })
})
