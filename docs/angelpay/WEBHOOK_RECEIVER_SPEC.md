# AngelPay Webhook Receiver — Spec

**Status:** draft
**Date:** 2026-05-25
**Owner:** Avoqado backend
**Scope:** ONLY the receiver endpoint that accepts AngelPay webhook callbacks. Out of scope (later docs): registering/fetching webhook endpoints via AngelPay's `/api/v1/webhooks/endpoints`, surfacing merchant id, dashboard UI.

---

## 1. Goal

Receive AngelPay payment-confirmation callbacks, verify they're authentic, store every event immutably, and reconcile against the `Payment` table — mirroring the proven Blumon TPV pattern (4-layer reconciliation, layer 4).

This is **layer 4 of 4** for AngelPay payments:

1. Nexgo → AngelPay SDK (app-to-app Intent)
2. Nexgo → Avoqado backend (`POST /tpv/fast` records `Payment`)
3. Backend validation (`merchantAccountId` resolution)
4. **AngelPay webhook (this spec)** — independent processor confirmation

---

## 2. Differences vs. Blumon (the reason this spec exists)

| Concern | Blumon TPV | AngelPay |
|---|---|---|
| Auth | IP whitelist (no signature) | **HMAC-SHA256 Svix headers** (`svix-id`, `svix-timestamp`, `svix-signature: v1,<base64>`) |
| Endpoint | 1 fixed URL | **1 URL per merchant account** (`/webhooks/angelpay/:merchantAccountId`) — each has its own Svix secret |
| Event types | 1 (`payment`) | 3 (`send_transaction`, `offline_event`, `canceled_transaction`) |
| Tenant identification | `serialNumber` → Terminal → Venue | `:merchantAccountId` from URL (cross-checked against payload `merchant_id`) |
| Idempotency key | `(operationNumber, reference)` | **`svix-id` header** (Svix guarantees per-event uniqueness) |
| Persistence model | `ProviderEventLog` | **Same `ProviderEventLog`** (`provider: PAYMENT_PROCESSOR`, distinguish by `payload.source` or `eventId` prefix) |
| Match retries | 3 attempts (0/2/3 s) | Same — keep Blumon's `RETRY_CONFIG` |
| PENDING cron | 30 s cadence, 24 h TTL → ORPHANED | Same — clone the cron, scope by event prefix |

---

## 3. Endpoint

```
POST  /api/v1/webhooks/angelpay/:merchantAccountId
GET   /api/v1/webhooks/angelpay/health
```

Registered in `src/routes/webhook.routes.ts` next to the Blumon route. Uses the same `express.raw({ type: 'application/json' })` body parser the file already imposes — Svix signature verification REQUIRES the raw bytes; do **not** mount `express.json()` upstream of this route.

---

## 4. Schema changes (minimal)

Add three columns to `MerchantAccount`. All optional / nullable so the rest of the system is unaffected.

```prisma
model MerchantAccount {
  // ...existing fields...

  // ━━ AngelPay webhook receiver (this spec) ━━
  /// Svix signing secret for this merchant's webhook endpoint.
  /// Encrypted at rest with the same KMS key as `providerCredentials.encryptedCredentials`.
  /// Provisioned manually (paste from AngelPay) until we automate via /webhooks/endpoints.
  angelpayWebhookSecret        String?
  /// AngelPay's endpoint id (`ep_...`) — kept for traceability + future CRUD.
  angelpayWebhookEndpointId    String?
  /// Last time we successfully verified + processed an AngelPay webhook for this merchant.
  /// NULL = never received one. Useful for ops dashboard.
  angelpayWebhookLastReceivedAt DateTime?
}
```

Migration name: `add_angelpay_webhook_fields_to_merchant_account`. **No DB constraint changes — backfill = NULL.**

`ProviderEventLog` already has the columns we need (`provider`, `eventId`, `type`, `payload`, `status`, `errorReason`, `venueId`, `terminalId`, `paymentId`, `processedAt`). No new model.

---

## 5. Request shape (AngelPay → us)

### 5.1 Headers (Svix)

```
svix-id:        msg_2abc...          # unique per event delivery
svix-timestamp: 1716673200            # Unix seconds when AngelPay signed
svix-signature: v1,<base64-hmac>      # may have multiple comma-separated values during key rotation
content-type:   application/json
```

### 5.2 Body (canonical events — taken from manual v1.2, may evolve)

All three events share an outer envelope:

```jsonc
{
  "event_type": "send_transaction" | "offline_event" | "canceled_transaction",
  "event_id":   "evt_...",        // AngelPay's own id (mirror of svix-id when delivered through Svix)
  "merchant_id": "351",            // AngelPay externalUserId — MUST match :merchantAccountId resolution
  "occurred_at": "2026-05-25T18:30:12Z",
  "data": {
    "transaction_id":    "tx_...",
    "external_reference": "<our referenceNumber>",  // we send this in startPayment
    "amount":             123.45,                    // decimal in MXN
    "currency":           "MXN",
    "status":             "APPROVED" | "DECLINED" | "CANCELED" | ...,
    "auth_code":          "987654",
    "card": {
      "last_four":   "1234",
      "brand":       "VISA",
      "entry_mode":  "CHIP" | "CONTACTLESS" | "MAG_STRIPE"
    },
    "operation_type":     "SALE" | "REFUND" | "VOID",
    "processed_at":       "2026-05-25T18:30:10Z"
  }
}
```

**Defensive:** treat every field except `event_type` and `merchant_id` as potentially missing. Same posture as `BlumonWebhookPayload` (lenient validation, log full payload on first surprise shape).

---

## 6. Processing pipeline (mirrors `processBlumonPaymentWebhook`)

`POST /api/v1/webhooks/angelpay/:merchantAccountId`

### Step 0 — Always-respond contract

Like Blumon: **always reply 200** unless the signature itself is invalid (then 401). AngelPay's Svix infrastructure retries on 5xx; we own retry semantics now, so we acknowledge and queue internally.

The only non-200 responses:
- **`401 Unauthorized`** — signature verification failed (this MUST 4xx so AngelPay flags the misconfig).
- **`404 Not Found`** — `:merchantAccountId` doesn't exist in our DB.
- **`410 Gone`** — merchant account exists but `angelpayWebhookSecret = NULL` (we haven't provisioned).

### Step 1 — Resolve merchant + load secret

```ts
const merchantAccount = await prisma.merchantAccount.findUnique({
  where: { id: req.params.merchantAccountId },
  select: {
    id: true,
    venueId: true,
    externalMerchantId: true,
    providerId: true,
    angelpayWebhookSecret: true,
  },
})
if (!merchantAccount) return res.status(404).json({ error: 'unknown merchant' })
if (!merchantAccount.angelpayWebhookSecret) return res.status(410).json({ error: 'webhook not provisioned' })
```

### Step 2 — Verify Svix signature

Use the official `svix` npm package (zero custom crypto):

```ts
import { Webhook } from 'svix'

const wh = new Webhook(decrypt(merchantAccount.angelpayWebhookSecret))
let payload: AngelPayWebhookPayload
try {
  payload = wh.verify(req.body /* raw Buffer */, {
    'svix-id':        req.header('svix-id')!,
    'svix-timestamp': req.header('svix-timestamp')!,
    'svix-signature': req.header('svix-signature')!,
  }) as AngelPayWebhookPayload
} catch {
  logger.warn('🚫 [AngelPay webhook] Invalid signature', { merchantAccountId, svixId: req.header('svix-id') })
  return res.status(401).json({ error: 'invalid signature' })
}
```

The `svix` library handles: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`, base64 decode, constant-time compare, multi-key rotation, and **timestamp tolerance ±5 min** (replay protection — Svix bakes this in).

### Step 3 — Cross-check tenant

```ts
if (payload.merchant_id !== merchantAccount.externalMerchantId) {
  // Defense in depth: URL says "this merchant" but body claims another.
  // Possible misconfig at AngelPay or signature key mixup. Log + 401.
  return res.status(401).json({ error: 'merchant_id mismatch' })
}
```

### Step 4 — Idempotency

```ts
const eventId = `angelpay-${payload.event_type}-${req.header('svix-id')}`
const existing = await prisma.providerEventLog.findFirst({
  where: { provider: 'PAYMENT_PROCESSOR', eventId },
  select: { id: true, status: true, paymentId: true },
})
if (existing) return res.status(200).json({ action: 'DUPLICATE', eventLogId: existing.id })
```

### Step 5 — Insert PENDING

Same pattern as Blumon — persist BEFORE matching, catch `P2002` race:

```ts
const event = await prisma.providerEventLog.create({
  data: {
    provider: 'PAYMENT_PROCESSOR',
    eventId,
    type: payload.event_type,
    payload: payload as unknown as Prisma.InputJsonValue,
    venueId: merchantAccount.venueId,
    status: 'PENDING',
  },
  select: { id: true },
})
```

### Step 6 — Dispatch by event_type

```ts
switch (payload.event_type) {
  case 'send_transaction':       return await handleSendTransaction(event.id, payload, merchantAccount)
  case 'canceled_transaction':   return await handleCanceledTransaction(event.id, payload, merchantAccount)
  case 'offline_event':          return await handleOfflineEvent(event.id, payload, merchantAccount)
}
```

#### 6a. `send_transaction` (the equivalent of Blumon's APROBADA)

Inline match with retry (clone Blumon's `attemptPaymentMatch`):

- Match conditions: `referenceNumber = data.external_reference` OR `authorizationNumber = data.auth_code` OR `processorId = data.transaction_id`
- Scope: `order.venueId = merchantAccount.venueId` (single-venue scope — AngelPay merchants are 1:1 with venue today; no fan-out yet)
- Retry: 3 attempts at 0/2/3 s (same `RETRY_CONFIG`)
- On match: compare `data.amount` ↔ `payment.amount` with `<0.01` tolerance
  - Match → `MATCHED`, write `payment.processorData.angelpayWebhook = { receivedAt, transactionId, authCode, last4 }`
  - Mismatch → `DISCREPANCY`, write `processorData.angelpayDiscrepancy = { detectedAt, webhookAmount, recordedAmount, difference }`
- On miss: stay `PENDING`, cron picks it up

If `data.status !== 'APPROVED'`: persist `ERROR/NOT_APPROVED`, return 200.

#### 6b. `canceled_transaction` (refund / void confirmation)

- Match by `data.transaction_id` against `Payment.processorData.angelpayTransactionId` OR by `external_reference`
- On match: stamp `payment.processorData.angelpayCanceledAt + canceledReason`. Do NOT mutate `payment.status` from webhook — backend already has its own cancel flow. Use this only for reconciliation + audit.
- On miss: `PENDING` → cron.

#### 6c. `offline_event` (terminal accumulated offline txs and batched them)

- Same match logic as 6a, but the `external_reference` may be NULL (offline txs sometimes lack one).
- If `external_reference` is missing, attempt by `(auth_code + amount + venueId + timeWindow ±10 min)`.
- If still no match after retries: `PENDING`, cron retries.
- Ops dashboard should surface these prominently — they represent the highest reconciliation risk.

### Step 7 — Finalize event row

Identical to Blumon's `updateEventLogFromMatchResult`. Touch `merchantAccount.angelpayWebhookLastReceivedAt = NOW()` on every successful processing (any non-PENDING terminal state).

---

## 7. Cron worker — `reconcileAngelPayPendingWebhooks`

Clone `reconcileBlumonPendingWebhooks` 1:1. Differences:

- Query: `provider='PAYMENT_PROCESSOR'` AND `eventId LIKE 'angelpay-%'`
- Per-event: call `reconcileAngelPayEvent(eventLogId, payload)` (which re-runs the matcher with `skipRetries: true`)
- TTL: 24 h → mark `ERROR / ORPHANED`
- Cadence: 30 s

Add to the same cron registration site as the Blumon worker.

---

## 8. Bidirectional reconciliation (race: webhook arrives before `POST /tpv/fast`)

Already implemented for Blumon via `reconcileWebhooksForPayment`. Extend it:

When `Payment.create` runs, also look for AngelPay PENDING events:

```ts
where: {
  provider: 'PAYMENT_PROCESSOR',
  eventId: { startsWith: 'angelpay-' },
  status: 'PENDING',
  OR: [
    { payload: { path: ['data', 'external_reference'], equals: payment.referenceNumber } },
    { payload: { path: ['data', 'transaction_id'],     equals: payment.processorId } },
  ],
}
```

Reconcile immediately. Same pattern, just a different JSONB path. Acceptable to call this on every `Payment.create` — it's already one indexed query for Blumon; adding AngelPay = same query shape with OR'd prefix.

---

## 9. Health endpoint

```ts
router.get('/angelpay/health', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'AngelPay webhook endpoint is healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  })
})
```

Identical contract to `blumonWebhookHealthCheck`. AngelPay can hit it to verify connectivity.

---

## 10. Error reasons (canonical)

Add a sibling to `BLUMON_WEBHOOK_ERROR_REASONS`:

```ts
export const ANGELPAY_WEBHOOK_ERROR_REASONS = {
  INVALID_SIGNATURE:   'INVALID_SIGNATURE',    // (rarely persisted — we 401 instead)
  UNKNOWN_MERCHANT:    'UNKNOWN_MERCHANT',
  NOT_PROVISIONED:     'NOT_PROVISIONED',
  MERCHANT_MISMATCH:   'MERCHANT_MISMATCH',
  NO_MATCH_FIELDS:     'NO_MATCH_FIELDS',
  AMOUNT_MISMATCH:     'AMOUNT_MISMATCH',
  NOT_APPROVED:        'NOT_APPROVED',
  ORPHANED:            'ORPHANED',
  PROCESSING_ERROR:    'PROCESSING_ERROR',
} as const
```

---

## 11. Security rules

| # | Rule | Why |
|---|---|---|
| 1 | Always read body as raw `Buffer` (`express.raw`). Never let `express.json` touch this route. | HMAC is over exact bytes; pretty-printed JSON breaks it. |
| 2 | `angelpayWebhookSecret` stored encrypted (KMS) — same envelope as `providerCredentials`. | Secrets at rest. |
| 3 | Constant-time compare via `svix` lib only. Never roll our own HMAC compare. | Timing attacks. |
| 4 | Reject `svix-timestamp` outside ±5 min (handled by `svix` lib). | Replay protection. |
| 5 | Log `svix-id`, never log raw signature header. | Signature is a credential proxy. |
| 6 | Log full payload on first-of-kind unknown `event_type`, redact `card.last_four` to `****` and never log full PAN (AngelPay should never send PAN anyway). | PCI. |
| 7 | 404 on unknown `:merchantAccountId` — don't leak existence by behaving differently. | Enumeration. |
| 8 | All processing happens server-side; webhook never triggers a payment, only records observations. | Defense in depth — webhook is observability, not a command channel. |

---

## 12. Acceptance criteria

- [ ] `POST /webhooks/angelpay/:merchantAccountId` returns 200 for a valid Svix-signed test event with `event_type=send_transaction`
- [ ] Same request replayed → returns 200 with `action: 'DUPLICATE'` (idempotent via `svix-id`)
- [ ] Wrong signature → returns 401, no `ProviderEventLog` row written
- [ ] Unknown `:merchantAccountId` → returns 404
- [ ] Provisioned but `data.merchant_id` ≠ `externalMerchantId` → returns 401
- [ ] Valid event for a Payment that hasn't been recorded yet → row stays PENDING, cron reconciles within 30 s of `POST /tpv/fast` completing
- [ ] Amount mismatch → row → `ERROR/AMOUNT_MISMATCH`, Payment `processorData.angelpayDiscrepancy` populated
- [ ] `canceled_transaction` for a real Payment → stamps `processorData.angelpayCanceledAt`, does NOT change `payment.status`
- [ ] Cron promotes a 24 h-old PENDING row to `ERROR/ORPHANED`
- [ ] `GET /webhooks/angelpay/health` returns 200 JSON

---

## 13. Out of scope (separate specs, later)

- Registering a webhook endpoint with AngelPay (`POST /api/v1/webhooks/endpoints`) — manual paste for now
- Fetching AngelPay merchant catalog / `merchant_id` discovery — covered by `CONNECT_MERCHANT_VIA_APIKEY_SPEC.md`
- Dashboard UI to manage webhook endpoints (rotate secret, view delivery history)
- Webhook signature key rotation flow
- Multi-tenant scope widening (one AngelPay merchant fanning out to N venues — not a thing today; revisit when it is)

---

## 14. Implementation checklist (work order)

1. Prisma migration: add 3 fields to `MerchantAccount`
2. `src/services/tpv/angelpay-webhook.service.ts` — port of `blumon-webhook.service.ts`, ~600 lines
3. `src/controllers/tpv/angelpay-webhook.tpv.controller.ts` — port of Blumon controller, ~150 lines
4. `src/routes/webhook.routes.ts` — register `POST /angelpay/:merchantAccountId` + `GET /angelpay/health`
5. `src/jobs/reconcile-angelpay-pending-webhooks.job.ts` — port of Blumon cron
6. Extend `reconcileWebhooksForPayment` to scan AngelPay PENDING events too
7. `npm install svix`
8. Unit tests: signature verify (happy/wrong/expired/replayed), each event_type handler, cron promotion to ORPHANED
9. Manual smoke: provision a sandbox `angelpayWebhookSecret`, trigger a Nexgo payment, verify the row lands as `PROCESSED`

End-to-end acceptance unlocks the moment we have one merchant's secret in `MerchantAccount.angelpayWebhookSecret` and AngelPay pointing their delivery URL at us — even before the `/webhooks/endpoints` automation lands.
