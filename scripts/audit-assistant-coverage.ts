import fs from 'fs'
import path from 'path'
import {
  AssistantCapability,
  AssistantCapabilityRegistryService,
} from '../src/services/dashboard/chatbot-conversation/assistant-capability-registry.service'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface MountInfo {
  file: string
  prefix: string
  inheritedPermissions: string[]
  inheritedAuth: string[]
}

interface EndpointInventoryRow {
  method: HttpMethod
  fullPath: string
  localPath: string
  mountPrefix: string
  routeFile: string
  controller: string
  controllerFile?: string
  services: string[]
  permissions: string[]
  inheritedPermissions: string[]
  auth: string[]
  schemas: string[]
  classification: 'read' | 'action' | 'mutation' | 'dangerousMutation' | 'adminOnly' | 'public'
  scope: 'venue' | 'organization' | 'superadmin' | 'public' | 'unknown'
  assistantCoverage: 'covered' | 'partial' | 'missing' | 'blocked'
  assistantTools: string[]
  notes: string[]
}

const REPO_ROOT = path.resolve(__dirname, '..')
const ROUTES_DIR = path.join(REPO_ROOT, 'src/routes')
const OUTPUT_DIR = path.join(REPO_ROOT, 'docs/generated')
const JSON_OUTPUT = path.join(OUTPUT_DIR, 'assistant-endpoint-inventory.json')
const MD_OUTPUT = path.join(OUTPUT_DIR, 'assistant-endpoint-inventory.md')
const CAPABILITIES_JSON_OUTPUT = path.join(OUTPUT_DIR, 'assistant-capabilities.json')
const CAPABILITIES_MD_OUTPUT = path.join(OUTPUT_DIR, 'assistant-capabilities.md')

const METHOD_RE = /router\.(get|post|put|patch|delete)\s*\(/g
const ROUTER_USE_RE = /router\.use\s*\(/g

const ASSISTANT_TOOL_HINTS: Array<{ pattern: RegExp; tools: string[]; coverage: EndpointInventoryRow['assistantCoverage'] }> = [
  { pattern: /sales|general-stats|stats|analytics|overview|summary/i, tools: ['sales', 'businessOverview'], coverage: 'partial' },
  { pattern: /available-balance|settlement|liquid/i, tools: ['settlementCalendar'], coverage: 'partial' },
  { pattern: /payment-method|payments/i, tools: ['paymentMethodBreakdown', 'payments.summary', 'payments.list'], coverage: 'partial' },
  { pattern: /reviews/i, tools: ['reviews'], coverage: 'covered' },
  {
    pattern: /inventory|stock|raw-material|recipe|purchase-order|supplier/i,
    tools: ['inventoryAlerts', 'recipeCount', 'recipeList', 'recipeUsage'],
    coverage: 'partial',
  },
  { pattern: /orders/i, tools: ['pendingOrders'], coverage: 'partial' },
  { pattern: /shift/i, tools: ['activeShifts'], coverage: 'partial' },
  { pattern: /product|menu/i, tools: ['topProducts'], coverage: 'partial' },
  { pattern: /payment-links/i, tools: ['paymentLinks.list', 'paymentLinks.detail', 'paymentLinks.create'], coverage: 'partial' },
  { pattern: /reservations/i, tools: ['reservations.summary', 'reservations.list', 'reservations.create'], coverage: 'partial' },
  { pattern: /commissions/i, tools: ['commissions.summary', 'commissions.payouts'], coverage: 'missing' },
  { pattern: /credit-packs|credits/i, tools: ['creditPacks.balance', 'creditPacks.list'], coverage: 'missing' },
  { pattern: /team|permission|role/i, tools: ['team.members', 'team.invite', 'permissions.howTo'], coverage: 'missing' },
]

function main() {
  const routeFiles = walk(ROUTES_DIR).filter(file => file.endsWith('.ts'))
  const mountedFiles = resolveMounts(routeFiles)
  const capabilities = new AssistantCapabilityRegistryService().listCapabilities()
  const assistantTools = capabilities.map(capability => capability.id).sort()
  const rows: EndpointInventoryRow[] = []

  for (const routeFile of routeFiles) {
    const mounts = mountedFiles.get(routeFile) || [
      { file: routeFile, prefix: inferFallbackPrefix(routeFile), inheritedPermissions: [], inheritedAuth: [] },
    ]
    const text = fs.readFileSync(routeFile, 'utf8')
    const imports = parseImports(text, routeFile)
    const endpoints = extractRouterEndpointCalls(text)

    for (const endpoint of endpoints) {
      for (const mount of mounts) {
        const fullPath = normalizeRoutePath(mount.prefix, endpoint.localPath)
        const controllerFile = resolveControllerFile(endpoint.controller, imports)
        const permissions = unique([...extractPermissions(endpoint.call), ...extractAccessPermissions(endpoint.call)])
        const inheritedPermissions = unique(mount.inheritedPermissions)
        const auth = unique([...mount.inheritedAuth, ...extractAuth(endpoint.call)])
        const schemas = extractSchemas(endpoint.call)
        const services = controllerFile ? extractServices(controllerFile, endpoint.controller) : []
        const scope = classifyScope(fullPath, routeFile)
        const classification = classifyEndpoint(endpoint.method, fullPath, routeFile, permissions, inheritedPermissions, auth, scope)
        const coverage = classifyAssistantCoverage(fullPath, routeFile, classification, capabilities)

        rows.push({
          method: endpoint.method,
          fullPath,
          localPath: endpoint.localPath,
          mountPrefix: mount.prefix,
          routeFile: relative(routeFile),
          controller: endpoint.controller,
          controllerFile: controllerFile ? relative(controllerFile) : undefined,
          services: services.map(relative),
          permissions,
          inheritedPermissions,
          auth,
          schemas,
          classification,
          scope,
          assistantCoverage: coverage.assistantCoverage,
          assistantTools: coverage.assistantTools,
          notes: coverage.notes,
        })
      }
    }
  }

  rows.sort((a, b) => `${a.fullPath} ${a.method}`.localeCompare(`${b.fullPath} ${b.method}`))
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const generatedAt = new Date().toISOString()
  fs.writeFileSync(JSON_OUTPUT, `${JSON.stringify({ generatedAt, assistantTools, endpoints: rows }, null, 2)}\n`)
  fs.writeFileSync(MD_OUTPUT, renderMarkdown(rows, assistantTools))
  fs.writeFileSync(CAPABILITIES_JSON_OUTPUT, `${JSON.stringify({ generatedAt, capabilities }, null, 2)}\n`)
  fs.writeFileSync(CAPABILITIES_MD_OUTPUT, renderCapabilitiesMarkdown(capabilities))

  const summary = summarize(rows)
  console.log(`Assistant endpoint inventory generated:`)
  console.log(`- ${relative(JSON_OUTPUT)}`)
  console.log(`- ${relative(MD_OUTPUT)}`)
  console.log(`- ${relative(CAPABILITIES_JSON_OUTPUT)}`)
  console.log(`- ${relative(CAPABILITIES_MD_OUTPUT)}`)
  console.log(`- endpoints: ${rows.length}`)
  console.log(`- coverage: ${JSON.stringify(summary.coverage)}`)
  console.log(`- classifications: ${JSON.stringify(summary.classifications)}`)
}

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap(entry => {
    const fullPath = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(fullPath) : [fullPath]
  })
}

function resolveMounts(routeFiles: string[]): Map<string, MountInfo[]> {
  const byFile = new Map<string, MountInfo[]>()
  const queue: MountInfo[] = [
    { file: path.join(REPO_ROOT, 'src/routes/index.ts'), prefix: '/api/v1', inheritedPermissions: [], inheritedAuth: [] },
    { file: path.join(REPO_ROOT, 'src/routes/public.routes.ts'), prefix: '/api/v1/public', inheritedPermissions: [], inheritedAuth: [] },
    { file: path.join(REPO_ROOT, 'src/routes/webhook.routes.ts'), prefix: '/api/v1/webhooks', inheritedPermissions: [], inheritedAuth: [] },
    {
      file: path.join(REPO_ROOT, 'src/routes/publicMenu.routes.ts'),
      prefix: '/api/v1/venues/:venueId/public-menu',
      inheritedPermissions: [],
      inheritedAuth: [],
    },
    {
      file: path.join(REPO_ROOT, 'src/routes/settlement-report.routes.ts'),
      prefix: '/reports/settlement',
      inheritedPermissions: [],
      inheritedAuth: [],
    },
    {
      file: path.join(REPO_ROOT, 'src/routes/superadmin/appUpdate.routes.ts'),
      prefix: '/api/v1/superadmin/app-updates',
      inheritedPermissions: [],
      inheritedAuth: ['authenticateTokenMiddleware', 'authorizeRole(SUPERADMIN)'],
    },
  ]

  for (const seed of queue) addMount(byFile, seed)

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    if (!fs.existsSync(current.file)) continue
    const text = fs.readFileSync(current.file, 'utf8')
    const imports = parseImports(text, current.file)
    const uses = extractRouterUseCalls(text)

    for (const use of uses) {
      const targetImport = findMountedRouterIdentifier(use.call, imports)
      if (!targetImport) continue
      const targetFile = imports.get(targetImport)
      if (!targetFile || !routeFiles.includes(targetFile)) continue

      const next: MountInfo = {
        file: targetFile,
        prefix: normalizeRoutePath(current.prefix, use.localPath),
        inheritedPermissions: unique([
          ...current.inheritedPermissions,
          ...extractPermissions(use.call),
          ...extractAccessPermissions(use.call),
        ]),
        inheritedAuth: unique([...current.inheritedAuth, ...extractAuth(use.call)]),
      }

      if (!hasMount(byFile, next)) {
        addMount(byFile, next)
        queue.push(next)
      }
    }
  }

  return byFile
}

function addMount(map: Map<string, MountInfo[]>, mount: MountInfo) {
  const mounts = map.get(mount.file) || []
  mounts.push(mount)
  map.set(mount.file, mounts)
}

function hasMount(map: Map<string, MountInfo[]>, mount: MountInfo): boolean {
  return (map.get(mount.file) || []).some(existing => existing.prefix === mount.prefix)
}

function extractRouterEndpointCalls(text: string) {
  const calls: Array<{ method: HttpMethod; localPath: string; call: string; controller: string }> = []
  let match: RegExpExecArray | null

  while ((match = METHOD_RE.exec(text))) {
    const openIndex = text.indexOf('(', match.index)
    const call = extractBalancedCall(text, openIndex)
    if (!call) continue
    const args = splitTopLevelArgs(call.slice(1, -1))
    const localPath = extractStringLiteral(args[0]) || '(dynamic)'
    const controller = normalizeController(args[args.length - 1] || '(unknown)')
    calls.push({ method: match[1].toUpperCase() as HttpMethod, localPath, call, controller })
  }

  return calls
}

function extractRouterUseCalls(text: string) {
  const calls: Array<{ localPath: string; call: string }> = []
  let match: RegExpExecArray | null

  while ((match = ROUTER_USE_RE.exec(text))) {
    const openIndex = text.indexOf('(', match.index)
    const call = extractBalancedCall(text, openIndex)
    if (!call) continue
    const args = splitTopLevelArgs(call.slice(1, -1))
    const localPath = extractStringLiteral(args[0]) || '/'
    calls.push({ localPath, call })
  }

  return calls
}

function extractBalancedCall(text: string, openIndex: number): string | null {
  let depth = 0
  let quote: string | null = null
  let escaped = false

  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i]

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }

    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return text.slice(openIndex, i + 1)
    }
  }

  return null
}

function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = []
  let start = 0
  let depth = 0
  let quote: string | null = null
  let escaped = false

  for (let i = 0; i < argsText.length; i += 1) {
    const char = argsText[i]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if ('([{'.includes(char)) depth += 1
    if (')]}'.includes(char)) depth -= 1
    if (char === ',' && depth === 0) {
      args.push(argsText.slice(start, i).trim())
      start = i + 1
    }
  }

  args.push(argsText.slice(start).trim())
  return args.filter(Boolean)
}

function parseImports(text: string, fromFile: string): Map<string, string> {
  const imports = new Map<string, string>()
  const importRe = /import\s+(?:(\w+)|\*\s+as\s+(\w+)|\{([^}]+)\})\s+from\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null

  while ((match = importRe.exec(text))) {
    const source = resolveImportPath(match[4], fromFile)
    if (!source) continue
    if (match[1]) imports.set(match[1], source)
    if (match[2]) imports.set(match[2], source)
    if (match[3]) {
      for (const namedImport of match[3].split(',')) {
        const localName = namedImport
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim()
        if (localName) imports.set(localName, source)
      }
    }
  }

  return imports
}

function resolveImportPath(source: string, fromFile: string): string | null {
  const base = source.startsWith('@/')
    ? path.join(REPO_ROOT, 'src', source.slice(2))
    : source.startsWith('.')
      ? path.resolve(path.dirname(fromFile), source)
      : null
  if (!base) return null

  const candidates = [base, `${base}.ts`, path.join(base, 'index.ts')]
  return candidates.find(candidate => fs.existsSync(candidate)) || null
}

function findMountedRouterIdentifier(call: string, imports: Map<string, string>): string | null {
  const args = splitTopLevelArgs(call.slice(1, -1))
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const candidate = args[i].trim()
    if (/^\w+$/.test(candidate) && imports.has(candidate)) return candidate
  }
  return null
}

function resolveControllerFile(controller: string, imports: Map<string, string>): string | undefined {
  const root = controller.split('.')[0]
  return imports.get(root)
}

function extractServices(controllerFile: string, controllerExpression: string): string[] {
  if (!fs.existsSync(controllerFile)) return []
  const text = fs.readFileSync(controllerFile, 'utf8')
  const imports = parseImports(text, controllerFile)
  const functionName = controllerExpression.includes('.') ? controllerExpression.split('.').pop() : controllerExpression
  const body = functionName ? extractExportedFunctionBody(text, functionName) : text
  const services = new Set<string>()

  for (const [localName, importFile] of imports.entries()) {
    if (!/service|Service/.test(localName) && !/service/i.test(importFile)) continue
    if (body.includes(localName)) services.add(importFile)
  }

  return Array.from(services).sort()
}

function extractExportedFunctionBody(text: string, functionName: string): string {
  const patterns = [
    new RegExp(`export\\s+const\\s+${escapeRegExp(functionName)}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`),
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${escapeRegExp(functionName)}\\s*\\([^)]*\\)\\s*\\{`),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (!match) continue
    const braceIndex = text.indexOf('{', match.index)
    return extractBalancedBlock(text, braceIndex) || text
  }

  return text
}

function extractBalancedBlock(text: string, openIndex: number): string | null {
  let depth = 0
  let quote: string | null = null
  let escaped = false

  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(openIndex, i + 1)
    }
  }
  return null
}

function extractPermissions(call: string): string[] {
  const permissions: string[] = []
  for (const match of call.matchAll(/checkPermission\(\s*['"]([^'"]+)['"]\s*\)/g)) permissions.push(match[1])
  for (const match of call.matchAll(/check(?:Any|All)Permission[s]?\(\s*\[([^\]]+)\]/g)) {
    for (const permission of match[1].matchAll(/['"]([^'"]+)['"]/g)) permissions.push(permission[1])
  }
  for (const match of call.matchAll(/verifyPermission\(\s*['"]([^'"]+)['"]\s*\)/g)) permissions.push(match[1])
  return unique(permissions)
}

function extractAccessPermissions(call: string): string[] {
  const permissions: string[] = []
  for (const match of call.matchAll(/verifyAccess\(\s*\{([^}]+)\}/g)) {
    const permission = /permission\s*:\s*['"]([^'"]+)['"]/.exec(match[1])
    const featureCode = /featureCode\s*:\s*['"]([^'"]+)['"]/.exec(match[1])
    if (permission) permissions.push(permission[1])
    if (featureCode) permissions.push(`feature:${featureCode[1]}`)
  }
  return unique(permissions)
}

function extractAuth(call: string): string[] {
  const auth: string[] = []
  if (/authenticateTokenMiddleware/.test(call)) auth.push('authenticateTokenMiddleware')
  if (/authenticateConsumer/.test(call)) auth.push('authenticateConsumer')
  if (/requirePartnerKey/.test(call)) auth.push('requirePartnerKey')
  if (/authorizeRole\(\s*\[[^\]]*SUPERADMIN/.test(call)) auth.push('authorizeRole(SUPERADMIN)')
  if (/checkOwnerAccess/.test(call)) auth.push('checkOwnerAccess')
  return auth
}

function extractSchemas(call: string): string[] {
  const schemas: string[] = []
  for (const match of call.matchAll(/validateRequest\(\s*([A-Za-z0-9_.$]+)/g)) schemas.push(match[1])
  for (const match of call.matchAll(/validate\(\s*([A-Za-z0-9_.$]+)/g)) schemas.push(match[1])
  return unique(schemas)
}

function normalizeController(arg: string): string {
  const value = arg.trim().replace(/\s+/g, ' ')
  if (/^(async\s*)?\(/.test(value) || /^async\s+/.test(value)) return '(inline handler)'
  return value.replace(/;$/, '')
}

function extractStringLiteral(arg: string | undefined): string | null {
  if (!arg) return null
  const match = /^\s*['"`]([^'"`]+)['"`]/.exec(arg)
  return match?.[1] || null
}

function normalizeRoutePath(prefix: string, routePath: string): string {
  const joined = `${prefix.replace(/\/$/, '')}/${routePath.replace(/^\//, '')}`
  return joined.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

function inferFallbackPrefix(routeFile: string): string {
  const rel = relative(routeFile)
  if (rel.includes('/superadmin/')) return '/api/v1/superadmin/(unmounted)'
  if (rel.includes('/dashboard/')) return '/api/v1/dashboard/(unmounted)'
  return '/api/v1/(unmounted)'
}

function classifyScope(fullPath: string, routeFile: string): EndpointInventoryRow['scope'] {
  if (/\/public|\/webhooks|\/health|public-menu|settlement/.test(fullPath)) return 'public'
  if (/superadmin/.test(fullPath) || routeFile.includes('/superadmin/')) return 'superadmin'
  if (/\/organizations\/:orgId|\/organizations/.test(fullPath)) return 'organization'
  if (/\/venues\/:venueId/.test(fullPath)) return 'venue'
  return 'unknown'
}

function classifyEndpoint(
  method: HttpMethod,
  fullPath: string,
  routeFile: string,
  permissions: string[],
  inheritedPermissions: string[],
  auth: string[],
  scope: EndpointInventoryRow['scope'],
): EndpointInventoryRow['classification'] {
  const permissionText = [...permissions, ...inheritedPermissions].join(' ')
  const isSuperadmin =
    scope === 'superadmin' ||
    /superadmin/.test(fullPath) ||
    routeFile.includes('/superadmin/') ||
    auth.includes('authorizeRole(SUPERADMIN)') ||
    /system:config|org-manage/.test(permissionText)
  if (isSuperadmin) return 'adminOnly'
  if (scope === 'public' && auth.length === 0 && permissions.length === 0 && inheritedPermissions.length === 0) return 'public'
  if (method === 'GET') return 'read'
  if (/delete|archive|void|cancel|refund|approve|process|payout|impersonat|run-job|bulk|reset|fail|complete|clawback/i.test(fullPath)) {
    return 'dangerousMutation'
  }
  if (method === 'DELETE') return 'dangerousMutation'
  if (method === 'POST') return 'action'
  return 'mutation'
}

function classifyAssistantCoverage(
  fullPath: string,
  routeFile: string,
  classification: EndpointInventoryRow['classification'],
  capabilities: AssistantCapability[],
): Pick<EndpointInventoryRow, 'assistantCoverage' | 'assistantTools' | 'notes'> {
  if (classification === 'adminOnly' || classification === 'public') {
    return {
      assistantCoverage: 'blocked',
      assistantTools: [],
      notes: [`${classification} endpoint should not be exposed to venue assistant by default.`],
    }
  }

  const target = `${fullPath} ${routeFile}`
  const hint = ASSISTANT_TOOL_HINTS.find(candidate => candidate.pattern.test(target))
  if (!hint) return { assistantCoverage: 'missing', assistantTools: [], notes: ['No assistant capability mapped yet.'] }

  const matchedCapabilities = hint.tools
    .map(
      tool =>
        capabilities.find(capability => capability.id === tool) ||
        capabilities.find(capability => capability.id.startsWith(tool.split('.')[0])),
    )
    .filter((capability): capability is AssistantCapability => Boolean(capability))
  const hasRegistered = matchedCapabilities.some(capability => capability.status === 'registered')
  const hasBacklog = matchedCapabilities.some(capability => capability.status === 'backlog')
  const coverage = hint.coverage !== 'missing' && hasRegistered ? hint.coverage : 'missing'
  const notes = hasRegistered
    ? ['Mapped by registered capability heuristic; verify exact contract before enabling broader routing.']
    : hasBacklog
      ? ['Backlog capability contract exists, but it is not executable yet.']
      : ['Suggested assistant capability is not registered yet.']
  return { assistantCoverage: coverage, assistantTools: hint.tools, notes }
}

function summarize(rows: EndpointInventoryRow[]) {
  return {
    coverage: countBy(rows, row => row.assistantCoverage),
    classifications: countBy(rows, row => row.classification),
    scopes: countBy(rows, row => row.scope),
    permissions: countBy(
      rows.flatMap(row => [...row.inheritedPermissions, ...row.permissions]),
      permission => permission,
    ),
  }
}

function renderMarkdown(rows: EndpointInventoryRow[], assistantTools: string[]): string {
  const summary = summarize(rows)
  const missingByDomain = Object.entries(
    countBy(
      rows.filter(row => row.assistantCoverage === 'missing'),
      row => domainFromPath(row.fullPath),
    ),
  ).sort((a, b) => b[1] - a[1])

  const dangerous = rows.filter(row => row.classification === 'dangerousMutation' || row.classification === 'adminOnly')

  return `# Assistant Endpoint Inventory

Generated: ${new Date().toISOString()}

## Summary

- Total endpoints: ${rows.length}
- Assistant tools registered: ${assistantTools.length}
- Coverage: ${formatCounts(summary.coverage)}
- Classifications: ${formatCounts(summary.classifications)}
- Scopes: ${formatCounts(summary.scopes)}

## Top Missing Domains

${missingByDomain
  .slice(0, 20)
  .map(([domain, count]) => `- ${domain}: ${count}`)
  .join('\n')}

## High-Risk Or Admin-Only Endpoints

${dangerous
  .slice(0, 120)
  .map(
    row =>
      `- ${row.method} \`${row.fullPath}\` — ${row.classification}; permissions: ${[...row.inheritedPermissions, ...row.permissions].join(', ') || 'none'}; controller: ${row.controller}`,
  )
  .join('\n')}

## Endpoint Inventory

| Method | Path | Class | Scope | Coverage | Permissions | Schema | Controller |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows
  .map(
    row =>
      `| ${row.method} | \`${row.fullPath}\` | ${row.classification} | ${row.scope} | ${row.assistantCoverage} | ${
        [...row.inheritedPermissions, ...row.permissions].join(', ') || '-'
      } | ${row.schemas.join(', ') || '-'} | ${row.controller} |`,
  )
  .join('\n')}
`
}

function renderCapabilitiesMarkdown(capabilities: AssistantCapability[]): string {
  const summary = {
    status: countBy(capabilities, capability => capability.status),
    kind: countBy(capabilities, capability => capability.kind),
    risk: countBy(capabilities, capability => capability.riskLevel),
    scope: countBy(capabilities, capability => capability.scope),
  }

  return `# Assistant Capabilities

Generated: ${new Date().toISOString()}

## Summary

- Total capabilities: ${capabilities.length}
- Status: ${formatCounts(summary.status)}
- Kind: ${formatCounts(summary.kind)}
- Risk: ${formatCounts(summary.risk)}
- Scope: ${formatCounts(summary.scope)}

## Registered Executable Capabilities

${capabilities
  .filter(capability => capability.status === 'registered' && capability.kind !== 'blocked')
  .map(
    capability =>
      `- \`${capability.id}\` (${capability.kind}, ${capability.riskLevel}) — permissions: ${capability.permissions.join(', ') || 'none'}; source: ${capability.dataSource}`,
  )
  .join('\n')}

## Backlog Contracts

${capabilities
  .filter(capability => capability.status === 'backlog')
  .map(
    capability =>
      `- \`${capability.id}\` (${capability.kind}, ${capability.riskLevel}) — permissions: ${capability.permissions.join(', ') || 'none'}; examples: ${capability.examples.join(' | ')}`,
  )
  .join('\n')}

## Blocked Capabilities

${capabilities
  .filter(capability => capability.status === 'blocked')
  .map(capability => `- \`${capability.id}\` — ${capability.description}`)
  .join('\n')}

## Full Registry

| ID | Kind | Status | Scope | Risk | Permission | Confirmation | Data Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
${capabilities
  .map(
    capability =>
      `| \`${capability.id}\` | ${capability.kind} | ${capability.status} | ${capability.scope} | ${capability.riskLevel} | ${capability.permissions.join(', ') || '-'} | ${capability.requiresDoubleConfirmation ? 'double' : capability.requiresConfirmation ? 'single' : '-'} | ${capability.dataSource} |`,
  )
  .join('\n')}
`
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFn(item)
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key} ${count}`)
    .join(', ')
}

function domainFromPath(fullPath: string): string {
  const parts = fullPath.split('/').filter(Boolean)
  const venueIndex = parts.indexOf(':venueId')
  if (venueIndex >= 0 && parts[venueIndex + 1]) return parts[venueIndex + 1]
  const apiIndex = parts.indexOf('v1')
  return parts[apiIndex + 1] || parts[0] || 'unknown'
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort()
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

main()
