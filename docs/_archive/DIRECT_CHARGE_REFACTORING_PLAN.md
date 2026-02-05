# 🎯 Blumon Direct Charge Refactoring Plan

**Date**: 2025-01-17 **Decision**: Use Direct Charge flow ONLY (customer stays on app.avoqado.io) **Scope**: Delete ~919 lines of hosted
checkout/webhook code, refactor to synchronous payment flow

---

## 📋 Executive Summary

**What We're Doing**:

- ❌ **DELETING**: Hosted checkout + webhook code (~919 lines)
- ✅ **KEEPING**: Direct charge (tokenize + authorize) code (~708 lines)
- 🔄 **REFACTORING**: CheckoutSession to work with direct charge

**Why**:

- Customer stays on `app.avoqado.io` the entire time
- Instant payment feedback (synchronous API calls)
- No security vulnerabilities (no webhook signature issues)
- Simpler architecture (no async webhooks)
- Better user experience

---

## 📊 File-by-File Analysis

### ❌ **FILES TO DELETE ENTIRELY** (7 files, ~629 lines)

| File                                                      | Lines | Reason                                     |
| --------------------------------------------------------- | ----- | ------------------------------------------ |
| `src/routes/sdk/webhooks.sdk.routes.ts`                   | 379   | Webhook receiver from Blumon (not needed)  |
| `src/routes/sdk/webhook-simulator.sdk.routes.ts`          | ~50   | Dev tool for testing webhooks (not needed) |
| `src/controllers/sdk/webhook-simulator.sdk.controller.ts` | ~200  | Webhook simulator controller (not needed)  |

**Total to delete**: ~629 lines

---

### 🔄 **FILES TO REFACTOR** (Major changes)

#### 1. `src/services/sdk/blumon-ecommerce.service.ts` (528 lines total)

**REMOVE** these methods (~140 lines):

```typescript
❌ createHostedCheckout() - Lines 134-210 (76 lines)
❌ verifyWebhookSignature() - Lines 221-237 (18 lines)
❌ getCheckoutStatus() - Lines 247-273 (20 lines)
❌ cancelCheckout() - Lines 281-307 (26 lines)
❌ BlumonWebhookPayload interface - Lines 41-59
```

**KEEP** these methods (~380 lines):

```typescript
✅ tokenizeCard() - Lines 316-394 (80 lines)
✅ authorizePayment() - Lines 403-481 (78 lines)
✅ OAuth client setup - Lines 73-126
✅ Error handling - Lines 195-209, 379-393, 466-480
✅ detectCardBrand() - Lines 487-495
```

---

#### 2. `src/services/sdk/blumon-ecommerce.interface.ts` (128 lines)

**REMOVE** (~48 lines):

```typescript
❌ BlumonHostedCheckoutRequest (lines 42-59)
❌ BlumonHostedCheckoutResponse (lines 61-71)
❌ cancelCheckout() from IBlumonEcommerceService (line 126)
```

**KEEP** (~80 lines):

```typescript
✅ BlumonTokenizeRequest
✅ BlumonTokenizeResponse
✅ BlumonAuthorizeRequest
✅ BlumonAuthorizeResponse
✅ tokenizeCard() in interface
✅ authorizePayment() in interface
```

---

#### 3. `src/services/sdk/blumon-ecommerce.service.mock.ts` (350 lines)

**REMOVE** (~120 lines):

```typescript
❌ createHostedCheckout() - Lines 267-299 (33 lines)
❌ cancelCheckout() - Lines 311-327 (17 lines)
❌ Mock checkout URL generation - Line 281
```

**KEEP** (~230 lines):

```typescript
✅ tokenizeCard() mock - Lines 132-172
✅ authorizePayment() mock - Lines 180-256
✅ Test scenarios - Lines 54-118
✅ detectCardBrand() - Lines 335-348
```

---

#### 4. `src/services/sdk/checkout-session.service.ts` (533 lines)

**MAJOR REFACTORING NEEDED**:

Current flow (lines 136-233):

```typescript
// ❌ REMOVE: Hosted checkout creation
const blumonCheckout = await blumonService.createHostedCheckout({
  accessToken,
  amount: data.amount,
  // ... redirect URLs, webhook URL
})
checkoutUrl = blumonCheckout.checkoutUrl
```

**New flow** (direct charge):

```typescript
// ✅ NEW: Session for tracking only, no Blumon API call
// Payment happens in separate endpoint (tokenize + authorize)
// Session just tracks the transaction
```

**Functions to modify**:

- ✅ `createCheckoutSession()` - Remove Blumon API call (lines 136-233), keep DB session creation
- ✅ `updateCheckoutSessionStatus()` - Keep for tracking (called after direct charge succeeds)
- ✅ `getCheckoutSession()` - Keep as-is
- ✅ `cancelCheckoutSession()` - Remove Blumon cancellation (lines 177-207), keep DB update
- ✅ `listCheckoutSessions()` - Keep as-is
- ✅ `cleanupExpiredSessions()` - Keep as-is
- ✅ `getCheckoutSessionStats()` - Keep as-is

---

#### 5. `src/controllers/sdk/checkout.sdk.controller.ts` (311 lines)

**MAJOR REFACTORING NEEDED**:

Current response (lines 101-109):

```typescript
// ❌ Returns checkoutUrl for redirect
res.status(201).json({
  id: session.id,
  sessionId: session.sessionId,
  checkoutUrl: session.checkoutUrl, // ❌ REMOVE
  status: session.status,
  // ...
})
```

**New response** (no redirect):

```typescript
// ✅ Returns session ID only (no checkout URL)
res.status(201).json({
  id: session.id,
  sessionId: session.sessionId,
  // No checkoutUrl - payment happens via separate tokenize + authorize endpoints
  status: session.status,
  // ...
})
```

**Functions to modify**:

- ✅ `createCheckoutSession()` - Remove checkoutUrl from response
- ✅ `getCheckoutSession()` - Remove blumonCheckoutUrl field (line 139)
- ✅ `cancelCheckoutSession()` - Remove Blumon cancellation (lines 177-207)
- ✅ `listCheckoutSessions()` - Keep as-is
- ✅ `getCheckoutStats()` - Keep as-is

---

#### 6. `src/routes/sdk/checkout.sdk.routes.ts`

**NEW ROUTES NEEDED**:

```typescript
// ✅ KEEP: Session management
POST   /api/v1/sdk/checkout/sessions - Create session (no Blumon call)
GET    /api/v1/sdk/checkout/sessions/:id - Get session
POST   /api/v1/sdk/checkout/sessions/:id/cancel - Cancel session
GET    /api/v1/sdk/checkout/sessions - List sessions
GET    /api/v1/sdk/checkout/stats - Get stats

// ✅ ADD: Direct charge endpoints
POST   /api/v1/sdk/payments/tokenize - Tokenize card
POST   /api/v1/sdk/payments/authorize - Authorize payment
```

---

#### 7. `src/routes/sdk.routes.ts`

**REMOVE**:

```typescript
❌ import webhookRoutes from './sdk/webhooks.sdk.routes'
❌ import webhookSimulatorRoutes from './sdk/webhook-simulator.sdk.routes'
❌ router.use('/webhooks', webhookRoutes)
❌ router.use('/webhook-simulator', webhookSimulatorRoutes)
```

**KEEP**:

```typescript
✅ import checkoutRoutes from './sdk/checkout.sdk.routes'
✅ import tokenizeRoutes from './sdk/tokenize.sdk.routes'  // If exists
✅ router.use('/checkout', checkoutRoutes)
```

---

### 📝 **TEST SCRIPTS TO MIGRATE** (13+ files)

**Scripts to migrate from `scripts/` to `tests/integration/blumon/`:**

| Script                                   | Migrate To                                           | Status                             |
| ---------------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| `test-blumon-checkout-flow.ts`           | ❌ DELETE                                            | Tests hosted checkout (not needed) |
| `test-blumon-mock.ts`                    | ✅ `tests/unit/blumon/mock-service.test.ts`          | Keep (tests direct charge mock)    |
| `test-blumon-public-tokenize.ts`         | ✅ `tests/integration/blumon/tokenize.test.ts`       | Keep (tests tokenization)          |
| `test-blumon-tokenize-direct.ts`         | ✅ `tests/integration/blumon/authorize.test.ts`      | Keep (tests authorization)         |
| `test-ecommerce-merchant-endpoints.ts`   | ✅ `tests/api/blumon/merchant-endpoints.test.ts`     | Keep (tests merchant CRUD)         |
| `create-checkout-with-valid-merchant.ts` | ❌ DELETE or ✅ REFACTOR                             | Update for direct charge           |
| `create-test-checkout-session.ts`        | ❌ DELETE or ✅ REFACTOR                             | Update for direct charge           |
| `create-small-checkout.ts`               | ❌ DELETE or ✅ REFACTOR                             | Update for direct charge           |
| `create-direct-session.ts`               | ✅ KEEP or ✅ REFACTOR                               | Already direct charge?             |
| `list-active-sessions.ts`                | ✅ `tests/integration/blumon/list-sessions.test.ts`  | Keep                               |
| `check-session-status.ts`                | ✅ `tests/integration/blumon/session-status.test.ts` | Keep                               |
| `check-blumon-merchant.ts`               | ✅ `tests/integration/blumon/merchant-check.test.ts` | Keep                               |
| `blumon-authenticate-master.ts`          | ✅ `tests/integration/blumon/oauth-auth.test.ts`     | Keep                               |
| `generate-blumon-payment-link.ts`        | ❌ DELETE                                            | Generates hosted checkout link     |
| `blumon-help.ts`                         | ✅ KEEP                                              | Dev utility                        |

---

## 🏗️ NEW ARCHITECTURE

### **Old Flow** (Hosted Checkout - DELETING):

```
┌─────────────────────────────────────────────────────────┐
│ 1. POST /api/v1/sdk/checkout/sessions                  │
│    → Create session in DB                               │
│    → Call Blumon: createHostedCheckout()               │
│    → Return: { checkoutUrl: "https://blumon.com/..." } │
└─────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────┐
│ 2. Frontend redirects customer to Blumon               │
│    URL: https://blumonpay.com/checkout/abc123          │
└─────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────┐
│ 3. Blumon sends webhook                                 │
│    POST /api/v1/sdk/webhooks/blumon                    │
│    → Verify signature (DISABLED - VULNERABILITY!)      │
│    → Update session status                              │
└─────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────┐
│ 4. Frontend polls for status or redirects back         │
└─────────────────────────────────────────────────────────┘
```

---

### **New Flow** (Direct Charge - IMPLEMENTING):

```
┌─────────────────────────────────────────────────────────┐
│ 1. POST /api/v1/sdk/checkout/sessions                  │
│    → Create session in DB (tracking only)              │
│    → Return: { sessionId: "cs_test_abc123" }           │
│    (No Blumon API call, no redirect URL)               │
└─────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────┐
│ 2. Frontend collects card details on Avoqado form      │
│    Customer stays on: https://app.avoqado.io/checkout  │
│    Card: 4111 1111 1111 1111                            │
│    CVV: 123                                              │
│    Expiry: 12/25                                         │
└─────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────┐
│ 3. POST /api/v1/sdk/payments/charge (NEW ENDPOINT)     │
│    {                                                     │
│      sessionId: "cs_test_abc123",                       │
│      card: {                                             │
│        number: "4111111111111111",                      │
│        cvv: "123",                                       │
│        expMonth: "12",                                   │
│        expYear: "2025",                                  │
│        holderName: "John Doe"                           │
│      }                                                   │
│    }                                                     │
│    → Backend: tokenizeCard()        ✅ SYNCHRONOUS      │
│    → Backend: authorizePayment()    ✅ SYNCHRONOUS      │
│    → Update session: status = COMPLETED                 │
│    → Return: { success: true, txId: "..." }             │
└─────────────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────────────┐
│ 4. Frontend shows result IMMEDIATELY                    │
│    ✅ Payment Successful!                               │
│    (No redirect, no polling, no webhooks)               │
└─────────────────────────────────────────────────────────┘
```

---

## 🎯 IMPLEMENTATION PLAN

### **Phase 1: DELETE** (1 hour)

1. ✅ Delete webhook routes

   ```bash
   rm src/routes/sdk/webhooks.sdk.routes.ts
   rm src/routes/sdk/webhook-simulator.sdk.routes.ts
   rm src/controllers/sdk/webhook-simulator.sdk.controller.ts
   ```

2. ✅ Remove webhook imports from `src/routes/sdk.routes.ts`

3. ✅ Delete test scripts for hosted checkout
   ```bash
   rm scripts/test-blumon-checkout-flow.ts
   rm scripts/generate-blumon-payment-link.ts
   rm scripts/create-checkout-with-valid-merchant.ts  # If hosted checkout
   ```

---

### **Phase 2: REFACTOR Services** (2-3 hours)

4. ✅ `blumon-ecommerce.service.ts`:

   - Remove `createHostedCheckout()`
   - Remove `verifyWebhookSignature()`
   - Remove `getCheckoutStatus()`
   - Remove `cancelCheckout()`
   - Keep `tokenizeCard()` and `authorizePayment()`

5. ✅ `blumon-ecommerce.interface.ts`:

   - Remove hosted checkout interfaces
   - Remove `cancelCheckout` from interface

6. ✅ `blumon-ecommerce.service.mock.ts`:

   - Remove `createHostedCheckout()` mock
   - Remove `cancelCheckout()` mock

7. ✅ `checkout-session.service.ts`:
   - Remove Blumon API call from `createCheckoutSession()` (lines 136-233)
   - Keep session creation in DB (just for tracking)
   - Remove Blumon cancellation from `cancelCheckoutSession()`

---

### **Phase 3: CREATE New Endpoints** (2-3 hours)

8. ✅ Create `src/controllers/sdk/payment.sdk.controller.ts`:

   ```typescript
   // POST /api/v1/sdk/payments/charge
   export async function chargeCard(req, res) {
     // 1. Validate card data
     // 2. Get session
     // 3. Tokenize card
     // 4. Authorize payment
     // 5. Update session status
     // 6. Return result
   }
   ```

9. ✅ Create `src/routes/sdk/payment.sdk.routes.ts`:

   ```typescript
   router.post('/charge', authenticateSDK, chargeCard)
   ```

10. ✅ Update `src/routes/sdk.routes.ts`:
    ```typescript
    import paymentRoutes from './sdk/payment.sdk.routes'
    router.use('/payments', paymentRoutes)
    ```

---

### **Phase 4: UPDATE Controllers** (1 hour)

11. ✅ `checkout.sdk.controller.ts`:
    - Remove `checkoutUrl` from `createCheckoutSession()` response
    - Remove `blumonCheckoutUrl` from `getCheckoutSession()` response
    - Remove Blumon cancellation from `cancelCheckoutSession()`

---

### **Phase 5: MIGRATE Tests** (3-4 hours)

12. ✅ Create `tests/integration/blumon/`:

    - `tokenize.test.ts` (from `test-blumon-public-tokenize.ts`)
    - `authorize.test.ts` (from `test-blumon-tokenize-direct.ts`)
    - `direct-charge-flow.test.ts` (NEW - full flow test)
    - `oauth-auth.test.ts` (from `blumon-authenticate-master.ts`)
    - `merchant-endpoints.test.ts` (from `test-ecommerce-merchant-endpoints.ts`)

13. ✅ Create `tests/unit/blumon/`:

    - `mock-service.test.ts` (from `test-blumon-mock.ts`)
    - `error-parser.test.ts` (NEW)

14. ✅ Delete old scripts from `scripts/`

---

### **Phase 6: UPDATE Documentation** (1-2 hours)

15. ✅ Update `docs/blumon-ecommerce/`:

    - Mark all hosted checkout docs as DEPRECATED
    - Create `DIRECT_CHARGE_IMPLEMENTATION.md`
    - Update `SDK_INTEGRATION_GUIDE.md` with new flow
    - Update `BLUMON_ECOMMERCE_IMPLEMENTATION.md` (remove hosted checkout)

16. ✅ Update `CLAUDE.md`:
    - Remove references to webhooks/hosted checkout
    - Add direct charge flow documentation

---

## 📊 FINAL METRICS

**Code Reduction**:

- ❌ Deleted: ~629 lines (webhooks, simulators)
- ❌ Removed from services: ~290 lines (hosted checkout methods)
- ✅ Kept: ~708 lines (tokenize, authorize, OAuth)
- ✅ New code: ~150 lines (direct charge controller)

**Total**: Reducing codebase by ~769 lines (~44% reduction)

**Test Scripts**:

- ❌ Deleted: 3-4 scripts (hosted checkout tests)
- ✅ Migrated: 9-10 scripts → Jest tests
- ✅ New tests: 3-5 integration tests

**Architecture**:

- ❌ Async flow: Redirect → Webhook → Poll (REMOVED)
- ✅ Sync flow: Tokenize → Authorize → Result (NEW)

**Security**:

- ❌ Webhook signature vulnerability (REMOVED)
- ✅ No webhooks = No vulnerability

**User Experience**:

- ❌ Customer redirects to Blumon (REMOVED)
- ✅ Customer stays on Avoqado (NEW)
- ❌ Async payment (wait for webhook) (REMOVED)
- ✅ Instant payment result (NEW)

---

## ✅ VERIFICATION CHECKLIST

After refactoring, verify:

- [ ] No files in `src/routes/sdk/` reference webhooks
- [ ] No files in `src/controllers/sdk/` reference webhooks
- [ ] `blumon-ecommerce.service.ts` has ONLY tokenize + authorize
- [ ] `blumon-ecommerce.interface.ts` has NO hosted checkout interfaces
- [ ] `checkout-session.service.ts` creates sessions without Blumon API calls
- [ ] New `/api/v1/sdk/payments/charge` endpoint exists
- [ ] All test scripts migrated from `scripts/` to `tests/`
- [ ] `npm test` passes (0 failures)
- [ ] `npm run lint` passes (0 errors)
- [ ] Documentation updated (no hosted checkout references)

---

## 🚀 READY TO EXECUTE?

This plan:

- ✅ Removes security vulnerabilities
- ✅ Simplifies architecture
- ✅ Improves user experience
- ✅ Reduces maintenance burden
- ✅ Keeps all working code

**Estimated Time**: 8-12 hours total **Risk Level**: Low (removing unused code, keeping tested code) **Testing Required**: Integration tests
for direct charge flow

**Next Step**: Begin Phase 1 (DELETE) - Remove webhook files
