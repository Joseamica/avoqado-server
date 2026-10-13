# CLAUDE.md - Avoqado Server (Backend)

Multi-tenant B2B SaaS for restaurant/venue management (POS, payments, inventory, staff). Express.js + TypeScript, PostgreSQL/Prisma,
Socket.IO, RabbitMQ. **No Redis** (founder, 21-sep-2026): prod runs ONE instance; locks → `pg_advisory_xact_lock`, shared state → a
Postgres row with CAS, cache → in-process memory with TTL. Payments via Blumon (TPV + E-commerce) and Stripe (subscriptions).

> **Reglas de entorno** — sesiones de IA en paralelo, y cuándo verificar según la carga de la máquina — están en el `CLAUDE.md` del
> workspace (`../CLAUDE.md`), que auto-carga junto con este archivo. Léelas antes de correr builds/tests o de tocar git.

**Verificación dual OAuth:** `avq-verify` no copia `.env`; si divergen los dos casos de recurso consentido, comprueba los orígenes públicos
con las mismas entradas explícitas de prueba en ambas máquinas, sin transferir secretos. El diagnóstico `SXNqUO` pasó 23/23 por lado;
eso no vuelve verde el shard original ni autoriza quitar una bandera previa de DIFIEREN.
**Presupuestos event-loop:** conserva el límite y repite sólo el archivo cuando diverge; el probe usa el mínimo de tiempo de pared y CPU
del hilo, así que no atribuyas el fallo sólo a descheduling. `qnKCre` pasó en ambas máquinas después del fallo Mac de `5VEMi3`; el shard
sigue DIFIEREN y la causa no quedó demostrada. No elevar el presupuesto ni normalizar esa diferencia como aprobación.

## 🔴 CRITICAL — Ask which payment tier (and how it gets turned on) BEFORE building or changing anything

Avoqado is a tier-gated SaaS (**FREE · PRO · PREMIUM · ENTERPRISE**). Whenever you add a new feature, modify existing behavior, or expose a
new capability, **STOP and ask the founder which paid tier it falls under** — then wire the gating to match. A change shipped without a tier
decision is unfinished: it either leaks paid value into a lower tier or hides a free capability behind a paywall. This repo is the
**authoritative** gate — get it right here first.

- **Backend (authoritative):** `src/services/access/basePlan.service.ts` + `src/middlewares/checkFeatureAccess.middleware.ts`. Obligatory
  gating questions live in `.claude/rules/feature-gating.md` (Module vs Feature decision). PREMIUM-only codes: read
  `PREMIUM_ONLY_CODES` in `basePlan.service.ts` (CFDI, INVENTORY_TRACKING, COMMISSIONS and more) — never trust a copy in a doc.
  COMMISSIONS is DUAL-GRANTED (module OR plan; `basePlan.service.ts` ~line 480).
- **Module vs Feature — use the RIGHT resolver (crossing them fails silently; grandfathered venues pass a wrong-system gate):** `Module`
  codes (`SERIALIZED_INVENTORY`, `WHITE_LABEL_DASHBOARD`, `COMMISSIONS`) gate via `moduleService.isModuleEnabled` (incl. org-level
  fallback); `Feature` codes (`INVENTORY_TRACKING`, `CFDI`, `ADVANCED_REPORTS`…) via `venueHasFeatureAccess`. **Every MCP
  serialized-inventory tool (`src/mcp/tools/`) MUST gate with `isModuleEnabled(SERIALIZED_INVENTORY)`** — never the Feature/tier resolver;
  only serialized tools carry it (per-tool gating, not coupled to white-label). Full rule: `.claude/rules/feature-gating.md`.
- **Display/CTA map + enforcement:** `avoqado-web-dashboard/src/config/plan-catalog.ts` (`getTierForFeature()` → FeatureGate upsell) — the
  dashboard is still the ONLY client enforcing tiers; iOS/Android will mirror the codes by exact name (a mismatch fails silently).
- **Activación (regla completa en `../CLAUDE.md` + `.claude/rules/feature-gating.md`):** este repo es el gate EFECTIVO — compón tier **AND**
  módulo **AND** ajuste del venue (`VenueSettings`) **AND** permiso. La respuesta 4xx debe decir QUÉ falta y CÓMO activarlo, para que cada
  cliente pueda pintar el mensaje sin adivinar; un 403 pelón obliga a los 6 clientes a inventarse el texto.

## Comparar con el mercado antes de decidir un diseño

Regla completa en `../CLAUDE.md` (auto-carga con este archivo). En corto: **cuando una decisión admite más de una respuesta defendible, mira
cómo la resuelve el referente del dominio y trae ambas versiones al reporte.** Aplica también aquí, no sólo a la UI: el caso que la originó
fue de este repo —bloqueábamos la venta y revertíamos la orden a PENDING cuando el stock no alcanzaba, mientras Square deja el stock ir a
negativo **a propósito** para no impedir un cobro; contradecía nuestra propia regla `payments.md` ("Non-blocking: payment succeeds even if
deduction fails").

**No aplica a un defecto objetivo** —dinero que no cuadra, fecha corrida, crash, tenant mal filtrado— ni a trabajo interno (refactor, tests,
observabilidad, migraciones), ni a lo que no tiene equivalente: CFDI/SAT, Blumon, PlayTelecom, el MCP. Y **nunca bloquea**: timebox de ~15
min, y si no hay evidencia se escribe "no encontré cómo lo resuelve X" y se sigue.

## Sister Repos (this repo is the hub of 10)

`avoqado-server` is the backend hub; 9 client repos talk to it over `/api/v1/`. Full ecosystem map: workspace-root `../CLAUDE.md`.

- **avoqado-web-dashboard** — React admin dashboard (venue owners/staff)
- **avoqado-tpv** — Kotlin app, card payment processing on PAX terminals
- **avoqado-android** / **avoqado-ios** — POS apps (menu/orders/tables) on tablets & phones
- **avoqado-consumer-app** — React Native app, customers book appointments
- **avoqado-booking-widget** — embeddable `<avoqado-booking>` web component
- **avoqado-checkout** — hosted online payment page (Stripe + MercadoPago)
- **avoqado-landing** — Astro marketing site
- **avoqado-windows-service** — bridges an external SoftRestaurant POS in via RabbitMQ

**Namespace ownership — know which clients share an endpoint before touching it:** `avoqado-ios` and `avoqado-android` (the staff-facing POS
apps) consume mainly the **`/api/v1/mobile/*`** namespace (controllers under `src/controllers/mobile/`), **but they ALSO call some
`/api/v1/dashboard/*` routes** (verified 9-oct-2026: `venues/:id`, products, discounts, referrals capture/validate/force-override,
reservations + waitlist, class-sessions, inventory raw-materials and inter-venue-transfers). The dashboard namespace
(`src/controllers/dashboard/`) is consumed by `avoqado-web-dashboard`, by those app calls, and by the legacy `avoqado-desktop`. Both apps
are developed in parallel by other LLM-agent sessions right now — before changing a `/mobile` controller/service/schema, re-verify its
current contract directly in source (never from memory or an earlier session). **Before changing a `/dashboard` route, grep both apps**
(`grep -rn "dashboard/venues" ../avoqado-android/app/src ../avoqado-ios/avoqado-ios`): if they call it, it carries the same risk as
`/mobile`. Also grep for other callers of any service function before assuming a fix is dashboard-only.

## How This Configuration Works

| Layer         | Location         | Loaded                  | Purpose                        |
| ------------- | ---------------- | ----------------------- | ------------------------------ |
| **Rules**     | `.claude/rules/` | **Auto**, every session | Guardrails you MUST follow     |
| **This file** | `CLAUDE.md`      | **Auto**, every session | Architecture & navigation      |
| **Guides**    | `docs/guides/`   | On-demand               | Dense operational cheat sheets |
| **Agents**    | `AGENTS.md`      | On-demand               | Role definitions for subagents |
| **Full docs** | `docs/`          | On-demand               | Complete reference (70+ files) |

When rules conflict: `.claude/rules/` wins > this file > `docs/guides/` > `docs/`

**Maintaining this file:** Short rules (1-3 lines) go directly here. Detailed content (code examples, tables, >10 lines) goes in `docs/` or
`.claude/rules/`. Keep this file under ~200 lines — it loads every session.

Note: Some rules are **path-conditional** (e.g., `payments.md` only loads when editing payment-related files). Check each rule's YAML
`paths:` frontmatter.

## Architecture

```
Routes → Middleware → Controllers (thin) → Services (business logic) → Prisma (DB)
```

| Layer       | Location           | Does                               | Does NOT       |
| ----------- | ------------------ | ---------------------------------- | -------------- |
| Routes      | `src/routes/`      | Endpoint definitions               | Business logic |
| Controllers | `src/controllers/` | Extract req, call service, respond | DB access      |
| Services    | `src/services/`    | Validations, calculations, DB ops  | HTTP concerns  |
| Middlewares | `src/middlewares/` | Auth, permissions, logging         | Business logic |

Multi-tenant: Organization → Venue → All data scoped by `venueId`.

Services: `dashboard/` (admin), `tpv/` (POS terminals), `pos-sync/` (legacy SoftRestaurant), `sdk/` (e-commerce), `modules/` (feature
flags), `pricing/` (MCC lookup), `serialized-inventory/` (unique barcodes), `access/` (permission resolution), `command-center/` (analytics
dashboard), `dashboard/commission/` (sales goals, tiers, payouts, clawbacks).

## Blumon: TWO Separate Integrations

**Always say "Blumon TPV" or "Blumon E-commerce". Never just "Blumon".** They are different APIs, different models, different services.
Details auto-load via `.claude/rules/payments.md` when editing payment files. Full docs: `docs/BLUMON_TWO_INTEGRATIONS.md`

## Roles (Two Levels)

**Org-level** (`OrgRole` on `StaffOrganization`): OWNER, ADMIN, MEMBER, VIEWER. **Venue-level** (`StaffRole` on `StaffVenue`): SUPERADMIN >
OWNER > ADMIN > MANAGER > CASHIER > WAITER > KITCHEN > HOST > VIEWER.

Multi-org: Staff → multiple orgs via `StaffOrganization` (junction, `OrgRole` + `isPrimary`).

Permissions: Use `checkPermission('resource:action')`, NOT `authorizeRole` (legacy, ~7 routes remain). Deep dive:
`docs/guides/PERMISSIONS_GUIDE.md`

## Commands

```bash
npm run dev            # Dev server (hot reload)
npm run build          # Compile TypeScript
npm run pre-deploy     # CI/CD sim — pesado: va por ../scripts/avq-verify.sh o el carril ci/<tema>, nunca a pelo
npm test               # All tests — pesado: igual (ver «Verificación repartida» en ../CLAUDE.md)
npm run test:unit      # Unit tests
npm run test:api       # API integration
npm run test:workflows # E2E workflows
npm run lint:fix       # Auto-fix ESLint
npm run format         # Prettier
npm run studio         # Prisma Studio
```

After editing code: `npm run format && npm run lint:fix`

## 🔴 "¿Está en el cajón?" y "¿lo deposita Avoqado?" — SIEMPRE por `tenderSemantics`

`src/services/shared/tenderSemantics.ts` es la ÚNICA respuesta a esas dos preguntas (`paymentCountsAsDrawerCash` /
`paymentIsAvoqadoSettled`, con `TENDER_SEMANTICS_SELECT` para el `select`). **Nunca escribas un `method === 'CASH'` / `method !== 'CASH'`
local**: así nacieron las tres definiciones distintas de "efectivo esperado" que no coincidían entre closeout, turno TPV y CashDrawerEvent.
La autoridad es `Payment.fundsFlow` (server-owned, estampado por el punto de entrada que cobró) → snapshot del tender → fallback legacy.
**La ausencia de `externalSource` NO es autoridad financiera** (auditoría 2026-08-15): un pago manual `BANK_TRANSFER` sin merchant no es
dinero que Avoqado vaya a depositar.

## Key Business Flow: Order → Payment → Inventory

Stock deduction ONLY when fully paid, FIFO (oldest first), non-blocking. Full rules auto-load via `.claude/rules/payments.md` when editing
payment files. Deep dive: `docs/guides/PAYMENT_FLOW_GUIDE.md`

## Module Config Schemas (CRITICAL - Common Bug)

When modifying module configs (especially `WHITE_LABEL_DASHBOARD`), **ALWAYS check the `configSchema`** stored in the `Module` table. AJV
validates configs at runtime against this schema. If you add/rename fields in the config object but don't update the schema, the API will
reject the update with cryptic "should have required property" errors. Schema is defined in `scripts/setup-modules.ts` — after editing,
re-run the script to update the DB.

## Data Inserts (any DB, any tool): IDs MUST be cuid v1

Whenever you create records outside Prisma's `create` — SQL, psql, scripts, seeds, imports, demo data, local OR production — **always
generate IDs as cuid v1** (25 chars, prefix `c`) to match Prisma's `@default(cuid())`. Never cuid2 (`@paralleldrive/cuid2` starts with
any letter), UUIDs, or custom prefixes like `mindf_hh_001`: the `z.string().cuid()` validators reject them with a 400 the dashboard
shows as a generic error (IQ, 13-oct-2026: 273 of 281 products created on 6-may with random ids could not print labels). Use the `cuid`
package: `npm install --no-save cuid && node -e "console.log(require('cuid')())"`. Before applying, check every generated id matches
`^c[a-z0-9]{24}$`. FKs with `ON UPDATE CASCADE` (Product→MenuCategory, Inventory→Product) allow safe id rewrites in a transaction if you
forget upfront.

## Cross-Repo (TPV Android)

Backend ALWAYS supports old TPV versions. NEVER remove API response fields. New fields must be optional with defaults. Deploy backend first,
wait stable, then APK. TPV sends `X-App-Version-Code` for conditional behavior.

## Server Capacity Is a Contract

Every new or changed list endpoint must stay bounded at 10×/100× current tenant volume without silently hiding data from clients. Enforce
the maximum on the server, paginate with stable ordering, aggregate cards in the database, and keep search/filtering server-side. Preserve
old response contracts; exports may walk bounded pages only after an explicit user action. The mandatory design, indexing, testing, and
canary checklist is in `.claude/rules/bounded-queries-and-server-load.md`.

## Documentation Router

### Auto-loaded rules (`.claude/rules/`)

- `critical-warnings.md` - authContext, tenant isolation, money, webhooks, storage, migrations, Zod Spanish messages
- `testing-and-git.md` - Regression prevention, git policy, test workflow
- `bounded-queries-and-server-load.md` - Mandatory bounded endpoints, stable pagination, aggregate cards, indexes, compatibility, and canary
  checks
- `payments.md` - Payment/inventory rules (path-conditional: `src/services/tpv/**`, `src/services/dashboard/rawMaterial*`)
- `cron-jobs.md` - Cron jobs MUST wrap entry DB read with `retry(..., shouldRetryDbConnectionError)` (path-conditional: `src/jobs/**`).
  Prevents top-of-hour P1001 stampede deaths. NO global Prisma retry.
- `contexto-de-ejecucion.md` - AsyncLocalStorage: TODO `logger.*` de un request emite `venueId`/`userId`/`correlationId`/`entrypoint` sin
  pasarlos. Un wrapper de contexto NUNCA atrapa errores. Cómo filtrar el log por negocio en vez de por reloj
- `feature-gating.md` - Module vs Feature: two parallel gating systems, don't cross the resolvers
- `playtelecom-vertical.md` - PlayTelecom white-label vertical: who's who (Bait/Walmart), generic vs bespoke, gotchas
- `blumon-seriales-virtuales.md` - 🔴 el dígito extra en `MerchantAccount.blumonSerialNumber` NO es typo: es multi-merchant deliberado. "¿Es
  nuestro?" = `Terminal` OR `MerchantAccount`, nunca solo una

### On-demand guides (`docs/guides/`)

- `PERMISSIONS_GUIDE.md` - Override/merge modes, adding features checklist
- `PAYMENT_FLOW_GUIDE.md` - FIFO logic, edge cases, debugging
- `EMAIL_STANDARDS.md` - Template specs, HTML structure

### Full reference (`docs/`)

| Topic                   | File                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| All docs index          | `docs/README.md`                                                             |
| Architecture            | `docs/ARCHITECTURE_OVERVIEW.md`                                              |
| Schema map (START HERE) | `docs/SCHEMA_MAP.md` — all models by domain (auto-gen: `npm run schema:map`) |
| Database schema (full)  | `docs/DATABASE_SCHEMA.md`                                                    |
| Permissions system      | `docs/PERMISSIONS_SYSTEM.md`                                                 |
| Blumon TPV              | `docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md`                                  |
| Blumon E-commerce       | `docs/blumon-ecommerce/REFACTORING_COMPLETE.md`                              |
| Payment architecture    | `docs/PAYMENT_ARCHITECTURE.md`                                               |
| Stripe                  | `docs/STRIPE_INTEGRATION.md`                                                 |
| Inventory (FIFO)        | `docs/INVENTORY_REFERENCE.md`                                                |
| Serialized inventory    | `docs/features/SERIALIZED_INVENTORY.md`                                      |
| Chatbot/Text-to-SQL     | `docs/CHATBOT_TEXT_TO_SQL_REFERENCE.md`                                      |
| Terminal IDs            | `docs/TERMINAL_IDENTIFICATION.md`                                            |
| TPV commands            | `docs/TPV_COMMAND_SYSTEM.md`                                                 |
| Team invitations        | `docs/features/TEAM_INVITATIONS.md`                                          |
| Login scenarios         | `docs/features/LOGIN_SCENARIOS.md`                                           |
| Industry config         | `docs/industry-config/README.md`                                             |
| Business types/MCC      | `docs/BUSINESS_TYPES.md`                                                     |
| Settlement incidents    | `docs/features/SETTLEMENT_INCIDENTS.md`                                      |
| Commissions/Goals       | `src/services/dashboard/commission/` (no doc yet)                            |
| Datetime/timezone       | `docs/DATETIME_SYNC.md`                                                      |
| Production checklist    | `docs/PRODUCTION_READINESS_CHECKLIST.md`                                     |

## 🔴 CRITICAL — Two MCPs: keep the CUSTOMER MCP in sync (do NOT confuse them)

Avoqado has **two separate MCP servers**. Confusing them causes branch chaos — be exact:

| MCP                          | Path           | What it is                                                                                                    | Where it lives                   |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Customer MCP** ← this rule | `src/mcp/`     | Customer-facing **product**: Streamable HTTP + OAuth, scoped by `getUserAccess()`. New feature tools go HERE. | `develop` (deployed)             |
| **Admin MCP**                | `scripts/mcp/` | **Internal** founder-ops tool (stdio, Prisma-direct). Separate lifecycle.                                     | only `feat/admin-mcp` (unmerged) |

**This rule targets the CUSTOMER MCP (`src/mcp/`).** Whenever you add or change a feature, Prisma model, service, endpoint, permission, or
any capability an operator should be able to read (later: act on), add or update the matching tool in **`src/mcp/tools/`** (on `develop`),
registered in `src/mcp/server.ts`, as part of the SAME change — never "later". A capability not reachable through the customer MCP is
unfinished. Treat it like permissions: kept in lockstep.

**Do NOT** add product feature tools to the admin MCP (`scripts/mcp/`), and **do NOT** merge `feat/admin-mcp` into develop just to add a
tool — it is a separate internal tool, not driven by this rule.

**Qué protege al MCP de un cliente hostil (no es el modelo — es el servidor):** (1) `guard` por venue/permiso en cada tool; (2)
`mcp-rate-limit.middleware.ts` en `POST /mcp` — techo de volumen por staff/org/IP, configurable con `MCP_{STAFF,ORG,IP}_RATE_LIMIT_MAX`,
responde JSON-RPC y **nunca** tumba el MCP si él mismo falla; (3) `instrument.ts` sanea los errores internos por AMBAS salidas —lanzados y
devueltos como `ok:false`— dejando pasar los mensajes escritos para el operador; (4) `avoqado_internal_docs` sólo se registra si
`scope.isSuperAdmin`. Hay un test que barre las ~250 descripciones del catálogo (`tests/unit/mcp-customer/catalog-no-internals.test.ts`): si
tu tool nueva menciona Prisma, una tabla o `Modelo.campo`, falla ahí — el catálogo lo lee **todo** cliente conectado.

**Every customer-MCP tool MUST honor these invariants** (full detail in `.claude/rules/critical-warnings.md`): (1) **money in PESOS, 1:1** —
inputs/outputs in major units (`150.50`), NEVER cents (`* 100` only at Stripe/CFDI/provider boundaries; ledger `…Cents` fields convert ÷100
before returning); (2) **dates are VENUE-LOCAL** — via `getVenueChartData` / `venueStartOfDay` / `parseDbDateRange`, never a bare
`new Date('YYYY-MM-DD')`; (3) money tools must cuadrar to the cent (`scripts/mcp-money-reconcile.ts`); (4) **writes are SAFE against a vague
LLM-driven request** — always `requirePermission` (exact action) + `venueFilter` + `auditMcpWrite`

- resolve-don't-guess on ambiguity; **high-impact / hard-to-reverse writes** (money out, plan/billing, prices, menu availability, bulk) MUST
  be **two-step confirm-gated** with a human-readable `current → new` preview (`confirm:true` to execute). When unsure, confirm-gate it.

## 🔴 CRITICAL — Audit mutations with ActivityLog

Every **audit-worthy mutation** — create/update/delete of domain entities, money ops, access/permission changes, **superadmin overrides**
(plan activate/deactivate, grant-trial, adjust-end-date), and status changes — MUST write an `ActivityLog` row (`action`, `entity`,
`entityId`, `staffId` from authContext, `venueId`, `data`) in the SAME change, never "later". A mutating endpoint without `ActivityLog` is
unfinished (treat it like permissions/MCP: kept in lockstep). Do NOT log reads or high-frequency events (heartbeats, scans, request logging)
— that just bloats the audit trail. **If a mutation already writes to a SILOED audit/event table (`OrderAction`,
`SerializedItemCustodyEvent`, `InventoryMovement`/`RawMaterialMovement`…), DUAL-WRITE to `ActivityLog` too** — the owner audit screen reads
ONLY `ActivityLog`, so siloed-only writes are invisible to it. Stamp `venueId` on org-level events + thread the actor (`performedBy`) from
the controller. Full rule + examples: `.claude/rules/critical-warnings.md`. (Backend-only — clients call the API; `avoqado-server` audits.)

## 🔴 Offline-first (reducer de intents) — LEE `.claude/rules/offline-first-y-hub-lan.md`

Este repo es la FUENTE DE VERDAD del contrato: `SyncIntentType` en `src/services/mobile/sync.mobile.service.ts` (15 tipos hoy). Agregar o
cambiar uno obliga a tocar Android, iOS y el MCP `pos_sync_status` en el MISMO cambio — un nombre desalineado falla en silencio.

Tres cosas que no se negocian:

- El reducer reutiliza los MISMOS servicios que la ruta online: el feature gating y la propiedad de mesa se evalúan por intent. Sincronizar
  NO es puerta trasera.
- `RETRY` (transitorio) ≠ `REJECTED` (permanente). Convertir uno en otro pierde el intent para siempre.
- Dinero: `PAY_CASH` deduplica por `[venueId, idempotencyKey]` y `ADD_ITEMS` usa CAS real sobre `version`. Sin eso, un reintento cobra dos
  veces.

> Reglas del workspace que aplican aquí también (MCP en sync, presentación de ventas, adjuntos de Asana, tier, sin red…):
> `../AGENTS.md` y `../CLAUDE.md`, que cargan siempre al abrir desde `Avoqado/`. Copias quitadas el 9-oct-2026 (fase 2b).
