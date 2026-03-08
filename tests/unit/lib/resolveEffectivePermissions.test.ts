import { getEffectivePermissions } from '../../../src/lib/resolveEffectivePermissions'

describe('getEffectivePermissions', () => {
  const rolePermissions = ['menu:read', 'orders:read', 'orders:create']

  // ==========================================
  // NEW FEATURE TESTS
  // ==========================================

  it('should return permission set permissions when assigned', () => {
    const staffVenue = {
      permissionSetId: 'ps-1',
      permissionSet: {
        id: 'ps-1',
        venueId: 'venue-1',
        name: 'Bar Lead',
        description: null,
        permissions: ['products:read', 'shifts:create', 'inventory:read'],
        color: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    }

    const result = getEffectivePermissions(staffVenue, rolePermissions)

    expect(result).toEqual(['products:read', 'shifts:create', 'inventory:read'])
  })

  it('should return role permissions when no permission set assigned', () => {
    const staffVenue = {
      permissionSetId: null,
      permissionSet: null,
    }

    const result = getEffectivePermissions(staffVenue, rolePermissions)

    expect(result).toEqual(rolePermissions)
  })

  it('should return role permissions when permissionSetId is null', () => {
    const staffVenue = {
      permissionSetId: null,
      permissionSet: undefined,
    }

    const result = getEffectivePermissions(staffVenue, rolePermissions)

    expect(result).toEqual(rolePermissions)
  })

  it('should return role permissions when permissionSet object is null (deleted)', () => {
    // This happens when permission set was deleted (SetNull)
    const staffVenue = {
      permissionSetId: null,
      permissionSet: null,
    }

    const result = getEffectivePermissions(staffVenue, rolePermissions)

    expect(result).toEqual(rolePermissions)
  })

  it('should handle empty permission set permissions array', () => {
    const staffVenue = {
      permissionSetId: 'ps-1',
      permissionSet: {
        id: 'ps-1',
        venueId: 'venue-1',
        name: 'Empty Set',
        description: null,
        permissions: [] as string[],
        color: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    }

    const result = getEffectivePermissions(staffVenue, rolePermissions)

    expect(result).toEqual([])
  })

  // ==========================================
  // REGRESSION TESTS
  // ==========================================

  it('should not modify the original role permissions array', () => {
    const originalPerms = ['menu:read', 'orders:read']
    const staffVenue = { permissionSetId: null, permissionSet: null }

    getEffectivePermissions(staffVenue, originalPerms)

    expect(originalPerms).toEqual(['menu:read', 'orders:read'])
  })

  it('should handle missing fields gracefully', () => {
    const staffVenue = {} as any

    const result = getEffectivePermissions(staffVenue, rolePermissions)

    expect(result).toEqual(rolePermissions)
  })
})
