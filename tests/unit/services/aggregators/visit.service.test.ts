import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { ConflictError } from '@/errors/AppError'
import { autoConfirmVisit, ingestCheckin, expireVisits, requeueCheckedInVisits } from '@/services/aggregators/core/visit.service'
import { onVenueCheckIn } from '@/services/aggregators/core/visitHook'
import * as checkIn from '@/services/reservation/checkIn.service'
import * as identity from '@/services/aggregators/core/customerIdentity.service'

const NOW = new Date(Date.now() + 3600e3)
const ev = {
  kind: 'CHECKIN_CREATED' as const,
  externalCheckinId: 'h1',
  validationRef: 'https://admin.totalpass.com/api/v1/webhook_confirmations/T',
  externalUserId: 'U1',
  placeId: 'place-1',
  startedAt: NOW,
  deadlineAt: new Date(NOW.getTime() + 90 * 60e3),
  user: { name: 'Ana', email: null, phone: null },
}
const auto = { id: 'c1', venueId: 'v1', provider: 'TOTALPASS' as const, confirmMode: 'AUTO' as const }

const checkInSpy = jest.spyOn(checkIn, 'checkInReservation')
const identitySpy = jest.spyOn(identity, 'resolvePassCustomer')

/** La reserva ligada: el estado que manda es el que se lee BAJO el candado (FOR UPDATE), no el de la búsqueda. */
function linkedReservation(status: string) {
  prismaMock.aggregatorBooking.findFirst.mockResolvedValueOnce({ reservationId: 'r1' } as any)
  prismaMock.$queryRaw.mockResolvedValueOnce([{ id: 'r1', status }])
}

/** Texto del SQL de una llamada a `tx.$queryRaw` con plantilla (el primer argumento son los trozos). */
function sqlOf(call: unknown[]): string {
  return (call[0] as string[]).join('?')
}

// Los «Once» que un camino no consume se quedarían para la prueba siguiente: se limpian todos.
beforeEach(() => {
  for (const fn of [
    checkInSpy,
    prismaMock.aggregatorBooking.findFirst,
    prismaMock.aggregatorVisit.findUnique,
    prismaMock.aggregatorVisit.findMany,
    prismaMock.aggregatorVisit.create,
    prismaMock.aggregatorVisit.updateMany,
    prismaMock.aggregatorOutbox.findFirst,
    prismaMock.aggregatorOutbox.create,
    prismaMock.aggregatorOutbox.update,
    prismaMock.aggregatorOutbox.findMany,
    prismaMock.$queryRaw,
  ])
    fn.mockReset()
  identitySpy.mockReset()
  identitySpy.mockResolvedValue({ customerId: 'cus1', created: false })
  prismaMock.aggregatorVisit.create.mockResolvedValue({ id: 'vis1' } as any)
  prismaMock.aggregatorVisit.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.aggregatorOutbox.findFirst.mockResolvedValue(null)
})
afterAll(() => {
  checkInSpy.mockRestore()
  identitySpy.mockRestore()
})

describe('ingestCheckin', () => {
  // nuevo
  it('AUTO: crea la visita ligada, encola la validación y marca la reserva como asistió', async () => {
    linkedReservation('CONFIRMED')
    checkInSpy.mockResolvedValueOnce({ outcome: 'CHECKED_IN' } as any)
    await expect(ingestCheckin(auto, ev, NOW)).resolves.toEqual({ visitId: 'vis1', duplicate: false, queuedValidation: true })
    expect(prismaMock.aggregatorVisit.create.mock.calls[0][0].data).toMatchObject({
      reservationId: 'r1',
      status: 'PENDING',
      externalCheckinId: 'h1',
    })
    expect(checkInSpy.mock.calls[0][1]).toMatchObject({
      reservationId: 'r1',
      venueId: 'v1',
      source: 'PASS',
      actor: { type: 'SERVICE', servicePrincipalId: 'aggregator:TOTALPASS' },
    })
    expect(prismaMock.aggregatorOutbox.create.mock.calls[0][0].data).toMatchObject({
      operation: 'VALIDATE_VISIT',
      aggregatorVisitId: 'vis1',
    })
  })
  // nuevo
  it('la reserva ligada es del mismo socio, de esta conexión y venue, aceptada y en la ventana −30/+60 min del check-in', async () => {
    linkedReservation('CONFIRMED')
    checkInSpy.mockResolvedValueOnce({ outcome: 'CHECKED_IN' } as any)
    await ingestCheckin(auto, ev, NOW)
    expect(prismaMock.aggregatorBooking.findFirst.mock.calls[0][0].where).toEqual({
      connectionId: 'c1',
      externalUserId: 'U1',
      decision: 'ACCEPTED',
      reservation: {
        venueId: 'v1',
        status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
        startsAt: { gte: new Date(NOW.getTime() - 30 * 60e3), lte: new Date(NOW.getTime() + 60 * 60e3) },
      },
    })
  })
  // nuevo — revisión final I3: el estudio canceló la reserva entre la búsqueda y el candado
  it.each(['CANCELLED', 'NO_SHOW', 'COMPLETED'])(
    'bajo el candado la reserva está %s ⇒ visita sin reserva (AUTO la valida igual)',
    async status => {
      linkedReservation(status)
      await expect(ingestCheckin(auto, ev, NOW)).resolves.toMatchObject({ queuedValidation: true })
      expect(prismaMock.aggregatorVisit.create.mock.calls[0][0].data.reservationId).toBeNull()
      expect(checkInSpy).not.toHaveBeenCalled()
    },
  )
  // nuevo — revisión final I3: en ON_VENUE_CHECKIN una reserva cancelada no deja la visita amarrada hasta vencer
  it('ON_VENUE_CHECKIN con la reserva cancelada ⇒ visita sin reserva para que la recepción la confirme', async () => {
    linkedReservation('CANCELLED')
    await expect(ingestCheckin({ ...auto, confirmMode: 'ON_VENUE_CHECKIN' }, ev, NOW)).resolves.toMatchObject({ queuedValidation: false })
    expect(prismaMock.aggregatorVisit.create.mock.calls[0][0].data.reservationId).toBeNull()
  })
  // nuevo — carrera kiosco/webhook: candado de la reserva antes de crear la visita
  it('bloquea la reserva (FOR UPDATE) ANTES de crear la visita', async () => {
    linkedReservation('CONFIRMED')
    checkInSpy.mockResolvedValueOnce({ outcome: 'CHECKED_IN' } as any)
    await ingestCheckin(auto, ev, NOW)
    const lockCall = prismaMock.$queryRaw.mock.calls[0]
    expect(sqlOf(lockCall)).toMatch(/FROM "Reservation" WHERE id = \? FOR UPDATE/)
    expect(lockCall[1]).toBe('r1')
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.aggregatorVisit.create.mock.invocationCallOrder[0])
  })
  // nuevo — la decisión usa el estado bajo candado: el kiosco confirmó entre la búsqueda y el candado
  it('ON_VENUE_CHECKIN: el estado bajo candado dice CHECKED_IN ⇒ encola aunque la búsqueda fuera anterior', async () => {
    prismaMock.aggregatorBooking.findFirst.mockResolvedValueOnce({
      reservationId: 'r1',
      reservation: { id: 'r1', status: 'CONFIRMED' },
    } as any)
    prismaMock.$queryRaw.mockResolvedValueOnce([{ id: 'r1', status: 'CHECKED_IN' }])
    await expect(ingestCheckin({ ...auto, confirmMode: 'ON_VENUE_CHECKIN' }, ev, NOW)).resolves.toMatchObject({ queuedValidation: true })
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(1)
  })
  // nuevo — la reserva desapareció entre la búsqueda y el candado ⇒ visita sin reserva
  it('el candado no encuentra la reserva ⇒ visita sin reserva (AUTO la valida igual)', async () => {
    prismaMock.aggregatorBooking.findFirst.mockResolvedValueOnce({ reservationId: 'r1' } as any)
    prismaMock.$queryRaw.mockResolvedValueOnce([])
    await expect(ingestCheckin(auto, ev, NOW)).resolves.toMatchObject({ queuedValidation: true })
    expect(prismaMock.aggregatorVisit.create.mock.calls[0][0].data.reservationId).toBeNull()
    expect(checkInSpy).not.toHaveBeenCalled()
  })
  // nuevo — sin reserva ligada no hay nada que bloquear
  it('sin reserva ligada no toma candado', async () => {
    prismaMock.aggregatorBooking.findFirst.mockResolvedValueOnce(null)
    await ingestCheckin(auto, ev, NOW)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })
  // nuevo
  it('AUTO con la reserva ya CHECKED_IN (el kiosco llegó primero) ⇒ no repite el check-in y encola', async () => {
    linkedReservation('CHECKED_IN')
    await expect(ingestCheckin(auto, ev, NOW)).resolves.toMatchObject({ queuedValidation: true })
    expect(checkInSpy).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(1)
  })
  // nuevo — carrera: la reserva cambió (p. ej. no-show) entre la lectura y el check-in
  it('AUTO: si la reserva ya no admite check-in, la visita se guarda y se valida igual', async () => {
    linkedReservation('CONFIRMED')
    checkInSpy.mockRejectedValueOnce(new ConflictError('cambió a NO_SHOW', checkIn.RESERVATION_NOT_CHECKINABLE))
    await expect(ingestCheckin(auto, ev, NOW)).resolves.toEqual({ visitId: 'vis1', duplicate: false, queuedValidation: true })
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(1)
  })
  // nuevo — cualquier otro error del check-in se propaga (el procesador reintenta el evento)
  it('AUTO: un error distinto del check-in se propaga', async () => {
    linkedReservation('CONFIRMED')
    checkInSpy.mockRejectedValueOnce(new Error('db down'))
    await expect(ingestCheckin(auto, ev, NOW)).rejects.toThrow('db down')
  })
  // nuevo
  it('ON_VENUE_CHECKIN sin check-in del estudio ⇒ espera (no encola)', async () => {
    linkedReservation('CONFIRMED')
    await expect(ingestCheckin({ ...auto, confirmMode: 'ON_VENUE_CHECKIN' }, ev, NOW)).resolves.toMatchObject({ queuedValidation: false })
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
    expect(checkInSpy).not.toHaveBeenCalled()
  })
  // nuevo — Review Focus 3: kiosco antes que webhook
  it('ON_VENUE_CHECKIN con la reserva ya CHECKED_IN ⇒ encola de inmediato', async () => {
    linkedReservation('CHECKED_IN')
    await expect(ingestCheckin({ ...auto, confirmMode: 'ON_VENUE_CHECKIN' }, ev, NOW)).resolves.toMatchObject({ queuedValidation: true })
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(1)
  })
  // nuevo — sin reserva: queda PENDING para la recepción (pantalla del Plan 2)
  it('ON_VENUE_CHECKIN sin reserva ligada ⇒ visita PENDING sin reserva, no encola', async () => {
    prismaMock.aggregatorBooking.findFirst.mockResolvedValueOnce(null)
    await expect(ingestCheckin({ ...auto, confirmMode: 'ON_VENUE_CHECKIN' }, ev, NOW)).resolves.toMatchObject({ queuedValidation: false })
    expect(prismaMock.aggregatorVisit.create.mock.calls[0][0].data).toMatchObject({ reservationId: null, status: 'PENDING' })
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })
  // nuevo — Review Focus 2
  it('el mismo check-in dos veces ⇒ duplicate', async () => {
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({ id: 'vis1' } as any)
    await expect(ingestCheckin(auto, ev, NOW)).resolves.toEqual({ visitId: 'vis1', duplicate: true, queuedValidation: false })
    expect(prismaMock.aggregatorVisit.create).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })
  // C8 (P2-9) — un socio sin reserva ni identidad previa aparecía sin nombre: el check-in también lo identifica
  it.each(['AUTO', 'ON_VENUE_CHECKIN'] as const)(
    '%s sin reserva ⇒ identifica al socio con el usuario del check-in (mismo helper que las reservas), en la misma tx',
    async confirmMode => {
      prismaMock.aggregatorBooking.findFirst.mockResolvedValueOnce(null)
      await ingestCheckin({ ...auto, confirmMode }, ev, NOW)
      expect(identitySpy).toHaveBeenCalledWith(prismaMock, {
        venueId: 'v1',
        provider: 'TOTALPASS',
        externalUserId: 'U1',
        user: { name: 'Ana', email: null, phone: null },
      })
    },
  )
  // nuevo
  it('AUTO sin reserva ligada (gimnasio libre) ⇒ visita sin reserva, se valida igual', async () => {
    prismaMock.aggregatorBooking.findFirst.mockResolvedValueOnce(null)
    await expect(ingestCheckin(auto, ev, NOW)).resolves.toMatchObject({ queuedValidation: true })
    expect(prismaMock.aggregatorVisit.create.mock.calls[0][0].data.reservationId).toBeNull()
    expect(checkInSpy).not.toHaveBeenCalled()
  })
})

describe('autoConfirmVisit', () => {
  const visit = { id: 'vis1', venueId: 'v1', connectionId: 'c1', provider: 'TOTALPASS', reservationId: 'r1' }
  // nuevo — P1-5: lo que esperaba a la recepción se confirma solo al pasar a AUTO
  it('bloquea la reserva, registra la asistencia (SERVICE, PASS) y encola la validación', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ status: 'CONFIRMED' }])
    checkInSpy.mockResolvedValueOnce({ outcome: 'CHECKED_IN' } as any)
    await autoConfirmVisit(prismaMock, visit, NOW)
    expect(sqlOf(prismaMock.$queryRaw.mock.calls[0])).toMatch(/FROM "Reservation" WHERE id = \? FOR UPDATE/)
    expect(checkInSpy.mock.calls[0][1]).toMatchObject({
      reservationId: 'r1',
      venueId: 'v1',
      source: 'PASS',
      actor: { type: 'SERVICE', servicePrincipalId: 'aggregator:TOTALPASS' },
      now: NOW,
    })
    expect(prismaMock.aggregatorOutbox.create.mock.calls[0][0].data).toMatchObject({
      operation: 'VALIDATE_VISIT',
      aggregatorVisitId: 'vis1',
    })
  })
  // C2 (P1-2) — la reclama ANTES de tocar la reserva: candado de la visita primero (mismo orden que el rechazo)
  it('reclama la visita (PENDING y en plazo) antes de bloquear la reserva', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ status: 'CONFIRMED' }])
    checkInSpy.mockResolvedValueOnce({ outcome: 'CHECKED_IN' } as any)
    await expect(autoConfirmVisit(prismaMock, visit, NOW)).resolves.toBe(true)
    const claim = prismaMock.aggregatorVisit.updateMany.mock.calls[0][0]
    expect(claim.where).toEqual({ id: 'vis1', status: 'PENDING', deadlineAt: { gt: NOW } })
    expect(prismaMock.aggregatorVisit.updateMany.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.$queryRaw.mock.invocationCallOrder[0])
  })
  // C2 (P1-2) — la recepción la rechazó (o venció) entre la lectura de pendientes y aquí: no se marca asistencia
  it('si no la reclama (ya no PENDING o vencida) ⇒ no toca la reserva ni encola', async () => {
    prismaMock.aggregatorVisit.updateMany.mockResolvedValueOnce({ count: 0 } as any)
    await expect(autoConfirmVisit(prismaMock, visit, NOW)).resolves.toBe(false)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(checkInSpy).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.update).not.toHaveBeenCalled()
  })
  // nuevo
  it('reserva ya CHECKED_IN, o visita sin reserva ⇒ no repite el check-in y valida igual', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ status: 'CHECKED_IN' }])
    await autoConfirmVisit(prismaMock, visit, NOW)
    await autoConfirmVisit(prismaMock, { ...visit, id: 'vis2', reservationId: null }, NOW)
    expect(checkInSpy).not.toHaveBeenCalled()
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(2)
  })
})

describe('onVenueCheckIn', () => {
  // nuevo
  it('con una visita PENDING de esa reserva en conexión ON_VENUE_CHECKIN ⇒ encola la validación', async () => {
    const tx = prismaMock as any
    tx.aggregatorVisit.findMany.mockResolvedValueOnce([
      { id: 'vis1', venueId: 'v1', connectionId: 'c1', connection: { confirmMode: 'ON_VENUE_CHECKIN' } },
    ])
    await onVenueCheckIn(tx, 'r1', 'KIOSK')
    expect(tx.aggregatorVisit.findMany.mock.calls[0][0].where).toEqual({ reservationId: 'r1', status: 'PENDING' })
    expect(tx.aggregatorOutbox.create.mock.calls[0][0].data).toMatchObject({ operation: 'VALIDATE_VISIT', aggregatorVisitId: 'vis1' })
  })
  // nuevo — en AUTO la validación ya se encoló al llegar el webhook
  it('visita de una conexión AUTO ⇒ no encola', async () => {
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce([
      { id: 'vis1', venueId: 'v1', connectionId: 'c1', connection: { confirmMode: 'AUTO' } },
    ] as any)
    await onVenueCheckIn(prismaMock as any, 'r1', 'DASHBOARD')
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })
  // nuevo — reserva sin visitas de pase (el caso normal de cualquier reserva) ⇒ nada
  it('sin visitas ⇒ no encola', async () => {
    prismaMock.aggregatorVisit.findMany.mockResolvedValueOnce([])
    await onVenueCheckIn(prismaMock as any, 'r1', 'POS_ANDROID')
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })
  // nuevo — sin lazo
  it('source PASS no hace nada', async () => {
    await onVenueCheckIn(prismaMock as any, 'r1', 'PASS')
    expect(prismaMock.aggregatorVisit.findMany).not.toHaveBeenCalled()
  })
})

describe('requeueCheckedInVisits', () => {
  const candidate = (id: string) => ({ id, venueId: 'v1', connectionId: 'c1' })
  /** La consulta ya armada (con los fragmentos `utcTs` y `Prisma.join` expandidos): texto y valores ligados. */
  const sweepQuery = () => {
    const [strings, ...values] = prismaMock.$queryRaw.mock.calls[0]
    const q = Prisma.sql(strings as TemplateStringsArray, ...values)
    return { sql: q.sql.replace(/\s+/g, ' '), values: q.values }
  }

  // nuevo — red de seguridad: todo el filtro va en la consulta, antes del tope
  it('una sola consulta acotada y en orden fijo: PENDING en plazo, conexión ACTIVE, ON_VENUE_CHECKIN con reserva CHECKED_IN, sin trabajo vivo', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([])
    await expect(requeueCheckedInVisits(NOW)).resolves.toBe(0)
    const { sql, values } = sweepQuery()
    expect(sql).toContain(`v.status = 'PENDING'`)
    expect(sql).toMatch(/v\."deadlineAt" > \(\? AT TIME ZONE 'UTC'\)/) // utcTs
    expect(sql).toContain(`c."confirmMode" = 'ON_VENUE_CHECKIN'`)
    expect(sql).toContain(`c.status = 'ACTIVE'`)
    expect(sql).toContain(`r.status = 'CHECKED_IN'`)
    expect(sql).toMatch(
      /NOT EXISTS \( SELECT 1 FROM "AggregatorOutbox" o WHERE o\."coalesceKey" = 'VALIDATE_VISIT:' \|\| v\."connectionId" \|\| ':' \|\| v\.id AND o\.status IN \(/,
    )
    expect(sql).toMatch(/ORDER BY v\."deadlineAt" ASC, v\.id ASC LIMIT \?/)
    expect(values).toEqual(expect.arrayContaining([NOW, 200]))
    // vivos = PENDING, IN_PROGRESS, FAILED, DEAD_LETTER; DONE y SKIPPED NO bloquean el re-encolado
    expect(values).toEqual(expect.arrayContaining(['PENDING', 'IN_PROGRESS', 'FAILED', 'DEAD_LETTER']))
    expect(values).not.toContain('SKIPPED')
    expect(values).not.toContain('DONE')
    expect(prismaMock.aggregatorOutbox.create).not.toHaveBeenCalled()
  })
  // nuevo — Codex F1: en AUTO la validación se encola al llegar el webhook; si el worker la saltó porque la conexión
  // estaba reconectando (PENDING), nada la volvía a encolar y la visita vencía sin cobrarse.
  it('también recupera visitas de conexiones AUTO, con o sin reserva, sin exigir CHECKED_IN', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([])
    await requeueCheckedInVisits(NOW)
    const { sql } = sweepQuery()
    expect(sql).toContain(`LEFT JOIN "Reservation" r ON r.id = v."reservationId"`)
    expect(sql).toContain(`(c."confirmMode" = 'AUTO' OR (c."confirmMode" = 'ON_VENUE_CHECKIN' AND r.status = 'CHECKED_IN'))`)
  })
  // R69 / Codex authz P1-3 — una visita que se ingirió con el modo viejo mientras la conexión pasaba a AUTO no estuvo en las
  // tandas del cambio: el barrido le aplica lo MISMO que AUTO (reclamo + asistencia + validación), no sólo la encola
  it('en una conexión AUTO aplica el helper protegido: reclama, registra la asistencia de la reserva y encola', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ ...candidate('vis1'), provider: 'TOTALPASS', reservationId: 'r1', confirmMode: 'AUTO' }])
      .mockResolvedValueOnce([{ status: 'CONFIRMED' }]) // candado de la reserva
    checkInSpy.mockResolvedValueOnce({ outcome: 'CHECKED_IN' } as any)
    await expect(requeueCheckedInVisits(NOW)).resolves.toBe(1)
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0].where).toEqual({ id: 'vis1', status: 'PENDING', deadlineAt: { gt: NOW } })
    expect(checkInSpy.mock.calls[0][1]).toMatchObject({
      reservationId: 'r1',
      venueId: 'v1',
      source: 'PASS',
      actor: { type: 'SERVICE', servicePrincipalId: 'aggregator:TOTALPASS' },
    })
    expect(prismaMock.aggregatorOutbox.create.mock.calls[0][0].data).toMatchObject({
      operation: 'VALIDATE_VISIT',
      aggregatorVisitId: 'vis1',
    })
    // La consulta trae lo que el helper necesita.
    expect(sweepQuery().sql).toMatch(
      /SELECT v\.id, v\."venueId", v\."connectionId", v\.provider::text AS provider, v\."reservationId", c\."confirmMode"::text AS "confirmMode"/,
    )
  })
  // R69 — en ON_VENUE_CHECKIN la reserva ya está CHECKED_IN: sólo se encola, como siempre
  it('en ON_VENUE_CHECKIN sólo encola (la asistencia ya está registrada)', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { ...candidate('vis1'), provider: 'TOTALPASS', reservationId: 'r1', confirmMode: 'ON_VENUE_CHECKIN' },
    ])
    await requeueCheckedInVisits(NOW)
    expect(prismaMock.aggregatorVisit.updateMany).not.toHaveBeenCalled()
    expect(checkInSpy).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(1)
  })
  // nuevo — el caso que sana (también el de un SKIPPED con la conexión ya reactivada)
  it('encola la validación de cada visita que devuelve la consulta', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([candidate('vis1'), candidate('vis2')])
    await expect(requeueCheckedInVisits(NOW)).resolves.toBe(2)
    expect(prismaMock.aggregatorOutbox.create).toHaveBeenCalledTimes(2)
    expect(prismaMock.aggregatorOutbox.create.mock.calls[0][0].data).toMatchObject({
      operation: 'VALIDATE_VISIT',
      connectionId: 'c1',
      aggregatorVisitId: 'vis1',
      coalesceKey: 'VALIDATE_VISIT:c1:vis1',
    })
    expect(prismaMock.aggregatorOutbox.create.mock.calls[1][0].data.aggregatorVisitId).toBe('vis2')
  })
})

describe('expireVisits', () => {
  // nuevo · C12 (P3-20): una visita vencida ya no dice «Reintentando…» (el texto operativo de la bandeja)
  it('marca EXPIRED las PENDING vencidas y reemplaza el último error por el del vencimiento', async () => {
    prismaMock.aggregatorVisit.updateMany.mockResolvedValueOnce({ count: 3 } as any)
    await expect(expireVisits(NOW)).resolves.toBe(3)
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0]).toEqual({
      where: { status: 'PENDING', deadlineAt: { lt: NOW } },
      data: { status: 'EXPIRED', lastError: 'Venció sin confirmarse a tiempo.' },
    })
  })
  // nuevo
  it('sin vencidas ⇒ 0', async () => {
    prismaMock.aggregatorVisit.updateMany.mockResolvedValueOnce({ count: 0 } as any)
    await expect(expireVisits(NOW)).resolves.toBe(0)
  })
})
