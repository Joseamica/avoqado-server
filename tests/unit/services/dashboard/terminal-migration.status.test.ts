import prisma from '@/utils/prismaClient'
import { migrateStatus } from '@/services/dashboard/terminal-migration.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    tpvCommandQueue: { findUnique: jest.fn() },
    terminal: { findUnique: jest.fn() },
  },
}))

const m = prisma as unknown as {
  tpvCommandQueue: { findUnique: jest.Mock }
  terminal: { findUnique: jest.Mock }
}

const T0 = new Date('2026-06-02T18:00:00Z')

describe('migrateStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    m.tpvCommandQueue.findUnique.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-1',
      venueId: 'venue-new',
      commandType: 'FACTORY_RESET',
      status: 'SENT',
      createdAt: T0,
    })
  })

  it('reports recent contact under the new venue without claiming SENT was acknowledged', async () => {
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-new',
      lastActivationStatusCheckAt: new Date(T0.getTime() + 60_000), // after T0
      lastHeartbeat: new Date(), // fresh → online
    })
    const r = await migrateStatus('term-1', 'cmd-1')
    expect(r.reboundAfterWipe).toBe(false)
    expect(r.onlineUnderNewVenue).toBe(true)
    expect(r.confirmed).toBe(false)
    expect(r.commandDelivered).toBe(false)
  })

  it.each(['FAILED', 'EXPIRED', 'CANCELLED'])('never confirms a %s migration despite later device contact', async status => {
    m.tpvCommandQueue.findUnique.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-1',
      venueId: 'venue-new',
      commandType: 'FACTORY_RESET',
      status,
      createdAt: T0,
      resultMessage: 'Detalle del fallo',
    })
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-new',
      lastActivationStatusCheckAt: new Date(T0.getTime() + 60_000),
      lastHeartbeat: new Date(),
    })
    expect(await migrateStatus('term-1', 'cmd-1')).toMatchObject({
      confirmed: false,
      commandDelivered: false,
      resultMessage: 'Detalle del fallo',
    })
  })

  it('confirmed=false when activation check predates the wipe command', async () => {
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-new',
      lastActivationStatusCheckAt: new Date(T0.getTime() - 60_000), // before T0 (stale)
      lastHeartbeat: new Date(),
    })
    const r = await migrateStatus('term-1', 'cmd-1')
    expect(r.reboundAfterWipe).toBe(false)
    expect(r.confirmed).toBe(false)
  })

  it('confirmed=false when device rebound but is still offline', async () => {
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-new',
      lastActivationStatusCheckAt: new Date(T0.getTime() + 60_000),
      lastHeartbeat: new Date(Date.now() - 10 * 60_000), // 10 min ago → offline
    })
    const r = await migrateStatus('term-1', 'cmd-1')
    expect(r.reboundAfterWipe).toBe(false)
    expect(r.onlineUnderNewVenue).toBe(false)
    expect(r.confirmed).toBe(false)
  })

  // REGRESSION / guard: a command belonging to a different terminal must not be addressable.
  it('throws when the command belongs to a different terminal', async () => {
    m.tpvCommandQueue.findUnique.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-OTHER',
      venueId: 'venue-new',
      commandType: 'FACTORY_RESET',
      status: 'SENT',
      createdAt: T0,
    })
    await expect(migrateStatus('term-1', 'cmd-1')).rejects.toThrow('Migration command not found for terminal')
  })

  // Guard: a non-migration command (not FACTORY_RESET) must not be usable as a status target.
  it('throws when the command is not a FACTORY_RESET (e.g. LOCK)', async () => {
    m.tpvCommandQueue.findUnique.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-1',
      venueId: 'venue-new',
      commandType: 'LOCK',
      status: 'SENT',
      createdAt: T0,
    })
    await expect(migrateStatus('term-1', 'cmd-1')).rejects.toThrow('Migration command not found for terminal')
  })
})

it('does not claim destination contact while a deferred migration is still at its origin', async () => {
  m.tpvCommandQueue.findUnique.mockResolvedValue({
    id: 'cmd-1',
    terminalId: 'term-1',
    venueId: 'origin',
    commandType: 'FACTORY_RESET',
    status: 'QUEUED',
    createdAt: T0,
    payload: { _migrationIntent: { toVenueId: 'destination' } },
  })
  m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'origin', lastHeartbeat: new Date() })
  expect((await migrateStatus('term-1', 'cmd-1')).onlineUnderNewVenue).toBe(false)
  m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'destination', lastHeartbeat: new Date() })
  expect((await migrateStatus('term-1', 'cmd-1')).onlineUnderNewVenue).toBe(true)
})

it('only confirms a completed migration after an authenticated new app session', async () => {
  m.tpvCommandQueue.findUnique.mockResolvedValue({
    id: 'cmd-1',
    terminalId: 'term-1',
    venueId: 'venue-new',
    commandType: 'FACTORY_RESET',
    status: 'COMPLETED',
    createdAt: T0,
    payload: { _deliveryProtocol: 2, _originCommandSessionId: 'old-boot' },
  })
  m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', commandSessionId: 'old-boot', lastHeartbeat: new Date() })
  expect((await migrateStatus('term-1', 'cmd-1')).confirmed).toBe(false)
  m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', commandSessionId: 'new-boot', lastHeartbeat: new Date() })
  expect((await migrateStatus('term-1', 'cmd-1')).confirmed).toBe(true)
})
