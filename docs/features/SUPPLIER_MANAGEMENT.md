# Supplier Management System

## Overview

The Supplier Management system provides comprehensive vendor relationship management for raw materials procurement. It tracks supplier information, pricing agreements, performance metrics, and integrates with the purchase order system to recommend the best suppliers based on price, lead time, and reliability.

## Business Context

**Key Use Cases:**
- Vendor information management (contact, payment terms)
- Price comparison across multiple suppliers
- Supplier performance tracking
- Automatic supplier recommendations for reordering
- Historical pricing analysis

**Industry Standards:**
- MarketMan: Supplier catalog with price tracking
- BlueCart: Vendor management with ordering
- Toast: Supplier integration for inventory

## Database Models

### Supplier

```prisma
model Supplier {
  id      String @id @default(cuid())
  venueId String

  // Basic info
  name        String
  contactName String?
  email       String?
  phone       String?
  website     String?

  // Address
  address String?
  city    String?
  state   String?
  country String? @default("MX")
  zipCode String?

  // Tax
  taxId String?  // RFC in Mexico

  // Performance metrics
  rating           Decimal @default(3.0) @db.Decimal(3, 2) // 1.0 - 5.0
  reliabilityScore Decimal @default(0.7) @db.Decimal(3, 2) // 0.0 - 1.0

  // Ordering details
  leadTimeDays Int      @default(3)  // Average delivery time
  minimumOrder Decimal? @db.Decimal(12, 2)  // Minimum order value

  // Status
  active Boolean @default(true)
  notes  String?

  // Soft delete
  deletedAt DateTime?
  deletedBy String?

  // Relations
  pricing        SupplierPricing[]
  purchaseOrders PurchaseOrder[]
}
```

### SupplierPricing

Tracks pricing agreements between suppliers and raw materials with versioning:

```prisma
model SupplierPricing {
  id            String @id @default(cuid())
  supplierId    String
  rawMaterialId String

  // Pricing
  pricePerUnit    Decimal  @db.Decimal(10, 4)
  unit            Unit     // Must match rawMaterial unit
  minimumQuantity Decimal  @default(1) @db.Decimal(12, 3)
  bulkDiscount    Decimal? @db.Decimal(5, 4)  // Percentage discount

  // Period
  effectiveFrom DateTime
  effectiveTo   DateTime?

  // Status
  active Boolean @default(true)

  @@unique([supplierId, rawMaterialId, effectiveFrom])
}
```

## Architecture

### Supplier Recommendation Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                 Supplier Recommendation Algorithm                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Query active suppliers with pricing for the raw material        │
│                                                                      │
│  2. For each supplier, calculate:                                    │
│     ├── Effective price (with bulk discount if applicable)          │
│     ├── Total cost for requested quantity                           │
│     └── Whether minimum order is met                                 │
│                                                                      │
│  3. Calculate normalized scores (0-100):                             │
│     ├── priceScore: Lower price = higher score (inverse)            │
│     ├── leadTimeScore: Faster delivery = higher score (inverse)     │
│     └── reliabilityScore: Higher reliability = higher score         │
│                                                                      │
│  4. Apply weights (configurable):                                    │
│     └── totalScore = price(50%) + leadTime(20%) + reliability(30%) │
│                                                                      │
│  5. Sort by totalScore descending                                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Scoring Weights

| Factor | Default Weight | Description |
|--------|----------------|-------------|
| `priceWeight` | 50% | Lower price = higher score |
| `leadTimeWeight` | 20% | Faster delivery = higher score |
| `reliabilityWeight` | 30% | Historical reliability rating |

## Service Layer

**File:** `src/services/dashboard/supplier.service.ts`

### Main Functions

```typescript
// CRUD Operations
export async function getSuppliers(
  venueId: string,
  filters?: { active?: boolean; search?: string; rating?: number }
): Promise<Supplier[]>

export async function getSupplier(
  venueId: string,
  supplierId: string
): Promise<Supplier | null>

export async function createSupplier(
  venueId: string,
  data: CreateSupplierDto
): Promise<Supplier>

export async function updateSupplier(
  venueId: string,
  supplierId: string,
  data: UpdateSupplierDto
): Promise<Supplier>

export async function deleteSupplier(
  venueId: string,
  supplierId: string
): Promise<void>  // Soft delete

// Pricing Operations
export async function createSupplierPricing(
  venueId: string,
  supplierId: string,
  data: PricingData
): Promise<SupplierPricing>

export async function getSupplierPricingHistory(
  venueId: string,
  rawMaterialId: string
): Promise<SupplierPricing[]>

// Recommendation & Analytics
export async function getSupplierRecommendations(
  venueId: string,
  rawMaterialId: string,
  quantity: number,
  weights?: WeightConfig
): Promise<SupplierRecommendation[]>

export async function getSupplierPerformance(
  venueId: string,
  supplierId: string,
  startDate?: Date,
  endDate?: Date
): Promise<PerformanceMetrics>
```

## Supplier Recommendation Algorithm

### Input Parameters

```typescript
interface RecommendationRequest {
  venueId: string
  rawMaterialId: string
  quantity: number
  weights?: {
    priceWeight?: number      // Default: 0.5
    leadTimeWeight?: number   // Default: 0.2
    reliabilityWeight?: number // Default: 0.3
  }
}
```

### Scoring Calculation

```typescript
// 1. Price Score (inverse - lower is better)
const priceScore = ((maxPrice - effectivePrice) / (maxPrice - minPrice)) * 100

// 2. Lead Time Score (inverse - faster is better)
const leadTimeScore = ((maxLeadTime - supplier.leadTimeDays) / (maxLeadTime - minLeadTime)) * 100

// 3. Reliability Score (direct - higher is better)
const reliabilityScore = (supplier.reliabilityScore || 0.5) * 100

// 4. Weighted Total
const totalScore =
  priceScore * priceWeight +
  leadTimeScore * leadTimeWeight +
  reliabilityScore * reliabilityWeight
```

### Response Structure

```typescript
interface SupplierRecommendation {
  supplier: {
    id: string
    name: string
    contactName: string | null
    email: string | null
    phone: string | null
    rating: number | null
    leadTimeDays: number
    reliabilityScore: number | null
    minimumOrder: number | null
  }
  pricing: {
    pricePerUnit: number
    unit: string
    minimumQuantity: number
    bulkDiscount: number | null
    effectivePrice: number  // After discount
  }
  analysis: {
    quantity: number
    totalCost: number
    estimatedDeliveryDays: number
    meetsMinimumOrder: boolean
    scores: {
      priceScore: number
      leadTimeScore: number
      reliabilityScore: number
      totalScore: number
    }
  }
}
```

## Performance Tracking

### Metrics Calculated

```typescript
interface SupplierPerformance {
  supplierId: string
  supplierName: string
  rating: number | null
  period: { startDate?: Date; endDate?: Date }

  // Order statistics
  orderCount: number
  totalSpent: number
  averageOrderValue: number

  // Delivery performance
  onTimeDeliveryRate: number  // Percentage
  completedOrders: number
  pendingOrders: number
  cancelledOrders: number

  // Quality
  qualityScore: number  // Based on reliabilityScore
}
```

### On-Time Delivery Calculation

```typescript
const onTimeOrders = completedOrders.filter(po => {
  if (!po.receivedDate || !po.expectedDeliveryDate) return false
  return new Date(po.receivedDate) <= new Date(po.expectedDeliveryDate)
})

const onTimeDeliveryRate = (onTimeOrders.length / completedOrders.length) * 100
```

## API Endpoints

### Suppliers

```
GET    /api/v1/dashboard/venues/:venueId/suppliers
       Query: active, search, rating

GET    /api/v1/dashboard/venues/:venueId/suppliers/:supplierId

POST   /api/v1/dashboard/venues/:venueId/suppliers
       Body: { name, contactName, email, phone, ... }

PATCH  /api/v1/dashboard/venues/:venueId/suppliers/:supplierId

DELETE /api/v1/dashboard/venues/:venueId/suppliers/:supplierId
```

### Pricing

```
POST   /api/v1/dashboard/venues/:venueId/suppliers/:supplierId/pricing
       Body: { rawMaterialId, pricePerUnit, unit, minimumQuantity, ... }

GET    /api/v1/dashboard/venues/:venueId/raw-materials/:rawMaterialId/pricing-history
```

### Recommendations

```
GET    /api/v1/dashboard/venues/:venueId/raw-materials/:rawMaterialId/supplier-recommendations
       Query: quantity, priceWeight, leadTimeWeight, reliabilityWeight
```

### Performance

```
GET    /api/v1/dashboard/venues/:venueId/suppliers/:supplierId/performance
       Query: startDate, endDate
```

## Request/Response Examples

### Create Supplier

```json
// POST /api/v1/dashboard/venues/:venueId/suppliers
{
  "name": "Frutas del Valle",
  "contactName": "Carlos García",
  "email": "ventas@frutasdelvalle.mx",
  "phone": "+52 555 123 4567",
  "address": "Central de Abastos Local 45",
  "city": "Ciudad de México",
  "state": "CDMX",
  "taxId": "FDV990101ABC",
  "leadTimeDays": 2,
  "minimumOrder": 500,
  "notes": "Especializado en aguacates y cítricos"
}
```

### Get Supplier Recommendations

```json
// GET /suppliers/recommendations?rawMaterialId=rm_123&quantity=50

[
  {
    "supplier": {
      "id": "sup_abc",
      "name": "Frutas del Valle",
      "rating": 4.5,
      "leadTimeDays": 2,
      "reliabilityScore": 0.92
    },
    "pricing": {
      "pricePerUnit": 45.00,
      "unit": "KG",
      "minimumQuantity": 10,
      "bulkDiscount": 0.05,
      "effectivePrice": 42.75
    },
    "analysis": {
      "quantity": 50,
      "totalCost": 2137.50,
      "estimatedDeliveryDays": 2,
      "meetsMinimumOrder": true,
      "scores": {
        "priceScore": 85.2,
        "leadTimeScore": 100,
        "reliabilityScore": 92,
        "totalScore": 90.3
      }
    }
  },
  {
    "supplier": {
      "id": "sup_def",
      "name": "Central de Abastos",
      "rating": 3.8,
      "leadTimeDays": 1,
      "reliabilityScore": 0.78
    },
    "pricing": {
      "pricePerUnit": 40.00,
      "unit": "KG",
      "minimumQuantity": 20,
      "effectivePrice": 40.00
    },
    "analysis": {
      "quantity": 50,
      "totalCost": 2000.00,
      "estimatedDeliveryDays": 1,
      "meetsMinimumOrder": true,
      "scores": {
        "priceScore": 100,
        "leadTimeScore": 100,
        "reliabilityScore": 78,
        "totalScore": 93.4
      }
    }
  }
]
```

## Pricing Versioning

When a new price is created for a supplier-material combination:

1. **Deactivate Previous**: Existing active pricing is set to `active: false`
2. **Set End Date**: Previous pricing gets `effectiveTo` set to current date
3. **Create New**: New pricing record created with `effectiveFrom`

```typescript
// Automatic versioning on price update
await prisma.supplierPricing.updateMany({
  where: {
    supplierId,
    rawMaterialId,
    active: true,
  },
  data: {
    active: false,
    effectiveTo: new Date().toISOString(),
  },
})

// Create new active pricing
await prisma.supplierPricing.create({
  data: {
    supplierId,
    rawMaterialId,
    pricePerUnit,
    effectiveFrom: new Date(),
    active: true,
  },
})
```

## Soft Delete

Suppliers with purchase order history cannot be hard deleted:

```typescript
if (existing.purchaseOrders.length > 0) {
  throw new AppError(
    `Cannot delete supplier - it has ${existing.purchaseOrders.length} associated purchase order(s)`,
    400
  )
}

// Soft delete instead
await prisma.supplier.update({
  where: { id: supplierId },
  data: {
    deletedAt: new Date(),
    deletedBy: staffId,
    active: false,
  },
})
```

## Integration with Auto-Reorder

The supplier recommendation system integrates with the Auto-Reorder feature:

```typescript
// In autoReorder.service.ts
const recommendations = await getSupplierRecommendations(
  venueId,
  rawMaterialId,
  suggestedQuantity
)

// Best supplier used for reorder suggestion
const bestSupplier = recommendations[0]

return {
  rawMaterial,
  suggestedQuantity,
  urgency,
  recommendedSupplier: bestSupplier.supplier,
  estimatedCost: bestSupplier.analysis.totalCost,
  estimatedDelivery: bestSupplier.analysis.estimatedDeliveryDays,
}
```

## Error Handling

| Error | Cause | HTTP Status |
|-------|-------|-------------|
| `Supplier with name X already exists` | Duplicate name in venue | 400 |
| `Supplier with ID X not found` | Invalid supplierId | 404 |
| `Cannot delete supplier - has purchase orders` | Delete protection | 400 |
| `Raw material not found` | Invalid rawMaterialId | 404 |

## Testing Scenarios

### Manual Testing

1. **Create and manage suppliers:**
   - Create supplier with full details
   - Update contact information
   - Verify soft delete with PO history

2. **Pricing management:**
   - Add pricing for raw material
   - Verify old price deactivated
   - Check pricing history

3. **Recommendations:**
   - Request recommendations for material
   - Verify scoring algorithm
   - Test with different weight configurations

4. **Performance tracking:**
   - Create multiple POs to supplier
   - Mark some as received (on-time, late)
   - Verify performance metrics

### Database Verification

```sql
-- Check suppliers with pricing
SELECT
  s.name,
  s.rating,
  s."leadTimeDays",
  s."reliabilityScore",
  COUNT(sp.id) as pricing_count
FROM "Supplier" s
LEFT JOIN "SupplierPricing" sp ON sp."supplierId" = s.id AND sp.active = true
WHERE s."venueId" = 'your-venue-id'
  AND s."deletedAt" IS NULL
GROUP BY s.id;

-- Check pricing for a raw material
SELECT
  s.name as supplier_name,
  sp."pricePerUnit",
  sp.unit,
  sp."minimumQuantity",
  sp."bulkDiscount",
  sp."effectiveFrom"
FROM "SupplierPricing" sp
JOIN "Supplier" s ON sp."supplierId" = s.id
WHERE sp."rawMaterialId" = 'your-material-id'
  AND sp.active = true
ORDER BY sp."pricePerUnit" ASC;

-- Check supplier performance
SELECT
  s.name,
  COUNT(po.id) as total_orders,
  SUM(po.total) as total_spent,
  AVG(po.total) as avg_order,
  COUNT(CASE WHEN po.status = 'RECEIVED' THEN 1 END) as completed
FROM "Supplier" s
LEFT JOIN "PurchaseOrder" po ON po."supplierId" = s.id
WHERE s.id = 'your-supplier-id'
GROUP BY s.id;
```

## Related Files

**Backend:**
- `src/services/dashboard/supplier.service.ts` - Core supplier logic
- `src/services/dashboard/autoReorder.service.ts` - Reorder integration
- `src/controllers/dashboard/inventory/supplier.controller.ts` - API handlers
- `src/schemas/dashboard/inventory.schema.ts` - Validation schemas
- `prisma/schema.prisma` - Supplier, SupplierPricing models

**Dashboard:**
- Supplier list and detail pages
- Price comparison views
- Performance analytics

## Future Enhancements

1. **Supplier portal:** Allow suppliers to update their own pricing
2. **Contract management:** Track supplier agreements and renewal dates
3. **Payment terms:** Net 30, Net 60, COD tracking
4. **Quality scoring:** Track defect rates and quality issues
5. **Supplier categories:** Group suppliers by type (produce, meat, etc.)
6. **Price alerts:** Notify when supplier prices change significantly
7. **Preferred suppliers:** Mark default suppliers per category
8. **Multi-currency:** Support international suppliers with currency conversion
