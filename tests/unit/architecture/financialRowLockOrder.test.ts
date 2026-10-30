/** Inventario, no prueba de concurrencia: PostgreSQL real vive en exchangeR5/R6/R7. */
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import reviewed from './financialRowLockOrder.reviewed.json'

const ROOT = path.join(__dirname, '../../..')
type Review = { count: number; loops: number; reason: string }
type Site = { key: string; line: number; loops: number }
const rawReview: Record<string, Review> = reviewed.sql
const callerReview: Record<string, Review> = reviewed.callers
const tableNames = ['Order', 'Payment', 'GiftCard']

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const name = path.join(dir, e.name)
    return e.isDirectory() ? files(name) : /\.[cm]?[jt]sx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [name] : []
  })
}
function ownerOf(node: ts.Node): string {
  let owner = '(module)'
  for (let n: ts.Node | undefined = node; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name && ts.isSourceFile(n.parent)) owner = n.name.text
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isSourceFile(n.parent.parent.parent)) owner = n.name.text
    else if (ts.isMethodDeclaration(n) && ts.isClassDeclaration(n.parent) && n.parent.name)
      owner = `${n.parent.name.text}.${n.name.getText()}`
  }
  return owner
}
function callName(node: ts.CallExpression): string {
  return ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : ''
}
function loopsOf(node: ts.Node): number {
  let loops = 0
  for (let n: ts.Node | undefined = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
    // El bucle de un job NO acumula filas si cada vuelta abre/termina su propia transacción.
    if (ts.isCallExpression(n) && ['$transaction', 'withSerializableRetry', 'transaction'].includes(callName(n))) break
    if (ts.isIterationStatement(n, false)) loops++
    if (ts.isCallExpression(n) && ['map', 'forEach', 'reduce', 'flatMap'].includes(callName(n))) loops++
  }
  return loops
}
function lockedTables(text: string): string[] {
  const sql = text.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, ' ')
  const clauses = [...sql.matchAll(/\bFOR\s+(?:(?:NO\s+)?KEY\s+)?(?:UPDATE|SHARE)\b(?:\s+OF\s+((?:"?\w+"?\s*,\s*)*"?\w+"?))?/gi)]
  if (!clauses.length) return []
  return tableNames.filter(table => {
    const occurrences = [
      ...sql.matchAll(
        new RegExp(
          `\\b(?:FROM|JOIN)\\s+(?:ONLY\\s+)?(?:(?:"[^"]+"|[\\w$]+)\\s*\\.\\s*)?"${table}"(?:\\s+(?:AS\\s+)?"?([a-z_][a-z0-9_]*)"?)?`,
          'gi',
        ),
      ),
    ]
    return occurrences.some(match =>
      clauses.some(clause => {
        if (!clause[1]) return true
        const alias = match[1] && !/^(WHERE|JOIN|ON|ORDER|FOR|LIMIT|UNION)$/i.test(match[1]) ? match[1] : table
        return clause[1]
          .replace(/"/g, '')
          .split(/\s*,\s*/)
          .includes(alias)
      }),
    )
  })
}
function scan(file: string, text: string, helpers: Set<string>) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const sql: Site[] = [],
    callers: Site[] = []
  const aliases = new Map<string, string>()
  for (const statement of source.statements)
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    )
      for (const entry of statement.importClause.namedBindings.elements)
        aliases.set(entry.name.text, entry.propertyName?.text ?? entry.name.text)
  function visit(n: ts.Node) {
    const owner = `${file}#${ownerOf(n)}`
    const site = (key: string) => ({ key, line: source.getLineAndCharacterOfPosition(n.getStart()).line + 1, loops: loopsOf(n) })
    if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) {
      // OF importa: una consulta que une Payment pero bloquea sólo SaleVerification no toma Payments.
      if (lockedTables(n.getText(source)).length) sql.push(site(owner))
    }
    if (ts.isCallExpression(n)) {
      const name = aliases.get(callName(n)) ?? callName(n)
      if (helpers.has(name)) {
        const call = site(`${owner}#${name}`)
        // Esta fase aparta sólo sesiones/vales. El conjunto de Orders se toma DESPUÉS en una sentencia canónica.
        if (name === 'lockAreaTicketCheckoutHierarchy' && /\blockOrder\s*:\s*false\b/.test(n.arguments[2]?.getText(source) ?? ''))
          call.loops = 0
        callers.push(call)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(source)
  return { sql, callers }
}
function differences(sites: Site[], decisions: Record<string, Review>): string[] {
  const actual = new Map<string, Site[]>()
  for (const site of sites) actual.set(site.key, [...(actual.get(site.key) ?? []), site])
  return [...new Set([...actual.keys(), ...Object.keys(decisions)])].flatMap(key => {
    const found = actual.get(key) ?? [],
      decision = decisions[key]
    return !decision ||
      !decision.reason.trim() ||
      found.length !== decision.count ||
      found.filter(s => s.loops > 0).length !== decision.loops
      ? [
          `${key}:${found.map(s => s.line).join(',')} — ${found.length} llamadas/SQL, ${found.filter(s => s.loops > 0).length} en bucle; revisado=${decision ? `${decision.count}/${decision.loops}` : 'NO'}`,
        ]
      : []
  })
}
const helpers = new Set([
  ...Object.keys(rawReview).map(key => key.split('#')[1].split('.').at(-1)!),
  'lockExistingOrderForPayment',
  'lockOrdersForUpdate',
  'lockTableOrderScope',
  'bloquearOrdenParaFacturar',
  'bloquearOrdenesParaFacturar',
  'lockAreaTicketCheckoutHierarchy',
])

describe('Orden canónico de candados financieros (src completo, sin DB)', () => {
  it('incluye todos los formatos de TypeScript y JavaScript al descubrir archivos nuevos', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'financial-locks-'))
    const names = ['new.ts', 'new.tsx', 'new.js', 'new.jsx', 'new.mts', 'new.cts', 'new.mjs', 'new.cjs']
    try {
      for (const name of [...names, 'ignored.d.ts', 'ignored.md']) fs.writeFileSync(path.join(dir, name), '')
      expect(
        files(dir)
          .map(f => path.basename(f))
          .sort(),
      ).toEqual(names.sort())
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it('detecta tablas con esquema y ONLY, conservando el alcance de FOR UPDATE OF', () => {
    for (const table of tableNames)
      for (const prefix of ['public.', '"public".', 'ONLY public.'])
        expect(lockedTables(`SELECT id FROM ${prefix}"${table}" FOR UPDATE`)).toEqual([table])
    expect(lockedTables('SELECT p.id FROM public."Payment" p JOIN "Other" s ON true FOR UPDATE OF s')).toEqual([])
    expect(lockedTables('SELECT p.id FROM public."Payment" p FOR UPDATE OF p')).toEqual(['Payment'])
    expect(lockedTables('SELECT p.id FROM public."Payment" AS "p" FOR UPDATE OF "p"')).toEqual(['Payment'])
  })
  it('sólo los helpers revisados apartan Order/Payment/GiftCard; todo llamador y todo bucle están inventariados', () => {
    const all = files(path.join(ROOT, 'src')).map(p => scan(path.relative(ROOT, p), fs.readFileSync(p, 'utf8'), helpers))
    const missing = [
      ...differences(
        all.flatMap(r => r.sql),
        rawReview,
      ),
      ...differences(
        all.flatMap(r => r.callers),
        callerReview,
      ),
    ]
    if (missing.length)
      throw new Error(
        'Revisa el orden canónico: TODAS las Orders (createdAt DESC, id DESC) antes de Payments y GiftCards (id ASC); ' +
          'sesiones/vales ANTES de cualquier Order. No apartes Orders nuevas una por una en un bucle. ' +
          'Documenta archivo + función + por qué es seguro en financialRowLockOrder.reviewed.json, y prueba en PostgreSQL los cruces alcanzables.\n' +
          missing.join('\n'),
      )
  })
  it('detecta SQL nuevo, alias y el bucle viejo de liquidación aunque el SQL viva en otro helper', () => {
    const old = scan(
      'src/services/dashboard/customer.dashboard.service.ts',
      'async function settleCustomerBalance(tx){ for (const orderId of ids) { await lockAreaTicketCheckoutHierarchy(tx,{venueId,orderId}); await lockExistingOrderForPayment(tx,{venueId,orderId}) } }',
      helpers,
    )
    expect(old.callers.every(site => site.loops > 0)).toBe(true)
    expect(differences(old.callers, callerReview).some(e => e.includes('settleCustomerBalance#lockExistingOrderForPayment'))).toBe(true)
    const alias = scan(
      'new.ts',
      'import {lockExistingOrderForPayment as claim} from "./x"; async function writer(tx){await claim(tx, args)}',
      helpers,
    )
    expect(alias.callers[0].key).toBe('new.ts#writer#lockExistingOrderForPayment')
    expect(differences(alias.callers, callerReview)).not.toHaveLength(0)
    for (const table of tableNames) {
      const raw = scan('new.ts', `async function writer(tx){await tx.$queryRaw\`SELECT id FROM "${table}" FOR NO KEY UPDATE\`}`, helpers)
      expect(raw.sql).toHaveLength(1)
      expect(differences(raw.sql, rawReview)).not.toHaveLength(0)
    }
    expect(lockedTables('SELECT sv.id FROM "Payment" p JOIN "SaleVerification" sv ON sv."paymentId"=p.id FOR UPDATE OF sv')).toEqual([])
    expect(lockedTables('SELECT o.id FROM "Order" o JOIN "Payment" p ON p."orderId"=o.id FOR UPDATE OF o')).toEqual(['Order'])
  })
})
