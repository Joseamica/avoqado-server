# Split Payments System

## Overview

The Split Payments system enables customers to divide a single order's payment across multiple transactions. This is an industry-standard
feature found in Toast, Square, and other POS systems, essential for group dining and table service scenarios.

## Business Context

**Common Use Cases:**

- **Group dining**: Multiple diners splitting a restaurant bill
- **Per-product payment**: Each person pays for their specific items
- **Equal split**: Dividing the total equally among party members
- **Custom amounts**: Arbitrary payment amounts (e.g., "I'll pay $50")

## Split Types

### SplitType Enum

```prisma
enum SplitType {
  PERPRODUCT    // Pay for specific products (recommended for restaurants)
  EQUALPARTS    // Split equally among party members
  CUSTOMAMOUNT  // Custom payment amount (flexible)
  FULLPAYMENT   // Pay the entire bill (default)
}
```

| Type           | Description                  | Use Case                                |
| -------------- | ---------------------------- | --------------------------------------- |
| `PERPRODUCT`   | Pay for specific order items | "I'll pay for my burger and beer"       |
| `EQUALPARTS`   | Divide total by party size   | "Split the $100 bill 4 ways = $25 each" |
| `CUSTOMAMOUNT` | Pay any arbitrary amount     | "I'll pay $50, you cover the rest"      |
| `FULLPAYMENT`  | Pay entire remaining balance | Single payer or final payment           |

## Architecture

### Database Models

**Order.splitType** - Tracks which split method was chosen for the order:

```prisma
model Order {
  splitType SplitType?  // Set on first split payment, null = not split
  // ...
}
```

**Payment.splitType** - Audit trail for each individual payment:

```prisma
model Payment {
  splitType SplitType @default(FULLPAYMENT)
  // ...
}
```

**PaymentAllocation** - Links payments to specific order items:

```prisma
model PaymentAllocation {
  id          String    @id @default(cuid())
  paymentId   String
  payment     Payment   @relation(...)

  // What this allocation covers
  orderItemId String?   // Specific item (PERPRODUCT)
  orderItem   OrderItem? @relation(...)
  orderId     String    // Always linked to order
  order       Order     @relation(...)

  amount      Decimal   @db.Decimal(12, 2)  // Portion of payment

  @@index([paymentId])
  @@index([orderItemId])
  @@index([orderId])
}
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Split Payment Flow                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. TPV App → User selects split type                               │
│                                                                      │
│  2. PERPRODUCT:                                                      │
│     └── User taps items they want to pay for                        │
│     └── paidProductsId[] sent to backend                            │
│                                                                      │
│  3. EQUALPARTS:                                                      │
│     └── User enters party size (e.g., 4 people)                     │
│     └── User selects how many "shares" to pay (e.g., 2 shares)      │
│     └── equalPartsPartySize + equalPartsPayedFor sent               │
│                                                                      │
│  4. CUSTOMAMOUNT:                                                    │
│     └── User enters arbitrary amount                                 │
│     └── Only amount is sent, no product selection                   │
│                                                                      │
│  5. Backend → Creates Payment + PaymentAllocations                  │
│                                                                      │
│  6. Backend → Updates Order.paidAmount, remainingBalance            │
│                                                                      │
│  7. Repeat until Order.remainingBalance = 0                         │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Business Rules

### Split Type Transition Rules

Once an order has a split type, only certain transitions are allowed:

```typescript
const allowedTransitions = {
  PERPRODUCT: ['PERPRODUCT', 'FULLPAYMENT'], // Continue same or finish
  EQUALPARTS: ['EQUALPARTS', 'FULLPAYMENT'], // Continue same or finish
  CUSTOMAMOUNT: ['PERPRODUCT', 'EQUALPARTS', 'CUSTOMAMOUNT', 'FULLPAYMENT'], // Most flexible
  FULLPAYMENT: ['FULLPAYMENT'], // Order should be done
}
```

**Example scenarios:**

- Order started with PERPRODUCT → Can continue with PERPRODUCT or finish with FULLPAYMENT
- Order started with CUSTOMAMOUNT → Can switch to any method
- Order started with FULLPAYMENT → Should already be completed

### Validation Logic

Located in `recordOrderPayment()` function:

```typescript
// Validate splitType business logic
if (activeOrder.splitType && activeOrder.splitType !== paymentData.splitType) {
  const allowedMethods = allowedTransitions[activeOrder.splitType] || []

  if (!allowedMethods.includes(paymentData.splitType)) {
    throw new BadRequestError(
      `Order has splitType ${activeOrder.splitType}. Cannot use ${paymentData.splitType}. ` +
        `Allowed methods: ${allowedMethods.join(', ')}`,
    )
  }
}
```

## Implementation Details

### Backend Service

**File:** `src/services/tpv/payment.tpv.service.ts`

**Key function:** `recordOrderPayment()`

```typescript
export async function recordOrderPayment(
  venueId: string,
  orderId: string,
  paymentData: PaymentCreationData,
  userId?: string,
  _orgId?: string,
)
```

**PaymentCreationData interface:**

```typescript
interface PaymentCreationData {
  splitType: 'PERPRODUCT' | 'EQUALPARTS' | 'CUSTOMAMOUNT' | 'FULLPAYMENT'
  paidProductsId: string[] // For PERPRODUCT
  equalPartsPartySize?: number // For EQUALPARTS
  equalPartsPayedFor?: number // For EQUALPARTS
  // ... other payment fields
}
```

### Payment Allocation Creation

The allocation logic depends on split type:

```typescript
// Inside transaction
if (paymentData.splitType === 'PERPRODUCT' && paymentData.paidProductsId.length > 0) {
  // Create allocations for specific products
  const orderItems = activeOrder.items.filter((item: any) => paymentData.paidProductsId.includes(item.id))

  for (const item of orderItems) {
    await tx.paymentAllocation.create({
      data: {
        paymentId: newPayment.id,
        orderItemId: item.id,
        orderId: activeOrder.id,
        amount: item.total, // Full item amount
      },
    })
  }
} else {
  // For other split types, create general allocation to order
  await tx.paymentAllocation.create({
    data: {
      paymentId: newPayment.id,
      orderId: activeOrder.id,
      amount: totalAmount + tipAmount,
    },
  })
}
```

### Inventory Validation Integration

**Critical:** Items with PaymentAllocations are considered "paid" for inventory validation purposes. This prevents double-validation on
split payments:

```typescript
// Only validate items that haven't been paid yet (no paymentAllocations)
const unpaidItems = order.items.filter(item => !item.paymentAllocations || item.paymentAllocations.length === 0)
```

## TPV Android Integration

The Android TPV app sends split payment data in the payment request:

```json
{
  "amount": 5000,
  "tip": 500,
  "splitType": "PERPRODUCT",
  "paidProductsId": ["item-id-1", "item-id-2"]
  // ... card data
}
```

For equal parts:

```json
{
  "amount": 2500,
  "tip": 0,
  "splitType": "EQUALPARTS",
  "equalPartsPartySize": 4,
  "equalPartsPayedFor": 1
  // ... card data
}
```

## Order Totals Tracking

Split payments update order totals in real-time:

```typescript
// Update order totals
await prisma.order.update({
  where: { id: orderId },
  data: {
    paymentStatus: isFullyPaid ? 'PAID' : 'PARTIAL',
    paidAmount: totalPaid,
    remainingBalance: remainingAmount,
    ...(isFullyPaid && {
      status: 'COMPLETED',
      completedAt: new Date(),
    }),
  },
})
```

**Order fields for split tracking:**

- `paidAmount` - Total paid across all payments
- `remainingBalance` - Amount still owed
- `paymentStatus` - PENDING | PARTIAL | PAID
- `splitType` - Set on first split payment

## Error Handling

### Common Errors

| Error                                            | Cause                         | Solution                                 |
| ------------------------------------------------ | ----------------------------- | ---------------------------------------- |
| `Order has splitType X. Cannot use Y`            | Invalid split type transition | Use allowed transition (see rules above) |
| `Cannot complete order - insufficient inventory` | Pre-flight validation failed  | Check stock levels                       |
| `Order not found in venue`                       | Invalid orderId               | Verify order exists and belongs to venue |

### Idempotency

Payments use `referenceNumber` for idempotency to prevent duplicates during retries:

```typescript
if (paymentData.referenceNumber) {
  const existingPayment = await prisma.payment.findFirst({
    where: {
      venueId,
      referenceNumber: paymentData.referenceNumber,
    },
  })

  if (existingPayment) {
    logger.info('Idempotent payment detected, returning existing payment')
    return existingPayment // Safe retry
  }
}
```

## Testing Scenarios

### Manual Testing

1. **PERPRODUCT split:**

   - Create order with 3 items
   - Pay for 1 item → Order.paymentStatus = PARTIAL
   - Pay for remaining 2 items → Order.paymentStatus = PAID

2. **EQUALPARTS split:**

   - Create order for $100
   - Pay $25 (1 of 4 shares) → remainingBalance = $75
   - Pay $25 × 3 more times → Order completed

3. **CUSTOMAMOUNT split:**

   - Create order for $100
   - Pay $60 (arbitrary) → remainingBalance = $40
   - Pay $40 (remaining) → Order completed

4. **Transition validation:**
   - Start with PERPRODUCT → Try EQUALPARTS → Should fail
   - Start with CUSTOMAMOUNT → Try PERPRODUCT → Should succeed

### Database Verification

```sql
-- Check payment allocations for an order
SELECT
  p.id as payment_id,
  p.amount,
  p."splitType",
  pa."orderItemId",
  pa.amount as allocation_amount
FROM "Payment" p
LEFT JOIN "PaymentAllocation" pa ON pa."paymentId" = p.id
WHERE p."orderId" = 'your-order-id';

-- Check order split status
SELECT
  id,
  "splitType",
  "paidAmount",
  "remainingBalance",
  "paymentStatus"
FROM "Order"
WHERE id = 'your-order-id';
```

## Related Files

**Backend:**

- `prisma/schema.prisma` - SplitType enum, PaymentAllocation model
- `src/services/tpv/payment.tpv.service.ts` - `recordOrderPayment()` function
- `src/schemas/tpv/payment.schema.ts` - Validation schemas

**TPV Android:**

- Split UI components in payment flow
- Payment request builder with split data

## Industry Standards Reference

| Platform   | Split Support           | Implementation                  |
| ---------- | ----------------------- | ------------------------------- |
| **Toast**  | Per-item, equal, custom | Similar PaymentAllocation model |
| **Square** | Equal split, itemized   | "Split Tender" feature          |
| **Stripe** | Via payment intents     | Application fee splitting       |
| **Clover** | Per-item, equal         | "Split Bill" tender             |

## Future Enhancements

1. **Tip splitting** - Split tip amount among multiple payments
2. **Split by seat** - Assign items to seats, auto-split by seat
3. **Group payment links** - Send payment links to each diner
4. **Split history** - Track who paid what for analytics
