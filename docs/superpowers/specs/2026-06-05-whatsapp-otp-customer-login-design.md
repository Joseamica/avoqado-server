# Design Spec — Passwordless WhatsApp OTP Customer Login

**Date:** 2026-06-05 **Status:** Draft (pending review) **Repos:** `avoqado-server` (backend), `avoqado-booking-widget` (widget) **Author:**
Jose + Claude (brainstorming session)

---

## 1. Problem

Booking customers (Mexico, WhatsApp-native, often one-off) face password friction to use the customer portal (see all their reservations,
credits, rebook). Today the portal login is **email + password** (`Customer.password`, bcrypt, per-venue). Casual customers won't
create/remember a password → abandonment + password-reset support load.

We want a **passwordless** login: customer enters their **phone**, gets a **6-digit code via WhatsApp**, enters it, and is in. The phone is
already the natural identity (it keys reservations via `guestPhone`), and the WhatsApp Cloud API is already integrated.

## 2. Goal

Add WhatsApp OTP as the primary, passwordless login for the customer portal, so a customer signs in with phone → WhatsApp code → sees their
reservations/credits. Keep the existing flows working.

### What already exists (reuse, don't rebuild)

- **`Consumer`** — global cross-venue identity (`email @unique`, `phone` indexed via `@@index([phone])`). The per-venue `Customer` links to
  it via `Customer.consumerId`.
- **`auth.consumer.service.ts`** — consumer auth, today **OAuth (Google/Apple)** only; no phone/OTP.
- **Customer portal** — `registerCustomer`/`loginCustomer` (email+password, bcrypt, per-venue), `CustomerTokenPayload` JWT
  (`sub`=Customer.id, `venueId`, `type:'customer'`), `signCustomerToken`, `customerAuth.middleware`, `getCustomerPortal`.
- **WhatsApp** — `sendTemplateMessage` + the approved Meta **Authentication** template `otp_verify` ("{{1}} es tu código de verificación.
  Vence en 10 minutos." + copy-code button).
- **Email** — `email.service` (for the fallback channel).
- **Magic link** — `?manage=<cancelSecret>` manages ONE reservation with no login. Stays as-is.

### Non-goals (v1, YAGNI)

- SMS fallback (WhatsApp + email cover ~all of this audience).
- Replacing/removing email+password login (kept as a secondary method).
- Migrating the consumer-app OAuth to OTP (out of scope; this is the booking widget portal).
- An MCP tool (see §8 — auth login is not an ops action).

## 3. Decisions (confirmed with product owner)

| #           | Decision                              | Choice                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity    | **Hybrid**                            | OTP authenticates the **global `Consumer`** by phone (1 phone = 1 identity cross-venue); in a venue's widget it resolves/creates the per-venue `Customer` linked to that Consumer and issues a **customer-token** (minimal change to the current portal + unified identity). |
| Scope       | **OTP = portal, magic-link = manage** | `?manage=` stays for single-reservation management (zero friction). OTP is for the portal (all reservations, credits, rebook).                                                                                                                                               |
| Fallback    | **WhatsApp + email**                  | Primary WhatsApp OTP; email-code fallback when no WhatsApp / undelivered. No SMS in v1.                                                                                                                                                                                      |
| Coexistence | **Add OTP, keep password**            | OTP is a new method; email+password keeps working. OTP pushed as the primary option in the UI.                                                                                                                                                                               |

## 4. Architecture

```
[Widget portal login]
  phone ─ POST /auth/otp/request {phone}  ─▶ generate code, store hash, send via WhatsApp otp_verify
  code  ─ POST /auth/otp/verify {phone,code} ─▶ validate ─▶ resolve identity (hybrid) ─▶ customer-token
                                                              │
                                                              ▼
                                          Consumer(global, by phone)  ──link──▶  Customer(this venue)
                                                              │
                                                              ▼  signCustomerToken (existing)
                                          { token, customer }  →  getCustomerPortal works unchanged
```

The OTP layer is a thin, isolated unit (request + verify + a challenge store). Identity resolution reuses the existing Consumer/Customer
models and the existing customer-token issuance, so the portal, middleware, and widget storage are untouched downstream.

## 5. Backend changes (`avoqado-server`)

### 5.1 Data model

New table **`OtpChallenge`** (Prisma):

```prisma
model OtpChallenge {
  id           String    @id @default(cuid())
  channel      String    // 'whatsapp' | 'email'
  destination  String    // E.164 phone OR email (normalized)
  codeHash     String    // sha256(code + pepper); never store the plaintext code
  expiresAt    DateTime  // now + 10 min (matches the template copy)
  attempts     Int       @default(0)
  maxAttempts  Int       @default(5)
  consumedAt   DateTime?
  ip           String?   // for rate-limit / abuse forensics
  createdAt    DateTime  @default(now())

  @@index([destination, expiresAt])
}
```

Add `PHONE` to the `AuthProvider` enum (`EMAIL | GOOGLE | FACEBOOK | APPLE | PHONE`).

### 5.2 OTP service (`src/services/public/otpAuth.public.service.ts`)

- `requestOtp({ venueSlug, channel, destination, ip })`:
  - Normalize phone → E.164 (or lowercase email).
  - Rate-limit: per destination (≤1 / 30s, ≤5 / hour) + per IP. Expire prior unconsumed challenges for that destination.
  - Generate a 6-digit code, store `codeHash` (sha256 with a server pepper) + `expiresAt`.
  - Send: WhatsApp `otp_verify` (code in body `{{1}}` + the OTP copy-code button param) or email code via `email.service`.
  - Return `{ ok: true }` regardless (never leak whether the destination is known).
- `verifyOtp({ venueSlug, destination, code })`:
  - Load the latest unconsumed, unexpired challenge for `destination`. `attempts++`. If `attempts > maxAttempts` → invalidate (set
    `consumedAt`) and reject.
  - Compare sha256(code) to `codeHash`. On mismatch → generic error.
  - On match → mark `consumedAt`, then **resolve identity (hybrid)**. The lookup key is the challenge's `destination` (phone for the
    WhatsApp channel, email for the fallback channel):
    1. Find `Consumer` by phone (`@@index([phone])`) — or by `email` (`@unique`) for the email channel; create the `Consumer` with the known
       field if none.
    2. Find this venue's `Customer` by (`venueId`, phone/email) OR by `consumerId`; create
       `{ venueId, phone|email, consumerId, provider: 'PHONE' }` if none; if it exists without `consumerId`, link it.
    3. Issue a customer-token via the existing `signCustomerToken({ sub: Customer.id, venueId })`.
  - Return `{ token, customer }` — identical shape to `loginCustomer` so the portal is unchanged.

### 5.3 Routes (`src/routes/public.routes.ts`)

| Method | Path                                  | Limiter                                         | Handler      |
| ------ | ------------------------------------- | ----------------------------------------------- | ------------ |
| `POST` | `/venues/:venueSlug/auth/otp/request` | writeLimit (+ per-destination guard in service) | `requestOtp` |
| `POST` | `/venues/:venueSlug/auth/otp/verify`  | authLimit (10/min)                              | `verifyOtp`  |

Zod (Spanish messages, shape-only): `otpRequestSchema` (`phone?` xor `email?`, at least one), `otpVerifySchema` (`phone`/`email` + `code` 6
digits).

### 5.4 WhatsApp send detail

`otp_verify` is an **Authentication-category** template. The Cloud API call must put the code in BOTH the `body` parameter and the OTP
**copy-code button** parameter. `sendTemplateMessage` may need a small extension (an `otpCode` option that emits a
`{ type: 'button', sub_type: 'url'|'copy_code', index: '0', parameters: [{ type:'text', text: code }] }` component) — mirrors the
`buttonUrlParam` extension done for the reschedule manage button.

## 6. Widget changes (`avoqado-booking-widget`)

### 6.1 API client (`src/api/booking.ts`)

```ts
requestOtp(slug, { phone?: string; email?: string }): Promise<{ ok: true }>
verifyOtp(slug, { phone?: string; email?: string; code: string }): Promise<AuthResponse> // { token, customer }
```

### 6.2 Login UI (`CustomerPortal` login)

Primary: **"Entrar con WhatsApp"**:

1. Phone field → "Enviar código" → `requestOtp`.
2. 6-digit code field → "Verificar" → `verifyOtp` → store the customer token (same as today's `loginCustomer`) → portal opens.
3. "Reenviar código" with a 30s cooldown; "usar email" fallback link; "o entra con email y contraseña" keeps the existing form as a
   secondary option.

i18n (es + en): phone label, "te enviamos un código por WhatsApp", code label, resend, and errors (expired / invalid / too-many-attempts).
No hardcoded user-facing strings.

## 7. Error handling

| Condition                        | HTTP         | Customer message                                 |
| -------------------------------- | ------------ | ------------------------------------------------ |
| Rate-limited (too many requests) | 429          | "Espera un momento antes de pedir otro código."  |
| Code expired                     | 400          | "El código expiró. Pide uno nuevo."              |
| Wrong code                       | 400          | "Código incorrecto." (generic; attempts counted) |
| Too many attempts                | 400          | "Demasiados intentos. Pide un código nuevo."     |
| Request (unknown phone)          | 200 `{ ok }` | never reveals existence                          |

All Zod messages in Spanish; shape/format only in Zod, business rules in the service.

## 8. MCP

Conscious decision: **N/A**. OTP login is customer self-service authentication; there is no sensible ops MCP tool for "log a customer in"
(an agent must not impersonate a customer login). No MCP tool is added. (Recorded explicitly per the MCP-in-sync rule — decided, not
forgotten.)

## 9. Security

- Codes are 6 digits, **hashed** (sha256 + server pepper) at rest, 10-min expiry.
- Verify caps at 5 attempts/challenge; new request expires prior challenges.
- Request rate-limited per destination (1/30s, 5/hour) + per IP.
- Generic responses: `request` always `{ ok }`; `verify` errors don't distinguish "no such phone" from "wrong code".
- Phone normalized to E.164; email lowercased.
- Pepper from env (e.g., `OTP_PEPPER`), validated at boot.

## 10. Testing

**Backend (Jest):**

- `requestOtp`: generates + stores a hash (never plaintext), sends on the chosen channel, rate-limits per destination, always returns
  `{ ok }`, expires prior challenges.
- `verifyOtp`: success → returns a customer-token; expired → 400; wrong code → `attempts++`; exceeding `maxAttempts` → invalidated; generic
  errors.
- Identity resolution: creates/links `Consumer` + per-venue `Customer`, issues a customer-token; existing email/password `Customer` for the
  same phone is linked (not duplicated).
- Email fallback channel path.

**Widget:** `vite build` passes; manual E2E (phone → real WhatsApp code → verify → portal), same method used to validate reschedule. Verify
in logs that `otp_verify` was sent.

## 11. Rollout / compatibility

- Additive: new table, new routes, new `AuthProvider.PHONE`, new widget option. Email+password login and the magic link are untouched.
- Deploy order: backend (`avoqado-server`) first → then widget. The widget OTP option only appears after the widget deploys; backend
  endpoints are inert until called.
- Migration: a one-time Prisma migration adds `OtpChallenge` + the enum value.

## 12. Impact & interference (reviewed — no breaking changes)

All changes are **additive**. Verified blast radius:

- **`Customer` has `@@unique([venueId, phone])` + `@@unique([venueId, email])`** → identity resolution uses an **upsert on (venueId,
  phone)**; duplicates are impossible by constraint.
- **Booking does not auto-create `Customer`** (it stores `guestPhone` + optional `customerId`) → OTP-created Customers don't collide with
  booking. The portal surfaces past reservations by matching the customer's phone to `guestPhone`.
- **`sendTemplateMessage`** already takes an optional `buttonUrlParam`; the OTP copy-code button is **another optional param** — existing
  sends (confirmation, reminder, reschedule, receipts) are untouched.
- **`AuthProvider.PHONE`** is additive; no exhaustive `switch(AuthProvider)` exists that would break (consumer auth does value checks like
  `=== 'GOOGLE'`; other `switch(provider)` are the fiscal/payment enums, unrelated).

**To handle carefully (not breaks):**

- **`Consumer.phone` is NOT unique** (`email @unique` + `@@index([phone])` only), and the consumer-app creates `Consumer`s via OAuth
  (Google/Apple, email-keyed). OTP identity resolution must therefore: find `Consumer` by phone → **0 → create; 1 → use; >1 → pick the
  oldest + log for ops to merge**. v1 does **not** auto-unify an OAuth(email) Consumer with an OTP(phone) Consumer (separate until a record
  carries both) — a documented limitation, not a regression to the consumer-app.

**Coordination (logistics, not breaks):**

- `prisma/schema.prisma`, `public.routes.ts`, and `whatsapp.service.ts` are being edited by a parallel session (CFDI/sales). **Sequence the
  Prisma migration** (new table + enum value) after theirs, and add routes/params **additively** to avoid merge conflicts.

## 13. Open questions

- None blocking. (Future: SMS fallback; auto-unify OAuth(email) ↔ OTP(phone) Consumers when a record carries both; promote the session to
  the consumer-app via the `Consumer` link; "remember this device" longer-lived tokens.)
