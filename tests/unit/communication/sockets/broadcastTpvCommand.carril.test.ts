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

/**
 * La caducidad del comando NO puede depender del reloj de la terminal.
 *
 * 24-sep-2026, Nexgo `AVQD-N860W173570`: seis FACTORY_RESET rechazados en 0.2 s con
 * «Command expired before execution». El socket le inventaba 5 min de vida (en vez de los
 * 30 del comando en la cola) y la terminal los comparaba contra SU reloj, que iba 9.2 min
 * adelantado. `expiresInSeconds` le dice cuánto le QUEDA: la terminal lo suma a su propio
 * «ahora» y su hora del día deja de importar.
 */
describe('broadcastTpvCommand — caducidad', () => {
  const AHORA = new Date('2026-09-24T17:48:33.000Z').getTime()
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(AHORA))
  afterEach(() => jest.restoreAllMocks())

  const payloadEmitido = () => sm.broadcastToTerminal.mock.calls[0][3]

  it('🔴 usa la caducidad REAL del comando en la cola, no 5 min inventados', () => {
    const expiresAt = new Date(AHORA + 30 * 60 * 1000)
    broadcastTpvCommand(WHITE, 'testarudo', { type: 'FACTORY_RESET', payload: {}, requestedBy: 'sa', commandId: 'c', expiresAt })

    expect(payloadEmitido().expiresAt).toBe(expiresAt.toISOString())
  })

  it('🔴 manda cuánto le QUEDA en segundos, para no depender del reloj de la terminal', () => {
    const expiresAt = new Date(AHORA + 30 * 60 * 1000)
    broadcastTpvCommand(WHITE, 'testarudo', { type: 'FACTORY_RESET', payload: {}, requestedBy: 'sa', commandId: 'c', expiresAt })

    expect(payloadEmitido().expiresInSeconds).toBe(1800)
  })

  it('un comando ya vencido viaja con 0 segundos, nunca negativo', () => {
    broadcastTpvCommand(WHITE, 'testarudo', {
      type: 'LOCK',
      payload: {},
      requestedBy: 'sa',
      expiresAt: new Date(AHORA - 60 * 1000),
    })

    expect(payloadEmitido().expiresInSeconds).toBe(0)
  })

  it('sin caducidad conocida conserva el default de 5 min, y lo dice en segundos', () => {
    broadcastTpvCommand(WHITE, 'testarudo', { type: 'LOCK', payload: {}, requestedBy: 'sa' })

    expect(payloadEmitido().expiresAt).toBe(new Date(AHORA + 5 * 60 * 1000).toISOString())
    expect(payloadEmitido().expiresInSeconds).toBe(300)
  })
})

describe('broadcastTpvCommand — regresión del aviso al dashboard', () => {
  it('`tpv_command_sent` no cambia con la caducidad', () => {
    broadcastTpvCommand(WHITE, 'testarudo', { type: 'LOCK', payload: {}, requestedBy: 'admin-1' })

    expect(sm.broadcastToVenue).toHaveBeenCalledWith(
      'testarudo',
      'tpv_command_sent',
      expect.objectContaining({ terminalId: WHITE, command: 'LOCK' }),
      undefined,
    )
  })
})
