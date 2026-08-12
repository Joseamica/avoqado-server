import { compareCatalogVenueDefaults } from '../../../scripts/lib/auditCatalogPermissionDefaults'

const server = {
  VIEWER: ['catalog-venue:read'],
  MANAGER: ['catalog-venue:read', 'catalog-venue:request-override'],
  ADMIN: ['catalog-venue:read', 'catalog-venue:request-override'],
  OWNER: ['catalog-venue:read', 'catalog-venue:request-override'],
  CASHIER: [],
}

const dashboardSource = `
export const DEFAULT_PERMISSIONS = {
  [StaffRole.VIEWER]: ['catalog-venue:read'],
  [StaffRole.MANAGER]: ['catalog-venue:read', 'catalog-venue:request-override'],
  [StaffRole.ADMIN]: ['catalog-venue:read', 'catalog-venue:request-override'],
  [StaffRole.OWNER]: ['catalog-venue:read', 'catalog-venue:request-override'],
  [StaffRole.CASHIER]: [],
}
`

describe('catalog venue default permission mirror audit', () => {
  it('accepts the exact server/dashboard role matrix', () => {
    expect(compareCatalogVenueDefaults(server, dashboardSource)).toEqual([])
  })

  it('fails when the dashboard loses a required role grant', () => {
    const drifted = dashboardSource.replace("'catalog-venue:read', 'catalog-venue:request-override'", "'catalog-venue:read'")
    expect(compareCatalogVenueDefaults(server, drifted)).toContainEqual(
      expect.objectContaining({ code: 'DASHBOARD_DEFAULT_DRIFT', role: 'MANAGER', permission: 'catalog-venue:request-override' }),
    )
  })

  it('fails when either side grants an extra role', () => {
    const drifted = dashboardSource.replace('[StaffRole.CASHIER]: []', "[StaffRole.CASHIER]: ['catalog-venue:request-override']")
    expect(compareCatalogVenueDefaults(server, drifted)).toContainEqual(
      expect.objectContaining({ code: 'DASHBOARD_DEFAULT_DRIFT', role: 'CASHIER', permission: 'catalog-venue:request-override' }),
    )
  })
})
