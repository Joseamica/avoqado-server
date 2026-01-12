# Serialized Inventory Module

Sistema de inventario para productos con identificadores únicos. Cada item tiene un código de barras/serial único y se vende
individualmente.

**Aplica para cualquier industria donde cada unidad es única:**

- **Telecom**: SIMs, tarjetas prepago (ICCID)
- **Joyería**: Anillos, piedras preciosas (Certificado GIA/IGI)
- **Electrónica**: Celulares, laptops, tablets (Serial Number)
- **Armas**: Pistolas, rifles (Serial ATF)
- **Automotriz**: Vehículos, motos (VIN)
- **Relojería**: Relojes de lujo (Serial de fábrica)
- **Coleccionables**: Arte, antigüedades (COA)
- **Equipo Médico**: Marcapasos, prótesis (UDI)
- **Gift Cards**: Tarjetas prepago (Código único)
- **Instrumentos**: Guitarras, violines (Serial)

---

## Tabla de Contenidos

1. [Conceptos Clave](#conceptos-clave)
2. [Arquitectura](#arquitectura)
3. [Modelos de Datos](#modelos-de-datos)
4. [API Endpoints](#api-endpoints)
5. [Flujos de Operación](#flujos-de-operación)
6. [Setup y Configuración](#setup-y-configuración)
7. [Diferencias con Inventario Normal](#diferencias-con-inventario-normal)
8. [Anti-patrones](#anti-patrones)

---

## Conceptos Clave

### Module System vs VenueFeature

| Concepto         | Propósito                              | Ejemplo                                   |
| ---------------- | -------------------------------------- | ----------------------------------------- |
| **VenueModule**  | Habilitar comportamiento/funcionalidad | SERIALIZED_INVENTORY, ATTENDANCE_TRACKING |
| **VenueFeature** | Control de facturación (Stripe)        | BASIC_POS, INVENTORY_MANAGEMENT           |

**VenueModule** controla **qué puede hacer** el venue. **VenueFeature** controla **qué paga** el venue.

### SerializedItem vs Inventory (FIFO)

| Aspecto           | SerializedItem                         | Inventory (FIFO)      |
| ----------------- | -------------------------------------- | --------------------- |
| **Tracking**      | Por unidad única                       | Por cantidad/batch    |
| **Identificador** | Código de barras único (ICCID, serial) | N/A                   |
| **Precio**        | Capturado al momento de venta          | Definido en Product   |
| **Ejemplo**       | SIM: `8901234567890123456`             | "5 kg de carne"       |
| **Deducción**     | Item se marca como SOLD                | FIFO resta de batches |

### ItemCategory vs MenuCategory

| Modelo           | Uso                                                  |
| ---------------- | ---------------------------------------------------- |
| **ItemCategory** | Para SerializedItems (Negra, Blanca, Roja para SIMs) |
| **MenuCategory** | Para Products en menú (Bebidas, Entradas, etc.)      |

Son modelos **completamente separados**.

---

## Arquitectura

### Flujo de Datos

```
┌─────────────────────────────────────────────────────────────┐
│                          TPV App                             │
├─────────────────────────────────────────────────────────────┤
│  1. Login → GET /tpv/v1/modules → Check SERIALIZED_INVENTORY │
│  2. If enabled → Show barcode scanner UI                     │
│  3. Scan → POST /tpv/v1/serialized-inventory/scan            │
│  4. Sell → POST /tpv/v1/serialized-inventory/sell            │
│     OR → POST /tpv/v1/orders/:orderId/serialized-item        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        Backend API                           │
├─────────────────────────────────────────────────────────────┤
│  ModuleService                                               │
│  ├─ isModuleEnabled(venueId, code)                          │
│  ├─ getModuleConfig(venueId, code) → Merged config          │
│  └─ enableModule(venueId, code, staffId, config, preset)    │
│                                                              │
│  SerializedInventoryService                                  │
│  ├─ scanItem(serialNumber) → Returns item or null           │
│  ├─ registerItem(venueId, serialNumber, categoryId)         │
│  ├─ markAsSold(itemId, orderId, staffId)                    │
│  └─ getCategories(venueId) → With stock counts              │
│                                                              │
│  OrderService (Extended)                                     │
│  ├─ addSerializedItemToOrder(venueId, orderId, input, ...)  │
│  └─ sellSerializedItem(venueId, input, staffId)             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        Database                              │
├─────────────────────────────────────────────────────────────┤
│  Module          → Definiciones globales con presets        │
│  VenueModule     → Módulos habilitados por venue            │
│  ItemCategory    → Categorías por venue (Negra, Blanca...)  │
│  SerializedItem  → Items individuales con barcode único     │
│  OrderItem       → Snapshot del item vendido (productName)  │
└─────────────────────────────────────────────────────────────┘
```

### Presets por Industria

Los presets permiten configuración rápida con terminología apropiada:

```typescript
// Telecom (SIMs, tarjetas prepago)
{ item: 'SIM', barcode: 'ICCID', category: 'Tipo de SIM', scan: 'Escanear SIM', register: 'Alta de SIM' }

// Jewelry (joyas, piedras preciosas)
{ item: 'Pieza', barcode: 'Certificado', category: 'Tipo de Piedra', scan: 'Escanear Certificado', register: 'Registrar Pieza' }

// Electronics (celulares, laptops, tablets)
{ item: 'Dispositivo', barcode: 'Número de Serie', category: 'Tipo de Dispositivo', scan: 'Escanear Serie', register: 'Registrar Dispositivo' }

// Firearms (armas de fuego - regulado)
{ item: 'Arma', barcode: 'Número de Serie', category: 'Tipo de Arma', scan: 'Escanear Serie', register: 'Registrar Arma' }

// Automotive (vehículos, motocicletas)
{ item: 'Vehículo', barcode: 'VIN', category: 'Tipo de Vehículo', scan: 'Escanear VIN', register: 'Registrar Vehículo' }

// Watches (relojes de lujo)
{ item: 'Reloj', barcode: 'Número de Serie', category: 'Marca/Modelo', scan: 'Escanear Serie', register: 'Registrar Reloj' }

// Collectibles (antigüedades, arte, coleccionables)
{ item: 'Pieza', barcode: 'Código de Autenticidad', category: 'Categoría', scan: 'Escanear Código', register: 'Registrar Pieza' }

// Medical Equipment (equipo médico serializado)
{ item: 'Equipo', barcode: 'Número de Serie', category: 'Tipo de Equipo', scan: 'Escanear Serie', register: 'Registrar Equipo' }

// Musical Instruments (instrumentos de alto valor)
{ item: 'Instrumento', barcode: 'Número de Serie', category: 'Tipo', scan: 'Escanear Serie', register: 'Registrar Instrumento' }

// Gift Cards / Vouchers (tarjetas de regalo prepago)
{ item: 'Tarjeta', barcode: 'Código', category: 'Denominación', scan: 'Escanear Código', register: 'Activar Tarjeta' }
```

### Casos de Uso por Industria

| Industria          | Ejemplo de Items           | Identificador Único               | Categorías Típicas        |
| ------------------ | -------------------------- | --------------------------------- | ------------------------- |
| **Telecom**        | SIMs, tarjetas prepago     | ICCID (19-20 dígitos)             | Negra, Blanca, Roja       |
| **Joyería**        | Anillos, collares, piedras | Certificado GIA/IGI               | Diamante, Oro, Plata      |
| **Electrónica**    | iPhones, laptops, tablets  | Serial number                     | Nuevo, Reacondicionado    |
| **Armas**          | Pistolas, rifles           | Serial ATF                        | Corta, Larga              |
| **Automotriz**     | Autos, motos               | VIN (17 caracteres)               | Nuevo, Seminuevo          |
| **Relojería**      | Rolex, Omega, Patek        | Serial de fábrica                 | Por marca                 |
| **Coleccionables** | Arte, antigüedades         | COA (Certificate of Authenticity) | Época, Material           |
| **Equipo Médico**  | Marcapasos, prótesis       | UDI (Unique Device ID)            | Categoría FDA             |
| **Gift Cards**     | Tarjetas prepago           | Código único                      | Denominación ($100, $500) |
| **Instrumentos**   | Guitarras, violines        | Serial de fabricante              | Tipo, Marca               |

---

## Modelos de Datos

### Module (Global)

```prisma
model Module {
  id            String   @id @default(cuid())
  code          String   @unique  // "SERIALIZED_INVENTORY"
  name          String             // "Inventario Serializado"
  description   String?
  defaultConfig Json               // Default labels & features
  presets       Json?              // Industry presets (telecom, jewelry, etc)
  configSchema  Json?              // JSON Schema for validation
  active        Boolean  @default(true)

  venueModules  VenueModule[]
}
```

### VenueModule

```prisma
model VenueModule {
  id          String   @id @default(cuid())
  venueId     String
  moduleId    String
  enabled     Boolean  @default(true)
  config      Json?    // Venue-specific overrides
  enabledAt   DateTime @default(now())
  enabledBy   String?  // Staff ID who enabled it

  venue       Venue    @relation(...)
  module      Module   @relation(...)

  @@unique([venueId, moduleId])
}
```

### ItemCategory

```prisma
model ItemCategory {
  id                      String   @id @default(cuid())
  venueId                 String
  name                    String           // "Negra", "Blanca", "Roja"
  description             String?
  color                   String?          // "#000000"
  sortOrder               Int      @default(0)
  requiresPreRegistration Boolean  @default(true)
  suggestedPrice          Decimal?
  active                  Boolean  @default(true)

  venue                   Venue    @relation(...)
  serializedItems         SerializedItem[]

  @@unique([venueId, name])
}
```

### SerializedItem

```prisma
model SerializedItem {
  id              String                 @id @default(cuid())
  venueId         String
  categoryId      String
  serialNumber    String                 // ICCID, serial único
  status          SerializedItemStatus   @default(AVAILABLE)
  registeredAt    DateTime               @default(now())
  registeredBy    String?                // Staff ID
  soldAt          DateTime?
  soldBy          String?
  orderId         String?                // Link to order when sold
  notes           String?

  venue           Venue          @relation(...)
  category        ItemCategory   @relation(...)
  order           Order?         @relation(...)

  @@unique([venueId, serialNumber])
  @@index([venueId, status])
}

enum SerializedItemStatus {
  AVAILABLE   // En inventario, listo para vender
  RESERVED    // Reservado (en carrito pero no pagado)
  SOLD        // Vendido
  RETURNED    // Devuelto
  DAMAGED     // Dañado/no vendible
}
```

### OrderItem (Snapshot Fields)

Cuando se vende un SerializedItem, el OrderItem captura:

```typescript
{
  orderId: "order_123",
  serializedItemId: "item_456",
  productName: "Negra",           // From ItemCategory.name
  productSku: "8901234567890123", // From SerializedItem.serialNumber
  unitPrice: 150.00,              // Entered by cashier at sale time
  quantity: 1,                    // Always 1 for serialized items
  // ... other OrderItem fields
}
```

**Importante:** `SerializedItem` NO tiene campo `price`. El precio se captura únicamente en `OrderItem.unitPrice` al momento de la venta.

---

## API Endpoints

### GET /tpv/v1/modules

Obtener módulos habilitados para el venue.

```typescript
// Response
{
  modules: [
    {
      code: "SERIALIZED_INVENTORY",
      name: "Inventario Serializado",
      enabled: true,
      config: {
        labels: { item: "SIM", barcode: "ICCID", ... },
        features: { allowUnregisteredSale: true, ... }
      }
    }
  ]
}
```

### GET /tpv/v1/serialized-inventory/categories

Obtener categorías con conteos de stock.

```typescript
// Response
{
  categories: [
    {
      id: 'cat_123',
      name: 'Negra',
      color: '#000000',
      requiresPreRegistration: true,
      availableCount: 45,
      soldCount: 123,
    },
  ]
}
```

### POST /tpv/v1/serialized-inventory/scan

Escanear código de barras.

```typescript
// Request
{ serialNumber: "8901234567890123456" }

// Response (item exists)
{
  found: true,
  item: {
    id: "item_123",
    serialNumber: "8901234567890123456",
    status: "AVAILABLE",
    category: { id: "cat_123", name: "Negra" }
  }
}

// Response (item not found)
{
  found: false,
  serialNumber: "8901234567890123456"
}
```

### POST /tpv/v1/serialized-inventory/register-batch

Registrar múltiples items (alta masiva).

```typescript
// Request
{
  categoryId: "cat_123",
  serialNumbers: ["8901234567890123456", "8901234567890123457"]
}

// Response
{
  created: 2,
  items: [...]
}
```

### POST /tpv/v1/serialized-inventory/sell

Venta rápida (crea orden + item en una transacción).

```typescript
// Request
{
  serialNumber: "8901234567890123456",
  price: 150.00,
  categoryId: "cat_123",      // Required if item not registered
  paymentMethodId: "pm_cash", // Optional
  notes: "Cliente nuevo"      // Optional
}

// Response
{
  order: { id: "order_789", status: "COMPLETED", ... },
  item: { id: "item_123", status: "SOLD", ... }
}
```

### POST /tpv/v1/orders/:orderId/serialized-item

Agregar item serializado a orden existente (carrito mixto).

```typescript
// Request
{
  serialNumber: "8901234567890123456",
  price: 150.00,
  categoryId: "cat_123",
  notes: null,
  expectedVersion: 5  // Optimistic concurrency
}

// Response
{
  order: { ... updated order with new item ... }
}
```

---

## Flujos de Operación

### Flujo 1: Venta Rápida (Quick Sell)

```
Cajero escanea SIM → Sistema busca item → Item existe?
                                          │
                     ┌────────────────────┴────────────────────┐
                     ▼                                         ▼
                   [SÍ]                                      [NO]
                     │                                         │
                     ▼                                         ▼
            Mostrar categoría               Pedir categoría al cajero
                     │                                         │
                     └──────────────┬──────────────────────────┘
                                    ▼
                          Pedir precio al cajero
                                    │
                                    ▼
                          POST /sell con precio
                                    │
                                    ▼
                   Crear Order + OrderItem + Marcar SOLD
                                    │
                                    ▼
                          Mostrar confirmación
```

### Flujo 2: Carrito Mixto

```
Cliente quiere: 2 Coca-Cola + 1 SIM

1. Cajero crea orden vacía
2. Agrega Product (Coca-Cola x2) → OrderItem normal
3. Escanea SIM → POST /orders/:orderId/serialized-item
4. Sistema crea OrderItem con snapshot del SIM
5. Cobrar todo junto
6. Al completar pago → SIM marcada como SOLD
```

### Flujo 3: Alta Masiva (Batch Register)

```
Gerente recibe caja de 100 SIMs
                    │
                    ▼
    Abrir pantalla de registro masivo
                    │
                    ▼
    Seleccionar categoría (Negra)
                    │
                    ▼
    Escanear SIM 1 → Agregar a lista
    Escanear SIM 2 → Agregar a lista
    ...
    Escanear SIM 100 → Agregar a lista
                    │
                    ▼
    POST /register-batch con 100 serials
                    │
                    ▼
    Sistema crea 100 SerializedItems
                    │
                    ▼
    Mostrar resumen: "100 SIMs registradas"
```

---

## Setup y Configuración

### 1. Crear Módulos Globales (Una vez)

```bash
cd avoqado-server
npx ts-node scripts/setup-modules.ts
```

Esto crea:

- `SERIALIZED_INVENTORY` con presets: telecom, jewelry, electronics
- `ATTENDANCE_TRACKING` con presets: strict, flexible

### 2. Habilitar para un Venue

```bash
npx ts-node scripts/setup-playtelecom.ts <venueId> <staffId>
```

Esto:

1. Habilita `SERIALIZED_INVENTORY` con preset `telecom`
2. Crea categorías: Negra, Blanca, Roja
3. Configura terminología (SIM, ICCID, etc.)

### 3. Verificar en TPV

Al hacer login en el TPV:

1. App llama `GET /tpv/v1/modules`
2. Si `SERIALIZED_INVENTORY` está habilitado, mostrar scanner UI
3. Usar terminología del config (labels)

---

## Diferencias con Inventario Normal

### Inventario Normal (FIFO)

```
┌─────────────────────────────────────────────────────────────┐
│ Product: "Coca-Cola"                                        │
│ ├─ SKU: "COCA-001"                                          │
│ ├─ Price: $25.00                                            │
│ └─ Inventory Batches:                                       │
│     ├─ Batch 1: qty=20, cost=$15, expiry=2025-03-01        │
│     └─ Batch 2: qty=30, cost=$16, expiry=2025-04-01        │
│                                                             │
│ On Sale: Deduct from oldest batch first (FIFO)             │
└─────────────────────────────────────────────────────────────┘
```

### Inventario Serializado

```
┌─────────────────────────────────────────────────────────────┐
│ Category: "Negra"                                           │
│ ├─ SerializedItem: ICCID "8901234567890123456" [AVAILABLE] │
│ ├─ SerializedItem: ICCID "8901234567890123457" [SOLD]      │
│ └─ SerializedItem: ICCID "8901234567890123458" [AVAILABLE] │
│                                                             │
│ On Sale: Mark specific item as SOLD (by barcode)           │
│ Price: Entered at sale time (not stored in item)           │
└─────────────────────────────────────────────────────────────┘
```

---

## Anti-patrones

### ❌ NUNCA hacer esto:

```typescript
// Anti-patrón 1: Código específico por cliente
if (venue.slug === 'playtelecom') {
  showBarcodeScanner()
}

// Anti-patrón 2: Código específico por industria
if (venue.type === 'TELECOMUNICACIONES') {
  enableSerializedInventory()
}

// Anti-patrón 3: Precio en SerializedItem
const item = await prisma.serializedItem.create({
  data: {
    serialNumber: '123',
    price: 150.0, // ❌ NO EXISTE ESTE CAMPO
  },
})
```

### ✅ SIEMPRE hacer esto:

```typescript
// Patrón correcto 1: Verificar módulo habilitado
const enabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
if (enabled) {
  showBarcodeScanner()
}

// Patrón correcto 2: Obtener config para terminología
const config = await moduleService.getModuleConfig(venueId, MODULE_CODES.SERIALIZED_INVENTORY)
const buttonLabel = config.labels.scan // "Escanear SIM"

// Patrón correcto 3: Precio en OrderItem
const orderItem = await prisma.orderItem.create({
  data: {
    orderId: order.id,
    serializedItemId: item.id,
    productName: category.name,
    productSku: item.serialNumber,
    unitPrice: input.price, // ✅ Precio capturado aquí
    quantity: 1,
  },
})
```

---

## Archivos de Referencia

| Archivo                                                            | Descripción                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `prisma/schema.prisma`                                             | Modelos: Module, VenueModule, ItemCategory, SerializedItem |
| `src/services/modules/module.service.ts`                           | ModuleService con enable/config/check                      |
| `src/services/serialized-inventory/serializedInventory.service.ts` | SerializedInventoryService                                 |
| `src/services/tpv/order.tpv.service.ts`                            | `addSerializedItemToOrder`, `sellSerializedItem`           |
| `src/routes/tpv.routes.ts`                                         | Endpoints TPV para módulos y serialized inventory          |
| `scripts/setup-modules.ts`                                         | Crear módulos globales                                     |
| `scripts/setup-playtelecom.ts`                                     | Habilitar para venue telecom                               |

---

## Estado de Implementación

- [x] **Schema**: Modelos Module, VenueModule, ItemCategory, SerializedItem
- [x] **ModuleService**: Enable, config, check functions
- [x] **SerializedInventoryService**: Scan, register, mark as sold
- [x] **OrderService Extensions**: Mixed cart support
- [x] **TPV Endpoints**: 6 endpoints para módulos y serialized inventory
- [x] **Setup Scripts**: setup-modules.ts, setup-playtelecom.ts
- [x] **TPV Android - Module System**: Repository, fetch at startup, cache
- [x] **TPV Android - LocationService**: GPS capture for clock-in/out
- [x] **TPV Android - Photo Verification**: Firebase Storage upload for clock-in
- [x] **TPV Android - Clock-out Photo**: Photo capture for clock-out (Completado 2025-01-06)
- [x] **TPV Android - Simplified Welcome**: "Vender" + "Alta" buttons (Completado - ya estaba implementado)
- [x] **TPV Android - Serialized Sale Screen**: Barcode scan → sell flow (Completado - ya estaba implementado)
- [x] **TPV Android - Inventory Register Screen**: Alta masiva (Completado - ya estaba implementado)
- [ ] **Dashboard UI**: Gestión de módulos y categorías

---

## TPV Android Implementation

### Module System (Fase 2 - Completado)

El TPV ahora carga los módulos en el **arranque de la app** (SplashScreen), antes del login:

```
App Startup → SplashScreen → Device Activated?
                                 ↓ YES
                          Fetch Modules (X-Venue-Id header)
                                 ↓
                          Cache in SecureStorage
                                 ↓
                          Navigate to Login
```

**Archivos clave:**

- `features/modules/domain/repository/ModulesRepository.kt` - Interface
- `features/modules/data/repository/ModulesRepositoryImpl.kt` - Implementation + cache
- `core/presentation/navigation/AppNavigation.kt` - Fetch at startup

**Endpoint semi-público:**

```
GET /tpv/modules
Headers:
  - Authorization: Bearer <token>  (si está logueado)
  - X-Venue-Id: <venueId>          (si no hay sesión, desde device activation)
```

Esto permite que features como Timeclock tengan la config correcta desde el inicio.

### GPS + Photo para Clock-in/out (Fase 3 - Completado ✅)

La configuración de attendance viene en el module config:

```json
{
  "code": "SERIALIZED_INVENTORY",
  "config": {
    "attendance": {
      "requireClockInPhoto": true,
      "requireClockInGps": true,
      "requireClockOutPhoto": true,
      "requireClockOutGps": false
    }
  }
}
```

**Flujo de Clock-in con foto + GPS:**

```
User taps Clock-in
       ↓
Check module config: requireClockInPhoto?
       ↓ YES
Show camera capture screen
       ↓
Upload to Firebase Storage (venues/{slug}/clockin/{date}/{staffId}_{timestamp}.jpg)
       ↓
Check module config: requireClockInGps?
       ↓ YES
Capture GPS coordinates
       ↓
POST /tpv/venues/:venueId/time-entries/clock-in
Body: {
  staffId, pin,
  checkInPhotoUrl: "https://firebase.storage/...",
  clockInLatitude: 19.4326,
  clockInLongitude: -99.1332,
  clockInAccuracy: 5.0
}
```

**Flujo de Clock-out con foto + GPS:**

```
User taps Clock-out
       ↓
Check module config: requireClockOutPhoto?
       ↓ YES
Show camera capture screen (same component as clock-in)
       ↓
Upload to Firebase Storage (venues/{slug}/clockout/{date}/{staffId}_{timestamp}.jpg)
       ↓
Check module config: requireClockOutGps?
       ↓ YES
Capture GPS coordinates
       ↓
POST /tpv/venues/:venueId/time-entries/clock-out
Body: {
  staffId, pin,
  checkOutPhotoUrl: "https://firebase.storage/...",
  clockOutLatitude: 19.4326,
  clockOutLongitude: -99.1332,
  clockOutAccuracy: 5.0
}
```

**Componentes de UI unificados:**

El estado `TimeclockState.RequiresPhoto` tiene un flag `isClockOut` para distinguir:

- `isClockOut = false` → Flujo de clock-in
- `isClockOut = true` → Flujo de clock-out

**Admin Skip:** Los roles ADMIN, MANAGER, OWNER y SUPERADMIN pueden saltar la verificación de foto.

**Archivos clave:**

- `core/location/LocationService.kt` - GPS capture via FusedLocationProvider
- `core/data/firebase/VerificationUploadManager.kt` - Firebase Storage upload (uploadClockInPhoto, uploadClockOutPhoto)
- `features/timeclock/presentation/TimeclockViewModel.kt` - Orchestrates both flows
- `features/timeclock/presentation/TimeclockState.kt` - RequiresPhoto state with isClockOut flag

**Backend TimeEntry fields:**

```prisma
model TimeEntry {
  // Check-in verification
  checkInPhotoUrl   String?  // Firebase Storage URL
  clockInLatitude   Float?
  clockInLongitude  Float?
  clockInAccuracy   Float?

  // Check-out verification
  checkOutPhotoUrl  String?
  clockOutLatitude  Float?
  clockOutLongitude Float?
  clockOutAccuracy  Float?
}
```

---

### Simplified Welcome Screen (Fase 4 - Completado ✅)

Cuando el módulo SERIALIZED_INVENTORY está habilitado y `config.ui.simplifiedOrderFlow = true`, el WelcomeScreen muestra solo dos botones:

```
┌─────────────────────────────────────────┐
│              Welcome Screen              │
├─────────────────────────────────────────┤
│                                          │
│     ┌──────────────────────────────┐    │
│     │     📦  Vender              │    │
│     │   (Scan & Quick Sell)       │    │
│     └──────────────────────────────┘    │
│                                          │
│     ┌──────────────────────────────┐    │
│     │     📝  Alta de Productos   │    │  ← Solo si tiene permiso
│     │   (Registrar Inventario)     │    │
│     └──────────────────────────────┘    │
│                                          │
└─────────────────────────────────────────┘
```

**Archivos clave:**

- `core/presentation/screens/WelcomeScreen.kt` - Detects simplified mode from module config
- `core/presentation/navigation/AppNavigation.kt` - Routes to SerializedSale/SerializedInventory

**Lógica:**

```kotlin
val isSimplifiedMode = modulesRepository
    .getModuleConfig(ModulesRepository.MODULE_SERIALIZED_INVENTORY)
    ?.ui?.simplifiedOrderFlow == true

if (isSimplifiedMode) {
    // Show only "Vender" + "Alta" buttons
} else {
    // Show normal menu with all options
}
```

---

### Serialized Sale Screen (Fase 5 - Completado ✅)

Pantalla de venta rápida para items serializados (Vender):

```
Scan Barcode
    ↓
POST /tpv/serialized-inventory/scan
    ↓
┌─────────────────────────────────────────┐
│ ✓ SIM Disponible                        │
│ ICCID: 8901234567890123456              │
│ Categoría: SIM Negra                    │
│ Precio sugerido: $150                   │
├─────────────────────────────────────────┤
│ Precio de venta: $____                  │
│                                         │
│     [Confirmar Venta]                   │
└─────────────────────────────────────────┘
    ↓
POST /tpv/serialized-inventory/sell
    ↓
Navigate to PaymentScreen with orderId
```

**Estados del scan:** | Status | UI | Siguiente Paso | |--------|-----|----------------| | `available` | ✅ Mostrar info + precio sugerido |
Confirmar venta | | `not_registered` | ⚠️ Selector de categoría | Seleccionar categoría → Confirmar | | `already_sold` | ❌ Error con fecha
de venta | Escanear otro | | `module_disabled` | ❌ Error - módulo no habilitado | N/A |

**Archivos clave:**

- `features/serialized_sale/presentation/SerializedSaleScreen.kt` - UI
- `features/serialized_sale/presentation/SerializedSaleViewModel.kt` - Business logic
- `features/serialized_sale/domain/repository/SerializedSaleRepository.kt` - API calls

**Labels dinámicos:** La pantalla usa los labels del module config:

```kotlin
val labels = modulesRepository.getModuleConfig(...)?.labels
val itemLabel = labels?.item ?: "Artículo"      // "SIM" para Telecom
val barcodeLabel = labels?.barcode ?: "Código"  // "ICCID" para Telecom
```

---

### Inventory Register Screen (Fase 6 - Completado ✅)

Pantalla de alta masiva de productos (Alta de Productos):

```
┌─────────────────────────────────────────┐
│ 1. Selecciona categoría                 │
│   ┌──────────────────────────────────┐  │
│   │ ○ SIM Negra (120 total)         │  │
│   │ ● SIM Blanca (85 total) ✓       │  │
│   │ ○ SIM Roja (45 total)           │  │
│   └──────────────────────────────────┘  │
├─────────────────────────────────────────┤
│ 2. Escanea SIMs                         │
│   [Iniciar Escaneo]                     │
│                                         │
│   ICCIDs escaneados (5):                │
│   1. 8901234567890123456  ✕             │
│   2. 8901234567890123457  ✕             │
│   3. 8901234567890123458  ✕             │
│   ...                                   │
├─────────────────────────────────────────┤
│ 3. Registrar 5 SIMs                     │
│   [Registrar SIMs]                      │
└─────────────────────────────────────────┘
```

**Modo escaneo continuo:**

- El scanner no se cierra después de cada escaneo
- Muestra contador en overlay: "5 escaneados"
- Feedback inmediato: "✓ Agregado" o "Ya escaneado"
- Botón "Listo" para terminar

**Archivos clave:**

- `features/serialized_inventory/presentation/SerializedInventoryScreen.kt` - UI
- `features/serialized_inventory/presentation/SerializedInventoryViewModel.kt` - Business logic
- `features/serialized_inventory/domain/model/InventoryScanResult.kt` - Scan result types

**Permisos:**

- `serialized-inventory:sell` - Requerido para vender (Vender screen)
- `serialized-inventory:create` - Requerido para registrar (Alta screen)

---

**Última actualización:** 2025-01-06
