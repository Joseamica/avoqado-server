import { StaffRole } from '@prisma/client'

import { INDIVIDUAL_PERMISSIONS_BY_RESOURCE, hasPermission, resolvePermissions } from '@/lib/permissions'

describe("permiso 'commercial:reconcile_payment'", () => {
  it('is explicit, readable and not implied by catalog publication', () => {
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.commercial).toContain('commercial:reconcile_payment')
    expect(resolvePermissions(['commercial:reconcile_payment'])).toEqual(
      new Set(['commercial:reconcile_payment', 'commercial:read']),
    )
    expect(resolvePermissions(['commercial:publish']).has('commercial:reconcile_payment')).toBe(false)
  })

  it('is founder-only by default through the SUPERADMIN wildcard', () => {
    expect(hasPermission(StaffRole.SUPERADMIN, null, 'commercial:reconcile_payment')).toBe(true)
    for (const role of [StaffRole.OWNER, StaffRole.ADMIN, StaffRole.MANAGER, StaffRole.CASHIER]) {
      expect(hasPermission(role, null, 'commercial:reconcile_payment')).toBe(false)
    }
  })
})
