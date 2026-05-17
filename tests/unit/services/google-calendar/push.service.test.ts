/**
 * push.service unit tests (Phase 2 — outbox worker).
 *
 * Covers:
 *   • CREATE: happy path / idempotency hit / source cancelled mid-flight /
 *             source deleted / ClassSession variant
 *   • UPDATE: existing mapping → patch / missing mapping → promote to CREATE
 *   • CANCEL: with mapping + removeCancelled=true → delete /
 *             with mapping + removeCancelled=false → patch [CANCELADA] /
 *             no mapping → no-op success
 *   • UPDATE_ROSTER: re-fetches class + patches description / no mapping no-op
 *   • Retry/backoff: failure increments attempts + schedules retry / 7th
 *                    failure → DEAD_LETTER
 *   • Single-flight advisory lock: contention → returns silently
 */
import { Prisma } from '@prisma/client'

import prisma from '@/utils/prismaClient'

// ---- googleapis ----
const eventsListMock = jest.fn()
const eventsInsertMock = jest.fn()
const eventsPatchMock = jest.fn()
const eventsDeleteMock = jest.fn()
const eventsGetMock = jest.fn()
jest.mock('googleapis', () => ({
  google: {
    calendar: jest.fn(() => ({
      events: {
        list: (...args: any[]) => eventsListMock(...args),
        insert: (...args: any[]) => eventsInsertMock(...args),
        patch: (...args: any[]) => eventsPatchMock(...args),
        delete: (...args: any[]) => eventsDeleteMock(...args),
        get: (...args: any[]) => eventsGetMock(...args),
      },
    })),
  },
}))

// ---- oauth.service ----
jest.mock('@/services/google-calendar/oauth.service', () => ({
  buildOAuthClient: jest.fn(() => ({ setCredentials: jest.fn() })),
}))

// ---- encryption.service ----
jest.mock('@/services/google-calendar/encryption.service', () => ({
  decryptToken: () => 'plaintext-token',
}))

import { processOutboxRow } from '@/services/google-calendar/push.service'

// ============================================================
// Helpers
// ============================================================

function makeConnection(overrides: any = {}): any {
  return {
    id: 'conn-1',
    selectedCalendarId: 'cal-1',
    selectedCalendarTimeZone: 'America/Mexico_City',
    accessTokenCiphertext: Buffer.from('at-enc'),
    refreshTokenCiphertext: Buffer.from('rt-enc'),
    ...overrides,
  }
}

function makeReservation(overrides: any = {}): any {
  return {
    id: 'res-1',
    venueId: 'venue-1',
    status: 'CONFIRMED',
    cancelledAt: null,
    startsAt: new Date('2026-05-20T18:00:00.000Z'),
    endsAt: new Date('2026-05-20T19:00:00.000Z'),
    partySize: 2,
    guestName: null,
    specialRequests: null,
    internalNotes: null,
    customer: { firstName: 'Juan', lastName: 'Pérez', email: null, phone: null },
    product: { id: 'p-1', name: 'Corte' },
    venue: {
      id: 'venue-1',
      slug: 'amaena',
      reservationSettings: {
        googleCalendarEventDetailLevel: 'FULL',
        googleCalendarRemoveCancelled: false,
        googleCalendarClassRosterInDescription: true,
      },
    },
    ...overrides,
  }
}

function makeClassSession(overrides: any = {}): any {
  return {
    id: 'class-1',
    venueId: 'venue-1',
    status: 'SCHEDULED',
    startsAt: new Date('2026-05-22T15:00:00.000Z'),
    endsAt: new Date('2026-05-22T16:00:00.000Z'),
    capacity: 10,
    product: { name: 'Yoga' },
    venue: {
      id: 'venue-1',
      slug: 'amaena',
      reservationSettings: {
        googleCalendarEventDetailLevel: 'FULL',
        googleCalendarRemoveCancelled: false,
        googleCalendarClassRosterInDescription: true,
      },
    },
    reservations: [{ id: 'r-a', partySize: 1, status: 'CONFIRMED', cancelledAt: null, customer: { firstName: 'Ana', lastName: 'G' } }],
    ...overrides,
  }
}

function makeOutboxRow(overrides: any = {}): any {
  const reservation = overrides.reservation === null ? null : (overrides.reservation ?? makeReservation())
  const base = {
    id: 'outbox-1',
    venueId: 'venue-1',
    operation: 'CREATE',
    status: 'PENDING',
    attempts: 0,
    syncKey: 'reservation:res-1:conn-1',
    idempotencyKey: 'ik-1',
    scheduledAt: new Date(),
    processedAt: null,
    lastError: null,
    debounceUntil: null,
    createdAt: new Date(),
    classSessionId: null,
    classSession: null,
    targetConnectionId: 'conn-1',
    targetConnection: makeConnection(),
  }
  const merged: any = { ...base, ...overrides, reservation }
  // Reservation FK column tracks the relation we just assigned unless caller
  // explicitly overrode it (e.g. for class-only rows).
  if (overrides.reservationId !== undefined) {
    merged.reservationId = overrides.reservationId
  } else {
    merged.reservationId = reservation?.id ?? null
  }
  return merged
}

/** Drives prisma.$transaction(cb) → cb(prisma) and supports array form too. */
function setupTransaction() {
  ;(prisma.$transaction as jest.Mock).mockImplementation((arg: any) => {
    if (typeof arg === 'function') return arg(prisma)
    return Promise.all(arg)
  })
}

/** Make the advisory-lock query return `acquired=true` by default. Tests that
 * want to simulate contention override this. */
function setupAdvisoryLockAcquired(acquired: boolean) {
  ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ acquired }])
}

beforeEach(() => {
  eventsListMock.mockReset()
  eventsInsertMock.mockReset()
  eventsPatchMock.mockReset()
  eventsDeleteMock.mockReset()
  eventsGetMock.mockReset()
  ;(prisma.$queryRaw as jest.Mock).mockReset()
  setupTransaction()
  setupAdvisoryLockAcquired(true)
  // Default safe mocks
  ;(prisma.reservation.findUnique as jest.Mock).mockResolvedValue({ status: 'CONFIRMED', cancelledAt: null })
  ;(prisma.classSession.findUnique as jest.Mock).mockResolvedValue({ status: 'SCHEDULED' })
  ;(prisma.reservationGoogleEventMapping.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.reservationGoogleEventMapping.upsert as jest.Mock).mockResolvedValue({})
  ;(prisma.reservationGoogleEventMapping.update as jest.Mock).mockResolvedValue({})
  ;(prisma.calendarSyncOutbox.update as jest.Mock).mockResolvedValue({})
})

// ============================================================
// CREATE
// ============================================================

describe('processOutboxRow — CREATE', () => {
  it('happy path: source active + no existing event → events.insert + mapping created + SUCCESS', async () => {
    const row = makeOutboxRow()
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    eventsListMock.mockResolvedValue({ data: { items: [] } })
    eventsInsertMock.mockResolvedValue({ data: { id: 'gcal-event-xyz' } })

    await processOutboxRow('outbox-1')

    // IN_PROGRESS write happened
    expect(prisma.calendarSyncOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outbox-1' },
        data: expect.objectContaining({ status: 'IN_PROGRESS', attempts: { increment: 1 } }),
      }),
    )

    // idempotency search by extended property
    expect(eventsListMock).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'cal-1',
        privateExtendedProperty: ['avoqadoReservationId=res-1'],
        showDeleted: false,
      }),
    )

    // insert
    expect(eventsInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'cal-1',
        requestBody: expect.objectContaining({
          extendedProperties: expect.objectContaining({
            private: expect.objectContaining({
              avoqadoOrigin: 'avoqado',
              avoqadoReservationId: 'res-1',
            }),
          }),
        }),
      }),
    )

    // mapping upsert with compound key
    expect(prisma.reservationGoogleEventMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { connectionId_googleEventId: { connectionId: 'conn-1', googleEventId: 'gcal-event-xyz' } },
        create: expect.objectContaining({
          reservationId: 'res-1',
          classSessionId: null,
          connectionId: 'conn-1',
          googleEventId: 'gcal-event-xyz',
          lastStatus: 'PUSHED',
        }),
      }),
    )

    // final SUCCESS state
    const updates = (prisma.calendarSyncOutbox.update as jest.Mock).mock.calls.map(c => c[0].data)
    expect(updates.some(u => u.status === 'SUCCESS')).toBe(true)
  })

  it('idempotency: existing event in calendar → mapping saved, NO duplicate insert', async () => {
    const row = makeOutboxRow()
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    eventsListMock.mockResolvedValue({ data: { items: [{ id: 'gcal-existing' }] } })

    await processOutboxRow('outbox-1')

    expect(eventsInsertMock).not.toHaveBeenCalled()
    expect(prisma.reservationGoogleEventMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { connectionId_googleEventId: { connectionId: 'conn-1', googleEventId: 'gcal-existing' } },
      }),
    )
  })

  it('source cancelled mid-flight → SKIPPED, no Google API calls', async () => {
    const row = makeOutboxRow()
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    ;(prisma.reservation.findUnique as jest.Mock).mockResolvedValue({ status: 'CANCELLED', cancelledAt: new Date() })

    await processOutboxRow('outbox-1')

    expect(eventsListMock).not.toHaveBeenCalled()
    expect(eventsInsertMock).not.toHaveBeenCalled()
    const updates = (prisma.calendarSyncOutbox.update as jest.Mock).mock.calls.map(c => c[0].data)
    expect(updates.some(u => u.status === 'SKIPPED' && u.lastError === 'source_cancelled_before_push')).toBe(true)
  })

  it('source deleted → SKIPPED with source_missing reason', async () => {
    const row = makeOutboxRow()
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    ;(prisma.reservation.findUnique as jest.Mock).mockResolvedValue(null)

    await processOutboxRow('outbox-1')

    expect(eventsInsertMock).not.toHaveBeenCalled()
    const updates = (prisma.calendarSyncOutbox.update as jest.Mock).mock.calls.map(c => c[0].data)
    expect(updates.some(u => u.status === 'SKIPPED' && u.lastError === 'source_missing')).toBe(true)
  })

  it('ClassSession CREATE: builds class body, mapping uses avoqadoClassSessionId tag + classSessionId column', async () => {
    const cs = makeClassSession()
    const row = makeOutboxRow({
      reservation: null,
      reservationId: null,
      classSessionId: cs.id,
      classSession: cs,
      syncKey: `class:${cs.id}:conn-1`,
    })
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    eventsListMock.mockResolvedValue({ data: { items: [] } })
    eventsInsertMock.mockResolvedValue({ data: { id: 'gcal-class-evt' } })

    await processOutboxRow('outbox-1')

    expect(eventsListMock).toHaveBeenCalledWith(expect.objectContaining({ privateExtendedProperty: ['avoqadoClassSessionId=class-1'] }))
    const insertCall = eventsInsertMock.mock.calls[0][0]
    expect(insertCall.requestBody.summary).toContain('Yoga')
    expect(insertCall.requestBody.extendedProperties.private.avoqadoClassSessionId).toBe('class-1')

    expect(prisma.reservationGoogleEventMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          classSessionId: 'class-1',
          reservationId: null,
          googleEventId: 'gcal-class-evt',
        }),
      }),
    )
  })
})

// ============================================================
// UPDATE
// ============================================================

describe('processOutboxRow — UPDATE', () => {
  it('mapping exists → events.patch + mapping.lastStatus=PATCHED', async () => {
    const row = makeOutboxRow({ operation: 'UPDATE' })
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    ;(prisma.reservationGoogleEventMapping.findFirst as jest.Mock).mockResolvedValue({
      connectionId: 'conn-1',
      googleEventId: 'gcal-existing',
    })

    await processOutboxRow('outbox-1')

    expect(eventsPatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'cal-1',
        eventId: 'gcal-existing',
        requestBody: expect.objectContaining({ summary: expect.stringContaining('Reserva:') }),
      }),
    )
    expect(prisma.reservationGoogleEventMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { connectionId_googleEventId: { connectionId: 'conn-1', googleEventId: 'gcal-existing' } },
        data: expect.objectContaining({ lastStatus: 'PATCHED' }),
      }),
    )
    expect(eventsInsertMock).not.toHaveBeenCalled()
  })

  it('mapping missing → promoted to CREATE flow (events.insert called)', async () => {
    const row = makeOutboxRow({ operation: 'UPDATE' })
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    ;(prisma.reservationGoogleEventMapping.findFirst as jest.Mock).mockResolvedValue(null)
    eventsListMock.mockResolvedValue({ data: { items: [] } })
    eventsInsertMock.mockResolvedValue({ data: { id: 'gcal-new' } })

    await processOutboxRow('outbox-1')

    expect(eventsInsertMock).toHaveBeenCalled()
    expect(eventsPatchMock).not.toHaveBeenCalled()
  })
})

// ============================================================
// CANCEL
// ============================================================

describe('processOutboxRow — CANCEL', () => {
  it('mapping exists + removeCancelled=true → events.delete + mapping TOMBSTONED', async () => {
    const row = makeOutboxRow({
      operation: 'CANCEL',
      reservation: makeReservation({
        venue: {
          id: 'venue-1',
          slug: 'amaena',
          reservationSettings: {
            googleCalendarEventDetailLevel: 'FULL',
            googleCalendarRemoveCancelled: true,
          },
        },
      }),
    })
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    ;(prisma.reservationGoogleEventMapping.findFirst as jest.Mock).mockResolvedValue({
      connectionId: 'conn-1',
      googleEventId: 'gcal-existing',
    })

    await processOutboxRow('outbox-1')

    expect(eventsDeleteMock).toHaveBeenCalledWith({ calendarId: 'cal-1', eventId: 'gcal-existing' })
    expect(eventsPatchMock).not.toHaveBeenCalled()
    expect(prisma.reservationGoogleEventMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastStatus: 'TOMBSTONED' }),
      }),
    )
  })

  it('mapping exists + removeCancelled=false → events.patch with [CANCELADA] prefix + status=cancelled', async () => {
    const row = makeOutboxRow({ operation: 'CANCEL' })
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    ;(prisma.reservationGoogleEventMapping.findFirst as jest.Mock).mockResolvedValue({
      connectionId: 'conn-1',
      googleEventId: 'gcal-existing',
    })
    eventsGetMock.mockResolvedValue({ data: { summary: 'Reserva: Corte — Juan Pérez', description: 'old body' } })

    await processOutboxRow('outbox-1')

    expect(eventsDeleteMock).not.toHaveBeenCalled()
    const patchCall = eventsPatchMock.mock.calls[0][0]
    expect(patchCall.calendarId).toBe('cal-1')
    expect(patchCall.eventId).toBe('gcal-existing')
    expect(patchCall.requestBody.status).toBe('cancelled')
    expect(patchCall.requestBody.summary).toMatch(/^\[CANCELADA\] /)
    expect(patchCall.requestBody.description).toContain('Cancelada en Avoqado')

    expect(prisma.reservationGoogleEventMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastStatus: 'TOMBSTONED' }) }),
    )
  })

  it('mapping missing → no-op SUCCESS (already gone), no events.delete or patch', async () => {
    const row = makeOutboxRow({ operation: 'CANCEL' })
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    ;(prisma.reservationGoogleEventMapping.findFirst as jest.Mock).mockResolvedValue(null)

    await processOutboxRow('outbox-1')

    expect(eventsDeleteMock).not.toHaveBeenCalled()
    expect(eventsPatchMock).not.toHaveBeenCalled()
    const updates = (prisma.calendarSyncOutbox.update as jest.Mock).mock.calls.map(c => c[0].data)
    expect(updates.some(u => u.status === 'SUCCESS' && u.lastError === 'no_mapping_to_cancel')).toBe(true)
  })
})

// ============================================================
// UPDATE_ROSTER
// ============================================================

describe('processOutboxRow — UPDATE_ROSTER', () => {
  it('re-fetches class with attendees and patches description (without touching summary/start/end)', async () => {
    const cs = makeClassSession()
    const row = makeOutboxRow({
      operation: 'UPDATE_ROSTER',
      reservation: null,
      reservationId: null,
      classSessionId: cs.id,
      classSession: cs,
      syncKey: `class:${cs.id}:conn-1`,
    })
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    ;(prisma.reservationGoogleEventMapping.findFirst as jest.Mock).mockResolvedValue({
      connectionId: 'conn-1',
      googleEventId: 'gcal-class-evt',
    })
    // Fresh re-fetch returns an updated class
    ;(prisma.classSession.findUnique as jest.Mock).mockResolvedValue({
      ...cs,
      reservations: [
        { id: 'r-a', partySize: 1, status: 'CONFIRMED', cancelledAt: null, customer: { firstName: 'Ana', lastName: 'G' } },
        { id: 'r-b', partySize: 1, status: 'CONFIRMED', cancelledAt: null, customer: { firstName: 'Beto', lastName: 'M' } },
      ],
    })

    await processOutboxRow('outbox-1')

    const patchCall = eventsPatchMock.mock.calls[0][0]
    expect(patchCall.eventId).toBe('gcal-class-evt')
    expect(patchCall.requestBody.description).toContain('Cupo: 2/10')
    expect(patchCall.requestBody.description).toContain('Beto M')
    // Only description should be patched (summary not in requestBody)
    expect(patchCall.requestBody.summary).toBeUndefined()
    expect(patchCall.requestBody.start).toBeUndefined()
    expect(patchCall.requestBody.end).toBeUndefined()
  })

  it('no mapping → no-op success', async () => {
    const cs = makeClassSession()
    const row = makeOutboxRow({
      operation: 'UPDATE_ROSTER',
      reservation: null,
      reservationId: null,
      classSessionId: cs.id,
      classSession: cs,
    })
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    ;(prisma.reservationGoogleEventMapping.findFirst as jest.Mock).mockResolvedValue(null)

    await processOutboxRow('outbox-1')

    expect(eventsPatchMock).not.toHaveBeenCalled()
    const updates = (prisma.calendarSyncOutbox.update as jest.Mock).mock.calls.map(c => c[0].data)
    expect(updates.some(u => u.status === 'SUCCESS' && u.lastError === 'no_mapping_for_roster_update')).toBe(true)
  })
})

// ============================================================
// Retry / backoff / dead letter
// ============================================================

describe('processOutboxRow — retry/backoff', () => {
  it('Google API failure → attempts++ + status=FAILED + scheduledAt pushed back', async () => {
    const row = makeOutboxRow()
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    eventsListMock.mockResolvedValue({ data: { items: [] } })
    eventsInsertMock.mockRejectedValue(new Error('5xx upstream'))

    const before = Date.now()
    await processOutboxRow('outbox-1')

    const finalUpdate = (prisma.calendarSyncOutbox.update as jest.Mock).mock.calls.map(c => c[0].data).find(d => d.status === 'FAILED')
    expect(finalUpdate).toBeDefined()
    expect(finalUpdate.lastError).toContain('5xx upstream')
    expect(finalUpdate.scheduledAt).toBeInstanceOf(Date)
    // backoff for attempt 1 (0.5min) = 30_000 ms
    expect((finalUpdate.scheduledAt as Date).getTime() - before).toBeGreaterThanOrEqual(29_000)
    expect((finalUpdate.scheduledAt as Date).getTime() - before).toBeLessThan(45_000)
  })

  it('7th failure → status=DEAD_LETTER', async () => {
    const row = makeOutboxRow({ attempts: 6 })
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    eventsListMock.mockResolvedValue({ data: { items: [] } })
    eventsInsertMock.mockRejectedValue(new Error('still down'))

    await processOutboxRow('outbox-1')

    const updates = (prisma.calendarSyncOutbox.update as jest.Mock).mock.calls.map(c => c[0].data)
    expect(updates.some(u => u.status === 'DEAD_LETTER')).toBe(true)
  })
})

// ============================================================
// Single-flight
// ============================================================

describe('processOutboxRow — single-flight advisory lock', () => {
  it('returns silently when pg_try_advisory_xact_lock returns false (another worker is processing)', async () => {
    const row = makeOutboxRow()
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    setupAdvisoryLockAcquired(false)

    await processOutboxRow('outbox-1')

    // No status flip to IN_PROGRESS, no Google calls.
    expect(prisma.calendarSyncOutbox.update).not.toHaveBeenCalled()
    expect(eventsListMock).not.toHaveBeenCalled()
    expect(eventsInsertMock).not.toHaveBeenCalled()
  })

  it('non-PENDING and non-FAILED rows are short-circuited (e.g. SUCCESS already)', async () => {
    const row = makeOutboxRow({ status: 'SUCCESS' })
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)

    await processOutboxRow('outbox-1')

    expect(prisma.$queryRaw).not.toHaveBeenCalled()
    expect(prisma.calendarSyncOutbox.update).not.toHaveBeenCalled()
    expect(eventsInsertMock).not.toHaveBeenCalled()
  })

  it('FAILED rows are picked up again (retry path)', async () => {
    const row = makeOutboxRow({ status: 'FAILED', attempts: 1 })
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    eventsListMock.mockResolvedValue({ data: { items: [] } })
    eventsInsertMock.mockResolvedValue({ data: { id: 'gcal-retry' } })

    await processOutboxRow('outbox-1')

    expect(eventsInsertMock).toHaveBeenCalled()
    const updates = (prisma.calendarSyncOutbox.update as jest.Mock).mock.calls.map(c => c[0].data)
    expect(updates.some(u => u.status === 'SUCCESS')).toBe(true)
  })

  it('missing row → silent no-op', async () => {
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(null)

    await processOutboxRow('not-here')

    expect(prisma.calendarSyncOutbox.update).not.toHaveBeenCalled()
    expect(eventsListMock).not.toHaveBeenCalled()
  })
})

// ============================================================
// Smoke: Prisma.sql is used for the lock query (proves prepared-statement safety)
// ============================================================

describe('processOutboxRow — implementation smoke', () => {
  it('uses Prisma.sql template for the advisory-lock query (NOT a raw string)', async () => {
    const row = makeOutboxRow()
    ;(prisma.calendarSyncOutbox.findUnique as jest.Mock).mockResolvedValue(row)
    eventsListMock.mockResolvedValue({ data: { items: [] } })
    eventsInsertMock.mockResolvedValue({ data: { id: 'gcal-1' } })

    await processOutboxRow('outbox-1')

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    const arg = (prisma.$queryRaw as jest.Mock).mock.calls[0][0]
    // Prisma.sql produces a Sql template object. Quick structural check that
    // we're NOT passing a plain string (which would be a SQL-injection footgun).
    expect(typeof arg).not.toBe('string')
    expect(arg).toBeDefined()
    // Sanity: prove the binding mechanism is in play.
    const referenceSql = Prisma.sql`SELECT 1`
    expect(arg.constructor).toBe(referenceSql.constructor)
  })
})
