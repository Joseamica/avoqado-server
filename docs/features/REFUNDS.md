# Refunds System

## Overview

The Refunds system enables processing of full or partial refunds for completed card payments via Blumon TPV terminals. Refunds create
negative payment records for accurate financial tracking and generate digital receipts for customer reference.

## Business Context

**Key Use Cases:**

- Customer returns merchandise
- Order cancellation after payment
- Price adjustments (partial refund)
- Error correction (wrong amount charged)
- Duplicate payment reversal

**Mexican Market Context:**

- Refunds are processed via card present (TPV terminal)
- Uses Blumon's `CancelIcc` SDK function
- Requires original transaction reference for tracking

## Architecture

### Refund Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Refund Processing Flow                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. TPV App → User selects original payment to refund               │
│                                                                      │
│  2. TPV App → Calls Blumon CancelIcc SDK                            │
│     └── Returns authorizationNumber, referenceNumber                │
│                                                                      │
│  3. TPV App → POST /api/v1/tpv/venues/:venueId/refunds              │
│     └── Sends: originalPaymentId, amount, blumon data               │
│                                                                      │
│  4. Backend → Validates original payment                            │
│     └── Checks: exists, completed, belongs to venue                 │
│     └── Validates: refund amount ≤ remaining refundable             │
│                                                                      │
│  5. Backend → Creates refund Payment (type=REFUND, amount negative) │
│     └── Links to original order                                      │
│     └── Creates TransactionCost (negative for reporting)            │
│                                                                      │
│  6. Backend → Updates original payment processorData                │
│     └── Tracks: refundedAmount, refundHistory                       │
│                                                                      │
│  7. Backend → Generates digital receipt                             │
│     └── Returns receiptUrl with ?refund=true flag                   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Database Model

### Payment (Refund Record)

Refunds are stored as `Payment` records with `type = REFUND`:

```prisma
model Payment {
  type PaymentType @default(PAYMENT)  // PAYMENT | REFUND | FAST

  // For refunds, amount is NEGATIVE
  amount Decimal @db.Decimal(12, 2)

  // processorData stores refund tracking
  processorData Json?  // { originalPaymentId, refundReason, ... }
}
```

### Original Payment processorData

After a refund, the original payment's `processorData` is updated:

```typescript
{
  // ... existing data ...
  refundedAmount: 150.00,        // Cumulative refunded amount
  lastRefundId: "pay_refund_123",
  refundHistory: [
    {
      refundId: "pay_refund_123",
      amount: 150.00,
      reason: "CUSTOMER_REQUEST",
      staffId: "staff_abc",
      timestamp: "2025-01-06T14:30:00Z"
    }
  ]
}
```

### TPV Payments History Fields

When TPV calls **payment history**, the backend returns:

- `refundedAmount` (string) → derived from `processorData.refundedAmount`
- `isFullyRefunded` (boolean) → derived from `refundedAmount >= (amount + tipAmount)`

This allows the TPV to clamp the refundable amount and prevent over‑refund errors.

### PaymentType Enum

```prisma
enum PaymentType {
  PAYMENT   // Standard payment
  REFUND    // Refund (negative amount)
  FAST      // Fast payment (no order)
}
```

## Service Layer

**File:** `src/services/tpv/refund.tpv.service.ts`

### Main Function

```typescript
export async function recordRefund(venueId: string, refundData: RefundRequestData, userId?: string, orgId?: string): Promise<RefundResponse>
```

### Request Interface

```typescript
interface RefundRequestData {
  venueId: string
  originalPaymentId: string
  originalOrderId?: string | null
  amount: number // In cents (5000 = $50.00)
  reason: string // RefundReason.name
  staffId: string
  shiftId?: string | null
  merchantAccountId?: string | null // Multi-merchant routing
  blumonSerialNumber: string
  authorizationNumber: string // From Blumon CancelIcc
  referenceNumber: string // From Blumon CancelIcc
  maskedPan?: string | null
  cardBrand?: string | null
  entryMode?: string | null
  isPartialRefund: boolean
  currency: string
}
```

### Response Interface

```typescript
interface RefundResponse {
  id: string
  originalPaymentId: string
  amount: number // In pesos (positive for display)
  status: string
  authorizationNumber?: string | null
  referenceNumber?: string | null
  digitalReceipt?: {
    id: string
    accessKey: string
    receiptUrl: string // Includes ?refund=true flag
  } | null
}
```

## Implementation Details

### Step 1: Validate Original Payment

```typescript
const originalPayment = await prisma.payment.findUnique({
  where: { id: refundData.originalPaymentId },
})

// Validation checks
if (!originalPayment) throw new NotFoundError('Payment not found')
if (originalPayment.venueId !== venueId) throw new BadRequestError('Payment does not belong to venue')
if (originalPayment.status !== 'COMPLETED') throw new BadRequestError('Cannot refund non-completed payment')
```

### Step 2: Validate Refund Amount

Supports partial refunds with tracking:

```typescript
const refundAmountInPesos = refundData.amount / 100
const originalAmountNumber = Number(originalPayment.amount)

// Get already refunded amount
const processorData = originalPayment.processorData || {}
const alreadyRefunded = Number(processorData.refundedAmount || 0)
const remainingRefundable = originalAmountNumber - alreadyRefunded

if (refundAmountInPesos > remainingRefundable) {
  throw new BadRequestError(`Refund amount (${refundAmountInPesos}) exceeds remaining refundable amount (${remainingRefundable})`)
}
```

### Step 3: Create Refund Record (Transaction)

```typescript
const refundPayment = await tx.payment.create({
  data: {
    venueId,
    orderId: originalPayment.orderId,
    shiftId: shiftId || undefined,
    processedById: refundData.staffId,
    merchantAccountId: refundData.merchantAccountId || originalPayment.merchantAccountId,

    // ⚠️ NEGATIVE AMOUNT
    amount: new Decimal(-refundAmountInPesos),
    tipAmount: new Decimal(0),

    method: originalPayment.method,
    source: originalPayment.source,
    status: TransactionStatus.COMPLETED,
    type: PaymentType.REFUND,

    processor: 'blumon',
    processorData: {
      originalPaymentId: refundData.originalPaymentId,
      refundReason: refundData.reason,
      isPartialRefund: refundData.isPartialRefund,
    },

    authorizationNumber: refundData.authorizationNumber,
    referenceNumber: refundData.referenceNumber,
    cardBrand: mapCardBrand(refundData.cardBrand),
    maskedPan: refundData.maskedPan,
    entryMode: mapEntryMode(refundData.entryMode),

    // No fees on refunds
    feePercentage: new Decimal(0),
    feeAmount: new Decimal(0),
    netAmount: new Decimal(-refundAmountInPesos),
  },
})
```

### Step 4: Update Original Payment

```typescript
const newRefundedAmount = alreadyRefunded + refundAmountInPesos
const isFullyRefunded = newRefundedAmount >= originalAmountNumber

await tx.payment.update({
  where: { id: refundData.originalPaymentId },
  data: {
    processorData: {
      ...processorData,
      refundedAmount: newRefundedAmount,
      isFullyRefunded,
      lastRefundId: refundPayment.id,
      lastRefundAt: new Date().toISOString(),
      refundHistory: [...existingHistory, newRefundEntry],
    },
  },
})
```

### Step 5: Transaction Cost

Creates negative transaction cost for accurate profit reporting:

```typescript
await createRefundTransactionCost(result.id, refundData.originalPaymentId)
```

### Step 6: Digital Receipt

```typescript
const receipt = await generateDigitalReceipt(result.id)
digitalReceipt = {
  id: receipt.id,
  accessKey: receipt.accessKey,
  // ?refund=true for frontend styling
  receiptUrl: `${FRONTEND_URL}/receipts/public/${receipt.accessKey}?refund=true`,
}
```

## API Endpoint

```
POST /api/v1/tpv/venues/:venueId/refunds
```

### Request Body

```json
{
  "originalPaymentId": "pay_abc123",
  "amount": 15000,
  "reason": "CUSTOMER_REQUEST",
  "staffId": "staff_xyz",
  "shiftId": "shift_123",
  "blumonSerialNumber": "PAX-001234",
  "authorizationNumber": "AUTH123456",
  "referenceNumber": "REF789012",
  "maskedPan": "****1234",
  "cardBrand": "VISA",
  "entryMode": "CHIP",
  "isPartialRefund": false,
  "currency": "MXN"
}
```

### Response

```json
{
  "id": "pay_refund_456",
  "originalPaymentId": "pay_abc123",
  "amount": 150.0,
  "status": "COMPLETED",
  "authorizationNumber": "AUTH123456",
  "referenceNumber": "REF789012",
  "digitalReceipt": {
    "id": "rcpt_789",
    "accessKey": "clrcp_abc",
    "receiptUrl": "https://dashboard.avoqado.io/receipts/public/clrcp_abc?refund=true"
  }
}
```

## Multi-Merchant Routing

**Critical:** Refunds MUST be processed by the same merchant account that processed the original payment.

```typescript
// Use original payment's merchantAccountId if not provided
merchantAccountId: refundData.merchantAccountId || originalPayment.merchantAccountId
```

This ensures:

- Card network routing to correct processor
- Reconciliation with original settlement
- Compliance with Blumon multi-merchant setup

## Error Handling

| Error                                  | Cause                     | HTTP Status |
| -------------------------------------- | ------------------------- | ----------- |
| `Payment not found`                    | Invalid originalPaymentId | 404         |
| `Payment does not belong to venue`     | Security violation        | 400         |
| `Cannot refund payment with status: X` | Non-completed payment     | 400         |
| `Refund amount exceeds remaining`      | Over-refund attempt       | 400         |

## Refund Reasons

Standard refund reason codes:

```typescript
enum RefundReason {
  CUSTOMER_REQUEST = 'CUSTOMER_REQUEST',
  DUPLICATE = 'DUPLICATE',
  FRAUDULENT = 'FRAUDULENT',
  PRODUCT_RETURN = 'PRODUCT_RETURN',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  PRICE_ADJUSTMENT = 'PRICE_ADJUSTMENT',
  OTHER = 'OTHER',
}
```

## Testing Scenarios

### Manual Testing

1. **Full refund:**

   - Process $100 payment
   - Refund $100
   - Verify `isFullyRefunded = true`

2. **Partial refund:**

   - Process $100 payment
   - Refund $30
   - Verify `refundedAmount = 30`, `remainingRefundable = 70`
   - Refund $70
   - Verify `isFullyRefunded = true`

3. **Over-refund prevention:**

   - Process $100 payment
   - Try to refund $150
   - Should fail with error

4. **Multi-refund tracking:**
   - Refund multiple times
   - Verify `refundHistory` array grows

### Database Verification

```sql
-- Check refund payments for an order
SELECT
  p.id,
  p.type,
  p.amount,
  p.status,
  p."authorizationNumber",
  p."processorData"->>'originalPaymentId' as original_payment
FROM "Payment" p
WHERE p."orderId" = 'your-order-id'
  AND p.type = 'REFUND';

-- Check original payment's refund tracking
SELECT
  p.id,
  p.amount,
  p."processorData"->>'refundedAmount' as refunded,
  p."processorData"->>'isFullyRefunded' as fully_refunded,
  jsonb_array_length(p."processorData"->'refundHistory') as refund_count
FROM "Payment" p
WHERE p.id = 'original-payment-id';
```

## Related Files

**Backend:**

- `src/services/tpv/refund.tpv.service.ts` - Main refund logic
- `src/services/payments/transactionCost.service.ts` - `createRefundTransactionCost()`
- `src/services/tpv/digitalReceipt.tpv.service.ts` - Receipt generation
- `src/controllers/tpv/refund.tpv.controller.ts` - API handler
- `src/routes/tpv.routes.ts` - Route definition

**TPV Android:**

- Blumon SDK `CancelIcc` integration
- Refund flow UI (select payment, enter amount)
- Receipt printing for refunds

## Industry Standards Reference

| Platform   | Feature         | Key Differences                                    |
| ---------- | --------------- | -------------------------------------------------- |
| **Stripe** | `refund` object | Separate from charges, linked via `charge_id`      |
| **Square** | `refund`        | Linked to payment via `payment_id`                 |
| **Toast**  | Refund          | In-order void vs post-settlement refund            |
| **Clover** | Refund          | Same pattern - negative payment linked to original |

## Future Enhancements

1. **Void vs Refund:** Pre-settlement void (same-day) vs post-settlement refund
2. **Refund approval workflow:** Manager approval for large refunds
3. **Refund limits:** Configure max refund amounts per role
4. **Automatic inventory restoration:** Return refunded items to stock
5. **Refund notifications:** Email customer when refund is processed
6. **Refund reports:** Daily/weekly refund summary by reason
