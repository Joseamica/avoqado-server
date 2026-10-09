/**
 * 🔴 DINERO — el shift resuelto antes de la transacción es sólo provisional.
 *
 * La transacción de la orden debe ganar un write-lock condicionado a OPEN antes de guardar
 * Order/Payment. Si el cierre ganó, la venta real sigue sincronizándose sin 409, pero las filas
 * nuevas quedan sin turno y una orden existente conserva exactamente su liga durable previa.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('@/services/pos-sync/posSyncStaff.service', () => ({ posSyncStaffService: { syncPosStaff: jest.fn() } }))
jest.mock('@/services/pos-sync/posSyncTable.service', () => ({ getOrCreatePosTable: jest.fn() }))
jest.mock('@/services/pos-sync/posSyncShift.service', () => ({ getOrCreatePosShift: jest.fn() }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({ socketManager: { broadcastToVenue: jest.fn() } }))
jest.mock('@/services/shared/orderCancelGuard', () => ({ findLiveTerminalCharge: jest.fn().mockResolvedValue(null) }))

import prisma from '@/utils/prismaClient'
import { processPosOrderDeleteEvent, processPosOrderEvent } from '@/services/pos-sync/posSyncOrder.service'
import { socketManager } from '@/communication/sockets/managers/socketManager'
import { SocketEventType } from '@/communication/sockets/types'
import { posSyncStaffService } from '@/services/pos-sync/posSyncStaff.service'
import { getOrCreatePosTable } from '@/services/pos-sync/posSyncTable.service'
import { getOrCreatePosShift } from '@/services/pos-sync/posSyncShift.service'
import { lockTableOrderScope, OrderTableTopologyChanged } from '@/services/shared/tableOrderLock'
import { NotFoundError } from '@/errors/AppError'

const VENUE = 'venue-order-race'
const SHIFT = 'shift-provisional'
const STAFF = 'staff-pos'
const ORDER = 'order-pos'
const CLAIMED_AT = new Date('2026-09-03T21:00:00.000Z')

const m = prisma as any

const payload = {
  venueId: VENUE,
  orderData: {
    externalId: 'INSTANCE:77:123',
    orderNumber: '123',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    subtotal: 100,
    taxAmount: 0,
    discountAmount: 0,
    tipAmount: 10,
    total: 110,
    createdAt: '2026-09-03T21:00:00.001Z',
    completedAt: '2026-09-03T21:00:00.001Z',
    posRawData: { source: 'test' },
  },
  staffData: { externalId: 'staff-ext', name: 'Cajera', pin: null },
  tableData: { externalId: 'table-ext' },
  shiftData: { externalId: 'shift-ext', startTime: '2026-09-03T14:00:00.000Z' },
  payments: [{ amount: 100, tipAmount: 10, methodExternalId: 'EFE', posRawData: { id: 'pay-pos' } }],
  paymentMethodsCatalog: [{ idformadepago: 'EFE', tipo: 1, descripcion: 'EFECTIVO' }],
} as any

function topologySql(query: unknown): string {
  if (Array.isArray(query)) return query.join(' ')
  if (query && typeof query === 'object' && 'strings' in query && Array.isArray(query.strings)) return query.strings.join(' ')
  throw new Error('Unexpected SQL representation in topology fixture')
}

function txWorld() {
  const tx = {
    // Real lock contract: the advisory returns nothing useful; the Order lock returns the row while the classified
    // ORDER is still this venue's.
    $queryRaw: jest.fn(async (_sql: any, ...values: unknown[]): Promise<Array<{ id: string }>> => {
      const sql = topologySql(_sql)
      if (sql.includes('FROM "Venue"')) return [{ id: VENUE }]
      if (sql.includes('FROM "Table"')) return [{ id: 'table-pos' }]
      if (sql.includes('ANY(')) {
        const result = tx.order.findUnique.mock.results[tx.order.findUnique.mock.results.length - 1]
        const row = result && (await result.value)
        return row ? [{ id: row.id }] : []
      }
      return values.includes(ORDER) ? [{ id: ORDER }] : []
    }),
    table: {
      findMany: jest.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id ? [{ id: 'table-pos', number: '12', status: 'AVAILABLE', currentOrderId: null }] : [],
      ),
    },
    shift: { findFirst: jest.fn().mockResolvedValue({ id: SHIFT, status: 'OPEN' }), updateMany: jest.fn() },
    order: {
      findUnique: jest.fn((args: any) => m.order.findUnique(args)),
      findMany: jest.fn(async ({ where }: { where: { id?: { in: string[] } } }): Promise<Record<string, unknown>[]> => {
        const result = tx.order.findUnique.mock.results[tx.order.findUnique.mock.results.length - 1]
        const row = result && (await result.value)
        return row && where.id?.in.includes(row.id) ? [{ ...row, tableId: row.tableId ?? null, createdAt: CLAIMED_AT }] : []
      }),
      // Reread under the lock: the stored row, as long as it keeps this venue and the key it was classified by.
      findFirst: jest.fn(async ({ where }: any) => {
        const row = await m.order.findUnique({ where: { venueId_externalId: { venueId: where.venueId, externalId: where.externalId } } })
        return row && row.id === where.id ? row : null
      }),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    payment: { count: jest.fn().mockResolvedValue(0), create: jest.fn() },
    paymentAllocation: { create: jest.fn().mockResolvedValue({ id: 'allocation' }) },
    venueSettings: { findUnique: jest.fn().mockResolvedValue({ enableShifts: true }) },
    activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-pos' }) },
  }
  m.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx))
  return tx
}

function storedOrder(over: Record<string, unknown> = {}) {
  return {
    id: ORDER,
    venueId: VENUE,
    externalId: payload.orderData.externalId,
    orderNumber: '123',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    source: 'POS',
    shiftId: null,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  m.venue.findUnique.mockResolvedValue({ id: VENUE, organizationId: 'org-pos', feeValue: 0 })
  m.order.findUnique.mockResolvedValue(null)
  m.venueSettings.findUnique.mockResolvedValue({ enableShifts: true })
  ;(posSyncStaffService.syncPosStaff as jest.Mock).mockResolvedValue(STAFF)
  ;(getOrCreatePosTable as jest.Mock).mockResolvedValue('table-pos')
  ;(getOrCreatePosShift as jest.Mock).mockResolvedValue(SHIFT)
})

it('serializa aliases SoftRestaurant :0:/:77: como una sola Order, Payment y asignación', async () => {
  const zeroPayload = {
    ...payload,
    orderData: { ...payload.orderData, externalId: 'INSTANCE:0:123' },
  }
  const realPayload = {
    ...payload,
    orderData: { ...payload.orderData, externalId: 'INSTANCE:77:123' },
  }
  const committed = { orders: [] as any[], payments: [] as any[], allocations: [] as any[] }
  const firstAdvisory = (() => {
    let resolve!: () => void
    return { promise: new Promise<void>(r => (resolve = r)), resolve }
  })()
  const secondAttempt = (() => {
    let resolve!: () => void
    return { promise: new Promise<void>(r => (resolve = r)), resolve }
  })()
  const firstReleased = (() => {
    let resolve!: () => void
    return { promise: new Promise<void>(r => (resolve = r)), resolve }
  })()
  const bothLooked = (() => {
    let resolve!: () => void
    return { promise: new Promise<void>(r => (resolve = r)), resolve }
  })()
  const advisoryKeys: string[] = []
  let lookupCount = 0
  let transactionNumber = 0

  m.$transaction.mockImplementation(async (callback: (tx: any) => Promise<any>) => {
    const transaction = transactionNumber++
    const staged = { orders: [] as any[], payments: [] as any[], allocations: [] as any[] }
    const visibleOrders = () => [...committed.orders, ...staged.orders]
    const tx = {
      $queryRaw: jest.fn(async (_sql: any, ...values: unknown[]) => {
        const sql = topologySql(_sql)
        if (sql.includes('FROM "Venue"')) return [{ id: VENUE }]
        if (sql.includes('FROM "Table"')) return [{ id: 'table-pos' }]
        if (sql.includes('ANY('))
          return visibleOrders()
            .filter(row => values.some(value => Array.isArray(value) && value.includes(row.id)))
            .map(row => ({ id: row.id }))
        const advisoryKey = values.find(value => typeof value === 'string' && value.startsWith('pos-order:')) as string | undefined
        if (!advisoryKey) {
          // Order row lock (`id`, `venueId`): a row while the order is visible for this venue.
          const [orderId, lockVenueId] = values
          return visibleOrders().some(order => order.id === orderId && order.venueId === lockVenueId) ? [{ id: orderId }] : []
        }
        advisoryKeys[transaction] = advisoryKey
        if (transaction === 0) {
          firstAdvisory.resolve()
          await secondAttempt.promise
        } else {
          secondAttempt.resolve()
          if (advisoryKeys[0] === advisoryKey) await firstReleased.promise
        }
        return []
      }),
      table: {
        findMany: jest.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
          where.id ? [{ id: 'table-pos', number: '12', status: 'AVAILABLE', currentOrderId: null }] : [],
        ),
      },
      shift: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ id: SHIFT, status: 'OPEN' }),
      },
      order: {
        findMany: jest.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
          visibleOrders()
            .filter(row => where.id?.in.includes(row.id))
            .map(row => ({ ...row, tableId: row.tableId ?? null, createdAt: CLAIMED_AT })),
        ),
        findUnique: jest.fn(async ({ where }: any) => {
          if (advisoryKeys[0] !== advisoryKeys[1]) {
            lookupCount += 1
            if (lookupCount === 2) bothLooked.resolve()
            await bothLooked.promise
          }
          const key = where.venueId_externalId
          return visibleOrders().find(order => order.venueId === key.venueId && order.externalId === key.externalId) ?? null
        }),
        findFirst: jest.fn(
          async ({ where }: any) =>
            visibleOrders().find(
              order => order.id === where.id && order.venueId === where.venueId && order.externalId === where.externalId,
            ) ?? null,
        ),
        upsert: jest.fn(async ({ where, update, create }: any) => {
          const key = where.venueId_externalId
          const existing = visibleOrders().find(order => order.venueId === key.venueId && order.externalId === key.externalId)
          if (existing) return Object.assign(existing, update)
          const row = {
            id: `order-${transaction + 1}`,
            venueId: VENUE,
            shiftId: SHIFT,
            ...create,
            tableId: create.table?.connect?.id ?? null,
          }
          staged.orders.push(row)
          return row
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const source = visibleOrders().find(order => order.id === where.id)!
          const updated = { ...source, ...data, shiftId: source.shiftId ?? SHIFT }
          staged.orders.push(updated)
          return updated
        }),
      },
      payment: {
        count: jest.fn(
          async ({ where }: any) => [...committed.payments, ...staged.payments].filter(payment => payment.orderId === where.orderId).length,
        ),
        create: jest.fn(async ({ data }: any) => {
          const orderId = data.order?.connect?.id ?? data.orderId
          const row = { id: `payment-${transaction + 1}`, orderId, ...data }
          staged.payments.push(row)
          return row
        }),
      },
      paymentAllocation: {
        create: jest.fn(async ({ data }: any) => {
          staged.allocations.push(data)
          return { id: `allocation-${transaction + 1}`, ...data }
        }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: `audit-${transaction + 1}` }) },
    }
    try {
      const result = await callback(tx)
      committed.orders = [...new Map([...committed.orders, ...staged.orders].map(row => [row.id, row])).values()]
      committed.payments.push(...staged.payments)
      committed.allocations.push(...staged.allocations)
      return result
    } finally {
      if (transaction === 0) firstReleased.resolve()
    }
  })

  const first = processPosOrderEvent(zeroPayload as any)
  await firstAdvisory.promise
  const second = processPosOrderEvent(realPayload as any)
  await Promise.all([first, second])

  expect(advisoryKeys[0]).toBe(advisoryKeys[1])
  expect(committed.orders).toHaveLength(1)
  expect(committed.orders[0].externalId).toBe('INSTANCE:77:123')
  expect(committed.payments).toHaveLength(1)
  expect(committed.allocations).toHaveLength(1)
})

it('si close ganó tras resolver OPEN, crea Order y Payment sin turno pero conserva la venta', async () => {
  const tx = txWorld()
  let status = 'OPEN'
  ;(getOrCreatePosShift as jest.Mock).mockImplementationOnce(async () => {
    expect(status).toBe('OPEN')
    const provisional = SHIFT
    // Interleaving del reviewer: el cierre gana y fija su cutoff después de resolver, antes de
    // que la transacción de Order intente el lock.
    status = 'CLOSING'
    return provisional
  })
  tx.shift.updateMany.mockImplementation(async () => {
    return { count: status === 'OPEN' ? 1 : 0 }
  })
  tx.order.upsert.mockResolvedValue(storedOrder())
  tx.payment.create.mockResolvedValue({ id: 'payment-pos', amount: 100 })

  await expect(processPosOrderEvent(payload)).resolves.toMatchObject({ id: ORDER })

  expect(status).toBe('CLOSING')
  expect(new Date(payload.orderData.createdAt).getTime()).toBe(CLAIMED_AT.getTime() + 1)
  expect(tx.shift.updateMany).toHaveBeenCalledWith({
    where: { id: SHIFT, venueId: VENUE, status: 'OPEN', endTime: null },
    data: expect.any(Object),
  })
  expect(tx.shift.updateMany.mock.invocationCallOrder[0]).toBeLessThan(tx.order.upsert.mock.invocationCallOrder[0])
  expect(tx.shift.updateMany.mock.invocationCallOrder[0]).toBeLessThan(tx.payment.create.mock.invocationCallOrder[0])
  expect(tx.order.upsert.mock.calls[0][0].create).not.toHaveProperty('shift')
  expect(tx.payment.create.mock.calls[0][0].data.shift).toBeUndefined()
  expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
  expect(tx.activityLog.create.mock.calls[0][0].data).toMatchObject({
    action: 'PAYMENT_WITHOUT_SHIFT',
    entity: 'Payment',
    entityId: 'payment-pos',
    staffId: STAFF,
    venueId: VENUE,
    data: expect.objectContaining({
      reason: 'CLAIM_LOST',
      channel: 'posSyncOrder',
      amountPesos: '100.00',
      tipPesos: '10.00',
      totalPesos: '110.00',
    }),
  })
})

it('si gana el lock OPEN, Order y Payment nuevos comparten el mismo shift dentro de la transacción', async () => {
  const tx = txWorld()
  tx.shift.updateMany.mockResolvedValue({ count: 1 })
  tx.order.upsert.mockResolvedValue(storedOrder({ shiftId: SHIFT }))
  tx.payment.create.mockResolvedValue({ id: 'payment-pos', amount: 100 })

  await processPosOrderEvent(payload)

  expect(tx.order.upsert.mock.calls[0][0].create.shift).toEqual({ connect: { id: SHIFT } })
  expect(tx.payment.create.mock.calls[0][0].data.shift).toEqual({ connect: { id: SHIFT } })
  expect(tx.activityLog.create).not.toHaveBeenCalled()
})

it('serializa la llave natural y reclasifica dentro de tx si la Order apareció tras la lectura exterior', async () => {
  // Foto exterior: no existía. Antes de la transacción otro request la crea.
  m.order.findUnique.mockResolvedValue(null)
  const existing = storedOrder({ shiftId: null })
  const tx = txWorld()
  tx.order.findUnique.mockResolvedValue(existing)
  tx.order.findFirst.mockResolvedValue(existing)
  tx.shift.updateMany.mockResolvedValue({ count: 1 })
  tx.order.upsert.mockResolvedValue({ ...existing, shiftId: SHIFT })
  tx.payment.create.mockResolvedValue({ id: 'payment-pos', amount: 100 })
  const ops: string[] = []
  tx.$queryRaw.mockImplementation(async (_sql: any, ...values: unknown[]) => {
    const sql = topologySql(_sql)
    if (sql.includes('FROM "Venue"')) return [{ id: VENUE }]
    if (sql.includes('FROM "Table"')) return [{ id: 'table-pos' }]
    if (sql.includes('ANY(')) {
      ops.push('order') // the topology helper's real Order claim is observable too
      return [{ id: ORDER }]
    }
    ops.push(values.includes(ORDER) ? 'order' : 'natural-key')
    return values.includes(ORDER) ? [{ id: ORDER }] : []
  })
  tx.shift.updateMany.mockImplementation(async () => {
    ops.push('shift')
    return { count: 1 }
  })

  await processPosOrderEvent(payload)

  expect(tx.order.findUnique).toHaveBeenCalledWith({
    where: { venueId_externalId: { venueId: VENUE, externalId: payload.orderData.externalId } },
  })
  expect(ops.slice(0, 3)).toEqual(['natural-key', 'order', 'shift'])
  expect(tx.order.upsert.mock.calls[0][0].update.shift).toEqual({ connect: { id: SHIFT } })
})

it('si gana el lock para una Order huérfana existente, liga Order y Payment al mismo shift', async () => {
  const existing = storedOrder({ shiftId: null })
  m.order.findUnique.mockResolvedValue(existing)
  const tx = txWorld()
  tx.shift.updateMany.mockResolvedValue({ count: 1 })
  tx.order.upsert.mockResolvedValue({ ...existing, shiftId: SHIFT })
  tx.payment.create.mockResolvedValue({ id: 'payment-pos', amount: 100 })

  await processPosOrderEvent(payload)

  expect(tx.order.upsert.mock.calls[0][0].update.shift).toEqual({ connect: { id: SHIFT } })
  expect(tx.payment.create.mock.calls[0][0].data.shift).toEqual({ connect: { id: SHIFT } })
})

it('si pierde con una Order existente, no roba/desconecta su liga previa y el Payment nuevo queda null', async () => {
  const existing = storedOrder({ shiftId: 'shift-historico' })
  m.order.findUnique.mockResolvedValue(existing)
  const tx = txWorld()
  tx.shift.updateMany.mockResolvedValue({ count: 0 })
  tx.order.upsert.mockResolvedValue(existing)
  tx.payment.create.mockResolvedValue({ id: 'payment-pos', amount: 100 })

  await processPosOrderEvent(payload)

  expect(tx.order.upsert.mock.calls[0][0].update).not.toHaveProperty('shift')
  expect(tx.payment.create.mock.calls[0][0].data.shift).toBeUndefined()
  expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
})

it('una redelivery con Payment ya existente no duplica la señal', async () => {
  const tx = txWorld()
  tx.shift.updateMany.mockResolvedValue({ count: 0 })
  tx.payment.count.mockResolvedValue(1)
  tx.order.upsert.mockResolvedValue(storedOrder())

  await processPosOrderEvent(payload)

  expect(tx.payment.create).not.toHaveBeenCalled()
  expect(tx.activityLog.create).not.toHaveBeenCalled()
})

it('con turnos apagados el Payment tardío no genera falsa alarma', async () => {
  const tx = txWorld()
  tx.shift.updateMany.mockResolvedValue({ count: 0 })
  m.venueSettings.findUnique.mockResolvedValue({ enableShifts: false })
  tx.order.upsert.mockResolvedValue(storedOrder())
  tx.payment.create.mockResolvedValue({ id: 'payment-pos', amount: 100 })

  await processPosOrderEvent(payload)

  expect(tx.payment.create).toHaveBeenCalledTimes(1)
  expect(tx.activityLog.create).not.toHaveBeenCalled()
})

it('smart resolution no escribe externalId antes de entrar a la transacción/lock', async () => {
  const orphan = storedOrder({ externalId: 'INSTANCE:0:123', shiftId: 'shift-historico' })
  m.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(orphan)
  const tx = txWorld()
  tx.order.findFirst.mockResolvedValue(orphan)
  tx.shift.updateMany.mockResolvedValue({ count: 0 })
  const resolved = { ...orphan, externalId: payload.orderData.externalId }
  m.order.update.mockResolvedValue(resolved)
  tx.order.update.mockResolvedValue(resolved)
  tx.order.upsert.mockResolvedValue(resolved)
  tx.payment.create.mockResolvedValue({ id: 'payment-pos', amount: 100 })

  await processPosOrderEvent(payload)

  expect(m.order.update).not.toHaveBeenCalled()
  expect(tx.shift.updateMany.mock.invocationCallOrder[0]).toBeLessThan(tx.order.update.mock.invocationCallOrder[0])
  expect(tx.order.update.mock.calls[0][0].data).not.toHaveProperty('shift')
  expect(tx.payment.create.mock.calls[0][0].data.shift).toBeUndefined()
})

describe('Plan 3b T6 — the header decides from the Order read under its lock', () => {
  const at = (fn: jest.Mock, index = 0) => fn.mock.invocationCallOrder[index]

  it('rereads the classified Order under its lock and keeps a shift link another writer set while the event waited', async () => {
    const stale = storedOrder({ shiftId: null })
    m.order.findUnique.mockResolvedValue(stale)
    const tx = txWorld()
    tx.shift.updateMany.mockResolvedValue({ count: 1 })
    tx.order.findFirst.mockResolvedValue({ ...stale, shiftId: 'shift-linked-meanwhile' })
    tx.order.upsert.mockResolvedValue({ ...stale, shiftId: 'shift-linked-meanwhile' })
    tx.payment.create.mockResolvedValue({ id: 'payment-pos', amount: 100 })

    await processPosOrderEvent(payload)

    expect(tx.order.findFirst).toHaveBeenCalledWith({ where: { id: ORDER, venueId: VENUE, externalId: payload.orderData.externalId } })
    const orderLock = tx.$queryRaw.mock.calls.findIndex(call =>
      call.some(value => value === ORDER || (Array.isArray(value) && value.includes(ORDER))),
    )
    expect(orderLock).toBeGreaterThanOrEqual(0)
    expect(at(tx.$queryRaw, orderLock)).toBeLessThan(at(tx.order.findFirst))
    expect(at(tx.order.findFirst)).toBeLessThan(at(tx.shift.updateMany))
    // The durable link read under the lock wins over the stale classification: no adoption.
    expect(tx.order.upsert.mock.calls[0][0].update).not.toHaveProperty('shift')
  })

  it('an alias Order that left the venue before the lock is never written by its stale id: the event takes the natural-key upsert', async () => {
    const orphan = storedOrder({ externalId: 'INSTANCE:0:123' })
    m.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(orphan)
    const tx = txWorld()
    tx.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = topologySql(query)
      if (sql.includes('FROM "Venue"')) return [{ id: VENUE }]
      if (sql.includes('FROM "Table"')) return [{ id: 'table-pos' }]
      if (sql.includes('FROM "Order"')) tx.order.findMany.mockResolvedValue([]) // disappearance also persists in the fresh snapshot
      return [] // the classified Order is gone; neither its old id nor its stale alias may be written
    })
    tx.shift.updateMany.mockResolvedValue({ count: 1 })
    tx.order.update.mockResolvedValue({ ...orphan, externalId: payload.orderData.externalId }) // what a stale-id write would return
    tx.order.upsert.mockResolvedValue(storedOrder({ id: 'order-fresh', shiftId: SHIFT }))
    tx.payment.create.mockResolvedValue({ id: 'payment-pos', amount: 100 })

    await expect(processPosOrderEvent(payload)).resolves.toMatchObject({ id: 'order-fresh' })

    expect(tx.order.update).not.toHaveBeenCalled()
    expect(tx.order.findFirst).not.toHaveBeenCalled()
    expect(tx.order.upsert.mock.calls[0][0].where).toEqual({ venueId_externalId: { venueId: VENUE, externalId: 'INSTANCE:77:123' } })
    const tableLock = tx.$queryRaw.mock.calls.findIndex(([query]) => topologySql(query).includes('FROM "Table"'))
    expect(tableLock).toBeGreaterThanOrEqual(0)
    expect(tx.$queryRaw.mock.invocationCallOrder[tableLock]).toBeLessThan(tx.shift.updateMany.mock.invocationCallOrder[0])
    expect(tx.$queryRaw.mock.invocationCallOrder[tableLock]).toBeLessThan(tx.order.upsert.mock.invocationCallOrder[0])
    expect(m.$transaction).toHaveBeenCalledTimes(1)
    expect(socketManager.broadcastToVenue).toHaveBeenCalledWith(
      VENUE,
      SocketEventType.ORDER_CREATED,
      expect.objectContaining({ orderId: 'order-fresh', eventType: 'created' }),
    )
  })

  it('writes the imported header money exactly as received on the natural-key branch (never recomputed)', async () => {
    const money = { subtotal: 100.1, taxAmount: 16.02, discountAmount: 3.33, tipAmount: 7.77, total: 120.56 }
    const existing = storedOrder()
    m.order.findUnique.mockResolvedValue(existing)
    const tx = txWorld()
    tx.shift.updateMany.mockResolvedValue({ count: 1 })
    tx.order.upsert.mockResolvedValue(existing)
    tx.payment.count.mockResolvedValue(1)

    await processPosOrderEvent({ ...payload, orderData: { ...payload.orderData, ...money } })

    expect(tx.order.upsert.mock.calls[0][0].update).toMatchObject(money)
    expect(tx.order.upsert.mock.calls[0][0].create).toMatchObject(money)
  })

  it('writes the imported header money exactly as received on the alias branch (never recomputed)', async () => {
    const money = { subtotal: 100.1, taxAmount: 16.02, discountAmount: 3.33, tipAmount: 7.77, total: 120.56 }
    const orphan = storedOrder({ externalId: 'INSTANCE:0:123' })
    m.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(orphan)
    const tx = txWorld()
    tx.order.findFirst.mockResolvedValue(orphan)
    tx.shift.updateMany.mockResolvedValue({ count: 1 })
    tx.order.update.mockResolvedValue({ ...orphan, externalId: payload.orderData.externalId })
    tx.payment.count.mockResolvedValue(1)

    await processPosOrderEvent({ ...payload, orderData: { ...payload.orderData, ...money } })

    expect(tx.order.update.mock.calls[0][0]).toMatchObject({
      where: { id: ORDER },
      data: { externalId: payload.orderData.externalId, ...money },
    })
  })

  it('a delete whose Order left the venue before the lock marks nothing and announces nothing', async () => {
    m.order.findUnique.mockResolvedValue(storedOrder())
    const tx = txWorld()
    tx.$queryRaw.mockImplementation(async () => [])
    tx.order.update.mockResolvedValue(storedOrder({ status: 'DELETED' })) // what a stale-id write would return

    await expect(
      processPosOrderDeleteEvent({ venueId: VENUE, orderData: { externalId: payload.orderData.externalId } } as any),
    ).resolves.toBeNull()

    expect(tx.order.update).not.toHaveBeenCalled()
    expect(socketManager.broadcastToVenue).not.toHaveBeenCalled()
  })
})

describe('POS optional candidate — only its absence can reduce the reviewed scope', () => {
  const table = { id: 'table-pos', number: '12', status: 'AVAILABLE', currentOrderId: null }
  const candidate = { id: ORDER, tableId: null, status: 'COMPLETED', paymentStatus: 'PAID', createdAt: CLAIMED_AT }
  const sibling = { ...candidate, id: 'sibling-required', tableId: table.id, status: 'PENDING', paymentStatus: 'PENDING' }
  const optionalInput = { venueId: VENUE, orderIds: [ORDER], tableIds: [table.id], optionalOrderId: ORDER }

  function scopeWorld(config: { before: any[]; after?: any[]; returnedIds?: string[]; afterTable?: any }) {
    let claimed = false
    const ops: string[] = []
    const visible = () => (claimed ? (config.after ?? config.before) : config.before)
    const visibleTable = () => (claimed ? (config.afterTable ?? table) : table)
    const tx = {
      $queryRaw: jest.fn(async (query: unknown, ...values: unknown[]) => {
        const sql = topologySql(query)
        if (sql.includes('FROM "Venue"')) {
          ops.push('venue')
          return [{ id: VENUE }]
        }
        if (sql.includes('FROM "Order"')) {
          ops.push('order')
          const ids = values.find(Array.isArray) as string[]
          claimed = true
          return (config.returnedIds ?? ids).map(id => ({ id }))
        }
        if (sql.includes('FROM "Table"')) {
          ops.push('table')
          claimed = true
          return [{ id: table.id }]
        }
        throw new Error('Unexpected scope query')
      }),
      order: {
        findMany: jest.fn(async ({ where }: any) =>
          visible().filter(row =>
            where.id ? where.id.in.includes(row.id) : where.tableId.in.includes(row.tableId) && !where.status.notIn.includes(row.status),
          ),
        ),
      },
      table: {
        findMany: jest.fn(async ({ where }: any) => {
          const row = visibleTable()
          return where.id ? (where.id.in.includes(row.id) ? [row] : []) : where.currentOrderId.in.includes(row.currentOrderId) ? [row] : []
        }),
      },
    }
    return { tx, ops }
  }

  it('accepts only the optional candidate absent before claiming, while retaining its explicit Table scope', async () => {
    const { tx, ops } = scopeWorld({ before: [] })
    await expect(lockTableOrderScope(tx as any, optionalInput)).resolves.toEqual({ venueId: VENUE, tables: [table], orders: [] })
    expect(ops).toEqual(['venue', 'table'])
  })

  it('accepts that one candidate disappearing during the ordered claim and still takes the Table once', async () => {
    const { tx, ops } = scopeWorld({ before: [candidate], after: [], returnedIds: [] })
    await expect(lockTableOrderScope(tx as any, optionalInput)).resolves.toEqual({ venueId: VENUE, tables: [table], orders: [] })
    expect(ops).toEqual(['venue', 'order', 'table'])
    const orderClaim = tx.$queryRaw.mock.calls.find(([query]) => topologySql(query).includes('FROM "Order"'))!
    expect(orderClaim).toContainEqual([ORDER])
  })

  it('preserves strict Order-not-found behavior without the optional input', async () => {
    const { tx, ops } = scopeWorld({ before: [] })
    await expect(lockTableOrderScope(tx as any, { venueId: VENUE, orderIds: [ORDER], tableIds: [table.id] })).rejects.toBeInstanceOf(
      NotFoundError,
    )
    expect(ops).toEqual(['venue'])
  })

  it('preserves strict topology rejection if a required Order disappears during its claim', async () => {
    const { tx, ops } = scopeWorld({ before: [candidate], after: [], returnedIds: [] })
    await expect(lockTableOrderScope(tx as any, { venueId: VENUE, orderIds: [ORDER], tableIds: [table.id] })).rejects.toBeInstanceOf(
      OrderTableTopologyChanged,
    )
    expect(ops).toEqual(['venue', 'order'])
  })

  it('retains the required live sibling when only the optional candidate disappears', async () => {
    const { tx, ops } = scopeWorld({ before: [candidate, sibling], after: [sibling], returnedIds: [sibling.id] })
    await expect(lockTableOrderScope(tx as any, optionalInput)).resolves.toEqual({ venueId: VENUE, tables: [table], orders: [sibling] })
    expect(ops).toEqual(['venue', 'order', 'table'])
    const orderClaim = tx.$queryRaw.mock.calls.find(([query]) => topologySql(query).includes('FROM "Order"'))!
    expect(orderClaim).toContainEqual([ORDER, sibling.id])
  })

  it('cannot waive the required sibling even when the optional candidate was claimed successfully', async () => {
    const { tx, ops } = scopeWorld({ before: [candidate, sibling], after: [candidate], returnedIds: [ORDER] })
    await expect(lockTableOrderScope(tx as any, optionalInput)).rejects.toBeInstanceOf(OrderTableTopologyChanged)
    expect(ops).toEqual(['venue', 'order'])
  })

  it('cannot waive a required live sibling with the optional candidate', async () => {
    const { tx, ops } = scopeWorld({ before: [candidate, sibling], after: [], returnedIds: [] })
    await expect(lockTableOrderScope(tx as any, optionalInput)).rejects.toBeInstanceOf(OrderTableTopologyChanged)
    expect(ops).toEqual(['venue', 'order'])
  })

  it.each([false, true])('rejects an unexpected returned Order ID before Table locks; optional=%s', async optional => {
    const { tx, ops } = scopeWorld({ before: [candidate], returnedIds: ['foreign-order'] })
    const input = optional ? optionalInput : { venueId: VENUE, orderIds: [ORDER], tableIds: [table.id] }
    await expect(lockTableOrderScope(tx as any, input)).rejects.toBeInstanceOf(OrderTableTopologyChanged)
    expect(ops).toEqual(['venue', 'order'])
  })

  it.each([
    ['candidate reappeared', [candidate], table],
    ['new live Order', [sibling], table],
    ['Table status changed', [], { ...table, status: 'CLEANING' }],
    ['Table pointer changed', [sibling], { ...table, currentOrderId: sibling.id }],
  ])('rejects the fresh snapshot when %s, without a second claim pass', async (_label, after, afterTable) => {
    const { tx, ops } = scopeWorld({ before: [candidate], after: after as any[], afterTable, returnedIds: [] })
    await expect(lockTableOrderScope(tx as any, optionalInput)).rejects.toBeInstanceOf(OrderTableTopologyChanged)
    expect(ops).toEqual(['venue', 'order', 'table'])
  })

  it('rejects loss of a Table discovered only through the vanished candidate', async () => {
    const { tx, ops } = scopeWorld({ before: [{ ...candidate, tableId: table.id }], after: [], returnedIds: [] })
    const input = { venueId: VENUE, orderIds: [ORDER], optionalOrderId: ORDER }
    await expect(lockTableOrderScope(tx as any, input)).rejects.toBeInstanceOf(OrderTableTopologyChanged)
    expect(ops).toEqual(['venue', 'order', 'table'])
  })

  it.each([
    { optionalOrderId: 'other-id', orderIds: [ORDER] },
    { optionalOrderId: ORDER, orderIds: [ORDER, 'other-id'] },
    { optionalOrderId: ORDER, orderIds: [ORDER], kdsOrderIds: [ORDER] },
  ])('rejects invalid optional scope %j before any lock', async options => {
    const { tx, ops } = scopeWorld({ before: [candidate] })
    const input = { venueId: VENUE, tableIds: [table.id], ...options }
    await expect(lockTableOrderScope(tx as any, input)).rejects.toBeInstanceOf(RangeError)
    expect(ops).toEqual([])
  })
})
