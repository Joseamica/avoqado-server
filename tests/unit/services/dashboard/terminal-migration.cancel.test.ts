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
    terminal: { update: jest.fn(), findUnique: jest.fn() },
    venuePaymentConfig: { deleteMany: jest.fn() },
  },
}))
jest.mock('@/services/tpv/command-queue.service', () => ({
  tpvCommandQueueService: { cancelCommand: jest.fn() },
}))
// logAction is best-effort; stub it so the test doesn't depend on prisma.activityLog.
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

const m = prisma as unknown as {
  tpvCommandQueue: { findFirst: jest.Mock }
  terminal: { update: jest.Mock; findUnique: jest.Mock }
  venuePaymentConfig: { deleteMany: jest.Mock }
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

  // Asana 1218069201250971 (2026-09-01): a MANUAL wipe (queued from the superadmin, no
  // `migration` payload) also blocks the wizard. Before, this path threw "cannot revert"
  // and left the operator with no way out. There is nothing to revert — the terminal never
  // moved — so cancelling is just dropping the queued command.
  it('cancels a MANUAL wipe (no migration payload) by dropping the command, without touching the venue', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-1',
      commandType: 'FACTORY_RESET',
      status: 'QUEUED',
      payload: {}, // no .migration
    })
    m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-current' })

    const r = await migrateCancel('term-1', { staffId: 'admin-1' })

    expect(mockedCancelCommand).toHaveBeenCalledWith('cmd-1', 'admin-1', expect.any(String))
    // nothing to revert: the terminal stays exactly where it is
    expect(m.terminal.update).not.toHaveBeenCalled()
    expect(r).toEqual({ cancelled: true, restoredVenueId: 'venue-current' })
  })
})

describe('migrateCancel — config de pagos creada por la migración', () => {
  const actor = { staffId: 'admin-1' }

  beforeEach(() => {
    jest.clearAllMocks()
    m.terminal.update.mockResolvedValue({ id: 'term-1', venueId: 'venue-old' })
    mockedCancelCommand.mockResolvedValue(undefined)
  })

  it('I5: borra la VenuePaymentConfig que creó la migración', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      payload: {
        migration: {
          fromVenueId: 'venue-old',
          previousMerchantIds: ['merch-p'],
          createdVenuePaymentConfigId: 'vpc-nueva',
        },
      },
    })
    await migrateCancel('term-1', actor)
    expect(m.venuePaymentConfig.deleteMany).toHaveBeenCalledWith({ where: { id: 'vpc-nueva' } })
  })

  it('I1+I5: NO borra nada si la migración no creó config', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      payload: { migration: { fromVenueId: 'venue-old', previousMerchantIds: ['merch-p'] } },
    })
    await migrateCancel('term-1', actor)
    expect(m.venuePaymentConfig.deleteMany).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: sigue revirtiendo venue y merchants del origen', async () => {
    m.tpvCommandQueue.findFirst.mockResolvedValue({
      id: 'cmd-1',
      payload: { migration: { fromVenueId: 'venue-old', previousMerchantIds: ['merch-p'] } },
    })
    const r = await migrateCancel('term-1', actor)
    expect(r).toEqual({ cancelled: true, restoredVenueId: 'venue-old' })
    expect(m.terminal.update).toHaveBeenCalledWith({
      where: { id: 'term-1' },
      data: { venueId: 'venue-old', assignedMerchantIds: ['merch-p'] },
    })
  })
})
