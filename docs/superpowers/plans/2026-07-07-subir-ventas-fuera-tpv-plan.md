# Subir ventas aprobadas fuera de TPV — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a PlayTelecom OWNER bulk-upload an Excel/CSV of SIM sales made outside the TPV, creating complete, already-approved sales in Avoqado (SIM `AVAILABLE`→`SOLD` + Order + Payment + `SaleVerification` COMPLETED + attribution to seller/store).

**Architecture:** New org-scoped backend endpoint with a two-phase (preview → apply) bulk flow. Each row creates one shadow `MANUAL_ENTRY` Order + OrderItem + Payment, calls the existing `markAsSold`, and creates a `SaleVerification` landing COMPLETED — all in one transaction per row, idempotent (skip if the SIM is already SOLD), per-row error-isolated. Dashboard reuses the existing `BulkUploadSection` drag-and-drop. Single-sale MCP tool for lockstep.

**Tech Stack:** Express + TypeScript + Prisma (backend, jest); React 18 + Vite + TanStack Query (dashboard, vitest). Excel parse via `xlsx` (already a dependency — verify with `npm ls xlsx`; if absent, plan adds it in Task 9).

Spec: `docs/superpowers/specs/2026-07-07-subir-ventas-fuera-tpv-design.md`.

## Global Constraints

- **Money in PESOS, `Prisma.Decimal`, 1:1.** Never `* 100`. `Monto "No aplica"` → `Decimal(0)`. (`.claude/rules/critical-warnings.md`)
- **Dates venue-local → UTC** via `fromZonedTime(\`${dateStr}T12:00:00\`, venueTz)` — pass a STRING, noon anchor. NEVER `new Date('YYYY-MM-DD')`.
- **`authContext` is `(req as any).authContext`** = `{ userId, orgId, venueId, role }`. NEVER `req.user`.
- **Tenant isolation:** every query scoped by `organizationId` (org endpoint). Resolve ICCID/seller/store only within the URL org.
- **Zod messages Spanish only** (shown to users).
- **Never hardcode `venue.slug === 'playtelecom'`** — gate by `moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)`.
- **Serial case:** match ICCID case-insensitively (`mode: 'insensitive'`) — legacy lowercase rows exist.
- **Audit:** every created sale dual-writes `ActivityLog` (`MANUAL_SALE_CREATED`) + `SerializedItemCustodyEvent` (MARKED_SOLD). `logAction` is fire-and-forget, OUTSIDE the tx.
- **Migrations:** `npx prisma migrate dev --name ...` — NEVER `db push`. (This plan needs NO schema change — see Task 4 note.)
- **New permission full mirror:** catalog + defaults + backend gate + dashboard gate + `npm run audit:permissions` exit 0. (`.claude/rules/permissions-policy.md`)
- **Git:** do NOT commit without the founder's explicit OK. Per-task "Commit" steps are gated on that standing permission — if not granted, stage only and pause.
- After editing TS: `npm run format && npm run lint:fix` (server) / `npx eslint --fix` (dashboard).

---

# Phase 1 — Backend (`avoqado-server`)

### Task 1: Permission `manual-sales:create`

**Files:**
- Modify: `src/lib/permissions.ts` (`INDIVIDUAL_PERMISSIONS_BY_RESOURCE` + `DEFAULT_PERMISSIONS`)

**Interfaces:**
- Produces: permission string `'manual-sales:create'` used by Task 6 (`checkPermission`) and Phase 2 (`PermissionGate`).

- [ ] **Step 1:** In `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`, add under a `manual-sales` resource key: `{ resource: 'manual-sales', actions: ['create'] }` (match the exact shape of a neighboring entry in the file).
- [ ] **Step 2:** In `DEFAULT_PERMISSIONS`, add `'manual-sales:create'` to `OWNER` and `SUPERADMIN` role arrays (mirror how an existing `sale-verifications:*` perm is listed).
- [ ] **Step 3:** Run `npm run audit:permissions`. Expected: exit 0, no PHANTOM for `manual-sales:create`.
- [ ] **Step 4:** Commit `feat(permissions): add manual-sales:create (OWNER, SUPERADMIN)`.

### Task 2: Row Zod schema + input types

**Files:**
- Create: `src/schemas/dashboard/manualSale.schema.ts`
- Test: `tests/unit/schemas/manualSale.schema.test.ts`

**Interfaces:**
- Produces: `ManualSaleRowInput` (one row), `BulkManualSalesInput = { rows: ManualSaleRowInput[]; confirm?: boolean }`, and `manualSaleRowSchema`, `bulkManualSalesSchema`.

`ManualSaleRowInput` fields (raw values from the sheet, resolved later in Task 3):
```ts
{
  iccid: string            // "ID SIM"
  promoterCode: string     // "ID Promotor" (employeeCode); may be empty → fallback promoterName
  promoterName?: string
  storeId?: string         // "ID Tienda" numeric-in-name
  storeName: string        // "Nombre de la Tienda"
  saleDate: string         // "Fecha" YYYY-MM-DD (venue-local calendar day)
  saleType: string         // "Tipo de Venta" — "Línea nueva" | "Portabilidad"
  paymentForm: string      // "Forma de Pago" — "Efectivo" | "Tarjeta" | "No aplica" | ...
  amount: string | number  // "Monto de Venta" — number or "No aplica"
  simType?: string         // "Tipo de SIM" / "Categoría"
}
```

- [ ] **Step 1: Write the failing test**
```ts
import { manualSaleRowSchema } from '@/schemas/dashboard/manualSale.schema'
describe('manualSaleRowSchema', () => {
  it('accepts a valid row', () => {
    const r = { iccid: '8952140063677014972F', promoterCode: 'BSCLOXH0405', storeName: 'BAE MUÑOZ SLP (898)', saleDate: '2026-06-24', saleType: 'Línea nueva', paymentForm: 'No aplica', amount: 'No aplica', simType: 'SIM de intercambio' }
    expect(manualSaleRowSchema.parse(r).iccid).toBe('8952140063677014972F')
  })
  it('rejects an empty iccid with a Spanish message', () => {
    expect(() => manualSaleRowSchema.parse({ iccid: '', storeName: 'X', saleDate: '2026-06-24', saleType: 'Línea nueva', paymentForm: 'No aplica', amount: '0' }))
      .toThrow(/ICCID/i)
  })
})
```
- [ ] **Step 2:** Run `npx jest tests/unit/schemas/manualSale.schema.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement.** `iccid: z.string().min(5, 'El ICCID es requerido')`, `saleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (usa AAAA-MM-DD)')`, `amount: z.union([z.number(), z.string()])`, `paymentForm: z.string()`, `saleType: z.string()`, rest as shown (optionals `.optional()`). `bulkManualSalesSchema = z.object({ rows: z.array(manualSaleRowSchema).min(1, 'Sube al menos una venta'), confirm: z.boolean().optional() })`.
- [ ] **Step 4:** Run the test → PASS. Then `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(manual-sales): row + bulk zod schema`.

### Task 3: Resolver helpers (ICCID / seller / store / category / paymentForm / amount)

**Files:**
- Create: `src/services/dashboard/manualSale.resolvers.ts`
- Test: `tests/unit/services/dashboard/manualSale.resolvers.test.ts`

**Interfaces:**
- Consumes: `ManualSaleRowInput` (Task 2).
- Produces:
  - `resolveIccid(orgId, iccid, tx): Promise<{ item: SerializedItem } | { error: string }>` — case-insensitive; requires `status==='AVAILABLE'` and `organizationId===orgId`; error strings: `'ICCID no existe'`, `'ICCID ya vendido'`, `'ICCID pertenece a otra organización'`.
  - `resolveStaffByCode(orgId, code, name, tx): Promise<{ staff } | { error: 'Vendedor no encontrado' }>` — match `employeeCode` (insensitive), fallback normalized `firstName+lastName`, must have a `StaffVenue`/`StaffOrganization` in org.
  - `resolveVenue(orgId, storeName, storeId, tx): Promise<{ venue } | { error: 'Tienda no encontrada' }>` — match by trailing `(NNNN)` number in name, else `name`/`slug` (insensitive), scoped to org.
  - `resolveCategory(orgId, simType, tx): Promise<{ categoryId: string } | { error: 'Categoría no encontrada' }>` — org-level `ItemCategory` by name (insensitive); if `simType` empty, use the item's existing `categoryId` (SIMs always have one).
  - `mapPaymentForm(raw): { method: PaymentMethod; amountApplies: boolean }` — `Efectivo→CASH`, `Tarjeta/Débito/Crédito→CARD` (use the real enum value), `No aplica→OTHER, amountApplies:false`, else `OTHER`.
  - `parseAmount(raw, amountApplies): Prisma.Decimal` — `"No aplica"` or `!amountApplies` → `Decimal(0)`; numeric string/number → `new Prisma.Decimal(raw)`.

- [ ] **Step 1: Write failing tests** for each resolver's happy + key error path (in-memory Prisma mocks). Example:
```ts
it('resolveIccid: available org item matches case-insensitively', async () => {
  const tx = mockTx({ serializedItem: { findFirst: async () => ({ id: 'si1', status: 'AVAILABLE', organizationId: 'org1', serialNumber: '8952...F' }) } })
  const r = await resolveIccid('org1', '8952...f', tx as any)   // lowercase input
  expect('item' in r && r.item.id).toBe('si1')
})
it('resolveIccid: already-sold → error', async () => {
  const tx = mockTx({ serializedItem: { findFirst: async () => ({ id: 'si1', status: 'SOLD', organizationId: 'org1' }) } })
  expect(await resolveIccid('org1', 'x', tx as any)).toEqual({ error: 'ICCID ya vendido' })
})
it('parseAmount: "No aplica" → 0', () => { expect(parseAmount('No aplica', false).toString()).toBe('0') })
```
- [ ] **Step 2:** Run tests → FAIL.
- [ ] **Step 3: Implement** the six resolvers per the Interfaces block. For `resolveIccid` use `tx.serializedItem.findFirst({ where: { organizationId: orgId, serialNumber: { equals: iccid.trim(), mode: 'insensitive' } } })` then branch on `status`.
- [ ] **Step 4:** Run tests → PASS. `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(manual-sales): row resolvers (iccid/staff/venue/category/payment)`.

### Task 4: Core `createOneManualSale` (single row → full approved sale, in a tx)

**Files:**
- Create: `src/services/dashboard/manualSale.service.ts`
- Test: `tests/unit/services/dashboard/manualSale.service.test.ts`

> **Schema note:** NO migration. Reuse `Order.type='MANUAL_ENTRY'` + `source='DASHBOARD_MANUAL'` (existing enum values), tag `posRawData.manualSerializedSale=true` so reports can distinguish. KDS already filters out `MANUAL_ENTRY`, so attaching an OrderItem is operationally safe.

**Interfaces:**
- Consumes: resolvers (Task 3); `serializedInventoryService.markAsSold(venueId, serial, orderItemId, tx, { staffId })` → `{ item }`; the shadow-order shape from `manualPayment.service.ts:234-322`.
- Produces: `createOneManualSale(orgId, actorStaffId, row: ManualSaleRowInput): Promise<{ ok: true; orderId: string; verificationId: string; venueId: string } | { ok: false; error: string }>`.

Implementation (inside `prisma.$transaction`):
1. `resolveIccid` → item (target `venueId = resolved venue`, see step 3; the SIM is org-level so `sellingVenueId` gets set by `markAsSold`).
2. `resolveVenue`, `resolveStaffByCode`, `resolveCategory`, `mapPaymentForm`, `parseAmount`. On ANY `{ error }` → return `{ ok:false, error }` (tx auto-rolls back — nothing created yet).
3. `const soldAt = fromZonedTime(\`${row.saleDate}T12:00:00\`, venueTz)` (venueTz from the resolved venue; fallback `'America/Mexico_City'`).
4. Create Order: `{ venueId, orderNumber: \`ORD-EXT-${Date.now()}-${rand}\`, type:'MANUAL_ENTRY', source:'DASHBOARD_MANUAL', status:'COMPLETED', paymentStatus: amount.gt(0)?'PAID':'PAID', subtotal: amount, total: amount, paidAmount: amount, remainingBalance: Decimal(0), completedAt: soldAt, createdAt: soldAt, createdById: actorStaffId, servedById: sellerStaffId, posRawData: { manualSerializedSale: true, recordedByStaffId: actorStaffId, iccid, storeName: row.storeName } }`.
5. Create OrderItem for the SIM: `{ orderId, name: row.simType ?? 'SIM', quantity: 1, unitPrice: amount, total: amount, productSku: iccid }` (match the OrderItem fields the TPV serialized path uses — verify against `order.tpv.service.ts:3077` context; `productSku` carries the serial).
6. `await serializedInventoryService.markAsSold(venueId, iccid, orderItem.id, tx, { staffId: sellerStaffId })`.
7. Create Payment: `{ venueId, orderId, amount, method, source:'DASHBOARD_MANUAL', status: 'COMPLETED', processedById: actorStaffId, feePercentage: Decimal(0), feeAmount: Decimal(0), netAmount: amount, processorData: { manualSerializedSale: true } }`.
8. Create SaleVerification **COMPLETED** directly (NOT `createPendingSaleVerification`, which hardcodes PENDING): `{ venueId, paymentId, staffId: sellerStaffId, photos: [], scannedProducts: [], status: 'COMPLETED', inventoryDeducted: false, isPortabilidad: /portabilidad/i.test(row.saleType), serialNumbers: [normalizedIccid], reviewedById: actorStaffId, reviewedAt: soldAt }` (match the exact `SaleVerification` field names, incl. the reviewer field, from `sale-verification.org.dashboard.service.ts` `reviewSaleVerification`).
9. Return `{ ok:true, orderId, verificationId, venueId }`. AFTER the tx: `void logAction({ action:'MANUAL_SALE_CREATED', entity:'Order', entityId: orderId, staffId: actorStaffId, venueId, data:{ iccid, sellerStaffId, storeName: row.storeName, amount: amount.toString() } })` and write a `SerializedItemCustodyEvent` (MARKED_SOLD, `actorStaffId`) mirroring `temp-mark-sim-sold.ts`.

- [ ] **Step 1: Write failing test** — happy path creates all 4 records + returns ok; error path (`resolveIccid` returns error) returns `{ ok:false }` and creates nothing. Mock resolvers + `markAsSold`; assert `tx.order.create`, `tx.payment.create`, `tx.saleVerification.create` called once each with COMPLETED status and pesos amount.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement per the steps above.
- [ ] **Step 4:** Run → PASS. `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(manual-sales): create one approved external sale (tx + audit)`.

### Task 5: Bulk orchestrator (preview + apply, idempotent, per-row isolated)

**Files:**
- Modify: `src/services/dashboard/manualSale.service.ts`
- Test: `tests/unit/services/dashboard/manualSale.bulk.test.ts`

**Interfaces:**
- Consumes: `createOneManualSale` (Task 4); resolvers for the dry preview.
- Produces: `bulkManualSales(orgId, actorStaffId, rows, apply: boolean): Promise<{ crear: RowResult[]; omitir: RowResult[]; error: RowResult[]; created?: number }>` where `RowResult = { index: number; iccid: string; storeName: string; motivo?: string }`.

Behavior:
- Dedup input rows by normalized ICCID (keep first; extras → `omitir` motivo `'ICCID duplicado en el archivo'`).
- **Preview (`apply=false`):** run all resolvers per row WITHOUT writing → classify each into `crear` / `omitir` (`'ICCID ya vendido'`) / `error` (resolver error string).
- **Apply (`apply=true`):** for each row call `createOneManualSale`; `{ok:true}`→`crear`, `{ok:false, error:'ICCID ya vendido'}`→`omitir`, other `{ok:false}`→`error`. Each row is its own tx (Task 4) → one bad row never rolls back the others. `created = crear.length`.

- [ ] **Step 1: Write failing tests:** (a) preview classifies available→crear, sold→omitir, missing-seller→error; (b) apply with 2 good + 1 sold → `created===2`, `omitir.length===1`; (c) duplicate ICCID in file → second is `omitir`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(manual-sales): bulk preview + apply orchestrator`.

### Task 6: Controller + org-scoped route (preview + apply)

**Files:**
- Create: `src/controllers/dashboard/manualSale.controller.ts`
- Modify: `src/routes/dashboard/organizationDashboard.routes.ts` (mount 2 routes; reuse exported `requireOrgOwner` at `:75`)
- Test: `tests/api-tests/dashboard/manualSale.api.test.ts`

**Interfaces:**
- Consumes: `bulkManualSales` (Task 5), `bulkManualSalesSchema` (Task 2), `moduleService.isModuleEnabled`.
- Routes (org-scoped, under existing `/organizations/:orgId`):
  - `POST /organizations/:orgId/manual-sales/preview` → `bulkManualSales(orgId, actor, rows, false)`
  - `POST /organizations/:orgId/manual-sales` (body `{ rows, confirm:true }`) → `bulkManualSales(orgId, actor, rows, true)`

- [ ] **Step 1:** Controller: read `const { orgId } = req.params; const { userId: actorStaffId } = (req as any).authContext`. Resolve a venue in the org to check `isModuleEnabled(SERIALIZED_INVENTORY)` (reuse the org module-gate helper already used by `organizationStockControl.routes.ts`); if not enabled → `403 { error: 'Módulo de inventario serializado no habilitado' }`. Call the service, `res.json({ success:true, data })`.
- [ ] **Step 2:** Routes: `router.post('/organizations/:orgId/manual-sales/preview', authenticateTokenMiddleware, requireOrgOwner, checkPermission('manual-sales:create'), validateRequest(bulkManualSalesSchema), ctrl.preview)` and the sibling `POST .../manual-sales` → `ctrl.apply`. Mount BEFORE any `:someId` param route that could shadow `manual-sales`.
- [ ] **Step 3: API test:** (a) OWNER preview returns classified rows; (b) apply creates sales (assert DB: SerializedItem SOLD + SaleVerification COMPLETED); (c) non-OWNER → 403; (d) cross-org ICCID → row `error`; (e) org without module → 403.
- [ ] **Step 4:** Run `npx jest tests/api-tests/dashboard/manualSale.api.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(manual-sales): org preview + apply endpoints (OWNER + module gate)`.

### Task 7: MCP tool `record_serialized_sale` (single, confirm-gated)

**Files:**
- Create: `src/mcp/tools/manualSale.ts`
- Modify: `src/mcp/server.ts` (register)
- Test: `tests/unit/mcp-customer/manualSale.tool.test.ts`

**Interfaces:**
- Consumes: `createOneManualSale` (Task 4), the MCP `guard` (requirePermission/venueFilter/auditMcpWrite) — match the shape in `src/mcp/tools/inventory.ts` (`mark_serialized_item`).

- [ ] **Step 1:** Tool `record_serialized_sale`: input `{ iccid, promoterCode|promoterName, storeName, saleDate, saleType, paymentForm, amount, simType?, confirm? }`. `guard.requirePermission('manual-sales:create')` + `guard.venueFilter()`. DEFAULT preview (`confirm` omitted) → return human-readable Spanish preview (`Voy a registrar la venta del SIM <iccid> a <vendedor> en <tienda> por $<monto>. Confirma con confirm:true.`). `confirm:true` → `createOneManualSale` + `auditMcpWrite`. Money in pesos, date venue-local.
- [ ] **Step 2:** Register in `src/mcp/server.ts` next to the other serialized tools.
- [ ] **Step 3: Test:** preview returns `requiresConfirmation:true`; confirm path calls `createOneManualSale`.
- [ ] **Step 4:** Run test → PASS. `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(mcp): record_serialized_sale (confirm-gated external SIM sale)`.

### Task 8: Backend verification gate

- [ ] **Step 1:** `npm run format && npm run lint:fix`.
- [ ] **Step 2:** `npm test` (full) → green. `npx tsc --noEmit` → 0.
- [ ] **Step 3:** `npm run audit:permissions` → exit 0.
- [ ] **Step 4:** `npm run pre-deploy` → green.
- [ ] **Step 5:** Commit any format/lint deltas `chore(manual-sales): format + lint`.

---

# Phase 2 — Dashboard (`avoqado-web-dashboard`)

### Task 9: Service client + Excel parse + template

**Files:**
- Create: `src/services/manualSale.service.ts`
- Test: `src/services/__tests__/manualSale.service.test.ts`

**Interfaces:**
- Produces: `parseSalesFile(file): ManualSaleRow[]` (xlsx → rows, mapping the Spanish column headers from spec §4), `previewManualSales(orgId, rows)`, `applyManualSales(orgId, rows)` (POST to the Task 6 endpoints, `/api/v1/` prefix), `downloadTemplate()` (generate an .xlsx with the exact headers).

- [ ] **Step 1:** Verify `xlsx` is installed (`npm ls xlsx`); if not, `npm i xlsx`.
- [ ] **Step 2: Failing test:** `parseSalesFile` maps a sheet with headers `ID SIM, ID Promotor, Nombre de la Tienda, Fecha, Tipo de Venta, Forma de Pago, Monto de Venta, Tipo de SIM` → array of typed rows (dates → `YYYY-MM-DD`).
- [ ] **Step 3:** Implement parse (header-name → field map, skip the 1 blank leading row + header row as in Isaac's file) + the two POST clients + `downloadTemplate`.
- [ ] **Step 4:** Run test → PASS. `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(manual-sales): dashboard service client + xlsx parse + template`.

### Task 10: Upload page (reuse `BulkUploadSection`) + preview + confirm

**Files:**
- Create: `src/pages/playtelecom/ManualSales/ManualSalesUpload.tsx`
- Test: `src/pages/playtelecom/ManualSales/__tests__/ManualSalesUpload.test.tsx`

**Interfaces:**
- Consumes: `parseSalesFile`, `previewManualSales`, `applyManualSales` (Task 9); `BulkUploadSection` (`src/pages/playtelecom/Stock/components/BulkUploadSection.tsx`).

- [ ] **Step 1:** Page flow: `<BulkUploadSection onUpload={...}>` → on file, `parseSalesFile` → `previewManualSales` → render a table (columns: ICCID · Vendedor · Tienda · Fecha · Monto · Estado[crear ✅ / omitir ⏭️ / error ❌ + motivo]) → "Crear N ventas" button (disabled if `crear.length===0`) → `applyManualSales` → result summary (creadas/omitidas/errores). Wrap page in `<PermissionGate permission="manual-sales:create">`. "Descargar template" button → `downloadTemplate()`.
- [ ] **Step 2: Test (vitest + RTL):** upload a mock file → preview table shows the 3 buckets; clicking "Crear" calls `applyManualSales`; summary renders counts. Mock the service.
- [ ] **Step 3:** Run `npx vitest run src/pages/playtelecom/ManualSales` → PASS. `npx tsc --noEmit`.
- [ ] **Step 4:** Commit `feat(manual-sales): upload page (preview + confirm + summary)`.

### Task 11: Route + sidebar entry + verify

**Files:**
- Modify: `src/routes/router.tsx` (mount under the PlayTelecom org/venue routes, `ModuleProtectedRoute requiredModule="SERIALIZED_INVENTORY"`)
- Modify: the PlayTelecom sidebar (`src/pages/organizations/components/WLOrgSidebar.tsx` and/or `src/pages/playtelecom/*Layout` sidebar) — add "Subir ventas fuera de TPV" entry, `PermissionGate`.
- Modify: `src/config/feature-registry.ts` (register the page, per the white-label feature rule).

- [ ] **Step 1:** Add the lazy import + route (path e.g. `manual-sales`) mirroring how `PlayTelecomStock` is mounted; gate by module + `manual-sales:create`.
- [ ] **Step 2:** Add the sidebar link (i18n keys en/es) using `fullBasePath`/`basePath` — NEVER hardcode `/venues/`.
- [ ] **Step 3:** `npm run build && npm run lint` → green. `npm run test:e2e` (happy path if a spec exists, else smoke via Playwright mount).
- [ ] **Step 4:** Commit `feat(manual-sales): route + sidebar entry + feature registry`.

---

## Self-Review (coverage vs spec)

- Spec §2 decisions (Excel upload / COMPLETED / permission-no-tier) → Task 6 (endpoint bulk), Task 4 (SaleVerification COMPLETED), Task 1 (permission, no tier). ✓
- Spec §4 columns/resolution → Task 3 resolvers + Task 9 parse. ✓
- Spec §5.1 backend (preview/apply, per-row tx, reuse markAsSold/MANUAL_ENTRY/SaleVerification) → Tasks 4-6. ✓
- Spec §5.2 dashboard (BulkUploadSection, preview table, template) → Tasks 9-11. ✓
- Spec §5.3 MCP → Task 7. ✓
- Spec §6 edge cases (monto "No aplica"→0, ICCID not found/sold/other-org, dup rows, bad date) → Task 3 (`parseAmount`/`resolveIccid`) + Task 5 (dedup) + Task 2 (date regex). ✓
- Spec §8 backlog of 342 → loaded via the same upload (Task 10). ✓
- Spec §9 permission mirror → Task 1 + Task 6 gate + Task 10 `PermissionGate` + Task 8 audit. ✓
- Spec §10 tests → per-task jest/vitest + Task 6 api-test + Task 8 pre-deploy. ✓
- Audit dual-write (ActivityLog + custody event) → Task 4 step 9. ✓
- No hardcoded slug (module gate) → Task 6. ✓

**Type consistency:** `ManualSaleRowInput`, `createOneManualSale`, `bulkManualSales`, the two route paths, and the dashboard `parseSalesFile`/`applyManualSales` names are consistent across tasks. Internal helper names in reused files (`markAsSold`, `requireOrgOwner`, SaleVerification reviewer field) are flagged "match the exact signature in the file" because they must be read at implementation time, not invented.

## Execution Handoff

(See chat for execution-mode choice.)
