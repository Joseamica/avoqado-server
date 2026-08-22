export interface CatalogDefaultDrift {
  code: 'SERVER_DEFAULT_CONTRACT' | 'DASHBOARD_DEFAULT_DRIFT' | 'DASHBOARD_DEFAULTS_UNPARSEABLE'
  role: string
  permission: string
  expected: boolean
  actual: boolean
}

const CONTRACT: Record<string, ReadonlySet<string>> = {
  'catalog-venue:read': new Set(['OWNER', 'ADMIN', 'MANAGER', 'VIEWER']),
  'catalog-venue:request-override': new Set(['OWNER', 'ADMIN', 'MANAGER']),
}

/**
 * Two literal shapes are accepted, because the dashboard's defaults moved from a
 * hand-written map to a generated artifact:
 *
 *   [StaffRole.OWNER]: ['x']   ← legacy, hand-written
 *   OWNER: ['x']               ← current, `generated/defaultPermissions.generated.ts`
 *
 * Anchored on `{`/`,`/line-start so a type annotation or a doc comment can't be
 * mistaken for a role entry.
 */
const ROLE_BLOCK = /(?:^|[{,])\s*(?:\[StaffRole\.([A-Z][A-Z0-9_]*)\]|([A-Z][A-Z0-9_]*))\s*:\s*\[([\s\S]*?)\]\s*,/gm

function dashboardDefaults(source: string): Map<string, Set<string>> {
  const defaults = new Map<string, Set<string>>()
  for (const match of source.matchAll(ROLE_BLOCK)) {
    const role = match[1] ?? match[2]
    defaults.set(role, new Set(Array.from(match[3].matchAll(/['"]([^'"]+)['"]/g), value => value[1])))
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

  // 🔴 "I parsed zero roles" and "every role lost the permission" produce IDENTICAL
  // lookups, so a source this parser doesn't understand used to come out as a fistful
  // of confident, precise, WRONG drifts — which is exactly what happened when the
  // dashboard's defaults became a re-export of a generated file. Say it's unreadable
  // instead of inventing findings, and keep checking the side we CAN still read.
  const dashboardReadable = dashboard.size > 0
  if (!dashboardReadable) {
    drift.push({ code: 'DASHBOARD_DEFAULTS_UNPARSEABLE', role: '*', permission: '*', expected: true, actual: false })
  }

  for (const [permission, expectedRoles] of Object.entries(CONTRACT)) {
    for (const role of roles) {
      const expected = expectedRoles.has(role)
      const serverActual = serverDefaults[role]?.includes(permission) ?? false
      if (serverActual !== expected) {
        drift.push({ code: 'SERVER_DEFAULT_CONTRACT', role, permission, expected, actual: serverActual })
      }
      if (!dashboardReadable) continue
      const dashboardActual = dashboard.get(role)?.has(permission) ?? false
      if (dashboardActual !== expected) {
        drift.push({ code: 'DASHBOARD_DEFAULT_DRIFT', role, permission, expected, actual: dashboardActual })
      }
    }
  }
  return drift
}
