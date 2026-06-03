# TPV Staff Carry-Over — Design Spec

**Date:** 2026-06-03
**Author:** Jose Amica (con Claude)
**Status:** Approved (brainstorming) → ready for implementation plan
**Predecessor:** `2026-06-02-tpv-venue-migration-design.md` (the migration feature this extends)

---

## 1. Problem

When a TPV terminal is migrated from venue A → venue B, the people who used it at
venue A **lose access**: PIN login is venue-scoped (`StaffVenue @@unique([venueId, pin])`),
so a user with a PIN at A but no `StaffVenue` (or no PIN) at B **cannot log in** at the
new location.

This bit us live: terminal `2840744304` was moved to **BAE RICARDO B ANAYA (3988)** and
**Braulio Niño** couldn't enter (his 3988 assignment had no PIN). It had to be fixed by
hand in production.

The owner doing the move (Isaac) is **non-technical**. He needs to carry over the people
who'll use the terminal at the new place, **safely**, **without jargon**, and **without
errors** (owners can own many venues; org-owners; PlayTelecom white-label — a wrong write
is dangerous).

## 2. Goal

Let the owner give the right people access at the destination venue **before the terminal
moves**, in plain language, reusing the platform's existing safe staff-assignment logic.

---

## 3. Decisions (confirmed with founder)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Where it lives | **Both:** a step inside the migration wizard **and** a standalone "Dar acceso a una persona" action (to fix the after-the-fact case like Braulio) |
| 2 | Surfaces | **Both** dashboards: org-owner (`avoqado-web-dashboard` org dashboard) **and** superadmin (`avoqado-superadmin`) |
| 3 | Who appears in the picker | **All users of the destination venue's organization** (search), source-venue people surfaced first as the natural carry-over set |
| 4 | Default role | **Pre-select the role the user had at the source venue**; owner can change it to any role the user already holds |
| 5 | Ordering (founder's instinct, correct) | **Grant access FIRST, move the terminal SECOND.** If granting fails, the terminal does **not** move — never a half-broken state, never a window where "the terminal arrived but nobody can log in" |

---

## 4. User-facing flow (plain language — what Isaac sees)

### A) During a move (new step in the migration wizard)

After picking the destination venue, a new step appears **before** the readiness check:

> **"¿Quién va a usar esta terminal en {Lugar Nuevo}?"**

- Search + tap people (all users of the destination org; the source-venue people listed first).
- For each tapped person:
  - **Role pre-selected** = the role they had where the terminal was (plain words: **Gerente / Cajero / Mesero / …**). Changeable to any role they already hold.
  - **PIN pre-filled** = the PIN they use at their other venues. If none, owner sets one. If it collides at the destination, a clear message.
  - One-line summary: **"Le vas a dar acceso a Braulio como Gerente con PIN 3987."**
- On "Continuar": **access is granted right here** (real, safe, idempotent writes). Only then does the wizard advance to the readiness check → confirm → move.

This step order is exactly what enforces "todo transferido antes de mover": the grants are a
**prerequisite step**, so by the time the terminal moves the people already have access. It
also naturally clears the `NO_STAFF_PIN` migration blocker.

### B) Standalone "Dar acceso a una persona"

Same picker, available on the venue / terminal at any time, **not tied to moving**. Grants
access immediately, **does not touch the terminal** (no factory reset). This is the fix for
the after-the-fact case (Isaac realizes later that someone was left out).

---

## 5. Architecture

**No schema change.** Reuses `StaffVenue` + the existing safe primitive.

### 5.1 The safe primitive (reuse, do not reinvent)

`assignToVenue(staffId, venueId, role, pin?)` in
`src/services/superadmin/staff.superadmin.service.ts` already:
- validates the staff exists,
- validates the venue exists,
- **validates the staff belongs to the venue's organization** (anti cross-tenant),
- **validates PIN uniqueness** within the venue,
- **upserts** the `StaffVenue` (role + pin + active=true, clears endDate).

Idempotent and additive. This is the unit of work for every grant.

### 5.2 Backend — new

**Service** (`src/services/dashboard/venue-access.service.ts`, new):

1. `grantVenueAccessBatch(venueId, grants: Array<{ staffId; role; pin? }>, actor)`
   - **Pre-validate everything first** (every staff ∈ org, venue ok, every PIN unique vs the
     venue **and** vs the other grants in the batch), then **apply all upserts in one
     `prisma.$transaction`** → all-or-nothing ("todo o nada"). Requires extracting the core
     upsert of `assignToVenue` into a tx-aware helper so the batch is atomic (small refactor;
     keep `assignToVenue` working as a thin wrapper for the existing single-assign route).
   - Writes an `ActivityLog` entry per grant.
   - Returns per-staff result `{ staffId, role, pin, status }`.

2. `listVenueAccessCandidates(destVenueId, sourceVenueId?)`
   - Returns the destination org's staff with, per person: `currentRoleAtSource` (for
     pre-select), `suggestedPin` (their existing PIN, most-common across their active venues,
     for auto-fill), `rolesHeld` (distinct roles across their venues, for the role picker),
     and `inSourceVenue` (to surface source people first). Only **active** staff.

**Org-scoped wrappers** (`src/services/organization-dashboard/orgTerminals.service.ts` or a new
`orgVenueAccess.service.ts`): `grantVenueAccessForOrg` / `listVenueAccessCandidatesForOrg` —
call `validateVenueInOrg(destVenueId, orgId)` and ensure **every** `staffId` ∈ org before
delegating. Mirrors the existing `*ForOrg` migration wrappers.

**Routes:**
- Superadmin (`avoqado-superadmin` namespace rule → `/superadmin/*`, never `/dashboard/superadmin/*`):
  - `GET  /superadmin/venues/:venueId/staff-access/candidates?sourceVenueId=`
  - `POST /superadmin/venues/:venueId/staff-access` (batch grant)
- Org-owner (under `/dashboard/organizations/:orgId/...`, behind `requireOrgOwner`):
  - `GET  /:orgId/venues/:venueId/staff-access/candidates?sourceVenueId=`
  - `POST /:orgId/venues/:venueId/staff-access`

Zod schemas: Spanish-only messages; ids validated as non-empty strings (mixed cuid/uuid in
prod — same lesson as `terminal-migration.schemas.ts`, do **not** use `.cuid()`).

**Permissions:** the org-owner endpoints are gated by `requireOrgOwner` (StaffOrganization
role = OWNER). Reuse an existing staff-management permission for the superadmin route; do not
invent a new `resource:action` unless the audit requires it — if a new one is needed, run the
full permission checklist (`docs/.claude/rules/permissions-policy.md`) + `npm run audit:permissions`.

### 5.3 Frontend

**Shared component + hooks** (per repo): `StaffAccessStep` (picker + per-person role/PIN +
summary) and `useVenueAccessCandidates` / `useGrantVenueAccess`. Used in **two** places:
inside the migration wizard, and the standalone drawer.

- **avoqado-superadmin** `src/features/terminals/TerminalMigrationDrawer.tsx`: insert a
  `staff` step → step machine becomes `pick → staff → preflight → progress`. Add a standalone
  "Dar acceso" drawer reachable from the terminal/venue actions. Reuse `Combobox`, `Badge`,
  `Drawer`, `Button` primitives + `.impeccable.md` design system. Tests: Vitest + MSW.
- **avoqado-web-dashboard** `src/pages/Organization/components/OrgMigrateTerminalWizard.tsx`:
  insert a step → `pickVenue → staff → preflight → confirm → progress`. Add a standalone
  "Dar acceso" entry on the org terminals/venue page.

**Plain-language role labels** (shared map, reuse if one already exists, else add one):
`OWNER→Dueño · ADMIN→Administrador · MANAGER→Gerente · CASHIER→Cajero · WAITER→Mesero ·
KITCHEN→Cocina · HOST→Anfitrión · VIEWER→Solo ver`. The owner never sees a raw enum.

### 5.4 MCP (kept in lockstep — house rule)

Add a `grant_venue_access` tool to the admin MCP (`scripts/mcp/`, currently in worktree
`.worktrees/admin-mcp`, pending merge → develop): Prisma-direct, same validations (staff ∈
org, venue exists, PIN unique). Note in the plan that the MCP lives in a pending-merge
worktree so the tool addition rides with that branch.

---

## 6. Safety guarantees (for a non-technical owner, "no quiero errores")

- **Transfer-before-move** enforced by step order: grants are a prerequisite; the terminal
  only moves after access exists.
- **Atomic batch**: pre-validate all, then `$transaction` → all grants succeed or none do.
- **No cross-tenant**: org-owner routes validate venue ∈ org and every staff ∈ org;
  `assignToVenue` independently re-checks org membership (defense in depth).
- **PIN collisions caught** with a plain message; never silently overwrite someone else's PIN.
- **Additive / idempotent**: grants upsert; re-running or going "back" is safe; we never
  silently revoke anyone (revocation is a separate, deliberate action — out of scope here).
- **Audit trail**: an `ActivityLog` row per grant.
- **Confirmation copy** in plain Spanish, one line per person.

---

## 7. Edge cases

- **Carry-over user not in destination org** (cross-org migration via superadmin): shown
  greyed ("no es de esta organización"); cannot be granted (`assignToVenue` 400s anyway).
- **PIN already taken at destination**: clear message, owner picks another (or reuses the
  user's own existing PIN, which is unique to them).
- **User has no PIN anywhere**: owner sets one; if left blank, warn that they won't be able to
  log in until a PIN is set.
- **User already has access at destination**: upsert updates role/PIN (the Braulio case —
  he was already MANAGER at 3988, just lacked a PIN).
- **`NO_PAYMENT_CONFIG`** and other migration blockers are unrelated to staff and still block
  at the readiness check.

---

## 8. Out of scope (YAGNI)

- Revoking access at the **old** venue (founder didn't ask; old-venue rows stay — harmless,
  old venue keeps working).
- Bulk carry-over across multiple terminals at once.
- Notifying the carried-over user (SMS/email/WhatsApp).
- A new paid feature/module gate — this is core staff management, not a premium feature.

---

## 9. Test plan

**Backend (Jest, avoqado-server):**
- `grantVenueAccessBatch`: happy path (multi-user), atomic rollback when one fails, PIN
  collision (vs venue and vs batch), staff-not-in-org rejection, idempotent re-grant.
- `listVenueAccessCandidates`: pre-selects source-venue role, suggests existing PIN, lists
  distinct roles, excludes inactive staff, surfaces source-venue people.
- Org wrappers reject cross-org staff and cross-org venue.
- **Regression:** migration still works with no carry-over; `NO_STAFF_PIN` still blocks when
  nobody at the destination has a PIN; existing single-assign route unchanged.

**Frontend (Vitest + MSW, both repos):**
- Wizard renders the new step; role pre-selected; plain labels; summary line correct.
- Standalone grant drawer works without touching the terminal.
- Grant failure stops the wizard before the move.

---

## 10. Files to touch (implementation checklist)

**avoqado-server**
- `src/services/superadmin/staff.superadmin.service.ts` — extract tx-aware upsert helper.
- `src/services/dashboard/venue-access.service.ts` — **new** (`grantVenueAccessBatch`, `listVenueAccessCandidates`).
- `src/services/organization-dashboard/orgVenueAccess.service.ts` — **new** org-scoped wrappers (or add to `orgTerminals.service.ts`).
- `src/routes/superadmin/venue-access.routes.ts` + controller — **new**.
- `src/routes/superadmin/venue-access.schemas.ts` — **new** (Spanish, non-empty string ids).
- `src/routes/dashboard/organizationDashboard.routes.ts` — add 2 routes behind `requireOrgOwner`.
- `scripts/mcp/` (worktree `.worktrees/admin-mcp`) — add `grant_venue_access` tool.
- Tests under `tests/unit/services/...` and `tests/unit/routes/...`.

**avoqado-superadmin**
- `src/features/terminals/StaffAccessStep.tsx` + `use-venue-access.ts` + `api.ts` additions — **new**.
- `src/features/terminals/TerminalMigrationDrawer.tsx` — add `staff` step.
- Standalone "Dar acceso" drawer entry on terminal/venue actions.
- Vitest + MSW tests; CHANGELOG entry.

**avoqado-web-dashboard**
- Org `StaffAccessStep` + hooks + api.
- `src/pages/Organization/components/OrgMigrateTerminalWizard.tsx` — add `staff` step.
- Standalone "Dar acceso" entry on the org terminals/venue page.

---

## 11. Deploy order (cross-repo rule)

Backend first (additive endpoints — safe for legacy dashboard) → wait stable → then the two
frontends. Never remove/rename existing API fields.
