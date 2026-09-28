/**
 * A `venueId` in a log line is a cuid — `cms1qzg6o02jxi32bkm2ta66g` tells a human nothing.
 * Every production investigation started by copying that id into a database query just to
 * learn which business the error belonged to.
 *
 * This cache exists so every log line can carry the venue's NAME. Three properties make it
 * safe to sit on the authentication hot path, and all are tested here:
 *
 * 1. Reads are synchronous and never touch the database. Observability must not add
 *    latency to a request that is about to take a payment.
 * 2. A database failure is invisible. Resolving a name is a nicety; it can never break
 *    authentication, and it must never throw into a caller that only wanted to log.
 * 3. 🔴 The cost is ONE query for every name, at most every 10 minutes (every minute while a
 *    venue is unknown) — never one query per venue or per request. The production CPU profile
 *    of 2026-09-28 caught the old per-venue `findUnique` refresh as the #1 trigger of Prisma's
 *    O(n²) field map: 150 lookups / 744 ms of blocked thread in 6 minutes, just to name logs.
 */

import { getVenueName, primeVenueNames, __resetVenueNameCacheForTests } from '@/observability/venueNames'
import prisma from '@/utils/prismaClient'

const prismaMock = prisma as unknown as {
  venue: { findUnique: jest.Mock; findMany: jest.Mock }
}

/** Lets the fire-and-forget refresh settle before asserting on its result. */
const flush = () => new Promise(resolve => setImmediate(resolve))

const MINUTO = 60 * 1000
let ahora = 1_000_000_000
let reloj: jest.SpyInstance

beforeEach(() => {
  __resetVenueNameCacheForTests()
  prismaMock.venue.findUnique.mockReset()
  prismaMock.venue.findMany.mockReset()
  ahora = 1_000_000_000
  reloj = jest.spyOn(Date, 'now').mockImplementation(() => ahora)
})

afterEach(() => {
  // 🔴 Never the per-venue lookup: `findUnique` goes through Prisma's fluent wrapper, which is
  // exactly the cost this cache exists to avoid.
  expect(prismaMock.venue.findUnique).not.toHaveBeenCalled()
  reloj.mockRestore()
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
    // The point of priming: reads never hit the database again.
    expect(prismaMock.venue.findMany).toHaveBeenCalledTimes(1)
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
    prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-nuevo', name: 'Venue Nuevo' }])

    // First sight: unknown, and the caller is not blocked waiting for it.
    expect(getVenueName('venue-nuevo')).toBeUndefined()
    await flush()

    expect(getVenueName('venue-nuevo')).toBe('Venue Nuevo')
  })

  it('asks the database only once while a load is already in flight', async () => {
    prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-nuevo', name: 'Venue Nuevo' }])

    getVenueName('venue-nuevo')
    getVenueName('venue-nuevo')
    getVenueName('otro-venue')
    await flush()

    expect(prismaMock.venue.findMany).toHaveBeenCalledTimes(1)
  })

  it('handles a missing venueId without touching the database', () => {
    expect(getVenueName(undefined)).toBeUndefined()
    expect(getVenueName(null)).toBeUndefined()
    expect(getVenueName('')).toBeUndefined()
    expect(prismaMock.venue.findMany).not.toHaveBeenCalled()
  })
})

describe('🔴 venue name cache — one query for every name, never one per venue or per request', () => {
  it('a stale cache is refreshed with ONE query for all venues, not one query per venue', async () => {
    prismaMock.venue.findMany.mockResolvedValue([
      { id: 'v1', name: 'Uno' },
      { id: 'v2', name: 'Dos' },
      { id: 'v3', name: 'Tres' },
    ])
    await primeVenueNames()

    ahora += 11 * MINUTO
    getVenueName('v1')
    getVenueName('v2')
    getVenueName('v3')
    await flush()

    expect(prismaMock.venue.findMany).toHaveBeenCalledTimes(2) // boot + one refresh
  })

  it('within 10 minutes known names never trigger a query, however many requests arrive', async () => {
    prismaMock.venue.findMany.mockResolvedValue([{ id: 'v1', name: 'Uno' }])
    await primeVenueNames()

    ahora += 9 * MINUTO
    for (let i = 0; i < 500; i++) getVenueName('v1')
    await flush()

    expect(prismaMock.venue.findMany).toHaveBeenCalledTimes(1)
  })

  it('a rename shows up after the next refresh, and the old name is served until then', async () => {
    prismaMock.venue.findMany.mockResolvedValueOnce([{ id: 'v1', name: 'Nombre Viejo' }])
    await primeVenueNames()

    prismaMock.venue.findMany.mockResolvedValueOnce([{ id: 'v1', name: 'Nombre Nuevo' }])
    ahora += 11 * MINUTO
    expect(getVenueName('v1')).toBe('Nombre Viejo')
    await flush()

    expect(getVenueName('v1')).toBe('Nombre Nuevo')
  })

  it('🔴 an id that does not exist causes at most one query per minute, not one per request', async () => {
    prismaMock.venue.findMany.mockResolvedValue([])

    expect(getVenueName('no-existe')).toBeUndefined()
    await flush()
    for (let i = 0; i < 200; i++) expect(getVenueName('no-existe')).toBeUndefined()
    await flush()
    expect(prismaMock.venue.findMany).toHaveBeenCalledTimes(1)

    ahora += MINUTO + 1
    getVenueName('no-existe')
    await flush()
    expect(prismaMock.venue.findMany).toHaveBeenCalledTimes(2)
  })
})

describe('🔴 venue name cache — a database failure stays invisible', () => {
  it('swallows the error and keeps returning undefined', async () => {
    prismaMock.venue.findMany.mockRejectedValue(new Error("P1001: Can't reach database server"))

    expect(() => getVenueName('venue-1')).not.toThrow()
    await flush()
    expect(getVenueName('venue-1')).toBeUndefined()
  })

  it('a database outage does not turn into one query per request', async () => {
    prismaMock.venue.findMany.mockRejectedValue(new Error('db down'))

    getVenueName('venue-1')
    await flush()
    for (let i = 0; i < 100; i++) getVenueName('venue-1')
    await flush()

    expect(prismaMock.venue.findMany).toHaveBeenCalledTimes(1)
  })

  it('keeps serving the last known name when a refresh fails', async () => {
    prismaMock.venue.findMany.mockResolvedValueOnce([{ id: 'venue-1', name: 'Testarudo Cafe' }])
    await primeVenueNames()

    prismaMock.venue.findMany.mockRejectedValue(new Error('db down'))
    ahora += 11 * MINUTO
    // A stale name is strictly better than no name — same reasoning as the offline print config.
    expect(getVenueName('venue-1')).toBe('Testarudo Cafe')
    await flush()
    expect(getVenueName('venue-1')).toBe('Testarudo Cafe')
  })
})
