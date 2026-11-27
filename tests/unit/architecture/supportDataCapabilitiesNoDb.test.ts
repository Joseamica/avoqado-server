/**
 * Candado estático de la B del soporte por WhatsApp: una capacidad nunca toca la base y sólo llama servicios del panel con la
 * sucursal del alcance (T-B41). T-B42 lo rehizo sobre el compilador de TypeScript y sobre una lista de lo PERMITIDO.
 *
 * Modelo de amenaza: ERRORES HONESTOS de quien escribe una capacidad (nuestros agentes, con revisión por tarea y Codex por bloque),
 * no código malicioso. Lo que sólo escribiría un autor malicioso es riesgo aceptado (abajo); lo cubren la revisión y el barrido.
 *
 * Cómo lee: un `ts.Program` con las opciones de `tsconfig.json` (las del typecheck), con raíz en los archivos vigilados (las muestras,
 * en memoria encima del disco). Cada import lo resuelve el resolvedor de TypeScript (`@/`, relativas, index) y cada llamada el type
 * checker (alias, re-exports, namespaces, desestructuración): ninguna ruta se normaliza a mano. Para que sea rápido, el programa sigue
 * los imports de los archivos vigilados y los re-exports, y no carga `node_modules` ni `@types`: un paquete se reconoce por su nombre.
 *
 * LO PERMITIDO (lista cerrada; lo demás falla). Una capacidad (`capabilities/**`) importa valores sólo de:
 *  (a) servicios del panel: `src/services/{dashboard,shared,legacy}/**` (menos `legacy/legacyPool.ts`);
 *  (b) los módulos de la B sin base: `support/data/{catalog,check,format,params,paymentText,planText,readRefusal,sanitize,texts}.ts`
 *      (`paymentText.ts`, los textos de un cobro que comparten C2 y C7, lo creó C2; `planText.ts`, el texto de «Tu plan» que comparten
 *      C5 y el editor de la oferta, que así rechaza un nombre que el bot no podría decir, lo creó B4; `readRefusal.ts`, `DataReadRefusal`
 *      sin dependencias para que una capacidad no se importe en ciclo con el catálogo, C6 r1);
 *  (c) los utils puros de UTILS, uno por uno (hoy `src/utils/datetime.ts` y `src/utils/venueDateKeys.ts`), menos lo de UTIL_BANNED
 *      (de `datetime.ts`, `venueStartOfDay`/`venueEndOfDay`: el día sale de `params.ts`, README regla 8, D19);
 *  (d) `date-fns`, `date-fns-tz`, y `@prisma/client` sólo para tipos, sus enums (`PaymentMethod.CASH`, `$Enums`) y `Prisma.Decimal`.
 *  De otra capacidad, sólo tipos; un `import type` vale desde cualquier lado. La DECLARACIÓN final de lo importado (tras alias y
 *  re-exports) también tiene que estar en la lista. `catalog.ts` y `answer.service.ts` importan (b), (c), (d) y lo de EXCEPTIONS, con su
 *  razón (una excepción que sobra falla); el catálogo, además, las capacidades.
 *
 * LAS REGLAS:
 *  1. Cierre transitivo: nada de lo que importan (b) y (c), ni lo que eso importa, llega a una conexión (DB_HANDLES, `pg`,
 *     `.prisma/client`, `PrismaClient`, o `@prisma/client` como valor que no sea un enum o `Prisma.Decimal`). El panel sí lee la base: no
 *     se recorre.
 *  2. Sin código dinámico en las capacidades: `import()`, `require`, `eval`, `Function`, `globalThis`, `module`, `process` (DYNAMIC), ni
 *     corchetes sobre algo importado. Un nombre que el compilador no resuelve, o un global que no es del lenguaje, falla. T-B44: los
 *     globales del lenguaje también son una lista cerrada (GLOBALS): antes pasaba cualquier nombre de la biblioteca por omisión, así
 *     que `Object.assign`, `Reflect` y hasta `fetch` (la biblioteca trae la del navegador) pasaban sin que nada los mirara.
 *  3. Un servicio del panel sólo se llama (directo, o `Servicio.método`), y el checker resuelve esa llamada a una declaración del panel:
 *     si no la resuelve, falla. Pasarlo como valor sólo vale para los nombres de PANEL_NO_DATA (`available: cashDrawerIndexesReady`).
 *  4. T-B42b: toda llamada al panel lleva la sucursal del alcance A LA VISTA, sin depender de los tipos: `scope.venueId` a su parámetro
 *     `venueId` (a `venueIds`, `[scope.venueId]` o `scope.venueIds`), o un objeto literal con la llave `venueId: scope.venueId`. En el
 *     objeto sólo esa llave lo protege (T-B42c: `venueIds` sola nunca), y va AL FINAL (T-B42d): antes, cualquier cosa, porque la última
 *     escritura gana; después, sólo `venueIds: [scope.venueId]` (o `scope.venueIds`), nada más: ni spread, ni llave calculada, ni otra
 *     propiedad. Un getter o setter `venueId`/`venueIds` y un `__proto__` fallan en cualquier lugar del objeto, y nada que pueda escribir
 *     cualquier llave (spread, llave calculada) va después de `venueIds`. Si no, falla: opciones en una variable, un argumento opcional
 *     que se omite, una función sin parámetro de sucursal. La excepción es por nombre y archivo, en PANEL_NO_DATA: funciones del panel que
 *     no leen datos de un negocio (hoy `venueWeekBounds`, C6, y `cashDrawerIndexesReady`, C8).
 *  5. La sucursal se escribe siempre `scope.venueId`: en todo parámetro `venueId`/`venueIds` y en toda llave `venueId`/`venueIds`
 *     (desestructurada o abreviada, `{ venueId }`, no cuenta); un parámetro del panel cuyo tipo trae esas llaves recibe un objeto literal;
 *     un parámetro `DataScope` recibe sólo el alcance de verdad; ningún texto con forma de id (cuid v1). Siguen las de T-B41: sólo el
 *     alcance se llama `scope`, nadie le asigna, y la organización nunca (T-B41b: ni `scope.organizationId`, ni la llave, ni `{ ...scope }`,
 *     ni el alcance entero al panel).
 *  6. Segunda red, por nombre: `$queryRaw`/`$transaction`…, `prisma.`/`tx.`, `x.<modelo>.<acción>()`, en todos los archivos vigilados.
 *  7. T-B43: una negativa es un texto fijo, nunca un dato (se guarda como ayuda, sin cifrar, y llega tal cual al historial del
 *     modelo). En una capacidad, lo que devuelve `notOffered`, el `refusal` de cualquier objeto (el candado de plan, el `{ ok: false }`
 *     de `params`) y el segundo argumento de `new DataReadRefusal()` son una llave LITERAL de SUPPORT_DATA_REFUSALS (texts.ts), `null`
 *     en `notOffered`, o un ternario de ésas (su condición, cualquier cosa). `notOffered` se escribe ahí mismo (flecha, función o
 *     método) y se revisa cada `return`. `key`, `label`, `object` y `aiHint` son textos literales (T-B44 sumó `key` y `aiHint`): van en
 *     la lista de lo que sí puede, en la negativa sin permiso, en la marca del historial, en los renglones para la IA y en los avisos.
 *     Detrás está el orquestador, que falla cerrado: lo que no es una llave contesta la genérica (supportDataRefusal).
 *  8. T-B44: una capacidad sólo escribe sus variables locales, declaradas en la MISMA función que la escritura. Falla toda asignación
 *     (`=`, `+=`, `-=`, `??=`…, `++`/`--`, un patrón o un `for…of` que escribe) sobre una propiedad (`x.y`, `x[y]`, `this.y`), algo
 *     importado, algo del nivel del módulo o una variable de otra función; todo `delete`. Un método que cambia lo que recibe (MUTATORS:
 *     `push`, `splice`, `set`, `sort`…, y todo `set…` de `Date`: `setHours`, `setTime`, `setUTCDate`…) sólo sobre una VARIABLE
 *     declarada en la misma función: nunca sobre un parámetro (`scope.now.setHours(…)`, `result.rows.sort()`), lo que devuelve una
 *     llamada (`lista().push(…)`), algo importado, del módulo o `this`. Ni `.call`, `.apply` o `.bind`: cambian a quién y con qué se
 *     llama una función sin que se vea en la llamada. Los mutadores de `Object` y `Reflect` no están en GLOBALS (regla 2).
 *     Detrás está el catálogo: lo que se registra se congela en su lugar (`dataCatalog`, `deepFreeze`) y las negativas, la etiqueta y el
 *     objeto se leen de esa capacidad congelada; una escritura que se cuela lanza `TypeError` y el orquestador falla cerrado. Y cada llamada a la capacidad
 *     recibe su propio alcance con su propia copia de `scope.now`: un `setHours` que se cuele no mueve el `preparedAt` del sobre.
 *  9. T-B45/T-B46: una capacidad es un objeto literal: nada de `class` (declarada o expresión), y una variable de tipo `DataCapability`
 *     se inicia con un objeto literal, nunca con lo que devuelve una llamada o un `new`. Y nada de `this` en todo el archivo: lo que
 *     hace una capacidad no depende de cómo se le llama (una bandera leída por `this`, Codex b2-r4). El catálogo ya no copia: revisa
 *     la forma (cada miembro del contrato, un valor del tipo que pide; un getter o algo que falta lanza al cargar), congela la MISMA
 *     capacidad y la guarda. Las dos copias de antes se comieron una negativa: `{ ...c }` perdía un método del prototipo (Codex
 *     b2-r3) y la copia por nombre, la bandera de un método (Codex b2-r4).
 *
 * QUÉ NO VE: RESIDUAL ACEPTADO (sólo lo escribiría un autor malicioso, o lo cubre otra red):
 *  - lo que un servicio del panel hace por dentro, también si regresa una conexión o una función que lee la base, o si filtra por un id
 *    con otro nombre (`id`, `orderId`): cada servicio NUEVO trae su prueba de aislamiento, y está el barrido de conducta;
 *  - un valor `any` (`as any`, `JSON.parse`, `Object.fromEntries`) armado para llevar otra sucursal sin una llave literal, o una segunda
 *    sucursal escondida en OTRA opción de una llamada que ya lleva `scope.venueId`;
 *  - T-B44: un método que cambia sobre una variable local que apunta a algo de fuera (`const hora = scope.now; hora.setHours(…)`,
 *    `const filas = result.rows; filas.sort()`): la guardia no sigue a qué apunta una variable. Lo cubre la copia de `scope.now` que
 *    recibe cada llamada; el resultado de la lectura es de esa petición;
 *  - T-B44: el objeto de exportaciones de un módulo (`texts.ts`, `catalog.ts`): CommonJS lo deja escribible, y las pruebas lo usan con
 *    `jest.replaceProperty`. Congelar el valor (`deepFreeze`) no impide cambiar el export entero por otro. Una capacidad sólo llega a él
 *    escribiendo sobre lo importado (`texts.SUPPORT_DATA_REFUSALS = …`, regla 8), con `Object.assign`/`Object.defineProperty`/`Reflect`
 *    (fuera de GLOBALS, regla 2) o con `require`/`module`/`exports` (DYNAMIC, regla 2): las tres están prohibidas, así que no se congela
 *    el módulo (dependería de su formato y rompería las herramientas de prueba);
 *  - T-B46: el prototipo de una capacidad no se congela (en un objeto literal es `Object.prototype`, de todo el proceso). Sólo importa si
 *    se colara una clase, que la regla 9 no deja; cambiarlo pide escribir sobre algo que no es local, que la regla 8 no deja;
 *  - un `require` con la ruta calculada dentro de un util;
 *  - T-B43: una negativa armada en un módulo de la B (un `params` compartido) o que llega por un spread, y `DataReadRefusal` guardado en
 *    otra variable: los tipos piden una llave y el orquestador sólo contesta textos de SUPPORT_DATA_REFUSALS.
 *  Falla de más, a propósito: un util de la lista que importa tipos sin `import type` cuenta como import de valor en el cierre, y un
 *  panel que re-exporta lo que importó (`import { x } …; export { x }`) no se ve, así que la llamada falla. T-B44: un `key:` o un
 *  `aiHint:` no literal en cualquier objeto de la capacidad, y una variable de la función escrita desde un callback
 *  (`rows.forEach(r => { total += r })`): se escribe con `for…of` o `reduce`.
 */
import * as fs from 'fs'
import * as path from 'path'
import ts from 'typescript'
import { Prisma } from '@prisma/client'
import { SUPPORT_DATA_REFUSALS } from '@/services/support/data/texts'
import { ROOT, fromRoot, lineOf, listTs } from '@tests/__helpers__/tsGuard'

const CAPABILITIES = 'src/services/support/data/capabilities/'
const CATALOG = 'src/services/support/data/catalog.ts'
const ANSWER = 'src/services/support/data/answer.service.ts'
/** Donde se declara `DataReadRefusal` (C6 r1): sin dependencias de valor; el catálogo lo re-exporta. */
const READ_REFUSAL = 'src/services/support/data/readRefusal.ts'

/** (a) Los servicios del panel: lo ÚNICO por lo que una capacidad lee datos. */
const PANEL = ['src/services/dashboard/', 'src/services/shared/', 'src/services/legacy/']
/** (b) Los módulos de la B, sin base, con los que una capacidad arma su respuesta. */
const PURE = ['catalog', 'check', 'format', 'params', 'paymentText', 'planText', 'readRefusal', 'sanitize', 'texts'].map(
  m => `src/services/support/data/${m}.ts`,
)
/** Lo que la guardia nombra y todavía no existe. Vacío: `paymentText.ts` lo creó C2 y `cashDrawerWho.dashboard.service.ts`, C8. */
const FUTURE: string[] = []
/**
 * T-B42b: las funciones del panel que NO leen datos de un negocio, por nombre y archivo. Sólo éstas se llaman sin la sucursal del
 * alcance, o se pasan como valor. Son las que llaman C1–C8 del plan; otra entra aquí con su razón.
 */
const PANEL_NO_DATA = [
  {
    file: 'src/services/dashboard/settlementCalendar.dashboard.service.ts',
    name: 'venueWeekBounds',
    why: 'C6: el lunes y el domingo de la semana de un día, en la zona de la sucursal; sólo calcula fechas',
  },
  {
    file: 'src/services/dashboard/cashDrawerWho.dashboard.service.ts',
    name: 'cashDrawerIndexesReady',
    why: 'C8 (available): si ya existen tres índices, en el catálogo de Postgres; ningún dato de un negocio',
  },
  {
    file: 'src/services/dashboard/planState.service.ts',
    name: 'nombresDeLosPlanesDeTuPlan',
    why: 'C5 (B4): el nombre de cada plan de la versión vigente del editor; un dato de la plataforma, ningún dato de un negocio',
  },
]
const noData = (file: string | undefined, name: string | null | undefined) =>
  PANEL_NO_DATA.some(x => x.file === fromRoot(file ?? '') && x.name === name)
/** (c) Los utils puros que una capacidad puede importar, uno por uno (lo que usan C1–C8 del plan). */
const UTILS = ['src/utils/datetime.ts', 'src/utils/venueDateKeys.ts']
/**
 * Lo que una capacidad NO importa de un util de la lista, con su razón: por nombre (también con otro nombre, o re-exportado por un
 * módulo de la B) y sin `import *` de ese util, que lo dejaría pasar como `dt.venueStartOfDay`.
 */
const UTIL_BANNED: { file: string; names: string[]; why: string }[] = [
  {
    file: 'src/utils/datetime.ts',
    names: ['venueStartOfDay', 'venueEndOfDay'],
    why: 'the day comes from dayBounds/wholeDayBounds of params.ts (README rule 8): venueStartOfDay/venueEndOfDay can depend on the zone of the process (D19)',
  },
]
const utilBan = (file: string, name: string) =>
  UTIL_BANNED.find(u => u.file === fromRoot(file) && (name === '*' || u.names.includes(name)))?.why
/** (d) Los paquetes. De `@prisma/client`, sólo tipos, sus enums (objetos de constantes) y `Prisma.Decimal`. */
const PACKAGES = ['date-fns', 'date-fns-tz', '@prisma/client']
/** Las conexiones a la base que tiene el repo, y los paquetes que abren una. */
const DB_HANDLES = ['src/utils/prismaClient.ts', 'src/services/legacy/legacyPool.ts', 'src/config/database.ts']
const DB_PACKAGES = ['pg', '.prisma/client']
/** Lo que trae código o el entorno en tiempo de ejecución: ninguno en un archivo vigilado. */
const DYNAMIC = new Set(['require', 'eval', 'Function', 'globalThis', 'global', 'window', 'self', 'module', 'exports', 'process'])
const CUID = /^c[a-z0-9]{24}$/

interface Exception {
  file: string
  from: string // ruta del repo, o el nombre del paquete
  names: string[] // lo importado ('default' para el default)
  why: string
  /** Sólo para la conexión: el único uso permitido es como primer argumento de esta función. */
  onlyAsFirstArgumentOf?: string
}
/**
 * Lo que `answer.service.ts` y `catalog.ts` importan hoy fuera de la lista general. Las LECTURAS de la base son las cinco primeras;
 * las demás no leen nada, pero sus módulos sí importan la base (o no son de la B), así que también van con nombre.
 */
const EXCEPTIONS: Exception[] = [
  {
    file: ANSWER,
    from: 'src/utils/prismaClient.ts',
    names: ['default'],
    onlyAsFirstArgumentOf: 'readDataValidity',
    why: 'la vigencia: readDataValidity recibe la conexión y lee por llave la sucursal, la aceptación y el desbloqueo, tablas de consent.service',
  },
  { file: ANSWER, from: 'src/services/support/data/consent.service.ts', names: ['readDataValidity'], why: 'la vigencia (arriba)' },
  {
    file: ANSWER,
    from: 'src/services/support/data/log.ts',
    names: ['countDataReadsToday', 'paramsHmac'],
    why: 'el registro: cuántas lecturas lleva hoy esta persona (y la huella de los parámetros, sin base)',
  },
  {
    file: ANSWER,
    from: 'src/services/support/context.service.ts',
    names: ['isSupportAccessLost', 'readSupportContext'],
    why: 'el vínculo y el acceso de la persona, los de la fase 1',
  },
  { file: ANSWER, from: 'src/mcp/scope.ts', names: ['isActiveSuperAdmin'], why: 'si la persona es superadmin, por su staffId' },
  { file: ANSWER, from: 'src/services/support/link.service.ts', names: ['supportCipher'], why: 'sella el sobre' },
  { file: ANSWER, from: 'src/services/support/notices.service.ts', names: ['within'], why: 'el tiempo máximo de la lectura' },
  { file: ANSWER, from: 'src/config/logger.ts', names: ['default'], why: 'avisos sin el mensaje' },
  { file: ANSWER, from: 'src/config/supportWhatsapp.ts', names: ['getSupportDataConfig'], why: 'el interruptor y los topes' },
  { file: ANSWER, from: 'crypto', names: ['default'], why: 'la huella de acceso' },
  {
    file: CATALOG,
    from: 'src/lib/permissions.ts',
    names: ['permissionListGrants'],
    why: 'mira la lista de permisos ya resuelta, sin base',
  },
  {
    file: CATALOG,
    from: 'src/utils/deepFreeze.ts',
    names: ['deepFreeze'],
    why: 'T-B44: congela cada capacidad y el catálogo al registrarlos',
  },
]

const RAW = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRawTyped',
  '$transaction',
  '$runCommandRaw',
])
const CLIENT_NAMES = new Set(['prisma', 'tx'])
const ENUMS = new Set([...Prisma.dmmf.datamodel.enums.map(e => e.name), '$Enums'])
const MODEL_DELEGATES = new Set(Prisma.dmmf.datamodel.models.map(m => m.name.charAt(0).toLowerCase() + m.name.slice(1)))
const MODEL_ACTIONS = new Set(
  'findUnique findUniqueOrThrow findFirst findFirstOrThrow findMany count aggregate groupBy create createMany createManyAndReturn update updateMany updateManyAndReturn upsert delete deleteMany'.split(
    ' ',
  ),
)
/** El campo del alcance del que puede salir cada nombre. */
const FIELD: Record<string, string> = { venueId: 'venueId', venueIds: 'venueIds' }
const TENANT = new Set(Object.keys(FIELD))
/** T-B41b: ningún valor es válido para estos nombres en una capacidad. */
const ORG = new Set(['organizationId', 'orgId'])
const NO_ORG =
  'the B answers for ONE venue: a capability never passes an organisation id; the panel service derives it from the venue (T-B41b)'
const FROM_SCOPE = 'write exactly scope.venueId (a list: [scope.venueId]) (T-B42b)'
const CARRY =
  "a panel call carries the scope's venue visibly: scope.venueId to its venueId parameter, or an object literal with venueId: scope.venueId (T-B42b); a function that reads no business data goes by name in PANEL_NO_DATA"
const LAST =
  'venueId: scope.venueId goes LAST in the object (after it, only venueIds: [scope.venueId]): before it, anything; after it, a spread, a computed key or any other property could replace it (T-B42d)'
const NO_DYNAMIC = 'a capability has no dynamic code nor runtime globals (import(), require, eval, Function, globalThis, module, process)'
const FIXED =
  'a refusal is a fixed text chosen by its key: a literal key of SUPPORT_DATA_REFUSALS (src/services/support/data/texts.ts), null in notOffered, or a ternary of those; never a template, a concatenation, a variable or a call (T-B43)'
const LITERAL =
  'a literal text of the capability: key, label, object and aiHint go into the refusals, the history mark, the rows for the AI and the notices (T-B43, T-B44)'
/**
 * T-B44: los globales del lenguaje que una capacidad usa (lista cerrada, como la de los imports). `true`: cualquier uso menos
 * `.prototype`; una lista: sólo esos miembros, escritos con su nombre (`Object.keys(…)`). Lo demás falla: `Object.assign`,
 * `Object.defineProperty`, `Reflect`, `Proxy`, y lo del navegador que trae la biblioteca por omisión (`fetch`, `console`, `setTimeout`).
 * Otro entra aquí con su razón.
 */
const GLOBALS: Record<string, true | string[]> = {
  Math: true,
  Number: true,
  String: true,
  Boolean: true,
  Date: true,
  Intl: true,
  JSON: true,
  Map: true,
  Set: true,
  Promise: true,
  Error: true,
  RegExp: true,
  parseInt: true,
  parseFloat: true,
  isFinite: true,
  isNaN: true,
  NaN: true,
  Infinity: true,
  Array: ['isArray', 'from', 'of'],
  Object: ['keys', 'values', 'entries', 'fromEntries'],
}
const NOT_LISTED =
  'a capability uses only the globals of GLOBALS (Object and Array only by their listed members, never .prototype): Object.assign, Object.defineProperty, Reflect and the like write into what it does not own (T-B44)'
const WRITES =
  'a capability writes only its own local variables, declared in the same function: never a property, nor something imported or of the module (T-B44)'
const CHANGES =
  'a method that changes what it receives (push, sort, set, setHours…) only on a variable declared in the same function: never on a parameter (scope.now), the result of a call, something imported, of the module or this (T-B44)'
const OBJECT_LITERAL =
  'a capability is an object literal, never a class nor what a call returns: the catalog stores the capability itself, frozen, and a class hides its members in its prototype (T-B45, T-B46)'
const NO_THIS =
  'a capability never uses this: what it does cannot depend on how it is called; read a constant of the file or the scope instead (T-B46)'
const NO_REBIND = 'a capability never calls through .call, .apply or .bind: what a function receives is written at the call (T-B44)'
/** Un `set…` de `Date` (`setHours`, `setTime`, `setUTCDate`…): cambia la fecha que recibe. */
const SETTER = /^set[A-Z]/
/** T-B44: los métodos que cambian lo que reciben, y los `set…` de `Date`: sólo sobre una variable de la misma función. */
const MUTATORS = new Set([
  'push',
  'splice',
  'set',
  'delete',
  'clear',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
  'unshift',
  'pop',
  'shift',
  'add',
])

// ─── El programa: las opciones del typecheck, el disco una vez, y las muestras encima ─────────────────────────────────────────

const parsedConfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  ROOT,
)
// ponytail: sin `@types` (lo que declaran, `process` o `require`, queda sin resolver y cae en DYNAMIC): medido, ~6 s el archivo en vez de ~10
const OPTIONS: ts.CompilerOptions = { ...parsedConfig.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined, types: [] }
const ALIASES = Object.keys(OPTIONS.paths ?? {}).map(p => p.replace(/\*$/, ''))
const onDisk = new Map<string, boolean>()
const diskSources = new Map<string, ts.SourceFile>()
const baseHost = ts.createCompilerHost(OPTIONS, true)

type Sources = Record<string, string>
type Target = { file: string } | { pkg: string } | { missing: true }
const bare = (spec: string) =>
  spec
    .split('/')
    .slice(0, /^[@.]/.test(spec) ? 2 : 1)
    .join('/')

/** El árbol del repo con `files` encima (rutas del repo → texto), y un programa con raíz en `roots`. */
function tree(files: Sources, roots: string[]) {
  const overlay = new Map(Object.entries(files).map(([p, text]) => [path.join(ROOT, p), text]))
  const fileExists = (f: string) => {
    if (overlay.has(f)) return true
    if (!onDisk.has(f)) onDisk.set(f, ts.sys.fileExists(f))
    return onDisk.get(f)!
  }
  const moduleHost: ts.ModuleResolutionHost = {
    fileExists,
    readFile: f => overlay.get(f) ?? ts.sys.readFile(f),
    directoryExists: ts.sys.directoryExists,
    realpath: ts.sys.realpath,
  }
  const resolved = (spec: string, from: string) => ts.resolveModuleName(spec, from, OPTIONS, moduleHost).resolvedModule
  /** Adónde lleva `spec` desde `from`, con el resolvedor del compilador. */
  const resolve = (spec: string, from: string): Target => {
    const r = resolved(spec, from)
    if (r && !r.isExternalLibraryImport) return { file: r.resolvedFileName }
    if (r) return { pkg: bare(spec) }
    return ts.isExternalModuleNameRelative(spec) || ALIASES.some(a => spec.startsWith(a)) ? { missing: true } : { pkg: bare(spec) }
  }
  const getSourceFile = (f: string, lang: ts.ScriptTarget | ts.CreateSourceFileOptions) => {
    const text = overlay.get(f)
    if (text !== undefined) return ts.createSourceFile(f, text, lang, true)
    if (!diskSources.has(f) && fileExists(f)) diskSources.set(f, ts.createSourceFile(f, ts.sys.readFile(f)!, lang, true))
    return diskSources.get(f)
  }
  const follow = new Set(roots.map(r => path.join(ROOT, r)))
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists,
    readFile: moduleHost.readFile,
    getSourceFile,
    // Los archivos vigilados ven lo que importan; de lo demás sólo se siguen los re-exports. Nada de node_modules.
    resolveModuleNameLiterals: (literals, from) =>
      literals.map(lit => {
        const r = follow.has(from) || ts.isExportDeclaration(lit.parent) ? resolved(lit.text, from) : undefined
        return { resolvedModule: r && !r.isExternalLibraryImport ? r : undefined }
      }),
  }
  const program = ts.createProgram({ rootNames: [...follow], options: OPTIONS, host })
  const source = (f: string) => program.getSourceFile(f) ?? getSourceFile(f, ts.ScriptTarget.Latest)!
  return { program, checker: program.getTypeChecker(), resolve, source, exists: fileExists }
}
type Tree = ReturnType<typeof tree>

// ─── Lo que lee cada archivo ───────────────────────────────────────────────────────────────────────────────────────────────

interface Load {
  node: ts.Node
  spec: string
  typeOnly: boolean
  reexport: boolean
  bindings: { name: string; local?: ts.Identifier }[] // 'default', '*' o el nombre exportado
}
/** Lo que un archivo carga: imports, re-exports, `import x = require()`; con `dynamic`, también `require('…')` e `import('…')`. */
const loadsOf = (sf: ts.SourceFile, dynamic = false): Load[] => {
  const out: Load[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const c = node.importClause
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements.filter(e => !e.isTypeOnly) : []
      const bindings = !c
        ? [{ name: '*' }]
        : [
            ...(c.name ? [{ name: 'default', local: c.name }] : []),
            ...(c.namedBindings && ts.isNamespaceImport(c.namedBindings) ? [{ name: '*', local: c.namedBindings.name }] : []),
            ...named.map(e => ({ name: (e.propertyName ?? e.name).text, local: e.name })),
          ]
      out.push({ node, spec: node.moduleSpecifier.text, typeOnly: !!c && (c.isTypeOnly || !bindings.length), reexport: false, bindings })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.filter(e => !e.isTypeOnly) : null
      const bindings = named ? named.map(e => ({ name: (e.propertyName ?? e.name).text })) : [{ name: '*' }]
      out.push({ node, spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly || !bindings.length, reexport: true, bindings })
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const spec = node.moduleReference.expression.text
      out.push({ node, spec, typeOnly: node.isTypeOnly, reexport: false, bindings: [{ name: '*', local: node.name }] })
    } else if (
      dynamic &&
      ts.isCallExpression(node) &&
      isDynamicLoad(node) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push({ node, spec: node.arguments[0].text, typeOnly: false, reexport: false, bindings: [{ name: '*' }] })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
const isDynamicLoad = (n: ts.CallExpression) =>
  n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) ||
  ts.isAsExpression(e) ||
  ts.isNonNullExpression(e) ||
  ts.isSatisfiesExpression(e) ||
  ts.isTypeAssertionExpression(e)
    ? unwrap(e.expression)
    : e
const nameText = (n: ts.PropertyName | ts.BindingName | undefined): string | null => {
  if (!n) return null
  if (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) return n.text
  if (ts.isComputedPropertyName(n) && ts.isStringLiteralLike(n.expression)) return n.expression.text
  return null
}
const inType = (n: ts.Node): boolean => {
  for (let p = n.parent; p && !ts.isSourceFile(p) && !ts.isStatement(p); p = p.parent) if (ts.isTypeNode(p)) return true
  return false
}
/** Una firma sin cuerpo (de un tipo o una interfaz): sus parámetros no reciben nada. */
const isSignature = (n: ts.Node) =>
  ts.isTypeNode(n) ||
  ts.isMethodSignature(n) ||
  ts.isCallSignatureDeclaration(n) ||
  ts.isConstructSignatureDeclaration(n) ||
  ts.isIndexSignatureDeclaration(n)
/** El identificador NOMBRA un valor (no es una llave, una declaración, un tipo ni un import). */
const isReference = (id: ts.Identifier): boolean => {
  const p = id.parent
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && (ts.isPropertyAccessExpression(p) ? p.name : p.right) === id)
    return false
  if ((ts.isBindingElement(p) && p.propertyName === id) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false
  if (ts.isMetaProperty(p) || ts.isImportClause(p) || ts.isImportSpecifier(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p))
    return false
  if (ts.isImportEqualsDeclaration(p) || ts.isNamespaceExport(p) || ts.isShorthandPropertyAssignment(p))
    return ts.isShorthandPropertyAssignment(p)
  if (DECLARES.some(is => is(p)) && (p as ts.NamedDeclaration).name === id) return false
  return !inType(id)
}
const DECLARES: ((n: ts.Node) => boolean)[] = [
  ts.isVariableDeclaration,
  ts.isParameter,
  ts.isFunctionDeclaration,
  ts.isFunctionExpression,
  ts.isClassDeclaration,
  ts.isClassExpression,
  ts.isBindingElement,
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isEnumDeclaration,
  ts.isEnumMember,
  ts.isModuleDeclaration,
  ts.isTypeParameterDeclaration,
  ts.isPropertyAssignment,
  ts.isPropertyDeclaration,
  ts.isPropertySignature,
  ts.isMethodDeclaration,
  ts.isMethodSignature,
  ts.isGetAccessorDeclaration,
  ts.isSetAccessorDeclaration,
]
/** La raíz de `a.b.c` / `a['b']`. */
const rootOf = (e: ts.Expression): ts.Expression => {
  e = unwrap(e)
  return ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? rootOf(e.expression) : e
}

/** De `@prisma/client` se usan tipos y, como valor, sólo sus enums y `Prisma.Decimal`: nunca el cliente. */
function prismaProblems(t: Tree, sf: ts.SourceFile): { node: ts.Node; what: string }[] {
  const out: { node: ts.Node; what: string }[] = []
  const locals = new Map<string, string>()
  for (const l of loadsOf(sf)) {
    const target = t.resolve(l.spec, sf.fileName)
    if (l.typeOnly || !('pkg' in target) || target.pkg !== '@prisma/client') continue
    for (const b of l.bindings)
      if (l.reexport || !b.local || ['PrismaClient', 'default', '*'].includes(b.name))
        out.push({
          node: l.node,
          what: `${l.reexport ? 're-exports' : 'imports'} ${b.name === '*' ? 'the module' : b.name} from @prisma/client: never the database client`,
        })
      else locals.set(b.local.text, b.name)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && locals.has(n.text) && isReference(n)) {
      const imported = locals.get(n.text)!
      const decimal = imported === 'Prisma' && ts.isPropertyAccessExpression(n.parent) && n.parent.name.text === 'Decimal'
      if (!decimal && !ENUMS.has(imported))
        out.push({
          node: n,
          what: `${n.text} from @prisma/client used as a value: from @prisma/client only types, its enums and Prisma.Decimal`,
        })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Regla 1: lo que (b) y (c) cargan, transitivamente, nunca llega a una conexión. Por módulo, el camino más corto al primer hallazgo. */
function closureProblems(t: Tree): string[] {
  const out: string[] = []
  for (const start of [...PURE, ...UTILS]) {
    if (!t.exists(path.join(ROOT, start))) continue // FUTURE, hasta que exista
    const chains = new Map([[path.join(ROOT, start), [start]]]) // en orden de llegada: a lo ancho
    let found: string | undefined
    for (const [file, chain] of chains) {
      const sf = t.source(file)
      const at = (node: ts.Node, what: string) => `${start} reaches the database: ${lineOf(sf, node)}: ${what} (${chain.join(' → ')})`
      const prisma = prismaProblems(t, sf)[0]
      if (prisma) found = at(prisma.node, prisma.what)
      for (const l of loadsOf(sf, true)) {
        const target = l.typeOnly ? null : t.resolve(l.spec, file)
        if (target && 'pkg' in target && DB_PACKAGES.includes(target.pkg)) found ??= at(l.node, `imports ${target.pkg}`)
        if (!target || !('file' in target)) continue
        const rel = fromRoot(target.file)
        const excepted = EXCEPTIONS.some(
          e => e.file === chain[chain.length - 1] && e.from === rel && l.bindings.every(b => e.names.includes(b.name)),
        )
        if (DB_HANDLES.includes(rel)) found ??= at(l.node, `imports ${rel}`)
        else if (!excepted && !rel.startsWith(CAPABILITIES) && !chains.has(target.file)) chains.set(target.file, [...chain, rel])
      }
      if (found) break
    }
    if (found) out.push(found)
  }
  return out
}

/** T-B43: las llaves de las negativas. Un texto nuevo entra a `SUPPORT_DATA_REFUSALS`, nunca a la capacidad. */
const REFUSAL_KEYS = new Set(Object.keys(SUPPORT_DATA_REFUSALS))
/** Lo que está mal en un valor de negativa, o null: una llave literal del conjunto, `null` si se permite, o un ternario de ésos. */
function refusalProblem(e: ts.Expression, nullable: boolean): string | null {
  e = unwrap(e)
  if (ts.isStringLiteralLike(e)) return REFUSAL_KEYS.has(e.text) ? null : `'${e.text}' is not a key of SUPPORT_DATA_REFUSALS; ${FIXED}`
  if (nullable && e.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isConditionalExpression(e)) return refusalProblem(e.whenTrue, nullable) ?? refusalProblem(e.whenFalse, nullable)
  return FIXED
}
/** Lo que devuelve una función: el cuerpo de una flecha, o cada `return` con valor de su cuerpo (sin entrar a otras funciones). */
function returnedValues(fn: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration): ts.Expression[] {
  if (!fn.body) return []
  if (!ts.isBlock(fn.body)) return [fn.body]
  const out: ts.Expression[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression)
    else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit)
  }
  ts.forEachChild(fn.body, visit)
  return out
}

/** T-B44: lo que está mal en el uso de un global del lenguaje, o null (GLOBALS). */
function globalProblem(id: ts.Identifier): string | null {
  const allowed = Object.prototype.hasOwnProperty.call(GLOBALS, id.text) ? GLOBALS[id.text] : undefined
  const p = id.parent
  const member =
    ts.isPropertyAccessExpression(p) && p.expression === id
      ? p.name.text
      : ts.isElementAccessExpression(p) && p.expression === id
        ? ts.isStringLiteralLike(p.argumentExpression)
          ? p.argumentExpression.text
          : '[…]'
        : null
  if (allowed === true && member !== 'prototype' && member !== '[…]') return null
  if (Array.isArray(allowed) && member && allowed.includes(member)) return null
  return `${member ? `${id.text}.${member}` : id.text}: ${NOT_LISTED}`
}

// ─── La guardia ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Kind = 'db' | 'panel' | 'pure' | 'util' | 'capability' | 'other'
const kindOf = (file: string): Kind => {
  const rel = fromRoot(file)
  if (DB_HANDLES.includes(rel)) return 'db'
  if (PANEL.some(dir => rel.startsWith(dir))) return 'panel'
  if (PURE.includes(rel)) return 'pure'
  if (UTILS.includes(rel)) return 'util'
  return rel.startsWith(CAPABILITIES) ? 'capability' : 'other'
}
const ON_THE_LIST =
  'a capability reads only through panel services (src/services/dashboard, shared, legacy); besides them, only the B modules, the listed utils (UTILS), date-fns and date-fns-tz'

/** Cada problema del código de `files` que vigila esta guardia, como `archivo:renglón: qué`. Lo que no está en `files` se lee del disco. */
function guardProblems(files: Sources): string[] {
  const guarded = Object.keys(files).filter(f => f === CATALOG || f === ANSWER || (f.startsWith(CAPABILITIES) && f.endsWith('.ts')))
  const t = tree(files, guarded)
  const { checker } = t
  const problems: string[] = []
  const used = new Set<Exception>()
  const aliased = (s: ts.Symbol | undefined) => (s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s)
  const declFile = (s: ts.Symbol | undefined) => s?.declarations?.[0]?.getSourceFile().fileName
  const isTypeOnlySymbol = (id: ts.Identifier) => {
    const s = aliased(checker.getSymbolAtLocation(id))
    return !!s?.declarations?.length && !(s.flags & ts.SymbolFlags.Value)
  }
  const hasKey = (type: ts.Type, keys: string[]) => (type.isUnion() ? type.types : [type]).some(x => keys.some(k => x.getProperty(k)))
  const isDataScope = (type: ts.Type) =>
    (type.isUnion() ? type.types : [type]).some(x => {
      const s = x.aliasSymbol ?? x.getSymbol()
      return s?.name === 'DataScope' && fromRoot(declFile(s) ?? '') === CATALOG
    })

  for (const file of guarded) {
    const sf = t.source(path.join(ROOT, file))
    const kind = file === ANSWER ? 'answer' : file === CATALOG ? 'catalog' : 'capability'
    const report = (node: ts.Node, what: string) => problems.push(`${lineOf(sf, node)}: ${what}`)
    /** Lo importado que ya falló: sus usos no se vuelven a reportar. */
    const refused = new Set<ts.Symbol>()
    const clientLocals = new Map<ts.Symbol, Exception>()

    // ── Lo que importa: la lista cerrada, resuelta por el compilador ──
    for (const l of loadsOf(sf)) {
      if (l.typeOnly) continue
      if (l.reexport && kind === 'capability') {
        report(l.node, `re-exports from ${l.spec}: a capability exports only what it declares`)
        continue
      }
      const target = t.resolve(l.spec, sf.fileName)
      for (const b of l.bindings) {
        if (b.local && isTypeOnlySymbol(b.local)) continue
        const what = `imports ${b.name === '*' ? 'the module' : b.name} from ${l.spec}`
        const refuse = (why: string) => {
          report(l.node, `${what}: ${why}`)
          const s = b.local && checker.getSymbolAtLocation(b.local)
          if (s) refused.add(s)
        }
        const exception = EXCEPTIONS.find(
          e =>
            e.file === file &&
            e.names.includes(b.name) &&
            e.from === ('file' in target ? fromRoot(target.file) : 'pkg' in target ? target.pkg : ''),
        )
        if (exception) {
          used.add(exception)
          const s = b.local && checker.getSymbolAtLocation(b.local)
          if (exception.onlyAsFirstArgumentOf && s) clientLocals.set(s, exception)
        } else if ('missing' in target) refuse('no such module')
        else if ('pkg' in target) {
          if (!PACKAGES.some(p => target.pkg === p)) refuse(`only ${PACKAGES.join(', ')} (no database driver)`)
        } else {
          const k = kindOf(target.file)
          const banned = k === 'util' && kind === 'capability' ? utilBan(target.file, b.name) : undefined
          if (k === 'db') refuse('the database client or a database pool; read through a panel service')
          else if (banned) refuse(banned)
          else if (k === 'pure' || k === 'util' || (k === 'panel' && kind === 'capability') || (k === 'capability' && kind === 'catalog')) {
            /* en la lista */
          } else if (k === 'capability' && kind === 'capability') refuse('only types come from another capability (import type)')
          else if (k === 'other' && kind === 'capability' && fromRoot(target.file).startsWith('src/utils/'))
            refuse('only the listed utils (UTILS), named one by one: add it there if it is pure, with its reason')
          else refuse(kind === 'capability' ? ON_THE_LIST : `not on the list of what ${file} may import (EXCEPTIONS, with its reason)`)
        }
      }
    }
    for (const p of prismaProblems(t, sf)) report(p.node, p.what)

    // ── Segunda red: SQL crudo, la conexión, los delegados de los modelos; y código dinámico ──
    const lastName = (e: ts.Expression): string | null => {
      e = unwrap(e)
      if (ts.isIdentifier(e)) return e.text
      if (ts.isPropertyAccessExpression(e)) return e.name.text
      if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text
      return null
    }
    const visitDb = (node: ts.Node): void => {
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && RAW.has(node.text))
        report(node, `${node.text}: raw SQL or a transaction`)
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(unwrap(node.expression)) &&
        CLIENT_NAMES.has((unwrap(node.expression) as ts.Identifier).text)
      )
        report(node, `${(unwrap(node.expression) as ts.Identifier).text}. member access: the database client`)
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression)
        if (ts.isPropertyAccessExpression(callee) && MODEL_ACTIONS.has(callee.name.text)) {
          const model = lastName(callee.expression)
          if (model && MODEL_DELEGATES.has(model)) report(node, `${model}.${callee.name.text}(): a Prisma model read or write`)
        }
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) report(node, `import(): ${NO_DYNAMIC}`)
      }
      if (ts.isIdentifier(node) && DYNAMIC.has(node.text) && isReference(node)) report(node, `${node.text}: ${NO_DYNAMIC}`)
      if (ts.isIdentifier(node) && clientLocals.size && isReference(node)) {
        const exception = clientLocals.get(checker.getSymbolAtLocation(node)!)
        const call = node.parent
        const callee =
          ts.isCallExpression(call) && call.arguments[0] === node ? aliased(checker.getSymbolAtLocation(call.expression)) : undefined
        if (exception && callee?.name !== exception.onlyAsFirstArgumentOf)
          report(node, `${node.text}: the database client, allowed here only as the first argument of ${exception.onlyAsFirstArgumentOf}()`)
      }
      ts.forEachChild(node, visitDb)
    }
    visitDb(sf)
    if (kind === 'answer') continue

    // ── Una capacidad: cada nombre que usa, resuelto (regla 2, 3 y la lista) ──
    const panelCall = (call: ts.Node): boolean => {
      if (!ts.isCallExpression(call) && !ts.isNewExpression(call)) return false
      const declared = checker.getResolvedSignature(call)?.declaration
      const fileOf =
        declared && !ts.isJSDocSignature(declared)
          ? declared.getSourceFile().fileName
          : declFile(aliased(checker.getSymbolAtLocation(call.expression)))
      return !!fileOf && kindOf(fileOf) === 'panel'
    }
    const panelReference = (id: ts.Identifier, target: ts.Symbol) => {
      let e: ts.Node = id
      while ((ts.isPropertyAccessExpression(e.parent) && e.parent.expression === e) || ts.isParenthesizedExpression(e.parent)) e = e.parent
      const call = e.parent
      const callee = (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === e
      if (callee && panelCall(call)) return
      if (callee && !checker.getResolvedSignature(call)?.declaration)
        return report(
          id,
          `${id.text}: the guard cannot resolve which panel function this calls; import it from the file that declares it (T-B42b)`,
        )
      if (callee || !noData(declFile(target), target.name))
        report(
          id,
          `${id.text}: a panel service is only called (directly, or as Service.method), never passed around, aliased or reached through .call`,
        )
    }
    const visitNames = (node: ts.Node): void => {
      if (kind === 'capability' && ts.isIdentifier(node) && isReference(node) && !DYNAMIC.has(node.text)) {
        const local = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node)
        if (!local) report(node, `${node.text}: the guard cannot see what it is (the compiler does not resolve it)`)
        else if (local.flags & ts.SymbolFlags.Alias) {
          const imported = local.declarations?.[0]
          const decl = imported && ts.findAncestor(imported, n => ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n))
          const spec =
            decl && ts.isImportDeclaration(decl)
              ? (decl.moduleSpecifier as ts.StringLiteral).text
              : decl && ts.isImportEqualsDeclaration(decl) && ts.isExternalModuleReference(decl.moduleReference)
                ? (decl.moduleReference.expression as ts.StringLiteral).text
                : null
          const target = spec ? t.resolve(spec, sf.fileName) : null
          if (!refused.has(local) && target && 'file' in target) {
            const final = checker.getAliasedSymbol(local)
            const where = declFile(final)
            const k = where && kindOf(where)
            if (!where) report(node, `${node.text}: the guard cannot see where it is declared; import it from the file that declares it`)
            else if (k === 'db') report(node, `${node.text} comes from ${fromRoot(where)}: the database client or a database pool`)
            else if (k === 'panel') panelReference(node, final)
            else if (k === 'util' && utilBan(where, final.name)) report(node, `${node.text}: ${utilBan(where, final.name)}`)
            else if (k !== 'pure' && k !== 'util') report(node, `${node.text} is declared in ${fromRoot(where)}: ${ON_THE_LIST}`)
          }
        } else {
          const where = local.declarations?.[0]?.getSourceFile()
          const global = where && where !== sf && !where.fileName.startsWith(path.join(ROOT, 'src'))
          if (global && !t.program.isSourceFileDefaultLibrary(where))
            report(node, `${node.text}: a global that is not part of the language (${fromRoot(where.fileName)})`)
          else if (global) {
            const bad = globalProblem(node)
            if (bad) report(node, bad)
          } else if (!where && !['undefined', 'arguments'].includes(node.text))
            report(node, `${node.text}: the guard cannot see what it is`)
        }
      }
      if (kind === 'capability' && ts.isElementAccessExpression(node)) {
        const root = rootOf(node.expression)
        const s = ts.isIdentifier(root) ? checker.getSymbolAtLocation(root) : undefined
        if (s && s.flags & ts.SymbolFlags.Alias)
          report(node, `${root.getText(sf)}[…]: brackets on something imported hide what is used; ${NO_DYNAMIC}`)
      }
      if (kind === 'capability' && ts.isStringLiteralLike(node) && CUID.test(node.text))
        report(node, `'${node.text}': a text shaped like an id (cuid); the venue comes only from the scope`)
      if (
        kind === 'capability' &&
        ts.isExportDeclaration(node) &&
        !node.moduleSpecifier &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      )
        for (const el of node.exportClause.elements) {
          const s = checker.getExportSpecifierLocalTargetSymbol(el)
          if (s && s.flags & ts.SymbolFlags.Alias)
            report(el, `exports ${el.name.text}, which it imported: a capability exports only what it declares`)
        }
      ts.forEachChild(node, visitNames)
    }
    visitNames(sf)

    // ── La sucursal sólo sale del alcance (T-B41, T-B41b, T-B41c) ──
    const isScopeParameter = (p: ts.ParameterDeclaration) => isDataScope(checker.getTypeAtLocation(p))
    const fromScope = (e: ts.Expression, key: string): boolean => {
      e = unwrap(e)
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'scope')
        return e.name.text === FIELD[key]
      if (key === 'venueIds' && ts.isArrayLiteralExpression(e))
        return e.elements.length > 0 && e.elements.every(el => !ts.isSpreadElement(el) && fromScope(el, 'venueId'))
      return false
    }
    /** El patrón desestructura alguno de estos nombres (por su llave o por el nombre que le da). */
    const binds = (pattern: ts.BindingName, names: Set<string>): boolean =>
      !ts.isIdentifier(pattern) &&
      pattern.elements.some(
        el =>
          !ts.isOmittedExpression(el) &&
          (binds(el.name, names) || names.has(nameText(el.name) ?? '') || names.has(nameText(el.propertyName) ?? '')),
      )
    const bindsTenant = (pattern: ts.BindingName) => binds(pattern, TENANT) || binds(pattern, ORG)
    const isScopeIdentifier = (e: ts.Expression | undefined) =>
      !!e && ts.isIdentifier(unwrap(e)) && (unwrap(e) as ts.Identifier).text === 'scope'
    const touchesTenant = (n: ts.Node): boolean =>
      (ts.isIdentifier(n) &&
        (TENANT.has(n.text) || n.text === 'scope') &&
        !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
        !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) ||
      ts.forEachChild(n, touchesTenant) === true

    const visitVenue = (node: ts.Node): void => {
      // T-B41b: la organización, de ningún modo
      if (
        (ts.isPropertyAccessExpression(node) && isScopeIdentifier(node.expression) && ORG.has(node.name.text)) ||
        (ts.isElementAccessExpression(node) &&
          isScopeIdentifier(node.expression) &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          ORG.has(node.argumentExpression.text))
      )
        report(node, `scope.organizationId: ${NO_ORG}`)
      if (
        (ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node)) &&
        ORG.has(node.name?.text ?? '')
      )
        report(node, `an import named ${node.name!.text}: ${NO_ORG}`)
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
        ts.isIdentifier(node.name) &&
        ORG.has(node.name.text) &&
        !isSignature(node.parent)
      )
        report(node, `${node.name.text} declared: ${NO_ORG}`)
      if (ts.isBindingElement(node) && (ORG.has(nameText(node.name) ?? '') || ORG.has(nameText(node.propertyName) ?? '')))
        report(node, `organizationId destructured: ${NO_ORG}`)
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ORG.has(nameText(node.name) ?? ''))
        report(node, `${nameText(node.name)}: ${NO_ORG}`)
      if (ts.isSpreadAssignment(node) && isScopeIdentifier(node.expression))
        report(node, `{ ...scope } carries the organisation: ${NO_ORG}`)
      // Quién se puede llamar venueId, orgId o scope
      if (ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node)) {
        const n = node.name?.text
        if (n && (TENANT.has(n) || n === 'scope')) report(node, `an import named ${n}: ${FROM_SCOPE}`)
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && (TENANT.has(node.name.text) || node.name.text === 'scope'))
        report(node, `a variable named ${node.name.text}: ${FROM_SCOPE}`)
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && !inType(node) && !isSignature(node.parent)) {
        const n = node.name.text
        if (TENANT.has(n)) report(node, `a parameter named ${n}: receive the scope and ${FROM_SCOPE}`)
        if (n === 'scope' && (node.initializer || node.dotDotDotToken || !isScopeParameter(node)))
          report(node, 'a parameter named scope that is not the capability scope (type it DataScope, no default)')
      }
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
        const n = node.name.text
        if (n === 'scope') report(node, `a destructured scope: ${FROM_SCOPE}`)
        if (TENANT.has(n)) {
          const field = nameText(node.propertyName) ?? n
          const owner = node.parent.parent
          const ofScope =
            ts.isObjectBindingPattern(node.parent) &&
            ((ts.isVariableDeclaration(owner) && isScopeIdentifier(owner.initializer)) ||
              (ts.isParameter(owner) && isScopeParameter(owner)))
          if (!ofScope || field !== FIELD[n] || node.initializer || node.dotDotDotToken)
            report(node, `${n} destructured from something else: ${FROM_SCOPE}`)
        }
      }
      // Nadie le asigna al alcance ni a esos nombres
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        touchesTenant(unwrap(node.left))
      )
        report(node, 'assigns to the scope or to a venue id')
      // Las llaves de un objeto
      if (ts.isPropertyAssignment(node)) {
        const key = nameText(node.name)
        if (key && TENANT.has(key) && !fromScope(node.initializer, key)) report(node, `${key}: ${FROM_SCOPE}`)
      }
      if (ts.isShorthandPropertyAssignment(node) && TENANT.has(node.name.text)) report(node, `${node.name.text}: ${FROM_SCOPE}`)
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) checkArguments(node)
      ts.forEachChild(node, visitVenue)
    }
    /** Los argumentos de una llamada a una función del repo, contra los parámetros de la declaración que resuelve el checker. */
    const checkArguments = (call: ts.CallExpression | ts.NewExpression) => {
      const declared = checker.getResolvedSignature(call)?.declaration
      if (!declared || ts.isJSDocSignature(declared) || !declared.getSourceFile().fileName.startsWith(path.join(ROOT, 'src'))) return
      const panel = kindOf(declared.getSourceFile().fileName) === 'panel'
      const holder = declared.parent
      const name =
        (ts.isFunctionDeclaration(declared) || ts.isMethodDeclaration(declared)) && declared.name
          ? nameText(declared.name)
          : ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder)
            ? nameText(holder.name)
            : null
      let carried = false
      const params = declared.parameters
      const args = call.arguments ?? ts.factory.createNodeArray<ts.Expression>()
      const shown = call.expression.getText(sf)
      if (panel && args.some(a => isScopeIdentifier(a)))
        report(call, `${shown}(): a panel service never receives the whole scope, it carries the organisation: pass scope.venueId (T-B41b)`)
      const tenantAt = params.findIndex(
        p => (ts.isIdentifier(p.name) && (TENANT.has(p.name.text) || ORG.has(p.name.text))) || bindsTenant(p.name),
      )
      if (tenantAt >= 0 && args.slice(0, tenantAt + 1).some(ts.isSpreadElement))
        return report(call, `${shown}(): a spread argument hides where the venue goes`)
      params.forEach((p, i) => {
        const type = checker.getTypeAtLocation(p)
        if (ts.isIdentifier(p.name) && ORG.has(p.name.text)) {
          if (args[i] !== undefined) report(call, `${shown}(): its ${p.name.text} parameter gets a value; ${NO_ORG}`)
        } else if (ts.isIdentifier(p.name) && TENANT.has(p.name.text)) {
          const key = p.name.text
          const given = p.dotDotDotToken ? args.slice(i) : [args[i]]
          if (given.some(a => a === undefined) || !given.length) report(call, `${shown}(): gets no ${key}; pass scope.${FIELD[key]}`)
          else if (given.some(a => ts.isSpreadElement(a) || !fromScope(a, p.dotDotDotToken ? 'venueId' : key)))
            report(call, `${shown}(): its ${key} argument is not the scope's; ${FROM_SCOPE}`)
          else carried = true
        } else if (args[i] !== undefined && isDataScope(type)) {
          if (!isScopeIdentifier(args[i])) report(call, `${shown}(): its DataScope parameter gets something else; pass only the real scope`)
        } else if (args[i] !== undefined && (bindsTenant(p.name) || (panel && hasKey(type, [...TENANT, ...ORG])))) {
          const a = unwrap(args[i])
          const ok = ts.isObjectLiteralExpression(a) || (isScopeIdentifier(a) && !binds(p.name, ORG) && !panel)
          if (!ok) report(call, `${shown}(): pass its options as an object literal (so the venue key is checked)`)
          const bad = ts.isObjectLiteralExpression(a) && !panel && literalProblem(a)
          if (bad) report(call, `${shown}(): ${bad}`)
        }
      })
      if (!panel) return
      const literals = args.map(unwrap).filter(ts.isObjectLiteralExpression)
      for (const bad of new Set(literals.map(literalProblem).filter(Boolean))) report(call, `${shown}(): ${bad}`)
      if (literals.some(protects)) carried = true
      if (!carried && !noData(declared.getSourceFile().fileName, name)) report(call, `${shown}(): ${CARRY}`)
    }
    const isScopeVenue = (q: ts.ObjectLiteralElementLike) =>
      ts.isPropertyAssignment(q) && nameText(q.name) === 'venueId' && fromScope(q.initializer, 'venueId')
    const isScopeVenues = (q: ts.ObjectLiteralElementLike) =>
      ts.isPropertyAssignment(q) && nameText(q.name) === 'venueIds' && fromScope(q.initializer, 'venueIds')
    /** Lo que puede escribir cualquier llave: un spread, o una llave calculada que no es un texto. */
    const opaque = (q: ts.ObjectLiteralElementLike) => ts.isSpreadAssignment(q) || (!!q.name && nameText(q.name) === null)
    const named = (q: ts.ObjectLiteralElementLike, name: string) => !!q.name && nameText(q.name) === name
    /** T-B42d: `venueId: scope.venueId` es lo ÚLTIMO del objeto (después, sólo `venueIds` del alcance), así que pisa lo de antes. */
    const protects = (l: ts.ObjectLiteralExpression) => {
      const k = l.properties.map(isScopeVenue).lastIndexOf(true)
      return k >= 0 && l.properties.slice(k + 1).every(isScopeVenues)
    }
    /** Lo que está mal en un objeto de opciones, o null. */
    const literalProblem = (l: ts.ObjectLiteralExpression): string | null => {
      if (l.properties.some(q => (ts.isGetAccessorDeclaration(q) || ts.isSetAccessorDeclaration(q)) && TENANT.has(nameText(q.name) ?? '')))
        return 'a getter or setter for the venue: write venueId: scope.venueId (T-B42d)'
      if (l.properties.some(q => named(q, '__proto__'))) return '__proto__ in the options (T-B42d)'
      if (l.properties.some(q => opaque(q) || named(q, 'venueId')) && !protects(l)) return LAST
      const plural = l.properties.findIndex(q => named(q, 'venueIds'))
      if (plural >= 0 && l.properties.slice(plural + 1).some(opaque)) return LAST // T-B42c: nada pisa el plural
      return null
    }
    visitVenue(sf)

    // ── T-B43: una negativa es un texto fijo elegido por llave; la etiqueta y el objeto, literales ──
    if (kind !== 'capability') continue
    const isDataReadRefusal = (e: ts.Expression) => {
      const s = aliased(checker.getSymbolAtLocation(unwrap(e)))
      return s?.name === 'DataReadRefusal' && fromRoot(declFile(s) ?? '') === READ_REFUSAL
    }
    const visitRefusals = (node: ts.Node): void => {
      const name =
        ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node)
          ? nameText(node.name)
          : null
      const value = ts.isPropertyAssignment(node) ? unwrap(node.initializer) : undefined
      if (name === 'notOffered') {
        const fn = ts.isMethodDeclaration(node) ? node : value
        if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)))
          report(node, `notOffered: ${FIXED}`)
        else
          for (const returned of returnedValues(fn)) {
            const bad = refusalProblem(returned, true)
            if (bad) report(returned, `notOffered: ${bad}`)
          }
      }
      if (name === 'refusal') {
        const bad = value ? refusalProblem(value, false) : FIXED
        if (bad) report(node, `refusal: ${bad}`)
      }
      if (name && ['key', 'label', 'object', 'aiHint'].includes(name) && !(value && ts.isStringLiteralLike(value)))
        report(node, `${name}: ${LITERAL}`)
      if (ts.isNewExpression(node) && isDataReadRefusal(node.expression)) {
        const given = node.arguments?.[1]
        const bad = given ? refusalProblem(given, false) : FIXED
        if (bad) report(node, `new DataReadRefusal(): ${bad}`)
      }
      ts.forEachChild(node, visitRefusals)
    }
    visitRefusals(sf)

    // ── T-B44: una capacidad sólo escribe sus variables locales ──
    /** La función que encierra a `n`; null en el nivel del módulo. */
    const fnOf = (n: ts.Node): ts.Node | null => ts.findAncestor(n.parent, ts.isFunctionLike) ?? null
    /** El destino es una variable o un parámetro declarado en la MISMA función que la escritura (no en otra, ni en el módulo). */
    const ownLocal = (target: ts.Expression, at: ts.Node): boolean => {
      if (!ts.isIdentifier(target)) return false
      const s = ts.isShorthandPropertyAssignment(target.parent)
        ? checker.getShorthandAssignmentValueSymbol(target.parent)
        : checker.getSymbolAtLocation(target)
      const decl = s?.valueDeclaration
      return (
        !!decl &&
        (ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isBindingElement(decl)) &&
        decl.getSourceFile() === sf &&
        fnOf(decl) !== null &&
        fnOf(decl) === fnOf(at)
      )
    }
    /** Lo que escribe una asignación: su destino, o cada hoja de un patrón (`[a, b] = …`, `({ a, b: c.d } = …)`, con sus valores por omisión). */
    const targetsOf = (e: ts.Expression): ts.Expression[] => {
      e = unwrap(e)
      if (ts.isArrayLiteralExpression(e))
        return e.elements.flatMap(el => (ts.isOmittedExpression(el) ? [] : targetsOf(ts.isSpreadElement(el) ? el.expression : el)))
      if (ts.isObjectLiteralExpression(e))
        return e.properties.flatMap(q =>
          ts.isPropertyAssignment(q)
            ? targetsOf(q.initializer)
            : ts.isShorthandPropertyAssignment(q)
              ? [q.name]
              : ts.isSpreadAssignment(q)
                ? targetsOf(q.expression)
                : [],
        )
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) return targetsOf(e.left)
      return [e]
    }
    /** La raíz de quien recibe un método: `this`, algo importado, un global o algo del nivel del módulo. */
    /**
     * Quien recibe un método que cambia es una variable (no un parámetro) declarada en la MISMA función que la llamada. Un parámetro
     * (el alcance, `scope.now`), lo que devuelve una llamada, algo importado, del módulo, un global o `this`, no.
     */
    const ownVariable = (root: ts.Expression, at: ts.Node): boolean => {
      if (!ts.isIdentifier(root)) return false
      const decl = checker.getSymbolAtLocation(root)?.valueDeclaration
      const holder = decl && ts.isBindingElement(decl) ? ts.walkUpBindingElementsAndPatterns(decl) : decl
      return (
        !!decl &&
        !!holder &&
        ts.isVariableDeclaration(holder) &&
        decl.getSourceFile() === sf &&
        fnOf(decl) !== null &&
        fnOf(decl) === fnOf(at)
      )
    }
    const isAssignment = (n: ts.BinaryExpression) =>
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    const visitWrites = (node: ts.Node): void => {
      const written = (target: ts.Expression, at: ts.Node) => {
        if (!ownLocal(target, at)) report(target, `${target.getText(sf)}: ${WRITES}`)
      }
      if (ts.isBinaryExpression(node) && isAssignment(node)) for (const target of targetsOf(node.left)) written(target, node)
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      )
        written(unwrap(node.operand), node)
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer))
        for (const target of targetsOf(node.initializer)) written(target, node)
      if (ts.isDeleteExpression(node)) report(node, `delete: ${WRITES}`)
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression)
        const method = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
            ? callee.argumentExpression.text
            : null
        if (
          method &&
          (MUTATORS.has(method) || SETTER.test(method)) &&
          !ownVariable(rootOf((callee as ts.PropertyAccessExpression).expression), node)
        )
          report(node, `${callee.getText(sf)}(): ${CHANGES}`)
      }
      // `.call`, `.apply` y `.bind` cambian a quién y con qué se llama una función: no se ven en la llamada
      const rebinding = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : null
      if (rebinding && ['call', 'apply', 'bind'].includes(rebinding)) report(node, `.${rebinding}: ${NO_REBIND}`)
      ts.forEachChild(node, visitWrites)
    }
    visitWrites(sf)

    // ── T-B45: una capacidad es un objeto literal; nada de clases ──
    const isCapabilityType = (type: ts.Type) =>
      (type.isUnion() ? type.types : [type]).some(x => {
        const s = x.getSymbol() ?? x.aliasSymbol
        return s?.name === 'DataCapability' && fromRoot(declFile(s) ?? '') === CATALOG
      })
    const visitShape = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) report(node, `class: ${OBJECT_LITERAL}`)
      if (node.kind === ts.SyntaxKind.ThisKeyword) report(node, `this: ${NO_THIS}`)
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        isCapabilityType(checker.getTypeAtLocation(node.name)) &&
        !ts.isObjectLiteralExpression(unwrap(node.initializer))
      )
        report(node, `${node.name.getText(sf)}: ${OBJECT_LITERAL}`)
      ts.forEachChild(node, visitShape)
    }
    visitShape(sf)
  }
  for (const e of EXCEPTIONS)
    if (guarded.includes(e.file) && !used.has(e))
      problems.push(`${e.file}: the exception for ${e.from} (${e.names.join(', ')}) is no longer used; remove it`)
  return [...problems, ...closureProblems(t)]
}

// ─── Lo de verdad ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const CAPABILITY_FILES = fs.existsSync(path.join(ROOT, CAPABILITIES)) ? listTs(path.join(ROOT, CAPABILITIES)).map(fromRoot) : []

it('the capabilities folder exists (a capability somewhere else would escape this guard)', () =>
  expect(fs.existsSync(path.join(ROOT, CAPABILITIES))).toBe(true))

// La primera vez lee del disco lo que importan (unos segundos); las muestras de abajo lo reusan.
it('no capability, nor the catalog, nor the orchestrator touches the database; the venue only comes from the scope', () => {
  const files = Object.fromEntries([...CAPABILITY_FILES, CATALOG, ANSWER].map(f => [f, read(f)]))
  expect(guardProblems(files)).toEqual([])
}, 60_000)

it('every module on the list exists (a typo would silently allow nothing)', () =>
  expect(
    [...PURE, ...UTILS, ...DB_HANDLES, ...PANEL_NO_DATA.map(x => x.file)].filter(
      f => !FUTURE.includes(f) && !fs.existsSync(path.join(ROOT, f)),
    ),
  ).toEqual([]))

it('a future module of the list does not exist yet (the task that creates it takes it out of FUTURE)', () =>
  expect(FUTURE.filter(f => fs.existsSync(path.join(ROOT, f)))).toEqual([]))

// ─── Las muestras: en memoria, para que la guardia tenga dientes aunque la carpeta esté vacía ─────────────────────────────────

const SAMPLE = `${CAPABILITIES}sample.ts`
const SAMPLE_PANEL = '@/services/dashboard/sampleByAmount.dashboard.service'
/** Un servicio NUEVO del panel, como el de C2, con sus opciones en un objeto. */
const NEW_PANEL = {
  'src/services/dashboard/sampleByAmount.dashboard.service.ts': [
    'export async function findPaymentsByAmount({ venueId, amount }: { venueId: string; amount: number }) { return [venueId, amount] }',
    'export const sumForVenues = async (venueIds: string[]) => venueIds.length',
    'export async function plansOfOrganization(organizationId: string) { return organizationId }',
    'export async function salesWithOrg(venueId: string, organizationId?: string) { return [venueId, organizationId] }',
    'export async function readWithScope(scope: { venueId: string }) { return scope.venueId }',
    'export interface DayFilter { venueId: string; day: string }',
    'export async function byFilter(filter: DayFilter) { return filter.day }',
    'export async function indexesReady() { return true }',
    'export async function salesMaybe(options?: { venueId?: string; day?: string }) { return options }',
    'export async function report(options: { venueId?: string; venueIds?: string[]; day?: string }) { return options }',
    "export async function rememberedFilter(venueId: string) { return { field: 'day' as 'day' | 'venueId', value: venueId } }",
  ].join('\n'),
  // R5-2: el tipo de las opciones vive en otro archivo; el checker no lo sigue y pierde sus llaves
  'src/services/dashboard/sampleFilter.types.ts': 'export interface Filter { venueId: string; day: string }\n',
  'src/services/dashboard/sampleImported.dashboard.service.ts':
    "import type { Filter } from './sampleFilter.types'\nexport async function byImportedFilter(filter: Filter) { return filter.day }\n",
}
const capability = (body: string, imports = '', more: Sources = {}): Sources => ({
  ...NEW_PANEL,
  ...more,
  [SAMPLE]: `import type { DataCapability, DataScope } from '../catalog'
import { DataReadRefusal } from '../catalog'
import { template } from '../check'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getSettlementCalendar } from '@/services/dashboard/availableBalance.dashboard.service'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import planStateService from '@/services/dashboard/planState.service'
import { byFilter, findPaymentsByAmount, indexesReady, plansOfOrganization, readWithScope, rememberedFilter, report, salesMaybe, salesWithOrg, sumForVenues } from '${SAMPLE_PANEL}'
${imports}
export const sample: DataCapability<any, any> = {
  key: 'sample', label: 'dato', object: 'el dato', aiHint: 'Dato.', permissions: ['reports:read'],
  params: () => ({ ok: true, value: { amount: 1 } }),
  render: (scope, _p, result) => { const t = template(scope.timezone); return t.done('Dato ' + t.money(result)) },
${body}
}
`,
})
const ID = 'ckq7z1x2y0000abcd1234efgh'
/**
 * Los servicios NUEVOS del panel que el plan le da a C2–C7, con su firma del plan (en memoria hasta que cada tarea los cree; el de C1,
 * `sumsLegacyQrPayments`, ya está en el puente). El de C8 (`cashDrawerWho.dashboard.service.ts`) ya no va aquí: su muestra corre con el
 * servicio de verdad, el que pasa `cashDrawerIndexesReady` como valor.
 */
const PLAN_PANEL: Sources = {
  'src/services/dashboard/paymentByAmount.dashboard.service.ts': [
    'export async function findPaymentsByAmount(venueId: string, input: { amount: number; windows: unknown[]; take: number }) { return { total: 0, rows: [venueId, input] } }',
    'export async function invoiceStateOfOrders(venueId: string, orderIds: string[]) { return new Map([[venueId, orderIds]]) }',
  ].join('\n'),
  'src/services/dashboard/openOrders.service.ts':
    'export async function listOpenOrdersBrief(venueId: string, since: Date, take: number) { return { total: take, orders: [venueId, since] } }\n',
  'src/services/dashboard/settlementWeekByGroups.service.ts':
    'export async function getSettlementWeekByGroups(venueId: string, weekStart: Date, weekEnd: Date, venueTimezone: string, caps: { groups: number; timeoutMs: number }) { return [venueId, weekStart, weekEnd, venueTimezone, caps] }\n',
}
const planCapability = (body: string, imports: string) => capability(body, imports, PLAN_PANEL)
const BY_AMOUNT =
  "import { findPaymentsByAmount as byAmount, invoiceStateOfOrders } from '@/services/dashboard/paymentByAmount.dashboard.service'"
const BRIDGE = "import { sumsLegacyQrPayments } from '@/services/legacy/qrPayments.legacy.service'"
/** Un util de la lista (c) con algo más al final: lo de verdad sigue ahí. */
const listedUtil = (file: string, extra: string, more: Sources = {}): Sources => ({ ...more, [file]: `${read(file)}\n${extra}\n` })
const OWN_PRISMA =
  "import { PrismaClient } from '@prisma/client'\nconst db = new PrismaClient()\nexport async function total(venueId: string) { return db.payment.count({ where: { venueId } }) }"
const OWN_PG =
  "import pg from 'pg'\nconst pool = new pg.Pool()\nexport const total = (venueId: string) => pool.query('SELECT 1', [venueId])"
/** Un servicio del panel que re-exporta lo que no es del panel. */
const PANEL_RELAY = {
  'src/services/dashboard/sampleRelay.dashboard.service.ts': [
    "export { calculateSettlementDate } from '@/services/payments/settlementCalculation.service'",
    "export { default as db } from '@/utils/prismaClient'",
  ].join('\n'),
}

it.each<[string, Sources]>([
  ['a panel service called with scope.venueId', capability('read: async scope => getSalesSummary(scope.venueId, { from: scope.now })')],
  [
    'C1: the bridge condition and the sales summary',
    planCapability(
      `notOffered: scope => (sumsLegacyQrPayments(scope.venueId) ? 'SALES_LEGACY_QR' : null),
  read: async scope => {
    const { from, to } = wholeDayBounds('today', scope)
    const report = await getSalesSummary(scope.venueId, {
      startDate: from.toISOString(),
      endDate: to.toISOString(),
      groupBy: 'none',
      reportType: 'summary',
      timezone: scope.timezone,
      skipStaffCommissions: true,
    })
    if (report.legacyUnavailable) throw new Error('incomplete')
    return report.summary
  }`,
      `${BRIDGE}\nimport { wholeDayBounds } from '../params'`,
    ),
  ],
  [
    'C2: a payment by its amount',
    planCapability(
      'read: async (scope, p) => byAmount(scope.venueId, { amount: p.amount, windows: p.windows, take: scope.rows })',
      BY_AMOUNT,
    ),
  ],
  [
    'C3: the open orders',
    planCapability(
      'read: async scope => listOpenOrdersBrief(scope.venueId, lastDaysStart(scope.openOrdersDays, scope), scope.rows)',
      "import { listOpenOrdersBrief } from '@/services/dashboard/openOrders.service'\nimport { lastDaysStart } from '../params'",
    ),
  ],
  [
    'C4: the reservations of today',
    planCapability(
      `gate: { featureCode: 'RESERVATIONS', gateKind: 'FEATURE', refusal: 'PLAN_RESERVATIONS' },
  params: request =>
    request.day === null || request.day === 'today' ? { ok: true, value: {} } : { ok: false, refusal: 'RESERVATIONS_TODAY_ONLY' },
  read: async scope =>
    SharedQueryService.getReservations(scope.venueId, wholeDayBounds('today', scope), { limit: scope.rows }, scope.timezone),`,
      "import { wholeDayBounds } from '../params'",
    ),
  ],
  [
    'C5: the plan',
    planCapability(
      'read: async scope => getPlanState(scope.venueId, { skipPauseOffer: true, stripeTimeoutMs: 3_000 })',
      "import { getPlanState } from '@/services/dashboard/planState.service'",
    ),
  ],
  [
    'C6: the week of the panel, the deposits and a refusal',
    planCapability(
      `read: async scope => {
    const { weekStart, weekEnd } = venueWeekBounds(scope.day, scope.timezone)
    const week = await getSettlementWeekByGroups(scope.venueId, weekStart, weekEnd, scope.timezone, { groups: scope.depositGroups, timeoutMs: scope.depositTimeoutMs })
    if (!week) throw new DataReadRefusal('OVER_CAP', 'DEPOSITS_OVER_CAP')
    return week
  }`,
      "import { venueWeekBounds } from '@/services/dashboard/settlementCalendar.dashboard.service'\nimport { getSettlementWeekByGroups } from '@/services/dashboard/settlementWeekByGroups.service'",
    ),
  ],
  [
    'C7: the invoice of the sale of a payment',
    planCapability(
      `gate: { featureCode: 'CFDI', gateKind: 'FEATURE', refusal: 'PLAN_INVOICES' },
  read: async (scope, p) => {
    const found = await byAmount(scope.venueId, { amount: p.amount, windows: p.windows, take: 5 })
    const sales = [...new Set(found.rows.map(String))]
    return sumsLegacyQrPayments(scope.venueId) || invoiceStateOfOrders(scope.venueId, sales)
  }`,
      `${BY_AMOUNT}\n${BRIDGE}`,
    ),
  ],
  [
    'C8: who opened the cash drawer, and its indexes as available',
    planCapability(
      `available: cashDrawerIndexesReady,
  params: request =>
    request.day === 'other' ? { ok: false, refusal: 'CASH_DRAWER_TODAY_OR_YESTERDAY' } : { ok: true, value: { day: request.day ?? 'today' } },
  read: async (scope, p) => readCashDrawers(scope.venueId, dayBounds(p.day, scope), scope.rows)`,
      "import { cashDrawerIndexesReady, readCashDrawers } from '@/services/dashboard/cashDrawerWho.dashboard.service'\nimport { dayBounds } from '../params'",
    ),
  ],
  [
    'anything before the venue key: a spread, a property, a computed key (T-B42d)',
    capability('read: async (scope, p) => report({ ...p.filters, day: scope.day, [p.k]: p.v, venueId: scope.venueId })'),
  ],
  [
    'the venue key last, followed only by the plural (T-B42d)',
    capability('read: async scope => report({ day: scope.day, venueId: scope.venueId, venueIds: [scope.venueId] })'),
  ],
  ['a spread before the venue key (T-B42c)', capability('read: async (scope, p) => report({ ...p.filters, venueId: scope.venueId })')],
  [
    'a spread before the venue key and the plural key (T-B42c)',
    capability('read: async (scope, p) => report({ ...p.filters, venueId: scope.venueId, venueIds: [scope.venueId] })'),
  ],
  [
    'options with a spread BEFORE the venue key, whose type lives in another file',
    capability(
      'read: async (scope, p) => byImportedFilter({ ...p.options, venueId: scope.venueId })',
      "import { byImportedFilter } from '@/services/dashboard/sampleImported.dashboard.service'",
    ),
  ],
  [
    'the parsers of the B and a panel read with its options (what C2 and C8 use)',
    capability(
      'read: async (scope, p) => windowsOf(p.message, p.time, scope) && findPaymentsByAmount({ amount: p.amount, venueId: scope.venueId })',
      `import { dayBounds, matchAmount, timeWindows } from '../params'
function windowsOf(message: string, time: string | null, scope: DataScope) {
  return matchAmount(message, null) && timeWindows(time, message, 'today', scope) && dayBounds('today', scope)
}`,
    ),
  ],
  [
    'the week of the panel and a refusal (what C6 uses)',
    capability(
      `read: async scope => {
    const { weekStart, weekEnd } = venueWeekBounds(scope.day, scope.timezone)
    if (weekEnd < weekStart) throw new DataReadRefusal('OVER_CAP', 'DEPOSITS_OVER_CAP')
    return sumForVenues([scope.venueId])
  }`,
      "import { venueWeekBounds } from '@/services/dashboard/settlementCalendar.dashboard.service'",
    ),
  ],
  ['the settlement calendar', capability('read: async scope => getSettlementCalendar(scope.venueId, { from: scope.now, to: scope.now })')],
  [
    'a static method of a panel class',
    capability("read: async scope => SharedQueryService.getSalesForPeriod(scope.venueId, 'today', scope.timezone)"),
  ],
  [
    'a new panel service with its options in an object',
    capability('read: async (scope, p) => findPaymentsByAmount({ amount: p.amount, venueId: scope.venueId })'),
  ],
  [
    'options typed with the venue, as an object literal',
    capability('read: async scope => byFilter({ day: scope.day, venueId: scope.venueId })'),
  ],
  ['a list of venues with only the scope', capability('read: async scope => sumForVenues([scope.venueId])')],
  ['only the venue, leaving an optional organizationId out (T-B41b)', capability('read: async scope => salesWithOrg(scope.venueId)')],
  [
    'the limits of the deposits from the scope (T-B41c)',
    capability('read: async scope => sumForVenues([scope.venueId]) && scope.depositGroups + scope.depositTimeoutMs'),
  ],
  [
    'a refusal, a typed helper with the scope, Decimal, and a type import from anywhere',
    capability(
      `read: async scope => {
    if (windowOf(scope)) throw new DataReadRefusal('OVER_CAP', 'NOT_AVAILABLE')
    return new Prisma.Decimal(1)
  }`,
      `import { Prisma, type PaymentMethod } from '@prisma/client'
import type { CashDrawerSession } from '@/services/mobile/cash-drawer.mobile.service'
const CASH: PaymentMethod = 'CASH'
function windowOf(scope: DataScope) { return scope.now && CASH }`,
    ),
  ],
  [
    'the enums of @prisma/client as values, also through $Enums',
    capability(
      'read: async () => PaymentMethod.CASH === $Enums.PaymentMethod.CASH',
      "import { $Enums, PaymentMethod } from '@prisma/client'",
    ),
  ],
  // T-B43: una negativa se elige por su llave, literal; la condición puede ser cualquier cosa
  [
    'refusals chosen by their key: a ternary of two keys, null, a method that returns keys, the plan gate and DataReadRefusal (T-B43)',
    capability(
      `notOffered: scope => (sumsLegacyQrPayments(scope.venueId) ? (scope.kycVerified ? 'NOT_AVAILABLE' : 'PLAN_RESERVATIONS') : null),
  gate: { featureCode: 'RESERVATIONS', gateKind: 'FEATURE', refusal: 'PLAN_RESERVATIONS' },
  read: async scope => {
    if (!scope.kycVerified) throw new DataReadRefusal('OVER_CAP', scope.rows > 1 ? 'NOT_AVAILABLE' : 'PLAN_RESERVATIONS')
    return sumForVenues([scope.venueId])
  }`,
      BRIDGE,
      PLAN_PANEL,
    ),
  ],
  [
    'notOffered as a method with returns of a key and of null, and a params refusal by its key (T-B43)',
    capability(
      `notOffered(scope: DataScope) {
    if (scope.kycVerified) return null
    return 'NOT_AVAILABLE'
  },
  read: async scope => sumForVenues([scope.venueId]),`,
      "const paramsOf = (amount: string | null) => (amount ? { ok: true as const, value: { amount } } : { ok: false as const, refusal: 'PARAM_AMOUNT' as const })",
    ),
  ],
  [
    'the B payment texts that C2 creates (shared with C7)',
    capability('read: async () => paymentFormLabel()', "import { paymentFormLabel } from '../paymentText'", {
      'src/services/support/data/paymentText.ts': "export const paymentFormLabel = () => 'Efectivo'\n",
    }),
  ],
  // T-B44: lo propio de la función sí se escribe; los globales de la lista, sí se usan
  [
    'a local array built with push, a local counter with ++, -= and a swap of locals, a local Date setter, and the listed globals (T-B44)',
    capability(
      `read: async scope => {
    const out: number[] = []
    let n = 0
    let left = 2
    for (const x of [3, 1, 2]) {
      out.push(x)
      n++
      left -= 1
    }
    let a = 1
    let b = 2
    ;[a, b] = [b, a]
    const seen = new Map<string, number>()
    seen.set('n', n)
    out.sort((x, y) => x - y)
    const day = new Date(scope.now.getTime())
    day.setHours(0, 0, 0, 0)
    const { length } = out
    const copy = [...out]
    copy.reverse()
    const total = Object.keys({ a, b }).length + Math.max(...out) + Number('1') + JSON.stringify(out).length + left + length + day.getTime() + copy.length
    return Array.isArray(out) && Array.from(seen.values()).length + total + new Date(scope.now.getTime()).getTime() + (await sumForVenues([scope.venueId]))
  },`,
    ),
  ],
  [
    'a parameter reassigned in its own function, and a local of a for loop (T-B44)',
    capability(
      `params: (request, message) => {
    message = message.trim()
    for (let i = 0; i < 2; i++) message = message.toLowerCase()
    return request.amount ? { ok: true, value: { amount: message } } : { ok: false, refusal: 'PARAM_AMOUNT' }
  },
  read: async scope => sumForVenues([scope.venueId]),`,
    ),
  ],
])('the guard lets a capability through: %s', (_name, files) => expect(guardProblems(files)).toEqual([]))

/** T-B44: una capacidad con algo de su archivo antes (`more`) y su cuerpo: para las muestras de escritura. */
const writes = (body: string, more = '', extra: Sources = {}) =>
  capability(`${body}\n  read: async scope => sumForVenues([scope.venueId]),`, more, extra)
/**
 * T-B45: la clase de Codex b2-r3, que pasaba la guardia: metadatos literales, flechas para `params`/`read`/`render` y `notOffered` como
 * método del prototipo, que `{ ...c }` perdía al registrarla.
 */
const CODEX_CLASS = `class SampleCapability implements DataCapability<any, any> {
  key = 'codex'
  label = 'dato'
  object = 'el dato'
  aiHint = 'Dato.'
  permissions = ['reports:read']
  params = () => ({ ok: true as const, value: {} })
  read = async (scope: DataScope) => sumForVenues([scope.venueId])
  render = (scope: DataScope) => template(scope.timezone).done('Dato')
  notOffered(_scope: DataScope) {
    return 'NOT_AVAILABLE' as const
  }
}
export const fromClass: DataCapability<any, any> = new SampleCapability()`
/** Un módulo de la B con algo que se puede cambiar, importado por la capacidad (aquí paymentText, en memoria encima del de verdad). */
const PURE_LIST = { 'src/services/support/data/paymentText.ts': 'export const PAYMENT_WORDS: string[] = []\n' }

it.each<[string, Sources, string]>([
  // ── T-B44: un texto que se cree fijo no se cambia en ejecución (las dos sondas de Codex b2-r2 primero) ──
  [
    'Codex b2-r2 #1: Object.assign over the set of refusals inside notOffered',
    writes(
      `notOffered(scope: DataScope) {
    Object.assign(SUPPORT_DATA_REFUSALS, { NOT_AVAILABLE: scope.venueName })
    return 'NOT_AVAILABLE'
  },`,
      "import { SUPPORT_DATA_REFUSALS } from '../texts'",
    ),
    `Object.assign: ${NOT_LISTED}`,
  ],
  [
    'Codex b2-r2 #2: label and object reassigned after declaring them literal',
    writes(`notOffered(scope: DataScope) {
    sample.object = scope.venueName
    sample.label = scope.venueName
    return null
  },`),
    `sample.object: ${WRITES}`,
  ],
  [
    'the label reassigned (the other half of Codex b2-r2 #2)',
    writes('notOffered(scope: DataScope) {\n    sample.label = scope.venueName\n    return null\n  },'),
    `sample.label: ${WRITES}`,
  ],
  [
    'x[y] = on an object of the module',
    writes("notOffered: scope => ((TEXTS['a'] = scope.venueName), null),", "const TEXTS: Record<string, string> = { a: 'x' }"),
    `TEXTS['a']: ${WRITES}`,
  ],
  [
    'a variable of the module assigned',
    writes('notOffered: scope => ((last = scope.venueName), null),', "let last = ''"),
    `last: ${WRITES}`,
  ],
  ['+= on a variable of the module', writes('notOffered: scope => ((seen += scope.venueName), null),', "let seen = ''"), `seen: ${WRITES}`],
  ['-= on a variable of the module', writes('notOffered: scope => ((left -= scope.rows), null),', 'let left = 0'), `left: ${WRITES}`],
  ['++ on a counter of the module', writes('notOffered: () => (calls++, null),', 'let calls = 0'), `calls: ${WRITES}`],
  ['-- on a counter of the module', writes('notOffered: () => (--calls, null),', 'let calls = 0'), `calls: ${WRITES}`],
  [
    'a variable of another function written from a callback',
    writes(
      'notOffered: scope => {\n    let total = 0\n    ;[scope.rows].forEach(r => { total += r })\n    return total ? null : null\n  },',
    ),
    `total: ${WRITES}`,
  ],
  ['delete', writes('notOffered: () => (delete (sample as Record<string, unknown>).label, null),'), `delete: ${WRITES}`],
  [
    'a destructuring that writes a property',
    writes('notOffered: scope => {\n    ;[sample.label] = [scope.venueName]\n    return null\n  },'),
    `sample.label: ${WRITES}`,
  ],
  [
    'a for…of that writes a property',
    writes('notOffered: scope => {\n    for (sample.label of [scope.venueName]) break\n    return null\n  },'),
    `sample.label: ${WRITES}`,
  ],
  [
    'this.label = …',
    writes('notOffered(scope: DataScope) {\n    this.label = scope.venueName\n    return null\n  },'),
    `this.label: ${WRITES}`,
  ],
  ...(['defineProperty', 'defineProperties', 'setPrototypeOf'] as const).map((m): [string, Sources, string] => [
    `Object.${m}`,
    writes(`notOffered: scope => (Object.${m}(sample, 'label', { value: scope.venueName }), null),`),
    `Object.${m}: ${NOT_LISTED}`,
  ]),
  ...(['set', 'defineProperty', 'deleteProperty'] as const).map((m): [string, Sources, string] => [
    `Reflect.${m}`,
    writes(`notOffered: scope => (Reflect.${m}(sample, 'label', scope.venueName), null),`),
    `Reflect.${m}: ${NOT_LISTED}`,
  ]),
  ['Object kept in a variable', writes('notOffered: () => { const O = Object; return O ? null : null },'), `Object: ${NOT_LISTED}`],
  [
    'a mutating method through Array.prototype',
    writes('notOffered: scope => (Array.prototype.push.call(sample.permissions, scope.venueName), null),'),
    `Array.prototype: ${NOT_LISTED}`,
  ],
  [
    'a global of the browser library: fetch',
    writes("notOffered: scope => (fetch('https://x.test/' + scope.venueName), null),"),
    `fetch: ${NOT_LISTED}`,
  ],
  ...[...MUTATORS].map((m): [string, Sources, string] => [
    `.${m}() on an array of the module`,
    writes(`notOffered: scope => (BAG.${m}(scope.venueName), null),`, 'const BAG: any = []'),
    `BAG.${m}(): ${CHANGES}`,
  ]),
  [
    '.push() on something imported from a B module',
    writes(
      'notOffered: scope => (PAYMENT_WORDS.push(scope.venueName), null),',
      "import { PAYMENT_WORDS } from '../paymentText'",
      PURE_LIST,
    ),
    `PAYMENT_WORDS.push(): ${CHANGES}`,
  ],
  [
    '.push() on this',
    writes('notOffered(scope: DataScope) {\n    this.permissions.push(scope.venueName)\n    return null\n  },'),
    `this.permissions.push(): ${CHANGES}`,
  ],
  [
    'a Date setter on a parameter: scope.now.setHours (it would move the envelope)',
    writes('notOffered: scope => (scope.now.setHours(0, 0, 0, 0), null),'),
    `scope.now.setHours(): ${CHANGES}`,
  ],
  [
    'a Date setter on a parameter of the read, by its UTC name',
    capability('read: async scope => {\n    scope.now.setUTCDate(1)\n    return sumForVenues([scope.venueId])\n  },'),
    `scope.now.setUTCDate(): ${CHANGES}`,
  ],
  [
    '.sort() on a parameter (the result the read gave)',
    capability("render: (scope, _p, result) => { result.rows.sort(); return template(scope.timezone).done('Dato') },"),
    `result.rows.sort(): ${CHANGES}`,
  ],
  [
    '.push() on the result of a call',
    writes('notOffered: scope => (list().push(scope.venueName), null),', 'const list = (): string[] => []'),
    `list().push(): ${CHANGES}`,
  ],
  [
    '.call',
    writes('notOffered: scope => (pick.call(sample, scope), null),', 'function pick(scope: DataScope) { return scope.rows }'),
    `.call: ${NO_REBIND}`,
  ],
  [
    '.apply',
    writes('notOffered: scope => (pick.apply(sample, [scope]), null),', 'function pick(scope: DataScope) { return scope.rows }'),
    `.apply: ${NO_REBIND}`,
  ],
  [
    '.bind',
    writes('notOffered: scope => (pick.bind(sample)(scope), null),', 'function pick(scope: DataScope) { return scope.rows }'),
    `.bind: ${NO_REBIND}`,
  ],
  // ── T-B45 (Codex b2-r3): una clase esconde sus métodos en el prototipo, y la copia `{ ...c }` del catálogo de entonces los perdía ──
  ['Codex b2-r3: a capability written as a class', writes('', CODEX_CLASS), `class: ${OBJECT_LITERAL}`],
  ['Codex b2-r3: the capability made with new', writes('', CODEX_CLASS), `fromClass: ${OBJECT_LITERAL}`],
  // ── T-B46 (Codex b2-r4): un método que lee una bandera por `this` dependía de cómo se le llama ──
  [
    'Codex b2-r4: notOffered reads a flag of the same object through this',
    writes("closed: true,\n  notOffered() {\n    return this.closed ? ('NOT_AVAILABLE' as const) : null\n  },"),
    `this: ${NO_THIS}`,
  ],
  [
    'Codex b2-r4: the flag brought by a spread',
    writes(
      "...FLAGS,\n  notOffered() {\n    return this.closed ? ('NOT_AVAILABLE' as const) : null\n  },",
      'const FLAGS = { closed: true }',
    ),
    `this: ${NO_THIS}`,
  ],
  [
    'a class expression',
    writes('', 'const Made = class {\n  notOffered() {\n    return null\n  }\n}\nexport const made = new Made()'),
    `class: ${OBJECT_LITERAL}`,
  ],
  [
    'a capability returned by a call',
    writes('', 'const make = (): DataCapability<any, any> => sample\nexport const made: DataCapability<any, any> = make()'),
    `made: ${OBJECT_LITERAL}`,
  ],
  [
    'an aiHint from a variable',
    capability('aiHint: HINT,\n  read: async scope => sumForVenues([scope.venueId]),', "const HINT = 'Dato.'"),
    `aiHint: ${LITERAL}`,
  ],
  ['a key from a template', capability("key: `sam${'ple'}`,\n  read: async scope => sumForVenues([scope.venueId]),"), `key: ${LITERAL}`],
  // ── README regla 8 (C1, D19): el día sale de params.ts, nunca de venueStartOfDay/venueEndOfDay ──
  [
    'venueStartOfDay from the datetime util (README rule 8)',
    capability(
      'read: async scope => sumForVenues([scope.venueId]) && venueStartOfDay(scope.timezone, scope.now)',
      "import { venueStartOfDay } from '@/utils/datetime'",
    ),
    `imports venueStartOfDay from @/utils/datetime: ${UTIL_BANNED[0].why}`,
  ],
  [
    'venueEndOfDay under another name (README rule 8)',
    capability(
      'read: async scope => sumForVenues([scope.venueId]) && end(scope.timezone, scope.now)',
      "import { venueEndOfDay as end } from '@/utils/datetime'",
    ),
    `imports venueEndOfDay from @/utils/datetime: ${UTIL_BANNED[0].why}`,
  ],
  [
    'the datetime util as a namespace (README rule 8)',
    capability(
      'read: async scope => sumForVenues([scope.venueId]) && dt.venueStartOfDay(scope.timezone, scope.now)',
      "import * as dt from '@/utils/datetime'",
    ),
    `imports the module from @/utils/datetime: ${UTIL_BANNED[0].why}`,
  ],
  [
    'venueStartOfDay re-exported by a B module (README rule 8)',
    capability(
      'read: async scope => sumForVenues([scope.venueId]) && venueStartOfDay(scope.timezone, scope.now)',
      "import { venueStartOfDay } from '../params'",
      listedUtil('src/services/support/data/params.ts', "export { venueStartOfDay } from '@/utils/datetime'"),
    ),
    `venueStartOfDay: ${UTIL_BANNED[0].why}`,
  ],
  [
    'C1: its key built from a template',
    capability(
      'read: async scope => sumForVenues([scope.venueId]),',
      "const todayOnly = () => ({ ok: false as const, refusal: `SALES_${'TODAY_ONLY'}` })",
    ),
    `refusal: ${FIXED}`,
  ],
  [
    'C4: its key built from a template',
    capability(
      "params: () => ({ ok: false as const, refusal: `RESERVATIONS_${'TODAY_ONLY'}` }),\n  read: async scope => sumForVenues([scope.venueId]),",
    ),
    `refusal: ${FIXED}`,
  ],
  [
    'C7: its key built from a template',
    capability(
      "gate: { featureCode: 'CFDI', gateKind: 'FEATURE', refusal: `PLAN_${'INVOICES'}` },\n  read: async scope => sumForVenues([scope.venueId]),",
    ),
    `refusal: ${FIXED}`,
  ],
  [
    'C8: its key built from a template',
    capability(
      "params: () => ({ ok: false as const, refusal: `CASH_DRAWER_${'TODAY_OR_YESTERDAY'}` }),\n  read: async scope => sumForVenues([scope.venueId]),",
    ),
    `refusal: ${FIXED}`,
  ],
  [
    'C6: its key built from a template',
    capability(
      "read: async scope => {\n    if (scope.rows > 1) throw new DataReadRefusal('OVER_CAP', `DEPOSITS_${'OVER_CAP'}`)\n    return sumForVenues([scope.venueId])\n  },",
    ),
    `new DataReadRefusal(): ${FIXED}`,
  ],
  // ── T-B43: una negativa es un texto fijo elegido por llave; la etiqueta y el objeto, literales (la sonda de Codex b2-r1 primero) ──
  [
    "Codex b2-r1: notOffered builds its text from the venue's name",
    capability(
      "notOffered: scope => (scope.kycVerified ? null : 'No disponible en ' + scope.venueName),\n  read: async scope => sumForVenues([scope.venueId]),",
    ),
    `notOffered: ${FIXED}`,
  ],
  [
    'notOffered returns a template',
    capability('notOffered: scope => `No disponible en ${scope.venueName}`,\n  read: async scope => sumForVenues([scope.venueId]),'),
    `notOffered: ${FIXED}`,
  ],
  [
    'notOffered returns a variable',
    capability('notOffered: () => why,\n  read: async scope => sumForVenues([scope.venueId]),', "const why = 'NOT_AVAILABLE'"),
    `notOffered: ${FIXED}`,
  ],
  [
    'notOffered returns a call',
    capability(
      'notOffered: scope => refusalFor(scope),\n  read: async scope => sumForVenues([scope.venueId]),',
      "const refusalFor = (scope: DataScope) => (scope.kycVerified ? null : 'NOT_AVAILABLE')",
    ),
    `notOffered: ${FIXED}`,
  ],
  [
    'notOffered returns an invented key',
    capability("notOffered: () => 'NO_SUCH_REFUSAL',\n  read: async scope => sumForVenues([scope.venueId]),"),
    "notOffered: 'NO_SUCH_REFUSAL' is not a key of SUPPORT_DATA_REFUSALS",
  ],
  [
    'notOffered is a function declared elsewhere',
    capability(
      'notOffered: closedHere,\n  read: async scope => sumForVenues([scope.venueId]),',
      "function closedHere(scope: DataScope) { return scope.kycVerified ? null : 'NOT_AVAILABLE' }",
    ),
    `notOffered: ${FIXED}`,
  ],
  [
    'a method notOffered with a return built from the scope',
    capability(
      'notOffered(scope: DataScope) {\n    if (scope.kycVerified) return null\n    return `Cerrado en ${scope.venueName}`\n  },\n  read: async scope => sumForVenues([scope.venueId]),',
    ),
    `notOffered: ${FIXED}`,
  ],
  [
    'DataReadRefusal with a text built from the scope',
    capability(
      "read: async scope => {\n    if (scope.rows > 1) throw new DataReadRefusal('OVER_CAP', 'Son demasiados en ' + scope.venueName)\n    return sumForVenues([scope.venueId])\n  },",
    ),
    `new DataReadRefusal(): ${FIXED}`,
  ],
  [
    'DataReadRefusal imported under another name, with a free text',
    capability(
      "read: async scope => {\n    if (scope.rows > 1) throw new Refused('OVER_CAP', 'Son demasiados.')\n    return sumForVenues([scope.venueId])\n  },",
      "import { DataReadRefusal as Refused } from '../catalog'",
    ),
    "new DataReadRefusal(): 'Son demasiados.' is not a key of SUPPORT_DATA_REFUSALS",
  ],
  [
    'a params refusal from a variable',
    capability(
      'read: async scope => sumForVenues([scope.venueId]),',
      "const why = 'PARAM_AMOUNT'\nconst paramsOf = () => ({ ok: false as const, refusal: why })",
    ),
    `refusal: ${FIXED}`,
  ],
  [
    'a plan refusal as free text',
    capability(
      "gate: { featureCode: 'RESERVATIONS', gateKind: 'FEATURE', refusal: 'Reservaciones es parte del plan Pro.' },\n  read: async scope => sumForVenues([scope.venueId]),",
    ),
    "refusal: 'Reservaciones es parte del plan Pro.' is not a key of SUPPORT_DATA_REFUSALS",
  ],
  [
    'a label from a variable',
    capability('label: LABEL,\n  read: async scope => sumForVenues([scope.venueId]),', "const LABEL = 'dato'"),
    `label: ${LITERAL}`,
  ],
  [
    'an object from a template',
    capability("object: `el ${'dato'}`,\n  read: async scope => sumForVenues([scope.venueId]),"),
    `object: ${LITERAL}`,
  ],
  // ── T-B42d: venueId: scope.venueId va al final del objeto (la sonda de Codex r7 primero) ──
  [
    'R7-1: a computed key after the venue key',
    capability(
      `read: async scope => {
    const filter = await rememberedFilter(scope.venueId)
    return getMonthlyProfits({ venueId: scope.venueId, [filter.field]: filter.value })
  }`,
      "import { getMonthlyProfits } from '@/services/dashboard/cost-management.service'",
    ),
    `getMonthlyProfits(): ${LAST}`,
  ],
  [
    'another property after the venue key',
    capability(
      'read: async scope => { const startDate = scope.now.toISOString(); return report({ venueId: scope.venueId, startDate } as never) }',
    ),
    `report(): ${LAST}`,
  ],
  ['a spread after the venue key', capability('read: async (scope, p) => report({ venueId: scope.venueId, ...p.x })'), `report(): ${LAST}`],
  [
    'a computed key after the venue key',
    capability('read: async (scope, p) => report({ venueId: scope.venueId, [p.k]: p.v })'),
    `report(): ${LAST}`,
  ],
  [
    'a getter for the venue',
    capability('read: async scope => report({ get venueId() { return scope.venueId } })'),
    'report(): a getter or setter for the venue',
  ],
  [
    '__proto__ in the options',
    capability('read: async (scope, p) => report({ __proto__: p.x, venueId: scope.venueId })'),
    'report(): __proto__',
  ],
  // ── T-B42c: el plural no protege el objeto (sondas de Codex r6) ──
  [
    'R6-1: the plural key after a spread',
    capability('read: async (scope, p) => report({ ...p.filters, venueIds: [scope.venueId] })'),
    'report(): venueId: scope.venueId goes LAST in the object',
  ],
  [
    'R6-1: a spread between the venue key and the plural key',
    capability('read: async (scope, p) => report({ venueId: scope.venueId, ...p.filters, venueIds: [scope.venueId] })'),
    'report(): venueId: scope.venueId goes LAST in the object',
  ],
  ['the plural key alone', capability('read: async scope => report({ venueIds: [scope.venueId] })'), `report(): ${CARRY}`],
  // ── T-B42b: la sucursal del alcance va escrita en cada llamada al panel (las sondas de Codex r5 primero) ──
  [
    'R5-1: monthly profits with only the dates (the venue left out)',
    capability(
      'read: async scope => getMonthlyProfits({ startDate: scope.now.toISOString(), endDate: scope.now.toISOString() })',
      "import { getMonthlyProfits } from '@/services/dashboard/cost-management.service'",
    ),
    `getMonthlyProfits(): ${CARRY}`,
  ],
  [
    'R5-1: every terminal, with no argument',
    capability(
      'read: async () => getAllTerminals()',
      "import { getAllTerminals } from '@/services/dashboard/terminals.superadmin.service'",
    ),
    `getAllTerminals(): ${CARRY}`,
  ],
  [
    'R5-2: options from a variable, whose type lives in another file',
    capability(
      'read: async (scope, p) => { const options = p.options; return byImportedFilter(options) }',
      "import { byImportedFilter } from '@/services/dashboard/sampleImported.dashboard.service'",
    ),
    `byImportedFilter(): ${CARRY}`,
  ],
  [
    'a spread AFTER the venue key',
    capability(
      'read: async (scope, p) => byImportedFilter({ venueId: scope.venueId, ...p.options })',
      "import { byImportedFilter } from '@/services/dashboard/sampleImported.dashboard.service'",
    ),
    'goes LAST in the object',
  ],
  ['an optional options argument left out', capability('read: async () => salesMaybe()'), `salesMaybe(): ${CARRY}`],
  ['options without the venue key', capability('read: async scope => salesMaybe({ day: scope.day })'), `salesMaybe(): ${CARRY}`],
  [
    'the venue key by shorthand',
    capability('read: async scope => { const { venueId } = scope; return salesMaybe({ venueId }) }'),
    'venueId: write exactly scope.venueId',
  ],
  [
    'a venueId destructured from the scope, to a panel service',
    capability(
      'read: async scope => { const { venueId } = scope; return getSettlementCalendar(venueId, { from: scope.now, to: scope.now }) }',
    ),
    "its venueId argument is not the scope's",
  ],
  [
    'a venueId destructured in the read parameter, through a default-export object',
    capability('read: async ({ venueId }) => planStateService.getPlanState(venueId)'),
    "its venueId argument is not the scope's",
  ],
  ['a panel function with no venue, off the list, called', capability('read: async () => indexesReady()'), `indexesReady(): ${CARRY}`],
  [
    'a panel function with no venue, off the list, as a value',
    capability('available: indexesReady,\n  read: async () => 1'),
    'only called',
  ],
  [
    'a function named like one of the list, in another panel file',
    capability(
      'read: async scope => venueWeekBounds(scope.day, scope.timezone)',
      "import { venueWeekBounds } from '@/services/dashboard/sampleLookalike.dashboard.service'",
      {
        'src/services/dashboard/sampleLookalike.dashboard.service.ts':
          'export function venueWeekBounds(day: string, timezone: string) { return [day, timezone] }\n',
      },
    ),
    `venueWeekBounds(): ${CARRY}`,
  ],
  [
    'a panel function the checker cannot resolve',
    capability('read: async scope => plans.notThere(scope.venueId)', "import * as plans from '@/services/dashboard/planState.service'"),
    'cannot resolve which panel function',
  ],
  // ── Las tres sondas de Codex r4 ──
  [
    'R4-1: import() of a panel service, with a literal id',
    capability(`read: async () => {
    const panel = await import('@/services/dashboard/planState.service')
    return panel.getPlanState('${ID}')
  }`),
    `import(): ${NO_DYNAMIC}`,
  ],
  [
    'R4-1: require() of a panel service, with a literal id',
    capability(`read: async () => require('@/services/dashboard/planState.service').getPlanState('${ID}')`),
    `require: ${NO_DYNAMIC}`,
  ],
  [
    'R4-1: a panel service re-exported by another capability and aliased',
    capability(`read: async () => { const p = plans; return p.getPlanState('${ID}') }`, "import { plans } from './relay'", {
      [`${CAPABILITIES}relay.ts`]: "export { default as plans } from '@/services/dashboard/planState.service'\n",
    }),
    'only types come from another capability',
  ],
  [
    'R4-1: the relay capability itself',
    capability(`read: async () => { const p = plans; return p.getPlanState('${ID}') }`, "import { plans } from './relay'", {
      [`${CAPABILITIES}relay.ts`]: "export { default as plans } from '@/services/dashboard/planState.service'\n",
    }),
    'relay.ts:1: re-exports',
  ],
  [
    'R4-2: the client by an equivalent path',
    capability(
      'read: async () => { const payments = db.payment; return payments.count() }',
      "import db from '@/utils/../utils/prismaClient'",
    ),
    'the database client',
  ],
  [
    'R4-3: a util off the list that opens its own Prisma connection',
    capability('read: async scope => total(scope.venueId)', "import { total } from '@/utils/sampleTotals'", {
      'src/utils/sampleTotals.ts': OWN_PRISMA,
    }),
    'only the listed utils',
  ],
  [
    'R4-3: a listed util that opens its own Prisma connection',
    capability(
      'read: async scope => total(scope.venueId)',
      "import { total } from '@/utils/venueDateKeys'",
      listedUtil('src/utils/venueDateKeys.ts', OWN_PRISMA),
    ),
    'src/utils/venueDateKeys.ts reaches the database',
  ],
  [
    'R4-3: a listed util that reaches a connection two imports away',
    capability('read: async scope => zonaValida(scope.timezone)', "import { zonaValida } from '@/utils/datetime'", {
      ...listedUtil('src/utils/datetime.ts', "export { total } from './sampleConnection'"),
      'src/utils/sampleConnection.ts': OWN_PRISMA,
    }),
    'src/utils/datetime.ts reaches the database',
  ],
  [
    'R4-3: a listed util with pg.Pool',
    capability(
      'read: async scope => total(scope.venueId)',
      "import { total } from '@/utils/venueDateKeys'",
      listedUtil('src/utils/venueDateKeys.ts', OWN_PG),
    ),
    'imports pg',
  ],
  // ── Lo que el compilador ve y una ruta a mano no ──
  [
    'a panel file that re-exports a service from outside the panel',
    capability(
      'read: async scope => calculateSettlementDate(scope.now)',
      "import { calculateSettlementDate } from '@/services/dashboard/sampleRelay.dashboard.service'",
      PANEL_RELAY,
    ),
    'is declared in src/services/payments/settlementCalculation.service.ts',
  ],
  [
    'a panel file that re-exports the client',
    capability(
      'read: async () => db.payment.count()',
      "import { db } from '@/services/dashboard/sampleRelay.dashboard.service'",
      PANEL_RELAY,
    ),
    'comes from src/utils/prismaClient.ts: the database client',
  ],
  [
    'a panel service destructured from its default export',
    capability(`read: async () => { const { getPlanState } = planStateService; return getPlanState('x') }`),
    'only called',
  ],
  ['a panel service handed to map', capability("read: async () => ['a'].map(planStateService.getPlanState)"), 'only called'],
  // ── Código dinámico ──
  ['eval', capability("read: async () => eval('1')"), `eval: ${NO_DYNAMIC}`],
  ['new Function', capability("read: async () => new Function('return 1')()"), `Function: ${NO_DYNAMIC}`],
  ['globalThis', capability('read: async () => (globalThis as any).prisma'), `globalThis: ${NO_DYNAMIC}`],
  ['module', capability('read: async () => module.children.length'), `module: ${NO_DYNAMIC}`],
  [
    'brackets on a panel service',
    capability("read: async scope => planStateService['getPlanState'](scope.venueId)"),
    'brackets on something imported',
  ],
  ['an id-shaped text anywhere', capability(`read: async () => { const other = '${ID}'; return other.length }`), 'shaped like an id'],
  [
    'a made-up scope handed to a helper that takes the scope',
    capability(
      'read: async (scope, p) => readFor(p.fake)',
      'function readFor(scope: DataScope) { return getSalesSummary(scope.venueId, {} as never) }',
    ),
    'its DataScope parameter gets something else',
  ],
  ['options typed with the venue, passed as a variable', capability('read: async (scope, p) => byFilter(p.filter)'), 'object literal'],
  [
    'options typed with the venue, with a spread',
    capability('read: async (scope, p) => byFilter({ ...p.filter, day: scope.day })'),
    'goes LAST in the object',
  ],
  ['a global that is not part of the language', capability("read: async () => Buffer.from('x')"), 'Buffer: '],
  // ── (a) la base ──
  ['importing the database client', capability('read: async () => db', "import db from '@/utils/prismaClient'"), 'database client'],
  ['$queryRaw', capability('read: async (scope, p, db: any) => db.$queryRaw`SELECT 1`'), '$queryRaw'],
  [
    'prisma.payment.findMany',
    capability('read: async scope => prisma.payment.findMany({ where: { venueId: scope.venueId }, take: 5 })'),
    'prisma. member',
  ],
  [
    'importing from src/services/somethingElse',
    capability('read: async () => x()', "import { x } from '@/services/somethingElse/x'"),
    'no such module',
  ],
  [
    'importing a service outside the panel',
    capability('read: async () => calc()', "import { calc } from '@/services/payments/settlementCalculation.service'"),
    'only through panel services',
  ],
  [
    'importing PrismaClient',
    capability('read: async () => new PrismaClient()', "import { PrismaClient } from '@prisma/client'"),
    'never the database client',
  ],
  [
    'the whole @prisma/client namespace',
    capability('read: async () => P', "import * as P from '@prisma/client'"),
    'never the database client',
  ],
  [
    'PrismaClient next to an enum, which is allowed',
    capability(
      'read: async () => PaymentMethod.CASH && new PrismaClient()',
      "import { PaymentMethod, PrismaClient } from '@prisma/client'",
    ),
    'imports PrismaClient from @prisma/client: never the database client',
  ],
  [
    'PrismaClient under another name, as a value',
    capability('read: async () => Db', "import { PrismaClient as Db } from '@prisma/client'"),
    'imports PrismaClient from @prisma/client: never the database client',
  ],
  [
    'another value of @prisma/client that is not an enum',
    capability('read: async () => Prisma.sql`SELECT 1`', "import { Prisma } from '@prisma/client'"),
    'only types, its enums and Prisma.Decimal',
  ],
  [
    'the B payment texts (C2 creates them) reaching the database',
    capability('read: async () => 1', "import { paymentFormLabel } from '../paymentText'", {
      'src/services/support/data/paymentText.ts':
        "import prisma from '@/utils/prismaClient'\nexport const paymentFormLabel = () => prisma\n",
    }),
    'src/services/support/data/paymentText.ts reaches the database',
  ],
  [
    'the client under another name',
    capability('read: async () => db.payment.findMany({ take: 1 })', "import { default as db } from '@/utils/prismaClient'"),
    'payment.findMany',
  ],
  [
    'the legacy pool',
    capability("read: async () => legacyPool.query('SELECT 1')", "import { legacyPool } from '@/services/legacy/legacyPool'"),
    'database pool',
  ],
  [
    'require() of the client',
    capability("read: async () => require('@/utils/prismaClient').default.order.count()"),
    `require: ${NO_DYNAMIC}`,
  ],
  ['import() of the client', capability("read: async () => (await import('@/utils/prismaClient')).default"), `import(): ${NO_DYNAMIC}`],
  ['a computed require()', capability("read: async () => require('@/utils/' + 'prismaClient')"), `require: ${NO_DYNAMIC}`],
  [
    'require under another name',
    capability("read: async () => { const load = require; return load('@/utils/prismaClient') }"),
    `require: ${NO_DYNAMIC}`,
  ],
  ['re-exporting the client', capability('read: async () => 1', "export * from '@/utils/prismaClient'"), 're-exports'],
  ['a database driver', capability('read: async () => new pg.Pool()', "import pg from 'pg'"), 'no database driver'],
  [
    'a helper off the list that imports the database',
    capability('read: async () => 1', "import { withSerializableRetry } from '@/utils/serializableRetry'"),
    'only the listed utils',
  ],
  [
    'a transaction handed in under another name',
    capability('read: async (scope, p, t: any) => t.payment.findMany({ take: 1 })'),
    'payment.findMany',
  ],
  ['tx.order.count', capability('read: async (scope, p, tx: any) => tx.order.count()'), 'tx. member'],
  // ── (b) la sucursal ──
  [
    "venueId: 'cxxx'",
    capability(`read: async () => findPaymentsByAmount({ venueId: '${ID}', amount: 1 })`),
    'venueId: write exactly scope.venueId',
  ],
  [
    'venueId: params.venue',
    capability('read: async (scope, params) => findPaymentsByAmount({ venueId: params.venue, amount: 1 })'),
    'venueId: write exactly scope.venueId',
  ],
  [
    'getX(otherId, …) where its first parameter is venueId',
    capability('read: async (scope, params) => getSalesSummary(params.otherId, {})'),
    'venueId argument',
  ],
  [
    'a literal id to a static method',
    capability(`read: async () => SharedQueryService.getSalesForPeriod('${ID}', 'today')`),
    'venueId argument',
  ],
  [
    'another id through a default-export object',
    capability('read: async (scope, p) => planStateService.getPlanState(p.id)'),
    'venueId argument',
  ],
  [
    'a variable named venueId',
    capability('read: async (scope, p) => { const venueId = p.venue; return planStateService.getPlanState(venueId) }'),
    'a variable named venueId',
  ],
  [
    'a helper with a venueId parameter',
    capability(
      'read: async (scope, p) => readFor(p.venue)',
      'async function readFor(venueId: string) { return getSalesSummary(venueId, {}) }',
    ),
    'a parameter named venueId',
  ],
  [
    'a scope made up',
    capability("read: async () => { const scope = { venueId: 'x' }; return getSalesSummary(scope.venueId, {}) }"),
    'a variable named scope',
  ],
  [
    'the scope reassigned',
    capability('read: async (scope, p) => { scope = { ...scope, venueId: p.v }; return getSalesSummary(scope.venueId, {}) }'),
    'assigns to the scope',
  ],
  ['a call without the venue', capability('read: async () => planStateService.getPlanState()'), 'gets no venueId'],
  ['spread arguments', capability('read: async (scope, p) => getSalesSummary(...p.args)'), 'spread argument'],
  [
    'a panel function aliased',
    capability('read: async scope => { const f = getSalesSummary; return f(scope.venueId, {}) }'),
    'only called',
  ],
  ['a panel function called through .call', capability("read: async () => getSalesSummary.call(null, 'x', {})"), 'only called'],
  [
    'an organizationId from the parameters',
    capability('read: async (scope, p) => getSalesSummary(scope.venueId, { organizationId: p.org })'),
    'never passes an organisation id',
  ],
  // T-B41b: la organización no se pasa con NINGÚN valor, ni siquiera la del alcance
  [
    'the scope organisation next to the venue',
    capability('read: async scope => findPaymentsByAmount({ venueId: scope.venueId, amount: 1, organizationId: scope.organizationId })'),
    'organizationId: the B answers for ONE venue',
  ],
  [
    'the scope organisation to a parameter named organizationId',
    capability('read: async scope => plansOfOrganization(scope.organizationId)'),
    'its organizationId parameter gets a value',
  ],
  [
    'an organizationId destructured from the scope, used as an argument',
    capability('read: async scope => { const { organizationId } = scope; return plansOfOrganization(organizationId) }'),
    'organizationId destructured',
  ],
  [
    'an optional organizationId parameter fed with anything',
    capability('read: async scope => salesWithOrg(scope.venueId, scope.venueId)'),
    'its organizationId parameter gets a value',
  ],
  ['the whole scope to a panel service', capability('read: async scope => readWithScope(scope)'), 'never receives the whole scope'],
  // T-B41c: la configuración llega en el alcance
  [
    'reading the configuration',
    capability(
      'read: async () => getSupportDataConfig()?.depositGroups',
      "import { getSupportDataConfig } from '@/config/supportWhatsapp'",
    ),
    'only through panel services',
  ],
  ['reading the environment', capability('read: async () => Number(process.env.SUPPORT_DATA_DEPOSIT_GROUPS)'), `process: ${NO_DYNAMIC}`],
  [
    'the scope spread into the options',
    capability('read: async scope => findPaymentsByAmount({ ...scope, amount: 1 })'),
    '{ ...scope } carries the organisation',
  ],
  [
    'the organization destructured as the venue',
    capability('read: async ({ organizationId: venueId }) => planStateService.getPlanState(venueId)'),
    'destructured from something else',
  ],
  ['another venue in a list', capability("read: async scope => sumForVenues([scope.venueId, 'x'])"), 'venueIds argument'],
  ['options passed as a variable', capability('read: async (scope, p) => findPaymentsByAmount(p.options)'), 'object literal'],
  [
    'a scope parameter that is not the scope',
    capability('read: async (s, scope) => getSalesSummary(scope.venueId, {})'),
    'not the capability scope',
  ],
])('the guard catches %s', (_name, files, says) => {
  const problems = guardProblems(files)
  expect(problems.length).toBeGreaterThan(0)
  expect(problems.join('\n')).toContain(says)
})

// El orquestador y el catálogo: lo de hoy pasa (arriba); cualquier lectura nueva, o una excepción que sobra, falla.
it.each<[string, string, (text: string) => string, string]>([
  ['the orchestrator reads a model', ANSWER, t => `${t}\nexport const leak = () => prisma.payment.findMany({ take: 1 })`, 'prisma. member'],
  [
    'the orchestrator hands the client to another read',
    ANSWER,
    t => `${t}\nexport const leak = () => countDataReadsToday(prisma as never, '2026-11-16')`,
    'only as the first argument of readDataValidity',
  ],
  [
    'the orchestrator imports a panel service',
    ANSWER,
    t => `${t}\nimport { getPlanState } from '@/services/dashboard/planState.service'`,
    'not on the list',
  ],
  [
    'the orchestrator imports the client by an equivalent path',
    ANSWER,
    t => `${t}\nimport other from '@/config/../utils/prismaClient'\nexport const leak = () => other`,
    'other: the database client, allowed here only as the first argument of readDataValidity',
  ],
  ['the orchestrator loads code at run time', ANSWER, t => `${t}\nexport const leak = () => require('pg')`, `require: ${NO_DYNAMIC}`],
  ['an exception no longer used', ANSWER, t => t.replace("import crypto from 'crypto'\n", ''), 'is no longer used'],
  [
    'a capability written inside the catalog',
    CATALOG,
    t => `${t}\nimport { getPlanState } from '@/services/dashboard/planState.service'`,
    'not on the list',
  ],
  ['the catalog imports the consent writer', CATALOG, t => `${t}\nimport { grantDataAccess } from './consent.service'`, 'not on the list'],
  ['the catalog sets a venueId', CATALOG, t => `${t}\nexport const other = { venueId: 'x' }`, 'venueId: write exactly scope.venueId'],
  [
    'a B module a capability uses starts reading the database',
    'src/services/support/data/check.ts',
    t => `import prisma from '@/utils/prismaClient'\n${t}`,
    'src/services/support/data/check.ts reaches the database',
  ],
  [
    'a B module a capability uses reaches the database through another module',
    'src/services/support/data/format.ts',
    t => `import { withSerializableRetry } from '@/utils/serializableRetry'\n${t}`,
    'reaches the database',
  ],
])('the guard catches %s', (_name, file, change, says) => {
  const text = read(file)
  expect(change(text)).not.toBe(text)
  expect(guardProblems({ [file]: change(text) }).join('\n')).toContain(says)
})
