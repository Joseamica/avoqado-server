# PITS H1A — Catalog Core Implementation Plan

> **Required execution skill:** use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Apply
> `superpowers:test-driven-development` to every migration, permission, tenant-isolation, money, import, concurrency, and publication step.

**Goal:** Add the default-off organizational master-catalog spine for PITS—corporate product and dish identity, governance, business-type
profiles, safe XLSX staging, explicit venue bindings, managed-field publication, audit, and exports—without replacing `Product` or changing
any current venue, POS, inventory, recipe, modifier, order, or checkout contract.

**Design:** [`2026-08-08-pits-h1-master-catalog-design.md`](../specs/2026-08-08-pits-h1-master-catalog-design.md)

**Architecture:** `CatalogItem` is an organization-scoped identity and reporting aggregate. `Product` remains the venue-scoped operational
aggregate and keeps its ID, scalar price, stock, recipe, modifiers, category, availability, and existing endpoints. A dedicated explicit
`OrganizationEntitlement` plus an `ORGANIZATION_ONLY` `MASTER_CATALOG` module controls new administration paths. New catalog commands use
one organization authorization resolver, preview then confirm, tenant-safe foreign keys, transactional ActivityLog, deterministic field
hashes, and a generic publication/outbox spine that H1B and H1C extend. All gates start false.

**Tech Stack:** Node.js 20, TypeScript, Express, Prisma/PostgreSQL, Zod, Jest/Supertest, `xlsx`, RabbitMQ/Socket.IO, customer MCP; React
18.3.1, Vite, TanStack Query/Table, React Hook Form, Zod, Vitest/Testing Library, Playwright; dedicated React superadmin.

## Global constraints

- Work in the shared dirty workspace. Before every edit, reread the live file and preserve every unrelated block. Agents are not alone and
  must never revert another session's work.
- Do not stage, commit, push, create/switch branches, reset, checkout, clean, or stash without a new explicit authorization from the user.
  Never use `git add -A` or `git add .`.
- Before the first product-code edit, create `avoqado-server/docs/PITS-H1-CHANGE-MANIFEST.md`. Every later task records repo, exact path,
  symbol/block, reason, tests, rollout impact, and whether the file format supports comments.
- Every touched logical code block gets a concise comment explaining why the additive/default-safe behavior exists. Do not narrate syntax.
  Prisma/SQL/JSON/XLSX-generated surfaces that cannot carry a useful inline comment are explained in the manifest and migration header.
- H1A is ENTERPRISE/custom only. PREMIUM, demo, grandfathered venues, `VenueFeature`, tier inheritance, and `VenueModule` never grant it.
  PITS receives no grant during migration or seed.
- `OrganizationEntitlement` answers commercial access. `OrganizationModule` plus versioned config answers rollout.
  `resolveMasterCatalogAccess()` is the only mutation resolver for HTTP, MCP, jobs, and dashboard. Unknown/missing configuration fails
  closed for H1 mutations.
- `catalogCoreEnabled`, `identifiersEnabled`, and `regionalPricingEnabled` start `false`; `governanceMode` starts `OFF`. No deployment
  advances a gate or governance state.
- NEVER_ENABLED organizations and venues retain existing status codes, response envelopes, validations, query shapes, and writer behavior.
  No current Product read, checkout, stock, recipe, modifier, order, or price path depends on an H1 table.
- `Product.id`, `Product.price`, `Product.categoryId`, inventory, Recipe, modifiers, availability, POS sync metadata, and historical order
  snapshots remain operational sources of truth.
- New API fields and routes are additive. Legacy Product payloads do not gain catalog joins or an `identifiers` relation, and scalar `price`
  is never replaced by an effective-price object.
- Organization authorization never reuses venue `checkPermission` or trusts an organization ID in the body. It derives scope from the
  route/auth context and rechecks active `Staff`, active `StaffOrganization`, `leftAt = null`, and `OrgRole` on each request.
- OWNER and ADMIN can manage catalog content; OWNER additionally manages validation profiles and expiring readiness overrides. Neither
  controls commercial entitlement, module gates, or rollout transitions in the standard dashboard; those remain dedicated superadmin
  control-plane actions. VIEWER is read-only; MEMBER has no catalog access by default. Superadmin changes only commercial
  entitlement/module/gates/readiness through `/api/v1/superadmin/*` and cannot mutate content.
- Impersonation is read-only for H1. Cross-tenant IDs return 404. Composite foreign keys also reject cross-tenant writes performed below the
  service layer.
- Money stays `Prisma.Decimal`, is accepted on new APIs as a canonical two-decimal string, preserves `0.00`, never crosses JavaScript
  `number`, and rejects more than two decimals or values outside `0.00..99999999.99`.
- Corporate SKU is organization-scoped only inside H1. Existing local Product SKU/GTIN uniqueness and meanings do not change in H1A; H1B
  owns the fenced operational identifier registry.
- Catalog links are explicit. SKU/GTIN/name may produce preview candidates but never auto-link, re-ID, reparent, delete, or overwrite a
  Product.
- Managed-field concurrency uses ordered `fieldMask`, hash version 1, current values of only those fields, canonical Decimal strings, NFC
  strings, and SHA-256. Stock, recipe, modifiers, category, availability, and unrelated Product fields never enter the gate hash.
- OFF and ADVISORY never block current creation or editing for completeness. ENFORCED blocks only a new/activated vendable Product after
  both organization and venue governance are explicitly ENFORCED; pre-existing Products remain grandfathered.
- A PREPARED_DISH binding reads the venue Recipe; it never copies a recipe. Publication requires positive portions, positive
  `Recipe.prepTime`, valid lines, and a scale-4 HALF_UP cost-per-portion matching the authoritative calculator.
- XLSX imports are separate from legacy menu replace/import. All rows stage first; any validation error means zero catalog, Product, price,
  identifier, or binding writes. A confirm needs the prior preview token/hash, `confirm: true`, and an idempotency key.
- Formula-like text is neutralized in exports. IDs/codes are text, timestamps RFC3339 UTC, money has fixed scale, and every workbook
  includes the versioned `Metadata` sheet defined by the spec.
- H1 writes and their organization ActivityLog summary share one transaction. Do not reuse the existing fire-and-forget ActivityLog helper
  for H1 mutations.
- Outbox delivery is at-least-once. Event IDs and venue sequence values are stable across retries; consumers deduplicate or refetch. A
  socket/RabbitMQ failure never rolls back a committed batch.
- Prisma changes require `npx prisma validate`, `npx prisma generate`, `npm run schema:map`, and checked-in `docs/SCHEMA_MAP.md`
  regeneration.
- Customer MCP is `avoqado-server/src/mcp/`, not the admin MCP under `scripts/mcp/`. MCP mutations always require `mcp:write`, active
  membership, exact role, preview, confirm, idempotency, and audit.
- Dashboard UI ships in Spanish, English, and French with keyboard operation, visible focus, screen-reader labels, paginated tables, and
  fail-closed navigation/query gating.
- During execution, read each frontend's design instructions and use the applicable Impeccable skills before visible UI changes. Do not
  invent a parallel component system.
- Android and iOS parity is not part of H1A behavior; H1B changes them together. H1A must still keep their current Product/menu contracts
  byte-compatible through contract fixtures.
- Partner presentation, one-pagers, generated PDFs, changelogs, runbook, schema map, and this milestone's acceptance matrix must be updated
  before H1A is called complete.
- PITS's pending answers do not block an off-gated expand-only spine. They do block ENFORCED, contractual acceptance, maker-checker claims,
  raw-material scope, and final workbook layouts.

## Milestone boundary and dependencies

H1A owns rows 43, 44, and 248 plus the enabling assignment/import work for rows 46 and 191. It creates the shared entitlement,
authorization, audit, import, binding, validation, preview/hash, publication, and outbox contracts. H1B may add non-SKU corporate
identifiers and venue identifier projection only after the H1A CatalogItem/CORPORATE_SKU transaction and rollout models are stable. H1C may
add regional/venue price rules and monetary publication lines only after H1A organization price rules, bindings, idempotency, and
publication state transitions are stable.

The shared-workspace integration order is H1A → H1B → H1C for server, dashboard, manifest, handoff, and presentation files. Subagents may
run concurrently only on explicitly disjoint files inside the active milestone; one integrator owns every shared file. H1C design work may
continue earlier, but H1C implementation does not edit shared paths until H1B has integrated and verified them.

H1A can deploy with every gate false. It cannot be commercially accepted until PITS supplies the field matrix and real layouts; until then
validation profiles remain ADVISORY and the preserved baseline in the approved spec is the non-relaxable default.

## Exact contract and file map

### Server files to create

- `src/types/master-catalog.ts`
- `src/services/master-catalog/masterCatalogAccess.service.ts`
- `src/services/master-catalog/catalogAuthorization.service.ts`
- `src/services/master-catalog/catalogAudit.service.ts`
- `src/services/master-catalog/catalogMoney.service.ts`
- `src/services/master-catalog/catalogHash.service.ts`
- `src/services/master-catalog/identifierNormalization.service.ts`
- `src/services/master-catalog/catalogItem.service.ts`
- `src/services/master-catalog/catalogValidation.service.ts`
- `src/services/master-catalog/catalogRecipeCost.service.ts`
- `src/services/master-catalog/catalogImport.service.ts`
- `src/services/master-catalog/catalogWorkbook.service.ts`
- `src/services/master-catalog/catalogBinding.service.ts`
- `src/services/master-catalog/catalogOverride.service.ts`
- `src/services/master-catalog/catalogPublication.service.ts`
- `src/services/master-catalog/catalogPublicationOutbox.service.ts`
- `src/services/master-catalog/catalogGovernance.service.ts`
- `src/services/master-catalog/catalogExport.service.ts`
- `src/services/dashboard/recipe-cost-calculator.ts`
- `src/jobs/catalog-publication-outbox-sweeper.job.ts`
- `src/jobs/catalog-publication-watchdog.job.ts`
- `src/controllers/dashboard/masterCatalog.dashboard.controller.ts`
- `src/routes/dashboard/masterCatalog.routes.ts`
- `src/routes/dashboard/masterCatalogVenue.routes.ts`
- `src/controllers/superadmin/masterCatalog.superadmin.controller.ts`
- `src/routes/superadmin/masterCatalog.routes.ts`
- `src/mcp/tools/masterCatalog.ts`
- `prisma/migrations/20260808120000_add_master_catalog_core/migration.sql`

### Server files to modify

- `prisma/schema.prisma`
- `scripts/setup-modules.ts`
- `scripts/generate-schema-map.ts`
- `docs/SCHEMA_MAP.md`
- `src/services/modules/module.service.ts`
- `src/controllers/dashboard/modules.superadmin.controller.ts`
- `src/controllers/dashboard/organizations.superadmin.controller.ts`
- `src/routes/dashboard.routes.ts`
- `src/routes/superadmin.routes.ts`
- `src/routes/superadmin/module.routes.ts`
- `src/mcp/scope.ts`
- `src/mcp/guard.ts`
- `src/mcp/server.ts`
- `src/lib/permissions.ts`
- `src/controllers/dashboard/auth.dashboard.controller.ts`
- `src/services/dashboard/activity-log.service.ts`
- `src/jobs/jobSchedules.ts`
- `src/server.ts`
- `src/services/dashboard/product.dashboard.service.ts`
- `src/controllers/dashboard/product.dashboard.controller.ts`
- `src/services/dashboard/productWizard.service.ts`
- `src/controllers/dashboard/inventory/productWizard.controller.ts`
- `src/services/dashboard/menu.dashboard.service.ts`
- `src/services/dashboard/recipe.service.ts`
- `src/controllers/mobile/product.mobile.controller.ts`
- `src/routes/tpv.routes.ts`
- `src/services/pos-sync/posSyncOrderItem.service.ts`
- `src/services/delivery-channels/core/deliveryOrderIngestion.service.ts`
- `src/services/onboarding/venueCreation.service.ts`
- `src/services/onboarding/demoSeed.service.ts`
- `CHANGELOG.md`

### Dashboard files to create

- `src/features/master-catalog/types.ts`
- `src/features/master-catalog/api.ts`
- `src/features/master-catalog/use-master-catalog-access.ts`
- `src/features/master-catalog/errors.ts`
- `src/features/master-catalog/use-catalog-items.ts`
- `src/pages/Organization/MasterCatalog/MasterCatalogLayout.tsx`
- `src/pages/Organization/MasterCatalog/CatalogItemsPage.tsx`
- `src/pages/Organization/MasterCatalog/CatalogItemPage.tsx`
- `src/pages/Organization/MasterCatalog/CatalogImportPage.tsx`
- `src/pages/Organization/MasterCatalog/CatalogBindingsPage.tsx`
- `src/pages/Organization/MasterCatalog/CatalogPublicationsPage.tsx`
- `src/pages/Organization/MasterCatalog/CatalogAuditPage.tsx`
- `src/pages/Organization/MasterCatalog/components/CatalogItemForm.tsx`
- `src/pages/Organization/MasterCatalog/components/CatalogPreviewTable.tsx`
- `src/pages/Organization/MasterCatalog/components/CatalogValidationSummary.tsx`
- `src/pages/Organization/MasterCatalog/components/CatalogBindingDecisionTable.tsx`
- `src/routes/MasterCatalogProtectedRoute.tsx`

### Dashboard files to modify

- `src/routes/router.tsx`
- `src/routes/lazyComponents.ts`
- `src/pages/Organization/OrganizationLayout.tsx`
- `src/pages/Organization/components/OrgSidebar.tsx`
- `src/hooks/use-current-organization.tsx`
- `src/services/auth.service.ts`
- `src/context/AuthContext.tsx`
- `src/types.ts`
- `src/components/Sidebar/venues-switcher.tsx`
- `src/lib/permissions/defaultPermissions.ts`
- `src/services/menu.service.ts`
- `src/pages/Menu/Products/createProduct.tsx`
- `src/pages/Menu/Products/Products.tsx`
- `src/pages/Menu/Products/productId.tsx`
- `src/pages/Inventory/components/ProductWizardDialog.tsx`
- `src/components/menu/MenuImportDialog.tsx`
- `src/locales/es/organization.json`
- `src/locales/en/organization.json`
- `src/i18n.ts`
- `CHANGELOG.md`

Create alongside those dashboard changes:

- `src/locales/fr/organization.json`

### Dedicated superadmin files to create

- `src/features/master-catalog/types.ts`
- `src/features/master-catalog/api.ts`
- `src/features/master-catalog/use-master-catalog.ts`
- `src/features/master-catalog/MasterCatalogAccessPage.tsx`
- `src/features/master-catalog/MasterCatalogOrganizationDrawer.tsx`
- `src/features/master-catalog/MasterCatalogRolloutTable.tsx`

### Dedicated superadmin files to modify

- `src/app/router.tsx`
- `src/shared/layouts/AppLayout.tsx`
- `README.md`
- `CHANGELOG.md`

### Planned HTTP and MCP surface

Dashboard organization routes are mounted under `/api/v1/dashboard/organizations/:orgId/master-catalog`:

```text
GET    /access
GET    /items
POST   /items
GET    /items/:catalogItemId
PATCH  /items/:catalogItemId
POST   /items/:catalogItemId/retire
GET    /validation-profiles
POST   /validation-profiles/preview
POST   /validation-profiles/:profileBatchId/confirm
GET    /catalogs/brands
POST   /catalogs/brands
PATCH  /catalogs/brands/:brandId
POST   /catalogs/brands/:brandId/retire
GET    /catalogs/manufacturers
POST   /catalogs/manufacturers
PATCH  /catalogs/manufacturers/:manufacturerId
POST   /catalogs/manufacturers/:manufacturerId/retire
GET    /catalogs/families
POST   /catalogs/families
PATCH  /catalogs/families/:familyId
POST   /catalogs/families/:familyId/retire
POST   /imports/preview
GET    /imports/:importBatchId
GET    /imports/:importBatchId/errors.xlsx
POST   /imports/:importBatchId/confirm
POST   /bindings/preview
POST   /bindings/confirm
POST   /publications/preview
POST   /publications/:publicationBatchId/confirm
GET    /publications/by-idempotency-key/:operation/:idempotencyKey
GET    /publications/:publicationBatchId
POST   /publications/:publicationBatchId/reversal/preview
GET    /publications
GET    /audit
GET    /audit/actions
GET    /exports/catalog-master.xlsx
GET    /exports/catalog-by-business-type.xlsx
GET    /templates/catalog-master-v1.xlsx
```

Venue-scoped H1A reads/requests are mounted under `/api/v1/dashboard/venues/:venueId/master-catalog`:

```text
GET    /access
GET    /products/:productId/provenance
GET    /changes
POST   /override-requests/preview
POST   /override-requests/:requestBatchId/confirm
```

Dedicated superadmin routes are mounted only under `/api/v1/superadmin/master-catalog`:

```text
GET    /organizations
GET    /organizations/:organizationId
PUT    /organizations/:organizationId/entitlement
PUT    /organizations/:organizationId/module
PUT    /organizations/:organizationId/config
PUT    /organizations/:organizationId/venues/:venueId/governance
```

Customer MCP registers these H1A tools in `src/mcp/server.ts`:

```text
list_catalog_items
get_catalog_item
preview_catalog_import
confirm_catalog_import
preview_catalog_publication
confirm_catalog_publication
request_catalog_override
```

### Core TypeScript contracts

```ts
export type GovernanceMode = 'OFF' | 'ADVISORY' | 'ENFORCED'
export type CatalogItemKind = 'RETAIL_PRODUCT' | 'PREPARED_DISH'
export type CatalogItemStatus = 'ACTIVE' | 'RETIRED'
export type CatalogMutationRole = 'OWNER' | 'ADMIN'

export interface MasterCatalogModuleConfigV1 {
  schemaVersion: 1
  catalogCoreEnabled: boolean
  identifiersEnabled: boolean
  regionalPricingEnabled: boolean
  governanceMode: GovernanceMode
}

export interface MasterCatalogAccess {
  organizationId: string
  orgRole: 'OWNER' | 'ADMIN' | 'VIEWER' | 'MEMBER' | null
  entitlementActive: boolean
  moduleActive: boolean
  config: MasterCatalogModuleConfigV1 | null
  canRead: boolean
  canMutateContent: boolean
  canConfigureControlPlane: boolean
}

export type CatalogActor = { type: 'HUMAN'; staffId: string; impersonating: boolean } | { type: 'SERVICE'; servicePrincipalId: string }

export interface CatalogCommandContext {
  organizationId: string
  actor: CatalogActor
  orgRole?: MasterCatalogAccess['orgRole']
  idempotencyKey?: string
}

export interface CatalogReadContext {
  organizationId: string
  actor: CatalogActor
  orgRole?: MasterCatalogAccess['orgRole']
}

export interface CatalogConfirmInput {
  previewToken: string
  confirm: true
  idempotencyKey: string
}

export interface CatalogPreviewTokenV1 {
  schemaVersion: 1
  organizationId: string
  commandKind: string
  targetHash: string
  expiresAt: string
}
```

The implementation entry points remain explicit and testable:

```ts
export async function resolveMasterCatalogAccess(input: {
  organizationId: string
  principal: CatalogActor
  capability: 'READ_CONTENT' | 'MUTATE_CONTENT' | 'MANAGE_PROFILE' | 'CONFIGURE_CONTROL_PLANE' | 'RUN_SERVICE_JOB'
  requiredGate: 'CORE' | 'IDENTIFIERS' | 'REGIONAL_PRICING'
  prisma?: Prisma.TransactionClient
}): Promise<MasterCatalogAccess>

export async function createCatalogItem(context: CatalogCommandContext, input: CreateCatalogItemInput): Promise<CatalogItemDetail>

export async function previewCatalogImport(context: CatalogCommandContext, workbook: Buffer): Promise<CatalogImportPreview>

export async function confirmCatalogImport(
  context: CatalogCommandContext,
  input: CatalogConfirmInput & { importBatchId: string },
): Promise<CatalogImportResult>

export async function previewCatalogBindings(
  context: CatalogCommandContext,
  input: CatalogBindingPreviewInput,
): Promise<CatalogBindingPreview>

export async function confirmCatalogBindings(
  context: CatalogCommandContext,
  input: CatalogConfirmInput & { bindingBatchId: string },
): Promise<CatalogBindingResult>

export async function previewCatalogPublication(
  context: CatalogCommandContext,
  input: CatalogPublicationPreviewInput,
): Promise<CatalogPublicationPreview>

export async function confirmCatalogPublication(
  context: CatalogCommandContext,
  input: CatalogConfirmInput & { publicationBatchId: string },
): Promise<CatalogPublicationResult>

export async function getCatalogPublicationByIdempotencyKey(
  context: CatalogReadContext,
  input: { operation: CatalogPublicationOperation; idempotencyKey: string },
): Promise<CatalogPublicationResult | CatalogPublicationInProgress>

export async function writeCatalogActivityLog(tx: Prisma.TransactionClient, input: CatalogAuditInput): Promise<void>

export async function assertLegacyCatalogGovernance(
  tx: Prisma.TransactionClient,
  input: {
    venueId: string
    operation: 'CREATE' | 'ACTIVATE'
    willBeVendable: boolean
  },
): Promise<void>

export async function evaluatePreparedDishBinding(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; venueId: string; productId: string },
): Promise<PreparedDishReadiness>
```

## Verification convention used by every task

1. Add the smallest focused test and run it to observe RED for the intended missing behavior.
2. Implement only enough production code for that behavior, including the required why-comment.
3. Run the focused test GREEN, then the complete touched-module suite.
4. Run formatter/lint/typecheck for the touched project; migrations also run Prisma/schema-map checks and an isolated-database migration
   test.
5. Update `docs/PITS-H1-CHANGE-MANIFEST.md` before moving to the next task.
6. Propose a Git checkpoint and pause. If the user authorizes it, stage only the exact paths listed in that task and commit with the
   proposed message. If authorization is not given, continue with an unstaged checkpoint record in the manifest.

## Task 1 — Create the change manifest and freeze legacy contracts

**Files**

- Create: `docs/PITS-H1-CHANGE-MANIFEST.md`
- Create: `tests/contracts/master-catalog/product-dashboard-legacy.fixture.json`
- Create: `tests/contracts/master-catalog/product-mobile-legacy.fixture.json`
- Create: `tests/contracts/master-catalog/product-tpv-legacy.fixture.json`
- Create: `tests/contracts/master-catalog/identifier-normalization-v1.json`
- Create: `tests/unit/contracts/masterCatalogLegacyProduct.contract.test.ts`

- [ ] Record the current branch/HEAD and `git status --porcelain` for server, dashboard, superadmin, Android, iOS, TPV, and Desktop without
      modifying Git state. Add the known shared-WIP warning and the explicit-path-only rule to the manifest.
- [ ] Capture representative Product list/detail/create/update envelopes for dashboard, mobile, and TPV from existing tests/serializers.
      Remove volatile IDs/timestamps but preserve required fields, null behavior, Decimal serialization, status, and error envelopes.
- [ ] Write the contract test so it calls the current serializers/controllers and proves there is no catalog relation, no effective-price
      object, and no new dependency on organization access.
- [ ] Freeze corporate-SKU normalization v1 vectors—NFKC, peripheral trim, locale-neutral uppercase, leading zeroes, spaces, and hyphens—in
      the identifier fixture. H1B may add format/checksum cases but must never reinterpret an H1A corporate SKU.
- [ ] Run the focused contract test and record GREEN as the pre-change baseline:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/contracts/masterCatalogLegacyProduct.contract.test.ts
```

- [ ] Add the six files to the manifest, including why the JSON fixtures cannot contain comments.
- [ ] Propose checkpoint `test(h1a): freeze legacy product contracts`; pause for authorization. If authorized, run only:

```bash
git add docs/PITS-H1-CHANGE-MANIFEST.md \
  tests/contracts/master-catalog/product-dashboard-legacy.fixture.json \
  tests/contracts/master-catalog/product-mobile-legacy.fixture.json \
  tests/contracts/master-catalog/product-tpv-legacy.fixture.json \
  tests/contracts/master-catalog/identifier-normalization-v1.json \
  tests/unit/contracts/masterCatalogLegacyProduct.contract.test.ts
git commit -m "test(h1a): freeze legacy product contracts"
```

## Task 2 — Add the expand-only H1A schema and database invariants

**Files**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260808120000_add_master_catalog_core/migration.sql`
- Create: `tests/integration/master-catalog/h1a-migration.integration.test.ts`
- Create: `tests/integration/master-catalog/h1a-tenant-constraints.integration.test.ts`
- Create: `tests/integration/master-catalog/h1a-corporate-sku-trigger.integration.test.ts`
- Modify: `scripts/generate-schema-map.ts`
- Modify/generated: `docs/SCHEMA_MAP.md`

- [ ] Write RED migration tests against a disposable PostgreSQL database containing legacy Products tied to orders, inventories, recipes,
      modifiers, categories, and pricing policies. Prove migration preserves IDs/counts/relationships and creates zero grants, catalog rows,
      bindings, or publications.
- [ ] Write RED SQL-direct tenant tests for every composite boundary: CatalogItem↔organization, binding↔organization/venue/Product,
      CatalogIdentifier↔CatalogItem, organization price rule↔CatalogItem, import/publication line↔batch, and ActivityLog actor
      combinations.
- [ ] Write RED deferred-trigger tests proving commit rejects a CatalogItem without exactly one CORPORATE_SKU projection, a normalized
      projection that differs from `CatalogItem.sku`, and a projection whose ACTIVE/RETIRED state diverges.
- [ ] Add these enums/models additively: `ModuleScope`, `OrganizationEntitlement`, `CatalogBrand`, `CatalogManufacturer`, `CatalogFamily`,
      `CatalogItem`, `CatalogItemBusinessType`, `CatalogProductTypeMapping`, the CORPORATE_SKU subset of `CatalogIdentifier`,
      `CatalogValidationProfile`, ORGANIZATION-scope `CatalogItemPrice`, `CatalogVenueRollout`, `CatalogVenueClientRequirement`,
      `CatalogClientObservation`, `CatalogClientReadinessOverride`, `CatalogVenueBinding`, `CatalogVenueOverride`, `CatalogImportBatch`,
      `CatalogImportLine`, `CatalogBindingBatch`, `CatalogBindingLine`, `CatalogIdempotencyRecord`, `CatalogPublicationBatch`,
      `CatalogPublicationLine`, `CatalogPublicationOutbox`, and stable per-venue event sequence ownership on CatalogVenueRollout or a
      dedicated locked `CatalogVenueEventSequence` row.
- [ ] Put generic preview/publication recovery in H1A: unique `(organizationId,operation,idempotencyKey)`, canonical requestHash/version,
      state/result/resource, attemptId, lease/heartbeat, PREVIEWED/APPLYING/APPLIED/FAILED transitions, and outbox claim/delivery
      fields/checks. H1B/H1C extend command/line payloads but do not create a second state machine.
- [ ] Store only a SHA-256 hash of each cryptographically random opaque preview token. Confirm uses constant-time comparison; raw bearer
      tokens are never persisted or logged. Capture targetHash, actor/org, dependencies, and expiration with the preview.
- [ ] Add `Module.scope` with default `BOTH`, `Product.createdById` nullable, `Venue.catalogGovernanceEnforcedAt` nullable/monotonic,
      `ActivityLog.organizationId`, conditional `actorType`, `servicePrincipalId`, and the organization composite keys required by the spec.
      Existing ActivityLog writers with null actor classification must remain valid; HUMAN and SERVICE combinations must be checked.
- [ ] Make Product.createdById `ON DELETE SET NULL`; make binding `(productId,venueId)` RESTRICT so a composite SET NULL cannot erase
      required venueId. Add supporting unique `(Product.id,venueId)` and `(Venue.id,organizationId)` keys with an index/lock-safe migration
      sequence.
- [ ] In SQL, add partial unique indexes and deferred constraint triggers that Prisma cannot express. Do not backfill legacy Product or
      invent actors. Add a migration header explaining expand-only safety and irreversible production policy.
- [ ] Extend `MODEL_TO_DOMAIN` in `scripts/generate-schema-map.ts`, then run:
- [ ] Add a `Master Catalog & Publication` domain for every Catalog aggregate, batch, line, outbox, rollout, validation, binding, and value
      model. Map OrganizationEntitlement to `Modules, Features & Billing`; keep Product, Venue, Module, and ActivityLog in existing domains.

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx prisma validate
npx prisma generate
npm run schema:map
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/h1a-migration.integration.test.ts \
  tests/integration/master-catalog/h1a-tenant-constraints.integration.test.ts \
  tests/integration/master-catalog/h1a-corporate-sku-trigger.integration.test.ts
```

- [ ] Run `npm run schema:map -- --check` after generation and fail if any model is unmapped or a stale map entry remains.

- [ ] Apply the migration only to the disposable database, query counts/defaults, and attach the assertions to the manifest. Do not migrate
      production during implementation.
- [ ] Propose checkpoint `feat(h1a): add expand-only catalog core schema`; pause for authorization. If authorized, stage exactly the Files
      list for this task plus the manifest and commit that message.

## Task 3 — Register the organization-only module and explicit entitlement

**Files**

- Modify: `scripts/setup-modules.ts`
- Modify: `src/services/modules/module.service.ts`
- Modify: `src/controllers/dashboard/modules.superadmin.controller.ts`
- Modify: `src/controllers/dashboard/organizations.superadmin.controller.ts`
- Create: `src/services/master-catalog/masterCatalogAccess.service.ts`
- Create: `src/types/master-catalog.ts`
- Create: `tests/unit/services/master-catalog/masterCatalogAccess.service.test.ts`
- Modify: `tests/unit/services/module-bulk.test.ts`
- Create: `tests/unit/scripts/masterCatalogModuleSeed.test.ts`

- [ ] Write RED access tests covering ACTIVE/REVOKED/not-yet-started/expired entitlement; active, inactive, and missing OrganizationModule;
      config schemaVersion 1, missing config, unknown version, malformed JSON, and data-access failure;
      PREMIUM/demo/grandfathered/VenueFeature/VenueModule must never grant access.
- [ ] Write RED module tests proving existing modules default to `BOTH`, MASTER_CATALOG is `ORGANIZATION_ONLY`, and generic VenueModule
      mutation rejects that module code without changing existing module behavior.
- [ ] Cover every venue-module method, not only enable: `isModuleEnabled`, `venuesWithModule`, `getModuleConfig`, `getEnabledModules`,
      `getEnabledModuleCodes`, `enableModule`, `disableModule`, and `updateModuleConfig` exclude/reject ORGANIZATION_ONLY. Organization
      enable/config methods similarly reject VENUE_ONLY. This prevents MASTER_CATALOG leaking into TPV login module payloads.
- [ ] Extend dedicated module create/update/read validation and responses with `scope`; preserve default `BOTH` for all existing callers.
- [ ] Thread `scope` through the current modules superadmin controller's direct Prisma create/update and organization module projections.
      Add additive response tests for generic module list/detail, organization module listing, and venue APIs rejecting ORGANIZATION_ONLY.
- [ ] Implement and validate this exact stored config without enabling it:

```ts
export const MASTER_CATALOG_DEFAULT_CONFIG: MasterCatalogModuleConfigV1 = {
  schemaVersion: 1,
  catalogCoreEnabled: false,
  identifiersEnabled: false,
  regionalPricingEnabled: false,
  governanceMode: 'OFF',
}
```

- [ ] Upsert only the Module definition in `scripts/setup-modules.ts`, which the existing seed already invokes. Keep `prisma/seed.ts`
      unchanged. Never create an `OrganizationEntitlement`, `OrganizationModule`, VenueModule, or PITS-specific grant from a seed.
- [ ] Implement `resolveMasterCatalogAccess()` so new mutations fail closed, reads report explicit reason codes, and already-published
      operational projections are not coupled to entitlement.
- [ ] Run GREEN and module regressions:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/masterCatalogAccess.service.test.ts \
  tests/unit/services/module-bulk.test.ts \
  tests/unit/scripts/masterCatalogModuleSeed.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1a): gate master catalog by explicit org entitlement`; pause for authorization. If authorized, stage exactly
      the Files list for this task plus the manifest and commit that message.

## Task 4 — Enforce organization roles and transactional audit

**Files**

- Create: `src/services/master-catalog/catalogAuthorization.service.ts`
- Create: `src/services/master-catalog/catalogAudit.service.ts`
- Modify: `src/services/dashboard/activity-log.service.ts`
- Create: `tests/unit/services/master-catalog/catalogAuthorization.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogAudit.service.test.ts`
- Create: `tests/api-tests/master-catalog/masterCatalogAuthorization.api.test.ts`

- [ ] Write RED role tests for OWNER/ADMIN/VIEWER/MEMBER, inactive Staff, inactive or left StaffOrganization, deleted organization, stale
      token membership, cross-tenant ID, superadmin, venue Staff only, and impersonation. Assert cross-tenant 404 rather than authorization
      leakage.
- [ ] Implement one authorization call that derives organizationId from the route/auth context and returns a typed command context. Do not
      accept organizationId from request bodies.
- [ ] Write RED transaction tests where audit insertion fails after a catalog write; the entire H1 transaction must roll back. Prove
      existing legacy callers of `logAction()` still retain their current best-effort behavior.
- [ ] Implement the H1-only audit writer with an explicit transaction client:

```ts
export async function writeCatalogAudit(tx: Prisma.TransactionClient, input: CatalogAuditInput): Promise<void>
```

- [ ] Extend ActivityLog querying/export so an organization-scoped request includes `organizationId = requestedOrganizationId` OR the legacy
      venue-scoped rows for venues in that organization. Keep all current venue filters and pagination ordering intact.

- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogAuthorization.service.test.ts \
  tests/unit/services/master-catalog/catalogAudit.service.test.ts
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/masterCatalogAuthorization.api.test.ts
npm run audit:permissions
```

- [ ] Propose checkpoint `feat(h1a): add org authorization and atomic catalog audit`; pause for authorization. If authorized, stage exactly
      the Files list for this task plus the manifest, then commit.

## Task 5 — Implement CatalogItem identity, canonical money, and revisions

**Files**

- Create: `src/services/master-catalog/catalogMoney.service.ts`
- Create: `src/services/master-catalog/catalogHash.service.ts`
- Create: `src/services/master-catalog/identifierNormalization.service.ts`
- Create: `src/services/master-catalog/catalogItem.service.ts`
- Create: `tests/unit/services/master-catalog/catalogMoney.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogHash.service.test.ts`
- Create: `tests/unit/services/master-catalog/identifierNormalization.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogItem.service.test.ts`

- [ ] Write RED money tests for blank, zero, integer, two decimals, three decimals, exponent, comma, negative, maximum, overflow, and
      non-string. Return canonical scale-2 strings without converting through JavaScript `number`.
- [ ] Write RED hash golden tests for ordered field masks, Decimal scale, null, enum, boolean, NFC strings, unrelated Product field changes,
      and hashVersion mismatch.
- [ ] Write RED CatalogItem tests for organization-scoped SKU uniqueness, mandatory actor/date, one CORPORATE_SKU projection, monotonic
      revision, ACTIVE→RETIRED reservation, normalized brand/manufacturer/family reuse, valid family hierarchy, business-type uniqueness,
      and tenant isolation.
- [ ] Implement the frozen `normalizeIdentifierV1()` SKU subset first. CatalogItem and its CORPORATE_SKU projection call that same pure
      function inside one transaction; H1A never stores a second interpretation that H1B would need to migrate.
- [ ] Implement brand/manufacturer/family create, update, and retire with normalized-name uniqueness, preserved display values, actor/date,
      tenant scope, and no silent relink. Retired references stay reportable; new assignments require active reference data.
- [ ] Implement item create/update/retire as one transaction. The SKU command must update CatalogItem and its non-editable CORPORATE_SKU
      projection together; there is no independent projection endpoint.
- [ ] Store ORGANIZATION SALE_PRICE and PURCHASE_COST rules as Decimal strings validated by the shared money parser. Do not write
      Product.price or Product.cost in this task.
- [ ] Ensure list/detail queries are paginated and do not load Recipe/modifier graphs. Expose actor and timestamps, profile validation
      state, bindings summary, and organization value rules.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogMoney.service.test.ts \
  tests/unit/services/master-catalog/catalogHash.service.test.ts \
  tests/unit/services/master-catalog/identifierNormalization.service.test.ts \
  tests/unit/services/master-catalog/catalogItem.service.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1a): implement corporate catalog identity`; pause for authorization. If authorized, stage exactly the Files
      list for this task plus the manifest, then commit.

## Task 6 — Add validation profiles and prepared-dish readiness

**Files**

- Create: `src/services/master-catalog/catalogValidation.service.ts`
- Create: `src/services/master-catalog/catalogRecipeCost.service.ts`
- Modify: `src/services/dashboard/recipe.service.ts`
- Create: `src/services/dashboard/recipe-cost-calculator.ts`
- Create: `tests/unit/services/master-catalog/catalogValidation.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogRecipeCost.service.test.ts`
- Create: `tests/integration/master-catalog/preparedDishReadiness.integration.test.ts`
- Modify: `tests/unit/services/dashboard/recipe-cost-conversion.test.ts`

- [ ] Encode the approved non-relaxable baseline as a versioned profile: full corporate identity, fiscal fields, explicit IEPS including
      NONE, organization sale/purchase values, currency, actor, date, and at least one business type. A profile may add requirements but
      cannot remove baseline fields.
- [ ] Write RED RETAIL_PRODUCT tests and PREPARED_DISH tests for no Recipe, invalid portion yield, missing `Recipe.prepTime`, empty/invalid
      lines, stale `Recipe.totalCost`, and complete recipe.
- [ ] Reuse the current authoritative recipe calculator in read-only mode. Compute only:

```text
costPerPortion = round(Recipe.totalCost / portionYield, 4, HALF_UP)
```

Capture Recipe.updatedAt and line hash as preview dependencies; never copy Recipe or mutate `PricingPolicy.calculatedCost`.

- [ ] Extract the pure calculation into neutral `src/services/dashboard/recipe-cost-calculator.ts`; both legacy recalculation and H1 preview
      call it, so the legacy domain never imports master-catalog code. Order line hashing by displayOrder/id, use Decimal ROUND_HALF_UP
      scale 4, and capture Recipe.updatedAt. H1 must not call the mutating `recalculateRecipeCost()` path.
- [ ] Prove OFF/ADVISORY only return validation findings and never change legacy Product writes. ENFORCED eligibility requires both
      organization mode and venue governance ENFORCED.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogValidation.service.test.ts \
  tests/unit/services/master-catalog/catalogRecipeCost.service.test.ts \
  tests/unit/services/dashboard/recipe-cost-conversion.test.ts
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/preparedDishReadiness.integration.test.ts
```

- [ ] Propose checkpoint `feat(h1a): validate catalog profiles and dish readiness`; pause for authorization. If authorized, stage exactly
      the Files list for this task plus the manifest, then commit.

## Task 7 — Stage and confirm the versioned master-catalog XLSX import

**Files**

- Create: `src/services/master-catalog/catalogImport.service.ts`
- Create: `src/services/master-catalog/catalogWorkbook.service.ts`
- Create: `src/schemas/dashboard/masterCatalogImport.schema.ts`
- Create: `tests/unit/services/master-catalog/catalogImport.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogWorkbook.service.test.ts`
- Create: `tests/api-tests/master-catalog/catalogImport.api.test.ts`
- Create: `tests/fixtures/master-catalog/catalog-master-v1-valid.xlsx`
- Create: `tests/fixtures/master-catalog/catalog-master-v1-errors.xlsx`

- [ ] Generate deterministic workbook fixtures in the test setup using `xlsx`; do not hand-edit binary fixtures during assertions. Cover
      `Metadata`, `Items`, `OrganizationValues`, `BusinessTypes`, `VenueBindings`, and `PreparedDishDetails` with the exact v1 columns.
- [ ] Validate MIME plus ZIP magic, upload bytes, entry count, uncompressed bytes, compression ratio, sheets, rows, columns, and cell length
      against explicit constants before parsing. Reject macros, formulas, external links, encrypted/invalid ZIP, and unknown sheets. The
      same workbook service owns safe text/Decimal/timestamp export and formula neutralization.
- [ ] Write RED preview tests for unknown schemaVersion, missing sheet/column, numeric code/SKU, formulas, duplicates, invalid
      enum/decimal/currency/URL, cross-tenant venue/Product, incomplete profile, and multiple errors in one row. Preview writes staging
      only.
- [ ] Return row-level errors with `source_sheet`, `source_row`, `column`, stable error code, safe/truncated rejected value, and actionable
      suggestion. Any error makes confirm unavailable.
- [ ] Bind preview to organization, actor, file SHA-256, parsed command hash, captured revisions, and expiration. Confirm requires the same
      active membership/access, preview token, `confirm: true`, and idempotency key.
- [ ] Write RED confirm tests for same-key/same-hash recovery, same-key/different-hash 409, expired/stale preview, two concurrent confirms,
      audit failure, and one invalid row. Every failure produces zero operational changes.
- [ ] Keep this route and labeling separate from `MenuImportDialog` and the current menu-replace service. Do not reuse a Product-by-name
      inference path.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogImport.service.test.ts \
  tests/unit/services/master-catalog/catalogWorkbook.service.test.ts
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/catalogImport.api.test.ts
```

- [ ] Propose checkpoint `feat(h1a): add atomic master catalog import`; pause for authorization. If authorized, stage exactly the Files list
      for this task plus the manifest, then commit.

## Task 8 — Preview and confirm explicit venue bindings

**Files**

- Create: `src/services/master-catalog/catalogBinding.service.ts`
- Create: `src/services/master-catalog/catalogOverride.service.ts`
- Create: `tests/unit/services/master-catalog/catalogBinding.service.test.ts`
- Create: `tests/integration/master-catalog/catalogBinding.integration.test.ts`
- Create: `tests/unit/services/master-catalog/catalogOverride.service.test.ts`

- [ ] Write RED preview tests for exact local SKU/GTIN candidates, no candidate, multiple candidates, cross-tenant target, Product already
      bound, CatalogItem already bound in venue, category/price/SKU required to create, and PREPARED_DISH recipe readiness.
- [ ] Return only `LINK`, `CREATE`, or `SKIP` proposals with current Product snapshot and explicit conflicts. No candidate is selected
      merely because names resemble each other.
- [ ] Confirm each line only after a human decision. `LINK` preserves Product ID/venue/category; `CREATE` creates a normal venue Product
      with explicit category/local SKU/initial scalar price; `SKIP` writes no binding.
- [ ] Store `lastPublishedCatalogRevision`, versioned managed snapshot, ordered field mask/hash, and diagnostic Product.updatedAt. Do not
      include stock, Recipe, modifiers, availability, category, or POS metadata in the managed hash.
- [ ] Add idempotency, stale dependency, concurrent binding, transaction-audit failure, and cross-tenant SQL tests. Confirming twice must
      not create a second Product or reparent the first.
- [ ] Add venue provenance/change reads and override-request preview/confirm through a shared service that requires active StaffVenue plus
      exact venue permission. The service cannot import, publish organization content, or expose another venue; MCP
      `request_catalog_override` calls this same service.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogBinding.service.test.ts \
  tests/unit/services/master-catalog/catalogOverride.service.test.ts
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogBinding.integration.test.ts
```

- [ ] Propose checkpoint `feat(h1a): add explicit venue catalog bindings`; pause for authorization. If authorized, stage exactly the Files
      list for this task plus the manifest, then commit.

## Task 9 — Build generic preview/publication and managed-field conflict handling

**Files**

- Create: `src/services/master-catalog/catalogPublication.service.ts`
- Create: `src/services/master-catalog/catalogGovernance.service.ts`
- Create: `tests/unit/services/master-catalog/catalogPublication.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogGovernance.service.test.ts`
- Create: `tests/integration/master-catalog/catalogPublication.integration.test.ts`
- Modify: `src/services/dashboard/product.dashboard.service.ts`
- Modify: `src/controllers/dashboard/product.dashboard.controller.ts`
- Modify: `src/services/dashboard/productWizard.service.ts`
- Modify: `src/controllers/dashboard/inventory/productWizard.controller.ts`
- Modify: `src/services/dashboard/menu.dashboard.service.ts`
- Modify: `src/controllers/mobile/product.mobile.controller.ts`
- Modify: `src/routes/tpv.routes.ts`
- Modify: `src/services/pos-sync/posSyncOrderItem.service.ts`
- Modify: `src/services/delivery-channels/core/deliveryOrderIngestion.service.ts`
- Modify: `src/services/onboarding/venueCreation.service.ts`
- Modify: `src/services/onboarding/demoSeed.service.ts`
- Create: `tests/unit/architecture/masterCatalogGovernedProductWriters.test.ts`
- Create: `src/services/master-catalog/catalogPublicationOutbox.service.ts`
- Create: `src/jobs/catalog-publication-outbox-sweeper.job.ts`
- Create: `src/jobs/catalog-publication-watchdog.job.ts`
- Modify: `src/jobs/jobSchedules.ts`
- Modify: `src/server.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationOutbox.service.test.ts`
- Create: `tests/unit/jobs/catalog-publication-outbox-sweeper.job.test.ts`
- Create: `tests/unit/jobs/catalog-publication-watchdog.job.test.ts`

- [ ] Write RED publication preview tests for name, description, imageUrl, Product.type, tax fields, objetoImp, unit, compatible retail
      cost, incompatible prepared-dish cost, unchanged fields, locally diverged managed field, unrelated local field changes, and Recipe
      dependency changes.
- [ ] A conflict line offers an explicit decision to preserve the local value as approved override or publish corporate value. It never
      overwrites drift by default. Store before/after, fieldMask, hashVersion, target hash, actor, and source revision.
- [ ] Implement PREVIEWED→APPLYING→APPLIED with idempotent confirmation and a transaction that relocks/reloads access, CatalogItem, binding,
      Product, relevant rule/profile, and Recipe dependencies before writing. Stale/conflict returns 409 with zero partial writes.
- [ ] Scope recovery by both `CatalogPublicationOperation` and idempotency key. Add RED/GREEN where the same key belongs to two operations;
      the static operation route must resolve the intended batch and reject unknown operations before the generic batch-id route.
- [ ] Materialize only confirmed H1A managed fields. Leave `Product.price` for H1C; organization purchase cost may update `Product.cost`
      only for compatible retail Products. Never change IDs, venue, category, active state, availability, inventory, recipe, modifiers, or
      POS metadata.
- [ ] Write one transactional ActivityLog summary plus immutable line details and co-committed outbox hints. Emit only after commit; stable
      eventId/venueSequence makes retry convergent.
- [ ] Implement the generic H1A outbox sweeper: PENDING lease/claim, external delivery outside the database transaction, bounded
      retry/backoff, DELIVERED/DEAD_LETTER, safe truncated error, stable `outbox.id` eventId, venueSequence, and dedupeKey. Socket/RabbitMQ
      failure never rolls back an APPLIED publication.
- [ ] Implement generic batch watchdog under the same batch advisory lock. It CAS-fails only an expired APPLYING attempt with the same
      attemptId/lease. A live commit and watchdog cannot produce FAILED-after-commit or commit-after-FAILED.
- [ ] Register start/stop/runNow/no-overlap job lifecycles without touching unrelated workers. Test emit-before-ack duplicate, worker race,
      venue ordering, dead letter, and crash recovery.
- [ ] Implement inverse publication as a new preview/batch using stored before values. Disabling a gate or entitlement is not a data
      rollback.
- [ ] Prove OFF/ADVISORY leave all legacy writers intact. Add the ENFORCED check only before a new or reactivated vendable Product for
      venues whose own governance state is ENFORCED; grandfathered Products remain usable.
- [ ] Transitioning venue governance to ENFORCED writes `Venue.catalogGovernanceEnforcedAt` and `CatalogVenueRollout.governanceState`
      atomically. Runtime writers read the nullable Venue scalar from the venue lookup they already perform; null executes the exact
      NEVER_ENABLED path without querying entitlement, OrganizationModule, rollout, or CatalogItem.
- [ ] Route create/activate through `assertLegacyCatalogGovernance()` for dashboard CRUD, ProductWizard, menu import, mobile CRUD, TPV
      quick-add, POS sync, and onboarding. Delivery placeholder creation remains allowed because it is `active:false`, but must preserve
      service actor attribution for any later activation. Demo/dev seeds operate only with the scalar null.
- [ ] Use `assertLegacyCatalogGovernance()` only for legacy create/activate. It reads only the Venue scalar and cannot accept fabricated
      catalog provenance. Catalog binding/publication CREATE uses a separate internal path that validates item, profile, binding, and
      publication in the same transaction.
- [ ] Thread authenticated `req.authContext.userId` through dashboard/mobile/TPV creators into nullable Product.createdById; onboarding
      passes its existing userId. POS sync, delivery, and demo use explicit SERVICE actors for ActivityLog and never invent a Staff ID.
- [ ] Add an architecture test that inventories these writers and fails if a new runtime Product create/activation bypasses the helper.
      Every 422 `CATALOG_GOVERNANCE_REQUIRED` happens before Product mutation and is non-retryable.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogPublication.service.test.ts \
  tests/unit/services/master-catalog/catalogGovernance.service.test.ts \
  tests/unit/architecture/masterCatalogGovernedProductWriters.test.ts \
  tests/unit/services/master-catalog/catalogPublicationOutbox.service.test.ts \
  tests/unit/jobs/catalog-publication-outbox-sweeper.job.test.ts \
  tests/unit/jobs/catalog-publication-watchdog.job.test.ts
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogPublication.integration.test.ts
```

- [ ] Propose checkpoint `feat(h1a): publish managed catalog fields atomically`; pause for authorization. If authorized, stage exactly the
      Files list for this task plus the manifest, then commit.

## Task 10 — Expose organization HTTP routes and customer MCP through shared services

**Files**

- Create: `src/controllers/dashboard/masterCatalog.dashboard.controller.ts`
- Create: `src/routes/dashboard/masterCatalog.routes.ts`
- Create: `src/routes/dashboard/masterCatalogVenue.routes.ts`
- Modify: `src/routes/dashboard.routes.ts`
- Create: `src/controllers/superadmin/masterCatalog.superadmin.controller.ts`
- Create: `src/routes/superadmin/masterCatalog.routes.ts`
- Modify: `src/routes/superadmin.routes.ts`
- Modify: `src/routes/superadmin/module.routes.ts`
- Modify: `src/mcp/scope.ts`
- Modify: `src/mcp/guard.ts`
- Create: `src/mcp/tools/masterCatalog.ts`
- Modify: `src/mcp/server.ts`
- Create: `tests/api-tests/master-catalog/masterCatalogCore.api.test.ts`
- Create: `tests/unit/mcp-customer/master-catalog-core.test.ts`

- [ ] Add thin controllers that parse Zod input, derive organization/actor from auth, call the shared services, and preserve
      `{success,data}` plus stable `{message,code,details}` errors. Controllers contain no Prisma calls.
- [ ] Mount organization routes under the exact surface in this plan and dedicated superadmin routes only under
      `/api/v1/superadmin/master-catalog`. Reject body/query attempts to change organization scope.
- [ ] Register `GET /publications/by-idempotency-key/:operation/:idempotencyKey` before `GET /publications/:publicationBatchId`; validate
      operation against the closed operation enum and test same key across two operations plus unknown-operation rejection.
- [ ] Mount the venue-scoped surface separately with the venue resolver and exact permission; do not add catalog provenance/overrides to
      legacy Product response shapes.
- [ ] Expose catalog audit through the hardened existing organization activity-log service at `/audit` and `/audit/actions`. Scope query as
      an `AND` containing `OR [{organizationId},{venueId in organization venues}]`; keep search in a separate `AND` group so it cannot
      overwrite tenant scope, support organizations with zero venues, and preserve `(createdAt desc, id desc)` pagination.
- [ ] Add `catalog-venue:read` and `catalog-venue:request-override` to server permission authority. These expose only local change/request
      views and never grant organization import/publish.
- [ ] Default venue-role grants are explicit: read for OWNER/ADMIN/MANAGER/VIEWER; request override for OWNER/ADMIN/MANAGER.
      VenueRolePermission custom overrides remain authoritative. Mirror these defaults exactly in dashboard and make
      `npm run audit:permissions` fail on drift.
- [ ] Extend `McpScope` with active organization and OrgRole. H1 write tools require `mcp:write` unconditionally even when the legacy
      environment enforcement flag is off.
- [ ] In H1 scope resolution recheck `Staff.active`, StaffOrganization `isActive=true` and `leftAt=null`, and StaffVenue `active=true`; add
      `orgRole` while retaining `activeOrg` for legacy tools. Preserve generic legacy guard behavior, but add `requireCatalogWriteScope()`
      that rejects missing scopes and arrays without `mcp:write` regardless of `MCP_ENFORCE_WRITE_SCOPE`.
- [ ] Register catalog tools only after resolving the active organization with the organization catalog resolver. Never use
      `anyVenueHasModule`, because MASTER_CATALOG is ORGANIZATION_ONLY. Superadmin has no implicit content access. Confirm calls the
      transactional shared service and must not append a second best-effort `auditMcpWrite()` after commit.
- [ ] Register the seven H1A MCP tools. Each call rechecks active membership, invokes the same access/preview/confirm/idempotency service as
      HTTP, and never duplicates audit logic.
- [ ] Write API/MCP RED then GREEN tests for all roles, revoked membership, impersonation, cross-tenant IDs, gate unknown/off,
      preview-confirm, idempotency, and no mutation without `mcp:write`.
- [ ] Run:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/masterCatalogCore.api.test.ts
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/mcp-customer/master-catalog-core.test.ts
npm run audit:permissions
npm run build
```

- [ ] Propose checkpoint `feat(h1a): expose guarded catalog API and MCP`; pause for authorization. If authorized, stage exactly the Files
      list for this task plus the manifest and commit that message.

## Task 11 — Produce contractual H1A exports and import-error workbooks

**Files**

- Create: `src/services/master-catalog/catalogExport.service.ts`
- Create: `tests/unit/services/master-catalog/catalogExport.service.test.ts`
- Create: `tests/api-tests/master-catalog/catalogExport.api.test.ts`

- [ ] Build one versioned XLSX writer that emits `Metadata` and typed sheets for `catalog-master-v1.xlsx`,
      `catalog-by-business-type-v1.xlsx`, and `import-errors-v1.xlsx` using the exact approved columns and grains.
- [ ] Write RED tests for text IDs/SKUs/codes with leading zero, Decimal(10,2), recipe cost scale 4, RFC3339 UTC, timezone metadata,
      null-as-empty, deterministic ordering, multiple business types, one-to-many data in separate sheets, and formula neutralization for
      `=`, `+`, `-`, and `@`.
- [ ] Join PREPARED_DISH exports to local Recipe through bindings and report status without copying or mutating Recipe. Include actor/date
      and profile version.
- [ ] Stream or buffer within a documented cap; reject a request above the cap with an actionable error rather than exhausting the event
      loop.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogExport.service.test.ts
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/catalogExport.api.test.ts
```

- [ ] Propose checkpoint `feat(h1a): add versioned catalog exports`; pause for authorization. If authorized, stage exactly the Files list
      for this task plus the manifest, then commit.

## Task 12 — Add fail-closed dashboard access and preserve legacy Product UX

**Files**

- Create: `avoqado-web-dashboard/src/features/master-catalog/types.ts`
- Create: `avoqado-web-dashboard/src/features/master-catalog/api.ts`
- Create: `avoqado-web-dashboard/src/features/master-catalog/use-master-catalog-access.ts`
- Create: `avoqado-web-dashboard/src/routes/MasterCatalogProtectedRoute.tsx`
- Modify: `avoqado-web-dashboard/src/routes/router.tsx`
- Modify: `avoqado-web-dashboard/src/routes/lazyComponents.ts`
- Modify: `avoqado-web-dashboard/src/pages/Organization/OrganizationLayout.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Organization/components/OrgSidebar.tsx`
- Modify: `avoqado-web-dashboard/src/hooks/use-current-organization.tsx`
- Modify: `avoqado-server/src/controllers/dashboard/auth.dashboard.controller.ts`
- Modify: `avoqado-web-dashboard/src/services/auth.service.ts`
- Modify: `avoqado-web-dashboard/src/context/AuthContext.tsx`
- Modify: `avoqado-web-dashboard/src/types.ts`
- Modify: `avoqado-web-dashboard/src/components/Sidebar/venues-switcher.tsx`
- Modify: `avoqado-web-dashboard/src/lib/permissions/defaultPermissions.ts`
- Modify: `avoqado-web-dashboard/src/services/menu.service.ts`
- Modify: `avoqado-web-dashboard/src/pages/Menu/Products/createProduct.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Menu/Products/Products.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Menu/Products/productId.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Inventory/components/ProductWizardDialog.tsx`
- Modify: `avoqado-web-dashboard/src/components/menu/MenuImportDialog.tsx`
- Create: `avoqado-web-dashboard/src/features/master-catalog/use-master-catalog-access.test.tsx`
- Create: `avoqado-web-dashboard/src/features/master-catalog/errors.test.ts`
- Create: `avoqado-web-dashboard/src/pages/Organization/__tests__/MasterCatalogNavigation.test.tsx`
- Create: `avoqado-web-dashboard/src/pages/Menu/Products/__tests__/legacyCatalogCompatibility.test.tsx`
- Create: `avoqado-server/tests/api-tests/dashboard/masterCatalogAccess.api.test.ts`
- Create: `avoqado-web-dashboard/src/context/__tests__/AuthContext.masterCatalogAccess.test.tsx`
- Create: `avoqado-web-dashboard/src/components/Sidebar/venues-switcher.masterCatalog.test.tsx`

- [ ] Write RED access/navigation tests: entitlement off/unknown/error emits no menu, no route content, and no catalog query;
      OWNER/ADMIN/VIEWER see permitted read surfaces; MEMBER and venue-only Staff fail closed. Do not broaden the existing
      OwnerProtectedRoute for unrelated organization pages.
- [ ] Add an optional `user.organizationMemberships` auth-status field containing only active, non-left memberships with organization
      ID/name, OrgRole, and `masterCatalogVisible`. The boolean is true only for explicit entitlement + active organization module + valid
      core config. Existing auth payload fields remain unchanged. When false/absent, the client issues no master-catalog access probe or
      content query; the `/master-catalog/access` endpoint revalidates on entry and on every mutation.
- [ ] Filter the auth-status membership query by both `isActive = true` and `leftAt = null`; the access endpoint and mutations still recheck
      these predicates rather than trusting cached auth context.
- [ ] Implement a catalog-specific organization guard so VIEWER can read H1 without gaining access to owner-only settings/team pages. Hide
      content mutations for VIEWER and rollout controls for all standard-dashboard users.
- [ ] Register the more-specific `/organizations/:orgId/master-catalog/*` sibling before the current OWNER-only `/organizations/:orgId/*`
      tree. Render `MasterCatalogLayout` directly from the fail-closed access endpoint; do not place it beneath `OwnerProtectedRoute` or the
      existing OWNER-only `OrganizationLayout` check.
- [ ] Mirror `catalog-venue:read` and `catalog-venue:request-override` exactly from server.
- [ ] Fix the two approved compatible legacy gaps with tests: createProduct sends the GTIN already captured by the form, and legacy product
      search includes SKU/GTIN. Aliases remain exclusive to the corporate view and add no join/query to legacy lists.
- [ ] Add `gtin?: string` to the exact CreateProductPayload, send its trimmed value, and extend only the existing client filter with
      normalized Product SKU/GTIN; do not add a master-catalog backend query to the legacy list.
- [ ] Translate `CODE_ALREADY_ASSIGNED` and `CATALOG_GOVERNANCE_REQUIRED` in create, edit, wizard, and legacy menu import. Show an
      actionable master-catalog link, never automatic retry, and per-row import errors. Preserve every other legacy error behavior.
- [ ] Centralize Axios/code parsing and non-retryable actionable copy in `src/features/master-catalog/errors.ts`; create/edit/wizard/menu
      import share it rather than implementing four subtly different mappings.
- [ ] Run focused GREEN plus compile:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard
npm run test:run -- \
  src/features/master-catalog/use-master-catalog-access.test.tsx \
  src/pages/Organization/__tests__/MasterCatalogNavigation.test.tsx \
  src/pages/Menu/Products/__tests__/legacyCatalogCompatibility.test.tsx
npm run build
```

- [ ] Propose checkpoint `feat(h1a): gate dashboard catalog access safely`; pause for authorization. If authorized, stage exactly the Files
      list for this task plus the manifest and commit that message.

## Task 13 — Build the organization master-catalog dashboard workflow

**Files**

- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogItemsPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogItemPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogImportPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogBindingsPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogPublicationsPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogAuditPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/CatalogItemForm.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/CatalogPreviewTable.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/CatalogValidationSummary.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/CatalogBindingDecisionTable.tsx`
- Create: `avoqado-web-dashboard/src/features/master-catalog/use-catalog-items.ts`
- Modify: `avoqado-web-dashboard/src/locales/es/organization.json`
- Modify: `avoqado-web-dashboard/src/locales/en/organization.json`
- Create: `avoqado-web-dashboard/src/locales/fr/organization.json`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/__tests__/CatalogItemsPage.test.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/__tests__/CatalogItemForm.test.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/__tests__/CatalogImportPage.test.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/__tests__/CatalogBindingsPage.test.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/__tests__/CatalogPublicationsPage.test.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/__tests__/CatalogAuditPage.test.tsx`
- Create: `avoqado-web-dashboard/e2e/tests/master-catalog/catalog-core.spec.ts`
- Create: `avoqado-web-dashboard/e2e/tests/master-catalog/catalog-import.spec.ts`
- Create: `avoqado-web-dashboard/e2e/tests/master-catalog/catalog-binding.spec.ts`
- Modify: `avoqado-web-dashboard/CHANGELOG.md`

- [ ] Before UI edits, read the dashboard design guide referenced by its repo instructions and use the applicable Impeccable design/review
      skills. Record material design decisions in the manifest.
- [ ] Write component tests first for paginated item table, item form, validation summary, workbook staging/errors download,
      link/create/skip decision table, publication before/after, conflicts, approved local override, explicit confirmation, stale response,
      and idempotency recovery.
- [ ] Build routes under `/organizations/:orgId/master-catalog/*` for products/dishes, imports, assignments, pending publications, and
      audit. H1B/H1C tabs may remain absent until their plans ship; do not render empty enabled-looking controls.
- [ ] Ensure the master import is visually and verbally distinct from legacy menu replacement. Disable confirmation while any row is invalid
      or stale and expose exactly one final action.
- [ ] Add Spanish/English/French keys with equivalent semantics, keyboard navigation, visible focus, accessible table descriptions, live
      validation summary, and downloadable error affordance.
- [ ] Register the new French `organization` namespace in `src/i18n.ts`; it does not exist in the current dashboard and must be loaded
      explicitly rather than silently falling back.
- [ ] Run component tests, Playwright with MSW/test backend, lint, and build:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard
npm run test:run -- src/pages/Organization/MasterCatalog
npx playwright test \
  e2e/tests/master-catalog/catalog-core.spec.ts \
  e2e/tests/master-catalog/catalog-import.spec.ts \
  e2e/tests/master-catalog/catalog-binding.spec.ts
npm run lint
npm run build
```

- [ ] Propose checkpoint `feat(h1a): add organization catalog workflow`; pause for authorization. If authorized, stage exactly the Files
      list for this task plus the manifest and commit that message.

## Task 14 — Add dedicated superadmin entitlement and rollout controls

**Files**

- Create: `avoqado-superadmin/src/features/master-catalog/types.ts`
- Create: `avoqado-superadmin/src/features/master-catalog/api.ts`
- Create: `avoqado-superadmin/src/features/master-catalog/use-master-catalog.ts`
- Create: `avoqado-superadmin/src/features/master-catalog/MasterCatalogAccessPage.tsx`
- Create: `avoqado-superadmin/src/features/master-catalog/MasterCatalogOrganizationDrawer.tsx`
- Create: `avoqado-superadmin/src/features/master-catalog/MasterCatalogRolloutTable.tsx`
- Create: `avoqado-superadmin/src/features/master-catalog/api.test.ts`
- Create: `avoqado-superadmin/src/features/master-catalog/MasterCatalogAccessPage.test.tsx`
- Create: `avoqado-superadmin/src/features/master-catalog/MasterCatalogRolloutTable.test.tsx`
- Modify: `avoqado-superadmin/src/app/router.tsx`
- Modify: `avoqado-superadmin/src/shared/layouts/AppLayout.tsx`
- Modify: `avoqado-superadmin/README.md`
- Modify: `avoqado-superadmin/CHANGELOG.md`

- [ ] Before UI edits, read `avoqado-superadmin/PRODUCT.md` and its component guidance; use existing `DataTable`, `Button`, `Combobox`,
      drawer, error, and query patterns.
- [ ] Write RED API/UI tests proving calls use only `/api/v1/superadmin/*`; entitlement, module, config, and per-venue governance changes
      require active superadmin; impersonation cannot mutate; unknown config fails closed; no control can edit catalog content or prices.
- [ ] Display entitlement source/status/dates, Module state, schema version, the three false-by-default gates, governance mode,
      rollout/readiness state, stale client observations, last actor/date, and failure reason. Every mutation shows a confirmation and
      server-returned before/after.
- [ ] Do not grant PITS automatically. An operator may explicitly create the grant only after the deploy/readiness checklist and user
      authorization outside this implementation task.
- [ ] Run:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-superadmin
PATH="/opt/homebrew/bin:$PATH" npm run test:run -- \
  src/features/master-catalog/api.test.ts \
  src/features/master-catalog/MasterCatalogAccessPage.test.tsx \
  src/features/master-catalog/MasterCatalogRolloutTable.test.tsx
PATH="/opt/homebrew/bin:$PATH" npm run check
PATH="/opt/homebrew/bin:$PATH" npm run build
```

- [ ] Propose checkpoint `feat(h1a): add superadmin catalog rollout controls`; pause for authorization. If authorized, stage exactly the
      Files list for this task plus the manifest and commit that message.

## Task 15 — Complete documentation, release evidence, and default-off verification

**Files**

- Modify: `avoqado-server/CHANGELOG.md`
- Modify: `avoqado-server/docs/PITS-H1-CHANGE-MANIFEST.md`
- Modify: `avoqado-server/docs/superpowers/specs/2026-08-08-pits-h1-master-catalog-design.md` only with verified implementation evidence
  that preserves approved decisions
- Modify: `avoqado-server/docs/superpowers/plans/2026-08-08-pits-h1a-catalog-core.md`
- Create: `avoqado-server/docs/PITS-H1A-ROLLOUT-RUNBOOK.md`
- Create: `avoqado-server/docs/api/master-catalog-h1a.md`
- Create: `avoqado-server/docs/mcp/master-catalog-h1a.md`
- Create: `avoqado-server/docs/xlsx/catalog-master-v1.md`
- Modify: `avoqado-server/docs/PITS-HANDOFF-SESION-2026-08-07.md`
- Modify: `avoqado-server/docs/PITS-HANDOFF.md`
- Create: `avoqado-server/docs/PITS-HANDOFF-SESION-2026-08-08.md`
- Modify: `avoqado-server/docs/PITS-INVENTARIO-MATRIZ.md`
- Modify: `avoqado-server/docs/PITS-PROGRAMA-COMPLETO.md`
- Modify: `avoqado-server/docs/DEMO-PITS-2026-08-BITACORA.md`
- Modify: `avoqado-server/docs/README.md`
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

- [ ] Document exact contracts, workbook columns, OrgRole matrix, entitlement/module separation, preview-confirm/idempotency, ENFORCED
      gates, inverse publication, operational metrics, alerts, rollback-by-disable, and the pending PITS acceptance blockers.
- [ ] Update customer-facing material only with claims demonstrable by the acceptance scenarios; label regional identifiers/pricing as
      unavailable until H1B/H1C ship. Regenerate canonical PDFs from source with the folder README's Chrome command
      (`--no-pdf-header-footer` and `--virtual-time-budget=15000`), then verify page count/text extraction and rasterize every changed page
      for visual QC. Refork the PAX/Blumon variant from V2 without reintroducing NexGo or any non-Blumon processor. Record the
      owner/link/evidence for the required clickable web deck, which is not a Git artifact in this workspace.
- [ ] Run the capacity check from workspace instructions. Even under load, run all mandatory module tests; serialize heavy builds and report
      longer duration rather than omitting verification.
- [ ] Execute the exact server unit/API/integration matrix and final gates in the `Exact final verification commands` section below with an
      explicitly supplied disposable `H1_TEST_DATABASE_URL`; do not collapse it into an unscoped Jest invocation.

- [ ] Execute dashboard and superadmin full targeted gates after confirming no other heavy build from this task is running. Compare all
      three legacy Product fixtures byte-for-byte.
- [ ] On an isolated local database, prove: migration creates no catalog/grant rows; all gates are false; a non-PITS organization performs
      current Product/menu/inventory/recipe/order flows without H1 queries; PITS can run off-gated preview only after explicit test grant;
      disabling the test grant stops H1 mutation but leaves Product operational.
- [ ] Do not assume server `develop` reaches staging: current Render staging deployment is suspended and Fly auto-deploy is disabled, while
      dashboard `develop` can still auto-deploy to demo. The runbook assigns an owner to reactivate/use an isolated manual backend
      environment, verifies it healthy with expand-only migration and gates OFF, and only then allows dashboard deployment. The first H1
      canary is never direct production.
- [ ] Review every row 43/44/248 and enablers 46/191 against the observable acceptance table. Mark software-ready separately from
      contractual acceptance blocked by PITS layouts/field matrix.
- [ ] Propose checkpoint `docs(h1a): document catalog core rollout`; pause for authorization. If authorized, stage exactly the Files list
      for this task plus the manifest and commit that message.

## Exact final verification commands

Set `H1_TEST_DATABASE_URL` explicitly to a disposable H1 database. Integration setup must reject an empty value or production fallback; no
credential is stored in this document.

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server

npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/contracts/masterCatalogLegacyProduct.contract.test.ts \
  tests/unit/services/master-catalog/masterCatalogAccess.service.test.ts \
  tests/unit/services/master-catalog/catalogAuthorization.service.test.ts \
  tests/unit/services/master-catalog/catalogAudit.service.test.ts \
  tests/unit/services/master-catalog/catalogMoney.service.test.ts \
  tests/unit/services/master-catalog/catalogHash.service.test.ts \
  tests/unit/services/master-catalog/identifierNormalization.service.test.ts \
  tests/unit/services/master-catalog/catalogItem.service.test.ts \
  tests/unit/services/master-catalog/catalogValidation.service.test.ts \
  tests/unit/services/master-catalog/catalogRecipeCost.service.test.ts \
  tests/unit/services/dashboard/recipe-cost-conversion.test.ts \
  tests/unit/services/master-catalog/catalogWorkbook.service.test.ts \
  tests/unit/services/master-catalog/catalogImport.service.test.ts \
  tests/unit/services/master-catalog/catalogBinding.service.test.ts \
  tests/unit/services/master-catalog/catalogOverride.service.test.ts \
  tests/unit/services/master-catalog/catalogPublication.service.test.ts \
  tests/unit/services/master-catalog/catalogGovernance.service.test.ts \
  tests/unit/services/master-catalog/catalogPublicationOutbox.service.test.ts \
  tests/unit/jobs/catalog-publication-outbox-sweeper.job.test.ts \
  tests/unit/jobs/catalog-publication-watchdog.job.test.ts \
  tests/unit/services/master-catalog/catalogExport.service.test.ts \
  tests/unit/mcp-customer/master-catalog-core.test.ts \
  tests/unit/architecture/masterCatalogGovernedProductWriters.test.ts \
  tests/unit/services/module-bulk.test.ts \
  tests/unit/scripts/masterCatalogModuleSeed.test.ts

npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/dashboard/masterCatalogAccess.api.test.ts \
  tests/api-tests/master-catalog/masterCatalogAuthorization.api.test.ts \
  tests/api-tests/master-catalog/catalogImport.api.test.ts \
  tests/api-tests/master-catalog/masterCatalogCore.api.test.ts \
  tests/api-tests/master-catalog/catalogExport.api.test.ts

test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/h1a-migration.integration.test.ts \
  tests/integration/master-catalog/h1a-tenant-constraints.integration.test.ts \
  tests/integration/master-catalog/h1a-corporate-sku-trigger.integration.test.ts \
  tests/integration/master-catalog/preparedDishReadiness.integration.test.ts \
  tests/integration/master-catalog/catalogBinding.integration.test.ts \
  tests/integration/master-catalog/catalogPublication.integration.test.ts

npx prisma validate
npx prisma generate
npm run schema:map
npm run schema:map -- --check
npm run audit:permissions
npm run typecheck
npm run build
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" npm run pre-deploy
```

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard
npm run test:run -- \
  src/features/master-catalog \
  src/context/__tests__/AuthContext.masterCatalogAccess.test.tsx \
  src/components/Sidebar/venues-switcher.masterCatalog.test.tsx \
  src/pages/Organization/MasterCatalog \
  src/pages/Organization/__tests__/MasterCatalogNavigation.test.tsx \
  src/pages/Menu/Products/__tests__/legacyCatalogCompatibility.test.tsx
npm run lint:i18n
npm run lint
npm run build
npm run test:e2e -- \
  e2e/tests/master-catalog/catalog-core.spec.ts \
  e2e/tests/master-catalog/catalog-import.spec.ts \
  e2e/tests/master-catalog/catalog-binding.spec.ts
npm run pre-deploy -- --skip-e2e
```

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-superadmin
PATH="/opt/homebrew/bin:$PATH" npm run test:run -- \
  src/features/master-catalog/api.test.ts \
  src/features/master-catalog/MasterCatalogAccessPage.test.tsx \
  src/features/master-catalog/MasterCatalogRolloutTable.test.tsx
PATH="/opt/homebrew/bin:$PATH" npm run check
PATH="/opt/homebrew/bin:$PATH" npm run build
```

## H1A completion gate

H1A is technically complete only when all focused and module suites are GREEN, schema-map and contract fixtures are current, every change
appears in the manifest, catalog administration is invisible and query-free without explicit access, migration/seed granted nobody, and a
complete catalog→binding→preview→confirm→inverse-publication scenario succeeds in the isolated environment without changing Product identity
or local operational relationships.

H1A is not commercially accepted until PITS's field matrix and real workbook layouts are archived, the profile version is updated through an
explicit reviewed change, and ENFORCED is approved as a separate operational action.
