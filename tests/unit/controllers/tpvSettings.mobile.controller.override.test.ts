import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'
import { UpdateVenueSettingsSchema } from '@/schemas/dashboard/venueSettings.schema'

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

describe('GET /mobile/venues/:venueId/settings — managerPinOverrideEnabled', () => {
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

  // 1. NUEVO
  it('devuelve true cuando el venue lo activó', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue({
      promotionsPanelCashier: 'TAB',
      promotionsPanelCustomer: 'SIDE_PANEL',
      managerPinOverrideEnabled: true,
    })
    await getVenueTpvSettings(req as Request, res as Response, next)
    expect(json.mock.calls[0][0].data.managerPinOverrideEnabled).toBe(true)
  })

  it('devuelve false cuando el venue no tiene fila de settings (nace OFF)', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue(null)
    await getVenueTpvSettings(req as Request, res as Response, next)
    expect(json.mock.calls[0][0].data.managerPinOverrideEnabled).toBe(false)
  })

  it('lo pide explícitamente en el select — si no, llegaría undefined y el POS lo leería como apagado', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue(null)
    await getVenueTpvSettings(req as Request, res as Response, next)
    expect(prisma.venueSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ managerPinOverrideEnabled: true }) }),
    )
  })

  it('el PUT del dashboard acepta el campo', () => {
    const parsed = UpdateVenueSettingsSchema.safeParse({
      params: { venueId: 'venue_1' },
      body: { managerPinOverrideEnabled: true },
      query: {},
    })
    expect(parsed.success).toBe(true)
    expect((parsed as any).data.body.managerPinOverrideEnabled).toBe(true)
  })

  // 2. REGRESIÓN: el contrato viejo no se movió
  it('sigue devolviendo terminals, settings, activeTerminalId, deviceTerminal y promotions', async () => {
    ;(prisma.venueSettings.findUnique as jest.Mock).mockResolvedValue(null)
    await getVenueTpvSettings(req as Request, res as Response, next)
    const data = json.mock.calls[0][0].data
    expect(data).toHaveProperty('terminals')
    expect(data).toHaveProperty('settings')
    expect(data).toHaveProperty('activeTerminalId')
    expect(data).toHaveProperty('deviceTerminal')
    expect(data.promotions).toEqual({ panelCashier: 'TAB', panelCustomer: 'SIDE_PANEL' })
  })
})
