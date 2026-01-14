# Business Types & Industry Categories Architecture

> **This is the single source of truth** for VenueType/BusinessCategory documentation across all Avoqado repos.

This document explains the hierarchical business type system used in Avoqado, following industry standards from Square, Stripe, and Toast.

## Overview

Avoqado uses a **two-level classification system**:

1. **VenueType** (specific) - The actual business type stored in the database (e.g., `RESTAURANT`, `JEWELRY`, `SALON`)
2. **BusinessCategory** (derived) - High-level industry grouping derived at runtime (e.g., `FOOD_SERVICE`, `RETAIL`, `SERVICES`)

```
┌─────────────────────────────────────────────────────────────────┐
│                     BusinessCategory (Derived)                   │
│  FOOD_SERVICE | RETAIL | SERVICES | HOSPITALITY | ENTERTAINMENT │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ getBusinessCategory()
                              │
┌─────────────────────────────────────────────────────────────────┐
│                      VenueType (Stored in DB)                    │
│  RESTAURANT, BAR, CAFE, JEWELRY, SALON, HOTEL, CINEMA, etc.     │
└─────────────────────────────────────────────────────────────────┘
```

## Why Derived Instead of Stored?

This is the **industry standard** used by Square, Stripe, and Toast:

| Platform   | Stores                                        | Derives                      |
| ---------- | --------------------------------------------- | ---------------------------- |
| **Square** | MCC (Merchant Category Code) in Locations API | Category for UI grouping     |
| **Stripe** | MCC codes (5812, 7941, etc.)                  | Category is just for display |
| **Toast**  | Restaurant type + Service model               | Category for onboarding UX   |

**Benefits of derived approach:**

- No database migration needed when adding types
- Single source of truth (VenueType)
- No data redundancy or sync issues
- Category automatically correct based on type

**When to store in DB:**

- Only if you need to query `WHERE industryCategory = 'RETAIL'` frequently
- Current system can use `WHERE type IN ('RETAIL_STORE', 'JEWELRY', ...)`

## VenueType Enum (Prisma Schema)

Location: `/prisma/schema.prisma` (lines ~3817-3870)

### FOOD_SERVICE (8 types)

| Type            | Description              | MCC  | Blumon Rate (Credit) |
| --------------- | ------------------------ | ---- | -------------------- |
| `RESTAURANT`    | Full-service restaurant  | 5812 | 2.3%                 |
| `BAR`           | Bar, cantina, pub        | 5813 | 2.3%                 |
| `CAFE`          | Coffee shop, cafeteria   | 5812 | 2.3%                 |
| `BAKERY`        | Bakery, panaderia        | 5462 | 2.3%                 |
| `FOOD_TRUCK`    | Mobile food service      | 5812 | 2.3%                 |
| `FAST_FOOD`     | Quick service restaurant | 5814 | 1.7%                 |
| `CATERING`      | Catering services        | 5812 | 2.3%                 |
| `CLOUD_KITCHEN` | Delivery-only kitchen    | 5812 | 2.3%                 |

### RETAIL (13 types)

| Type                 | Description                      | MCC  | Blumon Rate (Credit) |
| -------------------- | -------------------------------- | ---- | -------------------- |
| `RETAIL_STORE`       | General retail                   | 5999 | 1.53%                |
| `JEWELRY`            | Jewelry store                    | 5944 | 1.53%                |
| `CLOTHING`           | Clothing/apparel                 | 5651 | 1.53%                |
| `ELECTRONICS`        | Electronics store                | 5732 | 1.53%                |
| `PHARMACY`           | Pharmacy/drugstore               | 5912 | 1.28%                |
| `CONVENIENCE_STORE`  | Convenience store                | 5411 | 1.53%                |
| `SUPERMARKET`        | Supermarket/grocery              | 5411 | 1.53%                |
| `LIQUOR_STORE`       | Liquor store                     | 5921 | 1.53%                |
| `FURNITURE`          | Furniture store                  | 5712 | 1.53%                |
| `HARDWARE`           | Hardware store                   | 5251 | 1.53%                |
| `BOOKSTORE`          | Bookstore                        | 5942 | 1.53%                |
| `PET_STORE`          | Pet supplies                     | 5995 | 1.53%                |
| `TELECOMUNICACIONES` | Telcel/AT&T stores, phone repair | 4812 | 1.53%                |

### SERVICES (8 types)

| Type           | Description              | MCC  | Blumon Rate (Credit) |
| -------------- | ------------------------ | ---- | -------------------- |
| `SALON`        | Hair salon, beauty salon | 7230 | 1.7%                 |
| `SPA`          | Spa, wellness center     | 7298 | 1.7%                 |
| `FITNESS`      | Gym, fitness center      | 7941 | 1.7%                 |
| `CLINIC`       | Medical clinic           | 8011 | 1.7%                 |
| `VETERINARY`   | Veterinary clinic        | 0742 | 1.7%                 |
| `AUTO_SERVICE` | Auto repair, car wash    | 7538 | 1.7%                 |
| `LAUNDRY`      | Laundry, dry cleaning    | 7210 | 1.7%                 |
| `REPAIR_SHOP`  | General repair services  | 7699 | 1.7%                 |

### HOSPITALITY (3 types)

| Type     | Description | MCC  | Blumon Rate (Credit) |
| -------- | ----------- | ---- | -------------------- |
| `HOTEL`  | Hotel       | 7011 | 2.1%                 |
| `HOSTEL` | Hostel      | 7011 | 2.1%                 |
| `RESORT` | Resort      | 7011 | 2.1%                 |

### ENTERTAINMENT (5 types)

| Type          | Description               | MCC  | Blumon Rate (Credit) |
| ------------- | ------------------------- | ---- | -------------------- |
| `CINEMA`      | Movie theater             | 7832 | 1.7%                 |
| `ARCADE`      | Arcade, game center       | 7993 | 1.7%                 |
| `EVENT_VENUE` | Event venue, banquet hall | 7941 | 1.7%                 |
| `NIGHTCLUB`   | Nightclub, disco          | 5813 | 2.3%                 |
| `BOWLING`     | Bowling alley             | 7933 | 1.7%                 |

### LEGACY (2 types - hidden from onboarding)

| Type               | Maps To      | Notes                           |
| ------------------ | ------------ | ------------------------------- |
| `HOTEL_RESTAURANT` | FOOD_SERVICE | Use `RESTAURANT` for new venues |
| `FITNESS_STUDIO`   | SERVICES     | Use `FITNESS` for new venues    |

### OTHER (1 type)

| Type    | Description                           |
| ------- | ------------------------------------- |
| `OTHER` | Catch-all for unclassified businesses |

## Code Locations

### Backend (Server) - Source of Truth

```
/prisma/schema.prisma
└── VenueType enum (search for "enum VenueType")

/src/utils/businessCategory.ts
├── BusinessCategory type
├── CATEGORY_MAPPING
├── CATEGORY_TERMINOLOGY (with plural forms)
├── getBusinessCategory()
├── isBusinessCategory()
├── getBusinessTypesForCategory()
└── getTerminology()

/src/services/pricing/blumon-mcc-lookup.service.ts
├── VENUE_TYPE_TO_SEARCH_TERM mapping
├── lookupRatesByVenueType()
├── lookupRatesByBusinessName()
└── getRatesByFamilia()

/src/data/blumon-pricing/
├── familias-tasas.json (22 business families with rates)
└── business-synonyms.json (195+ business synonyms to MCC)

/src/config/chatbot/schema.registry.ts
└── VENUE_TYPE_TO_INDUSTRY mapping (for AI schema routing)
```

### Frontend (Dashboard) - Must Stay in Sync

```
/src/types.ts
├── BusinessType enum (must match VenueType)
├── BusinessCategory type
├── CATEGORY_MAPPING
├── CATEGORY_TERMINOLOGY
└── getBusinessCategory()

/src/components/business-type-combobox.tsx
└── UI dropdown for type selection
```

## MCC Integration (Payment Processing)

### How MCC Lookup Works

```typescript
// Server: /src/services/pricing/blumon-mcc-lookup.service.ts

// 1. VenueType → Search Term
const VENUE_TYPE_TO_SEARCH_TERM: Record<string, string> = {
  RESTAURANT: 'restaurante', // → searches business-synonyms.json
  FAST_FOOD: 'comida rapida',
  RETAIL_STORE: 'retail',
  FITNESS: 'fitness',
  // ... 40+ mappings
}

// 2. Search Term → MCC + Familia
// From business-synonyms.json:
// "restaurante" → { mcc: "5812", familia: "Restaurantes" }

// 3. Familia → Rates
// From familias-tasas.json:
// "Restaurantes" → { credito: 2.3, debito: 1.68, internacional: 3.3, amex: 3.0 }
```

### Rate Variation by Category (Blumon)

| Familia           | Credit | Debit | International | AMEX |
| ----------------- | ------ | ----- | ------------- | ---- |
| Restaurantes      | 2.3%   | 1.68% | 3.3%          | 3.0% |
| Comida rapida     | 1.7%   | 1.35% | 3.3%          | 3.0% |
| Ventas al detalle | 1.53%  | 1.15% | 3.3%          | 3.0% |
| Farmacias         | 1.28%  | 1.0%  | 3.3%          | 3.0% |
| Hoteles           | 2.1%   | 1.63% | 3.3%          | 3.0% |
| Entretenimiento   | 1.7%   | 1.63% | 3.3%          | 3.0% |

### Where Rates Are Stored

MCC lookup results are stored in `ProviderCostStructure` table:

- `creditRate`, `debitRate`, `amexRate`, `internationalRate`
- `notes` field contains MCC metadata for audit

## UI Terminology by Category

The system adapts UI labels based on business category:

| Category      | Menu      | Item     | Order       | Table      |
| ------------- | --------- | -------- | ----------- | ---------- |
| FOOD_SERVICE  | Menu      | Platillo | Orden       | Mesa       |
| RETAIL        | Catalogo  | Producto | Venta       | Caja       |
| SERVICES      | Servicios | Servicio | Cita        | Estacion   |
| HOSPITALITY   | Servicios | Servicio | Reservacion | Habitacion |
| ENTERTAINMENT | Eventos   | Evento   | Entrada     | Sala       |
| OTHER         | Catalogo  | Item     | Orden       | Ubicacion  |

**Usage:**

```typescript
import { getTerminology } from '@/utils/businessCategory'

const terms = getTerminology(BusinessType.JEWELRY)
// terms = { menu: 'Catalogo', item: 'Producto', order: 'Venta', table: 'Caja' }
```

## Chatbot Schema Routing

VenueType determines which AI schema/prompts are used:

```typescript
// Server: /src/config/chatbot/schema.registry.ts

const VENUE_TYPE_TO_INDUSTRY = {
  // Food Service → restaurant config
  RESTAURANT: 'restaurant',
  BAR: 'restaurant',
  CAFE: 'restaurant',

  // Retail → retail config
  RETAIL_STORE: 'retail',
  JEWELRY: 'retail',

  // Special configs
  TELECOMUNICACIONES: 'telecom', // PlayTelecom special features
  HOTEL: 'hospitality',
  // ...
}
```

## Adding a New VenueType

When adding a new business type, update these files **in order**:

### 1. Database Schema (Server)

```prisma
// /prisma/schema.prisma
enum VenueType {
  // ... existing types
  NEW_TYPE  // Add in appropriate category section
}
```

Run migration:

```bash
npx prisma migrate dev --name add_new_type
```

### 2. Backend Category Mapping (Server)

```typescript
// /src/utils/businessCategory.ts
const CATEGORY_MAPPING = {
  // ...
  NEW_TYPE: 'RETAIL', // or appropriate category
}
```

### 3. MCC Lookup Mapping (Server)

```typescript
// /src/services/pricing/blumon-mcc-lookup.service.ts
const VENUE_TYPE_TO_SEARCH_TERM = {
  // ...
  NEW_TYPE: 'search term for mcc lookup',
}
```

If needed, add to `/src/data/blumon-pricing/business-synonyms.json`:

```json
{
  "new search term": {
    "mcc": "XXXX",
    "familia": "Familia Name",
    "nota": "Description"
  }
}
```

### 4. Chatbot Schema Mapping (Server)

```typescript
// /src/config/chatbot/schema.registry.ts
const VENUE_TYPE_TO_INDUSTRY = {
  // ...
  NEW_TYPE: 'retail', // or create new industry config
}
```

### 5. Frontend Types (Dashboard)

```typescript
// /src/types.ts
export enum BusinessType {
  // ...
  NEW_TYPE = 'NEW_TYPE',
}

const CATEGORY_MAPPING = {
  // ...
  [BusinessType.NEW_TYPE]: 'RETAIL',
}
```

### 6. Translations (Dashboard)

```json
// /src/locales/es/onboarding.json
{
  "businessTypes": {
    "NEW_TYPE": "Nuevo Tipo"
  }
}

// /src/locales/en/onboarding.json
{
  "businessTypes": {
    "NEW_TYPE": "New Type"
  }
}
```

## Onboarding UX Recommendation

The recommended pattern for business type selection is a **grouped dropdown** (like Square):

```
┌─────────────────────────────────────┐
│ Buscar tipo de negocio...           │
├─────────────────────────────────────┤
│ --- Alimentos y Bebidas ---         │
│   Restaurante                       │
│   Bar                               │
│   Cafeteria                         │
│ --- Comercio ---                    │
│   Tienda                            │
│   Joyeria                           │
│   Telecomunicaciones                │
│ --- Servicios ---                   │
│   Salon de belleza                  │
│   Gimnasio                          │
└─────────────────────────────────────┘
```

**Implementation**: See dashboard `business-type-combobox.tsx`

## Known Sync Issues

### TELECOMUNICACIONES

- In Prisma schema (server)
- In chatbot schema.registry.ts (server)
- **MISSING** from dashboard BusinessType enum
- **MISSING** from dashboard translations

### Legacy Types

- `HOTEL_RESTAURANT` and `FITNESS_STUDIO` in Prisma
- **MISSING** from dashboard - should be hidden from onboarding but functional

## References

- [Square Industry Solutions](https://squareup.com/us/en/industry)
- [Stripe MCC Guide](https://stripe.com/guides/merchant-category-codes)
- [Toast Restaurant Types](https://pos.toasttab.com/blog/restaurant-business-types)
- [ISO 18245 MCC Standard](https://en.wikipedia.org/wiki/Merchant_category_code)
