# Shift Management Implementation Roadmap

## Overview

This document outlines the complete implementation plan for shift management across restaurant and retail contexts, inspired by Toast POS
and Square POS best practices.

**Current Status**: ✅ **FASE 1 COMPLETED** - Basic automatic shift open/close **Timeline**: Multi-phase approach (2-8 weeks per phase)

---

## FASE 1: Basic Automatic Shift Open/Close ✅ COMPLETED

### Implemented Features

- ✅ Open shift with starting cash amount
- ✅ Automatic calculation at shift close:
  - Payment method breakdown (CASH, CARD, VOUCHER, OTHER)
  - Total products sold (quantity from OrderItems)
  - Inventory consumed (from RawMaterialMovements)
  - Tips totals
  - Orders processed
  - Shift duration
- ✅ Report data generation for printing/display
- ✅ Minimal schema changes (7 new fields)

### Schema Changes Made

```prisma
// Added to Shift model
totalCashPayments    Decimal @default(0) @db.Decimal(12, 2)
totalCardPayments    Decimal @default(0) @db.Decimal(12, 2)
totalVoucherPayments Decimal @default(0) @db.Decimal(12, 2)
totalOtherPayments   Decimal @default(0) @db.Decimal(12, 2)
totalProductsSold    Int     @default(0)
inventoryConsumed    Json?   // FIFO batch data
reportData           Json?   // Full breakdown
```

### Migration

`20251112015141_add_shift_automatic_calculation_fields`

---

## FASE 2: Manual Cash Reconciliation (2-3 weeks)

### Goal

Allow cashiers to manually count cash and reconcile against expected amounts

### Features to Implement

#### 2.1 Cash Count Input

- **UI Component**: Bill denomination breakdown screen
  - $100 bills × quantity = subtotal
  - $50 bills × quantity = subtotal
  - $20 bills × quantity = subtotal
  - $10 bills × quantity = subtotal
  - $5 bills × quantity = subtotal
  - $1 bills × quantity = subtotal
  - Coins breakdown
  - **Auto-calculate total**

#### 2.2 Variance Detection

```typescript
enum VarianceStatus {
  EXACT      // Actual === Expected
  OVER       // Actual > Expected
  SHORT      // Actual < Expected
}

interface CashReconciliation {
  expectedCash: Decimal       // From automatic calculation
  actualCash: Decimal         // From manual count
  variance: Decimal           // actualCash - expectedCash
  varianceStatus: VarianceStatus
  billBreakdown: Json         // { "100": 5, "50": 10, ... }
  coinBreakdown: Json         // { "25": 40, "10": 50, ... }
  notes: string?              // Cashier explanation for variance
}
```

#### 2.3 Variance Thresholds

- **Acceptable variance**: ±$5 (configurable by venue)
- **Warning variance**: $5-$20
- **Manager approval required**: >$20

#### 2.4 Schema Changes Needed

```prisma
model Shift {
  // ... existing fields ...

  // FASE 2 - Cash Reconciliation
  expectedCash          Decimal? @db.Decimal(12, 2)
  actualCash            Decimal? @db.Decimal(12, 2)
  cashVariance          Decimal? @db.Decimal(12, 2)
  varianceStatus        VarianceStatus?
  billBreakdown         Json?
  coinBreakdown         Json?
  reconciliationNotes   String?
  requiresManagerReview Boolean @default(false)
}

enum VarianceStatus {
  EXACT
  OVER
  SHORT
}
```

---

## FASE 3: Cash Operations (2-3 weeks)

### Goal

Track cash movements beyond sales (drops, payouts, loans)

### Features to Implement

#### 3.1 Cash Operation Types

```typescript
enum CashOperationType {
  CASH_IN      // Adding cash to drawer (loan from manager)
  CASH_OUT     // Removing cash (payout to vendor)
  PAY_OUT      // Paying out expense
  TIP_OUT      // Distributing tips to staff
  CASH_DROP    // Moving excess cash to safe
  NO_SALE      // Opening drawer for non-sale reason
}

interface CashOperation {
  id: string
  shiftId: string
  type: CashOperationType
  amount: Decimal
  reason: string
  performedBy: string      // Staff ID
  approvedBy: string?      // Manager ID (if required)
  timestamp: DateTime
  receiptUrl: string?      // Photo of receipt/voucher
}
```

#### 3.2 Business Rules

- **CASH_DROP**: Auto-triggered when drawer exceeds threshold (e.g., >$500)
- **PAY_OUT**: Requires manager approval
- **TIP_OUT**: Requires destination (which staff member)
- **NO_SALE**: Tracked for audit purposes

#### 3.3 Schema Changes Needed

```prisma
model CashOperation {
  id          String             @id @default(cuid())
  shiftId     String
  shift       Shift              @relation(fields: [shiftId], references: [id])
  type        CashOperationType
  amount      Decimal            @db.Decimal(12, 2)
  reason      String
  performedBy String
  staff       Staff              @relation("PerformedBy", fields: [performedBy], references: [id])
  approvedBy  String?
  approver    Staff?             @relation("ApprovedBy", fields: [approvedBy], references: [id])
  timestamp   DateTime           @default(now())
  receiptUrl  String?
  createdAt   DateTime           @default(now())
  updatedAt   DateTime           @updatedAt
}

enum CashOperationType {
  CASH_IN
  CASH_OUT
  PAY_OUT
  TIP_OUT
  CASH_DROP
  NO_SALE
}

model Shift {
  // ... existing fields ...
  cashOperations CashOperation[]
}
```

#### 3.4 Impact on Cash Reconciliation

```typescript
// Expected cash calculation must include cash operations
expectedCash = startingCash
  + cashSales
  + CASH_IN operations
  - CASH_OUT operations
  - PAY_OUT operations
  - TIP_OUT operations
  - CASH_DROP operations
```

---

## FASE 4: Manager Approval Workflows (1-2 weeks)

### Goal

Require manager approval for sensitive operations and large variances

### Features to Implement

#### 4.1 Approval Requirements

- Cash variance > $20
- PAY_OUT operations
- Voiding orders during shift
- Discounts exceeding threshold
- Shift close with incomplete orders

#### 4.2 Manager Override

```typescript
interface ManagerApproval {
  id: string
  shiftId: string
  requestType: ApprovalType
  requestedBy: string      // Staff ID
  approvedBy: string?      // Manager ID
  status: ApprovalStatus   // PENDING, APPROVED, REJECTED
  reason: string
  requestedAt: DateTime
  respondedAt: DateTime?
  notes: string?
}

enum ApprovalType {
  CASH_VARIANCE
  CASH_OPERATION
  ORDER_VOID
  LARGE_DISCOUNT
  FORCE_CLOSE
}

enum ApprovalStatus {
  PENDING
  APPROVED
  REJECTED
}
```

#### 4.3 Schema Changes Needed

```prisma
model ManagerApproval {
  id          String         @id @default(cuid())
  shiftId     String
  shift       Shift          @relation(fields: [shiftId], references: [id])
  requestType ApprovalType
  requestedBy String
  requester   Staff          @relation("Requester", fields: [requestedBy], references: [id])
  approvedBy  String?
  approver    Staff?         @relation("Approver", fields: [approvedBy], references: [id])
  status      ApprovalStatus @default(PENDING)
  reason      String
  requestedAt DateTime       @default(now())
  respondedAt DateTime?
  notes       String?
}

enum ApprovalType {
  CASH_VARIANCE
  CASH_OPERATION
  ORDER_VOID
  LARGE_DISCOUNT
  FORCE_CLOSE
}

enum ApprovalStatus {
  PENDING
  APPROVED
  REJECTED
}
```

---

## FASE 5: Manual Inventory Count at Shift Close (3-4 weeks)

### Goal

Allow physical inventory count at shift close for retail and critical items

### Features to Implement

#### 5.1 Physical Count Interface

- Select items to count (not all inventory every shift)
- Input actual quantity on hand
- Compare against system expected quantity
- Auto-calculate shrinkage/overage

#### 5.2 Shrinkage Detection

```typescript
interface InventoryCount {
  id: string
  shiftId: string
  rawMaterialId: string
  expectedQuantity: Decimal    // From FIFO system
  actualQuantity: Decimal      // From manual count
  variance: Decimal            // actual - expected
  variancePercentage: Decimal  // (variance / expected) * 100
  varianceReason: ShrinkageReason?
  notes: string?
  countedBy: string            // Staff ID
  countedAt: DateTime
}

enum ShrinkageReason {
  THEFT
  SPOILAGE
  DAMAGE
  MEASUREMENT_ERROR
  SYSTEM_ERROR
  OTHER
}
```

#### 5.3 Business Rules

- **Variance threshold**: >5% requires explanation
- **High-value items**: Always require count at shift close
- **Retail mode**: Count all products at close
- **Restaurant mode**: Count only critical/expensive items

#### 5.4 Schema Changes Needed

```prisma
model InventoryCount {
  id                 String           @id @default(cuid())
  shiftId            String
  shift              Shift            @relation(fields: [shiftId], references: [id])
  rawMaterialId      String
  rawMaterial        RawMaterial      @relation(fields: [rawMaterialId], references: [id])
  expectedQuantity   Decimal          @db.Decimal(12, 3)
  actualQuantity     Decimal          @db.Decimal(12, 3)
  variance           Decimal          @db.Decimal(12, 3)
  variancePercentage Decimal          @db.Decimal(5, 2)
  varianceReason     ShrinkageReason?
  notes              String?
  countedBy          String
  counter            Staff            @relation(fields: [countedBy], references: [id])
  countedAt          DateTime         @default(now())
}

enum ShrinkageReason {
  THEFT
  SPOILAGE
  DAMAGE
  MEASUREMENT_ERROR
  SYSTEM_ERROR
  OTHER
}

model Shift {
  // ... existing fields ...
  inventoryCounts InventoryCount[]
}
```

---

## FASE 6: Retail-Specific Features (3-4 weeks)

### Goal

Add retail-specific shift operations (returns, gift cards, exchanges)

### Features to Implement

#### 6.1 Returns Tracking

```typescript
interface ShiftReturns {
  totalReturns: number
  totalReturnAmount: Decimal
  returnsByReason: {
    DEFECTIVE: number
    WRONG_SIZE: number
    CHANGED_MIND: number
    OTHER: number
  }
  returnProducts: Array<{
    productId: string
    quantity: number
    refundAmount: Decimal
  }>
}
```

#### 6.2 Gift Card Operations

```typescript
interface GiftCardOperation {
  type: 'SALE' | 'REDEMPTION' | 'RELOAD'
  amount: Decimal
  cardNumber: string
  timestamp: DateTime
}

interface ShiftGiftCards {
  totalSold: number
  totalSoldAmount: Decimal
  totalRedeemed: number
  totalRedeemedAmount: Decimal
  totalReloaded: number
  totalReloadedAmount: Decimal
}
```

#### 6.3 Exchanges

```typescript
interface Exchange {
  id: string
  shiftId: string
  originalOrderId: string
  returnedProducts: OrderItem[]
  newProducts: OrderItem[]
  priceDifference: Decimal // Positive = customer pays, Negative = refund
  reason: string
}
```

#### 6.4 Schema Changes Needed

```prisma
model ShiftReturnSummary {
  id                String  @id @default(cuid())
  shiftId           String  @unique
  shift             Shift   @relation(fields: [shiftId], references: [id])
  totalReturns      Int     @default(0)
  totalReturnAmount Decimal @default(0) @db.Decimal(12, 2)
  returnsByReason   Json    // { DEFECTIVE: 5, WRONG_SIZE: 3, ... }
  returnProducts    Json    // Array of products returned
}

model GiftCardOperation {
  id         String              @id @default(cuid())
  shiftId    String
  shift      Shift               @relation(fields: [shiftId], references: [id])
  type       GiftCardOpType
  amount     Decimal             @db.Decimal(12, 2)
  cardNumber String
  timestamp  DateTime            @default(now())
}

enum GiftCardOpType {
  SALE
  REDEMPTION
  RELOAD
}

model Exchange {
  id               String      @id @default(cuid())
  shiftId          String
  shift            Shift       @relation(fields: [shiftId], references: [id])
  originalOrderId  String
  originalOrder    Order       @relation(fields: [originalOrderId], references: [id])
  priceDifference  Decimal     @db.Decimal(12, 2)
  reason           String
  timestamp        DateTime    @default(now())
}
```

---

## FASE 7: Advanced Reporting & Analytics (2-3 weeks)

### Goal

Generate comprehensive shift reports for managers and owners

### Features to Implement

#### 7.1 Shift Summary Report

- Sales by hour breakdown
- Sales by staff member
- Sales by product category
- Payment method distribution
- Average transaction value
- Peak hours identification
- Labor cost vs revenue

#### 7.2 Multi-Shift Comparison

- Compare shifts across days/weeks
- Identify trends (improving/declining performance)
- Benchmark against venue averages
- Staff performance comparison

#### 7.3 Anomaly Detection

- Unusual cash variance patterns
- High void/discount rates
- Low sales during expected peak hours
- Inventory shrinkage patterns

#### 7.4 Export Formats

- PDF shift report (for printing)
- Excel export (for accounting)
- CSV export (for external systems)
- JSON export (for integrations)

---

## FASE 8: Offline Support & Conflict Resolution (4-6 weeks)

### Goal

Handle offline scenarios and concurrent shift edits

### Features to Implement

#### 8.1 Offline Mode

- Cache shift data locally on terminal
- Queue operations when offline
- Sync when connection restored
- Conflict detection on sync

#### 8.2 Conflict Resolution

```typescript
interface ShiftConflict {
  shiftId: string
  field: string           // Which field has conflict
  localValue: any         // Value on terminal
  serverValue: any        // Value on server
  timestamp: DateTime
  resolution: ConflictResolution
}

enum ConflictResolution {
  USE_LOCAL      // Keep terminal value
  USE_SERVER     // Keep server value
  MERGE          // Combine both (for additive fields)
  MANUAL         // Manager decides
}
```

#### 8.3 Business Rules

- **Additive fields**: totalSales, totalOrders → MERGE (sum both)
- **State fields**: status, endTime → USE_SERVER (latest wins)
- **Critical fields**: cashVariance → MANUAL (manager review)

#### 8.4 Technical Implementation

- IndexedDB for offline storage
- WebSocket for real-time sync
- Optimistic UI updates
- Conflict resolution UI for managers

---

## FASE 9: Multi-Terminal Coordination (2-3 weeks)

### Goal

Support multiple terminals operating on same shift

### Features to Implement

#### 9.1 Terminal Assignment

- Each terminal assigned to specific staff member
- Multiple terminals can contribute to same shift
- Terminal-specific cash drawer tracking

#### 9.2 Shift Close Coordination

```typescript
interface MultiTerminalShift {
  shiftId: string
  terminals: Array<{
    terminalId: string
    staffId: string
    startingCash: Decimal
    endingCash: Decimal
    salesContributed: Decimal
    status: 'OPEN' | 'CLOSED'
  }>
  canClose: boolean // All terminals must close first
}
```

#### 9.3 Business Rules

- Shift cannot close until all terminals close
- Each terminal reconciles independently
- Manager sees aggregated view
- Variance tracked per terminal

---

## FASE 10: Integration with POS Systems (3-4 weeks)

### Goal

Sync with external POS systems (Toast, Square, etc.)

### Features to Implement

#### 10.1 Toast Integration

- Import shifts from Toast API
- Sync payment data
- Sync product sales
- Map Toast staff to our Staff model

#### 10.2 Square Integration

- Import shifts from Square API
- Sync transactions
- Sync inventory movements
- Map Square team members

#### 10.3 Bidirectional Sync

- Export our shifts to external systems
- Handle sync failures gracefully
- Detect and resolve conflicts
- Audit trail for all syncs

---

## Technical Debt & Refactoring

### Test Coverage

- ⚠️ Fix test-shift-automatic-close.ts compilation errors:
  - OrderItem `productName` field doesn't exist
  - Payment missing required fields (feePercentage, feeAmount, netAmount)
  - PaymentMethod enum mismatch (CARD vs CREDIT_CARD/DEBIT_CARD)
- Unit tests for all FASE 2+ features
- Integration tests for multi-terminal scenarios
- Load testing for concurrent operations

### Performance Optimization

- Index on Shift.venueId + Shift.status for fast queries
- Index on Payment.shiftId for reconciliation
- Aggregate queries optimization (use raw SQL if needed)
- Cache shift summaries in Redis

### Security

- Role-based access (only managers can approve)
- Audit trail for all sensitive operations
- Encrypted storage for cash drawer amounts
- IP-based terminal verification

---

## Configuration & Customization

### Venue-Level Settings

```typescript
interface ShiftManagementConfig {
  // Cash reconciliation
  enableCashReconciliation: boolean
  acceptableVariance: Decimal // e.g., $5
  managerApprovalThreshold: Decimal // e.g., $20

  // Inventory
  requireInventoryCount: boolean
  criticalItems: string[] // RawMaterial IDs
  shrinkageThreshold: Decimal // e.g., 5%

  // Cash operations
  enableCashDrops: boolean
  cashDropThreshold: Decimal // e.g., $500
  requireManagerForPayouts: boolean

  // Multi-terminal
  enableMultiTerminal: boolean
  terminalCloseRequired: boolean

  // Retail features
  enableReturns: boolean
  enableGiftCards: boolean
  enableExchanges: boolean
}
```

### Industry Presets

- **Restaurant**: No inventory count, basic cash reconciliation
- **Retail**: Full inventory count, returns, gift cards
- **Hybrid**: Configurable features per venue

---

## Implementation Priority

### High Priority (Next 2 sprints)

1. FASE 2: Manual Cash Reconciliation
2. FASE 3: Cash Operations (CASH_DROP, PAY_OUT)
3. Fix test script compilation errors

### Medium Priority (3-6 months)

4. FASE 4: Manager Approval Workflows
5. FASE 5: Manual Inventory Count
6. FASE 7: Advanced Reporting

### Low Priority (6-12 months)

7. FASE 6: Retail-Specific Features
8. FASE 8: Offline Support
9. FASE 9: Multi-Terminal Coordination
10. FASE 10: External POS Integration

---

## References

### Research Sources

- Toast POS Shift Management: https://pos.toasttab.com/blog/on-the-line/how-to-open-and-close-your-restaurant
- Square POS Documentation: https://squareup.com/help/us/en/article/5068-open-and-close-shifts
- Toast Guide: https://central.toasttab.com/s/article/Cash-Management-Closing-and-Opening-Shifts

### Related Files

- `src/services/tpv/shift.tpv.service.ts` - Current implementation
- `prisma/schema.prisma` - Shift model (lines 1223-1268)
- `tests/unit/services/tpv/shift.tpv.service.test.ts` - Tests (to be created)

---

## Notes

- This roadmap is living document - update as requirements evolve
- Each FASE should have dedicated sprint planning
- User acceptance testing required before moving to next FASE
- Prioritize features based on actual venue needs (restaurant vs retail)

**Last Updated**: 2025-11-12 **Author**: Claude Code (with user requirements) **Status**: FASE 1 Complete, FASE 2+ Planned
