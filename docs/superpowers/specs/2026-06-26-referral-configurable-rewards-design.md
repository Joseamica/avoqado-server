# Diseño — Programa de Referidos: premios configurables por nivel

**Fecha:** 2026-06-26 **Autor:** Jose Antonio Amieva (con Claude) **Estado:** Borrador v5 (4 rondas de auditoría Codex incorporadas — ver
§15) **Repos afectados:** `avoqado-server` (núcleo), `avoqado-web-dashboard` (UI), `avoqado-tpv` (verificar auto-apply), presentación de
ventas

---

## 1. Contexto

El programa de referidos **ya existe y está en producción** (migración `20260529012230_add_referral_program`, 29-may-2026; venue `Mindform`
con 1,941 clientes). Hoy soporta:

- Captura del referido en el **cobro del TPV** (`features/referrals/` en `avoqado-tpv`, v2.5.2+).
- Conteo automático: al pagar el referido, `onOrderPaid` incrementa `Customer.referralCount`, evalúa nivel y emite premio.
- 3 niveles con umbrales configurables y **un único tipo de premio**: cupón de porcentaje de un solo uso (`emitTierReward` → `Discount` +
  `CustomerDiscount` + `CouponCode`).
- Notificación por **correo** (Resend) + link manual de WhatsApp.
- Dashboard: configuración (`ReferralsSettings.tsx`), Hall of Fame, tabla de referidos, ficha por cliente (`ReferralCard.tsx`).

**Limitación que motiva este diseño:** el premio es siempre "cupón %". El PDF de Mindform (y otros venues) requiere otros tipos de premio y
un **Nivel 3 con DOS premios a la vez** (5% permanente + 1 producto gratis recurrente).

## 2. Objetivo

Hacer el **tipo de premio configurable por nivel**, **genérico para todos los venues** (no hardcodeado para Mindform), sin volver la UI una
pesadilla, exponible por **dashboard** y **MCP**, y **sin romper el sistema vivo**.

### No-objetivos (YAGNI)

- Número variable de niveles. **3 niveles fijos.**
- Constructor genérico de programas de lealtad.
- Producto gratis automático/recurrente en v1 (ver §9).

## 3. Decisiones de diseño

| #   | Decisión                                                                                                                                                                                                                                                                 | Razón                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Tipo de premio configurable por nivel, **3 niveles fijos**                                                                                                                                                                                                               | Escala sin volverse genérico                                                                                                                                   |
| D2  | Un nivel puede tener **varios premios**                                                                                                                                                                                                                                  | Nivel 3 = % permanente + producto gratis                                                                                                                       |
| D3  | **Separar CONFIG de EMISIÓN**: `ReferralTierReward` (qué se ofrece) + `ReferralRewardGrant` (qué se entregó a quién)                                                                                                                                                     | Auditar y revocar N premios por nivel (Codex [P1])                                                                                                             |
| D4  | UX: **defaults pre-cargados + revelación progresiva**                                                                                                                                                                                                                    | El 95% no toca nada                                                                                                                                            |
| D5  | Config por **dashboard y MCP**, sobre el MISMO servicio                                                                                                                                                                                                                  | No pagar el costo dos veces                                                                                                                                    |
| D6  | `FREE_PRODUCT` **100% manual en v1** (no emite cupón)                                                                                                                                                                                                                    | El canje de cupones del TPV ignora `scope=ITEM` → un cupón COMP comp-earía la orden entera (Codex [P1]). Manual lo esquiva                                     |
| D7  | Emisión **transaccional e idempotente**                                                                                                                                                                                                                                  | Hoy hay un race: mintea/cuenta antes de actualizar el tier (Codex [P1])                                                                                        |
| D8  | Refund/revocación **reescrito alrededor de grants**                                                                                                                                                                                                                      | El actual revoca un solo discount y solo entiende `CouponRedemption`, no `OrderDiscount` (permanentes) (Codex [P1])                                            |
| D9  | WhatsApp automático: **v2** (correo en v1)                                                                                                                                                                                                                               | Depende de plantilla aprobada por Meta; no bloquear v1                                                                                                         |
| D10 | Migración **compatible hacia atrás** + mover TODOS los lectores/escritores de los campos planos en el mismo deploy                                                                                                                                                       | Los `tier{N}RewardPercent` siguen vivos en emisión, activate/update, schemas REST, controller y reads (Codex [P1])                                             |
| D11 | **Idempotencia a nivel de ORDEN y de DESBLOQUEO**: partial-unique en `Referral(qualifyingOrderId)` para PENDING + tabla `ReferralTierUnlock(customerId, tierLevel)` + CAS por orden. Un nivel se gana **una vez de por vida** (refund revoca, NO re-otorga al re-cruzar) | El CAS por `referral.id` no basta: pueden existir varios referrals PENDING para una orden y `onOrderPaid` se invoca por orderId → doble-conteo (Codex v3 [P1]) |

## 4. Modelo de datos

### 4.1 Enums

```prisma
enum ReferralRewardType {
  PERCENT_COUPON      // Cupón de % de un solo uso (comportamiento actual)
  PERMANENT_DISCOUNT  // % automático permanente en todas las compras
  FREE_PRODUCT        // 1 unidad gratis de un producto del catálogo (v1: manual)
}

enum ReferralRewardRecurrence {
  ONE_TIME   // Default. Aplica a todos los tipos.
  MONTHLY    // Solo relevante para FREE_PRODUCT (el circuito mensual). v1 = manual; v2 = cron.
}

enum ReferralGrantStatus {
  ISSUED            // Emitido y activo (cupón sin canjear / permanente vigente)
  REDEEMED          // Cupón canjeado (o permanente aplicado al menos una vez)
  REVOKED           // Revertido por refund (incl. permanente ya consumido sin clawback)
  MANUAL_PENDING    // FREE_PRODUCT manual: pendiente de que el staff lo entregue
  MANUAL_FULFILLED  // FREE_PRODUCT manual: entregado por el staff
}
```

### 4.2 `ReferralTierReward` — CONFIG (qué premios ofrece cada nivel)

Un row por premio configurado. El Nivel 3 de Mindform tendría 2 rows.

```prisma
model ReferralTierReward {
  id        String @id @default(cuid())
  configId  String
  config    ReferralProgramConfig @relation(fields: [configId], references: [id], onDelete: Cascade)

  tierLevel  Int                      // 1 | 2 | 3
  rewardType ReferralRewardType
  recurrence ReferralRewardRecurrence @default(ONE_TIME)

  rewardPercent   Decimal? @db.Decimal(5, 2) // PERCENT_COUPON / PERMANENT_DISCOUNT
  rewardProductId String?                     // FREE_PRODUCT (validar mismo venue en servicio)
  rewardProduct   Product? @relation("ReferralRewardProduct", fields: [rewardProductId], references: [id], onDelete: SetNull)
  rewardQuantity  Int @default(1)

  // Soft-delete / versionado: "editar" un nivel que YA emitió grants desactiva
  // la fila vieja (active=false) y crea una nueva; nunca se borra físicamente.
  // Así ReferralRewardGrant.tierRewardId (NON-NULL, onDelete: Restrict) nunca
  // queda huérfano y la idempotencia (§4.3) se sostiene.
  active Boolean @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  grants ReferralRewardGrant[]

  @@index([configId, tierLevel])
}
```

### 4.3 `ReferralRewardGrant` — EMISIÓN (qué premio se entregó a qué cliente) **[NUEVO]**

Un row por premio efectivamente emitido a un referidor al cruzar un nivel. Liga el premio configurado, el referral que lo gatilló, y los
artefactos emitidos (`Discount`/`CouponCode`). Base para auditar, revocar y (v2) renovar.

```prisma
model ReferralRewardGrant {
  id      String @id @default(cuid())
  venueId String
  venue   Venue  @relation(fields: [venueId], references: [id], onDelete: Cascade)

  customerId String   // el referidor que recibe el premio
  customer   Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)
  tierLevel  Int      // 1 | 2 | 3
  referralId String?  // el Referral cuyo PAID desbloqueó el tier
  referral   Referral? @relation(fields: [referralId], references: [id], onDelete: SetNull)

  // Snapshot del config al momento de emitir (sobrevive a cambios de config)
  tierRewardId    String   // NON-NULL — la idempotencia (unique abajo) lo exige
  tierReward      ReferralTierReward @relation(fields: [tierRewardId], references: [id], onDelete: Restrict)
  rewardType      ReferralRewardType
  rewardPercent   Decimal? @db.Decimal(5, 2)
  rewardProductId String?
  rewardQuantity  Int @default(1)

  // Artefactos emitidos (null para FREE_PRODUCT manual)
  discountId   String?
  discount     Discount? @relation(fields: [discountId], references: [id], onDelete: SetNull)
  couponCodeId String?

  status                  ReferralGrantStatus @default(ISSUED)
  revokedAt               DateTime?
  revokeReason            String?
  fulfilledAt             DateTime? // FREE_PRODUCT manual
  fulfilledByStaffVenueId String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // 🔑 Defensa secundaria de idempotencia: un grant por (customer, tier, reward).
  // tierRewardId NON-NULL (Postgres permite múltiples NULLs en un UNIQUE) (Codex v2 [P1]).
  @@unique([customerId, tierLevel, tierRewardId])
  @@index([venueId])
  @@index([customerId])
  @@index([referralId])
  @@index([status])
}
```

### 4.3b `ReferralTierUnlock` + idempotencia a nivel de orden **[NUEVO, Codex v3]**

Dos garantías de DB que el CAS por `referral.id` no daba:

```prisma
// Un desbloqueo de nivel por cliente, de por vida. El INSERT aquí es el guard
// idempotente PRIMARIO del desbloqueo: si ya existe, el nivel ya se otorgó →
// skip toda la emisión (independiente de qué premios tenga la config ahora).
model ReferralTierUnlock {
  id                   String   @id @default(cuid())
  customerId           String
  customer             Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)
  tierLevel            Int
  unlockedByReferralId String?
  unlockedAt           DateTime @default(now())

  @@unique([customerId, tierLevel]) // un nivel, una vez de por vida
  @@index([customerId])
}
```

Además, en `Referral`: **partial unique index** sobre `qualifyingOrderId` para filas no terminales (PENDING/QUALIFIED), garantizando **un
solo referral por orden**. Esto cierra el hueco order-level: hoy `captureReferral` hace `referral.create` sin unicidad y `onOrderPaid` se
invoca por `orderId`, así que dos ejecuciones podían reclamar referrals PENDING distintos de la misma orden (Codex v3 [P1]).
`captureReferral` maneja el conflicto como idempotente (no duplica).

**Política de `qualifyingOrderId` (Codex v4 [P2]):** el partial-unique no constriñe filas con `qualifyingOrderId = null` (Postgres permite
múltiples NULLs), y un referral sin orden **nunca califica** con el CAS por orden (§5). Hoy `captureReferral` permite omitir
`intendedOrderId` y `forceOverrideReferral` crea PENDING sin orden. Decisión v1: la **captura calificante exige `qualifyingOrderId`** (el
TPV ya lo manda en el cobro); para `forceOverrideReferral`, el referral se vincula a la **siguiente orden pagada del referido** vía un
attach explícito antes de `onOrderPaid`. El plan de implementación define el attach path.

### 4.4 Cambios a modelos existentes

- `ReferralProgramConfig`: se conservan umbrales, `newCustomerDiscountPercent`, `rewardCouponExpiryDays`, templates, `codePrefix`; se agrega
  `tierRewards ReferralTierReward[]`. Los `tier{1,2,3}RewardPercent` quedan **columnas muertas** tras la migración (§4.5).
- `Customer`, `Referral`, `Venue`, `Discount`: back-relations a `ReferralRewardGrant`. `Customer` también a `ReferralTierUnlock`.
- `Product`: back-relation `referralRewardConfigs ReferralTierReward[] @relation("ReferralRewardProduct")`. **El FK no fuerza same-venue** →
  el servicio valida `Product.venueId === config.venueId` (Codex [P2]).
- **Schema map:** registrar `ReferralTierReward`, `ReferralRewardGrant` y `ReferralTierUnlock` en `MODEL_TO_DOMAIN`
  (`scripts/generate-schema-map.ts`) y regenerar `docs/SCHEMA_MAP.md` en el mismo commit.

### 4.5 Migración (backward-compatible) + retiro de campos planos

1. **Migración de datos (en este orden):** a. Por cada `ReferralProgramConfig`, crear 3 `ReferralTierReward` (`PERCENT_COUPON/ONE_TIME`,
   `rewardPercent = tier{N}RewardPercent`). Cero cambio de comportamiento. b. **PREFLIGHT obligatorio antes del partial-unique de
   `Referral`:** detectar filas PENDING/QUALIFIED que comparten un `qualifyingOrderId` no-null y resolverlas (void de los duplicados,
   conservar el más antiguo) ANTES de crear el índice — si no, `CREATE UNIQUE INDEX … WHERE status IN (…)` aborta la migración (Codex v4
   [P1]). c. **Backfill OBLIGATORIO y COMPLETO de `ReferralTierUnlock`:** por cada `Customer` con `referralTier` ≥ TIER_1, insertar una fila
   por CADA nivel ya alcanzado (un cliente en TIER_3 → filas de TIER_1, TIER_2 y TIER_3, no solo el actual). Sin esto, un cliente ya
   escalonado re-dispararía y recibiría grants de nuevo (Codex v4 [P1]).
2. **Mover TODOS los lectores/escritores en el MISMO deploy** (Codex [P1]). Lista completa (Codex v2 la amplió):
   - `emitTierReward` lee de `ReferralTierReward` — `referralQualification.service.ts:53`
   - `activateReferralProgram`/`updateReferralConfig` escriben la tabla — `referralProgram.service.ts:108,246`
   - schemas REST — `referrals.schemas.ts:12`
   - read de config del controller — `referrals.controller.ts:14` (getConfig)
   - `referralReads.service.ts:19` — hoy proyecta UN `rewardDiscount` por referral → debe leer los `ReferralRewardGrant` (varios)
3. Los `tier{N}RewardPercent` quedan como columnas muertas (sin lectores) hasta una migración de **borrado posterior** (no en este v1).

## 5. Emisión de premios (`emitTierReward` reescrito)

`onOrderPaid` corre **una sola transacción** (los callers ya lo invocan tras el commit del pago, fuera de otra tx). La idempotencia vive en
DB (claim por orden + unlock), no en un check en memoria (Codex v2/v3 [P1]):

```
tx:
  1. CLAIM atómico del referral, por ORDEN (compare-and-swap):
       UPDATE Referral SET status='QUALIFIED', qualifiedAt=now()
       WHERE qualifyingOrderId=orderId AND status='PENDING'
     → si rowcount = 0, ABORTAR (otra ejecución/reintento ya lo reclamó; no-op).
       El partial-unique en qualifyingOrderId (§4.3b) garantiza que esto reclama
       EXACTAMENTE un referral por orden — cierra el doble-conteo (Codex v3 [P1]).
  2. Customer.referralCount += 1 (misma tx; seguro por el claim).
  3. Recomputar tier. Si no cruzó un nivel nuevo → fin.
  4. GUARD de desbloqueo: INSERT ReferralTierUnlock(customerId, tierLevel).
       - conflicto (ya existe) → el nivel ya se otorgó de por vida → fin (no re-emite).
       - nuevo → continúa.
  5. Para cada ReferralTierReward ACTIVO del tier:
       createGrant(customerId, tierLevel, tierRewardId)   // unique non-null, defensa 2ª
       - nuevo → emitir el artefacto según rewardType (abajo) y enlazarlo al grant.
  6. Customer.referralTier / tierUnlockedAt en la MISMA tx.
  7. ActivityLog REFERRAL_TIER_UNLOCKED con la lista de grants.
```

Emisión por tipo:

| `rewardType`         | Qué emite                                                                                 | Estado grant     |
| -------------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| `PERCENT_COUPON`     | `Discount` (one-time, `scope=ORDER`) + `CustomerDiscount` + `CouponCode` (igual que hoy)  | `ISSUED`         |
| `PERMANENT_DISCOUNT` | `Discount` `isAutomatic=true`, sin `validUntil`/`maxUses` + `CustomerDiscount` permanente | `ISSUED`         |
| `FREE_PRODUCT` (v1)  | **Nada automático.** Solo el grant + notificación al staff                                | `MANUAL_PENDING` |

- **Idempotencia real (3 capas):** claim por orden (paso 1) + `ReferralTierUnlock` (paso 4) + unique de grant (paso 5). Webhooks/órdenes
  concurrentes no duplican ni conteo ni premios. El email sigue fire-and-forget fuera de la tx.
- **Un nivel se gana una vez de por vida.** El `ReferralTierUnlock` persiste aunque un refund revoque los premios → re-cruzar el umbral NO
  re-otorga.
- **FREE_PRODUCT v1 manual:** evita el bug del cupón COMP item-scope. El staff ve "cortesía pendiente" en la ficha y la marca
  `MANUAL_FULFILLED` al entregar. El automático es v2.

## 6. Refund / revocación (reescrito alrededor de grants)

`onOrderRefunded` busca los `ReferralRewardGrant` del referral/tier desbloqueado por la orden reembolsada y revoca **cada uno según su tipo
y estado** (Codex [P1]):

| Tipo                 | Cómo decide si revoca                                  | Acción                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERCENT_COUPON`     | `status=ISSUED` (no canjeado)                          | Desactiva `Discount`+`CouponCode`, grant → `REVOKED`. Si `REDEEMED` → no se revoca                                                                                                                                                            |
| `PERMANENT_DISCOUNT` | ¿Se usó? Mirar `OrderDiscount` (NO `CouponRedemption`) | Si no se aplicó → desactivar `Discount`/`CustomerDiscount`, grant → `REVOKED`. Si ya se aplicó → desactivar a futuro, sin clawback; grant → `REVOKED` con `revokeReason` ("permanente ya consumido") — NO se deja en `ISSUED` (Codex v2 [P2]) |
| `FREE_PRODUCT`       | `status=MANUAL_PENDING`                                | → `REVOKED`. Si `MANUAL_FULFILLED` → no se revoca                                                                                                                                                                                             |

El `ReferralTierUnlock` **no** se borra en el refund (política D11: el nivel no se re-otorga). Esto permite, por primera vez, revocar
**todos** los premios de un nivel.

## 7. Configuración: dashboard + MCP

Núcleo `referralProgram.service.ts` ampliado para aceptar premios por nivel y **validar**: % ≥ 0, umbrales ascendentes (ya existe),
`rewardProductId` pertenece al venue, coherencia tipo↔campos.

- **Dashboard** (`ReferralsSettings.tsx`): vista por defecto en lenguaje natural (valores pre-cargados, activar = 1 clic); "Editar nivel"
  con dropdown **Tipo de premio** + campos condicionales + "Agregar otro premio" (revelación progresiva). Reusa `PATCH /referrals/config`
  extendido.
- **MCP** (`src/mcp/tools/referrals.ts`, nuevo): `referral_status` + `configure_referral`, patrón calcado de `configure_loyalty`
  (`src/mcp/tools/loyalty.ts:128` — permiso + plan gate + service + `auditMcpWrite`). Guard `referral:configure`. Gate
  `planGateMessage(venueId, 'REFERRAL_PROGRAM', …)`. Registrar en `src/mcp/server.ts`. Cierra el hueco actual (no hay tools de referral en
  el customer MCP).

## 8. Aplicación del descuento permanente (dependencia cross-repo)

El motor de auto-descuento existe (`discountEngine.service.ts`: `getCustomerDiscounts` fuerza `isAutomatic`), **pero el pago no lo dispara
solo**: `payment.tpv.service.ts` solo finaliza cupones; el auto-apply vive en `POST /discounts/auto` y **depende de que el cliente TPV lo
invoque en el cobro** (Codex [P2]). **Tarea de verificación obligatoria:** confirmar que el flujo de cobro del TPV llama `/discounts/auto`
cuando la orden tiene `customerId`. Si no, el 5% permanente no se aplica → cambio en TPV (o auto-apply server-side en el pago). Bloquea la
entrega funcional del `PERMANENT_DISCOUNT`.

## 9. Alcance v1 vs v2

### v1 (este spec)

- Enums + `ReferralTierReward` + `ReferralRewardGrant` + `ReferralTierUnlock` + partial-unique en `Referral` + migración + schema map.
- `emitTierReward` transaccional/idempotente (claim por orden + unlock + grant non-null); refund por grants.
- Tipos: `PERCENT_COUPON` (auto), `PERMANENT_DISCOUNT` (auto, sujeto a §8), `FREE_PRODUCT` (**manual**, `ONE_TIME` y `MONTHLY`).
- Config por dashboard (UI ampliada) + MCP (`configure_referral`).
- Notificación por **correo** (existe). Gating PRO (`REFERRAL_PROGRAM`), agregar al plan-gate del MCP.

### v2 (fast-follow)

- `FREE_PRODUCT` automático seguro (arreglar canje de cupones del TPV para honrar `scope=ITEM`).
- `FREE_PRODUCT MONTHLY` automático (cron + renovación de grants).
- **WhatsApp automático** (template Meta).
- Captura manual de referidos desde el dashboard (endpoints ya existen).

## 10. Gating / tier

`REFERRAL_PROGRAM` = **PRO** (ya en `plan-catalog.ts`). Agregar al plan-gate del MCP. Mindform tiene PREMIUM → cubierto. Los nuevos tipos de
premio son parte del MISMO feature → no cambian el tier.

## 11. Sincronización de capas

1. **Backend:** schema + migración + schema map + servicios + emisión + refund + tests.
2. **Dashboard:** UI de configuración ampliada.
3. **MCP:** `referrals.ts` + registro + plan-gate.
4. **TPV:** verificar `/discounts/auto` en el cobro (§8).
5. **Presentación de ventas:** el Nivel 3 con producto gratis es customer-visible → actualizar deck + one-pager + PDFs.

## 12. Plan de pruebas

- **Unit:** `computeTier` (sin cambio); emisión por cada `rewardType`; validación de config (tipo↔campos, producto del venue, umbrales).
- **Idempotencia/concurrencia:** dos `onOrderPaid` concurrentes para el mismo order → **un solo claim, un solo incremento, un solo set de
  grants** (CAS por orden + `ReferralTierUnlock` + unique de grant). Reintento del webhook = no-op. **Casos explícitos:** capturar 2
  referrals para la misma orden → partial-unique lo impide; desbloquear el mismo nivel dos veces → `ReferralTierUnlock` lo impide; re-cruzar
  tras refund → no re-otorga.
- **Refund:** revoca `PERCENT_COUPON` no canjeado; respeta `REDEEMED`; revoca `PERMANENT_DISCOUNT` no usado (vía `OrderDiscount`) y marca
  `REVOKED` con razón al permanente ya consumido; revoca `FREE_PRODUCT` `MANUAL_PENDING`, respeta `MANUAL_FULFILLED`.
- **Migración:** el preflight detecta y resuelve duplicados de `qualifyingOrderId` (el índice se crea sin abortar); el backfill de
  `ReferralTierUnlock` cubre TODOS los niveles ganados (un TIER_3 → 3 filas) → un cliente ya escalonado NO re-recibe grants al siguiente
  referido.
- **Regresión (golden):** un venue con solo `PERCENT_COUPON` se comporta **idéntico** a hoy; captura en TPV intacta; la migración no altera
  resultados existentes.
- **MCP:** `configure_referral` respeta permiso + plan-gate + audita.
- Tests de fecha con `TZ=UTC`.

## 13. Riesgos y mitigaciones

| Riesgo                                                          | Mitigación                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Sistema vivo con datos                                          | Migración backward-compatible; comportamiento actual no cambia                                                                             |
| Cupón COMP comp-earía la orden entera                           | `FREE_PRODUCT` manual en v1 (D6); automático sólo tras arreglar scope en v2                                                                |
| Doble-minteo / doble-conteo por concurrencia                    | CAS por orden + `ReferralTierUnlock` (un nivel/vida) + unique non-null de grant + partial-unique en `Referral(qualifyingOrderId)` (D7/D11) |
| Refund no revierte permanentes                                  | Refund por grants mirando `OrderDiscount` (D8/§6)                                                                                          |
| Campos planos quedan desincronizados                            | Mover todos los lectores/escritores en el mismo deploy, lista completa en §4.5 (D10)                                                       |
| 5% permanente no se aplica en el cobro                          | Verificación obligatoria del `/discounts/auto` en TPV (§8) — bloquea entrega                                                               |
| Borrar un `ReferralTierReward` con grants                       | `onDelete: Restrict` + soft-delete (`active`); editar un nivel versiona, no borra                                                          |
| El partial-unique aborta la migración por duplicados existentes | Preflight/dedupe obligatorio de `qualifyingOrderId` ANTES del índice (§4.5.b) (Codex v4)                                                   |
| Cliente ya escalonado re-recibe grants tras el deploy           | Backfill obligatorio y COMPLETO de `ReferralTierUnlock` (todos los niveles ganados) (§4.5.c) (Codex v4)                                    |
| Drift entre las 4 capas                                         | §11 obliga a sincronizar en el mismo cambio                                                                                                |

## 14. Esfuerzo estimado (honesto, post-auditoría)

| Bloque                                                                                                       | Esfuerzo                                   |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Núcleo (3 tablas + enums + migración + emisión idempotente con claim por orden + unlock + refund por grants) | ~5–7 días                                  |
| Verificación/ajuste auto-apply TPV (§8)                                                                      | ~0.5–2 días (según si el TPV ya lo invoca) |
| Fachada dashboard                                                                                            | ~1–2 días                                  |
| Fachada MCP                                                                                                  | ~0.5 día                                   |

(La estimación inicial de "~1 día" era optimista: subestimaba la capa de emisión/grants y la correctitud concurrente que las auditorías
destaparon.)

## 15. Auditoría externa (Codex, 2026-06-26)

Codex (gpt-5.5, read-only) auditó el spec contra el código real, en 4 rondas.

**Ronda 1 (v1 → v2).** 5 [P1]: cupón COMP comp-ea la orden (→ FREE_PRODUCT manual); falta tabla de emisión (→ `ReferralRewardGrant`);
idempotencia débil (→ tx + unique); refund no generaliza (→ por grants); campos planos vivos (→ migrar lectores/escritores).

**Ronda 2 (v2 → v3).** Confirmó 1, 2 y 4 resueltos; 2 nuevos [P1]: FK `tierRewardId` nullable rompía la unicidad (→ NON-NULL +
`onDelete: Restrict` + soft-delete); falta claim atómico del referral (→ CAS + tx). Más lectores de campos planos faltantes y estado del
grant permanente.

**Ronda 3 (v3 → v4).** Confirmó el FK non-null y los lectores resueltos; 1 nuevo [P1]: el CAS era por `referral.id`, pero `onOrderPaid` se
invoca por `orderId` y la DB no forzaba un referral por orden → doble-conteo posible. Atendido en v4:
**`ReferralTierUnlock(customerId, tierLevel)`** + **partial-unique en `Referral(qualifyingOrderId)`** + **CAS por orden** (§4.3b/§5/§D11).
Política declarada: un nivel se gana una vez de por vida; refund revoca pero no re-otorga.

**Ronda 4 (v4 → v5).** Confirmó cerrado el doble-conteo conceptual; 2 nuevos [P1], ambos de **migración segura** (ya no de diseño): (a) el
partial-unique abortaría la migración si hay `qualifyingOrderId` duplicados en prod → **preflight/dedupe obligatorio** (§4.5.b); (b) el
backfill de `ReferralTierUnlock` era "opcional" → **obligatorio y completo, todos los niveles ganados** (§4.5.c). [P2]: referrals sin
`qualifyingOrderId` (override / captura sin orden) nunca calificarían → política declarada en §4.3b.

[P2] pendientes (no bloquean): el MCP `configure_loyalty` existe para calcar; auto-discount depende del `/discounts/auto` del TPV (§8,
verificación); WhatsApp infra existe sin template de referral (v2); política de re-ganabilidad declarada en D11.

## 16. Preguntas abiertas

- **§8:** ¿el cobro del TPV ya invoca `/discounts/auto`? Determina si el `PERMANENT_DISCOUNT` necesita trabajo extra en TPV. A verificar
  antes de implementar.
