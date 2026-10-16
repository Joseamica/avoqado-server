/**
 * MEJORAS DE LO NUESTRO · 4 — ¿Node 24 gasta más memoria/CPU o es más lento que Node 20? (en el runner)
 *
 * Sólo el brazo A (el server tal cual: sin OTel, sin A+). En UN mismo job (mismo runner ⇒ diferencias PAREADAS) corren
 * las dos versiones, en orden alternado por repetición (impar 20→24, par 24→20):
 *   - árbol compilado con `npm ci && npm run build` EN ESA versión (WS_V20 / WS_V24) e imagen node:<v>-bookworm del
 *     server, con --cpus=1 --memory=2g; Postgres, actores y generador IDÉNTICOS (los de Node 20, del árbol v20);
 *   - bloque HUMO (server y base nuevos): el cobro congelado 5 veces, verificado en Postgres;
 *   - bloque CARGA (server y base nuevos): reposo 20 s, baja 1 cobro/s 120 s, calentamiento 60 s y alta a la tasa
 *     CONGELADA de 2.75 cobros/s (scripts/exp-otel/config/tasa.json) 180 s, con CPU/memoria del cgroup y event loop.
 * Criterio fijado ANTES de medir: scripts/exp-otel/config/criterio-node24.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import { OUT, SRV, correrActoresAsync, cpuEntre, escribirJson, log, mediana, muestrear } from '../lib/comun'
import { bajar, entornoActores, levantar, prepararBase } from './base'

const REP = Number(process.env.REP || 1)
const ARBOL: Record<string, string> = { '20': process.env.WS_V20!, '24': process.env.WS_V24! }

function medicion(archivo: string) {
  if (!fs.existsSync(archivo)) return []
  return fs
    .readFileSync(archivo, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean) as Array<{ t: number; p99: number; rss: number }>
}

function erroresDelLog(archivo: string) {
  if (!fs.existsSync(archivo)) return { lineas: 0, mensajes: [] as string[] }
  const msgs = new Set<string>()
  let n = 0
  for (const l of fs.readFileSync(archivo, 'utf8').split('\n')) {
    if (!l.includes('"level":"error"')) continue
    n++
    try {
      msgs.add(String(JSON.parse(l).message).slice(0, 120))
    } catch {
      msgs.add(l.slice(0, 120))
    }
  }
  return { lineas: n, mensajes: [...msgs] }
}

async function version(v: string) {
  const servidor = { imagen: `node:${v}-bookworm`, repo: ARBOL[v] }
  const nodeBuild = fs.readFileSync(path.join(ARBOL[v], 'node-build.txt'), 'utf8').trim()

  // HUMO
  const dirH = path.join(OUT, 'node24', `r${REP}-node${v}-humo`)
  const lh = await levantar('A', `n${v}h${REP}`, dirH, { servidor })
  const codH = await correrActoresAsync('scripts/exp-otel/actores/humo.ts', entornoActores(lh, { N_COBROS: '5', BRAZO: `node${v}`, N_TPV: '3' }))
  await bajar(lh)
  const humo = fs.existsSync(path.join(dirH, `humo-node${v}.json`)) ? JSON.parse(fs.readFileSync(path.join(dirH, `humo-node${v}.json`), 'utf8')) : null

  // CARGA
  const tasa = JSON.parse(fs.readFileSync('scripts/exp-otel/config/tasa.json', 'utf8')).cobrosPorSegundo
  const dirC = path.join(OUT, 'node24', `r${REP}-node${v}-carga`)
  const lc = await levantar('A', `n${v}c${REP}`, dirC, { servidor })
  const nodeServer = JSON.parse(fs.readFileSync(path.join(dirC, 'entorno.json'), 'utf8')).nodeDelServer
  const m = muestrear(SRV, 2000)
  const ventanas = [
    { nombre: 'baja', tasa: 1, duracionS: 120, medirDone: true, alinearSegundo: 20 },
    { nombre: 'calentamiento', tasa, duracionS: 60 },
    { nombre: 'alta', tasa, duracionS: 180, alinearSegundo: 20 },
  ]
  const codC = await correrActoresAsync('scripts/exp-otel/actores/carga.ts', entornoActores(lc, { VENTANAS: JSON.stringify(ventanas), REPOSO_S: '20', SALIDA: 'carga.json', N_TPV: '40' }))
  m.parar()
  const fin = await bajar(lc)
  const carga = fs.existsSync(path.join(dirC, 'carga.json')) ? JSON.parse(fs.readFileSync(path.join(dirC, 'carga.json'), 'utf8')) : null
  const med = medicion(path.join(dirC, 'medicion.jsonl'))
  const ventana = (nombre: string) => {
    const w = carga?.ventanas?.find((x: any) => x.nombre === nombre)
    if (!w) return null
    const cpu = cpuEntre(m.muestras, w.inicio, w.fin)
    const dentro = med.filter(x => x.t >= w.inicio && x.t <= w.fin + 5000)
    const todas = Object.values(w.porEtiqueta ?? {}).flatMap((e: any) => e.ms ?? [])
    return {
      cpuFraccion: cpu.fraccion,
      cpuMsPor1000Peticiones: w.peticionesHttp ? (cpu.cpuMs / w.peticionesHttp) * 1000 : NaN,
      peticionesHttp: w.peticionesHttp,
      msTodas: todas,
      rssPicoMB: dentro.length ? Math.max(...dentro.map(x => x.rss)) / 2 ** 20 : NaN,
      eventLoopP99: mediana(dentro.map(x => x.p99)),
      errores: Object.values(w.porEtiqueta ?? {}).reduce((a: number, e: any) => a + (e.errores ?? 0), 0),
      no2xx: Object.values(w.porEtiqueta ?? {}).reduce((a: number, e: any) => a + (e.no2xx ?? 0), 0),
      cobros: w.cobros,
      efectosPendientesAlFinal: w.efectosPendientesAlFinal,
    }
  }
  const reposo = carga?.reposo ? med.filter(x => x.t >= carga.reposo.inicio && x.t <= carga.reposo.fin) : []
  return {
    version: v,
    nodeBuild,
    nodeServerHumo: JSON.parse(fs.readFileSync(path.join(dirH, 'entorno.json'), 'utf8')).nodeDelServer,
    nodeServer,
    humo: { codigo: codH, exitosos: humo?.exitosos ?? 0, n: humo?.n ?? 5, listoMs: humo?.listoMs ?? null, erroresLog: erroresDelLog(path.join(dirH, 'servidor.log')) },
    carga: {
      codigo: codC,
      listoMs: carga?.listoMs ?? null,
      rssReposoMB: reposo.length ? mediana(reposo.map(x => x.rss)) / 2 ** 20 : NaN,
      alta: ventana('alta'),
      baja: ventana('baja'),
      apagado: fin,
      erroresLog: erroresDelLog(path.join(dirC, 'servidor.log')),
    },
  }
}

async function main() {
  await prepararBase()
  const orden = REP % 2 === 1 ? ['20', '24'] : ['24', '20']
  log(`node24 rep ${REP}: orden ${orden.join(' → ')}`)
  const res = []
  for (const v of orden) res.push(await version(v))
  escribirJson(`node24-rep${REP}.json`, { rep: REP, orden, versiones: res })
}

main().catch(e => {
  console.error('❌ node24:', e)
  process.exit(1)
})
