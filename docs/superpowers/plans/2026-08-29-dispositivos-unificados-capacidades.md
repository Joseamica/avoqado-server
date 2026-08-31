# Dispositivos unificados por capacidades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar TPV, POS móvil y futuros aparatos como “Dispositivos” sin crear otro modelo, y permitir sólo las acciones que el servidor
sabe que cada aparato puede ejecutar.

**Architecture:** `Terminal` sigue siendo la única identidad persistida y los endpoints históricos `/tpv`/`terminals` siguen siendo
contratos compatibles. Un resolver central del servidor combina tipo, observación fresca del cliente y permisos para producir capacidades
efectivas. La inversión de pantalla deja de ser un `PUT` optimista y pasa a ser una intención durable con CAS, expiración y ACK del Android
exacto. El dashboard adopta `/devices` sólo como ruta y lenguaje canónicos; Android anuncia hardware y consume la intención; TPV e iOS no
cambian en v1.

**Tech Stack:** TypeScript, Express, Prisma/PostgreSQL, Jest, React 18, React Router, TanStack Query, Vitest, Kotlin, Hilt, coroutines,
OkHttp, AndroidX Lifecycle.

**Spec:** `docs/superpowers/specs/2026-08-29-dispositivos-unificados-capacidades-design.md`

## Global Constraints

- **Una sola tabla:** no crear `Device`, no migrar IDs y no duplicar filas. `Terminal.id` y `[venueId, deviceUid]` siguen siendo identidad y
  unicidad.
- **Cero big-bang:** no renombrar Prisma `Terminal`, controladores, permisos, sockets, MCP ni endpoints históricos. Los nombres internos
  `tpv` pueden permanecer mientras sean implementación.
- **Sin branch ni worktree nuevos:** ejecutar en los checkouts actuales, preservando el WIP ajeno. Nunca `reset`, `checkout`, `clean` ni
  `stash`.
- **Sin activación para POS:** `POS_ANDROID`, `POS_IOS` y `POS_DESKTOP` se auto-registran y operan sin código, alta manual o switch.
  `requiresActivation=false` es una capacidad, no una inferencia de `activatedAt`.
- **Capacidad y permiso son dos candados:** una acción se muestra/acepta sólo si `capability=true` **y** el actor tiene el permiso vigente.
  Display reutiliza `tpv:update`; comandos conservan `tpv:command`; lecturas conservan `tpv:read`. No se crea permiso paralelo.
- **FREE y sin feature switch:** esta unificación pertenece al núcleo gratuito. No agregar `VenueFeature`, módulo o toggle de venue.
- **Fail closed para acciones, fail open para ventas:** una capacidad desconocida oculta/rechaza acciones remotas, pero un fallo al
  registrar/reportar/pollear jamás bloquea login, navegación, cobro u operación offline.
- **Presencia no implica inversión:** `customerDisplay.present` y `customerDisplay.invertible` se reportan y resuelven por separado.
- **Autoridad por contexto:** sin intención tipada, el ajuste local actual sigue mandando. Una intención nueva supera dirty local previo; si
  el operador cambia físicamente después de que Android journalizó la intención, el cambio local gana y Android responde
  `REJECTED/LOCAL_OVERRIDE` sin borrar dirty en silencio.
- **No estado optimista:** `customerDisplayInverted` cambia sólo al ACK del dispositivo. El dashboard muestra `PENDING`, `APPLIED`,
  `REJECTED`, `EXPIRED`, `CANCELLED` o `CANCEL_TOO_LATE`.
- **Atomicidad:** todo cambio CAS de intención y su `ActivityLog` se ejecutan en la misma `prisma.$transaction` mediante
  `writeLegacyActivityAuditTx`.
- **TTL y frescura fijos:** intención 15 minutos; capacidades de pantalla frescas por 7 días; Android vuelve a observar/reportar como máximo
  cada 24 horas.
- **Offline explícito:** el Android persiste un mini-journal por `[venueId, deviceId, requestId]`, no aplica intenciones expiradas y drena
  el ACK de A antes de aplicar B.
- **Paridad móvil consciente:** no hay cambio iOS porque iOS no ofrece customer display en v1; el servidor devuelve `UNSUPPORTED`. Esta es
  una excepción por hardware/plataforma, no una divergencia de negocio.
- **No borrar dispositivos:** retiro sigue siendo `RETIRED`. Este plan no agrega ni relaja endpoints de borrado.
- **Deploy seguro:** servidor aditivo → Android → QA en hardware → dashboard → ventana de observación → rechazo del `PUT` legado. Cada fase
  debe poder detenerse sin revertir datos.
- **Commits sólo con autorización explícita del founder.** Los pasos de commit quedan documentados, pero se omiten hasta recibir ese OK. En
  el árbol compartido enumerar siempre las rutas exactas después de `git commit --`; nunca usar `git add .`/`git add -A` ni un commit sin
  paths.
- **Verificación pesada por `avq-verify`:** ejecutar desde `/Users/amieva/Documents/Programming/Avoqado`; nunca correr builds/suites pesadas
  directamente.

## File Structure

### `avoqado-server`

| Archivo                                                                                                | Responsabilidad                                                                         |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                                                                 | Campos observados, versión CAS, JSON de intención e índice de expiración en `Terminal`. |
| `prisma/migrations/20260829170000_unified_device_capabilities/migration.sql`                           | Migración aditiva, sin renombres ni deletes.                                            |
| `src/services/device-capabilities.service.ts`                                                          | Matriz canónica por `TerminalType`, frescura y permisos.                                |
| `src/services/mobile/deviceRegistry.service.ts`                                                        | Auto-registro idempotente; carrera P2002 relee la fila ganadora.                        |
| `src/middlewares/registerDevice.middleware.ts`                                                         | Evita repetir el registro cuando un endpoint ya lo aseguró.                             |
| `src/schemas/mobile/deviceCapabilities.mobile.schema.ts`                                               | Body estricto del reporte Android.                                                      |
| `src/controllers/mobile/deviceCapabilities.mobile.controller.ts`                                       | Une reporte con el dispositivo exacto de `X-Device-ID`.                                 |
| `src/services/display-mode-request.service.ts`                                                         | Crear/cancelar/expirar/resolver intención mediante CAS.                                 |
| `src/schemas/dashboard/displayModeRequest.schema.ts`                                                   | Body del dashboard y params de cancelación.                                             |
| `src/schemas/mobile/tpvSettings.mobile.schema.ts`                                                      | ACK compatible: body antiguo sigue válido.                                              |
| `src/controllers/dashboard/displayModeRequest.dashboard.controller.ts`                                 | POST/DELETE de intención con tenant y `tpv:update`.                                     |
| `src/controllers/mobile/tpvSettings.mobile.controller.ts`                                              | GET de intención y ACK ligado al propio dispositivo.                                    |
| `src/routes/dashboard.routes.ts`                                                                       | Rutas nuevas bajo `/terminals/:terminalId/display-mode-request`.                        |
| `src/routes/mobile.routes.ts`                                                                          | PUT capabilities, GET request y PATCH ACK.                                              |
| `src/jobs/display-mode-request-expiry.job.ts`                                                          | Expira intenciones vencidas de forma idempotente.                                       |
| `src/jobs/jobSchedules.ts`, `src/server.ts`                                                            | Agenda, arranque y apagado del job.                                                     |
| `src/services/dashboard/tpv.dashboard.service.ts`                                                      | Lista/detalle devuelven capacidades efectivas.                                          |
| `src/services/organization-dashboard/orgTerminals.service.ts`                                          | Misma proyección en vista organización.                                                 |
| `src/services/tpv/command-queue.service.ts`                                                            | Rechaza comandos fuera del allowlist del tipo.                                          |
| `src/services/tpv/tpv-health.service.ts`                                                               | Liveness TPV no cambia lifecycle de POS.                                                |
| `src/mcp/tools/terminals.ts`                                                                           | `list_devices` y acciones consumen el mismo resolver.                                   |
| `scripts/remediate-pos-terminal-status.ts`                                                             | Dry-run/aplicación idempotente de POS erróneamente inactivos.                           |
| `tests/unit/services/*.test.ts`, `tests/unit/controllers/mobile/*.test.ts`, `tests/unit/mcp/*.test.ts` | Contratos, matriz, carreras, permisos y estados.                                        |
| `tests/integration/tpv/display-mode-request-cas.integration.test.ts`                                   | Prueba real de CAS y audit atómico.                                                     |

### `avoqado-android`

| Archivo                                                                                | Responsabilidad                                                                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `gradle/libs.versions.toml`, `app/build.gradle.kts`                                    | `lifecycle-process` con la versión AndroidX ya usada.                                                         |
| `app/src/main/java/com/avoqado/pos/customerdisplay/DisplayCapabilitySnapshot.kt`       | Observación pura de presencia/invertibilidad.                                                                 |
| `app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeRequest.kt`              | DTOs y decisiones puras de intención/ACK.                                                                     |
| `app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeRequestStore.kt`         | Mini-journal persistente y scopeado.                                                                          |
| `app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeRemoteRepository.kt`     | PUT de capacidades, GET de intención y PATCH ACK.                                                             |
| `app/src/main/java/com/avoqado/pos/customerdisplay/DeviceCapabilitySyncCoordinator.kt` | Poll foreground, jitter, backoff, serialización y recuperación de red.                                        |
| `app/src/main/java/com/avoqado/pos/customerdisplay/CustomerDisplayState.kt`            | Fuente única del snapshot combinado observado por el manager y consumido por el coordinator.                  |
| `app/src/main/java/com/avoqado/pos/customerdisplay/CustomerDisplayManager.kt`          | Actualiza `CustomerDisplayState` después del refresh real; no crea otro flow.                                 |
| `app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModePrefs.kt`                | Persiste valor remoto antes de reconfigurar pantallas.                                                        |
| `app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeSync.kt`                 | Autoridad local sin request y remota con request.                                                             |
| `app/src/main/java/com/avoqado/pos/tpvsettings/data/TpvSettingsRepository.kt`          | Evita reconcile legacy mientras el journal tenga una intención in-flight; no entrega requests al coordinator. |
| `app/src/main/java/com/avoqado/pos/auth/presentation/AppState.kt`                      | Señala login/logout/cambio de venue sin bloquearlos.                                                          |
| `app/src/main/java/com/avoqado/pos/AvoqadoApp.kt`                                      | Enlaza el coordinator al lifecycle del proceso.                                                               |
| `app/src/test/java/com/avoqado/pos/customerdisplay/*.kt`                               | Hardware, journal, HTTP, orden, expiry y lifecycle.                                                           |

### `avoqado-web-dashboard`

| Archivo                                                                               | Responsabilidad                                                                          |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/services/tpv.service.ts`                                                         | Tipos efectivos y API de crear/cancelar intención.                                       |
| `src/pages/Tpv/deviceCapabilities.ts`                                                 | Helpers puros para visibilidad y lifecycle.                                              |
| `src/pages/Tpv/components/DisplayModeRequestControl.tsx`                              | Control explícito de inversión y estados.                                                |
| `src/pages/Tpv/TpvId.tsx`                                                             | Compone acciones según capacidades; sin `PUT` genérico de display.                       |
| `src/pages/Tpv/Tpvs.tsx`                                                              | Lista “Dispositivos” y activación sólo donde aplica.                                     |
| `src/pages/Tpv/components/RemoteCommandPanel.tsx`                                     | Sólo muestra comandos incluidos en `supportedRemoteCommands`.                            |
| `src/pages/Organization/components/OrgTerminalDrawer.tsx`                             | Misma política en vista organización.                                                    |
| `src/routes/LegacyRedirect.tsx`                                                       | Extender el redirect existente para destinos dinámicos preservando params, query y hash. |
| `src/routes/venueRoutes.tsx`                                                          | `/devices` canónico, `/tpv` legado.                                                      |
| `src/components/Sidebar/app-sidebar.tsx` y enlaces listados en Task 15                | Navegación interna canónica.                                                             |
| `src/locales/{es,en,fr}/sidebar.json`, `src/locales/{es,en,fr}/tpv.json`              | Copy “Dispositivos” y estados de intención.                                              |
| `src/pages/Tpv/**/__tests__/*.test.tsx`, `src/routes/__tests__/DeviceRoutes.test.tsx` | Visibilidad, estados y redirects.                                                        |

### `Avoqado-HQ/operations/marketing/platform-presentation` (condicional)

| Archivo                             | Responsabilidad                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Los cuatro HTML listados en Task 22 | Modificar sólo si la búsqueda encuentra una afirmación afectada; mantener variante PAX en sync. |
| Los cuatro PDF listados en Task 22  | Regenerar sólo cuando cambie su HTML fuente.                                                    |

---

## Phase A — Server additive foundation

### Task 0: Capturar baseline y comprobar que `TPV_IOS` no tiene executor remoto

**Files:** ninguno; es una verificación read-only antes de cambiar comportamiento.

- [ ] **Step 1: Buscar consumidores reales por tipo**

```bash
rg -n "TPV_IOS|POS_IOS|TPV_ANDROID|POS_ANDROID|terminal-payment-request|refund.*terminal|tpv-command|command.*heartbeat" avoqado-server/src avoqado-tpv/app/src/main avoqado-android/app/src/main avoqado-ios
```

Esperado: el executor de comandos y de cobro físico remoto existe en `avoqado-tpv` para TPV Android; no existe executor `TPV_IOS`.
`POS_IOS` sí puede **originar** solicitudes de pago/refund hacia una TPV Android y ese flujo se conserva; originar no concede
`canAcceptTerminalPaymentRequests` al POS iOS.

- [ ] **Step 2: Medir filas sin imprimir IDs ni datos del venue**

```bash
./scripts/avq-verify.sh avoqado-server node -e 'const {PrismaClient}=require("@prisma/client"); const p=new PrismaClient(); Promise.all([p.terminal.count({where:{type:"TPV_IOS"}}),p.terminal.count({where:{type:"TPV_IOS",activatedAt:{not:null}}}),p.terminal.count({where:{type:"TPV_IOS",deviceUid:{not:null}}})]).then(([total,activated,identified])=>console.log(JSON.stringify({type:"TPV_IOS",total,activated,identified}))).finally(()=>p.$disconnect())'
```

Guardar sólo los tres conteos como evidencia del plan.

- [ ] **Step 3: Aplicar el guard de compatibilidad**

La matriz conserva `TPV_IOS.requiresActivation=true`, `canManagePaymentConfiguration=true`, `canAcceptTerminalPaymentRequests=false` y
comandos vacíos. Si Step 1 demuestra un executor iOS real de cobro/comandos en producción, detener Task 1 y enmendar spec/plan antes de
negar esa acción; no introducir una regresión para hacer cuadrar la taxonomía.

### Task 1: Codificar la matriz canónica de capacidades

**Files:**

- Create: `avoqado-server/src/services/device-capabilities.service.ts`
- Create: `avoqado-server/tests/unit/services/deviceCapabilities.service.test.ts`

**Interfaces:**

```typescript
export type CapabilityState = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN'

export interface EffectiveDeviceCapabilities {
  requiresActivation: boolean
  canManagePaymentConfiguration: boolean
  canAcceptTerminalPaymentRequests: boolean
  customerDisplay: {
    presence: CapabilityState
    invertibility: CapabilityState
    canRequestInversion: boolean
    observedAt: string | null
    stale: boolean
  }
  supportedRemoteCommands: TpvCommandType[]
}

export function resolveEffectiveDeviceCapabilities(
  terminal: DeviceCapabilitySnapshot,
  context?: { now?: Date },
): EffectiveDeviceCapabilities
```

- [ ] **Step 1: Escribir el test rojo de la matriz completa**

Cubrir exactamente:

| Tipo                                        | Activación | Config pagos | Solicitudes de cobro | Display                   | Comandos                                                                                           |
| ------------------------------------------- | ---------: | -----------: | -------------------: | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `TPV_ANDROID`                               |         sí |           sí |                   sí | `UNSUPPORTED`             | todos los ejecutados por `CommandExecutor.kt`, excepto `SCHEDULE`, `GEOFENCE_TRIGGER`, `TIME_RULE` |
| `TPV_IOS`                                   |         sí |           sí |                   no | `UNSUPPORTED`             | ninguno                                                                                            |
| `POS_ANDROID` fresco true/true              |         no |           no |                   no | `SUPPORTED`/`SUPPORTED`   | ninguno                                                                                            |
| `POS_ANDROID` fresco true/false             |         no |           no |                   no | `SUPPORTED`/`UNSUPPORTED` | ninguno                                                                                            |
| `POS_ANDROID` sin reporte o >7 días         |         no |           no |                   no | `UNKNOWN`/`UNKNOWN`       | ninguno                                                                                            |
| `POS_IOS`, `POS_DESKTOP`, `KDS`, impresoras |         no |           no |                   no | `UNSUPPORTED`             | ninguno                                                                                            |

Agregar asserts de que `canRequestInversion` exige presencia e invertibilidad frescas y `displayModeProtocolVersion===1`. No recibe ni
incorpora permisos: el caller combina después capacidad **AND** `tpv:update`.

- [ ] **Step 2: Correr el test y confirmar el rojo**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --runInBand tests/unit/services/deviceCapabilities.service.test.ts
```

Esperado: FAIL por módulo inexistente.

- [ ] **Step 3: Implementar constantes y resolver puro**

```typescript
export const CAPABILITY_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000

const TPV_ANDROID_COMMANDS: readonly TpvCommandType[] = [
  'LOCK',
  'UNLOCK',
  'MAINTENANCE_MODE',
  'EXIT_MAINTENANCE',
  'REACTIVATE',
  'REMOTE_ACTIVATE',
  'RESTART',
  'SHUTDOWN',
  'CLEAR_CACHE',
  'FORCE_UPDATE',
  'REQUEST_UPDATE',
  'INSTALL_VERSION',
  'SYNC_DATA',
  'FACTORY_RESET',
  'EXPORT_LOGS',
  'UPDATE_CONFIG',
  'REFRESH_MENU',
  'UPDATE_MERCHANT',
  'FETCH_ANGELPAY_MERCHANTS',
]
```

Para `POS_ANDROID`, si `capabilitiesObservedAt` falta o está vencido, devolver ambos estados `UNKNOWN`; nunca convertir `null` en `false`.
Para tipos explícitamente no compatibles, devolver `UNSUPPORTED` aunque no exista observación.

- [ ] **Step 4: Volver a correr y confirmar verde**

Esperado: PASS de todos los casos de matriz y frescura.

- [ ] **Step 5: Commit de checkpoint sólo si ya existe autorización**

```bash
cd avoqado-server && git commit -- src/services/device-capabilities.service.ts tests/unit/services/deviceCapabilities.service.test.ts -m "feat: centralize device capabilities"
```

### Task 2: Añadir almacenamiento aditivo en `Terminal`

**Files:**

- Modify: `avoqado-server/prisma/schema.prisma`
- Create: `avoqado-server/prisma/migrations/20260829170000_unified_device_capabilities/migration.sql`
- Modify: `avoqado-server/docs/SCHEMA_MAP.md` (generado por el script del repo)

- [ ] **Step 1: Añadir los campos sin tocar nombres existentes**

```prisma
customerDisplayPresent         Boolean?
customerDisplayInvertible      Boolean?
displayModeProtocolVersion     Int?
capabilitiesObservedAt         DateTime?
customerDisplayInverted        Boolean  @default(false)
customerDisplayRequest         Json?
customerDisplayRequestVersion  Int      @default(0)
customerDisplayRequestExpiresAt DateTime?

@@index([customerDisplayRequestExpiresAt])
```

`customerDisplayInverted` ya existe: moverlo junto al bloque si mejora lectura, pero no duplicarlo ni renombrarlo.

- [ ] **Step 2: Escribir la migración SQL aditiva exacta**

```sql
ALTER TABLE "Terminal"
  ADD COLUMN "customerDisplayPresent" BOOLEAN,
  ADD COLUMN "customerDisplayInvertible" BOOLEAN,
  ADD COLUMN "displayModeProtocolVersion" INTEGER,
  ADD COLUMN "capabilitiesObservedAt" TIMESTAMP(3),
  ADD COLUMN "customerDisplayRequest" JSONB,
  ADD COLUMN "customerDisplayRequestVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "customerDisplayRequestExpiresAt" TIMESTAMP(3);

CREATE INDEX "Terminal_customerDisplayRequestExpiresAt_idx"
  ON "Terminal"("customerDisplayRequestExpiresAt");
```

No incluir `UPDATE`, `DROP`, rename ni `NOT NULL` sin default.

- [ ] **Step 3: Validar Prisma y regenerar mapa**

```bash
./scripts/avq-verify.sh avoqado-server npx prisma validate
./scripts/avq-verify.sh avoqado-server npm run schema:map
```

Esperado: schema válido; `SCHEMA_MAP.md` lista los siete campos nuevos y el índice.

- [ ] **Step 4: Inspeccionar el SQL antes de cualquier deploy**

```bash
rg -n "DROP|RENAME|DELETE|UPDATE" avoqado-server/prisma/migrations/20260829170000_unified_device_capabilities/migration.sql
```

Esperado: sin salida.

- [ ] **Step 5: Commit de checkpoint sólo si está autorizado**

```bash
cd avoqado-server && git commit -- prisma/schema.prisma prisma/migrations/20260829170000_unified_device_capabilities/migration.sql docs/SCHEMA_MAP.md -m "db: store observed device capabilities"
```

### Task 3: Hacer fiable el auto-registro y recibir capacidades Android

**Files:**

- Modify: `avoqado-server/src/services/mobile/deviceRegistry.service.ts`
- Modify: `avoqado-server/src/middlewares/registerDevice.middleware.ts`
- Create: `avoqado-server/src/schemas/mobile/deviceCapabilities.mobile.schema.ts`
- Create: `avoqado-server/src/controllers/mobile/deviceCapabilities.mobile.controller.ts`
- Modify: `avoqado-server/src/routes/mobile.routes.ts`
- Modify: `avoqado-server/tests/unit/services/mobile/deviceRegistry.service.test.ts`
- Create: `avoqado-server/tests/unit/controllers/mobile/deviceCapabilities.mobile.controller.test.ts`

**Contract:**

```http
PUT /api/v1/mobile/venues/:venueId/device-capabilities
X-Device-ID: avq-device-7f3c9a21
X-Device-Platform: ANDROID
Content-Type: application/json

{
  "customerDisplay": { "present": true, "invertible": false },
  "displayModeProtocolVersion": 1
}
```

- [ ] **Step 1: Escribir tests rojos del registro concurrente**

Agregar a `deviceRegistry.service.test.ts`:

- dos altas simultáneas para `[venueId, deviceUid]` producen una sola fila;
- el perdedor P2002 relee y devuelve `{terminalId, created:false}` en vez de `null`;
- el auto-registro POS queda `ACTIVE`, `selfRegistered=true`, sin `activatedAt` ni activation code;
- una terminal `RETIRED` existente no se reactiva por heartbeat.

- [ ] **Step 2: Extraer `ensureDeviceTerminal` sin cambiar el contrato no bloqueante**

`registerDeviceSeen` puede delegar, pero el helper nuevo debe devolver la fila ganadora en P2002:

```typescript
const winner = await prisma.terminal.findFirst({
  where: { venueId, deviceUid: identity.deviceUid },
  select: { id: true, name: true },
})
return winner ? { terminalId: winner.id, created: false, name: winner.name } : null
```

- [ ] **Step 3: Escribir tests rojos del endpoint**

Cubrir 401 sin sesión, 400 sin headers, 403 por venue ajeno, 200 con binding exacto, y 503 `DEVICE_REGISTRY_UNAVAILABLE` cuando el registro
explícito no obtiene fila. Confirmar que el error sólo afecta este PUT y no middleware de login/cobro.

- [ ] **Step 4: Implementar schema/controlador/ruta**

El controlador:

1. marca `res.locals.deviceRegistrationHandled = true` antes de asegurar registro;
2. llama `ensureDeviceTerminal` con el staff autenticado y headers normalizados;
3. verifica que el `terminalId` resultante pertenece a `:venueId` y a `X-Device-ID`;
4. valida `displayModeProtocolVersion` con `z.literal(1)` y actualiza únicamente `customerDisplayPresent`, `customerDisplayInvertible`,
   `displayModeProtocolVersion`, `capabilitiesObservedAt=now()` y `lastHeartbeat`;
5. responde 200 con `{data:{terminalId, observedAt}}`.

El finish hook del middleware consulta `res.locals.deviceRegistrationHandled !== true` antes de registrar.

- [ ] **Step 5: Ejecutar tests enfocados**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --runInBand tests/unit/services/mobile/deviceRegistry.service.test.ts tests/unit/controllers/mobile/deviceCapabilities.mobile.controller.test.ts
```

Esperado: PASS; ninguna prueba espera activación de POS.

- [ ] **Step 6: Commit autorizado**

```bash
cd avoqado-server && git commit -- src/services/mobile/deviceRegistry.service.ts src/middlewares/registerDevice.middleware.ts src/schemas/mobile/deviceCapabilities.mobile.schema.ts src/controllers/mobile/deviceCapabilities.mobile.controller.ts src/routes/mobile.routes.ts tests/unit/services/mobile/deviceRegistry.service.test.ts tests/unit/controllers/mobile/deviceCapabilities.mobile.controller.test.ts -m "feat: accept passive device capability reports"
```

### Task 4: Implementar la máquina de estados durable de inversión

**Files:**

- Create: `avoqado-server/src/services/display-mode-request.service.ts`
- Create: `avoqado-server/tests/unit/services/displayModeRequest.service.test.ts`
- Create: `avoqado-server/tests/integration/tpv/display-mode-request-cas.integration.test.ts`

**Stored JSON:**

```typescript
type DisplayModeRequestStatus = 'PENDING' | 'APPLIED' | 'REJECTED' | 'SUPERSEDED' | 'CANCELLED' | 'EXPIRED'
type DisplayModeResultCode =
  | 'DISPLAY_NOT_PRESENT'
  | 'DISPLAY_NOT_INVERTIBLE'
  | 'APPLY_FAILED'
  | 'LOCAL_OVERRIDE'
  | 'CANCEL_TOO_LATE'
  | 'ACK_AFTER_EXPIRY'
  | 'DEVICE_RETIRED'

interface DisplayModeRequestRecord {
  requestId: string
  desiredInverted: boolean
  status: DisplayModeRequestStatus
  requestedAt: string
  requestedBy: string
  expiresAt: string
  resolvedAt?: string
  resultCode?: DisplayModeResultCode
}
```

- [ ] **Step 1: Escribir unit tests rojos de transiciones**

Casos obligatorios: crear A; crear B supersede A; cancelar PENDING; cancelar después de APPLIED produce `CANCEL_TOO_LATE`; expirar; ACK
APPLIED; ACK REJECTED; ACK `LOCAL_OVERRIDE` actualiza el estado físico elegido localmente; ACK tras expiry actualiza estado físico y marca
`ACK_AFTER_EXPIRY`; ACK viejo no pisa request nuevo; `RETIRED` rechaza.

- [ ] **Step 2: Implementar decisiones puras y servicio CAS**

Toda escritura usa el patrón:

```typescript
await prisma.$transaction(async tx => {
  const result = await tx.terminal.updateMany({
    where: { id: terminalId, venueId, customerDisplayRequestVersion: expectedVersion },
    data: {
      customerDisplayRequest: nextRequest as Prisma.InputJsonValue,
      customerDisplayRequestVersion: { increment: 1 },
      customerDisplayRequestExpiresAt: nextExpiry,
      ...(confirmedPhysicalValue === undefined ? {} : { customerDisplayInverted: confirmedPhysicalValue }),
    },
  })
  if (result.count !== 1) throw new DisplayModeCasConflictError()
  await writeLegacyActivityAuditTx(tx, auditInput)
})
```

En conflicto, releer, revalidar y reintentar una vez; si el segundo CAS pierde, responder 409 `DISPLAY_MODE_CONFLICT`.

Usar acciones estructuradas: `DISPLAY_MODE_REQUESTED` al crear/superar y `DISPLAY_MODE_RESOLVED` al aplicar, rechazar o cancelar. Sus `data`
incluyen requestId, status/resultCode, requestedAt, resolvedAt y latencyMs; no guardar payloads arbitrarios ni PII. Task 6 añade
`DISPLAY_MODE_EXPIRED` con el mismo contrato.

- [ ] **Step 3: Escribir integración roja de dos escritores reales**

Lanzar dos `createRequest` concurrentes sobre la misma terminal y comprobar:

- una petición queda corriente;
- la otra queda superseded o recibe conflicto reintentable, nunca se pierden ambas;
- `customerDisplayRequestVersion` aumenta monotónicamente;
- cada mutación exitosa tiene un `ActivityLog` correspondiente en la misma transacción, con acción estable, `requestId`, `requestedAt`,
  `resolvedAt`, `latencyMs`, status y resultCode suficientes para calcular el gate sin parsear logs de texto.

- [ ] **Step 4: Correr unit e integration**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --runInBand tests/unit/services/displayModeRequest.service.test.ts
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --runInBand tests/integration/tpv/display-mode-request-cas.integration.test.ts
```

Esperado: PASS. Si el segundo comando imprime `INCONCLUSO` o `DIFIEREN`, investigar la evidencia; no aceptar uno de los lados como verde.

- [ ] **Step 5: Commit autorizado**

```bash
cd avoqado-server && git commit -- src/services/display-mode-request.service.ts tests/unit/services/displayModeRequest.service.test.ts tests/integration/tpv/display-mode-request-cas.integration.test.ts -m "feat: add durable display mode requests"
```

### Task 5: Exponer creación, cancelación, entrega y ACK compatible

**Files:**

- Create: `avoqado-server/src/schemas/dashboard/displayModeRequest.schema.ts`
- Create: `avoqado-server/src/controllers/dashboard/displayModeRequest.dashboard.controller.ts`
- Modify: `avoqado-server/src/controllers/dashboard/tpv.dashboard.controller.ts`
- Modify: `avoqado-server/src/schemas/mobile/tpvSettings.mobile.schema.ts`
- Modify: `avoqado-server/src/controllers/mobile/tpvSettings.mobile.controller.ts`
- Modify: `avoqado-server/src/routes/dashboard.routes.ts`
- Modify: `avoqado-server/src/routes/mobile.routes.ts`
- Create: `avoqado-server/tests/unit/controllers/dashboard/displayModeRequest.dashboard.controller.test.ts`
- Create or Modify: `avoqado-server/tests/unit/controllers/dashboard/tpv.dashboard.controller.test.ts`
- Modify: `avoqado-server/tests/unit/controllers/mobile/tpvSettings.mobile.controller.test.ts`

**Routes:**

```text
POST   /api/v1/dashboard/venues/:venueId/terminals/:terminalId/display-mode-request
DELETE /api/v1/dashboard/venues/:venueId/terminals/:terminalId/display-mode-request/:requestId
GET    /api/v1/mobile/venues/:venueId/display-mode-request
PATCH  /api/v1/mobile/venues/:venueId/terminals/:terminalId/display-mode
```

- [ ] **Step 1: Escribir tests rojos del dashboard**

POST exige tenant + `tpv:update`, body estricto `{desiredInverted:boolean}`, terminal del venue, `POS_ANDROID`, reporte fresco, presencia e
invertibilidad `SUPPORTED`, `displayModeProtocolVersion===1`. Responde 202 con request PENDING. Cada incumplimiento responde 404/403/409/422
con código estable, nunca 200 silencioso.

DELETE sólo cancela el `requestId` corriente; si llegó tarde devuelve 409 con `CANCEL_TOO_LATE` y el valor físico confirmado.

- [ ] **Step 2: Escribir tests rojos del móvil**

GET liga por `X-Device-ID` + venue y responde siempre `{data:{terminalId,request: CustomerDisplayRequest|null}}` para el propio aparato. El
`terminalId` viene del binding exacto, nunca del body, y permite construir el PATCH después de process death. PATCH acepta ambos cuerpos:

```json
{ "customerDisplayInverted": true }
```

```json
{ "customerDisplayInverted": true, "requestId": "req-1", "outcome": "APPLIED" }
```

El body nuevo permite `outcome:"REJECTED"` y `resultCode`, incluido `LOCAL_OVERRIDE`; el cuerpo viejo no se capability-gatea y sigue
actualizando el aparato exacto. Un `terminalId` de otro `X-Device-ID` devuelve 403 `DEVICE_BINDING_MISMATCH`.

- [ ] **Step 3: Implementar schemas, controladores y rutas**

Quitar del controlador móvil la validación débil “terminal pertenece al venue” y reemplazarla por `{id, venueId, deviceUid: X-Device-ID}`.
No aceptar un ACK desde otro teléfono del mismo venue. No acoplar `getVenueTpvSettings` al coordinator: el GET ligero es el único canal de
entrega v1 y devuelve la identidad necesaria para ACK.

En el mismo cambio, instrumentar desde el día uno cualquier `PUT /dashboard/venues/:venueId/tpv/:id` cuyo body contenga
`customerDisplayInverted`: escribir `LEGACY_DISPLAY_MODE_UPDATE_USED` con terminal/venue, versión de app o user-agent sanitizado y sin PII,
conservando exactamente el status/body legacy. El test demuestra que la métrica se escribe y la respuesta no cambia.

- [ ] **Step 4: Correr tests enfocados**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --runInBand tests/unit/controllers/dashboard/displayModeRequest.dashboard.controller.test.ts tests/unit/controllers/mobile/tpvSettings.mobile.controller.test.ts
```

Esperado: PASS para compatibilidad antigua y binding nuevo.

- [ ] **Step 5: Commit autorizado**

```bash
cd avoqado-server && git commit -- src/schemas/dashboard/displayModeRequest.schema.ts src/controllers/dashboard/displayModeRequest.dashboard.controller.ts src/controllers/dashboard/tpv.dashboard.controller.ts src/schemas/mobile/tpvSettings.mobile.schema.ts src/controllers/mobile/tpvSettings.mobile.controller.ts src/routes/dashboard.routes.ts src/routes/mobile.routes.ts tests/unit/controllers/dashboard/displayModeRequest.dashboard.controller.test.ts tests/unit/controllers/dashboard/tpv.dashboard.controller.test.ts tests/unit/controllers/mobile/tpvSettings.mobile.controller.test.ts -m "feat: expose typed display mode intents"
```

### Task 6: Expirar intenciones sin depender de lecturas

**Files:**

- Create: `avoqado-server/src/jobs/display-mode-request-expiry.job.ts`
- Modify: `avoqado-server/src/jobs/jobSchedules.ts`
- Modify: `avoqado-server/src/server.ts`
- Create: `avoqado-server/tests/unit/jobs/display-mode-request-expiry.job.test.ts`
- Modify: `avoqado-server/tests/unit/jobs/job-schedule-hardening.test.ts`

- [ ] **Step 1: Escribir test rojo del sweeper idempotente**

Con reloj fijo, seleccionar sólo `customerDisplayRequestExpiresAt <= now`, request `PENDING`; marcar `EXPIRED`, limpiar expiry indexable,
incrementar versión y auditar `DISPLAY_MODE_EXPIRED` con requestId/requestedAt/resolvedAt/latencyMs. Dos ejecuciones producen una sola
transición.

- [ ] **Step 2: Implementar job y schedule**

Agregar `displayModeRequestExpiry: '4 * * * * *'` a `DATABASE_JOB_SCHEDULES`. Usar `scheduleJob`, guard `isRunning`, retry sólo para
conexión DB y métodos `start/stop/checkNow` como `tpv-health-monitor.job.ts`.

- [ ] **Step 3: Arrancar y detener en `server.ts`**

Importar el singleton; iniciar junto a jobs DB y detener en shutdown. No usar `setInterval` ad hoc.

- [ ] **Step 4: Correr tests**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --runInBand tests/unit/jobs/display-mode-request-expiry.job.test.ts tests/unit/jobs/job-schedule-hardening.test.ts
```

Esperado: PASS; el horario no colisiona con otro job declarado.

- [ ] **Step 5: Commit autorizado**

```bash
cd avoqado-server && git commit -- src/jobs/display-mode-request-expiry.job.ts src/jobs/jobSchedules.ts src/server.ts tests/unit/jobs/display-mode-request-expiry.job.test.ts tests/unit/jobs/job-schedule-hardening.test.ts -m "feat: expire stale display mode requests"
```

### Task 7: Proyectar capacidades en todas las lecturas

**Files:**

- Modify: `avoqado-server/src/services/dashboard/tpv.dashboard.service.ts`
- Modify: `avoqado-server/src/services/organization-dashboard/orgTerminals.service.ts`
- Modify: `avoqado-server/src/mcp/tools/terminals.ts`
- Modify: `avoqado-server/tests/unit/services/organization-dashboard/orgTerminals.service.test.ts`
- Create: `avoqado-server/tests/unit/services/dashboard/tpvCapabilitiesProjection.test.ts`
- Create: `avoqado-server/tests/unit/mcp/terminals.capabilities.test.ts`

- [ ] **Step 1: Escribir tests rojos de paridad de proyección**

La misma fila Terminal y el mismo contexto de permiso deben producir el mismo `capabilities` en:

- `GET /dashboard/venues/:venueId/tpvs`;
- detalle `GET /dashboard/venues/:venueId/tpv/:id`;
- vista organización;
- MCP `list_devices`.

Incluir `customerDisplayRequest`, `customerDisplayRequestVersion` y estado físico, pero no exponer `deviceUid` fuera de los DTO que ya lo
autorizan.

- [ ] **Step 2: Crear un mapper compartido**

En `device-capabilities.service.ts`, añadir `toDeviceManagementDto(terminal, context)` y hacer que llame una sola vez al resolver. Ninguna
vista reimplementa `type === 'POS_ANDROID'`.

- [ ] **Step 3: Corregir métricas/filtros de activación**

`activated`/`notActivated` sólo clasifican filas con `capabilities.requiresActivation=true`. Los POS no activables aparecen como “No
requiere activación”, no como pendientes.

- [ ] **Step 4: Correr tests**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --runInBand tests/unit/services/dashboard/tpvCapabilitiesProjection.test.ts tests/unit/services/organization-dashboard/orgTerminals.service.test.ts tests/unit/mcp/terminals.capabilities.test.ts
```

Esperado: PASS y snapshots iguales en las cuatro superficies.

- [ ] **Step 5: Commit autorizado**

```bash
cd avoqado-server && git commit -- src/services/device-capabilities.service.ts src/services/dashboard/tpv.dashboard.service.ts src/services/organization-dashboard/orgTerminals.service.ts src/mcp/tools/terminals.ts tests/unit/services/dashboard/tpvCapabilitiesProjection.test.ts tests/unit/services/organization-dashboard/orgTerminals.service.test.ts tests/unit/mcp/terminals.capabilities.test.ts -m "feat: expose effective capabilities on devices"
```

### Task 8: Separar liveness TPV del lifecycle POS y remediar datos

**Files:**

- Modify: `avoqado-server/src/services/tpv/tpv-health.service.ts`
- Create: `avoqado-server/tests/unit/services/tpv/tpv-health.pos-liveness.test.ts`
- Create: `avoqado-server/scripts/remediate-pos-terminal-status.ts`
- Create: `avoqado-server/tests/unit/scripts/remediatePosTerminalStatus.test.ts`

- [ ] **Step 1: Escribir test rojo del monitor de salud**

Una fila `POS_ANDROID|POS_IOS|POS_DESKTOP`, `ACTIVE`, `activatedAt=null`, heartbeat viejo permanece `ACTIVE`. Una `TPV_ANDROID` equivalente
sí pasa a `INACTIVE`. Agregar regresiones que demuestren que KDS y `PRINTER_*` conservan exactamente el resultado previo del job.
`MAINTENANCE` y `RETIRED` nunca se tocan.

- [ ] **Step 2: Restringir el `updateMany` existente**

Agregar `type: {notIn:['POS_ANDROID','POS_IOS','POS_DESKTOP']}` al filtro de `checkOfflineTerminals`; no crear otro concepto de status ni
alterar silenciosamente KDS/periféricos existentes. Conexión online/offline en DTO se sigue derivando de heartbeat, separada de
`Terminal.status` para POS.

- [ ] **Step 3: Escribir el test rojo del plan de remediación**

El selector exacto es:

```typescript
{
  selfRegistered: true,
  type: { in: ['POS_ANDROID', 'POS_IOS', 'POS_DESKTOP'] },
  activatedAt: null,
  status: 'INACTIVE',
}
```

Debe excluir TPV, `ACTIVE`, `MAINTENANCE`, `RETIRED` y provisionadas. Dry-run imprime conteo e IDs; `--apply` cambia a `ACTIVE` y escribe
`ActivityLog` por fila.

- [ ] **Step 4: Implementar runner re-ejecutable**

Sin flags no escribe. Con `--apply`, transacción por lote pequeño, vuelve a validar el where en cada update y reporta
`selected/updated/skipped`. Segunda aplicación actualiza cero.

- [ ] **Step 5: Correr tests y dry-run local**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --runInBand tests/unit/services/tpv/tpv-health.pos-liveness.test.ts tests/unit/scripts/remediatePosTerminalStatus.test.ts
./scripts/avq-verify.sh avoqado-server npx ts-node scripts/remediate-pos-terminal-status.ts
```

Esperado: tests PASS; dry-run no escribe y muestra sólo POS auto-registrados inactivos.

- [ ] **Step 6: Commit autorizado**

```bash
cd avoqado-server && git commit -- src/services/tpv/tpv-health.service.ts scripts/remediate-pos-terminal-status.ts tests/unit/services/tpv/tpv-health.pos-liveness.test.ts tests/unit/scripts/remediatePosTerminalStatus.test.ts -m "fix: separate pos lifecycle from tpv liveness"
```

### Task 9: Rechazar comandos y selección MCP incompatibles sin tocar el camino crítico de pago

**Files:**

- Modify: `avoqado-server/src/services/tpv/command-queue.service.ts`
- Modify: `avoqado-server/src/mcp/tools/terminals.ts`
- Create: `avoqado-server/tests/unit/services/tpv/command-queue.capabilities.test.ts`
- Modify: `avoqado-server/tests/unit/mcp/terminals.capabilities.test.ts`

- [ ] **Step 1: Escribir tests rojos del command queue**

`queueCommand` selecciona `type` y llama al resolver. Un POS rechaza cualquier `TpvCommandType` con 422 `COMMAND_NOT_SUPPORTED`; una TPV
Android acepta el allowlist; los tres comandos de automatización se rechazan como no ejecutables. Confirmar que sólo existe el
`tpvCommandQueue.create` actual.

- [ ] **Step 2: Escribir tests rojos del caller MCP de pago/refund**

Antes de mostrar/pedir `confirm:true`, `refund_card_on_terminal` y cualquier selector equivalente resuelven la fila dentro del venue por
`id` o por serial normalizado y exigen `canAcceptTerminalPaymentRequests=true`. POS, KDS, printer, TPV de otro venue y registro ausente
fallan. TPV Android conserva los casos actuales.

No modificar `sendPaymentToTerminal` ni `requestRefundOnTerminal`: reciben la identidad del `terminalRegistry` —que puede ser serial y no
`Terminal.id`— y ya validan conexión/socket y venue. Añadir Prisma ahí sería latencia y una semántica de identidad incorrecta en cobros.

- [ ] **Step 3: Implementar un guard compartido, no pipelines paralelos**

Añadir `assertDeviceActionSupported(terminal, action)` al servicio de capacidades. Usarlo en `command-queue.service.ts` y en el caller MCP
después de resolver el dispositivo; el servicio bajo nivel de pago queda registry-authoritative y sin nueva lectura DB. MCP
`refund_card_on_terminal` devuelve el mismo código/mensaje antes de pedir `confirm:true` si el aparato no es compatible.

- [ ] **Step 4: Ejecutar pruebas**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --runInBand tests/unit/services/tpv/command-queue.capabilities.test.ts tests/unit/mcp/terminals.capabilities.test.ts
```

Esperado: PASS. Como regresión de despliegue, Task 10 corre el módulo TPV completo y confirma que pagos/refunds conservan el resultado
previo sin cambios de implementación.

- [ ] **Step 5: Commit autorizado**

```bash
cd avoqado-server && git commit -- src/services/device-capabilities.service.ts src/services/tpv/command-queue.service.ts src/mcp/tools/terminals.ts tests/unit/services/tpv/command-queue.capabilities.test.ts tests/unit/mcp/terminals.capabilities.test.ts -m "fix: enforce device capabilities on remote actions"
```

### Task 10: Verificar y desplegar el servidor aditivo

- [ ] **Step 1: Whitespace y lint sin reescribir WIP ajeno**

```bash
git -C avoqado-server diff --check
./scripts/avq-verify.sh avoqado-server npm run lint
```

Revisar `git -C avoqado-server diff -- prisma src tests scripts docs` después: no corregir ruido en archivos ajenos.

- [ ] **Step 2: Suite unitaria del módulo y typecheck**

```bash
./scripts/avq-verify.sh avoqado-server npm run test:tpv
./scripts/avq-verify.sh avoqado-server npm run test:unit
./scripts/avq-verify.sh avoqado-server npm run typecheck:build
```

Esperado: ambos PASS. `DIFIEREN`/`INCONCLUSO` no cuenta como éxito.

- [ ] **Step 3: Pre-deploy de migración en local**

```bash
./scripts/avq-verify.sh avoqado-server npm run pre-deploy
```

Esperado: migración forward compatible; el servidor antiguo tolera las columnas nuevas y el nuevo tolera clientes antiguos.

- [ ] **Step 4: Deploy servidor antes que Android/dashboard**

Comprobar por API:

- login POS viejo sigue exitoso;
- GET settings viejo sigue respondiendo;
- PATCH viejo `{customerDisplayInverted}` sigue 200;
- PUT capabilities nuevo responde 200;
- dashboard viejo sigue operando `/tpv`.

Rollback de esta fase: revertir sólo código del servidor; dejar columnas aditivas. No hacer rollback destructivo de migración.

- [ ] **Step 5: Aplicar la remediación POS después de confirmar el deploy**

```bash
./scripts/avq-verify.sh avoqado-server npx ts-node scripts/remediate-pos-terminal-status.ts --apply
```

Antes y después guardar conteos. Si aparece una fila fuera del selector exacto, abortar sin ampliar la heurística. Volver a correr sin
`--apply`: el conteo seleccionable debe ser cero.

---

## Phase B — Android capability producer and intent consumer

### Task 11: Modelar snapshot, request y journal de forma pura

**Files:**

- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/customerdisplay/DisplayCapabilitySnapshot.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeRequest.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeRequestStore.kt`
- Create: `avoqado-android/app/src/test/java/com/avoqado/pos/customerdisplay/DisplayCapabilitySnapshotTest.kt`
- Create: `avoqado-android/app/src/test/java/com/avoqado/pos/customerdisplay/DisplayModeRequestStateTest.kt`

**Interfaces:**

```kotlin
data class DisplayCapabilitySnapshot(val present: Boolean, val invertible: Boolean)

data class RemoteDisplayModeRequest(
    val requestId: String,
    val desiredInverted: Boolean,
    val status: String,
    val expiresAt: Instant,
)

interface DisplayModeRequestJournal {
    fun load(venueId: String, deviceId: String): JournalEntry?
    fun save(entry: JournalEntry)
    fun clear(venueId: String, deviceId: String, requestId: String)
}
```

Cada `JournalEntry` conserva también el `terminalId` entregado por el GET junto con el request; nunca intenta obtenerlo desde
`TpvSettingsRepository`.

- [ ] **Step 1: Escribir tests rojos del hardware**

Usar `resolveDisplayRoles` existente:

- Sunmi D3: `present=true`, `invertible=true`;
- Sunmi T3 Pro OEM virtual: `present=true`, `invertible=false`;
- teléfono/tablet sin segunda pantalla: `false/false`;
- display de AnyDesk/capture: `false/false`.

- [ ] **Step 2: Escribir tests rojos de decisión**

`decideRemoteIntent` debe devolver `IGNORE_EXPIRED`, `IGNORE_ALREADY_ACKED`, `ACK_JOURNALED_APPLY`, `APPLY_AND_ACK`, `REJECT_UNSUPPORTED` o
`REJECT_LOCAL_OVERRIDE`. La key incluye venue y device para que cambio de local/reinstalación no mezcle requests.

- [ ] **Step 3: Implementar funciones puras y store SharedPreferences**

Persistir JSON con `terminalId`, `requestId`, `desiredInverted`, `appliedLocally`, `ackPending`, `localGenerationAtJournal`, timestamps y
scope. Escribir primero y aplicar después. No reutilizar el flag `dirty` como journal: representa otra autoridad. `DisplayModePrefs`
incrementa una generación monotónica persistida sólo en cambios locales; compararla dentro de la sección sincronizada permite producir
`LOCAL_OVERRIDE` sin comparar relojes server/device.

- [ ] **Step 4: Correr tests**

```bash
./scripts/avq-verify.sh avoqado-android ./gradlew testDebugUnitTest --tests 'com.avoqado.pos.customerdisplay.DisplayCapabilitySnapshotTest' --tests 'com.avoqado.pos.customerdisplay.DisplayModeRequestStateTest'
```

Esperado: PASS.

- [ ] **Step 5: Commit autorizado**

```bash
cd avoqado-android && git commit -- app/src/main/java/com/avoqado/pos/customerdisplay/DisplayCapabilitySnapshot.kt app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeRequest.kt app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeRequestStore.kt app/src/test/java/com/avoqado/pos/customerdisplay/DisplayCapabilitySnapshotTest.kt app/src/test/java/com/avoqado/pos/customerdisplay/DisplayModeRequestStateTest.kt -m "feat: model customer display intents"
```

### Task 12: Implementar el cliente HTTP exacto

**Files:**

- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeRemoteRepository.kt`
- Create: `avoqado-android/app/src/test/java/com/avoqado/pos/customerdisplay/DisplayModeRemoteRepositoryTest.kt`

- [ ] **Step 1: Escribir tests MockWebServer rojos**

Verificar método/path/body y que `DeviceHeadersInterceptor` agrega `X-Device-ID`/`X-Device-Platform` para:

- capability PUT;
- request GET;
- ACK PATCH APPLIED;
- ACK PATCH REJECTED con result code;
- 200 `{data:{terminalId,request:null}}`;
- 401, 409, 422 y 5xx tipados sin lanzar fuera del repositorio.

- [ ] **Step 2: Implementar repositorio no bloqueante**

Usar el `OkHttpClient` inyectado y `kotlinx.serialization` con `ignoreUnknownKeys=true`. `Success` conserva juntos `terminalId` y request;
`request:null` produce `NoRequest(terminalId)` sin perder el binding. Métodos `suspend` devuelven sealed outcomes (`Success`, `NoRequest`,
`Retryable`, `Rejected`, `SessionInvalid`) en vez de excepciones crudas.

- [ ] **Step 3: Correr test HTTP**

```bash
./scripts/avq-verify.sh avoqado-android ./gradlew testDebugUnitTest --tests 'com.avoqado.pos.customerdisplay.DisplayModeRemoteRepositoryTest'
```

Esperado: PASS y cuerpos idénticos al contrato del servidor.

- [ ] **Step 4: Commit autorizado**

```bash
cd avoqado-android && git commit -- app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeRemoteRepository.kt app/src/test/java/com/avoqado/pos/customerdisplay/DisplayModeRemoteRepositoryTest.kt -m "feat: sync customer display capabilities"
```

### Task 13: Coordinar polling por lifecycle del proceso

**Files:**

- Modify: `avoqado-android/gradle/libs.versions.toml`
- Modify: `avoqado-android/app/build.gradle.kts`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/customerdisplay/DeviceCapabilitySyncCoordinator.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/customerdisplay/CustomerDisplayState.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/customerdisplay/CustomerDisplayManager.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/auth/presentation/AppState.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/AvoqadoApp.kt`
- Create: `avoqado-android/app/src/test/java/com/avoqado/pos/customerdisplay/DeviceCapabilitySyncCoordinatorTest.kt`

- [ ] **Step 1: Escribir tests rojos del scheduler**

Con reloj, random y delay inyectables:

- arranca inmediatamente al foreground si hay sesión/venue;
- repite cada 15 s con jitter acotado;
- dispara al login, cambio de venue, `onResume` del proceso y recuperación de red;
- no hay dos polls concurrentes;
- background/logout cancela;
- red caída usa backoff y no bloquea;
- reporta snapshot al menos cada 24 h aunque no cambie;
- p95 simulado desde request disponible hasta inicio de apply es <=20 s.

- [ ] **Step 2: Extender `CustomerDisplayState` como fuente observable única**

Agregar a `CustomerDisplayState` presencia e invertibilidad y un snapshot combinado nullable. En el punto donde
`CustomerDisplayManager.refresh()` ya calcula `roles`, actualizar esa misma fuente:

```kotlin
customerDisplayState.updateCapabilities(DisplayCapabilitySnapshot(
    present = roles.customerDisplayId != null,
    invertible = roles.invertible,
))
```

No crear un segundo `MutableStateFlow` en el manager ni volver a enumerar displays en el coordinator. Mientras el snapshot siga en `null`,
no reportar `false/false`: aún no hubo observación de hardware.

- [ ] **Step 3: Añadir lifecycle-process**

```toml
lifecycle-process = { group = "androidx.lifecycle", name = "lifecycle-process", version.ref = "lifecycleRuntime" }
```

```kotlin
implementation(libs.lifecycle.process)
```

- [ ] **Step 4: Implementar coordinator singleton**

`DeviceCapabilitySyncCoordinator` implementa `DefaultLifecycleObserver`. `AvoqadoApp.onCreate()` lo registra en `ProcessLifecycleOwner`.
`AppState.onLoginSuccess`, logout exitoso y `refreshTabs`/switch de venue llaman `onSessionChanged()`; el callback sólo despierta el loop,
nunca espera red.

No arrancar/parar desde `MainActivity.onStart/onStop`: el display relocation actual puede producir ese ciclo y duplicar jobs.

- [ ] **Step 5: Correr tests**

```bash
./scripts/avq-verify.sh avoqado-android ./gradlew testDebugUnitTest --tests 'com.avoqado.pos.customerdisplay.DeviceCapabilitySyncCoordinatorTest'
```

Esperado: PASS sin delays reales.

- [ ] **Step 6: Commit autorizado**

```bash
cd avoqado-android && git commit -- gradle/libs.versions.toml app/build.gradle.kts app/src/main/java/com/avoqado/pos/customerdisplay/DeviceCapabilitySyncCoordinator.kt app/src/main/java/com/avoqado/pos/customerdisplay/CustomerDisplayState.kt app/src/main/java/com/avoqado/pos/customerdisplay/CustomerDisplayManager.kt app/src/main/java/com/avoqado/pos/auth/presentation/AppState.kt app/src/main/java/com/avoqado/pos/AvoqadoApp.kt app/src/test/java/com/avoqado/pos/customerdisplay/DeviceCapabilitySyncCoordinatorTest.kt -m "feat: poll device intents in foreground"
```

### Task 14: Aplicar intención por valor y drenar ACKs en orden

**Files:**

- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModePrefs.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeSync.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/customerdisplay/DeviceCapabilitySyncCoordinator.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/tpvsettings/data/TpvSettingsRepository.kt`
- Modify: `avoqado-android/app/src/test/java/com/avoqado/pos/customerdisplay/DisplayModeSyncTest.kt`
- Modify: `avoqado-android/app/src/test/java/com/avoqado/pos/customerdisplay/DeviceCapabilitySyncCoordinatorTest.kt`
- Create: `avoqado-android/app/src/test/java/com/avoqado/pos/tpvsettings/data/TpvSettingsDisplayModeAuthorityTest.kt`

- [ ] **Step 1: Reemplazar el test obsoleto de “server nunca manda”**

Conservar los casos locales históricos, pero añadir:

- sin request: local dirty se empuja; local limpio puede adoptar confirmación legacy;
- con request: persistir `desiredInverted`, aplicar ese valor exacto, observar roles, ACK;
- settings legacy: omitir reconcile mientras exista journal/in-flight, sin llamar al coordinator ni parsear requests;
- misma request repetida no hace toggle ni segunda aplicación;
- A aplicada sin ACK se drena antes de B;
- ACK de A después de B no limpia B;
- request expirada no se aplica;
- incapacidad física responde REJECTED `DISPLAY_NOT_INVERTIBLE`;
- dirty local anterior al journal queda superado por la request nueva;
- cambio local posterior al journal conserva dirty, no aplica/limpia el deseo silenciosamente y responde `REJECTED/LOCAL_OVERRIDE` con el
  snapshot físico actual.

- [ ] **Step 2: Añadir API de persistencia remota**

`DisplayModePrefs.applyRemoteIntent(value, localGenerationAtJournal)` es `@Synchronized`: compara primero la generación actual; si avanzó,
devuelve `LOCAL_OVERRIDE` y conserva valor/dirty. Si coincide, escribe el booleano antes de notificar el StateFlow y deja `dirty=false`. La
aplicación remota no incrementa la generación local ni llama al endpoint legacy.

`TpvSettingsRepository` depende sólo del journal/store y consulta `journal.hasInFlight(venueId, deviceId)` antes de ejecutar
`reconcileDisplayMode`. No depende del coordinator ni el coordinator depende de settings: el GET ligero entrega `{terminalId, request}` y es
el único bootstrap/control path. Así se evita un ciclo Hilt y un refresh de settings no adopta el estado físico anterior entre apply y ACK.

- [ ] **Step 3: Implementar orden journal → apply → ACK → clear**

En cada tick:

1. si existe `ackPending`, enviarlo y no aplicar request siguiente hasta confirmación;
2. obtener request corriente;
3. validar expiry y capacidad;
4. guardar journal;
5. si hubo cambio local posterior al journal, guardar ACK `REJECTED/LOCAL_OVERRIDE`; en otro caso aplicar **valor deseado**, nunca
   `!current`;
6. verificar snapshot final;
7. guardar ACK pendiente;
8. enviar ACK; limpiar sólo si coincide requestId.

- [ ] **Step 4: Correr regresión customer display**

```bash
./scripts/avq-verify.sh avoqado-android ./gradlew testDebugUnitTest --tests 'com.avoqado.pos.customerdisplay.*' --tests 'com.avoqado.pos.tpvsettings.data.TpvSettingsDisplayModeAuthorityTest'
```

Esperado: PASS, incluidos `DisplayRolesTest` existentes.

- [ ] **Step 5: Commit autorizado**

```bash
cd avoqado-android && git commit -- app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModePrefs.kt app/src/main/java/com/avoqado/pos/customerdisplay/DisplayModeSync.kt app/src/main/java/com/avoqado/pos/customerdisplay/DeviceCapabilitySyncCoordinator.kt app/src/main/java/com/avoqado/pos/tpvsettings/data/TpvSettingsRepository.kt app/src/test/java/com/avoqado/pos/customerdisplay/DisplayModeSyncTest.kt app/src/test/java/com/avoqado/pos/customerdisplay/DeviceCapabilitySyncCoordinatorTest.kt app/src/test/java/com/avoqado/pos/tpvsettings/data/TpvSettingsDisplayModeAuthorityTest.kt -m "feat: apply durable display mode intents"
```

### Task 15: Verificar Android y los cuatro escenarios offline en hardware

- [ ] **Step 1: Compilar Android**

```bash
./scripts/avq-verify.sh avoqado-android ./gradlew testDebugUnitTest
./scripts/avq-verify.sh avoqado-android ./gradlew assembleDebug
```

Esperado: tests y build exitosos. Si falla por WIP ajeno, identificarlo con `git -C avoqado-android diff --name-only`, reportarlo y no
tocarlo.

- [ ] **Step 2: Instalar el build en Sunmi D3 y T3 Pro**

```bash
adb -s D406D598J0068 install -r avoqado-android/app/build/outputs/apk/debug/app-debug.apk
adb -s T302P3AP40102 install -r avoqado-android/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 3: Verificar matriz física**

En D3 confirmar `present=true/invertible=true` y que una intención cambia roles. En T3 Pro confirmar `present=true/invertible=false` y que
el dashboard/server rechaza inversión. En teléfono/tablet confirmar `false/false`. AnyDesk no puede contar como display de cliente.

- [ ] **Step 4: Responder las cuatro preguntas offline**

1. **¿Qué puede hacer sin red?** vender y usar el valor de pantalla ya persistido; no recibe intents nuevos.
2. **¿Qué se encola?** sólo ACK de una intención ya aplicada, scopeado por venue/device/request.
3. **¿Qué ocurre al reconectar?** drena ACK viejo antes de leer/aplicar el siguiente request y vuelve a reportar capacidades.
4. **¿Qué pasa en conflicto?** el request corriente del server manda; ACK viejo actualiza físico sin sobrescribir el request nuevo, y el
   Android aplica después el valor nuevo.

Probar: cortar red después de guardar journal y antes del ACK; reiniciar app; reconectar; confirmar un solo ACK y estado final correcto.

- [ ] **Step 5: Gate de salida de fase**

No desplegar dashboard hasta que ambos aparatos pasen y 100 intentos de foreground automatizados/debidamente registrados cumplan p95 <=20 s
desde 202 a inicio de apply. Capturar también GET por dispositivo, errores y ACK para validar el costo del poll. Si Android falla, retirar
sólo ese release; el servidor aditivo permanece compatible.

---

## Phase C — Dashboard uses capabilities

### Task 16: Tipar DTOs y encapsular la nueva API

**Files:**

- Modify: `avoqado-web-dashboard/src/services/tpv.service.ts`
- Create: `avoqado-web-dashboard/src/pages/Tpv/deviceCapabilities.ts`
- Create: `avoqado-web-dashboard/src/pages/Tpv/__tests__/deviceCapabilities.test.ts`

- [ ] **Step 1: Escribir tests rojos de helpers**

Cubrir `canActivate`, `canConfigurePayments`, `canSendCommand`, `canRequestDisplayInversion` y labels de `SUPPORTED/UNSUPPORTED/UNKNOWN`.
Los helpers reciben capacidades del server; no deducen por marca/modelo/`activatedAt`.

- [ ] **Step 2: Añadir tipos al service**

```typescript
export interface EffectiveDeviceCapabilities {
  requiresActivation: boolean
  canManagePaymentConfiguration: boolean
  canAcceptTerminalPaymentRequests: boolean
  customerDisplay: {
    presence: 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN'
    invertibility: 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN'
    canRequestInversion: boolean
    observedAt: string | null
    stale: boolean
  }
  supportedRemoteCommands: TpvCommandType[]
}
```

Añadir `DisplayModeRequest` y métodos:

```typescript
createDisplayModeRequest(venueId, terminalId, desiredInverted)
cancelDisplayModeRequest(venueId, terminalId, requestId)
```

No cambiar URLs de `getTpvs`, `getTpvById`, comandos o activación.

- [ ] **Step 3: Correr test**

```bash
./scripts/avq-verify.sh avoqado-web-dashboard npm run test:run -- src/pages/Tpv/__tests__/deviceCapabilities.test.ts
```

Esperado: PASS.

- [ ] **Step 4: Commit autorizado**

```bash
cd avoqado-web-dashboard && git commit -- src/services/tpv.service.ts src/pages/Tpv/deviceCapabilities.ts src/pages/Tpv/__tests__/deviceCapabilities.test.ts -m "feat: consume effective device capabilities"
```

### Task 17: Hacer `/devices` canónico sin romper `/tpv`

**Files:**

- Modify: `avoqado-web-dashboard/src/routes/LegacyRedirect.tsx`
- Modify: `avoqado-web-dashboard/src/routes/venueRoutes.tsx`
- Create: `avoqado-web-dashboard/src/routes/__tests__/DeviceRoutes.test.tsx`
- Modify: `avoqado-web-dashboard/src/components/Sidebar/app-sidebar.tsx`
- Modify: `avoqado-web-dashboard/src/components/onboarding/HomeSetupChecklist.tsx`
- Modify: `avoqado-web-dashboard/src/components/PaymentSetupWizardDialog.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Home.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Tpv/TpvId.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Tpv/components/TerminalOrdersTab.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Tpv/components/purchase-wizard/TerminalPurchaseWizard.tsx`

- [ ] **Step 1: Escribir tests rojos de rutas**

Comprobar:

- `/devices`, `/devices/orders/:id`, `/devices/:tpvId` renderizan páginas actuales;
- `/tpv`, `/tpv/orders/:id`, `/tpv/:tpvId` redirigen con `replace`;
- query y hash sobreviven (`?page=2#commands`);
- `orders/:id` gana antes que `:tpvId`;
- `fullBasePath` conserva venue slug/white-label;
- `/devices*` y `/tpv*` permanecen dentro de los mismos guards actuales: sin `tpv:read` no renderizan y con KYC bloqueado no existe bypass
  por la ruta nueva;
- un redirect legacy no relacionado conserva su comportamiento previo (regresión del helper compartido).

- [ ] **Step 2: Extender el `LegacyRedirect` existente**

```tsx
<LegacyRedirect
  to={({ fullBasePath, params }) => {
    const suffix = params.id ? `orders/${params.id}` : (params.tpvId ?? '')
    return `${fullBasePath}/devices${suffix ? `/${suffix}` : ''}`
  }}
  preserveSearchAndHash
/>
```

Mantener compatible el prop estático actual del componente; el callback es aditivo. No duplicar lógica en un `DeviceLegacyRedirect` nuevo.

- [ ] **Step 3: Registrar primero rutas canónicas y luego aliases**

Mantener el param interno `:tpvId` para no forzar rename en `TpvId.tsx`. La URL visible ya usa el ID de dispositivo. Declarar canónicas y
aliases dentro del mismo `PermissionProtectedRoute permission="tpv:read"` y `KYCProtectedRoute` existente.

- [ ] **Step 4: Cambiar enlaces internos a `/devices`**

Usar `rg -n "\/tpv"` en los archivos listados y cambiar sólo navegación de venue. No tocar rutas `/superadmin/tpv`, endpoints API ni nombres
de permisos.

- [ ] **Step 5: Correr tests**

```bash
./scripts/avq-verify.sh avoqado-web-dashboard npm run test:run -- src/routes/__tests__/DeviceRoutes.test.tsx
```

Esperado: PASS para URLs nuevas y antiguas.

- [ ] **Step 6: Commit autorizado**

```bash
cd avoqado-web-dashboard && git commit -- src/routes/LegacyRedirect.tsx src/routes/venueRoutes.tsx src/routes/__tests__/DeviceRoutes.test.tsx src/components/Sidebar/app-sidebar.tsx src/components/onboarding/HomeSetupChecklist.tsx src/components/PaymentSetupWizardDialog.tsx src/pages/Home.tsx src/pages/Tpv/TpvId.tsx src/pages/Tpv/components/TerminalOrdersTab.tsx src/pages/Tpv/components/purchase-wizard/TerminalPurchaseWizard.tsx -m "feat: make devices the canonical dashboard route"
```

### Task 18: Reemplazar el switch optimista por intención explícita

**Files:**

- Create: `avoqado-web-dashboard/src/pages/Tpv/components/DisplayModeRequestControl.tsx`
- Create: `avoqado-web-dashboard/src/pages/Tpv/components/__tests__/DisplayModeRequestControl.test.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Tpv/TpvId.tsx`
- Modify: `avoqado-web-dashboard/src/locales/es/tpv.json`
- Modify: `avoqado-web-dashboard/src/locales/en/tpv.json`
- Modify: `avoqado-web-dashboard/src/locales/fr/tpv.json`

- [ ] **Step 1: Escribir tests rojos del control**

Estados:

- invertibilidad unsupported: no renderizar acción;
- unknown/stale: deshabilitada con explicación “esperando reporte del dispositivo”;
- sin `tpv:update`: visible pero deshabilitada por permiso;
- APPLIED: muestra físico actual y botón para pedir opuesto;
- PENDING: muestra valor solicitado, hora/expiry, botón cancelar; no cambia badge físico;
- REJECTED/EXPIRED: mensaje y reintento;
- CANCEL_TOO_LATE: explica que ya se aplicó y ofrece mandar la intención contraria.

- [ ] **Step 2: Implementar mutaciones**

POST invalida queries de lista/detalle al recibir 202, pero no escribe `customerDisplayInverted` en cache. DELETE conserva la respuesta real
del servidor. Poll del detalle cada 5 s sólo mientras status sea PENDING; detener al resolver.

- [ ] **Step 3: Quitar el `api.put` inline de `customerDisplayInverted`**

Eliminar el switch actual de `TpvId.tsx` y su llamada inline a `api.put` para esa propiedad. Las mutaciones generales de nombre/status
permanecen sin cambio.

- [ ] **Step 4: Correr tests e i18n**

```bash
./scripts/avq-verify.sh avoqado-web-dashboard npm run test:run -- src/pages/Tpv/components/__tests__/DisplayModeRequestControl.test.tsx
./scripts/avq-verify.sh avoqado-web-dashboard npm run lint:i18n
```

Esperado: PASS y las tres locales con las mismas keys.

- [ ] **Step 5: Commit autorizado**

```bash
cd avoqado-web-dashboard && git commit -- src/pages/Tpv/components/DisplayModeRequestControl.tsx src/pages/Tpv/components/__tests__/DisplayModeRequestControl.test.tsx src/pages/Tpv/TpvId.tsx src/locales/es/tpv.json src/locales/en/tpv.json src/locales/fr/tpv.json -m "feat: manage display mode with durable intents"
```

### Task 19: Aplicar capacidades a lista, comandos y drawer de organización

**Files:**

- Modify: `avoqado-web-dashboard/src/pages/Tpv/Tpvs.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Tpv/components/RemoteCommandPanel.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Organization/components/OrgTerminalDrawer.tsx`
- Create: `avoqado-web-dashboard/src/pages/Tpv/components/__tests__/DeviceActions.test.tsx`
- Modify: `avoqado-web-dashboard/src/locales/es/sidebar.json`
- Modify: `avoqado-web-dashboard/src/locales/en/sidebar.json`
- Modify: `avoqado-web-dashboard/src/locales/fr/sidebar.json`

- [ ] **Step 1: Escribir tests rojos de acciones por aparato**

Fixture TPV Android: activación/configuración/comandos según allowlist, sin doble pantalla. Fixture D3: sin activación/config
pagos/comandos, con inversión. Fixture T3 Pro: sin inversión. Fixture phone POS: ninguna acción especial. Verificar exactamente la misma
salida en detalle y `OrgTerminalDrawer`.

- [ ] **Step 2: Corregir lifecycle visual**

Reemplazar checks `!activatedAt` por `capabilities.requiresActivation && !activatedAt`. Para POS mostrar origen auto-registrado y conexión
derivada de heartbeat, sin CTA de activación ni estado “pendiente”.

- [ ] **Step 3: Filtrar comandos por allowlist**

`RemoteCommandPanel` recibe `supportedRemoteCommands`; si queda vacío no renderiza panel/historial operativo. No mantener botones
reiniciar/sync/lock incondicionales en `OrgTerminalDrawer`.

- [ ] **Step 4: Cambiar copy principal a “Dispositivos”**

Sidebar, título, breadcrumbs, empty states y filtros hablan de dispositivos. Se permite “TPV” en labels específicos de hardware/capacidad y
en historial técnico.

- [ ] **Step 5: Correr tests**

```bash
./scripts/avq-verify.sh avoqado-web-dashboard npm run test:run -- src/pages/Tpv/components/__tests__/DeviceActions.test.tsx
./scripts/avq-verify.sh avoqado-web-dashboard npm run lint:i18n
```

Esperado: PASS.

- [ ] **Step 6: Commit autorizado**

```bash
cd avoqado-web-dashboard && git commit -- src/pages/Tpv/Tpvs.tsx src/pages/Tpv/components/RemoteCommandPanel.tsx src/pages/Organization/components/OrgTerminalDrawer.tsx src/pages/Tpv/components/__tests__/DeviceActions.test.tsx src/locales/es/sidebar.json src/locales/en/sidebar.json src/locales/fr/sidebar.json -m "feat: tailor device actions by capability"
```

### Task 20: Verificar y desplegar dashboard

- [ ] **Step 1: Lint, tests enfocados y typecheck/build**

```bash
./scripts/avq-verify.sh avoqado-web-dashboard npm run lint
./scripts/avq-verify.sh avoqado-web-dashboard npm run test:run
./scripts/avq-verify.sh avoqado-web-dashboard npm run build
```

Esperado: PASS. El build incluye `tsc -b`.

- [ ] **Step 2: QA manual con cuatro fixtures reales**

Abrir lista y detalle para TPV Android, D3, T3 Pro y phone/tablet. Probar usuario con y sin `tpv:update`. Navegar también cada `/tpv` viejo
con query/hash y confirmar redirect.

- [ ] **Step 3: Deploy dashboard**

Gate: servidor y Android nuevo ya están desplegados, D3 pasó hardware QA. Si dashboard falla, rollback sólo de assets web; `/tpv` y
endpoints viejos siguen vivos.

---

## Phase D — Observation and legacy cutoff

### Task 21: Observar siete días antes de cerrar el `PUT` legado

**Files:**

- Modify: `avoqado-server/src/controllers/dashboard/tpv.dashboard.controller.ts`
- Modify: `avoqado-server/src/schemas/dashboard/tpv.schema.ts`
- Create or Modify: `avoqado-server/tests/unit/controllers/dashboard/tpv.dashboard.controller.test.ts`
- Create: `avoqado-server/scripts/report-display-mode-rollout.ts`
- Create: `avoqado-server/tests/unit/scripts/reportDisplayModeRollout.test.ts`

- [ ] **Step 1: Crear un reporte reproducible sobre la instrumentación ya desplegada**

La instrumentación legacy ya salió en Task 5. Implementar un script read-only con `--from`/`--to` (default: últimos 7 días) que combine
`Terminal` y `ActivityLog` y produzca JSON + resumen humano con:

- POS Android activos, cobertura fresca y porcentaje con `displayModeProtocolVersion===1`;
- conteos `DISPLAY_MODE_REQUESTED`, `DISPLAY_MODE_RESOLVED` por status/resultCode y tasa de ACK;
- latencia `latencyMs` p50/p95 de resoluciones;
- `DISPLAY_MODE_EXPIRED` por día y si la tendencia crece;
- `LEGACY_DISPLAY_MODE_UPDATE_USED` por versión/user-agent sanitizado.

El unit test usa fixtures de ActivityLog y comprueba denominadores vacíos, p95, expirados y cero legacy. El script no escribe ni imprime
deviceUid, staff, nombre de venue u otra PII.

- [ ] **Step 2: Esperar una ventana completa de 7 días**

Gate objetivo:

- cero llamadas legacy de dashboard soportado durante 7 días;
- > =95% de POS Android activos reportaron `displayModeProtocolVersion===1` en los últimos 7 días;
- tasa de ACK APPLIED/REJECTED y latencia p95 visibles;
- no hay crecimiento sostenido de PENDING expirados.

Si no se cumple, mantener compatibilidad; no forzar cutoff.

Ejecutar y guardar el JSON como evidencia del release:

```bash
./scripts/avq-verify.sh avoqado-server npx ts-node scripts/report-display-mode-rollout.ts --from <ISO-7-dias> --to <ISO-ahora>
```

- [ ] **Step 3: Escribir test rojo del rechazo explícito**

Después del gate, body con `customerDisplayInverted` en el PUT genérico responde 422:

```json
{
  "code": "LEGACY_DISPLAY_MODE_ENDPOINT",
  "message": "Usa la solicitud de modo de pantalla del dispositivo."
}
```

Nombre/status siguen funcionando. Nunca devolver 200 no-op.

- [ ] **Step 4: Retirar el campo del schema/update spread**

Eliminar `customerDisplayInverted` de `UpdateTpvBody`; detectar explícitamente su presencia antes de parsear/actualizar para dar el 422
estable. El PATCH móvil legacy permanece compatible para APKs viejas.

- [ ] **Step 5: Correr tests y desplegar**

```bash
./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --runInBand tests/unit/controllers/dashboard/tpv.dashboard.controller.test.ts tests/unit/controllers/dashboard/displayModeRequest.dashboard.controller.test.ts tests/unit/scripts/reportDisplayModeRollout.test.ts
./scripts/avq-verify.sh avoqado-server npm run typecheck:build
```

- [ ] **Step 6: Commit autorizado**

```bash
cd avoqado-server && git commit -- src/controllers/dashboard/tpv.dashboard.controller.ts src/schemas/dashboard/tpv.schema.ts scripts/report-display-mode-rollout.ts tests/unit/controllers/dashboard/tpv.dashboard.controller.test.ts tests/unit/scripts/reportDisplayModeRollout.test.ts -m "chore: reject legacy dashboard display updates"
```

### Task 22: Regresión cross-repo y cierre documental

**Files:**

- Modify if search finds an affected claim:
  `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-presentacion-v2.html`
- Modify if search finds an affected claim:
  `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-presentacion-v2-sin-nexgo.html`
- Modify if search finds an affected claim:
  `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-one-pager-v2.html`
- Modify if search finds an affected claim:
  `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-one-pager-cliente.html`
- Regenerate only if source HTML changed: the four corresponding PDF files listed below.
- Modify: `avoqado-server/docs/superpowers/specs/2026-08-29-dispositivos-unificados-capacidades-design.md` (implementation status only)
- Modify: `avoqado-server/docs/superpowers/plans/2026-08-29-dispositivos-unificados-capacidades.md` (checkboxes/evidence only)

- [ ] **Step 1: Confirmar que no hubo rename accidental de contratos**

```bash
rg -n "model Device|\/api\/v1\/dashboard\/.*\/devices" avoqado-server/prisma avoqado-server/src
```

Esperado: no `model Device`; sólo endpoints nuevos expresamente definidos, no duplicado general de `/tpv`.

- [ ] **Step 2: Regresión de `avoqado-tpv` sin cambios de producto**

```bash
./scripts/avq-verify.sh avoqado-tpv ./gradlew testDebugUnitTest --tests 'com.jaac.avoqado_tpv.features.remote_command.domain.CommandExecutorTest'
```

Esperado: PASS. No modificar TPV salvo que esta prueba descubra una incompatibilidad real; el allowlist del server ya refleja su executor.

- [ ] **Step 3: Regresión iOS sin implementar customer display**

```bash
./scripts/avq-verify.sh avoqado-ios xcodebuild -scheme avoqado-ios -destination 'platform=iOS Simulator,OS=18.5,name=iPhone 16 Pro' build
```

Esperado: `BUILD SUCCEEDED`. Confirmar manualmente login/venue switch y que el registro POS iOS sigue sin activación. No añadir
polling/display APIs a iOS en v1.

- [ ] **Step 4: Buscar y, sólo si aplica, actualizar los cuatro HTML comerciales**

```bash
rg -n "Terminales|TPV|Dispositivos" /Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-presentacion-v2.html /Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-presentacion-v2-sin-nexgo.html /Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-one-pager-v2.html /Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-one-pager-cliente.html
```

Si hay una afirmación afectada, cambiar la superficie administrativa a “Dispositivos” y explicar que cada aparato muestra sólo funciones
compatibles. No prometer reinicio, activación o doble pantalla universal. Mantener las omisiones intencionales del one-pager cliente y las
exclusiones de NexGo/procesadores de la variante PAX. Si no hay claim relevante, registrar “sin cambio comercial” y no tocar el repo.

- [ ] **Step 5: Regenerar los cuatro PDFs sólo cuando cambie su HTML**

```bash
cd /Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation
AVQ_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$AVQ_CHROME" --headless --disable-gpu --no-pdf-header-footer --run-all-compositor-stages-before-draw --virtual-time-budget=15000 --print-to-pdf="Avoqado-Presentacion-Plataforma-V2.pdf" "file://$PWD/avoqado-presentacion-v2.html"
"$AVQ_CHROME" --headless --disable-gpu --no-pdf-header-footer --run-all-compositor-stages-before-draw --virtual-time-budget=15000 --print-to-pdf="Avoqado-Presentacion-Plataforma-pax.pdf" "file://$PWD/avoqado-presentacion-v2-sin-nexgo.html"
"$AVQ_CHROME" --headless --disable-gpu --no-pdf-header-footer --run-all-compositor-stages-before-draw --virtual-time-budget=15000 --print-to-pdf="Avoqado-One-Pager-V2.pdf" "file://$PWD/avoqado-one-pager-v2.html"
"$AVQ_CHROME" --headless --disable-gpu --no-pdf-header-footer --run-all-compositor-stages-before-draw --virtual-time-budget=15000 --print-to-pdf="Avoqado-One-Pager-Cliente.pdf" "file://$PWD/avoqado-one-pager-cliente.html"
```

Ejecutar únicamente los comandos cuyos HTML cambiaron. Renderizar previews de las páginas afectadas y revisar que no haya texto cortado,
solapes ni promesas contradictorias. Si no cambió ningún HTML, omitir por completo regeneración y commit comercial.

- [ ] **Step 6: Auditoría final de seguridad/contratos**

Revisar específicamente: tenant scope, exact device binding, permiso `tpv:update`, CAS/audit atomicidad, JSON no confiable, job de expiry,
POS sin activación y MCP. Cualquier P0/P1 bloquea cierre.

- [ ] **Step 7: Registrar evidencia y estado**

Marcar en spec: fecha de deploy server, versión Android, dispositivos físicos probados, fecha dashboard y fecha cutoff legado. No marcar
“Implemented” hasta completar Phase D.

- [ ] **Step 8: Commits finales sólo si están autorizados**

```bash
# Ejecutar este commit sólo si Step 4 produjo cambios, limitando paths a cada HTML/PDF realmente modificado.
cd /Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation && git commit -- <rutas-realmente-modificadas> -m "docs: present unified device capabilities"
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server && git commit -- docs/superpowers/specs/2026-08-29-dispositivos-unificados-capacidades-design.md docs/superpowers/plans/2026-08-29-dispositivos-unificados-capacidades.md -m "docs: close unified devices rollout"
```

## Rollout Summary

```text
Schema/server aditivo
        ↓
Android reporta + consume intents
        ↓
QA D3 / T3 Pro / phone / offline
        ↓
Dashboard /devices + acciones por capacidad
        ↓
7 días de métricas
        ↓
422 al PUT dashboard legado de display
```

Una detención en cualquier flecha conserva la operación anterior. Ninguna fase requiere mover IDs, crear dispositivos manualmente ni activar
POS.
