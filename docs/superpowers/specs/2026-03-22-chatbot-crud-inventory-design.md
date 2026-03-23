# Chatbot CRUD Engine — Inventory Module Design Spec

**Date**: 2026-03-22 **Status**: Audited & Final **Scope**: Full inventory CRUD via chatbot (Raw Materials, Recipes, Purchase Orders,
Product Stock) **Platform**: Web dashboard only (for now)

---

## 1. Problem Statement

The current chatbot is read-only (text-to-SQL for analytics with ~95% accuracy). The only mutation is `create_product`, which is hardcoded
at ~800 lines in `text-to-sql-assistant.service.ts` (7,800 lines total). This approach does not scale to the 450+ CRUD operations needed to
replace the dashboard.

Restaurant operators need to manage inventory daily — creating raw materials, adjusting stock, managing recipes, handling purchase orders.
Doing this via chatbot with natural language (including typos, spanglish, colloquial Spanish) would be a disruptive competitive advantage.

## 2. Design Goals

1. **95-96% LLM accuracy + validation layers → 99% end-to-end reliability** — errors caught by validation, preview/confirm, and confidence
   thresholds before reaching the database
2. **Zero breaking changes** — existing text-to-SQL pipeline (queries, charts) untouched
3. **Scalable** — adding a new CRUD action = ~30-50 lines of declarative definition, not ~300 lines of handler code
4. **Secure** — 7-layer security model (prompt injection, permissions, validation, entity resolution, preview, danger guards, idempotency)
5. **Cost-efficient** — ~$0.005-0.008 per interaction using GPT-5.4 Mini/Nano

## 3. Architecture: Action Registry + Schema-Driven Engine

### 3.1 Why This Approach

Three approaches were evaluated:

| Approach                                                     | Verdict                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| **A) Hardcoded handlers** (current `create_product` pattern) | Does not scale: 50+ handlers = 30,000+ lines             |
| **B) Action Registry + Schema-Driven Engine**                | **Selected**: 1 generic engine + declarative definitions |
| **C) Direct LLM Agent with all tools**                       | Too expensive (50+ tool defs per request), less control  |

### 3.2 High-Level Flow

```
User message
    │
    ▼
┌─────────────────────────────────┐
│ text-to-sql-assistant.service   │ (existing)
│ processQuery()                  │
│   │                             │
│   ├─ Security checks (existing) │
│   ├─ Action Engine hook (NEW)───┼──► actionEngine.detectAction()
│   │   if isAction: delegate     │       │
│   │   if !isAction: continue ───┼──►    │
│   ├─ LLM Router (existing)     │       │
│   ├─ Text-to-SQL (existing)    │       │
│   └─ Response gen (existing)   │       │
└─────────────────────────────────┘       │
                                          ▼
                                  ┌───────────────┐
                                  │ Action Engine  │ (NEW)
                                  │  classify      │
                                  │  validate      │
                                  │  resolve       │
                                  │  preview       │
                                  │  confirm       │
                                  │  execute       │
                                  └───────────────┘
```

### 3.3 Integration Point

One hook (~15 lines) added to `processQuery()` in the existing service. If `CHATBOT_MUTATIONS_ENABLED` and the message is detected as an
action, delegate to the Action Engine. Otherwise, the existing text-to-SQL flow continues unchanged.

## 4. File Structure

```
src/services/dashboard/
├── text-to-sql-assistant.service.ts       ← EXISTING (1 hook added)
├── chatbot-actions/                        ← ALL NEW
│   ├── action-engine.service.ts            ← Generic orchestrator (~800-1000 lines)
│   ├── action-registry.ts                  ← Central registry of all actions
│   ├── action-classifier.service.ts        ← LLM function calling (GPT-5.4 Mini)
│   ├── entity-resolver.service.ts          ← Fuzzy match entities in DB (pg_trgm)
│   ├── field-collector.service.ts          ← Conversation-first with smart form fallback
│   ├── action-preview.service.ts           ← Generate rich previews with context
│   ├── danger-guard.service.ts             ← Risk classification + double confirmation
│   ├── types.ts                            ← Shared interfaces
│   │
│   └── definitions/                        ← One file per domain
│       ├── inventory.actions.ts            ← RawMaterial: create, update, delete, adjust-stock
│       ├── recipe.actions.ts               ← Recipe: create, update, delete, add/remove line
│       ├── purchase-order.actions.ts       ← PO: create, receive, approve, cancel
│       └── product-stock.actions.ts        ← Product inventory: adjust, set-minimum
```

## 5. Action Definition Schema

Each action is a declarative object. The engine reads these at runtime.

```typescript
interface ActionDefinition {
  // Identity
  actionType: string // 'inventory.rawMaterial.create'
  entity: string // 'RawMaterial'
  operation: 'create' | 'update' | 'delete' | 'custom'

  // Security
  permission: string // 'inventory:create'
  dangerLevel: 'low' | 'medium' | 'high' | 'blocked'

  // Execution
  service: string // 'rawMaterialService'
  method: string // 'create'

  // Service adapter: maps generic {venueId, entityId, params, userId} to actual function signature
  // Needed because service methods have diverse signatures:
  //   createRawMaterial(venueId, data)           — 2 params
  //   adjustStock(venueId, rawMaterialId, data, staffId?) — 4 params
  //   createRecipe(venueId, productId, data)     — 3 params
  //   cancelPurchaseOrder(venueId, poId, reason?, staffId?) — 4 params
  serviceAdapter?: (context: ActionContext, params: Record<string, any>, entityId?: string) => any[]

  // LLM classification
  description: string // Human-readable description for LLM
  examples: string[] // Example user messages for better classification

  // Fields (derived from Prisma schema)
  fields: Record<string, FieldDefinition>

  // For variable-length lists (e.g., recipe lines, PO items)
  listField?: {
    name: string // 'lines'
    itemFields: Record<string, FieldDefinition>
    minItems: number // 1 for recipes
    description: string // 'ingredientes de la receta'
  }

  // Entity resolution (for update/delete operations)
  entityResolution?: {
    searchField: string // 'name'
    scope: string // 'venueId'
    fuzzyMatch: boolean
    multipleMatchBehavior: 'ask' | 'first' | 'error'
    // Two-hop resolution: e.g., Recipe requires Product name → productId → Recipe
    resolveVia?: {
      intermediateEntity: string // 'Product'
      intermediateField: string // 'name'
      linkField: string // 'productId'
    }
  }

  // Preview
  previewTemplate: {
    title: string
    summary: string // Template with {{field}} placeholders
    showDiff?: boolean // For updates: before → after
    showImpact?: boolean // For deletes: affected recipes, orders, etc.
  }
}

interface FieldDefinition {
  type: 'string' | 'decimal' | 'integer' | 'boolean' | 'enum' | 'date'
  required: boolean
  prompt?: string // Question to ask if missing (Spanish)
  options?: string[] // For enum fields
  default?: any
  min?: number
  max?: number
  transform?: 'uppercase' | 'lowercase' | 'trim'
  unique?: boolean // Engine checks for duplicates
}
```

## 6. Action Engine Flow (4 Phases)

### Phase 1: Detection

**Model**: GPT-5.4 Nano (~$0.0001/call)

Determines if the message is a query (→ text-to-SQL) or an action (→ Action Engine). Uses structured output with JSON schema to return
`{ intent: 'query' | 'action' }`.

### Phase 2: Classification + Parameter Extraction

**Model**: GPT-5.4 Mini (~$0.003/call, 93.4% tool accuracy on tau2-bench)

Uses OpenAI function calling with tool definitions auto-generated from the Action Registry. Only sends tools for the detected domain (5-10
tools, not all 50+) to reduce token cost and improve accuracy.

Returns: `{ actionType, params, entityName }`

### Phase 3: Validation + Preview

**No LLM** — deterministic, fast, free.

1. **Permission check**: `hasPermission(role, permissions, definition.permission)`
2. **Entity resolution** (for update/delete): Fuzzy match via PostgreSQL `pg_trgm`
   - 0 matches → "No encontré esa materia prima"
   - 1 match → continue
   - 2+ matches → "¿Cuál de estas?: [list]"
3. **Missing field detection**: Compare extracted params vs required fields
   - Default → conversational (ask missing fields naturally in one message)
   - Form only if >5 missing AND complex enums, or user explicitly requests it
4. **Schema validation**: Zod schema auto-generated from `definition.fields`
5. **Preview generation**: Template-based (no LLM), shows:
   - For creates: summary of what will be created
   - For updates: diff (before → after)
   - For deletes: impact analysis (affected recipes, stock value, etc.)
6. **Session storage**: In-memory with 15-minute TTL

### Phase 4: Confirmation + Execution

**No LLM** — deterministic.

1. **Idempotency check**: Key = `venueId:userId:idempotencyKey`
2. **Session validation**: Exists, not expired, same venue/user
3. **Danger guard**: If `dangerLevel === 'high'`, require double confirmation
4. **Execute**: Call existing service method within `prisma.$transaction()`
5. **Audit log**: Record action, params, result, userId, timestamp
6. **Cache idempotency result**: 15-minute TTL

## 7. Entity Resolution (Fuzzy Match)

Uses PostgreSQL's `pg_trgm` extension for trigram similarity matching.

**PREREQUISITE**: A migration must be created to enable the extension and add indexes:

```sql
-- Migration: add_pg_trgm_for_chatbot_fuzzy_match
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN indexes for acceptable performance on fuzzy search
CREATE INDEX idx_raw_material_name_trgm ON "RawMaterial" USING GIN (name gin_trgm_ops);
CREATE INDEX idx_product_name_trgm ON "Product" USING GIN (name gin_trgm_ops);
CREATE INDEX idx_supplier_name_trgm ON "Supplier" USING GIN (name gin_trgm_ops);
```

```sql
-- "karne molida" → matches "Carne Molida Res" with score 0.45
SELECT id, name, similarity(name, 'karne molida') as score
FROM "RawMaterial"
WHERE "venueId" = $1 AND "active" = true AND "deletedAt" IS NULL
  AND similarity(name, 'karne molida') > 0.3
ORDER BY score DESC LIMIT 5
```

**CRITICAL: `venueId` MUST always come from `authContext`, never from user input or LLM output.** This is the tenant isolation invariant.

**Match behavior**:

- Exact match (case-insensitive) → use directly
- Single fuzzy match → use with confirmation in preview
- Multiple fuzzy matches → present options to user
- No matches → try SKU search, then return "not found"

**Active/deleted filtering by operation**:

- `create`: N/A (no entity to resolve)
- `update`, `adjustStock`: `active = true AND deletedAt IS NULL`
- `delete`: `deletedAt IS NULL` (include inactive so users can delete deactivated items)

**Two-hop resolution** (for recipes):

- User says "la receta de la hamburguesa"
- Step 1: Fuzzy match "hamburguesa" against `Product.name` → finds Product
- Step 2: Look up `Recipe` by `productId` → finds Recipe
- Configured via `entityResolution.resolveVia`

**Supplier resolution** (for purchase orders):

- PO creation requires `supplierId`
- "Pedir harina a Distribuidora Martinez" requires fuzzy-matching against `Supplier.name`
- Entity resolver supports resolving multiple entity types per action via `fields` with `type: 'reference'`

## 8. Security Model (7 Layers)

| Layer                | What                                                      | When                   | Blocks                         |
| -------------------- | --------------------------------------------------------- | ---------------------- | ------------------------------ |
| 1. Prompt Injection  | Regex + semantic detector                                 | Before anything        | Injection attempts             |
| 2. Permissions       | `hasPermission()` via `resolveCustomPermissionsForRole()` | After classification   | Unauthorized actions           |
| 3. Schema Validation | Zod (auto-generated)                                      | After param extraction | Invalid data types/values      |
| 4. Entity Resolution | Fuzzy match + venueId scope                               | For update/delete      | Wrong entity, cross-tenant     |
| 5. Preview           | Template-based, user sees exactly what happens            | Always                 | User reviews before execution  |
| 6. Danger Guards     | Risk-based confirmation levels                            | Before execution       | Accidental destructive actions |
| 7. Idempotency       | Key-based dedup                                           | At execution           | Double-execution               |

**Blocked operations** (never allowed via chatbot):

- Bulk deletes ("elimina todos los productos")
- Schema changes
- SQL generation for writes (mutations go through services, not raw SQL)
- Cross-venue operations

**Danger levels**:

- `low` → 1 confirmation (create operations)
- `medium` → 1 confirmation + change summary (updates)
- `high` → double confirmation + impact analysis (deletes, stock adjustments)
- `blocked` → not available via chatbot (bulk operations)

## 9. Field Collection (Conversation-First, Smart Fallback)

The default experience is **100% conversational** — no forms. The chatbot asks naturally and the user responds however they want. Forms are
a last resort, not the default.

### Conversation-first flow (default):

```
User: "Agrega carne molida, 20 kilos a 180"
Bot:  "Solo me falta el SKU. ¿Qué código le ponemos?"
User: "CARNE01"
Bot:  "Perfecto. Voy a crear:
       Carne Molida — 20kg a $180/kg, SKU: CARNE01
       ¿Confirmo?"
```

When multiple fields are missing, ask them ALL in one natural message:

```
Bot: "Para registrar la harina necesito: el SKU, en qué unidad se mide
     (kg, litros, piezas) y el costo por unidad. ¿Cuáles serían?"
User: "HAR01, en kilos, a 45 pesos"
```

The LLM parses the user's freeform response and extracts the values — no dropdowns, no forms.

### Smart form fallback (only when genuinely better):

The engine evaluates whether a form is truly necessary based on:

- **>5 missing required fields** AND the action has complex enum/reference fields
- **Recipe lines** where the user provided NO ingredients at all (blank slate)
- **User explicitly asks** for a form: "mejor dame un formulario"

Even in form mode, pre-fill everything the LLM already extracted.

### Multi-turn context:

```
User: "Crea la receta de hamburguesa: 200g carne, 1 pan, lechuga y queso"
Bot:  "La receta quedaría:
       • Carne Molida — 200g
       • Pan Hamburguesa — 1 pieza
       • Lechuga — 50g
       • Queso Amarillo — 30g
       ¿Le falta algo o la confirmo?"
User: "Agrégale jitomate y cebolla"
Bot:  "Actualizado:
       • Carne Molida — 200g
       • Pan Hamburguesa — 1 pieza
       • Lechuga — 50g
       • Queso Amarillo — 30g
       • Jitomate — 50g
       • Cebolla — 30g
       ¿Confirmo?"
```

### Unit/quantity inference:

When the user omits units or quantities, the LLM infers from context:

- Raw material already exists with `unit: KG` → infer KG
- "un poco de lechuga" → infer reasonable quantity based on recipe context
- If truly ambiguous → ask: "¿50g de lechuga está bien o cuánto?"

## 10. LLM Model Strategy

| Task                                     | Model           | Cost/call | Justification                          |
| ---------------------------------------- | --------------- | --------- | -------------------------------------- |
| Intent detection (query vs action)       | GPT-5.4 Nano    | ~$0.0001  | Only needs binary classification       |
| Action classification + param extraction | GPT-5.4 Mini    | ~$0.003   | 93.4% tool accuracy, best cost/quality |
| SQL generation (reads)                   | GPT-5.4 Mini    | ~$0.003   | Upgrade from GPT-4o-mini               |
| Response formatting                      | GPT-5.4 Nano    | ~$0.0001  | Just formats text                      |
| Preview generation                       | None (template) | $0        | Deterministic, no LLM needed           |

**Estimated cost per CRUD interaction**: $0.005-0.008 **$100 USD budget**: ~15,000-20,000 interactions

## 11. Inventory Actions (Complete List)

### Raw Materials (4 actions)

| Action                              | Type   | Danger | Permission         | Service Method                                                           |
| ----------------------------------- | ------ | ------ | ------------------ | ------------------------------------------------------------------------ |
| `inventory.rawMaterial.create`      | create | low    | `inventory:create` | `rawMaterialService.createRawMaterial(venueId, data)`                    |
| `inventory.rawMaterial.update`      | update | medium | `inventory:update` | `rawMaterialService.updateRawMaterial(venueId, rawMaterialId, data)`     |
| `inventory.rawMaterial.delete`      | delete | high   | `inventory:delete` | `rawMaterialService.deactivateRawMaterial(venueId, rawMaterialId)`       |
| `inventory.rawMaterial.adjustStock` | custom | medium | `inventory:update` | `rawMaterialService.adjustStock(venueId, rawMaterialId, data, staffId?)` |

### Recipes (5 actions)

**Note**: Recipe entity resolution requires two-hop: Product name → productId → Recipe. | Action | Type | Danger | Permission | Service
Method | |--------|------|--------|------------|----------------| | `inventory.recipe.create` | create | low | `menu:create` |
`recipeService.createRecipe(venueId, productId, data)` | | `inventory.recipe.update` | update | medium | `menu:update` |
`recipeService.updateRecipe(venueId, productId, data)` | | `inventory.recipe.delete` | delete | high | `menu:delete` |
`recipeService.deleteRecipe(venueId, productId)` | | `inventory.recipe.addLine` | custom | low | `menu:update` |
`recipeService.addRecipeLine(venueId, productId, data)` | | `inventory.recipe.removeLine` | custom | medium | `menu:update` |
`recipeService.removeRecipeLine(venueId, productId, recipeLineId)` |

### Purchase Orders (4 actions)

**Note**: PO creation requires supplier resolution (fuzzy match against Supplier.name). | Action | Type | Danger | Permission | Service
Method | |--------|------|--------|------------|----------------| | `inventory.purchaseOrder.create` | create | low | `inventory:create` |
`purchaseOrderService.createPurchaseOrder(venueId, data, staffId?)` | | `inventory.purchaseOrder.approve` | custom | medium |
`inventory:update` | `purchaseOrderService.approvePurchaseOrder(venueId, poId, staffId?)` | | `inventory.purchaseOrder.receive` | custom |
medium | `inventory:update` | `purchaseOrderService.receivePurchaseOrder(venueId, poId, data)` | | `inventory.purchaseOrder.cancel` | custom
| high | `inventory:delete` | `purchaseOrderService.cancelPurchaseOrder(venueId, poId, reason?, staffId?)` |

### Product Stock (2 actions)

**Note**: `setMinimumStock` does not exist yet — must be implemented as a thin wrapper. | Action | Type | Danger | Permission | Service
Method | |--------|------|--------|------------|----------------| | `inventory.product.adjustStock` | custom | medium | `inventory:update` |
`productInventoryService.adjustInventoryStock(venueId, productId, data)` | | `inventory.product.setMinimum` | update | low |
`inventory:update` | `productInventoryService.setMinimumStock(venueId, productId, minimum)` — **TO BUILD** |

### Product CRUD (3 actions — migration from hardcoded)

| Action                | Type   | Danger | Permission    | Service Method                 |
| --------------------- | ------ | ------ | ------------- | ------------------------------ |
| `menu.product.create` | create | low    | `menu:create` | `productService.createProduct` |
| `menu.product.update` | update | medium | `menu:update` | `productService.updateProduct` |
| `menu.product.delete` | delete | high   | `menu:delete` | `productService.deleteProduct` |

**Total: 18 actions for Phase 1 (Inventory) + 3 for product migration = 21 actions**

## 12. Integration with Existing System

### What changes in existing code:

- `text-to-sql-assistant.service.ts`: Add ~15-line hook in `processQuery()` to delegate to Action Engine
- `text-to-sql-assistant.controller.ts`: Routes for `/actions/preview` and `/actions/confirm` already exist — generalize them
- Existing `create_product` hardcoded code (~800 lines): Migrate to registry definition, then remove

### What does NOT change:

- Text-to-SQL pipeline (queries, charts, analytics)
- SharedQueryService (11 fast-path intents)
- Security layers (prompt injection, semantic injection, PII detection)
- AI learning service
- Table access control
- All existing routes and middleware

### Feature flag:

`CHATBOT_ENABLE_MUTATIONS` (env var, already exists) — gates all action functionality. Internal constant: `CHATBOT_MUTATIONS_ENABLED` (line
233 of text-to-sql-assistant.service.ts).

### Permission resolution:

The engine must call `resolveCustomPermissionsForRole(venueId, role)` to get venue-level custom permissions before calling
`hasPermission(role, customPermissions, requiredPermission)`. Import from `src/lib/permissions.ts` (not the access service version).

## 13. Future Expansion

After inventory is proven, adding new domains is trivial:

| Domain              | Actions                             | Effort                    |
| ------------------- | ----------------------------------- | ------------------------- |
| Staff management    | create, update, invite, assign role | ~200 lines of definitions |
| Customer management | create, update, settle balance      | ~150 lines                |
| Reservations        | create, confirm, cancel, reschedule | ~200 lines                |
| Coupons/Discounts   | create, update, deactivate          | ~150 lines                |
| Shifts              | create, close, add notes            | ~100 lines                |

Each domain only requires definition files — the engine, classifier, resolver, and preview services are reused as-is.

## 14. Testing Strategy

### Unit Tests

- Action Engine: test each phase (detect, classify, validate, preview, confirm)
- Entity Resolver: test fuzzy matching with typos, accents, spanglish
- Field Collector: test conversation-first logic with smart form fallback
- Danger Guard: test each level

### Integration Tests

- Full flow: message → classification → preview → confirm → DB check
- Permission denied scenarios
- Entity not found scenarios
- Session expiration
- Idempotency replay

### Regression Tests

- All existing text-to-SQL queries still work (70+ test cases)
- Existing `create_product` flow works via registry (backward compatible)

### LLM Accuracy Tests

- 50+ messages per domain covering:
  - Clean Spanish ("crear materia prima harina")
  - Typos ("kreame karne molida")
  - Spanglish ("agrega raw material carne")
  - Vague ("necesito harina")
  - False positives ("cuánta carne se usó ayer" → should be query, not action)

## 15. Edge Cases and Known Limitations

### Variable-length list fields (recipe lines, PO items)

Recipe creation requires a list of ingredients: "200g carne, 1 pan, 50g lechuga". This is harder than scalar field extraction.

- The LLM extracts a `lines` array via the `listField` definition
- Each line requires resolving a RawMaterial (fuzzy match) + quantity + unit
- Preview shows the full ingredient list for confirmation
- If the LLM can't parse all lines, it shows what it understood and asks for corrections

### Concurrent modification between preview and confirm

Between preview ("stock: 50kg, will adjust to 45kg") and confirm (user clicks), another user could change the stock.

- For `adjustStock`: Use relative operations (+5, -3), not absolute values. The service already handles this.
- For `update`: The preview stores the `updatedAt` timestamp. On confirm, verify it hasn't changed. If changed, show new values and
  re-preview.
- For `delete`: Soft delete via `deactivate` is safe — worst case, another user already deactivated it.

### No undo mechanism

The chatbot cannot undo confirmed actions. This is by design:

- The preview/confirm pattern prevents accidental actions
- If something goes wrong, use the dashboard to correct it
- The audit log records all actions for accountability

### Session storage (in-memory limitation)

Current: static `Map` (matches existing `create_product` pattern). Works for single-instance. Future: Migrate to Redis-backed sessions when
scaling to multiple server instances. Redis is already in the codebase.

### Zod error messages must be in Spanish

The auto-generated Zod schemas from `definition.fields` must produce Spanish error messages. The schema generator will use the field's
`prompt` for required field errors and predefined Spanish messages for type/min/max errors.

### Mutation-specific rate limiting

Consider tighter rate limits for mutations (e.g., 10 mutations/minute) vs. reads (60 queries/minute) to prevent abuse. Can be added as a
configuration in the action definition.

### Domain detection for tool selection

Phase 1 (GPT-5.4 Nano) returns `{ intent: 'query' | 'action', domain?: 'inventory' | 'recipe' | 'purchaseOrder' | 'product' }`. If domain is
ambiguous, Phase 2 receives tools from ALL domains (still <25 tools for inventory scope). Fallback is safe but slightly more expensive.

## 16. Production Hardening (from audit)

### LLM Reliability

- **Timeouts**: 5s for Nano calls, 8s for Mini calls. On timeout → graceful message in Spanish.
- **Circuit breaker**: After 3 consecutive OpenAI failures, block mutation requests (read queries still work). Auto-retry after 60s. Pattern
  already exists in `semantic-injection-detector.service.ts`.
- **Fallback chain**: LLM fails → retry once → fallback message "El asistente no está disponible, usa el dashboard."
- **Confidence threshold**: If classification confidence < 0.85, ask user to disambiguate: "¿Quisiste decir (1) ajustar stock o (2)
  actualizar datos?"
- **Model env vars**: `CHATBOT_CLASSIFICATION_MODEL` and `CHATBOT_INTENT_MODEL` — not hardcoded.

### Security Hardening

- **Strip dangerous params**: Engine MUST strip `venueId`, `orgId`, `userId`, `id` from LLM-extracted params before passing to any service.
  Hard-coded, not optional.
- **Entity name sanitization**: Names from DB passed to LLM wrapped in `[ENTITY_DATA]...[/ENTITY_DATA]` delimiters. System prompt instructs
  LLM to never interpret entity data as instructions.
- **Parameterized fuzzy queries**: ALL pg_trgm queries use `Prisma.$queryRaw` with tagged template literals (auto-parameterized). Never
  `$queryRawUnsafe`.
- **Centralized `scopedFuzzySearch()`**: Single function that always includes venueId filter. Individual resolvers cannot construct raw SQL.
- **Permission check BEFORE LLM**: After Phase 1 detects "action", immediately check if user has ANY mutation permission. If not, reject
  before Phase 2 (saves LLM cost).
- **Re-validate role on confirm**: Fetch fresh role from DB at confirm time, not from stored session.
- **Spanish injection patterns**: Add to regex detector: `ignora`, `olvida`, `ahora eres`, `actua como`, `muestra el prompt`.
- **Circuit breaker blocks mutations**: When semantic injection detector circuit breaker is open, block ALL mutation requests (not just
  injection detection).

### Rate Limiting

- Mutation-specific: 5 mutations/minute per user, 30/hour per venue.
- High-danger (deletes): 3/minute per user.
- Max pending sessions: 3 per user. New preview replaces oldest pending.
- Daily cap: 100 mutations/day per user.

### Monitoring

- Track confirmation rate vs rejection rate per action type. Low confirmation = bad classification.
- Track average confidence score. Alert if drops below 0.85.
- Log before/after state in audit log for all mutations (enables manual rollback).
- Cost per venue per day tracking. Alert on anomalies.

### Accuracy Improvement Roadmap

- **Month 1**: Launch with GPT-5.4 Mini + prompt engineering. Collect production data.
- **Month 2**: Analyze rejection/correction patterns. Add restaurant-specific glossary to system prompt ("merma", "mise en place",
  "comanda").
- **Month 3**: Fine-tune GPT-5.4 Mini on 500+ labeled production interactions. Expected accuracy: 93% → 97%+.
- **Ongoing**: Regression test suite of 200+ labeled examples. Run before any model migration.

## 17. Corrected Service Method Signatures

Verified against actual codebase (2026-03-22):

| Action                  | Actual Signature                                                                          | File:Line                          |
| ----------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| rawMaterial.create      | `createRawMaterial(venueId, data: CreateRawMaterialDto)`                                  | `rawMaterial.service.ts:128`       |
| rawMaterial.update      | `updateRawMaterial(venueId, rawMaterialId, data: UpdateRawMaterialDto)`                   | `rawMaterial.service.ts:184`       |
| rawMaterial.delete      | `deactivateRawMaterial(venueId, rawMaterialId)`                                           | `rawMaterial.service.ts:306`       |
| rawMaterial.adjustStock | `adjustStock(venueId, rawMaterialId, data: AdjustStockDto, staffId?)`                     | `rawMaterial.service.ts:377`       |
| recipe.create           | `createRecipe(venueId, productId, data: CreateRecipeDto)`                                 | `recipe.service.ts:53`             |
| recipe.update           | `updateRecipe(venueId, productId, data: UpdateRecipeDto)`                                 | `recipe.service.ts:154`            |
| recipe.delete           | `deleteRecipe(venueId, productId)`                                                        | `recipe.service.ts:289`            |
| recipe.addLine          | `addRecipeLine(venueId, productId, data)`                                                 | `recipe.service.ts:321`            |
| recipe.removeLine       | `removeRecipeLine(venueId, productId, recipeLineId)`                                      | `recipe.service.ts:397`            |
| purchaseOrder.create    | `createPurchaseOrder(venueId, data: CreatePurchaseOrderDto, staffId?)`                    | `purchaseOrder.service.ts:264`     |
| purchaseOrder.approve   | `approvePurchaseOrder(venueId, purchaseOrderId, staffId?)`                                | `purchaseOrder.service.ts:523`     |
| purchaseOrder.receive   | `receivePurchaseOrder(venueId, purchaseOrderId, data: ReceivePurchaseOrderDto, staffId?)` | `purchaseOrder.service.ts:573`     |
| purchaseOrder.cancel    | `cancelPurchaseOrder(venueId, purchaseOrderId, reason?, _staffId?)`                       | `purchaseOrder.service.ts:739`     |
| product.adjustStock     | `adjustInventoryStock(venueId, productId, data: AdjustInventoryStockDto, staffId?)`       | `productInventory.service.ts:32`   |
| product.setMinimum      | **TO BUILD** — does not exist yet                                                         | N/A                                |
| product.create          | `createProduct(venueId, productData: CreateProductDto)`                                   | `product.dashboard.service.ts:404` |
| product.update          | `updateProduct(venueId, productId, productData: UpdateProductDto)`                        | `product.dashboard.service.ts:589` |
| product.delete          | `deleteProduct(venueId, productId, userId)` — userId is REQUIRED                          | `product.dashboard.service.ts:757` |

### Dependencies to build:

- `productInventoryService.setMinimumStock()` — thin wrapper, ~20 lines
- Extract `resolveCustomPermissionsForRole()` from `TextToSqlAssistantService` (currently private) to `src/lib/permissions.ts`
- Migration: `CREATE EXTENSION pg_trgm` + GIN indexes on RawMaterial.name, Product.name, Supplier.name
