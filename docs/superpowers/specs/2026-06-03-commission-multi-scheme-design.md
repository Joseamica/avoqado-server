# Multi-Scheme Commissions — Design Spec

**Date:** 2026-06-03 **Status:** Approved design (pending written-spec review → implementation plan) **Author:** Jose Antonio Amieva +
Claude **Scope:** `avoqado-server` (engine + schema), `avoqado-web-dashboard` (minor UI), `scripts/mcp/` (tool sync)

---

## 1. Problem & Motivation

A venue (Mindform, a wellness studio) needs **more than one commission scheme running at the same time**, each rewarding a different group
of products differently:

- **Hidrógeno Molecular + Iyashi Dome** → tiered: **4%** of $0–$30,000 · **6%** from $30,000 to the staff member's **goal (meta)** · **8%**
  beyond the goal.
- **Lagree** → **3% flat**.
- (Merch / other → to be decided with the client.)

Each employee has her **own monthly goal**, and that goal is the boundary between the 6% and 8% bands.

### Why it doesn't work today (verified)

The calculation engine resolves **exactly one** commission config per payment. `createCommissionForPayment`
([src/services/dashboard/commission/commission-calculation.service.ts](../../../src/services/dashboard/commission/commission-calculation.service.ts))
calls `findActiveCommissionConfig`
([src/services/dashboard/commission/commission-utils.ts](../../../src/services/dashboard/commission/commission-utils.ts)), which is a
`findFirst` ordered by `priority desc`. If that single winning config is category-scoped and the order has no matching items, the base
amount is 0 and the commission is **skipped** — it never falls through to a lower-priority config.

**Empirical proof:**
[tests/unit/services/dashboard/commission-multi-config-limitation.test.ts](../../../tests/unit/services/dashboard/commission-multi-config-limitation.test.ts)
(2 passing tests). Same Lagree-only ticket: $0 when the Hidrógeno config wins by priority; 3% when the Lagree config is the active one.

Two secondary limitations:

1. **Goals are per-staff/venue, not per-service** — acceptable; the client wants per-**employee** goals ("cada una tiene su meta"), which
   already exist in `VenueModule.config.salesGoals`
   ([src/services/dashboard/commission/sales-goal.service.ts](../../../src/services/dashboard/commission/sales-goal.service.ts)).
2. **Tier boundaries can't mix a fixed amount and a per-person goal.** `CommissionTier` thresholds are fixed Decimals; `useGoalAsTier` is a
   separate, **binary** (2-rate) mechanism. The "4% → 6% (to goal) → 8% (past goal)" structure needs a tier whose upper boundary IS the
   staff's goal. (This is the chosen "Option A".)

### Current live state at Mindform (prod, verified 2026-06-03)

- One active config **"Comisión Grace"**: TIERED, recipient SERVER, categories **Lagree + Merch** (NOT Hidrógeno/Iyashi), tiers Bronce
  0–17,750 @ 4% / Plata 17,750+ @ 6% (no 8%). Pays all servers on those categories (Grace + Melissa earning; ~$506 since 2026-05-12). **It
  calculates correctly for the rules it was given — it is not buggy.**
- One goal: $17,750/month for Grace; the tier threshold (17,750) was **hand-copied** to match her goal — fragile. Option A removes this
  fragility (the goal drives the tier automatically).
- Hidrógeno/Iyashi commission is a **new** requirement to add, not a misconfiguration to fix.

---

## 2. Requirements

**Functional**

- R1. A venue can run **multiple commission schemes simultaneously**, each scoped to its own product categories, all paying correctly on the
  same or different tickets.
- R2. A scheme can be **tiered with a per-staff-goal boundary** (4% fixed band → 6% up to the staff's goal → 8% beyond), as well as the
  existing fixed-amount tiers and flat percentage.
- R3. Each category belongs to **exactly one** scheme. No double-payment.
- R4. Per-employee goals drive the goal-based tier boundary, resolved at calculation time.

**Non-functional (the client's explicit worries)**

- N1. **No UI/UX complexity creep** — no new pages/routes; reuse the existing commission setup wizard.
- N2. **Commissions assigned correctly** — idempotent (never double-pay a payment), with regression tests.
- N3. **Non-breaking** — venues with a single scheme behave exactly as today.
- N4. **No DB mess** — multiple configs are normal rows; the design _reduces_ current mess (removes the hand-copied goal-into-tier
  duplication).

**Out of scope**

- Per-service/per-category **goals** (goals stay per-employee — confirmed sufficient).
- Deprecating/removing `useGoalAsTier` (kept for backward compatibility).
- Merch's final scheme assignment (confirm with the client; does not block this work).

---

## 3. Design

### 3.1 Engine: evaluate ALL applicable schemes per payment

Replace the single-config lookup with a multi-config evaluation.

- New helper `findActiveCommissionConfigs(venueId, date)` → returns **all** active, non-deleted configs in the effective window, venue-level
  first; falls back to org-level only if there are no venue-level configs. Ordered by `priority desc`. (Keeps the existing venue-over-org
  precedence.)
- In `createCommissionForPayment`:
  1. Load all active configs. Partition into **category-scoped** (`filterByCategories = true`) and **catch-all**
     (`filterByCategories = false`).
  2. Build the set of **claimed categoryIds** = union of all category-scoped configs' `categoryIds`.
  3. For **each category-scoped config**: base = sum of order items in that config's categories (existing
     `calculateCategoryFilteredAmount`). If base > 0, produce one `CommissionCalculation` for it.
  4. For the **catch-all config** (at most one expected; if several, highest priority wins): base = sum of order items whose category is
     **not** in the claimed set ("leftover"). If there are no category-scoped configs, the claimed set is empty → base = whole payment =
     **today's behavior exactly** (N3). If base > 0, produce one calc.
- Each config independently resolves its own `recipient`, override, role rate, tier rate, and bounds (the existing cascade — Override >
  Tier > Role > Default — runs per config).

**Mental model:** each category lives in exactly one "carpeta"; the general carpeta (if any) catches the rest. This satisfies R1 + R3, and
N3 (single-config venues unchanged).

### 3.2 Idempotency (N2)

Change the guard from per-payment to **per-(payment, config, staff)**. For each config, before creating, check for an existing non-voided
`CommissionCalculation` with `(paymentId, configId, staffId)`; skip if present. This mirrors the existing precedent in
`createSplitCommissionForPayment` (per-`(paymentId, staffId)`), letting webhook retries run safely without duplicates.

### 3.3 Refunds

`createRefundCommission` currently mirrors the **single** original calc by `paymentId`. Update it to find **all** non-voided original calcs
for the refunded payment and create a proportional negative calc for **each** (same config, same rate, proportional base). Keeps
`SUM(netCommission)` correct after refunds across schemes.

### 3.4 Split commissions (payment links)

`createSplitCommissionForPayment` also uses a single config; update it to the same multi-config partition so multi-staff payment-link splits
respect per-category schemes. (Tiered rates still intentionally skipped for splits, per its existing docstring.)

### 3.5 Goal-based tier boundary — "Option A" (R2, R4)

Let a tier boundary be the **staff's goal** instead of a fixed number.

**Schema change** (`prisma/schema.prisma`, `CommissionTier`):

```prisma
enum ThresholdType {
  FIXED
  STAFF_GOAL
}

model CommissionTier {
  // ... existing fields ...
  minThresholdType ThresholdType @default(FIXED)
  maxThresholdType ThresholdType @default(FIXED)
}
```

`FIXED` (default) preserves all existing tiers unchanged. `STAFF_GOAL` means "resolve this boundary to the staff member's active goal at
calculation time" (the stored numeric value is ignored / used only as fallback).

Mindform's Hidrógeno scheme becomes:

| Tier | min            | max            | rate |
| ---- | -------------- | -------------- | ---- |
| 1    | 0 (FIXED)      | 30,000 (FIXED) | 4%   |
| 2    | 30,000 (FIXED) | **STAFF_GOAL** | 6%   |
| 3    | **STAFF_GOAL** | ∞ (max null)   | 8%   |

**Resolution rules** (in `commission-tier.service.ts` — `getStaffTierProgress` / `getApplicableTierRate`):

- For each tier boundary of type `STAFF_GOAL`, resolve to the staff member's active goal whose `period` matches the tier's `tierPeriod`
  (default MONTHLY) via `getStaffSalesGoal`.
- Tiers are evaluated in `tierLevel` order. If a resolved boundary ends up `<=` the previous tier's lower bound (e.g. the staff's goal is
  below a fixed cut — degenerate config), that band is **empty and skipped**; the engine does not error.
- **No goal set for the staff:** `STAFF_GOAL` upper boundaries extend to ∞ (the staff stays in the lower band; the higher band is
  unreachable until a goal exists). This is the safe default and is logged.

This generalizes and supersedes `useGoalAsTier` for new configs, but `useGoalAsTier` remains supported for existing configs (the calc code
keeps its `if (useGoalAsTier) … else if (TIERED) …` branch; the TIERED branch gains dynamic-boundary resolution).

### 3.6 UI (avoqado-web-dashboard) — minimal (N1)

No new pages or routes. Changes confined to the existing commission setup:

- **Tiers card** (`setup-panel/cards/TiersCard.tsx`): each tier's max (and min) amount field gains a small toggle "monto fijo / la meta del
  empleado". When "meta" is chosen, the numeric input is replaced by a "Meta del empleado" chip and the boundary is sent as `STAFF_GOAL`.
- **Config card / list**: surface an "Aplica a: [categorías]" label per scheme (data already present via `categoryIds`) so it's obvious at a
  glance what each scheme covers.
- **Soft warning**: if two active schemes list the same category, show a non-blocking notice ("esta categoría está en más de un esquema; se
  pagará solo una vez, con el de mayor prioridad").
- A visual mockup will be produced for the user to approve before frontend implementation begins.

### 3.7 MCP sync (mandatory per CLAUDE.md)

Audit `scripts/mcp/` for commission/goal tools. Add or update tools so an agent can: list commission schemes for a venue, create a scheme
(flat/tiered/with category scope), define tiers including a `STAFF_GOAL` boundary, and manage per-staff goals. A capability not reachable
via MCP is considered unfinished.

### 3.8 Permissions

No new `resource:action` expected — schemes/tiers/goals use existing endpoints and permissions (`commissions:*`). The new tier-boundary type
is carried within existing tier create/update payloads. Verify with `npm run audit:permissions` after changes; add nothing unless the audit
flags a gap.

---

## 4. Data flow (after change)

```
Payment COMPLETED
  → createCommissionForPayment(paymentId)
      → findActiveCommissionConfigs(venueId, date)        // ALL active configs
      → partition: category-scoped[] + catch-all?
      → claimedCategoryIds = ∪ category-scoped.categoryIds
      → for each category-scoped config:
            base = Σ items in config.categoryIds
            if base>0 and not already calc'd (paymentId,configId,staffId):
               rate = cascade(override > tier(dynamic STAFF_GOAL) > role > default)
               create CommissionCalculation
      → catch-all (if any):
            base = Σ items whose category ∉ claimedCategoryIds   // whole payment if none claimed
            if base>0 …: create CommissionCalculation
```

---

## 5. Testing (N2, N3)

Extend/replace `commission-multi-config-limitation.test.ts` (its current assertions characterize the OLD behavior and will be updated):

- **Both schemes pay:** Lagree-only ticket with Hidrógeno+Lagree configs → Lagree calc at 3%, no Hidrógeno calc.
- **Mixed ticket:** items in both Hidrógeno and Lagree → two calcs, each on its own categories, correct rates.
- **No double-pay:** a category present in one scheme produces exactly one calc; idempotency holds on retry.
- **Regression (N3):** venue with a single catch-all config → identical behavior to today (whole-payment base).
- **Leftover / catch-all:** category-scoped + catch-all configs → catch-all bills only unclaimed categories.
- **Hybrid tier (Option A):** staff below 30k → 4%; between 30k and resolved goal → 6%; above goal → 8%; per-staff goal resolution; no-goal
  fallback (stays in lower band, no error); degenerate goal (≤ fixed cut) skips the empty band.
- **Refund:** mirrors ALL original calcs proportionally.

Run `npm run test:unit` and `npm run pre-deploy` before any commit.

---

## 6. Mindform cleanup (one-time, ops — after deploy)

1. Re-scope "Comisión Grace": remove Lagree from it (Lagree moves to its own scheme); decide Merch.
2. Create **Lagree — 3% fijo** (PERCENTAGE, category Lagree).
3. Create **Hidrógeno + Iyashi — escalonado** (TIERED, categories Hidógeno Molecular + Iyashi y Cryo; tiers 4% / 6%(→goal) / 8%(>goal)).
4. Ensure each employee's monthly goal is set sensibly (must be **> $30,000** for the 8% band to be reachable given the fixed first cut —
   flag to the client).
5. Confirm Merch's scheme with the client.

IDs generated as cuid v1 per repo convention if done via script; otherwise via the dashboard UI.

---

## 7. Open questions

- **Merch**: keep on the existing scheme, move, or drop? (client decision; non-blocking)
- Should the soft category-overlap warning ever become a hard block? (Default: soft only.)

---

## 8. Risk & mitigation

| Risk                                  | Mitigation                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Double-pay across overlapping schemes | "Each category in exactly one scheme" + highest-priority-wins; covered by tests    |
| Breaking single-config venues         | Catch-all path with empty claimed-set = today's behavior; explicit regression test |
| Webhook retries duplicating calcs     | Per-(payment, config, staff) idempotency                                           |
| Degenerate goal/threshold config      | Empty bands skipped, never error; no-goal fallback documented                      |
| MCP drift                             | MCP tool audit/update in the same change                                           |

```

```
