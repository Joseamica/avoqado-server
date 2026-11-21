/**
 * D662 parte 2 (v5): el interruptor «pausa sola desde <hora>» de la tienda en línea (`InterruptorDePlataforma`, clave `pausa-sola`).
 *
 * Es el PASO 3 al publicar (promesa v5, docs/audit/2026-11-18-tienda-abierta-cualquier-pantalla/plan-p2-v5-interruptor.md):
 *   1. publicar el SERVIDOR; 2. cuando Render diga «Live», esperar 2 minutos; 3. prenderlo con este script.
 * Prenderlo pone «desde» = ahora + 15 min (o más con --minutos): todos los servidores lo ven a la vez, sin redesplegar.
 *
 * Uso (sin --apply sólo dice qué haría):
 *   npx tsx scripts/pausa-sola-interruptor.ts --ver [--base render]
 *   npx tsx scripts/pausa-sola-interruptor.ts --prender [--minutos 20] --por <quién> [--base render] --apply --confirm-db <host:puerto/base/esquema>
 *   npx tsx scripts/pausa-sola-interruptor.ts --apagar --por <quién> [--base render] --apply --confirm-db <host:puerto/base/esquema>
 * 🔴 Contra producción (--base render) sólo con el «sí, en prod» del founder.
 *
 * Codex p2v5-r3 #4 y p2v5-r4 #3: escribir pide confirmar el DESTINO completo, `--confirm-db host:puerto/base/esquema`, igual al de la URL
 * que se va a usar (dos bases pueden compartir host, puerto o nombre, y `?schema=` cambia de esquema). `--base local` (o sin --base)
 * usa la regla de `_solo-base-local.ts` (esta máquina, puerto 5432, base de desarrollo); `--base render` sólo acepta un host de Postgres
 * de Render. El destino se imprime ANTES de conectar.
 */
import dotenv from 'dotenv'
import { esBaseLocal } from './_solo-base-local'

/** El host externo de un Postgres de Render: `dpg-<id>.<región>-postgres.render.com`. */
const HOST_DE_RENDER = /^dpg-[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9-]+-postgres\.render\.com$/

export type DestinoDeLaBase = { url: string; destino: string }

const leerValor = (argv: string[], bandera: string): string | undefined => {
  const i = argv.indexOf(bandera)
  return i >= 0 ? argv[i + 1] : undefined
}

/** `host:puerto/base/esquema` de una URL de Postgres; ningún error imprime la URL. */
function destinoDeLaUrl(url: string, variable: string): { destino: string; host: string } {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`${variable} no es una URL (su valor no se imprime).`)
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error(`${variable} no es una URL postgres:// o postgresql://.`)
  if (u.searchParams.has('host')) throw new Error(`${variable} trae «?host=», que manda la conexión a otro lado: no se usa.`)
  const baseDeDatos = decodeURIComponent(u.pathname.replace(/^\//, ''))
  if (!u.hostname || !baseDeDatos) throw new Error(`${variable} no trae host y nombre de base (su valor no se imprime).`)
  return { host: u.hostname, destino: `${u.hostname}:${u.port || '5432'}/${baseDeDatos}/${u.searchParams.get('schema') || 'public'}` }
}

/** Elige la base ANTES de que exista el cliente de Prisma: `local` usa DATABASE_URL y `render`, RENDER_DATABASE_URL. */
export function elegirBase(argv: string[], env: NodeJS.ProcessEnv): DestinoDeLaBase {
  const base = leerValor(argv, '--base') ?? 'local'
  if (base !== 'local' && base !== 'render') throw new Error(`--base sólo acepta «render» o «local» (recibí «${base}»).`)
  const variable = base === 'render' ? 'RENDER_DATABASE_URL' : 'DATABASE_URL'
  const url = env[variable]
  if (!url) throw new Error(`--base ${base}: falta ${variable} en el entorno.`)
  const { destino, host } = destinoDeLaUrl(url, variable)
  if (base === 'local') {
    const corte = esBaseLocal(url)
    if (!corte.ok) throw new Error(`--base local: ${corte.motivo}.`)
  } else if (!HOST_DE_RENDER.test(host)) {
    throw new Error(`--base render: «${host}» no es un Postgres de Render (dpg-….<región>-postgres.render.com).`)
  }
  return { url, destino }
}

/** Escribir pide confirmar exactamente el destino que se va a usar. */
export function revisarConfirmacion(argv: string[], d: DestinoDeLaBase): void {
  if (leerValor(argv, '--confirm-db') !== d.destino) {
    throw new Error(`--confirm-db debe ser exactamente el destino de la base (${d.destino}).`)
  }
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const destino = elegirBase(argv, env)
  console.log(`Base: ${destino.destino}`)
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
      console.log(`Simulación: no se escribió nada (agrega --apply --confirm-db ${destino.destino}).`)
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
