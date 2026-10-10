// tests/unit/scripts/shopify-sandbox-arranque.test.ts
/**
 * El sandbox importa la app y el worker REALES con el entorno saneado, y las llaves sintéticas (Stripe, OpenAI) siguen en
 * su lugar (Codex R3-4). Sin base (nadie se conecta: el puerto 1 no escucha), sin proveedores y sin el `.env` del repo:
 * corre en una carpeta temporal con su propio `.env` sintético y el cliente de Prisma del sandbox. Lenta: genera ese
 * cliente e importa toda la app (~1-2 min).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.join(__dirname, '../../..')
const correr = (dir: string, modo: 'cliente' | 'probar') =>
  spawnSync(
    path.join(REPO, 'node_modules', '.bin', 'tsx'),
    ['--tsconfig', path.join(REPO, 'tsconfig.json'), path.join(REPO, 'scripts', 'shopify-sandbox-server.ts'), modo],
    // Sólo lo básico de la terminal: el script vacía el resto de todos modos.
    { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', timeout: 240_000 },
  )

it('🔴 `probar` importa la app y el worker reales con el entorno del sandbox y Stripe y OpenAI sintéticos (R3-4)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avq-shopify-sandbox-'))
  try {
    fs.writeFileSync(
      path.join(dir, '.env'),
      [
        'DATABASE_URL=postgresql://nadie@127.0.0.1:1/av-db-25-shopify-prueba',
        'PORT=3999',
        'BASE_URL=https://sandbox.invalid',
        'FRONTEND_URL=http://localhost:5999',
        ...['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET', 'SESSION_SECRET', 'COOKIE_SECRET', 'OTP_PEPPER', 'OAUTH_STATE_SECRET'].map(
          k => `${k}=${'s'.repeat(64)}`,
        ),
        'SHOPIFY_PILOTO_CLIENT_ID=prueba',
        'SHOPIFY_PILOTO_CLIENT_SECRET=prueba',
        `SHOPIFY_TOKEN_KEY=${'e'.repeat(64)}`,
        'SHOPIFY_PILOTO_SHOPS=prueba.myshopify.com',
        '',
      ].join('\n'),
    )
    expect(correr(dir, 'cliente').status).toBe(0)
    const r = correr(dir, 'probar')
    expect(r.stderr).not.toMatch(/✋/)
    expect(r.stdout).toContain('Importación revisada')
    expect(r.status).toBe(0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 300_000)
