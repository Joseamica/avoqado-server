/**
 * 🔴 DINERO — un Shift CLOSED exacto es sólo un candidato provisional para pos-sync Order.
 *
 * Este archivo integra el resolver REAL `getOrCreatePosShift` con `processPosOrderEvent`: mockear
 * el resolver escondería precisamente la caída a `shift.create`/P2002 que protege esta regresión.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    shift: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('@/services/pos-sync/posSyncStaff.service', () => ({ posSyncStaffService: { syncPosStaff: jest.fn() } }))
jest.mock('@/services/pos-sync/posSyncTable.service', () => ({ getOrCreatePosTable: jest.fn() }))
jest.mock('@/services/shared/turnoDeCaja', () => ({
  UNICO_TURNO_ABIERTO: { indice: 'Shift_venueId_open_key', columnas: ['venueId'] },
  esChoqueDelUnico: (error: any, unico: any) => {
    if (error?.code !== 'P2002') return false
    const descriptor = error.meta?.constraint ?? error.meta?.target
    if (descriptor === unico.indice) return true
    if (!Array.isArray(descriptor)) return false
    return (
      descriptor.length === unico.columnas.length && descriptor.every((value: string, index: number) => value === unico.columnas[index])
    )
  },
}))
jest.mock('@/services/tpv/shift.tpv.service', () => ({
  aggregateShiftPayments: jest.fn(),
  readShiftPaymentsForClose: jest.fn(),
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({ socketManager: { broadcastToVenue: jest.fn() } }))

import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { processPosOrderEvent } from '@/services/pos-sync/posSyncOrder.service'
import { posSyncStaffService } from '@/services/pos-sync/posSyncStaff.service'
import { getOrCreatePosTable } from '@/services/pos-sync/posSyncTable.service'

const VENUE = 'venue-closed-shift'
const CLOSED_SHIFT = 'shift-signed'
const STAFF = 'staff-pos'
const m = prisma as any

const payload = {
  venueId: VENUE,
  orderData: {
    externalId: 'INSTANCE:88:900',
    orderNumber: '900',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    subtotal: 100,
    taxAmount: 0,
    discountAmount: 0,
    tipAmount: 10,
    total: 110,
    createdAt: '2026-09-04T02:00:00.000Z',
    completedAt: '2026-09-04T02:00:00.000Z',
    posRawData: { source: 'late-pos-event' },
  },
  staffData: { externalId: 'staff-ext', name: 'Cajera', pin: null },
  tableData: { externalId: 'table-ext' },
  shiftData: { externalId: 'WS-SIGNED', startTime: '2026-09-03T14:00:00.000Z' },
  payments: [{ amount: 100, tipAmount: 10, methodExternalId: 'EFE', posRawData: { id: 'late-payment' } }],
  paymentMethodsCatalog: [{ idformadepago: 'EFE', tipo: 1, descripcion: 'EFECTIVO' }],
} as any

function closedShift() {
  return {
    id: CLOSED_SHIFT,
    venueId: VENUE,
    externalId: payload.shiftData.externalId,
    status: 'CLOSED',
    startTime: new Date('2026-09-03T14:00:00.000Z'),
    endTime: new Date('2026-09-03T21:00:00.000Z'),
    updatedAt: new Date('2026-09-03T21:00:00.000Z'),
  }
}

function transactionWorld() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    shift: m.shift,
    order: { findUnique: jest.fn((args: any) => m.order.findUnique(args)), upsert: jest.fn(), update: jest.fn() },
    payment: { count: jest.fn().mockResolvedValue(0), create: jest.fn() },
    paymentAllocation: { create: jest.fn().mockResolvedValue({ id: 'allocation' }) },
    venueSettings: { findUnique: jest.fn().mockResolvedValue({ enableShifts: true }) },
    activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-pos' }) },
  }
  m.shift.updateMany.mockResolvedValue({ count: 0 })
  m.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx))
  return tx
}

const p2002ExternalId = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { modelName: 'Shift', target: ['venueId', 'externalId'] },
  })

function savedOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'order-late',
    venueId: VENUE,
    externalId: payload.orderData.externalId,
    orderNumber: payload.orderData.orderNumber,
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
  m.shift.findFirst.mockImplementation(({ where }: any) =>
    where.id === CLOSED_SHIFT ? Promise.resolve(closedShift()) : Promise.resolve(null),
  )
  m.shift.findUnique.mockResolvedValue(closedShift())
  // El código roto cae hasta aquí y simula el P2002 terminal que mandaría el mensaje a DLQ.
  m.shift.create.mockRejectedValue(Object.assign(new Error('unique venueId/externalId'), { code: 'P2002' }))
  m.order.findUnique.mockResolvedValue(null)
  ;(posSyncStaffService.syncPosStaff as jest.Mock).mockResolvedValue(STAFF)
  ;(getOrCreatePosTable as jest.Mock).mockResolvedValue('table-pos')
})

it('un evento tardío crea Order/Payment sin turno y nunca intenta recrear el Shift CLOSED', async () => {
  const tx = transactionWorld()
  tx.order.upsert.mockResolvedValue(savedOrder())
  tx.payment.create.mockResolvedValue({ id: 'payment-late', amount: 100 })

  await expect(processPosOrderEvent(payload)).resolves.toMatchObject({ id: 'order-late' })

  expect(m.shift.create).not.toHaveBeenCalled()
  expect(tx.shift.updateMany).toHaveBeenCalledWith({
    where: { id: CLOSED_SHIFT, venueId: VENUE, status: 'OPEN', endTime: null },
    data: expect.any(Object),
  })
  expect(tx.order.upsert.mock.calls[0][0].create).not.toHaveProperty('shift')
  expect(tx.payment.create.mock.calls[0][0].data.shift).toBeUndefined()
  expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
  expect(tx.activityLog.create.mock.calls[0][0].data.data).toMatchObject({
    reason: 'SHIFT_NOT_OPEN',
    candidateShiftId: CLOSED_SHIFT,
    observedShiftStatus: 'CLOSED',
  })
})

it('una Order existente conserva su liga durable y el Payment tardío queda sin turno', async () => {
  const existing = savedOrder({ shiftId: 'shift-historico' })
  m.order.findUnique.mockResolvedValue(existing)
  const tx = transactionWorld()
  tx.order.upsert.mockResolvedValue(existing)
  tx.payment.create.mockResolvedValue({ id: 'payment-late', amount: 100 })

  await expect(processPosOrderEvent(payload)).resolves.toBe(existing)

  expect(m.shift.create).not.toHaveBeenCalled()
  expect(tx.order.upsert.mock.calls[0][0].update).not.toHaveProperty('shift')
  expect(tx.payment.create.mock.calls[0][0].data.shift).toBeUndefined()
})

it('null→P2002 compuesto→ganador CLOSED conserva la venta tardía sin turno y no cae a DLQ', async () => {
  const tx = transactionWorld()
  tx.order.upsert.mockResolvedValue(savedOrder())
  tx.payment.create.mockResolvedValue({ id: 'payment-after-race', amount: 100 })
  m.shift.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(closedShift())
  m.shift.create.mockRejectedValueOnce(p2002ExternalId())

  await expect(processPosOrderEvent(payload)).resolves.toMatchObject({ id: 'order-late' })

  expect(m.shift.create).toHaveBeenCalledTimes(1)
  expect(tx.order.upsert.mock.calls[0][0].create).not.toHaveProperty('shift')
  expect(tx.payment.create.mock.calls[0][0].data.shift).toBeUndefined()
})
