/**
 * `broadcastTpvCommand` (sockets/index.ts) — el comando va por el carril DIRIGIDO.
 *
 * Es la otra mitad del arreglo del 7-sep-2026: de nada sirve que exista
 * `broadcastToTerminal` si el emisor real de `tpv_command` sigue llamando a
 * `broadcastToVenue`. Esta prueba fija QUÉ carril usa cada evento:
 *  · `tpv_command` (la orden que ejecuta un aparato)   → sólo la terminal destinataria;
 *  · `tpv_command_sent` (aviso para el dashboard)      → el venue, como siempre.
 */
const sm = {
  getServer: jest.fn(() => ({})),
  broadcastToVenue: jest.fn(),
  broadcastToTerminal: jest.fn(),
}

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: sm,
  socketManager: sm,
  SocketManager: class {},
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { broadcastTpvCommand } from '@/communication/sockets'

const WHITE = 'AVQD-2841653112'

beforeEach(() => jest.clearAllMocks())

describe('broadcastTpvCommand — qué carril usa cada evento', () => {
  it('🔴 `tpv_command` viaja SÓLO a la terminal destinataria, con los ids del TpvCommandQueue', () => {
    broadcastTpvCommand(WHITE, 'testarudo', {
      type: 'FACTORY_RESET',
      payload: {},
      requestedBy: 'superadmin-1',
      commandId: 'cmd-cuid',
      correlationId: 'corr-uuid',
    })

    expect(sm.broadcastToTerminal).toHaveBeenCalledTimes(1)
    const [venueId, terminalId, event, payload] = sm.broadcastToTerminal.mock.calls[0]
    expect(venueId).toBe('testarudo')
    expect(terminalId).toBe(WHITE)
    expect(event).toBe('tpv_command')
    expect(payload).toMatchObject({ terminalId: WHITE, commandId: 'cmd-cuid', correlationId: 'corr-uuid', type: 'FACTORY_RESET' })

    // 🔴 La guarda que importa: `tpv_command` NUNCA sale por el carril del venue.
    const alVenue = sm.broadcastToVenue.mock.calls.map(([, event]) => event)
    expect(alVenue).not.toContain('tpv_command')
  })

  it('`tpv_command_sent` sigue yendo al venue entero: es informativo, lo consume el dashboard', () => {
    broadcastTpvCommand(WHITE, 'testarudo', { type: 'LOCK', payload: {}, requestedBy: 'admin-1' })

    expect(sm.broadcastToVenue).toHaveBeenCalledWith(
      'testarudo',
      'tpv_command_sent',
      expect.objectContaining({ terminalId: WHITE, command: 'LOCK' }),
      undefined,
    )
  })
})
