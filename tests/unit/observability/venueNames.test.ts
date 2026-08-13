/**
 * A `venueId` in a log line is a cuid — `cms1qzg6o02jxi32bkm2ta66g` tells a human nothing.
 * Every production investigation started by copying that id into a database query just to
 * learn which business the error belonged to.
 *
 * This cache exists so every log line can carry the venue's NAME. Two properties make it
 * safe to sit on the authentication hot path, and both are tested here:
 *
 * 1. Reads are synchronous and never touch the database. Observability must not add
 *    latency to a request that is about to take a payment.
 * 2. A database failure is invisible. Resolving a name is a nicety; it can never break
 *    authentication, and it must never throw into a caller that only wanted to log.
 */

import { getVenueName, primeVenueNames, __resetVenueNameCacheForTests } from '@/observability/venueNames'
import prisma from '@/utils/prismaClient'

const prismaMock = prisma as unknown as {
  venue: { findUnique: jest.Mock; findMany: jest.Mock }
}

/** Lets the fire-and-forget refresh settle before asserting on its result. */
const flush = () => new Promise(resolve => setImmediate(resolve))

beforeEach(() => {
  __resetVenueNameCacheForTests()
  prismaMock.venue.findUnique.mockReset()
  prismaMock.venue.findMany.mockReset()
})

describe('venue name cache — priming', () => {
  it('loads every venue up front, so the first log line already carries a name', async () => {
    prismaMock.venue.findMany.mockResolvedValue([
      { id: 'venue-1', name: 'Testarudo Cafe' },
      { id: 'venue-2', name: 'BAE Unidad Pavón' },
    ])

    const loaded = await primeVenueNames()

    expect(loaded).toBe(2)
    expect(getVenueName('venue-1')).toBe('Testarudo Cafe')
    expect(getVenueName('venue-2')).toBe('BAE Unidad Pavón')
    // The point of priming: reads never hit the database.
    expect(prismaMock.venue.findUnique).not.toHaveBeenCalled()
  })

  it('🔴 a failed prime never throws — the server must still boot', async () => {
    prismaMock.venue.findMany.mockRejectedValue(new Error("Can't reach database server"))

    await expect(primeVenueNames()).resolves.toBe(0)
    expect(getVenueName('venue-1')).toBeUndefined()
  })
})

describe('venue name cache — reads', () => {
  it('🔴 is synchronous: a cached read never awaits the database', async () => {
    prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-1', name: 'Testarudo Cafe' }])
    await primeVenueNames()

    // No await here on purpose — this is what the auth middleware does on every request.
    expect(getVenueName('venue-1')).toBe('Testarudo Cafe')
  })

  it('resolves a venue created after boot, in the background', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ name: 'Venue Nuevo' })

    // First sight: unknown, and the caller is not blocked waiting for it.
    expect(getVenueName('venue-nuevo')).toBeUndefined()
    await flush()

    expect(getVenueName('venue-nuevo')).toBe('Venue Nuevo')
  })

  it('asks the database only once while a lookup is already in flight', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ name: 'Venue Nuevo' })

    getVenueName('venue-nuevo')
    getVenueName('venue-nuevo')
    getVenueName('venue-nuevo')
    await flush()

    expect(prismaMock.venue.findUnique).toHaveBeenCalledTimes(1)
  })

  it('returns undefined for a venue that does not exist, without retrying forever in one tick', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(null)

    expect(getVenueName('no-existe')).toBeUndefined()
    await flush()
    expect(getVenueName('no-existe')).toBeUndefined()
  })

  it('handles a missing venueId without touching the database', () => {
    expect(getVenueName(undefined)).toBeUndefined()
    expect(prismaMock.venue.findUnique).not.toHaveBeenCalled()
  })
})

describe('🔴 venue name cache — a database failure stays invisible', () => {
  it('swallows the error and keeps returning undefined', async () => {
    prismaMock.venue.findUnique.mockRejectedValue(new Error("P1001: Can't reach database server"))

    expect(() => getVenueName('venue-1')).not.toThrow()
    await flush()
    expect(getVenueName('venue-1')).toBeUndefined()
  })

  it('keeps serving the last known name when a refresh fails', async () => {
    prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-1', name: 'Testarudo Cafe' }])
    await primeVenueNames()

    prismaMock.venue.findUnique.mockRejectedValue(new Error('db down'))
    // A stale name is strictly better than no name — same reasoning as the offline print config.
    expect(getVenueName('venue-1')).toBe('Testarudo Cafe')
    await flush()
    expect(getVenueName('venue-1')).toBe('Testarudo Cafe')
  })
})
