/**
 * external-busy-block.service — unit tests (Phase 1 — Task 14).
 *
 * Covers:
 *   - All-day event in America/Mexico_City (UTC-6) → startsAt at 06:00:00Z.
 *   - Timed event with offset → preserved as UTC.
 *   - Recurring instance id passes through to the upsert key.
 *   - deleteBlock against unknown id is a no-op (deleteMany, no P2025).
 *   - upsertBlock surfaces isPrivate when summary is missing.
 */
import type { calendar_v3 } from 'googleapis'

import { deleteBlock, parseGoogleEventTime, upsertBlock } from '@/services/google-calendar/external-busy-block.service'

// Minimal stub of Prisma.TransactionClient that records the calls.
type Calls = {
  upsert: jest.Mock
  deleteMany: jest.Mock
}
function makeTx(): { tx: any; calls: Calls } {
  const calls: Calls = {
    upsert: jest.fn().mockResolvedValue(undefined),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  }
  const tx = {
    externalBusyBlock: {
      upsert: calls.upsert,
      deleteMany: calls.deleteMany,
    },
  }
  return { tx, calls }
}

describe('parseGoogleEventTime', () => {
  // ============================================================
  // NEW FEATURE TESTS
  // ============================================================
  it('all-day event in America/Mexico_City → UTC midnight + 6h', () => {
    const event: calendar_v3.Schema$Event = {
      id: 'ev-1',
      start: { date: '2026-05-15' },
      end: { date: '2026-05-16' }, // exclusive
    }
    const t = parseGoogleEventTime(event, 'America/Mexico_City')
    expect(t.allDay).toBe(true)
    expect(t.startsAt.toISOString()).toBe('2026-05-15T06:00:00.000Z')
    expect(t.endsAt.toISOString()).toBe('2026-05-16T06:00:00.000Z')
  })

  it('timed event with explicit UTC offset preserved as UTC', () => {
    const event: calendar_v3.Schema$Event = {
      id: 'ev-2',
      start: { dateTime: '2026-05-15T10:00:00-06:00', timeZone: 'America/Mexico_City' },
      end: { dateTime: '2026-05-15T11:00:00-06:00', timeZone: 'America/Mexico_City' },
    }
    const t = parseGoogleEventTime(event, 'America/Mexico_City')
    expect(t.allDay).toBe(false)
    expect(t.startsAt.toISOString()).toBe('2026-05-15T16:00:00.000Z')
    expect(t.endsAt.toISOString()).toBe('2026-05-15T17:00:00.000Z')
  })

  it('multi-day all-day event spans correct UTC window', () => {
    const event: calendar_v3.Schema$Event = {
      id: 'vac-1',
      start: { date: '2026-12-22' },
      end: { date: '2027-01-03' }, // 12-day vacation, end is exclusive (Jan 2 inclusive)
    }
    const t = parseGoogleEventTime(event, 'America/Mexico_City')
    expect(t.startsAt.toISOString()).toBe('2026-12-22T06:00:00.000Z')
    expect(t.endsAt.toISOString()).toBe('2027-01-03T06:00:00.000Z')
  })

  it('throws if all-day event is missing end.date', () => {
    expect(() => parseGoogleEventTime({ id: 'x', start: { date: '2026-05-15' } } as any, 'America/Mexico_City')).toThrow(
      'all_day_event_missing_end_date',
    )
  })

  it('throws if timed event is missing dateTime', () => {
    expect(() => parseGoogleEventTime({ id: 'x', start: {}, end: {} } as any, 'America/Mexico_City')).toThrow(
      'timed_event_missing_datetime',
    )
  })
})

describe('upsertBlock', () => {
  // ============================================================
  // NEW FEATURE TESTS
  // ============================================================
  it('writes startsAt/endsAt/allDay/title/isPrivate computed from the event', async () => {
    const { tx, calls } = makeTx()
    const event: calendar_v3.Schema$Event = {
      id: 'ev-7',
      summary: 'Dentist',
      start: { dateTime: '2026-05-15T10:00:00-06:00' },
      end: { dateTime: '2026-05-15T11:00:00-06:00' },
    }

    await upsertBlock(tx, {
      connectionId: 'conn-1',
      venueId: 'venue-1',
      staffId: null,
      externalCalendarId: 'cal-1',
      event,
      calendarTimeZone: 'America/Mexico_City',
    })

    expect(calls.upsert).toHaveBeenCalledTimes(1)
    const arg = calls.upsert.mock.calls[0][0]
    expect(arg.where.googleConnectionId_externalEventId).toEqual({
      googleConnectionId: 'conn-1',
      externalEventId: 'ev-7',
    })
    expect(arg.create).toMatchObject({
      googleConnectionId: 'conn-1',
      venueId: 'venue-1',
      staffId: null,
      externalCalendarId: 'cal-1',
      externalEventId: 'ev-7',
      allDay: false,
      title: 'Dentist',
      isPrivate: false,
    })
    expect((arg.create.startsAt as Date).toISOString()).toBe('2026-05-15T16:00:00.000Z')
    expect((arg.update.startsAt as Date).toISOString()).toBe('2026-05-15T16:00:00.000Z')
  })

  it('passes recurring instance id (Google materializes recurring → unique ids per instance)', async () => {
    const { tx, calls } = makeTx()
    const event: calendar_v3.Schema$Event = {
      id: 'recurring_20260515T100000Z',
      summary: 'Weekly check-in',
      start: { dateTime: '2026-05-15T10:00:00Z' },
      end: { dateTime: '2026-05-15T11:00:00Z' },
    }
    await upsertBlock(tx, {
      connectionId: 'conn-1',
      venueId: null,
      staffId: 'staff-1',
      externalCalendarId: 'cal-1',
      event,
      calendarTimeZone: 'America/Mexico_City',
    })
    const arg = calls.upsert.mock.calls[0][0]
    expect(arg.where.googleConnectionId_externalEventId.externalEventId).toBe('recurring_20260515T100000Z')
  })

  it('isPrivate=true when summary missing OR visibility=private', async () => {
    const { tx, calls } = makeTx()
    await upsertBlock(tx, {
      connectionId: 'c',
      venueId: null,
      staffId: 's',
      externalCalendarId: 'cal',
      event: {
        id: 'ev-private',
        start: { dateTime: '2026-05-15T10:00:00Z' },
        end: { dateTime: '2026-05-15T11:00:00Z' },
        visibility: 'private',
        summary: 'Therapy appointment',
      },
      calendarTimeZone: 'UTC',
    })
    expect(calls.upsert.mock.calls[0][0].create.isPrivate).toBe(true)

    await upsertBlock(tx, {
      connectionId: 'c',
      venueId: null,
      staffId: 's',
      externalCalendarId: 'cal',
      event: {
        id: 'ev-untitled',
        start: { dateTime: '2026-05-15T10:00:00Z' },
        end: { dateTime: '2026-05-15T11:00:00Z' },
      },
      calendarTimeZone: 'UTC',
    })
    expect(calls.upsert.mock.calls[1][0].create.isPrivate).toBe(true)
  })

  it('throws if event.id is missing (signals corrupt Google payload)', async () => {
    const { tx } = makeTx()
    await expect(
      upsertBlock(tx, {
        connectionId: 'c',
        venueId: null,
        staffId: 's',
        externalCalendarId: 'cal',
        event: {
          start: { dateTime: '2026-05-15T10:00:00Z' },
          end: { dateTime: '2026-05-15T11:00:00Z' },
        } as any,
        calendarTimeZone: 'UTC',
      }),
    ).rejects.toThrow('google_event_missing_id')
  })
})

describe('deleteBlock', () => {
  // ============================================================
  // NEW FEATURE TESTS
  // ============================================================
  it('uses deleteMany so unknown event id is a silent no-op', async () => {
    const { tx, calls } = makeTx()
    await deleteBlock(tx, 'conn-1', 'unknown-event-id')
    expect(calls.deleteMany).toHaveBeenCalledWith({
      where: { googleConnectionId: 'conn-1', externalEventId: 'unknown-event-id' },
    })
  })

  // ============================================================
  // REGRESSION TESTS
  // ============================================================
  it('REGRESSION: does NOT call delete() (which would throw P2025 for missing rows)', async () => {
    const { tx, calls } = makeTx()
    await deleteBlock(tx, 'conn-1', 'ev-x')
    // The fake tx never had a `delete` method — call would have been undefined.
    expect((tx.externalBusyBlock as any).delete).toBeUndefined()
    expect(calls.deleteMany).toHaveBeenCalled()
  })
})
