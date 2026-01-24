# TODO: Sistema Completo de Proveedores

**Status:** Planificado **Priority:** Medium **Requested:** 2026-01-19

## Problema Actual

Actualmente, el campo `supplier` en `InventoryMovement` es un simple string. Esto limita las capacidades de:

- Tracking histórico por proveedor
- Análisis de costos por proveedor
- Evaluación de calidad de proveedores
- Gestión de contactos y términos de pago

## Propuesta: Sistema de Proveedores Completo

### 1. Database Schema

```prisma
model Supplier {
  id          String   @id @default(cuid())
  venueId     String
  venue       Venue    @relation(fields: [venueId], references: [id], onDelete: Cascade)

  // Basic Info
  name        String
  code        String?  // Internal supplier code
  taxId       String?  // RFC/Tax ID

  // Contact
  contactName String?
  email       String?
  phone       String?
  address     String?
  city        String?
  state       String?
  country     String   @default("MX")
  zipCode     String?

  // Business Terms
  paymentTerms     Int     @default(30)  // Days
  currency         String  @default("MXN")
  minimumOrder     Decimal? @db.Decimal(10, 2)
  leadTimeDays     Int     @default(7)

  // Quality Metrics
  rating           Float?  @db.Real  // 1-5 stars
  onTimeDelivery   Float?  @db.Real  // Percentage
  qualityScore     Float?  @db.Real  // Percentage

  // Status
  active      Boolean  @default(true)
  notes       String?

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  // Relations
  movements   InventoryMovement[]
  purchaseOrders PurchaseOrder[]

  @@unique([venueId, name])
  @@index([venueId])
  @@index([active])
}

// Then update InventoryMovement
model InventoryMovement {
  // ... existing fields ...

  // Change supplier from String to relation
  supplierId  String?
  supplier    Supplier? @relation(fields: [supplierId], references: [id])

  @@index([supplierId])
}
```

### 2. Migration Strategy

**Phase 1: Create Supplier model**

```bash
npx prisma migrate dev --name create_supplier_model
```

**Phase 2: Data migration script**

- Extract unique supplier names from existing InventoryMovement records
- Create Supplier records for each unique name
- Update InventoryMovement.supplierId with the corresponding Supplier.id

**Phase 3: Frontend UI**

- Supplier management page (CRUD)
- Supplier selector in stock adjustment dialog (autocomplete)
- Supplier analytics dashboard

### 3. Features to Implement

#### 3.1 Supplier Management

- [ ] Create/Edit/Delete suppliers
- [ ] Import suppliers from CSV
- [ ] Export supplier list
- [ ] Duplicate detection

#### 3.2 Purchase Orders

- [ ] Create purchase orders linked to suppliers
- [ ] Track order status (Pending, Confirmed, Shipped, Received)
- [ ] Receive stock directly from PO
- [ ] Compare PO vs actual received quantities

#### 3.3 Supplier Analytics

- [ ] Total purchases by supplier (last 30/90/365 days)
- [ ] Average unit cost by supplier
- [ ] On-time delivery rate
- [ ] Quality incidents by supplier
- [ ] Cost variance analysis

#### 3.4 Supplier Scoring

- [ ] Automatic rating based on:
  - On-time delivery percentage
  - Quality incidents
  - Price competitiveness
  - Order fulfillment accuracy
- [ ] Manual rating override
- [ ] Preferred supplier badge

### 4. API Endpoints

```typescript
// Suppliers
GET    /api/v1/dashboard/venues/:venueId/suppliers
POST   /api/v1/dashboard/venues/:venueId/suppliers
GET    /api/v1/dashboard/venues/:venueId/suppliers/:supplierId
PUT    /api/v1/dashboard/venues/:venueId/suppliers/:supplierId
DELETE /api/v1/dashboard/venues/:venueId/suppliers/:supplierId

// Analytics
GET    /api/v1/dashboard/venues/:venueId/suppliers/:supplierId/analytics
GET    /api/v1/dashboard/venues/:venueId/suppliers/:supplierId/purchase-history

// Purchase Orders (future)
POST   /api/v1/dashboard/venues/:venueId/purchase-orders
GET    /api/v1/dashboard/venues/:venueId/purchase-orders/:orderId
PUT    /api/v1/dashboard/venues/:venueId/purchase-orders/:orderId/receive
```

### 5. UI Components

#### 5.1 Supplier List Page

- DataTable with filters (active/inactive, rating)
- Search by name, code, taxId
- Quick actions (edit, deactivate, view history)
- Import/Export buttons

#### 5.2 Supplier Form Dialog

- Basic info tab (name, code, contact)
- Terms tab (payment terms, lead time, minimum order)
- Notes tab (free text)

#### 5.3 Supplier Selector (in Stock Adjustment)

- Autocomplete dropdown
- Show recent suppliers first
- "Add new supplier" quick action
- Display supplier info on hover

#### 5.4 Supplier Analytics Dashboard

- KPI cards (total purchases, avg cost, on-time %)
- Purchase timeline chart
- Top suppliers by volume
- Cost comparison by supplier

### 6. Business Logic

#### 6.1 Automatic Quality Scoring

```typescript
function calculateSupplierScore(supplier: Supplier): number {
  const weights = {
    onTimeDelivery: 0.4,
    qualityScore: 0.3,
    priceCompetitiveness: 0.2,
    orderAccuracy: 0.1
  }

  return (
    supplier.onTimeDelivery * weights.onTimeDelivery +
    supplier.qualityScore * weights.qualityScore +
    // ... etc
  )
}
```

#### 6.2 Preferred Supplier Recommendation

- When adjusting stock, suggest suppliers with:
  - Highest score
  - Best price for similar products
  - Recent orders (within 30 days)

### 7. Permissions

```typescript
'suppliers:read' // View supplier list
'suppliers:create' // Add new suppliers
'suppliers:update' // Edit supplier info
'suppliers:delete' // Delete suppliers
'suppliers:analytics' // View supplier analytics
```

Assign to:

- MANAGER: read, create, update
- ADMIN: all
- OWNER: all
- SUPERADMIN: all

### 8. Internationalization

Add translations for:

- `suppliers.title`
- `suppliers.create`
- `suppliers.fields.*`
- `suppliers.analytics.*`

### 9. Testing

- [ ] Unit tests for supplier CRUD
- [ ] Integration tests for supplier-product relationships
- [ ] E2E tests for stock adjustment with supplier selection
- [ ] Migration script tests (string → Supplier relation)

### 10. Documentation

Update:

- [ ] `docs/INVENTORY_REFERENCE.md` - Add supplier system section
- [ ] `docs/DATABASE_SCHEMA.md` - Add Supplier model
- [ ] Frontend `docs/features/inventory.md` - Add supplier management UI

## Timeline

**Phase 1:** Database & Backend (1 week)

- Schema migration
- CRUD endpoints
- Data migration script

**Phase 2:** Frontend UI (1 week)

- Supplier list page
- Supplier form
- Stock adjustment integration

**Phase 3:** Analytics (1 week)

- Purchase history
- Quality scoring
- Supplier dashboard

**Phase 4:** Purchase Orders (2 weeks) - Future enhancement

- PO creation
- PO receiving
- PO analytics

## References

Similar systems:

- Square: Supplier management in Inventory
- Toast: Vendor management
- Shopify: Vendor tracking in products

## Notes

- Consider integrating with accounting systems (future)
- Mobile app support for receiving POs (future)
- Automated reordering based on supplier lead times (future)
