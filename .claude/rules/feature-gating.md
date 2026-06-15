# Feature Gating - Preguntas Obligatorias Antes de Implementar

Cuando el usuario pida "agregar un nuevo feature", "nuevo módulo", "nueva funcionalidad premium" o similar, **SIEMPRE hacer estas preguntas ANTES de escribir código o plan**:

## Preguntas obligatorias

1. **¿Es de paga o gratis?**
   - De paga → usar `Feature` / `VenueFeature` (tiene integración Stripe, trial, grace period, suspended state)
   - Gratis/interno → usar `Module` / `VenueModule` (sin pricing) o código regular sin gating

2. **Si es de paga: ¿visible como teaser (paywall visible) o totalmente oculto?**
   - Teaser visible → aparece en sidebar con candado, click lleva a upsell/billing
   - Oculto → solo aparece si el venue ya pagó (patrón legacy — pedir confirmación explícita)

3. **¿Qué rol mínimo puede verlo/usarlo?** (SUPERADMIN, OWNER, ADMIN, MANAGER, CASHIER, etc.)

4. **¿Requiere permiso específico?** Crear nuevo `resource:action` en `PERMISSION_CATALOG` o reusar uno existente.

5. **Si es de paga: ¿entra al split de white-label?** Registrar en `PERMISSION_TO_FEATURE_MAP` (`src/services/access/access.service.ts:73`) para que el filtrado por feature access en modo white-label funcione.

## Por qué importa

Avoqado tiene **dos sistemas paralelos** de gating (Module y Feature) con semántica distinta:

| | Module/VenueModule | Feature/VenueFeature |
|---|---|---|
| Pricing | No | Sí (Stripe) |
| Billing state | No | trial, suspended, grace period |
| Uso típico | SERIALIZED_INVENTORY, COMMISSIONS, WHITE_LABEL_DASHBOARD | CHATBOT, INVENTORY_TRACKING |

Escoger el sistema incorrecto causa refactor doloroso (migrar de Module → Feature implica crear tabla, migration, Stripe product, webhook handling).

## Gating EN CÓDIGO: qué resolver usar — NO los cruces (lección 2026-06-15)

Hay DOS resolvers en runtime y son distintos. **Usar el equivocado FALLA EN SILENCIO**: en prod casi todos los venues están _grandfathered_, así que un gate contra el sistema equivocado "pasa" para TODOS y NO restringe nada. (Bug real: el MCP gateó `SERIALIZED_INVENTORY` con el resolver de Features → pasaba para todos; fix commit `16c3bc35`.)

| El code vive en... | Gatéalo SIEMPRE con | Ejemplos |
|---|---|---|
| **`Module`** (VenueModule / OrganizationModule) | `moduleService.isModuleEnabled(venueId, MODULE_CODES.X)` — incluye fallback **org-level** | `SERIALIZED_INVENTORY`, `WHITE_LABEL_DASHBOARD`, `COMMISSIONS` |
| **`Feature`** (VenueFeature, Stripe/trial/tier) | `venueHasFeatureAccess(venueId, 'X')` / `venuesWithFeatureAccess(ids, 'X')` | `INVENTORY_TRACKING`, `CFDI`, `ADVANCED_REPORTS`, `LOYALTY_PROGRAM`, `CHATBOT` |

Para saber cuál: `SELECT code FROM "Module"` vs `SELECT code FROM "Feature"`. **Nunca gatees un Module con el resolver de Features ni viceversa.**

### MCP (`src/mcp/tools/`): serialized inventory SIEMPRE por el módulo

Todo tool del MCP que lea o escriba **inventario serializado** (SIMs / ICCID / seriales, sale-verification / "Vinculación", handoff de SIM, credit packs, detalle por serial, etc.) DEBE gatearse con `moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)` — **NUNCA** con `venuesWithFeatureAccess`/`planGateMessage`. Patrón canónico en `src/mcp/tools/inventory.ts` (`serialized_inventory`, `mark_serialized_item`): venue sin el módulo → `text({ ok: false, moduleRequired: true, error: ... })`. Así el MCP queda idéntico a cómo gatea la plataforma (`serializedInventory.routes`, `sale-verification.service`, `order.tpv`). Reglas:

- **Solo** los tools de serialized llevan este gate. **NO** gatear ventas/órdenes/menú/clientes/pagos por serialized — cada tool usa su propio candado (core gratis, su Feature, o su Module). El usuario recibe lo que **SUS** venues tengan habilitado (gate por-tool, no global). Un owner PlayTelecom (Isaac Mayoral, org OWNER) recibe todo lo normal **+** serialized; un restaurante recibe lo normal sin serialized.
- **NO acoplar** serialized ↔ white-label: son módulos independientes (PlayTelecom tiene ambos a nivel ORG vía `OrganizationModule`, pero exigir white-label rompería a quien solo tenga serialized).

## Archivos clave (referencia)

- Backend schema: `prisma/schema.prisma` — Module:6109, VenueModule:6137, Feature:~6620, VenueFeature:2598
- Module service: `src/services/modules/module.service.ts`
- Feature gating middleware: `src/middlewares/checkFeatureAccess.middleware.ts`
- Access/permissions resolver: `src/services/access/access.service.ts`
- Frontend sidebar: `src/components/Sidebar/app-sidebar.tsx`
- Frontend hooks: `src/hooks/use-access.ts`, `src/hooks/useWhiteLabelConfig.ts`
- Protected routes: `src/routes/FeatureProtectedRoute.tsx`, `src/routes/ModuleProtectedRoute.tsx`

## Excepción

Si el usuario dice explícitamente "solo es un endpoint", "es temporal", "es interno de superadmin" o similar, puedes proceder sin todas las preguntas — pero al menos confirma "¿es interno/gratis verdad?" antes de saltar el gating.
