/** Plan3b T3: transaction and global clients deliberately disagree. */
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { $transaction: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as tpv from '@/services/tpv/discount.tpv.service'
import * as engine from '@/services/dashboard/discountEngine.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const globalDb = prisma as any
let tx: any
let creada: any
const discount = {
  id: 'discount',
  venueId: 'venue',
  name: 'Ten',
  type: 'PERCENTAGE',
  value: 10,
  scope: 'ORDER',
  active: true,
  isAutomatic: true,
  isStackable: true,
  priority: 0,
  stackPriority: 0,
  requiresApproval: false,
  applyBeforeTax: true,
  targetItemIds: [],
  targetCategoryIds: [],
  targetModifierIds: [],
  targetModifierGroupIds: [],
  buyItemIds: [],
  getItemIds: [],
  customerGroupId: null,
  minPurchaseAmount: null,
  maxDiscountAmount: null,
  minQuantity: null,
  buyQuantity: null,
  getQuantity: null,
  getDiscountPercent: null,
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  maxTotalUses: null,
  maxUsesPerCustomer: null,
  currentUses: 0,
}
const order = () => ({
  id: 'order',
  venueId: 'venue',
  customerId: 'customer',
  paymentStatus: 'PENDING',
  subtotal: 100,
  discountAmount: 0,
  taxAmount: 16,
  tipAmount: 0,
  paidAmount: 0,
  total: 116,
  orderDiscounts: [],
  items: [],
})
function db() {
  return {
    $queryRaw: jest.fn(async () => [{ id: 'order' }]),
    order: { findUnique: jest.fn(async () => order()), update: jest.fn(async () => ({})) },
    orderDiscount: {
      findFirst: jest.fn(async () => ({ id: 'od', orderId: 'order', discountId: null, amount: 10, taxReduction: 0 })),
      create: jest.fn(async () => ({ id: 'od' })),
      update: jest.fn(async () => ({})),
      delete: jest.fn(),
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
    },
    orderItem: { findMany: jest.fn(async () => []) },
    discount: { findFirst: jest.fn(async () => discount), findMany: jest.fn(async () => [discount]), update: jest.fn() },
    customer: { findUnique: jest.fn(async () => ({ customerGroupId: null })) },
    customerDiscount: { findMany: jest.fn(async () => []) },
    venue: { findUnique: jest.fn(async () => ({ timezone: 'America/Mexico_City' })) },
    orderServiceCharge: { findMany: jest.fn(async () => []), update: jest.fn() },
    couponCode: {
      findFirst: jest.fn(async () => ({
        id: 'coupon',
        code: 'TEN',
        active: true,
        discount,
        minPurchaseAmount: null,
        maxUses: null,
        currentUses: 0,
        maxUsesPerCustomer: 1,
        validFrom: null,
        validUntil: null,
        _count: { redemptions: 0 },
      })),
    },
    couponRedemption: { count: jest.fn(async () => 0) },
    // B2 T7 (P3): quitar desde la terminal pregunta siempre por el premio de la fila; sin premio no escribe nada.
    stampReward: { findFirst: jest.fn(async () => null), update: jest.fn() },
  }
}
beforeEach(() => {
  jest.clearAllMocks()
  Object.assign(globalDb, db())
  tx = db()
  globalDb.$transaction.mockImplementation(async (cb: any) => cb(tx))
  // B2: la fila recién creada es la que la sincronización de repartos lee después (tx y global siguen separados).
  creada = null
  tx.orderDiscount.create.mockImplementation(
    async ({ data }: any) => (creada = { id: 'od-nueva', createdAt: new Date(0), appliedToItemIds: [], ...data }),
  )
  tx.orderDiscount.findMany.mockImplementation(async () => (creada ? [creada] : []))
  // B2b T3: la sincronización lee contrato e impuesto de la orden con el tx (sólo si alguna fila participa en D16).
  tx.order.findUniqueOrThrow = jest.fn(async () => tx.order.findUnique())
})
const writers = [
  ['predefined', () => tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')],
  ['manual', () => tpv.applyManualDiscount('venue', 'order', 'PERCENTAGE', 10, 'Ten', 'staff')],
  ['auto', () => tpv.applyAutomaticDiscounts('venue', 'order', 'staff')],
  ['remove', () => tpv.removeDiscount('venue', 'order', 'od', 'staff')],
  ['coupon', () => tpv.applyCouponCode('venue', 'order', 'TEN', 'staff')],
] as const

// Codex r1 P1: la cabecera de una orden anterior a B2 ($20 sin ninguna fila) se congela en su fila antes de la del escritor.
describe('descuento histórico de cabecera (Codex r1 P1)', () => {
  it.each(writers.filter(([name]) => name !== 'remove'))('🔴 %s congela los $20 históricos antes de crear su fila', async (_name, run) => {
    tx.order.findUnique.mockResolvedValue({ ...order(), discountAmount: 20, total: 96 })
    await run()
    const creadas = tx.orderDiscount.create.mock.calls.map((c: any) => c[0].data)
    expect(creadas).toHaveLength(2)
    expect(creadas[0]).toMatchObject({ orderId: 'order', type: 'FIXED_AMOUNT', name: 'Descuento anterior', isManual: true })
    expect([Number(creadas[0].amount), creadas[0].reparto]).toEqual([20, undefined])
    expect(globalDb.orderDiscount.create).not.toHaveBeenCalled()
  })
})

describe('fresh discount mutations', () => {
  it.each(writers)('%s uses the canonical Order lock before any child/charge write', async (_name, run) => {
    await run()
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    for (const model of ['orderDiscount', 'orderServiceCharge'])
      for (const method of ['create', 'update', 'delete']) {
        const mock = tx[model][method]
        if (mock?.mock.calls.length) expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mock.mock.invocationCallOrder[0])
      }
    expect(globalDb.order.update).not.toHaveBeenCalled()
    expect(globalDb.orderDiscount.create).not.toHaveBeenCalled()
  })
  // The global client still says PENDING: the rejection proves the PAID read goes through the transaction. That this
  // read happens AFTER the lock is proven on real PostgreSQL (discountMoney.atomic.integration.test.ts).
  it.each(writers)('%s rejects a PAID order read through the transaction, not the global client', async (name, run) => {
    tx.order.findUnique.mockResolvedValue({ ...order(), paymentStatus: 'PAID' })
    if (name === 'coupon') expect(await run()).toMatchObject({ success: false, error: 'Cannot apply coupon to a paid order' })
    else await expect(run()).rejects.toThrow(/paid order/)
    expect(tx.orderDiscount.create).not.toHaveBeenCalled()
    expect(tx.orderDiscount.delete).not.toHaveBeenCalled()
  })
  it.each(writers)('%s rejects a foreign/missing Order returned by the lock', async (_name, run) => {
    tx.$queryRaw.mockResolvedValue([])
    await expect(run()).rejects.toThrow(/Order not found/)
    expect(tx.orderDiscount.create).not.toHaveBeenCalled()
  })
  it.each(writers)('%s scopes the canonical lock to the ROUTE venue, never to the Order own venue', async (_name, run) => {
    // The Order claims another venue: a writer that derived the tenant from it (legacy path) would lock that one instead.
    tx.order.findUnique.mockResolvedValue({ ...order(), venueId: 'order-own-venue' })
    await run()
    expect(tx.order.findUnique.mock.calls.filter(([args]: any[]) => args?.select?.venueId)).toHaveLength(0)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    // Tagged template: [strings, orderId, venueId] — the bound venue must be the route's.
    expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['order', 'venue'])
  })
  // B2b T4 (D16): este caso esperaba `taxReduction: 3.2` (el 16 % inventado) sobre una orden sin contrato; desde B2b T2 ya da
  // 0 y el impuesto no se toca. Lo reemplaza P10 (nace verde con T2 ⇒ control). Sigue probando que todo sale del tx.
  it.each(writers.filter(([name]) => name === 'predefined' || name === 'auto'))(
    'control — P10 antes/después — %s sobre una orden DESCONOCIDO con impuesto 16: impuesto 16 y total 196 (antes 12.80 y 192.80)',
    async (name, run) => {
      tx.order.findUnique.mockResolvedValue({ ...order(), subtotal: 200, contratoDePrecio: 'DESCONOCIDO' })
      expect(await run()).toMatchObject(name === 'predefined' ? { amount: 20 } : { applied: 1, totalSavings: 20 })
      expect(tx.orderDiscount.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amount: 20, taxReduction: 0 }) }),
      )
      const escrito = tx.order.update.mock.calls.at(-1)[0].data
      expect(Number(escrito.taxAmount)).toBe(16)
      expect(escrito.total).toBe(196)
      expect(globalDb.discount.findMany).not.toHaveBeenCalled()
      expect(globalDb.customerDiscount.findMany).not.toHaveBeenCalled()
    },
  )
  it('rejects a cached calculation when the same-tx catalog no longer allows it', async () => {
    tx.discount.findMany.mockResolvedValue([])
    const cached = {
      discountId: 'discount',
      name: 'Ten',
      type: 'PERCENTAGE' as const,
      value: 10,
      amount: 99,
      taxReduction: 15.84,
      applicableItems: [],
      isAutomatic: true,
      requiresApproval: false,
    }
    const result = await engine.applyDiscountToOrder('order', cached)
    expect(result.success).toBe(false)
    expect(tx.orderDiscount.create).not.toHaveBeenCalled()
    // A legacy caller without venue may only resolve the exact Order tenant before the lock; everything else is reread after it.
    expect(tx.order.findUnique.mock.calls[0][0]).toEqual({ where: { id: 'order' }, select: { venueId: true } })
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeGreaterThan(tx.order.findUnique.mock.invocationCallOrder[0])
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.order.findUnique.mock.invocationCallOrder[1])
  })
  it('auto writes usage counters after the last batch write, in ascending discount id order (T3-R2)', async () => {
    // Evaluation order (priority desc) is z-first then a-second: deliberately NOT ascending id order.
    tx.discount.findMany.mockResolvedValue([
      { ...discount, id: 'z-first', priority: 10 },
      { ...discount, id: 'a-second', priority: 5 },
    ])
    tx.orderServiceCharge.findMany.mockResolvedValue([{ id: 'sc', orderId: 'order', type: 'PERCENTAGE', value: 10, amount: 10 }])
    expect(await tpv.applyAutomaticDiscounts('venue', 'order', 'staff')).toMatchObject({ applied: 2, totalSavings: 20 })
    // Application order (money) is untouched: the evaluation order still decides which rule is applied first.
    expect(tx.orderDiscount.create.mock.calls.map((call: any) => call[0].data.discountId)).toEqual(['z-first', 'a-second'])
    const lastBatchWrite = Math.max(
      ...tx.orderDiscount.create.mock.invocationCallOrder,
      ...tx.orderServiceCharge.update.mock.invocationCallOrder,
      ...tx.order.update.mock.invocationCallOrder,
    )
    expect(Math.min(...tx.discount.update.mock.invocationCallOrder)).toBeGreaterThan(lastBatchWrite)
    expect(tx.discount.update.mock.calls.map((call: any) => call[0].where.id)).toEqual(['a-second', 'z-first'])
    expect(globalDb.discount.update).not.toHaveBeenCalled()
  })
  it('coupon validates fresh subtotal and customer using only the transaction client', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), customerId: 'fresh', subtotal: 200 })
    expect(await tpv.applyCouponCode('venue', 'order', 'TEN', 'staff')).toMatchObject({ amount: 20 })
    expect(tx.couponRedemption.count).toHaveBeenCalledWith({ where: { couponCodeId: 'coupon', customerId: 'fresh' } })
    expect(globalDb.couponCode.findFirst).not.toHaveBeenCalled()
    expect(globalDb.couponRedemption.count).not.toHaveBeenCalled()
  })
  it.each(writers.filter(([name]) => name === 'predefined' || name === 'auto' || name === 'remove'))(
    '%s does not emit its audit before commit succeeds',
    async (name, run) => {
      globalDb.$transaction.mockImplementation(async (cb: any) => {
        await cb(tx)
        throw new Error('commit failure')
      })
      await expect(run()).rejects.toThrow('commit failure')
      expect(name === 'remove' ? tx.orderDiscount.delete : tx.orderDiscount.create).toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    },
  )
})

describe('B2 — el motor guarda a qué renglones aplicó (spec §4.1, D7)', () => {
  it('🔴 C1: con promoción en la cuenta, el descuento de cuenta del motor se reparte SÓLO sobre su base (no sobre «Otro importe»)', async () => {
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      subtotal: 290,
      items: [
        {
          id: 'cafe',
          productId: 'p1',
          product: { id: 'p1', categoryId: 'c1', taxRate: 0.16 },
          quantity: 1,
          unitPrice: 100,
          total: 100,
          taxAmount: 0,
          orderPromotionId: null,
          modifiers: [],
        },
        {
          id: 'otro',
          productId: null,
          product: null,
          quantity: 1,
          unitPrice: 100,
          total: 100,
          taxAmount: 0,
          orderPromotionId: null,
          modifiers: [],
        },
        {
          id: 'combo',
          productId: 'p2',
          product: { id: 'p2', categoryId: 'c1', taxRate: 0.16 },
          quantity: 1,
          unitPrice: 90,
          total: 90,
          taxAmount: 0,
          orderPromotionId: 'op',
          modifiers: [],
        },
      ],
    })
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'cafe', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
      { id: 'otro', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
      { id: 'combo', total: 90, discountAmount: 0, orderPromotionId: 'op', taxAmount: 0 },
    ])
    await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data).toMatchObject({
      amount: 10,
      reparto: { alcance: 'CUENTA', conPromociones: false, base: ['cafe'] },
    })
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'od-nueva' },
      data: { reparto: { v: 1, alcance: 'CUENTA', conPromociones: false, base: ['cafe'], espejo: false, renglones: { cafe: 1000 } } },
    })
    expect(tx.orderDiscount.update.mock.invocationCallOrder[0]).toBeLessThan(tx.order.update.mock.invocationCallOrder[0])
    expect(globalDb.orderDiscount.update).not.toHaveBeenCalled()
  })
  it('2×1 del catálogo: fila DIRIGIDA con lo regalado por artículo; importe y totales de hoy', async () => {
    tx.discount.findMany.mockResolvedValue([
      { ...discount, scope: 'QUANTITY', buyQuantity: 1, getQuantity: 1, getDiscountPercent: 100, applyBeforeTax: false },
    ])
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      subtotal: 100,
      items: [
        {
          id: 'i1',
          productId: 'p1',
          product: { id: 'p1', categoryId: 'c1', taxRate: 0.16 },
          quantity: 2,
          unitPrice: 50,
          total: 100,
          taxAmount: 0,
          orderPromotionId: null,
          modifiers: [],
        },
      ],
    })
    tx.orderItem.findMany.mockResolvedValue([{ id: 'i1', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 }])
    await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data).toMatchObject({
      amount: 50,
      reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { i1: 5000 } },
    })
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ discountAmount: 50 }) }))
  })
  it('manual: fila de CUENTA con promociones, repartida; el importe es el de hoy', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'n', total: 60, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
      { id: 'p', total: 40, discountAmount: 10, orderPromotionId: 'op', taxAmount: 0 },
    ])
    await tpv.applyManualDiscount('venue', 'order', 'PERCENTAGE', 10, 'Ten', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data).toMatchObject({
      amount: 10,
      reparto: { alcance: 'CUENTA', conPromociones: true },
    })
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'od-nueva' },
      data: { reparto: expect.objectContaining({ renglones: { n: 600, p: 400 } }) },
    })
  })
  it('lee los renglones DESPUÉS del candado', async () => {
    tx.orderItem.findMany.mockResolvedValue([{ id: 'n', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 }])
    await tpv.applyManualDiscount('venue', 'order', 'PERCENTAGE', 10, 'Ten', 'staff')
    expect(tx.orderItem.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
  })
  it('cupón: fila de CUENTA con promociones, repartida después del candado; importe de hoy', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'n', total: 60, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
      { id: 'p', total: 40, discountAmount: 10, orderPromotionId: 'op', taxAmount: 0 },
    ])
    await tpv.applyCouponCode('venue', 'order', 'TEN', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data).toMatchObject({
      amount: 10,
      reparto: { alcance: 'CUENTA', conPromociones: true },
    })
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'od-nueva' },
      data: { reparto: expect.objectContaining({ renglones: { n: 600, p: 400 } }) },
    })
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ discountAmount: 10 }) }))
    // Bajo el candado y ANTES de la escritura de totales: un fallo en ésta revierte también el reparto.
    expect(tx.orderDiscount.update.mock.invocationCallOrder[0]).toBeLessThan(tx.order.update.mock.invocationCallOrder[0])
  })
  it('R6: el cupón de % con tope del catálogo guarda su tope en el reparto (hoy el siguiente recálculo lo ignoraba)', async () => {
    const cupon = await tx.couponCode.findFirst()
    tx.couponCode.findFirst.mockResolvedValue({ ...cupon, discount: { ...discount, maxDiscountAmount: 5 } })
    await tpv.applyCouponCode('venue', 'order', 'TEN', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data).toMatchObject({
      amount: 5,
      reparto: { alcance: 'CUENTA', conPromociones: true, tope: 5 },
    })
  })
  // Codex r1: un tope de $0 (no nulo) ES tope. Al aplicar ya topaba (Decimal(0) es verdadero); el reparto lo omitía y el
  // siguiente recálculo daba $15.
  it('🔴 R6: un tope de $0 en el cupón de % topa al aplicar ($0) y viaja en el reparto para el recálculo', async () => {
    const cupon = await tx.couponCode.findFirst()
    tx.couponCode.findFirst.mockResolvedValue({ ...cupon, discount: { ...discount, maxDiscountAmount: new Prisma.Decimal(0) } })
    await tpv.applyCouponCode('venue', 'order', 'TEN', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data).toMatchObject({
      amount: 0,
      reparto: { alcance: 'CUENTA', conPromociones: true, tope: 0 },
    })
  })
  it('🔴 P3 antes/después: quitar desde la terminal un descuento de puntos y premio devuelve los dos en la misma transacción (hoy no)', async () => {
    tx.orderDiscount.findFirst.mockResolvedValue({
      id: 'od',
      orderId: 'order',
      discountId: null,
      amount: 10,
      taxReduction: 0,
      loyaltyTransactionId: 'lt',
      appliedToItemIds: [],
      reparto: null,
    })
    tx.staffVenue = { findUnique: jest.fn(async () => ({ id: 'sv' })) }
    tx.loyaltyTransaction = {
      findUnique: jest.fn(async () => ({ id: 'lt', customerId: 'c1', points: -1000, orderId: 'order' })),
      create: jest.fn(async () => ({ id: 'lt2' })),
    }
    tx.customer = { ...tx.customer, update: jest.fn(async () => ({})) }
    tx.stampReward = {
      findFirst: jest.fn(async () => ({ id: 'rw', customerId: 'c1', rewardLabel: 'Café' })),
      update: jest.fn(async () => ({})),
    }
    await tpv.removeDiscount('venue', 'order', 'od', 'staff')
    expect(tx.loyaltyTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'ADJUST', points: 1000 }) }),
    )
    expect(tx.customer.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { loyaltyPoints: { increment: 1000 } } })
    expect(tx.stampReward.update).toHaveBeenCalledWith({
      where: { id: 'rw' },
      data: { status: 'PENDING', redeemedAt: null, orderDiscountId: null },
    })
    expect(tx.loyaltyTransaction.create.mock.invocationCallOrder[0]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0])
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DISCOUNT_REMOVED',
        data: expect.objectContaining({ pointsRefunded: 1000, stampRewardReturned: 'rw' }),
      }),
    )
  })
  it('🔴 Codex r2 N2: quitar un descuento NO espejo re-reparte los demás (premio de $100 en A y $10 de cuenta en B ⇒ 5/5)', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), subtotal: 200, discountAmount: 110, total: 106 })
    tx.orderDiscount.findFirst.mockResolvedValue({
      id: 'premio',
      orderId: 'order',
      discountId: null,
      amount: 100,
      taxReduction: 0,
      loyaltyTransactionId: null,
      appliedToItemIds: [],
      reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { A: 10000 } },
    })
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'A', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
      { id: 'B', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
    ])
    const cuenta = { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { B: 1000 } }
    tx.orderDiscount.findMany.mockResolvedValue([
      {
        id: 'cta',
        type: 'FIXED_AMOUNT',
        value: 10,
        amount: 10,
        taxReduction: 0,
        appliedToItemIds: [],
        createdAt: new Date(1),
        reparto: cuenta,
      },
    ])
    await tpv.removeDiscount('venue', 'order', 'premio', 'staff')
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'cta' },
      data: { reparto: { ...cuenta, renglones: { A: 500, B: 500 } } },
    })
    expect(tx.orderDiscount.update.mock.invocationCallOrder[0]).toBeLessThan(tx.order.update.mock.invocationCallOrder[0])
  })
})

describe('B2b T3 — manual y cupón suman lo que la sincronización devolvió a Order.taxAmount (D16)', () => {
  // «prev» ($10 marcado, restó 1.60 sobre A) se re-reparte 5/5 al entrar la fila nueva ⇒ 1.60 → 0.80, vuelven 0.80.
  // manual: 200 − (10 + 10) + (14.4 + 0.8) = 195.20 · cupón (10 % de los 190 que quedan = 19): 200 − (10 + 19) + 15.2 = 186.20.
  it.each([
    ['manual', () => tpv.applyManualDiscount('venue', 'order', 'FIXED_AMOUNT', 10, 'Diez', 'staff'), 195.2],
    ['cupón', () => tpv.applyCouponCode('venue', 'order', 'TEN', 'staff'), 186.2],
  ] as const)('🔴 %s calcula su total con el impuesto que la sincronización devolvió', async (_name, run, total) => {
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      contratoDePrecio: 'IVA_APARTE',
      subtotal: 200,
      discountAmount: 10,
      taxAmount: 14.4,
    })
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'a', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16 },
      { id: 'b', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
    ])
    const vieja = {
      id: 'prev',
      type: 'FIXED_AMOUNT',
      value: 10,
      amount: 10,
      taxReduction: 1.6,
      appliedToItemIds: [],
      createdAt: new Date(0),
      reparto: { v: 1, alcance: 'CUENTA', conPromociones: false, espejo: false, reduceImpuesto: true, renglones: { a: 1000 } },
    }
    tx.orderDiscount.findMany.mockImplementation(async () => (creada ? [vieja, creada] : [vieja]))
    tx.order.findUniqueOrThrow = jest.fn(async () => ({ contratoDePrecio: 'IVA_APARTE', taxAmount: 14.4 }))
    await run()
    const devueltos = tx.order.update.mock.calls.filter(([a]: any) => a.data.taxAmount?.increment !== undefined)
    expect(devueltos.map(([a]: any) => Number(a.data.taxAmount.increment))).toEqual([0.8])
    expect(tx.order.update.mock.calls.at(-1)[0].data.total).toBe(total)
  })
})

describe('B2b T4 — aplicar y quitar en el motor: la reducción la pone la sincronización (D16, V3)', () => {
  it.each(writers.filter(([name]) => name === 'predefined' || name === 'auto'))(
    '%s con impuesto aparte: la reducción sale del reparto final (20 × 32/200 = 3.20) y se guarda en la misma transacción',
    async (_name, run) => {
      tx.order.findUnique.mockResolvedValue({
        ...order(),
        subtotal: 200,
        taxAmount: 32,
        contratoDePrecio: 'IVA_APARTE',
        items: [
          {
            id: 'i1',
            productId: 'p1',
            product: { id: 'p1', categoryId: 'c1', taxRate: 0.16 },
            quantity: 1,
            unitPrice: 200,
            total: 200,
            taxAmount: 32,
            orderPromotionId: null,
            modifiers: [],
          },
        ],
      })
      tx.orderItem.findMany.mockResolvedValue([{ id: 'i1', total: 200, discountAmount: 0, orderPromotionId: null, taxAmount: 32 }])
      await run()
      // Codex r3 V3: UNA sola escritura de la reducción (la de la sincronización, junto con el reparto final).
      const conReduccion = tx.orderDiscount.update.mock.calls.filter(([a]: any) => a.data.taxReduction !== undefined)
      expect(conReduccion.map(([a]: any) => [a.where.id, a.data.taxReduction])).toEqual([['od-nueva', 3.2]])
      const escrito = tx.order.update.mock.calls.at(-1)[0].data
      expect(Number(escrito.taxAmount)).toBe(28.8)
      expect(escrito.total).toBe(208.8)
    },
  )
  const cafeConIva = () => ({
    ...order(),
    subtotal: 100,
    taxAmount: 16,
    total: 116,
    contratoDePrecio: 'IVA_APARTE',
    items: [
      {
        id: 'i1',
        productId: 'p1',
        product: { id: 'p1', categoryId: 'c1', taxRate: 0.16 },
        quantity: 1,
        unitPrice: 100,
        total: 100,
        taxAmount: 16,
        orderPromotionId: null,
        modifiers: [],
      },
    ],
  })
  it.each([
    ['de cuenta ($10 fijos)', { type: 'FIXED_AMOUNT', value: 10, scope: 'ORDER' }],
    ['dirigido (10 % del café)', { type: 'PERCENTAGE', value: 10, scope: 'ITEM', targetItemIds: ['p1'] }],
  ])(
    '🔴 Codex r3 V3: un descuento nuevo %s sobre $100 + $16 resta el IVA UNA vez ⇒ IVA 14.40 y total 104.40 (v3 de este plan: 12.80 y 102.80)',
    async (_caso, regla) => {
      tx.order.findUnique.mockResolvedValue(cafeConIva())
      tx.discount.findMany.mockResolvedValue([{ ...discount, ...regla }])
      tx.orderItem.findMany.mockResolvedValue([
        { id: 'i1', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16, productId: 'p1', product: { categoryId: 'c1' } },
      ])
      await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
      const conReduccion = tx.orderDiscount.update.mock.calls.filter(([a]: any) => a.data.taxReduction !== undefined)
      expect(conReduccion.map(([a]: any) => a.data.taxReduction)).toEqual([1.6])
      const escrito = tx.order.update.mock.calls.at(-1)[0].data
      expect(Number(escrito.taxAmount)).toBe(14.4)
      expect(escrito.total).toBe(104.4)
    },
  )
  it('control — Codex r3 V3: con `applyBeforeTax = false` en una orden IVA_APARTE no hay marca ni reducción (IVA 16, total 106)', async () => {
    tx.order.findUnique.mockResolvedValue(cafeConIva())
    tx.discount.findMany.mockResolvedValue([{ ...discount, type: 'FIXED_AMOUNT', value: 10, applyBeforeTax: false }])
    tx.orderItem.findMany.mockResolvedValue([{ id: 'i1', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16 }])
    await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data.reparto.reduceImpuesto).toBeUndefined()
    expect(tx.orderDiscount.update.mock.calls.some(([a]: any) => a.data.taxReduction !== undefined)).toBe(false)
    expect(Number(tx.order.update.mock.calls.at(-1)[0].data.taxAmount)).toBe(16)
    // R-3 (preflight): el título promete el total; se afirma.
    expect(tx.order.update.mock.calls.at(-1)[0].data.total).toBe(106)
  })
  it('control — Codex r3 V3: con IVA incluido no hay marca ni reducción, ni se relee la orden (IVA 0, total 90)', async () => {
    tx.order.findUnique.mockResolvedValue({ ...cafeConIva(), taxAmount: 0, total: 100, contratoDePrecio: 'IVA_INCLUIDO' })
    tx.discount.findMany.mockResolvedValue([{ ...discount, type: 'FIXED_AMOUNT', value: 10 }])
    tx.orderItem.findMany.mockResolvedValue([{ id: 'i1', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 }])
    await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data.reparto.reduceImpuesto).toBeUndefined()
    expect(tx.order.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(tx.order.update.mock.calls.at(-1)[0].data.total).toBe(90)
  })
  it('🔴 la reducción sale del reparto FINAL: si por capacidad el descuento cae entero en el renglón exento, no baja impuesto', async () => {
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      subtotal: 200,
      discountAmount: 100,
      taxAmount: 16,
      contratoDePrecio: 'IVA_APARTE',
      items: [
        {
          id: 'A',
          productId: 'p1',
          product: { id: 'p1', categoryId: 'c1', taxRate: 0.16 },
          quantity: 1,
          unitPrice: 100,
          total: 100,
          taxAmount: 16,
          orderPromotionId: null,
          modifiers: [],
        },
        {
          id: 'B',
          productId: 'p2',
          product: { id: 'p2', categoryId: 'c1', taxRate: 0 },
          quantity: 1,
          unitPrice: 100,
          total: 100,
          taxAmount: 0,
          orderPromotionId: null,
          modifiers: [],
        },
      ],
    })
    tx.discount.findMany.mockResolvedValue([{ ...discount, type: 'FIXED_AMOUNT', value: 10 }])
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'A', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16 },
      { id: 'B', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
    ])
    const previa = {
      id: 'prev',
      type: 'FIXED_AMOUNT',
      value: 100,
      amount: 100,
      taxReduction: 0,
      appliedToItemIds: [],
      createdAt: new Date(0),
      reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { A: 10000 } },
    }
    tx.orderDiscount.findMany.mockImplementation(async () => (creada ? [previa, creada] : [previa]))
    await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
    // La vista previa repartía 5/5 (0.80); el reparto final pone los $10 en B (A ya no tiene lugar) ⇒ 0.
    expect(tx.orderDiscount.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ taxReduction: expect.anything() }) }),
    )
    expect(Number(tx.order.update.mock.calls.at(-1)[0].data.taxAmount)).toBe(16)
  })
  it('🔴 sobre lo APLICADO y un solo redondeo: 4 % de $1 recortado a $0.02 con IVA $0.16 ⇒ 0.00 (hoy 0.01)', async () => {
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      subtotal: 1,
      discountAmount: 0.98,
      taxAmount: 0.16,
      contratoDePrecio: 'IVA_APARTE',
      items: [
        {
          id: 'i1',
          productId: 'p1',
          product: { id: 'p1', categoryId: 'c1', taxRate: 0.16 },
          quantity: 1,
          unitPrice: 1,
          total: 1,
          taxAmount: 0.16,
          orderPromotionId: null,
          modifiers: [],
        },
      ],
    })
    tx.discount.findMany.mockResolvedValue([{ ...discount, value: 4 }])
    tx.orderItem.findMany.mockResolvedValue([{ id: 'i1', total: 1, discountAmount: 0, orderPromotionId: null, taxAmount: 0.16 }])
    await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
    expect(tx.orderDiscount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 0.02, taxReduction: 0 }) }),
    )
    expect(tx.orderDiscount.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ taxReduction: expect.anything() }) }),
    )
    expect(Number(tx.order.update.mock.calls.at(-1)[0].data.taxAmount)).toBe(0.16)
  })
  // Ya pasa desde B2b T2 (la vista previa topa a la cabecera en 0) ⇒ control (R-1); ahora la topa la sincronización.
  it('control — cuenta separada que heredó IVA_APARTE con la cabecera en impuesto 0: la reducción se topa en 0', async () => {
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      subtotal: 100,
      taxAmount: 0,
      contratoDePrecio: 'IVA_APARTE',
      items: [
        {
          id: 'i1',
          productId: 'p1',
          product: { id: 'p1', categoryId: 'c1', taxRate: 0.16 },
          quantity: 1,
          unitPrice: 100,
          total: 100,
          taxAmount: 16,
          orderPromotionId: null,
          modifiers: [],
        },
      ],
    })
    tx.orderItem.findMany.mockResolvedValue([{ id: 'i1', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16 }])
    await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
    expect(Number(tx.order.update.mock.calls.at(-1)[0].data.taxAmount)).toBe(0)
  })
  it('la fila que participa en D16 lo dice en su reparto, aunque su reducción sea 0 (Codex r2 N3)', async () => {
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      subtotal: 100,
      taxAmount: 0,
      contratoDePrecio: 'IVA_APARTE',
      items: [
        {
          id: 'b',
          productId: 'p2',
          product: { id: 'p2', categoryId: 'c1', taxRate: 0 },
          quantity: 1,
          unitPrice: 100,
          total: 100,
          taxAmount: 0,
          orderPromotionId: null,
          modifiers: [],
        },
      ],
    })
    tx.orderItem.findMany.mockResolvedValue([{ id: 'b', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 }])
    await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
    expect(tx.orderDiscount.create.mock.calls[0][0].data.reparto).toMatchObject({ reduceImpuesto: true })
  })
  it('🔴 Codex r2 N2: quitar del motor un descuento NO espejo de una orden IVA_APARTE re-reparte los demás y su reducción (impuesto final 15.20)', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), subtotal: 200, discountAmount: 110, taxAmount: 0, contratoDePrecio: 'IVA_APARTE' })
    tx.orderDiscount.findFirst.mockResolvedValue({
      id: 'premio',
      orderId: 'order',
      discountId: null,
      amount: 100,
      taxReduction: 16,
      loyaltyTransactionId: null,
      appliedToItemIds: [],
      name: 'Premio',
      reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, reduceImpuesto: true, renglones: { A: 10000 } },
    })
    tx.stampReward = { findFirst: jest.fn(async () => null), update: jest.fn() }
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'A', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16 },
      { id: 'B', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
    ])
    const cuenta = { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, reduceImpuesto: true, renglones: { B: 1000 } }
    tx.orderDiscount.findMany.mockResolvedValue([
      {
        id: 'cta',
        type: 'FIXED_AMOUNT',
        value: 10,
        amount: 10,
        taxReduction: 0,
        appliedToItemIds: [],
        createdAt: new Date(1),
        reparto: cuenta,
      },
    ])
    tx.order.findUniqueOrThrow = jest.fn(async () => ({ contratoDePrecio: 'IVA_APARTE', taxAmount: 16 })) // ya con los 16 devueltos
    await tpv.removeDiscount('venue', 'order', 'premio', 'staff')
    const incrementos = tx.order.update.mock.calls
      .filter(([a]: any) => a.data.taxAmount?.increment !== undefined)
      .map(([a]: any) => Number(a.data.taxAmount.increment))
    expect(incrementos).toEqual([16, -0.8]) // primero vuelve lo de la fila quitada; luego el re-reparto de «cta»
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'cta' },
      data: { taxReduction: 0.8, reparto: { ...cuenta, renglones: { A: 500, B: 500 } } },
    })
    expect(Number(tx.order.update.mock.calls.at(-1)[0].data.taxAmount)).toBe(15.2)
  })
  it('control de regresión: quitar una fila VIEJA devuelve exactamente lo que restó (−1.60 ⇒ 0; total 100)', async () => {
    tx.order.findUnique.mockResolvedValue({ ...order(), subtotal: 100, taxAmount: -1.6, discountAmount: 10, total: 90 })
    tx.orderDiscount.findFirst.mockResolvedValue({
      id: 'od',
      orderId: 'order',
      discountId: null,
      amount: 10,
      taxReduction: 1.6,
      loyaltyTransactionId: null,
      appliedToItemIds: [],
      reparto: null,
      name: 'Vieja',
    })
    tx.stampReward = { findFirst: jest.fn(async () => null), update: jest.fn() }
    await tpv.removeDiscount('venue', 'order', 'od', 'staff')
    const escrito = tx.order.update.mock.calls.at(-1)[0].data
    expect(Number(escrito.taxAmount)).toBe(0)
    expect(escrito.total).toBe(100)
  })
})

describe('B2c R8 — el motor, al APLICAR un %, deja fuera lo ya regalado (y nada más: Codex r3 V6)', () => {
  it('🔴 R8 antes/después: el 10 % de cuenta del motor no cuenta la cortesía de la terminal ($10; hoy $15)', async () => {
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      subtotal: 150,
      items: [
        {
          id: 'cafe',
          productId: 'p1',
          product: { id: 'p1', categoryId: 'c1', taxRate: 0.16 },
          quantity: 1,
          unitPrice: 100,
          total: 100,
          discountAmount: 0,
          isCortesia: false,
          taxAmount: 0,
          orderPromotionId: null,
          modifiers: [],
        },
        {
          id: 'pan',
          productId: 'p2',
          product: { id: 'p2', categoryId: 'c1', taxRate: 0.16 },
          quantity: 1,
          unitPrice: 50,
          total: 50,
          discountAmount: 50,
          isCortesia: true,
          taxAmount: 0,
          orderPromotionId: null,
          modifiers: [],
        },
      ],
    })
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'cafe', total: 100, discountAmount: 0, orderPromotionId: null, isCortesia: false, taxAmount: 0 },
      { id: 'pan', total: 50, discountAmount: 50, orderPromotionId: null, isCortesia: true, taxAmount: 0 },
    ])
    await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
    expect(tx.orderDiscount.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: 10 }) }))
  })

  const conCortesiaDeCien = () => ({
    ...order(),
    subtotal: 150,
    discountAmount: 100,
    taxAmount: 0,
    items: [
      {
        id: 'regalo',
        productId: 'p1',
        product: { id: 'p1', categoryId: 'c1', taxRate: 0.16 },
        quantity: 1,
        unitPrice: 100,
        total: 100,
        discountAmount: 100,
        isCortesia: true,
        taxAmount: 0,
        orderPromotionId: null,
        modifiers: [],
      },
      {
        id: 'pan',
        productId: 'p2',
        product: { id: 'p2', categoryId: 'c1', taxRate: 0.16 },
        quantity: 1,
        unitPrice: 50,
        total: 50,
        discountAmount: 0,
        isCortesia: false,
        taxAmount: 0,
        orderPromotionId: null,
        modifiers: [],
      },
    ],
  })
  it('control — Codex r3 V6: un descuento FIJO de $10 con mínimo de compra de $100 sigue aplicando con una cortesía de $100 + $50 (como hoy; cobra $40)', async () => {
    tx.order.findUnique.mockResolvedValue(conCortesiaDeCien())
    tx.discount.findMany.mockResolvedValue([{ ...discount, type: 'FIXED_AMOUNT', value: 10, minPurchaseAmount: 100 }])
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'regalo', total: 100, discountAmount: 100, orderPromotionId: null, isCortesia: true, taxAmount: 0 },
      { id: 'pan', total: 50, discountAmount: 0, orderPromotionId: null, isCortesia: false, taxAmount: 0 },
    ])
    const res = await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
    // Si R8 filtrara el contexto entero (la v3 de este plan), la elegibilidad vería $50 < $100 y el descuento desaparecería.
    expect(tx.orderDiscount.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: 10 }) }))
    expect(res.newOrderTotal).toBe(40) // 150 − (100 de la cortesía + 10)
  })
  it('control — Codex r3 V6: un 2×1 sigue contando lo regalado para armar el par, como hoy ($100)', async () => {
    tx.order.findUnique.mockResolvedValue({
      ...order(),
      subtotal: 200,
      discountAmount: 100,
      items: [
        {
          id: 'cafe1',
          productId: 'p1',
          product: { id: 'p1', categoryId: 'c1', taxRate: 0.16 },
          quantity: 1,
          unitPrice: 100,
          total: 100,
          discountAmount: 100,
          isCortesia: true,
          taxAmount: 0,
          orderPromotionId: null,
          modifiers: [],
        },
        {
          id: 'cafe2',
          productId: 'p1',
          product: { id: 'p1', categoryId: 'c1', taxRate: 0.16 },
          quantity: 1,
          unitPrice: 100,
          total: 100,
          discountAmount: 0,
          isCortesia: false,
          taxAmount: 0,
          orderPromotionId: null,
          modifiers: [],
        },
      ],
    })
    tx.discount.findMany.mockResolvedValue([{ ...discount, scope: 'QUANTITY', buyQuantity: 1, getQuantity: 1, getDiscountPercent: 100 }])
    tx.orderItem.findMany.mockResolvedValue([
      { id: 'cafe1', total: 100, discountAmount: 100, orderPromotionId: null, isCortesia: true, taxAmount: 0 },
      { id: 'cafe2', total: 100, discountAmount: 0, orderPromotionId: null, isCortesia: false, taxAmount: 0 },
    ])
    await tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')
    // Cambiar si un regalado cuenta para un 2×1 sería otra decisión comercial (residual R10), no R8.
    expect(tx.orderDiscount.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: 100 }) }))
  })
})
