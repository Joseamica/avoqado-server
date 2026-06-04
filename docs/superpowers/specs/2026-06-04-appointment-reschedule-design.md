# Design Spec — Customer Self-Service Reschedule for Appointments

**Date:** 2026-06-04
**Status:** Draft (pending eng review)
**Repos:** `avoqado-server` (backend), `avoqado-booking-widget` (widget)
**Author:** Jose + Claude (brainstorming session)

---

## 1. Problem

Venues can enable `allowCustomerReschedule = true` in their reservation settings, and
the booking widget shows a **"Cambiar horario"** button on the customer's magic-link
manage screen (`book.avoqado.io/<slug>?manage=<cancelSecret>`).

Today that button only works for **class** reservations. For **appointments** (services
with a `productId` and no `classSessionId`), the backend hard-gates reschedule on
`!!classSessionId`, so the button is permanently disabled — and worse, it shows a
time-based tooltip ("puedes reagendar hasta N horas antes") even when the appointment is
days away, implying the customer is too late when the feature simply doesn't exist for
appointments.

**Discovered:** during the WhatsApp "Gestionar mi cita" live test (venue Amaena, which
has `allowCustomerReschedule = true`). Cancel works for appointments; reschedule does not.

## 2. Goal

Let a customer reschedule an **appointment** to a different date/time of the **same
service** via the magic link, with the same correctness guarantees as a fresh booking
(availability, pacing, overlap), no login required.

### Non-goals (v1, YAGNI)

- Changing the **service** during reschedule (cross-service = cancel + rebook).
- Changing party size / modifiers (duration is fixed = same service + same extras).
- Limiting the **number** of reschedules.
- A new WhatsApp template with a manage button for the reschedule confirmation (reuse the
  existing reschedule notification).

## 3. Decisions (confirmed with product owner)

| Decision | Choice |
|---|---|
| Scope | **Same service only** — move date/time, keep service + extras + duration. |
| Notification | **Yes** — WhatsApp + email of the new time (reuse existing senders). |
| Slot race | **Hold of 10 min** (reuse `SlotHold`, like booking) + countdown. |
| MCP | **Yes** — add a `reschedule_reservation` MCP tool. |
| Endpoint shape | **Approach A** — reschedule sub-endpoints scoped by `cancelSecret`, self-exclusion done server-side. |

## 4. Architecture

The reservation being moved must **not count against the availability/pacing of the new
slot** (otherwise a customer can't move to an adjacent slot, and a `pacingMaxPerSlot = 1`
venue like Amaena would block itself). All three steps — availability, hold, confirm —
exclude the current reservation, resolved server-side from the `cancelSecret`.

```
Customer (magic link, no login)
  │  GET …/:cancelSecret/reschedule/availability?date=YYYY-MM-DD   → slots (excl. self)
  │  POST …/:cancelSecret/reschedule/hold  { startsAt, endsAt }    → { holdId, expiresAt }
  │  POST …/:cancelSecret/reschedule       { startsAt, holdId }    → moved + notified
  ▼
avoqado-server (public controller → service → Prisma, serializable)
```

## 5. Backend changes (`avoqado-server`)

### 5.1 Shared plumbing — self-exclusion

Add an optional `excludeReservationId?: string` parameter to:

- **`getAvailableSlots()`** (`src/services/dashboard/reservationAvailability.service.ts`):
  the active-reservations query that computes per-slot occupancy adds
  `AND id != excludeReservationId`.
- **`countAppointmentOccupancy()`** (used by `createHold` and the appointment create
  pacing guard, `src/controllers/public/reservation.public.controller.ts`): same exclusion
  in the reservations count.

Both default to no exclusion (existing callers unchanged).

### 5.2 GET reservation — enable reschedule for appointments

In `src/controllers/public/reservation.public.controller.ts`, the `reschedule.allowed`
computation (currently requires `!!classSessionId`) becomes type-aware:

```ts
reschedule: {
  allowed:
    settings.cancellation.allowCustomerReschedule &&
    (reservation.status === 'CONFIRMED' || reservation.status === 'PENDING') &&
    isWithinWindow(reservation.startsAt, settings.cancellation.minHoursBeforeStart),
  // type tells the widget which mini-flow to run
  kind: (reservation as any).classSessionId ? 'class' : 'appointment',
  minHoursBeforeStart: settings.cancellation.minHoursBeforeStart,
  productId: (reservation as any).productId ?? null,
}
```

`kind` is a new, additive field (old clients ignore it; never remove existing fields).

### 5.3 New routes (`src/routes/public.routes.ts`)

| Method | Path | Limiter | Controller |
|---|---|---|---|
| `GET` | `/venues/:venueSlug/reservations/:cancelSecret/reschedule/availability` | readLimit | `getRescheduleAvailability` |
| `POST` | `/venues/:venueSlug/reservations/:cancelSecret/reschedule/hold` | writeLimit | `createRescheduleHold` |
| `POST` | `/venues/:venueSlug/reservations/:cancelSecret/reschedule` (extend) | cancelLimit | `rescheduleReservation` (branch) |
| `DELETE` | `/venues/:venueSlug/reservations/hold/:holdId` (reuse existing) | cancelLimit | existing `releaseHold` |

Each new handler first runs the **reschedule guard**: resolve reservation by
`cancelSecret`, then assert `allowCustomerReschedule` + within window + status
CONFIRMED/PENDING. Extracted into a helper `assertCanReschedule(reservation, settings)`
reused by all three.

### 5.4 New controllers (`reservation.public.controller.ts`)

- **`getRescheduleAvailability`**: guard → call `getAvailableSlots` for the reservation's
  `productId` on `?date`, passing `excludeReservationId = reservation.id`. Return `{ slots }`.
- **`createRescheduleHold`**: guard → **re-validate the requested slot is genuinely
  offerable** (see §5.8) → reuse the existing hold-creation path with
  `excludeReservationId = reservation.id` (advisory lock + pacing count excl. self) →
  return `{ holdId, expiresAt }`.
- **`rescheduleReservation`** (extend): after the existing guard, branch on reservation type:
  - **class** (`classSessionId` present): existing behavior (`classSessionId`, `spotIds`).
  - **appointment**: require `{ startsAt, holdId }`. Compute
    `newEndsAt = newStartsAt + reservation.duration` (authoritative — ignore any client
    `endsAt`). Call `rescheduleAppointmentReservation(...)`.

### 5.5 New service `rescheduleAppointmentReservation()` (`reservation.dashboard.service.ts`)

Mirrors `rescheduleClassReservation`. Steps:

Signature: `rescheduleAppointmentReservation({ venueId, reservationId, newStartsAt, holdId?, rescheduledBy })`.

1. Load reservation; assert appointment (`!classSessionId`) + status CONFIRMED/PENDING.
2. **Pacing protection (one of two paths):**
   - **Customer path (`holdId` present):** validate hold — exists, not expired,
     `startsAt`/`endsAt` match the requested move. Pacing is already protected because the
     hold reserved the slot at creation (counted in everyone's occupancy).
   - **Ops/MCP path (`holdId` absent):** re-check pacing inline via
     `countAppointmentOccupancy({ startsAt, endsAt, excludeReservationId: reservationId })`
     and throw 409 if `reservations + holds >= effectivePacing`.
3. `newEndsAt = newStartsAt + reservation.duration` (minutes).
4. Call existing `updateReservation(venueId, reservationId, { startsAt, endsAt, duration }, rescheduledBy)`
   — already runs a serializable tx with table/staff/capacity overlap checks that
   **exclude self** (`id <> reservationId`) and enqueues the Google Calendar `UPDATE`
   outbox op.
5. Delete the hold if one was used (best-effort).
6. `logAction('RESERVATION_RESCHEDULED', { entity: 'Reservation', staffId: 'CUSTOMER'→null sentinel, data: { startsAt, endsAt, by: 'CUSTOMER' } })`.
7. Notify (§5.6).
8. Return `{ confirmationCode, status, startsAt, endsAt }`.

> Note: `'CUSTOMER'` is normalized to `null` staffId via the existing `ACTOR_SENTINELS`
> set in `activity-log.service.ts` (avoids the FK violation we fixed earlier).

### 5.6 Notifications

Best-effort, after a successful move (reuse existing senders used by the staff path):

- `sendReservationRescheduleWhatsApp(phone, { customerName, venueName, date, time })`
- `emailService.sendReservationRescheduledEmail(email, { customerName, venueName, serviceName, oldDateTime, newDateTime, confirmationCode })`

Wrapped in try/catch with `logger.warn` on failure — a notification failure never fails the
reschedule.

### 5.7 MCP tool (`src/mcp/tools/reservations.ts`)

Add `reschedule_reservation`:

- **Input:** `{ venueId, confirmationCode, newStartsAt (ISO) }` (resolve reservation by
  confirmationCode within the scoped venue).
- **Behavior:** appointment → `rescheduleAppointmentReservation({ ..., holdId: undefined, rescheduledBy: '<mcp-actor>' })`
  — the ops/agent path skips the hold and re-validates pacing inline (§5.5 path 2) +
  overlap via `updateReservation`; class → out of scope for the tool v1 (return a clear
  "use the dashboard for class reschedule" message).
- **Scope guard:** `venueFilter(venueId)` (same RBAC as the read tool).
- Register in the tool list so it ships with the MCP server.

### 5.8 Slot re-validation (server-side, decided in eng review — D1)

**Problem:** the widget only surfaces valid slots, but a client calling the API directly
could hold/reschedule to an invalid time (3am, past `maxAdvanceDays`, off-grid, under
`minNoticeMin`). `createHold` alone does not check operating hours / window / grid.

**Fix (single source of truth):** add a helper `assertSlotOfferable(venueId, productId,
{ startsAt, endsAt }, excludeReservationId)` that calls `getAvailableSlots` for that date
(excluding self) and asserts the requested `{ startsAt, endsAt }` is in the returned set.
This reuses the booking availability engine, so operating hours, `slotIntervalMin`,
`minNoticeMin`, `maxAdvanceDays`, pacing and capacity are all enforced from one place — no
duplicated rules.

- Called in **`createRescheduleHold`** (primary gate, before the hold is written).
- Called again in the **confirm** path inside `rescheduleAppointmentReservation` for the
  ops/MCP route (no hold) and as a cheap re-check of `minHoursBeforeStart`/`minNoticeMin`
  on the customer route (time may have advanced during the 10-min hold). On failure → 409
  "Ese horario ya no está disponible, elige otro."

## 6. Widget changes (`avoqado-booking-widget`)

### 6.1 API client (`src/api/booking.ts`)

```ts
getRescheduleAvailability(slug, cancelSecret, { date }): Promise<{ slots: PublicSlot[] }>
createRescheduleHold(slug, cancelSecret, { startsAt, endsAt }): Promise<{ holdId, expiresAt }>
rescheduleAppointment(slug, cancelSecret, { startsAt, holdId }): Promise<RescheduleResult>
// releaseHold(slug, holdId) already exists — reuse for cancel/timeout.
```

### 6.2 `RescheduleFlow.tsx` — branch by `reservation.reschedule.kind`

- **`kind === 'class'`**: existing flow untouched.
- **`kind === 'appointment'`**:
  - Steps: `date → time → confirm` (no `seat`).
  - On date pick → `getRescheduleAvailability` (not the generic availability).
  - On time pick → `createRescheduleHold` → store `{ holdId, expiresAt }` → start a 10-min
    countdown → go to `confirm`.
  - `confirm` step: show old → new summary + countdown + "Confirmar cambio" →
    `rescheduleAppointment({ startsAt, holdId })` → `onSuccess()`.
  - Back / cancel / countdown-expiry → `releaseHold(holdId)` + reset to `date`.
  - 409 on confirm ("slot taken / hold expired") → release, show inline error, send back to
    `date` to pick again.

### 6.3 i18n

Add keys (en + es; fr if namespace exists): `reschedule.confirmStep`, `reschedule.holdCountdown`,
`reschedule.holdExpired`, `reschedule.confirmButton`, `reschedule.slotTakenError`. No hardcoded
strings.

### 6.4 Manage screen tooltip fix

The disabled-tooltip path already keys off `reschedule.allowed`; once appointments return
`allowed: true` when eligible, the misleading tooltip disappears for them. (No separate fix
needed beyond §5.2.)

## 7. Error handling

| Condition | HTTP | Customer message |
|---|---|---|
| Venue disallows reschedule | 400 | "Este negocio no permite cambiar horarios en línea." |
| Outside window | 400 | "No puedes cambiar el horario con menos de N horas de anticipación." |
| Status not CONFIRMED/PENDING | 400 | "Esta reservación ya no se puede cambiar." |
| Class endpoint hit for appointment or vice-versa | 400 | type-specific message |
| Hold expired / slot taken | 409 | "Ese horario ya no está disponible, elige otro." |
| Reservation not found | 404 | generic not-found |

All Zod messages in Spanish (project rule); shape/format only in Zod, business rules in the
service/controller.

## 8. Testing

**Backend (Jest):**
- `rescheduleAppointmentReservation`: success moves times + keeps duration; rejects
  class reservation; rejects bad status; 409 on expired hold; 409 when slot taken by
  another active reservation.
- Self-exclusion: `getAvailableSlots` with `excludeReservationId` returns the slot the
  reservation currently occupies; `countAppointmentOccupancy` doesn't count self.
- **Slot re-validation (§5.8):** `assertSlotOfferable` rejects an off-grid time, a time
  past `maxAdvanceDays`, a time under `minNoticeMin`, and a time outside operating hours —
  i.e. a direct-API reschedule to an invalid slot returns 409, not a silent move.
- **REGRESSION (CRITICAL — IRON RULE):** class reschedule still works end to end after the
  appointment branch is added — `rescheduleClassReservation` path unchanged, controller
  still routes `classSessionId` bodies to it, response shape identical. This proves the new
  branch didn't break the existing class flow.
- Controller branch: appointment vs class routing; guard rejects out-of-window.
- MCP tool: reschedule by confirmationCode within scope; rejects cross-venue.

**Widget:** no test infra (no Vitest) → manual verification against a real staging/prod
reservation via the magic link (same method used to verify the deep-link fix), plus
`vite build` must pass.

## 9. Rollout / compatibility

- Additive only: new routes, new optional params, new `kind` field. No existing API field
  removed or renamed (old widget builds keep working; reschedule button stays disabled for
  them until the new widget deploys).
- Deploy order: backend (`avoqado-server`) → then widget (`avoqado-booking-widget`,
  Cloudflare Pages on push to `main`). Widget calls degrade gracefully if backend not yet
  deployed (button stays disabled because `allowed` still requires backend support).
- MCP tool ships with the backend deploy (CLAUDE.md "MCP in sync" rule).

## 10. Open questions

- None blocking. (Possible future: include a manage-button in the reschedule WhatsApp
  template; cross-service reschedule; reschedule count limit.)

## 11. Implementation Tasks
Synthesized from the eng review. P1 blocks ship, P2 same-branch, P3 follow-up.

- [ ] **T1 (P1, human: ~2h / CC: ~20min)** — backend — Add `excludeReservationId` to `getAvailableSlots` + `countAppointmentOccupancy`
  - Surfaced by: Architecture — self must not count against its own new slot
  - Files: `src/services/dashboard/reservationAvailability.service.ts`, `src/controllers/public/reservation.public.controller.ts`
  - Verify: unit test — self's current slot appears as offerable
- [ ] **T2 (P1, human: ~1h / CC: ~15min)** — backend — `assertSlotOfferable` helper (§5.8) + wire into `createRescheduleHold` and confirm
  - Surfaced by: Architecture D1 — direct-API reschedule to invalid time
  - Files: `reservation.public.controller.ts`
  - Verify: unit test — off-grid / past-maxAdvance / under-minNotice → 409
- [ ] **T3 (P1, human: ~2h / CC: ~20min)** — backend — `rescheduleAppointmentReservation` service (hold + non-hold paths) + GET `reschedule.allowed`/`kind` for appointments
  - Surfaced by: core feature
  - Files: `reservation.dashboard.service.ts`, `reservation.public.controller.ts`
  - Verify: unit tests (success, expired hold→409, slot taken→409, bad status→400)
- [ ] **T4 (P1, human: ~1h / CC: ~15min)** — backend — 3 routes + Zod schema (Spanish messages) + controllers (`getRescheduleAvailability`, `createRescheduleHold`, extend `rescheduleReservation` branch) + `assertCanReschedule` helper
  - Files: `src/routes/public.routes.ts`, `src/schemas/dashboard/reservation.schema.ts`, `reservation.public.controller.ts`
  - Verify: controller branch test (appointment vs class)
- [ ] **T5 (P1, human: ~30min / CC: ~10min)** — backend — REGRESSION test: class reschedule still works after the branch
  - Surfaced by: Test review (IRON RULE)
  - Verify: existing class reschedule path green
- [ ] **T6 (P2, human: ~3h / CC: ~30min)** — widget — `RescheduleFlow` appointment branch (date→time→hold+countdown→confirm) + 3 API client fns + i18n (en/es/fr)
  - Files: `src/components/RescheduleFlow.tsx`, `src/api/booking.ts`, `src/types.ts`, `src/i18n/*`
  - Verify: `vite build` + manual deep-link test against staging reservation; class flow still works
- [ ] **T7 (P2, human: ~1h / CC: ~15min)** — backend — MCP `reschedule_reservation` tool + register
  - Files: `src/mcp/tools/reservations.ts`
  - Verify: unit test (in-scope ok, cross-venue rejected)
- [ ] **T8 (P2, human: ~20min / CC: ~5min)** — both — Notifications wired (WhatsApp + email, best-effort) on successful move
  - Files: `reservation.dashboard.service.ts`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (scope set in brainstorming) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 1 P1 architecture finding (slot validation) resolved → D1=A; class-reschedule regression test added (IRON RULE); self-exclusion + perf reviewed, no further issues |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | optional (widget reuses existing DatePicker/TimeSlotPicker UI) |
| Outside Voice | `/codex` | Independent 2nd opinion | 0 | — | skipped |

- **Step 0 scope:** accepted (layering, not creep; scope set in brainstorming).
- **Critical gaps:** 0 (the slot-validation gap was caught and closed via §5.8).
- **UNRESOLVED:** none.
- **VERDICT:** ENG CLEARED — ready to implement. Deploy backend → widget; MCP ships with backend.
