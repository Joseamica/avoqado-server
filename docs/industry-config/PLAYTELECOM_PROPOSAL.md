# Propuesta de Integración: PlayTelecom + Avoqado

## Resumen Ejecutivo

Avoqado adaptará su plataforma POS para cubrir las necesidades operativas de PlayTelecom, incluyendo:

- Control de asistencia de promotores con verificación fotográfica y GPS
- Tracking de saldos en tiempo real (efectivo y tarjeta)
- Flujo de validación de depósitos
- Visibilidad jerárquica por rol

**Sin desarrollo custom.** PlayTelecom usará la misma plataforma que otros clientes, configurada para su industria.

---

## Mapeo de Roles

| Rol en PlayTelecom | Rol en Avoqado | Acceso |
|--------------------|----------------|--------|
| **Super Admin** | Owner | Dashboard Web - Control total |
| **Admin (Operaciones)** | Admin | Dashboard Web - Gestión y validación |
| **Gerente** | Manager | Dashboard Web - Solo lectura, sus tiendas |
| **Promotor** | Staff | TPV Android - Operación en punto de venta |

---

## Funcionalidades por Rol

### Owner (Super Admin de PlayTelecom)

**Plataforma:** Dashboard Web

| Funcionalidad | Descripción |
|---------------|-------------|
| Gestión de usuarios | Crear/editar Admins, Gerentes, Promotores |
| Vista global | Todas las tiendas, todos los promotores |
| Reportes | Métricas de ventas, asistencia, depósitos |
| Configuración | Activar/desactivar módulos, ajustar reglas |

---

### Admin (Operaciones)

**Plataforma:** Dashboard Web

| Funcionalidad | Descripción |
|---------------|-------------|
| Gestión de personal | Asignar gerentes a tiendas, crear promotores |
| Validación de depósitos | Ver comprobantes, aprobar o rechazar |
| Monitoreo de saldos | Ver saldos de todos los promotores |
| Reportes de asistencia | Ver check-ins con foto, hora y ubicación |

**Flujo de validación de depósitos:**
```
Promotor sube foto de voucher
       ↓
Admin ve depósito pendiente
       ↓
Admin revisa foto y monto
       ↓
[Aprobar] → Saldo del promotor se actualiza
[Rechazar] → Promotor recibe notificación
```

---

### Gerente

**Plataforma:** Dashboard Web

| Funcionalidad | Descripción |
|---------------|-------------|
| Vista limitada | Solo ve las tiendas asignadas a él |
| Métricas | Día/semana/mes de sus tiendas |
| Lista de promotores | Solo los de sus tiendas |
| Notificaciones | Alerta cuando un promotor hace check-in |

**Importante:** El gerente NO puede editar ni validar, solo consultar.

---

### Promotor

**Plataforma:** TPV Android (tablet/celular)

| Funcionalidad | Descripción |
|---------------|-------------|
| **Check-in** | Registro de entrada con foto y ubicación |
| **Ventas** | Registro de ventas (efectivo/tarjeta) |
| **Mi saldo** | Ver efectivo recaudado y pendiente de depositar |
| **Subir comprobante** | Foto del voucher de depósito bancario |

---

## Flujos Operativos

### 1. Inicio de Turno (Check-in)

```
┌─────────────────────────────────────┐
│         TPV del Promotor            │
├─────────────────────────────────────┤
│                                     │
│   1. Ingresar PIN personal          │
│   [____]                            │
│                                     │
│   2. Tomar foto                     │
│   ┌─────────────────┐               │
│   │   📷 Cámara     │               │
│   └─────────────────┘               │
│   [Capturar]                        │
│                                     │
│   3. Confirmar ubicación            │
│   📍 19.4326, -99.1332              │
│   Av. Insurgentes 123, CDMX         │
│                                     │
│   [Registrar Entrada]               │
│                                     │
└─────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│   ✅ Check-in registrado            │
│   Gerente notificado                │
└─────────────────────────────────────┘
```

**Datos capturados:**
- Foto del promotor o punto de venta
- Coordenadas GPS
- Fecha y hora exacta
- Dirección aproximada

---

### 2. Durante el Día (Ventas)

```
Promotor registra venta
         │
         ├── Pago en efectivo → cashBalance aumenta
         │
         └── Pago con tarjeta → cardBalance aumenta
```

El promotor puede ver su saldo en cualquier momento:

```
┌─────────────────────────────────────┐
│         💰 Mi Saldo                 │
├─────────────────────────────────────┤
│                                     │
│   Efectivo         $3,450.00        │
│   Tarjeta         $12,800.00        │
│   ─────────────────────────────     │
│   Por depositar    $3,450.00        │
│                                     │
│   [📷 Subir Comprobante]            │
│                                     │
└─────────────────────────────────────┘
```

---

### 3. Fin de Turno (Depósito)

```
┌──────────────────┐
│    PROMOTOR      │
└────────┬─────────┘
         │
         │ 1. Va al banco
         │ 2. Deposita $3,450 en efectivo
         │ 3. Recibe voucher
         │
         ▼
┌─────────────────────────────────────┐
│   Subir Comprobante                 │
├─────────────────────────────────────┤
│                                     │
│   Monto: [$3,450.00]                │
│                                     │
│   ┌─────────────────┐               │
│   │  📷 Foto del    │               │
│   │     voucher     │               │
│   └─────────────────┘               │
│                                     │
│   [Enviar]                          │
│                                     │
└─────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│      ADMIN       │
└────────┬─────────┘
         │
         │ Ve depósito pendiente
         │ Revisa foto y monto
         │
         ├── [Aprobar] → Saldo se libera
         │
         └── [Rechazar] → Promotor notificado
```

---

## Dashboard: Vista del Admin

### Pantalla: Depósitos Pendientes

```
┌─────────────────────────────────────────────────────────────┐
│  Depósitos Pendientes                           [Filtrar ▼] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Juan Pérez          Tienda Centro      $3,450.00    │   │
│  │ Hoy 18:45           [Ver voucher]                   │   │
│  │                                                     │   │
│  │                     [✓ Aprobar]  [✗ Rechazar]       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ María López         Tienda Norte       $2,100.00    │   │
│  │ Hoy 19:20           [Ver voucher]                   │   │
│  │                                                     │
│  │                     [✓ Aprobar]  [✗ Rechazar]       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Pantalla: Reporte de Asistencia

```
┌─────────────────────────────────────────────────────────────┐
│  Asistencia                    [Hoy ▼]  [Todas las tiendas] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────┬─────────────┬──────────┬───────────┬─────────┐  │
│  │ Foto  │ Promotor    │ Tienda   │ Hora      │ Ubicación│  │
│  ├───────┼─────────────┼──────────┼───────────┼─────────┤  │
│  │ 📷    │ Juan Pérez  │ Centro   │ 08:02 AM  │ ✓ OK    │  │
│  │ 📷    │ María López │ Norte    │ 08:15 AM  │ ✓ OK    │  │
│  │ 📷    │ Pedro Ruiz  │ Sur      │ 08:45 AM  │ ⚠️ Tarde │  │
│  └───────┴─────────────┴──────────┴───────────┴─────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Configuración Disponible

El Owner puede ajustar estas opciones sin necesidad de desarrollo:

| Opción | Descripción | Default |
|--------|-------------|---------|
| Requerir foto en check-in | Obligar captura de foto | ✅ Sí |
| Requerir GPS en check-in | Obligar captura de ubicación | ✅ Sí |
| Notificar a gerente | Enviar push cuando promotor hace check-in | ✅ Sí |
| Validación de depósitos | Admin debe aprobar depósitos | ✅ Sí |
| Radio de geofencing | Distancia máxima del punto de venta | 100m |

**Estos ajustes se pueden cambiar en cualquier momento desde el dashboard.**

---

## Etiquetas Personalizadas

En la interfaz, los roles se mostrarán con los nombres que PlayTelecom usa:

| Rol técnico | Se muestra como |
|-------------|-----------------|
| Staff | **Promotor** |
| Manager | **Gerente** |
| Admin | **Administrador** |

---

## Plataformas

| Rol | Plataforma | Dispositivo |
|-----|------------|-------------|
| Owner | Dashboard Web | PC/Mac/Tablet |
| Admin | Dashboard Web | PC/Mac/Tablet |
| Gerente | Dashboard Web | PC/Mac/Tablet |
| Promotor | TPV Android | Tablet Android |

---

## Seguridad

| Aspecto | Implementación |
|---------|----------------|
| Acceso | PIN único por promotor por tienda |
| Fotos | Almacenadas en la nube con acceso restringido |
| GPS | Validación de proximidad al punto de venta |
| Datos | Aislamiento completo entre organizaciones |

---

## Tiempo de Implementación

| Fase | Descripción | Duración |
|------|-------------|----------|
| 1 | Configuración backend | 1-2 días |
| 2 | Check-in con foto/GPS | 1-2 días |
| 3 | Sistema de saldos y depósitos | 2 días |
| 4 | TPV Android (promotor) | 2-3 días |
| 5 | Dashboard (admin/gerente) | 2-3 días |
| **Total** | | **~8-12 días** |

---

## Entregables

1. **TPV Android** con:
   - Check-in verificado (foto + GPS)
   - Registro de ventas
   - Vista de saldo
   - Subida de comprobantes

2. **Dashboard Web** con:
   - Gestión de usuarios
   - Validación de depósitos
   - Reportes de asistencia
   - Métricas por tienda/promotor

3. **Configuración** ajustable:
   - Activar/desactivar módulos
   - Cambiar reglas de validación
   - Personalizar etiquetas

---

## Próximos Pasos

1. ✅ Definición de requisitos (este documento)
2. ⏳ Implementación backend
3. ⏳ Implementación TPV Android
4. ⏳ Implementación Dashboard
5. ⏳ Testing y ajustes
6. ⏳ Despliegue a producción

---

*Documento preparado para PlayTelecom*
*Avoqado - Sistema POS Multi-Industria*
