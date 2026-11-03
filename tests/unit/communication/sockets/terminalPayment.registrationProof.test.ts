import { SocketManager } from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { terminalPaymentService } from '@/services/terminal-payment.service'

jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: {
    replayPendingForTerminal: jest.fn().mockResolvedValue(undefined),
    probeUnresolvedForTerminal: jest.fn().mockResolvedValue(0),
    handleProbeResultFromSocket: jest.fn().mockResolvedValue(true),
    handleCancelDispositionFromSocket: jest.fn().mockResolvedValue(true),
  },
}))

let connection: (socket: any) => void
let sockets: string[] = []
beforeEach(() => {
  jest.clearAllMocks()
  const manager = new SocketManager() as any
  manager.io = {
    on: jest.fn((_event, handler) => {
      connection = handler
    }),
  }
  manager.roomManager = { registerSocket: jest.fn() }
  manager.registerSocketEventHandlers = jest.fn()
  manager.setupEventHandlers()
})
afterEach(() => {
  sockets.forEach(id => terminalRegistry.unregisterBySocketId(id))
  sockets = []
})
function connect(claimed: string, signed?: string, socketId = 'proof-socket', auth: Record<string, unknown> = {}) {
  sockets.push(socketId)
  connection({
    id: socketId,
    handshake: { auth: { terminalId: claimed, terminalPaymentAckVersion: 1, terminalPaymentCancelDispositionVersion: 1, ...auth } },
    authContext: { userId: 'cashier', venueId: 'venue-proof', terminalSerialNumber: signed },
  })
}
describe('New proof registration boundaries', () => {
  it('signed device cannot register or replay another claimed terminal', () => {
    connect('terminal-b', 'terminal-a')
    expect(terminalRegistry.getTerminal('terminal-b')).toBeNull()
    // La sonda se llama en síncrono al conectar (la reentrega va después de su await): no llamarla prueba que no se arrancó nada.
    expect(terminalPaymentService.probeUnresolvedForTerminal).not.toHaveBeenCalled()
    expect(terminalPaymentService.replayPendingForTerminal).not.toHaveBeenCalled()
  })
  it('unsigned legacy handshake cannot advertise negative financial proof', () => {
    connect('legacy-terminal')
    const entry = terminalRegistry.getTerminal('legacy-terminal')
    expect(entry?.socketId).toBe('proof-socket')
    expect(entry?.terminalPaymentCancelDispositionVersion ?? 0).toBe(0)
    expect(entry?.terminalPaymentAckVersion ?? 0).toBe(0)
  })
  it('unsigned replacement cannot inherit verified capabilities from the previous socket', () => {
    connect('terminal-a', 'terminal-a', 'verified')
    connect('terminal-a', undefined, 'unverified')
    const entry = terminalRegistry.getTerminal('terminal-a')
    expect(entry?.socketId === 'verified' || (entry?.terminalPaymentCancelDispositionVersion ?? 0) === 0).toBe(true)
  })
})
describe('Existing signed delivery compatibility', () => {
  it('normalizes a signed serial before accepting the matching handshake', () => {
    connect('terminal-a', 'AVQD-TERMINAL-A')
    expect(terminalRegistry.getTerminal('terminal-a')?.socketId).toBe('proof-socket')
  })
})

describe('S1 · capacidad de ejecución cerrada (terminalPaymentExecutionVersion)', () => {
  const capacidades = { terminalPaymentProbeVersion: 1, terminalPaymentExecutionVersion: '1' }
  /** Los manejadores reales de la terminal, registrados sobre un socket falso con el venue del handshake. */
  function manejadores(socketId: string): Record<string, (payload: unknown, callback: (r: unknown) => void) => Promise<void>> {
    const registrados: Record<string, any> = {}
    const socket = { id: socketId, authContext: { venueId: 'venue-proof' }, on: jest.fn((ev: string, h: any) => (registrados[ev] = h)) }
    ;(SocketManager.prototype as any).registerSocketEventHandlers.call(new SocketManager(), socket)
    return registrados
  }
  const evidencia = { requestId: 'req-1', disposition: 'ACTIVE', executionAlive: false, closedForExecution: true }

  it('P1 una terminal firmada que anuncia "1" la conserva y sus dos campos llegan al servicio', async () => {
    connect('terminal-x', 'terminal-x', 'exec-socket', capacidades)
    expect(terminalRegistry.getTerminal('terminal-x')?.terminalPaymentExecutionVersion).toBe(1)
    const h = manejadores('exec-socket')
    await h['terminal:payment_probe_result'](evidencia, jest.fn())
    expect(terminalPaymentService.handleProbeResultFromSocket).toHaveBeenCalledWith(
      expect.objectContaining({ executionAlive: false, closedForExecution: true }),
      expect.objectContaining({ terminalPaymentExecutionVersion: 1 }),
    )
    await h['terminal:payment_cancel_disposition'](evidencia, jest.fn())
    expect(terminalPaymentService.handleCancelDispositionFromSocket).toHaveBeenCalledWith(
      expect.objectContaining({ executionAlive: false, closedForExecution: true }),
      expect.objectContaining({ terminalPaymentExecutionVersion: 1 }),
    )
  })

  it('P1 sin firma no hay capacidad: un cliente que dice "1" no aporta evidencia', () => {
    connect('terminal-y', undefined, 'unsigned-exec', capacidades)
    expect(terminalRegistry.getTerminal('terminal-y')?.terminalPaymentExecutionVersion ?? 0).toBe(0)
  })
})

/**
 * Codex servidor r1 · F3 (21-oct): al conectar se lanzaban en paralelo la reentrega y la sonda. Si la reentrega grababa
 * primero su procedencia, la SENT de la app muerta ya apuntaba al socket nuevo y la sonda la excluía (E9): sin certificado de
 * cese hasta el vencimiento de 5 min. Ahora la sonda va ANTES y la reentrega espera a que termine.
 */
describe('F3 · al conectar, la sonda corre ANTES que la reentrega', () => {
  const sonda = terminalPaymentService.probeUnresolvedForTerminal as jest.Mock
  const reentrega = terminalPaymentService.replayPendingForTerminal as jest.Mock
  const vaciarPromesas = () => new Promise(resolve => setImmediate(resolve))
  const capacidades = { terminalPaymentProbeVersion: 1 }

  it('la reentrega no arranca hasta que la sonda terminó', async () => {
    let terminarSonda: (n: number) => void = () => undefined
    sonda.mockImplementationOnce(() => new Promise<number>(resolve => (terminarSonda = resolve)))
    connect('terminal-f3', 'terminal-f3', 'f3-socket', capacidades)
    await vaciarPromesas()
    expect(sonda).toHaveBeenCalledWith('terminal-f3', 'venue-proof', 'f3-socket')
    expect(reentrega).not.toHaveBeenCalled()

    terminarSonda(1)
    await vaciarPromesas()
    expect(reentrega).toHaveBeenCalledWith('terminal-f3', 'venue-proof', 'f3-socket')
    expect(sonda.mock.invocationCallOrder[0]).toBeLessThan(reentrega.mock.invocationCallOrder[0])
  })

  it('una sonda que truena no impide la reentrega (cada una con su catch)', async () => {
    sonda.mockRejectedValueOnce(new Error('P2024: pool agotado'))
    connect('terminal-f3b', 'terminal-f3b', 'f3b-socket', capacidades)
    await vaciarPromesas()
    expect(reentrega).toHaveBeenCalledWith('terminal-f3b', 'venue-proof', 'f3b-socket')
  })
})
