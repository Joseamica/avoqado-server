import { SocketManager } from '@/communication/sockets/managers/socketManager'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'
import { terminalPaymentService } from '@/services/terminal-payment.service'

jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: {
    replayPendingForTerminal: jest.fn().mockResolvedValue(undefined),
    probeUnresolvedForTerminal: jest.fn().mockResolvedValue(0),
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
function connect(claimed: string, signed?: string, socketId = 'proof-socket') {
  sockets.push(socketId)
  connection({
    id: socketId,
    handshake: { auth: { terminalId: claimed, terminalPaymentAckVersion: 1, terminalPaymentCancelDispositionVersion: 1 } },
    authContext: { userId: 'cashier', venueId: 'venue-proof', terminalSerialNumber: signed },
  })
}
describe('New proof registration boundaries', () => {
  it('signed device cannot register or replay another claimed terminal', () => {
    connect('terminal-b', 'terminal-a')
    expect(terminalRegistry.getTerminal('terminal-b')).toBeNull()
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
