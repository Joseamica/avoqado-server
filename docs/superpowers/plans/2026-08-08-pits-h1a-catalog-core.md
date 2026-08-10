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
- `src/services/master-catalog/catalogProductType.service.ts`
- `src/services/master-catalog/catalogItem.service.ts`
- `src/services/master-catalog/catalogValidation.service.ts`
- `src/services/master-catalog/catalogRecipeCost.service.ts`
- `src/services/master-catalog/catalogImport.service.ts`
- `src/services/master-catalog/catalogWorkbook.service.ts`
- `src/workers/masterCatalogXlsx.worker.ts`
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
- `src/schemas/dashboard/masterCatalog.schema.ts`
- `src/routes/dashboard/masterCatalog.routes.ts`
- `src/routes/dashboard/masterCatalogVenue.routes.ts`
- `src/controllers/superadmin/masterCatalog.superadmin.controller.ts`
- `src/routes/superadmin/masterCatalog.routes.ts`
- `src/mcp/tools/masterCatalog.ts`
- the exact 48 phased migration directories listed in Task 2, from `prisma/migrations/20260808120000_add_h1a_catalog_types/` through
  `prisma/migrations/20260808121800_validate_activity_log_actor_check/`
- `scripts/generate-master-catalog-import-fixtures.ts`

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
- `src/controllers/dashboard/menu.dashboard.controller.ts`
- `src/services/dashboard/productWizard.service.ts`
- `src/controllers/dashboard/inventory/productWizard.controller.ts`
- `src/services/dashboard/menu.dashboard.service.ts`
- `src/mcp/tools/menu.ts`
- `src/services/dashboard/chatbot-actions/definitions/product-crud.actions.ts`
- `src/services/dashboard/text-to-sql-assistant.service.ts`
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
GET    /templates/catalog-master-import-v1.xlsx
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
  reasonCode:
    | 'ACCESSIBLE'
    | 'ENTITLEMENT_MISSING'
    | 'ENTITLEMENT_INACTIVE'
    | 'MODULE_MISSING'
    | 'MODULE_INACTIVE'
    | 'CONFIG_MISSING'
    | 'CONFIG_INVALID'
    | 'GATE_DISABLED'
    | 'ROLE_DENIED'
    | 'DEPENDENCY_UNAVAILABLE'
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

export type CatalogPublicationOperation = 'CATALOG_FIELDS_PUBLISH' | 'CATALOG_FIELDS_REVERSION' | 'CATALOG_PRODUCT_ACTIVATION'

export interface CatalogAuditInput {
  organizationId: string
  venueId?: string | null
  actor: CatalogActor
  action: string
  entity: string
  entityId?: string | null
  batchId?: string | null
  idempotencyKeyHash?: string | null
  reason?: string | null
  before?: Prisma.InputJsonValue
  after?: Prisma.InputJsonValue
  metadata?: Prisma.InputJsonValue
  ipAddress?: string | null
  userAgent?: string | null
}

export interface CatalogConfirmInput {
  previewToken: string
  confirm: true
  idempotencyKey: string
}

export interface CatalogWorkbookUpload {
  buffer: Buffer
  mimeType: string
  originalFilename: string
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

export async function previewCatalogImport(context: CatalogCommandContext, upload: CatalogWorkbookUpload): Promise<CatalogImportPreview>

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

export async function writeCatalogAudit(tx: Prisma.TransactionClient, input: CatalogAuditInput): Promise<void>

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
npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
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

**Status:** accepted scoped after round-1 verification and two independent reviews; quarantine lifted. Rollout remains default-off and
production deployment is a separate gate.

**Files**

- Modify: `prisma/schema.prisma`
- Delete: `prisma/migrations/20260808120000_add_master_catalog_core/migration.sql` (rejected round-0 WIP; never deployed)
- Create: `prisma/migrations/20260808120000_add_h1a_catalog_types/migration.sql`
- Create: `prisma/migrations/20260808120100_add_h1a_activity_log_columns/migration.sql`
- Create: `prisma/migrations/20260808120200_add_h1a_module_scope/migration.sql`
- Create: `prisma/migrations/20260808120300_add_h1a_product_creator/migration.sql`
- Create: `prisma/migrations/20260808120400_add_h1a_venue_governance_fence/migration.sql`
- Create: `prisma/migrations/20260808120500_index_activity_log_organization_concurrently/migration.sql`
- Create: `prisma/migrations/20260808120600_index_activity_log_actor_type_concurrently/migration.sql`
- Create: `prisma/migrations/20260808120700_index_activity_log_service_principal_concurrently/migration.sql`
- Create: `prisma/migrations/20260808120750_index_activity_log_actor_staff_concurrently/migration.sql`
- Create: `prisma/migrations/20260808120800_index_product_creator_concurrently/migration.sql`
- Create: `prisma/migrations/20260808120900_index_product_venue_key_concurrently/migration.sql`
- Create: `prisma/migrations/20260808121000_index_venue_organization_key_concurrently/migration.sql`
- Create: `prisma/migrations/20260808121100_add_h1a_master_catalog_core/migration.sql`
- Create: `prisma/migrations/20260808121101_add_organization_entitlement_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121102_add_catalog_brand_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121103_add_catalog_manufacturer_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121104_add_catalog_family_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121105_add_catalog_item_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121106_add_catalog_item_business_type_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121107_add_catalog_product_type_mapping_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121108_add_catalog_identifier_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121109_add_catalog_validation_profile_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121110_add_catalog_item_price_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121111_add_catalog_venue_rollout_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121112_add_catalog_venue_client_requirement_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121113_add_catalog_client_observation_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121114_add_catalog_client_readiness_override_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121115_add_catalog_venue_binding_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121116_add_catalog_venue_override_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121117_add_catalog_idempotency_record_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121118_add_catalog_import_batch_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121119_add_catalog_import_line_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121120_add_catalog_binding_batch_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121121_add_catalog_binding_line_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121122_add_catalog_publication_batch_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121123_add_catalog_publication_line_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121124_add_catalog_publication_field_decision_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121125_add_catalog_venue_event_sequence_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121126_add_catalog_publication_outbox_hot_parent_fks_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121150_validate_h1a_hot_parent_fks/migration.sql`
- Create: `prisma/migrations/20260808121200_add_product_creator_fk_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121300_add_activity_log_constraints_not_valid/migration.sql`
- Create: `prisma/migrations/20260808121400_add_activity_log_tenant_guard/migration.sql`
- Create: `prisma/migrations/20260808121500_add_venue_governance_write_once_trigger/migration.sql`
- Create: `prisma/migrations/20260808121600_validate_product_creator_fk/migration.sql`
- Create: `prisma/migrations/20260808121700_validate_activity_log_organization_fk/migration.sql`
- Create: `prisma/migrations/20260808121750_validate_activity_log_actor_staff_fk/migration.sql`
- Create: `prisma/migrations/20260808121800_validate_activity_log_actor_check/migration.sql`
- Create: `tests/integration/master-catalog/h1a-migration-harness.cjs`
- Create: `tests/fixtures/master-catalog/h1a-legacy-graph.sql`
- Create: `tests/integration/master-catalog/h1a-migration-replay.integration.test.ts`
- Create: `tests/integration/master-catalog/h1a-migration-lock-safety.integration.test.ts`
- Create: `tests/integration/master-catalog/h1a-migration.integration.test.ts`
- Create: `tests/integration/master-catalog/h1a-tenant-constraints.integration.test.ts`
- Create: `tests/integration/master-catalog/h1a-corporate-sku-trigger.integration.test.ts`
- Create: `tests/integration/master-catalog/h1a-concurrency.integration.test.ts`
- Create: `tests/integration/master-catalog/h1a-delete-and-lifecycle.integration.test.ts`
- Create: `tests/unit/architecture/h1aMigrationLockSafety.test.ts`
- Modify: `src/utils/prismaClient.ts`
- Create: `src/utils/legacyProductPayload.ts`
- Modify: `src/controllers/dashboard/product.dashboard.controller.ts`
- Modify: `src/controllers/dashboard/venue.dashboard.controller.ts`
- Modify: `src/controllers/mobile/product.mobile.controller.ts`
- Modify: `src/controllers/tpv/venue.tpv.controller.ts`
- Modify: `src/routes/tpv.routes.ts`
- Modify: `src/services/dashboard/table-access-control.service.ts`
- Modify: `src/services/dashboard/sql-ast-parser.service.ts`
- Modify: `src/services/dashboard/text-to-sql-assistant.service.ts`
- Modify: `src/services/dashboard/chatbot-actions/entity-resolver.service.ts`
- Modify: `tests/unit/contracts/masterCatalogLegacyProduct.contract.test.ts`
- Create: `tests/unit/contracts/masterCatalogLegacyVenue.contract.test.ts`
- Create: `tests/unit/contracts/h1aLegacyInternalFieldBoundary.contract.test.ts`
- Modify: `tests/unit/services/dashboard/sql-ast-parser-security.test.ts`
- Modify: `tests/unit/services/dashboard/text-to-sql-assistant.security.test.ts`
- Modify: `tests/unit/services/dashboard/chatbot-actions/entity-resolver.test.ts`
- Modify: `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs`
- Modify: `scripts/generate-schema-map.ts`
- Modify/generated: `docs/SCHEMA_MAP.md`
- Modify: `docs/PITS-H1-CHANGE-MANIFEST.md`
- Modify: `docs/superpowers/plans/2026-08-08-pits-h1a-catalog-core.md`
- Modify: `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/task-2-brief.md`
- Modify: `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/task-2-findings-round-1.md`
- Modify: `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/task-2-report.md`
- Modify: `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/progress.md`

- [ ] Write RED migration tests against a disposable PostgreSQL database containing legacy Products tied to orders, inventories, recipes,
      modifiers, categories, and pricing policies. Prove migration preserves IDs/counts/relationships and creates zero grants, catalog rows,
      bindings, or publications.
- [ ] Write RED SQL-direct tenant tests for every composite boundary: CatalogItem↔organization, binding↔organization/venue/Product,
      CatalogIdentifier↔CatalogItem, organization price rule↔CatalogItem, import/publication line↔batch, and ActivityLog actor
      combinations.
- [ ] Write RED deferred-trigger tests proving commit rejects a CatalogItem without exactly one CORPORATE_SKU projection, a normalized
      projection that differs from `CatalogItem.sku`, and a projection whose ACTIVE/RETIRED state diverges.
- [ ] Prove a real legacy-to-H1 edge, not a post-migration seed: the dedicated replay test resets only the asserted H1 test database,
      deploys every pre-H1 migration, loads the frozen legacy SQL graph, snapshots it, applies the exact H1A chain through Prisma 6.19.3,
      and compares IDs/counts/relationships/default-off counts afterwards. Run this test in its own Jest invocation before the remaining
      integration files so no open Prisma client spans the schema reset.
- [ ] Harden the disposable-DB wrapper before any reset/deploy: force `USE_RENDER_DB=false`, remove inherited `RENDER_DATABASE_URL`, and
      make the harness independently reject any effective URL whose host is not local or whose pathname is not exactly
      `/avoqado_h1a_test_20260808`. The frozen pre-H1 cutoff is `20260808010000_add_cash_reconciliation_opt_in`; reject the obsolete
      monolith or a duplicate H1 timestamp before invoking Prisma.
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
- [ ] Add `Module.scope` with default `BOTH`, `Product.createdById` nullable, `Venue.catalogGovernanceEnforcedAt` nullable/write-once,
      `ActivityLog.organizationId`, conditional `actorType`, durable `actorStaffId`, `servicePrincipalId`, and the organization composite
      keys required by the spec. Existing ActivityLog writers with null actor classification must remain valid. HUMAN writes populate equal
      `staffId`/`actorStaffId`; SERVICE uses neither; classified actor/organization identity is immutable.
- [ ] Split every legacy-table change from the new-table core. Each nullable/default column alteration is a short explicit transaction with
      `SET LOCAL lock_timeout='5s'`; each legacy `CREATE INDEX CONCURRENTLY` is the only executable statement in its migration file; legacy
      FK/CHECK constraints are added `NOT VALID` and validated later. Partial indexes cover nullable actor/scope columns. Never use
      `IF NOT EXISTS` for a concurrent index: an invalid remnant must be detected and removed explicitly before retry.
- [ ] Keep the exact 48-phase H1A chain auditable. The 26 migrations `20260808121101`–`20260808121126` each install all hot-parent FKs for
      one new child table as `NOT VALID` inside one bounded transaction; `20260808121150` validates the resulting 68 constraints with a
      bounded lock wait and ten-minute statement timeout. The core migration contains no FK reference to legacy Organization, Staff, Venue,
      or Product.
- [ ] Keep the seven concurrent-index migration files byte-auditable: each has exactly one executable `CREATE [UNIQUE] INDEX CONCURRENTLY`
      statement and no `SET`, `BEGIN`, `COMMIT`, `DO`, or `IF NOT EXISTS`. Recovery inspects `pg_index.indisvalid/indisready`, drops only
      the invalid index with a standalone `DROP INDEX CONCURRENTLY`, runs `prisma migrate resolve --rolled-back <migration>`, then
      redeploys. If the exact index is already valid/ready, recovery may resolve that migration as applied; it never marks an invalid build
      as applied.
- [ ] Recover a `55P03` in any bounded FK/trigger phase differently from a failed concurrent index: verify PostgreSQL rolled back the
      transaction and created no partial constraint/trigger set, run `prisma migrate resolve --rolled-back <exact_phase>`, then retry in a
      deployment window. Do not inspect/drop `pg_index` unless the failed phase is one of the seven standalone concurrent-index migrations.
- [ ] Make Product.createdById `ON DELETE SET NULL`. Product references from binding/batch/publication use composite
      `(productId,venueId) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`: an individual Product with provenance remains protected,
      while deleting a whole Venue can cascade its venue-scoped H1 rows and Products in one transaction without ordering-dependent P2003.
      Venue references on those rows/outbox use CASCADE; CatalogItem/history ownership remains RESTRICT where specified. Add supporting
      unique `(Product.id,venueId)` and `(Venue.id,organizationId)` keys with an index/lock-safe migration sequence and direct SQL tests for
      “Product delete blocked, Venue delete succeeds”.
- [ ] Keep `Product.createdById` and `Venue.catalogGovernanceEnforcedAt` server-only until their owning H1 writers activate. Prisma omits
      them by default, explicit internal selects may opt in, legacy Product/Venue response boundaries remove them defensively, and raw
      Text-to-SQL/entity-resolution paths deny or strip them. Tests cover direct, aliased, wrapped, wildcard, composite-row, clause,
      correlated, root/nested UNION, CTE, derived-table and nested relation reads without changing legacy envelopes.
- [ ] In SQL, add partial unique indexes and deferred constraint triggers that Prisma cannot express. Do not backfill legacy Product or
      invent actors. Direct catalog tests query `pg_index`, `pg_get_indexdef` and `pg_get_expr` against an exact allowlist of names,
      columns, uniqueness and predicates; also prove Prisma did not create full-index substitutes. Keep the new-table outbox dequeue index
      as the conventional `(status,nextAttemptAt,venueId,venueSequence)` contract consumed by Task 9. Add a migration header explaining
      expand-only safety and irreversible production policy.
- [ ] Add a second deferred baseline trigger for the new aggregate: every CatalogItem that still exists at commit has at least one
      CatalogItemBusinessType and at least one active ORGANIZATION SALE_PRICE/PURCHASE_COST pair in the same currency. Fire it from item,
      business-type, and price changes; deleting the final requirement must fail, while deleting the parent organization/item ignores the
      now-absent parent. This affects only new H1 tables, never legacy Product.
- [ ] Serialize both deferred aggregate checks by locking the surviving CatalogItem before reading its children. Include organizationId in
      the price lookup and an index with catalogItemId as the leading key where required. Add real two-connection tests for business-type,
      price-pair and CORPORATE_SKU write skew plus a representative bulk/index-plan check. Freeze one protocol: internal
      `CatalogItem.invariantVersion BigInt @default(0)` and immediate child-table triggers bump the affected item rows in stable ID order
      before deferred validation. READ COMMITTED writers re-evaluate after waiting; REPEATABLE READ writers must serialize or abort, never
      commit an invalid aggregate. Do not add an unmodelled/temp invariant queue.
- [ ] Link every override request to its tenant-safe CatalogIdempotencyRecord requestBatchId. Add partial unique indexes for one REQUESTED
      and one APPROVED row per binding/field, lifecycle/maker-checker CHECKs, and concurrent SQL-direct tests. The FK/trigger also proves
      operation `CATALOG_OVERRIDE_REQUEST`; JSONB localValue is NOT NULL so JSON `null` remains a captured value. Freeze approval order as
      lock binding/field → supersede old APPROVED → approve the REQUESTED replacement. Do not persist NOT_STARTED. DETECTED has no
      requester/batch; REQUESTED and terminal decisions retain them. SUPERSEDED adds `supersededByOverrideId`/`supersededAt`, with a
      tenant+binding+field deferrable self-FK and commit-time proof that its replacement is APPROVED.
- [ ] Add normalized CatalogPublicationFieldDecision rows for per-field before/proposed/after and override provenance. PublicationLine owns
      decisionSchemaVersion/changeKind plus tenant-safe, deferrable supersedes/reverses self-references; test mixed decisions and Venue
      cascade through history chains. Decision/line carries binding identity and any override FK covers organization+binding+field.
      `PUBLISH_CORPORATE` requires `after=proposed` with no override; `APPROVE_LOCAL_OVERRIDE` requires matching override and
      `after=before`; UNDECIDED is non-terminal. APPLIED requires decision fields to equal fieldMask exactly. Binding→override/history
      references use `NO ACTION DEFERRABLE`: an individual unlink cannot erase audit, while the Venue cascade deletes the full graph.
      Successor/reversal uniqueness applies to APPLIED lines through raw partial indexes so an abandoned preview never blocks a retry. A
      REVERSION line stores both non-null `supersedesLineId` (the current line it replaces) and `reversesLineId` (the historical state it
      restores); both targets must be APPLIED, both APPLIED partial-unique slots are occupied, and reachability uses deduplicated `UNION`
      across both edges so cycles fail without exponential path enumeration.
- [ ] Freeze request/target/preview/canonical hashes as lowercase 64-hex SHA-256 and add state-shape CHECKs: APPLYING owns the complete
      lease tuple; no other state may retain it; APPLIED and FAILED require their respective completion/result/failure evidence.
- [ ] Preserve Staff hard-delete only for rows with no H1 provenance. SQL-direct tests prove LEGACY_UNCLASSIFIED ActivityLog still SET NULLs
      on delete and classified H1 actors remain durable through `actorStaffId ON DELETE RESTRICT`; Task 10 owns the conditional
      deactivate/revoke/anonymize application flow before any H1 content endpoint is exposed.
- [ ] Extend `MODEL_TO_DOMAIN` in `scripts/generate-schema-map.ts`, then run:
- [ ] Add a `Master Catalog & Publication` domain for every Catalog aggregate, batch, line, outbox, rollout, validation, binding, and value
      model. Map OrganizationEntitlement to `Modules, Features & Billing`; keep Product, Venue, Module, and ActivityLog in existing domains.
- [ ] Prevent PostgreSQL's silent 63-byte identifier truncation: the architecture test scans every double-quoted identifier in all 48 H1A
      migration files plus every Prisma `map:` using UTF-8 byte length and reports the exact path, line, name and byte count. Runtime tests
      still inspect the installed `pg_trigger` definitions rather than trusting source alone.

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx prisma validate
npx prisma generate
npm run schema:map
node .superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs \
  ./node_modules/.bin/jest --selectProjects=integration --runInBand --watchman=false --testTimeout=600000 --runTestsByPath \
  tests/integration/master-catalog/h1a-migration-replay.integration.test.ts
node .superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs \
  ./node_modules/.bin/jest --selectProjects=integration --runInBand --watchman=false --testTimeout=600000 --runTestsByPath \
  tests/integration/master-catalog/h1a-migration-lock-safety.integration.test.ts
node .superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs \
  ./node_modules/.bin/jest --selectProjects=integration --runInBand --watchman=false --testTimeout=600000 --runTestsByPath \
  tests/integration/master-catalog/h1a-migration.integration.test.ts \
  tests/integration/master-catalog/h1a-tenant-constraints.integration.test.ts \
  tests/integration/master-catalog/h1a-corporate-sku-trigger.integration.test.ts \
  tests/integration/master-catalog/h1a-concurrency.integration.test.ts \
  tests/integration/master-catalog/h1a-delete-and-lifecycle.integration.test.ts
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/architecture/h1aMigrationLockSafety.test.ts
node .superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs \
  ./node_modules/.bin/prisma migrate diff --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script --exit-code
npm run schema:map -- --check
npm run typecheck
npm run build
npx prettier --check prisma/schema.prisma tests/integration/master-catalog \
  tests/unit/architecture/h1aMigrationLockSafety.test.ts scripts/generate-schema-map.ts \
  docs/SCHEMA_MAP.md docs/PITS-H1-CHANGE-MANIFEST.md
git diff --check -- prisma/schema.prisma scripts/generate-schema-map.ts docs/SCHEMA_MAP.md \
  docs/PITS-H1-CHANGE-MANIFEST.md docs/superpowers/plans/2026-08-08-pits-h1a-catalog-core.md
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
- Modify: `src/routes/superadmin/module.routes.ts`
- Create: `src/services/master-catalog/masterCatalogAccess.service.ts`
- Create: `src/types/master-catalog.ts`
- Create: `tests/unit/services/master-catalog/masterCatalogAccess.service.test.ts`
- Modify: `tests/unit/services/module-bulk.test.ts`
- Create: `tests/unit/scripts/masterCatalogModuleSeed.test.ts`
- Create: `tests/unit/routes/superadminModuleScope.routes.test.ts`

- [ ] Write RED access tests covering ACTIVE/REVOKED/not-yet-started/expired entitlement; active, inactive, and missing OrganizationModule;
      config schemaVersion 1, missing config, unknown version, malformed JSON, and data-access failure;
      PREMIUM/demo/grandfathered/VenueFeature/VenueModule must never grant access.
- [ ] Freeze time/gate boundaries: an entitlement is current only when `startsAt <= now` and `endsAt IS NULL OR endsAt > now` (the exact
      `endsAt` instant is expired). `CORE` requires `catalogCoreEnabled`; `IDENTIFIERS` requires both core and identifiers; and
      `REGIONAL_PRICING` requires both core and regional pricing. No dependent gate can operate while core is false.
- [ ] Write RED module tests proving existing modules default to `BOTH`, MASTER_CATALOG is `ORGANIZATION_ONLY`, and generic VenueModule
      mutation rejects that module code without changing existing module behavior.
- [ ] Cover every venue-module method, not only enable: `isModuleEnabled`, `venuesWithModule`, `getModuleConfig`, `getEnabledModules`,
      `getEnabledModuleCodes`, `enableModule`, `disableModule`, and `updateModuleConfig` exclude/reject ORGANIZATION_ONLY. Organization
      methods `enableModuleForOrganization`, `disableModuleForOrganization`, `updateOrganizationModuleConfig`, `getOrganizationModules`, and
      `isModuleEnabledForOrganization` similarly exclude/reject VENUE_ONLY. `anyVenueHasModule` must remain safe through its
      `venuesWithModule` delegation. This prevents MASTER_CATALOG leaking into TPV login module payloads.
- [ ] Extend dedicated module create/update/read validation and responses with `scope`; preserve default `BOTH` for all existing callers.
- [ ] Make scope transitions safe and transactional. A transition to `ORGANIZATION_ONLY` is rejected while any VenueModule row exists; a
      transition to `VENUE_ONLY` is rejected while any OrganizationModule row exists. Count disabled rows too so a dormant assignment cannot
      silently disappear or later resurrect. Transitions back to `BOTH` are additive. MASTER_CATALOG setup never rewrites the scope of an
      existing conflicting definition; it reports the conflict for explicit superadmin resolution.
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
- [ ] Implement `resolveMasterCatalogAccess()` so new mutations fail closed, reads report the frozen `reasonCode`, and already-published
      operational projections are not coupled to entitlement. A database/connectivity failure is `DEPENDENCY_UNAVAILABLE` and maps to 503,
      never to a misleading authorization denial.
- [ ] Treat `CONFIGURE_CONTROL_PLANE` as the dedicated superadmin bootstrap capability: it revalidates an active SUPERADMIN principal but
      reports the current entitlement/module/config state without requiring those resources to exist or be active. Content and service-job
      capabilities continue to require the explicit entitlement, active OrganizationModule, valid config, and requested gate.
- [ ] Run GREEN and module regressions:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/masterCatalogAccess.service.test.ts \
  tests/unit/services/module-bulk.test.ts \
  tests/unit/scripts/masterCatalogModuleSeed.test.ts \
  tests/unit/routes/superadminModuleScope.routes.test.ts
npm run typecheck
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
- Modify: `tests/unit/services/dashboard/activity-log.pagination-stability.test.ts`
- Create: `tests/unit/services/dashboard/activity-log.organization-scope.test.ts`
- Create: `tests/integration/master-catalog/catalogAuditRollback.integration.test.ts`

- [ ] Write RED role tests for OWNER/ADMIN/VIEWER/MEMBER, inactive Staff, inactive or left StaffOrganization, deleted organization, stale
      token membership, cross-tenant ID, superadmin, venue Staff only, and impersonation. Assert cross-tenant 404 rather than authorization
      leakage.
- [ ] Implement one pure authorization call, `authorizeCatalogRequest()`, that receives the authenticated `AuthContext`, the
      `routeOrganizationId`, required gate and a READ/COMMAND capability, constructs only the HUMAN principal, calls
      `resolveMasterCatalogAccess()`, and returns `CatalogReadContext` or `CatalogCommandContext`. The route parameter is the requested
      tenant scope and live StaffOrganization membership is authoritative; stale JWT `orgId`/venue role neither grants nor revokes a
      multi-org membership. Do not accept organizationId from request bodies or cast StaffRole to OrgRole. Impersonation may read under
      effective membership but cannot issue commands.
- [ ] Freeze HTTP authorization mapping for later controllers: unauthenticated is 401; nonexistent organization or missing/foreign child
      under an authorized tenant-scoped lookup is the same 404; authenticated principal without membership/role/entitlement/gate is 403;
      `DEPENDENCY_UNAVAILABLE` is 503. SUPERADMIN has no implicit content access and only the explicitly revalidated control-plane
      capability may bootstrap entitlement/module state.
- [ ] Write RED transaction tests where audit insertion fails after a catalog write; the entire H1 transaction must roll back. Prove
      existing legacy callers of `logAction()` still retain their current best-effort behavior.
- [ ] Implement the H1-only audit writer with an explicit transaction client:

```ts
export async function writeCatalogAudit(tx: Prisma.TransactionClient, input: CatalogAuditInput): Promise<void>
```

For HUMAN actors it writes equal `staffId` and durable `actorStaffId`; for SERVICE it writes neither Staff field. It never downgrades or
rewrites classified actor/organization identity.

- [ ] Extend ActivityLog querying so an organization-scoped request treats a populated organizationId as authoritative and falls back to
      venues only for legacy rows:
      `organizationId = requestedOrganizationId OR (organizationId IS NULL AND venueId IN organization     venues)`. This prevents an
      inconsistent org/venue pair from appearing in two tenants. Keep current venue filters and pagination ordering intact; the H1 writer
      also validates any venue belongs to its derived organization.
- [ ] Build organization scope as an outer `AND` containing the tenant `OR`; put search in a separate nested `OR` so it cannot overwrite
      scope. Reuse the same tenant predicate for `queryActivityLogs()` and `getDistinctActions()`. An organization with zero venues must
      still see organization-only rows. Keep venue-only listing/export paths unchanged; H1A does not invent a new organization export here.
- [ ] The Task 4 API test is an explicit test-only Express/Supertest authorization harness mounted at the future exact organization route;
      it proves JWT/AuthContext → route scope → 401/403/404/503 and body-forgery behavior without adding production routes early. Task 10
      repeats these cases against the real mounted controller/application.
- [ ] Prove PostgreSQL rollback in `catalogAuditRollback.integration.test.ts`: a catalog insert followed by an audit FK failure inside one
      real transaction leaves neither committed; the valid actor case commits both. A mocked transaction alone is insufficient evidence.

- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogAuthorization.service.test.ts \
  tests/unit/services/master-catalog/catalogAudit.service.test.ts \
  tests/unit/services/dashboard/activity-log.pagination-stability.test.ts \
  tests/unit/services/dashboard/activity-log.organization-scope.test.ts
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/masterCatalogAuthorization.api.test.ts
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogAuditRollback.integration.test.ts
npm run audit:permissions
npm run typecheck
npm run build
```

- [ ] Propose checkpoint `feat(h1a): add org authorization and atomic catalog audit`; pause for authorization. If authorized, stage exactly
      the Files list for this task plus the manifest, then commit.

## Task 5 — Implement CatalogItem identity, canonical money, and revisions

**Files**

- Create: `src/services/master-catalog/catalogMoney.service.ts`
- Create: `src/services/master-catalog/catalogHash.service.ts`
- Create: `src/services/master-catalog/identifierNormalization.service.ts`
- Create: `src/services/master-catalog/catalogProductType.service.ts`
- Create: `src/services/master-catalog/catalogMutationLock.service.ts`
- Create: `src/services/master-catalog/catalogItem.types.ts`
- Create: `src/services/master-catalog/catalogItemValidation.service.ts`
- Create: `src/services/master-catalog/catalogReference.service.ts`
- Create: `src/services/master-catalog/catalogItem.service.ts`
- Create: `tests/unit/services/master-catalog/catalogMoney.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogHash.service.test.ts`
- Create: `tests/unit/services/master-catalog/identifierNormalization.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogProductType.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogMutationLock.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogItemValidation.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogItem.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogItemOrganizationValues.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogReference.service.test.ts`
- Create: `tests/integration/master-catalog/catalogItemAggregate.integration.test.ts`
- Create: `tests/integration/master-catalog/catalogItemConcurrency.integration.test.ts`
- Create: `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/task-5-report.md`
- Modify: `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/task-5-brief.md`
- Modify: `docs/superpowers/plans/2026-08-08-pits-h1a-catalog-core.md` (this Task 5 entry only)
- Modify: `docs/superpowers/specs/2026-08-08-pits-h1-master-catalog-design.md`
- Modify: `docs/PITS-H1-CHANGE-MANIFEST.md` (Task 5 entry only)

- [ ] Write RED money tests for blank, zero, integer, two decimals, three decimals, exponent, comma, negative, maximum, overflow, and
      non-string. Return canonical scale-2 strings without converting through JavaScript `number`.
- [ ] Write RED hash golden tests for ordered field masks, Decimal scale, null, enum, boolean, NFC strings, unrelated Product field changes,
      hashVersion mismatch, post-NFC collisions, ordinal non-ASCII/integer-index ordering, sparse-array holes, magic own keys, and
      inherited-scale resistance. Serialize sorted object pairs directly because `JSON.stringify` numerically reorders integer-index keys;
      reject every missing array slot rather than materializing it as null.
- [ ] Write RED CatalogItem tests for organization-scoped SKU uniqueness, mandatory actor/date, one CORPORATE_SKU projection, monotonic
      revision, ACTIVE→RETIRED reservation, normalized brand/manufacturer/family reuse, valid family hierarchy, business-type uniqueness,
      and tenant isolation.
- [ ] Treat CatalogItem as the complete aggregate, never staging: require every baseline scalar/reference made non-null by Task 2; validate
      non-empty/format, active brand/manufacturer, a leaf family with active parent, at least one business type, and at least one active
      ORGANIZATION SALE_PRICE and PURCHASE_COST rule with currency. Incomplete workbook rows remain CatalogImportLine staging.
- [ ] Implement the frozen `normalizeIdentifierV1()` SKU subset first. CatalogItem and its CORPORATE_SKU projection call that same pure
      function inside one transaction; H1A never stores a second interpretation that H1B would need to migrate.
- [ ] Implement brand/manufacturer/family create, update, and retire with normalized-name uniqueness, preserved display values, actor/date,
      tenant scope, and no silent relink. Retired references stay reportable; new assignments require active reference data. A shared
      versioned per-organization transaction advisory lock serializes reference hierarchy/status changes with item assignment. Acquire its
      PostgreSQL `void` statement through parameterized `tx.$executeRaw` plus `Prisma.sql`, not a result-decoding query. Retirement rejects
      references used by any CatalogItem, and FAMILY retirement also rejects durable children; detaching an in-use leaf is rejected.
- [ ] Implement item create/update/retire as one transaction. The SKU command must update CatalogItem and its non-editable CORPORATE_SKU
      projection together; there is no independent projection endpoint.
- [ ] Expose explicit transaction-bound commands for both reference proposals and item aggregates:
      `applyCatalogReferenceProposalsTx(tx, context, proposals, { auditOwnership })` and
      `applyCatalogItemAggregateTx(tx, context, command, { auditOwnership })`. `auditOwnership` is the discriminated union `DIRECT` or
      `BATCH {batchId}` rather than an ambiguous `skipAudit` boolean. The direct wrapper owns one item ActivityLog; the import caller
      applies many commands in its outer transaction, consumes their returned audit envelopes, and writes one batch ActivityLog summary plus
      immutable CatalogImportLine details. Neither path opens nested transactions, writes through global Prisma, or silently loses audit.
- [ ] Store ORGANIZATION SALE_PRICE and PURCHASE_COST rules as Decimal strings validated by the shared money parser. Do not write
      Product.price or Product.cost in this task. Multiple currencies are allowed; uniqueness is item + kind + organization scope +
      currency. UPDATE preserves stable price IDs, increments each touched rule revision with its own CAS, reactivates the same inactive
      row, and deactivates rather than deletes omitted ACTIVE rows. The required internal
      `organizationValueDeactivations[{kind,currency,expectedRuleRevision}]` set is disjoint from retained values and covers exactly every
      ACTIVE omission; Task 7 synthesizes it from the preview snapshot rather than adding an XLSX column.
- [ ] Materialize `CatalogItem.productType` and export the single pure v1 validator consumed by Tasks 6 and 7: PREPARED_DISH requires
      FOOD_AND_BEV; RETAIL_PRODUCT permits REGULAR or FOOD_AND_BEV. Reject deprecated and non-vendible ProductType values for new H1 items.
      CatalogProductTypeMapping is an organization-scoped, immutable/versioned import-alias resolver with at most one active row per
      org+alias; changing it never remaps existing CatalogItems and Task 5 adds no seed/backfill or mapping CRUD.
- [ ] Ensure list/detail queries are paginated and do not load Recipe/modifier graphs. Expose actor and timestamps, profile validation state
      as `NOT_EVALUATED`/stored summary only, bindings summary, and organization value rules. Task 5 must not import or reimplement Task 6
      profile/recipe validation.
- [ ] Prove the real wrapper commits the complete aggregate plus audit; audit FK, relational baseline, and SKU-projection failures roll
      back; retirement keeps normalized SKU reserved; stale retained/omitted price CAS leaves the aggregate unchanged; reference retirement
      in use is rejected; and opposite FAMILY moves serialize without committing a cycle. Identify the second connection and observe its
      advisory-lock wait before releasing the first transaction so scheduler timing alone cannot satisfy the race test. Use only the
      hardened exact local H1 test wrapper, never reset/migrate/start a shared database from this task.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogMoney.service.test.ts \
  tests/unit/services/master-catalog/catalogHash.service.test.ts \
  tests/unit/services/master-catalog/identifierNormalization.service.test.ts \
  tests/unit/services/master-catalog/catalogProductType.service.test.ts \
  tests/unit/services/master-catalog/catalogMutationLock.service.test.ts \
  tests/unit/services/master-catalog/catalogItemValidation.service.test.ts \
  tests/unit/services/master-catalog/catalogItem.service.test.ts \
  tests/unit/services/master-catalog/catalogItemOrganizationValues.service.test.ts \
  tests/unit/services/master-catalog/catalogReference.service.test.ts
node .superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs \
  npx jest --no-watchman --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogItemAggregate.integration.test.ts \
  tests/integration/master-catalog/catalogItemConcurrency.integration.test.ts
npx prettier --check \
  src/services/master-catalog/catalogMoney.service.ts \
  src/services/master-catalog/catalogHash.service.ts \
  src/services/master-catalog/identifierNormalization.service.ts \
  src/services/master-catalog/catalogProductType.service.ts \
  src/services/master-catalog/catalogMutationLock.service.ts \
  src/services/master-catalog/catalogItem.types.ts \
  src/services/master-catalog/catalogItemValidation.service.ts \
  src/services/master-catalog/catalogReference.service.ts \
  src/services/master-catalog/catalogItem.service.ts \
  tests/unit/services/master-catalog/catalogMoney.service.test.ts \
  tests/unit/services/master-catalog/catalogHash.service.test.ts \
  tests/unit/services/master-catalog/identifierNormalization.service.test.ts \
  tests/unit/services/master-catalog/catalogProductType.service.test.ts \
  tests/unit/services/master-catalog/catalogMutationLock.service.test.ts \
  tests/unit/services/master-catalog/catalogItemValidation.service.test.ts \
  tests/unit/services/master-catalog/catalogItem.service.test.ts \
  tests/unit/services/master-catalog/catalogItemOrganizationValues.service.test.ts \
  tests/unit/services/master-catalog/catalogReference.service.test.ts \
  tests/integration/master-catalog/catalogItemAggregate.integration.test.ts \
  tests/integration/master-catalog/catalogItemConcurrency.integration.test.ts
npx eslint \
  src/services/master-catalog/catalogMoney.service.ts \
  src/services/master-catalog/catalogHash.service.ts \
  src/services/master-catalog/identifierNormalization.service.ts \
  src/services/master-catalog/catalogProductType.service.ts \
  src/services/master-catalog/catalogMutationLock.service.ts \
  src/services/master-catalog/catalogItem.types.ts \
  src/services/master-catalog/catalogItemValidation.service.ts \
  src/services/master-catalog/catalogReference.service.ts \
  src/services/master-catalog/catalogItem.service.ts \
  tests/unit/services/master-catalog/catalogMoney.service.test.ts \
  tests/unit/services/master-catalog/catalogHash.service.test.ts \
  tests/unit/services/master-catalog/identifierNormalization.service.test.ts \
  tests/unit/services/master-catalog/catalogProductType.service.test.ts \
  tests/unit/services/master-catalog/catalogMutationLock.service.test.ts \
  tests/unit/services/master-catalog/catalogItemValidation.service.test.ts \
  tests/unit/services/master-catalog/catalogItem.service.test.ts \
  tests/unit/services/master-catalog/catalogItemOrganizationValues.service.test.ts \
  tests/unit/services/master-catalog/catalogReference.service.test.ts \
  tests/integration/master-catalog/catalogItemAggregate.integration.test.ts \
  tests/integration/master-catalog/catalogItemConcurrency.integration.test.ts
npm run typecheck
npm run build
```

- [ ] Propose checkpoint `feat(h1a): implement corporate catalog identity`; pause for authorization. If authorized, stage exactly the Files
      list for this task plus the manifest, then commit.

## Task 6 — Add validation profiles and prepared-dish readiness

**Files**

- Modify: `src/types/master-catalog.ts`
- Create: `src/services/master-catalog/catalogValidation.service.ts`
- Create: `src/services/master-catalog/catalogValidationProfile.service.ts`
- Create: `src/services/master-catalog/catalogValidationProfileRecovery.service.ts`
- Create: `src/services/master-catalog/catalogRecipeCost.service.ts`
- Modify: `src/services/dashboard/recipe.service.ts`
- Modify: `src/services/dashboard/rawMaterial.service.ts`
- Create: `src/services/dashboard/recipe-cost-calculator.ts`
- Create: `src/services/dashboard/recipe-cost-graph-lock.ts`
- Create: `tests/unit/services/master-catalog/catalogValidation.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogValidationProfile.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogValidationProfileAuthorization.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogValidationProfileRecovery.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogRecipeCost.service.test.ts`
- Create: `tests/integration/master-catalog/preparedDishReadiness.integration.test.ts`
- Create: `tests/integration/master-catalog/catalogValidationProfile.integration.test.ts`
- Modify: `tests/unit/services/dashboard/recipe-cost-conversion.test.ts`
- Create: `tests/unit/services/dashboard/recipe-cost-graph-lock.test.ts`
- Create: `tests/unit/services/dashboard/recipe-cost-duplicate-writers.test.ts`
- Modify: `tests/unit/services/dashboard/recipe.service.test.ts`
- Modify: `tests/unit/services/dashboard/rawMaterial.unit-conversion.test.ts`
- Create: `tests/unit/services/dashboard/rawMaterial.recipe-cost-graph.test.ts`
- Modify: `tests/integration/inventory/inventory-system-e2e.test.ts`
- Create: `tests/integration/inventory/recipe-cost-serialization.integration.test.ts`
- Modify: `docs/superpowers/specs/2026-08-08-pits-h1-master-catalog-design.md`
- Modify: `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/task-6-brief.md`
- Create: `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/task-6-report.md`
- Modify: the Task 6 entry of `docs/PITS-H1-CHANGE-MANIFEST.md`

The validation split is intentional: `catalogValidation.service.ts` remains the public baseline/resolution facade and reexports profile
commands, `catalogValidationProfile.service.ts` owns preview-confirm persistence, and `catalogValidationProfileRecovery.service.ts`
validates durable APPLIED recovery against its idempotency record. Dedicated baseline, authorization, state-machine and recovery tests keep
every new production/test file below 500 lines without duplicating the baseline.

- [ ] Encode the approved non-relaxable baseline as a versioned profile: full corporate identity, fiscal fields, explicit IEPS including
      NONE, organization sale/purchase values, currency, actor, date, and at least one business type. A profile may add requirements but
      cannot remove baseline fields.
- [ ] Implement profile changes as preview-confirm without a parallel batch table. Reserve the generic `CatalogIdempotencyRecord` with
      operation `VALIDATION_PROFILE_CHANGE`; its id is `profileBatchId` and its hashed preview token/target hash/dependencies/expiry are
      authoritative. Confirm creates a new immutable profile version and deactivates the prior version transactionally; it never PATCHes a
      historical profile in place. Persist `rulesSchemaVersion=1`; the database permits only one active profile per org/name/business-type/
      operational-role scope.
- [ ] Persist only the random preview token's SHA-256. On a concurrent P2002, re-read outside the aborted transaction: same key/different
      target is 409 `IDEMPOTENCY_KEY_REUSED`; same key/same target still `PREVIEWED` is 409
      `CATALOG_VALIDATION_PROFILE_PREVIEW_TOKEN_NOT_RECOVERABLE`, because raw bearer recovery/re-exposure is forbidden. The caller must
      retain the original token or use a new key; a valid `APPLIED` confirm result remains recoverable.
- [ ] Serialize profile confirmation on the organization + profile name even when the requested scope has no active row. The database
      version key is global to `(organizationId,name,profileVersion)`, so confirm computes `max(profileVersion)+1` under that lock and
      deactivates only the exact scope's active profile. Re-read the idempotency row after the lock, bound versions to PostgreSQL Int32,
      validate persisted APPLIED ids/results, and use a final PREVIEWED CAS. Concurrent absent-row or different-scope previews cannot choose
      the same version. The same transaction writes the complete business audit, including canonical `additionalRules`.
- [ ] Bind every recovered APPLIED result to its containing record: nonblank record id, exact `CatalogValidationProfile` resource type,
      nonblank/equal resource and profile ids, equal batch id, schema v1, active state and profile version in PostgreSQL Int32 range. Reject
      corrupt durable JSON as stable `CATALOG_VALIDATION_PROFILE_RESULT_INVALID` before any profile/audit write.
- [ ] Fail authorization before reservation or lock: only live HUMAN, non-impersonating OWNER with mutable CORE access may preview or
      confirm. SERVICE actors, impersonation, revoked/mismatched staff access and dependency failure map to stable 403/503 results.
- [ ] Write RED RETAIL_PRODUCT tests and PREPARED_DISH tests for no Recipe, invalid portion yield, missing `Recipe.prepTime`, empty/invalid
      lines, stale `Recipe.totalCost`, and complete recipe. Only an ACTIVE CatalogItem with a LINKED binding is eligible; `prepTime` is a
      positive integer. Pending/unlinked provenance and retired items fail tenant-safe without reading Recipe details.
- [ ] Require the materialized `CatalogItem.productType` and v1 kind compatibility: PREPARED_DISH requires FOOD_AND_BEV; RETAIL_PRODUCT
      permits REGULAR or FOOD_AND_BEV so packaged food/drink merchandise does not acquire Recipe semantics. Reject deprecated
      FOOD/BEVERAGE/ALCOHOL/RETAIL and out-of-scope non-vendible service/class/event/digital/donation/OTHER types for new H1 items.
      Product-type alias resolution belongs to Task 7 import and does not add a mutable FK dependency here.
- [ ] Reuse the current authoritative recipe calculator in read-only mode. Compute only:

```text
batchCost = sum(convert(line.quantity, line.unit, rawMaterial.unit) * rawMaterial.costPerUnit)
costPerPortion = round(batchCost / portionYield, 4, HALF_UP)
```

Compare the recomputed `costPerPortion` directly with the stored `Recipe.totalCost`, because the operational domain already treats
`Recipe.totalCost` as per-portion cost. Capture Recipe.updatedAt and line hash as preview dependencies; never copy Recipe or mutate
`PricingPolicy.calculatedCost`.

- [ ] Extract the pure calculation into neutral `src/services/dashboard/recipe-cost-calculator.ts`; both legacy recalculation and H1 preview
      call it, so the legacy domain never imports master-catalog code. Order line hashing by displayOrder/id, use Decimal ROUND_HALF_UP
      scale 4, and capture Recipe.updatedAt. Correct the isolated legacy recalculation path so yield > 1 stores the sum of per-serving line
      costs in `Recipe.totalCost`, matching create/update/raw-material recomputation/pricing/report semantics; add a regression asserting
      both line and recipe totals for a batch recipe. A metadata-only `portionYield` update must recalculate existing line/aggregate costs
      transactionally instead of persisting a new denominator with stale costs. H1 must not call the mutating `recalculateRecipeCost()`
      path.
- [ ] Preserve legacy empty-recipe compatibility in the neutral calculator: an empty batch yields exact zero batch/per-portion cost and no
      line results, so yield edits and explicit recalculation persist zero instead of throwing 500. Readiness still reports `EMPTY_LINES`
      before calculation. Map invalid historical calculator inputs in mutation paths to stable 422 `RECIPE_COST_INPUT_INVALID`.
- [ ] Serialize cooperating graph writers on `h1a:recipe-cost-graph:v1:<venueId>` before graph reads: lock Recipe and Product, then
      RecipeLine in id order, then RawMaterial in id order; reread after locks and calculate/write in the same transaction. Recipe create
      locks the tenant Product row. The calculator-input writers create/update/add/updateLine/remove/recalculate in `recipe.service.ts`
      participate, as does dashboard RawMaterial editing whenever `costPerUnit` or `unit` is present. Duplicate ingredient ids in
      create/full-update/add fail stable 400 before writes.
- [ ] Keep the scope honest: the coarse Venue lock closes cooperating add-line/RM phantoms and row locks stabilize current Product/RM inputs
      through commit, but `interVenueTransfer.service.ts` and `scripts/recover-cost-per-unit.ts` remain non-cooperating cost writers. They
      may make a recipe subsequently STALE; migrate them in follow-up rather than claiming a global invariant. The dashboard operational
      recompute ActivityLog is emitted after graph commit and is not an atomic business-audit guarantee.
- [ ] Revalidate tenant/provenance at the final readiness reads. The Recipe query must include Product.venueId, every RawMaterial must match
      the requested Venue before dependency hashing, and a fresh LINKED binding + ACTIVE CatalogItem row supplies returned revisions.
      Cross-venue/corrupt graphs expose no cost or recipe hash oracle.
- [ ] Keep Task 6 read-only with respect to operational Product: it returns validation findings/readiness and never changes a legacy writer.
      Task 9 owns the actual OFF/ADVISORY/ENFORCED writer guard and will require both organization and venue governance states.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --watchman=false --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogValidation.service.test.ts \
  tests/unit/services/master-catalog/catalogValidationProfile.service.test.ts \
  tests/unit/services/master-catalog/catalogValidationProfileAuthorization.service.test.ts \
  tests/unit/services/master-catalog/catalogValidationProfileRecovery.service.test.ts \
  tests/unit/services/master-catalog/catalogRecipeCost.service.test.ts \
  tests/unit/services/dashboard/recipe-cost-conversion.test.ts \
  tests/unit/services/dashboard/recipe-cost-graph-lock.test.ts \
  tests/unit/services/dashboard/recipe-cost-duplicate-writers.test.ts \
  tests/unit/services/dashboard/recipe.service.test.ts \
  tests/unit/services/dashboard/rawMaterial.unit-conversion.test.ts \
  tests/unit/services/dashboard/rawMaterial.recipe-cost-graph.test.ts
node .superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs \
  npx jest --watchman=false --runInBand --runTestsByPath \
  tests/integration/master-catalog/preparedDishReadiness.integration.test.ts \
  tests/integration/master-catalog/catalogValidationProfile.integration.test.ts \
  tests/integration/inventory/inventory-system-e2e.test.ts \
  tests/integration/inventory/recipe-cost-serialization.integration.test.ts
npm run typecheck -- --pretty false
npm run build
```

The two concurrency integrations use independent blocker/observer connections and identifiable `application_name` values. They release the
held key only after PostgreSQL reports both production writers waiting on `wait_event='advisory'`; this is a mutation-sensitive lock proof,
not a scheduler sleep or merely a commutative final-state assertion. Execute them only through the exact disposable H1 wrapper.

- [ ] Propose checkpoint `feat(h1a): validate catalog profiles and dish readiness`; pause for authorization. If authorized, stage exactly
      the Files list for this task plus the manifest, then commit.

## Task 7 — Stage and confirm the versioned master-catalog XLSX import

**Files**

- Modify shared seams: `src/types/master-catalog.ts`, `src/services/master-catalog/identifierNormalization.service.ts`,
  `src/services/master-catalog/catalogItemValidation.service.ts`, `src/services/master-catalog/catalogReference.service.ts`,
  `src/services/master-catalog/catalogValidationProfile.service.ts`,
  `tests/unit/services/master-catalog/identifierNormalization.service.test.ts`,
  `tests/unit/services/master-catalog/catalogItemValidation.service.test.ts` and
  `tests/unit/services/master-catalog/catalogValidationProfile.service.test.ts`.
- Create facade/contracts/pipeline: `src/services/master-catalog/catalogImport.service.ts`,
  `src/services/master-catalog/catalogImport.types.ts`, `src/services/master-catalog/catalogImportValidation.service.ts`,
  `src/services/master-catalog/catalogImportConfirmation.service.ts`, `src/services/master-catalog/catalogImportRecovery.service.ts`,
  `src/services/master-catalog/catalogWorkbook.service.ts` and `src/schemas/dashboard/masterCatalogImport.schema.ts`.
- Create bounded mapping/staging splits: `src/services/master-catalog/catalogImportBinding.service.ts`,
  `src/services/master-catalog/catalogImportFieldValidation.service.ts`, `src/services/master-catalog/catalogImportItemRow.service.ts`,
  `src/services/master-catalog/catalogImportLookup.service.ts`, `src/services/master-catalog/catalogImportMapping.service.ts`,
  `src/services/master-catalog/catalogImportReviewLines.service.ts`,
  `src/services/master-catalog/catalogImportStagedCollections.service.ts`,
  `src/services/master-catalog/catalogImportStagedPayload.service.ts` and
  `src/services/master-catalog/catalogImportStagingPersistence.service.ts`.
- Create authority/performance/read splits: `src/services/master-catalog/catalogImportAuditSummary.service.ts`,
  `src/services/master-catalog/catalogImportCanonical.service.ts`, `src/services/master-catalog/catalogImportCapacity.service.ts`,
  `src/services/master-catalog/catalogImportDependencies.service.ts`,
  `src/services/master-catalog/catalogImportDependencySnapshot.service.ts`,
  `src/services/master-catalog/catalogImportPreviewProjection.service.ts`,
  `src/services/master-catalog/catalogImportPreviewReferenceProjection.service.ts`,
  `src/services/master-catalog/catalogImportRead.service.ts`, `src/services/master-catalog/catalogImportReadQueries.service.ts`,
  `src/services/master-catalog/catalogImportReadReferenceProofQueries.service.ts`,
  `src/services/master-catalog/catalogImportReadValidation.service.ts` and
  `src/services/master-catalog/catalogValidationRuleJson.service.ts`.
- Create custom upload parser: `src/workers/masterCatalogXlsx.worker.ts`, `src/workers/masterCatalogOoxmlPreflight.ts`,
  `src/workers/masterCatalogWorksheetXml.ts` and `src/workers/masterCatalogXmlSafety.ts`.
- Create fixtures: `scripts/generate-master-catalog-import-fixtures.ts`, `tests/fixtures/master-catalog/catalog-master-import-v1-valid.xlsx`
  and `tests/fixtures/master-catalog/catalog-master-import-v1-errors.xlsx`.
- Create service tests under `tests/unit/services/master-catalog/`: `catalogImport.service.test.ts`,
  `catalogImportAuditSummary.service.test.ts`, `catalogImportCanonical.service.test.ts`, `catalogImportCapacity.service.test.ts`,
  `catalogImportCapacityIntegration.service.test.ts`, `catalogImportConfirmation.service.test.ts`,
  `catalogImportConfirmationConcurrency.service.test.ts`, `catalogImportDependencies.service.test.ts`,
  `catalogImportDependencySnapshot.service.test.ts`, `catalogImportDurableEventLoop.service.test.ts`,
  `catalogImportEventLoopTestHarness.ts`, `catalogImportBinding.service.test.ts`, `catalogImportFieldValidation.service.test.ts`,
  `catalogImportItemRow.service.test.ts`, `catalogImportLookup.service.test.ts`, `catalogImportPreviewProjection.service.test.ts`,
  `catalogImportPreviewProjectionValidation.service.test.ts`, `catalogImportPreviewReferenceProjection.service.test.ts`,
  `catalogImportPreviewSkuProjection.service.test.ts`, `catalogImportRead.service.test.ts`, `catalogImportReadQueries.service.test.ts`,
  `catalogImportReadState.service.test.ts`, `catalogImportRecovery.service.test.ts`, `catalogImportReviewLines.service.test.ts`,
  `catalogImportStagedPayload.service.test.ts`, `catalogImportTestHarness.ts`, `catalogImportValidationMatrix.service.test.ts`,
  `catalogReferenceNormalization.service.test.ts`, `catalogValidationRuleJson.service.test.ts`, `catalogWorkbook.service.test.ts` and
  `catalogWorkbook.eventloop-budget.test.ts`.
- Create boundary/adapter tests: `tests/unit/workers/masterCatalogXlsx.fixture.ts`, `tests/unit/workers/masterCatalogXlsx.worker.test.ts`,
  `tests/unit/workers/masterCatalogXlsxSecurity.worker.test.ts`, `tests/unit/architecture/masterCatalogWorkbookRuntimeBoundary.test.ts`,
  `tests/unit/schemas/dashboard/masterCatalogImport.schema.test.ts`, `tests/unit/scripts/generateMasterCatalogImportFixtures.test.ts`,
  `tests/api-tests/master-catalog/catalogImport.api.test.ts` and `tests/integration/master-catalog/catalogImport.integration.test.ts`.
- Modify documentation/evidence: `docs/superpowers/specs/2026-08-08-pits-h1-master-catalog-design.md`, this plan,
  `docs/PITS-H1-CHANGE-MANIFEST.md`, `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/progress.md`,
  `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/task-7-brief.md` and
  `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/task-7-report.md`.

- [ ] Freeze the input as `catalog-master-import-v1.xlsx`, distinct from the nine-sheet read/export `catalog-master-v1.xlsx`. Accept exactly
      `Metadata`, `Items`, `OrganizationValues`, `BusinessTypes`, and `VenueBindingRequests`; reject `PreparedDishDetails`, `Identifiers`,
      `Regions`, `RegionalValues`, and every unknown sheet as input. Metadata freezes `documentType=catalog-master-import` and integer
      `schemaVersion=1`. Use the exact columns and CREATE/UPDATE/RETIRE replacement semantics in spec D11.1. Server-derived actor,
      timestamps, status, calculated recipe diagnostics, and publication revisions are never trusted from XLSX.
- [ ] Generate both binary fixtures deterministically with `scripts/generate-master-catalog-import-fixtures.ts`; do not hand-edit them or
      generate them as a side effect of assertions. The source script and manifest explain every binary-only decision.
- [ ] Validate `CatalogWorkbookUpload` MIME, `.xlsx` suffix, ZIP/OOXML magic, upload bytes, entry count, uncompressed bytes, compression
      ratio, sheets, rows, columns, and cell length before mapping domain commands. Constants are contractual: 10 MiB compressed, 128 ZIP
      entries, 64 MiB expanded, ratio 100:1, 50,000 rows total, 20,000 rows per sheet, 64 columns, and 4,096 Unicode scalars/16,384 UTF-8
      bytes per cell. Accept `application/octet-stream` only when the filename ends in `.xlsx` and the content is valid OOXML. Reject
      macros, formulas, external links, encrypted/invalid ZIP, control characters, and formula-like cells.
- [ ] Keep ZIP/OPC inspection, fatal UTF-8 XML validation and row extraction in the custom worker safe subset, with a transferable buffer,
      resource limits and a hard 15 s timeout. The Task 7 arbitrary-upload runtime must not import/call installed `xlsx@0.18.5`; within Task
      7 that dependency is used only for trusted fixture writes/tests because arbitrary reads are affected by documented
      prototype-pollution/ReDoS advisories. Existing unrelated export generators remain outside this task. Authorization, tenant lookups,
      validation, staging and transactions remain on the main thread. Prove every main-thread slice remains below `EVENT_LOOP_BUDGET_MS=50`,
      including nested canonicalization and durable parsers. Tolerate only benign metadata formatting required by real openpyxl/LibreOffice
      resaves; semantic sheet relationships and `worksheet/sheetData/row/cell/value` ancestry remain exact. Benign rows outside `sheetData`
      may be accepted as metadata but are ignored and never staged/applied; formulas remain rejected.
- [ ] Preserve numeric OOXML lexemes directly from worksheet XML. SKU/code cells must be text; decimal/integer cells pass raw `<v>` strings
      to Task 5's string-only Decimal parser. Reject exponent, NaN/Infinity, cached/formula values, malformed cell types, invalid UTF-8/XML,
      DTD/ENTITY, unknown XML parts/roots/ancestry and any precision outside the frozen contract.
- [ ] Write RED preview tests for unknown schemaVersion, missing sheet/column, numeric code/SKU, formulas, duplicates, invalid
      enum/decimal/currency/URL, cross-tenant venue/Product, retired/ambiguous references, unknown product-type alias, incomplete profile,
      and multiple errors in one row. Canonical ProductType values bypass mappings; organization aliases require one active immutable
      `CatalogProductTypeMapping`, whose ID/version is captured as a dependency. Preview writes staging only.
- [ ] Apply explicit merge semantics. CREATE has blank item ID/revision; UPDATE/RETIRE require both; CREATE/UPDATE replace the complete item
      baseline plus complete OrganizationValues and non-empty BusinessTypes sets. Rows absent for items not listed in `Items` mean no
      change. RETIRE preserves identity/history. A SKU rename requires the stable item ID and expected revision. Unknown active
      brand/manufacturer/family values become visible `CREATE_REFERENCE` proposals; retired or ambiguous values are invalid.
- [ ] Treat `VenueBindingRequests` as requests only. Validate and retain LINK/CREATE/SKIP intent in staging, but import confirmation never
      creates or changes Product/CatalogVenueBinding. Task 8 consumes and revalidates those requests in its separate human-confirmed binding
      preview.
- [ ] Return row-level errors with `source_sheet`, `source_row`, `column`, stable error code, safe/truncated rejected value, and actionable
      suggestion. Any error makes confirm unavailable. Bound the immediate response with `errorCount/errorsTruncated`, while preserving
      every actionable coordinate as its own durable review line; never synthesize a 50,001st line for a batch-level capacity error.
- [ ] Make preview reviewable rather than blind. Authorize only the original non-impersonating HUMAN actor with live CORE/MUTATE access,
      then expose bounded keyset pages for ITEMS, ORGANIZATION_VALUES, BUSINESS_TYPES, REFERENCE_PROPOSALS, VENUE_BINDING_REQUESTS and
      ERRORS plus bounded Item detail. Cursor v1 binds batch, section and targetHash; page size defaults to 25 and caps at 50. FAILED stays
      readable for correction and APPLIED for history. No URL contains a bearer and no response exposes raw JSON.
- [ ] Freeze confirmation cost model version 1 at 12,000 units inclusive: base 32; root reference 3; child FAMILY 4; CREATE 10; UPDATE
      `12 + values + deactivations`; RETIRE 6. Persist exact capacity for PREVIEWED/APPLIED. An early lower bound of 12,001 produces a fully
      shaped FAILED batch, no token and 413; never auto-split or partially apply. Confirmation recomputes exact capacity before lease or
      Task 5 writes.
- [ ] Bind preview to organization, actor, file SHA-256, canonical command hash, captured item/reference/profile/mapping revisions, and a
      30-minute expiration. `CatalogImportBatch` is authoritative for content and import state; the unique
      `CatalogIdempotencyRecord(operation='CATALOG_IMPORT')` reserves recovery/idempotency and points to the batch via resourceType/id.
      Update both in one transaction. Its durable `createdAt` is the same instant already checked against preview expiry, so dependency work
      cannot cross the database snapshot constraint; the exact constraint maps to stable expired 409. Persist only SHA-256 of the random
      bearer token and compare it in constant time. Confirm requires the same active membership/access, preview token, `confirm: true`, and
      idempotency key.
- [ ] Treat every persisted JSON boundary as hostile: exact schema/version/keys/types, lowercase SHA-256, finite dates, Int32 source rows,
      bounded arrays/strings and canonical Task 5 DTO equality. Limit line reads with `take 50_001` before payload hydration and query/write
      large `IN`/createMany sets in documented chunks. Recovery validates complete dependency snapshots and exact APPLIED Item lines across
      batch/idempotency; no raw durable extras are returned.
- [ ] Bound final persisted corporate-SKU, reference, and Venue-binding local Product keys—after NFKC/trim/(reference whitespace
      collapse)/uppercase—to 256 Unicode scalars and 1,024 UTF-8 bytes, rejecting NUL and lone surrogates before Prisma. Preserve
      corporate/reference display within the 4,096-scalar/16,384-byte cell envelope; deliberately stage binding `localSku` as the canonical
      future Product key while file/request hashes retain submitted-upload authority. Keep the generic SKU transform unchanged. Truncate
      rejected-value diagnostics at 128 complete scalars so JSONB/API output never contains a split surrogate.
- [ ] Treat read excerpts as presentation only. Query bounded hidden full-SKU/reference proofs plus a SHA-256 marker-base proof, verify the
      normalized identity and FAMILY parent/sibling binding in JavaScript, and only then emit a bounded projection. If long padding hides
      the meaningful reference key in the middle, emit that canonical identity; never expose proof fields, digests or proposal markers.
- [ ] Write RED confirm tests for same-key/same-hash recovery, same-key/different-hash 409, expired/stale preview, two concurrent confirms,
      audit failure, and one invalid row. Use the transaction-bound Task 5 aggregate command; never bypass its baseline, SKU, revision, or
      audit invariants with direct partial Prisma writes. Call `applyCatalogReferenceProposalsTx()` and `applyCatalogItemAggregateTx()` with
      `auditOwnership: {kind:'BATCH',batchId}` and write exactly one summary ActivityLog in the outer transaction. Every failure produces
      zero operational changes. Prove with PostgreSQL that one confirm commits items/reference proposals/import state/audit together,
      concurrent confirmation has one effect, and any failure rolls all of them back.
- [ ] Acquire the shared organization catalog-mutation lock before dependency revalidation; Task 6 profile writers take that same lock
      before their name lock. After a wait, reread batch/idempotency: same-key APPLIED returns exact recovery, a different key conflicts and
      only PREVIEWED continues. A CREATE_REFERENCE proposal that races into `reused:true` is STALE_PREVIEW and rolls back before Item/audit.
- [ ] Keep this route and labeling separate from `MenuImportDialog` and the current menu-replace service. Do not reuse a Product-by-name
      inference path.
- [ ] Until Task 10 mounts production routes, make `catalogImport.api.test.ts` an explicitly named test-only Express/Supertest multipart
      authorization/schema harness for the exact planned URL. Task 10 repeats the contract against the real app/controller/Multer wiring and
      maps upload-limit/file-type errors to stable 4xx responses rather than 500.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogImport.service.test.ts \
  tests/unit/services/master-catalog/catalogImportAuditSummary.service.test.ts \
  tests/unit/services/master-catalog/catalogImportBinding.service.test.ts \
  tests/unit/services/master-catalog/catalogImportCanonical.service.test.ts \
  tests/unit/services/master-catalog/catalogImportCapacity.service.test.ts \
  tests/unit/services/master-catalog/catalogImportCapacityIntegration.service.test.ts \
  tests/unit/services/master-catalog/catalogImportConfirmation.service.test.ts \
  tests/unit/services/master-catalog/catalogImportConfirmationConcurrency.service.test.ts \
  tests/unit/services/master-catalog/catalogImportDependencies.service.test.ts \
  tests/unit/services/master-catalog/catalogImportDependencySnapshot.service.test.ts \
  tests/unit/services/master-catalog/catalogImportDurableEventLoop.service.test.ts \
  tests/unit/services/master-catalog/catalogImportFieldValidation.service.test.ts \
  tests/unit/services/master-catalog/catalogImportItemRow.service.test.ts \
  tests/unit/services/master-catalog/catalogImportLookup.service.test.ts \
  tests/unit/services/master-catalog/catalogImportPreviewProjection.service.test.ts \
  tests/unit/services/master-catalog/catalogImportPreviewProjectionValidation.service.test.ts \
  tests/unit/services/master-catalog/catalogImportPreviewReferenceProjection.service.test.ts \
  tests/unit/services/master-catalog/catalogImportPreviewSkuProjection.service.test.ts \
  tests/unit/services/master-catalog/catalogImportRead.service.test.ts \
  tests/unit/services/master-catalog/catalogImportReadQueries.service.test.ts \
  tests/unit/services/master-catalog/catalogImportReadState.service.test.ts \
  tests/unit/services/master-catalog/catalogImportRecovery.service.test.ts \
  tests/unit/services/master-catalog/catalogImportReviewLines.service.test.ts \
  tests/unit/services/master-catalog/catalogImportStagedPayload.service.test.ts \
  tests/unit/services/master-catalog/catalogImportValidationMatrix.service.test.ts \
  tests/unit/services/master-catalog/catalogItemValidation.service.test.ts \
  tests/unit/services/master-catalog/catalogReferenceNormalization.service.test.ts \
  tests/unit/services/master-catalog/identifierNormalization.service.test.ts \
  tests/unit/services/master-catalog/catalogValidationProfile.service.test.ts \
  tests/unit/services/master-catalog/catalogValidationRuleJson.service.test.ts \
  tests/unit/services/master-catalog/catalogWorkbook.service.test.ts \
  tests/unit/services/master-catalog/catalogWorkbook.eventloop-budget.test.ts \
  tests/unit/workers/masterCatalogXlsx.worker.test.ts \
  tests/unit/workers/masterCatalogXlsxSecurity.worker.test.ts \
  tests/unit/architecture/masterCatalogWorkbookRuntimeBoundary.test.ts \
  tests/unit/schemas/dashboard/masterCatalogImport.schema.test.ts \
  tests/unit/scripts/generateMasterCatalogImportFixtures.test.ts
npx jest --no-watchman --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/catalogImport.api.test.ts
node .superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs \
  npx jest --no-watchman --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogImport.integration.test.ts
npm run typecheck -- --pretty false
npm run build
```

- [ ] Propose checkpoint `feat(h1a): add atomic master catalog import`; pause for authorization. If authorized, stage exactly the Files list
      for this task plus the manifest, then commit.

## Task 8 — Preview and confirm explicit venue bindings

**Files**

- Modify: `src/types/master-catalog.ts`
- Create binding facade/state-machine splits: `src/services/master-catalog/catalogBinding.service.ts`,
  `src/services/master-catalog/catalogBindingPreview.service.ts`, `src/services/master-catalog/catalogBindingConfirmation.service.ts`,
  `src/services/master-catalog/catalogBindingProductWriter.service.ts`, `src/services/master-catalog/catalogBindingReadiness.service.ts`,
  `src/services/master-catalog/catalogBindingRecovery.service.ts` and `src/services/master-catalog/catalogBindingRecoverySchema.service.ts`.
- Create override facade/read/recovery splits: `src/services/master-catalog/catalogOverride.service.ts`,
  `src/services/master-catalog/catalogOverrideRead.service.ts` and `src/services/master-catalog/catalogOverrideRecovery.service.ts`.
- Create binding unit matrix: `tests/unit/services/master-catalog/catalogBinding.service.test.ts`,
  `tests/unit/services/master-catalog/catalogBindingConfirmation.service.test.ts`,
  `tests/unit/services/master-catalog/catalogBindingGuards.service.test.ts` and
  `tests/unit/services/master-catalog/catalogBindingTestHarness.ts`.
- Create override unit matrix: `tests/unit/services/master-catalog/catalogOverride.service.test.ts` and
  `tests/unit/services/master-catalog/catalogOverrideConcurrency.service.test.ts`.
- Create guarded PostgreSQL proof and concurrency harness: `tests/integration/master-catalog/catalogBinding.integration.test.ts` and
  `tests/integration/master-catalog/catalogBindingIntegrationHarness.ts`.
- Modify documentation/evidence: this plan, `docs/PITS-H1-CHANGE-MANIFEST.md`,
  `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/progress.md` and `.superpowers/sdd/2026-08-08-pits-h1a-catalog-core/task-8-report.md`.

- [ ] Freeze `CatalogBindingPreviewInput` as bounded lines of `(catalogItemId,venueId,decision?)`; a decision is the discriminated union
      `LINK {productId}`, `CREATE {categoryId,localSku,initialPrice:string}`, or `SKIP`. A discovery-only preview may omit decisions and
      returns `canConfirm=false`; the last preview before confirm requires one explicit human decision per line. Bind/override commands
      require a non-impersonating HUMAN actor with live organization access.
- [ ] Write RED preview tests for raw case-sensitive equality of `CatalogItem.sku` against local Product `sku` or `gtin`, no candidate,
      cross-field collision, multiple candidates, cross-tenant target, Product already bound, CatalogItem already bound in venue,
      category/price/SKU required to create, exact Venue-currency PURCHASE_COST for retail, explicit inactive creation, and PREPARED_DISH
      recipe readiness. H1A does not NFKC/case-fold Product codes or use name, similarity, `findFirst`, barcode service, or H1B aliases.
      Order by Product ID and deduplicate a Product matching both fields.
- [ ] Return only `LINK`, `CREATE`, or `SKIP` proposals with an explicitly selected Product snapshot and conflicts. Include active,
      inactive, and soft-deleted exact-code rows in collision diagnostics because all can reserve venue SKU/GTIN uniqueness. Deleted rows
      are never linkable; inactive rows may be linked only by explicit decision and remain inactive. CREATE is rejected while any row
      reserves the requested local SKU/GTIN. A LINK Product ID must be one of the preview's exact candidates.
- [ ] Confirm each line only after a human decision. `LINK` inserts provenance only and preserves every Product field/ID/venue/category;
      `CREATE` uses a private transaction-bound writer, a DB-generated Product ID, explicit local category/SKU/price, `gtin=null`, and
      materializes only the current CatalogItem managed fields. The local price is denominated in `Venue.currency`; retail cost requires the
      ACTIVE ORGANIZATION PURCHASE_COST in that exact currency, with no conversion or fallback, while PREPARED_DISH cost remains null. Every
      new Product is written explicitly `active=false` so the legacy default cannot bypass Task 9 activation. It creates no Inventory,
      Recipe, modifiers, availability, print/display, tags beyond required empty defaults, or POS metadata. `SKIP` writes no Product or
      binding.
- [ ] For CREATE, save current catalog revision, managed snapshot/hash version 1 and diagnostic Product.updatedAt because those fields were
      materialized by the confirmed catalog operation. For LINK, set `lastPublishedCatalogRevision`, managed snapshot and managed hash to
      null until Task 9 publishes; Product.updatedAt remains diagnostic. The ordered H1A field mask is cost (retail only), description,
      imageUrl, name, objetoImp, satProductKey, satUnitKey, taxRate, type and unit. Never include Product.price, category, active,
      availability, stock/inventoryMethod, Recipe, modifiers, display/print, tags, or POS metadata.
- [ ] PREPARED_DISH LINK/CREATE may create provenance while readiness is MISSING_RECIPE, but it captures that dependency and Task 9 blocks
      publication/activation until readiness is valid. Task 8 never fabricates or updates a Recipe and never activates any Product.
- [ ] Add idempotency, stale dependency, concurrent binding, transaction-audit failure, and cross-tenant SQL tests. Confirming twice must
      not create a second Product or reparent the first. Use operation `CATALOG_BINDING`, token hash only, stable
      item/venue/Product/category and readiness snapshots, and map expected unique/serialization races without leaving an orphan Product.
- [ ] Add venue provenance/change reads and override-request preview/confirm through a shared service that requires active StaffVenue plus
      exact venue permission. The service cannot import, publish organization content, or expose another venue; MCP
      `request_catalog_override` calls this same service.
- [ ] Override requests use `CatalogIdempotencyRecord.id` as `requestBatchId` with operation `CATALOG_OVERRIDE_REQUEST`; preview captures
      binding/Product values server-side, never accepts `localValue`, and permits only the H1A managed field mask with a nonempty reason. It
      creates REQUESTED rows only. Corporate APPROVED/REJECTED decisions occur in Task 9's publication conflict flow, never implicitly in
      this venue service. Serialize concurrent requests for the same binding/field and prove audit failure rolls every row back.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogBinding.service.test.ts \
  tests/unit/services/master-catalog/catalogBindingConfirmation.service.test.ts \
  tests/unit/services/master-catalog/catalogBindingGuards.service.test.ts \
  tests/unit/services/master-catalog/catalogOverride.service.test.ts \
  tests/unit/services/master-catalog/catalogOverrideConcurrency.service.test.ts
node .superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs \
  npx jest --no-watchman --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogBinding.integration.test.ts \
  tests/integration/master-catalog/h1a-tenant-constraints.integration.test.ts
npm run typecheck
npm run build
```

- [ ] Propose checkpoint `feat(h1a): add explicit venue catalog bindings`; pause for authorization. If authorized, stage exactly the Files
      list for this task plus the manifest, then commit.

## Task 9 — Build generic preview/publication and managed-field conflict handling

**Implementation status (2026-08-09):** production, unit/static gates and all writer adapters are implemented. The four disposable
PostgreSQL specs and shared harness are prepared but deliberately unexecuted pending explicit DB authorization. Final independent review
approved the frozen scoped snapshot with 0 P0/P1; the required unit gate is 14 suites/154 tests, the expanded real-writer/legacy-envelope
gate is 27 suites/269 tests, and the full 70-path ESLint/Prettier scope is clean. This status does not claim ENFORCED rollout or database
acceptance.

**Files**

- Modify: `src/types/master-catalog.ts`
- Create: `src/services/master-catalog/catalogPublication.service.ts`
- Create: `src/services/master-catalog/catalogPublication.types.ts`
- Create: `src/services/master-catalog/catalogPublicationProjection.service.ts`
- Create: `src/services/master-catalog/catalogPublicationPreview.service.ts`
- Create: `src/services/master-catalog/catalogPublicationTargetLoader.service.ts`
- Create: `src/services/master-catalog/catalogPublicationStaging.service.ts`
- Create: `src/services/master-catalog/catalogPublicationConfirmation.service.ts`
- Create: `src/services/master-catalog/catalogPublicationAuthorityLock.service.ts`
- Create: `src/services/master-catalog/catalogPublicationPersistence.service.ts`
- Create: `src/services/master-catalog/catalogPublicationRecovery.service.ts`
- Create: `src/services/master-catalog/catalogPublicationOverrideDecision.service.ts`
- Create: `src/services/master-catalog/catalogPublicationActivation.service.ts`
- Create: `src/services/master-catalog/catalogPublicationReversion.service.ts`
- Create: `src/services/master-catalog/catalogPublicationReversionAuthority.service.ts`
- Create: `src/services/master-catalog/catalogGovernance.service.ts`
- Create: `src/services/master-catalog/catalogGovernanceFence.service.ts`
- Create: `tests/unit/services/master-catalog/catalogPublication.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationProjection.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationPreview.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationTargetLoader.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationStaging.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationConfirmation.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationAuthorityLock.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationPersistence.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationRecovery.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationOverrideDecision.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationActivation.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationReversion.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationReversionAuthority.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogGovernance.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogGovernanceFence.service.test.ts`
- Create: `tests/integration/master-catalog/catalogPublication.integration.test.ts`
- Create: `tests/integration/master-catalog/catalogPublicationIntegrationHarness.ts`
- Create: `tests/integration/master-catalog/catalogPublicationConcurrency.integration.test.ts`
- Create: `tests/integration/master-catalog/catalogGovernance.integration.test.ts`
- Create: `tests/integration/master-catalog/catalogPublicationOutbox.integration.test.ts`
- Modify: `src/services/dashboard/product.dashboard.service.ts`
- Modify: `src/controllers/dashboard/product.dashboard.controller.ts`
- Modify: `src/controllers/dashboard/menu.dashboard.controller.ts`
- Modify: `src/services/dashboard/productWizard.service.ts`
- Modify: `src/controllers/dashboard/inventory/productWizard.controller.ts`
- Modify: `src/services/dashboard/menu.dashboard.service.ts`
- Modify: `src/mcp/tools/menu.ts`
- Modify: `src/services/dashboard/chatbot-actions/definitions/product-crud.actions.ts`
- Modify: `src/services/dashboard/text-to-sql-assistant.service.ts`
- Modify: `src/controllers/mobile/product.mobile.controller.ts`
- Modify: `src/routes/tpv.routes.ts`
- Modify: `src/services/pos-sync/posSyncOrderItem.service.ts`
- Modify: `src/services/delivery-channels/core/deliveryOrderIngestion.service.ts`
- Modify: `src/services/onboarding/venueCreation.service.ts`
- Modify: `src/services/onboarding/demoSeed.service.ts`
- Modify: `scripts/seed-demo-venues.ts`
- Create: `tests/unit/architecture/masterCatalogGovernedProductWriters.test.ts`
- Create: `tests/unit/services/master-catalog/catalogGovernedProductWriters.service.test.ts`
- Create: `tests/unit/services/pos-sync/posSyncOrderItem.service.test.ts`
- Modify: `tests/unit/services/delivery-channels/deliveryOrderIngestion.test.ts`
- Modify: `tests/unit/services/dashboard/menu.dashboard.service.test.ts`
- Modify: `tests/unit/services/dashboard/product.dashboard.service.test.ts`
- Modify: `tests/unit/services/dashboard/product.sat-fields.test.ts`
- Modify: `tests/unit/contracts/h1aLegacyInternalFieldBoundary.contract.test.ts`
- Modify: `tests/unit/contracts/masterCatalogLegacyProduct.contract.test.ts`
- Create: `src/services/master-catalog/catalogPublicationOutbox.service.ts`
- Create: `src/jobs/catalog-publication-outbox-sweeper.job.ts`
- Create: `src/jobs/catalog-publication-watchdog.job.ts`
- Modify: `src/jobs/jobSchedules.ts`
- Modify: `src/server.ts`
- Create: `tests/unit/services/master-catalog/catalogPublicationOutbox.service.test.ts`
- Create: `tests/unit/jobs/catalog-publication-outbox-sweeper.job.test.ts`
- Create: `tests/unit/jobs/catalog-publication-watchdog.job.test.ts`

Authorized responsibility splits keep every new file below 500 lines: target loading, shared staging, confirmation authority locking and
reversion authority are separate from their orchestration facades. The writer matrix invokes real dashboard/mobile/TPV/wizard/menu/
onboarding/demo adapters; POS and delivery retain focused real-adapter suites. `catalogPublicationIntegrationHarness.ts` owns only the exact
disposable guard, fixture lifecycle, independent pools and PostgreSQL wait-state observation.

- [x] Write RED publication preview tests for name, description, imageUrl, Product.type, tax fields, objetoImp, unit, compatible retail
      cost, incompatible prepared-dish cost, unchanged fields, locally diverged managed field, unrelated local field changes, and Recipe
      dependency changes.
- [x] A conflict line offers an explicit decision to preserve the local value as approved override or publish corporate value. It never
      overwrites drift by default. Store line-level before/after, fieldMask, hashVersion, target hash, actor and source revision; store each
      field's before/proposed/after, decision and override FK in CatalogPublicationFieldDecision. A mixed target uses line status APPLIED
      when any Product field changed and never collapses distinct field decisions into APPROVED_OVERRIDE.
- [x] Implement PREVIEWED→APPLYING→APPLIED with idempotent confirmation and a transaction that relocks/reloads access, CatalogItem, binding,
      Product, relevant rule/profile, and Recipe dependencies before writing. Stale/conflict returns 409 with zero partial writes.
- [x] Scope recovery by both `CatalogPublicationOperation` and idempotency key. Add RED/GREEN where the same key belongs to two operations;
      the static operation route must resolve the intended batch and reject unknown operations before the generic batch-id route.
- [x] Materialize only confirmed H1A managed fields. Leave `Product.price` for H1C; organization purchase cost may update `Product.cost`
      only for compatible retail Products. A normal managed-field publication never changes IDs, venue, category, active state,
      availability, inventory, recipe, modifiers, or POS metadata.
- [x] Add the explicit publication operation `CATALOG_PRODUCT_ACTIVATION`. Its preview targets one inactive, non-deleted bound Product and
      shows only `active:false → true`; it requires a current published managed revision/hash (or approved overrides), complete catalog,
      active binding, and READY venue validation/Recipe dependencies. Confirmation revalidates and activates atomically with audit/outbox.
      It never updates managed fields in the same hidden step. A stale/unpublished binding must first use the ordinary publication flow.
      This is the only H1 internal path allowed to bypass the legacy activation guard.
- [x] Write one transactional ActivityLog summary plus immutable line details and co-committed outbox hints. Emit only after commit; stable
      eventId/venueSequence makes retry convergent.
- [x] Implement the generic H1A outbox sweeper: PENDING lease/claim, external delivery outside the database transaction, bounded
      retry/backoff, DELIVERED/DEAD_LETTER, safe truncated error, stable `outbox.id` eventId, venueSequence, and dedupeKey. Socket/RabbitMQ
      failure never rolls back an APPLIED publication.
- [x] Implement generic batch watchdog under the same batch advisory lock. It CAS-fails only an expired APPLYING attempt with the same
      attemptId/lease. A live commit and watchdog cannot produce FAILED-after-commit or commit-after-FAILED.
- [x] Register start/stop/runNow/no-overlap job lifecycles without touching unrelated workers. Test emit-before-ack duplicate, worker race,
      venue ordering, dead letter, and crash recovery.
- [x] Implement inverse publication as a new preview/batch using stored before values. Disabling a gate or entitlement is not a data
      rollback. The new line records both supersedesLineId for Current/History and reversesLineId for the historical line whose before value
      it restores; both references are tenant-safe and defer deletion checks until commit.
- [x] Prove OFF/ADVISORY leave all legacy writers intact. Add the ENFORCED check only before a new or reactivated vendable Product for
      venues whose own governance state is ENFORCED; grandfathered Products remain usable.
- [x] Transitioning venue governance to ENFORCED writes `Venue.catalogGovernanceEnforcedAt` and `CatalogVenueRollout.governanceState`
      atomically. The scalar cutoff is write-once (`NULL → timestamp`, exact-value replay only), not merely increasing, so later Products
      can never become grandfathered by moving it forward. Runtime writers read it from the venue lookup they already perform; null executes
      the exact NEVER_ENABLED path without querying entitlement, OrganizationModule, rollout, or CatalogItem.
- [x] Route create/activate through `assertLegacyCatalogGovernance()` for dashboard CRUD, ProductWizard, menu import, mobile CRUD, TPV
      quick-add, POS sync, onboarding, MCP menu tools, chatbot product actions, and text-to-SQL product actions. Pass the authenticated
      actor through every controller/tool caller; never weaken the signature to optional actor. Delivery placeholder creation remains
      allowed because it is `active:false`, but its later activation is guarded. Demo/dev seeds operate only with the scalar null.
- [x] Use `assertLegacyCatalogGovernance()` only for legacy create/activate. It reads only the Venue scalar and cannot accept fabricated
      catalog provenance. Catalog binding/publication CREATE uses a separate internal path that validates item, profile, binding, and
      publication in the same transaction.
- [x] Thread authenticated `req.authContext.userId` through dashboard/mobile/TPV creators into nullable Product.createdById; onboarding
      passes its existing userId. POS sync, delivery, and demo use explicit SERVICE actors for ActivityLog and never invent a Staff ID.
- [x] Add an architecture test that inventories these writers and fails if a new runtime Product create/activation bypasses the helper.
      Every 422 `CATALOG_GOVERNANCE_REQUIRED` happens before Product mutation and is non-retryable.
- [x] Run the frozen unit/static GREEN gate (14 suites/154 tests); the expanded real-writer/legacy-envelope gate is also GREEN at 27
      suites/269 tests, with typecheck, build and the full 70-path lint/format scope clean:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogPublication.service.test.ts \
  tests/unit/services/master-catalog/catalogPublicationProjection.service.test.ts \
  tests/unit/services/master-catalog/catalogPublicationPreview.service.test.ts \
  tests/unit/services/master-catalog/catalogPublicationConfirmation.service.test.ts \
  tests/unit/services/master-catalog/catalogPublicationRecovery.service.test.ts \
  tests/unit/services/master-catalog/catalogPublicationOverrideDecision.service.test.ts \
  tests/unit/services/master-catalog/catalogPublicationActivation.service.test.ts \
  tests/unit/services/master-catalog/catalogPublicationReversion.service.test.ts \
  tests/unit/services/master-catalog/catalogGovernance.service.test.ts \
  tests/unit/services/master-catalog/catalogGovernanceFence.service.test.ts \
  tests/unit/services/master-catalog/catalogPublicationOutbox.service.test.ts \
  tests/unit/jobs/catalog-publication-outbox-sweeper.job.test.ts \
  tests/unit/jobs/catalog-publication-watchdog.job.test.ts \
  tests/unit/architecture/masterCatalogGovernedProductWriters.test.ts
```

- [ ] Execute the disposable PostgreSQL acceptance gate only after explicit DB authorization; this exact wrapper/spec set is PREPARED and
      was not run during Task 9:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
node .superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs \
  npx jest --no-watchman --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/catalogPublication.integration.test.ts \
  tests/integration/master-catalog/catalogPublicationConcurrency.integration.test.ts \
  tests/integration/master-catalog/catalogGovernance.integration.test.ts \
  tests/integration/master-catalog/catalogPublicationOutbox.integration.test.ts \
  tests/integration/master-catalog/h1a-delete-and-lifecycle.integration.test.ts \
  tests/integration/master-catalog/h1a-tenant-constraints.integration.test.ts
```

- [ ] Propose checkpoint `feat(h1a): publish managed catalog fields atomically`; pause for authorization. If authorized, stage exactly the
      Files list for this task plus the manifest, then commit.

## Task 10 — Expose organization HTTP routes and customer MCP through shared services

**Files**

- Create: `src/controllers/dashboard/masterCatalog.dashboard.controller.ts`
- Create: `src/schemas/dashboard/masterCatalog.schema.ts`
- Create: `src/routes/dashboard/masterCatalog.routes.ts`
- Create: `src/routes/dashboard/masterCatalogVenue.routes.ts`
- Modify: `src/routes/dashboard.routes.ts`
- Create: `src/controllers/superadmin/masterCatalog.superadmin.controller.ts`
- Create: `src/routes/superadmin/masterCatalog.routes.ts`
- Modify: `src/routes/superadmin.routes.ts`
- Modify: `src/services/superadmin/staff.superadmin.service.ts`
- Modify: `src/services/cleanup/liveDemoCleanup.service.ts`
- Modify: `tests/unit/services/superadmin/staffCapture.test.ts`
- Modify: `tests/unit/services/cleanup/liveDemoCleanup.service.test.ts`
- Modify: `src/mcp/scope.ts`
- Modify: `src/mcp/guard.ts`
- Create: `src/mcp/tools/masterCatalog.ts`
- Modify: `src/mcp/server.ts`
- Create: `tests/api-tests/master-catalog/masterCatalogCore.api.test.ts`
- Create: `tests/unit/mcp-customer/master-catalog-core.test.ts`

Approved Task 10 splits/evidence: `masterCatalogRead.service.ts`, `masterCatalogControlPlane.service.ts`, `staffDeletion.service.ts`,
`auditCatalogPermissionDefaults.ts`, real controller/auth API adapters, strict HTTP schema tests, and the Staff/live-demo deterministic
two-connection specs. The exact cross-repo permission mirror is `../avoqado-web-dashboard/src/lib/permissions/defaultPermissions.ts`; shared
Task 8/9 cap/idempotency/reversion authorities were extended only where the adapters required a missing reusable seam. See
`task-10-report.md` for the exhaustive path inventory.

- [x] Add thin controllers that parse Zod input, derive organization/actor from auth, call the shared services, and preserve
      `{success,data}` plus stable `{message,code,details}` errors. Controllers contain no Prisma calls.
- [x] Make `masterCatalog.schema.ts` the composed HTTP schema surface for item/binding/publication/venue-override commands while reusing
      Task 7's specialized multipart import schema; do not duplicate money, operation, decision, or confirm-token validation.
- [x] Mount organization routes under the exact surface in this plan and dedicated superadmin routes only under
      `/api/v1/superadmin/master-catalog`. Reject body/query attempts to change organization scope.
- [x] Register `GET /publications/by-idempotency-key/:operation/:idempotencyKey` before `GET /publications/:publicationBatchId`; validate
      operation against the closed operation enum and test same key across two operations plus unknown-operation rejection.
- [x] Mount the venue-scoped surface separately with the venue resolver and exact permission; do not add catalog provenance/overrides to
      legacy Product response shapes.
- [x] Expose catalog audit through the hardened existing organization activity-log service at `/audit` and `/audit/actions`. Scope query as
      an `AND` containing `OR [{organizationId: requestedOrganizationId}, {organizationId: null, venueId: {in:     organizationVenueIds}}]`;
      reuse the single Task 4 scope builder rather than rewriting it in the controller. Keep search in a separate `AND` group so it cannot
      overwrite tenant scope, support organizations with zero venues, and preserve `(createdAt desc, id desc)` pagination.
- [x] Add `catalog-venue:read` and `catalog-venue:request-override` to server permission authority. These expose only local change/request
      views and never grant organization import/publish.
- [x] Default venue-role grants are explicit: read for OWNER/ADMIN/MANAGER/VIEWER; request override for OWNER/ADMIN/MANAGER.
      VenueRolePermission custom overrides remain authoritative. Mirror these defaults exactly in dashboard and make
      `npm run audit:permissions` fail on drift.
- [x] Extend `McpScope` with active organization and OrgRole. H1 write tools require `mcp:write` unconditionally even when the legacy
      environment enforcement flag is off.
- [x] In H1 scope resolution recheck `Staff.active`, StaffOrganization `isActive=true` and `leftAt=null`, and StaffVenue `active=true`; add
      `orgRole` while retaining `activeOrg` for legacy tools. Preserve generic legacy guard behavior, but add `requireCatalogWriteScope()`
      that rejects missing scopes and arrays without `mcp:write` regardless of `MCP_ENFORCE_WRITE_SCOPE`.
- [x] Register catalog tools only after resolving the active organization with the organization catalog resolver. Never use
      `anyVenueHasModule`, because MASTER_CATALOG is ORGANIZATION_ONLY. Superadmin has no implicit content access. Confirm calls the
      transactional shared service and must not append a second best-effort `auditMcpWrite()` after commit.
- [x] Register the seven H1A MCP tools. Each call rechecks active membership, invokes the same access/preview/confirm/idempotency service as
      HTTP, and never duplicates audit logic.
- [x] Preserve immutable H1 actor provenance without breaking legacy deletion: Staff with no H1 references keeps the current hard-delete; a
      Staff referenced by classified ActivityLog or H1 aggregates follows one transactional deactivate/revoke-credentials/revoke-active-
      memberships/anonymize-PII path while retaining its ID. Live-demo cleanup asserts the disposable Staff has no H1 provenance before hard
      delete and reports a stable actionable conflict otherwise. Lock the Staff row before the provenance decision so a concurrent H1 audit
      cannot race the hard-delete; retain the FK/constraint catch as final defense and map it to the same stable conflict, never a raw
      CHECK/P2003. Add a two-connection test for both race orderings.
- [x] Write API/MCP RED then GREEN tests for all roles, revoked membership, impersonation, cross-tenant IDs, gate unknown/off,
      preview-confirm, idempotency, and no mutation without `mcp:write`.
- [x] Run:

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
- Create: `src/services/master-catalog/catalogExportContract.service.ts`
- Create: `src/services/master-catalog/catalogExportErrors.service.ts`
- Create: `src/services/master-catalog/catalogExportWorkbook.service.ts`
- Create: `src/controllers/dashboard/masterCatalogExport.dashboard.controller.ts`
- Create: `tests/unit/services/master-catalog/catalogExport.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogExportRecipe.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogExportCapacity.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogExportErrors.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogExportWorkbook.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogExportTestHarness.ts`
- Create: `tests/api-tests/master-catalog/catalogExport.api.test.ts`
- Modify: `src/controllers/dashboard/masterCatalog.dashboard.controller.ts`
- Modify: `src/routes/dashboard/masterCatalog.routes.ts`
- Modify: `src/services/master-catalog/catalogImportDependencySnapshot.service.ts`
- Modify: `src/services/master-catalog/catalogImportReadQueries.service.ts`
- Modify: `src/services/master-catalog/catalogImportRead.service.ts`
- Modify: `tests/unit/services/master-catalog/catalogImportRead.service.test.ts`

- [x] Build one versioned XLSX writer that emits `Metadata` with exact grain `(key,value)` and typed sheets for `catalog-master-v1.xlsx`,
      `catalog-by-business-type-v1.xlsx`, and `import-errors-v1.xlsx` using the exact approved columns and grains.
- [x] Write RED tests for text IDs/SKUs/codes with leading zero, Decimal(10,2), recipe cost scale 4, RFC3339 UTC, timezone metadata,
      null-as-empty, deterministic ordering, multiple business types, one-to-many data in separate sheets, and formula neutralization for
      `=`, `+`, `-`, and `@`.
- [x] Join PREPARED_DISH exports to local Recipe through bindings and report status without copying or mutating Recipe. Include actor/date
      and profile version.
- [x] Emit all CORPORATE_SKU lifecycle states, require an active root/leaf hierarchy, and leave `Regions`/`RegionalValues` typed but empty
      until H1C owns a region/rule authority. Do not infer fallback data.
- [x] Resolve profile metadata deterministically: master/template use every active organization profile; business export uses only active
      `operationalRole=null` profiles for null/requested business type; errors use the durable Task 7 snapshot. Emit baseline/profile
      `RequiredFields` without relaxing baseline grains or silently coalescing contradictions.
- [x] Preflight 5,000 tenant-scoped hydrated/output rows before full hydration; cap 12 sheets, 40 columns, 180,000 cells, 32,767 emitted
      text scalars, 8 MiB XML parts, 32 MiB aggregate XML and 16 MiB ZIP; yield every 128 rows and return actionable 413 errors. Share Task
      7's closed 20,000-profile snapshot authority instead of inventing a smaller export-only limit.
- [x] Mount the two export, template and durable error-workbook routes through the Task 10 production authorization/controller surface; test
      the real routes and parse their actual XLSX responses while mocking only DB/access leaves.
- [x] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --no-watchman --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogExport.service.test.ts \
  tests/unit/services/master-catalog/catalogExportRecipe.service.test.ts \
  tests/unit/services/master-catalog/catalogExportCapacity.service.test.ts \
  tests/unit/services/master-catalog/catalogExportErrors.service.test.ts \
  tests/unit/services/master-catalog/catalogExportWorkbook.service.test.ts \
  tests/unit/services/master-catalog/catalogImportRead.service.test.ts
npx jest --selectProjects=api-tests --no-watchman --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/catalogExport.api.test.ts
```

- [x] Checkpoint `feat(h1a): add versioned catalog exports` authorized and committed as `10266f49` with the exact production/test slice.

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
- Create: `avoqado-server/docs/xlsx/catalog-master-import-v1.md`
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

- [x] Document exact contracts, workbook columns, OrgRole matrix, entitlement/module separation, preview-confirm/idempotency, ENFORCED
      gates, inverse publication, operational metrics, alerts, rollback-by-disable, and the pending PITS acceptance blockers.
- [x] Update customer-facing material only with claims demonstrable by the acceptance scenarios; label regional identifiers/pricing as
      unavailable until H1B/H1C ship. Regenerate canonical PDFs from source with the folder README's Chrome command
      (`--no-pdf-header-footer` and `--virtual-time-budget=15000`), then verify page count/text extraction and rasterize every changed page
      for visual QC. Refork the PAX/Blumon variant from V2 without reintroducing NexGo or any non-Blumon processor. Record the
      owner/link/evidence for the required clickable web deck, which is not a Git artifact in this workspace.
- [x] Run the capacity check from workspace instructions. Even under load, run all mandatory module tests; serialize heavy builds and report
      longer duration rather than omitting verification.
- [x] Execute the exact server unit/API/integration matrix and final gates in the `Exact final verification commands` section below with an
      explicitly supplied disposable `H1_TEST_DATABASE_URL`; do not collapse it into an unscoped Jest invocation.

- [x] Execute dashboard and superadmin full targeted gates after confirming no other heavy build from this task is running. Compare all
      three legacy Product fixtures byte-for-byte.
- [x] On an isolated local database, prove: migration creates no catalog/grant rows; all gates are false; a non-PITS organization performs
      current Product/menu/inventory/recipe/order flows without H1 queries; PITS can run off-gated preview only after explicit test grant;
      disabling the test grant stops H1 mutation but leaves Product operational.
- [x] Do not assume server `develop` reaches staging: current Render staging deployment is suspended and Fly auto-deploy is disabled, while
      dashboard `develop` can still auto-deploy to demo. The runbook assigns an owner to reactivate/use an isolated manual backend
      environment, verifies it healthy with expand-only migration and gates OFF, and only then allows dashboard deployment. The first H1
      canary is never direct production.
- [x] Review every row 43/44/248 and enablers 46/191 against the observable acceptance table. Mark software-ready separately from
      contractual acceptance blocked by PITS layouts/field matrix.
- [x] Checkpoint `docs(h1a): document catalog core rollout` authorized by the user; stage exactly the Files list for this task plus the
      manifest and commit that message.

### Task 15 final localhost evidence — 2026-08-10

- Server pre-deploy: exit 0; 829 unit suites (10,083 pass / 14 skip), 24 API suites / 607 tests, 14 isolated migration tests, 46 pass / 3
  skip integration suites (389 pass / 52 skip), typecheck/build/assistant audit/DB consistency GREEN.
- Dashboard scoped H1A: 14 Vitest files / 71 tests and 6/6 Chromium Playwright tests GREEN on localhost.
- Superadmin: 121 files, 917 pass / 1 skip, check/build GREEN.
- Disposable PostgreSQL: 423 migrations current; replay cleanup GREEN; every `Catalog*` table returned to zero.
- Global status: **FAIL outside H1A** because seven legacy dashboard E2E regressions reproduce red in serial. The isolated H1A/Task 15
  checkpoint is ready; a global dashboard deploy is not.
- Full local transcript: `/tmp/full-testing-20260810-task15-final-ok-rTOVih/report.md`.

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
  tests/unit/services/master-catalog/catalogWorkbook.eventloop-budget.test.ts \
  tests/unit/workers/masterCatalogXlsx.worker.test.ts \
  tests/unit/workers/masterCatalogXlsxSecurity.worker.test.ts \
  tests/unit/architecture/masterCatalogWorkbookRuntimeBoundary.test.ts \
  tests/unit/schemas/dashboard/masterCatalogImport.schema.test.ts \
  tests/unit/scripts/generateMasterCatalogImportFixtures.test.ts \
  tests/unit/services/master-catalog/catalogImport.service.test.ts \
  tests/unit/services/master-catalog/catalogImportAuditSummary.service.test.ts \
  tests/unit/services/master-catalog/catalogImportBinding.service.test.ts \
  tests/unit/services/master-catalog/catalogImportCanonical.service.test.ts \
  tests/unit/services/master-catalog/catalogImportCapacity.service.test.ts \
  tests/unit/services/master-catalog/catalogImportCapacityIntegration.service.test.ts \
  tests/unit/services/master-catalog/catalogImportConfirmation.service.test.ts \
  tests/unit/services/master-catalog/catalogImportConfirmationConcurrency.service.test.ts \
  tests/unit/services/master-catalog/catalogImportDependencies.service.test.ts \
  tests/unit/services/master-catalog/catalogImportDependencySnapshot.service.test.ts \
  tests/unit/services/master-catalog/catalogImportDurableEventLoop.service.test.ts \
  tests/unit/services/master-catalog/catalogImportFieldValidation.service.test.ts \
  tests/unit/services/master-catalog/catalogImportItemRow.service.test.ts \
  tests/unit/services/master-catalog/catalogImportLookup.service.test.ts \
  tests/unit/services/master-catalog/catalogImportPreviewProjection.service.test.ts \
  tests/unit/services/master-catalog/catalogImportPreviewProjectionValidation.service.test.ts \
  tests/unit/services/master-catalog/catalogImportPreviewReferenceProjection.service.test.ts \
  tests/unit/services/master-catalog/catalogImportPreviewSkuProjection.service.test.ts \
  tests/unit/services/master-catalog/catalogImportRead.service.test.ts \
  tests/unit/services/master-catalog/catalogImportReadQueries.service.test.ts \
  tests/unit/services/master-catalog/catalogImportReadState.service.test.ts \
  tests/unit/services/master-catalog/catalogImportRecovery.service.test.ts \
  tests/unit/services/master-catalog/catalogImportReviewLines.service.test.ts \
  tests/unit/services/master-catalog/catalogImportStagedPayload.service.test.ts \
  tests/unit/services/master-catalog/catalogImportValidationMatrix.service.test.ts \
  tests/unit/services/master-catalog/catalogReferenceNormalization.service.test.ts \
  tests/unit/services/master-catalog/catalogValidationRuleJson.service.test.ts \
  tests/unit/services/master-catalog/catalogBinding.service.test.ts \
  tests/unit/services/master-catalog/catalogBindingConfirmation.service.test.ts \
  tests/unit/services/master-catalog/catalogBindingGuards.service.test.ts \
  tests/unit/services/master-catalog/catalogOverride.service.test.ts \
  tests/unit/services/master-catalog/catalogOverrideConcurrency.service.test.ts \
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

node .superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs \
  npx jest --no-watchman --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/h1a-migration.integration.test.ts \
  tests/integration/master-catalog/h1a-tenant-constraints.integration.test.ts \
  tests/integration/master-catalog/h1a-corporate-sku-trigger.integration.test.ts \
  tests/integration/master-catalog/preparedDishReadiness.integration.test.ts \
  tests/integration/master-catalog/catalogValidationProfile.integration.test.ts \
  tests/integration/master-catalog/catalogImport.integration.test.ts \
  tests/integration/master-catalog/catalogBinding.integration.test.ts \
  tests/integration/master-catalog/catalogPublication.integration.test.ts

npx prisma validate
npx prisma generate
npm run schema:map
npm run schema:map -- --check
npm run audit:permissions
npm run typecheck
npm run build
node .superpowers/sdd/2026-08-08-pits-h1a-catalog-core/run-with-h1-test-db.cjs npm run pre-deploy
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
