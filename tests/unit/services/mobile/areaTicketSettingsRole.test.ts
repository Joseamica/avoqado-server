/**
 * D3 (2-nov-2026): la app sabe si debe preguntar «¿Qué hará este aparato?» y con qué áreas.
 *
 * Sólo pregunta un aparato que se dio de alta solo y cuyo papel nunca se eligió, en un negocio con vales prendidos y al
 * menos un área activa. `areas` es nuevo y opcional: una app vieja lo ignora; una app nueva distingue «campo ausente»
 * (servidor viejo) de «lista vacía».
 */
jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
}))

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { getAreaTicketSettings } from '@/services/mobile/areaTicketV7.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const NUEVO = {
  id: 'terminal-cremeria',
  name: 'PC de la cremería',
  fulfillmentAreaId: null,
  canIssueAreaTickets: false,
  canCheckoutAreaTickets: false,
  canDeliverAreaTickets: false,
  defaultWorkspace: 'STANDARD_POS',
  selfRegistered: true,
  areaRoleChosenAt: null,
  scaleProfile: null,
  fulfillmentArea: null,
}

const AREAS = [
  { id: 'area-cremeria', name: 'Cremería' },
  { id: 'area-panaderia', name: 'Panadería' },
]

describe('getAreaTicketSettings — papel del aparato (D3)', () => {
  beforeEach(() => {
    ;(venueHasFeatureAccess as jest.Mock).mockImplementation(async (_venueId: string, code: string) => code === 'AREA_TICKETS')
    prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({ enabled: true })
    prismaMock.venueScaleSettings.findUnique.mockResolvedValue(null)
    prismaMock.terminal.findFirst.mockResolvedValue(NUEVO)
    prismaMock.fulfillmentArea.findMany.mockResolvedValue(AREAS)
    prismaMock.fulfillmentArea.count.mockResolvedValue(2)
  })

  it('pregunta a un aparato nuevo que se dio de alta solo, con las áreas activas', async () => {
    const settings = await getAreaTicketSettings('venue-tienda', 'device-cremeria')

    expect(settings.terminal.roleChoicePending).toBe(true)
    expect(settings.areas).toEqual(AREAS)
    expect(settings.areasTotal).toBe(2)
  })

  it('no pregunta si el papel ya se eligió', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ ...NUEVO, areaRoleChosenAt: new Date('2026-11-02T20:00:00Z') })

    const settings = await getAreaTicketSettings('venue-tienda', 'device-cremeria')

    expect(settings.terminal.roleChoicePending).toBe(false)
  })

  it('no pregunta a una terminal que dio de alta el administrador', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ ...NUEVO, selfRegistered: false })

    const settings = await getAreaTicketSettings('venue-tienda', 'device-cremeria')

    expect(settings.terminal.roleChoicePending).toBe(false)
  })

  it('sin vales prendidos no manda áreas ni pregunta', async () => {
    prismaMock.venueAreaTicketSettings.findUnique.mockResolvedValue({ enabled: false })

    const settings = await getAreaTicketSettings('venue-tienda', 'device-cremeria')

    expect(settings.areas).toEqual([])
    expect(settings.areasTotal).toBe(0)
    expect(settings.terminal.roleChoicePending).toBe(false)
    expect(prismaMock.fulfillmentArea.findMany).not.toHaveBeenCalled()
  })

  it('sin áreas activas no pregunta', async () => {
    prismaMock.fulfillmentArea.findMany.mockResolvedValue([])
    prismaMock.fulfillmentArea.count.mockResolvedValue(0)

    const settings = await getAreaTicketSettings('venue-tienda', 'device-cremeria')

    expect(settings.terminal.roleChoicePending).toBe(false)
  })

  it('las áreas salen acotadas y del negocio, y el total sale del conteo y no del largo de la lista', async () => {
    prismaMock.fulfillmentArea.count.mockResolvedValue(250)

    const settings = await getAreaTicketSettings('venue-tienda', 'device-cremeria')

    expect(prismaMock.fulfillmentArea.findMany).toHaveBeenCalledWith({
      where: { venueId: 'venue-tienda', active: true },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 200,
    })
    expect(prismaMock.fulfillmentArea.count).toHaveBeenCalledWith({ where: { venueId: 'venue-tienda', active: true } })
    expect(settings.areasTotal).toBe(250)
  })
})
