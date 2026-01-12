# Cash Closeout System (Cortes de Caja)

## Overview

The Cash Closeout system enables venues to track expected vs actual cash amounts when they deposit or store cash. This is an
industry-standard feature for restaurants, retail, and hotels, critical for financial reconciliation and loss prevention.

## Business Context

**Key Use Cases:**

- End-of-shift cash reconciliation (arqueo de caja)
- Daily cash deposits to bank
- Cash variance detection and investigation
- Shift-over handoffs (leaving cash for next shift)
- Owner/manager cash withdrawals

**Mexican Business Practice:** In Mexico, "cortes de caja" are typically done:

- At end of each shift
- At end of business day
- Before bank deposits
- During owner/manager spot checks

## Related Systems

### Cash Closeout vs Shift Close

| System            | Scope              | Purpose                                                        |
| ----------------- | ------------------ | -------------------------------------------------------------- |
| **Cash Closeout** | Cash payments only | Track expected vs actual cash, deposit methods                 |
| **Shift Close**   | All payments       | Full shift report (cash + cards + vouchers), staff performance |

**Cash Closeout** is venue-level and independent of shifts. **Shift Close** is per-staff and includes all payment methods.

## Database Model

### CashCloseout

```prisma
model CashCloseout {
  id      String @id @default(cuid())
  venueId String
  venue   Venue  @relation(...)

  // Period tracking
  periodStart DateTime  // Start of cash period (last closeout or venue creation)
  periodEnd   DateTime  // When closeout was made

  // Expected vs Actual
  expectedAmount  Decimal @db.Decimal(12, 2)  // Sum of CASH payments
  actualAmount    Decimal @db.Decimal(12, 2)  // User counted
  variance        Decimal @db.Decimal(12, 2)  // actual - expected
  variancePercent Decimal? @db.Decimal(5, 2)  // For warnings

  // Deposit details
  depositMethod DepositMethod @default(BANK_DEPOSIT)
  bankReference String?       // Bank receipt number
  notes         String?       @db.Text

  // Staff tracking
  closedById String
  closedBy   Staff  @relation("CashCloseoutClosedBy", ...)

  @@index([venueId])
  @@index([venueId, createdAt])
}
```

### DepositMethod Enum

```prisma
enum DepositMethod {
  BANK_DEPOSIT      // Cash deposited to bank account
  SAFE              // Cash stored in venue safe
  OWNER_WITHDRAWAL  // Owner took the cash
  NEXT_SHIFT        // Left as starting bank for next shift
}
```

## Architecture

### Service Layer

**File:** `src/services/dashboard/cashCloseout.dashboard.service.ts`

**Exported Functions:**

```typescript
export async function getLastCloseoutDate(venueId: string): Promise<Date>
export async function getExpectedCashAmount(venueId: string): Promise<ExpectedCashResult>
export async function createCashCloseout(venueId: string, data: CloseoutData, closedById: string)
export async function getCloseoutHistory(venueId: string, page: number, pageSize: number)
export async function getCloseoutById(venueId: string, closeoutId: string)
```

### Period Calculation

The system automatically calculates the period start:

```typescript
async function getLastCloseoutDate(venueId: string): Promise<Date> {
  const lastCloseout = await prisma.cashCloseout.findFirst({
    where: { venueId },
    orderBy: { createdAt: 'desc' },
    select: { periodEnd: true },
  })

  if (lastCloseout) {
    return lastCloseout.periodEnd // Continue from last closeout
  }

  // No closeouts yet - use venue creation date
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { createdAt: true },
  })

  return venue?.createdAt || new Date()
}
```

### Expected Amount Calculation

```typescript
async function getExpectedCashAmount(venueId: string): Promise<{
  expectedAmount: number
  periodStart: Date
  transactionCount: number
  daysSinceLastCloseout: number
  hasCloseouts: boolean
}> {
  const periodStart = await getLastCloseoutDate(venueId)

  // Sum all CASH payments since last closeout
  const cashPayments = await prisma.payment.findMany({
    where: {
      venueId,
      method: PaymentMethod.CASH,
      status: 'COMPLETED',
      createdAt: { gt: periodStart },
    },
    select: { amount: true },
  })

  const expectedAmount = cashPayments.reduce((sum, p) => sum + Number(p.amount), 0)

  return {
    expectedAmount,
    periodStart,
    transactionCount: cashPayments.length,
    daysSinceLastCloseout: Math.floor((Date.now() - periodStart.getTime()) / (1000 * 60 * 60 * 24)),
    hasCloseouts: !!lastCloseout,
  }
}
```

### Variance Calculation

```typescript
const variance = actualAmount - expectedAmount

// Positive variance = OVERAGE (more cash than expected)
// Negative variance = SHORTAGE (less cash than expected)

// Variance percent (clamped for database)
let variancePercent: number | null = null
if (expectedAmount > 0) {
  const rawPercent = (variance / expectedAmount) * 100
  variancePercent = Math.max(-999.99, Math.min(999.99, rawPercent))
}
```

## API Endpoints

```
GET    /api/v1/dashboard/venues/:venueId/cash-closeouts
GET    /api/v1/dashboard/venues/:venueId/cash-closeouts/expected
GET    /api/v1/dashboard/venues/:venueId/cash-closeouts/:id
POST   /api/v1/dashboard/venues/:venueId/cash-closeouts
```

### Request: Create Closeout

```json
POST /api/v1/dashboard/venues/:venueId/cash-closeouts
{
  "actualAmount": 15250.00,
  "depositMethod": "BANK_DEPOSIT",
  "bankReference": "DEP-2025-0106-001",
  "notes": "Cash deposit to Banamex account ending 1234"
}
```

### Response

```json
{
  "id": "clout_abc123",
  "venueId": "venue_xyz",
  "periodStart": "2025-01-05T06:00:00.000Z",
  "periodEnd": "2025-01-06T22:00:00.000Z",
  "expectedAmount": 15000.0,
  "actualAmount": 15250.0,
  "variance": 250.0,
  "variancePercent": 1.67,
  "depositMethod": "BANK_DEPOSIT",
  "bankReference": "DEP-2025-0106-001",
  "notes": "Cash deposit to Banamex account",
  "closedBy": {
    "id": "staff_123",
    "firstName": "Maria",
    "lastName": "Garcia"
  },
  "createdAt": "2025-01-06T22:00:00.000Z"
}
```

## Variance Interpretation

| Variance       | Amount | Interpretation              | Action Required                               |
| -------------- | ------ | --------------------------- | --------------------------------------------- |
| Positive       | +$50   | Overage - more cash counted | Verify no errors, may indicate pricing issues |
| Zero           | $0     | Perfect match               | Ideal outcome                                 |
| Small Negative | -$10   | Minor shortage              | Document, investigate if recurring            |
| Large Negative | -$500  | Significant shortage        | Immediate investigation, possible theft       |

### Warning Thresholds (Configurable)

```typescript
const VARIANCE_THRESHOLDS = {
  WARNING: 0.02, // 2% - Yellow alert
  CRITICAL: 0.05, // 5% - Red alert, requires manager approval
}
```

## Shift Management Integration

### Shift Model (Related)

```prisma
model Shift {
  // Cash management
  startingCash   Decimal @default(0) @db.Decimal(10, 2)
  endingCash     Decimal? @db.Decimal(10, 2)
  cashDifference Decimal? @db.Decimal(10, 2)

  // Cash reconciliation
  cashDeclared     Decimal? @db.Decimal(10, 2)
  cardDeclared     Decimal? @db.Decimal(10, 2)
  vouchersDeclared Decimal? @db.Decimal(10, 2)
  otherDeclared    Decimal? @db.Decimal(10, 2)

  // Auto-calculated totals
  totalCashPayments    Decimal @default(0) @db.Decimal(12, 2)
  totalCardPayments    Decimal @default(0) @db.Decimal(12, 2)
  totalVoucherPayments Decimal @default(0) @db.Decimal(12, 2)
  totalOtherPayments   Decimal @default(0) @db.Decimal(12, 2)
}
```

### Real-Time Shift Totals

The shift service calculates totals dynamically:

```typescript
export async function getCurrentShift(venueId: string): Promise<Shift | null> {
  const shift = await prisma.shift.findFirst({
    where: { venueId, endTime: null },
  })

  // Calculate from actual payments
  const shiftPayments = await prisma.payment.findMany({
    where: { shiftId: shift.id, status: 'COMPLETED' },
  })

  shiftPayments.forEach(payment => {
    switch (payment.method) {
      case 'CASH':
        totalCashPayments = totalCashPayments.add(amount)
        break
      case 'CREDIT_CARD':
      case 'DEBIT_CARD':
        totalCardPayments = totalCardPayments.add(amount)
        break
      // ...
    }
  })

  return { ...shift, totalCashPayments, totalCardPayments, ... }
}
```

## Testing Scenarios

### Manual Testing

1. **First closeout (no history):**

   - Make cash payments
   - Create closeout
   - Verify periodStart = venue creation date

2. **Subsequent closeout:**

   - Make more cash payments
   - Create closeout
   - Verify periodStart = last closeout's periodEnd

3. **Variance scenarios:**

   - Enter actual = expected (zero variance)
   - Enter actual > expected (overage)
   - Enter actual < expected (shortage)

4. **Deposit methods:**
   - Test each DepositMethod enum value
   - Verify bank reference is optional

### Database Verification

```sql
-- Check closeout history
SELECT
  id,
  "periodStart",
  "periodEnd",
  "expectedAmount",
  "actualAmount",
  variance,
  "variancePercent",
  "depositMethod"
FROM "CashCloseout"
WHERE "venueId" = 'your-venue-id'
ORDER BY "createdAt" DESC;

-- Verify expected calculation
SELECT
  SUM(amount) as expected_cash
FROM "Payment"
WHERE "venueId" = 'your-venue-id'
  AND method = 'CASH'
  AND status = 'COMPLETED'
  AND "createdAt" > '2025-01-05T06:00:00Z';  -- periodStart
```

## Related Files

**Backend:**

- `prisma/schema.prisma` - CashCloseout model, DepositMethod enum
- `src/services/dashboard/cashCloseout.dashboard.service.ts` - Business logic
- `src/services/tpv/shift.tpv.service.ts` - Shift management with cash tracking
- `src/controllers/dashboard/cashCloseout.dashboard.controller.ts` - API handlers
- `src/routes/dashboard.routes.ts` - Route definitions

**Dashboard:**

- Cash closeout page with expected amount display
- Closeout history table with variance highlighting

## Industry Standards Reference

| Platform       | Feature Name            | Key Differences                              |
| -------------- | ----------------------- | -------------------------------------------- |
| **Toast**      | End of Day Drawer Count | Per-drawer, with bill denomination breakdown |
| **Square**     | Cash Drawer Report      | Shift-based, supports multiple drawers       |
| **Clover**     | Cash Closeout           | Supports safe drops during shift             |
| **Lightspeed** | Cash Management         | Daily reconciliation with variance alerts    |

## Future Enhancements

1. **Bill denomination counting:**

   ```json
   {
     "denominations": {
       "1000": 5, // 5 × $1000 bills
       "500": 3,
       "200": 10,
       "100": 5,
       "50": 4,
       "20": 3
     }
   }
   ```

2. **Safe drop tracking:** Allow mid-shift deposits to safe

3. **Multi-drawer support:** Track cash per TPV terminal

4. **Variance alerts:** Automatic notifications for threshold breaches

5. **Photo evidence:** Require photo of counted cash for large amounts

6. **Manager approval:** Require manager signature for large variances
