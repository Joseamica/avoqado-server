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

/**
 * Every name is reloaded at most this often, with ONE query for all venues: a rename shows up
 * within 10 minutes. The old design refreshed each venue on its own with `findUnique` — one query
 * per active venue every 10 minutes, and `findUnique` goes through Prisma's fluent wrapper, which
 * rebuilds a map of the model's 256 fields on every call. The production CPU profile of
 * 2026-09-28 caught it as the #1 trigger of that cost: 150 lookups, 744 ms of blocked thread in
 * 6 minutes, just to put names on log lines.
 */
const REFRESH_MS = 10 * 60 * 1000
/**
 * A venue the cache does not know (created after the last load, or an id that does not exist)
 * triggers a reload at most this often — never one query per request.
 */
const UNKNOWN_RETRY_MS = 60 * 1000

const names = new Map<string, string>()
/** When the last load STARTED: a failed load also waits its turn, so an outage is not a query storm. */
let lastLoadAt = Number.NEGATIVE_INFINITY
/** The load in flight, so N concurrent requests cause ONE query. */
let loading: Promise<number> | null = null

/**
 * The venue's name, or undefined while it is still unknown.
 *
 * Never awaits and never throws. An unknown or stale cache schedules a background reload and
 * returns whatever it has right now.
 */
export function getVenueName(venueId: string | undefined | null): string | undefined {
  if (!venueId) return undefined

  const name = names.get(venueId)
  const due = name === undefined ? UNKNOWN_RETRY_MS : REFRESH_MS
  if (Date.now() - lastLoadAt > due) void loadAllVenueNames()
  return name
}

/**
 * Loads every venue name into the cache at boot, so the very first log line of the process
 * already carries a name — including the errors that show up seconds after a deploy.
 *
 * Returns how many names were loaded (0 when the database was unreachable). Never throws:
 * the server must boot regardless.
 */
export function primeVenueNames(): Promise<number> {
  return loadAllVenueNames()
}

/**
 * One query for every name. Deduplicated, and silent on failure by design: a failed load keeps
 * serving the names it already had.
 *
 * `findMany`, not a per-venue `findUnique`: Prisma's fluent wrapper (see
 * `scripts/parchar-prisma-runtime.cjs`) only wraps the single-row methods.
 * ponytail: every venue in one query — fine for thousands of rows; past `UMBRAL_FILAS_DEFAULT`
 * (2000) the query guard will start flagging it, and it should become a keyset walk by id.
 */
function loadAllVenueNames(): Promise<number> {
  if (!loading) {
    lastLoadAt = Date.now()
    // `.finally` always runs on a later tick, so it can never clear `loading` before it is set.
    loading = queryAllVenueNames().finally(() => {
      loading = null
    })
  }
  return loading
}

async function queryAllVenueNames(): Promise<number> {
  try {
    const venues = await prisma.venue.findMany({ select: { id: true, name: true } })
    for (const venue of venues) {
      if (venue.name) names.set(venue.id, venue.name)
    }
    return venues.length
  } catch {
    // Deliberately silent — see the module docstring. Logs fall back to the raw venueId.
    return 0
  }
}

/** Test seam: the cache is process-wide state, so each test needs a clean one. */
export function __resetVenueNameCacheForTests(): void {
  names.clear()
  lastLoadAt = Number.NEGATIVE_INFINITY
  loading = null
}
