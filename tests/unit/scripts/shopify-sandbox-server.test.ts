// tests/unit/scripts/shopify-sandbox-server.test.ts
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { SHOPIFY_OAUTH_CALLBACK_PATH } from '@/services/commerce-channels/shopify/shopify.connect.service'
import { SHOPIFY_WEBHOOK_ROUTE } from '@/services/commerce-channels/shopify/shopify.inbound.service'
import {
  blindarClaves,
  cifrarAzar,
  CLAVES_LITERALES_DEL_SEED,
  clavesDelSeed,
  crearTunel,
  entornoSandbox,
  esquemaSandbox,
  ganchoPrisma,
  llavesAjenas,
  OPENAI_SINTETICA,
  opcionesNodeHijo,
  revisarSandbox,
  rutasDelTunel,
  staffConClaveDelSeed,
  STRIPE_SINTETICA,
  vigiaEntorno,
} from '../../../scripts/shopify-sandbox-server'

const RAIZ_REPO = path.join(__dirname, '../../..')
const SANDBOX = '/tmp/avq-shopify-guia'
const SECRETOS = {
  ACCESS_TOKEN_SECRET: 'a'.repeat(32),
  REFRESH_TOKEN_SECRET: 'r'.repeat(32),
  SESSION_SECRET: 'b'.repeat(32),
  COOKIE_SECRET: 'c'.repeat(32),
  OTP_PEPPER: 'd'.repeat(32),
}
/** Lo que sólo piden `probar` y `servir`: el túnel, el secreto del OAuth y la app piloto. */
const PARA_SERVIR = {
  BASE_URL: 'https://algo.trycloudflare.com',
  OAUTH_STATE_SECRET: 'f'.repeat(64),
  SHOPIFY_PILOTO_CLIENT_ID: 'id-de-prueba',
  SHOPIFY_PILOTO_CLIENT_SECRET: 'secreto-de-prueba',
  SHOPIFY_TOKEN_KEY: 'e'.repeat(64),
  SHOPIFY_PILOTO_SHOPS: 'avoqado-prueba-sync.myshopify.com',
}
const archivo = (o: Record<string, string> = {}) => ({
  DATABASE_URL: 'postgresql://usuario:clave-secreta@localhost:5432/av-db-25-shopify-guia',
  PORT: '3100',
  FRONTEND_URL: 'http://localhost:5180',
  ...SECRETOS,
  ...PARA_SERVIR,
  ...o,
})
const sin = (o: Record<string, string>, fuera: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !fuera.includes(k)))
const nadaExiste = () => false
const revisar = (o: Partial<Parameters<typeof revisarSandbox>[0]> = {}) =>
  revisarSandbox({ modo: 'servir', cwd: SANDBOX, envArchivo: archivo(), existe: nadaExiste, ...o })
const motivo = (r: ReturnType<typeof revisarSandbox>) => (r.ok ? '' : r.motivo)

describe('revisarSandbox', () => {
  it('el sandbox bien armado pasa y sólo devuelve el NOMBRE de la base', () => {
    expect(revisar()).toEqual({ ok: true, dbName: 'av-db-25-shopify-guia' })
  })

  it('🔴 corrido desde el repo (hay prisma/schema.prisma) se niega: ahí dotenv cargaría el .env de siempre', () => {
    const r = revisar({ cwd: '/repo', existe: p => p === path.join('/repo', 'prisma', 'schema.prisma') })
    expect(r.ok).toBe(false)
    expect(motivo(r)).toMatch(/carpeta del sandbox/)
  })

  it('sin .env del sandbox se niega', () => {
    expect(revisar({ envArchivo: null }).ok).toBe(false)
  })

  it('🔴 una llave fuera de la lista (credencial real) se niega y la nombra sin enseñar su valor', () => {
    const r = revisar({ envArchivo: archivo({ STRIPE_SECRET_KEY: 'sk_live_valor' }) })
    expect(r.ok).toBe(false)
    expect(motivo(r)).toContain('STRIPE_SECRET_KEY')
    expect(motivo(r)).not.toContain('sk_live_valor')
  })

  it('🔴 la base compartida se niega, y el motivo trae el nombre pero nunca la URL', () => {
    const r = revisar({ envArchivo: archivo({ DATABASE_URL: 'postgresql://usuario:clave-secreta@localhost:5432/av-db-25' }) })
    expect(r.ok).toBe(false)
    expect(motivo(r)).toContain('«av-db-25»')
    expect(motivo(r)).not.toMatch(/clave-secreta|localhost|usuario/)
  })

  it('una DATABASE_URL que no es URL se niega sin repetirla', () => {
    const r = revisar({ envArchivo: archivo({ DATABASE_URL: 'no-es-url-clave-secreta' }) })
    expect(r.ok).toBe(false)
    expect(motivo(r)).not.toContain('clave-secreta')
  })

  it('servir exige BASE_URL con HTTPS (el túnel): Shopify no devuelve el OAuth ni manda webhooks a http', () => {
    const r = revisar({ envArchivo: archivo({ BASE_URL: 'http://localhost:3100' }) })
    expect(r.ok).toBe(false)
    expect(motivo(r)).toMatch(/HTTPS/)
  })

  it('🔴 sin REFRESH_TOKEN_SECRET no se prepara ni se sirve: la app no importa sin él (R4-1)', () => {
    for (const modo of ['preparar', 'probar', 'servir'] as const) {
      const r = revisar({ modo, envArchivo: sin(archivo(), ['REFRESH_TOKEN_SECRET']) })
      expect(r.ok).toBe(false)
      expect(motivo(r)).toContain('REFRESH_TOKEN_SECRET')
    }
  })

  it('preparar no necesita todavía el túnel, el OAuth ni la app piloto; servir sí', () => {
    const sinServir = sin(archivo(), Object.keys(PARA_SERVIR))
    expect(revisar({ modo: 'preparar', envArchivo: sinServir }).ok).toBe(true)
    const r = revisar({ envArchivo: sinServir })
    expect(r.ok).toBe(false)
    expect(motivo(r)).toContain('SHOPIFY_PILOTO_CLIENT_ID')
  })

  it('🔴 probar y servir exigen OAUTH_STATE_SECRET: sin él no se puede firmar el `state` del OAuth (R2-1)', () => {
    for (const modo of ['probar', 'servir'] as const) {
      const r = revisar({ modo, envArchivo: sin(archivo(), ['OAUTH_STATE_SECRET']) })
      expect(r.ok).toBe(false)
      expect(motivo(r)).toContain('OAUTH_STATE_SECRET')
    }
  })

  it('🔴 sólo acepta un Postgres LOCAL (localhost, 127.0.0.1 o ::1), y no lo dice con la URL (ronda 1)', () => {
    const conHost = (url: string) => revisar({ envArchivo: archivo({ DATABASE_URL: url }) })
    for (const ok of [
      'postgresql://u:clave-secreta@localhost:5432/av-db-25-shopify-guia',
      'postgresql://u:clave-secreta@127.0.0.1:5432/av-db-25-shopify-guia',
      'postgresql://u:clave-secreta@[::1]:5432/av-db-25-shopify-guia',
      'postgresql://u:clave-secreta@localhost:5432/av-db-25-shopify-guia?host=localhost',
    ]) {
      expect(conHost(ok)).toEqual({ ok: true, dbName: 'av-db-25-shopify-guia' })
    }
    for (const fuera of [
      'postgresql://u:clave-secreta@db.render.com:5432/av-db-25-shopify-guia',
      'postgresql://u:clave-secreta@10.0.0.5:5432/av-db-25-shopify-guia',
      // Prisma y libpq aceptan `host=` en la query: ganaría sobre el de la URL.
      'postgresql://u:clave-secreta@localhost:5432/av-db-25-shopify-guia?host=db.render.com',
      'postgresql://u:clave-secreta@localhost:5432/av-db-25-shopify-guia?sslmode=require&host=10.0.0.5',
      'postgresql://u:clave-secreta@localhost:5432/av-db-25-shopify-guia?hostaddr=10.0.0.5',
    ]) {
      const r = conHost(fuera)
      expect(r.ok).toBe(false)
      expect(motivo(r)).toMatch(/local/)
      expect(motivo(r)).not.toMatch(/clave-secreta|render|10\.0\.0\.5/)
    }
  })
})

describe('entornoSandbox', () => {
  it('🔴 nada de la terminal sobrevive salvo lo básico; manda el archivo, RabbitMQ apagado y Stripe y OpenAI SINTÉTICOS (R2-2, R3-4)', () => {
    const env = entornoSandbox(
      {
        PATH: '/usr/bin',
        HOME: '/Users/x',
        TSX_TSCONFIG_PATH: '/wt/tsconfig.json',
        DATABASE_URL: 'postgresql://compartida/av-db-25',
        USE_RENDER_DB: 'true',
        REFRESH_TOKEN_SECRET: 'el-de-la-terminal',
        STRIPE_SECRET_KEY: 'sk_live_real',
        OPENAI_API_KEY: 'sk-real-de-la-terminal',
        RESEND_API_KEY: 're_real',
      },
      archivo(),
    )
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/Users/x')
    expect(env.TSX_TSCONFIG_PATH).toBe('/wt/tsconfig.json')
    expect(env.DATABASE_URL).toBe(archivo().DATABASE_URL)
    expect(env.OAUTH_STATE_SECRET).toBe(PARA_SERVIR.OAUTH_STATE_SECRET)
    // R4-1: `jwt.service.ts` lanza al importarse sin él; sobrevive al saneamiento y es el del sandbox, nunca el de la terminal.
    expect(env.REFRESH_TOKEN_SECRET).toBe(SECRETOS.REFRESH_TOKEN_SECRET)
    expect(env.USE_RENDER_DB).toBeUndefined()
    expect(env.RESEND_API_KEY).toBeUndefined()
    // La app construye `new Stripe(...)` al importarse: va una llave que no es de ninguna cuenta, nunca la de la terminal.
    expect(env.STRIPE_SECRET_KEY).toBe(STRIPE_SINTETICA)
    // R3-4: dos singletons exigen la llave de OpenAI al importarse; también va SINTÉTICA.
    expect(env.OPENAI_API_KEY).toBe(OPENAI_SINTETICA)
    expect(env.DISABLE_RABBITMQ).toBe('true')
    expect(env.NODE_ENV).toBe('development')
    expect(env.RABBITMQ_URL).toBe('amqp://desactivado.invalid')
  })

  it('🔴 un NODE_OPTIONS o un SEED_RESET de la terminal no pasan (ronda 1): el primero metería código en cada hijo, el segundo cambia lo que siembra', () => {
    const env = entornoSandbox(
      { PATH: '/usr/bin', NODE_OPTIONS: '--require /tmp/otro-gancho.cjs', SEED_RESET: 'true', SEED_DAYS: '900' },
      archivo(),
    )
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.SEED_RESET).toBeUndefined()
    expect(env.SEED_DAYS).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })
})

describe('llavesAjenas', () => {
  it('🔴 tras importar la app, una llave que el sandbox no puso o que cambió se detecta por NOMBRE (nunca su valor)', () => {
    const esperado = entornoSandbox({ PATH: '/usr/bin' }, archivo())
    expect(llavesAjenas({ ...esperado }, esperado)).toEqual([])
    expect(llavesAjenas({ ...esperado, RENDER_DATABASE_URL: 'postgresql://prod', LOG_LEVEL: 'debug' }, esperado)).toEqual([
      'LOG_LEVEL',
      'RENDER_DATABASE_URL',
    ])
    expect(llavesAjenas({ ...esperado, DATABASE_URL: 'postgresql://otra/av-db-25' }, esperado)).toEqual(['DATABASE_URL'])
    // Si algo reemplazara una llave sintética por una real, también se detecta.
    expect(llavesAjenas({ ...esperado, OPENAI_API_KEY: 'sk-real' }, esperado)).toEqual(['OPENAI_API_KEY'])
  })
})

describe('el cliente de Prisma del sandbox (Codex N9)', () => {
  const ESQUEMA = [
    'generator client {',
    '  provider = "prisma-client-js"',
    '  // output   = "../src/generated/prisma"',
    '}',
    '',
    'datasource db {',
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    '}',
    '',
  ].join('\n')

  it('la copia del esquema genera el cliente DENTRO del sandbox (el `output` comentado no cuenta) y lo demás no cambia', () => {
    const nuevo = esquemaSandbox(ESQUEMA, '../cliente-prisma')
    expect(nuevo.match(/^[ \t]*output[ \t]*=.*$/gm)).toEqual(['  output   = "../cliente-prisma"'])
    expect(nuevo).toContain('datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}')
    expect(() => esquemaSandbox(nuevo, '../otro')).toThrow(/ya fija/)
  })

  it('🔴 con el gancho, `@prisma/client` es el cliente del sandbox aunque el repo tenga el suyo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avq-gancho-'))
    try {
      fs.mkdirSync(path.join(dir, 'cliente-prisma'))
      fs.writeFileSync(path.join(dir, 'cliente-prisma', 'index.js'), "module.exports = { soy: 'sandbox' }")
      const gancho = path.join(dir, 'prisma-hook.cjs')
      fs.writeFileSync(gancho, ganchoPrisma(path.join(dir, 'cliente-prisma', 'index.js')))
      // Desde la raíz del repo, donde `@prisma/client` sí se resolvería al cliente de siempre.
      const r = spawnSync(process.execPath, ['-r', gancho, '-e', "process.stdout.write(require('@prisma/client').soy)"], {
        cwd: RAIZ_REPO,
        encoding: 'utf8',
      })
      expect(r.stdout).toBe('sandbox')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('el túnel (ronda 1): por el puerto público sólo pasa lo que Shopify necesita', () => {
  const RUTAS = rutasDelTunel(SHOPIFY_OAUTH_CALLBACK_PATH, SHOPIFY_WEBHOOK_ROUTE)
  const WEBHOOK = SHOPIFY_WEBHOOK_ROUTE.replace(':appKey', 'piloto')
  const CALLBACK = SHOPIFY_OAUTH_CALLBACK_PATH
  const vistas: { method?: string; url?: string; cuerpo: string }[] = []
  const bitacora: string[] = []
  let server: http.Server
  let puerto = 0

  beforeAll(async () => {
    // La «app» de mentira contesta 200 y anota lo que le llegó: si una ruta prohibida la alcanza, se ve aquí.
    const app: http.RequestListener = (req, res) => {
      const partes: Buffer[] = []
      req.on('data', (c: Buffer) => partes.push(c))
      req.on('end', () => {
        vistas.push({ method: req.method, url: req.url, cuerpo: Buffer.concat(partes).toString('utf8') })
        res.statusCode = 200
        res.end('app')
      })
    }
    server = crearTunel(app, RUTAS, linea => bitacora.push(linea))
    await new Promise<void>(listo => server.listen(0, '127.0.0.1', () => listo()))
    puerto = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>(listo => server.close(() => listo()))
  })
  beforeEach(() => {
    vistas.length = 0
    bitacora.length = 0
  })

  /** La ruta viaja CRUDA (sin normalizar), como la mandaría cualquiera por el túnel. */
  const pedir = (method: string, ruta: string, cuerpo?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: puerto,
          method,
          path: ruta,
          agent: false,
          headers: cuerpo ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(cuerpo) } : {},
        },
        res => {
          const partes: Buffer[] = []
          res.on('data', (c: Buffer) => partes.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(partes).toString('utf8') }))
        },
      )
      req.on('error', reject)
      if (cuerpo) req.write(cuerpo)
      req.end()
    })

  it('deja pasar exactamente GET /health, GET del callback del OAuth (con su query) y POST del webhook (cuerpo intacto)', async () => {
    expect(await pedir('GET', '/health')).toEqual({ status: 200, body: 'app' })
    const query = '?code=abc&hmac=f00&host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUveA%3D%3D&shop=x.myshopify.com&state=st&timestamp=1'
    expect(await pedir('GET', `${CALLBACK}${query}`)).toEqual({ status: 200, body: 'app' })
    const cuerpo = '{"inventory_item_id": 1, "nombre":"ñandú é"}'
    expect(await pedir('POST', WEBHOOK, cuerpo)).toEqual({ status: 200, body: 'app' })
    expect(vistas).toEqual([
      { method: 'GET', url: '/health', cuerpo: '' },
      { method: 'GET', url: `${CALLBACK}${query}`, cuerpo: '' },
      { method: 'POST', url: WEBHOOK, cuerpo },
    ])
  })

  it('🔴 /api/dev/generate-token (firma tokens de SUPERADMIN sin sesión en desarrollo) y las rutas del dashboard dan 404 sin cuerpo', async () => {
    const casos: [string, string, string?][] = [
      ['POST', '/api/dev/generate-token', '{"role":"SUPERADMIN"}'],
      ['GET', '/api/dev/generate-token'],
      ['GET', '/api/v1/dashboard/venues/v1/shopify/overview'],
      ['POST', '/api/v1/dashboard/auth/login', '{"email":"superadmin@superadmin.com","password":"superadmin"}'],
      ['POST', '/api/v1/dashboard/venues/v1/shopify/connect/start', '{}'],
      ['GET', '/api/public/healthcheck'],
      ['POST', '/api/v1/webhooks/stripe', '{}'],
    ]
    for (const [method, ruta, cuerpo] of casos) {
      expect([method, ruta, await pedir(method, ruta, cuerpo)]).toEqual([method, ruta, { status: 404, body: '' }])
    }
    expect(vistas).toEqual([])
  })

  it('🔴 ningún truco de ruta se cuela: `..`, codificados, barra final, doble barra, mayúsculas, `#`, `\\` ni forma absoluta', async () => {
    const casos: [string, string][] = [
      ['GET', `${CALLBACK}/../../dev/generate-token`],
      ['POST', `${CALLBACK}/../../dev/generate-token`],
      ['GET', `${CALLBACK}/%2e%2e/%2e%2e/dev/generate-token`],
      ['GET', `${CALLBACK}%2F..%2F..%2Fdev%2Fgenerate-token`],
      ['GET', `${CALLBACK}/%2E%2E%2F%2E%2E%2Fdev%2Fgenerate-token`],
      ['GET', '/api/v1/shopify/oauth/%63allback'],
      ['GET', `${CALLBACK}/`],
      ['GET', `${CALLBACK};x`],
      ['GET', `/${CALLBACK}`],
      ['GET', CALLBACK.toUpperCase()],
      ['GET', '/health/'],
      ['GET', '//health'],
      ['GET', '/health/../api/dev/generate-token'],
      ['GET', '/health#/../api/dev/generate-token'],
      ['GET', '/health\\..\\api\\dev\\generate-token'],
      ['GET', '/HEALTH'],
      ['GET', 'http://127.0.0.1/health'],
      ['POST', `${WEBHOOK}/../../../dev/generate-token`],
      ['POST', `${WEBHOOK}/`],
      ['POST', '/api/v1/webhooks/shopify/pil%6fto'],
      ['POST', '/api/v1/webhooks/shopify/'],
      ['POST', '/api/v1/webhooks/shopify'],
      ['POST', '/api/v1/webhooks/shopify/piloto/extra'],
    ]
    for (const [method, ruta] of casos) {
      const r = await pedir(method, ruta, method === 'POST' ? '{}' : undefined)
      expect([method, ruta, r]).toEqual([method, ruta, { status: 404, body: '' }])
    }
    expect(vistas).toEqual([])
  })

  it('el método también cuenta: POST /health, GET del webhook, POST del callback, HEAD y PUT dan 404', async () => {
    expect((await pedir('POST', '/health', '{}')).status).toBe(404)
    expect((await pedir('GET', WEBHOOK)).status).toBe(404)
    expect((await pedir('POST', CALLBACK, '{}')).status).toBe(404)
    expect((await pedir('HEAD', '/health')).status).toBe(404)
    expect((await pedir('PUT', WEBHOOK, '{}')).status).toBe(404)
    expect(vistas).toEqual([])
  })

  it('🔴 de lo rechazado sólo se anota método y ruta: nunca la query ni el cuerpo', async () => {
    await pedir('POST', '/api/dev/generate-token?token=valor-secreto', '{"role":"SUPERADMIN","otro":"cuerpo-secreto"}')
    expect(bitacora).toHaveLength(1)
    expect(bitacora[0]).toContain('POST /api/dev/generate-token')
    expect(bitacora[0]).not.toMatch(/valor-secreto|cuerpo-secreto|SUPERADMIN|\?/)
  })
})

describe('las contraseñas conocidas del seed (ronda 1)', () => {
  type Fila = { id: string; password: string | null }
  /** Lector por tandas con cursor por id, como el de verdad. */
  const leerDe =
    (filas: Fila[], tanda = 2) =>
    async (despuesDe: string | null) =>
      filas
        .filter(f => despuesDe === null || f.id > despuesDe)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, tanda)

  it('🔴 la lista cubre CADA contraseña literal de prisma/seed.ts (si el seed agrega otra, esto falla)', () => {
    const seed = fs.readFileSync(path.join(RAIZ_REPO, 'prisma', 'seed.ts'), 'utf8')
    const literales = new Set<string>()
    for (const m of seed.matchAll(/password:\s*'([^']+)'/g)) literales.add(m[1])
    for (const m of seed.matchAll(/password:\s*suffix \|\| '([^']+)'/g)) literales.add(m[1])
    for (const m of seed.matchAll(/password:\s*suffix \? `[^`]*` : '([^']+)'/g)) literales.add(m[1])
    expect(literales.size).toBeGreaterThanOrEqual(10)
    for (const l of literales) expect(CLAVES_LITERALES_DEL_SEED).toContain(l)
    // Las únicas plantillas de contraseña del seed son las que `clavesDelSeed` deriva del slug.
    const plantillas = [...seed.matchAll(/password:\s*suffix \? `([^`]*)`/g)].map(m => m[1])
    expect(plantillas.sort()).toEqual(['waiter2.${suffix}', 'waiter3.${suffix}', 'waiter4.${suffix}'])
    // Y nada más asigna `password:` en el seed fuera de esas formas y del hash.
    const otras = [...seed.matchAll(/password:\s*([^\n,]+)/g)]
      .map(m => m[1].trim())
      .filter(v => !/^'[^']+'$/.test(v) && !/^suffix (\|\||\?)/.test(v) && !v.startsWith('await bcrypt.hash('))
    expect(otras).toEqual([])
  })

  it('suma las que el seed deriva del slug de cada sucursal (`suffix` = el slug sin «avoqado-»)', () => {
    const c = clavesDelSeed(['avoqado-full', 'play-telecom'])
    for (const k of [
      'superadmin',
      'owner',
      'Password123!',
      'full',
      'waiter2.full',
      'waiter4.full',
      'play-telecom',
      'waiter3.play-telecom',
    ]) {
      expect(c).toContain(k)
    }
    expect(new Set(c).size).toBe(c.length)
  })

  it('🔴 staffConClaveDelSeed cuenta las cuentas que todavía entran con una contraseña del seed (no las nulas ni las aleatorias)', async () => {
    const staff: Fila[] = [
      { id: 'a', password: bcrypt.hashSync('superadmin', 4) },
      { id: 'b', password: bcrypt.hashSync('waiter2.full', 4) },
      { id: 'c', password: bcrypt.hashSync('una-aleatoria-que-nadie-sabe', 4) },
      { id: 'd', password: null },
      { id: 'e', password: bcrypt.hashSync('Password123!', 4) },
    ]
    const comparar = (clave: string, hash: string) => bcrypt.compare(clave, hash)
    expect(await staffConClaveDelSeed(leerDe(staff), clavesDelSeed(['avoqado-full']), comparar)).toBe(3)
    expect(await staffConClaveDelSeed(leerDe(staff.slice(2, 4)), clavesDelSeed(['avoqado-full']), comparar)).toBe(0)
  })

  it('🔴 blindarClaves cambia la contraseña de TODAS las cuentas (también las nulas), cada una distinta, sin imprimir nada', async () => {
    const filas: Fila[] = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, password: i % 3 === 0 ? null : 'hash-del-seed' }))
    const escritas = new Map<string, string>()
    const consola = [jest.spyOn(console, 'log'), jest.spyOn(console, 'error'), jest.spyOn(console, 'warn')]
    try {
      let n = 0
      const total = await blindarClaves(
        leerDe(filas, 3),
        async (id, hash) => {
          escritas.set(id, hash)
        },
        async () => `hash-${n++}`,
      )
      expect(total).toBe(7)
      expect([...escritas.keys()].sort()).toEqual(filas.map(f => f.id).sort())
      expect(new Set(escritas.values()).size).toBe(7)
      for (const espia of consola) expect(espia).not.toHaveBeenCalled()
    } finally {
      for (const espia of consola) espia.mockRestore()
    }
  })

  it('la contraseña nueva por omisión es un bcrypt de algo aleatorio: ninguna del seed entra con ella', async () => {
    const [h1, h2] = [await cifrarAzar(), await cifrarAzar()]
    expect(h1).toMatch(/^\$2[aby]\$10\$/)
    expect(h1).not.toBe(h2)
    for (const clave of CLAVES_LITERALES_DEL_SEED) expect(bcrypt.compareSync(clave, h1)).toBe(false)
  })
})

describe('los hijos del seed: el vigía del entorno y el NODE_OPTIONS (ronda 1)', () => {
  const enCarpeta = <T>(prefijo: string, fn: (dir: string) => T): T => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefijo))
    try {
      return fn(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  const conVigia = (codigo: string) =>
    enCarpeta('avq-vigia-', dir => {
      const vigia = path.join(dir, 'vigia.cjs')
      fs.writeFileSync(vigia, vigiaEntorno())
      return spawnSync(process.execPath, ['-r', vigia, '-e', codigo], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
    })

  it('un hijo que no toca el entorno sale con su propio código y sin ✋', () => {
    const limpio = conVigia('process.exitCode = 0')
    expect(limpio.status).toBe(0)
    expect(limpio.stderr).not.toMatch(/✋/)
    expect(conVigia('process.exit(3)').status).toBe(3)
  })

  it('🔴 si durante el hijo aparece o cambia una llave, sale con 1 y la nombra sin su valor', () => {
    const r = conVigia('process.env.RENDER_DATABASE_URL = "postgresql://prod-secreta"; process.env.PATH = "/otra"')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/✋/)
    expect(r.stderr).toContain('PATH, RENDER_DATABASE_URL')
    expect(r.stderr).not.toMatch(/prod-secreta|\/otra/)
    expect(conVigia('process.env.X = "1"; process.exit(0)').status).toBe(1)
  })

  it('🔴 NODE_OPTIONS lleva cada `--require` entre comillas: una carpeta con espacios no lo rompe', () => {
    enCarpeta('avq gancho con espacios ', dir => {
      const a = path.join(dir, 'a.cjs')
      const b = path.join(dir, 'b.cjs')
      fs.writeFileSync(a, "process.stdout.write('A')")
      fs.writeFileSync(b, "process.stdout.write('B')")
      expect(opcionesNodeHijo([a, b])).toBe(`--require ${JSON.stringify(a)} --require ${JSON.stringify(b)}`)
      const r = spawnSync(process.execPath, ['-e', ''], {
        env: { PATH: process.env.PATH, NODE_OPTIONS: opcionesNodeHijo([a, b]) },
        encoding: 'utf8',
      })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('AB')
    })
  })
})
