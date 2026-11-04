/**
 * D2 de vales (3-nov-2026): el POS apaga o prende la comanda del área que ESE aparato emite. Sólo la suya, con los vales
 * prendidos, y por el mismo escritor que el panel (`updateArea`), con fuente `pos` y la terminal.
 */
jest.mock('@/services/dashboard/areaTicket.dashboard.service', () => ({ updateArea: jest.fn() }))
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  assertAreaTicketsEnabled: jest.fn(),
  resolveTerminal: jest.fn(),
  getAreaTicketSettings: jest.fn(),
}))

import { updateArea } from '@/services/dashboard/areaTicket.dashboard.service'
import { assertAreaTicketsEnabled, getAreaTicketSettings, resolveTerminal } from '@/services/mobile/areaTicketV7.mobile.service'
import { setAreaComandaFromPos } from '@/services/mobile/areaComanda.mobile.service'
import { areaComandaSchema } from '@/schemas/mobile/areaComanda.schema'

const entrada = { venueId: 'venue-1', areaId: 'area-cremeria', deviceUid: 'device-cremeria', staffId: 'staff-1', sendsComanda: false }

describe('setAreaComandaFromPos (D2)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(assertAreaTicketsEnabled as jest.Mock).mockResolvedValue({ enabled: true })
    ;(resolveTerminal as jest.Mock).mockResolvedValue({ id: 'terminal-cremeria', canIssueAreaTickets: true, fulfillmentAreaId: 'area-cremeria' })
    ;(getAreaTicketSettings as jest.Mock).mockResolvedValue({ venueId: 'venue-1' })
  })

  it('cambia el área del propio aparato por el escritor del panel, con fuente pos y la terminal', async () => {
    const r = await setAreaComandaFromPos(entrada)
    expect(updateArea).toHaveBeenCalledWith('venue-1', 'area-cremeria', { sendsComanda: false }, 'staff-1', {
      source: 'pos',
      terminalId: 'terminal-cremeria',
      soloSiEmite: 'terminal-cremeria',
    })
    expect(getAreaTicketSettings).toHaveBeenCalledWith('venue-1', 'device-cremeria')
    expect(r).toEqual({ venueId: 'venue-1' })
  })

  it('un área que este aparato no emite no se toca', async () => {
    await expect(setAreaComandaFromPos({ ...entrada, areaId: 'area-cafeteria' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'AREA_NOT_OF_THIS_DEVICE',
    })
    ;(resolveTerminal as jest.Mock).mockResolvedValue({ id: 'terminal-caja', canIssueAreaTickets: false, fulfillmentAreaId: 'area-cremeria' })
    await expect(setAreaComandaFromPos(entrada)).rejects.toMatchObject({ statusCode: 403 })
    expect(updateArea).not.toHaveBeenCalled()
  })

  it('con los vales apagados no cambia nada', async () => {
    ;(assertAreaTicketsEnabled as jest.Mock).mockRejectedValue(Object.assign(new Error('apagados'), { code: 'AREA_TICKETS_DISABLED' }))
    await expect(setAreaComandaFromPos(entrada)).rejects.toMatchObject({ code: 'AREA_TICKETS_DISABLED' })
    expect(updateArea).not.toHaveBeenCalled()
  })

  it('el cuerpo sólo lleva sendsComanda booleano', () => {
    const ok = (body: unknown) => areaComandaSchema.safeParse({ params: { venueId: 'v', areaId: 'a' }, body }).success
    expect(ok({ sendsComanda: false })).toBe(true)
    expect(ok({ sendsComanda: 'no' })).toBe(false)
    expect(ok({})).toBe(false)
    expect(ok({ sendsComanda: true, otra: 1 })).toBe(false)
  })
})
