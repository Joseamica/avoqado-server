import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

const SOURCE_ROOT = resolve(process.cwd(), 'src')
const ROUTES_ROOT = join(SOURCE_ROOT, 'routes')

const localTypeScriptFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? localTypeScriptFiles(path) : path.endsWith('.ts') ? [path] : []
  })

const resolveLocalImport = (from: string, specifier: string): string | null => {
  const unresolved = specifier.startsWith('@/')
    ? join(SOURCE_ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : null
  if (!unresolved) return null

  for (const candidate of [`${unresolved}.ts`, join(unresolved, 'index.ts')]) {
    if (existsSync(candidate)) return normalize(candidate)
  }
  return null
}

const reachableSourceFiles = (roots: readonly string[]): Set<string> => {
  const pending = [...roots]
  const visited = new Set<string>()
  const staticImport = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || visited.has(current)) continue
    visited.add(current)

    const source = readFileSync(current, 'utf8')
    for (const match of source.matchAll(staticImport)) {
      const dependency = resolveLocalImport(current, match[1])
      if (dependency && !visited.has(dependency)) pending.push(dependency)
    }
  }

  return visited
}

describe('Commercial Quote v3 route exposure boundary', () => {
  it('keeps dedicated v3 claim and acquisition-context authorities unreachable from every mounted route graph', () => {
    const graph = reachableSourceFiles(localTypeScriptFiles(ROUTES_ROOT))
    const forbidden = [
      normalize(join(SOURCE_ROOT, 'services/commercial/quotes-v3/commercialOfferClaimV3.service.ts')),
      normalize(join(SOURCE_ROOT, 'services/commercial/quotes-v3/commercialAcquisitionContextV3.service.ts')),
    ]

    for (const authority of forbidden) expect(graph).not.toContain(authority)
  })
})
