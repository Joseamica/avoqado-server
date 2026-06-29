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

const makeSocket = (id = 'socket-1') => ({ id }) as any

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

    await controller.handleTerminalHeartbeat(makeSocket(), makeHealthPayload('AVQD-A') as any, cb)

    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith({ success: true, id: 'health-row-1' })
  })

  it('debounces a 2nd heartbeat within 30s: NO 2nd DB write, but STILL registers (payments)', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue({ id: 'term-B', venueId: 'venue-1' })
    const cb = jest.fn()

    nowSpy.mockReturnValue(1_000_000)
    await controller.handleTerminalHeartbeat(makeSocket(), makeHealthPayload('AVQD-B') as any, cb)

    nowSpy.mockReturnValue(1_000_000 + 10_000) // +10s — inside the 30s window
    await controller.handleTerminalHeartbeat(makeSocket(), makeHealthPayload('AVQD-B') as any, cb)

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1) // only the first one wrote
    expect(mockRegister).toHaveBeenCalledTimes(2) // payment routing refreshed every time
    expect(cb).toHaveBeenNthCalledWith(2, { success: true, debounced: true })
  })

  it('writes again once the 30s window passes', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue({ id: 'term-C', venueId: 'venue-1' })
    const cb = jest.fn()

    nowSpy.mockReturnValue(2_000_000)
    await controller.handleTerminalHeartbeat(makeSocket(), makeHealthPayload('AVQD-C') as any, cb)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)

    nowSpy.mockReturnValue(2_000_000 + 20_000) // +20s — still debounced
    await controller.handleTerminalHeartbeat(makeSocket(), makeHealthPayload('AVQD-C') as any, cb)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)

    nowSpy.mockReturnValue(2_000_000 + 31_000) // +31s — window passed → writes again
    await controller.handleTerminalHeartbeat(makeSocket(), makeHealthPayload('AVQD-C') as any, cb)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2)
  })

  it('does NOT debounce a different terminal (per-terminal key)', async () => {
    const cb = jest.fn()

    mockPrisma.terminal.findFirst.mockResolvedValueOnce({ id: 'term-D1', venueId: 'venue-1' })
    await controller.handleTerminalHeartbeat(makeSocket(), makeHealthPayload('AVQD-D1') as any, cb)

    mockPrisma.terminal.findFirst.mockResolvedValueOnce({ id: 'term-D2', venueId: 'venue-1' })
    await controller.handleTerminalHeartbeat(makeSocket(), makeHealthPayload('AVQD-D2') as any, cb)

    // Same instant, but two distinct terminals → both persist.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2)
  })

  it('REGRESSION: rejects an unknown terminal without registering or writing', async () => {
    mockPrisma.terminal.findFirst.mockResolvedValue(null)
    const cb = jest.fn()

    await controller.handleTerminalHeartbeat(makeSocket(), makeHealthPayload('AVQD-UNKNOWN') as any, cb)

    expect(mockRegister).not.toHaveBeenCalled()
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(cb).toHaveBeenCalledWith({ success: false, error: expect.stringContaining('Terminal not found') })
  })
})
