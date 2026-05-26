# Permission System Policy — MANDATORY before merging

The Avoqado permission system spans 4 repos (`avoqado-server`, `avoqado-web-dashboard`, `avoqado-tpv`, `avoqado-android`). Drift between
them causes silent 403s, hidden UI, or — worst — accidentally granted access. This document captures the rules and the tooling that prevents
it.

## Source of truth

**`avoqado-server/src/lib/permissions.ts`** is the single source of truth. Three exports matter:

| Export                               | Purpose                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `DEFAULT_PERMISSIONS`                | What each `StaffRole` gets out of the box                                |
| `PERMISSION_DEPENDENCIES`            | Implicit deps + namespace aliases (e.g. `tpv-orders:comp → orders:comp`) |
| `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` | Toggles exposed in the dashboard's custom-role editor                    |

A permission is only "real" if it appears in at least one of these.

## Adding a new permission (`resource:action`)

Run through this checklist in order. Don't ship without it.

1. **Catalog** — add to `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` so admins can assign it individually from the role editor. Skipping this = the
   permission can only be granted via a role default or a wildcard, never per-role custom.
2. **Defaults** — add to `DEFAULT_PERMISSIONS` for at least one role. Without this, nobody (except SUPERADMIN via `*:*`) can satisfy it →
   endpoint dead-on-arrival.
3. **Dependencies** — if the permission needs implicit deps (e.g. `menu:update` needs `menu:read` to actually use the resource), add to
   `PERMISSION_DEPENDENCIES`.
4. **Backend gate** — use the _exact_ same string in `checkPermission('resource:action')`.
5. **Frontend gate** — same string in `<PermissionGate permission="resource:action">` and `hasPermission('resource:action')` calls.
6. **TPV gate** — same string in `permissionsRepository.hasPermission("resource:action")`.
7. **Android** — `avoqado-android` does NOT read the permissions array (uses role strings via `RoleManager`). Add a method to `RoleManager`
   and document the role set; verify the set matches what those roles get in `DEFAULT_PERMISSIONS` for the new perm.
8. **Audit** — run `npm run audit:permissions` from `avoqado-server`. Must exit 0.

## Renaming a permission

NEVER rename directly. Existing `VenueRolePermission` overrides in production hold the old name; a rename strands those customers with
toggles that no longer work.

Migration pattern:

1. Add a **bidirectional alias** in `PERMISSION_DEPENDENCIES`:
   ```typescript
   'new:name': ['new:name', 'old:name', /* other deps */],
   'old:name': ['old:name', 'new:name', /* other deps */],
   ```
2. Update routes/UI to the new name in the same commit (so new clients use the new name).
3. Plan a separate migration PR for `VenueRolePermission` rows. Until then, both names coexist and the alias makes them equivalent.
4. Deprecate the old name (comment, not removal) after 30 days. Remove only after a verified migration of all stored overrides.

## Endpoints with sub-actions (commandType-style)

If your endpoint accepts a `type` / `kind` / `action` field in the body and the permission depends on it (e.g. `POST /tpv-commands` accepts
LOCK, RESTART, WIPE), **do NOT** gate with a single generic `checkPermission('resource:write')`. That's how we ended up with WIPE accessible
to anyone who could LOCK.

Instead, create a per-type middleware:

```typescript
const checkCommandTypePermission = (req, res, next) => {
  const perm = `tpv-commands:${req.body.commandType.toLowerCase()}`
  return checkPermission(perm)(req, res, next)
}

router.post(
  '/venues/:venueId/tpv-commands',
  authenticateTokenMiddleware,
  validateRequest(sendCommandSchema), // validate body BEFORE perm check
  checkCommandTypePermission,
  tpvCommandController.sendCommand,
)
```

## Custom `VenueRolePermission` overrides

The wildcard expansion in `evaluatePermissionList` differs from `hasPermission`:

- `hasPermission(role, customPerms, requiredPerm)` — if the role has a wildcard in defaults (e.g. ADMIN's `tpv:*`), the wildcard check
  `${resource}:*` short-circuits.
- `evaluatePermissionList(effectivePerms, requiredPerm)` — wildcards must be present in the _effective_ list. Custom-role editors save the
  _expanded_ list, so `tpv:*` becomes `[tpv:read, tpv:create, ...]` and `tpv:wipe` is NOT in there → 403.

Practical rule: any new permission you add to the catalog **must** be reachable via either an explicit literal or a wildcard in role
defaults. The audit script catches this automatically (PHANTOM error).

## avoqado-android architectural limitation

`avoqado-android` uses role-string sets (`RoleManager.canCreateProducts = role in setOf("MANAGER", "ADMIN", ...)`) instead of consuming the
permissions array. This means **custom VenueRolePermission overrides are ignored on Android**. If a venue denies a default permission via
custom override, the Android UI still shows the option.

This is tracked architectural debt. For now:

- Document the role set in code comments (which `DEFAULT_PERMISSIONS` it mirrors).
- The audit script does not cross-check Android string gates against the catalog; it only flags it as informational.
- If you add a new feature to Android, mirror the role set with the backend defaults exactly. If the backend lists `tpv-x:y` for MANAGER+,
  the Android `canDoX` should check `role in setOf("MANAGER", "ADMIN", "OWNER", "SUPERADMIN")`.

## Automated checks

| Layer                 | Trigger                                         | Command                                                |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Local (before commit) | Manual                                          | `npm run audit:permissions` from `avoqado-server/`     |
| Local strict mode     | Pre-PR                                          | `npm run audit:permissions:strict` (fails on WARN too) |
| CI on every PR        | Auto when permissions.ts or routes/\*\* changes | `.github/workflows/permissions-audit.yml`              |
| CI weekly cron        | Monday 09:00 UTC                                | Same workflow with schedule                            |

The script (`scripts/audit-permissions.ts`) reads sibling repos (`../avoqado-web-dashboard`, `../avoqado-tpv`, `../avoqado-android`) when
run locally — in CI only `avoqado-server` is checked out, so the weekly cron and pre-PR local run cover cross-repo drift.

## What the audit catches

| Code                  | Severity | Meaning                                                                                                                           |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `PHANTOM`             | ERROR    | Backend `checkPermission('X')` where no non-SUPERADMIN role can satisfy X — endpoint dead for everyone except SUPERADMIN.         |
| `DASHBOARD_PHANTOM`   | ERROR    | Dashboard `<PermissionGate permission="X">` where no role can satisfy X — UI gate always false.                                   |
| `TPV_PHANTOM`         | ERROR    | TPV `hasPermission("X")` where no role can satisfy X.                                                                             |
| `CATALOG_GAP`         | WARN     | Backend uses X but X is missing from `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` — cannot be assigned individually from the role editor. |
| `DASHBOARD_DEAD_GATE` | WARN     | Dashboard gates X but no backend endpoint checks X.                                                                               |
| `TPV_CLIENT_ONLY`     | WARN     | TPV gates X but no backend endpoint enforces it. Defense-in-depth recommended.                                                    |
| `NAME_DRIFT`          | WARN     | Two permissions in the same resource are 1 edit apart (likely typo).                                                              |
| `SUPERADMIN_ONLY`     | WARN     | Only SUPERADMIN can satisfy X (via `*:*`). Add to `SUPERADMIN_ONLY_ALLOWLIST` if intentional.                                     |

## When you find an audit warning

- `CATALOG_GAP` — usually means the perm was added to a route but the catalog wasn't updated. Add to `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`.
  If it should remain SUPERADMIN-only, add to `CATALOG_GAP_ALLOWLIST` in the audit script with a comment.
- `DASHBOARD_DEAD_GATE` — either remove the UI gate (the action it protects doesn't exist server-side) or add the missing backend route.
- `TPV_CLIENT_ONLY` — verify there's a `PERMISSION_DEPENDENCIES` bridge between the TPV-side name and the data-level backend name. We use
  this for `tpv-orders:comp` → `orders:comp`. If no bridge exists, add one.
- `NAME_DRIFT` — confirm both names are intentional. If not, fix the typo and add an alias in `PERMISSION_DEPENDENCIES` to bridge any
  existing customer overrides.

## History — what motivated this policy

Found during the 2026-05-22 permission audit:

- 2 phantom permissions in backend (`shifts:manage`, `role-permissions:update`) silently blocked ADMIN/OWNER access to legitimate features.
  Mindform PROD affected.
- 3 name drifts (`features:write` vs `features:update`, `tpv-commands:*` vs `tpv:command:*`, `commissions:process_payout` vs
  `commissions:payout`) caused hidden UI buttons and unreachable endpoints. Mindform PROD had inconsistent perms across ADMIN/MANAGER.
- 22 permissions in backend missing from the catalog → couldn't be granted individually.
- 1 cross-repo drift in TPV (`MenuViewModel.kt` checking `orders:comp` instead of the `tpv-orders:comp` name the dashboard uses) → Fatima
  Flores couldn't apply courtesy at Mindform.

All of these would have been caught by `npm run audit:permissions` on the PR that introduced them.
