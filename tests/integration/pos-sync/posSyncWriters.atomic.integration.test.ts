/**
 * Plan3b T6: imported POS events (pos-sync header and lines) serialize with fiscal capture on the real Order row, decide
 * from the row read under that lock, and never change the imported header money (the POS header is the monetary
 * authority, IVA_APARTE). A line that needs a placeholder Product takes the Venue governance fence BEFORE the Order
 * (deleteVenue holds the Venue first, then deletes the venue's OrderItems and Payments before its Orders — T8-R4
 * residual, kept); the existing-product fast path never takes it.
 * Last block: characterization of the upstream-completeness limit (§14), which Plan 3b does NOT resolve.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as orderLock from '@/services/shared/paymentShiftClaim'
import * as catalogGovernance from '@/services/master-catalog/catalogGovernance.service'
import { bloquearOrdenParaFacturar } from '@/services/fiscal/admisionIva'
import { loadOrderForCfdiFromDb } from '@/services/fiscal/cfdi.service'
import { cleanupPaymentCache, processPosOrderDeleteEvent, processPosOrderEvent } from '@/services/pos-sync/posSyncOrder.service'
import { processPosOrderItemEvent } from '@/services/pos-sync/posSyncOrderItem.service'
import type { PosOrderData, RichPosPayload } from '@/types/pos.types'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(database.pathname)
) {
  throw new Error('This suite requires an explicitly selected isolated local test database.')
}

const fixture = `posw-${randomUUID()}`
const organizationId = fixture
const venueId = fixture
// Same organization: an order moved here (the reassignment path) is no longer the POS venue's order.
const otherVenueId = `${fixture}-other`
// Placeholder rollback runs on its own venue, so its «pos-sync» category is provably absent before and after.
const rollbackVenueId = `${fixture}-rollback`
const VENUES = [venueId, otherVenueId, rollbackVenueId]
const INSTANCE = 'SR1'
const PRODUCT_EXT = `${fixture}-cafe`
const CARD = [{ idformadepago: 'TAR', tipo: 2, descripcion: 'TARJETA CREDITO' }]
// A POS waiter and the POS shift it reports: the header event claims that OPEN shift for orphan orders.
const POS_WAITER = { externalId: 'W1', name: 'Mesero POS', pin: null }
const POS_SHIFT = { externalId: `${fixture}-open`, startTime: new Date().toISOString() }
let catalogCategoryId: string, staffId: string, openShiftId: string, historicShiftId: string
let sequence = 0

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function barrier<T = void>() {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    release = resolve
  })
  return { promise, release }
}
type Outcome<T> = { value: T | undefined; error: any }
const resultOf = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    value => ({ value, error: undefined }),
    error => ({ value: undefined, error }),
  )
async function backendPid(tx: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
  return pid
}
/**
 * Some connection is blocked by `pid` — on a row lock, an FK check or the Venue fence alike. Postgres decides, not a wall
 * clock: polls up to 30 s (the gates run on a loaded machine). `until()` ends the poll early with false (nobody waited).
 */
async function blockedBy(pid: number, until: () => boolean = () => false): Promise<boolean> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !until()) {
    const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
    if (count > 0) return true
    await pause(20)
  }
  if (until()) return false
  throw new Error(`No connection waited on backend ${pid}`)
}
/** Fiscal capture holding the Order (and its Products FOR SHARE); `change` runs right before it commits. */
function holdFiscal(orderId: string, change: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  const entered = barrier<number>(),
    finish = barrier()
  const done = prisma.$transaction(
    async tx => {
      await bloquearOrdenParaFacturar(tx, orderId)
      entered.release(await backendPid(tx))
      await finish.promise
      await change(tx)
    },
    { timeout: 20_000 },
  )
  return { entered: entered.promise, release: () => finish.release(), done }
}
/** Runs `run` while fiscal capture holds the Order, proves it waited, and returns its outcome after fiscal commits. */
async function whileFiscalHolds<T>(
  orderId: string,
  change: (tx: Prisma.TransactionClient) => Promise<unknown>,
  run: () => Promise<T>,
  whileWaiting: () => Promise<void> = async () => {},
): Promise<Outcome<T>> {
  const fiscal = holdFiscal(orderId, change)
  let writer: Promise<Outcome<T>> | undefined
  try {
    const pid = await fiscal.entered
    writer = resultOf(run())
    await blockedBy(pid)
    await whileWaiting()
  } finally {
    fiscal.release()
    await fiscal.done
    await writer
  }
  return writer!
}
/** Pauses the next Order lock right after it is acquired; `entered` fails if the writer ends without taking it. */
function pauseAfterOrderLock() {
  const entered = barrier<number>(),
    finish = barrier()
  const lock = orderLock.lockExistingOrderForPayment
  jest.spyOn(orderLock, 'lockExistingOrderForPayment').mockImplementationOnce(async (tx, input) => {
    const value = await lock(tx, input)
    entered.release(await backendPid(tx))
    await finish.promise
    return value
  })
  return {
    entered: (writer: Promise<unknown>) =>
      Promise.race([
        entered.promise,
        writer.then(() => {
          throw new Error('writer never acquired Order lock')
        }),
      ]),
    release: () => finish.release(),
  }
}

const folio = () => `${Date.now().toString(36)}${++sequence}`
function header(externalId: string, money: Partial<PosOrderData> = {}, paid?: number, forVenue = venueId): RichPosPayload {
  return {
    venueId: forVenue,
    orderData: {
      externalId,
      orderNumber: externalId.split(':').pop()!,
      status: paid === undefined ? 'PENDING' : 'COMPLETED',
      paymentStatus: paid === undefined ? 'PENDING' : 'PAID',
      subtotal: 100,
      taxAmount: 16,
      discountAmount: 0,
      tipAmount: 0,
      total: 116,
      createdAt: new Date().toISOString(),
      completedAt: paid === undefined ? null : new Date().toISOString(),
      posRawData: { test: fixture },
      ...money,
    },
    // externalId null ⇒ staff, table and shift sync return null without writing.
    staffData: { externalId: null, name: null, pin: null },
    tableData: { externalId: null },
    shiftData: { externalId: null, startTime: null },
    payments:
      paid === undefined ? [] : [{ amount: paid, tipAmount: 0, methodExternalId: 'TAR', reference: null, posRawData: { test: fixture } }],
    paymentMethodsCatalog: CARD,
  }
}
type ItemEvent = Parameters<typeof processPosOrderItemEvent>[0]
function line(parentExternalId: string, externalId: string, itemData: Partial<ItemEvent['itemData']> = {}, forVenue = venueId): ItemEvent {
  return {
    venueId: forVenue,
    parentOrderExternalId: parentExternalId,
    itemData: {
      externalId,
      deleted: false,
      productExternalId: PRODUCT_EXT,
      productName: 'Café',
      quantity: 1,
      unitPrice: 50,
      taxAmount: 8,
      total: 50,
      ...itemData,
    },
  }
}
/** An order created by the real header event, with `lines` lines created by the real line event. */
async function posOrder(opts: { lines?: number; paid?: number } = {}) {
  const externalId = `${INSTANCE}:1:${folio()}`
  const order = await processPosOrderEvent(header(externalId, {}, opts.paid))
  const lineIds: string[] = []
  for (let i = 0; i < (opts.lines ?? 0); i++) {
    lineIds.push(`${externalId}:L${i}`)
    await processPosOrderItemEvent(line(externalId, lineIds[i]))
  }
  return { id: order.id, externalId, lineIds }
}
/** Header money as stored text (byte-identical comparison) plus the lines. */
async function snapshot(orderId: string, db: Prisma.TransactionClient = prisma) {
  const [order] = await db.$queryRaw<Array<Record<string, string | null>>>`
    SELECT "venueId", "externalId", status::text AS status, "paymentStatus"::text AS "paymentStatus",
           subtotal::text AS subtotal, "taxAmount"::text AS tax, "discountAmount"::text AS discount,
           "tipAmount"::text AS tip, total::text AS total, "contratoDePrecio"::text AS contrato
    FROM "Order" WHERE id = ${orderId}`
  const items = await db.orderItem.findMany({ where: { orderId }, orderBy: { externalId: 'asc' }, take: 50 })
  return {
    ...order,
    items: items.map(i => ({
      externalId: i.externalId,
      productId: i.productId,
      quantity: i.quantity,
      unitPrice: Number(i.unitPrice),
      total: Number(i.total),
      taxAmount: Number(i.taxAmount),
    })),
  }
}
const moveTo = (orderId: string, target: string) => (tx: Prisma.TransactionClient) =>
  tx.$executeRaw`UPDATE "Order" SET "venueId" = ${target} WHERE id = ${orderId}`
const nothing = async () => {}

beforeAll(async () => {
  await prisma.organization.create({ data: { id: organizationId, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' } })
  for (const id of VENUES) await prisma.venue.create({ data: { id, organizationId, name: id, slug: id } })
  catalogCategoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Catálogo', slug: 'catalogo' } })).id
  await prisma.product.create({
    data: { venueId, categoryId: catalogCategoryId, name: 'Café', sku: PRODUCT_EXT, price: 50, externalId: PRODUCT_EXT },
  })
  await prisma.fiscalEmisor.create({
    data: { venueId, rfc: 'AAA010101AAA', legalName: 'Emisor de prueba', regimenFiscal: '601', lugarExpedicion: '06600' },
  })
  staffId = (await prisma.staff.create({ data: { email: `${fixture}@staff.test`, firstName: 'Mesero', lastName: 'POS' } })).id
  await prisma.staffVenue.create({ data: { staffId, venueId, posStaffId: POS_WAITER.externalId, role: 'WAITER' } })
  openShiftId = (await prisma.shift.create({ data: { venueId, staffId, externalId: POS_SHIFT.externalId, startTime: new Date() } })).id
  historicShiftId = (
    await prisma.shift.create({
      data: {
        venueId,
        staffId,
        externalId: `${fixture}-historic`,
        status: 'CLOSED',
        startTime: new Date(Date.now() - 86_400_000),
        endTime: new Date(Date.now() - 3_600_000),
      },
    })
  ).id
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  const orders = { OR: [{ venueId: { in: VENUES } }, { order: { venueId: { in: VENUES } } }] }
  await prisma.paymentAllocation.deleteMany({ where: { payment: orders } })
  await prisma.payment.deleteMany({ where: orders })
  await prisma.orderItem.deleteMany({ where: { order: { venueId: { in: VENUES } } } })
  await prisma.order.deleteMany({ where: { venueId: { in: VENUES } } })
  await prisma.shift.deleteMany({ where: { venueId: { in: VENUES } } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: VENUES } } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.activityLog.deleteMany({ where: { OR: [{ organizationId }, { venueId: { in: VENUES } }] } })
  await prisma.product.deleteMany({ where: { venueId: { in: VENUES } } })
  await prisma.menuCategory.deleteMany({ where: { venueId: { in: VENUES } } })
  await prisma.fiscalEmisor.deleteMany({ where: { venueId: { in: VENUES } } })
  await prisma.venue.deleteMany({ where: { id: { in: VENUES } } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  cleanupPaymentCache()
})

describe('header events vs fiscal capture, both directions', () => {
  it('a header update waits for fiscal capture and then applies its imported money exactly', async () => {
    const o = await posOrder()
    const before = await snapshot(o.id)
    const writer = await whileFiscalHolds(
      o.id,
      nothing,
      () => processPosOrderEvent(header(o.externalId, { subtotal: 200.1, taxAmount: 32.02, total: 232.12 })),
      async () => expect(await snapshot(o.id)).toEqual(before),
    )
    expect(writer.error).toBeUndefined()
    expect(await snapshot(o.id)).toMatchObject({
      subtotal: '200.10',
      tax: '32.02',
      discount: '0.00',
      total: '232.12',
      contrato: 'IVA_APARTE',
    })
  })

  it('fiscal capture arriving while a header event holds the Order sees the whole event: money, PAID and its payment', async () => {
    const o = await posOrder()
    const paused = pauseAfterOrderLock()
    const writer = resultOf(processPosOrderEvent(header(o.externalId, { subtotal: 300, taxAmount: 48, total: 348 }, 348)))
    let reservation: Promise<unknown> | undefined
    try {
      const pid = await paused.entered(writer)
      reservation = prisma.$transaction(async tx => {
        await bloquearOrdenParaFacturar(tx, o.id)
        return { order: await snapshot(o.id, tx), payments: await tx.payment.count({ where: { orderId: o.id } }) }
      })
      await blockedBy(pid)
    } finally {
      paused.release()
      await writer
    }
    expect((await writer).error).toBeUndefined()
    const final = { order: await snapshot(o.id), payments: await prisma.payment.count({ where: { orderId: o.id } }) }
    expect(final).toMatchObject({ order: { total: '348.00', paymentStatus: 'PAID' }, payments: 1 })
    expect(await reservation).toEqual(final)
  })
})

describe('one lock-wait budget (Ruling T8-R2)', () => {
  // A lock wait counts against the interactive-transaction timeout. On Prisma's default (5 s) the header died with P2028
  // behind a holder allowed 15 s, and the POS consumer sends that to a permanent DLQ while its lines (15 s) still apply.
  it('a header event outlasts a holder that keeps the Order ~7 s, then applies its imported money', async () => {
    const o = await posOrder()
    const writer = await whileFiscalHolds(
      o.id,
      nothing,
      () => processPosOrderEvent(header(o.externalId, { subtotal: 210, taxAmount: 33.6, total: 243.6 })),
      async () => {
        await pause(7_000)
      },
    )
    expect(writer.error).toBeUndefined()
    expect(await snapshot(o.id)).toMatchObject({ subtotal: '210.00', tax: '33.60', total: '243.60', contrato: 'IVA_APARTE' })
  })
})

describe('header identity is revalidated under the Order lock', () => {
  it('an alias order moved to another venue while the header waited is never written; the event creates its own order', async () => {
    const f = folio()
    const alias = await processPosOrderEvent(header(`${INSTANCE}:0:${f}`))
    const writer = await whileFiscalHolds(alias.id, moveTo(alias.id, otherVenueId), () =>
      processPosOrderEvent(header(`${INSTANCE}:77:${f}`, { subtotal: 200, taxAmount: 32, total: 232 })),
    )
    expect(writer.error).toBeUndefined()
    expect(await snapshot(alias.id)).toMatchObject({ venueId: otherVenueId, externalId: `${INSTANCE}:0:${f}`, total: '116.00' })
    const created = await prisma.order.findUniqueOrThrow({ where: { venueId_externalId: { venueId, externalId: `${INSTANCE}:77:${f}` } } })
    expect(created.id).not.toBe(alias.id)
    expect(await snapshot(created.id)).toMatchObject({ total: '232.00', contrato: 'IVA_APARTE' })
  })

  it('an alias order deleted while the header waited does not fail the event: it creates its own order', async () => {
    const f = folio()
    const alias = await processPosOrderEvent(header(`${INSTANCE}:0:${f}`))
    const writer = await whileFiscalHolds(
      alias.id,
      tx => tx.order.delete({ where: { id: alias.id } }),
      () => processPosOrderEvent(header(`${INSTANCE}:77:${f}`)),
    )
    expect(writer.error).toBeUndefined()
    expect(await prisma.order.count({ where: { id: alias.id } })).toBe(0)
    const created = await prisma.order.findUniqueOrThrow({ where: { venueId_externalId: { venueId, externalId: `${INSTANCE}:77:${f}` } } })
    expect(await snapshot(created.id)).toMatchObject({ total: '116.00', contrato: 'IVA_APARTE' })
  })

  it('a shift link another writer set while the header waited is kept: adoption is decided from the row under the lock', async () => {
    const o = await posOrder()
    const writer = await whileFiscalHolds(
      o.id,
      tx => tx.order.update({ where: { id: o.id }, data: { shiftId: historicShiftId } }),
      () => processPosOrderEvent({ ...header(o.externalId), staffData: POS_WAITER, shiftData: POS_SHIFT }),
    )
    expect(writer.error).toBeUndefined()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).shiftId).toBe(historicShiftId)
  })

  it('control: an order that is still orphan under the lock adopts the OPEN shift the header claimed', async () => {
    const o = await posOrder()
    await processPosOrderEvent({ ...header(o.externalId), staffData: POS_WAITER, shiftData: POS_SHIFT })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).shiftId).toBe(openShiftId)
  })
})

describe('line events vs fiscal capture, both directions', () => {
  it('a line update waits for fiscal capture, then applies', async () => {
    const o = await posOrder({ lines: 1 })
    const before = await snapshot(o.id)
    const writer = await whileFiscalHolds(
      o.id,
      nothing,
      () => processPosOrderItemEvent(line(o.externalId, o.lineIds[0], { quantity: 2, total: 100, taxAmount: 16 })),
      async () => expect(await snapshot(o.id)).toEqual(before),
    )
    expect(writer.error).toBeUndefined()
    expect((await snapshot(o.id)).items).toEqual([expect.objectContaining({ externalId: o.lineIds[0], quantity: 2, total: 100 })])
  })

  it('a line delete waits for fiscal capture, then removes the line', async () => {
    const o = await posOrder({ lines: 1 })
    const before = await snapshot(o.id)
    const writer = await whileFiscalHolds(
      o.id,
      nothing,
      () => processPosOrderItemEvent(line(o.externalId, o.lineIds[0], { deleted: true })),
      async () => expect(await snapshot(o.id)).toEqual(before),
    )
    expect(writer.error).toBeUndefined()
    expect(writer.value).toEqual({ id: o.lineIds[0], deleted: true })
    expect((await snapshot(o.id)).items).toEqual([])
  })

  it('a new line waits for fiscal capture, then is created', async () => {
    const o = await posOrder({ lines: 1 })
    const before = await snapshot(o.id)
    const writer = await whileFiscalHolds(
      o.id,
      nothing,
      () => processPosOrderItemEvent(line(o.externalId, `${o.externalId}:NEW`)),
      async () => expect(await snapshot(o.id)).toEqual(before),
    )
    expect(writer.error).toBeUndefined()
    expect((await snapshot(o.id)).items).toHaveLength(2)
  })

  it('fiscal capture arriving while a line event holds the Order sees the finished line', async () => {
    const o = await posOrder({ lines: 1 })
    const paused = pauseAfterOrderLock()
    const writer = resultOf(processPosOrderItemEvent(line(o.externalId, `${o.externalId}:NEW`, { quantity: 3, total: 150, taxAmount: 24 })))
    let reservation: Promise<unknown> | undefined
    try {
      const pid = await paused.entered(writer)
      reservation = prisma.$transaction(async tx => {
        await bloquearOrdenParaFacturar(tx, o.id)
        return snapshot(o.id, tx)
      })
      await blockedBy(pid)
    } finally {
      paused.release()
      await writer
    }
    expect((await writer).error).toBeUndefined()
    const final = await snapshot(o.id)
    expect(final.items).toHaveLength(2)
    expect(await reservation).toEqual(final)
  })

  it('a line whose parent was renamed to its paid idturno while it waited is not found, like a line arriving after the rename', async () => {
    const f = folio()
    const zero = `${INSTANCE}:0:${f}`
    const order = await processPosOrderEvent(header(zero))
    const writer = await whileFiscalHolds(
      order.id,
      tx => tx.order.update({ where: { id: order.id }, data: { externalId: `${INSTANCE}:77:${f}` } }),
      () => processPosOrderItemEvent(line(zero, `${zero}:L0`)),
    )
    expect(writer.error).toMatchObject({
      statusCode: 404,
      message: `La orden padre ${zero} no fue encontrada. No se puede procesar el item.`,
    })
    expect((await snapshot(order.id)).items).toEqual([])
  })

  it('a line whose parent moved to another venue while it waited is not found and writes nothing', async () => {
    const o = await posOrder({ lines: 1 })
    const writer = await whileFiscalHolds(o.id, moveTo(o.id, otherVenueId), () =>
      processPosOrderItemEvent(line(o.externalId, `${o.externalId}:LATE`)),
    )
    expect(writer.error).toMatchObject({
      statusCode: 404,
      message: `La orden padre ${o.externalId} no fue encontrada. No se puede procesar el item.`,
    })
    expect((await snapshot(o.id)).items.map(i => i.externalId)).toEqual([o.lineIds[0]])
  })
})

describe('POS delete: tenant-scoped lock, no native PAID guard', () => {
  it('a delete whose order moved to another venue while it waited marks nothing', async () => {
    const o = await posOrder()
    const writer = await whileFiscalHolds(o.id, moveTo(o.id, otherVenueId), () => processPosOrderDeleteEvent(header(o.externalId)))
    expect(writer.error).toBeUndefined()
    expect(writer.value).toBeNull()
    expect(await snapshot(o.id)).toMatchObject({ venueId: otherVenueId, status: 'PENDING' })
  })

  it('control: a delete of its own PAID order waits for fiscal capture and marks it DELETED, money untouched', async () => {
    const o = await posOrder({ paid: 116 })
    const writer = await whileFiscalHolds(o.id, nothing, () => processPosOrderDeleteEvent(header(o.externalId)))
    expect(writer.error).toBeUndefined()
    expect(await snapshot(o.id)).toMatchObject({ venueId, status: 'DELETED', paymentStatus: 'PAID', total: '116.00' })
  })
})

describe('placeholder Product: Venue fence first, one transaction, bounded retry', () => {
  it('a failure after the placeholder Product, its category and its audit were written rolls them back with the line', async () => {
    const externalId = `${INSTANCE}:1:${folio()}`
    await processPosOrderEvent(header(externalId, {}, undefined, rollbackVenueId))
    const productExt = `${fixture}-rollback-product`
    const original = prisma.$transaction.bind(prisma)
    let observed = false
    jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options: any) =>
      typeof callback !== 'function'
        ? original(callback)
        : original(
            async tx =>
              callback(
                new Proxy(tx, {
                  get(target, key) {
                    return key === 'orderItem'
                      ? new Proxy(target.orderItem, {
                          get(model, method) {
                            return method === 'upsert'
                              ? async () => {
                                  const products = await tx.product.count({ where: { venueId: rollbackVenueId, externalId: productExt } })
                                  const categories = await tx.menuCategory.count({ where: { venueId: rollbackVenueId, slug: 'pos-sync' } })
                                  const audits = await tx.activityLog.count({
                                    where: { venueId: rollbackVenueId, action: 'CATALOG_LEGACY_PRODUCT_CREATED' },
                                  })
                                  observed = products === 1 && categories === 1 && audits === 1
                                  throw new Error('injected line failure after the placeholder')
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
      processPosOrderItemEvent(
        line(externalId, `${externalId}:L0`, { productExternalId: productExt, productName: 'Nuevo' }, rollbackVenueId),
      ),
    ).rejects.toThrow('injected line failure after the placeholder')

    expect(observed).toBe(true)
    expect(await prisma.product.count({ where: { venueId: rollbackVenueId, externalId: productExt } })).toBe(0)
    expect(await prisma.menuCategory.count({ where: { venueId: rollbackVenueId, slug: 'pos-sync' } })).toBe(0)
    expect(await prisma.activityLog.count({ where: { venueId: rollbackVenueId, action: 'CATALOG_LEGACY_PRODUCT_CREATED' } })).toBe(0)
    expect(await prisma.orderItem.count({ where: { order: { venueId: rollbackVenueId } } })).toBe(0)
  })

  it('a placeholder line waits for a deletion holding the Venue without holding the Order, then finishes', async () => {
    const o = await posOrder()
    const entered = barrier<number>(),
      finish = barrier()
    const lock = jest.spyOn(orderLock, 'lockExistingOrderForPayment')
    const deleting = prisma.$transaction(
      async tx => {
        // deleteVenue's Venue → Order part: Venue FOR UPDATE, then this Order. (The real deleteVenue deletes the venue's
        // OrderItems/modifiers and Payments BEFORE its Orders; against a writer already holding an Order that is a
        // possible 40P01, the kept T8-R4 residual — not modeled here.)
        await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR UPDATE`
        entered.release(await backendPid(tx))
        await finish.promise
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${o.id} FOR UPDATE NOWAIT`
      },
      { timeout: 20_000 },
    )
    let writer: Promise<Outcome<unknown>> | undefined
    try {
      const pid = await entered.promise
      writer = resultOf(
        processPosOrderItemEvent(
          line(o.externalId, `${o.externalId}:PH`, { productExternalId: `${fixture}-ph-${folio()}`, productName: 'Sin catálogo' }),
        ),
      )
      await blockedBy(pid)
      // It waits on the Venue fence and has not taken the Order: another connection still locks it without waiting.
      expect(lock).not.toHaveBeenCalled()
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

  it('the existing-product fast path never needs the Venue: it finishes while a deletion holds the Venue', async () => {
    const o = await posOrder()
    const entered = barrier<number>(),
      finish = barrier()
    // Only the Venue step of deleteVenue (it then deletes OrderItems and Payments before Orders — T8-R4, not modeled).
    const deleting = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} FOR UPDATE`
        entered.release(await backendPid(tx))
        await finish.promise
      },
      { timeout: 45_000 },
    )
    let writer: Promise<Outcome<unknown>> | undefined
    let waitedOnDeletion: boolean | undefined
    try {
      const pid = await entered.promise
      let finished = false
      writer = resultOf(processPosOrderItemEvent(line(o.externalId, `${o.externalId}:FAST`))).finally(() => {
        finished = true
      })
      // Postgres, not a fixed window, says whether it waited: a slow writer on a loaded machine is not a blocked one.
      waitedOnDeletion = await blockedBy(pid, () => finished)
    } finally {
      finish.release()
      await deleting
      await writer
    }
    expect(waitedOnDeletion).toBe(false)
    expect((await writer!).error).toBeUndefined()
    expect((await snapshot(o.id)).items).toHaveLength(1)
  })

  it('a product deleted while the fast path waited is recreated as a placeholder by ONE retry that takes the fence first', async () => {
    const o = await posOrder()
    const ext = `${fixture}-vanishing-${folio()}`
    const vanishing = await prisma.product.create({
      data: { venueId, categoryId: catalogCategoryId, name: 'Temporal', sku: ext, price: 30, externalId: ext },
    })
    const fence = jest.spyOn(catalogGovernance, 'assertLegacyCatalogGovernanceForVenue')
    const lock = jest.spyOn(orderLock, 'lockExistingOrderForPayment')
    const writer = await whileFiscalHolds(
      o.id,
      tx => tx.product.delete({ where: { id: vanishing.id } }),
      () =>
        processPosOrderItemEvent(
          line(o.externalId, `${o.externalId}:V`, { productExternalId: ext, productName: 'Recreado', unitPrice: 30, total: 30 }),
        ),
    )
    expect(writer.error).toBeUndefined()
    const placeholder = await prisma.product.findUniqueOrThrow({ where: { venueId_externalId: { venueId, externalId: ext } } })
    expect(placeholder.id).not.toBe(vanishing.id)
    expect(placeholder).toMatchObject({ name: 'Recreado', originSystem: 'POS_SOFTRESTAURANT' })
    expect((await snapshot(o.id)).items).toEqual([expect.objectContaining({ externalId: `${o.externalId}:V`, productId: placeholder.id })])
    expect(await prisma.activityLog.count({ where: { venueId, action: 'CATALOG_LEGACY_PRODUCT_CREATED', entityId: placeholder.id } })).toBe(
      1,
    )
    // First attempt: Order lock without fence. Retry: fence, then its own Order lock.
    expect(lock).toHaveBeenCalledTimes(2)
    expect(fence).toHaveBeenCalledTimes(1)
    expect(fence.mock.invocationCallOrder[0]).toBeGreaterThan(lock.mock.invocationCallOrder[0])
    expect(fence.mock.invocationCallOrder[0]).toBeLessThan(lock.mock.invocationCallOrder[1])
  })
})

describe('imported header money is authoritative (golden)', () => {
  it('stays byte-identical through line create, update and delete and a re-sent header', async () => {
    const externalId = `${INSTANCE}:1:${folio()}`
    const money = { subtotal: 100.1, taxAmount: 16.02, discountAmount: 3.33, tipAmount: 7.77, total: 120.56 }
    const order = await processPosOrderEvent(header(externalId, money))
    const golden = { subtotal: '100.10', tax: '16.02', discount: '3.33', tip: '7.77', total: '120.56', contrato: 'IVA_APARTE' }
    expect(await snapshot(order.id)).toMatchObject(golden)

    await processPosOrderItemEvent(line(externalId, `${externalId}:A`, { unitPrice: 999.99, total: 999.99, taxAmount: 160 }))
    await processPosOrderItemEvent(line(externalId, `${externalId}:A`, { quantity: 7, total: 6999.93 }))
    await processPosOrderItemEvent(line(externalId, `${externalId}:B`, { quantity: 2, unitPrice: 1, total: 2 }))
    await processPosOrderItemEvent(line(externalId, `${externalId}:B`, { deleted: true }))
    expect(await snapshot(order.id)).toMatchObject(golden)

    await processPosOrderEvent(header(externalId, money))
    expect(await snapshot(order.id)).toMatchObject(golden)
  })

  it('a PAID imported order still takes line events and keeps its money and its single payment (no native PAID guard)', async () => {
    const o = await posOrder({ paid: 116 })
    await processPosOrderItemEvent(line(o.externalId, `${o.externalId}:AFTER`))
    await processPosOrderEvent(header(o.externalId, {}, 116))
    const after = await snapshot(o.id)
    expect(after).toMatchObject({ paymentStatus: 'PAID', total: '116.00', tax: '16.00' })
    expect(after.items).toHaveLength(1)
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(1)
  })
})

describe('characterization: the numeric barrier cannot prove a complete POS snapshot (§14, NOT resolved by Plan 3b)', () => {
  // These tests document a KNOWN LIMITATION, not desired behavior. Header and lines are independent upstream events
  // without a common revision: the Order lock serializes the events that arrived, it cannot prove none is missing.
  // The approved answer is NOT to block «sinRenglones» or recompute imported headers (all-16 compatibility and the
  // IVA_APARTE monetary authority); it is Plan 6's POS exclusion before activation. If one of these starts failing,
  // somebody changed that decision: make it explicit instead of adjusting the expectation.
  const capture = (orderId: string) =>
    prisma.$transaction(async tx => {
      await bloquearOrdenParaFacturar(tx, orderId)
      return loadOrderForCfdiFromDb(orderId, {}, tx)
    })

  it('a PAID header that arrived without any line passes: a generic «Venta» concept equals what was paid', async () => {
    const o = await posOrder({ paid: 116 })
    const bundle = await capture(o.id)
    expect(bundle).not.toBeNull()
    expect(bundle!.unsupportedReasons).toBeUndefined()
    expect({ total: bundle!.totalCents, paid: bundle!.paidCents }).toEqual({ total: 11600, paid: 11600 })
    expect(bundle!.order.items).toEqual([expect.objectContaining({ productName: 'Venta', quantity: 1 })])
    expect(bundle!.order.renglonesOrigen).toEqual([])
  })

  it('a stale line of equal value passes too: upstream replaced it and the replacement events never arrived', async () => {
    const o = await posOrder({ paid: 116 })
    await processPosOrderItemEvent(line(o.externalId, `${o.externalId}:OLD`, { unitPrice: 100, total: 100, taxAmount: 16 }))
    // Upstream now sells another $100 + IVA product instead: the header is re-sent unchanged, while the delete of the
    // old line and the new line are lost. Nothing local can tell.
    await processPosOrderEvent(header(o.externalId, {}, 116))
    const bundle = await capture(o.id)
    expect(bundle).not.toBeNull()
    expect(bundle!.unsupportedReasons).toBeUndefined()
    expect({ total: bundle!.totalCents, paid: bundle!.paidCents }).toEqual({ total: 11600, paid: 11600 })
    const stale = await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.id } })
    expect(bundle!.order.renglonesOrigen).toEqual([{ orderItemId: stale.id, tratamiento: 'IVA_16' }])
  })
})
