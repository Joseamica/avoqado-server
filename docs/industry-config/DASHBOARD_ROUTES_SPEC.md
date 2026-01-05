# Dashboard Routes Specification: Industry Configuration

## Contexto: Tres Niveles de Dashboard

```
/superadmin/*           → SuperadminLayout (Avoqado - tú, el dueño de la plataforma)
/organizations/:orgId/* → OrganizationLayout (Owner de PlayTelecom ve TODAS sus tiendas)
/venues/:slug/*         → Dashboard (Admin/Manager ve UNA tienda)
```

---

## Audiencia por Funcionalidad

```
┌─────────────────────┬──────────────────────┬─────────────────────┐
│  Funcionalidad      │  ¿Quién la usa?      │  ¿Cuándo?           │
├─────────────────────┼──────────────────────┼─────────────────────┤
│  Industry Config    │  Owner               │  Una vez (setup)    │
│  Reporte Asistencia │  Owner, Admin, Mgr   │  Diario (monitoreo) │
│  Lista de Saldos    │  Owner, Admin        │  Durante el día     │
│  Validar Depósitos  │  Owner, Admin        │  Final del día      │
└─────────────────────┴──────────────────────┴─────────────────────┘
```

---

## Estructura de Rutas Propuesta

### Nivel 1: Organization Dashboard (Owner de PlayTelecom)

```
/organizations/:orgId/
│
├── overview                    # Métricas consolidadas de todas las tiendas
│
├── attendance                  # Asistencia de TODAS las tiendas (vista consolidada)
│
├── deposits                    # Depósitos pendientes de TODAS las tiendas
│                               # ↳ Crítico: Owner valida desde aquí
│
├── settings/
│   └── industry                # Configuración de industria (org-level)
│                               # ↳ Activa/desactiva módulos para toda la org
│
└── venues/                     # Lista de tiendas de la organización
```

### Nivel 2: Venue Dashboard (Admin de una tienda)

```
/venues/:slug/
│
├── home                        # Dashboard principal de la tienda
│
├── attendance                  # Asistencia de ESTA tienda solamente
│                               # ↳ Check-ins con foto, GPS, hora
│
├── staff-balances              # Saldos de promotores de ESTA tienda
│                               # ↳ Diferente de "Available Balance" (que es del venue)
│
├── deposits                    # Depósitos de ESTA tienda
│                               # ↳ Admin puede aprobar/rechazar
│
├── settings/
│   └── industry                # Override de config para ESTA tienda (opcional)
│                               # ↳ Hereda de org, puede personalizar
│
└── ... (rutas existentes: pagos, órdenes, menú, etc.)
```

### Nivel 3: Manager View (Solo lectura, scope limitado)

```
/venues/:slug/
│
├── attendance                  # Solo ve SUS tiendas asignadas (filtrado automático)
│                               # ↳ Read-only, no puede editar
│
├── staff-balances              # Solo ve SUS promotores (filtrado automático)
│                               # ↳ Read-only
│
└── (NO tiene acceso a deposits - no puede validar)
```

---

## Sidebar Dinámico

### Filtrado por Permiso + Config de Industria

El sidebar actual filtra por `permission`. Ahora también filtrará por `industryFeature`:

```typescript
const allItems = [
  // Items existentes (siempre visibles según permiso)
  { title: 'Inicio', permission: 'home:read' },
  { title: 'Analytics', permission: 'analytics:read' },
  { title: 'Pagos', permission: 'payments:read' },

  // NUEVOS (solo visibles si industryConfig los habilita)
  {
    title: 'Asistencia',
    permission: 'attendance:read',
    industryFeature: 'attendance.enabled', // ← NUEVO
  },
  {
    title: 'Saldos',
    permission: 'balance:read',
    industryFeature: 'balance.enabled', // ← NUEVO
  },
  {
    title: 'Depósitos',
    permission: 'deposits:validate',
    industryFeature: 'balance.requireDepositValidation', // ← NUEVO
  },
]
```

### Resultado Visual por Tipo de Venue

```
┌────────────────────────────────────┬────────────────────────────────────┐
│  RESTAURANTE (config default)      │  TELECOM (config PlayTelecom)      │
├────────────────────────────────────┼────────────────────────────────────┤
│                                    │                                    │
│  🏠 Inicio                         │  🏠 Inicio                         │
│  📊 Analytics                      │  📊 Analytics                      │
│  📋 Menú                           │  📋 Menú (o Productos)             │
│  💳 Pagos                          │                                    │
│  🛒 Órdenes                        │  ✅ Asistencia        ← NUEVO      │
│  ⏰ Turnos                         │  💰 Saldos            ← NUEVO      │
│  ⚙️ Configuración                  │  📋 Depósitos         ← NUEVO      │
│                                    │                                    │
│                                    │  💳 Pagos                          │
│                                    │  🛒 Órdenes                        │
│                                    │  ⏰ Turnos                         │
│                                    │  ⚙️ Configuración                  │
│                                    │                                    │
└────────────────────────────────────┴────────────────────────────────────┘

Nota: El restaurante NO ve Asistencia/Saldos/Depósitos porque su config
tiene attendance.enabled = false y balance.enabled = false
```

---

## Estructura de Carpetas en Dashboard

```
src/pages/
│
├── Organization/
│   ├── OrganizationLayout.tsx        # (existente)
│   ├── Overview.tsx                  # (existente)
│   │
│   ├── Attendance/                   # ← NUEVO
│   │   └── OrgAttendance.tsx         # Vista consolidada todas las tiendas
│   │
│   ├── Deposits/                     # ← NUEVO
│   │   └── OrgDeposits.tsx           # Validación centralizada
│   │
│   └── Settings/
│       └── IndustryConfig.tsx        # ← NUEVO (configuración org-level)
│
├── Venue/
│   │
│   ├── Attendance/                   # ← NUEVO
│   │   ├── AttendanceReport.tsx      # Lista con fotos y GPS
│   │   └── components/
│   │       ├── AttendanceTable.tsx
│   │       ├── AttendancePhotoModal.tsx
│   │       └── AttendanceMap.tsx     # Mapa con ubicaciones
│   │
│   ├── StaffBalances/                # ← NUEVO
│   │   ├── StaffBalances.tsx         # Lista de saldos por promotor
│   │   └── components/
│   │       ├── BalanceCard.tsx
│   │       └── BalanceTable.tsx
│   │
│   ├── Deposits/                     # ← NUEVO
│   │   ├── DepositValidation.tsx     # Aprobar/rechazar depósitos
│   │   └── components/
│   │       ├── DepositCard.tsx
│   │       ├── VoucherPreview.tsx    # Modal para ver foto del voucher
│   │       └── DepositActions.tsx    # Botones aprobar/rechazar
│   │
│   └── Settings/
│       └── IndustryConfig.tsx        # ← NUEVO (override por venue)
│
└── index.ts                          # Exportar todos los nuevos componentes
```

---

## Definición de Rutas en router.tsx

### Rutas de Organization (Owner)

```typescript
{
  path: 'organizations/:orgId',
  element: <OwnerProtectedRoute />,
  children: [{
    element: <OrganizationLayout />,
    children: [
      // Existentes...
      { path: '', element: <OrgOverview /> },

      // ═══════════════════════════════════════════
      // NUEVAS RUTAS
      // ═══════════════════════════════════════════

      {
        path: 'attendance',
        element: <PermissionProtectedRoute permission="attendance:read" />,
        children: [
          { index: true, element: <OrgAttendance /> }
        ]
      },

      {
        path: 'deposits',
        element: <PermissionProtectedRoute permission="deposits:validate" />,
        children: [
          { index: true, element: <OrgDeposits /> }
        ]
      },

      {
        path: 'settings/industry',
        element: <PermissionProtectedRoute permission="industry:update" />,
        children: [
          { index: true, element: <IndustryConfig /> }
        ]
      },
    ]
  }]
}
```

### Rutas de Venue (Admin/Manager)

```typescript
{
  path: 'venues/:slug',
  element: <Dashboard />,
  children: [
    // Existentes...

    // ═══════════════════════════════════════════
    // NUEVAS RUTAS
    // ═══════════════════════════════════════════

    // Attendance - Manager puede ver (read-only)
    {
      path: 'attendance',
      element: <AdminProtectedRoute requiredRole={AdminAccessLevel.MANAGER} />,
      children: [{
        element: <PermissionProtectedRoute permission="attendance:read" />,
        children: [{
          element: <KYCProtectedRoute />,
          children: [
            { index: true, element: <AttendanceReport /> }
          ]
        }]
      }]
    },

    // Staff Balances - Solo Admin
    {
      path: 'staff-balances',
      element: <AdminProtectedRoute requiredRole={AdminAccessLevel.ADMIN} />,
      children: [{
        element: <PermissionProtectedRoute permission="balance:read" />,
        children: [{
          element: <KYCProtectedRoute />,
          children: [
            { index: true, element: <StaffBalances /> }
          ]
        }]
      }]
    },

    // Deposits - Solo Admin (puede validar)
    {
      path: 'deposits',
      element: <AdminProtectedRoute requiredRole={AdminAccessLevel.ADMIN} />,
      children: [{
        element: <PermissionProtectedRoute permission="deposits:validate" />,
        children: [{
          element: <KYCProtectedRoute />,
          children: [
            { index: true, element: <DepositValidation /> }
          ]
        }]
      }]
    },

    // Industry Config - Solo Admin (override)
    {
      path: 'settings/industry',
      element: <AdminProtectedRoute requiredRole={AdminAccessLevel.ADMIN} />,
      children: [{
        element: <PermissionProtectedRoute permission="industry:read" />,
        children: [
          { index: true, element: <VenueIndustryConfig /> }
        ]
      }]
    },
  ]
}
```

---

## Permisos Necesarios

### Nuevos Permission Strings

```typescript
// Attendance
'attendance:read' // Ver registros de asistencia
'attendance:create' // Registrar check-in (solo TPV)

// Balance
'balance:read' // Ver saldos de staff
'balance:update' // Modificar saldos manualmente

// Deposits
'deposits:read' // Ver lista de depósitos
'deposits:create' // Subir comprobante (solo TPV)
'deposits:validate' // Aprobar/rechazar depósitos

// Industry Config
'industry:read' // Ver configuración de industria
'industry:update' // Modificar configuración
```

### Matriz de Permisos por Rol

```
┌─────────────────────┬───────┬───────┬─────────┬────────┐
│  Permiso            │ OWNER │ ADMIN │ MANAGER │ WAITER │
├─────────────────────┼───────┼───────┼─────────┼────────┤
│  attendance:read    │   ✓   │   ✓   │    ✓    │   ✗    │
│  attendance:create  │   ✗   │   ✗   │    ✗    │   ✓    │
│  balance:read       │   ✓   │   ✓   │    ✓    │   ✓*   │
│  balance:update     │   ✓   │   ✓   │    ✗    │   ✗    │
│  deposits:read      │   ✓   │   ✓   │    ✓    │   ✓*   │
│  deposits:create    │   ✗   │   ✗   │    ✗    │   ✓    │
│  deposits:validate  │   ✓   │   ✓   │    ✗    │   ✗    │
│  industry:read      │   ✓   │   ✓   │    ✗    │   ✗    │
│  industry:update    │   ✓   │   ✗   │    ✗    │   ✗    │
└─────────────────────┴───────┴───────┴─────────┴────────┘

* WAITER solo ve su propio balance/depósitos (en TPV, no en Dashboard)
```

---

## Scope Jerárquico para Manager

El middleware `hierarchyScope` filtra automáticamente los datos:

```
Ejemplo: Manager "Juan" asignado a Tienda Centro y Tienda Norte

Cuando Juan entra a /venues/tienda-centro/attendance:
  → Backend devuelve SOLO attendance de tienda-centro
  → Frontend NO muestra botones de edición (read-only)

Cuando Juan intenta acceder a /venues/tienda-sur/attendance:
  → Backend devuelve 403 Forbidden
  → O redirecta a página de error
```

---

## Resumen de Decisiones

```
┌─────────────────────┬────────────────────────────────────────────────────┐
│  Decisión           │  Recomendación                                     │
├─────────────────────┼────────────────────────────────────────────────────┤
│  Industry Config    │  /organizations/:orgId/settings/industry           │
│                     │  (org-level, con override opcional por venue)      │
├─────────────────────┼────────────────────────────────────────────────────┤
│  Attendance         │  /venues/:slug/attendance                          │
│                     │  (top-level, alta visibilidad diaria)              │
├─────────────────────┼────────────────────────────────────────────────────┤
│  Staff Balances     │  /venues/:slug/staff-balances                      │
│                     │  (separado de Available Balance del venue)         │
├─────────────────────┼────────────────────────────────────────────────────┤
│  Deposits           │  /venues/:slug/deposits                            │
│                     │  (separado de Payments de clientes)                │
├─────────────────────┼────────────────────────────────────────────────────┤
│  Sidebar            │  Filtrado por permission + industryFeature         │
│                     │  (no muestra items si config está deshabilitado)   │
├─────────────────────┼────────────────────────────────────────────────────┤
│  Manager Scope      │  Backend filtra datos por tiendas asignadas        │
│                     │  Frontend oculta acciones de edición               │
└─────────────────────┴────────────────────────────────────────────────────┘
```

---

## Escalabilidad

Esta estructura soporta futuras industrias sin cambios arquitectónicos:

```
Gimnasio:
  → industryConfig.membership.enabled = true
  → Aparece sidebar item "Membresías"
  → Ruta /venues/:slug/memberships

Retail:
  → industryConfig.inventory.trackByLocation = true
  → Inventory muestra columna "Ubicación en tienda"

Hotel:
  → industryConfig.reservations.enabled = true
  → Aparece sidebar item "Reservaciones"
  → Ruta /venues/:slug/reservations
```

El patrón es siempre el mismo:

1. Agregar config en `industryConfig`
2. Agregar `industryFeature` al sidebar item
3. Crear componentes y rutas
4. Backend respeta config

---

_Documento preparado para implementación de Dashboard - Avoqado_
