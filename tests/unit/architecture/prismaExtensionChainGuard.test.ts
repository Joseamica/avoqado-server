/**
 * Static guard: the Prisma client extensions of the shared client — the assumption behind the MCP brake's batch mark.
 *
 * Inside an MCP request, `$transaction([…])` runs marked `prismaBatch` (`src/utils/requestCancellation.ts`): its
 * operations are part of the batch, which is counted as a whole, and are not counted one by one — Prisma can leave one
 * waiting forever at its internal barrier when a sibling fails. The mark is safe only because NOTHING but Prisma's own
 * batch machinery runs in that context. A query extension of the shared client runs there too, inside the chain of every
 * batch operation: one that launched its own queries would have them marked as batch operations — never counted, never
 * taking the person's slot back — and the brake would let work escape (Codex, round 6, P3).
 *
 * Two layers. The BEHAVIOUR is checked with the real client in
 * `tests/integration/mcp/freno-transacciones.integration.test.ts` (the brake must see exactly one operation per batch
 * element, however an extension is written). This file is the tripwire that stops the change at review time: it reads
 * the code as a TypeScript AST (Codex, rounds 7 and 8: regular expressions missed an inline `.$extends({ … })`, a
 * multi-line import, composition, `import = require` and constructor aliases).
 *
 * Adding an extension, deriving a client with `$extends` anywhere, composing or mutating an approved extension, or
 * giving one of the brake's modules a new RUNTIME dependency needs a review of that assumption first — then update this
 * test in the same change. Type-only imports are free: they load nothing.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as ts from 'typescript'

const SRC_DIR = path.resolve(__dirname, '../../../src')
const PRISMA_CLIENT = path.join(SRC_DIR, 'utils/prismaClient.ts')

/** The approved chain, innermost first, and where each extension must come from. */
const APPROVED_CHAIN = [
  { name: 'extensionResultadoGigante', module: './queryResultGuard', file: 'utils/queryResultGuard.ts' },
  { name: 'extensionCancellableReads', module: './requestCancellation', file: 'utils/requestCancellation.ts' },
  { name: 'extensionCancellableTransactions', module: './requestCancellation', file: 'utils/requestCancellation.ts' },
]
const APPROVED_NAMES = new Set(APPROVED_CHAIN.map(e => e.name))

/** The runtime dependencies each module of the brake may load. Anything new needs a review. */
const APPROVED_RUNTIME_DEPENDENCIES: Record<string, string[]> = {
  'utils/queryResultGuard.ts': ['../config/logger'],
  'utils/requestCancellation.ts': ['@prisma/client', '@/observability/executionContext', './readOnlySql'],
  'utils/readOnlySql.ts': [],
  'observability/executionContext.ts': ['node:async_hooks'],
}

const parse = (text: string, file = 'x.ts') => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

/** `x.$extends` or `x['$extends']` — used as a callee or not. */
function isExtendsAccess(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === '$extends'
  if (ts.isElementAccessExpression(node)) {
    return ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === '$extends'
  }
  return false
}

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node

/**
 * The chain of one expression, innermost first: `base.$extends(a).$extends(b)` → { base: 'base', args: ['a', 'b'] }.
 * Null when it is not a pure chain of `$extends` calls with one identifier each, on an identifier.
 */
function extendsChain(expression: ts.Expression): { base: string; args: string[] } | null {
  const args: string[] = []
  let node = unwrap(expression)
  while (ts.isCallExpression(node) && isExtendsAccess(node.expression)) {
    const [arg, ...rest] = node.arguments
    if (rest.length > 0 || !arg || !ts.isIdentifier(arg)) return null
    args.unshift(arg.text)
    node = unwrap((node.expression as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)
  }
  return ts.isIdentifier(node) && args.length > 0 ? { base: node.text, args } : null
}

/** How many `$extends` accesses a source has (as a callee or not: `.bind`, an alias, a callback…). */
function extendsAccesses(text: string): number {
  let count = 0
  walk(parse(text), node => {
    if (isExtendsAccess(node)) count++
  })
  return count
}

const isTypeOnlyImport = (node: ts.ImportDeclaration): boolean => {
  const clause = node.importClause
  if (!clause) return false // `import './x'` runs the module
  if (clause.isTypeOnly) return true
  const bindings = clause.namedBindings
  return (
    !clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(e => e.isTypeOnly)
  )
}

const isTypeOnlyExport = (node: ts.ExportDeclaration): boolean =>
  node.isTypeOnly ||
  (!!node.exportClause &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every(e => e.isTypeOnly))

/** Every module a source loads AT RUNTIME: imports, re-exports, `import = require`, `require(…)` and `import(…)`. */
function runtimeModules(text: string): string[] {
  const modules: string[] = []
  walk(parse(text), node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && !isTypeOnlyImport(node)) {
      modules.push(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && !isTypeOnlyExport(node)) {
      modules.push(node.moduleSpecifier.text)
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      const target = node.moduleReference.expression
      modules.push(ts.isStringLiteralLike(target) ? target.text : '<dynamic>')
    }
    if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const [arg] = node.arguments
      if ((isRequire || isDynamicImport) && arg) modules.push(ts.isStringLiteralLike(arg) ? arg.text : '<dynamic>')
    }
  })
  return modules
}

/** Does the source construct a Prisma client — by its name, an alias of it, or through a namespace of `@prisma/client`? */
function constructsPrismaClient(text: string): boolean {
  const source = parse(text)
  const constructors = new Set(['PrismaClient'])
  const namespaces = new Set<string>()
  walk(source, node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text === '@prisma/client') {
      const clause = node.importClause
      if (clause?.name) namespaces.add(clause.name.text)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'PrismaClient') constructors.add(element.name.text)
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const target = node.moduleReference.expression
      if (ts.isStringLiteralLike(target) && target.text === '@prisma/client') namespaces.add(node.name.text)
    }
  })
  let found = false
  walk(source, node => {
    if (!ts.isNewExpression(node)) return
    const callee = node.expression
    if (ts.isIdentifier(callee) && constructors.has(callee.text)) found = true
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'PrismaClient') found = true
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text)) found = true
  })
  return found
}

/** Where an identifier with one of `names` appears in a source: kind of use, for the approved-extension check. */
function uses(
  text: string,
  names: ReadonlySet<string>,
): Array<{ name: string; kind: 'declaration' | 'import' | 'extends-argument' | 'other' }> {
  const found: Array<{ name: string; kind: 'declaration' | 'import' | 'extends-argument' | 'other' }> = []
  walk(parse(text), node => {
    if (!ts.isIdentifier(node) || !names.has(node.text)) return
    const parent = node.parent
    let kind: 'declaration' | 'import' | 'extends-argument' | 'other' = 'other'
    if (ts.isVariableDeclaration(parent) && parent.name === node) kind = 'declaration'
    else if (ts.isImportSpecifier(parent)) kind = 'import'
    else if (ts.isCallExpression(parent) && isExtendsAccess(parent.expression) && parent.arguments.includes(node)) kind = 'extends-argument'
    found.push({ name: node.text, kind })
  })
  return found
}

/**
 * An approved extension must be declared as a plain object literal (`{ … } as const`) whose STRUCTURE has no spread —
 * `{ ...other, name }` would compose it from something this guard does not see. Function bodies (the hooks) are code,
 * not structure: a spread there (`logger.warn(…, { ...aviso })`) composes nothing.
 */
function declaredAsPlainLiteral(text: string, name: string): boolean {
  let ok = false
  const hasStructuralSpread = (node: ts.Node): boolean => {
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) return true
    if (ts.isFunctionLike(node)) return false
    return ts.forEachChild(node, hasStructuralSpread) ?? false
  }
  walk(parse(text), node => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== name || !node.initializer) return
    const initializer = unwrap(node.initializer)
    ok = ts.isObjectLiteralExpression(initializer) && !hasStructuralSpread(initializer)
  })
  return ok
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

const read = (relative: string) => fs.readFileSync(path.join(SRC_DIR, relative), 'utf8')

describe('la cadena de extensiones del cliente de Prisma compartido (freno del MCP, marca del lote)', () => {
  const clientSource = fs.readFileSync(PRISMA_CLIENT, 'utf8')

  it('el cliente compartido es UNA cadena sobre el cliente base: la guardia de resultados, el freno de lecturas y el de transacciones', () => {
    const chains: Array<{ base: string; args: string[] } | null> = []
    walk(parse(clientSource), node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'prisma' && node.initializer) {
        chains.push(extendsChain(node.initializer))
      }
    })
    expect(chains).toEqual([{ base: 'prismaBase', args: APPROVED_CHAIN.map(e => e.name) }])
    // …y no hay ningún otro `$extends` en el archivo: tres accesos, los tres de esa cadena.
    expect(extendsAccesses(clientSource)).toBe(APPROVED_CHAIN.length)
  })

  it('cada extensión viene de su módulo aprobado', () => {
    const origin: Record<string, string> = {}
    walk(parse(clientSource), node => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return
      const bindings = node.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) return
      for (const element of bindings.elements) origin[element.name.text] = node.moduleSpecifier.text
    })
    for (const extension of APPROVED_CHAIN)
      expect({ [extension.name]: origin[extension.name] }).toEqual({ [extension.name]: extension.module })
  })

  it('cada extensión aprobada es un objeto literal, sin composición, y nadie la toca fuera de su declaración y de la cadena', () => {
    for (const extension of APPROVED_CHAIN)
      expect({ [extension.name]: declaredAsPlainLiteral(read(extension.file), extension.name) }).toEqual({ [extension.name]: true })
    const misuses = sourceFiles(SRC_DIR).flatMap(file =>
      uses(fs.readFileSync(file, 'utf8'), APPROVED_NAMES)
        .filter(use => (file === PRISMA_CLIENT ? use.kind !== 'import' && use.kind !== 'extends-argument' : use.kind !== 'declaration'))
        .map(use => `${path.relative(SRC_DIR, file)}: ${use.name}`),
    )
    expect(misuses).toEqual([])
  })

  it('ningún otro archivo deriva un cliente ni toca $extends (tampoco con .bind ni un alias)', () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter(file => file !== PRISMA_CLIENT)
      .filter(file => extendsAccesses(fs.readFileSync(file, 'utf8')) > 0)
      .map(file => path.relative(SRC_DIR, file))
    expect(offenders).toEqual([])
  })

  it.each(Object.entries(APPROVED_RUNTIME_DEPENDENCIES))(
    '%s sólo carga en ejecución sus dependencias aprobadas y no construye un cliente',
    (file, approved) => {
      const source = read(file)
      expect([...new Set(runtimeModules(source))].sort()).toEqual([...approved].sort())
      expect(constructsPrismaClient(source)).toBe(false)
    },
  )
})

/** Las burlas que encontró Codex en las rondas 7 y 8: cada una debe hacer fallar la guardia. */
describe('la guardia no se deja burlar (Codex rondas 7 y 8)', () => {
  const chainOf = (text: string) => {
    let chain: { base: string; args: string[] } | null | undefined
    walk(parse(text), node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'prisma' && node.initializer) {
        chain = extendsChain(node.initializer)
      }
    })
    return chain
  }

  it('una cuarta extensión escrita en línea no es una cadena aprobada', () => {
    const text = `const prisma = prismaBase
      .$extends(extensionResultadoGigante)
      .$extends({ name: 'extra', query: { $allModels: { async findMany({ args, query }) {
        await prisma.$queryRawUnsafe('SELECT pg_sleep(1)'); return query(args) } } } })
      .$extends(extensionCancellableReads)
      .$extends(extensionCancellableTransactions)`
    expect(chainOf(text)).toBeNull()
  })

  it('tres llamadas sobre receptores distintos no son una cadena', () => {
    const text = `const a = prismaBase.$extends(extensionResultadoGigante)
      const b = otro.$extends(extensionCancellableReads)
      const prisma = b.$extends(extensionCancellableTransactions)`
    expect(chainOf(text)).toEqual({ base: 'b', args: ['extensionCancellableTransactions'] })
    expect(extendsAccesses(text)).toBe(3)
  })

  it('un alias del método ($extends.bind) cuenta como acceso', () => {
    expect(extendsAccesses('const extend = prisma.$extends.bind(prisma); extend(extra)')).toBe(1)
    expect(extendsAccesses("const x = prisma['$extends'](algo)")).toBe(1)
  })

  it.each([
    ['Object.assign', 'Object.assign(extensionResultadoGigante, { query: {} })'],
    ['un spread', 'const extensionCancellableReads2 = { ...extensionCancellableReads }'],
    ['una mutación', 'extensionCancellableTransactions.client = {}'],
  ])('componer o mutar una extensión aprobada (%s) es un uso fuera de lo permitido', (_caso, text) => {
    expect(uses(text, APPROVED_NAMES).some(use => use.kind === 'other')).toBe(true)
  })

  it('una extensión aprobada declarada con un spread no es un objeto literal limpio', () => {
    expect(
      declaredAsPlainLiteral('export const extensionResultadoGigante = { ...base, name: "x" } as const', 'extensionResultadoGigante'),
    ).toBe(false)
    expect(declaredAsPlainLiteral('export const extensionResultadoGigante = { name: "x" } as const', 'extensionResultadoGigante')).toBe(
      true,
    )
    // Un spread DENTRO de un gancho es código, no composición; en la estructura, sí lo es.
    const conGancho =
      'export const extensionResultadoGigante = { query: { async findMany({ args, query }) { log({ ...args }); return query(args) } } } as const'
    expect(declaredAsPlainLiteral(conGancho, 'extensionResultadoGigante')).toBe(true)
    const compuesta = 'export const extensionResultadoGigante = { query: { ...otro } } as const'
    expect(declaredAsPlainLiteral(compuesta, 'extensionResultadoGigante')).toBe(false)
  })

  it.each([
    ['importación en varias líneas', "import {\n  default as prisma,\n} from './prismaClient'", './prismaClient'],
    ['import = require', "import client = require('./prismaClient')", './prismaClient'],
    ['require', "const prisma = require('./prismaClient').default", './prismaClient'],
    ['importación dinámica', "const load = () => import('@/utils/prismaClient')", '@/utils/prismaClient'],
    ['re-exportación', "export { default } from './prismaClient'", './prismaClient'],
    ['un servicio cualquiera', "import { algo } from '@/services/algo.service'", '@/services/algo.service'],
  ])('una dependencia en ejecución por %s se ve', (_caso, text, module) => {
    expect(runtimeModules(text)).toContain(module)
  })

  it.each([
    ['import type', "import type { Prisma } from '@prisma/client'"],
    ['especificadores de tipo', "import { type Prisma, type PrismaClient } from '@prisma/client'"],
    ['export type', "export type { Algo } from './prismaClient'"],
  ])('una importación sólo de tipos (%s) no es dependencia en ejecución', (_caso, text) => {
    expect(runtimeModules(text)).toEqual([])
  })

  it.each([
    ['por su nombre', 'const c = new PrismaClient()'],
    ['con alias', "import { PrismaClient as Client } from '@prisma/client'\nconst c = new Client()"],
    ['por espacio de nombres', "import * as db from '@prisma/client'\nconst c = new db.PrismaClient()"],
    ['por import = require', "import db = require('@prisma/client')\nconst c = new db.PrismaClient()"],
  ])('construir un cliente %s se detecta', (_caso, text) => {
    expect(constructsPrismaClient(text)).toBe(true)
  })
})
