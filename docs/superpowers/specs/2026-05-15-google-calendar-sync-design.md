# Google Calendar Bidirectional Sync — Design Spec

**Status:** APPROVED v1.6 — backend Phase 1 implemented and tested (210 tests pass, 46 Stripe regression intact, uncommitted in working tree). Dashboard UI pending its own plan.
**Author:** Jose Antonio Amieva (with Claude Code)
**Date:** 2026-05-15
**Repos affected (verified by post-implementation cross-repo audit):**
- `avoqado-server` — full backend (this spec)
- `avoqado-web-dashboard` — UI for the 6 new endpoints (REQUIRED for Phase 1 to be user-visible — separate plan)
- `avoqado-android` — cosmetic 409 error mapping (OPTIONAL polish, see §20)
**Out of scope (confirmed by audit):** `avoqado-tpv`, `avoqado-checkout`, `avoqado-booking-widget`

---

## Changelog

**v1.6 (2026-05-15) — post-implementation cross-repo audit:**

- ✅ **`avoqado-android` flagged for cosmetic-only polish:** post-implementation audit revealed `avoqado-android` (separate repo from `avoqado-tpv`) has a full reservations module that calls `POST /dashboard/venues/{v}/reservations`. When backend rejects with 409 `external_calendar_busy`, the Android app currently shows raw JSON. Fix is ~5 lines in `ReservationApi.kt:110-113`. NOT blocking Phase 1. (§20)
- ✅ **`avoqado-web-dashboard` UI marked as REQUIRED for Phase 1 user-visibility:** without dashboard UI the 6 endpoints can only be called via Postman/curl. Backend ships first, soaks, then dashboard merges. (§20)
- ✅ **`avoqado-tpv` confirmed zero-touch:** audit verified TPV has 48 endpoints, none for reservations/availability. Spec was correct. (§20)

**v1.5 (2026-05-15) — final approval notes:**

- ✅ **`encryptedRefreshToken` is NOT NULL on `GoogleOAuthSession`:** if Google omits `refresh_token`, the callback retries with
  `prompt=consent` (§7.2.1) BEFORE creating any session row. A session that exists is guaranteed to carry a refresh token. Removed the
  nullable annotation and the "null only on re-consent retry path" comment that contradicted §7.2.1. (§7.3.3)
- ✅ **`consumedAt` commit ordering specified:** the session is consumed inside the SAME transaction that creates `GoogleCalendarConnection`
  and its first `GoogleCalendarChannel`. Backfill happens AFTER the transaction commits (async — fire-and-forget into the pull worker via
  inbox or direct enqueue). A failed backfill leaves a CONNECTED row with `syncToken=null` that the pull worker re-attempts; it never leaves
  a consumed session without a usable connection. (§7.3.4)

**v1.4 (2026-05-15) — fifth-opinion audit fixes:**

- ✅ **OIDC scopes added (`openid email`):** `googleAccountEmail` and `googleAccountSub` on `GoogleCalendarConnection` and
  `GoogleOAuthSession` cannot be trusted without OIDC. Added `openid` + `email` to the authorization URL; the callback now verifies the
  `id_token` returned by Google alongside the access/refresh tokens. Without this, `email` and `sub` were unsigned, attacker-controllable
  strings. (§7.1, §7.2.1, §7.3.2)
- ✅ **Webhook route mount order pinned:** Stripe webhook at `/api/v1/webhooks` already uses `express.raw({ type: 'application/json' })`.
  Google's webhook must mount BEFORE that route, on its own path `/api/v1/webhooks/google-calendar`, with
  `express.raw({ type: '*/*', limit: '64kb' })`. Order matters — mounting after the existing raw parser swallows requests. Documented exact
  `app.ts` ordering. (§9.1)

**v1.3 (2026-05-15) — fourth-opinion audit fixes:**

- ✅ **OAuth §7.3 cleaned up — no `authContext` at callback time:** the GET callback comes from Google as a top-level browser redirect; the
  dashboard's API auth context is not guaranteed there. The callback now validates state JWT signature + nonce ONLY. The
  `session.authUserId === req.authContext.userId` check moves to the SUBSEQUENT authenticated endpoints (`GET /oauth/calendars`,
  `POST /connections`). (§7.3)
- ✅ **`GoogleOAuthSession` schema defined:** new Prisma model storing tokenHash (sha256 of opaque session token returned to client),
  encrypted refresh/access tokens, authUserId, venueId/staffId, intent, TTL 10min, one-time-use via `consumedAt`. (§6.1)
- ✅ **`syncKey` added to all outbox examples:** ClassSession create example (§14.1) and any other outbox snippet now include the required
  field.
- ✅ **`lastHorizonEnd` set during backfill, not only horizon-refresh:** initial backfill at connect AND 410 GONE recovery both stamp
  `lastHorizonEnd = NOW + maxAdvanceDays`. Eliminates ambiguous state after a fresh connect. (§7.4 step 6, §8.1 410 recovery)
- ✅ **Incremental sync filters to booking horizon:** events outside `[NOW - 7d, NOW + maxAdvanceDays]` are skipped (or, if they used to be
  inside and moved out, their `ExternalBusyBlock` is deleted). Prevents the table from growing unboundedly when staff has years of Google
  events. Horizon refresh re-captures events as they enter the window. (§8.1)

**v1.2 (2026-05-15) — third-opinion audit fixes:**

- ✅ **`events.watch` API correctly specified:** request takes `params.ttl` (seconds, string); the response returns `expiration` (epoch ms).
  The spec previously sent `expiration` in the request, which Google ignores — channels would default to ~1 week then surprise us. (§7.4
  step 6)
- ✅ **Horizon refresh cron added:** initial backfill covers `NOW → NOW+maxAdvanceDays`. As time passes, the window shifts and events newly
  inside the horizon don't necessarily fire webhooks. New daily `gcal-horizon-refresh.job` does a bounded re-sync without invalidating
  `syncToken`. (§5 cron list, §8.1, §15.1)
- ✅ **OAuth callback corrected to GET:** Google redirects with `GET /api/v1/google-calendar/oauth/callback?code=X&state=Y` query params,
  not POST. The picker-confirmation step that DOES use POST is now clearly the second step (after user picks a calendar). (§7.2)
- ✅ **Refresh token guaranteed:** added `access_type=offline` and conditional `prompt=consent` to the OAuth init URL. If the callback
  returns NO refresh_token (re-consent edge case), retry with forced consent. (§7.3)
- ✅ **Calendar accessRole validated at picker time:** for STAFF_PERSONAL connections (which push events back), the selected calendar MUST
  have `accessRole ∈ {owner, writer}`. Reader-only calendars are rejected. For VENUE connections with push disabled, reader is acceptable.
  (§7.4 step 3)
- ✅ **Explicit `syncKey` column added to outbox:** replaces `idempotencyKey LIKE '...'` pattern for collapsing/queue-coalescing. Indexed
  `(syncKey, status, createdAt)`. Format `reservation:<id>:<connId>` / `class:<id>:<connId>`. (§6.1, §8.2)
- ✅ **Declined invitations don't block:** if Google event includes `attendees[].self === true` AND `responseStatus === 'declined'`, treat
  as not-busy (skip / delete `ExternalBusyBlock`). Same semantics as `transparency: 'transparent'`. (§8.1)
- ✅ **Outbox test cases expanded:** CREATE→UPDATE→CANCEL, CANCEL-before-CREATE-arrival, "CREATE row enqueued, source row cancelled
  mid-flight, CREATE processed after cancellation". (§16.2)
- ✅ **Integration-point language clarified:** check must live wherever the reservation INSERT/UPDATE actually commits — i.e., inside the
  same transaction. Spec now names the service-layer transaction sites and notes the controller line numbers as caller context only. (§11.2)

**v1.1 (2026-05-15) — second-opinion audit fixes:**

- ✅ **OAuth scope fixed:** `calendar.events` alone does NOT permit `calendarList.list`. Added `calendar.calendarlist.readonly`. (§7.1)
- ✅ **Outbox ordering bug fixed:** CREATE→CANCEL out-of-order processing could create a ghost Google event for a cancelled reservation.
  Worker now serializes per `(reservationId|classSessionId, connectionId)` via advisory lock AND re-reads source row state before pushing.
  CANCEL rows supersede earlier PENDING CREATE/UPDATE for the same key. (§8.2)
- ✅ **`hasBlockingConflict` is additive, not replacement:** existing conflict logic in `reservation.dashboard.service.ts:252,821` and
  `reservation.public.controller.ts:551,1616` handles table/staff/capacity nuances we don't want to flatten. The new helper is a
  single-purpose `checkExternalBusyBlock(tx, args)` that's CALLED ALONGSIDE existing checks, not in place of them. (§11.1)
- ✅ **Update path added:** `updateReservation` at `reservation.dashboard.service.ts:821` is a fourth integration point — a reschedule that
  lands on a Google event must also reject. (§11.2)
- ✅ **DB CHECK constraint added:** partial unique indexes don't enforce "exactly one of venueId/staffId" — added explicit CHECK. Also added
  partial unique on `ReservationGoogleEventMapping` for `(reservationId|classSessionId, connectionId)`. (§6.1 migration notes)
- ✅ **All-day timezone correctness:** added `selectedCalendarTimeZone` to `GoogleCalendarConnection` (fetched at connect time). All-day
  events use the calendar's own timezone, not a hardcoded fallback. v1 documents single-timezone-per-calendar as a known limitation. (§6.1,
  §8.1)
- ✅ **syncToken contract documented precisely:** backfill phase and incremental phase have different parameter shapes. Spec now spells out
  both phases explicitly to prevent Google API 400s from parameter combinations Google rejects. (§8.1)

**v1.0 (2026-05-15):** Initial spec. Incorporates Codex consult-review findings (28 issues). Key corrections vs the brainstorming draft:

- Write-path conflict checks added to ALL reservation creation paths (dashboard, public widget, slot holds) — not only the availability read
  path.
- `GoogleCalendarConnection` redesigned for multi-venue staff: `scope` enum (`VENUE` vs `STAFF_PERSONAL`); staff-personal connections are
  global (one per staff across all venues).
- Webhook durability: DB inbox row written BEFORE returning 200 to Google. RabbitMQ is best-effort with sweeper fallback.
- Push moved off the reservation-creation hot path: transactional outbox pattern (`CalendarSyncOutbox`).
- Single push target by default (staff-personal preferred, venue fallback). Dual-write is opt-in setting.
- Cancellation via `events.patch` with `status=cancelled`, not `events.delete`. Configurable.
- Privacy default: MINIMAL summary, no PII. Detail level is per-venue opt-in.
- ClassSession push: one event per class, roster updates are debounced patches.
- Direction policy explicit: Google → Avoqado does NOT mutate Reservation. Avoqado overwrites Google on next update.
- Watch channels modeled as their own table (overlap during renewal).
- Recurring events expanded via `singleEvents=true`; cancelled events tombstoned; all-day events use venue timezone.
- Free module (`GOOGLE_CALENDAR_SYNC`) enforced at every worker boundary, not only UI.

---

## 1. Problem

Avoqado venues that run appointment-based businesses (salons, spas, fitness studios, medical offices, classes) need their reservation
availability to reflect the real schedule of the staff member or venue. Today, a stylist's "doctor appointment at 3pm Tuesday" is invisible
to Avoqado, so `book.avoqado.io` will happily let a customer book that slot, creating a double-booking the venue discovers only when the
customer arrives.

Conversely, staff want their Avoqado reservations to appear in the personal calendar app on their phone (Google Calendar, the default on
Android and widely used on iOS) so they see their day at a glance without opening the Avoqado dashboard.

This is table-stakes for competing with Calendly, Cal.com, Square Appointments, Booksy, and Vagaro in the appointment-scheduling space.

## 2. Goals

1. **No double-bookings against external calendar events.** When a customer attempts to book a slot on `book.avoqado.io` (or staff creates
   one in dashboard) for a time when the assigned staff has a personal Google Calendar event, the system rejects the slot — both at
   availability-display time and at write-commit time.
2. **Reservations visible on staff phones via Google Calendar.** Reservations assigned to staff Juan appear in Juan's personal Google
   Calendar (if he connected one) within seconds of creation.
3. **Optional venue-wide master calendar.** OWNER/ADMIN can connect one Google Calendar to the venue. That calendar's events block
   availability venue-wide (e.g., "venue closed for plumbing repair") and receives copies of all reservations (opt-in).
4. **Multi-venue staff support.** A stylist working at Venue A and Venue B connects their personal Google Calendar ONCE; their personal
   events block their availability at both venues.
5. **Privacy by default.** Customer PII does NOT land in personal Google Calendars unless the venue explicitly opts in.
6. **Resilient to component failure.** Loss of RabbitMQ, Redis, Google Calendar API, or our own worker process must not cause the system to
   silently drift out of sync.

## 3. Non-goals (explicit)

- **Outlook, iCloud, Office 365 sync.** Designed to be extensible (`ExternalBusyBlock` is calendar-source-agnostic), but only Google is
  implemented in v1.
- **Free/busy-only sync (no event detail at all).** Google's freebusy API would be lighter, but we want to push reservation details back to
  Google, so we use the full events API.
- **Two-way semantic sync of Avoqado-pushed events.** If a stylist drags a reservation event in Google Calendar to a new time, that does NOT
  reschedule the Avoqado reservation. The next Avoqado-side update overwrites it. (Documented in UI; see §10.)
- **Per-event ACL.** All synced events use the same ACL the user has on the selected calendar.
- **Sharing calendars to customers.** Customers see availability via `book.avoqado.io`, not a Google Calendar.
- **Real-time push without webhooks.** No polling fallback. If Google's push notification system is down, we degrade to stale-availability
  and surface a warning, not silently poll.

## 4. User stories

**S1 — Stylist connects personal calendar.** Juan (CASHIER role at "Salón Pavón") opens dashboard → Mi perfil → Calendarios → "Conectar
Google Calendar". OAuth flow. After consent, Juan picks "Personal" from his Google calendar list. From that moment, Juan's personal events
block his availability at every venue he works at, and new reservations assigned to him appear in his Google Calendar (with default MINIMAL
detail level).

**S2 — Venue owner connects master calendar.** María (OWNER at "Salón Pavón") opens dashboard → Configuración → Calendarios → "Conectar
calendario del venue". OAuth flow. She picks "Salón Pavón — Operativo" from her calendars. From that moment, events in that calendar block
availability venue-wide. Reservations are NOT pushed there by default (it's read-only-blocker by default).

**S3 — Multi-venue stylist.** Juan works at "Salón Pavón" AND "Salón Reforma". He connects his personal Google Calendar from Salón Pavón.
Salón Reforma's dashboard also shows his connection as active. His "doctor at 3pm Tuesday" event blocks availability at BOTH venues.

**S4 — Customer attempts to book a busy slot.** Customer opens `book.avoqado.io/salon-pavon`, picks Juan, requests Tuesday 3pm. Avoqado
returns "unavailable" because Juan's personal Google event covers that time.

**S5 — Race: customer books just as staff adds Google event.** Customer is on `book.avoqado.io` checkout. Staff opens their phone and adds
"client meeting" at the same time the customer hits "Confirmar". The reservation creation transaction reads `ExternalBusyBlock` inside the
same advisory-lock window; if the Google event has already been synced, the reservation is rejected with a friendly "slot just became
unavailable" message. If the Google event has NOT yet been synced (sub-second race), the reservation succeeds, and the staff sees the
conflict in their dashboard — this is the residual race window we accept (see §11).

**S6 — Staff revokes Avoqado's Google access.** Juan opens Google Account Settings and removes Avoqado. Next pull attempt returns
`invalid_grant`. We mark his `GoogleCalendarConnection.status = TOKEN_REVOKED`, drop all his `ExternalBusyBlock` rows, and send him an
in-app + email notification: "Tu calendario de Google se desconectó. Tu disponibilidad puede no reflejar eventos personales."

## 5. Architecture overview

```
                           ┌──────────────────────┐
                           │ Google Calendar API  │
                           └──┬─────────────────▲─┘
                              │                 │
                events.watch  │                 │ events.insert/patch
                ──────────────┘                 │ (via Outbox worker)
                              ▼                 │
┌──────────────────────────────────────┐        │
│ POST /api/v1/webhooks/google-calendar│        │
│  1. Validate headers (constant-time) │        │
│  2. INSERT GoogleCalendarWebhookInbox│        │
│  3. Best-effort enqueue to RabbitMQ  │        │
│  4. Return 200                       │        │
└──────────────┬───────────────────────┘        │
               │                                │
               ▼                                │
        ┌──────────────┐ ←── sweeper job (30s)  │
        │  RabbitMQ    │     picks orphans      │
        │  gcal.pull   │     from Inbox         │
        └──────┬───────┘                        │
               │                                │
               ▼                                │
┌──────────────────────────────────────┐        │
│ GoogleCalendarPullWorker             │        │
│  - Single-flight per connectionId    │        │
│  - events.list incremental w/ token  │        │
│  - Upsert/tombstone ExternalBusyBlock│        │
│  - Handle 401 → refresh / mark REVOKED│       │
│  - Handle 410 → full re-sync         │        │
└──────────────┬───────────────────────┘        │
               │                                │
               ▼                                │
┌────────────────────────────────────────────┐  │
│ ExternalBusyBlock (Postgres)               │  │
│  Single source for "external busy time"    │  │
│  Read by availability + write-path conflict│  │
│  checks. Future Outlook sync writes here.  │  │
└──────────────┬─────────────────────────────┘  │
               │                                │
               ▼                                │
┌────────────────────────────────────────────┐  │
│ checkExternalBusyBlock(tx, args):          │  │
│   ExternalBusyBlock | null                 │──┘ Additive — called ALONGSIDE
│                                            │    existing reservation/staff/
│                                            │    table/capacity checks at:
│  - reservation.dashboard.service.ts:252    │    (createReservation)
│  - reservation.dashboard.service.ts:821    │    (updateReservation)
│  - reservation.public.controller.ts:551    │    (public booking)
│  - reservation.public.controller.ts:1616   │    (slot hold)
│  - reservationAvailability.service.ts:92   │    (availability read)
└────────────────────────────────────────────┘

                ─── Outbox direction (Avoqado → Google) ───

┌──────────────────────────────────────┐
│ reservation.service createReservation│
│  prisma.$transaction([               │
│    Reservation.create,               │
│    CalendarSyncOutbox.create (1+)    │
│  ])                                  │
└──────────────┬───────────────────────┘
               │
               ▼
        ┌──────────────┐
        │  RabbitMQ    │ ←── sweeper job (30s) picks PENDING outbox rows
        │  gcal.push   │
        └──────┬───────┘
               │
               ▼
┌──────────────────────────────────────┐
│ GoogleCalendarPushWorker             │
│  - Idempotent: search by private     │
│    extendedProperty before insert    │
│  - Save ReservationGoogleEventMapping│
│  - Retry with exponential backoff    │
│  - Dead-letter after 7 attempts      │
└──────────────────────────────────────┘

                ─── Cron jobs ───

  gcal-channel-renewal.job   every 12h   renew watch channels <48h to expiry
  gcal-outbox-sweeper.job    every 30s   pick PENDING rows older than 30s
  gcal-inbox-sweeper.job     every 30s   pick unprocessed Inbox rows
  gcal-horizon-refresh.job   daily 04:00 bounded re-sync of [yesterdayEnd, todayEnd+maxAdvanceDays]
  gcal-pruning.job           daily       delete ExternalBusyBlock endsAt < NOW - 7d
  gcal-health-check.job      daily       calendarList.get on quiet connections
```

## 6. Data model

### 6.1 New models

```prisma
enum GoogleCalendarConnectionScope {
  VENUE
  STAFF_PERSONAL
}

enum GoogleCalendarConnectionStatus {
  CONNECTED
  TOKEN_REVOKED       // invalid_grant on refresh
  CALENDAR_LOST       // 403/404 (ACL revoked on calendar but OAuth still works)
  WATCH_FAILED        // 3+ failed channel renewals
  DISCONNECTED        // user explicit disconnect
}

model GoogleCalendarConnection {
  id                       String                          @id @default(cuid())
  scope                    GoogleCalendarConnectionScope

  // Exactly one of these is set per row (enforced via partial unique indexes; see migration).
  venueId                  String?
  venue                    Venue?                          @relation(fields: [venueId], references: [id], onDelete: Cascade)
  staffId                  String?
  staff                    Staff?                          @relation("StaffGoogleCalendarConnection", fields: [staffId], references: [id], onDelete: Cascade)

  // Google account identifiers
  googleAccountEmail       String                          // for display; not used for auth
  googleAccountSub         String                          // OIDC subject id; stable identifier
  selectedCalendarId       String                          // user picks from their calendar list at connect time
  selectedCalendarSummary  String                          // cached display name

  // Encrypted credentials (AES-256-GCM, key from GOOGLE_CALENDAR_TOKEN_KEY env)
  refreshTokenCiphertext   Bytes
  accessTokenCiphertext    Bytes?
  accessTokenExpiresAt     DateTime?

  // Calendar metadata (fetched at connect time, refreshed on health check)
  selectedCalendarTimeZone String                          // e.g. "America/Mexico_City" — used for all-day event boundaries

  // Sync state
  syncToken                String?                         // Google opaque incremental token; null = needs full sync
  lastSyncedAt             DateTime?
  lastHorizonEnd           DateTime?                       // last end-of-booking-horizon covered (updated by gcal-horizon-refresh.job)

  // Status
  status                   GoogleCalendarConnectionStatus  @default(CONNECTED)
  statusReason             String?                         @db.Text
  connectedAt              DateTime                        @default(now())
  disconnectedAt           DateTime?

  // Audit
  createdByStaffId         String?                         // who initiated the OAuth (may differ from staffId for venue scope)
  createdByStaff           Staff?                          @relation("StaffCreatedGoogleConnection", fields: [createdByStaffId], references: [id], onDelete: SetNull)

  // Relations
  channels                 GoogleCalendarChannel[]
  busyBlocks               ExternalBusyBlock[]
  outboxRows               CalendarSyncOutbox[]
  eventMappings            ReservationGoogleEventMapping[]

  createdAt                DateTime                        @default(now())
  updatedAt                DateTime                        @updatedAt

  @@index([venueId])
  @@index([staffId])
  @@index([status])
}
// Required raw-SQL migration (Prisma doesn't model these natively):
//
//   -- Enforce "exactly one of venueId/staffId is set, matching scope".
//   -- Partial unique indexes alone do NOT enforce this; a row with
//   -- scope=VENUE AND both venueId and staffId set would slip through.
//   ALTER TABLE "GoogleCalendarConnection"
//     ADD CONSTRAINT gcal_conn_scope_xor CHECK (
//       (scope = 'VENUE'          AND "venueId" IS NOT NULL AND "staffId" IS NULL) OR
//       (scope = 'STAFF_PERSONAL' AND "staffId" IS NOT NULL AND "venueId" IS NULL)
//     );
//
//   -- One venue-master connection per venue, one personal connection per staff.
//   CREATE UNIQUE INDEX gcal_conn_venue_unique
//     ON "GoogleCalendarConnection"("venueId") WHERE "scope" = 'VENUE';
//   CREATE UNIQUE INDEX gcal_conn_staff_unique
//     ON "GoogleCalendarConnection"("staffId") WHERE "scope" = 'STAFF_PERSONAL';

enum GoogleCalendarChannelStatus {
  ACTIVE
  RENEWING   // new channel created, old still valid during overlap
  EXPIRED
  STOPPED
}

model GoogleCalendarChannel {
  id           String                       @id @default(cuid())
  connectionId String
  connection   GoogleCalendarConnection     @relation(fields: [connectionId], references: [id], onDelete: Cascade)

  channelId    String                       @unique             // UUID we send to events.watch
  resourceId   String                                          // returned by Google; identifies the watched resource
  token        String                                          // random 32-byte hex; we validate constant-time
  expiresAt    DateTime
  status       GoogleCalendarChannelStatus  @default(ACTIVE)
  createdAt    DateTime                     @default(now())
  stoppedAt    DateTime?

  @@index([connectionId, status])
  @@index([expiresAt, status])  // renewal cron
  @@index([resourceId])          // webhook lookup
}

model ExternalBusyBlock {
  id                  String                    @id @default(cuid())

  googleConnectionId  String
  connection          GoogleCalendarConnection  @relation(fields: [googleConnectionId], references: [id], onDelete: Cascade)

  // Denormalized scope (set from connection at write time, never updated).
  // - venueId set when connection.scope = VENUE
  // - staffId set when connection.scope = STAFF_PERSONAL (applies to all venues this staff works at)
  venueId             String?
  staffId             String?

  // Google source identifiers
  externalSource      String                    @default("GOOGLE")  // future-proofing for Outlook etc.
  externalCalendarId  String
  externalEventId     String

  // Time
  startsAt            DateTime                  // real UTC; for all-day events, computed from venue timezone
  endsAt              DateTime
  allDay              Boolean                   @default(false)

  // Optional metadata (NOT used for blocking decisions; for UX/debug only)
  title               String?                   @db.Text
  isPrivate           Boolean                   @default(true)  // suppress title display if true

  createdAt           DateTime                  @default(now())
  updatedAt           DateTime                  @updatedAt

  @@unique([googleConnectionId, externalEventId])
  @@index([venueId, startsAt, endsAt])      // venue-scope blocks
  @@index([staffId, startsAt, endsAt])      // staff-scope blocks (apply across venues)
}

model GoogleCalendarWebhookInbox {
  id              String   @id @default(cuid())
  connectionId    String
  channelId       String
  resourceId      String
  resourceState   String   // "sync" | "exists" | "not_exists"
  messageNumber   String

  receivedAt      DateTime @default(now())
  processedAt     DateTime?
  attempts        Int      @default(0)
  lastError       String?  @db.Text

  @@index([processedAt, receivedAt])
  @@index([connectionId, processedAt])
}

enum CalendarSyncOperation {
  CREATE
  UPDATE
  CANCEL
  UPDATE_ROSTER   // ClassSession description-only update
}

enum CalendarSyncStatus {
  PENDING
  IN_PROGRESS
  SUCCESS
  FAILED          // will retry
  DEAD_LETTER     // exhausted retries
  SKIPPED         // module disabled mid-flight, connection lost, etc.
}

model CalendarSyncOutbox {
  id                  String                    @id @default(cuid())
  venueId             String                                              // tenant isolation
  venue               Venue                     @relation(fields: [venueId], references: [id], onDelete: Cascade)

  reservationId       String?
  reservation         Reservation?              @relation(fields: [reservationId], references: [id], onDelete: Cascade)
  classSessionId      String?
  classSession        ClassSession?             @relation(fields: [classSessionId], references: [id], onDelete: Cascade)

  operation           CalendarSyncOperation
  targetConnectionId  String
  targetConnection    GoogleCalendarConnection  @relation(fields: [targetConnectionId], references: [id], onDelete: Cascade)

  // Grouping key for collapse/coalesce — identifies the (source, target) pair across all operations.
  // Format: "reservation:<reservationId>:<connectionId>" or "class:<classSessionId>:<connectionId>".
  // Indexed for the worker's "find pending ops for this source+target" query.
  syncKey             String

  // Per-row uniqueness — full operation. Used by worker to dedupe enqueues.
  idempotencyKey      String                    @unique

  status              CalendarSyncStatus        @default(PENDING)
  attempts            Int                       @default(0)
  scheduledAt         DateTime                  @default(now())
  processedAt         DateTime?
  lastError           String?                   @db.Text

  // For UPDATE_ROSTER debounce
  debounceUntil       DateTime?

  createdAt           DateTime                  @default(now())

  @@index([status, scheduledAt])
  @@index([venueId, status])
  @@index([syncKey, status, createdAt])  // collapse query: find PENDING ops for a (source, target) pair in order
  @@index([reservationId])
  @@index([classSessionId])
}

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

  @@id([connectionId, googleEventId])  // composite key — googleEventId is unique within a calendar/connection
  @@index([reservationId])
  @@index([classSessionId])
}
// Required raw-SQL migration alongside ReservationGoogleEventMapping:
//
//   -- "One mapping per (reservation OR classSession, connection)" — prevents
//   -- duplicate Google events if a retry races and the idempotency search
//   -- by extendedProperty fails (e.g. private property indexing lag).
//   CREATE UNIQUE INDEX rgem_reservation_conn
//     ON "ReservationGoogleEventMapping"("reservationId", "connectionId")
//     WHERE "reservationId" IS NOT NULL;
//   CREATE UNIQUE INDEX rgem_classsession_conn
//     ON "ReservationGoogleEventMapping"("classSessionId", "connectionId")
//     WHERE "classSessionId" IS NOT NULL;
```

### 6.2 Modified models

`Venue` adds:

```prisma
googleCalendarConnections GoogleCalendarConnection[]
calendarSyncOutbox        CalendarSyncOutbox[]
```

`Staff` adds:

```prisma
googleCalendarConnection   GoogleCalendarConnection?   @relation("StaffGoogleCalendarConnection")
createdGoogleConnections   GoogleCalendarConnection[]  @relation("StaffCreatedGoogleConnection")
```

`Reservation` adds:

```prisma
googleEventMappings  ReservationGoogleEventMapping[]
calendarSyncOutbox   CalendarSyncOutbox[]
```

`ClassSession` adds:

```prisma
googleEventMappings  ReservationGoogleEventMapping[]
calendarSyncOutbox   CalendarSyncOutbox[]
```

`ReservationSettings` adds:

```prisma
// Master toggle (independent of Module enablement; module gates the whole feature, this gates push behavior)
googleCalendarPushEnabled      Boolean  @default(true)
googleCalendarDualWrite        Boolean  @default(false)  // push to BOTH staff personal AND venue master
googleCalendarEventDetailLevel String   @default("MINIMAL")  // MINIMAL | SERVICE | FULL
googleCalendarRemoveCancelled  Boolean  @default(false)  // delete vs patch with status=cancelled
googleCalendarClassRosterInDescription Boolean @default(true)
```

### 6.3 Module registration

Add to `scripts/setup-modules.ts`:

```typescript
{
  code: 'GOOGLE_CALENDAR_SYNC',
  name: 'Google Calendar Sync',
  category: 'INTEGRATIONS',
  description: 'Sincronización bidireccional con Google Calendar para reservaciones',
  configSchema: { /* venue-level overrides if needed in future */ },
  defaultEnabled: false,  // venues opt in
}
```

## 7. OAuth flow

### 7.1 Required scopes

Four scopes are needed:

| Scope                                                            | Purpose                                                      | Sensitivity   |
| ---------------------------------------------------------------- | ------------------------------------------------------------ | ------------- |
| `openid`                                                         | Triggers Google's OIDC flow; gets us a verifiable `id_token` | Non-sensitive |
| `email`                                                          | Adds the user's email to the `id_token` claims               | Non-sensitive |
| `https://www.googleapis.com/auth/calendar.events`                | Read/write events on the selected calendar                   | Sensitive     |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | List the user's calendars so they can pick which one to sync | Sensitive     |

**Why OIDC (`openid email`):** the `GoogleCalendarConnection` and `GoogleOAuthSession` models store `googleAccountEmail` and
`googleAccountSub` as identity columns. Without OIDC, those would have to come from `userinfo` or Calendar API responses — neither
cryptographically tied to the consent we just received, both attacker-controllable in the rare case the access token is misused before we
save it. With `openid email`, Google returns a signed `id_token` JWT we verify against Google's JWKS, and we extract `sub` and `email` from
its verified claims.

**Why both Calendar scopes:** `calendar.events` alone does NOT permit `calendarList.list`. Google's documented scope matrix requires
`calendar.calendarlist.readonly`, `calendar.calendarlist`, `calendar.readonly`, or full `calendar` for that endpoint. We choose
`calendar.calendarlist.readonly` — the most-restricted scope that works — to minimize the consent footprint.

The Calendar scopes are **sensitive** (require Google app verification, not the more onerous **restricted** scope path that requires CASA
assessment). The OIDC scopes (`openid email`) are non-sensitive and add no friction to verification.

### 7.2 Endpoints

```
GET    /api/v1/google-calendar/oauth/init?intent=staff_personal|venue_master
GET    /api/v1/google-calendar/oauth/callback?code=...&state=...   (Google redirect target — MUST be GET; that's how Google redirects)
GET    /api/v1/google-calendar/oauth/calendars?session=<short-lived-token>   (lists user's calendars filtered by accessRole; called by dashboard after callback completes server-side OAuth)
POST   /api/v1/google-calendar/connections                            (commits the connection with the picked calendarId)
GET    /api/v1/google-calendar/connections                            (list connections for current venue/staff)
DELETE /api/v1/google-calendar/connections/:id                        (disconnect; revokes tokens with Google, stops watch channel, drops blocks)
```

**Flow ordering:**

1. Dashboard GET `…/init` → server returns the Google authorization URL (303 redirect or JSON depending on UI choice).
2. User authenticates with Google.
3. Google redirects to `GET …/callback?code=...&state=...` server-side. Server validates state, exchanges code for tokens, stashes encrypted
   credentials and a short-lived `oauthSession` row (TTL 10 min) keyed by random `session` token, redirects the user back to the dashboard
   URL with `?session=<sessionToken>` query param.
4. Dashboard calls GET `…/oauth/calendars?session=<sessionToken>` → server fetches `calendarList.list`, filters by `accessRole`, returns
   picker payload.
5. User picks a calendar → dashboard POSTs to `…/connections` with `{ session, selectedCalendarId }`. Server finalizes: creates
   `GoogleCalendarConnection`, kicks off backfill, subscribes to watch.

### 7.2.1 Refresh token guarantee

Google returns `refresh_token` **only when**:

- `access_type=offline` is in the authorization URL, AND
- The user has not previously consented to this `client_id` for these scopes (re-consent omits `refresh_token`).

Without a refresh token, the connection dies the first time the access token expires (1 hour). To make refresh tokens reliable:

1. The init URL always sends `access_type=offline`.
2. The init URL sends `include_granted_scopes=true` so users who previously granted partial scopes don't lose them.
3. After the token exchange in the callback, if the response has NO `refresh_token`:
   - Discard the partial credentials.
   - Redirect the user back through OAuth with `prompt=consent` (forces Google to show the consent screen and emit a fresh `refresh_token`).
   - If the second attempt ALSO returns no refresh token, fail with a user-facing message: "No se pudo obtener un token persistente de
     Google. Revoca el acceso de Avoqado en tu cuenta de Google e intenta de nuevo."

```typescript
const GOOGLE_CALENDAR_OAUTH_SCOPES = [
  'openid', // OIDC — gives us id_token
  'email', // OIDC — email claim in id_token
  'https://www.googleapis.com/auth/calendar.events', // read/write events
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly', // list calendars at picker time
].join(' ')

function buildAuthUrl(state: string, forceConsent: boolean) {
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_OAUTH_SCOPES,
    access_type: 'offline',
    include_granted_scopes: 'true',
    state,
  })
  if (forceConsent) params.set('prompt', 'consent')
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}
```

### 7.3 State binding & `GoogleOAuthSession`

OAuth has two unrelated security primitives: a **state JWT** that survives the trip through Google and back, and a **session token** that
bridges the public callback to the authenticated dashboard endpoints.

#### 7.3.1 State JWT (signed, lives in the URL)

The `state` parameter on `/init` is a JWT signed with `OAUTH_STATE_SECRET` (separate from `JWT_SECRET`):

```typescript
{
  intent:     'staff_personal' | 'venue_master',
  authUserId: string,   // who initiated; used later to bind dashboard session
  staffId?:   string,   // for staff_personal: MUST equal authUserId (or caller has calendar:disconnect_staff)
  venueId?:   string,   // for venue_master
  csrfNonce:  string,   // 32-byte random hex
  iat:        number,
  exp:        number,   // 10 minutes
}
```

#### 7.3.2 Callback (GET, NO authContext required)

Google redirects the user's browser to `GET …/oauth/callback?code=X&state=Y` as a top-level navigation. The dashboard's API `authContext` is
NOT guaranteed at this endpoint — the user might land here via a fresh tab, after a long pause, with a stale cookie. Treating the callback
as an authenticated endpoint is a category error.

The callback validates ONLY:

1. JWT signature + expiration on `state`.
2. CSRF nonce shape (32-byte hex).
3. (If we want extra safety) `csrfNonce` matches a value briefly stashed in a short-lived signed cookie set at `/init` time.

It does NOT call `authContext`. After validation:

4. Exchange `code` for tokens with Google. The token response includes `access_token`, `refresh_token` (if `access_type=offline` and not
   re-consent), `expires_in`, AND — because we requested `openid email` — an `id_token` JWT.
5. Verify the `id_token` against Google's JWKS:
   ```typescript
   const ticket = await googleAuthClient.verifyIdToken({
     idToken: tokenResponse.id_token,
     audience: GOOGLE_OAUTH_CLIENT_ID, // must match our client_id
   })
   const payload = ticket.getPayload()
   if (!payload?.sub || !payload?.email) throw new HttpError(502, 'oidc_missing_claims')
   if (!payload.email_verified) throw new HttpError(403, 'google_email_not_verified')
   const googleAccountSub = payload.sub // stable identifier, never reassigned
   const googleAccountEmail = payload.email
   ```
   These signed claims are what we persist on `GoogleOAuthSession` and later `GoogleCalendarConnection`. The `sub` is the immutable Google
   account ID — use it (not email) for any equality check across accounts.
6. Validate refresh_token presence; if absent and not retried, redirect through `prompt=consent` (§7.2.1).
7. Encrypt tokens at rest with AES-256-GCM (`GOOGLE_CALENDAR_TOKEN_KEY`).
8. Generate a `sessionToken` (32-byte hex). Hash it (sha256) and INSERT a `GoogleOAuthSession` row with the hash, encrypted credentials,
   `authUserId`, `intent`, `venueId|staffId`, `googleAccountSub`, `googleAccountEmail`. TTL 10 min.
9. 303-redirect the user back to the dashboard: `https://dashboardv2.avoqado.io/google-calendar/picker?session=<sessionToken>`.

#### 7.3.3 `GoogleOAuthSession` model

```prisma
model GoogleOAuthSession {
  id                       String   @id @default(cuid())

  // Opaque token returned to the user (in the redirect URL) is 32-byte hex.
  // We store only the sha256 hash — leak of DB rows does not leak active sessions.
  tokenHash                String   @unique

  // Intent context (mirrors the state JWT — duplicated here for the post-callback flow)
  authUserId               String   // who initiated; subsequent endpoints check authContext.userId === this
  intent                   String   // 'staff_personal' | 'venue_master'
  venueId                  String?
  staffId                  String?

  // Encrypted credentials — staged until user picks a calendar at /connections.
  // Refresh token is REQUIRED to create a session — if Google omitted it on the
  // first token exchange, the callback retries with prompt=consent (§7.2.1)
  // BEFORE this row is created. A session that exists is guaranteed to carry one.
  encryptedRefreshToken    Bytes
  encryptedAccessToken     Bytes
  accessTokenExpiresAt     DateTime

  // Account identity (display only at picker time; final identity is captured on GoogleCalendarConnection)
  googleAccountEmail       String
  googleAccountSub         String

  // Lifecycle
  createdAt                DateTime  @default(now())
  expiresAt                DateTime  // createdAt + 10 minutes
  consumedAt               DateTime? // one-time-use: set when POST /connections commits a connection

  @@index([expiresAt])
}
```

A daily cron prunes rows where `expiresAt < NOW() - 1 hour`.

#### 7.3.4 Authenticated endpoints AFTER callback

`GET /api/v1/google-calendar/oauth/calendars?session=<sessionToken>` and `POST /api/v1/google-calendar/connections` both require
`authContext` (standard dashboard auth middleware). They share this guard:

```typescript
async function loadSessionForUser(req: Request, sessionToken: string) {
  const hash = sha256(sessionToken)
  const session = await prisma.googleOAuthSession.findUnique({ where: { tokenHash: hash } })
  if (!session) throw new HttpError(404, 'oauth_session_not_found')
  if (session.consumedAt) throw new HttpError(409, 'oauth_session_already_consumed')
  if (session.expiresAt < new Date()) throw new HttpError(410, 'oauth_session_expired')
  if (session.authUserId !== (req as any).authContext.userId) {
    // Different user is trying to consume this session — possible CSRF / link sharing
    throw new HttpError(403, 'oauth_session_user_mismatch')
  }
  // For staff_personal intent: enforce staffId === authUserId (or calendar:disconnect_staff)
  if (session.intent === 'staff_personal' && session.staffId && session.staffId !== session.authUserId) {
    if (!hasPermission((req as any).authContext, 'calendar:disconnect_staff')) {
      throw new HttpError(403, 'cross_user_oauth_denied')
    }
  }
  return session
}
```

`POST /connections` is the single point that consumes the session. Critical: `consumedAt` and the `GoogleCalendarConnection` INSERT (plus
the first `GoogleCalendarChannel` row from `events.watch`) commit in the SAME DB transaction. Backfill (Phase A `events.list`) runs AFTER
the transaction commits — fire-and-forget into the pull worker via the inbox sweeper path or a direct queue enqueue. A failed backfill
leaves a CONNECTED row with `syncToken=null`; the next pull worker run picks it up via the "needs full sync" predicate. We NEVER end up with
a consumed session row whose connection doesn't exist.

```typescript
// Inside POST /connections handler, after validating session + accessRole:
const result = await prisma.$transaction(async tx => {
  // 1. Atomic one-time-use guard. If 0 rows updated → another concurrent commit won; return 409.
  const consumed = await tx.googleOAuthSession.updateMany({
    where: { id: session.id, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  if (consumed.count === 0) throw new HttpError(409, 'oauth_session_already_consumed')

  // 2. Create the connection (encrypted creds copied from session — syncToken null until backfill).
  const connection = await tx.googleCalendarConnection.create({
    data: { ...resolveScope(session), encryptedRefreshToken: session.encryptedRefreshToken /* ... */ },
  })

  // 3. Subscribe to push and store the channel — same transaction. If events.watch throws, the txn rolls back, session stays unconsumed.
  const watchRes = await calendar.events.watch({
    /* ...as in §7.4 step 7 */
  })
  await tx.googleCalendarChannel.create({
    data: {
      connectionId: connection.id,
      channelId: watchRes.channelId,
      resourceId: watchRes.resourceId,
      token: watchRes.token,
      expiresAt: new Date(Number(watchRes.expiration)),
      status: 'ACTIVE',
    },
  })

  return connection
})

// 4. POST-COMMIT: enqueue backfill. If this fails, the next pull worker tick picks up the connection via syncToken=null.
await rabbitmq.publish('gcal.pull', { connectionId: result.id }).catch(() => {})
```

Both endpoints rate-limit by `authContext.userId` to mitigate brute-force probing of session tokens (the sha256 hash and 32-byte entropy
already make this impractical, but defense in depth).

### 7.4 Connect (POST /connections)

Server side (in order, called from `POST /api/v1/google-calendar/connections`):

1. Resolve scope from auth context + intent.
2. Validate the user's `accessRole` on the picked calendar:
   - **STAFF_PERSONAL** intent (push target): require `accessRole ∈ { 'owner', 'writer' }`. Reject `reader` and `freeBusyReader` with 422
     `calendar_insufficient_access` — we can't insert events into a read-only calendar.
   - **VENUE** intent: if `ReservationSettings.googleCalendarPushEnabled` is true, same rule. If push is explicitly disabled (venue uses
     calendar as read-only blocker only), allow `reader` as well. The picker UI in §7.2 step 4 also pre-filters the calendar list so users
     never see calendars they can't use for the chosen intent — but the server enforces it at commit time too.
3. Encrypt refreshToken with AES-256-GCM (`GOOGLE_CALENDAR_TOKEN_KEY`).
4. Fetch the selected calendar's metadata: `calendarList.get(selectedCalendarId)` → capture `summary`, `timeZone`. The `timeZone` field is
   the calendar's display timezone; all-day events use it as their interpretation context.
5. Insert `GoogleCalendarConnection` row with `selectedCalendarTimeZone` set.
6. **Backfill phase** (Phase A):
   `events.list({ calendarId, timeMin=NOW, timeMax=NOW+maxAdvanceDays, singleEvents=true, showDeleted=false })`. Page through with
   `nextPageToken`. Upsert `ExternalBusyBlock` rows. The LAST page returns `nextSyncToken`. In a single DB transaction at the end, save
   `syncToken`, `lastSyncedAt = NOW`, AND `lastHorizonEnd = NOW + maxAdvanceDays` on the connection. Setting `lastHorizonEnd` here (not only
   in the horizon-refresh job) means a fresh connect leaves no ambiguous state — the next horizon-refresh run knows exactly where backfill
   left off.
7. Subscribe to push notifications. **`events.watch` request shape** (request has `params.ttl`; response returns `expiration`):
   ```typescript
   const channelId = uuidv4()
   const token = crypto.randomBytes(32).toString('hex')
   const res = await calendar.events.watch({
     calendarId: connection.selectedCalendarId,
     requestBody: {
       id: channelId,
       type: 'web_hook',
       address: `${PUBLIC_API_URL}/api/v1/webhooks/google-calendar`,
       token,
       params: { ttl: '604800' }, // seconds; Google's max ≈ 7 days
     },
   })
   // res.data: { kind, id, resourceId, resourceUri, token, expiration }
   await prisma.googleCalendarChannel.create({
     data: {
       connectionId: connection.id,
       channelId,
       resourceId: res.data.resourceId, // from response — required for header validation
       token,
       expiresAt: new Date(Number(res.data.expiration)), // epoch ms — TRUST GOOGLE's value, never compute locally
       status: 'ACTIVE',
     },
   })
   ```
   Do NOT pass `expiration` in the request — Google's events.watch only honors `params.ttl`. Trust the response's `expiration` as the
   authoritative deadline; that's what the renewal cron compares against.
8. Audit log (existing audit pattern from `auditLog` table).

## 8. Sync semantics

### 8.1 Pull (Google → Avoqado)

Triggered by webhook (primary) or inbox sweeper (fallback).

**Single-flight lock per connection**: Redis `SETNX gcal:pull:<connectionId> 1 EX 60`. If lock not acquired, return — concurrent pull will
absorb our changes (Google notifications coalesce).

**Two-phase contract — backfill vs incremental.** Google's `events.list` accepts different parameter shapes depending on whether we're doing
a one-time full backfill or an incremental delta sync. Mixing them produces 400 errors. We commit to exactly these two shapes:

**Phase A — Backfill** (one-time at connect, or after 410 GONE recovery):

```typescript
{
  calendarId: connection.selectedCalendarId,
  timeMin:    nowIso,
  timeMax:    nowPlusMaxAdvanceDaysIso,    // venue.reservationSettings.maxAdvanceDays
  singleEvents: true,                       // expand recurring → instances
  showDeleted: false,                       // not relevant — we have no prior state to delete
  maxResults: 250,
  pageToken: undefined,                     // set on subsequent pages
  // DO NOT pass syncToken.
}
```

Page through via `nextPageToken`. The LAST page returns `nextSyncToken`. Save it.

**Phase B — Incremental** (every webhook):

```typescript
{
  calendarId: connection.selectedCalendarId,
  syncToken: connection.syncToken,          // the saved token
  singleEvents: true,                       // MUST stay consistent with Phase A
  showDeleted: true,                        // required — incremental delivers cancelled events to tombstone
  maxResults: 250,
  pageToken: undefined,                     // set on subsequent pages
  // DO NOT pass timeMin / timeMax / updatedMin / orderBy — Google rejects with 400 when combined with syncToken.
}
```

Page through via `nextPageToken`. The LAST page returns the new `nextSyncToken` — save it ATOMICALLY with the upserts (single DB
transaction). If pagination is interrupted, do NOT save partial state; on next webhook we'll re-do from the old token (Google guarantees the
old token remains valid for ~7 days).

**Per-event handling** (both phases):

First, compute the booking-horizon window:

```typescript
const horizonStart = new Date(NOW - 7 * DAY) // 7d grace for audit / late-arriving past events
const horizonEnd = new Date(NOW + venue.reservationSettings.maxAdvanceDays * DAY)
const inHorizon = (ev: GoogleEvent) => eventEnd(ev) > horizonStart && eventStart(ev) < horizonEnd
```

Then apply the table below in order — first match wins:

| Event state                                                                                                     | Action                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status === 'cancelled'` (only in Phase B)                                                                      | DELETE matching `ExternalBusyBlock`                                                                                                                                                                                                  |
| `extendedProperties.private.avoqadoOrigin === 'avoqado'`                                                        | SKIP — this is our own pushed event                                                                                                                                                                                                  |
| `transparency === 'transparent'` (user marked "free")                                                           | DELETE matching `ExternalBusyBlock` if exists; otherwise no-op                                                                                                                                                                       |
| User is an invitee AND `responseStatus === 'declined'` (`attendees[].self === true` resolves "user is invitee") | DELETE matching `ExternalBusyBlock` if exists; otherwise no-op. Declined invites don't block — the user isn't attending.                                                                                                             |
| `!inHorizon(ev)` (event outside the booking-horizon window)                                                     | DELETE matching `ExternalBusyBlock` if exists (event was previously in window and moved out); otherwise no-op. Far-future or far-past events are not stored. `gcal-horizon-refresh.job` re-captures them when they enter the window. |
| Otherwise (inside horizon, not cancelled/declined/transparent/own)                                              | UPSERT `ExternalBusyBlock`                                                                                                                                                                                                           |

The horizon filter on incremental sync prevents `ExternalBusyBlock` from growing unbounded when a connected calendar contains years of
unrelated events that get edited periodically. Without this, a staff member's 2030 dental cleaning recurring series gets a row that we never
query and never prune.

**410 GONE on syncToken**: token expired (Google retains state ~7 days). Recovery: delete ALL `ExternalBusyBlock` for this connection, run
Phase A (backfill), save new `nextSyncToken` AND `lastHorizonEnd = NOW + maxAdvanceDays` in a single transaction. Same path is used on first
connect (initial sync token doesn't exist yet).

**401 Unauthorized**: refresh access token using stored refreshToken. If refresh returns `invalid_grant`: set `status=TOKEN_REVOKED`, delete
all `ExternalBusyBlock` for connection, notify user.

**All-day events**: Google sends `start.date = "2026-05-15"` (no time). Convert to UTC interval `[localMidnight, localMidnight+24h)` using
`connection.selectedCalendarTimeZone` (captured at connect from `calendarList.get`) via `fromZonedTime` (existing pattern in
`critical-warnings.md`).

> **v1 known limitation:** all-day events are interpreted in the calendar's single timezone. A staff member who travels across timezones
> will see their all-day "vacation" event interpreted in the calendar's home timezone, not where they currently are. This is the standard
> Google Calendar behavior and matches user expectations for the appointment-scheduling use case.

**Recurring events**: handled automatically by `singleEvents: true` — Google materializes each instance with a unique `id` (e.g.,
`eventid_20260515T100000Z`). Future occurrences appear in subsequent syncs as the instance comes within Google's lookahead window.

### 8.1.5 Horizon refresh (daily)

The initial backfill covers `[NOW, NOW+maxAdvanceDays]`. As the calendar day advances, the booking horizon shifts forward by one day every
day. Pure webhook-driven sync does NOT guarantee events newly inside that horizon get synced — Google's `events.watch` notifies on CHANGES
to events, not on "this previously-existing event now falls inside your window of interest".

**Concrete failure mode without this job:**

- Day 1, 04:00 — staff connects calendar. Backfill covers `[Day 1, Day 1 + 30]`.
- Day 1, 23:00 — staff creates an event for Day 35 in their Google calendar. Webhook fires. `events.list` with syncToken returns the new
  event. ✅ It's stored.
- Day 5, 14:00 — staff has NOT touched their calendar since Day 1. Customer tries to book Day 32 at 3pm. Staff has a recurring weekly event
  for Day 32 at 3pm that's been in Google for months — but our last backfill stopped at Day 31. ❌ Customer books over it.

**Fix — `gcal-horizon-refresh.job` (daily at 04:00 venue-local, or 04:00 UTC for staff-personal):**

For each CONNECTED connection:

```typescript
const lastHorizonEnd = connection.lastHorizonEnd ?? connection.connectedAt + maxAdvanceDays
const newHorizonEnd = NOW + maxAdvanceDays

if (newHorizonEnd <= lastHorizonEnd) return // nothing new to cover

// Bounded re-sync of just the new window — does NOT invalidate syncToken
const events = await calendar.events.list({
  calendarId: connection.selectedCalendarId,
  timeMin: lastHorizonEnd.toISOString(),
  timeMax: newHorizonEnd.toISOString(),
  singleEvents: true,
  showDeleted: false,
  // No syncToken — this is a windowed read, not an incremental delta.
})
// Paginate, upsert ExternalBusyBlock rows (using the same per-event handling table from §8.1).
// Do NOT save nextSyncToken from this call — keep the incremental token from the live sync.

await tx.googleCalendarConnection.update({
  where: { id: connection.id },
  data: { lastHorizonEnd: newHorizonEnd },
})
```

Adds a new column to `GoogleCalendarConnection`:

```prisma
lastHorizonEnd  DateTime?   // last covered end of the booking horizon; null until first horizon-refresh runs
```

**Cost**: 1 list call per connection per day, bounded to roughly 1 day's worth of new events. Cheap.

**Why this doesn't conflict with the incremental syncToken**: we never pass `syncToken` to this call; it's a windowed snapshot. Upserts are
idempotent (`@@unique([googleConnectionId, externalEventId])`). The incremental sync remains the source of truth for changes inside the
already-covered window; horizon refresh only adds rows from the newly-entered window.

### 8.2 Push (Avoqado → Google)

Triggered by inserting a `CalendarSyncOutbox` row in the same transaction as the Reservation/ClassSession mutation. Worker processes async.

**Per-key serialization (critical):** outbox rows for the same `(reservationId|classSessionId, connectionId)` MUST be processed in insertion
order. Without this, a CREATE→CANCEL pair processed out of order produces a phantom Google event: CANCEL runs first with no mapping (no-op),
CREATE runs later and inserts a Google event for an already-cancelled reservation.

Two complementary mechanisms enforce ordering:

1. **Postgres advisory lock per key**: worker calls
   `pg_try_advisory_xact_lock(hashtext('gcal-push:' || reservationId || ':' || connectionId))` (or `classSessionId`). If lock not acquired,
   skip — another worker has it; we'll be re-driven by the sweeper.
2. **State-aware push**: every CREATE/UPDATE handler re-reads the current Reservation/ClassSession state from DB inside the locked section
   BEFORE calling Google. If status is now `CANCELLED` (or class is cancelled), mark the outbox row `SKIPPED` and emit a CANCEL row in its
   place (if no mapping exists) or run the CANCEL inline. CREATE never fires for an already-cancelled source row.

Additionally, when a CANCEL row is enqueued, the worker pre-flight upgrades any earlier PENDING `CREATE` / `UPDATE` / `UPDATE_ROSTER` rows
for the same `syncKey` to `SKIPPED` in a single query:

```sql
UPDATE "CalendarSyncOutbox"
   SET status     = 'SKIPPED',
       lastError  = 'superseded_by_cancel'
 WHERE "syncKey"  = $1
   AND status     = 'PENDING'
   AND operation IN ('CREATE','UPDATE','UPDATE_ROSTER')
   AND "createdAt" < $2     -- the CANCEL row's createdAt
```

This collapses redundant work and prevents the race entirely in the happy path. Indexed on `(syncKey, status, createdAt)`.

**Idempotency**:

- `CREATE`: before `events.insert`, search by `extendedProperties.private.avoqadoReservationId={id}` (private extended properties are
  indexed by Google and queryable via `privateExtendedProperty=key=value`). If exists, treat as success and save mapping. The partial unique
  on `ReservationGoogleEventMapping(reservationId, connectionId)` is the DB-level backstop against duplicates that slip past the API-level
  search (e.g., extended-property indexing lag).
- `UPDATE`: requires existing mapping. If mapping missing (e.g., previous CREATE failed mid-flight): if source row state is still active,
  promote operation to CREATE; otherwise emit CANCEL or skip.
- `CANCEL`: requires existing mapping. If missing, no-op (event was never created in Google).

**Event body (MINIMAL detail level)**:

```typescript
{
  summary: 'Reserva Avoqado',
  description: `https://dashboardv2.avoqado.io/venues/${venueSlug}/reservations/${reservationId}`,
  start: { dateTime: startsAt.toISOString() },
  end: { dateTime: endsAt.toISOString() },
  extendedProperties: {
    private: {
      avoqadoOrigin: 'avoqado',
      avoqadoReservationId: reservation.id,
      avoqadoVenueId: reservation.venueId,
    },
  },
  transparency: 'opaque',
  // Notifications/reminders use the user's calendar default — we don't override.
}
```

**SERVICE detail level**: add `summary = 'Reserva: <productName>'`.

**FULL detail level** (opt-in): add `summary = 'Reserva: <productName> — <guestName>'`, append `description` with party size, special
requests, deposit status.

**Push targets**: see §10 (single target by default).

### 8.3 Direction policy (locked decision)

Google → Avoqado does NOT mutate `Reservation`. If a stylist drags their Avoqado-created event in Google Calendar, the pull-side skip
(`avoqadoOrigin === 'avoqado'`) ignores the change. The next Avoqado-side reservation update overwrites the Google event via `events.patch`.

UI must say (Spanish):

> "Los cambios que hagas en Google Calendar a eventos creados por Avoqado no actualizan la reservación. Para reagendar o cancelar, usa el
> dashboard de Avoqado."

## 9. Webhook handling

### 9.1 Route mounting

Three constraints conspire here:

1. Stripe webhooks at `/api/v1/webhooks` need `express.raw({ type: 'application/json' })` for signature verification (`app.ts:79`).
2. Google notifications often arrive with no body (`sync` handshake) or with non-JSON content types; they need
   `express.raw({ type: '*/*' })`.
3. Express matches routes in mount order. If the Google route is mounted AFTER the existing `/api/v1/webhooks` raw parser, Express may strip
   the body to an empty Buffer (the `application/json` raw parser will short-circuit on the unmatched content-type, but downstream behavior
   is implementation-dependent enough that we don't gamble).

**Required mount order in `app.ts`** (BEFORE `configureCoreMiddlewares`):

```typescript
// 1. Google Calendar webhook — most-specific path, mounted FIRST.
//    type: '*/*' tolerates empty body + non-JSON content types Google may send.
app.post('/api/v1/webhooks/google-calendar', express.raw({ type: '*/*', limit: '64kb' }), handleGoogleCalendarWebhook)

// 2. Existing Stripe webhook router — broader prefix, mounted SECOND.
//    type: 'application/json' is intentionally strict; Stripe always sends JSON.
app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), webhookRoutes)
```

**Why a direct `app.post` and not the existing `webhookRoutes` router for Google:** mounting Google under the same `/api/v1/webhooks` prefix
would inherit the prefix-level `type: 'application/json'` parser, which silently drops Google's notifications. A separate top-level route
with its own parser is the clean separation.

**Regression guard (per `.claude/rules/testing-and-git.md`):** an integration test must POST to `/api/v1/webhooks/stripe/payment_intent`
with a valid Stripe signature AFTER this change and assert it still verifies. Stripe path must remain bit-identical to today.

### 9.2 Handler

```typescript
async function handleGoogleCalendarWebhook(req: Request, res: Response) {
  const channelId = req.header('X-Goog-Channel-ID')
  const token = req.header('X-Goog-Channel-Token')
  const resourceId = req.header('X-Goog-Resource-ID')
  const resourceState = req.header('X-Goog-Resource-State')
  const messageNumber = req.header('X-Goog-Message-Number')

  if (!channelId || !token || !resourceId) return res.status(400).end()

  // 1. Lookup channel — may include both ACTIVE and RENEWING during channel rotation overlap
  const channels = await prisma.googleCalendarChannel.findMany({
    where: { channelId, status: { in: ['ACTIVE', 'RENEWING'] } },
    include: { connection: true },
  })
  if (channels.length === 0) return res.status(404).end()

  // 2. Constant-time token comparison
  const channel = channels.find(c => {
    if (c.token.length !== token.length) return false
    return crypto.timingSafeEqual(Buffer.from(c.token), Buffer.from(token))
  })
  if (!channel) return res.status(401).end()

  // 3. Cross-check resourceId (defense against header tampering)
  if (channel.resourceId !== resourceId) return res.status(401).end()

  // 4. Connection must be active (not REVOKED/DISCONNECTED)
  if (channel.connection.status !== 'CONNECTED') return res.status(200).end() // ack but do nothing

  // 5. Sync handshake — no-op
  if (resourceState === 'sync') return res.status(200).end()

  // 6. DURABLE write to inbox BEFORE returning 200 to Google
  try {
    await prisma.googleCalendarWebhookInbox.create({
      data: {
        connectionId: channel.connectionId,
        channelId,
        resourceId,
        resourceState: resourceState ?? 'unknown',
        messageNumber: messageNumber ?? '0',
      },
    })
  } catch (err) {
    // DB write failed — DON'T 200. Google will retry.
    logger.error({ err, channelId }, 'gcal webhook inbox write failed')
    return res.status(503).end()
  }

  // 7. Best-effort enqueue to RabbitMQ. Sweeper will pick up if this fails.
  rabbitmq.publish('gcal.pull', { connectionId: channel.connectionId }).catch(() => {})

  return res.status(200).end()
}
```

### 9.3 Coalescing semantics

The pull worker processes all pending inbox rows for a connection in a SINGLE `events.list` call, then marks them all `processedAt`.
Multiple notifications about the same connection within a few seconds → one API call to Google. This sidesteps the
message-number-non-sequential gotcha.

### 9.4 Inbox sweeper

Every 30 seconds:

```sql
SELECT connectionId FROM "GoogleCalendarWebhookInbox"
WHERE processedAt IS NULL
  AND (lastError IS NULL OR receivedAt < NOW() - INTERVAL '1 minute')
GROUP BY connectionId
LIMIT 100
```

For each: try the single-flight pull. If lock held, skip (another worker has it).

## 10. Push target resolution

```typescript
function resolvePushTargets(reservation: Reservation, settings: ReservationSettings): GoogleCalendarConnection[] {
  const targets: GoogleCalendarConnection[] = []
  const staffConn = reservation.assignedStaffId ? await findActiveStaffPersonal(reservation.assignedStaffId) : null
  const venueConn = await findActiveVenueMaster(reservation.venueId)

  if (settings.googleCalendarDualWrite && venueConn) {
    // Dual-write mode: push to both
    if (staffConn) targets.push(staffConn)
    targets.push(venueConn)
  } else {
    // Default single-target mode: prefer staff personal
    if (staffConn) targets.push(staffConn)
    else if (venueConn) targets.push(venueConn)
  }
  return targets
}
```

`reservation.assignedStaffId === null` (no staff assigned) → falls back to venue master regardless of dual-write setting.

## 11. Write-path conflict checks (THE critical fix)

The original draft only modified the availability READ path. This is insufficient because reservation creation has independent
conflict-check paths that would still permit double-bookings.

### 11.1 New helper — ADDITIVE, not a replacement

**Design decision (from audit):** the existing conflict logic in `reservation.dashboard.service.ts` and `reservation.public.controller.ts`
already handles nuances we will NOT flatten — table-vs-staff capacity, multi-service appointment chains (`Reservation.productIds[]`),
class-session capacity vs. seat-spot occupation, advisory-locked sections, serializable isolation, and exclude-self-on-update semantics.
Replacing all of this with a single helper would either over-block (rejecting bookings the current code correctly allows) or under-block
(losing the table/capacity/multi-service nuance).

The new helper is therefore **single-purpose** and is called **alongside** existing checks at each integration point:

New file `src/services/reservation/external-busy-block.service.ts`:

```typescript
/**
 * Single-purpose check: does any synced external calendar event (Google, future
 * Outlook/iCloud) block the requested time window for the given (venue, staff?)?
 *
 * CALLED ALONGSIDE existing reservation/slot-hold/capacity checks — never
 * replacing them. The existing checks handle table/staff/capacity/multi-service
 * nuance we do not want to flatten into one generic predicate.
 *
 * Returns the first blocking row found, or null if clear.
 */
export async function checkExternalBusyBlock(
  tx: Prisma.TransactionClient,
  args: {
    venueId: string
    staffId?: string | null
    startsAt: Date
    endsAt: Date
  },
): Promise<ExternalBusyBlock | null> {
  const orClauses: Prisma.ExternalBusyBlockWhereInput[] = [
    // Venue-master blocks affect the venue regardless of staff assignment.
    { venueId: args.venueId },
  ]
  if (args.staffId) {
    // Staff-personal blocks apply to that staff across all their venues.
    orClauses.push({ staffId: args.staffId })
  }
  return tx.externalBusyBlock.findFirst({
    where: {
      OR: orClauses,
      startsAt: { lt: args.endsAt },
      endsAt: { gt: args.startsAt },
    },
  })
}
```

Callers use it like:

```typescript
// inside the existing serializable txn / advisory-lock block
const block = await checkExternalBusyBlock(tx, { venueId, staffId, startsAt, endsAt })
if (block) {
  throw new ConflictError('external_calendar_busy', {
    externalSource: block.externalSource,
    blockStartsAt: block.startsAt,
    blockEndsAt: block.endsAt,
  })
}
// existing reservation/staff/table/capacity checks run unchanged
```

For reservations with no `staffId` (table-only bookings), only venue-master blocks are checked — staff-personal blocks correctly do not
apply.

### 11.2 Integration points

**Rule of placement:** the call MUST live inside the same DB transaction that actually commits the reservation INSERT/UPDATE (or the
slot-hold INSERT). The controller line numbers below are caller context — they help orient the reader, but if the implementer finds that the
SERIALIZABLE transaction lives in the service layer rather than the controller (which is the current Avoqado pattern for dashboard create),
the check goes in the service. Never duplicate the check at both layers — exactly one site per write path.

| Site                            | Authoritative transaction location                                                                                                                                                                                                       | Caller path                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Dashboard `createReservation`   | `src/services/dashboard/reservation.dashboard.service.ts` ~252 (SERIALIZABLE `$transaction`)                                                                                                                                             | dashboard controller → service           |
| Dashboard `updateReservation`   | `src/services/dashboard/reservation.dashboard.service.ts` ~821 (SERIALIZABLE `$transaction`) — reschedule/reassign                                                                                                                       | dashboard controller → service           |
| Public booking create           | Wherever the public path commits the INSERT — likely a service method, with the controller at `src/controllers/public/reservation.public.controller.ts:551` driving it. Insert the check INSIDE that transaction, NOT in the controller. | `book.avoqado.io` → controller → service |
| Slot hold create                | `src/controllers/public/reservation.public.controller.ts:1616` runs an `pg_advisory_xact_lock` on `venueId`-hash then performs the INSERT in the same transaction. Insert the check inside this locked transaction.                      | `book.avoqado.io` → controller           |
| `getAvailableSlots` (read path) | `src/services/dashboard/reservationAvailability.service.ts:92`                                                                                                                                                                           | dashboard + public widget UI             |

For all four write sites: pass the NEW (target) `{ venueId, staffId?, startsAt, endsAt }`. On `updateReservation` reschedules, that's the
destination time, not the current row's time. For `getAvailableSlots`, UNION `ExternalBusyBlock` rows into the busy-intervals computation
alongside Reservations and SlotHolds — same set semantics as today, just one more source.

The existing serializable isolation level + venue-scoped advisory locks remain in place — `checkExternalBusyBlock` is called inside those,
never as a replacement. If the call returns a row, throw the existing `ConflictError`/422-style response the controllers already understand;
no new error type leaks to the API contract.

### 11.3 Residual race window

There is a small race: a Google event created at T0 → notification at T0+1s → pull complete at T0+3s → `ExternalBusyBlock` row visible at
T0+3s. A customer hitting "Confirmar" at T0+2s will succeed.

Mitigations:

- Watch channels (vs polling) keep this window in single-digit seconds, not minutes.
- A nightly reconciliation job (out of v1 scope, noted in §17) can detect post-hoc and notify staff.
- UI copy: "Tu calendario se sincroniza en tiempo casi real. Cambios hechos en Google pueden tardar unos segundos en bloquear nuevas
  reservaciones."

We do NOT attempt to make this zero — that requires a synchronous freebusy query at booking time, which adds Google API latency to every
booking attempt. Rejected.

## 12. Permission model

Add to `src/services/access/access.service.ts` `PERMISSION_CATALOG`:

```typescript
'calendar:manage_venue':         { description: 'Connect/disconnect the venue master Google Calendar', roles: ['OWNER', 'ADMIN'] }
'calendar:connect_self':         { description: 'Connect/disconnect your own personal Google Calendar', roles: ['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'HOST'] }
'calendar:disconnect_staff':     { description: 'Force-disconnect another staff member\'s personal calendar (audit)', roles: ['OWNER', 'ADMIN'] }
'calendar:view_status':          { description: 'View calendar connection status for the venue', roles: ['OWNER', 'ADMIN', 'MANAGER'] }
```

All routes use `checkPermission` middleware (NOT `authorizeRole`).

If `GOOGLE_CALENDAR_SYNC` module is required for paid tier later, add to `PERMISSION_TO_FEATURE_MAP` for the white-label split (per
`.claude/rules/feature-gating.md`).

## 13. Privacy defaults

`googleCalendarEventDetailLevel` in `ReservationSettings`:

| Level               | Title                                    | Description               | PII leaked?                   |
| ------------------- | ---------------------------------------- | ------------------------- | ----------------------------- |
| `MINIMAL` (default) | `Reserva Avoqado`                        | Link to dashboard         | None                          |
| `SERVICE`           | `Reserva: Corte de cabello`              | Link to dashboard         | Service name                  |
| `FULL` (opt-in)     | `Reserva: Corte de cabello — Juan Pérez` | Link + party size + notes | Customer name, service, notes |

Dashboard settings UI must show a preview of each level's event as it would appear in Google Calendar, with a warning chip on FULL:
"Información del cliente visible en widgets de teléfono, calendarios compartidos, asistentes de voz y backups de Google." Default forced to
MINIMAL on venues newly enabling the module.

## 14. ClassSession push rule

A ClassSession is a single calendar event regardless of attendee count.

### 14.1 On ClassSession create

```typescript
await prisma.$transaction(async (tx) => {
  const cs = await tx.classSession.create({ ... })
  const targets = resolveClassPushTargets(cs)  // instructor's personal if connected, else venue master
  for (const target of targets) {
    await tx.calendarSyncOutbox.create({
      data: {
        venueId:            cs.venueId,
        classSessionId:     cs.id,
        operation:          'CREATE',
        targetConnectionId: target.id,
        syncKey:            `class:${cs.id}:${target.id}`,                  // grouping key for collapse/coalesce
        idempotencyKey:     `class:${cs.id}:CREATE:${target.id}`,            // unique per row
      },
    })
  }
})
```

### 14.2 On Reservation against a class

Do NOT enqueue a new event push. Instead enqueue `UPDATE_ROSTER` against the class's existing event with `debounceUntil = NOW() + 30s`. The
outbox worker collapses consecutive UPDATE_ROSTER rows for the same `classSessionId + connectionId` and emits one `events.patch` per
30-second window.

The patched `description` includes the roster (names only, party size, or "5 attendees" — depending on detail level).

### 14.3 On ClassSession cancel

`cancelClassSession` in `classSession.dashboard.service.ts:325` enqueues ONE `CANCEL` outbox row per target connection (not one per attendee
reservation).

## 15. Error handling & resilience

### 15.1 Failure matrix

| Failure                                   | Detection                                                                        | Recovery                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| RabbitMQ down                             | Worker can't consume / publish fails                                             | Inbox + outbox sweepers (30s) pick up orphaned work directly from DB                                          |
| Worker process crashed                    | Heartbeat metric                                                                 | Restarted by deploy platform; sweeper picks up stale `IN_PROGRESS` rows after timeout                         |
| Redis down (single-flight lock)           | Lock acquisition errors                                                          | Fall back to a Postgres advisory lock keyed on `connectionId` hashtext                                        |
| Google API 5xx                            | `events.list` / `events.insert` error                                            | Exponential backoff: 30s, 1min, 5min, 30min, 2h, 6h, 24h. After 7 attempts → DEAD_LETTER + alert              |
| Google API 401                            | Response code                                                                    | Refresh access token. If refresh fails with `invalid_grant`: `status=TOKEN_REVOKED`, drop blocks, notify user |
| Google API 403/404 on calendar            | Response code                                                                    | `status=CALENDAR_LOST`, notify user                                                                           |
| Watch channel expired                     | `expiresAt` in DB (TRUSTED from `events.watch` response, never computed locally) | Renewal cron renews 48h before expiration. If 3 renewals fail → `status=WATCH_FAILED`                         |
| Booking horizon drifts past last backfill | Time advances; new days fall inside `maxAdvanceDays` window                      | `gcal-horizon-refresh.job` daily picks up the newly-uncovered window. See §8.1.5.                             |
| syncToken expired (410)                   | Response                                                                         | Drop all `ExternalBusyBlock` for connection; run Phase A backfill                                             |
| Webhook signature invalid                 | Constant-time compare fails                                                      | 401 to Google; alert if rate of 401s exceeds threshold                                                        |
| Module disabled mid-flight                | Worker check at job start                                                        | Outbox row → `status=SKIPPED`; inbox row processed (we still mark) but pull is no-op                          |

### 15.2 Dead letter handling

`CalendarSyncOutbox` rows in `DEAD_LETTER`:

- Visible in superadmin dashboard with retry button.
- Surface a venue-level notification: "X reservaciones no se pudieron sincronizar a Google Calendar".
- Daily digest email to venue OWNER/ADMIN with permission `calendar:view_status`.

### 15.3 Reconciliation (post-MVP)

Out of v1 scope but noted: a nightly job compares all FUTURE reservations against their mapping rows; missing mappings get re-enqueued as
`CREATE`. This catches gaps from any bug or outage. v1 ships without this; we add it after monitoring DEAD_LETTER rates in production.

## 16. Testing strategy

### 16.1 Unit tests

- `checkExternalBusyBlock` — exhaustive overlap matrix (venue-master block / staff-personal block / both / neither × exact-bound /
  partial-inside / fully-inside / fully-outside × staffId null / staffId set).
- `parseGoogleEventTime` — all-day in MX timezone, all-day across DST boundary, timed event with explicit timezone, timed event with
  floating time (deprecated by Google but possible).
- OAuth state JWT — expired, tampered signature, mismatched authUserId, intent/staffId mismatch.
- Webhook handler — missing headers, token mismatch, resourceId mismatch, valid sync notification, valid exists notification, DB insert
  failure → 503.

### 16.2 Integration tests (real DB)

- Full pull cycle: insert connection, mock `events.list` response with mix (event, cancelled, recurring expanded, transparent,
  avoqadoOrigin), assert `ExternalBusyBlock` state.
- syncToken 410 recovery.
- 401 → refresh → success.
- 401 → refresh fails → status=TOKEN_REVOKED.
- Full push cycle: create reservation, assert outbox row, run worker, assert mapping row, mock Google insert response.
- Idempotent push retry: simulate insert succeeds but DB save fails; second run finds via privateExtendedProperty.
- **Outbox ordering correctness** (critical — guards against ghost-event bug):
  - CREATE → UPDATE → CANCEL all enqueued before worker runs: assert worker collapses to CANCEL only, no Google events created.
  - CREATE in PENDING, then CANCEL enqueued: assert CREATE is upgraded to SKIPPED with `lastError='superseded_by_cancel'`.
  - CREATE processed first, mapping saved, then CANCEL: assert worker calls `events.patch` with `status=cancelled`, mapping moved to
    `TOMBSTONED`.
  - CANCEL enqueued for a reservation that was never pushed (no mapping): assert no Google API call, outbox marked SUCCESS as no-op.
  - CREATE in IN_PROGRESS state, source reservation gets CANCELLED in DB mid-flight: worker re-reads source state inside advisory lock, sees
    CANCELLED, marks outbox row SKIPPED, emits a CANCEL row only if mapping exists (in this scenario it doesn't yet — no Google API call).
  - Concurrent workers on same syncKey: assert `pg_try_advisory_xact_lock` prevents both from calling Google for the same key.
- Conflict-check integration: insert ExternalBusyBlock, attempt to create reservation overlapping it via all three entry points (dashboard,
  public, slot-hold). Assert all three reject.

### 16.3 Workflow tests

- E2E: connect calendar (mocked OAuth callback), seed event via mock, customer hits `book.avoqado.io` for that slot, gets "unavailable".
- E2E: customer books slot, mock Google `events.insert`, assert mapping row, then customer cancels, assert outbox CANCEL row, run worker,
  assert Google `events.patch` to `status=cancelled`.
- Multi-venue staff: stylist Juan at Venue A and Venue B. Connect once. Mock Google event. Assert blocked at both Venue A and Venue B.

### 16.4 Regression tests (required per `.claude/rules/testing-and-git.md`)

- Existing reservation flows (dashboard create, dashboard update, public create, slot hold create) MUST continue to pass after
  `checkExternalBusyBlock` is inserted. The helper is additive — when no synced `ExternalBusyBlock` rows exist for a venue, behavior must be
  identical to today.
- Stripe webhook signature verification still works (we did not touch `express.raw` for Stripe path).

## 17. Open decisions / future work (out of v1 scope)

1. **Outlook / iCloud sync.** `ExternalBusyBlock.externalSource` is the extension point.
2. **Free/busy preview in dashboard.** Show staff their own Google Calendar overlay in the dashboard reservations calendar view.
3. **Apple Calendar via CalDAV.** Different architecture; defer.
4. **Reconciliation cron job.** §15.3.
5. **GiST range index on `ExternalBusyBlock`.** Optimization for when overlap queries get slow.
6. **Per-event ACL / sharing.** Not in v1.
7. **Notification preferences.** Currently we use the user's Google Calendar default reminders. Future: per-venue override (e.g., "no email
   reminders from synced reservations").
8. **Customer-side iCal subscription.** Customers might want an iCal feed for their own bookings. Different feature.
9. **Stripe-gated upgrade to paid Feature.** Module is free in v1; conversion to paid Feature is a schema migration only (`Module` →
   `Feature`, add `VenueFeature` table). Plumbing is already aligned.

## 18. Implementation phases

**Phase 1 — Data + OAuth + Read-only sync**

- Schema migration (all new models including `GoogleOAuthSession`, partial unique indexes, CHECK constraint).
- OAuth flow + connection management: init → Google → GET callback (no authContext) → `GoogleOAuthSession` row → picker with accessRole
  filter → POST `/connections` (consumes session atomically) → disconnect with token revocation.
- `events.watch` with `params.ttl`; channel renewal cron trusting Google-returned `expiration`.
- Pull worker + webhook + inbox + sweeper with declined-attendee handling + horizon filter on incremental.
- `gcal-horizon-refresh.job` daily (`lastHorizonEnd` stamped on both backfill and refresh).
- `checkExternalBusyBlock` helper integrated into all five call sites (`createReservation`, `updateReservation`, public create, slot hold,
  availability read).
- Conflict check works; availability reflects Google events.
- NO push yet.

**Phase 2 — Push**

- `CalendarSyncOutbox` worker.
- Hooks in `reservation.service` + `classSession.service`.
- `ReservationGoogleEventMapping`.
- ClassSession one-event-per-class semantics.
- Dead-letter UI.

**Phase 3 — Polish**

- Privacy detail-level UI.
- Health check cron.
- Pruning cron.
- Dashboard for connection status (`calendar:view_status` permission).

Each phase is independently shippable.

## 19. Production readiness checklist

- [ ] `GOOGLE_CALENDAR_TOKEN_KEY` env var set in production (32-byte hex), separate from `JWT_SECRET`.
- [ ] `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` set.
- [ ] OAuth consent screen submitted for Google verification (sensitive scope path).
- [ ] Webhook URL HTTPS-only, public, no auth (Google can't auth — relies on token in header).
- [ ] Module `GOOGLE_CALENDAR_SYNC` seeded via `scripts/setup-modules.ts`.
- [ ] Permissions added to `PERMISSION_CATALOG`.
- [ ] Cron jobs registered in server startup.
- [ ] RabbitMQ topics/queues declared (or auto-declared by consumer).
- [ ] Alerts wired: DEAD_LETTER outbox row count, channel renewal failure rate, webhook 401 rate, average pull lag.
- [ ] Runbook in `docs/` for on-call: "Google Calendar sync is behind" / "Customer reports double-booking via Google event".
- [ ] Load test: 100 venues × 5 staff × 100 events/calendar → measure pull throughput and DB load.

## 20. Cross-repo impact

| Repo | Phase 1 impact | Required for Phase 1 ship? |
|---|---|---|
| `avoqado-server` | All implementation lives here | ✅ — entire feature |
| `avoqado-web-dashboard` | UI to drive the 6 new endpoints (connect button, OAuth picker page, connections list with disconnect, calendar status badge) | ✅ — without it users have no way to connect a calendar |
| `avoqado-android` | Cosmetic only: Spanish error string for `external_calendar_busy` 409 in `ReservationApi.kt` | ❌ optional — without it staff using the Android app see raw JSON when they try to create a reservation over a synced Google event |
| `avoqado-tpv` (Android POS) | None — no reservation surface in TPV | ❌ — verified by audit |
| `avoqado-checkout` | None — e-commerce checkout, unrelated | ❌ |
| `avoqado-booking-widget` | None — consumes server `/availability`; server-side change is transparent | ❌ |

### `avoqado-web-dashboard` (REQUIRED — separate plan)

The 6 backend endpoints are useless without a UI to invoke them. The dashboard needs (minimum):

1. **OAuth init trigger** — a "Conectar Google Calendar" button in:
   - Venue Settings → Integraciones (gated by `calendar:manage_venue`).
   - "Mi perfil" → Calendarios (gated by `calendar:connect_self`).
   The button calls `GET /api/v1/google-calendar/oauth/init?intent={staff_personal|venue_master}`, receives a `{ url }` payload, and redirects the browser to Google.
2. **Picker page** at `/google-calendar/picker?session=<token>` — receives the redirect from `/oauth/callback`, calls `GET /api/v1/google-calendar/oauth/calendars?session=<token>`, renders the picker, and POSTs `{ session, selectedCalendarId }` to `/api/v1/google-calendar/connections`. Shows accessRole warning for read-only calendars on staff_personal intent.
3. **Connections list** — for each venue + the current staff: `GET /api/v1/google-calendar/connections` (renders email, calendar name, status, lastSyncedAt) with a "Disconnect" button calling `DELETE /api/v1/google-calendar/connections/:id`.
4. **Status badges** — show `TOKEN_REVOKED` / `CALENDAR_LOST` / `WATCH_FAILED` connections with a "Reconnect" CTA in venue/profile settings.
5. **Conflict-error UX** — when create/update reservation returns 409 with `errorCode: 'external_calendar_busy'`, show a friendly Spanish toast: "Este horario está bloqueado por un evento del calendario conectado."

Backend MUST ship first and soak before dashboard merges UI. While backend is live with no UI, only direct API consumers (e.g., Postman / curl) can connect calendars — which is fine for staged rollout.

### `avoqado-android` (OPTIONAL polish — separate ticket)

Per audit by Subagent 7, the Android staff app at `/Users/amieva/Documents/Programming/Avoqado/avoqado-android` has a full reservations module: calendar view (`presentation/calendar/`), create wizard (`CreateReservationViewModel.kt:226-244`), and the reservation list/detail/reschedule flows. It calls `GET /dashboard/venues/{v}/reservations/calendar` and `POST /dashboard/venues/{v}/reservations`.

**Risk:** when staff creates/updates a reservation via the Android wizard and the backend rejects with 409 `external_calendar_busy`, the app today shows raw JSON: `HTTP 409: {"errorCode":"external_calendar_busy",...}`. This is because `ReservationApi.kt:110-113` only special-cases 404; everything else falls to the generic `"HTTP $code: ${body.take(200)}"` branch.

**Fix (cosmetic):**

- Edit `app/src/main/java/com/avoqado/pos/reservations/data/ReservationApi.kt:110-113` to add a `409 ->` branch with a Spanish message (e.g., *"El horario está bloqueado por un evento del calendario"*).
- For better UX, parse the JSON body's `errorCode` field so other 409 reasons (e.g., regular double-booking) get distinct copy.
- Mirror the pattern in `ClassSessionApi.kt:98-104` which already does this for class endpoints.

**Phase 2 watch-out:** the app's JSON parser uses `ignoreUnknownKeys = true` (`ReservationApi.kt:33`) so new optional response fields are safe — BUT it does NOT use `coerceInputValues = true`. Any new enum value (e.g., a hypothetical `GOOGLE_CALENDAR` `ReservationChannel`) would crash deserialization. Phase 2 must avoid adding enum values to existing Reservation responses, OR the Android app must add coercion first.

**Phase 3 watch-out:** if you decide staff should be able to connect their personal Google Calendar from the Android app (not just the web dashboard), this is greenfield — the app has no OAuth/Google sign-in scaffolding today. Recommended: keep Google Calendar connect web-only.

### Compatibility rule (per `.claude/rules/critical-warnings.md`, Cross-Repo TPV)

No API response fields removed; all new fields optional with defaults. Backend ships first, soaks, then dashboard. The `avoqado-android` polish is independent and can land in any order after backend.

---

**Next step:** audit pass by independent LLM (Codex challenge mode or Gemini via auditoria-cambios agent) before promoting to implementation
plan via `writing-plans` skill.
