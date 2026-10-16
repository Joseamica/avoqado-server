/**
 * EXPERIMENTO OTel — COSTO DE CORRER (plan 2; correcciones 9 y 10). En el runner.
 *
 *   MODO=calibrar  sólo A+: escalera de tasas, CPU del server por escalón, y la tasa que deja ~50 % de 1 CPU
 *                  (regla preregistrada por el coordinador). Escribe exp-out/calibracion.json. La tasa se CONGELA a mano
 *                  en scripts/exp-otel/config/tasa.json ANTES de medir los demás brazos.
 *   MODO=medir     REP=n: los brazos A, A+, B, B0, B−P en orden ALEATORIO reproducible (semilla = REP) dentro del
 *                  MISMO job. Por brazo: base restaurada, server nuevo con `npm start`, reposo 20 s, calentamiento 60 s,
 *                  ventana ALTA (tasa congelada, 180 s, alineada al segundo :20 del minuto) y ventana BAJA
 *                  (1 cobro/s, 120 s, con «hasta DONE»). El server vive en su cgroup de 1 CPU / 2 GB; Postgres, el
 *                  colector y el generador quedan fuera de esa cuota.
 */
import fs from 'node:fs'
import path from 'node:path'
import { OUT, SRV, Brazo, barajar, correrActoresAsync, cpuEntre, escribirJson, log, muestrear, mediana } from '../lib/comun'
import { bajar, entornoActores, levantar, prepararBase } from './base'

const MODO = process.env.MODO || 'medir'
const REP = Number(process.env.REP || 1)
const CORTO = process.env.CORTO === '1'

function leerMedicion(archivo: string): Array<{ t: number; p50: number; p99: number; max: number; rss: number; heap: number }> {
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
    .filter(Boolean)
}

async function bloque(brazo: Brazo, etiqueta: string, ventanas: unknown[], reposoS: number) {
  const dir = path.join(OUT, 'costo', etiqueta)
  const l = await levantar(brazo, etiqueta, dir)
  const m = muestrear(SRV, 2000)
  const codigo = await correrActoresAsync('scripts/exp-otel/actores/carga.ts', entornoActores(l, { VENTANAS: JSON.stringify(ventanas), REPOSO_S: String(reposoS), SALIDA: 'carga.json' }))
  m.parar()
  const fin = await bajar(l)
  fs.writeFileSync(path.join(dir, 'muestras-cgroup.json'), JSON.stringify(m.muestras))
  if (codigo !== 0) log(`⚠️ actores de ${etiqueta} salieron con ${codigo}`)
  const carga = fs.existsSync(path.join(dir, 'carga.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'carga.json'), 'utf8')) : null
  const med = leerMedicion(path.join(dir, 'medicion.jsonl'))
  const resumenVentanas = (carga?.ventanas ?? []).map((v: any) => {
    const cpu = cpuEntre(m.muestras, v.inicio, v.fin)
    const dentro = med.filter(x => x.t >= v.inicio && x.t <= v.fin + 5000)
    return {
      nombre: v.nombre,
      tasa: v.tasa,
      cpuFraccion: cpu.fraccion,
      cpuMsPor1000Peticiones: v.peticionesHttp ? (cpu.cpuMs / v.peticionesHttp) * 1000 : NaN,
      peticionesHttp: v.peticionesHttp,
      rssPicoMB: dentro.length ? Math.max(...dentro.map(x => x.rss)) / 2 ** 20 : NaN,
      memCgroupPicoMB: Math.max(...m.muestras.filter(x => x.t >= v.inicio && x.t <= v.fin).map(x => x.memCgroup)) / 2 ** 20,
      eventLoopP99Mediana: mediana(dentro.map(x => x.p99)),
      eventLoopP99Max: dentro.length ? Math.max(...dentro.map(x => x.p99)) : NaN,
      porEtiqueta: v.porEtiqueta,
      cobros: v.cobros,
      sinTerminal: v.sinTerminal,
      efectosPendientesAlFinal: v.efectosPendientesAlFinal,
      done: v.done,
    }
  })
  const reposo = carga?.reposo ? med.filter(x => x.t >= carga.reposo.inicio && x.t <= carga.reposo.fin) : []
  const r = {
    brazo,
    etiqueta,
    rep: REP,
    codigoActores: codigo,
    listoMs: carga?.listoMs ?? null,
    modoTokenPos: carga?.modoTokenPos,
    paridadDelTokenTpv: carga?.paridadDelTokenTpv,
    rssReposoMB: reposo.length ? mediana(reposo.map(x => x.rss)) / 2 ** 20 : NaN,
    apagado: fin,
    ventanas: resumenVentanas,
  }
  escribirJson(`costo/${etiqueta}/resumen.json`, r)
  return r
}

async function main() {
  await prepararBase()
  if (MODO === 'calibrar') {
    const tasas = CORTO ? [1, 3] : [1, 2, 3, 4, 6, 8]
    const ventanas = [{ nombre: 'calentamiento', tasa: 1, duracionS: CORTO ? 20 : 45 }, ...tasas.map(t => ({ nombre: `t${t}`, tasa: t, duracionS: CORTO ? 30 : 60 }))]
    const r = await bloque('A+', 'calibracion', ventanas, 0)
    const escalones = r.ventanas.filter((v: any) => v.nombre !== 'calentamiento').map((v: any) => ({ tasa: v.tasa, cpu: v.cpuFraccion, cobrosOk: v.cobros?.ok, iniciados: v.cobros?.iniciados }))
    // interpolación lineal al 50 % de 1 CPU
    let tasa50: number | null = null
    for (let i = 1; i < escalones.length; i++) {
      const a = escalones[i - 1]
      const b = escalones[i]
      if (a.cpu <= 0.5 && b.cpu >= 0.5) tasa50 = a.tasa + ((0.5 - a.cpu) * (b.tasa - a.tasa)) / (b.cpu - a.cpu)
    }
    escribirJson('calibracion.json', { regla: 'tasa abierta que deja el CPU del server (cgroup) cerca del 50 % de 1 CPU, medida en A+', escalones, tasa50 })
    log('calibración:', JSON.stringify({ escalones, tasa50 }))
    return
  }
  const tasa = JSON.parse(fs.readFileSync('scripts/exp-otel/config/tasa.json', 'utf8')).cobrosPorSegundo
  const brazos: Brazo[] = barajar(['A', 'A+', 'B', 'B0', 'BmP'], REP * 7919)
  log(`rep ${REP}: orden de brazos ${brazos.join(' → ')} · tasa congelada ${tasa}/s`)
  const ventanas = [
    { nombre: 'calentamiento', tasa, duracionS: CORTO ? 15 : 60 },
    { nombre: 'alta', tasa, duracionS: CORTO ? 40 : 180, alinearSegundo: 20 },
    { nombre: 'baja', tasa: 1, duracionS: CORTO ? 30 : 120, medirDone: true, alinearSegundo: 20 },
  ]
  const res = []
  for (const b of brazos) res.push(await bloque(b, `r${REP}-${b}`, ventanas, 20))
  escribirJson(`costo-rep${REP}.json`, { rep: REP, orden: brazos, tasa, bloques: res })
}

main().catch(e => {
  console.error('❌ costo:', e)
  process.exit(1)
})
