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
  RESERVATION_INCLUDE: { customer: true },
}))

import { checkInMethodFor, checkInReservation, undoCheckIn, type CheckInActor } from '@/services/reservation/checkIn.service'

/**
 * Asistencia verificada (16-nov-2026, spec D-B): cada llegada guarda CÓMO se demostró y, si fue a mano o desde la lista
 * de una app vieja, QUIÉN la marcó. Es lo que Pago al personal desglosa («6 con celular · 1 con teléfono · 1 a mano»).
 */
const HUMAN: CheckInActor = { type: 'HUMAN', staffId: 'staff-1' }
const KIOSK: CheckInActor = { type: 'SERVICE', servicePrincipalId: 'kiosk' }
const NOW = new Date('2026-11-16T18:00:00.000Z')

function mkTx(row: Partial<any> = {}) {
  const reservation = {
    id: 'res-1',
    venueId: 'v1',
    confirmationCode: 'RES-1',
    status: 'CONFIRMED',
    startsAt: NOW,
    productId: 'svc-1',
    productIds: [],
    statusLog: [],
    ...row,
  }
  return {
    reservation: {
      findFirst: jest.fn(async () => reservation),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => ({ ...reservation, status: 'CHECKED_IN' })),
    },
    activityLog: { create: jest.fn(async () => ({})) },
    venue: { findUniqueOrThrow: jest.fn(async () => ({ organizationId: 'org-1' })) },
    product: { findMany: jest.fn(async () => []) },
    aggregatorVisit: { findMany: jest.fn(async () => []) },
    order: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    reservationNoShowCorrection: { findUnique: jest.fn(async () => null) },
    payment: { findFirst: jest.fn(async () => null) },
    $executeRaw: jest.fn(async () => 1),
  } as any
}

describe('checkInMethodFor — el método y quién', () => {
  it('panel, POS y MCP sin método explícito ⇒ «a mano» con la persona', () => {
    expect(checkInMethodFor({ source: 'DASHBOARD', actor: HUMAN })).toEqual({ checkInMethod: 'STAFF', checkedInByStaffId: 'staff-1' })
    expect(checkInMethodFor({ source: 'POS_ANDROID', actor: HUMAN }).checkInMethod).toBe('STAFF')
    expect(checkInMethodFor({ source: 'MCP', actor: HUMAN }).checkInMethod).toBe('STAFF')
  })
  it('pases ⇒ PASS, sin persona', () => {
    expect(checkInMethodFor({ source: 'PASS', actor: { type: 'SERVICE', servicePrincipalId: 'aggregator:x' } })).toEqual({
      checkInMethod: 'PASS',
      checkedInByStaffId: null,
    })
  })
  it('kiosco sin método ⇒ lista de app vieja, con la sesión del aparato', () => {
    expect(checkInMethodFor({ source: 'KIOSK', actor: KIOSK, byStaffId: 'staff-aparato' })).toEqual({
      checkInMethod: 'KIOSK_LIST',
      checkedInByStaffId: 'staff-aparato',
    })
  })
  it('🔴 QR y teléfono no guardan persona: los demostró la propia clienta', () => {
    expect(checkInMethodFor({ source: 'KIOSK', actor: KIOSK, method: 'QR', byStaffId: 'staff-aparato' })).toEqual({
      checkInMethod: 'QR',
      checkedInByStaffId: null,
    })
    expect(checkInMethodFor({ source: 'KIOSK', actor: KIOSK, method: 'PHONE' }).checkedInByStaffId).toBeNull()
  })
})

describe('checkInReservation guarda el método en la reserva, el statusLog y el ActivityLog', () => {
  it('QR del kiosco', async () => {
    const tx = mkTx()
    await checkInReservation(tx, { reservationId: 'res-1', venueId: 'v1', actor: KIOSK, source: 'KIOSK', now: NOW, method: 'QR' })
    const data = tx.reservation.updateMany.mock.calls[0][0].data
    expect(data.checkInMethod).toBe('QR')
    expect(data.checkedInByStaffId).toBeNull()
    expect(data.statusLog.at(-1)).toMatchObject({ status: 'CHECKED_IN', source: 'KIOSK', method: 'QR' })
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toMatchObject({ source: 'KIOSK', method: 'QR' })
  })

  it('a mano desde el panel lleva quién', async () => {
    const tx = mkTx()
    await checkInReservation(tx, { reservationId: 'res-1', venueId: 'v1', actor: HUMAN, source: 'DASHBOARD', now: NOW })
    const data = tx.reservation.updateMany.mock.calls[0][0].data
    expect(data).toMatchObject({ checkInMethod: 'STAFF', checkedInByStaffId: 'staff-1' })
  })

  it('una llegada repetida no cambia el método (gana la primera, no escribe)', async () => {
    const tx = mkTx({ status: 'CHECKED_IN', checkInMethod: 'QR' })
    const out = await checkInReservation(tx, { reservationId: 'res-1', venueId: 'v1', actor: HUMAN, source: 'DASHBOARD', now: NOW })
    expect(out.outcome).toBe('ALREADY_CHECKED_IN')
    expect(tx.reservation.updateMany).not.toHaveBeenCalled()
  })
})

describe('undoCheckIn limpia el método', () => {
  it('al deshacer la llegada, método y quién vuelven a null', async () => {
    const tx = mkTx({ status: 'CHECKED_IN', checkInMethod: 'STAFF', checkedInByStaffId: 'staff-1', checkedInAt: NOW })
    await undoCheckIn(tx, { reservationId: 'res-1', venueId: 'v1', actor: HUMAN, source: 'DASHBOARD', now: NOW } as any)
    const call = tx.reservation.updateMany.mock.calls[0]
    expect(call).toBeDefined()
    expect(call[0].data).toMatchObject({ checkInMethod: null, checkedInByStaffId: null, checkedInAt: null })
  })
})

describe('opId de una cola: nunca se vuelve a aplicar (Codex r2 #3)', () => {
  it('si la historia ya trae ese opId, contesta «ya estaba» sin escribir aunque hoy esté deshecha', async () => {
    const tx = mkTx({ status: 'CONFIRMED', statusLog: [{ status: 'CHECKED_IN', opId: 'fila-1' }, { status: 'CONFIRMED' }] })
    const out = await checkInReservation(tx, {
      reservationId: 'res-1',
      venueId: 'v1',
      actor: KIOSK,
      source: 'KIOSK',
      now: NOW,
      method: 'PHONE',
      opId: 'fila-1',
    })
    expect(out.outcome).toBe('ALREADY_CHECKED_IN')
    expect(tx.reservation.updateMany).not.toHaveBeenCalled()
  })
})
