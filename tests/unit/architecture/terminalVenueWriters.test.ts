/**
 * Pantalla del cliente F0-A (spec §5.1, reconstrucción del 14-oct, v2): todo escritor de `Terminal.venueId` llama, dentro de
 * su transacción y ANTES de escribir, a `borrarDisenoAlCambiarDeNegocio`, y el servidor invalida la caché de la ficha tras el
 * commit. Es una red de INVENTARIO (como `orderCancelWriters.test.ts`), no una prueba formal: sin el checker de tipos, lo que
 * no se puede leer (un `data` variable) se inventaría por nombre con su motivo. Un escritor nuevo —directo, anidado desde
 * otro modelo a cualquier profundidad, en SQL crudo o en una migración— tumba esta prueba con su archivo y línea hasta que
 * alguien lo clasifique. La atomicidad NO se prueba aquí: la prueban las integraciones de las Tasks 8 y 9.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const RAIZ = path.join(__dirname, '../../..')
const GANCHO = 'borrarDisenoAlCambiarDeNegocio'
const INVALIDAR = 'invalidateCustomerDisplayCache'
const ESCRITURAS_DE_TERMINAL = new Set(['update', 'updateMany', 'updateManyAndReturn', 'upsert'])
const ESCRITURAS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert'])
/** Anidadas que mudan una terminal existente. `create` es un alta; `terminal: { connect }` desde un hijo sólo liga al hijo. */
const MUEVEN_DESDE_EL_PADRE = new Set(['connect', 'connectOrCreate', 'set', 'disconnect', 'update', 'updateMany', 'upsert'])
const MUEVEN_DESDE_UN_HIJO = new Set(['update', 'upsert'])

type Clase = 'VENUE' | 'OPACO' | 'ANIDADO' | 'SQL' | 'LIMPIA'
interface Hallazgo {
  sitio: string
  linea: number
  clase: Clase
  inicio: number
}
interface Llamada {
  sitio: string
  nombre: string
  inicio: number
}
interface Lectura {
  llaves: string[]
  opaco: boolean
}

function archivos(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return ['node_modules', '__tests__'].includes(e.name) ? [] : archivos(p)
    const rel = path.relative(RAIZ, p).split(path.sep).join('/')
    if (/^scripts\/temp-/.test(rel)) return [] // .gitignore: scripts locales de una sesión (los 2 versionados sólo crean)
    if (rel.startsWith('prisma/migrations/')) return e.name === 'migration.sql' ? [p] : []
    return /\.(ts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

const sinEnvoltura = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) ||
  ts.isAsExpression(e) ||
  ts.isNonNullExpression(e) ||
  ts.isSatisfiesExpression(e) ||
  ts.isTypeAssertionExpression(e)
    ? sinEnvoltura(e.expression)
    : e
const nombreDePropiedad = (n: ts.PropertyName) => n.getText().replace(/['"`]/g, '')
function propiedad(o: ts.ObjectLiteralExpression, nombre: string): ts.Expression | undefined {
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && nombreDePropiedad(p.name) === nombre) return p.initializer
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === nombre) return p.name
  }
  return undefined
}
const unir = (a: Lectura, b: Lectura): Lectura => ({ llaves: [...a.llaves, ...b.llaves], opaco: a.opaco || b.opaco })
const VACIO: Lectura = { llaves: [], opaco: false }

/** Las llaves de un payload. Ternarios y `&&`/`??`/`||` se resuelven ANTES de rechazar lo que no es objeto (Codex r1, #2). */
function llaves(e: ts.Expression): Lectura {
  const o = sinEnvoltura(e)
  if (ts.isConditionalExpression(o)) return unir(llaves(o.whenTrue), llaves(o.whenFalse))
  if (ts.isBinaryExpression(o)) {
    if (o.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return llaves(o.right)
    if (o.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || o.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      return unir(llaves(o.left), llaves(o.right))
  }
  if (o.kind === ts.SyntaxKind.NullKeyword || o.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(o) && o.text === 'undefined'))
    return VACIO
  if (!ts.isObjectLiteralExpression(o)) return { llaves: [], opaco: true }
  let r = VACIO
  for (const p of o.properties) {
    if (ts.isSpreadAssignment(p)) r = unir(r, llaves(p.expression))
    else if (!p.name || ts.isComputedPropertyName(p.name)) r = { ...r, opaco: true }
    else r = { ...r, llaves: [...r.llaves, nombreDePropiedad(p.name)] }
  }
  return r
}

/** ¿El payload muda una terminal por una escritura anidada, a CUALQUIER profundidad? (Codex r1, #3) */
function anidadoQueMueve(e: ts.Expression): boolean {
  const o = sinEnvoltura(e)
  if (ts.isConditionalExpression(o)) return anidadoQueMueve(o.whenTrue) || anidadoQueMueve(o.whenFalse)
  if (ts.isBinaryExpression(o)) return anidadoQueMueve(o.left) || anidadoQueMueve(o.right)
  if (ts.isArrayLiteralExpression(o)) return o.elements.some(x => anidadoQueMueve(x))
  if (!ts.isObjectLiteralExpression(o)) return false
  for (const p of o.properties) {
    if (ts.isSpreadAssignment(p)) {
      if (anidadoQueMueve(p.expression)) return true
      continue
    }
    if (!ts.isPropertyAssignment(p)) continue
    const k = nombreDePropiedad(p.name)
    const mueven = k === 'terminals' ? MUEVEN_DESDE_EL_PADRE : k === 'terminal' ? MUEVEN_DESDE_UN_HIJO : null
    if (mueven) {
      // `llaves()` también resuelve `c ? { connect } : {}` y `c && { set: [] }` (Codex r2). Una relación `terminals`
      // ilegible se acusa: puede mudar terminales.
      const r = llaves(p.initializer)
      if (r.llaves.some(op => mueven.has(op)) || (k === 'terminals' && r.opaco)) return true
    }
    if (anidadoQueMueve(p.initializer)) return true
  }
  return false
}

/** Sentencias `UPDATE "Terminal" … SET … venueId = …`, sin contar comentarios. Devuelve dónde empieza cada una. */
function sqlQueMueve(texto: string): number[] {
  const limpio = texto.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  const re =
    /\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?Terminal"?(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\b([\s\S]*?)(?=\bFROM\b|\bWHERE\b|\bRETURNING\b|;|$)/gi
  return [...limpio.matchAll(re)].filter(m => /(?:^|[\s,(.])"?venueId"?\s*=/i.test(m[1])).map(m => m.index!)
}

/** Funciones con nombre: declaraciones, métodos, expresiones nombradas, y flechas o expresiones asignadas a una variable.
 *  Un callback anónimo (el de `$transaction`, el de `writeScopedTerminal`, un `map`) es transparente: cuenta como parte de
 *  la función que lo contiene. */
function nombrePropio(x: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x)) && x.name) return x.name.text
  if (ts.isMethodDeclaration(x))
    return `${ts.isClassDeclaration(x.parent) && x.parent.name ? `${x.parent.name.text}.` : ''}${x.name.getText()}`
  if ((ts.isArrowFunction(x) || ts.isFunctionExpression(x)) && ts.isVariableDeclaration(x.parent) && ts.isIdentifier(x.parent.name))
    return x.parent.name.text
  return undefined
}
/** El dueño es la función con nombre MÁS CERCANA (Codex r2): un gancho dentro de una función interna que nunca se llama no
 *  protege la escritura de la de afuera. Se escribe con la cadena completa (`afuera.adentro`). */
function duenoDe(n: ts.Node): string {
  const nombres: string[] = []
  for (let x: ts.Node | undefined = n.parent; x && !ts.isSourceFile(x); x = x.parent) {
    const nombre = nombrePropio(x)
    if (nombre) nombres.unshift(nombre)
  }
  return nombres.length ? nombres.join('.') : '(módulo)'
}
const lineaDe = (texto: string, i: number) => texto.slice(0, i).split('\n').length

export function revisar(archivo: string, texto: string): { hallazgos: Hallazgo[]; llamadas: Llamada[] } {
  if (archivo.endsWith('.sql'))
    return {
      hallazgos: sqlQueMueve(texto).map(i => ({ sitio: `${archivo}#(sql)`, linea: lineaDe(texto, i), clase: 'SQL' as const, inicio: i })),
      llamadas: [],
    }
  const sf = ts.createSourceFile(
    archivo,
    texto,
    ts.ScriptTarget.Latest,
    true,
    archivo.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  )
  const hallazgos: Hallazgo[] = []
  const llamadas: Llamada[] = []
  const sitioDe = (n: ts.Node) => `${archivo}#${duenoDe(n)}`
  const anotar = (n: ts.Node, clase: Clase) =>
    hallazgos.push({ sitio: sitioDe(n), linea: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, clase, inicio: n.getStart() })
  const visitar = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const nombre = ts.isIdentifier(n.expression)
        ? n.expression.text
        : ts.isPropertyAccessExpression(n.expression)
          ? n.expression.name.text
          : ''
      // El gancho y la invalidación cuentan como LLAMADAS reales, nunca como texto (un comentario no cuenta) — Codex r1, #3.
      if (nombre === GANCHO || nombre === INVALIDAR) llamadas.push({ sitio: sitioDe(n), nombre, inicio: n.getStart() })
      if (ts.isPropertyAccessExpression(n.expression) && ESCRITURAS.has(nombre) && n.arguments[0]) {
        const receptor = n.expression.expression
        const modelo = ts.isPropertyAccessExpression(receptor) ? receptor.name.text : ''
        const arg = sinEnvoltura(n.arguments[0])
        if (modelo === 'terminal' && ESCRITURAS_DE_TERMINAL.has(nombre)) {
          // `data` (o el `update` del upsert). Un argumento que no es objeto, un `data` abreviado o un `{ ...args }` sin
          // `data` visible no se pueden leer: OPACO.
          const valor = ts.isObjectLiteralExpression(arg) ? propiedad(arg, nombre === 'upsert' ? 'update' : 'data') : arg
          const conEsparcido = ts.isObjectLiteralExpression(arg) && arg.properties.some(ts.isSpreadAssignment)
          if (valor || conEsparcido) {
            const r = valor ? llaves(valor) : { llaves: [], opaco: true }
            anotar(n, r.llaves.includes('venueId') || r.llaves.includes('venue') ? 'VENUE' : r.opaco ? 'OPACO' : 'LIMPIA')
          }
        }
        if (ts.isObjectLiteralExpression(arg))
          for (const p of arg.properties)
            if (
              ts.isPropertyAssignment(p) &&
              ['data', 'create', 'update'].includes(nombreDePropiedad(p.name)) &&
              anidadoQueMueve(p.initializer)
            )
              anotar(n, 'ANIDADO')
      }
    }
    if (
      (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n) || ts.isTemplateExpression(n)) &&
      sqlQueMueve(n.getText()).length > 0
    )
      anotar(n, 'SQL')
    ts.forEachChild(n, visitar)
  }
  visitar(sf)
  return { hallazgos, llamadas }
}

const llamaAntes = (h: Hallazgo, llamadas: Llamada[], nombre: string) =>
  llamadas.some(l => l.sitio === h.sitio && l.nombre === nombre && l.inicio < h.inicio)

/** §4.1 del plan del 14-oct. Cambiar esta lista exige decir por qué, y que el escritor llame al gancho. */
const ESCRITORES: Record<string, string> = {
  'src/services/dashboard/terminals.superadmin.service.ts#updateTerminal':
    'migración con protocolo < 2: el negocio cambia al encolar el borrado',
  'src/services/tpv/command-queue.service.ts#TpvCommandQueueService.updateCommandStatus':
    'migración con protocolo 2: el negocio cambia cuando la TPV pide ejecutar el borrado',
  'src/services/dashboard/terminal-migration.service.ts#migrateCancel': 'cancelar una migración regresa la terminal a su origen (con G4)',
  'src/services/dashboard/terminal-migration.service.ts#migrateDiscard':
    'descartar un borrado de migración sin ejecutar regresa la terminal a su origen (con G4)',
  'scripts/separar-cubre-descanso-zonas.ts#main': 'traslado puntual de PlayTelecom, ya ejecutado e idempotente',
}
/** Otro proceso: no comparte la caché de la ficha con el servidor. */
const SIN_INVALIDAR = new Set(['scripts/separar-cubre-descanso-zonas.ts#main'])

/** Escrituras de terminal con un payload que el escáner no puede leer: cada una dice por qué no toca el negocio. */
const OPACOS: Record<string, string> = {
  'scripts/backfill-terminal-device-attrs.ts#backfill':
    '`data` = { formFactor, modelIdentifier, osVersion }, armado justo antes de escribir',
  'src/services/dashboard/tpv.dashboard.service.ts#updateTpv':
    '`data` se arma campo por campo con UPDATABLE_TPV_FIELDS (auditoría D1, 16-sep): venueId no está',
  'src/services/display-mode-request.service.ts#runAuditedCasTransition':
    '`data` sólo toca customerDisplayInverted y customerDisplayRequest* (invertir pantallas)',
  'src/services/tpv/command-queue.service.ts#TpvCommandQueueService.updateTerminalStateForCommand':
    '`updates` sólo lleva el estado que deja un comando: isLocked, lock* y status',
  'src/services/tpv/tpv-health.service.ts#TpvHealthService.acknowledgeCommand':
    '`updateData` y `syncUpdateData` sólo llevan status, isLocked, lock* y la activación remota',
}

describe('el escáner (si estos fallan, el inventario no vale)', () => {
  const clases = (codigo: string, archivo = 'caso.ts') => revisar(archivo, codigo).hallazgos.map(h => h.clase)
  it.each([
    ['venueId literal', `tx.terminal.update({ where: { id }, data: { venueId: 'b' } })`, 'VENUE', 'caso.ts'],
    ['venue anidado', `prisma.terminal.update({ where: { id }, data: { venue: { connect: { id: 'b' } } } })`, 'VENUE', 'caso.ts'],
    ['esparcido condicional', `tx.terminal.update({ where: { id }, data: { ...(mover && { venueId: b }) } })`, 'VENUE', 'caso.ts'],
    ['ternario como data', `tx.terminal.updateMany({ where: { id }, data: x ? { venueId: b } : { name } })`, 'VENUE', 'caso.ts'],
    ['nullish', `tx.terminal.update({ where: { id }, data: cambios ?? { venueId: b } })`, 'VENUE', 'caso.ts'],
    ['upsert', `db.terminal.upsert({ where: { id }, update: { venueId: b }, create: { venueId: b, name } })`, 'VENUE', 'caso.ts'],
    ['data abreviado', `tx.terminal.update({ where: { id }, data })`, 'OPACO', 'caso.ts'],
    ['esparcido de variable', `tx.terminal.update({ where: { id }, data: { ...cambios } })`, 'OPACO', 'caso.ts'],
    ['argumento entero variable', `tx.terminal.update(args)`, 'OPACO', 'caso.ts'],
    ['argumento esparcido', `tx.terminal.update({ ...args })`, 'OPACO', 'caso.ts'],
    ['desde el negocio', `tx.venue.update({ where: { id }, data: { terminals: { connect: { id: t } } } })`, 'ANIDADO', 'caso.ts'],
    [
      'anidado profundo',
      `tx.organization.update({ where: { id }, data: { venues: { update: { where: { id: v }, data: { terminals: { set: [] } } } } } })`,
      'ANIDADO',
      'caso.ts',
    ],
    ['desde un hijo', `tx.tpvCommandQueue.update({ where: { id }, data: { terminal: { update: { venueId: b } } } })`, 'ANIDADO', 'caso.ts'],
    [
      'relación en un ternario',
      `tx.venue.update({ where: { id: destino }, data: { terminals: condicion ? { connect: { id: terminalId } } : {} } })`,
      'ANIDADO',
      'caso.ts',
    ],
    ['relación ilegible', `tx.venue.update({ where: { id }, data: { terminals: relacion } })`, 'ANIDADO', 'caso.ts'],
    ['SQL crudo', 'tx.$executeRaw`UPDATE "Terminal" SET "venueId" = ${b} WHERE id = ${t}`', 'SQL', 'caso.ts'],
    [
      'SQL con alias',
      'tx.$executeRawUnsafe(\'UPDATE "Terminal" t SET "name" = $1, "venueId" = $2 WHERE t.id = $3\', a, b, c)',
      'SQL',
      'caso.ts',
    ],
    ['archivo .sql', 'UPDATE "Terminal"\nSET "venueId" = \'v2\'\nWHERE "id" = \'t1\';', 'SQL', 'prisma/migrations/x/migration.sql'],
    ['script .js', 'async function f(){ await prisma.terminal.update({ where: { id }, data: { venueId: b } }) }', 'VENUE', 'scripts/x.js'],
  ])('CAZA: %s', (_caso, codigo, clase, archivo) => expect(clases(codigo, archivo)).toContain(clase))
  it.each([
    ['otra columna', `tx.terminal.update({ where: { id, venueId }, data: { name: 'x' } })`, 'caso.ts'],
    ['ternario con undefined', `tx.terminal.update({ where: { id }, data: { ...(x ? { name } : undefined) } })`, 'caso.ts'],
    ['alta', `tx.terminal.create({ data: { venueId, name } })`, 'caso.ts'],
    ['alta anidada', `tx.venue.create({ data: { name, terminals: { create: [{ name }] } } })`, 'caso.ts'],
    [
      'relación en un ternario que sólo crea',
      `tx.venue.update({ where: { id }, data: { terminals: c ? { create: [{ name }] } : undefined } })`,
      'caso.ts',
    ],
    ['hijo que se liga', `tx.tpvCommandQueue.create({ data: { terminal: { connect: { id: t } }, commandType: 'LOCK' } })`, 'caso.ts'],
    [
      'filtro por relación',
      `tx.tpvCommandQueue.updateMany({ where: { terminal: { venueId: v } }, data: { status: 'EXPIRED' } })`,
      'caso.ts',
    ],
    ['lectura', `tx.terminal.findMany({ where: { venueId }, take: 10 })`, 'caso.ts'],
    ['SQL de candado', 'tx.$queryRaw`SELECT id, "venueId" FROM "Terminal" WHERE id = ${t} FOR UPDATE`', 'caso.ts'],
    ['SQL que filtra por negocio', 'tx.$executeRaw`UPDATE "Terminal" SET "brand" = ${b} WHERE "venueId" = ${v}`', 'caso.ts'],
    ['otra tabla', 'tx.$executeRaw`UPDATE "TerminalHealth" SET "venueId" = ${v}`', 'caso.ts'],
    [
      'sólo un comentario',
      `// tx.terminal.update({ where: { id }, data: { venueId: b } })\n/* UPDATE "Terminal" SET "venueId" = 1 */\nconst x = 1`,
      'caso.ts',
    ],
    ['comentario en .sql', '-- UPDATE "Terminal" SET "venueId" = 1;\nSELECT 1;', 'prisma/migrations/y/migration.sql'],
  ])('NO acusa: %s', (_caso, codigo, archivo) => expect(clases(codigo, archivo).filter(c => c !== 'LIMPIA')).toEqual([]))

  const ganchoAntesDeTodas = (codigo: string) => {
    const { hallazgos, llamadas } = revisar('caso.ts', codigo)
    return hallazgos.filter(h => h.clase === 'VENUE').every(h => llamaAntes(h, llamadas, GANCHO))
  }
  it.each([
    [
      'gancho real antes',
      `async function mover(tx){ await borrarDisenoAlCambiarDeNegocio(tx, c); await tx.terminal.update({ where: { id }, data: { venueId: b } }) }`,
      true,
    ],
    [
      'gancho sólo en un comentario',
      `async function mover(tx){ /* borrarDisenoAlCambiarDeNegocio( */ await tx.terminal.update({ where: { id }, data: { venueId: b } }) }`,
      false,
    ],
    [
      'gancho después',
      `async function mover(tx){ await tx.terminal.update({ where: { id }, data: { venueId: b } }); await borrarDisenoAlCambiarDeNegocio(tx, c) }`,
      false,
    ],
    [
      'gancho en otra función',
      `async function otra(tx){ await borrarDisenoAlCambiarDeNegocio(tx, c) }\nasync function mover(tx){ await tx.terminal.update({ where: { id }, data: { venueId: b } }) }`,
      false,
    ],
    [
      'gancho en una función interna que nunca se llama',
      `async function mover(tx){ async function nunca(){ await borrarDisenoAlCambiarDeNegocio(tx, c) } await tx.terminal.update({ data: { venueId: destino } }) }`,
      false,
    ],
    [
      'gancho en una flecha interna con nombre',
      `async function mover(tx){ const nunca = async () => { await borrarDisenoAlCambiarDeNegocio(tx, c) }; await tx.terminal.update({ data: { venueId: destino } }) }`,
      false,
    ],
    [
      'callback transaccional anónimo',
      `async function mover(){ await prisma.$transaction(async tx => { await borrarDisenoAlCambiarDeNegocio(tx, c); await tx.terminal.update({ where: { id }, data: { venueId: b } }) }) }`,
      true,
    ],
    [
      'dentro de writeScopedTerminal',
      `async function mover(){ await writeScopedTerminal(() => prisma.$transaction(async tx => { await borrarDisenoAlCambiarDeNegocio(tx, c); await tx.terminal.update({ where: { id }, data: { venueId: b } }) }), 'x') }`,
      true,
    ],
    [
      'método de clase',
      `class S { async mover(tx){ await borrarDisenoAlCambiarDeNegocio(tx, c); await tx.terminal.updateMany({ where: { id }, data: { venueId: b } }) } }`,
      true,
    ],
  ])('el gancho cuenta sólo como llamada real y anterior: %s', (_caso, codigo, esperado) =>
    expect(ganchoAntesDeTodas(codigo)).toBe(esperado),
  )
})

describe('Terminal.venueId: cada escritor pasa por el gancho de la pantalla del cliente (spec §5.1)', () => {
  let hallazgos: Hallazgo[] = []
  let llamadas: Llamada[] = []
  // En un beforeAll y no en el cuerpo del describe: así cuenta el tope de tiempo (con la Mac en carga 90, 2,686 archivos ≈ 10 s).
  beforeAll(() => {
    const resultados = ['src', 'scripts', 'prisma']
      .flatMap(d => archivos(path.join(RAIZ, d)))
      .map(f => revisar(path.relative(RAIZ, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')))
    hallazgos = resultados.flatMap(r => r.hallazgos)
    llamadas = resultados.flatMap(r => r.llamadas)
  }, 120_000)
  const de = (clase: Clase) => hallazgos.filter(h => h.clase === clase)
  const sitios = (clase: Clase) => [...new Set(de(clase).map(h => h.sitio))].sort()

  it('el escáner ve el repo (si esto baja, se rompió el escáner, no el código)', () => {
    expect(de('LIMPIA').length).toBeGreaterThanOrEqual(35) // 14-oct (21f992e53): 41 en develop; 42 con el gancho
  })
  it('cada escritura de Terminal.venueId está inventariada — ninguna nueva sin clasificar', () => {
    expect(sitios('VENUE')).toEqual(Object.keys(ESCRITORES).sort())
  })
  it.each(Object.keys(ESCRITORES))('%s llama al gancho ANTES de escribir el negocio (y el servidor invalida la caché)', sitio => {
    for (const h of de('VENUE').filter(x => x.sitio === sitio)) {
      expect({ sitio, linea: h.linea, ganchoAntes: llamaAntes(h, llamadas, GANCHO) }).toMatchObject({ ganchoAntes: true })
      if (!SIN_INVALIDAR.has(sitio)) expect(llamadas.some(l => l.sitio === sitio && l.nombre === INVALIDAR)).toBe(true)
    }
  })
  it('cada escritura opaca está inventariada con su motivo', () => {
    expect(sitios('OPACO')).toEqual(Object.keys(OPACOS).sort())
    for (const motivo of Object.values(OPACOS)) expect(motivo.length).toBeGreaterThan(40)
  })
  it('nadie mueve una terminal desde otro modelo, con SQL crudo ni en una migración', () => {
    expect(de('ANIDADO').map(h => `${h.sitio}:${h.linea}`)).toEqual([])
    expect(de('SQL').map(h => `${h.sitio}:${h.linea}`)).toEqual([])
  })
})
