/**
 * Live Demo Cleanup — cleanupExpiredLiveDemos / cleanupAllLiveDemos
 *
 * LiveDemoSession has onDelete: Cascade on venueId, so deleting the demo venue
 * (deleteVenueData) already removes the session row at the DB level. The
 * explicit session delete that follows must therefore be idempotent —
 * otherwise every cleanup throws P2025 ("No record was found for a delete"),
 * cleanedCount never increments and the cron logs a false error per session
 * (prod, 2026-07-03 03:00 UTC).
 */

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cleanupExpiredLiveDemos, cleanupAllLiveDemos } from '@/services/cleanup/liveDemoCleanup.service'

const prismaMock = prisma as any

function p2025(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('No record was found for a delete.', {
    code: 'P2025',
    clientVersion: '6.14.0',
  })
}

function makeSession(n = 1) {
  return {
    id: `lds-${n}`,
    sessionId: `session-uuid-${n}`,
    venueId: `venue-${n}`,
    staffId: `staff-${n}`,
    venue: { id: `venue-${n}`, name: `Live Demo ${n}`, status: 'LIVE_DEMO' },
    staff: { id: `staff-${n}`, email: `demo${n}@avoqado.io` },
  }
}

/**
 * Mocks the DB exactly as prod behaves after deleteVenueData ran:
 * the venue cascade already removed the LiveDemoSession row, so an exact
 * .delete() throws P2025 while .deleteMany() resolves with count 0.
 */
function mockCascadeAlreadyDeletedSession(status = 'LIVE_DEMO') {
  prismaMock.venue.findUnique.mockResolvedValue({ status, name: 'Live Demo 1' })
  prismaMock.venue.delete.mockResolvedValue({})
  prismaMock.staff.delete.mockResolvedValue({})
  prismaMock.liveDemoSession.delete.mockRejectedValue(p2025())
  prismaMock.liveDemoSession.deleteMany.mockResolvedValue({ count: 0 })
}

describe('cleanupExpiredLiveDemos — cascade-tolerant session delete', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('counts a session as cleaned even though the venue cascade already deleted the session row', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.venue.delete).toHaveBeenCalledWith({ where: { id: 'venue-1' } })
    expect(prismaMock.staff.delete).toHaveBeenCalledWith({ where: { id: 'staff-1' } })
    // Idempotent delete: tolerates the row being gone (cascade), never throws P2025
    expect(prismaMock.liveDemoSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'lds-1' } })
  })

  it('cleans the remaining sessions when one of them fails', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1), makeSession(2)])
    mockCascadeAlreadyDeletedSession()
    prismaMock.staff.delete.mockRejectedValueOnce(new Error('transient DB error')).mockResolvedValueOnce({})

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.venue.delete).toHaveBeenCalledTimes(2)
  })

  // REGRESSION: pre-existing behavior that must not change
  it('still returns 0 and deletes nothing when there are no expired sessions', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([])

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(0)
    expect(prismaMock.venue.delete).not.toHaveBeenCalled()
    expect(prismaMock.staff.delete).not.toHaveBeenCalled()
  })

  it('still refuses to delete a non-LIVE_DEMO venue and does not count the session', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession('ACTIVE')

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(0)
    expect(prismaMock.venue.delete).not.toHaveBeenCalled()
    expect(prismaMock.staff.delete).not.toHaveBeenCalled()
  })
})

describe('cleanupAllLiveDemos — cascade-tolerant session delete', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('counts a session as cleaned even though the venue cascade already deleted the session row', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    const cleaned = await cleanupAllLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.liveDemoSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'lds-1' } })
  })
})
