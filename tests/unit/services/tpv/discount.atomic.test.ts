/** Plan3b T3: transaction and global clients deliberately disagree. */
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { $transaction: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
import prisma from '@/utils/prismaClient'
import * as tpv from '@/services/tpv/discount.tpv.service'
import * as engine from '@/services/dashboard/discountEngine.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const globalDb = prisma as any
let tx: any
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
      delete: jest.fn(),
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
    },
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
  }
}
beforeEach(() => {
  jest.clearAllMocks()
  Object.assign(globalDb, db())
  tx = db()
  globalDb.$transaction.mockImplementation(async (cb: any) => cb(tx))
})
const writers = [
  ['predefined', () => tpv.applyPredefinedDiscount('venue', 'order', 'discount', 'staff')],
  ['manual', () => tpv.applyManualDiscount('venue', 'order', 'PERCENTAGE', 10, 'Ten', 'staff')],
  ['auto', () => tpv.applyAutomaticDiscounts('venue', 'order', 'staff')],
  ['remove', () => tpv.removeDiscount('venue', 'order', 'od', 'staff')],
  ['coupon', () => tpv.applyCouponCode('venue', 'order', 'TEN', 'staff')],
] as const

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
  it.each(writers)('%s rejects PAID revealed only after the lock', async (name, run) => {
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
  it.each(writers.filter(([name]) => name === 'predefined' || name === 'auto'))(
    '%s recalculates amount and tax from the transaction even without a version change',
    async (name, run) => {
      tx.order.findUnique.mockResolvedValue({ ...order(), subtotal: 200 })
      expect(await run()).toMatchObject(name === 'predefined' ? { amount: 20 } : { applied: 1, totalSavings: 20 })
      expect(tx.orderDiscount.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amount: 20, taxReduction: 3.2 }) }),
      )
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
