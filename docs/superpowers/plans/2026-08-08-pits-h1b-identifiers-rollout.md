# PITS H1B — Identifiers and Offline Rollout Implementation Plan

> **Required execution skill:** use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Apply
> `superpowers:test-driven-development` to every migration, identifier, tenant-isolation, writer-fence, cache, concurrency, and offline
> behavior change.

**Goal:** Let one PITS corporate SKU own multiple validated EAN/UPC/GTIN/internal codes, import them atomically from XLSX, project them
safely into each opted-in venue, and resolve them online/offline in Android, iOS, TPV, and Desktop—while every never-enabled venue and old
client continues using its current Product SKU/GTIN/barcode behavior without a checkout dependency on H1.

**Design:** [`2026-08-08-pits-h1-master-catalog-design.md`](../specs/2026-08-08-pits-h1-master-catalog-design.md)

**Depends on:** H1A CatalogItem/CORPORATE_SKU invariants, explicit organization access, atomic audit, CatalogVenueRollout, versioned
import/preview-confirm, idempotency, publication/outbox, dashboard organization shell, and superadmin readiness controls.

**Shared-workspace barrier:** begin H1B only after H1A's shared contracts and files are integrated and verified. H1C must not edit
`schema.prisma`, catalog services/types/routes/MCP, dashboard catalog files, manifest, handoff, or presentation concurrently with H1B.
Within H1B, subagents may work in parallel only on explicitly disjoint client repositories/files under one integration owner.

**Architecture:** `CatalogIdentifier` reserves corporate codes organization-wide, including retired codes. `ProductIdentifier` is the single
active lookup registry per venue and mirrors local `Product.sku`, local `Product.gtin`, and published corporate aliases without replacing
Product. The registry cutover is monotonic and fenced. Never-enabled writers pay only measured advisory-lock overhead on SKU/GTIN
create/update; reads, checkout, stock, price, and unrelated updates receive no new query or lock. Each client downloads a versioned delta
into an independent durable alias cache, keeps orphan aliases, and resolves them to a complete local Product; old caches and direct legacy
comparisons remain valid.

**Tech Stack:** TypeScript/Express, Prisma/PostgreSQL, Jest/Supertest, XLSX, customer MCP; React/Vite/Vitest/Playwright; Android
Kotlin/Room/Retrofit/Compose; iOS Swift/GRDB; TPV Kotlin/Room/Retrofit/Compose; Desktop Kotlin Multiplatform/JVM serialization.

## Global constraints

- Follow every H1A global constraint and update the existing `avoqado-server/docs/PITS-H1-CHANGE-MANIFEST.md` before and after each task.
- Shared worktrees are dirty and concurrent. Reread live files, edit named blocks only, and never revert unrelated work. No Git mutation
  occurs without a new explicit user authorization.
- Android and iOS visible behavior ships together. Android, iOS, TPV, and Desktop must all be capable and observed before aliases can be
  enabled for a PITS venue.
- Backend deploys first with identifiers gate false, no ProductIdentifier rows, no backfill, and
  `Venue.productIdentifierRegistryRequired = false` for every venue.
- `registryRequired` and `productIdentifiersBootstrappedAt` are monotonic operational fields on Venue. Entitlement/module pause never turns
  them off and never disables existing lookup, synchronization, uniqueness, or client deltas.
- NEVER_ENABLED means the registry bit is false. The helper performs the exact legacy validation and write, with no
  CatalogIdentifier/ProductIdentifier/rollout/entitlement lookup. Only the measured shared advisory-lock fence is new.
- PAUSED_AFTER_IDENTIFIERS means administration is paused but registry lookup/delta/synchronization and deterministic 409 uniqueness
  continue for safety.
- Product SKU and GTIN remain venue-local fields. Corporate SKU and aliases project only into ProductIdentifier; no publication overwrites
  legacy Product.sku or Product.gtin.
- All Product create and SKU/GTIN updates enter one transaction helper. No runtime writer, raw SQL, sync, import, delivery, onboarding, or
  quick-add bypass is allowed.
- Product hard-delete paths are inventoried too. A registry-enabled Product is not hard-deleted by menu replace or wizard rollback because
  that would destroy stable tombstones; explicit venue deletion may cascade the entire tenant-scoped registry.
- Lock namespace and order are fixed: Product writer shared(org)→shared(venue); bootstrap shared(org)→exclusive(venue); corporate identifier
  mutation/publication exclusive(org)→exclusive(venue IDs sorted). Reads never take these locks.
- Before backend deploy, a comparative benchmark with 50 concurrent writers across 10 venues must show incremental p95 ≤ 5 ms, p99 ≤ 20 ms,
  and throughput degradation ≤ 5%. Failure blocks deploy, not merely rollout.
- Normalization version 1 is NFKC + peripheral trim + locale-neutral uppercase. Preserve internal spaces, hyphens, and leading zeroes. GS1
  codes are digits only with exact length/checksum.
- Normalization applies only to ProductIdentifier aliases/mirrors in a registry snapshot. When no authoritative snapshot exists, every
  client keeps its exact legacy direct comparison semantics.
- XLSX code cells must be text; numeric cells are rejected because leading zeroes may be lost. Any row error means zero
  CatalogIdentifier/ProductIdentifier writes and only staging remains.
- A corporate ACTIVE or RETIRED code is reserved and never reused for another CatalogItem. A retired local code may be reused by creating a
  new stable identifierId and tombstoning the old row.
- Active uniqueness is enforced by a partial unique index on `(venueId, normalizedCode)`. Runtime lookup never uses ambiguous `findFirst`
  across Product and identifier tables.
- Delta pagination is fixed at one `toRevision` and ordered by `(revision, identifierId)`. Page size max is 500. A future revision/cursor
  mismatch is an explicit non-destructive error.
- Once `registryRequired=true`, a 200 full delta—including an empty one—is authoritative. While the bit is false, the endpoint returns
  404/not-ready so clients retain exact legacy matching. Timeout, 5xx, decode failure, or unknown normalization version preserves aliases
  and revision. Product and alias refreshes are independent.
- An alias received before its Product is stored by identifierId, advances revision after complete paging, remains excluded from lookup, and
  becomes resolvable when Product later arrives.
- All client migrations are additive/non-destructive. Old serialized caches decode; new caches do not change Product ID, scalar price, or
  operational fields.
- `CODE_ALREADY_ASSIGNED` (409) and `CATALOG_GOVERNANCE_REQUIRED` (422) are non-retryable and actionable in every writer UI. Checkout and
  grandfathered Product usage never receive this gate.
- Ordering, Mesas, Kiosk, payment, inventory, serialized inventory, and historical Product DTOs retain their existing contracts. Only
  scanners that already resolve sellable products gain the optional alias source.
- Every touched logical block gets a concise why-comment; binary/generated schema files are recorded in the manifest with their generation
  source and reason.

## Exact contract and file map

### Server files to create

- `prisma/migrations/20260808130000_add_product_identifier_registry/migration.sql`
- `src/services/master-catalog/catalogIdentifier.service.ts`
- `src/services/master-catalog/productIdentifierRegistry.service.ts`
- `src/services/master-catalog/identifierBootstrap.service.ts`
- `src/services/master-catalog/productIdentifierDelta.service.ts`
- `src/services/master-catalog/catalogClientReadiness.service.ts`
- `src/controllers/dashboard/productIdentifier.dashboard.controller.ts`
- `src/controllers/mobile/productIdentifier.mobile.controller.ts`
- `src/controllers/tpv/productIdentifier.tpv.controller.ts`
- `src/routes/dashboard/productIdentifier.routes.ts`
- `src/schemas/productIdentifier.schema.ts`
- `scripts/benchmark-product-identifier-fence.ts`
- `tests/unit/architecture/productIdentifierWriters.test.ts`

### Server files to modify

- `prisma/schema.prisma`
- `scripts/generate-schema-map.ts`
- `docs/SCHEMA_MAP.md`
- `src/types/master-catalog.ts`
- `src/services/master-catalog/identifierNormalization.service.ts`
- `src/services/master-catalog/catalogItem.service.ts`
- `src/services/master-catalog/catalogImport.service.ts`
- `src/services/master-catalog/catalogPublication.service.ts`
- `src/services/master-catalog/catalogExport.service.ts`
- `src/services/dashboard/product.dashboard.service.ts`
- `src/controllers/dashboard/product.dashboard.controller.ts`
- `src/services/dashboard/productWizard.service.ts`
- `src/controllers/dashboard/inventory/productWizard.controller.ts`
- `src/services/dashboard/menu.dashboard.service.ts`
- `src/services/dashboard/chatbot-actions/definitions/product-crud.actions.ts`
- `src/services/dashboard/text-to-sql-assistant.service.ts`
- `src/controllers/mobile/product.mobile.controller.ts`
- `src/services/pos-sync/posSyncOrderItem.service.ts`
- `src/services/delivery-channels/core/deliveryOrderIngestion.service.ts`
- `src/services/mobile/areaTicketV7.mobile.service.ts`
- `src/services/onboarding/venueCreation.service.ts`
- `src/services/onboarding/demoSeed.service.ts`
- `src/services/onboarding/demoCleanup.service.ts`
- `src/services/cleanup/liveDemoCleanup.service.ts`
- `src/services/dashboard/venue.dashboard.service.ts`
- `src/routes/tpv.routes.ts`
- `src/routes/dashboard.routes.ts`
- `src/routes/mobile.routes.ts`
- `src/controllers/dashboard/masterCatalog.dashboard.controller.ts`
- `src/routes/dashboard/masterCatalog.routes.ts`
- `src/controllers/superadmin/masterCatalog.superadmin.controller.ts`
- `src/routes/superadmin/masterCatalog.routes.ts`
- `src/mcp/tools/masterCatalog.ts`
- `src/mcp/tools/menu.ts`
- `src/mcp/server.ts`
- `src/lib/permissions.ts`
- `prisma/seed.ts`
- `scripts/seed-la-ribera-demo.ts`
- `scripts/seed-avoqado-fitness-demo.ts`
- `scripts/seed-demo-venues.ts`
- `scripts/test-inventory-fixes.ts`
- `CHANGELOG.md`

Development/setup writers in `prisma/seed.ts`, `scripts/seed-la-ribera-demo.ts`, `scripts/seed-avoqado-fitness-demo.ts`,
`scripts/seed-demo-venues.ts`, and `scripts/test-inventory-fixes.ts` remain explicitly limited to venues with registryRequired false; the
architecture inventory documents them and production code cannot import their bypass.

### Dashboard files

- Modify: `avoqado-web-dashboard/src/features/master-catalog/types.ts`
- Modify: `avoqado-web-dashboard/src/features/master-catalog/api.ts`
- Modify: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/MasterCatalogLayout.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogIdentifiersPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogIdentifierImportPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/IdentifierEditor.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/IdentifierCollisionTable.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/IdentifierImportPreview.tsx`
- Create: `avoqado-web-dashboard/src/features/master-catalog/device-capability.ts`
- Modify: `avoqado-web-dashboard/src/pages/Menu/Products/createProduct.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Menu/Products/productId.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Inventory/components/ProductWizardDialog.tsx`
- Modify: `avoqado-web-dashboard/src/components/menu/MenuImportDialog.tsx`
- Modify: `avoqado-web-dashboard/src/locales/es/organization.json`
- Modify: `avoqado-web-dashboard/src/locales/en/organization.json`
- Modify: `avoqado-web-dashboard/src/locales/fr/organization.json`
- Modify: `avoqado-web-dashboard/CHANGELOG.md`

### Android files

- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/data/ProductsRepository.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/data/model/Product.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/local/database/ProductIdentifierEntity.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/local/database/ProductIdentifierSyncStateEntity.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/local/database/ProductIdentifierDao.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/data/model/ProductIdentifierModels.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/data/ProductIdentifierRepository.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/local/database/AvoqadoDatabase.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/local/database/AvoqadoDatabaseMigrations.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/core/di/DatabaseModule.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/network/DeviceHeadersInterceptor.kt`
- Generated: `avoqado-android/app/schemas/com.avoqado.pos.core.data.local.database.AvoqadoDatabase/9.json`
- Modify: `avoqado-android/app/src/androidTest/java/com/avoqado/pos/core/data/local/database/AvoqadoDatabaseMigrationTest.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/presentation/cart/CartViewModel.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/articles/data/ArticlesRepository.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/articles/presentation/ArticlesViewModel.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/articles/presentation/products/ProductDetailView.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/presentation/product/CreateProductView.kt`

Execution must verify the live Android database package/version before editing; the names above are the current mapped owners, not
permission to overwrite concurrent migration work.

### iOS files

- Modify: `avoqado-ios/avoqado-ios/POS/Services/ProductsRepository.swift`
- Modify: `avoqado-ios/avoqado-ios/POS/Models/CartModels.swift`
- Modify: `avoqado-ios/avoqado-ios/Services/Database/DatabaseManager.swift`
- Modify: `avoqado-ios/avoqado-ios/Services/Database/LocalProductStore.swift`
- Create: `avoqado-ios/avoqado-ios/POS/Models/ProductIdentifierModels.swift`
- Create: `avoqado-ios/avoqado-ios/Services/Database/LocalProductIdentifierStore.swift`
- Modify: `avoqado-ios/avoqado-ios/POS/ViewModels/CartViewModel.swift`
- Modify: `avoqado-ios/avoqado-ios/Articles/Services/ArticlesRepository.swift`
- Modify: `avoqado-ios/avoqado-ios/Articles/ViewModels/ArticlesViewModel.swift`
- Modify: `avoqado-ios/avoqado-ios/Articles/Views/ProductDetailView.swift`
- Modify: `avoqado-ios/avoqado-ios/POS/Views/CreateProductView.swift`
- Modify: `avoqado-ios/avoqado-ios/Services/DeviceHeaders.swift`

`ProductRecord` currently lives inside `Services/Database/LocalProductStore.swift`; extend it in place and do not create a second
persistence model.

### TPV files

- Create: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/local/entities/ProductIdentifierEntity.kt`
- Create: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/local/entities/ProductIdentifierSyncStateEntity.kt`
- Create: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/local/dao/ProductIdentifierDao.kt`
- Create: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/ordering/data/dto/ProductIdentifierDeltaDto.kt`
- Create: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/ordering/data/repository/ProductIdentifierRepository.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/local/AvoqadoDatabase.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/di/DatabaseModule.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/network/ApiService.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/network/interceptors/AuthInterceptor.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/local/dao/ProductDao.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/ordering/data/repository/ProductRepositoryImpl.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/ordering/domain/ProductRepository.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/ordering/presentation/menu/MenuViewModel.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/checkout/presentation/CheckoutViewModel.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/presentation/viewmodels/HomeViewModel.kt`
- Generated: `avoqado-tpv/app/schemas/com.jaac.avoqado_tpv.core.data.local.AvoqadoDatabase/30.json`
- Modify: `avoqado-tpv/app/src/androidTest/java/com/jaac/avoqado_tpv/core/data/local/AvoqadoDatabaseMigrationTest.kt`
- Modify: `avoqado-tpv/CHANGELOG.md`

### Desktop files

- Create: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/core/model/ProductIdentifierModels.kt`
- Create: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/core/sync/ProductCodeResolver.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/core/api/AvoqadoApi.kt`
- Modify: `avoqado-desktop/shared/src/jvmMain/kotlin/com/avoqado/pos/core/api/HttpAvoqadoApi.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/core/sync/CatalogCache.kt`
- Modify: `avoqado-desktop/shared/src/jvmMain/kotlin/com/avoqado/pos/core/sync/CatalogCache.jvm.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/ui/checkout/CheckoutState.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/ui/checkout/CheckoutScreen.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/ui/catalogo/CatalogoProductHandlers.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/ui/shell/MainShell.kt`
- Create: `avoqado-desktop/CHANGELOG.md`

### Exact additive wire contract

All three server namespaces expose the same payload:

```text
GET /api/v1/dashboard/venues/:venueId/product-identifiers
GET /api/v1/mobile/venues/:venueId/product-identifiers
GET /api/v1/tpv/venues/:venueId/product-identifiers
```

Query: `afterRevision` (non-negative integer), opaque `cursor`, `pageSize` 1..500.

```ts
export interface ProductIdentifierDeltaV1 {
  venueId: string
  fromRevision: number
  toRevision: number
  normalizationVersion: 1
  items: Array<{
    identifierId: string
    productId: string
    code: string
    normalizedCode: string
    format: 'SKU' | 'EAN13' | 'EAN8' | 'UPCA' | 'GTIN14' | 'INTERNAL'
    active: boolean
    revision: number
  }>
  nextCursor: string | null
}
```

The service entry points are:

```ts
export function normalizeIdentifierV1(input: { code: string; format: IdentifierFormat }): {
  code: string
  normalizedCode: string
  normalizationVersion: 1
}

export async function executeProductCodeWrite<T>(input: {
  tx: Prisma.TransactionClient
  organizationId: string
  venueId: string
  actor: CatalogActor
  previous: { productId?: string; sku: string | null; gtin: string | null }
  next: { sku: string | null; gtin: string | null }
  legacyWrite: () => Promise<T>
}): Promise<T>

export async function preflightIdentifierBootstrap(context: CatalogCommandContext, venueId: string): Promise<IdentifierBootstrapPreview>

export async function confirmIdentifierBootstrap(
  context: CatalogCommandContext,
  input: CatalogConfirmInput & { venueId: string },
): Promise<IdentifierBootstrapResult>

export async function getProductIdentifierDelta(input: {
  venueId: string
  afterRevision: number
  cursor: string | null
  pageSize: number
}): Promise<ProductIdentifierDeltaV1>
```

Organization identifier administration extends the H1A base at `/api/v1/dashboard/organizations/:orgId/master-catalog`:

```text
GET    /items/:catalogItemId/identifiers
POST   /items/:catalogItemId/identifiers
POST   /items/:catalogItemId/identifiers/:catalogIdentifierId/retire
GET    /venues/:venueId/identifier-rollout
POST   /venues/:venueId/identifier-registry/preflight
POST   /venues/:venueId/identifier-registry/bootstrap
POST   /venues/:venueId/client-readiness-overrides/preview
POST   /venues/:venueId/client-readiness-overrides/:overrideBatchId/confirm
GET    /exports/associated-identifiers.xlsx
```

Dedicated superadmin control-plane routes extend `/api/v1/superadmin/master-catalog`:

```text
POST /organizations/:organizationId/venues/:venueId/identifier-client-requirements/preview
POST /organizations/:organizationId/venues/:venueId/identifier-client-requirements/:batchId/confirm
POST /organizations/:organizationId/venues/:venueId/identifier-alias-publication/preview
POST /organizations/:organizationId/venues/:venueId/identifier-alias-publication/:batchId/confirm
```

Only active, non-impersonated superadmin can set required/N/A families, minimum versions, staleness, or advance/pause alias publication.
Organization OWNER can only create an expiring readiness override through the organization routes, with reason and transactional
ActivityLog.

The CORPORATE_SKU projection is returned read-only and has no independent mutation route. Identifier imports and publications reuse the H1A
`/imports/*` and `/publications/*` preview-confirm surfaces.

## Verification and checkpoint convention

Every task observes focused RED, implements one responsibility, runs focused and touched-module GREEN, updates the change manifest, and
proposes a Git checkpoint. Execution pauses before staging or committing. If the user authorizes a checkpoint, stage only the task's exact
files; otherwise record the verified unstaged state and continue.

## Task 1 — Freeze legacy scanner behavior and cross-client normalization vectors

**Files**

- Create: `avoqado-server/tests/contracts/master-catalog/product-identifiers-v1.json`
- Modify: `avoqado-server/tests/contracts/master-catalog/identifier-normalization-v1.json` created by H1A
- Create: `avoqado-server/tests/unit/contracts/productIdentifier.contract.test.ts`
- Create: `avoqado-android/app/src/test/java/com/avoqado/pos/pos/presentation/cart/CartViewModelBarcodeIdentifierTest.kt`
- Create: `avoqado-ios/avoqado-iosTests/ProductIdentifierNormalizationTests.swift`
- Create: `avoqado-tpv/app/src/test/java/com/jaac/avoqado_tpv/features/ordering/data/repository/ProductRepositoryImplIdentifierTest.kt`
- Create: `avoqado-desktop/shared/src/commonTest/kotlin/com/avoqado/pos/ProductCodeResolverTest.kt`

- [ ] Capture the exact current direct-match semantics per client: Android SKU/barcode/GTIN order and case behavior, iOS `findByBarcode`,
      TPV local/network barcode behavior, and Desktop case-insensitive SKU/GTIN/barcode comparison. These are distinct legacy branches and
      must not be homogenized when no authoritative identifier snapshot exists.
- [ ] Create shared golden vectors for NFKC, peripheral whitespace, locale-neutral case, internal space/hyphen preservation, leading zeroes,
      EAN8/EAN13/UPCA/GTIN14 checksum validity, numeric XLSX rejection, tombstone, and unknown normalization version.
- [ ] Freeze the exact server delta envelope, optional cursor, empty authoritative response, and errors. Use the same fixture from
      TypeScript, Kotlin, Swift, and Desktop tests.
- [ ] Run each baseline test GREEN before implementation and record commands/results in the H1 manifest.
- [ ] Run the exact baseline commands serially:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/contracts/productIdentifier.contract.test.ts
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-android
./gradlew :app:testDebugUnitTest --tests '*CartViewModelBarcodeIdentifierTest*'
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-ios
xcodebuild test -scheme avoqado-ios \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -only-testing:avoqado-iosTests/ProductIdentifierNormalizationTests
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv
./gradlew :app:testSandboxDebugUnitTest --tests '*ProductRepositoryImplIdentifierTest*'
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-desktop
JAVA_HOME="/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home" \
  ./gradlew :shared:jvmTest --tests '*ProductCodeResolverTest*'
```

- [ ] Propose checkpoint `test(h1b): freeze identifier contracts`; pause before any Git action.

## Task 2 — Add the expand-only operational identifier schema

**Files**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260808130000_add_product_identifier_registry/migration.sql`
- Modify: `scripts/generate-schema-map.ts`
- Modify/generated: `docs/SCHEMA_MAP.md`
- Create: `tests/integration/master-catalog/identifierRegistryMigration.integration.test.ts`
- Create: `tests/integration/master-catalog/identifierRegistryConstraints.integration.test.ts`

- [ ] Write RED migration tests with duplicate legacy SKU/GTIN values, cross-field collisions, nulls, active/inactive Products, and Products
      linked to current operational graphs. The migration must succeed, preserve all legacy data, create zero registry/observation rows, and
      leave every Venue bit false/null.
- [ ] Add `Venue.productIdentifierRegistryRequired Boolean @default(false)` and `Venue.productIdentifiersBootstrappedAt DateTime?`; both are
      written only by fenced bootstrap and never revert.
- [ ] Extend CatalogIdentifier from H1A with EAN13/EAN8/UPCA/GTIN14/INTERNAL, original/normalized code, ACTIVE/RETIRED reservation, actor,
      and organization-wide unique normalizedCode including retired rows.
- [ ] Add ProductIdentifier with stable ID, composite tenant keys, independent `mirrorsSku` and `mirrorsGtin`, nullable catalogIdentifierId,
      active tombstones, monotonic revision, actor, and timestamps. Add the raw-SQL partial unique active `(venueId, normalizedCode)` index.
- [ ] Extend H1A's CatalogVenueRollout with registry/alias states and identifierRevision. Reuse and extend H1A CatalogClientObservation,
      CatalogVenueClientRequirement, and readiness override models with identifier capabilities, required/N/A family, minimum version, max
      staleness, and expiring OWNER audit fields; do not create duplicate readiness tables.
- [ ] Add SQL-direct RED tests for cross-tenant identifiers, duplicate active code, legal retired local reuse with new identifierId, illegal
      corporate retired reuse, monotonic revision, and invalid mirror provenance.
- [ ] Run:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx prisma validate
npx prisma generate
npm run schema:map
npm run schema:map -- --check
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/identifierRegistryMigration.integration.test.ts \
  tests/integration/master-catalog/identifierRegistryConstraints.integration.test.ts
```

- [ ] Propose checkpoint `feat(h1b): add identifier registry schema`; pause before staging. If authorized, stage only the six task paths and
      manifest.

## Task 3 — Implement canonical normalization and corporate identifier commands

**Files**

- Modify: `src/services/master-catalog/identifierNormalization.service.ts`
- Create: `src/services/master-catalog/catalogIdentifier.service.ts`
- Modify: `src/services/master-catalog/catalogItem.service.ts`
- Modify: `tests/unit/services/master-catalog/identifierNormalization.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogIdentifier.service.test.ts`
- Modify: `tests/integration/master-catalog/h1a-corporate-sku-trigger.integration.test.ts`

- [ ] Observe RED against every shared golden vector. Reject null/blank, unsupported format, non-digit GS1, incorrect length/checksum, and
      data outside documented limits. Preserve the original display code independently from normalizedCode.
- [ ] Preserve H1A's corporate-SKU vectors byte-for-byte and extend `normalizeIdentifierV1()` only with EAN8/EAN13/UPCA/GTIN14/INTERNAL
      validation/checksums; never renormalize existing H1A rows.
- [ ] Implement create/retire commands under exclusive organization then sorted venue locks. A corporate code remains reserved after
      retirement. No independent endpoint may edit the CORPORATE_SKU projection.
- [ ] Changing `CatalogItem.sku` continues through the H1A transaction that updates CatalogItem and exactly-one CORPORATE_SKU projection,
      now using the shared normalizer and all H1B locks.
- [ ] Return deterministic 409 `CODE_ALREADY_ASSIGNED` with safe details and zero writes. Do not disclose another tenant's
      Product/CatalogItem ID.
- [ ] Run focused GREEN and build:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/identifierNormalization.service.test.ts \
  tests/unit/services/master-catalog/catalogIdentifier.service.test.ts
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/h1a-corporate-sku-trigger.integration.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1b): validate and reserve corporate identifiers`; pause before Git action.

## Task 4 — Fence and synchronize every Product SKU/GTIN writer

**Files**

- Create: `src/services/master-catalog/productIdentifierRegistry.service.ts`
- Modify: `src/services/dashboard/product.dashboard.service.ts`
- Modify: `src/controllers/dashboard/product.dashboard.controller.ts`
- Modify: `src/services/dashboard/productWizard.service.ts`
- Modify: `src/controllers/dashboard/inventory/productWizard.controller.ts`
- Modify: `src/services/dashboard/menu.dashboard.service.ts`
- Modify: `src/services/dashboard/chatbot-actions/definitions/product-crud.actions.ts`
- Modify: `src/services/dashboard/text-to-sql-assistant.service.ts`
- Modify: `src/controllers/mobile/product.mobile.controller.ts`
- Modify: `src/routes/tpv.routes.ts`
- Modify: `src/services/pos-sync/posSyncOrderItem.service.ts`
- Modify: `src/services/delivery-channels/core/deliveryOrderIngestion.service.ts`
- Modify: `src/services/onboarding/venueCreation.service.ts`
- Modify: `src/services/onboarding/demoSeed.service.ts`
- Modify: `src/services/onboarding/demoCleanup.service.ts`
- Modify: `src/services/cleanup/liveDemoCleanup.service.ts`
- Modify: `src/services/dashboard/venue.dashboard.service.ts`
- Modify: `src/mcp/tools/menu.ts`
- Modify: `prisma/seed.ts`
- Modify: `scripts/seed-la-ribera-demo.ts`
- Modify: `scripts/seed-avoqado-fitness-demo.ts`
- Modify: `scripts/seed-demo-venues.ts`
- Modify: `scripts/test-inventory-fixes.ts`
- Create: `tests/unit/services/master-catalog/productIdentifierRegistry.service.test.ts`
- Create: `tests/integration/master-catalog/productIdentifierWriterFence.integration.test.ts`
- Create: `tests/unit/architecture/productIdentifierWriters.test.ts`
- Create: `scripts/benchmark-product-identifier-fence.ts`

- [ ] Generate and commit-to-test an inventory of every `product.create`, `product.update`, `product.upsert`, `product.delete`,
      `product.deleteMany`, and SQL writer touching SKU/GTIN. Explicitly cover dashboard CRUD/quick-add, ProductWizard, menu import, mobile
      CRUD, TPV direct quick-add, POS sync, delivery placeholder, onboarding, demo seed, and development setup scripts.
- [ ] Write RED NEVER_ENABLED tests proving exact old validation/status/envelope and zero queries to CatalogIdentifier, ProductIdentifier,
      CatalogVenueRollout, entitlement, or modules. Only advisory lock calls may appear.
- [ ] Write RED registryRequired tests proving Product and mirrors update in one transaction; SKU↔GTIN/corporate collision returns 409
      before Product mutation; zero/null changes are preserved; retiring one mirror retains a row that still has the other/corporate
      provenance.
- [ ] Implement the shared(org)→shared(venue) fence and reread the Venue bit under the lock. The caller performs its existing legacy write
      inside the callback; only the true path reserves/syncs identifiers using the same transaction client.
- [ ] Expose only `executeProductCodeWrite()`. Keep lock, bit reread, legacy callback, true-path validation, Product result, and mirror
      synchronization in that single public helper so a caller cannot perform the Product mutation and forget the registry update.
- [ ] Move TPV quick-add out of direct route-level Prisma into the shared service path without changing its request/response envelope.
      Delivery ingestion must use its existing order transaction; production bypass is forbidden.
- [ ] Architecture test rejects any new unapproved runtime SKU/GTIN writer. Development seeds may run only after asserting registryRequired
      false and cannot be imported by runtime services.
- [ ] Preserve menu REPLACE hard-delete exactly while registryRequired is false. When true, retire local mirrors into tombstones and
      deactivate Products instead of hard-deleting them; return actionable per-row conflicts if replacement cannot preserve
      bindings/aliases. Refactor wizard Step 1 so create and rollback share one transaction rather than deleting a registered Product.
- [ ] Demo/setup cleanup asserts registryRequired false. Explicit Venue deletion may cascade all ProductIdentifier rows with the venue and
      is tested separately. Alias lookup requires Product `active=true` and `deletedAt=null`; aliases remain stored while inactive/deleted
      and become resolvable when the same Product is reactivated.
- [ ] Benchmark old vs new NEVER_ENABLED path with 50 concurrent writers across 10 venues; report p50/p95/p99/throughput and assert
      thresholds. Instrument and assert zero new read/checkout/stock/ price queries or locks.
- [ ] Run focused suites, `npm run build`, and the benchmark against an isolated local database. Benchmark failure blocks moving to Task 5.
- [ ] Run the exact gate:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/productIdentifierRegistry.service.test.ts \
  tests/unit/architecture/productIdentifierWriters.test.ts
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/productIdentifierWriterFence.integration.test.ts
H1_TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx tsx scripts/benchmark-product-identifier-fence.ts --writers 50 --venues 10
npm run build
```

- [ ] Propose checkpoint `feat(h1b): fence product identifier writers`; pause before Git action.

## Task 5 — Preflight, bootstrap, readiness, and canary state machine

**Files**

- Create: `src/services/master-catalog/identifierBootstrap.service.ts`
- Create: `src/services/master-catalog/catalogClientReadiness.service.ts`
- Create: `tests/unit/services/master-catalog/identifierBootstrap.service.test.ts`
- Create: `tests/unit/services/master-catalog/catalogClientReadiness.service.test.ts`
- Create: `tests/integration/master-catalog/identifierBootstrapRace.integration.test.ts`
- Create: `tests/api-tests/master-catalog/identifierReadiness.api.test.ts`
- Create: `tests/api-tests/superadmin/masterCatalogIdentifierReadiness.api.test.ts`
- Modify: `src/controllers/dashboard/masterCatalog.dashboard.controller.ts`
- Modify: `src/routes/dashboard/masterCatalog.routes.ts`
- Modify: `src/controllers/superadmin/masterCatalog.superadmin.controller.ts`
- Modify: `src/routes/superadmin/masterCatalog.routes.ts`

- [ ] Write RED preflight tests for SKU↔GTIN, normalization/case, corporate reservation, duplicate Product, and existing tombstone
      collisions. Preflight is read-only except batch/readiness staging and produces an actionable resolution report.
- [ ] Use a concurrency barrier to prove a writer before bootstrap finishes before the scan and is included; a later writer waits for the
      exclusive venue fence and synchronizes after cutover.
- [ ] Confirm takes shared(org)→exclusive(venue), revalidates preview/revisions, rescans Products, creates mirrors, advances revisions, and
      atomically changes false→true plus timestamp and registry READY. Any collision rolls back all rows and keeps bit false.
- [ ] Bootstrap confirm requires the H1A `CatalogConfirmInput` idempotency key under operation IDENTIFIER_BOOTSTRAP. Same key/hash returns
      the persisted result; key/hash mismatch is 409; concurrent or timeout-after-commit callers recover by GET and never rerun the
      scan/write.
- [ ] Implement readiness for DASHBOARD/ANDROID/IOS/TPV/DESKTOP with required/N/A, minimum version, default 30-day staleness, and unknown
      capability fail-closed. OWNER override requires reason, expiration, and transactional ActivityLog.
- [ ] Implement the exact organization OWNER override and dedicated superadmin requirement/alias-state routes above through preview-confirm,
      idempotency, active principal recheck, and transactional ActivityLog. Test every role, impersonation, expiry/revocation, illegal state
      transition, and no-op replay; no rollout step requires direct SQL.
- [ ] Add capability transport only to the new delta requests. Android/iOS extend existing device/platform/app-version headers; TPV adds
      opaque terminal/device plus app version/capabilities; Desktop passes device serial and AppVersion through MainShell/API; dashboard
      persists one opaque browser UUID. Server derives family from namespace plus allowlist, validates version/capabilities, stores
      best-effort observation, and never treats client-supplied family as authorization.
- [ ] Alias publication requires registry READY, all required clients ready or valid override, and aliasPublicationState ENABLED. Governance
      ENFORCED remains a separate state.
- [ ] Refuse transition to governance ENFORCED until registry/readiness proves every required client understands identifier v1 and
      governance 422 errors. This blocks only the transition, never existing Product/checkout behavior.
- [ ] Prove no operation can return registryRequired to false and pause/grant-off preserves lookup, delta, mirror sync, and uniqueness.
- [ ] Add concurrency RED/GREEN for two bootstrap confirms and timeout-after-commit recovery by `(operation,idempotencyKey)`.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/identifierBootstrap.service.test.ts \
  tests/unit/services/master-catalog/catalogClientReadiness.service.test.ts
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/identifierReadiness.api.test.ts \
  tests/api-tests/superadmin/masterCatalogIdentifierReadiness.api.test.ts
test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/identifierBootstrapRace.integration.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1b): add fenced identifier rollout`; pause before Git.

## Task 6 — Serve one stable delta through dashboard, mobile, and TPV

**Files**

- Create: `src/services/master-catalog/productIdentifierDelta.service.ts`
- Create: `src/controllers/dashboard/productIdentifier.dashboard.controller.ts`
- Create: `src/controllers/mobile/productIdentifier.mobile.controller.ts`
- Create: `src/controllers/tpv/productIdentifier.tpv.controller.ts`
- Create: `src/routes/dashboard/productIdentifier.routes.ts`
- Create: `src/schemas/productIdentifier.schema.ts`
- Modify: `src/routes/dashboard.routes.ts`, `src/routes/mobile.routes.ts`, `src/routes/tpv.routes.ts`
- Create: `tests/unit/services/master-catalog/productIdentifierDelta.service.test.ts`
- Create: `tests/api-tests/master-catalog/productIdentifiers.api.test.ts`

- [ ] Write RED pagination tests with equal revisions at page boundaries, tombstones, zero rows, alias reuse, cursor tampering, future
      revision, fixed toRevision, pageSize 1/500/501, and tenant mismatch.
- [ ] Implement one service/serializer used by all three thin controllers. Order and cursor on `(revision, identifierId)`; every page keeps
      the first page's toRevision so concurrent writes appear only in the next refresh.
- [ ] Authenticate by the namespace's current venue rules and registry bit, not by active catalog entitlement. A paused-after-rollout venue
      keeps reading. Never-enabled returns 404/not-ready, equivalent to an older server, so clients preserve alias cache and remain in the
      exact legacy branch. A 200 empty delta is authoritative only after registryRequired is true.
- [ ] When registryRequired is true, update CatalogClientObservation from trusted request headers: family comes from the authenticated
      namespace/client allowlist, device ID is opaque, app version is validated, and capabilities include `product-identifiers-v1` plus
      governance-error support. Never trust a body-supplied family/readiness claim. Dashboard generates one opaque browser device ID;
      Android/iOS reuse their existing device/platform/version headers; TPV/Desktop add the missing stable/version headers without logging
      them.
- [ ] Route `/mobile/venues/:venueId/scans/resolve` through the same unambiguous registry resolver only when the Venue bit is true. In false
      mode preserve Area Ticket v7's existing trim, Product-SKU/GTIN candidate lookup, and AMBIGUOUS response exactly.
- [ ] Preserve the exact shared `{success:true,data:...}` envelope. Add contract tests proving old Product list/barcode endpoints are
      byte-compatible and only delegate lookup to ProductIdentifier when registryRequired is true.
- [ ] Run focused tests, all three route suites, and build:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/productIdentifierDelta.service.test.ts
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/productIdentifiers.api.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1b): expose additive identifier deltas`; pause before Git.

## Task 7 — Import, publish, export, and MCP identifiers through the H1A spine

**Files**

- Modify: `src/services/master-catalog/catalogImport.service.ts`
- Modify: `src/services/master-catalog/catalogPublication.service.ts`
- Modify: `src/services/master-catalog/catalogExport.service.ts`
- Modify: `src/mcp/tools/masterCatalog.ts`
- Modify: `src/mcp/server.ts`
- Modify: `tests/unit/services/master-catalog/catalogImport.service.test.ts`
- Modify: `tests/unit/services/master-catalog/catalogPublication.service.test.ts`
- Modify: `tests/unit/services/master-catalog/catalogExport.service.test.ts`
- Create: `tests/api-tests/master-catalog/identifierImport.api.test.ts`
- Create: `tests/unit/mcp-customer/master-catalog-identifiers.test.ts`
- Create: `tests/fixtures/master-catalog/associated-identifiers-v1-valid.xlsx`
- Create: `tests/fixtures/master-catalog/associated-identifiers-v1-errors.xlsx`

- [ ] Extend H1A staging with the exact identifiers sheets/columns. Write RED for numeric code cell, formula, checksum, duplicate within
      file, existing organization reservation, local Product collision in any target venue, retired code, unknown SKU, stale catalog
      revision, and one valid zero-leading code.
- [ ] Any row error produces only staging and `import-errors-v1.xlsx`; confirm remains disabled and creates zero
      CatalogIdentifier/ProductIdentifier rows. Corrected confirm uses one idempotent H1A command and all required exclusive locks.
- [ ] Publication checks venue readiness and aliases ENABLED before materializing; partial target failure rolls back the complete command.
      Outbox remains at-least-once and only hints clients to refresh.
- [ ] Generate `associated-identifiers-v1.xlsx` with text codes, deterministic order, Metadata, corporate identifiers, venue projection,
      tombstones/status, actor/date, and formula neutralization.
- [ ] Extend MCP structured/file preview and confirm through the same service. Require `mcp:write` unconditionally and no body-inferred
      binding. No separate MCP writer is allowed.
- [ ] Run API/MCP/import/export tests:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/services/master-catalog/catalogImport.service.test.ts \
  tests/unit/services/master-catalog/catalogPublication.service.test.ts \
  tests/unit/services/master-catalog/catalogExport.service.test.ts \
  tests/unit/mcp-customer/master-catalog-identifiers.test.ts
npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/identifierImport.api.test.ts
npm run build
```

- [ ] Propose checkpoint `feat(h1b): add atomic identifier import and publication`; pause before Git.

## Task 8 — Add dashboard identifier governance and conflict UX

**Files**

- Modify: `avoqado-web-dashboard/src/features/master-catalog/types.ts`
- Modify: `avoqado-web-dashboard/src/features/master-catalog/api.ts`
- Modify: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/MasterCatalogLayout.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogIdentifiersPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/CatalogIdentifierImportPage.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/IdentifierEditor.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/IdentifierCollisionTable.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/components/IdentifierImportPreview.tsx`
- Create: `avoqado-web-dashboard/src/features/master-catalog/device-capability.ts`
- Modify: `avoqado-web-dashboard/src/pages/Menu/Products/createProduct.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Menu/Products/productId.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Inventory/components/ProductWizardDialog.tsx`
- Modify: `avoqado-web-dashboard/src/components/menu/MenuImportDialog.tsx`
- Modify: `avoqado-web-dashboard/src/locales/es/organization.json`
- Modify: `avoqado-web-dashboard/src/locales/en/organization.json`
- Modify: `avoqado-web-dashboard/src/locales/fr/organization.json`
- Modify: `avoqado-web-dashboard/CHANGELOG.md`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/__tests__/CatalogIdentifiersPage.test.tsx`
- Create: `avoqado-web-dashboard/src/pages/Organization/MasterCatalog/__tests__/CatalogIdentifierImportPage.test.tsx`
- Create: `avoqado-web-dashboard/e2e/tests/master-catalog/catalog-identifiers.spec.ts`

- [ ] Use the H1A single gated organization entry. Add Codes and identifier import only when the server reports
      identifiersEnabled/readiness; do not create a second organization feature shell.
- [ ] Write RED UI tests for multiple codes per corporate SKU, format/status, checksum error, organization/local collision, retired
      reservation, numeric-cell error download, stale preview, idempotency recovery, one final confirmation, and no mutation for VIEWER.
- [ ] Show preflight/bootstrap/readiness states and collision resolution without exposing a control that flips the monotonic Venue bit
      outside the confirmed bootstrap command.
- [ ] Update Product create/edit/wizard/menu import 409/422 handling: actionable corporate catalog route, row-specific error for import, and
      zero automatic retry. Preserve all other legacy paths.
- [ ] Add equivalent es/en/fr copy, accessible table/editor/import flow, and change log.
- [ ] Run focused Vitest, i18n lint, lint, build, and Playwright:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard
npm run test:run -- \
  src/features/master-catalog \
  src/pages/Organization/MasterCatalog/__tests__/CatalogIdentifiersPage.test.tsx \
  src/pages/Organization/MasterCatalog/__tests__/CatalogIdentifierImportPage.test.tsx
npm run lint:i18n
npm run lint
npm run build
npm run test:e2e -- e2e/tests/master-catalog/catalog-identifiers.spec.ts
```

- [ ] Propose checkpoint `feat(h1b): add identifier governance dashboard`; pause before Git.

## Task 9 — Add Android durable identifier delta and scanner resolution

**Files**

- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/data/ProductsRepository.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/data/model/Product.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/local/database/ProductIdentifierEntity.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/local/database/ProductIdentifierSyncStateEntity.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/local/database/ProductIdentifierDao.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/data/model/ProductIdentifierModels.kt`
- Create: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/data/ProductIdentifierRepository.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/local/database/AvoqadoDatabase.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/local/database/AvoqadoDatabaseMigrations.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/core/di/DatabaseModule.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/core/data/network/DeviceHeadersInterceptor.kt`
- Generated: `avoqado-android/app/schemas/com.avoqado.pos.core.data.local.database.AvoqadoDatabase/9.json`
- Modify: `avoqado-android/app/src/androidTest/java/com/avoqado/pos/core/data/local/database/AvoqadoDatabaseMigrationTest.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/presentation/cart/CartViewModel.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/articles/data/ArticlesRepository.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/articles/presentation/ArticlesViewModel.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/articles/presentation/products/ProductDetailView.kt`
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/pos/presentation/product/CreateProductView.kt`
- Create: `app/src/test/java/com/avoqado/pos/pos/data/ProductIdentifierNormalizationTest.kt`
- Create: `app/src/test/java/com/avoqado/pos/pos/data/ProductIdentifierRepositoryTest.kt`
- Create: `app/src/test/java/com/avoqado/pos/pos/data/ProductsRepositoryIdentifierCacheTest.kt`
- Modify: `app/src/test/java/com/avoqado/pos/pos/presentation/cart/CartViewModelBarcodeIdentifierTest.kt`
- Create: `app/src/test/java/com/avoqado/pos/articles/presentation/ArticlesViewModelCatalogErrorsTest.kt`
- Create: `app/src/androidTest/java/com/avoqado/pos/core/data/local/database/ProductIdentifierMigrationTest.kt`

- [ ] First inspect live Room version/migrations and allocate the next unused version; never reuse a number from concurrent WIP. Add
      identifier and sync-state entities without changing Product cache payload semantics.
- [ ] If Android Room remains version 8, generate schema `9.json` and extend the existing migration chain test with MIGRATION_8_9. If
      concurrent WIP has claimed 9, use the next live version and update every referenced path in the manifest before editing.
- [ ] Write migration RED then GREEN: old database/cached payload opens; Products, price, SKU, barcode/GTIN and unrelated tables remain;
      empty identifier tables/revision appear.
- [ ] Implement Retrofit DTO/envelope and fixed-toRevision paging. Apply all pages in one Room transaction by identifierId, including
      tombstones/orphans; advance sync state only after a complete successful 200 sequence.
- [ ] ProductsRepository refreshes Product first, then aliases. Alias 404/timeout/5xx/decode/unknown version preserves previous alias
      rows/revision. Authoritative empty delta can retire rows.
- [ ] Cart scanner uses v1 normalization only against an authoritative alias cache and returns a full cached Product. Otherwise run the
      frozen legacy branch exactly. Cold start offline must work.
- [ ] Map write 409/422 to typed actionable UI without retry in Articles, Product detail, POS create, and unknown-barcode flow. Do not gate
      existing Android cash drawer or other mobile features.
- [ ] Run focused unit tests, migration instrumentation compile/test, and `assembleDebug` after the machine-capacity check:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-android
./gradlew :app:testDebugUnitTest \
  --tests '*ProductIdentifier*' --tests '*CartViewModel*' --tests '*Articles*'
./gradlew :app:compileDebugAndroidTestKotlin :app:assembleDebugAndroidTest
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.avoqado.pos.core.data.local.database.ProductIdentifierMigrationTest
./gradlew :app:compileDebugKotlin
```

- [ ] Propose checkpoint `feat(h1b): add Android identifier cache`; pause before Git.

## Task 10 — Add iOS GRDB identifier cache and preserve Product round-trip

**Files**

- Modify: `avoqado-ios/avoqado-ios/POS/Services/ProductsRepository.swift`
- Modify: `avoqado-ios/avoqado-ios/POS/Models/CartModels.swift`
- Modify: `avoqado-ios/avoqado-ios/Services/Database/DatabaseManager.swift`
- Modify: `avoqado-ios/avoqado-ios/Services/Database/LocalProductStore.swift`
- Create: `avoqado-ios/avoqado-ios/POS/Models/ProductIdentifierModels.swift`
- Create: `avoqado-ios/avoqado-ios/Services/Database/LocalProductIdentifierStore.swift`
- Modify: `avoqado-ios/avoqado-ios/POS/ViewModels/CartViewModel.swift`
- Modify: `avoqado-ios/avoqado-ios/Articles/Services/ArticlesRepository.swift`
- Modify: `avoqado-ios/avoqado-ios/Articles/ViewModels/ArticlesViewModel.swift`
- Modify: `avoqado-ios/avoqado-ios/Articles/Views/ProductDetailView.swift`
- Modify: `avoqado-ios/avoqado-ios/POS/Views/CreateProductView.swift`
- Modify: `avoqado-ios/avoqado-ios/Services/DeviceHeaders.swift`
- Modify: `avoqado-ios/avoqado-iosTests/ProductIdentifierNormalizationTests.swift`
- Create: `avoqado-ios/avoqado-iosTests/ProductsRepositoryIdentifierCacheTests.swift`
- Create: `avoqado-ios/avoqado-iosTests/LocalProductStoreRoundTripTests.swift`
- Create: `avoqado-ios/avoqado-iosTests/DatabaseMigrationProductIdentifierTests.swift`
- Create: `avoqado-ios/avoqado-iosTests/ProductWriteCatalogErrorTests.swift`

- [ ] Write RED for the existing offline round-trip gap: Product encode/persistence must retain barcode and GTIN as well as SKU, price, and
      ID. Fix it additively before alias resolution.
- [ ] Inspect the live migrator and allocate the next unused version. Add product barcode/gtin columns if absent, ProductIdentifier, and
      sync-state tables; preserve every old row and price.
- [ ] Implement the same golden normalization/delta semantics as Android. Apply a complete page set in one GRDB write; keep aliases/revision
      on 404/network/decode/unknown version and keep orphans.
- [ ] `findByBarcode` returns a complete Product from local stores. Use v1 only for aliases and the frozen legacy comparison when no
      authoritative snapshot exists. Prove cold restart offline.
- [ ] Map write 409/422 to actionable no-retry messages in Articles, Product detail, create, and unknown barcode. Do not change existing iOS
      cash drawer or Product price handling.
- [ ] Run focused xcodebuild test then build as prescribed by the iOS repo, serialized after Android heavy build:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-ios
xcodebuild test -scheme avoqado-ios \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -only-testing:avoqado-iosTests/ProductIdentifierNormalizationTests \
  -only-testing:avoqado-iosTests/ProductsRepositoryIdentifierCacheTests \
  -only-testing:avoqado-iosTests/LocalProductStoreRoundTripTests \
  -only-testing:avoqado-iosTests/DatabaseMigrationProductIdentifierTests \
  -only-testing:avoqado-iosTests/ProductWriteCatalogErrorTests
xcodebuild -scheme avoqado-ios \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' build
```

- [ ] Propose checkpoint `feat(h1b): add iOS identifier cache`; pause before Git.

## Task 11 — Add TPV Room registry and one shared scanner resolver

**Files**

- Create: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/local/entities/ProductIdentifierEntity.kt`
- Create: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/local/entities/ProductIdentifierSyncStateEntity.kt`
- Create: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/local/dao/ProductIdentifierDao.kt`
- Create: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/ordering/data/dto/ProductIdentifierDeltaDto.kt`
- Create: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/ordering/data/repository/ProductIdentifierRepository.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/local/AvoqadoDatabase.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/di/DatabaseModule.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/network/ApiService.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/network/interceptors/AuthInterceptor.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/data/local/dao/ProductDao.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/ordering/data/repository/ProductRepositoryImpl.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/ordering/domain/ProductRepository.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/ordering/presentation/menu/MenuViewModel.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/checkout/presentation/CheckoutViewModel.kt`
- Modify: `avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/core/presentation/viewmodels/HomeViewModel.kt`
- Generated: `avoqado-tpv/app/schemas/com.jaac.avoqado_tpv.core.data.local.AvoqadoDatabase/30.json`
- Modify: `avoqado-tpv/app/src/androidTest/java/com/jaac/avoqado_tpv/core/data/local/AvoqadoDatabaseMigrationTest.kt`
- Modify: `avoqado-tpv/CHANGELOG.md`
- Create: `avoqado-tpv/app/src/test/java/com/jaac/avoqado_tpv/core/data/local/ProductIdentifierDaoTest.kt`
- Create: `avoqado-tpv/app/src/test/java/com/jaac/avoqado_tpv/features/ordering/data/repository/ProductIdentifierRepositoryTest.kt`
- Modify: `avoqado-tpv/app/src/test/java/com/jaac/avoqado_tpv/features/ordering/data/repository/ProductRepositoryImplIdentifierTest.kt`
- Create: `avoqado-tpv/app/src/test/java/com/jaac/avoqado_tpv/features/ordering/presentation/menu/MenuViewModelTest.kt`
- Modify: `avoqado-tpv/app/src/test/java/com/jaac/avoqado_tpv/features/checkout/presentation/CheckoutViewModelTest.kt`
- Create: `avoqado-tpv/app/src/test/java/com/jaac/avoqado_tpv/features/tables/data/api/TablesApiServiceContractTest.kt`

- [ ] Allocate Room migration 29→30 only if 30 is still unused when execution starts; otherwise use the next live version and schema JSON.
      Never use destructive fallback.
- [ ] Extend the existing AvoqadoDatabaseMigrationTest with the direct migration and full chain; generate the matching Room schema JSON
      rather than hand-editing it.
- [ ] DAO resolves alias→complete ProductEntity with one transaction/join; returning only productId is not success. Delta apply retains
      orphans/tombstones and advances sync state only after all pages.
- [ ] ProductRepositoryImpl becomes local-first: frozen exact local SKU legacy match, then v1 alias only when authoritative snapshot exists,
      then existing network fallback. MenuViewModel and CheckoutViewModel already converge on this repository and must not implement
      separate logic.
- [ ] Home/Menu refresh applies Product and alias caches independently. Alias refresh failure keeps last good aliases; Product refresh may
      still succeed.
- [ ] Decode 409/422 into sealed no-retry Product write failures and show actionable quick-add copy. Kiosk, ProductDto, scalar price,
      Ordering, Mesas MenuCatalogDto/MenuProduct, tables, payment, and serialized inventory remain unchanged; contract tests enforce each
      graph.
- [ ] Run:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv
./gradlew :app:testSandboxDebugUnitTest \
  --tests '*ProductIdentifier*' \
  --tests '*MenuViewModel*' \
  --tests '*CheckoutViewModel*' \
  --tests '*TablesApiServiceContractTest*'
./gradlew :app:compileSandboxDebugAndroidTestKotlin :app:assembleSandboxDebugAndroidTest
./gradlew :app:connectedSandboxDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.jaac.avoqado_tpv.core.data.local.AvoqadoDatabaseMigrationTest
./gradlew :app:compileSandboxDebugKotlin
```

- [ ] Generate/verify the Room schema, update CHANGELOG, run ADB cold-start/offline/scanner checks on the 360×640 terminal if connected, and
      ensure no identifier/code is logged. Propose checkpoint `feat(h1b): add TPV identifier cache`; pause before Git.

## Task 12 — Add Desktop versioned cache and alias resolver

**Files**

- Create: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/core/model/ProductIdentifierModels.kt`
- Create: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/core/sync/ProductCodeResolver.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/core/api/AvoqadoApi.kt`
- Modify: `avoqado-desktop/shared/src/jvmMain/kotlin/com/avoqado/pos/core/api/HttpAvoqadoApi.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/core/sync/CatalogCache.kt`
- Modify: `avoqado-desktop/shared/src/jvmMain/kotlin/com/avoqado/pos/core/sync/CatalogCache.jvm.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/ui/checkout/CheckoutState.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/ui/checkout/CheckoutScreen.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/ui/catalogo/CatalogoProductHandlers.kt`
- Modify: `avoqado-desktop/shared/src/commonMain/kotlin/com/avoqado/pos/ui/shell/MainShell.kt`
- Create: `avoqado-desktop/CHANGELOG.md`
- Modify: `avoqado-desktop/shared/src/jvmTest/kotlin/com/avoqado/pos/FileCatalogCacheTest.kt`
- Create: `avoqado-desktop/shared/src/commonTest/kotlin/com/avoqado/pos/ProductIdentifierSerializationTest.kt`
- Modify: `avoqado-desktop/shared/src/commonTest/kotlin/com/avoqado/pos/ProductCodeResolverTest.kt`
- Modify: `avoqado-desktop/shared/src/jvmTest/kotlin/com/avoqado/pos/CheckoutFlowUiTest.kt`
- Modify: `avoqado-desktop/shared/src/commonTest/kotlin/com/avoqado/pos/CatalogoProductHandlersTest.kt`
- Modify: `avoqado-desktop/shared/src/jvmTest/kotlin/com/avoqado/pos/CatalogoSerializationTest.kt`

- [ ] Keep existing Product cache methods and `catalog-<venue>.json` byte-compatible as `List<Product>`. Add independent
      `loadIdentifierState`/`saveIdentifierState` methods backed by `catalog-identifiers-<venue>.json`, containing identifiers, revision,
      and normalization version. A legacy installation with no identifier file starts in the frozen direct-match path.
- [ ] Add AvoqadoApi/JVM fixed-toRevision paging. CheckoutState stores Product success even when alias download fails, and preserves old
      aliases on 404/network/decode/unknown version.
- [ ] ProductCodeResolver uses the shared golden normalization only for aliases and resolves to a complete Product. CheckoutScreen keeps the
      exact old ignoreCase SKU/GTIN/barcode branch when no authoritative snapshot exists.
- [ ] Persist orphan aliases and activate resolution after a later Product refresh, including a process restart. Tombstone removes only
      alias lookup after a successful delta.
- [ ] Decode catalog 409/422 in CatalogoProductHandlers as actionable no-retry errors; keep all other create/edit flows unchanged.
- [ ] Run with the repo-required JDK 17:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-desktop
JAVA_HOME="/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home" \
  ./gradlew :shared:jvmTest --tests '*ProductIdentifier*' \
  --tests '*FileCatalogCacheTest*' --tests '*CatalogoProductHandlersTest*'
JAVA_HOME="/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home" \
  ./gradlew :shared:jvmTest
JAVA_HOME="/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home" \
  ./gradlew :desktopApp:compileKotlin
```

- [ ] If the module task differs, discover it with `./gradlew tasks` and record the exact replacement in the manifest. Propose checkpoint
      `feat(h1b): add Desktop identifier cache`; pause before Git.

## Task 13 — Cross-client compatibility, documentation, and staged rollout

**Files**

- Modify: `docs/PITS-H1-CHANGE-MANIFEST.md`
- Modify: `docs/superpowers/specs/2026-08-08-pits-h1-master-catalog-design.md` only for verified implementation notes that do not alter the
  approved product decision
- Modify: `docs/superpowers/plans/2026-08-08-pits-h1b-identifiers-rollout.md`
- Create: `docs/PITS-H1B-IDENTIFIER-ROLLOUT.md`
- Create: `docs/api/product-identifiers-v1.md`
- Create: `docs/xlsx/associated-identifiers-v1.md`
- Modify: `docs/mcp/master-catalog-h1a.md`
- Modify: `docs/PITS-HANDOFF-SESION-2026-08-07.md`
- Modify: `docs/PITS-HANDOFF-SESION-2026-08-08.md` created by H1A
- Modify: `docs/PITS-HANDOFF.md`
- Modify: `docs/PITS-INVENTARIO-MATRIZ.md`
- Modify: `docs/PITS-PROGRAMA-COMPLETO.md`
- Modify: `docs/DEMO-PITS-2026-08-BITACORA.md`
- Modify: `avoqado-server/CHANGELOG.md`
- Modify: `avoqado-web-dashboard/CHANGELOG.md`
- Modify: `avoqado-android/CHANGELOG.md`
- Modify: `avoqado-tpv/CHANGELOG.md`
- Create: `avoqado-ios/CHANGELOG.md`
- Create: `avoqado-desktop/CHANGELOG.md`
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

- [ ] Run every language against the same wire and normalization fixtures. Prove leading zero, NFKC, tombstone, orphan-before-Product,
      unknown version, 200 empty, and failure-preserves-cache outcomes match.
- [ ] Run server migration/schema-map/build/permission/MCP suites, writer architecture test, fence benchmark, all three route contracts, and
      the full master-catalog identifier suites. Run each client's focused/full module verification serially according to capacity rules.
- [ ] Execute one compatibility matrix: old server+new client, new server+old client, new server+new client with NEVER_ENABLED,
      registryRequired with no aliases, READY aliases, PAUSED_AFTER_IDENTIFIERS, offline restart, duplicate socket hint, and withdrawn
      alias.
- [ ] Deployment order is fixed: expand migration/no backfill → backend gates false → hidden dashboard → capable releases for
      Android+iOS+TPV+Desktop → observations/readiness → PITS preflight and human collision resolution → one venue fenced bootstrap → alias
      ENABLED canary → venue-by-venue.
- [ ] Current server `develop` does not automatically deploy a staging backend, while dashboard develop may deploy demo. Use/reactivate an
      explicitly owned isolated backend first; verify healthy H1A/H1B migrations, benchmark, and gates OFF before any dashboard/client
      canary. Never make the first registry bootstrap directly in production.
- [ ] Verify current non-PITS venues perform Product CRUD, scan, checkout, inventory, recipes, tables, kiosk, and offline restart without
      catalog queries or behavior changes beyond measured writer fence.
- [ ] Update presentation claims only after the four-client canary is observable. Contractual row 71 remains blocked until PITS
      supplies/approves the actual XLSX layout and volume. Use the README's Chrome flags, run PDF text/page/raster QC, refork the
      PAX/Blumon-only deck without other processors, and record the owner/link/evidence for the separately shared clickable web deck.
- [ ] Execute every command in `Exact final verification commands` below, in listed order; the Android, iOS, TPV, and Desktop heavy gates
      run serially after each capacity check.
- [ ] Propose checkpoint `docs(h1b): document identifier rollout`; pause before any Git action.

## Exact final verification commands

Set `H1_TEST_DATABASE_URL` explicitly to a disposable H1 database. Integration and benchmark code must reject an empty value or production
fallback.

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server

npx jest --selectProjects=unit --runInBand --runTestsByPath \
  tests/unit/contracts/productIdentifier.contract.test.ts \
  tests/unit/services/master-catalog/identifierNormalization.service.test.ts \
  tests/unit/services/master-catalog/catalogIdentifier.service.test.ts \
  tests/unit/services/master-catalog/productIdentifierRegistry.service.test.ts \
  tests/unit/services/master-catalog/identifierBootstrap.service.test.ts \
  tests/unit/services/master-catalog/catalogClientReadiness.service.test.ts \
  tests/unit/services/master-catalog/productIdentifierDelta.service.test.ts \
  tests/unit/mcp-customer/master-catalog-identifiers.test.ts \
  tests/unit/architecture/productIdentifierWriters.test.ts

npx jest --selectProjects=api-tests --runInBand --runTestsByPath \
  tests/api-tests/master-catalog/productIdentifiers.api.test.ts \
  tests/api-tests/master-catalog/identifierImport.api.test.ts \
  tests/api-tests/master-catalog/identifierReadiness.api.test.ts \
  tests/api-tests/superadmin/masterCatalogIdentifierReadiness.api.test.ts

test -n "$H1_TEST_DATABASE_URL"
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx jest --selectProjects=integration --runInBand --runTestsByPath \
  tests/integration/master-catalog/identifierRegistryMigration.integration.test.ts \
  tests/integration/master-catalog/identifierRegistryConstraints.integration.test.ts \
  tests/integration/master-catalog/productIdentifierWriterFence.integration.test.ts \
  tests/integration/master-catalog/identifierBootstrapRace.integration.test.ts \
  tests/integration/master-catalog/h1a-corporate-sku-trigger.integration.test.ts

npx prisma validate
npx prisma generate
npm run schema:map
npm run schema:map -- --check
npm run audit:permissions
npm run typecheck
npm run build
H1_TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" \
  npx tsx scripts/benchmark-product-identifier-fence.ts --writers 50 --venues 10
TEST_DATABASE_URL="$H1_TEST_DATABASE_URL" npm run pre-deploy
```

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard
npm run test:run -- \
  src/features/master-catalog \
  src/pages/Organization/MasterCatalog/__tests__/CatalogIdentifiersPage.test.tsx \
  src/pages/Organization/MasterCatalog/__tests__/CatalogIdentifierImportPage.test.tsx
npm run lint:i18n
npm run lint
npm run build
npm run test:e2e -- e2e/tests/master-catalog/catalog-identifiers.spec.ts
npm run pre-deploy -- --skip-e2e
```

Run the four client gates serially; perform the workspace capacity check before each heavy build:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-android
./gradlew :app:testDebugUnitTest \
  --tests '*ProductIdentifier*' --tests '*CartViewModel*' --tests '*Articles*'
./gradlew :app:compileDebugAndroidTestKotlin :app:assembleDebugAndroidTest
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.avoqado.pos.core.data.local.database.ProductIdentifierMigrationTest
./gradlew :app:compileDebugKotlin
```

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-ios
xcodebuild test -scheme avoqado-ios \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -only-testing:avoqado-iosTests/ProductIdentifierNormalizationTests \
  -only-testing:avoqado-iosTests/ProductsRepositoryIdentifierCacheTests \
  -only-testing:avoqado-iosTests/LocalProductStoreRoundTripTests \
  -only-testing:avoqado-iosTests/DatabaseMigrationProductIdentifierTests \
  -only-testing:avoqado-iosTests/ProductWriteCatalogErrorTests
xcodebuild -scheme avoqado-ios \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' build
```

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv
./gradlew :app:testSandboxDebugUnitTest \
  --tests '*ProductIdentifier*' \
  --tests '*MenuViewModel*' \
  --tests '*CheckoutViewModel*' \
  --tests '*TablesApiServiceContractTest*'
./gradlew :app:compileSandboxDebugAndroidTestKotlin :app:assembleSandboxDebugAndroidTest
./gradlew :app:connectedSandboxDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.jaac.avoqado_tpv.core.data.local.AvoqadoDatabaseMigrationTest
./gradlew :app:compileSandboxDebugKotlin
```

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-desktop
JAVA_HOME="/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home" \
  ./gradlew :shared:jvmTest --tests '*ProductIdentifier*' \
  --tests '*FileCatalogCacheTest*' --tests '*CatalogoProductHandlersTest*'
JAVA_HOME="/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home" \
  ./gradlew :shared:jvmTest
JAVA_HOME="/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home" \
  ./gradlew :desktopApp:compileKotlin
```

## H1B completion gate

H1B is technically complete when registry migration is expand-only, every writer is fenced, NEVER_ENABLED benchmark meets all thresholds,
bootstrap race tests are deterministic, three server namespaces share one delta contract, all four clients preserve old caches and direct
matching while supporting durable aliases, and the canary can pause administration without disabling published lookup. H1B is not
commercially accepted until PITS's identifier policy/layout is archived and the one-venue canary passes online and offline on every required
client family.
