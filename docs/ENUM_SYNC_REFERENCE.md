# Enum Synchronization Reference

# Backend ↔ Frontend Enum Values

**CRITICAL**: Frontend and backend MUST use the same enum values.

## 📋 Inventory Enums

### RawMaterialMovementType

**Backend** (`@prisma/client`):

```typescript
enum RawMaterialMovementType {
  PURCHASE = 'PURCHASE',
  USAGE = 'USAGE',
  ADJUSTMENT = 'ADJUSTMENT',
  COUNT = 'COUNT',
  SPOILAGE = 'SPOILAGE', // ⚠️ NOT 'WASTE'
  TRANSFER_IN = 'TRANSFER_IN',
  TRANSFER_OUT = 'TRANSFER_OUT',
  RETURN = 'RETURN',
}
```

**Frontend** (Use exactly these strings):

```typescript
export const MOVEMENT_TYPES = {
  PURCHASE: 'PURCHASE',
  USAGE: 'USAGE',
  ADJUSTMENT: 'ADJUSTMENT',
  COUNT: 'COUNT',
  SPOILAGE: 'SPOILAGE', // ⚠️ NOT 'WASTE'
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  RETURN: 'RETURN',
} as const
```

### PurchaseOrderStatus

**Backend**:

```typescript
enum PurchaseOrderStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SENT = 'SENT',
  CONFIRMED = 'CONFIRMED',
  SHIPPED = 'SHIPPED',
  PARTIAL = 'PARTIAL',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}
```

**Frontend**:

```typescript
export const PO_STATUSES = {
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SENT: 'SENT',
  CONFIRMED: 'CONFIRMED',
  SHIPPED: 'SHIPPED',
  PARTIAL: 'PARTIAL',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
} as const
```

### RawMaterialCategory

**Backend**:

```typescript
enum RawMaterialCategory {
  MEAT = 'MEAT',
  POULTRY = 'POULTRY',
  SEAFOOD = 'SEAFOOD',
  DAIRY = 'DAIRY',
  CHEESE = 'CHEESE',
  EGGS = 'EGGS',
  VEGETABLES = 'VEGETABLES',
  FRUITS = 'FRUITS',
  GRAINS = 'GRAINS',
  BREAD = 'BREAD',
  PASTA = 'PASTA',
  RICE = 'RICE',
  BEANS = 'BEANS',
  SPICES = 'SPICES',
  HERBS = 'HERBS',
  OILS = 'OILS',
  SAUCES = 'SAUCES',
  CONDIMENTS = 'CONDIMENTS',
  BEVERAGES = 'BEVERAGES',
  ALCOHOL = 'ALCOHOL',
  CLEANING = 'CLEANING',
  PACKAGING = 'PACKAGING',
  OTHER = 'OTHER',
}
```

### Unit

**Backend**:

```typescript
enum Unit {
  // Weight
  GRAM = 'GRAM',
  KILOGRAM = 'KILOGRAM',
  MILLIGRAM = 'MILLIGRAM',
  POUND = 'POUND',
  OUNCE = 'OUNCE',
  TON = 'TON',

  // Volume
  MILLILITER = 'MILLILITER',
  LITER = 'LITER',
  GALLON = 'GALLON',
  QUART = 'QUART',
  PINT = 'PINT',
  CUP = 'CUP',
  FLUID_OUNCE = 'FLUID_OUNCE',
  TABLESPOON = 'TABLESPOON',
  TEASPOON = 'TEASPOON',

  // Count
  UNIT = 'UNIT',
  PIECE = 'PIECE',
  DOZEN = 'DOZEN',
  CASE = 'CASE',
  BOX = 'BOX',
  BAG = 'BAG',
  BOTTLE = 'BOTTLE',
  CAN = 'CAN',
  JAR = 'JAR',

  // Length
  METER = 'METER',
  CENTIMETER = 'CENTIMETER',
  MILLIMETER = 'MILLIMETER',
  INCH = 'INCH',
  FOOT = 'FOOT',

  // Temperature
  CELSIUS = 'CELSIUS',
  FAHRENHEIT = 'FAHRENHEIT',

  // Time
  MINUTE = 'MINUTE',
  HOUR = 'HOUR',
  DAY = 'DAY',
}
```

### UnitType

**Backend**:

```typescript
enum UnitType {
  WEIGHT = 'WEIGHT',
  VOLUME = 'VOLUME',
  COUNT = 'COUNT',
  LENGTH = 'LENGTH',
  TEMPERATURE = 'TEMPERATURE',
  TIME = 'TIME',
}
```

### CostingMethod

**Backend**:

```typescript
enum CostingMethod {
  FIFO = 'FIFO', // First In, First Out
  LIFO = 'LIFO', // Last In, First Out (not implemented)
  WEIGHTED_AVERAGE = 'WEIGHTED_AVERAGE',
  STANDARD_COST = 'STANDARD_COST',
}
```

### AlertType

**Backend**:

```typescript
enum AlertType {
  LOW_STOCK = 'LOW_STOCK',
  OUT_OF_STOCK = 'OUT_OF_STOCK',
  EXPIRING_SOON = 'EXPIRING_SOON', // ⚠️ NOT 'EXPIRED'
  OVER_STOCK = 'OVER_STOCK',
}
```

### NotificationChannel

**Backend**:

```typescript
enum NotificationChannel {
  IN_APP = 'IN_APP',
  EMAIL = 'EMAIL',
  SMS = 'SMS',
  PUSH = 'PUSH',
}
```

## 🎯 Product Inventory Type (NEW)

**Backend Type** (not in database, stored in `externalData` JSON field):

```typescript
type InventoryType = 'NONE' | 'SIMPLE_STOCK' | 'RECIPE_BASED'
```

**Frontend**:

```typescript
export const INVENTORY_TYPES = {
  NONE: 'NONE', // Services, no inventory tracking
  SIMPLE_STOCK: 'SIMPLE_STOCK', // Retail, jewelry (-1 per sale)
  RECIPE_BASED: 'RECIPE_BASED', // Restaurants, ingredient-based
} as const
```

## ⚠️ Common Mistakes

### ❌ WRONG

```typescript
// Frontend
{
  type: 'WASTE'
} // Backend expects 'SPOILAGE'
{
  type: 'EXPIRED'
} // Backend expects 'EXPIRING_SOON'
{
  status: 'PENDING'
} // Backend expects 'PENDING_APPROVAL'
{
  total: 100
} // PurchaseOrder field is 'total' (correct)
```

### ✅ CORRECT

```typescript
// Frontend
{
  type: 'SPOILAGE'
}
{
  type: 'EXPIRING_SOON'
}
{
  status: 'PENDING_APPROVAL'
}
{
  total: 100
}
```

## 🔄 API Response Format

All API responses follow this structure:

```typescript
// Success
{
  success: true,
  data: T,
  pagination?: {
    limit?: number,
    offset?: number,
    hasMore: boolean
  }
}

// Error
{
  success: false,
  error: string,
  code?: number
}
```

## 📚 Frontend Type Definitions

Create a types file in frontend:

```typescript
// src/types/inventory.ts

export type InventoryType = 'NONE' | 'SIMPLE_STOCK' | 'RECIPE_BASED'

export type MovementType = 'PURCHASE' | 'USAGE' | 'ADJUSTMENT' | 'COUNT' | 'SPOILAGE' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'RETURN'

export type PurchaseOrderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'SENT'
  | 'CONFIRMED'
  | 'SHIPPED'
  | 'PARTIAL'
  | 'RECEIVED'
  | 'CANCELLED'

export type AlertType = 'LOW_STOCK' | 'OUT_OF_STOCK' | 'EXPIRING_SOON' | 'OVER_STOCK'

// ... etc
```

## 🛠️ Development Checklist

When adding new enums:

- [ ] Add to Prisma schema
- [ ] Run `npx prisma generate`
- [ ] Update this document
- [ ] Update frontend type definitions
- [ ] Update API documentation
- [ ] Test enum values in API calls
- [ ] Update i18n translation keys for enum labels

## 📖 Related Documentation

- Database Schema: `C:\Users\josea\Documents\Avoqado\avoqado-server\prisma\schema.prisma`
- Backend Types: Auto-generated by Prisma in `node_modules/.prisma/client`
- API Endpoints: See each controller in `src/controllers/dashboard/inventory/`
