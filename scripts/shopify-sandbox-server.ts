// scripts/shopify-sandbox-server.ts
/**
 * Local AISLADO para la guía y el QA del conector Shopify (plan C, C10). Nunca toca `av-db-25` ni carga el `.env` del
 * repo:
 * - `src/config/env.ts` y `prisma.config.ts` hacen `dotenv.config()` desde la carpeta en que se corre: este script se corre
 *   desde una carpeta de SANDBOX cuyo `.env` sólo trae llaves permitidas, y vacía el entorno heredado de la terminal (un
 *   `DATABASE_URL` o `USE_RENDER_DB` exportado ganaría sobre cualquier `.env`);
 * - el cliente de Prisma del repo carga el `.env` del repo: el sandbox genera SU cliente y un gancho manda ahí todo
 *   `require('@prisma/client')`;
 * - antes de escuchar, compara el entorno con el que puso (`llavesAjenas`): si algo lo cambió al importar, no arranca.
 * Sólo levanta `app` y el worker de Shopify: nada de la sincronización de Stripe, RabbitMQ, Socket.IO ni los demás jobs.
 *
 * Uso (desde la carpeta del sandbox, NUNCA desde el repo; <wt> = worktree del server):
 *   <wt>/node_modules/.bin/tsx --tsconfig <wt>/tsconfig.json <wt>/scripts/shopify-sandbox-server.ts preparar
 *   … cliente  sólo el cliente de Prisma del sandbox y el gancho (sin base; lo usa la prueba de arranque)
 *   … probar   importa la app y el worker de verdad y comprueba el entorno; no consulta la base
 *   … servir   lo mismo, y escucha en PORT y arranca el worker de Shopify
 * Imprime el NOMBRE de la base, nunca su URL, y de una llave ajena sólo su nombre.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

export type Modo = 'cliente' | 'preparar' | 'probar' | 'servir'
export type Revision = { ok: true; dbName: string } | { ok: false; motivo: string }

/** Lo único que puede traer el `.env` del sandbox: secretos LOCALES generados para esto y la app piloto de Shopify. */
export const LLAVES_SANDBOX = [
  'DATABASE_URL',
  'PORT',
  'BASE_URL',
  'FRONTEND_URL',
  'LOG_LEVEL',
  'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_SECRET',
  'SESSION_SECRET',
  'COOKIE_SECRET',
  'OTP_PEPPER',
  'OAUTH_STATE_SECRET',
  'SHOPIFY_PILOTO_CLIENT_ID',
  'SHOPIFY_PILOTO_CLIENT_SECRET',
  'SHOPIFY_TOKEN_KEY',
  'SHOPIFY_PILOTO_SHOPS',
] as const
/**
 * Sin éstas la app no importa: env.ts las valida, y `jwt.service.ts:11` lanza al importarse sin `REFRESH_TOKEN_SECRET`
 * (Codex R4-1; lo importa `auth.dashboard.controller.ts:15`). Revisado en `src/`: los demás requisitos de llaves son
 * perezosos (WhatsApp, cifrado de tokens, Uber, Google Wallet) o tienen respaldo (Resend, Anthropic, Firebase); Stripe y
 * OpenAI van sintéticos en FORZADAS.
 */
const BASICAS = [
  'DATABASE_URL',
  'FRONTEND_URL',
  'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_SECRET',
  'SESSION_SECRET',
  'COOKIE_SECRET',
  'OTP_PEPPER',
]
/** Sólo para importar la app y conectar de verdad: el túnel, el firmador del `state` (R2-1) y la app piloto. */
const PARA_SERVIR = [
  'BASE_URL',
  'OAUTH_STATE_SECRET',
  'SHOPIFY_PILOTO_CLIENT_ID',
  'SHOPIFY_PILOTO_CLIENT_SECRET',
  'SHOPIFY_TOKEN_KEY',
  'SHOPIFY_PILOTO_SHOPS',
]
/** De la terminal sólo pasa lo que el sistema necesita para correr procesos (y lo de tsx); ninguna credencial. */
const DE_LA_TERMINAL = ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'TZ']
/**
 * Llave de Stripe SINTÉTICA (Codex R2-2): `webhook.controller.ts` construye `new Stripe(...)` al importarse y el SDK truena
 * sin llave. No es de ninguna cuenta: el SDK se construye y cualquier llamada a Stripe falla.
 */
export const STRIPE_SINTETICA = 'sk_test_avq_sandbox_inactivo'
/**
 * Llave de OpenAI SINTÉTICA (Codex R3-4): `assistant.dashboard.service.ts:53` y `text-to-sql-assistant.service.ts:450`
 * la exigen en el constructor de singletons que se crean al importar la app. No es de ninguna cuenta.
 */
export const OPENAI_SINTETICA = 'sk-avq-sandbox-inactivo'
/** Siempre así en el sandbox: RabbitMQ apagado (la URL de mentira sólo llena el campo obligatorio de env.ts). */
const FORZADAS = {
  NODE_ENV: 'development',
  DISABLE_RABBITMQ: 'true',
  RABBITMQ_URL: 'amqp://desactivado.invalid',
  STRIPE_SECRET_KEY: STRIPE_SINTETICA,
  OPENAI_API_KEY: OPENAI_SINTETICA,
}
export const BASE_DESECHABLE = /^av-db-25-shopify-[a-z0-9-]+$/
/** Lo generado dentro de la carpeta del sandbox (el esquema va en `prisma-sandbox/`, nunca en `prisma/`: ver revisarSandbox). */
export const DENTRO = { esquema: 'prisma-sandbox', cliente: 'cliente-prisma', gancho: 'prisma-hook.cjs' } as const

export function revisarSandbox(o: {
  modo: Modo
  cwd: string
  envArchivo: Record<string, string> | null
  existe: (p: string) => boolean
}): Revision {
  if (o.existe(path.join(o.cwd, 'prisma', 'schema.prisma'))) {
    return { ok: false, motivo: 'Corre esto desde la carpeta del sandbox, no desde el repo: ahí se cargaría el .env de siempre.' }
  }
  if (!o.envArchivo) return { ok: false, motivo: 'Falta el .env del sandbox en esta carpeta.' }
  const sobran = Object.keys(o.envArchivo).filter(k => !(LLAVES_SANDBOX as readonly string[]).includes(k))
  if (sobran.length) return { ok: false, motivo: `El .env del sandbox trae llaves que no van aquí: ${sobran.join(', ')}.` }
  const sirve = o.modo === 'probar' || o.modo === 'servir'
  const faltan = (sirve ? [...BASICAS, ...PARA_SERVIR] : BASICAS).filter(k => !o.envArchivo![k])
  if (faltan.length) return { ok: false, motivo: `Faltan en el .env del sandbox: ${faltan.join(', ')}.` }
  let dbName: string
  try {
    dbName = decodeURIComponent(new URL(o.envArchivo.DATABASE_URL).pathname.replace(/^\//, ''))
  } catch {
    return { ok: false, motivo: 'DATABASE_URL no es una URL válida (no se muestra: puede traer la contraseña).' }
  }
  if (!BASE_DESECHABLE.test(dbName)) {
    return { ok: false, motivo: `La base «${dbName}» no es desechable: debe llamarse av-db-25-shopify-<algo>.` }
  }
  if (sirve && !o.envArchivo.BASE_URL.startsWith('https://')) {
    return { ok: false, motivo: 'BASE_URL debe ser la URL HTTPS del túnel: Shopify no devuelve el OAuth ni manda webhooks a http.' }
  }
  return { ok: true, dbName }
}

export function entornoSandbox(shell: NodeJS.ProcessEnv, archivo: Record<string, string>): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(shell).filter(([k, v]) => v !== undefined && (DE_LA_TERMINAL.includes(k) || k.startsWith('TSX_'))),
  )
  return { ...base, ...archivo, ...FORZADAS }
}

/** Llaves que aparecieron o cambiaron respecto de lo que puso el sandbox. Sólo NOMBRES, ordenados: los valores no salen. */
export function llavesAjenas(actual: NodeJS.ProcessEnv, esperado: NodeJS.ProcessEnv): string[] {
  return Object.keys(actual)
    .filter(k => actual[k] !== esperado[k])
    .sort()
}

/** Copia del esquema con el cliente generado DENTRO del sandbox: sus rutas de `.env` quedan dentro (Codex N9). */
export function esquemaSandbox(texto: string, salida: string): string {
  const bloque = /generator client \{([^}]*)\}/.exec(texto)
  if (!bloque) throw new Error('El esquema no trae `generator client`')
  if (bloque[1].split('\n').some(l => /^\s*output\s*=/.test(l)))
    throw new Error('El esquema ya fija `output`: revisa el sandbox antes de seguir')
  return texto.replace(bloque[0], `generator client {${bloque[1].replace(/\s*$/, '')}\n  output   = ${JSON.stringify(salida)}\n}`)
}

/** Gancho CJS: TODO `require('@prisma/client')` (el server, el seed, el worker) va al cliente del sandbox (Codex N9). */
export function ganchoPrisma(clienteIndex: string): string {
  return [
    "const Module = require('node:module')",
    'const original = Module._resolveFilename',
    `const CLIENTE = ${JSON.stringify(clienteIndex)}`,
    'Module._resolveFilename = function (pedido, ...resto) {',
    "  return pedido === '@prisma/client' ? CLIENTE : original.call(this, pedido, ...resto)",
    '}',
    '',
  ].join('\n')
}

function correr(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync(bin, args, { cwd, env, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`✋ Falló ${path.basename(bin)} ${args[0] ?? ''}`)
    process.exit(r.status ?? 1)
  }
}

const binDe = (repo: string) => (n: string) => path.join(repo, 'node_modules', '.bin', n)

/** Esquema copiado → cliente de Prisma PROPIO → gancho. No toca ninguna base (lo usa también la prueba de arranque). */
function cliente(repo: string, sandbox: string, env: NodeJS.ProcessEnv): string {
  const bin = binDe(repo)
  const dir = path.join(sandbox, DENTRO.esquema)
  const esquema = path.join(dir, 'schema.prisma')
  mkdirSync(dir, { recursive: true })
  writeFileSync(esquema, esquemaSandbox(readFileSync(path.join(repo, 'prisma', 'schema.prisma'), 'utf8'), `../${DENTRO.cliente}`))
  cpSync(path.join(repo, 'prisma', 'migrations'), path.join(dir, 'migrations'), { recursive: true })
  // `prisma generate` busca `@prisma/client` junto al proyecto: se ENLAZA el del worktree (rm -rf no sigue el enlace).
  const enlace = path.join(sandbox, 'node_modules', '@prisma', 'client')
  mkdirSync(path.dirname(enlace), { recursive: true })
  if (!existsSync(enlace)) symlinkSync(path.join(repo, 'node_modules', '@prisma', 'client'), enlace, 'dir')
  correr(bin('prisma'), ['generate', '--schema', esquema], sandbox, env)
  const gancho = path.join(sandbox, DENTRO.gancho)
  writeFileSync(gancho, ganchoPrisma(path.join(sandbox, DENTRO.cliente, 'index.js')))
  console.log('Cliente de Prisma del sandbox generado.')
  return esquema
}

/**
 * Cliente → base VACÍA migrada → datos sintéticos de `prisma/seed.ts` → la fila Feature de Shopify (C1). Nada se copia
 * de av-db-25. El seed corre con el gancho: también usa el cliente del sandbox.
 */
function preparar(repo: string, sandbox: string, env: NodeJS.ProcessEnv) {
  const bin = binDe(repo)
  const esquema = cliente(repo, sandbox, env)
  const gancho = path.join(sandbox, DENTRO.gancho)
  correr(bin('prisma'), ['migrate', 'deploy', '--schema', esquema], sandbox, env)
  const conGancho = { ...env, NODE_OPTIONS: `--require ${gancho}` }
  const tsx = (archivo: string) =>
    correr(bin('tsx'), ['--tsconfig', path.join(repo, 'tsconfig.json'), path.join(repo, archivo)], sandbox, conGancho)
  tsx('prisma/seed.ts')
  tsx('scripts/seed-shopify-feature.ts')
  console.log('Sandbox listo: base migrada y sembrada, con el cliente de Prisma del sandbox.')
}

/** `probar` y `servir`: importa la app y el worker DE VERDAD, revisa el entorno, y sólo `servir` escucha y arranca. */
async function arrancar(modo: 'probar' | 'servir', sandbox: string, esperado: NodeJS.ProcessEnv) {
  const gancho = path.join(sandbox, DENTRO.gancho)
  if (!existsSync(gancho)) {
    console.error('✋ Falta el cliente de Prisma del sandbox: corre antes `preparar`.')
    process.exit(1)
  }
  await import(gancho) // instala el gancho ANTES de que nada pida `@prisma/client`
  const { default: app } = await import('../src/app')
  const { shopifyWorkerJob } = await import('../src/jobs/shopify-worker.job')
  // 🔴 Ya importados la app, el worker y el cliente de Prisma (que carga su `.env`): el entorno debe ser EXACTAMENTE el del
  // sandbox. Sólo nombres; no se consulta la base.
  const ajenas = llavesAjenas(process.env, esperado)
  if (ajenas.length) {
    console.error(`✋ Al importar la app apareció o cambió: ${ajenas.join(', ')}. No se arranca.`)
    process.exit(1)
  }
  if (modo === 'probar') {
    // `llavesAjenas` ya cubre que Stripe y OpenAI sigan siendo los SINTÉTICOS (están en el entorno esperado).
    console.log('Importación revisada: la app y el worker cargan con el entorno del sandbox y nada más (Stripe y OpenAI sintéticos).')
    process.exit(0)
  }
  const port = Number(process.env.PORT ?? 3100)
  const server = app.listen(port, () => console.log(`Sandbox Shopify en el puerto ${port} (sólo la app y el worker de Shopify).`))
  shopifyWorkerJob.start()
  const parar = () => {
    shopifyWorkerJob.stop()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', parar)
  process.on('SIGTERM', parar)
}

async function main() {
  const modo = process.argv[2]
  if (modo !== 'cliente' && modo !== 'preparar' && modo !== 'probar' && modo !== 'servir') {
    console.error('Uso: … shopify-sandbox-server.ts cliente | preparar | probar | servir')
    process.exit(2)
  }
  const cwd = process.cwd()
  const ruta = path.join(cwd, '.env')
  const envArchivo = existsSync(ruta) ? dotenv.parse(readFileSync(ruta)) : null
  const r = revisarSandbox({ modo, cwd, envArchivo, existe: existsSync })
  if (!r.ok) {
    console.error(`✋ ${r.motivo}`)
    process.exit(1)
  }
  console.log(`Sandbox Shopify · base: ${r.dbName}`) // 🔴 sólo el NOMBRE
  // Antes de importar nada del server: lo heredado de la terminal no debe ganarle al .env del sandbox.
  const env = entornoSandbox(process.env, envArchivo!)
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, env)
  const repo = path.resolve(__dirname, '..')
  if (modo === 'cliente') return void cliente(repo, cwd, env)
  if (modo === 'preparar') return preparar(repo, cwd, env)
  return arrancar(modo, cwd, env)
}

if (require.main === module) void main()
