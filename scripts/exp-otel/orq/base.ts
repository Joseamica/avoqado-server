/**
 * EXPERIMENTO OTel — piezas comunes de los orquestadores de la fase 2 (en el runner).
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  OUT,
  SRV,
  SERVICIOS,
  COLECTOR,
  Brazo,
  arrancarPostgres,
  arrancarServer,
  arrancarServiciosOtel,
  arrancarServiciosSolos,
  clienteDe,
  clonarBase,
  corriendo,
  detenerServiciosOtel,
  entornoDelBrazo,
  entornoDelServer,
  leerEnContenedor,
  log,
  logsDe,
  psql,
  redInterna,
  sh,
  sleep,
  urlHost,
  urlRed,
  SECRETOS,
  verificarSinSalida,
  REPO,
  ServidorNode,
} from '../lib/comun'

export const PLANTILLA = 'exp_plantilla'

/** Red, Postgres, migraciones y fixture en una plantilla. Devuelve la ruta del fixture. */
export async function prepararBase(): Promise<string> {
  fs.mkdirSync(OUT, { recursive: true })
  redInterna()
  await arrancarPostgres()
  psql('postgres', `CREATE DATABASE ${PLANTILLA}`)
  sh(`npx prisma migrate deploy`, { env: { DATABASE_URL: urlHost(PLANTILLA), USE_RENDER_DB: 'false' } })
  const fixture = sh(`node_modules/.bin/tsx scripts/exp-otel/fixture/sembrar.ts`, { env: { DATABASE_URL: urlHost(PLANTILLA) } })
  const ruta = path.join(OUT, 'fixture.json')
  fs.writeFileSync(ruta, fixture)
  return ruta
}

export interface Levantado {
  brazo: Brazo
  db: string
  t0: number
  dirSalida: string
  conOtel: boolean
}

export interface OpcionesDeLevantar {
  extra?: Record<string, string>
  comando?: string
  colectorConfig?: string
  modoProxy?: string
  /** brazos A/A+ con la falla (ii): sólo el externo falso */
  conExternoFalso?: boolean
  /** imagen de Node y árbol compilado del server (comparación Node 20 vs 24); por defecto, el de siempre */
  servidor?: ServidorNode
}

/** Base nueva (clon de la plantilla), servicios OTel si el brazo los usa, y el server con su entorno. */
export async function levantar(brazo: Brazo, etiqueta: string, dirSalida: string, op: OpcionesDeLevantar = {}): Promise<Levantado> {
  fs.mkdirSync(dirSalida, { recursive: true })
  const db = `c_${etiqueta.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`.slice(0, 60)
  clonarBase(PLANTILLA, db)
  const conOtel = brazo !== 'A' && brazo !== 'A+'
  if (conOtel) arrancarServiciosOtel(path.join(dirSalida, 'colector'), { colectorConfig: op.colectorConfig, modoProxy: op.modoProxy })
  else if (op.conExternoFalso) arrancarServiciosSolos()
  else detenerServiciosOtel()
  await sleep(conOtel || op.conExternoFalso ? 3000 : 0)
  const env = entornoDelServer(db, entornoDelBrazo(brazo, op.extra))
  // la precarga de medición se toma del árbol que corre el server (el otro no está montado en su contenedor)
  if (op.servidor && env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.split(REPO).join(op.servidor.repo)
  const t0 = Date.now()
  arrancarServer(SRV, env, op.comando, op.servidor)
  await sleep(2000)
  if (!corriendo(SRV)) throw new Error(`el server (${brazo}) murió al arrancar:\n${logsDe(SRV).slice(-5000)}`)
  fs.writeFileSync(
    path.join(dirSalida, 'entorno.json'),
    JSON.stringify(
      {
        brazo,
        comando: op.comando ?? 'npm start',
        imagenServer: op.servidor?.imagen ?? 'node:20-bookworm',
        nodeDelServer: sh(`docker exec ${SRV} node -v`, { quiet: true, allowFail: true }),
        variables: Object.keys(env).filter(k => k !== 'EXP_INYECTOR').sort(),
        // EXP_INYECTOR NO se escribe aquí: el calificador ciego no debe poder saber qué falla se sembró.
        otel: Object.fromEntries(Object.entries(env).filter(([k]) => (k.startsWith('OTEL_') || k.startsWith('EXP_')) && k !== 'EXP_INYECTOR')),
        salidaAInternet: verificarSinSalida(SRV),
      },
      null,
      2,
    ),
  )
  return { brazo, db, t0, dirSalida, conOtel }
}

/** Entorno para el contenedor de actores. */
export function entornoActores(l: Levantado, extra: Record<string, string> = {}): Record<string, string> {
  return {
    SERVER_URL: 'http://srv:3000',
    DATABASE_URL: urlRed(l.db),
    ACCESS_TOKEN_SECRET: SECRETOS.ACCESS_TOKEN_SECRET,
    FIXTURE: path.join(OUT, 'fixture.json'),
    OUT_DIR: l.dirSalida,
    MODO_CLIENTE: clienteDe(l.brazo),
    SERVER_T0_MS: String(l.t0),
    ...extra,
  }
}

/** Baja el server (SIGTERM) y guarda TODO lo crudo: log, medición del event loop, contadores OTel, spans. */
export async function bajar(l: Levantado): Promise<{ vivoAlFinal: boolean; codigoDeSalida: number; msHastaSalir: number }> {
  const vivoAlFinal = corriendo(SRV)
  fs.writeFileSync(path.join(l.dirSalida, 'medicion.jsonl'), leerEnContenedor(SRV, '/tmp/exp-medicion.jsonl'))
  if (l.conOtel) fs.writeFileSync(path.join(l.dirSalida, 'contadores-otel-antes.json'), leerEnContenedor(SRV, '/tmp/exp-otel-contadores.json'))
  const t = Date.now()
  sh(`docker stop -t 40 ${SRV}`, { quiet: true, allowFail: true })
  const msHastaSalir = Date.now() - t
  fs.writeFileSync(path.join(l.dirSalida, 'servidor.log'), logsDe(SRV))
  // tras el apagado (docker cp funciona con el contenedor detenido): lo último que escribió el proceso al salir
  sh(`docker cp ${SRV}:/tmp/exp-medicion.jsonl ${path.join(l.dirSalida, 'medicion.jsonl')}`, { quiet: true, allowFail: true })
  if (l.conOtel) sh(`docker cp ${SRV}:/tmp/exp-otel-contadores.json ${path.join(l.dirSalida, 'contadores-otel-final.json')}`, { quiet: true, allowFail: true })
  const codigoDeSalida = Number(sh(`docker inspect -f '{{.State.ExitCode}}' ${SRV}`, { quiet: true, allowFail: true }))
  if (l.conOtel) {
    // el colector escribe en lote: se le da tiempo y se detiene ordenadamente antes de leer el archivo
    await sleep(3000)
    fs.writeFileSync(path.join(l.dirSalida, 'proxy-otlp.json'), sh(`docker exec ${SERVICIOS} node -e "fetch('http://127.0.0.1:9099/').then(r=>r.text()).then(console.log)"`, { quiet: true, allowFail: true }))
    sh(`docker stop -t 15 ${COLECTOR}`, { quiet: true, allowFail: true })
  }
  detenerServiciosOtel()
  log(`server ${l.brazo} abajo: vivo al final=${vivoAlFinal}, salida=${codigoDeSalida}, ${msHastaSalir} ms`)
  return { vivoAlFinal, codigoDeSalida, msHastaSalir }
}
