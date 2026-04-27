import { StaffRole } from '@prisma/client'
import { evaluatePermissionList, expandWildcards, hasPermission } from '../../../src/lib/permissions'

describe('permissions', () => {
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
})
