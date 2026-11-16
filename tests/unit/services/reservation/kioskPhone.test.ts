import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/reservationSettings.service', () => ({
  __esModule: true,
  getReservationSettings: jest.fn(async () => ({ scheduling: { noShowGraceMin: 10 } })),
}))
jest.mock('@/services/reservation/checkIn.service', () => {
  const real = jest.requireActual('@/services/reservation/checkIn.service')
  return { __esModule: true, ...real, checkInReservation: jest.fn() }
})
jest.mock('@/services/reservation/undoNoShow.service', () => ({ __esModule: true, undoNoShow: jest.fn() }))
jest.mock('@/services/reservation/noShowNotices.service', () => ({
  __esModule: true,
  afterNoShowCorrection: jest.fn(async () => undefined),
  notifyNoShowNeedsReview: jest.fn(async () => undefined),
}))

import { checkInReservation } from '@/services/reservation/checkIn.service'
import { undoNoShow } from '@/services/reservation/undoNoShow.service'
import { afterNoShowCorrection } from '@/services/reservation/noShowNotices.service'
import { checkInByIdentifier } from '@/services/reservation/kioskCheckIn.service'
import { ConflictError } from '@/errors/AppError'

/**
 * Asistencia verificada (16-nov-2026, spec D-D): la alumna sin celular teclea su teléfono en el kiosco. Cuenta, marcada
 * «con teléfono» (decisión «C» del founder). Sin red, el aparato la guarda con la hora estimada del servidor y su id de
 * fila, y la manda después.
 */
const V = 'venue-1'
const NOW = new Date('2026-11-16T18:00:00Z')
const CLASE = new Date('2026-11-16T18:05:00Z')
const yoga = { name: 'Yoga', layoutConfig: { spots: [{ id: 't4', label: 'Tapete 4' }] } }

function reserva(over: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    status: 'CONFIRMED',
    startsAt: CLASE,
    guestName: null,
    statusLog: [],
    spotIds: ['t4'],
    customer: { firstName: 'Ana', lastName: 'Ruiz' },
    classSession: { assignedStaff: { firstName: 'María' }, product: yoga },
    product: yoga,
    ...over,
  }
}

const base = { venueId: V, terminalId: null, stationKey: 'B', identifier: '55 1234 5678', now: NOW }

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  prismaMock.kioskCheckInAttempt.upsert.mockResolvedValue({ count: 1 } as any)
  prismaMock.reservation.findFirst.mockResolvedValue(reserva() as any)
  ;(checkInReservation as jest.Mock).mockResolvedValue({ outcome: 'CHECKED_IN', reservation: {}, services: [] })
})

describe('Teléfono tecleado en el kiosco', () => {
  it('en vivo: llegada «con teléfono», y la confirmación trae nombre corto y lugar', async () => {
    const out = await checkInByIdentifier(base)
    expect(out.outcome).toBe('CHECKED_IN')
    expect(out.display).toMatchObject({ displayName: 'Ana R.', spotLabel: 'Tapete 4', staffLabel: 'con María' })
    expect((checkInReservation as jest.Mock).mock.calls[0][1]).toMatchObject({ method: 'PHONE', source: 'KIOSK', now: NOW })
    // Una cancelada del mismo teléfono no tapa a la buena; sin cola, «No asistió» no entra.
    expect((prismaMock.reservation.findFirst.mock.calls[0][0] as any).where.status).toEqual({ in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] })
  })

  it('desde la cola sin red: busca la clase por la hora en que se tecleó, no por ahora', async () => {
    const tecleado = new Date('2026-11-16T17:50:00Z')
    const later = new Date('2026-11-16T19:30:00Z')
    await checkInByIdentifier({ ...base, now: later, occurredAt: tecleado, opId: 'fila-1234' })
    const where = (prismaMock.reservation.findFirst.mock.calls[0][0] as any).where
    expect(where.startsAt).toEqual({ gte: new Date('2026-11-16T17:40:00Z'), lte: new Date('2026-11-16T18:10:00Z') })
    expect((checkInReservation as jest.Mock).mock.calls[0][1]).toMatchObject({ now: tecleado, method: 'PHONE', opId: 'fila-1234' })
  })

  it('desde la cola, el «No asistió» automático ya había corrido ⇒ se corrige con la hora tecleada y se avisa', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue(reserva({ status: 'NO_SHOW' }) as any)
    ;(undoNoShow as jest.Mock).mockResolvedValue({ outcome: 'UNDONE', correction: { id: 'corr-1' } })
    const tecleado = new Date('2026-11-16T17:58:00Z')
    const out = await checkInByIdentifier({ ...base, now: new Date('2026-11-16T19:00:00Z'), occurredAt: tecleado, opId: 'fila-1' })
    expect(out.outcome).toBe('CHECKED_IN')
    expect((undoNoShow as jest.Mock).mock.calls[0][1]).toMatchObject({ arrivedAt: tecleado, method: 'PHONE', opId: 'fila-1' })
    expect(afterNoShowCorrection).toHaveBeenCalledWith('corr-1')
  })

  it('🔴 en vivo, un «No asistió» no se corrige desde el kiosco (eso es del panel: «Sí llegó»)', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue(null)
    await expect(checkInByIdentifier(base)).rejects.toMatchObject({ statusCode: 404 })
    expect(undoNoShow).not.toHaveBeenCalled()
  })

  it('🔴 Codex r1 #5: la gerente deshizo la llegada y la cola reintenta la misma fila ⇒ «ya registrada», sin volver a marcar', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue(
      reserva({
        status: 'CONFIRMED',
        statusLog: [
          { status: 'CHECKED_IN', opId: 'fila-1', method: 'PHONE' },
          { status: 'CONFIRMED', by: 'gerente' },
        ],
      }) as any,
    )
    const out = await checkInByIdentifier({ ...base, occurredAt: new Date('2026-11-16T17:59:00Z'), opId: 'fila-1' })
    expect(out.outcome).toBe('ALREADY_CHECKED_IN')
    expect(checkInReservation).not.toHaveBeenCalled()
  })

  it('una hora futura (más de 1 min) ⇒ 422', async () => {
    await expect(checkInByIdentifier({ ...base, occurredAt: new Date('2026-11-16T18:02:00Z'), opId: 'fila-1' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'CHECK_IN_OUTSIDE_WINDOW',
    })
  })

  it('guardada hace más de 72 h ⇒ 422 CHECK_IN_TOO_OLD', async () => {
    await expect(checkInByIdentifier({ ...base, occurredAt: new Date('2026-11-13T17:00:00Z'), opId: 'fila-1' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'CHECK_IN_TOO_OLD',
    })
    expect(prismaMock.reservation.findFirst).not.toHaveBeenCalled()
  })

  it('🔴 Codex r2 #3: desde la cola, «ya estaba registrada» también deja su opId (un reintento tras deshacer no re-marca)', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue(reserva({ status: 'CHECKED_IN' }) as any)
    ;(prismaMock.$executeRaw as jest.Mock).mockResolvedValue(1)
    const out = await checkInByIdentifier({ ...base, occurredAt: new Date('2026-11-16T17:59:00Z'), opId: 'fila-9' })
    expect(out.outcome).toBe('ALREADY_CHECKED_IN')
    const [pedazos, ...valores] = (prismaMock.$executeRaw as jest.Mock).mock.calls[0] as [string[], ...unknown[]]
    expect(pedazos.join('?')).toMatch(/"status" = 'CHECKED_IN'/)
    expect(String(valores[0])).toContain('"opId":"fila-9"')
    expect(checkInReservation).not.toHaveBeenCalled()
  })

  it('🔴 Codex r2 #4: el «No asistió» gana entre la lectura y el check-in ⇒ desde la cola se corrige igual', async () => {
    ;(checkInReservation as jest.Mock).mockRejectedValue(new ConflictError('cambió', 'RESERVATION_NOT_CHECKINABLE'))
    prismaMock.reservation.findFirst.mockResolvedValueOnce(reserva() as any).mockResolvedValueOnce({ status: 'NO_SHOW' } as any)
    ;(undoNoShow as jest.Mock).mockResolvedValue({ outcome: 'UNDONE', correction: { id: 'corr-9' } })
    const out = await checkInByIdentifier({
      ...base,
      now: new Date('2026-11-16T18:30:00Z'),
      occurredAt: new Date('2026-11-16T17:59:00Z'),
      opId: 'fila-2',
    })
    expect(out.outcome).toBe('CHECKED_IN')
    expect(undoNoShow).toHaveBeenCalled()
  })

  it('Codex r2 #5: la cola tiene 30 intentos por minuto para su teléfono; lo tecleado en vivo, 5', async () => {
    await checkInByIdentifier({ ...base, occurredAt: new Date('2026-11-16T17:59:00Z'), opId: 'fila-3' })
    await checkInByIdentifier(base)
    const ups = prismaMock.kioskCheckInAttempt.upsert.mock.calls.map(c => (c[0] as any).where.venueId_scope_windowStart.scope)
    expect(ups.filter((x: string) => x.startsWith('identifier:'))).toHaveLength(2)
  })
})
