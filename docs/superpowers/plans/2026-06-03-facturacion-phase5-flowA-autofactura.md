# Facturación CFDI — Phase 5: Flow A (customer self-service autofactura) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps. `critical-warnings.md` auto-loads.

**Goal:** A customer who paid at a venue can **self-invoice their own ticket** from the public digital-receipt page — **only if the merchant
they paid through has `autofacturaEnabled`**. Reuses the Plan-4 issuance engine (`issueCfdiForOrder` with `flow:'AUTOFACTURA_A'`, which
already enforces `facturacionEnabled` + `autofacturaEnabled` and resolves the per-merchant emisor). This plan is the **public surface** +
ownership/window guards around it.

**Architecture:** Public route (`/api/v1/public`) keyed off the existing `DigitalReceipt.accessKey` (the customer already reaches their
receipt via this key). Controller verifies ownership (receipt → payment → order), enforces "paid + same-month + not-already-invoiced", then
delegates to `issueCfdiForOrder`. No auth (public); abuse-gated by a dedicated rate limiter (each stamp costs money).

**Tech Stack:** TypeScript, Express, Prisma, Zod (Spanish, shape-only), Jest (DI mocks).

**Scope — IN:** public autofactura controller + GET status, Zod schema, public route + rate limiter, ActivityLog, tests. **OUT:** the global
job (Plan 6); the dashboard UI (other repo); a new MCP tool (the customer MCP is **read-only**; `cfdi_status` already surfaces the result —
see MCP note). Design: spec §6.1c (merchant gating), §7.4 (autofactura).

**Reference rules:** `.claude/rules/critical-warnings.md` (tenant isolation, authContext, money, Zod-Spanish, storage),
`.claude/rules/testing-and-git.md` (NEVER commit; do NOT touch `src/mcp/**`). `.claude/rules/feature-gating.md` (this is public; gating is
the merchant flag, no Feature/permission).

> **Coordination:** founder co-develops fiscal in parallel — do NOT `git commit`/branch/worktree, do NOT touch `src/mcp/**`,
> `reservation.public.controller.ts`, or `sales-summary*`. Read the CURRENT `issueCfdiForOrder` signature (it takes
> `{ orderId, receptor, sandbox, flow?, expectedVenueId? }`) and the existing dashboard `issueCfdiSchema` before writing — co-locate, don't
> duplicate.

---

### Schema facts (verified, no migration)

- `DigitalReceipt`: `accessKey String @unique`, `paymentId`, `payment Payment`. Reach the order via `payment.order`.
- `Payment`: `status TransactionStatus` (settled = `COMPLETED`), `merchantAccountId`/`ecommerceMerchantId`, `order Order`.
- `Order`: `venueId`, `paymentStatus PaymentStatus` (PAID/PARTIAL/PENDING/REFUNDED), `createdAt`, `orderNumber`.
- `Cfdi`: `orderId`, `status` (STAMPED…), `flow`. `getDigitalReceiptByAccessKey(accessKey)` exists in `digitalReceipt.tpv.service.ts`.
- Public routes mount at `/api/v1/public` (`src/app.ts:121`), with rate limiters `readLimit`/`writeLimit`/`authLimit` already defined in
  `public.routes.ts`.

---

### Task 1: Zod schema for autofactura

**Files:** co-locate with the existing dashboard cfdi schema (find `issueCfdiSchema` — likely `src/schemas/**/cfdi*.ts`). Add
`autofacturaSchema`.

- [ ] **Step 1:** `autofacturaSchema` — `{ body: { rfc, razonSocial, regimenFiscal, codigoPostal, usoCfdi, email } }`. ALL messages
      **Spanish**, **shape-only** (length/format/required). `email` is **required** here (the customer must receive the CFDI) +
      `.email('Correo inválido')`. `rfc` shape only (`min/max`, uppercase) — the real SAT validation stays in `validateBeforeStamp`. Mirror
      the field names of the dashboard `issueCfdiSchema` so the controller bodies match.

---

### Task 2: Public autofactura controller

**Files:** NEW `src/controllers/public/cfdi.public.controller.ts`. Reuse: `issueCfdiForOrder` (`src/services/fiscal/cfdi.service.ts`),
`getDigitalReceiptByAccessKey`, `prisma`, `logAction`, `logger`.

- [ ] **Step 1: `autofacturaController(req, res)`** — `:accessKey` param + validated body. Flow:

  1. Resolve the receipt + order in ONE query (don't trust the snapshot):
     ```typescript
     const receipt = await prisma.digitalReceipt.findUnique({
       where: { accessKey },
       select: {
         payment: { select: { orderId: true, order: { select: { id: true, venueId: true, paymentStatus: true, createdAt: true } } } },
       },
     })
     const order = receipt?.payment?.order
     if (!order) {
       res.status(404).json({ error: 'Recibo no encontrado' })
       return
     }
     ```
  2. `if (order.paymentStatus !== 'PAID') → 409 'La cuenta aún no está pagada.'`
  3. **Same-month window** (Mexico TZ): `order.createdAt` month+year must equal _now_ in `America/Mexico_City` (use `toZonedTime` from
     `date-fns-tz`, compare `getMonth()/getFullYear()`). Else `409 'Solo puedes facturar tickets del mes en curso.'` (SAT: prevents overlap
     with the global sweep, Plan 6).
  4. **Already invoiced**: `prisma.cfdi.findFirst({ where: { orderId: order.id, status: 'STAMPED' } })` →
     `409 'Esta cuenta ya fue facturada.'`
  5. `const result = await issueCfdiForOrder({ orderId: order.id, receptor: req.body, sandbox: env.NODE_ENV !== 'production', flow: 'AUTOFACTURA_A', expectedVenueId: order.venueId })`
  6. Map: `VALIDATION_FAILED → 422 { error:'No se pudo facturar', reasons }`; `STAMP_FAILED → 502 { error:'El SAT rechazó el timbrado' }`;
     else `200 { cfdi: { uuid, serie, folio, pdfUrl, xmlUrl } }`.
  7. `catch`: `/no habilitada/i → 403 { error:'La facturación no está disponible para esta cuenta.' }` (do NOT leak the internal merchant
     message); `/not found/i → 404`; else `500`.
  8. On STAMPED,
     `logAction({ staffId: null, venueId: order.venueId, action:'CFDI_ISSUED', entity:'Cfdi', entityId: result.cfdi.id, data:{ flow:'AUTOFACTURA_A', accessKey, orderId: order.id, uuid: result.cfdi.uuid } })`
     (`logAction` already null-safes `staffId`).

- [ ] **Step 2: `getAutofacturaStatusController(req, res)`** — `GET`; returns the order's STAMPED/most-recent Cfdi if any, so the portal can
      show "ya facturada / descargar": `prisma.cfdi.findFirst({ where:{ order:{ payment???}}})`. Simpler: resolve order via accessKey (same
      first query), then
      `prisma.cfdi.findFirst({ where:{ orderId: order.id }, orderBy:{ createdAt:'desc' }, select:{ uuid, status, serie, folio, pdfUrl } })`.
      Return `{ cfdi: null }` if none. 404 if receipt not found.

---

### Task 3: Route + rate limiter

**Files:** `src/routes/public.routes.ts`.

- [ ] **Step 1:** add a dedicated limiter near the others:
      `const cfdiLimit = rateLimit({ windowMs: 60_000, max: 5, standardHeaders:true, legacyHeaders:false })` (stamping costs money — keep it
      tight).
- [ ] **Step 2:** register:
  ```typescript
  router.post('/receipt/:accessKey/cfdi', cfdiLimit, validateRequest(autofacturaSchema), autofacturaController)
  router.get('/receipt/:accessKey/cfdi', readLimit, getAutofacturaStatusController)
  ```
  Place beside the existing `/receipt/:accessKey/...` routes.

---

### Task 4: Tests + audit (NO commit)

**Files:** NEW `tests/unit/controllers/public/cfdi.public.controller.test.ts` (mock `issueCfdiForOrder` + `prisma` like
`loadOrderForCfdi.test.ts` mocks `prismaClient`). Cover:

- [ ] happy path → 200 with `cfdi.uuid`; `logAction` called with `staffId:null` + `flow:'AUTOFACTURA_A'`.
- [ ] receipt not found → 404, service never called.
- [ ] `paymentStatus !== 'PAID'` → 409, service never called.
- [ ] out-of-month ticket → 409, service never called. (Mock `order.createdAt` to a prior month — note `Date.now()` is allowed in tests;
      freeze with `jest.useFakeTimers` or inject a fixed date if cleaner.)
- [ ] already STAMPED → 409, service never called.
- [ ] service throws `/no habilitada/` (autofactura disabled) → **403** (not 500).
- [ ] service returns `VALIDATION_FAILED` → 422 with reasons.
- [ ] GET status: existing STAMPED → 200 with cfdi; none → `{ cfdi: null }`.

- [ ] **Audit:** `npm run audit:permissions` exit 0 (public route, no permission — confirm no PHANTOM introduced);
      `npm run format && npm run lint:fix`; `npm run build` exit 0;
      `npm test -- tests/unit/controllers/public/cfdi.public.controller.test.ts tests/unit/services/fiscal` ALL green.
- [ ] DO NOT commit.

---

## MCP note (CRITICAL rule compliance)

The customer MCP (`src/mcp/`) is currently **read-only**; issued CFDIs (including autofactura) are already surfaced by the existing
`cfdi_status` tool (venue-scoped). Autofactura is a **public customer** action, not an operator capability, so it adds **no new
operator-readable surface** → no new MCP tool required by this plan. (When the customer MCP gains write tools, a customer-initiated invoice
has no operator-write equivalent anyway.) **Do NOT touch `src/mcp/**` in this plan.\*\*

## Self-review

**Spec coverage:** customer self-invoices their own ticket ✓; gated by merchant `autofacturaEnabled` (enforced in `issueCfdiForOrder`,
Plan 4) ✓; ownership via existing `accessKey` ✓; same-month + paid + not-already-invoiced guards prevent global/individual double-invoice ✓;
Spanish, shape-only Zod ✓; ActivityLog with null staffId ✓; rate-limited ✓. **Behavior:** a disabled merchant → 403; a foreign/old/unpaid
ticket → 4xx, never stamps. **Window caveat:** same-month assumes ≥monthly periodicity; for sub-monthly emisores (DIARIO/SEMANAL) Plan 6's
global only sweeps _closed_ periods and _excludes individually-stamped orders_, so the residual overlap is bounded — documented, acceptable
for MVP.
