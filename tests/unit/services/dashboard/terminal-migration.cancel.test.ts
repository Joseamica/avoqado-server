import { migrateCancel } from '@/services/dashboard/terminal-migration.service'
import prisma from '@/utils/prismaClient'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { BadRequestError } from '@/errors/AppError'

// migrateCancel reverts the terminal DIRECTLY via prisma (bypassing updateTerminal
// so the "blindar" auto-wipe does NOT re-queue a FACTORY_RESET on the revert).
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    tpvCommandQueue: { findFirst: jest.fn() },
    terminal: { update: jest.fn() },
  },
}))
jest.mock('@/services/tpv/command-queue.service', () => ({
  tpvCommandQueueService: { cancelCommand: jest.fn() },
}))
// logAction is best-effort; stub it so the test doesn't depend on prisma.activityLog.
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

const m = prisma as unknown as {
  tpvCommandQueue: { findFirst: jest.Mock }
  terminal: { update: jest.Mock }
}
const mockedCancelCommand = tpvCommandQueueService.cancelCommand as jest.Mock

describe('migrateCancel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    m.terminal.update.mockResolvedValue({ id: 'term-1', venueId: 'venue-old' })
    mockedCancelCommand.mockResolvedValue(undefined)
  })

  // ---- NEW FEATURE ----
  it('cancels a QUEUED wipe and reverts the terminal venue + merchants to the payload values', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-1',
      commandType: 'FACTORY_RESET',
      status: 'QUEUED',
      payload: { migration: { fromVenueId: 'venue-old', previousMerchantIds: ['ma-1', 'ma-2'], toVenueId: 'venue-new' } },
    })

    const r = await migrateCancel('term-1', { staffId: 'admin-1' })

    // only PENDING/QUEUED + not-expired wipes are cancellable
    expect(m.tpvCommandQueue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          terminalId: 'term-1',
          commandType: 'FACTORY_RESET',
          status: { in: ['PENDING', 'QUEUED'] },
        }),
      }),
    )
    // queued wipe cancelled so it never reaches the device
    expect(mockedCancelCommand).toHaveBeenCalledWith('cmd-1', 'admin-1', expect.stringContaining('cancelada'))
    // terminal reverted directly (bypassing updateTerminal → blindar does NOT re-wipe)
    expect(m.terminal.update).toHaveBeenCalledWith({
      where: { id: 'term-1' },
      data: { venueId: 'venue-old', assignedMerchantIds: ['ma-1', 'ma-2'] },
    })
    expect(r).toEqual({ cancelled: true, restoredVenueId: 'venue-old' })
  })

  it('reverts to an empty merchant list when previousMerchantIds is absent in the payload', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-1',
      commandType: 'FACTORY_RESET',
      status: 'PENDING',
      payload: { migration: { fromVenueId: 'venue-old', toVenueId: 'venue-new' } },
    })

    await migrateCancel('term-1', { staffId: 'admin-1' })

    expect(m.terminal.update).toHaveBeenCalledWith({
      where: { id: 'term-1' },
      data: { venueId: 'venue-old', assignedMerchantIds: [] },
    })
  })

  // ---- ERROR / GUARD CASES ----
  it('throws when no cancellable wipe exists (e.g. status already SENT → device may have wiped)', async () => {
    // The query filters status to PENDING/QUEUED, so a SENT command is simply not
    // returned by findFirst → null.
    m.tpvCommandQueue.findFirst.mockResolvedValue(null)

    await expect(migrateCancel('term-1', { staffId: 'admin-1' })).rejects.toThrow(BadRequestError)
    await expect(migrateCancel('term-1', { staffId: 'admin-1' })).rejects.toThrow('cancelable')
    expect(mockedCancelCommand).not.toHaveBeenCalled()
    expect(m.terminal.update).not.toHaveBeenCalled()
  })

  it('throws when the command payload has no migration info (older command, cannot auto-revert)', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-1',
      commandType: 'FACTORY_RESET',
      status: 'QUEUED',
      payload: {}, // no .migration
    })

    await expect(migrateCancel('term-1', { staffId: 'admin-1' })).rejects.toThrow(BadRequestError)
    await expect(migrateCancel('term-1', { staffId: 'admin-1' })).rejects.toThrow('revertir')
    // nothing mutated when we can't determine the revert target
    expect(mockedCancelCommand).not.toHaveBeenCalled()
    expect(m.terminal.update).not.toHaveBeenCalled()
  })
})
