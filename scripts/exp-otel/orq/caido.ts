/**
 * EXPERIMENTO OTel — brazo C: COLECTOR / DESTINO CAÍDO (plan 3; corrección 11). En el runner. VARIANTE=… REP=n.
 *
 *   puerto_muerto  el SDK apunta a un puerto donde nadie escucha (conexión rechazada)
 *   sin_respuesta  el proxy acepta la conexión y nunca contesta
 *   rechazo        el proxy contesta 503
 *   lento          el proxy tarda 5 s en reenviar
 *   recuperacion   sin_respuesta la primera mitad y normal la segunda
 *   destino_caido  colector VIVO cuyo exportador apunta a un destino inexistente
 *
 * En el MISMO job, en orden aleatorio reproducible: B (colector sano) y C, cada uno 10 min a la tasa congelada.
 * Mide latencia, memoria (y su pendiente), errores/caídas, ruido en el log y los contadores del SDK
 * (terminados / exportados / fallidos / descartados / cola pendiente máxima). Después, la SUB-PRUEBA DE APAGADO
 * (B y C): arranque con `node` DIRECTO (no `npm start`, que no deja terminar el gracefulShutdown: hallazgo a verificar),
 * 45 s de carga, SIGTERM, y cuánto se exportó vs. cuánto se perdió al salir.
 */
import fs from 'node:fs'
import path from 'node:path'
import { OUT, SRV, Brazo, COMANDO_NODE_DIRECTO, REPO, barajar, correrActoresAsync, enLaRed, escribirJson, log, muestrear, sleep } from '../lib/comun'
import { bajar, entornoActores, levantar, prepararBase, OpcionesDeLevantar } from './base'

const VARIANTE = process.env.VARIANTE || 'puerto_muerto'
const REP = Number(process.env.REP || 1)
const CORTO = process.env.CORTO === '1'
const SOSTENIDA_S = CORTO ? 60 : 600

function opcionesC(): OpcionesDeLevantar {
  switch (VARIANTE) {
    case 'puerto_muerto':
      return { extra: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://servicios:4999' } }
    case 'sin_respuesta':
    case 'recuperacion':
      return { modoProxy: 'sin_respuesta' }
    case 'rechazo':
      return { modoProxy: 'rechazo' }
    case 'lento':
      return { modoProxy: 'lento' }
    case 'destino_caido':
      return { colectorConfig: `${REPO}/scripts/exp-otel/otel/colector-destino-caido.yaml` }
    default:
      throw new Error(`variante desconocida ${VARIANTE}`)
  }
}

async function bloque(cual: 'B' | 'C', etiqueta: string, tasa: number, apagado: boolean) {
  const dir = path.join(OUT, 'caido', etiqueta)
  const op: OpcionesDeLevantar = cual === 'C' ? opcionesC() : {}
  if (apagado) op.comando = COMANDO_NODE_DIRECTO
  const brazo: Brazo = 'B'
  const l = await levantar(brazo, etiqueta, dir, op)
  const m = muestrear(SRV, 2000)
  const ventanas = apagado
    ? [{ nombre: 'apagado', tasa, duracionS: 45 }]
    : [
        { nombre: 'calentamiento', tasa, duracionS: CORTO ? 15 : 60 },
        { nombre: 'sostenida', tasa, duracionS: SOSTENIDA_S, alinearSegundo: 20 },
      ]
  // recuperación: a la mitad de la ventana sostenida el destino vuelve
  let cambio: Promise<void> | null = null
  if (cual === 'C' && VARIANTE === 'recuperacion' && !apagado) {
    cambio = (async () => {
      const marca = path.join(dir, 'ventana-sostenida.inicio.json')
      while (!fs.existsSync(marca)) await sleep(1000)
      const ini = JSON.parse(fs.readFileSync(marca, 'utf8')).inicio
      await sleep(Math.max(0, ini + (SOSTENIDA_S * 1000) / 2 - Date.now()))
      enLaRed(`-s -X POST http://servicios:9099/modo/reenviar`)
      fs.writeFileSync(path.join(dir, 'recuperacion.json'), JSON.stringify({ vuelveEn: Date.now() }))
      log('recuperación: el destino vuelve')
    })()
  }
  const codigo = await correrActoresAsync('scripts/exp-otel/actores/carga.ts', entornoActores(l, { VENTANAS: JSON.stringify(ventanas), REPOSO_S: '10', SALIDA: 'carga.json', N_TPV: '40' }))
  await cambio
  m.parar()
  const fin = await bajar(l)
  fs.writeFileSync(path.join(dir, 'muestras-cgroup.json'), JSON.stringify(m.muestras))
  const r = { cual, variante: cual === 'C' ? VARIANTE : null, rep: REP, apagadoDirecto: apagado, codigoActores: codigo, ...fin }
  escribirJson(`caido/${etiqueta}/bloque.json`, r)
  return r
}

async function main() {
  await prepararBase()
  const tasa = JSON.parse(fs.readFileSync('scripts/exp-otel/config/tasa.json', 'utf8')).cobrosPorSegundo
  const orden = barajar<'B' | 'C'>(['B', 'C'], REP * 104729 + VARIANTE.length)
  log(`C ${VARIANTE} rep ${REP}: orden ${orden.join(' → ')}`)
  const res = []
  for (const c of orden) res.push(await bloque(c, `${VARIANTE}-r${REP}-${c}`, tasa, false))
  for (const c of orden) res.push(await bloque(c, `${VARIANTE}-r${REP}-${c}-apagado`, tasa, true))
  escribirJson(`caido-${VARIANTE}-rep${REP}.json`, { variante: VARIANTE, rep: REP, orden, tasa, bloques: res })
}

main().catch(e => {
  console.error('❌ caido:', e)
  process.exit(1)
})
