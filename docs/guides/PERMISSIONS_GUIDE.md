# Permissions System - Claude Operational Guide

> Dense cheat sheet for working with permissions. Full architecture: `docs/PERMISSIONS_SYSTEM.md`

---

## The Only Middleware You Should Use

```typescript
import { checkPermission } from '../middlewares/checkPermission.middleware'
import { checkAnyPermission } from '../middlewares/checkPermission.middleware'
import { checkAllPermissions } from '../middlewares/checkPermission.middleware'

// Single permission (most common)
router.get('/endpoint', authenticateTokenMiddleware, checkPermission('resource:action'), handler)

// ANY of these permissions
router.get('/endpoint', authenticateTokenMiddleware, checkAnyPermission(['perm:a', 'perm:b']), handler)

// ALL of these permissions
router.post('/endpoint', authenticateTokenMiddleware, checkAllPermissions(['perm:a', 'perm:b']), handler)
```

**`authorizeRole` is LEGACY.** It still exists in ~7 routes but should NOT be used in new code. Use `checkPermission` exclusively.

---

## Permission Format

`"resource:action"` - Resource is singular, action is CRUD + custom.

**Standard actions:** `read`, `create`, `update`, `delete`, `command`, `export`, `respond`, `manage`

**Wildcards:**
- `"*:*"` - All permissions (ADMIN, OWNER, SUPERADMIN default)
- `"tpv:*"` - All TPV actions
- `"*:read"` - Read all resources

---

## Default Permissions by Role

| Role | Permissions |
|------|-------------|
| VIEWER | `home:read`, `analytics:read`, `menu:read`, `orders:read`, `payments:read`, `shifts:read`, `reviews:read`, `teams:read` |
| WAITER | menu:read/create/update, orders:read/create/update, payments:read/create, shifts:read, tables:read/update, reviews:read, teams:read, tpv:read |
| MANAGER | analytics:read/export, menu:*, orders:*, payments:read/create/refund, shifts:*, tpv:read/create/update/command, reviews:respond, teams:update |
| ADMIN/OWNER/SUPERADMIN | `*:*` (full access) |

**Source of truth:** `src/lib/permissions.ts` -> `DEFAULT_PERMISSIONS`

---

## Override vs Merge Mode

**Wildcard roles** (ADMIN, OWNER, SUPERADMIN) use **Override Mode**:
- If custom permissions exist in `VenueRolePermission` -> ONLY those permissions apply
- Default `*:*` is completely replaced

**Non-wildcard roles** (WAITER, CASHIER, etc.) use **Merge Mode**:
- Custom permissions are ADDED to defaults (additive)
- Default permissions are never removed

**Per-venue customization** via `VenueRolePermission` table:
```typescript
// Same role, different permissions per venue
VenueRolePermission { venueId: 'venue_B', role: 'WAITER', permissions: ['inventory:read'] }
// WAITER in venue_B gets: all default WAITER perms + inventory:read
```

---

## 4-Step Checklist: Adding a New Feature with Permissions

### Step 1: Add to `DEFAULT_PERMISSIONS` in `src/lib/permissions.ts`
```typescript
[StaffRole.MANAGER]: [
  // ... existing
  'reports:read',
  'reports:create',
]
```

### Step 2: If white-label feature, add to `PERMISSION_TO_FEATURE_MAP` in `src/services/access/access.service.ts`
```typescript
const PERMISSION_TO_FEATURE_MAP: Record<string, string> = {
  // ... existing (66+ mappings)
  'reports:read': 'AVOQADO_REPORTS',
  'reports:create': 'AVOQADO_REPORTS',
}
```

### Step 3: Protect routes with `verifyAccess` middleware
```typescript
import { verifyAccess } from '@/middlewares/verifyAccess.middleware'

router.get('/reports', authenticateTokenMiddleware, verifyAccess({ permission: 'reports:read' }), handler)
```

### Step 4: Update docs
- Update `docs/PERMISSIONS_SYSTEM.md`
- Sync frontend: `avoqado-web-dashboard/src/lib/permissions/defaultPermissions.ts` MUST match backend

---

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/permissions.ts` | `DEFAULT_PERMISSIONS` by role |
| `src/services/access/access.service.ts` | Permission resolution + `PERMISSION_TO_FEATURE_MAP` (66+ mappings) |
| `src/middlewares/verifyAccess.middleware.ts` | Route protection (combines permission + feature check) |
| `src/middlewares/checkPermission.middleware.ts` | Permission-only middleware (3 variants) |
| `src/middlewares/checkFeatureAccess.middleware.ts` | Subscription/feature-gating middleware |
| `prisma/schema.prisma` -> `VenueRolePermission` | Per-venue role permission overrides |

---

## Common Mistakes

```typescript
// WRONG - authorizeRole is deprecated
router.post('/endpoint', authenticateTokenMiddleware, authorizeRole(['ADMIN']), handler)

// CORRECT - use checkPermission
router.post('/endpoint', authenticateTokenMiddleware, checkPermission('resource:action'), handler)

// WRONG - Frontend must match backend
// If you add 'reports:read' to backend DEFAULT_PERMISSIONS but not to frontend -> UI breaks

// WRONG - Forgetting PERMISSION_TO_FEATURE_MAP for white-label features
// Without the mapping, the feature won't be gated by subscription
```

## Verification Script

```bash
bash scripts/check-permission-migration.sh
```
