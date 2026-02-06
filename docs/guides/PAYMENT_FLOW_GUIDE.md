# Order -> Payment -> Inventory Flow - Claude Operational Guide

> Dense cheat sheet for the most critical business flow. Full docs: `docs/PAYMENT_ARCHITECTURE.md`, `docs/INVENTORY_REFERENCE.md`

---

## Flow Summary

```
ORDER CREATED (status=CONFIRMED, paymentStatus=PENDING)
    -> No inventory deduction yet

PAYMENT RECORDED
    -> totalPaid < total? -> paymentStatus=PARTIAL -> No deduction
    -> totalPaid >= total? -> paymentStatus=PAID, status=COMPLETED
        -> TRIGGER INVENTORY DEDUCTION (automatic)
```

**Golden rule:** Stock deduction ONLY when fully paid (`totalPaid >= order.total`).

---

## Key Files (Verified)

| File                                                            | Function                      | Purpose                                          |
| --------------------------------------------------------------- | ----------------------------- | ------------------------------------------------ |
| `src/services/tpv/payment.tpv.service.ts`                       | `recordOrderPayment()`        | Entry point. Triggers deduction when fully paid. |
| `src/services/dashboard/rawMaterial.service.ts`                 | `deductStockForRecipe()`      | Orchestrates recipe-based deduction per product  |
| `src/services/dashboard/fifoBatch.service.ts`                   | `deductStockFIFO()`           | FIFO batch consumption (oldest batches first)    |
| `src/services/dashboard/productInventoryIntegration.service.ts` | `getProductInventoryMethod()` | Returns `'QUANTITY' \| 'RECIPE' \| null`         |
| `src/services/dashboard/productInventoryIntegration.service.ts` | `deductInventoryForProduct()` | Determines and executes deduction strategy       |

---

## 7 Critical Business Rules

1. **Stock deduction ONLY when fully paid**: `totalPaid >= order.total`
2. **Non-blocking failures**: Payment succeeds even if deduction fails (logged, not thrown)
3. **FIFO batch consumption**: Oldest batches first (`receivedDate ASC`)
4. **Recipe-based deduction**: Product -> Recipe -> RecipeLines -> RawMaterials -> StockBatches
5. **Optional ingredients**: Skipped if unavailable (`isOptional: true`)
6. **Low stock alerts**: Auto-generated when `currentStock <= reorderPoint`
7. **Partial payments**: Do NOT trigger deduction

---

## FIFO Batch Logic

```
StockBatch query: WHERE rawMaterialId=? AND status=ACTIVE ORDER BY receivedDate ASC

Deduction steps:
1. Take oldest active batch
2. Deduct up to batch.remainingQuantity
3. If batch depleted -> status=DEPLETED, move to next batch
4. Repeat until full quantity deducted
5. Create RawMaterialMovement record (audit trail)
6. Update RawMaterial.currentStock
7. If currentStock <= reorderPoint -> Create LowStockAlert
```

---

## Inventory Types

| Type       | How it works                                                                        | Example                                |
| ---------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| `RECIPE`   | Product has Recipe with RecipeLines. Each line maps to a RawMaterial with quantity. | Hamburger = 1 bun + 1 patty + 2 cheese |
| `QUANTITY` | Product directly tracks stock count. Simple decrement.                              | Bottled water = -1 per sale            |
| `null`     | No inventory tracking. Skip deduction.                                              | Digital gift card                      |

For serialized items (SIMs, jewelry): Uses `serializedInventoryService.markAsSold()` - separate flow.

---

## Edge Cases

| Scenario                        | Behavior                                             |
| ------------------------------- | ---------------------------------------------------- |
| No recipe for product           | Skip deduction, log warning (NOT an error)           |
| Insufficient stock              | Skip deduction, log warning (payment still succeeds) |
| Partial payment                 | No deduction at all                                  |
| Optional ingredient unavailable | Skip that ingredient, continue with rest             |
| Order cancelled                 | No deduction (only COMPLETED orders trigger)         |
| Modifier with substitution      | Substitution ingredient deducted instead of original |

---

## Database Model Chain

```
Order -> OrderItem -> Product -> Recipe -> RecipeLine -> RawMaterial -> StockBatch
                                                                     -> RawMaterialMovement (audit)
                                                                     -> LowStockAlert
```

**Critical fields:**

- `Order.totalPaid` vs `Order.total` -> Determines if deduction triggers
- `StockBatch.receivedDate` -> FIFO ordering
- `StockBatch.status` -> ACTIVE or DEPLETED
- `RawMaterial.currentStock` -> Auto-calculated running total
- `RawMaterial.reorderPoint` -> Low stock threshold
- `RecipeLine.isOptional` -> Skip if unavailable

---

## Profit Tracking

```
Recipe Cost = SUM(ingredient.quantity * ingredient.costPerUnit)
Sale Price = Product.price
Gross Profit = Sale Price - Recipe Cost

Records created:
- VenueTransaction (revenue tracking)
- TransactionCost (detailed cost breakdown)
- MonthlyVenueProfit (aggregated monthly)
```

---

## Testing

```bash
npm run test:workflows    # Includes inventory deduction tests
npm run test:tpv          # TPV-specific tests
```

---

## Debugging Checklist

**Stock not deducting?**

1. Is order fully paid? (`totalPaid >= total`)
2. Does product have recipe? (Check Recipe -> RecipeLines)
3. Are ingredients available? (`rawMaterial.currentStock > 0`)
4. Are there active batches? (`StockBatch.status = 'ACTIVE'`)

**Wrong FIFO order?**

```sql
SELECT id, "receivedDate", "remainingQuantity", status
FROM "StockBatch"
WHERE "rawMaterialId" = 'rm_xxx'
ORDER BY "receivedDate" ASC;
```

---

## Anti-Patterns

```typescript
// NEVER block payments due to inventory issues
try { await deductInventory() } catch (e) { logger.warn(e) } // Payment continues

// NEVER use float for money
amount: new Prisma.Decimal(100.50)  // CORRECT
amount: 100.50                       // WRONG - precision loss

// ALWAYS use transactions for stock deduction
await prisma.$transaction(async (tx) => {
  await tx.payment.create(...)
  await tx.order.update(...)
})
```
