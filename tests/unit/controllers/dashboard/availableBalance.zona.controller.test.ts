/**
 * «Cuándo cae (semana)» y el calendario de Saldo disponible con la zona guardada como «GMT-6» (altas viejas, no es IANA): la tarjeta
 * semanal del Resumen de ventas tronaba al convertir la fecha (hz:fefa11b6:D15, Codex r2 del carril F). La misma zona del cálculo que
 * el resumen y su exporte: la Ciudad de México.
 */
import type { Request, Response } from 'express'

const mockSemana = jest.fn()
const mockLimites = jest.fn()
const mockCalendario = jest.fn()

jest.mock('@/services/dashboard/settlementCalendar.dashboard.service', () => ({
  getSettlementsLandingInWeek: (...a: unknown[]) => mockSemana(...a),
  venueWeekBounds: (...a: unknown[]) => mockLimites(...a),
}))
jest.mock('@/services/dashboard/availableBalance.dashboard.service', () => ({
  getSettlementCalendar: (...a: unknown[]) => mockCalendario(...a),
}))

import { getSettlementWeek } from '@/controllers/dashboard/availableBalance.dashboard.controller'
import { prismaMock } from '@tests/__helpers__/setup'

const res = () => {
  const r: Record<string, jest.Mock> = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r as unknown as Response
}
const req = { params: { venueId: 'v1' }, query: {} } as unknown as Request<{ venueId: string }, {}, {}, { weekStart?: string }>

beforeEach(() => {
  jest.clearAllMocks()
  mockLimites.mockReturnValue({ weekStart: '2026-11-23', weekEnd: '2026-11-29' })
  mockSemana.mockResolvedValue({ days: [] })
})

it('🔴 la semana con la zona guardada como «GMT-6» se calcula en America/Mexico_City', async () => {
  ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'GMT-6' })
  const next = jest.fn()
  await getSettlementWeek(req, res(), next)
  expect(next).not.toHaveBeenCalled()
  expect(mockLimites).toHaveBeenCalledWith(undefined, 'America/Mexico_City')
  expect(mockSemana).toHaveBeenCalledWith('v1', '2026-11-23', '2026-11-29', 'America/Mexico_City')
})

it('control · una zona IANA válida llega tal cual', async () => {
  ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Tijuana' })
  await getSettlementWeek(req, res(), jest.fn())
  expect(mockSemana).toHaveBeenCalledWith('v1', '2026-11-23', '2026-11-29', 'America/Tijuana')
})
