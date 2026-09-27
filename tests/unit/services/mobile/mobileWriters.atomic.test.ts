/**
 * Plan3b T4 — mobile money writers on an EXISTING order (order discount, split, split by seat, promotion, loyalty and
 * stamp redemptions) and the money written while `createOrderWithItems` creates a sale.
 *
 * Contract: canonical Order lock first (scoped to the ROUTE venue), every decision from the locked read, children and
 * totals on that SAME tx, audits only after commit. The tx double and the global client are DIFFERENT objects, so any
 * escape to the global client fails here instead of hiding behind a shared double.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import {
  applyOrderDiscount,
  createOrderWithItems,
  removeOrderDiscount,
  splitOrderBySeat,
  splitOrderItems,
} from '@/services/mobile/order.mobile.service'
import * as promotionService from '@/services/promotions/promotion.service'
import { redeemPointsToOrder } from '@/services/mobile/loyalty.mobile.service'
import * as stampService from '@/services/wallet/redeemStampReward.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { notifyCustomerPassUpdated } from '@/services/wallet/notifyPassUpdated.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const ORDER = {
  id: 'order',
  venueId: 'venue',
  orderNumber: 'ORD-1',
  status: 'PENDING',
  paymentStatus: 'PENDING',
  subtotal: 150,
  discountAmount: 20,
  paidAmount: 7,
  tableId: 't1',
  covers: 2,
  servedById: 'staff',
  type: 'DINE_IN',
  shiftId: 'shift',
  contratoDePrecio: 'IVA_INCLUIDO',
  customerId: 'customer',
  items: [
    { id: 'i1', orderPromotionId: null, seat: 1 },
    { id: 'i2', orderPromotionId: null, seat: 2 },
  ],
  orderDiscounts: [],
  serviceCharges: [],
}
const PROMOTION = {
  id: 'promo',
  venueId: 'venue',
  name: 'Combo',
  type: 'BUNDLE',
  pricingMode: 'FIXED_TOTAL',
  priceCents: 9000,
  status: 'PUBLISHED',
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  groups: [
    {
      id: 'g1',
      name: 'Plato',
      options: [
        {
          id: 'o1',
          productId: 'p1',
          quantity: 1,
          chargedQuantity: 1,
          priceDeltaCents: 0,
          product: { price: 100, venueId: 'venue', name: 'Plato', sku: null, category: null },
        },
      ],
    },
  ],
}
const promoParams = {
  venueId: 'venue',
  orderId: 'order',
  promotionId: 'promo',
  instanceId: 'instance',
  selections: [{ groupId: 'g1', optionId: 'o1' }],
  soldAt: new Date('2026-09-27T18:00:00Z'),
}
const CONFIG = {
  id: 'config',
  venueId: 'venue',
  active: true,
  minPointsRedeem: 100,
  redemptionRate: new Prisma.Decimal(0.01),
  pointsPerDollar: new Prisma.Decimal(1),
}
const REWARD = {
  id: 'rw',
  venueId: 'venue',
  customerId: 'customer',
  status: 'PENDING',
  rewardType: 'FIXED_AMOUNT',
  rewardValue: 50,
  rewardLabel: 'Premio',
  expiresAt: null,
}

let tx: any
let committed: boolean
const MODELS = [
  'order',
  'orderItem',
  'orderDiscount',
  'orderServiceCharge',
  'orderPromotion',
  'promotion',
  'venue',
  'discount',
  'customer',
  'loyaltyTransaction',
  'staffVenue',
  'stampReward',
  'shift',
]
const WRITES = ['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany']

const writers = {
  applyDiscount: () => applyOrderDiscount('venue', 'order', 'disc', 'staff'),
  removeDiscount: () => removeOrderDiscount('venue', 'order', 'od', 'staff'),
  split: () => splitOrderItems('venue', 'order', ['i1'], 'staff'),
  splitBySeat: () => splitOrderBySeat('venue', 'order', 'staff'),
  applyPromotion: () => promotionService.applyPromotionToOrder(promoParams),
  removePromotion: () => promotionService.removePromotionFromOrder({ venueId: 'venue', orderId: 'order', orderPromotionId: 'op' }),
  redeemPoints: () => redeemPointsToOrder('venue', 'order', 'customer', 1000, 'staff'),
  redeemStamp: () => stampService.redeemStampReward('venue', 'order', 'rw', { staffId: 'staff' }),
}
type Writer = keyof typeof writers
const ALL = Object.keys(writers) as Writer[]
const AUDITED: Writer[] = ['applyDiscount', 'removeDiscount', 'split', 'splitBySeat', 'redeemPoints', 'redeemStamp']

/** remainingBalance of the recalculated Order: 150 of lines − fallback discount − locked paidAmount (7). */
const LOCKED_REMAINING: Record<Writer, number> = {
  applyDiscount: 143,
  removeDiscount: 143,
  split: 143,
  splitBySeat: 143,
  // Promotions keep the inherited discount (20) read under the lock as their fallback.
  applyPromotion: 123,
  removePromotion: 123,
  redeemPoints: 143,
  redeemStamp: 143,
}
const PAID_MESSAGE: Record<Writer, string> = {
  applyDiscount: 'No se puede descontar una orden ya pagada',
  removeDiscount: 'No se puede modificar una orden ya pagada',
  split: 'No se puede separar una cuenta ya pagada',
  splitBySeat: 'No se puede dividir una cuenta ya pagada',
  applyPromotion: 'A una cuenta ya pagada no se le pueden agregar promociones.',
  removePromotion: 'Esta cuenta ya se pagó: retira la promoción con un reembolso, no borrándola.',
  redeemPoints: 'No se puede modificar una orden ya pagada',
  redeemStamp: 'No se puede aplicar un premio a una cuenta ya pagada.',
}
const NOT_FOUND_MESSAGE: Record<Writer, string> = {
  applyDiscount: 'Order not found',
  removeDiscount: 'Order not found',
  split: 'Order not found',
  splitBySeat: 'Order not found',
  applyPromotion: 'No encontramos esa cuenta en este establecimiento.',
  removePromotion: 'No encontramos esa promoción en la cuenta.',
  redeemPoints: 'Orden no encontrada',
  redeemStamp: 'Orden no encontrada',
}

function model() {
  return Object.fromEntries(['findUnique', 'findFirst', 'findMany', ...WRITES].map(name => [name, jest.fn()])) as Record<string, jest.Mock>
}
function txCallOrders(except: jest.Mock[] = []): number[] {
  return MODELS.flatMap(name => Object.values(tx[name] as Record<string, jest.Mock>))
    .filter(fn => !except.includes(fn))
    .flatMap(fn => fn.mock.invocationCallOrder)
}
function txWrites(): string[] {
  return MODELS.flatMap(name => WRITES.filter(op => tx[name][op].mock.calls.length > 0).map(op => `${name}.${op}`))
}
function paidOrder() {
  tx.order.findFirst.mockResolvedValue({ ...ORDER, paymentStatus: 'PAID' })
  tx.orderPromotion.findFirst.mockResolvedValue({ id: 'op', order: { paymentStatus: 'PAID', discountAmount: 20, paidAmount: 150 } })
}

beforeEach(() => {
  jest.clearAllMocks()
  committed = false
  tx = { $queryRaw: jest.fn().mockResolvedValue([{ id: 'order' }]), ...Object.fromEntries(MODELS.map(name => [name, model()])) }
  tx.order.findFirst.mockResolvedValue({ ...ORDER })
  tx.order.create.mockResolvedValue({ id: 'child', orderNumber: 'ORD-2', version: 1 })
  tx.order.update.mockImplementation(async ({ data }: any) => ({
    subtotal: data.subtotal ?? 0,
    discountAmount: data.discountAmount ?? 0,
    serviceChargeAmount: data.serviceChargeAmount ?? 0,
    total: data.total ?? 0,
    version: 2,
  }))
  // Recalculation reads the lines; FREE_PRODUCT reads their unit prices — both through the tx.
  tx.orderItem.findMany.mockResolvedValue([
    { total: 100, orderPromotionId: null, unitPrice: 100 },
    { total: 50, orderPromotionId: null, unitPrice: 50 },
  ])
  tx.orderItem.updateMany.mockResolvedValue({ count: 1 })
  tx.orderItem.createMany.mockResolvedValue({ count: 1 })
  tx.orderItem.deleteMany.mockResolvedValue({ count: 1 })
  tx.orderDiscount.findMany.mockResolvedValue([])
  tx.orderDiscount.findFirst.mockImplementation(async ({ where }: any) =>
    where.id === 'od' ? { id: 'od', orderId: 'order', name: 'Recompensas', amount: 10, loyaltyTransactionId: 'lt' } : null,
  )
  tx.orderDiscount.create.mockResolvedValue({ id: 'od-new', name: 'Diez', amount: 15 })
  tx.orderServiceCharge.findMany.mockResolvedValue([])
  tx.orderPromotion.findUnique.mockResolvedValue(null)
  tx.orderPromotion.findFirst.mockResolvedValue({ id: 'op', order: { paymentStatus: 'PENDING', discountAmount: 20, paidAmount: 7 } })
  tx.orderPromotion.create.mockResolvedValue({ id: 'op-new' })
  tx.orderPromotion.updateMany.mockResolvedValue({ count: 0 })
  tx.promotion.findFirst.mockResolvedValue(PROMOTION)
  tx.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  tx.discount.findFirst.mockResolvedValue({
    id: 'disc',
    venueId: 'venue',
    name: 'Diez',
    type: 'PERCENTAGE',
    value: 10,
    scope: 'ORDER',
    active: true,
    validFrom: null,
    validUntil: null,
    maxTotalUses: null,
    currentUses: 0,
  })
  tx.customer.findFirst.mockResolvedValue({ id: 'customer', loyaltyPoints: 5000 })
  tx.customer.updateMany.mockResolvedValue({ count: 1 })
  tx.loyaltyTransaction.create.mockResolvedValue({ id: 'lt-new' })
  tx.loyaltyTransaction.findUnique.mockResolvedValue({ id: 'lt', customerId: 'customer', points: -1000, orderId: 'order' })
  tx.staffVenue.findUnique.mockResolvedValue({ id: 'sv' })
  tx.stampReward.findFirst.mockImplementation(async ({ where }: any) =>
    where.orderDiscountId ? { id: 'rw-od', customerId: 'customer', rewardLabel: 'Premio' } : { ...REWARD },
  )
  tx.stampReward.updateMany.mockResolvedValue({ count: 1 })
  tx.shift.findFirst.mockResolvedValue(null)

  prismaMock.$transaction.mockImplementation(async (callback: any) => {
    const result = await callback(tx)
    committed = true
    return result
  })
  // Venue configuration is not Order data: it may be read before the lock.
  prismaMock.loyaltyConfig.findUnique.mockResolvedValue(CONFIG)
  // The response's balance is read after commit.
  prismaMock.customer.findUnique.mockResolvedValue({ loyaltyPoints: 4000 })
  // Every Order/child/reward read or write on the GLOBAL client is an escape from the lock.
  for (const [name, ops] of Object.entries({
    order: ['findFirst', 'findUnique', 'update', 'updateMany', 'create'],
    orderItem: ['findMany', 'updateMany', 'createMany', 'deleteMany'],
    orderDiscount: ['findFirst', 'create', 'delete'],
    orderPromotion: ['findUnique', 'findFirst', 'create', 'delete', 'updateMany'],
    promotion: ['findFirst'],
    discount: ['findFirst'],
    customer: ['findFirst', 'updateMany', 'update'],
    loyaltyTransaction: ['create'],
    staffVenue: ['findUnique'],
    stampReward: ['findFirst', 'updateMany', 'update'],
  })) {
    for (const op of ops) prismaMock[name][op].mockRejectedValue(new Error(`GLOBAL ${name}.${op}`))
  }
  ;(logAction as jest.Mock).mockImplementation(() => {
    expect(committed).toBe(true)
  })
  ;(notifyCustomerPassUpdated as jest.Mock).mockImplementation(() => {
    expect(committed).toBe(true)
  })
})

describe('locked mobile writers', () => {
  it.each(ALL)('%s locks the route venue Order before any tx access and recalculates on that tx with locked paidAmount', async name => {
    await writers[name]()

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(committed).toBe(true)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    // Tagged template: [strings, orderId, venueId] — the ROUTE venue, never one taken from the Order itself.
    expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['order', 'venue'])
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(Math.min(...txCallOrders()))
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order' },
        data: expect.objectContaining({ remainingBalance: LOCKED_REMAINING[name] }),
      }),
    )
  })

  it.each(ALL)('%s rejects PAID seen only by the locked read and writes nothing', async name => {
    paidOrder()

    await expect(writers[name]()).rejects.toThrow(PAID_MESSAGE[name])

    expect(committed).toBe(false)
    expect(txWrites()).toEqual([])
    expect(logAction).not.toHaveBeenCalled()
  })

  it.each(ALL)('%s treats an Order the lock cannot see (missing/other venue) as not found and writes nothing', async name => {
    tx.$queryRaw.mockResolvedValue([])

    await expect(writers[name]()).rejects.toMatchObject({ statusCode: 404, message: NOT_FOUND_MESSAGE[name] })

    expect(txWrites()).toEqual([])
  })

  it.each(AUDITED)('%s propagates a failed total write before commit and never audits it', async name => {
    tx.order.update.mockRejectedValue(new Error('total write failed'))

    await expect(writers[name]()).rejects.toThrow('total write failed')

    expect(committed).toBe(false)
    expect(logAction).not.toHaveBeenCalled()
    expect(notifyCustomerPassUpdated).not.toHaveBeenCalled()
  })
})

describe('writer-specific fresh decisions', () => {
  it('applyDiscount caps against the locked subtotal/discount and reads the catalog rule on the tx', async () => {
    tx.order.findFirst.mockResolvedValue({ ...ORDER, subtotal: 150, discountAmount: 145 })

    await applyOrderDiscount('venue', 'order', 'disc', 'staff')

    expect(tx.discount.findFirst).toHaveBeenCalledWith({ where: { id: 'disc', venueId: 'venue' } })
    // 10 % of 150 = 15, but only 150 − 145 = 5 is still discountable on the locked photo.
    expect(tx.orderDiscount.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: 5 }) }))
  })

  it('removeDiscount refunds points and returns the stamp reward on the locked tx, after the Order lock', async () => {
    const result = await removeOrderDiscount('venue', 'order', 'od', 'staff')

    expect(result).toMatchObject({ total: 150 })
    const lock = tx.$queryRaw.mock.invocationCallOrder[0]
    expect(tx.customer.update).toHaveBeenCalledWith({ where: { id: 'customer' }, data: { loyaltyPoints: { increment: 1000 } } })
    expect(tx.customer.update.mock.invocationCallOrder[0]).toBeGreaterThan(lock)
    expect(tx.stampReward.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rw-od' }, data: expect.objectContaining({ status: 'PENDING' }) }),
    )
    expect(tx.stampReward.update.mock.invocationCallOrder[0]).toBeGreaterThan(lock)
    expect(tx.orderDiscount.delete).toHaveBeenCalledWith({ where: { id: 'od' } })
  })

  it('split decides "at least one item stays" from the locked lines', async () => {
    tx.order.findFirst.mockResolvedValue({ ...ORDER, items: [{ id: 'i1', orderPromotionId: null, seat: 1 }] })

    await expect(splitOrderItems('venue', 'order', ['i1'], 'staff')).rejects.toThrow(
      'Debe quedar al menos un artículo en la cuenta original',
    )
    expect(txWrites()).toEqual([])
  })

  it('split moves a complete combo and its instance using the locked lines', async () => {
    tx.order.findFirst.mockResolvedValue({
      ...ORDER,
      items: [
        { id: 'c1', orderPromotionId: 'op1', seat: null },
        { id: 'c2', orderPromotionId: 'op1', seat: null },
        { id: 'n1', orderPromotionId: null, seat: null },
      ],
    })

    await expect(splitOrderItems('venue', 'order', ['c1'], 'staff')).rejects.toThrow(/completa/)
    await splitOrderItems('venue', 'order', ['c1', 'c2'], 'staff')

    expect(tx.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] }, orderId: 'order' },
      data: { orderId: 'child' },
    })
    expect(tx.orderPromotion.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['op1'] }, orderId: 'order' },
      data: { orderId: 'child' },
    })
  })

  it('splitBySeat groups the locked seats', async () => {
    tx.order.findFirst.mockResolvedValue({
      ...ORDER,
      items: [
        { id: 'i1', orderPromotionId: null, seat: 1 },
        { id: 'i2', orderPromotionId: null, seat: 2 },
        { id: 'i3', orderPromotionId: null, seat: 3 },
      ],
    })

    const result = await splitOrderBySeat('venue', 'order', 'staff')

    expect(tx.order.create).toHaveBeenCalledTimes(2)
    expect(result.created.map(c => c.seat)).toEqual([2, 3])
    expect(tx.orderItem.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['i3'] }, orderId: 'order' }, data: { orderId: 'child' } })
  })

  it('applyPromotion answers a replayed instance from the locked read, before the PAID guard, writing nothing', async () => {
    tx.orderPromotion.findUnique.mockResolvedValue({ id: 'op-prev', netCents: 9000 })
    paidOrder()

    await expect(promotionService.applyPromotionToOrder(promoParams)).resolves.toEqual({
      orderPromotionId: 'op-prev',
      netCents: 9000,
      created: false,
    })
    expect(tx.orderPromotion.findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
    expect(txWrites()).toEqual([])
  })

  it('applyPromotion with a caller tx opens no transaction and does every read and write on that tx', async () => {
    const result = await promotionService.applyPromotionToOrder(promoParams, tx)

    expect(result).toEqual({ orderPromotionId: 'op-new', netCents: 9000, created: true })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.orderPromotion.create).toHaveBeenCalledTimes(1)
    expect(tx.orderItem.createMany).toHaveBeenCalledTimes(1)
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ discountAmount: 20 }) }))
  })

  it('applyPromotion with a caller tx rethrows a unique violation without querying a winner on the global client', async () => {
    const unique = Object.assign(new Error('unique'), { code: 'P2002' })
    tx.orderPromotion.create.mockRejectedValue(unique)

    await expect(promotionService.applyPromotionToOrder(promoParams, tx)).rejects.toBe(unique)
    expect(prismaMock.orderPromotion.findUnique).not.toHaveBeenCalled()
  })

  it('redeemPoints caps from the locked base and burns with the customer CAS after the Order lock', async () => {
    tx.order.findFirst.mockResolvedValue({ ...ORDER, subtotal: 25, discountAmount: 20 })

    const result = await redeemPointsToOrder('venue', 'order', 'customer', 1000, 'staff')

    // 1000 points × 0.01 = 10, but the locked base is 25 − 20 = 5 → only 500 points burn.
    expect(result).toMatchObject({ pointsRedeemed: 500, discountAmount: 5, newBalance: 4000 })
    expect(tx.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'customer', loyaltyPoints: { gte: 500 } },
      data: { loyaltyPoints: { decrement: 500 } },
    })
    expect(tx.customer.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
    expect(tx.loyaltyTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ points: -500, createdById: 'sv' }) }),
    )
    expect(tx.staffVenue.findUnique).toHaveBeenCalled()
  })

  it('redeemPoints losing the customer CAS creates no discount and no totals', async () => {
    tx.customer.updateMany.mockResolvedValue({ count: 0 })

    await expect(redeemPointsToOrder('venue', 'order', 'customer', 1000, 'staff')).rejects.toThrow(
      'Puntos insuficientes (otro canje se procesó al mismo tiempo)',
    )
    expect(tx.orderDiscount.create).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
  })

  it('redeemStamp FREE_PRODUCT discounts the most expensive LOCKED line and burns after the Order lock', async () => {
    tx.stampReward.findFirst.mockResolvedValue({ ...REWARD, rewardType: 'FREE_PRODUCT', rewardValue: null })

    const result = await stampService.redeemStampReward('venue', 'order', 'rw', { staffId: 'staff' })

    // Locked lines are 100 and 50; the base is 150 − 20 = 130, so the whole 100 is given.
    expect(result.discountAmount).toBe(100)
    expect(tx.orderItem.findMany).toHaveBeenCalledWith({ where: { orderId: 'order' }, select: { unitPrice: true } })
    expect(tx.stampReward.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
    expect(tx.stampReward.update).toHaveBeenCalledWith({ where: { id: 'rw' }, data: { orderDiscountId: 'od-new' } })
  })

  it('redeemStamp losing the reward CAS creates no discount and no totals', async () => {
    tx.stampReward.updateMany.mockResolvedValue({ count: 0 })

    await expect(stampService.redeemStampReward('venue', 'order', 'rw')).rejects.toThrow('Este premio ya fue canjeado.')
    expect(tx.orderDiscount.create).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
  })
})

describe('createOrderWithItems writes the sale money inside its creation transaction', () => {
  const CREATED = {
    id: 'order-new',
    orderNumber: 'ORD-9',
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    type: 'DINE_IN',
    source: 'AVOQADO_IOS',
    subtotal: new Prisma.Decimal(100),
    discountAmount: new Prisma.Decimal(20),
    taxAmount: new Prisma.Decimal(0),
    total: new Prisma.Decimal(85),
    createdAt: new Date('2026-09-27T18:00:00Z'),
    items: [{ id: 'line', productId: 'p1', productName: 'Plato', quantity: 1, unitPrice: 100, total: 100, modifiers: [] }],
    promotions: [],
  }
  const input = {
    staffId: 'staff',
    items: [{ productId: 'p1', quantity: 1 }, { promotionRef: { promotionId: 'promo', promotionInstanceId: 'uuid-1', selections: [] } }],
    discount: 2000,
    tip: 500,
  } as any
  let apply: jest.SpyInstance
  let committedAtApply: boolean[]

  beforeEach(() => {
    committedAtApply = []
    prismaMock.staffVenue.findFirst.mockResolvedValue({ staffId: 'staff' })
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'p1',
        name: 'Plato',
        price: new Prisma.Decimal(100),
        sku: 'P1',
        categoryId: 'c1',
        soldByWeight: false,
        category: { name: 'Comida' },
      },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    tx.order.create.mockResolvedValue(CREATED)
    tx.order.findFirst.mockResolvedValue({ subtotal: new Prisma.Decimal(190), serviceChargeAmount: new Prisma.Decimal(0), paidAmount: 0 })
    tx.order.update.mockImplementation(async ({ data }: any) => ({ ...CREATED, ...data }))
    apply = jest.spyOn(promotionService, 'applyPromotionToOrder').mockImplementation(async () => {
      committedAtApply.push(committed)
      return { orderPromotionId: 'op', netCents: 9000, created: true }
    })
  })
  afterEach(() => apply.mockRestore())

  it('applies the promotion with the creation tx and reaffirms tip and order discount from that tx before commit', async () => {
    const result = await createOrderWithItems('venue', input)

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'venue', orderId: 'order-new', instanceId: 'uuid-1' }), tx)
    expect(committedAtApply).toEqual([false])
    // 190 with the combo − 20 order discount + 5 tip = 175 — the same arithmetic as before, now on the private order.
    expect(tx.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order-new', venueId: 'venue' } }))
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-new' },
        data: expect.objectContaining({
          discountAmount: new Prisma.Decimal(20),
          total: new Prisma.Decimal(175),
          remainingBalance: new Prisma.Decimal(175),
        }),
      }),
    )
    expect(result.total).toBe(175)
  })

  it('a promotion failure rolls the sale back: no cancel, no compensation, no post-commit effects', async () => {
    const compensate = jest.spyOn(promotionService, 'removeIntentPromotions')
    apply.mockRejectedValue(new Error('Esa promoción no está publicada.'))
    prismaMock.order.findUnique.mockResolvedValueOnce(null) // idempotency pre-check for the externalId

    await expect(createOrderWithItems('venue', { ...input, externalId: 'ticket-1' })).rejects.toThrow('Esa promoción no está publicada.')

    expect(committed).toBe(false)
    expect(compensate).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
    expect(prismaMock.discount.updateMany).not.toHaveBeenCalled()
    compensate.mockRestore()
  })

  it('the stamp reward is redeemed only after the creation commits, through the locked service', async () => {
    const committedAtRedeem: boolean[] = []
    const redeem = jest.spyOn(stampService, 'redeemStampReward').mockImplementation(async () => {
      committedAtRedeem.push(committed)
      return { discountAmount: 10, rewardLabel: 'Café', order: {} }
    })
    prismaMock.order.findUnique.mockResolvedValueOnce({ ...CREATED, total: new Prisma.Decimal(165) })

    const result = await createOrderWithItems('venue', { ...input, stampRewardId: 'rw' })

    expect(redeem).toHaveBeenCalledWith('venue', 'order-new', 'rw', { staffId: 'staff' })
    expect(committedAtRedeem).toEqual([true])
    expect(result.stampReward).toEqual({ applied: true, discountAmount: 10, rewardLabel: 'Café' })
    redeem.mockRestore()
  })
})
