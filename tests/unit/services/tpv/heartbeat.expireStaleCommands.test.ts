/**
 * Stale in-flight commands expire on the heartbeat that is already happening.
 *
 * A command is handed to a terminal exactly once (PENDING/QUEUED → SENT) and is never
 * re-delivered, so one that is never acknowledged sits in SENT forever. `RESTART`,
 * `SHUTDOWN` and `FACTORY_RESET` kill the app process before it can ACK, so in prod they
 * ALWAYS stalled: 67 RESTART and 65 FACTORY_RESET frozen in SENT (61 of them already past
 * `expiresAt`, some since April), and not one COMPLETED in the platform's history.
 *
 * `processExpiredCommands()` was written for exactly this and nothing ever called it.
 * Rather than add a cron that sweeps the whole table on a clock, the sweep rides the
 * heartbeat each terminal already sends, scoped to that terminal.
 */

import { tpvHealthService } from '@/services/tpv/tpv-health.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findUnique: jest.fn(), findFirst: jest.fn() },
    tpvCommandQueue: { findMany: jest.fn(), updateMany: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  broadcastTpvStatusUpdate: jest.fn(),
  broadcastTpvCommandStatusChanged: jest.fn(),
}))

jest.mock('@/services/tpv/command-queue.service', () => ({
  __esModule: true,
  tpvCommandQueueService: { queueCommand: jest.fn() },
}))

const mockedTerminalFindUnique = prisma.terminal.findUnique as jest.Mock
const mockedQueueFindMany = prisma.tpvCommandQueue.findMany as jest.Mock
const mockedQueueUpdateMany = prisma.tpvCommandQueue.updateMany as jest.Mock

const TERMINAL = { id: 'term-1' }

/** The sweep is the updateMany that targets already-in-flight statuses. */
const sweepCall = () =>
  mockedQueueUpdateMany.mock.calls.find(([args]) => Array.isArray(args?.where?.status?.in) && args.where.status.in.includes('SENT'))

beforeEach(() => {
  jest.clearAllMocks()
  mockedTerminalFindUnique.mockResolvedValue(TERMINAL)
  mockedQueueFindMany.mockResolvedValue([])
  mockedQueueUpdateMany.mockResolvedValue({ count: 0 })
})

describe('getPendingCommands — expiring stale in-flight commands', () => {
  // NEW BEHAVIOUR
  it("expires this terminal's in-flight commands whose expiresAt has passed", async () => {
    await tpvHealthService.getPendingCommands('term-1')

    const call = sweepCall()
    expect(call).toBeDefined()
    expect(call![0]).toMatchObject({
      where: {
        terminalId: 'term-1',
        status: { in: ['SENT', 'RECEIVED', 'EXECUTING'] },
      },
      data: {
        status: 'EXPIRED',
        resultStatus: 'TIMEOUT',
      },
    })
    expect(call![0].where.expiresAt.lt).toBeInstanceOf(Date)
  })

  it('scopes the sweep to ONE terminal — never a fleet-wide table scan', async () => {
    await tpvHealthService.getPendingCommands('term-1')

    // A missing terminalId here would expire every terminal's commands on any heartbeat.
    expect(sweepCall()![0].where.terminalId).toBe('term-1')
  })

  it('runs BEFORE delivery, so an expired command is never handed out', async () => {
    await tpvHealthService.getPendingCommands('term-1')

    const sweepOrder = mockedQueueUpdateMany.mock.invocationCallOrder[0]
    const deliveryOrder = mockedQueueFindMany.mock.invocationCallOrder[0]
    expect(sweepOrder).toBeLessThan(deliveryOrder)
  })

  it('leaves terminal states that are not in flight alone', async () => {
    await tpvHealthService.getPendingCommands('term-1')

    const statuses = sweepCall()![0].where.status.in
    // PENDING/QUEUED are still deliverable; COMPLETED/FAILED/EXPIRED are already terminal.
    expect(statuses).not.toContain('PENDING')
    expect(statuses).not.toContain('QUEUED')
    expect(statuses).not.toContain('COMPLETED')
  })

  it('does not sweep when the terminal cannot be resolved', async () => {
    mockedTerminalFindUnique.mockResolvedValue(null)
    ;(prisma.terminal.findFirst as jest.Mock).mockResolvedValue(null)

    const result = await tpvHealthService.getPendingCommands('unknown-serial')

    expect(result).toEqual([])
    expect(mockedQueueUpdateMany).not.toHaveBeenCalled()
  })

  // REGRESSION — delivery itself must be unchanged
  it('still delivers PENDING/QUEUED commands and marks them SENT', async () => {
    mockedQueueFindMany.mockResolvedValue([
      {
        id: 'cmd-1',
        correlationId: 'corr-1',
        commandType: 'RESTART',
        payload: null,
        priority: 'HIGH',
        requiresPin: false,
        expiresAt: null,
        requestedBy: 'staff-1',
        requestedByName: 'Isaac Mayoral',
        createdAt: new Date('2026-08-08T17:00:00.000Z'),
      },
    ])

    const commands = await tpvHealthService.getPendingCommands('term-1')

    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ commandId: 'cmd-1', type: 'RESTART' })

    expect(mockedQueueFindMany.mock.calls[0][0]).toMatchObject({
      where: { terminalId: 'term-1', status: { in: ['PENDING', 'QUEUED'] } },
    })

    const markSent = mockedQueueUpdateMany.mock.calls.find(([args]) => args?.data?.status === 'SENT')
    expect(markSent).toBeDefined()
    expect(markSent![0].where.id.in).toEqual(['cmd-1'])
  })

  it('returns an empty list without throwing when the sweep fails', async () => {
    mockedQueueUpdateMany.mockRejectedValue(new Error('db down'))

    // A heartbeat must never fail because of housekeeping.
    await expect(tpvHealthService.getPendingCommands('term-1')).resolves.toEqual([])
  })
})
