# Facturación CFDI — Phase 0d: Gating Permissions (backend) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Checkbox steps. The
> `.claude/rules/permissions-policy.md` auto-loads when editing `src/lib/permissions.ts` — FOLLOW IT.

**Goal:** Establish the backend permission vocabulary + feature mapping for facturación so later routes/UI can gate on it: add
`cfdi:configure` (OWNER/ADMIN only — founder decision), `cfdi:issue`, `cfdi:view` to `src/lib/permissions.ts`, map them to the `CFDI`
feature in `PERMISSION_TO_FEATURE_MAP`, and keep `npm run audit:permissions` green.

**Architecture:** Pure config in the permission single-source-of-truth (`src/lib/permissions.ts`) + the white-label feature map
(`src/services/access/access.service.ts`). No routes, no DB, no business logic. CFDI is a **Pro-tier paid feature** (spec §15): the `CFDI`
feature code is unlocked by the `PLAN_PRO` blanket grant; this plan only wires the permission↔feature mapping so feature-access filtering
works.

**Scope — IN:** the 3 `cfdi:*` permissions (catalog + defaults + dependencies) + `CFDI` entries in `PERMISSION_TO_FEATURE_MAP` + audit
green. **OUT (Phase 1 / other repos / other branch):** the HTTP route + `checkFeatureAccess('CFDI')`/`checkPermission('cfdi:issue')`
middleware that USE these (Phase 1, tested end-to-end there); the `CFDI` Feature DB-row seed (a `scripts/seed-cfdi-feature.ts` mirroring
`seed-plan-pro.ts`, done with Phase 1); the dashboard `<PermissionGate>` + TPV mirrors (those repos); the MCP tools (`scripts/mcp/` lives on
branch `feat/admin-mcp`, NOT develop — add `cfdi.issue`/`cfdi.status`/`fiscal.config` there when it merges). Design: spec §15, §18.

**Reference rules:** `.claude/rules/permissions-policy.md` (the adding-a-permission checklist + audit), `.claude/rules/feature-gating.md`,
`.claude/rules/testing-and-git.md` (NEVER commit without asking).

---

### Task 1: Add the `cfdi:*` permissions to `src/lib/permissions.ts`

**Files:**

- Modify: `src/lib/permissions.ts` — three exports: `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` (~line 1215), `DEFAULT_PERMISSIONS` (~line 472),
  `PERMISSION_DEPENDENCIES` (~line 46).

> Read each export first to match the EXACT existing structure/formatting (e.g. how `inventory` or `tpv` resource blocks are written). Place
> the new entries alongside siblings.

- [ ] **Step 1: Catalog** — in `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`, add a new `cfdi` resource key:

```typescript
  cfdi: ['cfdi:configure', 'cfdi:issue', 'cfdi:view'],
```

- [ ] **Step 2: Defaults** — in `DEFAULT_PERMISSIONS`, grant per the founder decision (configure = OWNER/ADMIN only; issue/view =
      OWNER/ADMIN/MANAGER). Add these strings to the existing arrays for each role (do NOT remove anything):

  - `OWNER`: add `'cfdi:configure'`, `'cfdi:issue'`, `'cfdi:view'`
  - `ADMIN`: add `'cfdi:configure'`, `'cfdi:issue'`, `'cfdi:view'`
  - `MANAGER`: add `'cfdi:issue'`, `'cfdi:view'` (NOT configure)
  - (SUPERADMIN already satisfies everything via `*:*` — do not touch.)

- [ ] **Step 3: Dependencies** — in `PERMISSION_DEPENDENCIES`, add (issue/configure imply view, so a holder can read what they manage):

```typescript
  'cfdi:configure': ['cfdi:configure', 'cfdi:view'],
  'cfdi:issue': ['cfdi:issue', 'cfdi:view'],
```

- [ ] **Step 4: Build check**

Run: `npm run build` Expected: exit 0.

---

### Task 2: Map `cfdi:*` → `CFDI` feature in the white-label map

**Files:**

- Modify: `src/services/access/access.service.ts` — `PERMISSION_TO_FEATURE_MAP` (~line 76).

- [ ] **Step 1: Add the mapping** alongside the other feature groups (e.g. after the Inventory block):

```typescript
  // Facturación CFDI (Pro-tier feature)
  'cfdi:configure': 'CFDI',
  'cfdi:issue': 'CFDI',
  'cfdi:view': 'CFDI',
```

- [ ] **Step 2: Build check** · `npm run build` → exit 0

---

### Task 3: Permission audit (the safety net)

- [ ] **Step 1: Run the audit**

Run: `npm run audit:permissions` Expected: **exit 0**. The 3 new permissions are in the catalog AND defaults (so no
`PHANTOM`/`CATALOG_GAP`), and are not yet referenced by any route/dashboard gate (so no `DASHBOARD_DEAD_GATE`). If the audit reports
anything for `cfdi:*`, fix per `.claude/rules/permissions-policy.md` (e.g. add to the relevant export). Do NOT add allowlist entries to
silence real warnings.

- [ ] **Step 2: Format**

Run: `npm run format && npm run lint:fix`

---

### Task 4: Stop for the founder (NO commit)

- [ ] **Step 1:** DO NOT commit. Report the changed files (`src/lib/permissions.ts`, `src/services/access/access.service.ts`) + the audit
      output.

---

## Self-review

**Spec coverage (§15/§18):** `cfdi:configure` OWNER/ADMIN-only ✓; `cfdi:issue`/`cfdi:view` ✓; permission↔feature map for white-label ✓ (§15
"register in PERMISSION_TO_FEATURE_MAP"); audit green ✓. **Deferred (clearly noted):** the route + middleware that consume the gate (Phase
1); the `CFDI` Feature DB-row seed (Phase 1, mirror `seed-plan-pro.ts`); dashboard/TPV mirrors (sibling repos — the local audit cross-checks
them, so a future dashboard `<PermissionGate permission="cfdi:...">` must use the EXACT same strings); MCP tools (branch `feat/admin-mcp`).

**Placeholder scan:** none — exact strings + exact insertion targets.

**Type consistency:** permission strings are identical across catalog, defaults, dependencies, and the feature map (`cfdi:configure` /
`cfdi:issue` / `cfdi:view`); feature code `CFDI` is consistent. No renames (so no alias migration needed).

**Cross-repo note:** when Phase 1 / dashboard adds `<PermissionGate permission="cfdi:issue">` or a `checkPermission('cfdi:issue')` route, it
MUST reuse these exact names; the audit (`npm run audit:permissions`, which reads sibling repos locally) will catch any drift.
