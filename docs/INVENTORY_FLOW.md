# Order → Payment → Inventory Flow (CRITICAL BUSINESS LOGIC)

This document details the complete order, payment, and inventory management flow with FIFO (First-In-First-Out) batch tracking.

## Overview

This is the **most critical business flow** in the platform. When an order is fully paid, the system automatically deducts inventory using
FIFO (First-In-First-Out) batch tracking.

## Complete Flow Diagram

```
1. ORDER CREATION [TPV or Dashboard]
   ├─ POST /api/v1/tpv/venues/{venueId}/orders
   ├─ Controller: order.tpv.controller.ts → createOrder()
   ├─ Service: order.tpv.service.ts → createOrder()
   └─ Result: Order with status="CONFIRMED", paymentStatus="PENDING"
   ⚠️ NO INVENTORY DEDUCTION YET

2. PAYMENT PROCESSING
   ├─ POST /api/v1/tpv/venues/{venueId}/orders/{orderId}/payments
   ├─ Controller: payment.tpv.controller.ts → recordPayment()
   ├─ Service: payment.tpv.service.ts → recordOrderPayment()
   │   ├─ Create Payment record
   │   ├─ Create VenueTransaction (revenue tracking)
   │   ├─ Create TransactionCost (profit tracking)
   │   └─ Check if order is fully paid:
   │       ├─ totalPaid < order.total → paymentStatus="PARTIAL"
   │       └─ totalPaid >= order.total → paymentStatus="PAID", status="COMPLETED"
   │           └─ 🎯 TRIGGER AUTOMATIC INVENTORY DEDUCTION

3. INVENTORY DEDUCTION [payment.tpv.service.ts:98-147]
   For each OrderItem:
   ├─ Call deductStockForRecipe(venueId, productId, quantity, orderId)
   ├─ Product has NO recipe? → Skip (log warning, not error)
   ├─ Insufficient stock? → Skip (log warning, payment still succeeds)
   └─ Success: Deduct inventory via FIFO

4. FIFO BATCH DEDUCTION [rawMaterial.service.ts:468-537]
   For each ingredient in recipe:
   ├─ Skip if ingredient.isOptional = true
   ├─ Calculate needed: ingredient.quantity × portions sold
   ├─ Call deductStockFIFO() → [rawMaterial.service.ts:395-466]
   │   ├─ Query: SELECT * FROM StockBatch WHERE rawMaterialId=? AND status=ACTIVE ORDER BY receivedDate ASC
   │   ├─ Batch 1 (oldest): Deduct up to remainingQuantity
   │   ├─ Batch depleted? → Update status=DEPLETED, move to Batch 2
   │   └─ Repeat until full quantity deducted
   ├─ Create RawMaterialMovement record (audit trail)
   ├─ Update RawMaterial.currentStock (-quantity)
   └─ Check if currentStock <= reorderPoint:
       └─ Create LowStockAlert + emit Socket.IO notification

5. PROFIT TRACKING
   ├─ Recipe Cost = SUM(ingredient.quantity × ingredient.costPerUnit)
   ├─ Sale Price = Product.price
   ├─ Gross Profit = Sale Price - Recipe Cost
   └─ Records: VenueTransaction (revenue) / TransactionCost (detailed costs) / MonthlyVenueProfit (aggregated)
```

## Key Files and Line Numbers

| File                                                            | Function                    | Lines   | Purpose                                               |
| --------------------------------------------------------------- | --------------------------- | ------- | ----------------------------------------------------- |
| `src/services/tpv/payment.tpv.service.ts`                       | `recordOrderPayment()`      | 98-147  | Triggers inventory deduction when order is fully paid |
| `src/services/dashboard/rawMaterial.service.ts`                 | `deductStockForRecipe()`    | 468-537 | Orchestrates recipe-based deduction                   |
| `src/services/dashboard/rawMaterial.service.ts`                 | `deductStockFIFO()`         | 395-466 | Implements FIFO batch consumption                     |
| `src/services/dashboard/productInventoryIntegration.service.ts` | `getProductInventoryType()` | 14-38   | Determines inventory strategy                         |

## Critical Business Rules

1. ✅ **Stock deduction ONLY when fully paid**: `totalPaid >= order.total`
2. ✅ **Non-blocking failures**: Payment succeeds even if deduction fails
3. ✅ **FIFO batch consumption**: Oldest batches first (`receivedDate ASC`)
4. ✅ **Recipe-based deduction**: Each product links to recipe with ingredients
5. ✅ **Optional ingredients**: Skipped if unavailable (`isOptional: true`)
6. ✅ **Low stock alerts**: Auto-generated when `currentStock <= reorderPoint`
7. ✅ **Partial payments**: Do NOT trigger deduction

## Real-World Example: 3 Hamburgers

### Recipe (1 burger)

- 1 bun @ $0.50 = $0.50
- 1 beef patty @ $2.00 = $2.00
- 2 cheese slices @ $0.30 each = $0.60
- 50g lettuce @ $0.50/100g = $0.25
- **Total Cost: $3.35 | Sale Price: $12.99 | Profit: $9.64 (74.2% margin)**

### Order Flow

1. **Waiter creates order**: 3 burgers = $38.97 (total with tax)
2. **Customer pays**: $38.97 + $5.00 tip = $43.97
3. **Payment triggers inventory deduction** (`totalPaid >= order.total` ✓)
4. **Stock deducted (FIFO)**:
   - 3 buns → Batch 1 (Oct 1, oldest)
   - 3 beef patties → Batch 1 (Oct 1)
   - 6 cheese slices → Batch 2 (Oct 3, after Batch 1 depleted)
   - 150g lettuce → Batch 1 (Oct 2)
5. **Revenue tracked**:
   - VenueTransaction: $43.97 gross
   - TransactionCost: $10.05 cost (3 × $3.35)
   - Profit: $33.92 (77.2% margin including tip)
6. **Low stock alert**: If any ingredient <= reorderPoint

## FIFO Batch Example

```typescript
// Buns inventory before order:
Batch 1: 50 units, received Oct 4, expires Oct 9  (OLDEST)
Batch 2: 100 units, received Oct 9, expires Oct 14
Batch 3: 150 units, received Oct 14, expires Oct 19 (NEWEST)

// Order requires 60 buns:
Step 1: Deduct 50 from Batch 1 → Batch 1 DEPLETED
Step 2: Deduct 10 from Batch 2 → Batch 2 has 90 remaining
Step 3: Batch 3 untouched (still 150)

// Result: Oldest stock used first, reducing waste!
```

## Edge Cases & Error Handling

| Scenario                        | Behavior                    | Code Location                    |
| ------------------------------- | --------------------------- | -------------------------------- |
| No recipe for product           | Skip deduction, log warning | `payment.tpv.service.ts:126-132` |
| Insufficient stock              | Skip deduction, log warning | `rawMaterial.service.ts:442-448` |
| Partial payment                 | No deduction                | `payment.tpv.service.ts:95-97`   |
| Optional ingredient unavailable | Skip ingredient, continue   | `rawMaterial.service.ts:483`     |
| Batch expired                   | Skip batch, use next        | `rawMaterial.service.ts:419-424` |
| Order cancelled                 | No deduction                | Only COMPLETED orders trigger    |

## API Endpoints

### Create Order

```bash
POST /api/v1/tpv/venues/{venueId}/orders
Authorization: Bearer {token}
Content-Type: application/json

{
  "items": [
    {
      "productId": "prod_123",
      "quantity": 3,
      "notes": "No onions"
    }
  ],
  "tableId": "table_5",
  "customerName": "John Doe"
}
```

### Record Payment (triggers inventory deduction)

```bash
POST /api/v1/tpv/venues/{venueId}/orders/{orderId}/payments
Authorization: Bearer {token}
Content-Type: application/json

{
  "amount": 38.97,
  "method": "CASH",
  "reference": "CASH-001"
}
```

### View Stock Movements

```bash
GET /api/v1/dashboard/venues/{venueId}/raw-materials/{materialId}/movements
Authorization: Bearer {token}
```

## Testing the Flow

### Automated Tests

```bash
npm run test:workflows  # Includes inventory deduction tests
npm run test:tpv        # TPV-specific tests
```

### Manual Testing

```bash
# 1. Reset and seed database
npm run migrate && npm run seed

# 2. Start dev server
npm run dev

# 3. Create order via curl
curl -X POST http://localhost:12344/api/v1/tpv/venues/{venueId}/orders \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"productId":"prod_123","quantity":3}]}'

# 4. Record payment
curl -X POST http://localhost:12344/api/v1/tpv/venues/{venueId}/orders/{orderId}/payments \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"amount":38.97,"method":"CASH"}'

# 5. Watch logs for inventory deduction
tail -f logs/app.log | grep "🎯\|✅\|⚠️"

# 6. Verify in Prisma Studio
npm run studio
# Check: RawMaterial.currentStock, StockBatch.remainingQuantity, RawMaterialMovement
```

## Debugging Common Issues

### Stock not deducting

**Check 1: Is order fully paid?**

```sql
SELECT id, total, totalPaid, paymentStatus
FROM "Order"
WHERE id = 'order_123';
-- totalPaid should be >= total
```

**Check 2: Does product have recipe?**

```sql
SELECT p.id, p.name, r.id as recipe_id
FROM "Product" p
LEFT JOIN "Recipe" r ON r."productId" = p.id
WHERE p.id = 'prod_123';
-- recipe_id should NOT be null
```

**Check 3: Are ingredients available?**

```sql
SELECT rm.id, rm.name, rm."currentStock", rm."reorderPoint"
FROM "RawMaterial" rm
INNER JOIN "RecipeLine" rl ON rl."rawMaterialId" = rm.id
INNER JOIN "Recipe" r ON r.id = rl."recipeId"
WHERE r."productId" = 'prod_123';
-- currentStock should be > 0
```

### Wrong FIFO order

```sql
SELECT id, "receivedDate", "remainingQuantity", status
FROM "StockBatch"
WHERE "rawMaterialId" = 'rm_123'
ORDER BY "receivedDate" ASC;
-- Should show oldest first with status='ACTIVE'
```

### Low stock alert not generated

**Check reorder point:**

```sql
SELECT id, name, "currentStock", "reorderPoint"
FROM "RawMaterial"
WHERE id = 'rm_123';
-- currentStock <= reorderPoint triggers alert
```

## Socket.IO Events

### Low stock alert

```typescript
socket.to(`venue_${venueId}`).emit('inventory.lowStock', {
  rawMaterialId,
  name,
  currentStock,
  reorderPoint,
  unit,
})
```

### Stock movement

```typescript
socket.to(`venue_${venueId}`).emit('inventory.stockMoved', {
  rawMaterialId,
  type,
  quantity,
  reference,
})
```

## Database Models

### Key Relationships

```
Order → OrderItem → Product → Recipe → RecipeLine → RawMaterial → StockBatch
                                                                 ↓
                                                      RawMaterialMovement
                                                                 ↓
                                                        LowStockAlert
```

### Critical Fields

| Model              | Field          | Purpose                                                  |
| ------------------ | -------------- | -------------------------------------------------------- |
| Order              | `totalPaid`    | Sum of all payments                                      |
| Order              | `total`        | Order total (triggers deduction when totalPaid >= total) |
| StockBatch         | `receivedDate` | FIFO ordering (oldest first)                             |
| StockBatch         | `status`       | ACTIVE or DEPLETED                                       |
| RawMaterial        | `currentStock` | Auto-calculated from batches                             |
| RawMaterial        | `reorderPoint` | Low stock threshold                                      |
| RecipeLine         | `isOptional`   | Skip if unavailable                                      |
| VenueTransaction   | `amount`       | Revenue tracking                                         |
| TransactionCost    | `cost`         | Cost tracking for profit calculation                     |
| MonthlyVenueProfit | `totalRevenue` | Aggregated monthly profits                               |

## Best Practices

1. **Always use transactions** for stock deduction to ensure atomicity
2. **Log extensively** during inventory operations (use emojis: 🎯 ✅ ⚠️)
3. **Never block payments** due to inventory issues
4. **Always validate** `totalPaid >= total` before deduction
5. **Test FIFO order** by creating multiple batches with different dates
6. **Monitor logs** for `⚠️` warnings about missing recipes or low stock

## Related Documentation

- **Root CLAUDE.md** - Architecture overview
- **STRIPE_INTEGRATION.md** - Payment processing and subscriptions
- **PERMISSIONS_SYSTEM.md** - Access control for inventory management endpoints
