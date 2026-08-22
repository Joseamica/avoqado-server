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

  // The dashboard's defaults are no longer hand-written: they are GENERATED from this
  // repo's DEFAULT_PERMISSIONS into `generated/defaultPermissions.generated.ts`, whose
  // object literal uses plain keys (`OWNER: [`), not computed ones (`[StaffRole.OWNER]: [`).
  // Only understanding the old shape made the audit report the whole contract as drifted.
  describe('generated artifact shape (plain object keys)', () => {
    const generatedSource = `
export const DEFAULT_PERMISSIONS: Record<StaffRole, string[]> = {
  ADMIN: [
    'catalog-venue:read',
    'catalog-venue:request-override',
  ],
  CASHIER: [
    'orders:read',
  ],
  MANAGER: [
    'catalog-venue:read',
    'catalog-venue:request-override',
  ],
  OWNER: [
    'catalog-venue:read',
    'catalog-venue:request-override',
  ],
  VIEWER: [
    'catalog-venue:read',
  ],
} as Record<StaffRole, string[]>

export const DEFAULT_PERMISSIONS_DIGEST = 'deadbeefdeadbeef'
`

    it('accepts the exact role matrix written with plain keys', () => {
      expect(compareCatalogVenueDefaults(server, generatedSource)).toEqual([])
    })

    it('still detects a real drift in the generated shape', () => {
      const drifted = generatedSource.replace("  VIEWER: [\n    'catalog-venue:read',\n  ],", '  VIEWER: [\n  ],')
      expect(compareCatalogVenueDefaults(server, drifted)).toContainEqual(
        expect.objectContaining({ code: 'DASHBOARD_DEFAULT_DRIFT', role: 'VIEWER', permission: 'catalog-venue:read' }),
      )
    })
  })

  // The bug class: when the parser understands NOTHING, "no roles found" is
  // indistinguishable from "every role lost the permission" — so the audit reported 7
  // confident, precise, WRONG drifts. An unreadable input must say it is unreadable.
  describe('unparseable dashboard source', () => {
    const reExportShim = `
export { DEFAULT_PERMISSIONS } from './generated/defaultPermissions.generated'
export function hasDefaultPermission(role: StaffRole, permission: string): boolean {
  return false
}
`

    it('reports ONE unparseable error instead of a drift per role', () => {
      const result = compareCatalogVenueDefaults(server, reExportShim)
      expect(result.filter(r => r.code === 'DASHBOARD_DEFAULTS_UNPARSEABLE')).toHaveLength(1)
      expect(result.filter(r => r.code === 'DASHBOARD_DEFAULT_DRIFT')).toEqual([])
    })

    it('still checks the SERVER side of the contract when the dashboard is unreadable', () => {
      const serverMissingGrant = { ...server, VIEWER: [] }
      expect(compareCatalogVenueDefaults(serverMissingGrant, reExportShim)).toContainEqual(
        expect.objectContaining({ code: 'SERVER_DEFAULT_CONTRACT', role: 'VIEWER', permission: 'catalog-venue:read' }),
      )
    })
  })
})
