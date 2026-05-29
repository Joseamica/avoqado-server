# Onboarding Payment Providers — Design Spec

**Date:** 2026-05-27
**Status:** Approved for implementation planning
**Repos affected:** `avoqado-server`, `avoqado-web-dashboard`

## Problem

A merchant who completes the V2 setup wizard today leaves with a venue that
cannot accept online payments (checkout web, payment links, booking deposits)
until they manually visit `/venues/:slug/ecommerce-merchants` and complete a
separate flow per provider. The friction is high enough that many never come
back, and they reach out to support thinking "Avoqado doesn't work for online
payments."

The marketplace integrations exist and work in production:

- Mercado Pago marketplace OAuth (`src/services/mercado-pago/*`,
  routes at `src/routes/mercado-pago.routes.ts`)
- Stripe Connect (`src/services/dashboard/stripeConnect.service.ts` +
  `src/services/payments/providers/stripe-connect.provider.ts`)
- A wizard component (`EcommerceMerchantWizard.tsx`) that exposes them after
  the venue is already onboarded

This spec moves the connect step into the onboarding wizard as an explicit,
**optional** Step 8 so the merchant can leave fully activated.

## Goals

1. Let a new merchant connect Mercado Pago and/or Stripe Connect during
   onboarding, without forcing them to.
2. Preserve full wizard progress across the OAuth round-trip — closing the tab,
   timing out, or switching browsers must not lose state.
3. Offer an immediate confidence-builder: a real test payment link delivered
   via WhatsApp + on-screen.
4. Ship behind an env flag so we can roll back cleanly if anything regresses.

## Non-goals

- **No new provider integrations.** Mercado Pago and Stripe Connect are the
  only providers in scope. Conekta, Clip, etc. stay in the post-onboarding flow.
- **No KYC docs upload.** Per user direction, this remains optional and
  outside the wizard.
- **No subscription billing.** Stripe Connect ≠ Stripe Billing.
- **No banner for skippers in `/home`.** Tracked as a follow-up (see
  "Out of scope" below).
- **No legacy `/integrations/mercadopago` page rework.** It continues to handle
  the existing post-onboarding flow unchanged.

---

## User flow (Step 8)

Step 8 is a small state machine with four UI views, all inside the same wizard
shell so the user never feels they have left.

### View A — empty

```
Activa cobros online (opcional)
Conecta Mercado Pago o Stripe para recibir pagos por checkout y ligas de pago.

┌──────────────┐  ┌──────────────┐
│ Mercado Pago │  │ Stripe       │
│ [Conectar]   │  │ [Conectar]   │
└──────────────┘  └──────────────┘

Saltar por ahora →   (text link, not a button)
```

### View B — during OAuth

User has been redirected to the provider's hosted page. The wizard tab is
either replaced (preferred) or backgrounded. The OAuth provider drives this
view entirely.

### View C — return with at least one provider connected

```
¡Conectaste Mercado Pago!  ✓

┌──────────────┐  ┌──────────────┐
│ Mercado Pago │  │ Stripe       │
│ ✓ Conectado  │  │ [Conectar]   │
└──────────────┘  └──────────────┘

¿Quieres probarlo con una liga de pago real?
[Generar liga de prueba]   [Terminar onboarding →]
```

Connecting the second provider re-renders View C with both tiles green.

### View D — test payment link sub-flow

```
Monto a cobrar
[ $ ____ ] MXN

[Enviar liga por WhatsApp y mostrar aquí →]

After submit:
✓ Liga enviada a +52 664 844 2154 por WhatsApp
📋 También aquí: https://mp.com/pay/abc123   [Copiar]
[QR rendered inline]

[Terminar onboarding →]
```

### Skip semantics

The "Saltar por ahora" link is available in View A and View C. Pressing it
sets `step8_paymentProviders.skipped = true` and exits the wizard normally.
The merchant lands at `/venues/:slug/home` as today.

---

## State persistence — OAuth round-trip

Three layers cooperate to keep wizard state intact even when the user is bounced
to a third-party domain.

### Layer 1 — OAuth state JWT carries wizard context

`mercado-pago/oauth.service.ts:signState()` already issues a 10-minute HMAC-signed
JWT carrying `{ venueId, ecommerceMerchantId }`. Extend the payload:

```typescript
interface MercadoPagoOAuthState {
  venueId: string
  ecommerceMerchantId: string
  returnTo?: 'wizard'  // new — present when initiated from the setup wizard
  iat: number
  exp: number
}
```

`/oauth/connect` receives a new optional query param `from=wizard`. The
controller forwards it into the state payload. If absent, the JWT shape is
unchanged and legacy behavior is preserved.

### Layer 2 — Callback routes to the wizard

`mercadoPagoOAuth.controller.ts:callback` today redirects to
`${dashboardUrl}/integrations/mercadopago?mp_status=...`. After the change:

```typescript
const wizardReturn = statePayload.returnTo === 'wizard'
const targetPath = wizardReturn
  ? `/setup#step-7?mp_status=${status}&merchantId=${merchantId}${errorParams}`
  : `/integrations/mercadopago?mp_status=${status}${errorParams}`
return res.redirect(`${dashboardUrl}${targetPath}`)
```

**Hash convention.** The URL hash is zero-indexed against the visible
`SETUP_STEPS` array (`#step-0` = Business Info, the first visible step).
Adding Payment Providers as the eighth visible step lands at `#step-7`.
The backend `currentStep` is 1-indexed and includes the signup step,
so the same step is `currentStep = 8` server-side.

Stripe Connect is simpler: `accountLinks.create()` already accepts explicit
`return_url` and `refresh_url`. The wizard-initiated call passes
`${frontendUrl}/setup#step-7?stripe_status=success` and a matching refresh URL.

### Layer 3 — Wizard hydrates from URL + DB

`SetupWizard.tsx` already restores `currentStep` and `v2SetupData` on mount via
`GET /api/v1/onboarding/status`. Two additions:

1. **Pre-redirect save.** Before initiating OAuth, the wizard calls
   `saveV2StepData(8, { mpConnecting: true })` (or `stripeConnecting`). This
   guarantees `currentStep ≥ 8` in DB so a tab close + return resumes at Step 8.

2. **URL-param hydration.** On Setup mount, if the URL contains
   `?mp_status=success&merchantId=X` (or stripe equivalent), the wizard:
   - Jumps to Step 8.
   - Issues `GET /api/v1/dashboard/venues/:id/ecommerce-merchants` to verify
     the merchant exists and is `COMPLETED` or `IN_PROGRESS`.
   - Renders View C with the appropriate tile green.

3. **DB-resolved fallback.** Even without URL params, if the venue already has
   any `EcommerceMerchant` row, Step 8 opens at View C with the right tiles
   green. This covers users who closed the tab and returned days later.

### Schema additions

`OnboardingProgress.v2SetupData.step8_paymentProviders`:

```json
{
  "mpMerchantId": "string | null",
  "stripeMerchantId": "string | null",
  "skipped": "boolean",
  "lastUpdatedAt": "ISO timestamp"
}
```

The corresponding TypeScript type lives in
`src/services/onboarding/onboardingProgress.service.ts:OnboardingStepData` and
the frontend `src/pages/Setup/types.ts:SetupData`.

---

## Test payment link

New backend endpoint:

```
POST /api/v1/onboarding/:venueId/test-payment-link
Body: { amount: number, providerCode: 'MERCADO_PAGO' | 'STRIPE' }
Auth: authContext required, must own venue
Response:
{
  url: string          // hosted checkout URL
  qrCodeUrl: string    // data: URL of QR SVG, rendered client-side
  whatsappSent: boolean
}
```

Lives in `src/services/onboarding/testPaymentLink.service.ts` (new). It is a
thin facade over the existing `provider-registry.ts`:

1. Validate amount: integer MXN, between 1 and 10000.
2. Look up the venue's `EcommerceMerchant` for the requested provider, status
   `COMPLETED` only. Reject with 400 otherwise.
3. Call `providerRegistry.getProvider(code).createPaymentLink({ venueId, amount,
   description: 'Liga de prueba — Avoqado onboarding' })`.
4. Generate QR (use existing `qrcode` package — already a dep of payment links).
5. Send WhatsApp via existing `whatsapp.service.ts` to `venue.phone`. Message:
   `Probando tu nueva cuenta de cobros en Avoqado. Liga de prueba: {url}`.
   Failure to deliver is non-fatal — return `whatsappSent: false` and let the UI
   surface the URL.
6. Return.

The endpoint is venue-scoped and auth-gated, but does not require a special
permission since it is the wizard owner using their own venue.

---

## Failure mode matrix

| Scenario | Detection | UX response |
|---|---|---|
| User cancels at provider | `?mp_status=error&reason=user_denied` | View A with inline error "Cancelaste la conexión. Reintentar o saltar." |
| Provider rejects credentials | `?mp_status=error&reason=auth_failed` | View A with inline error + link to provider docs. |
| State JWT expired (>10 min) | Backend `verifyState` throws | Redirect to `/setup#step-7?mp_status=error&reason=expired`. View A: "La sesión expiró, reinicia la conexión." |
| Tab closed during OAuth | Backend completes silently if provider redirects; merchant row exists in DB | On next `/setup` load, DB hydration shows View C automatically. |
| Browser switch / different device | Callback persists to DB, not session | Next sign-in on any device hydrates Step 8 from DB. |
| User skips | `step8_paymentProviders.skipped=true` | Wizard ends normally. Persistent home banner is **out of scope** for this spec; tracked as follow-up. |
| Stripe partial onboarding (`RESTRICTED`) | Stripe redirects success but merchant `onboardingStatus=RESTRICTED` | View C tile shows "✓ Conectado · ⚠ Stripe pidió más info" + deep link to Stripe dashboard. |
| Test link: cancelled by user | Provider webhook `cancelled` | No UI change. Test is informational. |
| Test link: WhatsApp delivery fails | `whatsapp.service.send` returns `false` | Toast: "No pudimos enviar por WhatsApp. La liga sigue disponible aquí." UI still renders URL + QR. |

---

## Backend changes (summary)

| File | Change |
|---|---|
| `src/services/mercado-pago/oauth.service.ts` | Add `returnTo` field to state payload. |
| `src/controllers/dashboard/mercadoPagoOAuth.controller.ts` | Accept `?from=wizard` on `/connect`. Branch redirect target on callback based on `state.returnTo`. |
| `src/services/dashboard/stripeConnect.service.ts` | Accept dynamic `return_url` / `refresh_url` when creating account links. |
| `src/services/onboarding/onboardingProgress.service.ts` | Add `step8_paymentProviders` to `OnboardingStepData` and reading logic. |
| `src/controllers/onboarding.controller.ts` | Extend `getV2SetupDataForCompletion` to surface `step8_paymentProviders`. |
| `src/services/onboarding/testPaymentLink.service.ts` | **NEW** — facade for generating + delivering the test payment link. |
| `src/routes/onboarding.routes.ts` | New route `POST /:venueId/test-payment-link`. |
| Tests | New unit tests for oauth state + returnTo, callback branching, test-payment-link service. |

## Frontend changes (summary)

| File | Change |
|---|---|
| `src/pages/Setup/SetupWizard.tsx` | Add Step 8 to the steps array. Hydrate URL params for `mp_status` / `stripe_status`. Pre-save `step8` flag before OAuth redirect. |
| `src/pages/Setup/steps/PaymentProvidersStep.tsx` | **NEW** — renders Views A, C, D. Handles provider tiles, skip, test link sub-flow. |
| `src/pages/Setup/types.ts` | Add `paymentProviders` to `SetupData`. |
| `src/services/setup.service.ts` | New `testPaymentLink({ amount, providerCode })` method. |
| `src/locales/es/setup.json`, `en/setup.json` | New keys for step 8 strings. |
| Tests | Snapshot + interaction test for `PaymentProvidersStep`. |

Estimated total: ~600–800 LOC + ~200 LOC tests. Two implementation sessions.

---

## Rollout

**Feature flag.** All new behavior is gated on
`process.env.ENABLE_ONBOARDING_PAYMENT_PROVIDERS === 'true'`. When false:

- Backend `getV2SetupDataForCompletion` returns 7 steps as today.
- Frontend `SetupWizard.tsx` does not include Step 8 in its array.
- OAuth callback ignores `returnTo` (existing behavior).
- Test-payment-link endpoint returns 404.

This makes rollback a one-line env-var change with no DB migration.

**Existing merchants.**

- Onboarding-completed venues (`status ≠ ONBOARDING`) see no change.
- Mid-onboarding venues (`status = ONBOARDING`, `currentStep ≤ 7`) see Step 8
  the next time they enter the wizard. No data migration required;
  `step8_paymentProviders` is optional.

---

## Testing strategy

### Unit (backend)

- `oauth.service.signState` / `verifyState` — `returnTo` round-trips.
- `mercadoPagoOAuth.controller.callback` — redirect URL differs when
  `state.returnTo === 'wizard'`.
- `testPaymentLink.service` — happy path, missing merchant, WhatsApp failure
  still returns `url`.

### Integration / e2e (frontend)

- Mocked OAuth: click Connect → simulated callback URL params → assert View C
  rendered with green tile.
- DB-resolved Step 8: venue with an existing `EcommerceMerchant` row → assert
  Step 8 opens at View C without any URL params.
- Skip flow: click "Saltar por ahora" → wizard completes, no merchant row
  created, `step8_paymentProviders.skipped=true` in DB.

### Manual QA (real OAuth)

- Connect a real MP account in production-equivalent env.
- Connect a Stripe Connect test-mode account.
- Generate a 5 MXN test link and pay it from a phone.
- Close the tab mid-OAuth, reopen `/setup` — verify Step 8 resumes at the
  correct view.

### Out of scope for automated tests

- WhatsApp delivery reliability (already covered by `whatsapp.service` tests).
- Stripe-hosted onboarding UI itself.
- MP marketplace sandbox (known broken per project memory).

---

## Out of scope / follow-ups

These are deliberately deferred so the spec stays shippable in two sessions:

1. **Persistent home banner** for users who skipped payment providers. UI
   pattern TBD — could reuse `KYCStatusBanner.tsx`.
2. **Provider auto-suggest by business type.** E.g. food trucks see MP-first
   because they go in-person + online; services see Stripe-first. Data needed.
3. **Multiple Stripe Connect accounts per venue.** Today the wizard assumes
   one of each. Multi-channel comes later.
4. **Auto-refund of the 1 MXN test charge.** Currently the merchant keeps it.

---

## Open questions

None as of approval. Spec is implementation-ready.
