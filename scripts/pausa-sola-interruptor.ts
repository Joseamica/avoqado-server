/**
 * D662 parte 2 (v5): el interruptor «pausa sola desde <hora>» de la tienda en línea (`InterruptorDePlataforma`, clave `pausa-sola`).
 *
 * Es el PASO 3 al publicar (promesa v5, docs/audit/2026-11-18-tienda-abierta-cualquier-pantalla/plan-p2-v5-interruptor.md):
 *   1. publicar el SERVIDOR; 2. cuando Render diga «Live», esperar 2 minutos; 3. prenderlo con este script.
 * Prenderlo pone «desde» = ahora + 15 min (o más con --minutos): todos los servidores lo ven a la vez, sin redesplegar.
 *
 * Uso (sin --apply sólo dice qué haría; --ver y la simulación imprimen la identidad que hay que confirmar):
 *   npx tsx scripts/pausa-sola-interruptor.ts --ver [--base render]
 *   npx tsx scripts/pausa-sola-interruptor.ts --prender [--minutos 20] --por <quién> [--base render] --apply --confirm-db <identidad>
 *   npx tsx scripts/pausa-sola-interruptor.ts --apagar --por <quién> [--base render] --apply --confirm-db <identidad>
 * La identidad es lo que la BASE dice que es, en una sola cadena sin espacios:
 *   `cluster:<system_identifier>/servidor:<dirección:puerto>/base:<current_database()>/esquema:<current_schema()>`
 * El servidor es la dirección y el puerto que atienden ESTA conexión: distingue una copia física, que conserva el clúster (r7 #2).
 * 🔴 Contra producción (--base render) sólo con el «sí, en prod» del founder.
 *
 * Rediseño tras Codex p2v5-r6 (cuatro rondas de la misma familia: el destino deducido de la URL no era el que abría Prisma; rutas
 * con `/`, letras codificadas, `search_path`, `DATABASE_CONNECTION_LIMIT`, un túnel a localhost). La URL ya no decide nada: `--base`
 * sólo elige la variable (y `local` pide un host de esta máquina, sin `?host=` ni `?hostaddr=`, como primera barrera). Lo que se
 * confirma es la identidad que contesta Postgres en la MISMA transacción que escribe, después del candado y antes de escribir, y sólo
 * en el esquema que lee la tienda.
 */
import dotenv from 'dotenv'
import type { Prisma } from '@prisma/client'

/** Primera barrera de `--base local`, no la confirmación: un túnel puede traer otra base a localhost (eso lo ataja la identidad). */
const HOSTS_DE_ESTA_MAQUINA = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export type IdentidadDeLaBase = { cluster: string; servidor: string; base: string; esquema: string | null }
type ConsultaCruda = Pick<Prisma.TransactionClient, '$queryRaw'>

const leerValor = (argv: string[], bandera: string): string | undefined => {
  const i = argv.indexOf(bandera)
  return i >= 0 ? argv[i + 1] : undefined
}

/** Qué variable usar: `local` → DATABASE_URL (de esta máquina), `render` → RENDER_DATABASE_URL. Ninguna URL se imprime. */
export function elegirBase(argv: string[], env: NodeJS.ProcessEnv): string {
  const base = leerValor(argv, '--base') ?? 'local'
  if (base !== 'local' && base !== 'render') throw new Error(`--base sólo acepta «render» o «local» (recibí «${base}»).`)
  const variable = base === 'render' ? 'RENDER_DATABASE_URL' : 'DATABASE_URL'
  const url = env[variable]
  if (!url) throw new Error(`--base ${base}: falta ${variable} en el entorno.`)
  if (base === 'local') {
    let host = ''
    let otroHost = false
    try {
      const u = new URL(url)
      host = u.hostname
      // Codex p2v5-r7 #3: con `?host=` (o `?hostaddr=`) Prisma conecta a ESE host aunque la dirección diga localhost.
      otroHost = u.searchParams.has('host') || u.searchParams.has('hostaddr')
    } catch {
      // se reporta abajo, sin el valor
    }
    if (!HOSTS_DE_ESTA_MAQUINA.has(host) || otroHost) {
      throw new Error('--base local: DATABASE_URL no apunta a esta máquina (su valor no se imprime).')
    }
  }
  return url
}

/** Quién es la base de ESTA conexión, según Postgres: el identificador del clúster (único por instalación), la base y el esquema. */
export async function leerIdentidad(db: ConsultaCruda): Promise<IdentidadDeLaBase> {
  const [fila] = await db.$queryRaw<IdentidadDeLaBase[]>`
    SELECT (SELECT system_identifier::text FROM pg_control_system()) AS cluster,
           coalesce(host(inet_server_addr()), 'socket') || ':' || coalesce(inet_server_port()::text, '-') AS servidor,
           current_database() AS base,
           current_schema() AS esquema`
  if (!fila?.cluster || !fila.servidor || !fila.base)
    throw new Error('La base no dijo quién es (clúster, servidor y nombre): no se escribe.')
  return fila
}

/** Una sola cadena, sin espacios (se copia tal cual en --confirm-db). */
export const textoDeIdentidad = (i: IdentidadDeLaBase): string =>
  `cluster:${i.cluster}/servidor:${i.servidor}/base:${i.base}/esquema:${i.esquema ?? '(ninguno)'}`

/** Lo que corre en la transacción que escribe: la base confirma quién es y que escribe en el esquema que lee la tienda. */
export function exigirIdentidad(confirmacion: string | undefined, esquemaDeLaTienda: string) {
  return async (tx: ConsultaCruda): Promise<void> => {
    const identidad = await leerIdentidad(tx)
    const texto = textoDeIdentidad(identidad)
    if (identidad.esquema !== esquemaDeLaTienda) {
      throw new Error(`Esta conexión trabaja en el esquema «${identidad.esquema}», no en «${esquemaDeLaTienda}» (el que lee la tienda).`)
    }
    if (confirmacion !== texto) throw new Error(`--confirm-db debe ser exactamente lo que contesta la base: ${texto}`)
  }
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const url = elegirBase(argv, env)
  // Antes de crear el cliente de Prisma: lo lee de DATABASE_URL al crearse.
  env.DATABASE_URL = url
  const { default: prisma } = await import('../src/utils/prismaClient')
  const servicio = await import('../src/services/online-ordering/interruptorPausaSola')
  try {
    const identidad = textoDeIdentidad(await leerIdentidad(prisma))
    console.log(`Base: ${identidad}`)
    const actual = await prisma.interruptorDePlataforma.findUnique({ where: { clave: servicio.CLAVE_PAUSA_SOLA } })
    console.log(
      actual?.desde
        ? `Hoy: PRENDIDA desde ${actual.desde.toISOString()} (por ${actual.actualizadoPor ?? '¿?'}, ${actual.updatedAt.toISOString()})`
        : 'Hoy: APAGADA (la tienda se porta como antes de la pausa sola)',
    )
    if (argv.includes('--ver')) return

    const prender = argv.includes('--prender')
    const apagar = argv.includes('--apagar')
    if (prender === apagar) throw new Error('Di --prender o --apagar (uno).')
    const por = leerValor(argv, '--por')
    if (!por) throw new Error('Falta --por <quién> (queda anotado).')
    const minutosTexto = leerValor(argv, '--minutos')
    const minutos = minutosTexto === undefined ? undefined : Number(minutosTexto)

    if (!argv.includes('--apply')) {
      console.log(prender ? `Haría: PRENDER desde ahora + ${minutos ?? 15} min.` : 'Haría: APAGAR.')
      console.log(`Simulación: no se escribió nada (agrega --apply --confirm-db ${identidad}).`)
      return
    }
    // La confirmación se revisa contra lo que contesta la base DENTRO de la transacción que escribe (no contra lo de arriba).
    const antesDeEscribir = exigirIdentidad(leerValor(argv, '--confirm-db'), servicio.ESQUEMA_DE_LA_TIENDA)
    if (prender) {
      const desde = await servicio.prenderPausaSola({ por, minutos, antesDeEscribir })
      console.log(`✅ PRENDIDA: la pausa sola cuenta desde ${desde.toISOString()} (pedidos con hora límite desde esa hora).`)
    } else {
      await servicio.apagarPausaSola({ por, antesDeEscribir })
      console.log('✅ APAGADA: en unos segundos la tienda se porta como antes de la pausa sola.')
    }
  } finally {
    await prisma.$disconnect()
  }
}

// Sólo corre si se invoca directo; importarlo desde una prueba no carga el .env ni conecta.
if (require.main === module) {
  dotenv.config()
  main().catch(error => {
    console.error(`🔴 ${error instanceof Error ? error.message : String(error)} — no se escribió nada.`)
    process.exitCode = 1
  })
}
