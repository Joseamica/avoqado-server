/**
 * Los barridos de la B: recorren el catálogo DE VERDAD, así que cada capacidad queda cubierta en cuanto se registra (Tasks C).
 * Con el catálogo vacío corren las cercas del catálogo y el barrido sobre una capacidad de mentira que sí lee la base, que prueba al
 * barrido mismo; y sus variantes rotas, que prueban que las cercas de comportamiento (T-B38, T-B39) sí fallan.
 */
import { Prisma, type SupportConversation } from '@prisma/client'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { getSupportDataConfig } from '@/config/supportWhatsapp'
import { checkDataDelivery, prepareDataAnswer, type DataOutcome } from '@/services/support/data/answer.service'
import {
  DATA_CAPABILITIES,
  DataReadRefusal,
  dataCatalog,
  type AnyDataCapability,
  type DataCatalog,
  type DataRequest,
  type DataScope,
} from '@/services/support/data/catalog'
import { template, type Figure, type Rendered } from '@/services/support/data/check'
import { readDataValidity } from '@/services/support/data/consent.service'
import { fmtMoney } from '@/services/support/data/format'
import { safeDbText } from '@/services/support/data/sanitize'
import { recordSupportDataQuery } from '@/services/support/data/log'
import { paymentParams } from '@/services/support/data/paymentText'
import { admitSupportMessage, claimNext } from '@/services/support/store.service'
import { prepareSupportAnswer } from '@/services/support/worker.service'
import { MARGEN_DE_LECTURA_ANTES_MS, MARGEN_DE_LECTURA_MS } from '@/services/shared/horaRealDelAparato'
import { utcTs } from '@/utils/sqlDates'
import { venueDayKey } from '@/utils/venueDateKeys'
import {
  SUPPORT_DATA_CHECK_FAILED,
  SUPPORT_DATA_DAILY_CAP,
  SUPPORT_DATA_LINK_FIRST,
  SUPPORT_DATA_NEEDS_UNLOCK,
  SUPPORT_DATA_OFF,
  SUPPORT_DATA_OMITTED,
  SUPPORT_DATA_OTHER_VENUE,
  SUPPORT_DATA_QUERY_FAILED,
  SUPPORT_DATA_REFUSALS,
  SUPPORT_DATA_SUPERADMIN,
  supportDataHistoryMark,
  supportDataNoPermission,
  supportDataOutOfCatalog,
  type DataRefusalKey,
} from '@/services/support/data/texts'
import {
  FAKE_SUPPORT_AI_ENV,
  amountLeaks,
  capabilityFixtures,
  fakeCapability,
  fakeSupportAi,
  fixtureGuide,
  seedDataFixture,
  spyLogger,
  spyQueries,
  type CapabilityFixture,
  type DataFixture,
  type ForeignSeed,
  type QueryCall,
} from '@tests/__helpers__/supportData'

/** Lo que ninguna capacidad puede traer (revisiones de Tasks 4 y 6). Recibe también un objeto a mano: así la cerca tiene dientes. */
function catalogFenceProblems(catalog: Record<string, AnyDataCapability>): string[] {
  return Object.entries(catalog).flatMap(([key, def]) => [
    ...(def.key === key ? [] : [`${key}: its key is ${def.key}`]),
    // el candado mira `included`, nunca `enabled`: un activationKey se ignoraría en silencio
    ...(def.gate?.activationKey ? [`${key}: gate with an activationKey`] : []),
    // every() sobre una lista vacía es true: pasaría con cualquiera
    ...(def.permissions.length ? [] : [`${key}: no permissions`]),
  ])
}
const isTextHole = (kind: string) => kind === 'text' || kind === 'strictText'
/** Lo que, entre dos huecos de texto seguidos, los deja leerse como UNA pieza: nada, espacios, puntos, diagonales, dos puntos, guiones, arrobas. */
const GLUE = /^[ ./:@-]*$/
/**
 * Dos huecos de texto seguidos, pegados o con sólo GLUE entre ellos (T-B34 y T-B34b): el cotejo busca 8 dígitos SEGUIDOS en el texto, así
 * que «1234567» + « » + «7654321» (nombre y apellido de 7 dígitos cada uno, un teléfono de 14) pasaría, y «evil» + «.» + «com» armaría
 * una liga que ninguno de los dos huecos trae. Pasa con «, », con un salto de renglón o con cualquier otra cosa en medio (una letra, una
 * cifra). Los huecos se ubican sobre el texto en NFKC y sin caracteres de formato DOS veces: desde el principio, como checkRendered (cada
 * `shown` con indexOf, en orden), y desde el final (lastIndexOf, en orden inverso). Si un valor también sale en el texto fijo («Ana
 * atendió: Ana Pérez»), la primera ubicación cae en el texto fijo y escondería el pegado de verdad: las dos ubicaciones no coinciden, y
 * la capacidad falla pidiendo otro valor en su fixture.
 * Y un hueco de texto pegado a la plantilla (T-B34c): la regla de salida rompe los puntos DENTRO de un hueco, pero no ve lo que lo rodea,
 * así que «Sucursal» + «.mx/pago» o «bit.» + «ly» rearmarían una liga. Falla si el carácter de ANTES es una letra, un dígito o un punto;
 * si el de DESPUÉS es una letra o un dígito; o si el de después es un punto seguido de algo que no es espacio ni puntuación (T-B39b, la
 * misma definición de punto pegado que la regla de salida: pasan el punto que cierra una oración, «Ana.,» y «Ana.)»). Se mira el carácter vecino tal cual, sea de la plantilla o de otro hueco. Pasan un espacio, un salto de renglón, «»,
 * comillas, paréntesis, dos puntos, una coma, y el principio o el final del texto. Un hueco vacío (un dato que falta) no imprime nada:
 * no se ubica ni se revisa.
 * Riesgo ACEPTADO: dígitos repartidos entre huecos separados por algo más («1234567, 7654321») no los ve ni esta cerca ni el cotejo.
 */
const GLUED_BETWEEN = 'las partes de un nombre van en UN hueco: junta nombre y apellido antes de t.text'
const GLUED_TO_TEMPLATE =
  'un hueco de texto no puede ir pegado a una letra, un dígito o un punto de la plantilla: deja un espacio o un signo entre el texto fijo y el dato'
function gluedTextHoles(rendered: Rendered): string[] {
  const plain = rendered.text.normalize('NFKC').replace(/\p{Cf}/gu, '')
  const figures = rendered.figures.filter(figure => figure.shown !== '')
  let at = 0
  const fromStart = figures.map(figure => {
    const start = plain.indexOf(figure.shown, at)
    at = start + figure.shown.length
    return start
  })
  let limit = plain.length
  const fromEnd = [...figures]
    .reverse()
    .map((figure: Figure) => (limit = plain.lastIndexOf(figure.shown, limit - figure.shown.length)))
    .reverse()
  const shifted = figures.find((_, i) => fromStart[i] !== fromEnd[i])
  if (shifted)
    return [
      `«${shifted.shown}» también sale en el texto fijo de la plantilla y no se sabe dónde va su hueco: cambia ese valor del fixture para que no repita el texto de la plantilla`,
    ]
  return figures.flatMap((figure, i) => {
    const start = fromStart[i],
      end = start + figure.shown.length
    const previous = figures[i - 1]
    const between = previous ? plain.slice(fromStart[i - 1] + previous.shown.length, start) : ''
    const gluedBetween = !!previous && isTextHole(previous.kind) && isTextHole(figure.kind) && GLUE.test(between)
    const before = plain.slice(0, start),
      after = plain.slice(end)
    const gluedToTemplate =
      isTextHole(figure.kind) && (/[\p{L}\p{N}.]$/u.test(before) || /^[\p{L}\p{N}]/u.test(after) || /^\.[^\s\p{P}]/u.test(after))
    return [
      ...(gluedBetween ? [`«${previous.shown}» y «${figure.shown}»: ${GLUED_BETWEEN}`] : []),
      ...(gluedToTemplate ? [`«${figure.shown}»: ${GLUED_TO_TEMPLATE}`] : []),
    ]
  })
}
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g

type Answered = { out: Extract<DataOutcome, { kind: 'answer' }>; rendered: Rendered }
/** Contesta la pregunta del fixture con un reloj dado; una negativa lanza con su texto. */
type Answer = (now?: Date) => Promise<Answered>

/**
 * El alcance de otra sucursal, armado como lo arma prepareDataAnswer para la propia: con readDataValidity (zona, día de la sucursal,
 * nombre, organización, verificación), el mismo reloj y la misma configuración. Así la ventana es la misma.
 */
async function scopeOf(f: DataFixture, venueId: string, now: Date): Promise<DataScope> {
  const validity = await readDataValidity(prisma, { staffId: f.staffId, venueId, linkId: null, now })
  const config = getSupportDataConfig()
  if (!config) throw new Error('la B está apagada')
  return {
    venueId,
    organizationId: validity.organizationId,
    venueName: validity.venueName,
    timezone: validity.timezone,
    day: validity.day,
    kycVerified: validity.kycVerified,
    now,
    rows: config.rows,
    openOrdersDays: config.openOrdersDays,
    depositGroups: config.depositGroups,
    depositTimeoutMs: config.depositTimeoutMs,
  }
}

/** La lectura y la plantilla de la capacidad, directas, con un alcance dado: sin los candados del orquestador (no son lo que se prueba). */
async function renderAs(def: AnyDataCapability, fx: CapabilityFixture, scope: DataScope): Promise<string> {
  const params = def.params(fx.request, fx.message, scope)
  if (!params.ok) throw new Error(params.refusal)
  return def.render(scope, params.value, await def.read(scope, params.value)).text
}

/** T-B38c: otra sucursal de la persona, en la que ninguna siembra escribe, y en la misma zona que las sembradas (R3-1). */
const EMPTY_VENUE = 'la sucursal de la persona sin datos sembrados'
const INEFFECTIVE =
  'la siembra es ineficaz: el fixture tiene que crear, en esa sucursal, renglones que la capacidad lea de verdad, dentro de su ventana (o la capacidad no lee la sucursal de su alcance)'

/**
 * T-B38, la cerca de datos ajenos, por comportamiento: siembra lo propio y contesta; siembra lo mismo, en la misma ventana, en otra
 * sucursal de la organización y en una de otra organización, y contesta otra vez con el MISMO reloj. La respuesta tiene que salir
 * idéntica byte por byte, y ninguna cifra ajena (nombre, importe) puede salir. Revisar el JSON de las consultas no basta: un
 * `OR: [{ venueId }, { createdAt }]` lleva la sucursal y las fechas, y un `findUnique` por id no dice de quién es el renglón.
 * T-B38b: antes de comparar, un control positivo por cada sucursal ajena. La MISMA capacidad, leída con el alcance de esa sucursal
 * y el mismo reloj, tiene que sacar las cifras de su siembra y dar otra respuesta que la propia. Sin eso, una siembra que no crea
 * nada (o lo crea fuera de los filtros) dejaría la respuesta propia idéntica y aprobaría un `OR`; y una capacidad que no lee su
 * alcance tampoco sacaría las cifras de la otra sucursal.
 * T-B38c: la pierna sin datos. La misma capacidad, leída con el alcance de otra sucursal de la persona (`f.emptyId`, en la MISMA zona
 * que las sembradas: en otra, su ventana para la misma pregunta caería en otra hora y no vería nada; R3-1), donde el
 * fixture no siembra nada, antes de sembrar y después de sembrar las tres: esa respuesta no puede cambiar ni traer una cifra sembrada. Así cae la lectura del
 * «primero que encuentre» sin filtro de sucursal (con datos propios, el renglón propio gana el orden y la comparación sale pareja), y
 * la que se trae algo de la OTRA sucursal de la persona, que la cerca no sembraba.
 * El reloj se lee antes de sembrar: por eso las siembras escriben sus horas al menos un minuto antes de la llamada.
 */
async function foreignDataProblems(def: AnyDataCapability, fx: CapabilityFixture, f: DataFixture, answer: Answer): Promise<string[]> {
  const now = new Date()
  // Leída directa con su alcance, como los controles positivos: la plática del fixture es una sola por teléfono.
  const emptyScope = await scopeOf(f, f.emptyId, now)
  const empty = await renderAs(def, fx, emptyScope)
  const own = await fx.seed(f)
  const before = (await answer(now)).out.envelope.text
  const seeds = [
    { label: 'otra sucursal de la organización', venueId: f.siblingId, ...(await fx.seed(f, { venueId: f.siblingId, marker: 1 })) },
    { label: 'una sucursal de otra organización', venueId: f.foreignId, ...(await fx.seed(f, { venueId: f.foreignId, marker: 2 })) },
  ]
  const foreign = seeds.flatMap(seed => seed.figures)
  if (seeds.some(seed => !seed.figures.length)) return ['la siembra de otra sucursal no dice qué saldría si se colara: devuelve sus cifras']
  const markers = [...own.figures, ...foreign]
  const echoed = [
    ...foreign.filter(figure => before.includes(figure)).map(figure => `«${figure}» ya sale en la respuesta propia`),
    ...markers.filter(figure => empty.includes(figure)).map(figure => `«${figure}» ya sale en la respuesta de ${EMPTY_VENUE}`),
  ]
  if (echoed.length) return echoed.map(problem => `${problem}: siembra otro valor`)
  const positive: string[] = []
  for (const seed of seeds) {
    let text: string
    try {
      text = await renderAs(def, fx, await scopeOf(f, seed.venueId, now))
    } catch (err) {
      positive.push(`${seed.label}: no se pudo leer con su alcance (${(err as Error).message}); ${INEFFECTIVE}`)
      continue
    }
    const missing = seed.figures.filter(figure => !text.includes(figure))
    if (missing.length) positive.push(`${seed.label}: leída con su alcance no sale «${missing.join('», «')}»; ${INEFFECTIVE}`)
    if (text === before) positive.push(`${seed.label}: leída con su alcance da la misma respuesta que la propia; ${INEFFECTIVE}`)
  }
  // Sólo con las dos siembras comprobadas cuenta la comparación de abajo.
  if (positive.length) return positive
  const after = (await answer(now)).out.envelope.text
  const emptyAfter = await renderAs(def, fx, emptyScope)
  return [
    ...(after === before ? [] : [`con datos de otra sucursal la respuesta cambió: «${before}» → «${after}»`]),
    ...foreign.filter(figure => after.includes(figure)).map(figure => `«${figure}» es de otra sucursal y salió en la respuesta`),
    ...(emptyAfter === empty ? [] : [`${EMPTY_VENUE}: la respuesta cambió al sembrar las otras: «${empty}» → «${emptyAfter}»`]),
    ...markers.filter(figure => emptyAfter.includes(figure)).map(figure => `${EMPTY_VENUE}: salió «${figure}», que se sembró en otra`),
  ]
}

/** T-B39: lo que el barrido escribe en cada texto libre de la siembra, y lo que de él no puede salir tal cual en la respuesta. */
const POISONS: { value: string; raw: RegExp }[] = [
  { value: 'Corte 4111/1111/1111/1111', raw: /4111/ },
  { value: 'https://bit.ly/x', raw: /:\/\/|bit\.ly/i },
  { value: 'ana@correo.com', raw: /@|correo\.com/i },
  { value: 'GODE561231GR8', raw: /GODE561231GR8/i },
]
/** Por cada veneno: contesta (una negativa es un problema), sale el reemplazo, no sale el veneno ni 8 dígitos, ni huecos pegados. */
async function poisonProblems(fx: CapabilityFixture, f: DataFixture, answer: Answer): Promise<string[]> {
  await fx.seed(f)
  const problems: string[] = []
  for (const { value, raw } of POISONS) {
    const { replacedBy } = await fx.poison(f, value)
    let answered: Answered
    try {
      answered = await answer()
    } catch (err) {
      problems.push(`«${value}»: no contestó (${(err as Error).message})`)
      continue
    }
    const text = answered.out.envelope.text
    problems.push(
      ...replacedBy.filter(replacement => !text.includes(replacement)).map(replacement => `«${value}»: no salió «${replacement}»`),
      ...(raw.test(text) || /[\p{Nd}\p{No}]{8}/u.test(text) ? [`«${value}» salió tal cual: «${text}»`] : []),
      ...gluedTextHoles(answered.rendered).map(problem => `«${value}»: ${problem}`),
    )
  }
  return problems
}

describe('the catalog', () => {
  it('no gate with an activationKey, no capability without permissions, every key is its own', () =>
    expect(catalogFenceProblems(DATA_CAPABILITIES)).toEqual([]))
  it('the fence has teeth', () =>
    expect(
      catalogFenceProblems({
        a: { ...fakeCapability, key: 'a', gate: { ...fakeCapability.gate!, activationKey: 'allowReservations' } },
        b: { ...fakeCapability, key: 'b', permissions: [] },
        c: { ...fakeCapability, key: 'x' },
      }),
    ).toEqual(['a: gate with an activationKey', 'b: no permissions', 'c: its key is x']))
  /** Una capacidad de mentira que imprime dos huecos de texto con `between` en medio (y otro contenido alrededor). */
  const twoNames = (between: string): AnyDataCapability => ({
    ...fakeCapability,
    render: (scope: DataScope) => {
      const t = template(scope.timezone)
      return t.done(`Atendió ${t.text('Ana')}${between}${t.strict('Pérez', 'una persona')} por ${t.money(850)}`)
    },
  })
  const scope = { timezone: 'America/Mexico_City', venueName: 'Norte', now: new Date() } as DataScope
  const fenceOf = (def: AnyDataCapability) => gluedTextHoles(def.render(scope, {}, {}))
  // «» y «.» además pegan cada hueco al otro (T-B34c): por eso se pide el mensaje de los dos huecos entre los problemas, no como el único
  it.each(['', ' ', '.', ' . ', '/', ':', '-', '@'])('the glued-holes fence has teeth: «%s» between two text holes fails', between =>
    expect(fenceOf(twoNames(between))).toContain(`«Ana» y «Pérez»: ${GLUED_BETWEEN}`),
  )
  it.each([', ', '\n', ' y ', ' en la caja ', ' 14:30 '])('the glued-holes fence lets «%s» between two text holes pass', between =>
    expect(fenceOf(twoNames(between))).toEqual([]),
  )
  // Un valor que repite el texto fijo movería la ubicación del hueco y escondería el pegado (los dos casos tienen UN espacio entre huecos).
  const hole = (shown: string): Figure => ({ kind: 'text', shown, value: shown })
  it.each<[string, string[]]>([
    ['Ana atendió: Ana Pérez', ['Ana', 'Pérez']],
    ['Cajera: a 1234567', ['a', '1234567']],
  ])('a hole value that also appears in the fixed text fails instead of hiding the glue: «%s»', (text, shown) =>
    expect(gluedTextHoles({ text, figures: shown.map(hole) })).toEqual([
      `«${shown[0]}» también sale en el texto fijo de la plantilla y no se sabe dónde va su hueco: cambia ese valor del fixture para que no repita el texto de la plantilla`,
    ]),
  )
  // T-B34c: un hueco de texto pegado a la plantilla. Los huecos se arman a mano (sin safeDbText), así que la muestra es exactamente ésta.
  const money = (shown: string): Figure => ({ kind: 'money', shown, value: shown })
  it.each<[string, Figure[]]>([
    ['SucursalAna', [hole('Ana')]],
    ['Analy', [hole('Ana')]],
    ['No.Ana', [hole('Ana')]],
    ['Ana.mx', [hole('Ana')]],
    ['MesaAna', [hole('Ana')]],
    ['Ana.mx/pago', [hole('Ana')]],
    ['Ana.Pérez', [hole('Ana')]],
  ])('a text hole glued to the template fails: «%s»', (text, figures) =>
    expect(gluedTextHoles({ text, figures })).toEqual([`«Ana»: ${GLUED_TO_TEMPLATE}`]),
  )
  it.each<[string, Figure[]]>([
    ['Sucursal «Ana».', [hole('Ana')]],
    ['Atendió Ana.', [hole('Ana')]],
    ['Atendió Ana. Luego cerró.', [hole('Ana')]],
    ['(Ana)', [hole('Ana')]],
    ['Ana: $150.00', [hole('Ana'), money('$150.00')]],
    ['Ana, Pérez', [hole('Ana'), hole('Pérez')]],
    ['Cobro en Ana., listo', [hole('Ana')]],
    ['Atendió (Ana.)', [hole('Ana')]],
    ['Atendió «Ana.»', [hole('Ana')]],
  ])('a text hole with a space or a sign around it passes: «%s»', (text, figures) => expect(gluedTextHoles({ text, figures })).toEqual([]))
  it('a repeated value cannot hide a glued edge: «Ana: SucursalAna» fails as a repeated value', () =>
    expect(gluedTextHoles({ text: 'Ana: SucursalAna', figures: [hole('Ana')] })).toEqual([
      '«Ana» también sale en el texto fijo de la plantilla y no se sabe dónde va su hueco: cambia ese valor del fixture para que no repita el texto de la plantilla',
    ]))
  it('an empty text hole prints nothing and is not placed', () =>
    expect(gluedTextHoles({ text: 'Atendió Ana.', figures: [hole(''), hole('Ana')] })).toEqual([]))
  it('a money hole between two text holes is not glue', () => {
    const t = template('America/Mexico_City')
    expect(gluedTextHoles(t.done(`${t.text('Ana')} ${t.money(850)} ${t.text('Pérez')}`))).toEqual([])
  })
  if (!Object.keys(DATA_CAPABILITIES).length) it('no capability registered yet', () => expect(DATA_CAPABILITIES).toEqual({}))
})

/** Los barridos de UNA capacidad. `catalog` es el de verdad, salvo en la prueba del barrido mismo. */
function sweep(catalog: DataCatalog, key: string, fx: CapabilityFixture | undefined) {
  let f: DataFixture
  const def = (): AnyDataCapability => catalog[key]
  beforeAll(async () => {
    f = await seedDataFixture(`support-data-sweep-${key}`)
  })
  afterAll(() => f?.clean())
  beforeEach(async () => {
    await f.reset()
    process.env.SUPPORT_DATA_ENABLED = 'true'
  })
  afterEach(() => jest.restoreAllMocks())

  /**
   * T-B44: un catálogo registrado está congelado y no se espía. Para mirar su `read` y su `render`, la capacidad se registra otra vez
   * en un catálogo de la prueba con los dos envueltos (`read` puede cambiarse por otro que llame al de verdad).
   */
  const spied = (read: AnyDataCapability['read'] = def().read) => {
    const spies = { read: jest.fn(read), render: jest.fn(def().render) }
    return { ...spies, catalog: dataCatalog({ ...def(), ...spies }) }
  }
  const ask = async (now = new Date(), within: DataCatalog = catalog) =>
    prepareDataAnswer({ conversation: await f.conversation(), request: fx!.request, message: fx!.message, now }, within)
  /** La respuesta, con lo que devolvió su plantilla (para mirar sus huecos). */
  const answer = async (now = new Date(), read?: AnyDataCapability['read']): Promise<Answered> => {
    const { render, catalog: within } = spied(read)
    const out = await ask(now, within)
    if (out.kind !== 'answer') throw new Error(`${key}: ${out.text}`)
    return { out, rendered: render.mock.results[render.mock.results.length - 1].value as Rendered }
  }
  const ready = async () => {
    await f.grant(fx!.grant)
    await f.unlock()
  }

  it('has a fixture', () => expect(fx).toBeDefined())

  it("without today's unlock: the same fixed text, NEEDS_UNLOCK, read never called (case 5)", async () => {
    await f.grant(fx!.grant)
    const { read, catalog: within } = spied()
    expect(await ask(undefined, within)).toMatchObject({
      kind: 'refusal',
      text: SUPPORT_DATA_NEEDS_UNLOCK,
      log: { result: 'NEEDS_UNLOCK', capability: key },
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('without each of its permissions: «no puedo mostrarte», read never called (case 8)', async () => {
    await ready()
    const { read, catalog: within } = spied()
    for (const permission of fx!.grant.permissions) {
      await f.grant({ ...fx!.grant, permissions: fx!.grant.permissions.filter(p => p !== permission) })
      expect(await ask(undefined, within)).toMatchObject({
        kind: 'refusal',
        text: supportDataNoPermission(def().object),
        log: { result: 'NO_PERMISSION', capability: key },
      })
    }
    expect(read).not.toHaveBeenCalled()
  })

  it('its figures are the seeded ones and the text passes checkRendered; no two text holes glued together', async () => {
    const seeded = await fx!.seed(f)
    await ready()
    const { out, rendered } = await answer() // ANSWERED: ya pasó checkRendered
    for (const figure of seeded.figures) expect(out.envelope.text).toContain(figure)
    expect(gluedTextHoles(rendered)).toEqual([])
  })

  it('the answer of its own venue does not change with data of another venue or of another organization (T-B38)', async () => {
    await ready()
    expect(await foreignDataProblems(def(), fx!, f, answer)).toEqual([])
  })

  // Aviso temprano, ya no la garantía (la da la prueba de arriba): dice QUÉ consulta se salió de la sucursal o de la ventana.
  it('every query of its read carries the venue and its window, and it touches nothing forbidden (case 22)', async () => {
    const seeded = await fx!.seed(f)
    await ready()
    const original = def().read
    let calls: QueryCall[] = []
    await answer(undefined, async (scope, params) => {
      const spy = spyQueries()
      try {
        return await original(scope, params)
      } finally {
        calls = spy.calls
        spy.restore()
      }
    })
    // Sin una sola consulta anotada, el ciclo de abajo no revisaría nada (una lectura que no pasa por prisma ni por legacyPool).
    if (fx!.windowed.length) expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      if (fx!.allowed?.(call)) continue
      const where = `${key}: ${call.model ?? 'raw'}.${call.action}`
      expect([where, call.action === 'legacyPool.query' || fx!.forbidden.includes(call.model ?? '')]).toEqual([where, false]) // (a)
      const json = JSON.stringify(call.args)
      if (call.model === null || fx!.windowed.includes(call.model)) {
        // (b) la sucursal, al menos una fecha y todas dentro de la ventana. Salvo los dos bordes exactos de la banda de llegada de D93
        // (`dondeHoraRealEntre`, develop 17-nov): `createdAt` desde 1 h antes hasta 25 h después; la hora real sí va en la ventana.
        const dates = (json.match(ISO) ?? []).map(d => new Date(d).getTime())
        const band = [seeded.window.from.getTime() - MARGEN_DE_LECTURA_ANTES_MS, seeded.window.to.getTime() + MARGEN_DE_LECTURA_MS]
        const outside = dates.filter(d => (d < seeded.window.from.getTime() || d > seeded.window.to.getTime()) && !band.includes(d))
        expect([where, json.includes(f.northId), dates.length > 0, outside]).toEqual([where, true, true, []])
      } else {
        // (c) por llave, con tope o por id
        const args = (call.args ?? {}) as { take?: unknown; where?: { id?: unknown } }
        expect([where, call.action.startsWith('findUnique') || args.take !== undefined || args.where?.id !== undefined]).toEqual([
          where,
          true,
        ])
      }
    }
  })

  it('no logger argument carries an amount of the result (case 23)', async () => {
    const seeded = await fx!.seed(f)
    await ready()
    const log = spyLogger()
    await answer()
    expect(amountLeaks(log.args(), seeded.amounts)).toEqual([])
    log.restore()
  })

  it('poisoned names (a long number, a link, an email, an RFC) come out as the replacement; none of them raw (case 20, T-B39)', async () => {
    await ready()
    expect(await poisonProblems(fx!, f, answer)).toEqual([])
  })

  it('with data and with zero rows, the text says the venue and «(corte HH:mm)» (case 52)', async () => {
    await ready()
    const says = async () => {
      const { out } = await answer()
      expect(out.envelope.text).toContain(safeDbText('Norte'))
      expect(out.envelope.text).toMatch(/\(corte \d{2}:\d{2}\)/)
    }
    await says()
    await fx!.seed(f)
    await says()
  })

  it('the verification withdrawn after preparing → checkDataDelivery says STALE for this capability too (case 40)', async () => {
    await fx!.seed(f)
    await ready()
    const { out } = await answer()
    if (out.kind !== 'answer') throw new Error(key)
    await prisma.venue.update({ where: { id: f.northId }, data: { kycStatus: 'IN_REVIEW' } })
    expect(await checkDataDelivery(await f.conversation(), out.accessFingerprint, out.envelope, new Date(), catalog)).toBe('STALE')
  })

  it('no cash-of-the-day and no breakdown by method (case 34)', async () => {
    await fx!.seed(f)
    await ready()
    const { out } = await answer()
    expect(out.envelope.text).not.toMatch(/efectivo del d[ií]a|esperado en caja|por m[eé]todo/i)
  })

  it('fits in 1,500 characters and 7 lines', async () => {
    await fx!.seed(f)
    await ready()
    const { out } = await answer()
    expect(out.envelope.text.length).toBeLessThanOrEqual(1500)
    expect(out.envelope.text.split(/\r\n|[\n\r\u2028\u2029]/).length).toBeLessThanOrEqual(7)
  })

  // T-B47 (Codex bloque 3 r1): las que leen monto y hora con `paymentParams` (hoy find_payment y payment_invoice) cruzan un monto
  // equivocado de la IA con una hora corregida; las demás preguntas del barrido no traen hora
  if (catalog[key]?.params === paymentParams)
    it('a wrong AI amount that is the corrected hour («cobré 850 a las 2, no, 3», amount 3): PARAM_TIME, read never called (T-B47)', async () => {
      await ready()
      const { read, catalog: within } = spied()
      const request = { ...fx!.request, day: 'today' as const, amount: '3', time: 'a las 2' }
      const out = await prepareDataAnswer(
        { conversation: await f.conversation(), request, message: 'cobré 850 a las 2, no, 3', now: new Date() },
        within,
      )
      expect(out).toMatchObject({
        kind: 'refusal',
        text: SUPPORT_DATA_REFUSALS.PARAM_TIME,
        log: { result: 'PARAM_INVALID', capability: key },
      })
      expect(read).not.toHaveBeenCalled()
    })
}

const keys = Object.keys(DATA_CAPABILITIES)
if (keys.length) describe.each(keys)('%s', key => sweep(DATA_CAPABILITIES, key, capabilityFixtures[key]))

// ─── El barrido mismo, sobre una capacidad de mentira que lee la base, y sus variantes rotas ──────────────────────────────────

/** Sólo los renglones de este archivo: así ninguna variante rota lee los de otra prueba. */
const SWEEP_SOURCE = `support-sweep-${Date.now()}`
const HOUR = 3_600_000
/** La ventana de la capacidad de mentira: la última hora, hasta el corte. */
const lastHour = (scope: DataScope) => ({ gte: new Date(scope.now.getTime() - HOUR), lte: scope.now })
type Discounts = { total: Prisma.Decimal; name: string }
const summed = (rows: { name: string; value: Prisma.Decimal }[]): Discounts => ({
  total: rows.reduce((sum, row) => sum.plus(row.value), new Prisma.Decimal(0)),
  name: rows.map(row => row.name).join(', '),
})
const readDiscounts = async (where: Prisma.DiscountWhereInput, take: number) =>
  summed(
    await prisma.discount.findMany({
      where: { ...where, source: SWEEP_SOURCE },
      select: { name: true, value: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
    }),
  )
/** La de mentira que cumple: los descuentos de SU sucursal en la ventana. Imprime la sucursal, el corte, la suma y los nombres. */
const discountsCapability: AnyDataCapability = {
  ...fakeCapability,
  read: (scope: DataScope) => readDiscounts({ venueId: scope.venueId, createdAt: lastHour(scope) }, scope.rows),
}
/**
 * Un descuento por sucursal, creado hace `ago` ms (dentro de la última hora con 60 s). `ago` en null no crea nada: sólo dice sus
 * cifras (una siembra ineficaz, para los controles que deben fallar).
 */
async function seedDiscounts(f: DataFixture, other: ForeignSeed | undefined, ago: number | null) {
  const venueId = other?.venueId ?? f.northId
  const name = other ? `Mesa ${['', 'Bravo', 'Charlie'][other.marker]}` : 'Mesa 12'
  const value = other ? 700 + other.marker * 11.11 : 12345.6
  await prisma.discount.deleteMany({ where: { venueId, source: SWEEP_SOURCE } })
  if (ago !== null)
    await prisma.discount.create({
      data: { venueId, name, type: 'FIXED_AMOUNT', value, source: SWEEP_SOURCE, createdAt: new Date(Date.now() - ago) },
    })
  return {
    figures: [fmtMoney(value), name],
    amounts: [value],
    window: { from: new Date(Date.now() - 2 * HOUR), to: new Date(Date.now() + HOUR) },
  }
}
const discountsFixture: CapabilityFixture = {
  request: { capability: 'fake', day: 'today', amount: '850', time: null, otherVenue: false },
  message: '¿entró un cobro de 850?',
  grant: { permissions: ['reports:read'], features: ['RESERVATIONS'] },
  seed: (f, other) => seedDiscounts(f, other, 60_000),
  poison: async (f, value) => {
    await prisma.venue.update({ where: { id: f.northId }, data: { name: value } })
    await prisma.discount.updateMany({ where: { venueId: f.northId, source: SWEEP_SOURCE }, data: { name: value } })
    return { replacedBy: [safeDbText(value)] }
  },
  windowed: ['Discount'],
  forbidden: [],
}
describe('the sweep itself, on a test capability that reads the database', () =>
  sweep(dataCatalog(discountsCapability), 'fake', discountsFixture))

/** Las variantes rotas: cada una tiene que hacer fallar su cerca. La de arriba, que cumple, tiene que pasar las dos. */
describe('the behavioural fences have teeth (T-B38, T-B39)', () => {
  let f: DataFixture
  beforeAll(async () => {
    f = await seedDataFixture('support-data-sweep-teeth')
  })
  afterAll(() => f?.clean())
  beforeEach(async () => {
    await f.reset()
    process.env.SUPPORT_DATA_ENABLED = 'true'
    await prisma.discount.deleteMany({ where: { source: SWEEP_SOURCE } })
    await f.grant(discountsFixture.grant)
    await f.unlock()
  })
  afterEach(() => jest.restoreAllMocks())
  const answerWith =
    (def: AnyDataCapability): Answer =>
    async (now = new Date()) => {
      const render = jest.fn(def.render)
      const out = await prepareDataAnswer(
        { conversation: await f.conversation(), request: discountsFixture.request, message: discountsFixture.message, now },
        dataCatalog({ ...def, render }),
      )
      if (out.kind !== 'answer') throw new Error(out.text)
      return { out, rendered: render.mock.results[render.mock.results.length - 1].value as Rendered }
    }
  const broken = (read: (scope: DataScope) => Promise<Discounts>): AnyDataCapability => ({ ...discountsCapability, read })
  const orCapability = broken(scope => readDiscounts({ OR: [{ venueId: scope.venueId }, { createdAt: lastHour(scope) }] }, scope.rows))

  it('the capability that keeps to its venue passes both', async () => {
    expect(await foreignDataProblems(discountsCapability, discountsFixture, f, answerWith(discountsCapability))).toEqual([])
    expect(await poisonProblems(discountsFixture, f, answerWith(discountsCapability))).toEqual([])
  })
  it.each<[string, AnyDataCapability]>([
    ['OR: [{ venueId }, { createdAt }]', orCapability],
    [
      'a findUnique by id that does not check the venue (the organization, with all its venues)',
      broken(async scope => {
        const org = await prisma.organization.findUnique({
          where: { id: scope.organizationId },
          select: {
            venues: {
              take: 10,
              select: {
                discounts: {
                  where: { source: SWEEP_SOURCE, createdAt: lastHour(scope) },
                  select: { name: true, value: true },
                  take: scope.rows,
                },
              },
            },
          },
        })
        return summed(org?.venues.flatMap(venue => venue.discounts) ?? [])
      }),
    ],
    ['no venue filter at all', broken(scope => readDiscounts({ createdAt: lastHour(scope) }, scope.rows))],
  ])('the foreign-data fence fails with %s', async (_label, def) => {
    expect((await foreignDataProblems(def, discountsFixture, f, answerWith(def))).length).toBeGreaterThan(0)
  })
  // T-B38b: la siembra ajena tiene que participar. Con cualquiera de estas, el «idéntico con y sin» saldría parejo aunque la
  // capacidad mezclara sucursales: por eso cada una falla con el control positivo, también junto a la capacidad del `OR`.
  const createsNothing: CapabilityFixture = { ...discountsFixture, seed: (fx, other) => seedDiscounts(fx, other, other ? null : 60_000) }
  const outsideWindow: CapabilityFixture = { ...discountsFixture, seed: (fx, other) => seedDiscounts(fx, other, other ? 3 * HOUR : 60_000) }
  it.each<[string, string, CapabilityFixture, AnyDataCapability]>([
    ['a foreign seed that creates nothing', 'the capability that keeps to its venue', createsNothing, discountsCapability],
    ['a foreign seed that creates nothing', 'the OR capability', createsNothing, orCapability],
    [
      'a foreign seed that creates its rows outside the window',
      'the capability that keeps to its venue',
      outsideWindow,
      discountsCapability,
    ],
    ['a foreign seed that creates its rows outside the window', 'the OR capability', outsideWindow, orCapability],
  ])('the foreign-data fence fails with %s, with %s', async (_label, _with, fixture, def) => {
    const problems = await foreignDataProblems(def, fixture, f, answerWith(def))
    expect(problems.length).toBe(2) // una por sucursal ajena
    for (const problem of problems) expect(problem).toContain(INEFFECTIVE)
  })
  // Las tres capacidades que mezclan sucursales (el `OR`, el `findUnique` y sin filtro) ya las para el control positivo: leídas con
  // otra sucursal, sus sumas mezclan. Ésta sólo mezcla en la respuesta propia, así que pasa los controles positivos: la detiene la
  // comparación «idéntica con y sin».
  it('the comparison still fails a leak that the positive controls cannot see (the sibling added only to the own venue)', async () => {
    const leaksIntoOwn = broken(scope =>
      readDiscounts(
        { venueId: { in: scope.venueId === f.northId ? [f.northId, f.siblingId] : [scope.venueId] }, createdAt: lastHour(scope) },
        scope.rows,
      ),
    )
    const problems = await foreignDataProblems(leaksIntoOwn, discountsFixture, f, answerWith(leaksIntoOwn))
    expect(problems.some(problem => problem.startsWith('con datos de otra sucursal la respuesta cambió'))).toBe(true)
    expect(problems.some(problem => problem.includes(INEFFECTIVE))).toBe(false)
  })
  // T-B38c: el primer renglón sin filtro de sucursal, con el orden que hace ganar al propio cuando existe. Pasa los controles
  // positivos (cada sucursal ve el suyo) y la comparación (en Norte gana el de Norte): sólo lo detiene la pierna sin datos.
  it('the zero-rows leg fails a first match without a venue filter whose ordering lets the own row win (T-B38c)', async () => {
    const firstMatch = broken(async scope => {
      const { gte, lte } = lastHour(scope)
      return summed(
        await prisma.$queryRaw<{ name: string; value: Prisma.Decimal }[]>`
          SELECT name, value FROM "Discount"
          WHERE source = ${SWEEP_SOURCE} AND "createdAt" BETWEEN ${utcTs(gte)} AND ${utcTs(lte)}
          ORDER BY ("venueId" = ${scope.venueId}) DESC, "createdAt" DESC, id DESC
          LIMIT 1`,
      )
    })
    const problems = await foreignDataProblems(firstMatch, discountsFixture, f, answerWith(firstMatch))
    expect(problems.some(problem => problem.startsWith(`${EMPTY_VENUE}: la respuesta cambió`))).toBe(true)
    expect(problems.some(problem => problem.includes(INEFFECTIVE) || problem.startsWith('con datos de otra sucursal'))).toBe(false)
  })
  // R3-1 (T-B41), la sonda del auditor: la hora que preguntó la persona («a las 14:30»), leída en la zona de la sucursal, y el primer
  // renglón sin filtro de sucursal que prefiere el propio. Con la pierna sin datos en OTRA zona, su ventana cae en otra hora (14:30 en
  // Cancún son las 19:30Z; las siembras de la Ciudad de México, a las 20:30Z) y ninguna siembra entra: la sonda pasaba las tres
  // comprobaciones. Con la sucursal sin datos en la MISMA zona que las sembradas, esa pierna la detiene.
  it('the zero-rows leg fails a first match by the hour asked, read in the zone of each venue (R3-1)', async () => {
    const byAskedHour = broken(async scope => {
      // La hora de las siembras (un minuto antes del reloj), escrita como la diría la persona en la Ciudad de México.
      const asked = formatInTimeZone(new Date(scope.now.getTime() - 60_000), 'America/Mexico_City', "yyyy-MM-dd'T'HH:mm:ss")
      const at = fromZonedTime(asked, scope.timezone).getTime()
      return summed(
        await prisma.$queryRaw<{ name: string; value: Prisma.Decimal }[]>`
          SELECT name, value FROM "Discount"
          WHERE source = ${SWEEP_SOURCE} AND "createdAt" BETWEEN ${utcTs(new Date(at - HOUR / 2))} AND ${utcTs(new Date(at + HOUR / 2))}
          ORDER BY ("venueId" = ${scope.venueId}) DESC, "createdAt" DESC, id DESC
          LIMIT 1`,
      )
    })
    const problems = await foreignDataProblems(byAskedHour, discountsFixture, f, answerWith(byAskedHour))
    expect(problems.some(problem => problem.startsWith(`${EMPTY_VENUE}: la respuesta cambió`))).toBe(true)
    expect(problems.some(problem => problem.includes(INEFFECTIVE) || problem.startsWith('con datos de otra sucursal'))).toBe(false)
  })
  it('the foreign-data fence fails with a capability that ignores its scope (it always reads the own venue)', async () => {
    const ignoresScope = broken(scope => readDiscounts({ venueId: f.northId, createdAt: lastHour(scope) }, scope.rows))
    const problems = await foreignDataProblems(ignoresScope, discountsFixture, f, answerWith(ignoresScope))
    expect(problems.length).toBe(2)
    for (const problem of problems) expect(problem).toContain(INEFFECTIVE)
  })
  it('the poison fence fails with a template that prints a name from the database without t.text()', async () => {
    const raw: AnyDataCapability = {
      ...discountsCapability,
      render: (scope: DataScope, _params: unknown, result: Discounts) => {
        const t = template(scope.timezone)
        return t.done(
          `Dato de prueba en ${t.text(scope.venueName)} (corte ${t.time(scope.now)}): ${t.money(result.total)} en ${result.name}`,
        )
      },
    }
    const problems = await poisonProblems(discountsFixture, f, answerWith(raw))
    // el número y el RFC traen dígitos fuera de un hueco; la liga y el correo no: los detiene la regla de salida (T-B39)
    for (const { value } of POISONS) expect(problems.some(problem => problem.startsWith(`«${value}»`))).toBe(true)
  })
})

// ─── T-B43: una negativa es un texto fijo, nunca un dato ─────────────────────────────────────────────────────────────────────

/**
 * Toda negativa de la B se guarda como ayuda (HELP), sin cifrar, y llega tal cual al historial del modelo: por eso es SIEMPRE un
 * texto fijo de texts.ts (Ruling T-B43, hallazgo de Codex b2-r1). El veneno va en el nombre de la sucursal, de la persona y de la
 * organización: un monto, una tarjeta de prueba y una liga. Por cada camino que termina en una negativa, (1) prepareDataAnswer
 * contesta exactamente su texto fijo, sin nada del veneno; y (2) por el worker de verdad, la negativa se guarda así y, en la
 * siguiente pregunta, nada del veneno llega al modelo de mentira. Los caminos que arman el texto con el alcance (con un `as` que se
 * salta el tipo, como lo haría un error del bloque 3) caen en la genérica: el orquestador falla cerrado.
 */
const VENOM = 'Club $876.54 4111111111111111 https://bit.ly/club'
/** Lo que no puede salir del veneno, ni crudo ni saneado. */
const venomIn = (text: string) => ['Club', '876', '4111', 'bit.ly', SUPPORT_DATA_OMITTED, '[enlace]'].filter(piece => text.includes(piece))
const QUESTION = '¿entró un cobro de 850?'
const NONE = { capability: 'none', day: 'none', amount: '', time: '', otherVenue: false }
/** Lo que contesta «Entender» de mentira: la pregunta de datos de la capacidad de mentira, con lo que cambie el camino. */
const understood = (request: Partial<DataRequest> = {}) => ({
  kind: 'data',
  standalone: '',
  guideIds: [],
  data: { ...NONE, capability: 'fake', day: 'today', amount: '850', ...request },
})
const UNKNOWN = { kind: 'unknown', standalone: '', guideIds: [], data: NONE }
const unlockWithout = (grant: Parameters<DataFixture['grant']>[0]) => async (f: DataFixture) => {
  await f.unlock()
  await f.grant(grant)
}

interface RefusalPath {
  name: string
  /** El texto fijo que tiene que salir (una función: la tabla no lee texts.ts al cargarse). */
  text: () => string
  /** Después de reiniciar y envenenar; si falta, el desbloqueo del día. */
  arrange?: (f: DataFixture) => Promise<unknown>
  request?: Partial<DataRequest>
  capability?: Partial<AnyDataCapability>
  conversation?: Partial<SupportConversation>
  /** Por qué el worker no llega a este camino (sólo prepareDataAnswer lo recorre). */
  workerless?: string
}
const REFUSAL_PATHS: RefusalPath[] = [
  {
    name: 'la B off',
    text: () => SUPPORT_DATA_OFF,
    arrange: async f => {
      await f.unlock()
      process.env.SUPPORT_DATA_ENABLED = 'false'
    },
    workerless: '«Entender» no ofrece datos con la B apagada',
  },
  {
    name: 'a public conversation',
    text: () => SUPPORT_DATA_LINK_FIRST,
    conversation: { mode: 'PUBLIC' },
    workerless: 'la plática del fixture es personal',
  },
  {
    name: 'a superadmin',
    text: () => SUPPORT_DATA_SUPERADMIN,
    arrange: async f => {
      await f.unlock()
      await prisma.staffVenue.updateMany({ where: { staffId: f.staffId, venueId: f.cancunId }, data: { role: 'SUPERADMIN' } })
    },
  },
  { name: 'out of the catalog', text: () => supportDataOutOfCatalog(['dato de prueba']), request: { capability: 'other' } },
  { name: 'another venue', text: () => SUPPORT_DATA_OTHER_VENUE, request: { otherVenue: true } },
  { name: "without today's unlock", text: () => SUPPORT_DATA_NEEDS_UNLOCK, arrange: async () => undefined },
  {
    name: 'without its permission (Codex b2-r1)',
    text: () => supportDataNoPermission('el dato de prueba'),
    arrange: unlockWithout({ permissions: [], features: ['RESERVATIONS'] }),
  },
  {
    name: 'without the plan',
    text: () => SUPPORT_DATA_REFUSALS.PLAN_RESERVATIONS,
    arrange: unlockWithout({ permissions: ['reports:read'] }),
  },
  {
    name: 'a plan refusal that is not a key',
    text: () => SUPPORT_DATA_REFUSALS.NOT_AVAILABLE,
    arrange: unlockWithout({ permissions: ['reports:read'] }),
    capability: { gate: { ...fakeCapability.gate!, refusal: VENOM as DataRefusalKey } },
  },
  { name: 'not offered here', text: () => SUPPORT_DATA_REFUSALS.NOT_AVAILABLE, capability: { notOffered: () => 'NOT_AVAILABLE' } },
  {
    name: 'a not-offered text built from the venue (Codex b2-r1)',
    text: () => SUPPORT_DATA_REFUSALS.NOT_AVAILABLE,
    capability: { notOffered: scope => `No disponible en ${scope.venueName}` as DataRefusalKey },
  },
  { name: 'an amount it did not write', text: () => SUPPORT_DATA_REFUSALS.PARAM_AMOUNT, request: { amount: '900' } },
  {
    name: 'a params refusal built from the venue',
    text: () => SUPPORT_DATA_REFUSALS.NOT_AVAILABLE,
    capability: { params: (_request, _message, scope) => ({ ok: false, refusal: scope.venueName as DataRefusalKey }) },
  },
  {
    name: 'the daily cap',
    text: () => SUPPORT_DATA_DAILY_CAP,
    arrange: async f => {
      await f.unlock()
      const day = venueDayKey(new Date(), 'America/Mexico_City')
      const row = { staffId: f.staffId, venueId: f.northId, capability: 'fake', paramsHmac: 'x', result: 'ANSWERED' as const, day }
      await Promise.all(Array.from({ length: getSupportDataConfig()!.dailyCap }, () => recordSupportDataQuery(prisma, row)))
    },
  },
  {
    name: 'a read over its cap',
    text: () => SUPPORT_DATA_REFUSALS.NOT_AVAILABLE,
    capability: { read: () => Promise.reject(new DataReadRefusal('OVER_CAP', 'NOT_AVAILABLE')) },
  },
  {
    name: 'an over-cap text built from the venue',
    text: () => SUPPORT_DATA_REFUSALS.NOT_AVAILABLE,
    capability: { read: (scope: DataScope) => Promise.reject(new DataReadRefusal('OVER_CAP', scope.venueName as DataRefusalKey)) },
  },
  {
    name: 'a read that fails with the venue in its error',
    text: () => SUPPORT_DATA_QUERY_FAILED,
    capability: { read: (scope: DataScope) => Promise.reject(new Error(scope.venueName)) },
  },
  // Las negativas propias de las capacidades del bloque 3, cada una donde la usa su tarea
  { name: 'SALES_LEGACY_QR (C1)', text: () => SUPPORT_DATA_REFUSALS.SALES_LEGACY_QR, capability: { notOffered: () => 'SALES_LEGACY_QR' } },
  {
    name: 'SALES_TODAY_ONLY (C1)',
    text: () => SUPPORT_DATA_REFUSALS.SALES_TODAY_ONLY,
    capability: { params: () => ({ ok: false, refusal: 'SALES_TODAY_ONLY' }) },
  },
  // C2: PARAM_AMOUNT ya tiene su camino de verdad («an amount it did not write»); el día y la hora, sobre la capacidad de mentira
  {
    name: 'PARAM_DAY (C2)',
    text: () => SUPPORT_DATA_REFUSALS.PARAM_DAY,
    capability: { params: () => ({ ok: false, refusal: 'PARAM_DAY' }) },
  },
  {
    name: 'PARAM_TIME (C2)',
    text: () => SUPPORT_DATA_REFUSALS.PARAM_TIME,
    capability: { params: () => ({ ok: false, refusal: 'PARAM_TIME' }) },
  },
  // C4: PLAN_RESERVATIONS ya tiene su camino de verdad («without the plan»); el de sólo hoy, sobre la capacidad de mentira
  {
    name: 'RESERVATIONS_TODAY_ONLY (C4)',
    text: () => SUPPORT_DATA_REFUSALS.RESERVATIONS_TODAY_ONLY,
    capability: { params: () => ({ ok: false, refusal: 'RESERVATIONS_TODAY_ONLY' }) },
  },
  // C6: las cuatro, cada una donde la usa su tarea (candado, notOffered, params y su tope), sobre la capacidad de mentira
  {
    name: 'PLAN_DEPOSITS (C6)',
    text: () => SUPPORT_DATA_REFUSALS.PLAN_DEPOSITS,
    arrange: unlockWithout({ permissions: ['reports:read'] }),
    capability: { gate: { ...fakeCapability.gate!, refusal: 'PLAN_DEPOSITS' } },
  },
  {
    name: 'DEPOSITS_NEEDS_KYC (C6)',
    text: () => SUPPORT_DATA_REFUSALS.DEPOSITS_NEEDS_KYC,
    capability: { notOffered: () => 'DEPOSITS_NEEDS_KYC' },
  },
  {
    name: 'DEPOSITS_THIS_WEEK_ONLY (C6)',
    text: () => SUPPORT_DATA_REFUSALS.DEPOSITS_THIS_WEEK_ONLY,
    capability: { params: () => ({ ok: false, refusal: 'DEPOSITS_THIS_WEEK_ONLY' }) },
  },
  {
    name: 'DEPOSITS_OVER_CAP (C6)',
    text: () => SUPPORT_DATA_REFUSALS.DEPOSITS_OVER_CAP,
    capability: { read: () => Promise.reject(new DataReadRefusal('OVER_CAP', 'DEPOSITS_OVER_CAP')) },
  },
  // C7: su candado, sobre la capacidad de mentira (PARAM_DAY, PARAM_AMOUNT y PARAM_TIME ya tienen camino, los de C2)
  {
    name: 'PLAN_INVOICES (C7)',
    text: () => SUPPORT_DATA_REFUSALS.PLAN_INVOICES,
    arrange: unlockWithout({ permissions: ['reports:read'] }),
    capability: { gate: { ...fakeCapability.gate!, refusal: 'PLAN_INVOICES' } },
  },
  // C8: el de otro día, en su `params`, sobre la capacidad de mentira
  {
    name: 'CASH_DRAWER_TODAY_OR_YESTERDAY (C8)',
    text: () => SUPPORT_DATA_REFUSALS.CASH_DRAWER_TODAY_OR_YESTERDAY,
    capability: { params: () => ({ ok: false, refusal: 'CASH_DRAWER_TODAY_OR_YESTERDAY' }) },
  },
  {
    name: 'a template that prints the venue raw',
    text: () => SUPPORT_DATA_CHECK_FAILED,
    capability: { render: (scope: DataScope) => ({ text: `En ${scope.venueName}`, figures: [] }) },
  },
]

describe('T-B43: every refusal is a fixed text, never data', () => {
  let f: DataFixture, receiverId: string
  let serial = 0
  const originalFetch = global.fetch
  beforeAll(async () => {
    f = await seedDataFixture('support-data-refusals')
    ;({ receiverId } = await f.conversation())
    Object.assign(process.env, FAKE_SUPPORT_AI_ENV)
  })
  afterAll(async () => {
    if (!f) return
    await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${receiverId}:` } } })
    await f.clean()
    for (const key of Object.keys(FAKE_SUPPORT_AI_ENV)) delete process.env[key]
  })
  beforeEach(async () => {
    await f.reset()
    process.env.SUPPORT_DATA_ENABLED = 'true'
    await prisma.supportBudget.deleteMany({
      where: { OR: [{ key: { startsWith: 'AI:' } }, { key: { startsWith: `CONTROL:${receiverId}:` } }] },
    })
    // Meta (el indicador de escritura) nunca sale de la prueba.
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch
    // El veneno, en los tres nombres que el alcance o la base podrían colar en un texto.
    await prisma.venue.update({ where: { id: f.northId }, data: { name: VENOM } })
    await prisma.staff.update({ where: { id: f.staffId }, data: { firstName: VENOM, lastName: VENOM } })
    await prisma.organization.update({ where: { id: f.orgId }, data: { name: VENOM } })
  })
  afterEach(() => {
    global.fetch = originalFetch
    process.env.SUPPORT_DATA_ENABLED = 'true'
    jest.restoreAllMocks()
  })

  const catalogOf = (path: RefusalPath): DataCatalog => dataCatalog({ ...fakeCapability, ...path.capability })
  /** Una vuelta del worker de verdad: admite la pregunta en la plática personal, la reclama y la prepara con «Entender» de mentira. */
  const turn = async (reply: object, catalog: DataCatalog) => {
    const { phone } = await f.conversation()
    const { messageId } = await admitSupportMessage({
      receiverId,
      phone,
      wamid: `wamid.${receiverId}-refusal-${++serial}`,
      type: 'text',
      body: QUESTION,
      timestamp: String(Math.floor(Date.now() / 1000)),
    })
    await prisma.supportConversation.updateMany({
      where: { receiverId, phone, mode: { not: 'CLOSED' } },
      data: { lastUserMessageAt: new Date(), lastActivityAt: new Date() },
    })
    const ai = fakeSupportAi([reply])
    const claim = await claimNext(new Date(Date.now() + 10), receiverId)
    await prepareSupportAnswer(claim!, { client: ai.client, library: [fixtureGuide], dataCapabilities: catalog })
    return { ai, message: await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } }) }
  }
  const markSent = (id: string) =>
    prisma.supportMessage.update({ where: { id }, data: { status: 'SENT', outboundWamid: `wamid.out-refusal-${++serial}` } })

  it.each(REFUSAL_PATHS.map(path => [path.name, path] as const))(
    '%s: prepareDataAnswer answers exactly its fixed text, with nothing of the poison',
    async (_name, path) => {
      await (path.arrange ?? (fx => fx.unlock()))(f)
      const conversation = { ...(await f.conversation()), ...path.conversation }
      const out = await prepareDataAnswer(
        { conversation, request: { ...understood(path.request).data, time: null } as DataRequest, message: QUESTION, now: new Date() },
        catalogOf(path),
      )
      expect(out).toMatchObject({ kind: 'refusal', text: path.text() })
      // sólo el texto: el renglón del registro lleva ids y una huella hex, que pueden traer «876» por azar
      expect(venomIn((out as { text?: string }).text ?? '')).toEqual([])
    },
  )

  it.each(REFUSAL_PATHS.filter(path => !path.workerless).map(path => [path.name, path] as const))(
    '%s: through the worker it is saved as that fixed text, and the next question sends nothing of the poison to the model',
    async (_name, path) => {
      await (path.arrange ?? (fx => fx.unlock()))(f)
      const first = await turn(understood(path.request), catalogOf(path))
      expect(first.message).toMatchObject({ purpose: 'HELP', answerCipher: null })
      expect(first.message.answer?.split('\n\n')[0]).toBe(path.text())
      await markSent(first.message.id)
      const next = await turn(UNKNOWN, catalogOf(path))
      const [input] = next.ai.inputs()
      // la negativa sí llegó al historial (si no, la revisión de abajo no probaría nada)
      expect(input.history).toEqual([
        { role: 'user', text: QUESTION },
        { role: 'assistant', text: expect.any(String) },
      ])
      expect(venomIn(JSON.stringify(next.ai.inputs()))).toEqual([])
    },
  )

  // El caso exacto de Codex b2-r1: con el texto viejo salía «Con tus permisos en Club $876.54 no puedo mostrarte…», guardado como
  // ayuda sin cifrar, y en la siguiente pregunta el modelo recibía el importe en el historial.
  it("Codex b2-r1: «Club $876.54», without reports:read and with today's unlock → the fixed text without the name; the next question's history has no 876.54", async () => {
    await prisma.venue.update({ where: { id: f.northId }, data: { name: 'Club $876.54' } })
    await unlockWithout({ permissions: [], features: ['RESERVATIONS'] })(f)
    const first = await turn(understood(), dataCatalog(fakeCapability))
    await markSent(first.message.id)
    const next = await turn(UNKNOWN, dataCatalog(fakeCapability))
    const history = JSON.stringify(next.ai.inputs()[0].history)
    expect({ answerHasIt: !!first.message.answer?.includes('876.54'), historyHasIt: history.includes('876.54') }).toEqual({
      answerHasIt: false,
      historyHasIt: false,
    })
    expect(first.message.answer?.split('\n\n')[0]).toBe(supportDataNoPermission('el dato de prueba'))
    expect(history).toContain('Con tus permisos en esta sucursal no puedo mostrarte el dato de prueba')
  })

  // ── T-B44 (Codex b2-r2): un texto que se cree fijo no se cambia en ejecución ──
  /** Lo que tiene que seguir igual después de cada sonda: la genérica, y la etiqueta y el objeto de la copia del catálogo. */
  const constantsHold = (catalog: DataCatalog) =>
    expect([SUPPORT_DATA_REFUSALS.NOT_AVAILABLE, catalog.fake.label, catalog.fake.object]).toEqual([
      'Ese dato no está disponible por WhatsApp en esta sucursal. Lo encuentras en el panel.',
      'dato de prueba',
      'el dato de prueba',
    ])
  /** Las dos sondas de Codex b2-r2 tal cual: cada una escribe, dentro de `notOffered`, sobre lo que nace congelado. */
  const PROBES: [string, () => AnyDataCapability][] = [
    [
      '#1 Object.assign(SUPPORT_DATA_REFUSALS, { NOT_AVAILABLE: scope.venueName })',
      () => ({
        ...fakeCapability,
        notOffered: (scope: DataScope) => {
          Object.assign(SUPPORT_DATA_REFUSALS, { NOT_AVAILABLE: scope.venueName })
          return 'NOT_AVAILABLE'
        },
      }),
    ],
    [
      '#2 sample.object = sample.label = scope.venueName',
      () => {
        const sample: AnyDataCapability = {
          ...fakeCapability,
          notOffered(scope: DataScope) {
            sample.object = scope.venueName
            sample.label = scope.venueName
            return null
          },
        }
        return sample
      },
    ],
  ]
  it.each(PROBES)(
    'Codex b2-r2 %s: the write throws and the orchestrator fails closed with its fixed text; nothing of the poison in the output, the out-of-catalog list or the next request to the model',
    async (_name, probe) => {
      await f.unlock()
      const catalog = dataCatalog(probe())
      const ask = async (request: Partial<DataRequest> = {}) =>
        prepareDataAnswer(
          {
            conversation: await f.conversation(),
            request: { ...understood(request).data, time: null } as DataRequest,
            message: QUESTION,
            now: new Date(),
          },
          catalog,
        )
      expect(await ask()).toMatchObject({ kind: 'refusal', text: SUPPORT_DATA_QUERY_FAILED, log: { result: 'QUERY_FAILED' } })
      expect(await ask({ capability: 'other' })).toMatchObject({ kind: 'refusal', text: supportDataOutOfCatalog(['dato de prueba']) })
      const first = await turn(understood(), catalog)
      expect(first.message).toMatchObject({ purpose: 'HELP', answerCipher: null })
      expect(first.message.answer?.split('\n\n')[0]).toBe(SUPPORT_DATA_QUERY_FAILED)
      await markSent(first.message.id)
      const next = await turn(UNKNOWN, catalog)
      expect(next.ai.inputs()[0].history).toEqual([
        { role: 'user', text: QUESTION },
        { role: 'assistant', text: expect.any(String) },
      ])
      expect(venomIn(JSON.stringify(next.ai.inputs()))).toEqual([])
      constantsHold(catalog)
    },
  )
  // La secuencia de Codex: con el permiso sale una respuesta DATA y, ya sin él, una negativa. Para llegar a la respuesta, la capacidad
  // intenta las dos escrituras y se traga el error: la marca del historial y la negativa leen la copia congelada del catálogo.
  it('Codex b2-r2 sequence: DATA with the permission, then the refusal without it; the mark and the refusal carry nothing of the poison', async () => {
    const sample: AnyDataCapability = {
      ...fakeCapability,
      notOffered(scope: DataScope) {
        try {
          Object.assign(SUPPORT_DATA_REFUSALS, { NOT_AVAILABLE: scope.venueName })
        } catch {
          // congelado (T-B44)
        }
        try {
          sample.object = scope.venueName
          sample.label = scope.venueName
        } catch {
          // congelado (T-B44)
        }
        return null
      },
    }
    const catalog = dataCatalog(sample)
    await f.unlock()
    await f.grant({ permissions: ['reports:read'], features: ['RESERVATIONS'] })
    const first = await turn(understood(), catalog)
    expect(first.message).toMatchObject({ purpose: 'DATA', answer: null, dataCapability: 'fake' })
    expect(first.message.answerCipher).toBeTruthy()
    await markSent(first.message.id)
    await f.grant({ permissions: [], features: ['RESERVATIONS'] })
    const second = await turn(understood(), catalog)
    expect(second.ai.inputs()[0].history).toEqual([
      { role: 'user', text: QUESTION },
      { role: 'assistant', text: supportDataHistoryMark('dato de prueba') },
    ])
    expect(second.message).toMatchObject({ purpose: 'HELP', answerCipher: null })
    expect(second.message.answer?.split('\n\n')[0]).toBe(supportDataNoPermission('el dato de prueba'))
    await markSent(second.message.id)
    const third = await turn(UNKNOWN, catalog)
    expect(third.ai.inputs()[0].history).toEqual([
      { role: 'user', text: QUESTION },
      { role: 'assistant', text: supportDataHistoryMark('dato de prueba') },
      { role: 'user', text: QUESTION },
      { role: 'assistant', text: expect.stringContaining(supportDataNoPermission('el dato de prueba')) },
    ])
    for (const turned of [first, second, third]) expect(venomIn(JSON.stringify(turned.ai.inputs()))).toEqual([])
    expect(venomIn(second.message.answer ?? '')).toEqual([])
    constantsHold(catalog)
  })
  // Hueco 1 (T-B44): un `setHours` sobre `scope.now` que se colara de la guardia sólo mueve la copia de ESA llamada. Cada llamada
  // recibe la hora de la pregunta, y la hora del sobre (`preparedAt`) no se mueve.
  it('a capability that moves its scope.now (setHours, setFullYear, setTime, setUTCDate) leaves preparedAt and the other calls unchanged', async () => {
    await f.unlock()
    await f.grant({ permissions: ['reports:read'], features: ['RESERVATIONS'] })
    const now = new Date()
    const at = now.getTime()
    const seen: number[] = []
    const moving: AnyDataCapability = {
      ...fakeCapability,
      notOffered: (scope: DataScope) => {
        seen.push(scope.now.getTime())
        scope.now.setHours(0, 0, 0, 0)
        return null
      },
      params: (request: DataRequest, message: string, scope: DataScope) => {
        seen.push(scope.now.getTime())
        scope.now.setFullYear(2000)
        return fakeCapability.params(request, message, scope)
      },
      read: (scope: DataScope, params: unknown) => {
        seen.push(scope.now.getTime())
        scope.now.setTime(0)
        return fakeCapability.read(scope, params as never)
      },
      render: (scope: DataScope, params: unknown, result: unknown) => {
        seen.push(scope.now.getTime())
        const rendered = fakeCapability.render(scope, params as never, result as never)
        scope.now.setUTCDate(1)
        return rendered
      },
    }
    const out = await prepareDataAnswer(
      {
        conversation: await f.conversation(),
        request: { ...understood().data, time: null } as DataRequest,
        message: QUESTION,
        now,
      },
      dataCatalog(moving),
    )
    expect(out).toMatchObject({ kind: 'answer', envelope: { preparedAt: new Date(at).toISOString() } })
    expect([now.getTime(), seen]).toEqual([at, [at, at, at, at]])
  })
  // T-B45 (Codex b2-r3): una clase guarda sus métodos en el prototipo, y la copia `{ ...c }` del catálogo los perdía: la negativa de
  // `notOffered` desaparecía y la capacidad contestaba (NOT_OFFERED → ANSWERED); con todo en métodos, siempre QUERY_FAILED.
  it('Codex b2-r3: a capability written as a class keeps its refusal (NOT_OFFERED, never ANSWERED); one with every function as a method still answers', async () => {
    await f.unlock()
    await f.grant({ permissions: ['reports:read'], features: ['RESERVATIONS'] })
    class CodexClass {
      key = 'fake'
      label = 'dato de prueba'
      object = 'el dato de prueba'
      aiHint = fakeCapability.aiHint
      permissions = ['reports:read']
      params = fakeCapability.params
      read = fakeCapability.read
      render = fakeCapability.render
      notOffered(_scope: DataScope) {
        return 'NOT_AVAILABLE' as const
      }
    }
    class AllMethods {
      key = 'fake'
      label = 'dato de prueba'
      object = 'el dato de prueba'
      aiHint = fakeCapability.aiHint
      permissions = ['reports:read']
      params(request: DataRequest, message: string, scope: DataScope) {
        return fakeCapability.params(request, message, scope)
      }
      read(scope: DataScope, params: never) {
        return fakeCapability.read(scope, params)
      }
      render(scope: DataScope, params: never, result: never) {
        return fakeCapability.render(scope, params, result)
      }
    }
    const ask = async (catalog: DataCatalog) =>
      prepareDataAnswer(
        {
          conversation: await f.conversation(),
          request: { ...understood().data, time: null } as DataRequest,
          message: QUESTION,
          now: new Date(),
        },
        catalog,
      )
    expect(await ask(dataCatalog(new CodexClass() as AnyDataCapability))).toMatchObject({
      kind: 'refusal',
      text: SUPPORT_DATA_REFUSALS.NOT_AVAILABLE,
      log: { result: 'NOT_OFFERED' },
    })
    expect((await ask(dataCatalog(new AllMethods() as unknown as AnyDataCapability))).kind).toBe('answer')
  })
  // T-B46 (Codex b2-r4): la copia por nombre tiraba la bandera que `notOffered` lee por `this` (NOT_OFFERED → ANSWERED). Sin copia,
  // el catálogo guarda el mismo objeto congelado: el método ve su bandera, y nadie la cambia después. Directo, sin pasar por la guardia.
  it('Codex b2-r4: notOffered reading a flag through this keeps NOT_OFFERED (never ANSWERED), and the flag cannot change afterwards', async () => {
    await f.unlock()
    await f.grant({ permissions: ['reports:read'], features: ['RESERVATIONS'] })
    const flags = { closed: true }
    const own = {
      ...fakeCapability,
      closed: true,
      notOffered() {
        return this.closed ? ('NOT_AVAILABLE' as const) : null
      },
    }
    const spread = {
      ...fakeCapability,
      ...flags,
      notOffered() {
        return this.closed ? ('NOT_AVAILABLE' as const) : null
      },
    }
    const ask = async (catalog: DataCatalog) =>
      prepareDataAnswer(
        {
          conversation: await f.conversation(),
          request: { ...understood().data, time: null } as DataRequest,
          message: QUESTION,
          now: new Date(),
        },
        catalog,
      )
    const refused = { kind: 'refusal', text: SUPPORT_DATA_REFUSALS.NOT_AVAILABLE, log: { result: 'NOT_OFFERED' } }
    for (const capability of [own, spread]) {
      const catalog = dataCatalog(capability as AnyDataCapability)
      expect(await ask(catalog)).toMatchObject(refused)
      expect(() => {
        capability.closed = false
      }).toThrow(TypeError)
      expect(await ask(catalog)).toMatchObject(refused)
    }
  })
})
