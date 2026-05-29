# Onboarding TPV Purchase — Design Spec

**Date:** 2026-05-29
**Status:** Approved for implementation planning
**Repos affected:** `avoqado-server`, `avoqado-web-dashboard`
**Related spec:** `2026-05-27-onboarding-payment-providers-design.md`

## Problem

A new merchant who finishes the V2 setup wizard today reaches `/home` without
a physical terminal in their account. The buying experience exists
(`/venues/:slug/tpv?action=buy` opens `TerminalPurchaseWizard`), and the home
checklist nudges them toward it — but the friction of "land at home → discover
the checklist → click → wait → return to home" is enough that many never
follow through, then ask support "where do I buy the terminal?"

This spec moves the TPV purchase into the setup wizard as an explicit,
**always optional** Step 9 so the merchant who wants hardware can leave fully
ordered, while everyone else exits the wizard exactly as they do today.

The complete purchase pipeline already ships in production:

- `TerminalPurchaseWizard.tsx` — 4-step modal (catalog → shipping → payment →
  confirmation)
- `createOrder` + Stripe Checkout for card / SPEI bank transfer
- Magic-link approval, serial assignment, shipped email
- TPV catalog with PAX A910S, NexGo N62, NexGo N86, free 4G SIM included

This spec wires that pipeline into the onboarding wizard. **It does not
rewrite or duplicate any of the purchase flow.**

## Goals

1. Let a new merchant buy a TPV during onboarding, without forcing them to.
2. **The step never blocks completion.** Regardless of order state — no order,
   pending SPEI, paid, awaiting serials, shipped — the merchant can always
   click "Terminar onboarding →" and reach `/home`.
3. Preserve the existing purchase wizard verbatim; the setup step is a thin
   wrapper that opens it and hydrates from its result.
4. Survive the OAuth-equivalent round-trip: a tab close mid-purchase, or a
   Stripe Checkout redirect, must resume at Step 9 with the right state.
5. Ship behind an env flag so we can roll back cleanly.

## Non-goals

- **No changes to `TerminalPurchaseWizard`.** Its 4 steps stay identical. We
  pass one new prop (`from='setup'`) and observe its completion callback.
- **No changes to the TPV order lifecycle.** Same states (`CREATED`,
  `AWAITING_SPEI`, `SPEI_RECEIVED`, `PAID`, `AWAITING_SERIALS`,
  `SERIALS_ASSIGNED`, `SHIPPED`, `DELIVERED`), same magic-link flow, same
  emails.
- **No changes to the home checklist's `buy-tpv` step.** That stays as the
  post-onboarding fallback for users who skipped here.
- **No new payment methods.** Card via Stripe Checkout + SPEI manual transfer
  are the only options, same as today.
- **No subscription billing for the TPV itself.** One-time purchase only.
- **No catalog-management surface during onboarding.** The 3 fixed models
  shown today are the 3 models shown in the step.

---

## User flow (Step 9)

Step 9 is a small state machine with three UI views, all inside the same
wizard shell so the user never feels they have left.

### View A — empty (no order)

```
Paso 9 de 9

Compra tu terminal de pago (opcional)
Cobra presencial con una terminal física. SIM con internet 4G incluida.

┌────────────────────────────────────────┐
│ Modelos disponibles                     │
│ • PAX A910S   $4,000 + IVA             │
│ • NexGo N62   $1,800 + IVA             │
│ • NexGo N86   $3,000 + IVA             │
│                                         │
│       [ Ver catálogo y comprar → ]      │
└────────────────────────────────────────┘

Saltar por ahora →
```

Clicking the CTA opens `TerminalPurchaseWizard` as a `FullScreenModal`
overlay. The setup wizard's state persists underneath; closing the modal
without checking out returns to View A unchanged.

### View B — order exists (any state)

After the user finishes the purchase wizard (SPEI or Card success), the modal
closes and View B renders:

```
Paso 9 de 9

✓ Pedido AVO-0003 creado

  Producto:    1 × PAX A910S
  Total:       $4,640.00 MXN (con IVA)
  Estado:      Esperando comprobante SPEI
  Envío a:     Av. Reforma 123, CDMX

Te enviamos las instrucciones al correo. Puedes terminar el onboarding
ahora — no necesitas esperar el pago.

[ Ver detalles del pedido ]    [ Terminar onboarding → ]
```

State variations:

| Order state | Status line | Secondary message |
|---|---|---|
| `AWAITING_SPEI` | Esperando comprobante SPEI | "Sube tu comprobante en TPV → Pedidos cuando estés listo." |
| `SPEI_RECEIVED` | Comprobante recibido — revisando | "Te notificaremos por correo cuando lo aprobemos." |
| `PAID`, `AWAITING_SERIALS` | Pago confirmado | "Asignaremos tu terminal en las próximas horas." |
| `SERIALS_ASSIGNED`, `SHIPPED` | Tu terminal está en camino | "Te enviamos los detalles de envío al correo." |
| `DELIVERED` | Entregada | "Empieza a cobrar desde TPV → Equipos." |
| `REJECTED`, `EXPIRED`, `CANCELED` | Pedido cancelado | "Puedes intentar de nuevo o saltar este paso." + show CTA again |

"Terminar onboarding →" is **always** enabled in View B. The order continues
its lifecycle independently after the user leaves the wizard.

### View C — skipped

The "Saltar por ahora" link in View A and the implicit skip when the user
clicks "Terminar onboarding →" without ever opening the purchase wizard both
set `step9_tpvPurchase.skipped = true` and complete onboarding normally. The
merchant lands at `/home` where `HomeSetupChecklist.buy-tpv` continues to
nudge them.

### Skip semantics

The link is text-only (not a button) to keep visual emphasis on the primary
action. After skip, no order is created. The merchant can buy later via the
home checklist or `/tpv?action=buy` with no state lost.

---

## State persistence — Stripe Checkout round-trip + tab-close

Three layers cooperate so the step survives a third-party redirect or a tab
close mid-purchase.

### Layer 1 — Stripe Checkout `success_url` carries wizard context

Today `createCheckoutSession` builds a `success_url` that lands at
`/tpv/orders/:id`. We add an optional `from` parameter:

```typescript
interface CreateCheckoutSessionParams {
  orderId: string
  venueId: string
  from?: 'tpv' | 'setup'  // new — default 'tpv' preserves current behavior
}
```

When `from === 'setup'`, the session's `success_url` becomes:

```
${frontendUrl}/setup?tpv_status=success&orderId=${orderId}#step-8
```

And `cancel_url` becomes:

```
${frontendUrl}/setup?tpv_status=cancel#step-8
```

For SPEI, no Stripe redirect happens — the order is created and the modal
closes inline. The setup wizard observes completion via the modal's
`onComplete(orderId)` callback. So `from` only matters for card payments.

### Layer 2 — Wizard hydrates from URL + DB on mount

`SetupWizard.tsx` already handles `?mp_status=success` and
`?stripe_status=success` for payment providers. We add a third branch for
`?tpv_status=success&orderId=X`:

1. Jump to Step 9.
2. Issue `GET /api/v1/dashboard/venues/:venueId/tpv-orders/:orderId` to
   confirm the order exists.
3. Render View B with the order's current status.

If the URL has no params (clean reload, different device, days later), the
wizard issues `GET /api/v1/dashboard/venues/:venueId/tpv-orders?limit=1` to
fetch the **most recent** order. If one exists, render View B with it; else
View A.

### Layer 3 — Wizard state persistence before redirect

Before opening Stripe Checkout, the wizard calls
`saveStep(9, { tpvOrderId: 'order-id', orderCreating: true })`. This
guarantees `currentStep ≥ 9` in DB so a tab close followed by return to
`/setup` resumes at Step 9 with the order ID known.

For SPEI, the modal closes after order creation; the wizard immediately calls
`saveStep(9, { tpvOrderId, skipped: false })`. No redirect involved.

### Schema additions

`OnboardingProgress.v2SetupData.step9_tpvPurchase`:

```json
{
  "tpvOrderId": "string | null",
  "skipped": "boolean",
  "lastUpdatedAt": "ISO timestamp"
}
```

The corresponding TypeScript types live in:
- Backend: `src/services/onboarding/onboardingProgress.service.ts:V2Step9Data`
- Frontend: `src/pages/Setup/types.ts:SetupData.tpvPurchase`

### Hydration rules

| Trigger | Behavior |
|---|---|
| URL has `?tpv_status=success&orderId=X` | Force Step 9, fetch order, render View B |
| URL has `?tpv_status=cancel` | Force Step 9, no order fetch, render View A, toast "Compra cancelada" |
| Clean reload, `v2SetupData.step9_tpvPurchase.tpvOrderId` exists | Fetch that order, render View B |
| Clean reload, no step9 data, fallback query returns most recent order | Render View B with that order |
| Clean reload, no step9 data, no orders | Render View A |
| `step9_tpvPurchase.skipped === true` | Don't auto-hydrate; render View A (user already skipped, but can change mind) |

The "user already skipped" case still allows buying — skip is not sticky
across re-entries.

---

## Reusing `TerminalPurchaseWizard`

The existing component takes `open`, `onOpenChange`, `venueId`, and emits a
completion event. We add one prop:

```typescript
interface TerminalPurchaseWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  venueId: string
  /** Where the wizard was opened from — affects Stripe redirect URLs. */
  from?: 'tpv' | 'setup'  // new
  onComplete?: (result: { orderId: string; paymentMethod: 'CARD' | 'SPEI' }) => void  // new
}
```

`from` is forwarded to `createOrder` API call → forwarded to
`createCheckoutSession` → embedded in `success_url` / `cancel_url`.

`onComplete` fires from Step4 of the wizard:
- For SPEI: fires after `createOrder` returns successfully.
- For Card: does **not** fire here — Stripe redirect takes over. The setup
  wizard observes completion via URL params on return.

The setup step receives `onComplete` and:
1. Saves to `v2SetupData.step9_tpvPurchase`.
2. Closes the modal.
3. Switches to View B.

### Why a wrapper instead of inlining

Inlining the 4 steps into the setup wizard would mean ~1500 LOC of duplication
and two state machines to keep in sync forever. The wrapper:

- Keeps the purchase wizard as the single source of truth for catalog,
  shipping form, payment method selection.
- Lets us ship bug fixes once (the address autocomplete + manual fallback
  improvements from this morning already apply here).
- Keeps the setup step small (~150 LOC) and testable in isolation.

---

## Failure mode matrix

| Scenario | Detection | UX response |
|---|---|---|
| User opens modal, closes without buying | Modal `onOpenChange(false)`, no `onComplete` | Step stays at View A. No state change. |
| Card payment cancelled at Stripe | `?tpv_status=cancel` on return | View A + toast: "Compra cancelada. Puedes intentar de nuevo o saltar." |
| Card payment succeeds | Stripe webhook → order PAID → `?tpv_status=success&orderId=X` | View B with PAID state. |
| SPEI order created, never paid | `onComplete` fires with state AWAITING_SPEI | View B; "Terminar onboarding →" still enabled. User can leave; SPEI flow continues async. |
| Tab closed mid-purchase (before order creation) | No DB record, no URL params | On return: View A. Nothing to recover. |
| Tab closed after order creation, before Stripe redirect | DB has order in CREATED state | On return: View B with order. Allow "Reanudar pago" CTA that re-creates a Stripe session or shows SPEI instructions. |
| Tab closed during Stripe redirect | Stripe completes webhook → order PAID. No URL params on next setup load. | Fallback query returns the PAID order; View B. |
| Order rejected by sales (SPEI proof bad) | Order state `REJECTED`. | View B shows "Pedido cancelado", CTA to start over. |
| Backend `tpv-orders` API errors | `useQuery` reports error | Toast + render View A (don't block onboarding). |
| Stripe Checkout returns `success` but webhook hasn't fired yet | Order state still `AWAITING_PAYMENT` momentarily | View B shows "Procesando pago…" with auto-refresh every 3s for 30s. After that, optimistic "Pago en proceso, te notificaremos al correo". |
| Server down at "Terminar onboarding →" click | `completeSetup` API error | Toast + stay at Step 9. **Do not lose order data.** |

---

## Backend changes (summary)

| File | Change |
|---|---|
| `src/services/dashboard/terminalOrder/createCheckoutSession.ts` | Accept `from?: 'tpv' \| 'setup'`. Branch `success_url` / `cancel_url`. |
| `src/services/dashboard/terminalOrder/createOrder.service.ts` | Forward `from` to checkout session creation. |
| `src/controllers/dashboard/terminalOrder.dashboard.controller.ts` | Accept `from` in request body, forward to service. |
| `src/services/onboarding/onboardingProgress.service.ts` | Add `V2Step9Data` typing + read helper. |
| `src/controllers/onboarding.controller.ts` | Extend `getV2SetupDataForCompletion` to surface `tpvOrderId` + order status. |
| `src/config/featureFlags.ts` (or inline) | Expose `ENABLE_ONBOARDING_TPV_PURCHASE`. |
| Tests | Unit tests for `from` branching in checkout session, order hydration in onboarding controller. |

## Frontend changes (summary)

| File | Change |
|---|---|
| `src/pages/Setup/SetupWizard.tsx` | Conditionally add `BuyTpvStep` to `SETUP_STEPS`. Hydrate URL params for `tpv_status`. |
| `src/pages/Setup/steps/BuyTpvStep.tsx` | **NEW** — renders Views A, B. Hosts the embedded `TerminalPurchaseWizard`. |
| `src/pages/Setup/types.ts` | Add `tpvPurchase` to `SetupData`. |
| `src/services/setup.service.ts` | No new methods — reuse `tpvOrderService` directly. |
| `src/pages/Tpv/components/purchase-wizard/TerminalPurchaseWizard.tsx` | Accept `from` + `onComplete` props. |
| `src/pages/Tpv/components/purchase-wizard/wizard-steps/Step4Confirmation.tsx` | Fire `onComplete` for SPEI flow. |
| `src/services/tpvOrder.service.ts` | Forward `from` in `createOrder` payload. |
| `src/locales/es/setup.json`, `en/setup.json` | New keys for step 9 strings. |
| Tests | Snapshot + interaction test for `BuyTpvStep` (View A → click CTA → modal opens → mock SPEI completion → View B). |

Estimated total: ~500–700 LOC + ~200 LOC tests. Two implementation sessions.

---

## Rollout

**Feature flag.** All new behavior gates on
`process.env.ENABLE_ONBOARDING_TPV_PURCHASE === 'true'`. When false:

- Backend `getV2SetupDataForCompletion` returns 8 steps as today (payment
  providers + the 6 before it).
- Backend `createCheckoutSession` ignores `from` (existing behavior).
- Frontend `SetupWizard.tsx` does not include `BuyTpvStep` in its array.
- `HomeSetupChecklist.buy-tpv` remains the only entry point.

One-line env-var change rolls back. No DB migration required;
`step9_tpvPurchase` is an optional field in JSON state.

**Existing merchants.**

- Onboarding-completed venues (`status ≠ ONBOARDING`) see no change.
- Mid-onboarding venues see Step 9 the next time they enter the wizard.
- Venues with an in-flight TPV order from the home checklist: when they
  re-enter onboarding (if they do), Step 9's hydration logic finds the order
  and renders View B. No data conflict.

---

## Testing strategy

### Unit (backend)

- `createCheckoutSession` — `success_url` differs when `from === 'setup'`.
- `onboardingProgress.service` — `step9_tpvPurchase` round-trips through
  `getV2SetupData` and `saveV2StepData`.
- `getV2SetupDataForCompletion` — surfaces `tpvOrderId` from `step9` plus
  fallback query for the most recent order.

### Integration / e2e (frontend)

- Skip flow: View A → click "Saltar por ahora" → wizard completes, no order
  row, `step9_tpvPurchase.skipped=true`.
- SPEI flow: View A → CTA → modal → SPEI selected → confirm → modal closes →
  View B shows `AWAITING_SPEI` → "Terminar onboarding →" completes.
- DB-resolved Step 9: venue with an existing `TerminalOrder` → Step 9 opens
  at View B without URL params.
- URL-hydrated Step 9: load `/setup?tpv_status=success&orderId=X#step-8` →
  Step 9 opens at View B.
- "Terminar onboarding →" works at every order state (AWAITING_SPEI, PAID,
  SHIPPED, REJECTED). **No state ever blocks completion.**

### Manual QA (real Stripe)

- Buy with Stripe test card, complete onboarding mid-redirect, return to
  `/setup` from a different browser — verify View B.
- Start SPEI purchase, close tab, return next day — verify View B with
  pending order.
- Reject a SPEI proof via magic link, return to setup — verify View B shows
  "Pedido cancelado" with CTA to retry.

### Out of scope for automated tests

- Stripe-hosted checkout UI itself.
- Webhook timing edge cases (covered by existing TPV order tests).
- Email delivery (covered by existing tests).

---

## Out of scope / follow-ups

Deliberately deferred to keep this spec shippable in two sessions:

1. **Inline catalog browsing inside Step 9.** Today the catalog shows 3
   models in a static card. A richer comparison UI is future work.
2. **Pre-fill shipping address from `BusinessInfoStep`.** The purchase
   wizard's address autocomplete already accepts an initial value; we can
   wire the venue's primary address into Step2 of the purchase wizard when
   opened from setup. Tracked as a follow-up for the "from='setup'" code
   path.
3. **Banner for skippers on `/home`.** Same out-of-scope item the payment
   providers spec deferred — the home checklist already nudges them.
4. **Quantity > 1 inside Step 9.** The purchase wizard supports it; the
   setup wrapper does not prevent it but doesn't surface it either.

---

## Open questions

None as of draft. Awaiting approval.
