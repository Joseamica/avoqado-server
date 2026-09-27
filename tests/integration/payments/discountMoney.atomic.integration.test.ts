/** Plan3b T3: real discount writers and fiscal admission serialize on the same Order. */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as lock from '@/services/shared/paymentShiftClaim'
import { bloquearOrdenParaFacturar } from '@/services/fiscal/admisionIva'
import * as tpv from '@/services/tpv/discount.tpv.service'
import { applyDiscountToOrder, evaluateAutomaticDiscounts } from '@/services/dashboard/discountEngine.service'
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(database.pathname)
) {
  throw new Error('This suite requires an explicitly selected isolated local test database.')
}
const venueId = `discount-money-${randomUUID()}`
// A second venue of the same organization: a TPV route for it must never reach an Order of `venueId`.
const otherVenueId = `discount-money-other-${randomUUID()}`
let staffId: string, staffVenueId: string, productId: string, chargeId: string, discountId: string, couponId: string, customerId: string
let otherProductId: string, secondDiscountId: string, groupId: string
const couponCode = `T3-${randomUUID()}`.toUpperCase()
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}
// Writers return different shapes (TPV auto vs the rest): the harness only inspects outcomes, so it takes any promise.
const resultOf = (promise: Promise<unknown>) =>
  promise.then(
    value => ({ value, error: undefined }),
    error => ({ value: undefined, error }),
  )
async function waitingOnOrder(minimum = 1) {
  for (let i = 0; i < 100; i++) {
    const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%"Order"%'`
    if (count >= minimum) return
    await pause(20)
  }
  throw new Error('No connection waited on Order')
}
async function newOrder(remove = false) {
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      subtotal: 100,
      taxAmount: 16,
      total: 126,
      remainingBalance: 126,
      serviceChargeAmount: remove ? 9 : 10,
      discountAmount: remove ? 10 : 0,
      items: { create: { productId, productName: 'Product', quantity: 1, unitPrice: 100, total: 100, taxAmount: 16 } },
      serviceCharges: { create: { serviceChargeId: chargeId, name: 'Service', type: 'PERCENTAGE', value: 10, amount: remove ? 9 : 10 } },
      ...(remove
        ? { orderDiscounts: { create: { name: 'Remove', type: 'FIXED_AMOUNT', value: 10, amount: 10, taxReduction: 0, isManual: true } } }
        : {}),
    },
    include: { items: true, orderDiscounts: true },
  })
}
async function snapshot(orderId: string, db: Prisma.TransactionClient = prisma) {
  const o = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { orderDiscounts: { orderBy: { id: 'asc' } }, serviceCharges: { orderBy: { id: 'asc' } } },
  })
  return {
    subtotal: Number(o.subtotal),
    discount: Number(o.discountAmount),
    tax: Number(o.taxAmount),
    total: Number(o.total),
    charge: Number(o.serviceChargeAmount),
    remaining: Number(o.remainingBalance),
    version: o.version,
    discounts: o.orderDiscounts.map(d => ({ id: d.id, amount: Number(d.amount), tax: Number(d.taxReduction), coupon: d.couponCodeId })),
    charges: o.serviceCharges.map(c => ({ id: c.id, amount: Number(c.amount) })),
  }
}
function holdFiscal(orderId: string, after: (tx: Prisma.TransactionClient) => Promise<unknown> = async () => {}) {
  const entered = barrier(),
    finish = barrier()
  const done = prisma.$transaction(
    async tx => {
      await bloquearOrdenParaFacturar(tx, orderId)
      entered.release()
      await finish.promise
      await after(tx)
    },
    { timeout: 15000 },
  )
  return { entered: entered.promise, release: finish.release, done }
}
type Fixture = Awaited<ReturnType<typeof newOrder>>
const writers = [
  ['predefined', (o: Fixture, venue = venueId) => tpv.applyPredefinedDiscount(venue, o.id, discountId, staffVenueId)],
  ['manual', (o: Fixture, venue = venueId) => tpv.applyManualDiscount(venue, o.id, 'PERCENTAGE', 10, 'Manual', staffVenueId)],
  ['auto', (o: Fixture, venue = venueId) => tpv.applyAutomaticDiscounts(venue, o.id, staffVenueId)],
  ['remove', (o: Fixture, venue = venueId) => tpv.removeDiscount(venue, o.id, o.orderDiscounts[0].id, staffId)],
  ['coupon', (o: Fixture, venue = venueId) => tpv.applyCouponCode(venue, o.id, couponCode, staffVenueId)],
] as const
beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
  await prisma.venue.create({ data: { id: otherVenueId, organizationId: venueId, name: otherVenueId, slug: otherVenueId } })
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Discount', lastName: 'Atomic' } })).id
  staffVenueId = (await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })).id
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Catalog', slug: 'catalog' } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: 'Product', sku: 'T3', price: 100 } })).id
  chargeId = (await prisma.serviceCharge.create({ data: { venueId, name: 'Service', type: 'PERCENTAGE', value: 10 } })).id
  discountId = (
    await prisma.discount.create({
      data: { venueId, name: 'Ten', type: 'PERCENTAGE', value: 10, scope: 'ORDER', isAutomatic: true, isStackable: true },
    })
  ).id
  couponId = (await prisma.couponCode.create({ data: { discountId, code: couponCode } })).id
  customerId = (await prisma.customer.create({ data: { venueId, firstName: 'Customer' } })).id
  otherProductId = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: 'Other', sku: 'T3-OTHER', price: 150 } }))
    .id
  // Second automatic rule for batch tests; inactive unless a test turns it on.
  secondDiscountId = (
    await prisma.discount.create({
      data: {
        venueId,
        name: 'Fixed',
        type: 'FIXED_AMOUNT',
        value: 20,
        scope: 'ORDER',
        isAutomatic: true,
        isStackable: true,
        active: false,
      },
    })
  ).id
  groupId = (await prisma.customerGroup.create({ data: { venueId, name: 'VIP' } })).id
})
beforeEach(async () => {
  await prisma.discount.update({
    where: { id: discountId },
    data: {
      value: 10,
      active: true,
      requiresApproval: false,
      maxDiscountAmount: null,
      minPurchaseAmount: null,
      customerGroupId: null,
      currentUses: 0,
      priority: 0,
      scope: 'ORDER',
      targetItemIds: [],
      buyQuantity: null,
      getQuantity: null,
      getDiscountPercent: null,
    },
  })
  await prisma.discount.update({ where: { id: secondDiscountId }, data: { active: false, value: 20, priority: 0, currentUses: 0 } })
  await prisma.customer.update({ where: { id: customerId }, data: { customerGroupId: null } })
  await prisma.couponCode.update({ where: { id: couponId }, data: { active: true, minPurchaseAmount: null, maxUsesPerCustomer: null } })
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  await prisma.couponRedemption.deleteMany({ where: { couponCodeId: couponId } })
  await prisma.orderDiscount.deleteMany({ where: { order: { venueId } } })
  await prisma.orderServiceCharge.deleteMany({ where: { order: { venueId } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.couponCode.deleteMany({ where: { discount: { venueId } } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.customerGroup.deleteMany({ where: { venueId } })
  await prisma.serviceCharge.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, otherVenueId] } } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

describe('new serialized discount behavior', () => {
  it.each(writers)('%s waits for fiscal admission and rereads PAID without a version bump', async (name, run) => {
    const o = await newOrder(name === 'remove'),
      before = await snapshot(o.id)
    const fiscal = holdFiscal(o.id, tx => tx.order.update({ where: { id: o.id }, data: { paymentStatus: 'PAID', paidAmount: 126 } }))
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(run(o))
      await waitingOnOrder()
      expect(await snapshot(o.id)).toEqual(before)
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    if (name === 'coupon') expect((await writer!).value).toMatchObject({ success: false, error: 'Cannot apply coupon to a paid order' })
    else expect((await writer!).error?.message).toContain('paid order')
    expect(await snapshot(o.id)).toEqual(before)
  })
  it.each(writers)('%s from another venue gets 404 and writes nothing', async (name, run) => {
    const o = await newOrder(name === 'remove'),
      before = await snapshot(o.id)
    await expect(run(o, otherVenueId)).rejects.toMatchObject({ statusCode: 404, message: 'Order not found' })
    expect(await snapshot(o.id)).toEqual(before)
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: discountId } })).currentUses).toBe(0)
    expect(await prisma.couponRedemption.count({ where: { orderId: o.id } })).toBe(0)
  })
  it.each(writers)('%s holds Order until fiscal reads the entire committed operation', async (name, run) => {
    const o = await newOrder(name === 'remove'),
      entered = barrier(),
      finish = barrier()
    const original = lock.lockExistingOrderForPayment
    jest.spyOn(lock, 'lockExistingOrderForPayment').mockImplementationOnce(async (...args) => {
      const value = await original(...args)
      entered.release()
      await finish.promise
      return value
    })
    const writer = resultOf(run(o))
    let fiscal: Promise<Awaited<ReturnType<typeof snapshot>>> | undefined
    try {
      await Promise.race([
        entered.promise,
        writer.then(() => {
          throw new Error('writer never acquired Order lock')
        }),
      ])
      fiscal = prisma.$transaction(async tx => {
        await bloquearOrdenParaFacturar(tx, o.id)
        return snapshot(o.id, tx)
      })
      await waitingOnOrder()
    } finally {
      finish.release()
      await writer
    }
    expect((await writer).error).toBeUndefined()
    expect(await fiscal!).toEqual(await snapshot(o.id))
  })
  it.each(writers)('%s rolls back successful discount AND charge writes after a total fault', async (name, run) => {
    const o = await newOrder(name === 'remove'),
      before = await snapshot(o.id)
    const original = prisma.$transaction.bind(prisma)
    let childWritten = false,
      chargeWritten = false
    jest.spyOn(prisma, '$transaction').mockImplementation(((cb: any, opts: any) =>
      original(
        async tx =>
          cb(
            new Proxy(tx, {
              get(target, key) {
                return key === 'order'
                  ? new Proxy(target.order, {
                      get(model, method) {
                        return method === 'update'
                          ? async () => {
                              const after = await snapshot(o.id, tx)
                              childWritten = JSON.stringify(after.discounts) !== JSON.stringify(before.discounts)
                              chargeWritten = JSON.stringify(after.charges) !== JSON.stringify(before.charges)
                              throw new Error('after successful writes')
                            }
                          : Reflect.get(model, method)
                      },
                    })
                  : Reflect.get(target, key)
              },
            }),
          ),
        opts,
      )) as any)
    await expect(run(o)).rejects.toThrow('after successful writes')
    expect(childWritten).toBe(true)
    expect(chargeWritten).toBe(true)
    expect(await snapshot(o.id)).toEqual(before)
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: discountId } })).currentUses).toBe(0)
  })
  it.each(['predefined', 'manual', 'auto', 'coupon'] as const)(
    '%s rereads subtotal and discount amount after fiscal releases',
    async name => {
      const o = await newOrder()
      const fiscal = holdFiscal(o.id, async tx => {
        await tx.order.update({ where: { id: o.id }, data: { subtotal: 200, discountAmount: 50 } })
        await tx.orderItem.update({ where: { id: o.items[0].id }, data: { total: 200, unitPrice: 200 } })
      })
      let writer: ReturnType<typeof resultOf> | undefined
      try {
        await fiscal.entered
        writer = resultOf(writers.find(w => w[0] === name)![1](o))
        await waitingOnOrder()
      } finally {
        fiscal.release()
        await fiscal.done
        await writer
      }
      expect((await writer!).error).toBeUndefined()
      const after = await snapshot(o.id)
      expect(after.discount).toBe(['manual', 'coupon'].includes(name) ? 65 : 70)
      expect(after.version).toBe(o.version)
    },
  )
  it('rejects a previously calculated discount whose rules changed without touching the Order version', async () => {
    const o = await newOrder(),
      [cached] = await evaluateAutomaticDiscounts(o.id)
    const fiscal = holdFiscal(o.id, tx => tx.discount.update({ where: { id: discountId }, data: { minPurchaseAmount: 500 } }))
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(applyDiscountToOrder(o.id, cached))
      await waitingOnOrder()
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    expect((await writer!).value).toMatchObject({ success: false })
    expect((await snapshot(o.id)).discounts).toHaveLength(0)
  })
  it.each(['predefined', 'auto'] as const)('%s recomputes fresh catalog value and tax reduction', async name => {
    const o = await newOrder()
    const fiscal = holdFiscal(o.id, tx => tx.discount.update({ where: { id: discountId }, data: { value: 30 } }))
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(writers.find(w => w[0] === name)![1](o))
      await waitingOnOrder()
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    expect((await writer!).error).toBeUndefined()
    expect((await snapshot(o.id)).discounts[0]).toMatchObject({ amount: 30, tax: 4.8 })
  })
  it.each(['predefined', 'coupon'] as const)('%s serializes duplicate concurrent application', async name => {
    const o = await newOrder(),
      fiscal = holdFiscal(o.id)
    let jobs: Array<ReturnType<typeof resultOf>> = []
    try {
      await fiscal.entered
      const run = writers.find(w => w[0] === name)![1]
      jobs = [resultOf(run(o)), resultOf(run(o))]
      await waitingOnOrder(2)
    } finally {
      fiscal.release()
      await fiscal.done
      await Promise.all(jobs)
    }
    const after = await snapshot(o.id)
    expect(after.discounts).toHaveLength(1)
    expect(after.discount).toBe(10)
    expect(await prisma.couponRedemption.count({ where: { orderId: o.id } })).toBe(0)
    expect((await prisma.couponCode.findUniqueOrThrow({ where: { id: couponId } })).currentUses).toBe(0)
  })
  it('coupon revalidates the minimum against the fresh subtotal', async () => {
    await prisma.couponCode.update({ where: { id: couponId }, data: { minPurchaseAmount: 80 } })
    const o = await newOrder(),
      fiscal = holdFiscal(o.id, tx => tx.order.update({ where: { id: o.id }, data: { subtotal: 40 } }))
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(tpv.applyCouponCode(venueId, o.id, couponCode, staffVenueId))
      await waitingOnOrder()
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    expect((await writer!).value).toMatchObject({ success: false, error: 'Minimum purchase of 80 required' })
    expect((await snapshot(o.id)).discounts).toHaveLength(0)
  })
  it('coupon revalidates the changed customer and their paid redemption', async () => {
    const paid = await newOrder()
    await prisma.couponRedemption.create({ data: { couponCodeId: couponId, customerId, orderId: paid.id, amountSaved: 10 } })
    await prisma.couponCode.update({ where: { id: couponId }, data: { maxUsesPerCustomer: 1 } })
    const o = await newOrder(),
      fiscal = holdFiscal(o.id, tx => tx.order.update({ where: { id: o.id }, data: { customerId } }))
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(tpv.applyCouponCode(venueId, o.id, couponCode, staffVenueId))
      await waitingOnOrder()
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    expect((await writer!).value).toMatchObject({ success: false, error: 'You have already used this coupon 1 time(s)' })
    expect((await snapshot(o.id)).discounts).toHaveLength(0)
  })
  // Item-specific bases: ITEM reads the fresh targeted line (not the subtotal), BOGO the fresh quantity.
  const itemScenarios = {
    ITEM: {
      rule: () => ({ scope: 'ITEM' as const, targetItemIds: [productId] }),
      change: async (tx: Prisma.TransactionClient, o: Fixture) => {
        await tx.orderItem.update({ where: { id: o.items[0].id }, data: { unitPrice: 250, total: 250 } })
        await tx.orderItem.create({
          data: { orderId: o.id, productId: otherProductId, productName: 'Other', quantity: 1, unitPrice: 150, total: 150, taxAmount: 24 },
        })
        await tx.order.update({ where: { id: o.id }, data: { subtotal: 400 } })
      },
      expected: { amount: 25, tax: 4 },
    },
    BOGO: {
      rule: () => ({ scope: 'QUANTITY' as const, buyQuantity: 1, getQuantity: 1, getDiscountPercent: 100 }),
      change: async (tx: Prisma.TransactionClient, o: Fixture) => {
        await tx.orderItem.update({ where: { id: o.items[0].id }, data: { quantity: 2, total: 200 } })
        await tx.order.update({ where: { id: o.id }, data: { subtotal: 200 } })
      },
      expected: { amount: 100, tax: 16 },
    },
  }
  it.each([
    ['ITEM', 'predefined'],
    ['ITEM', 'auto'],
    ['BOGO', 'predefined'],
    ['BOGO', 'auto'],
  ] as const)('%s base is recomputed from the fresh lines for %s', async (scenario, name) => {
    const { rule, change, expected } = itemScenarios[scenario]
    await prisma.discount.update({ where: { id: discountId }, data: rule() })
    const o = await newOrder(),
      fiscal = holdFiscal(o.id, tx => change(tx, o))
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(writers.find(w => w[0] === name)![1](o))
      await waitingOnOrder()
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    expect((await writer!).error).toBeUndefined()
    const after = await snapshot(o.id)
    expect(after.discounts).toHaveLength(1)
    expect(after.discounts[0]).toMatchObject(expected)
  })
  it.each(['predefined', 'auto'] as const)('%s rereads customer-group eligibility after fiscal releases', async name => {
    await prisma.discount.update({ where: { id: discountId }, data: { customerGroupId: groupId } })
    await prisma.customer.update({ where: { id: customerId }, data: { customerGroupId: groupId } })
    const o = await newOrder()
    await prisma.order.update({ where: { id: o.id }, data: { customerId } })
    const fiscal = holdFiscal(o.id, tx => tx.customer.update({ where: { id: customerId }, data: { customerGroupId: null } }))
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(writers.find(w => w[0] === name)![1](o))
      await waitingOnOrder()
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    if (name === 'predefined') expect((await writer!).error?.message).toBe('This discount cannot be applied to this order')
    else expect((await writer!).value).toMatchObject({ applied: 0, totalSavings: 0 })
    expect((await snapshot(o.id)).discounts).toHaveLength(0)
  })
  const deactivate = {
    coupon: (tx: Prisma.TransactionClient) => tx.couponCode.update({ where: { id: couponId }, data: { active: false } }),
    discount: (tx: Prisma.TransactionClient) => tx.discount.update({ where: { id: discountId }, data: { active: false } }),
  }
  it.each([
    ['coupon', 'Coupon code is inactive'],
    ['discount', 'Discount associated with this coupon is inactive'],
  ] as const)('coupon rereads a %s deactivated while it waited', async (which, error) => {
    const o = await newOrder(),
      fiscal = holdFiscal(o.id, deactivate[which])
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(tpv.applyCouponCode(venueId, o.id, couponCode, staffVenueId))
      await waitingOnOrder()
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    expect((await writer!).value).toMatchObject({ success: false, error })
    expect((await snapshot(o.id)).discounts).toHaveLength(0)
  })
  it('auto rolls back the whole batch when the SECOND discount fails after its writes', async () => {
    await prisma.discount.update({ where: { id: discountId }, data: { priority: 10 } })
    await prisma.discount.update({ where: { id: secondDiscountId }, data: { active: true, priority: 5 } })
    const o = await newOrder(),
      before = await snapshot(o.id)
    const original = prisma.$transaction.bind(prisma)
    let updates = 0
    let insideSecond: Awaited<ReturnType<typeof snapshot>> | undefined
    jest.spyOn(prisma, '$transaction').mockImplementation(((cb: any, opts: any) =>
      original(
        async tx =>
          cb(
            new Proxy(tx, {
              get(target, key) {
                return key === 'order'
                  ? new Proxy(target.order, {
                      get(model, method) {
                        return method === 'update'
                          ? async (args: any) => {
                              if (++updates < 2) return target.order.update(args)
                              insideSecond = await snapshot(o.id, tx)
                              throw new Error('after second discount')
                            }
                          : Reflect.get(model, method)
                      },
                    })
                  : Reflect.get(target, key)
              },
            }),
          ),
        opts,
      )) as any)
    await expect(tpv.applyAutomaticDiscounts(venueId, o.id, staffVenueId)).rejects.toThrow('after second discount')
    // The first discount was fully written (child, charge, totals) and the second child existed when it failed.
    expect(insideSecond?.discounts).toHaveLength(2)
    expect(insideSecond?.discount).toBe(10)
    expect(await snapshot(o.id)).toEqual(before)
    for (const id of [discountId, secondDiscountId])
      expect((await prisma.discount.findUniqueOrThrow({ where: { id } })).currentUses).toBe(0)
  })
})

describe('existing discount policies', () => {
  it('automatic discounts needing approval remain skipped', async () => {
    await prisma.discount.update({ where: { id: discountId }, data: { requiresApproval: true } })
    const o = await newOrder()
    expect(await tpv.applyAutomaticDiscounts(venueId, o.id, staffVenueId)).toMatchObject({ applied: 0, totalSavings: 0 })
    expect(await tpv.applyPredefinedDiscount(venueId, o.id, discountId, staffVenueId)).toMatchObject({
      success: false,
      error: 'This discount requires manager approval',
    })
  })
  it('predefined keeps its public errors: inactive rule 404, ineligible rule 400', async () => {
    const o = await newOrder()
    await prisma.discount.update({ where: { id: discountId }, data: { active: false } })
    await expect(tpv.applyPredefinedDiscount(venueId, o.id, discountId, staffVenueId)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Discount not found or inactive',
    })
    await prisma.discount.update({ where: { id: discountId }, data: { active: true, minPurchaseAmount: 500 } })
    await expect(tpv.applyPredefinedDiscount(venueId, o.id, discountId, staffVenueId)).rejects.toMatchObject({
      statusCode: 400,
      message: 'This discount cannot be applied to this order',
    })
    expect((await snapshot(o.id)).discounts).toHaveLength(0)
  })
  it('PARTIAL remains allowed, caps the remaining base, and preserves paid balance', async () => {
    const o = await newOrder()
    await prisma.order.update({ where: { id: o.id }, data: { paymentStatus: 'PARTIAL', discountAmount: 95, paidAmount: 5 } })
    expect(await tpv.applyManualDiscount(venueId, o.id, 'FIXED_AMOUNT', 20, 'Cap', staffVenueId)).toMatchObject({
      success: true,
      amount: 5,
      newOrderTotal: 16,
    })
    expect((await snapshot(o.id)).remaining).toBe(11)
  })
  // Characterization (settled ruling): the response still adds each rule's requested amount while
  // persistence caps the stacked rule against the remaining base. Passes before and after Task 3.
  it('auto keeps the uncapped response aggregation while persisting capped stacked amounts', async () => {
    await prisma.discount.update({ where: { id: discountId }, data: { priority: 10 } })
    await prisma.discount.update({ where: { id: secondDiscountId }, data: { active: true, value: 95, priority: 5 } })
    const o = await newOrder()
    expect(await tpv.applyAutomaticDiscounts(venueId, o.id, staffVenueId)).toMatchObject({ applied: 2, totalSavings: 105 })
    const after = await snapshot(o.id)
    expect(after.discounts.map(d => d.amount).sort((a, b) => a - b)).toEqual([10, 90])
    expect(after.discount).toBe(100)
  })
})
