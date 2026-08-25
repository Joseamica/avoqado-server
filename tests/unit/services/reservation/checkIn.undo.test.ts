import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

/**
 * Fase 5 · D16 — deshacer un check-in.
 *
 * El kiosco es autoservicio: alguien va a tocar el nombre equivocado. Hoy eso es una
 * puerta de un solo sentido — `CHECKED_IN` no se revierte desde ninguna pantalla, y la
 * clase queda con un asistente que nunca llegó y un ausente marcado como presente.
 *
 * Lo que NO puede hacer el undo es borrar dinero: si el check-in abrió una orden y esa
 * orden ya se cobró, revertir el estado dejaría un cobro colgando de una reserva que
 * dice que nadie vino. Ahí se para y se le dice al negocio por qué.
 */
describe('Fase 5 · deshacer el check-in', () => {
  const actor = { type: 'HUMAN' as const, staffId: 'staff-1' }
  const base = {
    id: 'res-1',
    venueId: 'venue-1',
    status: 'CHECKED_IN',
    confirmationCode: 'ABC123',
    checkedInAt: new Date('2026-08-24T18:00:00Z'),
    statusLog: [
      { status: 'CONFIRMED', at: '2026-08-24T10:00:00Z', by: 'staff-9' },
      { status: 'CHECKED_IN', at: '2026-08-24T18:00:00Z', by: 'staff-1', source: 'KIOSK' },
    ],
  }

  let tx: any
  beforeEach(() => {
    jest.clearAllMocks()
    tx = {
      reservation: {
        findFirst: jest.fn().mockResolvedValue({ ...base }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ...base, status: 'CONFIRMED' }),
      },
      order: { findMany: jest.fn().mockResolvedValue([]) },
      venue: { findUniqueOrThrow: jest.fn().mockResolvedValue({ organizationId: 'org-1' }) },
      activityLog: { create: jest.fn().mockResolvedValue({}) },
    }
  })

  const cmd = () => ({ reservationId: 'res-1', venueId: 'venue-1', actor, source: 'DASHBOARD' as const, now: new Date('2026-08-24T18:05:00Z') })

  it('🔴 devuelve la reserva al estado que tenía ANTES del check-in', async () => {
    const { undoCheckIn } = await import('@/services/reservation/checkIn.service')

    const res = await undoCheckIn(tx, cmd())

    expect(res.outcome).toBe('UNDONE')
    const data = tx.reservation.updateMany.mock.calls[0][0].data
    expect(data.status).toBe('CONFIRMED') // no PENDING inventado: es lo que decía su bitácora
    expect(data.checkedInAt).toBeNull()
  })

  it('🔴 NO deshace si la orden del check-in ya se cobró', async () => {
    tx.order.findMany.mockResolvedValue([{ id: 'ord-1', payments: [{ id: 'pay-1', status: 'COMPLETED' }] }])
    const { undoCheckIn } = await import('@/services/reservation/checkIn.service')

    await expect(undoCheckIn(tx, cmd())).rejects.toThrow(/cobr/i)
    expect(tx.reservation.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 deja rastro de quién lo deshizo y por qué', async () => {
    const { undoCheckIn } = await import('@/services/reservation/checkIn.service')

    await undoCheckIn(tx, { ...cmd(), reason: 'se tocó el nombre equivocado' })

    expect(tx.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'RESERVATION_CHECK_IN_UNDONE', entityId: 'res-1' }),
      }),
    )
    const log = tx.reservation.updateMany.mock.calls[0][0].data.statusLog
    expect(log[log.length - 1]).toEqual(expect.objectContaining({ reason: 'se tocó el nombre equivocado' }))
  })

  it('🔴 repetirlo no truena: ya estaba deshecho', async () => {
    tx.reservation.findFirst.mockResolvedValue({ ...base, status: 'CONFIRMED', checkedInAt: null })
    const { undoCheckIn } = await import('@/services/reservation/checkIn.service')

    const res = await undoCheckIn(tx, cmd())

    expect(res.outcome).toBe('ALREADY_UNDONE')
    expect(tx.reservation.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 no revive una reserva cancelada', async () => {
    tx.reservation.findFirst.mockResolvedValue({ ...base, status: 'CANCELLED' })
    const { undoCheckIn } = await import('@/services/reservation/checkIn.service')

    await expect(undoCheckIn(tx, cmd())).rejects.toThrow()
    expect(tx.reservation.updateMany).not.toHaveBeenCalled()
  })
})
