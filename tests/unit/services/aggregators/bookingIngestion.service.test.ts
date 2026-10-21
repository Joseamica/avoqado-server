import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { NotFoundError } from '@/errors/AppError'
import { ingestBookingRequested } from '@/services/aggregators/core/bookingIngestion.service'
import { enqueuePassOutbox } from '@/services/aggregators/core/outbox.service'
import * as classBooking from '@/services/reservation/classBooking.service'

jest.mock('@/services/aggregators/core/customerIdentity.service', () => ({
  resolvePassCustomer: jest.fn().mockResolvedValue({ customerId: 'cu1', created: false }),
}))

const logActionMock = logAction as jest.Mock
const NOW = new Date(Date.now() + 24 * 3600 * 1000)
const conn = { id: 'c1', venueId: 'v1', provider: 'TOTALPASS' as const }
const ev = {
  kind: 'BOOKING_REQUESTED' as const,
  externalBookingId: 'slot-1',
  externalOccurrenceId: 'occ-1',
  externalUserId: 'U1',
  externalPlanCode: 'PLAN1',
  placeId: 'place-1',
  user: { name: 'Ana', email: null, phone: null },
  seatRef: null,
}
const session = {
  id: 's1',
  productId: 'p1',
  startsAt: new Date(NOW.getTime() + 3600e3),
  endsAt: new Date(NOW.getTime() + 7200e3),
  duration: 60,
  capacity: 12,
  status: 'SCHEDULED',
  assignedStaffId: 'st1',
}

const lockSpy = jest.spyOn(classBooking, 'lockClassSession')
const occupiedSpy = jest.spyOn(classBooking, 'sumOccupiedSeats')
const passSpy = jest.spyOn(classBooking, 'sumPassSeats')

// Los «Once» que un camino no consume se quedarían para la prueba siguiente: se limpian todos.
beforeEach(() => {
  for (const fn of [
    lockSpy,
    occupiedSpy,
    passSpy,
    prismaMock.aggregatorBooking.findUnique,
    prismaMock.aggregatorBooking.create,
    prismaMock.aggregatorSessionLink.findFirst,
    prismaMock.aggregatorCapacityRule.findMany,
    prismaMock.venue.findUniqueOrThrow,
    prismaMock.reservation.findUnique,
    prismaMock.reservation.create,
    prismaMock.aggregatorOutbox.findFirst,
    prismaMock.aggregatorOutbox.create,
    prismaMock.aggregatorOutbox.update,
    prismaMock.aggregatorProductLink.findFirst,
  ])
    fn.mockReset()
  // Las pruebas asumen la clase ligada a un plan del proveedor (el caso que no, va aparte).
  prismaMock.aggregatorProductLink.findFirst.mockResolvedValue({ id: 'l1' } as any)
})
afterAll(() => {
  lockSpy.mockRestore()
  occupiedSpy.mockRestore()
  passSpy.mockRestore()
})

function arrange(over: { occupied?: number; passes?: number; status?: string; existing?: any; startsAt?: Date } = {}) {
  prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce(over.existing ?? null)
  prismaMock.aggregatorSessionLink.findFirst.mockResolvedValueOnce({ classSessionId: 's1', connectionId: 'c1' } as any)
  lockSpy.mockResolvedValueOnce({ ...session, status: over.status ?? 'SCHEDULED', startsAt: over.startsAt ?? session.startsAt })
  occupiedSpy.mockResolvedValueOnce(over.occupied ?? 3)
  passSpy.mockResolvedValueOnce(over.passes ?? 0)
  prismaMock.aggregatorCapacityRule.findMany.mockResolvedValueOnce([])
  prismaMock.venue.findUniqueOrThrow.mockResolvedValueOnce({ timezone: 'America/Mexico_City' } as any)
  prismaMock.reservation.create.mockResolvedValueOnce({ id: 'r1' } as any)
  prismaMock.aggregatorBooking.create.mockResolvedValueOnce({ id: 'b1' } as any)
  prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
}

describe('ingestBookingRequested', () => {
  // nuevo
  it('hay lugar ⇒ Reservation CONFIRMED THIRD_PARTY de 1 lugar, sin créditos, y respuesta encolada', async () => {
    arrange()
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'ACCEPTED', reservationId: 'r1' })
    const data = prismaMock.reservation.create.mock.calls[0][0].data
    expect(data).toMatchObject({
      venueId: 'v1',
      classSessionId: 's1',
      status: 'CONFIRMED',
      channel: 'THIRD_PARTY',
      partySize: 1,
      customerId: 'cu1',
      spotIds: [],
      confirmedAt: NOW,
    })
    expect(data.confirmationCode).toMatch(/^RES-[A-Z0-9]{6}$/)
    expect(prismaMock.creditTransaction.create).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorBooking.create.mock.calls[0][0].data).toMatchObject({
      decision: 'ACCEPTED',
      externalBookingId: 'slot-1',
      reservationId: 'r1',
    })
    const ops = prismaMock.aggregatorOutbox.create.mock.calls.map((c: any) => c[0].data.operation)
    expect(ops).toEqual(expect.arrayContaining(['RESPOND_BOOKING', 'SYNC_SESSION']))
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASS_BOOKING_ACCEPTED', entity: 'Reservation', entityId: 'r1', venueId: 'v1', staffId: null }),
    )
  })

  // nuevo — Review Focus 1: el último lugar
  it('clase llena ⇒ DENIED con CLASS_FULL, sin Reservation', async () => {
    arrange({ occupied: 12 })
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'DENIED', reason: 'CLASS_FULL' })
    expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorBooking.create.mock.calls[0][0].data).toMatchObject({
      decision: 'DENIED',
      denyReason: 'CLASS_FULL',
      reservationId: null,
    })
    expect(prismaMock.aggregatorOutbox.create.mock.calls.map((c: any) => c[0].data.operation)).toEqual(['RESPOND_BOOKING'])
  })

  // nuevo — Review Focus 1: queda exactamente un lugar
  it('queda un solo lugar ⇒ se acepta', async () => {
    arrange({ occupied: 11 })
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'ACCEPTED' })
  })

  // nuevo
  it('tope de pases alcanzado aunque haya lugares propios ⇒ DENIED', async () => {
    arrange({ occupied: 5, passes: 2 })
    prismaMock.aggregatorCapacityRule.findMany
      .mockReset()
      .mockResolvedValueOnce([{ scope: 'DEFAULT', weekday: null, startMinute: null, classSessionId: null, maxSpots: 2 }] as any)
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'DENIED', reason: 'CLASS_FULL' })
  })

  // nuevo — R6: entre reglas del mismo nivel gana la editada más reciente
  it('carga las reglas acotadas y de la más reciente a la más vieja', async () => {
    arrange()
    await ingestBookingRequested(conn, ev, NOW)
    const args = prismaMock.aggregatorCapacityRule.findMany.mock.calls[0][0]
    expect(args.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }])
    expect(args.take).toBeGreaterThan(0)
    expect(args.where.venueId).toBe('v1')
  })

  // nuevo — la regla semanal se compara en hora local del venue (lunes 09:00 CDMX = 15:00 UTC)
  it('regla semanal del día y hora locales de la clase ⇒ aplica su tope', async () => {
    const monday9 = new Date('2025-01-06T15:00:00Z')
    arrange({ passes: 1, startsAt: monday9 })
    prismaMock.aggregatorCapacityRule.findMany
      .mockReset()
      .mockResolvedValueOnce([{ scope: 'WEEKLY', weekday: 1, startMinute: 540, classSessionId: null, maxSpots: 1 }] as any)
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'DENIED', reason: 'CLASS_FULL' })
  })

  // nuevo — la misma regla, otro día: no aplica
  it('regla semanal de otro día ⇒ no aplica', async () => {
    const monday9 = new Date('2025-01-06T15:00:00Z')
    arrange({ passes: 1, startsAt: monday9 })
    prismaMock.aggregatorCapacityRule.findMany
      .mockReset()
      .mockResolvedValueOnce([{ scope: 'WEEKLY', weekday: 2, startMinute: 540, classSessionId: null, maxSpots: 1 }] as any)
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'ACCEPTED' })
  })

  // nuevo
  it('sesión cancelada ⇒ DENIED con CLASS_CANCELLED', async () => {
    arrange({ status: 'CANCELLED' })
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'DENIED', reason: 'CLASS_CANCELLED' })
    expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PASS_BOOKING_DENIED',
        entity: 'AggregatorBooking',
        entityId: 'b1',
        data: expect.objectContaining({ provider: 'TOTALPASS', externalBookingId: 'slot-1', reason: 'CLASS_CANCELLED' }),
      }),
    )
    // Sin datos personales del socio en el rastro.
    expect(JSON.stringify(logActionMock.mock.calls[0][0])).not.toContain('Ana')
  })

  // nuevo — P1-4: una reserva que llega para una clase que el estudio acaba de desligar se rechaza
  it('el producto de la clase ya no está ligado a la conexión ⇒ DENIED CLASS_CANCELLED sin crear reserva', async () => {
    arrange()
    prismaMock.aggregatorProductLink.findFirst.mockResolvedValueOnce(null)
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'DENIED', reason: 'CLASS_CANCELLED' })
    expect(prismaMock.aggregatorProductLink.findFirst.mock.calls[0][0].where).toEqual({
      connectionId: conn.id,
      productId: 'p1',
      active: true,
    })
    expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorBooking.create.mock.calls[0][0].data).toMatchObject({
      decision: 'DENIED',
      denyReason: 'CLASS_CANCELLED',
      classSessionId: 's1',
      reservationId: null,
    })
  })

  // nuevo — Review Focus 2
  it('la misma reserva otra vez ⇒ DUPLICATE, sin escribir', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({ id: 'b1', decision: 'ACCEPTED', reservationId: 'r1' } as any)
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'DUPLICATE', reservationId: 'r1' })
    expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorBooking.create).not.toHaveBeenCalled()
    expect(logActionMock).not.toHaveBeenCalled()
  })

  // nuevo — Review Focus 2: dos copias del mismo evento a la vez; la segunda la ve ya guardada bajo el candado
  it('la otra copia ganó mientras esperaba el candado ⇒ DUPLICATE, sin escribir', async () => {
    arrange()
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({ id: 'b9', decision: 'ACCEPTED', reservationId: 'r9' } as any)
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'DUPLICATE', reservationId: 'r9' })
    expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorBooking.create).not.toHaveBeenCalled()
    expect(logActionMock).not.toHaveBeenCalled()
  })

  // nuevo
  it('ocurrencia que no conocemos ⇒ DENIED OTHER (no se inventa una clase)', async () => {
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce(null)
    prismaMock.aggregatorSessionLink.findFirst.mockResolvedValueOnce(null)
    prismaMock.aggregatorBooking.create.mockResolvedValueOnce({ id: 'b2' } as any)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'DENIED', reason: 'OTHER' })
    expect(lockSpy).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorBooking.create.mock.calls[0][0].data).toMatchObject({ classSessionId: null, decision: 'DENIED' })
  })

  // nuevo — la sesión se borró entre leer la liga y tomar el candado
  it('la sesión ya no existe al tomar el candado ⇒ DENIED OTHER, sin Reservation', async () => {
    arrange()
    lockSpy.mockReset().mockRejectedValueOnce(new NotFoundError('Sesion de clase no encontrada'))
    await expect(ingestBookingRequested(conn, ev, NOW)).resolves.toMatchObject({ decision: 'DENIED', reason: 'OTHER' })
    expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorBooking.create.mock.calls[0][0].data).toMatchObject({ classSessionId: null, denyReason: 'OTHER' })
  })

  // regresión — un error que no es «no existe» no se convierte en rechazo
  it('error de base al tomar el candado ⇒ se propaga (el procesador reintenta)', async () => {
    arrange()
    lockSpy.mockReset().mockRejectedValueOnce(new Error('connection lost'))
    await expect(ingestBookingRequested(conn, ev, NOW)).rejects.toThrow('connection lost')
    expect(prismaMock.aggregatorBooking.create).not.toHaveBeenCalled()
  })
})

describe('enqueuePassOutbox', () => {
  const tx = prismaMock as any

  // nuevo
  it('sin trabajo igual pendiente ⇒ crea la fila con su llave de agrupación', async () => {
    tx.aggregatorOutbox.findFirst.mockResolvedValueOnce(null)
    await enqueuePassOutbox(tx, { venueId: 'v1', connectionId: 'c1', operation: 'SYNC_SESSION', classSessionId: 's1' })
    expect(tx.aggregatorOutbox.findFirst.mock.calls[0][0].where).toEqual({
      coalesceKey: 'SYNC_SESSION:c1:s1',
      status: { in: ['PENDING', 'FAILED'] },
    })
    expect(tx.aggregatorOutbox.create.mock.calls[0][0].data).toMatchObject({
      venueId: 'v1',
      connectionId: 'c1',
      operation: 'SYNC_SESSION',
      classSessionId: 's1',
      aggregatorBookingId: null,
      aggregatorVisitId: null,
      coalesceKey: 'SYNC_SESSION:c1:s1',
    })
  })

  // C7 (P2-8) — un reintento de Confirmar mientras el worker ya valida (IN_PROGRESS con lease vivo) no manda otra validación
  it('VALIDATE_VISIT con una igual en curso (lease vivo) ⇒ no crea otra ni la toca', async () => {
    tx.aggregatorOutbox.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'o1' })
    await expect(
      enqueuePassOutbox(tx, { venueId: 'v1', connectionId: 'c1', operation: 'VALIDATE_VISIT', aggregatorVisitId: 'vis1' }),
    ).resolves.toBe('IN_FLIGHT')
    expect(tx.aggregatorOutbox.findFirst.mock.calls[1][0].where).toEqual({
      coalesceKey: 'VALIDATE_VISIT:c1:vis1',
      status: 'IN_PROGRESS',
      leaseUntil: { gt: expect.any(Date) },
    })
    expect(tx.aggregatorOutbox.create).not.toHaveBeenCalled()
    expect(tx.aggregatorOutbox.update).not.toHaveBeenCalled()
  })
  // C7 — resincronizar una sesión conserva su semántica: el estado pudo cambiar después de que el worker lo leyó
  it('SYNC_SESSION no mira las filas en curso: crea otra', async () => {
    tx.aggregatorOutbox.findFirst.mockResolvedValueOnce(null)
    await expect(
      enqueuePassOutbox(tx, { venueId: 'v1', connectionId: 'c1', operation: 'SYNC_SESSION', classSessionId: 's1' }),
    ).resolves.toBe('CREATED')
    expect(tx.aggregatorOutbox.findFirst).toHaveBeenCalledTimes(1)
    expect(tx.aggregatorOutbox.create).toHaveBeenCalledTimes(1)
  })

  // nuevo
  it('ya hay uno igual esperando ⇒ no crea otro, lo adelanta', async () => {
    tx.aggregatorOutbox.findFirst.mockResolvedValueOnce({ id: 'o1' })
    await enqueuePassOutbox(tx, { venueId: 'v1', connectionId: 'c1', operation: 'RESPOND_BOOKING', aggregatorBookingId: 'b1' })
    expect(tx.aggregatorOutbox.create).not.toHaveBeenCalled()
    expect(tx.aggregatorOutbox.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { scheduledAt: expect.any(Date) } })
  })
})
