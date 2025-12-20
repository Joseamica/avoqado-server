# Architecture: Configuration-Driven Multi-Industry System

## Overview

Este documento describe la arquitectura que permite a Avoqado servir múltiples industrias (Telecom, Retail, Restaurantes) con un único codebase, sin código específico por cliente.

---

## Patrones de Referencia (Industria)

| Empresa | Patrón | Cómo lo usan |
|---------|--------|--------------|
| **Salesforce** | Metadata-Driven | Custom fields/objects por tenant |
| **Shopify** | Metafields | Key-value pairs por merchant |
| **Square** | Industry Modes | Una app, múltiples modos por industria |
| **Toast** | Multi-Location Config | Configuración por ubicación |

**Avoqado usa:** Configuration-Driven (similar a Square) + campos opcionales

---

## Arquitectura de Configuración

### 1. Estructura de Datos

```
VenueSettings.industryConfig (Json)
       │
       ▼
┌─────────────────────────────────────┐
│  {                                  │
│    attendance: {                    │
│      enabled: true,                 │
│      requirePhoto: true,            │
│      requireGPS: true,              │
│      notifyManager: true            │
│    },                               │
│    balance: {                       │
│      enabled: true,                 │
│      trackCash: true,               │
│      trackCard: true,               │
│      requireDepositValidation: true │
│    },                               │
│    hierarchy: {                     │
│      managerScopedToStores: true    │
│    },                               │
│    roleLabels: {                    │
│      WAITER: "Promotor",            │
│      MANAGER: "Gerente"             │
│    }                                │
│  }                                  │
└─────────────────────────────────────┘
```

### 2. Flujo de Configuración

```
┌──────────────────┐
│ Venue creado     │
│ type: ELECTRONICS│
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────┐
│ ¿Tiene industryConfig custom?    │
│                                  │
│  NO → Usa TELECOM_CONFIG default │
│  SÍ → Merge con defaults         │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ getIndustryConfig(venue)         │
│ retorna config final             │
└──────────────────────────────────┘
```

### 3. Archivos de Configuración

```
src/config/industry/
├── index.ts              # Exports y getIndustryConfig()
├── types.ts              # IndustryConfig interface
├── defaults.ts           # DEFAULT_CONFIG
├── telecom.config.ts     # TELECOM_CONFIG
├── restaurant.config.ts  # RESTAURANT_CONFIG
└── retail.config.ts      # RETAIL_CONFIG
```

---

## Principios de Diseño

### 1. Campos Opcionales (Nullable)

```prisma
model TimeEntry {
  // Campos existentes (siempre presentes)
  clockInTime  DateTime
  clockOutTime DateTime?

  // Campos nuevos (opcionales, config-driven)
  checkInPhotoUrl  String?   // null si config.attendance.requirePhoto = false
  checkInLatitude  Decimal?  // null si config.attendance.requireGPS = false
  checkInLongitude Decimal?
}
```

**Impacto en venues existentes:** NINGUNO (campos null por default)

### 2. Defaults Seguros

```prisma
model StaffVenue {
  // Existentes
  totalSales Decimal @default(0)
  totalTips  Decimal @default(0)

  // Nuevos (default 0, no rompen nada)
  cashBalance    Decimal @default(0)
  pendingDeposit Decimal @default(0)
}
```

**Impacto en venues existentes:** NINGUNO (defaults a 0)

### 3. UI Condicional

```tsx
// En Sidebar
{config.attendance.enabled && (
  <NavItem to="/attendance">Asistencia</NavItem>
)}

{config.balance.enabled && (
  <NavItem to="/balance">Saldos</NavItem>
)}
```

**Impacto en venues existentes:** NINGUNO (no renderiza si disabled)

### 4. Endpoints Adicionales (No Modifican)

```typescript
// Existente - NO SE TOCA
POST /tpv/venues/:venueId/time-entries/clock-in

// Nuevo - ADICIONAL
POST /tpv/venues/:venueId/deposits
GET  /tpv/venues/:venueId/staff/:staffId/balance
```

**Impacto en venues existentes:** NINGUNO (rutas nuevas)

---

## Validación por Configuración

### Patrón en Servicios

```typescript
// src/services/tpv/time-entry.tpv.service.ts

async function clockIn(params: ClockInParams) {
  const venue = await getVenueWithSettings(params.venueId)
  const config = getIndustryConfig(venue)

  // Validación condicional
  if (config.attendance.enabled) {
    if (config.attendance.requirePhoto && !params.photoUrl) {
      throw new AppError('Foto requerida para check-in', 400)
    }
    if (config.attendance.requireGPS && !params.latitude) {
      throw new AppError('Ubicación requerida para check-in', 400)
    }
  }

  // Crear entry (campos null si no se proporcionan)
  return prisma.timeEntry.create({
    data: {
      staffId: params.staffId,
      venueId: params.venueId,
      clockInTime: new Date(),
      checkInPhotoUrl: params.photoUrl || null,
      checkInLatitude: params.latitude || null,
      checkInLongitude: params.longitude || null,
    }
  })
}
```

---

## Scope Jerárquico

### Problema

```
MANAGER de telecom solo debe ver SUS tiendas asignadas
MANAGER de restaurante ve todo el venue
```

### Solución

```typescript
// src/middlewares/hierarchyScope.middleware.ts

export async function applyHierarchyScope(req, res, next) {
  const { role, staffId } = req.authContext
  const config = await getVenueIndustryConfig(req.params.venueId)

  if (config.hierarchy?.managerScopedToStores && role === 'MANAGER') {
    // Obtener solo venues asignados a este manager
    const assignedVenues = await prisma.staffVenue.findMany({
      where: { staffId, role: 'MANAGER' },
      select: { venueId: true }
    })
    req.authContext.scopedVenueIds = assignedVenues.map(v => v.venueId)
  }

  next()
}
```

### Uso en Queries

```typescript
// En cualquier servicio que liste datos
const whereClause = {
  venueId: req.authContext.scopedVenueIds
    ? { in: req.authContext.scopedVenueIds }
    : req.authContext.venueId
}
```

---

## Verificación de No-Impacto

| Criterio | Status |
|----------|--------|
| Sin `if (venueId === 'xxx')` | ✅ |
| Campos opcionales/nullable | ✅ |
| Defaults que no rompen existentes | ✅ |
| Config en JSON, no hardcoded | ✅ |
| UI condicional por config | ✅ |
| Endpoints adicionales | ✅ |
| Mismo código para futuros clientes | ✅ |

---

## Cómo Agregar Nueva Industria

1. Crear `src/config/industry/[industria].config.ts`
2. Agregar tipo a `VenueType` enum (si no existe)
3. Mapear en `INDUSTRY_CONFIGS` en `index.ts`
4. Agregar UI condicional si hay módulos nuevos

**Tiempo estimado:** 1-2 horas (solo configuración)
