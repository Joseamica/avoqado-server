import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { cancelPassBookingsOfReplacedOccurrence, ingestBookingCancelled } from '@/services/aggregators/core/bookingIngestion.service'

const logActionMock = logAction as jest.Mock
const NOW = new Date(Date.now() + 3600e3)
const conn = { id: 'c1', venueId: 'v1', provider: 'TOTALPASS' as const }
const ev = { kind: 'BOOKING_CANCELLED' as const, externalBookingId: 'slot-1', late: false, placeId: 'place-1' }
const acceptedBooking = { id: 'b1', reservationId: 'r1', classSessionId: 's1', decision: 'ACCEPTED' }

// Los «Once» que un camino no consume se quedarían para la prueba siguiente: se limpian todos.
beforeEach(() => {
  for (const fn of [
    prismaMock.aggregatorBooking.findUnique,
    prismaMock.aggregatorBooking.update,
    prismaMock.reservation.findFirst,
    prismaMock.reservation.updateMany,
    prismaMock.aggregatorOutbox.findFirst,
    prismaMock.aggregatorOutbox.create,
    prismaMock.aggregatorOutbox.update,
  ])
    fn.mockReset()
})

describe('ingestBookingCancelled', () => {
  // nuevo
  it('cancela la Reservation, deja rastro y libera el lugar', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce(acceptedBooking as any)
    prismaMock.reservation.findFirst.mockResolvedValueOnce({ id: 'r1', status: 'CONFIRMED', statusLog: [] } as any)
    prismaMock.reservation.updateMany.mockResolvedValueOnce({ count: 1 } as any)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
    await expect(ingestBookingCancelled(conn, { ...ev, late: true }, NOW)).resolves.toBe('CANCELLED')
    const upd = prismaMock.reservation.updateMany.mock.calls[0][0]
    expect(upd.where).toMatchObject({ id: 'r1', status: { in: ['PENDING', 'CONFIRMED'] } })
    expect(upd.data.status).toBe('CANCELLED')
    expect(JSON.stringify(upd.data.statusLog)).toContain('late')
    expect(prismaMock.aggregatorBooking.update.mock.calls[0][0].data).toEqual({ decision: 'CANCELLED' })
    expect(prismaMock.aggregatorOutbox.create.mock.calls[0][0].data.operation).toBe('SYNC_SESSION')
  })

  it('llena la cancelación como el dashboard y el renglón de statusLog trae fuente y nota', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce(acceptedBooking as any)
    prismaMock.reservation.findFirst.mockResolvedValueOnce({
      id: 'r1',
      status: 'PENDING',
      statusLog: [{ status: 'CONFIRMED', at: 'x', by: null }],
    } as any)
    prismaMock.reservation.updateMany.mockResolvedValueOnce({ count: 1 } as any)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
    await expect(ingestBookingCancelled(conn, ev, NOW)).resolves.toBe('CANCELLED')

    const findArgs = prismaMock.reservation.findFirst.mock.calls[0][0]
    expect(findArgs.where).toEqual({ id: 'r1', venueId: 'v1' })
    const data = prismaMock.reservation.updateMany.mock.calls[0][0].data
    expect(data.cancelledAt).toEqual(NOW)
    expect(data.cancelledBy).toBe('CUSTOMER')
    expect(data.cancellationReason).toBe('Cancelada por el socio en TOTALPASS')
    expect(data.statusLog).toEqual([
      { status: 'CONFIRMED', at: 'x', by: null },
      { status: 'CANCELLED', at: NOW.toISOString(), by: null, source: 'PASS:TOTALPASS', note: 'cancel' },
    ])
    expect(prismaMock.aggregatorOutbox.create.mock.calls[0][0].data).toMatchObject({ classSessionId: 's1', connectionId: 'c1' })
  })

  it('deja el rastro PASS_BOOKING_CANCELLED sin datos personales, ya fuera de la transacción', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce(acceptedBooking as any)
    prismaMock.reservation.findFirst.mockResolvedValueOnce({ id: 'r1', status: 'CONFIRMED', statusLog: null } as any)
    prismaMock.reservation.updateMany.mockResolvedValueOnce({ count: 1 } as any)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
    await ingestBookingCancelled(conn, { ...ev, late: true }, NOW)
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock).toHaveBeenCalledWith({
      staffId: null,
      venueId: 'v1',
      action: 'PASS_BOOKING_CANCELLED',
      entity: 'Reservation',
      entityId: 'r1',
      data: { provider: 'TOTALPASS', externalBookingId: 'slot-1', late: true },
    })
  })

  // nuevo
  it('reserva que no conocemos ⇒ NOT_FOUND sin tocar nada', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce(null)
    await expect(ingestBookingCancelled(conn, ev, NOW)).resolves.toBe('NOT_FOUND')
    expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
    expect(logActionMock).not.toHaveBeenCalled()
  })

  // Codex F4: NOT_FOUND ahora se reintenta (la reserva puede venir en camino); una que rechazamos ya no va a tener
  // Reservation nunca, así que es ALREADY (nada que cancelar) y no gasta los reintentos.
  it('reserva que rechazamos (sin Reservation) ⇒ ALREADY sin tocar nada', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({
      id: 'b1',
      reservationId: null,
      classSessionId: 's1',
      decision: 'DENIED',
    } as any)
    await expect(ingestBookingCancelled(conn, ev, NOW)).resolves.toBe('ALREADY')
    expect(prismaMock.reservation.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorBooking.update).not.toHaveBeenCalled()
  })

  // nuevo — no cancela a quien ya llegó
  it('si ya hizo check-in, no se cancela (ALREADY)', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce(acceptedBooking as any)
    prismaMock.reservation.findFirst.mockResolvedValueOnce({ id: 'r1', status: 'CHECKED_IN', statusLog: [] } as any)
    await expect(ingestBookingCancelled(conn, ev, NOW)).resolves.toBe('ALREADY')
  })

  it.each(['COMPLETED', 'NO_SHOW', 'CANCELLED'])('estado %s ⇒ ALREADY sin escribir', async status => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce(acceptedBooking as any)
    prismaMock.reservation.findFirst.mockResolvedValueOnce({ id: 'r1', status, statusLog: [] } as any)
    await expect(ingestBookingCancelled(conn, ev, NOW)).resolves.toBe('ALREADY')
    expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorBooking.update).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('la Reservation es de otro negocio ⇒ ALREADY sin escribir', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce(acceptedBooking as any)
    prismaMock.reservation.findFirst.mockResolvedValueOnce(null)
    await expect(ingestBookingCancelled(conn, ev, NOW)).resolves.toBe('ALREADY')
    expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
  })

  it('otro proceso cambió el estado entre leer y escribir (CAS perdido) ⇒ ALREADY sin marcar ni encolar', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce(acceptedBooking as any)
    prismaMock.reservation.findFirst.mockResolvedValueOnce({ id: 'r1', status: 'CONFIRMED', statusLog: [] } as any)
    prismaMock.reservation.updateMany.mockResolvedValueOnce({ count: 0 } as any)
    await expect(ingestBookingCancelled(conn, ev, NOW)).resolves.toBe('ALREADY')
    expect(prismaMock.aggregatorBooking.update).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('sin clase ligada no encola SYNC_SESSION pero sí cancela', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({ ...acceptedBooking, classSessionId: null } as any)
    prismaMock.reservation.findFirst.mockResolvedValueOnce({ id: 'r1', status: 'CONFIRMED', statusLog: [] } as any)
    prismaMock.reservation.updateMany.mockResolvedValueOnce({ count: 1 } as any)
    await expect(ingestBookingCancelled(conn, ev, NOW)).resolves.toBe('CANCELLED')
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })
})

/**
 * Decisión del founder (3-oct, opción A): TotalPass no deja mover una clase de hora. Al cambiarla, la ocurrencia vieja se
 * borra (TotalPass cancela a sus socios y les avisa) y se publica otra. Aquí esas reservas quedaban vivas como fantasmas.
 */
describe('cancelPassBookingsOfReplacedOccurrence', () => {
  const REPLACED_AT = new Date(NOW.getTime() - 1000)
  beforeEach(() => {
    prismaMock.aggregatorBooking.findMany.mockReset()
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
  })

  // nuevo
  it('busca sólo las reservas aceptadas de esa conexión y clase hechas ANTES del reemplazo', async () => {
    prismaMock.aggregatorBooking.findMany.mockResolvedValueOnce([])
    await expect(cancelPassBookingsOfReplacedOccurrence(conn, 's1', REPLACED_AT, NOW)).resolves.toBe(0)
    const q = prismaMock.aggregatorBooking.findMany.mock.calls[0][0]
    expect(q.where).toEqual({
      connectionId: 'c1',
      classSessionId: 's1',
      decision: 'ACCEPTED',
      reservationId: { not: null },
      createdAt: { lt: REPLACED_AT },
    })
    expect(q.take).toBeGreaterThan(0)
    expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
  })

  // nuevo
  it('cancela cada reserva con el motivo «la clase cambió de hora», la marca CANCELLED y deja rastro', async () => {
    prismaMock.aggregatorBooking.findMany.mockResolvedValueOnce([
      { id: 'b1', reservationId: 'r1', classSessionId: 's1', decision: 'ACCEPTED' },
      { id: 'b2', reservationId: 'r2', classSessionId: 's1', decision: 'ACCEPTED' },
    ] as any)
    prismaMock.reservation.findFirst
      .mockResolvedValueOnce({ id: 'r1', status: 'CONFIRMED', statusLog: [] } as any)
      .mockResolvedValueOnce({ id: 'r2', status: 'CONFIRMED', statusLog: [] } as any)
    prismaMock.reservation.updateMany.mockResolvedValue({ count: 1 } as any)
    await expect(cancelPassBookingsOfReplacedOccurrence(conn, 's1', REPLACED_AT, NOW)).resolves.toBe(2)
    const upd = prismaMock.reservation.updateMany.mock.calls[0][0]
    expect(upd.data).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM' })
    expect(upd.data.cancellationReason).toMatch(/cambió de hora/)
    expect(JSON.stringify(upd.data.statusLog)).toContain('class-rescheduled')
    expect(prismaMock.aggregatorBooking.update.mock.calls.map((c: any) => c[0])).toEqual([
      { where: { id: 'b1' }, data: { decision: 'CANCELLED' } },
      { where: { id: 'b2' }, data: { decision: 'CANCELLED' } },
    ])
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PASS_BOOKING_CANCELLED',
        entityId: 'r1',
        data: expect.objectContaining({ cause: 'CLASS_RESCHEDULED' }),
      }),
    )
  })

  // nuevo
  it('quien ya hizo check-in no se cancela ni se cuenta', async () => {
    prismaMock.aggregatorBooking.findMany.mockResolvedValueOnce([
      { id: 'b1', reservationId: 'r1', classSessionId: 's1', decision: 'ACCEPTED' },
    ] as any)
    prismaMock.reservation.findFirst.mockResolvedValueOnce({ id: 'r1', status: 'CHECKED_IN', statusLog: [] } as any)
    await expect(cancelPassBookingsOfReplacedOccurrence(conn, 's1', REPLACED_AT, NOW)).resolves.toBe(0)
    expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorBooking.update).not.toHaveBeenCalled()
  })
})
