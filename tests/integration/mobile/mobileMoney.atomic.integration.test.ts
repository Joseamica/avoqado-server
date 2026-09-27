/** Plan3b T1: real Order locks, fresh reads without version bumps and rollback after a successful child write. */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as orderLock from '@/services/shared/paymentShiftClaim'
import { bloquearOrdenParaFacturar } from '@/services/fiscal/admisionIva'
import { compOrderItem, compWholeOrder } from '@/services/mobile/comp-item.mobile.service'
import { applyServiceCharge, removeServiceCharge, syncAutomaticServiceCharges } from '@/services/mobile/service-charge.mobile.service'
import { updateOrderDetails, mergeOrders } from '@/services/mobile/order.mobile.service'
import { logAction } from '@/services/dashboard/activity-log.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/referrals/referralRefund.service', () => ({ onOrderCancelled: jest.fn() }))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(database.pathname)
) {
  throw new Error('This suite requires an explicitly selected isolated local test database.')
}
const venueId = `mobile-money-${randomUUID()}`
let chargeId: string
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}
const resultOf = <T>(promise: Promise<T>) =>
  promise.then(
    value => ({ value, error: undefined }),
    error => ({ value: undefined, error }),
  )
async function waitingOnOrder() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event_type = 'Lock' AND query ILIKE '%"Order"%'`
    if (count > 0) return
    await pause(20)
  }
  throw new Error('No connection waited on Order')
}
async function newOrder(extra: Record<string, unknown> = {}) {
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      remainingBalance: 100,
      covers: 8,
      ...extra,
      items: { create: { productName: 'Producto', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 } },
    },
    include: { items: true },
  })
}
async function addCharge(orderId: string) {
  return prisma.orderServiceCharge.create({
    data: { orderId, serviceChargeId: chargeId, name: 'Servicio', type: 'PERCENTAGE', value: 10, amount: 10, isAutomatic: true },
  })
}
async function snapshot(orderId: string, db: Prisma.TransactionClient = prisma) {
  const o = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { orderBy: { id: 'asc' } }, serviceCharges: { orderBy: { id: 'asc' } } },
  })
  return {
    total: Number(o.total),
    subtotal: Number(o.subtotal),
    discount: Number(o.discountAmount),
    paid: Number(o.paidAmount),
    remaining: Number(o.remainingBalance),
    version: o.version,
    covers: o.covers,
    status: o.status,
    paymentStatus: o.paymentStatus,
    items: o.items.map(i => ({ id: i.id, total: Number(i.total), discount: Number(i.discountAmount), comp: i.isCortesia })),
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
    { timeout: 15_000 },
  )
  return { entered: entered.promise, release: finish.release, done }
}
type Fixture = Awaited<ReturnType<typeof newOrder>>
const writers = [
  ['comp', (o: Fixture, _row: string) => compOrderItem({ venueId, orderId: o.id, itemId: o.items[0].id, reason: 'Error' })],
  ['whole', (o: Fixture, _row: string) => compWholeOrder({ venueId, orderId: o.id, reason: 'Error' })],
  ['apply', (o: Fixture, _row: string) => applyServiceCharge(venueId, o.id, chargeId)],
  ['remove', (o: Fixture, row: string) => removeServiceCharge(venueId, o.id, row)],
  ['auto', (o: Fixture, _row: string) => syncAutomaticServiceCharges(venueId, o.id)],
] as const

beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
  chargeId = (
    await prisma.serviceCharge.create({ data: { venueId, name: 'Servicio', type: 'PERCENTAGE', value: 10, autoApplyMinCovers: 8 } })
  ).id
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  await prisma.orderServiceCharge.deleteMany({ where: { order: { venueId } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.serviceCharge.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

/** Inject only at Order totals, after observing the child mutation through the SAME connection. */
function failTotals(orderId: string, before: Awaited<ReturnType<typeof snapshot>>) {
  const original = prisma.$transaction.bind(prisma)
  let successfulWriteObserved = false
  const fail = async (db: Prisma.TransactionClient) => {
    const after = await snapshot(orderId, db)
    successfulWriteObserved =
      JSON.stringify(after.items) !== JSON.stringify(before.items) || JSON.stringify(after.charges) !== JSON.stringify(before.charges)
    throw new Error('injected total failure after child write')
  }
  const update = prisma.order.update.bind(prisma.order)
  jest
    .spyOn(prisma.order, 'update')
    .mockImplementation((args: any) => (args.data.total !== undefined ? (fail(prisma) as any) : update(args)))
  jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options: any) =>
    Array.isArray(callback)
      ? original(callback)
      : original(
          async tx =>
            callback(
              new Proxy(tx, {
                get(target, key) {
                  return key === 'order'
                    ? new Proxy(target.order, {
                        get(model, method) {
                          return method === 'update'
                            ? (args: any) => (args.data.total !== undefined ? fail(tx) : model.update(args))
                            : Reflect.get(model, method)
                        },
                      })
                    : Reflect.get(target, key)
                },
              }),
            ),
          options,
        )) as any)
  return () => expect(successfulWriteObserved).toBe(true)
}

describe('new atomic mobile money behavior', () => {
  it.each(writers)('%s rolls back a successful child mutation when totals fail', async (name, run) => {
    const o = await newOrder()
    const row = name === 'remove' ? (await addCharge(o.id)).id : ''
    const before = await snapshot(o.id)
    const observed = failTotals(o.id, before)
    await expect(run(o, row)).rejects.toThrow('injected total failure after child write')
    observed()
    expect(await snapshot(o.id)).toEqual(before)
  })
  it.each(writers)('%s waits for fiscal Order lock, then rereads PAID without a version bump', async (name, run) => {
    const o = await newOrder()
    const row = name === 'remove' ? (await addCharge(o.id)).id : ''
    const before = await snapshot(o.id)
    const fiscal = holdFiscal(o.id, tx =>
      tx.order.update({ where: { id: o.id }, data: { paymentStatus: 'PAID', paidAmount: 100, remainingBalance: 0 } }),
    )
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(run(o, row))
      await waitingOnOrder()
      // Before releasing the fiscal lock, no child write may already be visible.
      expect((await snapshot(o.id)).items).toEqual(before.items)
      expect((await snapshot(o.id)).charges).toEqual(before.charges)
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    const outcome = await writer!
    if (name === 'auto') expect(outcome.value).toBeNull()
    else expect(outcome.error?.message).toContain('pagada')
    const after = await snapshot(o.id)
    expect(after.items).toEqual(before.items)
    expect(after.charges).toEqual(before.charges)
    expect(after.version).toBe(before.version)
  })
  it('comp rereads item amount and inherited discount after waiting', async () => {
    const o = await newOrder()
    const fiscal = holdFiscal(o.id, async tx => {
      await tx.orderItem.update({ where: { id: o.items[0].id }, data: { total: 140 } })
      await tx.order.update({ where: { id: o.id }, data: { subtotal: 140, total: 120, discountAmount: 20, paidAmount: 7 } })
    })
    let writer: Promise<unknown> | undefined
    try {
      await fiscal.entered
      writer = compOrderItem({ venueId, orderId: o.id, itemId: o.items[0].id, reason: 'Error' })
      await waitingOnOrder()
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    await writer
    expect(await snapshot(o.id)).toMatchObject({
      total: 0,
      discount: 20,
      paid: 7,
      remaining: 0,
      items: [{ id: o.items[0].id, total: 0, discount: 140, comp: true }],
    })
  })
  it('auto rereads covers, current lines and paidAmount while keeping fallback zero', async () => {
    const o = await newOrder({ covers: 1 })
    const fiscal = holdFiscal(o.id, async tx => {
      await tx.orderItem.update({ where: { id: o.items[0].id }, data: { total: 140 } })
      await tx.order.update({ where: { id: o.id }, data: { covers: 9, subtotal: 140, discountAmount: 20, paidAmount: 7 } })
    })
    let writer: Promise<unknown> | undefined
    try {
      await fiscal.entered
      writer = syncAutomaticServiceCharges(venueId, o.id)
      await waitingOnOrder()
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    await writer
    expect(await snapshot(o.id)).toMatchObject({
      total: 154,
      discount: 0,
      remaining: 147,
      charges: [{ id: expect.any(String), amount: 14 }],
    })
  })
  it.each([writers[0], writers[2]])('%s holds Order until fiscal admission can see the complete operation', async (name, run) => {
    const o = await newOrder()
    const entered = barrier(),
      finish = barrier()
    const lock = orderLock.lockExistingOrderForPayment
    jest.spyOn(orderLock, 'lockExistingOrderForPayment').mockImplementationOnce(async (...args) => {
      const value = await lock(...args)
      entered.release()
      await finish.promise
      return value
    })
    const writer = resultOf(run(o, ''))
    let reservation: Promise<Awaited<ReturnType<typeof snapshot>>> | undefined
    try {
      await Promise.race([
        entered.promise,
        writer.then(() => {
          throw new Error('writer never acquired Order lock')
        }),
      ])
      reservation = prisma.$transaction(async tx => {
        await bloquearOrdenParaFacturar(tx, o.id)
        return snapshot(o.id, tx)
      })
      await waitingOnOrder()
    } finally {
      finish.release()
      await writer
    }
    const captured = await reservation!
    expect(captured).toMatchObject(
      name === 'comp'
        ? { total: 0, subtotal: 0, items: [{ id: o.items[0].id, total: 0, discount: 100, comp: true }] }
        : { total: 110, charges: [{ id: expect.any(String), amount: 10 }] },
    )
  })
  it('covers and autocharge roll back together after successful creation', async () => {
    const o = await newOrder({ covers: 1 })
    const before = await snapshot(o.id)
    const observed = failTotals(o.id, before)
    await expect(updateOrderDetails(venueId, o.id, { covers: 9 })).rejects.toThrow('injected total failure after child write')
    observed()
    expect(await snapshot(o.id)).toEqual(before)
  })
  it.each(['empty', 'added'] as const)('merge rereads source membership after waiting: %s', async change => {
    const target = await newOrder({ covers: 1 }),
      source = await newOrder({ covers: 1 })
    const originalTarget = await snapshot(target.id)
    const winner = holdFiscal(source.id, async tx => {
      if (change === 'empty') {
        await tx.orderItem.deleteMany({ where: { orderId: source.id } })
        await tx.order.update({ where: { id: source.id }, data: { subtotal: 0, total: 0, remainingBalance: 0 } })
      } else {
        await tx.orderItem.create({
          data: { orderId: source.id, productName: 'Nuevo', quantity: 1, unitPrice: 50, taxAmount: 0, total: 50 },
        })
        await tx.order.update({ where: { id: source.id }, data: { subtotal: 150, total: 150, remainingBalance: 150 } })
      }
    })
    let merging: ReturnType<typeof resultOf<Awaited<ReturnType<typeof mergeOrders>>>> | undefined
    try {
      await winner.entered
      merging = resultOf(mergeOrders(venueId, target.id, source.id))
      await waitingOnOrder()
    } finally {
      winner.release()
      await winner.done
      await merging
    }
    const result = await merging!
    if (change === 'empty') {
      expect(result.error?.message).toBe('La cuenta origen no tiene artículos')
      expect(await snapshot(target.id)).toEqual(originalTarget)
      expect(await snapshot(source.id)).toMatchObject({ status: source.status, version: source.version, items: [] })
      expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'ORDERS_MERGED', entityId: target.id }))
    } else {
      expect(result.error).toBeUndefined()
      expect(result.value).toMatchObject({ merged: { items: 2 }, target: { total: 250 } })
      expect((await snapshot(target.id)).items).toHaveLength(3)
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ORDERS_MERGED', entityId: target.id, data: expect.objectContaining({ items: 2 }) }),
      )
    }
  })
  it('merge and autocharge roll back together when automatic sync fails', async () => {
    const target = await newOrder(),
      source = await newOrder()
    const beforeTarget = await snapshot(target.id),
      beforeSource = await snapshot(source.id)
    const original = prisma.$transaction.bind(prisma)
    jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options: any) =>
      Array.isArray(callback)
        ? original(callback)
        : original(
            async tx =>
              callback(
                new Proxy(tx, {
                  get(object, key) {
                    return key === 'serviceCharge'
                      ? new Proxy(object.serviceCharge, {
                          get(model, method) {
                            return method === 'findMany'
                              ? () => {
                                  throw new Error('auto sync failed')
                                }
                              : Reflect.get(model, method)
                          },
                        })
                      : Reflect.get(object, key)
                  },
                }),
              ),
            options,
          )) as any)
    await expect(mergeOrders(venueId, target.id, source.id)).rejects.toThrow('auto sync failed')
    expect(await snapshot(target.id)).toEqual(beforeTarget)
    expect(await snapshot(source.id)).toEqual(beforeSource)
  })
})

describe('existing mobile contracts', () => {
  it('concurrent manual charge requests keep one row and the duplicate message', async () => {
    const o = await newOrder()
    const results = await Promise.all([
      resultOf(applyServiceCharge(venueId, o.id, chargeId)),
      resultOf(applyServiceCharge(venueId, o.id, chargeId)),
    ])
    expect(results.filter(r => r.error)).toHaveLength(1)
    expect(results.find(r => r.error)?.error.message).toBe('Ese cobro ya está aplicado a la cuenta')
    expect((await snapshot(o.id)).charges).toHaveLength(1)
  })
  it('automatic replay is a no-op and never changes a manual charge', async () => {
    const o = await newOrder()
    await applyServiceCharge(venueId, o.id, chargeId)
    await expect(syncAutomaticServiceCharges(venueId, o.id)).resolves.toBeNull()
    await updateOrderDetails(venueId, o.id, { covers: 1 })
    expect((await snapshot(o.id)).charges).toHaveLength(1)
  })
})
