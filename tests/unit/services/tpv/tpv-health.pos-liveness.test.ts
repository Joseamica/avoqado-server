import { TerminalStatus, TerminalType } from '@prisma/client'

import { tpvHealthService } from '@/services/tpv/tpv-health.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { updateMany: jest.fn() },
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

const updateMany = prisma.terminal.updateMany as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  updateMany.mockResolvedValue({ count: 0 })
})

describe('checkOfflineTerminals — POS lifecycle is independent from TPV liveness', () => {
  it('excludes every POS role from stale-heartbeat lifecycle demotion', async () => {
    await tpvHealthService.checkOfflineTerminals()

    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(updateMany.mock.calls[0][0].where.type).toEqual({
      notIn: [TerminalType.POS_ANDROID, TerminalType.POS_IOS, TerminalType.POS_DESKTOP],
    })
  })

  it('keeps TPV Android, KDS and both printer roles eligible exactly as before', async () => {
    await tpvHealthService.checkOfflineTerminals()

    const excludedTypes = updateMany.mock.calls[0][0].where.type.notIn
    expect(excludedTypes).not.toContain(TerminalType.TPV_ANDROID)
    expect(excludedTypes).not.toContain(TerminalType.KDS)
    expect(excludedTypes).not.toContain(TerminalType.PRINTER_RECEIPT)
    expect(excludedTypes).not.toContain(TerminalType.PRINTER_KITCHEN)
  })

  it('preserves the legacy status, activation and heartbeat predicates', async () => {
    const now = new Date('2026-08-30T22:00:00.000Z')
    jest.useFakeTimers().setSystemTime(now)

    try {
      await tpvHealthService.checkOfflineTerminals()

      expect(updateMany.mock.calls[0][0]).toEqual({
        where: {
          lastHeartbeat: { lt: new Date('2026-08-30T21:58:00.000Z') },
          status: { in: [TerminalStatus.ACTIVE] },
          activatedAt: null,
          type: {
            notIn: [TerminalType.POS_ANDROID, TerminalType.POS_IOS, TerminalType.POS_DESKTOP],
          },
        },
        data: {
          status: TerminalStatus.INACTIVE,
          updatedAt: now,
        },
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('remains one idempotent updateMany instead of per-device writes', async () => {
    updateMany.mockResolvedValue({ count: 6 })

    await tpvHealthService.checkOfflineTerminals()

    expect(updateMany).toHaveBeenCalledTimes(1)
  })
})
