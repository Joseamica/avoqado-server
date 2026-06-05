# Facturación CFDI — Phase 4: Merchant-based emisor resolution + gating — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Checkbox steps.
> `critical-warnings.md` auto-loads.

**Goal:** Make the founder's core rule real — **a sale can only be invoiced if the merchant it was paid through has facturación enabled**,
and the issuing emisor is the one mapped to that merchant (`MerchantFiscalConfig`), not `venue.fiscalEmisors[0]`. Also block "Público en
General" on individual (Flow B/A) issuance (it's global-only — the §spec/PAC rule found in the live e2e). This unblocks Flow A (autofactura)
and Flow C (global).

**Architecture:** Change `loadOrderForCfdi` (in `cfdi.service.ts`) to resolve the emisor via the order's most-recent payment's merchant →
`MerchantFiscalConfig` → `fiscalEmisor`, returning the per-merchant flags `facturacionEnabled`/`autofacturaEnabled`. `issueCfdiForOrder`
enforces: `facturacionEnabled` always; `autofacturaEnabled` when `flow==='AUTOFACTURA_A'`. Add a `XAXX010101000`-on-individual block to
`validateBeforeStamp`.

**Tech Stack:** TypeScript, Prisma, Jest (DI mocks — the existing `IssueCfdiDeps` pattern).

**Scope — IN:** rewrite `loadOrderForCfdi` (merchant→config→emisor) + `LoadedOrderBundle` adds `facturacionEnabled`/`autofacturaEnabled`;
`issueCfdiForOrder` gating; `validateBeforeStamp` público-general block; tests. **OUT (next plans):** the public autofactura endpoint (Plan
5), the global job (Plan 6). Design: spec §6.1c, §7.3.

**Reference rules:** `.claude/rules/critical-warnings.md` (tenant isolation; authContext), `.claude/rules/testing-and-git.md` (NEVER commit;
do NOT touch `src/mcp/**`).

> **Coordination:** founder co-develops fiscal in parallel — do NOT touch `src/mcp/**`. Read the CURRENT `cfdi.service.ts` >
> `loadOrderForCfdi` + `LoadedOrderBundle` + `issueCfdiForOrder`, and `cfdiValidation.ts`, before editing; integrate, don't rewrite
> unrelated parts. Confirm the `MerchantFiscalConfig` fields/relations in `prisma/schema.prisma`.

---

### Task 1: Merchant-based emisor resolution in `loadOrderForCfdi`

**Files:**

- Modify: `src/services/fiscal/cfdi.service.ts` — `LoadedOrderBundle` interface + the default `loadOrderForCfdi`.
- Test: extend `tests/unit/services/fiscal/cfdi.service.test.ts` (the existing `makeDeps().loadOrderForCfdi` mock already returns a bundle —
  add `facturacionEnabled`/`autofacturaEnabled` to it).

- [ ] **Step 1: Extend `LoadedOrderBundle`** — add:

```typescript
facturacionEnabled: boolean
autofacturaEnabled: boolean
```

- [ ] **Step 2: Rewrite the default `loadOrderForCfdi`** to resolve via the merchant config. Conceptual (integrate with the existing select;
      confirm field names):

```typescript
loadOrderForCfdi: async orderId => {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      venueId: true, subtotal: true, taxAmount: true, total: true, tipAmount: true,
      venue: { select: { slug: true, type: true } },
      // most-recent payment + its merchant FKs
      payments: { take: 1, orderBy: { createdAt: 'desc' }, select: { method: true, merchantAccountId: true, ecommerceMerchantId: true } },
      items: { /* unchanged: productName, quantity, unitPrice, discountAmount, product{satKeys,objetoImp,taxRate,category{defaults}} */ },
    },
  })
  if (!order) return null
  const pay = order.payments[0]
  if (!pay || (!pay.merchantAccountId && !pay.ecommerceMerchantId)) return null // no merchant → cannot resolve an emisor

  const cfg = await prisma.merchantFiscalConfig.findUnique({
    where: pay.merchantAccountId ? { merchantAccountId: pay.merchantAccountId } : { ecommerceMerchantId: pay.ecommerceMerchantId! },
    select: { facturacionEnabled: true, autofacturaEnabled: true, fiscalEmisor: { select: { id: true, provider: true, providerKeyEnc: true, csdStatus: true, serie: true } } },
  })
  if (!cfg || !cfg.fiscalEmisor) return null // merchant has no fiscal config → cannot invoice

  const peso = (d: any) => Math.round(Number(d) * 100)
  return {
    venueId: order.venueId, venueSlug: order.venue.slug, venueType: order.venue.type,
    emisor: cfg.fiscalEmisor,
    facturacionEnabled: cfg.facturacionEnabled,
    autofacturaEnabled: cfg.autofacturaEnabled,
    paymentMethod: pay.method, metodoPago: 'PUE',
    subtotalCents: peso(order.subtotal), taxCents: peso(order.taxAmount), totalCents: peso(order.total),
    order: { venueType: order.venue.type, tipAmount: order.tipAmount, items: order.items as any },
  }
},
```

- [ ] **Step 3:** update the test bundle mock to include `facturacionEnabled: true, autofacturaEnabled: true`. Build → exit 0; existing
      cfdi.service tests green.

---

### Task 2: Enforce the gating in `issueCfdiForOrder`

**Files:** `src/services/fiscal/cfdi.service.ts` (after the bundle load + tenant guard) + tests.

- [ ] **Step 1: Add the checks** right after the tenant guard:

```typescript
if (!bundle.facturacionEnabled) throw new Error('Facturación no habilitada para este merchant')
if (params.flow === 'AUTOFACTURA_A' && !bundle.autofacturaEnabled) throw new Error('Autofactura no habilitada para este merchant')
```

- [ ] **Step 2: Tests** — add to `cfdi.service.test.ts`:
  - merchant facturación disabled (`facturacionEnabled:false`) → `issueCfdiForOrder` rejects `/no habilitada/`, never calls the PAC.
  - flow `AUTOFACTURA_A` + `autofacturaEnabled:false` → rejects `/Autofactura no habilitada/`, never calls PAC.
  - flow `AUTOFACTURA_A` + both enabled → proceeds to STAMPED (happy path).

> The controller maps these to **403** (not 404): they're "feature disabled for this merchant", not "not found". Add to the Flow-B
> controller's catch: `if (/no habilitada/i.test(message)) { res.status(403).json({ error: message }); return }` BEFORE the generic 500.
> (And the autofactura controller in Plan 5 will reuse it.)

- [ ] **Step 3:** Update `issueCfdiForOrderController` (Flow B) error mapping for the 403 case. Build → exit 0.

---

### Task 3: Block "Público en General" on individual issuance (validation)

**Files:** `src/services/fiscal/cfdiValidation.ts` + `tests/unit/services/fiscal/cfdiValidation.test.ts`.

- [ ] **Step 1:** add an optional `isGlobal?: boolean` to `PreStampInput`, and in `validateBeforeStamp`:

```typescript
// XAXX010101000 "Público en General" is ONLY valid on the global CFDI (Flow C), never an individual one.
if (!input.isGlobal && input.receptor.rfc?.toUpperCase() === 'XAXX010101000') {
  reasons.push('El RFC "Público en General" (XAXX010101000) solo es válido en la factura global, no en una factura individual.')
}
```

- [ ] **Step 2:** the call site in `issueCfdiForOrder` passes `isGlobal: false` (individual). The global job (Plan 6) will pass
      `isGlobal: true`.
- [ ] **Step 3: Tests** — individual + XAXX → invalid (reason matches `/Público en General|global/i`); global (`isGlobal:true`) + XAXX →
      that reason absent. Build → exit 0.

---

### Task 4: Audit + regression (NO commit)

- [ ] `npm run audit:permissions` exit 0; `npm run format && npm run lint:fix`; `npm run build` exit 0;
      `npm test -- tests/unit/services/fiscal tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts` ALL green.
- [ ] DO NOT commit. Report files + the resolved-emisor query + the 3 new gating behaviors.

---

## Self-review

**Spec coverage (§6.1c, §7.3):** emisor resolved via the payment's merchant `MerchantFiscalConfig` ✓ (the founder's "merchant must have
facturación enabled" rule); `facturacionEnabled` enforced for all issuance, `autofacturaEnabled` for Flow A ✓; XAXX010101000 blocked on
individual ✓; tenant guard preserved ✓. **Deferred:** the public autofactura endpoint (Plan 5), the global job (Plan 6).

**Placeholder scan:** the "confirm field names / integrate with existing select" notes are real integration steps against the current code,
not logic gaps.

**Type consistency:** `LoadedOrderBundle` flags flow into `issueCfdiForOrder`; `MerchantFiscalConfig`/`FiscalEmisor` selects match the 0a
schema; `AUTOFACTURA_A` is the 0a `CfdiFlow` enum value; gating errors map to 403 (disabled) vs 404 (not found) vs 409 (rule) consistently.

**Behavior change to flag:** issuance now resolves the emisor from the **merchant config**, not `venue.fiscalEmisors[0]`. An order whose
payment-merchant has no `MerchantFiscalConfig` (or `facturacionEnabled=false`) can no longer be invoiced — which is the intended gating.
(The dashboard must let the venue set up a merchant config first — Plan 2 endpoints already exist.)
