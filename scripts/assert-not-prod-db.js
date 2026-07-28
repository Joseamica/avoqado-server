#!/usr/bin/env node
/**
 * Guarda para `npm run migrate` (= `prisma migrate dev`).
 *
 * POR QUÉ EXISTE
 * --------------
 * `prisma migrate dev` es un comando de DESARROLLO: crea una "shadow database"
 * temporal en el mismo servidor para validar el historial de migraciones, y la
 * borra al terminar. Si el comando se interrumpe, la shadow queda huérfana.
 *
 * El 2026-07-28 encontramos DOS shadow DBs abandonadas en el servidor de
 * PRODUCCIÓN (15 MB y 21 MB), más un drift real de llave foránea en RecipeLine.
 * Ninguna de las dos cosas pudo venir de un deploy: producción corre
 * `prisma migrate deploy` (render.yaml), que nunca crea shadow DBs. Sólo pudieron
 * venir de alguien corriendo `migrate dev` con el DATABASE_URL apuntando a Render.
 *
 * Basta con tener el .env de producción a la mano y un despiste. Esta guarda
 * convierte ese despiste en un error claro en vez de basura silenciosa en prod.
 *
 * NO reemplaza al criterio: `migrate deploy` (el de producción) no pasa por aquí,
 * porque ese sí debe correr contra prod.
 */

const fs = require('fs')
const path = require('path')

/** Hosts que jamás deben recibir un `migrate dev`. */
const REMOTE_HOST_PATTERNS = [/\.render\.com$/i, /\.rds\.amazonaws\.com$/i, /\.supabase\.co$/i, /\.neon\.tech$/i, /\.pooler\./i]

/** Lo único que consideramos local. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal', 'postgres', 'db'])

function readEnvFile(key) {
  const envPath = path.join(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return undefined
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    if (trimmed.slice(0, eq).trim() !== key) continue
    return trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return undefined
}

const url = process.env.DATABASE_URL || readEnvFile('DATABASE_URL')

if (!url) {
  console.error('\n❌ No se encontró DATABASE_URL (ni en el entorno ni en .env).')
  console.error('   `prisma migrate dev` necesita saber contra qué base va a correr.\n')
  process.exit(1)
}

let host
try {
  host = new URL(url).hostname
} catch {
  console.error('\n❌ DATABASE_URL no es una URL válida. Revisa tu .env.\n')
  process.exit(1)
}

const isLocal = LOCAL_HOSTS.has(host)
const looksRemote = REMOTE_HOST_PATTERNS.some(re => re.test(host))

if (looksRemote || !isLocal) {
  console.error('\n🛑 BLOQUEADO: `prisma migrate dev` apunta a una base NO LOCAL.')
  console.error(`   host: ${host}`)
  console.error('')
  console.error('   `migrate dev` crea una shadow database temporal en ese servidor y,')
  console.error('   si se interrumpe, la deja huérfana. Ya pasó en producción: dos shadow')
  console.error('   DBs abandonadas (36 MB) y un drift de llave foránea en RecipeLine.')
  console.error('')
  console.error('   Si querías aplicar migraciones a un ambiente desplegado, ese comando')
  console.error('   es `npx prisma migrate deploy` — no crea shadow DBs.')
  console.error('   Si de verdad necesitas correr `migrate dev` contra un host remoto,')
  console.error('   ejecútalo a mano a sabiendas de lo que hace.\n')
  process.exit(1)
}

console.log(`✅ DATABASE_URL apunta a ${host} (local). Continuando con migrate dev...`)
