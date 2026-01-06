# Discount Engine

## Overview

The Discount Engine is the core system for calculating and applying discounts to orders. It supports automatic discounts, BOGO (Buy One Get One), percentage/fixed discounts, comps, and complex eligibility rules including time windows, usage limits, and customer group targeting.

## Business Context

**Key Use Cases:**
- Happy hour discounts (time-based)
- Customer loyalty discounts (customer group)
- BOGO promotions (Buy 2 Get 1 Free)
- Manager comps (100% off with approval)
- Category-wide discounts (all drinks 20% off)
- Volume discounts (spend $500, get 10% off)

**Industry Standards:**
- Toast: "Discounts & Comps" with manager approval
- Square: "Discounts" with automatic rules
- Clover: "Order-level and item-level discounts"

## Database Models

### Discount

```prisma
model Discount {
  id      String @id @default(cuid())
  venueId String

  // Basic info
  name        String
  description String?
  type        DiscountType     // PERCENTAGE, FIXED_AMOUNT, COMP
  value       Decimal          // Percentage (0-100) or fixed amount

  // Scope - what the discount applies to
  scope DiscountScope @default(ORDER)

  // Target IDs (based on scope)
  targetItemIds          String[]  // Product IDs when scope = ITEM
  targetCategoryIds      String[]  // Category IDs when scope = CATEGORY
  targetModifierIds      String[]  // Modifier IDs
  targetModifierGroupIds String[]  // ModifierGroup IDs

  // Customer Group targeting
  customerGroupId String?

  // Automatic application
  isAutomatic Boolean @default(false)
  priority    Int @default(0)  // Higher = applied first

  // Rules / Conditions
  minPurchaseAmount Decimal?  // Minimum order total required
  maxDiscountAmount Decimal?  // Cap on discount amount
  minQuantity       Int?      // Minimum item quantity

  // BOGO configuration
  buyQuantity        Int?      // Buy X items...
  getQuantity        Int?      // ...get Y items
  getDiscountPercent Decimal?  // ...at Z% off (100 = free)
  buyItemIds         String[]  // Items that qualify for "buy"
  getItemIds         String[]  // Items that qualify for "get"

  // Time-based restrictions
  validFrom  DateTime?
  validUntil DateTime?
  daysOfWeek Int[]      // 0-6 (Sunday-Saturday)
  timeFrom   String?    // "09:00"
  timeUntil  String?    // "17:00"

  // Usage limits
  maxTotalUses       Int?
  maxUsesPerCustomer Int?
  currentUses        Int @default(0)

  // Comp-specific
  requiresApproval Boolean @default(false)

  // Tax handling
  applyBeforeTax Boolean @default(true)

  // Stacking rules
  isStackable   Boolean @default(false)
  stackPriority Int @default(0)
}
```

### DiscountType Enum

```prisma
enum DiscountType {
  PERCENTAGE    // E.g., 10% off
  FIXED_AMOUNT  // E.g., $50 off
  COMP          // Full comp (100% off)
}
```

### DiscountScope Enum

```prisma
enum DiscountScope {
  ORDER           // Entire order subtotal
  ITEM            // Specific products
  CATEGORY        // Products in categories
  MODIFIER        // Specific modifiers
  MODIFIER_GROUP  // Modifiers in groups
  CUSTOMER_GROUP  // Auto-apply to group members
  QUANTITY        // BOGO promotions
}
```

### OrderDiscount

Applied discounts are stored per order for historical accuracy:

```prisma
model OrderDiscount {
  id      String @id @default(cuid())
  orderId String

  // Source (one should be set)
  discountId   String?    // Link to Discount
  couponCodeId String?    // Link to CouponCode

  // Denormalized details
  type  DiscountType
  name  String
  value Decimal       // Original value

  // Calculated amounts
  amount       Decimal   // Actual discount applied
  taxReduction Decimal   // Tax saved

  // Flags
  isComp      Boolean @default(false)
  isAutomatic Boolean @default(false)
  isManual    Boolean @default(false)

  // Comp-specific
  compReason String?

  // Audit trail
  appliedById    String?   // Staff who applied
  authorizedById String?   // Manager who approved
}
```

## Architecture

### Discount Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Discount Application Flow                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Order Created/Updated                                            │
│     └── evaluateAutomaticDiscounts(orderId)                          │
│                                                                      │
│  2. Get Eligible Discounts                                           │
│     ├── Check venue + active                                         │
│     ├── Check date validity (validFrom/validUntil)                   │
│     ├── Check day of week (daysOfWeek)                               │
│     ├── Check time window (timeFrom/timeUntil)                       │
│     ├── Check usage limits (maxTotalUses, currentUses)               │
│     ├── Check minimum purchase (minPurchaseAmount)                   │
│     ├── Check customer usage limit (maxUsesPerCustomer)              │
│     └── Check customer group membership (customerGroupId)            │
│                                                                      │
│  3. Filter Automatic Discounts                                       │
│     └── isAutomatic = true                                           │
│                                                                      │
│  4. Add Customer-Specific Discounts                                  │
│     └── CustomerDiscount assignments                                 │
│                                                                      │
│  5. Sort by Priority (highest first)                                 │
│                                                                      │
│  6. Calculate Amounts                                                │
│     ├── Get applicable base (scope determines what to discount)      │
│     ├── Apply discount type (%, fixed, comp)                         │
│     ├── Apply max discount cap                                       │
│     └── Calculate tax reduction (if applyBeforeTax)                  │
│                                                                      │
│  7. Handle Stacking Rules                                            │
│     └── Non-stackable discounts exclude each other                   │
│                                                                      │
│  8. Apply to Order                                                   │
│     ├── Create OrderDiscount records                                 │
│     ├── Update Order.discountAmount                                  │
│     ├── Update Order.taxAmount (if before-tax)                       │
│     └── Increment Discount.currentUses                               │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Scope-Based Calculation

| Scope | Applicable Base |
|-------|-----------------|
| `ORDER` | Entire order subtotal |
| `ITEM` | Sum of items matching `targetItemIds` |
| `CATEGORY` | Sum of items in `targetCategoryIds` |
| `MODIFIER` | Sum of modifiers matching `targetModifierIds` |
| `MODIFIER_GROUP` | Sum of modifiers in `targetModifierGroupIds` |
| `CUSTOMER_GROUP` | Entire order (if customer in group) |
| `QUANTITY` | BOGO calculation (separate logic) |

## Service Layer

**File:** `src/services/dashboard/discountEngine.service.ts`

### Main Functions

```typescript
// Get all discounts eligible for an order
export async function getEligibleDiscounts(
  venueId: string,
  customerId?: string,
  orderTotal?: number
): Promise<DiscountCandidate[]>

// Get customer-assigned discounts
export async function getCustomerDiscounts(
  venueId: string,
  customerId: string
): Promise<DiscountCandidate[]>

// Calculate discount amount for a discount
export function calculateDiscountAmount(
  discount: DiscountCandidate,
  context: OrderContext
): DiscountCalculationResult

// Evaluate all automatic discounts for an order
export async function evaluateAutomaticDiscounts(
  orderId: string
): Promise<DiscountCalculationResult[]>

// Apply a calculated discount to an order
export async function applyDiscountToOrder(
  orderId: string,
  discount: DiscountCalculationResult,
  appliedById?: string,
  authorizedById?: string
): Promise<ApplyDiscountResult>

// Remove a discount from an order
export async function removeDiscountFromOrder(
  orderId: string,
  orderDiscountId: string
): Promise<ApplyDiscountResult>

// Apply all eligible automatic discounts
export async function applyAutomaticDiscounts(
  orderId: string,
  appliedById?: string
): Promise<{ applied: DiscountCalculationResult[]; total: number }>

// Apply manual (on-the-fly) discount
export async function applyManualDiscount(
  orderId: string,
  type: DiscountType,
  value: number,
  name: string,
  appliedById: string,
  authorizedById?: string,
  compReason?: string
): Promise<ApplyDiscountResult>
```

## BOGO Implementation

### Configuration Example

```typescript
// Buy 2 Tacos, Get 1 Free
{
  name: "Buy 2 Get 1 Free Tacos",
  type: "PERCENTAGE",
  value: 100,  // Not used for BOGO
  scope: "QUANTITY",
  buyQuantity: 2,
  getQuantity: 1,
  getDiscountPercent: 100,  // 100% off = free
  buyItemIds: ["taco_asada", "taco_pastor", "taco_carnitas"],
  getItemIds: ["taco_asada", "taco_pastor", "taco_carnitas"],
  isAutomatic: true
}
```

### BOGO Calculation Logic

```typescript
function calculateBOGO(discount, context) {
  // 1. Filter items that qualify for "buy"
  const buyItems = context.items.filter(i => discount.buyItemIds.includes(i.productId))

  // 2. Count total "buy" quantity
  const totalBuyQty = buyItems.reduce((sum, i) => sum + i.quantity, 0)

  // 3. Calculate qualifying sets
  const qualifyingSets = Math.floor(totalBuyQty / discount.buyQuantity)
  const freeItemCount = qualifyingSets * discount.getQuantity

  // 4. Sort "get" items by price (cheapest first)
  const sortedGetItems = getItems.sort((a, b) => a.unitPrice - b.unitPrice)

  // 5. Apply discount to cheapest qualifying items
  for (const item of sortedGetItems) {
    const itemsToDiscount = Math.min(item.quantity, remainingFree)
    totalDiscount += (item.unitPrice * itemsToDiscount * discountPercent) / 100
  }

  return totalDiscount
}
```

## Time-Based Discounts

### Happy Hour Example

```typescript
{
  name: "Happy Hour 20% Off Drinks",
  type: "PERCENTAGE",
  value: 20,
  scope: "CATEGORY",
  targetCategoryIds: ["cat_drinks", "cat_cocktails"],
  isAutomatic: true,
  daysOfWeek: [1, 2, 3, 4, 5],  // Monday-Friday
  timeFrom: "16:00",
  timeUntil: "19:00"
}
```

### Time Window Logic

```typescript
function isWithinTimeWindow(timeFrom: string, timeUntil: string): boolean {
  const now = new Date()
  const currentTime = `${now.getHours()}:${now.getMinutes()}`

  // Handle overnight windows (e.g., 22:00 - 02:00)
  if (timeFrom > timeUntil) {
    return currentTime >= timeFrom || currentTime <= timeUntil
  }

  return currentTime >= timeFrom && currentTime <= timeUntil
}
```

## Stacking Rules

### Non-Stackable Discounts

When `isStackable = false`:
- Only one non-stackable discount can apply
- Higher `stackPriority` wins
- Non-stackable discounts can't combine with other non-stackables

### Stackable Discounts

When `isStackable = true`:
- Can combine with other stackable discounts
- Applied in order of `priority`
- Each discount applies to the remaining amount

## Manual Discounts

For on-the-fly discounts not pre-configured:

```typescript
await applyManualDiscount(
  orderId,
  'PERCENTAGE',
  15,  // 15% off
  'Customer complaint resolution',
  staffId,
  managerId  // Optional: for approval
)
```

Manual discounts:
- Don't require a pre-existing `Discount` record
- Set `isManual = true` on `OrderDiscount`
- Can be PERCENTAGE, FIXED_AMOUNT, or COMP
- COMP requires `authorizedById` (manager approval)

## Comp (Complimentary) Discounts

Comps are 100% discounts requiring manager approval:

```typescript
// Comp configuration
{
  type: "COMP",
  value: 100,
  scope: "ORDER",
  requiresApproval: true  // Must have authorizedById
}

// Applying a comp
await applyDiscountToOrder(
  orderId,
  compDiscount,
  staffId,      // appliedById
  managerId     // authorizedById (required)
)
```

## Customer Group Discounts

### Setup

1. Create `CustomerGroup` (e.g., "VIP Members")
2. Assign customers to the group
3. Create discount with `customerGroupId`
4. Set `scope: CUSTOMER_GROUP` for auto-apply to entire order

### Alternative: CustomerDiscount

Direct discount assignment to individual customers:

```prisma
model CustomerDiscount {
  customerId String
  discountId String
  validFrom  DateTime?
  validUntil DateTime?
  maxUses    Int?
  usageCount Int @default(0)
  active     Boolean @default(true)
}
```

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `Discount already applied` | Same discount applied twice | Check `orderDiscounts` before applying |
| `Requires manager approval` | Comp without `authorizedById` | Provide manager authorization |
| `Percentage must be 0-100` | Invalid percentage value | Validate before applying |
| `Order not found` | Invalid orderId | Verify order exists |

## Testing Scenarios

### Manual Testing

1. **Percentage discount:**
   - Create 10% order discount
   - Add items totaling $100
   - Verify discount = $10

2. **BOGO:**
   - Create "Buy 2 Get 1 Free" discount
   - Add 3 items at $20 each
   - Verify discount = $20 (cheapest free)

3. **Time-based:**
   - Create happy hour discount (16:00-19:00)
   - Test at 15:00 → not applied
   - Test at 17:00 → applied

4. **Stacking:**
   - Create non-stackable 10% discount
   - Create non-stackable 15% discount
   - Verify only highest priority applies

### Database Verification

```sql
-- Check applied discounts on an order
SELECT
  od.name,
  od.type,
  od.value,
  od.amount,
  od."isAutomatic",
  od."isComp",
  sv_applied.staff->'firstName' as applied_by,
  sv_auth.staff->'firstName' as authorized_by
FROM "OrderDiscount" od
LEFT JOIN "StaffVenue" sv_applied ON od."appliedById" = sv_applied.id
LEFT JOIN "StaffVenue" sv_auth ON od."authorizedById" = sv_auth.id
WHERE od."orderId" = 'your-order-id';

-- Check eligible discounts for a venue
SELECT
  d.name,
  d.type,
  d.scope,
  d.value,
  d."isAutomatic",
  d."validFrom",
  d."validUntil",
  d."daysOfWeek",
  d."currentUses",
  d."maxTotalUses"
FROM "Discount" d
WHERE d."venueId" = 'your-venue-id'
  AND d.active = true
ORDER BY d.priority DESC;
```

## Related Files

**Backend:**
- `src/services/dashboard/discountEngine.service.ts` - Core discount logic
- `src/services/dashboard/discount.dashboard.service.ts` - Discount CRUD
- `src/services/tpv/discount.tpv.service.ts` - TPV discount operations
- `prisma/schema.prisma` - Discount, OrderDiscount models

**Dashboard:**
- Discount management page
- Order discount application UI
- Comp approval workflow

**TPV Android:**
- Discount selection UI
- Manual discount entry
- Manager approval flow

## Industry Standards Reference

| Platform | Feature | Key Differences |
|----------|---------|-----------------|
| **Toast** | Discounts & Comps | Requires manager PIN for comps |
| **Square** | Automatic Discounts | Rules-based engine |
| **Clover** | Discounts | Item-level and order-level |
| **Lightspeed** | Promotions | Scheduled campaigns |

## Future Enhancements

1. **Coupon codes:** Integration with `CouponCode` model
2. **Discount analytics:** Track discount usage and revenue impact
3. **A/B testing:** Test discount effectiveness
4. **Loyalty integration:** Earn points with discounts
5. **Geo-fencing:** Location-based discounts
6. **Dynamic pricing:** AI-driven discount suggestions
7. **Discount limits per shift:** Prevent abuse
8. **Comp audit reports:** Track all comps by staff/manager
