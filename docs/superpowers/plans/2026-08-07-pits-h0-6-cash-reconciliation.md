# PITS H0.6 — Cash Reconciliation Implementation Plan

> **Execution rule:** use `superpowers:test-driven-development` for every money, tier, permission, concurrency, and migration change. Use
> `superpowers:subagent-driven-development` only if the founder explicitly selects that execution mode.

**Goal:** An explicitly opted-in PRO venue can perform a Square/Toast-style blind cash count at TPV shift close and receive a truthful
balanced/short/over result. Current venues, Avoqado Desktop, old APKs, kiosks, inventory, payments, and SoftRestaurant retain their current
behavior.

**Design:** [`2026-08-07-pits-h0-6-cash-reconciliation-design.md`](../specs/2026-08-07-pits-h0-6-cash-reconciliation-design.md)

**Architecture:** The server owns entitlement and activation. A new `VenueSettings.cashReconciliationEnabled` defaults false; effective
access is the existing PRO Feature resolver AND that raw opt-in. The new close contract uses `cashReconciliationAction=COUNTED|SKIPPED` plus
canonical-string `countedCash`; legacy `cashDeclared` remains ungated and unchanged because Avoqado Desktop actively uses it. The existing
`ShiftStatus.CLOSING` provides an atomic close claim. Server ships first; dashboard and TPV consume only additive fields.

**Tech stack:** Express/TypeScript, Prisma/PostgreSQL, Jest, RabbitMQ, Socket.IO, customer MCP; React/Vite/Vitest; Kotlin, Retrofit/Gson,
Jetpack Compose, MockK, Gradle.

## Global constraints

- No commit, push, branch switch, reset, checkout, clean, stash, or `git add` without explicit permission. This is a shared dirty worktree;
  edit only named blocks and preserve other sessions.
- Production PostgreSQL is SELECT-only. All mutations and migration exercises use the isolated H0 local clone.
- Money stays `Prisma.Decimal` / Kotlin `BigDecimal`; zero is checked nullishly, never by truthiness. New wire money is a canonical decimal
  string.
- New API fields are optional/additive. Backend deploys before dashboard and APK.
- Feature/config/normalization failures never block shift close. A concurrent close may return `409 SHIFT_CLOSE_IN_PROGRESS`; the TPV
  recovers by refetching.
- `cashDeclared` and nested `closeData.cashDeclared` are legacy contracts, not aliases for the new gate. Avoqado Desktop depends on
  top-level `cashDeclared` today.
- Kiosk call sites remain count-free. No payment, inventory, or SoftRestaurant contract is removed or renamed.
- Every RED test must fail for the intended reason before production code is added.
- Prisma changes require `npm run schema:map` and a regenerated `docs/SCHEMA_MAP.md`.
- Customer-visible server capability must keep `src/mcp/` and Feature catalogs in sync.
- Every TPV change goes under `CHANGELOG.md` `[Unreleased]` and gets 360×640 previews.
- The partner presentation already says “apertura y cierre con arqueo por turno”; verify that copy remains truthful, but do not create
  unrelated presentation churn.

## Task 1 — Freeze the existing and new HTTP contracts with RED tests

**Files**

- Create: `tests/unit/controllers/tpv/shift.closeContract.test.ts`
- Create: `tests/unit/services/shared/cashReconciliation.test.ts`
- Modify: `tests/unit/services/tpv/shiftCapture.test.ts`
- Modify: `tests/unit/services/dashboard/shift.cashDifference.test.ts`

- [ ] Controller tests prove old bodies stay compatible:
  - `{}` and `{venueId, shiftId, closeData:null}` do not fabricate a count.
  - top-level `cashDeclared` is forwarded on the legacy path, ungated.
  - nested `closeData.cashDeclared` remains accepted; top-level wins on conflict.
  - legacy numeric zero retains the current legacy outcome and never becomes a new reconciliation action.
- [ ] New-contract tests prove:
  - `COUNTED + "0.00"` preserves zero.
  - `SKIPPED` is distinguishable from omission.
  - `COUNTED` with blank, negative, exponent, comma, three decimals, overflow, number/alias conflicts, or missing amount yields
    `IGNORED_INVALID` and does not fall back.
  - `SKIPPED` with a count is invalid; no fake count is applied.
  - root `reconciliation` is additive while `data` remains the Shift object.
- [ ] Decimal helper tests cover positive, zero, shortage, balanced, maximum value, and a computed difference outside `Decimal(10,2)`
      without converting through JavaScript `number`.
- [ ] Serializer tests prove Decimal zero survives in every shift list/detail/update path.
- [ ] Observe RED:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --runInBand --runTestsByPath \
  tests/unit/controllers/tpv/shift.closeContract.test.ts \
  tests/unit/services/shared/cashReconciliation.test.ts \
  tests/unit/services/tpv/shiftCapture.test.ts \
  tests/unit/services/dashboard/shift.cashDifference.test.ts
```

## Task 2 — Add the default-off opt-in and register the PRO Feature

**Files**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260808010000_add_cash_reconciliation_opt_in/migration.sql`
- Modify/generated: `docs/SCHEMA_MAP.md`
- Modify: `prisma/seed.ts`
- Modify: `src/services/onboarding/demoSeed.service.ts`
- Create: `src/services/access/cashReconciliationAccess.service.ts`
- Modify: `src/services/dashboard/venueSettings.dashboard.service.ts`
- Modify: `src/controllers/dashboard/venueSettings.dashboard.controller.ts`
- Modify: `src/schemas/dashboard/venueSettings.schema.ts`
- Create: `tests/unit/services/access/cashReconciliationAccess.test.ts`
- Create: `tests/unit/services/dashboard/venueSettings.cashReconciliation.test.ts`
- Modify: `tests/unit/schemas/venueSettings.schema.test.ts`

- [ ] Write RED access tests for raw off, PRO/PREMIUM/exempt + raw on, FREE + raw on, explicit grant + raw on, missing settings, and runtime
      resolver failure returning false.
- [ ] Write RED mutation tests proving false→true requires entitlement, true→false is always allowed after downgrade, entitlement
      infrastructure failure on enable is retryable rather than a false 403, and the update/audit share one transaction.
- [ ] Add `cashReconciliationEnabled Boolean @default(false)` to `VenueSettings`.
- [ ] Migration adds that non-null default-false column and idempotently registers an active `CASH_RECONCILIATION` OPERATIONS Feature
      (bundled price `0.00`) so explicit VenueFeature grants are possible. It creates no VenueFeature rows and performs no opt-in backfill.
- [ ] Mirror the Feature row in `prisma/seed.ts`. Keep demo seeding explicit/default-off; do not overwrite an existing venue preference
      merely because demo data is rerun.
- [ ] Implement `isCashReconciliationEnabled(venueId)` as Feature entitlement AND raw setting. Runtime consumers catch errors and return
      false; the enable mutation lets infrastructure errors surface as retryable.
- [ ] Extend venue settings defaults, create/upsert input, and Zod schema. Thread `authContext.userId` from controller to service. Audit
      actor plus previous/new values.
- [ ] Run GREEN and schema generation:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx prisma validate
npx prisma generate
npm run schema:map
npx jest --runInBand --runTestsByPath \
  tests/unit/services/access/cashReconciliationAccess.test.ts \
  tests/unit/services/dashboard/venueSettings.cashReconciliation.test.ts \
  tests/unit/schemas/venueSettings.schema.test.ts
```

- [ ] Apply only this migration to the isolated H0 clone. Assert every pre-existing `VenueSettings` row remains false and no VenueFeature
      grant was created.

## Task 3 — Publish a server-owned, fail-closed terminal capability

**Files**

- Modify: `src/controllers/tpv/terminal.tpv.controller.ts`
- Modify: `tests/unit/controllers/tpv/terminal.tpv.planInfo.test.ts`
- Create: `tests/unit/controllers/tpv/terminal.tpv.cashReconciliation.test.ts`
- Modify: `tests/unit/controllers/tpv/terminal.tpv.trackPromoterLocation.test.ts`

- [ ] Write RED tests for raw off + PRO, raw on + FREE, raw on + eligible plan/exemption/grant, resolver error, and old/missing setting.
- [ ] Return `data.cashReconciliationEnabled` outside mutable `data.tpvSettings`, always present and false on resolution failure. Preserve
      every existing terminal/merchant/settings/plan field.
- [ ] Strip an injected/previously stored `cashReconciliationEnabled` from device PUT settings and overrides. The generic device endpoint
      cannot activate or persist this venue-level capability.
- [ ] Assert terminal settings updates still preserve server-owned `trackPromoterLocation` behavior.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --runInBand --runTestsByPath \
  tests/unit/controllers/tpv/terminal.tpv.planInfo.test.ts \
  tests/unit/controllers/tpv/terminal.tpv.cashReconciliation.test.ts \
  tests/unit/controllers/tpv/terminal.tpv.trackPromoterLocation.test.ts
```

## Task 4 — Normalize Decimal input and atomically close one shift once

**Files**

- Create: `src/services/shared/cashReconciliation.service.ts`
- Modify: `src/controllers/tpv/shift.tpv.controller.ts`
- Modify: `src/services/tpv/shift.tpv.service.ts`
- Modify: `src/services/dashboard/shift.dashboard.service.ts`
- Modify: `src/routes/tpv.routes.ts` (OpenAPI only; middleware stays unchanged)
- Modify: `src/communication/sockets/types/index.ts`
- Create: `tests/unit/services/tpv/shift.cashReconciliation.test.ts`
- Create: `tests/unit/services/tpv/shift.closeConcurrency.test.ts`
- Create: `tests/unit/services/dashboard/shift.serializer.test.ts`
- Modify: Task 1 tests

- [ ] Implement a pure request normalizer that returns source, action, Decimal amount, and outcome. New-action input owns the request and
      never falls through. Legacy declarations retain their current path and SoftRestaurant payload.
- [ ] Remove every missing-value `|| 0`/truthiness conversion at the HTTP boundary while preserving the legacy no-count observable result.
      Carry authenticated actor metadata separately from money.
- [ ] Use `Prisma.Decimal` for expected, count, and difference. On difference overflow, persist the valid physical count, leave difference
      null, and return/audit `IGNORED_OVERFLOW`.
- [ ] Claim with atomic `OPEN -> CLOSING` `updateMany` scoped by `id + venueId + endTime:null`. Concurrent/fresh CLOSING returns
      `409 SHIFT_CLOSE_IN_PROGRESS`; a CLOSING claim older than five minutes may be CAS-recovered and retried once.
- [ ] On pre-commit failure, guarded-release CLOSING→OPEN. Final Shift update and `SHIFT_CLOSED` ActivityLog create occur in one Prisma
      transaction. Audit actor, source, outcome, counted, expected, difference, and ignore reason as Decimal strings.
- [ ] Move RabbitMQ SoftRestaurant publish and Socket broadcast after commit. They are best-effort, at-most-one attempts for the winning
      request; no side effect runs for a losing concurrent close.
- [ ] Applied new count persists `endingCash=countedCash`, `cashDeclared=countedCash`, and the shared difference. New
      skip/invalid/disabled/no-request retains the no-count path. Legacy declaration retains its current ending/declaration/POS semantics
      without consulting the new gate.
- [ ] Add `cashDeclared`/`cashDifference` to optional Socket payload and replace dashboard truthiness serializers with nullish checks.
- [ ] Update OpenAPI with action, canonical-string amount, legacy shapes, outcomes, 409 code, and unchanged
      `authenticateTokenMiddleware + shifts:close` route middleware.
- [ ] Concurrency RED/GREEN proves two simultaneous calls produce one claim/final update/audit and at most one POS publish; fresh vs stale
      CLOSING and rollback release are independent cases.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --runInBand --runTestsByPath \
  tests/unit/controllers/tpv/shift.closeContract.test.ts \
  tests/unit/services/shared/cashReconciliation.test.ts \
  tests/unit/services/tpv/shift.cashReconciliation.test.ts \
  tests/unit/services/tpv/shift.closeConcurrency.test.ts \
  tests/unit/services/tpv/shiftCapture.test.ts \
  tests/unit/services/dashboard/shift.serializer.test.ts \
  tests/unit/services/dashboard/shift.cashDifference.test.ts
```

## Task 5 — Add the PRO opt-in and result detail to the web dashboard

**Files**

- Modify: `src/config/plan-catalog.ts`
- Modify: `src/config/__tests__/plan-catalog.test.ts`
- Modify: `src/hooks/use-tier-feature-access.ts`
- Modify: `src/types.ts`
- Modify: `src/pages/Venue/Edit/BasicInfo.tsx`
- Create: `src/pages/Venue/Edit/components/CashReconciliationSetting.tsx`
- Create: `src/pages/Venue/Edit/components/CashReconciliationSetting.test.tsx`
- Modify: `src/pages/Shift/ShiftId.tsx`
- Create: `src/pages/Shift/components/CashReconciliationSummary.tsx`
- Create: `src/pages/Shift/components/CashReconciliationSummary.test.tsx`
- Modify: `src/hooks/use-shift-socket-events.ts`
- Modify: `src/locales/{es,en,fr}/venue.json`
- Modify: `src/locales/{es,en,fr}/shifts.json`
- Modify: `CHANGELOG.md`

- [ ] Register `CASH_RECONCILIATION` in PRO and prove catalog/server code spelling matches exactly.
- [ ] Add an additive resolved signal to the tier hook without changing its existing fail-open callers. This setting may enable only on a
      positively resolved entitlement.
- [ ] Use `useAccess().can('venues:update')`, not hard-coded global roles.
- [ ] Render below enabled shifts when `hasAccess || storedSetting===true`. After downgrade, explain that it is inactive and permit only
      turning it off. Unresolved plan cannot turn it on.
- [ ] PUT only `{cashReconciliationEnabled:boolean}` to venue settings; optimistic error/403/503 restores server state. Add
      `data-tour="cash-reconciliation-setting"`.
- [ ] Shift detail renders `Caja cuadrada` for exactly zero, `Faltante` for negative, `Sobrante` for positive, and `Sin conteo` for null. No
      new list column is required; Socket invalidation keeps the existing list fresh.
- [ ] Localize all copy in es/en/fr and use semantic color tokens.
- [ ] Run targeted tests, i18n/contract validation, lint, and build:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard
npm run test:run -- \
  src/config/__tests__/plan-catalog.test.ts \
  src/pages/Venue/Edit/components/CashReconciliationSetting.test.tsx \
  src/pages/Shift/components/CashReconciliationSummary.test.tsx
npm run lint:i18n
npm run validate:contracts
npx eslint src/config/plan-catalog.ts src/hooks/use-tier-feature-access.ts src/types.ts \
  src/pages/Venue/Edit/BasicInfo.tsx \
  src/pages/Venue/Edit/components/CashReconciliationSetting.tsx \
  src/pages/Shift/ShiftId.tsx src/pages/Shift/components/CashReconciliationSummary.tsx \
  src/hooks/use-shift-socket-events.ts
npm run build
```

## Task 6 — Cache the server-owned capability safely on TPV

**Files**

- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/network/dto/TerminalConfigDto.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/domain/model/TpvSettings.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/repository/TpvSettingsRepository.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/core/data/local/SecureStorage.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/plan/domain/model/VenuePlanInfo.kt`
- Create: `app/src/test/java/com/jaac/avoqado_tpv/core/data/network/dto/TerminalConfigCashReconciliationTest.kt`
- Modify: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/data/repository/TpvSettingsRepositoryLocalFirstTest.kt`
- Modify: `app/src/test/java/com/jaac/avoqado_tpv/features/plan/domain/model/VenuePlanInfoTest.kt`

- [ ] RED tests: absent old-server field maps false, explicit true maps true, resolver refresh stores true across restart, unset key stays
      false, and device update DTO never includes the field.
- [ ] Add nullable top-level terminal-config DTO field; copy it into the local domain settings value with false default. Do not add it to
      mutable `TpvSettingsDto`.
- [ ] Add SecureStorage save/read/remove with false default. Do not log credentials or drawer money.
- [ ] Mirror the PRO feature code for catalog consistency, but never use local `PlanManager` fail-open logic to show the count UI; the
      server-owned boolean is authoritative.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv
./gradlew :app:testSandboxDebugUnitTest \
  --tests "*TerminalConfigCashReconciliationTest*" \
  --tests "*TpvSettingsRepositoryLocalFirstTest*" \
  --tests "*VenuePlanInfoTest*"
```

## Task 7 — Send canonical counts and parse additive close outcomes on TPV

**Files**

- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/shift/data/dto/ShiftDto.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/shift/data/repository/ShiftRepository.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/shift/domain/Shift.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/shift/presentation/ShiftViewModel.kt`
- Create: `app/src/test/java/com/jaac/avoqado_tpv/features/shift/data/ShiftCloseRequestTest.kt`
- Create: `app/src/test/java/com/jaac/avoqado_tpv/features/shift/data/ShiftRepositoryTest.kt`
- Modify: `app/src/test/java/com/jaac/avoqado_tpv/features/shift/presentation/ShiftViewModelTest.kt`

- [ ] RED serialization tests prove old/default call retains `{venueId,shiftId}` wire shape (nullable fields omitted), zero sends
      `COUNTED + "0.00"`, and intentional escape sends only `SKIPPED`.
- [ ] Add request enum/action plus `countedCash:String?` produced only by `BigDecimal.toPlainString()`. Retain `CloseShiftData` for
      compatibility.
- [ ] Add optional `reconciliation` to `ShiftResponse`, with all documented outcomes. Add nullable string DTO and defaulted `BigDecimal?`
      domain values for `cashDeclared` and `cashDifference`.
- [ ] Repository and ViewModel accept defaulted `BigDecimal?`/action arguments. A 409 triggers one bounded refetch of current/history; if
      already closed, surface the server result rather than resending the close.
- [ ] Kiosk and old callers compile and send neither action nor count.
- [ ] Run GREEN:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv
./gradlew :app:testSandboxDebugUnitTest \
  --tests "*ShiftCloseRequestTest*" \
  --tests "*ShiftRepositoryTest*" \
  --tests "*ShiftViewModelTest*"
```

## Task 8 — Build the blind count and persistent result UI

**Files**

- Create: `app/src/main/java/com/jaac/avoqado_tpv/features/shift/domain/CashCountParser.kt`
- Create: `app/src/test/java/com/jaac/avoqado_tpv/features/shift/domain/CashCountParserTest.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/shift/presentation/ShiftDialogs.kt`
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/shift/presentation/ShiftScreen.kt`
- Modify: `CHANGELOG.md`

- [ ] Parser RED cases cover blank, zero, integer, comma input, two decimals, negative, exponent, three decimals, non-numeric, maximum, and
      overflow. Parser returns `BigDecimal` or typed error.
- [ ] Flag off: preserve current dialog layout, totals, buttons, and repository call.
- [ ] Flag on: show only non-monetary context; hide starting cash, sales, tips, and every payment total from which expected cash could be
      inferred. Show `Efectivo total contado` and `Incluye el fondo inicial`.
- [ ] Primary `Cerrar y conciliar` requires valid input. Secondary `Cerrar sin conteo` requires a second confirmation and sends `SKIPPED`.
- [ ] Result shows balanced/short/over. Attempted-but-null result shows a non-blocking closed-without- reconciliation warning. Disable the
      two-second auto-dismiss only for a reconciliation attempt; keep the result until explicit acknowledgment.
- [ ] History displays a stored difference when present without changing old history rows.
- [ ] Add enabled/disabled/result previews at exact 360×640 and make content scroll safely.
- [ ] Add `[Unreleased]` changelog copy for opt-in blind count and compatibility.
- [ ] Run GREEN and compile:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv
./gradlew :app:testSandboxDebugUnitTest \
  --tests "*CashCountParserTest*" \
  --tests "*ShiftViewModelTest*" \
  --tests "*ShiftRepositoryTest*"
./gradlew :app:compileSandboxDebugKotlin
```

## Task 9 — Keep customer MCP, catalogs, docs, and changelogs synchronized

**Files**

- Modify: `src/mcp/tools/shifts.ts`
- Create: `tests/unit/mcp-customer/shifts.test.ts`
- Modify: `CHANGELOG.md` (server)
- Modify: dashboard/TPV changelogs from Tasks 5 and 8

- [ ] Extend existing `list_shifts` output with `cashDeclared` and null-safe `cashDifference` in pesos under the existing `shifts:read`
      guard. Never infer an intentional skip from null columns.
- [ ] Test zero, null, negative, and tenant/permission behavior.
- [ ] Confirm `registerShiftTools` is already registered in `src/mcp/server.ts`; no duplicate tool.
- [ ] Update server/dashboard/TPV changelogs with additive rollout and compatibility notes.
- [ ] Recheck the three partner-presentation source files still describe this capability truthfully. The existing “arqueo por turno”
      statement means no deck/PDF regeneration is required unless implementation changes that promise.
- [ ] Run:

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --runInBand --runTestsByPath tests/unit/mcp-customer/shifts.test.ts
npx eslint src/mcp/tools/shifts.ts tests/unit/mcp-customer/shifts.test.ts
```

## Task 10 — Cross-repo regression and real local-clone proof

- [ ] Check capacity before heavy suites, but run required verification even if slow:

```bash
sysctl -n hw.ncpu vm.loadavg
sysctl -n vm.swapusage
pgrep -fl "GradleDaemon|KotlinCompileDaemon|xcodebuild|jest|vitest|tsc" | head
```

- [ ] Server: run all targeted H0.6 tests, full unit suite, `npm run pre-deploy`, schema drift/map, permissions audit, and MCP
      money/contract checks. If known unrelated `areaTicketV7.mobile.service.ts` type errors remain, prove they are outside this diff and
      report them without editing that file.
- [ ] Dashboard: run full Vitest, i18n/contract validation, and production build.
- [ ] TPV: run full sandbox unit suite, `compileSandboxDebugKotlin`, lint, and `./scripts/check-cross-repo.sh`.
- [ ] Read-only compatibility proof in `avoqado-desktop`: source-contract assertion plus targeted `CajaFlowUiTest`; no Desktop edit should
      be required because legacy `cashDeclared` remains active.
- [ ] Run `adb devices -l`. If attached, monitor an off-flow close, counted close, zero-count close, confirmed skip, and result
      acknowledgment. If none is attached, state hardware proof remains unavailable; never invent it.
- [ ] Against the isolated local DB clone, prove via real HTTP + PostgreSQL:
  1. old TPV body closes with no fabricated count;
  2. Desktop top-level `cashDeclared` remains applied with flag off/FREE;
  3. new count while raw off is `IGNORED_DISABLED` and still closes;
  4. eligible raw on + balanced count stores/returns exact zero;
  5. zero count stores zero and the full shortage;
  6. explicit skip stores null and audits `SKIPPED`;
  7. invalid/overflowed count closes with its explicit outcome;
  8. FREE cannot enable while downgrade can disable;
  9. two concurrent requests create one close/audit/POS attempt;
  10. stale CLOSING recovery works and fresh CLOSING is not stolen;
  11. venue A cannot close or configure venue B.
- [ ] Production remains SELECT-only; compare only migration/schema/count assumptions if needed.

## Task 11 — Close H0 and hand off cleanly

- [ ] Update the H0 report with exact commands/results, Square/Toast/Shopify rationale, Decimal and legacy-Desktop decisions, paid-in/out
      limitation, and payment-vs-close snapshot limitation.
- [ ] Record every file touched by this work separately from other sessions' WIP. Recheck shared hotspots before reporting ownership.
- [ ] Drop only the explicitly named isolated H0 clone after preserving the verification log and confirm no process started by this task
      remains. Never touch production or the user's normal local database.
- [ ] Do not commit. Offer explicit-path commit groups only if requested.
- [ ] Recommend a TPV MINOR bump at release time because operators gain a capability; do not bump during implementation unless the founder
      requests a release.
- [ ] Only after H0 is completely closed, begin the next PITS milestone with:
      `brainstorming -> writing-plans -> explicit inline/subagent execution choice`.
