# Feature Gating - Preguntas Obligatorias Antes de Implementar

Cuando el usuario pida "agregar un nuevo feature", "nuevo módulo", "nueva funcionalidad premium" o similar, **SIEMPRE hacer estas preguntas
ANTES de escribir código o plan**:

## Preguntas obligatorias

1. **¿Es de paga o gratis?**

   - De paga → usar `Feature` / `VenueFeature` (tiene integración Stripe, trial, grace period, suspended state)
   - Gratis/interno → usar `Module` / `VenueModule` (sin pricing) o código regular sin gating

2. **Si es de paga: ¿visible como teaser (paywall visible) o totalmente oculto?**

   - Teaser visible → aparece en sidebar con candado, click lleva a upsell/billing
   - Oculto → solo aparece si el venue ya pagó (patrón legacy — pedir confirmación explícita)

3. **¿Qué rol mínimo puede verlo/usarlo?** (SUPERADMIN, OWNER, ADMIN, MANAGER, CASHIER, etc.)

4. **¿Requiere permiso específico?** Crear nuevo `resource:action` en `PERMISSION_CATALOG` o reusar uno existente.

5. **Si es de paga: ¿entra al split de white-label?** Registrar en `PERMISSION_TO_FEATURE_MAP` (`src/services/access/access.service.ts:73`)
   para que el filtrado por feature access en modo white-label funcione.

6. **¿Cómo se PRENDE?** — el tier dice "¿lo pagó?", no "¿lo quiere prendido?". Ver "Activación" abajo. Sin esta respuesta el feature queda
   con el founder de switch humano.

## Activación: el switch (eje distinto del tier)

Cuatro candados que se componen con **AND**, no se sustituyen. Caso vivo en el schema: `VenueSettings.cashReconciliationEnabled` = _"PRO +
explicit opt-in"_.

| Eje                  | Contesta                     | Quién lo prende      | Dónde vive                                      |
| -------------------- | ---------------------------- | -------------------- | ----------------------------------------------- |
| Tier                 | ¿lo pagó?                    | comercial (Stripe)   | `Feature` / `VenueFeature`                      |
| Módulo               | ¿se lo habilitamos nosotros? | Avoqado (superadmin) | `Module` / `VenueModule` / `OrganizationModule` |
| **Ajuste del venue** | **¿el cliente lo quiere?**   | **el owner/admin**   | **`VenueSettings`**                             |
| Permiso              | ¿este usuario puede?         | el venue, por rol    | `PERMISSION_CATALOG`                            |

### 1. ¿Merece switch? — la app NO se construye por toggles

Un switch se justifica **solo si puedes nombrar dos clientes reales que quieran lo contrario** (uno quiere cierre de turno automático, otro
no → `autoCloseShifts`). Si no puedes nombrar los dos, es comportamiento core y va **sin** switch: cada toggle duplica los caminos que hay
que probar y las combinaciones en las que el producto puede romperse.

### 2. ¿Dónde vive el switch?

- **Canónico: SIEMPRE en `avoqado-web-dashboard`**, escribiendo el registro del server. Sin excepción.
- **Espejo en Android + iOS: solo si se toca DURANTE el turno, desde el piso** (no desde la oficina). Si se espeja va en **las dos** apps
  (la regla android↔iOS aplica igual) y edita el **mismo** registro del server — nunca una copia local. Costo real de espejar: 2
  implementaciones + días de rollout, contra minutos del dashboard.
- 🔴 **Nunca solo en la DB.** Un feature cuyo único switch es un `UPDATE` en Postgres está **incompleto** — deja al founder de switch humano
  para cada cliente que lo pida.

Referencia externa: Toast configura todo en Toast Web y **publica** a las terminales; Square deja editar desde la app solo un subconjunto
acotado (ajustes del _modo_) y el resto solo en Dashboard. Ninguno hace "todo configurable en todos lados".

### 3. El default (ON u OFF) lo decides tú, no el founder

Mide el riesgo, **decláralo en el reporte** y sigue. **Pregunta al founder solo si toca dinero, fiscal, permisos, stock o algo
irreversible** — ahí el default es **OFF** salvo que él diga lo contrario (precedente: `includeInGlobal` → `false` por riesgo de
doble-facturación). Todo lo demás lo decides sin preguntar.

🔴 **Y cuando SÍ le preguntes, la pregunta se plantea como «¿configurable por venue o fijo para todos?»** — instrucción directa del founder
(2026-08-17; caso que la originó: la propina de delivery, que quiso configurable). No preguntarle solo "¿ON u OFF?": presentarle las DOS
formas — (a) switch por venue en `VenueSettings`, dashboard canónico, o (b) comportamiento fijo — cada una con su consecuencia en una línea.
Aplica en general a decisiones de comportamiento donde dos dueños de venue podrían razonablemente querer cosas opuestas (su frase: _"tal vez
algunos admins lo quieren de una manera y otros otra"_). El test de los dos clientes reales (regla 1) sigue siendo el análisis que se le
presenta; lo que cambia es que la elección final entre configurable y fijo es SUYA, no del LLM.

### 4. Apagado se VE y se EXPLICA

🔴 **Nunca desaparecer en silencio.** Ese es exactamente el bug de `Venue.status='ONBOARDING'`, que borra el venue y sus TPVs del dashboard
de org sin avisar. Con el candado cerrado: punto de entrada **visible**, estado apagado, **qué hacer** para prenderlo, y **a quién
pedírselo** si el usuario no tiene el permiso. Aplica a los cuatro ejes; solo cambia el texto — tier → upsell al plan; módulo → "pídelo a
Avoqado"; ajuste → "actívalo en Ajustes"; permiso → "pídeselo a tu administrador".

## Por qué importa

Avoqado tiene **dos sistemas paralelos** de gating (Module y Feature) con semántica distinta:

|               | Module/VenueModule                                       | Feature/VenueFeature           |
| ------------- | -------------------------------------------------------- | ------------------------------ |
| Pricing       | No                                                       | Sí (Stripe)                    |
| Billing state | No                                                       | trial, suspended, grace period |
| Uso típico    | SERIALIZED_INVENTORY, COMMISSIONS, WHITE_LABEL_DASHBOARD | CHATBOT, INVENTORY_TRACKING    |

Escoger el sistema incorrecto causa refactor doloroso (migrar de Module → Feature implica crear tabla, migration, Stripe product, webhook
handling).

## Gating EN CÓDIGO: qué resolver usar — NO los cruces (lección 2026-06-15)

Hay DOS resolvers en runtime y son distintos. **Usar el equivocado FALLA EN SILENCIO**: en prod casi todos los venues están _grandfathered_,
así que un gate contra el sistema equivocado "pasa" para TODOS y NO restringe nada. (Bug real: el MCP gateó `SERIALIZED_INVENTORY` con el
resolver de Features → pasaba para todos; fix commit `16c3bc35`.)

| El code vive en...                              | Gatéalo SIEMPRE con                                                                       | Ejemplos                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **`Module`** (VenueModule / OrganizationModule) | `moduleService.isModuleEnabled(venueId, MODULE_CODES.X)` — incluye fallback **org-level** | `SERIALIZED_INVENTORY`, `WHITE_LABEL_DASHBOARD`, `COMMISSIONS`                 |
| **`Feature`** (VenueFeature, Stripe/trial/tier) | `venueHasFeatureAccess(venueId, 'X')` / `venuesWithFeatureAccess(ids, 'X')`               | `INVENTORY_TRACKING`, `CFDI`, `ADVANCED_REPORTS`, `LOYALTY_PROGRAM`, `CHATBOT` |

Para saber cuál: `SELECT code FROM "Module"` vs `SELECT code FROM "Feature"`. **Nunca gatees un Module con el resolver de Features ni
viceversa.**

### 🔴 El grandfathering vive en DOS niveles — resuélvelo SOLO con `access/grandfather.ts`

`seatCapExempt` existe en `Venue` **y** en `Organization`. Un venue está exento si **cualquiera de los dos** la tiene. La de la organización
es la que cubre las tiendas que el cliente **todavía no ha abierto**: la migración del rollout sólo alcanzó a los venues vivos en ese
momento, así que las que nacen después arrancan en el tope del plan Gratis (PlayTelecom, 6 tiendas — el bloqueo aparece recién al invitar al
tercer empleado).

```typescript
// ❌ MAL — sólo ve un nivel; discrepa del resto de la plataforma sin fallar
select: { seatCapExempt: true }
if (venue.seatCapExempt) ...

// ✅ BIEN — un único punto de verdad
import { GRANDFATHER_SELECT, resolveGrandfathered } from '@/services/access/grandfather'
select: { ...GRANDFATHER_SELECT }
if (resolveGrandfathered(venue)) ...
```

- **Impórtalo de `access/grandfather.ts`, NO de `basePlan.service`** (que lo re-exporta por comodidad): varias suites mockean `basePlan`
  completo, y pasar por él deja el resolver `undefined` dentro de un gate que decide si alguien puede trabajar.
- Los ocho consumidores actuales ya lo usan (basePlan ×4, `getVenueSeatCap`, `assertCanAddSeatsBulk`, `getPlanState`, `seatReconciliation`,
  `venueFeature`, el middleware). **Si añades un noveno, úsalo también**: un gate que contesta distinto a los demás no truena, sólo deja
  pasar —o bloquea— a quien no debía.
- No confundas exención con **estatus demo** (`LIVE_DEMO`/`TRIAL`): también exime del paywall, pero NO es grandfathering.
  `venueIsExemptFromPlanGating` compone las dos; `venueIsGrandfathered` sólo la primera.

### MCP (`src/mcp/tools/`): serialized inventory SIEMPRE por el módulo

Todo tool del MCP que lea o escriba **inventario serializado** (SIMs / ICCID / seriales, sale-verification / "Vinculación", handoff de SIM,
credit packs, detalle por serial, etc.) DEBE gatearse con `moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)` —
**NUNCA** con `venuesWithFeatureAccess`/`planGateMessage`. Patrón canónico en `src/mcp/tools/inventory.ts` (`serialized_inventory`,
`mark_serialized_item`): venue sin el módulo → `text({ ok: false, moduleRequired: true, error: ... })`. Así el MCP queda idéntico a cómo
gatea la plataforma (`serializedInventory.routes`, `sale-verification.service`, `order.tpv`). Reglas:

- **Solo** los tools de serialized llevan este gate. **NO** gatear ventas/órdenes/menú/clientes/pagos por serialized — cada tool usa su
  propio candado (core gratis, su Feature, o su Module). El usuario recibe lo que **SUS** venues tengan habilitado (gate por-tool, no
  global). Un owner PlayTelecom (Isaac Mayoral, org OWNER) recibe todo lo normal **+** serialized; un restaurante recibe lo normal sin
  serialized.
- **NO acoplar** serialized ↔ white-label: son módulos independientes (PlayTelecom tiene ambos a nivel ORG vía `OrganizationModule`, pero
  exigir white-label rompería a quien solo tenga serialized).

## Archivos clave (referencia)

- Backend schema: `prisma/schema.prisma` — Module:6109, VenueModule:6137, Feature:~6620, VenueFeature:2598
- Module service: `src/services/modules/module.service.ts`
- Feature gating middleware: `src/middlewares/checkFeatureAccess.middleware.ts`
- Access/permissions resolver: `src/services/access/access.service.ts`
- Frontend sidebar: `src/components/Sidebar/app-sidebar.tsx`
- Frontend hooks: `src/hooks/use-access.ts`, `src/hooks/useWhiteLabelConfig.ts`
- Protected routes: `src/routes/FeatureProtectedRoute.tsx`, `src/routes/ModuleProtectedRoute.tsx`

## Excepción

Si el usuario dice explícitamente "solo es un endpoint", "es temporal", "es interno de superadmin" o similar, puedes proceder sin todas las
preguntas — pero al menos confirma "¿es interno/gratis verdad?" antes de saltar el gating.
