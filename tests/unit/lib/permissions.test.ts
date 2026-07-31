import { StaffRole } from '@prisma/client'
import {
  canAssignRole,
  evaluatePermissionList,
  expandWildcards,
  getEffectiveRolePermissions,
  hasPermission,
} from '../../../src/lib/permissions'

describe('permissions', () => {
  describe('area-ticket counter operator', () => {
    it('allows a WAITER assigned to an area terminal to issue and deliver tickets', () => {
      expect(hasPermission(StaffRole.WAITER, null, 'area-tickets:issue')).toBe(true)
      expect(hasPermission(StaffRole.WAITER, null, 'area-tickets:deliver')).toBe(true)
    })

    it('does not let the area operator collect, cancel, or configure area tickets', () => {
      expect(hasPermission(StaffRole.WAITER, null, 'area-tickets:checkout')).toBe(false)
      expect(hasPermission(StaffRole.WAITER, null, 'area-tickets:cancel')).toBe(false)
      expect(hasPermission(StaffRole.WAITER, null, 'area-tickets:configure')).toBe(false)
    })

    it.each([StaffRole.ADMIN, StaffRole.OWNER])('lets %s operate and configure area tickets and scales', role => {
      expect(hasPermission(role, null, 'area-tickets:issue')).toBe(true)
      expect(hasPermission(role, null, 'area-tickets:configure')).toBe(true)
      expect(hasPermission(role, null, 'scale:use')).toBe(true)
      expect(hasPermission(role, null, 'scale:configure')).toBe(true)
    })

    it('keeps new OWNER defaults when a venue has an older custom permission list', () => {
      const permissions = getEffectiveRolePermissions(StaffRole.OWNER, ['menu:read'])

      expect(permissions).toContain('menu:read')
      expect(permissions).toContain('area-tickets:*')
      expect(permissions).toContain('scale:*')
    })
  })

  describe('discount application', () => {
    it('allows CASHIER through discounts:apply', () => {
      expect(hasPermission(StaffRole.CASHIER, null, 'discounts:apply')).toBe(true)
    })

    it('expands discounts:* to include discounts:apply', () => {
      expect(expandWildcards(['discounts:*'])).toContain('discounts:apply')
    })

    it('keeps legacy tpv-orders:discount permission sets compatible', () => {
      expect(evaluatePermissionList(['tpv-orders:discount'], 'discounts:apply')).toBe(true)
    })
  })

  describe('evaluatePermissionList', () => {
    it('honors dependencies without merging role defaults', () => {
      expect(evaluatePermissionList(['discounts:apply'], 'orders:update')).toBe(true)
    })

    it('honors resource wildcards without merging role defaults', () => {
      expect(evaluatePermissionList(['discounts:*'], 'discounts:apply')).toBe(true)
    })

    it('does not grant unrelated role-default permissions', () => {
      expect(evaluatePermissionList(['discounts:read'], 'orders:update')).toBe(false)
    })
  })

  describe('canAssignRole (privilege-escalation guard)', () => {
    // NEW BEHAVIOR: blocks the escalation vectors
    it('blocks an OWNER from assigning SUPERADMIN (platform takeover vector)', () => {
      expect(canAssignRole(StaffRole.OWNER, StaffRole.SUPERADMIN)).toBe(false)
    })

    it('blocks a MANAGER from assigning OWNER (self-promotion vector)', () => {
      expect(canAssignRole(StaffRole.MANAGER, StaffRole.OWNER)).toBe(false)
    })

    it('blocks a MANAGER from assigning ADMIN', () => {
      expect(canAssignRole(StaffRole.MANAGER, StaffRole.ADMIN)).toBe(false)
    })

    it('blocks an ADMIN from assigning OWNER', () => {
      expect(canAssignRole(StaffRole.ADMIN, StaffRole.OWNER)).toBe(false)
    })

    it('only a SUPERADMIN may assign SUPERADMIN', () => {
      expect(canAssignRole(StaffRole.SUPERADMIN, StaffRole.SUPERADMIN)).toBe(true)
    })

    // REGRESSION: legitimate assignments must still work
    it('allows an OWNER to assign a co-OWNER', () => {
      expect(canAssignRole(StaffRole.OWNER, StaffRole.OWNER)).toBe(true)
    })

    it('allows an OWNER to assign ADMIN / MANAGER / lower', () => {
      expect(canAssignRole(StaffRole.OWNER, StaffRole.ADMIN)).toBe(true)
      expect(canAssignRole(StaffRole.OWNER, StaffRole.MANAGER)).toBe(true)
      expect(canAssignRole(StaffRole.OWNER, StaffRole.WAITER)).toBe(true)
    })

    it('allows an ADMIN to assign ADMIN and below', () => {
      expect(canAssignRole(StaffRole.ADMIN, StaffRole.ADMIN)).toBe(true)
      expect(canAssignRole(StaffRole.ADMIN, StaffRole.MANAGER)).toBe(true)
    })

    it('allows a MANAGER to invite a WAITER (legit team op preserved)', () => {
      expect(canAssignRole(StaffRole.MANAGER, StaffRole.WAITER)).toBe(true)
      expect(canAssignRole(StaffRole.MANAGER, StaffRole.CASHIER)).toBe(true)
    })
  })
})
