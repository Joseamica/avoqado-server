/**
 * Candado estático de la B del soporte por WhatsApp: el permiso de «datos por WhatsApp» (la aceptación del aviso y el
 * desbloqueo del día) tiene UN solo escritor, la ruta del panel con sesión fuerte. Ni el router, ni el worker, ni la entrega,
 * ni un aviso de Meta lo escriben. Un escritor nuevo en cualquier archivo de `src/` hace fallar esta prueba.
 *
 * Al revés de una lista de escritores (que siempre se queda corta): fuera del escritor, sobre estos modelos sólo se LEE. Con el
 * compilador de TypeScript, cada mención del delegado (`tx.supportDataUnlock`, `tx?.…`, `tx['…']`) tiene que ser la llamada directa
 * a un lector (`find*`, `count`, `aggregate`, `groupBy`); cualquier otra (`create`, `?.create`, un alias, desestructurarlo) falla.
 * Y todo texto o plantilla que nombra la tabla (`"SupportDataUnlock"`, también `public."…"`) tiene que ser un SELECT: empieza con
 * SELECT o WITH y no trae INSERT, UPDATE, DELETE, TRUNCATE ni MERGE, en mayúsculas o minúsculas y en cualquier renglón.
 * Qué NO ve: un nombre de tabla armado con pedazos de texto, o un delegado sacado con una llave calculada.
 * Ojo, quien arme lecturas por pedazos (la purga, la lista semanal): `isSelectOnly` también marca `SELECT … FOR UPDATE` (lleva UPDATE)
 * y todo pedazo de lectura que no empiece él mismo con SELECT o WITH, como un `Prisma.sql` que empieza con `FROM "SupportDataQuery"`.
 * El pedazo que nombra la tabla tiene que empezar con SELECT o WITH; o el archivo entra a la lista de escritores, si de verdad escribe.
 * La única excepción es la purga de 90 días (Task 11): en `retention.service.ts`, y sólo ahí, pasa además UNA forma de SQL, la del
 * lote que ya purga SupportEvent: `WITH chosen AS (SELECT id FROM "<tabla>" WHERE "createdAt" <= ${…} ORDER BY "createdAt", id
 * LIMIT ${…} FOR UPDATE SKIP LOCKED) DELETE FROM "<tabla>" x USING chosen WHERE x.id = chosen.id`, con ese filtro exacto, de la
 * misma tabla y sólo del registro o de los desbloqueos. La aceptación no se purga. Como en todo lo demás, un hueco `${…}` cuenta
 * como `?`: la guardia no ve lo que trae (un `Prisma.raw` en el corte o en el tope pasaría).
 */
import * as fs from 'fs'
import * as path from 'path'
import ts from 'typescript'
import { ROOT, fromRoot, listTs } from '@tests/__helpers__/tsGuard'

const SOURCES = listTs(path.join(ROOT, 'src')).map(file => ({ file: fromRoot(file), text: fs.readFileSync(file, 'utf8') }))

/** Las rutas, relativas a la raíz del repo, de los `.ts` bajo `src/` cuyo texto cumple el patrón. */
const filesMatching = (pattern: RegExp): string[] => SOURCES.filter(s => pattern.test(s.text)).map(s => s.file)

interface Guarded {
  delegates: string[] // la propiedad del cliente de Prisma ('supportDataUnlock')
  tables: string[] // el nombre de la tabla en SQL ('SupportDataUnlock')
}
const ACCEPTANCE_AND_UNLOCK: Guarded = {
  delegates: ['supportDataAcceptance', 'supportDataUnlock'],
  tables: ['SupportDataAcceptance', 'SupportDataUnlock'],
}
const QUERY_LOG: Guarded = { delegates: ['supportDataQuery'], tables: ['SupportDataQuery'] }

const READER = /^(find\w*|count|aggregate|groupBy)$/
const SQL_WRITE = /\b(insert|update|delete|truncate|merge)\b/i

/** `name` es la propiedad de un acceso (`x.name`, `x?.name`, `x['name']`) cuyo resultado se llama directo con un lector. */
function isDirectRead(name: ts.Node): boolean {
  const access = name.parent
  const isAccess =
    (ts.isPropertyAccessExpression(access) && access.name === name) ||
    (ts.isElementAccessExpression(access) && access.argumentExpression === name)
  if (!isAccess) return false
  const method = access.parent
  return (
    ts.isPropertyAccessExpression(method) &&
    method.expression === access &&
    READER.test(method.name.text) &&
    ts.isCallExpression(method.parent) &&
    method.parent.expression === method
  )
}

/** El texto de un literal o de una plantilla (los huecos `${…}` cuentan como `?`); null si el nodo no es texto. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(' ? ')
  return null
}
const isSelectOnly = (sql: string): boolean => {
  const plain = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
  return /^\(*\s*(select|with)\b/i.test(plain) && !SQL_WRITE.test(plain)
}

/** La purga de 90 días, el único archivo fuera de los escritores que puede borrar (sólo con la forma de `isPurge`). */
const PURGER = 'src/services/support/retention.service.ts'
const PURGEABLE = ['SupportDataQuery', 'SupportDataUnlock']
// El filtro es el de la purga y ningún otro: por edad, en orden de su índice [createdAt, id] y con su tope (los huecos son `?`).
const PURGE =
  /^with chosen as \( ?select id from "(\w+)" where "createdat" <= \? order by "createdat", id limit \? for update skip locked ?\) delete from "\1" (\w+) using chosen where \2\.id = chosen\.id$/i
/** Un lote de la purga y nada más: borra por edad de la misma tabla que eligió, con su tope, sin otra sentencia. */
const isPurge = (sql: string): boolean => {
  const match = PURGE.exec(
    sql
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
  return !!match && PURGEABLE.includes(match[1])
}

/** Cada uso de estos modelos que no es una lectura, como `archivo:renglón: qué`. */
function writeProblems(source: string, guarded: Guarded, file = 'sample.ts', purges = false): string[] {
  if (![...guarded.delegates, ...guarded.tables].some(name => source.includes(name))) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const delegates = new Set(guarded.delegates)
  const table = new RegExp(`"(${guarded.tables.join('|')})"`)
  const problems: string[] = []
  const where = (node: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && delegates.has(node.text) && !isDirectRead(node))
      problems.push(`${where(node)}: ${node.text} used for something other than a read`)
    const sql = literalText(node)
    if (sql !== null && table.test(sql) && !isSelectOnly(sql) && !(purges && isPurge(sql)))
      problems.push(`${where(node)}: SQL on ${table.exec(sql)![1]} that is not a SELECT`)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return problems
}

/** Los problemas en todo `src/`, fuera de los escritores permitidos (que tienen que existir). */
function writersOutside(guarded: Guarded, writers: string[]): string[] {
  for (const writer of writers) expect(fs.existsSync(path.join(ROOT, writer))).toBe(true)
  return SOURCES.filter(s => !writers.includes(s.file)).flatMap(s => writeProblems(s.text, guarded, s.file, s.file === PURGER))
}

it('only the panel route service writes the acceptance and the unlock; only the purge deletes', () => {
  expect(writersOutside(ACCEPTANCE_AND_UNLOCK, ['src/services/support/data/consent.service.ts'])).toEqual([])
})

// El registro de consultas dice «se consultó»: lo escribe un solo archivo, y nadie lo vuelve a tocar (la purga sólo lo borra).
it('only data/log.ts writes SupportDataQuery', () => {
  expect(writersOutside(QUERY_LOG, ['src/services/support/data/log.ts'])).toEqual([])
})

// La purga de 90 días: retention.service.ts borra el registro y los desbloqueos con UNA forma, y nada más pasa.
const PURGE_FILTER = '"createdAt" <= ${utcTs(ninety)} ORDER BY "createdAt", id LIMIT ${take}'
const purge = (table: string, filter = PURGE_FILTER) =>
  `await tx.$executeRaw\`WITH chosen AS (\n  SELECT id FROM "${table}" WHERE ${filter} FOR UPDATE SKIP LOCKED\n) DELETE FROM "${table}" x USING chosen WHERE x.id = chosen.id\``
const ALL: Guarded = {
  delegates: [...ACCEPTANCE_AND_UNLOCK.delegates, ...QUERY_LOG.delegates],
  tables: [...ACCEPTANCE_AND_UNLOCK.tables, ...QUERY_LOG.tables],
}

it('retention.service.ts purges the log and the unlocks, and only through the purge allowance', () => {
  const retention = SOURCES.find(s => s.file === PURGER)!.text
  expect(writeProblems(retention, ALL, PURGER, true)).toEqual([])
  // Without the allowance its two deletes are writes: the purge is really there, one statement per table.
  expect(writeProblems(retention, ALL, PURGER).map(p => p.replace(/^[^:]+:\d+: /, ''))).toEqual([
    'SQL on SupportDataQuery that is not a SELECT',
    'SQL on SupportDataUnlock that is not a SELECT',
  ])
})

it.each(['SupportDataQuery', 'SupportDataUnlock'])('the purge shape on %s passes in retention.service.ts and nowhere else', table => {
  expect(writeProblems(purge(table), ALL, PURGER, true)).toEqual([])
  expect(writeProblems(purge(table), ALL)).not.toEqual([])
})

it.each([
  ['a purge of the acceptance', purge('SupportDataAcceptance')],
  // The batch, but not by age: by person and day, everything, without its cap, or a filter that is all hole (a Prisma.raw).
  ['a purge filtered by person and day', purge('SupportDataQuery', '"staffId" = ${staffId} AND day = ${day}')],
  ['a purge of every row (WHERE true)', purge('SupportDataUnlock', 'true')],
  ['a purge without its LIMIT', purge('SupportDataQuery', '"createdAt" <= ${utcTs(ninety)} ORDER BY "createdAt", id')],
  ['a purge whose whole filter is a hole', purge('SupportDataUnlock', '${Prisma.raw(filter)}')],
  ['a DELETE without the chosen batch', 'await tx.$executeRaw`DELETE FROM "SupportDataUnlock" WHERE "createdAt" <= ${ninety}`'],
  [
    'a SELECT … FOR UPDATE that is not a purge',
    'await tx.$queryRaw`SELECT id FROM "SupportDataQuery" ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`',
  ],
  [
    'a purge that deletes another table',
    purge('SupportDataQuery').replace('DELETE FROM "SupportDataQuery"', 'DELETE FROM "SupportDataUnlock"'),
  ],
  [
    'a purge followed by another statement',
    purge('SupportDataQuery').replace('= chosen.id`', '= chosen.id; INSERT INTO "SupportDataQuery" (id) VALUES (1)`'),
  ],
  [
    'a purge with a write in its filter',
    purge('SupportDataUnlock').replace(
      'WHERE "createdAt"',
      'WHERE id IN (UPDATE "SupportDataUnlock" SET day = 1 RETURNING id) AND "createdAt"',
    ),
  ],
  ['an UPDATE', 'await tx.$executeRaw`UPDATE "SupportDataQuery" SET result = \'ANSWERED\'`'],
  ['an INSERT', 'await tx.$executeRaw`INSERT INTO "SupportDataUnlock" (id) VALUES (1)`'],
  ['a delegate deleteMany', 'await tx.supportDataQuery.deleteMany({ where: { createdAt: { lte: ninety } } })'],
  ['a delegate update', 'await tx.supportDataUnlock.update({ where: { id }, data: { day } })'],
])('even in retention.service.ts the guard catches %s', (_name, source) => expect(writeProblems(source, ALL, PURGER, true)).not.toEqual([]))

// Las formas que la guardia por regex de antes no veía: cada una debe hacerla fallar.
it.each([
  ['an INSERT in lower case', 'await tx.$executeRaw`insert into "SupportDataAcceptance" ("staffId") values (1)`'],
  ['multi-line SQL with a hole', 'await tx.$executeRaw`\n  INSERT\n    INTO "SupportDataUnlock" (id)\n  VALUES (${id})`'],
  ['a schema-qualified table', 'await tx.$executeRaw`UPDATE public."SupportDataUnlock" SET day = 1`'],
  ['TRUNCATE in a plain string', 'await prisma.$executeRawUnsafe(\'TRUNCATE "SupportDataAcceptance"\')'],
  ['a CTE that deletes', 'await tx.$queryRaw`WITH gone AS (DELETE FROM "SupportDataUnlock" RETURNING id) SELECT * FROM gone`'],
  ['an optional call to a writer', 'await tx.supportDataAcceptance?.create({ data })'],
  ['a bracketed delegate', 'await tx["supportDataUnlock"].create({ data })'],
  ['an aliased delegate', 'const unlocks = tx.supportDataUnlock\nawait unlocks.deleteMany({})'],
  ['a destructured delegate', 'const { supportDataAcceptance } = tx\nawait supportDataAcceptance.upsert(args)'],
])('the guard catches %s', (_name, source) => expect(writeProblems(source, ACCEPTANCE_AND_UNLOCK)).not.toEqual([]))

it.each([
  ['a findUnique', 'await tx.supportDataAcceptance.findUnique({ where: { staffId } })'],
  ['an optional chain before the delegate', 'await tx?.supportDataUnlock.count({ where })'],
  ['a bracketed findMany', "await tx['supportDataUnlock'].findMany({ take: 5 })"],
  ['a raw SELECT', 'await tx.$queryRaw`SELECT id, "updatedAt" FROM "SupportDataUnlock" WHERE "staffId" = ${staffId}`'],
  ['a raw WITH … SELECT', 'await tx.$queryRaw`WITH u AS (SELECT id FROM "SupportDataUnlock") SELECT count(*) FROM u`'],
])('the guard lets a reader through: %s', (_name, source) => expect(writeProblems(source, ACCEPTANCE_AND_UNLOCK)).toEqual([]))

// El permiso de una capacidad se mira sobre la lista YA resuelta (permissionListGrants): evaluatePermissionList o resolvePermissions la
// expandirían otra vez y concederían permisos que el panel niega.
const RESOLVES_AGAIN = /evaluatePermissionList|resolvePermissions\(/
it('the support code never expands a resolved list again (evaluatePermissionList, resolvePermissions)', () => {
  expect(['evaluatePermissionList(list, p)', 'resolvePermissions(access.permissions)'].filter(s => RESOLVES_AGAIN.test(s))).toHaveLength(2)
  expect(filesMatching(RESOLVES_AGAIN).filter(f => f.startsWith('src/services/support/'))).toEqual([])
})
