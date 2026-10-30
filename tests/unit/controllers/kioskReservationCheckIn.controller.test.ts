jest.mock('@/services/reservation/kioskCheckIn.service', () => ({
  ...jest.requireActual('@/services/reservation/kioskCheckIn.service'),
  kioskCheckInReservation: jest.fn(async (a: any) => ({ reservationId: a.reservationId, orderId: null })),
}))

import { kioskReservationCheckIn } from '@/controllers/kiosk/kioskCheckIn.controller'
import { kioskCheckInReservation } from '@/services/reservation/kioskCheckIn.service'

/**
 * 0.e — el cuerpo del check-in del kiosco se valida en el borde: un `msBeforeClose` enorme volvía inválida la hora
 * del toque y terminaba en un 500 (RangeError al formatear la hora). Ahora es un 400 con mensaje en español.
 */
async function call(body: unknown) {
  const req: any = { params: { venueId: 'venue-1', reservationId: 'r1' }, body, authContext: { venueId: 'venue-1' } }
  const res: any = { setHeader: jest.fn(), json: jest.fn() }
  const next = jest.fn()
  await kioskReservationCheckIn(req, res, next)
  return { res, err: next.mock.calls[0]?.[0] }
}

beforeEach(() => (kioskCheckInReservation as jest.Mock).mockClear())

describe('POST …/kiosk/reservations/:reservationId/check-in — cuerpo', () => {
  it('msBeforeClose = 1e20 ⇒ 400 en español, sin llegar al servicio', async () => {
    const { err } = await call({ closesAt: '2026-10-28T19:20:00.000Z', msBeforeClose: 1e20 })
    expect(err).toMatchObject({ statusCode: 400, message: 'Tiempo fuera de rango' })
    expect(kioskCheckInReservation).not.toHaveBeenCalled()
  })

  it.each([
    [{ closesAt: 'ayer', msBeforeClose: 60_000 }, 'Hora de cierre inválida'],
    [{ closesAt: 123, msBeforeClose: 60_000 }, 'Hora de cierre inválida'],
    [{ closesAt: '2026-10-28T19:20:00.000Z', msBeforeClose: 'mucho' }, 'Tiempo inválido'],
    [{ closesAt: '2026-10-28T19:20:00.000Z', msBeforeClose: 1.5 }, 'Tiempo inválido'],
    [{ closesAt: '2026-10-28T19:20:00.000Z' }, 'Manda closesAt y msBeforeClose juntos'],
  ])('%j ⇒ 400 «%s»', async (body, message) => {
    const { err } = await call(body)
    expect(err).toMatchObject({ statusCode: 400, message })
    expect(kioskCheckInReservation).not.toHaveBeenCalled()
  })

  it('cuerpo vacío = toque en vivo; con los dos = toque guardado sin red', async () => {
    await call({})
    expect(kioskCheckInReservation).toHaveBeenLastCalledWith(expect.objectContaining({ reservationId: 'r1', tapped: undefined }))

    await call({ closesAt: '2026-10-28T19:20:00.000Z', msBeforeClose: 15 * 60_000 })
    expect(kioskCheckInReservation).toHaveBeenLastCalledWith(
      expect.objectContaining({ tapped: { closesAt: new Date('2026-10-28T19:20:00.000Z'), msBeforeClose: 15 * 60_000 } }),
    )
  })
})
