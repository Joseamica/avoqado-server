# Subscription Lifecycle Emails (Phase 1.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing subscription-lifecycle emails (confirmation, renewal reminder, win-back) and fix/retrofit the 5 existing ones to use a correct recipient and bilingual (es/en) bodies, for the PLAN_PRO base subscription.

**Architecture:** A shared `resolvePlanNotificationTarget(venueId)` resolves recipient + locale for every plan email. Three new bilingual `emailService` methods cover the gaps; one is called directly from `completeV2Onboarding`, the other two are driven by two new daily crons. The 5 existing methods are retrofitted to take the resolver's recipient + a `locale` param. A new `Venue.language` field (populated from the wizard's locale) is the locale source.

**Tech Stack:** Express + TypeScript, Prisma/PostgreSQL, Stripe SDK, Resend (via `emailService.sendEmail`), `cron` (CronJob), Jest (`--runInBand`).

---

## ⚠️ EXECUTION CONSTRAINTS (read first)

- **NO git commits during execution.** Other LLMs commit in parallel on `develop`. Leave every change **uncommitted** in the working tree; the user commits thematically afterward (as in Phase 1). Wherever a normal plan would "commit", instead just **verify tests pass and move on**.
- **Work on `develop`.** No new branches. Never stage/modify files outside this plan's scope (other LLMs' WIP).
- **Tests run with `--runInBand`** (the suite OOMs otherwise): `npx jest <path> --runInBand`.
- **Money = `Prisma.Decimal`** for any DB writes; never float.
- **Emails are non-blocking:** on a null recipient, `logger.warn` + return; never throw. Wrap every send call site in try/catch so a Stripe/email hiccup never breaks onboarding or a cron batch.
- After editing TS: `npm run format && npm run lint:fix` is the repo norm, but **do not run repo-wide `lint:fix`/`format`** (it mutates other LLMs' WIP). Format only the files you created/edited: `npx prettier --write <files>`.

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` (modify) | Add `Venue.language`, `VenueFeature.renewalReminderSentAt`, `VenueFeature.winbackSentAt` |
| `prisma/migrations/<ts>_subscription_email_fields/` (create) | The migration |
| `src/services/access/planNotification.service.ts` (create) | `resolvePlanNotificationTarget(venueId)` |
| `src/services/email.service.ts` (modify) | 3 new methods + `locale` param on 5 existing |
| `src/jobs/plan-renewal-reminder.job.ts` (create) | Daily renewal-reminder cron |
| `src/jobs/plan-winback.job.ts` (create) | Daily win-back cron |
| `src/server.ts` (modify) | Register + start the 2 new crons |
| `src/controllers/onboarding.controller.ts` (modify) | Call `sendPlanConfirmationEmail` in `completeV2Onboarding`; persist `Venue.language` |
| `scripts/seed-plan-pro.ts` (modify) | Add `WINBACK_FIRST_MONTH_FREE` coupon |
| `avoqado-web-dashboard/src/pages/Setup/SetupWizard.tsx` (modify) | Send `i18n.language` on completion |
| `tests/unit/services/access/planNotification.test.ts` (create) | Resolver tests |
| `tests/unit/services/email/planEmails.test.ts` (create) | New email method tests |
| `tests/unit/jobs/plan-renewal-reminder.test.ts` (create) | Renewal cron tests |
| `tests/unit/jobs/plan-winback.test.ts` (create) | Win-back cron tests |
| `tests/unit/controllers/completeV2.confirmationEmail.test.ts` (create) | Confirmation-call test |

---

## Task 1: Migration — locale + cron dedup fields

**Files:**
- Modify: `prisma/schema.prisma` (Venue model ~108-458; VenueFeature model — find with `grep -n "model VenueFeature" prisma/schema.prisma`)
- Create: `prisma/migrations/<timestamp>_subscription_email_fields/migration.sql` (via `prisma migrate dev`)

- [ ] **Step 1: Add fields to schema.prisma**

In `model Venue { ... }` add (near other scalar prefs):
```prisma
  language String @default("es") // locale for transactional emails (es|en), set from onboarding wizard
```
In `model VenueFeature { ... }` add:
```prisma
  renewalReminderSentAt DateTime? // last renewal-reminder email sent (cron dedup, per billing period)
  winbackSentAt         DateTime? // win-back email sent once after suspension (cron dedup)
```

- [ ] **Step 2: Create the migration (NEVER `db push`)**

Run: `npx prisma migrate dev --name subscription_email_fields`
Expected: migration created + applied; `npx prisma generate` runs. (These are enum-less scalar fields → no `MODEL_TO_DOMAIN`/`schema:map` update needed.)

- [ ] **Step 3: Verify** `npx tsc --noEmit` passes (Prisma Client types regenerated).

---

## Task 2: `resolvePlanNotificationTarget` helper

**Files:**
- Create: `src/services/access/planNotification.service.ts`
- Test: `tests/unit/services/access/planNotification.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { resolvePlanNotificationTarget } from '../../../../src/services/access/planNotification.service'
import prisma from '../../../../src/utils/prismaClient'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn() } },
}))

const mockVenue = (overrides: any) => (prisma.venue.findUnique as jest.Mock).mockResolvedValueOnce(overrides)

describe('resolvePlanNotificationTarget', () => {
  it('prefers venue.email and reads venue.language', async () => {
    mockVenue({ id: 'v1', name: 'Bar', email: 'bar@x.com', language: 'en',
      organization: { email: 'org@x.com' }, staffVenues: [] })
    expect(await resolvePlanNotificationTarget('v1')).toEqual({
      email: 'bar@x.com', locale: 'en', venueName: 'Bar', ownerName: null })
  })
  it('falls back to owner Staff email, defaults locale to es', async () => {
    mockVenue({ id: 'v1', name: 'Bar', email: null, language: 'es',
      organization: { email: null }, staffVenues: [{ staff: { email: 'owner@x.com', firstName: 'Ana', lastName: 'P' } }] })
    const t = await resolvePlanNotificationTarget('v1')
    expect(t.email).toBe('owner@x.com'); expect(t.locale).toBe('es'); expect(t.ownerName).toBe('Ana P')
  })
  it('falls back to org.email when no venue/owner email', async () => {
    mockVenue({ id: 'v1', name: 'Bar', email: null, language: 'es',
      organization: { email: 'org@x.com' }, staffVenues: [] })
    expect((await resolvePlanNotificationTarget('v1')).email).toBe('org@x.com')
  })
  it('returns null email when nothing available', async () => {
    mockVenue({ id: 'v1', name: 'Bar', email: null, language: 'es', organization: { email: null }, staffVenues: [] })
    expect((await resolvePlanNotificationTarget('v1')).email).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, verify it fails** — `npx jest tests/unit/services/access/planNotification.test.ts --runInBand` → FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
import prisma from '../../utils/prismaClient'

export interface PlanNotificationTarget {
  email: string | null
  locale: 'es' | 'en'
  venueName: string
  ownerName: string | null
}

export async function resolvePlanNotificationTarget(venueId: string): Promise<PlanNotificationTarget> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      name: true,
      email: true,
      language: true,
      organization: { select: { email: true } },
      staffVenues: {
        where: { active: true, role: { in: ['OWNER', 'ADMIN'] } },
        orderBy: { role: 'asc' }, // OWNER < ADMIN alphabetically? verify; else two queries
        take: 1,
        select: { staff: { select: { email: true, firstName: true, lastName: true } } },
      },
    },
  })
  if (!venue) return { email: null, locale: 'es', venueName: 'tu negocio', ownerName: null }

  const owner = venue.staffVenues[0]?.staff
  const email = venue.email || owner?.email || venue.organization?.email || null
  const ownerName = owner ? `${owner.firstName ?? ''} ${owner.lastName ?? ''}`.trim() || null : null
  const locale = venue.language === 'en' ? 'en' : 'es'
  return { email, locale, venueName: venue.name, ownerName }
}
```
> NOTE for implementer: verify the `StaffVenue` relation name on `Venue` (`grep -n "staffVenues\|StaffVenue" prisma/schema.prisma`) and the OWNER-first ordering; if `orderBy: { role }` doesn't put OWNER first, select all and pick `find(s => s.role === 'OWNER') ?? find(ADMIN)`.

- [ ] **Step 4: Run tests, verify pass.** Format the new file with `npx prettier --write src/services/access/planNotification.service.ts tests/unit/services/access/planNotification.test.ts`.

---

## Task 3: Win-back coupon in seed

**Files:**
- Modify: `scripts/seed-plan-pro.ts` (add a second `ensureCoupon`-style helper or generalize)

- [ ] **Step 1: Generalize `ensureCoupon` to accept config** — refactor the existing `ensureCoupon()` into `ensureCoupon(id, config)` and call it for both coupons:

```typescript
async function ensureCoupon(id: string, cfg: Stripe.CouponCreateParams): Promise<Stripe.Coupon> {
  try {
    const existing = await stripe.coupons.retrieve(id)
    const matches = cfg.amount_off != null ? existing.amount_off === cfg.amount_off : existing.percent_off === cfg.percent_off
    if (matches && existing.duration === cfg.duration) return existing
    await stripe.coupons.del(id)
  } catch { /* not found */ }
  return stripe.coupons.create({ id, ...cfg })
}
```

- [ ] **Step 2: Create both coupons in `main()`** (replace the single `ensureCoupon()` call):

```typescript
const introCoupon = await ensureCoupon('INTRO_PRO_3M', {
  amount_off: COUPON_OFF, currency: 'mxn', duration: 'repeating', duration_in_months: 3,
  name: 'Avoqado Pro - 3 meses a $599 + IVA',
})
const winbackCoupon = await ensureCoupon('WINBACK_FIRST_MONTH_FREE', {
  percent_off: 100, duration: 'once', name: 'Avoqado Pro - Win-back: 1er mes gratis',
})
```
Update the final `logger.info` to mention both coupon ids.

- [ ] **Step 3: Run the seed** (test mode): `npx tsx -r dotenv/config -r tsconfig-paths/register scripts/seed-plan-pro.ts` → logs both coupons. (No unit test; seed is integration-only.)

---

## Task 4: `sendPlanConfirmationEmail`

**Files:**
- Modify: `src/services/email.service.ts` (add method; mirror the HTML shell of `sendTrialEndingEmail` / `sendPaymentFailedEmail` — white bg, logo `https://avoqado.io/isotipo.svg` header+footer, black `#000000` CTA, no emoji in subject, per `.claude/rules/email-templates.md`)
- Test: `tests/unit/services/email/planEmails.test.ts`

- [ ] **Step 1: Define the data type + method signature**

```typescript
export interface PlanConfirmationEmailData {
  locale: 'es' | 'en'
  venueName: string
  payNow: boolean            // true = paid today, false = trial
  interval: 'monthly' | 'annual'
  firstChargeDate: Date      // trial end (trial) OR next renewal (pay-now)
  firstChargeAmountCents: number   // gross IVA-inclusive (115884 monthly / 1158840 annual)
  introAmountCents?: number  // pay-now first charge (69484 = $694.84) when applicable
  billingPortalUrl: string
}
async sendPlanConfirmationEmail(email: string, data: PlanConfirmationEmailData): Promise<boolean>
```

- [ ] **Step 2: Write the failing test** (assert subject per locale + send called):

```typescript
import emailService from '../../../../src/services/email.service'
const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(true)
afterEach(() => spy.mockClear())

it('confirmation: trial es subject, no emoji', async () => {
  await emailService.sendPlanConfirmationEmail('a@x.com', {
    locale: 'es', venueName: 'Bar', payNow: false, interval: 'monthly',
    firstChargeDate: new Date('2026-07-03'), firstChargeAmountCents: 115884, billingPortalUrl: 'u' })
  const arg = spy.mock.calls[0][0]
  expect(arg.to).toBe('a@x.com')
  expect(arg.subject).toMatch(/prueba|Pro/i)
  expect(arg.subject).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u) // no emoji
  expect(arg.html).toContain('1,158.84')
})
it('confirmation: pay-now en subject + intro amount', async () => {
  await emailService.sendPlanConfirmationEmail('a@x.com', {
    locale: 'en', venueName: 'Bar', payNow: true, interval: 'monthly',
    firstChargeDate: new Date('2026-09-03'), firstChargeAmountCents: 115884, introAmountCents: 69484, billingPortalUrl: 'u' })
  const arg = spy.mock.calls[0][0]
  expect(arg.subject).toMatch(/welcome|plan|Pro/i)
  expect(arg.html).toContain('694.84')
})
```

- [ ] **Step 3: Run, verify fail** (method undefined).

- [ ] **Step 4: Implement** — `subject`/copy chosen by `data.locale`; format money via `new Intl.NumberFormat(data.locale === 'en' ? 'en-US' : 'es-MX', { style: 'currency', currency: 'MXN' }).format(cents/100)`. Copy:
  - **Trial** es: `asunto: "Tu prueba de Avoqado Pro empezó"` · body: "Tu prueba de 30 días está activa. Tu primer cobro será de {first} el {date}." en: "Your Avoqado Pro trial has started" · "Your 30-day trial is active. Your first charge of {first} is on {date}."
  - **Pay-now** es: `asunto: "¡Bienvenido a Avoqado Pro!"` · "Recibimos tu pago de {intro}. Seguirás con {intro} los primeros 3 meses, luego {first}/{interval}." en analog.
  - Always include a black CTA "Ver facturación" / "View billing" → `billingPortalUrl`. Build HTML by copying the `<table>` shell of `sendPaymentFailedEmail` (logo header, body, CTA, footer).

- [ ] **Step 5: Run tests, verify pass.** Prettier the 2 files.

---

## Task 5: Call confirmation from `completeV2Onboarding`

**Files:**
- Modify: `src/controllers/onboarding.controller.ts` (inside the `if (planEnabled && planData?.paymentMethodId)` block, lines ~1059-1087, AFTER `prisma.venue.update({ planTier: 'PRO' })`)
- Test: `tests/unit/controllers/completeV2.confirmationEmail.test.ts`

- [ ] **Step 1: Add the call** (inside the existing try, after planTier update):

```typescript
        try {
          const target = await resolvePlanNotificationTarget(result.venue.id)
          if (target.email) {
            const feature = await prisma.feature.findFirst({ where: { code: 'PLAN_PRO' }, select: { monthlyPrice: true } })
            const grossCents = planData.interval === 'annual' ? 1158840 : 115884 // IVA-inclusive
            const now = new Date()
            const firstChargeDate = planData.payNow
              ? new Date(now.getTime() + (planData.interval === 'annual' ? 365 : 30) * 86400000)
              : new Date(now.getTime() + 30 * 86400000) // trial end
            const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dashboard.avoqado.io'
            await emailService.sendPlanConfirmationEmail(target.email, {
              locale: target.locale, venueName: target.venueName, payNow: planData.payNow,
              interval: planData.interval, firstChargeDate, firstChargeAmountCents: grossCents,
              introAmountCents: planData.payNow && planData.interval === 'monthly' ? 69484 : undefined,
              billingPortalUrl: `${FRONTEND_URL}/dashboard/venues/${result.venue.slug}/billing`,
            })
          } else {
            logger.warn(`No notification recipient for venue ${result.venue.id}; skipping plan confirmation email`)
          }
        } catch (mailErr) {
          logger.error(`⚠️ Plan confirmation email failed for venue ${result.venue.id}`, mailErr)
        }
```
Add imports at top: `import { resolvePlanNotificationTarget } from '../services/access/planNotification.service'` and ensure `emailService` is imported (`import emailService from '../services/email.service'` — check existing imports first).

- [ ] **Step 2: Write a focused test** that mocks `resolvePlanNotificationTarget` + `emailService.sendPlanConfirmationEmail` and asserts the confirmation is called with `payNow`/`interval` derived from `planData`, and that a thrown email error does NOT reject completeV2. (Mirror the structure of the existing `tests/unit/controllers/completeV2.planGate.test.ts`.)

- [ ] **Step 3: Run, verify pass.**

---

## Task 6: `sendPlanRenewalReminderEmail`

**Files:** Modify `src/services/email.service.ts`; Test `tests/unit/services/email/planEmails.test.ts` (same file as Task 4)

- [ ] **Step 1: Type + signature**

```typescript
export interface PlanRenewalReminderEmailData {
  locale: 'es' | 'en'; venueName: string; interval: 'monthly' | 'annual'
  renewalDate: Date; amountCents: number; billingPortalUrl: string
}
async sendPlanRenewalReminderEmail(email: string, data: PlanRenewalReminderEmailData): Promise<boolean>
```

- [ ] **Step 2: Failing test** — assert subject (es "Tu plan se renueva pronto" / en "Your plan renews soon"), body contains the formatted amount + date, no emoji in subject.

- [ ] **Step 3: Implement** — copy es: "Tu plan Avoqado Pro se renovará el {date} por {amount}. No necesitas hacer nada; se cobra automáticamente a tu tarjeta." en analog. Black CTA "Administrar plan" → billingPortalUrl. Same HTML shell.

- [ ] **Step 4: Run tests, verify pass.**

---

## Task 7: `plan-renewal-reminder.job.ts` cron

**Files:**
- Create: `src/jobs/plan-renewal-reminder.job.ts`
- Modify: `src/server.ts` (import + start, mirroring `subscriptionCancellationJob`)
- Test: `tests/unit/jobs/plan-renewal-reminder.test.ts`

- [ ] **Step 1: Implement the job** (mirror `subscription-cancellation.job.ts` class shape; **entry DB read wrapped in `retry(..., { shouldRetry: shouldRetryDbConnectionError })`** per `.claude/rules/cron-jobs.md`):

```typescript
import { CronJob } from 'cron'
import Stripe from 'stripe'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import emailService from '../services/email.service'
import { resolvePlanNotificationTarget } from '../services/access/planNotification.service'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

export class PlanRenewalReminderJob {
  private job: CronJob | null = null
  start() {
    // Daily 09:00 America/Mexico_City
    this.job = new CronJob('0 9 * * *', () => this.runNow(), null, true, 'America/Mexico_City')
  }
  async runNow() {
    try { await this.run() } catch (e) { logger.error('plan-renewal-reminder failed', e) }
  }
  private async run() {
    // Active PLAN_PRO VenueFeatures with a Stripe sub
    const features = await retry(
      () => prisma.venueFeature.findMany({
        where: { active: true, stripeSubscriptionId: { not: null }, feature: { code: 'PLAN_PRO' } },
        select: { id: true, venueId: true, stripeSubscriptionId: true, renewalReminderSentAt: true },
      }),
      { shouldRetry: shouldRetryDbConnectionError },
    )
    const now = Date.now()
    for (const vf of features) {
      try {
        const sub = await stripe.subscriptions.retrieve(vf.stripeSubscriptionId!)
        if (sub.status !== 'active' && sub.status !== 'trialing') continue
        const periodEndMs = sub.current_period_end * 1000
        const daysToRenewal = (periodEndMs - now) / 86400000
        if (daysToRenewal < 2 || daysToRenewal > 4) continue // ~3 days window
        // dedup: already reminded for this period?
        if (vf.renewalReminderSentAt && vf.renewalReminderSentAt.getTime() > sub.current_period_start * 1000) continue
        const target = await resolvePlanNotificationTarget(vf.venueId)
        if (!target.email) { logger.warn(`renewal reminder: no recipient for venue ${vf.venueId}`); continue }
        const interval = sub.items.data[0]?.price.recurring?.interval === 'year' ? 'annual' : 'monthly'
        const amountCents = sub.items.data[0]?.price.unit_amount ?? 0
        const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dashboard.avoqado.io'
        await emailService.sendPlanRenewalReminderEmail(target.email, {
          locale: target.locale, venueName: target.venueName, interval,
          renewalDate: new Date(periodEndMs), amountCents,
          billingPortalUrl: `${FRONTEND_URL}/dashboard/venues/billing`,
        })
        await prisma.venueFeature.update({ where: { id: vf.id }, data: { renewalReminderSentAt: new Date() } })
      } catch (err) { logger.error(`renewal reminder failed for venueFeature ${vf.id}`, err) }
    }
  }
}
export const planRenewalReminderJob = new PlanRenewalReminderJob()
```

- [ ] **Step 2: Register in `src/server.ts`** — add `import { planRenewalReminderJob } from './jobs/plan-renewal-reminder.job'` and `planRenewalReminderJob.start()` next to the other `.start()` calls (find with `grep -n "subscriptionCancellationJob" src/server.ts`).

- [ ] **Step 3: Test** `tests/unit/jobs/plan-renewal-reminder.test.ts` — mock prisma (`venueFeature.findMany`/`update`), Stripe (`subscriptions.retrieve`), `resolvePlanNotificationTarget`, `emailService`. Cases: sub renewing in 3d + not reminded → sends + stamps; renewing in 10d → skipped; already reminded this period → skipped; null recipient → skipped, no throw. Run with `--runInBand`.

- [ ] **Step 4: Verify pass.**

---

## Task 8: `sendPlanWinbackEmail`

**Files:** Modify `src/services/email.service.ts`; Test `tests/unit/services/email/planEmails.test.ts`

- [ ] **Step 1: Type + signature**

```typescript
export interface PlanWinbackEmailData {
  locale: 'es' | 'en'; venueName: string; reactivateUrl: string
}
async sendPlanWinbackEmail(email: string, data: PlanWinbackEmailData): Promise<boolean>
```

- [ ] **Step 2: Failing test** — subject es "Vuelve a Avoqado Pro — tu primer mes es gratis" / en "Come back to Avoqado Pro — your first month is free"; body mentions free month; CTA → reactivateUrl; no emoji.

- [ ] **Step 3: Implement** — copy es: "Te extrañamos. Reactiva Avoqado Pro y tu primer mes es gratis. Tus datos siguen intactos y el acceso se reactiva al instante." en analog. Black CTA "Reactivar con 1 mes gratis" / "Reactivate — 1 month free" → reactivateUrl. Same shell.

- [ ] **Step 4: Run, verify pass.**

---

## Task 9: `plan-winback.job.ts` cron

**Files:**
- Create: `src/jobs/plan-winback.job.ts`
- Modify: `src/server.ts` (register + start)
- Test: `tests/unit/jobs/plan-winback.test.ts`

- [ ] **Step 1: Implement** (same class shape + `retry` wrap):

```typescript
// imports same as Task 7 (minus Stripe — not needed)
export class PlanWinbackJob {
  private job: CronJob | null = null
  start() { this.job = new CronJob('0 10 * * *', () => this.runNow(), null, true, 'America/Mexico_City') }
  async runNow() { try { await this.run() } catch (e) { logger.error('plan-winback failed', e) } }
  private async run() {
    const fourDaysAgo = new Date(Date.now() - 4 * 86400000)
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000)
    const features = await retry(
      () => prisma.venueFeature.findMany({
        where: {
          feature: { code: 'PLAN_PRO' },
          suspendedAt: { not: null, gte: fourDaysAgo, lte: twoDaysAgo }, // suspended ~3 days ago
          winbackSentAt: null,
          active: false, // still suspended, not reactivated
        },
        select: { id: true, venueId: true, venue: { select: { slug: true } } },
      }),
      { shouldRetry: shouldRetryDbConnectionError },
    )
    for (const vf of features) {
      try {
        const target = await resolvePlanNotificationTarget(vf.venueId)
        if (!target.email) { logger.warn(`winback: no recipient for venue ${vf.venueId}`); continue }
        const FRONTEND_URL = process.env.FRONTEND_URL || 'https://dashboard.avoqado.io'
        await emailService.sendPlanWinbackEmail(target.email, {
          locale: target.locale, venueName: target.venueName,
          reactivateUrl: `${FRONTEND_URL}/dashboard/venues/${vf.venue.slug}/billing?winback=1`,
        })
        await prisma.venueFeature.update({ where: { id: vf.id }, data: { winbackSentAt: new Date() } })
      } catch (err) { logger.error(`winback failed for venueFeature ${vf.id}`, err) }
    }
  }
}
export const planWinbackJob = new PlanWinbackJob()
```
> NOTE: verify the `active`/`suspendedAt` semantics match how suspension is recorded (check `sendSubscriptionSuspendedEmail` caller in `stripe.service.ts`). If suspension sets `suspendedAt` but leaves `active` true, drop the `active: false` filter and instead require `suspendedAt` set.

- [ ] **Step 2: Register in `src/server.ts`.**

- [ ] **Step 3: Test** — suspended 3d ago + winbackSentAt null → sends + stamps; suspended 10d ago → skipped (outside window); winbackSentAt set → skipped; reactivated → skipped; null recipient → skipped no throw. `--runInBand`.

- [ ] **Step 4: Verify pass.**

---

## Task 10: Retrofit the 5 existing emails (recipient + locale)

**Files:**
- Modify: `src/services/email.service.ts` (add optional `locale?: 'es' | 'en'` to the 5 data types, default `'es'`; add `en` bodies)
- Modify the **callers** to pass `resolvePlanNotificationTarget`'s `email` + `locale`:
  - `src/services/stripe.service.ts` (`sendPaymentFailedEmail` ~1259, `sendSubscriptionSuspendedEmail` ~1304)
  - `src/services/stripe.webhook.service.ts` (`sendTrialEndingEmail` ~640)
  - `src/jobs/subscription-cancellation.job.ts` (`sendSubscriptionCanceledEmail` ~273, `sendTrialExpiredEmail` ~145)
- Test: extend `tests/unit/services/email/planEmails.test.ts`

- [ ] **Step 1: Add `locale` param + en body to each of the 5 methods.** Each currently builds a Spanish subject/body; wrap the locale-varying strings in a `const t = locale === 'en' ? {...} : {...}` object. Keep `locale` optional defaulting to `'es'` so the **old à-la-carte Feature callers keep working unchanged**.

- [ ] **Step 2: Update the 5 callers** to resolve the target and pass it. Example (stripe.service.ts payment-failed, replacing `venueFeature.venue.organization.email`):
```typescript
const target = await resolvePlanNotificationTarget(venueFeature.venueId)
const recipient = target.email ?? venueFeature.venue.organization.email // keep org as last resort
if (recipient) {
  await emailService.sendPaymentFailedEmail(recipient, { ...existingData, locale: target.locale })
}
```
Apply the analogous change at each of the 5 sites. Import `resolvePlanNotificationTarget` where missing.

- [ ] **Step 3: Tests** — for each of the 5, assert `locale: 'en'` produces an English subject and `locale` omitted defaults to Spanish (regression for old callers). Add a regression test confirming `subscription-cancellation.job` / webhook still send when `venue.email` is set but `org.email` is null.

- [ ] **Step 4: Run the affected suites** (`--runInBand`): the new `planEmails.test.ts` + existing `stripe.webhook.planPro.test.ts` + any email/webhook tests. Verify pass.

---

## Task 11: Capture wizard locale → `Venue.language`

**Files:**
- Modify: `avoqado-web-dashboard/src/pages/Setup/SetupWizard.tsx` (the completion call — `grep -n "v2/complete\|completeSetup\|handleComplete" SetupWizard.tsx`)
- Modify: `src/controllers/onboarding.controller.ts` (`completeV2Onboarding`) + `src/schemas/onboarding.schema.ts` (allow optional `language` in the complete body)
- Test: extend the completeV2 test

- [ ] **Step 1: Frontend** — when calling `/v2/complete`, include the active i18n locale:
```typescript
import { useTranslation } from 'react-i18next'
// inside the component:
const { i18n } = useTranslation()
// in the completion POST body:
body: { language: i18n.language?.startsWith('en') ? 'en' : 'es' }
```

- [ ] **Step 2: Backend** — in `completeV2Onboarding`, read `const language = req.body?.language === 'en' ? 'en' : 'es'` and include it in the `prisma.venue.update`/create for the venue (set `language`). Add `language: z.enum(['es', 'en']).optional()` to the complete-body schema if that route validates a body (check `onboarding.schema.ts`); keep Spanish error messages per the Zod rule.

- [ ] **Step 3: Test** — completeV2 with `language: 'en'` persists `venue.language = 'en'`; omitted → `'es'`.

- [ ] **Step 4: Verify pass.**

---

## Task 12: Final verification

- [ ] **Step 1:** `npx tsc --noEmit` (backend) → EXIT 0.
- [ ] **Step 2:** `npx tsc -b` (dashboard) → no errors.
- [ ] **Step 3:** Run the full affected unit set `--runInBand`: `tests/unit/services/access tests/unit/services/email tests/unit/jobs tests/unit/controllers/completeV2.confirmationEmail.test.ts` → all pass.
- [ ] **Step 4:** Prettier only the touched files (no repo-wide format/lint:fix).
- [ ] **Step 5:** Leave everything **uncommitted**. Print `git status --short` and a summary of which files are this feature's (for the user to commit thematically later).

---

## Self-Review (filled)

**Spec coverage:** (1) migration → Task 1 ✅; (2) resolver → Task 2 ✅; (3) 3 new emails → Tasks 4/6/8 ✅, confirmation wiring → Task 5 ✅; (4) 2 crons → Tasks 7/9 ✅; (5) retrofit 5 → Task 10 ✅; (6) win-back coupon → Task 3 ✅; (7) locale capture → Task 11 ✅; testing throughout + Task 12 ✅.

**Placeholder scan:** Two explicit `NOTE for implementer` verification points (StaffVenue relation/order in Task 2; suspension `active`/`suspendedAt` semantics in Task 9) — these are deliberate "verify against schema" instructions, not lazy placeholders; both give a concrete fallback. Email HTML bodies reference the existing `sendPaymentFailedEmail` shell to copy (established-pattern reuse), with exact subjects + copy provided.

**Type consistency:** `resolvePlanNotificationTarget → { email, locale, venueName, ownerName }` used consistently in Tasks 5/7/9/10. `locale: 'es' | 'en'` consistent across all email data types. Gross IVA-inclusive cents (115884 / 1158840 / 69484) consistent with the 2026-06-02 IVA spec.
