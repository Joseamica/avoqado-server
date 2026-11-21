/**
 * D662 parte 2 (v5): el interruptor «pausa sola desde <hora>» de la tienda en línea (`InterruptorDePlataforma`, clave `pausa-sola`).
 *
 * Es el PASO 3 al publicar (promesa v5, docs/audit/2026-11-18-tienda-abierta-cualquier-pantalla/plan-p2-v5-interruptor.md):
 *   1. publicar el SERVIDOR; 2. cuando Render diga «Live», esperar 2 minutos; 3. prenderlo con este script.
 * Prenderlo pone «desde» = ahora + 15 min (o más con --minutos): todos los servidores lo ven a la vez, sin redesplegar.
 *
 * Uso (sin --apply sólo dice qué haría):
 *   npx tsx scripts/pausa-sola-interruptor.ts --ver [--base render]
 *   npx tsx scripts/pausa-sola-interruptor.ts --prender [--minutos 20] --por <quién> [--base render] --apply --confirm-host <host> --confirm-db <base>
 *   npx tsx scripts/pausa-sola-interruptor.ts --apagar --por <quién> [--base render] --apply --confirm-host <host> --confirm-db <base>
 * 🔴 Contra producción (--base render) sólo con el «sí, en prod» del founder.
 *
 * Codex p2v5-r3 #4: confirmar sólo el host no basta (dos bases pueden compartirlo, y `local` heredaba una DATABASE_URL de Render).
 * Por eso `--base local` (o sin --base) exige una URL de esta máquina, `--base render` exige una que NO lo sea, y escribir pide
 * `--confirm-host` y `--confirm-db` iguales al host y al nombre de la base que se va a usar. Host y base se imprimen ANTES de conectar.
 */
import dotenv from 'dotenv'

const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export type DestinoDeLaBase = { url: string; host: string; baseDeDatos: string }

const leerValor = (argv: string[], bandera: string): string | undefined => {
  const i = argv.indexOf(bandera)
  return i >= 0 ? argv[i + 1] : undefined
}

/** Host y nombre de la base de una URL de Postgres; ninguna URL se imprime en el error. */
function partesDeLaUrl(url: string | undefined, variable: string): { host: string; baseDeDatos: string } {
  let host = ''
  let baseDeDatos = ''
  try {
    const u = new URL(url ?? '')
    host = u.hostname
    baseDeDatos = decodeURIComponent(u.pathname.replace(/^\//, ''))
  } catch {
    // se reporta abajo, sin el valor
  }
  if (!host || !baseDeDatos) throw new Error(`${variable} no es una URL con host y nombre de base (su valor no se imprime).`)
  return { host, baseDeDatos }
}

/**
 * Elige la base ANTES de que exista el cliente de Prisma. `local` (o sin --base) usa DATABASE_URL y exige que sea de esta máquina;
 * `render` usa RENDER_DATABASE_URL y exige que NO lo sea.
 */
export function elegirBase(argv: string[], env: NodeJS.ProcessEnv): DestinoDeLaBase {
  const base = leerValor(argv, '--base') ?? 'local'
  if (base !== 'local' && base !== 'render') throw new Error(`--base sólo acepta «render» o «local» (recibí «${base}»).`)
  const variable = base === 'render' ? 'RENDER_DATABASE_URL' : 'DATABASE_URL'
  const url = env[variable]
  if (!url) throw new Error(`--base ${base}: falta ${variable} en el entorno.`)
  const { host, baseDeDatos } = partesDeLaUrl(url, variable)
  const esLocal = HOSTS_LOCALES.has(host)
  if (base === 'local' && !esLocal) throw new Error(`--base local: ${variable} apunta a «${host}», que no es de esta máquina.`)
  if (base === 'render' && esLocal) throw new Error(`--base render: ${variable} apunta a «${host}», que es de esta máquina.`)
  return { url, host, baseDeDatos }
}

/** Escribir pide confirmar exactamente el host Y el nombre de la base que se van a usar. */
export function revisarConfirmacion(argv: string[], destino: DestinoDeLaBase): void {
  if (leerValor(argv, '--confirm-host') !== destino.host) {
    throw new Error(`--confirm-host debe ser exactamente el host de la base (${destino.host}).`)
  }
  if (leerValor(argv, '--confirm-db') !== destino.baseDeDatos) {
    throw new Error(`--confirm-db debe ser exactamente el nombre de la base (${destino.baseDeDatos}).`)
  }
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const destino = elegirBase(argv, env)
  console.log(`Base: ${destino.host} / ${destino.baseDeDatos}`)
  // Después de elegir la base: el cliente de Prisma lee DATABASE_URL al crearse.
  env.DATABASE_URL = destino.url
  const { default: prisma } = await import('../src/utils/prismaClient')
  const { apagarPausaSola, CLAVE_PAUSA_SOLA, prenderPausaSola } = await import('../src/services/online-ordering/interruptorPausaSola')
  try {
    const actual = await prisma.interruptorDePlataforma.findUnique({ where: { clave: CLAVE_PAUSA_SOLA } })
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
      console.log('Simulación: no se escribió nada (agrega --apply --confirm-host <host> --confirm-db <base>).')
      return
    }
    revisarConfirmacion(argv, destino)
    if (prender) {
      const desde = await prenderPausaSola({ por, minutos })
      console.log(`✅ PRENDIDA: la pausa sola cuenta desde ${desde.toISOString()} (pedidos con hora límite desde esa hora).`)
    } else {
      await apagarPausaSola({ por })
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
