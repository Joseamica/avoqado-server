# Facturación CFDI — Phase 6: Flow C (factura global "público en general", admin-defined periodicity) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps. `critical-warnings.md` +
> `cron-jobs.md` auto-load.

**Goal:** At the cadence the admin chose (`FiscalEmisor.globalPeriodicity` — DIARIO/SEMANAL/QUINCENAL/MENSUAL/BIMESTRAL), the platform
issues a single **factura global** to "Público en General" (RFC `XAXX010101000`) covering every paid order in the closed period that (a) was
collected through a merchant with `includeInGlobal=true` mapped to this emisor, and (b) was **not** individually invoiced (Flow B/A). Plus
an **admin manual-trigger** endpoint.

**Architecture:** A new pure-ish global service (`cfdiGlobal.service.ts`) with the same DI shape as `cfdi.service.ts`; a connector method
`createGlobalInvoice`; a payload builder for the global; a cron job that, per emisor, detects the most-recent **closed** period and issues
if not already issued; a dashboard trigger endpoint. The schema is **already global-ready** — `Cfdi.isGlobal`, `Cfdi.globalPeriod Json?`
(`{periodicidad, meses, anio}`), nullable `orderId`, index `[fiscalEmisorId, isGlobal, createdAt]`. **NO migration.**

**Tech Stack:** TypeScript, Prisma, `facturapi` SDK, `cron`/CronJob (see existing `src/jobs/*.job.ts`), Jest (DI mocks).

**Scope — IN:** connector `createGlobalInvoice`, `buildGlobalInvoiceParams`, `cfdiGlobal.service.ts`, cron job + `server.ts` registration,
dashboard trigger endpoint + route + ActivityLog, tests. **OUT:** dashboard UI (other repo); a write MCP tool (customer MCP is read-only —
see MCP note). Design: spec §7.5 (global).

**Reference rules:** `.claude/rules/critical-warnings.md` (tenant isolation, money=integer cents, Spanish), `.claude/rules/cron-jobs.md`
(**MUST** wrap the cron's entry DB read in `retry(fn, shouldRetryDbConnectionError)` — no global Prisma retry),
`.claude/rules/testing-and-git.md` (NEVER commit; do NOT touch `src/mcp/**`).

> **Coordination:** founder co-develops fiscal in parallel — do NOT `git commit`/branch/worktree, do NOT touch `src/mcp/**`,
> `reservation.public.controller.ts`, `sales-summary*`. Read the CURRENT `cfdi.service.ts` (`validateBeforeStamp` already takes `isGlobal`;
> `resolveFiscalProvider`, `assembleSaleInput`, `buildCreateInvoiceParams`, the `FiscalProvider` interface, `facturapi.provider.ts`) before
> writing. Reuse `validateBeforeStamp({..., isGlobal:true})`.

---

### Schema facts (verified, no migration)

- `Cfdi.isGlobal Boolean`, `Cfdi.globalPeriod Json?` (`{ periodicidad, meses, anio }`), `Cfdi.orderId String?` (null for global),
  `Cfdi.type CfdiType` (use `INGRESO` — a global is still an Ingreso), `Cfdi.flow` (`GLOBAL_C`). Idempotency via
  `Cfdi.idempotencyKey @unique`.
- `FiscalEmisor`: `globalPeriodicity`, `serie`, `lugarExpedicion`, `defaultUsoCfdi`, `csdStatus`, `providerKeyEnc`,
  `merchantConfigs MerchantFiscalConfig[]`.
- `MerchantFiscalConfig`: `includeInGlobal Boolean @default(true)`, `facturacionEnabled`, `merchantAccountId`/`ecommerceMerchantId`,
  `fiscalEmisorId`.
- Reach orders from an emisor: emisor → `merchantConfigs` (includeInGlobal && facturacionEnabled) → each merchant's `Payment`s (status
  COMPLETED) in the period → `Order` (paymentStatus PAID).

---

### Task 1: Connector — `createGlobalInvoice`

**Files:** `src/services/fiscal/providers/fiscal-provider.interface.ts`, `facturapi.provider.ts`. **VERIFY the facturapi global shape**
against the installed SDK types (`node_modules/facturapi`) / docs before coding (use context7 `facturapi` or read the SDK `.d.ts`).

- [ ] **Step 1:** add to the `FiscalProvider` interface:
  ```typescript
  createGlobalInvoice(params: GlobalInvoiceParams): Promise<StampedInvoice>
  ```
  where `GlobalInvoiceParams` carries: the público-general receptor (`legal_name:'PÚBLICO EN GENERAL'`, `tax_id:'XAXX010101000'`,
  `tax_system:'616'`, `address.zip = emisor.lugarExpedicion`), `items[]`, `payment_form`, `use:'S01'`, `serie?`, and
  `global:{ periodicity, months, year }`.
- [ ] **Step 2:** implement in `facturapi.provider.ts`. Expected facturapi call (CONFIRM exact keys against the SDK — facturapi uses
      `periodicity` ∈ `day|week|fortnight|month|two_months`, `months` as the SAT `c_Meses` code, `year`):
  ```typescript
  const inv = await this.client.invoices.create({
    type: 'I',
    customer: { legal_name: 'PÚBLICO EN GENERAL', tax_id: 'XAXX010101000', tax_system: '616', address: { zip } },
    use: 'S01',
    items,
    payment_form,
    ...(serie ? { series: serie } : {}),
    global: { periodicity, months, year },
  })
  ```
  Map the SAT periodicity (our enum DIARIO/SEMANAL/QUINCENAL/MENSUAL/BIMESTRAL) → facturapi's value + SAT `c_Periodicidad` (01/02/03/04/05).
  Reuse the existing `downloadXml/downloadPdf/getInvoice` unchanged. **Do NOT forward idempotency to facturapi** (it rejects it — we own
  idempotency).

---

### Task 2: Payload builder + period helper

**Files:** `src/services/fiscal/cfdiPayloadBuilder.ts` (or a new `globalPeriod.ts` for the date math — keep functions pure/testable).

- [ ] **Step 1: `buildGlobalInvoiceParams(emisor, lines, period)`** — pure. One **line per order** (ticket):
      `{ description: 'Venta', product_key:'01010101'     (ClaveProdServ "no existe en el catálogo"/global), unit_key:'ACT', quantity:1, price: order total in PESOS, tax_included:true }`
      (POS prices are NET — mirror the per-item tax logic already in `buildCreateInvoiceParams`; reuse helpers, don't re-derive). Sum must
      cuadrar al centavo (integer cents).
- [ ] **Step 2: `closedPeriodFor(periodicity, now)`** — pure: given the emisor periodicity + a reference `Date` (pass it in — `Date.now()`
      is unavailable in services-under-cron only via the job; here accept `now` as a param so it's testable), return
      `{ periodStart, periodEnd, meses, anio, satPeriodicidad }` for the **most-recent fully-closed** period (e.g. MENSUAL on Jun 3 → May
      1..Jun 1, meses '05', anio 2026). Mexico TZ boundaries via `date-fns-tz`.

---

### Task 3: Global service `issueGlobalForEmisor`

**Files:** NEW `src/services/fiscal/cfdiGlobal.service.ts`. Same DI pattern as `cfdi.service.ts` (`IssueGlobalDeps` with
`findExistingGlobal`, `loadGlobalCandidates`, `resolveProvider`, `storeArtifact`, `persistCfdi`; real `defaultDeps` use prisma/storage;
tests inject mocks).

- [ ] **Step 1:** `issueGlobalForEmisor({ emisorId, now, sandbox }, deps)`:
  1. Resolve emisor (`globalPeriodicity`, `serie`, `lugarExpedicion`, `csdStatus`, `providerKeyEnc`, `venueId`). If `csdStatus !== 'ACTIVE'`
     → skip (return `{ status:'SKIPPED', reason:'CSD inactivo' }`).
  2. `period = closedPeriodFor(emisor.globalPeriodicity, now)`.
  3. **Idempotency:** `idempotencyKey = cfdi-global-${emisorId}-${anio}-${meses}-${periodicidad}`. `findExistingGlobal(key)` STAMPED →
     return it.
  4. `loadGlobalCandidates(emisorId, periodStart, periodEnd)` — orders that are PAID, settled (payment COMPLETED) via a merchant under this
     emisor with `includeInGlobal && facturacionEnabled`, **and have NO `Cfdi` with status STAMPED** (exclude already individually-invoiced
     — `LEFT JOIN`/`NOT EXISTS`). Return `[{ orderId, orderNumber, subtotalCents, taxCents, totalCents, items? }]`.
  5. If **zero** candidates → return `{ status:'NOTHING_TO_INVOICE' }` (do NOT stamp an empty global).
  6. `buildGlobalInvoiceParams(emisor, lines, period)` → `validateBeforeStamp({ ..., isGlobal:true })` (XAXX is allowed here). On invalid →
     persist a `VALIDATION_FAILED` global Cfdi + return reasons.
  7. `resolveProvider(emisor,{sandbox}).createGlobalInvoice(params)` → store XML/PDF →
     `persistCfdi({ venueId, fiscalEmisorId:emisorId, orderId:null, isGlobal:true, type:'INGRESO', flow:'GLOBAL_C', status:'STAMPED', idempotencyKey, globalPeriod:{periodicidad,meses,anio}, receptorRfc:'XAXX010101000', receptorNombre:'PÚBLICO EN GENERAL', receptorRegimen:'616', receptorCp: emisor.lugarExpedicion, usoCfdi:'S01', formaPago, metodoPago:'PUE', subtotalCents, taxCents, totalCents, ...stampedFields })`.
     On PAC error → persist `STAMP_FAILED`.
- [ ] **Step 2:** export `issueGlobalForEmisor`. Keep money in **integer cents**; reconcile the sum across lines exactly.

> **Double-invoice safety:** candidates exclude any order already STAMPED (individual). The window is the **closed** period; Plan 5
> autofactura only allows **same-month/current** tickets. For ≥monthly periodicity these windows never overlap. Sub-monthly (DIARIO/SEMANAL)
> has a bounded residual overlap — documented; a Phase-2 refinement is to stamp per-order "covered-by-global" markers. Do NOT silently
> ignore: `log()` the candidate count + period.

---

### Task 4: Cron job

**Files:** NEW `src/jobs/cfdiGlobal.job.ts`, register in `src/server.ts` (mirror an existing `new CronJob(...).start()`).

- [ ] **Step 1:** schedule daily (e.g. `0 4 * * *` Mexico TZ). Handler: load all emisores with `csdStatus:'ACTIVE'` — **wrap this entry DB
      read in `retry(fn, shouldRetryDbConnectionError)`** (cron-jobs rule, prevents top-of-hour P1001 stampede). For each emisor, call
      `issueGlobalForEmisor({ emisorId,     now: new Date(), sandbox: env.NODE_ENV !== 'production' })` inside a per-emisor try/catch (one
      emisor's failure must not abort the rest). `logger.info` a summary `{ emisorId, status, period, count }`.
- [ ] **Step 2:** register in `src/server.ts` alongside the other jobs; guard with the same env flag pattern other jobs use (don't start in
      test).

---

### Task 5: Admin manual-trigger endpoint

**Files:** `src/controllers/dashboard/cfdi.dashboard.controller.ts` (+ `src/routes/dashboard.routes.ts`).

- [ ] **Step 1:** `triggerGlobalCfdiController` — `POST /api/v1/dashboard/venues/:venueId/fiscal/emisores/:emisorId/global`. Gated by
      `checkFeatureAccess('CFDI')` + `checkPermission('cfdi:configure')` (reuse — OWNER/ADMIN). Tenant: confirm the emisor belongs to
      `authContext.venueId` (`prisma.fiscalEmisor.findFirst({ where:{ id:emisorId, venueId } })` → 404 if not). Call
      `issueGlobalForEmisor({ emisorId, now:new Date(), sandbox })`. Map:
      `NOTHING_TO_INVOICE → 200 { status, message:'No hay tickets por facturar en el periodo.' }`; `SKIPPED → 409`;
      `VALIDATION_FAILED → 422`; `STAMP_FAILED → 502`; STAMPED → `201 { cfdi:{ id, uuid, serie, folio, globalPeriod, pdfUrl } }`.
- [ ] **Step 2: ActivityLog** on STAMPED:
      `action:'CFDI_GLOBAL_ISSUED', entity:'Cfdi', entityId, staffId: authContext.userId, venueId, data:{ emisorId, period, count, uuid }`.
- [ ] **Step 3:** register the route next to the other `fiscal/emisores` routes with the standard middleware chain (`authenticateToken` →
      `checkFeatureAccess('CFDI')` → `checkPermission('cfdi:configure')` → controller). No new permission needed (reuse `cfdi:configure`).

---

### Task 6: Tests + audit (NO commit)

- [ ] `cfdiGlobal.service.test.ts` (DI mocks): zero candidates → NOTHING_TO_INVOICE, never stamps; candidates present → one global stamped,
      `orderId:null`, `isGlobal:true`, `globalPeriod` set, receptor XAXX; idempotent (existing STAMPED global for the period → no re-stamp);
      excludes an order that has a STAMPED individual Cfdi; inactive CSD → SKIPPED; PAC error → STAMP_FAILED persisted.
- [ ] `globalPeriod.test.ts` (pure): `closedPeriodFor` for each periodicity returns correct closed bounds + SAT
      `meses`/`anio`/`periodicidad` (Mexico TZ).
- [ ] connector global test (mock facturapi client): `createGlobalInvoice` sends the `global` object + XAXX customer, does NOT send
      idempotency.
- [ ] controller test: trigger happy path → 201 + ActivityLog; foreign emisor → 404; nothing-to-invoice → 200.
- [ ] `validateBeforeStamp` global path already covered (Plan 4) — add a regression asserting XAXX passes when `isGlobal:true`.
- [ ] **Audit:** `npm run audit:permissions` exit 0 (reusing `cfdi:configure` — no new PHANTOM); `npm run format && npm run lint:fix`;
      `npm run build` exit 0; `npm test -- tests/unit/services/fiscal tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts`
      ALL green.
- [ ] DO NOT commit.

---

## MCP note (CRITICAL rule compliance)

The customer MCP (`src/mcp/`) is **read-only**; the resulting global CFDIs are already visible through the existing `cfdi_status` tool
(venue-scoped, lists recent CFDIs incl. `isGlobal`). The manual trigger is an **operator write** action — the customer MCP has no write
tools yet by design, so this plan adds none. When write tools are introduced, add a `trigger_global_cfdi` tool mirroring this endpoint (same
`cfdi:configure` gate). **Do NOT touch `src/mcp/**`.\*\*

## Self-review

**Spec coverage:** admin-defined cadence drives the sweep (`globalPeriodicity`) ✓; one global per closed period to XAXX ✓; only
`includeInGlobal` merchants under the emisor ✓; excludes individually-invoiced orders ✓ (no double-invoice with Flow B/A); idempotent per
period ✓; manual trigger for OWNER/ADMIN ✓; ActivityLog ✓; cron retry-wrapped ✓; integer-cents reconciliation ✓; no migration (schema
pre-built) ✓. **Behavior to flag:** empty period stamps nothing; inactive CSD skips; sub-monthly periodicity has a bounded, documented
autofactura-overlap window. **Type consistency:** reuses `validateBeforeStamp(isGlobal)`, `StampedInvoice`, `CfdiFlow.GLOBAL_C`,
`CfdiType.INGRESO`; period math is pure + injectable `now` for tests.
