/**
 * Plan3b T6: imported POS events (pos-sync header and lines) serialize with fiscal capture on the real Order row, decide
 * from the row read under that lock, and never change the imported header money (the POS header is the monetary
 * authority, IVA_APARTE). R5: both existing products and placeholder paths take Venue before Order, closing T8-R4
 * against deleteVenue's child deletes. Placeholders retain the governance check before the Order.
 * Characterization block: the upstream-completeness limit (§14), which Plan 3b does NOT resolve.
 * Plan 6b block (spec §5.4): with IVA por producto ON, no POS writer writes anything (the reverse exclusion).
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
import type { Request, Response } from 'express'
import { dispatchPosEvent } from '@/communication/rabbitmq/dispacher'
import { transferVenue } from '@/controllers/dashboard/venues.superadmin.controller'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'
import * as exclusionIva from '@/services/pos-sync/exclusionIva'
import { olvidarRechazos, PosRechazadoPorIva } from '@/services/pos-sync/exclusionIva'
import { processPosAreaEvent } from '@/services/pos-sync/posSyncArea.service'
import { processPosHeartbeat } from '@/services/pos-sync/posSyncHeartbeat.service'
import { getOrCreatePosShift, processPosShiftEvent } from '@/services/pos-sync/posSyncShift.service'
import { posSyncStaffService } from '@/services/pos-sync/posSyncStaff.service'
import { lockShiftLifecycleForVenue } from '@/services/shared/shiftLifecycleLock'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/communication/sockets/terminal-registry', () => ({
  normalizeTerminalId: (id: string) => jest.requireActual('@/utils/terminalSerial').terminalIdentityKey(id),
  terminalRegistry: { getTerminal: jest.fn(), getAllTerminalIds: jest.fn(() => []) },
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
// Plan 6b: el rastro del rechazo (ActivityLog) se escribe de verdad; la configuración de integración lo deja en `jest.fn()`.
jest.mock('@/services/dashboard/activity-log.service', () => jest.requireActual('@/services/dashboard/activity-log.service'))
// Plan 6b: la observación de 30 días de los aparatos se da por cumplida (su valor real lo prueba la Tarea 3).
jest.mock('@/services/mobile/deviceRegistry.service', () => ({
  ...jest.requireActual('@/services/mobile/deviceRegistry.service'),
  OBSERVADOR_POS_DESDE: new Date('2026-08-01T00:00:00Z'),
}))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(codex_testarudo_test_|avoqado_(?:[a-z0-9]+|cambio_r5)_test_)/.test(database.pathname)
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
/** Observe only this fixture's real claim, after PostgreSQL acquired it; preserve the legacy item path explicitly. */
function pauseAfterOrderLock(orderId: string, mode: 'scope' | 'legacy') {
  const entered = barrier<number>(),
    finish = barrier()
  const original = prisma.$transaction.bind(prisma)
  let paused = false
  jest.spyOn(prisma, '$transaction').mockImplementation(((callback: any, options: any) =>
    Array.isArray(callback)
      ? original(callback, options)
      : original(
          async tx =>
            callback(
              new Proxy(tx, {
                get(target, key) {
                  if (key !== '$queryRaw') return Reflect.get(target, key)
                  return async (...args: unknown[]) => {
                    const rows: unknown = await Reflect.apply(target.$queryRaw, target, args)
                    const raw = args[0] as { strings?: readonly string[]; values?: unknown[] }
                    const sql = (Array.isArray(raw) ? raw : (raw.strings ?? [])).join('?').replace(/\s+/g, ' ').trim()
                    const values = Array.isArray(raw) ? Prisma.sql(raw, ...args.slice(1)).values : (raw.values ?? [])
                    const scopeClaim =
                      mode === 'scope' &&
                      sql ===
                        'SELECT id FROM "Order" WHERE "venueId"=? AND id=ANY(?::text[]) ORDER BY "createdAt" DESC, id DESC FOR UPDATE' &&
                      args[1] === venueId &&
                      Array.isArray(args[2]) &&
                      args[2].includes(orderId)
                    const legacyClaim =
                      mode === 'legacy' &&
                      sql.includes('ancestors(id) AS') &&
                      sql.includes('FOR UPDATE OF o') &&
                      // The payment lock seeds its CTE with a list of Orders (exchange settlement adds the original).
                      Array.isArray(values[0]) &&
                      values[0].includes(orderId) &&
                      values[1] === venueId
                    if (!paused && (scopeClaim || legacyClaim) && Array.isArray(rows) && rows.some(row => row.id === orderId)) {
                      paused = true
                      entered.release(await backendPid(target))
                      await finish.promise
                    }
                    return rows
                  }
                },
              }),
            ),
          options,
        )) as any)
  return {
    entered: (writer: Promise<unknown>) =>
      Promise.race([
        entered.promise,
        writer.then(() => {
          throw new Error('writer never acquired target Order lock')
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
    const paused = pauseAfterOrderLock(o.id, 'scope')
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
      await Promise.allSettled([writer, ...(reservation ? [reservation] : [])])
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
    const paused = pauseAfterOrderLock(o.id, 'legacy')
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
      await Promise.allSettled([writer, ...(reservation ? [reservation] : [])])
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
        // Venue → Order, including the common R5 fence: deletion cannot get ahead of a writer already holding its Order.
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

  it('an existing-product line waits for deletion before holding its Order, then finishes (R5 closes T8-R4)', async () => {
    const o = await posOrder()
    const entered = barrier<number>(),
      finish = barrier()
    // The common fence must serialize even an existing-product writer before deletion can touch its child rows.
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
      writer = resultOf(processPosOrderItemEvent(line(o.externalId, `${o.externalId}:FAST`)))
      waitedOnDeletion = await blockedBy(pid)
      await prisma.$transaction(tx => tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${o.id} FOR UPDATE NOWAIT`)
    } finally {
      finish.release()
      await deleting
      await writer
    }
    expect(waitedOnDeletion).toBe(true)
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

describe('Plan 6b (spec §5.4): con el IVA por producto encendido, el POS externo no escribe nada', () => {
  const ORGS: string[] = []
  const STAFFS: string[] = []
  const P6B = `${fixture}-6b-`
  const RECHAZO = 'POS_EXTERNO_RECHAZADO_POR_IVA'

  /** Los backends que esperan un candado que tiene `pid` (sólo los de ESTE caso). */
  async function esperarBloqueadosPor(pid: number, n = 1): Promise<number[]> {
    for (let i = 0; i < 1200; i++) {
      const filas = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
      if (filas.length >= n) return filas.map(f => f.pid)
      await pause(25)
    }
    throw new Error(`nadie quedó esperando al backend ${pid}`)
  }
  /** Una transacción de la prueba que retiene un candado hasta `soltar()`; `tomado` entrega su pid ya con el candado. */
  function tapon(retener: (t: Prisma.TransactionClient) => Promise<unknown>) {
    const suelto = barrier()
    const tomado = barrier<number>()
    const tx = prisma.$transaction(
      async t => {
        const pid = await backendPid(t)
        await retener(t)
        tomado.release(pid)
        await suelto.promise
      },
      { timeout: 45_000 },
    )
    return { tomado: tomado.promise, soltar: () => suelto.release(), tx }
  }
  /** El candado del ciclo de turnos del negocio: el reclamo y el cierre lo toman DESPUÉS de su guardia. */
  const taponDeTurnos = (venueId: string) => tapon(t => lockShiftLifecycleForVenue(t, venueId))

  const organizacion = async (etiqueta: string) => {
    const id = `${P6B}${etiqueta}`
    await prisma.organization.create({ data: { id, name: id, email: `${id}@example.test`, phone: '5500000000' } })
    ORGS.push(id)
    return id
  }
  /** Una organización con su negocio (mismo id), sin POS conectado: `posType` nulo, sin latido ni órdenes POS. */
  const negocio = async (etiqueta: string) => {
    const id = await organizacion(etiqueta)
    await prisma.venue.create({ data: { id, organizationId: id, name: id, slug: id } })
    return id
  }
  const persona = async (venueId: string, role: 'OWNER' | 'WAITER', posStaffId?: string) => {
    const id = (await prisma.staff.create({ data: { email: `${venueId}-${randomUUID()}@staff.test`, firstName: 'IVA', lastName: '6b' } }))
      .id
    STAFFS.push(id)
    await prisma.staffVenue.create({ data: { staffId: id, venueId, role, posStaffId } })
    return id
  }
  /** Un turno del POS abierto con dos cobros (efectivo y tarjeta, con propina), sembrados directo: no son ventas recibidas del POS. */
  const turnoConCobros = async (venueId: string, cajeroId: string) => {
    const turno = await prisma.shift.create({
      data: {
        venueId,
        staffId: cajeroId,
        externalId: `${venueId}-turno`,
        startTime: new Date(Date.now() - 3_600_000),
        originSystem: 'POS_SOFTRESTAURANT',
      },
    })
    const venta = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${venueId}-1`,
        subtotal: 150,
        taxAmount: 0,
        total: 150,
        shiftId: turno.id,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
      },
    })
    for (const [method, amount, tipAmount] of [
      ['CASH', 100, 10],
      ['CREDIT_CARD', 50, 5],
    ] as const)
      await prisma.payment.create({
        data: {
          venueId,
          orderId: venta.id,
          shiftId: turno.id,
          method,
          amount,
          tipAmount,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: amount,
          status: 'COMPLETED',
        },
      })
    return turno
  }
  const cierreDe = (venueId: string, externalId: string) => ({
    venueId,
    shiftData: { externalId, staffId: 'C1', posRawData: { fondo: 500, efectivo: 610 } },
  })
  const productoDe = async (venueId: string) => {
    const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'IVA', slug: `iva-${randomUUID().slice(0, 8)}` } })).id
    return prisma.product.create({
      data: { venueId, categoryId, sku: `P6B-${randomUUID().slice(0, 8)}`, name: 'Café en grano', price: 100 },
    })
  }
  /** El encendido REAL: el dueño elige 0 % en un negocio apagado. */
  const encenderAlGuardar = (venueId: string, productId: string, staffId: string) =>
    updateProduct(venueId, productId, { ivaTratamiento: 'IVA_0' } as any, { type: 'HUMAN', staffId, impersonating: false })
  const rechazos = (venueId: string) => prisma.activityLog.count({ where: { venueId, action: RECHAZO } })
  const turnoDe = async (id: string) =>
    JSON.parse(
      JSON.stringify(
        await prisma.shift.findUniqueOrThrow({
          where: { id },
          select: { status: true, endTime: true, totalSales: true, totalTips: true, totalCashPayments: true, totalCardPayments: true },
        }),
      ),
    )
  /** Todo lo que el POS externo escribe en un negocio, para comparar antes y después (byte a byte). */
  const foto = async (venueId: string) =>
    JSON.parse(
      JSON.stringify({
        orders: await prisma.order.findMany({ where: { venueId }, orderBy: { id: 'asc' }, take: 50 }),
        items: await prisma.orderItem.findMany({ where: { order: { venueId } }, orderBy: { id: 'asc' }, take: 50 }),
        shifts: await prisma.shift.findMany({ where: { venueId }, orderBy: { id: 'asc' }, take: 50 }),
        payments: await prisma.payment.findMany({ where: { venueId }, orderBy: { id: 'asc' }, take: 50 }),
        staffVenues: await prisma.staffVenue.findMany({ where: { venueId }, include: { staff: true }, orderBy: { id: 'asc' }, take: 50 }),
        tables: await prisma.table.findMany({ where: { venueId }, orderBy: { id: 'asc' }, take: 50 }),
        areas: await prisma.area.findMany({ where: { venueId }, orderBy: { id: 'asc' }, take: 50 }),
        conexion: await prisma.posConnectionStatus.findUnique({ where: { venueId } }),
        venue: await prisma.venue.findUniqueOrThrow({
          where: { id: venueId },
          select: { organizationId: true, posStatus: true, updatedAt: true },
        }),
      }),
    )
  /** El controlador REAL del traslado, sin HTTP: el error que pasó a `next`, o `{ status }`. */
  async function trasladar(venueId: string, targetOrganizationId: string): Promise<unknown> {
    let error: unknown = null
    let status = 0
    const res = { status: (s: number) => ((status = s), res), json: () => res } as unknown as Response
    const req = { params: { venueId }, body: { targetOrganizationId }, authContext: { userId: null } } as unknown as Request
    await transferVenue(req, res, (e?: unknown) => (error = e))
    return error ?? { status }
  }

  beforeEach(() => olvidarRechazos())
  afterAll(async () => {
    const venues = { in: ORGS }
    await prisma.paymentAllocation.deleteMany({ where: { payment: { venueId: venues } } })
    await prisma.payment.deleteMany({ where: { venueId: venues } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId: venues } } })
    await prisma.order.deleteMany({ where: { venueId: venues } })
    await prisma.shift.deleteMany({ where: { venueId: venues } })
    await prisma.staffVenue.deleteMany({ where: { venueId: venues } })
    await prisma.staffOrganization.deleteMany({ where: { OR: [{ organizationId: venues }, { staffId: { in: STAFFS } }] } })
    await prisma.activityLog.deleteMany({ where: { OR: [{ venueId: venues }, { organizationId: venues }] } })
    await prisma.staff.deleteMany({ where: { OR: [{ id: { in: STAFFS } }, { email: { startsWith: `pos-${P6B}` } }] } })
    await prisma.table.deleteMany({ where: { venueId: venues } })
    await prisma.area.deleteMany({ where: { venueId: venues } })
    await prisma.product.deleteMany({ where: { venueId: venues } })
    await prisma.menuCategory.deleteMany({ where: { venueId: venues } })
    await prisma.venue.deleteMany({ where: { id: venues } })
    await prisma.organization.deleteMany({ where: { id: venues } })
  })

  describe('negocio ya encendido', () => {
    let v: string, pedido: { id: string; externalId: string }, turnoId: string, turnoExterno: string, area: { externalId: string }
    const latido = { instanceId: 'SR-6B', producerVersion: '1.0.0' }
    beforeAll(async () => {
      v = await negocio('encendido')
      // Lo que el POS escribió mientras el negocio estaba apagado: un mesero, una orden con su renglón, un turno con cobros, un área
      // y su conexión.
      await persona(v, 'WAITER', 'W1')
      const cajero = await persona(v, 'WAITER', 'C1')
      const externalId = `${INSTANCE}:1:${folio()}`
      pedido = { id: (await processPosOrderEvent(header(externalId, {}, undefined, v))).id, externalId }
      await processPosOrderItemEvent(line(externalId, `${externalId}:L0`, {}, v))
      const turno = await turnoConCobros(v, cajero)
      turnoId = turno.id
      turnoExterno = turno.externalId!
      area = { externalId: `${v}-area` }
      await prisma.area.create({ data: { venueId: v, name: 'Terraza', externalId: area.externalId, originSystem: 'POS_SOFTRESTAURANT' } })
      await prisma.posConnectionStatus.create({
        data: { venueId: v, status: 'ONLINE', ...latido, lastHeartbeatAt: new Date('2026-10-01T12:00:00Z') },
      })
      await encenderIvaPorProducto(v)
    })

    it('alta tardía por el despachador: resuelve (ACK), nada nuevo (orden, mesero, mesa, turno) y UNA fila de rastro', async () => {
      const antes = await foto(v)
      const rastro = await rechazos(v)
      const alta: RichPosPayload = {
        ...header(`${INSTANCE}:1:${folio()}`, {}, 116, v),
        staffData: { externalId: 'W9', name: 'Mesero nuevo', pin: '1234' },
        tableData: { externalId: 'T9' },
        shiftData: { externalId: `${v}-turno-nuevo`, startTime: new Date().toISOString() },
      }
      await expect(dispatchPosEvent('pos.softrestaurant.order.created', alta)).resolves.toBeUndefined()
      expect(await foto(v)).toEqual(antes)
      expect(await prisma.staff.count({ where: { email: { startsWith: `pos-${v}-` } } })).toBe(0)
      expect(await rechazos(v)).toBe(rastro + 1)
    })

    it('la carrera, en cada escritor (sin la revisión del despachador): cada uno rechaza con PosRechazadoPorIva y NADA cambia', async () => {
      const antes = await foto(v)
      const escritores: Array<[string, () => Promise<unknown>]> = [
        [
          'alta de orden',
          () =>
            processPosOrderEvent({
              ...header(`${INSTANCE}:1:${folio()}`, {}, 116, v),
              staffData: POS_WAITER,
              tableData: { externalId: 'T9' },
              shiftData: { externalId: `${v}-turno-nuevo`, startTime: null },
            }),
        ],
        ['borrado de orden (atrasado)', () => processPosOrderDeleteEvent(header(pedido.externalId, {}, undefined, v))],
        ['renglón', () => processPosOrderItemEvent(line(pedido.externalId, `${pedido.externalId}:L1`, {}, v))],
        ['cierre de turno (atrasado)', () => processPosShiftEvent(cierreDe(v, turnoExterno), 'closed')],
        [
          'personal',
          () => posSyncStaffService.processPosStaffEvent({ venueId: v, staffData: { externalId: 'W77', name: 'Nuevo', pin: null } }),
        ],
        ['área', () => processPosAreaEvent({ venueId: v, areaData: { externalId: area.externalId, name: 'Cambiada', posRawData: {} } })],
        ['latido', () => processPosHeartbeat({ venueId: v, ...latido }, 'softrestaurant')],
        [
          'latido con otra instancia',
          () => processPosHeartbeat({ venueId: v, instanceId: 'SR-OTRA', producerVersion: '9' }, 'softrestaurant'),
        ],
      ]
      for (const [nombre, escribir] of escritores) {
        const r = await resultOf(escribir())
        expect({ nombre, rechazado: r.error instanceof PosRechazadoPorIva }).toEqual({ nombre, rechazado: true })
      }
      expect(await foto(v)).toEqual(antes)
      expect(await turnoDe(turnoId)).toMatchObject({ status: 'OPEN', endTime: null })
    })

    it('la carrera DENTRO de un evento: lo anterior ya pasó y la transacción siguiente ve la bandera (mesa, orden, reclamo, turno nuevo)', async () => {
      const real = exclusionIva.conIvaApagado
      // Lo que se escribió ANTES del encendido (el mesero, el cajero): la guardia de esa escritura ya pasó.
      const yaPaso = <T>(_venueId: string, escribir: (tx: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(escribir)
      const alta = (extra: Partial<RichPosPayload>) => ({ ...header(`${INSTANCE}:1:${folio()}`, {}, undefined, v), ...extra })
      const tablas = await prisma.table.count({ where: { venueId: v } })
      const ordenes = await prisma.order.count({ where: { venueId: v } })
      const turno = JSON.stringify(await prisma.shift.findUniqueOrThrow({ where: { id: turnoId } }))

      // El mesero ya pasó; la mesa rechaza.
      jest.spyOn(exclusionIva, 'conIvaApagado').mockImplementationOnce(yaPaso).mockImplementation(real)
      await expect(processPosOrderEvent(alta({ staffData: POS_WAITER, tableData: { externalId: 'T9' } }))).rejects.toBeInstanceOf(
        PosRechazadoPorIva,
      )
      jest.restoreAllMocks()
      expect(await prisma.table.count({ where: { venueId: v } })).toBe(tablas)

      jest.spyOn(exclusionIva, 'conIvaApagado').mockImplementation(yaPaso)
      // Sin mesero, mesa ni turno: la transacción de la orden rechaza.
      await expect(processPosOrderEvent(alta({}))).rejects.toBeInstanceOf(PosRechazadoPorIva)
      expect(await prisma.order.count({ where: { venueId: v } })).toBe(ordenes)
      // El cajero ya pasó: el reclamo del cierre rechaza ANTES de tocar el turno (ni siquiera un CLOSING que luego se deshace).
      await expect(processPosShiftEvent(cierreDe(v, turnoExterno), 'closed')).rejects.toBeInstanceOf(PosRechazadoPorIva)
      expect(JSON.stringify(await prisma.shift.findUniqueOrThrow({ where: { id: turnoId } }))).toBe(turno)
      jest.restoreAllMocks()

      // La creación del turno del POS, en un negocio encendido sin turno abierto.
      const sinTurno = await negocio('encendido-sin-turno')
      const mesero = await persona(sinTurno, 'WAITER', 'W1')
      await encenderIvaPorProducto(sinTurno)
      await expect(getOrCreatePosShift({ externalId: `${sinTurno}-turno`, startTime: null }, sinTurno, mesero)).rejects.toBeInstanceOf(
        PosRechazadoPorIva,
      )
      expect(await prisma.shift.count({ where: { venueId: sinTurno } })).toBe(0)
    })

    it('el latido en la carrera: la revisión previa llegó antes del encendido ⇒ ACK, la conexión no cambia y queda UNA fila de rastro (Codex r2 N3)', async () => {
      const antes = await foto(v)
      const rastro = await rechazos(v)
      jest.spyOn(exclusionIva, 'rechazarSiIvaEncendido').mockResolvedValueOnce(false)
      await expect(dispatchPosEvent('pos.softrestaurant.system.heartbeat', { venueId: v, ...latido })).resolves.toBeUndefined()
      expect(await foto(v)).toEqual(antes)
      expect(await rechazos(v)).toBe(rastro + 1)
    })
  })

  // Casos 3 a 5: el negocio NO tiene POS conectado (posType nulo, sin latido ni órdenes POS recibidas: el turno, sus cobros y el área se
  // siembran directo), para que el encendido real no se detenga por POS_EXTERNO; y lo enciende su dueño.
  it('el encendido espera al cierre que FINALIZA: el turno se cierra con sus totales y después enciende (Codex r2 N8)', async () => {
    const v = await negocio('cierre-gana')
    const turno = await turnoConCobros(v, await persona(v, 'WAITER', 'C1'))
    const dueno = await persona(v, 'OWNER')
    const producto = await productoDe(v)
    const L1 = taponDeTurnos(v)
    let L2: ReturnType<typeof tapon> | undefined
    let cierre: Promise<Outcome<unknown>> | undefined
    let encendido: Promise<Outcome<unknown>> | undefined
    try {
      const pidL1 = await L1.tomado
      cierre = resultOf(processPosShiftEvent(cierreDe(v, turno.externalId!), 'closed'))
      await esperarBloqueadosPor(pidL1) // el reclamo pasó su guardia y espera L1
      L2 = taponDeTurnos(v)
      await esperarBloqueadosPor(pidL1, 2) // L2 queda en la fila DETRÁS del reclamo
      L1.soltar() // el reclamo confirma CLOSING; L2 toma el candado antes que el cierre
      const pidL2 = await L2.tomado
      const [pidCierre] = await esperarBloqueadosPor(pidL2) // el cierre ya tiene su admisión compartida y espera L2
      encendido = resultOf(encenderAlGuardar(v, producto.id, dueno))
      await esperarBloqueadosPor(pidCierre) // el encendido espera la admisión que tiene el cierre
    } finally {
      L1.soltar()
      L2?.soltar()
      await Promise.allSettled([L1.tx, L2?.tx, cierre, encendido])
    }
    expect((await cierre!).error).toBeUndefined()
    expect((await encendido!).error).toBeUndefined()
    expect(await turnoDe(turno.id)).toMatchObject({
      status: 'CLOSED',
      totalSales: '150',
      totalTips: '15',
      totalCashPayments: '100',
      totalCardPayments: '50',
    })
    expect(await prisma.venueIvaPorProducto.count({ where: { venueId: v } })).toBe(1)
  })

  it('el encendido gana entre el reclamo y el cierre: el cierre rechaza, libera su reclamo y el turno queda como estaba (Codex r2 N8)', async () => {
    const v = await negocio('encendido-gana')
    const turno = await turnoConCobros(v, await persona(v, 'WAITER', 'C1'))
    const dueno = await persona(v, 'OWNER')
    const producto = await productoDe(v)
    const antes = await turnoDe(turno.id)
    const cobros = await prisma.payment.findMany({ where: { venueId: v }, orderBy: { id: 'asc' }, take: 50 })
    const L1 = taponDeTurnos(v)
    let cierre: Promise<Outcome<unknown>> | undefined
    let encendido: Promise<Outcome<unknown>> | undefined
    try {
      const pidL1 = await L1.tomado
      cierre = resultOf(processPosShiftEvent(cierreDe(v, turno.externalId!), 'closed'))
      const [pidReclamo] = await esperarBloqueadosPor(pidL1) // el reclamo, con su admisión compartida, espera L1
      encendido = resultOf(encenderAlGuardar(v, producto.id, dueno))
      await esperarBloqueadosPor(pidReclamo) // el encendido espera la admisión exclusiva DETRÁS del reclamo
    } finally {
      L1.soltar()
      await Promise.allSettled([L1.tx, cierre, encendido])
    }
    expect((await encendido!).error).toBeUndefined()
    expect((await cierre!).error).toBeInstanceOf(PosRechazadoPorIva)
    expect(antes).toMatchObject({ status: 'OPEN', endTime: null })
    expect(await turnoDe(turno.id)).toEqual(antes)
    expect(await prisma.payment.findMany({ where: { venueId: v }, orderBy: { id: 'asc' }, take: 50 })).toEqual(cobros)
  })

  it('traslado a otra organización durante una escritura del POS: el traslado espera; ya en B y encendido, el POS no escribe (Codex r2 N1)', async () => {
    const v = await negocio('traslado-a')
    const destino = await organizacion('traslado-b')
    const area = await prisma.area.create({
      data: { venueId: v, name: 'Terraza', externalId: `${v}-area`, originSystem: 'POS_SOFTRESTAURANT' },
    })
    const evento = (name: string) => ({ venueId: v, areaData: { externalId: area.externalId!, name, posRawData: {} } })
    const fila = tapon(t => t.$queryRaw`SELECT id FROM "Area" WHERE id = ${area.id} FOR UPDATE`)
    let escritura: Promise<Outcome<unknown>> | undefined
    let traslado: Promise<unknown> | undefined
    try {
      const pidFila = await fila.tomado
      escritura = resultOf(processPosAreaEvent(evento('Terraza nueva')))
      const [pidArea] = await esperarBloqueadosPor(pidFila) // pasó su guardia (admisión de A, A FOR SHARE, bandera apagada) y espera la fila
      traslado = trasladar(v, destino)
      await esperarBloqueadosPor(pidArea) // el traslado toma las organizaciones FOR NO KEY UPDATE y espera A
    } finally {
      fila.soltar()
      await Promise.allSettled([fila.tx, escritura, traslado])
    }
    expect((await escritura!).error).toBeUndefined()
    expect(await traslado).toEqual({ status: 200 })
    expect(await prisma.area.findUniqueOrThrow({ where: { id: area.id }, select: { name: true } })).toEqual({ name: 'Terraza nueva' })
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: v } })).organizationId).toBe(destino)

    await encenderIvaPorProducto(v)
    await expect(processPosAreaEvent(evento('Otra'))).rejects.toBeInstanceOf(PosRechazadoPorIva)
    expect(await prisma.area.findUniqueOrThrow({ where: { id: area.id }, select: { name: true } })).toEqual({ name: 'Terraza nueva' })
  })
})
