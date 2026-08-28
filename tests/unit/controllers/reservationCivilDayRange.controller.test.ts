/**
 * Un `YYYY-MM-DD` que Zod coerciona llega al controlador como MEDIANOCHE UTC.
 *
 * 🔴 El bug que originó estas pruebas (visto capturando la guía de reservaciones, 27-ago-2026):
 * la pantalla pedía las estadísticas de HOY con `dateFrom === dateTo === '2026-08-27'`, el
 * controlador hacía `new Date()` de las dos y consultaba `startsAt >= X AND startsAt <= X`
 * — una ventana de CERO milisegundos. Las cuatro tarjetas (Hoy · Pendientes · En curso ·
 * Tasa No Show) salían en 0 con cuatro reservas del día en la tabla de abajo, y la pestaña
 * «Hoy» de la lista no podía mostrar nada nunca.
 *
 * El día civil se interpreta en la zona del NEGOCIO, no en UTC ni en la del servidor.
 */
import * as controller from '@/controllers/dashboard/reservation.dashboard.controller'
import * as reservationService from '@/services/dashboard/reservation.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/dashboard/reservation.dashboard.service')

const statsSpy = reservationService.getReservationStats as jest.Mock
const listSpy = reservationService.getReservations as jest.Mock

function ctx(query: Record<string, unknown>) {
  const req = { params: { venueId: 'venue_1' }, query } as any
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as any
  const next = jest.fn()
  return { req, res, next }
}

function conZona(timezone: string | null) {
  ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ timezone })
}

beforeEach(() => {
  jest.clearAllMocks()
  statsSpy.mockResolvedValue({ total: 0, byStatus: {}, byChannel: {}, noShowRate: 0 })
  listSpy.mockResolvedValue({ data: [], meta: {} })
})

describe('el día civil de reservaciones se resuelve en la zona del negocio', () => {
  it('estadísticas: un solo día NO produce una ventana de cero milisegundos', async () => {
    conZona('America/Mexico_City')
    const { req, res, next } = ctx({ dateFrom: new Date('2026-08-27'), dateTo: new Date('2026-08-27') })

    await controller.getStats(req, res, next)

    expect(next).not.toHaveBeenCalled()
    const [, desde, hasta] = statsSpy.mock.calls[0]
    expect(hasta.getTime() - desde.getTime()).toBeGreaterThan(23 * 60 * 60_000)
    // México es UTC-6 todo el año (sin horario de verano desde 2022)
    expect(desde.toISOString()).toBe('2026-08-27T06:00:00.000Z')
    expect(hasta.toISOString()).toBe('2026-08-28T05:59:59.999Z')
  })

  it('estadísticas: una reserva de las 11:00 locales CAE dentro de la ventana', async () => {
    conZona('America/Mexico_City')
    const { req, res, next } = ctx({ dateFrom: new Date('2026-08-27'), dateTo: new Date('2026-08-27') })

    await controller.getStats(req, res, next)

    const [, desde, hasta] = statsSpy.mock.calls[0]
    const reservaDeHoy = new Date('2026-08-27T17:00:00.000Z') // 11:00 en México
    expect(reservaDeHoy >= desde && reservaDeHoy <= hasta).toBe(true)
  })

  it('estadísticas: la zona del negocio manda — Madrid no es México', async () => {
    conZona('Europe/Madrid')
    const { req, res, next } = ctx({ dateFrom: new Date('2026-08-27'), dateTo: new Date('2026-08-27') })

    await controller.getStats(req, res, next)

    const [, desde] = statsSpy.mock.calls[0]
    expect(desde.toISOString()).toBe('2026-08-26T22:00:00.000Z') // CEST = UTC+2
  })

  it('estadísticas: sin zona configurada cae a México, no a UTC', async () => {
    conZona(null)
    const { req, res, next } = ctx({ dateFrom: new Date('2026-08-27'), dateTo: new Date('2026-08-27') })

    await controller.getStats(req, res, next)

    expect(statsSpy.mock.calls[0][1].toISOString()).toBe('2026-08-27T06:00:00.000Z')
  })

  it('lista: la pestaña «Hoy» abarca el día entero del negocio', async () => {
    conZona('America/Mexico_City')
    const { req, res, next } = ctx({ dateFrom: new Date('2026-08-27'), dateTo: new Date('2026-08-27') })

    await controller.getReservations(req, res, next)

    expect(next).not.toHaveBeenCalled()
    const filtros = listSpy.mock.calls[0][1]
    expect(filtros.dateFrom.toISOString()).toBe('2026-08-27T06:00:00.000Z')
    expect(filtros.dateTo.toISOString()).toBe('2026-08-28T05:59:59.999Z')
  })

  it('lista: un INSTANTE explícito se respeta tal cual, no se estira al día completo', async () => {
    conZona('America/Mexico_City')
    const instante = new Date('2026-08-27T20:30:00.000Z')
    const { req, res, next } = ctx({ dateFrom: instante, dateTo: instante })

    await controller.getReservations(req, res, next)

    const filtros = listSpy.mock.calls[0][1]
    expect(filtros.dateFrom.toISOString()).toBe('2026-08-27T20:30:00.000Z')
    expect(filtros.dateTo.toISOString()).toBe('2026-08-27T20:30:00.000Z')
  })

  it('lista: sin fechas no se inventa un rango', async () => {
    conZona('America/Mexico_City')
    const { req, res, next } = ctx({})

    await controller.getReservations(req, res, next)

    const filtros = listSpy.mock.calls[0][1]
    expect(filtros.dateFrom).toBeUndefined()
    expect(filtros.dateTo).toBeUndefined()
  })
})
