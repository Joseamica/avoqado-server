// scripts/shopify-sandbox-server.ts
/**
 * Local AISLADO para la guía y el QA del conector Shopify (plan C, C10). Nunca toca `av-db-25` ni carga el `.env` del
 * repo:
 * - `src/config/env.ts` y `prisma.config.ts` hacen `dotenv.config()` desde la carpeta en que se corre: este script se corre
 *   desde una carpeta de SANDBOX cuyo `.env` sólo trae llaves permitidas, y vacía el entorno heredado de la terminal (un
 *   `DATABASE_URL` o `USE_RENDER_DB` exportado ganaría sobre cualquier `.env`);
 * - el cliente de Prisma del repo carga el `.env` del repo: el sandbox genera SU cliente y un gancho manda ahí todo
 *   `require('@prisma/client')`;
 * - antes de escuchar, compara el entorno con el que puso (`llavesAjenas`): si algo lo cambió al importar, no arranca;
 *   los hijos del seed llevan un vigía que hace lo mismo al terminar (`vigiaEntorno`).
 * Sólo levanta `app` y el worker de Shopify: nada de la sincronización de Stripe, RabbitMQ, Socket.IO ni los demás jobs.
 *
 * 🔴 Lo que se publica por el túnel (ronda 1): con `NODE_ENV=development` la app trae `POST /api/dev/generate-token`, que
 * firma tokens de SUPERADMIN sin sesión, además de trazas de error y rutas de desarrollo. Por eso la app completa escucha
 * SÓLO en `127.0.0.1:PORT` (la usa el dashboard local) y el túnel apunta a OTRO puerto, `127.0.0.1:PORT+1`, que sólo deja
 * pasar lo que Shopify necesita: `GET /health`, el callback del OAuth y el POST del webhook (`crearTunel`). Y las
 * contraseñas conocidas del seed (`superadmin`/`superadmin`, …) se reemplazan al preparar; `servir` no arranca si alguna
 * cuenta todavía entra con una de ellas.
 *
 * Uso (desde la carpeta del sandbox, NUNCA desde el repo; <wt> = worktree del server):
 *   <wt>/node_modules/.bin/tsx --tsconfig <wt>/tsconfig.json <wt>/scripts/shopify-sandbox-server.ts preparar
 *   … cliente  sólo el cliente de Prisma del sandbox y el gancho (sin base; lo usa la prueba de arranque)
 *   … probar   importa la app y el worker de verdad y comprueba el entorno; no consulta la base
 *   … servir   lo mismo, revisa las contraseñas, escucha en 127.0.0.1:PORT (app) y 127.0.0.1:PORT+1 (túnel) y arranca el
 *              worker de Shopify. El túnel: `cloudflared tunnel --url http://127.0.0.1:<PORT+1>`.
 * Imprime el NOMBRE de la base, nunca su URL, y de una llave ajena sólo su nombre.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import http, { type RequestListener } from 'node:http'
import path from 'node:path'
import bcryptjs from 'bcryptjs'
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
/** El sandbox sólo habla con el Postgres de esta Mac (`URL.hostname` deja `::1` entre corchetes). */
const HOSTS_LOCALES = ['localhost', '127.0.0.1', '::1', '[::1]']
/** Lo generado dentro de la carpeta del sandbox (el esquema va en `prisma-sandbox/`, nunca en `prisma/`: ver revisarSandbox). */
export const DENTRO = {
  esquema: 'prisma-sandbox',
  cliente: 'cliente-prisma',
  gancho: 'prisma-hook.cjs',
  vigia: 'prisma-vigia.cjs',
} as const

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
  let url: URL
  let dbName: string
  try {
    url = new URL(o.envArchivo.DATABASE_URL)
    dbName = decodeURIComponent(url.pathname.replace(/^\//, ''))
  } catch {
    return { ok: false, motivo: 'DATABASE_URL no es una URL válida (no se muestra: puede traer la contraseña).' }
  }
  // Prisma y libpq aceptan `host=` (y libpq `hostaddr=`) en la query, y ganan sobre el host de la URL.
  const hosts = [url.hostname, ...url.searchParams.getAll('host'), ...url.searchParams.getAll('hostaddr')]
  if (hosts.some(h => !HOSTS_LOCALES.includes(h))) {
    return {
      ok: false,
      motivo:
        'DATABASE_URL debe apuntar a tu Postgres local (localhost, 127.0.0.1 o ::1), también en un `host=` de la query (no se muestra).',
    }
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

/**
 * Vigía CJS para los hijos del seed (ronda 1): guarda el entorno con el que arrancó el hijo y, al terminar, si apareció o
 * cambió alguna llave, la NOMBRA (nunca su valor) y el hijo sale con 1. Es la misma revisión que `probar` hace tras
 * importar la app (`llavesAjenas`), hecha donde corre el seed.
 */
export function vigiaEntorno(): string {
  return [
    'const inicial = { ...process.env }',
    "process.on('exit', () => {",
    '  const ajenas = Object.keys(process.env).filter(k => process.env[k] !== inicial[k]).sort()',
    '  if (ajenas.length) {',
    "    process.stderr.write('✋ Durante este paso del sandbox apareció o cambió en el entorno: ' + ajenas.join(', ') + '.\\n')",
    '    process.exitCode = 1',
    '  }',
    '})',
    '',
  ].join('\n')
}

/** `NODE_OPTIONS` de los hijos: cada `--require` con su ruta entre comillas (una carpeta con espacios no lo rompe). */
export function opcionesNodeHijo(archivos: string[]): string {
  return archivos.map(a => `--require ${JSON.stringify(a)}`).join(' ')
}

// ---------- El túnel (ronda 1): lo ÚNICO que se publica ----------

export type RutaDelTunel = { metodo: 'GET' | 'POST'; ruta: string }

/** Lo que Shopify necesita del sandbox: la comprobación de vida, el regreso del OAuth y los webhooks. Nada más. */
export function rutasDelTunel(callbackOAuth: string, rutaWebhook: string): RutaDelTunel[] {
  return [
    { metodo: 'GET', ruta: '/health' },
    { metodo: 'GET', ruta: callbackOAuth },
    { metodo: 'POST', ruta: rutaWebhook },
  ]
}

const escaparRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Plantilla de Express → regex EXACTA sobre la ruta CRUDA; un `:parametro` sólo admite `[A-Za-z0-9_-]`. */
const regexDeRuta = (ruta: string) =>
  new RegExp(
    `^${ruta
      .split('/')
      .map(s => (s.startsWith(':') ? '[A-Za-z0-9_-]+' : escaparRegex(s)))
      .join('/')}$`,
  )

/**
 * ¿Pasa esta petición por el túnel? Se compara la ruta CRUDA (sin decodificar ni normalizar) contra la plantilla exacta:
 * `..`, `%2e`, `%2f`, `//`, `\`, `#`, `;`, una barra final, mayúsculas o la forma absoluta (`http://…`) nunca coinciden.
 * Sólo cuenta lo que va antes del `?`; la query sigue intacta hacia la app (el HMAC del OAuth la necesita).
 */
export function pasaPorElTunel(metodo: string | undefined, url: string | undefined, rutas: RutaDelTunel[]): boolean {
  if (!metodo || !url || !url.startsWith('/')) return false
  const fin = url.indexOf('?')
  const ruta = fin === -1 ? url : url.slice(0, fin)
  return rutas.some(r => r.metodo === metodo && regexDeRuta(r.ruta).test(ruta))
}

/**
 * El servidor al que apunta el túnel: lo permitido se le entrega a la app TAL CUAL (el mismo request, el cuerpo crudo
 * intacto para el HMAC); lo demás es un 404 sin cuerpo. De lo rechazado sólo se anota el método y la ruta, nunca la query
 * ni el cuerpo.
 */
export function crearTunel(
  app: RequestListener,
  rutas: RutaDelTunel[],
  anotar: (linea: string) => void = l => console.log(l),
): http.Server {
  return http.createServer((req, res) => {
    if (pasaPorElTunel(req.method, req.url, rutas)) return void app(req, res)
    const limpio = (s: string) => s.replace(/[^\x21-\x7e]/g, '').slice(0, 200)
    anotar(`túnel: 404 ${limpio(req.method ?? '?')} ${limpio((req.url ?? '').split('?')[0])}`)
    req.resume()
    res.statusCode = 404
    res.end()
  })
}

// ---------- Las contraseñas conocidas del seed (ronda 1) ----------

/**
 * Cada contraseña LITERAL de `prisma/seed.ts` (`superadmin@superadmin.com`/`superadmin`, `owner`, `admin`, …). Una prueba
 * lee el seed y falla si aparece otra que no esté aquí.
 */
export const CLAVES_LITERALES_DEL_SEED = [
  'superadmin',
  'owner',
  'admin',
  'Password123!',
  'manager',
  'cashier',
  'waiter',
  'waiter2',
  'waiter3',
  'waiter4',
  'kitchen',
  'host',
  'viewer',
] as const

/** Las literales más las que el seed arma con el slug de cada sucursal (`suffix = slug.replace('avoqado-', '')`). */
export function clavesDelSeed(slugs: string[]): string[] {
  const derivadas = slugs.flatMap(slug => {
    const sufijo = slug.replace('avoqado-', '')
    return sufijo ? [sufijo, `waiter2.${sufijo}`, `waiter3.${sufijo}`, `waiter4.${sufijo}`] : []
  })
  return [...new Set<string>([...CLAVES_LITERALES_DEL_SEED, ...derivadas])]
}

export type FilaStaff = { id: string; password: string | null }
/** Una tanda de cuentas con id mayor que `despuesDe`, ordenadas por id (cursor estable, tanda acotada). */
export type LeerTanda = (despuesDe: string | null) => Promise<FilaStaff[]>

/** Cuántas cuentas todavía entran con alguna contraseña conocida del seed. Sólo el número: ni correos ni claves. */
export async function staffConClaveDelSeed(
  leer: LeerTanda,
  candidatas: string[],
  comparar: (clave: string, hash: string) => Promise<boolean>,
): Promise<number> {
  let n = 0
  for (let despuesDe: string | null = null; ; ) {
    const tanda = await leer(despuesDe)
    if (!tanda.length) return n
    const entran = await Promise.all(
      tanda.map(async ({ password }) => {
        if (!password) return false
        for (const clave of candidatas) if (await comparar(clave, password)) return true
        return false
      }),
    )
    n += entran.filter(Boolean).length
    despuesDe = tanda[tanda.length - 1].id
  }
}

/** bcrypt (costo 10, como el seed) de 32 bytes aleatorios que no se guardan ni se muestran: nadie conoce la contraseña. */
export async function cifrarAzar(): Promise<string> {
  return bcryptjs.hash(randomBytes(32).toString('base64url'), 10)
}

/** Le pone a CADA cuenta (también a las que no tenían) una contraseña aleatoria distinta. Devuelve cuántas; no imprime nada. */
export async function blindarClaves(
  leer: LeerTanda,
  escribir: (id: string, hash: string) => Promise<void>,
  cifrar: () => Promise<string> = cifrarAzar,
): Promise<number> {
  let n = 0
  for (let despuesDe: string | null = null; ; ) {
    const tanda = await leer(despuesDe)
    if (!tanda.length) return n
    for (const { id } of tanda) {
      await escribir(id, await cifrar())
      n++
    }
    despuesDe = tanda[tanda.length - 1].id
  }
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

/** El cliente de Prisma de la app, cargado DESPUÉS del gancho (así es el del sandbox). */
type PrismaDeLaApp = (typeof import('../src/utils/prismaClient'))['default']

/** Lector por tandas de 200 cuentas, por id. */
const leerStaff =
  (prisma: PrismaDeLaApp): LeerTanda =>
  despuesDe =>
    prisma.staff.findMany({
      where: despuesDe ? { id: { gt: despuesDe } } : {},
      select: { id: true, password: true },
      orderBy: { id: 'asc' },
      take: 200,
    })

/** Los slugs de las sucursales (el seed arma contraseñas con ellos). Acotado: el sandbox tiene un puñado. */
const slugsDeSucursales = async (prisma: PrismaDeLaApp) =>
  (await prisma.venue.findMany({ select: { slug: true }, orderBy: { id: 'asc' }, take: 500 })).map(v => v.slug)

/** bcrypt nativo: compara en el pool de hilos (≈4 a la vez); bcryptjs tardaría más de un minuto con ~40 cuentas. */
async function comparadorRapido(): Promise<(clave: string, hash: string) => Promise<boolean>> {
  const bcrypt = await import('bcrypt')
  return (clave, hash) => bcrypt.compare(clave, hash)
}

/** Si después de cargar algo apareció o cambió una llave del entorno, se detiene (sólo nombres). */
function exigirEntorno(esperado: NodeJS.ProcessEnv, cuando: string) {
  const ajenas = llavesAjenas(process.env, esperado)
  if (ajenas.length) {
    console.error(`✋ ${cuando} apareció o cambió: ${ajenas.join(', ')}. No se sigue.`)
    process.exit(1)
  }
}

/**
 * Cliente → base VACÍA migrada → datos sintéticos de `prisma/seed.ts` → la fila Feature de Shopify (C1) → contraseñas del
 * seed reemplazadas. Nada se copia de av-db-25. Los hijos del seed corren con el gancho (también usan el cliente del
 * sandbox) y con el vigía del entorno.
 */
async function preparar(repo: string, sandbox: string, env: NodeJS.ProcessEnv) {
  const bin = binDe(repo)
  const esquema = cliente(repo, sandbox, env)
  const gancho = path.join(sandbox, DENTRO.gancho)
  const vigia = path.join(sandbox, DENTRO.vigia)
  writeFileSync(vigia, vigiaEntorno())
  correr(bin('prisma'), ['migrate', 'deploy', '--schema', esquema], sandbox, env)
  const conGancho = { ...env, NODE_OPTIONS: opcionesNodeHijo([gancho, vigia]) }
  const tsx = (archivo: string) =>
    correr(bin('tsx'), ['--tsconfig', path.join(repo, 'tsconfig.json'), path.join(repo, archivo)], sandbox, conGancho)
  tsx('prisma/seed.ts')
  tsx('scripts/seed-shopify-feature.ts')
  // 🔴 El seed deja cuentas con contraseñas conocidas (`superadmin@superadmin.com`/`superadmin`, …): se reemplazan TODAS
  // por una aleatoria que no se guarda ni se muestra. En este proceso, como `probar`: gancho, cliente, y el entorno intacto.
  await import(gancho)
  const { default: prisma } = await import('../src/utils/prismaClient')
  exigirEntorno(env, 'Al cargar el cliente de Prisma')
  try {
    const total = await blindarClaves(leerStaff(prisma), async (id, password) => {
      await prisma.staff.update({ where: { id }, data: { password }, select: { id: true } })
    })
    const quedan = await staffConClaveDelSeed(leerStaff(prisma), clavesDelSeed(await slugsDeSucursales(prisma)), await comparadorRapido())
    if (quedan) {
      console.error(`✋ ${quedan} cuenta(s) todavía entran con una contraseña conocida del seed.`)
      process.exit(1)
    }
    console.log(
      `Contraseñas del seed reemplazadas: ${total} cuentas con una contraseña aleatoria que nadie conoce; ninguna entra con una del seed.`,
    )
  } finally {
    await prisma.$disconnect()
  }
  console.log('Sandbox listo: base migrada y sembrada, con el cliente de Prisma del sandbox.')
}

/** `listen` en una dirección concreta, esperando a que de verdad escuche (un puerto ocupado detiene todo). */
const escuchar = (server: http.Server, puerto: number) =>
  new Promise<void>((listo, falla) => {
    server.once('error', falla)
    server.listen(puerto, '127.0.0.1', () => listo())
  })

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
  // Las rutas que publica el túnel salen de las MISMAS constantes con que `app.ts` las monta (ya están cargadas).
  const { SHOPIFY_OAUTH_CALLBACK_PATH } = await import('../src/services/commerce-channels/shopify/shopify.connect.service')
  const { SHOPIFY_WEBHOOK_ROUTE } = await import('../src/services/commerce-channels/shopify/shopify.inbound.service')
  const { default: prisma } = await import('../src/utils/prismaClient')
  exigirEntorno(esperado, 'Al cargar las rutas de Shopify')
  console.log('Revisando que ninguna cuenta entre con una contraseña conocida del seed (unos segundos)…')
  const quedan = await staffConClaveDelSeed(leerStaff(prisma), clavesDelSeed(await slugsDeSucursales(prisma)), await comparadorRapido())
  if (quedan) {
    console.error(`✋ ${quedan} cuenta(s) todavía entran con una contraseña conocida del seed: corre \`preparar\` otra vez. No se arranca.`)
    process.exit(1)
  }
  const port = Number(process.env.PORT ?? 3100)
  // 🔴 La app completa SÓLO en 127.0.0.1 (el dashboard local); el túnel apunta al puerto de al lado, que filtra.
  const servidorApp = http.createServer(app)
  const servidorTunel = crearTunel(app, rutasDelTunel(SHOPIFY_OAUTH_CALLBACK_PATH, SHOPIFY_WEBHOOK_ROUTE))
  await escuchar(servidorApp, port)
  await escuchar(servidorTunel, port + 1)
  console.log(
    `Sandbox Shopify: app en 127.0.0.1:${port} (sólo esta Mac) · túnel en 127.0.0.1:${port + 1} (sólo /health, el OAuth y el webhook).`,
  )
  shopifyWorkerJob.start()
  const parar = () => {
    shopifyWorkerJob.stop()
    servidorTunel.close()
    servidorApp.close(() => process.exit(0))
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
  if (modo === 'preparar') return await preparar(repo, cwd, env)
  return arrancar(modo, cwd, env)
}

if (require.main === module) void main()
