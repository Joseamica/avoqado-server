# Square Vendors API - Reference Guide

**Status:** Investigación completada 2026-01-19 **Purpose:** Guía de referencia para implementar un sistema de proveedores similar a Square

Esta documentación detalla cómo Square maneja proveedores (vendors/suppliers) en su API, para servir como referencia al implementar nuestro
propio sistema de proveedores en Avoqado.

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Vendor Object Schema](#vendor-object-schema)
3. [API Endpoints](#api-endpoints)
4. [Use Cases](#use-cases)
5. [Relationship with Inventory](#relationship-with-inventory)
6. [Implementación Recomendada para Avoqado](#implementación-recomendada-para-avoqado)

---

## Overview

### What are Vendors?

> "A seller typically has a list of vendors to supply items for sale."

**Square's Definition:** Vendors (also called suppliers) are entities that supply items for sale to Square sellers.

### Key Characteristics

- A Square seller can be a vendor for another Square seller
- A vendor might not be a Square seller (external suppliers)
- Vendors are managed at the seller level (multi-location support)
- API is in **Beta** status (as of 2025-10-16 version)

### Permissions Required

- **VENDOR_READ**: Read operations (retrieve, search)
- **VENDOR_WRITE**: Write operations (create, update)

### Webhook Events

- `vendor.created`: Notifies when a vendor is created
- `vendor.updated`: Notifies when a vendor is updated

---

## Vendor Object Schema

### Complete Vendor Object

```typescript
interface Vendor {
  // Auto-generated (read-only)
  id?: string // Unique vendor identifier (UUID)
  created_at?: string // RFC 3339 timestamp
  updated_at?: string // RFC 3339 timestamp
  version?: number // Record version for optimistic locking
  status?: 'ACTIVE' | 'INACTIVE' // Default: 'ACTIVE'

  // Required fields
  name: string // Vendor business name (1-255 chars)

  // Optional fields
  address?: Address // Physical address
  contacts?: Contact[] // Contact persons
  account_number?: string // Vendor's account number for this seller
  note?: string // Additional notes/description
}
```

### Address Object

```typescript
interface Address {
  address_line_1?: string // Street address
  address_line_2?: string // Suite, apt, floor, etc.
  locality?: string // City
  administrative_district_level_1?: string // State/Province
  postal_code?: string // ZIP/Postal code
  country?: string // ISO 3166-1 alpha-2 (e.g., "US", "MX")
}
```

### Contact Object

```typescript
interface Contact {
  name?: string // Contact person name
  email_address?: string // Contact email
  phone_number?: string // Contact phone (E.164 format recommended)
}
```

---

## API Endpoints

### Base URL

```
https://connect.squareup.com
```

### 1. Create Vendor

**POST** `/v2/vendors/create`

**Request:**

```json
{
  "idempotency_key": "8fc6a5b0-9fe8-4b46-b46b-2ef95793abbe",
  "vendor": {
    "name": "Joe's Fresh Seafood",
    "address": {
      "address_line_1": "505 Electric Ave",
      "address_line_2": "Suite 600",
      "locality": "New York",
      "administrative_district_level_1": "NY",
      "postal_code": "10003",
      "country": "US"
    },
    "contacts": [
      {
        "name": "Joe Burrow",
        "email_address": "joe@example.com",
        "phone_number": "1-212-555-4250"
      }
    ],
    "account_number": "4025391",
    "note": "a vendor"
  }
}
```

**Response:**

```json
{
  "vendor": {
    "id": "INV_V_JDKYHBWT1D4F8MFH63DBMEN8Y4",
    "created_at": "2022-03-16T10:21:54.859Z",
    "updated_at": "2022-03-16T10:21:54.859Z",
    "name": "Joe's Fresh Seafood",
    "address": {
      /* same as request */
    },
    "contacts": [
      /* same as request */
    ],
    "account_number": "4025391",
    "note": "a vendor",
    "version": 1,
    "status": "ACTIVE"
  }
}
```

**Key Points:**

- ✅ `idempotency_key` is **required** (prevents duplicate vendors)
- ✅ Only `name` is required in the vendor object
- ✅ Response includes auto-generated fields: `id`, timestamps, `version`, `status`

---

### 2. Bulk Create Vendors

**POST** `/v2/vendors/bulk-create`

**Purpose:** Create multiple vendors in a single request (batch operation)

**Benefits:**

- Reduces API calls for bulk imports
- Maintains consistency across multiple vendor creations
- Single idempotency key for entire batch

---

### 3. Retrieve Vendor

**GET** `/v2/vendors/{vendor_id}`

**Purpose:** Get details of a specific vendor by ID

**Example:**

```bash
GET /v2/vendors/INV_V_JDKYHBWT1D4F8MFH63DBMEN8Y4
```

---

### 4. Bulk Retrieve Vendors

**POST** `/v2/vendors/bulk-retrieve`

**Purpose:** Retrieve multiple vendors by their IDs

**Request:**

```json
{
  "vendor_ids": ["INV_V_JDKYHBWT1D4F8MFH63DBMEN8Y4", "INV_V_ANOTHER_VENDOR_ID_HERE"]
}
```

---

### 5. Update Vendor

**PUT** `/v2/vendors/{vendor_id}`

**Purpose:** Update an existing vendor's information

**Request:**

```json
{
  "vendor": {
    "name": "Joe's Premium Seafood", // Updated name
    "note": "Preferred supplier for seafood items"
  }
}
```

**Note:** Uses optimistic locking via `version` field

---

### 6. Bulk Update Vendors

**PUT** `/v2/vendors/bulk-update`

**Purpose:** Update multiple vendors in batch

---

### 7. Search Vendors (⭐ Most Important)

**POST** `/v2/vendors/search`

**Purpose:** Search vendors using filters and sorting

**Key Features:**

- Filter by vendor properties
- Sort results
- Pagination support

**Example Request (Inferred):**

```json
{
  "filter": {
    "name": {
      "contains": "seafood"
    },
    "status": ["ACTIVE"]
  },
  "sort": {
    "field": "NAME",
    "order": "ASC"
  },
  "limit": 20,
  "cursor": null
}
```

**Square's Search Pattern (from other APIs):**

- Uses cursor-based pagination
- Supports fuzzy search on text fields
- Can filter by multiple criteria

---

## Use Cases

### 1. Onboarding New Suppliers

> "Programmatically add new sellers as suppliers for existing sellers during onboarding"

**Implementation:**

```typescript
// When a new restaurant joins the platform
async function onboardRestaurantSupplier(restaurantInfo) {
  await createVendor({
    name: restaurantInfo.name,
    address: restaurantInfo.address,
    contacts: [restaurantInfo.primaryContact],
    account_number: restaurantInfo.customerId,
  })
}
```

---

### 2. Vendor Selection for Item Stocking

> "Present vendor lists for suppliers to stock particular item types"

**Implementation:**

```typescript
// Filter vendors by product category
const seafoodVendors = await searchVendors({
  filter: {
    note: { contains: 'seafood' }
  }
})

// Display in UI for stock replenishment
<VendorDropdown
  vendors={seafoodVendors}
  onSelect={(vendor) => createPurchaseOrder(vendor.id)}
/>
```

---

### 3. Ad Hoc Vendor Creation

> "Create ad hoc vendors and add them to seller vendor lists"

**Implementation:**

```typescript
// Quick vendor creation during purchase order
const quickVendor = await createVendor({
  name: 'Emergency Supplier',
  contacts: [
    {
      phone_number: '+1-555-1234',
    },
  ],
  note: 'Created during emergency PO on 2026-01-19',
})
```

---

## Relationship with Inventory

### How Square Connects Vendors to Inventory

Based on Square's documentation:

1. **Vendor Management Feature** (Square Dashboard):

   - Create vendor profiles for barcodes, purchase orders, reports
   - Enter **SKUs** and **vendor codes** for items
   - "Including both SKUs and vendor codes for an item will help you match the items in your library with the codes vendors use to identify
     their products"

2. **Purchase Orders** (Square for Retail Plus/Premium):

   - Create and track purchase orders
   - Link vendors to specific POs
   - Sync inventory across locations when PO is received

3. **Inventory Updates**:
   - When orders are completed/refunded → inventory updated
   - Purchase orders received → inventory increased

### Key Insight: Vendor Codes

**Square's Pattern:**

```
Product.sku = "PROD-001"  (internal code)
Product.vendor_code = "SUPPLIER-ABC-XYZ"  (vendor's code for same item)
```

**Why this matters:**

- Vendors use their own product codes
- Reconciliation: Match vendor invoices to internal products
- Purchase orders: Use vendor codes when ordering

---

## Implementación Recomendada para Avoqado

### Phase 1: Core Vendor System (Week 1)

#### 1.1 Database Schema

```prisma
model Supplier {
  id          String   @id @default(cuid())
  venueId     String
  venue       Venue    @relation(fields: [venueId], references: [id], onDelete: Cascade)

  // Basic Info (matching Square)
  name        String
  accountNumber String? // Vendor's account number for this venue
  note        String?  // Additional notes

  // Contact (simplified - Square uses array, we start with single contact)
  contactName String?
  email       String?
  phone       String?

  // Address (matching Square structure)
  addressLine1    String?
  addressLine2    String?
  city            String?  // Square: "locality"
  state           String?  // Square: "administrative_district_level_1"
  zipCode         String?  // Square: "postal_code"
  country         String   @default("MX")

  // Status
  status      SupplierStatus @default(ACTIVE)
  active      Boolean        @default(true)

  // Versioning (for optimistic locking like Square)
  version     Int      @default(1)

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  // Relations
  movements   InventoryMovement[]
  purchaseOrders PurchaseOrder[]

  @@unique([venueId, name])
  @@index([venueId])
  @@index([status])
  @@index([active])
}

enum SupplierStatus {
  ACTIVE
  INACTIVE
}
```

#### 1.2 API Endpoints (Matching Square Pattern)

```typescript
// Create single supplier
POST /api/v1/dashboard/venues/:venueId/suppliers
{
  "idempotencyKey": "uuid",  // Prevent duplicates like Square
  "supplier": {
    "name": "string",
    "accountNumber": "string",
    "contactName": "string",
    "email": "string",
    "phone": "string",
    "addressLine1": "string",
    "city": "string",
    "state": "string",
    "country": "MX",
    "note": "string"
  }
}

// Bulk create suppliers (for imports)
POST /api/v1/dashboard/venues/:venueId/suppliers/bulk-create

// Retrieve single supplier
GET /api/v1/dashboard/venues/:venueId/suppliers/:supplierId

// Update supplier
PUT /api/v1/dashboard/venues/:venueId/suppliers/:supplierId
{
  "supplier": { /* fields to update */ },
  "version": 2  // Optimistic locking
}

// Search suppliers (most important!)
POST /api/v1/dashboard/venues/:venueId/suppliers/search
{
  "filter": {
    "name": { "contains": "string" },
    "status": ["ACTIVE"],
    "note": { "contains": "string" }
  },
  "sort": {
    "field": "NAME" | "CREATED_AT" | "UPDATED_AT",
    "order": "ASC" | "DESC"
  },
  "limit": 20,
  "cursor": "string"
}

// Deactivate supplier (don't delete - preserve history)
PUT /api/v1/dashboard/venues/:venueId/suppliers/:supplierId/deactivate
```

#### 1.3 Idempotency Implementation

```typescript
// src/services/dashboard/supplier.service.ts
import { v4 as uuidv4 } from 'uuid'

const idempotencyCache = new Map<string, string>() // key → supplierId

export async function createSupplier(venueId: string, data: CreateSupplierDto, idempotencyKey: string): Promise<Supplier> {
  // Check idempotency cache
  const cachedId = idempotencyCache.get(idempotencyKey)
  if (cachedId) {
    return await prisma.supplier.findUnique({ where: { id: cachedId } })
  }

  // Create supplier
  const supplier = await prisma.supplier.create({
    data: {
      venueId,
      ...data,
      version: 1,
    },
  })

  // Store in cache (expire after 24h)
  idempotencyCache.set(idempotencyKey, supplier.id)
  setTimeout(() => idempotencyCache.delete(idempotencyKey), 86400000)

  return supplier
}
```

#### 1.4 Optimistic Locking (Version Control)

```typescript
export async function updateSupplier(
  venueId: string,
  supplierId: string,
  data: UpdateSupplierDto,
  expectedVersion: number,
): Promise<Supplier> {
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, venueId },
  })

  if (!supplier) {
    throw new AppError('Supplier not found', 404)
  }

  // Check version match (optimistic locking)
  if (supplier.version !== expectedVersion) {
    throw new AppError('Supplier has been modified by another user. Please refresh and try again.', 409)
  }

  // Update with version increment
  return await prisma.supplier.update({
    where: { id: supplierId },
    data: {
      ...data,
      version: { increment: 1 },
      updatedAt: new Date(),
    },
  })
}
```

---

### Phase 2: Vendor Codes & Product Linking (Week 2)

#### 2.1 Add Vendor Codes to Products

```prisma
model Product {
  // ... existing fields ...

  sku         String  // Internal SKU (already exists)
  supplierSku String? // NEW: Vendor's product code

  // Preferred supplier (optional)
  preferredSupplierId String?
  preferredSupplier   Supplier? @relation(fields: [preferredSupplierId], references: [id])

  @@index([supplierSku])
  @@index([preferredSupplierId])
}
```

#### 2.2 Product-Supplier Pricing

```prisma
model SupplierProductPrice {
  id          String   @id @default(cuid())
  supplierId  String
  supplier    Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  productId   String
  product     Product  @relation(fields: [productId], references: [id], onDelete: Cascade)

  // Pricing
  unitCost    Decimal  @db.Decimal(10, 2)
  currency    String   @default("MXN")

  // Purchase terms
  minimumOrderQty Int    @default(1)
  leadTimeDays    Int    @default(7)

  // Validity
  effectiveFrom DateTime
  effectiveTo   DateTime?

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([supplierId, productId, effectiveFrom])
  @@index([productId])
  @@index([effectiveFrom])
}
```

---

### Phase 3: Purchase Orders (Week 3-4)

```prisma
model PurchaseOrder {
  id          String   @id @default(cuid())
  venueId     String
  venue       Venue    @relation(fields: [venueId], references: [id])
  supplierId  String
  supplier    Supplier @relation(fields: [supplierId], references: [id])

  // PO Details
  orderNumber String   // PO-2026-001
  orderDate   DateTime @default(now())
  expectedDeliveryDate DateTime?

  // Status
  status      POStatus @default(DRAFT)

  // Totals
  subtotal    Decimal  @db.Decimal(10, 2)
  tax         Decimal  @db.Decimal(10, 2)
  total       Decimal  @db.Decimal(10, 2)

  // Notes
  notes       String?

  createdBy   String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  // Relations
  items       PurchaseOrderItem[]

  @@unique([venueId, orderNumber])
  @@index([venueId])
  @@index([supplierId])
  @@index([status])
}

enum POStatus {
  DRAFT       // Being created
  PENDING     // Sent to supplier
  CONFIRMED   // Supplier confirmed
  SHIPPED     // In transit
  RECEIVED    // Arrived
  CANCELLED
}

model PurchaseOrderItem {
  id              String        @id @default(cuid())
  purchaseOrderId String
  purchaseOrder   PurchaseOrder @relation(fields: [purchaseOrderId], references: [id], onDelete: Cascade)
  productId       String
  product         Product       @relation(fields: [productId], references: [id])

  // Quantities
  quantityOrdered  Int
  quantityReceived Int      @default(0)

  // Pricing
  unitCost         Decimal  @db.Decimal(10, 2)
  lineTotal        Decimal  @db.Decimal(10, 2)

  @@index([purchaseOrderId])
  @@index([productId])
}
```

---

## Comparación: Square vs Avoqado

| Feature                | Square                          | Avoqado (Propuesto)                       |
| ---------------------- | ------------------------------- | ----------------------------------------- |
| **Basic Vendor CRUD**  | ✅                              | ✅ Phase 1                                |
| **Bulk Operations**    | ✅                              | ✅ Phase 1                                |
| **Search/Filter**      | ✅                              | ✅ Phase 1                                |
| **Idempotency**        | ✅                              | ✅ Phase 1                                |
| **Optimistic Locking** | ✅ (version field)              | ✅ Phase 1                                |
| **Multiple Contacts**  | ✅ (array)                      | 🔄 Single contact (Phase 1), expand later |
| **Vendor Codes**       | ✅ Dashboard only               | ✅ Phase 2                                |
| **Purchase Orders**    | ✅ Dashboard only (Retail Plus) | ✅ Phase 3                                |
| **Supplier Analytics** | ❌ Not in API                   | ✅ Phase 3                                |
| **Quality Scoring**    | ❌                              | ✅ Phase 3                                |
| **Price Comparison**   | ❌                              | ✅ Phase 3                                |

**Key Differences:**

- Square keeps vendors simple in API (basic CRUD)
- Square's advanced features (PO, reports) are Dashboard-only
- Avoqado will add analytics and scoring in API (competitive advantage)

---

## Frontend Implementation

### Supplier List Page

```tsx
// src/pages/Inventory/Suppliers.tsx
export function SuppliersPage() {
  const { venueId } = useCurrentVenue()
  const [searchQuery, setSearchQuery] = useState('')

  const { data: suppliers, isLoading } = useQuery({
    queryKey: ['suppliers', venueId, searchQuery],
    queryFn: async () => {
      const response = await suppliersApi.search(venueId, {
        filter: {
          name: { contains: searchQuery },
          status: ['ACTIVE'],
        },
        limit: 50,
      })
      return response.data.suppliers
    },
  })

  return (
    <div>
      <div className="flex justify-between mb-4">
        <Input placeholder="Buscar proveedor..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
        <Button onClick={() => openCreateSupplierDialog()}>Crear proveedor</Button>
      </div>

      <DataTable
        columns={[
          { header: 'Nombre', accessorKey: 'name' },
          { header: 'Contacto', accessorKey: 'contactName' },
          { header: 'Email', accessorKey: 'email' },
          { header: 'Teléfono', accessorKey: 'phone' },
          { header: 'Estado', accessorKey: 'status' },
        ]}
        data={suppliers}
      />
    </div>
  )
}
```

### Supplier Selector in Stock Adjustment

```tsx
// Update StockEditPopover to use supplier selector
function StockEditPopover({ productId, currentStock, onSave }) {
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null)

  const { data: suppliers } = useQuery({
    queryKey: ['suppliers', venueId],
    queryFn: () =>
      suppliersApi.search(venueId, {
        filter: { status: ['ACTIVE'] },
        sort: { field: 'NAME', order: 'ASC' },
      }),
  })

  return (
    <div>
      {/* Existing fields... */}

      <div className="space-y-2">
        <Label>Proveedor</Label>
        <Select
          value={selectedSupplier?.id}
          onValueChange={id => {
            const supplier = suppliers.find(s => s.id === id)
            setSelectedSupplier(supplier)
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Seleccionar proveedor" />
          </SelectTrigger>
          <SelectContent>
            {suppliers?.map(supplier => (
              <SelectItem key={supplier.id} value={supplier.id}>
                {supplier.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button
        onClick={() => {
          onSave(action, qty, reason, unitCost, selectedSupplier?.id)
        }}
      >
        Guardar
      </Button>
    </div>
  )
}
```

---

## Migration Strategy: String → Supplier Relation

### Step 1: Create Suppliers from Existing Data

```typescript
// scripts/migrate-suppliers.ts
async function migrateExistingSuppliersFromMovements() {
  // 1. Get unique supplier names from InventoryMovement
  const uniqueSuppliers = await prisma.$queryRaw<Array<{ supplier: string }>>`
    SELECT DISTINCT supplier
    FROM "InventoryMovement"
    WHERE supplier IS NOT NULL
    ORDER BY supplier
  `

  // 2. Create Supplier records for each unique name
  const supplierMap = new Map<string, string>() // name → id

  for (const { supplier } of uniqueSuppliers) {
    const created = await prisma.supplier.create({
      data: {
        venueId: 'VENUE_ID', // Need to determine venue
        name: supplier,
        note: 'Migrated from inventory movements',
      },
    })
    supplierMap.set(supplier, created.id)
  }

  // 3. Update InventoryMovement.supplierId
  for (const [name, id] of supplierMap.entries()) {
    await prisma.$executeRaw`
      UPDATE "InventoryMovement"
      SET "supplierId" = ${id}
      WHERE supplier = ${name}
    `
  }

  console.log(`✅ Migrated ${supplierMap.size} suppliers`)
}
```

### Step 2: Prisma Migration

```prisma
// Add supplierId field first (nullable)
model InventoryMovement {
  // ... existing fields ...
  supplier    String?    // Keep for backward compatibility
  supplierId  String?    // NEW
  supplierRel Supplier?  @relation(fields: [supplierId], references: [id])

  @@index([supplierId])
}
```

### Step 3: Deprecate String Field

```typescript
// After migration complete, make supplierId required
model InventoryMovement {
  supplierId  String
  supplierRel Supplier  @relation(fields: [supplierId], references: [id])
  // Remove: supplier String?
}
```

---

## Testing

### Unit Tests

```typescript
describe('Supplier Service', () => {
  describe('createSupplier', () => {
    it('should prevent duplicate creation with idempotency key', async () => {
      const key = uuid()
      const data = { name: 'Test Supplier', venueId: 'V1' }

      const supplier1 = await createSupplier('V1', data, key)
      const supplier2 = await createSupplier('V1', data, key)

      expect(supplier1.id).toBe(supplier2.id)
    })
  })

  describe('updateSupplier', () => {
    it('should fail with version mismatch', async () => {
      const supplier = await createSupplier('V1', { name: 'Test' }, uuid())

      // Simulate concurrent update
      await prisma.supplier.update({
        where: { id: supplier.id },
        data: { version: { increment: 1 } },
      })

      await expect(updateSupplier('V1', supplier.id, { name: 'Updated' }, 1)).rejects.toThrow('Supplier has been modified')
    })
  })
})
```

---

## Resources & References

### Square Official Documentation

- [Vendors API Guide](https://developer.squareup.com/docs/vendors-api/manage-vendors-in-apps)
- [Vendors API Reference](https://developer.squareup.com/reference/square/vendors-api)
- [Create Vendors](https://developer.squareup.com/docs/vendors-api/create-vendors)
- [Update Vendors](https://developer.squareup.com/docs/vendors-api/update-vendors)
- [Inventory API](https://developer.squareup.com/docs/inventory-api/what-it-does)
- [Purchase Orders (Dashboard)](https://squareup.com/help/us/en/article/8258-create-purchase-orders-with-square-for-retail)
- [Vendor Management (Dashboard)](https://squareup.com/help/us/en/article/5958-vendor-management)

### Key Insights from Square

1. **Idempotency is critical** - Prevents duplicate vendors during retries
2. **Optimistic locking** - Uses `version` field to prevent concurrent update conflicts
3. **Simple API, rich Dashboard** - Complex features (PO, analytics) live in UI
4. **Vendor codes matter** - SKU vs vendor product codes for reconciliation
5. **Status over deletion** - ACTIVE/INACTIVE instead of hard delete

---

## Next Steps

1. ✅ **Phase 1** (This PR): Add unitCost & supplier to InventoryMovement
2. ⏳ **Phase 2**: Create Supplier model + CRUD API
3. ⏳ **Phase 3**: Supplier-Product linking + vendor codes
4. ⏳ **Phase 4**: Purchase Orders
5. ⏳ **Phase 5**: Analytics & Quality Scoring

---

**Last Updated:** 2026-01-19 **Investigated By:** Claude Code **Status:** Ready for Implementation
