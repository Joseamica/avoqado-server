/**
 * Aparatos claros, Paso 1: lo que la ficha del aparato agrega para decir su papel, su comanda y su menú (campos opcionales).
 */
const mockPrisma: any = {
  venueAreaTicketSettings: { findUnique: jest.fn() },
  terminalMenu: { findMany: jest.fn() },
}
const mockFeature = jest.fn()
jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('../../../../src/services/access/basePlan.service', () => ({ venueHasFeatureAccess: (...a: unknown[]) => mockFeature(...a) }))

import { extrasDeLaFicha } from '../../../../src/services/dashboard/tpvDetailExtras'

const VENUE = 'v1'
const PC = { id: 't1', type: 'POS_ANDROID' as const, version: '2.25.33-escritorio' }
const MENU = { id: 'm1', name: 'Cremería y Panadería' }

beforeEach(() => {
  jest.clearAllMocks()
  mockFeature.mockResolvedValue(true)
  mockPrisma.venueAreaTicketSettings.findUnique.mockResolvedValue({ enabled: true })
  mockPrisma.terminalMenu.findMany.mockResolvedValue([{ menu: MENU }])
})

describe('extrasDeLaFicha', () => {
  it('vales prendidos y plan: areaTicketsEnabled; los menús elegidos con su nombre', async () => {
    expect(await extrasDeLaFicha(VENUE, PC)).toEqual({
      areaTicketsEnabled: true,
      deviceMenus: { menus: [MENU], needsAppUpdate: false },
    })
    expect(mockPrisma.terminalMenu.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { terminalId: 't1', menu: { venueId: VENUE, active: true, appliesToDevices: true } } }),
    )
  })

  it('vales apagados en el negocio o sin plan: false', async () => {
    mockPrisma.venueAreaTicketSettings.findUnique.mockResolvedValue({ enabled: false })
    expect((await extrasDeLaFicha(VENUE, PC)).areaTicketsEnabled).toBe(false)
    mockPrisma.venueAreaTicketSettings.findUnique.mockResolvedValue({ enabled: true })
    mockFeature.mockImplementation((_v: string, code: string) => Promise.resolve(code !== 'AREA_TICKETS'))
    expect((await extrasDeLaFicha(VENUE, PC)).areaTicketsEnabled).toBe(false)
  })

  it('sin menús elegidos = «Todos» (lista vacía)', async () => {
    mockPrisma.terminalMenu.findMany.mockResolvedValue([])
    expect((await extrasDeLaFicha(VENUE, PC)).deviceMenus).toEqual({ menus: [], needsAppUpdate: false })
  })

  it('sin el plan del menú del aparato la elección no aplica: «Todos», como en la PC', async () => {
    mockFeature.mockImplementation((_v: string, code: string) => Promise.resolve(code !== 'DEVICE_MENUS'))
    expect((await extrasDeLaFicha(VENUE, PC)).deviceMenus).toEqual({ menus: [], needsAppUpdate: false })
  })

  it('con una app que todavía no aplica el menú: needsAppUpdate', async () => {
    expect((await extrasDeLaFicha(VENUE, { ...PC, version: '2.22.2-escritorio' })).deviceMenus).toEqual({
      menus: [MENU],
      needsAppUpdate: true,
    })
  })

  it('una terminal de cobro (TPV) no tiene menú del aparato: no lee menús', async () => {
    const r = await extrasDeLaFicha(VENUE, { ...PC, type: 'TPV_ANDROID' as any })
    expect(r).toEqual({ areaTicketsEnabled: true })
    expect(mockPrisma.terminalMenu.findMany).not.toHaveBeenCalled()
  })

  it('si algo falla, la ficha sigue: sin campos extra', async () => {
    mockPrisma.venueAreaTicketSettings.findUnique.mockRejectedValue(new Error('se cayó'))
    expect(await extrasDeLaFicha(VENUE, PC)).toEqual({})
  })
})
