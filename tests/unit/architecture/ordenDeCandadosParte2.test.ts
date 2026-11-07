/**
 * S5b (red por traba; R63–R65, R74; Rulings 13, 16, 21, 22, 29): lo que el tipo `TxConReintento` no ve. Mira sólo la FORMA del
 * código (árbol de TypeScript, sin base y sin verificador de tipos; la marca la cuida `scripts/guardias/txConReintento.ts`):
 *
 * Escrituras — toda escritura o candado de una fila protegida (Prisma `create`…`deleteMany`; SQL `UPDATE`/`INSERT`/`DELETE` o los
 * cuatro candados de fila `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`), el asesor del cupón y los escritores
 * indirectos (borrar, o cambiarle la llave a, un padre cuya acción referencial llega a esas tablas), encontrada por NODO:
 *  (1) no usa el cliente global; (2) su receptor es un parámetro `TxConReintento` o el `tx` de un cuerpo de `withDeadlockRetry`
 *  (o de `withSerializableRetry` con `reintentarInterbloqueo`, o de un opener genérico del JSON); (3) ninguna función que la
 *  contiene tiene su cliente por omisión `= prisma`; (8) los padres se derivan de `schema.prisma` y deben ser los del JSON.
 * Transacciones — (4) ninguna `$transaction([…])` en arreglo con una de esas escrituras; (5)/(6) los `as TxConReintento` de `src/`
 *  son exactamente los de `castsPermitidos` (y el efecto que justifica el de `recordOrderPayment` sigue ahí); (7) una función que
 *  recibe `tx` no abre `withDeadlockRetry` (salvo una función de `cuerposRevisados`, Ruling 21: la exime ENTERA, porque esta prueba
 *  no separa ramas; sólo se lista una función cuya única apertura es la rama que corre sin `tx`, y eso lo comprueba la revisión).
 * Cuerpos de `withDeadlockRetry`, con su cierre de llamadas resuelto por `import` (también `await import`): (a) ningún efecto fuera
 *  de la base; (b) ninguna escritura con el cliente global ni `logAction` sin `tx`; (c) no abre otra transacción (misma excepción);
 *  (d) no escribe nada declarado fuera de él (asignación, `++`, `.push/.add/.set/.splice/.delete/.unshift/.pop/.shift/.clear`,
 *  `Object.assign(afuera, …)`, propiedades); (e) no se lo pasa a una función que muta ese parámetro.
 * Inventario — cada función con una escritura está en `escritores` (clase y etiqueta) y cada apertura en `aperturas`; falta o sobra,
 *  falla.
 *
 * 🔴 La corrida sobre `src/` se enciende en el paso 8 (`corridaSobreSrc` del JSON); hasta entonces corren las autopruebas, sobre
 * fuentes de juguete. Techo (ponytail): el cierre de llamadas es sintáctico (no sigue métodos de objetos ni `this.x()`); la marca y
 * el compilador son la autoridad, esta prueba atrapa la forma.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import revisadoJson from './ordenDeCandadosParte2.reviewed.json'

const RAIZ = path.join(__dirname, '../../..')

type Clase = 'EN_TX' | 'SENTENCIA'
type Efecto = { archivo: string; funcion: string; llamada: string }
export type Revisado = {
  corridaSobreSrc: boolean
  padresConAccionReferencial: string[]
  escritores: Record<string, { clase: Clase; etiqueta: string }>
  aperturas: Record<string, { etiqueta: string; cantidad: number; serializable?: boolean }>
  openersGenericos: Record<string, { cuerpo: number; motivo: string }>
  castsPermitidos: Record<string, { cantidad: number; motivo: string; efectos?: Efecto[] }>
  cuerposRevisados: Record<string, string>
  /** `archivo#llamada` → motivo: una llamada cuyo NOMBRE parece un efecto (emit…, mandar…, setTimeout) pero sólo toca la base o es un plazo. */
  efectosRevisados?: Record<string, string>
}
const revisado = revisadoJson as unknown as Revisado

export const PROTEGIDAS = [
  'Discount',
  'CouponCode',
  'CouponRedemption',
  'StampReward',
  'StampCard',
  'StampEvent',
  'Customer',
  'LoyaltyTransaction',
  'GiftCard',
]
const ESCRITURAS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
])
const BORRADOS = new Set(['delete', 'deleteMany'])
const CAMBIOS = new Set(['update', 'updateMany', 'updateManyAndReturn', 'upsert'])
const ASESOR_DEL_CUPON = new Set(['apartarCupon', 'bloquearDescuento'])
const CRUDAS = new Set(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'])
const ABREN = new Set(['$transaction', 'withDeadlockRetry', 'withSerializableRetry'])
const MUTADORES = new Set(['push', 'add', 'set', 'splice', 'delete', 'unshift', 'pop', 'shift', 'clear'])
/** (a) Efectos fuera de la base (y `verifyIdToken`, Ruling 15). Sin `/i`: `send` + MAYÚSCULA (`sendEmail`, no `sendero`). */
const EFECTO_POR_NOMBRE =
  /^(emit|broadcast|notify|publish)|^(send|enviar|mandar)[A-Z]|^(setTimeout|setImmediate|fetch|axios|opsAlert|finalizeCouponsForOrder|verifyIdToken)$/
const EFECTO_WHATSAPP = /whatsapp/i
/** Métodos que mandan algo afuera sea cual sea el receptor: `messaging().send(…)`, `canal.publish(…)` (RabbitMQ). */
const EFECTO_POR_METODO = new Set(['send', 'publish'])
const EFECTO_POR_RECEPTOR =
  /^(socketManager|stripe|axios|mercadoPago|mercadopago|blumon\w*|angelPay\w*|emailService|resend|twilio|whatsapp\w*)$/i

// ───────────────────────────── esquema: los padres con acción referencial (8) ─────────────────────────────

type Relacion = { hijo: string; padre: string; accion: string; alCambiar: string; referencias: string[] }
function relaciones(schema: string): Relacion[] {
  const out: Relacion[] = []
  for (const modelo of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm))
    for (const linea of modelo[2].split('\n')) {
      const campo = linea
        .replace(/\/\/.*$/, '')
        .trim()
        .match(/^\w+\s+(\w+)(\[\])?(\?)?\s+.*@relation\((.*)\)/)
      const fields = campo?.[4].match(/fields:\s*\[([^\]]*)\]/)
      if (!campo || campo[2] || !fields) continue
      out.push({
        hijo: modelo[1],
        padre: campo[1],
        // Prisma: opcional sin onDelete = SetNull; obligatoria sin él = Restrict.
        accion: campo[4].match(/onDelete:\s*(\w+)/)?.[1] ?? (campo[3] ? 'SetNull' : 'Restrict'),
        alCambiar: campo[4].match(/onUpdate:\s*(\w+)/)?.[1] ?? 'Cascade',
        referencias: (campo[4].match(/references:\s*\[([^\]]*)\]/)?.[1] ?? 'id').split(',').map(s => s.trim()),
      })
    }
  return out
}
/** Padres (no protegidos) cuyo borrado llega a una tabla protegida por Cascade/SetNull/SetDefault, también por una cadena de Cascade. */
export function padresDerivados(schema: string): { padres: string[]; llaves: Map<string, Set<string>> } {
  const rels = relaciones(schema)
  const padres = new Set<string>()
  for (let cambio = true; cambio; ) {
    cambio = false
    for (const r of rels)
      if (!PROTEGIDAS.includes(r.padre) && !padres.has(r.padre))
        if (
          (PROTEGIDAS.includes(r.hijo) && ['Cascade', 'SetNull', 'SetDefault'].includes(r.accion)) ||
          (r.accion === 'Cascade' && padres.has(r.hijo))
        ) {
          padres.add(r.padre)
          cambio = true
        }
  }
  // La llave referida que, al cambiar, escribe una fila protegida (onUpdate Cascade por omisión de Prisma).
  const escribeAlCambiar = (r: Relacion) => PROTEGIDAS.includes(r.hijo) && !['Restrict', 'NoAction'].includes(r.alCambiar)
  const llaves = new Map(
    [...padres].map(p => [p, new Set(rels.filter(r => r.padre === p && escribeAlCambiar(r)).flatMap(r => r.referencias))]),
  )
  return { padres: [...padres].sort(), llaves }
}

// ───────────────────────────── SQL ─────────────────────────────

const TABLA = (t: string) => `(?:ONLY\\s+)?(?:(?:"[^"]+"|[\\w$]+)\\s*\\.\\s*)?"${t}"`
/** Tablas que el texto escribe (`UPDATE`/`INSERT INTO`/`DELETE FROM`) o bloquea con uno de los cuatro candados de fila (Ruling 13). */
export function tablasDelSql(texto: string, tablas: string[]): string[] {
  const sql = texto.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, ' ')
  const candados = [...sql.matchAll(/\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b(?:\s+OF\s+((?:"?\w+"?\s*,\s*)*"?\w+"?))?/gi)]
  return tablas.filter(t => {
    if (new RegExp(`\\b(?:UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+${TABLA(t)}`, 'i').test(sql)) return true
    if (!candados.length) return false
    return [...sql.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+${TABLA(t)}(?:\\s+(?:AS\\s+)?"?([a-z_][a-z0-9_]*)"?)?`, 'gi'))].some(m =>
      candados.some(c => {
        if (!c[1]) return true
        const alias = m[1] && !/^(WHERE|JOIN|ON|ORDER|FOR|LIMIT|UNION|SET|INNER|LEFT)$/i.test(m[1]) ? m[1] : t
        return c[1]
          .replace(/"/g, '')
          .split(/\s*,\s*/)
          .includes(alias)
      }),
    )
  })
}
const SQL_ESCRIBE = /\b(?:UPDATE\s+(?:ONLY\s+)?(?:"[^"]+"|\w+)\s+(?:AS\s+\w+\s+)?SET|INSERT\s+INTO|DELETE\s+FROM)\b/i

// ───────────────────────────── módulos ─────────────────────────────

type Modulo = {
  archivo: string
  sf: ts.SourceFile
  globales: Set<string>
  imports: Map<string, { modulo: string; nombre: string }>
}
const llamadaDe = (c: ts.CallExpression) =>
  ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : ''
const linea = (n: ts.Node) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1
const esFuncion = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)

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
const llave = (n: ts.Node) => `${n.getSourceFile().fileName}#${ownerOf(n)}`

function resolver(desde: string, especificador: string, existe: (a: string) => boolean): string | null {
  const base = especificador.startsWith('@/')
    ? path.posix.join('src', especificador.slice(2))
    : especificador.startsWith('.')
      ? path.posix.join(path.posix.dirname(desde), especificador)
      : null
  if (!base) return null
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`].find(existe) ?? null
}
/** `await import('x')` (o `require('x')`) → el especificador. */
function importDinamico(n: ts.Expression | undefined): string | null {
  while (n && (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n))) n = n.expression
  if (n && ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || llamadaDe(n) === 'require'))
    return ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : null
  return null
}

function indexar(fuentes: Map<string, string>): Map<string, Modulo> {
  const existe = (a: string) => fuentes.has(a)
  const modulos = new Map<string, Modulo>()
  for (const [archivo, texto] of fuentes) {
    const sf = ts.createSourceFile(archivo, texto, ts.ScriptTarget.Latest, true)
    const globales = new Set<string>()
    const imports = new Map<string, { modulo: string; nombre: string }>()
    const esCliente = (m: string | null) => !!m && /(^|\/)utils\/prismaClient(\.ts)?$/.test(m)
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.importClause?.isTypeOnly) continue
      const modulo = resolver(archivo, st.moduleSpecifier.text, existe)
      const c = st.importClause
      if (c?.name && esCliente(modulo ?? st.moduleSpecifier.text)) globales.add(c.name.text)
      if (!modulo) continue
      if (c?.name) imports.set(c.name.text, { modulo, nombre: 'default' })
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings))
        for (const e of c.namedBindings.elements) imports.set(e.name.text, { modulo, nombre: (e.propertyName ?? e.name).text })
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) imports.set(c.namedBindings.name.text, { modulo, nombre: '*' })
    }
    // Ruling 22: `const { f } = await import('x')` y `const m = await import('x')` cuentan como un import (en cualquier función).
    const visitar = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n)) {
        const espec = importDinamico(n.initializer)
        const defaultDe = n.initializer && ts.isPropertyAccessExpression(n.initializer) ? importDinamico(n.initializer.expression) : null
        if ((espec && esCliente(espec)) || (defaultDe && esCliente(defaultDe))) if (ts.isIdentifier(n.name)) globales.add(n.name.text)
        const modulo = espec && resolver(archivo, espec, existe)
        if (modulo && ts.isObjectBindingPattern(n.name))
          for (const e of n.name.elements)
            if (ts.isIdentifier(e.name)) {
              const nombre = (e.propertyName ?? e.name).getText()
              if (nombre === 'default' && esCliente(modulo)) globales.add(e.name.text)
              imports.set(e.name.text, { modulo, nombre })
            }
        if (modulo && ts.isIdentifier(n.name)) imports.set(n.name.text, { modulo, nombre: '*' })
      }
      ts.forEachChild(n, visitar)
    }
    visitar(sf)
    modulos.set(archivo, { archivo, sf, globales, imports })
  }
  return modulos
}

/** La función de nivel superior `nombre` de un módulo (declaración, `const f = (…) => …`, `export default`, o un re-export). */
function funcionExportada(
  modulos: Map<string, Modulo>,
  archivo: string,
  nombre: string,
  visto = new Set<string>(),
): ts.FunctionLikeDeclaration | null {
  const m = modulos.get(archivo)
  if (!m || visto.has(`${archivo}#${nombre}`)) return null
  visto.add(`${archivo}#${nombre}`)
  for (const st of m.sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.body) {
      const esDefault = st.modifiers?.some(x => x.kind === ts.SyntaxKind.DefaultKeyword)
      if (st.name?.text === nombre || (nombre === 'default' && esDefault)) return st
    }
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.name.text === nombre && d.initializer && esFuncion(d.initializer)) return d.initializer
    if (nombre === 'default' && ts.isExportAssignment(st) && ts.isIdentifier(st.expression))
      return funcionExportada(modulos, archivo, st.expression.text, visto)
    if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      const destino =
        st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
          ? resolver(archivo, st.moduleSpecifier.text, a => modulos.has(a))
          : archivo
      if (!destino) continue
      if (!st.exportClause) {
        const f = funcionExportada(modulos, destino, nombre, visto)
        if (f) return f
      } else if (ts.isNamedExports(st.exportClause))
        for (const e of st.exportClause.elements)
          if (e.name.text === nombre) return funcionExportada(modulos, destino, (e.propertyName ?? e.name).text, visto)
    }
  }
  const imp = m.imports.get(nombre)
  return imp && imp.nombre !== '*' ? funcionExportada(modulos, imp.modulo, imp.nombre, visto) : null
}

/** La función que nombra `id`: local (declarada en un bloque que lo contiene), de nivel superior, o importada. */
function resolverNombre(modulos: Map<string, Modulo>, m: Modulo, id: ts.Identifier): ts.FunctionLikeDeclaration | null {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent)
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n))
      for (const st of n.statements) {
        if (ts.isFunctionDeclaration(st) && st.name?.text === id.text && st.body) return st
        if (ts.isVariableStatement(st))
          for (const d of st.declarationList.declarations)
            if (ts.isIdentifier(d.name) && d.name.text === id.text && d.initializer && esFuncion(d.initializer)) return d.initializer
      }
  const imp = m.imports.get(id.text)
  return imp && imp.nombre !== '*' ? funcionExportada(modulos, imp.modulo, imp.nombre) : null
}
function resolverLlamada(modulos: Map<string, Modulo>, m: Modulo, c: ts.CallExpression): ts.FunctionLikeDeclaration | null {
  let e: ts.Expression = c.expression
  while (ts.isParenthesizedExpression(e)) e = e.expression
  if (ts.isIdentifier(e)) return resolverNombre(modulos, m, e)
  if (ts.isPropertyAccessExpression(e)) {
    // `ns.f(…)` con `import * as ns` o `const ns = await import(…)`, y `(await import('x')).f(…)` (Ruling 22).
    const espec = importDinamico(e.expression)
    const destino = espec
      ? resolver(m.archivo, espec, a => modulos.has(a))
      : ts.isIdentifier(e.expression) && m.imports.get(e.expression.text)?.nombre === '*'
        ? m.imports.get(e.expression.text)!.modulo
        : null
    return destino ? funcionExportada(modulos, destino, e.name.text) : null
  }
  return null
}

// ───────────────────────────── receptores y cuerpos ─────────────────────────────

const esTipoCliente = (t: ts.TypeNode | undefined) =>
  !!t &&
  !ts.isFunctionTypeNode(t) &&
  /^(?:(?:Prisma\.)?TransactionClient|TxConReintento|Tx|DbClient)(?:\s*\|\s*(?:undefined|null))*$/.test(t.getText())
/** ¿Esta función recibe un `tx`? (un parámetro `tx`, o tipado como cliente de transacción). */
const recibeTx = (f: ts.SignatureDeclaration) =>
  f.parameters.some(p => (ts.isIdentifier(p.name) && p.name.text === 'tx' && !p.type) || esTipoCliente(p.type))

function opcionReintentar(c: ts.CallExpression): boolean {
  const o = c.arguments[1]
  return (
    !!o &&
    ts.isObjectLiteralExpression(o) &&
    o.properties.some(
      p => ts.isPropertyAssignment(p) && p.name.getText() === 'reintentarInterbloqueo' && p.initializer.kind === ts.SyntaxKind.TrueKeyword,
    )
  )
}
/** ¿Esta llamada abre la red? Devuelve el índice del argumento que es el cuerpo, o -1. */
function cuerpoDeApertura(c: ts.CallExpression, genericos: Map<string, number>): number {
  const nombre = llamadaDe(c)
  if (nombre === 'withDeadlockRetry') return 0
  if (nombre === 'withSerializableRetry' && opcionReintentar(c)) return 0
  return genericos.get(nombre) ?? -1
}
/** Si `f` es el cuerpo (en línea) de una apertura de la red. */
function esCuerpoEnLinea(f: ts.Node, genericos: Map<string, number>): boolean {
  const c = f.parent
  return !!c && ts.isCallExpression(c) && c.arguments.indexOf(f as ts.Expression) === cuerpoDeApertura(c, genericos)
}

type Receptor = 'marcado' | 'global' | 'otro'
function clasificarReceptor(r: ts.Expression | undefined, m: Modulo, genericos: Map<string, number>): { tipo: Receptor; texto: string } {
  while (r && (ts.isParenthesizedExpression(r) || ts.isNonNullExpression(r))) r = r.expression
  if (!r) return { tipo: 'otro', texto: '(sin receptor)' }
  const texto = r.getText().slice(0, 40)
  if (!ts.isIdentifier(r)) return { tipo: 'otro', texto }
  for (let n: ts.Node | undefined = r.parent; n && !ts.isSourceFile(n); n = n.parent)
    if (esFuncion(n))
      for (const p of n.parameters) {
        const nombres = ts.isIdentifier(p.name)
          ? [p.name.text]
          : p.name.elements.flatMap(e => (ts.isBindingElement(e) && ts.isIdentifier(e.name) ? [e.name.text] : []))
        if (!nombres.includes(r.text)) continue
        const marcado =
          /\bTxConReintento\b/.test(p.type?.getText() ?? '') || (!p.type && n.parameters[0] === p && esCuerpoEnLinea(n, genericos))
        return { tipo: marcado ? 'marcado' : 'otro', texto }
      }
  return { tipo: m.globales.has(r.text) || r.text === 'prisma' ? 'global' : 'otro', texto }
}

/** El receptor de un SQL: el cliente de la llamada cruda que lo lleva. */
function receptorDelSql(n: ts.Node): ts.Expression | undefined {
  for (let p: ts.Node | undefined = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isTaggedTemplateExpression(p) && ts.isPropertyAccessExpression(p.tag) && CRUDAS.has(p.tag.name.text)) return p.tag.expression
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && CRUDAS.has(p.expression.name.text))
      return p.expression.expression
    if (esFuncion(p)) return undefined
  }
  return undefined
}

type Sitio = { llave: string; donde: string; nodo: ts.Node; receptor: { tipo: Receptor; texto: string } }

/** Toda escritura o candado de una fila protegida (directa, del asesor o indirecta) del módulo. */
function sitiosDe(m: Modulo, padres: Map<string, Set<string>>, genericos: Map<string, number>): Sitio[] {
  const out: Sitio[] = []
  const delegados = new Map(PROTEGIDAS.map(t => [t[0].toLowerCase() + t.slice(1), t]))
  const delegadosPadre = new Map([...padres.keys()].map(t => [t[0].toLowerCase() + t.slice(1), t]))
  const tablasSql = [...PROTEGIDAS]
  const sitio = (n: ts.Node, que: string, receptor: ts.Expression | undefined) =>
    out.push({
      llave: llave(n),
      donde: `${m.archivo}:${linea(n)} ${ownerOf(n)} ${que}`,
      nodo: n,
      receptor: clasificarReceptor(receptor, m, genericos),
    })
  const visitar = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isPropertyAccessExpression(n.expression.expression)) {
      const op = n.expression.name.text
      const delegado = n.expression.expression.name.text
      const receptor = n.expression.expression.expression
      if (ESCRITURAS.has(op) && delegados.has(delegado)) sitio(n, `${delegado}.${op}`, receptor)
      const padre = delegadosPadre.get(delegado)
      if (padre && BORRADOS.has(op)) sitio(n, `${delegado}.${op} (escritura indirecta)`, receptor)
      if (padre && CAMBIOS.has(op)) {
        const arg = n.arguments[0]
        const data = arg && ts.isObjectLiteralExpression(arg) ? arg.properties.find(p => p.name?.getText() === 'data') : undefined
        const cambiaLlave =
          data && ts.isPropertyAssignment(data) && ts.isObjectLiteralExpression(data.initializer)
            ? data.initializer.properties.some(p => padres.get(padre)!.has(p.name?.getText() ?? ''))
            : false
        if (cambiaLlave) sitio(n, `${delegado}.${op} cambia la llave (escritura indirecta)`, receptor)
      }
    }
    if (ts.isCallExpression(n) && ASESOR_DEL_CUPON.has(llamadaDe(n)) && !ts.isPropertyAccessExpression(n.expression))
      sitio(n, `asesor del cupón ${llamadaDe(n)}`, n.arguments[0])
    if (
      (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) &&
      /\b(UPDATE|INSERT|DELETE|FOR)\b/i.test(n.getText())
    ) {
      const texto = n.getText()
      const tablas = tablasDelSql(texto, tablasSql)
      const borrados = [...padres.keys()].filter(p => new RegExp(`\\bDELETE\\s+FROM\\s+${TABLA(p)}`, 'i').test(texto))
      if (tablas.length || borrados.length)
        sitio(n, `SQL sobre ${[...tablas, ...borrados.map(p => `${p} (indirecta)`)].join(', ')}`, receptorDelSql(n))
    }
    ts.forEachChild(n, visitar)
  }
  visitar(m.sf)
  // Una plantilla anidada (`Prisma.sql` dentro de otra) es el mismo sitio: uno por línea y escritura.
  return out.filter((s, i) => out.findIndex(o => o.donde === s.donde) === i)
}

/** Nombres declarados DENTRO de un nodo (parámetros, variables, funciones, clases, `catch`), sin mirar el alcance exacto. */
function declaradosDentro(nodo: ts.Node): Set<string> {
  const nombres = new Set<string>()
  const nombre = (b: ts.BindingName) => {
    if (ts.isIdentifier(b)) nombres.add(b.text)
    else for (const e of b.elements) if (ts.isBindingElement(e)) nombre(e.name)
  }
  const visitar = (n: ts.Node) => {
    if (ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n)) nombre(n.name)
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) nombres.add(n.name.text)
    ts.forEachChild(n, visitar)
  }
  visitar(nodo)
  return nombres
}
function sinAserciones(e: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression
  return e
}
function raiz(e: ts.Expression): ts.Expression {
  while (
    ts.isPropertyAccessExpression(e) ||
    ts.isElementAccessExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isParenthesizedExpression(e)
  )
    e = e.expression
  return e
}
const ASIGNACIONES = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])
type Escritura = { raiz: ts.Expression; escrito: ts.Expression; reasigna: boolean }
/**
 * Lo que un nodo escribe: asignación, `+=`, `++`, los MUTADORES, `Object.assign(x, …)` y propiedades. `reasigna` = sólo cambia la
 * variable local (`x = …`, `x++`), no lo que apunta.
 */
function escrituras(nodo: ts.Node): Escritura[] {
  const out: Escritura[] = []
  const nuevo = (escrito: ts.Expression, reasigna: boolean) => out.push({ raiz: raiz(escrito), escrito, reasigna })
  const visitar = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && ASIGNACIONES.has(n.operatorToken.kind)) nuevo(n.left, ts.isIdentifier(sinAserciones(n.left)))
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)
    )
      nuevo(n.operand, ts.isIdentifier(sinAserciones(n.operand)))
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MUTADORES.has(n.expression.name.text))
      nuevo(n.expression, false)
    if (ts.isCallExpression(n) && n.expression.getText() === 'Object.assign' && n.arguments[0]) nuevo(n.arguments[0], false)
    ts.forEachChild(n, visitar)
  }
  visitar(nodo)
  return out
}

type Local = { efectos: string[]; globales: string[]; abre: string[]; llamadas: ts.FunctionLikeDeclaration[] }

function analizarCuerpos(modulos: Map<string, Modulo>, rev: Revisado, genericos: Map<string, number>): string[] {
  const out: string[] = []
  const memo = new Map<ts.Node, Local>()
  const moduloDe = (n: ts.Node) => modulos.get(n.getSourceFile().fileName)!
  const local = (f: ts.FunctionLikeDeclaration): Local => {
    if (memo.has(f)) return memo.get(f)!
    const m = moduloDe(f)
    const r: Local = { efectos: [], globales: [], abre: [], llamadas: [] }
    memo.set(f, r)
    const revisada = rev.cuerposRevisados[llave(f)] !== undefined
    const donde = (n: ts.Node) => `${m.archivo}:${linea(n)}`
    const visitar = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const nombre = llamadaDe(n)
        const receptor = ts.isPropertyAccessExpression(n.expression) ? raiz(n.expression.expression) : undefined
        const nombreReceptor = receptor && ts.isIdentifier(receptor) ? receptor.text : ''
        const metodo = ts.isPropertyAccessExpression(n.expression) && EFECTO_POR_METODO.has(nombre)
        const efectoRevisado = rev.efectosRevisados?.[`${m.archivo}#${nombre}`] !== undefined
        if (
          !efectoRevisado &&
          (EFECTO_POR_NOMBRE.test(nombre) || EFECTO_WHATSAPP.test(nombre) || EFECTO_POR_RECEPTOR.test(nombreReceptor) || metodo)
        )
          r.efectos.push(`${donde(n)} ${n.expression.getText().slice(0, 50)}`)
        if (ABREN.has(nombre) && !revisada) r.abre.push(`${donde(n)} ${nombre}`)
        if (nombre === 'logAction' && !n.arguments.some(a => ts.isIdentifier(a) && a.text === 'tx'))
          r.globales.push(`${donde(n)} logAction sin tx`)
        if (receptor && ts.isIdentifier(receptor) && clasificarReceptor(receptor, m, genericos).tipo === 'global') {
          const escribe = ESCRITURAS.has(nombre) || nombre === '$executeRaw' || nombre === '$executeRawUnsafe'
          if (escribe) r.globales.push(`${donde(n)} ${n.expression.getText().slice(0, 50)}`)
        }
        const destino = resolverLlamada(modulos, m, n)
        if (destino && destino !== f) r.llamadas.push(destino)
      }
      if (ts.isTaggedTemplateExpression(n) && ts.isPropertyAccessExpression(n.tag) && CRUDAS.has(n.tag.name.text)) {
        const receptor = clasificarReceptor(n.tag.expression, m, genericos)
        if (receptor.tipo === 'global' && SQL_ESCRIBE.test(n.template.getText()))
          r.globales.push(`${donde(n)} SQL que escribe con el cliente global`)
      }
      ts.forEachChild(n, visitar)
    }
    if (f.body) visitar(f.body)
    return r
  }

  for (const m of modulos.values()) {
    const visitar = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const i = cuerpoDeApertura(n, genericos)
        const arg = i >= 0 ? n.arguments[i] : undefined
        const cuerpo = arg && esFuncion(arg) ? arg : arg && ts.isIdentifier(arg) ? resolverNombre(modulos, m, arg) : null
        if (arg && !cuerpo)
          out.push(
            `${m.archivo}:${linea(n)} ${ownerOf(n)}: el cuerpo de ${llamadaDe(n)} no se pudo resolver (pásalo en línea o por nombre)`,
          )
        if (cuerpo) revisarCuerpo(cuerpo, `${m.archivo}:${linea(n)} ${llamadaDe(n)} de ${ownerOf(n)}`)
      }
      ts.forEachChild(n, visitar)
    }
    visitar(m.sf)
  }
  return out

  function revisarCuerpo(cuerpo: ts.FunctionLikeDeclaration, donde: string) {
    // (a)–(c): el cuerpo y su cierre de llamadas.
    const visto = new Set<ts.Node>([cuerpo])
    const pendientes: ts.FunctionLikeDeclaration[] = [cuerpo]
    while (pendientes.length) {
      const f = pendientes.pop()!
      const l = local(f)
      for (const e of l.efectos) out.push(`(a) ${donde}: efecto fuera de la base en ${e}`)
      for (const e of l.globales) out.push(`(b) ${donde}: escritura con el cliente global en ${e}`)
      for (const e of l.abre) out.push(`(c) ${donde}: abre otra transacción en ${e}`)
      for (const g of l.llamadas)
        if (!visto.has(g)) {
          visto.add(g)
          pendientes.push(g)
        }
    }
    // (d) y (e): sólo el cuerpo.
    const dentro = declaradosDentro(cuerpo)
    const m = moduloDe(cuerpo)
    const afuera = (e: ts.Expression) =>
      e.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(e) && !dentro.has(e.text) && !m.globales.has(e.text) && e.text !== 'prisma')
    for (const { raiz: r, escrito } of escrituras(cuerpo))
      if (afuera(r)) out.push(`(d) ${donde}: escribe «${escrito.getText()}», declarado fuera del cuerpo (${m.archivo}:${linea(escrito)})`)
    const visitar = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const destino = resolverLlamada(modulos, m, n)
        n.arguments.forEach((a, i) => {
          const p = destino?.parameters[i]
          if (!p || !ts.isIdentifier(p.name) || !ts.isIdentifier(a) || !afuera(a) || !destino?.body) return
          const nombre = p.name.text
          // `param = otro` sólo cambia la variable local; `param.push(…)` o `param.x = …` cambian lo del llamador.
          const muta = escrituras(destino.body).some(e => ts.isIdentifier(e.raiz) && e.raiz.text === nombre && !e.reasigna)
          if (muta)
            out.push(
              `(e) ${donde}: le pasa «${a.text}», declarado fuera del cuerpo, a ${llamadaDe(n)}, que muta ese parámetro (${m.archivo}:${linea(n)})`,
            )
        })
      }
      ts.forEachChild(n, visitar)
    }
    if (cuerpo.body) visitar(cuerpo.body)
  }
}

// ───────────────────────────── la revisión completa ─────────────────────────────

export function revisar(fuentes: Map<string, string>, schema: string, rev: Revisado): string[] {
  const out: string[] = []
  const { padres, llaves } = padresDerivados(schema)
  const listados = [...rev.padresConAccionReferencial].sort()
  if (padres.join() !== listados.join())
    out.push(
      `(8) padresConAccionReferencial no coincide con schema.prisma: derivados [${padres.join(', ')}], JSON [${listados.join(', ')}]. ` +
        'Un padre nuevo: clasifica sus borrados (cada escritor entra a escritores y su transacción a aperturas).',
    )
  const genericos = new Map(Object.entries(rev.openersGenericos).map(([k, v]) => [k.split('#')[1], v.cuerpo]))
  const modulos = indexar(fuentes)
  const inventario = new Set<string>()
  const aperturas = new Map<string, { cantidad: number; etiquetas: Set<string>; serializable: boolean }>()
  const casts = new Map<string, number>()

  for (const m of modulos.values()) {
    for (const s of sitiosDe(m, llaves, genericos)) {
      inventario.add(s.llave)
      if (s.receptor.tipo === 'global') out.push(`(1) ${s.donde}: usa el cliente global (${s.receptor.texto})`)
      else if (s.receptor.tipo === 'otro')
        out.push(
          `(2) ${s.donde}: su receptor «${s.receptor.texto}» no es un parámetro TxConReintento ni el tx de un cuerpo de withDeadlockRetry`,
        )
      for (let n: ts.Node | undefined = s.nodo.parent; n && !ts.isSourceFile(n); n = n.parent) {
        if (
          esFuncion(n) &&
          n.parameters.some(p => p.initializer && clasificarReceptor(sinAserciones(p.initializer), m, genericos).tipo === 'global')
        )
          out.push(`(3) ${s.donde}: una función que la contiene tiene su cliente por omisión = prisma`)
        if (ts.isCallExpression(n) && llamadaDe(n) === '$transaction' && n.arguments[0] && ts.isArrayLiteralExpression(n.arguments[0]))
          out.push(`(4) ${s.donde}: va dentro de una $transaction([…]) en arreglo; pásala a callback con withDeadlockRetry`)
      }
    }
    const visitar = (n: ts.Node) => {
      if (ts.isCallExpression(n) && cuerpoDeApertura(n, new Map()) === 0) {
        const k = llave(n)
        const a = aperturas.get(k) ?? { cantidad: 0, etiquetas: new Set<string>(), serializable: false }
        const o = n.arguments[1]
        const etiqueta =
          o && ts.isObjectLiteralExpression(o)
            ? o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'etiqueta')
                ?.initializer
            : undefined
        a.cantidad++
        a.etiquetas.add(etiqueta && ts.isStringLiteralLike(etiqueta) ? etiqueta.text : `(no literal en la línea ${linea(n)})`)
        a.serializable ||= llamadaDe(n) === 'withSerializableRetry'
        aperturas.set(k, a)
        // (7): el reintento va en quien ABRE.
        for (let p: ts.Node | undefined = n.parent; p && !ts.isSourceFile(p); p = p.parent)
          if (esFuncion(p) && recibeTx(p) && rev.cuerposRevisados[llave(p)] === undefined) {
            out.push(
              `(7) ${m.archivo}:${linea(n)} ${ownerOf(n)}: una función que recibe tx abre ${llamadaDe(n)}; el reintento va donde se abre la transacción`,
            )
            break
          }
      }
      if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && n.type.getText() === 'TxConReintento')
        casts.set(llave(n), (casts.get(llave(n)) ?? 0) + 1)
      ts.forEachChild(n, visitar)
    }
    visitar(m.sf)
  }
  out.push(...analizarCuerpos(modulos, rev, genericos))

  // Inventario de escritores.
  for (const k of inventario)
    if (!rev.escritores[k])
      out.push(`inventario: falta en escritores ${JSON.stringify(k)}: { "clase": "EN_TX" | "SENTENCIA", "etiqueta": "…" }`)
  for (const [k, e] of Object.entries(rev.escritores)) {
    if (!inventario.has(k)) out.push(`inventario: ${k} ya no escribe tablas protegidas; quítalo de escritores`)
    if (!['EN_TX', 'SENTENCIA'].includes(e.clase) || !e.etiqueta?.trim())
      out.push(`inventario: ${k} necesita clase EN_TX o SENTENCIA y su etiqueta`)
  }
  // Aperturas: cada withDeadlockRetry (y withSerializableRetry con reintentarInterbloqueo) está en el JSON con su etiqueta.
  for (const k of new Set([...aperturas.keys(), ...Object.keys(rev.aperturas)])) {
    const real = aperturas.get(k)
    const esperado = rev.aperturas[k]
    const etiquetas = real ? [...real.etiquetas] : []
    if (!esperado)
      out.push(`aperturas: falta ${JSON.stringify(k)}: { "etiqueta": "${etiquetas[0] ?? ''}", "cantidad": ${real?.cantidad ?? 0} }`)
    else if (
      !real ||
      real.cantidad !== esperado.cantidad ||
      etiquetas.some(e => e !== esperado.etiqueta) ||
      real.serializable !== !!esperado.serializable
    )
      out.push(
        `aperturas: ${k} — en el código ${real?.cantidad ?? 0} (${etiquetas.join(', ') || 'ninguna'}${real?.serializable ? ', serializable' : ''}); ` +
          `en el JSON ${esperado.cantidad} con etiqueta «${esperado.etiqueta}»${esperado.serializable ? ', serializable' : ''}`,
      )
  }
  // (5)/(6): los casts a TxConReintento son exactamente los listados, y la excepción conserva su efecto.
  for (const k of new Set([...casts.keys(), ...Object.keys(rev.castsPermitidos)])) {
    const permitido = rev.castsPermitidos[k]
    if ((casts.get(k) ?? 0) !== (permitido?.cantidad ?? 0))
      out.push(`(6) ${k}: ${casts.get(k) ?? 0} «as TxConReintento»; permitidos ${permitido?.cantidad ?? 0} (castsPermitidos del JSON)`)
    for (const efecto of permitido?.efectos ?? []) {
      const m = modulos.get(efecto.archivo)
      let sigue = false
      const visitar = (n: ts.Node) => {
        if (ts.isCallExpression(n) && llamadaDe(n) === efecto.llamada && ownerOf(n) === efecto.funcion) sigue = true
        ts.forEachChild(n, visitar)
      }
      if (m) visitar(m.sf)
      if (!sigue)
        out.push(
          `(5) ${k}: su efecto ya no está (${efecto.archivo}#${efecto.funcion} → ${efecto.llamada}); quita la excepción y envuélvela con withDeadlockRetry`,
        )
    }
  }
  return out
}

// ───────────────────────────── pruebas ─────────────────────────────

function fuentesDeSrc(): Map<string, string> {
  const leer = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name)
      return e.isDirectory() ? leer(p) : /\.[cm]?[jt]sx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : []
    })
  return new Map(leer(path.join(RAIZ, 'src')).map(p => [path.relative(RAIZ, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8')]))
}
const SCHEMA = () => fs.readFileSync(path.join(RAIZ, 'prisma/schema.prisma'), 'utf8')

const ESQUEMA_DE_JUGUETE = `
model Venue {
  id String @id
}
model Customer {
  id      String  @id
  venueId String
  venue   Venue   @relation(fields: [venueId], references: [id], onDelete: Cascade)
  grupoId String?
  grupo   Grupo?  @relation(fields: [grupoId], references: [id])
}
model Grupo {
  id       String @id
  abueloId String
  abuelo   Abuelo @relation(fields: [abueloId], references: [id], onDelete: Cascade)
}
model Abuelo {
  id String @id
}
model Order {
  id String @id
}
model CouponRedemption {
  id      String @id
  orderId String
  order   Order  @relation(fields: [orderId], references: [id], onDelete: Cascade)
}
model StaffVenue {
  id String @id
}
model Discount {
  id          String      @id
  createdById String?
  createdBy   StaffVenue? @relation(fields: [createdById], references: [id], onDelete: SetNull)
}
model Bitacora {
  id         String   @id
  customerId String
  customer   Customer @relation(fields: [customerId], references: [id], onDelete: Restrict)
}
`
const PADRES_DE_JUGUETE = ['Abuelo', 'Grupo', 'Order', 'StaffVenue', 'Venue']
const juguete = (extra: Partial<Revisado> = {}): Revisado => ({
  corridaSobreSrc: true,
  padresConAccionReferencial: PADRES_DE_JUGUETE,
  escritores: {},
  aperturas: {},
  openersGenericos: revisado.openersGenericos,
  castsPermitidos: {},
  cuerposRevisados: {},
  ...extra,
})
const CLIENTE = `import prisma from '@/utils/prismaClient'\nimport { withDeadlockRetry, withSerializableRetry, TxConReintento } from '@/utils/serializableRetry'\nimport { Prisma } from '@prisma/client'\n`
const archivos = (codigo: Record<string, string>) =>
  new Map<string, string>([
    ['src/utils/prismaClient.ts', 'export default {}'],
    ['src/utils/serializableRetry.ts', ''],
    ...Object.entries(codigo),
  ])
const hallazgos = (codigo: Record<string, string>, extra?: Partial<Revisado>) =>
  revisar(archivos(codigo), ESQUEMA_DE_JUGUETE, juguete(extra))
const con = (lista: string[], regla: string, texto = '') => lista.filter(h => h.startsWith(regla) && h.includes(texto))

describe('Red por traba: la forma que el tipo no ve (S5b)', () => {
  describe('detector', () => {
    it('los cuatro candados de fila cuentan, con el alcance de OF, y también UPDATE/INSERT/DELETE (Ruling 13)', () => {
      for (const candado of ['FOR UPDATE', 'FOR NO KEY UPDATE', 'FOR SHARE', 'FOR KEY SHARE'])
        expect(tablasDelSql(`SELECT id FROM "Discount" WHERE id = ANY($1) ORDER BY id ${candado}`, PROTEGIDAS)).toEqual(['Discount'])
      expect(tablasDelSql('SELECT c.id FROM "Customer" c JOIN "Order" o ON true FOR UPDATE OF o', PROTEGIDAS)).toEqual([])
      expect(tablasDelSql('SELECT c.id FROM public."Customer" AS "c" FOR KEY SHARE OF "c"', PROTEGIDAS)).toEqual(['Customer'])
      expect(tablasDelSql('UPDATE "GiftCard" AS g SET x = 1', PROTEGIDAS)).toEqual(['GiftCard'])
      expect(tablasDelSql('INSERT INTO "StampEvent" (id) VALUES ($1)', PROTEGIDAS)).toEqual(['StampEvent'])
      expect(tablasDelSql('DELETE FROM ONLY public."CouponCode" WHERE id = $1', PROTEGIDAS)).toEqual(['CouponCode'])
      expect(tablasDelSql('SELECT id FROM "Customer" WHERE id = $1', PROTEGIDAS)).toEqual([])
    })

    it('`prisma.discount⏎  .update({…})` se detecta por el nodo (r4 #4) y falla por cliente global', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f(id: string) {\n  await prisma.discount\n    .update({ where: { id }, data: {} })\n}`,
      })
      expect(con(h, '(1)', 'discount.update')).toHaveLength(1)
    })

    it('`prisma.$transaction([prisma.customer.update(…)])` falla (r5 #3)', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f() { await prisma.$transaction([prisma.customer.update({ where: { id: 'c' }, data: {} })]) }`,
      })
      expect(con(h, '(4)', 'customer.update')).toHaveLength(1)
      expect(con(h, '(1)', 'customer.update')).toHaveLength(1)
    })

    it('`tx.discount.delete` con tx: Prisma.TransactionClient falla; con tx: TxConReintento pasa', () => {
      const crudo = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f(tx: Prisma.TransactionClient) { await tx.discount.delete({ where: { id: 'd' } }) }`,
      })
      expect(con(crudo, '(2)', 'discount.delete')).toHaveLength(1)
      const marcado = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f(tx: TxConReintento) { await tx.discount.delete({ where: { id: 'd' } }) }`,
      })
      expect(con(marcado, '(1)').concat(con(marcado, '(2)'))).toEqual([])
    })

    it('una función con `db = prisma` que escribe Customer falla', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f(id: string, db = prisma) { await db.customer.update({ where: { id }, data: {} }) }`,
      })
      expect(con(h, '(3)', 'customer.update')).toHaveLength(1)
      const conCast = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f(id: string, db: TxConReintento = prisma as any) { await db.customer.update({ where: { id }, data: {} }) }`,
      })
      expect(con(conCast, '(3)', 'customer.update')).toHaveLength(1)
    })

    it('el asesor del cupón y el SQL con candado cuentan como escritura, también con un tx sin marca', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}import { apartarCupon } from './b'\nexport async function f(tx: Prisma.TransactionClient) {\n  await apartarCupon(tx, 'v', {} as any, null)\n  await tx.$queryRaw\`SELECT id FROM "Customer" WHERE id = \${'c'} FOR NO KEY UPDATE\`\n}`,
        'src/b.ts': 'export async function apartarCupon(..._a: unknown[]) {}',
      })
      expect(con(h, '(2)', 'asesor del cupón apartarCupon')).toHaveLength(1)
      expect(con(h, '(2)', 'SQL sobre Customer')).toHaveLength(1)
    })

    it('un segundo `as TxConReintento` en src falla, y el listado pasa', () => {
      const cast = `${CLIENTE}export async function recordOrderPayment() { await prisma.$transaction(async tx => cuerpo(tx as TxConReintento)) }\nasync function cuerpo(_tx: TxConReintento) {}`
      const permitidos = {
        'src/services/tpv/payment.tpv.service.ts#recordOrderPayment': { cantidad: 1, motivo: 'excepción' },
      }
      const solo = hallazgos({ 'src/services/tpv/payment.tpv.service.ts': cast }, { castsPermitidos: permitidos })
      expect(con(solo, '(6)')).toEqual([])
      const doble = hallazgos({ 'src/services/tpv/payment.tpv.service.ts': cast, 'src/otro.ts': cast }, { castsPermitidos: permitidos })
      expect(con(doble, '(6)', 'src/otro.ts#recordOrderPayment')).toHaveLength(1)
    })

    it('una excepción cuyo efecto ya no está falla', () => {
      const cast = `${CLIENTE}export async function recordOrderPayment() { await prisma.$transaction(async tx => cuerpo(tx as TxConReintento)) }\nasync function cuerpo(_tx: TxConReintento) {}`
      const efectos = [{ archivo: 'src/registro.ts', funcion: 'consolidar', llamada: 'avisar' }]
      const permitidos = { 'src/p.ts#recordOrderPayment': { cantidad: 1, motivo: 'excepción', efectos } }
      const conEfecto = hallazgos(
        { 'src/p.ts': cast, 'src/registro.ts': 'export async function consolidar() { avisar() }\nfunction avisar() {}' },
        { castsPermitidos: permitidos },
      )
      expect(con(conEfecto, '(5)')).toEqual([])
      const sinEfecto = hallazgos(
        { 'src/p.ts': cast, 'src/registro.ts': 'export async function consolidar() {}' },
        { castsPermitidos: permitidos },
      )
      expect(con(sinEfecto, '(5)', 'ya no está')).toHaveLength(1)
    })

    it('un cuerpo que llama socketManager.emit, notifyCustomerPassUpdated o abre otra transacción falla (también por un import)', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}import { ayudante } from './b'\nexport async function f() {\n  await withDeadlockRetry(async tx => {\n    socketManager.emit('x')\n    await ayudante(tx)\n  }, { etiqueta: 'f' })\n}\ndeclare const socketManager: any`,
        'src/b.ts': `import { withDeadlockRetry } from '@/utils/serializableRetry'\nexport async function ayudante(tx: any) {\n  notifyCustomerPassUpdated('c')\n  await withDeadlockRetry(async () => 1, { etiqueta: 'otra' })\n}\ndeclare function notifyCustomerPassUpdated(c: string): void`,
      })
      expect(con(h, '(a)', 'socketManager.emit')).toHaveLength(1)
      expect(con(h, '(a)', 'notifyCustomerPassUpdated')).toHaveLength(1)
      expect(con(h, '(c)', 'withDeadlockRetry')).toHaveLength(1)
    })

    it('una llamada con nombre de efecto pero revisada (efectosRevisados: archivo#llamada) no falla; en otro archivo, sí', () => {
      const nombre = `${CLIENTE}export async function f() {\n  await withDeadlockRetry(async tx => {\n    await emitTierRewards(tx)\n  }, { etiqueta: 'f' })\n}\ndeclare function emitTierRewards(tx: any): Promise<void>`
      expect(con(hallazgos({ 'src/a.ts': nombre }), '(a)', 'emitTierRewards')).toHaveLength(1)
      expect(
        con(
          hallazgos({ 'src/a.ts': nombre }, { efectosRevisados: { 'src/a.ts#emitTierRewards': 'sólo escribe con tx' } }),
          '(a)',
          'emitTierRewards',
        ),
      ).toEqual([])
      expect(
        con(
          hallazgos({ 'src/b.ts': nombre }, { efectosRevisados: { 'src/a.ts#emitTierRewards': 'sólo escribe con tx' } }),
          '(a)',
          'emitTierRewards',
        ),
      ).toHaveLength(1)
    })

    it('messaging().send, canal.publish y sendX son efectos; sendero() no (sin /i: send + MAYÚSCULA)', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f() {\n  await withDeadlockRetry(async tx => {\n    await messaging().send({})\n    canal.publish('cola', 'x')\n    await sendPushToStaff('s')\n    sendero(1)\n  }, { etiqueta: 'f' })\n}\ndeclare const canal: any\ndeclare function messaging(): any\ndeclare function sendPushToStaff(s: string): Promise<void>\ndeclare function sendero(n: number): void`,
      })
      expect(con(h, '(a)', 'messaging().send')).toHaveLength(1)
      expect(con(h, '(a)', 'canal.publish')).toHaveLength(1)
      expect(con(h, '(a)', 'sendPushToStaff')).toHaveLength(1)
      expect(con(h, '(a)', 'sendero')).toEqual([])
    })

    it('`const { f } = await import(…)` y `(await import(…)).f(tx)` se siguen como un import (Ruling 22)', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f() {\n  await withDeadlockRetry(async tx => {\n    const { ayudante } = await import('./b')\n    await ayudante(tx)\n    await (await import('./c')).otro(tx)\n  }, { etiqueta: 'f' })\n}`,
        'src/b.ts': 'export async function ayudante(_tx: unknown) { setTimeout(() => 1, 5) }',
        'src/c.ts': 'export async function otro(_tx: unknown) { setImmediate(() => 1) }',
      })
      expect(con(h, '(a)', 'setTimeout')).toHaveLength(1)
      expect(con(h, '(a)', 'setImmediate')).toHaveLength(1)
    })

    it('un cuerpo con prisma.order.update o logAction sin tx falla', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}import { logAction } from './log'\nexport async function f() {\n  await withDeadlockRetry(async tx => {\n    await prisma.order.update({ where: { id: 'o' }, data: {} })\n    await logAction({ action: 'X' })\n    await logAction({ action: 'Y' }, tx)\n  }, { etiqueta: 'f' })\n}`,
        'src/log.ts': 'export async function logAction(..._a: unknown[]) {}',
      })
      expect(con(h, '(b)', 'prisma.order.update')).toHaveLength(1)
      expect(con(h, '(b)', 'logAction sin tx')).toHaveLength(1)
    })

    it('un cuerpo que hace afuera.push(x), afuera = x o afuera.y = x falla, aunque lo reinicie', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f() {\n  let afuera: any = []\n  const lista: number[] = []\n  await withDeadlockRetry(async tx => {\n    afuera = []\n    lista.push(1)\n    afuera.y = 2\n    const dentro: number[] = []\n    dentro.push(1)\n    return dentro\n  }, { etiqueta: 'f' })\n}`,
      })
      expect(con(h, '(d)', '«afuera»')).toHaveLength(1)
      expect(con(h, '(d)', '«lista.push»')).toHaveLength(1)
      expect(con(h, '(d)', '«afuera.y»')).toHaveLength(1)
      expect(con(h, '(d)', '«dentro.push»')).toEqual([])
    })

    it('unshift, pop, shift, clear y Object.assign(afuera, …) también escriben afuera (m5)', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f() {\n  const lista: number[] = []\n  const mapa = new Map()\n  const estado = { x: 0 }\n  await withDeadlockRetry(async tx => {\n    lista.unshift(1)\n    lista.pop()\n    lista.shift()\n    mapa.clear()\n    Object.assign(estado, { x: 1 })\n    Object.assign({}, estado)\n  }, { etiqueta: 'f' })\n}`,
      })
      for (const escrito of ['«lista.unshift»', '«lista.pop»', '«lista.shift»', '«mapa.clear»', '«estado»'])
        expect(con(h, '(d)', escrito)).toHaveLength(1)
      expect(con(h, '(d)')).toHaveLength(5)
    })

    it('el cuerpo por nombre también se revisa (la asignación a `revertida`)', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function reverse() {\n  let revertida = false\n  const dentroDelCandado = async (tx: TxConReintento) => { revertida = true }\n  await withDeadlockRetry(dentroDelCandado, { etiqueta: 'reverse' })\n  return revertida\n}`,
      })
      expect(con(h, '(d)', '«revertida»')).toHaveLength(1)
    })

    it('un cuerpo que pasa afuera a una función que hace param.push falla (r5 #2)', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}import { aplicar } from './b'\nexport async function f() {\n  const audits: string[] = []\n  await withDeadlockRetry(async tx => { await aplicar(tx, audits) }, { etiqueta: 'f' })\n  const locales = 1\n}`,
        'src/b.ts': 'export async function aplicar(_tx: unknown, audits: string[]) { audits.push("x") }',
      })
      expect(con(h, '(e)', '«audits»')).toHaveLength(1)
      const dentro = hallazgos({
        'src/a.ts': `${CLIENTE}import { aplicar } from './b'\nexport async function f() {\n  return withDeadlockRetry(async tx => { const audits: string[] = []; await aplicar(tx, audits); return audits }, { etiqueta: 'f' })\n}`,
        'src/b.ts': 'export async function aplicar(_tx: unknown, audits: string[]) { audits.push("x") }',
      })
      expect(con(dentro, '(e)')).toEqual([])
      const conAssign = hallazgos({
        'src/a.ts': `${CLIENTE}import { aplicar } from './b'\nexport async function f() {\n  const estado = { n: 0 }\n  await withDeadlockRetry(async tx => { await aplicar(tx, estado) }, { etiqueta: 'f' })\n}`,
        'src/b.ts': 'export async function aplicar(_tx: unknown, estado: { n: number }) { Object.assign(estado, { n: 1 }) }',
      })
      expect(con(conAssign, '(e)', '«estado»')).toHaveLength(1)
      const reasigna = hallazgos({
        'src/a.ts': `${CLIENTE}import { aplicar } from './b'\nexport async function f() {\n  const estado = { n: 0 }\n  await withDeadlockRetry(async tx => { await aplicar(tx, estado) }, { etiqueta: 'f' })\n}`,
        'src/b.ts': 'export async function aplicar(_tx: unknown, estado: { n: number }) { estado = { n: 1 }; return estado }',
      })
      expect(con(reasigna, '(e)')).toEqual([])
    })

    it('una función que recibe tx y llama withDeadlockRetry falla; la rama sin tx de una función revisada pasa (Ruling 21)', () => {
      const codigo = {
        'src/a.ts': `${CLIENTE}export async function f(tx?: TxConReintento) {\n  if (tx) return 1\n  return withDeadlockRetry(async t => 2, { etiqueta: 'f' })\n}`,
      }
      expect(con(hallazgos(codigo), '(7)')).toHaveLength(1)
      expect(con(hallazgos(codigo, { cuerposRevisados: { 'src/a.ts#f': 'abre la suya sólo si no le dan tx' } }), '(7)')).toEqual([])
    })

    it('el opener genérico del JSON (executeHttpOperation) cuenta como cuerpo: su tx pasa y su cuerpo se revisa (Ruling 16)', () => {
      const h = hallazgos({
        'src/c.ts': `import { executeHttpOperation } from './h'\nexport async function handler() {\n  let auditData: unknown\n  await executeHttpOperation({}, async tx => {\n    await tx.customer.update({ where: { id: 'c' }, data: {} })\n    auditData = 1\n  })\n}`,
        'src/h.ts': 'export async function executeHttpOperation(_i: unknown, _m: unknown) {}',
      })
      expect(con(h, '(2)', 'customer.update')).toEqual([])
      expect(con(h, '(d)', '«auditData»')).toHaveLength(1)
    })
  })

  describe('inventario y aperturas', () => {
    const escritor = {
      'src/a.ts': `${CLIENTE}export async function f(tx: TxConReintento) { await tx.customer.update({ where: { id: 'c' }, data: {} }) }`,
    }

    it('una escritura nueva sin entrada en el JSON falla; con su entrada pasa', () => {
      expect(con(hallazgos(escritor), 'inventario', 'falta en escritores "src/a.ts#f"')).toHaveLength(1)
      expect(con(hallazgos(escritor, { escritores: { 'src/a.ts#f': { clase: 'EN_TX', etiqueta: 'f' } } }), 'inventario')).toEqual([])
    })

    it('una entrada que ya no existe falla', () => {
      const h = hallazgos(escritor, {
        escritores: { 'src/a.ts#f': { clase: 'EN_TX', etiqueta: 'f' }, 'src/a.ts#vieja': { clase: 'SENTENCIA', etiqueta: 'vieja' } },
      })
      expect(con(h, 'inventario', 'src/a.ts#vieja ya no escribe')).toHaveLength(1)
    })

    it('cada apertura está en el JSON con su etiqueta, su cantidad y si es serializable', () => {
      const codigo = {
        'src/a.ts': `${CLIENTE}export async function f() {\n  await withDeadlockRetry(async tx => tx.customer.update({ where: { id: 'c' }, data: {} }), { etiqueta: 'f' })\n  await withSerializableRetry(async tx => 1, { reintentarInterbloqueo: true, etiqueta: 'f' })\n}`,
      }
      expect(con(hallazgos(codigo), 'aperturas', 'falta "src/a.ts#f"')).toHaveLength(1)
      expect(
        con(hallazgos(codigo, { aperturas: { 'src/a.ts#f': { etiqueta: 'f', cantidad: 2, serializable: true } } }), 'aperturas'),
      ).toEqual([])
      expect(
        con(hallazgos(codigo, { aperturas: { 'src/a.ts#f': { etiqueta: 'otra', cantidad: 2, serializable: true } } }), 'aperturas'),
      ).toHaveLength(1)
      expect(
        con(hallazgos({}, { aperturas: { 'src/a.ts#g': { etiqueta: 'g', cantidad: 1 } } }), 'aperturas', 'en el código 0'),
      ).toHaveLength(1)
    })
  })

  describe('escritores indirectos (r6 #1)', () => {
    it('con un esquema de juguete, una relación opcional sin onDelete hacia Customer vuelve padre a su modelo, y uno que llega por una cadena de Cascade también', () => {
      const { padres } = padresDerivados(ESQUEMA_DE_JUGUETE)
      expect(padres).toEqual(PADRES_DE_JUGUETE)
      expect(padres).toContain('Grupo') // Customer.grupo, opcional sin onDelete = SetNull
      expect(padres).toContain('Abuelo') // Abuelo → Grupo en Cascade
      expect(padres).not.toContain('Customer') // ya es protegida
      expect(padres).not.toContain('Bitacora') // Restrict: borrarla no toca Customer
    })

    it('un modelo padre nuevo que no está en padresConAccionReferencial tumba la prueba', () => {
      const conMesa =
        ESQUEMA_DE_JUGUETE.replace(
          '  grupoId String?',
          '  mesaId  String?\n  mesa    Mesa?   @relation(fields: [mesaId], references: [id])\n  grupoId String?',
        ) + '\nmodel Mesa {\n  id String @id\n}\n'
      expect(padresDerivados(conMesa).padres).toContain('Mesa')
      expect(revisar(archivos({}), conMesa, juguete()).filter(h => h.startsWith('(8)'))).toHaveLength(1)
      expect(revisar(archivos({}), ESQUEMA_DE_JUGUETE, juguete()).filter(h => h.startsWith('(8)'))).toEqual([])
    })

    it('tx.staffVenue.delete con tx: Prisma.TransactionClient dentro de un prisma.$transaction crudo falla', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f() { await prisma.$transaction(async (tx: Prisma.TransactionClient) => { await tx.staffVenue.delete({ where: { id: 's' } }) }) }`,
      })
      expect(con(h, '(2)', 'staffVenue.delete (escritura indirecta)')).toHaveLength(1)
    })

    it('prisma.staffVenue.deleteMany con el cliente global falla, y el SQL DELETE FROM "Order" también', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f() {\n  await prisma.staffVenue.deleteMany({})\n  await prisma.$executeRaw\`DELETE FROM "Order" WHERE id = \${'o'}\`\n}`,
      })
      expect(con(h, '(1)', 'staffVenue.deleteMany')).toHaveLength(1)
      expect(con(h, '(1)', 'Order (indirecta)')).toHaveLength(1)
    })

    it('con tx: TxConReintento dentro de withDeadlockRetry pasa', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f() { await withDeadlockRetry(async tx => { await tx.staffVenue.delete({ where: { id: 's' } }) }, { etiqueta: 'f' }) }`,
      })
      expect([...con(h, '(1)'), ...con(h, '(2)'), ...con(h, '(3)')]).toEqual([])
    })

    it('order.update que cambia id falla igual que un borrado; uno que no toca la llave no es escritura', () => {
      const h = hallazgos({
        'src/a.ts': `${CLIENTE}export async function f(tx: Prisma.TransactionClient) {\n  await tx.order.update({ where: { id: 'o' }, data: { id: 'o2' } })\n  await tx.order.update({ where: { id: 'o' }, data: { total: 1 } })\n}`,
      })
      expect(con(h, '(2)', 'order.update cambia la llave')).toHaveLength(1)
      expect(h.filter(x => x.includes('order.update'))).toHaveLength(1)
    })
  })

  describe('el JSON', () => {
    it('los padres con acción referencial de schema.prisma son los del JSON', () => {
      expect(padresDerivados(SCHEMA()).padres).toEqual([...revisado.padresConAccionReferencial].sort())
    })

    it('la semilla está completa: clases válidas, etiquetas, aperturas y los casts permitidos con sus efectos', () => {
      for (const [k, e] of Object.entries(revisado.escritores)) {
        expect([k, ['EN_TX', 'SENTENCIA'].includes(e.clase)]).toEqual([k, true])
        expect([k, e.etiqueta.length > 0]).toEqual([k, true])
      }
      for (const [k, a] of Object.entries(revisado.aperturas)) expect([k, a.cantidad > 0 && a.etiqueta.length > 0]).toEqual([k, true])
      expect(Object.keys(revisado.castsPermitidos).sort()).toEqual([
        'src/services/tpv/payment.tpv.service.ts#recordOrderPayment',
        'src/utils/serializableRetry.ts#withDeadlockRetry',
        'src/utils/serializableRetry.ts#withSerializableRetry',
      ])
      expect(revisado.castsPermitidos['src/services/tpv/payment.tpv.service.ts#recordOrderPayment'].efectos?.length).toBeGreaterThan(0)
      expect(Object.keys(revisado.openersGenericos)).toContain('src/services/mobile/http-operation.mobile.service.ts#executeHttpOperation')
    })
  })

  // 🔴 Paso 8: `corridaSobreSrc: true` en el JSON. Antes, todo `src/` sale rojo: nada usa todavía el reintento.
  ;(revisado.corridaSobreSrc ? it : it.skip)('src completo: escrituras, transacciones, cuerpos e inventario', () => {
    const h = revisar(fuentesDeSrc(), SCHEMA(), revisado)
    if (h.length)
      throw new Error(
        'Red por traba (S5b): toda escritura o candado de Discount, CouponCode, CouponRedemption, StampReward, StampCard, StampEvent, ' +
          'Customer, LoyaltyTransaction o GiftCard corre dentro de withDeadlockRetry, y su cuerpo no tiene efectos fuera de la base. ' +
          `Clasifica lo nuevo en ordenDeCandadosParte2.reviewed.json.\n${h.length} hallazgos:\n${h.join('\n')}`,
      )
  })
})
