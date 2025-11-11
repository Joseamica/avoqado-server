# MerchantAccountId Usage Analysis - Avoqado Server

## Summary

**Found: 23 source files + Prisma schema + 2 migrations** **Total occurrences: 180+ usages across backend codebase**

---

## 1. PRISMA SCHEMA DEFINITIONS

### A. Payment Model (OPTIONAL field - nullable)

**File:** `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/prisma/schema.prisma:1523-1524`

```prisma
model Payment {
  // ⭐ Provider-agnostic merchant account tracking (2025-01-10)
  merchantAccountId String?  // ← NULLABLE (backward compatible)
  merchantAccount   MerchantAccount? @relation(fields: [merchantAccountId], references: [id], onDelete: Restrict)

  @@index([merchantAccountId]) // Line 1578
}
```

**Schema Details:**

- **Required:** NO (optional, nullable)
- **Relations:** FK to MerchantAccount (onDelete: Restrict)
- **Indexes:** Single index on merchantAccountId
- **Impact:** BREAKING if made required (legacy payments have null)

---

### B. ProviderCostStructure Model (REQUIRED field)

**File:** `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/prisma/schema.prisma:2132-2133`

```prisma
model ProviderCostStructure {
  merchantAccountId String  // ← REQUIRED (not nullable)
  merchantAccount   MerchantAccount @relation(fields: [merchantAccountId], references: [id])

  @@unique([merchantAccountId, effectiveFrom])  // Line 2166
  @@index([merchantAccountId])  // Line 2168
}
```

**Schema Details:**

- **Required:** YES (must always be present)
- **Relations:** FK to MerchantAccount
- **Constraints:** Unique with effectiveFrom
- **Indexes:** Unique composite + single index
- **Impact:** BREAKING if made optional (business logic depends on this)

---

### C. TransactionCost Model (REQUIRED field)

**File:** `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/prisma/schema.prisma:2231-2232`

```prisma
model TransactionCost {
  merchantAccountId String  // ← REQUIRED (not nullable)
  merchantAccount   MerchantAccount @relation(fields: [merchantAccountId], references: [id])

  @@index([merchantAccountId])  // Line 2262
}
```

**Schema Details:**

- **Required:** YES (must always be present)
- **Relations:** FK to MerchantAccount
- **Indexes:** Single index
- **Impact:** BREAKING if made optional (cost calculation depends on this)

---

### D. SettlementConfiguration Model (REQUIRED field)

**File:** `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/prisma/schema.prisma:2277-2278`

```prisma
model SettlementConfiguration {
  merchantAccountId String  // ← REQUIRED (not nullable)
  merchantAccount   MerchantAccount @relation(fields: [merchantAccountId], references: [id], onDelete: Cascade)

  @@unique([merchantAccountId, cardType, effectiveFrom])  // Line 2300
  @@index([merchantAccountId])  // Line 2301
}
```

**Schema Details:**

- **Required:** YES (must always be present)
- **Relations:** FK to MerchantAccount (onDelete: Cascade)
- **Constraints:** Unique with cardType + effectiveFrom
- **Indexes:** Unique composite + single index
- **Impact:** BREAKING if made optional (settlement rules depend on this)

---

### E. MerchantAccount Model (Relations)

**File:** `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/prisma/schema.prisma:2001-2008`

```prisma
model MerchantAccount {
  // Relations (this merchant account is referenced by):
  venueConfigsPrimary   VenuePaymentConfig[]      @relation("PrimaryAccount")
  venueConfigsSecondary VenuePaymentConfig[]      @relation("SecondaryAccount")
  venueConfigsTertiary  VenuePaymentConfig[]      @relation("TertiaryAccount")
  costStructures        ProviderCostStructure[]
  transactionCosts      TransactionCost[]
  settlementConfigs     SettlementConfiguration[]
  payments              Payment[]  // ⭐ NUEVO: Track all payments processed by this merchant account
}
```

---

## 2. VALIDATION SCHEMAS (Zod)

### A. TPV Payment Request Schema

**File:** `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/schemas/tpv.schema.ts:171`

```typescript
merchantAccountId: z.string().cuid({ message: 'El ID de la cuenta merchant debe ser un CUID válido.' }).optional()
```

**Validation:** OPTIONAL (modern Android clients)

### B. Payment Routing Schema

**File:** `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/schemas/tpv.schema.ts:187`

```typescript
merchantAccountId: z.string().cuid({ message: 'El ID de la cuenta merchant debe ser un CUID válido.' })
```

**Validation:** REQUIRED (endpoint POST /payment/routing)

### C. Cost Management Schema

**File:** `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/schemas/dashboard/cost-management.schema.ts:51`

```typescript
merchantAccountId: z.string().optional()
```

**Validation:** OPTIONAL (query filter)

### D. Provider Cost Structure Schema

**File:** `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/schemas/dashboard/cost-management.schema.ts:101`

```typescript
merchantAccountId: z.string().min(1, 'Merchant account ID is required')
```

**Validation:** REQUIRED (create/update operations)

---

## 3. DATABASE QUERIES (Prisma findFirst/findUnique/findMany)

### A. Payment Service (payment.tpv.service.ts)

**Location:** Line 761

```typescript
logger.info(`✅ Resolved blumonSerialNumber ${blumonSerialNumber} → merchantAccountId ${merchant.id}`)
```

**Query Type:** Resolution from Blumon serial to merchantAccountId

**Context:**

- Priority 1: Use merchantAccountId if provided by modern Android client
- Priority 2: Resolve blumonSerialNumber → merchantAccountId for backward compatibility
- Priority 3: Leave undefined (legacy payments before feature)

---

### B. Payment Dashboard Service (payment.dashboard.service.ts:40-41)

```typescript
if (filters.merchantAccountId) {
  whereClause.merchantAccountId = filters.merchantAccountId
}
```

**Query Type:** WHERE filter for payment listings **Impact:** Filtering payments by merchant account in dashboard

---

### C. Settlement Configuration Service (settlementConfiguration.service.ts)

**Query 1: Get all configurations (Line 69)**

```typescript
if (filters?.merchantAccountId) {
  where.merchantAccountId = filters.merchantAccountId
}
```

**Query 2: Check existing config (Line 172)**

```typescript
const existingConfig = await prisma.settlementConfiguration.findFirst({
  where: {
    merchantAccountId: data.merchantAccountId,
    cardType: data.cardType,
    effectiveTo: null, // Only active configs
  },
})
```

**Query 3: Get active configuration (Line 305)**

```typescript
export async function getActiveConfiguration(merchantAccountId: string, cardType: TransactionCardType, effectiveDate: Date = new Date()) {
  const configuration = await prisma.settlementConfiguration.findFirst({
    where: {
      merchantAccountId,
      cardType,
      effectiveFrom: { lte: effectiveDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveDate } }],
    },
  })
}
```

---

### D. Provider Cost Structure Service (providerCostStructure.service.ts)

**Query 1: Get cost structures (Line 66)**

```typescript
if (merchantAccountId) {
  where.merchantAccountId = merchantAccountId
}
```

**Query 2: Get active cost structure (Line 142-145)**

```typescript
const costStructure = await prisma.providerCostStructure.findFirst({
  where: {
    merchantAccountId,
    active: true,
    effectiveFrom: { lte: now },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
  },
})
```

---

### E. Transaction Cost Service (transactionCost.service.ts)

**Query 1: Find active provider cost structure (Line 68)**

```typescript
export async function findActiveProviderCostStructure(merchantAccountId: string, effectiveDate: Date = new Date()) {
  const costStructure = await prisma.providerCostStructure.findFirst({
    where: {
      merchantAccountId,
      active: true,
      effectiveFrom: { lte: effectiveDate },
    },
  })
}
```

**Query 2: Create transaction cost record (Line 330)**

```typescript
data: {
  paymentId: payment.id,
  merchantAccountId: merchantAccount.id,  // ← Required
  transactionType,
  amount,
  // ... provider costs
}
```

---

### F. Cost Calculation Service (cost-calculation.service.ts)

**Query 1: Get provider cost structure (Line 40)**

```typescript
const providerCost = await prisma.providerCostStructure.findFirst({
  where: {
    merchantAccountId,
    active: true,
    effectiveFrom: { lte: new Date() },
  },
})
```

**Query 2: Update provider costs (Line 172)**

```typescript
await prisma.providerCostStructure.updateMany({
  where: { merchantAccountId, active: true },
  data: { active: false, effectiveTo: new Date() },
})
```

**Query 3: Create new cost structure (Line 179-182)**

```typescript
await prisma.providerCostStructure.create({
  data: {
    merchantAccountId,
    providerId: (...).providerId,
    // ... cost data
  },
})
```

---

### G. Settlement Calculation Service (settlementCalculation.service.ts)

**Query 1: Find active settlement config (Line 178-179)**

```typescript
const config = await prisma.settlementConfiguration.findFirst({
  where: {
    merchantAccountId,
    cardType,
    effectiveFrom: { lte: effectiveDate },
  },
})
```

**Query 2: Calculate payment settlement (Line 320)**

```typescript
const config = await findActiveSettlementConfig(merchantAccountId, cardType, payment.createdAt)
```

**Query 3: Settlement simulation (Line 367)**

```typescript
select: {
  merchantAccountId: true,
  transactionType: true,
  providerCostAmount: true,
  venueChargeAmount: true,
}
```

---

### H. Cost Management Service (cost-management.service.ts)

**Query 1: Transaction stats (Line 258)**

```typescript
const transactionStats = await prisma.transactionCost.aggregate({
  where: {
    merchantAccountId: merchant.id,
    createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
  },
})
```

**Query 2: Cost details (Line 373)**

```typescript
merchantAccountId: cost.merchantAccountId,
```

---

### I. Available Balance Service (availableBalance.dashboard.service.ts:205)

```typescript
merchantAccountId: true // Selected in transaction cost relation
```

---

## 4. API ROUTE DEFINITIONS

### A. TPV Routes (tpv.routes.ts:838-841)

**Endpoint:** POST `/tpv/venues/{venueId}/orders/{orderId}/payment` **Parameter:** merchantAccountId (REQUIRED in body) **Type:** Selected
merchant account ID (user has already chosen primary/secondary/tertiary)

**Documentation:**

```yaml
merchantAccountId:
  type: string
  format: cuid
  description: Selected merchant account ID
```

### B. Settlement Configuration Routes

**Base URL:** `/api/v1/superadmin/settlement-configurations`

| Endpoint                               | Method | Parameter | Required |
| -------------------------------------- | ------ | --------- | -------- |
| `/?merchantAccountId=...`              | GET    | Query     | NO       |
| `/active/:merchantAccountId/:cardType` | GET    | Path      | YES      |
| `/`                                    | POST   | Body      | YES      |
| `/bulk`                                | POST   | Body      | YES      |

### C. Provider Cost Structure Routes

**Base URL:** `/api/v1/superadmin/provider-cost-structures`

| Endpoint                     | Method | Parameter | Required |
| ---------------------------- | ------ | --------- | -------- |
| `/?merchantAccountId=...`    | GET    | Query     | NO       |
| `/active/:merchantAccountId` | GET    | Path      | YES      |
| `/`                          | POST   | Body      | YES      |
| `/flat-rate`                 | POST   | Body      | YES      |

### D. Terminal Routes

**Endpoint:** POST `/api/v1/superadmin/terminals/:terminalId/merchants` **Parameter:** merchantAccountIds (array, REQUIRED in body)
**Usage:** Assign multiple merchant accounts to a physical terminal

---

## 5. SERVICE IMPLEMENTATIONS

### A. Payment TPV Service (payment.tpv.service.ts)

**Function:** `recordOrderPayment()` **Lines:** 887-902, 937

**Implementation:**

```typescript
// ⭐ PROVIDER-AGNOSTIC MERCHANT TRACKING: Resolve merchantAccountId
let merchantAccountId = paymentData.merchantAccountId

if (!merchantAccountId && paymentData.blumonSerialNumber) {
  merchantAccountId = await resolveBlumonSerialToMerchantId(venueId, paymentData.blumonSerialNumber)
}

if (merchantAccountId) {
  logger.info(`✅ Payment will be attributed to merchantAccountId: ${merchantAccountId}`)
} else {
  logger.warn(`⚠️ No merchantAccountId - payment will have null merchant (legacy mode)`)
}

// Later in create:
merchantAccountId,  // Can be null for legacy
```

**Function:** `recordFastPayment()` **Lines:** 1277-1344

**Implementation:** Same pattern as above with legacy fallback

**Function:** `getPaymentRouting()` **Line:** 1619

```typescript
interface PaymentRoutingData {
  amount: number
  merchantAccountId: string // REQUIRED: User has already selected
  terminalSerial: string
  bin?: string
}
```

---

### B. Settlement Configuration Service (settlementConfiguration.service.ts)

**Key Functions:**

1. **getSettlementConfigurations(filters)**

   - Filter by merchantAccountId (optional)
   - Returns all configurations for merchant

2. **getActiveConfiguration(merchantAccountId, cardType)**

   - Get currently active config
   - Required: merchantAccountId + cardType

3. **createSettlementConfiguration(data)**

   - Required: merchantAccountId
   - Creates new config with unique constraint: (merchantAccountId, cardType, effectiveFrom)

4. **bulkCreateSettlementConfigurations(merchantAccountId, configs)**
   - Required: merchantAccountId
   - Creates multiple card type configs at once

---

### C. Provider Cost Structure Service (providerCostStructure.service.ts)

**Key Functions:**

1. **getProviderCostStructures(merchantAccountId?, includeInactive)**

   - Optional filter by merchantAccountId
   - Returns cost structures ordered by effectiveFrom DESC

2. **getActiveCostStructure(merchantAccountId)**

   - Get currently active cost structure
   - Required: merchantAccountId
   - Returns null if no active structure

3. **createProviderCostStructure(data)**
   - Required: merchantAccountId
   - Creates new cost structure with unique constraint: (merchantAccountId, effectiveFrom)

---

### D. Transaction Cost Service (transactionCost.service.ts)

**Key Functions:**

1. **findActiveProviderCostStructure(merchantAccountId, effectiveDate)**

   - Find active cost for specific merchant account
   - Required: merchantAccountId

2. **calculateAndRecordTransactionCost(payment)**
   - Records transaction cost record
   - Uses merchantAccountId from payment
   - Required: payment.merchantAccountId

---

### E. Cost Calculation Service (cost-calculation.service.ts)

**Interface:**

```typescript
interface CostCalculationInput {
  venueId: string
  amount: number
  cardType: TransactionCardType
  accountType: AccountType // PRIMARY, SECONDARY, TERTIARY
  merchantAccountId: string // REQUIRED
}
```

**Key Functions:**

1. **calculateTransactionCost(input)**

   - Get provider cost structure by merchantAccountId
   - Get venue pricing structure
   - Calculate and return cost breakdown

2. **updateProviderCosts(merchantAccountId, newCosts)**
   - Deactivate current cost structures
   - Create new cost structure

---

### F. Settlement Calculation Service (settlementCalculation.service.ts)

**Key Functions:**

1. **findActiveSettlementConfig(merchantAccountId, cardType, effectiveDate)**

   - Find active settlement configuration
   - Required: merchantAccountId

2. **calculatePaymentSettlement(payment, merchantAccountId, cardType)**

   - Calculate settlement date and amount
   - Uses active settlement config for merchant account

3. **simulateSettlement(payment)**
   - References merchantAccountId from transactionCost relation

---

## 6. CONTROLLER IMPLEMENTATIONS

### A. Payment Dashboard Controller (payment.dashboard.controller.ts)

**Endpoint:** GET `/dashboard/payments` **Query Parameter:** merchantAccountId (optional) **Implementation:**

```typescript
const filters: paymentDashboardService.PaymentFilters = {
  merchantAccountId: req.query.merchantAccountId,
  // ... other filters
}
```

---

### B. Settlement Configuration Controller (settlementConfiguration.controller.ts)

| Function                           | Endpoint                                 | merchantAccountId | Required |
| ---------------------------------- | ---------------------------------------- | ----------------- | -------- |
| getSettlementConfigurations        | GET /                                    | Query             | NO       |
| getActiveConfiguration             | GET /active/:merchantAccountId/:cardType | Path              | YES      |
| createSettlementConfiguration      | POST /                                   | Body              | YES      |
| bulkCreateSettlementConfigurations | POST /bulk                               | Body              | YES      |

---

### C. Provider Cost Structure Controller (providerCostStructure.controller.ts)

| Function                    | Endpoint                       | merchantAccountId | Required |
| --------------------------- | ------------------------------ | ----------------- | -------- |
| getProviderCostStructures   | GET /                          | Query             | NO       |
| getActiveCostStructure      | GET /active/:merchantAccountId | Path              | YES      |
| createProviderCostStructure | POST /                         | Body              | YES      |
| createFlatRateCostStructure | POST /flat-rate                | Body              | YES      |

---

### D. Terminal Controller (terminal.controller.ts:49-183)

**Function:** `assignMerchantsToTerminal()`

```typescript
const { merchantAccountIds } = req.body // Array of merchant account IDs

if (!merchantAccountIds || !Array.isArray(merchantAccountIds)) {
  throw new BadRequestError('merchantAccountIds must be an array')
}

// Fetch merchant accounts
const merchantAccounts = await prisma.merchantAccount.findMany({
  where: {
    id: { in: merchantAccountIds },
  },
})

// Update terminal with assigned merchants
const updatedTerminal = await prisma.terminal.update({
  where: { id: terminalId },
  data: {
    assignedMerchantIds: merchantAccountIds,
    updatedAt: new Date(),
  },
})
```

---

## 7. BUSINESS LOGIC FLOWS

### A. Payment Processing Flow

```
1. TPV sends payment request with merchantAccountId (optional)
2. Service checks: merchantAccountId provided?
   YES → Use it directly
   NO → Has blumonSerialNumber? → Resolve to merchantAccountId
   NO → Leave as NULL (legacy)

3. Create Payment record with merchantAccountId

4. Create TransactionCost record (REQUIRES merchantAccountId)
   - Look up ProviderCostStructure by merchantAccountId
   - Calculate costs based on merchant's rates

5. Create SettlementConfiguration lookup (if needed)
   - Find config by (merchantAccountId, cardType)
   - Calculate estimated settlement date
```

### B. Cost Management Flow

```
1. Get merchant account
2. Fetch ProviderCostStructure by merchantAccountId
3. Fetch TransactionCost records by merchantAccountId
4. Aggregate and report costs
```

### C. Settlement Configuration Flow

```
1. Create SettlementConfiguration with merchantAccountId
2. Enforce unique constraint: (merchantAccountId, cardType, effectiveFrom)
3. When processing payment, find active config by merchantAccountId + cardType
4. Calculate settlement date using config rules
```

---

## 8. MIGRATION HISTORY

### Migration 1: Payment Table Enhancement

**File:** `prisma/migrations/20251110112527_add_merchant_account_to_payments/migration.sql`

```sql
-- Add merchantAccountId column to Payment table (nullable for backward compatibility)
ALTER TABLE "Payment" ADD COLUMN "merchantAccountId" TEXT;

-- Add foreign key constraint
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_merchantAccountId_fkey"
  FOREIGN KEY ("merchantAccountId") REFERENCES "MerchantAccount"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add index on merchantAccountId for efficient queries
CREATE INDEX "Payment_merchantAccountId_idx" ON "Payment"("merchantAccountId");
```

**Impact:** NULLABLE - backward compatible with existing payments

### Migration 2: Cost Management System

**File:** `prisma/migrations/20250904014551_add_cost_management_and_pricing_models/migration.sql`

```sql
CREATE TABLE "public"."ProviderCostStructure" (
    "merchantAccountId" TEXT NOT NULL,
    ...
);

CREATE TABLE "public"."TransactionCost" (
    "merchantAccountId" TEXT NOT NULL,
    ...
);

-- Create indexes
CREATE INDEX "ProviderCostStructure_merchantAccountId_idx" ON "public"."ProviderCostStructure"("merchantAccountId");
CREATE UNIQUE INDEX "ProviderCostStructure_merchantAccountId_effectiveFrom_key" ON "public"."ProviderCostStructure"("merchantAccountId", "effectiveFrom");
CREATE INDEX "TransactionCost_merchantAccountId_idx" ON "public"."TransactionCost"("merchantAccountId");

-- Create foreign key constraints
ALTER TABLE "public"."ProviderCostStructure" ADD CONSTRAINT "ProviderCostStructure_merchantAccountId_fkey"
  FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."TransactionCost" ADD CONSTRAINT "TransactionCost_merchantAccountId_fkey"
  FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

**Impact:** REQUIRED - no existing data, fresh tables

### Migration 3: Settlement Tracking System

**File:** `prisma/migrations/20251031195807_add_settlement_tracking_system/migration.sql`

```sql
CREATE TABLE "public"."SettlementConfiguration" (
    "merchantAccountId" TEXT NOT NULL,
    ...
);

CREATE INDEX "SettlementConfiguration_merchantAccountId_idx" ON "public"."SettlementConfiguration"("merchantAccountId");
CREATE UNIQUE INDEX "SettlementConfiguration_merchantAccountId_cardType_effectiv_key"
  ON "public"."SettlementConfiguration"("merchantAccountId", "cardType", "effectiveFrom");

ALTER TABLE "public"."SettlementConfiguration" ADD CONSTRAINT "SettlementConfiguration_merchantAccountId_fkey"
  FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
```

**Impact:** REQUIRED - no existing data, fresh tables

---

## 9. SEED DATA USAGE

**File:** `prisma/seed.ts`

### Seed Examples:

**Line 780:**

```typescript
merchantAccountId: stripeMerchant.id,  // Stripe account
```

**Line 797:**

```typescript
merchantAccountId: blumonMerchantA.id,  // Blumon account A
```

**Line 814:**

```typescript
merchantAccountId: blumonMerchantB.id,  // Blumon account B
```

**Line 3287-3308:**

```typescript
const merchantAccountId = // Resolve based on payment method
  paymentMethod !== PaymentMethod.CASH && merchantAccountId
    ? merchantAccountId
    : undefined

// Create payment with merchant
merchantAccountId, // 🆕 Link payment to merchant account
```

---

## 10. AGGREGATIONS & REPORTING

### A. Available Balance Service (availableBalance.dashboard.service.ts)

**Query:** Select merchantAccountId from transactionCost relation

- Used for tracking which merchant account processed payment
- Links transaction costs to merchant accounts

### B. Cost Management Service (cost-management.service.ts)

**Aggregation 1: Transaction Stats**

```typescript
const transactionStats = await prisma.transactionCost.aggregate({
  where: {
    merchantAccountId: merchant.id,
    createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
  },
  _sum: {
    amount: true,
    providerCostAmount: true,
    venueChargeAmount: true,
  },
})
```

**Aggregation 2: Cost Details Mapping**

```typescript
merchantAccountId: cost.merchantAccountId,
providerName: cost.merchantAccount?.provider?.name,
```

---

## SUMMARY TABLE

| Model                   | Field             | Required | Type   | Indexes | Constraints                                                    | Default | Impact               |
| ----------------------- | ----------------- | -------- | ------ | ------- | -------------------------------------------------------------- | ------- | -------------------- |
| Payment                 | merchantAccountId | NO       | String | ✓ Index | FK(MerchantAccount)                                            | null    | BREAKING if required |
| ProviderCostStructure   | merchantAccountId | YES      | String | ✓ Index | FK(MerchantAccount), Unique(+effectiveFrom)                    | -       | BREAKING if optional |
| TransactionCost         | merchantAccountId | YES      | String | ✓ Index | FK(MerchantAccount)                                            | -       | BREAKING if optional |
| SettlementConfiguration | merchantAccountId | YES      | String | ✓ Index | FK(MerchantAccount, Cascade), Unique(+cardType, effectiveFrom) | -       | BREAKING if optional |

---

## MAKING merchantAccountId NULLABLE

**IMPACT ANALYSIS:**

### BREAKING Changes

1. ProviderCostStructure - Business logic requires knowing which merchant's rates apply
2. TransactionCost - Cost calculations fundamentally depend on merchantAccountId
3. SettlementConfiguration - Settlement dates calculated per merchant account

### COMPATIBLE Changes

1. Payment - Already nullable, legacy payments exist without it
2. Dashboard filters - merchantAccountId is optional query filter

### REQUIRED Migrations

1. **ProviderCostStructure:** Add DEFAULT or backfill logic (HIGH IMPACT)
2. **TransactionCost:** Add DEFAULT or backfill logic (HIGH IMPACT)
3. **SettlementConfiguration:** Add DEFAULT or backfill logic (HIGH IMPACT)

### Code Changes Required

1. All functions expecting `merchantAccountId: string` → `merchantAccountId?: string`
2. Add null-checking logic throughout cost calculation, settlement, and reporting
3. Update type definitions in interfaces and DTOs
4. Update validation schemas (Zod)

---

## RECOMMENDATIONS

1. **Payment:** Keep nullable (backward compatibility already in place)
2. **ProviderCostStructure/TransactionCost/SettlementConfiguration:** Keep required (core business logic)
3. **Future:** Consider audit trail for when merchantAccountId changed from null → populated
4. **Migration:** If making required tables nullable:
   - Create data migration first
   - Add DEFAULT constraint
   - Update validation schemas
   - Update service implementations
   - Add comprehensive logging
