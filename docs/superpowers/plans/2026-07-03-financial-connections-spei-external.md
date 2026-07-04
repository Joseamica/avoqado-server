# Financial Connections — SPEI Externo (envío real a cualquier banco) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un OWNER pueda enviar dinero real desde su cuenta de negocio conectada a **cualquier banco** (vía CLABE), no solo entre
cuentas Moneygiver. Reemplaza el stub deshabilitado ("Muy pronto") de la página `bancos/spei` del dashboard (avoqado-web-dashboard) por un
envío real, auditado y con doble candado de seguridad.

**Contexto — de dónde sale esto:** Se descubrió un endpoint de QPay/Moneygiver **etiquetado explícitamente `External`** en su Swagger de
producción (`https://api.qpaydev.xyz/swagger/v1/swagger.json`, el mismo host que ya usa `EXTERNAL_BANK_API_BASE` en `src/config/env.ts:89` —
NO es un ambiente distinto): `POST /api/external/spei/out`. A diferencia de `add-transferenciaMG` (transferencia interna, sin idempotencia),
este endpoint **sí acepta `idempotencyKey`** y usa el mismo Bearer JWT que ya cacheamos — cero mecanismo de auth nuevo. También existe
`GET /api/external/banks` (catálogo de bancos con su `idBanco`) y `GET /api/external/spei/out/{id}` (consulta de estatus). Contrato
confirmado contra el spec real (no reversado a ciegas):

```
POST /api/external/spei/out  (SpeiOutDto → SpeiOutReponseDto)
  idempotencyKey         string (uuid)   — clave de idempotencia real del proveedor
  idMoneyGiver           string (uuid)   — cuenta origen
  cuentaBeneficiario     string          — CLABE destino
  nombreBeneficiario     string
  tipoCuentaCuentaBeneficiario string    — tipo de cuenta destino (revisar valores válidos en Task 2)
  monto                  number
  conceptoPago           string
  idBanco                int             — código de banco destino (catálogo abajo)
→ { success, message, httpStatusCode, idOperacion, id }

GET /api/external/spei/out/{id} → SpeiResponseDto { id, estatus (int), motivoDevolucion }
GET /api/external/banks → { data: [{ idBanco, nombre, clabe }] }
```

**Arquitectura:** Mismo patrón que `sendInternalTransfer` (ya en producción, `financialConnection.service.ts:598`), adaptado:

- **Origen**: en vez de `idCuentaAlt` (traspaso interno), se necesita `idMoneyGiver` de la cuenta conectada. Ya se captura para conexiones
  **CLIENT** (`idMoneyGiverOf()`, guardado como `externalClientId`); para **MERCHANT** hay que confirmar/capturar (Task 1) — mismo patrón de
  backfill perezoso que `externalCuentaId` (movements plan, Task 1/3).
- **Destino**: CLABE + nombre + banco, tecleados por el usuario (con el mismo validador de dígito verificador de CLABE ya construido en el
  dashboard para Beneficiarios — se extrae a un util compartido).
- **Doble candado de dinero real**: idempotencyKey real del proveedor (nuevo) + dedup por contenido en ActivityLog (mismo patrón que
  `sendInternalTransfer`, defensa en profundidad porque esto sale del todo del ecosistema Moneygiver — más riesgoso que un traspaso
  interno) + rate limit + confirmación explícita en UI antes de enviar.
- **Catálogo de bancos**: proxy de solo lectura (`GET .../spei-banks`) — usa el token YA cacheado de esa cuenta para llamar
  `/api/external/banks` (el dato en sí no es específico de la cuenta, pero se reusa la resolución de token existente en vez de inventar una
  nueva).
- **Reemplaza el stub Fase 2**: `bankingHub.service.ts`'s `speiService`/`SpeiOutInput`/`SpeiOutResult` (que siempre lanzaban
  `BankingHubNotImplementedError`) se **eliminan** — el envío real vive en `financialConnection.service.ts`, igual que
  `sendInternalTransfer`, no en el archivo de stubs UI-first.
- **Fuera de alcance de este plan**: Dispersiones (envío en lote) — no existe un endpoint `External` de lote; se lograría iterando el envío
  individual de este plan una vez por beneficiario (su propio plan futuro, reusa `sendSpeiOut`).

**Tech Stack:** avoqado-server (Node/Express/Prisma/axios/jest+nock) · avoqado-web-dashboard (React 18/TS/TanStack
Query/shadcn/react-i18next/vitest).

## Global Constraints

- **Repos y cwd por task:** Tasks 1-5 en `/Users/amieva/Documents/Programming/Avoqado/avoqado-server`; Tasks 6-8 en
  `/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard`; Task 9 ambos.
- **🔴 Git read-only en esta sesión (regla del founder):** NO commitear, NO cambiar de branch, NO crear worktrees. Cada task deja el cambio
  aplicado y verificado, sin commit — el founder decide cuándo commitear.
- **Regla de oro del proyecto:** ya no aplica el "nunca finjas éxito" del stub — esto SÍ mueve dinero real. Por eso el candado es más
  estricto que traspasos internos: idempotencyKey real + dedup por contenido + rate limit + confirmación explícita (dos pasos: revisar
  destino → confirmar envío, igual que `BankInternalTransferDialog` pero con una advertencia más fuerte porque el destino es un banco ajeno,
  no verificable de antemano como en traspasos internos).
- **CLIENT-kind guard:** igual que traspasos internos — `fa.connection.accountKind === 'CLIENT'` → `BadRequestError`. El spec original de
  financial-connections nunca probó dinero saliente contra sesión CLIENT (PWA); se mantiene fuera de alcance.
- **Montos honestos:** cero `|| 0` en montos. CLABE se valida con dígito verificador (algoritmo Banxico, ya implementado en el dashboard
  para Beneficiarios — extraer a `src/utils/clabe.ts` para reusarlo en ambos).
- **Auditoría obligatoria:** cada intento de envío (éxito o falla) se registra en `ActivityLog` con acción `FINANCIAL_SPEI_OUT` — mismo
  shape que `FINANCIAL_INTERNAL_TRANSFER` (destAccount/destName/amount/ok/movementId/message) + `idBanco`.
- **Tier gate:** las rutas nuevas llevan `checkFeatureAccess('BANKING_HUB')` (mismo gate que el resto de financial-connections — ver
  `financialConnection.routes.ts` actual, todas las rutas ya lo tienen después de `checkPermission`).
- **Rate limit:** `financialConnectionRateLimiter` en la ruta de envío (mueve dinero, mismo criterio que `/internal-transfer`). El catálogo
  de bancos es solo lectura → sin rate limiter (paridad con `/balance`).
- **🔴 Exclusión MCP (decisión del founder, 2026-07-03):** NO exponer `sendSpeiOut`, confirmaciones de envío ni ninguna herramienta capaz de
  iniciar un SPEI en ninguno de los dos MCP (`src/mcp/` customer ni `scripts/mcp/` admin). El envío queda restringido al dashboard/API
  autenticado. Las herramientas de reportes pueden seguir mostrando movimientos SPEI históricos en modo de solo lectura.
- **i18n frontend:** CERO strings hardcodeados; paridad exacta es/en/fr en `financialConnections.json`. El copy actual de "vista previa" /
  "Muy pronto" de `hub.spei.*` se **reemplaza** por el flujo real (confirmar antes de enviar, éxito, error) — mismo tono que `transfer.*`
  (traspasos internos) pero con un aviso más fuerte de irreversibilidad ("vas a enviar dinero a un banco externo, no se puede deshacer").
- **Verificación por task:** backend `npx jest tests/unit/services/financial-connections/ --silent` +
  `NODE_OPTIONS='--max-old-space-size=8192' npx tsc --noEmit`; frontend `npx tsc -p tsconfig.app.json --noEmit` (⚠️ `tsc --noEmit` de raíz
  es no-op en este repo) + `npx vitest run <archivos>` + `npm run lint`.
- **NUNCA probar el envío real contra la cuenta viva conectada con un monto que no sea trivial** (ej. $1.00 MXN a una CLABE propia del
  founder, confirmada por él antes de correrlo) — a diferencia de las lecturas (movimientos, saldo), esto es irreversible. Cualquier smoke
  test en vivo de este plan requiere confirmación explícita del founder antes de ejecutarse, con monto y destino visibles en el mensaje de
  confirmación.

---

### Task 1 (BE): Capturar `idMoneyGiver` de la cuenta conectada (MERCHANT + CLIENT)

**Files:**

- Modify: `prisma/schema.prisma` (model `FinancialConnection` o `FinancialAccount` — decidir en Step 1 dónde vive semánticamente:
  `idMoneyGiver` es de la CONEXIÓN/usuario, no de la cuenta de dispersión individual, así que probablemente `FinancialConnection`, paralelo
  a `externalClientId`)
- Modify: `src/services/financial-connections/externalBank.client.ts` (`idMoneyGiverOf` ya existe — confirmar que se llama también en el
  flujo MERCHANT, no solo CLIENT)
- Modify: `src/services/financial-connections/financialConnection.service.ts` (persistir + backfill perezoso, mismo patrón que
  `externalCuentaId`)
- Create: migración Prisma
- Test: ajustar tests existentes del service

**Interfaces:**

- Produces: `FinancialConnection.externalMoneyGiverId: string | null` (o el nombre que decida Step 1 tras leer el modelo actual). Task 3 lo
  consume.

- [ ] **Step 1: Investigar dónde aparece `idMoneyGiver` para una conexión MERCHANT.** Leer `idMoneyGiverOf()` completo
      (`externalBank.client.ts`) y todos sus call sites — ¿se invoca ya en el flujo de login/connect MERCHANT (no solo CLIENT)? ¿El payload
      de `/api/auth` (fetchMe, el mismo que ya parseamos para `cuentaDispersion.idCuenta`) trae `idMoneyGiver` también para negocios? Si sí:
      extenderlo en el MISMO punto donde se extrae `cuentaId` (paralelo a Task 1 del plan de movimientos). Si NO está en ese payload para
      MERCHANT: documentar dónde SÍ aparece (probar contra la cuenta MERCHANT viva conectada si existe una en `av-db-25`; si no hay ninguna
      MERCHANT conectada actualmente, usar un script temporal `scripts/temp-probe-merchant-idmoneygiver.ts` como se hizo antes para el flujo
      CLIENT — **borrar el script al terminar**, ver `.claude/rules/testing-and-git.md`).
- [ ] **Step 2: Agregar la columna** (protocolo compartido de `schema.prisma` — ver Task 1 Step 1 del plan de movimientos si hay diff ajeno
      sin commitear) y migrar.
- [ ] **Step 3: Persistir en el connect flow** (donde ya se guarda `externalClientId` para CLIENT — extender para MERCHANT también si el
      Step 1 confirma que está disponible ahí).
- [ ] **Step 4: Backfill perezoso** — función `resolveMoneyGiverId(conn)` mirror de `resolveCuentaId` (movements plan Task 3): si
      `externalMoneyGiverId` es null, refetch vía el mismo mecanismo que ya usa `listAccounts`/`fetchMe` y persistir. Lanza
      `BadRequestError` honesto si el proveedor tampoco lo reporta (nunca 500).
- [ ] **Step 5: Test** + **Step 6: Verificar** (jest + tsc) — sin commit (regla git read-only de esta sesión).

---

### Task 2 (BE): Cliente del proveedor — envío SPEI externo + catálogo de bancos

**Files:**

- Modify: `src/services/financial-connections/types.ts`
- Modify: `src/services/financial-connections/externalBank.client.ts`
- Test: `tests/unit/services/financial-connections/externalBank.client.test.ts` (nock)

**Interfaces:**

- Produces (Task 3 los consume con estos nombres):

```ts
export interface SpeiOutInput {
  idMoneyGiver: string
  idempotencyKey: string
  destinationClabe: string
  beneficiaryName: string
  destinationAccountType: string // valor confirmado en Step 1 contra el spec/probes reales — no adivinar
  amount: number
  concept: string
  idBanco: number
}
export interface SpeiOutResult {
  ok: boolean
  operationId: string | null
  transferId: string | null // el `id` (uuid) de SpeiOutReponseDto — para consultar status después
  message: string | null
}
export interface SpeiBank {
  idBanco: number
  name: string | null
  clabePrefix: number | null // el campo `clabe` del BankDto — confirmar en Step 1 si es el prefijo de 3 dígitos o algo distinto
}
// en FinancialProviderClient:
sendSpeiOut(ctx: ConnectionContext, input: SpeiOutInput): Promise<SpeiOutResult>
listSpeiBanks(ctx: ConnectionContext): Promise<SpeiBank[]>
```

- [ ] **Step 1: Confirmar contra el spec real** (`https://api.qpaydev.xyz/swagger/v1/swagger.json`, mismas credenciales que ya se usaron
      para descubrir esto — pedir al founder si hace falta re-fetchear) los valores válidos de `tipoCuentaBeneficiario` (¿"CLABE" |
      "TARJETA"? — el schema solo dice `string`) y qué representa `clabe` en `BankDto` (int — ¿los primeros 3 dígitos de CLABE de ese banco,
      para poder autodetectar el banco desde la CLABE tecleada?). Documentar el hallazgo en el código con un comentario, igual que el resto
      del client (`// Espejo de la petición probada...`).
- [ ] **Step 2: Tests nock que fallan** — mock `POST /api/external/spei/out` y `GET /api/external/banks` con el shape real confirmado en
      Step 1.
- [ ] **Step 3: Implementar** `sendSpeiOut`/`listSpeiBanks` en `externalBank.client.ts`, mismo estilo que `internalTransfer`/`resolveMgAlt`
      (try/catch → nunca lanza en fallos "esperados" del proveedor, devuelve `{ok:false, message}`; SÍ propaga errores de red/auth para que
      el service los maneje vía `markConnectionNeedsReauth`).
- [ ] **Step 4: PASS + tsc exit 0.**

---

### Task 3 (BE): Service — envío auditado con doble candado + catálogo

**Files:**

- Modify: `src/services/financial-connections/financialConnection.service.ts`
- Test: `tests/unit/services/financial-connections/financialConnection.service.test.ts`

**Interfaces:**

- Produces:
  `sendSpeiOut(financialAccountId, input: { destinationClabe, beneficiaryName, idBanco, amount, concept, staffId? }): Promise<SpeiOutResult>`
  y `getSpeiBanks(financialAccountId): Promise<SpeiBank[]>`.

- [ ] **Step 1: Tests que fallan**, mismo estilo que los de `sendInternalTransfer` existentes en el archivo, cubriendo:
  - Guard CLIENT-kind → `BadRequestError`.
  - CLABE con dígito verificador inválido → `BadRequestError` ANTES de llamar al proveedor (fail fast, no gastar la llamada).
  - Dedup: mismo destino + mismo monto dentro de la ventana → NO reenvía, devuelve el resultado previo (mismo
    `INTERNAL_TRANSFER_DEDUP_WINDOW_MS` de 5 min, o una constante propia `SPEI_OUT_DEDUP_WINDOW_MS` si se decide una ventana distinta —
    justificar en el código si difiere).
  - Éxito: genera `idempotencyKey` (nuevo, vía `crypto.randomUUID()`) UNA vez, la pasa al client, y el mismo valor se reutiliza si esta
    MISMA invocación se reintenta a nivel de código (no aplica a un F5 del usuario — eso es un envío nuevo con su propio `idempotencyKey`,
    correcto).
  - Auditoría: `ActivityLog` con `action: 'FINANCIAL_SPEI_OUT'`, `entity: 'FinancialAccount'`, incluye `idBanco`.
  - Error del proveedor (ej. CLABE inexistente, banco no disponible) → mensaje honesto, `ok:false`, SIN 500.
- [ ] **Step 2: Implementar**, mismo esqueleto que `sendInternalTransfer` (líneas 598-683 actuales): validar monto > 0, cargar `fa` +
      `connection`, guard CLIENT, dedup por ActivityLog, resolver `idMoneyGiver` (Task 1), llamar `client.sendSpeiOut`, loguear, retornar.
      `getSpeiBanks` es una lectura simple (sin dedup/audit, paridad con `/balance`).
- [ ] **Step 3: PASS + tsc exit 0.**

---

### Task 4 (BE): Controller + rutas

**Files:**

- Modify: `src/controllers/dashboard/financialConnection.controller.ts`
- Modify: `src/routes/dashboard/financialConnection.routes.ts`

- [ ] **Step 1: Controller** — `sendSpeiOut` (valida body: `destinationClabe`, `beneficiaryName`, `idBanco`, `amount`, `concept` requeridos,
      400 si faltan) y `getSpeiBanks` (sin params), mismo shape `{ success: true, data }` que el resto.
- [ ] **Step 2: Rutas** — agregar bajo `venueFinancialAccountRoutes`, MISMO orden de middlewares que `/internal-transfer` (permiso →
      `checkFeatureAccess('BANKING_HUB')` → rate limiter → controller):

```ts
venueFinancialAccountRoutes.get(
  '/:id/spei-banks',
  checkPermission('financialConnections:manage'),
  checkFeatureAccess('BANKING_HUB'),
  ctrl.getSpeiBanks,
)
venueFinancialAccountRoutes.post(
  '/:id/spei-out',
  checkPermission('financialConnections:manage'),
  checkFeatureAccess('BANKING_HUB'),
  financialConnectionRateLimiter,
  ctrl.sendSpeiOut,
)
```

- [ ] **Step 3: Verificar** jest + tsc.

---

### Task 5 (BE): Verificación integral backend + smoke controlado

- [ ] **Step 1:** `npx jest tests/unit/services/financial-connections/ --silent` verde; tsc exit 0.
- [ ] **Step 2 (catálogo, solo lectura, seguro):** smoke en vivo de `GET .../spei-banks` contra la cuenta conectada real — pegar el response
      (truncado) en el reporte.
- [ ] **Step 3 (envío real — REQUIERE luz verde explícita del founder):** NO ejecutar sin que Jose confirme monto + CLABE destino en el
      propio mensaje de aprobación. Si se aprueba: un envío de $1.00 MXN a una CLABE de prueba que el founder indique, documentar el
      `idOperacion` devuelto y confirmar en Movimientos que aparece. Si no hay luz verde, dejar este paso como pendiente explícito en el
      reporte final — NO inventar un smoke test con dinero real por cuenta propia.

---

### Task 6 (FE): Servicio frontend + util de CLABE compartido

**Files:**

- Modify: `src/services/financialConnection.service.ts`
- Create: `src/utils/clabe.ts` (extraído de `BancosBeneficiarios.tsx` — `clabeCheckDigit`/`isValidClabe`)
- Modify: `src/pages/Bancos/BancosBeneficiarios.tsx` (importar del util nuevo en vez de la copia local)
- Modify/Delete: `src/services/bankingHub.service.ts` (quitar `speiService`, `SpeiOutInput`, `SpeiOutResult`,
  `BankingHubNotImplementedError` SOLO si ya no lo usa nada más — Dispersiones sigue como stub, así que la clase de error se queda si
  Dispersiones la sigue usando)
- Test: `src/services/__tests__/financialConnection.service.test.ts`, `src/utils/__tests__/clabe.test.ts` (nuevo)

- [ ] **Step 1:** Extraer `clabeCheckDigit`/`isValidClabe` a `src/utils/clabe.ts` con su test unitario (casos: CLABE real válida
      `032180000118359719`, dígito trocado → inválida, longitud incorrecta → inválida). Actualizar `BancosBeneficiarios.tsx` para importar
      de ahí.
- [ ] **Step 2:** `financialConnectionAPI.sendSpeiOut(venueId, financialAccountId, body)` y `.listSpeiBanks(venueId, financialAccountId)`,
      mismo patrón que `internalTransfer`/`resolveTransferDestination` ya existentes en el archivo.
- [ ] **Step 3:** Tests + tsc + lint verdes.

---

### Task 7 (FE): Reemplazar el stub de `BancosSpei.tsx` por el envío real

**Files:**

- Modify: `src/pages/Bancos/BancosSpei.tsx`
- Modify: `src/components/Sidebar/app-sidebar.tsx` (quitar `comingSoon: true` de `bancosMenu.spei`)
- Modify: `src/routes/venueRoutes.tsx` (sin cambio de estructura, la ruta ya existe — solo deja de ser "letra muerta")
- Modify: locales `financialConnections.json` es/en/fr (`hub.spei.*` — quitar copy de "vista previa"/"muy pronto", agregar confirmación +
  éxito + error)
- Test: `src/pages/Bancos/BancosSpei.test.tsx` (el existente valida que el submit esté SIEMPRE deshabilitado — esos tests dejan de aplicar
  tal cual; reescribir para validar el flujo real: banco poblado desde `listSpeiBanks`, confirmación de dos pasos, éxito, error honesto)

- [ ] **Step 1:** Selector de banco poblado con `listSpeiBanks` (reemplaza el campo de texto libre de CLABE-implica-banco si Task 2 confirmó
      autodetección; si no, selector manual). Validación de CLABE con `isValidClabe` (Task 6) en vivo mientras el usuario teclea.
- [ ] **Step 2:** Flujo de confirmación de DOS pasos antes de enviar (mismo patrón que `BankInternalTransferDialog`): paso 1 revisa destino
      (nombre + CLABE + banco + monto) con advertencia "esto sale a un banco externo, no se puede deshacer, verifica el nombre y CLABE";
      paso 2 confirma y envía. Botón deshabilitado durante `isPending` (protección doble-click).
- [ ] **Step 3:** Éxito → toast + folio (`idOperacion`) visible, mismo patrón que `transfer.successBody`. Error → mensaje honesto + "puede
      que sí se haya enviado, revisa tus movimientos antes de reintentar" (mismo texto que traspasos internos, aplica igual aquí).
- [ ] **Step 4:** Quitar `comingSoon: true` de `bancosMenu.spei` en `app-sidebar.tsx` (mismo cambio que se hizo para Beneficiarios/Reportes
      en la Fase 2 del hub).
- [ ] **Step 5:** Reescribir `BancosSpei.test.tsx` para el flujo real; tsc + lint + vitest verdes.

---

### Task 8 (FE): i18n final + verificación integral frontend

- [ ] **Step 1:** Paridad exacta es/en/fr de las keys nuevas/modificadas de `hub.spei.*`.
- [ ] **Step 2:** `npx tsc -p tsconfig.app.json --noEmit` + `npm run lint` + `npx vitest run` + `npm run build` — todo verde.
- [ ] **Step 3:** Playwright manual (igual que se hizo para el resto del hub): navegar a `bancos/spei`, confirmar que el sidebar ya no lo
      muestra "Muy pronto", que el selector de banco carga datos reales, y que el formulario completo hasta el paso de confirmación funciona
      (SIN enviar dinero real salvo luz verde explícita del founder, ver Task 5 Step 3).

---

### Task 9: Reporte final + actualizar mapas del proyecto

- [ ] **Step 1:** Actualizar `TODOS.md` (avoqado-server) — quitar el item de "guard 0-cuentas MERCHANT" si Task 1 lo resolvió de paso; dejar
      constancia de que Dispersiones (envío en lote) queda como su propio plan futuro.
- [ ] **Step 2: 🔴 CRÍTICO — verificar exclusión MCP.** Confirmar con búsqueda y tests que no existe ninguna herramienta en `src/mcp/` ni
      `scripts/mcp/` capaz de iniciar o confirmar un SPEI. Esta capacidad se excluye deliberadamente del MCP por decisión del founder; no es
      trabajo pendiente ni bloqueante.
- [ ] **Step 3: 🔴 CRÍTICO — deck de ventas.** SPEI externo es una capacidad visible al cliente nueva (antes no existía ni como promesa) —
      actualizar `avoqado-presentacion.html` + `avoqado-one-pager.html` en el mismo cambio, o dejarlo bloqueante explícito.
- [ ] **Step 4:** Reporte final: qué se implementó, qué quedó pendiente de luz verde (envío real de prueba), confirmación de que el MCP no
      puede enviar SPEI y estado del deck de ventas.

---

## Self-Review (hecho al escribir el plan)

- **Cobertura:** contrato real confirmado contra Swagger de producción (no reversado a ciegas) — Tasks 2-4. Doble candado de dinero real
  (idempotencyKey + dedup + rate limit + confirmación UI) — Tasks 3/7. Reemplazo limpio del stub Fase 2 sin dejar código muerto — Task 6.
  Tier gate + auditoría — Tasks 3/4. i18n paridad — Task 8. Exclusión explícita del envío SPEI en ambos MCP + deck de ventas — Task 9.
- **Riesgo mayor identificado y mitigado:** ningún test/smoke de este plan mueve dinero real sin luz verde explícita del founder con monto y
  destino visibles (Global Constraints + Task 5 Step 3) — el error más caro posible (enviar dinero de verdad sin querer durante desarrollo)
  tiene una barrera humana explícita, no solo una buena intención en el código.
- **Incertidumbre honesta declarada, no ocultada:** `idMoneyGiver` para MERCHANT (Task 1), `tipoCuentaBeneficiario`/`clabe` en `BankDto`
  (Task 2 Step 1) — ambos con un paso de investigación explícito ANTES de escribir el código que depende de ellos, siguiendo el mismo patrón
  (`probe temporal, borrar después`) ya usado en este proyecto para incertidumbres similares del mismo proveedor.
- **Consistencia con lo ya construido:** mismo esqueleto que `sendInternalTransfer`/`resolveTransferDestination` (probado en producción),
  mismo gate de tier que el resto de financial-connections, mismo patrón de auditoría/dedup — cero invención de un patrón nuevo donde ya
  existe uno probado.
