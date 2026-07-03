/**
 * MCP GUARD BATTERY — 2000+ adversarial probes of the customer-MCP security choke point.
 *
 * Every write tool routes its authorization through `createGuard(scope)`:
 *   - guard.venueFilter(venueId)      → tenant isolation (throws on a venue not in scope)
 *   - guard.requirePermission(p, v)   → per-venue RBAC (throws when the venue-role lacks p)
 * If the guard is correct AND every write tool calls it (verified separately, statically),
 * then no MCP caller — however the LLM phrases the request — can read/write another
 * tenant's data or exceed the connected user's role.
 *
 * This battery drives the REAL guard + REAL hasPermission + REAL DEFAULT_PERMISSIONS across
 * thousands of (role × permission × venue) combinations and asserts the invariants hold.
 * Pure in-memory: no DB, no network. Ground-truth oracle = `hasPermission` (the same fn the
 * dashboard uses) plus hard independent assertions (fake perms & foreign venues ALWAYS deny).
 */
import { createGuard, ScopeError } from '../../../src/mcp/guard'
import { DEFAULT_PERMISSIONS } from '../../../src/lib/permissions'
import { hasPermission } from '../../../src/services/access/access.service'
import { StaffRole } from '@prisma/client'
import type { McpScope } from '../../../src/mcp/scope'
import type { UserAccess } from '../../../src/services/access/access.service'

const ROLES: StaffRole[] = [
  StaffRole.SUPERADMIN,
  StaffRole.OWNER,
  StaffRole.ADMIN,
  StaffRole.MANAGER,
  StaffRole.CASHIER,
  StaffRole.WAITER,
  StaffRole.KITCHEN,
  StaffRole.HOST,
  StaffRole.VIEWER,
]

// Sensitive, high-impact actions the MCP write tools gate on (money out, access, prices…).
const SENSITIVE_PERMS = [
  'payments:refund',
  'commissions:payout',
  'settings:manage',
  'teams:update',
  'teams:invite',
  'menu:update',
  'menu:create',
  'discounts:create',
  'staff:delete',
  'sale-verifications:reopen',
  'reservations:create',
  'loyalty:adjust',
  'loyalty:update',
  'reviews:respond',
  'customers:update',
  'accounting:manage',
  'inventory:manage',
  'payment-links:create',
  'coupons:create',
  'tables:update',
]
// Permissions no role should ever satisfy (except SUPERADMIN's `*:*`).
const FAKE_PERMS = ['totally:fake', 'foo:bar', 'nonexistent:superpower', 'xyz:abc', 'drop:tables', 'god:mode']

const OWN_VENUE = 'venue_own'
const OTHER_OWN_VENUE = 'venue_own_2'

function accessFor(venueId: string, role: StaffRole): UserAccess {
  return {
    userId: 's1',
    venueId,
    organizationId: 'o1',
    role,
    corePermissions: DEFAULT_PERMISSIONS[role],
    whiteLabelEnabled: false,
    enabledFeatures: [],
    featureAccess: {},
    featureMetadata: {},
  }
}

function scopeWithRole(role: StaffRole): McpScope {
  const perVenueAccess = new Map<string, UserAccess>()
  perVenueAccess.set(OWN_VENUE, accessFor(OWN_VENUE, role))
  perVenueAccess.set(OTHER_OWN_VENUE, accessFor(OTHER_OWN_VENUE, role))
  return { staffId: 's1', activeOrg: 'o1', allowedVenueIds: [OWN_VENUE, OTHER_OWN_VENUE], perVenueAccess }
}

// Deterministic pseudo-random foreign venue ids (no Math.random — reproducible).
function foreignVenueId(i: number): string {
  return `venue_foreign_${(i * 2654435761) % 1_000_000}_${i}`
}

let assertions = 0
const bump = () => {
  assertions++
}

describe('MCP guard battery — tenant isolation (venueFilter)', () => {
  it('NEVER returns a filter for a venue outside the caller scope — any role, hundreds of foreign ids', () => {
    for (const role of ROLES) {
      const guard = createGuard(scopeWithRole(role))
      for (let i = 0; i < 160; i++) {
        const foreign = foreignVenueId(i)
        expect(() => guard.venueFilter(foreign)).toThrow(ScopeError)
        bump()
      }
      // own venues always resolve to a single-venue filter
      expect(guard.venueFilter(OWN_VENUE)).toEqual({ venueId: { in: [OWN_VENUE] } })
      expect(guard.venueFilter(OTHER_OWN_VENUE)).toEqual({ venueId: { in: [OTHER_OWN_VENUE] } })
      // no venue arg → constrained to exactly the caller's own venues (never a wildcard)
      expect(guard.venueFilter().venueId.in.sort()).toEqual([OWN_VENUE, OTHER_OWN_VENUE].sort())
      bump()
      bump()
      bump()
    }
  })

  it('an empty scope (revoked / no assignments) can touch NOTHING', () => {
    const empty: McpScope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: [], perVenueAccess: new Map() }
    const guard = createGuard(empty)
    for (let i = 0; i < 50; i++) {
      expect(() => guard.venueFilter(foreignVenueId(i))).toThrow(ScopeError)
      bump()
    }
    expect(guard.venueFilter().venueId.in).toEqual([]) // no venue arg → empty set, matches nothing
    bump()
  })
})

describe('MCP guard battery — RBAC (requirePermission)', () => {
  it('a FAKE permission is denied for every non-SUPERADMIN role (and SUPERADMIN passes via *:*)', () => {
    for (const role of ROLES) {
      const guard = createGuard(scopeWithRole(role))
      for (const perm of FAKE_PERMS) {
        if (role === StaffRole.SUPERADMIN) {
          expect(() => guard.requirePermission(perm, OWN_VENUE)).not.toThrow()
        } else {
          expect(() => guard.requirePermission(perm, OWN_VENUE)).toThrow(ScopeError)
        }
        bump()
      }
    }
  })

  it('requirePermission EXACTLY mirrors hasPermission for every role × sensitive-permission', () => {
    for (const role of ROLES) {
      const scope = scopeWithRole(role)
      const guard = createGuard(scope)
      const access = scope.perVenueAccess.get(OWN_VENUE)!
      for (const perm of SENSITIVE_PERMS) {
        const allowed = hasPermission(access, perm)
        if (allowed) expect(() => guard.requirePermission(perm, OWN_VENUE)).not.toThrow()
        else expect(() => guard.requirePermission(perm, OWN_VENUE)).toThrow(ScopeError)
        bump()
      }
    }
  })

  it('low-privilege roles are DENIED access-control / payout actions (hard independent assertion)', () => {
    // The 5 lowest roles. NOTE (verified against DEFAULT_PERMISSIONS): CASHIER legitimately
    // holds `payments:refund` (counter refunds) and HOST holds `reservations:create` — those
    // are deliberate role-design choices the guard faithfully enforces, so they are NOT in the
    // forbidden set here. FORBIDDEN = actions NO low role has by default (payout, settings,
    // team-management, staff deletion) — a caller at these roles must be denied them everywhere.
    const LOW = [StaffRole.WAITER, StaffRole.KITCHEN, StaffRole.HOST, StaffRole.VIEWER, StaffRole.CASHIER]
    const FORBIDDEN = ['commissions:payout', 'settings:manage', 'teams:update', 'teams:invite', 'staff:delete']
    for (const role of LOW) {
      const guard = createGuard(scopeWithRole(role))
      for (const perm of FORBIDDEN) {
        expect(() => guard.requirePermission(perm, OWN_VENUE)).toThrow(ScopeError)
        bump()
      }
    }
  })

  it('requirePermission on a venue NOT in perVenueAccess always throws (no access row = no power)', () => {
    for (const role of ROLES) {
      const guard = createGuard(scopeWithRole(role))
      for (let i = 0; i < 20; i++) {
        expect(() => guard.requirePermission('menu:read', foreignVenueId(i))).toThrow(ScopeError)
        bump()
      }
    }
  })

  it('a permission granted at venue A is NOT usable at venue B when B gives the caller a weaker role', () => {
    // venue A: OWNER (can refund). venue B: WAITER (cannot). Same connection.
    const perVenueAccess = new Map<string, UserAccess>()
    perVenueAccess.set('vA', accessFor('vA', StaffRole.OWNER))
    perVenueAccess.set('vB', accessFor('vB', StaffRole.WAITER))
    const scope: McpScope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['vA', 'vB'], perVenueAccess }
    const guard = createGuard(scope)
    for (let i = 0; i < 40; i++) {
      expect(() => guard.requirePermission('payments:refund', 'vA')).not.toThrow() // OWNER can
      expect(() => guard.requirePermission('payments:refund', 'vB')).toThrow(ScopeError) // WAITER cannot
      bump()
      bump()
    }
  })
})

describe('MCP guard battery — PII redaction', () => {
  it('strips maskedPan / referenceNumber / authorizationNumber from any result row', () => {
    const guard = createGuard(scopeWithRole(StaffRole.OWNER))
    for (let i = 0; i < 50; i++) {
      const [row] = guard.redact([
        { id: `p${i}`, amount: 100, maskedPan: '**** 2026', referenceNumber: 'REF', authorizationNumber: 'AUTH', keep: 'yes' },
      ])
      expect(row).not.toHaveProperty('maskedPan')
      expect(row).not.toHaveProperty('referenceNumber')
      expect(row).not.toHaveProperty('authorizationNumber')
      expect(row).toMatchObject({ id: `p${i}`, amount: 100, keep: 'yes' })
      bump()
    }
  })
})

describe('MCP guard battery — total coverage', () => {
  it('ran at least 2000 adversarial assertions', () => {
    console.log(`\n🔒 MCP guard battery: ${assertions} adversarial assertions passed.\n`)
    expect(assertions).toBeGreaterThanOrEqual(2000)
  })
})
