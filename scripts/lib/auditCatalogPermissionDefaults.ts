export interface CatalogDefaultDrift {
  code: 'SERVER_DEFAULT_CONTRACT' | 'DASHBOARD_DEFAULT_DRIFT'
  role: string
  permission: string
  expected: boolean
  actual: boolean
}

const CONTRACT: Record<string, ReadonlySet<string>> = {
  'catalog-venue:read': new Set(['OWNER', 'ADMIN', 'MANAGER', 'VIEWER']),
  'catalog-venue:request-override': new Set(['OWNER', 'ADMIN', 'MANAGER']),
}

function dashboardDefaults(source: string): Map<string, Set<string>> {
  const defaults = new Map<string, Set<string>>()
  for (const match of source.matchAll(/\[StaffRole\.([A-Z_]+)\]\s*:\s*\[([\s\S]*?)\]\s*,/g)) {
    defaults.set(match[1], new Set(Array.from(match[2].matchAll(/['"]([^'"]+)['"]/g), value => value[1])))
  }
  return defaults
}

export function compareCatalogVenueDefaults(
  serverDefaults: Record<string, readonly string[]>,
  dashboardSource: string,
): CatalogDefaultDrift[] {
  const dashboard = dashboardDefaults(dashboardSource)
  const roles = new Set([...Object.keys(serverDefaults), ...dashboard.keys(), ...Object.values(CONTRACT).flatMap(value => [...value])])
  const drift: CatalogDefaultDrift[] = []

  for (const [permission, expectedRoles] of Object.entries(CONTRACT)) {
    for (const role of roles) {
      const expected = expectedRoles.has(role)
      const serverActual = serverDefaults[role]?.includes(permission) ?? false
      const dashboardActual = dashboard.get(role)?.has(permission) ?? false
      if (serverActual !== expected) {
        drift.push({ code: 'SERVER_DEFAULT_CONTRACT', role, permission, expected, actual: serverActual })
      }
      if (dashboardActual !== expected) {
        drift.push({ code: 'DASHBOARD_DEFAULT_DRIFT', role, permission, expected, actual: dashboardActual })
      }
    }
  }
  return drift
}
