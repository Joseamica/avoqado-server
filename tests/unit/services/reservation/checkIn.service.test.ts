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
  attachServices: jest.fn(async (r: any) => ({ ...r, services: [{ id: 'svc-1', name: 'Yoga' }] })),
  RESERVATION_INCLUDE: { customer: true },
}))

import {
  deriveCheckInSource,
  evaluateKioskWindow,
  decideCheckIn,
  checkInReservation,
  type CheckInActor,
} from '@/services/reservation/checkIn.service'
import { getReservationSettings } from '@/services/dashboard/reservationSettings.service'

/**
 * Fase 0.C — check-in PURO (spec §0.C, tests 1-5, 7-8, 11-15, 19).
 * Cambia estado + statusLog + ActivityLog DENTRO de la tx; NO crea orden; idempotente.
 */
const HUMAN: CheckInActor = { type: 'HUMAN', staffId: 'staff-1', organizationId: 'org-1' }
const SERVICE: CheckInActor = { type: 'SERVICE', servicePrincipalId: 'kiosk-device-1', organizationId: 'org-1' }
const NOW = new Date('2026-08-22T18:00:00.000Z')

function mkTx(row: Partial<any>, opts: { casCount?: number; rereadStatus?: string; logThrows?: boolean } = {}) {
  const reservation = {
    id: 'res-1',
    venueId: 'v1',
    confirmationCode: 'RES-1',
    status: 'CONFIRMED',
    startsAt: NOW,
    statusLog: [{ status: 'CONFIRMED', at: '2026-08-22T10:00:00.000Z', by: null }],
    ...row,
  }
  const tx: any = {
    reservation: {
      findFirst: jest.fn(async () => reservation),
      updateMany: jest.fn(async () => ({ count: opts.casCount ?? 1 })),
      findUniqueOrThrow: jest.fn(async () => ({ ...reservation, status: opts.rereadStatus ?? 'CHECKED_IN', checkedInAt: NOW })),
    },
    activityLog: {
      create: jest.fn(async () => {
        if (opts.logThrows) throw new Error('activity log down')
        return {}
      }),
    },
    order: { findFirst: jest.fn(), create: jest.fn() },
  }
  return tx
}

const base = { reservationId: 'res-1', venueId: 'v1', actor: HUMAN, source: 'DASHBOARD' as const, now: NOW }

describe('deriveCheckInSource — de la credencial, nunca del cliente (test 19)', () => {
  it('sin header → DASHBOARD', () => expect(deriveCheckInSource(undefined)).toBe('DASHBOARD'))
  it('ANDROID → POS_ANDROID', () => expect(deriveCheckInSource('ANDROID')).toBe('POS_ANDROID'))
  it('IOS → POS_IOS', () => expect(deriveCheckInSource('IOS')).toBe('POS_IOS'))
  it('🔴 "KIOSK" u otro valor inventado → DASHBOARD (un JWT de staff NUNCA produce KIOSK)', () => {
    expect(deriveCheckInSource('KIOSK')).toBe('DASHBOARD')
    expect(deriveCheckInSource('WEB')).toBe('DASHBOARD')
    expect(deriveCheckInSource(['ANDROID'])).toBe('DASHBOARD')
  })
})

describe('evaluateKioskWindow — startsAt−20min ≤ now < startsAt+grace (test 11, 13)', () => {
  const startsAt = new Date('2026-08-22T18:00:00.000Z')
  const at = (offsetMs: number) => new Date(startsAt.getTime() + offsetMs)
  it('−21 min → fuera', () => expect(evaluateKioskWindow({ startsAt, now: at(-21 * 60_000), noShowGraceMin: 15 })).toBe(false))
  it('−20 min exacto → dentro (≤)', () => expect(evaluateKioskWindow({ startsAt, now: at(-20 * 60_000), noShowGraceMin: 15 })).toBe(true))
  it('+grace −1 s → dentro', () => expect(evaluateKioskWindow({ startsAt, now: at(15 * 60_000 - 1000), noShowGraceMin: 15 })).toBe(true))
  it('+grace exacto → fuera (estricto <, igual que el job de no-show)', () =>
    expect(evaluateKioskWindow({ startsAt, now: at(15 * 60_000), noShowGraceMin: 15 })).toBe(false))
  it('grace=0 → cierra en startsAt exacto', () => {
    expect(evaluateKioskWindow({ startsAt, now: at(-1000), noShowGraceMin: 0 })).toBe(true)
    expect(evaluateKioskWindow({ startsAt, now: at(0), noShowGraceMin: 0 })).toBe(false)
  })
})

describe('decideCheckIn', () => {
  it('PENDING y CONFIRMED → TRANSITION', () => {
    expect(decideCheckIn('PENDING')).toBe('TRANSITION')
    expect(decideCheckIn('CONFIRMED')).toBe('TRANSITION')
  })
  it('CHECKED_IN → ALREADY', () => expect(decideCheckIn('CHECKED_IN')).toBe('ALREADY'))
  it('NO_SHOW / CANCELLED / COMPLETED → NOT_CHECKINABLE', () => {
    expect(decideCheckIn('NO_SHOW')).toBe('NOT_CHECKINABLE')
    expect(decideCheckIn('CANCELLED')).toBe('NOT_CHECKINABLE')
    expect(decideCheckIn('COMPLETED')).toBe('NOT_CHECKINABLE')
  })
})

describe('checkInReservation (puro, dentro de tx)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('test 1: PENDING → CHECKED_IN con CAS sobre status IN (PENDING, CONFIRMED), checkedInAt y statusLog', async () => {
    const tx = mkTx({ status: 'PENDING' })
    const r = await checkInReservation(tx, base)

    expect(r.outcome).toBe('CHECKED_IN')
    expect(tx.reservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'res-1', venueId: 'v1', status: { in: ['PENDING', 'CONFIRMED'] } },
        data: expect.objectContaining({ status: 'CHECKED_IN', checkedInAt: NOW }),
      }),
    )
    const data = tx.reservation.updateMany.mock.calls[0][0].data
    expect(data.statusLog.at(-1)).toEqual(expect.objectContaining({ status: 'CHECKED_IN', by: 'staff-1', source: 'DASHBOARD' }))
  })

  it('test 2: CONFIRMED → CHECKED_IN, y devuelve { reservation, services } con los servicios reservados', async () => {
    const tx = mkTx({ status: 'CONFIRMED' })
    const r = await checkInReservation(tx, base)
    expect(r.outcome).toBe('CHECKED_IN')
    expect(r.reservation.status).toBe('CHECKED_IN')
    expect(r.services).toEqual([{ id: 'svc-1', name: 'Yoga' }])
  })

  it('test 3: CHECKED_IN → mismo outcome, SIN escribir (idempotente)', async () => {
    const tx = mkTx({ status: 'CHECKED_IN', checkedInAt: NOW })
    const r = await checkInReservation(tx, base)
    expect(r.outcome).toBe('ALREADY_CHECKED_IN')
    expect(tx.reservation.updateMany).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('test 4: NO_SHOW → 409 RESERVATION_NOT_CHECKINABLE, sin escribir', async () => {
    const tx = mkTx({ status: 'NO_SHOW' })
    await expect(checkInReservation(tx, base)).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_NOT_CHECKINABLE' })
    expect(tx.reservation.updateMany).not.toHaveBeenCalled()
  })

  it('test 5: es PURO — nunca toca Order', async () => {
    const tx = mkTx({ status: 'CONFIRMED' })
    await checkInReservation(tx, base)
    expect(tx.order.findFirst).not.toHaveBeenCalled()
    expect(tx.order.create).not.toHaveBeenCalled()
  })

  it('test 7: ActivityLog HUMAN dentro de la tx cumple la constraint: actorType HUMAN, organizationId, staffId = actorStaffId, sin servicePrincipalId', async () => {
    const tx = mkTx({ status: 'CONFIRMED' })
    await checkInReservation(tx, base)
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: 'HUMAN',
        organizationId: 'org-1',
        staffId: 'staff-1',
        actorStaffId: 'staff-1',
        servicePrincipalId: null,
        venueId: 'v1',
        action: 'RESERVATION_CHECKED_IN',
        entity: 'Reservation',
        entityId: 'res-1',
        data: expect.objectContaining({ source: 'DASHBOARD' }),
      }),
    })
  })

  it('actor SERVICE → actorType SERVICE + servicePrincipalId, staffId y actorStaffId null', async () => {
    const tx = mkTx({ status: 'CONFIRMED' })
    await checkInReservation(tx, { ...base, actor: SERVICE, source: 'KIOSK' })
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorType: 'SERVICE', servicePrincipalId: 'kiosk-device-1', staffId: null, actorStaffId: null }),
    })
  })

  it('test 8: si el ActivityLog falla, el error se propaga (la tx revierte el estado)', async () => {
    const tx = mkTx({ status: 'CONFIRMED' }, { logThrows: true })
    await expect(checkInReservation(tx, base)).rejects.toThrow('activity log down')
  })

  it('test 11: KIOSK fuera de ventana (−21 min) → 422 CHECK_IN_OUTSIDE_WINDOW, sin escribir', async () => {
    const tx = mkTx({ status: 'CONFIRMED', startsAt: new Date(NOW.getTime() + 21 * 60_000) })
    await expect(checkInReservation(tx, { ...base, actor: SERVICE, source: 'KIOSK' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'CHECK_IN_OUTSIDE_WINDOW',
    })
    expect(tx.reservation.updateMany).not.toHaveBeenCalled()
  })

  it('test 11: KIOSK en +grace exacto → 422; en +grace −1 s → ok', async () => {
    const grace = 15
    const exact = mkTx({ status: 'CONFIRMED', startsAt: new Date(NOW.getTime() - grace * 60_000) })
    await expect(checkInReservation(exact, { ...base, actor: SERVICE, source: 'KIOSK' })).rejects.toMatchObject({ statusCode: 422 })

    const justBefore = mkTx({ status: 'CONFIRMED', startsAt: new Date(NOW.getTime() - grace * 60_000 + 1000) })
    await expect(checkInReservation(justBefore, { ...base, actor: SERVICE, source: 'KIOSK' })).resolves.toMatchObject({
      outcome: 'CHECKED_IN',
    })
  })

  it('test 12: POS_ANDROID a +1 h → ok (sin ventana para COUNTER/DASHBOARD/MCP)', async () => {
    const tx = mkTx({ status: 'CONFIRMED', startsAt: new Date(NOW.getTime() - 60 * 60_000) })
    await expect(checkInReservation(tx, { ...base, source: 'POS_ANDROID' })).resolves.toMatchObject({ outcome: 'CHECKED_IN' })
    expect(getReservationSettings).not.toHaveBeenCalled() // sólo KIOSK consulta la gracia
  })

  it('test 13/14: KIOSK lee noShowGraceMin de los settings del venue (con la tx); sin fila → default del servicio', async () => {
    ;(getReservationSettings as jest.Mock).mockResolvedValueOnce({ scheduling: { noShowGraceMin: 0 } })
    const tx = mkTx({ status: 'CONFIRMED', startsAt: NOW }) // now === startsAt, grace 0 → cerrado
    await expect(checkInReservation(tx, { ...base, actor: SERVICE, source: 'KIOSK' })).rejects.toMatchObject({ statusCode: 422 })
    expect(getReservationSettings).toHaveBeenCalledWith('v1', tx)
  })

  it('test 15 (carrera con no-show): CAS pierde y la relectura dice NO_SHOW → 409', async () => {
    const tx = mkTx({ status: 'CONFIRMED' }, { casCount: 0, rereadStatus: 'NO_SHOW' })
    await expect(checkInReservation(tx, base)).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_NOT_CHECKINABLE' })
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('test 9 (carrera con otro check-in): CAS pierde y la relectura dice CHECKED_IN → ALREADY_CHECKED_IN sin segundo ActivityLog', async () => {
    const tx = mkTx({ status: 'CONFIRMED' }, { casCount: 0, rereadStatus: 'CHECKED_IN' })
    const r = await checkInReservation(tx, base)
    expect(r.outcome).toBe('ALREADY_CHECKED_IN')
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('reserva inexistente en el venue → 404', async () => {
    const tx = mkTx({})
    tx.reservation.findFirst.mockResolvedValue(null)
    await expect(checkInReservation(tx, base)).rejects.toMatchObject({ statusCode: 404 })
  })
})
