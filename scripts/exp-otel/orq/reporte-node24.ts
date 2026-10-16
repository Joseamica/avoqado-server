/**
 * MEJORAS DE LO NUESTRO · 4 — reporte Node 24 vs Node 20 con el criterio de scripts/exp-otel/config/criterio-node24.md
 * (fijado antes de medir). Uso: tsx reporte-node24.ts <carpeta-con-artefactos> → node24.json y node24.md ahí.
 */
import fs from 'node:fs'
import path from 'node:path'

const RAIZ = process.argv[2] || 'exp-all'
const buscar = (d: string, out: string[] = []): string[] => {
  if (!fs.existsSync(d)) return out
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f)
    if (fs.statSync(p).isDirectory()) buscar(p, out)
    else if (/node24-rep\d+\.json$/.test(f)) out.push(p)
  }
  return out
}
const pct = (xs: number[], p: number) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] : NaN
}
const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null)

const reps = buscar(RAIZ)
  .map(p => JSON.parse(fs.readFileSync(p, 'utf8')))
  .sort((a, b) => a.rep - b.rep)

const filas = reps.map(r => {
  const v20 = r.versiones.find((v: any) => v.version === '20')
  const v24 = r.versiones.find((v: any) => v.version === '24')
  const m = (v: any) => ({
    p50: pct(v.carga.alta?.msTodas ?? [], 50),
    p95: pct(v.carga.alta?.msTodas ?? [], 95),
    p99: pct(v.carga.alta?.msTodas ?? [], 99),
    p95baja: pct(v.carga.baja?.msTodas ?? [], 95),
    cpuPor1000: v.carga.alta?.cpuMsPor1000Peticiones,
    cpuFraccion: v.carga.alta?.cpuFraccion,
    rssPico: v.carga.alta?.rssPicoMB,
    rssReposo: v.carga.rssReposoMB,
    elp99: v.carga.alta?.eventLoopP99,
    arranqueS: ((v.humo.listoMs ?? NaN) + (v.carga.listoMs ?? NaN)) / 2 / 1000,
    humo: `${v.humo.exitosos}/${v.humo.n}`,
    erroresHttp: (v.carga.alta?.errores ?? 0) + (v.carga.baja?.errores ?? 0),
    mensajesError: [...new Set([...(v.humo.erroresLog?.mensajes ?? []), ...(v.carga.erroresLog?.mensajes ?? [])])],
    cobrosAlta: `${v.carga.alta?.cobros?.ok}/${v.carga.alta?.cobros?.iniciados}`,
    node: `server ${v.nodeServer} (humo ${v.nodeServerHumo}) · build ${v.nodeBuild}`,
  })
  return { rep: r.rep, orden: r.orden.join('→'), a: m(v20), b: m(v24) }
})

const d = (k: string, rel = false) => filas.map(f => (rel ? (f.b as any)[k] / (f.a as any)[k] - 1 : (f.b as any)[k] - (f.a as any)[k]))
function evaluar(ds: number[], umbral: (i: number) => number) {
  if (!ds.length || ds.some(x => !Number.isFinite(x))) return { veredicto: 'SIN DATOS', tendencia: '—' }
  const ok = ds.map((x, i) => x <= umbral(i))
  const veredicto = ok.every(Boolean) ? 'PASA' : ok.every(x => !x) ? 'FALLA' : 'INCONCLUSO'
  const tendencia = ds.every(x => x < 0) ? 'MEJORA' : ds.every(x => x > 0) ? 'EMPEORA' : 'sin tendencia'
  return { veredicto, tendencia }
}
const metricas = {
  p95: { d: d('p95').map(r1), ...evaluar(d('p95'), i => Math.min(0.05 * filas[i].a.p95, 10)) },
  cpuPorPeticionPct: { d: d('cpuPor1000', true).map(x => r1(x * 100)), ...evaluar(d('cpuPor1000', true), () => 0.1) },
  rssPicoMB: { d: d('rssPico').map(r1), ...evaluar(d('rssPico'), () => 30) },
  arranqueS: { d: d('arranqueS').map(r1), ...evaluar(d('arranqueS'), () => 3) },
}
const humoOk = filas.every(f => f.a.humo === '5/5' && f.b.humo === '5/5')
const erroresHttpNuevos = filas.reduce((a, f) => a + Math.max(0, f.b.erroresHttp - f.a.erroresHttp), 0)
const mensajes20 = new Set(filas.flatMap(f => f.a.mensajesError))
const mensajesNuevos = [...new Set(filas.flatMap(f => f.b.mensajesError))].filter(x => !mensajes20.has(x))
const vs = Object.values(metricas)
let veredicto: string
if (vs.some(m => m.veredicto === 'FALLA') || !humoOk || erroresHttpNuevos > 0 || mensajesNuevos.length > 0) veredicto = 'NO ACEPTABLE'
else if (vs.some(m => m.veredicto !== 'PASA')) veredicto = `INCONCLUSO (${Object.entries(metricas).filter(([, m]) => m.veredicto !== 'PASA').map(([k]) => k).join(', ')})`
else if (vs.some(m => m.tendencia === 'MEJORA') && !vs.some(m => m.tendencia === 'EMPEORA')) veredicto = 'MEJOR'
else veredicto = 'ACEPTABLE'

const salida = { veredicto, metricas, humoOk, erroresHttpNuevos, mensajesNuevos, filas: filas.map(f => ({ ...f, a: { ...f.a }, b: { ...f.b } })) }
fs.mkdirSync(RAIZ, { recursive: true })
fs.writeFileSync(path.join(RAIZ, 'node24.json'), JSON.stringify(salida, null, 2))

const L: string[] = []
L.push(`**Veredicto (criterio fijado antes de medir): ${veredicto}**`, '')
L.push('| métrica (24 − 20, por repetición) | diferencias | umbral | veredicto | tendencia |', '|---|---|---|---|---|')
L.push(`| p95 ventana alta (ms) | ${metricas.p95.d.join(' / ')} | ≤ mín(5 %, 10 ms) | ${metricas.p95.veredicto} | ${metricas.p95.tendencia} |`)
L.push(`| CPU por petición (%) | ${metricas.cpuPorPeticionPct.d.join(' / ')} | ≤ +10 % | ${metricas.cpuPorPeticionPct.veredicto} | ${metricas.cpuPorPeticionPct.tendencia} |`)
L.push(`| RSS pico (MB) | ${metricas.rssPicoMB.d.join(' / ')} | ≤ +30 MB | ${metricas.rssPicoMB.veredicto} | ${metricas.rssPicoMB.tendencia} |`)
L.push(`| arranque (s) | ${metricas.arranqueS.d.join(' / ')} | ≤ +3 s | ${metricas.arranqueS.veredicto} | ${metricas.arranqueS.tendencia} |`)
L.push('', `Humo 5/5 en las dos versiones en todas las repeticiones: ${humoOk ? 'sí' : 'NO'} · errores HTTP nuevos: ${erroresHttpNuevos} · mensajes de error nuevos en el log: ${mensajesNuevos.length ? mensajesNuevos.join(' | ') : 'ninguno'}`, '')
L.push('| rep | orden | versión | p50 / p95 / p99 alta (ms) | p95 baja (ms) | CPU alta | CPU ms/1000 pet. | RSS reposo / pico (MB) | event loop p99 (ms) | arranque (s) | humo | cobros alta | Node |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const f of filas)
  for (const [v, x] of [['20', f.a], ['24', f.b]] as const)
    L.push(`| ${f.rep} | ${f.orden} | ${v} | ${r1(x.p50)} / ${r1(x.p95)} / ${r1(x.p99)} | ${r1(x.p95baja)} | ${r1(x.cpuFraccion * 100)} % | ${r1(x.cpuPor1000)} | ${r1(x.rssReposo)} / ${r1(x.rssPico)} | ${r1(x.elp99)} | ${r1(x.arranqueS)} | ${x.humo} | ${x.cobrosAlta} | ${x.node} |`)
fs.writeFileSync(path.join(RAIZ, 'node24.md'), L.join('\n'))
console.log(L.join('\n'))
