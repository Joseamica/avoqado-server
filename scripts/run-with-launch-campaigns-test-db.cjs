/* eslint-disable */
/**
 * Corre un comando contra una base DESECHABLE para las campañas ligeras de lanzamiento
 * (spec 2026-09-17 § 8.3). Crea → `prisma migrate deploy` → comando → `DROP … WITH (FORCE)` →
 * comprueba que la base ya no existe.
 *
 * 🔴 POR QUÉ EXISTE, y no es ceremonia: la base local `av-db-25` es UNA sola para TODOS los
 * worktrees, y el 2026-09-10 un `prisma migrate diff --shadow-database-url` cuya URL se armó con
 * `sed` la VACIÓ entera. Aquí el nombre de la base destino NO se deriva con regex: se construye
 * con `new URL` y se sustituye el `pathname` completo, y si el nombre resultante coincidiera con
 * el de la base de origen el script ABORTA antes de tocar nada.
 *
 * 🔴 El nombre de la base destino se IMPRIME antes de ejecutar. La URL, con sus credenciales,
 * NUNCA se imprime.
 *
 * Uso (desde la raíz del repo o del worktree):
 *   node scripts/run-with-launch-campaigns-test-db.cjs npx jest --selectProjects integration \
 *     --runInBand --runTestsByPath tests/integration/launch-campaigns/schema.integration.test.ts
 */
const { spawnSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const dotenv = require('dotenv')

// Un worktree no tiene `.env` propio (es un archivo ignorado por git), así que se cae al del
// árbol PRINCIPAL, que es el único sitio donde vive. 🔴 Nadie LEE ese archivo aquí: dotenv lo
// carga en `process.env` y de ahí sólo se usa la URL, que nunca se imprime.
function cargarEnv() {
  // Convención de dotenv: permite apuntar al archivo desde fuera (p. ej. una copia aislada para
  // correr sabotajes, que no es un repo git). Nadie lo lee aquí: se le pasa a dotenv.
  if (process.env.DOTENV_CONFIG_PATH && fs.existsSync(process.env.DOTENV_CONFIG_PATH)) {
    console.log('[desechable] credenciales locales tomadas de DOTENV_CONFIG_PATH')
    return dotenv.config({ path: process.env.DOTENV_CONFIG_PATH })
  }
  if (fs.existsSync('.env')) return dotenv.config()
  try {
    // stderr silenciado: fuera de un repo git esto imprimiría un «fatal:» que no es un error.
    const gitCommonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const principal = path.dirname(gitCommonDir)
    const envPrincipal = path.join(principal, '.env')
    if (fs.existsSync(envPrincipal)) {
      console.log(`[desechable] credenciales locales tomadas del árbol principal (${path.basename(principal)}/.env)`)
      return dotenv.config({ path: envPrincipal })
    }
  } catch {
    /* fuera de un repo git: se sigue con lo que ya haya en el entorno */
  }
  return dotenv.config()
}
cargarEnv()

const LOOPBACK = ['localhost', '127.0.0.1', '::1']
// Sufijo fijo + el pid, para que dos corridas simultáneas nunca compartan base.
const DB_NAME = `avq_launch_campaigns_test_${process.pid}`

async function main() {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('falta DATABASE_URL')

  // 🔴 Doble candado contra la base REMOTA: `prisma.config.ts` sustituye DATABASE_URL por
  // RENDER_DATABASE_URL cuando esta bandera está encendida. Aquí no se corrige: se aborta.
  if (process.env.USE_RENDER_DB === 'true') {
    throw new Error('USE_RENDER_DB=true: este script NUNCA corre contra la base remota. ABORTA.')
  }

  const source = new URL(raw)
  if (!LOOPBACK.includes(source.hostname)) {
    throw new Error('este script sólo corre contra una base LOCAL; la DATABASE_URL apunta a otro host')
  }

  // El nombre de la base de origen, sólo para comprobar que NO es el destino.
  const sourceDbName = decodeURIComponent(source.pathname.replace(/^\//, ''))
  if (sourceDbName === DB_NAME) {
    throw new Error('el nombre derivado coincide con la base de origen: ABORTA')
  }

  const target = new URL(raw)
  target.pathname = `/${DB_NAME}`
  target.search = ''
  target.hash = ''
  const targetUrl = target.toString()

  const maintenance = new URL(raw)
  maintenance.pathname = '/postgres'
  maintenance.search = ''
  maintenance.hash = ''

  // Lo único que se imprime son NOMBRES de base, nunca una URL con credenciales.
  console.log(`[desechable] base de origen (intacta): ${sourceDbName}`)
  console.log(`[desechable] base destino (se crea y se borra): ${DB_NAME}`)

  const admin = new Client({ connectionString: maintenance.toString() })
  await admin.connect()

  let commandStatus = 1
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`)
    await admin.query(`CREATE DATABASE "${DB_NAME}"`)
    console.log(`[desechable] creada ${DB_NAME}`)

    // Entorno hijo BLINDADO: ninguna variable heredada puede redirigir esto a Render ni a la
    // base compartida. Es el mismo blindaje de scripts/run-with-h1-test-db.cjs.
    const childEnv = {
      ...process.env,
      USE_RENDER_DB: 'false',
      DATABASE_URL: targetUrl,
      TEST_DATABASE_URL: targetUrl,
      SHADOW_DATABASE_URL: '',
      RENDER_DATABASE_URL: '',
      DIRECT_URL: '',
      DIRECT_DATABASE_URL: '',
    }

    const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { env: childEnv, stdio: 'inherit' })
    if (migrate.status !== 0) throw new Error(`prisma migrate deploy falló con código ${migrate.status}`)

    const [command, ...args] = process.argv.slice(2)
    if (!command) throw new Error('uso: node scripts/run-with-launch-campaigns-test-db.cjs <comando> [args...]')
    const result = spawnSync(command, args, { env: childEnv, stdio: 'inherit' })
    if (result.error) throw result.error
    commandStatus = result.status ?? 1
  } finally {
    // El borrado va en `finally`: una prueba roja NO puede dejar una base huérfana con el
    // esquema entero dentro.
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`)
    const check = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME])
    if (check.rowCount !== 0) throw new Error(`la base desechable ${DB_NAME} SIGUE EXISTIENDO tras el DROP`)
    console.log(`[desechable] borrada y verificada: ${DB_NAME} ya no existe`)
    await admin.end()
  }

  process.exit(commandStatus)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
