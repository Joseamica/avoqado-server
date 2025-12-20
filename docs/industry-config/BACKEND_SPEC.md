# Backend Specification: Industry Configuration

## Schema Changes

### 1. VenueSettings - Agregar industryConfig

```prisma
model VenueSettings {
  id      String @id @default(cuid())
  venueId String @unique
  venue   Venue  @relation(fields: [venueId], references: [id], onDelete: Cascade)

  // ... campos existentes ...

  // NUEVO: Configuración de industria
  industryConfig Json?  // Ver IndustryConfig interface

  updatedAt DateTime @updatedAt
}
```

### 2. TimeEntry - Agregar campos de verificación

```prisma
model TimeEntry {
  id      String @id @default(cuid())
  staffId String
  venueId String
  // ... campos existentes ...

  // NUEVO: Check-in verification (optional, config-driven)
  checkInPhotoUrl  String?              // URL de foto de check-in
  checkInLatitude  Decimal? @db.Decimal(10, 8)
  checkInLongitude Decimal? @db.Decimal(11, 8)
  checkInAddress   String?              // Dirección geocodificada (opcional)

  // ... resto de campos ...
}
```

### 3. StaffVenue - Agregar campos de balance

```prisma
model StaffVenue {
  id      String @id @default(cuid())
  staffId String
  venueId String
  // ... campos existentes (totalSales, totalTips, etc.) ...

  // NUEVO: Balance tracking (config-driven)
  cashBalance    Decimal @default(0) @db.Decimal(12, 2)  // Efectivo en mano
  cardBalance    Decimal @default(0) @db.Decimal(12, 2)  // Procesado por tarjeta
  pendingDeposit Decimal @default(0) @db.Decimal(12, 2)  // Pendiente de depositar

  // Relación con depósitos
  deposits StaffDeposit[]

  // ... resto de campos ...
}
```

### 4. StaffDeposit - Nuevo modelo

```prisma
model StaffDeposit {
  id           String   @id @default(cuid())
  staffVenueId String
  staffVenue   StaffVenue @relation(fields: [staffVenueId], references: [id], onDelete: Cascade)

  // Monto y evidencia
  amount     Decimal @db.Decimal(12, 2)
  voucherUrl String  // URL de foto del comprobante

  // Workflow de validación
  status          DepositStatus @default(PENDING)
  validatedBy     String?       // Staff ID del admin que validó
  validatedAt     DateTime?
  rejectionReason String?       // Razón si fue rechazado

  // Metadata
  notes     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([staffVenueId])
  @@index([status])
  @@index([createdAt])
}

enum DepositStatus {
  PENDING   // Esperando validación
  APPROVED  // Aprobado por admin
  REJECTED  // Rechazado por admin
}
```

---

## TypeScript Interfaces

### IndustryConfig

```typescript
// src/config/industry/types.ts

export interface IndustryConfig {
  attendance: AttendanceConfig
  balance: BalanceConfig
  hierarchy: HierarchyConfig
  roleLabels: RoleLabels | null
}

export interface AttendanceConfig {
  enabled: boolean
  requirePhoto: boolean
  requireGPS: boolean
  notifyManager: boolean
  geofenceRadius?: number  // metros (opcional, para validar distancia)
}

export interface BalanceConfig {
  enabled: boolean
  trackCash: boolean
  trackCard: boolean
  requireDepositValidation: boolean
  autoUpdateOnSale: boolean
}

export interface HierarchyConfig {
  managerScopedToStores: boolean
}

export interface RoleLabels {
  WAITER?: string
  MANAGER?: string
  CASHIER?: string
  ADMIN?: string
  // ... otros roles
}
```

### ClockInParams (actualizado)

```typescript
// src/services/tpv/time-entry.tpv.service.ts

interface ClockInParams {
  venueId: string
  staffId: string
  pin: string
  jobRole?: string
  // NUEVOS (opcionales)
  photoUrl?: string
  latitude?: number
  longitude?: number
}
```

---

## Industry Configs

### Default (Restaurant)

```typescript
// src/config/industry/defaults.ts

export const DEFAULT_CONFIG: IndustryConfig = {
  attendance: {
    enabled: false,
    requirePhoto: false,
    requireGPS: false,
    notifyManager: false,
  },
  balance: {
    enabled: false,
    trackCash: false,
    trackCard: false,
    requireDepositValidation: false,
    autoUpdateOnSale: false,
  },
  hierarchy: {
    managerScopedToStores: false,
  },
  roleLabels: null,
}
```

### Telecom

```typescript
// src/config/industry/telecom.config.ts

export const TELECOM_CONFIG: IndustryConfig = {
  attendance: {
    enabled: true,
    requirePhoto: true,
    requireGPS: true,
    notifyManager: true,
    geofenceRadius: 100,  // 100 metros
  },
  balance: {
    enabled: true,
    trackCash: true,
    trackCard: true,
    requireDepositValidation: true,
    autoUpdateOnSale: true,
  },
  hierarchy: {
    managerScopedToStores: true,
  },
  roleLabels: {
    WAITER: 'Promotor',
    MANAGER: 'Gerente',
    CASHIER: 'Vendedor',
  },
}
```

---

## Helper Function

```typescript
// src/config/industry/index.ts

import { VenueType } from '@prisma/client'
import { IndustryConfig } from './types'
import { DEFAULT_CONFIG } from './defaults'
import { TELECOM_CONFIG } from './telecom.config'
import { RESTAURANT_CONFIG } from './restaurant.config'
import { RETAIL_CONFIG } from './retail.config'

const INDUSTRY_CONFIGS: Partial<Record<VenueType, IndustryConfig>> = {
  ELECTRONICS: TELECOM_CONFIG,
  RESTAURANT: RESTAURANT_CONFIG,
  RETAIL_STORE: RETAIL_CONFIG,
  // ... otros tipos
}

export function getIndustryConfig(
  venue: { type: VenueType; settings?: { industryConfig?: any } | null }
): IndustryConfig {
  // 1. Prioridad: Config custom del venue
  if (venue.settings?.industryConfig) {
    return mergeDeep(
      INDUSTRY_CONFIGS[venue.type] || DEFAULT_CONFIG,
      venue.settings.industryConfig
    )
  }

  // 2. Fallback: Config default por tipo
  return INDUSTRY_CONFIGS[venue.type] || DEFAULT_CONFIG
}

// Helper para merge profundo
function mergeDeep<T>(target: T, source: Partial<T>): T {
  const output = { ...target }
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      output[key] = mergeDeep(output[key] as any, source[key] as any)
    } else if (source[key] !== undefined) {
      output[key] = source[key] as any
    }
  }
  return output
}
```

---

## API Endpoints

### TPV Endpoints

```typescript
// Existente (modificar)
POST /tpv/venues/:venueId/time-entries/clock-in
Body: {
  staffId: string
  pin: string
  photoUrl?: string      // NUEVO
  latitude?: number      // NUEVO
  longitude?: number     // NUEVO
}

// Nuevos
GET /tpv/venues/:venueId/staff/:staffId/balance
Response: {
  cashBalance: number
  cardBalance: number
  pendingDeposit: number
  totalSales: number
  totalTips: number
}

POST /tpv/venues/:venueId/deposits
Body: {
  staffId: string
  amount: number
  voucherUrl: string
  notes?: string
}
Response: {
  id: string
  status: 'PENDING'
  createdAt: string
}
```

### Dashboard Endpoints

```typescript
// Ver check-ins con fotos
GET /dashboard/venues/:venueId/attendance
Query: { startDate, endDate, staffId? }
Response: {
  entries: [{
    id: string
    staff: { id, firstName, lastName }
    clockInTime: string
    checkInPhotoUrl: string | null
    checkInLatitude: number | null
    checkInLongitude: number | null
  }]
}

// Listar depósitos
GET /dashboard/venues/:venueId/deposits
Query: { status?, staffId?, startDate?, endDate? }
Response: {
  deposits: [{
    id: string
    staffVenue: { staff: { firstName, lastName } }
    amount: number
    voucherUrl: string
    status: DepositStatus
    createdAt: string
  }]
}

// Validar depósito
PATCH /dashboard/venues/:venueId/deposits/:depositId
Body: {
  status: 'APPROVED' | 'REJECTED'
  rejectionReason?: string
}
Response: {
  id: string
  status: DepositStatus
  validatedAt: string
}
```

---

## Permisos

### Nuevos Permission Strings

```typescript
// src/lib/permissions.ts

// Attendance
'attendance:read'    // Ver registros de asistencia
'attendance:create'  // Registrar check-in (TPV)

// Balance
'balance:read'       // Ver saldos
'balance:update'     // Modificar saldos manualmente

// Deposits
'deposits:read'      // Ver depósitos
'deposits:create'    // Subir comprobante (TPV)
'deposits:validate'  // Aprobar/rechazar depósitos

// Industry Config
'industry:read'      // Ver configuración de industria
'industry:update'    // Modificar configuración (OWNER/SUPERADMIN)
```

### Permisos por Rol

| Rol | attendance | balance | deposits | industry |
|-----|------------|---------|----------|----------|
| OWNER | ✅ all | ✅ all | ✅ all | ✅ all |
| ADMIN | ✅ all | ✅ all | ✅ all | ❌ |
| MANAGER | read | read | read | ❌ |
| WAITER | create | read (propio) | create | ❌ |

---

## Middleware de Scope

```typescript
// src/middlewares/hierarchyScope.middleware.ts

import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import { getIndustryConfig } from '@/config/industry'

export async function applyHierarchyScope(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authContext = (req as any).authContext
  if (!authContext) return next()

  const { role, staffId, venueId } = authContext

  // Solo aplicar si es MANAGER y la config lo requiere
  if (role !== 'MANAGER') return next()

  try {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      include: { settings: true }
    })

    if (!venue) return next()

    const config = getIndustryConfig(venue)

    if (config.hierarchy.managerScopedToStores) {
      // Obtener venues asignados a este manager
      const assignedVenues = await prisma.staffVenue.findMany({
        where: { staffId, role: 'MANAGER' },
        select: { venueId: true }
      })

      // Agregar al authContext para uso en queries
      authContext.scopedVenueIds = assignedVenues.map(v => v.venueId)
    }
  } catch (error) {
    console.error('Error applying hierarchy scope:', error)
  }

  next()
}
```

---

## Migración de Datos

### Migración Prisma

```bash
npx prisma migrate dev --name add_industry_config_and_deposits
```

### Script de Seed (para venues existentes)

```typescript
// prisma/migrations/seed-industry-config.ts

// Los venues existentes NO necesitan migración de datos
// porque todos los campos nuevos son:
// - Nullable (Json?, String?, Decimal?)
// - Con defaults (@default(0), @default(PENDING))

// Solo si quieres pre-configurar algún venue:
await prisma.venueSettings.update({
  where: { venueId: 'venue_telecom_id' },
  data: {
    industryConfig: {
      attendance: { enabled: true, requirePhoto: true, requireGPS: true },
      balance: { enabled: true, requireDepositValidation: true },
      // ...
    }
  }
})
```
