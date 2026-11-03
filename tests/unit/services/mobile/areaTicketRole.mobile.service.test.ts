/**
 * D3 (2-nov-2026): el aparato guarda su propio papel en los vales desde «¿Qué hará este aparato?».
 *
 * Sólo su propia terminal (id + negocio + X-Device-Id), sólo con los vales prendidos, y por el MISMO escritor que el panel
 * (`updateTerminal`), con fuente `pos`. Elegir caja apaga emitir y quita el área; elegir un área apaga cobrar (Codex r1 #1:
 * un aparato que emite siempre emite). Entregar nunca se toca desde el aparato.
 */
jest.mock('@/services/dashboard/areaTicket.dashboard.service', () => ({
  updateTerminal: jest.fn(),
}))
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  assertAreaTicketsEnabled: jest.fn(),
  resolveTerminal: jest.fn(),
  getAreaTicketSettings: jest.fn(),
}))

import { updateTerminal } from '@/services/dashboard/areaTicket.dashboard.service'
import { assertAreaTicketsEnabled, getAreaTicketSettings, resolveTerminal } from '@/services/mobile/areaTicketV7.mobile.service'
import { setTerminalAreaRole } from '@/services/mobile/areaTicketRole.mobile.service'
import { capabilitiesForRole } from '@/services/shared/areaTicketRole'
import { areaRoleSchema } from '@/schemas/mobile/areaTicketRole.schema'

describe('capabilitiesForRole', () => {
  it('caja: cobra, no emite y sin área', () => {
    expect(capabilitiesForRole({ role: 'CHECKOUT' })).toEqual({
      canIssueAreaTickets: false,
      canCheckoutAreaTickets: true,
      fulfillmentAreaId: null,
    })
  })

  it('emite vales de un área: emite, no cobra y con su área', () => {
    expect(capabilitiesForRole({ role: 'ISSUE', fulfillmentAreaId: 'area-cremeria' })).toEqual({
      canIssueAreaTickets: true,
      canCheckoutAreaTickets: false,
      fulfillmentAreaId: 'area-cremeria',
    })
  })
})

describe('areaRoleSchema', () => {
  const body = (b: unknown) => areaRoleSchema.safeParse({ body: b })

  it('acepta los dos papeles', () => {
    expect(body({ role: 'CHECKOUT' }).success).toBe(true)
    expect(body({ role: 'ISSUE', fulfillmentAreaId: 'area-cremeria' }).success).toBe(true)
  })

  it('rechaza emitir sin área', () => {
    expect(body({ role: 'ISSUE' }).success).toBe(false)
  })

  it('rechaza «también cobra»: la combinación no funciona en el aparato', () => {
    expect(body({ role: 'ISSUE', fulfillmentAreaId: 'area-cremeria', alsoCheckout: true }).success).toBe(false)
  })

  it('un dato de más se rechaza con mensaje en español, no el genérico de Zod', () => {
    for (const extra of [
      { role: 'ISSUE', fulfillmentAreaId: 'area-cremeria', alsoCheckout: true },
      { role: 'CHECKOUT', fulfillmentAreaId: 'area-cremeria' },
    ]) {
      const issues = JSON.stringify(body(extra).error?.issues)
      expect(issues).toContain('El papel del aparato trae un dato de más')
      expect(issues).not.toContain('Unrecognized key')
    }
  })

  it('rechaza un papel desconocido, con mensaje en español', () => {
    const result = body({ role: 'DELIVER' })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('El papel del aparato no es válido')
  })
})

describe('setTerminalAreaRole', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(assertAreaTicketsEnabled as jest.Mock).mockResolvedValue({ enabled: true })
    ;(resolveTerminal as jest.Mock).mockResolvedValue({ id: 'terminal-cremeria' })
    ;(updateTerminal as jest.Mock).mockResolvedValue({ id: 'terminal-cremeria' })
    ;(getAreaTicketSettings as jest.Mock).mockResolvedValue({ terminal: { id: 'terminal-cremeria', roleChoicePending: false } })
  })

  it('guarda el papel del propio aparato por el escritor del panel, con fuente pos', async () => {
    const result = await setTerminalAreaRole({
      venueId: 'venue-tienda',
      terminalId: 'terminal-cremeria',
      deviceUid: 'device-cremeria',
      staffId: 'staff-admin',
      choice: { role: 'ISSUE', fulfillmentAreaId: 'area-cremeria' },
    })

    expect(updateTerminal).toHaveBeenCalledWith(
      'venue-tienda',
      'terminal-cremeria',
      { canIssueAreaTickets: true, canCheckoutAreaTickets: false, fulfillmentAreaId: 'area-cremeria' },
      'staff-admin',
      { source: 'pos' },
    )
    expect(getAreaTicketSettings).toHaveBeenCalledWith('venue-tienda', 'device-cremeria')
    expect(result.terminal.roleChoicePending).toBe(false)
  })

  it('otro aparato no puede cambiar el papel de esa terminal', async () => {
    ;(resolveTerminal as jest.Mock).mockResolvedValue({ id: 'terminal-caja' })

    await expect(
      setTerminalAreaRole({
        venueId: 'venue-tienda',
        terminalId: 'terminal-cremeria',
        deviceUid: 'device-caja',
        staffId: 'staff-admin',
        choice: { role: 'CHECKOUT' },
      }),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Este aparato no es esa terminal.' })
    expect(updateTerminal).not.toHaveBeenCalled()
  })

  it('con los vales apagados no cambia nada', async () => {
    const disabled = Object.assign(new Error('Los vales por área no están habilitados para este local.'), {
      statusCode: 403,
      code: 'AREA_TICKETS_DISABLED',
    })
    ;(assertAreaTicketsEnabled as jest.Mock).mockRejectedValue(disabled)

    await expect(
      setTerminalAreaRole({
        venueId: 'venue-tienda',
        terminalId: 'terminal-cremeria',
        deviceUid: 'device-cremeria',
        staffId: 'staff-admin',
        choice: { role: 'CHECKOUT' },
      }),
    ).rejects.toMatchObject({ code: 'AREA_TICKETS_DISABLED' })
    expect(updateTerminal).not.toHaveBeenCalled()
  })
})
