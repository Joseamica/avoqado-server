# Spec de diseño — Cuentas de merchant ilimitadas por venue (modelo N-cuentas)

**Fecha:** 2026-06-17
**Estado:** Diseño para revisión (sin código todavía)
**Autor:** Jose + Claude
**Opción elegida:** B — tabla de cuentas (join table) + pricing por cuenta de merchant

---

## 0. Resumen en español sencillo (léelo aunque no leas el resto)

Hoy un venue puede tener **máximo 3 cuentas de cobro** (Principal / Secundaria / Terciaria). Queremos que pueda tener **las que quiera** (ilimitadas), y que **cada cuenta tenga su propia comisión**.

Cómo lo logramos sin romper nada:

1. Cambiamos los "3 cajones con nombre" por una **lista** donde cada renglón es una cuenta con un **número de orden** (0, 1, 2, 3, 4, …). Agregar una cuenta = agregar un renglón. Sin límite, sin enums nuevos.
2. Movemos la **comisión** para que se guarde **por cuenta** (no por cajón). Esta es la parte delicada — la hacemos por etapas, cada una reversible, con una **red de seguridad** que recalcula TODOS los pagos y compara que ninguna comisión cambie sin querer antes de soltar.
3. **La TPV no se toca en su forma de cobrar.** Ya está lista para N cuentas. No necesita actualización (APK). Lo único que cambia es la lista de cuentas que le mandamos, y eso se mantiene compatible con apps viejas. Probamos con **una terminal de prueba (canario)** antes de soltar a todos.
4. **Los POS (Android/iOS) no se tocan** — no manejan cuentas de merchant; el backend resuelve la cuenta de la orden. *(Nota: la selección de cuenta es POR TERMINAL, no por un orden global del venue — ver §1.5.)*
5. Actualizamos **los 2 portales de superadmin** (el legacy del dashboard y el nuevo avoqado-superadmin) para que ninguno quede desactualizado.

**El miedo principal (que la TPV deje de cobrar) está cubierto:** el cobro es independiente de todo esto, el cálculo de comisión corre DESPUÉS del cobro y está envuelto en try/catch (aunque truene, el cobro no se cae), y nada quita campos que las apps viejas necesitan.

---

## 1. Problema y estado actual

### El modelo de 3 slots
`VenuePaymentConfig` (y su gemelo `OrganizationPaymentConfig`) tienen exactamente 3 columnas FK:
`primaryAccountId` (requerido), `secondaryAccountId` (opcional), `tertiaryAccountId` (opcional).
El `enum AccountType { PRIMARY, SECONDARY, TERTIARY }` se usa para llavear las tarifas.

### La asimetría que causa bugs (la raíz del incidente amaena)
- **Costo del proveedor** (`ProviderCostStructure`) ya se llavea por `merchantAccountId` → ilimitado, por cuenta.
- **Precio al venue** (`VenuePricingStructure`) se llavea por `(venueId, accountType)` → máximo 3, por slot.
- **Terminales** (`Terminal.assignedMerchantIds: String[]`) ya pueden apuntar a N cuentas.

El cuello de botella es **solo el precio al venue**. Esta asimetría fue la causa del bug de amaena (un pago en la cuenta SECONDARY se costeaba con la tarifa de PRIMARY). Ya se hizo un fix de routing (cost por `payment.merchantAccountId`) + un hardening (fallback a PRIMARY si el slot no tiene pricing). **Este spec termina de cerrar la asimetría — PERO solo si trata las terminales como fuente de cuentas de primera clase (ver §1.5, corrección crítica de la auditoría).**

### Blast radius (medido)
| Repo | Toca | Notas |
|------|------|-------|
| **avoqado-server** | ~24 puntos | schema, transactionCost, inheritance resolvers, rateCorrectionScope, fiscalConfig, heartbeat, controllers, MCP |
| **avoqado-web-dashboard** (legacy superadmin + venue) | ~40 archivos | `src/pages/Superadmin/*` (merchant-setup-panel, SlotCard, VenuePricing, wizards) + `src/pages/Venue/*` |
| **avoqado-superadmin** (nuevo control plane) | ~13 puntos | `src/features/merchants/*`, `src/features/venues/*` (`AccountSlot`, `MAX_SLOTS=3`, `SLOT_LABELS`) |
| **avoqado-tpv** | 0 (transparente) | ya es N-ready; **no necesita release** |
| **avoqado-android / avoqado-ios** | 0 (fuera de alcance) | no consumen cuentas de merchant |
| **MCP** (`scripts/mcp`, `src/mcp`) | agregar tools | hoy no expone merchant/pricing; agregar tools de **solo lectura** |

---

## 1.5 ⚠️ CORRECCIÓN CRÍTICA (auditoría 2026-06-17): la SEGUNDA topología — terminales ↔ cuentas

**Dos auditores independientes (modelo de datos + seguridad de pagos) encontraron el MISMO hueco crítico.** El diseño original solo modelaba el eje `Venue → VenuePaymentConfig → cuentas` (los slots) y **omitía el eje `Venue → Terminal[] → Terminal.assignedMerchantIds`**, que es el que de verdad maneja la selección y, por lo tanto, el pricing.

**El error:** el endpoint de config de terminal (`terminal.tpv.controller.ts:263-271`) **ramifica**: si `terminal.assignedMerchantIds.length > 0`, carga ESAS cuentas por id y **nunca consulta `VenuePaymentConfig`**; solo cae a la herencia de slots si el array está vacío. Producción crea cuentas "solo-en-terminal" (en cero slots) automáticamente: Blumon auto-fetch (`merchantAccount.controller.ts:883-890`) y la asignación superadmin (`terminal.controller.ts:144-147`) escriben `assignedMerchantIds` **sin** verificar slots.

**Consecuencia (el bug de amaena, reintroducido):** una cuenta que cobra en una terminal pero no está en ningún slot → no tendría fila en `VenueMerchantAccount` → el pricing por-cuenta (§4 paso 3.1) no la encuentra → no hay `priority` para `deriveAccountType` (§4 paso 3.2) → cae a PRIMARY en silencio (§4 paso 3.3). **Exactamente la falla que el spec dice eliminar.** Además, si la compuerta recompute-diff se construye sobre la maquinaria por-slot de `rateCorrection` (`rateCorrectionScope.resolveMerchantAccountId`, `buildScopeWhere`), **ni siquiera seleccionaría esos pagos** → diff = 0 → falso "todo limpio".

### Correcciones obligatorias (sobrescriben las secciones citadas)

1. **El "universo de cuentas" en TODAS partes** (backfill §5.2, resolución de costo §4, compuerta §5.4, canario §6) = la **UNIÓN** de: `(3 slots) ∪ (DISTINCT Terminal.assignedMerchantIds del venue) ∪ (DISTINCT Payment.merchantAccountId histórico)`. Cuentas solo-en-terminal e inherited-del-org son de **primera clase**, no solo los slots.

2. **Modelo de consistencia (decisión — ver §12.4):** dos opciones —
   - **(a)** `VenueMerchantAccount` es la fuente de verdad y `assignedMerchantIds` debe ser un **subconjunto validado** (toda cuenta en cualquier terminal del venue tiene fila en el roster).
   - **(b) [recomendada]** **reemplazar el `String[]` sin FK por una tabla `TerminalMerchantAccount`** `{ terminalId FK, merchantAccountId FK, perTerminalOrder Int?, isDefault Boolean }`. Da FKs reales, un lugar para el default por terminal (`kioskDefaultMerchantId` actual), y elimina el drift.
   - **Invariante común (cualquiera de las dos):** *ninguna cuenta puede estar en una terminal sin estar en el roster del venue* (así siempre tiene precio). Se enforcea en el endpoint de asignación + Blumon auto-fetch + un checker periódico, y se extiende el guard de `deleteMerchantAccount()`.

3. **`priority` NO es ruteo.** La selección es **por terminal** (el cajero elige de `assignedMerchantIds` de ESA terminal; `kioskDefaultMerchantId` es por terminal). `priority` es **solo** orden de display/etiqueta y fuente del `accountType` legacy. Se borran las frases "el backend rutea por orden" (§0.4, §8.5). `deriveAccountType` se ancla a la **identidad de la cuenta** capturada en el backfill, NO al `priority` mutable (reordenar no debe re-mapear el pricing de otra cuenta).

4. **Backfill (§5.2) desde la UNIÓN.** priority 0/1/2 = slots; 3+ = solo-terminal/solo-pago. **Cada cuenta necesita su fila de pricing** (o decisión auditada de heredar PRIMARY) — backfillear sin pricing solo mueve el fallback silencioso una capa abajo. Query pre-migración obligatorio: por venue, `(unión de assignedMerchantIds) − (cuentas en slots)` → reportar cualquier resultado no vacío antes de continuar.

5. **Compuerta recompute-diff (§5.4) re-especificada:** itera **TODOS** los pagos elegibles del venue por su `Payment.merchantAccountId` real, **sin filtro de slot/accountType** (NO construir sobre `rateCorrectionScope`/`buildScopeWhere`). Bucketea y **se DETIENE** ante: (a) cuenta sin fila de pricing, (b) cuenta no-slot, (c) pago con merchant null, (d) delta inexplicado. Un diff = 0 producido por doble fallback-PRIMARY en una cuenta no-modelada **NO** pasa.

6. **Canario (§6.5/§6.1) reforzado:** **≥2 terminales** con sets de cuentas distintos-pero-traslapados; cobrar con una cuenta priority≥1 **y** con una cuenta solo-en-terminal (si existe); y **assertar contra Postgres** que cada `TransactionCost.merchantAccountId` y `venuePricingStructureId` corresponden a la cuenta que de verdad cobró (no un fallback a PRIMARY). "Una tarjeta cobró en una terminal" **NO basta.**

7. **Pricing por-cuenta REQUERIDO para priority ≥ 3** (no existe `accountType` legacy para 3+; `deriveAccountType` solo está definido para 0/1/2). El wizard **bloquea activar** una 4ta+ cuenta hasta que tenga su fila de pricing — o se documenta la decisión deliberada de cobrarla a tasa PRIMARY. (Corrige §4 paso 3.2 y la afirmación de §7 de que el pricing por-cuenta es "opcional".)

8. **Resolución serial legacy (Tier 2):** `resolveBlumonSerialToMerchantId` (`payment.tpv.service.ts:1229-1267`) debe buscar en la **lista completa / assignedMerchantIds**, no solo en los 3 slots — si no, un APK viejo que manda `blumonSerialNumber` de una cuenta solo-en-terminal se mis-resuelve a null/PRIMARY. TDD: APK legacy paga con serial de una cuenta priority-3 → resuelve a esa cuenta.

9. **Herencia org-level explícita:** el resolver matchea `payment.merchantAccountId` contra `(venue VenueMerchantAccount) ∪ (org OrganizationMerchantAccount cuando el venue hereda)`; `getEffectivePricing` gana un path por `merchantAccountId` (venue per-account → org per-account → accountType legacy → PRIMARY), simétrico al lado venue. Precedencia de selección: `terminal assignment > venue list > org list`. TDD para cuenta org-heredada priority-3.

10. **Auditabilidad:** nuevo flag `TransactionCost.pricingFallbackUsed Boolean @default(false)` → el fallback a PRIMARY se vuelve contable por-pago en la compuerta y dashboards (fuga de margen **visible**, no silenciosa).

> **Resumen de la corrección:** el modelo correcto reconoce **dos ejes** que llegan a `MerchantAccount` (slots y terminales), exige que **toda cuenta cobrable esté en el roster con su precio**, y hace que backfill + resolver + compuerta + canario operen sobre la **unión** de cuentas, no solo los slots.

---

## 1.6 Decisión §12.4 RESUELTA (opción b) + ajustes finales de la re-auditoría (2026-06-17)

La re-auditoría (3 lentes) dio **`minor-fixes-then-ready`** — sin huecos críticos. **Decisión §12.4: opción (b)** — tabla real `TerminalMerchantAccount`. Esta sección resuelve la decisión y los ajustes menores; **sobrescribe** lo que la contradiga en el cuerpo.

### 1.6.1 Modelo terminal↔cuenta (opción b)

```prisma
model TerminalMerchantAccount {
  id                String   @id @default(cuid())
  terminalId        String
  terminal          Terminal @relation(fields: [terminalId], references: [id], onDelete: Cascade)
  merchantAccountId String
  merchantAccount   MerchantAccount @relation(fields: [merchantAccountId], references: [id], onDelete: Restrict)
  perTerminalOrder  Int?     // orden en el selector de ESA terminal
  isDefault         Boolean  @default(false) // reemplaza Terminal.kioskDefaultMerchantId
  active            Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([terminalId, merchantAccountId])
  @@index([merchantAccountId])
}
```
- Reemplaza `Terminal.assignedMerchantIds String[]` (sin FK). El array se **conserva** durante la transición (dual-write) y se elimina en la etapa contract, igual que los slots.
- `isDefault` absorbe `kioskDefaultMerchantId` (el default vive por terminal, NO en `priority`).
- Tiene su **propio carril expand/backfill/dual-read/contract** en §5, en paralelo a `VenueMerchantAccount`: backfill desde `assignedMerchantIds` (y desde la herencia de slots para terminales con array vacío).

### 1.6.2 Invariante + enforcement (el corazón de la corrección)

**Invariante:** toda fila de `TerminalMerchantAccount` DEBE tener su `VenueMerchantAccount` correspondiente (roster del venue) **con pricing activo**.

Enforcement en **cada** escritor de cuentas-en-terminal (enumerados por la re-auditoría): `superadmin/terminal.controller.ts`, `superadmin/merchantAccount.controller.ts` (×4 incl. Blumon auto-fetch :883-890), `onboarding.controller.ts:375`, `dashboard/terminal-migration.controller.ts`. Cada uno, al asignar, **upsert/valida primero** la fila de roster (+ pricing). Más: un **job reconciliador periódico** y el guard de `deleteMerchantAccount()` extendido a ambas tablas. **Test de regresión:** un Blumon auto-fetch posterior al backfill **no puede** crear una cuenta cobrable sin precio.

### 1.6.3 Ajustes de consistencia (resuelven los hallazgos menores)

1. **§4 paso 1 (reescrito):** el resolver matchea `payment.merchantAccountId` contra la **unión** = `(venue roster) ∪ (org roster si hereda) ∪ (cuentas históricas)`, precedencia **terminal > venue > org**.
2. **§7 corregido:** pricing por-cuenta **REQUERIDO** para `priority ≥ 3` (no "opcional") — no hay `accountType` legacy para ellas.
3. **Ancla de accountType:** nuevo campo persistido **inmutable** `VenueMerchantAccount.legacySlotType AccountType?` (set una vez en backfill: 0→PRIMARY,1→SECONDARY,2→TERTIARY,3+→null). El pricing legacy se resuelve por este campo, NO por `priority`. Se **elimina** `@@unique([venuePaymentConfigId, priority])` (priority = orden de display; se maneja a nivel app), evitando el hazard de reordenar.
4. **Unicidad de pricing (§3.2):** se **retiene** `@@unique([venueId, accountType, effectiveFrom])` para filas legacy + se agrega **índice único parcial** `(merchantAccountId, effectiveFrom) WHERE merchantAccountId IS NOT NULL` para las por-cuenta.
5. **`TransactionCost.pricingFallbackUsed Boolean @default(false)`** se agrega al schema (§3) y a la **etapa 1 expand** (§5) — migración aditiva, no bullet huérfano.
6. **Merchant null:** distinguir **null intencional** (manual/QR, `source ≠ TPV`) de **esperado-pero-no-resuelto** (TPV/AVOQADO con merchant null → `pricingFallbackUsed=true`, la compuerta lo cuenta como anomalía).
7. **`getEffectivePricing` gana parámetro `merchantAccountId`** (hoy solo filtra por `accountType`): venue per-account → org per-account → accountType legacy → PRIMARY.
8. **Canario (+1 aserción):** cobrar la **misma cuenta desde 2 terminales** y assertar mismo `venuePricingStructureId` y tasa.
9. **`heartbeat`** (conteo de versión de config): es **count-only**; el fallback a slots es aceptable — marcado como no-crítico.
10. **In-flight durante cutover:** el backfill (etapa 2) **completa y se verifica no-vacío/todo-priceado** ANTES de cambiar lecturas (etapa 3); dual-read prefiere roster con fallback a columnas legacy hasta el contract.

### 1.6.4 Fuera de alcance (se agrega a §13)
- **E-commerce:** pagos con `Payment.ecommerceMerchantId` set (Stripe Connect / Blumon e-commerce, `merchantAccountId` null) **quedan fuera** del roster, resolver y compuerta. Se filtran explícitamente (`source = TPV/terminal` + `merchantAccountId IS NOT NULL`).

---

## 2. Objetivos y NO-objetivos (YAGNI)

**Objetivos**
- Un venue (y una organización) puede tener **N cuentas de merchant** (no solo 3).
- **Cada cuenta** puede tener su **propia tarifa al venue** (pricing por merchantAccount).
- **Cero regresión** en la capacidad de cobrar de la TPV.
- Ambos portales de superadmin actualizados en lockstep.
- MCP en lockstep (solo lectura).

**NO-objetivos (explícitamente fuera, por YAGNI — el driver es "headroom", no una necesidad urgente)**
- Cost-routing / BIN-routing / failover automático entre cuentas. (Queda el campo `routingRules` JSON como escape hatch futuro, sin construir lógica.)
- Cambios a los POS Android/iOS.
- Forzar a venues existentes a migrar su UX — el cambio es aditivo.

---

## 3. Modelo de datos (el corazón)

### 3.1 Nueva tabla de cuentas (reemplaza los 3 FK)

```prisma
model VenueMerchantAccount {
  id                   String   @id @default(cuid())
  venuePaymentConfigId String
  venuePaymentConfig   VenuePaymentConfig @relation(fields: [venuePaymentConfigId], references: [id], onDelete: Cascade)
  merchantAccountId    String
  merchantAccount      MerchantAccount    @relation(fields: [merchantAccountId], references: [id], onDelete: Restrict)
  priority             Int      // 0 = Principal, 1 = Secundaria, 2 = Terciaria, 3+ = adicionales
  label                String?  // override opcional de etiqueta
  active               Boolean  @default(true)
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@unique([venuePaymentConfigId, merchantAccountId])
  @@unique([venuePaymentConfigId, priority])
  @@index([merchantAccountId])
}
```
Más un gemelo `OrganizationMerchantAccount` para el nivel organización (misma forma, FK a `OrganizationPaymentConfig`).

- **`priority`** es el "número de orden" de la lista. 0/1/2 mapean a los antiguos PRIMARY/SECONDARY/TERTIARY (para compatibilidad de pricing durante la transición). 3+ son cuentas nuevas.
- `VenuePaymentConfig` conserva `routingRules` y `preferredProcessor`. **Las columnas `primary/secondary/tertiaryAccountId` se MANTIENEN durante toda la transición** (dual-write) y solo se eliminan en la etapa final ("contract"), que es opcional y separada.

### 3.2 Pricing por cuenta (cierra la asimetría)

```prisma
model VenuePricingStructure {
  // ... campos existentes ...
  accountType       AccountType?  // ahora NULLABLE — legacy. Se conserva para filas viejas.
  merchantAccountId String?       // NUEVO — cuando está set, el pricing aplica a ESTA cuenta
  merchantAccount   MerchantAccount? @relation(fields: [merchantAccountId], references: [id], onDelete: Restrict)
  // ...
  @@index([merchantAccountId])
}
```
Igual para `OrganizationPricingStructure`. El `enum AccountType` **se conserva definido** (filas viejas lo usan); las filas nuevas usan `merchantAccountId`. Queda simétrico con `ProviderCostStructure`.

> **Constraint de unicidad:** durante la transición conviven filas con `accountType` (legacy) y con `merchantAccountId` (nuevo). La unicidad por-cuenta `(merchantAccountId, effectiveFrom)` se valida **a nivel app** durante la transición y se promueve a `@@unique` en la etapa "contract". Detalle de implementación en el plan, no aquí.

---

## 4. Resolución de costo/comisión (la parte delicada — incluye el fix crítico)

`createTransactionCost` queda así (orden de resolución):

1. **Resolver la cuenta que cobró** — match `payment.merchantAccountId` contra la **lista completa** del venue (`VenueMerchantAccount`; durante transición, también contra las 3 columnas legacy). Devuelve `merchantAccount` + `priority`.
   - 🔴 **Fix crítico (lo que cazó la revisión adversarial):** hoy esto solo mira las 3 columnas, así que una cuenta #4 caería en PRIMARY (= bug de amaena otra vez). Con la lista completa, la #4 se atribuye bien.
2. **Costo del proveedor** — por `merchantAccount.id` (ya es por cuenta). Si falta, fallback al de PRIMARY + warn (hardening existente).
3. **Precio al venue** — orden de preferencia:
   1. Pricing por-cuenta (`VenuePricingStructure.merchantAccountId == merchantAccount.id`).
   2. Si no, legacy por accountType (`deriveAccountType(priority)` → PRIMARY/SECONDARY/TERTIARY).
   3. Si no, **fallback a PRIMARY** (hardening existente). Nunca produce "sin costo".
   - Cada path se loguea para visibilidad.
4. **Registrar `TransactionCost`** con la cuenta REAL (`merchantAccount.id`) → atribución correcta en todas las vistas.

Esto hace que B sea **superset y backward-compatible**: filas viejas siguen funcionando por accountType, nuevas por merchantAccountId, y el hardening de amaena queda dentro.

---

## 5. Plan de migración — expand/contract en 5 etapas (reversible)

> Principio: **nunca un paso destructivo sin antes haber verificado contra dinero real.** Cada etapa es un deploy separado y reversible hasta la etapa 5.

| Etapa | Qué hace | Reversible | Riesgo |
|-------|----------|------------|--------|
| **1. Expand (aditivo)** | Crear `VenueMerchantAccount` + `OrganizationMerchantAccount`; agregar `merchantAccountId?` a las pricing structures. Nada se borra, nada se lee aún. | ✅ git revert + drop tablas | Nulo |
| **2. Backfill** | Por cada config: insertar filas priority 0/1/2 desde primary/secondary/tertiaryAccountId. Por cada `VenuePricingStructure`: resolver accountType → la cuenta de ese slot → set `merchantAccountId`. | ✅ datos nuevos, columnas viejas intactas | Bajo |
| **3. Dual-read + dual-write** | Lecturas usan la lista nueva, con fallback a columnas viejas si falta. Escrituras actualizan AMBOS (lista + columnas legacy 0/1/2) vía **un solo método de servicio**. Sin cambio de comportamiento observable. | ✅ | Bajo |
| **4. 🚦 Compuerta recompute-diff (la red de seguridad)** | Correr la nueva lógica de pricing contra **TODOS los pagos históricos** y assertar que la comisión calculada **== la guardada** (para cuentas que no deberían cambiar). Si **una sola** difiere sin explicación → STOP. | ✅ (no muta nada) | — |
| **5. Contract (destructivo, OPCIONAL/diferible)** | Solo cuando el diff sale limpio: promover `@@unique([merchantAccountId, effectiveFrom])`, dejar de escribir las columnas legacy, y eventualmente droppearlas. | ⚠️ rollback = re-derivar columnas desde priority (scriptable) | El único paso de un solo sentido |

**Nota:** se puede vivir indefinidamente en la etapa 3-4 (lista + columnas coexistiendo). La etapa 5 se hace cuando haya confianza total; no es urgente.

---

## 6. 🔴 Seguridad de la TPV (PRIORIDAD #1 — tu miedo principal)

**Garantías (verificadas en código):**

1. **El camino del cobro NO se toca.** El flujo terminal → tarjeta → `recordPayment` es independiente del modelo de cuentas/pricing.
2. **El cálculo de comisión corre DESPUÉS del cobro** y está en `try/catch` en ambos call sites (`payment.tpv.service.ts:1776-1809` y `2500-2508`) con el comentario *"Don't fail the payment if TransactionCost creation fails"*. Aunque truene, **el cobro no se cae**.
3. **La TPV ya es N-ready** — lee `merchantAccounts: List<MerchantAccountDto>` de tamaño arbitrario y enruta por `merchantAccountId`. **No necesita release.**
4. **Único endpoint TPV-facing que cambia:** `getVenueMerchantAccounts` (la lista de cuentas que se le manda a la terminal). Cambia su origen (lista en vez de 3 columnas) pero **mantiene todos los campos** que las apps viejas usan: `id`, `accountType` (sintetizado desde priority: 0→PRIMARY, 1→SECONDARY, 2→TERTIARY, 3+→valor seguro), `displayName`, `providerCode`, `credentials`, `active`. **Nada se quita ni se renombra** (regla de plataforma).
5. **Prueba canario obligatoria:** antes de soltar a todos, en **una terminal de prueba** (o venue demo): cargar cuentas + **cobrar una tarjeta real** de punta a punta. Solo si cobra bien → rollout. Si no → revert.

**Conclusión:** el riesgo extra de B sobre C vive 100% en el área de comisiones (post-cobro, recuperable). Para la capacidad de cobro de la TPV, **B y C son igual de seguros.**

### 6.1 Compatibilidad con apps VIEJAS de TPV (verificado forensemente, 2026-06-17)

Pregunta clave: una APK vieja ya instalada en la calle, ¿se rompe al recibir N cuentas / un `accountType` nuevo / campos nuevos? **Evidencia → NO.**

| Hecho (leído del código real) | Evidencia | Implicación |
|---|---|---|
| La TPV deserializa con **Gson** con config por defecto (ignora keys desconocidas) | `core/di/NetworkModule.kt:189-193` (GsonConverterFactory sin builder custom) | Campos nuevos en la respuesta → ignorados, no truenan |
| `MerchantAccountDto` **NO tiene campo `accountType`** | `core/data/network/dto/TerminalConfigDto.kt:182-232` | La TPV **nunca lee** accountType → mandar "SLOT_4" es irrelevante para ella |
| `providerCode` es **String nullable** (enum solo en domain con `else -> BLUMON`) | `TerminalConfigDto.kt:189`, `Mapper.kt:40-43` | Valor de provider desconocido → default seguro, no truena |
| La lista se recorre con `.map/.filter/.forEach`, **sin índices [0][1][2]** | `MerchantRepositoryImpl.kt:64,75,89`, `MerchantSelectionContent.kt:123` | 8 cuentas → sin problema |
| El DTO solo ha evolucionado **agregando campos opcionales** | git log de `TerminalConfigDto.kt` | Patrón establecido = aditivo |

**Corrección al §6 punto 4:** la síntesis de `accountType` para 3+ importa SOLO para los clientes REST (dashboard / avoqado-superadmin) que sí lo leen — **la TPV lo ignora** (no existe el campo en su DTO).

**Reglas obligatorias (do-no-harm) para no romper apps viejas:**
1. **Nunca** quitar ni renombrar un campo de la respuesta.
2. **Nunca** volver `providerCode` (ni ningún campo que la app lea) un enum estricto sin `else -> default`.
3. Todo campo nuevo: **opcional con default**.
4. No asumir tamaño de lista en ningún cliente (la TPV ya cumple).

**Cómo lo PROBAMOS (no adivinamos):** canario con **APK VIEJO real** (la versión en la calle, hoy versionCode 83 / v2.5.7), apuntado a un venue con 8 cuentas, **cobrando una tarjeta real**. Solo si la app vieja carga las cuentas y cobra → rollout.

**Backstop disponible (no necesario según la evidencia):** la TPV manda `X-App-Version-Code` (`AuthInterceptor.kt:42-43`) y el server tiene `tpv-version-gate.middleware.ts` que lo lee. Si alguna vez se necesitara, el endpoint puede mandar a apps `< vN` solo las 3 primeras cuentas (branch por header). NO se planea usar para este cambio.

---

## 7. Contrato REST (aditivo, backward-compatible)

Dos capas, ambas se mantienen compatibles:
- **Dashboard:** `/api/v1/dashboard/venues/:venueId/payment-config` y `.../merchant-accounts`, `.../pricing-structures`.
- **Superadmin:** `/api/v1/superadmin/venue-pricing/*` y `/api/v1/superadmin/merchant-accounts/*`.

**Regla:** en cada respuesta de config, devolver **ambos**:
- Los 3 campos legacy `primaryAccountId/secondaryAccountId/tertiaryAccountId` (derivados de priority 0/1/2) — para clientes viejos.
- Un campo nuevo `merchantAccounts: Array<{ merchantAccountId, priority, label, active, accountType(derivado) }>` — para clientes nuevos.

En POST/PUT: aceptar **ambos** formatos. Si llega el formato de 3 campos → convertir a lista internamente (no rompe clientes viejos). Si llega `merchantAccounts` → usarlo. Pricing endpoints aceptan `merchantAccountId` opcional; si no viene, comportamiento legacy por `accountType`.

Nunca se incluye `credentialsEncrypted` ni secretos en respuestas (excepto el endpoint superadmin de fetch de credenciales, auditado).

---

## 8. Cambios por frontend

### 8.1 avoqado-web-dashboard — **portal legacy superadmin** (SÍ se actualiza)
`src/pages/Superadmin/`:
- `MerchantAccounts.tsx`, `VenuePricing.tsx`, `SettlementConfigurations.tsx`, `OrganizationManagement.tsx`
- `components/VenuePaymentConfigCard.tsx`, `VenuePricingStructureDialog.tsx`, `MerchantAccountDialog.tsx`
- `components/merchant-accounts/` (todo el `merchant-setup-panel`): `SlotCard.tsx`, `PricingCard.tsx`, `useMerchantBundle.ts`, `useSetupReducer.ts`, `assemblePayload.ts`, `types.ts`, `PaymentSetupWizard.tsx`, `wizard-steps/VenuePricingStep.tsx`, `AssignAccountToVenueDialog.tsx`
**Cambio:** reemplazar el modelo de 3 slots (`SlotCard` × 3, literales `'PRIMARY'|'SECONDARY'|'TERTIARY'`) por una lista dinámica de cuentas con `priority` + botón "agregar cuenta". Pricing por cuenta.

### 8.2 avoqado-web-dashboard — pantallas venue-facing
`src/pages/Venue/VenuePaymentConfig.tsx`, `components/VenuePricingDialog.tsx`, `PricingStructuresDisplay.tsx`, `CostStructuresDisplay.tsx` → iterar la lista en vez de 3 slots fijos.

### 8.3 avoqado-superadmin — **portal nuevo** (SÍ se actualiza, en paralelo)
`src/features/merchants/`: `types.ts` (`AccountSlot`), `api.ts`, `MerchantDetailPage.tsx`, `EditVenuePricingDrawer.tsx`, `AngelPaySetupDrawers.tsx`.
`src/features/venues/`: `api.ts` (`VenuePaymentConfig`), `VenuePaymentConfigPage.tsx` (`MAX_SLOTS=3`, `SLOT_LABELS`).
**Cambio:** mismo patrón — lista dinámica con `priority`, label `getSlotLabel(index)` ('Principal'/'Secundaria'/'Terciaria'/'Cuenta 4'…), pricing por cuenta. Mantener la `accountType` derivada para compatibilidad.

> Ambos portales consumen el MISMO contrato REST aditivo (§7), así que se pueden migrar con el mismo modelo mental y en paralelo.

### 8.4 avoqado-tpv — **transparente**
Solo recibe la lista más larga vía el endpoint existente. Cero cambios de código, cero release. (Ver §6.)

### 8.5 avoqado-android / avoqado-ios — **fuera de alcance**
No consumen cuentas de merchant. El backend resuelve la cuenta (la selección real es **por terminal** — ver §1.5). Cero cambios.

---

## 9. MCP (lockstep, solo lectura)

Hoy el MCP no expone merchant/pricing/config. Agregar tools de **solo lectura** (escrituras se quedan superadmin-only, como `planAdmin`):
- `list_venue_merchant_accounts(venueId)` → cuentas + priority + provider + estado.
- `get_venue_payment_config(venueId)` → asignación + routingRules + preferredProcessor.
- `list_venue_pricing(venueId, merchantAccountId?)` → tarifas por cuenta.
- `settlement_detail_by_merchant(venueId, startDate, endDate, merchantAccountId?)` → neto por cuenta.
Actualizar docstrings de `daily_sales`, `settlement_calendar`, `export_sales_summary` para mencionar el breakdown por cuenta.

---

## 10. Estrategia de pruebas
- **TDD** en server: resolución de cuenta por lista (incl. cuenta #4), pricing por-cuenta → legacy → fallback PRIMARY, dual-read/dual-write paridad (la lista nunca diverge de las columnas 0/1/2).
- **Compuerta recompute-diff** (§5 etapa 4): el gran test contra dinero real.
- **Canario TPV** (§6): cobro real end-to-end en una terminal.
- E2E dashboard + superadmin: crear venue con 4+ cuentas, asignar pricing por cuenta, ver el desglose correcto.
- Regresión de no-regresión: los 18 pagos ya correctos de amaena no cambian.

---

## 11. Secuencia de rollout (orden importa)
1. Etapa 1-2 (expand + backfill) a server prod — invisible.
2. Etapa 3 (dual-read/write) — invisible, reversible.
3. Etapa 4 (recompute-diff) — verificar; si limpio, continuar.
4. Frontends (ambos portales) detrás del contrato aditivo — se pueden soltar cuando estén listos, sin bloquear el backend.
5. Canario TPV.
6. Etapa 5 (contract) — diferible, cuando haya confianza total.

Cada paso reversible hasta el 6.

---

## 12. Decisiones abiertas para Jose
1. **Etiquetas de las cuentas 4+:** ¿numéricas ("Cuenta 4", "Cuenta 5") o con nombre libre (`label`)? (Recomiendo numéricas por defecto + `label` opcional.)
2. **¿Cuándo (o si) hacer la etapa 5 (contract)?** Se puede diferir indefinidamente. (Recomiendo diferir hasta tener varios venues con 4+ cuentas en uso.)
3. **¿Tope blando?** Aunque el modelo es ilimitado, ¿ponemos un límite de UX (p.ej. avisar a partir de 8) para no saturar la pantalla de la terminal? (Recomiendo sí, solo aviso.)
4. **✅ DECIDIDO (2026-06-17): opción (b)** — tabla real `TerminalMerchantAccount` con FKs + default por terminal. Modelo, invariante y enforcement especificados en §1.6. (Era la decisión más importante de la auditoría: de ella depende que ninguna cuenta cobre sin precio.)

---

## 13. Fuera de alcance (explícito)
- Cost-routing / BIN-routing / failover automático (queda `routingRules` JSON sin lógica).
- Cambios a POS Android/iOS.
- Migración forzada de la UX de venues existentes.
- Backfill del `merchantAccountId` histórico en `TransactionCost` para la vista interna de costos (es un ítem aparte ya identificado; no bloquea esto).
