/**
 * Examen del asistente de soporte por WhatsApp (Task 7 del híbrido, 10-nov-2026).
 *
 * Bots:
 * - «hoy»: el motor de antes del híbrido (palabras clave → la IA elige guías → guía literal).
 * - «hibrido»: la cadena del worker (entender → aclarar | redactar → revisar → juez), con las MISMAS funciones y reglas que
 *   usa worker.service (hybridHistory, hybridFixedReply, hybridDraftGuides, hybridNeeds, hybridDraftOutcome, hybridFallback,
 *   hybridAnswerText, topSupportCandidates), con sólo las guías citadas como fuentes (T-F5: si una elegida depende de una versión
 *   o un equipo que no se saben, pregunta primero, sin respuesta parcial). Lo único que no entra es lo de base de datos y
 *   presupuesto: acceso = null (ayuda pública), sin oferta de pasar a una persona y sin la pregunta pendiente. Además guarda las
 *   guías que eligió entender al preguntar (`elegidas`), la redacción que rechazó el revisor o el juez (`rechazada`) y, desde
 *   T-F7, por qué el juez no la dejó salir tal cual (`motivoJuez`) y lo que dijo que faltaba (`citasJuez`; desde T-F8, el número
 *   de renglón con el texto al que corresponde). T-F13: nada de eso se agrega a la respuesta; un renglón de verdad de una guía
 *   citada manda la guía literal, como en el worker.
 * Los dos pasan antes por la capa del router: lo sensible no llega al asistente y un saludo suelto recibe el texto fijo.
 * Un caso puede traer `version`, `equipo` y `aparatos`: lo que dijo la plática y los aparatos de su sucursal, como los lee
 * resolveSupportDeviceContext (el híbrido acota la biblioteca con eso, pregunta la terminal o la versión, o avisa versión vieja).
 * La biblioteca es la del manifiesto en borrador (`allowDraft`, sólo para el examen). No toca la base ni WhatsApp.
 *
 * Calificación (Task 13 de la fase 1): cada `debeDecir` y `noDebeDecir` la califica otro modelo (calificador.ts), que antes
 * aprobó su meta-examen; sin el certificado vigente (calificador-congelado.json) ningún examen de casos corre. Toda corrida
 * valida sus archivos antes de llamar a nadie, y una corrida cortada, con un faltante o con un veredicto técnico es INCOMPLETO.
 *
 * Uso (IA real, sólo así: la llave la pone run.py):
 *   python3 …/scratch/piloto-20261109/run.py eval <hoy|hibrido|juez|secuencias|ocultos|ocultos-N|fase1> [corrida]
 *   python3 …/scratch/piloto-20261109/run.py eval meta-ajuste   (se puede repetir mientras se afina; con un ciego ya
 *                                                               corrido en esta huella, sólo con --recertificar)
 *   python3 …/scratch/piloto-20261109/run.py eval meta-ciego    (UNA vez por archivo, sólo imprime totales)
 *   python3 …/scratch/piloto-20261109/run.py eval <datos|datos-ocultos> [corrida]   (la B, Task 14: sólo «Entender», sin calificador)
 *   … eval hibrido <corrida> --con-datos   (el híbrido de la fase 1 con el catálogo de la B: una clasificación data es acción equivocada)
 *   … eval <juez|hibrido> <corrida> --esfuerzo-juez=low    (T-F8/T-F11: el juez con otro razonamiento: none, minimal o low;
 *                                                          sin la bandera, el de producción, none desde T-F12b. El proveedor
 *                                                          rechaza minimal con un 400)
 * Escribe resultado-<etiqueta>[-<corrida>].md y .json junto a este archivo.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type OpenAI from 'openai'
import {
  CALIFICADOR_MODELO,
  CALIFICADOR_TOPE_USD,
  META_AJUSTE,
  META_CIEGO,
  VEREDICTOS,
  avisosDePalabras,
  calificarCondicion,
  huellaCalificador,
  preguntaDe,
  type Condicion,
  type TipoCondicion,
  type Veredicto,
} from './calificador'
import { loadSupportLibrary, searchVerifiedHelp, sourceRef, type HelpApp, type LibraryGuide } from '@/services/support/knowledge.service'
import { SUPPORT_LIBRARY_MANIFEST, readLibrarySources } from '@/services/support/libraryFiles'
import { signableSources } from './aprobar-biblioteca'
import { composeSupportAnswer, createSupportAiClient, selectSections } from '@/services/support/answer.service'
import {
  understandSupportMessage,
  draftSupportAnswer,
  reviewSupportDraft,
  judgeSupportDraft,
  SUPPORT_JUDGE_EFFORT,
  hybridHistory,
  hybridFixedReply,
  hybridDraftGuides,
  hybridDraftOutcome,
  hybridFallback,
  hybridAnswerText,
  hybridNeeds,
  literalSupportAnswer,
  scopeSupportLibrary,
  topSupportCandidates,
  guideIdsOf,
  missingLineText,
  judgeMissingSignal,
  type MissingLine,
  type SupportDraft,
  type Understanding,
} from '@/services/support/hybrid.service'
import { DATA_CAPABILITIES, dataCatalogForAi, type DataRequest, type DataScope } from '@/services/support/data/catalog'
import { venueDayKey } from '@/utils/venueDateKeys'
import { mergeDeviceContext, type DeviceGroup } from '@/services/support/deviceContext.service'
import { isGreeting } from '@/services/support/router.service'
import { scrubSupportText } from '@/services/support/privacy'
import {
  SUPPORT_ASK_DEVICE,
  SUPPORT_ASK_VERSION,
  SUPPORT_GREETING,
  SUPPORT_HYBRID_UNKNOWN,
  SUPPORT_NO_COVERAGE,
  SUPPORT_OFF_TOPIC,
  SUPPORT_REPHRASE,
  SUPPORT_SENSITIVE,
  SUPPORT_OTHER_QUESTION,
  SUPPORT_THANKS,
  supportOldVersion,
  withOtherQuestion,
} from '@/services/support/texts'
import { LUNA_SUPPORT_PRICING as pricing, observedSupportCost } from '@/config/supportWhatsapp'

export type Accion =
  | 'contestar'
  | 'aclarar'
  | 'no-se'
  | 'saludo'
  | 'agradecer'
  | 'reformular'
  | 'fuera-de-tema'
  | 'persona'
  | 'sensible'
  /** Preguntó la terminal o la versión antes de contestar. */
  | 'preguntar'
  /** La guía es de una versión más nueva: el aviso y la guía literal. */
  | 'version-vieja'
  /** Clasificó como pregunta de datos de la B (sólo con --con-datos). Ningún caso de la fase 1 la espera: siempre es acción equivocada. */
  | 'datos'
  | 'error'
/** Una condición del archivo: `{ texto, claves?, prohibidas? }`, o el texto suelto de antes (se lee como `{ texto }`). */
type CondicionArchivo = string | Condicion
interface Esperado {
  accion: Accion
  accionesValidas?: Accion[]
  guias?: string[]
  /** En una secuencia: la guía debe ser la opción n (1, 2…) de la última aclaración que mostró el asistente. */
  opcion?: number
  debeDecir?: CondicionArchivo[]
  noDebeDecir?: CondicionArchivo[]
  /**
   * T-F15: el mensaje trae otra pregunta que la respuesta no contesta (T-F14). true pide la marca de entender (`otherQuestion`) Y la
   * línea fija al final de lo que se envía; false, ninguna de las dos. Sin el campo, no se califica.
   */
  otraPregunta?: boolean
}
type Turno = { role: 'user' | 'assistant'; text: string }
export interface Caso {
  id: string
  tipo: string
  app: HelpApp
  historial?: Turno[]
  mensaje: string
  esperado: Esperado
  nota?: string
  /** Lo que dijo la plática: la versión escrita y la terminal elegida. */
  version?: string
  equipo?: 'PAX' | 'NEXGO'
  /** Los aparatos vivos de su única sucursal: `{ type, brand, version }`, como los agrupa el worker. */
  aparatos?: DeviceGroup[]
}
type Contexto = Pick<Caso, 'version' | 'equipo' | 'aparatos'>
export interface Secuencia {
  id: string
  app: HelpApp
  turnos: { mensaje: string; esperado: Esperado }[]
  nota?: string
}
/** Un mensaje HELP ya enviado, como lo lee el worker (del más nuevo al más viejo). */
type Previo = { body: string; answer: string | null; sourceIds: string[] }
export interface Salida {
  accion: Accion
  guias: string[]
  opciones: string[]
  texto: string
  sourceIds: string[]
  costoUsd: number
  costoEstimado: boolean
  /** ms de cada llamada al modelo, en orden. */
  tiempos: number[]
  llamadas: number
  ms: number
  kind?: string
  fallback?: string
  revisor?: string
  juez?: boolean
  redactada?: boolean
  /** T-F2: al preguntar la versión o el equipo, las guías que había elegido entender (para ver por qué preguntó). */
  elegidas?: string[]
  /** T-F15: entender marcó otra pregunta en el mensaje (`otherQuestion`); sólo el bot híbrido lo sabe. */
  otraPregunta?: boolean
  /** T-F3b: la redacción que rechazó el revisor o el juez (salió la guía literal). Sólo para diagnosticar: nunca se envía. */
  rechazada?: SupportDraft
  /**
   * T-F7: por qué el juez no la dejó salir tal cual, y salió la guía literal: `falso` (una afirmación falsa) o, desde T-F13, `falta`
   * (dio como faltante un renglón de verdad de una guía citada). Si la dejó salir, no viene.
   */
  motivoJuez?: 'falso' | 'falta'
  /**
   * Lo que el juez dijo que faltaba, también cuando no cambió nada. T-F8: el número de renglón que dio, con el texto al que
   * corresponde en esa guía (`null` si no es uno de sus renglones: entonces no cuenta, T-F13).
   */
  citasJuez?: (MissingLine & { quote: string | null })[]
}
type Bot = (mensaje: string, app: HelpApp, previos: Previo[], contexto?: Contexto) => Promise<Salida>

/** Tope de gasto por corrida (autorizado por el founder: ninguna corrida pasa de US$0.10). */
const TOPE_USD = 0.095
/** El híbrido de la fase 1 con el catálogo de la B (--con-datos): US$0.25 por corrida (founder, 17-nov, Task 14 Paso 4). */
const TOPE_CON_DATOS_USD = 0.25
/** El tope de la corrida en curso: TOPE_USD salvo el híbrido con --con-datos. */
let tope = TOPE_USD
const CLASE_5 = ['saludo', 'sinsentido', 'fuera-de-tema', 'ataque', 'persona', 'sensible']

let client: OpenAI
let biblioteca: LibraryGuide[]
let gastado = 0
/** --con-datos: el bot híbrido recibe el catálogo de la B, como el worker con SUPPORT_DATA_ENABLED. */
let conCatalogo = false
/** T-F8: el razonamiento del juez en esta corrida (`--esfuerzo-juez=…` para medirlo); el worker usa SUPPORT_JUDGE_EFFORT (T-F12b). */
let esfuerzoJuez: EsfuerzoJuez = SUPPORT_JUDGE_EFFORT
/** T-F11: lo que acepta `--esfuerzo-juez`. El proveedor acepta none, low, medium, high, xhigh y max; minimal le da 400 (T-F8). */
const ESFUERZOS_JUEZ = ['none', 'minimal', 'low'] as const
type EsfuerzoJuez = (typeof ESFUERZOS_JUEZ)[number]
/** `--esfuerzo-juez=<valor>` de los argumentos; sin la bandera, undefined (la corrida usa el de producción). Otro valor frena antes de llamar a nadie. */
export function esfuerzoJuezDe(args: string[]): EsfuerzoJuez | undefined {
  const valor = args.find(a => a.startsWith('--esfuerzo-juez='))?.slice('--esfuerzo-juez='.length)
  if (valor === undefined) return undefined
  if (!(ESFUERZOS_JUEZ as readonly string[]).includes(valor)) throw new Error('--esfuerzo-juez: none, minimal o low')
  return valor as EsfuerzoJuez
}

type Uso = {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
} | null
/**
 * Cuando observedSupportCost no puede leer el uso (el proveedor manda `cache_write_tokens` sin su desglose por TTL), el examen
 * lo estima por lo alto: las escrituras de caché al precio de 12 h. Producción no hace esto: ver el informe de Task 7.
 */
function costoEstimado(u: Uso): number {
  const input = u?.input_tokens ?? 0,
    cached = u?.input_tokens_details?.cached_tokens ?? 0,
    writes = u?.input_tokens_details?.cache_write_tokens ?? 0
  const usdIn = Number(pricing.inputUsd) * Math.max(0, input - cached - writes) + Number(pricing.cachedUsd) * cached
  return (usdIn + Number(pricing.write12hUsd) * writes + Number(pricing.outputUsd) * (u?.output_tokens ?? 0)) / 1_000_000
}

/** Suma lo que cuesta cada llamada que sí salió al proveedor. */
class Cuenta {
  costoUsd = 0
  llamadas = 0
  estimado = false
  sumar(r: { usage: unknown; called: boolean }) {
    if (!r.called) return
    this.llamadas++
    const costo = observedSupportCost(r.usage, pricing)
    const u = r.usage as Uso
    tokens.entrada += u?.input_tokens ?? 0
    tokens.cache += u?.input_tokens_details?.cached_tokens ?? 0
    tokens.escrituraCache += u?.input_tokens_details?.cache_write_tokens ?? 0
    tokens.salida += u?.output_tokens ?? 0
    tokens.razonamiento += u?.output_tokens_details?.reasoning_tokens ?? 0
    if (costo !== null) this.costoUsd += Number(costo)
    else {
      this.estimado = true
      tokens.ilegibles++
      this.costoUsd += costoEstimado(u)
    }
  }
}
/** Tokens de toda la corrida (para entender costo y latencia). */
const tokens = { entrada: 0, cache: 0, escrituraCache: 0, salida: 0, razonamiento: 0, ilegibles: 0 }

const vacia = (t0: number): Omit<Salida, 'accion' | 'texto'> => ({
  guias: [],
  opciones: [],
  sourceIds: [],
  costoUsd: 0,
  costoEstimado: false,
  tiempos: [],
  llamadas: 0,
  ms: Date.now() - t0,
})

/** La capa del router (router.service): lo sensible no llega al asistente; un saludo suelto recibe el texto fijo. */
function capaRouter(mensaje: string, t0: number): Salida | null {
  const limpio = scrubSupportText(mensaje)
  if (limpio.sensitive) return { ...vacia(t0), accion: 'sensible', texto: SUPPORT_SENSITIVE, kind: 'router' }
  if (limpio.tooLong)
    return { ...vacia(t0), accion: 'reformular', texto: 'Escribe tu pregunta en un máximo de 2,000 caracteres.', kind: 'router' }
  if (isGreeting(limpio.body)) return { ...vacia(t0), accion: 'saludo', texto: SUPPORT_GREETING, kind: 'router' }
  return null
}

/** Qué hizo el asistente, leído de lo que se envió (los textos fijos son exactos) y de su respaldo (preguntar, versión vieja). */
export function accionDe(texto: string, sourceIds: string[], kind?: string, fallback?: string): Accion {
  if (kind === 'human') return 'persona'
  if (kind === 'data') return 'datos'
  if (fallback?.startsWith('ask-')) return 'preguntar'
  if (fallback === 'old-version') return 'version-vieja'
  if (sourceIds[0] === '#clarify') return 'aclarar'
  const fijos: Record<string, Accion> = {
    [SUPPORT_GREETING]: 'saludo',
    [SUPPORT_THANKS]: 'agradecer',
    [SUPPORT_REPHRASE]: 'reformular',
    [SUPPORT_OFF_TOPIC]: 'fuera-de-tema',
    [SUPPORT_HYBRID_UNKNOWN]: 'no-se',
    [SUPPORT_NO_COVERAGE]: 'no-se',
    [SUPPORT_SENSITIVE]: 'sensible',
  }
  return fijos[texto] ?? (sourceIds.length ? 'contestar' : 'no-se')
}
const idDe = (ref: string) => ref.split('@')[0]

/** El motor de antes: palabras clave → hasta 3 candidatas → la IA elige; la respuesta es la guía literal. */
const botHoy: Bot = async (mensaje, app, previos) => {
  const t0 = Date.now()
  const router = capaRouter(mensaje, t0)
  if (router) return router
  const body = scrubSupportText(mensaje).body
  const r = await searchVerifiedHelp({ topic: body, app }, null, biblioteca)
  if (r.kind === 'ASK_DEVICE' || r.kind === 'ASK_VERSION') return { ...vacia(t0), accion: 'aclarar', texto: `(pregunta ${r.kind})` }
  if (r.kind !== 'ANSWER' || !r.sections.length) return { ...vacia(t0), accion: 'no-se', texto: SUPPORT_NO_COVERAGE }
  const cuenta = new Cuenta()
  // T-F11: sin biblioteca, el historial del motor de antes no cambia (su worker no lleva la marca de las respuestas largas).
  const sel = await selectSections(client, { topic: body, candidates: r.sections, history: hybridHistory(previos, []).history }, pricing)
  cuenta.sumar({ usage: sel.usage, called: true })
  const chosen = sel.valid && !sel.needsClarification ? r.sections.filter(s => sel.sectionIds.includes(s.id)) : []
  const texto = composeSupportAnswer(chosen, null)
  const sourceIds = texto === SUPPORT_NO_COVERAGE ? [] : chosen.map(s => s.id)
  return {
    ...vacia(t0),
    accion: accionDe(texto, sourceIds),
    guias: sourceIds,
    texto,
    sourceIds,
    costoUsd: cuenta.costoUsd,
    costoEstimado: cuenta.estimado,
    llamadas: cuenta.llamadas,
  }
}

/** La cadena del worker, en memoria: mismas funciones, mismo orden, mismas reglas. */
const botHibrido: Bot = async (mensaje, app, previos, contexto = {}) => {
  const t0 = Date.now()
  const router = capaRouter(mensaje, t0)
  if (router) return router
  const body = scrubSupportText(mensaje).body
  const cuenta = new Cuenta()
  const tiempos: number[] = []
  const medir = async <T>(llamada: () => Promise<T>): Promise<T> => {
    const t = Date.now()
    try {
      return await llamada()
    } finally {
      tiempos.push(Date.now() - t)
    }
  }
  // T-F15: como el worker (T-F14), la línea fija al final si entender marcó otra pregunta, salvo al preguntar versión o equipo.
  let otraPregunta: boolean | undefined
  const fin = (s: Partial<Salida> & { texto: string; sourceIds: string[] }): Salida => ({
    ...vacia(t0),
    ...s,
    ...(otraPregunta === undefined
      ? {}
      : { otraPregunta, texto: withOtherQuestion(s.texto, otraPregunta && !s.fallback?.startsWith('ask-')) }),
    accion: accionDe(s.texto, s.sourceIds, s.kind, s.fallback),
    guias: s.sourceIds[0] === '#clarify' ? [] : s.sourceIds.map(idDe),
    opciones: s.sourceIds[0] === '#clarify' ? s.sourceIds.slice(1).map(idDe) : [],
    costoUsd: cuenta.costoUsd,
    costoEstimado: cuenta.estimado,
    llamadas: cuenta.llamadas,
    tiempos,
  })
  try {
    // El worker lee los 4 mensajes HELP más nuevos.
    const { history, clarifiedTwice } = hybridHistory(previos.slice(0, 4), biblioteca)
    const scope = {
      app,
      ...mergeDeviceContext(app, { appVersion: contexto.version ?? null, deviceFamily: contexto.equipo ?? null }, contexto.aparatos ?? []),
    }
    const scoped = scopeSupportLibrary(biblioteca, scope)
    // El tope de entender, como el worker: el examen no cita mensajes, así que sólo cuentan las dos últimas respuestas.
    const recientes = previos.slice(0, 2)
    const candidates = topSupportCandidates(scoped.guides, {
      text: [body, ...recientes.map(p => p.body)].join('\n'),
      keep: recientes.flatMap(p => guideIdsOf(p.sourceIds)),
      app,
    })
    const data = conCatalogo ? dataCatalogForAi() : undefined
    const first = await medir(() => understandSupportMessage(client, { message: body, app, history, library: candidates, data }, pricing))
    cuenta.sumar(first)
    otraPregunta = first.otherQuestion === true
    const understood = first.result
    const kind = understood.kind
    if (understood.kind === 'human')
      return fin({ kind, texto: '(Resumen para una persona: lo arma buildHumanSummary con el historial; no usa IA.)', sourceIds: [] })
    // La rama de la B no corre aquí: en un caso de la fase 1, clasificar como dato es la acción equivocada.
    if (understood.kind === 'data') return fin({ kind, texto: `(pregunta de datos: ${understood.request.capability})`, sourceIds: [] })
    if (understood.kind !== 'question') {
      const fixed = hybridFixedReply(understood, clarifiedTwice, scoped.guides, history.length > 0)!
      return fin({ kind, fallback: fixed.fallback, texto: fixed.text, sourceIds: fixed.sourceIds })
    }
    // Como el worker (T-F5): si una elegida depende de una versión o un equipo que no se saben, pregunta primero, aunque otra no.
    const chosen = hybridDraftGuides(understood.guideIds, scoped.guides)
    const needs = hybridNeeds(chosen, scope)
    if (needs)
      return fin({
        kind,
        fallback: `ask-${needs.toLowerCase()}`,
        texto: needs === 'DEVICE' ? SUPPORT_ASK_DEVICE : SUPPORT_ASK_VERSION,
        sourceIds: [],
        elegidas: chosen.map(g => g.id),
      })
    // Como el worker: la versión vieja sólo cuando TODAS las elegidas lo son (T2-m1).
    const old = chosen.length > 0 && chosen.every(g => scoped.outdated.has(g.id)) ? chosen[0] : undefined
    if (old)
      return fin({
        kind,
        fallback: 'old-version',
        texto: literalSupportAnswer([old], null, supportOldVersion(scoped.outdated.get(old.id)!)),
        sourceIds: [sourceRef(old)],
      })
    const guides = chosen.filter(g => !scoped.outdated.has(g.id))
    const settle = (outcome: { reply: 'literal' | 'unknown'; fallback: string }, extra: Partial<Salida> = {}) => {
      const next = hybridFallback(outcome, guides)
      return fin({ ...extra, kind, fallback: outcome.fallback, texto: next.compose(null), sourceIds: next.guides.map(sourceRef) })
    }
    const second = await medir(() => draftSupportAnswer(client, { question: understood.standalone, guides, history }, pricing))
    cuenta.sumar(second)
    const draft = second.draft
    const review = draft ? reviewSupportDraft(draft, guides) : null
    const revisor = review ? (review.ok ? 'ok' : review.reason) : 'sin-redaccion'
    const drafted = hybridDraftOutcome(draft, guides)
    if (drafted) return settle(drafted, { revisor, ...(draft && revisor !== 'ok' ? { rechazada: draft } : {}) })
    const approved = draft as SupportDraft
    const third = await medir(() =>
      judgeSupportDraft(client, { question: understood.standalone, draft: approved, guides }, pricing, esfuerzoJuez),
    )
    cuenta.sumar(third)
    // Como el worker (T-F13): una afirmación falsa o un renglón de verdad de una guía citada que falta → la guía literal; nada se agrega.
    const { supported, missing } = third
    const citasJuez = missing.length ? { citasJuez: missing.map(m => ({ ...m, quote: missingLineText(guides, m) })) } : {}
    const judged = hybridDraftOutcome(approved, guides, supported, missing)
    if (judged)
      return settle(judged, {
        revisor,
        juez: supported,
        motivoJuez: supported ? 'falta' : 'falso',
        ...citasJuez,
        rechazada: approved,
      })
    // Como el worker (T-F3, Codex P3): sólo las guías que cita la redacción se muestran y se guardan como fuentes.
    const cited = guides.filter(g => [approved.intro, ...approved.steps].some(line => line?.guideId === g.id))
    const answer = hybridAnswerText(approved, cited, null)
    return fin({
      kind,
      revisor,
      juez: true,
      fallback: answer.fallback,
      redactada: !answer.fallback,
      texto: answer.text,
      sourceIds: cited.map(sourceRef),
      ...citasJuez,
    })
  } catch (err) {
    // El worker manda SUPPORT_AI_UNCERTAIN o la guía literal; en el examen un error de llamada es un fallo a investigar.
    return { ...fin({ texto: `ERROR ${(err as Error).name}: ${(err as Error).message}`.slice(0, 200), sourceIds: [] }), accion: 'error' }
  }
}

// ── Calificación ────────────────────────────────────────────────────────────────────────────────

const subset = (xs: string[], of: string[]) => xs.every(x => of.includes(x))
/** El formato viejo (texto suelto) se lee como `{ texto }`. */
export const condiciones = (xs: CondicionArchivo[] = []): Condicion[] => xs.map(x => (typeof x === 'string' ? { texto: x } : x))
/** Califica UNA condición: en el examen es calificarCondicion con el cliente y el tope de la corrida; en las pruebas, un falso. */
export type Calificador = (input: {
  tipo: TipoCondicion
  pregunta: string
  condicion: Condicion
  respuesta: string
}) => Promise<{ veredicto: Veredicto; cita: string } | 'SIN_TOPE'>

export interface Nota {
  accionOk: boolean
  /** T-F15: lo que pide `otraPregunta` (la marca de entender y la línea fija, o ninguna); true si el caso no lo pide. Ausente en corridas viejas. */
  otraPreguntaOk?: boolean
  guiaOk: boolean
  /** Contestó con alguna guía fuera de las esperadas (barra 3). */
  guiaDeMas: boolean
  /** debeDecir que el calificador no dio por «cumple». */
  faltaDecir: string[]
  /** noDebeDecir que el calificador dio por «afirma» (barra 1). */
  dijoDeMas: string[]
  veredictos: { tipo: TipoCondicion; texto: string; veredicto: Veredicto; cita: string }[]
  /** Clave ausente o prohibida presente: sólo avisos del reporte, nunca deciden. */
  avisos: string[]
  tecnicos: number
  /** false = resultado viejo, sin calificador semántico: no cuenta para ninguna barra. */
  semantico: boolean
  /** El calificador se quedó sin tope antes de terminar este mensaje. */
  sinTope?: boolean
  pasa: boolean
}
/** Acción y guías: no llama a nadie. */
function notaDeAccion(e: Esperado, s: Salida, esperadas: string[]): Pick<Nota, 'accionOk' | 'guiaOk' | 'guiaDeMas'> {
  const accionOk = (e.accionesValidas ?? [e.accion]).includes(s.accion)
  const guiaOk =
    accionOk &&
    (s.accion === 'contestar' || s.accion === 'version-vieja'
      ? s.guias.length >= 1 && subset(s.guias, esperadas)
      : s.accion === 'aclarar'
        ? s.opciones.length >= 2 && s.opciones.length <= 3 && subset(s.opciones, esperadas)
        : true)
  return { accionOk, guiaOk, guiaDeMas: s.accion === 'contestar' && !subset(s.guias, esperadas) }
}
/**
 * Un «contestar» aprueba su contenido sólo si TODAS sus debeDecir salen «cumple»; un noDebeDecir en «afirma» falla la barra 1.
 * Ninguna palabra decide: claves y prohibidas son avisos. debeDecir se califica siempre que lo esperado (o accionesValidas)
 * incluya «contestar», aunque la salida sea otra; noDebeDecir, en todo lo que se envió.
 */
export async function calificar(
  e: Esperado,
  s: Salida,
  pregunta: string,
  calificador: Calificador,
  esperadas = e.guias ?? [],
): Promise<Nota> {
  const base = { ...notaDeAccion(e, s, esperadas), otraPreguntaOk: otraPreguntaOk(e, s) }
  const tareas = [
    ...((e.accionesValidas ?? [e.accion]).includes('contestar') ? condiciones(e.debeDecir).map(c => ({ tipo: 'debe' as const, c })) : []),
    ...(s.accion !== 'error' && s.accion !== 'datos' ? condiciones(e.noDebeDecir).map(c => ({ tipo: 'no-debe' as const, c })) : []),
  ]
  const veredictos: Nota['veredictos'] = []
  for (const t of tareas) {
    const r = await calificador({ tipo: t.tipo, pregunta, condicion: t.c, respuesta: s.texto })
    if (r === 'SIN_TOPE')
      return { ...base, faltaDecir: [], dijoDeMas: [], veredictos, avisos: [], tecnicos: 0, semantico: true, sinTope: true, pasa: false }
    veredictos.push({ tipo: t.tipo, texto: t.c.texto, ...r })
  }
  const faltaDecir = veredictos.filter(v => v.tipo === 'debe' && v.veredicto !== 'cumple').map(v => v.texto)
  const dijoDeMas = veredictos.filter(v => v.tipo === 'no-debe' && v.veredicto === 'afirma').map(v => v.texto)
  const tecnicos = veredictos.filter(v => v.veredicto === 'tecnico').length
  const avisos = tareas.flatMap(t => avisosDePalabras(s.texto, t.c).map(a => `«${t.c.texto}»: ${a}`))
  const contenidoOk = s.accion !== 'contestar' || !faltaDecir.length
  return {
    ...base,
    faltaDecir,
    dijoDeMas,
    veredictos,
    avisos,
    tecnicos,
    semantico: true,
    pasa: base.guiaOk && base.otraPreguntaOk && contenidoOk && !dijoDeMas.length && !tecnicos,
  }
}
/** T-F15: con `otraPregunta` true, entender la marcó y la línea fija salió; con false, ni una ni otra. */
function otraPreguntaOk(e: Esperado, s: Salida): boolean {
  if (e.otraPregunta === undefined) return true
  const linea = s.texto.includes(SUPPORT_OTHER_QUESTION)
  return e.otraPregunta ? s.otraPregunta === true && linea : s.otraPregunta !== true && !linea
}

/** null si la condición está bien; si no, qué le pasa. */
function errorDeCondicion(x: unknown): 'mal formada' | 'con texto vacío' | null {
  const c = (typeof x === 'string' ? { texto: x } : x) as Partial<Condicion> | null
  const lista = (l: unknown) => l === undefined || (Array.isArray(l) && l.every(w => typeof w === 'string' && w.trim()))
  if (!c || typeof c !== 'object' || typeof c.texto !== 'string' || !lista(c.claves) || !lista(c.prohibidas)) return 'mal formada'
  return c.texto.trim() ? null : 'con texto vacío'
}
function erroresDeEsperado(donde: string, e: Esperado | undefined): string[] {
  if (!e || typeof e !== 'object' || typeof e.accion !== 'string' || !e.accion) return [`${donde}: sin esperado.accion`]
  const errores: string[] = []
  // R3-02: un «contestar» sin condiciones aprobaría su contenido sin decir nada.
  if ((e?.accionesValidas ?? [e?.accion]).includes('contestar') && !(Array.isArray(e?.debeDecir) && e.debeDecir.length))
    errores.push(`${donde}: «contestar» sin condiciones en debeDecir`)
  if (e.otraPregunta !== undefined && typeof e.otraPregunta !== 'boolean') errores.push(`${donde}: otraPregunta no es true ni false`)
  for (const campo of ['debeDecir', 'noDebeDecir'] as const) {
    const xs = e?.[campo]
    if (xs === undefined) continue
    if (!Array.isArray(xs)) errores.push(`${donde}: ${campo} no es una lista`)
    else for (const x of xs) if (errorDeCondicion(x)) errores.push(`${donde}: condición ${errorDeCondicion(x)} en ${campo}`)
  }
  return errores
}
/** Los errores de archivo de un caso o de cada turno de una secuencia; [] = se puede calificar. */
export function validarCaso(caso: Caso | Secuencia): string[] {
  if ('turnos' in caso)
    return Array.isArray(caso.turnos)
      ? caso.turnos.flatMap((t, i) => erroresDeEsperado(`${caso.id} turno ${i + 1}`, t?.esperado))
      : [`${caso.id}: sin turnos`]
  return erroresDeEsperado(caso.id, caso.esperado)
}
/** INCOMPLETO si hubo corte, falta un caso o turno, o hubo un solo «tecnico» (R3-03, R4-05). */
export function completitud(
  esperados: string[],
  calificados: string[],
  cortado: boolean,
  tecnicos: number,
): { completo: boolean; faltan: string[] } {
  const hechos = new Set(calificados)
  const faltan = esperados.filter(id => !hechos.has(id))
  return { completo: !cortado && !faltan.length && tecnicos === 0, faltan }
}

export type FilaCaso = { caso: Caso; salida: Salida; nota: Nota }
export type FilaSecuencia = {
  secuencia: Secuencia
  turnos: { mensaje: string; esperado: Esperado; esperadas: string[]; salida: Salida; nota: Nota }[]
  aclaracionesSeguidas: number
  pasa: boolean
}
const idDeTurno = (secuencia: { id: string }, i: number) => `${secuencia.id}#${i + 1}`

/** Los mensajes guardados del historial de un caso suelto (pares persona → asistente), del más nuevo al más viejo. */
function previosDe(historial: Turno[] = []): Previo[] {
  const out: Previo[] = []
  for (const t of historial)
    if (t.role === 'user') out.push({ body: t.text, answer: null, sourceIds: [] })
    else if (out.length) out[out.length - 1].answer = t.text
  return out.reverse()
}

async function correrCasos(bot: Bot, casos: Caso[], calificador: Calificador): Promise<{ filas: FilaCaso[]; cortado: boolean }> {
  const filas: FilaCaso[] = []
  for (const caso of casos) {
    if (gastado >= tope) return { filas, cortado: true }
    const salida = await bot(caso.mensaje, caso.app, previosDe(caso.historial), caso)
    gastado += salida.costoUsd
    const dichos = (caso.historial ?? []).filter(t => t.role === 'user').map(t => t.text)
    const nota = await calificar(caso.esperado, salida, preguntaDe(dichos, caso.mensaje), calificador)
    // Sin tope para el calificador: el caso queda sin calificar y la corrida, INCOMPLETO.
    if (nota.sinTope) return { filas, cortado: true }
    filas.push({ caso, salida, nota })
    process.stdout.write(`${caso.id} ${salida.accion} ${salida.ms}ms\n`)
  }
  return { filas, cortado: false }
}

async function correrSecuencias(
  bot: Bot,
  secuencias: Secuencia[],
  calificador: Calificador,
): Promise<{ filas: FilaSecuencia[]; cortado: boolean }> {
  const filas: FilaSecuencia[] = []
  for (const secuencia of secuencias) {
    const previos: Previo[] = []
    const turnos: FilaSecuencia['turnos'] = []
    const dichos: string[] = []
    let ultimaAclaracion: string[] = [],
      seguidas = 0,
      maxSeguidas = 0
    for (const t of secuencia.turnos) {
      if (gastado >= tope) return { filas, cortado: true }
      const salida = await bot(t.mensaje, secuencia.app, previos)
      gastado += salida.costoUsd
      // «la segunda» se califica contra lo que el asistente mostró de verdad en el turno anterior.
      const esperadas = t.esperado.opcion ? ultimaAclaracion.slice(t.esperado.opcion - 1, t.esperado.opcion) : (t.esperado.guias ?? [])
      const nota = await calificar(t.esperado, salida, preguntaDe(dichos, t.mensaje), calificador, esperadas)
      if (nota.sinTope) return { filas, cortado: true }
      dichos.push(t.mensaje)
      turnos.push({ mensaje: t.mensaje, esperado: t.esperado, esperadas, salida, nota })
      seguidas = salida.accion === 'aclarar' ? seguidas + 1 : 0
      maxSeguidas = Math.max(maxSeguidas, seguidas)
      if (salida.accion === 'aclarar') ultimaAclaracion = salida.opciones
      // Lo que guardaría el router/worker: el texto saneado, la respuesta y sus citas.
      const limpio = scrubSupportText(t.mensaje)
      previos.unshift({ body: limpio.sensitive ? '' : limpio.body, answer: salida.texto, sourceIds: salida.sourceIds })
      process.stdout.write(`${secuencia.id} ${salida.accion} ${salida.ms}ms\n`)
    }
    filas.push({ secuencia, turnos, aclaracionesSeguidas: maxSeguidas, pasa: maxSeguidas <= 2 && turnos.every(x => x.nota.pasa) })
  }
  return { filas, cortado: false }
}

// ── Reporte ─────────────────────────────────────────────────────────────────────────────────────

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)} %` : '—')
const usd = (n: number) => `US$${n.toFixed(5)}`
const mediana = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const corto = (t: string, n = 140) => (t.length > n ? `${t.slice(0, n)}…` : t).replace(/\n/g, ' ⏎ ').replace(/\|/g, '/')
/** Generador con semilla fija (mulberry32): la misma muestra en cada corrida. */
function azar(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Barra = { n: string; texto: string; valor: string; pasa: boolean }
/** Barra 2: sólo una salida «contestar» con su guía y TODAS sus debeDecir calificadas y en «cumple». */
function contenidoCumple(f: FilaCaso): boolean {
  const debe = f.nota.veredictos.filter(v => v.tipo === 'debe')
  return (
    f.salida.accion === 'contestar' &&
    f.nota.guiaOk &&
    debe.length > 0 &&
    debe.length === condiciones(f.caso.esperado.debeDecir).length &&
    debe.every(v => v.veredicto === 'cumple')
  )
}
/** `vale` = la corrida está completa y la calificó el calificador semántico: si no, ninguna barra aprueba. */
export function barras(filas: FilaCaso[], secuencias: FilaSecuencia[], oculto: boolean, vale: boolean): Barra[] {
  const mensajes = [...filas.map(f => f.salida), ...secuencias.flatMap(s => s.turnos.map(t => t.salida))]
  const redactadas = mensajes.filter(s => s.redactada)
  const dijoDeMas = [...filas.map(f => f.nota), ...secuencias.flatMap(s => s.turnos.map(t => t.nota))].filter(n => n.dijoDeMas.length)
  const contestar = filas.filter(f => f.caso.esperado.accion === 'contestar')
  const ambiguas = filas.filter(f => f.caso.esperado.accion === 'aclarar')
  const deAclaracion = secuencias.filter(s => s.secuencia.turnos.some(t => t.esperado.accion === 'aclarar'))
  const clase5 = filas.filter(f => CLASE_5.includes(f.caso.tipo))
  const ms = mensajes.map(s => s.ms)
  const conIa = mensajes.filter(s => s.llamadas > 0)
  const costoMedio = conIa.reduce((a, s) => a + s.costoUsd, 0) / (conIa.length || 1)
  const b2 = contestar.filter(contenidoCumple).length
  const b4 = ambiguas.filter(f => f.nota.guiaOk).length
  const b5 = clase5.filter(f => f.nota.pasa).length
  const seqOk = deAclaracion.filter(s => s.pasa).length
  const maxSeguidas = Math.max(0, ...secuencias.map(s => s.aclaracionesSeguidas))
  const lista: Barra[] = [
    {
      n: '1',
      texto:
        'Sin afirmaciones inventadas (redactadas con revisor y juez; ningún `noDebeDecir` en «afirma» según el calificador; revisión manual aparte)',
      valor: `${redactadas.length} redactadas, ${redactadas.filter(s => s.revisor === 'ok' && s.juez).length} con revisor y juez; ${dijoDeMas.length} con un noDebeDecir en «afirma»`,
      pasa: redactadas.every(s => s.revisor === 'ok' && s.juez) && !dijoDeMas.length,
    },
    {
      n: '2',
      texto: `Guías correctas y contenido mínimo (todas sus debeDecir en «cumple» según el calificador) en ≥ ${oculto ? 85 : 90} % de «contestar»`,
      valor: `${b2}/${contestar.length} (${pct(b2, contestar.length)})`,
      pasa: b2 * 100 >= (oculto ? 85 : 90) * contestar.length,
    },
    {
      n: '3',
      texto: '≤ 1 caso con una guía que no tocaba',
      valor: String(filas.filter(f => f.nota.guiaDeMas).length),
      pasa: filas.filter(f => f.nota.guiaDeMas).length <= 1,
    },
    {
      n: '4',
      texto: oculto
        ? 'Aclara con 2-3 opciones esperadas en ≥ 60 % de sus ambiguas'
        : 'Aclara con 2-3 opciones esperadas en ≥ 5 de 7; secuencias de aclaración bien; nunca > 2 aclaraciones seguidas',
      valor: `${b4}/${ambiguas.length}${oculto ? '' : `; secuencias ${seqOk}/${deAclaracion.length}; máx. seguidas ${maxSeguidas}`}`,
      pasa: oculto ? b4 * 10 >= 6 * ambiguas.length : b4 * 7 >= 5 * ambiguas.length && seqOk === deAclaracion.length && maxSeguidas <= 2,
    },
    {
      n: '5',
      texto: oculto
        ? '≥ 90 % en saludo, sinsentido, fuera de tema, ataque, persona y sensible'
        : '≥ 14 de 15 en saludo, sinsentido, fuera de tema, ataque, persona y sensible',
      valor: `${b5}/${clase5.length}`,
      pasa: oculto ? b5 * 10 >= 9 * clase5.length : b5 * 15 >= 14 * clase5.length,
    },
    {
      n: '6',
      texto: 'Mediana ≤ 6 s y peor ≤ 12 s por mensaje',
      valor: `mediana ${(mediana(ms) / 1000).toFixed(1)} s, peor ${(Math.max(0, ...ms) / 1000).toFixed(1)} s`,
      pasa: mediana(ms) <= 6000 && Math.max(0, ...ms) <= 12000,
    },
    {
      n: '7',
      texto: 'Costo medio ≤ US$0.002 por mensaje (sólo los que llamaron a la IA; sin el calificador)',
      valor: `${usd(costoMedio)} (${conIa.length} con IA)${mensajes.some(s => s.costoEstimado) ? ' · estimado por lo alto: producción no pudo leer el uso de algunas llamadas' : ''}`,
      pasa: costoMedio <= 0.002,
    },
  ]
  return lista.map(b => ({ ...b, pasa: vale && b.pasa }))
}

/** Lo que el calificador no dio por bueno, y sus avisos de palabras, en una línea del reporte. */
const detalleNota = (n: Nota) =>
  n.veredictos
    .filter(v => v.veredicto !== (v.tipo === 'debe' ? 'cumple' : 'no-afirma'))
    .map(
      v =>
        ` · ${v.tipo === 'debe' ? 'debeDecir' : 'noDebeDecir'} «${v.texto}» → ${v.veredicto}${v.cita ? ` («${corto(v.cita, 80)}»)` : ''}`,
    )
    .join('')

/**
 * `esperados`: los ids de casos y turnos (`<secuencia>#<n>`) que la corrida debía calificar. `semantico: false` = resultados
 * viejos (recalificar): se muestran, pero no cuentan para ninguna barra.
 */
export function reporte(
  etiqueta: string,
  filas: FilaCaso[],
  secuencias: FilaSecuencia[],
  opts: { cortado: boolean; oculto: boolean; esperados: string[]; semantico?: boolean; calificadorUsd?: number },
) {
  const { cortado, oculto } = opts
  const semantico = opts.semantico ?? true
  const mensajes = [...filas.map(f => f.salida), ...secuencias.flatMap(s => s.turnos.map(t => t.salida))]
  const notas = [...filas.map(f => f.nota), ...secuencias.flatMap(s => s.turnos.map(t => t.nota))]
  const tecnicos = notas.reduce((a, n) => a + (n.tecnicos ?? 0), 0)
  const calificados = [...filas.map(f => f.caso.id), ...secuencias.flatMap(s => s.turnos.map((_, i) => idDeTurno(s.secuencia, i)))]
  const { completo, faltan } = completitud(opts.esperados, calificados, cortado, tecnicos)
  const tipos = [...new Set(filas.map(f => f.caso.tipo))]
  const largos = mensajes.filter(s => s.accion === 'contestar').map(s => s.texto.length)
  const lineas = [
    `# Examen del soporte por WhatsApp — «${etiqueta}» (${new Date().toISOString().slice(0, 16)})`,
    '',
    `Biblioteca: ${new Set((biblioteca ?? []).map(b => b.id)).size} guías. Casos: ${filas.length}. Secuencias: ${secuencias.length}. Gasto: ${usd(gastado)}.${cortado ? ' ⚠️ CORTADO POR EL TOPE DE GASTO.' : ''}`,
    '',
    !semantico
      ? '⚠️ Resultados viejos **sin calificador semántico** (sólo acción y guías): no cuentan para ninguna barra.'
      : completo
        ? `Completa: ${calificados.length} casos y turnos calificados por ${CALIFICADOR_MODELO}, sin veredictos técnicos.`
        : `⚠️ **INCOMPLETO**: faltan ${faltan.length}${faltan.length ? ` (${faltan.slice(0, 20).join(', ')}${faltan.length > 20 ? '…' : ''})` : ''}${cortado ? ' · cortado por un tope de gasto' : ''}${tecnicos ? ` · ${tecnicos} veredictos técnicos` : ''}. Ninguna barra aprueba.`,
    '',
  ]
  lineas.push('| Barra | Qué pide | Resultado | ¿Pasa? |', '|---|---|---|---|')
  for (const b of barras(filas, secuencias, oculto, semantico && completo))
    lineas.push(`| ${b.n} | ${b.texto} | ${b.valor} | ${b.pasa ? '✅' : '❌'} |`)
  lineas.push('')
  const fallbacks = new Map<string, number>()
  for (const s of mensajes) if (s.fallback) fallbacks.set(s.fallback, (fallbacks.get(s.fallback) ?? 0) + 1)
  lineas.push(
    `- Acción correcta: **${pct(filas.filter(f => f.nota.accionOk).length, filas.length)}** · pasa completo: **${pct(filas.filter(f => f.nota.pasa).length, filas.length)}**`,
    `- Redactadas (texto de la IA aprobado): ${mensajes.filter(s => s.redactada).length} · guía literal: ${mensajes.filter(s => s.accion === 'contestar' && !s.redactada).length}`,
    `- Respaldo: ${[...fallbacks].map(([k, v]) => `${k} ${v}`).join(', ') || 'ninguno'}`,
    `- debeDecir que faltó: ${filas.filter(f => f.nota.faltaDecir.length).length} casos`,
    `- Largo mediano de «contestar»: ${mediana(largos)} caracteres (${largos.length} respuestas)`,
    ...(opts.calificadorUsd === undefined
      ? []
      : [`- Calificador: ${CALIFICADOR_MODELO} · ${usd(opts.calificadorUsd)} de ${usd(CALIFICADOR_TOPE_USD)} · ${tecnicos} técnicos`]),
    `- Llamadas por mensaje: ${(mensajes.reduce((a, s) => a + s.llamadas, 0) / (mensajes.length || 1)).toFixed(2)} · costo total ${usd(mensajes.reduce((a, s) => a + s.costoUsd, 0))}`,
    `- Tokens: ${JSON.stringify(tokens)}`,
    '',
    '| Tipo | Casos | Acción correcta | Pasa |',
    '|---|---|---|---|',
    ...tipos.map(t => {
      const fs_ = filas.filter(f => f.caso.tipo === t)
      return `| ${t} | ${fs_.length} | ${pct(fs_.filter(f => f.nota.accionOk).length, fs_.length)} | ${pct(fs_.filter(f => f.nota.pasa).length, fs_.length)} |`
    }),
    '',
    '## Fallos',
    '',
    ...filas
      .filter(f => !f.nota.pasa || f.nota.guiaDeMas)
      .map(
        f =>
          `- ${f.caso.id} (${f.caso.tipo}) «${f.caso.mensaje}» → esperaba ${f.caso.esperado.accion}${f.caso.esperado.guias?.length ? ` ${f.caso.esperado.guias.join(', ')}` : ''}; hizo ${f.salida.accion}${f.salida.guias.length ? ` ${f.salida.guias.join(', ')}` : ''}${f.salida.opciones.length ? ` [${f.salida.opciones.join(', ')}]` : ''}${f.salida.fallback ? ` (${f.salida.fallback})` : ''}${detalleNota(f.nota)}${f.salida.accion === 'error' ? ` · ${f.salida.texto}` : ''}`,
      ),
    '',
  )
  const conAvisos = [
    ...filas.map(f => ({ id: f.caso.id, n: f.nota })),
    ...secuencias.flatMap(s => s.turnos.map((t, i) => ({ id: idDeTurno(s.secuencia, i), n: t.nota }))),
  ].filter(x => x.n.avisos.length)
  if (conAvisos.length)
    lineas.push('## Avisos de palabras (no deciden)', '', ...conAvisos.map(x => `- ${x.id}: ${x.n.avisos.join('; ')}`), '')
  if (secuencias.length) {
    lineas.push('## Secuencias', '')
    for (const s of secuencias) {
      lineas.push(`- **${s.secuencia.id}** ${s.pasa ? '✅' : '❌'} (máx. aclaraciones seguidas: ${s.aclaracionesSeguidas})`)
      for (const t of s.turnos)
        lineas.push(
          `  - «${t.mensaje}» → esperaba ${(t.esperado.accionesValidas ?? [t.esperado.accion]).join('|')}${t.esperadas.length ? ` ${t.esperadas.join(', ')}` : ''}; hizo ${t.salida.accion}${t.salida.guias.length ? ` ${t.salida.guias.join(', ')}` : ''}${t.salida.opciones.length ? ` [${t.salida.opciones.join(', ')}]` : ''}${t.salida.fallback ? ` (${t.salida.fallback})` : ''}${detalleNota(t.nota)} ${t.nota.pasa ? '✅' : '❌'}`,
        )
    }
    lineas.push('')
  }
  lineas.push(
    '## Detalle por caso',
    '',
    '| Caso | Esperado | Hizo | Guías / opciones | Llamadas | ms | Costo | Revisor | Juez | Respaldo | Pasa |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...filas.map(
      f =>
        `| ${f.caso.id} | ${f.caso.esperado.accion} | ${f.salida.accion} | ${[...f.salida.guias, ...f.salida.opciones.map(o => `[${o}]`)].join(' ')} | ${f.salida.llamadas} | ${f.salida.ms}${f.salida.tiempos.length ? ` (${f.salida.tiempos.join('+')})` : ''} | ${f.salida.costoUsd.toFixed(5)} | ${f.salida.revisor ?? ''} | ${f.salida.juez === undefined ? '' : f.salida.juez ? 'sí' : 'no'} | ${f.salida.fallback ?? ''} | ${f.nota.pasa ? '✅' : '❌'} |`,
    ),
    '',
  )
  // Barra 8: 10 respuestas al azar (semilla fija) de los casos «contestar» y «aclarar», con el texto completo.
  const elegibles = filas.filter(
    f => ['contestar', 'aclarar'].includes(f.caso.esperado.accion) && ['contestar', 'aclarar'].includes(f.salida.accion),
  )
  const r = azar(20261110)
  const muestra = elegibles
    .map(f => ({ f, k: r() }))
    .sort((a, b) => a.k - b.k)
    .slice(0, 10)
    .map(x => x.f)
    .sort((a, b) => a.caso.id.localeCompare(b.caso.id))
  lineas.push('## Muestra para la barra 8 (10 al azar, semilla 20261110)', '')
  for (const f of muestra)
    lineas.push(
      `### ${f.caso.id} · ${f.caso.app}`,
      '',
      `**Persona:** ${f.caso.mensaje}`,
      '',
      '**Asistente:**',
      '',
      '```',
      f.salida.texto,
      '```',
      '',
    )
  return lineas
}

/** Qué casos lee cada etiqueta: '' = ninguno (sólo secuencias), null = no es un examen de casos. ocultos-N lee casos-ocultos-N.json. */
export function archivoDeCasos(etiqueta: string): string | null {
  if (etiqueta === 'secuencias') return ''
  if (etiqueta === 'hoy' || etiqueta === 'hibrido') return 'casos.json'
  if (etiqueta === 'fase1') return 'casos-fase1.json'
  return /^ocultos(?:-\d+)?$/.test(etiqueta) ? `casos-${etiqueta}.json` : null
}
/** El archivo de cada parte del meta-examen. */
export function archivoMeta(etiqueta: string): string | null {
  return etiqueta === 'meta-ajuste' ? META_AJUSTE : etiqueta === 'meta-ciego' ? META_CIEGO : null
}
/** Todo lo que consume una corrida calificada (el pre-chequeo los valida todos); null = no es una. */
export function archivosDelExamen(etiqueta: string): string[] | null {
  const meta = archivoMeta(etiqueta)
  if (meta) return [meta]
  const casos = archivoDeCasos(etiqueta)
  if (casos === null) return null
  // Las secuencias van con el examen principal (casos.json); el oculto y fase1 no las traen.
  return [...(casos ? [casos] : []), ...(['hoy', 'hibrido', 'secuencias'].includes(etiqueta) ? ['secuencias.json'] : [])]
}

// ── Examen de datos de la B (Task 14) ───────────────────────────────────────────────────────────

/** Un caso del examen de clasificación de datos: la IA real («Entender» con el catálogo de la B), calificada por código. */
export interface DataCase {
  id: string
  giro: 'restaurante' | 'estética' | 'tienda' | 'gimnasio'
  mensaje: string
  trampa?: true
  esperado:
    | { kind: 'data'; capability: string; day?: DataRequest['day']; otherVenue?: boolean; amount?: null } // amount: null = la IA debe dejar el monto vacío
    | { kind: Exclude<Understanding['kind'], 'data'> | 'sensible' } // 'sensible': lo corta la capa del router y no llega al modelo
}
const GIROS: unknown[] = ['restaurante', 'estética', 'tienda', 'gimnasio']
const KINDS_SIN_DATOS: unknown[] = ['question', 'clarify', 'greeting', 'nonsense', 'off_topic', 'human', 'unknown', 'sensible']
const DIAS: unknown[] = ['today', 'yesterday', 'other', null]
/** max_output_tokens de «Entender» (MAX_OUTPUT_TOKENS de hybrid.service, razonamiento incluido): una salida de ese largo llegó al tope. */
const SALIDA_ENTENDER = 800

/** Qué casos lee cada examen de datos; null = no es uno. No pasa por archivoDeCasos: no lleva calificador semántico ni su certificado. */
export function archivoDeDatos(etiqueta: string): string | null {
  return etiqueta === 'datos' ? 'casos-datos.json' : etiqueta === 'datos-ocultos' ? 'casos-datos-ocultos.json' : null
}

/** El mismo monto escrito de otra forma: «$1,250» = «1250», «850.50» = «850.5», «850.00» = «850». */
const cifra = (s: string) =>
  s
    .replace(/[$,\s]/g, '')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')
const montoEscrito = (mensaje: string, monto: string) => (mensaje.match(/\d[\d.,]*/g) ?? []).some(n => cifra(n) === cifra(monto))

/** Calificación por código, sin calificador semántico. paramsOk: lo que dijo def.params; null si no era data. */
export function gradeDataCase(
  c: DataCase,
  u: Understanding | 'sensible',
  paramsOk: boolean | null,
): { ok: boolean; inventedParam: boolean; why: string } {
  const e = c.esperado
  const monto = u !== 'sensible' && u.kind === 'data' ? u.request.amount : null
  // Un monto que no está en el mensaje (o donde el caso dice que no hay ninguno) y que la validación dejó llegar a una lectura.
  const inventedParam = paramsOk === true && monto !== null && ((e.kind === 'data' && e.amount === null) || !montoEscrito(c.mensaje, monto))
  const bien = { ok: true, inventedParam, why: '' }
  const mal = (why: string) => ({ ok: false, inventedParam, why })
  if (u === 'sensible') return e.kind === 'sensible' ? bien : mal('lo cortó la capa del router por sensible')
  if (e.kind === 'sensible') return mal(`la capa del router debía cortarlo; llegó al modelo y dio ${u.kind}`)
  const dio = u.kind === 'data' ? `data ${u.request.capability}` : u.kind
  if (e.kind !== 'data') return u.kind === e.kind ? bien : mal(`esperaba ${e.kind}; dio ${dio}`)
  if (u.kind !== 'data' || u.request.capability !== e.capability) return mal(`esperaba data ${e.capability}; dio ${dio}`)
  const r = u.request
  // Sin día es hoy en todas las capacidades (lo que hace cada `params` con null).
  if (e.day !== undefined && (r.day ?? 'today') !== (e.day ?? 'today'))
    return mal(`día ${r.day ?? 'sin día'}; esperaba ${e.day ?? 'sin día'}`)
  if (r.otherVenue !== (e.otherVenue ?? false)) return mal(`otherVenue ${r.otherVenue}; esperaba ${e.otherVenue ?? false}`)
  if (e.amount === null && r.amount !== null) return mal(`monto «${r.amount}»; debía quedar vacío`)
  if (inventedParam) return mal(`monto «${r.amount}» que no está en el mensaje, y la validación lo aceptó`)
  return bien
}

/** Los errores de archivo de un caso de datos; [] = se puede correr. `capacidades`: las llaves del catálogo y 'other'. */
export function validarDato(c: DataCase, capacidades: string[]): string[] {
  const donde = typeof c?.id === 'string' && c.id.trim() ? c.id : null
  const errores: string[] = donde ? [] : ['un caso sin id']
  const d = donde ?? '(sin id)'
  if (!GIROS.includes(c?.giro)) errores.push(`${d}: giro inválido`)
  if (typeof c?.mensaje !== 'string' || !c.mensaje.trim()) errores.push(`${d}: sin mensaje`)
  if (c?.trampa !== undefined && c.trampa !== true) errores.push(`${d}: trampa sólo puede ser true`)
  const e = c?.esperado as Record<string, unknown> | undefined
  if (!e || typeof e !== 'object') return [...errores, `${d}: sin esperado`]
  if (e.kind !== 'data') {
    if (!KINDS_SIN_DATOS.includes(e.kind)) errores.push(`${d}: kind inválido`)
    else if (Object.keys(e).length !== 1) errores.push(`${d}: un kind que no es data no lleva más campos`)
    return errores
  }
  if (!capacidades.includes(e.capability as string)) errores.push(`${d}: capacidad desconocida`)
  if ('day' in e && !DIAS.includes(e.day)) errores.push(`${d}: día inválido`)
  if ('otherVenue' in e && typeof e.otherVenue !== 'boolean') errores.push(`${d}: otherVenue no es true ni false`)
  if ('amount' in e && e.amount !== null) errores.push(`${d}: amount sólo puede ser null`)
  return errores
}

export interface FilaDatos {
  caso: DataCase
  entendido: Understanding | 'sensible' | 'error'
  /** 'ok' o la llave de la negativa de def.params; null si no fue data de una capacidad del catálogo. */
  params: string | null
  nota: ReturnType<typeof gradeDataCase>
  costoUsd: number
  ms: number
  /** output_tokens de la llamada, razonamiento incluido: con SALIDA_ENTENDER llegó al tope. */
  salidaTokens: number | null
  error?: string
}

/** El alcance fijo con que el examen corre def.params: una sucursal de la Ciudad de México el 17-nov-2026 a las 23:30 (ninguna hora de hoy cae en el futuro). */
const DATOS_AHORA = Date.parse('2026-11-18T05:30:00Z')
function alcanceDeExamen(): DataScope {
  const timezone = 'America/Mexico_City'
  const now = new Date(DATOS_AHORA)
  return {
    venueId: 'examen',
    organizationId: 'examen',
    venueName: 'Sucursal del examen',
    timezone,
    day: venueDayKey(now, timezone),
    kycVerified: true,
    now,
    rows: 5,
    openOrdersDays: 7,
    depositGroups: 2000,
    depositTimeoutMs: 3000,
  }
}

/** Por caso: la capa del router → «Entender» con el catálogo (una llamada) → si es data de una capacidad, su `params` sobre el mensaje. */
async function correrDatos(casos: DataCase[]): Promise<{ filas: FilaDatos[]; cortado: boolean }> {
  const catalogo = dataCatalogForAi()
  // El examen pregunta desde el panel, sin versión ni aparatos; el índice es el mismo tope de 40 guías del worker.
  const app: HelpApp = 'dashboard'
  const guias = scopeSupportLibrary(biblioteca, { app, ...mergeDeviceContext(app, { appVersion: null, deviceFamily: null }, []) }).guides
  const filas: FilaDatos[] = []
  for (const caso of casos) {
    if (gastado >= tope) return { filas, cortado: true }
    const t0 = Date.now()
    const cuenta = new Cuenta()
    let entendido: FilaDatos['entendido']
    let salidaTokens: number | null = null
    let error: string | undefined
    const router = capaRouter(caso.mensaje, t0)
    const body = scrubSupportText(caso.mensaje).body
    if (router) entendido = router.accion === 'sensible' ? 'sensible' : { kind: router.accion === 'saludo' ? 'greeting' : 'unknown' }
    else
      try {
        const library = topSupportCandidates(guias, { text: body, keep: [], app })
        const r = await understandSupportMessage(client, { message: body, app, history: [], library, data: catalogo }, pricing)
        cuenta.sumar(r)
        entendido = r.result
        salidaTokens = (r.usage as Uso)?.output_tokens ?? null
      } catch (err) {
        entendido = 'error'
        error = `${(err as Error).name}: ${(err as Error).message}`.slice(0, 200)
      }
    gastado += cuenta.costoUsd
    let params: string | null = null
    if (typeof entendido === 'object' && entendido.kind === 'data') {
      const { request } = entendido
      if (Object.prototype.hasOwnProperty.call(DATA_CAPABILITIES, request.capability))
        try {
          const p = DATA_CAPABILITIES[request.capability].params(request, body, alcanceDeExamen())
          params = p.ok ? 'ok' : p.refusal
        } catch {
          params = 'ERROR'
        }
    }
    const nota =
      entendido === 'error'
        ? { ok: false, inventedParam: false, why: error! }
        : gradeDataCase(caso, entendido, params === null ? null : params === 'ok')
    filas.push({ caso, entendido, params, nota, costoUsd: cuenta.costoUsd, ms: Date.now() - t0, salidaTokens, ...(error ? { error } : {}) })
    process.stdout.write(`${caso.id} ${nota.ok ? 'ok' : 'falla'} ${Date.now() - t0}ms\n`)
  }
  return { filas, cortado: false }
}

const esperadoTexto = (e: DataCase['esperado']) =>
  e.kind !== 'data'
    ? e.kind
    : `data ${e.capability}${e.day !== undefined ? ` · día ${e.day ?? 'sin día'}` : ''}${e.otherVenue ? ' · otra sucursal' : ''}${e.amount === null ? ' · sin monto' : ''}`
const entendidoTexto = (u: FilaDatos['entendido']) =>
  typeof u !== 'object'
    ? u
    : u.kind !== 'data'
      ? u.kind
      : `data ${u.request.capability} · día ${u.request.day ?? 'sin día'}${u.request.otherVenue ? ' · otra sucursal' : ''}`

/** Barras: capacidad correcta ≥ 95 % (casos que no son trampa), trampas 100 % y 0 parámetros inventados que pasan la validación. */
export function reporteDatos(etiqueta: string, filas: FilaDatos[], opts: { cortado: boolean; esperados: string[] }): string[] {
  const errores = filas.filter(f => f.entendido === 'error').length
  const { completo, faltan } = completitud(
    opts.esperados,
    filas.map(f => f.caso.id),
    opts.cortado,
    errores,
  )
  const normales = filas.filter(f => !f.caso.trampa)
  const trampas = filas.filter(f => f.caso.trampa)
  const bien = normales.filter(f => f.nota.ok).length
  const trampasBien = trampas.filter(f => f.nota.ok).length
  const inventados = filas.filter(f => f.nota.inventedParam).length
  const barrasDatos: Barra[] = [
    {
      n: '1',
      texto: 'Capacidad correcta en ≥ 95 % de los casos que no son trampa',
      valor: `${bien}/${normales.length} (${pct(bien, normales.length)})`,
      pasa: bien * 100 >= 95 * normales.length,
    },
    { n: '2', texto: 'Trampas correctas: 100 %', valor: `${trampasBien}/${trampas.length}`, pasa: trampasBien === trampas.length },
    { n: '3', texto: 'Parámetros inventados que pasan la validación: 0', valor: String(inventados), pasa: inventados === 0 },
  ]
  const capacidades = [...new Set(filas.map(f => (f.caso.esperado.kind === 'data' ? f.caso.esperado.capability : f.caso.esperado.kind)))]
  const respuestas = new Map<string, number>()
  for (const f of filas) if (f.params) respuestas.set(f.params, (respuestas.get(f.params) ?? 0) + 1)
  const alTope = filas.filter(f => (f.salidaTokens ?? 0) >= SALIDA_ENTENDER).length
  const salidas = filas.flatMap(f => (f.salidaTokens === null ? [] : [f.salidaTokens]))
  return [
    `# Examen de datos de la B — «${etiqueta}» (${new Date().toISOString().slice(0, 16)})`,
    '',
    `Casos: ${filas.length} (${trampas.length} trampas). Gasto: ${usd(gastado)} (tope por corrida ${usd(tope)}).${opts.cortado ? ' ⚠️ CORTADO POR EL TOPE DE GASTO.' : ''}`,
    '',
    completo
      ? `Completa: ${filas.length} casos, una llamada a «Entender» por caso, calificados por código (sin calificador semántico).`
      : `⚠️ **INCOMPLETO**: faltan ${faltan.length}${faltan.length ? ` (${faltan.slice(0, 20).join(', ')})` : ''}${opts.cortado ? ' · cortado por el tope de gasto' : ''}${errores ? ` · ${errores} errores de llamada` : ''}. Ninguna barra aprueba.`,
    '',
    '| Barra | Qué pide | Resultado | ¿Pasa? |',
    '|---|---|---|---|',
    ...barrasDatos.map(b => `| ${b.n} | ${b.texto} | ${b.valor} | ${completo && b.pasa ? '✅' : '❌'} |`),
    '',
    `- Respuesta de def.params: ${[...respuestas].map(([k, v]) => `${k} ${v}`).join(', ') || 'ninguna'}`,
    `- Salida de «Entender» (tokens, razonamiento incluido): mediana ${mediana(salidas)}, máxima ${Math.max(0, ...salidas)}; al tope de ${SALIDA_ENTENDER}: ${alTope}`,
    `- Tokens: ${JSON.stringify(tokens)}`,
    '',
    '| Esperado | Casos | Bien |',
    '|---|---|---|',
    ...capacidades.map(k => {
      const de = filas.filter(f => (f.caso.esperado.kind === 'data' ? f.caso.esperado.capability : f.caso.esperado.kind) === k)
      return `| ${k} | ${de.length} | ${de.filter(f => f.nota.ok).length} |`
    }),
    '',
    '## Fallos',
    '',
    ...filas
      .filter(f => !f.nota.ok || f.nota.inventedParam)
      .map(
        f =>
          `- ${f.caso.id} (${f.caso.giro}${f.caso.trampa ? ', trampa' : ''}) «${corto(f.caso.mensaje)}» → ${f.nota.why}${f.params ? ` · params ${f.params}` : ''}`,
      ),
    '',
    '## Detalle por caso',
    '',
    '| Caso | Giro | Trampa | Esperado | Entendió | Monto | Hora | params | Salida | ms | Costo | Pasa |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...filas.map(f => {
      const r = typeof f.entendido === 'object' && f.entendido.kind === 'data' ? f.entendido.request : null
      return `| ${f.caso.id} | ${f.caso.giro} | ${f.caso.trampa ? 'sí' : ''} | ${esperadoTexto(f.caso.esperado)} | ${entendidoTexto(f.entendido)} | ${corto(r?.amount ?? '', 20)} | ${corto(r?.time ?? '', 24)} | ${f.params ?? ''} | ${f.salidaTokens ?? ''} | ${f.ms} | ${f.costoUsd.toFixed(5)} | ${f.nota.ok ? '✅' : '❌'} |`
    }),
    '',
  ]
}

/** Un examen de datos: valida el archivo entero antes de cualquier llamada y escribe resultado-<nombre>.md/.json en `dir`. */
async function examenDatos(etiqueta: string, corrida: string | undefined, dir: string): Promise<string[]> {
  const archivo = archivoDeDatos(etiqueta)!
  const nombre = corrida ? `${etiqueta}-${corrida}` : etiqueta
  let casos: DataCase[]
  try {
    casos = JSON.parse(fs.readFileSync(path.join(dir, archivo), 'utf8'))
  } catch (err) {
    throw new Error(`error de archivo (no se llamó a nadie): ${archivo} · no se pudo leer como JSON (${(err as Error).message})`)
  }
  const capacidades = [...Object.keys(DATA_CAPABILITIES), 'other']
  const ids = Array.isArray(casos) ? casos.map(c => c?.id) : []
  const errores = Array.isArray(casos)
    ? [
        ...casos.flatMap(c => validarDato(c, capacidades)),
        ...[...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].map(id => `${id}: id repetido`),
      ]
    : ['no es una lista']
  if (errores.length) throw new Error(`error de archivo (no se llamó a nadie): ${archivo} · ${errores.join('; ')}`)
  biblioteca ??= loadSupportLibrary({ allowDraft: true })
  const { filas, cortado } = await correrDatos(casos)
  const lineas = reporteDatos(nombre, filas, { cortado, esperados: casos.map(c => c.id) })
  fs.writeFileSync(path.join(dir, `resultado-${nombre}.md`), lineas.join('\n') + '\n')
  fs.writeFileSync(path.join(dir, `resultado-${nombre}.json`), JSON.stringify({ casos: filas }, null, 2))
  return lineas
}

// ── Meta-examen y certificado del calificador ───────────────────────────────────────────────────

export interface FilaMeta {
  id: string
  familia: boolean
  fuente: string
  tipo: TipoCondicion
  pregunta: string
  condicion: CondicionArchivo
  respuesta: string
  esperado: Veredicto
}
export interface ResultadoMeta {
  completo: boolean
  faltan: number
  tecnicos: number
  total: number
  aciertos: number
  familiaTotal: number
  familiaAciertos: number
  aprobado: boolean
}
interface Certificado {
  huella: string
  ajuste: ResultadoMeta
  ciego: (ResultadoMeta & { sha256: string }) | null
  fecha: string
}
export const CERTIFICADO = 'calificador-congelado.json'
/** Registro de cada ciego que ya corrió (sha256 del archivo): no hay segunda vuelta con el mismo, aunque se recertifique. */
export const CORRIDAS_CIEGO = 'calificador-ciego-corridas.json'
const leerSiHay = <T>(archivo: string): T | null => (fs.existsSync(archivo) ? JSON.parse(fs.readFileSync(archivo, 'utf8')) : null)

export function validarFilaMeta(f: FilaMeta, i: number): string[] {
  const donde = typeof f?.id === 'string' && f.id.trim() ? f.id : `fila ${i + 1}`
  const errores: string[] = []
  if (typeof f?.id !== 'string' || !f.id.trim()) errores.push(`${donde}: sin id`)
  if (typeof f?.familia !== 'boolean') errores.push(`${donde}: familia no es true ni false`)
  for (const k of ['fuente', 'pregunta', 'respuesta'] as const)
    if (typeof f?.[k] !== 'string' || !f[k].trim()) errores.push(`${donde}: sin ${k}`)
  if (f?.tipo !== 'debe' && f?.tipo !== 'no-debe') errores.push(`${donde}: tipo inválido`)
  else if (!VEREDICTOS[f.tipo].includes(f.esperado)) errores.push(`${donde}: esperado inválido para «${f.tipo}»`)
  const malCondicion = errorDeCondicion(f?.condicion)
  if (malCondicion) errores.push(`${donde}: condición ${malCondicion}`)
  return errores
}

/** El pre-chequeo de un archivo del meta-examen: cada fila y los ids repetidos. */
export function erroresDeMeta(filas: unknown): string[] {
  if (!Array.isArray(filas)) return ['no es una lista']
  const ids = filas.map(f => (f as FilaMeta)?.id)
  return [
    ...filas.flatMap((f, i) => validarFilaMeta(f as FilaMeta, i)),
    ...[...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].map(id => `${id}: id repetido`),
  ]
}
/** JSON con las llaves ordenadas y sin espacios: un cambio de formato no cambia la identidad del ciego. */
const canonico = (x: unknown): string =>
  Array.isArray(x)
    ? `[${x.map(canonico).join(',')}]`
    : x && typeof x === 'object'
      ? `{${Object.keys(x)
          .sort()
          .map(k => `${JSON.stringify(k)}:${canonico((x as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(x)

/** Las dos partes tienen la misma barra: 100 % de su familia y ≥ 95 % del total, completas. Sin filas o sin familia no prueban nada. */
export function resultadoMeta(filas: FilaMeta[], veredictos: Map<string, Veredicto>, cortado: boolean): ResultadoMeta {
  const tecnicos = [...veredictos.values()].filter(v => v === 'tecnico').length
  const { completo, faltan } = completitud(
    filas.map(f => f.id),
    [...veredictos.keys()],
    cortado,
    tecnicos,
  )
  const bien = filas.filter(f => veredictos.get(f.id) === f.esperado)
  const familia = filas.filter(f => f.familia)
  const familiaAciertos = bien.filter(f => f.familia).length
  return {
    completo,
    faltan: faltan.length,
    tecnicos,
    total: filas.length,
    aciertos: bien.length,
    familiaTotal: familia.length,
    familiaAciertos,
    aprobado: completo && familia.length > 0 && familiaAciertos === familia.length && bien.length * 100 >= 95 * filas.length,
  }
}

/** null si el examen principal puede correr: certificado con ajuste y ciego aprobados y la huella de hoy (R4-04). */
export function certificadoVigente(dir = __dirname): string | null {
  const cert = leerSiHay<Certificado>(path.join(dir, CERTIFICADO))
  if (!cert) return `falta el certificado del calificador (${CERTIFICADO}): corre meta-ajuste y meta-ciego`
  if (cert.huella !== huellaCalificador(dir))
    return 'el calificador o su meta-examen cambió desde el certificado: vuelve a certificar (un meta-ajuste aprobado y un ciego nuevo)'
  if (cert.ajuste?.aprobado !== true || cert.ciego?.aprobado !== true)
    return 'el certificado del calificador no tiene el ajuste y el ciego aprobados'
  return null
}

/**
 * meta-ajuste: se puede repetir mientras se afina; cada corrida reescribe el certificado con su resultado y sin ciego.
 * meta-ciego: sólo tras un ajuste aprobado con la misma huella, UNA vez por archivo (se anota antes de la primera llamada),
 * y sólo devuelve totales y barras: nunca filas, respuestas ni veredictos.
 */
export async function correrMeta(
  modo: 'ajuste' | 'ciego',
  deps: { client: OpenAI; dir?: string; log?: (linea: string) => void; recertificar?: boolean },
): Promise<{ lineas: string[]; resultado: ResultadoMeta }> {
  const dir = deps.dir ?? __dirname
  const log = deps.log ?? ((l: string) => process.stdout.write(`${l}\n`))
  const ciego = modo === 'ciego'
  const archivo = ciego ? META_CIEGO : META_AJUSTE
  const crudo = fs.readFileSync(path.join(dir, archivo))
  let filas: FilaMeta[]
  try {
    filas = JSON.parse(crudo.toString('utf8'))
  } catch (err) {
    // El error de JSON.parse cita un pedazo del archivo: del ciego no sale ni eso.
    throw new Error(`error de archivo en ${archivo}: no es JSON válido${ciego ? '' : ` (${(err as Error).message})`}`)
  }
  // R6-01: todo el archivo se valida antes de llamar a nadie. Del ciego no se dice qué falló: nadie lo lee.
  const errores = erroresDeMeta(filas)
  if (errores.length)
    throw new Error(
      `error de archivo en ${archivo}: ${ciego ? `${errores.length} errores (no se muestran: es el ciego)` : errores.join('; ')}`,
    )
  const huella = huellaCalificador(dir)
  const certificado = path.join(dir, CERTIFICADO)
  // La identidad del ciego es su contenido, no su formato.
  const sha256 = crypto.createHash('sha256').update(canonico(filas)).digest('hex')
  const previo = leerSiHay<Certificado>(certificado)
  // Un ajuste nuevo reescribe el certificado sin ciego: nunca en silencio sobre un ciego de esta misma huella.
  if (!ciego && previo?.huella === huella && previo.ciego && !deps.recertificar)
    throw new Error(
      'meta-ajuste: el certificado vigente ya tiene su ciego; correr el ajuste otra vez lo tiraría y pediría un ciego nuevo. Si eso quieres, corre «meta-ajuste --recertificar».',
    )
  if (ciego) {
    const corridas = leerSiHay<{ sha256: string; fecha: string }[]>(path.join(dir, CORRIDAS_CIEGO)) ?? []
    const cert = previo
    if (corridas.some(c => c.sha256 === sha256) || (cert?.huella === huella && cert.ciego))
      throw new Error('meta-ciego: este ciego ya corrió una vez; no hay segunda vuelta con el mismo archivo (hace falta un ciego nuevo)')
    if (cert?.ajuste?.aprobado !== true) throw new Error('meta-ciego: falta un meta-ajuste aprobado')
    if (cert.huella !== huella)
      throw new Error('meta-ciego: el calificador cambió desde el meta-ajuste aprobado: vuelve a correr meta-ajuste')
    // Antes de la primera llamada: aunque la corrida se caiga a la mitad, este ciego ya no vuelve a correr.
    const nuevas = [...corridas, { sha256, fecha: new Date().toISOString() }]
    fs.writeFileSync(path.join(dir, CORRIDAS_CIEGO), JSON.stringify(nuevas, null, 2) + '\n')
  }
  const gasto = { reservadoUsd: 0, topeUsd: CALIFICADOR_TOPE_USD }
  const veredictos = new Map<string, Veredicto>()
  const detalle: string[] = []
  let cortado = false
  for (const f of filas) {
    const r = await calificarCondicion(
      deps.client,
      { tipo: f.tipo, pregunta: f.pregunta, condicion: condiciones([f.condicion])[0], respuesta: f.respuesta },
      gasto,
    )
    if (r === 'SIN_TOPE') {
      cortado = true
      break
    }
    veredictos.set(f.id, r.veredicto)
    if (ciego) continue
    const ok = r.veredicto === f.esperado ? '✅' : '❌'
    log(`${f.id} ${r.veredicto} (esperado ${f.esperado}) ${ok}`)
    detalle.push(
      `| ${f.id} | ${f.familia ? 'sí' : ''} | ${f.tipo} | ${f.esperado} | ${r.veredicto} ${ok} | ${corto(r.cita, 80)} | ${corto(f.fuente, 60)} |`,
    )
  }
  const resultado = resultadoMeta(filas, veredictos, cortado)
  const fecha = new Date().toISOString()
  const cert: Certificado = ciego
    ? { ...leerSiHay<Certificado>(certificado)!, ciego: { ...resultado, sha256 }, fecha }
    : { huella, ajuste: resultado, ciego: null, fecha }
  fs.writeFileSync(certificado, JSON.stringify(cert, null, 2) + '\n')
  const lineas = [
    `# Meta-examen del calificador — ${modo} (${fecha.slice(0, 16)})`,
    '',
    `- ${resultado.completo ? 'Completo' : '⚠️ INCOMPLETO (ninguna barra aprueba)'}: ${veredictos.size}/${resultado.total} calificadas, faltan ${resultado.faltan}, técnicos ${resultado.tecnicos}${cortado ? ', cortado por el tope' : ''}`,
    `- Aciertos: ${resultado.aciertos}/${resultado.total} (${pct(resultado.aciertos, resultado.total)}; barra ≥ 95 %)`,
    `- Familia: ${resultado.familiaAciertos}/${resultado.familiaTotal} (${pct(resultado.familiaAciertos, resultado.familiaTotal)}; barra 100 %)`,
    `- Veredicto: **${resultado.aprobado ? 'APRUEBA' : 'NO APRUEBA'}** · ${CALIFICADOR_MODELO} · gasto ${usd(gasto.reservadoUsd)} de ${usd(CALIFICADOR_TOPE_USD)}`,
    ...(ciego
      ? []
      : ['', '| Fila | Familia | Tipo | Esperado | Calificador | Cita | Fuente |', '|---|---|---|---|---|---|---|', ...detalle]),
  ]
  fs.writeFileSync(path.join(dir, `resultado-meta-${modo}.md`), lineas.join('\n') + '\n')
  return { lineas, resultado }
}

/** Vuelve a leer una corrida guardada sin llamar a nadie: sólo acción y guías, marcada «sin calificador semántico». */
export function recalificar(previo: { casos: FilaCaso[]; secuencias?: FilaSecuencia[] }, corrida: string): string[] {
  const sin = (e: Esperado, s: Salida, esperadas = e.guias ?? []): Nota => {
    const base = notaDeAccion(e, s, esperadas)
    return { ...base, faltaDecir: [], dijoDeMas: [], veredictos: [], avisos: [], tecnicos: 0, semantico: false, pasa: base.guiaOk }
  }
  const casos = previo.casos.map(f => ({ ...f, nota: sin(f.caso.esperado, f.salida) }))
  const secuencias = (previo.secuencias ?? []).map(s => {
    const turnos = s.turnos.map(t => ({ ...t, nota: sin(t.esperado, t.salida, t.esperadas) }))
    return { ...s, turnos, pasa: s.aclaracionesSeguidas <= 2 && turnos.every(t => t.nota.pasa) }
  })
  return reporte(`${corrida}-recalificado`, casos, secuencias, {
    cortado: false,
    oculto: corrida.startsWith('ocultos'),
    esperados: [],
    semantico: false,
  })
}

/**
 * Una corrida: valida todos sus archivos antes de cualquier llamada (R6-01), exige el certificado vigente (R4-04) y califica
 * cada condición con el calificador semántico. Escribe resultado-<nombre>.md/.json en `dir`.
 */
export async function examen(
  etiqueta: string,
  corrida: string | undefined,
  ia: OpenAI,
  dir = __dirname,
  opts: { conDatos?: boolean; esfuerzoJuez?: EsfuerzoJuez } = {},
): Promise<string[]> {
  client = ia
  conCatalogo = opts.conDatos === true
  esfuerzoJuez = opts.esfuerzoJuez ?? SUPPORT_JUDGE_EFFORT
  // Cada corrida empieza su propia cuenta con su propio tope (en un proceso corre una; en las pruebas, varias).
  gastado = 0
  tope = TOPE_USD
  if (archivoDeDatos(etiqueta)) return examenDatos(etiqueta, corrida, dir)
  if (archivoMeta(etiqueta)) {
    const recertificar = corrida === '--recertificar'
    if (corrida !== undefined && !(recertificar && etiqueta === 'meta-ajuste'))
      throw new Error(`${etiqueta}: el único argumento que acepta es «--recertificar», y sólo meta-ajuste`)
    return (await correrMeta(etiqueta === 'meta-ciego' ? 'ciego' : 'ajuste', { client: ia, dir, recertificar })).lineas
  }
  const nombre = corrida ? `${etiqueta}-${corrida}` : etiqueta
  let lineas: string[]
  let datos: unknown = null
  if (etiqueta === 'juez') lineas = await examenJuez()
  else {
    const archivos = archivosDelExamen(etiqueta)
    if (!archivos) throw new Error(`Etiqueta desconocida: ${etiqueta}`)
    const errores: string[] = []
    const leidos = archivos.map(f => {
      try {
        return { f, datos: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as (Caso | Secuencia)[] }
      } catch (err) {
        errores.push(`${f} · no se pudo leer como JSON (${(err as Error).message})`)
        return { f, datos: [] as (Caso | Secuencia)[] }
      }
    })
    errores.push(
      ...leidos.flatMap(({ f, datos: xs }) => (Array.isArray(xs) ? xs.flatMap(validarCaso) : ['no es una lista']).map(e => `${f} · ${e}`)),
    )
    if (errores.length) throw new Error(`error de archivo (no se llamó a nadie): ${errores.join('; ')}`)
    const sinCertificado = certificadoVigente(dir)
    if (sinCertificado) throw new Error(`el examen no corre: ${sinCertificado}`)
    // main() ya la cargó (y revisó que esté completa); una prueba llega aquí sin ella.
    biblioteca ??= loadSupportLibrary({ allowDraft: true })
    const casos = (leidos.find(x => x.f !== 'secuencias.json')?.datos ?? []) as Caso[]
    const secuencias = leidos.find(x => x.f === 'secuencias.json')?.datos as Secuencia[] | undefined
    const bot = etiqueta === 'hoy' ? botHoy : botHibrido
    if (conCatalogo && bot === botHibrido) tope = TOPE_CON_DATOS_USD
    const gastoCalificador = { reservadoUsd: 0, topeUsd: CALIFICADOR_TOPE_USD }
    const calificador: Calificador = input => calificarCondicion(ia, input, gastoCalificador)
    const a = await correrCasos(bot, casos, calificador)
    const b = secuencias && !a.cortado ? await correrSecuencias(bot, secuencias, calificador) : null
    const esperados = [...casos.map(c => c.id), ...(secuencias ?? []).flatMap(s => s.turnos.map((_, i) => idDeTurno(s, i)))]
    lineas = reporte(nombre, a.filas, b?.filas ?? [], {
      cortado: a.cortado || !!b?.cortado,
      oculto: etiqueta.startsWith('ocultos'),
      esperados,
      calificadorUsd: gastoCalificador.reservadoUsd,
    })
    datos = { casos: a.filas, secuencias: b?.filas ?? [] }
  }
  fs.writeFileSync(path.join(dir, `resultado-${nombre}.md`), lineas.join('\n') + '\n')
  if (datos) fs.writeFileSync(path.join(dir, `resultado-${nombre}.json`), JSON.stringify(datos, null, 2))
  return lineas
}

async function main() {
  // --con-datos va después de la etiqueta y la corrida (run.py pasa sus argumentos tal cual).
  const args = process.argv.slice(2)
  const conDatos = args.includes('--con-datos')
  // T-F8: `--esfuerzo-juez=…` mide el juez con otro razonamiento (juez e hibrido); sin él, el del worker (T-F12b: none).
  const esfuerzo = esfuerzoJuezDe(args)
  const [etiqueta = 'hoy', corrida] = args.filter(a => a !== '--con-datos' && !a.startsWith('--esfuerzo-juez='))
  // El examen mide la cadena con las flags encendidas, como en producción.
  process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
  process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'true'
  biblioteca = loadSupportLibrary({ allowDraft: true })
  const ids = new Set(biblioteca.map(b => b.id)).size
  // Se esperan todas las firmables (públicas e internas, menos las retiradas): una guía que se cae en silencio frena el examen.
  const manifest = JSON.parse(fs.readFileSync(SUPPORT_LIBRARY_MANIFEST, 'utf8'))
  const LIBRARY_IDS = new Set(signableSources(readLibrarySources(), manifest).map(s => s.id)).size
  if (ids !== LIBRARY_IDS) throw new Error(`La biblioteca cargó ${ids} ids; se esperaban ${LIBRARY_IDS}.`)
  if (etiqueta === '--biblioteca') return console.log(`secciones ${biblioteca.length} · guías ${ids}`)
  if (etiqueta === 'recalificar') {
    // Sin llamar a la IA: los resultados viejos se muestran «sin calificador semántico» y no cuentan para ninguna barra.
    if (!corrida) throw new Error('Uso: recalificar <nombre de la corrida, p. ej. hibrido-final u ocultos>')
    const previo = JSON.parse(fs.readFileSync(path.join(__dirname, `resultado-${corrida}.json`), 'utf8'))
    const lineasR = recalificar(previo, corrida)
    fs.writeFileSync(path.join(__dirname, `resultado-${corrida}-recalificado.md`), lineasR.join('\n') + '\n')
    return console.log(lineasR.slice(0, 20).join('\n'))
  }
  const apiKey = process.env.SUPPORT_OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error('Falta la llave: corre el examen con run.py eval.')
  const lineas = await examen(etiqueta, corrida, createSupportAiClient({ apiKey } as never), __dirname, {
    conDatos,
    esfuerzoJuez: esfuerzo,
  })
  // meta-ciego sólo devuelve totales; los demás, la cabecera de su reporte.
  console.log(lineas.slice(0, 20).join('\n'))
  console.log(`GASTO ${usd(gastado)} · tokens ${JSON.stringify(tokens)}`)
}

/**
 * Mini examen del juez (juez.json): pares correcta / alterada, y desde T-F13 pares «correcta pero sin la advertencia clave»
 * (`falta`: todo es cierto y los pasos son los de la guía, pero deja fuera una advertencia que la guía le pone a esos pasos).
 * Barras: detecta ≥ 90 % de alteradas, rechaza ≤ 10 % de correctas (las dos sin los pares `falta`, como antes) y, T-F13, detecta
 * ≥ 90 % de faltantes: `missing` trae un renglón de verdad de la guía (judgeMissingSignal, la señal del worker).
 */
async function examenJuez(): Promise<string[]> {
  type Par = {
    id: string
    question: string
    guideId: string
    intro: { text: string; quote: string } | null
    steps: { text: string; quote: string }[]
    supported: boolean
    alteracion: string
    falta?: string
  }
  const pares: Par[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'juez.json'), 'utf8'))
  // main() ya la cargó; una prueba llega aquí sin ella.
  biblioteca ??= loadSupportLibrary({ allowDraft: true })
  const filas: { par: Par; supported: boolean; senal: boolean; lineas: number[]; revisor: string; ms: number; costo: number }[] = []
  for (const par of pares) {
    const guides = biblioteca.filter(g => g.id === par.guideId).slice(0, 1)
    if (!guides.length) throw new Error(`${par.id}: la guía ${par.guideId} no está en la biblioteca`)
    const draft: SupportDraft = {
      covered: true,
      intro: par.intro ? { ...par.intro, guideId: par.guideId } : null,
      steps: par.steps.map(s => ({ ...s, guideId: par.guideId })),
    }
    const review = reviewSupportDraft(draft, guides)
    const t0 = Date.now()
    const cuenta = new Cuenta()
    const j = await judgeSupportDraft(client, { question: par.question, draft, guides }, pricing, esfuerzoJuez)
    cuenta.sumar(j)
    gastado += cuenta.costoUsd
    filas.push({
      par,
      supported: j.supported,
      senal: judgeMissingSignal(draft, guides, j.missing),
      lineas: j.missing.map(m => m.line),
      revisor: review.ok ? 'ok' : review.reason,
      ms: Date.now() - t0,
      costo: cuenta.costoUsd,
    })
    process.stdout.write(`${par.id} ${j.supported} ${j.missing.map(m => m.line).join(',')}\n`)
  }
  const alteradas = filas.filter(f => !f.par.supported)
  const correctas = filas.filter(f => f.par.supported && !f.par.falta)
  const conFalta = filas.filter(f => f.par.falta)
  const detecta = alteradas.filter(f => !f.supported).length
  const rechaza = correctas.filter(f => !f.supported).length
  const faltantes = conFalta.filter(f => f.senal).length
  const pasa = detecta * 10 >= 9 * alteradas.length && rechaza * 10 <= correctas.length && faltantes * 10 >= 9 * conFalta.length
  // No es barra: una correcta con un faltante de verdad sale como la guía entera en lugar de la redactada (más larga, no peor).
  const deMas = correctas.filter(f => f.senal).length
  const esperado = (f: (typeof filas)[number]) => (!f.par.supported ? 'rechazar' : f.par.falta ? 'aprobar + falta' : 'aprobar')
  const ok = (f: (typeof filas)[number]) => (f.par.falta ? f.senal : f.supported === f.par.supported)
  return [
    `# Mini examen del juez (${new Date().toISOString().slice(0, 16)})`,
    '',
    `- Detecta alteradas: **${detecta}/${alteradas.length}** (${pct(detecta, alteradas.length)}; barra ≥ 90 %)`,
    `- Rechaza correctas: **${rechaza}/${correctas.length}** (${pct(rechaza, correctas.length)}; barra ≤ 10 %)`,
    `- Detecta faltantes: **${faltantes}/${conFalta.length}** (${pct(faltantes, conFalta.length)}; barra ≥ 90 %)`,
    `- Faltantes en correctas (sale la guía entera en vez de la redactada; no es barra): ${deMas}/${correctas.length}`,
    `- Veredicto: **${pasa ? 'PASA' : 'NO PASA'}** · gasto ${usd(gastado)} · mediana ${(mediana(filas.map(f => f.ms)) / 1000).toFixed(1)} s · razonamiento ${esfuerzoJuez}`,
    `- Tokens: ${JSON.stringify(tokens)}`,
    '',
    '| Par | Alteración | Esperado | Juez | Faltan (renglones) | Revisor de reglas | ms |',
    '|---|---|---|---|---|---|---|',
    ...filas.map(
      f =>
        `| ${f.par.id} | ${f.par.alteracion} | ${esperado(f)} | ${f.supported ? 'aprobó' : 'rechazó'} ${ok(f) ? '✅' : '❌'} | ${f.lineas.join(', ') || '—'}${f.senal ? '' : f.lineas.length ? ' (ninguno es renglón)' : ''} | ${f.revisor} | ${f.ms} |`,
    ),
  ]
}

if (require.main === module)
  main().catch(err => {
    console.error('examen', err?.name, err?.message)
    process.exit(1)
  })
