/**
 * Plan3b T4: mobile order-discount, split, split-by-seat, promotion, loyalty and stamp writers serialize with fiscal
 * admission on the real Order row, decide from the locked read (no version bump needed), and roll back as one unit;
 * `createOrderWithItems` writes the promotions and its reaffirmed money inside the transaction that creates the order.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as orderLock from '@/services/shared/paymentShiftClaim'
import { bloquearOrdenParaFacturar } from '@/services/fiscal/admisionIva'
import {
  applyOrderDiscount,
  createOrderWithItems,
  removeOrderDiscount,
  splitOrderBySeat,
  splitOrderItems,
} from '@/services/mobile/order.mobile.service'
import { applyPromotionToOrder, removePromotionFromOrder } from '@/services/promotions/promotion.service'
import { redeemPointsToOrder } from '@/services/mobile/loyalty.mobile.service'
import { redeemStampReward } from '@/services/wallet/redeemStampReward.service'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import * as featureAccess from '@/middlewares/checkFeatureAccess.middleware'
import * as tableOwnership from '@/middlewares/checkTableOwnership.middleware'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(database.pathname)
) {
  throw new Error('This suite requires an explicitly selected isolated local test database.')
}
const venueId = `mobile-writers-${randomUUID()}`
// A second venue of the same organization: a route for it must never reach an Order of `venueId`.
const otherVenueId = `mobile-writers-other-${randomUUID()}`
let staffId: string, customerId: string, productA: string, productB: string
let discountId: string, fixedDiscountId: string, promotionId: string, draftPromotionId: string
let selections: Array<{ groupId: string; optionId: string }>, draftSelections: Array<{ groupId: string; optionId: string }>
let cycle = 0

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}
// Writers return different shapes: the harness only inspects outcomes.
const resultOf = (promise: Promise<unknown>) =>
  promise.then(
    value => ({ value: value as any, error: undefined as any }),
    error => ({ value: undefined as any, error }),
  )
async function waitingOn(pattern = '%"Order"%', minimum = 1) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`
    if (count >= minimum) return
    await pause(20)
  }
  throw new Error(`No connection waited on ${pattern}`)
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
    { timeout: 15_000 },
  )
  return { entered: entered.promise, release: finish.release, done }
}
/** Runs `run` while fiscal admission holds the Order; returns its outcome after fiscal commits. */
async function whileFiscalHolds(orderId: string, change: (tx: Prisma.TransactionClient) => Promise<unknown>, run: () => Promise<unknown>) {
  const fiscal = holdFiscal(orderId, change)
  let writer: ReturnType<typeof resultOf> | undefined
  try {
    await fiscal.entered
    writer = resultOf(run())
    await waitingOn()
  } finally {
    fiscal.release()
    await fiscal.done
    await writer
  }
  return writer!
}
async function snapshot(orderId: string, db: Prisma.TransactionClient = prisma) {
  const o = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: { orderBy: { id: 'asc' } },
      orderDiscounts: { orderBy: { id: 'asc' } },
      promotions: { orderBy: { id: 'asc' } },
    },
  })
  return {
    status: o.status,
    paymentStatus: o.paymentStatus,
    version: o.version,
    subtotal: Number(o.subtotal),
    discount: Number(o.discountAmount),
    total: Number(o.total),
    paid: Number(o.paidAmount),
    remaining: Number(o.remainingBalance),
    items: o.items.map(i => ({ id: i.id, total: Number(i.total), promo: i.orderPromotionId, seat: i.seat })),
    discounts: o.orderDiscounts.map(d => ({ id: d.id, amount: Number(d.amount), loyalty: d.loyaltyTransactionId })),
    promotions: o.promotions.map(p => p.instanceId),
  }
}
type Fixture = Awaited<ReturnType<typeof newOrder>>
async function state(o: Fixture, db: Prisma.TransactionClient = prisma) {
  const rewards = await db.stampReward.findMany({ where: { id: { in: o.rewardIds } }, orderBy: { id: 'asc' }, take: 10 })
  return {
    order: await snapshot(o.id, db),
    points: (await db.customer.findUniqueOrThrow({ where: { id: customerId } })).loyaltyPoints,
    rewards: rewards.map(r => ({ status: r.status, orderDiscountId: r.orderDiscountId })),
    loyaltyTransactions: await db.loyaltyTransaction.count({ where: { orderId: o.id } }),
    venueOrders: await db.order.count({ where: { venueId } }),
  }
}
async function newReward(data: Partial<Prisma.StampRewardUncheckedCreateInput> = {}) {
  const card = await prisma.stampCard.create({
    data: { customerId, venueId, cycle: ++cycle, stampsRequired: 1, stampsEarned: 1, completedAt: new Date() },
  })
  return prisma.stampReward.create({
    data: { stampCardId: card.id, customerId, venueId, rewardType: 'FIXED_AMOUNT', rewardValue: 30, rewardLabel: 'Premio', ...data },
  })
}
type Kind = 'plain' | 'discount' | 'stampDiscount' | 'promotion' | 'reward'
async function newOrder(kind: Kind = 'plain') {
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      customerId,
      subtotal: 150,
      discountAmount: 0,
      taxAmount: 0,
      total: 150,
      remainingBalance: 150,
      items: {
        create: [
          { productId: productA, productName: 'Plato', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100, seat: 1 },
          { productId: productB, productName: 'Bebida', quantity: 1, unitPrice: 50, taxAmount: 0, total: 50, seat: 2 },
        ],
      },
    },
    include: { items: { orderBy: { total: 'desc' } } },
  })
  const fixture = {
    id: order.id,
    items: order.items.map(i => i.id),
    orderDiscountId: '',
    orderPromotionId: '',
    rewardIds: [] as string[],
  }
  if (kind === 'discount' || kind === 'stampDiscount') {
    // A redemption already on the check: removing it must give the points (or the reward) back in the same tx.
    const loyalty =
      kind === 'discount'
        ? await prisma.loyaltyTransaction.create({ data: { customerId, type: 'REDEEM', points: -1000, orderId: order.id } })
        : null
    if (loyalty) await prisma.customer.update({ where: { id: customerId }, data: { loyaltyPoints: { decrement: 1000 } } })
    fixture.orderDiscountId = (
      await prisma.orderDiscount.create({
        data: {
          orderId: order.id,
          type: 'FIXED_AMOUNT',
          name: 'Recompensa',
          value: 10,
          amount: 10,
          isManual: true,
          loyaltyTransactionId: loyalty?.id ?? null,
        },
      })
    ).id
    if (kind === 'stampDiscount') {
      fixture.rewardIds.push((await newReward({ status: 'REDEEMED', redeemedAt: new Date(), orderDiscountId: fixture.orderDiscountId })).id)
    }
    await prisma.order.update({ where: { id: order.id }, data: { discountAmount: 10, total: 140, remainingBalance: 140 } })
  }
  if (kind === 'promotion') {
    const op = await prisma.orderPromotion.create({
      data: {
        orderId: order.id,
        promotionId,
        instanceId: randomUUID(),
        snapshotJson: { name: 'Combo' },
        grossCents: 15000,
        discountCents: 6000,
        netCents: 9000,
      },
    })
    await prisma.orderItem.createMany({
      data: [
        {
          orderId: order.id,
          orderPromotionId: op.id,
          productId: productA,
          productName: 'Plato',
          quantity: 1,
          unitPrice: 100,
          discountAmount: 40,
          taxAmount: 0,
          total: 60,
        },
        {
          orderId: order.id,
          orderPromotionId: op.id,
          productId: productB,
          productName: 'Bebida',
          quantity: 1,
          unitPrice: 50,
          discountAmount: 20,
          taxAmount: 0,
          total: 30,
        },
      ],
    })
    await prisma.order.update({ where: { id: order.id }, data: { subtotal: 240, total: 240, remainingBalance: 240 } })
    fixture.orderPromotionId = op.id
  }
  if (kind === 'reward') fixture.rewardIds.push((await newReward()).id)
  return fixture
}

const writers = [
  ['applyDiscount', 'plain', (o: Fixture, v = venueId) => applyOrderDiscount(v, o.id, discountId, staffId)],
  ['removeDiscount', 'discount', (o: Fixture, v = venueId) => removeOrderDiscount(v, o.id, o.orderDiscountId, staffId)],
  ['split', 'plain', (o: Fixture, v = venueId) => splitOrderItems(v, o.id, [o.items[1]], staffId)],
  ['splitBySeat', 'plain', (o: Fixture, v = venueId) => splitOrderBySeat(v, o.id, staffId)],
  [
    'applyPromotion',
    'plain',
    (o: Fixture, v = venueId) =>
      applyPromotionToOrder({ venueId: v, orderId: o.id, promotionId, instanceId: randomUUID(), selections, soldAt: new Date() }),
  ],
  [
    'removePromotion',
    'promotion',
    (o: Fixture, v = venueId) => removePromotionFromOrder({ venueId: v, orderId: o.id, orderPromotionId: o.orderPromotionId }),
  ],
  ['redeemPoints', 'plain', (o: Fixture, v = venueId) => redeemPointsToOrder(v, o.id, customerId, 1000, staffId)],
  ['redeemStamp', 'reward', (o: Fixture, v = venueId) => redeemStampReward(v, o.id, o.rewardIds[0], { staffId })],
] as const
type Name = (typeof writers)[number][0]
const PAID_MESSAGE: Record<Name, string> = {
  applyDiscount: 'No se puede descontar una orden ya pagada',
  removeDiscount: 'No se puede modificar una orden ya pagada',
  split: 'No se puede separar una cuenta ya pagada',
  splitBySeat: 'No se puede dividir una cuenta ya pagada',
  applyPromotion: 'A una cuenta ya pagada no se le pueden agregar promociones.',
  removePromotion: 'Esta cuenta ya se pagó: retira la promoción con un reembolso, no borrándola.',
  redeemPoints: 'No se puede modificar una orden ya pagada',
  redeemStamp: 'No se puede aplicar un premio a una cuenta ya pagada.',
}
const NOT_FOUND_MESSAGE: Record<Name, string> = {
  applyDiscount: 'Order not found',
  removeDiscount: 'Order not found',
  split: 'Order not found',
  splitBySeat: 'Order not found',
  applyPromotion: 'No encontramos esa cuenta en este establecimiento.',
  removePromotion: 'No encontramos esa promoción en la cuenta.',
  redeemPoints: 'Orden no encontrada',
  redeemStamp: 'Orden no encontrada',
}
type State = Awaited<ReturnType<typeof state>>
/** Which Order-total write fails, and what must already be written in the SAME tx when it does. */
const ROLLBACK: Record<Name, { nth: number; written: (inside: State, before: State) => boolean }> = {
  applyDiscount: { nth: 1, written: (i, b) => i.order.discounts.length === b.order.discounts.length + 1 },
  removeDiscount: { nth: 1, written: (i, b) => i.points === b.points + 1000 && i.order.discounts.length === 0 },
  // The SECOND total write (the new check's) fails after the new check, the moved line and the source totals exist.
  split: { nth: 2, written: (i, b) => i.venueOrders === b.venueOrders + 1 && i.order.items.length === 1 && i.order.subtotal === 100 },
  splitBySeat: {
    nth: 2,
    written: (i, b) => i.venueOrders === b.venueOrders + 1 && i.order.items.length === 1 && i.order.subtotal === 100,
  },
  applyPromotion: { nth: 1, written: i => i.order.promotions.length === 1 && i.order.items.length === 4 },
  removePromotion: { nth: 1, written: i => i.order.promotions.length === 0 && i.order.items.length === 2 },
  redeemPoints: {
    nth: 1,
    written: (i, b) => i.points === b.points - 1000 && i.order.discounts.length === 1 && i.loyaltyTransactions === 1,
  },
  redeemStamp: { nth: 1, written: i => i.rewards[0]?.status === 'REDEEMED' && i.order.discounts.length === 1 },
}

/** Proxies every interactive transaction; `onOrderUpdate` / `onCreate` intercept the named calls on that tx. */
function interceptTransactions(hooks: {
  orderUpdate?: (args: any, tx: Prisma.TransactionClient, next: () => Promise<unknown>) => Promise<unknown>
  create?: { model: string; run: (args: any, tx: Prisma.TransactionClient, next: () => Promise<unknown>) => Promise<unknown> }
}) {
  const original = prisma.$transaction.bind(prisma)
  jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options: any) =>
    Array.isArray(callback)
      ? original(callback)
      : original(
          async tx =>
            callback(
              new Proxy(tx, {
                get(target, key) {
                  if (key === 'order' && hooks.orderUpdate) {
                    return new Proxy(target.order, {
                      get(model, method) {
                        return method === 'update'
                          ? (args: any) => hooks.orderUpdate!(args, tx, () => model.update(args))
                          : Reflect.get(model, method)
                      },
                    })
                  }
                  if (hooks.create && key === hooks.create.model) {
                    const delegate = (target as any)[key]
                    return new Proxy(delegate, {
                      get(model, method) {
                        return method === 'create'
                          ? (args: any) => hooks.create!.run(args, tx, () => model.create(args))
                          : Reflect.get(model, method)
                      },
                    })
                  }
                  return Reflect.get(target, key)
                },
              }),
            ),
          options,
        )) as any)
}

beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
  await prisma.venue.create({ data: { id: otherVenueId, organizationId: venueId, name: otherVenueId, slug: otherVenueId } })
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Mobile', lastName: 'Writers' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Catalog', slug: 'catalog' } })
  productA = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: 'Plato', sku: 'T4-A', price: 100 } })).id
  productB = (await prisma.product.create({ data: { venueId, categoryId: category.id, name: 'Bebida', sku: 'T4-B', price: 50 } })).id
  discountId = (await prisma.discount.create({ data: { venueId, name: 'Diez', type: 'PERCENTAGE', value: 10, scope: 'ORDER' } })).id
  fixedDiscountId = (
    await prisma.discount.create({ data: { venueId, name: 'Doscientos', type: 'FIXED_AMOUNT', value: 200, scope: 'ORDER' } })
  ).id
  customerId = (await prisma.customer.create({ data: { venueId, firstName: 'Cliente', loyaltyPoints: 1_000_000 } })).id
  await prisma.loyaltyConfig.create({ data: { venueId, active: true, redemptionRate: 0.01, minPointsRedeem: 100 } })
  const combo = (status: 'PUBLISHED' | 'DRAFT') =>
    prisma.promotion.create({
      data: {
        venueId,
        name: `Combo ${status}`,
        type: 'BUNDLE',
        pricingMode: 'FIXED_TOTAL',
        priceCents: 9000,
        status,
        daysOfWeek: [],
        groups: {
          create: [
            { name: 'Plato', displayOrder: 0, options: { create: [{ productId: productA }] } },
            { name: 'Bebida', displayOrder: 1, options: { create: [{ productId: productB }] } },
          ],
        },
      },
      include: { groups: { include: { options: true }, orderBy: { displayOrder: 'asc' } } },
    })
  const published = await combo('PUBLISHED')
  const draft = await combo('DRAFT')
  promotionId = published.id
  draftPromotionId = draft.id
  selections = published.groups.map(g => ({ groupId: g.id, optionId: g.options[0].id }))
  draftSelections = draft.groups.map(g => ({ groupId: g.id, optionId: g.options[0].id }))
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  await prisma.posSyncIntent.deleteMany({ where: { venueId: { in: [venueId, otherVenueId] } } })
  await prisma.order.deleteMany({ where: { venueId: { in: [venueId, otherVenueId] } } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.loyaltyTransaction.deleteMany({ where: { customerId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.promotion.deleteMany({ where: { venueId } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, otherVenueId] } } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

describe('locked mobile writers against real fiscal admission', () => {
  it.each(writers)('%s waits for the fiscal Order lock, then rereads PAID without a version bump', async (name, kind, run) => {
    const o = await newOrder(kind)
    const before = await state(o)
    const fiscal = holdFiscal(o.id, tx =>
      tx.order.update({ where: { id: o.id }, data: { paymentStatus: 'PAID', paidAmount: before.order.total } }),
    )
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(run(o))
      await waitingOn()
      // While fiscal admission holds the Order, nothing of the writer is visible.
      expect(await state(o)).toEqual(before)
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    expect((await writer!).error?.message).toBe(PAID_MESSAGE[name])
    expect(await state(o)).toEqual({ ...before, order: { ...before.order, paymentStatus: 'PAID', paid: before.order.total } })
  })

  it.each(writers)('%s holds the Order until fiscal admission can read the complete operation', async (_name, kind, run) => {
    const o = await newOrder(kind)
    const entered = barrier(),
      finish = barrier()
    const lock = orderLock.lockExistingOrderForPayment
    jest.spyOn(orderLock, 'lockExistingOrderForPayment').mockImplementationOnce(async (...args) => {
      const value = await lock(...args)
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
      await waitingOn()
    } finally {
      finish.release()
      await writer
    }
    expect((await writer).error).toBeUndefined()
    expect(await fiscal!).toEqual(await snapshot(o.id))
  })

  it.each(writers)('%s rolls back every write when a later Order-total write fails', async (name, kind, run) => {
    const o = await newOrder(kind)
    const before = await state(o)
    const { nth, written } = ROLLBACK[name]
    let totals = 0,
      observed = false
    interceptTransactions({
      orderUpdate: async (args, tx, next) => {
        if (args?.data?.total === undefined || ++totals < nth) return next()
        observed = written(await state(o, tx), before)
        throw new Error('injected failure after successful writes')
      },
    })
    await expect(run(o)).rejects.toThrow('injected failure after successful writes')
    expect(observed).toBe(true)
    expect(await state(o)).toEqual(before)
  })

  it.each(writers)('%s from another venue gets a 404 and writes nothing', async (name, kind, run) => {
    const o = await newOrder(kind)
    const before = await state(o)
    await expect(run(o, otherVenueId)).rejects.toMatchObject({ statusCode: 404, message: NOT_FOUND_MESSAGE[name] })
    expect(await state(o)).toEqual(before)
  })
})

describe('split writers take the Venue before the source Order (deleteVenue order: Venue, then its Orders)', () => {
  it.each([
    ['split', (o: Fixture) => splitOrderItems(venueId, o.id, [o.items[1]], staffId)],
    ['splitBySeat', (o: Fixture) => splitOrderBySeat(venueId, o.id, staffId)],
  ] as const)('%s waits for a deletion holding the Venue without holding the source Order, then finishes', async (_name, run) => {
    const o = await newOrder()
    const entered = barrier(),
      finish = barrier()
    const lock = jest.spyOn(orderLock, 'lockExistingOrderForPayment')
    const deleting = prisma.$transaction(
      async tx => {
        // Same ordering as deleteVenue / liveDemoCleanup: Venue FOR UPDATE, then its Orders.
        await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR UPDATE`
        entered.release()
        await finish.promise
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${o.id} FOR UPDATE NOWAIT`
      },
      { timeout: 15_000 },
    )
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await entered.promise
      writer = resultOf(run(o))
      let waiting = false
      for (let attempt = 0; attempt < 150 && !waiting; attempt++) {
        const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND (query ILIKE '%"Venue"%' OR query ILIKE '%"Order"%')`
        waiting = count > 0
        if (!waiting) await pause(20)
      }
      expect(waiting).toBe(true)
      // It waits on the Venue and has not taken the source Order: another connection can still lock it without waiting.
      expect(lock.mock.calls.length).toBe(0)
      await prisma.$transaction(tx => tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${o.id} FOR UPDATE NOWAIT`)
    } finally {
      finish.release()
      const deletion = await resultOf(deleting)
      await writer
      expect(deletion.error).toBeUndefined()
    }
    expect((await writer!).error).toBeUndefined()
    expect((await snapshot(o.id)).items).toHaveLength(1)
  })
})

describe('fresh decisions after waiting', () => {
  it('applyDiscount caps a fixed discount against the subtotal and discount read after waiting', async () => {
    const o = await newOrder()
    const writer = await whileFiscalHolds(
      o.id,
      async tx => {
        await tx.orderItem.create({
          data: { orderId: o.id, productId: productA, productName: 'Plato', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 },
        })
        await tx.order.update({ where: { id: o.id }, data: { subtotal: 250, discountAmount: 30, total: 220, remainingBalance: 220 } })
      },
      () => applyOrderDiscount(venueId, o.id, fixedDiscountId, staffId),
    )
    expect(writer.error).toBeUndefined()
    // Fresh: min(200, 250) capped at 250 − 30 = 220 → 200. From the stale photo it would have been 150.
    const after = await snapshot(o.id)
    expect(after.discounts.map(d => d.amount)).toEqual([200])
    expect(after).toMatchObject({ subtotal: 250, discount: 200, total: 50 })
  })

  it('split rereads the source lines: the line that was to stay was removed while it waited', async () => {
    const o = await newOrder()
    const before = await state(o)
    const writer = await whileFiscalHolds(
      o.id,
      async tx => {
        await tx.orderItem.delete({ where: { id: o.items[0] } })
        await tx.order.update({ where: { id: o.id }, data: { subtotal: 50, total: 50, remainingBalance: 50 } })
      },
      () => splitOrderItems(venueId, o.id, [o.items[1]], staffId),
    )
    expect(writer.error?.message).toBe('Debe quedar al menos un artículo en la cuenta original')
    const after = await state(o)
    expect(after.venueOrders).toBe(before.venueOrders)
    expect(after.order.items.map(i => i.id)).toEqual([o.items[1]])
  })

  it('split rereads a concurrent payment (PARTIAL without a version bump) and refuses', async () => {
    const o = await newOrder()
    const before = await state(o)
    const writer = await whileFiscalHolds(
      o.id,
      tx => tx.order.update({ where: { id: o.id }, data: { paymentStatus: 'PARTIAL', paidAmount: 20, remainingBalance: 130 } }),
      () => splitOrderItems(venueId, o.id, [o.items[1]], staffId),
    )
    expect(writer.error?.message).toBe('No se puede separar una cuenta ya pagada')
    expect((await state(o)).venueOrders).toBe(before.venueOrders)
  })

  it('split keeps a line added while it waited on the source and recalculates both checks', async () => {
    const o = await newOrder()
    const writer = await whileFiscalHolds(
      o.id,
      async tx => {
        await tx.orderItem.create({
          data: { orderId: o.id, productId: productA, productName: 'Extra', quantity: 1, unitPrice: 70, taxAmount: 0, total: 70 },
        })
        await tx.order.update({ where: { id: o.id }, data: { subtotal: 220, total: 220, remainingBalance: 220 } })
      },
      () => splitOrderItems(venueId, o.id, [o.items[1]], staffId),
    )
    expect(writer.error).toBeUndefined()
    expect(await snapshot(o.id)).toMatchObject({ subtotal: 170, total: 170, remaining: 170 })
    expect(await snapshot(writer.value.created.id)).toMatchObject({ subtotal: 50, total: 50, items: [{ id: o.items[1] }] })
  })

  it('splitBySeat groups the seats read after waiting', async () => {
    const o = await newOrder()
    const before = await state(o)
    const writer = await whileFiscalHolds(
      o.id,
      tx => tx.orderItem.update({ where: { id: o.items[1] }, data: { seat: 1 } }),
      () => splitOrderBySeat(venueId, o.id, staffId),
    )
    expect(writer.error?.message).toBe('Se necesitan al menos dos asientos con artículos para dividir por puesto')
    expect((await state(o)).venueOrders).toBe(before.venueOrders)
  })

  it('applyPromotion inherits the discount read after waiting', async () => {
    const o = await newOrder()
    const writer = await whileFiscalHolds(
      o.id,
      tx => tx.order.update({ where: { id: o.id }, data: { discountAmount: 20, total: 130, remainingBalance: 130 } }),
      () => applyPromotionToOrder({ venueId, orderId: o.id, promotionId, instanceId: randomUUID(), selections, soldAt: new Date() }),
    )
    expect(writer.error).toBeUndefined()
    expect(await snapshot(o.id)).toMatchObject({ subtotal: 240, discount: 20, total: 220, remaining: 220 })
  })

  it('removePromotion inherits the discount read after waiting', async () => {
    const o = await newOrder('promotion')
    const writer = await whileFiscalHolds(
      o.id,
      tx => tx.order.update({ where: { id: o.id }, data: { discountAmount: 20, total: 220, remainingBalance: 220 } }),
      () => removePromotionFromOrder({ venueId, orderId: o.id, orderPromotionId: o.orderPromotionId }),
    )
    expect(writer.error).toBeUndefined()
    expect(await snapshot(o.id)).toMatchObject({ subtotal: 150, discount: 20, total: 130, promotions: [] })
  })

  it('two concurrent applications of the same instance create one promotion (created:false for the replay)', async () => {
    const o = await newOrder()
    const instanceId = randomUUID()
    const apply = () => applyPromotionToOrder({ venueId, orderId: o.id, promotionId, instanceId, selections, soldAt: new Date() })
    const fiscal = holdFiscal(o.id)
    let jobs: Array<ReturnType<typeof resultOf>> = []
    try {
      await fiscal.entered
      jobs = [resultOf(apply()), resultOf(apply())]
      await waitingOn('%"Order"%', 2)
    } finally {
      fiscal.release()
      await fiscal.done
      await Promise.all(jobs)
    }
    const outcomes = await Promise.all(jobs)
    expect(outcomes.map(r => r.error)).toEqual([undefined, undefined])
    expect(outcomes.map(r => r.value.created).sort()).toEqual([false, true])
    expect(await snapshot(o.id)).toMatchObject({ subtotal: 240, total: 240, promotions: [instanceId] })
    expect((await snapshot(o.id)).items).toHaveLength(4)
  })

  it('a replayed instance on an order that was paid meanwhile still answers created:false and writes nothing', async () => {
    const o = await newOrder()
    const instanceId = randomUUID()
    const apply = () => applyPromotionToOrder({ venueId, orderId: o.id, promotionId, instanceId, selections, soldAt: new Date() })
    await apply()
    await prisma.order.update({ where: { id: o.id }, data: { paymentStatus: 'PAID', paidAmount: 240, remainingBalance: 0 } })
    const before = await state(o)
    await expect(apply()).resolves.toMatchObject({ created: false })
    expect(await state(o)).toEqual(before)
  })

  it('redeemPoints caps against the base read after waiting and burns only what it gives', async () => {
    const o = await newOrder()
    const before = await state(o)
    const writer = await whileFiscalHolds(
      o.id,
      async tx => {
        await tx.orderItem.delete({ where: { id: o.items[0] } })
        await tx.order.update({ where: { id: o.id }, data: { subtotal: 50, total: 50, remainingBalance: 50 } })
      },
      () => redeemPointsToOrder(venueId, o.id, customerId, 10_000, staffId),
    )
    expect(writer.error).toBeUndefined()
    // 10 000 × 0.01 = 100, but the fresh base is 50: 50 given, 5 000 burned (from the stale photo: 100 and 10 000).
    expect(writer.value).toMatchObject({ pointsRedeemed: 5000, discountAmount: 50 })
    const after = await state(o)
    expect(before.points - after.points).toBe(5000)
    expect(after.order).toMatchObject({ discount: 50, total: 0, discounts: [{ amount: 50 }] })
  })

  it('redeemStamp FREE_PRODUCT gives the most expensive line read after waiting', async () => {
    const o = await newOrder()
    const reward = await newReward({ rewardType: 'FREE_PRODUCT', rewardValue: null })
    const writer = await whileFiscalHolds(
      o.id,
      async tx => {
        await tx.orderItem.create({
          data: { orderId: o.id, productId: productA, productName: 'Especial', quantity: 1, unitPrice: 120, taxAmount: 0, total: 120 },
        })
        await tx.order.update({ where: { id: o.id }, data: { subtotal: 270, total: 270, remainingBalance: 270 } })
      },
      () => redeemStampReward(venueId, o.id, reward.id, { staffId }),
    )
    expect(writer.error).toBeUndefined()
    expect(writer.value.discountAmount).toBe(120)
    expect(await snapshot(o.id)).toMatchObject({ subtotal: 270, discount: 120, total: 150 })
  })

  it('two rewards on the same check serialize: the second one only takes what is left of the base', async () => {
    const o = await newOrder()
    const [r1, r2] = [await newReward({ rewardValue: 100 }), await newReward({ rewardValue: 100 })]
    const fiscal = holdFiscal(o.id)
    let jobs: Array<ReturnType<typeof resultOf>> = []
    try {
      await fiscal.entered
      jobs = [
        resultOf(redeemStampReward(venueId, o.id, r1.id, { staffId })),
        resultOf(redeemStampReward(venueId, o.id, r2.id, { staffId })),
      ]
      await waitingOn('%"Order"%', 2)
    } finally {
      fiscal.release()
      await fiscal.done
      await Promise.all(jobs)
    }
    const outcomes = await Promise.all(jobs)
    expect(outcomes.map(r => r.error)).toEqual([undefined, undefined])
    expect(outcomes.map(r => r.value.discountAmount).sort((a, b) => a - b)).toEqual([50, 100])
    expect(await snapshot(o.id)).toMatchObject({ subtotal: 150, discount: 150, total: 0 })
  })

  it('the same reward on two checks burns once: the second waits on the reward row and finds it redeemed', async () => {
    const reward = await newReward()
    const first = await newOrder(),
      second = await newOrder()
    const beforeSecond = await snapshot(second.id)
    const burned = barrier(),
      resume = barrier()
    let paused = false
    interceptTransactions({
      create: {
        model: 'orderDiscount',
        run: async (_args, _tx, next) => {
          if (!paused) {
            paused = true
            burned.release()
            await resume.promise
          }
          return next()
        },
      },
    })
    const one = resultOf(redeemStampReward(venueId, first.id, reward.id, { staffId }))
    let two: ReturnType<typeof resultOf> | undefined
    try {
      await Promise.race([
        burned.promise,
        one.then(() => {
          throw new Error('first redemption never burned the reward')
        }),
      ])
      two = resultOf(redeemStampReward(venueId, second.id, reward.id, { staffId }))
      await waitingOn('%"StampReward"%')
    } finally {
      resume.release()
      await one
      await two
    }
    expect((await one).error).toBeUndefined()
    expect((await two!).error?.message).toBe('Este premio ya fue canjeado.')
    const firstAfter = await snapshot(first.id)
    const redeemed = await prisma.stampReward.findUniqueOrThrow({ where: { id: reward.id } })
    expect(redeemed).toMatchObject({ status: 'REDEEMED', orderDiscountId: firstAfter.discounts[0].id })
    expect(await snapshot(second.id)).toEqual(beforeSecond)
  })

  it('removing a stamp-reward discount returns the reward and the money in one operation', async () => {
    const o = await newOrder('stampDiscount')
    await removeOrderDiscount(venueId, o.id, o.orderDiscountId, staffId)
    const after = await state(o)
    expect(after.rewards).toEqual([{ status: 'PENDING', orderDiscountId: null }])
    expect(after.order).toMatchObject({ discount: 0, total: 150, discounts: [] })
  })
})

describe('createOrderWithItems writes promotions and reaffirmed money in its creation transaction', () => {
  const sale = (externalId: string, promotion = promotionId, chosen = selections) => ({
    staffId,
    externalId,
    items: [
      { productId: productA, quantity: 1 },
      { promotionRef: { promotionId: promotion, promotionInstanceId: randomUUID(), selections: chosen } },
    ],
    discount: 2000,
    tip: 500,
  })

  it('a promotion failure leaves no order, line or promotion behind and the externalId free for the retry', async () => {
    const externalId = `t4-${randomUUID()}`
    const before = {
      orders: await prisma.order.count({ where: { venueId } }),
      items: await prisma.orderItem.count({ where: { order: { venueId } } }),
      promotions: await prisma.orderPromotion.count({ where: { order: { venueId } } }),
    }
    await expect(createOrderWithItems(venueId, sale(externalId, draftPromotionId, draftSelections) as any)).rejects.toThrow(
      'Esa promoción no está publicada.',
    )
    expect({
      orders: await prisma.order.count({ where: { venueId } }),
      items: await prisma.orderItem.count({ where: { order: { venueId } } }),
      promotions: await prisma.orderPromotion.count({ where: { order: { venueId } } }),
    }).toEqual(before)
    expect(await prisma.order.findUnique({ where: { venueId_externalId: { venueId, externalId } } })).toBeNull()

    const retry = await createOrderWithItems(venueId, sale(externalId) as any)
    // 100 + combo 90 − order discount 20 + tip 5 — the same arithmetic as the pre-existing reaffirmation.
    expect(retry).toMatchObject({ total: 175, discountAmount: 20, subtotal: 190 })
    expect(retry.promotions).toHaveLength(1)
    expect(await prisma.order.count({ where: { venueId, externalId } })).toBe(1)
  })

  it('no concurrent reader sees the new order without its combo: plain read, fiscal admission and a retry', async () => {
    const externalId = `t4-${randomUUID()}`
    const input = sale(externalId)
    const reached = barrier(),
      resume = barrier()
    let pendingOrderId: string | undefined
    interceptTransactions({
      create: {
        model: 'orderPromotion',
        run: async (args, _tx, next) => {
          if (!pendingOrderId) {
            pendingOrderId = args.data.orderId
            reached.release()
            await resume.promise
          }
          return next()
        },
      },
    })
    const creating = resultOf(createOrderWithItems(venueId, input as any))
    let retry: ReturnType<typeof resultOf> | undefined
    try {
      await Promise.race([
        reached.promise,
        creating.then(() => {
          throw new Error('the creation never reached its promotion')
        }),
      ])
      expect(await prisma.order.findUnique({ where: { venueId_externalId: { venueId, externalId } } })).toBeNull()
      expect(await prisma.$transaction(tx => bloquearOrdenParaFacturar(tx, pendingOrderId!))).toBeNull()
      retry = resultOf(createOrderWithItems(venueId, input as any))
      await waitingOn()
    } finally {
      resume.release()
      await creating
      await retry
    }
    const [one, two] = [await creating, await retry!]
    expect(one.error).toBeUndefined()
    expect(two.error).toBeUndefined()
    expect(two.value.id).toBe(one.value.id)
    expect(two.value).toMatchObject({ total: 175, discountAmount: 20 })
    expect(two.value.promotions).toHaveLength(1)
    expect(await prisma.order.count({ where: { venueId, externalId } })).toBe(1)
  })

  it('a stamp reward is still redeemed on the committed sale through the locked service', async () => {
    const reward = await newReward()
    const result = await createOrderWithItems(venueId, {
      staffId,
      customerId,
      stampRewardId: reward.id,
      items: [
        { productId: productA, quantity: 1 },
        { productId: productB, quantity: 1 },
      ],
    } as any)
    expect(result.stampReward).toEqual({ applied: true, discountAmount: 30, rewardLabel: 'Premio' })
    expect(result).toMatchObject({ subtotal: 150, discountAmount: 30, total: 120 })
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: reward.id } })).toMatchObject({ status: 'REDEEMED' })
  })
})

describe('the sync reducer classifies the locked writers as before', () => {
  beforeEach(() => {
    jest.spyOn(featureAccess, 'hasFeatureAccess').mockResolvedValue({ hasAccess: true } as any)
    jest.spyOn(tableOwnership, 'isTableOwnershipEnforced').mockResolvedValue(false)
  })
  const replay = (intent: { id: string; type: any; payload: Record<string, unknown> }) =>
    processIntents({ venueId, staffId, deviceId: 't4-device', intents: [intent], authorizeIntent: () => true })
  const persisted = (id: string) => prisma.posSyncIntent.findUnique({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: id } } })

  it.each([
    [
      'ADD_ITEMS promotion',
      (o: Fixture) => ({
        type: 'ADD_ITEMS',
        payload: { orderId: o.id, items: [{ promotionRef: { promotionId, promotionInstanceId: randomUUID(), selections } }] },
      }),
      'A una cuenta ya pagada no se le pueden agregar promociones.',
    ],
    [
      'APPLY_DISCOUNT',
      (o: Fixture) => ({ type: 'APPLY_DISCOUNT', payload: { orderId: o.id, discountId } }),
      'No se puede descontar una orden ya pagada',
    ],
    [
      'SPLIT_ORDER',
      (o: Fixture) => ({ type: 'SPLIT_ORDER', payload: { orderId: o.id, itemRefs: [o.items[1]] } }),
      'No se puede separar una cuenta ya pagada',
    ],
  ] as const)('%s that finds the order PAID under the lock is REJECTED (quarantine), never RETRY', async (_label, build, message) => {
    const o = await newOrder()
    const id = randomUUID()
    const outcome = await whileFiscalHolds(
      o.id,
      tx => tx.order.update({ where: { id: o.id }, data: { paymentStatus: 'PAID', paidAmount: 150, remainingBalance: 0 } }),
      () => replay({ id, ...build(o) }),
    )
    expect(outcome.error).toBeUndefined()
    expect(outcome.value).toEqual([expect.objectContaining({ id, status: 'REJECTED', errorCode: 'BUSINESS_RULE', message })])
    expect(await persisted(id)).toMatchObject({ status: 'REJECTED' })
    expect(await snapshot(o.id)).toMatchObject({ discounts: [], promotions: [], items: [{}, {}] })
  })

  it('a lock wait that outlives the writer transaction is RETRY: not persisted and nothing written', async () => {
    const o = await newOrder()
    const before = await state(o)
    const id = randomUUID()
    const fiscal = holdFiscal(o.id)
    let acks: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      acks = resultOf(replay({ id, type: 'APPLY_DISCOUNT', payload: { orderId: o.id, discountId } }))
      await waitingOn()
      // Longer than the writer's interactive-transaction timeout (Prisma's default 5 s): a transient condition.
      await pause(6_000)
    } finally {
      fiscal.release()
      await fiscal.done
      await acks
    }
    const outcome = await acks!
    expect(outcome.error).toBeUndefined()
    expect(outcome.value).toEqual([expect.objectContaining({ id, status: 'RETRY' })])
    expect(await persisted(id)).toBeNull()
    expect(await state(o)).toEqual(before)
  }, 30_000)
})
