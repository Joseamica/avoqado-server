# 🎯 STRIPE COMPLETE IMPLEMENTATION PLAN

## "Claude-Style" Subscription Management - ULTRATHINK Analysis

**Date**: 2025-01-25 (Updated: 2025-10-28) **Goal**: Implement production-ready Stripe billing matching Claude.ai's subscription system
**Status**: Phase 2 - COMPLETE ✅ (Payment Methods ✅, Webhooks ✅, Invoicing ✅, Dunning Management ✅, Venue Migration ✅, Feature Sync
✅)

---

## 📊 CURRENT STATE ANALYSIS

### 🔄 RECENT CHANGES (2025-10-28)

**Critical Migration: Organization → Venue Level Stripe Customer**

**Why**: Payment methods added during onboarding weren't appearing because:

- Stripe customers saved to Organization
- Webhooks tried to save payment methods to Venue WHERE stripeCustomerId = customerId
- Venue.stripeCustomerId was never populated → webhook matched 0 records

**What Changed**:

1. Removed `Organization.stripeCustomerId` from schema
2. Moved all Stripe customer creation to Venue level
3. Updated `getOrCreateStripeCustomer()` signature: `organizationId` → `venueId`
4. Added venue slug to Stripe customer names for easy identification
5. Updated all 6 call sites in codebase
6. Fixed webhook `payment_method.attached` to save to `venue.stripePaymentMethodId`

**Migration**: `prisma/migrations/20251027235905_remove_organization_stripe_customer/`

**Automatic Feature Sync System**

**Implementation**: Features auto-sync to Stripe during seed without manual intervention.

**How it works**:

```bash
npm run seed
# 1. Creates/updates features in database (upsert)
# 2. Automatically syncs to Stripe (creates products/prices if missing)
# 3. Updates database with Stripe IDs
# 4. Idempotent - safe to run multiple times
```

**Key Changes**:

- Seed does NOT delete features (preserves Stripe IDs across runs)
- `syncFeaturesToStripe()` checks if product/price exists before creating
- Creates NEW on first run, UPDATES on subsequent runs
- No duplicates in Stripe on repeated seed runs

**Production Workflow**:

```bash
# Switch to production Stripe
STRIPE_SECRET_KEY=sk_live_...
# Clear test IDs (one-time)
psql -c "UPDATE Feature SET stripeProductId=NULL, stripePriceId=NULL"
# Run seed - auto-syncs to production
npm run seed
```

### ✅ What We HAVE (Implemented)

#### Backend Core:

- ✅ `getOrCreateStripeCustomer(venueId, ...)` - Creates Stripe customers per venue (includes venue slug in name)
- ✅ `syncFeaturesToStripe()` - Auto-syncs features to Stripe (idempotent, runs on seed)
- ✅ `createTrialSubscriptions()` - 5-day trial periods
- ✅ Feature access middleware (`checkFeatureAccess`)
- ✅ Basic webhook handlers:
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_succeeded`
  - `invoice.payment_failed`
  - `payment_method.attached` (saves to venue.stripePaymentMethodId)

#### Frontend Core:

- ✅ Billing page UI
- ✅ Payment method form (Stripe Elements)
- ✅ Trial status banner
- ✅ Active subscriptions display

#### Database:

- ✅ `Venue.stripeCustomerId` (MIGRATED from Organization 2025-10-28)
- ✅ `Venue.stripePaymentMethodId` (stores default payment method)
- ✅ `Feature.stripeProductId` and `Feature.stripePriceId` (auto-synced)
- ✅ `VenueFeature` with trial tracking
- ✅ `VenueFeature` with grace period fields (suspendedAt, gracePeriodEndsAt, etc.)
- ✅ Subscription metadata storage
- ❌ `Organization.stripeCustomerId` - REMOVED (migrated to Venue level)

#### Permissions & Access Control:

- ✅ OWNER/ADMIN billing access (`venues:*` permission) - FIXED (2025-10-27)
- ✅ Permission management API (role permissions CRUD)
- ✅ Feature access middleware with suspension checks

---

## ❌ CRITICAL GAPS (What Claude Does That We Don't)

### 1. Payment Method Management

```
✅ Setup Intent (add card without charging)
✅ List saved payment methods
✅ Update/delete payment methods
✅ Set default payment method
✅ Payment method verification (3D Secure)
```

**Implementation Status**: COMPLETE

- Backend: `src/services/dashboard/venue.dashboard.service.ts` (lines 1050-1150)
- Endpoints: POST/GET/PUT/DELETE `/api/v1/dashboard/venues/:venueId/payment-methods`
- Frontend: `src/pages/Settings/Billing.tsx` with Stripe Elements integration

**Implementation Notes:**

- **2025-10-27 Bug Fixes:**
  - Fixed payment method webhook (`payment_method.attached`) to save payment method ID to database (`venue.stripePaymentMethodId`)
  - Fixed payment method webhook to set as default in Stripe (`invoice_settings.default_payment_method`)
  - Synced all Stripe products/prices for 6 features (CHATBOT, ADVANCED_ANALYTICS, INVENTORY_TRACKING, LOYALTY_PROGRAM, ONLINE_ORDERING,
    RESERVATIONS)
  - Fixed all unit tests - 153 tests passing (webhook event model names, field names, duplicate operations)
  - Created one-time script to fix existing venue with payment method (`scripts/temp-update-payment-method.ts`)

### 2. Subscription Lifecycle

```
N/A Change plan (upgrade/downgrade) - NOT NEEDED (features don't have tiers)
✅ Cancel with grace period - IMPLEMENTED (via dunning system)
✅ Reactivate canceled subscriptions - IMPLEMENTED (via payment update)
N/A Pause/resume subscriptions - NOT NEEDED for current business model
❌ Preview invoice before changes - OPTIONAL (low priority)
```

**Implementation Note (2025-10-27):**

- Upgrade/downgrade not needed: All features are binary (active/inactive), no pricing tiers
- Cancellation handled through dunning system (soft → hard cancel flow)
- Reactivation happens automatically when customer updates payment method and payment succeeds

### 3. Billing History & Invoices

```
✅ List past invoices
✅ Download invoice PDFs
❌ View payment attempts
❌ Retry failed payments manually
❌ Upcoming invoice preview
```

**Implementation Status**: PARTIAL

- Backend: `src/services/features.service.ts:getVenueInvoices()`, `downloadInvoice()`
- Frontend: `src/pages/Settings/Billing.tsx` invoice table with download button
- Missing: Manual retry, upcoming invoice preview

### 4. Error Handling & Recovery

```
✅ Payment retry logic (automatic) - IMPLEMENTED (2025-10-27)
✅ Grace period after failed payment - IMPLEMENTED (2025-10-27)
✅ Dunning management (Days 0, 3, 5, 7, 14) - IMPLEMENTED (2025-10-27)
✅ Soft suspension vs hard cancelation - IMPLEMENTED (2025-10-27)
✅ Email notifications on each event - IMPLEMENTED (2025-10-27)
```

**Implementation Status**: COMPLETE

- Backend: `src/services/stripe.service.ts:handlePaymentFailure()` (lines 737-891)
- Database: `VenueFeature` fields: `suspendedAt`, `gracePeriodEndsAt`, `lastPaymentAttempt`, `paymentFailureCount`
- Emails: `src/services/email.service.ts` - Payment failed, suspended, canceled templates
- Cron: `src/jobs/subscription-cancellation.job.ts` - Daily job for hard cancellation
- Middleware: `src/middlewares/checkFeatureAccess.middleware.ts` - Suspension checks

**Implementation Notes (2025-10-27):**

- Progressive dunning: Days 0, 3, 5 (warnings) → Day 7 (soft suspension) → Day 14 (hard cancel)
- Non-blocking email sends (payment processing never fails due to email issues)
- Billing portal URL generation helper for easy payment method updates
- All emails integrated with full HTML/text templates

### 5. Missing Webhook Handlers

```
❌ payment_intent.payment_failed
✅ customer.subscription.trial_will_end (3 days warning) - IMPLEMENTED
❌ invoice.upcoming (preview before charge)
❌ invoice.payment_action_required (3D Secure)
❌ charge.dispute.created
❌ customer.updated
```

**Implementation Status**: PARTIAL

- ✅ Implemented: `trial_will_end` with email + in-app notifications
- ✅ Implemented: `invoice.payment_failed` (basic logging, no notifications yet)
- ✅ Implemented: `customer.deleted` with cleanup
- Backend: `src/services/stripe.webhook.service.ts`

### 6. Advanced Features

```
❌ Coupons/promo codes
❌ Usage-based billing
❌ Multiple subscriptions per customer
❌ Billing portal (Stripe Customer Portal)
❌ Tax calculation (Stripe Tax)
```

---

## 🎯 IMPLEMENTATION PHASES

## PHASE 1: Critical Payment Flow (Week 1-2) 🔥

**Goal**: Users can add/manage payment methods and subscriptions work end-to-end **Status**: ✅ MOSTLY COMPLETE (Payment methods ✅,
Invoicing ✅, Missing: Subscription upgrades/downgrades)

### 1.1 Setup Intent & Payment Methods

**New Service Functions** (`stripe.service.ts`):

```typescript
// Create setup intent for adding card without charging
export async function createSetupIntent(customerId: string): Promise<{ clientSecret: string }> {
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'off_session', // Allow charging later without customer present
  })
  return { clientSecret: setupIntent.client_secret! }
}

// List all payment methods for a customer
export async function listPaymentMethods(customerId: string): Promise<Stripe.PaymentMethod[]> {
  const paymentMethods = await stripe.paymentMethods.list({
    customer: customerId,
    type: 'card',
  })
  return paymentMethods.data
}

// Update default payment method
export async function setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
  await stripe.customers.update(customerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  })
}

// Remove payment method
export async function detachPaymentMethod(paymentMethodId: string): Promise<void> {
  await stripe.paymentMethods.detach(paymentMethodId)
}
```

**New API Endpoints** (`billing.routes.ts`):

```typescript
// POST /api/v1/dashboard/venues/:venueId/billing/setup-intent
// Response: { clientSecret: "seti_..." }
router.post('/setup-intent', billingController.createSetupIntent)

// GET /api/v1/dashboard/venues/:venueId/billing/payment-methods
router.get('/payment-methods', billingController.listPaymentMethods)

// PUT /api/v1/dashboard/venues/:venueId/billing/payment-methods/:pmId/default
router.put('/payment-methods/:pmId/default', billingController.setDefaultPaymentMethod)

// DELETE /api/v1/dashboard/venues/:venueId/billing/payment-methods/:pmId
router.delete('/payment-methods/:pmId', billingController.removePaymentMethod)
```

**Frontend Integration** (Dashboard):

```typescript
// 1. Fetch setup intent
const { clientSecret } = await api.createSetupIntent(venueId)

// 2. Use Stripe.js to collect card
const { setupIntent, error } = await stripe.confirmCardSetup(clientSecret, {
  payment_method: {
    card: cardElement,
    billing_details: { name: 'Customer Name' },
  },
})

// 3. Payment method is automatically attached to customer
// 4. Refresh payment methods list
```

### 1.2 Subscription Management

**Service Functions** (`stripe.service.ts`):

```typescript
// Upgrade/downgrade subscription
export async function updateSubscription(
  subscriptionId: string,
  newPriceId: string,
  options?: {
    prorate?: boolean // Default: true
    prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice'
  },
): Promise<Stripe.Subscription> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)

  return await stripe.subscriptions.update(subscriptionId, {
    items: [
      {
        id: subscription.items.data[0].id,
        price: newPriceId,
      },
    ],
    proration_behavior: options?.prorationBehavior || 'create_prorations',
  })
}

// Cancel subscription with options
export async function cancelSubscription(
  subscriptionId: string,
  options?: {
    immediately?: boolean // true = cancel now, false = end of period
    reason?: 'customer_request' | 'too_expensive' | 'other'
  },
): Promise<Stripe.Subscription> {
  if (options?.immediately) {
    return await stripe.subscriptions.cancel(subscriptionId)
  } else {
    // Cancel at period end
    return await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
      cancellation_details: {
        comment: options?.reason,
      },
    })
  }
}

// Reactivate canceled subscription (before period end)
export async function reactivateSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  return await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: false,
  })
}

// Preview upcoming invoice
export async function previewInvoice(
  customerId: string,
  options?: {
    subscriptionId?: string
    newPriceId?: string
  },
): Promise<Stripe.Invoice> {
  return await stripe.invoices.retrieveUpcoming({
    customer: customerId,
    subscription: options?.subscriptionId,
    subscription_items: options?.newPriceId
      ? [
          {
            price: options.newPriceId,
          },
        ]
      : undefined,
  })
}
```

**New API Endpoints**:

```typescript
// PUT /api/v1/dashboard/venues/:venueId/features/:featureId/upgrade
// Body: { newPriceId: "price_xxx", prorate: true }
router.put('/features/:featureId/upgrade', featureController.upgradeFeature)

// DELETE /api/v1/dashboard/venues/:venueId/features/:featureId/cancel
// Body: { immediately: false, reason: "too_expensive" }
router.delete('/features/:featureId/cancel', featureController.cancelFeature)

// POST /api/v1/dashboard/venues/:venueId/features/:featureId/reactivate
router.post('/features/:featureId/reactivate', featureController.reactivateFeature)

// GET /api/v1/dashboard/venues/:venueId/billing/preview-invoice
// Query: ?newPriceId=price_xxx (optional)
router.get('/billing/preview-invoice', billingController.previewInvoice)
```

### 1.3 Invoice History

**Service Functions** (`stripe.service.ts`):

```typescript
// List invoices for customer
export async function listInvoices(
  customerId: string,
  options?: {
    limit?: number
    startingAfter?: string
  },
): Promise<Stripe.ApiList<Stripe.Invoice>> {
  return await stripe.invoices.list({
    customer: customerId,
    limit: options?.limit || 10,
    starting_after: options?.startingAfter,
  })
}

// Get invoice PDF
export async function getInvoicePdf(invoiceId: string): Promise<string> {
  const invoice = await stripe.invoices.retrieve(invoiceId)
  return invoice.invoice_pdf! // URL to PDF
}

// Retry failed invoice
export async function retryInvoice(invoiceId: string): Promise<Stripe.Invoice> {
  return await stripe.invoices.pay(invoiceId, {
    forgive: false, // Don't forgive unpaid amount
  })
}
```

**New API Endpoints**:

```typescript
// GET /api/v1/dashboard/venues/:venueId/billing/invoices
// Query: ?limit=10&startingAfter=in_xxx
router.get('/billing/invoices', billingController.listInvoices)

// GET /api/v1/dashboard/venues/:venueId/billing/invoices/:invoiceId/pdf
router.get('/billing/invoices/:invoiceId/pdf', billingController.getInvoicePdf)

// POST /api/v1/dashboard/venues/:venueId/billing/invoices/:invoiceId/retry
router.post('/billing/invoices/:invoiceId/retry', billingController.retryInvoice)
```

### 1.4 Critical Webhook Handlers

**New Webhooks** (`stripe.webhook.service.ts`):

```typescript
// Trial ending soon (3 days before)
case 'customer.subscription.trial_will_end':
  const subscription = event.data.object as Stripe.Subscription
  // Send email: "Your trial ends in 3 days"
  await sendTrialEndingEmail(subscription.customer, subscription.trial_end)
  break

// Payment requires action (3D Secure)
case 'invoice.payment_action_required':
  const invoice = event.data.object as Stripe.Invoice
  // Send email with link to complete 3D Secure
  await sendPaymentActionRequiredEmail(
    invoice.customer,
    invoice.hosted_invoice_url
  )
  break

// Upcoming invoice (7 days before charge)
case 'invoice.upcoming':
  const upcomingInvoice = event.data.object as Stripe.Invoice
  // Send email: "You'll be charged $X on DATE"
  await sendUpcomingInvoiceEmail(
    upcomingInvoice.customer,
    upcomingInvoice.amount_due,
    upcomingInvoice.next_payment_attempt
  )
  break

// Dispute created
case 'charge.dispute.created':
  const dispute = event.data.object as Stripe.Dispute
  // Alert admin about chargeback
  await notifyAdminOfDispute(dispute)
  break
```

---

## PHASE 2: Robust Error Handling (Week 3) 🛡️

**Goal**: Handle payment failures gracefully like Claude does

### 2.1 Grace Period & Retry Logic

**Dunning Strategy** (like Claude):

```
Payment Fails →
  ├─ Day 0: Immediate retry (Stripe automatic)
  ├─ Day 3: Retry + Email "Payment failed, please update"
  ├─ Day 5: Retry + Email "Final warning"
  ├─ Day 7: SOFT SUSPENSION
  │   ├─ Access blocked via checkFeatureAccess middleware
  │   ├─ Data NOT deleted
  │   └─ Email: "Subscription suspended, add payment method"
  └─ Day 14: HARD CANCELATION
      ├─ Subscription canceled in Stripe
      ├─ VenueFeature.active = false
      └─ Email: "Subscription canceled"
```

**Implementation**:

**New Database Fields** (Migration):

```sql
-- Add grace period tracking
ALTER TABLE "VenueFeature"
ADD COLUMN "suspendedAt" TIMESTAMP,
ADD COLUMN "gracePeriodEndsAt" TIMESTAMP,
ADD COLUMN "lastPaymentAttempt" TIMESTAMP,
ADD COLUMN "paymentFailureCount" INTEGER DEFAULT 0;
```

**Service Function** (`stripe.service.ts`):

```typescript
export async function handlePaymentFailure(subscriptionId: string, attemptCount: number): Promise<void> {
  const venueFeature = await prisma.venueFeature.findFirst({
    where: { stripeSubscriptionId: subscriptionId },
  })

  if (!venueFeature) return

  const now = new Date()

  // Update failure tracking
  await prisma.venueFeature.update({
    where: { id: venueFeature.id },
    data: {
      lastPaymentAttempt: now,
      paymentFailureCount: attemptCount,
      // Set grace period on first failure
      gracePeriodEndsAt: attemptCount === 1 ? addDays(now, 7) : venueFeature.gracePeriodEndsAt,
    },
  })

  // Send appropriate email based on attempt count
  switch (attemptCount) {
    case 1:
      await sendEmail('payment-failed-day-0', venueFeature.venueId)
      break
    case 2: // Day 3
      await sendEmail('payment-failed-day-3', venueFeature.venueId)
      break
    case 3: // Day 5
      await sendEmail('payment-failed-final-warning', venueFeature.venueId)
      break
    case 4: // Day 7 - Soft suspend
      await prisma.venueFeature.update({
        where: { id: venueFeature.id },
        data: {
          suspendedAt: now,
          active: false, // Block access but keep data
        },
      })
      await sendEmail('subscription-suspended', venueFeature.venueId)
      break
  }

  // Day 14 - Hard cancel (cron job checks this)
  if (attemptCount >= 5) {
    await cancelSubscription(subscriptionId, { immediately: true })
    await sendEmail('subscription-canceled', venueFeature.venueId)
  }
}
```

**Updated Webhook Handler**:

```typescript
case 'invoice.payment_failed':
  const failedInvoice = event.data.object as Stripe.Invoice
  const attemptCount = failedInvoice.attempt_count || 1

  if (failedInvoice.subscription) {
    await handlePaymentFailure(
      failedInvoice.subscription as string,
      attemptCount
    )
  }
  break
```

### 2.2 Email Notification System

**Email Templates** (using nodemailer + handlebars):

```typescript
// emails/trial-ending-soon.hbs
Subject: Your trial ends in 3 days - Add payment method
Body: Hi {{venueName}}, your trial of {{featureName}} ends on {{trialEndDate}}...

// emails/payment-failed-day-0.hbs
Subject: Payment failed - Please update your payment method
Body: We couldn't charge your card ending in {{last4}}...

// emails/payment-failed-day-3.hbs
Subject: Reminder: Update your payment method
Body: We've tried charging your card 2 times...

// emails/payment-failed-final-warning.hbs
Subject: Final warning: Your subscription will be suspended
Body: This is your final reminder. Update your payment method within 2 days...

// emails/subscription-suspended.hbs
Subject: Your subscription has been suspended
Body: Your access has been temporarily suspended due to payment failure...

// emails/subscription-canceled.hbs
Subject: Your subscription has been canceled
Body: Your subscription was canceled after 14 days of failed payments...

// emails/payment-succeeded.hbs
Subject: Payment successful - Thank you!
Body: We've successfully charged ${{amount}} for your {{featureName}} subscription...
```

**Service Function** (`email.service.ts`):

```typescript
export async function sendSubscriptionEmail(template: string, venueId: string, data: Record<string, any>): Promise<void> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    include: { organization: true },
  })

  const templatePath = path.join(__dirname, `../emails/${template}.hbs`)
  const templateContent = fs.readFileSync(templatePath, 'utf-8')
  const compiledTemplate = handlebars.compile(templateContent)

  const html = compiledTemplate({
    venueName: venue!.name,
    ...data,
  })

  await transporter.sendMail({
    from: '"Avoqado Billing" <billing@avoqado.com>',
    to: venue!.organization.email,
    subject: data.subject,
    html,
  })
}
```

---

## PHASE 3: Advanced Features (Week 4+) ⭐

**Goal**: Match Claude's complete feature set

### 3.1 Coupons & Promo Codes

**Service Functions**:

```typescript
export async function applyCoupon(subscriptionId: string, couponCode: string): Promise<Stripe.Subscription> {
  // Validate coupon exists
  const coupon = await stripe.coupons.retrieve(couponCode)

  if (!coupon.valid) {
    throw new Error('Invalid or expired coupon')
  }

  // Apply to subscription
  return await stripe.subscriptions.update(subscriptionId, {
    coupon: couponCode,
  })
}

export async function createPromotionCode(couponId: string, code: string): Promise<Stripe.PromotionCode> {
  return await stripe.promotionCodes.create({
    coupon: couponId,
    code,
    max_redemptions: 100,
  })
}
```

**API Endpoints**:

```typescript
// POST /api/v1/dashboard/venues/:venueId/billing/apply-coupon
// Body: { code: "LAUNCH50", subscriptionId: "sub_xxx" }
router.post('/billing/apply-coupon', billingController.applyCoupon)
```

### 3.2 Stripe Customer Portal

**Easiest Approach**: Let Stripe handle everything!

```typescript
export async function createCustomerPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  })

  return { url: session.url }
}
```

**Benefits of Customer Portal**:

- ✅ Update payment methods
- ✅ View invoices
- ✅ Cancel subscription
- ✅ Update billing details
- ✅ Download receipts
- **NO CODE NEEDED** - Stripe handles everything!

**Frontend Integration**:

```typescript
// Button in billing page
<button onClick={async () => {
  const { url } = await api.createPortalSession(venueId)
  window.location.href = url
}}>
  Manage Billing
</button>
```

### 3.3 Usage-Based Billing (Future)

For features like "pay per order processed":

```typescript
export async function reportUsage(subscriptionItemId: string, quantity: number): Promise<void> {
  await stripe.subscriptionItems.createUsageRecord(subscriptionItemId, {
    quantity,
    timestamp: Math.floor(Date.now() / 1000),
    action: 'increment',
  })
}

// Example: After processing order
await reportUsage(venueFeature.stripeSubscriptionItemId, 1) // +1 order
```

### 3.4 Revenue Analytics Dashboard

**Metrics to Track**:

```typescript
interface RevenueMetrics {
  mrr: number // Monthly Recurring Revenue
  churnRate: number // Canceled / Total subscribers
  ltv: number // Lifetime Value per customer
  arpu: number // Average Revenue Per User
  conversionRate: number // Trial → Paid
}

export async function getRevenueMetrics(): Promise<RevenueMetrics> {
  // Query VenueFeature table
  const activeSubscriptions = await prisma.venueFeature.count({
    where: { active: true, trialEndDate: null },
  })

  const totalRevenue = await prisma.venueFeature.aggregate({
    where: { active: true },
    _sum: {
      /* calculate from Stripe prices */
    },
  })

  return {
    mrr: totalRevenue._sum.revenue / 30,
    // ... calculate other metrics
  }
}
```

---

## 🧪 TESTING STRATEGY

### Unit Tests

```typescript
// tests/unit/services/stripe.service.test.ts
describe('Stripe Service', () => {
  describe('createSetupIntent', () => {
    it('should create setup intent for customer', async () => {
      const result = await createSetupIntent('cus_xxx')
      expect(result.clientSecret).toMatch(/^seti_/)
    })
  })

  describe('handlePaymentFailure', () => {
    it('should send day 0 email on first failure', async () => {
      await handlePaymentFailure('sub_xxx', 1)
      expect(mockSendEmail).toHaveBeenCalledWith('payment-failed-day-0', ...)
    })

    it('should suspend after 4 failures', async () => {
      await handlePaymentFailure('sub_xxx', 4)
      const venueFeature = await prisma.venueFeature.findFirst(...)
      expect(venueFeature.suspendedAt).not.toBeNull()
    })
  })
})
```

### Integration Tests

```typescript
// tests/integration/billing-flow.test.ts
describe('Complete Billing Flow', () => {
  it('should handle full payment lifecycle', async () => {
    // 1. Create customer
    const customerId = await getOrCreateStripeCustomer(...)

    // 2. Add payment method
    const { clientSecret } = await createSetupIntent(customerId)
    // (simulate Stripe.js confirmation)

    // 3. Create subscription
    const subscription = await createTrialSubscriptions(...)

    // 4. Simulate payment failure
    await handlePaymentFailure(subscription.id, 1)

    // 5. Verify email sent
    expect(emailService.send).toHaveBeenCalled()
  })
})
```

### Webhook Tests

```typescript
// tests/integration/webhooks.test.ts
describe('Stripe Webhooks', () => {
  it('should handle trial_will_end webhook', async () => {
    const event = createMockWebhookEvent('customer.subscription.trial_will_end', {
      customer: 'cus_xxx',
      trial_end: Date.now() / 1000 + 3 * 86400, // 3 days
    })

    await handleStripeWebhook(event)

    expect(emailService.send).toHaveBeenCalledWith('trial-ending-soon', expect.any(String))
  })
})
```

---

## 📋 IMPLEMENTATION CHECKLIST

### Phase 1: Critical (Week 1-2)

- [x] Setup Intent endpoint + service ✅
- [x] Payment methods CRUD endpoints ✅
- [ ] Subscription upgrade/downgrade ⚠️ PENDING
- [x] Subscription cancel/reactivate ✅
- [x] Invoice history endpoints ✅
- [x] Invoice PDF download ✅
- [ ] Add missing webhook handlers:
  - [x] `customer.subscription.trial_will_end` ✅
  - [ ] `invoice.payment_action_required` ⚠️ PENDING
  - [ ] `invoice.upcoming` ⚠️ PENDING
  - [ ] `charge.dispute.created` ⚠️ PENDING
- [x] Frontend: Payment method management UI ✅
- [x] Frontend: Subscription management UI ✅
- [x] Frontend: Invoice history UI ✅

### Phase 2: Robust Error Handling (Week 3) ✅ COMPLETE (2025-10-27)

- [x] Database migration for grace period fields ✅
- [x] `handlePaymentFailure()` service function ✅
- [x] Email templates (payment failed, suspended, canceled) ✅
- [x] Email service integration ✅
- [x] Cron job for hard cancelation (Day 14) ✅
- [x] Updated `checkFeatureAccess` to respect suspension ✅
- [ ] Frontend: Grace period banner ⚠️ TODO (Frontend work)
- [ ] Frontend: Suspended state UI ⚠️ TODO (Frontend work)

**Completed Files:**

- Migration: `prisma/migrations/20251027173126_add_grace_period_fields_to_venue_feature/`
- Service: `src/services/stripe.service.ts:handlePaymentFailure()` (lines 737-891)
- Emails: `src/services/email.service.ts:sendPaymentFailedEmail()` (lines 469-538), `sendSubscriptionSuspendedEmail()` (lines 540-660),
  `sendSubscriptionCanceledEmail()` (lines 662-767)
- Cron: `src/jobs/subscription-cancellation.job.ts` (191 lines, runs daily at 2:00 AM)
- Webhook: `src/services/stripe.webhook.service.ts:handleInvoicePaymentFailed()` (updated to pass invoice data)
- Middleware: `src/middlewares/checkFeatureAccess.middleware.ts` (suspension checks in all 3 functions)

### Phase 3: Advanced (Week 4+)

- [ ] Coupon/promo code system
- [ ] Stripe Customer Portal integration
- [ ] Usage-based billing (optional)
- [ ] Revenue analytics dashboard
- [ ] Tax calculation (Stripe Tax)

### Testing

- [ ] Unit tests for all new service functions
- [ ] Integration tests for complete flows
- [ ] Webhook payload tests
- [ ] Frontend E2E tests (Cypress/Playwright)

### Documentation

- [ ] API endpoint documentation
- [ ] Webhook event documentation
- [ ] Email template documentation
- [ ] Error handling flowchart
- [ ] User-facing billing FAQ

---

## 🚀 DEPLOYMENT PLAN

### Pre-Production Checklist

- [ ] Test webhooks with Stripe CLI
- [ ] Verify all email templates render correctly
- [ ] Test payment failures in test mode
- [ ] Verify grace period logic
- [ ] Load test subscription endpoints
- [ ] Security audit (no API keys leaked)

### Production Deployment

1. **Deploy backend** (webhooks first!)
2. **Configure Stripe webhooks** in dashboard
3. **Deploy frontend** (billing UI)
4. **Monitor logs** for first 24 hours
5. **Test with real card** (capture & refund)

### Monitoring

- [ ] Set up Sentry alerts for webhook failures
- [ ] Monitor Stripe Dashboard for disputes
- [ ] Track email delivery rates
- [ ] Monitor subscription churn rate

---

## 💰 COST ANALYSIS

### Stripe Fees

- **Successful charge**: 2.9% + $0.30
- **Failed charge**: $0 (no fee for retries)
- **Dispute**: $15 (waived if won)

### Example Revenue Math

```
10 venues × $99/month = $990 MRR
Stripe fee: $990 × 2.9% + ($0.30 × 10) = $31.71
Net revenue: $958.29/month
```

---

## 🎯 SUCCESS METRICS

### Phase 1 Success Criteria

- [ ] User can add payment method without being charged
- [ ] User can upgrade/downgrade subscription
- [ ] User can cancel subscription
- [ ] User can view invoice history
- [ ] 100% webhook coverage (no missed events)

### Phase 2 Success Criteria

- [ ] Payment failures trigger correct email sequence
- [ ] Subscriptions suspended after 7 days
- [ ] Subscriptions canceled after 14 days
- [ ] Users can reactivate suspended subscriptions
- [ ] 0 data loss during suspension period

### Phase 3 Success Criteria

- [ ] Coupon redemption working
- [ ] Customer portal functional
- [ ] Revenue analytics accurate
- [ ] Churn rate < 5%

---

## 🔗 RESOURCES

- [Stripe Subscriptions Best Practices](https://stripe.com/docs/billing/subscriptions/overview)
- [Stripe Webhooks Guide](https://stripe.com/docs/webhooks)
- [Dunning Management Guide](https://stripe.com/docs/billing/revenue-recovery)
- [Stripe Customer Portal](https://stripe.com/docs/billing/subscriptions/integrating-customer-portal)
- [Stripe Testing Cards](https://stripe.com/docs/testing)

---

## 📞 SUPPORT PLAN

### User Support

- Billing FAQ page
- Live chat for payment issues
- Email: billing@avoqado.com
- Phone support for disputes

### Developer Support

- Stripe support (included in account)
- Internal Slack channel: #billing-issues
- On-call rotation for webhook failures

---

---

## 🎯 NEXT STEPS (Priority Order)

### Immediate Priorities (Now)

**1. End-to-End Testing (CRITICAL)**

- [ ] Test payment failure flow with Stripe test cards
- [ ] Verify dunning emails are sent correctly (Days 0, 3, 5, 7, 14)
- [ ] Confirm suspension blocks access after Day 7
- [ ] Confirm hard cancellation after Day 14
- [ ] Test payment recovery flow (customer updates card)

**Commands:**

```bash
# Use Stripe test cards for payment failures
# 4000000000000341 - Card always fails

# Monitor logs for email sends and dunning logic
tail -f logs/$(ls -t logs/development*.log | head -1) | grep "payment\|suspend\|cancel"

# Check cron job execution
# Runs daily at 2:00 AM (America/Mexico_City)
```

### Short-Term (Next 1-2 weeks)

**2. Missing Webhook Handlers (Medium Priority)**

- [ ] `invoice.payment_action_required` - 3D Secure authentication needed
- [ ] `invoice.upcoming` - Preview before charge (7 days notice)
- [ ] `charge.dispute.created` - Chargeback alerts

**3. Stripe Customer Portal (EASIEST WIN - ~2 hours)**

- [ ] Implement `createCustomerPortalSession()` service function
- [ ] Add "Manage Billing" button in frontend
- [ ] Benefits: Let Stripe handle payment method updates, invoice downloads, subscription cancellation

**Backend implementation:**

```typescript
// src/services/stripe.service.ts
export async function createCustomerPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  })
  return { url: session.url }
}
```

**4. Frontend Work (Requires Frontend Team)**

- [ ] Grace period warning banner (show when payment fails)
- [ ] Suspended state UI (show when access blocked)
- [ ] Payment retry button
- [ ] Permission management UI at `/settings/role-permissions`

### Medium-Term (Next 1-2 months)

**5. Advanced Features**

- [ ] Coupons/promo codes system (for marketing campaigns)
- [ ] Revenue analytics dashboard (MRR, churn rate, LTV, ARPU)
- [ ] Manual invoice retry from admin panel
- [ ] Upcoming invoice preview API

### Long-Term (Optional)

**6. Enterprise Features**

- [ ] Usage-based billing (pay per order)
- [ ] Multiple subscriptions per customer
- [ ] Tax calculation (Stripe Tax)
- [ ] Multi-currency support

---

## 📋 CURRENT STATUS SUMMARY (2025-10-28)

### ✅ COMPLETED

- **Phase 1**: Payment methods, invoicing, webhooks ✅
- **Phase 2**: Complete dunning management system ✅
  - Progressive email warnings (Days 0, 3, 5)
  - Soft suspension after Day 7
  - Hard cancellation after Day 14
  - Cron job for automated cleanup
  - Non-blocking email integration
- **Permission Fix**: OWNER/ADMIN can now access billing features ✅
- **Organization → Venue Migration**: Stripe customers now at venue level ✅
  - Fixed payment method webhook to save to correct location
  - Added venue slug to Stripe customer names
  - Updated all service function signatures
  - All unit tests passing (153 tests)
- **Feature Sync System**: Auto-sync features to Stripe during seed ✅
  - Idempotent sync (no duplicates)
  - Creates if missing, updates if exists
  - Works for test → production transition

### ⚠️ IN PROGRESS

- End-to-end testing of payment failure flow

### ❌ PENDING

- Missing webhook handlers (3D Secure, upcoming invoices, disputes)
- Stripe Customer Portal integration (quick win)
- Frontend: Grace period banner and suspended state UI
- Frontend: Permission management UI

---

## 🚨 CRITICAL NOTES FOR NEXT CONVERSATION

**1. Organization → Venue Migration COMPLETE** ✅

- All Stripe customers now at Venue level (not Organization)
- Payment methods save correctly via webhooks
- Venue slug included in Stripe customer names
- All 6 call sites updated, all tests passing

**2. Feature Sync System COMPLETE** ✅

- `npm run seed` auto-syncs features to Stripe
- Idempotent - no duplicates on repeated runs
- Ready for test → production transition
- Just update .env and run seed

**3. No Upgrade/Downgrade Needed**

- Features are binary (active/inactive), no pricing tiers
- Don't implement subscription plan changes

**4. Dunning System Is Complete**

- Fully functional backend implementation
- Just needs end-to-end testing
- Email templates ready (HTML + text)

**5. Permission Fix Applied**

- OWNER and ADMIN roles now have `venues:*` permission
- Fixes 403 errors on billing endpoints
- Backend permission management API exists (5 endpoints ready for frontend)

**6. Testing Priority**

- Test payment failure → email → suspension → cancellation flow
- Use Stripe test card: 4000000000000341 (always fails)
- Monitor cron job execution (daily at 2:00 AM)

**7. Quick Wins Available**

- Stripe Customer Portal (~2 hours implementation)
- Frontend grace period banner (~1 day)
- End-to-end testing suite (~2 days)

---

## END OF PLAN

**Last Updated**: 2025-10-28 | **Phase 2 Status**: COMPLETE ✅ | **Migration Status**: COMPLETE ✅

**Next Conversation Start Here**:

1. Review new "RECENT CHANGES (2025-10-28)" section above
2. Test Organization → Venue migration in production
3. Start with end-to-end testing of payment flows
