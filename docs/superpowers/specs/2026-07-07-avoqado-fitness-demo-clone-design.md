# Avoqado Fitness — Demo Venue Clone (gym-oriented)

**Date:** 2026-07-07
**Author:** Jose Antonio Amieva (via Claude)
**Status:** ✅ EXECUTED & VERIFIED in prod 2026-07-07 — venue `avoqado-fitness` = `cmrb9clsl0001c9126obyxp2q`

## Execution result (2026-07-07)

Ran `scripts/seed-avoqado-fitness-demo.ts` (via `tsx`, `DATABASE_URL`→Render prod). Created:
- Venue **Avoqado Fitness** (`cmrb9clsl0001c9126obyxp2q`), slug `avoqado-fitness`, type FITNESS, accent `#7ADD2C`.
- Cloned VenueSettings, ReservationSettings (public booking ON), LoyaltyConfig from avoqado-full.
- 8 features enabled (ADVANCED_ANALYTICS Feature is deactivated in prod → correctly skipped; the other 8 apply).
- 8 staff links (logins + instructors).
- 5 categories / 31 products; 72 ClassSessions (Mon–Sat, next 21 days, slots 07:00/09:00/18:00/19:30);
  3 credit packs (5/10/20 credits); 3 sample appointment reservations.

**Verified:** avoqado-full byte-identical after run (product hash `196f6688ccaedf1179e9144a2f0c5d1d`,
counts unchanged). Public API live in prod: `/info` (FITNESS + catalog), `/credit-packs` (3 packs),
`/availability` returns bookable class slots with instructor + capacity at correct venue-local times.

**Payment note:** `canVenueChargeOnline` requires a Stripe-Connect chargeable EcommerceMerchant, which
avoqado-full also lacks — so the gym mirrors full's online-charge behavior exactly (credit-pack purchase
routes through the platform Stripe account; class-booking upfront falls back the same way full does). The
sandbox EcommerceMerchant in the plan was intentionally NOT created — a Blumon one wouldn't flip
`canVenueChargeOnline`, so it added nothing. No TPV/terminal (founder owns that).

## Goal

Create a **new** production demo venue, gym-oriented ("Avoqado Fitness"), so the founder can
demo Avoqado to a gym prospect. All customer-visible catalog (categories, products, packages,
classes, appointments) must read as a fitness studio, and the data-driven frontends (booking
widget, dashboard, checkout) render gym content with **zero frontend code changes**.

## Decisions (confirmed with founder)

| # | Decision | Choice |
|---|----------|--------|
| 1 | New clone vs re-theme in place | **New venue** (`avoqado-full` stays intact as the restaurant showcase) |
| 2 | Branding | Generic **"Avoqado Fitness"** |
| 3 | Frontend scope | **DB-only** — no changes to any frontend repo |
| 4 | Surfaces that must work | Booking widget, Web dashboard, Checkout/payments (TPV handled separately by founder) |
| 5 | TPV / terminal | **Not created here.** Founder will attach a terminal himself. (Follow-up: investigate 2 TPV builds → different venues.) |

## Non-goals (YAGNI)

- No TPV terminal / merchant-account / card-processing setup (founder owns this).
- No new Organization — reuse `Grupo Avoqado Prime`.
- No changes to `avoqado-full` or any other venue.
- No real money movement (checkout merchant is **sandbox**).
- No frontend/repo code changes.

## Source of truth (production, queried 2026-07-07)

- Org `Grupo Avoqado Prime` = `cmhvejg1t00a52gtx889cat0e`
- Template venue `avoqado-full` = `cmhvejgq300ad2gtxbrawgh7w` (type RESTAURANT, `seatCapExempt=true`, status ACTIVE)
  - 9 VenueFeatures: ADVANCED_ANALYTICS, ADVANCED_REPORTS, AI_ASSISTANT_BUBBLE, AVAILABLE_BALANCE, CHATBOT, INVENTORY_TRACKING, LOYALTY_PROGRAM, ONLINE_ORDERING, RESERVATIONS
  - 0 VenueModules
  - ReservationSettings: `publicBookingEnabled=true`, `autoConfirm=true`, `classUpfrontDefault=required`, `appointmentUpfrontDefault=at_venue`, operating hours Mon–Sat 09:00–22:00
  - EcommerceMerchant `test_ecomm_sandbox_001` (Blumon, `sandboxMode=true`)
- `VenueType.FITNESS` exists (Services category) → the new venue's `type`.
- Schema drift check: the only unmigrated local changes touch fiscal models (`FiscalEmisor`,
  `MerchantFiscalConfig`) — none of the models used here. Prisma is safe against prod for all
  target models.

## Architecture / approach

**Executable = one idempotent TypeScript seed script** (`scripts/seed-avoqado-fitness-demo.ts`)
run with `DATABASE_URL` pointed at the Render prod DB. Rationale over hand-written SQL:
Prisma gives correct types/defaults, auto-generates cuids, and models relations cleanly.
Rejected alternative (raw psql INSERTs) is drift-proof but far more error-prone across 200+
column models — higher risk of a missing NOT NULL / wrong enum. Prisma is safe here because
target models are in sync with prod.

Safety properties:
- **Additive only** — creates a brand-new venue subtree; never updates/deletes `avoqado-full`.
- **Idempotent** — if slug `avoqado-fitness` already exists, the script aborts (or `--force`
  reuses it); each child create is guarded by a natural-key existence check.
- **Reversible** — companion `--teardown` flag deletes the venue (cascade removes children:
  categories, products, class sessions, credit packs, reservation settings, features, staff
  links, ecommerce merchant). The venue id is printed on create and saved to the scratchpad.
- **Reviewed before run** — script is shown to the founder; nothing executes against prod
  until explicit "córrelo".

## What the script creates

### 1. Venue
- `name: "Avoqado Fitness"`, `slug: "avoqado-fitness"`, `type: FITNESS`, org = Grupo Avoqado Prime,
  `timezone/currency` = MX/MXN, `seatCapExempt: true`, `status: ACTIVE`.
- `primaryColor` set to a gym accent (e.g. `#7ADD2C` brand green) so the booking widget looks intentional.

### 2. Cloned config (copied field-for-field from `avoqado-full`, new ids/venueId)
- `VenueSettings` (1 row)
- `VenueFeature` × 9 (same feature codes → same capabilities/gating-exempt behavior)
- `ReservationSettings` (public booking ON, same hours/policies)
- `LoyaltyConfig` (if present on template)
- `EcommerceMerchant` (sandbox) — new unique `contactEmail`, `publicKey`, `secretKeyHash`, `channelName`

### 3. Staff logins (dashboard access)
Add `StaffVenue` rows linking existing demo accounts to the new venue (no new passwords):
`superadmin@superadmin.com`, `owner@owner.com`, `admin@admin.com`, `manager@manager.com`,
`cashier@cashier.com`. Roles mirror their role at `avoqado-full`.

### 4. Catalog (new gym content) — 1 Menu "Membresías & Servicios" + categories via MenuCategoryAssignment

| Category (slug) | ProductType | Products (price MXN) |
|---|---|---|
| Membresías (`membresias`) | REGULAR | Inscripción 300, Mensual 799, Trimestral 2099, Anual 6999, Pase Diario 150, Pase Semanal 499 |
| Clases (`clases`) | CLASS | Indoor Cycling 180, Spinning Power 190, HIIT 200, Yoga Flow 160, Pilates Reformer 250, Box Fit 210, Zumba 150, Functional Training 190 |
| Entrenamiento & Citas (`entrenamiento`) | APPOINTMENTS_SERVICE | Sesión Personal Training 450, Valoración InBody 250, Consulta Nutricional 500, Masaje Deportivo 600, Evaluación Postural 350 |
| Suplementos & Retail (`suplementos`) | REGULAR | Proteína Whey 750, Pre-Entreno 550, Creatina 450, Barra Proteica 45, Shaker 120, Guantes 250, Toalla Avoqado 180 |
| Bebidas (`bebidas`) | FOOD_AND_BEV | Agua 20, Bebida Isotónica 35, Batido Proteico 75, Smoothie Verde 85, Café Americano 40 |

- CLASS products: `durationMinutes` 45–60, `maxParticipants` 12–20, `allowCreditRedemption=true`.
- APPOINTMENTS_SERVICE products: `durationMinutes` 30–60.
- Every product gets a unique per-venue `sku` (e.g. `MEMB-001`, `CLASE-001`, `CITA-001`).

### 5. Class sessions (booking availability)
For each CLASS product, seed `ClassSession` rows across the next ~21 days (2–3 slots/day on
operating days), `status=SCHEDULED`, `capacity` = product `maxParticipants`, `assignedStaffId`
= one of the manager accounts (as instructors), start/end times venue-local within 09:00–21:00.

### 6. Credit packs (paquetes)
Three `CreditPack` rows + `CreditPackItem` links to the new CLASS products:
- **Paquete 5 Clases** — 800, validity 30d → 5 credits (Indoor Cycling)
- **Paquete 10 Clases Mixto** — 1500, validity 45d → mixed across several classes
- **Paquete Premium 20 Clases** — 2900, validity 60d → mixed across all classes
`stripeProductId/stripePriceId` left null (created lazily by the credit-pack checkout service).

### 7. Sample appointment reservations (optional, small)
A few `Reservation` rows for personal-training slots so the dashboard reservations view isn't empty.

## Verification (after run, read-only)

1. `Venue` row exists with slug `avoqado-fitness`, type FITNESS.
2. Category + product counts match the table above; all `active=true`.
3. `ClassSession` count > 0 and future-dated (venue-local).
4. 3 credit packs with items linked to real CLASS products.
5. `ReservationSettings.publicBookingEnabled=true`.
6. Booking widget resolves: `book.avoqado.io/avoqado-fitness/classes` shows classes.
7. Dashboard: log in as `owner@owner.com`, switch to Avoqado Fitness, catalog reads gym.
8. Confirm `avoqado-full` is byte-for-byte unchanged (category/product counts identical to pre-run snapshot).

## Rollback

`npx ts-node scripts/seed-avoqado-fitness-demo.ts --teardown` → deletes the `avoqado-fitness`
venue; cascade removes all children. `avoqado-full` untouched by construction.
