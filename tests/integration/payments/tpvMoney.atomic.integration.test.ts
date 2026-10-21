/** Plan3b T2: real Order locks, fresh reads without version bumps and rollback after a successful child write. */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as orderLock from '@/services/shared/paymentShiftClaim'
import { bloquearOrdenParaFacturar } from '@/services/fiscal/admisionIva'
import {
  addItemsToOrder,
  removeOrderItem,
  compItems,
  voidItems,
  applyDiscount,
  addSerializedItemToOrder,
  sellSerializedItem,
} from '@/services/tpv/order.tpv.service'
import { serializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'
import { moduleService } from '@/services/modules/module.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/referrals/referralRefund.service', () => ({ onOrderCancelled: jest.fn() }))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(database.pathname)
) {
  throw new Error('This suite requires an explicitly selected isolated local test database.')
}
const venueId = `tpv-money-${randomUUID()}`
let chargeId: string
let staffId: string
let categoryId: string
let productId: string
let modifierId: string
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
  ['add', (o: Fixture) => addItemsToOrder(venueId, o.id, [{ customName: 'Nueva', customUnitPriceCents: 2000, quantity: 1 }], o.version)],
  ['remove', (o: Fixture) => removeOrderItem(venueId, o.id, o.items[0].id, o.version)],
  ['comp', (o: Fixture) => compItems(venueId, o.id, { itemIds: [], reason: 'Error', staffId })],
  ['void', (o: Fixture) => voidItems(venueId, o.id, { itemIds: [o.items[0].id], reason: 'Error', staffId, expectedVersion: o.version })],
  ['discount', (o: Fixture) => applyDiscount(venueId, o.id, { type: 'PERCENTAGE', value: 10, staffId, expectedVersion: o.version })],
  ['serial', (o: Fixture) => addSerializedItemToOrder(venueId, o.id, { serialNumber: o.id, categoryId, price: 20 }, o.version, staffId)],
] as const

beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'TPV', lastName: 'Atomic' } })).id
  categoryId = (await prisma.itemCategory.create({ data: { venueId, name: 'SIM' } })).id
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Catalog', slug: 'catalog' } })
  productId = (
    await prisma.product.create({ data: { venueId, categoryId: category.id, name: 'Catalog product', sku: 'TPV-ATOMIC', price: 20 } })
  ).id
  const group = await prisma.modifierGroup.create({ data: { venueId, name: 'Extras' } })
  modifierId = (await prisma.modifier.create({ data: { groupId: group.id, name: 'Extra', price: 5 } })).id
  chargeId = (
    await prisma.serviceCharge.create({ data: { venueId, name: 'Servicio', type: 'PERCENTAGE', value: 10, autoApplyMinCovers: 8 } })
  ).id
})
beforeEach(() => jest.spyOn(moduleService, 'isModuleEnabled').mockResolvedValue(true))
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  await prisma.orderServiceCharge.deleteMany({ where: { order: { venueId } } })
  await prisma.serializedItem.deleteMany({ where: { OR: [{ venueId }, { organizationId: venueId }] } })
  await prisma.orderAction.deleteMany({ where: { order: { venueId } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.serviceCharge.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.modifierGroup.deleteMany({ where: { venueId } })
  await prisma.itemCategory.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

/** Inject only at Order totals, after observing the child mutation through the SAME connection. */
function failTotals(orderId: string, before: Awaited<ReturnType<typeof snapshot>>) {
  const original = prisma.$transaction.bind(prisma)
  let successfulWriteObserved = false
  let soldObserved = false
  const fail = async (db: Prisma.TransactionClient) => {
    const after = await snapshot(orderId, db)
    successfulWriteObserved =
      JSON.stringify(after.items) !== JSON.stringify(before.items) || JSON.stringify(after.charges) !== JSON.stringify(before.charges)
    soldObserved =
      (await db.serializedItem.count({
        where: { venueId, serialNumber: orderId.toUpperCase(), status: 'SOLD', orderItemId: { not: null } },
      })) === 1
    throw new Error('injected total failure after child write')
  }
  const updateMany = prisma.order.updateMany.bind(prisma.order)
  jest
    .spyOn(prisma.order, 'updateMany')
    .mockImplementation((args: any) => (args.data.total !== undefined ? (fail(prisma) as any) : updateMany(args)))
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
                          return method === 'update' || method === 'updateMany'
                            ? (args: any) => (args.data.total !== undefined ? fail(tx) : (model[method] as any)(args))
                            : Reflect.get(model, method)
                        },
                      })
                    : Reflect.get(target, key)
                },
              }),
            ),
          options,
        )) as any)
  return (expectSold = false) => {
    expect(successfulWriteObserved).toBe(true)
    if (expectSold) expect(soldObserved).toBe(true)
  }
}

describe('new atomic TPV money behavior', () => {
  it.each(writers)('%s rolls back after an actual child write and total failure', async (name, run) => {
    const o = await newOrder()
    await addCharge(o.id)
    const before = await snapshot(o.id)
    const observed = failTotals(o.id, before)
    await expect(run(o)).rejects.toThrow('injected total failure after child write')
    observed(name === 'serial')
    expect(await snapshot(o.id)).toEqual(before)
    expect(await prisma.serializedItem.count({ where: { venueId, serialNumber: o.id.toUpperCase() } })).toBe(0)
  })
  it.each(writers)('%s waits for fiscal admission and rereads PAID without a version bump', async (_name, run) => {
    const o = await newOrder()
    const before = await snapshot(o.id)
    const fiscal = holdFiscal(o.id, tx => tx.order.update({ where: { id: o.id }, data: { paymentStatus: 'PAID', paidAmount: 100 } }))
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(run(o))
      await waitingOnOrder()
      expect((await snapshot(o.id)).items).toEqual(before.items)
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    expect((await writer!).error?.message).toContain('paid order')
    expect((await snapshot(o.id)).items).toEqual(before.items)
    expect((await snapshot(o.id)).version).toBe(before.version)
  })
  it.each(writers)('%s holds Order until the fiscal reader sees the complete operation', async (_name, run) => {
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
    const writer = resultOf(run(o))
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
    expect((await writer).error).toBeUndefined()
    expect(await reservation!).toEqual(await snapshot(o.id))
    expect((await snapshot(o.id)).version).toBe(o.version + 1)
  })
  it.each(['comp', 'discount', 'void', 'remove'] as const)('%s rereads changed lines and discount while waiting', async name => {
    const o = await newOrder()
    const fiscal = holdFiscal(o.id, async tx => {
      await tx.orderItem.update({ where: { id: o.items[0].id }, data: { total: 140 } })
      await tx.orderItem.create({ data: { orderId: o.id, productName: 'Otra', quantity: 1, unitPrice: 60, taxAmount: 0, total: 60 } })
      await tx.order.update({ where: { id: o.id }, data: { subtotal: 200, total: 180, discountAmount: 20, paidAmount: 7 } })
    })
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(writers.find(([label]) => label === name)![1](o))
      await waitingOnOrder()
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    expect((await writer!).error).toBeUndefined()
    const after = await snapshot(o.id)
    expect(after).toMatchObject(
      name === 'comp'
        ? // B2c T4b (ronda 1): la cabecera es Σ filas SIN tope — los $20 releídos (su fila «Descuento anterior») + la cortesía de
          // los $200 releídos —; el total lo topa en 0 `computeStoredOrderTotal`. (Antes, cabecera topada al subtotal: 200.)
          { total: 0, discount: 220, remaining: 0 }
        : name === 'discount'
          ? { total: 160, discount: 40, remaining: 153 }
          : { subtotal: 60, total: 40, remaining: 33, status: o.status },
    )
  })
  it('two same-version rounds leave one committed line set and a retryable loser', async () => {
    const o = await newOrder()
    const run = () => addItemsToOrder(venueId, o.id, [{ customName: 'Ronda', customUnitPriceCents: 1000, quantity: 1 }], o.version, true)
    const outcomes = await Promise.all([resultOf(run()), resultOf(run())])
    expect(outcomes.filter(r => !r.error)).toHaveLength(1)
    expect(outcomes.find(r => r.error)?.error.code).toBe('VERSION_CONFLICT')
    expect(await prisma.orderItem.count({ where: { orderId: o.id } })).toBe(2)
    expect((await snapshot(o.id)).total).toBe(110)
  })
  it('quick sell registration rolls back if the new Order fails, without marking SOLD', async () => {
    const serialNumber = randomUUID().toUpperCase()
    const original = prisma.$transaction.bind(prisma)
    let registrationObserved = false
    jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options: any) =>
      original(
        async tx =>
          callback(
            new Proxy(tx, {
              get(target, key) {
                return key === 'order'
                  ? new Proxy(target.order, {
                      get(model, method) {
                        return method === 'create'
                          ? async () => {
                              registrationObserved = (await tx.serializedItem.count({ where: { venueId, serialNumber } })) === 1
                              throw new Error('new order failure')
                            }
                          : Reflect.get(model, method)
                      },
                    })
                  : Reflect.get(target, key)
              },
            }),
          ),
        options,
      )) as any)
    const sold = jest.spyOn(serializedInventoryService, 'markAsSold')
    await expect(sellSerializedItem(venueId, { serialNumber, categoryId, price: 20 }, staffId)).rejects.toThrow('new order failure')
    expect(registrationObserved).toBe(true)
    expect(await prisma.serializedItem.count({ where: { venueId, serialNumber } })).toBe(0)
    expect(sold).not.toHaveBeenCalled()
  })
})

describe('TPV regression: transaction boundaries and serialized custody', () => {
  it('a second item failure rolls back the first successful insert', async () => {
    const o = await newOrder()
    const before = await snapshot(o.id)
    const original = prisma.$transaction.bind(prisma)
    let created = false,
      count = 0
    jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options: any) =>
      original(
        async tx =>
          callback(
            new Proxy(tx, {
              get(target, key) {
                return key === 'orderItem'
                  ? new Proxy(target.orderItem, {
                      get(model, method) {
                        return method === 'create'
                          ? async (args: any) => {
                              if (++count === 2) {
                                created = (await tx.orderItem.count({ where: { orderId: o.id } })) === 2
                                throw new Error('second item failure')
                              }
                              return model.create(args)
                            }
                          : Reflect.get(model, method)
                      },
                    })
                  : Reflect.get(target, key)
              },
            }),
          ),
        options,
      )) as any)
    await expect(
      addItemsToOrder(
        venueId,
        o.id,
        [
          { customName: 'A', customUnitPriceCents: 1000, quantity: 1 },
          { customName: 'B', customUnitPriceCents: 2000, quantity: 1 },
        ],
        o.version,
      ),
    ).rejects.toThrow('second item failure')
    expect(created).toBe(true)
    expect(await snapshot(o.id)).toEqual(before)
  })
  it('org inventory custody denial rolls back the line; accepted custody sells in the same transaction', async () => {
    const o = await newOrder()
    const before = await snapshot(o.id)
    const serialNumber = randomUUID().toUpperCase()
    await prisma.organization.update({ where: { id: venueId }, data: { simCustodyEnforcementMode: 'ENFORCE' } })
    const serial = await prisma.serializedItem.create({
      data: { organizationId: venueId, categoryId, serialNumber, createdBy: staffId, custodyState: 'ADMIN_HELD' },
    })
    try {
      await expect(addSerializedItemToOrder(venueId, o.id, { serialNumber, price: 20 }, o.version, staffId)).rejects.toMatchObject({
        code: 'SIM_NOT_ACCEPTED',
      })
      expect(await snapshot(o.id)).toEqual(before)
      expect((await prisma.serializedItem.findUniqueOrThrow({ where: { id: serial.id } })).status).toBe('AVAILABLE')
      await prisma.serializedItem.update({ where: { id: serial.id }, data: { custodyState: 'PROMOTER_HELD', assignedPromoterId: staffId } })
      await addSerializedItemToOrder(venueId, o.id, { serialNumber, price: 20 }, o.version, staffId)
      expect(await prisma.serializedItem.findUniqueOrThrow({ where: { id: serial.id } })).toMatchObject({
        status: 'SOLD',
        custodyState: 'SOLD',
        sellingVenueId: venueId,
        orderItemId: expect.any(String),
      })
      expect((await snapshot(o.id)).total).toBe(120)
    } finally {
      await prisma.organization.update({ where: { id: venueId }, data: { simCustodyEnforcementMode: 'OFF' } })
    }
  })
  it('a serial sold while waiting on Order is rejected from its fresh status', async () => {
    const o = await newOrder()
    const serialNumber = randomUUID().toUpperCase()
    const serial = await prisma.serializedItem.create({ data: { venueId, categoryId, serialNumber, createdBy: staffId } })
    const fiscal = holdFiscal(o.id, tx => tx.serializedItem.update({ where: { id: serial.id }, data: { status: 'SOLD' } }))
    let writer: ReturnType<typeof resultOf> | undefined
    try {
      await fiscal.entered
      writer = resultOf(addSerializedItemToOrder(venueId, o.id, { serialNumber, price: 20 }, o.version, staffId))
      await waitingOnOrder()
    } finally {
      fiscal.release()
      await fiscal.done
      await writer
    }
    expect((await writer!).error?.message).toContain('ya fue vendido')
    expect((await snapshot(o.id)).items).toHaveLength(1)
  })
})

describe('serialized Venue FK lock order', () => {
  it('waits for the deletion Venue fence before taking Order', async () => {
    const o = await newOrder()
    const entered = barrier(),
      finish = barrier()
    const lock = jest.spyOn(orderLock, 'lockExistingOrderForPayment')
    const deleting = prisma.$transaction(
      async tx => {
        // Same ordering as deleteVenue: Venue FOR UPDATE -> Order children/Order.
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
      writer = resultOf(writers[5][1](o))
      let waiting = false
      for (let i = 0; i < 100; i++) {
        const [{ count }] = await prisma.$queryRaw<
          Array<{ count: number }>
        >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND (query ILIKE '%"Venue"%' OR query ILIKE '%"SerializedItem"%')`
        if (count > 0) {
          waiting = true
          break
        }
        await pause(20)
      }
      expect(waiting).toBe(true)
      expect(lock.mock.calls.length).toBe(0)
      expect((await snapshot(o.id)).items).toHaveLength(1)
    } finally {
      finish.release()
      const deletion = await resultOf(deleting)
      await writer
      expect(deletion.error).toBeUndefined()
    }
    expect((await writer!).error).toBeUndefined()
  })
  it('compatible Venue KEY SHARE allows different Orders at the same venue to progress', async () => {
    const a = await newOrder(),
      b = await newOrder()
    const entered = barrier(),
      finish = barrier()
    const original = orderLock.lockExistingOrderForPayment
    jest.spyOn(orderLock, 'lockExistingOrderForPayment').mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      entered.release()
      await finish.promise
      return result
    })
    const first = resultOf(writers[5][1](a))
    let second: ReturnType<typeof resultOf> | undefined
    try {
      await entered.promise
      second = resultOf(writers[5][1](b))
      expect(
        (
          await Promise.race([
            second,
            pause(5_000).then(() => {
              throw new Error('different Order blocked on shared Venue fence')
            }),
          ])
        ).error,
      ).toBeUndefined()
      expect((await snapshot(b.id)).total).toBe(120)
      expect((await snapshot(a.id)).total).toBe(100)
    } finally {
      finish.release()
      await first
      await second
    }
    expect((await first).error).toBeUndefined()
  })
})

describe('round replay and modifier rollback', () => {
  it('replaying an externalId keeps one line and a rejected version adds no orphan round', async () => {
    const o = await newOrder()
    const input = [{ productId, quantity: 1, modifierIds: [modifierId], externalId: randomUUID() }]
    const first = await addItemsToOrder(venueId, o.id, input, o.version, true)
    await expect(addItemsToOrder(venueId, o.id, input, o.version, true)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    const replay = await addItemsToOrder(venueId, o.id, input, first.version, true)
    expect(Number(replay.total)).toBe(125)
    expect(await prisma.orderItem.count({ where: { orderId: o.id } })).toBe(2)
    expect(await prisma.orderItemModifier.count({ where: { orderItem: { orderId: o.id } } })).toBe(1)
    await addItemsToOrder(venueId, o.id, [{ productId, quantity: 1, course: 'Principal', seat: 2 }], replay.version, true)
    const round = await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.id, productId, externalId: null } })
    expect(round.sentToKitchenAt).toBeInstanceOf(Date)
    expect(round.course).toBe('Principal')
    expect(round.seat).toBe(2)
    expect((await snapshot(o.id)).total).toBe(145)
  })
  it('a nested modifier inserted successfully disappears when totals fail', async () => {
    const o = await newOrder()
    const before = await snapshot(o.id)
    const original = prisma.$transaction.bind(prisma)
    let modifierObserved = false
    jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options: any) =>
      original(
        async tx =>
          callback(
            new Proxy(tx, {
              get(target, key) {
                return key === 'order'
                  ? new Proxy(target.order, {
                      get(model, method) {
                        return method === 'updateMany'
                          ? async () => {
                              modifierObserved = (await tx.orderItemModifier.count({ where: { orderItem: { orderId: o.id } } })) === 1
                              throw new Error('total failure after modifier')
                            }
                          : Reflect.get(model, method)
                      },
                    })
                  : Reflect.get(target, key)
              },
            }),
          ),
        options,
      )) as any)
    await expect(addItemsToOrder(venueId, o.id, [{ productId, quantity: 1, modifierIds: [modifierId] }], o.version)).rejects.toThrow(
      'total failure after modifier',
    )
    expect(modifierObserved).toBe(true)
    expect(await prisma.orderItemModifier.count({ where: { orderItem: { orderId: o.id } } })).toBe(0)
    expect(await snapshot(o.id)).toEqual(before)
  })
})

/**
 * P12 (B2b Tarea 6) en los dos escritores de la terminal que guardan el total SIN pasar por la sincronización de repartos: la
 * cortesía (`computeStoredOrderTotal` con el contrato, el IVA y el estado) y el artículo serializado (`impuestoQueSeCobraAparte`).
 * Sin estas pruebas, quitar el término del IVA en cualquiera de los dos dejaba verde todo el bloque (revisión de la Tarea 6).
 */
describe('P12: la cortesía y el serializado guardan el total con el IVA aparte (B2b)', () => {
  /** Producto $100 con IVA $16 aparte: cabecera IVA_APARTE, total y saldo $116. */
  const conIvaAparte = async () => {
    const o = await newOrder({ contratoDePrecio: 'IVA_APARTE', taxAmount: 16, total: 116, remainingBalance: 116, covers: 1 })
    await prisma.orderItem.update({ where: { id: o.items[0].id }, data: { taxAmount: 16 } })
    return o
  }

  it('🔴 cortesía de un renglón exento: total y saldo $116 = 150 − 50 de cortesía + 16 de IVA (sin el término: $100)', async () => {
    const o = await conIvaAparte()
    const agua = await prisma.orderItem.create({
      data: { orderId: o.id, productName: 'Agua', quantity: 1, unitPrice: 50, taxAmount: 0, total: 50 },
    })
    await prisma.order.update({ where: { id: o.id }, data: { subtotal: 150, total: 166, remainingBalance: 166 } })
    await compItems(venueId, o.id, { itemIds: [agua.id], reason: 'Invitación', staffId })
    expect(await snapshot(o.id)).toMatchObject({ subtotal: 150, discount: 50, total: 116, remaining: 116 })
  })

  it('🔴 artículo serializado de $20: total y saldo $136 = 120 + 16 de IVA (sin el término: $120)', async () => {
    const o = await conIvaAparte()
    await addSerializedItemToOrder(venueId, o.id, { serialNumber: o.id, categoryId, price: 20 }, o.version, staffId)
    expect(await snapshot(o.id)).toMatchObject({ subtotal: 120, total: 136, remaining: 136 })
  })
})
