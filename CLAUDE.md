# CLAUDE.md - Avoqado Server (Backend)

Multi-tenant B2B SaaS for restaurant/venue management (POS, payments, inventory, staff). Express.js + TypeScript, PostgreSQL/Prisma,
Socket.IO, Redis, RabbitMQ. Payments via Blumon (TPV + E-commerce) and Stripe (subscriptions).

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
