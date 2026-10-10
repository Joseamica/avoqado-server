// tests/unit/scripts/shopify-sandbox-server.test.ts
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  entornoSandbox,
  esquemaSandbox,
  ganchoPrisma,
  llavesAjenas,
  OPENAI_SINTETICA,
  revisarSandbox,
  STRIPE_SINTETICA,
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
