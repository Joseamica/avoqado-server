# Production Readiness Checklist - Blumon SDK Integration

**Date**: November 15, 2025 **Current Status**: ⚠️ **Development Ready** (Not Production Ready)

---

## 🎯 Priority Levels

- 🔴 **CRITICAL** - Must have before production
- 🟡 **HIGH** - Should have for good UX
- 🟢 **MEDIUM** - Nice to have
- ⚪ **LOW** - Future enhancement

---

## 🔴 CRITICAL (Must Have Before Production)

### 1. ✅ Webhook Handlers (DONE - Need to implement)

**WHY**: Blumon sends payment status updates asynchronously. Without webhooks, you won't know when payments complete, fail, or get refunded.

**What Stripe/Square/Toast do**:

- Listen for `payment.succeeded`, `payment.failed`, `payment.refunded` events
- Update order status in database
- Send confirmation emails
- Trigger fulfillment workflows

**Implementation needed**:

```typescript
// src/controllers/sdk/webhooks.sdk.controller.ts
POST /api/v1/sdk/webhooks/blumon
- Verify webhook signature (security)
- Handle payment.authorized
- Handle payment.captured
- Handle payment.failed
- Handle payment.refunded
- Update CheckoutSession status
- Trigger post-payment actions (email, inventory, etc.)
```

**Files to create**:

- `src/controllers/sdk/webhooks.sdk.controller.ts`
- `src/services/sdk/blumon-webhook-handler.service.ts`
- `src/routes/sdk/webhooks.sdk.routes.ts`

**Estimated time**: 4-6 hours

---

### 2. ✅ Automatic OAuth Token Refresh

**WHY**: Tokens expire every 3 hours. In production, you can't manually re-authenticate.

**What Stripe/Square/Toast do**:

- Auto-refresh tokens before expiration
- Fallback: If request fails with 401, refresh and retry
- Background job checks token expiration every hour

**Current issue**: Manual script `blumon-authenticate-master.ts`

**Implementation needed**:

```typescript
// src/services/sdk/oauth-refresh.service.ts
class OAuthRefreshService {
  // Check all merchants every hour
  async refreshExpiredTokens() {
    const expiringSoon = await findMerchantsWithExpiringTokens(60) // 60 min buffer
    for (const merchant of expiringSoon) {
      await refreshMerchantToken(merchant)
    }
  }
}

// Cron job (every hour)
cron.schedule('0 * * * *', () => {
  oauthRefreshService.refreshExpiredTokens()
})
```

**Implementation**:

- Add `node-cron` dependency
- Create refresh service
- Add to `src/app.ts` startup

**Estimated time**: 2-3 hours

---

### 3. 🔐 Webhook Signature Verification

**WHY**: Prevents attackers from sending fake webhook events to your server.

**What Stripe/Square/Toast do**:

- Sign webhooks with HMAC-SHA256
- Server verifies signature before processing
- Reject unsigned/invalid webhooks

**Implementation needed**:

```typescript
// Verify Blumon webhook signature
function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  const expectedSignature = crypto.createHmac('sha256', secret).update(payload).digest('hex')

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
}
```

**Files to modify**:

- `src/controllers/sdk/webhooks.sdk.controller.ts`

**Estimated time**: 1-2 hours

---

### 4. 📊 Production Credentials Setup

**WHY**: Sandbox credentials don't work in production. Real money = real credentials.

**What you need from Blumon**:

- Production API URL
- Production OAuth credentials
- Production webhook secret
- Production merchant IDs

**Implementation**:

```typescript
// .env.production
BLUMON_PRODUCTION_API_URL=https://api.blumonpay.com
BLUMON_PRODUCTION_OAUTH_CLIENT_ID=xxx
BLUMON_PRODUCTION_OAUTH_CLIENT_SECRET=xxx
BLUMON_PRODUCTION_WEBHOOK_SECRET=xxx

// Update EcommerceMerchant
UPDATE "EcommerceMerchant"
SET "sandboxMode" = false,
    "providerCredentials" = {...production tokens...}
WHERE id = 'xxx'
```

**Estimated time**: 1 hour (once you have credentials)

---

### 5. 🔒 Rate Limiting & Security Hardening

**WHY**: Prevent abuse, brute force attacks, and DoS.

**What Stripe/Square/Toast do**:

- 100 requests/minute per IP for tokenization
- 10 failed payment attempts → block for 1 hour
- CAPTCHA after 3 failed attempts
- IP whitelisting for webhooks

**Implementation needed**:

```typescript
// src/middlewares/rate-limit.middleware.ts
import rateLimit from 'express-rate-limit'

export const tokenizationRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: 'Too many tokenization requests, please try again later',
})

export const paymentRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 payment attempts per minute
  message: 'Too many payment attempts, please try again later',
})

// Apply to routes
router.post('/tokenize', tokenizationRateLimit, tokenizeCard)
router.post('/charge', paymentRateLimit, chargeWithToken)
```

**Dependencies**: `express-rate-limit`, `rate-limit-redis` (for distributed rate limiting)

**Estimated time**: 2-3 hours

---

### 6. 💾 Idempotency Keys (Prevent Duplicate Charges)

**WHY**: Network issues can cause duplicate payment requests. Idempotency prevents charging twice.

**What Stripe/Square/Toast do**:

```typescript
// Frontend sends idempotency key
POST /api/v1/sdk/charge
Headers: {
  "Idempotency-Key": "unique-id-12345"
}

// Backend checks if already processed
const existingPayment = await prisma.payment.findUnique({
  where: { idempotencyKey: req.headers['idempotency-key'] }
})

if (existingPayment) {
  return res.json(existingPayment) // Return cached result
}

// Process payment + store idempotency key
```

**Implementation needed**:

- Add `idempotencyKey` field to `Payment` model
- Add middleware to extract/validate idempotency key
- Check cache before processing payment

**Estimated time**: 3-4 hours

---

### 7. 📧 Email Notifications (Payment Confirmations)

**WHY**: Customers expect email receipts. Professional businesses send them.

**What Stripe/Square/Toast do**:

- Payment succeeded → Email receipt
- Payment failed → Email failure notice
- Refund processed → Email refund confirmation

**Implementation needed**:

```typescript
// src/services/email/payment-email.service.ts
class PaymentEmailService {
  async sendPaymentReceipt(payment: Payment) {
    await sendEmail({
      to: payment.customerEmail,
      subject: `Payment Receipt - $${payment.amount} ${payment.currency}`,
      template: 'payment-receipt',
      data: { payment, merchant, items },
    })
  }
}

// Trigger after webhook confirms payment
webhookHandler.on('payment.succeeded', async payment => {
  await emailService.sendPaymentReceipt(payment)
})
```

**Dependencies**: `nodemailer`, `handlebars` (for templates)

**Estimated time**: 4-5 hours

---

## 🟡 HIGH Priority (Should Have)

### 8. 🔄 Session Cleanup / Expiration Cron Job

**WHY**: Old sessions accumulate in database. Clean up after 24 hours.

**Implementation**:

```typescript
// src/jobs/cleanup-expired-sessions.job.ts
cron.schedule('0 */6 * * *', async () => {
  // Every 6 hours
  const expired = await prisma.checkoutSession.updateMany({
    where: {
      status: { in: ['PENDING', 'PROCESSING'] },
      expiresAt: { lt: new Date() },
    },
    data: { status: 'EXPIRED' },
  })

  logger.info(`🧹 Expired ${expired.count} old checkout sessions`)
})
```

**Estimated time**: 1 hour

---

### 9. 📊 Monitoring & Error Tracking

**WHY**: Know when things break in production BEFORE customers complain.

**What Stripe/Square/Toast use**:

- **Sentry** - Error tracking
- **Datadog/New Relic** - Performance monitoring
- **PagerDuty** - Alerting

**Implementation**:

```typescript
// src/config/sentry.ts
import * as Sentry from '@sentry/node'

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 1.0,
})

// Capture payment errors
try {
  await chargePayment()
} catch (error) {
  Sentry.captureException(error, {
    tags: { component: 'payment' },
    extra: { sessionId, amount, merchant },
  })
  throw error
}
```

**Dependencies**: `@sentry/node`

**Estimated time**: 2-3 hours

---

### 10. 🔍 Payment Status Polling (Webhook Fallback)

**WHY**: Webhooks can fail (network issues, server down). Polling ensures you don't miss payments.

**What Stripe/Square/Toast do**:

- Frontend polls `/status` endpoint every 3 seconds
- Backend checks Blumon API for payment status
- After 60 seconds → timeout

**Implementation**:

```typescript
// Frontend
let pollCount = 0
const interval = setInterval(async () => {
  const status = await fetch(`/api/v1/sdk/sessions/${sessionId}/status`)

  if (status.payment === 'COMPLETED') {
    clearInterval(interval)
    showSuccess()
  }

  if (pollCount++ > 20) { // 60 seconds
    clearInterval(interval)
    showTimeout()
  }
}, 3000)

// Backend
GET /api/v1/sdk/sessions/:sessionId/status
- Check local database first
- If PROCESSING > 30s, query Blumon API
- Return latest status
```

**Estimated time**: 3-4 hours

---

### 11. 💳 3D Secure / SCA Support

**WHY**: Required by European regulations (PSD2). Many cards require it.

**What Stripe/Square/Toast do**:

- Detect if card requires 3DS
- Redirect customer to bank's 3DS page
- Complete payment after authentication

**Implementation**:

```typescript
// Blumon may return `requires_3ds: true`
if (authResult.requires3DS) {
  return res.json({
    status: 'requires_action',
    redirectUrl: authResult.redirectUrl, // Bank's 3DS page
  })
}

// After 3DS complete, customer redirects back
GET /api/v1/sdk/confirm-payment?sessionId=xxx&3ds_result=success
```

**Check Blumon docs**: Does Blumon support 3DS? If yes, implement.

**Estimated time**: 6-8 hours (if Blumon supports it)

---

### 12. 💰 Refund Support

**WHY**: Customers return items. You need to refund payments.

**Implementation**:

```typescript
// src/controllers/sdk/refunds.sdk.controller.ts
POST /api/v1/sdk/refunds
{
  "paymentId": "pay_xxx",
  "amount": 50.00, // Partial or full
  "reason": "customer_request"
}

// Call Blumon refund API
const refund = await blumonService.createRefund({
  transactionId: payment.blumonTransactionId,
  amount: refundAmount,
})

// Update database
await prisma.payment.update({
  where: { id: paymentId },
  data: { status: 'REFUNDED', refundedAt: new Date() }
})
```

**Estimated time**: 4-5 hours

---

## 🟢 MEDIUM Priority (Nice to Have)

### 13. 📱 Multiple Payment Methods

**WHY**: Not everyone has credit cards. Support OXXO, SPEI, PayPal.

**What Stripe/Square/Toast do**:

- Credit/Debit cards
- Digital wallets (Apple Pay, Google Pay)
- Bank transfers (SPEI)
- Cash (OXXO, 7-Eleven)

**Check Blumon capabilities**: Does Blumon support these? Implement if yes.

**Estimated time**: 8-12 hours per method

---

### 14. 💱 Multiple Currency Support

**WHY**: International customers pay in their currency.

**Current**: Only MXN (484)

**Implementation**:

```typescript
// Support USD, EUR, etc.
const currencyCodes = {
  MXN: '484',
  USD: '840',
  EUR: '978',
}

const blumonCurrency = currencyCodes[session.currency]
```

**Estimated time**: 2-3 hours

---

### 15. 📈 Analytics Dashboard

**WHY**: Track conversion rates, failed payments, revenue.

**Metrics to track**:

- Payment success rate
- Average transaction value
- Failed payment reasons (card declined, insufficient funds)
- Time to complete payment
- Abandonment rate

**Implementation**: Add analytics events to payment flow

**Estimated time**: 8-12 hours

---

### 16. 🧪 End-to-End Testing

**WHY**: Automated tests catch bugs before production.

**What to test**:

- Full payment flow (tokenize → charge → webhook)
- Token expiration + auto-refresh
- Failed payments + retry logic
- Webhook signature verification
- Idempotency key handling

**Implementation**: Playwright/Cypress tests

**Estimated time**: 12-16 hours

---

### 17. 🗄️ Database Optimization

**WHY**: Fast queries = happy customers.

**Add indexes**:

```sql
-- Frequently queried fields
CREATE INDEX idx_checkout_session_id ON "CheckoutSession"("sessionId");
CREATE INDEX idx_checkout_session_status ON "CheckoutSession"("status");
CREATE INDEX idx_checkout_session_expires ON "CheckoutSession"("expiresAt");
CREATE INDEX idx_payment_transaction_id ON "Payment"("blumonTransactionId");
CREATE INDEX idx_payment_idempotency ON "Payment"("idempotencyKey");
```

**Estimated time**: 1 hour

---

## ⚪ LOW Priority (Future Enhancements)

### 18. 🔐 Card Vault / Saved Cards

**WHY**: Repeat customers don't want to re-enter card every time.

**Implementation**: Store Blumon tokens permanently (not one-time use)

**Estimated time**: 8-10 hours

---

### 19. 📄 Invoice Generation

**WHY**: Professional businesses send invoices.

**Implementation**: Generate PDF invoices after payment

**Estimated time**: 6-8 hours

---

### 20. 🌐 Multi-Language Support

**WHY**: International customers.

**Implementation**: i18n for error messages, emails, etc.

**Estimated time**: 4-6 hours

---

## 📊 Summary: What to Do First

### Week 1 (Critical - 20-30 hours)

1. ✅ Webhook handlers (6h)
2. ✅ OAuth auto-refresh (3h)
3. ✅ Webhook signature verification (2h)
4. ✅ Rate limiting (3h)
5. ✅ Idempotency keys (4h)
6. ✅ Email notifications (5h)

### Week 2 (High Priority - 15-20 hours)

7. ✅ Session cleanup job (1h)
8. ✅ Monitoring/Sentry (3h)
9. ✅ Payment status polling (4h)
10. ✅ Database indexes (1h)
11. ✅ End-to-end tests (12h)

### Week 3 (Medium Priority - 10-15 hours)

12. ✅ Refund support (5h)
13. ✅ 3D Secure (if Blumon supports - 8h)
14. ✅ Production credentials setup (1h)

### Week 4+ (Nice to Have)

15. Multiple payment methods
16. Analytics dashboard
17. Multi-currency
18. Saved cards
19. Invoices

---

## 🚀 Minimum Viable Production (MVP)

**Absolute minimum to go live:**

1. ✅ Webhook handlers (CRITICAL)
2. ✅ OAuth auto-refresh (CRITICAL)
3. ✅ Rate limiting (CRITICAL)
4. ✅ Production credentials (CRITICAL)
5. ✅ Monitoring/Sentry (HIGH)
6. ✅ Email notifications (HIGH)

**Estimated time**: 1-2 weeks for MVP

---

## 📞 Contact Blumon For

Before production, ask Blumon support:

1. **Production API credentials** - OAuth client ID/secret
2. **Webhook URL registration** - Where to send events
3. **Webhook secret** - For signature verification
4. **3D Secure support** - Is it available?
5. **Rate limits** - What are production limits?
6. **Refund API** - How to process refunds
7. **Test card reset** - Fix monthly limit issue
8. **Go-live checklist** - Any other requirements?

**Email**: support@blumonpay.com **Docs**: https://www.blumonpay.com/documentacion/

---

**Next Steps**: Review this checklist and decide which items to prioritize for your launch timeline.
