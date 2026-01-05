# Implementation Plan: Industry Configuration System

## Resumen Ejecutivo

| Métrica                   | Valor                   |
| ------------------------- | ----------------------- |
| **Fases totales**         | 7                       |
| **Tiempo estimado**       | 26-34 horas (~4-5 días) |
| **Impacto en existentes** | NINGUNO                 |
| **Cliente inicial**       | PlayTelecom             |

---

## Fase 1: Configuration System (Backend)

**Tiempo:** 2-3 horas **Prioridad:** CRÍTICA (base para todo lo demás)

### Tareas

- [ ] 1.1 Agregar campo `industryConfig Json?` a `VenueSettings`
- [ ] 1.2 Crear migración Prisma
- [ ] 1.3 Crear directorio `src/config/industry/`
- [ ] 1.4 Implementar `types.ts` con interfaces
- [ ] 1.5 Implementar configs por industria
- [ ] 1.6 Implementar `getIndustryConfig()` helper
- [ ] 1.7 Tests unitarios

### Archivos

```
MODIFICAR:
  prisma/schema.prisma (1 campo)

CREAR:
  src/config/industry/
  ├── index.ts
  ├── types.ts
  ├── defaults.ts
  ├── telecom.config.ts
  ├── restaurant.config.ts
  └── retail.config.ts
```

### Criterio de Éxito

```typescript
const venue = await getVenue('telecom_venue_id')
const config = getIndustryConfig(venue)
expect(config.attendance.requirePhoto).toBe(true)
```

---

## Fase 2: Attendance con Foto/GPS (Backend)

**Tiempo:** 3-4 horas **Dependencia:** Fase 1

### Tareas

- [ ] 2.1 Agregar campos a `TimeEntry` (photoUrl, lat, lng, address)
- [ ] 2.2 Crear migración Prisma
- [ ] 2.3 Actualizar `ClockInParams` interface
- [ ] 2.4 Modificar `clockIn()` service con validación condicional
- [ ] 2.5 Actualizar controller para extraer nuevos campos
- [ ] 2.6 Actualizar schema de validación (Zod)
- [ ] 2.7 Tests de integración

### Archivos

```
MODIFICAR:
  prisma/schema.prisma (4 campos en TimeEntry)
  src/services/tpv/time-entry.tpv.service.ts
  src/controllers/tpv/time-entry.tpv.controller.ts
  src/schemas/tpv/time-entry.schema.ts (si existe)
```

### Criterio de Éxito

```bash
# Sin foto (venue telecom) → Error
curl -X POST /tpv/venues/telecom/time-entries/clock-in \
  -d '{"staffId": "x", "pin": "1234"}'
# Response: 400 "Foto requerida para check-in"

# Con foto → Success
curl -X POST /tpv/venues/telecom/time-entries/clock-in \
  -d '{"staffId": "x", "pin": "1234", "photoUrl": "...", "latitude": 19.4, "longitude": -99.1}'
# Response: 201 Created
```

---

## Fase 3: Balance y Depósitos (Backend)

**Tiempo:** 4-5 horas **Dependencia:** Fase 1

### Tareas

- [ ] 3.1 Agregar campos a `StaffVenue` (cashBalance, cardBalance, pendingDeposit)
- [ ] 3.2 Crear modelo `StaffDeposit` con enum `DepositStatus`
- [ ] 3.3 Crear migración Prisma
- [ ] 3.4 Crear `balance.tpv.service.ts` (ver saldo, crear depósito)
- [ ] 3.5 Crear `deposits.dashboard.service.ts` (listar, validar)
- [ ] 3.6 Crear controllers para TPV y Dashboard
- [ ] 3.7 Agregar rutas
- [ ] 3.8 Lógica de actualización de balance en ventas
- [ ] 3.9 Tests de integración

### Archivos

```
MODIFICAR:
  prisma/schema.prisma (3 campos StaffVenue + modelo StaffDeposit)
  src/routes/tpv.routes.ts
  src/routes/dashboard.routes.ts

CREAR:
  src/services/tpv/balance.tpv.service.ts
  src/services/dashboard/deposits.dashboard.service.ts
  src/controllers/tpv/balance.tpv.controller.ts
  src/controllers/dashboard/deposits.dashboard.controller.ts
```

### Endpoints Nuevos

```
TPV:
  GET  /tpv/venues/:venueId/staff/:staffId/balance
  POST /tpv/venues/:venueId/deposits

Dashboard:
  GET   /dashboard/venues/:venueId/deposits
  GET   /dashboard/venues/:venueId/deposits/:id
  PATCH /dashboard/venues/:venueId/deposits/:id (aprobar/rechazar)
```

### Criterio de Éxito

```bash
# Ver saldo
curl /tpv/venues/x/staff/y/balance
# Response: { cashBalance: 3450, cardBalance: 12800, pendingDeposit: 3450 }

# Subir depósito
curl -X POST /tpv/venues/x/deposits \
  -d '{"staffId": "y", "amount": 3450, "voucherUrl": "..."}'
# Response: 201 Created

# Validar (Admin)
curl -X PATCH /dashboard/venues/x/deposits/z \
  -d '{"status": "APPROVED"}'
# Response: 200 OK (balance actualizado)
```

---

## Fase 4: Scope Jerárquico Manager (Backend)

**Tiempo:** 2-3 horas **Dependencia:** Fase 1

### Tareas

- [ ] 4.1 Crear `hierarchyScope.middleware.ts`
- [ ] 4.2 Integrar con rutas de analytics
- [ ] 4.3 Integrar con rutas de team
- [ ] 4.4 Integrar con rutas de orders (si aplica)
- [ ] 4.5 Tests de integración

### Archivos

```
CREAR:
  src/middlewares/hierarchyScope.middleware.ts

MODIFICAR:
  src/routes/dashboard.routes.ts (agregar middleware a rutas)
```

### Criterio de Éxito

```bash
# Manager de telecom solo ve sus tiendas
curl -H "Authorization: Bearer <manager_token>" \
  /dashboard/venues/org_x/analytics
# Response: Solo datos de tiendas asignadas al manager
```

---

## Fase 5: Foto/GPS en Check-in (TPV Android)

**Tiempo:** 5-6 horas **Dependencia:** Fase 2

### Tareas

- [ ] 5.1 Agregar estado para foto y GPS en `TimeClockViewModel`
- [ ] 5.2 Implementar captura de foto (reusar patrón CameraX)
- [ ] 5.3 Implementar captura de GPS (FusedLocationProviderClient)
- [ ] 5.4 Modificar UI de `TimeClockScreen` (flujo: PIN → Foto → GPS)
- [ ] 5.5 Actualizar `ClockInRequest` con nuevos campos
- [ ] 5.6 Implementar upload de foto (multipart o base64)
- [ ] 5.7 Tests manuales en dispositivo

### Archivos (AvoqadoPOS)

```
MODIFICAR:
  features/timeclock/presentation/clockin/TimeClockViewModel.kt
  features/timeclock/presentation/clockin/TimeClockScreen.kt
  features/timeclock/presentation/clockin/TimeClockUiState.kt
  core/data/network/models/timeentry/ClockInRequest.kt
  core/data/network/AvoqadoService.kt
```

### Flujo UI

```
┌─────────────────────────┐
│  Ingresa tu PIN         │
│  [____]                 │
│  [Continuar]            │
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│  Toma una foto          │
│  ┌─────────────────┐    │
│  │   [Cámara]      │    │
│  └─────────────────┘    │
│  [Capturar]             │
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│  Confirmar ubicación    │
│  📍 19.4326, -99.1332   │
│  Calle X, Col Y         │
│  [Registrar Entrada]    │
└─────────────────────────┘
```

---

## Fase 6: Saldo y Depósitos (TPV Android)

**Tiempo:** 4-5 horas **Dependencia:** Fase 3

### Tareas

- [ ] 6.1 Crear módulo `features/balance/`
- [ ] 6.2 Implementar `BalanceScreen` (ver saldo)
- [ ] 6.3 Implementar `DepositUploadScreen` (subir comprobante)
- [ ] 6.4 Implementar captura de foto para voucher
- [ ] 6.5 Agregar navegación desde menú principal
- [ ] 6.6 Tests manuales

### Archivos (AvoqadoPOS)

```
CREAR:
  features/balance/
  ├── data/
  │   ├── network/BalanceService.kt
  │   └── repository/BalanceRepositoryImpl.kt
  ├── domain/
  │   ├── models/StaffBalance.kt
  │   ├── models/StaffDeposit.kt
  │   └── repository/BalanceRepository.kt
  └── presentation/
      ├── balance/
      │   ├── BalanceScreen.kt
      │   └── BalanceViewModel.kt
      └── deposit/
          ├── DepositUploadScreen.kt
          └── DepositViewModel.kt

MODIFICAR:
  MainActivity.kt o navegación principal
```

### UI Mockup

```
┌─────────────────────────┐
│  💰 Mi Saldo            │
├─────────────────────────┤
│  Efectivo    $3,450.00  │
│  Tarjeta    $12,800.00  │
│  ─────────────────────  │
│  Por depositar          │
│              $3,450.00  │
├─────────────────────────┤
│  [📷 Subir Comprobante] │
└─────────────────────────┘
```

---

## Fase 7: UI Admin (Dashboard Web)

**Tiempo:** 6-8 horas **Dependencia:** Fases 1-4

### Tareas

- [ ] 7.1 Crear página `IndustryConfig.tsx` en Settings
- [ ] 7.2 Crear página `AttendanceReport.tsx` (ver check-ins con fotos)
- [ ] 7.3 Crear página `BalanceList.tsx` (saldos de promotores)
- [ ] 7.4 Crear página `DepositValidation.tsx` (aprobar/rechazar)
- [ ] 7.5 Modificar Sidebar para mostrar items según config
- [ ] 7.6 Agregar rutas protegidas
- [ ] 7.7 Tests manuales

### Archivos (avoqado-web-dashboard)

```
CREAR:
  src/pages/Settings/IndustryConfig.tsx
  src/pages/Attendance/AttendanceReport.tsx
  src/pages/Balance/BalanceList.tsx
  src/pages/Deposits/DepositValidation.tsx

MODIFICAR:
  src/components/Sidebar.tsx
  src/routes/router.tsx
```

### Visibilidad por Rol

| Página            | OWNER | ADMIN | MANAGER             |
| ----------------- | ----- | ----- | ------------------- |
| IndustryConfig    | ✅    | ❌    | ❌                  |
| AttendanceReport  | ✅    | ✅    | ✅ (sus tiendas)    |
| BalanceList       | ✅    | ✅    | ✅ (sus promotores) |
| DepositValidation | ✅    | ✅    | ❌                  |

---

## Orden de Ejecución Recomendado

```
Semana 1:
├── Día 1: Fase 1 (Configuration System)
├── Día 2: Fase 2 (Attendance Backend)
└── Día 3: Fase 3 (Balance Backend)

Semana 2:
├── Día 4: Fase 4 (Scope) + Fase 5 inicio (TPV)
├── Día 5: Fase 5 completa + Fase 6 (TPV)
└── Día 6-7: Fase 7 (Dashboard)
```

---

## Checklist de Verificación Final

- [ ] Venue de restaurante existente funciona igual
- [ ] Venue de telecom tiene módulos habilitados
- [ ] Check-in con foto funciona en TPV
- [ ] Saldo se actualiza con ventas
- [ ] Admin puede validar depósitos
- [ ] Manager solo ve sus tiendas
- [ ] UI no muestra módulos deshabilitados
- [ ] No hay código específico por cliente
