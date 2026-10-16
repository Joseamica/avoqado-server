/**
 * EXPERIMENTO OTel — REPORTE: junta los artefactos de todos los jobs, corre el CALIFICADOR CIEGO sobre la utilidad,
 * lo compara después con las claves (qué falla se sembró) y aplica EXACTAMENTE el criterio del plan
 * (plan-medicion.md + correcciones 9-12), con «INCONCLUSO» cuando la dispersión entre repeticiones cruza el umbral.
 *
 * Uso: tsx reporte.ts <carpeta-con-los-artefactos> → resumen.json y resumen.md en esa carpeta.
 * Parámetros de volumen (para GB/mes): VOL_COBROS_MES, VOL_PETICIONES_MES, MUESTREO_RESTO (fracción).
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const RAIZ = process.argv[2] || 'exp-all'
const VOL_COBROS_MES = Number(process.env.VOL_COBROS_MES || 45_000)
const VOL_PETICIONES_MES = Number(process.env.VOL_PETICIONES_MES || 3_000_000)
const MUESTREO_RESTO = Number(process.env.MUESTREO_RESTO || 0.1)
const CAL_BAJA_SEGUNDOS = [16, 46]

const leer = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))
const existe = (p: string) => fs.existsSync(p)
function buscar(dir: string, pred: (p: string) => boolean, out: string[] = []): string[] {
  if (!existe(dir)) return out
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) buscar(p, pred, out)
    else if (pred(p)) out.push(p)
  }
  return out
}
const pct = (xs: number[], p: number) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : NaN
}
const med = (xs: number[]) => pct(xs, 50)
const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null)
const ETIQUETAS_HTTP = ['1_crear_orden', '2_agregar_ronda', '3_cobro_en_terminal', '6_registro_del_cobro', 'GET ordenes', 'GET tipos-de-pago', 'GET orden']

/** pasa / falla / INCONCLUSO con las diferencias PAREADAS por repetición (corrección 10: intervalos, no igualdad). */
function decidir(diffs: number[], umbral: (i: number) => number) {
  const ok = diffs.map((d, i) => d <= umbral(i))
  if (!diffs.length || diffs.some(d => !Number.isFinite(d))) return 'SIN DATOS'
  if (ok.every(Boolean)) return 'PASA'
  if (ok.every(x => !x)) return 'FALLA'
  return 'INCONCLUSO'
}

// ─────────────────────────────── 2 · COSTO ───────────────────────────────
function costo() {
  const reps = buscar(RAIZ, p => /costo-rep\d+\.json$/.test(p)).map(leer)
  const porBrazo: Record<string, any[]> = {}
  for (const rep of reps)
    for (const b of rep.bloques) {
      const alta = b.ventanas.find((v: any) => v.nombre === 'alta')
      const baja = b.ventanas.find((v: any) => v.nombre === 'baja')
      const todas = (v: any) => ETIQUETAS_HTTP.flatMap(e => v?.porEtiqueta?.[e]?.ms ?? [])
      const done = (baja?.done ?? []).filter((x: any) => x.completado)
      const espera = (c: number) => {
        const d = new Date(c)
        const s = d.getUTCSeconds() + d.getUTCMilliseconds() / 1000
        const prox = CAL_BAJA_SEGUNDOS.find(x => x >= s) ?? 76
        return (prox - s) * 1000
      }
      ;(porBrazo[b.brazo] ??= []).push({
        rep: rep.rep,
        listoMs: b.listoMs,
        rssReposoMB: b.rssReposoMB,
        alta: {
          p50: pct(todas(alta), 50),
          p95: pct(todas(alta), 95),
          p99: pct(todas(alta), 99),
          cpuFraccion: alta?.cpuFraccion,
          cpuMsPor1000: alta?.cpuMsPor1000Peticiones,
          rssPicoMB: alta?.rssPicoMB,
          eventLoopP99: alta?.eventLoopP99Mediana,
          cobrosOk: alta?.cobros?.ok,
          cobros: alta?.cobros?.iniciados,
          errores: ETIQUETAS_HTTP.reduce((a, e) => a + (alta?.porEtiqueta?.[e]?.errores ?? 0), 0),
          pendientes: alta?.efectosPendientesAlFinal,
          porEndpointP95: Object.fromEntries(ETIQUETAS_HTTP.map(e => [e, r1(alta?.porEtiqueta?.[e]?.p95)])),
        },
        baja: {
          p95: pct(todas(baja), 95),
          cpuFraccion: baja?.cpuFraccion,
          rssPicoMB: baja?.rssPicoMB,
          doneTotalP50: med(done.map((x: any) => x.completado - x.creado)),
          doneSinEsperaDelCronP50: med(done.map((x: any) => x.completado - x.creado - espera(x.creado))),
          efectos: (baja?.done ?? []).length,
          efectosDone: done.length,
        },
      })
    }
  for (const k of Object.keys(porBrazo)) porBrazo[k].sort((a, b) => a.rep - b.rep)
  const ref = porBrazo['A+'] ?? []
  const comparar = (brazo: string) => {
    const x = porBrazo[brazo] ?? []
    const pares = x.map(b => ({ b, a: ref.find(r => r.rep === b.rep) })).filter(p => p.a)
    const dp95 = pares.map(p => p.b.alta.p95 - p.a.alta.p95)
    const cpu = pares.map(p => p.b.alta.cpuMsPor1000 / p.a.alta.cpuMsPor1000 - 1)
    const rss = pares.map(p => p.b.alta.rssPicoMB - p.a.alta.rssPicoMB)
    const arranque = pares.map(p => (p.b.listoMs - p.a.listoMs) / 1000)
    return {
      brazo,
      reps: pares.length,
      dp95Ms: dp95.map(r1),
      dCpuPorPeticionPct: cpu.map(v => r1(v * 100)),
      dRssPicoMB: rss.map(r1),
      dArranqueS: arranque.map(r1),
      veredictos: {
        p95: decidir(dp95, i => Math.min(0.05 * pares[i].a.alta.p95, 10)),
        cpuPorPeticion: decidir(cpu, () => 0.1),
        rssPico: decidir(rss, () => 30),
        arranque: decidir(arranque, () => 3),
      },
    }
  }
  return { porBrazo, contraAmas: ['A', 'B', 'B0', 'BmP'].map(comparar) }
}

// ─────────────────────────────── 3 · C ───────────────────────────────
function caido() {
  const archivos = buscar(RAIZ, p => /caido-.*-rep\d+\.json$/.test(p))
  const filas: any[] = []
  for (const f of archivos) {
    const j = leer(f)
    const base = path.dirname(f)
    const bloque = (etq: string) => {
      const dir = path.join(base, 'caido', etq)
      const carga = existe(path.join(dir, 'carga.json')) ? leer(path.join(dir, 'carga.json')) : null
      const v = carga?.ventanas?.find((x: any) => x.nombre === 'sostenida' || x.nombre === 'apagado')
      const ms = ETIQUETAS_HTTP.flatMap(e => v?.porEtiqueta?.[e]?.ms ?? [])
      const med_ = existe(path.join(dir, 'medicion.jsonl'))
        ? fs.readFileSync(path.join(dir, 'medicion.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
        : []
      const dentro = v ? med_.filter((x: any) => x.t >= v.inicio && x.t <= v.fin) : []
      const mitad = v ? (v.inicio + v.fin) / 2 : 0
      const rssMitad = med(dentro.filter((x: any) => x.t <= mitad && x.t >= mitad - 60_000).map((x: any) => x.rss)) / 2 ** 20
      const rssFin = med(dentro.slice(-12).map((x: any) => x.rss)) / 2 ** 20
      const contAntes = existe(path.join(dir, 'contadores-otel-antes.json')) ? (() => { try { return leer(path.join(dir, 'contadores-otel-antes.json')) } catch { return null } })() : null
      const contFinal = existe(path.join(dir, 'contadores-otel-final.json')) ? (() => { try { return leer(path.join(dir, 'contadores-otel-final.json')) } catch { return null } })() : null
      const logS = existe(path.join(dir, 'servidor.log')) ? fs.readFileSync(path.join(dir, 'servidor.log'), 'utf8').split('\n') : []
      const ruido = logS.filter(l => /"level":"(error|warn)"/.test(l)).length
      const b = existe(path.join(dir, 'bloque.json')) ? leer(path.join(dir, 'bloque.json')) : {}
      return {
        p95: pct(ms, 95),
        errores: ETIQUETAS_HTTP.reduce((a, e) => a + (v?.porEtiqueta?.[e]?.errores ?? 0), 0),
        cobrosOk: v?.cobros?.ok,
        cobros: v?.cobros?.iniciados,
        rssMitadMB: r1(rssMitad),
        rssFinMB: r1(rssFin),
        crecimientoSegundaMitadMB: r1(rssFin - rssMitad),
        vivo: b.vivoAlFinal,
        salida: b.codigoDeSalida,
        msHastaSalir: b.msHastaSalir,
        contadoresAntesDeApagar: contAntes,
        contadoresAlSalir: contFinal,
        lineasWarnError: ruido,
      }
    }
    const B = bloque(`${j.variante}-r${j.rep}-B`)
    const C = bloque(`${j.variante}-r${j.rep}-C`)
    const BA = bloque(`${j.variante}-r${j.rep}-B-apagado`)
    const CA = bloque(`${j.variante}-r${j.rep}-C-apagado`)
    filas.push({ variante: j.variante, rep: j.rep, B, C, apagadoB: BA, apagadoC: CA, dp95Pct: r1((C.p95 / B.p95 - 1) * 100) })
  }
  const variantes = [...new Set(filas.map(f => f.variante))]
  const veredictos = variantes.map(v => {
    const fs_ = filas.filter(f => f.variante === v)
    return {
      variante: v,
      reps: fs_.length,
      p95: decidir(fs_.map(f => f.C.p95 / f.B.p95 - 1), () => 0.2),
      seCayo: fs_.some(f => f.C.vivo === false),
      crecimientoMB: fs_.map(f => f.C.crecimientoSegundaMitadMB),
      memoriaSinTope: fs_.some(f => (f.C.crecimientoSegundaMitadMB ?? 0) > 50) ? 'POSIBLE (>50 MB en la 2.ª mitad)' : 'no observado en 10 min (10 min no prueban «sin tope»)',
    }
  })
  return { filas, veredictos }
}

// ─────────────────────────────── 1 · UTILIDAD ───────────────────────────────
function utilidad() {
  const raices = buscar(RAIZ, p => p.endsWith(`${path.sep}fixture.json`))
    .map(p => path.dirname(p))
    .filter(d => existe(path.join(d, 'utilidad')))
  const calif: any[] = []
  const claves: Record<string, string> = {}
  for (const d of raices) {
    execSync(`node_modules/.bin/tsx scripts/exp-otel/calificador/calificar.ts ${path.join(d, 'utilidad')} ${path.join(d, 'fixture.json')}`, { stdio: 'inherit' })
    calif.push(...leer(path.join(d, 'utilidad', 'calificacion.json')))
    for (const f of buscar(path.join(d, 'claves'), p => p.endsWith('.json'))) Object.assign(claves, leer(f))
  }
  const ESPERADO: Record<string, string> = { db_lenta: '7', cpu: '6', externa_lenta: '8' }
  const brazos = [...new Set(calif.map(c => c.brazo))]
  const porBrazo: Record<string, any> = {}
  for (const b of brazos) {
    const cs = calif.filter(c => c.brazo === b)
    const refs = cs.filter(c => c.esReferencia)
    const fallas: Record<string, { reps: number; aciertos: number; respuestas: any[] }> = {}
    for (const c of cs.filter(x => !x.esReferencia)) {
      const f = claves[c.id]
      if (!ESPERADO[f]) continue
      const r = c.respuesta1b
      const acierto = !!r && r.paso === ESPERADO[f] && Math.abs(r.incrementoMs - 800) <= 160 && (f !== 'cpu' || r.tipo === 'ejecutor')
      const x = (fallas[f] ??= { reps: 0, aciertos: 0, respuestas: [] })
      x.reps++
      if (acierto) x.aciertos++
      x.respuestas.push({ rep: c.rep, paso: r?.paso ?? null, incrementoMs: r?.incrementoMs ?? null, tipo: r?.tipo ?? null, acierto })
    }
    const errorRuns = cs.filter(c => claves[c.id] === 'efecto_falla')
    porBrazo[b] = {
      hilo: med(refs.map(r => r.hilo.mediana)),
      hiloEstricto: med(refs.map(r => r.hilo.medianaEstricta)),
      hiloPorRep: refs.map(r => ({ rep: r.rep, porCobro: r.hilo.porCobro, estricto: r.hilo.estrictoPorCobro })),
      enlacesFalsos: refs.reduce((a, r) => a + r.enlacesFalsos, 0),
      duplicados: refs.reduce((a, r) => a + r.duplicados, 0),
      fallas,
      puntos1b: Object.fromEntries(Object.entries(fallas).map(([f, x]) => [f, x.aciertos * 2 > x.reps ? 1 : 0])),
      errorDeEfecto: { corridas: errorRuns.length, conErrorLigado: errorRuns.map(r => `${r.errorDeEfectoLigado}/5`), falsosPositivosEnReferencia: refs.map(r => r.errorDeEfectoLigado) },
      ec1c: errorRuns.length > 0 && errorRuns.filter(r => r.errorDeEfectoLigado > 0).length * 2 > errorRuns.length && refs.every(r => r.errorDeEfectoLigado === 0),
      contextos: refs.map(r => r.contextos).filter(Boolean),
    }
  }
  return { porBrazo, calificacionCruda: calif.length }
}

// ─────────────────────────────── 4 · QUE NO CAMBIE NADA ───────────────────────────────
function suite() {
  const jsons = buscar(RAIZ, p => /suite-(sin|con)-(unit|integracion)\.json$/.test(p))
  const casos: Record<string, Record<string, string>> = { sin: {}, con: {} }
  const totales: Record<string, any> = {}
  for (const f of jsons) {
    const m = path.basename(f).match(/suite-(sin|con)-(unit|integracion)\.json$/)!
    const j = leer(f)
    totales[`${m[1]}-${m[2]}`] = { pasan: j.numPassedTests, fallan: j.numFailedTests, pendientes: j.numPendingTests, total: j.numTotalTests }
    for (const t of j.testResults ?? [])
      for (const a of t.assertionResults ?? []) casos[m[1]][`${m[2]}::${path.relative(process.cwd(), t.name)}::${a.fullName}`] = a.status
  }
  const llaves = new Set([...Object.keys(casos.sin), ...Object.keys(casos.con)])
  const distintos = [...llaves].filter(k => casos.sin[k] !== casos.con[k]).map(k => ({ caso: k, sin: casos.sin[k] ?? 'AUSENTE', con: casos.con[k] ?? 'AUSENTE' }))
  return { totales, casosComparados: llaves.size, distintos: distintos.slice(0, 200), nDistintos: distintos.length }
}

function respuestasIguales() {
  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, /At$|Date$|timestamp|Number$|requestId|correlationId|traceparent|attemptId|transactionId|authorizationNumber|referenceNumber|receiptAccessKey|receiptUrl|accessKey|qr/i.test(k) ? '<v>' : norm(x)]))
    if (typeof v === 'string') return v.replace(/c[a-z0-9]{24}/g, '<id>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<fecha>').replace(/ORD-\d+/g, 'ORD-<n>')
    return v
  }
  const refs = buscar(RAIZ, p => p.endsWith('referencia-cliente.json')).map(p => ({ p, j: leer(p) })).filter(x => x.j.cobros?.[0]?.respuestas)
  const porModo: Record<string, any> = {}
  for (const r of refs) porModo[r.j.modoCliente] ??= norm(r.j.cobros[0].respuestas)
  const a = porModo['ninguna']
  const b = porModo['traceparent']
  if (!a || !b) return { comparado: false }
  const dif: string[] = []
  const recorrer = (x: any, y: any, ruta: string) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) recorrer(x[k], y[k], `${ruta}.${k}`)
      return
    }
    dif.push(`${ruta}: A=${JSON.stringify(x)?.slice(0, 80)} B=${JSON.stringify(y)?.slice(0, 80)}`)
  }
  recorrer(a, b, 'respuestas')
  return { comparado: true, diferencias: dif.slice(0, 50), nDiferencias: dif.length }
}

// ─────────────────────────────── 5 · VOLUMEN Y PRECIO ───────────────────────────────
function volumen() {
  const out: any[] = []
  for (const dir of buscar(RAIZ, p => p.endsWith('llaves.json')).map(p => path.dirname(p))) {
    const llaves = leer(path.join(dir, 'llaves.json'))
    if (llaves.modoCliente !== 'traceparent' || !existe(path.join(dir, 'colector', 'spans.jsonl'))) continue
    const meta = existe(path.join(dir, 'meta.json')) ? leer(path.join(dir, 'meta.json')) : {}
    if (!meta.esReferencia || meta.brazo !== 'B') continue
    const lineas = fs.readFileSync(path.join(dir, 'colector', 'spans.jsonl'), 'utf8').split('\n').filter(Boolean)
    const spans: any[] = []
    for (const l of lineas) for (const rs of JSON.parse(l).resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) spans.push(s)
    const proxy = existe(path.join(dir, 'proxy-otlp.json')) ? (() => { try { return leer(path.join(dir, 'proxy-otlp.json')) } catch { return null } })() : null
    const bytesPorSpan = proxy?.bytes && spans.length ? proxy.bytes / spans.length : NaN
    const claves = new Set((llaves.cobros as any[]).map(c => c.llave))
    const enlazadas = new Set(spans.filter(s => (s.links ?? []).some((k: any) => claves.has(k.traceId))).map(s => s.traceId))
    const delCobro = spans.filter(s => claves.has(s.traceId) || enlazadas.has(s.traceId)).length / claves.size
    const raices = spans.filter(s => !s.parentSpanId && s.kind === 2 && /GET/.test(s.name))
    const trazasLectura = new Set(raices.map(s => s.traceId))
    const porLectura = trazasLectura.size ? spans.filter(s => trazasLectura.has(s.traceId)).length / trazasLectura.size : NaN
    out.push({ dir: path.basename(dir), spansTotales: spans.length, bytesComprimidosTotales: proxy?.bytes ?? null, bytesPorSpan: r1(bytesPorSpan), spansPorCobro: r1(delCobro), spansPorLectura: r1(porLectura) })
  }
  const bps = med(out.map(o => o.bytesPorSpan))
  const spc = med(out.map(o => o.spansPorCobro))
  const spl = med(out.map(o => o.spansPorLectura))
  const gb = (fraccionResto: number) => (VOL_COBROS_MES * spc * bps + VOL_PETICIONES_MES * fraccionResto * spl * bps) / 1e9
  const precio = (g: number) => ({ ingestaEU: r1(g * 0.1), ingestaUS: r1(g * 0.15), retencionMesEU: r1(g * 0.05), retencionMesUS: r1(g * 0.08), libre3GB: g <= 3 })
  return {
    medido: out,
    bytesPorSpanComprimido: r1(bps),
    spansPorCobro: r1(spc),
    spansPorLectura: r1(spl),
    parametros: { VOL_COBROS_MES, VOL_PETICIONES_MES, MUESTREO_RESTO },
    gbMes100: r1(gb(1)),
    gbMesMuestreado: r1(gb(MUESTREO_RESTO)),
    precio100: precio(gb(1)),
    precioMuestreado: precio(gb(MUESTREO_RESTO)),
    fuentePrecio: 'investigacion-en-vivo.md §5 (betterstack.com/pricing): ingesta $0.10/GB EU, $0.15 US; retención $0.05/GB-mes EU, $0.08 US; gratis 3 GB',
  }
}

function main() {
  fs.mkdirSync(RAIZ, { recursive: true })
  const c = costo()
  const k = caido()
  const u = utilidad()
  const s = suite()
  const api = respuestasIguales()
  const v = volumen()
  const tasa = existe('scripts/exp-otel/config/tasa.json') ? leer('scripts/exp-otel/config/tasa.json') : null

  // Criterio (plan + correcciones). Base = A+.
  const B = u.porBrazo['B']
  const Am = u.porBrazo['A+']
  const victorias1b = B && Am ? Object.keys(B.puntos1b).filter(f => B.puntos1b[f] === 1 && Am.puntos1b?.[f] !== 1) : []
  const retrocede1a = B && Am ? B.hilo < Am.hilo : null
  const retrocede1c = B && Am ? Am.ec1c && !B.ec1c : null
  const empata1a = B && Am ? B.hilo === Am.hilo : null
  const empata1c = B && Am ? B.ec1c === Am.ec1c : null
  const ganaUtilidad = B && Am ? !retrocede1a && !retrocede1c && victorias1b.length >= 2 : null
  const cB = c.contraAmas.find(x => x.brazo === 'B')
  const pasa2 = cB ? Object.values(cB.veredictos).every(x => x === 'PASA') : null
  const inconcluso2 = cB ? Object.values(cB.veredictos).some(x => x === 'INCONCLUSO' || x === 'SIN DATOS') : null
  const falla3 = k.veredictos.some(x => x.seCayo || x.p95 === 'FALLA' || String(x.memoriaSinTope).startsWith('POSIBLE'))
  const inconcluso3 = k.veredictos.some(x => x.p95 === 'INCONCLUSO' || x.p95 === 'SIN DATOS')
  const falla4 = s.nDistintos > 0 || (api.comparado && (api as any).nDiferencias > 0)
  let veredicto: string
  if (falla4 || falla3) veredicto = 'DESCARTADO'
  else if (!B || !Am) veredicto = 'INCONCLUSO (faltan datos de utilidad)'
  else if (empata1a && empata1c && victorias1b.length < 2) veredicto = 'NO APORTA: ARREGLA LO NUESTRO (A+)'
  else if (ganaUtilidad && pasa2 === false && !inconcluso2) veredicto = 'PEOR PARA NUESTRA MÁQUINA HOY'
  else if (ganaUtilidad && pasa2 && !inconcluso3 && !falla4) veredicto = 'VALE UN PILOTO'
  else if (ganaUtilidad && (inconcluso2 || inconcluso3)) veredicto = 'INCONCLUSO (B gana en utilidad; el costo o C quedan dentro del ruido)'
  else veredicto = 'MIXTO'

  const resumen = {
    fecha: new Date().toISOString(),
    tasaCongelada: tasa,
    veredicto,
    criterio: { victorias1bIncrementalesSobreAmas: victorias1b, retrocede1a, retrocede1c, empata1a, empata1c, ganaUtilidad, pasa2, inconcluso2, falla3, inconcluso3, falla4 },
    utilidad: u,
    costo: c,
    colectorCaido: k,
    suite: s,
    respuestasApi: api,
    volumen: v,
  }
  fs.writeFileSync(path.join(RAIZ, 'resumen.json'), JSON.stringify(resumen, null, 2))

  const L: string[] = []
  L.push(`# Experimento OTel vs correlationId — resultados`, '', `**Veredicto según el criterio del plan: ${veredicto}**`, '')
  L.push(`Tasa congelada (calibrada en A+ al ~50 % de 1 CPU): ${tasa ? `${tasa.cobrosPorSegundo} cobros/s` : '¿?'}`, '')
  L.push('## 1. Utilidad (calificador ciego)', '', '| brazo | hilo 1a (mediana, con enlaces) | hilo estricto | enlaces falsos | duplicados | 1b db_lenta | 1b cpu | 1b externa (sintética) | 1c |', '|---|---|---|---|---|---|---|---|---|')
  for (const [b, x] of Object.entries(u.porBrazo) as any)
    L.push(`| ${b} | ${x.hilo}/8 | ${x.hiloEstricto}/8 | ${x.enlacesFalsos} | ${x.duplicados} | ${x.puntos1b.db_lenta ?? '—'} | ${x.puntos1b.cpu ?? '—'} | ${x.puntos1b.externa_lenta ?? '—'} | ${x.ec1c ? 'sí' : 'no'} |`)
  L.push('', `Victorias incrementales de B sobre A+ en 1b: ${victorias1b.join(', ') || 'ninguna'}`, '')
  L.push('## 2. Costo (vs A+, diferencias pareadas por repetición)', '', '| brazo | Δp95 ms | ΔCPU/petición % | ΔRSS pico MB | Δarranque s | p95 | CPU | RSS | arranque |', '|---|---|---|---|---|---|---|---|---|')
  for (const x of c.contraAmas) L.push(`| ${x.brazo} | ${x.dp95Ms.join(' / ')} | ${x.dCpuPorPeticionPct.join(' / ')} | ${x.dRssPicoMB.join(' / ')} | ${x.dArranqueS.join(' / ')} | ${x.veredictos.p95} | ${x.veredictos.cpuPorPeticion} | ${x.veredictos.rssPico} | ${x.veredictos.arranque} |`)
  L.push('', '## 3. Colector caído (C vs B)', '', '| variante | p95 (+20 % máx) | se cayó | memoria | Δp95 % por rep |', '|---|---|---|---|---|')
  for (const x of k.veredictos) L.push(`| ${x.variante} | ${x.p95} | ${x.seCayo ? 'SÍ' : 'no'} | ${x.memoriaSinTope} | ${k.filas.filter(f => f.variante === x.variante).map(f => f.dp95Pct).join(' / ')} |`)
  L.push('', '## 4. Que no cambie nada', '', `Suite (mismo commit, con y sin SDK): ${s.casosComparados} casos comparados, ${s.nDistintos} distintos. Totales: ${JSON.stringify(s.totales)}`, `Respuestas de la API A vs B (normalizadas): ${api.comparado ? `${(api as any).nDiferencias} diferencias` : 'no comparado'}`, '')
  L.push('## 5. Volumen y precio', '', `Spans por cobro: ${v.spansPorCobro} · por lectura: ${v.spansPorLectura} · bytes comprimidos por span: ${v.bytesPorSpanComprimido}`, `Con ${VOL_COBROS_MES} cobros/mes y ${VOL_PETICIONES_MES} peticiones/mes (PARÁMETROS, no medidos): ${v.gbMes100} GB/mes al 100 %; ${v.gbMesMuestreado} GB/mes con 100 % de cobros y ${MUESTREO_RESTO * 100} % del resto. Precio: ${JSON.stringify(v.precioMuestreado)} (${v.fuentePrecio})`, '')
  fs.writeFileSync(path.join(RAIZ, 'resumen.md'), L.join('\n'))
  console.log(L.join('\n'))
}

main()
