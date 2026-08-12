# PITS H1C — Regional Pricing and Price History Implementation Plan

> **Required execution skill:** use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Apply
> `superpowers:test-driven-development` to every money, migration, tenant-isolation, idempotency, publication, outbox, concurrency, export,
> and permission change.

**Goal:** Let PITS define organization, regional, and venue-specific sale-price/purchase-cost rules; preview manual or XLSX adjustments;
publish up to 10,000 expanded targets atomically; recover safely from concurrent confirms; view/export current and historical changes; and
reverse through a new publication—while every POS continues charging the scalar `Product.price` it already caches and a disconnected device
keeps selling with its last known good value.

**Design:** [`2026-08-08-pits-h1-master-catalog-design.md`](../specs/2026-08-08-pits-h1-master-catalog-design.md)

**Depends on:** H1A organization entitlement/roles, CatalogItem organization values, bindings, canonical money/hash, workbook security,
preview-confirm/idempotency, publication line/outbox/audit, dashboard organization shell, venue permissions, and superadmin readiness. H1B
is not required for price calculation, but code/SKU filters and exports consume H1B identifiers when its gate is ready.

**Shared-workspace barrier:** H1C implementation starts only after H1B has integrated and verified all shared server/dashboard/docs paths.
Earlier H1C design or isolated tests do not authorize concurrent edits to those files. Subagents inside H1C may run concurrently only with
explicit, disjoint file ownership and one integration owner.

**Architecture:** `CatalogItemPrice` contains typed Decimal rules at ORGANIZATION, PRICE_REGION, or VENUE scope. `CatalogPriceRegion` is a
pricing domain—not `Zone`—with many-to-many venue membership and deterministic priority. Preview resolves rules against current venue
currency and materializes the resulting scalar into Product/PricingPolicy only during confirmed publication. The H1A batch, line, audit,
hash, and outbox state machine is extended rather than duplicated. A leased attempt/CAS protocol makes concurrent confirms and watchdog
recovery safe. POS and legacy Product reads never resolve master rules synchronously.

**Tech Stack:** Node.js 20, TypeScript, Express, Prisma/PostgreSQL Decimal/raw bulk SQL, Jest, Supertest, XLSX, RabbitMQ/Socket.IO, customer
MCP; React 18.3.1, Vite, TanStack Query/Table, React Hook Form, Zod, Vitest/Testing Library, Playwright; dedicated React superadmin for
gates and health only.

## Global constraints

- Follow every H1A global constraint and continuously update `avoqado-server/docs/PITS-H1-CHANGE-MANIFEST.md`. Preserve all concurrent WIP.
- Do not mutate Git without a new explicit user authorization. Never stage broad paths.
- `Product.price` and optional `PricingPolicy.currentPrice` remain the operational read sources. Checkout, menu reads, stock, orders, and
  offline caches never query price-region tables.
- Rules and new API money use Decimal/canonical scale-2 strings. Accept `0.00..99999999.99`; reject rather than round more than two
  decimals, exponent, comma, negative, overflow, Float/number input, non-uppercase/non-ISO currency, and cross-currency targets. No FX
  conversion exists.
- Recipe costs remain Decimal(10,4). PURCHASE_COST never overwrites Recipe totals, PricingPolicy.calculatedCost, RawMaterial, StockBatch, or
  inventory valuation.
- SALE_PRICE atomically updates Product.price and existing PricingPolicy.currentPrice only. Historical order/payment snapshots do not
  change.
- Scope is relational, not polymorphic JSON: ORGANIZATION has no region/venue FK, PRICE_REGION has exactly region FK, VENUE has exactly
  venue FK. Raw SQL CHECKs, partial unique indexes, and composite tenant foreign keys enforce this below services.
- Region membership is many-to-many. Lower integer priority wins; `(venueId, priority)` is unique. `Zone` and `Venue.zoneId` remain
  untouched.
- Precedence is venue rule → first matching active region by priority → organization rule → preserve existing Product.price for an existing
  Product. New Product requires a resolvable rule in its Venue.currency.
- Topology changes are commercial publications: preview, confirm, increment Organization.pricingTopologyRevision, and rematerialize every
  affected target atomically.
- A topology or publication expansion above the configured 10,000 target cap returns 413 before any write. H1C never partitions one atomic
  topology operation across active revisions.
- Normalized manual and `price-adjustments-v1.xlsx` inputs produce the same command/hash/preview. Any invalid/stale row means zero
  Product/rule/publication writes.
- Preview captures entitlement/config, topology revision, rule revisions, CatalogItem revisions, binding revision/hash,
  Product/PricingPolicy values, target currencies, and exact field mask.
- Confirm takes stable locks, rereads all dependencies under lock, and returns 409 STALE with zero writes if any managed dependency
  diverged. Unrelated Product fields do not invalidate a price-only preview.
- Idempotency scope is `(organizationId, operation, idempotencyKey)` with a versioned request hash. Same key/hash returns original
  state/result; same key/different hash returns 409; concurrent caller receives 202 IN_PROGRESS and recovers by GET; a failed attempt
  requires a new key.
- Batch transition is PREVIEWED→APPLYING→APPLIED. Every attempt has attemptId, lease expiry, and heartbeat. Watchdog takes the same batch
  lock and CAS; it cannot mark FAILED while a live attempt commits or allow a commit after FAILED.
- Transaction budgets are explicit: lock timeout 5 seconds, statement timeout 60 seconds, transaction timeout 90 seconds. Bulk writes use
  stable ordering and chunks ≤ 500 without calling the row-by-row legacy Product service.
- Publication audit summary and line before/after are co-committed. External events are sent only after commit from outbox.
- Outbox delivery is at-least-once. Retry preserves eventId and per-venue sequence; consumers ignore old sequence or refetch.
  `oldPrice = 0.00` emits `priceChangePercent: null`, never Infinity/NaN.
- Disabling entitlement/gates stops new rules/publications but keeps the last materialized Product price. Rollback is an explicit inverse
  preview/publication, never destructive migration or silent price restoration.
- Organization content APIs use active StaffOrganization + OrgRole. Venue price-change/provenance APIs use active StaffVenue and exact
  `catalog-venue:read`/ `catalog-venue:request-override`. Cross-tenant identifiers return 404.
- Superadmin sees only entitlement/gates/readiness/outbox health. It never edits rules, regions, values, publications, or prices.
- Customer MCP uses the same server services, organization/venue resolvers, preview, confirm, idempotency, and audit. H1 writes require
  `mcp:write` unconditionally.
- Customer-visible UI is es/en/fr, accessible, paginated, explicit about currency and provenance, preserves exact zero, never blindly
  retries a confirm POST, and recovers by batch/key GET.
- PITS's answer about sale price, purchase cost, or both blocks contractual row 47 acceptance. The off-gated model and separate columns can
  ship; no final commercial claim is made before written confirmation.

## Exact file map

### Server files to create

- `prisma/migrations/20260808140000_add_regional_catalog_pricing/migration.sql`
- `src/services/master-catalog/catalogPriceRegion.service.ts`
- `src/services/master-catalog/catalogPricing.service.ts`
- `src/services/master-catalog/catalogPriceAdjustmentImport.service.ts`
- `src/services/master-catalog/catalogPriceHistory.service.ts`
- `src/controllers/dashboard/masterCatalogPricing.dashboard.controller.ts`
- `src/controllers/dashboard/masterCatalogVenue.dashboard.controller.ts`
- `src/services/master-catalog/catalogPricingReadiness.service.ts`
- `src/workers/masterCatalogXlsx.worker.ts`
- `src/schemas/dashboard/masterCatalogPricing.schema.ts`
- `scripts/benchmark-catalog-pricing-publication.ts`
- `tests/workflows/master-catalog-price-publication.workflow.test.ts`

### Server files to modify

- `prisma/schema.prisma`
- `scripts/generate-schema-map.ts`
- `docs/SCHEMA_MAP.md`
- `src/types/master-catalog.ts`
- `src/services/master-catalog/catalogMoney.service.ts`
- `src/services/master-catalog/catalogHash.service.ts`
- `src/services/master-catalog/catalogPublication.service.ts`
- `src/services/master-catalog/catalogExport.service.ts`
- `src/services/master-catalog/catalogWorkbook.service.ts`
- `src/services/master-catalog/catalogPublicationOutbox.service.ts`
- `src/routes/dashboard/masterCatalog.routes.ts`
- `src/routes/dashboard/masterCatalogVenue.routes.ts`
- `src/routes/dashboard.routes.ts`
- `src/services/dashboard/pricing.service.ts`
- `src/services/dashboard/product.dashboard.service.ts`
- `src/communication/sockets/services/broadcasting.service.ts`
- `src/communication/sockets/types/index.ts`
- `src/jobs/jobSchedules.ts`
- `src/jobs/catalog-publication-outbox-sweeper.job.ts`
- `src/jobs/catalog-publication-watchdog.job.ts`
- `src/server.ts`
- `src/mcp/tools/masterCatalog.ts`
- `src/mcp/server.ts`
- `src/controllers/superadmin/masterCatalog.superadmin.controller.ts`
- `src/routes/superadmin/masterCatalog.routes.ts`
- `CHANGELOG.md`

### Dashboard organization files to create

- `avoqado-web-dashboard/src/features/master-catalog/pricing-types.ts`
- `avoqado-web-dashboard/src/features/master-catalog/pricing-api.ts`
- `avoqado-web-dashboard/src/features/master-catalog/use-catalog-pricing.ts`
- `avoqado-web-dashboard/src/features/master-catalog/use-catalog-price-history.ts`
- `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogPricingPage.tsx`
- `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogPriceAdjustmentsPage.tsx`
- `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogPriceHistoryPage.tsx`
- `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/CatalogPricePreviewTable.tsx`
- `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/PriceAdjustmentImportDialog.tsx`
- `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/PriceRuleForm.tsx`

### Dashboard organization files to modify

- `avoqado-web-dashboard/src/features/master-catalog/types.ts`
- `avoqado-web-dashboard/src/features/master-catalog/api.ts`
- `avoqado-web-dashboard/src/features/master-catalog/use-catalog-items.ts`
- `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/MasterCatalogLayout.tsx`
- `avoqado-web-dashboard/src/routes/router.tsx`
- `avoqado-web-dashboard/src/locales/es/organization.json`
- `avoqado-web-dashboard/src/locales/en/organization.json`
- `avoqado-web-dashboard/src/locales/fr/organization.json`
- `avoqado-web-dashboard/CHANGELOG.md`

### Dashboard venue files to create/modify

- Create: `avoqado-web-dashboard/src/pages/Menu/CatalogVenuePriceChangesPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Menu/components/CatalogPriceProvenanceCard.tsx`
- Create: `avoqado-web-dashboard/src/features/master-catalog/use-venue-master-catalog-access.ts`
- Create: `avoqado-web-dashboard/src/routes/VenueMasterCatalogProtectedRoute.tsx`
- Modify: `avoqado-web-dashboard/src/routes/venueRoutes.tsx`
- Modify: `avoqado-web-dashboard/src/routes/lazyComponents.ts`
- Modify: `avoqado-web-dashboard/src/components/Sidebar/app-sidebar.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Menu/Products/productId.tsx`
- Modify: `avoqado-web-dashboard/src/lib/permissions/defaultPermissions.ts`
- Modify: `avoqado-web-dashboard/src/locales/es/menu.json`
- Modify: `avoqado-web-dashboard/src/locales/en/menu.json`
- Modify: `avoqado-web-dashboard/src/locales/fr/menu.json`
- Modify: `avoqado-web-dashboard/src/locales/es/sidebar.json`
- Modify: `avoqado-web-dashboard/src/locales/en/sidebar.json`
- Modify: `avoqado-web-dashboard/src/locales/fr/sidebar.json`

### Dedicated superadmin files to modify

- `avoqado-superadmin/src/features/master-catalog/types.ts`
- `avoqado-superadmin/src/features/master-catalog/api.ts`
- `avoqado-superadmin/src/features/master-catalog/use-master-catalog.ts`
- `avoqado-superadmin/src/features/master-catalog/MasterCatalogAccessPage.tsx`
- `avoqado-superadmin/src/features/master-catalog/MasterCatalogOrganizationDrawer.tsx`
- `avoqado-superadmin/src/features/master-catalog/MasterCatalogRolloutTable.tsx`
- `avoqado-superadmin/CHANGELOG.md`

### Exact API additions

H1C adds the price-region, rule, adjustment, price-change, and price-export contracts below. The publication
preview/confirm/recovery/reversal and venue provenance/override-request paths already belong to H1A; H1C extends their discriminated
command/result unions and never mounts duplicates.

Under `/api/v1/dashboard/organizations/:orgId/master-catalog`:

```text
GET    /price-regions
POST   /price-regions/preview
GET    /price-rules
POST   /price-adjustments/preview
POST   /price-adjustments/imports/preview
GET    /price-adjustments/imports/:importBatchId/errors.xlsx
GET    /templates/price-adjustments.xlsx
GET    /price-changes
GET    /exports/regional-values.xlsx
GET    /exports/price-changes.xlsx
```

H1C extends, but does not re-register, these H1A organization routes:

```text
POST   /publications/preview
POST   /publications/:publicationBatchId/confirm
GET    /publications/by-idempotency-key/:operation/:idempotencyKey
GET    /publications/:publicationBatchId
POST   /publications/:publicationBatchId/reversal/preview
```

Under `/api/v1/dashboard/venues/:venueId/master-catalog`:

```text
GET    /price-changes
GET    /price-changes.xlsx
```

H1C extends, but does not re-register, these H1A venue routes:

```text
GET    /access
GET    /products/:productId/provenance
POST   /override-requests/preview
POST   /override-requests/:requestBatchId/confirm
```

### Core command contracts

H1C reuses H1A's `CatalogActor`, `CatalogCommandContext`, `CatalogReadContext`, `CatalogConfirmInput`, and generic publication result types;
it extends the shared type file rather than redeclaring parallel contracts.

```ts
export type CatalogPriceValueType = 'SALE_PRICE' | 'PURCHASE_COST'
export type CatalogPriceScope = 'ORGANIZATION' | 'PRICE_REGION' | 'VENUE'

export interface CatalogPriceRuleBase {
  catalogItemId: string
  valueType: CatalogPriceValueType
  amount: string
  currency: string
  expectedRevision?: number
}

export type CatalogPriceTarget =
  | { scope: 'ORGANIZATION'; priceRegionId?: never; venueId?: never }
  | { scope: 'PRICE_REGION'; priceRegionId: string; venueId?: never }
  | { scope: 'VENUE'; venueId: string; priceRegionId?: never }

export type CatalogPriceRuleInput = CatalogPriceRuleBase & CatalogPriceTarget

export type CatalogPricingCommandContext = CatalogCommandContext & {
  idempotencyKey: string
}

export type CatalogPricingCommandV1 =
  | { kind: 'UPSERT_RULES'; rules: CatalogPriceRuleInput[] }
  | { kind: 'MUTATE_REGION_TOPOLOGY'; mutation: CatalogRegionMutation }
  | { kind: 'REVERSE_PUBLICATION'; publicationBatchId: string }

export async function resolveCatalogPrice(input: {
  tx: Prisma.TransactionClient
  organizationId: string
  catalogItemId: string
  venueId: string
  valueType: CatalogPriceValueType
}): Promise<ResolvedCatalogPrice | null>

export async function previewCatalogPricing(
  context: CatalogPricingCommandContext,
  command: CatalogPricingCommandV1,
): Promise<CatalogPublicationPreview>

export async function confirmCatalogPublication(
  context: CatalogCommandContext,
  input: CatalogConfirmInput & { publicationBatchId: string },
): Promise<CatalogPublicationResult | CatalogPublicationInProgress>

export async function getCatalogPublicationByIdempotencyKey(
  context: CatalogReadContext,
  input: { operation: CatalogPublicationOperation; idempotencyKey: string },
): Promise<CatalogPublicationResult | CatalogPublicationInProgress>

export async function claimCatalogPublicationAttempt(input: {
  tx: Prisma.TransactionClient
  publicationBatchId: string
  attemptId: string
  leaseExpiresAt: Date
}): Promise<'CLAIMED' | 'IN_PROGRESS' | 'TERMINAL'>
```

## Verification and checkpoint convention

Every task observes the intended RED first, implements one bounded responsibility, runs focused and touched-module GREEN, updates the
manifest, and proposes a named Git checkpoint. Execution pauses before staging or committing. If the user authorizes it, stage only the
exact Files list for that task; otherwise retain the verified changes unstaged.

## Task 1 — Freeze scalar-price and event compatibility

**Files**

- Create: `tests/contracts/master-catalog/catalog-pricing-v1.json`
- Create: `tests/contracts/master-catalog/product-price-events-v1.json`
- Create: `tests/unit/contracts/masterCatalogPricing.contract.test.ts`

- [ ] Capture Product list/detail payloads with price `0.00`, positive price, Product without PricingPolicy, and Product with PricingPolicy.
      Prove every dashboard/mobile/TPV wire still exposes scalar price exactly as before.
- [ ] Keep H1A legacy fixtures unchanged; the new H1C contract fixture owns the zero-price baseline and compares it to current serializers
      without rewriting earlier evidence.
- [ ] Freeze current `menu_updated`, `menu_item_updated`, and `product_price_changed` envelopes, then add the versioned H1 serializer golden
      where `oldPrice = 0.00` produces `priceChangePercent: null`.
- [ ] Add a query-observer regression proving Product/menu/checkout/stock/recipe reads execute no
      CatalogItemPrice/CatalogPriceRegion/publication query.
- [ ] Run the focused contract test GREEN before production edits and record output in the manifest:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/contracts/masterCatalogPricing.contract.test.ts
```

- [ ] Propose checkpoint `test(h1c): freeze price compatibility`; pause before Git action.

## Task 2 — Add regional price topology and publication recovery schema

**Files**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260808140000_add_regional_catalog_pricing/migration.sql`
- Modify: `scripts/generate-schema-map.ts`
- Modify/generated: `docs/SCHEMA_MAP.md`
- Create: `tests/integration/master-catalog/catalogPricingMigration.integration.test.ts`
- Create: `tests/integration/master-catalog/catalogPricingConstraints.integration.test.ts`

- [ ] Write RED migration tests with current Products/PricingPolicies/Recipes/orders and H1A catalog rows. Migration preserves all
      IDs/prices/costs and creates no region, rule, batch, or outbox rows; Organization topology revision defaults to zero.
- [ ] Add `Organization.pricingTopologyRevision` and tenant-safe CatalogPriceRegion plus CatalogPriceRegionVenue. Enforce one region/venue
      membership and unique `(venueId,priority)`; lower priority number wins.
- [ ] Repeat organizationId in region memberships and rules. Enforce composite FKs `(priceRegionId,organizationId)`,
      `(venueId,organizationId)`, and `(catalogItemId,organizationId)` against parent unique `(id,organizationId)` keys; do not rely on
      service-only tenant checks.
- [ ] Extend CatalogItemPrice with explicit PRICE_REGION and VENUE foreign keys plus scope CHECKs. Add raw-SQL partial uniques separately
      for organization, region, and venue rules because nullable composite uniques are insufficient.
- [ ] Extend the H1A publication spine only with pricing/topology command kinds, topology revision, line monetary before/after/provenance,
      and price reversal links. Generic requestHash, idempotency, attempt/lease/heartbeat, state transitions, outbox delivery, and venue
      sequence already belong to H1A and are not duplicated.
- [ ] Write SQL-direct RED for all cross-tenant combinations, scope/FK mismatch, duplicate rule, duplicate priority, negative/out-of-range
      Decimal, invalid currency, illegal batch transition, and idempotency key/hash. PostgreSQL NUMERIC may round scale during coercion, so
      rejection of more than two input decimals remains a parser/service guarantee tested before Prisma, not a false CHECK claim.
- [ ] Update schema-map domains, then run Prisma validate/generate, schema map check, and integration projects against a disposable
      PostgreSQL database.
- [ ] Run the exact schema gate:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx prisma validate
npx prisma generate
npm run schema:map
npm run schema:map -- --check
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogPricingMigration.integration.test.ts \
  tests/integration/master-catalog/catalogPricingConstraints.integration.test.ts
```

- [ ] Propose checkpoint `feat(h1c): add regional pricing schema`; pause before Git action.

## Task 3 — Resolve Decimal rules and deterministic precedence

**Files**

- Modify: `src/services/master-catalog/catalogMoney.service.ts`
- Create: `src/services/master-catalog/catalogPricing.service.ts`
- Modify: `src/types/master-catalog.ts`
- Create: `tests/unit/services/master-catalog/catalogMoney.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPricing.service.test.ts`

- [ ] Extend RED money tests for API strings, XLSX decimal cells represented losslessly, zero, maximum, scale 3, exponent, comma, negative,
      overflow, numeric JSON, lowercase/invalid ISO code, and canonical hash strings. Reject rather than round.
- [ ] Write RED resolver matrix for venue override, multiple active regions ordered by priority, missing regional rule fallthrough,
      organization default, preserve existing Product.price, inactive region, wrong currency, and multi-currency organization.
- [ ] Implement one pure command normalizer used by manual and XLSX rows. It sorts targets/rules, canonicalizes money/currency, rejects
      duplicate target+valueType entries, and returns one versioned request hash.
- [ ] Implement `resolveCatalogPrice()` inside a caller transaction. It queries only explicit organization/region/venue rules matching
      Venue.currency and returns provenance, rule revision, amount Decimal, and currency.
- [ ] For a new Product, missing resolvable SALE_PRICE is invalid. For an existing Product, missing proposal means preserve current price
      and no publication line.
- [ ] Run focused GREEN and build:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogMoney.service.test.ts \
  tests/unit/services/master-catalog/catalogPricing.service.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1c): resolve canonical catalog prices`; pause before Git.

## Task 4 — Preview-confirm every region topology mutation

**Files**

- Create: `src/services/master-catalog/catalogPriceRegion.service.ts`
- Create: `tests/unit/services/master-catalog/catalogPriceRegion.service.test.ts`
- Create: `tests/integration/master-catalog/catalogPriceTopology.integration.test.ts`

- [ ] Write RED for create/rename/deactivate region, add/remove venue, reprioritize, duplicate name, duplicate priority, cross-tenant venue,
      inactive target, currency differences, zero affected Products, exact cap, and cap+1.
- [ ] Persist display name plus normalizedName, active, createdBy/updatedBy, and timestamps; enforce unique
      `(organizationId,normalizedName)` and tenant-safe memberships.
- [ ] Direct POST/PATCH writers are forbidden. `price-regions/preview` accepts a typed CREATE, UPDATE, DEACTIVATE, MEMBERSHIP, or PRIORITY
      mutation and expands every affected unique `(catalogItemId,venueId,productId)` target. Sale and purchase fields for one Product count
      as one target/write, not two fan-out slots.
- [ ] Preview captures current topology revision, region/membership/rule revisions, target currencies, and expanded target count. If count
      exceeds 10,000, return 413 before staging a confirmable batch.
- [ ] Confirm performs topology mutation, increments revision once, resolves and materializes every affected target in the same publication
      transaction. No intermediate topology revision becomes active with stale Product prices.
- [ ] Prove rollback on any invalid currency/target/rule; no partition/campaign behavior exists.
- [ ] Run focused/integration GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogPriceRegion.service.test.ts
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogPriceTopology.integration.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1c): publish price topology atomically`; pause before Git.

## Task 5 — Normalize manual and XLSX price-adjustment previews

**Files**

- Modify: `src/services/master-catalog/catalogWorkbook.service.ts`
- Modify: `src/services/master-catalog/catalogImport.service.ts`
- Modify: `src/services/master-catalog/catalogHash.service.ts`
- Modify: `src/services/master-catalog/catalogPricing.service.ts`
- Create: `src/services/master-catalog/catalogPriceAdjustmentImport.service.ts`
- Create: `tests/unit/services/master-catalog/catalogPriceImport.service.test.ts`
- Create: `tests/api-tests/master-catalog/catalogPricePreview.api.test.ts`
- Create: `tests/fixtures/master-catalog/price-adjustments-v1-valid.xlsx`
- Create: `tests/fixtures/master-catalog/price-adjustments-v1-errors.xlsx`

- [ ] Define `price-adjustments-v1.xlsx` with `Metadata` and `Adjustments`. Grain is
      `(corporate_sku,value_type,target_scope,target_id,currency)` and exact columns are
      `corporate_sku,value_type,target_scope,target_id,new_amount,currency,expected_rule_revision?,note?`. `target_id` is empty only for
      ORGANIZATION. Resolve catalogItemId only inside the normalized command and generate the blank template from this schema.
- [ ] Reuse H1A workbook security before parsing: byte/ZIP/sheet/row/column/cell caps, no macro, formula, external link, numeric identifier,
      encrypted/invalid ZIP, or unknown sheet.
- [ ] Write RED for duplicate rows, bad money/currency/scope, unknown/retired item, invalid region or venue, cross-tenant target, wrong
      target currency, stale expected revision, missing binding, and formula injection. One error means zero rule/Product/publication
      writes.
- [ ] Feed both manual and workbook inputs to the exact same `CatalogPricingCommandV1` normalizer. Assert identical target expansion,
      canonical request hash, preview lines, and validation output.
- [ ] Compute requestHash as `sha256("catalog-publication-request:v1\n" + canonicalJson(normalizedCommand))`. Preview reserves unique
      `(organizationId, operation, idempotencyKey)`: same key/hash returns the original batch; same key/different hash returns 409
      `IDEMPOTENCY_KEY_REUSED`.
- [ ] Preview displays current→new amount, value type, currency, resolved provenance, rule/product revision, conflict, and target count;
      `0.00` remains visible and confirmable.
- [ ] Run focused API/unit GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogPriceImport.service.test.ts
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/catalogPricePreview.api.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1c): preview manual and XLSX price changes`; pause before Git.

## Task 6 — Revalidate and bulk-publish one atomic price batch

**Files**

- Modify: `src/services/master-catalog/catalogPublication.service.ts`
- Modify: `src/services/dashboard/pricing.service.ts`
- Modify: `src/services/dashboard/product.dashboard.service.ts`
- Create: `tests/unit/services/master-catalog/catalogPricePublisher.service.test.ts`
- Create: `tests/integration/master-catalog/catalogPricePublication.integration.test.ts`
- Create: `tests/workflows/master-catalog-price-publication.workflow.test.ts`

- [ ] Write RED for 0, 1, 200, 6,200, 10,000, and 10,001 expanded targets; stable Product lock order; stale
      Product/rule/binding/topology/currency; line failure at first/middle/last chunk; Product without/with PricingPolicy; SALE/PURCHASE;
      prepared dish; and audit failure.
- [ ] Claim PREVIEWED→APPLYING by CAS with attemptId/lease. In the transaction, reacquire entitlement/gate/role, then lock/reload batch,
      topology, rules, regions, memberships, CatalogItems, bindings, Products, PricingPolicies, and target currencies in deterministic
      order.
- [ ] The short claim transaction updates only PREVIEWED with matching requestHash. If zero rows change, reload: APPLYING returns
      202/recovery URL, APPLIED returns its persisted result, and a terminal failure requires a fresh preview/key. Lease exceeds the
      90-second apply budget; heartbeat CAS uses `(id,status=APPLYING,attemptId)`.
- [ ] Recompute managed hash under lock. A concurrent change between preview and lock returns 409 STALE and leaves
      rules/Product/PricingPolicy/audit/outbox untouched.
- [ ] Use bounded temp-table/CTE bulk SQL with chunks ≤ 500. Do not call row-by-row `updateProduct()`, which emits/audits outside the
      transaction.
- [ ] Begin with `pg_advisory_xact_lock` for the batch, `SET LOCAL lock_timeout='5s'`, and `SET LOCAL statement_timeout='60s'`; Prisma
      transaction timeout is 90 seconds/maxWait 5 seconds. A price-only publication never takes H1B's identifier fence.
- [ ] SALE_PRICE writes Product.price and an existing PricingPolicy.currentPrice together. PURCHASE_COST writes Product.cost only for
      compatible retail Product and never recipe/raw/stock/ calculated cost. Every amount remains Decimal.
- [ ] In the same transaction, persist rule/topology changes, immutable publication lines, APPLIED CAS for this attemptId, one organization
      ActivityLog summary, and bulk outbox intents: PRODUCT_PRICE_CHANGED plus MENU_ITEM_UPDATED per Product and one coalesced MENU_UPDATED
      per venue, all with stable sequences.
- [ ] Make the final statement an APPLYING→APPLIED CAS for the same attemptId and persist the result snapshot. If row count is not one,
      throw so Product, PricingPolicy, lines, audit, and outbox roll back. Catch may fail only the same attempt under the same batch lock;
      process crash leaves lease recovery to the watchdog.
- [ ] Apply lock 5s/statement 60s/transaction 90s budgets and classify retryable infrastructure failure separately from deterministic
      invalid/stale input.
- [ ] Run focused/integration/workflow GREEN; Task 14 owns the reproducible 200/6,200/10,000 benchmark:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogPricePublisher.service.test.ts
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogPricePublication.integration.test.ts
npx jest --selectProjects=workflows --runInBand --runTestsByPath \
  tests/workflows/master-catalog-price-publication.workflow.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1c): publish prices atomically`; pause before Git.

## Task 7 — Make concurrent confirmation and watchdog recovery truthful

**Files**

- Modify: `src/services/master-catalog/catalogPublication.service.ts`
- Modify: `src/jobs/catalog-publication-watchdog.job.ts`
- Modify: `src/jobs/jobSchedules.ts`
- Modify: `src/server.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationIdempotency.service.test.ts`
- Modify: `tests/unit/jobs/catalog-publication-watchdog.job.test.ts`
- Create: `tests/integration/master-catalog/catalogPublicationConcurrency.integration.test.ts`

- [ ] Write RED same-key/same-hash recovery, same-key/different-hash 409, two simultaneous confirms, retry while APPLYING, expired lease
      before/after heartbeat, crash before transaction, commit before response, watchdog competing with live transaction, and failed attempt
      with reused/new key.
- [ ] Use the same idempotency key in two different operations and prove the operation path segment resolves each independently; an unknown
      operation fails validation and never falls through to `/:publicationBatchId`.
- [ ] Only one caller can claim APPLYING. Another gets 202 with batchId/recovery URL and never repeats the POST internally. Database state
      remains APPLYING; HTTP/MCP map it consistently to wire `status: 'IN_PROGRESS'` with batchId/recovery URL. GET by idempotency key
      returns PREVIEWED/IN_PROGRESS/APPLIED/FAILED truthfully.
- [ ] Heartbeat extends only `(state=APPLYING,attemptId=current)`. Final APPLIED CAS requires the same predicate. Watchdog takes the batch
      advisory lock and marks FAILED only after lease expiry and CAS; it cannot race a live commit.
- [ ] Uncertain outcome remains recoverable by GET; do not fabricate FAILED because an HTTP request timed out. Deterministic validation
      failure requires a fresh preview/key.
- [ ] Register one watchdog schedule without killing/restarting unrelated jobs. Test scheduler idempotence and shutdown behavior.
- [ ] Run unit/integration concurrency GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogPublicationIdempotency.service.test.ts \
  tests/unit/jobs/catalog-publication-watchdog.job.test.ts
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogPublicationConcurrency.integration.test.ts
```

- [ ] Propose checkpoint `fix(h1c): recover catalog publication attempts safely`; pause before Git.

## Task 8 — Deliver idempotent post-commit events from the outbox

**Files**

- Modify: `src/services/master-catalog/catalogPublicationOutbox.service.ts`
- Modify: `src/jobs/catalog-publication-outbox-sweeper.job.ts`
- Modify: `src/communication/sockets/services/broadcasting.service.ts`
- Modify: `src/communication/sockets/types/index.ts`
- Modify: `src/jobs/jobSchedules.ts`
- Modify: `src/server.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationOutboxPricing.service.test.ts`
- Create: `tests/unit/communication/sockets/productPriceChangedSerializer.test.ts`
- Modify: `tests/unit/jobs/catalog-publication-outbox-sweeper.job.test.ts`

- [ ] Write RED payload goldens for `product_price_changed`, `menu_item_updated`, and coalesced `menu_updated`, including exact zero, null
      percentage from old zero, Decimal serialization, eventId, venueSequence, batchId, schemaVersion, and refetch hint.
- [ ] Claim pending rows by lease/attempt without holding a DB transaction during RabbitMQ/socket delivery. On success mark DELIVERED; on
      failure back off and retry with the same eventId/sequence; after bounded attempts mark DEAD_LETTER and alert without reverting
      Product.
- [ ] In the Product transaction, lock/increment H1A's per-venue sequence and insert PRODUCT_PRICE_CHANGED plus MENU_ITEM_UPDATED rows per
      Product and one MENU_UPDATED row per venue with sorted/deduplicated IDs. Keep unique dedupeKey and `(venueId,venueSequence)`; do not
      replace existing per-item socket contracts with an array payload.
- [ ] Generate price/menu outbox only for Products whose SALE_PRICE actually changed. PURCHASE_COST- only and NO_CHANGE lines emit no
      Product/menu event. In the `2*N+1` reservation, N is the number of changed SALE_PRICE Products in that venue and MENU_UPDATED exists
      only when N is positive.
- [ ] Reserve one contiguous block of `2*N+1` sequences per venue atomically. Assign by stable `(productId,eventKind)` order and place
      MENU_UPDATED last. Worker processes only the due head for a venue; retry/backoff blocks that venue until DELIVERED or DEAD_LETTER
      while other venues progress.
- [ ] Add RED regression for the current legacy divide-by-zero paths in Product dashboard and pricing suggestion. Change shared payload
      typing to `number | null` and make one serializer serve H1 publication and touched legacy writers so oldPrice zero never emits
      Infinity/NaN.
- [ ] Worker claims at most 100 due PENDING rows with a lease and prevents two PENDING claims for the same venue; emit occurs outside the DB
      transaction. Use bounded backoff/max attempts, truncate safe lastError to 500 characters, and allow later sequence processing after a
      dead letter.
- [ ] Prove crash after emit/before ack causes at-least-once duplicate with stable identity. Consumer tests either deduplicate by
      eventId/sequence or converge through refetch.
- [ ] Preserve per-venue ordering through a venue lock/sequence; different venues may deliver in parallel. Coalesce batch hints so 10,000
      lines do not emit 10,000 menu refreshes.
- [ ] Register worker lifecycle safely, expose queue lag/failure/dead-letter metrics without logging price-file contents, and test graceful
      shutdown.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogPublicationOutboxPricing.service.test.ts \
  tests/unit/communication/sockets/productPriceChangedSerializer.test.ts \
  tests/unit/jobs/catalog-publication-outbox-sweeper.job.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1c): deliver price events from outbox`; pause before Git.

## Task 9 — Derive current history, divergence, and inverse publications

**Files**

- Create: `src/services/master-catalog/catalogPriceHistory.service.ts`
- Modify: `src/services/master-catalog/catalogPublication.service.ts`
- Create: `tests/unit/services/master-catalog/catalogPriceHistory.service.test.ts`
- Create: `tests/integration/master-catalog/catalogPriceReversal.integration.test.ts`

- [ ] Implement `Current` as the latest APPLIED line per venue/Product whose after amount equals Product.price and that has not been
      superseded. A later legacy price edit marks the prior line DIVERGED in derived output; it remains immutable in History.
- [ ] Public organization/venue `/price-changes`, MCP `list_catalog_price_changes`, and price-changes-v1 are SALE_PRICE/Product.price-only.
      Internal history may query PURCHASE_COST, but purchase cost remains visible only in rules, resolved regional values, publications, and
      audit until a separately versioned customer contract exists.
- [ ] Write RED for publish→republish→reverse→legacy edit, exact zero, sale and purchase filters, multiple venues, identifier/SKU filter
      when H1B ready, pagination ties, date range, batch filter, venue permission, and cross-tenant 404.
- [ ] Reverse is a new preview with before/after swapped from immutable lines and current dependency capture. Confirm uses the same
      publisher/idempotency/audit/outbox; it never edits/deletes the old batch and uses `change_kind=REVERSION` plus reversal links.
- [ ] If current Product diverged, reverse preview shows conflict and cannot confirm without a new explicit decision under H1A override
      rules.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogPriceHistory.service.test.ts
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogPriceReversal.integration.test.ts
```

- [ ] Propose checkpoint `feat(h1c): add price history and reversal`; pause before Git.

## Task 10 — Generate secure regional and price-change XLSX contracts

**Files**

- Modify: `src/services/master-catalog/catalogExport.service.ts`
- Modify: `src/services/master-catalog/catalogWorkbook.service.ts`
- Create: `src/workers/masterCatalogXlsx.worker.ts`
- Create: `tests/unit/services/master-catalog/catalogPriceExport.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPriceExport.eventloop-budget.test.ts`
- Create: `tests/unit/workers/masterCatalogXlsx.worker.test.ts`
- Create: `tests/api-tests/master-catalog/catalogPriceExport.api.test.ts`

- [ ] Implement exact `regional-values-v1.xlsx` sheets Regions, Rules, ResolvedVenueValues and exact `price-changes-v1.xlsx` sheets Current,
      History, plus Metadata. Regional values keep sale/purchase value type. Price-changes v1 is SALE_PRICE/Product.price only and must not
      add an unversioned value_type, currency, or divergence column. Current columns are exactly
      `venue_id,product_id,local_sku,product_name,old_price,current_price,difference,source_scope,batch_id,change_kind,applied_by,applied_at`;
      History adds exactly `publication_line_id,line_status,before_price,after_price,superseded_by?,reverses_line_id?`.
- [ ] Write RED for leading-zero SKU/code text, amount/difference exact scale 2, zero, RFC3339 UTC, deterministic grain/order, null cells,
      multi-region membership, separate sale/purchase, formula neutralization, row cap, and cross-tenant filters.
- [ ] Generate exports from SQL/keyset pages without Product×identifier×region Cartesian explosion. Send already validated/neutralized rows
      to `masterCatalogXlsx.worker.ts` in pages of at most 500; the worker owns synchronous `XLSX.write`, while the request thread enforces
      timeout, cancellation, bounded memory, and a safe error. Do not reuse the synchronous legacy export helper.
- [ ] Enforce an `EVENT_LOOP_BUDGET_MS=50` main-thread test with `src/utils/eventLoopBudget.ts`, plus RED/GREEN tests for worker timeout,
      crash/error propagation, cancellation, and deterministic bytes. Document/run a 6,200 and 10,000 row timing/memory check without
      weakening the budget.
- [ ] Reuse the single secure workbook writer; no raw unescaped cell assignment in H1C services.
- [ ] Run API/unit GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogPriceExport.service.test.ts \
  tests/unit/services/master-catalog/catalogPriceExport.eventloop-budget.test.ts \
  tests/unit/workers/masterCatalogXlsx.worker.test.ts
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/catalogPriceExport.api.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1c): export regional prices and history`; pause before Git.

## Task 11 — Expose organization/venue HTTP and customer MCP surfaces

**Files**

- Create: `src/controllers/dashboard/masterCatalogPricing.dashboard.controller.ts`
- Create: `src/controllers/dashboard/masterCatalogVenue.dashboard.controller.ts`
- Modify: `src/routes/dashboard/masterCatalog.routes.ts`
- Modify: `src/routes/dashboard/masterCatalogVenue.routes.ts`
- Create: `src/schemas/dashboard/masterCatalogPricing.schema.ts`
- Modify: `src/routes/dashboard.routes.ts`
- Modify: `src/mcp/tools/masterCatalog.ts`
- Modify: `src/mcp/server.ts`
- Create: `tests/unit/routes/masterCatalogPricing.routes.test.ts`
- Create: `tests/api-tests/master-catalog/masterCatalogPricing.api.test.ts`
- Create: `tests/unit/mcp-customer/master-catalog-pricing.test.ts`

- [ ] Add thin organization endpoints from the exact API table. OWNER/ADMIN may preview/publish/ reverse; VIEWER reads/audits; MEMBER none.
      Gate regionalPricingEnabled false/unknown and revoked membership fail closed without affecting Product routes.
- [ ] Extend H1A publication/access/provenance/override handlers in place. Add an architecture route assertion that every method+path is
      registered exactly once and that the static idempotency recovery route precedes the batch-id parameter route.
- [ ] Add venue endpoints using active StaffVenue plus exact `catalog-venue:read` or `catalog-venue:request-override`, active organization
      capability, and tenant-safe Product scope. These permissions never grant region/rule/publication mutation.
- [ ] Return venue `/access` with only `{visible,canRead,canRequestOverride,regionalPricingEnabled}` after checking active Staff, active
      StaffVenue, exact permissions, entitlement/module/config/gate, and tenant. The dashboard performs no venue H1 content query until this
      fail-closed capability is visible.
- [ ] Return 202+recovery links for in-progress confirm, 409 stable stale/idempotency errors, 413 cap, and safe row details. Controllers
      never retry POST or perform Prisma work.
- [ ] Extend MCP preview/confirm request unions with structured pricing command and add `list_catalog_price_changes`. Amounts are strings,
      IDs exact, `confirm: true` literal, key required, `mcp:write` unconditional, and shared services own all writes/audit.
- [ ] Retain legacy MCP `set_menu_item_price` for current OFF/ADVISORY behavior; its later edit is visible as H1 divergence. Do not silently
      route it through regional pricing.
- [ ] Run HTTP/MCP/permission tests, permission audit, and build:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/routes/masterCatalogPricing.routes.test.ts \
  tests/unit/mcp-customer/master-catalog-pricing.test.ts
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/masterCatalogPricing.api.test.ts
npm run audit:permissions
npm run build
```

- [ ] Propose checkpoint `feat(h1c): expose guarded pricing API and MCP`; pause before Git.

## Task 12 — Build organization and venue dashboard pricing workflows

**Files**

- Create: `avoqado-web-dashboard/src/features/master-catalog/pricing-types.ts`
- Create: `avoqado-web-dashboard/src/features/master-catalog/pricing-api.ts`
- Create: `avoqado-web-dashboard/src/features/master-catalog/use-catalog-pricing.ts`
- Create: `avoqado-web-dashboard/src/features/master-catalog/use-catalog-price-history.ts`
- Create: `avoqado-web-dashboard/src/features/master-catalog/use-venue-master-catalog-access.ts`
- Create: `avoqado-web-dashboard/src/routes/VenueMasterCatalogProtectedRoute.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogPricingPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogPriceAdjustmentsPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogPriceHistoryPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/CatalogPricePreviewTable.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/PriceAdjustmentImportDialog.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/PriceRuleForm.tsx`
- Create: `avoqado-web-dashboard/src/pages/Menu/CatalogVenuePriceChangesPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Menu/components/CatalogPriceProvenanceCard.tsx`
- Modify: `avoqado-web-dashboard/src/features/master-catalog/types.ts`
- Modify: `avoqado-web-dashboard/src/features/master-catalog/api.ts`
- Modify: `avoqado-web-dashboard/src/features/master-catalog/use-catalog-items.ts`
- Modify: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/MasterCatalogLayout.tsx`
- Modify: `avoqado-web-dashboard/src/routes/router.tsx`
- Modify: `avoqado-web-dashboard/src/routes/venueRoutes.tsx`
- Modify: `avoqado-web-dashboard/src/routes/lazyComponents.ts`
- Modify: `avoqado-web-dashboard/src/components/Sidebar/app-sidebar.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Menu/Products/productId.tsx`
- Modify: `avoqado-web-dashboard/src/lib/permissions/defaultPermissions.ts`
- Modify: `avoqado-web-dashboard/src/locales/es/organization.json`
- Modify: `avoqado-web-dashboard/src/locales/en/organization.json`
- Modify: `avoqado-web-dashboard/src/locales/fr/organization.json`
- Modify: `avoqado-web-dashboard/src/locales/es/menu.json`
- Modify: `avoqado-web-dashboard/src/locales/en/menu.json`
- Modify: `avoqado-web-dashboard/src/locales/fr/menu.json`
- Modify: `avoqado-web-dashboard/src/locales/es/sidebar.json`
- Modify: `avoqado-web-dashboard/src/locales/en/sidebar.json`
- Modify: `avoqado-web-dashboard/src/locales/fr/sidebar.json`
- Modify: `avoqado-web-dashboard/CHANGELOG.md`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/__tests__/CatalogPricingPage.test.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/__tests__/CatalogPriceAdjustmentsPage.test.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/__tests__/CatalogPriceHistoryPage.test.tsx`
- Create: `avoqado-web-dashboard/src/pages/Menu/__tests__/CatalogVenuePriceChangesPage.test.tsx`
- Create: `avoqado-web-dashboard/e2e/tests/master-catalog/catalog-pricing.spec.ts`

- [ ] Use the H1A gated organization shell and extend its single feature API/types. Do not create a parallel pricing feature tree or second
      master-catalog navigation entry.
- [ ] `pricing-types.ts` and `pricing-api.ts` are private submodules re-exported by H1A `types.ts` and `api.ts`; they share the existing API
      client, QueryClient, keys, access guard, and cache namespace. Add a regression proving no second base URL/query client/cache namespace
      exists.
- [ ] Write RED UI for rule provenance/revision/currency, overlapping region priority, venue exception, manual=XLSX preview, row errors
      download, zero, stale conflict, cap, confirm 202 polling, recovery by idempotency key, history/current/diverged, and inverse preview.
- [ ] Never auto-retry confirm POST. Disable confirmation for invalid/stale preview and present one explicit final action with affected
      target count, currency summary, topology revision, and hash.
- [ ] Venue page shows only permitted store changes/provenance and override request. It cannot expose other venues or organization mutation.
      Product detail provenance card is absent without permission.
- [ ] Wrap the venue route in `VenueMasterCatalogProtectedRoute` driven by `use-venue-master-catalog-access`; the generic permission guard
      alone cannot enforce entitlement and regionalPricingEnabled.
- [ ] Add es/en/fr, keyboard/focus/screen-reader coverage, memoized table inputs, loading/empty/error states, and changelog. Use applicable
      design skills before visible UI edits.
- [ ] Run focused Vitest, i18n lint, lint, build, and Playwright:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard
npm run test:run -- \
  src/features/master-catalog \
  src/pages/Organization/MasterCatalog/__tests__/CatalogPricingPage.test.tsx \
  src/pages/Organization/MasterCatalog/__tests__/CatalogPriceAdjustmentsPage.test.tsx \
  src/pages/Organization/MasterCatalog/__tests__/CatalogPriceHistoryPage.test.tsx \
  src/pages/Menu/__tests__/CatalogVenuePriceChangesPage.test.tsx
npm run lint:i18n
npm run lint
npm run build
npm run test:e2e -- e2e/tests/master-catalog/catalog-pricing.spec.ts
```

- [ ] Propose checkpoint `feat(h1c): add regional pricing dashboard`; pause before Git.

## Task 13 — Extend superadmin with regional gate and operational health only

**Files**

- Modify: `avoqado-superadmin/src/features/master-catalog/types.ts`
- Modify: `avoqado-superadmin/src/features/master-catalog/api.ts`
- Modify: `avoqado-superadmin/src/features/master-catalog/use-master-catalog.ts`
- Modify: `avoqado-superadmin/src/features/master-catalog/MasterCatalogAccessPage.tsx`
- Modify: `avoqado-superadmin/src/features/master-catalog/MasterCatalogOrganizationDrawer.tsx`
- Modify: `avoqado-superadmin/src/features/master-catalog/MasterCatalogRolloutTable.tsx`
- Modify: `avoqado-superadmin/CHANGELOG.md`
- Modify: `src/controllers/superadmin/masterCatalog.superadmin.controller.ts`
- Modify: `src/routes/superadmin/masterCatalog.routes.ts`
- Create: `src/services/master-catalog/catalogPricingReadiness.service.ts`
- Create: `tests/unit/services/master-catalog/catalogPricingReadiness.service.test.ts`
- Create: `tests/api-tests/superadmin/masterCatalogPricingReadiness.api.test.ts`
- Create: `avoqado-superadmin/src/features/master-catalog/MasterCatalogPricingReadiness.test.tsx`

- [ ] Extend the existing H1A page/types/API; do not add a second route or feature. Display regionalPricingEnabled, topology revision, last
      publication, APPLYING/FAILED count, outbox lag, retry/dead-letter count, and readiness/failure reason.
- [ ] Write RED proving superadmin endpoints remain `/api/v1/superadmin/*` and never expose rule, region, workbook, price,
      publication-confirm, or content mutation APIs.
- [ ] Server readiness response returns only flags, topology revision, last-applied timestamp, expired APPLYING count, outbox
      pending/dead-letter counts, lag, and failure summary. Negative API tests assert it never contains item, SKU, amount, rule, region
      membership detail, or workbook data.
- [ ] Gate change requires explicit confirmation, active superadmin, non-impersonated session, reason, and server-returned audit. It never
      materializes prices or advances governance itself.
- [ ] Run the server readiness checks before the frontend checkpoint:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogPricingReadiness.service.test.ts
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/superadmin/masterCatalogPricingReadiness.api.test.ts
npm run audit:permissions
npm run build
```

- [ ] Run the superadmin checks with the repo-required Node path:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-superadmin
PATH="/opt/homebrew/bin:$PATH" npm run test:run -- \
  src/features/master-catalog/MasterCatalogPricingReadiness.test.tsx
PATH="/opt/homebrew/bin:$PATH" npm run check
PATH="/opt/homebrew/bin:$PATH" npm run build
```

- [ ] Propose checkpoint `feat(h1c): surface pricing rollout health`; pause before Git.

## Task 14 — Verify performance, document rollout, and demonstrate reversible pricing

**Files**

- Modify: `docs/PITS-H1-CHANGE-MANIFEST.md`
- Modify: `docs/superpowers/specs/2026-08-08-pits-h1-master-catalog-design.md` only with verified implementation evidence that preserves
  approved decisions
- Modify: `docs/superpowers/plans/2026-08-08-pits-h1c-regional-pricing.md`
- Create: `docs/PITS-H1C-REGIONAL-PRICING-RUNBOOK.md`
- Create: `docs/api/master-catalog-pricing-v1.md`
- Modify: `docs/mcp/master-catalog-h1a.md`
- Create: `docs/PITS-H1C-REGIONAL-PRICING-ADMIN-GUIDE.md`
- Create: `docs/xlsx/price-adjustments-v1.md`
- Create: `docs/xlsx/regional-values-v1.md`
- Create: `docs/xlsx/price-changes-v1.md`
- Modify: `docs/PITS-HANDOFF.md`
- Modify: `docs/PITS-HANDOFF-SESION-2026-08-08.md` created by H1A
- Modify: `docs/PITS-INVENTARIO-MATRIZ.md`
- Modify: `docs/PITS-PROGRAMA-COMPLETO.md`
- Modify: `docs/DEMO-PITS-2026-08-BITACORA.md`
- Modify: `docs/README.md`
- Create: `scripts/benchmark-catalog-pricing-publication.ts`
- Create: `tests/unit/scripts/benchmarkCatalogPricingPublication.test.ts`
- Modify: `avoqado-server/CHANGELOG.md`
- Modify: `avoqado-web-dashboard/CHANGELOG.md`
- Modify: `avoqado-superadmin/CHANGELOG.md`
- Modify: `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-presentacion-v2.html`
- Modify/refork:
  `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-presentacion-v2-sin-nexgo.html`
- Modify: `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-one-pager-v2.html`
- Modify: `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-one-pager-cliente.html`
- Regenerate:
  `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/Avoqado-Presentacion-Plataforma-V2.pdf`
- Regenerate:
  `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/Avoqado-Presentacion-Plataforma-pax.pdf`
- Regenerate: `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/Avoqado-One-Pager-V2.pdf`
- Regenerate: `/Users/amieva/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/Avoqado-One-Pager-Cliente.pdf`

- [ ] Document rule precedence, money/currency, no-FX, topology atomicity, cap, preview/confirm, idempotency recovery, CAS/lease/watchdog,
      outbox at-least-once, history/divergence, inverse publication, metrics/alerts, disable behavior, and PITS acceptance blocker. The
      runbook and admin guide explicitly cover gate/readiness/superadmin operations; the MCP document freezes scopes, string-money,
      preview/confirm/idempotency and `list_catalog_price_changes`. Each XLSX dictionary freezes Metadata/version, grain, columns,
      nullability, formats, and formula neutralization.
- [ ] Run capacity checks and serialize heavy verification. Execute Prisma/schema-map, full H1C unit/API/integration/workflow/MCP tests,
      permissions audit, build, pre-deploy, dashboard targeted suite/build/E2E, and superadmin checks. No mandatory money/concurrency test
      is deferred.
- [ ] Benchmark preview and apply at 200, 6,200, and 10,000 expanded targets. Target p95 preview under 5 seconds and apply under 15 seconds
      at 6,200; record query count, lock duration, memory, outbox size, and event-loop lag. Cap+1 must reject before writes.
- [ ] Make the benchmark script reject a missing/non-disposable database, seed deterministic targets, run 200/6,200/10,000 plus 10,001 cap
      rejection, and emit machine-readable evidence without logging prices or credentials. The workflow test remains the reproducible
      inverse-publication demo; benchmark and workflow are both required.
- [ ] Demonstrate in an isolated environment: two overlapping regions and priority; venue exception; sale/purchase and wrong currency;
      manual and XLSX same hash; publish; POS offline keeps old scalar; reconnect refreshes; duplicate/missing socket converges; concurrent
      confirm recovers; legacy edit becomes DIVERGED; inverse publication restores through a new APPLIED batch.
- [ ] Canary order is fixed: expand-only migration/no backfill → backend with MASTER_CATALOG and regional gate OFF → hidden dashboard →
      H1A/H1C dry-run in ADVISORY → explicit PITS grant/core plus preflight → one regional venue → venue-by-venue expansion → ENFORCED only
      after matrix, contract, and readiness. Gate/entitlement OFF blocks new commands without deleting or reverting data; monetary
      correction uses only inverse publication.
- [ ] The runbook records that server `develop` currently has no automatic Render/Fly staging deploy, while dashboard develop can deploy
      demo. Assign an owner to restore/use an isolated manual backend, verify migration/health/gates OFF there, and deploy dashboard only
      afterward. The first H1C canary never runs directly in production.
- [ ] Canary asserts Product.price equals existing PricingPolicy.currentPrice, one ActivityLog summary, truthful Current/History, drained
      outbox, duplicate-confirm/timeout GET recovery, oldPrice-zero null percentage, legacy-edit divergence, safe exports, cross-tenant 404,
      and no H1 query for non-PITS/OFF.
- [ ] Verify a non-PITS venue and a PITS venue with gate false perform all existing pricing/Product/ menu/checkout/order/inventory flows
      without H1 query or behavior change.
- [ ] Update customer material only with demonstrated behavior. Row 47 remains not contractually accepted until PITS chooses price, cost, or
      both and approves report columns. Regenerate with Chrome headless `--no-pdf-header-footer --virtual-time-budget=15000`; verify
      `pdfinfo`, extracted text, and rasterized affected pages. Refork the PAX/Blumon-only variant without NexGo or other processors, and
      record the owner/link/evidence for the separately shared clickable web deck.
- [ ] Execute every command in `Exact final verification commands` below, in listed order, including the disposable-DB benchmark and
      workflow proof; no money/concurrency/performance gate is replaced by documentation evidence.
- [ ] Propose checkpoint `docs(h1c): document regional pricing rollout`; pause before Git.

## Exact final verification commands

`H1_TEST_DATABASE_URL` must be set explicitly to a disposable database dedicated to H1 tests. The integration setup must reject an empty
value or any attempt to fall back to production `DATABASE_URL`; credentials never belong in this plan.

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server

npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/contracts/masterCatalogPricing.contract.test.ts \
  tests/unit/services/master-catalog/catalogMoney.service.test.ts \
  tests/unit/services/master-catalog/catalogPricing.service.test.ts \
  tests/unit/services/master-catalog/catalogPriceRegion.service.test.ts \
  tests/unit/services/master-catalog/catalogPriceImport.service.test.ts \
  tests/unit/services/master-catalog/catalogPricePublisher.service.test.ts \
  tests/unit/services/master-catalog/catalogPublicationIdempotency.service.test.ts \
  tests/unit/jobs/catalog-publication-watchdog.job.test.ts \
  tests/unit/services/master-catalog/catalogPublicationOutboxPricing.service.test.ts \
  tests/unit/communication/sockets/productPriceChangedSerializer.test.ts \
  tests/unit/jobs/catalog-publication-outbox-sweeper.job.test.ts \
  tests/unit/services/master-catalog/catalogPriceHistory.service.test.ts \
  tests/unit/services/master-catalog/catalogPriceExport.service.test.ts \
  tests/unit/services/master-catalog/catalogPriceExport.eventloop-budget.test.ts \
  tests/unit/workers/masterCatalogXlsx.worker.test.ts \
  tests/unit/services/master-catalog/catalogPricingReadiness.service.test.ts \
  tests/unit/scripts/benchmarkCatalogPricingPublication.test.ts \
  tests/unit/routes/masterCatalogPricing.routes.test.ts \
  tests/unit/mcp-customer/master-catalog-pricing.test.ts

npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/catalogPricePreview.api.test.ts \
  tests/api-tests/master-catalog/catalogPriceExport.api.test.ts \
  tests/api-tests/master-catalog/masterCatalogPricing.api.test.ts \
  tests/api-tests/superadmin/masterCatalogPricingReadiness.api.test.ts

npx jest --selectProjects=workflows --runInBand --runTestsByPath \
  tests/workflows/master-catalog-price-publication.workflow.test.ts

test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogPricingMigration.integration.test.ts \
  tests/integration/master-catalog/catalogPricingConstraints.integration.test.ts \
  tests/integration/master-catalog/catalogPriceTopology.integration.test.ts \
  tests/integration/master-catalog/catalogPricePublication.integration.test.ts \
  tests/integration/master-catalog/catalogPublicationConcurrency.integration.test.ts \
  tests/integration/master-catalog/catalogPriceReversal.integration.test.ts

npx prisma validate
npx prisma generate
npm run schema:map
npm run schema:map -- --check
npm run audit:permissions
npm run typecheck
npm run build
H1_TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx tsx scripts/benchmark-catalog-pricing-publication.ts \
  --targets 200,6200,10000,10001 \
  --preview-p95-ms 5000 --apply-p95-ms 15000 --assert-cap-reject
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" npm run pre-deploy
```

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard
npm run test:run -- \
  src/features/master-catalog \
  src/pages/Organization/MasterCatalog \
  src/pages/Menu/__tests__/CatalogVenuePriceChangesPage.test.tsx
npm run lint:i18n
npm run lint
npm run build
npm run test:e2e -- e2e/tests/master-catalog/catalog-pricing.spec.ts
npm run pre-deploy -- --skip-e2e
```

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-superadmin
PATH="/opt/homebrew/bin:$PATH" npm run test:run -- \
  src/features/master-catalog/MasterCatalogPricingReadiness.test.tsx
PATH="/opt/homebrew/bin:$PATH" npm run check
PATH="/opt/homebrew/bin:$PATH" npm run build
```

## H1C completion gate

H1C is technically complete only when migration is expand-only, rules resolve deterministically by currency/priority, manual and XLSX
commands are identical, one 10,000-target publication is fully atomic, concurrent confirms/watchdog/outbox are recoverable, scalar Product
price remains the only POS read source, current/history/divergence/reversal are truthful, venue and organization permissions are isolated,
and default-off/non-PITS regressions pass. Commercial acceptance remains separate until PITS provides its written row-47 interpretation and
approves the real layouts and volume.
