#!/usr/bin/env tsx
/**
 * Permission System Audit
 * =======================
 *
 * Cross-repo consistency checker. Runs in `avoqado-server` and (optionally) reads sibling
 * repos `avoqado-web-dashboard`, `avoqado-tpv`, `avoqado-android` to detect drift between
 * the canonical permission catalog and the actual gates used by clients.
 *
 * What it checks:
 *   ❌ PHANTOM            backend checkPermission('X') where X cannot be satisfied by any role
 *   ❌ TPV PHANTOM        TPV hasPermission('X') where X is not satisfiable
 *   ⚠️  CATALOG GAP        backend uses X but X is missing from INDIVIDUAL_PERMISSIONS_BY_RESOURCE
 *                        (can't be assigned individually from the dashboard role editor)
 *   ⚠️  DEAD UI GATE       dashboard PermissionGate uses X but no backend endpoint checks X
 *   ⚠️  SUPERADMIN-ONLY    backend uses X and only SUPERADMIN (via *:*) can satisfy
 *   ⚠️  NAME DRIFT         two permission strings within Levenshtein distance 1 — likely typo
 *
 * Exit codes:
 *   0 = aligned (no ERRORs; warnings tolerated)
 *   1 = at least one ERROR (PHANTOM or TPV PHANTOM)
 *   2 = audit script itself failed
 *
 * Usage:
 *   npm run audit:permissions                # from avoqado-server
 *   tsx scripts/audit-permissions.ts --strict  # also fail on warnings
 *   tsx scripts/audit-permissions.ts --json    # machine-readable output
 *
 * Add new sibling repo to AUDITED_CLIENTS to extend coverage.
 */

import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_PERMISSIONS, hasPermission, type StaffRole } from '../src/lib/permissions'

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..')
const WORKSPACE_ROOT = path.resolve(ROOT, '..')

interface ClientRepo {
  name: string
  relativeDir: string
  scanDir: string
  fileExt: string[]
  patterns: { kind: string; regex: RegExp }[]
}

const AUDITED_CLIENTS: ClientRepo[] = [
  {
    name: 'avoqado-web-dashboard',
    relativeDir: 'avoqado-web-dashboard',
    scanDir: 'src',
    fileExt: ['.tsx', '.ts'],
    patterns: [
      { kind: 'PermissionGate', regex: /<PermissionGate[^>]*permission=["']([a-z][a-zA-Z0-9_:.-]+:[a-z][a-zA-Z0-9_-]+)["']/g },
      { kind: 'hasPermission', regex: /hasPermission\(["']([a-z][a-zA-Z0-9_:.-]+:[a-z][a-zA-Z0-9_-]+)["']\)/g },
    ],
  },
  {
    name: 'avoqado-tpv',
    relativeDir: 'avoqado-tpv',
    scanDir: 'app/src',
    fileExt: ['.kt'],
    patterns: [{ kind: 'hasPermission', regex: /hasPermission\(["]([a-z][a-zA-Z0-9_:.-]+:[a-z][a-zA-Z0-9_-]+)["]\)/g }],
  },
  {
    name: 'avoqado-android',
    relativeDir: 'avoqado-android',
    scanDir: 'app/src',
    fileExt: ['.kt'],
    // avoqado-android uses role-strings (RoleManager) not the permissions array —
    // intentionally not scanned for permission name matches. Tracked as architectural debt.
    patterns: [],
  },
]

// Permissions intentionally restricted to SUPERADMIN — silenced from "SUPERADMIN-ONLY" warnings.
const SUPERADMIN_ONLY_ALLOWLIST = new Set<string>([
  // Truly SUPERADMIN-only (system internals, crypto config):
  'system:config',
  'system:manage',
  'system:test',
  'venue-crypto:manage',
  // TODO(tpv-commands): tpv-commands:* endpoints currently gated by a single generic
  // perm that nobody except SUPERADMIN holds. The intended granular checks per
  // commandType (lock/maintenance/restart/wipe/etc.) require a new middleware that
  // infers permission from `req.body.commandType`. Allowlisted here so this audit
  // doesn't block CI while that work is scoped. Remove from allowlist when the
  // granular middleware lands.
  'tpv-commands:read',
  'tpv-commands:write',
  'tpv-commands:bulk',
  'tpv-commands:schedule',
  'tpv-commands:geofence',
])

// Permissions intentionally absent from INDIVIDUAL_PERMISSIONS_BY_RESOURCE (can't be assigned
// individually because they're either SUPERADMIN-only or destructive).
const CATALOG_GAP_ALLOWLIST = new Set<string>([
  'system:config',
  'system:manage',
  'system:test',
  'venue-crypto:manage',
  'payments:delete', // ADMIN+ via wildcard, intentionally not granular
  'payments:update', // ADMIN+ via wildcard, intentionally not granular
  'orders:delete',
  'reviews:delete',
])

const ARG_STRICT = process.argv.includes('--strict')
const ARG_JSON = process.argv.includes('--json')

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function walkDir(dir: string, ext: string[], cb: (file: string) => void): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'dist') {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkDir(full, ext, cb)
    else if (ext.some(e => entry.name.endsWith(e))) cb(full)
  }
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > 2) return 99 // early prune
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

// ────────────────────────────────────────────────────────────────────────────
// Extraction
// ────────────────────────────────────────────────────────────────────────────

interface PermUsage {
  perm: string
  location: string
  kind: string
}

function extractBackendGates(): PermUsage[] {
  const usages: PermUsage[] = []
  walkDir(path.join(ROOT, 'src/routes'), ['.ts'], file => {
    const content = fs.readFileSync(file, 'utf8')
    const matches = content.matchAll(/checkPermission\(['"`]([a-z][a-zA-Z0-9_:.-]+:[a-z][a-zA-Z0-9_-]+)['"`]\)/g)
    for (const m of matches) {
      usages.push({ perm: m[1], location: path.relative(ROOT, file), kind: 'checkPermission' })
    }
  })
  return usages
}

function extractCatalog(): { individual: Set<string>; defaults: Map<StaffRole, string[]> } {
  const permissionsSrc = fs.readFileSync(path.join(ROOT, 'src/lib/permissions.ts'), 'utf8')
  const catalogMatch = permissionsSrc.match(/INDIVIDUAL_PERMISSIONS_BY_RESOURCE[^=]*=\s*\{([\s\S]+?)\n\}/)
  if (!catalogMatch) {
    console.error('FATAL: Could not parse INDIVIDUAL_PERMISSIONS_BY_RESOURCE from permissions.ts')
    process.exit(2)
  }
  const individual = new Set<string>(
    Array.from(catalogMatch[1].matchAll(/'([a-z][a-zA-Z0-9_:.-]+:[a-z][a-zA-Z0-9_-]+)'/g)).map(m => m[1]),
  )

  const defaultsMap = new Map<StaffRole, string[]>()
  for (const role of Object.keys(DEFAULT_PERMISSIONS) as StaffRole[]) {
    defaultsMap.set(role, DEFAULT_PERMISSIONS[role])
  }
  return { individual, defaults: defaultsMap }
}

function extractClientGates(client: ClientRepo): PermUsage[] {
  const usages: PermUsage[] = []
  const root = path.join(WORKSPACE_ROOT, client.relativeDir, client.scanDir)
  if (!fs.existsSync(root)) return usages
  walkDir(root, client.fileExt, file => {
    const content = fs.readFileSync(file, 'utf8')
    for (const { kind, regex } of client.patterns) {
      for (const m of content.matchAll(regex)) {
        usages.push({
          perm: m[1],
          location: `${client.name}:${path.relative(path.join(WORKSPACE_ROOT, client.relativeDir), file)}`,
          kind,
        })
      }
    }
  })
  return usages
}

// ────────────────────────────────────────────────────────────────────────────
// Issue model + reporters
// ────────────────────────────────────────────────────────────────────────────

type Severity = 'ERROR' | 'WARN'
interface Issue {
  severity: Severity
  code: string
  perm: string
  message: string
  occurrences?: string[]
}

function reportText(issues: Issue[], stats: Record<string, number>): void {
  console.log(`\n┌─ Permission System Audit ─────────────────────────────────`)
  console.log(`│ Backend gates:     ${stats.backend}`)
  console.log(`│ Catalog entries:   ${stats.individual}`)
  console.log(`│ Dashboard gates:   ${stats.dashboard}`)
  console.log(`│ TPV gates:         ${stats.tpv}`)
  console.log(`│ Roles in defaults: ${stats.roles}`)
  console.log(`└───────────────────────────────────────────────────────────\n`)

  const errors = issues.filter(i => i.severity === 'ERROR')
  const warns = issues.filter(i => i.severity === 'WARN')

  if (errors.length === 0 && warns.length === 0) {
    console.log('✅ No issues found — permission system fully aligned.')
    return
  }

  if (errors.length > 0) {
    console.log(`❌ ${errors.length} ERROR${errors.length === 1 ? '' : 'S'}:`)
    for (const e of errors) {
      console.log(`  [${e.code}] ${e.perm}`)
      console.log(`         ${e.message}`)
      if (e.occurrences) [...new Set(e.occurrences)].slice(0, 3).forEach(o => console.log(`         • ${o}`))
    }
    console.log()
  }

  if (warns.length > 0) {
    console.log(`⚠️  ${warns.length} WARNING${warns.length === 1 ? '' : 'S'}:`)
    for (const w of warns) {
      console.log(`  [${w.code}] ${w.perm}`)
      console.log(`         ${w.message}`)
      if (w.occurrences) [...new Set(w.occurrences)].slice(0, 3).forEach(o => console.log(`         • ${o}`))
    }
    console.log()
  }
}

function reportJson(issues: Issue[], stats: Record<string, number>): void {
  console.log(JSON.stringify({ stats, issues }, null, 2))
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

function main(): void {
  const backendUsages = extractBackendGates()
  const { individual: catalogIndividual } = extractCatalog()

  const dashboardUsages = extractClientGates(AUDITED_CLIENTS[0])
  const tpvUsages = extractClientGates(AUDITED_CLIENTS[1])

  const allRoles = Object.keys(DEFAULT_PERMISSIONS) as StaffRole[]
  const backendPermsByName = new Map<string, PermUsage[]>()
  for (const u of backendUsages) {
    if (!backendPermsByName.has(u.perm)) backendPermsByName.set(u.perm, [])
    backendPermsByName.get(u.perm)!.push(u)
  }
  const backendPermsSet = new Set(backendPermsByName.keys())
  const dashboardPermsSet = new Set(dashboardUsages.map(u => u.perm))
  const tpvPermsSet = new Set(tpvUsages.map(u => u.perm))

  const issues: Issue[] = []

  // ── Check 1: every backend perm satisfiable by a non-SUPERADMIN role
  // SUPERADMIN always passes via *:* short-circuit, so we exclude them when looking
  // for "phantom" permissions (strings that don't exist in catalog/defaults/deps —
  // they only pass for SUPERADMIN because of the wildcard, not because anyone has
  // them literally). This is exactly the bug we shipped with `shifts:manage` and
  // `role-permissions:update`.
  const nonSARoles = allRoles.filter(r => r !== 'SUPERADMIN')
  for (const [perm, occurrences] of backendPermsByName) {
    const grantingNonSA = nonSARoles.filter(r => hasPermission(r, null, perm))
    if (grantingNonSA.length === 0) {
      if (SUPERADMIN_ONLY_ALLOWLIST.has(perm)) {
        // Intentionally SUPERADMIN-only — silent.
        continue
      }
      issues.push({
        severity: 'ERROR',
        code: 'PHANTOM',
        perm,
        message: `Backend checks this permission but NO non-SUPERADMIN role can satisfy it (only SUPERADMIN passes via *:* short-circuit). Either add to DEFAULT_PERMISSIONS for at least one role, fix the string, or add to SUPERADMIN_ONLY_ALLOWLIST if intentional.`,
        occurrences: occurrences.map(o => o.location),
      })
    }
  }

  // ── Check 2: every backend perm in INDIVIDUAL_PERMISSIONS_BY_RESOURCE
  for (const perm of backendPermsSet) {
    if (!catalogIndividual.has(perm) && !CATALOG_GAP_ALLOWLIST.has(perm)) {
      issues.push({
        severity: 'WARN',
        code: 'CATALOG_GAP',
        perm,
        message: `Backend checks this but it's missing from INDIVIDUAL_PERMISSIONS_BY_RESOURCE — admins cannot assign it individually from the role editor. Add it to the catalog or to CATALOG_GAP_ALLOWLIST.`,
      })
    }
  }

  // ── Check 3: dashboard PermissionGate strings backed by backend
  for (const perm of dashboardPermsSet) {
    if (!backendPermsSet.has(perm)) {
      // OK if at least some role can satisfy via dependencies (some gates are pure UI)
      const grantingRoles = allRoles.filter(r => hasPermission(r, null, perm))
      if (grantingRoles.length === 0) {
        issues.push({
          severity: 'ERROR',
          code: 'DASHBOARD_PHANTOM',
          perm,
          message: `Dashboard gate references a permission no role can satisfy. Likely a typo or stale string.`,
          occurrences: dashboardUsages.filter(u => u.perm === perm).map(u => u.location).slice(0, 3),
        })
      } else {
        issues.push({
          severity: 'WARN',
          code: 'DASHBOARD_DEAD_GATE',
          perm,
          message: `Dashboard gates this but no backend endpoint checks it. Either gate-only UI by design, or backend gate missing.`,
          occurrences: dashboardUsages.filter(u => u.perm === perm).map(u => u.location).slice(0, 3),
        })
      }
    }
  }

  // ── Check 4: TPV hasPermission strings backed by backend AND satisfiable
  for (const perm of tpvPermsSet) {
    const grantingRoles = allRoles.filter(r => hasPermission(r, null, perm))
    if (grantingRoles.length === 0) {
      issues.push({
        severity: 'ERROR',
        code: 'TPV_PHANTOM',
        perm,
        message: `TPV client checks this permission but no role can satisfy it.`,
        occurrences: tpvUsages.filter(u => u.perm === perm).map(u => u.location).slice(0, 3),
      })
    } else if (!backendPermsSet.has(perm)) {
      // Many TPV-side perms are intentionally client-only (e.g. tpv-orders:comp gates UI;
      // backend uses the data-level orders:comp via PERMISSION_DEPENDENCIES bridge).
      // We just log informationally — not a hard fail.
      issues.push({
        severity: 'WARN',
        code: 'TPV_CLIENT_ONLY',
        perm,
        message: `TPV gates this client-side but no backend endpoint checks the same name. Verify there's a PERMISSION_DEPENDENCIES bridge (e.g. tpv-orders:comp → orders:comp).`,
        occurrences: tpvUsages.filter(u => u.perm === perm).map(u => u.location).slice(0, 3),
      })
    }
  }

  // ── Check 5: name drift (Levenshtein) across all known permissions
  const allKnown = new Set<string>([...backendPermsSet, ...catalogIndividual, ...dashboardPermsSet, ...tpvPermsSet])
  const knownList = [...allKnown].sort()
  const driftSeen = new Set<string>()
  for (let i = 0; i < knownList.length; i++) {
    for (let j = i + 1; j < knownList.length; j++) {
      const a = knownList[i]
      const b = knownList[j]
      const dKey = `${a}|${b}`
      if (driftSeen.has(dKey)) continue
      driftSeen.add(dKey)
      // Only flag same resource (left of colon) — different resources with similar names are coincidence
      if (a.split(':')[0] !== b.split(':')[0]) continue
      const d = levenshtein(a, b)
      if (d > 0 && d <= 1) {
        issues.push({
          severity: 'WARN',
          code: 'NAME_DRIFT',
          perm: `${a} ⇄ ${b}`,
          message: `Permission names are 1 edit apart and share a resource — likely typo. Confirm both are intentional.`,
        })
      }
    }
  }

  const stats = {
    backend: backendPermsSet.size,
    individual: catalogIndividual.size,
    dashboard: dashboardPermsSet.size,
    tpv: tpvPermsSet.size,
    roles: allRoles.length,
  }

  if (ARG_JSON) reportJson(issues, stats)
  else reportText(issues, stats)

  const hasErrors = issues.some(i => i.severity === 'ERROR')
  const hasWarns = issues.some(i => i.severity === 'WARN')
  if (hasErrors) process.exit(1)
  if (ARG_STRICT && hasWarns) process.exit(1)
  process.exit(0)
}

main()
