/**
 * Entorno aislado para el recorrido real en el sandbox de Rappi (Tarea 7 del plan «Rappi fase 2»).
 *
 * El servidor del recorrido se arranca con `DEMO_MODE=true` y `DISABLE_RABBITMQ=true` para que no corra NINGÚN cron, y apunta a una
 * COPIA de la base (`av-db-25-rappi-f2-test`). Este script pone lo que ese servidor no trae:
 *
 *   npx tsx scripts/rappi-entorno-aislado.ts vincular --tienda <storeId> --venue <venueId> [--reapuntar]
 *   npx tsx scripts/rappi-entorno-aislado.ts jobs
 *
 *   · `vincular`: deja la tienda de Rappi ligada a un venue de la copia (vínculo RAPPI, ACTIVE, AUTO, `autoSyncMenu`). Idempotente: una
 *     segunda corrida con la misma tienda y el MISMO venue actualiza el mismo vínculo (la clave única es proveedor + tienda).
 *     🔴 Si la tienda ya estaba ligada a OTRO venue, NO la mueve: aborta con código 1 y explica. Con `--reapuntar` la mueve y además
 *     deja en null lo que era del venue anterior (`CAMPOS_AL_REAPUNTAR`: huella y fecha del último menú publicado, `config` y la
 *     activación en curso); sin eso, el menú del venue nuevo podría darse por «ya publicado» y la `config` seguiría hablando del viejo.
 *   · `jobs`: corre, cada `INTERVALO_JOBS_MS`, la pasada única (`runOnce()`) de los tres jobs de reparto que `DEMO_MODE` apaga en el
 *     servidor y, aparte, cada `INTERVALO_CARRIL_RAPPI_MS`, el carril propio de Rappi (`reprocesarCarrilRappi()`, Tarea 8): el que
 *     retoma en ≤ 90 s un pedido que quedó a medias. Se queda corriendo hasta Ctrl+C (SIGINT) o SIGTERM.
 *     🔴 Esos jobs NO filtran por proveedor (`syncableLinksWhere()` y `RECONCILABLE_PROVIDERS` incluyen Uber y Deliverect, y el sandbox
 *     de Uber escribe en producción). Por eso, al inicio de CADA pasada y de CADA vuelta del carril (las primeras incluidas) cuenta los
 *     vínculos ACTIVE por proveedor, imprime sólo esos conteos y, si hay alguno que no sea RAPPI, NO corre: lo dice con un 🚨 y sale con
 *     código 1. No arregla la copia.
 *
 * 🔴 SE NIEGA A CORRER si la base no es la copia de este recorrido. Tres candados, los tres tienen que pasar y NINGUNO imprime la URL
 * (trae la contraseña): (1) el NOMBRE de la base de `DATABASE_URL` tiene que contener `rappi-f2`, porque `exigirBaseLocal()` deja pasar
 * `av-db-25`, la base compartida por todas las sesiones; (2) `exigirBaseLocalDeVerdad` (URL local y, además, el clúster al que de verdad
 * se conectó, que un túnel no puede falsificar); (3) ya conectado, `SELECT current_database()` también tiene que contener `rappi-f2`,
 * para cerrar la guarda por el lado real y no sólo por el texto de la URL. La segunda pide `AVQ_LOCAL_DB_ID` en el entorno: si falta,
 * aborta e imprime el identificador del clúster para copiarlo DESPUÉS de comprobar a mano que es la Postgres local.
 *
 * Los secretos nunca salen: `vincular` ni siquiera LEE el `webhookSecret` (no está en su `select`), los jobs no imprimen nada más que
 * contadores y errores, y de un error sólo sale su PRIMERA línea (los de validación de Prisma traen los argumentos debajo).
 *
 * Este archivo se corre a mano; no hay prueba de la parte que toca la base. Lo que decide (la guarda por nombre, los argumentos, qué
 * hacer con un vínculo existente, cuándo `jobs` no corre y el recorte de errores) es función pura y se prueba en
 * `tests/unit/scripts/rappiEntornoAislado.test.ts`.
 */
import crypto from 'crypto'
import dotenv from 'dotenv'
import { parseArgs } from 'util'

import { DeliveryChannelStatus, DeliveryProvider, OrderAcceptanceMode, Prisma } from '@prisma/client'

import { exigirBaseLocalDeVerdad } from './_solo-base-local'

/** El nombre de la copia lleva esta marca; sin ella el script no corre. */
export const MARCA_BASE_AISLADA = 'rappi-f2'

/**
 * Cada cuánto corre una pasada de `jobs`. Constante con nombre a propósito: el carril de Rappi de la Tarea 8 va en su propio
 * temporizador (`INTERVALO_CARRIL_RAPPI_MS`), no cambiando éste.
 */
export const INTERVALO_JOBS_MS = 2 * 60_000

/** Cada cuánto corre el carril propio de Rappi (`reprocesarCarrilRappi()`), como su cron en el servidor (`15,45 * * * * *`). */
export const INTERVALO_CARRIL_RAPPI_MS = 30_000

export const USO = [
  'Uso:',
  '  npx tsx scripts/rappi-entorno-aislado.ts vincular --tienda <storeId> --venue <venueId> [--reapuntar]',
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
 * ¿Un NOMBRE de base es el de la copia de este recorrido? Sí sólo si contiene `rappi-f2`. Sirve para el nombre que sale de la URL y,
 * sobre todo, para el que contesta el servidor (`SELECT current_database()`). El motivo trae a lo más ese nombre, que no es secreto y es
 * lo que hace falta para corregir el entorno.
 */
export function nombreEsAislado(nombre: string | undefined): { ok: boolean; motivo?: string } {
  if (!nombre) return { ok: false, motivo: 'No pude leer el nombre de la base' }
  if (!nombre.includes(MARCA_BASE_AISLADA)) {
    return { ok: false, motivo: `La base "${nombre}" no contiene "${MARCA_BASE_AISLADA}": no es la copia de este recorrido` }
  }
  return { ok: true }
}

/** El primer candado: el nombre que dice la URL. El motivo nunca incluye la URL. */
export function baseAislada(databaseUrl: string | undefined): { ok: boolean; motivo?: string } {
  if (!databaseUrl) return { ok: false, motivo: 'No hay DATABASE_URL definida' }
  const nombre = nombreDeBase(databaseUrl)
  if (!nombre) return { ok: false, motivo: 'No pude leer el nombre de la base en DATABASE_URL' }
  return nombreEsAislado(nombre)
}

/**
 * De un error, sólo su PRIMERA línea con texto, recortada. Los errores de validación de Prisma empiezan con un salto de línea y traen
 * debajo la ruta y los argumentos de la llamada (ahí puede ir un secreto): nunca se imprime el mensaje entero.
 */
export function primeraLinea(e: unknown): string {
  const MAXIMO = 300
  const texto = e instanceof Error ? e.message : String(e)
  const linea = texto
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.length > 0)
  if (!linea) return 'error desconocido'
  return linea.length > MAXIMO ? `${linea.slice(0, MAXIMO)}…` : linea
}

export type Orden = { cmd: 'vincular'; tienda: string; venue: string; reapuntar: boolean } | { cmd: 'jobs' }

/** Lee los argumentos (sin `node` ni el script). Un subcomando desconocido, una opción de más o un valor que falta es un `error`. */
export function interpretarArgumentos(argv: string[]): Orden | { error: string } {
  let parsed: { values: { tienda?: string; venue?: string; reapuntar?: boolean }; positionals: string[] }
  try {
    parsed = parseArgs({
      args: argv,
      options: { tienda: { type: 'string' }, venue: { type: 'string' }, reapuntar: { type: 'boolean' } },
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
    if (values.tienda !== undefined || values.venue !== undefined || values.reapuntar !== undefined) {
      return { error: '"jobs" no recibe --tienda, --venue ni --reapuntar.' }
    }
    return { cmd: 'jobs' }
  }
  if (cmd === 'vincular') {
    const tienda = values.tienda?.trim()
    const venue = values.venue?.trim()
    if (!tienda || !venue) return { error: '"vincular" necesita --tienda y --venue.' }
    return { cmd: 'vincular', tienda, venue, reapuntar: values.reapuntar === true }
  }
  return { error: `Subcomando desconocido: ${cmd}` }
}

export type DecisionVinculo =
  | { accion: 'CREAR' }
  | { accion: 'ACTUALIZAR' }
  | { accion: 'REAPUNTAR'; venueAnterior: string }
  | { accion: 'ABORTAR'; venueAnterior: string; motivo: string }

/**
 * Qué hacer con el vínculo RAPPI de la tienda según lo que ya hay. Mismo venue o sin vínculo: como siempre. Otro venue: sólo con
 * `--reapuntar`; sin él se aborta, porque mover a escondidas un vínculo ajeno deja basura (huella de menú, `config`, activación) y
 * oculta un error de dedo en `--venue`.
 */
export function decidirVinculo(antes: { venueId: string } | null, venueId: string, reapuntar: boolean): DecisionVinculo {
  if (!antes) return { accion: 'CREAR' }
  if (antes.venueId === venueId) return { accion: 'ACTUALIZAR' }
  if (reapuntar) return { accion: 'REAPUNTAR', venueAnterior: antes.venueId }
  return {
    accion: 'ABORTAR',
    venueAnterior: antes.venueId,
    motivo:
      `La tienda ya está ligada a OTRO venue (${antes.venueId}) y pediste ${venueId}: no se tocó nada. ` +
      `Si de verdad quieres moverla, repite el comando con --reapuntar (además deja en null la huella del último menú, su fecha, ` +
      `la config y la activación en curso, que eran del venue anterior).`,
  }
}

/**
 * Lo que se deja en null al re-apuntar un vínculo a otro venue: todo lo que describe el estado del venue ANTERIOR. Los cinco campos
 * existen y son opcionales en `DeliveryChannelLink`; el tipo `Pick` hace que un nombre mal escrito no compile. `config` es JSON: se
 * vacía con `Prisma.DbNull`, no con `null`.
 */
export const CAMPOS_AL_REAPUNTAR: Pick<
  Prisma.DeliveryChannelLinkUpdateInput,
  'lastMenuHash' | 'lastMenuSyncAt' | 'config' | 'activatingIntentId' | 'activationOwner'
> = {
  lastMenuHash: null,
  lastMenuSyncAt: null,
  config: Prisma.DbNull,
  activatingIntentId: null,
  activationOwner: null,
}

export type ConteoPorProveedor = { provider: string; cantidad: number }

/** Los proveedores que NO son RAPPI y tienen al menos un vínculo ACTIVE: con alguno, `jobs` no corre. */
export function proveedoresAjenos(conteos: ConteoPorProveedor[]): ConteoPorProveedor[] {
  return conteos.filter(c => c.provider !== DeliveryProvider.RAPPI && c.cantidad > 0)
}

/** Lo único que se imprime de los vínculos: «PROVEEDOR=cantidad · …», o «ninguno». */
export function textoConteos(conteos: ConteoPorProveedor[]): string {
  return conteos.length === 0 ? 'ninguno' : conteos.map(c => `${c.provider}=${c.cantidad}`).join(' · ')
}

// ── vincular ────────────────────────────────────────────────────────────────────────────

type ClientePrisma = typeof import('../src/utils/prismaClient').default

async function vincular(prisma: ClientePrisma, tienda: string, venueId: string, reapuntar: boolean): Promise<number> {
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

  // 🔴 Antes de escribir nada: un vínculo ajeno no se mueve a escondidas.
  const decision = decidirVinculo(antes, venueId, reapuntar)
  if (decision.accion === 'ABORTAR') {
    console.error(`🔴 ${decision.motivo}`)
    return 1
  }

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
    // `snoozedUntil: null` quita una pausa que la copia pudiera traer de antes. Al re-apuntar, además, se limpia lo del venue anterior.
    update: {
      venueId,
      orderAcceptanceMode: OrderAcceptanceMode.AUTO,
      status: DeliveryChannelStatus.ACTIVE,
      autoSyncMenu: true,
      snoozedUntil: null,
      ...(decision.accion === 'REAPUNTAR' ? CAMPOS_AL_REAPUNTAR : {}),
    },
    select: { id: true, venueId: true, externalLocationId: true, status: true, orderAcceptanceMode: true, autoSyncMenu: true },
  })

  if (decision.accion === 'CREAR') console.log('Vínculo RAPPI creado.')
  else if (decision.accion === 'ACTUALIZAR') console.log('Vínculo RAPPI actualizado (mismo venue).')
  else {
    console.log(`Vínculo RAPPI re-apuntado: ${decision.venueAnterior} → ${venueId}.`)
    console.log(`  quedaron en null: ${Object.keys(CAMPOS_AL_REAPUNTAR).join(', ')}`)
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
      console.error(`${ahora()} 🚨 el paso "${paso.nombre}" falló: ${primeraLinea(e)}`)
      return `${paso.nombre}=ERROR`
    }
  }

  let enPasada = false
  let numero = 0
  let cerrando = false
  // El carril de Rappi lleva su propia bandera: una vuelta lenta no se encima con la siguiente, ni frena la pasada (ni al revés).
  let enVueltaRappi = false
  let numeroRappi = 0

  /** Vínculos ACTIVE por proveedor: una consulta agrupada, de a lo más un renglón por proveedor. */
  async function activosPorProveedor(): Promise<ConteoPorProveedor[]> {
    const filas = await prisma.deliveryChannelLink.groupBy({
      by: ['provider'],
      where: { status: DeliveryChannelStatus.ACTIVE },
      _count: { _all: true },
    })
    return filas.map(f => ({ provider: f.provider, cantidad: f._count._all }))
  }

  /**
   * 🔴 La guarda de proveedores, ANTES de cualquier job (de la pasada o del carril): estos jobs no filtran por proveedor, y un vínculo
   * ACTIVE de Uber o Deliverect en la copia los haría hablar con un proveedor real. Devuelve los conteos si es seguro correr; `null` si
   * no: con un ajeno, avisa y termina el proceso; si no se pudo contar, se salta ESTA vuelta (una caída pasajera no mata el proceso).
   */
  async function seguroCorrer(que: string): Promise<ConteoPorProveedor[] | null> {
    let conteos: ConteoPorProveedor[]
    try {
      conteos = await activosPorProveedor()
    } catch (e) {
      console.error(`${ahora()} 🚨 no pude contar los vínculos ACTIVE por proveedor (${primeraLinea(e)}): se salta ${que}`)
      return null
    }
    const ajenos = proveedoresAjenos(conteos)
    if (ajenos.length > 0) {
      console.error(
        `${ahora()} 🚨 hay vínculos ACTIVE de otros proveedores (${textoConteos(ajenos)}); activos: ${textoConteos(conteos)}. ` +
          'NO se corre ninguna pasada: estos jobs no filtran por proveedor y llamarían al proveedor real. ' +
          'Este script no arregla la copia: déjala solo con vínculos RAPPI y vuelve a arrancar.',
      )
      await cerrar('vínculos de otros proveedores', 1)
      return null
    }
    return conteos
  }

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
      // En CADA pasada (la primera incluida). Con un vínculo ajeno no corre nada y el proceso termina.
      const conteos = await seguroCorrer(`la pasada #${id}`)
      if (!conteos) return
      // Pasos en paralelo, como corren sus crons en el servidor: uno lento no retrasa a los demás.
      const partes = await Promise.all(pasos.map(ejecutar))
      console.log(`${ahora()} pasada #${id} (${Date.now() - inicio} ms) · activos: ${textoConteos(conteos)} · ${partes.join(' · ')}`)
    } finally {
      enPasada = false
    }
  }

  /** Una vuelta del carril de Rappi. Una a la vez (su bandera), con la misma guarda de proveedores, y NUNCA lanza. */
  async function vueltaRappi(): Promise<void> {
    if (enVueltaRappi || cerrando) return // la anterior sigue: ésta se salta en silencio (cada 30 s haría ruido)
    enVueltaRappi = true
    const id = ++numeroRappi
    const inicio = Date.now()
    try {
      if (!(await seguroCorrer(`la vuelta #${id} del carril de Rappi`))) return
      const resueltos = await runInJobContext('delivery-webhook-reconciliation-rappi', () => reconciliacion.reprocesarCarrilRappi())
      // Sólo cuando hizo algo: la pasada de cada 2 min ya dice que el proceso sigue vivo.
      if (resueltos > 0) console.log(`${ahora()} carril de Rappi #${id} (${Date.now() - inicio} ms) · resueltos=${resueltos}`)
    } catch (e) {
      console.error(`${ahora()} 🚨 la vuelta #${id} del carril de Rappi falló: ${primeraLinea(e)}`)
    } finally {
      enVueltaRappi = false
    }
  }

  const temporizador = setInterval(() => void pasada(), INTERVALO_JOBS_MS)
  const temporizadorRappi = setInterval(() => void vueltaRappi(), INTERVALO_CARRIL_RAPPI_MS)

  async function cerrar(motivo: string, codigo: number): Promise<void> {
    if (cerrando) return
    cerrando = true
    clearInterval(temporizador)
    clearInterval(temporizadorRappi)
    console.log(`${ahora()} ${motivo}: se detiene y se desconecta la base (código ${codigo})`)
    try {
      await prisma.$disconnect()
    } finally {
      process.exit(codigo)
    }
  }
  process.on('SIGINT', () => void cerrar('SIGINT', 0))
  process.on('SIGTERM', () => void cerrar('SIGTERM', 0))

  console.log(
    `${ahora()} jobs de reparto cada ${INTERVALO_JOBS_MS / 1000} s y carril de Rappi cada ${INTERVALO_CARRIL_RAPPI_MS / 1000} s ` +
      '(Ctrl+C para detener)',
  )
  void pasada() // la primera, ya; las siguientes las dispara el temporizador
  void vueltaRappi() // ídem el carril de Rappi
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

  // 🔴 Tercer candado, por el lado REAL: la URL es texto y puede decir una cosa y conectar a otra. Se le pregunta al servidor cómo se
  // llama la base a la que ESTE proceso está conectado. Es una lectura; sigue sin haberse escrito nada.
  const filas = await prisma.$queryRaw<Array<{ base: string }>>`SELECT current_database() AS base`
  const conectada = nombreEsAislado(filas[0]?.base)
  if (!conectada.ok) {
    console.error('\n🔴 ABORTADO: la URL decía otra cosa, pero la base a la que me conecté no es la copia del recorrido de Rappi.')
    console.error(`   ${conectada.motivo}\n`)
    await prisma.$disconnect().catch(() => undefined)
    return { codigo: 1, salir: true }
  }
  console.log(`Base: ${filas[0].base}`)

  if (orden.cmd === 'jobs') {
    await jobs(prisma)
    return { codigo: 0, salir: false }
  }

  try {
    return { codigo: await vincular(prisma, orden.tienda, orden.venue, orden.reapuntar), salir: true }
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
      console.error('💥', primeraLinea(e))
      process.exit(1)
    })
}
