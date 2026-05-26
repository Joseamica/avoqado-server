# Connect AngelPay merchant via apiKey — Implementation Spec

> Handoff document for another agent/dev. Self-contained: no prior context needed.

**Repo:** `avoqado-server` (Node.js + Express + TypeScript + Prisma + PostgreSQL) **Feature:** Add new endpoint that lets a superadmin
"connect" an AngelPay merchant to a venue by pasting an apiKey. The endpoint validates the apiKey against AngelPay's integrations-api,
captures the merchant_id, persists the credentials encrypted, and registers a webhook so AngelPay can push transaction events back to us.

---

## 1. Why this exists (context)

Avoqado is a multi-tenant POS/payments platform. Today AngelPay merchants are discovered **TPV-side** (`FETCH_ANGELPAY_MERCHANTS` command →
TPV runs AngelPay SDK → reports back). That flow has 5+ failure modes (heartbeat lag, SDK auth timeouts, R8 stripping, etc.) and a 90s
spinner.

AngelPay finally released their **integrations-api** (Q2 2026) which allows backend-to-backend onboarding:

- Validate the apiKey directly from our backend
- Get the merchant_id without involving the TPV
- Register webhooks to receive `send_transaction`, `offline_event`, `canceled_transaction` events in real time

This spec covers ONLY the onboarding endpoint. Webhook receiver (`POST /api/v1/webhooks/angelpay/:merchantAccountId`) is a separate spec.

---

## 2. AngelPay integrations-api facts (already explored)

| Item                                  | Value                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base URL (QA)                         | `https://integrations-api.angelpay-qa.com.mx`                                                                                                                                                                                  |
| Base URL (PROD)                       | `https://integrations-api.angelpay.com.mx` _(probable — confirm with AngelPay)_                                                                                                                                                |
| Auth                                  | `POST /auth/token` with `{apiKey}` → returns `{access_token, token_type:"bearer", expires_in:3600}`                                                                                                                            |
| Decode JWT to get merchant_id         | `JWT.sub` (string, numeric like "61", "63", "106", "107")                                                                                                                                                                      |
| Register webhook                      | `POST /api/v1/webhooks/endpoints` with `{url, description?, events:[]}` — response includes `id` (uuid), `id_merchant`, `secret` (`whsec_*`)                                                                                   |
| 🚨 Secret returned ONLY on CREATE     | `GET /webhooks/endpoints` does NOT expose secret. Persist immediately or you lose it forever (no regenerate endpoint exists).                                                                                                  |
| Event types available                 | `send_transaction`, `offline_event`, `canceled_transaction` (from `GET /api/v1/webhooks/events/catalog`)                                                                                                                       |
| Signature scheme on incoming webhooks | Svix-style HMAC-SHA256: headers `svix-id`, `svix-timestamp`, `svix-signature` (format `v1,<base64>`). Verify: `expected = base64(HMAC_SHA256(base64decode(secret[6:]), f"{svix-id}.{svix-timestamp}.".encode() + body_bytes))` |
| NO endpoint returns                   | Merchant name, affiliation number, MSI plans — those still come only from SDK on-device                                                                                                                                        |

### Verified curl outputs (don't re-test, just trust)

```bash
# Auth
$ curl -X POST .../auth/token -d '{"apiKey":"ANGELPAY-KEY-..."}'
{"access_token":"eyJhbGciOiJIUzI1NiIs...","token_type":"bearer","expires_in":3600}

# JWT.sub for QA keys we have
Avoqado          → sub: "61"
AVOCMER          → sub: "63"
AvoqadoTest      → sub: "106"
AvoqadoComercio  → sub: "107"

# Register webhook
$ curl -X POST .../api/v1/webhooks/endpoints -H "Authorization: Bearer ..." -d '{...}'
{
  "id": "c51ae87c-3ba4-4e37-8b7d-b2c082c34ec9",
  "id_merchant": "61",
  "url": "...",
  "secret": "whsec_a564bacf86dedbb63351a982a5bad71cdb973559dca3bf3b321bf819528499d0",
  "description": "...",
  "is_active": true,
  "events": ["canceled_transaction","offline_event","send_transaction"],
  "created_at": "2026-05-24T15:54:42.647262"
}

# Invalid apiKey → returns 401 or 422 (test it; not yet confirmed)
```

---

## 3. Goal: the new endpoint

```http
POST /api/v1/superadmin/venues/:venueId/angelpay-connect-merchant
Authorization: Bearer <superadmin-jwt>
Content-Type: application/json

{
  "apiKey": "ANGELPAY-KEY-cHKSLL...",
  "environment": "QA" | "PROD",
  "displayName": "Avoqado Comercio",     // operator-provided (since API doesn't return it)
  "affiliation": "8920378",              // operator-provided
  "alias": "principal"                   // optional
}
```

### Happy-path response (201)

```json
{
  "merchantAccount": {
    "id": "cmp...",
    "providerId": "angelpay_provider_mx",
    "providerCode": "ANGELPAY",
    "displayName": "Avoqado Comercio",
    "externalMerchantId": "107",
    "angelpayAffiliation": "8920378",
    "angelpayMerchantName": "Avoqado Comercio",
    "angelpayEnvironment": "PROD",
    "active": true,
    "createdAt": "...",
    "webhookEndpointId": "c51ae87c-...",
    "webhookActive": true
  }
}
```

### Error responses

| HTTP | When                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | Missing fields, invalid environment                                                                                                     |
| 401  | AngelPay rejected apiKey (relay their error)                                                                                            |
| 409  | A `MerchantAccount` with `(providerId, externalMerchantId, venueId-via-VenuePaymentConfig)` already exists for this venue + merchant_id |
| 502  | AngelPay integrations-api unreachable / timed out                                                                                       |
| 500  | Unexpected backend error (do not leak internals)                                                                                        |

---

## 4. Server-side flow

```
1. Validate request body (Zod)
2. Validate environment ∈ {QA, PROD}
3. POST /auth/token to AngelPay (env-aware base URL)
   → if not 200 → 401 to client
4. Decode JWT.sub = externalMerchantId
5. Encrypt apiKey using existing `encryptCredentials()` helper
   (src/services/superadmin/merchantAccount.service.ts already has it)
6. Inside a single Prisma transaction:
   a. Insert MerchantAccount row (active=true, providerCode=ANGELPAY)
   b. POST /webhooks/endpoints with:
        url:   `${PUBLIC_BASE_URL}/api/v1/webhooks/angelpay/${merchantAccount.id}`
        events: ["send_transaction", "offline_event", "canceled_transaction"]
        description: `Avoqado venue ${venueId}`
   c. If webhook creation fails → ROLLBACK + return 502
   d. Encrypt `secret` (whsec_*) using same encryptCredentials helper
   e. Persist webhookEndpointId + webhookSecretEncrypted on the MerchantAccount row
7. Auto-attach merchant to NEXGO terminals (re-use existing helper, see §6)
8. Return 201 with the created row + webhook info
```

**Critical:** the webhook secret must be persisted in the SAME transaction as the MerchantAccount row. If we crash between create-merchant
and persist-secret, we'll never recover the secret (AngelPay doesn't expose it post-create).

---

## 5. Schema changes (Prisma)

`prisma/schema.prisma` — add 4 fields to `MerchantAccount` (NULLABLE; backwards compatible):

```prisma
model MerchantAccount {
  // ... existing fields ...

  // 🆕 AngelPay integrations-api fields (2026-05-24)
  // Populated when the merchant was connected via the dashboard "Connect with apiKey"
  // flow instead of the legacy TPV-side discovery. Null on Blumon merchants and on
  // AngelPay merchants created via TPV auto-discovery (those rely on SDK on-device).
  angelpayApiKeyEncrypted    Json?   // { iv, encrypted } — apiKey from operator
  angelpayWebhookEndpointId  String? // uuid from POST /webhooks/endpoints
  angelpayWebhookSecret      Json?   // { iv, encrypted } — whsec_* (verify-only)
  angelpayEnvironment        String? // "QA" | "PROD" — which AngelPay backend
}
```

Migration:

```bash
npx prisma migrate dev --name add_angelpay_integrations_api_fields
```

---

## 6. Code reuse — don't reinvent

| Need                                                                | Existing helper                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encrypt sensitive blob                                              | `encryptCredentials()` in `src/services/superadmin/merchantAccount.service.ts` (line ~32)                                                                                                                                       |
| Auto-bind a new MerchantAccount to all NEXGO terminals in the venue | Pattern already in `upsertDiscoveredAngelPayMerchants()` post-loop in same file (line ~1310). Extract into a reusable `attachAngelPayMerchantToNexgoTerminals(merchantAccountId, venueId)` helper if it'd be the 3rd call site. |
| HTTP client (with timeout, retries)                                 | Use `axios` (already a dep). Wrap in a tiny `AngelPayIntegrationsApiClient` class with `auth()` + `registerWebhook()` methods. Place at `src/services/integrations/angelpay-integrations-api.client.ts`.                        |

---

## 7. Files to touch (estimate)

1. **Service** — new file `src/services/superadmin/angelpayConnectMerchant.service.ts`

   - Exports `connectAngelPayMerchant(input: {venueId, apiKey, environment, displayName, affiliation, alias?})`

2. **HTTP client** — new file `src/services/integrations/angelpay-integrations-api.client.ts`

   - Exports class with `auth(apiKey)` → `{accessToken, merchantId}` and `registerWebhook(token, body)` → `{id, secret}`

3. **Controller** — new file `src/controllers/superadmin/angelpayConnectMerchant.controller.ts`

   - Zod schema validation
   - Calls service, maps service errors → HTTP

4. **Routes** — `src/routes/superadmin/index.ts` (or wherever existing AngelPay routes live)

   - Mount `POST /venues/:venueId/angelpay-connect-merchant`

5. **Prisma schema** — add 4 fields (see §5) + migration

6. **Env vars** — add to `.env.example`:

   ```
   ANGELPAY_INTEGRATIONS_API_BASE_URL_QA=https://integrations-api.angelpay-qa.com.mx
   ANGELPAY_INTEGRATIONS_API_BASE_URL_PROD=https://integrations-api.angelpay.com.mx
   PUBLIC_BASE_URL=https://api.avoqado.io   # used to build webhook callback URL
   ```

7. **Tests** — `tests/unit/services/superadmin/angelpayConnectMerchant.service.test.ts`
   - Mock the HTTP client + Prisma
   - Cover: happy path, invalid apiKey, AngelPay 502, secret-persistence rollback

---

## 8. Security / non-negotiables

- **Encrypt apiKey + webhook secret BEFORE any DB write.** Use the existing `encryptCredentials()` helper — it's already tested and proven
  on other credentials.
- **Never log the apiKey or secret.** Add a `RedactingLoggingInterceptor` pattern if axios logs request bodies (the AngelPay SDK has a
  similar interceptor in TPV at `core/data/network/RedactingLoggingInterceptor.kt` — same idea).
- **Validate the URL we send to AngelPay.** It MUST be HTTPS and on our domain (allow-list check). Otherwise a malicious request could trick
  the system into pointing webhooks elsewhere.
- **No external callbacks before persistence.** If we register the webhook BEFORE persisting the MerchantAccount and our DB write fails,
  AngelPay holds an orphan webhook pointing to us. Order is: insert MerchantAccount → register webhook → update MerchantAccount with secret.
  If webhook registration fails, rollback the insert.

---

## 9. Acceptance criteria

- [ ] `POST /api/v1/superadmin/venues/:venueId/angelpay-connect-merchant` exists and is mounted under the superadmin router (auth +
      SUPERADMIN role enforced)
- [ ] Happy path: with a valid apiKey returns 201 + the persisted MerchantAccount. Webhook IS visible in `GET /api/v1/webhooks/endpoints`
      (verify with curl).
- [ ] Bad apiKey → 401 with helpful message, no DB writes
- [ ] AngelPay unreachable (simulate via env override) → 502, no orphan rows
- [ ] Duplicate (`same venueId + same externalMerchantId from JWT.sub`) → 409
- [ ] DB row contains: encrypted apiKey, encrypted secret, webhookEndpointId, environment, externalMerchantId
- [ ] No plaintext apiKey or secret appears in any log file (grep test logs after running)
- [ ] Unit tests cover all 4 paths above
- [ ] AngelPay merchant auto-attached to all NEXGO terminals in venue (re-use existing helper)

---

## 10. Out of scope (do NOT do in this PR)

- The webhook receiver (`POST /api/v1/webhooks/angelpay/:merchantAccountId`) — separate spec
- Dashboard UI for the form — separate ticket (only the backend endpoint here)
- Disconnect/rotate flow (`DELETE`) — follow-up
- Backfilling existing AngelPay merchants with apiKey/webhook — separate migration script
- TPV-side changes — none required. The TPV continues using the SDK on-device and reading `angelpayAccounts` from
  `/tpv/terminals/:serial/config` exactly as today.

---

## 11. Quick start for the implementer

```bash
# 1. Pull the latest develop
git checkout develop
git pull origin develop

# 2. New branch
git checkout -b feat/angelpay-connect-merchant-via-apikey

# 3. Add the schema fields + migrate
# edit prisma/schema.prisma  (see §5)
npx prisma migrate dev --name add_angelpay_integrations_api_fields

# 4. Implement files in §7 order: client → service → controller → routes → tests

# 5. Smoke test with a QA apiKey (from the spec maintainer — don't paste in git):
curl -X POST http://localhost:3000/api/v1/superadmin/venues/<venueId>/angelpay-connect-merchant \
  -H "Authorization: Bearer <superadmin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "ANGELPAY-KEY-...",
    "environment": "QA",
    "displayName": "AvoqadoTest",
    "affiliation": "8920379"
  }'

# 6. Verify the webhook was registered:
TOKEN=$(curl -s -X POST 'https://integrations-api.angelpay-qa.com.mx/auth/token' \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"ANGELPAY-KEY-..."}' | jq -r .access_token)
curl -s 'https://integrations-api.angelpay-qa.com.mx/api/v1/webhooks/endpoints' \
  -H "Authorization: Bearer $TOKEN" | jq

# 7. Run tests
npm test -- tests/unit/services/superadmin/angelpayConnectMerchant.service.test.ts

# 8. Open PR against develop
```

---

## 12. References

- AngelPay integrations-api Swagger: https://integrations-api.angelpay-qa.com.mx/docs#
- Webhook integration example app:
  `/Users/amieva/Library/Mobile Documents/com~apple~CloudDocs/Avoqado/Socios/AngelPay/dev/sdk_propio/1.0.7/webhook-integration-example/`
  (Python Flask reference impl; `app.py` has Svix signature verification we can port to TS)
- Existing AngelPay-related code in this repo:
  - `src/services/superadmin/angelpayUserAccount.service.ts` (existing service for SDK-based AngelPay user accounts — coexists with new
    flow)
  - `src/services/superadmin/merchantAccount.service.ts` (encryption helpers + auto-bind pattern)
  - `src/controllers/superadmin/angelpayUserAccount.controller.ts` (existing controllers — follow same patterns)
  - `prisma/schema.prisma` — `MerchantAccount`, `AngelPayUserAccount`, `Terminal` models
- Past sessions exploring this: see `docs/ANGELPAY_R8_FIX_REPORT.txt` for context on why this matters operationally.
