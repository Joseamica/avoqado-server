# Granular Permission System (Action-Based Permissions)

This document details the complete permission system implementation using action-based permissions inspired by Fortune 500 companies like
Stripe, AWS, and GitHub.

## 🔴 IMPORTANT: Centralized Architecture (2024 Update)

**Backend is the SINGLE SOURCE OF TRUTH for all permissions.**

The permission system is now centralized with the following architecture:

```
Backend (Single Source of Truth)
├── /api/v1/me/access → Returns resolved permissions to frontend
├── PERMISSION_TO_FEATURE_MAP → Maps permissions to white-label features
├── access.service.ts → Resolves + filters permissions for white-label
└── verifyAccess middleware → Enforces on API routes

Frontend (UI Only - No mapping logic)
├── useAccess() → Fetches from /me/access
├── can('permission') → Just checks, no mapping needed
└── PermissionGate → UI visibility only
```

**Key Files (Centralized System):**

| File                                         | Purpose                                                           |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `src/lib/permissions.ts`                     | `DEFAULT_PERMISSIONS` by role, permission validation              |
| `src/services/access/access.service.ts`      | **CENTRAL** - Permission resolution + `PERMISSION_TO_FEATURE_MAP` |
| `src/middlewares/verifyAccess.middleware.ts` | **RECOMMENDED** - Unified route protection                        |
| `src/routes/me.routes.ts`                    | `/me/access` endpoint for frontend                                |

**When adding new features, see "Adding New Permissions" section below.**

---

## Architecture Overview

The platform uses a **granular permission system** based on action-based permissions.

**Permission Format**: `"resource:action"` (e.g., `"tpv:create"`, `"menu:update"`, `"analytics:export"`)

## Two-Layer Permission System

1. **Default Role-Based Permissions** - Defined in `src/lib/permissions.ts`
2. **Custom Permissions** - Stored in `VenueRolePermission` table (per venue + role)

**Key Files:**

- `src/lib/permissions.ts` - Permission constants and validation logic
- `src/services/access/access.service.ts` - Central permission resolution service
- `src/middlewares/verifyAccess.middleware.ts` - Unified route-level permission middleware
- `src/middlewares/checkPermission.middleware.ts` - Legacy route-level permission middleware
- `prisma/schema.prisma` - `VenueRolePermission` model for custom permissions

## Permission Middleware Usage

### Basic usage (single permission)

```typescript
import { checkPermission } from '../middlewares/checkPermission.middleware'

router.get('/venues/:venueId/tpvs', authenticateTokenMiddleware, checkPermission('tpv:read'), tpvController.getTerminals)

router.post('/venues/:venueId/tpvs', authenticateTokenMiddleware, checkPermission('tpv:create'), tpvController.createTpv)
```

### Multiple permissions (requires ANY)

```typescript
import { checkAnyPermission } from '../middlewares/checkPermission.middleware'

router.get(
  '/venues/:venueId/analytics',
  authenticateTokenMiddleware,
  checkAnyPermission(['analytics:read', 'analytics:export']),
  analyticsController.getData,
)
```

### Multiple permissions (requires ALL)

```typescript
import { checkAllPermissions } from '../middlewares/checkPermission.middleware'

router.post(
  '/venues/:venueId/admin/dangerous-action',
  authenticateTokenMiddleware,
  checkAllPermissions(['admin:write', 'admin:delete']),
  adminController.dangerousAction,
)
```

## Wildcard Permissions

- `"*:*"` - All permissions (ADMIN, OWNER, SUPERADMIN roles)
- `"tpv:*"` - All TPV actions (create, read, update, delete, command)
- `"*:read"` - Read access to all resources

## Default Permissions by Role

From `src/lib/permissions.ts`:

### VIEWER

```typescript
;['home:read', 'analytics:read', 'menu:read', 'orders:read', 'payments:read', 'shifts:read', 'reviews:read', 'teams:read']
```

### WAITER

```typescript
;[
  'menu:read',
  'menu:create',
  'menu:update',
  'orders:read',
  'orders:create',
  'orders:update',
  'payments:read',
  'payments:create',
  'shifts:read',
  'tables:read',
  'tables:update',
  'reviews:read',
  'teams:read',
  'tpv:read',
]
```

### MANAGER

```typescript
;[
  'analytics:read',
  'analytics:export',
  'menu:*', // All menu actions
  'orders:*', // All order actions
  'payments:read',
  'payments:create',
  'payments:refund',
  'shifts:*', // All shift actions
  'tpv:read',
  'tpv:create',
  'tpv:update',
  'tpv:command',
  'reviews:respond',
  'teams:update',
]
```

### ADMIN, OWNER, SUPERADMIN

```typescript
;['*:*'] // Full access to all resources and actions
```

## Custom Permissions (Per-Venue Overrides)

The system supports custom permissions via `StaffVenue.permissions` JSON field.

### Database Schema

From `prisma/schema.prisma`:

```prisma
model StaffVenue {
  id          String   @id @default(cuid())
  staffId     String
  venueId     String
  role        StaffRole
  permissions Json?    // Custom permissions array: ["feature:action", ...]
  // ...
}
```

### Override vs Merge Logic

#### Override Mode (for wildcard roles: ADMIN, OWNER, SUPERADMIN)

When a wildcard role has custom permissions, the custom permissions **completely replace** the default `*:*`:

```typescript
// Example: OWNER in a specific venue
Default permissions: ['*:*']  // All permissions
Custom permissions:  ['orders:read', 'payments:read']  // Only these 2

// Result: Uses ONLY custom (complete override)
// ✅ OWNER can access orders and payments
// ❌ OWNER CANNOT access menu (menu:read not in custom list)
```

**Use case**: Restrict a high-privilege role to specific actions in a particular venue.

#### Merge Mode (for non-wildcard roles: WAITER, CASHIER, etc.)

When a non-wildcard role has custom permissions, they are **added to** the default permissions:

```typescript
// Example: WAITER in a specific venue
Default permissions: ['menu:read', 'orders:create', 'tpv:read']
Custom permissions:  ['inventory:read', 'analytics:export']

// Result: Default + Custom (additive merge)
// ✅ WAITER has ALL default permissions PLUS the 2 custom ones
Final: ['menu:read', 'orders:create', 'tpv:read', 'inventory:read', 'analytics:export']
```

**Use case**: Grant additional permissions to lower-privilege roles without removing their base permissions.

### Per-Venue Customization

The same user can have different permissions in different venues:

```typescript
// Venue A: WAITER has default permissions only
VenueRolePermission: null

// Venue B: WAITER has extra permissions
VenueRolePermission: {
  venueId: 'venue_B',
  role: 'WAITER',
  permissions: ['inventory:read', 'shifts:close']
}

// ✅ Same user, different permissions based on venue context
```

## `authorizeRole` vs `checkPermission` - Understanding the Paradigm Shift

The system has fully migrated from role-based authorization (`authorizeRole`) to permission-based authorization (`checkPermission`). **These
are fundamentally different approaches**, not just extensions.

### `authorizeRole` - Legacy Role-Based Approach (RBAC) - DEPRECATED

```typescript
authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.OWNER])
```

**How it works:**

- Question: "Is your role in this list?"
- Static check - Cannot be customized per venue
- All or nothing - If you're a WAITER, you're blocked. Period.

**Limitations:**

- ❌ Very rigid - Cannot grant extra permissions to lower roles
- ❌ Cannot remove permissions from higher roles (OWNER always has full access)
- ❌ Same permissions for all venues (no per-venue customization)
- ❌ No granularity - You either have full role access or none

**Example problem:**

```typescript
// Analytics route
router.get(
  '/venues/:venueId/analytics',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]),
  analyticsController.getData,
)

// ❌ WAITER blocked - No way to grant analytics access to a specific WAITER
// ❌ OWNER has access - No way to restrict analytics from a specific OWNER
```

### `checkPermission` - Modern Permission-Based Approach (ABAC)

```typescript
checkPermission('menu:read')
```

**How it works:**

- Question: "Do you have this specific permission?"
- Dynamic check - Queries `VenueRolePermission` table on each request
- Granular control - Permissions calculated using override/merge logic

**Advantages:**

1. **Override Mode** - Restrict high-privilege roles
2. **Merge Mode** - Grant extra permissions to low-privilege roles
3. **Per-Venue Customization** - Same user, different permissions per venue

### Real-World Comparison

**Scenario:** An OWNER wants to give analytics access to a WAITER, but NOT menu editing.

#### ❌ With `authorizeRole` (impossible):

```typescript
// Analytics route
router.get(
  '/venues/:venueId/analytics',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]),
  /* WAITER blocked - No way to grant access */
)

// Menu route
router.post(
  '/venues/:venueId/menu/products',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]),
  /* WAITER blocked - Correct, but not granular */
)
```

#### ✅ With `checkPermission` (flexible):

```typescript
// Analytics route
router.get(
  '/venues/:venueId/analytics',
  authenticateTokenMiddleware,
  checkPermission('analytics:read'),
  /* ✅ WAITER can access if custom permission granted */
)

// Menu route
router.post(
  '/venues/:venueId/menu/products',
  authenticateTokenMiddleware,
  checkPermission('menu:create'),
  /* ✅ WAITER blocked - Doesn't have this permission */
)

// In database:
VenueRolePermission {
  venueId: 'venue_123',
  role: 'WAITER',
  permissions: ['analytics:read', 'analytics:export']
}
```

### Key Differences Summary

| Aspect                      | `authorizeRole`             | `checkPermission`                          |
| --------------------------- | --------------------------- | ------------------------------------------ |
| **Type**                    | Role-based (RBAC)           | Permission-based (ABAC)                    |
| **Flexibility**             | Static, same for all venues | Dynamic, customizable per venue            |
| **Granularity**             | Full role (all or nothing)  | Specific permission (resource:action)      |
| **Customization**           | ❌ Impossible               | ✅ Via `VenueRolePermission` table         |
| **Remove perms from OWNER** | ❌ Impossible               | ✅ Override mode                           |
| **Add perms to WAITER**     | ❌ Impossible               | ✅ Merge mode                              |
| **Database queries**        | None                        | Queries `VenueRolePermission` each request |

### Migration Example

**Before (role-based):**

```typescript
router.get(
  '/venues/:venueId/menucategories',
  authenticateTokenMiddleware,
  authorizeRole([StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.OWNER]),
  menuController.listMenuCategoriesHandler,
) // ❌ Rigid
```

**After (permission-based):**

```typescript
router.get(
  '/venues/:venueId/menucategories',
  authenticateTokenMiddleware,
  checkPermission('menu:read'),
  menuController.listMenuCategoriesHandler,
) // ✅ Flexible + customizable
```

**Result:** The system now respects custom permissions configured in the `VenueRolePermission` table, enabling use cases like "OWNER without
menu access" or "WAITER with analytics access".

### When to Use Each

#### Use `checkPermission` (REQUIRED for all new routes)

✅ **ALL features** - Business-critical and administrative features ✅ Granular control over permissions ✅ Per-venue permission
customization ✅ Flexible permission assignment to any role

#### Do NOT use `authorizeRole` (deprecated)

❌ **Deprecated** - Do not use in new code ❌ Exists only for reference and understanding migration ❌ All existing routes have been
migrated to `checkPermission` ❌ Use `checkPermission` with appropriate permission strings instead (e.g., `system:manage` for
SUPERADMIN-only features)

## Migration Status

### 🎉 100% MIGRATION COMPLETE - PURE SINGLE PARADIGM ACHIEVED

All 74 routes in the codebase now use `checkPermission` middleware. Zero exceptions. No hybrid approach.

**Completed migrations:**

- ✅ Menu routes - 38 routes (menucategories, menus, products, modifiers, modifier-groups)
- ✅ Orders routes - 4 routes (read, update, delete)
- ✅ Payments routes - 2 routes (read receipts)
- ✅ Reviews routes - 1 route (read)
- ✅ Analytics routes - 4 routes (general stats, metrics, charts)
- ✅ Venues routes - 5 routes (create, read, update, delete, enhanced)
- ✅ Teams routes - 8 routes (list, invite, update, delete, resend)
- ✅ Notifications routes - 3 routes (send, bulk send)
- ✅ System routes - 4 routes (payment config, testing endpoints)
- ✅ Permission Management routes - 5 routes (role permissions CRUD, hierarchy)

**Total: 74 routes using `checkPermission` ✅**

### New Permission Strings (System & Settings)

These permissions are covered by the `*:*` wildcard for SUPERADMIN, OWNER, and ADMIN:

```typescript
'system:config' // SUPERADMIN - Payment provider configuration
'system:test' // SUPERADMIN - Testing payment endpoints
'settings:manage' // OWNER/ADMIN - Role permission management
```

### Why 100% migration matters

✅ **Pure single paradigm** - Follows Stripe/AWS/GitHub patterns exactly ✅ **Zero confusion** - Developers always use `checkPermission`, no
exceptions ✅ **Maximum flexibility** - Even system routes can be customized via VenueRolePermission ✅ **Future-proof** - Can grant
`system:test` to non-SUPERADMINs if needed ✅ **Self-documenting** - Permission strings clearly describe what each route does

### Verification

```bash
# Count total checkPermission uses (should be 74 + 1 import = 75)
grep -c "checkPermission" src/routes/dashboard.routes.ts  # Result: 75

# Count authorizeRole uses (should be ONLY the import = 1)
grep "authorizeRole" src/routes/dashboard.routes.ts | wc -l  # Result: 1 (just the import statement)
```

## Permission Best Practices

### 1. Use granular permissions instead of role checks

```typescript
// ✅ GOOD - Permission-based
router.post('/tpvs',
  authenticateTokenMiddleware,
  checkPermission('tpv:create'),
  ...
)

// ❌ BAD - Role-based (too rigid)
router.post('/tpvs',
  authenticateTokenMiddleware,
  authorizeRole(['MANAGER', 'ADMIN']),
  ...
)
```

### 2. Keep frontend and backend permissions in sync

- **Frontend**: `avoqado-web-dashboard/src/lib/permissions/defaultPermissions.ts`
- **Backend**: `avoqado-server/src/lib/permissions.ts`

⚠️ **CRITICAL**: Both files must have identical permission arrays for each role.

### 3. Always document new permissions

When adding features:

1. Add permission to `DEFAULT_PERMISSIONS` constant
2. Update this documentation with new permission strings
3. Update frontend permission configuration

### 4. Permission naming convention

- **Resource** should be singular: `tpv`, `menu`, `order`, `payment`
- **Action** should be standard CRUD + custom: `read`, `create`, `update`, `delete`, `command`, `export`, `respond`
- **Format**: `resource:action`

## Request Context Pattern

⚠️ **CRITICAL**: The `authenticateTokenMiddleware` attaches user information to `req.authContext`, NOT `req.user`:

```typescript
// ✅ CORRECT - Use authContext
const authContext = (req as any).authContext
if (!authContext || !authContext.role) {
  return res.status(401).json({ error: 'Unauthorized' })
}
const userRole = authContext.role // StaffRole
const userId = authContext.userId
const venueId = authContext.venueId
const orgId = authContext.orgId

// ❌ WRONG - req.user does NOT exist
const user = (req as any).user // undefined!
```

**AuthContext Structure** (from `src/security.ts`):

```typescript
interface AuthContext {
  userId: string
  orgId: string
  venueId: string
  role: StaffRole
}
```

**Common Mistake**: Creating new middleware that reads `req.user` instead of `req.authContext`, causing "No user found in request" errors
even though authentication succeeded.

**Where to find this:**

- Middleware: `src/middlewares/authenticateToken.middleware.ts:37` (Sets `req.authContext`)
- `src/middlewares/checkPermission.middleware.ts:25` (Reads `req.authContext`, current standard)
- `src/middlewares/authorizeRole.middleware.ts:14,23` (Reads `req.authContext`, deprecated - use checkPermission instead)

## Implementing Admin Permission Management UI (Future)

Since `StaffVenue.permissions` exists in the schema, you can build an admin UI to:

1. **View staff permissions** per venue
2. **Assign custom permissions** to individual staff members
3. **Override default role permissions** with granular control

### Example Implementation

**Backend endpoint to update staff permissions:**

```typescript
router.put(
  '/venues/:venueId/staff/:staffId/permissions',
  authenticateTokenMiddleware,
  checkPermission('staff:manage'),
  async (req, res) => {
    const { permissions } = req.body // Array of permission strings

    await prisma.staffVenue.update({
      where: {
        staffId_venueId: {
          staffId: req.params.staffId,
          venueId: req.params.venueId,
        },
      },
      data: { permissions },
    })

    res.json({ success: true })
  },
)
```

### Frontend UI Requirements

- **Checkbox grid**: Rows = resources, Columns = actions
- **Separate section** for custom permissions
- **Visual indicator** showing role defaults vs custom overrides
- **Permission inheritance display** (role → custom)

## White-Label Permission Filtering

When a venue has the `WHITE_LABEL_DASHBOARD` module enabled, permissions are automatically filtered based on enabled features.

### PERMISSION_TO_FEATURE_MAP

Located in `src/services/access/access.service.ts`:

```typescript
const PERMISSION_TO_FEATURE_MAP: Record<string, string> = {
  // TPV Management
  'tpv:read': 'AVOQADO_TPVS',
  'tpv:write': 'AVOQADO_TPVS',

  // Team Management
  'teams:read': 'AVOQADO_TEAM',
  'teams:write': 'AVOQADO_TEAM',

  // Menu Management
  'menu:read': 'AVOQADO_MENU',
  'menu:write': 'AVOQADO_MENU',

  // ... etc
}
```

### How It Works

1. User requests `/me/access?venueId=xxx`
2. `access.service.ts` resolves permissions normally
3. If white-label is enabled:
   - Checks each permission against `PERMISSION_TO_FEATURE_MAP`
   - If the feature is disabled or user's role doesn't have access → permission is filtered out
4. Frontend receives only the permissions the user actually has

**Frontend just calls `can('permission')` - no mapping logic needed.**

## Adding New Permissions

**🔴 MANDATORY: Follow these steps when adding new features:**

### Step 1: Add to DEFAULT_PERMISSIONS

In `src/lib/permissions.ts`:

```typescript
export const DEFAULT_PERMISSIONS: Record<StaffRole, string[]> = {
  [StaffRole.VIEWER]: [
    // ... existing
  ],
  [StaffRole.MANAGER]: [
    // ... existing
    'newfeature:read',
    'newfeature:create',
  ],
  [StaffRole.ADMIN]: ['*:*'],
  [StaffRole.OWNER]: ['*:*'],
  [StaffRole.SUPERADMIN]: ['*:*'],
}
```

### Step 2: If White-Label Feature, Add to PERMISSION_TO_FEATURE_MAP

In `src/services/access/access.service.ts`:

```typescript
const PERMISSION_TO_FEATURE_MAP: Record<string, string> = {
  // ... existing
  'newfeature:read': 'AVOQADO_NEWFEATURE',
  'newfeature:create': 'AVOQADO_NEWFEATURE',
  'newfeature:update': 'AVOQADO_NEWFEATURE',
  'newfeature:delete': 'AVOQADO_NEWFEATURE',
}
```

### Step 3: Protect Routes with verifyAccess

```typescript
import { verifyAccess } from '@/middlewares/verifyAccess.middleware'

router.get('/newfeature', authenticateTokenMiddleware, verifyAccess({ permission: 'newfeature:read' }), controller.list)

router.post('/newfeature', authenticateTokenMiddleware, verifyAccess({ permission: 'newfeature:create' }), controller.create)
```

### Step 4: Update Documentation

Update this file (`docs/PERMISSIONS_SYSTEM.md`) with new permission strings.

### Verification

Run the centralization checker:

```bash
bash scripts/check-permission-migration.sh
```

## Venue Access: `StaffVenue.active` and Org-Level OWNER

### Access Resolution Priority (in `getUserAccess()`)

When a user accesses a venue, `getUserAccess()` resolves their role in this order:

| Priority | Condition | Result |
|----------|-----------|--------|
| 1 | User has any `StaffVenue.role = SUPERADMIN` | SUPERADMIN — access to ALL venues |
| 2 | User has `StaffOrganization.role = OWNER` for the venue's org | **OWNER always** — ignores StaffVenue.active |
| 3 | User has `StaffVenue` with `active = true` | Uses the per-venue `StaffVenue.role` |
| 4 | Everything else | **Access denied** |

### Business Rules

**Org-Level OWNER (StaffOrganization.role = OWNER):**
- OWNER of an organization = OWNER of ALL venues in that org
- Cannot be downgraded or deactivated per-venue
- `StaffVenue.active = false` is ignored for org-level OWNERs
- This is by design: organization ownership implies full venue authority

**Non-OWNER roles (ADMIN, MANAGER, WAITER, VIEWER, etc.):**
- Access is per-venue via `StaffVenue`
- `StaffVenue.active = false` means **no access** to that venue
- Role can vary per venue (e.g., ADMIN in Venue A, WAITER in Venue B)

### Example

```
Jose in org "Pollos" (StaffOrganization.role = OWNER):
  → Pollo 1: OWNER (always, even if StaffVenue.active = false)
  → Pollo 2: OWNER (always)
  → Pollo 3: OWNER (always)

Jose in org "Patos" (StaffOrganization.role = ADMIN):
  → Pato 1: StaffVenue.role = ADMIN, active = true  → ADMIN access
  → Pato 2: StaffVenue.role = OWNER, active = true  → OWNER access
  → Pato 3: StaffVenue.active = false               → NO access
```

### Scope of `getUserAccess()` enforcement

`getUserAccess()` is called by:
- `verifyAccess` middleware (white-label routes: storesAnalysis, commandCenter, promoters, stockDashboard)
- `GET /api/v1/me/access` endpoint (frontend `useAccess()` hook)

It does NOT affect:
- `checkPermission` middleware (legacy/core routes)
- Venue switcher (`getAuthStatus` / `switchVenueForStaff`)
- TPV auth (PIN login)
- Login/logout flow

## Related Documentation

- **Root CLAUDE.md** - Architecture overview and authentication flow
- **STRIPE_INTEGRATION.md** - Feature access control middleware usage
- **avoqado-web-dashboard/docs/architecture/permissions.md** - Frontend permission usage
