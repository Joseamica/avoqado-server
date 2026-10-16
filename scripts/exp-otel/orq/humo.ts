/**
 * EXPERIMENTO OTel — orquestador del HUMO (fase 1, sólo brazo A). Corre en el runner (host), después de `npm ci` y
 * `npm run build`. Monta la topología de `lib/comun.ts`, migra y siembra una plantilla desechable, clona la base,
 * arranca el server compilado con `npm start` y corre los actores. Deja en exp-out/: fixture.json, entorno-A.json,
 * humo-A.json (lo escribe el actor), servidor-A.log (stdout JSON del server, completo, incluido el apagado).
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  OUT,
  SRV,
  arrancarPostgres,
  arrancarServer,
  clonarBase,
  correrActores,
  corriendo,
  entornoDelServer,
  escribirJson,
  log,
  logsDe,
  psql,
  redInterna,
  sh,
  urlHost,
  urlRed,
  verificarSinSalida,
  SECRETOS,
  sleep,
} from '../lib/comun'

const BRAZO = 'A'
const PLANTILLA = 'exp_plantilla'

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  log('red interna + Postgres 16')
  redInterna()
  await arrancarPostgres()
  psql('postgres', `CREATE DATABASE ${PLANTILLA}`)

  log('migraciones (prisma migrate deploy) contra la plantilla desechable')
  const tMig = Date.now()
  sh(`npx prisma migrate deploy`, { env: { DATABASE_URL: urlHost(PLANTILLA), USE_RENDER_DB: 'false' } })
  const migracionMs = Date.now() - tMig

  log('fixture preregistrado')
  const fixture = sh(`node_modules/.bin/tsx scripts/exp-otel/fixture/sembrar.ts`, { env: { DATABASE_URL: urlHost(PLANTILLA) } })
  fs.writeFileSync(path.join(OUT, 'fixture.json'), fixture)

  const db = `corrida_${BRAZO.toLowerCase()}_1`
  clonarBase(PLANTILLA, db)

  log(`server brazo ${BRAZO}: npm start (cgroup 1 CPU / 2 GB, red interna)`)
  const env = entornoDelServer(db)
  const t0 = Date.now()
  arrancarServer(SRV, env)
  await sleep(3000)
  if (!corriendo(SRV)) throw new Error(`el server murió al arrancar:\n${logsDe(SRV).slice(-6000)}`)
  const salida = verificarSinSalida(SRV)
  log('salida a internet desde el server:', salida)

  escribirJson(`entorno-${BRAZO}.json`, {
    brazo: BRAZO,
    nodeServer: sh(`docker exec ${SRV} node --version`, { quiet: true, allowFail: true }),
    imagen: sh(`docker inspect -f '{{.Config.Image}}' ${SRV}`, { quiet: true, allowFail: true }),
    cgroup: { cpus: 1, memoria: '2g' },
    // Sólo NOMBRES de variables: los valores son literales desechables, pero no se imprimen igual.
    variables: Object.keys(env).sort(),
    salidaAInternet: salida,
    migracionMs,
    commit: sh('git rev-parse HEAD', { quiet: true }),
  })

  log('actores (POS + TPV de script) en su propio contenedor')
  const codigo = correrActores('scripts/exp-otel/actores/humo.ts', {
    SERVER_URL: 'http://srv:3000',
    DATABASE_URL: urlRed(db),
    ACCESS_TOKEN_SECRET: SECRETOS.ACCESS_TOKEN_SECRET,
    FIXTURE: path.join(OUT, 'fixture.json'),
    OUT_DIR: OUT,
    BRAZO,
    N_COBROS: process.env.N_COBROS || '5',
    SERVER_T0_MS: String(t0),
  })

  const vivo = corriendo(SRV)
  log(`server ${vivo ? 'sigue vivo' : 'MURIÓ durante el humo'}; apagado con SIGTERM (flush)`)
  sh(`docker stop -t 30 ${SRV}`, { quiet: true, allowFail: true })
  fs.writeFileSync(path.join(OUT, `servidor-${BRAZO}.log`), logsDe(SRV))
  const exit = sh(`docker inspect -f '{{.State.ExitCode}}' ${SRV}`, { quiet: true, allowFail: true })
  log(`código de salida del server tras SIGTERM: ${exit}`)
  if (codigo !== 0) process.exit(codigo)
  if (!vivo) process.exit(3)
}

main().catch(e => {
  console.error('❌ orquestador:', e)
  try {
    fs.writeFileSync(path.join(OUT, `servidor-${BRAZO}.log`), logsDe(SRV))
  } catch {
    /* sin server */
  }
  process.exit(1)
})
