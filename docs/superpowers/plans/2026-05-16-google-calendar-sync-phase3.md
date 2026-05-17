# Google Calendar Sync — Phase 3 Implementation Plan (UI Polish)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Spec:** `docs/superpowers/specs/2026-05-15-google-calendar-sync-design.md` (v1.6) — §17 (future work) **Phase 1 status:** ✅ shipped +
deployed **Phase 2 status:** ✅ implemented (uncommitted)

**Goal:** UI polish so connected Google Calendar events appear visually in the dashboard's reservation calendar, plus dead-letter outbox
banner, connection-status dashboard improvements, and privacy preview.

**User decision lock-ins from Phase 2:**

- Detail level default = **FULL** (cliente + servicio visibles).

---

## Scope (4 deliverables)

### 1. Visual overlay — Google events appear in dashboard calendar

**What user noticed missing in Phase 1:** their Google events don't render in the Avoqado reservation calendar. Phase 3 fixes this.

**Backend:**

- New endpoint `GET /api/v1/dashboard/venues/:venueId/google-calendar/busy-blocks?from=<ISO>&to=<ISO>&staffId=<opt>` — returns
  `ExternalBusyBlock` rows scoped to the requested range + (optional) staff filter, OR-ed with venue-master blocks.
- Permission gate: `calendar:view_status` minimum.
- Response shape: `{ blocks: [{ id, startsAt, endsAt, allDay, title, isPrivate, source: 'GOOGLE', connectionId }] }`.

**Frontend (avoqado-web-dashboard):**

- Modify `src/pages/Reservations/ReservationCalendar.tsx` — query the new endpoint, render `ExternalBusyBlock` rows as visually-distinct
  events (gray/hatched background, "Bloqueo de Google" label, no click action).
- Toggle in calendar header: "Mostrar bloqueos de Google" (on by default; persist preference in localStorage).
- If `isPrivate=true`, render as "Ocupado" without leaking the title (privacy default).
- Hover tooltip shows source ("Google Calendar - juan@gmail.com").

### 2. Connection-status dashboard

**Backend:**

- Existing `GET /api/v1/google-calendar/connections` returns list. Already done in Phase 1.
- New: per-connection detail endpoint `GET /api/v1/google-calendar/connections/:id` with extra fields: `lastSyncedAt`, `statusReason`,
  `channel.expiresAt`, `pendingOutboxCount`, `deadLetterCount`. Permission: `calendar:view_status`.

**Frontend:**

- New page or section: connection-status detail accessible from the cards in Reservation Settings + Account.
- Show status badge with color (CONNECTED=green, TOKEN_REVOKED/CALENDAR_LOST/WATCH_FAILED=red), last sync time, pending/dead-letter counts,
  "Reconectar" CTA for non-CONNECTED states.

### 3. Dead-letter outbox banner

**Backend:**

- New endpoint `GET /api/v1/dashboard/venues/:venueId/google-calendar/outbox/dead-letter` — list of DEAD_LETTER rows with reservation/class
  context. Permission: `calendar:view_status`.
- New endpoint `POST /api/v1/dashboard/venues/:venueId/google-calendar/outbox/:rowId/retry` — reset row to PENDING (status='PENDING',
  attempts=0, scheduledAt=NOW, lastError=null) for sweeper to pick up. Permission: `calendar:manage_venue`.

**Frontend:**

- Banner in Reservation Settings (and/or sidebar): "X reservaciones no se pudieron sincronizar a Google Calendar. [Ver detalles]"
- Detail modal: table of dead-letter rows with reservation date, error message, "Reintentar" button per row.

### 4. Privacy detail-level preview UI

**Frontend only — backend already has the field.**

In ReservationSettings page, add a section "Privacidad del evento en Google Calendar" with:

- Radio group: MINIMAL / SERVICE / FULL (current value from `ReservationSettings.googleCalendarEventDetailLevel`).
- Live preview pane: shows a mock Google Calendar event card with the selected detail level applied (using a real-looking reservation as
  sample data).
- Warning chip on FULL: "El nombre del cliente y notas serán visibles en widgets de teléfono, calendarios compartidos y backups."
- Save button calls existing settings update mutation.

---

## Subagent breakdown (2 subagents)

### Subagent A — Backend Phase 3 endpoints (small)

3 new endpoints in `avoqado-server`:

1. `GET /api/v1/dashboard/venues/:venueId/google-calendar/busy-blocks` (date range query)
2. `GET /api/v1/dashboard/venues/:venueId/google-calendar/outbox/dead-letter` (list)
3. `POST /api/v1/dashboard/venues/:venueId/google-calendar/outbox/:rowId/retry` (reset to PENDING)

Plus enhance `GET /api/v1/google-calendar/connections/:id` (or add it if doesn't exist).

Permission gates per the matrix above.

Tests: unit + API integration tests for each.

### Subagent B — Frontend Phase 3 UI (avoqado-web-dashboard)

4 deliverables per above. Modifies:

- `src/pages/Reservations/ReservationCalendar.tsx` — overlay rendering
- `src/pages/Reservations/ReservationSettings.tsx` — privacy preview section + dead-letter banner
- `src/pages/Account/Account.tsx` — connection detail view (optional, may consolidate with Settings)
- New: `src/services/googleCalendar.service.ts` — add the 3 new endpoint wrappers
- Locale files for new strings

---

## Out of scope (deferred to Phase 4 or post-MVP)

- Real-time updates of `ExternalBusyBlock` overlay via Socket.io (currently polls; works fine since blocks update via cron/webhook anyway)
- Per-connection bulk-retry of dead-letter (only per-row retry in Phase 3; bulk if user demand)
- Per-staff visibility filters in calendar overlay (Phase 4 if needed for multi-staff venues)
- The Google OAuth verification submission (separate workstream, requires marketing assets)
- Orphan-mapping cleanup on staff reassignment (Phase 2's `// TODO Phase 3`)

---

## Definition of done

1. All 4 deliverables shipping end-to-end (user can see Google events in their calendar, see dead-letter banner if push fails, change
   privacy level with live preview, see connection status).
2. Build clean (both repos).
3. Tests passing.
4. No commits — user owns commits.
