/**
 * ObservabilityController.handleTerminalHeartbeat — heartbeat write debounce
 *
 * Regression guard for the 2026-06-29 incident: a terminal that reconnects after
 * a long socket outage flushes its whole backlog of buffered `tpv:heartbeat`
 * emits at once (observed: 187 in ~2s), and each ran a `prisma.$transaction`,
 * exhausting the Prisma connection pool ("Timed out fetching a connection").
 *
 * These tests pin the fix:
 *  - NEW: a 2nd heartbeat from the same terminal within 30s is debounced (no 2nd
 *    DB write), but terminalRegistry.register() STILL runs (payment routing).
 *  - NEW: after the 30s window, writes resume.
 *  - NEW: the debounce is per-terminal (server clock), not global.
 *  - REGRESSION: a normal heartbeat still persists; an unknown terminal is still
 *    rejected without registering or writing.
 */

import { ObservabilityController } from '@/communication/sockets/controllers/observability.controller'
import prisma from '@/utils/prismaClient'
import { terminalRegistry } from '@/communication/sockets/terminal-registry'

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findFirst: jest.fn(), update: jest.fn() },
    terminalHealth: { create: jest.fn() },
    terminalLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/communication/sockets/terminal-registry', () => ({
  __esModule: true,
  terminalRegistry: { register: jest.fn() },
}))

const mockPrisma = prisma as unknown as {
  terminal: { findFirst: jest.Mock }
  terminalHealth: { create: jest.Mock }
  terminalLog: { create: jest.Mock }
  $transaction: jest.Mock
}
const mockRegister = terminalRegistry.register as jest.Mock

// Full health payload — the handler reads every nested field when building the
// TerminalHealth row, so all of these must be present.
function makeHealthPayload(terminalSerial: string, venueId = 'venue-1') {
  return {
    terminalId: terminalSerial,
    venueId,
    healthScore: 90,
    timestamp: 1_700_000_000_000,
    health: {
      memory: { totalMB: 1859, availableMB: 960, usagePercent: 48, lowMemory: false },
      storage: { totalMB: 10901, availableMB: 9280, usagePercent: 14, lowStorage: false },
      battery: { level: 64, isCharging: false, temperatureCelsius: 24.9, lowBattery: false },
      connectivity: { socketConnected: false, online: true },
      device: {
        manufacturer: 'PAX',
        model: 'A910S',
        osVersion: '12',
        appVersion: '2.5.3',
        appVersionCode: 79,
        blumonEnv: 'PROD',
      },
      uptime: { uptimeMinutes: 1079 },
    },
  }
}

/**
 * A TPV socket: its JWT carries the terminal serial the server signed at PIN login and the venue of
 * that login. The default (venue-1 + the payload's own serial) is what every real terminal sends.
 */
const makeSocket = (terminalSerialNumber: string, venueId = 'venue-1', id = 'socket-1') =>
  ({ id, authContext: { userId: 'staff-1', venueId, role: 'WAITER', terminalSerialNumber } }) as any

/** A dashboard (panel) socket: same JWT shape but NO terminal serial. */
const makePanelSocket = (venueId = 'venue-A', id = 'panel-socket') =>
  ({ id, authContext: { userId: 'admin-A', venueId, role: 'ADMIN' } }) as any

/** Honors the `where` it gets, like the database: a lookup scoped to the wrong venue finds nothing. */
const TERMINALS = [
  { id: 'term-A1', venueId: 'venue-A', serialNumber: 'AVQD-1111111111' },
  { id: 'term-B1', venueId: 'venue-B', serialNumber: 'AVQD-2222222222' },
]
function fakeTerminalFindFirst({ where }: any) {
  const matches = (t: (typeof TERMINALS)[number]) =>
    (where.venueId === undefined || t.venueId === where.venueId) &&
    (where.OR ?? [{ serialNumber: where.serialNumber }]).some(
      (c: any) => c.id === t.id || (c.serialNumber?.equals && c.serialNumber.equals.toLowerCase() === t.serialNumber.toLowerCase()),
    )
  return Promise.resolve(TERMINALS.find(matches) ?? null)
}

function makeLogPayload(terminalId: string, venueId: string) {
  return { level: 'error', tag: 'Payment', message: 'boom', terminalId, venueId, timestamp: 1_700_000_000_000 }
}

describe('ObservabilityController.handleTerminalHeartbeat — write debounce', () => {
  let controller: ObservabilityController
  let nowSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    // No broadcastingService set → the broadcast step is skipped (null guard).
    controller = new ObservabilityController({} as any)
    mockPrisma.$transaction.mockResolvedValue([{ id: 'health-row-1' }, {}])
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
  })

  afterEach(() => {
    nowSpy.mockRestore()
  })

  it('persists the first heartbeat: registers + one DB transaction + acks the row id', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue({ id: 'term-A', venueId: 'venue-1' })
    const cb = jest.fn()

    await controller.handleTerminalHeartbeat(makeSocket('AVQD-A'), makeHealthPayload('AVQD-A') as any, cb)

    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith({ success: true, id: 'health-row-1' })
  })

  it('debounces a 2nd heartbeat within 30s: NO 2nd DB write, but STILL registers (payments)', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue({ id: 'term-B', venueId: 'venue-1' })
    const cb = jest.fn()

    nowSpy.mockReturnValue(1_000_000)
    await controller.handleTerminalHeartbeat(makeSocket('AVQD-B'), makeHealthPayload('AVQD-B') as any, cb)

    nowSpy.mockReturnValue(1_000_000 + 10_000) // +10s — inside the 30s window
    await controller.handleTerminalHeartbeat(makeSocket('AVQD-B'), makeHealthPayload('AVQD-B') as any, cb)

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1) // only the first one wrote
    expect(mockRegister).toHaveBeenCalledTimes(2) // payment routing refreshed every time
    expect(cb).toHaveBeenNthCalledWith(2, { success: true, debounced: true })
  })

  it('writes again once the 30s window passes', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue({ id: 'term-C', venueId: 'venue-1' })
    const cb = jest.fn()

    nowSpy.mockReturnValue(2_000_000)
    await controller.handleTerminalHeartbeat(makeSocket('AVQD-C'), makeHealthPayload('AVQD-C') as any, cb)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)

    nowSpy.mockReturnValue(2_000_000 + 20_000) // +20s — still debounced
    await controller.handleTerminalHeartbeat(makeSocket('AVQD-C'), makeHealthPayload('AVQD-C') as any, cb)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)

    nowSpy.mockReturnValue(2_000_000 + 31_000) // +31s — window passed → writes again
    await controller.handleTerminalHeartbeat(makeSocket('AVQD-C'), makeHealthPayload('AVQD-C') as any, cb)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2)
  })

  it('does NOT debounce a different terminal (per-terminal key)', async () => {
    const cb = jest.fn()

    mockPrisma.terminal.findFirst.mockResolvedValueOnce({ id: 'term-D1', venueId: 'venue-1' })
    await controller.handleTerminalHeartbeat(makeSocket('AVQD-D1'), makeHealthPayload('AVQD-D1') as any, cb)

    mockPrisma.terminal.findFirst.mockResolvedValueOnce({ id: 'term-D2', venueId: 'venue-1' })
    await controller.handleTerminalHeartbeat(makeSocket('AVQD-D2'), makeHealthPayload('AVQD-D2') as any, cb)

    // Same instant, but two distinct terminals → both persist.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2)
  })

  it('REGRESSION: rejects an unknown terminal without registering or writing', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue(null)
    const cb = jest.fn()

    await controller.handleTerminalHeartbeat(makeSocket('AVQD-UNKNOWN'), makeHealthPayload('AVQD-UNKNOWN') as any, cb)

    expect(mockRegister).not.toHaveBeenCalled()
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(cb).toHaveBeenCalledWith({ success: false, error: expect.stringContaining('Terminal not found') })
  })
})

/**
 * D2 (31-oct): `tpv:log` and `tpv:heartbeat` accepted the terminal and the venue from the PAYLOAD of ANY
 * authenticated socket, and the heartbeat looked the terminal up across ALL venues. A dashboard session of
 * venue A could write logs and health rows (and take the payment-routing slot) of venue B's terminals.
 * Now the socket must be a terminal (signed serial in its JWT), the payload must name THAT terminal
 * (`sameTerminalSerial`, the rule command ACKs already use), and everything is written for the SESSION's
 * venue, with the terminal looked up inside it. A rejected event is ignored with a warning (no disconnect).
 */
describe('ObservabilityController — only the terminal itself, inside its own venue (D2)', () => {
  let controller: ObservabilityController
  let broadcastToVenue: jest.Mock
  let nowSpy: jest.SpyInstance
  // The write debounce is module-level and keyed by terminal: each test starts a minute later so
  // a previous test's write never debounces this one.
  let clock = 50_000_000

  beforeEach(() => {
    jest.clearAllMocks()
    clock += 60_000
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(clock)
    controller = new ObservabilityController({} as any)
    broadcastToVenue = jest.fn()
    controller.setBroadcastingService({ broadcastToVenue } as any)
    mockPrisma.terminal.findFirst.mockImplementation(fakeTerminalFindFirst)
    mockPrisma.$transaction.mockResolvedValue([{ id: 'health-row' }, {}])
    mockPrisma.terminalLog.create.mockResolvedValue({ id: 'log-row' })
  })

  afterEach(() => {
    nowSpy.mockRestore()
  })

  describe('tpv:heartbeat', () => {
    it("a panel socket of venue A sending B's terminal heartbeat writes nothing and takes no routing slot", async () => {
      const cb = jest.fn()
      await controller.handleTerminalHeartbeat(makePanelSocket('venue-A'), makeHealthPayload('AVQD-2222222222', 'venue-B') as any, cb)

      expect(mockPrisma.$transaction).not.toHaveBeenCalled()
      expect(mockRegister).not.toHaveBeenCalled()
      expect(broadcastToVenue).not.toHaveBeenCalled()
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ success: false }))
    })

    it("terminal A1's socket claiming terminal B1 writes nothing", async () => {
      await controller.handleTerminalHeartbeat(
        makeSocket('AVQD-1111111111', 'venue-A'),
        makeHealthPayload('AVQD-2222222222', 'venue-B') as any,
      )

      expect(mockPrisma.$transaction).not.toHaveBeenCalled()
      expect(mockRegister).not.toHaveBeenCalled()
    })

    it('a terminal whose session venue is not where the terminal lives writes nothing (lookup scoped to the session venue)', async () => {
      // Signed serial of B1 but a session of venue A (the terminal moved; stale session): never write into B.
      await controller.handleTerminalHeartbeat(
        makeSocket('AVQD-2222222222', 'venue-A'),
        makeHealthPayload('AVQD-2222222222', 'venue-B') as any,
      )

      expect(mockPrisma.terminal.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ venueId: 'venue-A' }) }),
      )
      expect(mockPrisma.$transaction).not.toHaveBeenCalled()
      expect(broadcastToVenue).not.toHaveBeenCalled()
    })

    it("a payload venue that differs from the session's is never used: the row and the broadcast go to the session venue", async () => {
      await controller.handleTerminalHeartbeat(
        makeSocket('AVQD-1111111111', 'venue-A'),
        makeHealthPayload('AVQD-1111111111', 'venue-B') as any,
      )

      expect(mockPrisma.terminalHealth.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ venueId: 'venue-A', terminalId: 'term-A1' }) }),
      )
      expect(broadcastToVenue).toHaveBeenCalledWith('venue-A', expect.anything(), expect.anything())
      expect(broadcastToVenue).not.toHaveBeenCalledWith('venue-B', expect.anything(), expect.anything())
      expect(mockRegister).toHaveBeenCalledWith('AVQD-1111111111', expect.any(String), 'venue-A')
    })

    it.each([
      ['same serial', 'AVQD-1111111111'],
      ['without the AVQD- prefix', '1111111111'],
      ['lowercase', 'avqd-1111111111'],
    ])('REGRESSION: the legit terminal still writes (%s)', async (_label, claimed) => {
      const cb = jest.fn()
      await controller.handleTerminalHeartbeat(makeSocket('AVQD-1111111111', 'venue-A'), makeHealthPayload(claimed, 'venue-A') as any, cb)

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
      expect(mockPrisma.terminalHealth.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ venueId: 'venue-A', terminalId: 'term-A1' }) }),
      )
      expect(mockRegister).toHaveBeenCalledTimes(1)
      expect(broadcastToVenue).toHaveBeenCalledWith('venue-A', expect.anything(), expect.anything())
      expect(cb).toHaveBeenCalledWith({ success: true, id: 'health-row' })
    })
  })

  describe('tpv:log', () => {
    it("a panel socket of venue A sending a log with venue B and B's terminal: not stored, not broadcast", async () => {
      const cb = jest.fn()
      await controller.handleTerminalLog(makePanelSocket('venue-A'), makeLogPayload('AVQD-2222222222', 'venue-B') as any, cb)

      expect(mockPrisma.terminalLog.create).not.toHaveBeenCalled()
      expect(broadcastToVenue).not.toHaveBeenCalled()
      expect(cb).toHaveBeenCalledWith(expect.objectContaining({ success: false }))
    })

    it("terminal A1's socket logging as terminal B1: not stored, not broadcast", async () => {
      await controller.handleTerminalLog(makeSocket('AVQD-1111111111', 'venue-A'), makeLogPayload('AVQD-2222222222', 'venue-B') as any)

      expect(mockPrisma.terminalLog.create).not.toHaveBeenCalled()
      expect(broadcastToVenue).not.toHaveBeenCalled()
    })

    it('a log with venue B from terminal A1 is stored and broadcast for venue A only, never for B', async () => {
      await controller.handleTerminalLog(makeSocket('AVQD-1111111111', 'venue-A'), makeLogPayload('AVQD-1111111111', 'venue-B') as any)

      expect(mockPrisma.terminalLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ venueId: 'venue-A', terminalId: 'term-A1' }) }),
      )
      expect(broadcastToVenue).toHaveBeenCalledTimes(1)
      expect(broadcastToVenue).toHaveBeenCalledWith('venue-A', expect.anything(), expect.anything())
    })

    it('REGRESSION: the legit terminal still stores and broadcasts its log', async () => {
      const cb = jest.fn()
      await controller.handleTerminalLog(makeSocket('AVQD-1111111111', 'venue-A'), makeLogPayload('AVQD-1111111111', 'venue-A') as any, cb)

      expect(mockPrisma.terminalLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ venueId: 'venue-A', terminalId: 'term-A1', level: 'ERROR' }) }),
      )
      expect(broadcastToVenue).toHaveBeenCalledWith('venue-A', expect.anything(), expect.objectContaining({ id: 'log-row' }))
      expect(cb).toHaveBeenCalledWith({ success: true, id: 'log-row' })
    })
  })
})
