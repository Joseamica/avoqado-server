# Organization-Level Payment Configuration

## Overview

Allows configuring payment merchant accounts and pricing structures at the **organization level**, inherited by all venues that don't have their own config. Eliminates the need to configure 32+ venues individually when they share the same merchant account, bank, rates, and settlement rules.

## Resolution Pattern

Same as the module system (`VenueModule` > `OrganizationModule`):

```
getEffectivePaymentConfig(venueId):
  1. VenuePaymentConfig exists? → return { config, source: 'venue' }
  2. OrganizationPaymentConfig exists? → return { config, source: 'organization' }
  3. → return null
```

**No materialization** — resolved at query time. No sync issues.

## What Can Be Org-Level

| Payment Readiness Step | Org-Level? | Why |
|------------------------|-----------|-----|
| KYC Approved | No | Per-venue legal entity |
| Terminal Registered | No | Physical device at location |
| Merchant Account Created | **Yes** | Shared merchant account |
| Terminal-Merchant Linked | No | Device-specific |
| Venue Payment Configured | **Yes** | Primary/secondary/tertiary accounts |
| Pricing Structure Set | **Yes** | Rates (debit%, credit%, amex%, intl%) |
| Provider Cost Structure | Already shared | Per-MerchantAccount |

## Schema Models

### OrganizationPaymentConfig

Mirrors `VenuePaymentConfig`. Links org to merchant accounts (primary/secondary/tertiary), routingRules, preferredProcessor. `organizationId` is `@unique` (1:1 with Organization).

### OrganizationPricingStructure

Mirrors `VenuePricingStructure`. Org-level rates per accountType with effectiveFrom/To dates.

## Key Files

| File | Purpose |
|------|---------|
| `src/services/organization-payment-config.service.ts` | Resolution service (getEffective*, getVenueConfigSources) |
| `src/controllers/dashboard/organization-payment.superadmin.controller.ts` | CRUD controller |
| `src/routes/superadmin/organization.routes.ts` | API routes (under `/:orgId/payment-config`) |

## API Endpoints

Base: `/api/v1/dashboard/superadmin/organizations/:orgId/payment-config`

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/` | Org config + pricing + venue inheritance |
| PUT | `/` | Set/update org payment config |
| DELETE | `/` | Remove org payment config |
| PUT | `/pricing` | Set/update org pricing structure |
| DELETE | `/pricing/:pricingId` | Deactivate pricing structure |
| GET | `/venues` | Venue inheritance status list |

## Readiness Service Integration

`venuePaymentReadiness.service.ts` now uses the resolution service for steps 5 and 6. When config comes from the org level, status is `'inherited'` and detail shows "Heredado de organizacion". The `canProcessPayments` check treats `'inherited'` as valid.

## Usage Example

```typescript
import { getEffectivePaymentConfig, getEffectivePricing } from '@/services/organization-payment-config.service'

// Get payment config for a venue (auto-resolves venue or org level)
const result = await getEffectivePaymentConfig(venueId)
// result.config = { primaryAccountId, ... }
// result.source = 'venue' | 'organization'

// Get pricing for a venue (auto-resolves)
const pricing = await getEffectivePricing(venueId, AccountType.PRIMARY)
// pricing.pricing = [{ debitRate, creditRate, ... }]
// pricing.source = 'venue' | 'organization'

// Get inheritance status for all venues in an org (admin UI)
const sources = await getVenueConfigSources(organizationId)
// [{ venueId, venueName, paymentConfig: { source: 'organization', hasVenueOverride: false }, ... }]
```
