# Spec — Cuentas de merchant ilimitadas por venue (modelo N-cuentas) · **v3 (canónico, sin capas)**

**Fecha:** 2026-06-17 · **Estado:** listo para partir en PRs (estrategia + plan aprobados en revisión cross-LLM) · **Opción:** B
(per-account) **Nota:** v3 fusiona todas las correcciones de auditoría en el cuerpo. **No hay secciones "override".** Trail de cómo se llegó
aquí: §15.

---

## 0. Resumen en español sencillo

Hoy un venue tiene **máximo 3 cuentas de cobro**. Queremos **ilimitadas, cada una con su propia comisión.**

- "3 cajones con nombre" → una **lista** (cada renglón = una cuenta con número de orden). Sin enums nuevos, sin tope.
- La comisión pasa a guardarse **por cuenta** (no por cajón). Parte delicada → etapas reversibles, ensayadas primero en una **copia de
  producción**.
- **Regla de oro:** ninguna cuenta puede cobrar sin precio. Se garantiza con **una sola API de escritura + gate de CI + reconciler +
  validación al cobrar** (la base de datos asegura que la cuenta esté en el **roster** del venue vía FK; un **trigger SQL es opcional** como
  refuerzo). _No_ es "la BD lo garantiza sola" — es defensa en capas.
- **El cobro nunca se toca.** La TPV ya está lista para N cuentas (sin release). Apps viejas no se rompen (§8).
- **Se suelta UN venue a la vez detrás de un flag** (amaena primero). Peor caso = 1 venue, reversible.

---

## 1. Problema y estado actual

### Asimetría raíz (causa del bug amaena)

- **Costo del proveedor** (`ProviderCostStructure`): por `merchantAccountId` → ilimitado.
- **Precio al venue** (`VenuePricingStructure`): por `(venueId, accountType)` → máx 3. Ese desbalance causó el subcobro de amaena. Esta spec
  lo cierra de verdad, incluido el camino de terminales (abajo).

### Las DOS topologías que llegan a una cuenta

```
(1) Venue → VenuePaymentConfig → {primary,secondary,tertiary}Account     ← "slots" (pricing)
(2) Venue → Terminal[] → Terminal.assignedMerchantIds (String[], sin FK)  ← "asignación por terminal" (selección)
```

`terminal.tpv.controller.ts:263-271`: si la terminal tiene `assignedMerchantIds`, usa ESAS cuentas e **ignora los slots**. Producción crea
cuentas "solo-en-terminal" (en cero slots) automáticamente (Blumon auto-fetch, asignación superadmin). **La selección es POR TERMINAL** (el
cajero elige); no hay "orden global del venue" que rutee.

### Blast radius

server (schema+resolver+migración+MCP) · web-dashboard (~40 archivos `Superadmin/*` + `Venue/*`) · avoqado-superadmin
(`features/merchants|venues/*`) · **avoqado-tpv: 0, transparente, sin release** · **POS android/ios: 0, fuera de alcance**.

---

## 2. Objetivos, convenciones y tier

**Objetivos:** N cuentas por venue/org; pricing por cuenta; cero regresión del cobro; ambos portales superadmin; MCP read-only en lockstep.
**Fuera de alcance:** cost/BIN-routing/failover automático (queda `routingRules` JSON sin lógica); POS android/ios; **e-commerce**
(`Payment.ecommerceMerchantId` / Stripe Connect / Blumon e-commerce → `merchantAccountId=null`, se **excluyen** de
roster/resolver/compuerta, filtrando `merchantAccountId IS NOT NULL`); migración forzada de UX.

**Tier:** `MULTI_MERCHANT_ACCOUNTS` = **FREE** — registrado en el sistema de features (`plan-catalog.ts` + `basePlan.service.ts` +
`checkFeatureAccess`), disponible a todos (sin paywall; queda en catálogo con flexibilidad de moverlo a pago después). **NO confundir con el
flag de rollout per-venue** (§7), que es estado de migración interno y temporal.

**Convenciones (obligatorias para quien implemente):**

- **Dinero = `Decimal` pesos**, NO cents estilo Stripe. `Payment.amount` `Decimal(12,2)`, tasas `Decimal(5,4)`. Los cents solo existen en
  fronteras externas (TPV manda cents → `/100` al entrar; Stripe/MercadoPago convierten aparte). Aritmética **Decimal** + redondeo a 2
  decimales (`round2`); la compuerta compara con tolerancia de redondeo, no igualdad de float.
- **Fechas = UTC en BD, lógica/agrupación en `venue.timezone`** (fallback `DEFAULT_TIMEZONE`, `date-fns-tz`). Todo bucketing por día
  (compuerta, canario, settlement) en venue-tz, nunca UTC/hora-servidor.

---

## 3. Modelo de datos (final)

### 3.1 Roster del venue (reemplaza los 3 slots)

```prisma
model VenueMerchantAccount {
  id                   String   @id @default(cuid())
  venuePaymentConfigId String
  venuePaymentConfig   VenuePaymentConfig @relation(fields: [venuePaymentConfigId], references: [id], onDelete: Cascade)
  venueId              String
  merchantAccountId    String
  merchantAccount      MerchantAccount @relation(fields: [merchantAccountId], references: [id], onDelete: Restrict)
  priority             Int          // SOLO orden de display (NO ruteo)
  legacySlotType       AccountType? // INMUTABLE, set una vez en backfill (0→PRIMARY,1→SECONDARY,2→TERTIARY,3+→null). Única fuente del pricing/contrato legacy.
  inheritedFromOrg     Boolean  @default(false) // cuenta materializada desde OrganizationMerchantAccount
  label                String?
  active               Boolean  @default(true)
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@unique([venuePaymentConfigId, merchantAccountId])
  @@unique([venueId, merchantAccountId])  // requerido por la FK compuesta de TerminalMerchantAccount
  @@index([merchantAccountId])
  @@index([venueId])
}
```

- Gemelo `OrganizationMerchantAccount` = **plantilla/fuente** a nivel org. Las cuentas heredadas se **materializan** como filas
  `VenueMerchantAccount` por venue (`inheritedFromOrg=true`) → el resolver de costo NO necesita un camino org especial, y la FK de terminal
  siempre se satisface. **Ciclo de vida (post-rollout):** cambios en `OrganizationMerchantAccount`/`OrganizationPaymentConfig` se **propagan transaccionalmente** a las filas `VenueMerchantAccount` de los venues hijos vía la API de escritura (alta/baja/cambio); el reconciler **REPARA** la deriva, no solo la reporta.
- `priority` solo ordena display; el orden se maneja a nivel app (sin `@@unique([…, priority])`, para no re-mapear al reordenar).

### 3.2 Terminal ↔ cuenta (reemplaza el `String[]` sin FK)

```prisma
model TerminalMerchantAccount {
  id                   String   @id @default(cuid())
  terminalId           String
  terminal             Terminal @relation(fields: [terminalId], references: [id], onDelete: Cascade)
  venueId              String
  merchantAccountId    String
  merchantAccount      MerchantAccount @relation(fields: [merchantAccountId], references: [id], onDelete: Restrict)
  // FK COMPUESTA al roster. GARANTIZA solo que la cuenta esté en el roster del venue.
  // NO garantiza active ni pricing — eso se enforza en §4 (no es una promesa de la BD).
  venueMerchantAccount VenueMerchantAccount @relation(fields: [venueId, merchantAccountId], references: [venueId, merchantAccountId], onDelete: Restrict)
  perTerminalOrder     Int?
  isDefault            Boolean  @default(false)
  active               Boolean  @default(true)

  @@unique([terminalId, merchantAccountId])
  @@index([merchantAccountId])
}
```

- `isDefault`: **unique parcial** `(terminalId) WHERE isDefault` → "un default por terminal". Reemplaza el `kioskDefaultMerchantId` que hoy
  vive en `Terminal.config.settings` (JSON, no columna) → durante la transición se **dual-escribe/deriva** ese JSON desde `isDefault` hasta
  que mueran los APKs viejos.
- Reemplaza `Terminal.assignedMerchantIds String[]`; el array se conserva (dual-write) hasta la etapa contract.

### 3.3 Pricing por cuenta

```prisma
model VenuePricingStructure {
  // ...campos existentes...
  accountType       AccountType?   // legacy (filas viejas)
  merchantAccountId String?        // nuevo (filas por-cuenta)
  merchantAccount   MerchantAccount? @relation(fields: [merchantAccountId], references: [id], onDelete: Restrict)
  @@index([merchantAccountId])
}
```

- Igual `OrganizationPricingStructure`.
- **Constraints de dinero — van en SQL CRUDO de la migración** (Prisma no modela CHECK, y los partial unique requieren
  `previewFeatures=["partialIndexes"]` o SQL): (a) `CHECK` de **exactamente uno** de (`accountType`, `merchantAccountId`) no-null; (b)
  unique parcial **scoped por venue/org** — en `VenuePricingStructure`:
  `(venueId, accountType, effectiveFrom) WHERE merchantAccountId IS NULL` (legacy) +
  `(venueId, merchantAccountId, effectiveFrom) WHERE merchantAccountId IS NOT NULL` (nuevo); en `OrganizationPricingStructure`: lo mismo con
  `organizationId` en vez de `venueId`. **Sin el `venueId`/`organizationId` el índice bloquearía overrides válidos de la misma cuenta (p.
  ej. una cuenta org materializada) en distintos venues.**
- Per-account **REQUERIDO** para cuentas con `priority ≥ 3` (no hay `legacySlotType`); el wizard bloquea activar una 4ta+ sin pricing.

### 3.4 Observabilidad

**Dos** flags en `TransactionCost` (fallbacks distintos): `providerCostFallbackUsed Boolean @default(false)` y
`venuePricingFallbackUsed Boolean @default(false)`. Hacen la fuga de margen contable por pago.

**Fuente del pricing en `TransactionCost`.** El precio puede venir del nivel org (fallback de herencia,
`organization-payment-config.service.ts:100`), pero hoy `TransactionCost` solo puede apuntar a `VenuePricingStructure`. Por eso se agrega
`pricingStructureSource enum { VENUE, ORG }` + un `organizationPricingStructureId String?` (junto al `venuePricingStructureId` existente),
para registrar **qué fila y de qué nivel** costeó cada pago. **No se materializa el pricing org** (evitaría drift al cambiar tarifas del
org); se resuelve por nivel y se registra la fuente. (Las _cuentas_ org sí se materializan al roster — §3.1 — por la presión de la FK; el
_pricing_ no.) **Integridad (CHECK SQL):** `source=VENUE ⇒ venuePricingStructureId NOT NULL AND organizationPricingStructureId NULL`; `source=ORG ⇒ organizationPricingStructureId NOT NULL AND venuePricingStructureId NULL` (excepción: pagos TEST pueden no tener ninguno).

---

## 4. El invariante + enforcement (anti-amaena, honesto)

**Invariante:** toda cuenta cobrable (en `TerminalMerchantAccount` o referenciada por un pago) tiene un `VenueMerchantAccount` **activo con
pricing**.

Qué garantiza cada capa (sin sobrepromesas):

1. **BD (FK compuesta):** garantiza que la cuenta esté **en el roster del venue**. NO garantiza `active` ni pricing.
2. **Servicio (único choke-point):** UNA sola API (`assignMerchantToTerminal`) hace TODAS las escrituras de cuentas-en-terminal; hace
   upsert/valida la fila de roster **+ pricing** antes de asignar. **Gate de CI (grep/lint) que FALLA** si queda cualquier escritura cruda
   de `assignedMerchantIds`/`TerminalMerchantAccount` fuera de la API. Escritores a migrar (lista completa):
   `superadmin/terminal.controller.ts:144`, `superadmin/merchantAccount.controller.ts` (Blumon auto-fetch :883, batch, full-setup, toggles
   :1083), `onboarding.controller.ts:375`, `dashboard/terminal-migration.service.ts:171`, `dashboard/terminals.superadmin.service.ts:313`,
   `organization-dashboard/orgTerminals.service.ts:464`, AngelPay/full-setup.
3. **Runtime (ingestión):** `recordPayment` (`payment.tpv.service.ts:1505`) **valida** que el `merchantAccountId` enviado pertenezca al
   roster del venue (y a la terminal); si no, lo marca de forma **DURABLE** (nuevos campos en `Payment`: `merchantResolutionStatus` enum + `merchantResolutionReason` + `originalMerchantAccountId` — NO solo en `processorData` JSON) en vez de costear mal (cierra el hueco de una TPV stale/offline
   durante el cutover).
4. **Defensa en profundidad (opcional):** trigger SQL que rechace una `TerminalMerchantAccount` cuya cuenta-roster no esté `active`/sin
   pricing.

Más: **reconciler periódico** (que **REPARA** la deriva, no solo la reporta — ver ciclo de vida §3.1) + guard de `deleteMerchantAccount()` extendido a ambas tablas.

---

## 5. Resolución de costo/comisión (`createTransactionCost`)

1. **Cuenta real:** match `payment.merchantAccountId` contra el **roster del venue** (que ya incluye las org materializadas) ∪ cuentas
   históricas. Como las org están materializadas, **no hay camino org especial** aquí.
2. **Costo del proveedor:** por `merchant.id`. Si falta → fallback al de PRIMARY + `providerCostFallbackUsed=true` + warn. (Hoy el código
   **lanza** en `transactionCost.service.ts:303` y se pierde el `TransactionCost`; este fallback lo evita.)
3. **Precio al venue:** venue per-account (`VenuePricingStructure.merchantAccountId`) → **org per-account** (`OrganizationPricingStructure.merchantAccountId`) → legacy por `legacySlotType` (venue→org) → fallback PRIMARY +
   `venuePricingFallbackUsed=true`. Se registra `pricingStructureSource` (VENUE/ORG) + el id en `TransactionCost` (§3.4); el account-resolution del paso 1 es venue-only (cuentas org materializadas), pero el PRICING sí puede venir del org.
4. **Fecha:** toda lookup de pricing/costo usa **`effectiveAt` = fecha del pago**, no `now()`.
   `getEffectivePricing({ venueId, accountType?, merchantAccountId?, effectiveAt })` (hoy hardcodea `new Date()` en
   `organization-payment-config.service.ts:73`). Crítico para el recompute histórico.
5. **Registrar** `TransactionCost` con la cuenta REAL (incluyendo `pricingStructureSource`, `organizationPricingStructureId` y los 2 flags de fallback). **Refunds:** `createRefundTransactionCost` (`transactionCost.service.ts:541-561`) debe copiar del original NO solo `venuePricingStructureId`, sino también `organizationPricingStructureId`, `pricingStructureSource` y los flags de fallback (hoy solo copia el venue id).
6. **Segundo endpoint TPV:** `getPaymentRouting` (`payment.tpv.service.ts:2836`) también resuelve solo contra los 3 slots → migrar al roster
   (o probar muerto para todo APK desplegado).
7. **DRY:** resolución venue/org unificada en **un solo camino parametrizado por nivel** (la duplicación copy-paste causó la asimetría
   original).

---

## 6. Migración expand/contract (reversible)

| Etapa                                 | Qué                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Reversible                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **1. Expand**                         | crear las 3 tablas + `VenuePricingStructure.merchantAccountId` + los 2 flags de fallback + constraints (SQL crudo). Nada se lee.                                                                                                                                                                                                                                                                                                                                                                          | ✅ revert+drop                   |
| **2. Backfill**                       | roster desde la **UNIÓN** (slots ∪ `assignedMerchantIds` ∪ históricos); **materializar org** (`inheritedFromOrg`); set `legacySlotType`; `TerminalMerchantAccount` desde `assignedMerchantIds`. Pricing backfill **history-aware**: NO asumir "slot de hoy = cuenta histórica" (VenuePaymentConfig no tiene historia) → resolver por el historial real (`TransactionCost`), ambiguo → **flag para remediación humana**. Query pre-migración: `(unión assignedMerchantIds) − (slots)` no-vacío → reportar. **Backfill + reconciler IDEMPOTENTES** (se pueden re-correr sin duplicar). | ✅ datos nuevos                  |
| **3. Dual-read/write**                | lecturas prefieren roster (fallback a columnas); escrituras por la única API. **Detrás del flag per-venue.**                                                                                                                                                                                                                                                                                                                                                                                              | ✅                               |
| **4. 🚦 Compuerta recompute-diff**    | recalcula TODOS los pagos del venue por su `merchantAccountId` real, **con `effectiveAt`=fecha del pago**, sin filtro de slot, comparación Decimal con tolerancia. STOP ante: cuenta sin precio / no-slot / merchant null inesperado / delta inexplicado. Corre **primero en un clon de prod**.                                                                                                                                                                                                           | ✅ no muta                       |
| **5. Contract** (opcional, diferible) | drop columnas legacy + `assignedMerchantIds`; promover constraints.                                                                                                                                                                                                                                                                                                                                                                                                                                       | ⚠️ único paso de un solo sentido |

---

## 7. 🔴 Seguridad de la transición (columna vertebral)

1. **Ensayo en CLON de prod** primero (etapas 1-4 + compuerta); solo si sale 100% limpio → mismos scripts en prod.
2. **Flag POR-VENUE — un venue a la vez** (amaena primero). Las lecturas nuevas se activan por venue; el **canario corre ANTES** de cambiar
   lecturas globales.
3. **Canario multi-terminal:** ≥2 terminales con cuentas distintas-pero-traslapadas; cobrar con cuenta priority≥1 **y** una
   solo-en-terminal; **misma cuenta desde 2 terminales** (mismo `venuePricingStructureId`); verificado **contra Postgres** + **APK viejo
   real** (§8).
4. **Compuertas = SCRIPTS con pass/fail + runbook de rollback por etapa** (no SQL a mano a las 3am).
5. **El cobro NUNCA en el camino de migración** (cálculo post-captura, `try/catch`).

## 8. Compatibilidad TPV (apps viejas — verificado forensemente)

No se rompen: Gson ignora keys desconocidas; `MerchantAccountDto` no tiene `accountType`; `providerCode` es String con `else→BLUMON`; lista
sin índices `[0][1][2]`. Do-no-harm: nunca quitar/renombrar campo; `providerCode` nunca enum estricto; campos nuevos opcionales. Backstop:
`X-App-Version-Code` + `tpv-version-gate.middleware.ts`. Prueba: canario con APK viejo (§7.3).

## 9. Contrato REST (aditivo)

Responses de payment-config devuelven **ambos**: los 3 campos legacy **derivados de `legacySlotType`** (NUNCA de `priority`) +
`merchantAccounts: [{merchantAccountId, priority, legacySlotType, active, inheritedFromOrg}]` ordenados por `priority`. POST/PUT aceptan
ambos formatos. Pricing endpoints aceptan `merchantAccountId` opcional. Nunca se exponen credenciales.

## 10. Frontends (ambos portales superadmin, en paralelo, mismo contrato)

- **Dashboard legacy:** `src/pages/Superadmin/*` (`MerchantAccounts`, `VenuePricing`, `merchant-setup-panel/SlotCard`, wizards) +
  `src/pages/Venue/*` → lista dinámica + pricing por cuenta.
- **avoqado-superadmin:** `src/features/merchants|venues/*` (`AccountSlot`, `MAX_SLOTS=3`, `SLOT_LABELS`) → mismo patrón.
- **TPV:** transparente, sin release.

## 11. MCP (read-only, en `src/mcp/` — Customer MCP)

Agregar: `list_venue_merchant_accounts`, `get_venue_payment_config`, `list_venue_pricing(merchantAccountId?)`,
`settlement_detail_by_merchant`. Escrituras quedan superadmin-only (no en MCP).

## 12. Matriz de cobertura de tests (objetivo 100%)

Resolver: `{en roster / org-materializada / solo-terminal-backfilled→aceptada+costeada / fuera-de-roster-y-terminal→rechazada / null-intencional / null-inesperado / sin-precio}` ×
`{pricing propio / legacy por legacySlotType / fallback PRIMARY}`, todo con `effectiveAt`. Más: provider-cost fallback (flag); invariante
(asignar cuenta sin roster → rechazada por FK; el grep-gate falla con escritura cruda); backfill history-aware (slot que cambió de cuenta);
recompute-diff Decimal sobre todos los pagos; `getPaymentRouting` con cuenta priority-3; `recordPayment` rechaza cuenta fuera de roster;
legacy del contrato sale de `legacySlotType` (reordenar priority no cambia primary/secondary/tertiary); canario multi-terminal; APK viejo.
**refund con pricing org** (copia `pricingStructureSource`+`organizationPricingStructureId`+flags); **CHECK de integridad** de la fuente de pricing; **propagación org→venue** tras cambio de config org (el reconciler repara). Regresión: los pagos correctos de amaena no cambian.

## 13. Decisiones abiertas (menores)

1. Etiquetas de cuentas 4+ (numéricas + `label` opcional — recomendado).
2. Cuándo la etapa 5 (contract) — diferible (recomendado: esperar a ≥varios venues con 4+ cuentas).
3. Aviso de tope blando en UI de terminal (recomendado: sí, solo aviso).

## 14. Plan de PRs (acordado)

1. **Expand + backfill** (server, detrás del flag, ensayado en clon).
2. **Resolver + writes-a-la-API + flag + recordPayment validation** (server).
3. **Contratos REST + MCP** (server).
4. **Frontends** (ambos portales superadmin).
5. **Contract** (diferido). Cada PR detrás del flag per-venue; cada uno con sus tests (§12) en verde antes de merge.

**Secuencia segura PR1→PR2:** como los writers crudos siguen activos hasta PR2, el **backfill/reconciler (idempotente) se RE-EJECUTA justo antes de activar el flag por venue** — captura cualquier `assignedMerchantIds` escrito entre PR1 y PR2 antes de que ese venue lea el modelo nuevo.

## 15. Trail de auditoría

- **R1** (data-model + payments-safety): hueco crítico terminal↔cuenta.
- **R2** (re-auditoría 3 lentes): opción (b) TerminalMerchantAccount.
- **R3** (eng-manager): rollout per-venue flag, runbook, DRY, matriz tests.
- **R4** (Codex gpt-5.5): invariante, choke-point, provider-cost fallback, `getPaymentRouting`, `recordPayment`, backfill history-aware,
  constraints, kioskDefaultMerchantId JSON.
- **R5** (cross-LLM estático): 5 P1 — FK overpromise, org-inheritance vs FK, legacy desde legacySlotType, `effectiveAt`, lista de
  escritores + grep-gate; + tier=FREE.
- **R6** (cross-LLM estático): **fusionar las correcciones en el cuerpo, eliminar la capa "override"** → hecho en este v3 (sin §16;
  secciones 0/3/4/5/6/9/12 ya consistentes).
- **R7** (cross-LLM estático): unique parcial mal dimensionado (faltaba `venueId`/`organizationId`); pricing org sin referencia en `TransactionCost` (→ `pricingStructureSource` + `organizationPricingStructureId`); matriz "solo-terminal→rechazada" mal redactada (las solo-terminal SÍ se backfillean y costean); idempotencia del backfill entre PR1↔PR2. → §3.3, §3.4, §5, §6, §12, §14.
- **R8** (cross-LLM estático): ciclo de vida de materialización org (propagar+**reparar**, no solo reportar); marca de reconciliación **durable** (`merchantResolutionStatus`/`Reason`/`originalMerchantAccountId`); CHECK de integridad de `pricingStructureSource`; **refunds** copian source+org-id+flags. → §3.1, §3.4, §4, §5, §12.
- Compat TPV apps viejas: verificada forensemente.
