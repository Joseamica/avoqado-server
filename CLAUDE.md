# CLAUDE.md - Avoqado Server (Backend)

Multi-tenant B2B SaaS for restaurant/venue management (POS, payments, inventory, staff). Express.js + TypeScript, PostgreSQL/Prisma,
Socket.IO, Redis, RabbitMQ. Payments via Blumon (TPV + E-commerce) and Stripe (subscriptions).

## 🔴 CRITICAL — Ask which payment tier BEFORE building or changing anything

Avoqado is a tier-gated SaaS (**FREE · PRO · PREMIUM · ENTERPRISE**). Whenever you add a new feature, modify existing behavior, or expose a
new capability, **STOP and ask the founder which paid tier it falls under** — then wire the gating to match. A change shipped without a tier
decision is unfinished: it either leaks paid value into a lower tier or hides a free capability behind a paywall. This repo is the
**authoritative** gate — get it right here first.

- **Backend (authoritative):** `src/services/access/basePlan.service.ts` + `src/middlewares/checkFeatureAccess.middleware.ts`. Obligatory
  gating questions live in `.claude/rules/feature-gating.md` (Module vs Feature decision). PREMIUM-only codes today: `CFDI`,
  `INVENTORY_TRACKING`.
- **Module vs Feature — use the RIGHT resolver (crossing them fails silently; grandfathered venues pass a wrong-system gate):** `Module`
  codes (`SERIALIZED_INVENTORY`, `WHITE_LABEL_DASHBOARD`, `COMMISSIONS`) gate via `moduleService.isModuleEnabled` (incl. org-level
  fallback); `Feature` codes (`INVENTORY_TRACKING`, `CFDI`, `ADVANCED_REPORTS`…) via `venueHasFeatureAccess`. **Every MCP
  serialized-inventory tool (`src/mcp/tools/`) MUST gate with `isModuleEnabled(SERIALIZED_INVENTORY)`** — never the Feature/tier resolver;
  only serialized tools carry it (per-tool gating, not coupled to white-label). Full rule: `.claude/rules/feature-gating.md`.
- **Dashboard display/CTA map:** `avoqado-web-dashboard/src/config/plan-catalog.ts` (`TierId`, `PLAN_TIERS`, `getTierForFeature()` →
  FeatureGate upsell).
- **Enforcement status:** ✅ only **avoqado-web-dashboard** enforces tiers today. ⚠️ **avoqado-ios** and **avoqado-android** have NO tier
  gating yet — they will mirror the backend feature codes by exact name. Treat tier codes like permissions: a name mismatch fails silently.

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
apps) consume the **`/api/v1/mobile/*`** namespace (controllers under `src/controllers/mobile/`), NOT `/api/v1/dashboard/*`. The dashboard
namespace (`src/controllers/dashboard/`) is consumed by `avoqado-web-dashboard` and `avoqado-desktop`. Both avoqado-ios and avoqado-android
are developed in parallel by other LLM-agent sessions against `/mobile` right now — before changing a `/mobile` controller/service/ schema,
re-verify its current contract directly in source (never from memory or an earlier session), since those two clients depend on it and their
in-flight work isn't visible from here. A change confined to `/dashboard` (e.g. its own controllers/services) does not carry that same risk
unless the underlying service function is also called from a `/mobile` controller — grep for other callers of any service function before
assuming a fix is dashboard-only.

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
npm run pre-deploy     # CI/CD sim (MUST pass before push)
npm test               # All tests
npm run test:unit      # Unit tests
npm run test:api       # API integration
npm run test:workflows # E2E workflows
npm run lint:fix       # Auto-fix ESLint
npm run format         # Prettier
npm run studio         # Prisma Studio
```

After editing code: `npm run format && npm run lint:fix`

## Key Business Flow: Order → Payment → Inventory

Stock deduction ONLY when fully paid, FIFO (oldest first), non-blocking. Full rules auto-load via `.claude/rules/payments.md` when editing
payment files. Deep dive: `docs/guides/PAYMENT_FLOW_GUIDE.md`

## Module Config Schemas (CRITICAL - Common Bug)

When modifying module configs (especially `WHITE_LABEL_DASHBOARD`), **ALWAYS check the `configSchema`** stored in the `Module` table. AJV
validates configs at runtime against this schema. If you add/rename fields in the config object but don't update the schema, the API will
reject the update with cryptic "should have required property" errors. Schema is defined in `scripts/setup-modules.ts` — after editing,
re-run the script to update the DB.

## Production Data Inserts: IDs MUST be cuid format

When the user asks you to insert/create records directly in production (psql, scripts, etc.), **always generate IDs as cuid v1** (25 chars,
prefix `c`) to match Prisma's `@default(cuid())` convention. Never use custom prefixes like `mindf_hh_001` or UUIDs — they break consistency
with the rest of the catalog. Use the `cuid` package: `npm install --no-save cuid && node -e "console.log(require('cuid')())"`. FKs with
`ON UPDATE CASCADE` (Product→MenuCategory, Inventory→Product) allow safe id rewrites in a transaction if you forget upfront.

## Cross-Repo (TPV Android)

Backend ALWAYS supports old TPV versions. NEVER remove API response fields. New fields must be optional with defaults. Deploy backend first,
wait stable, then APK. TPV sends `X-App-Version-Code` for conditional behavior.

## Documentation Router

### Auto-loaded rules (`.claude/rules/`)

- `critical-warnings.md` - authContext, tenant isolation, money, webhooks, storage, migrations, Zod Spanish messages
- `testing-and-git.md` - Regression prevention, git policy, test workflow
- `payments.md` - Payment/inventory rules (path-conditional: `src/services/tpv/**`, `src/services/dashboard/rawMaterial*`)
- `cron-jobs.md` - Cron jobs MUST wrap entry DB read with `retry(..., shouldRetryDbConnectionError)` (path-conditional: `src/jobs/**`).
  Prevents top-of-hour P1001 stampede deaths. NO global Prisma retry.
- `feature-gating.md` - Module vs Feature: two parallel gating systems, don't cross the resolvers
- `playtelecom-vertical.md` - PlayTelecom white-label vertical: who's who (Bait/Walmart), generic vs bespoke, gotchas

### On-demand guides (`docs/guides/`)

- `PERMISSIONS_GUIDE.md` - Override/merge modes, adding features checklist
- `PAYMENT_FLOW_GUIDE.md` - FIFO logic, edge cases, debugging
- `EMAIL_STANDARDS.md` - Template specs, HTML structure

### Full reference (`docs/`)

| Topic                   | File                                              |
| ----------------------- | ------------------------------------------------- |
| All docs index          | `docs/README.md`                                  |
| Architecture            | `docs/ARCHITECTURE_OVERVIEW.md`                   |
| Schema map (START HERE) | `docs/SCHEMA_MAP.md` — 206 models in 20 domains   |
| Database schema (full)  | `docs/DATABASE_SCHEMA.md`                         |
| Permissions system      | `docs/PERMISSIONS_SYSTEM.md`                      |
| Blumon TPV              | `docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md`       |
| Blumon E-commerce       | `docs/blumon-ecommerce/REFACTORING_COMPLETE.md`   |
| Payment architecture    | `docs/PAYMENT_ARCHITECTURE.md`                    |
| Stripe                  | `docs/STRIPE_INTEGRATION.md`                      |
| Inventory (FIFO)        | `docs/INVENTORY_REFERENCE.md`                     |
| Serialized inventory    | `docs/features/SERIALIZED_INVENTORY.md`           |
| Chatbot/Text-to-SQL     | `docs/CHATBOT_TEXT_TO_SQL_REFERENCE.md`           |
| Terminal IDs            | `docs/TERMINAL_IDENTIFICATION.md`                 |
| TPV commands            | `docs/TPV_COMMAND_SYSTEM.md`                      |
| Team invitations        | `docs/features/TEAM_INVITATIONS.md`               |
| Login scenarios         | `docs/features/LOGIN_SCENARIOS.md`                |
| Industry config         | `docs/industry-config/README.md`                  |
| Business types/MCC      | `docs/BUSINESS_TYPES.md`                          |
| Settlement incidents    | `docs/features/SETTLEMENT_INCIDENTS.md`           |
| Commissions/Goals       | `src/services/dashboard/commission/` (no doc yet) |
| Datetime/timezone       | `docs/DATETIME_SYNC.md`                           |
| Production checklist    | `docs/PRODUCTION_READINESS_CHECKLIST.md`          |

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

## 🔴 CRITICAL — Keep the sales presentation in sync

The partner sales presentation (`~/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/`) is the canonical "what
Avoqado does" document — third parties sell from it. It must never fall behind the platform.

**Whenever you add, change, or remove a customer-visible capability (feature, module, product, payment method, supported sector, tier
packaging), you MUST update BOTH deliverables as part of the SAME change — never "later":** the full deck (`avoqado-presentacion-v2.html`)
AND the one-pager (`avoqado-one-pager-v2.html`) — plus the client one-pager (`avoqado-one-pager-cliente.html`). **Editing the HTML is only
HALF the change.** You MUST then **regenerate the PDF of each** with the Chrome-headless HTML→PDF command in that folder's `README.md` — the
PDF is the file partners actually open and send, so an HTML edit WITHOUT a freshly regenerated PDF is an INCOMPLETE change. Updating only
one deliverable, or editing HTML without regenerating its PDF, is incomplete. Internal refactors and bugfixes with no customer-visible
impact are exempt.

---

## Fetching Asana task attachments / screenshots

When given an Asana task URL, you **can** see its screenshots and attachments — don't claim you can't.

- `mcp__asana__*` reads task text/comments but **not** files; the `mcp__claude_ai_Asana__` connector is often unauthorized. Don't stop there
  — use the Asana Personal Access Token directly (it's what powers the `asana` MCP server):
  1. Read the token (use it, **never print or commit the value**): key `ASANA_ACCESS_TOKEN` under `mcpServers.asana.env` in
     `~/.claude.json`. Example:
     `TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['asana']['env']['ASANA_ACCESS_TOKEN'])")`
  2. List attachments + signed URLs (task GID = the long number after `/task/` in the URL):
     `curl -s -H "Authorization: Bearer $TOKEN" "https://app.asana.com/api/1.0/tasks/<GID>/attachments?opt_fields=name,download_url,created_at"`
  3. `curl` each `download_url` (pre-signed, needs no auth) to a temp file in the scratchpad, then Read the image. Inline description images
     are attachments too, so this returns all of them — not just the ones embedded in the text.
- If slide/screenshot text is unreadable after Read downscales a large image, crop it into regions with PIL and upscale (LANCZOS) before
  re-reading.
