# PITS Legacy Compatibility Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that organizations and venues which have never enabled Master Catalog preserve their current Product, checkout, stock,
pricing, order and API behavior, and quantify the incremental cost of the existing Venue chronology fence before any additional PITS
capability is built.

**Architecture:** This tranche changes no production behavior and creates no schema. It adds runtime and static regression contracts around
the existing `catalogGovernanceEnforcedAt = NULL` fast path, then runs an isolated PostgreSQL benchmark comparing the same legacy Product
write with and without the production governance call. A checked-in report records query isolation and p50/p95/p99/throughput so later H1B
or H1C work cannot reinterpret “default off” as “the UI is hidden but every request still pays the catalog cost.”

**Tech Stack:** TypeScript 5, Jest, TypeScript compiler API, Prisma, PostgreSQL 16, Node `perf_hooks`, existing
`scripts/run-with-h1-test-db.cjs` disposable-database wrapper.

## Global Constraints

- This plan implements only section 4 and the legacy portion of section 9 of
  `docs/superpowers/specs/2026-08-10-pits-confirmed-foundations-design.md`.
- Do not add or edit Prisma models, migrations, API fields, permissions, tier mapping, module configuration or dashboard behavior.
- Reuse the existing Master Catalog entitlement/module/activation boundary. Nothing in this tranche may enable it for any organization or
  venue.
- `catalogGovernanceEnforcedAt = NULL` is the authoritative `NEVER_ENABLED` state.
- `NEVER_ENABLED` must not query `CatalogItem`, `CatalogIdentifier`, `CatalogVenueBinding`, `CatalogVenueRollout`, `OrganizationModule`,
  `OrganizationEntitlement` or validation-profile tables.
- Existing Product request and response envelopes, status codes, Prisma query shapes and venue-scoped SKU semantics remain unchanged.
- Benchmark 50 concurrent writers distributed deterministically across 10 venues.
- Candidate minus baseline must be p95 <= 5 ms and p99 <= 20 ms; candidate throughput must be at least 95% of baseline.
- The benchmark may run only when `DATABASE_URL`, `TEST_DATABASE_URL` and `H1_TEST_DATABASE_URL` resolve to local
  `/avoqado_h1a_test_20260808`; never connect it to production, staging or a shared development database.
- Measurements must record Node, CPU count, PostgreSQL version, warmup count, sample count, raw p50/p95/p99 and throughput. A failed
  threshold remains a failed result; do not widen the threshold or omit the run.
- Test and production identifiers/comments are English. Only user-facing error text is Spanish.
- No `git add .`, `git add -A`, stash, reset or branch switch. Stage explicit paths only and wait for founder approval before each commit.

---

## File Structure

### New files

- `tests/unit/architecture/masterCatalogNeverEnabledIsolation.test.ts` — AST inventory of the exact legacy read/write surfaces and banned
  catalog authority references.
- `tests/unit/contracts/masterCatalogNeverEnabledRead.contract.test.ts` — runs real legacy read services against Prisma mocks whose catalog
  delegates fail on contact.
- `tests/unit/services/master-catalog/catalogNeverEnabledWriterIsolation.service.test.ts` — exercises the real governance fast path and the
  real writer adapters with catalog-authority query traps.
- `src/testing/catalogNeverEnabledBenchmark.ts` — pure percentile, throughput and threshold evaluation shared by the CLI and deterministic
  unit tests; it contains no Prisma import or environment side effect.
- `scripts/benchmark-catalog-never-enabled.ts` — disposable-DB fixture, paired baseline/candidate runner and JSON report writer.
- `tests/unit/scripts/benchmarkCatalogNeverEnabled.test.ts` — deterministic unit contract for arguments, percentiles and threshold exit
  decision.
- `tests/integration/master-catalog/catalogNeverEnabledBenchmark.integration.test.ts` — small real-PostgreSQL smoke proving the candidate
  uses the production fence and the baseline does not; it does not assert wall-clock thresholds.
- `docs/superpowers/reports/2026-08-10-pits-legacy-compatibility-proof.md` — checked-in evidence and exact commands.

### Existing files modified

- `tests/contracts/master-catalog/product-dashboard-legacy.fixture.json` — only if a real service currently returns a field not frozen by
  the fixture; do not add Master Catalog fields.
- `tests/contracts/master-catalog/product-mobile-legacy.fixture.json` — same constraint for mobile.
- `tests/contracts/master-catalog/product-tpv-legacy.fixture.json` — same constraint for TPV.
- `docs/superpowers/specs/2026-08-08-pits-h1-master-catalog-design.md` — append the measured legacy evidence; do not rewrite historical
  decisions.
- `docs/superpowers/specs/2026-08-10-pits-confirmed-foundations-design.md` — mark only the legacy-proof criterion complete after all gates
  pass.
- `docs/PITS-H1-CHANGE-MANIFEST.md` — enumerate the exact new test, benchmark and report paths and commands.

## Interfaces

```ts
export interface BenchmarkDistribution {
  samplesMs: number[]
  elapsedMs: number
  operations: number
}

export interface BenchmarkSummary {
  p50Ms: number
  p95Ms: number
  p99Ms: number
  throughputPerSecond: number
}

export interface NeverEnabledBenchmarkEvaluation {
  baseline: BenchmarkSummary
  candidate: BenchmarkSummary
  delta: { p50Ms: number; p95Ms: number; p99Ms: number; throughputPercent: number }
  thresholds: { p95DeltaMaxMs: 5; p99DeltaMaxMs: 20; throughputFloorPercent: 95 }
  passed: boolean
}

export function summarizeBenchmark(input: BenchmarkDistribution): BenchmarkSummary
export function evaluateNeverEnabledBenchmark(
  baseline: BenchmarkDistribution,
  candidate: BenchmarkDistribution,
): NeverEnabledBenchmarkEvaluation
```

The CLI consumes these pure interfaces and writes this closed report envelope:

```ts
interface NeverEnabledBenchmarkReportV1 {
  schemaVersion: 1
  generatedAt: string
  gitCommit: string
  runtime: { node: string; platform: string; arch: string; cpuCount: number; postgresVersion: string }
  configuration: { writers: 50; venues: 10; warmupRounds: number; measuredRounds: number }
  result: NeverEnabledBenchmarkEvaluation
}
```

---

### Task 1: Freeze the exact NEVER_ENABLED surface inventory

**Files:**

- Create: `tests/unit/architecture/masterCatalogNeverEnabledIsolation.test.ts`
- Read: `tests/unit/architecture/masterCatalogGovernedProductWriters.test.ts`
- Read: `src/services/master-catalog/catalogGovernance.service.ts`

**Interfaces:**

- Consumes: TypeScript compiler API and the existing exact Product mutation inventory.
- Produces: a failing architectural gate whenever a protected legacy function directly references H1 authority or a new Product writer is
  introduced without classification.

- [ ] **Step 1: Write the RED AST inventory test**

  Parse the following exact named functions instead of scanning whole files, because write services legitimately import governance while
  their read functions must remain catalog-free:

  ```ts
  const LEGACY_READ_SURFACES = {
    'src/services/dashboard/product.dashboard.service.ts': ['getProducts', 'getProduct', 'getProductByBarcode'],
    'src/controllers/mobile/product.mobile.controller.ts': ['listProducts'],
    'src/services/mobile/inventory.mobile.service.ts': ['getStockOverview', 'getStockCounts'],
    'src/services/dashboard/pricing.service.ts': ['calculatePrice'],
    'src/services/tpv/order.tpv.service.ts': ['getOrders', 'getOrder'],
    'src/services/dashboard/venueCheckout.service.ts': ['getVenueCheckoutInfo', 'getVenueCheckoutSessionStatus'],
  } as const

  const FORBIDDEN_AUTHORITIES = [
    'CatalogItem',
    'CatalogIdentifier',
    'CatalogVenueBinding',
    'CatalogVenueRollout',
    'CatalogValidationProfile',
    'OrganizationModule',
    'OrganizationEntitlement',
    'catalogItem',
    'catalogIdentifier',
    'catalogVenueBinding',
    'catalogVenueRollout',
    'catalogValidationProfile',
    'organizationModule',
    'organizationEntitlement',
  ] as const
  ```

  Resolve local helper calls transitively within the same file. Fail if a listed function is missing, renamed, calls an unresolved local
  helper, or its reachable source contains one of the forbidden authority names. Import calls may be allowlisted only by exact symbol and
  exact current file after demonstrating the callee is catalog-free.

- [ ] **Step 2: Run RED and record the reason**

  Run:

  ```bash
  npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
    tests/unit/architecture/masterCatalogNeverEnabledIsolation.test.ts
  ```

  Expected: FAIL until the function resolver and exact inventory are implemented. Any existing catalog reference is a real finding and is
  adjudicated before changing the allowlist.

- [ ] **Step 3: Implement the minimal AST resolver in the test file**

  Use `ts.createSourceFile`, index top-level function declarations and exported variable arrow functions, recursively visit direct local
  identifier calls, and collect property/element access plus SQL template text. Do not create a reusable production scanner.

- [ ] **Step 4: Run GREEN with the existing Product writer inventory**

  ```bash
  npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
    tests/unit/architecture/masterCatalogNeverEnabledIsolation.test.ts \
    tests/unit/architecture/masterCatalogGovernedProductWriters.test.ts
  ```

  Expected: both suites PASS and the existing exact Product mutation counts remain unchanged.

- [ ] **Step 5: Stage exact paths and request commit approval**

  ```bash
  git add tests/unit/architecture/masterCatalogNeverEnabledIsolation.test.ts
  git diff --cached --check
  git diff --cached --stat
  ```

  Proposed commit: `test(catalog): freeze never-enabled legacy surfaces`

---

### Task 2: Prove real reads and writers never touch catalog authority

**Files:**

- Create: `tests/unit/contracts/masterCatalogNeverEnabledRead.contract.test.ts`
- Create: `tests/unit/services/master-catalog/catalogNeverEnabledWriterIsolation.service.test.ts`
- Read: `tests/unit/contracts/masterCatalogLegacyProduct.contract.test.ts`
- Read: `tests/unit/services/master-catalog/catalogGovernedProductWriters.service.test.ts`

**Interfaces:**

- Consumes: real exported legacy read functions, real writer adapters and `createCatalogGovernanceService()`.
- Produces: runtime zero-query proof and exact legacy output/error snapshots under a null cutoff.

- [ ] **Step 1: Write a catalog-authority tripwire**

  In each new test file, install rejecting delegates before importing the subject:

  ```ts
  const forbiddenQuery = jest.fn(async () => {
    throw new Error('NEVER_ENABLED_CATALOG_QUERY')
  })

  for (const delegate of [
    prismaMock.catalogItem,
    prismaMock.catalogIdentifier,
    prismaMock.catalogVenueBinding,
    prismaMock.catalogVenueRollout,
    prismaMock.catalogValidationProfile,
    prismaMock.organizationModule,
    prismaMock.organizationEntitlement,
  ]) {
    Object.assign(delegate, {
      findUnique: forbiddenQuery,
      findFirst: forbiddenQuery,
      findMany: forbiddenQuery,
      count: forbiddenQuery,
      aggregate: forbiddenQuery,
    })
  }
  ```

  Keep the trap local to these tests; do not change the global Prisma mock registry.

- [ ] **Step 2: Write RED read contracts**

  Invoke the real dashboard product list/detail/barcode, mobile product list, stock overview/counts, pricing calculation, TPV order
  list/detail and venue checkout reads with the smallest valid mocked legacy graph. Assert their current DTO or stable error, then assert
  `forbiddenQuery` has zero calls. The representative shape assertion is:

  ```ts
  await expect(getProducts(venueId, { includeRecipe: true, includeModifiers: true })).resolves.toEqual(existingDashboardFixture)
  expect(forbiddenQuery).not.toHaveBeenCalled()
  ```

  Use each function's real signature from source; do not cast calls through `as never` to hide drift.

- [ ] **Step 3: Write RED writer fast-path contracts**

  Call `createCatalogGovernanceService().assertLegacy()` with a mocked Venue fence returning
  `{ id: venueId, organizationId, catalogGovernanceEnforcedAt: null }`. Run the existing real dashboard, mobile, TPV, wizard, menu,
  onboarding, demo, POS-sync and delivery adapters through their allowed-success path. Assert existing Product payload/envelope and zero
  forbidden queries.

  ```ts
  await service.assertLegacy(tx, {
    organizationId,
    venueId,
    operation: 'CREATE',
    willBeVendable: true,
    actor: { type: 'HUMAN', staffId, impersonating: false },
  })
  expect(tx.module.findUnique).not.toHaveBeenCalled()
  expect(tx.catalogVenueRollout.findUnique).not.toHaveBeenCalled()
  ```

- [ ] **Step 4: Run RED**

  ```bash
  npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
    tests/unit/contracts/masterCatalogNeverEnabledRead.contract.test.ts \
    tests/unit/services/master-catalog/catalogNeverEnabledWriterIsolation.service.test.ts
  ```

  Expected: FAIL on missing fixtures/mocks or a real forbidden query. A real forbidden query is fixed at its production call site; it is
  never allowlisted.

- [ ] **Step 5: Complete minimal mocks and run the full legacy focal gate**

  ```bash
  npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
    tests/unit/architecture/masterCatalogNeverEnabledIsolation.test.ts \
    tests/unit/architecture/masterCatalogGovernedProductWriters.test.ts \
    tests/unit/contracts/masterCatalogLegacyProduct.contract.test.ts \
    tests/unit/contracts/masterCatalogLegacyVenue.contract.test.ts \
    tests/unit/contracts/masterCatalogNeverEnabledRead.contract.test.ts \
    tests/unit/services/master-catalog/catalogGovernance.service.test.ts \
    tests/unit/services/master-catalog/catalogGovernanceFence.service.test.ts \
    tests/unit/services/master-catalog/catalogGovernedProductWriters.service.test.ts \
    tests/unit/services/master-catalog/catalogNeverEnabledWriterIsolation.service.test.ts
  ```

  Expected: all suites PASS with no fixture containing `organizationId`, `catalogItemId`, identifiers, effective regional values or any
  newly mandatory PITS field in a legacy API response.

- [ ] **Step 6: Stage exact paths and request commit approval**

  ```bash
  git add \
    tests/unit/contracts/masterCatalogNeverEnabledRead.contract.test.ts \
    tests/unit/services/master-catalog/catalogNeverEnabledWriterIsolation.service.test.ts
  git diff --cached --check
  git diff --cached --stat
  ```

  Proposed commit: `test(catalog): prove never-enabled query isolation`

---

### Task 3: Build the deterministic benchmark evaluator

**Files:**

- Create: `src/testing/catalogNeverEnabledBenchmark.ts`
- Create: `tests/unit/scripts/benchmarkCatalogNeverEnabled.test.ts`

**Interfaces:**

- Consumes: the interfaces declared in this plan.
- Produces: `summarizeBenchmark()` and `evaluateNeverEnabledBenchmark()` for the disposable-DB CLI.

- [ ] **Step 1: Write RED percentile and threshold tests**

  Freeze nearest-rank percentiles over ascending finite non-negative samples, operations/elapsed throughput, and exact threshold edges:

  ```ts
  expect(summarizeBenchmark({ samplesMs: [1, 2, 3, 4, 100], elapsedMs: 1_000, operations: 5 })).toEqual({
    p50Ms: 3,
    p95Ms: 100,
    p99Ms: 100,
    throughputPerSecond: 5,
  })

  expect(
    evaluateNeverEnabledBenchmark(
      { samplesMs: [10], elapsedMs: 1_000, operations: 100 },
      { samplesMs: [15], elapsedMs: 1_050, operations: 100 },
    ).passed,
  ).toBe(true)
  ```

  Add failures for empty/NaN/negative samples, p95 delta `5.001`, p99 delta `20.001` and throughput `94.999%`.

- [ ] **Step 2: Run RED**

  ```bash
  npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
    tests/unit/scripts/benchmarkCatalogNeverEnabled.test.ts
  ```

  Expected: FAIL because `src/testing/catalogNeverEnabledBenchmark.ts` does not exist.

- [ ] **Step 3: Implement pure evaluation**

  Round only when serializing the report, not before deciding pass/fail. Preserve raw IEEE numbers inside the evaluator. Throughput delta is
  `(candidate / baseline) * 100`; zero elapsed time and zero operations are invalid input.

- [ ] **Step 4: Run GREEN and typecheck the project**

  ```bash
  npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
    tests/unit/scripts/benchmarkCatalogNeverEnabled.test.ts
  npm run typecheck -- --pretty false
  ```

  Expected: PASS and typecheck exit 0.

- [ ] **Step 5: Stage exact paths and request commit approval**

  ```bash
  git add src/testing/catalogNeverEnabledBenchmark.ts tests/unit/scripts/benchmarkCatalogNeverEnabled.test.ts
  git diff --cached --check
  git diff --cached --stat
  ```

  Proposed commit: `test(catalog): add never-enabled benchmark evaluator`

---

### Task 4: Run the paired disposable-PostgreSQL benchmark

**Files:**

- Create: `scripts/benchmark-catalog-never-enabled.ts`
- Create: `tests/integration/master-catalog/catalogNeverEnabledBenchmark.integration.test.ts`
- Read: `scripts/run-with-h1-test-db.cjs`
- Read: `tests/integration/master-catalog/catalogGovernance.integration.test.ts`

**Interfaces:**

- Consumes: `evaluateNeverEnabledBenchmark()`, Prisma, `assertLegacyCatalogGovernanceForVenue()` and the exact disposable H1 URL guard.
- Produces: one JSON report on stdout and a non-zero process exit when any threshold fails.

- [ ] **Step 1: Write RED CLI and integration contracts**

  Unit-test argument parsing by exporting `parseBenchmarkArgs()` without invoking `main()`. Integration-test a 2-writer/2-venue smoke that
  verifies the candidate issues `FOR NO KEY UPDATE` on Venue and never selects Module, rollout, entitlement or CatalogItem when the cutoff
  is null.

  ```ts
  expect(parseBenchmarkArgs(['--writers', '50', '--venues', '10', '--warmup-rounds', '2', '--measured-rounds', '20'])).toEqual({
    writers: 50,
    venues: 10,
    warmupRounds: 2,
    measuredRounds: 20,
  })
  ```

  Reject writers other than 50 and venues other than 10 in the evidence mode. Permit 2/2 only through an explicit exported smoke helper used
  by the integration test, not through the production CLI.

- [ ] **Step 2: Run RED through the tracked safety wrapper**

  ```bash
  node scripts/run-with-h1-test-db.cjs npx jest --no-watchman --selectProjects=integration --runInBand --runTestsByPath \
    tests/integration/master-catalog/catalogNeverEnabledBenchmark.integration.test.ts
  ```

  Expected: FAIL because the benchmark module does not exist.

- [ ] **Step 3: Implement exact fixture and paired scenarios**

  Create one organization, 10 venues with `catalogGovernanceEnforcedAt: null`, one category per venue and a stable HUMAN Staff fixture.
  Generate unique Product ids/SKUs before timing. For every measured round alternate AB/BA order:

  ```ts
  // baseline
  await prisma.$transaction(tx => tx.product.create({ data: legacyProductData }))

  // candidate: exact production seam used by real Product writers
  await prisma.$transaction(async tx => {
    await assertLegacyCatalogGovernanceForVenue(tx, {
      venueId,
      operation: 'CREATE',
      willBeVendable: true,
      actor: { type: 'HUMAN', staffId, impersonating: false },
    })
    await tx.product.create({ data: legacyProductData })
  })
  ```

  Each scenario performs 50 concurrent operations distributed by `writerIndex % 10`; measure each operation and the scenario wall clock.
  Delete only fixture-prefixed Products between scenarios. In `finally`, delete the complete fixture by explicit organization/venue ids.
  Never disable constraints or truncate shared tables.

- [ ] **Step 4: Add query evidence and environment metadata**

  Use a benchmark-local Prisma client with query event logging. Count normalized table names only; never log bound values. Assert candidate
  catalog-authority query counts are all zero except the Venue fence. Read PostgreSQL version using `SHOW server_version` and git commit
  using `git rev-parse HEAD` without failing when the worktree has uncommitted benchmark files.

- [ ] **Step 5: Run smoke GREEN**

  ```bash
  node scripts/run-with-h1-test-db.cjs npx jest --no-watchman --selectProjects=integration --runInBand --runTestsByPath \
    tests/integration/master-catalog/catalogNeverEnabledBenchmark.integration.test.ts
  ```

  Expected: PASS; the test validates semantics and query classification but contains no timing assertion.

- [ ] **Step 6: Check capacity and run the mandatory benchmark**

  ```bash
  sysctl -n hw.ncpu vm.loadavg
  sysctl -n vm.swapusage
  pgrep -fl "GradleDaemon|KotlinCompileDaemon|xcodebuild|jest|vitest|tsc" | head
  node scripts/run-with-h1-test-db.cjs npx tsx scripts/benchmark-catalog-never-enabled.ts \
    --writers 50 --venues 10 --warmup-rounds 2 --measured-rounds 20 \
    --output /tmp/pits-never-enabled-benchmark.json
  ```

  Expected: exit 0 only if all three thresholds pass. Preserve `/tmp/pits-never-enabled-benchmark.json` as the input to Task 5. If load or
  swap is high, run anyway and record it; do not reinterpret a noisy failure as success.

- [ ] **Step 7: Stage exact paths and request commit approval**

  ```bash
  git add \
    scripts/benchmark-catalog-never-enabled.ts \
    tests/integration/master-catalog/catalogNeverEnabledBenchmark.integration.test.ts
  git diff --cached --check
  git diff --cached --stat
  ```

  Proposed commit: `test(catalog): benchmark never-enabled writer fence`

---

### Task 5: Record evidence and close only the legacy criterion

**Files:**

- Create: `docs/superpowers/reports/2026-08-10-pits-legacy-compatibility-proof.md`
- Modify: `docs/superpowers/specs/2026-08-08-pits-h1-master-catalog-design.md`
- Modify: `docs/superpowers/specs/2026-08-10-pits-confirmed-foundations-design.md`
- Modify: `docs/PITS-H1-CHANGE-MANIFEST.md`

**Interfaces:**

- Consumes: exact Jest output, benchmark JSON and current git commit.
- Produces: one auditable claim with explicit pass/fail and no claim about H1B, H1C, fiscal, recipe, regional values or the 30-minute SLA.

- [ ] **Step 1: Write the report from measured data**

  The report must include:

  ```markdown
  ## Scope

  NEVER_ENABLED legacy compatibility only. No PITS organization was enabled.

  ## Query isolation

  [exact suite command and output]

  ## Benchmark environment

  [Node, CPU count, PostgreSQL, commit, load and swap]

  ## Results

  | Scenario      |      p50 |      p95 |      p99 | throughput |
  | ------------- | -------: | -------: | -------: | ---------: |
  | Baseline      | measured | measured | measured |   measured |
  | Current fence | measured | measured | measured |   measured |

  ## Decision

  PASS only when p95 delta <= 5 ms, p99 delta <= 20 ms and throughput >= 95%.

  ## Explicit non-claims

  This does not approve identifiers, regions, fiscal rules, recipes, 100k staging, CSV layout or a 30-minute SLA.
  ```

  Copy numbers from the JSON; do not transcribe from terminal rounding.

- [ ] **Step 2: Update specs narrowly**

  Append the report link and result to the existing NEVER_ENABLED verification section. In the confirmed-foundations spec, mark only the
  functional/operational legacy proof as complete. Leave staging, CSV/background and every unanswered PITS decision pending.

- [ ] **Step 3: Run exact focused and repository gates**

  ```bash
  npx jest --no-watchman --selectProjects=unit --runInBand --runTestsByPath \
    tests/unit/architecture/masterCatalogNeverEnabledIsolation.test.ts \
    tests/unit/architecture/masterCatalogGovernedProductWriters.test.ts \
    tests/unit/contracts/masterCatalogLegacyProduct.contract.test.ts \
    tests/unit/contracts/masterCatalogLegacyVenue.contract.test.ts \
    tests/unit/contracts/masterCatalogNeverEnabledRead.contract.test.ts \
    tests/unit/services/master-catalog/catalogGovernance.service.test.ts \
    tests/unit/services/master-catalog/catalogGovernanceFence.service.test.ts \
    tests/unit/services/master-catalog/catalogGovernedProductWriters.service.test.ts \
    tests/unit/services/master-catalog/catalogNeverEnabledWriterIsolation.service.test.ts \
    tests/unit/scripts/benchmarkCatalogNeverEnabled.test.ts
  node scripts/run-with-h1-test-db.cjs npx jest --no-watchman --selectProjects=integration --runInBand --runTestsByPath \
    tests/integration/master-catalog/catalogNeverEnabledBenchmark.integration.test.ts
  npm run typecheck -- --pretty false
  npm run build
  npx eslint --max-warnings=0 \
    src/testing/catalogNeverEnabledBenchmark.ts \
    scripts/benchmark-catalog-never-enabled.ts \
    tests/unit/architecture/masterCatalogNeverEnabledIsolation.test.ts \
    tests/unit/contracts/masterCatalogNeverEnabledRead.contract.test.ts \
    tests/unit/services/master-catalog/catalogNeverEnabledWriterIsolation.service.test.ts \
    tests/unit/scripts/benchmarkCatalogNeverEnabled.test.ts \
    tests/integration/master-catalog/catalogNeverEnabledBenchmark.integration.test.ts
  npx prettier --check --ignore-path /dev/null \
    src/testing/catalogNeverEnabledBenchmark.ts \
    scripts/benchmark-catalog-never-enabled.ts \
    tests/unit/architecture/masterCatalogNeverEnabledIsolation.test.ts \
    tests/unit/contracts/masterCatalogNeverEnabledRead.contract.test.ts \
    tests/unit/services/master-catalog/catalogNeverEnabledWriterIsolation.service.test.ts \
    tests/unit/scripts/benchmarkCatalogNeverEnabled.test.ts \
    tests/integration/master-catalog/catalogNeverEnabledBenchmark.integration.test.ts \
    docs/superpowers/reports/2026-08-10-pits-legacy-compatibility-proof.md \
    docs/superpowers/plans/2026-08-10-pits-legacy-compatibility-proof.md \
    docs/superpowers/specs/2026-08-08-pits-h1-master-catalog-design.md \
    docs/superpowers/specs/2026-08-10-pits-confirmed-foundations-design.md \
    docs/PITS-H1-CHANGE-MANIFEST.md
  ```

  Expected: all commands exit 0. Then run the repository `full-testing` skill before declaring the tranche complete.

- [ ] **Step 4: Self-review the evidence boundary**

  Search the report/spec diff for `73,000`, `100,000`, `30 minutos`, `H1B`, `H1C`, `fiscal`, `receta`, `regional` and ensure every mention
  is explicitly a non-claim or pending item. Verify `git diff -- prisma/` is empty.

- [ ] **Step 5: Stage exact paths and request final commit approval**

  ```bash
  git add \
    docs/superpowers/reports/2026-08-10-pits-legacy-compatibility-proof.md \
    docs/superpowers/specs/2026-08-08-pits-h1-master-catalog-design.md \
    docs/superpowers/specs/2026-08-10-pits-confirmed-foundations-design.md \
    docs/PITS-H1-CHANGE-MANIFEST.md
  git diff --cached --check
  git diff --cached --stat
  ```

  Proposed commit: `docs(pits): record legacy compatibility proof`

---

## Self-Review

### Spec coverage

- Functional legacy behavior: Tasks 1 and 2.
- Operational zero-query behavior: Tasks 1 and 2.
- Exact writer inventory: Task 1 reuses and runs the current inventory; Task 2 adds runtime proof.
- 50 writers / 10 venues and p95/p99/throughput thresholds: Tasks 3 and 4.
- Archived evidence and honest non-claims: Task 5.
- 100k staging and CSV/background are intentionally excluded because the approved design treats them as independent subprojects. They
  require their own plans after this proof is underway; this plan does not silently claim them.

### Industry-pattern check

- NetSuite exposes durable queued import status, progress, cancellation, retry and downloadable result artifacts rather than keeping a
  request open; this supports the later staging plan without changing this compatibility tranche.
- Shopify bulk operations are asynchronous, pollable/cancellable and produce a downloadable result file; this supports reusing durable
  operation state instead of building an in-request 100k apply.
- Google Cloud signed URLs are bearer authority until expiry, so the later artifact plan must reauthorize before minting a short-lived URL;
  a stored public URL is not acceptable.
- Odoo supports XLSX and CSV templates but warns that imports are permanent; PITS's all-or-nothing preview requirement remains stricter and
  is not weakened here.

### Placeholder scan

This plan contains no implementation placeholders. Values in the final report are intentionally described as `measured` because Task 4 is
the step that produces them; the report may not be marked complete before those exact values exist.

### Type consistency

The pure evaluator interfaces are declared once and consumed unchanged by Tasks 3–5. The CLI uses the production
`assertLegacyCatalogGovernanceForVenue()` signature and the existing HUMAN actor union.
