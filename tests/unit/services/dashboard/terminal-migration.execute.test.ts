import { migrateExecute } from '@/services/dashboard/terminal-migration.service'
import prisma from '@/utils/prismaClient'
import * as terminalsService from '@/services/dashboard/terminals.superadmin.service'

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
// updateTerminal now owns the wipe-queueing ("blindar"). We mock the whole
// terminals service so migrateExecute delegates re-parent + wipe to a mock —
// the blindar logic itself is covered by its own service test.
jest.mock('@/services/dashboard/terminals.superadmin.service')
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

const m = prisma as unknown as {
  terminal: { findUnique: jest.Mock }
  venue: { findUnique: jest.Mock }
  venuePaymentConfig: { findFirst: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  tpvCommandQueue: { findFirst: jest.Mock; update: jest.Mock }
}
const mockedUpdate = terminalsService.updateTerminal as jest.Mock

const healthyPreflight = () => {
  m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-old', status: 'ACTIVE', brand: 'PAX' })
  m.venue.findUnique.mockResolvedValue({ id: 'venue-new', name: 'New' })
  m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1' })
  m.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  // Idempotency check (preflight) AND the post-reparent commandId recovery both
  // call findFirst. Default: preflight sees no in-flight wipe (null), then the
  // recovery sees the wipe blindar queued. Tests override per-call as needed.
  m.tpvCommandQueue.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'cmd-1', commandType: 'FACTORY_RESET' })
}

describe('migrateExecute', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    healthyPreflight()
    m.tpvCommandQueue.update.mockResolvedValue({})
    mockedUpdate.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', name: 'T1' })
  })

  it('delegates re-parent to updateTerminal (which auto-queues the wipe) and recovers the commandId', async () => {
    const r = await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })

    // Re-parent delegated to updateTerminal with ONLY { venueId } — the wipe is
    // queued INSIDE updateTerminal (blindar), not here, so no double-wipe.
    expect(mockedUpdate).toHaveBeenCalledWith('term-1', { venueId: 'venue-new' }, expect.objectContaining({ staffId: 'admin-1' }))
    // migrateExecute must NOT have only one updateTerminal call (no merchant arg here)
    expect(mockedUpdate).toHaveBeenCalledTimes(1)
    // commandId recovered by re-querying the latest FACTORY_RESET for the terminal
    expect(m.tpvCommandQueue.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { terminalId: 'term-1', commandType: 'FACTORY_RESET' },
        orderBy: { createdAt: 'desc' },
      }),
    )
    expect(r).toEqual(expect.objectContaining({ commandId: 'cmd-1', fromVenueId: 'venue-old', toVenueId: 'venue-new' }))
  })

  it('sets the optional destination merchant via a SECOND updateTerminal call (venue unchanged → no re-wipe)', async () => {
    await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' }, ['ma-1', 'ma-2'])

    expect(mockedUpdate).toHaveBeenNthCalledWith(1, 'term-1', { venueId: 'venue-new' }, expect.objectContaining({ staffId: 'admin-1' }))
    expect(mockedUpdate).toHaveBeenNthCalledWith(
      2,
      'term-1',
      { assignedMerchantIds: ['ma-1', 'ma-2'] },
      expect.objectContaining({ staffId: 'admin-1' }),
    )
    expect(mockedUpdate).toHaveBeenCalledTimes(2)
  })

  // Regression (TPV migration left payment-dead): when the operator uses the
  // "Comercio por defecto de la sucursal (recomendado)" option, the wizard sends NO
  // merchant. migrateExecute MUST fall back to the destination venue's configured
  // default (VenuePaymentConfig.primaryAccountId) so the terminal can still charge —
  // otherwise it lands with assignedMerchantIds = [] and cannot process payments.
  it('falls back to the destination venue default merchant (primaryAccountId) when no merchants are provided', async () => {
    m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1', primaryAccountId: 'ma-default' })
    await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })
    expect(mockedUpdate).toHaveBeenNthCalledWith(1, 'term-1', { venueId: 'venue-new' }, expect.objectContaining({ staffId: 'admin-1' }))
    expect(mockedUpdate).toHaveBeenNthCalledWith(
      2,
      'term-1',
      { assignedMerchantIds: ['ma-default'] },
      expect.objectContaining({ staffId: 'admin-1' }),
    )
    expect(mockedUpdate).toHaveBeenCalledTimes(2)
  })

  it('falls back to the venue default merchant for an empty merchant array too', async () => {
    m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1', primaryAccountId: 'ma-default' })
    await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' }, [])
    expect(mockedUpdate).toHaveBeenNthCalledWith(2, 'term-1', { assignedMerchantIds: ['ma-default'] }, expect.anything())
    expect(mockedUpdate).toHaveBeenCalledTimes(2)
  })

  it('does NOT make a second updateTerminal call when the venue has no default merchant configured', async () => {
    m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1', primaryAccountId: null })
    await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })
    expect(mockedUpdate).toHaveBeenCalledTimes(1)
  })

  it('throws and does NOT re-parent when the destination is not ready (blocker)', async () => {
    m.staffVenue.findFirst.mockResolvedValue(null) // → NO_STAFF_PIN blocker
    await expect(migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })).rejects.toThrow()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  // Partial-failure window. The re-parent succeeds inside updateTerminal but the wipe
  // failed to queue (blindar logs a warning, does NOT throw), so no FACTORY_RESET exists
  // to recover. The operator MUST be told that recoverable state, not get a silent success.
  it('surfaces the recoverable re-parented state when no wipe was queued (recovery finds none)', async () => {
    // preflight findFirst → null (no in-flight wipe), recovery findFirst → null (none queued)
    m.tpvCommandQueue.findFirst.mockReset()
    m.tpvCommandQueue.findFirst.mockResolvedValue(null)
    mockedUpdate.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', name: 'T1' })

    const err = await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toContain('reasignó')
    expect(message).toContain('reenvía')

    // the re-parent WAS performed even though the function ultimately threw
    expect(mockedUpdate).toHaveBeenCalledWith('term-1', { venueId: 'venue-new' }, expect.objectContaining({ staffId: 'admin-1' }))
  })
})
