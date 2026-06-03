# Subscription Lifecycle Emails (Phase 1.5) — Design

> **Status:** Approved design, pending implementation plan.
> **Builds on:** `docs/superpowers/specs/2026-06-02-venue-base-subscription-design.md` (PLAN_PRO base subscription).

## Goal

Complete the email/notification layer around the PLAN_PRO base subscription so a venue gets the right
message at every lifecycle moment: welcome, trial-ending, renewal, payment problems, suspension,
cancellation, and a win-back nudge. Most of the lifecycle already exists and fires; this phase fills the
gaps, fixes the recipient, and makes the subscription emails bilingual.

## Context: what already exists (verified)

`emailService` already has these methods, **already wired** to Stripe webhooks / crons, and they fire for
PLAN_PRO because it is a generic `VenueFeature` with a Stripe subscription:

| Email | Trigger (existing) | Status |
| --- | --- | --- |
| Trial ending soon | webhook `customer.subscription.trial_will_end` → `handleSubscriptionTrialWillEnd` → `sendTrialEndingEmail` | ✅ exists |
| Payment failed (dunning, attempts 1/2/3 = day 0/3/5) | webhook `invoice.payment_failed` → `handlePaymentFailure` → `sendPaymentFailedEmail` | ✅ exists |
| Subscription suspended | `stripe.service.ts` suspension flow → `sendSubscriptionSuspendedEmail` | ✅ exists |
| Subscription canceled | `subscription-cancellation.job.ts` → `sendSubscriptionCanceledEmail` | ✅ exists |
| Trial expired | `subscription-cancellation.job.ts` → `sendTrialExpiredEmail` | ✅ exists |

**Two problems with the existing 5:**
1. **Recipient:** they send to `venue.organization.email` (or `staff.email`). Onboarding fills `venue.email`,
   not necessarily `org.email` → for new PLAN_PRO venues the email can silently have no recipient.
2. **Language:** they are Spanish-only (no locale parameter).

## Decisions (confirmed with product owner)

- **Confirmation email:** sent on activation for **both** paths — trial start **and** pay-now.
- **Renewal reminder:** **monthly and annual**, **3 days before** each recurring charge.
- **Win-back:** sent **~3 days after suspension**, offering a **new, more aggressive** coupon =
  **first month free** (`WINBACK_FIRST_MONTH_FREE`, 100% off, `duration: once`). **Monthly only** — an
  annual reactivation pays standard price (annual churn is rare). Rationale follows the standard B2B SaaS
  playbook: dunning recovers involuntary (failed-card) churn with no discount; the win-back is the
  escalation for those who truly left.
- **Language:** **bilingual es/en**, including a retrofit of the 5 existing subscription emails.
- **Recipient:** normalized for all plan emails.

## Locale source (new)

Neither `Venue`, `Staff`, nor `Organization` has a language field today. Add one:

- **Migration:** `Venue.language String @default("es")`.
- **Populate:** the V2 onboarding wizard already has an es/en selector; on completion the frontend sends its
  active i18n locale, persisted to `Venue.language`. Absent → `"es"`.
- Every plan email resolves its language from `Venue.language`.

## Architecture

### 0. Shared resolver — `resolvePlanNotificationTarget(venueId)`

New helper (e.g., `src/services/access/planNotification.service.ts` or alongside `email.service`):

```
resolvePlanNotificationTarget(venueId) → {
  email: string | null,   // venue.email → owner StaffVenue's Staff.email → org.email (first non-null)
  locale: 'es' | 'en',    // venue.language, default 'es'
  venueName: string,
  ownerName: string | null,
}
```

- Owner email: `StaffVenue` where `role = 'OWNER'` (fallback `ADMIN`) → `Staff.email`.
- If `email` is null, the caller logs a warning and skips (never throws — emails are non-blocking).
- Used by the 3 new emails **and** the 5 retrofit emails.

### 1. New emails (bilingual)

Each new `emailService` method takes `(target, data)` where `data` carries `locale`. Templates follow the
Avoqado inventory standard (white bg, black `#000000` CTAs, logo header+footer, no emoji in subject) per
`.claude/rules/email-templates.md`, with es + en bodies selected by `locale`.

| Method | Trigger | Content (es/en) |
| --- | --- | --- |
| `sendPlanConfirmationEmail` | **Direct call in `completeV2Onboarding`** right after `createPlanSubscription` succeeds. Variant by `payNow`. | Trial: "Tu prueba de 30 días empezó · primer cobro $1,158.84 el {trialEnd}". Pay-now: "¡Gracias! Pagaste $694.84 (3 meses a $599+IVA), luego $1,158.84/mes". |
| `sendPlanRenewalReminderEmail` | **New cron** `plan-renewal-reminder.job.ts` (daily). | "Tu plan Avoqado Pro se renueva el {date} por ${amount}." Monthly + annual. |
| `sendPlanWinbackEmail` | **New cron** `plan-winback.job.ts` (daily). | "Vuelve a Avoqado Pro — tu primer mes es gratis" + billing/reactivation link + coupon. |

### 2. New crons (`src/jobs/`)

Both follow the cron rule: wrap the entry DB read with `retry(..., shouldRetryDbConnectionError)` (no global
Prisma retry); idempotent; non-blocking per-venue (one failure doesn't abort the batch).

- **`plan-renewal-reminder.job.ts`** — daily. For each active PLAN_PRO `VenueFeature` with a Stripe sub,
  read the sub's `current_period_end`; if it falls in ~3 days and a reminder wasn't already sent this period,
  send `sendPlanRenewalReminderEmail` and stamp `VenueFeature.renewalReminderSentAt`. (Cron, not
  `invoice.upcoming` webhook, so the "3 days" is deterministic.)
- **`plan-winback.job.ts`** — daily. For each PLAN_PRO `VenueFeature` with `suspendedAt` ~3 days ago and
  `winbackSentAt` null, send `sendPlanWinbackEmail` with the win-back coupon and stamp `winbackSentAt`.

### 3. Retrofit the 5 existing emails

For `sendTrialEndingEmail`, `sendPaymentFailedEmail`, `sendSubscriptionSuspendedEmail`,
`sendSubscriptionCanceledEmail`, `sendTrialExpiredEmail`:
- Switch the recipient to `resolvePlanNotificationTarget(venueId).email`.
- Add a `locale` parameter (default `'es'` for backward compatibility with the old à-la-carte Feature
  callers) and add the `en` body. Callers that resolve a PLAN_PRO venue pass the venue's locale.

### 4. Win-back coupon (seed)

Add to `scripts/seed-plan-pro.ts`: coupon `WINBACK_FIRST_MONTH_FREE` (`percent_off: 100`, `duration: once`),
created/reconciled idempotently like `INTRO_PRO_3M`. The win-back email references it; reactivation applies it
to the monthly price.

### 5. Migration

One migration adds:
- `Venue.language String @default("es")`
- `VenueFeature.renewalReminderSentAt DateTime?`
- `VenueFeature.winbackSentAt DateTime?`

(Fields, not models → no `MODEL_TO_DOMAIN` / `schema:map` update needed.)

## Edge cases

- **No recipient:** resolver returns null email → log warning, skip send (non-blocking).
- **Re-send guards:** `renewalReminderSentAt` reset/compared per billing period; `winbackSentAt` set once
  (don't nag a venue repeatedly).
- **Win-back after reactivation:** if the venue already reactivated (`suspendedAt` cleared / plan active),
  the cron skips it.
- **Annual win-back:** no coupon; the email still invites reactivation at standard annual price.
- **Idempotent crons:** safe to run repeatedly; stamps prevent duplicates.
- **Money:** amounts shown are gross IVA-inclusive (matches the Stripe price); formatted via `Intl.NumberFormat`.

## Testing

- Unit: `resolvePlanNotificationTarget` (venue.email / owner-fallback / org fallback / null; locale es/en).
- Unit: each new email method renders es and en, correct subject, no emoji in subject.
- Unit: renewal cron selects only subs renewing in ~3 days and respects `renewalReminderSentAt`.
- Unit: win-back cron selects only `suspendedAt ≈ -3d & winbackSentAt null`, skips reactivated.
- Unit: `completeV2Onboarding` calls `sendPlanConfirmationEmail` (trial vs pay-now variant) and never throws.
- Regression: retrofit emails still send for the old à-la-carte Feature callers (default `es`, recipient fallback).

## Out of scope (later)

- Multi-touch win-back sequences / A-B testing of offers.
- CFDI/factura generation.
- SMS/WhatsApp notifications.
- In-app notification redesign (the existing `createNotification` path stays as-is).
- Retrofitting non-subscription emails to bilingual.
