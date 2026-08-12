import prisma from '@/utils/prismaClient'

/**
 * Resolves a venueId to the venue's NAME, so log lines say "Testarudo Cafe" instead of
 * `cms1qzg6o02jxi32bkm2ta66g`.
 *
 * The id alone is useless to a human reading an alert: every investigation used to begin
 * with a database query just to learn which business the error belonged to. The name is what
 * makes a log line actionable on sight.
 *
 * Two properties make this safe to call from the authentication middleware, on every single
 * request:
 *
 * - **Reads are synchronous.** `getVenueName` returns from an in-memory map and never awaits.
 *   Observability must not add latency to a request that is about to take a payment, so the
 *   cache is filled at boot (`primeVenueNames`) and refreshed in the background afterwards.
 * - **Failures are invisible.** A name is a nicety; authentication is not. Every database
 *   error here is swallowed on purpose — the same reasoning as the context wrapper that never
 *   catches: observability may never become the cause of the next bug.
 *
 * A stale name beats no name (a venue rename is cosmetic, an anonymous money alert is not),
 * so a failed refresh keeps serving the last value it knew.
 */

/** How long a cached name is trusted before a background refresh is triggered. */
const TTL_MS = 10 * 60 * 1000

interface CachedName {
  name: string
  cachedAt: number
}

const cache = new Map<string, CachedName>()
/** Venues with a lookup already running, so N concurrent requests cause ONE query. */
const inFlight = new Set<string>()

/**
 * The venue's name, or undefined while it is still unknown.
 *
 * Never awaits and never throws. An unknown or stale venue schedules a refresh and returns
 * whatever it has right now.
 */
export function getVenueName(venueId: string | undefined | null): string | undefined {
  if (!venueId) return undefined

  const cached = cache.get(venueId)
  if (!cached) {
    void refreshVenueName(venueId)
    return undefined
  }

  if (Date.now() - cached.cachedAt > TTL_MS) void refreshVenueName(venueId)
  return cached.name
}

/**
 * Loads every venue name into the cache at boot, so the very first log line of the process
 * already carries a name — including the errors that show up seconds after a deploy.
 *
 * Returns how many names were loaded (0 when the database was unreachable). Never throws:
 * the server must boot regardless.
 */
export async function primeVenueNames(): Promise<number> {
  try {
    const venues = await prisma.venue.findMany({ select: { id: true, name: true } })
    const now = Date.now()
    for (const venue of venues) {
      if (venue.name) cache.set(venue.id, { name: venue.name, cachedAt: now })
    }
    return venues.length
  } catch {
    // Booting without names is degraded, not broken: logs fall back to the raw venueId.
    return 0
  }
}

/** Fire-and-forget single lookup. Deduplicated, and silent on failure by design. */
async function refreshVenueName(venueId: string): Promise<void> {
  if (inFlight.has(venueId)) return
  inFlight.add(venueId)

  try {
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true } })
    if (venue?.name) cache.set(venueId, { name: venue.name, cachedAt: Date.now() })
  } catch {
    // Deliberately silent — see the module docstring. The previous value (if any) stands.
  } finally {
    inFlight.delete(venueId)
  }
}

/** Test seam: the cache is process-wide state, so each test needs a clean one. */
export function __resetVenueNameCacheForTests(): void {
  cache.clear()
  inFlight.clear()
}
