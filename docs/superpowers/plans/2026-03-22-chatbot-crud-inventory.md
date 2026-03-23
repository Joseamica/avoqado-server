# Chatbot CRUD Engine — Inventory Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic Action Engine that lets users create, update, delete, and adjust inventory (raw materials, recipes, purchase
orders, product stock) via conversational chatbot — no forms unless truly necessary.

**Architecture:** Action Registry + Schema-Driven Engine. Declarative action definitions feed a generic engine that handles classification
(GPT-5.4 Mini), entity resolution (pg_trgm fuzzy match), validation (Zod), conversational field collection, preview/confirm, and execution
via existing services. Integrates into the existing text-to-SQL chatbot via a single hook.

**Tech Stack:** TypeScript, Express.js, Prisma, PostgreSQL (pg_trgm), OpenAI API (GPT-5.4 Mini/Nano), Zod, Jest

**Spec:** `docs/superpowers/specs/2026-03-22-chatbot-crud-inventory-design.md`

---

## File Map

### New files (all under `src/services/dashboard/chatbot-actions/`)

| File                                    | Responsibility                                                                                                                        | ~Lines |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `types.ts`                              | All interfaces: ActionDefinition, FieldDefinition, ActionContext, etc.                                                                | ~150   |
| `action-registry.ts`                    | Central Map of actionType → ActionDefinition. Auto-generates OpenAI tool schemas and Zod validators.                                  | ~200   |
| `action-classifier.service.ts`          | LLM calls: intent detection (Nano) + action classification (Mini function calling). Timeouts, circuit breaker, confidence thresholds. | ~300   |
| `entity-resolver.service.ts`            | `scopedFuzzySearch()` via pg_trgm. Two-hop resolution. venueId always from authContext.                                               | ~250   |
| `field-collector.service.ts`            | Detects missing fields. Conversation-first: asks naturally. Smart form fallback (>5 missing + complex enums, or user requests).       | ~200   |
| `action-preview.service.ts`             | Template-based previews. Diff for updates, impact for deletes. No LLM.                                                                | ~200   |
| `danger-guard.service.ts`               | Danger level checks. Double confirm for high. Block for blocked.                                                                      | ~80    |
| `action-engine.service.ts`              | Orchestrator: detect → classify → permission check → resolve → collect → validate → preview → confirm → execute.                      | ~500   |
| `definitions/inventory.actions.ts`      | RawMaterial CRUD + adjustStock definitions                                                                                            | ~250   |
| `definitions/recipe.actions.ts`         | Recipe CRUD + addLine/removeLine definitions                                                                                          | ~250   |
| `definitions/purchase-order.actions.ts` | PO create/approve/receive/cancel definitions                                                                                          | ~200   |
| `definitions/product-stock.actions.ts`  | Product adjustStock + setMinimum definitions                                                                                          | ~100   |
| `definitions/product-crud.actions.ts`   | Product create/update/delete (migration from hardcoded)                                                                               | ~150   |

### New test files

| File                                                                    | Tests                                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `tests/unit/services/dashboard/chatbot-actions/action-registry.test.ts` | Registry CRUD, Zod generation, OpenAI tool generation                                  |
| `tests/unit/services/dashboard/chatbot-actions/entity-resolver.test.ts` | Fuzzy match, two-hop, venueId scoping, no-match, multi-match                           |
| `tests/unit/services/dashboard/chatbot-actions/field-collector.test.ts` | Missing field detection, conversation vs form decision                                 |
| `tests/unit/services/dashboard/chatbot-actions/action-engine.test.ts`   | Full flow: detect → preview → confirm. Permission denied. Session expiry. Idempotency. |
| `tests/unit/services/dashboard/chatbot-actions/danger-guard.test.ts`    | Low/medium/high/blocked levels                                                         |
| `tests/integration/chatbot-actions/inventory-crud-flow.test.ts`         | E2E: message → classification → preview → confirm → DB verify                          |

### Modified files

| File                                                          | Change                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/services/dashboard/text-to-sql-assistant.service.ts`     | Add ~15-line hook in processQuery() to delegate to Action Engine           |
| `src/lib/permissions.ts`                                      | Extract `resolveCustomPermissionsForRole()` from TextToSqlAssistantService |
| `src/services/dashboard/productInventory.service.ts`          | Add `setMinimumStock()` thin wrapper (~20 lines)                           |
| `src/services/dashboard/prompt-injection-detector.service.ts` | Add Spanish injection patterns                                             |
| `prisma/migrations/`                                          | New migration: `CREATE EXTENSION pg_trgm` + GIN indexes                    |

---

## Task 1: Types & Interfaces

**Files:**

- Create: `src/services/dashboard/chatbot-actions/types.ts`

- [ ] **Step 1: Create the types file with all interfaces**

```typescript
// src/services/dashboard/chatbot-actions/types.ts
import { StaffRole } from '@prisma/client'

// ─── Field Definition ───
export interface FieldDefinition {
  type: 'string' | 'decimal' | 'integer' | 'boolean' | 'enum' | 'date' | 'reference'
  required: boolean
  prompt?: string
  options?: string[]
  default?: any
  min?: number
  max?: number
  transform?: 'uppercase' | 'lowercase' | 'trim'
  unique?: boolean
  referenceEntity?: string // For type: 'reference' — which entity to fuzzy match
}

// ─── List Field (for recipe lines, PO items) ───
export interface ListFieldDefinition {
  name: string
  itemFields: Record<string, FieldDefinition>
  minItems: number
  description: string
}

// ─── Entity Resolution Config ───
export interface EntityResolutionConfig {
  searchField: string
  scope: 'venueId'
  fuzzyMatch: boolean
  multipleMatchBehavior: 'ask' | 'first' | 'error'
  resolveVia?: {
    intermediateEntity: string
    intermediateField: string
    linkField: string
  }
}

// ─── Preview Template ───
export interface PreviewTemplate {
  title: string
  summary: string
  showDiff?: boolean
  showImpact?: boolean
}

// ─── Action Definition ───
export interface ActionDefinition {
  actionType: string
  entity: string
  operation: 'create' | 'update' | 'delete' | 'custom'
  permission: string
  dangerLevel: 'low' | 'medium' | 'high' | 'blocked'
  service: string
  method: string
  serviceAdapter?: (context: ActionContext, params: Record<string, any>, entityId?: string) => any[]
  description: string
  examples: string[]
  fields: Record<string, FieldDefinition>
  listField?: ListFieldDefinition
  entityResolution?: EntityResolutionConfig
  previewTemplate: PreviewTemplate
}

// ─── Runtime Context ───
export interface ActionContext {
  venueId: string
  userId: string
  role: StaffRole
  permissions: string[] | null
  ipAddress?: string
}

// ─── Classification Result ───
export interface ActionClassification {
  actionType: string
  params: Record<string, any>
  entityName?: string
  confidence: number
}

// ─── Detection Result ───
export interface DetectionResult {
  isAction: boolean
  domain?: string
  classification?: ActionClassification
}

// ─── Entity Match ───
export interface EntityMatch {
  id: string
  name: string
  score: number
  data?: Record<string, any>
}

export interface EntityResolutionResult {
  matches: number
  candidates: EntityMatch[]
  exact: boolean
  resolved?: EntityMatch
}

// ─── Preview ───
export interface ActionPreview {
  actionId: string
  actionType: string
  dangerLevel: 'low' | 'medium' | 'high'
  summary: string
  diff?: Record<string, { before: any; after: any }>
  impact?: { affectedRecipes?: number; stockValue?: number; details?: string }
  canConfirm: boolean
  expiresAt: number
}

// ─── Session ───
export interface PendingActionSession {
  actionId: string
  definition: ActionDefinition
  params: Record<string, any>
  targetEntity?: EntityMatch
  context: ActionContext
  preview: ActionPreview
  createdAt: number
  expiresAt: number
}

// ─── Response Types ───
export type ActionResponseType =
  | 'preview'
  | 'confirmed'
  | 'requires_input'
  | 'disambiguate'
  | 'not_found'
  | 'permission_denied'
  | 'expired'
  | 'error'
  | 'double_confirm'

export interface ActionResponse {
  type: ActionResponseType
  message: string
  preview?: ActionPreview
  missingFields?: string[]
  candidates?: EntityMatch[]
  entityId?: string
  actionId?: string
}

// ─── Dangerous param names to strip from LLM output ───
export const FORBIDDEN_LLM_PARAMS = ['venueId', 'orgId', 'userId', 'id', 'createdAt', 'updatedAt', 'deletedAt'] as const
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/services/dashboard/chatbot-actions/types.ts` Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/services/dashboard/chatbot-actions/types.ts
git commit -m "feat(chatbot-actions): add types and interfaces for Action Engine"
```

---

## Task 2: Action Registry

**Files:**

- Create: `src/services/dashboard/chatbot-actions/action-registry.ts`
- Test: `tests/unit/services/dashboard/chatbot-actions/action-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/dashboard/chatbot-actions/action-registry.test.ts
import { ActionRegistry } from '../../../../src/services/dashboard/chatbot-actions/action-registry'
import type { ActionDefinition } from '../../../../src/services/dashboard/chatbot-actions/types'

const mockAction: ActionDefinition = {
  actionType: 'test.entity.create',
  entity: 'TestEntity',
  operation: 'create',
  permission: 'test:create',
  dangerLevel: 'low',
  service: 'testService',
  method: 'create',
  description: 'Create a test entity',
  examples: ['crear test', 'agrega test'],
  fields: {
    name: { type: 'string', required: true, prompt: '¿Nombre?' },
    value: { type: 'decimal', required: true, min: 0, prompt: '¿Valor?' },
    category: { type: 'enum', required: false, options: ['A', 'B', 'C'] },
  },
  previewTemplate: { title: 'Crear Test', summary: '{{name}} — ${{value}}' },
}

describe('ActionRegistry', () => {
  beforeEach(() => ActionRegistry.clear())

  it('should register and retrieve an action', () => {
    ActionRegistry.register(mockAction)
    const result = ActionRegistry.get('test.entity.create')
    expect(result).toEqual(mockAction)
  })

  it('should return undefined for unregistered action', () => {
    expect(ActionRegistry.get('nonexistent')).toBeUndefined()
  })

  it('should generate OpenAI tool definitions for a domain', () => {
    ActionRegistry.register(mockAction)
    const tools = ActionRegistry.getToolDefinitions('test')
    expect(tools).toHaveLength(1)
    expect(tools[0].type).toBe('function')
    expect(tools[0].function.name).toBe('test.entity.create')
    expect(tools[0].function.parameters.required).toContain('name')
    expect(tools[0].function.parameters.required).toContain('value')
    expect(tools[0].function.parameters.required).not.toContain('category')
  })

  it('should generate Zod schema from field definitions', () => {
    ActionRegistry.register(mockAction)
    const schema = ActionRegistry.getZodSchema('test.entity.create')
    expect(schema).toBeDefined()

    const valid = schema!.safeParse({ name: 'Test', value: 10 })
    expect(valid.success).toBe(true)

    const invalid = schema!.safeParse({ name: '', value: -1 })
    expect(invalid.success).toBe(false)
  })

  it('should generate Zod errors in Spanish', () => {
    ActionRegistry.register(mockAction)
    const schema = ActionRegistry.getZodSchema('test.entity.create')!
    const result = schema.safeParse({ value: 5 })
    expect(result.success).toBe(false)
    if (!result.success) {
      const nameError = result.error.issues.find(i => i.path.includes('name'))
      expect(nameError?.message).toMatch(/requerid|obligatori/i)
    }
  })

  it('should list all actions for a domain', () => {
    ActionRegistry.register(mockAction)
    ActionRegistry.register({ ...mockAction, actionType: 'test.entity.update', operation: 'update' })
    ActionRegistry.register({ ...mockAction, actionType: 'other.entity.create' })
    const testActions = ActionRegistry.getByDomain('test')
    expect(testActions).toHaveLength(2)
  })

  it('should list all registered domains', () => {
    ActionRegistry.register(mockAction)
    ActionRegistry.register({ ...mockAction, actionType: 'inventory.rawMaterial.create' })
    expect(ActionRegistry.getDomains()).toEqual(expect.arrayContaining(['test', 'inventory']))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/services/dashboard/chatbot-actions/action-registry.test.ts --no-coverage` Expected: FAIL — module not found

- [ ] **Step 3: Implement ActionRegistry**

Create `src/services/dashboard/chatbot-actions/action-registry.ts`. Key methods:

- `register(definition)` — stores in a Map
- `get(actionType)` — retrieves by key
- `getByDomain(domain)` — filters by `actionType.split('.')[0]`
- `getDomains()` — unique first segments
- `getToolDefinitions(domain)` — converts fields to OpenAI function calling format
- `getZodSchema(actionType)` — auto-generates Zod schema from fields with Spanish error messages
- `clear()` — for testing

The Zod generator must:

- Use `z.string().min(1, { message: 'Este campo es requerido' })` for required strings
- Use `z.number().min(field.min, { message: 'El valor mínimo es ${field.min}' })` for min
- Use `z.enum(field.options, { errorMap: () => ({ message: 'Opción no válida' }) })` for enums
- Add `.refine(v => Number.isFinite(v), { message: 'Debe ser un número válido' })` for decimals

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/services/dashboard/chatbot-actions/action-registry.test.ts --no-coverage` Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/dashboard/chatbot-actions/action-registry.ts tests/unit/services/dashboard/chatbot-actions/action-registry.test.ts
git commit -m "feat(chatbot-actions): add ActionRegistry with Zod and OpenAI tool generation"
```

---

## Task 3: pg_trgm Migration + Entity Resolver

**Files:**

- Create: `prisma/migrations/<timestamp>_add_pg_trgm_for_chatbot_fuzzy_match/migration.sql`
- Create: `src/services/dashboard/chatbot-actions/entity-resolver.service.ts`
- Test: `tests/unit/services/dashboard/chatbot-actions/entity-resolver.test.ts`

- [ ] **Step 1: Create the pg_trgm migration**

Run: `npx prisma migrate dev --name add_pg_trgm_for_chatbot_fuzzy_match --create-only`

Then edit the generated migration.sql to contain:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_raw_material_name_trgm ON "RawMaterial" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_product_name_trgm ON "Product" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_supplier_name_trgm ON "Supplier" USING GIN (name gin_trgm_ops);
```

- [ ] **Step 2: Run migration**

Run: `npx prisma migrate dev` Expected: Migration applied successfully

- [ ] **Step 3: Write the failing test for EntityResolver**

Test file: `tests/unit/services/dashboard/chatbot-actions/entity-resolver.test.ts`

Test cases:

- `scopedFuzzySearch` always includes venueId in query
- Exact match (case-insensitive) returns score 1.0
- No match returns `{ matches: 0, candidates: [] }`
- Multiple matches returns sorted candidates
- Two-hop resolution (Product → Recipe)
- venueId from LLM params is NEVER used (stripped)
- SKU fallback when name match fails
- Active/deleted filtering per operation type

Note: Since this uses raw SQL, mock `prisma.$queryRaw` in unit tests. The integration test in Task 10 will test against a real DB.

- [ ] **Step 4: Implement EntityResolver**

Create `src/services/dashboard/chatbot-actions/entity-resolver.service.ts`. Key methods:

- `resolve(entity, searchTerm, venueId, config)` — main entry point
- `private scopedFuzzySearch(entity, term, venueId, threshold, activeFilter)` — ALL queries use `prisma.$queryRaw` with tagged template
  literals. NEVER `$queryRawUnsafe`.
- `private exactSearch(entity, term, venueId)` — case-insensitive exact match
- `private skuSearch(entity, term, venueId)` — fallback by SKU
- `private twoHopResolve(config, term, venueId)` — resolves via intermediate entity

CRITICAL: `venueId` ALWAYS comes from `context.venueId` (authContext). The `resolve()` method signature takes venueId explicitly and it is
used in EVERY query.

- [ ] **Step 5: Run tests**

Run: `npx jest tests/unit/services/dashboard/chatbot-actions/entity-resolver.test.ts --no-coverage` Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add prisma/migrations/ src/services/dashboard/chatbot-actions/entity-resolver.service.ts tests/unit/services/dashboard/chatbot-actions/entity-resolver.test.ts
git commit -m "feat(chatbot-actions): add pg_trgm migration and EntityResolver with fuzzy match"
```

---

## Task 4: Action Classifier (LLM Integration)

**Files:**

- Create: `src/services/dashboard/chatbot-actions/action-classifier.service.ts`
- Test: `tests/unit/services/dashboard/chatbot-actions/action-classifier.test.ts`

- [ ] **Step 1: Implement ActionClassifier**

Key methods:

- `detectIntent(message)` — GPT-5.4 Nano. Returns `{ intent: 'query' | 'action', domain?: string }`. Uses structured output
  (`response_format: { type: 'json_schema' }`). **Timeout: 5 seconds.**
- `classifyAction(message, context, domain)` — GPT-5.4 Mini. Function calling with tools from `ActionRegistry.getToolDefinitions(domain)`.
  **Timeout: 8 seconds.** Returns `ActionClassification` with confidence.
- Circuit breaker: Track consecutive failures. After 3, set `circuitOpen = true`. Auto-close after 60s.
- Model IDs from env vars: `process.env.CHATBOT_INTENT_MODEL || 'gpt-5.4-nano'` and
  `process.env.CHATBOT_CLASSIFICATION_MODEL || 'gpt-5.4-mini'`.
- Strip `FORBIDDEN_LLM_PARAMS` from extracted params before returning.
- Entity names in system prompt wrapped in `[ENTITY_DATA]...[/ENTITY_DATA]` delimiters.

System prompt for intent detection must include:

- "Si el mensaje contiene verbos como crear, agregar, eliminar, borrar, actualizar, cambiar, ajustar, recibir, aprobar, cancelar → intent =
  action"
- "Si el mensaje pregunta por datos, reportes, ventas, estadísticas, cuántos, cuánto → intent = query"
- Restaurant glossary: "merma = waste/shrinkage, comanda = order ticket, mise en place = prep"

- [ ] **Step 2: Write the unit test (mock OpenAI)**

Test file: `tests/unit/services/dashboard/chatbot-actions/action-classifier.test.ts`

Mock `openai.chat.completions.create()`. Test cases:

- `detectIntent("cuánto vendí ayer")` → `{ intent: 'query' }` (read, not action)
- `detectIntent("crea materia prima harina")` → `{ intent: 'action', domain: 'inventory' }` (mutation detected)
- `classifyAction("agrega carne 20kg a 180")` → returns correct actionType + params
- Timeout after 5s/8s → returns fallback error
- Circuit breaker opens after 3 failures → returns "asistente no disponible"
- Circuit breaker auto-closes after 60s
- `FORBIDDEN_LLM_PARAMS` stripped from extracted params (venueId, userId, id, etc.)
- Confidence below 0.85 → flagged in result
- Entity names in context wrapped in `[ENTITY_DATA]...[/ENTITY_DATA]` delimiters

- [ ] **Step 3: Run tests**

Run: `npx jest tests/unit/services/dashboard/chatbot-actions/action-classifier.test.ts --no-coverage` Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/dashboard/chatbot-actions/action-classifier.service.ts tests/unit/services/dashboard/chatbot-actions/action-classifier.test.ts
git commit -m "feat(chatbot-actions): add ActionClassifier with GPT-5.4 Mini/Nano, circuit breaker, confidence"
```

---

## Task 5: Field Collector (Conversation-First)

**Files:**

- Create: `src/services/dashboard/chatbot-actions/field-collector.service.ts`
- Test: `tests/unit/services/dashboard/chatbot-actions/field-collector.test.ts`

- [ ] **Step 1: Write the failing test**

Test cases:

- `getMissingFields(definition, extracted)` — returns array of missing required field names
- `shouldUseForm(definition, missing)` — returns false when ≤5 missing, true when >5 AND has complex enums
- `shouldUseForm` returns true when user message contains "formulario" or "form"
- `buildConversationalPrompt(definition, missing)` — returns natural Spanish question asking for ALL missing fields in one message
- When 1 field missing: "Solo me falta el SKU. ¿Cuál le ponemos?"
- When 3 fields missing: "Para completar necesito: el SKU, la unidad (kg, litros, piezas) y el costo por unidad. ¿Cuáles serían?"

- [ ] **Step 2: Implement FieldCollector**

Key methods:

- `getMissingFields(definition, extractedParams)` — compare against `fields` where `required: true`
- `shouldUseForm(definition, missingFields, userMessage?)` — conversation-first logic
- `buildConversationalPrompt(definition, missingFields)` — generates natural Spanish prompt. For enum fields, includes options inline. For 1
  field: direct question. For 2+: combines all in one natural sentence.

- [ ] **Step 3: Run tests**

Run: `npx jest tests/unit/services/dashboard/chatbot-actions/field-collector.test.ts --no-coverage` Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/dashboard/chatbot-actions/field-collector.service.ts tests/unit/services/dashboard/chatbot-actions/field-collector.test.ts
git commit -m "feat(chatbot-actions): add FieldCollector with conversation-first UX"
```

---

## Task 6: Preview Service + Danger Guard

**Files:**

- Create: `src/services/dashboard/chatbot-actions/action-preview.service.ts`
- Create: `src/services/dashboard/chatbot-actions/danger-guard.service.ts`
- Test: `tests/unit/services/dashboard/chatbot-actions/danger-guard.test.ts`

- [ ] **Step 1: Write danger guard test**

Test file: `tests/unit/services/dashboard/chatbot-actions/danger-guard.test.ts`

Test cases:

- `low` → returns `{ requiresConfirmation: true, requiresDoubleConfirm: false }`
- `medium` → same as low but `showChangeSummary: true`
- `high` → `{ requiresDoubleConfirm: true }`
- `blocked` → throws error "Esta operación no está disponible via chatbot"

- [ ] **Step 2: Implement DangerGuard**

`checkDanger(definition, context)` — returns confirmation requirements based on `definition.dangerLevel`.

- [ ] **Step 3: Write preview service test**

Test file: `tests/unit/services/dashboard/chatbot-actions/action-preview.test.ts`

Test cases:

- `renderTemplate("{{name}} — ${{costPerUnit}}", { name: "Carne", costPerUnit: 180 })` → `"Carne — $180"`
- `buildDiff({ costPerUnit: 180 }, { costPerUnit: 200 })` → `{ costPerUnit: { before: 180, after: 200 } }`
- `generatePreview` for create action → returns summary with all params
- `generatePreview` for update with `showDiff: true` → includes diff
- `generatePreview` for delete with `showImpact: true` → includes affected recipe count
- Preview stores `updatedAt` from target entity for optimistic locking on confirm
- Preview `expiresAt` is 15 minutes from now
- HTML/script tags in entity names are sanitized in preview output

- [ ] **Step 4: Implement ActionPreview**

Key methods:

- `generatePreview(definition, params, targetEntity, context)` — creates ActionPreview using template interpolation. No LLM calls.
- `renderTemplate(template, params, entity)` — replaces `{{field}}` placeholders with actual values.
- `buildDiff(currentEntity, newParams)` — for updates: `{ price: { before: 180, after: 200 } }`
- `calculateImpact(entity, entityId, venueId)` — for deletes: counts affected recipes, calculates stock value.
- Stores before/after state in preview for audit log.

- [ ] **Step 5: Run tests**

Run:
`npx jest tests/unit/services/dashboard/chatbot-actions/danger-guard.test.ts tests/unit/services/dashboard/chatbot-actions/action-preview.test.ts --no-coverage`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/dashboard/chatbot-actions/action-preview.service.ts src/services/dashboard/chatbot-actions/danger-guard.service.ts tests/unit/services/dashboard/chatbot-actions/danger-guard.test.ts tests/unit/services/dashboard/chatbot-actions/action-preview.test.ts
git commit -m "feat(chatbot-actions): add preview generation and danger guard"
```

---

## Task 7: Action Engine (Orchestrator)

**Files:**

- Create: `src/services/dashboard/chatbot-actions/action-engine.service.ts`
- Test: `tests/unit/services/dashboard/chatbot-actions/action-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Test the full flow with mocked dependencies (classifier, resolver, registry, preview, services). Test cases:

- Happy path: detect action → classify → resolve entity → validate → preview → confirm → execute
- Permission denied: user lacks required permission → returns `permission_denied` before LLM call
- Entity not found: fuzzy match returns 0 → returns `not_found`
- Disambiguation: fuzzy match returns 2+ → returns `disambiguate` with candidates
- Missing fields: returns `requires_input` with conversational prompt
- Session expiry: confirm after 15 min → returns `expired`
- Idempotency: same idempotencyKey → returns cached result
- Double confirm: high danger → returns `double_confirm` first time
- Circuit breaker open → returns error message
- venueId/userId stripped from LLM params

- [ ] **Step 2: Implement ActionEngine**

This is the main orchestrator (~500 lines). Methods:

- `detectAction(message, context)` — calls classifier.detectIntent(). If action, checks user has ANY mutation permission before calling
  classifier.classifyAction().
- `processAction(classification, context)` — registry lookup → permission check → entity resolution → field collection → validation →
  preview
- `generatePreview(definition, params, entity, context)` — delegates to ActionPreview. Stores pending session (Map, 15-min TTL, max 3 per
  user).
- `confirmAction(actionId, idempotencyKey, context)` — idempotency check → session validation → re-validate role from DB → **optimistic
  locking check** (for updates: verify entity `updatedAt` hasn't changed since preview; if changed, reject and force re-preview) → danger
  guard → execute via service → audit log (store before/after state) → cache result
- `private executeService(definition, params, entity, context)` — resolves service instance, calls serviceAdapter or default
  `service[method](venueId, ...params)` pattern within `prisma.$transaction()`.
- `private cleanupExpiredSessions()` — called on first request, then every 60s via `setInterval`.

Rate limiting tracked internally: 5 mutations/minute per user, 3 deletes/minute.

- [ ] **Step 3: Run tests**

Run: `npx jest tests/unit/services/dashboard/chatbot-actions/action-engine.test.ts --no-coverage` Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/dashboard/chatbot-actions/action-engine.service.ts tests/unit/services/dashboard/chatbot-actions/action-engine.test.ts
git commit -m "feat(chatbot-actions): add ActionEngine orchestrator with full flow"
```

---

## Task 8: Inventory Action Definitions

**Files:**

- Create: `src/services/dashboard/chatbot-actions/definitions/inventory.actions.ts`
- Create: `src/services/dashboard/chatbot-actions/definitions/recipe.actions.ts`
- Create: `src/services/dashboard/chatbot-actions/definitions/purchase-order.actions.ts`
- Create: `src/services/dashboard/chatbot-actions/definitions/product-stock.actions.ts`
- Create: `src/services/dashboard/chatbot-actions/definitions/product-crud.actions.ts`

- [ ] **Step 1: Create inventory.actions.ts (RawMaterial CRUD)**

4 actions: create, update, delete, adjustStock. Each with:

- `fields` derived from Prisma schema (see spec Section 17 for exact signatures)
- `serviceAdapter` mapping generic params to actual function signatures
- `examples` with clean Spanish, typos, spanglish variations
- `entityResolution` for update/delete/adjustStock

Read `src/services/dashboard/rawMaterial.service.ts` to get exact DTOs for field definitions. Read the Prisma schema for `RawMaterial` model
field types and constraints.

- [ ] **Step 2: Create recipe.actions.ts**

5 actions: create, update, delete, addLine, removeLine.

- All use two-hop entity resolution (`resolveVia: { intermediateEntity: 'Product', intermediateField: 'name', linkField: 'productId' }`)
- `createRecipe` and `addLine` use `listField` for ingredients
- Read `src/services/dashboard/recipe.service.ts` for exact DTOs

- [ ] **Step 3: Create purchase-order.actions.ts**

4 actions: create, approve, receive, cancel.

- Create needs supplier resolution (fuzzy match on Supplier.name)
- Receive uses `listField` for received items
- Read `src/services/dashboard/purchaseOrder.service.ts` for exact DTOs

- [ ] **Step 4: Create product-stock.actions.ts**

2 actions: adjustStock, setMinimum.

- Entity resolution on Product.name
- Read `src/services/dashboard/productInventory.service.ts` for adjustStock DTO

- [ ] **Step 5: Create product-crud.actions.ts**

3 actions: create, update, delete (migration from hardcoded `create_product`).

- Read `src/services/dashboard/product.dashboard.service.ts` for DTOs
- Note: `deleteProduct` requires `userId` (not optional) — serviceAdapter must pass it

- [ ] **Step 6: Create index file to register all definitions**

Create `src/services/dashboard/chatbot-actions/definitions/index.ts`:

```typescript
import { ActionRegistry } from '../action-registry'
import { inventoryActions } from './inventory.actions'
import { recipeActions } from './recipe.actions'
import { purchaseOrderActions } from './purchase-order.actions'
import { productStockActions } from './product-stock.actions'
import { productCrudActions } from './product-crud.actions'

export function registerAllActions() {
  ;[...inventoryActions, ...recipeActions, ...purchaseOrderActions, ...productStockActions, ...productCrudActions].forEach(action =>
    ActionRegistry.register(action),
  )
}
```

- [ ] **Step 7: Commit**

```bash
git add src/services/dashboard/chatbot-actions/definitions/
git commit -m "feat(chatbot-actions): add all 21 inventory action definitions"
```

---

## Task 9: Dependencies & Integration Hook

**Files:**

- Modify: `src/lib/permissions.ts`
- Modify: `src/services/dashboard/productInventory.service.ts`
- Modify: `src/services/dashboard/prompt-injection-detector.service.ts`
- Modify: `src/services/dashboard/text-to-sql-assistant.service.ts`

- [ ] **Step 1: Extract resolveCustomPermissionsForRole to permissions.ts**

Read the private method in `text-to-sql-assistant.service.ts` (~line 4898). Copy it to `src/lib/permissions.ts` as an exported function.
Update the original service to import from permissions.ts instead.

- [ ] **Step 2: Add setMinimumStock to productInventory.service.ts**

Read `src/services/dashboard/productInventory.service.ts`. Add a thin wrapper:

```typescript
export async function setMinimumStock(venueId: string, productId: string, minimum: number) {
  return prisma.inventory.update({
    where: { productId, product: { venueId } },
    data: { minimumStock: minimum },
  })
}
```

- [ ] **Step 3: Add Spanish injection patterns to prompt-injection-detector**

Read `src/services/dashboard/prompt-injection-detector.service.ts`. Add to the regex patterns array:

```typescript
/\b(ignora|olvida|desconsidera)\b.{0,30}\b(instrucciones|reglas|sistema)\b/i,
/\b(ahora\s+eres|actua\s+como|pretende\s+ser)\b/i,
/\b(muestra|dame|revela)\b.{0,20}\b(prompt|instrucciones|sistema)\b/i,
```

- [ ] **Step 4: Add the Action Engine hook in text-to-sql-assistant.service.ts**

Read the `processQuery()` method. After the existing security checks (prompt injection, semantic injection) and BEFORE the existing
`detectCreateProductIntent` check, add:

```typescript
// ── Action Engine Hook ──
if (CHATBOT_MUTATIONS_ENABLED) {
  const detection = await this.actionEngine.detectAction(query.message, {
    venueId: query.venueId,
    userId: query.userId,
    role: query.userRole,
    permissions: await resolveCustomPermissionsForRole(query.venueId, query.userRole),
    ipAddress: query.ipAddress,
  })

  if (detection.isAction && detection.classification) {
    return this.actionEngine.processAction(detection.classification, {
      venueId: query.venueId,
      userId: query.userId,
      role: query.userRole,
      permissions: await resolveCustomPermissionsForRole(query.venueId, query.userRole),
      ipAddress: query.ipAddress,
    })
  }
}
```

Also: import ActionEngineService and instantiate it. Call `registerAllActions()` on service init.

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `npx jest tests/unit/services/dashboard/text-to-sql-assistant.test.ts --no-coverage` Expected: ALL EXISTING TESTS PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/permissions.ts src/services/dashboard/productInventory.service.ts src/services/dashboard/prompt-injection-detector.service.ts src/services/dashboard/text-to-sql-assistant.service.ts
git commit -m "feat(chatbot-actions): integrate Action Engine hook into text-to-sql pipeline"
```

---

## Task 10: Controller Generalization

**Files:**

- Modify: `src/controllers/dashboard/text-to-sql-assistant.controller.ts`
- Modify: `src/routes/dashboard.routes.ts`

- [ ] **Step 1: Read existing controller and route endpoints**

Read `src/controllers/dashboard/text-to-sql-assistant.controller.ts` — look at `previewAssistantAction()` and `confirmAssistantAction()`
methods. These are currently hardcoded for `create_product`. They need to delegate to the generic Action Engine.

Read `src/routes/dashboard.routes.ts` — look at the `/assistant/actions/preview` and `/assistant/actions/confirm` routes (~line 7395-7414).

- [ ] **Step 2: Generalize the controller methods**

Update `previewAssistantAction()`:

- Accept any `actionType` (not just `'create_product'`)
- Delegate to `actionEngine.processAction()` for previews
- Keep the existing Zod schema validation but extend `assistantActionPreviewSchema` to accept any registered actionType

Update `confirmAssistantAction()`:

- Delegate to `actionEngine.confirmAction()`
- Keep the existing request validation

- [ ] **Step 3: Update Zod schemas in `src/schemas/dashboard/assistant.schema.ts`**

Read the file. Update `assistantActionPreviewSchema`:

- Change `actionType: z.literal('create_product')` to `actionType: z.string().min(1, 'El tipo de acción es requerido')`
- Keep `draft` as optional any object (the Action Engine handles validation per action type)

- [ ] **Step 4: Run existing tests**

Run: `npx jest tests/unit/services/dashboard/text-to-sql-assistant.test.ts --no-coverage` Expected: ALL PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add src/controllers/dashboard/text-to-sql-assistant.controller.ts src/routes/dashboard.routes.ts src/schemas/dashboard/assistant.schema.ts
git commit -m "feat(chatbot-actions): generalize controller endpoints for any action type"
```

---

## Task 11: Integration Tests (E2E Flow)

**Files:**

- Create: `tests/integration/chatbot-actions/inventory-crud-flow.test.ts`

- [ ] **Step 1: Write integration test**

This test exercises the full flow against a real database (following the pattern in `tests/integration/inventory/`). Mock only the OpenAI
API calls.

Test scenarios:

1. **Create raw material**: Message "agrega carne molida, 20kg a $180/kg, SKU CARNE01" → preview → confirm → verify RawMaterial exists in DB
2. **Update raw material**: Message "cambia el precio de la carne a 200" → fuzzy match finds "Carne Molida" → preview shows diff (180→200) →
   confirm → verify DB updated
3. **Adjust stock**: Message "llegaron 10kg de carne" → preview → confirm → verify stock increased
4. **Delete raw material**: Message "elimina la carne molida" → preview shows impact → double confirm → verify deactivated
5. **Permission denied**: WAITER role sends "elimina carne" → blocked before LLM call
6. **Entity not found**: "actualiza el arroz" when no arroz exists → returns not_found
7. **Disambiguation**: Two products with "carne" → returns candidates list
8. **Query NOT intercepted**: "cuánta carne se usó ayer" → goes to text-to-SQL, not Action Engine

- [ ] **Step 2: Run integration test**

Run: `npx jest tests/integration/chatbot-actions/inventory-crud-flow.test.ts --no-coverage` Expected: ALL PASS

- [ ] **Step 3: Run full test suite for regressions**

Run: `npm test` Expected: ALL EXISTING TESTS STILL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/integration/chatbot-actions/
git commit -m "test(chatbot-actions): add integration tests for inventory CRUD flow"
```

---

## Task 12: Format, Lint, Pre-deploy

- [ ] **Step 1: Format and lint**

Run: `npm run format && npm run lint:fix`

- [ ] **Step 2: Run pre-deploy**

Run: `npm run pre-deploy` Expected: PASS (all checks green)

- [ ] **Step 3: Fix any issues found and re-run**

- [ ] **Step 4: Final commit**

```bash
git add src/services/dashboard/chatbot-actions/ tests/unit/services/dashboard/chatbot-actions/ tests/integration/chatbot-actions/ src/lib/permissions.ts src/services/dashboard/productInventory.service.ts src/services/dashboard/prompt-injection-detector.service.ts src/services/dashboard/text-to-sql-assistant.service.ts src/controllers/dashboard/text-to-sql-assistant.controller.ts src/schemas/dashboard/assistant.schema.ts src/routes/dashboard.routes.ts
git commit -m "chore: format and lint chatbot-actions module"
```

---

## Execution Order & Dependencies

```
Task 1 (Types)
    │
    ▼
Task 2 (Registry) ──────────┐
    │                        │
    ▼                        ▼
Task 3 (Migration + Resolver)    Task 4 (Classifier)    Task 5 (Field Collector)
    │                        │                          │
    └────────────┬───────────┘──────────────────────────┘
                 │
                 ▼
         Task 6 (Preview + Danger Guard)
                 │
                 ▼
         Task 7 (Action Engine)
                 │
                 ▼
         Task 8 (Definitions)
                 │
                 ▼
         Task 9 (Integration Hook + Dependencies)
                 │
                 ▼
         Task 10 (Controller Generalization)
                 │
                 ▼
         Task 11 (E2E Tests)
                 │
                 ▼
         Task 12 (Lint + Pre-deploy)
```

**Parallelizable:** Tasks 3, 4, 5 can run in parallel after Task 2. **Sequential:** Tasks 7-12 must be sequential.
