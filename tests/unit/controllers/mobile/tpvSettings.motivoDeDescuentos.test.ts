import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findMany: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
  },
}))
jest.mock('@/services/access/basePlan.service', () => ({ getVenuePlanInfo: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/dashboard/tpv.dashboard.service', () => ({ getTpvSettings: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

describe('GET /mobile/venues/:venueId/settings — motivo en los descuentos (encargo f998c8)', () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: NextFunction
  let json: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    json = jest.fn()
    res = { json } as any
    next = jest.fn()
    req = { params: { venueId: 'venue_1' }, headers: {} } as any
    ;(prisma.terminal.findMany as jest.Mock).mockResolvedValue([])
    // receiptInfo fuera de foco aquí: null ⇒ el bloque se omite y el contrato
    // viejo queda byte a byte (lo cubre tpvSettings.mobile.controller.test.ts).
    ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue(null)
  })

  const llamar = () => getVenueTpvSettings(req as Request, res as Response, next)

  it('entrega el switch y la lista que guardó el negocio', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({
      discountReasonRequired: true,
      discountReasons: ['Error de captura', 'Cliente frecuente'],
    })
    await llamar()
    const data = json.mock.calls[0][0].data
    expect(data.discountReasonRequired).toBe(true)
    expect(data.discountReasons).toEqual(['Error de captura', 'Cliente frecuente'])
  })

  it('sin fila de ajustes: apagado y sin lista (el POS no pide nada, como hoy)', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue(null)
    await llamar()
    const data = json.mock.calls[0][0].data
    expect(data.discountReasonRequired).toBe(false)
    expect(data.discountReasons).toEqual([])
  })

  it('los pide en el select (si no, llegarían undefined y el POS nunca preguntaría)', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue(null)
    await llamar()
    expect(prisma.venueSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ discountReasonRequired: true, discountReasons: true }) }),
    )
  })

  it('regresión: managerPinOverrideEnabled y promotions siguen saliendo igual', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({ managerPinOverrideEnabled: true })
    await llamar()
    const data = json.mock.calls[0][0].data
    expect(data.managerPinOverrideEnabled).toBe(true)
    expect(data.promotions).toEqual({ panelCashier: 'TAB', panelCustomer: 'SIDE_PANEL' })
  })
})
