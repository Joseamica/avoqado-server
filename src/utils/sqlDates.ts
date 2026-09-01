import { Prisma } from '@prisma/client'
import { sanitizeTimezone } from './sanitizeTimezone'

/**
 * Date binds and venue-local buckets for raw SQL over `timestamp without time zone`
 * columns that store real UTC — which is every DateTime column in this schema.
 *
 * Verified against findMany on the exact boundary (2026-09-01): a Prisma `Date` bound
 * into `$queryRaw` / `$queryRawUnsafe` arrives as `timestamptz`. Compared directly, or
 * cast with `::timestamp`, Postgres converts it with the SESSION time zone before
 * comparing. That zone is NOT the same everywhere we run (measured 2026-09-01): the local
 * Mac Postgres is `America/Mexico_City`, so a bare bind shifts the filter 6 hours there;
 * production on Render is `UTC`, where a bare bind happens to be right. `utcTs` returns
 * the same rows under both zones (proved in org-stock-date-binds.integration.test.ts),
 * which is what makes it safe to ship.
 * `AT TIME ZONE 'UTC'` turns the instant into its UTC wall clock — exactly what the
 * column stores and what a Prisma `createdAt: { gte }` compares.
 *
 *   WHERE o."createdAt" >= ${utcTs(from)}      -- ✅ same rows as findMany
 *   WHERE o."createdAt" >= ${from}             -- ❌ shifted 6 hours
 *   WHERE o."createdAt" >= ${from}::timestamp  -- ❌ shifted 6 hours
 *
 * The same session dependency breaks buckets built with a SINGLE `AT TIME ZONE tz` over
 * a UTC column: the stored value is read as if it were local time, so the "local" day or
 * hour comes out in UTC (a 20:00 sale lands on the next day, at hour 02). The correct
 * bucket applies it twice — UTC first, then the venue zone.
 */

/** Instant → its UTC wall clock (`timestamp`), comparable against any DateTime column. */
export const utcTs = (d: Date): Prisma.Sql => Prisma.sql`(${d} AT TIME ZONE 'UTC')`

/**
 * Same, for nullable columns written through `UPDATE … SET col = …`. A bare `NULL`
 * cannot be typed by Postgres inside `AT TIME ZONE`, hence the explicit cast.
 */
export const utcTsOrNull = (d: Date | null | undefined): Prisma.Sql => (d == null ? Prisma.sql`NULL::timestamp` : utcTs(d))

/**
 * Positional flavour for `$queryRawUnsafe`: the Date still travels as parameter `$n`,
 * only the SQL text changes. `"createdAt" >= ${utcTsParam(2)}` with `params[1]` a Date.
 */
export const utcTsParam = (n: number): string => `($${n} AT TIME ZONE 'UTC')`

/**
 * Venue wall clock of a UTC column (`timestamp`, no zone) — the value to bucket by.
 * `DATE_TRUNC`, `EXTRACT` and `TO_CHAR` over it yield the venue's day/hour regardless of
 * the session time zone. Prisma seals the result as UTC, so it IS the wall clock: format
 * it with `timeZone: 'UTC'`, never with the venue zone (that would shift it back).
 */
export const localWallClock = (tz: string, col: Prisma.Sql = Prisma.raw('o."createdAt"')): Prisma.Sql =>
  Prisma.sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${tz})`

/** String flavour for `$queryRawUnsafe`. The zone is interpolated, so it is sanitized here, always. */
export const localWallClockRaw = (tz: string, colExpr: string): string =>
  `((${colExpr} AT TIME ZONE 'UTC') AT TIME ZONE '${sanitizeTimezone(tz)}')`

/**
 * Turns a wall-clock expression (e.g. `DATE_TRUNC('day', localWallClockRaw(...))`) back
 * into the instant it names (`timestamptz`): midnight of that venue day, on the venue's
 * own clock. Consumers that format the period IN the venue zone (dashboard `period` ISO
 * strings, the TPV's `periodStart`) keep their contract; only the day the sale falls on
 * is corrected.
 */
export const localInstantRaw = (tz: string, wallClockExpr: string): string => `(${wallClockExpr} AT TIME ZONE '${sanitizeTimezone(tz)}')`
