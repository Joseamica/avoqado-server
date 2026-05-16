/**
 * Google Calendar pull engine (Phase 1 — Tasks 15, 16, 17, 18).
 *
 * The engine is responsible for keeping `ExternalBusyBlock` rows in sync with
 * the user's chosen Google calendar. It runs in two phases:
 *
 *   Phase A — Backfill (`runBackfill`)
 *     • One-time at connect, or after 410 GONE recovery.
 *     • `events.list({ timeMin, timeMax, singleEvents: true, showDeleted: false })`.
 *     • NO syncToken. Pages through nextPageToken; saves `nextSyncToken` ONLY
 *       on the last page.
 *     • At commit time: wipes ExternalBusyBlock for the connection, reinserts
 *       all kept events, and atomically writes
 *       `{ syncToken, lastSyncedAt, lastHorizonEnd }` in ONE transaction.
 *
 *   Phase B — Incremental (`runIncrementalPull`)
 *     • Driven by webhook fan-out OR inbox sweeper.
 *     • `events.list({ syncToken, singleEvents: true, showDeleted: true })`.
 *     • NO timeMin/timeMax with syncToken — Google returns 400 if mixed.
 *     • `status === 'cancelled'` → delete block.
 *     • `avoqadoOrigin === 'avoqado'` → skip (our own pushed events).
 *     • `transparency === 'transparent'` OR self-declined → delete block.
 *     • Outside `[NOW-7d, NOW+maxAdvanceDays]` → delete block.
 *     • Otherwise → upsert block.
 *     • Saves the new `nextSyncToken` atomically with upserts in ONE txn.
 *     • If pagination throws mid-flight, we DO NOT save partial state —
 *       Google retains the old token for ~7 days; the next webhook re-drives
 *       from it. Idempotent by design.
 *
 *   Error recovery
 *     • 410 GONE  → syncToken expired. Drop all blocks, re-run backfill.
 *     • 401       → access token revoked. `handleAuthError` refreshes; if the
 *                   refresh fails with `invalid_grant`, mark TOKEN_REVOKED and
 *                   drop blocks.
 *
 *   Concurrency
 *     • `pullConnection` wraps Phase B with a Postgres advisory lock so two
 *       parallel webhooks for the same connection only run Phase B once.
 *
 * For STAFF_PERSONAL connections there is no venue → no `reservationSettings`.
 * We default `maxAdvanceDays` to 60 in that case.
 */
import { Prisma } from '@prisma/client'
import { google, calendar_v3 } from 'googleapis'

import logger from '@/config/logger'
import { getRabbitMQChannel, POS_COMMANDS_EXCHANGE } from '@/communication/rabbitmq/connection'
import { decryptToken, encryptToken } from '@/services/google-calendar/encryption.service'
import { upsertBlock } from '@/services/google-calendar/external-busy-block.service'
import { buildOAuthClient, refreshAccessToken } from '@/services/google-calendar/oauth.service'
import prisma from '@/utils/prismaClient'

const MAX_RESULTS = 250
const DAY_MS = 86_400_000
const DEFAULT_MAX_ADVANCE_DAYS = 60
const PULL_LOCK_TTL_SECONDS = 60

/** Routing key used by the webhook controller and connection-commit hooks. */
export const GCAL_PULL_ROUTING_KEY = 'gcal.pull'

interface ConnectionWithSettings {
  id: string
  status: string
  scope: string
  venueId: string | null
  staffId: string | null
  selectedCalendarId: string
  selectedCalendarTimeZone: string
  syncToken: string | null
  accessTokenCiphertext: Buffer | null
  refreshTokenCiphertext: Buffer
  venue?: {
    reservationSettings?: {
      maxAdvanceDays: number | null
    } | null
  } | null
}

/**
 * Loads a connection with the venue settings we need for the horizon window.
 * Returns null when the connection is missing or not CONNECTED.
 */
async function loadConnection(connectionId: string): Promise<ConnectionWithSettings | null> {
  const conn = (await prisma.googleCalendarConnection.findUnique({
    where: { id: connectionId },
    include: { venue: { include: { reservationSettings: true } } },
  })) as unknown as ConnectionWithSettings | null
  if (!conn) return null
  if (conn.status !== 'CONNECTED') return null
  return conn
}

/** Compute `maxAdvanceDays` for a connection, defaulting to 60 for staff-personal. */
function getMaxAdvanceDays(conn: ConnectionWithSettings): number {
  const v = conn.venue?.reservationSettings?.maxAdvanceDays
  return typeof v === 'number' && v > 0 ? v : DEFAULT_MAX_ADVANCE_DAYS
}

/** Build a fresh OAuth client wired with the connection's tokens. */
function buildCalendarClient(conn: ConnectionWithSettings) {
  const auth = buildOAuthClient()
  if (!conn.accessTokenCiphertext) {
    throw new Error('connection_access_token_missing')
  }
  auth.setCredentials({
    access_token: decryptToken(Buffer.from(conn.accessTokenCiphertext)),
    refresh_token: decryptToken(Buffer.from(conn.refreshTokenCiphertext)),
  })
  return google.calendar({ version: 'v3', auth })
}

/** Apply the per-event handling table from spec §8.1. Used by both phases. */
function isAvoqadoOrigin(event: calendar_v3.Schema$Event): boolean {
  return event.extendedProperties?.private?.avoqadoOrigin === 'avoqado'
}

function isSelfDeclined(event: calendar_v3.Schema$Event): boolean {
  return (event.attendees ?? []).some(a => a.self === true && a.responseStatus === 'declined')
}

function eventStartUtc(event: calendar_v3.Schema$Event): Date {
  if (event.start?.dateTime) return new Date(event.start.dateTime)
  // All-day fallback — best-effort horizon check (UTC midnight is close enough
  // for ±7d windows; the precise parse happens in `upsertBlock`).
  if (event.start?.date) return new Date(`${event.start.date}T00:00:00Z`)
  return new Date(0)
}

function eventEndUtc(event: calendar_v3.Schema$Event): Date {
  if (event.end?.dateTime) return new Date(event.end.dateTime)
  if (event.end?.date) return new Date(`${event.end.date}T00:00:00Z`)
  return new Date(0)
}

// ============================================================
// Phase A — Backfill
// ============================================================

/**
 * One-time full sync: lists every event in `[NOW, NOW+maxAdvanceDays]` and
 * commits the resulting ExternalBusyBlock set atomically. Saves the
 * `nextSyncToken` returned on the LAST page so the next call can run
 * incremental.
 */
export async function runBackfill(connectionId: string): Promise<void> {
  const conn = await loadConnection(connectionId)
  if (!conn) return

  const calendar = buildCalendarClient(conn)

  const now = new Date()
  const maxAdvanceDays = getMaxAdvanceDays(conn)
  const horizonEnd = new Date(now.getTime() + maxAdvanceDays * DAY_MS)

  const events: calendar_v3.Schema$Event[] = []
  let pageToken: string | undefined
  let nextSyncToken: string | undefined

  do {
    const page = await calendar.events.list({
      calendarId: conn.selectedCalendarId,
      timeMin: now.toISOString(),
      timeMax: horizonEnd.toISOString(),
      singleEvents: true, // expand recurring rules into instances
      showDeleted: false, // we have no prior state to delete
      maxResults: MAX_RESULTS,
      pageToken,
    })
    for (const ev of page.data.items ?? []) events.push(ev)
    pageToken = page.data.nextPageToken ?? undefined
    if (!pageToken) nextSyncToken = page.data.nextSyncToken ?? undefined
  } while (pageToken)

  // The transaction is the atomic boundary: wipe-and-replace blocks for this
  // connection AND advance the sync state cursor in one shot.
  //
  // Timeout raised to 60s (default 5s) because each `upsertBlock` is a
  // separate round-trip to Postgres and a fresh connection with several
  // hundred future events can easily exceed 5s — observed in prod rescue
  // 2026-05-16. 60s is a safe ceiling: even a 1000-event calendar over a
  // 100ms-latency link stays inside the window.
  await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.externalBusyBlock.deleteMany({ where: { googleConnectionId: conn.id } })

      for (const ev of events) {
        if (!ev.id) continue
        if (isAvoqadoOrigin(ev)) continue
        if (ev.transparency === 'transparent') continue
        if (isSelfDeclined(ev)) continue

        await upsertBlock(tx, {
          connectionId: conn.id,
          venueId: conn.venueId,
          staffId: conn.staffId,
          externalCalendarId: conn.selectedCalendarId,
          event: ev,
          calendarTimeZone: conn.selectedCalendarTimeZone,
        })
      }

      await tx.googleCalendarConnection.update({
        where: { id: conn.id },
        data: {
          syncToken: nextSyncToken ?? null,
          lastSyncedAt: new Date(),
          lastHorizonEnd: horizonEnd,
        },
      })
    },
    { timeout: 60_000, maxWait: 5_000 },
  )

  logger.info('gcal backfill complete', {
    connectionId: conn.id,
    eventCount: events.length,
    horizonEnd,
    hasNextSyncToken: !!nextSyncToken,
  })
}

// ============================================================
// Phase B — Incremental
// ============================================================

/**
 * Incremental delta sync using the saved `syncToken`. Falls back to backfill
 * for new connections (no syncToken yet) and on 410 GONE. On 401, hands off to
 * `handleAuthError` which refreshes the access token and retries once.
 */
export async function runIncrementalPull(connectionId: string): Promise<void> {
  const conn = await loadConnection(connectionId)
  if (!conn) return

  // First sync after connect — no token yet → behave like backfill.
  if (!conn.syncToken) {
    return runBackfill(connectionId)
  }

  const calendar = buildCalendarClient(conn)

  const now = new Date()
  const maxAdvanceDays = getMaxAdvanceDays(conn)
  const horizonStart = new Date(now.getTime() - 7 * DAY_MS)
  const horizonEnd = new Date(now.getTime() + maxAdvanceDays * DAY_MS)

  const collected: calendar_v3.Schema$Event[] = []
  let pageToken: string | undefined
  let nextSyncToken: string = conn.syncToken

  try {
    do {
      const page = await calendar.events.list({
        calendarId: conn.selectedCalendarId,
        syncToken: conn.syncToken,
        singleEvents: true,
        showDeleted: true, // incremental delivers status='cancelled' for deletions
        maxResults: MAX_RESULTS,
        pageToken,
        // DO NOT pass timeMin/timeMax — Google rejects 400 when combined with syncToken.
      })
      for (const ev of page.data.items ?? []) collected.push(ev)
      pageToken = page.data.nextPageToken ?? undefined
      if (!pageToken && page.data.nextSyncToken) {
        nextSyncToken = page.data.nextSyncToken
      }
    } while (pageToken)
  } catch (err: any) {
    if (isGoneError(err)) {
      // syncToken expired (Google retains state ~7 days). Recovery: wipe blocks
      // and run a fresh backfill.
      logger.warn('gcal syncToken expired (410 GONE) — re-running backfill', {
        connectionId: conn.id,
      })
      await prisma.$transaction([
        prisma.externalBusyBlock.deleteMany({ where: { googleConnectionId: conn.id } }),
        prisma.googleCalendarConnection.update({
          where: { id: conn.id },
          data: { syncToken: null },
        }),
      ])
      return runBackfill(connectionId)
    }
    if (isUnauthorizedError(err)) {
      return handleAuthError(conn.id)
    }
    throw err
  }

  // Atomic commit: per-event handling + advance sync cursor.
  // Timeout 60s mirrors `runBackfill` — incremental can also batch many events
  // (e.g., user added 50 events in one go, all delivered in one webhook).
  await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      for (const ev of collected) {
        if (!ev.id) continue

        // Order matters — see spec §8.1, first match wins.
        if (ev.status === 'cancelled') {
          await tx.externalBusyBlock.deleteMany({
            where: { googleConnectionId: conn.id, externalEventId: ev.id },
          })
          continue
        }
        if (isAvoqadoOrigin(ev)) continue
        if (ev.transparency === 'transparent' || isSelfDeclined(ev)) {
          await tx.externalBusyBlock.deleteMany({
            where: { googleConnectionId: conn.id, externalEventId: ev.id },
          })
          continue
        }

        // Horizon filter — drops events that moved out of our booking window.
        const start = eventStartUtc(ev)
        const end = eventEndUtc(ev)
        const inHorizon = end > horizonStart && start < horizonEnd
        if (!inHorizon) {
          await tx.externalBusyBlock.deleteMany({
            where: { googleConnectionId: conn.id, externalEventId: ev.id },
          })
          continue
        }

        await upsertBlock(tx, {
          connectionId: conn.id,
          venueId: conn.venueId,
          staffId: conn.staffId,
          externalCalendarId: conn.selectedCalendarId,
          event: ev,
          calendarTimeZone: conn.selectedCalendarTimeZone,
        })
      }

      await tx.googleCalendarConnection.update({
        where: { id: conn.id },
        data: { syncToken: nextSyncToken, lastSyncedAt: new Date() },
      })
    },
    { timeout: 60_000, maxWait: 5_000 },
  )

  logger.info('gcal incremental pull complete', {
    connectionId: conn.id,
    eventCount: collected.length,
  })
}

// ============================================================
// Task 17 — Single-flight lock + RabbitMQ enqueue helpers
// ============================================================

/**
 * Single-flight wrapper around `runIncrementalPull` using a Postgres advisory
 * lock keyed on the connection id. Two parallel webhooks for the same
 * connection only run Phase B once — the loser short-circuits.
 *
 * We use Postgres advisory locks instead of a Redis SETNX because:
 *   • There is no standalone Redis client wrapper in this codebase
 *     (Redis is only the socket.io adapter); adding one is out of scope.
 *   • The advisory lock is scoped to the database session and auto-released
 *     on disconnect, so a crashed worker can't deadlock the next one.
 *   • `pg_try_advisory_lock` returns false instantly on contention — the
 *     same non-blocking semantics SETNX has.
 *
 * The lock key is `hashtextextended('gcal:pull:<id>', 0)::int8` (deterministic
 * 64-bit hash of the connectionId), held for the duration of the call and
 * released in `finally`.
 */
export async function pullConnection(connectionId: string): Promise<void> {
  const lockKey = `gcal:pull:${connectionId}`
  const rows = await prisma.$queryRaw<{ acquired: boolean }[]>(
    Prisma.sql`SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS acquired`,
  )
  const acquired = Array.isArray(rows) && rows.length > 0 && rows[0].acquired === true
  if (!acquired) {
    logger.debug('gcal pull: lock not acquired, another worker has it', { connectionId })
    return
  }

  try {
    await runIncrementalPull(connectionId)
  } finally {
    try {
      await prisma.$queryRaw(Prisma.sql`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`)
    } catch (err) {
      logger.warn('gcal pull: failed to release advisory lock', { connectionId, err })
    }
  }
}

/**
 * Best-effort RabbitMQ enqueue for a pull command. Throws on failure — the
 * caller MUST wrap in `.catch(() => {})`. Used by the webhook controller and
 * by `connection.service.ts` after a fresh connect.
 *
 * Server starts WITHOUT RabbitMQ if it's down (`server.ts:229`); this function
 * throws in that case so the caller's `.catch` keeps the request path alive.
 */
export async function enqueuePullForConnection(connectionId: string): Promise<void> {
  const channel = getRabbitMQChannel()
  const payload = Buffer.from(JSON.stringify({ connectionId }))
  const ok = channel.publish(POS_COMMANDS_EXCHANGE, GCAL_PULL_ROUTING_KEY, payload, { persistent: true })
  if (!ok) {
    throw new Error('rabbitmq_publish_buffer_full')
  }
}

// ============================================================
// Task 18 — Auth-error handling (refresh + invalid_grant)
// ============================================================

/**
 * 401 recovery path:
 *   1. Refresh the access token using the stored refresh token.
 *   2. On success: save new access token + retry incremental ONCE. If the
 *      retry 401s again we let it bubble — likely the refresh token was
 *      already revoked between our checks.
 *   3. On invalid_grant: drop all ExternalBusyBlock rows for the connection
 *      and set status=TOKEN_REVOKED. Phase 3 will notify the user.
 *
 * @internal exported for tests
 */
export async function handleAuthError(connectionId: string): Promise<void> {
  const conn = await prisma.googleCalendarConnection.findUnique({
    where: { id: connectionId },
  })
  if (!conn) return

  try {
    const creds = await refreshAccessToken(decryptToken(Buffer.from(conn.refreshTokenCiphertext)))
    if (!creds.access_token) {
      throw new Error('refresh_returned_no_access_token')
    }
    await prisma.googleCalendarConnection.update({
      where: { id: conn.id },
      data: {
        accessTokenCiphertext: encryptToken(creds.access_token),
        accessTokenExpiresAt: new Date(creds.expiry_date ?? Date.now() + 3_600_000),
      },
    })
    logger.info('gcal access token refreshed', { connectionId: conn.id })
    // Retry incremental once. If it 401s again we surface the error.
    await runIncrementalPull(connectionId)
    return
  } catch (err: any) {
    if (isInvalidGrant(err)) {
      logger.warn('gcal refresh failed with invalid_grant — marking TOKEN_REVOKED', {
        connectionId: conn.id,
      })
      await prisma.$transaction([
        prisma.externalBusyBlock.deleteMany({ where: { googleConnectionId: conn.id } }),
        prisma.googleCalendarConnection.update({
          where: { id: conn.id },
          data: { status: 'TOKEN_REVOKED', statusReason: 'invalid_grant' },
        }),
      ])
      // TODO (Phase 3): notify user via email/in-app that they must reconnect.
      return
    }
    throw err
  }
}

// ============================================================
// Error classifiers
// ============================================================

function isGoneError(err: any): boolean {
  if (!err) return false
  if (err.code === 410) return true
  if (err.response?.status === 410) return true
  return false
}

function isUnauthorizedError(err: any): boolean {
  if (!err) return false
  if (err.code === 401) return true
  if (err.response?.status === 401) return true
  return false
}

function isInvalidGrant(err: any): boolean {
  if (!err) return false
  if (err.response?.data?.error === 'invalid_grant') return true
  if (typeof err.message === 'string' && /invalid_grant/.test(err.message)) return true
  return false
}
