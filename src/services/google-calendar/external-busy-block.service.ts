/**
 * ExternalBusyBlock — persistence helpers (Phase 1 — Task 14).
 *
 * `ExternalBusyBlock` is the read-only projection of a Google Calendar event
 * we use to block reservation availability. The Phase 1 sync engine never
 * touches `Reservation` directly — it just adds/removes rows here.
 *
 * Two time formats from Google:
 *   - Timed events:  `start.dateTime` (ISO 8601 with offset) → store as UTC.
 *   - All-day events: `start.date` (YYYY-MM-DD, no time) → interpret at local
 *                     midnight in the CALENDAR'S timezone (not the venue's, not
 *                     the staff member's current TZ — Google's stored TZ at
 *                     connect time). v1 known limitation: a staff member who
 *                     travels across timezones will see their "vacation"
 *                     all-day event resolved in the calendar's home TZ.
 *
 * Google's `end.date` for all-day events is EXCLUSIVE (vacation 15-16 ends at
 * the 17th's midnight), so we pass it through verbatim — `fromZonedTime` does
 * the right thing.
 */
import { Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import type { calendar_v3 } from 'googleapis'

export interface ParsedEventTime {
  startsAt: Date
  endsAt: Date
  allDay: boolean
}

/**
 * Parse a Google event's start/end into UTC `Date` instances.
 *
 * @param calendarTimeZone IANA timezone of the calendar (e.g. `America/Mexico_City`).
 *                         For all-day events, midnights are resolved in this TZ.
 */
export function parseGoogleEventTime(event: calendar_v3.Schema$Event, calendarTimeZone: string): ParsedEventTime {
  if (event.start?.date) {
    if (!event.end?.date) {
      throw new Error('all_day_event_missing_end_date')
    }
    // Google sends YYYY-MM-DD; resolve to local midnight in the calendar's TZ → UTC.
    const startsAt = fromZonedTime(new Date(`${event.start.date}T00:00:00`), calendarTimeZone)
    const endsAt = fromZonedTime(new Date(`${event.end.date}T00:00:00`), calendarTimeZone)
    return { startsAt, endsAt, allDay: true }
  }

  if (!event.start?.dateTime || !event.end?.dateTime) {
    throw new Error('timed_event_missing_datetime')
  }
  return {
    startsAt: new Date(event.start.dateTime),
    endsAt: new Date(event.end.dateTime),
    allDay: false,
  }
}

export interface UpsertArgs {
  connectionId: string
  venueId: string | null
  staffId: string | null
  externalCalendarId: string
  event: calendar_v3.Schema$Event
  calendarTimeZone: string
}

/**
 * Upsert an `ExternalBusyBlock` row keyed on `(connectionId, externalEventId)`.
 *
 * Used inside `prisma.$transaction` callbacks — the caller decides the
 * transaction boundary. Idempotent: rerunning with the same event is safe.
 *
 * `isPrivate` is set when the calendar's visibility is `private` OR the event
 * has no summary — we never want to leak titles through public-facing surfaces.
 */
export async function upsertBlock(tx: Prisma.TransactionClient, args: UpsertArgs): Promise<void> {
  if (!args.event.id) {
    throw new Error('google_event_missing_id')
  }
  const t = parseGoogleEventTime(args.event, args.calendarTimeZone)

  await tx.externalBusyBlock.upsert({
    where: {
      googleConnectionId_externalEventId: {
        googleConnectionId: args.connectionId,
        externalEventId: args.event.id,
      },
    },
    create: {
      googleConnectionId: args.connectionId,
      venueId: args.venueId,
      staffId: args.staffId,
      externalCalendarId: args.externalCalendarId,
      externalEventId: args.event.id,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      allDay: t.allDay,
      title: args.event.summary ?? null,
      isPrivate: args.event.visibility === 'private' || !args.event.summary,
    },
    update: {
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      allDay: t.allDay,
      title: args.event.summary ?? null,
      isPrivate: args.event.visibility === 'private' || !args.event.summary,
    },
  })
}

/**
 * Delete an `ExternalBusyBlock` by `(connectionId, externalEventId)`.
 *
 * Uses `deleteMany` rather than `delete` so a tombstone for an unknown event
 * (e.g. a cancellation we never saw the original of) is a no-op rather than
 * throwing P2025.
 */
export async function deleteBlock(tx: Prisma.TransactionClient, connectionId: string, externalEventId: string): Promise<void> {
  await tx.externalBusyBlock.deleteMany({
    where: { googleConnectionId: connectionId, externalEventId },
  })
}
