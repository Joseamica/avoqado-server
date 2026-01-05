# Customer, Loyalty & Promotions - Complete Reference

**Last Updated:** 2025-12-10 **Status:** Production Ready (Phase 1 Complete, Phase 2 In Progress)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Industry Benchmark Analysis](#2-industry-benchmark-analysis)
3. [Avoqado Implementation](#3-avoqado-implementation)
4. [Data Models](#4-data-models)
5. [API Reference](#5-api-reference)
6. [TPV Integration Guide](#6-tpv-integration-guide)
7. [Business Logic](#7-business-logic)
8. [Improvement Recommendations](#8-improvement-recommendations)

---

## 1. Executive Summary

### What We're Building

A comprehensive customer relationship, loyalty, and promotions system for Avoqado POS that matches industry leaders like Toast, Square,
Clover, and Stripe.

### Key Features

| Feature                 | Status      | Description                               |
| ----------------------- | ----------- | ----------------------------------------- |
| **Customer Management** | ✅ Complete | Full CRM with customer profiles, tracking |
| **Customer Groups**     | ✅ Complete | Segmentation for targeted promotions      |
| **Loyalty Program**     | ✅ Complete | Points-based rewards system               |
| **Discounts**           | 🔄 55%      | Automatic, manual, BOGO discounts         |
| **Coupon Codes**        | 🔄 55%      | Promotional codes with validation         |
| **Comps/Cortesías**     | ✅ Complete | Manager-approved complimentary items      |

---

## 2. Industry Benchmark Analysis

### 2.1 Customer Management Comparison

#### Square Customers API

**Source:** [Square Customers API](https://developer.squareup.com/docs/customers-api/what-it-does)

| Feature              | Square        | Avoqado       | Notes                       |
| -------------------- | ------------- | ------------- | --------------------------- |
| Customer Profile     | ✅            | ✅            | Name, email, phone, address |
| Instant Profiles     | ✅            | ❌            | Auto-create from payment    |
| Customer Groups      | ✅ (explicit) | ✅            | Manual group assignment     |
| Customer Segments    | ✅ (dynamic)  | ❌            | Rule-based auto-assignment  |
| Custom Attributes    | ✅            | ✅ (via tags) | Extensible metadata         |
| Version Control      | ✅            | ❌            | Optimistic concurrency      |
| Duplicate Prevention | Manual        | Manual        | No auto-dedup               |
| Cards on File        | ✅            | ❌            | Saved payment methods       |

**Key Square Pattern:**

```
CustomerGroup = Explicit membership (manual assignment)
CustomerSegment = Dynamic membership (filter criteria auto-applied)
```

**Recommendation:** Consider adding CustomerSegments with auto-assign rules for dynamic grouping (e.g., "Customers who spent >$500/month").

#### Toast Customers

**Source:** Toast Developer Guide

| Feature             | Toast          | Avoqado     | Notes                           |
| ------------------- | -------------- | ----------- | ------------------------------- |
| Customer Profile    | ✅             | ✅          | Basic CRM                       |
| Loyalty Integration | ✅ (3rd party) | ✅ (native) | Toast uses partner integrations |
| Marketing Consent   | ✅             | ✅          | GDPR/CCPA compliant             |

**Toast Pattern:** Toast relies on loyalty partner integrations rather than native loyalty. Avoqado has advantage of native implementation.

#### Stripe Customers

**Source:** [Stripe Billing Customers](https://docs.stripe.com/billing/customer)

| Feature          | Stripe | Avoqado   | Notes                 |
| ---------------- | ------ | --------- | --------------------- |
| Customer Profile | ✅     | ✅        | Core entity           |
| Tax IDs          | ✅     | ❌        | VAT, RFC storage      |
| Billing Address  | ✅     | ✅        | Via order             |
| Invoice Settings | ✅     | ❌        | Per-customer defaults |
| Metadata         | ✅     | ✅ (tags) | Key-value storage     |
| Multi-currency   | ✅     | ✅        | Per-venue currency    |

### 2.2 Loyalty Program Comparison

#### Square Loyalty API

**Source:** [Square Loyalty API](https://developer.squareup.com/docs/loyalty-api/overview)

| Feature                   | Square       | Avoqado | Notes                                           |
| ------------------------- | ------------ | ------- | ----------------------------------------------- |
| Points Accrual Types      | 4            | 2       | SPEND, VISIT (CATEGORY, ITEM_VARIATION pending) |
| Reward Tiers              | ✅           | ❌      | Multiple reward levels                          |
| Promotions (bonus points) | ✅           | ❌      | 2x, 3x point events                             |
| Tax Handling              | Pre/Post tax | Pre-tax | Configurable                                    |
| Tip Exclusion             | ✅           | ✅      | Points before tip                               |
| Multi-reward per order    | ✅           | ❌      | One reward per tier                             |
| Point Expiration          | ✅           | ✅      | Configurable days                               |
| Transaction History       | ✅           | ✅      | EARN, REDEEM, EXPIRE, ADJUST                    |

**Square Accrual Rule Types:**

```
SPEND       → 1 point per $1 spent
VISIT       → X points per visit (min purchase threshold)
CATEGORY    → Extra points for specific categories
ITEM_VARIATION → Extra points for specific items
```

**Avoqado Current:**

```
SPEND       → pointsPerDollar (configurable)
VISIT       → pointsPerVisit (bonus per order)
```

**Recommendation:** Add CATEGORY and ITEM_VARIATION accrual rules for targeted promotions.

#### Toast Loyalty Integration

**Source:** [Toast Loyalty API](https://doc.toasttab.com/doc/devguide/apiLoyaltyProgramIntegrationOverview.html)

Toast uses a **provider integration model** where external loyalty providers implement Toast's API:

| Transaction Type  | Description             | Avoqado Equivalent           |
| ----------------- | ----------------------- | ---------------------------- |
| `LOYALTY_SEARCH`  | Find customer accounts  | `searchCustomers()`          |
| `LOYALTY_INQUIRE` | Get available rewards   | `getCustomerPointsBalance()` |
| `LOYALTY_REDEEM`  | Apply reward at payment | `redeemPoints()`             |
| `LOYALTY_ACCRUE`  | Add points post-payment | `earnPoints()`               |
| `LOYALTY_REVERSE` | Undo transaction        | `adjustPoints()`             |

**Toast Pattern:** Idempotent operations via `Toast-Transaction-GUID` header.

**Recommendation:** Consider adding idempotency keys to loyalty operations.

### 2.3 Discount & Promotions Comparison

#### Toast Discounts

**Source:** [Toast Orders API - Discounts](https://doc.toasttab.com/doc/devguide/apiDiscountingOrders.html)

| Discount Type    | Toast | Avoqado | Notes                 |
| ---------------- | ----- | ------- | --------------------- |
| Fixed Percentage | ✅    | ✅      | X% off                |
| Fixed Amount     | ✅    | ✅      | $X off                |
| Open Percentage  | ✅    | ❌      | Manual % entry at POS |
| Open Amount      | ✅    | ✅      | Manual $ entry        |
| BOGO             | ✅    | ✅      | Buy X Get Y           |
| Combo            | ✅    | ❌      | Bundle pricing        |
| Comp (100% off)  | ✅    | ✅      | Complimentary items   |

**Toast Discount Scope:**

```
CHECK level   → Applies to entire order
ITEM level    → Applies to specific items
```

**Toast BOGO Pattern:**

```json
{
  "discount": { "guid": "bogo-discount" },
  "triggers": ["buy-item-guid"], // Items that triggered BOGO
  "comboItems": ["get-item-guid"] // Items receiving discount
}
```

**Toast Key Rule:** "Only one discount can apply to each line item"

#### Square Catalog Discounts

**Source:** [Square CatalogDiscount](https://developer.squareup.com/reference/square/objects/CatalogDiscount)

| Feature             | Square | Avoqado | Notes                |
| ------------------- | ------ | ------- | -------------------- |
| FIXED_PERCENTAGE    | ✅     | ✅      | Percentage off       |
| FIXED_AMOUNT        | ✅     | ✅      | Amount off           |
| VARIABLE_PERCENTAGE | ✅     | ❌      | Entry at sale        |
| VARIABLE_AMOUNT     | ✅     | ✅      | Entry at sale        |
| Max Discount Cap    | ✅     | ✅      | Limit savings        |
| PIN Required        | ✅     | 🔄      | Via requiresApproval |
| Tax Basis Modify    | ✅     | ✅      | Before/after tax     |
| Label Color         | ✅     | ❌      | UI customization     |

**Square Pricing Rules (Automatic Discounts):**

```
Pricing Rule + Product Set + Time Period = Automatic Discount
```

**Square Supports:**

- Volume discounts (BOGO)
- Minimum order discounts
- Time-based discounts (Happy Hour)
- Category bundle discounts

**Avoqado Already Has:**

- Time-based (`validFrom`, `validUntil`, `daysOfWeek`, `timeFrom`, `timeUntil`)
- Minimum purchase (`minPurchaseAmount`)
- BOGO (`buyQuantity`, `getQuantity`, `buyItemIds`, `getItemIds`)
- Category targeting (`targetCategoryIds`)

#### Clover Discounts

**Source:** [Clover Inventory API](https://docs.clover.com/dev/reference/inventorycreatediscount)

| Feature             | Clover | Avoqado | Notes              |
| ------------------- | ------ | ------- | ------------------ |
| Percentage Discount | ✅     | ✅      | `percentage` field |
| Amount Discount     | ✅     | ✅      | Negative `amount`  |
| Custom Discount     | ✅     | ✅      | Via manual entry   |
| Line Item Discount  | ✅     | ✅      | Item scope         |
| Order Discount      | ✅     | ✅      | Order scope        |

**Clover Pattern:** Discount amounts are stored as **negative values** to indicate subtraction.

#### Stripe Coupons & Promotion Codes

**Source:** [Stripe Coupons](https://docs.stripe.com/billing/subscriptions/coupons)

| Feature              | Stripe | Avoqado | Notes                        |
| -------------------- | ------ | ------- | ---------------------------- |
| Percent Off          | ✅     | ✅      | Percentage discount          |
| Amount Off           | ✅     | ✅      | Fixed amount                 |
| Duration             | ✅     | ✅      | once, forever, repeating     |
| Max Redemptions      | ✅     | ✅      | Global limit                 |
| Redeem By Date       | ✅     | ✅      | Expiration                   |
| Customer Restriction | ✅     | ✅      | Per-customer limit           |
| First Purchase Only  | ✅     | ❌      | First-time restriction       |
| Minimum Amount       | ✅     | ✅      | Min purchase requirement     |
| Product Restriction  | ✅     | ✅      | Applies to specific products |

**Stripe Coupon → Promotion Code Pattern:**

```
Coupon (internal) ─── 1:N ──► Promotion Codes (customer-facing)

Example:
"25OFF" coupon → "SPRING25", "FALL25", "VIP25" promotion codes
```

**Avoqado Equivalent:**

```
Discount (internal) ─── 1:N ──► CouponCodes (customer-facing)
```

### 2.4 Comp/Void Comparison

#### Industry Standard (Toast, Square)

**Source:** [Restaurant Comps](https://pos.toasttab.com/blog/on-the-line/comped-meal)

| Concept  | Definition                        | Avoqado Implementation         |
| -------- | --------------------------------- | ------------------------------ |
| **Comp** | Item made & delivered, given free | `DiscountType.COMP` (100% off) |
| **Void** | Item cancelled before made        | Order item deletion with audit |

**Comp Flow (Standard):**

```
1. Staff selects item(s) to comp
2. Staff enters reason (required)
3. If requiresApproval=true: Manager authorization
4. Discount applied with full audit trail
5. Item shows $0 on check but remains visible
```

**Avoqado Comp Implementation:**

```typescript
Discount {
  type: "COMP"
  value: 100               // Always 100%
  scope: "ITEM"            // Usually item-level
  requiresApproval: true   // Manager auth
  compReason: string       // Audit trail
}

OrderDiscount {
  isComp: true
  compReason: "Customer complaint - cold food"
  appliedById: "staff_123"
  authorizedById: "manager_456"  // If approval required
}
```

---

## 3. Avoqado Implementation

### 3.1 Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        AVOQADO POS                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  CUSTOMERS  │  │   LOYALTY   │  │  DISCOUNTS  │             │
│  ├─────────────┤  ├─────────────┤  ├─────────────┤             │
│  │ • Profiles  │  │ • Points    │  │ • Automatic │             │
│  │ • Groups    │  │ • Earn      │  │ • Manual    │             │
│  │ • Search    │  │ • Redeem    │  │ • BOGO      │             │
│  │ • Tracking  │  │ • History   │  │ • Coupons   │             │
│  └─────────────┘  └─────────────┘  │ • Comps     │             │
│         │                │         └─────────────┘             │
│         │                │                │                     │
│         └────────────────┴────────────────┘                     │
│                          │                                      │
│                          ▼                                      │
│                   ┌─────────────┐                               │
│                   │   ORDERS    │                               │
│                   ├─────────────┤                               │
│                   │ • customerId│                               │
│                   │ • discounts │                               │
│                   │ • loyalty   │                               │
│                   │   points    │                               │
│                   └─────────────┘                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Entity Relationships

```
Venue
├── customers: Customer[]
├── customerGroups: CustomerGroup[]
├── loyaltyConfig: LoyaltyConfig (1:1)
├── discounts: Discount[]
└── orders: Order[]
    └── orderDiscounts: OrderDiscount[]

Customer
├── customerGroup?: CustomerGroup
├── orders: Order[]
├── loyaltyTransactions: LoyaltyTransaction[]
├── customerDiscounts: CustomerDiscount[]
└── couponRedemptions: CouponRedemption[]

Discount
├── couponCodes: CouponCode[]
├── customerGroup?: CustomerGroup (scope target)
├── customerDiscounts: CustomerDiscount[]
└── orderDiscounts: OrderDiscount[]

Order
├── customer?: Customer
└── orderDiscounts: OrderDiscount[]
    ├── discount?: Discount
    └── couponCode?: CouponCode
```

### 3.3 Implementation Status

| Component           | Files                                   | Status | Tests |
| ------------------- | --------------------------------------- | ------ | ----- |
| **Customer System** |                                         |        |       |
| Schema              | `prisma/schema.prisma`                  | ✅     | -     |
| Dashboard Service   | `customer.dashboard.service.ts`         | ✅     | 124   |
| TPV Service         | `customer.tpv.service.ts`               | ✅     | 30    |
| Controller          | `customer.dashboard.controller.ts`      | ✅     | -     |
| **Customer Groups** |                                         |        |       |
| Dashboard Service   | `customerGroup.dashboard.service.ts`    | ✅     | ✅    |
| Controller          | `customerGroup.dashboard.controller.ts` | ✅     | -     |
| **Loyalty**         |                                         |        |       |
| Config              | `LoyaltyConfig` model                   | ✅     | -     |
| Dashboard Service   | `loyalty.dashboard.service.ts`          | ✅     | ✅    |
| Controller          | `loyalty.dashboard.controller.ts`       | ✅     | -     |
| Payment Integration | `payment.tpv.service.ts`                | ✅     | -     |
| **Discounts**       |                                         |        |       |
| Dashboard Service   | `discount.dashboard.service.ts`         | ✅     | 🔄    |
| TPV Service         | `discount.tpv.service.ts`               | ✅     | 🔄    |
| Discount Engine     | `discountEngine.service.ts`             | ✅     | 🔄    |
| Controller          | `discount.dashboard.controller.ts`      | ✅     | -     |
| **Coupons**         |                                         |        |       |
| Dashboard Service   | `coupon.dashboard.service.ts`           | ✅     | 🔄    |
| Controller          | `coupon.dashboard.controller.ts`        | ✅     | -     |

---

## 4. Data Models

### 4.1 Customer Model

```prisma
model Customer {
  id              String    @id @default(cuid())
  venueId         String

  // Profile
  email           String?   // Unique per venue
  phone           String?   // Unique per venue
  firstName       String?
  lastName        String?
  birthDate       DateTime?
  gender          String?

  // Loyalty Tracking
  loyaltyPoints   Int       @default(0)
  totalVisits     Int       @default(0)
  lastVisitAt     DateTime?
  firstVisitAt    DateTime?
  totalSpent      Decimal   @default(0) @db.Decimal(12, 2)
  averageOrderValue Decimal @default(0) @db.Decimal(10, 2)

  // Segmentation
  customerGroupId String?
  tags            String[]  // ["VIP", "Birthday-Dec", "Allergen-Nuts"]

  // Preferences
  marketingConsent Boolean  @default(false)
  language         String   @default("es")

  // Status
  active          Boolean   @default(true)

  @@unique([venueId, email])
  @@unique([venueId, phone])
}
```

### 4.2 LoyaltyConfig Model

```prisma
model LoyaltyConfig {
  venueId         String   @id @unique

  // Earning
  pointsPerDollar Decimal  @default(1) @db.Decimal(5, 2)
  pointsPerVisit  Int      @default(0)

  // Redemption
  redemptionRate  Decimal  @default(0.01) @db.Decimal(5, 4) // 100pts = $1
  minPointsRedeem Int      @default(100)

  // Expiration
  pointsExpireDays Int?    // null = never expire

  active          Boolean  @default(true)
}
```

**Calculation Examples:**

```
Purchase $50 → 50 points (if pointsPerDollar = 1)
100 points → $1 discount (if redemptionRate = 0.01)
```

### 4.3 Discount Model

```prisma
model Discount {
  id              String   @id @default(cuid())
  venueId         String

  // Basic Info
  name            String
  description     String?
  type            DiscountType  // PERCENTAGE, FIXED_AMOUNT, COMP
  value           Decimal       // 0-100 for %, amount for fixed

  // Scope & Targeting
  scope           DiscountScope
  targetItemIds       String[]
  targetCategoryIds   String[]
  targetModifierIds   String[]
  targetModifierGroupIds String[]
  customerGroupId     String?

  // Automatic Application
  isAutomatic     Boolean  @default(false)
  priority        Int      @default(0)

  // Rules
  minPurchaseAmount Decimal?
  maxDiscountAmount Decimal?
  minQuantity       Int?

  // BOGO
  buyQuantity       Int?
  getQuantity       Int?
  getDiscountPercent Decimal?  // 100 = free
  buyItemIds        String[]
  getItemIds        String[]

  // Time-based
  validFrom       DateTime?
  validUntil      DateTime?
  daysOfWeek      Int[]     // 0-6, empty = all days
  timeFrom        String?   // "HH:MM"
  timeUntil       String?   // "HH:MM"

  // Usage Limits
  maxTotalUses        Int?
  maxUsesPerCustomer  Int?
  currentUses         Int   @default(0)

  // Comp-specific
  requiresApproval Boolean  @default(false)
  compReason       String?

  // Tax Handling
  applyBeforeTax  Boolean  @default(true)
  modifyTaxBasis  Boolean  @default(true)

  // Stacking
  isStackable     Boolean  @default(false)
  stackPriority   Int      @default(0)

  active          Boolean  @default(true)
}

enum DiscountType {
  PERCENTAGE
  FIXED_AMOUNT
  COMP
}

enum DiscountScope {
  ORDER          // Applies to entire order
  ITEM           // Specific items
  CATEGORY       // Category-wide
  MODIFIER       // Specific modifiers
  MODIFIER_GROUP // Modifier groups
  CUSTOMER_GROUP // Auto-apply to group members
  QUANTITY       // BOGO/volume discounts
}
```

### 4.4 CouponCode Model

```prisma
model CouponCode {
  id              String   @id @default(cuid())
  discountId      String
  code            String   @unique  // "SAVE20", "PROMO-ABC123"

  // Override Discount Limits
  maxUses             Int?
  maxUsesPerCustomer  Int?
  currentUses         Int   @default(0)

  // Override Discount Validity
  minPurchaseAmount Decimal?
  validFrom         DateTime?
  validUntil        DateTime?

  active          Boolean  @default(true)
}
```

---

## 5. API Reference

### 5.1 Dashboard APIs

#### Customer Endpoints

```
GET    /api/v1/dashboard/venues/{venueId}/customers
       Query: page, pageSize, search, customerGroupId, tags

GET    /api/v1/dashboard/venues/{venueId}/customers/stats
       Response: { totalCustomers, activeCustomers, newThisMonth, vipCustomers, ... }

GET    /api/v1/dashboard/venues/{venueId}/customers/{customerId}
       Response: Customer + orders + loyalty transactions

POST   /api/v1/dashboard/venues/{venueId}/customers
       Body: { email?, phone, firstName?, lastName?, ... }

PUT    /api/v1/dashboard/venues/{venueId}/customers/{customerId}
DELETE /api/v1/dashboard/venues/{venueId}/customers/{customerId}
```

#### Customer Group Endpoints

```
GET    /api/v1/dashboard/venues/{venueId}/customer-groups
POST   /api/v1/dashboard/venues/{venueId}/customer-groups
GET    /api/v1/dashboard/venues/{venueId}/customer-groups/{groupId}
PUT    /api/v1/dashboard/venues/{venueId}/customer-groups/{groupId}
DELETE /api/v1/dashboard/venues/{venueId}/customer-groups/{groupId}

POST   /api/v1/dashboard/venues/{venueId}/customer-groups/{groupId}/assign
       Body: { customerIds: string[] }

POST   /api/v1/dashboard/venues/{venueId}/customer-groups/{groupId}/remove
       Body: { customerIds: string[] }
```

#### Loyalty Endpoints

```
GET    /api/v1/dashboard/venues/{venueId}/loyalty/config
PUT    /api/v1/dashboard/venues/{venueId}/loyalty/config

POST   /api/v1/dashboard/venues/{venueId}/loyalty/calculate-points
       Body: { amount: number }

GET    /api/v1/dashboard/venues/{venueId}/customers/{customerId}/loyalty/balance
GET    /api/v1/dashboard/venues/{venueId}/customers/{customerId}/loyalty/transactions

POST   /api/v1/dashboard/venues/{venueId}/customers/{customerId}/loyalty/adjust
       Body: { points: number, reason: string }
```

#### Discount Endpoints

```
GET    /api/v1/dashboard/venues/{venueId}/discounts
       Query: page, pageSize, search, type, scope, isAutomatic, active

POST   /api/v1/dashboard/venues/{venueId}/discounts
GET    /api/v1/dashboard/venues/{venueId}/discounts/{discountId}
PUT    /api/v1/dashboard/venues/{venueId}/discounts/{discountId}
DELETE /api/v1/dashboard/venues/{venueId}/discounts/{discountId}
POST   /api/v1/dashboard/venues/{venueId}/discounts/{discountId}/clone
```

#### Coupon Endpoints

```
GET    /api/v1/dashboard/venues/{venueId}/coupons
POST   /api/v1/dashboard/venues/{venueId}/coupons
POST   /api/v1/dashboard/venues/{venueId}/coupons/bulk-generate
       Body: { discountId, prefix?, quantity, codeLength? }

POST   /api/v1/dashboard/venues/{venueId}/coupons/validate
       Body: { code, orderTotal?, customerId? }

GET    /api/v1/dashboard/venues/{venueId}/coupons/redemptions
```

### 5.2 TPV APIs

#### Customer Lookup

```
GET    /api/v1/tpv/venues/{venueId}/customers/search?phone={phone}
GET    /api/v1/tpv/venues/{venueId}/customers/search?email={email}
GET    /api/v1/tpv/venues/{venueId}/customers/search?q={query}
GET    /api/v1/tpv/venues/{venueId}/customers/recent

POST   /api/v1/tpv/venues/{venueId}/customers
       Body: { firstName?, lastName?, phone?, email? }
       Response: CustomerSearchResult
```

#### Discount Operations

```
GET    /api/v1/tpv/venues/{venueId}/orders/{orderId}/discounts/available
       Response: AvailableDiscount[]

POST   /api/v1/tpv/venues/{venueId}/orders/{orderId}/discounts/automatic
       Response: { applied: number, totalSavings: number, discounts: OrderDiscountSummary[] }

POST   /api/v1/tpv/venues/{venueId}/orders/{orderId}/discounts/predefined
       Body: { discountId, authorizedById? }

POST   /api/v1/tpv/venues/{venueId}/orders/{orderId}/discounts/manual
       Body: { type, value, reason, authorizedById? }

POST   /api/v1/tpv/venues/{venueId}/orders/{orderId}/discounts/coupon
       Body: { code }

DELETE /api/v1/tpv/venues/{venueId}/orders/{orderId}/discounts/{orderDiscountId}

POST   /api/v1/tpv/venues/{venueId}/coupons/validate
       Body: { code, orderTotal, customerId? }
```

---

## 6. TPV Integration Guide

### 6.1 Customer Lookup Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ TPV: Customer Lookup                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Staff taps "Add Customer" on GuestTab                       │
│     │                                                           │
│     ▼                                                           │
│  2. Search modal opens                                          │
│     ┌─────────────────────────────────┐                        │
│     │ 🔍 [Phone/Email/Name          ]│                        │
│     │                                 │                        │
│     │ Recent Customers:               │                        │
│     │ • María García (55-1234-5678)   │                        │
│     │ • Juan López (55-8765-4321)     │                        │
│     │                                 │                        │
│     │ [+ Create New Customer]         │                        │
│     └─────────────────────────────────┘                        │
│     │                                                           │
│     ▼                                                           │
│  3. API: GET /tpv/venues/:id/customers/search?q={input}        │
│     │                                                           │
│     ▼                                                           │
│  4. Display results with loyalty points badge                   │
│     │                                                           │
│     ▼                                                           │
│  5. Staff selects customer → Order.customerId set               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Apply Discount Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ TPV: Apply Discount Flow                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ActionsTab                                                     │
│  ┌─────────────────────────────────────────────┐               │
│  │ 📋 Available Discounts                      │               │
│  │ ┌─────────────────────────────────────────┐ │               │
│  │ │ 🏷️ 10% Off (Happy Hour) - AUTO          │ │               │
│  │ │    Save $5.00                           │ │               │
│  │ └─────────────────────────────────────────┘ │               │
│  │ ┌─────────────────────────────────────────┐ │               │
│  │ │ 🏷️ VIP Discount (15%)                   │ │               │
│  │ │    Save $7.50 (Customer Group)          │ │               │
│  │ └─────────────────────────────────────────┘ │               │
│  │                                             │               │
│  │ 💰 Manual Discount    🎫 Enter Coupon Code  │               │
│  │ 🎁 Comp Item                                │               │
│  └─────────────────────────────────────────────┘               │
│                                                                 │
│  Flow:                                                          │
│  1. GET /tpv/.../discounts/available (show options)            │
│  2. Staff selects discount                                      │
│  3. POST /tpv/.../discounts/predefined                         │
│  4. If requiresApproval: Show manager PIN prompt                │
│  5. Order totals recalculated                                   │
│  6. UI updated with applied discount                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.3 Coupon Code Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ TPV: Coupon Code Flow                                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Customer provides code: "SAVE20"                            │
│     │                                                           │
│     ▼                                                           │
│  2. POST /tpv/.../coupons/validate                             │
│     Body: { code: "SAVE20", orderTotal: 50.00 }                │
│     │                                                           │
│     ├─► Valid: Show preview                                     │
│     │   "20% off - Save $10.00"                                │
│     │   [Apply Coupon]                                          │
│     │                                                           │
│     └─► Invalid: Show error                                     │
│         "Code expired" / "Min purchase $100"                   │
│     │                                                           │
│     ▼                                                           │
│  3. Staff confirms → POST /tpv/.../discounts/coupon            │
│     │                                                           │
│     ▼                                                           │
│  4. Success: Order updated, coupon marked as used               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.4 Comp Flow (Manager Authorization)

```
┌─────────────────────────────────────────────────────────────────┐
│ TPV: Comp with Manager Authorization                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Staff selects "Comp Item" on ActionsTab                     │
│     │                                                           │
│     ▼                                                           │
│  2. Select items to comp (checkboxes)                           │
│     │                                                           │
│     ▼                                                           │
│  3. Enter reason (required)                                     │
│     ┌─────────────────────────────────────────┐                │
│     │ Reason for comp:                        │                │
│     │ [Customer complaint - food was cold   ] │                │
│     │                                         │                │
│     │ [Cancel]              [Request Approval]│                │
│     └─────────────────────────────────────────┘                │
│     │                                                           │
│     ▼                                                           │
│  4. Manager authorization prompt                                │
│     ┌─────────────────────────────────────────┐                │
│     │ 🔐 Manager Authorization Required       │                │
│     │                                         │                │
│     │ Enter Manager PIN:                      │                │
│     │ [● ● ● ●]                               │                │
│     │                                         │                │
│     │ Manager: [Select ▼]                     │                │
│     └─────────────────────────────────────────┘                │
│     │                                                           │
│     ▼                                                           │
│  5. POST /tpv/.../discounts/manual                             │
│     Body: {                                                     │
│       type: "COMP",                                             │
│       value: 100,                                               │
│       reason: "Customer complaint - food was cold",             │
│       authorizedById: "manager_456"                             │
│     }                                                           │
│     │                                                           │
│     ▼                                                           │
│  6. Item shows as $0.00 with "COMP" badge                       │
│     Full audit trail stored                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Business Logic

### 7.1 Loyalty Points Calculation

```typescript
// Earning Points
const earnPoints = async (venueId: string, customerId: string, orderTotal: number) => {
  const config = await getLoyaltyConfig(venueId)

  // Base points from spending
  const spendPoints = Math.floor(orderTotal * config.pointsPerDollar)

  // Bonus points per visit
  const visitPoints = config.pointsPerVisit

  const totalEarned = spendPoints + visitPoints

  // Create EARN transaction
  await createLoyaltyTransaction(customerId, 'EARN', totalEarned, orderId)

  // Update customer balance
  await updateCustomerPoints(customerId, totalEarned)
}

// Redeeming Points
const redeemPoints = async (venueId: string, customerId: string, points: number) => {
  const config = await getLoyaltyConfig(venueId)

  // Check minimum redemption
  if (points < config.minPointsRedeem) {
    throw new Error(`Minimum ${config.minPointsRedeem} points required`)
  }

  // Calculate discount
  const discountAmount = points * config.redemptionRate

  // Create REDEEM transaction (negative points)
  await createLoyaltyTransaction(customerId, 'REDEEM', -points, orderId)

  // Update customer balance
  await updateCustomerPoints(customerId, -points)

  return discountAmount
}
```

### 7.2 Discount Application Rules

```typescript
// Priority Order
const applyDiscountsInOrder = [
  1. Automatic discounts (by priority DESC)
  2. Customer group discounts
  3. Coupon code discounts
  4. Manual discounts
]

// Stacking Rules
const canStackDiscounts = (discount1, discount2) => {
  // Non-stackable discounts block all others
  if (!discount1.isStackable || !discount2.isStackable) {
    return false
  }

  // Same scope discounts don't stack
  if (discount1.scope === discount2.scope) {
    return false
  }

  return true
}

// BOGO Calculation
const calculateBOGO = (discount, orderItems) => {
  const buyItems = orderItems.filter(i => discount.buyItemIds.includes(i.productId))
  const getItems = orderItems.filter(i => discount.getItemIds.includes(i.productId))

  const buyCount = buyItems.reduce((sum, i) => sum + i.quantity, 0)
  const getCount = getItems.reduce((sum, i) => sum + i.quantity, 0)

  // How many "sets" can we apply?
  const sets = Math.floor(buyCount / discount.buyQuantity)
  const freeItems = Math.min(sets * discount.getQuantity, getCount)

  // Calculate discount (getDiscountPercent = 100 means free)
  const discountPercent = discount.getDiscountPercent / 100
  const freeItemsValue = getItems
    .slice(0, freeItems)
    .reduce((sum, i) => sum + i.price, 0)

  return freeItemsValue * discountPercent
}
```

### 7.3 Time-Based Discount Eligibility

```typescript
const isDiscountValidNow = (discount: Discount): boolean => {
  const now = new Date()

  // Date range check
  if (discount.validFrom && now < discount.validFrom) return false
  if (discount.validUntil && now > discount.validUntil) return false

  // Day of week check
  if (discount.daysOfWeek.length > 0) {
    const currentDay = now.getDay() // 0=Sunday, 6=Saturday
    if (!discount.daysOfWeek.includes(currentDay)) return false
  }

  // Time of day check
  if (discount.timeFrom && discount.timeUntil) {
    const currentTime = now.toTimeString().slice(0, 5) // "HH:MM"
    if (currentTime < discount.timeFrom || currentTime > discount.timeUntil) {
      return false
    }
  }

  return true
}
```

---

## 8. Improvement Recommendations

### 8.1 High Priority Improvements

#### 1. Customer Segments (Dynamic Groups)

**Inspired by:** Square Customer Segments

**Problem:** Current groups are manual-only. No automatic customer assignment.

**Solution:**

```prisma
model CustomerSegment {
  id          String   @id @default(cuid())
  venueId     String
  name        String
  description String?

  // Rule-based criteria (JSON)
  rules       Json     // { "totalSpent": { "gte": 500 }, "visits": { "gte": 10 } }

  // Dynamic membership computed on query
  customerCount Int    @default(0) // Cached count
  lastComputed  DateTime?
}
```

**Example Rules:**

```json
{
  "and": [{ "totalSpent": { "gte": 500 } }, { "lastVisitAt": { "gte": "30daysAgo" } }]
}
```

#### 2. Loyalty Promotions (Bonus Points)

**Inspired by:** Square Loyalty Promotions

**Problem:** No way to offer 2x, 3x point events.

**Solution:**

```prisma
model LoyaltyPromotion {
  id          String   @id @default(cuid())
  venueId     String
  name        String

  multiplier  Decimal  @db.Decimal(3, 2)  // 2.0 = 2x points

  // Time-based
  validFrom   DateTime
  validUntil  DateTime
  daysOfWeek  Int[]
  timeFrom    String?
  timeUntil   String?

  // Targeting
  targetCategoryIds String[]
  targetItemIds     String[]
  customerGroupId   String?

  active      Boolean  @default(true)
}
```

#### 3. First Purchase Restriction for Coupons

**Inspired by:** Stripe `first_time_transaction`

**Problem:** Cannot restrict coupons to new customers only.

**Solution:** Add to CouponCode:

```prisma
model CouponCode {
  // ... existing fields
  firstPurchaseOnly Boolean @default(false)
}
```

Validation logic:

```typescript
if (coupon.firstPurchaseOnly) {
  const previousOrders = await prisma.order.count({
    where: { customerId, paymentStatus: 'PAID' },
  })
  if (previousOrders > 0) {
    return { valid: false, error: 'Coupon valid for first purchase only' }
  }
}
```

### 8.2 Medium Priority Improvements

#### 4. Combo Discounts

**Inspired by:** Toast Combo Discounts

**Problem:** Can't create "Coffee + Bagel = $5" bundles.

**Solution:**

```prisma
model ComboDiscount {
  id          String   @id @default(cuid())
  venueId     String
  name        String

  // Required items for combo
  requiredItems Json   // [{ productId, quantity }]

  // Combo price (overrides individual prices)
  comboPrice  Decimal  @db.Decimal(10, 2)

  // Or discount off individual prices
  discountType DiscountType?
  discountValue Decimal?
}
```

#### 5. Category-Based Point Accrual

**Inspired by:** Square CATEGORY accrual rule

**Problem:** Cannot give extra points for specific categories.

**Solution:** Add to LoyaltyConfig or create LoyaltyAccrualRule:

```prisma
model LoyaltyAccrualRule {
  id          String   @id @default(cuid())
  venueId     String

  type        AccrualType  // SPEND, VISIT, CATEGORY, ITEM
  points      Int          // Points to earn

  // For CATEGORY type
  categoryIds String[]

  // For ITEM type
  itemIds     String[]

  // Multiplier (alternative to fixed points)
  multiplier  Decimal?     // 2.0 = 2x base points

  active      Boolean @default(true)
}
```

#### 6. Open Discounts (Variable at POS)

**Inspired by:** Square VARIABLE_PERCENTAGE, Toast Open Discounts

**Problem:** Manual discounts require exact value. Can't have "Open 10-50%" slider.

**Solution:**

```prisma
model Discount {
  // ... existing fields

  isOpen          Boolean @default(false)
  minValue        Decimal?  // Minimum allowed
  maxValue        Decimal?  // Maximum allowed
  valueStep       Decimal?  // Increment (e.g., 5 for 5%, 10%, 15%...)
}
```

### 8.3 Low Priority / Future Considerations

#### 7. Reward Tiers (Square Style)

Multiple reward options at different point levels.

#### 8. Cards on File

Save customer payment methods for faster checkout.

#### 9. Customer Merge

Handle duplicate customer records.

#### 10. A/B Testing for Discounts

Test different discounts with customer subsets.

---

## Appendix A: Comparison Matrix

| Feature                     | Toast     | Square | Clover    | Stripe | Avoqado |
| --------------------------- | --------- | ------ | --------- | ------ | ------- |
| **Customer Management**     |
| Customer Profiles           | ✅        | ✅     | ✅        | ✅     | ✅      |
| Customer Groups (Manual)    | ✅        | ✅     | ✅        | ❌     | ✅      |
| Customer Segments (Dynamic) | ❌        | ✅     | ❌        | ❌     | ❌      |
| Customer Tags               | ✅        | ✅     | ✅        | ✅     | ✅      |
| **Loyalty**                 |
| Points-Based                | 3rd Party | ✅     | 3rd Party | ❌     | ✅      |
| Visit-Based                 | 3rd Party | ✅     | 3rd Party | ❌     | ✅      |
| Category Bonus              | ❌        | ✅     | ❌        | ❌     | ❌      |
| Point Multipliers           | ❌        | ✅     | ❌        | ❌     | ❌      |
| Reward Tiers                | ❌        | ✅     | ❌        | ❌     | ❌      |
| **Discounts**               |
| Percentage                  | ✅        | ✅     | ✅        | ✅     | ✅      |
| Fixed Amount                | ✅        | ✅     | ✅        | ✅     | ✅      |
| Open/Variable               | ✅        | ✅     | ✅        | ❌     | ❌      |
| BOGO                        | ✅        | ✅     | ❌        | ❌     | ✅      |
| Combo                       | ✅        | ✅     | ❌        | ❌     | ❌      |
| Time-Based                  | ✅        | ✅     | ✅        | ❌     | ✅      |
| **Coupons**                 |
| Promo Codes                 | ✅        | ✅     | ✅        | ✅     | ✅      |
| Bulk Generation             | ✅        | ❌     | ❌        | ❌     | ✅      |
| First Purchase Only         | ❌        | ❌     | ❌        | ✅     | ❌      |
| Customer-Specific           | ✅        | ✅     | ❌        | ✅     | ✅      |
| **Comps**                   |
| Item-Level Comp             | ✅        | ✅     | ✅        | N/A    | ✅      |
| Manager Authorization       | ✅        | ✅     | ✅        | N/A    | ✅      |
| Comp Reasons                | ✅        | ✅     | ✅        | N/A    | ✅      |

---

## Appendix B: Sources

- [Square Customers API](https://developer.squareup.com/docs/customers-api/what-it-does)
- [Square Loyalty API](https://developer.squareup.com/docs/loyalty-api/overview)
- [Square CatalogDiscount](https://developer.squareup.com/reference/square/objects/CatalogDiscount)
- [Toast Loyalty Integration](https://doc.toasttab.com/doc/devguide/apiLoyaltyProgramIntegrationOverview.html)
- [Toast Order Discounts](https://doc.toasttab.com/doc/devguide/apiDiscountingOrders.html)
- [Stripe Billing Customers](https://docs.stripe.com/billing/customer)
- [Stripe Coupons](https://docs.stripe.com/billing/subscriptions/coupons)
- [Clover Discounts](https://docs.clover.com/dev/reference/inventorycreatediscount)
