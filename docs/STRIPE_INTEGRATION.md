# Stripe Integration & Feature Access Control

This document details the complete Stripe integration implementation for subscription-based feature access control.

## Architecture Overview

Subscription-based feature access with trial periods:

```
Venue Conversion → Create Stripe Customer → Attach Payment Method → Create Trial Subscriptions
                                                                              ↓
                                                                    VenueFeature records (active=true, endDate=5 days)
                                                                              ↓
Stripe Webhooks → customer.subscription.updated → Update VenueFeature (trial→paid or deactivate)
                                                                              ↓
Feature Access Middleware → checkFeatureAccess('ANALYTICS') → Validate active + trial not expired
```

## Design Decisions (WHY)

### Why 2-day trial period?

Balance between evaluation time and conversion pressure. Long enough for meaningful testing, short enough to drive purchase decisions.

### Why `endDate` field?

- `endDate=null` = paid forever (active subscription)
- `endDate!=null` = trial with expiration date
- Enables simple trial expiration checks without complex state management

### Why webhooks?

Auto-handle payment failures and trial expirations without manual checks. Stripe notifies us of all subscription lifecycle events:

- Trial ending → Convert to paid or deactivate
- Payment failed → Deactivate feature
- Subscription cancelled → Deactivate feature

### Why middleware instead of service checks?

Centralized enforcement at the route level. Can't be bypassed by forgetting to add checks in service layer.

## Recent Changes (2025-10-28)

### Critical Migration: Organization → Venue Level Stripe Customer

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

**Database Schema Changes**:

- ✅ `Venue.stripeCustomerId` (MIGRATED from Organization 2025-10-28)
- ✅ `Venue.stripePaymentMethodId` (stores default payment method)
- ✅ `Feature.stripeProductId` and `Feature.stripePriceId` (auto-synced)
- ❌ `Organization.stripeCustomerId` - REMOVED (migrated to Venue level)

### Automatic Feature Sync System

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

**Idempotency**: The sync checks `Feature.stripeProductId`:

- If NULL → Creates new Stripe product/price
- If exists → Updates existing Stripe product/price
- Never creates duplicates

## Feature Map (WHERE)

| Component                    | Location                                                     | Purpose                                                     |
| ---------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Stripe customer creation     | `src/services/stripe.service.ts:getOrCreateStripeCustomer()` | Creates/retrieves Stripe customer (VENUE-LEVEL)             |
| Feature sync to Stripe       | `src/services/stripe.service.ts:syncFeaturesToStripe()`      | Syncs Feature records to Stripe products/prices             |
| Trial subscriptions          | `src/services/stripe.service.ts:createTrialSubscriptions()`  | Creates 5-day trials for selected features                  |
| Venue conversion integration | `src/services/dashboard/venue.dashboard.service.ts:688-817`  | Integrates Stripe into demo→prod flow                       |
| Feature management endpoints | `src/routes/dashboard.routes.ts:1163-1249`                   | GET/POST/DELETE /venues/:id/features                        |
| Webhook handlers             | `src/services/stripe.webhook.service.ts`                     | subscription.updated, invoice.paid, payment_method.attached |
| Webhook endpoint             | `src/routes/webhook.routes.ts` + `src/app.ts:23-29`          | POST /webhooks/stripe (raw body)                            |
| Feature access middleware    | `src/middlewares/checkFeatureAccess.middleware.ts`           | Validates subscription before access                        |
| Seed script                  | `prisma/seed.ts:435-440`                                     | Creates features with note about sync                       |
| Sync script                  | `scripts/sync-features-to-stripe.ts`                         | Manual sync script (also called by npm run seed)            |

## Customer Name Format

Stripe customer names now include venue slug for easy identification:

```typescript
// Format: "{ownerName} ({venueSlug})"
// Examples:
// - "Main Owner (avoqado-full)"
// - "Main Owner (avoqado-empty)"
// - "John Doe (pizza-palace)"
```

**Why**: Multiple venues owned by same user (owner@owner.com) need to be distinguishable in Stripe dashboard.

**Implementation**: `src/services/stripe.service.ts:54`

```typescript
const customerName = venueSlug ? `${name} (${venueSlug})` : name
```

## Critical Gotchas

⚠️ **Webhook body parsing:** Webhooks MUST be mounted BEFORE `express.json()` middleware (requires raw buffer for signature verification)

⚠️ **Trial expiration:** Check `endDate < now` even if `active=true` - webhook may not have fired yet

⚠️ **Non-blocking payments:** Inventory deduction failures DON'T block payment success (logged only)

⚠️ **Feature codes:** Must match `Feature.code` in database (query: `SELECT code FROM Feature`)

⚠️ **Subscription cancellation:** Use Stripe API (don't just update DB) - webhook will sync state back

⚠️ **Venue-level customers:** ALL Stripe operations use `venueId`, NOT `organizationId`. Organization has NO Stripe fields.

⚠️ **Seed script feature deletion:** Features are NOT deleted during seed (line 352 commented out) to preserve Stripe IDs

## Usage Example

Protect premium endpoint with feature access:

```typescript
// Protect premium endpoint with feature access
router.get(
  '/venues/:venueId/analytics',
  authenticateTokenMiddleware, // 1. Validate JWT
  checkPermission('analytics:read'), // 2. Validate permission
  checkFeatureAccess('ANALYTICS'), // 3. Validate subscription
  analyticsController.getData,
)
```

## Stripe Feature Sync

**Command:**

```bash
npm run seed  # Runs both: npx prisma db seed + sync script
```

**Auto-sync locations:**

- Onboarding: `src/services/dashboard/venueCreation.service.ts:313`
- Demo conversion: `src/services/dashboard/venue.dashboard.service.ts:817`

**Why two-step?** Path alias issues prevent direct import in seed script. Pragmatic solution: seed creates DB records, sync script handles
Stripe API.

**Seed Script Note** (`prisma/seed.ts:435-440`):

```typescript
// Note: Seed creates features in DB, but Stripe sync happens separately
// Stripe products/prices are created automatically during:
// 1. Onboarding (venueCreation.service.ts calls syncFeaturesToStripe)
// 2. Demo conversion (venue.dashboard.service.ts calls syncFeaturesToStripe)
// To manually sync: npx ts-node -r tsconfig-paths/register scripts/sync-features-to-stripe.ts
console.log('  💡 To sync features to Stripe, run: npx ts-node -r tsconfig-paths/register scripts/sync-features-to-stripe.ts')
```

## Environment Variables

Required environment variables in `.env`:

```bash
# Stripe API keys
STRIPE_SECRET_KEY=sk_test_...         # or sk_live_... for production
STRIPE_WEBHOOK_SECRET=whsec_...       # from Stripe CLI or Dashboard

# Get webhook secret:
# 1. Stripe CLI: stripe listen --print-secret
# 2. Dashboard: Developers → Webhooks → Add endpoint → Signing secret
```

## Testing Locally

### Webhook Testing with Stripe CLI

```bash
# 1. Install Stripe CLI (if not installed)
brew install stripe/stripe-cli/stripe

# 2. Login to Stripe
stripe login

# 3. Forward webhooks to local server
stripe listen --forward-to localhost:12344/api/v1/webhooks/stripe

# 4. Trigger test webhooks (in another terminal)
stripe trigger customer.subscription.updated
stripe trigger invoice.payment_succeeded
stripe trigger payment_method.attached

# 5. Check logs for webhook processing
tail -f logs/development*.log | grep "🔔\|✅\|❌"
```

### Feature Sync Testing

```bash
# 1. Run seed (creates features + syncs to Stripe)
npm run seed

# 2. Verify in Stripe Dashboard
# Go to: Products → Should see all features as products

# 3. Verify in database
npm run studio
# Check Feature table: stripeProductId and stripePriceId should be populated

# 4. Test idempotency (run again)
npm run seed
# Should show "Updated" not "Created" for existing products
```

## Common Issues & Debugging

### Payment Method Not Saving

**Symptom**: Setup intent succeeds, payment method exists in Stripe, but `venue.stripePaymentMethodId` is null

**Cause**: Webhook not firing or not configured

**Solution**:

1. Check Stripe CLI is running: `stripe listen --forward-to localhost:12344/api/v1/webhooks/stripe`
2. Check webhook secret in `.env` matches CLI output
3. Check logs for webhook processing: `grep "payment_method.attached" logs/development*.log`

### Duplicate Stripe Products on Seed

**Symptom**: Running `npm run seed` creates duplicate products in Stripe

**Cause**: Features deleted during seed, losing Stripe IDs

**Solution**: Already fixed - feature deletion commented out at `prisma/seed.ts:352`

### "Venue not found" Error

**Symptom**: Error during Stripe customer creation: `Venue {id} not found`

**Cause**: Passing wrong parameter to `getOrCreateStripeCustomer()`

**Solution**: Always pass `venueId`, NOT `orgId` or `organization.id`

```typescript
// ✅ CORRECT
const customerId = await getOrCreateStripeCustomer(venueId, email, name, venueName, venueSlug)

// ❌ WRONG
const customerId = await getOrCreateStripeCustomer(
  organization.id, // ❌ Don't pass orgId
  email,
  name,
  venueName,
  venueSlug,
)
```

## Migration from Test to Production

When switching from test mode to production:

1. **Update environment variables**:

   ```bash
   STRIPE_SECRET_KEY=sk_live_...  # Change from sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...  # Get new secret from Dashboard
   ```

2. **Configure production webhook**:

   - Go to Stripe Dashboard → Developers → Webhooks
   - Add endpoint: `https://yourdomain.com/api/v1/webhooks/stripe`
   - Select events: `customer.subscription.updated`, `invoice.payment_succeeded`, `payment_method.attached`, `customer.deleted`
   - Copy webhook signing secret to `.env`

3. **Run feature sync** (creates products in production Stripe):

   ```bash
   npm run seed  # On production server
   ```

4. **Verify products created**:
   - Check Stripe Dashboard → Products
   - Check database: `SELECT id, code, stripeProductId, stripePriceId FROM "Feature"`

## Related Documentation

- **STRIPE_COMPLETE_IMPLEMENTATION_PLAN.md** - Complete implementation status and checklist
- **Root CLAUDE.md** - Architecture overview
- **DATABASE_SCHEMA.md** - Complete schema documentation (if exists)
