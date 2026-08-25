jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/reservationSettings.service', () => ({
  __esModule: true,
  getReservationSettings: jest.fn(async () => ({ scheduling: { noShowGraceMin: 15 } })),
}))
jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  __esModule: true,
  RESERVATION_INCLUDE: {},
}))
jest.mock('@/services/reservation/createOrderFromReservation', () => ({
  __esModule: true,
  createOrderFromReservation: jest.fn(),
}))
jest.mock('@/utils/serializableRetry', () => ({
  __esModule: true,
  withSerializableRetry: jest.fn((fn: any) => fn({})),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { checkInReservationAndOpenOrder } from '@/services/reservation/checkIn.service'
import { createOrderFromReservation } from '@/services/reservation/createOrderFromReservation'

/**
 * Fase 0.C — wrapper COUNTER: check-in puro en tx + orden TPV fuera de la tx, respuesta PLANA
 * (spec tests 6, 10, 16, 20). Una orden preexistente NO es error.
 */
const NOW = new Date('2026-08-22T18:00:00.000Z')
const cmd = {
  reservationId: 'res-1',
  venueId: 'v1',
  actor: { type: 'HUMAN' as const, staffId: 'staff-1' },
  source: 'POS_ANDROID' as const,
  now: NOW,
}

function armReservation(status = 'CONFIRMED') {
  const row = {
    id: 'res-1',
    venueId: 'v1',
    confirmationCode: 'RES-1',
    status,
    startsAt: NOW,
    statusLog: [],
    productId: 'svc-1',
    productIds: [],
  }
  prismaMock.venue.findUniqueOrThrow.mockResolvedValue({ organizationId: 'org-del-venue' } as any)
  prismaMock.product.findMany.mockResolvedValue([{ id: 'svc-1', name: 'Yoga', price: null, duration: 60 }] as any)
  prismaMock.reservation.findFirst.mockResolvedValue(row as any)
  prismaMock.reservation.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.reservation.findUniqueOrThrow.mockResolvedValue({ ...row, status: 'CHECKED_IN', checkedInAt: NOW } as any)
  prismaMock.activityLog.create.mockResolvedValue({} as any)
}

describe('checkInReservationAndOpenOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    armReservation()
  })

  it('test 16/20: orden nueva → respuesta PLANA con los campos de la reserva en la raíz + services + orderId + orderCreated:true', async () => {
    ;(createOrderFromReservation as jest.Mock).mockResolvedValue({ orderId: 'ord-1', created: true })

    const r = await checkInReservationAndOpenOrder(cmd)

    // Lo que Reservation.kt decodifica: campos en raíz, sin sobre anidado.
    expect(r).toEqual(
      expect.objectContaining({ id: 'res-1', status: 'CHECKED_IN', confirmationCode: 'RES-1', orderId: 'ord-1', orderCreated: true }),
    )
    expect((r as any).reservation).toBeUndefined()
    expect(r.services).toEqual([{ id: 'svc-1', name: 'Yoga', price: null, duration: 60 }])
    expect(r.orderError).toBeUndefined()
    expect(createOrderFromReservation).toHaveBeenCalledWith(expect.anything(), {
      reservationId: 'res-1',
      venueId: 'v1',
      createdByStaffId: 'staff-1',
    })
  })

  it('orden viva preexistente → orderId de la existente, orderCreated:false (NO es error)', async () => {
    ;(createOrderFromReservation as jest.Mock).mockResolvedValue({ orderId: 'ord-old', created: false })
    const r = await checkInReservationAndOpenOrder(cmd)
    expect(r).toEqual(expect.objectContaining({ orderId: 'ord-old', orderCreated: false }))
    expect(r.orderError).toBeUndefined()
  })

  it('test 20: perdedor de carrera (P2002 sobre reservationId) → orderId del ganador releído fuera de tx, orderCreated:false', async () => {
    ;(createOrderFromReservation as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Unique constraint'), { code: 'P2002', meta: { target: 'Order_reservationId_alive_key' } }),
    )
    prismaMock.order.findFirst.mockResolvedValue({ id: 'ord-winner' } as any)

    const r = await checkInReservationAndOpenOrder(cmd)

    expect(r).toEqual(expect.objectContaining({ orderId: 'ord-winner', orderCreated: false }))
    expect(r.orderError).toBeUndefined()
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ reservationId: 'res-1', status: { notIn: ['CANCELLED', 'DELETED'] } }) }),
    )
  })

  it('test 6: la orden falla → 200 plano con orderId:null, orderCreated:false, orderError:ORDER_CREATION_FAILED + ActivityLog ORDER_FROM_RESERVATION_FAILED; el check-in NO se revierte', async () => {
    ;(createOrderFromReservation as jest.Mock).mockRejectedValue(new Error('sales disabled'))

    const r = await checkInReservationAndOpenOrder(cmd)

    expect(r).toEqual(
      expect.objectContaining({ status: 'CHECKED_IN', orderId: null, orderCreated: false, orderError: 'ORDER_CREATION_FAILED' }),
    )
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'ORDER_FROM_RESERVATION_FAILED',
        entityId: 'res-1',
        actorType: 'HUMAN',
        actorStaffId: 'staff-1',
      }),
    })
  })

  it('el check-in puro corre DENTRO de prisma.$transaction y la orden FUERA (withSerializableRetry aparte)', async () => {
    ;(createOrderFromReservation as jest.Mock).mockResolvedValue({ orderId: 'ord-1', created: true })
    await checkInReservationAndOpenOrder(cmd)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    const { withSerializableRetry } = jest.requireMock('@/utils/serializableRetry')
    expect(withSerializableRetry).toHaveBeenCalledTimes(1)
  })

  it('si el check-in puro truena (409), NO se intenta la orden', async () => {
    armReservation('NO_SHOW')
    await expect(checkInReservationAndOpenOrder(cmd)).rejects.toMatchObject({ statusCode: 409 })
    expect(createOrderFromReservation).not.toHaveBeenCalled()
  })
})
