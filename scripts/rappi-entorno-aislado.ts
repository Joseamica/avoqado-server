/**
 * Entorno aislado para el recorrido real en el sandbox de Rappi (Tarea 7 del plan «Rappi fase 2»).
 *
 * El servidor del recorrido se arranca con `DEMO_MODE=true` y `DISABLE_RABBITMQ=true` para que no corra NINGÚN cron, y apunta a una
 * COPIA de la base (`av-db-25-rappi-f2-test`). Este script pone lo que ese servidor no trae:
 *
 *   npx tsx scripts/rappi-entorno-aislado.ts vincular --tienda <storeId> --venue <venueId>
 *   npx tsx scripts/rappi-entorno-aislado.ts jobs
 *
 *   · `vincular`: deja la tienda de Rappi ligada a un venue de la copia (vínculo RAPPI, ACTIVE, AUTO, `autoSyncMenu`). Idempotente: una
 *     segunda corrida con la misma tienda actualiza el mismo vínculo (la clave única es proveedor + tienda).
 *   · `jobs`: corre, cada `INTERVALO_JOBS_MS`, la pasada única (`runOnce()`) de los tres jobs de reparto que `DEMO_MODE` apaga en el
 *     servidor. Se queda corriendo hasta Ctrl+C (SIGINT) o SIGTERM.
 *
 * 🔴 SE NIEGA A CORRER si la base no es la copia de este recorrido. Dos candados, los dos tienen que pasar y NINGUNO imprime la URL
 * (trae la contraseña): (1) el NOMBRE de la base de `DATABASE_URL` tiene que contener `rappi-f2`, porque `exigirBaseLocal()` deja pasar
 * `av-db-25`, la base compartida por todas las sesiones; (2) `exigirBaseLocalDeVerdad` (URL local y, además, el clúster al que de verdad
 * se conectó, que un túnel no puede falsificar). Esa segunda pide `AVQ_LOCAL_DB_ID` en el entorno: si falta, aborta e imprime el
 * identificador del clúster para copiarlo DESPUÉS de comprobar a mano que es la Postgres local.
 *
 * Los secretos nunca salen: `vincular` ni siquiera LEE el `webhookSecret` (no está en su `select`), y los jobs no imprimen nada más que
 * contadores y mensajes de error.
 *
 * Este archivo se corre a mano; no hay prueba de la parte que toca la base. Lo que decide (la guarda por nombre y los argumentos) es
 * función pura y se prueba en `tests/unit/scripts/rappiEntornoAislado.test.ts`.
 */
import crypto from 'crypto'
import dotenv from 'dotenv'
import { parseArgs } from 'util'

import { DeliveryChannelStatus, DeliveryProvider, OrderAcceptanceMode } from '@prisma/client'

import { exigirBaseLocalDeVerdad } from './_solo-base-local'

/** El nombre de la copia lleva esta marca; sin ella el script no corre. */
export const MARCA_BASE_AISLADA = 'rappi-f2'

/**
 * Cada cuánto corre una pasada de `jobs`. Constante con nombre a propósito: la Tarea 8 suma `reprocesarCarrilRappi()` cada 30 s, y
 * ese cambio es tocar esto (o sumar un segundo temporizador junto a éste), no buscar un número suelto.
 */
export const INTERVALO_JOBS_MS = 2 * 60_000

export const USO = [
  'Uso:',
  '  npx tsx scripts/rappi-entorno-aislado.ts vincular --tienda <storeId> --venue <venueId>',
  '  npx tsx scripts/rappi-entorno-aislado.ts jobs',
].join('\n')

// ── Lo que se decide sin tocar nada (probado) ───────────────────────────────────────────

/**
 * El nombre de la base de una URL de conexión, o `undefined` si no hay URL o no se puede leer. Parsea la URL y devuelve SÓLO el
 * nombre: lo demás (usuario, contraseña, host) no sale de aquí.
 */
export function nombreDeBase(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined
  try {
    const nombre = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''))
    return nombre || undefined
  } catch {
    return undefined
  }
}

/**
 * ¿Es la copia de este recorrido? Sí sólo si el NOMBRE de la base contiene `rappi-f2`. El motivo nunca incluye la URL: a lo más, el
 * nombre de la base, que no es secreto y es lo que hace falta para corregir el entorno.
 */
export function baseAislada(databaseUrl: string | undefined): { ok: boolean; motivo?: string } {
  if (!databaseUrl) return { ok: false, motivo: 'No hay DATABASE_URL definida' }
  const nombre = nombreDeBase(databaseUrl)
  if (!nombre) return { ok: false, motivo: 'No pude leer el nombre de la base en DATABASE_URL' }
  if (!nombre.includes(MARCA_BASE_AISLADA)) {
    return { ok: false, motivo: `La base "${nombre}" no contiene "${MARCA_BASE_AISLADA}": no es la copia de este recorrido` }
  }
  return { ok: true }
}

export type Orden = { cmd: 'vincular'; tienda: string; venue: string } | { cmd: 'jobs' }

/** Lee los argumentos (sin `node` ni el script). Un subcomando desconocido, una opción de más o un valor que falta es un `error`. */
export function interpretarArgumentos(argv: string[]): Orden | { error: string } {
  let parsed: { values: { tienda?: string; venue?: string }; positionals: string[] }
  try {
    parsed = parseArgs({
      args: argv,
      options: { tienda: { type: 'string' }, venue: { type: 'string' } },
      strict: true,
      allowPositionals: true,
    })
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'argumentos ilegibles' }
  }
  const { values, positionals } = parsed
  const [cmd, ...resto] = positionals
  if (!cmd) return { error: 'Falta el subcomando (vincular o jobs).' }
  if (resto.length > 0) return { error: `Sobra: ${resto.join(' ')}` }

  if (cmd === 'jobs') {
    if (values.tienda !== undefined || values.venue !== undefined) return { error: '"jobs" no recibe --tienda ni --venue.' }
    return { cmd: 'jobs' }
  }
  if (cmd === 'vincular') {
    const tienda = values.tienda?.trim()
    const venue = values.venue?.trim()
    if (!tienda || !venue) return { error: '"vincular" necesita --tienda y --venue.' }
    return { cmd: 'vincular', tienda, venue }
  }
  return { error: `Subcomando desconocido: ${cmd}` }
}

// ── vincular ────────────────────────────────────────────────────────────────────────────

type ClientePrisma = typeof import('../src/utils/prismaClient').default

async function vincular(prisma: ClientePrisma, tienda: string, venueId: string): Promise<number> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true } })
  if (!venue) {
    console.error(`🔴 El venue ${venueId} no existe en esta base: no se vinculó nada.`)
    return 1
  }

  const clave = { provider: DeliveryProvider.RAPPI, externalLocationId: tienda }
  const antes = await prisma.deliveryChannelLink.findUnique({
    where: { provider_externalLocationId: clave },
    select: { id: true, venueId: true },
  })

  // El `select` deja FUERA `webhookSecret` a propósito: así ni un descuido lo imprime.
  const vinculo = await prisma.deliveryChannelLink.upsert({
    where: { provider_externalLocationId: clave },
    create: {
      // Sin `id`: lo pone Prisma (`@default(cuid())`, cuid v1). Nunca ids a mano.
      venueId,
      ...clave,
      // El mismo secreto aleatorio que inventa `rappi.provisioning.ts`. Sólo al crear: repetir `vincular` no lo rota.
      webhookSecret: crypto.randomBytes(32).toString('hex'),
      orderAcceptanceMode: OrderAcceptanceMode.AUTO,
      status: DeliveryChannelStatus.ACTIVE,
      autoSyncMenu: true,
    },
    // `snoozedUntil: null` quita una pausa que la copia pudiera traer de antes.
    update: {
      venueId,
      orderAcceptanceMode: OrderAcceptanceMode.AUTO,
      status: DeliveryChannelStatus.ACTIVE,
      autoSyncMenu: true,
      snoozedUntil: null,
    },
    select: { id: true, venueId: true, externalLocationId: true, status: true, orderAcceptanceMode: true, autoSyncMenu: true },
  })

  console.log(antes ? 'Vínculo RAPPI actualizado.' : 'Vínculo RAPPI creado.')
  if (antes && antes.venueId !== venueId) {
    console.log(`⚠️  La tienda estaba ligada a OTRO venue (${antes.venueId}); ahora quedó en ${venueId}.`)
  }
  console.log(`  vínculo:  ${vinculo.id}`)
  console.log(`  venue:    ${vinculo.venueId}`)
  console.log(`  tienda:   ${vinculo.externalLocationId}`)
  console.log(`  estado:   ${vinculo.status} · aceptación ${vinculo.orderAcceptanceMode} · autoSyncMenu ${vinculo.autoSyncMenu}`)
  return 0
}

// ── jobs ────────────────────────────────────────────────────────────────────────────────

/** Un paso de la pasada: qué job llama y con qué nombre de contexto (el MISMO que le da su cron en el servidor). */
type Paso = { nombre: string; contexto: string; correr: () => Promise<unknown> }

const ahora = () => new Date().toISOString()
const mensajeDe = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function jobs(prisma: ClientePrisma): Promise<void> {
  // Se importan aquí, DESPUÉS de las guardas: cargar estos módulos arrastra los servicios, el logger y la validación de `env`.
  const { runInJobContext } = await import('../src/observability/jobContext')
  const { deliveryWebhookReconciliationJob: reconciliacion } = await import('../src/jobs/delivery-webhook-reconciliation.job')
  const { deliveryLineActionReconcilerJob: lineas } = await import('../src/jobs/delivery-line-action-reconciler.job')
  const { deliveryMenuSyncJob: menu } = await import('../src/jobs/delivery-menu-sync.job')

  // NO se arrancan los crons (`start()`): se llama la pasada única de cada job.
  const pasos: Paso[] = [
    // Los dos carriles de `tick()` de la reconciliación (pedidos y aprovisionamiento); cada uno trae su propio candado.
    { nombre: 'pedidos', contexto: 'delivery-webhook-reconciliation', correr: () => reconciliacion.runOnce() },
    {
      nombre: 'aprovisionamiento',
      contexto: 'delivery-webhook-reconciliation',
      correr: async () => ({ resueltos: await reconciliacion.reprocesarAprovisionamientos() }),
    },
    { nombre: 'line-actions', contexto: 'delivery-line-action-reconciler', correr: () => lineas.runOnce() },
    { nombre: 'menu', contexto: 'deliveryMenuSync', correr: () => menu.runOnce() },
  ]

  /** Un job que falla no tumba la pasada ni a los demás: se anota y se sigue. NUNCA lanza. */
  async function ejecutar(paso: Paso): Promise<string> {
    try {
      // Un contexto de ejecución POR pasada, como lo abre el cron del propio job (correlationId nuevo cada vez).
      const contadores = await runInJobContext(paso.contexto, () => paso.correr())
      return `${paso.nombre}=${JSON.stringify(contadores)}`
    } catch (e) {
      console.error(`${ahora()} 🚨 el paso "${paso.nombre}" falló: ${mensajeDe(e)}`)
      return `${paso.nombre}=ERROR`
    }
  }

  let enPasada = false
  let numero = 0
  let cerrando = false

  async function pasada(): Promise<void> {
    // Una pasada a la vez: si la anterior sigue, ésta se salta (los jobs tienen además su candado propio).
    if (enPasada || cerrando) {
      console.log(`${ahora()} la pasada anterior sigue corriendo: se salta ésta`)
      return
    }
    enPasada = true
    const id = ++numero
    const inicio = Date.now()
    try {
      // Pasos en paralelo, como corren sus crons en el servidor: uno lento no retrasa a los demás.
      const partes = await Promise.all(pasos.map(ejecutar))
      console.log(`${ahora()} pasada #${id} (${Date.now() - inicio} ms): ${partes.join(' · ')}`)
    } finally {
      enPasada = false
    }
  }

  const temporizador = setInterval(() => void pasada(), INTERVALO_JOBS_MS)

  async function cerrar(senal: string): Promise<void> {
    if (cerrando) return
    cerrando = true
    clearInterval(temporizador)
    console.log(`${ahora()} ${senal}: se detiene y se desconecta la base`)
    try {
      await prisma.$disconnect()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void cerrar('SIGINT'))
  process.on('SIGTERM', () => void cerrar('SIGTERM'))

  console.log(`${ahora()} jobs de reparto cada ${INTERVALO_JOBS_MS / 1000} s (Ctrl+C para detener)`)
  void pasada() // la primera, ya; las siguientes las dispara el temporizador
}

// ── Principal ───────────────────────────────────────────────────────────────────────────

/** `salir: false` = el proceso se queda vivo a propósito (los `jobs` corren hasta una señal). */
async function main(argv: string[]): Promise<{ codigo: number; salir: boolean }> {
  const orden = interpretarArgumentos(argv)
  if ('error' in orden) {
    console.error(`${orden.error}\n${USO}`)
    return { codigo: 1, salir: true }
  }

  // El `.env` se carga ANTES de leer `DATABASE_URL`; lo que ya venga exportado en el entorno gana (dotenv no lo pisa).
  dotenv.config()

  const aislada = baseAislada(process.env.DATABASE_URL)
  if (!aislada.ok) {
    console.error('\n🔴 ABORTADO: este script sólo corre contra la copia de la base del recorrido de Rappi (`av-db-25-rappi-f2-test`).')
    console.error(`   ${aislada.motivo}\n`)
    return { codigo: 1, salir: true }
  }

  // Hasta aquí no se tocó nada. El cliente de Prisma se carga ya con la URL buena, y lo primero que hace es la guarda fuerte.
  const { default: prisma } = await import('../src/utils/prismaClient')
  await exigirBaseLocalDeVerdad(prisma)
  console.log(`Base: ${nombreDeBase(process.env.DATABASE_URL)}`)

  if (orden.cmd === 'jobs') {
    await jobs(prisma)
    return { codigo: 0, salir: false }
  }

  try {
    return { codigo: await vincular(prisma, orden.tienda, orden.venue), salir: true }
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(({ codigo, salir }) => {
      process.exitCode = codigo
      // Fuera de `jobs`, se sale explícito: el logger y el cliente de Prisma pueden dejar abierto algún recurso.
      if (salir) process.exit(codigo)
    })
    .catch(e => {
      console.error('💥', mensajeDe(e))
      process.exit(1)
    })
}
