/**
 * Ajuste manual de sellos: el controlador NO usa getStaffVenueId (que lanza para un dueño de la organización sin fila
 * en StaffVenue). Y el GET de la cartilla dice `version` y `stampsEnabled`.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findUnique: jest.fn() },
    loyaltyConfig: { findUnique: jest.fn() },
    stampReward: { findMany: jest.fn() },
  },
}))
jest.mock('@/services/wallet/stampLedger.service', () => ({
  adjustStamps: jest.fn(),
  contarVersionDeCartilla: jest.fn(),
  getStampCardStatus: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { adjustStamps, contarVersionDeCartilla, getStampCardStatus } from '@/services/wallet/stampLedger.service'
import { adjustStampsHandler, getStampCardHandler } from '@/controllers/dashboard/loyalty.dashboard.controller'

const m = (f: unknown) => f as jest.Mock
const p = prisma as any

const res = () => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}
const body = {
  stampsEarned: 7,
  expectedStampCardId: 'c1',
  expectedStampsEarned: 3,
  expectedVersion: 2,
  expectedStampsRequired: 10,
  reason: 'Migración de cartón',
}
const req = (userId?: string): any => ({
  params: { venueId: 'v1', customerId: 'cu1' },
  body,
  authContext: userId ? { userId } : undefined,
})

beforeEach(() => jest.clearAllMocks())

describe('adjustStampsHandler', () => {
  it('dueño sin StaffVenue: llama a adjustStamps con staffVenueId undefined y actorStaffId = userId', async () => {
    p.staffVenue.findUnique.mockResolvedValue(null)
    m(adjustStamps).mockResolvedValue({ ok: true })
    const r = res()
    await adjustStampsHandler(req('st1'), r)
    expect(adjustStamps).toHaveBeenCalledWith('v1', 'cu1', { ...body, staffVenueId: undefined, actorStaffId: 'st1' })
    expect(r.status).toHaveBeenCalledWith(200)
    expect(r.json).toHaveBeenCalledWith({ ok: true })
  })
  it('con StaffVenue: pasa su id', async () => {
    p.staffVenue.findUnique.mockResolvedValue({ id: 'sv1' })
    m(adjustStamps).mockResolvedValue({ ok: true })
    await adjustStampsHandler(req('st1'), res())
    expect(p.staffVenue.findUnique).toHaveBeenCalledWith({
      where: { staffId_venueId: { staffId: 'st1', venueId: 'v1' } },
      select: { id: true },
    })
    expect(adjustStamps).toHaveBeenCalledWith('v1', 'cu1', expect.objectContaining({ staffVenueId: 'sv1', actorStaffId: 'st1' }))
  })
  it('sin authContext.userId responde 403', async () => {
    const r = res()
    await adjustStampsHandler(req(), r)
    expect(r.status).toHaveBeenCalledWith(403)
    expect(adjustStamps).not.toHaveBeenCalled()
  })
})

describe('getStampCardHandler', () => {
  beforeEach(() => {
    m(getStampCardStatus).mockResolvedValue({ stampCardId: 'c1', stampsEarned: 3 })
    m(contarVersionDeCartilla).mockResolvedValue(4)
    p.stampReward.findMany.mockResolvedValue([])
  })
  it('incluye version', async () => {
    p.loyaltyConfig.findUnique.mockResolvedValue({ active: true, stampsEnabled: true })
    const r = res()
    await getStampCardHandler(req('st1'), r)
    expect(contarVersionDeCartilla).toHaveBeenCalledWith('c1')
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ version: 4, stampsEnabled: true, stampsEarned: 3 }))
  })
  it.each([
    ['programa apagado', { active: false, stampsEnabled: true }],
    ['sellos apagados', { active: true, stampsEnabled: false }],
    ['sin config', null],
  ])('dice stampsEnabled:false con %s', async (_n, cfg) => {
    p.loyaltyConfig.findUnique.mockResolvedValue(cfg)
    const r = res()
    await getStampCardHandler(req('st1'), r)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ stampsEnabled: false }))
  })
})
