# Plan de Implementación: Customer System + Discounts

**Fecha de inicio:** 2025-11-26 **Última actualización:** 2026-01-06 **Estado:** Phase 1 COMPLETO, Phase 2 ~90% COMPLETO

> **IMPORTANTE:** Este archivo se elimina al completar la implementación. Actualizar con cada cambio significativo.

---

## 📊 Resumen de Progreso

| Phase       | Descripción            | Progreso | Estimado               |
| ----------- | ---------------------- | -------- | ---------------------- |
| **Phase 1** | Customer System        | **100%** | ✅ COMPLETADO          |
| **Phase 2** | Discount System        | **~90%** | Solo faltan API tests  |
| **Phase 3** | Inventory Enhancements | **0%**   | 2-3 semanas (opcional) |

---

## 🎯 PHASE 1: Customer/CRM System (Foundation)

### Objetivos

- Conectar el modelo Customer existente y hacerlo funcional
- Asociar clientes a órdenes
- Tracking de compras/visitas
- Foundation para loyalty points
- Foundation para descuentos customer-specific

### ✅ Completado

| Componente               | Archivo                                                            | Estado       |
| ------------------------ | ------------------------------------------------------------------ | ------------ |
| Prisma Schema            | `prisma/schema.prisma`                                             | ✅           |
| Migration                | `prisma/migrations/20251126194331_phase1_customer_system_loyalty/` | ✅           |
| Customer Service         | `src/services/dashboard/customer.dashboard.service.ts`             | ✅           |
| CustomerGroup Service    | `src/services/dashboard/customerGroup.dashboard.service.ts`        | ✅           |
| Loyalty Service          | `src/services/dashboard/loyalty.dashboard.service.ts`              | ✅           |
| Customer Controller      | `src/controllers/dashboard/customer.dashboard.controller.ts`       | ✅           |
| CustomerGroup Controller | `src/controllers/dashboard/customerGroup.dashboard.controller.ts`  | ✅           |
| Loyalty Controller       | `src/controllers/dashboard/loyalty.dashboard.controller.ts`        | ✅           |
| Customer Schema          | `src/schemas/dashboard/customer.schema.ts`                         | ✅           |
| CustomerGroup Schema     | `src/schemas/dashboard/customerGroup.schema.ts`                    | ✅           |
| Loyalty Schema           | `src/schemas/dashboard/loyalty.schema.ts`                          | ✅           |
| Dashboard Routes         | `src/routes/dashboard.routes.ts`                                   | ✅           |
| Permissions              | `src/lib/permissions.ts`                                           | ✅           |
| Payment Integration      | `src/services/tpv/payment.tpv.service.ts` (earnPoints)             | ✅           |
| Seed Data                | `prisma/seed.ts` (300 customers/venue)                             | ✅           |
| Unit Tests               | `tests/unit/services/dashboard/customer*.test.ts`                  | ✅ 124 tests |
| API Tests                | `tests/api-tests/dashboard/customer*.test.ts`                      | ✅ 78 tests  |
| TPV Customer Service     | `src/services/tpv/customer.tpv.service.ts`                         | ✅           |
| TPV Customer Controller  | `src/controllers/tpv/customer.tpv.controller.ts`                   | ✅           |
| TPV Customer Routes      | `src/routes/tpv.routes.ts` (4 endpoints)                           | ✅           |
| Demo Seed Customers      | `src/services/onboarding/demoSeed.service.ts`                      | ✅           |
| Integration Tests        | `tests/integration/tpv/customer-lookup.test.ts`                    | ✅ 30 tests  |

### ✅ Phase 1 COMPLETADO

> **Nota**: Data Migration Script no fue necesario - forward-only approach. Las órdenes nuevas se vinculan automáticamente via TPV lookup.

### TPV Customer Lookup - Especificación

**Archivo a crear:** `src/services/tpv/customer.tpv.service.ts`

```typescript
// Funciones requeridas:
findCustomerByPhone(venueId: string, phone: string): Promise<Customer | null>
findCustomerByEmail(venueId: string, email: string): Promise<Customer | null>
searchCustomers(venueId: string, query: string): Promise<Customer[]> // búsqueda general
quickCreateCustomer(venueId: string, data: { name, phone?, email? }): Promise<Customer>
```

**Endpoints TPV:**

```
GET  /api/v1/tpv/venues/:venueId/customers/search?phone=5551234567
GET  /api/v1/tpv/venues/:venueId/customers/search?email=test@example.com
GET  /api/v1/tpv/venues/:venueId/customers/search?q=María
POST /api/v1/tpv/venues/:venueId/customers (quick create)
```

### demoSeed.service.ts - Especificación

Agregar después de crear venue en `createDemoVenueData()`:

```typescript
// 1. Crear LoyaltyConfig
await prisma.loyaltyConfig.create({
  data: {
    venueId: venue.id,
    pointsPerDollar: 1,
    pointsPerVisit: 10,
    redemptionRate: 0.01, // 100 points = $1
    minPointsRedeem: 100,
    pointsExpireDays: 365,
    active: true,
  },
})

// 2. Crear CustomerGroups
const groups = await prisma.customerGroup.createMany({
  data: [
    { venueId: venue.id, name: 'VIP', description: 'Clientes frecuentes', color: '#FFD700' },
    { venueId: venue.id, name: 'Nuevos', description: 'Primera visita', color: '#4CAF50' },
    { venueId: venue.id, name: 'Cumpleañeros', description: 'Mes de cumpleaños', color: '#E91E63' },
  ],
})

// 3. Crear Customers de ejemplo (5-10)
// Con variedad: algunos con puntos, algunos en grupos, etc.
```

### Data Migration Script - SQL

```sql
-- Crear archivo: scripts/migrate-order-customers.sql

-- 1. Insertar customers únicos desde órdenes existentes
INSERT INTO "Customer" (id, "venueId", "firstName", email, phone, "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  o."venueId",
  COALESCE(o."customerName", 'Guest'),
  o."customerEmail",
  o."customerPhone",
  MIN(o."createdAt"),
  NOW()
FROM "Order" o
WHERE o."customerEmail" IS NOT NULL OR o."customerPhone" IS NOT NULL
GROUP BY o."venueId", o."customerName", o."customerEmail", o."customerPhone"
ON CONFLICT DO NOTHING;

-- 2. Vincular órdenes a customers
UPDATE "Order" o
SET "customerId" = c.id
FROM "Customer" c
WHERE o."venueId" = c."venueId"
  AND (o."customerEmail" = c.email OR o."customerPhone" = c.phone)
  AND o."customerId" IS NULL;

-- 3. Calcular stats iniciales
UPDATE "Customer" c
SET
  "totalVisits" = sub.visits,
  "totalSpent" = sub.spent,
  "firstVisitAt" = sub.first_visit,
  "lastVisitAt" = sub.last_visit
FROM (
  SELECT
    "customerId",
    COUNT(*) as visits,
    COALESCE(SUM(total), 0) as spent,
    MIN("createdAt") as first_visit,
    MAX("createdAt") as last_visit
  FROM "Order"
  WHERE "customerId" IS NOT NULL AND status = 'COMPLETED'
  GROUP BY "customerId"
) sub
WHERE c.id = sub."customerId";
```

---

## 🎯 PHASE 2: Comprehensive Discount System

### ✅ Completado Phase 2

| Componente          | Archivo                                                      | Estado |
| ------------------- | ------------------------------------------------------------ | ------ |
| Prisma Schema       | `prisma/schema.prisma` (Discount models + inverse relations) | ✅     |
| Migration           | `prisma/migrations/20251126235544_phase2_discount_system/`   | ✅     |
| Permissions         | `src/lib/permissions.ts`                                     | ✅     |
| Discount Service    | `src/services/dashboard/discount.dashboard.service.ts`       | ✅     |
| Discount Schema     | `src/schemas/dashboard/discount.schema.ts`                   | ✅     |
| Discount Controller | `src/controllers/dashboard/discount.dashboard.controller.ts` | ✅     |
| Dashboard Routes    | `src/routes/dashboard.routes.ts`                             | ✅     |
| Coupon Service      | `src/services/dashboard/coupon.dashboard.service.ts`         | ✅     |
| Coupon Schema       | `src/schemas/dashboard/coupon.schema.ts`                     | ✅     |
| Coupon Controller   | `src/controllers/dashboard/coupon.dashboard.controller.ts`   | ✅     |
| Coupon Routes       | `src/routes/dashboard.routes.ts` (10 endpoints)              | ✅     |

### ✅ Completado Phase 2 (adicional - actualizado 2026-01-06)

| Componente      | Archivo                                            | Estado |
| --------------- | -------------------------------------------------- | ------ |
| Discount Engine | `src/services/dashboard/discountEngine.service.ts` | ✅     |
| TPV Integration | `src/services/tpv/discount.tpv.service.ts`         | ✅     |
| Unit Tests      | `tests/unit/services/dashboard/discount*.test.ts`  | ✅     |
| Unit Tests      | `tests/unit/services/dashboard/coupon*.test.ts`    | ✅     |

### 🔄 Pendiente Phase 2

| Componente      | Archivo                                            | Estado    |
| --------------- | -------------------------------------------------- | --------- |
| API Tests       | `tests/api-tests/dashboard/discount*.test.ts`      | Pendiente |

### Objetivos

- Dashboard para gestión de descuentos
- Descuentos automáticos (por reglas)
- BOGO (Buy One Get One)
- Coupon codes
- Descuentos permanentes por customer
- Descuentos "on-the-fly" en TPV
- Alcance: Item, Category, Menu, Modifier, ModifierGroup, CustomerGroup, Quantity

### Requerimientos del Usuario

1. ✅ Descuentos permanentes por customer (aplicar automáticamente)
2. ✅ Descuentos "on-the-fly" en TPV (sin crear previamente)
3. ✅ Alcance completo: Modificadores, Grupos, Productos, Categorías, Menú
4. ✅ Features MUST-HAVE: Dashboard, Automáticos, BOGO, Coupon codes
5. ✅ "Muy fácil de usar para el cliente" (UX crítico)

### Database Schema

```prisma
model Discount {
  id              String   @id @default(cuid())
  venueId         String
  venue           Venue    @relation(fields: [venueId], references: [id])

  // Basic info
  name            String
  description     String?
  type            DiscountType // PERCENTAGE, FIXED_AMOUNT, COMP
  value           Decimal  @db.Decimal(10, 4)

  // Scope
  scope           DiscountScope

  // Target IDs
  targetItemIds       String[]
  targetCategoryIds   String[]
  targetModifierIds   String[]
  targetModifierGroupIds String[]
  customerGroupId     String?

  // Automatic application
  isAutomatic     Boolean  @default(false)
  priority        Int      @default(0)

  // Rules
  minPurchaseAmount    Decimal?
  maxDiscountAmount    Decimal?
  minQuantity          Int?

  // BOGO logic
  buyQuantity          Int?
  getQuantity          Int?
  getDiscountPercent   Decimal?
  buyItemIds           String[]
  getItemIds           String[]

  // Time-based
  validFrom       DateTime?
  validUntil      DateTime?
  dayOfWeek       Int[]?
  timeFrom        String?
  timeUntil       String?

  // Usage limits
  maxTotalUses    Int?
  maxUsesPerCustomer Int?
  currentUses     Int      @default(0)

  // Comp-specific
  requiresApproval Boolean  @default(false)
  compReason       String?

  // Tax handling
  applyAfterTax   Boolean  @default(false)
  modifyTaxBasis  Boolean  @default(true)

  // Stacking
  isStackable     Boolean  @default(false)

  active          Boolean  @default(true)
  createdById     String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model CouponCode {
  id              String   @id @default(cuid())
  discountId      String
  code            String   @unique
  maxUses         Int?
  maxUsesPerCustomer Int?
  currentUses     Int      @default(0)
  minPurchaseAmount Decimal?
  validFrom       DateTime?
  validUntil      DateTime?
  active          Boolean  @default(true)
  createdAt       DateTime @default(now())
}

model CouponRedemption {
  id           String   @id @default(cuid())
  couponCodeId String
  customerId   String?
  orderId      String   @unique
  redeemedAt   DateTime @default(now())
}

model CustomerDiscount {
  id              String   @id @default(cuid())
  customerId      String
  discountId      String
  active          Boolean  @default(true)
  assignedAt      DateTime @default(now())
  assignedById    String
}

model OrderDiscount {
  id              String   @id @default(cuid())
  orderId         String
  discountId      String?
  couponCodeId    String?
  type            DiscountType
  name            String
  value           Decimal
  amount          Decimal
  isComp          Boolean  @default(false)
  isAutomatic     Boolean  @default(false)
  compReason      String?
  appliedById     String
  authorizedById  String?
  createdAt       DateTime @default(now())
}

enum DiscountType {
  PERCENTAGE
  FIXED_AMOUNT
  COMP
}

enum DiscountScope {
  ITEM
  CATEGORY
  MENU
  MODIFIER
  MODIFIER_GROUP
  CUSTOMER_GROUP
  QUANTITY
  CUSTOM
}
```

### Services a Crear

| Service                         | Descripción                         |
| ------------------------------- | ----------------------------------- |
| `discount.dashboard.service.ts` | CRUD de descuentos                  |
| `discountEngine.service.ts`     | Lógica automática, BOGO, validación |
| `couponCode.service.ts`         | Gestión de cupones                  |
| `discountReport.service.ts`     | Analytics y reportes                |

### API Endpoints

**Dashboard:**

```
GET    /api/v1/dashboard/venues/:venueId/discounts
POST   /api/v1/dashboard/venues/:venueId/discounts
GET    /api/v1/dashboard/venues/:venueId/discounts/:id
PUT    /api/v1/dashboard/venues/:venueId/discounts/:id
DELETE /api/v1/dashboard/venues/:venueId/discounts/:id
POST   /api/v1/dashboard/venues/:venueId/discounts/:id/clone

GET    /api/v1/dashboard/venues/:venueId/coupons
POST   /api/v1/dashboard/venues/:venueId/coupons
PUT    /api/v1/dashboard/venues/:venueId/coupons/:id
DELETE /api/v1/dashboard/venues/:venueId/coupons/:id

GET    /api/v1/dashboard/venues/:venueId/discounts/reports/usage
GET    /api/v1/dashboard/venues/:venueId/discounts/reports/comps
GET    /api/v1/dashboard/venues/:venueId/discounts/reports/roi
```

**TPV:**

```
POST   /api/v1/tpv/venues/:venueId/orders/:orderId/discount/auto
POST   /api/v1/tpv/venues/:venueId/orders/:orderId/discount/manual
POST   /api/v1/tpv/venues/:venueId/orders/:orderId/discount/coupon
DELETE /api/v1/tpv/venues/:venueId/orders/:orderId/discount/:discountId
```

### Timeline Phase 2

| Semana | Tareas                                             |
| ------ | -------------------------------------------------- |
| 1-2    | Schema + Migration + discount.dashboard.service.ts |
| 3-4    | discountEngine.service.ts (automáticos, BOGO)      |
| 5-6    | couponCode.service.ts + usage limits               |
| 7      | TPV integration (on-the-fly discounts)             |
| 8      | Reports + tests + polish                           |

---

## 🎯 PHASE 3: Inventory Enhancements (Opcional)

### Transfer Orders

- Mover stock entre venues (A → B)
- FIFO integration (deduct from source, add to dest)
- Status workflow: DRAFT → SENT → IN_TRANSIT → RECEIVED

### Inventory Counts

- Conteo físico de inventario
- Generar hoja de conteo (full o parcial)
- Calcular varianza (esperado vs real)
- Aplicar ajustes

---

## 📝 Changelog

| Fecha      | Cambio                                                              |
| ---------- | ------------------------------------------------------------------- |
| 2025-11-26 | Plan inicial creado                                                 |
| 2025-11-26 | Phase 1: Schema, services, controllers, tests completados (85%)     |
| 2025-11-26 | Phase 1: Payment integration (earnPoints) completado                |
| 2025-11-26 | Phase 1: 100% COMPLETADO - TPV lookup, demo seed, integration tests |
| 2025-11-26 | Phase 2: Schema + Migration completado (15%)                        |
| 2025-11-26 | Phase 2: Service, Controller, Schema, Routes completados (40%)      |
| 2025-11-26 | Phase 2: Coupon Service + Schema + Controller + Routes (55%)        |

---

## ⚠️ Decisiones Pendientes

1. **Multi-venue discounts:** ¿Per-venue (recomendado) o Per-org (compartidos)?

   - Decisión actual: Per-venue (seguir patrón Avoqado)

2. **Marketing automation:** ¿Priorizar para Phase 4?
   - Decisión actual: Postergar (fuera de alcance)

---

> **RECORDATORIO:** Eliminar este archivo al completar toda la implementación.
