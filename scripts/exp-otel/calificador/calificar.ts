/**
 * EXPERIMENTO OTel — CALIFICADOR CONGELADO Y CIEGO (plan 1a/1b/1c; correcciones 5 y 6).
 * Se congela con su commit ANTES de la primera corrida medida; cualquier cambio posterior se declara en el reporte.
 *
 * CIEGO: lee SÓLO, por corrida: `servidor.log` (JSON de winston), `colector/spans.jsonl` (lo exportado por el colector,
 * si existe), `llaves.json` (la llave de partida de cada cobro) y `meta.json` (brazo, repetición, ¿referencia?), más el
 * fixture (ids del montaje). NO lee `entorno.json`, `exp-out/claves/` ni `referencia-cliente.json`.
 *
 * ── 1a · HILO ── Partiendo de la llave de la PRIMERA petición del POS (A: el X-Correlation-ID que devolvió ①; A+: su
 * correlationId; B: su trace-id), ¿cuántos de los 8 pasos se recuperan con ESA llave y nada más? Ocho detectores:
 *   ①②③⑥  logs: «Request End» de su entrypoint · spans: span SERVER de su ruta
 *   ④      logs: «Sending payment request to terminal» o «Durable ACK received» · spans: nombre/atributo con
 *          `terminal:payment_request`
 *   ⑤      logs: cualquier línea con entrypoint `socket:terminal:payment_attempt_opened` · spans: con
 *          `terminal:payment_attempt_opened`
 *   ⑦      logs: «Payment blocking steps» · spans: operación de Prisma/SQL que crea `PaymentEffect`
 *   ⑧      logs: cualquier línea con entrypoint `payment-effects` · spans: `payment-effect <kind>`
 * En B la llave es el trace-id; se reporta ESTRICTO (sólo spans/logs con ese trace-id) y CON ENLACES (además los spans
 * que tienen un LINK a ese trace-id y su subárbol — lo que prescribe la convención de mensajería y lo que un visor de
 * trazas sigue solo). También se cuentan ENLACES FALSOS (ids de otro cobro bajo esta llave) y DUPLICADOS.
 *
 * ── 1b · ¿DÓNDE SE FUE EL TIEMPO? ── Por corrida con falla: para cada paso, una métrica de duración leída del artefacto;
 * delta = mediana(corrida) − mediana(referencia del mismo brazo y repetición). Se descartan deltas < 200 ms. Entre los
 * candidatos con delta ≥ 80 % del mayor gana el paso MÁS INTERNO (③ contiene ⑥, que contiene ⑦). Respuesta:
 * (paso, incremento, tipo de evidencia). Métricas:
 *   logs : ①②③⑥ durationMs de «Request End» (inclusiva) · ⑦ fase `financial_commit` de «Payment blocking steps»
 *          (propia) · ⑥-propio = ⑥ − Σ fases (inclusiva: restar no prueba quién ejecutaba)
 *   spans: ①②③⑥ duración del span SERVER (inclusiva) · ⑥-ejecutor = Σ spans `request_handler` de Express (tiempo
 *          SÍNCRONO del handler: separa al que ejecutaba de los que esperaban) · ⑦ mayor span de base de datos dentro
 *          de ⑥ (propia) · ⑧ duración del span `payment-effect RECEIPT` (propia)
 *
 * ── 1c · ERROR DE PUNTA A PUNTA ── ¿Algún cobro tiene, bajo SU llave, un error de efecto? logs: «El efecto falló» /
 * nivel error con entrypoint `payment-effects` · spans: `payment-effect …` con estado ERROR.
 *
 * ── CONTEXTOS (corrección 7, sólo familia B, en la referencia) ── (a) ninguna traza mezcla dos sucursales en sus logs;
 * (c) ningún span de efecto hereda un padre (de la vuelta del cron); (d) ningún span de efecto termina antes que su
 * trabajo (descendientes).
 *
 * Uso: tsx calificar.ts <carpeta-utilidad> <fixture.json> → escribe calificacion.json en esa carpeta.
 */
import fs from 'node:fs'
import path from 'node:path'

type Linea = Record<string, any>
interface Span {
  traceId: string
  spanId: string
  parent: string
  name: string
  kind: number
  ini: number
  fin: number
  attrs: Record<string, string>
  links: string[]
  error: boolean
}

const PASOS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const
const RUTAS: Record<string, { metodo: string; ruta: string }> = {
  '1': { metodo: 'POST', ruta: '/api/v1/mobile/venues/:id/orders' },
  '2': { metodo: 'POST', ruta: '/api/v1/mobile/venues/:id/orders/:id/items' },
  '3': { metodo: 'POST', ruta: '/api/v1/mobile/venues/:id/terminal-payment' },
  '6': { metodo: 'POST', ruta: '/api/v1/tpv/venues/:id/orders/:id' },
}
const RANGO: Record<string, number> = { '1': 2, '2': 2, '3': 1, '4': 2, '5': 2, '6': 2, '6p': 2, '6e': 2, '7': 3, '8': 3 }

const normRuta = (r: string) =>
  r
    .split('?')[0]
    .replace(/\/c[a-z0-9]{24}(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/g, '/:id')
    .replace(/\/:\w+/g, '/:id')

function leerLog(archivo: string): Linea[] {
  if (!fs.existsSync(archivo)) return []
  const out: Linea[] = []
  for (const l of fs.readFileSync(archivo, 'utf8').split('\n')) {
    if (!l.startsWith('{')) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      /* línea no JSON */
    }
  }
  return out
}

function valor(v: any): string {
  if (!v) return ''
  for (const k of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) if (v[k] !== undefined) return String(v[k])
  return JSON.stringify(v)
}

function leerSpans(archivo: string): Span[] {
  if (!fs.existsSync(archivo)) return []
  const out: Span[] = []
  for (const l of fs.readFileSync(archivo, 'utf8').split('\n')) {
    if (!l.trim()) continue
    let j: any
    try {
      j = JSON.parse(l)
    } catch {
      continue
    }
    for (const rs of j.resourceSpans ?? [])
      for (const ss of rs.scopeSpans ?? [])
        for (const s of ss.spans ?? []) {
          const attrs: Record<string, string> = {}
          for (const a of s.attributes ?? []) attrs[a.key] = valor(a.value)
          out.push({
            traceId: s.traceId,
            spanId: s.spanId,
            parent: s.parentSpanId ?? '',
            name: s.name ?? '',
            kind: Number(s.kind ?? 0),
            ini: Number(BigInt(s.startTimeUnixNano ?? 0) / 1000n) / 1000,
            fin: Number(BigInt(s.endTimeUnixNano ?? 0) / 1000n) / 1000,
            attrs,
            links: (s.links ?? []).map((k: any) => k.traceId),
            error: s.status?.code === 2 || s.status?.code === 'STATUS_CODE_ERROR',
          })
        }
  }
  return out
}

const texto = (s: Span) => `${s.name} ${Object.values(s.attrs).join(' ')}`
const rutaDeSpan = (s: Span) => normRuta(s.attrs['http.route'] || s.attrs['url.path'] || s.attrs['http.target'] || s.name.replace(/^[A-Z]+ /, ''))
const metodoDeSpan = (s: Span) => s.attrs['http.request.method'] || s.attrs['http.method'] || s.name.split(' ')[0]
const esServer = (s: Span) => s.kind === 2 || s.kind === ('SPAN_KIND_SERVER' as any)
const duracion = (s: Span) => s.fin - s.ini

function lineasDeLlave(log: Linea[], llave: string, b: boolean) {
  return log.filter(l => (b ? l.trace_id === llave : l.correlationId === llave))
}
const esRequestEnd = (l: Linea, paso: string) =>
  typeof l.message === 'string' && l.message.startsWith('Request End') && normRuta(String(l.entrypoint ?? '').replace(/^[A-Z]+ /, '')) === RUTAS[paso].ruta && String(l.entrypoint ?? '').startsWith(RUTAS[paso].metodo)

function detectoresLog(ls: Linea[]): Record<string, number> {
  const n = (f: (l: Linea) => boolean) => ls.filter(f).length
  return {
    '1': n(l => esRequestEnd(l, '1')),
    '2': n(l => esRequestEnd(l, '2')),
    '3': n(l => esRequestEnd(l, '3')),
    '4': n(l => /Sending payment request to terminal|Durable ACK received/.test(String(l.message))),
    '5': n(l => l.entrypoint === 'socket:terminal:payment_attempt_opened'),
    '6': n(l => esRequestEnd(l, '6')),
    '7': n(l => l.message === 'Payment blocking steps'),
    '8': n(l => l.entrypoint === 'payment-effects'),
  }
}

function spansDeLlave(spans: Span[], llave: string, conEnlaces: boolean): Span[] {
  const propios = spans.filter(s => s.traceId === llave)
  if (!conEnlaces) return propios
  const trazasEnlazadas = new Set(spans.filter(s => s.links.includes(llave)).map(s => s.traceId))
  return [...propios, ...spans.filter(s => trazasEnlazadas.has(s.traceId))]
}

function detectoresSpans(ss: Span[]): Record<string, number> {
  const n = (f: (s: Span) => boolean) => ss.filter(f).length
  const srv = (p: string) => (s: Span) => esServer(s) && rutaDeSpan(s) === RUTAS[p].ruta && metodoDeSpan(s) === RUTAS[p].metodo
  return {
    '1': n(srv('1')),
    '2': n(srv('2')),
    '3': n(srv('3')),
    '4': n(s => texto(s).includes('terminal:payment_request')),
    '5': n(s => texto(s).includes('terminal:payment_attempt_opened')),
    '6': n(srv('6')),
    '7': n(s => /PaymentEffect/.test(texto(s)) && /createMany|INSERT/i.test(texto(s))),
    '8': n(s => s.name.startsWith('payment-effect ')),
  }
}

/** Métricas de duración por paso de UN cobro (1b), con su tipo de evidencia. */
function metricas(ls: Linea[], ss: Span[]): Record<string, { ms: number; tipo: string }> {
  const m: Record<string, { ms: number; tipo: string }> = {}
  for (const p of ['1', '2', '3', '6']) {
    const re = ls.find(l => esRequestEnd(l, p))
    if (re && Number.isFinite(Number(re.durationMs))) m[p] = { ms: Number(re.durationMs), tipo: 'inclusiva' }
  }
  const pbs = ls.find(l => l.message === 'Payment blocking steps')
  if (pbs && Array.isArray(pbs.phases)) {
    const fc = pbs.phases.find((x: any) => x.step === 'financial_commit')
    if (fc) m['7'] = { ms: Number(fc.elapsedMs), tipo: 'propia' }
    const suma = pbs.phases.reduce((a: number, x: any) => a + Number(x.elapsedMs || 0), 0)
    if (m['6']) m['6p'] = { ms: m['6'].ms - suma, tipo: 'inclusiva' }
  }
  if (ss.length) {
    for (const p of ['1', '2', '3', '6']) {
      const s = ss.find(x => esServer(x) && rutaDeSpan(x) === RUTAS[p].ruta && metodoDeSpan(x) === RUTAS[p].metodo)
      if (s && !m[p]) m[p] = { ms: duracion(s), tipo: 'inclusiva' }
      else if (s) m[p] = { ms: duracion(s), tipo: 'inclusiva' }
    }
    const s6 = ss.find(x => esServer(x) && rutaDeSpan(x) === RUTAS['6'].ruta)
    if (s6) {
      const enTraza = ss.filter(x => x.traceId === s6.traceId && x.ini >= s6.ini - 1 && x.fin <= s6.fin + 1)
      const handlers = enTraza.filter(x => x.attrs['express.type'] === 'request_handler')
      if (handlers.length) m['6e'] = { ms: handlers.reduce((a, x) => a + duracion(x), 0), tipo: 'ejecutor' }
      const db = enTraza.filter(x => /prisma:engine:db_query|db_query|prisma:client:operation/.test(x.name) || x.attrs['db.system'] || x.attrs['db.system.name'])
      if (db.length) m['7'] = { ms: Math.max(...db.map(duracion)), tipo: 'propia' }
    }
    const e8 = ss.filter(x => x.name === 'payment-effect RECEIPT')
    if (e8.length) m['8'] = { ms: Math.max(...e8.map(duracion)), tipo: 'propia' }
  }
  return m
}

const med = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!s.length) return NaN
  const k = Math.floor(s.length / 2)
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2
}

function main() {
  const raiz = process.argv[2]
  const fixture = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
  const idsDelMontaje = new Set<string>(
    [fixture.orgId, fixture.venueId, fixture.venue2Id, fixture.staffId, fixture.productId, fixture.merchantAccountId, ...(fixture.mesas ?? []), ...fixture.terminales.map((t: any) => t.id)].filter(Boolean),
  )
  const corridas = fs.readdirSync(raiz).filter(d => fs.existsSync(path.join(raiz, d, 'meta.json')))
  const datos = corridas.map(id => {
    const dir = path.join(raiz, id)
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
    const llaves = fs.existsSync(path.join(dir, 'llaves.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'llaves.json'), 'utf8')) : { cobros: [] }
    const log = leerLog(path.join(dir, 'servidor.log'))
    const spans = leerSpans(path.join(dir, 'colector', 'spans.jsonl'))
    const b = llaves.modoCliente === 'traceparent'
    const cobros = (llaves.cobros as Array<{ n: number; llave: string | null }>).map(c => {
      if (!c.llave) return { n: c.n, llave: null, hilo: 0 }
      const ls = lineasDeLlave(log, c.llave, b)
      const det = detectoresLog(ls)
      const estricto = b ? detectoresSpans(spansDeLlave(spans, c.llave, false)) : null
      const enlaces = b ? detectoresSpans(spansDeLlave(spans, c.llave, true)) : null
      const junta = (x: Record<string, number> | null) => Object.fromEntries(PASOS.map(p => [p, (det[p] ?? 0) + (x?.[p] ?? 0)]))
      const final = b ? junta(enlaces) : det
      const finalEstricto = b ? junta(estricto) : det
      // ids de negocio (cuid) bajo esta llave
      const ids = new Set<string>()
      for (const l of ls) for (const x of JSON.stringify(l).match(/c[a-z0-9]{24}/g) ?? []) if (!idsDelMontaje.has(x)) ids.add(x)
      const ss = b ? spansDeLlave(spans, c.llave, true) : []
      const errorLog = ls.some(l => /El efecto falló/.test(String(l.message)) || (l.level === 'error' && l.entrypoint === 'payment-effects'))
      const errorSpan = ss.some(s => s.name.startsWith('payment-effect ') && s.error)
      return {
        n: c.n,
        llave: c.llave,
        detectores: final,
        hilo: PASOS.filter(p => final[p] > 0).length,
        hiloEstricto: PASOS.filter(p => finalEstricto[p] > 0).length,
        // un paso que debía ocurrir UNA vez y aparece más (reintento o duplicado), por fuente
        duplicados: ['1', '2', '3', '6', '7'].filter(p => det[p] > 1 || (b && p !== '7' && (enlaces?.[p] ?? 0) > 1)).length,
        ids: [...ids],
        metricas: metricas(ls, ss),
        errorDeEfecto: errorLog || errorSpan,
      }
    })
    // enlaces falsos: un id de negocio que aparece bajo las llaves de DOS cobros distintos
    const cuenta = new Map<string, number>()
    for (const c of cobros as any[]) for (const x of c.ids ?? []) cuenta.set(x, (cuenta.get(x) ?? 0) + 1)
    for (const c of cobros as any[]) c.enlacesFalsos = (c.ids ?? []).filter((x: string) => (cuenta.get(x) ?? 0) > 1).length

    // contextos (familia B)
    let contextos: any = null
    if (b) {
      const venuesPorTraza = new Map<string, Set<string>>()
      for (const l of log) if (l.trace_id && l.venueId) (venuesPorTraza.get(l.trace_id) ?? venuesPorTraza.set(l.trace_id, new Set()).get(l.trace_id)!).add(l.venueId)
      const mezcladas = [...venuesPorTraza.values()].filter(s => s.size > 1).length
      const llavesCobro = new Set((llaves.cobros as any[]).map(c => c.llave))
      const cobroEnOtraSucursal = log.filter(l => llavesCobro.has(l.trace_id) && l.venueId && l.venueId !== fixture.venueId).length
      const efectos = spans.filter(s => s.name.startsWith('payment-effect '))
      const conPadre = efectos.filter(s => s.parent && s.parent !== '').length
      const hijos = (s: Span) => spans.filter(x => x.traceId === s.traceId && x.spanId !== s.spanId)
      const cerradoAntes = efectos.filter(s => hijos(s).some(x => x.fin > s.fin + 1)).length
      contextos = { trazasConDosSucursales: mezcladas, lineasDeCobroConOtraSucursal: cobroEnOtraSucursal, spansDeEfecto: efectos.length, efectosConPadre: conPadre, efectosCerradosAntesQueSuTrabajo: cerradoAntes }
    }
    return { id, meta, b, cobros, contextos, nLog: log.length, nSpans: spans.length }
  })

  // 1b: contra la referencia del mismo brazo y repetición
  const salida = datos.map(d => {
    const ref = datos.find(x => x.meta.brazo === d.meta.brazo && x.meta.rep === d.meta.rep && x.meta.esReferencia)
    let respuesta1b: any = null
    if (!d.meta.esReferencia && ref) {
      const claves = new Set<string>()
      for (const c of d.cobros as any[]) for (const k of Object.keys(c.metricas ?? {})) claves.add(k)
      const cand = [...claves]
        .map(k => {
          const a = med((d.cobros as any[]).map(c => c.metricas?.[k]?.ms))
          const r = med((ref.cobros as any[]).map(c => c.metricas?.[k]?.ms))
          const tipo = (d.cobros as any[]).find(c => c.metricas?.[k])?.metricas[k].tipo
          return { metrica: k, paso: k.replace(/[pe]$/, ''), delta: a - r, tipo }
        })
        .filter(x => Number.isFinite(x.delta) && x.delta >= 200)
      if (cand.length) {
        const max = Math.max(...cand.map(x => x.delta))
        const finos = cand.filter(x => x.delta >= 0.8 * max).sort((x, y) => RANGO[y.metrica] - RANGO[x.metrica] || (y.tipo === 'ejecutor' ? 1 : 0) - (x.tipo === 'ejecutor' ? 1 : 0) || y.delta - x.delta)
        respuesta1b = { paso: finos[0].paso, incrementoMs: Math.round(finos[0].delta), tipo: finos[0].tipo, metrica: finos[0].metrica, candidatos: cand }
      } else respuesta1b = { paso: null, incrementoMs: null, tipo: null, candidatos: [] }
    }
    return {
      id: d.id,
      brazo: d.meta.brazo,
      rep: d.meta.rep,
      esReferencia: d.meta.esReferencia,
      hilo: { porCobro: d.cobros.map((c: any) => c.hilo), estrictoPorCobro: d.cobros.map((c: any) => c.hiloEstricto), mediana: med(d.cobros.map((c: any) => c.hilo)), medianaEstricta: med(d.cobros.map((c: any) => c.hiloEstricto)) },
      detectoresPorCobro: d.cobros.map((c: any) => c.detectores),
      enlacesFalsos: d.cobros.reduce((a: number, c: any) => a + (c.enlacesFalsos ?? 0), 0),
      duplicados: d.cobros.reduce((a: number, c: any) => a + (c.duplicados ?? 0), 0),
      respuesta1b,
      errorDeEfectoLigado: d.cobros.filter((c: any) => c.errorDeEfecto).length,
      contextos: d.contextos,
      nLog: d.nLog,
      nSpans: d.nSpans,
    }
  })
  fs.writeFileSync(path.join(raiz, 'calificacion.json'), JSON.stringify(salida, null, 2))
  console.log(`calificadas ${salida.length} corridas`)
}

main()
