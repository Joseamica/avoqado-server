/**
 * Privilege-escalation guard for permission sets (security fix, 2026-07-02).
 *
 * Audit finding #2: an ADMIN could create/assign a permission set containing `*:*`
 * (or OWNER-only perms) to exceed their own role — the escalation `canAssignRole`
 * already blocks on the ROLE path, but the permission-set path had no ceiling.
 * `ungrantablePermissions(callerRole, requested)` returns the requested permissions the
 * caller may NOT grant (empty = all allowed). This locks the guard's core logic.
 */
import { ungrantablePermissions, DEFAULT_PERMISSIONS } from '../../../src/lib/permissions'
import { StaffRole } from '@prisma/client'

describe('ungrantablePermissions — permission-set escalation guard', () => {
  it('SUPERADMIN can grant ANYTHING (has *:*)', () => {
    expect(ungrantablePermissions(StaffRole.SUPERADMIN, ['*:*', 'payments:refund', 'commissions:payout', 'weird:thing'])).toEqual([])
  })

  it('🔒 ADMIN cannot grant *:* (the core exploit)', () => {
    expect(ungrantablePermissions(StaffRole.ADMIN, ['*:*'])).toEqual(['*:*'])
  })

  it('🔒 MANAGER cannot grant *:*', () => {
    expect(ungrantablePermissions(StaffRole.MANAGER, ['*:*'])).toEqual(['*:*'])
  })

  it('a role CANNOT grant a permission it does not hold', () => {
    expect(ungrantablePermissions(StaffRole.ADMIN, ['nonexistent:superpower'])).toEqual(['nonexistent:superpower'])
  })

  it('a role CAN grant a concrete permission it holds by default', () => {
    const adminConcrete = DEFAULT_PERMISSIONS[StaffRole.ADMIN].find(p => !p.includes('*'))
    expect(adminConcrete).toBeDefined()
    expect(ungrantablePermissions(StaffRole.ADMIN, [adminConcrete!])).toEqual([])
  })

  it('a resource-wildcard holder can grant that wildcard and its concrete perms', () => {
    const adminWildcard = DEFAULT_PERMISSIONS[StaffRole.ADMIN].find(p => p.endsWith(':*') && p !== '*:*')
    if (!adminWildcard) return // ADMIN has no resource wildcard — skip
    const res = adminWildcard.slice(0, -2)
    expect(ungrantablePermissions(StaffRole.ADMIN, [`${res}:*`, `${res}:read`])).toEqual([])
  })

  it('mixed request returns ONLY the ungrantable ones', () => {
    const adminConcrete = DEFAULT_PERMISSIONS[StaffRole.ADMIN].find(p => !p.includes('*'))!
    const out = ungrantablePermissions(StaffRole.ADMIN, [adminConcrete, '*:*', 'nonexistent:x'])
    expect(out.sort()).toEqual(['*:*', 'nonexistent:x'].sort())
  })
})
