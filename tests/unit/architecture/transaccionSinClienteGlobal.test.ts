/**
 * S10 r2, familia A (Codex código r2 P2-a): dentro de una transacción de dinero, toda consulta va por SU transacción (`tx`), nunca por el
 * cliente global. Una consulta global ahí pide una SEGUNDA conexión mientras la transacción retiene la suya: con tantas transacciones a la
 * vez como conexiones del pool (18 por default) se traban todas, también las de apps viejas que no usan saldo a favor. Pasó con
 * `validateStaffVenue` dentro de `prepareExchangeInTx` (exchangeTx.ts, S10 r1).
 *
 * Inventario estático (no prueba de concurrencia; la de verdad, con UNA conexión en el pool, es
 * `tests/integration/storeCredit/unaSolaConexion.integration.test.ts`). En los archivos de abajo, dentro de todo cuerpo «de transacción»
 * —el callback de un `$transaction(...)` o una función con un parámetro `tx`— falla:
 *  (a) usar el cliente global directamente (`prisma.x` o pasarlo como argumento);
 *  (b) llamar a una función de `src/` (importada o del mismo archivo) cuyo cuerpo usa el cliente global, sin pasarle la transacción del
 *      cuerpo como argumento (si la recibe, la usa: `db = prisma` sólo es el default de quien la llama afuera).
 * Límite (ponytail): un nivel de llamada. Una función que no toca el cliente global pero llama a otra que sí no se ve aquí; para eso
 * está la de integración con una sola conexión. Ampliar a dos niveles cuando aparezca un caso.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const RAIZ = path.join(__dirname, '../../..')
const ARCHIVOS = [
  ...['src/services/storeCredit', 'src/services/exchanges'].flatMap(dir =>
    fs
      .readdirSync(path.join(RAIZ, dir))
      .filter(f => f.endsWith('.ts'))
      .map(f => path.join(dir, f)),
  ),
  // El núcleo del reembolso: ahí corren `reglasBajoCandado` y el abono del saldo a favor.
  'src/services/dashboard/refund.dashboard.service.ts',
]

type Fuente = { archivo: string; sf: ts.SourceFile; global: string | null; imports: Map<string, { modulo: string; nombre: string }> }
const cache = new Map<string, Fuente | null>()

function resolver(desde: string, especificador: string): string | null {
  const base = especificador.startsWith('@/')
    ? path.join(RAIZ, 'src', especificador.slice(2))
    : especificador.startsWith('.')
      ? path.resolve(path.dirname(path.join(RAIZ, desde)), especificador)
      : null
  if (!base) return null
  for (const c of [base + '.ts', path.join(base, 'index.ts')]) if (fs.existsSync(c)) return path.relative(RAIZ, c)
  return null
}

function fuente(archivo: string, texto?: string): Fuente | null {
  if (texto === undefined && cache.has(archivo)) return cache.get(archivo)!
  const ruta = path.join(RAIZ, archivo)
  if (texto === undefined && !fs.existsSync(ruta)) return cache.set(archivo, null).get(archivo)!
  const sf = ts.createSourceFile(archivo, texto ?? fs.readFileSync(ruta, 'utf8'), ts.ScriptTarget.Latest, true)
  let global: string | null = null
  const imports = new Map<string, { modulo: string; nombre: string }>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.importClause?.isTypeOnly) continue
    const modulo = resolver(archivo, st.moduleSpecifier.text)
    if (!modulo) continue
    const c = st.importClause
    if (c?.name && modulo === 'src/utils/prismaClient.ts') global = c.name.text
    if (c?.namedBindings && ts.isNamedImports(c.namedBindings))
      for (const e of c.namedBindings.elements) imports.set(e.name.text, { modulo, nombre: (e.propertyName ?? e.name).text })
    if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) imports.set(c.namedBindings.name.text, { modulo, nombre: '*' })
  }
  return cache.set(archivo, { archivo, sf, global, imports }).get(archivo)!
}

/** El cuerpo de la función `nombre` de nivel superior del archivo (declaración, o `const nombre = (…) => …`). */
function funcionDe(f: Fuente, nombre: string): ts.Node | null {
  for (const st of f.sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === nombre) return st
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.name.text === nombre && d.initializer) return d.initializer
  }
  return null
}

/** ¿Este nodo usa el cliente global del archivo (como objeto o como argumento)? */
function usaElGlobal(nodo: ts.Node, global: string | null): boolean {
  if (!global) return false
  let usa = false
  const ver = (n: ts.Node) => {
    if (usa) return
    if (ts.isIdentifier(n) && n.text === global && !ts.isImportClause(n.parent) && !ts.isImportSpecifier(n.parent)) usa = true
    else ts.forEachChild(n, ver)
  }
  ver(nodo)
  return usa
}

const llamadaDe = (c: ts.CallExpression): { objeto?: string; nombre: string } | null =>
  ts.isIdentifier(c.expression)
    ? { nombre: c.expression.text }
    : ts.isPropertyAccessExpression(c.expression) && ts.isIdentifier(c.expression.expression)
      ? { objeto: c.expression.expression.text, nombre: c.expression.name.text }
      : null

/** El nombre del parámetro «transacción» de una función: `tx`, o el que se tipa como `TransactionClient`/`Tx`. */
function parametroTx(fn: ts.SignatureDeclaration): string | null {
  for (const p of fn.parameters) {
    if (!ts.isIdentifier(p.name)) continue
    const tipo = p.type?.getText() ?? ''
    if (p.name.text === 'tx' || /TransactionClient\b|^Tx$/.test(tipo)) return p.name.text
  }
  return null
}

function hallazgos(archivo: string): string[] {
  const f = fuente(archivo)!
  const out: string[] = []
  const linea = (n: ts.Node) => f.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
  const revisarCuerpo = (cuerpo: ts.Node, tx: string, donde: string) => {
    const ver = (n: ts.Node) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === f.global)
        out.push(`${archivo}:${linea(n)} ${donde}: usa el cliente global (${n.getText().slice(0, 60)})`)
      if (ts.isCallExpression(n)) {
        if (n.arguments.some(a => ts.isIdentifier(a) && a.text === f.global))
          out.push(`${archivo}:${linea(n)} ${donde}: le pasa el cliente global a ${n.expression.getText().slice(0, 60)}`)
        const llamada = llamadaDe(n)
        const pasaLaTx = n.arguments.some(a => ts.isIdentifier(a) && a.text === tx)
        if (llamada && !pasaLaTx) {
          const imp = f.imports.get(llamada.objeto ?? llamada.nombre)
          const destino = imp
            ? { archivo: imp.modulo, nombre: imp.nombre === '*' ? llamada.nombre : imp.nombre }
            : !llamada.objeto
              ? { archivo, nombre: llamada.nombre }
              : null
          const fd = destino && destino.archivo.startsWith('src/') ? fuente(destino.archivo) : null
          const cuerpoDestino = fd && funcionDe(fd, destino!.nombre)
          if (fd && cuerpoDestino && usaElGlobal(cuerpoDestino, fd.global))
            out.push(
              `${archivo}:${linea(n)} ${donde}: llama a ${destino!.nombre} (${destino!.archivo}), que usa el cliente global, sin pasarle «${tx}»`,
            )
        }
      }
      ts.forEachChild(n, ver)
    }
    ver(cuerpo)
  }
  const visitar = (n: ts.Node) => {
    // (1) El callback de `$transaction(async tx => …)`.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === '$transaction') {
      const cb = n.arguments[0]
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0] && ts.isIdentifier(cb.parameters[0].name))
        revisarCuerpo(cb.body, cb.parameters[0].name.text, `$transaction de la línea ${linea(n)}`)
    }
    // (2) Una función que recibe la transacción.
    if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) && n.body) {
      const tx = parametroTx(n)
      if (tx) revisarCuerpo(n.body, tx, `función con «${tx}» de la línea ${linea(n)}`)
    }
    ts.forEachChild(n, visitar)
  }
  visitar(f.sf)
  return [...new Set(out)]
}

describe('🔴 familia A: dentro de una transacción de dinero no se usa el cliente global', () => {
  it.each(ARCHIVOS)('%s', archivo => {
    expect(hallazgos(archivo)).toEqual([])
  })

  it('control: la prueba sí atrapa el caso de S10 r1 (validateStaffVenue sin la transacción dentro de las puertas del Cambio)', () => {
    // Un archivo en memoria (nunca en disco: otras pruebas recorren src/).
    const control = 'src/services/exchanges/__control_familiaA.ts'
    fuente(
      control,
      `import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { validateStaffVenue } from '@/utils/staff-venue.util'
export async function puertas(tx: Prisma.TransactionClient) {
  await validateStaffVenue('s', 'v')
  await prisma.venue.findUnique({ where: { id: 'v' } })
  await validateStaffVenue('s', 'v', undefined, tx)
}
`,
    )
    expect(hallazgos(control)).toEqual([
      expect.stringContaining('llama a validateStaffVenue (src/utils/staff-venue.util.ts), que usa el cliente global'),
      expect.stringContaining('usa el cliente global (prisma.venue'),
    ])
  })
})
