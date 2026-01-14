# Auto-Reorder System

## Overview

The Auto-Reorder system analyzes inventory levels and historical usage patterns to generate intelligent purchase order suggestions. When
stock levels fall to or below configured reorder points, the system calculates optimal order quantities, recommends suppliers, and can
automatically create purchase orders.

## Business Context

**Key Use Cases:**

- Proactive inventory replenishment before stockouts
- Data-driven purchasing decisions based on actual usage
- Supplier comparison and recommendation
- Automated purchase order generation
- Urgency-based prioritization for procurement teams

**Industry Standards:**

- Toast: "Auto-86" for low stock alerts
- BlueCart: Automated purchasing with par levels
- MarketMan: Predictive ordering based on sales

## Database Models

### RawMaterial (Stock Tracking Fields)

```prisma
model RawMaterial {
  // Stock tracking
  currentStock  Decimal @db.Decimal(12, 3)
  minimumStock  Decimal @db.Decimal(12, 3)  // Low stock alert threshold
  reorderPoint  Decimal @db.Decimal(12, 3)  // Auto-reorder trigger
  maximumStock  Decimal? @db.Decimal(12, 3) // Maximum storage capacity
  reservedStock Decimal @default(0) @db.Decimal(12, 3)

  // Costing
  costPerUnit    Decimal @db.Decimal(10, 4)
  avgCostPerUnit Decimal @db.Decimal(10, 4)

  // Relations
  movements       RawMaterialMovement[]
  supplierPricing SupplierPricing[]
}
```

### PurchaseOrder

```prisma
model PurchaseOrder {
  id         String   @id @default(cuid())
  venueId    String
  supplierId String

  // Order details
  orderNumber          String @unique  // Format: PO20250106-001
  status               PurchaseOrderStatus @default(DRAFT)
  orderDate            DateTime
  expectedDeliveryDate DateTime?
  receivedDate         DateTime?

  // Amounts
  subtotal  Decimal @db.Decimal(12, 2)
  taxAmount Decimal @default(0) @db.Decimal(10, 2)
  total     Decimal @db.Decimal(12, 2)
  taxRate   Decimal @default(0.16) @db.Decimal(5, 4)

  // Approval workflow
  createdBy       String?
  approvedBy      String?
  approvedAt      DateTime?
  rejectedBy      String?
  rejectedAt      DateTime?
  rejectionReason String?

  items PurchaseOrderItem[]
}
```

### PurchaseOrderStatus Enum

```prisma
enum PurchaseOrderStatus {
  DRAFT              // Being created
  PENDING_APPROVAL   // Awaiting manager/admin approval
  REJECTED           // Approval rejected
  APPROVED           // Approved, ready to send
  SENT               // Sent to supplier
  CONFIRMED          // Supplier confirmed
  SHIPPED            // In transit
  PARTIAL            // Partially received
  RECEIVED           // Fully received
  CANCELLED          // Cancelled
}
```

### Supplier & SupplierPricing

```prisma
model Supplier {
  // Performance metrics
  rating           Decimal @default(3.0) @db.Decimal(3, 2)  // 1.0 - 5.0
  reliabilityScore Decimal @default(0.7) @db.Decimal(3, 2)  // 0.0 - 1.0
  leadTimeDays     Int     @default(3)  // Delivery time

  pricing SupplierPricing[]
}

model SupplierPricing {
  pricePerUnit    Decimal @db.Decimal(10, 4)
  minimumQuantity Decimal @default(1) @db.Decimal(12, 3)
  bulkDiscount    Decimal? @db.Decimal(5, 4)  // Percentage
  effectiveFrom   DateTime
  effectiveTo     DateTime?
  active          Boolean @default(true)
}
```

## Architecture

### Reorder Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Auto-Reorder Suggestion Flow                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Query RawMaterials where currentStock ≤ reorderPoint            │
│                                                                      │
│  2. For each material:                                               │
│     └── Calculate suggested quantity (90-day EMA + 25% safety)      │
│     └── Get supplier recommendations (price, lead time, rating)      │
│     └── Calculate urgency level                                      │
│     └── Estimate days until stockout                                 │
│                                                                      │
│  3. Sort by urgency (CRITICAL → HIGH → MEDIUM → LOW)                │
│     └── Secondary sort: days until stockout (ascending)              │
│                                                                      │
│  4. Return suggestions with supplier recommendations                 │
│                                                                      │
│  5. Optional: Auto-create PurchaseOrders grouped by supplier        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Urgency Levels

| Level      | Condition                           | Action                             |
| ---------- | ----------------------------------- | ---------------------------------- |
| `CRITICAL` | currentStock = 0                    | Immediate attention - out of stock |
| `HIGH`     | currentStock < 50% of reorderPoint  | Order within 24 hours              |
| `MEDIUM`   | currentStock < 80% of reorderPoint  | Order within 3 days                |
| `LOW`      | currentStock ≤ 100% of reorderPoint | Schedule for next order cycle      |

## Service Layer

**File:** `src/services/dashboard/autoReorder.service.ts`

### Main Functions

```typescript
// Get all materials needing reorder with suggestions
export async function getReorderSuggestions(
  venueId: string,
  options?: {
    category?: string
    includeNearReorder?: boolean // Include items within 10% of reorder point
    limit?: number
    offset?: number
  },
): Promise<ReorderSuggestionsResponse>

// Create POs from selected suggestions
export async function createPurchaseOrdersFromSuggestions(
  venueId: string,
  rawMaterialIds: string[],
  options?: {
    staffId?: string
    autoApprove?: boolean
  },
): Promise<{ ordersCreated: number; orders: PurchaseOrder[] }>
```

### Demand Forecasting Algorithm

Uses Exponential Moving Average (EMA) on 90 days of usage data:

```typescript
async function calculateSuggestedQuantity(venueId: string, rawMaterialId: string, daysToForecast: number = 30): Promise<number> {
  // 1. Get last 90 days of USAGE movements
  const movements = await prisma.rawMaterialMovement.findMany({
    where: {
      venueId,
      rawMaterialId,
      type: 'USAGE',
      createdAt: { gte: startDate, lte: endDate },
    },
  })

  // 2. Calculate daily average usage
  const totalUsage = movements.reduce((sum, m) => sum + Math.abs(m.quantity), 0)
  const avgDailyUsage = totalUsage / daysWithData

  // 3. Forecast + safety stock
  const forecastedUsage = avgDailyUsage * daysToForecast
  const safetyStock = forecastedUsage * 0.25 // 25% buffer
  const suggestedQuantity = forecastedUsage + safetyStock

  return Math.ceil(suggestedQuantity)
}
```

### Supplier Recommendation

Integrates with `getSupplierRecommendations()` which scores suppliers based on:

- **Price** (40%): Lower price = higher score
- **Lead time** (25%): Faster delivery = higher score
- **Rating** (20%): Higher rating = higher score
- **Reliability** (15%): Higher reliability score = higher score
- **Minimum order met** (bonus): Extra points if quantity meets minimum

## API Response Structure

### getReorderSuggestions Response

```typescript
{
  totalSuggestions: 12,
  criticalCount: 2,
  highCount: 3,
  mediumCount: 4,
  lowCount: 3,
  suggestions: [
    {
      rawMaterial: {
        id: "rm_abc123",
        name: "Aguacate Hass",
        sku: "AGU-001",
        category: "PRODUCE",
        unit: "KG",
        currentStock: 2.5,
        reorderPoint: 10,
        stockLevel: 0.25  // 25% of reorder point
      },
      suggestion: {
        urgency: "CRITICAL",
        suggestedQuantity: 50,
        estimatedCost: 2250.00,
        daysUntilStockout: 1,
        recommendedSupplier: {
          id: "sup_xyz",
          name: "Frutas del Valle",
          leadTimeDays: 2,
          pricePerUnit: 45.00,
          totalCost: 2250.00,
          estimatedDeliveryDate: "2025-01-08T00:00:00Z",
          meetsMinimumOrder: true
        },
        alternativeSuppliers: [
          {
            id: "sup_abc",
            name: "Central de Abastos",
            pricePerUnit: 42.00,
            totalCost: 2100.00,
            leadTimeDays: 4,
            score: 78.5
          }
        ]
      },
      analysis: {
        hasSuppliers: true,
        supplierCount: 3,
        avgDailyUsage: 2.1,
        forecastPeriodDays: 30,
        includesSafetyStock: true,
        safetyStockPercentage: 25
      }
    }
  ],
  pagination: {
    limit: 50,
    offset: 0,
    hasMore: false
  }
}
```

## Purchase Order Generation

### Order Number Format

```
PO{YYYY}{MM}{DD}-{SEQ}
Example: PO20250106-001, PO20250106-002
```

### Grouping Logic

When creating POs from suggestions:

1. Group materials by recommended supplier
2. Create one PO per supplier
3. Calculate totals per order
4. Optionally auto-approve if `autoApprove: true`

```typescript
// Example: Create POs for selected materials
const result = await createPurchaseOrdersFromSuggestions(venueId, ['rm_abc', 'rm_def', 'rm_ghi'], {
  staffId: 'staff_123',
  autoApprove: false,
})
// Returns: { ordersCreated: 2, orders: [...] }
// (2 orders if materials had different recommended suppliers)
```

## Integration Points

### Low Stock Alerts

Works in conjunction with `LowStockAlert` model:

```prisma
model LowStockAlert {
  rawMaterialId String
  alertType     LowStockAlertType  // BELOW_MINIMUM | BELOW_REORDER | OUT_OF_STOCK
  currentStock  Decimal
  threshold     Decimal
  acknowledged  Boolean @default(false)
}
```

### Inventory Movements

Triggers reorder check after stock deductions:

```typescript
// In inventory service after USAGE movement
if (newStock <= rawMaterial.reorderPoint) {
  // Create or update low stock alert
  await createLowStockAlert(rawMaterialId, 'BELOW_REORDER')
}
```

## Testing Scenarios

### Manual Testing

1. **Trigger reorder suggestion:**

   - Set raw material `reorderPoint = 10`
   - Reduce `currentStock` to 8
   - Call `getReorderSuggestions()`
   - Verify material appears in suggestions

2. **Urgency levels:**

   - Stock = 0 → CRITICAL
   - Stock = 4 (40% of 10) → HIGH
   - Stock = 7 (70% of 10) → MEDIUM
   - Stock = 10 (100% of 10) → LOW

3. **Create PO from suggestion:**
   - Select materials from suggestions
   - Call `createPurchaseOrdersFromSuggestions()`
   - Verify PO created with correct items and supplier

### Database Verification

```sql
-- Check materials needing reorder
SELECT
  rm.name,
  rm."currentStock",
  rm."reorderPoint",
  rm."currentStock" / rm."reorderPoint" as stock_level,
  CASE
    WHEN rm."currentStock" = 0 THEN 'CRITICAL'
    WHEN rm."currentStock" < rm."reorderPoint" * 0.5 THEN 'HIGH'
    WHEN rm."currentStock" < rm."reorderPoint" * 0.8 THEN 'MEDIUM'
    ELSE 'LOW'
  END as urgency
FROM "RawMaterial" rm
WHERE rm."currentStock" <= rm."reorderPoint"
  AND rm.active = true
  AND rm."deletedAt" IS NULL
ORDER BY rm."currentStock" / rm."reorderPoint" ASC;

-- Check average daily usage
SELECT
  rm.name,
  COUNT(mov.id) as movement_count,
  SUM(ABS(mov.quantity)) as total_usage,
  SUM(ABS(mov.quantity)) / 30.0 as avg_daily_usage
FROM "RawMaterial" rm
JOIN "RawMaterialMovement" mov ON mov."rawMaterialId" = rm.id
WHERE mov.type = 'USAGE'
  AND mov."createdAt" > NOW() - INTERVAL '30 days'
GROUP BY rm.id, rm.name;
```

## Related Files

**Backend:**

- `src/services/dashboard/autoReorder.service.ts` - Main reorder logic
- `src/services/dashboard/supplier.service.ts` - Supplier recommendations
- `src/services/dashboard/alert.service.ts` - Low stock alerts
- `src/services/dashboard/rawMaterial.service.ts` - Stock management
- `prisma/schema.prisma` - RawMaterial, PurchaseOrder, Supplier models

**Dashboard:**

- Reorder suggestions page
- Purchase order management
- Supplier management

## Configuration

### Venue-Level Settings (Future)

```typescript
interface ReorderSettings {
  forecastDays: number // Default: 30
  safetyStockPercent: number // Default: 25
  autoCreatePO: boolean // Default: false
  autoApproveUnder: number // Auto-approve POs under this amount
  defaultLeadTimeDays: number // Fallback if supplier has no lead time
}
```

## Future Enhancements

1. **Seasonal adjustments:** Factor in historical seasonality (e.g., December demand spike)
2. **Machine learning:** Replace EMA with ML-based demand forecasting
3. **Supplier auto-rotation:** Distribute orders across suppliers based on capacity
4. **Price alerts:** Notify when supplier prices change significantly
5. **Integration with accounting:** Auto-sync POs to accounting software
6. **Mobile notifications:** Push alerts for CRITICAL urgency items
7. **Batch optimization:** Suggest optimal order timing to consolidate shipments
