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
import { execSync } from 'node:child_process'
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
  fs.mkdirSync(OUT, { recursive: true })
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

export function arrancarServer(nombre: string, env: Record<string, string>) {
  sh(`docker rm -f ${nombre}`, { quiet: true, allowFail: true })
  const flags = Object.entries(env)
    .map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`)
    .join(' ')
  // cgroup de 1 CPU / 2 GB como Render (corrección 9). `--init` para que las señales lleguen a npm → node.
  sh(
    `docker run -d --name ${nombre} --init --cpus=1 --memory=2g --network ${RED} --network-alias srv ` +
      `-v ${REPO}:${REPO} -w ${REPO} ${flags} ${NODE_IMAGE} npm start`,
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
