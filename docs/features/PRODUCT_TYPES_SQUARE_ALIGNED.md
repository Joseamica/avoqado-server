# Product Types - Square-Aligned Architecture

## Executive Summary

Implementación de tipos de productos alineada con la arquitectura real de Square API, basada en análisis de su documentación oficial.

**Fecha de análisis:** Enero 2026
**Fuentes:** [Square CatalogItemProductType](https://developer.squareup.com/reference/square/enums/CatalogItemProductType), [CatalogItem Object](https://developer.squareup.com/reference/square/objects/CatalogItem)

---

## Hallazgos Clave de Square API

### 1. ProductType es UN solo nivel (no 2)

Square usa un único enum `CatalogItemProductType`:

```typescript
enum CatalogItemProductType {
  REGULAR              // Productos físicos normales (default)
  FOOD_AND_BEV         // Comida Y bebida (UN solo tipo)
  APPOINTMENTS_SERVICE // Servicios agendables
  EVENT                // Eventos con tickets
  DIGITAL              // Productos digitales
  DONATION             // Donaciones
  GIFT_CARD            // Tarjetas de regalo (deprecated)
}
```

### 2. Alcohol es un BOOLEAN, no un tipo

```typescript
interface CatalogItem {
  product_type: 'FOOD_AND_BEV'
  is_alcoholic: boolean  // ← Separado del tipo
}
```

### 3. Detalles de F&B son un objeto estructurado

```typescript
food_and_beverage_details: {
  calorie_count: number
  dietary_preferences: DietaryPreference[]
  ingredients: Ingredient[]
}
```

### 4. Combos/Bundles NO son tipos de producto

- Combos: Feature separada (2025+), no un tipo
- Bundles: Agrupación de items existentes
- Se manejan con relaciones, no con el enum

---

## Arquitectura Propuesta para Avoqado

### Nuevo Enum ProductType

```prisma
enum ProductType {
  // Productos físicos (default)
  REGULAR              // Merchandise, retail items, productos genéricos

  // Comida y bebida (restaurantes, cafeterías, bares)
  FOOD_AND_BEV         // Reemplaza FOOD + BEVERAGE + ALCOHOL

  // Servicios
  SERVICE              // Servicios generales (lavado de auto, etc.)
  APPOINTMENTS_SERVICE // Servicios agendables (cortes, masajes, citas médicas)

  // Otros tipos
  EVENT                // Eventos con tickets (conciertos, clases, experiencias)
  DIGITAL              // Productos digitales (ebooks, cursos, PDFs)
  DONATION             // Donaciones (redondeo, causas, tips a staff)

  // Legacy/Catch-all
  OTHER                // Catch-all para casos especiales
}
```

### Migración desde Enum Actual

| Actual | Nuevo | Notas |
|--------|-------|-------|
| `FOOD` | `FOOD_AND_BEV` | + `isAlcoholic: false` |
| `BEVERAGE` | `FOOD_AND_BEV` | + `isAlcoholic: false` |
| `ALCOHOL` | `FOOD_AND_BEV` | + `isAlcoholic: true` |
| `RETAIL` | `REGULAR` | Renombrado |
| `SERVICE` | `SERVICE` | Sin cambio |
| `OTHER` | `OTHER` | Sin cambio |

### Nuevos Campos en Product Model

```prisma
model Product {
  // ... campos existentes ...

  type ProductType @default(FOOD)  // Keep FOOD for backwards compatibility (contextual defaults via API)

  // ═══════════════════════════════════════════════════════════════
  // NUEVOS CAMPOS ALINEADOS CON SQUARE
  // ═══════════════════════════════════════════════════════════════

  // Alcohol flag (como Square)
  isAlcoholic Boolean @default(false)  // Solo relevante si type = FOOD_AND_BEV

  // POS Display
  kitchenName  String?  // Nombre corto para pantalla de cocina (max 50)
  abbreviation String?  // Texto ultra-corto para POS (max 24, como Square)

  // Service-specific
  duration Int?  // Duración en minutos (para SERVICE y APPOINTMENTS_SERVICE)

  // Event-specific
  eventDate     DateTime?
  eventTime     String?    // "19:00" formato HH:mm
  eventEndTime  String?    // "22:00" formato HH:mm
  eventCapacity Int?       // Capacidad máxima
  eventLocation String?    // Ubicación del evento

  // Digital-specific
  downloadUrl     String?  // URL de descarga
  downloadLimit   Int?     // Límite de descargas por compra
  fileSize        String?  // "15 MB", "2.3 GB"

  // Donation-specific
  suggestedAmounts Decimal[]  // [5.00, 10.00, 25.00, 50.00]
  allowCustomAmount Boolean @default(true)
  donationCause    String?   // "Propinas para staff", "Cruz Roja", etc.

  // ═══════════════════════════════════════════════════════════════
  // CAMPOS EXISTENTES QUE SE MANTIENEN (ya alineados con Square)
  // ═══════════════════════════════════════════════════════════════

  // tags      String[]  ← Ya existe, equivalente a dietary_preferences
  // allergens String[]  ← Ya existe, equivalente a ingredients[].allergens
  // calories  Int?      ← Ya existe, equivalente a calorie_count
  // prepTime  Int?      ← Ya existe
}
```

---

## Mapeo de Campos por Tipo

### FOOD_AND_BEV (Comida y Bebida)

| Campo | Uso | Requerido |
|-------|-----|-----------|
| `isAlcoholic` | Indica si requiere +18 | No (default: false) |
| `kitchenName` | Nombre para cocina | No |
| `abbreviation` | Texto corto POS | No |
| `prepTime` | Tiempo de preparación | No |
| `calories` | Información nutricional | No |
| `tags` | Vegetariano, vegano, etc. | No |
| `allergens` | Alérgenos | No |
| `cookingNotes` | Notas de preparación | No |

### REGULAR (Productos Físicos)

| Campo | Uso | Requerido |
|-------|-----|-----------|
| `trackInventory` | Seguimiento de stock | Recomendado |
| `unit` | Unidad de medida | Si trackInventory |
| `cost` | Costo del producto | No |

### SERVICE / APPOINTMENTS_SERVICE

| Campo | Uso | Requerido |
|-------|-----|-----------|
| `duration` | Duración en minutos | Recomendado |
| `trackInventory` | Siempre `false` | N/A |

### EVENT

| Campo | Uso | Requerido |
|-------|-----|-----------|
| `eventDate` | Fecha del evento | Sí |
| `eventTime` | Hora de inicio | Sí |
| `eventEndTime` | Hora de fin | No |
| `eventCapacity` | Capacidad máxima | No |
| `eventLocation` | Ubicación | No |
| `trackInventory` | Para tickets limitados | Opcional |

### DIGITAL

| Campo | Uso | Requerido |
|-------|-----|-----------|
| `downloadUrl` | URL del archivo | Sí |
| `downloadLimit` | Límite de descargas | No |
| `fileSize` | Tamaño del archivo | No |
| `trackInventory` | Siempre `false` | N/A |

### DONATION

| Campo | Uso | Requerido |
|-------|-----|-----------|
| `suggestedAmounts` | Montos sugeridos | No |
| `allowCustomAmount` | Permitir monto libre | No (default: true) |
| `donationCause` | Descripción de la causa | No |
| `trackInventory` | Siempre `false` | N/A |

---

## Plan de Implementación

### FASE 1: Schema Migration (Backend)

**Paso 1.1: Agregar nuevos campos al Product**

```prisma
// prisma/schema.prisma

model Product {
  // ... existing fields ...

  // NEW: Alcohol flag
  isAlcoholic Boolean @default(false)

  // NEW: POS Display
  kitchenName  String?
  abbreviation String?

  // NEW: Service fields
  duration Int?

  // NEW: Event fields
  eventDate     DateTime?
  eventTime     String?
  eventEndTime  String?
  eventCapacity Int?
  eventLocation String?

  // NEW: Digital fields
  downloadUrl   String?
  downloadLimit Int?
  fileSize      String?

  // NEW: Donation fields
  suggestedAmounts  Decimal[] @default([])
  allowCustomAmount Boolean   @default(true)
  donationCause     String?
}
```

**Paso 1.2: Agregar nuevos valores al enum**

```prisma
enum ProductType {
  // Existing (to keep)
  FOOD      // Will be deprecated, kept for backwards compatibility
  BEVERAGE  // Will be deprecated
  ALCOHOL   // Will be deprecated
  RETAIL    // Will be deprecated
  SERVICE
  OTHER

  // NEW values
  REGULAR
  FOOD_AND_BEV
  APPOINTMENTS_SERVICE
  EVENT
  DIGITAL
  DONATION
}
```

**Paso 1.3: Crear migración**

```bash
npx prisma migrate dev --name add_square_aligned_product_fields
```

### FASE 2: Data Migration

**Script de migración de datos existentes:**

```typescript
// scripts/migrate-product-types.ts

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function migrateProductTypes() {
  // FOOD → FOOD_AND_BEV + isAlcoholic: false
  await prisma.product.updateMany({
    where: { type: 'FOOD' },
    data: {
      type: 'FOOD_AND_BEV',
      isAlcoholic: false
    }
  })

  // BEVERAGE → FOOD_AND_BEV + isAlcoholic: false
  await prisma.product.updateMany({
    where: { type: 'BEVERAGE' },
    data: {
      type: 'FOOD_AND_BEV',
      isAlcoholic: false
    }
  })

  // ALCOHOL → FOOD_AND_BEV + isAlcoholic: true
  await prisma.product.updateMany({
    where: { type: 'ALCOHOL' },
    data: {
      type: 'FOOD_AND_BEV',
      isAlcoholic: true
    }
  })

  // RETAIL → REGULAR
  await prisma.product.updateMany({
    where: { type: 'RETAIL' },
    data: { type: 'REGULAR' }
  })

  console.log('Migration complete!')
}

migrateProductTypes()
```

### FASE 3: Backend Service Updates

**Archivo:** `src/services/dashboard/product.dashboard.service.ts`

```typescript
// Validaciones por tipo de producto
function validateProductByType(data: CreateProductDto) {
  switch (data.type) {
    case 'FOOD_AND_BEV':
      // isAlcoholic es opcional, default false
      if (data.kitchenName && data.kitchenName.length > 50) {
        throw new AppError('Kitchen name must be 50 characters or less', 400)
      }
      break

    case 'SERVICE':
    case 'APPOINTMENTS_SERVICE':
      // Servicios NO pueden tener inventario
      if (data.trackInventory) {
        throw new AppError('Services cannot track inventory', 400)
      }
      break

    case 'EVENT':
      if (!data.eventDate) {
        throw new AppError('Event date is required for event products', 400)
      }
      break

    case 'DIGITAL':
      if (!data.downloadUrl) {
        throw new AppError('Download URL is required for digital products', 400)
      }
      // Digital NO puede tener inventario
      if (data.trackInventory) {
        throw new AppError('Digital products cannot track inventory', 400)
      }
      break

    case 'DONATION':
      // Donaciones NO pueden tener inventario
      if (data.trackInventory) {
        throw new AppError('Donations cannot track inventory', 400)
      }
      break
  }
}
```

### FASE 4: Frontend - ProductWizardDialog

**Nuevo Step 0: Selección de tipo**

```tsx
// src/pages/Inventory/components/ProductTypeSelector.tsx

const productTypes = [
  {
    type: 'FOOD_AND_BEV',
    icon: Utensils,
    gradient: 'from-orange-500/20 to-orange-500/5',
    recommended: ['RESTAURANT', 'CAFE', 'BAR', 'FOOD_TRUCK']
  },
  {
    type: 'REGULAR',
    icon: Package,
    gradient: 'from-green-500/20 to-green-500/5',
    recommended: ['RETAIL', 'BOUTIQUE', 'GROCERY']
  },
  {
    type: 'SERVICE',
    icon: Clock,
    gradient: 'from-blue-500/20 to-blue-500/5',
    recommended: ['SALON', 'SPA', 'GYM']
  },
  {
    type: 'APPOINTMENTS_SERVICE',
    icon: Calendar,
    gradient: 'from-purple-500/20 to-purple-500/5',
    recommended: ['CLINIC', 'SALON', 'CONSULTING']
  },
  {
    type: 'EVENT',
    icon: Ticket,
    gradient: 'from-pink-500/20 to-pink-500/5',
    recommended: ['ENTERTAINMENT', 'VENUE', 'GYM']
  },
  {
    type: 'DIGITAL',
    icon: Download,
    gradient: 'from-cyan-500/20 to-cyan-500/5',
    recommended: []  // Disponible para todos
  },
  {
    type: 'DONATION',
    icon: Heart,
    gradient: 'from-red-500/20 to-red-500/5',
    recommended: []  // Disponible para todos
  },
  {
    type: 'OTHER',
    icon: HelpCircle,
    gradient: 'from-gray-500/20 to-gray-500/5',
    recommended: []
  }
]
```

**Step 1: Campos condicionales**

```tsx
// Dentro de ProductWizardDialog Step 1

{/* Solo para FOOD_AND_BEV */}
{selectedType === 'FOOD_AND_BEV' && (
  <>
    <FormField
      control={form.control}
      name="isAlcoholic"
      render={({ field }) => (
        <FormItem className="flex items-center gap-3">
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
          <FormLabel>Contiene alcohol (+18)</FormLabel>
        </FormItem>
      )}
    />

    <FormField
      control={form.control}
      name="kitchenName"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Nombre para cocina</FormLabel>
          <FormControl>
            <Input {...field} maxLength={50} placeholder="Ej: Hamburguesa Doble" />
          </FormControl>
          <FormDescription>
            Nombre corto que aparece en la pantalla de cocina
          </FormDescription>
        </FormItem>
      )}
    />
  </>
)}

{/* Solo para SERVICE / APPOINTMENTS_SERVICE */}
{['SERVICE', 'APPOINTMENTS_SERVICE'].includes(selectedType) && (
  <FormField
    control={form.control}
    name="duration"
    render={({ field }) => (
      <FormItem>
        <FormLabel>Duración (minutos)</FormLabel>
        <FormControl>
          <Input type="number" {...field} min={1} max={1440} />
        </FormControl>
      </FormItem>
    )}
  />
)}

{/* Solo para EVENT */}
{selectedType === 'EVENT' && (
  <>
    <FormField name="eventDate" ... />
    <FormField name="eventTime" ... />
    <FormField name="eventCapacity" ... />
    <FormField name="eventLocation" ... />
  </>
)}

{/* Solo para DIGITAL */}
{selectedType === 'DIGITAL' && (
  <>
    <FormField name="downloadUrl" ... />
    <FormField name="downloadLimit" ... />
    <FormField name="fileSize" ... />
  </>
)}

{/* Solo para DONATION */}
{selectedType === 'DONATION' && (
  <>
    <FormField name="suggestedAmounts" ... />
    <FormField name="allowCustomAmount" ... />
    <FormField name="donationCause" ... />
  </>
)}
```

### FASE 5: Traducciones

**`src/locales/es/inventory.json`:**

```json
{
  "productTypes": {
    "REGULAR": {
      "title": "Producto físico",
      "description": "Artículos de venta al por menor (ropa, mercancía, etc.)"
    },
    "FOOD_AND_BEV": {
      "title": "Alimentos y bebidas",
      "description": "Platillos y bebidas preparadas"
    },
    "SERVICE": {
      "title": "Servicio",
      "description": "Servicios generales (lavado, limpieza, etc.)"
    },
    "APPOINTMENTS_SERVICE": {
      "title": "Servicio con cita",
      "description": "Servicios que requieren agendar (cortes, masajes, consultas)"
    },
    "EVENT": {
      "title": "Evento",
      "description": "Boletos para eventos, clases o experiencias"
    },
    "DIGITAL": {
      "title": "Producto digital",
      "description": "Archivos descargables (eBooks, cursos, música)"
    },
    "DONATION": {
      "title": "Donación",
      "description": "Donaciones para causas o propinas"
    },
    "OTHER": {
      "title": "Otro",
      "description": "Artículos que no encajan en otras categorías"
    }
  },
  "fields": {
    "isAlcoholic": "Contiene alcohol (+18)",
    "kitchenName": "Nombre para cocina",
    "kitchenNameHelp": "Nombre corto que aparece en la pantalla de cocina (máx. 50 caracteres)",
    "abbreviation": "Abreviatura POS",
    "abbreviationHelp": "Texto ultra-corto para el punto de venta (máx. 24 caracteres)",
    "duration": "Duración",
    "durationMinutes": "minutos",
    "eventDate": "Fecha del evento",
    "eventTime": "Hora de inicio",
    "eventEndTime": "Hora de fin",
    "eventCapacity": "Capacidad",
    "eventLocation": "Ubicación",
    "downloadUrl": "URL de descarga",
    "downloadLimit": "Límite de descargas",
    "fileSize": "Tamaño del archivo",
    "suggestedAmounts": "Montos sugeridos",
    "allowCustomAmount": "Permitir monto personalizado",
    "donationCause": "Causa de la donación"
  }
}
```

---

## Reglas de Negocio por Tipo

### Inventario

| Tipo | `trackInventory` | Razón |
|------|------------------|-------|
| REGULAR | ✅ Permitido | Productos físicos con stock |
| FOOD_AND_BEV | ✅ Permitido | Ingredientes y recetas |
| SERVICE | ❌ Prohibido | No tiene stock físico |
| APPOINTMENTS_SERVICE | ❌ Prohibido | No tiene stock físico |
| EVENT | ⚠️ Opcional | Solo para tickets limitados |
| DIGITAL | ❌ Prohibido | Infinito por naturaleza |
| DONATION | ❌ Prohibido | No aplica |

### Validaciones +18

| Tipo | Validación |
|------|------------|
| FOOD_AND_BEV + `isAlcoholic: true` | Requiere verificación de edad |
| Otros | No requiere |

### Wizard Flow

| Tipo | Steps |
|------|-------|
| FOOD_AND_BEV | Type → Basic Info + Alcohol → Inventory → Confirm |
| REGULAR | Type → Basic Info → Inventory → Confirm |
| SERVICE | Type → Basic Info + Duration → Confirm (skip inventory) |
| APPOINTMENTS_SERVICE | Type → Basic Info + Duration → Confirm (skip inventory) |
| EVENT | Type → Basic Info + Event Details → Inventory? → Confirm |
| DIGITAL | Type → Basic Info + Download → Confirm (skip inventory) |
| DONATION | Type → Basic Info + Amounts → Confirm (skip inventory) |

---

## Backwards Compatibility

### Deprecación Gradual

Los tipos legacy (`FOOD`, `BEVERAGE`, `ALCOHOL`, `RETAIL`) se mantienen en el enum pero:

1. **UI**: No se muestran como opciones en el wizard
2. **API**: Se aceptan pero se migran automáticamente
3. **Queries**: Se incluyen en filtros de `FOOD_AND_BEV` / `REGULAR`

```typescript
// En queries, mapear legacy a nuevo
function normalizeProductType(type: ProductType): ProductType {
  const legacyMap = {
    'FOOD': 'FOOD_AND_BEV',
    'BEVERAGE': 'FOOD_AND_BEV',
    'ALCOHOL': 'FOOD_AND_BEV',
    'RETAIL': 'REGULAR'
  }
  return legacyMap[type] || type
}
```

### TPV Compatibility

El TPV actual usa `ProductType` para lógica de negocio:
- Validación +18 para alcohol
- Filtros por tipo

**Cambio requerido en TPV:**
```kotlin
// Antes
if (product.type == ProductType.ALCOHOL) { requireAgeVerification() }

// Después
if (product.type == ProductType.FOOD_AND_BEV && product.isAlcoholic) { requireAgeVerification() }
```

---

## Timeline Estimado

| Fase | Duración | Descripción |
|------|----------|-------------|
| **Fase 1** | 1 día | Schema migration (campos nuevos) |
| **Fase 2** | 0.5 día | Data migration script |
| **Fase 3** | 2 días | Backend service updates + validaciones |
| **Fase 4** | 3 días | Frontend wizard refactor |
| **Fase 5** | 0.5 día | Traducciones |
| **Testing** | 2 días | E2E testing |
| **TPV Update** | 1 día | Actualizar lógica de alcohol |

**Total: ~10 días**

---

## Checklist de Verificación

- [x] Schema migration aplicada (enum + nuevos campos en Product)
- [x] Data migration script creado (`scripts/migrate-product-types-to-square.ts`)
- [x] Backend validaciones por tipo funcionando (`validateProductByType()`)
- [x] Zod schemas actualizados con nuevos campos
- [x] Endpoint `GET /venues/:venueId/product-types` implementado
- [x] Endpoint `GET /product-types` (reference) implementado
- [ ] Data migration ejecutada en producción
- [ ] Wizard muestra tipos correctos (frontend)
- [ ] Campos condicionales aparecen según tipo (frontend)
- [ ] Servicios/Digital/Donation saltan inventory
- [ ] isAlcoholic funciona para validación +18
- [ ] TPV actualizado para nueva lógica de alcohol
- [ ] Traducciones completas (es/en)
- [ ] Tests pasando

### Estado Actual (Enero 2026)

**Backend completado:**
- ✅ Prisma schema con nuevos tipos y campos
- ✅ Migración de base de datos aplicada
- ✅ Script de migración de datos listo (dry-run verificado)
- ✅ Validaciones de servicio implementadas
- ✅ Esquemas Zod actualizados
- ✅ Endpoints de product-types creados
- ✅ Documentación actualizada

**Pendiente:**
- ⏳ Ejecutar migración de datos en producción
- ⏳ Frontend: ProductWizardDialog actualizado
- ⏳ Frontend: Traducciones
- ⏳ TPV: Actualizar lógica de alcohol

---

## Referencias

- [Square CatalogItemProductType](https://developer.squareup.com/reference/square/enums/CatalogItemProductType)
- [Square CatalogItem Object](https://developer.squareup.com/reference/square/objects/CatalogItem)
- [Square CatalogItemFoodAndBeverageDetails](https://developer.squareup.com/reference/square/objects/CatalogItemFoodAndBeverageDetails)
