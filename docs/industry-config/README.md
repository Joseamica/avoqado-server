# Industry Configuration System

Sistema de configuración por industria que permite personalizar el comportamiento de Avoqado para diferentes tipos de negocio (Telecom, Retail, Restaurantes) **sin código específico por cliente**.

---

## Principio Fundamental

```typescript
// PROHIBIDO - Código específico por cliente
if (venue.slug === 'playtelecom') { ... }

// CORRECTO - Comportamiento por configuración
const config = getIndustryConfig(venue)
if (config.attendance.requirePhoto) { ... }
```

---

## Documentación

| Documento | Descripción |
|-----------|-------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Arquitectura Configuration-Driven y patrones |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | Plan de implementación fase por fase |
| [BACKEND_SPEC.md](./BACKEND_SPEC.md) | Especificaciones técnicas del backend |
| [TPV_SPEC.md](./TPV_SPEC.md) | Especificaciones del TPV Android |
| [REQUIREMENTS_TELECOM.md](./REQUIREMENTS_TELECOM.md) | Requisitos específicos de PlayTelecom |

---

## Quick Reference

### Configuración por Industria

```typescript
// Telecom/Retail con promotores
{
  attendance: {
    enabled: true,
    requirePhoto: true,
    requireGPS: true,
    notifyManager: true
  },
  balance: {
    enabled: true,
    trackCash: true,
    trackCard: true,
    requireDepositValidation: true
  },
  hierarchy: {
    managerScopedToStores: true
  },
  roleLabels: {
    WAITER: "Promotor",
    MANAGER: "Gerente"
  }
}

// Restaurante (default)
{
  attendance: { enabled: false },
  balance: { enabled: false },
  hierarchy: { managerScopedToStores: false },
  roleLabels: null
}
```

### Mapeo de Roles

| Telecom (diagrama) | Avoqado | Permisos |
|--------------------|---------|----------|
| Super Admin | `OWNER` | CRUD total, reportes |
| Admin | `ADMIN` | Validar depósitos, gestión |
| Gerente | `MANAGER` | Solo lectura, sus tiendas |
| Promotor | `WAITER` | TPV: check-in, ventas, saldo |

---

## Estado de Implementación

- [ ] **Fase 1**: Configuration System (Backend)
- [ ] **Fase 2**: Attendance con Foto/GPS (Backend)
- [ ] **Fase 3**: Balance y Depósitos (Backend)
- [ ] **Fase 4**: Scope Jerárquico Manager (Backend)
- [ ] **Fase 5**: Foto/GPS en Check-in (TPV Android)
- [ ] **Fase 6**: Saldo y Depósitos (TPV Android)
- [ ] **Fase 7**: UI Admin (Dashboard Web)

**Estimación total: 26-34 horas (~4-5 días)**

---

## Cliente Inicial: PlayTelecom

Este sistema fue diseñado inicialmente para PlayTelecom, una empresa de telecomunicaciones que requiere:

1. Check-in de promotores con foto y GPS
2. Tracking de saldos (efectivo/tarjeta)
3. Validación de depósitos por Admin
4. Gerentes con vista limitada a sus tiendas
5. Notificaciones de check-in a gerentes

Ver [REQUIREMENTS_TELECOM.md](./REQUIREMENTS_TELECOM.md) para detalles completos.
