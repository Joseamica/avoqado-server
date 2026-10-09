import { randomUUID, randomInt } from 'crypto'

// Must precede runtime/product imports; the launcher checks exact owned PG before dotenv.
const testDatabaseUrl = process.env.TEST_DATABASE_URL
let target: URL
try {
  target = new URL(testDatabaseUrl ?? '')
} catch {
  throw new Error('Owned local TEST_DATABASE_URL required; URL withheld')
}
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  !/^\/avoqado_[a-z0-9]+_test_/.test(target.pathname) ||
  process.env.DATABASE_URL !== testDatabaseUrl
) {
  throw new Error('Owned local database and equal DATABASE_URL/TEST_DATABASE_URL required; URL withheld')
}
const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client')
const prisma = (require('@/utils/prismaClient') as typeof import('@/utils/prismaClient')).default
const { assignTable } = require('@/services/tpv/table.tpv.service') as typeof import('@/services/tpv/table.tpv.service')
const { splitOrderItems, splitOrderBySeat } =
  require('@/services/mobile/order.mobile.service') as typeof import('@/services/mobile/order.mobile.service')
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(45_000)
const observer = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}
function evidence(name: string, data: unknown) {
  console.log('TASK6_NATIVE ' + JSON.stringify({ name, data }))
}
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 3000
  while (Date.now() < end) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(r => setTimeout(r, 15))
  }
  throw new Error('INCONCLUSO: required native lock observation absent')
}
async function observeWait(key: number) {
  return eventually(
    async () =>
      (
        await observer.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=${key}::oid AND NOT granted`
      )[0]?.pid,
  )
}
async function observeBlockedBy(pid: number) {
  return eventually(
    async () =>
      (
        await observer.$queryRaw<
          Array<{ pid: number; blockers: number[]; query: string }>
        >`SELECT pid,pg_blocking_pids(pid) blockers,query FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))`
      )[0],
  )
}
async function tableProbe(venueId: string, tableId: string) {
  return observer.$transaction(async tx => {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "Table" WHERE id=${tableId} AND "venueId"=${venueId} FOR KEY SHARE NOWAIT`
    expect(rows).toEqual([{ id: tableId }])
    return true
  })
}
async function fixture() {
  const venueId = `gate6-${randomUUID()}`
  await prisma.organization.create({ data: { id: venueId, name: 'Gate6 fixture', email: `${venueId}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: 'Gate6 fixture', slug: venueId, salesEnabled: true } })
  const staff = await prisma.staff.create({
    data: { email: `${venueId}@staff.test`, firstName: 'Gate6', lastName: 'Fixture', active: true },
  })
  await prisma.staffVenue.create({ data: { venueId, staffId: staff.id, role: 'MANAGER', active: true } })
  const table = await prisma.table.create({
    data: { venueId, number: randomUUID(), capacity: 4, qrCode: randomUUID(), status: 'AVAILABLE' },
  })
  return { venueId, staffId: staff.id, tableId: table.id }
}
async function nativeGate(
  relation: 'Order' | 'Table' | 'Payment',
  timing: 'BEFORE INSERT' | 'AFTER UPDATE' | 'BEFORE INSERT OR UPDATE',
  condition: string,
) {
  const suffix = randomUUID().replace(/-/g, '')
  const fn = `g6_fn_${suffix}`
  const trigger = `g6_tr_${suffix}`
  const key = randomInt(1, 2_000_000_000)
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
  const ready = deferred()
  const release = deferred()
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(${key}::bigint); END IF; RETURN NEW; END $b$`,
  )
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" ${timing} ON "${relation}" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`)
  const hold = holder.$transaction(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`
      ready.resolve()
      await release.promise
    },
    { timeout: 30_000 },
  )
  await Promise.race([
    ready.promise,
    hold.then(() => {
      throw new Error('INCONCLUSO: gate holder ended')
    }),
  ])
  return {
    key,
    release: release.resolve,
    async cleanup(pending: Promise<unknown>[]) {
      release.resolve()
      await Promise.allSettled([hold, ...pending])
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "${relation}"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`)
      await holder.$disconnect()
    },
  }
}
afterAll(async () => {
  await observer.$disconnect()
  await prisma.$disconnect()
})

describe('Task6 native composed table/order locks', () => {
  it.each(['items', 'seat'] as const)('admission waits for the %s split Order without retaining an incompatible Table lock', async mode => {
    const f = await fixture()
    const source = await prisma.order.create({
      data: {
        venueId: f.venueId,
        tableId: f.tableId,
        orderNumber: randomUUID(),
        servedById: f.staffId,
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        remainingBalance: 100,
        contratoDePrecio: 'IVA_INCLUIDO',
        items: {
          create: [
            { productName: 'First', quantity: 1, unitPrice: 50, total: 50, taxAmount: 0, seat: 1 },
            { productName: 'Second', quantity: 1, unitPrice: 50, total: 50, taxAmount: 0, seat: 2 },
          ],
        },
      },
      include: { items: true },
    })
    await prisma.table.update({ where: { id: f.tableId }, data: { currentOrderId: source.id } })
    const gate = await nativeGate('Order', 'BEFORE INSERT', `NEW."tableId"='${f.tableId}' AND NEW.id<>'${source.id}'`)
    const pending: Promise<unknown>[] = []
    try {
      const split =
        mode === 'items'
          ? splitOrderItems(f.venueId, source.id, [source.items[1].id], f.staffId)
          : splitOrderBySeat(f.venueId, source.id, f.staffId)
      pending.push(split)
      void split.catch(() => undefined)
      const splitPid = await observeWait(gate.key)
      const admission = assignTable(f.venueId, f.tableId, f.staffId, 2)
      pending.push(admission)
      void admission.catch(() => undefined)
      const waiter = await observeBlockedBy(splitPid)
      evidence(`split-${mode}-wait`, { ...f, sourceId: source.id, splitPid, waiter })
      let probe: unknown
      try {
        probe = await tableProbe(f.venueId, f.tableId)
      } catch (error) {
        probe = { code: (error as { code?: string }).code, message: String(error) }
      }
      evidence(`split-${mode}-table-key-share`, { probe })
      expect(probe).toBe(true)
      gate.release()
      await split
      const result = await admission.then(
        value => ({ value }),
        error => ({ error: String(error) }),
      )
      if ('error' in result) expect(result.error).toContain('ORDER_TABLE_TOPOLOGY_CHANGED')
      expect(await prisma.orderItem.count({ where: { order: { venueId: f.venueId } } })).toBe(2)
      expect(await prisma.order.count({ where: { venueId: f.venueId } })).toBe(2)
    } finally {
      await gate.cleanup(pending)
    }
  })
})

const { payCashOrder } = require('@/services/mobile/order.mobile.service') as typeof import('@/services/mobile/order.mobile.service')
const { createOrderWithItems: createTpvOrder } =
  require('@/services/tpv/order.tpv.service') as typeof import('@/services/tpv/order.tpv.service')
const { createManualPayment } =
  require('@/services/dashboard/manualPayment.service') as typeof import('@/services/dashboard/manualPayment.service')
async function openShift(f: Awaited<ReturnType<typeof fixture>>) {
  return prisma.shift.create({ data: { venueId: f.venueId, staffId: f.staffId, startTime: new Date(), status: 'OPEN' } })
}
async function shiftProbe(venueId: string, shiftId: string) {
  return observer.$transaction(async tx => {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "Shift" WHERE id=${shiftId} AND "venueId"=${venueId} FOR UPDATE NOWAIT`
    expect(rows).toEqual([{ id: shiftId }])
    return true
  })
}
function freeCart(f: Awaited<ReturnType<typeof fixture>>) {
  return createTpvOrder(f.venueId, {
    staffId: f.staffId,
    tableId: f.tableId,
    externalId: randomUUID(),
    source: 'TPV',
    orderType: 'DINE_IN',
    items: [{ name: 'Gate6 zero', quantity: 1, unitPrice: 0 }],
    subtotal: 0,
    total: 0,
    taxAmount: 0,
    tip: 0,
    discount: 0,
  })
}
function shadow(f: Awaited<ReturnType<typeof fixture>>, key: string) {
  return createManualPayment(f.venueId, f.staffId, {
    amount: '100.00',
    tipAmount: '0',
    method: 'BANK_TRANSFER',
    source: 'POS',
    tableId: f.tableId,
    idempotencyKey: key,
  })
}
describe('Task6 native Shift and actual pointer promotion', () => {
  it.each(['assign', 'free-cart', 'simple-tpv', 'mobile', 'reservation', 'check-in', 'pos'] as const)(
    '%s waits for existing Order before any Shift claim',
    async creator => {
      const f = await fixture()
      const shift = await openShift(f)
      const reservation = creator === 'reservation' || creator === 'check-in' ? await reservationFixture(f) : null
      if (creator === 'pos') {
        await prisma.staffVenue.update({
          where: { staffId_venueId: { staffId: f.staffId, venueId: f.venueId } },
          data: { posStaffId: 'gate6-staff' },
        })
        await prisma.shift.update({ where: { id: shift.id }, data: { externalId: 'gate6-shift' } })
      }
      const source = await prisma.order.create({
        data: {
          venueId: f.venueId,
          tableId: f.tableId,
          shiftId: shift.id,
          orderNumber: randomUUID(),
          servedById: f.staffId,
          createdById: f.staffId,
          status: 'PENDING',
          paymentStatus: 'PARTIAL',
          subtotal: 100,
          total: 100,
          taxAmount: 0,
          paidAmount: 40,
          remainingBalance: 60,
          version: 1,
          contratoDePrecio: 'IVA_INCLUIDO',
          items: { create: { productName: 'Gate6 amount', quantity: 1, unitPrice: 100, total: 100, taxAmount: 0 } },
        },
      })
      await prisma.payment.create({
        data: {
          venueId: f.venueId,
          orderId: source.id,
          shiftId: shift.id,
          processedById: f.staffId,
          amount: 40,
          tipAmount: 0,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: 40,
          method: 'CASH',
          source: 'APP',
          status: 'COMPLETED',
          type: 'REGULAR',
        },
      })
      await prisma.shift.update({ where: { id: shift.id }, data: { totalSales: 40, totalOrders: 1 } })
      await prisma.table.update({ where: { id: f.tableId }, data: { currentOrderId: source.id } })
      const gate = await nativeGate(
        'Order',
        'AFTER UPDATE',
        `NEW.id='${source.id}' AND NEW."venueId"='${f.venueId}' AND NEW.version=OLD.version+1 AND NEW."paymentStatus"='PARTIAL' AND OLD."paymentStatus"='PARTIAL'`,
      )
      const pending: Promise<unknown>[] = []
      const tracing = traceNativeTransactions()
      try {
        const payment = payCashOrder(f.venueId, source.id, {
          amount: 2000,
          tip: 0,
          staffId: f.staffId,
          method: 'CASH',
          idempotencyKey: randomUUID(),
        })
        pending.push(payment)
        void payment.catch(() => undefined)
        const paymentPid = await observeWait(gate.key)
        expect(await shiftProbe(f.venueId, shift.id)).toBe(true)
        evidence(`payment-${creator}-control0`, { paymentPid, shiftId: shift.id })
        const created =
          creator === 'assign'
            ? assignTable(f.venueId, f.tableId, f.staffId, 2)
            : creator === 'free-cart'
              ? freeCart(f)
              : creator === 'simple-tpv'
                ? createSimpleTpvOrder(f.venueId, { tableId: f.tableId, waiterId: f.staffId })
                : creator === 'mobile'
                  ? createMobileOrder(f.venueId, {
                      tableId: f.tableId,
                      staffId: f.staffId,
                      externalId: randomUUID(),
                      items: [{ name: 'Gate6 mobile', unitPrice: 10000, quantity: 1 }],
                    })
                  : creator === 'reservation'
                    ? prisma.$transaction(tx =>
                        createOrderFromReservation(tx, { venueId: f.venueId, reservationId: reservation!.id, createdByStaffId: f.staffId }),
                      )
                    : creator === 'check-in'
                      ? checkInReservationAndOpenOrder({
                          venueId: f.venueId,
                          reservationId: reservation!.id,
                          actor: { type: 'HUMAN', staffId: f.staffId },
                          source: 'POS_IOS',
                          now: new Date(),
                        })
                      : processPosOrderEvent({
                          venueId: f.venueId,
                          orderData: {
                            externalId: `gate6:1:${randomUUID()}`,
                            orderNumber: randomUUID(),
                            status: 'PENDING',
                            paymentStatus: 'PENDING',
                            subtotal: 100,
                            total: 100,
                            taxAmount: 0,
                            discountAmount: 0,
                            tipAmount: 0,
                            createdAt: new Date().toISOString(),
                            completedAt: null,
                            posRawData: { test: 'gate6' },
                          },
                          staffData: { externalId: 'gate6-staff', name: 'Gate6', pin: null },
                          tableData: { externalId: (await prisma.table.findUniqueOrThrow({ where: { id: f.tableId } })).number },
                          shiftData: { externalId: 'gate6-shift', startTime: null },
                          payments: [],
                          paymentMethodsCatalog: [],
                        })
        pending.push(created)
        void created.catch(() => undefined)
        const waiter = await observeBlockedBy(paymentPid)
        const secondAdmission = creator === 'assign' ? assignTable(f.venueId, f.tableId, f.staffId, 2) : null
        if (secondAdmission) {
          pending.push(secondAdmission)
          void secondAdmission.catch(() => undefined)
          const secondWait = await admissionWait(f.venueId, f.tableId, waiter.pid)
          evidence('payment-assign-second-advisory', { paymentPid, firstWait: waiter, secondWait })
        }
        expect(await shiftProbe(f.venueId, shift.id)).toBe(true)
        const tableAvailable = await tableProbe(f.venueId, f.tableId)
        const nativeLocks = await observer.$queryRaw<
          Array<{ pid: number; locktype: string; mode: string; granted: boolean }>
        >`SELECT pid,locktype,mode,granted FROM pg_locks WHERE pid=ANY(${[paymentPid, waiter.pid]}::int[]) ORDER BY pid,locktype,mode`
        evidence(`payment-${creator}-control1`, { paymentPid, waiter, shiftId: shift.id, tableAvailable, nativeLocks })
        gate.release()
        await payment
        const createdResult = await created
        if (secondAdmission) {
          const secondResult = await secondAdmission
          expect(createdResult).toMatchObject({ order: { id: secondResult.order.id } })
          expect(secondResult.isNewOrder).toBe(false)
        }
        if (creator === 'check-in') expect(createdResult).toMatchObject({ orderCreated: true, orderId: expect.any(String) })
        if (creator === 'reservation') expect(createdResult).toMatchObject({ created: true, orderId: expect.any(String) })
        const current = await prisma.order.findUniqueOrThrow({ where: { id: source.id } })
        expect(Number(current.paidAmount)).toBe(60)
        expect(Number(current.remainingBalance)).toBe(40)
        expect(current.paymentStatus).toBe('PARTIAL')
        expect(await prisma.payment.count({ where: { venueId: f.venueId, orderId: source.id, status: 'COMPLETED' } })).toBe(2)
        const actualShift = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })
        expect(Number(actualShift.totalSales)).toBe(60)
        expect(actualShift.totalOrders).toBe(creator === 'free-cart' ? 2 : 1)
        const creatorTrace = tracing.traces.find(trace => trace.some(entry => entry.includes('id=ANY') && entry.includes('FROM "Order"')))!
        expect(creatorTrace).toBeDefined()
        const orderLock = creatorTrace.findIndex(entry => entry.includes('id=ANY'))
        expect(creatorTrace.slice(0, orderLock).filter(entry => /^shift\.(update|create|upsert|delete)/.test(entry))).toEqual([])
        evidence(`payment-${creator}-native-call-trace`, { creatorTrace, orderLock })
      } finally {
        await gate.cleanup(pending)
        tracing.restore()
      }
    },
  )
  it('actual currentOrderId UPDATE promotes Table lock; FK shadow waits while writer can commit', async () => {
    const f = await fixture()
    const shift = await openShift(f)
    const gate = await nativeGate(
      'Table',
      'AFTER UPDATE',
      `NEW.id='${f.tableId}' AND NEW."currentOrderId" IS NOT NULL AND NEW."currentOrderId" IS DISTINCT FROM OLD."currentOrderId"`,
    )
    const pending: Promise<unknown>[] = []
    const tracing = traceNativeTransactions()
    try {
      const admission = assignTable(f.venueId, f.tableId, f.staffId, 2)
      pending.push(admission)
      void admission.catch(() => undefined)
      const writerPid = await observeWait(gate.key)
      await expect(tableProbe(f.venueId, f.tableId)).rejects.toMatchObject({
        code: 'P2010',
        meta: expect.objectContaining({ code: '55P03' }),
      })
      const payment = shadow(f, randomUUID())
      pending.push(payment)
      void payment.catch(() => undefined)
      const waiter = await observeBlockedBy(writerPid)
      await expect(shiftProbe(f.venueId, shift.id)).rejects.toMatchObject({
        code: 'P2010',
        meta: expect.objectContaining({ code: '55P03' }),
      })
      evidence('pointer-promoted-shadow-fk-wait', { ...f, writerPid, waiter })
      gate.release()
      const assigned = await admission
      await payment
      const table = await prisma.table.findUniqueOrThrow({ where: { id: f.tableId } })
      expect(table.currentOrderId).toBe(assigned.order.id)
      expect(table.status).toBe('OCCUPIED')
      const writerTrace = tracing.traces.find(trace => trace.some(entry => entry === 'table.update'))!
      expect(writerTrace).toBeDefined()
      const promotion = writerTrace.indexOf('table.update')
      expect(
        writerTrace
          .slice(promotion + 1)
          .filter(entry => /^(order|shift)\.(create|update|upsert|delete)/.test(entry) || /FOR UPDATE|FOR NO KEY UPDATE/.test(entry)),
      ).toEqual([])
      evidence('pointer-writer-native-call-trace', { writerPid, writerTrace, promotion })
      const paid = await prisma.order.findFirstOrThrow({ where: { venueId: f.venueId, type: 'MANUAL_ENTRY' } })
      expect(paid).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID', tableId: f.tableId })
      expect(await prisma.orderItem.count({ where: { orderId: paid.id } })).toBe(0)
    } finally {
      await gate.cleanup(pending)
      tracing.restore()
    }
  })
})

const { lockTableOrderScope, OrderTableTopologyChanged } =
  require('@/services/shared/tableOrderLock') as typeof import('@/services/shared/tableOrderLock')
const { createOrder: createSimpleTpvOrder } =
  require('@/services/tpv/order.tpv.service') as typeof import('@/services/tpv/order.tpv.service')
const { updateOrder: updateDashboardOrder } =
  require('@/services/dashboard/order.dashboard.service') as typeof import('@/services/dashboard/order.dashboard.service')
async function accountFor(
  f: Awaited<ReturnType<typeof fixture>>,
  tableId: string | null = f.tableId,
  status: 'PENDING' | 'COMPLETED' = 'PENDING',
) {
  return prisma.order.create({
    data: {
      venueId: f.venueId,
      tableId,
      orderNumber: randomUUID(),
      servedById: f.staffId,
      status,
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      remainingBalance: 100,
      contratoDePrecio: 'IVA_INCLUIDO',
    },
  })
}
async function extraTable(f: Awaited<ReturnType<typeof fixture>>) {
  return prisma.table.create({ data: { venueId: f.venueId, number: randomUUID(), capacity: 4, qrCode: randomUUID() } })
}

describe('Task6 complete snapshots and pointer compatibility', () => {
  it('paid shadow FK remains compatible with creator NKU until its Shift claim completes', async () => {
    const f = await fixture()
    const shift = await openShift(f)
    const key = randomUUID()
    const gate = await nativeGate(
      'Payment',
      'BEFORE INSERT',
      `NEW."venueId"='${f.venueId}' AND NEW."idempotencyKey"='${key}' AND NEW."processorData"->>'shadowOrder'='true'`,
    )
    const pending: Promise<unknown>[] = []
    try {
      const paid = shadow(f, key)
      pending.push(paid)
      void paid.catch(() => undefined)
      const shadowPid = await observeWait(gate.key)
      await expect(shiftProbe(f.venueId, shift.id)).rejects.toMatchObject({
        code: 'P2010',
        meta: expect.objectContaining({ code: '55P03' }),
      })
      expect(await tableProbe(f.venueId, f.tableId)).toBe(true)
      const free = freeCart(f)
      pending.push(free)
      void free.catch(() => undefined)
      const creator = await observeBlockedBy(shadowPid)
      expect(creator.query).toContain('"Shift"')
      const pointer = assignTable(f.venueId, f.tableId, f.staffId, 2)
      pending.push(pointer)
      void pointer.catch(() => undefined)
      const writer = await observeBlockedBy(creator.pid)
      expect(await tableProbe(f.venueId, f.tableId)).toBe(true)
      evidence('shadow-creator-pointer-chain', { ...f, shadowPid, creator, writer })
      gate.release()
      await paid
      await free
      const assigned = await pointer
      const table = await prisma.table.findUniqueOrThrow({ where: { id: f.tableId } })
      expect(table.currentOrderId).toBe(assigned.order.id)
      const actual = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })
      expect(Number(actual.totalSales)).toBe(100)
      expect(actual.totalOrders).toBe(2)
      const payment = await prisma.payment.findFirstOrThrow({ where: { venueId: f.venueId, idempotencyKey: key } })
      expect(await prisma.paymentAllocation.count({ where: { paymentId: payment.id } })).toBe(1)
      expect(await prisma.venueTransaction.count({ where: { paymentId: payment.id } })).toBe(1)
    } finally {
      await gate.cleanup(pending)
    }
  })
  it.each([101, 501, 1001])('captures and locks all %i participants, including a closed discordant pointer', async count => {
    const f = await fixture()
    const other = await extraTable(f)
    const ids = Array.from({ length: count - 1 }, () => randomUUID())
    for (let start = 0; start < ids.length; start += 100)
      await prisma.order.createMany({
        data: ids.slice(start, start + 100).map(id => ({
          id,
          venueId: f.venueId,
          tableId: f.tableId,
          orderNumber: randomUUID(),
          subtotal: 100,
          total: 100,
          taxAmount: 0,
          remainingBalance: 100,
          contratoDePrecio: 'IVA_INCLUIDO' as const,
        })),
      })
    const closed = await accountFor(f, other.id, 'COMPLETED')
    await prisma.table.update({ where: { id: f.tableId }, data: { currentOrderId: closed.id } })
    const scope = await prisma.$transaction(tx => lockTableOrderScope(tx, { venueId: f.venueId, orderIds: [], tableIds: [f.tableId] }), {
      timeout: 15000,
    })
    expect(scope.orders).toHaveLength(count)
    expect(scope.orders.map(o => o.id).sort()).toEqual([...ids, closed.id].sort())
    const plan =
      await observer.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id,"tableId",status,"paymentStatus","createdAt" FROM "Order" WHERE "venueId"=${f.venueId} AND "tableId"=${f.tableId} AND status NOT IN ('COMPLETED','CANCELLED','DELETED') ORDER BY id LIMIT 100`
    evidence(`snapshot-${count}`, { capturedIds: scope.orders.map(o => o.id), plan })
  })
  it('an unrelated table admission in the same venue progresses while another Table is locked', async () => {
    const f = await fixture()
    const other = await extraTable(f)
    const held = deferred()
    const release = deferred()
    const block = observer.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Table" WHERE id=${f.tableId} FOR UPDATE`
        held.resolve()
        await release.promise
      },
      { timeout: 15000 },
    )
    try {
      await held.promise
      const result = await assignTable(f.venueId, other.id, f.staffId, 2)
      expect(result.isNewOrder).toBe(true)
      evidence('unrelated-table-progress', { held: f.tableId, completed: other.id, orderId: result.order.id })
    } finally {
      release.resolve()
      await block
    }
  })
  it.each(['T1-T2', 'null-T', 'T-null', 'reopen', 'discordant-pointer', 'new101st'] as const)(
    'stale original discovery aborts %s without acquiring new participants',
    async mutation => {
      const f = await fixture()
      const other = await extraTable(f)
      const source = await accountFor(f, mutation === 'null-T' ? null : f.tableId, mutation === 'reopen' ? 'COMPLETED' : 'PENDING')
      const newMember = mutation === 'reopen' ? source : await accountFor(f, null)
      if (mutation === 'new101st') {
        await prisma.order.update({ where: { id: source.id }, data: { tableId: null } })
        await prisma.order.createMany({
          data: Array.from({ length: 100 }, (_, i) => ({
            id: `z-${randomUUID()}-${i}`,
            venueId: f.venueId,
            tableId: f.tableId,
            orderNumber: randomUUID(),
            subtotal: 100,
            total: 100,
            taxAmount: 0,
            remainingBalance: 100,
            contratoDePrecio: 'IVA_INCLUIDO' as const,
          })),
        })
      }
      const key = randomInt(1, 2_000_000_000)
      const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
      const held = deferred()
      const release = deferred()
      const hold = holder.$transaction(
        async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`
          held.resolve()
          await release.promise
        },
        { timeout: 15000 },
      )
      await held.promise
      let intercepted = false
      let originalIds: string[] = []
      const scopeInput = {
        venueId: f.venueId,
        orderIds: mutation === 'new101st' || mutation === 'reopen' || mutation === 'discordant-pointer' ? [] : [source.id],
        tableIds: [f.tableId],
      }
      const attempt = prisma.$transaction(
        async tx => {
          const proxy = new Proxy(tx, {
            get(target, prop) {
              if (prop !== 'order') return Reflect.get(target, prop)
              return new Proxy(target.order, {
                get(order, method) {
                  if (method !== 'findMany') return Reflect.get(order, method)
                  return async (args: Parameters<typeof tx.order.findMany>[0]) => {
                    const rows = await tx.order.findMany(args)
                    if (!intercepted) {
                      intercepted = true
                      originalIds = rows.map(o => o.id)
                      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`
                    }
                    return rows
                  }
                },
              })
            },
          })
          await lockTableOrderScope(proxy, scopeInput)
          await tx.table.update({ where: { id: f.tableId }, data: { number: 'MUST-ROLL-BACK' } })
        },
        { timeout: 15000 },
      )
      void attempt.catch(() => undefined)
      try {
        const pid = await observeWait(key)
        if (mutation === 'new101st') await createSimpleTpvOrder(f.venueId, { tableId: f.tableId, waiterId: f.staffId })
        else if (mutation === 'discordant-pointer')
          await prisma.table.update({ where: { id: f.tableId }, data: { currentOrderId: newMember.id } })
        else
          await updateDashboardOrder(
            f.venueId,
            source.id,
            mutation === 'reopen' ? { status: 'PENDING' } : { tableId: mutation === 'T-null' ? null : other.id },
          )
        release.resolve()
        await expect(attempt).rejects.toBeInstanceOf(OrderTableTopologyChanged)
        expect((await prisma.table.findUniqueOrThrow({ where: { id: f.tableId } })).number).not.toBe('MUST-ROLL-BACK')
        evidence(`stale-${mutation}`, { pid, originalIds, scopeInput })
      } finally {
        release.resolve()
        await Promise.allSettled([hold, attempt])
        await holder.$disconnect()
      }
    },
  )
})

const { processPosOrderEvent } =
  require('@/services/pos-sync/posSyncOrder.service') as typeof import('@/services/pos-sync/posSyncOrder.service')
it('POS initially unbound classification still locks a concurrently joined table sibling', async () => {
  const f = await fixture()
  const externalId = `gate6:1:${randomUUID()}`
  const source = await accountFor(f, null)
  await prisma.order.update({ where: { id: source.id }, data: { externalId } })
  const sibling = await accountFor(f, f.tableId)
  const readKey = randomInt(1, 2_000_000_000)
  const readHolder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
  const readReady = deferred(),
    readRelease = deferred(),
    siblingReady = deferred(),
    siblingRelease = deferred()
  const readHold = readHolder.$transaction(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${readKey}::bigint)`
      readReady.resolve()
      await readRelease.promise
    },
    { timeout: 15000 },
  )
  await readReady.promise
  const realTransaction = prisma.$transaction.bind(prisma)
  let intercepted = false
  const spy = jest.spyOn(prisma, '$transaction')
  spy.mockImplementation((run, options) =>
    realTransaction(async tx => {
      const proxy = new Proxy(tx, {
        get(target, prop) {
          if (prop !== 'order') return Reflect.get(target, prop)
          return new Proxy(target.order, {
            get(order, method) {
              if (method !== 'findUnique') return Reflect.get(order, method)
              return async (args: Parameters<typeof tx.order.findUnique>[0]) => {
                const row = await tx.order.findUnique(args)
                if (!intercepted && args.where.venueId_externalId?.externalId === externalId) {
                  intercepted = true
                  expect(row?.tableId).toBeNull()
                  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${readKey}::bigint)`
                }
                return row
              }
            },
          })
        },
      })
      return run(proxy)
    }, options),
  )
  const pending: Promise<unknown>[] = [readHold]
  try {
    const writer = processPosOrderEvent({
      venueId: f.venueId,
      orderData: {
        externalId,
        orderNumber: externalId,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal: 100,
        total: 100,
        taxAmount: 0,
        discountAmount: 0,
        tipAmount: 0,
        createdAt: new Date().toISOString(),
        completedAt: null,
        posRawData: { test: 'gate6' },
      },
      staffData: { externalId: null, name: null, pin: null },
      tableData: { externalId: null },
      shiftData: { externalId: null, startTime: null },
      payments: [],
      paymentMethodsCatalog: [],
    })
    pending.push(writer)
    void writer.catch(() => undefined)
    const writerPid = await observeWait(readKey)
    await updateDashboardOrder(f.venueId, source.id, { tableId: f.tableId })
    let siblingPid = 0
    const siblingHold = observer.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${sibling.id} FOR UPDATE`
        siblingPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() pid`)[0].pid
        siblingReady.resolve()
        await siblingRelease.promise
      },
      { timeout: 15000 },
    )
    pending.push(siblingHold)
    await siblingReady.promise
    readRelease.resolve()
    const waiter = await observeBlockedBy(siblingPid)
    expect(waiter.pid).toBe(writerPid)
    expect(waiter.query).toContain('ORDER BY id FOR UPDATE')
    expect(await tableProbe(f.venueId, f.tableId)).toBe(true)
    evidence('pos-null-table-sibling', { writerPid, siblingPid, waiter, sourceId: source.id, siblingId: sibling.id })
    siblingRelease.resolve()
    await writer
    expect((await prisma.order.findUniqueOrThrow({ where: { id: source.id } })).tableId).toBe(f.tableId)
  } finally {
    readRelease.resolve()
    siblingRelease.resolve()
    await Promise.allSettled(pending)
    spy.mockRestore()
    await readHolder.$disconnect()
  }
})

const { createOrderWithItems: createMobileOrder } =
  require('@/services/mobile/order.mobile.service') as typeof import('@/services/mobile/order.mobile.service')
const { createOrderFromReservation } =
  require('@/services/reservation/createOrderFromReservation') as typeof import('@/services/reservation/createOrderFromReservation')
const { checkInReservationAndOpenOrder } =
  require('@/services/reservation/checkIn.service') as typeof import('@/services/reservation/checkIn.service')
async function reservationFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const category = await prisma.menuCategory.create({ data: { venueId: f.venueId, name: 'Gate6', slug: randomUUID() } })
  const product = await prisma.product.create({
    data: { venueId: f.venueId, categoryId: category.id, sku: randomUUID(), name: 'Gate6 service', price: 100, type: 'SERVICE' },
  })
  return prisma.reservation.create({
    data: {
      venueId: f.venueId,
      tableId: f.tableId,
      productId: product.id,
      confirmationCode: randomUUID(),
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600000),
      blockedEndsAt: new Date(Date.now() + 3600000),
      duration: 60,
      status: 'CONFIRMED',
      guestName: 'Gate6',
    },
  })
}

const { executeHttpOperation } =
  require('@/services/mobile/http-operation.mobile.service') as typeof import('@/services/mobile/http-operation.mobile.service')
const { processIntents } = require('@/services/mobile/sync.mobile.service') as typeof import('@/services/mobile/sync.mobile.service')
it.each(['http', 'legacy'] as const)('real stale discovery returns %s RETRY without receipt, effect or FIFO continuation', async mode => {
  const f = await fixture()
  await prisma.venue.update({ where: { id: f.venueId }, data: { seatCapExempt: true } })
  const source = await accountFor(f, f.tableId)
  const other = await extraTable(f)
  const firstId = randomUUID(),
    secondId = randomUUID(),
    deviceId = randomUUID()
  const key = randomInt(1, 2_000_000_000)
  const held = deferred(),
    release = deferred()
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
  const hold = holder.$transaction(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`
      held.resolve()
      await release.promise
    },
    { timeout: 15000 },
  )
  await held.promise
  const realTransaction = prisma.$transaction.bind(prisma)
  let intercepted = false,
    effects = 0
  let originalIds: string[] = []
  const spy = jest.spyOn(prisma, '$transaction')
  spy.mockImplementation((run, options) =>
    realTransaction(async tx => {
      const proxy = new Proxy(tx, {
        get(target, prop) {
          if (prop !== 'order') return Reflect.get(target, prop)
          return new Proxy(target.order, {
            get(order, method) {
              if (method !== 'findMany') return Reflect.get(order, method)
              return async (args: Parameters<typeof tx.order.findMany>[0]) => {
                const rows = await tx.order.findMany(args)
                if (!intercepted) {
                  intercepted = true
                  originalIds = rows.map(o => o.id)
                  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`
                }
                return rows
              }
            },
          })
        },
      })
      return run(proxy)
    }, options),
  )
  const writer =
    mode === 'legacy'
      ? processIntents({
          venueId: f.venueId,
          staffId: f.staffId,
          deviceId,
          intents: [
            { id: firstId, type: 'OPEN_TABLE', seq: 1, payload: { tableId: f.tableId } },
            { id: secondId, type: 'OPEN_TABLE', seq: 2, payload: { tableId: other.id } },
          ],
          authorizeIntent: () => true,
        })
      : executeHttpOperation(
          {
            venueId: f.venueId,
            actorId: f.staffId,
            operation: { version: 1, id: firstId, deviceId },
            manifest: {
              action: 'removeServiceCharge',
              refs: { orderId: source.id, orderServiceChargeId: 'unused-after-scope' },
              payload: {},
            },
          },
          async tx => {
            await lockTableOrderScope(tx, { venueId: f.venueId, orderIds: [source.id] })
            effects++
            await tx.table.update({ where: { id: f.tableId }, data: { number: 'MUST-NOT-PUBLISH' } })
            return {
              response: {
                status: 200,
                body: {
                  success: true,
                  data: {
                    subtotal: Number(source.subtotal),
                    total: Number(source.total),
                    version: source.version,
                    discountAmount: Number(source.discountAmount),
                    serviceChargeAmount: Number(source.serviceChargeAmount),
                  },
                },
              },
              affectedRefs: [{ kind: 'Order', id: source.id }],
            }
          },
        )
  void writer.catch(() => undefined)
  try {
    const pid = await observeWait(key)
    await updateDashboardOrder(f.venueId, source.id, { tableId: other.id })
    release.resolve()
    const result = await writer
    if (mode === 'legacy')
      expect(result).toEqual([expect.objectContaining({ id: firstId, status: 'RETRY', errorCode: 'ORDER_TABLE_TOPOLOGY_CHANGED' })])
    else expect(result).toEqual({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
    expect(effects).toBe(0)
    expect(await prisma.posSyncIntent.count({ where: { venueId: f.venueId } })).toBe(0)
    expect(await prisma.order.count({ where: { venueId: f.venueId } })).toBe(1)
    expect((await prisma.table.findUniqueOrThrow({ where: { id: f.tableId } })).number).not.toBe('MUST-NOT-PUBLISH')
    expect((await prisma.table.findUniqueOrThrow({ where: { id: other.id } })).currentOrderId).toBeNull()
    evidence(`topology-${mode}-retry`, { pid, originalIds, result, effects, firstId, secondId })
  } finally {
    release.resolve()
    await Promise.allSettled([hold, writer])
    spy.mockRestore()
    await holder.$disconnect()
  }
})

// Delegate every call to the native client. This records the actual transaction's
// Prisma/SQL call order; it supplies no rows and never substitutes business logic.
function traceNativeTransactions() {
  const traces: string[][] = []
  const realTransaction = prisma.$transaction.bind(prisma)
  const spy = jest.spyOn(prisma, '$transaction')
  spy.mockImplementation((run, options) =>
    realTransaction(async tx => {
      const trace: string[] = []
      traces.push(trace)
      const proxy = new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop)
          if (typeof value === 'function')
            return (...args: unknown[]) => {
              if (String(prop).startsWith('$query') || String(prop).startsWith('$execute')) {
                const query = args[0]
                trace.push(
                  Array.isArray(query)
                    ? query.join('?')
                    : query && typeof query === 'object' && 'sql' in query
                      ? String(query.sql)
                      : String(prop),
                )
              }
              return Reflect.apply(value, target, args)
            }
          if (value && typeof value === 'object')
            return new Proxy(value, {
              get(model, method) {
                const call = Reflect.get(model, method)
                if (typeof call !== 'function') return call
                return (...args: unknown[]) => {
                  trace.push(`${String(prop)}.${String(method)}`)
                  return Reflect.apply(call, model, args)
                }
              },
            })
          return value
        },
      })
      return run(proxy)
    }, options),
  )
  return { traces, restore: () => spy.mockRestore() }
}

it('soft delete leaves closed paid account foreign keys intact and applies its existing unpaid guard', async () => {
  const f = await fixture()
  const paid = await accountFor(f, f.tableId, 'COMPLETED')
  await prisma.order.update({ where: { id: paid.id }, data: { paymentStatus: 'PAID', paidAmount: 100, remainingBalance: 0 } })
  const { deleteTable } = require('@/services/tpv/table.tpv.service') as typeof import('@/services/tpv/table.tpv.service')
  await prisma.table.update({ where: { id: f.tableId }, data: { currentOrderId: paid.id } })
  await deleteTable(f.venueId, f.tableId)
  expect((await prisma.table.findUniqueOrThrow({ where: { id: f.tableId } })).active).toBe(false)
  expect((await prisma.order.findUniqueOrThrow({ where: { id: paid.id } })).tableId).toBe(f.tableId)
  const unpaid = await accountFor(f, f.tableId)
  await prisma.table.update({ where: { id: f.tableId }, data: { active: true, currentOrderId: unpaid.id } })
  await expect(deleteTable(f.venueId, f.tableId)).rejects.toThrow('Cannot delete table with active unpaid order')
  expect((await prisma.table.findUniqueOrThrow({ where: { id: f.tableId } })).active).toBe(true)
})
it('initial missing/foreign explicit participants reject, including a foreign pointer', async () => {
  const f = await fixture(),
    foreign = await fixture()
  const foreignOrder = await accountFor(foreign)
  for (const input of [
    { venueId: f.venueId, orderIds: ['missing'] },
    { venueId: f.venueId, orderIds: [foreignOrder.id] },
    { venueId: f.venueId, orderIds: [], tableIds: ['missing'] },
    { venueId: f.venueId, orderIds: [], tableIds: [foreign.tableId] },
  ])
    await expect(prisma.$transaction(tx => lockTableOrderScope(tx, input))).rejects.toMatchObject({ statusCode: 404 })
  await prisma.table.update({ where: { id: f.tableId }, data: { currentOrderId: foreignOrder.id } })
  await expect(
    prisma.$transaction(tx => lockTableOrderScope(tx, { venueId: f.venueId, orderIds: [], tableIds: [f.tableId] })),
  ).rejects.toMatchObject({ statusCode: 403 })
})

async function admissionWait(venueId: string, tableId: string, blockerPid: number) {
  const identity = JSON.stringify([venueId, tableId])
  return eventually(async () => {
    const rows = await observer.$queryRaw<Array<{ pid: number; blockers: number[]; key: number; classid: number; query: string }>>`
      SELECT l.pid, pg_blocking_pids(l.pid) blockers, hashtext(${identity}) key, l.classid::int classid, a.query
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE l.locktype='advisory' AND l.classid=${7_310_115}::oid
        AND l.objid=(hashtext(${identity})::bigint & 4294967295)::oid AND l.objsubid=2
        AND NOT l.granted AND ${blockerPid}::int=ANY(pg_blocking_pids(l.pid))`
    return rows[0]
  })
}

it.each([false, true])('actual admission advisory serializes the second caller and releases on rollback=%s', async rollback => {
  const f = await fixture()
  const key = randomInt(1, 2_000_000_000)
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
  const ready = deferred(),
    release = deferred()
  const hold = holder.$transaction(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`
      ready.resolve()
      await release.promise
    },
    { timeout: 30_000 },
  )
  await ready.promise
  let intercepted = false
  const traces: string[][] = []
  const real = prisma.$transaction.bind(prisma)
  const spy = jest.spyOn(prisma, '$transaction').mockImplementation((run, options) =>
    real(async tx => {
      const trace: string[] = []
      traces.push(trace)
      return run(
        new Proxy(tx, {
          get(target, prop) {
            if (prop !== '$queryRaw') return Reflect.get(target, prop)
            return async (...args: unknown[]) => {
              const query = args[0]
              const sql = Array.isArray(query) ? query.join('?') : String(query)
              trace.push(sql)
              const rows = await Reflect.apply(tx.$queryRaw, tx, args)
              if (!intercepted && sql.includes('pg_advisory_xact_lock') && args[1] === 7_310_115) {
                intercepted = true
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`
                if (rollback) throw new Error('Gate6 admission rollback')
              }
              return rows
            }
          },
        }),
      )
    }, options),
  )
  const pending: Promise<unknown>[] = []
  try {
    const first = assignTable(f.venueId, f.tableId, f.staffId, 2)
    pending.push(first)
    void first.catch(() => undefined)
    const firstPid = await observeWait(key)
    const second = assignTable(f.venueId, f.tableId, f.staffId, 2)
    pending.push(second)
    void second.catch(() => undefined)
    const waiter = await admissionWait(f.venueId, f.tableId, firstPid)
    expect(traces).toHaveLength(2)
    expect(traces.every(trace => trace.length === 1 && trace[0].includes('pg_advisory_xact_lock'))).toBe(true)
    const lower = await observer.$queryRaw<Array<{ pid: number; relation: string }>>`
      SELECT l.pid,c.relname relation FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=ANY(${[firstPid, waiter.pid]}::int[]) AND c.relname IN ('Venue','Order','Table','Shift')`
    expect(lower).toEqual([])
    evidence('admission-prefix-wait', { rollback, firstPid, waiter, lower, traces: traces.map(trace => [...trace]) })
    release.resolve()
    if (rollback) await expect(first).rejects.toThrow('Gate6 admission rollback')
    const result = await second
    if (!rollback) {
      const original = await first
      expect(result.order.id).toBe(original.order.id)
      expect(original.isNewOrder).toBe(true)
      expect(result.isNewOrder).toBe(false)
    } else expect(result.isNewOrder).toBe(true)
    expect(await prisma.order.count({ where: { venueId: f.venueId } })).toBe(1)
    evidence('admission-prefix-completed', { rollback, orderId: result.order.id })
  } finally {
    release.resolve()
    await Promise.allSettled([hold, ...pending])
    spy.mockRestore()
    await holder.$disconnect()
  }
})

it('actual assign private Order FK waits on Shift while second assign waits on admission and Table accepts KEY SHARE', async () => {
  const f = await fixture()
  const shift = await openShift(f)
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
  const ready = deferred(),
    release = deferred()
  let holderPid = 0
  const hold = holder.$transaction(
    async tx => {
      holderPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() pid`)[0].pid
      await tx.$queryRaw`SELECT id FROM "Shift" WHERE id=${shift.id} FOR UPDATE`
      ready.resolve()
      await release.promise
    },
    { timeout: 30_000 },
  )
  await ready.promise
  const pending: Promise<unknown>[] = []
  try {
    const first = assignTable(f.venueId, f.tableId, f.staffId, 2)
    pending.push(first)
    void first.catch(() => undefined)
    const firstWait = await observeBlockedBy(holderPid)
    expect(firstWait.query).toContain('INSERT INTO "public"."Order"')
    const second = assignTable(f.venueId, f.tableId, f.staffId, 2)
    pending.push(second)
    void second.catch(() => undefined)
    const secondWait = await admissionWait(f.venueId, f.tableId, firstWait.pid)
    expect(await tableProbe(f.venueId, f.tableId)).toBe(true)
    expect((await observer.table.findUniqueOrThrow({ where: { id: f.tableId } })).currentOrderId).toBeNull()
    evidence('admission-shift-fk-chain', { holderPid, firstWait, secondWait, tableKeyShare: true })
    release.resolve()
    const results = await Promise.all([first, second])
    expect(results[0].order.id).toBe(results[1].order.id)
    expect(results.map(r => r.isNewOrder)).toEqual([true, false])
    expect(results[0].order.shiftId).toBe(shift.id)
  } finally {
    release.resolve()
    await Promise.allSettled([hold, ...pending])
    await holder.$disconnect()
  }
})

it('another real assign completes for a distinct table hash while first assign is paused after pointer promotion', async () => {
  const f = await fixture()
  const other = await extraTable(f)
  const keys = await observer.$queryRaw<Array<{ first: number; other: number }>>`
    SELECT hashtext(${JSON.stringify([f.venueId, f.tableId])}) first, hashtext(${JSON.stringify([f.venueId, other.id])}) other`
  expect(keys[0].first).not.toBe(keys[0].other)
  const gate = await nativeGate(
    'Table',
    'AFTER UPDATE',
    `NEW.id='${f.tableId}' AND NEW."currentOrderId" IS DISTINCT FROM OLD."currentOrderId"`,
  )
  const pending: Promise<unknown>[] = []
  try {
    const first = assignTable(f.venueId, f.tableId, f.staffId, 2)
    pending.push(first)
    void first.catch(() => undefined)
    const firstPid = await observeWait(gate.key)
    const otherResult = await assignTable(f.venueId, other.id, f.staffId, 2)
    expect(otherResult.isNewOrder).toBe(true)
    expect(await observeWait(gate.key)).toBe(firstPid)
    evidence('admission-other-table-progress', { firstPid, keys: keys[0], otherOrderId: otherResult.order.id })
    gate.release()
    await first
  } finally {
    await gate.cleanup(pending)
  }
})

it.each(['tpv', 'mobile'] as const)(
  'actual %s HTTP controller returns two concurrent successful openings of the same order',
  async mode => {
    const express = require('express') as typeof import('express')
    const request = require('supertest') as typeof import('supertest')
    const tpv = require('@/controllers/tpv/table.tpv.controller') as typeof import('@/controllers/tpv/table.tpv.controller')
    const mobile = require('@/controllers/mobile/table.mobile.controller') as typeof import('@/controllers/mobile/table.mobile.controller')
    const f = await fixture()
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      Object.assign(req, { authContext: { userId: f.staffId } })
      next()
    })
    const path = mode === 'tpv' ? `/tpv/venues/${f.venueId}/tables/assign` : `/mobile/venues/${f.venueId}/tables/${f.tableId}/open`
    if (mode === 'tpv') app.post('/tpv/venues/:venueId/tables/assign', tpv.assignTable)
    else app.post('/mobile/venues/:venueId/tables/:tableId/open', mobile.openTable)
    const gate = await nativeGate(
      'Table',
      'AFTER UPDATE',
      `NEW.id='${f.tableId}' AND NEW."currentOrderId" IS DISTINCT FROM OLD."currentOrderId"`,
    )
    const pending: Promise<unknown>[] = []
    try {
      const first = request(app)
        .post(path)
        .send({ tableId: f.tableId, covers: 2 })
        .then(response => response)
      pending.push(first)
      const firstPid = await observeWait(gate.key)
      const second = request(app)
        .post(path)
        .send({ tableId: f.tableId, covers: 2 })
        .then(response => response)
      pending.push(second)
      const waiter = await admissionWait(f.venueId, f.tableId, firstPid)
      gate.release()
      const responses = await Promise.all([first, second])
      expect(responses.map(r => r.status)).toEqual(mode === 'tpv' ? [201, 200] : [200, 200])
      expect(responses.map(r => r.body.success)).toEqual([true, true])
      expect(responses.map(r => r.body.data.isNewOrder)).toEqual([true, false])
      expect(responses[0].body.data.order.id).toBe(responses[1].body.data.order.id)
      expect(await prisma.order.count({ where: { venueId: f.venueId } })).toBe(1)
      evidence(`admission-${mode}-http`, { firstPid, waiter, statuses: responses.map(r => r.status), bodies: responses.map(r => r.body) })
    } finally {
      await gate.cleanup(pending)
    }
  },
)

it('real deleteTable and dashboard update preserve exact initial 404 wording and Order before Table precedence', async () => {
  const f = await fixture(),
    foreign = await fixture()
  const own = await accountFor(f),
    foreignOrder = await accountFor(foreign)
  const { deleteTable } = require('@/services/tpv/table.tpv.service') as typeof import('@/services/tpv/table.tpv.service')
  const cases: Array<{ name: string; run: () => Promise<unknown>; message: string }> = [
    { name: 'delete-missing-table', run: () => deleteTable(f.venueId, 'missing-table'), message: `Table not found in venue ${f.venueId}` },
    { name: 'delete-foreign-table', run: () => deleteTable(f.venueId, foreign.tableId), message: `Table not found in venue ${f.venueId}` },
    { name: 'delete-missing-venue', run: () => deleteTable('missing-venue', f.tableId), message: 'Table not found in venue missing-venue' },
    {
      name: 'update-missing-order',
      run: () => updateDashboardOrder(f.venueId, 'missing-order', { tableId: 'missing-table' }),
      message: 'Order with ID missing-order not found in this venue',
    },
    {
      name: 'update-foreign-order',
      run: () => updateDashboardOrder(f.venueId, foreignOrder.id, { tableId: foreign.tableId }),
      message: `Order with ID ${foreignOrder.id} not found in this venue`,
    },
    {
      name: 'update-missing-venue',
      run: () => updateDashboardOrder('missing-venue', own.id, { tableId: f.tableId }),
      message: `Order with ID ${own.id} not found in this venue`,
    },
    {
      name: 'update-missing-table',
      run: () => updateDashboardOrder(f.venueId, own.id, { tableId: 'missing-table' }),
      message: 'Table with ID missing-table not found in this venue',
    },
    {
      name: 'update-foreign-table',
      run: () => updateDashboardOrder(f.venueId, own.id, { tableId: foreign.tableId }),
      message: `Table with ID ${foreign.tableId} not found in this venue`,
    },
  ]
  for (const row of cases) {
    await expect(row.run()).rejects.toMatchObject({ statusCode: 404, message: row.message })
    evidence('wrapper-not-found', { name: row.name, statusCode: 404, message: row.message })
  }
  expect((await prisma.order.findUniqueOrThrow({ where: { id: own.id } })).tableId).toBe(f.tableId)
  expect((await prisma.table.findUniqueOrThrow({ where: { id: f.tableId } })).active).toBe(true)
  expect((await prisma.table.findUniqueOrThrow({ where: { id: foreign.tableId } })).active).toBe(true)
})

it('two real admissions and a later reopening preserve accepted item IDs, ownership, quantities and money in DB and DTO', async () => {
  const f = await fixture()
  const gate = await nativeGate(
    'Table',
    'AFTER UPDATE',
    `NEW.id='${f.tableId}' AND NEW."currentOrderId" IS DISTINCT FROM OLD."currentOrderId"`,
  )
  const pending: Promise<unknown>[] = []
  try {
    const first = assignTable(f.venueId, f.tableId, f.staffId, 2)
    pending.push(first)
    void first.catch(() => undefined)
    const firstPid = await observeWait(gate.key)
    const second = assignTable(f.venueId, f.tableId, f.staffId, 3)
    pending.push(second)
    void second.catch(() => undefined)
    const waiter = await admissionWait(f.venueId, f.tableId, firstPid)
    gate.release()
    const results = await Promise.all([first, second])
    const orderId = results[0].order.id
    expect(results[1].order.id).toBe(orderId)
    expect(results.map(row => row.isNewOrder).filter(Boolean)).toHaveLength(1)
    expect(await prisma.order.count({ where: { venueId: f.venueId, tableId: f.tableId } })).toBe(1)
    const accepted = []
    for (const item of [
      { productName: 'Accepted first', quantity: 2, unitPrice: '12.50', total: '25.00' },
      { productName: 'Accepted second', quantity: 3, unitPrice: '7.25', total: '21.75' },
    ])
      accepted.push(await prisma.orderItem.create({ data: { orderId, ...item, taxAmount: 0 } }))
    const normalize = (item: {
      id: string
      orderId: string
      quantity: number
      unitPrice: { toString(): string }
      total: { toString(): string }
    }) => ({
      id: item.id,
      orderId: item.orderId,
      quantity: item.quantity,
      unitPrice: item.unitPrice.toString(),
      total: item.total.toString(),
    })
    const expected = accepted.map(normalize).sort((a, b) => a.id.localeCompare(b.id))
    const reopened = await assignTable(f.venueId, f.tableId, f.staffId, 2)
    expect(reopened.isNewOrder).toBe(false)
    expect(reopened.order.id).toBe(orderId)
    // assignTable's declared return type is Order; its actual legacy DTO also contains selected items.
    expect(reopened.order).toHaveProperty('items')
    const dto = JSON.parse(JSON.stringify(reopened.order))
    const ids = accepted.map(item => item.id)
    const dtoItems = dto.items
      .filter((item: { id: string }) => ids.includes(item.id))
      .map(normalize)
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id))
    const dbItems = (
      await prisma.orderItem.findMany({
        where: { orderId, id: { in: ids } },
        select: { id: true, orderId: true, quantity: true, unitPrice: true, total: true },
        take: ids.length,
        orderBy: { id: 'asc' },
      })
    ).map(normalize)
    expect(dtoItems).toEqual(expected)
    expect(dbItems).toEqual(expected)
    expect((await prisma.table.findUniqueOrThrow({ where: { id: f.tableId } })).currentOrderId).toBe(orderId)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).tableId).toBe(f.tableId)
    expect(await prisma.order.count({ where: { venueId: f.venueId, tableId: f.tableId } })).toBe(1)
    evidence('admission-accepted-items', { firstPid, waiter, orderId, expected, dtoItems, dbItems })
  } finally {
    await gate.cleanup(pending)
  }
})

it('optional POS candidate deleted during the real Order claim retains only the original Table lock', async () => {
  const f = await fixture()
  const candidate = await accountFor(f, null)
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
  const holderReady = deferred()
  const holderRelease = deferred()
  const scopeReady = deferred()
  const waiterRelease = deferred()
  let holderPid = 0
  let waiterPid = 0
  const claims: Array<{ relation: string; sql: string; boundValues: unknown[]; returnedIds?: string[] }> = []
  let scope: Awaited<ReturnType<typeof lockTableOrderScope>> | undefined
  let waiter: Promise<Awaited<ReturnType<typeof lockTableOrderScope>>> | undefined
  const hold = holder.$transaction(
    async tx => {
      holderPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() pid`)[0].pid
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Order" WHERE id=${candidate.id} FOR UPDATE`
      expect(rows).toEqual([{ id: candidate.id }])
      holderReady.resolve()
      await holderRelease.promise
      await tx.order.delete({ where: { id: candidate.id } })
    },
    { timeout: 30_000 },
  )
  void hold.catch(() => undefined)
  try {
    await Promise.race([
      holderReady.promise,
      hold.then(() => {
        throw new Error('INCONCLUSO: candidate holder ended before readiness')
      }),
    ])
    const input = { venueId: f.venueId, orderIds: [candidate.id], tableIds: [f.tableId], optionalOrderId: candidate.id }
    waiter = prisma.$transaction(
      async tx => {
        waiterPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() pid`)[0].pid
        const proxy = new Proxy(tx, {
          get(target, prop) {
            if (prop !== '$queryRaw') return Reflect.get(target, prop)
            return async (...args: unknown[]) => {
              const query = args[0]
              const sql = Array.isArray(query) ? query.join('?') : ((query as { sql?: string }).sql ?? String(query))
              const relation = sql.match(/FROM "(Venue|Order|Table)"/)?.[1]
              const boundValues = Array.isArray(query) ? args.slice(1) : ((query as { values?: unknown[] }).values ?? [])
              const claim = relation ? { relation, sql, boundValues, returnedIds: undefined as string[] | undefined } : undefined
              if (claim) claims.push(claim)
              const rows = await Reflect.apply(tx.$queryRaw, tx, args)
              if (claim) claim.returnedIds = (rows as Array<{ id: string }>).map(row => row.id)
              return rows
            }
          },
        })
        scope = await lockTableOrderScope(proxy, input)
        scopeReady.resolve()
        await waiterRelease.promise
        return scope
      },
      { timeout: 15_000, maxWait: 5_000 },
    )
    void waiter.catch(() => undefined)
    const blocked = await observeBlockedBy(holderPid)
    expect(blocked.pid).toBe(waiterPid)
    expect(blocked.blockers).toContain(holderPid)
    expect(blocked.query).toContain('FROM "Order"')
    expect(blocked.query).toContain('ORDER BY id FOR UPDATE')
    expect(claims.map(claim => claim.relation)).toEqual(['Venue', 'Order'])
    expect(claims[0].returnedIds).toEqual([f.venueId])
    expect(claims[1].boundValues).toEqual([f.venueId, [candidate.id]])
    expect(claims[1].returnedIds).toBeUndefined()
    expect(await tableProbe(f.venueId, f.tableId)).toBe(true)
    const unlockedTable = await observer.$transaction(
      tx => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Table" WHERE id=${f.tableId} FOR NO KEY UPDATE NOWAIT`,
    )
    expect(unlockedTable).toEqual([{ id: f.tableId }])
    evidence('optional-pos-candidate-real-order-wait', { ...f, candidateId: candidate.id, holderPid, waiterPid, blocked, claims })
    holderRelease.resolve()
    await hold
    await Promise.race([
      scopeReady.promise,
      waiter.then(() => {
        throw new Error('INCONCLUSO: scope waiter ended before readiness')
      }),
    ])
    expect(scope?.orders).toEqual([])
    expect(scope?.tables).toEqual([expect.objectContaining({ id: f.tableId, status: 'AVAILABLE', currentOrderId: null })])
    expect(claims.map(claim => claim.relation)).toEqual(['Venue', 'Order', 'Table'])
    expect(claims[1].returnedIds).toEqual([])
    expect(claims[2].returnedIds).toEqual([f.tableId])
    expect(claims[2].boundValues).toEqual([f.venueId, f.tableId])
    expect(claims[2].sql).toContain('ORDER BY id FOR NO KEY UPDATE')
    expect(await tableProbe(f.venueId, f.tableId)).toBe(true)
    await expect(
      observer.$transaction(tx => tx.$queryRaw`SELECT id FROM "Table" WHERE id=${f.tableId} FOR NO KEY UPDATE NOWAIT`),
    ).rejects.toMatchObject({ code: 'P2010', meta: expect.objectContaining({ code: '55P03' }) })
    expect(await observer.order.findUnique({ where: { id: candidate.id } })).toBeNull()
    evidence('optional-pos-candidate-real-reduced-scope', { ...f, candidateId: candidate.id, holderPid, waiterPid, scope, claims })
    waiterRelease.resolve()
    expect(await waiter).toEqual(scope)
    expect(await observer.table.findUniqueOrThrow({ where: { id: f.tableId } })).toMatchObject({
      status: 'AVAILABLE',
      currentOrderId: null,
    })
  } finally {
    holderRelease.resolve()
    waiterRelease.resolve()
    await Promise.allSettled([hold, ...(waiter ? [waiter] : [])])
    await holder.$disconnect()
  }
})
