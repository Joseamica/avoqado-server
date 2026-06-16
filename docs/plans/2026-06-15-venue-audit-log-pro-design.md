# Bitácora de auditoría por-venue (PRO, solo owners) — Design Spec

**Fecha:** 2026-06-15
**Estado:** Aprobado (diseño) — pendiente revisión del spec → plan de implementación
**Repos afectados:** `avoqado-server` (autoritativo), `avoqado-web-dashboard`, presentación de ventas (`Avoqado-HQ`)

---

## 1. Problema

Varios dueños (owners) piden ver el **ActivityLog de toda su sucursal** para auditar "qué está bien y qué está mal" — quién creó/canceló órdenes, quién cobró, quién abrió/cerró caja, quién dio de alta/baja empleados.

Hoy existe parcialmente:
- El modelo `ActivityLog` es maduro (130+ tipos de acción) y hay un endpoint **a nivel organización** (`GET /api/v1/dashboard/organizations/:orgId/activity-log`) con una pantalla (`OrganizationActivityLog.tsx`) que un owner ya puede usar filtrando por venue.
- **Pero:** (a) no hay una bitácora **dedicada por-venue**; (b) los eventos operativos POS más valiosos (creación de orden, pago exitoso, turnos, ciclo de vida de staff) **nunca se registran** en `ActivityLog`; (c) el acceso no está gateado por tier ni catalogado como permiso.

## 2. Objetivo

Entregar una pantalla **`/venues/:slug/activity-log`** donde el **OWNER** audita su sucursal con **filtros completos** (fecha, empleado, acción, entidad, búsqueda, paginación), gateada a **PRO**, reusando el modelo `ActivityLog` existente (sin modelo nuevo) — **y** cerrar las brechas de captura agregando `logAction()` en los puntos POS que hoy faltan.

## 3. Decisiones tomadas (con racional)

| Decisión | Elección | Por qué |
|---|---|---|
| **Tier** | **PRO** vía nuevo `Feature` code `VENUE_AUDIT_LOG` | Es de paga (necesita estados Stripe/trial) ⇒ `Feature`, no `Module`. Mientras NO esté en `PREMIUM_ONLY_CODES`, `venueHasFeatureAccess()` lo concede a PRO+PREMIUM y lo bloquea en FREE — sin lógica extra. |
| **Rol** | **Solo OWNER** vía permiso `activity:read` (default solo OWNER; SUPERADMIN pasa por wildcard) | Cumple "solo owners" hoy, pero queda **asignable** a un gerente si el dueño quiere (modelo estándar de la plataforma) y **auditable** por `npm run audit:permissions`. Mejor que un candado rígido de rol. |
| **Alcance** | Pantalla/endpoint por-venue **+ captura de eventos POS faltantes** | Sin la captura, la pantalla saldría vacía en lo que de verdad pide el dueño. |
| **Captura** | **Explícita** (`logAction()` en cada punto) — Opción A | Un interceptor central (Prisma `$extends`) (1) no conoce el actor (`staffId`) sin `AsyncLocalStorage` frágil, (2) loguearía ruido (heartbeats/scans) que la regla prohíbe, (3) pierde semántica (`Order.create` vs `ORDER_CREATED`). La captura explícita mantiene "quién/qué/cuándo" exacto. |

**Verificación de arquitectura (2026-06-15):** no hay middleware ni Prisma `$use`/`$extends` que auto-guarde mutaciones. Las 319 entradas de auditoría son llamadas explícitas a `logAction()`. El único middleware que escribe `ActivityLog` es `checkPermission` y solo registra `PERMISSION_DENIED`.

## 4. Backend (`avoqado-server`) — repo autoritativo

### 4.1 Feature code (gating de tier)
- Nuevo `Feature` code **`VENUE_AUDIT_LOG`**. Seedear el `Feature` row (script de setup de features) para que sea asignable y aparezca en el catálogo. **NO** agregarlo a `PREMIUM_ONLY_CODES` en `src/services/access/basePlan.service.ts` (eso lo deja como PRO).
- Nota: el gate por tier funciona aunque no exista el `Feature` row (el comentario en `PREMIUM_ONLY_CODES` lo confirma); el row es para asignación explícita (grandfather) + catálogo + Stripe.

### 4.2 Permiso (gating de rol)
Seguir el checklist de `.claude/rules/permissions-policy.md` para **`activity:read`** en `src/lib/permissions.ts`:
1. `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` — catalogarlo (assignable desde el editor de roles).
2. `DEFAULT_PERMISSIONS` — asignarlo **solo a OWNER** (SUPERADMIN ya pasa por `*:*`).
3. `PERMISSION_DEPENDENCIES` — no requiere deps adicionales (es read puro).
4. Si debe filtrarse en modo white-label por feature access: registrar en `PERMISSION_TO_FEATURE_MAP` (`src/services/access/access.service.ts`) mapeando `activity:read` → `VENUE_AUDIT_LOG`.
5. Correr `npm run audit:permissions` (exit 0).

### 4.3 Endpoint
`GET /api/v1/dashboard/venues/:venueId/activity-log` + `/activity-log/actions` + `/activity-log/entities` (para poblar dropdowns).

Cadena de guards (en orden):
```
authenticateTokenMiddleware
→ checkVenueAccess (tenant isolation por venueId)
→ checkFeatureAccess('VENUE_AUDIT_LOG')   // ¿venue en PRO+?
→ checkPermission('activity:read')         // ¿usuario es owner?
```

### 4.4 Servicio
Nueva función `queryVenueActivityLogs(venueId, filters)` en `src/services/dashboard/activity-log.service.ts` — versión **venue-scoped** (sin el rodeo org→venues de `queryActivityLogs`). Reusa la forma de `where`/enriquecido existente. Filtros soportados: `staffId, action, entity, search, startDate, endDate, page, pageSize`. + `getVenueDistinctActions(venueId)` y `getVenueDistinctEntities(venueId)` para los dropdowns.

### 4.5 Captura de eventos faltantes (Opción A)
Agregar `logAction()` (siempre activa, **no** gateada por feature — capturar es barato y evita estrenar la pantalla vacía al subir a PRO) en los puntos de mutación hoy sin auditar. Acciones en SCREAMING_SNAKE:

| Acción | Entity | Dónde (servicio) |
|---|---|---|
| `ORDER_CREATED` | `Order` | `src/services/tpv/order.tpv.service.ts`, `src/services/mobile/order.mobile.service.ts` |
| `PAYMENT_COMPLETED` | `Payment` | `src/services/tpv/payment.tpv.service.ts` (success path de `recordOrderPayment`), pago mobile equivalente |
| `REFUND_ISSUED` | `Payment`/`Refund` | `src/services/mobile/refund.mobile.service.ts` |
| `SHIFT_OPENED` / `SHIFT_CLOSED` | `Shift` | `src/services/tpv/shift.tpv.service.ts` |
| `STAFF_CREATED` / `STAFF_UPDATED` / `STAFF_DELETED` | `Staff` | servicio de staff (hoy solo `logger.info`) |

Cada llamada incluye `staffId` (de `authContext.userId`), `venueId`, `entity`, `entityId`, y un `data` con contexto relevante (monto, método de pago, etc.). **NO** loguear heartbeats/scans/retries.

### 4.6 MCP cliente (obligatorio — regla "keep the customer MCP in sync")
Nuevo tool de **lectura** `get_activity_log` en `src/mcp/tools/`, scoped por `getUserAccess()` (mismo gating de venue/permiso), registrado en `src/mcp/server.ts`. Permite a un owner preguntar a su IA "¿qué pasó en mi negocio?".

## 5. Dashboard (`avoqado-web-dashboard`)

- **Página nueva** `src/pages/Venue/VenueActivityLog.tsx` — clona el patrón de `src/pages/Organization/OrganizationActivityLog.tsx` pero **agrega filtro de rango de fechas + filtro de empleado** (los dos que le faltan al de org). Columnas: acción (icono+badge), entidad, quién (staff), fecha (timezone del venue), detalle JSON expandible. Patrones obligatorios: Stripe FilterPill, expandable search, `useDebounce(300)`, `useVenueDateTime()`, i18n `t()`.
- **Ruta** `/venues/:slug/activity-log` (+ `/wl/venues/:slug/activity-log`). Guards: `FeatureProtectedRoute('VENUE_AUDIT_LOG')` + `SuperProtectedRoute` (OWNER+). Para FREE: entrada en sidebar con candado-teaser → upsell a PRO (FeatureGate).
- **`src/config/plan-catalog.ts`**: agregar `VENUE_AUDIT_LOG` a `PRO.includes` + un `featureKey` (p.ej. `auditLog`) en `PRO.featureKeys`. Esto hace que `getTierForFeature('VENUE_AUDIT_LOG')` → `'PRO'` y el FeatureGate muestre el upsell correcto.
- **`src/config/feature-registry.ts`**: registrar la página (white-label).
- **Servicio** `src/services/...`: `getVenueActivityLog(venueId, filters)` + `getVenueActivityLogActions(venueId)` + `...Entities`.
- **i18n**: keys en `en` + `es` (namespace nuevo o reuso de `activityLog.*`).

## 6. Lockstep cross-repo (mismo cambio)

- **Presentación de ventas** (`~/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/`): agregar "Bitácora de auditoría por sucursal" a lo que incluye **PRO** en el deck (`avoqado-presentacion.html`) **y** el one-pager (`avoqado-one-pager.html`), regenerar ambos PDFs. Es packaging visible al cliente.
- **Schema map**: sin cambio (se reusa `ActivityLog`, no hay modelo nuevo).

## 7. Tests

- **Unit:** `queryVenueActivityLogs` (scoping estricto a 1 venue + cada filtro). Gate de feature: FREE→403, PRO→200, PREMIUM→200. Gate de permiso: no-owner→403, owner→200.
- **Captura:** asserts de que `logAction` se invoca en order-create / payment-success / refund / shift open+close / staff create+update+delete, con `staffId` y `venueId` correctos.
- **Regresión:** el endpoint org-level y la pantalla de org siguen funcionando; el patrón de 319 `logAction` existentes no se rompe.

## 8. Fuera de alcance (por ahora)

- Captura de: estimates, pos-sync (SoftRestaurant), ejecución de chatbot, demo-seed.
- Export/descarga de la bitácora (CSV/PDF).
- Stream en tiempo real (la pantalla pagina + refresca manual).
- Gating en iOS/Android (mirror del feature code) — la pantalla vive en web.

## 9. Secuencia sugerida de implementación

1. Backend: permiso `activity:read` + Feature `VENUE_AUDIT_LOG` (+ audit:permissions verde).
2. Backend: servicio venue-scoped + endpoint + guards.
3. Backend: captura `logAction()` en los puntos POS (incremental, con tests de captura).
4. Backend: MCP tool `get_activity_log`.
5. Dashboard: servicio + página + ruta + guards + sidebar + plan-catalog + feature-registry + i18n.
6. Lockstep: presentación de ventas (deck + one-pager + PDFs).
7. Tests verdes (`npm run pre-deploy` server, `npm run build && lint && test:e2e` dashboard).

## 10. Riesgos / notas

- **Fallo silencioso de gating:** confirmar que `VENUE_AUDIT_LOG` es `Feature` (no `Module`) y gatear con `venueHasFeatureAccess` — cruzarlo con el resolver de módulos pasa para todos los grandfathered.
- **Nombre del permiso:** `activity:read` debe existir en ≥1 de los 3 exports de `permissions.ts` o es "phantom".
- **No remover/renombrar campos de respuesta API** (compatibilidad TPV). Este cambio solo agrega.
