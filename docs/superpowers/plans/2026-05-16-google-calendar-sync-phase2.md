# Google Calendar Sync — Phase 2 Implementation Plan (Push direction)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-05-15-google-calendar-sync-design.md` (v1.6) — §6 (data model), §8.2 (push), §10 (push targets), §13
(privacy), §14 (ClassSession), §15 (resilience)

**Phase 1 status:** ✅ shipped + deployed. Tu connection ya tiene 91 events sincronizados pull-side. Phase 2 agrega push: cuando
creas/actualizas/cancelas una reservación en Avoqado, se refleja en el Google Calendar conectado.

**User decision lock-ins:**

- Detail level default = **FULL** (cliente, servicio, party size visible en el evento de Google). Per-venue puede override a SERIALIZED o
  MINIMAL después.
- Mantener todos los modelos en mismo archivo Prisma como Phase 1.

**Goal:** Pushear reservations a Google Calendar end-to-end con outbox transaccional, idempotencia, ordering serializado por key, y collapse
de CANCEL que supersede CREATE/UPDATE pendientes.

**Architecture:**

```
Reservation.create/update/cancel
    ↓ (inside the same SERIALIZABLE txn as the DB write)
INSERT CalendarSyncOutbox { syncKey, operation, sourceId, targetConnectionId }
    ↓
RabbitMQ publish gcal.push (best-effort, .catch)
    ↓
gcal-push-consumer
    ↓ (also driven by gcal-outbox-sweeper every 30s as fallback)
GoogleCalendarPushService
    ├── pg_try_advisory_xact_lock(hashtext('gcal-push:' + syncKey))
    ├── CANCEL pre-flight: mark earlier PENDING CREATE/UPDATE as SKIPPED
    ├── Re-read source row state (skip if CANCELLED for non-CANCEL ops)
    ├── Idempotency search: events.list({ privateExtendedProperty: 'avoqadoReservationId=X' })
    ├── Google API: events.insert / events.patch / events.delete-or-patch-cancelled
    └── INSERT/UPDATE ReservationGoogleEventMapping
```

---

## Schema (Subagent 1)

### `CalendarSyncOutbox` (new model)

```prisma
enum CalendarSyncOperation { CREATE UPDATE CANCEL UPDATE_ROSTER }
enum CalendarSyncStatus    { PENDING IN_PROGRESS SUCCESS FAILED DEAD_LETTER SKIPPED }

model CalendarSyncOutbox {
  id                  String                @id @default(cuid())
  venueId             String
  venue               Venue                 @relation(fields: [venueId], references: [id], onDelete: Cascade)
  reservationId       String?
  reservation         Reservation?          @relation(fields: [reservationId], references: [id], onDelete: Cascade)
  classSessionId      String?
  classSession        ClassSession?         @relation(fields: [classSessionId], references: [id], onDelete: Cascade)
  operation           CalendarSyncOperation
  targetConnectionId  String
  targetConnection    GoogleCalendarConnection @relation(fields: [targetConnectionId], references: [id], onDelete: Cascade)
  syncKey             String                // "reservation:<id>:<connId>" or "class:<id>:<connId>"
  idempotencyKey      String                @unique
  status              CalendarSyncStatus    @default(PENDING)
  attempts            Int                   @default(0)
  scheduledAt         DateTime              @default(now())
  processedAt         DateTime?
  lastError           String?               @db.Text
  debounceUntil       DateTime?
  createdAt           DateTime              @default(now())

  @@index([status, scheduledAt])
  @@index([venueId, status])
  @@index([syncKey, status, createdAt])  // collapse query
  @@index([reservationId])
  @@index([classSessionId])
}
```

### `ReservationGoogleEventMapping` (new model)

```prisma
model ReservationGoogleEventMapping {
  reservationId    String?
  reservation      Reservation?              @relation(fields: [reservationId], references: [id], onDelete: SetNull)
  classSessionId   String?
  classSession     ClassSession?             @relation(fields: [classSessionId], references: [id], onDelete: SetNull)
  connectionId     String
  connection       GoogleCalendarConnection  @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  googleEventId    String
  lastPushedAt     DateTime
  lastStatus       String                    // "PUSHED" | "PATCHED" | "TOMBSTONED" | "FAILED"
  createdAt        DateTime                  @default(now())
  updatedAt        DateTime                  @updatedAt

  @@id([connectionId, googleEventId])  // googleEventId unique within a calendar
  @@index([reservationId])
  @@index([classSessionId])
}
```

### Migration raw SQL (partial uniques per spec §6.1):

```sql
CREATE UNIQUE INDEX rgem_reservation_conn
  ON "ReservationGoogleEventMapping"("reservationId", "connectionId")
  WHERE "reservationId" IS NOT NULL;
CREATE UNIQUE INDEX rgem_classsession_conn
  ON "ReservationGoogleEventMapping"("classSessionId", "connectionId")
  WHERE "classSessionId" IS NOT NULL;
```

### `ReservationSettings` columns added

```prisma
// Push toggle (independent of module enablement)
googleCalendarPushEnabled              Boolean @default(true)
googleCalendarDualWrite                Boolean @default(false)
// FULL is the locked-in default per user decision (2026-05-16)
googleCalendarEventDetailLevel         String  @default("FULL")
googleCalendarRemoveCancelled          Boolean @default(false)
googleCalendarClassRosterInDescription Boolean @default(true)
```

### Relations added to existing models

```prisma
// inside Venue        { ... }
calendarSyncOutbox    CalendarSyncOutbox[]

// inside Reservation  { ... }
calendarSyncOutbox    CalendarSyncOutbox[]
googleEventMappings   ReservationGoogleEventMapping[]

// inside ClassSession { ... }
calendarSyncOutbox    CalendarSyncOutbox[]
googleEventMappings   ReservationGoogleEventMapping[]

// inside GoogleCalendarConnection { ... }
outboxRows            CalendarSyncOutbox[]
eventMappings         ReservationGoogleEventMapping[]
```

---

## Section A — Schema + Foundation (Subagent 1)

**Tasks:**

1. Add the 2 new models + 5 ReservationSettings columns + relations to `prisma/schema.prisma`.
2. `npx prisma migrate dev --name gcal_phase2 --create-only`.
3. Append raw SQL for partial unique indexes.
4. `npx prisma migrate dev`.
5. **Run migration against prod DB too** via Prisma migrate deploy. (Or document for user to run.)
6. Add `[CalendarSyncOperation, CalendarSyncStatus]` to `tests/__helpers__/setup.ts` prisma mock + add `calendarSyncOutbox` and
   `reservationGoogleEventMapping` model mocks.

**Definition of done:** Schema migrates clean on local + prod. Build succeeds. Existing tests still pass.

---

## Section B — Event body builder + Push service (Subagent 2)

**Files:**

- New: `src/services/google-calendar/event-body.service.ts`
- New: `src/services/google-calendar/push.service.ts`
- Tests for both

### `event-body.service.ts`

```typescript
export interface EventBodyArgs {
  reservation: Reservation  // with includes for customer, products, etc.
  detailLevel: 'MINIMAL' | 'SERVICE' | 'FULL'
  dashboardUrl: string       // e.g., 'https://dashboardv2.avoqado.io'
  venueSlug: string
}

export function buildEventBodyForReservation(args): calendar_v3.Schema$Event {
  const summary =
    args.detailLevel === 'MINIMAL' ? 'Reserva Avoqado' :
    args.detailLevel === 'SERVICE' ? `Reserva: ${productName}` :
    /* FULL */ `Reserva: ${productName} — ${guestName}`

  const description = buildDescription(args)  // varies by detail level

  return {
    summary,
    description,
    start: { dateTime: args.reservation.startsAt.toISOString() },
    end:   { dateTime: args.reservation.endsAt.toISOString() },
    extendedProperties: {
      private: {
        avoqadoOrigin: 'avoqado',
        avoqadoReservationId: args.reservation.id,
        avoqadoVenueId: args.reservation.venueId,
      },
    },
    transparency: 'opaque',
  }
}

export function buildEventBodyForClassSession(args): calendar_v3.Schema$Event { ... }
```

Tests for MINIMAL, SERVICE, FULL.

### `push.service.ts`

```typescript
export async function processOutboxRow(rowId: string): Promise<void> {
  const row = await prisma.calendarSyncOutbox.findUnique({
    where: { id: rowId },
    include: { reservation: { include: customerProductRelations }, classSession: ..., targetConnection: true },
  })
  if (!row || row.status !== 'PENDING') return

  // Single-flight per syncKey using pg advisory lock
  await prisma.$transaction(async tx => {
    const lockAcquired = await tx.$queryRaw<[{ pg_try_advisory_xact_lock: boolean }]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${`gcal-push:${row.syncKey}`}::text))
    `
    if (!lockAcquired[0].pg_try_advisory_xact_lock) return  // another worker has it

    // Mark IN_PROGRESS
    await tx.calendarSyncOutbox.update({
      where: { id: row.id },
      data: { status: 'IN_PROGRESS', attempts: { increment: 1 } },
    })

    try {
      if (row.operation === 'CREATE') await handleCreate(tx, row)
      else if (row.operation === 'UPDATE') await handleUpdate(tx, row)
      else if (row.operation === 'CANCEL') await handleCancel(tx, row)
      else if (row.operation === 'UPDATE_ROSTER') await handleUpdateRoster(tx, row)

      await tx.calendarSyncOutbox.update({
        where: { id: row.id },
        data: { status: 'SUCCESS', processedAt: new Date() },
      })
    } catch (err) {
      // Retry up to 7 times with exponential backoff; then DEAD_LETTER
      ...
    }
  }, { timeout: 60_000 })
}

async function handleCreate(tx, row) {
  // 1. Re-read source row state — if cancelled, mark SKIPPED
  if (row.reservationId) {
    const r = await tx.reservation.findUnique({ where: { id: row.reservationId } })
    if (!r || r.status === 'CANCELLED') {
      await tx.calendarSyncOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'source_cancelled' } })
      return
    }
  }

  // 2. Idempotency: search Google by privateExtendedProperty
  const auth = ... // build OAuth client with decrypted tokens from row.targetConnection
  const calendar = google.calendar({ version: 'v3', auth })
  const existing = await calendar.events.list({
    calendarId: row.targetConnection.selectedCalendarId,
    privateExtendedProperty: [`avoqadoReservationId=${row.reservationId}`],
  })
  if (existing.data.items?.length) {
    // Already exists — save mapping and exit
    await tx.reservationGoogleEventMapping.upsert(...)
    return
  }

  // 3. Build body + insert
  const venueSettings = ... // fetch ReservationSettings
  const body = buildEventBodyForReservation({ reservation: r, detailLevel: venueSettings.googleCalendarEventDetailLevel, ... })
  const created = await calendar.events.insert({ calendarId: ..., requestBody: body })

  // 4. Save mapping
  await tx.reservationGoogleEventMapping.upsert(...)
}

async function handleUpdate(tx, row) {
  // 1. Re-read source state
  // 2. Find existing mapping
  // 3. If no mapping → promote to CREATE
  // 4. events.patch with updated body
}

async function handleCancel(tx, row) {
  // 1. Find existing mapping (no need to re-read source — cancel is terminal)
  // 2. If no mapping → no-op (event was never created)
  // 3. If ReservationSettings.googleCalendarRemoveCancelled → events.delete; else events.patch with status=cancelled
  // 4. Mark mapping as TOMBSTONED
}

async function handleUpdateRoster(tx, row) {
  // ClassSession-only — debounced update of attendee list in event description
}
```

Tests:

- CREATE happy path (idempotency search returns empty → insert)
- CREATE retry after extendedProperty match (saves mapping, no duplicate insert)
- UPDATE with existing mapping (events.patch)
- UPDATE with missing mapping (promotes to CREATE)
- CANCEL with mapping + removeCancelled=true (events.delete)
- CANCEL with mapping + removeCancelled=false (events.patch status=cancelled)
- CANCEL with no mapping (no-op)
- Source row CANCELLED mid-flight for CREATE op → SKIPPED
- Detail level FULL/SERVICE/MINIMAL bodies
- Single-flight lock prevents concurrent push for same syncKey

---

## Section C — Outbox enqueue helpers + Worker (Subagent 3)

**Files:**

- New: `src/services/google-calendar/outbox.service.ts`
- New: `src/communication/rabbitmq/gcal-push-consumer.ts`
- New: `src/jobs/gcal-outbox-sweeper.job.ts`
- Register in `src/server.ts`

### `outbox.service.ts`

```typescript
/**
 * Enqueue a Calendar push operation. MUST be called inside the same DB
 * transaction as the source row mutation (atomicity).
 */
export async function enqueuePushForReservation(
  tx: Prisma.TransactionClient,
  args: { reservation: Reservation; operation: 'CREATE' | 'UPDATE' | 'CANCEL'; targetConnectionIds: string[] },
): Promise<void>

export async function enqueuePushForClassSession(
  tx: Prisma.TransactionClient,
  args: { classSession: ClassSession; operation: 'CREATE' | 'CANCEL' | 'UPDATE_ROSTER'; targetConnectionIds: string[] },
): Promise<void>

/**
 * CANCEL pre-flight: when emitting a CANCEL outbox row, also mark any earlier
 * PENDING CREATE/UPDATE rows for the same syncKey as SKIPPED. Single UPDATE
 * query indexed on (syncKey, status, createdAt). Prevents ghost events.
 */
export async function collapseSupersededOps(tx: Prisma.TransactionClient, syncKey: string, newRowCreatedAt: Date): Promise<number>
```

### `resolvePushTargets` helper

Per spec §10:

```typescript
async function resolvePushTargets(reservation: Reservation): Promise<GoogleCalendarConnection[]> {
  const settings = await prisma.reservationSettings.findUnique({ where: { venueId: reservation.venueId } })
  if (!settings.googleCalendarPushEnabled) return []

  const staffConn = reservation.assignedStaffId
    ? await prisma.googleCalendarConnection.findFirst({
        where: { staffId: reservation.assignedStaffId, scope: 'STAFF_PERSONAL', status: 'CONNECTED' },
      })
    : null
  const venueConn = await prisma.googleCalendarConnection.findFirst({
    where: { venueId: reservation.venueId, scope: 'VENUE', status: 'CONNECTED' },
  })

  if (settings.googleCalendarDualWrite && venueConn) {
    const targets = []
    if (staffConn) targets.push(staffConn)
    targets.push(venueConn)
    return targets
  }
  // Single-target mode (default): prefer staff personal
  if (staffConn) return [staffConn]
  if (venueConn) return [venueConn]
  return []
}
```

### Outbox sweeper job

```typescript
// src/jobs/gcal-outbox-sweeper.job.ts — every 30s
// SELECT id FROM CalendarSyncOutbox WHERE status = 'PENDING' AND scheduledAt <= NOW()
//   ORDER BY scheduledAt ASC LIMIT 100
// For each: processOutboxRow(id) (best-effort, single-flight)
```

### RabbitMQ consumer

```typescript
// src/communication/rabbitmq/gcal-push-consumer.ts
// Same pattern as gcal-pull-consumer.ts
// Routing key 'gcal.push', queue 'gcal_push_queue'
// On message: { outboxRowId } → processOutboxRow(outboxRowId)
```

Tests:

- Sweeper picks up PENDING rows
- Outbox row IN_PROGRESS NOT picked up by parallel worker (single-flight lock test)
- Failed rows retry with exponential backoff
- After 7 failures → DEAD_LETTER
- collapseSupersededOps marks earlier rows SKIPPED with correct WHERE clause

---

## Section D — Hooks integration (Subagent 4)

**Files modified:**

- `src/services/dashboard/reservation.dashboard.service.ts` — emit outbox rows in createReservation, updateReservation, cancelReservation
- `src/controllers/public/reservation.public.controller.ts` — emit outbox rows in public create + cancel flows
- `src/services/dashboard/classSession.dashboard.service.ts` — emit outbox rows in createClassSession, cancelClassSession, reschedule

Pattern (per spec):

```typescript
// inside the same prisma.$transaction as the source row mutation:
const reservation = await tx.reservation.create({ ... })

const targets = await resolvePushTargets(tx, reservation)
if (targets.length > 0) {
  await enqueuePushForReservation(tx, {
    reservation,
    operation: 'CREATE',
    targetConnectionIds: targets.map(t => t.id),
  })
}

// best-effort RMQ enqueue post-commit (sweeper picks up if RMQ down):
// outside transaction, after txn returns:
void publishPushNotification(outboxRowIds).catch(...)
```

For ClassSession roster updates (when an attendee adds/cancels): emit `UPDATE_ROSTER` outbox row with `debounceUntil = NOW + 30s`. The
sweeper / worker checks `debounceUntil` before processing and skips rows whose debounce hasn't expired. When picking up, collapse all
pending UPDATE_ROSTER rows for the same syncKey into one.

Integration tests:

- Create reservation → assert outbox row inserted in same txn
- Reservation create with no connected calendars → no outbox row
- Reservation cancel → CANCEL row inserted, earlier PENDING CREATE collapsed to SKIPPED
- Public flow same shape
- ClassSession cancel → CANCEL row for class itself, NOT per attendee
- Reschedule = atomic CANCEL of old slot + CREATE of new slot, OR UPDATE if just time change

---

## Production checklist (after deploy)

- [ ] Migration deployed via `prisma migrate deploy`
- [ ] `gcal-push-consumer` boots without error
- [ ] `gcal-outbox-sweeper` registered + started
- [ ] Manual smoke test: create a reservation in dashboardv2, verify event appears in Google Calendar within ~5 seconds
- [ ] Smoke test: cancel that reservation, verify Google event gets `[CANCELADA]` prefix or deleted (per setting)
- [ ] Smoke test: update reservation time, verify Google event time updates
- [ ] Verify no PII leaks in calendar widget on phone screenshot (FULL mode is intentional per user decision)

## Out of scope (Phase 3)

- Visual rendering of `ExternalBusyBlock` rows in the dashboard reservation calendar
- Connection-status dashboard with reconnect CTA for `TOKEN_REVOKED`/`CALENDAR_LOST`
- Dead-letter outbox banner UI
- Privacy preview UI showing what FULL/SERVICE/MINIMAL events look like before opt-in

---

**Execution: 4 subagents sequentially.** Subagent 1 (schema) blocks all others. 2-3-4 can also go sequentially since they each modify shared
files (server.ts, etc.).
