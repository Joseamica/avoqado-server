# AngelPay Webhook Receiver — Spec

**Status:** approved (brainstorming complete) **Date:** 2026-05-26 **Owner:** Avoqado backend **Scope:** ONLY the endpoint that receives
AngelPay webhook callbacks. Out of scope: registering/listing/deleting webhook endpoints via `/api/v1/webhooks/endpoints` (separate spec),
dashboard UI, multi-tenant URL routing, automatic secret rotation, `canceled_transaction` and `offline_event` handlers.

---

## 1. Goal

Receive AngelPay payment-confirmation callbacks, verify Svix HMAC signature, and reconcile each event against the `Payment` table —
mirroring the proven Blumon TPV pattern (layer 4 of the 4-layer reconciliation strategy) but simplified for AngelPay's smaller operational
envelope.

This is layer 4 of 4 for AngelPay payments:

1. Nexgo → AngelPay app-to-app Intent (local cobro on terminal)
2. Nexgo → Avoqado backend (`POST /tpv/fast` records `Payment`)
3. Backend validation (`merchantAccountId` resolution)
4. **AngelPay webhook (this spec)** — independent processor confirmation from the cloud

---

## 2. Why this is simpler than Blumon's webhook (and what we cut)

| Concern                                    | Blumon TPV                        | AngelPay (this spec)                                                                                                                  |
| ------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Auth                                       | IP whitelist, no signature        | **Svix HMAC-SHA256** (vendor signs every event)                                                                                       |
| Endpoint                                   | 1 URL                             | **1 URL** (single global endpoint)                                                                                                    |
| Event types                                | 1 (`payment`)                     | **1 in v1** (`send_transaction`); `canceled_transaction` + `offline_event` deferred                                                   |
| Tenant identification                      | `serialNumber` → Terminal → Venue | `merchant_id` from body → `MerchantAccount.externalMerchantId`                                                                        |
| Secret storage                             | N/A                               | **2 env vars** (`_SANDBOX` + `_PROD`), selected by `NODE_ENV`                                                                         |
| Idempotency key                            | `(operationNumber, reference)`    | `svix-id` (Svix guarantees uniqueness per delivery)                                                                                   |
| Persistence model                          | `ProviderEventLog`                | **Same `ProviderEventLog`** (distinguish by `eventId` prefix `angelpay-*`)                                                            |
| Match retries                              | 3 attempts (0/2/3 s)              | **Same** (5 s total window)                                                                                                           |
| PENDING cron                               | 30 s cadence, 24 h TTL → ORPHANED | **Removed.** AngelPay terminals require internet to cobrar, so the TPV-offline-for-hours race that justifies the cron does not exist. |
| Bidirectional reconcile (`Payment.create`) | Yes                               | **Removed.** No PENDING rows to reconcile without the cron.                                                                           |

**Lines of code estimate:** ~250 (service) + ~100 (controller) — roughly one third of the Blumon implementation, with the same coverage of
realistic scenarios.

---

## 3. Endpoints

```
POST /api/v1/webhooks/angelpay/:merchantAccountId  ← receiver (per-merchant)
GET  /api/v1/webhooks/angelpay/health              ← liveness for AngelPay/ops
```

`:merchantAccountId` is the internal CUID of the `MerchantAccount` row. Each AngelPay merchant registers a distinct webhook URL pointing at
its own row. The health route is registered BEFORE the parameterised route so Express does not match `health` as a `:merchantAccountId`
value.

Registered in `src/routes/webhook.routes.ts` next to the Blumon route. The receiver uses the existing
`express.raw({ type: 'application/json' })` body parser (Svix verification requires exact bytes). **Do not** mount `express.json()` upstream
of this route.

---

## 4. Schema changes (minimal)

Three nullable columns on `MerchantAccount`. No new models, no enums.

```prisma
model MerchantAccount {
  // ...existing fields...

  /// Last time we successfully processed an AngelPay webhook for this merchant.
  /// NULL = never. Useful for ops dashboard ("¿está vivo el endpoint?").
  angelpayWebhookLastReceivedAt DateTime?

  /// Svix HMAC secret returned by AngelPay's POST /api/v1/webhooks/endpoints
  /// when we register a webhook for this merchant. Format: "whsec_<base64>".
  /// Stored plaintext — it's not a customer credential, it's a per-tenant
  /// signing key (same risk class as a JWT signing key).
  angelpayWebhookSecret      String?

  /// AngelPay's endpoint id (e.g. "ep_abc123") from the registration response.
  /// Kept for traceability + future automation of de-registration / re-rotation.
  angelpayWebhookEndpointId  String?
}
```

Migration name: `add_angelpay_webhook_secret_to_merchant_account`. Backfill = NULL. No constraints. All three columns are additive (no
existing data affected).

`ProviderEventLog` already has all columns we need (`provider`, `eventId`, `type`, `payload`, `status`, `errorReason`, `venueId`,
`paymentId`, `processedAt`).

---

## 5. Secret storage (per-merchant DB column — no env vars)

Webhook secrets are stored per-merchant in `MerchantAccount.angelpayWebhookSecret` (see §4). There are no `ANGELPAY_WEBHOOK_SECRET_*`
environment variables.

**Provisioning workflow (manual v1):**

1. Call `POST /api/v1/webhooks/endpoints` against the AngelPay API for the desired merchant.
2. AngelPay returns a `{ id, secret }` response where `secret` is a `whsec_<base64>` string.
3. Store the secret in `MerchantAccount.angelpayWebhookSecret` (via admin SQL or a future dashboard action).
4. Optionally store the endpoint `id` in `MerchantAccount.angelpayWebhookEndpointId` for traceability.
5. Register the webhook URL as `POST /api/v1/webhooks/angelpay/<merchantAccountId>` pointing at the Render service.

The endpoint is automatically active once `angelpayWebhookSecret` is non-NULL. If the column is NULL, the controller returns
`503 { error: 'webhook not provisioned for this merchant' }`.

The `/api/v1/webhooks/endpoints` automation (auto-register, auto-rotate) is out of scope for v1.

---

## 6. Request shape (AngelPay → us)

### 6.1 Headers (Svix, confirmed by AngelPay's `webhook-integration-example/app.py`)

```
svix-id:        msg_2abc...           # unique per event delivery
svix-timestamp: 1716673200             # Unix seconds when AngelPay signed
svix-signature: v1,<base64-hmac>       # may be multiple comma-separated values during key rotation
                                       # e.g. "v1,abc... v1,xyz..." (space-separated)
content-type:   application/json
```

**Header aliases:** AngelPay's own reference implementation also accepts `webhook-id`, `webhook-timestamp`, `webhook-signature` as fallback
names. Our verifier must check both prefixes (svix-first, then webhook-) before deciding the headers are missing.

### 6.2 Body — `send_transaction`

**Verified** against AngelPay's official OpenAPI `InternalEventCreate` schema (2026-05-26).

```jsonc
{
  "event_type": "send_transaction", // string — exact value
  "id_merchant": 1042, // number — INT, not string. MUST match MerchantAccount.externalMerchantId (stored as String, convert with String(id_merchant))
  "payload": {
    // top-level field is "payload", NOT "data"
    "amount": 50.0, // number — decimal MXN
    "description": "Motivo de declinado en caso de no aprobarse", // string — optional, present on declines
    "integratorReference": "Viene desde la transaccion", // string — OUR referenceNumber that TPV passed in startPayment; primary match key
    "status": "approved", // lowercase: "approved" | "declined" | etc. Check is case-insensitive
    "terminalSerial": "12345678", // string — Nexgo serial number
    "timestamp": "2026-03-20T12:34:56Z", // string — ISO 8601
    "transactionId": "txn_20260320_0002_OPTIONAL", // string — AngelPay's transaction PK; secondary match key
  },
}
```

**What does NOT exist (removed from inferred spec):**

- No `auth_code` field
- No `card.*` fields (`last_four`, `brand`, `entry_mode`)
- `id_merchant` is a **number** (not a string like the old `merchant_id`)

**Validation posture:** lenient. Required fields = `event_type`, `id_merchant` (number), and `payload.amount`. Match fields =
`payload.integratorReference` and/or `payload.transactionId`. Everything else is best-effort.

---

## 7. Processing pipeline

`POST /api/v1/webhooks/angelpay/:merchantAccountId`

### Step 0 — Always-respond contract

| Scenario                                            | HTTP  | Body                                                     | Why                                               |
| --------------------------------------------------- | ----- | -------------------------------------------------------- | ------------------------------------------------- |
| Valid signature, processed (any internal outcome)   | `200` | `{ action, eventLogId, paymentId? }`                     | We own retry semantics; AngelPay should not retry |
| Valid signature, already seen (`svix-id` duplicate) | `200` | `{ action: 'DUPLICATE', eventLogId }`                    | Idempotent no-op                                  |
| Valid signature, unknown `merchant_id`              | `200` | `{ action: 'UNKNOWN_MERCHANT' }`                         | Logged for ops; AngelPay can't fix it             |
| Valid signature, payload missing required fields    | `200` | `{ action: 'ERROR', errorReason: 'NO_MATCH_FIELDS' }`    | Logged; retry won't help                          |
| **Invalid signature**                               | `401` | `{ error: 'invalid signature' }`                         | AngelPay must see 4xx to flag misconfig           |
| **Headers missing (no `svix-*` or `webhook-*`)**    | `401` | `{ error: 'missing signature headers' }`                 | Same                                              |
| **:merchantAccountId not found**                    | `404` | `{ error: 'unknown merchant' }`                          | URL misconfigured                                 |
| **angelpayWebhookSecret is NULL**                   | `503` | `{ error: 'webhook not provisioned for this merchant' }` | Provisioning step not done yet                    |

### Step 1 — Lookup MerchantAccount by URL param :merchantAccountId

The controller resolves `prisma.merchantAccount.findFirst({ where: { id: merchantAccountId, provider: { code: 'ANGELPAY' } } })`. If not
found → 404. If `angelpayWebhookSecret` is NULL → 503. The venueId is resolved via the VenuePaymentConfig join chain (MerchantAccount has no
direct venueId column).

### Step 1.5 — Verify Svix signature (per-merchant secret)

Implementation uses `svix` npm package (zero custom crypto). The lib handles:

- HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${raw-body}`
- base64 compare via `crypto.timingSafeEqual`
- Multiple `v1,...` signatures (key rotation)
- Timestamp tolerance ±5 min (replay protection)

```ts
// Normalize: svix lib expects 'svix-*' header names. Accept 'webhook-*' aliases too.
const headers = {
  'svix-id': req.header('svix-id') ?? req.header('webhook-id'),
  'svix-timestamp': req.header('svix-timestamp') ?? req.header('webhook-timestamp'),
  'svix-signature': req.header('svix-signature') ?? req.header('webhook-signature'),
}
if (!headers['svix-id'] || !headers['svix-timestamp'] || !headers['svix-signature']) {
  return res.status(401).json({ error: 'missing signature headers' })
}

let payload: AngelPayWebhookPayload
try {
  // Secret is taken from the MerchantAccount row resolved in Step 1
  payload = new Webhook(merchantAccount.angelpayWebhookSecret).verify(req.body /* raw Buffer */, headers) as AngelPayWebhookPayload
} catch (err) {
  logger.warn('🚫 [AngelPay webhook] Invalid signature', { merchantAccountId, svixId: headers['svix-id'] })
  return res.status(401).json({ error: 'invalid signature' })
}
```

### Step 2 — Lenient body validation

```ts
if (!payload.event_type || typeof payload.id_merchant !== 'number' || !payload.payload?.amount) {
  return await persistError(payload, 'INVALID_PAYLOAD', res)
}
```

`persistError` writes a `ProviderEventLog` row (status=ERROR) and returns 200 with the action label.

### Step 2.5 — Cross-check id_merchant vs URL-resolved merchant (MERCHANT_MISMATCH defence)

After validation, the service asserts that `String(payload.id_merchant) === merchantAccount.externalMerchantId`. This defends against
URL/secret mix-ups (e.g. merchant A's secret leaked to merchant B's URL). On mismatch: persists an ERROR row with
`errorReason: 'MERCHANT_MISMATCH'` and returns `{ action: 'UNKNOWN_MERCHANT', errorReason: 'MERCHANT_MISMATCH' }` (200 — AngelPay should not
retry).

### Step 3 — First-time-seen logging

```ts
if (payload.event_type !== 'send_transaction') {
  // We only act on send_transaction in v1, but we still log unknown types
  // so ops can see what AngelPay is delivering.
  await prisma.providerEventLog.create({ data: { ..., status: 'ERROR', errorReason: 'UNSUPPORTED_EVENT_TYPE' } })
  return res.status(200).json({ action: 'UNSUPPORTED_EVENT_TYPE' })
}
```

Additionally: the service tracks a Set of `event_type` values it has already logged in full. First sighting of each type →
`logger.info({ ...payload }, 'AngelPay first-of-type body')`. This is how we validate the EXPECTED shape against reality without manual
capture.

### Step 4 — Merchant already resolved (no DB lookup needed)

The controller already resolved and passed `{ id, venueId, externalMerchantId }` to the service. No secondary merchant lookup is performed
inside the orchestrator.

### Step 5 — Idempotency

```ts
const eventId = `angelpay-${headers['svix-id']}`
const existing = await prisma.providerEventLog.findFirst({
  where: { provider: 'PAYMENT_PROCESSOR', eventId },
  select: { id: true, paymentId: true, status: true },
})
if (existing) return res.status(200).json({ action: 'DUPLICATE', eventLogId: existing.id, paymentId: existing.paymentId ?? undefined })
```

### Step 6 — Insert PENDING row (before match)

```ts
let event
try {
  event = await prisma.providerEventLog.create({
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
} catch (err) {
  // Race with concurrent idempotency check — P2002 unique violation
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const existing = await prisma.providerEventLog.findFirst({ where: { provider: 'PAYMENT_PROCESSOR', eventId }, select: { id: true } })
    return res.status(200).json({ action: 'DUPLICATE', eventLogId: existing!.id })
  }
  throw err
}
```

### Step 7 — Non-approved bailout

```ts
// AngelPay sends lowercase status; check is case-insensitive for defensiveness
if (payload.payload.status && payload.payload.status.toLowerCase() !== 'approved') {
  await finalize(event.id, { action: 'NOT_APPROVED', errorReason: 'NOT_APPROVED' })
  return res.status(200).json({ action: 'NOT_APPROVED', eventLogId: event.id })
}
```

### Step 8 — Match with retry (5 s total)

```ts
const RETRY_CONFIG = { maxAttempts: 3, delays: [0, 2000, 3000] } // 0ms, 2s, 3s

const matchConditions = [
  payload.payload.integratorReference && { referenceNumber: payload.payload.integratorReference },
  payload.payload.transactionId && { processorId: payload.payload.transactionId },
].filter(Boolean) as Prisma.PaymentWhereInput[]

if (matchConditions.length === 0) {
  await finalize(event.id, { action: 'ERROR', errorReason: 'NO_MATCH_FIELDS' })
  return res.status(200).json({ action: 'ERROR', eventLogId: event.id })
}

const where: Prisma.PaymentWhereInput = {
  OR: matchConditions,
  status: { in: ['COMPLETED', 'PENDING'] },
  order: { venueId: merchantAccount.venueId },
}

let payment = null
for (let i = 0; i < RETRY_CONFIG.maxAttempts; i++) {
  if (RETRY_CONFIG.delays[i] > 0) await delay(RETRY_CONFIG.delays[i])
  payment = await prisma.payment.findFirst({ where, include: { order: { select: { venueId: true } } } })
  if (payment) break
}
```

### Step 9 — Reconcile or orphan

```ts
if (!payment) {
  // No cron will retry this — investigate manually via ProviderEventLog query.
  await finalize(event.id, { action: 'ORPHANED', errorReason: 'ORPHANED' })
  return res.status(200).json({ action: 'ORPHANED', eventLogId: event.id })
}

const webhookAmount = Number(payload.payload.amount)
const recordedAmount = Number(payment.amount)
const diff = Math.abs(webhookAmount - recordedAmount)

if (diff < 0.01) {
  // MATCHED — stamp audit, finalize event row, touch lastReceivedAt
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      processorData: {
        ...((payment.processorData as Record<string, unknown>) ?? {}),
        angelpayWebhook: {
          receivedAt: new Date().toISOString(),
          svixId: headers['svix-id'],
          transactionId: payload.payload.transactionId ?? null,
          integratorReference: payload.payload.integratorReference ?? null,
          terminalSerial: payload.payload.terminalSerial ?? null,
          timestamp: payload.payload.timestamp ?? null,
          status: payload.payload.status ?? null,
          // No auth_code, no card details — AngelPay doesn't send them
        },
      },
    },
  })
  await finalize(event.id, { action: 'MATCHED', paymentId: payment.id })
} else {
  // DISCREPANCY — audit only, do NOT mutate payment.status
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      processorData: {
        ...((payment.processorData as Record<string, unknown>) ?? {}),
        angelpayDiscrepancy: {
          detectedAt: new Date().toISOString(),
          webhookAmount,
          recordedAmount,
          difference: diff,
          transactionId: payload.payload.transactionId ?? null,
        },
      },
    },
  })
  await finalize(event.id, { action: 'DISCREPANCY', errorReason: 'AMOUNT_MISMATCH', paymentId: payment.id })
}

// Touch lastReceivedAt — confirms AngelPay is reaching us for this merchant.
await prisma.merchantAccount.update({
  where: { id: merchantAccount.id },
  data: { angelpayWebhookLastReceivedAt: new Date() },
})
```

---

## 8. Error reasons (canonical)

```ts
export const ANGELPAY_WEBHOOK_ERROR_REASONS = {
  NOT_PROVISIONED: 'NOT_PROVISIONED', // env var missing (rare; returns 503)
  INVALID_SIGNATURE: 'INVALID_SIGNATURE', // rarely persisted — we 401 instead
  INVALID_PAYLOAD: 'INVALID_PAYLOAD', // body missing event_type/merchant_id/data.amount
  UNSUPPORTED_EVENT_TYPE: 'UNSUPPORTED_EVENT_TYPE', // event_type != send_transaction in v1
  UNKNOWN_MERCHANT: 'UNKNOWN_MERCHANT', // merchant_id not in our DB
  NO_MATCH_FIELDS: 'NO_MATCH_FIELDS', // payload has no usable matching field
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH', // diff >= $0.01
  NOT_APPROVED: 'NOT_APPROVED', // data.status != APPROVED
  ORPHANED: 'ORPHANED', // no Payment match after 5s — manual investigation
  PROCESSING_ERROR: 'PROCESSING_ERROR', // internal exception
} as const
```

---

## 9. Logging policy

| Field                                                  | Level | Notes                                    |
| ------------------------------------------------------ | ----- | ---------------------------------------- |
| `svix-id`                                              | INFO  | Trace key                                |
| `svix-signature` header                                | NEVER | It is a credential                       |
| Full body on first sighting of each `event_type`       | INFO  | Validates EXPECTED shape; bounded volume |
| Full body on errors                                    | DEBUG | Only with `LOG_LEVEL=debug`              |
| `payload.terminalSerial`                               | OK    | Device identifier, not sensitive         |
| `payload.integratorReference`, `payload.transactionId` | INFO  | Match keys                               |
| PAN (if ever appears in any field)                     | NEVER | Redact to `****`; PCI                    |
| `id_merchant`, `payload.amount`, `payload.status`      | INFO  | Audit trail                              |

---

## 10. Security rules

1. Body MUST be read as raw `Buffer` (`express.raw`). HMAC is over exact bytes.
2. Use the `svix` npm package; never roll our own HMAC compare. Constant-time + replay protection built-in.
3. Secrets in env vars only (not in DB, not in source). 1Password / Render dashboard for storage.
4. Log `svix-id`, never log raw signature header.
5. Reject `data.card.pan` if it ever appears (AngelPay should never send PAN — defensive).
6. The webhook is **observability only**, never a command channel. It records confirmations; it never triggers a Payment.create or mutates
   `payment.status`.

---

## 11. Acceptance criteria

- [ ] `POST /api/v1/webhooks/angelpay/:merchantAccountId` returns 200 for a valid Svix-signed `send_transaction` event, payload matches a
      Payment exactly → row stamped MATCHED, `payment.processorData.angelpayWebhook` populated,
      `MerchantAccount.angelpayWebhookLastReceivedAt` touched
- [ ] Same request replayed → returns 200 with `action: 'DUPLICATE'` (idempotent via `svix-id`)
- [ ] Wrong signature → 401, no `ProviderEventLog` row written
- [ ] Missing `svix-*` headers (and no `webhook-*` fallback) → 401
- [ ] `:merchantAccountId` not found in DB (or not ANGELPAY provider) → 404
- [ ] `MerchantAccount.angelpayWebhookSecret` is NULL → 503 `{ error: 'webhook not provisioned for this merchant' }`
- [ ] Valid signature, body `id_merchant` doesn't match URL-resolved `MerchantAccount.externalMerchantId` → 200, action `UNKNOWN_MERCHANT`,
      errorReason `MERCHANT_MISMATCH`, row persisted
- [ ] Valid signature, payload missing all of `integratorReference`/`transactionId` → 200, action `ERROR`, errorReason `NO_MATCH_FIELDS`
- [ ] `event_type != 'send_transaction'` → 200, action `UNSUPPORTED_EVENT_TYPE`, row persisted (audit only)
- [ ] `data.status != 'APPROVED'` → 200, action `NOT_APPROVED`
- [ ] Race: webhook arrives 500ms before `POST /tpv/fast` completes → match succeeds on retry attempt 2 or 3 (within 5s)
- [ ] No Payment match after 5s → 200, action `ORPHANED`, row persisted (ERROR/ORPHANED)
- [ ] Amount differs ≥ $0.01 → 200, action `DISCREPANCY`, row ERROR/AMOUNT_MISMATCH, `payment.processorData.angelpayDiscrepancy` populated,
      `payment.status` UNCHANGED
- [ ] `GET /api/v1/webhooks/angelpay/health` → 200 JSON

---

## 12. Implementation checklist (work order)

1. **Prisma migration** — add `angelpayWebhookLastReceivedAt` to `MerchantAccount`
2. **`src/services/tpv/angelpay-webhook.service.ts`** — pure logic (~250 lines): `processAngelPayWebhook`, `attemptPaymentMatch`,
   `finalize`, `persistError`, `getActiveWebhookSecret`, payload types, error reason constants
3. **`src/controllers/tpv/angelpay-webhook.tpv.controller.ts`** — HTTP adapter (~100 lines): signature verify, dispatch, response mapping
4. **`src/routes/webhook.routes.ts`** — register `POST /angelpay` + `GET /angelpay/health` next to the Blumon route
5. **`npm install svix`** — single new dependency
6. **Unit tests** — signature verify (happy / wrong / expired / replayed / multi-sig / aliases), each error reason path, retry loop,
   idempotency race
7. **Env vars** — add `ANGELPAY_WEBHOOK_SECRET_SANDBOX` to Render dev service; document in `docs/RENDER_SETUP.md`
8. **Manual smoke test** — provision sandbox secret, register webhook in AngelPay portal pointing at Render dev URL, trigger Nexgo payment,
   verify event row lands as MATCHED (or capture the actual body shape and patch §6.2 if it differs)

---

## 13. What's deliberately NOT in this spec (future work)

- **Cron worker** for long-window retries — not needed under the "cobrar requires online" invariant
- **`canceled_transaction` handler** — separate spec, low priority (TPV refunds aren't allowed on Nexgo today)
- **`offline_event` handler** — separate spec, only matters if AngelPay starts supporting offline cobros
- **Automation of `/api/v1/webhooks/endpoints`** — provisioning is manual paste-from-portal for v1
- **Dashboard UI** for `ProviderEventLog` AngelPay rows — query DB or build report endpoint when needed
- **Multi-tenant URL** (`/webhooks/angelpay/:merchantAccountId`) — global URL is sufficient given 1 partner; revisit only if Avoqado becomes
  a white-label platform
- **Secret rotation flow** — manual swap in Render env for v1

---

## 14. Open items (non-blocking for implementation)

1. **Body shape now verified** (§6.2 updated 2026-05-26 against AngelPay OpenAPI `InternalEventCreate`). Field names corrected:
   `id_merchant` (number), `payload.*` wrapper, `integratorReference`, `transactionId`, `terminalSerial`. No `auth_code`, no `card.*`.
2. **`event_type` enum values confirmed:** `send_transaction | canceled_transaction | offline_event` (verified from AngelPay event catalog
   endpoint).

---

## Implementation status

- ✅ Code implemented per `WEBHOOK_RECEIVER_PLAN.md` (Tasks 1-13)
- ⏳ Manual provisioning needed BEFORE going live:
  1. Register a webhook endpoint in the AngelPay sandbox portal pointing at the Render dev URL
     `https://<dev-service>.onrender.com/api/v1/webhooks/angelpay`, subscribed to `send_transaction`
  2. Copy the returned `whsec_*` secret into `ANGELPAY_WEBHOOK_SECRET_SANDBOX` on Render dev service
  3. Trigger a sandbox cobro on a Nexgo terminal and verify the row lands in `ProviderEventLog` as `MATCHED`
  4. Body field names are now verified against the official OpenAPI spec (§6.2 updated 2026-05-26). No further shape patching expected.
- ⏳ Production rollout: repeat steps 1-3 against the AngelPay production portal + Render prod service
