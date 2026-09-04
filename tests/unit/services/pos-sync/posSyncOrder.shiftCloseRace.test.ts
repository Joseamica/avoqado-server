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

import prisma from '@/utils/prismaClient'
import { processPosOrderEvent } from '@/services/pos-sync/posSyncOrder.service'
import { posSyncStaffService } from '@/services/pos-sync/posSyncStaff.service'
import { getOrCreatePosTable } from '@/services/pos-sync/posSyncTable.service'
import { getOrCreatePosShift } from '@/services/pos-sync/posSyncShift.service'

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

function txWorld() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    shift: { findFirst: jest.fn().mockResolvedValue({ id: SHIFT, status: 'OPEN' }), updateMany: jest.fn() },
    order: { findUnique: jest.fn((args: any) => m.order.findUnique(args)), upsert: jest.fn(), update: jest.fn() },
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
        const advisoryKey = values.find(value => typeof value === 'string' && value.startsWith('pos-order:')) as string | undefined
        if (!advisoryKey) return []
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
      shift: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ id: SHIFT, status: 'OPEN' }),
      },
      order: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (advisoryKeys[0] !== advisoryKeys[1]) {
            lookupCount += 1
            if (lookupCount === 2) bothLooked.resolve()
            await bothLooked.promise
          }
          const key = where.venueId_externalId
          return visibleOrders().find(order => order.venueId === key.venueId && order.externalId === key.externalId) ?? null
        }),
        upsert: jest.fn(async ({ where, update, create }: any) => {
          const key = where.venueId_externalId
          const existing = visibleOrders().find(order => order.venueId === key.venueId && order.externalId === key.externalId)
          if (existing) return Object.assign(existing, update)
          const row = { id: `order-${transaction + 1}`, venueId: VENUE, shiftId: SHIFT, ...create }
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
  tx.shift.updateMany.mockResolvedValue({ count: 1 })
  tx.order.upsert.mockResolvedValue({ ...existing, shiftId: SHIFT })
  tx.payment.create.mockResolvedValue({ id: 'payment-pos', amount: 100 })
  const ops: string[] = []
  tx.$queryRaw.mockImplementation(async (_sql: any, ...values: unknown[]) => {
    ops.push(values.includes(ORDER) ? 'order' : 'natural-key')
    return []
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
