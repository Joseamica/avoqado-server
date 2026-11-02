jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/reservationSettings.service', () => ({
  __esModule: true,
  getReservationSettings: jest.fn(async () => ({ scheduling: { noShowGraceMin: 10 } })),
}))
jest.mock('@/services/reservation/checkIn.service', () => ({
  ...jest.requireActual('@/services/reservation/checkIn.service'),
  checkInReservationAndOpenOrder: jest.fn(),
}))
jest.mock('@/services/reservation/undoNoShow.service', () => ({
  ...jest.requireActual('@/services/reservation/undoNoShow.service'),
  undoNoShow: jest.fn(),
}))
jest.mock('@/services/reservation/noShowNotices.service', () => ({
  __esModule: true,
  afterNoShowCorrection: jest.fn(async () => {}),
  notifyNoShowNeedsReview: jest.fn(async () => {}),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { ConflictError, ValidationError } from '@/errors/AppError'
import {
  CHECK_IN_OUTSIDE_WINDOW,
  RESERVATION_NOT_CHECKINABLE,
  checkInReservationAndOpenOrder as realWrapper,
} from '@/services/reservation/checkIn.service'
import { NO_SHOW_UNDO_PASS_BOOKING, undoNoShow as realUndo } from '@/services/reservation/undoNoShow.service'
import { afterNoShowCorrection, notifyNoShowNeedsReview } from '@/services/reservation/noShowNotices.service'
import { getKioskRoster, kioskCheckInReservation } from '@/services/reservation/kioskCheckIn.service'

/**
 * 0.e — la lista y el check-in PROPIOS del kiosco. El servidor calcula la ventana (el cliente no
 * manda rango), nunca devuelve teléfono ni correo, y el check-in usa la hora del TOQUE
 * (`closesAt − msBeforeClose`), sin ningún reloj del aparato.
 */
const checkInReservationAndOpenOrder = realWrapper as jest.MockedFunction<typeof realWrapper>
const undoNoShow = realUndo as jest.MockedFunction<typeof realUndo>
const V = 'venue-1'
const now = new Date('2026-10-28T19:00:00.000Z')

const yoga = { name: 'Yoga', layoutConfig: { spots: [{ id: 't4', label: 'Tapete 4' }] } }
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    status: 'CHECKED_IN',
    startsAt: new Date('2026-10-28T19:10:00.000Z'),
    classSessionId: 's1',
    spotIds: ['t4'],
    guestName: null,
    customer: { firstName: 'Ana', lastName: 'Ruiz', phone: '5512345678', email: 'a@x.mx' },
    product: yoga,
    assignedStaff: null,
    classSession: { product: yoga, assignedStaff: { firstName: 'María' } },
    ...over,
  }
}

beforeEach(() => {
  checkInReservationAndOpenOrder.mockReset()
  undoNoShow.mockReset()
  prismaMock.reservation.findMany.mockReset()
  prismaMock.reservation.findFirst.mockReset()
  prismaMock.reservationNoShowCorrection.findFirst.mockReset()
  prismaMock.notification.findFirst.mockReset()
  prismaMock.venue.findUniqueOrThrow.mockResolvedValue({ organizationId: 'org-1' } as any)
  prismaMock.activityLog.create.mockResolvedValue({} as any)
})

describe('getKioskRoster', () => {
  it('pide sólo la ventana: inicio en (ahora − tolerancia, ahora + 20 min], con tope', async () => {
    prismaMock.reservation.findMany.mockResolvedValue([])
    await getKioskRoster({ venueId: V, now })
    expect(prismaMock.reservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: V,
          status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
          startsAt: { gt: new Date('2026-10-28T18:50:00.000Z'), lte: new Date('2026-10-28T19:20:00.000Z') },
        }),
        orderBy: [{ startsAt: 'asc' }, { classSessionId: 'asc' }, { id: 'asc' }],
        take: 200,
      }),
    )
  })

  it('sin clase en ventana → null', async () => {
    prismaMock.reservation.findMany.mockResolvedValue([])
    await expect(getKioskRoster({ venueId: V, now })).resolves.toBeNull()
  })

  it('devuelve la clase que empieza primero, «Nombre I.», lugar y llegada; nunca teléfono ni correo', async () => {
    prismaMock.reservation.findMany.mockResolvedValue([
      row(),
      row({ id: 'r2', status: 'CONFIRMED', spotIds: [], customer: null, guestName: 'Luis Pérez Gómez' }),
      row({ id: 'r3', status: 'CONFIRMED', startsAt: new Date('2026-10-28T19:15:00.000Z'), classSessionId: 's2' }),
    ] as any)

    const r = await getKioskRoster({ venueId: V, now })

    expect(r!.classTitle).toBe('Yoga')
    expect(r!.staffFirstName).toBe('María')
    expect(r!.people).toHaveLength(2)
    expect(r!.people[0]).toEqual({ reservationId: 'r1', displayName: 'Ana R.', checkedIn: true, spotLabel: 'Tapete 4' })
    expect(r!.people[1]).toEqual({ reservationId: 'r2', displayName: 'Luis P.', checkedIn: false, spotLabel: null })
    expect(r!.closesAt).toEqual(new Date('2026-10-28T19:20:00.000Z'))
    expect(r!.closesInMs).toBe(20 * 60_000) // 19:10 + 10 min − 19:00
    expect(JSON.stringify(r)).not.toMatch(/5512345678|a@x\.mx/)
  })
})

describe('kioskCheckInReservation', () => {
  // La ventana de la reserva de prueba cierra a las 19:20Z: clase 19:10Z + 10 min de tolerancia.
  const vio = (ms: number, closesAt = '2026-10-28T19:20:00.000Z') => ({ closesAt: new Date(closesAt), msBeforeClose: ms })

  it('el check-in del kiosco va con source KIOSK y actor de servicio (el servidor vuelve a checar la ventana)', async () => {
    checkInReservationAndOpenOrder.mockResolvedValue({ orderId: 'o1' } as any)
    await expect(kioskCheckInReservation({ venueId: V, reservationId: 'r1', now })).resolves.toEqual({ reservationId: 'r1', orderId: 'o1' })
    expect(checkInReservationAndOpenOrder).toHaveBeenCalledWith({
      reservationId: 'r1',
      venueId: V,
      actor: { type: 'SERVICE', servicePrincipalId: 'kiosk' },
      source: 'KIOSK',
      now,
    })
  })

  it('usa la hora del toque: el cierre que vio la persona − msBeforeClose, sin ningún reloj del aparato', async () => {
    checkInReservationAndOpenOrder.mockResolvedValue({ orderId: 'o1' } as any)
    await kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: new Date('2026-10-28T19:45:00.000Z'), tapped: vio(15 * 60_000) })
    expect(checkInReservationAndOpenOrder).toHaveBeenCalledWith(expect.objectContaining({ now: new Date('2026-10-28T19:05:00.000Z') }))
  })

  it('reprogramada mientras no había red: manda la hora ORIGINAL y la ventana nueva la rechaza', async () => {
    // La reserva ya es de las 20:10; checkInReservation (real, dentro del wrapper) contesta 422 con now = 19:05.
    checkInReservationAndOpenOrder.mockRejectedValue(new ValidationError('fuera de ventana', CHECK_IN_OUTSIDE_WINDOW))
    await expect(
      kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: new Date('2026-10-28T20:06:00.000Z'), tapped: vio(15 * 60_000) }),
    ).rejects.toMatchObject({ code: 'CHECK_IN_OUTSIDE_WINDOW' })
    expect(checkInReservationAndOpenOrder).toHaveBeenCalledWith(expect.objectContaining({ now: new Date('2026-10-28T19:05:00.000Z') }))
  })

  it('un toque que quedaría en el futuro ⇒ 422 CHECK_IN_OUTSIDE_WINDOW sin tocar la reserva', async () => {
    await expect(
      kioskCheckInReservation({
        venueId: V,
        reservationId: 'r1',
        now: new Date('2026-10-28T19:45:00.000Z'),
        tapped: vio(15 * 60_000, '2026-10-28T21:20:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'CHECK_IN_OUTSIDE_WINDOW', statusCode: 422 })
    expect(checkInReservationAndOpenOrder).not.toHaveBeenCalled()
  })

  it('un toque de hace más de 72 h ⇒ 422 CHECK_IN_TOO_OLD y no toca la reserva', async () => {
    await expect(
      kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: new Date('2026-10-31T20:00:00.000Z'), tapped: vio(60_000) }),
    ).rejects.toMatchObject({ code: 'CHECK_IN_TOO_OLD', statusCode: 422 })
    expect(checkInReservationAndOpenOrder).not.toHaveBeenCalled()
  })

  // D4 — «No asistió» mientras no había red. La reserva es de las 19:10Z con 10 min de tolerancia: el SERVIDOR calcula el
  // cierre en 19:20Z, el mismo que la lista le dio al kiosco.
  const noShow = (over: Record<string, unknown> = {}) =>
    ({
      id: 'r1',
      status: 'NO_SHOW',
      startsAt: new Date('2026-10-28T19:10:00.000Z'),
      customer: { firstName: 'Ana', lastName: 'Ruiz' },
      guestName: null,
      venue: { timezone: 'America/Mexico_City' },
      ...over,
    }) as any
  const later = new Date('2026-10-28T19:45:00.000Z')
  const flush = () => new Promise(r => setImmediate(r))
  const rejectNotCheckinable = () =>
    checkInReservationAndOpenOrder.mockRejectedValueOnce(new ConflictError('no admite check-in', RESERVATION_NOT_CHECKINABLE))

  it.each([
    ['el mismo cierre', '2026-10-28T19:20:00.000Z', 15 * 60_000, '2026-10-28T19:05:00.000Z'],
    ['un cierre 60 s distinto (redondeo del aparato)', '2026-10-28T19:21:00.000Z', 16 * 60_000, '2026-10-28T19:05:00.000Z'],
  ])(
    '🔴 tapped + NO_SHOW + %s + toque en ventana ⇒ el SERVIDOR corrige solo (kiosco, hora del toque) y lo avisa',
    async (_, closesAt, ms, tappedAt) => {
      rejectNotCheckinable()
      checkInReservationAndOpenOrder.mockResolvedValueOnce({ orderId: null } as any) // ya CHECKED_IN: la rama «ya registrada»
      prismaMock.reservation.findFirst.mockResolvedValue(noShow())
      undoNoShow.mockResolvedValue({
        outcome: 'UNDONE',
        reservation: {},
        plan: {
          creditToReconsume: 0,
          clearFee: false,
          restoreDeposit: false,
          feeAmount: null,
          depositAmount: null,
          packName: null,
          pending: ['CLASS_UNPAID'],
        },
        correction: { id: 'c1', pending: ['CLASS_UNPAID'], resolvedAt: null },
      })
      prismaMock.reservationNoShowCorrection.findFirst.mockResolvedValue({ id: 'c1', pending: ['CLASS_UNPAID'] })

      const out = await kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: later, tapped: vio(ms, closesAt) })

      expect(out).toEqual({ reservationId: 'r1', orderId: null, correction: { id: 'c1', pending: ['CLASS_UNPAID'] } })
      expect(undoNoShow).toHaveBeenCalledTimes(1)
      expect(undoNoShow).toHaveBeenCalledWith(expect.anything(), {
        reservationId: 'r1',
        venueId: V,
        actor: { type: 'SERVICE', servicePrincipalId: 'kiosk' },
        source: 'KIOSK',
        now: later,
        arrivedAt: new Date(tappedAt),
      })
      expect(afterNoShowCorrection).toHaveBeenCalledWith('c1')
      expect(notifyNoShowNeedsReview).not.toHaveBeenCalled()
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled() // ni el rastro de «no se pudo»
    },
  )

  it('la corrección ya la hizo otra repetición en carrera (ALREADY_UNDONE) ⇒ éxito con su corrección, sin avisar dos veces', async () => {
    rejectNotCheckinable()
    checkInReservationAndOpenOrder.mockResolvedValueOnce({ orderId: null } as any)
    prismaMock.reservation.findFirst.mockResolvedValue(noShow())
    undoNoShow.mockResolvedValue({
      outcome: 'ALREADY_UNDONE',
      reservation: {},
      plan: {} as any,
      correction: { id: 'c1', pending: [], resolvedAt: null },
    })
    prismaMock.reservationNoShowCorrection.findFirst.mockResolvedValue({ id: 'c1', pending: [] })

    const out = await kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: later, tapped: vio(15 * 60_000) })

    expect(out).toEqual({ reservationId: 'r1', orderId: null, correction: { id: 'c1', pending: [] } })
    expect(afterNoShowCorrection).not.toHaveBeenCalled()
  })

  it('🔴 repetir la misma llegada ya corregida (respuesta perdida) ⇒ éxito con la MISMA corrección; una resuelta ya no se manda', async () => {
    checkInReservationAndOpenOrder.mockResolvedValue({ orderId: null } as any)
    prismaMock.reservationNoShowCorrection.findFirst.mockResolvedValue({ id: 'c1', pending: ['CLASS_UNPAID'] })

    const out = await kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: later, tapped: vio(15 * 60_000) })

    expect(out).toEqual({ reservationId: 'r1', orderId: null, correction: { id: 'c1', pending: ['CLASS_UNPAID'] } })
    expect(undoNoShow).not.toHaveBeenCalled()
    expect(prismaMock.reservationNoShowCorrection.findFirst).toHaveBeenCalledWith({
      where: { reservationId: 'r1', venueId: V, resolvedAt: null },
      select: { id: true, pending: true },
    })
  })

  it.each([
    // [caso, closesAt que mandó, msBeforeClose, hora local del toque, hora UTC del toque, ¿aviso KIOSK_UNVERIFIED?]
    [
      'un cierre que no es el del SERVIDOR (más de 60 s)',
      '2026-10-28T19:21:01.000Z',
      16 * 60_000 + 1_000,
      '13:05',
      '2026-10-28T19:05:00.000Z',
      true,
    ],
    ['un toque fuera de la ventana', '2026-10-28T19:20:00.000Z', 31 * 60_000, '12:49', '2026-10-28T18:49:00.000Z', false],
  ])(
    'no asistió mientras no había red con %s: 409 honesto de hoy, bitácora, y la reserva sigue igual',
    async (_, closesAt, ms, hora, tappedAt, avisa) => {
      rejectNotCheckinable()
      prismaMock.reservation.findFirst.mockResolvedValue(noShow()) // relectura tras el 409

      const err = await kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: later, tapped: vio(ms, closesAt) }).catch(e => e)
      await flush()

      expect(err).toMatchObject({ code: RESERVATION_NOT_CHECKINABLE, statusCode: 409 })
      expect(err.message).toBe(
        `Ana R. llegó a las ${hora} sin conexión, pero su reserva ya estaba como «No asistió». Si sí llegó, corrígelo con «Sí llegó».`,
      )
      expect(prismaMock.reservation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1', venueId: V } }))
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venueId: V,
            action: 'RESERVATION_KIOSK_CHECK_IN_AFTER_NO_SHOW',
            entity: 'Reservation',
            entityId: 'r1',
            actorType: 'SERVICE',
            servicePrincipalId: 'kiosk',
            organizationId: 'org-1',
            data: expect.objectContaining({ tappedAt, msBeforeClose: ms }),
          }),
        }),
      )
      expect(undoNoShow).not.toHaveBeenCalled()
      expect(prismaMock.reservation.update).not.toHaveBeenCalled()
      expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
      if (avisa) expect(notifyNoShowNeedsReview).toHaveBeenCalledWith({ venueId: V, reservationId: 'r1', reason: 'KIOSK_UNVERIFIED' })
      else expect(notifyNoShowNeedsReview).not.toHaveBeenCalled()
    },
  )

  it('la corrección no se puede (reserva de un pase) ⇒ el 409 de hoy con su bitácora, sin aviso', async () => {
    rejectNotCheckinable()
    prismaMock.reservation.findFirst.mockResolvedValue(noShow())
    undoNoShow.mockRejectedValue(new ConflictError('vino de un pase', NO_SHOW_UNDO_PASS_BOOKING))

    const err = await kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: later, tapped: vio(15 * 60_000) }).catch(e => e)
    await flush()

    expect(err).toMatchObject({ code: RESERVATION_NOT_CHECKINABLE, statusCode: 409 })
    expect(err.message).toMatch(/^Ana R\. llegó a las 13:05 sin conexión/)
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'RESERVATION_KIOSK_CHECK_IN_AFTER_NO_SHOW' }) }),
    )
    expect(afterNoShowCorrection).not.toHaveBeenCalled()
    expect(notifyNoShowNeedsReview).not.toHaveBeenCalled()
  })

  it('🔴 la corrección falla por la base (tiempo de espera, conexión) ⇒ el error sube (5xx, el aparato reintenta), sin 409 ni bitácora', async () => {
    rejectNotCheckinable()
    prismaMock.reservation.findFirst.mockResolvedValue(noShow())
    const timeout = Object.assign(new Error('Transaction API error: Transaction already closed'), { code: 'P2028' })
    undoNoShow.mockRejectedValue(timeout)

    const err = await kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: later, tapped: vio(15 * 60_000) }).catch(e => e)
    await flush()

    expect(err).toBe(timeout)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(afterNoShowCorrection).not.toHaveBeenCalled()
    expect(notifyNoShowNeedsReview).not.toHaveBeenCalled()
  })

  it('🔴 un toque de hace más de 72 h sobre un «No asistió» ⇒ el mismo 422 y UN aviso KIOSK_TOO_OLD por reserva', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue({ status: 'NO_SHOW' } as any)
    const tooOld = () =>
      kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: new Date('2026-10-31T20:00:00.000Z'), tapped: vio(60_000) })

    await expect(tooOld()).rejects.toMatchObject({ code: 'CHECK_IN_TOO_OLD', statusCode: 422 })
    await flush()
    expect(prismaMock.reservation.findFirst).toHaveBeenCalledWith({ where: { id: 'r1', venueId: V }, select: { status: true } })
    expect(notifyNoShowNeedsReview).toHaveBeenCalledTimes(1)
    expect(notifyNoShowNeedsReview).toHaveBeenCalledWith({ venueId: V, reservationId: 'r1', reason: 'KIOSK_TOO_OLD' })

    // La segunda vez ya hay campanita de esa reserva: no se vuelve a avisar.
    prismaMock.notification.findFirst.mockResolvedValue({ id: 'n1' })
    await expect(tooOld()).rejects.toMatchObject({ code: 'CHECK_IN_TOO_OLD', statusCode: 422 })
    await flush()
    expect(notifyNoShowNeedsReview).toHaveBeenCalledTimes(1)
    expect(prismaMock.notification.findFirst).toHaveBeenLastCalledWith({
      where: { venueId: V, type: 'RESERVATION_NEEDS_REVIEW', entityType: 'Reservation', entityId: 'r1' },
      select: { id: true },
    })
    expect(checkInReservationAndOpenOrder).not.toHaveBeenCalled()
  })

  it('un toque de hace más de 72 h sobre una reserva que NO es «No asistió» ⇒ el 422 de hoy, sin aviso', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue({ status: 'CONFIRMED' } as any)
    await expect(
      kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: new Date('2026-10-31T20:00:00.000Z'), tapped: vio(60_000) }),
    ).rejects.toMatchObject({ code: 'CHECK_IN_TOO_OLD', statusCode: 422 })
    await flush()
    expect(notifyNoShowNeedsReview).not.toHaveBeenCalled()
  })

  it('el mismo 409 SIN tapped (toque en vivo) se reenvía tal cual, sin bitácora', async () => {
    const original = new ConflictError('no admite check-in', RESERVATION_NOT_CHECKINABLE)
    checkInReservationAndOpenOrder.mockRejectedValue(original)
    await expect(kioskCheckInReservation({ venueId: V, reservationId: 'r1', now })).rejects.toBe(original)
    expect(prismaMock.reservation.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    expect(undoNoShow).not.toHaveBeenCalled()
  })

  it('409 con tapped pero la reserva NO está en «No asistió» (p. ej. cancelada) ⇒ se reenvía tal cual, sin bitácora', async () => {
    const original = new ConflictError('no admite check-in', RESERVATION_NOT_CHECKINABLE)
    checkInReservationAndOpenOrder.mockRejectedValue(original)
    prismaMock.reservation.findFirst.mockResolvedValue({
      id: 'r1',
      status: 'CANCELLED',
      customer: null,
      guestName: 'Ana Ruiz',
      venue: { timezone: 'America/Mexico_City' },
    } as any)
    await expect(
      kioskCheckInReservation({ venueId: V, reservationId: 'r1', now: new Date('2026-10-28T19:45:00.000Z'), tapped: vio(15 * 60_000) }),
    ).rejects.toBe(original)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})
