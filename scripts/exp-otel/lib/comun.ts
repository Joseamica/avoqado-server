/**
 * EXPERIMENTO OTel vs correlationId (16-oct-2026) — utilidades del ORQUESTADOR (corre en el runner de GitHub Actions,
 * nunca en la Mac). Plan: docs/investigaciones/otel-trazas/plan-medicion.md (las «Correcciones» del final mandan).
 *
 * Topología (la misma para el humo y para la medición de la fase 2):
 *
 *   red «exp-otel-red» (docker --internal: SIN salida a internet)
 *   ├── exp-pg       Postgres 16 (además en el bridge por defecto, con el puerto publicado para el orquestador)
 *   ├── exp-srv      el server compilado, `npm start`, en su propio cgroup (--cpus=1 --memory=2g, como Render)
 *   └── exp-actores  el «POS» (HTTP) y la «TPV» (socket.io-client) de script, FUERA de la cuota del server
 *
 * El server sólo está en la red interna: Stripe, OpenAI, Firebase, Better Stack… no se pueden alcanzar (se verifica y
 * se anota en cada corrida). Ningún secreto real: todo lo de abajo son literales desechables.
 */
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const REPO = process.cwd()
export const OUT = process.env.OUT_DIR || path.join(REPO, 'exp-out')
export const RED = 'exp-otel-red'
export const PG = 'exp-pg'
export const SRV = 'exp-srv'
export const ACTORES = 'exp-actores'
export const NODE_IMAGE = 'node:20-bookworm' // misma línea que producción (`engines.node: 20.x`)
export const PG_IMAGE = 'postgres:16'
export const PG_PORT_HOST = 54329

/** Secretos DESECHABLES del experimento (no existen en ningún otro lado). */
export const SECRETOS = {
  ACCESS_TOKEN_SECRET: 'exp-otel-access-secret-desechable-0001',
  REFRESH_TOKEN_SECRET: 'exp-otel-refresh-secret-desechable-0001',
  SESSION_SECRET: 'exp-otel-session-secret-desechable-0001',
  COOKIE_SECRET: 'exp-otel-cookie-secret-desechable-0001',
  OTP_PEPPER: 'exp-otel-otp-pepper-desechable-00001',
  SESSION_SUCCESSOR_ENC_KEY: '0'.repeat(63) + '1',
  AUDIT_LOG_ENCRYPTION_KEY: 'exp-otel-audit-key-desechable-000001',
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function log(...a: unknown[]) {
  console.log(`[${new Date().toISOString()}]`, ...a)
}

export function sh(cmd: string, opts: { quiet?: boolean; allowFail?: boolean; env?: Record<string, string> } = {}): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', opts.quiet ? 'pipe' : 'inherit'],
      maxBuffer: 512 * 1024 * 1024,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    }).trim()
  } catch (e: any) {
    if (opts.allowFail) return String(e.stdout ?? '')
    throw e
  }
}

export function escribirJson(nombre: string, datos: unknown) {
  fs.mkdirSync(path.dirname(path.join(OUT, nombre)), { recursive: true })
  fs.writeFileSync(path.join(OUT, nombre), JSON.stringify(datos, null, 2))
}

export const urlHost = (db: string) => `postgresql://app:app@127.0.0.1:${PG_PORT_HOST}/${db}`
export const urlRed = (db: string) => `postgresql://app:app@pg:5432/${db}`

export function redInterna() {
  sh(`docker network rm ${RED}`, { quiet: true, allowFail: true })
  sh(`docker network create --internal ${RED}`, { quiet: true })
}

export async function arrancarPostgres() {
  sh(`docker rm -f ${PG}`, { quiet: true, allowFail: true })
  // Fuera de la cuota del server (plan, corrección 9): Postgres tiene sus propios recursos y se mide aparte.
  sh(
    `docker run -d --name ${PG} -p ${PG_PORT_HOST}:5432 -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=postgres ` +
      `${PG_IMAGE} -c max_connections=300 -c shared_preload_libraries=pg_stat_statements`,
    { quiet: true },
  )
  sh(`docker network connect --alias pg ${RED} ${PG}`, { quiet: true })
  for (let i = 0; i < 90; i++) {
    const ok = sh(`docker exec ${PG} pg_isready -U app -d postgres`, { quiet: true, allowFail: true })
    if (ok.includes('accepting connections')) return
    await sleep(1000)
  }
  throw new Error('Postgres no arrancó')
}

export function psql(db: string, sql: string): string {
  return sh(`docker exec -i ${PG} psql -U app -d ${db} -v ON_ERROR_STOP=1 -Atc ${JSON.stringify(sql)}`, { quiet: true })
}

/** Base nueva copiada de la plantilla ya migrada y sembrada: cada corrida arranca con los MISMOS datos. */
export function clonarBase(plantilla: string, nueva: string) {
  psql('postgres', `DROP DATABASE IF EXISTS "${nueva}" WITH (FORCE)`)
  psql('postgres', `CREATE DATABASE "${nueva}" TEMPLATE "${plantilla}"`)
}

export function entornoDelServer(db: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'production', // como Render
    PORT: '3000',
    TZ: 'UTC',
    LOG_DIR: '/tmp/explogs',
    DATABASE_URL: urlRed(db),
    ...SECRETOS,
    // Arranque (plan, corrección 3): sin RabbitMQ vivo, con su URL de relleno; NUNCA DEMO_MODE (apaga jobs y sockets).
    DISABLE_RABBITMQ: 'true',
    RABBITMQ_URL: 'amqp://exp:exp@rabbit-inexistente:5672',
    // Rellenos: la red interna no tiene salida, así que aunque algo intente llamar, no llega.
    OPENAI_API_KEY: 'exp-otel-openai-relleno',
    STRIPE_SECRET_KEY: 'sk_test_exp_otel_relleno',
    EXTERNAL_BANK_API_BASE: 'http://banco-inexistente.invalid/',
    FRONTEND_URL: 'http://localhost:5173',
    ...extra,
  }
}

/** `npm start` es lo que corre Render (render.yaml: startCommand). `node-directo` SÓLO para la sub-prueba de apagado. */
export const COMANDO_NODE_DIRECTO = 'node -r tsconfig-paths/register dist/src/server.js'

/**
 * `servidor`: qué IMAGEN de Node corre el server y desde qué ÁRBOL compilado (node_modules + dist). Por defecto, el de
 * siempre (node:20-bookworm y este mismo repo). La comparación Node 20 vs Node 24 (4-node24-rendimiento) pasa otro árbol,
 * compilado con `npm ci && npm run build` en ESA versión, y la imagen node:24-bookworm. Postgres y actores no cambian.
 */
export interface ServidorNode {
  imagen: string
  repo: string
}

export function arrancarServer(nombre: string, env: Record<string, string>, comando = 'npm start', servidor: ServidorNode = { imagen: NODE_IMAGE, repo: REPO }) {
  sh(`docker rm -f ${nombre}`, { quiet: true, allowFail: true })
  const flags = Object.entries(env)
    .map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`)
    .join(' ')
  // cgroup de 1 CPU / 2 GB como Render (corrección 9). `--init` + TINI_KILL_PROCESS_GROUP: el SIGTERM llega al GRUPO
  // (npm y node). Sin esto (corrida 38927605201) npm moría con 143 y node nunca corría su gracefulShutdown — la fase 2
  // necesita el apagado con flush (brazo C).
  sh(
    `docker run -d --name ${nombre} --init -e TINI_KILL_PROCESS_GROUP=1 --cpus=1 --memory=2g --network ${RED} --network-alias srv ` +
      `-v ${servidor.repo}:${servidor.repo} -w ${servidor.repo} ${flags} ${servidor.imagen} ${comando}`,
    { quiet: true },
  )
}

export function correrActores(script: string, env: Record<string, string>): number {
  sh(`docker rm -f ${ACTORES}`, { quiet: true, allowFail: true })
  const flags = Object.entries(env)
    .map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`)
    .join(' ')
  try {
    execSync(
      `docker run --name ${ACTORES} --network ${RED} -v ${REPO}:${REPO} -w ${REPO} ${flags} ${NODE_IMAGE} ` +
        `node_modules/.bin/tsx ${script}`,
      { stdio: 'inherit' },
    )
    return 0
  } catch (e: any) {
    return typeof e.status === 'number' ? e.status : 1
  } finally {
    sh(`docker rm -f ${ACTORES}`, { quiet: true, allowFail: true })
  }
}

export function corriendo(nombre: string): boolean {
  return sh(`docker inspect -f '{{.State.Running}}' ${nombre}`, { quiet: true, allowFail: true }) === 'true'
}

export function logsDe(nombre: string): string {
  return sh(`docker logs ${nombre} 2>&1`, { quiet: true, allowFail: true })
}

/** ¿El server puede salir a internet? Se espera que NO (red interna). Se prueba DNS y una IP directa. */
export function verificarSinSalida(nombre: string): { dns: string; ipDirecta: string } {
  const dns = sh(
    `docker exec ${nombre} node -e "require('dns').lookup('api.stripe.com',e=>{console.log(e?'BLOQUEADO '+e.code:'ABIERTO');process.exit(0)})"`,
    { quiet: true, allowFail: true },
  )
  const ip = sh(
    `docker exec ${nombre} node -e "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:4000});` +
      `s.on('connect',()=>{console.log('ABIERTO');process.exit(0)});s.on('timeout',()=>{console.log('BLOQUEADO timeout');process.exit(0)});` +
      `s.on('error',e=>{console.log('BLOQUEADO '+e.code);process.exit(0)})"`,
    { quiet: true, allowFail: true },
  )
  return { dns, ipDirecta: ip }
}

// ───────────────────────────── Fase 2: brazos, servicios OTel, muestreo ─────────────────────────────

export const SERVICIOS = 'exp-servicios'
export const COLECTOR = 'exp-colector'
export const COLECTOR_IMAGE = 'otel/opentelemetry-collector-contrib:0.115.1' // fijada (publicada en 2024)

export type Brazo = 'A' | 'A+' | 'B' | 'B0' | 'BmP' | 'C'
/** Qué manda el cliente de script: nada (A, el de hoy), su correlationId (A+) o traceparent W3C (familia B). */
export const clienteDe = (b: Brazo): 'ninguna' | 'correlationId' | 'traceparent' =>
  b === 'A' ? 'ninguna' : b === 'A+' ? 'correlationId' : 'traceparent'

const PRECARGA_MEDIR = () => `${REPO}/scripts/exp-otel/medir/eld.cjs`
const PRECARGA_OTEL = () => `${REPO}/scripts/exp-otel/otel/preload.cjs`

/** Variables de cada brazo (MISMO build). A y A+ NO cargan el SDK; todos cargan el muestreador de medición. */
export function entornoDelBrazo(b: Brazo, extra: Record<string, string> = {}): Record<string, string> {
  const medir = { EXP_MEDIR: '1', NODE_OPTIONS: `--require ${PRECARGA_MEDIR()}` }
  if (b === 'A') return { ...medir, ...extra }
  if (b === 'A+') return { ...medir, EXP_PROPAGACION: 'correlationId', ...extra }
  const otel: Record<string, string> = {
    EXP_PROPAGACION: 'traceparent',
    EXP_OTEL: b === 'B0' ? 'B0' : b === 'BmP' ? 'BmP' : 'B',
    NODE_OPTIONS: `--require ${PRECARGA_MEDIR()} --require ${PRECARGA_OTEL()}`,
    EXP_MEDIR: '1',
    OTEL_SERVICE_NAME: 'avoqado-server',
    OTEL_TRACES_SAMPLER: b === 'B0' ? 'always_off' : 'parentbased_always_on',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://servicios:4318',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
    OTEL_EXPORTER_OTLP_TIMEOUT: '10000',
    OTEL_BSP_MAX_QUEUE_SIZE: '2048',
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '512',
    OTEL_BSP_SCHEDULE_DELAY: '5000',
    OTEL_BSP_EXPORT_TIMEOUT: '30000',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
  }
  return { ...otel, ...extra }
}

/** Contenedor «servicios» (proxy OTLP contador + externo falso) y colector, en la red interna. */
export function arrancarServiciosOtel(salida: string, opciones: { colectorConfig?: string; modoProxy?: string } = {}) {
  fs.mkdirSync(salida, { recursive: true })
  sh(`chmod 777 ${salida}`, { quiet: true, allowFail: true })
  sh(`docker rm -f ${COLECTOR} ${SERVICIOS}`, { quiet: true, allowFail: true })
  const cfg = opciones.colectorConfig ?? `${REPO}/scripts/exp-otel/otel/colector.yaml`
  sh(
    `docker run -d --name ${COLECTOR} --network ${RED} --network-alias colector -v ${cfg}:/etc/colector.yaml:ro -v ${salida}:/salida ` +
      `${COLECTOR_IMAGE} --config /etc/colector.yaml`,
    { quiet: true },
  )
  sh(
    `docker run -d --name ${SERVICIOS} --network ${RED} --network-alias servicios -e MODO_INICIAL=${opciones.modoProxy ?? 'reenviar'} ` +
      `-v ${REPO}:${REPO} -w ${REPO} ${NODE_IMAGE} node_modules/.bin/tsx scripts/exp-otel/otel/servicios.ts`,
    { quiet: true },
  )
}

/** Sólo el externo falso (falla ii) sin colector, para los brazos A/A+. */
export function arrancarServiciosSolos() {
  sh(`docker rm -f ${COLECTOR} ${SERVICIOS}`, { quiet: true, allowFail: true })
  sh(
    `docker run -d --name ${SERVICIOS} --network ${RED} --network-alias servicios -v ${REPO}:${REPO} -w ${REPO} ${NODE_IMAGE} ` +
      `node_modules/.bin/tsx scripts/exp-otel/otel/servicios.ts`,
    { quiet: true },
  )
}

export function detenerServiciosOtel() {
  sh(`docker stop -t 10 ${COLECTOR}`, { quiet: true, allowFail: true })
  sh(`docker rm -f ${COLECTOR} ${SERVICIOS}`, { quiet: true, allowFail: true })
}

/** Ejecuta algo DENTRO de la red interna (p. ej. hablarle al admin del proxy). */
export function enLaRed(cmd: string): string {
  return sh(`docker run --rm --network ${RED} curlimages/curl:8.10.1 ${cmd}`, { quiet: true, allowFail: true })
}

/** Actores en segundo plano (para muestrear el server mientras corren). */
export function correrActoresAsync(script: string, env: Record<string, string>, nombre = ACTORES): Promise<number> {
  sh(`docker rm -f ${nombre}`, { quiet: true, allowFail: true })
  const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  return new Promise(resolve => {
    const p = spawn('docker', ['run', '--name', nombre, '--network', RED, '-v', `${REPO}:${REPO}`, '-w', REPO, ...flags, NODE_IMAGE, 'node_modules/.bin/tsx', script], {
      stdio: 'inherit',
    })
    p.on('exit', code => {
      sh(`docker rm -f ${nombre}`, { quiet: true, allowFail: true })
      resolve(code ?? 1)
    })
  })
}

export interface Muestra {
  t: number
  cpuUsec: number
  memCgroup: number
}

/** CPU (µs acumulados del cgroup v2) y memoria del cgroup del server, cada `cadaMs`, hasta que `parar()` se llame. */
export function muestrear(nombre: string, cadaMs = 2000): { muestras: Muestra[]; parar: () => void } {
  const muestras: Muestra[] = []
  let vivo = true
  const una = () => {
    const s = sh(`docker exec ${nombre} sh -c 'cat /sys/fs/cgroup/cpu.stat; echo MEM $(cat /sys/fs/cgroup/memory.current)'`, {
      quiet: true,
      allowFail: true,
    })
    const cpu = s.match(/usage_usec (\d+)/)
    const mem = s.match(/MEM (\d+)/)
    if (cpu) muestras.push({ t: Date.now(), cpuUsec: Number(cpu[1]), memCgroup: mem ? Number(mem[1]) : NaN })
  }
  const bucle = async () => {
    while (vivo) {
      una()
      await sleep(cadaMs)
    }
  }
  void bucle()
  return { muestras, parar: () => (vivo = false) }
}

/** Fracción de 1 CPU usada por el server entre dos instantes (de las muestras del cgroup). */
export function cpuEntre(muestras: Muestra[], ini: number, fin: number): { fraccion: number; cpuMs: number } {
  const dentro = muestras.filter(m => m.t >= ini && m.t <= fin)
  if (dentro.length < 2) return { fraccion: NaN, cpuMs: NaN }
  const a = dentro[0]
  const b = dentro[dentro.length - 1]
  const cpuMs = (b.cpuUsec - a.cpuUsec) / 1000
  return { fraccion: cpuMs / (b.t - a.t), cpuMs: (cpuMs * (fin - ini)) / (b.t - a.t) }
}

export function leerEnContenedor(nombre: string, archivo: string): string {
  return sh(`docker exec ${nombre} cat ${archivo}`, { quiet: true, allowFail: true })
}

export function pct(xs: number[], p: number): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!s.length) return NaN
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
export function mediana(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!s.length) return NaN
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** PRNG con semilla (orden aleatorio REPRODUCIBLE de los brazos por repetición). */
export function barajar<T>(xs: T[], semilla: number): T[] {
  let s = semilla >>> 0 || 1
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Espera hasta el próximo segundo :SS del minuto (fase del cron de efectos: corre a :16 y :46). */
export async function esperarSegundo(ss: number) {
  const ahora = new Date()
  let ms = ((ss - ahora.getSeconds() + 60) % 60) * 1000 - ahora.getMilliseconds()
  if (ms < 0) ms += 60_000
  await sleep(ms)
}
