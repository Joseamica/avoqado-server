# Requirements: PlayTelecom

## Cliente

**Nombre:** PlayTelecom
**Industria:** Telecomunicaciones / Retail
**Tipo en sistema:** `VenueType.ELECTRONICS`

---

## Diagrama de Roles

```
┌─────────────────────────────────────────────────────────────┐
│                      SUPER ADMIN (OWNER)                     │
│  - Todos los permisos CRUD                                  │
│  - Reportes personalizados                                  │
│  - Gestión de Admins                                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                         ADMIN                                │
│  - Dashboard con métricas configurables                     │
│  - Altas/bajas de Gerentes y Promotores                    │
│  - Validación de depósitos                                  │
│  - Edición de saldos                                        │
│  - Vista de: Gerente → Tiendas → Promotores                │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                        GERENTE                               │
│  - SOLO LECTURA                                             │
│  - Solo ve SUS tiendas asignadas                           │
│  - Métricas día/semana/mes                                  │
│  - Recibe notificación cuando promotor hace check-in       │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                       PROMOTOR                               │
│  - Solo acceso a TPV                                        │
│  - Check-in con foto + GPS al iniciar turno                │
│  - Registro de ventas (efectivo/tarjeta)                   │
│  - Escaneo de código de barras (ICCI)                      │
│  - Ver su saldo                                             │
│  - Subir foto de comprobante de depósito                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Mapeo de Roles

| PlayTelecom | Avoqado | Notas |
|-------------|---------|-------|
| Super Admin | `OWNER` | Dueño de la organización |
| Admin | `ADMIN` | Equipo de operaciones |
| Gerente | `MANAGER` | Scope limitado a sus tiendas |
| Promotor | `WAITER` | Etiqueta personalizada |

---

## Requisitos Funcionales

### 1. Check-in con Verificación

**Actor:** Promotor
**Plataforma:** TPV Android

**Flujo:**
1. Promotor abre TPV al inicio del turno
2. Ingresa su PIN
3. Sistema solicita foto (selfie o de la tienda)
4. Sistema captura GPS automáticamente
5. Sistema registra: `{ foto, latitud, longitud, timestamp }`
6. Gerente recibe notificación push

**Reglas:**
- Foto OBLIGATORIA (configurable)
- GPS OBLIGATORIO (configurable)
- Validar que GPS esté dentro del radio de la tienda (opcional, geofencing)

### 2. Tracking de Saldos

**Actor:** Promotor, Admin
**Plataforma:** TPV (ver), Dashboard (gestionar)

**Campos a trackear:**
- `cashBalance` - Efectivo recaudado
- `cardBalance` - Procesado por tarjeta
- `pendingDeposit` - Monto que debe depositar

**Actualización:**
- Cuando se procesa venta en efectivo → `cashBalance += amount`
- Cuando se procesa venta con tarjeta → `cardBalance += amount`
- `pendingDeposit = cashBalance` (efectivo pendiente de depositar)

### 3. Ciclo de Depósitos

**Flujo completo:**

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   PROMOTOR   │     │    ADMIN     │     │   SISTEMA    │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       │ 1. Vende productos │                    │
       │ ─────────────────────────────────────►  │
       │                    │     cashBalance++  │
       │                    │                    │
       │ 2. Deposita efectivo en banco           │
       │                    │                    │
       │ 3. Sube foto de voucher                 │
       │ ─────────────────────────────────────►  │
       │                    │  status: PENDING   │
       │                    │                    │
       │                    │ 4. Ve depósito     │
       │                    │ ◄──────────────────│
       │                    │                    │
       │                    │ 5. Aprueba         │
       │                    │ ─────────────────► │
       │                    │  status: APPROVED  │
       │                    │  pendingDeposit=0  │
       │                    │                    │
```

### 4. Scope Jerárquico para Gerente

**Requisito:** Un Gerente solo puede ver datos de las tiendas asignadas a él.

**Implementación:**
- Gerente tiene múltiples `StaffVenue` con `role: MANAGER`
- Cada `StaffVenue` corresponde a una tienda
- Queries filtran por `venueId IN (tiendas_asignadas)`

**Ejemplo:**
```
Gerente "Juan" asignado a:
- Tienda Centro (venue_001)
- Tienda Norte (venue_002)

Cuando Juan entra al dashboard:
- Solo ve promotores de venue_001 y venue_002
- Solo ve ventas de venue_001 y venue_002
- Solo ve métricas de venue_001 y venue_002
```

### 5. Notificaciones de Check-in

**Trigger:** Promotor hace check-in exitoso
**Destinatario:** Gerente(s) de esa tienda
**Canal:** Push notification
**Contenido:** "🕐 {Promotor} registró entrada en {Tienda} - {hora}"

---

## Requisitos No Funcionales

### Seguridad
- PIN único por promotor por tienda
- Fotos almacenadas en Firebase Storage con URLs firmadas
- GPS no falsificable (validación en backend si hay discrepancia)

### Performance
- Check-in debe completarse en <3 segundos
- Upload de foto <5 segundos (compresión al 85% JPEG)

### UX
- Flujo de check-in intuitivo (máximo 4 pasos)
- Mensajes de error claros
- Indicador de progreso durante upload

---

## Configuración Inicial

### IndustryConfig para PlayTelecom

```json
{
  "attendance": {
    "enabled": true,
    "requirePhoto": true,
    "requireGPS": true,
    "notifyManager": true,
    "geofenceRadius": 100
  },
  "balance": {
    "enabled": true,
    "trackCash": true,
    "trackCard": true,
    "requireDepositValidation": true,
    "autoUpdateOnSale": true
  },
  "hierarchy": {
    "managerScopedToStores": true
  },
  "roleLabels": {
    "WAITER": "Promotor",
    "MANAGER": "Gerente",
    "CASHIER": "Vendedor"
  }
}
```

### Permisos por Rol

| Permiso | OWNER | ADMIN | MANAGER | WAITER |
|---------|-------|-------|---------|--------|
| `attendance:read` | ✅ | ✅ | ✅ | ❌ |
| `attendance:create` | ❌ | ❌ | ❌ | ✅ |
| `balance:read` | ✅ | ✅ | ✅ | ✅* |
| `balance:update` | ✅ | ✅ | ❌ | ❌ |
| `deposits:read` | ✅ | ✅ | ✅ | ✅* |
| `deposits:create` | ❌ | ❌ | ❌ | ✅ |
| `deposits:validate` | ✅ | ✅ | ❌ | ❌ |

*Solo su propio saldo/depósitos

---

## Entregables

### Fase 1 - Backend
- [ ] Modelo `StaffDeposit`
- [ ] Campos en `TimeEntry` (foto/GPS)
- [ ] Campos en `StaffVenue` (balance)
- [ ] Endpoints de balance y depósitos
- [ ] Middleware de scope jerárquico

### Fase 2 - TPV Android
- [ ] Check-in con foto y GPS
- [ ] Pantalla "Mi Saldo"
- [ ] Pantalla "Subir Comprobante"

### Fase 3 - Dashboard
- [ ] Reporte de Asistencia (con fotos)
- [ ] Lista de Saldos
- [ ] Validación de Depósitos
- [ ] Configuración de industria

---

## Métricas de Éxito

| Métrica | Target |
|---------|--------|
| Tiempo de check-in | <30 segundos |
| Tasa de éxito upload foto | >99% |
| Precisión GPS | ±10 metros |
| Tiempo validación depósito | <24 horas |

---

## Notas del Cliente

1. "El check-in con foto es para evitar fraudes de asistencia"
2. "Los gerentes deben saber inmediatamente cuando sus promotores llegan"
3. "El ciclo de depósitos es diario - al final del día depositan"
4. "Cada gerente maneja entre 3-5 tiendas"
5. "Los promotores solo deben ver su información, nada más"
