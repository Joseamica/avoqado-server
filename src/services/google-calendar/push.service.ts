/**
 * Google Calendar push engine (Phase 2 — outbox worker).
 *
 * Single public entry point: `processOutboxRow(outboxRowId)`. The function is
 * idempotent and concurrency-safe — a Postgres advisory-xact lock keyed on the
 * row's `syncKey` ensures parallel workers / sweepers can't double-push the
 * same source mutation. The Subagent 3 outbox sweeper + RabbitMQ consumer
 * both call this, passing only the row id.
 *
 * Operations:
 *   • CREATE         — idempotency-search Google by privateExtendedProperty
 *                       first; if present, just save a mapping. Otherwise
 *                       `events.insert` + save mapping.
 *   • UPDATE         — find existing mapping; if missing promote to CREATE.
 *                       Otherwise `events.patch` with a fresh body.
 *   • CANCEL         — find mapping; either delete (when
 *                       `googleCalendarRemoveCancelled=true`) or patch with
 *                       status=cancelled + [CANCELADA] title prefix.
 *   • UPDATE_ROSTER  — ClassSession only. Re-fetch the class with current
 *                       attendees and patch the description.
 *
 * Retry / backoff:
 *   • 7 attempts max → status=DEAD_LETTER.
 *   • Backoff schedule (minutes): 0.5, 2, 10, 60, 360, 1440, 10080. Each
 *     failure stamps `scheduledAt` so the sweeper picks the row up again.
 *   • Failures don't rethrow — they're persisted to `lastError`.
 *
 * Source-state guard: before pushing CREATE/UPDATE we re-read the source row
 * inside the same transaction. If it's been deleted or cancelled mid-flight
 * we mark the outbox row SKIPPED with a reason and skip the Google call.
 * This prevents a "ghost event" appearing in someone's calendar a few
 * milliseconds after they cancelled in Avoqado.
 */
import { Prisma } from '@prisma/client'
import type { calendar_v3 } from 'googleapis'
import { google } from 'googleapis'

import logger from '@/config/logger'
import { decryptToken } from '@/services/google-calendar/encryption.service'
import { buildOAuthClient } from '@/services/google-calendar/oauth.service'
import prisma from '@/utils/prismaClient'

import {
  buildEventBodyForClassSession,
  buildEventBodyForReservation,
  normalizeDetailLevel,
  type ClassSessionWithRelations,
  type EventDetailLevel,
  type ReservationWithRelations,
} from './event-body.service'

const MAX_ATTEMPTS = 7
const TX_TIMEOUT_MS = 60_000
const TX_MAX_WAIT_MS = 5_000

/** Exponential backoff schedule in minutes per attempt number (1-indexed).
 * Capped at 7 days — anything that fails that long is in DEAD_LETTER anyway. */
const BACKOFF_MINUTES = [0.5, 2, 10, 60, 360, 1440, 10080]

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'https://dashboardv2.avoqado.io'

/** Tx-bound prisma client passed to handlers. We narrow to a structural type
 * so the helpers can be unit-tested against the mock prisma. */
type Tx = Prisma.TransactionClient

// ============================================================
// Internal types — what the row include shape returns
// ============================================================

type OutboxRowWithRelations = Prisma.CalendarSyncOutboxGetPayload<{
  include: {
    reservation: {
      include: {
        customer: true
        product: true
        venue: { include: { reservationSettings: true } }
      }
    }
    classSession: {
      include: {
        product: true
        venue: { include: { reservationSettings: true } }
        reservations: { include: { customer: true } }
      }
    }
    targetConnection: true
  }
}>

// ============================================================
// Public entry point
// ============================================================

export async function processOutboxRow(outboxRowId: string): Promise<void> {
  // Whole row processing wrapped in a single transaction so:
  //   • the advisory lock is held until commit (auto-released on rollback)
  //   • status updates land atomically with mapping writes
  //   • Phase 1 learned the 5s default isn't enough when Google round-trip is slow
  await prisma.$transaction(
    async (tx: Tx) => {
      const row = (await tx.calendarSyncOutbox.findUnique({
        where: { id: outboxRowId },
        include: {
          reservation: {
            include: {
              customer: true,
              product: true,
              venue: { include: { reservationSettings: true } },
            },
          },
          classSession: {
            include: {
              product: true,
              venue: { include: { reservationSettings: true } },
              reservations: { include: { customer: true } },
            },
          },
          targetConnection: true,
        },
      })) as OutboxRowWithRelations | null

      if (!row) return

      // Only PENDING/FAILED rows are picked up. IN_PROGRESS means another
      // worker beat us into the transaction — bail and let it finish.
      if (row.status !== 'PENDING' && row.status !== 'FAILED') return

      // Single-flight: one push per syncKey at a time. Use try-variant so we
      // return immediately on contention instead of blocking the worker pool.
      const lockKey = `gcal-push:${row.syncKey}`
      const lockRows = await tx.$queryRaw<{ acquired: boolean }[]>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS acquired`,
      )
      const acquired = Array.isArray(lockRows) && lockRows.length > 0 && lockRows[0].acquired === true
      if (!acquired) {
        logger.debug('gcal push: lock not acquired, another worker has it', {
          outboxRowId: row.id,
          syncKey: row.syncKey,
        })
        return
      }

      // Stake our claim BEFORE the network call. If we crash, the row stays
      // IN_PROGRESS until the sweeper resets stuck rows (Subagent 3 territory).
      await tx.calendarSyncOutbox.update({
        where: { id: row.id },
        data: { status: 'IN_PROGRESS', attempts: { increment: 1 } },
      })

      const calendar = buildCalendarClientForConnection(row.targetConnection)

      try {
        if (row.operation === 'CREATE') {
          await handleCreate(tx, row, calendar)
        } else if (row.operation === 'UPDATE') {
          await handleUpdate(tx, row, calendar)
        } else if (row.operation === 'CANCEL') {
          await handleCancel(tx, row, calendar)
        } else if (row.operation === 'UPDATE_ROSTER') {
          await handleUpdateRoster(tx, row, calendar)
        }
      } catch (err: any) {
        const errMsg = err?.message ?? String(err)
        const nextAttempts = row.attempts + 1
        const nextStatus = nextAttempts >= MAX_ATTEMPTS ? 'DEAD_LETTER' : 'FAILED'
        await tx.calendarSyncOutbox.update({
          where: { id: row.id },
          data: {
            status: nextStatus,
            lastError: errMsg.slice(0, 500),
            scheduledAt: new Date(Date.now() + computeBackoffMs(nextAttempts)),
          },
        })
        logger.warn('gcal push: outbox row failed', {
          outboxRowId: row.id,
          syncKey: row.syncKey,
          operation: row.operation,
          attempts: nextAttempts,
          status: nextStatus,
          err: errMsg,
        })
      }
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
  )
}

// ============================================================
// Operation handlers
// ============================================================

async function handleCreate(tx: Tx, row: OutboxRowWithRelations, calendar: calendar_v3.Calendar): Promise<void> {
  // 1. Re-read source state. If cancelled/deleted while we sat in the queue,
  //    swallow the push and mark SKIPPED.
  const stale = await isSourceCancelled(tx, row)
  if (stale) {
    await markSkipped(tx, row, stale)
    return
  }

  const target = row.targetConnection
  const idempotencyProp = row.reservationId ? `avoqadoReservationId=${row.reservationId}` : `avoqadoClassSessionId=${row.classSessionId}`

  // 2. Idempotency check — if the event already exists in the calendar (a
  //    previous attempt crashed AFTER insert but BEFORE writing the mapping),
  //    we'd otherwise create a duplicate.
  const existing = await calendar.events.list({
    calendarId: target.selectedCalendarId,
    privateExtendedProperty: [idempotencyProp],
    showDeleted: false,
  })
  const existingItems = existing.data.items ?? []
  if (existingItems.length > 0 && existingItems[0].id) {
    await upsertMapping(tx, row, existingItems[0].id, 'PUSHED')
    await markSuccess(tx, row.id)
    return
  }

  // 3. Build the body
  const body = buildBodyForRow(row)

  // 4. Insert
  const inserted = await calendar.events.insert({
    calendarId: target.selectedCalendarId,
    requestBody: body,
  })
  const newEventId = inserted.data.id
  if (!newEventId) {
    throw new Error('events.insert returned no id')
  }

  // 5. Save mapping + mark success
  await upsertMapping(tx, row, newEventId, 'PUSHED')
  await markSuccess(tx, row.id)
}

async function handleUpdate(tx: Tx, row: OutboxRowWithRelations, calendar: calendar_v3.Calendar): Promise<void> {
  // 1. Re-read source — UPDATE on a cancelled source is meaningless.
  const stale = await isSourceCancelled(tx, row)
  if (stale) {
    await markSkipped(tx, row, stale)
    return
  }

  // 2. Find existing mapping for this (source × target).
  const mapping = await findMapping(tx, row)
  if (!mapping) {
    // No mapping yet → the prior CREATE either never ran or failed. Promote
    // to CREATE so the source gets pushed at all.
    return handleCreate(tx, row, calendar)
  }

  // 3. Patch with a fresh body
  const body = buildBodyForRow(row)
  await calendar.events.patch({
    calendarId: row.targetConnection.selectedCalendarId,
    eventId: mapping.googleEventId,
    requestBody: body,
  })

  await tx.reservationGoogleEventMapping.update({
    where: { connectionId_googleEventId: { connectionId: mapping.connectionId, googleEventId: mapping.googleEventId } },
    data: { lastPushedAt: new Date(), lastStatus: 'PATCHED' },
  })
  await markSuccess(tx, row.id)
}

async function handleCancel(tx: Tx, row: OutboxRowWithRelations, calendar: calendar_v3.Calendar): Promise<void> {
  // 1. Find existing mapping
  const mapping = await findMapping(tx, row)
  if (!mapping) {
    // Never pushed in the first place — nothing to cancel. Idempotent no-op.
    await markSuccess(tx, row.id, 'no_mapping_to_cancel')
    return
  }

  // 2. Per-venue policy: hard delete vs. patch with status=cancelled
  const settings = getReservationSettings(row)
  const removeCancelled = settings?.googleCalendarRemoveCancelled === true
  const calendarId = row.targetConnection.selectedCalendarId

  if (removeCancelled) {
    await calendar.events.delete({ calendarId, eventId: mapping.googleEventId })
  } else {
    // Get current title so we can prefix [CANCELADA] without losing context.
    const current = await calendar.events.get({ calendarId, eventId: mapping.googleEventId })
    const currentSummary = (current.data.summary ?? '').trim()
    const currentDescription = current.data.description ?? ''
    const cancelLine = `— Cancelada en Avoqado el ${new Date().toISOString()}`

    await calendar.events.patch({
      calendarId,
      eventId: mapping.googleEventId,
      requestBody: {
        summary: currentSummary.startsWith('[CANCELADA]') ? currentSummary : `[CANCELADA] ${currentSummary}`.trim(),
        status: 'cancelled',
        description: currentDescription ? `${currentDescription}\n\n${cancelLine}` : cancelLine,
      },
    })
  }

  // 3. Mark mapping TOMBSTONED so future UPDATEs to a cancelled reservation
  //    don't accidentally hit the (deleted or tombstoned) event.
  await tx.reservationGoogleEventMapping.update({
    where: { connectionId_googleEventId: { connectionId: mapping.connectionId, googleEventId: mapping.googleEventId } },
    data: { lastPushedAt: new Date(), lastStatus: 'TOMBSTONED' },
  })
  await markSuccess(tx, row.id)
}

async function handleUpdateRoster(tx: Tx, row: OutboxRowWithRelations, calendar: calendar_v3.Calendar): Promise<void> {
  // Only meaningful for ClassSession rows
  if (!row.classSessionId || !row.classSession) {
    await markSkipped(tx, row, 'roster_requires_class_session')
    return
  }

  const mapping = await findMapping(tx, row)
  if (!mapping) {
    // Class was never pushed somehow — nothing to update.
    await markSuccess(tx, row.id, 'no_mapping_for_roster_update')
    return
  }

  // Re-fetch the class with its CURRENT reservation list. The row.classSession
  // snapshot might be stale because attendees added/cancelled while debounce
  // ran.
  const fresh = (await tx.classSession.findUnique({
    where: { id: row.classSessionId },
    include: {
      product: true,
      venue: { include: { reservationSettings: true } },
      reservations: { include: { customer: true } },
    },
  })) as ClassSessionWithRelations | null

  if (!fresh) {
    await markSkipped(tx, row, 'class_session_deleted')
    return
  }

  const settings = (fresh.venue as any).reservationSettings as
    | { googleCalendarEventDetailLevel?: string; googleCalendarClassRosterInDescription?: boolean }
    | null
    | undefined

  const body = buildEventBodyForClassSession({
    classSession: fresh,
    detailLevel: normalizeDetailLevel(settings?.googleCalendarEventDetailLevel),
    dashboardUrl: DASHBOARD_URL,
    includeRosterInDescription: settings?.googleCalendarClassRosterInDescription ?? true,
  })

  await calendar.events.patch({
    calendarId: row.targetConnection.selectedCalendarId,
    eventId: mapping.googleEventId,
    requestBody: { description: body.description },
  })

  await tx.reservationGoogleEventMapping.update({
    where: { connectionId_googleEventId: { connectionId: mapping.connectionId, googleEventId: mapping.googleEventId } },
    data: { lastPushedAt: new Date(), lastStatus: 'PATCHED' },
  })
  await markSuccess(tx, row.id)
}

// ============================================================
// Helpers — body building + mapping + state transitions
// ============================================================

function buildBodyForRow(row: OutboxRowWithRelations): calendar_v3.Schema$Event {
  if (row.reservationId) {
    if (!row.reservation) {
      throw new Error('outbox row references reservation but include returned null')
    }
    const settings = (row.reservation.venue as any).reservationSettings as { googleCalendarEventDetailLevel?: string } | null | undefined
    return buildEventBodyForReservation({
      reservation: row.reservation as ReservationWithRelations,
      detailLevel: normalizeDetailLevel(settings?.googleCalendarEventDetailLevel),
      dashboardUrl: DASHBOARD_URL,
    })
  }
  if (row.classSessionId) {
    if (!row.classSession) {
      throw new Error('outbox row references classSession but include returned null')
    }
    const settings = (row.classSession.venue as any).reservationSettings as
      | { googleCalendarEventDetailLevel?: string; googleCalendarClassRosterInDescription?: boolean }
      | null
      | undefined
    return buildEventBodyForClassSession({
      classSession: row.classSession as ClassSessionWithRelations,
      detailLevel: normalizeDetailLevel(settings?.googleCalendarEventDetailLevel),
      dashboardUrl: DASHBOARD_URL,
      includeRosterInDescription: settings?.googleCalendarClassRosterInDescription ?? true,
    })
  }
  // DB CHECK constraint should prevent this, but throw a clear error if a
  // malformed row sneaks past (e.g., raw SQL insertion that bypassed Prisma).
  throw new Error('outbox row has neither reservationId nor classSessionId set')
}

async function findMapping(tx: Tx, row: OutboxRowWithRelations): Promise<{ connectionId: string; googleEventId: string } | null> {
  if (row.reservationId) {
    return tx.reservationGoogleEventMapping.findFirst({
      where: { reservationId: row.reservationId, connectionId: row.targetConnectionId },
      select: { connectionId: true, googleEventId: true },
    })
  }
  return tx.reservationGoogleEventMapping.findFirst({
    where: { classSessionId: row.classSessionId!, connectionId: row.targetConnectionId },
    select: { connectionId: true, googleEventId: true },
  })
}

async function upsertMapping(
  tx: Tx,
  row: OutboxRowWithRelations,
  googleEventId: string,
  status: 'PUSHED' | 'PATCHED' | 'TOMBSTONED' | 'FAILED',
): Promise<void> {
  const now = new Date()
  await tx.reservationGoogleEventMapping.upsert({
    where: {
      connectionId_googleEventId: {
        connectionId: row.targetConnectionId,
        googleEventId,
      },
    },
    create: {
      reservationId: row.reservationId ?? null,
      classSessionId: row.classSessionId ?? null,
      connectionId: row.targetConnectionId,
      googleEventId,
      lastPushedAt: now,
      lastStatus: status,
    },
    update: {
      lastPushedAt: now,
      lastStatus: status,
    },
  })
}

async function markSuccess(tx: Tx, rowId: string, reason?: string): Promise<void> {
  await tx.calendarSyncOutbox.update({
    where: { id: rowId },
    data: {
      status: 'SUCCESS',
      processedAt: new Date(),
      lastError: reason ?? null,
    },
  })
}

async function markSkipped(tx: Tx, row: OutboxRowWithRelations, reason: string): Promise<void> {
  await tx.calendarSyncOutbox.update({
    where: { id: row.id },
    data: {
      status: 'SKIPPED',
      processedAt: new Date(),
      lastError: reason,
    },
  })
}

/** Returns a reason string if the source is missing/cancelled, else null. */
async function isSourceCancelled(tx: Tx, row: OutboxRowWithRelations): Promise<string | null> {
  if (row.reservationId) {
    const r = await tx.reservation.findUnique({
      where: { id: row.reservationId },
      select: { status: true, cancelledAt: true },
    })
    if (!r) return 'source_missing'
    if (r.status === 'CANCELLED' || r.cancelledAt !== null) return 'source_cancelled_before_push'
    return null
  }
  if (row.classSessionId) {
    const cs = await tx.classSession.findUnique({
      where: { id: row.classSessionId },
      select: { status: true },
    })
    if (!cs) return 'source_missing'
    if (cs.status === 'CANCELLED') return 'source_cancelled_before_push'
    return null
  }
  return 'source_missing'
}

function getReservationSettings(
  row: OutboxRowWithRelations,
): { googleCalendarRemoveCancelled?: boolean; googleCalendarEventDetailLevel?: string } | null {
  if (row.reservation) {
    return ((row.reservation.venue as any).reservationSettings as any) ?? null
  }
  if (row.classSession) {
    return ((row.classSession.venue as any).reservationSettings as any) ?? null
  }
  return null
}

function buildCalendarClientForConnection(conn: OutboxRowWithRelations['targetConnection']): calendar_v3.Calendar {
  if (!conn.accessTokenCiphertext) {
    throw new Error('connection_access_token_missing')
  }
  const auth = buildOAuthClient()
  auth.setCredentials({
    access_token: decryptToken(Buffer.from(conn.accessTokenCiphertext)),
    refresh_token: decryptToken(Buffer.from(conn.refreshTokenCiphertext)),
  })
  return google.calendar({ version: 'v3', auth })
}

function computeBackoffMs(attemptNumber: number): number {
  // attemptNumber is 1-indexed; clamp into the table.
  const idx = Math.min(Math.max(attemptNumber - 1, 0), BACKOFF_MINUTES.length - 1)
  const minutes = BACKOFF_MINUTES[idx]
  return minutes * 60 * 1000
}

// Re-export the detail-level type for downstream callers / tests.
export type { EventDetailLevel }
