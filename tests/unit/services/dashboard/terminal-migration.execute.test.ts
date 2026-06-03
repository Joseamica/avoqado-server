import { migrateExecute } from '@/services/dashboard/terminal-migration.service'
import prisma from '@/utils/prismaClient'
import * as terminalsService from '@/services/dashboard/terminals.superadmin.service'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'

// Mock the Prisma layer so the REAL migratePreflight (called inside migrateExecute) runs.
// Do NOT self-mock the migration module — Jest can't intercept intra-module calls, so
// migrateExecute's internal migratePreflight() would still hit the real one regardless.
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    venuePaymentConfig: { findFirst: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    tpvCommandQueue: { findFirst: jest.fn(), update: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/terminals.superadmin.service')
jest.mock('@/services/tpv/command-queue.service', () => ({
  tpvCommandQueueService: { queueCommand: jest.fn() },
}))

const m = prisma as unknown as {
  terminal: { findUnique: jest.Mock }
  venue: { findUnique: jest.Mock }
  venuePaymentConfig: { findFirst: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  tpvCommandQueue: { findFirst: jest.Mock; update: jest.Mock }
}
const mockedUpdate = terminalsService.updateTerminal as jest.Mock
const mockedQueue = tpvCommandQueueService.queueCommand as jest.Mock

const healthyPreflight = () => {
  m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-old', status: 'ACTIVE', brand: 'PAX' })
  m.venue.findUnique.mockResolvedValue({ id: 'venue-new', name: 'New' })
  m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1' })
  m.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  m.tpvCommandQueue.findFirst.mockResolvedValue(null)
}

describe('migrateExecute', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    healthyPreflight()
    m.tpvCommandQueue.update.mockResolvedValue({})
    mockedUpdate.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', name: 'T1' })
    mockedQueue.mockResolvedValue({
      commandId: 'cmd-1',
      correlationId: 'corr-1',
      status: 'QUEUED',
      queued: true,
      terminalOnline: true,
      message: 'ok',
    })
  })

  it('re-parents BEFORE queueing the wipe, and queues FACTORY_RESET against the NEW venue', async () => {
    const order: string[] = []
    mockedUpdate.mockImplementation(async () => {
      order.push('reparent')
      return { id: 'term-1', venueId: 'venue-new' }
    })
    mockedQueue.mockImplementation(async () => {
      order.push('wipe')
      return { commandId: 'cmd-1', status: 'QUEUED' }
    })

    const r = await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })

    expect(order).toEqual(['reparent', 'wipe'])
    expect(mockedUpdate).toHaveBeenCalledWith('term-1', { venueId: 'venue-new' }, expect.objectContaining({ staffId: 'admin-1' }))
    expect(mockedQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: 'term-1',
        venueId: 'venue-new',
        commandType: 'FACTORY_RESET',
        priority: 'CRITICAL',
      }),
    )
    expect(r).toEqual(expect.objectContaining({ commandId: 'cmd-1', fromVenueId: 'venue-old', toVenueId: 'venue-new' }))
  })

  // Offline-safe TTL: the migration wipe must outlive a multi-day-offline device so it completes
  // whenever the device reconnects (the default FACTORY_RESET TTL is only 30 min).
  it('extends the wipe TTL to ~7 days so it survives a multi-day-offline device', async () => {
    const before = Date.now()
    await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })

    expect(m.tpvCommandQueue.update).toHaveBeenCalledWith({
      where: { id: 'cmd-1' },
      data: { expiresAt: expect.any(Date) },
    })
    const expiresAt = (m.tpvCommandQueue.update.mock.calls[0][0] as { data: { expiresAt: Date } }).data.expiresAt
    // Well beyond the default 30-min TTL — at least ~6 days out.
    expect(expiresAt.getTime() - before).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
  })

  it('throws and does NOT wipe when the destination is not ready (blocker)', async () => {
    m.staffVenue.findFirst.mockResolvedValue(null) // → NO_STAFF_PIN blocker
    await expect(migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })).rejects.toThrow()
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedQueue).not.toHaveBeenCalled()
  })

  // FIX 2: partial-failure window. Re-parent succeeds, but queueCommand throws (e.g. the
  // terminal got locked between preflight and queue). The terminal is now re-parented with
  // NO wipe queued — the operator MUST be told that recoverable state, not get a bare error.
  it('surfaces the recoverable re-parented state when the wipe fails to queue', async () => {
    mockedUpdate.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', name: 'T1' })
    mockedQueue.mockRejectedValue(new Error('terminal locked'))

    // (a) migrateExecute rejects
    const err = await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)

    // (b) the message tells the operator the re-parent happened and to re-send the factory reset
    const message = (err as Error).message
    expect(message).toContain('reasignó')
    expect(message).toContain('reenvía')
    expect(message).toContain('terminal locked') // original error preserved

    // (c) the re-parent WAS performed even though the function ultimately threw
    expect(mockedUpdate).toHaveBeenCalledWith('term-1', { venueId: 'venue-new' }, expect.objectContaining({ staffId: 'admin-1' }))
    expect(mockedQueue).toHaveBeenCalled()
  })
})
