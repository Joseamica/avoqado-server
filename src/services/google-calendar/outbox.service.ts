/**
 * Google Calendar push outbox helpers (Phase 2 — Section C).
 *
 * Companion module to `push.service.ts`. Where the push service drains the
 * outbox + talks to Google, this module is responsible for **deciding what to
 * enqueue** and **enqueuing it transactionally** alongside the source-row
 * mutation. Called from the reservation/classSession service hooks (Subagent
 * 4) so a push is always co-committed with the underlying state change — no
 * orphaned pushes, no missed pushes.
 *
 * Public surface:
 *   • resolveReservationPushTargets / resolveClassSessionPushTargets — read
 *     the venue's push settings + look up CONNECTED GoogleCalendarConnection
 *     rows to decide the target set (single vs dual write). Per spec §10.
 *   • buildSyncKey — canonical "<kind>:<sourceId>:<connId>" formatter that
 *     the push worker uses to scope its pg advisory lock.
 *   • enqueuePush — inserts one outbox row per target connection inside the
 *     caller's transaction. XOR-validates source kind, derives the
 *     idempotencyKey, returns the inserted row ids so the caller can publish
 *     a best-effort RabbitMQ notification after commit.
 *   • collapseSupersededOps — when emitting a CANCEL, mark any earlier
 *     PENDING/FAILED CREATE/UPDATE/UPDATE_ROSTER rows for the same syncKey
 *     as SKIPPED. Prevents a ghost event from arriving in someone's calendar
 *     milliseconds after the cancel.
 */
import { Prisma } from '@prisma/client'

import { ValidationError } from '@/errors/AppError'

export type PushOperation = 'CREATE' | 'UPDATE' | 'CANCEL' | 'UPDATE_ROSTER'
export type PushTargetScope = 'VENUE' | 'STAFF_PERSONAL'

interface PushTarget {
  id: string
  scope: PushTargetScope
}

/**
 * Resolve which Google Calendar connections should receive a push for a given
 * reservation. Logic per spec §10:
 *
 *   1. Read ReservationSettings for the venue.
 *   2. If `googleCalendarPushEnabled=false`, return []. Master kill switch
 *      so the venue can pause push without disconnecting the calendar.
 *   3. Look up staff-personal connection (CONNECTED + scope=STAFF_PERSONAL)
 *      for the assigned staff, if any.
 *   4. Look up venue master connection (CONNECTED + scope=VENUE) for the
 *      venue.
 *   5. dualWrite=true → push to both when both exist.
 *      dualWrite=false (default) → prefer staff personal, fall back to venue.
 *
 * Always pass `tx` so this stays inside the caller's transaction — the lookup
 * needs to see consistent state with whatever the caller is about to mutate.
 */
export async function resolveReservationPushTargets(
  tx: Prisma.TransactionClient,
  args: { venueId: string; assignedStaffId: string | null },
): Promise<PushTarget[]> {
  return resolvePushTargets(tx, args)
}

/**
 * Resolve push targets for a ClassSession. Same shape as reservation: the
 * instructor (assignedStaffId) is preferred, venue master is the fallback.
 * Per spec §14: one event per class, not per attendee — regardless of how
 * many reservations exist on the session.
 */
export async function resolveClassSessionPushTargets(
  tx: Prisma.TransactionClient,
  args: { venueId: string; assignedStaffId: string | null },
): Promise<PushTarget[]> {
  return resolvePushTargets(tx, args)
}

async function resolvePushTargets(
  tx: Prisma.TransactionClient,
  args: { venueId: string; assignedStaffId: string | null },
): Promise<PushTarget[]> {
  const settings = await tx.reservationSettings.findUnique({
    where: { venueId: args.venueId },
    select: {
      googleCalendarPushEnabled: true,
      googleCalendarDualWrite: true,
    },
  })

  // Schema-default behavior when the row doesn't exist: push enabled, no
  // dual-write. Previously a missing row silently disabled push, which broke
  // venues that connected a calendar without ever editing reservation settings
  // (the settings page returns defaults without persisting them).
  const pushEnabled = settings?.googleCalendarPushEnabled ?? true
  const dualWrite = settings?.googleCalendarDualWrite ?? false

  if (!pushEnabled) {
    return []
  }

  // Run both lookups in parallel — they're independent queries on the same tx.
  const [staffConn, venueConn] = await Promise.all([
    args.assignedStaffId
      ? tx.googleCalendarConnection.findFirst({
          where: {
            staffId: args.assignedStaffId,
            scope: 'STAFF_PERSONAL',
            status: 'CONNECTED',
          },
          select: { id: true },
        })
      : Promise.resolve(null),
    tx.googleCalendarConnection.findFirst({
      where: {
        venueId: args.venueId,
        scope: 'VENUE',
        status: 'CONNECTED',
      },
      select: { id: true },
    }),
  ])

  const targets: PushTarget[] = []

  if (dualWrite === true) {
    // Dual-write: emit to both when both exist. Order is deterministic
    // (staff first, venue second) so callers can assert on it in tests.
    if (staffConn) targets.push({ id: staffConn.id, scope: 'STAFF_PERSONAL' })
    if (venueConn) targets.push({ id: venueConn.id, scope: 'VENUE' })
  } else {
    // Single-target: staff personal wins when present, else venue master.
    if (staffConn) {
      targets.push({ id: staffConn.id, scope: 'STAFF_PERSONAL' })
    } else if (venueConn) {
      targets.push({ id: venueConn.id, scope: 'VENUE' })
    }
  }

  return targets
}

/**
 * Canonical `syncKey` string for a (source, connection) pair. The push
 * worker takes a Postgres advisory-xact lock on `hashtextextended(syncKey, 0)`
 * so two mutations to the same source against the same target serialize.
 *
 * Format:
 *   Reservation:  "reservation:<reservationId>:<connectionId>"
 *   ClassSession: "class:<classSessionId>:<connectionId>"
 */
export function buildSyncKey(
  args:
    | { kind: 'reservation'; reservationId: string; connectionId: string }
    | { kind: 'class'; classSessionId: string; connectionId: string },
): string {
  if (args.kind === 'reservation') {
    return `reservation:${args.reservationId}:${args.connectionId}`
  }
  return `class:${args.classSessionId}:${args.connectionId}`
}

export interface EnqueuePushArgs {
  source: { kind: 'reservation'; reservationId: string } | { kind: 'class'; classSessionId: string }
  venueId: string
  operation: PushOperation
  targetConnectionIds: string[]
  debounceUntil?: Date | null
}

/**
 * Enqueue one outbox row per target connection. MUST be called inside the
 * caller's transaction so the rows commit (or roll back) atomically with the
 * source-row mutation that triggered the push.
 *
 * The idempotencyKey is `<syncKey>:<operation>:<epochMs>` — unique per row
 * because epochMs is captured per insert. Two simultaneous CREATEs for the
 * same source against the same target could race past the UNIQUE constraint
 * if they happen in the same millisecond, but the push worker handles
 * duplicates safely (advisory lock + idempotency-search at the Google layer).
 *
 * @returns ids of the inserted outbox rows so the caller can publish them to
 *          the RabbitMQ push consumer after the transaction commits.
 */
export async function enqueuePush(tx: Prisma.TransactionClient, args: EnqueuePushArgs): Promise<string[]> {
  if (!args.source) {
    throw new ValidationError('enqueuePush: source is required')
  }
  // The DB CHECK constraint enforces XOR at the row level, but checking here
  // gives the caller a clearer error than a Prisma constraint violation.
  if (args.source.kind === 'reservation' && !args.source.reservationId) {
    throw new ValidationError('enqueuePush: reservationId required for reservation source')
  }
  if (args.source.kind === 'class' && !args.source.classSessionId) {
    throw new ValidationError('enqueuePush: classSessionId required for class source')
  }

  if (!Array.isArray(args.targetConnectionIds) || args.targetConnectionIds.length === 0) {
    // No targets is a normal outcome (push disabled, no connections) — callers
    // call resolvePushTargets first and skip enqueue when the result is empty.
    // We return [] rather than throwing so the call site stays clean.
    return []
  }

  const ids: string[] = []
  const now = Date.now()

  for (const connectionId of args.targetConnectionIds) {
    const syncKey =
      args.source.kind === 'reservation'
        ? buildSyncKey({ kind: 'reservation', reservationId: args.source.reservationId, connectionId })
        : buildSyncKey({ kind: 'class', classSessionId: args.source.classSessionId, connectionId })

    const idempotencyKey = `${syncKey}:${args.operation}:${now}`

    const created = await tx.calendarSyncOutbox.create({
      data: {
        venueId: args.venueId,
        reservationId: args.source.kind === 'reservation' ? args.source.reservationId : null,
        classSessionId: args.source.kind === 'class' ? args.source.classSessionId : null,
        operation: args.operation,
        targetConnectionId: connectionId,
        syncKey,
        idempotencyKey,
        status: 'PENDING',
        attempts: 0,
        debounceUntil: args.debounceUntil ?? null,
      },
      select: { id: true },
    })
    ids.push(created.id)
  }

  return ids
}

/**
 * CANCEL pre-flight: mark any earlier PENDING/FAILED CREATE/UPDATE/
 * UPDATE_ROSTER rows for the same syncKey as SKIPPED so a queued push doesn't
 * land a ghost event seconds after the cancel.
 *
 * Does NOT touch:
 *   • IN_PROGRESS rows — another worker has them; collapsing under their feet
 *     could orphan a mapping.
 *   • SUCCESS/SKIPPED/DEAD_LETTER rows — already terminal.
 *   • Other CANCEL rows — multiple cancels collapsing each other is wrong;
 *     the last one wins via the worker's advisory lock anyway.
 *
 * Uses the (syncKey, status, createdAt) index for an O(log N) scan.
 */
export async function collapseSupersededOps(tx: Prisma.TransactionClient, syncKey: string, beforeCreatedAt: Date): Promise<number> {
  const result = await tx.calendarSyncOutbox.updateMany({
    where: {
      syncKey,
      status: { in: ['PENDING', 'FAILED'] },
      operation: { in: ['CREATE', 'UPDATE', 'UPDATE_ROSTER'] },
      createdAt: { lt: beforeCreatedAt },
    },
    data: {
      status: 'SKIPPED',
      lastError: 'superseded_by_cancel',
      processedAt: new Date(),
    },
  })
  return result.count
}
