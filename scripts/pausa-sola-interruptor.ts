/**
 * D662 parte 2 (v5): el interruptor «pausa sola desde <hora>» de la tienda en línea (`InterruptorDePlataforma`, clave `pausa-sola`).
 *
 * Es el PASO 3 al publicar (promesa v5, docs/audit/2026-11-18-tienda-abierta-cualquier-pantalla/plan-p2-v5-interruptor.md):
 *   1. publicar el SERVIDOR; 2. cuando Render diga «Live», esperar 2 minutos; 3. prenderlo con este script.
 * Prenderlo pone «desde» = ahora + 15 min (o más con --minutos): todos los servidores lo ven a la vez, sin redesplegar.
 *
 * Uso (sin --apply sólo dice qué haría):
 *   npx tsx scripts/pausa-sola-interruptor.ts --ver [--base render]
 *   npx tsx scripts/pausa-sola-interruptor.ts --prender [--minutos 20] --por <quién> [--base render] --apply --confirm-host <host>
 *   npx tsx scripts/pausa-sola-interruptor.ts --apagar --por <quién> [--base render] --apply --confirm-host <host>
 * 🔴 Contra producción (--base render) sólo con el «sí, en prod» del founder.
 */
import 'dotenv/config'

const leerValor = (bandera: string): string | undefined => {
  const i = process.argv.indexOf(bandera)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Elige la base ANTES de que exista el cliente de Prisma; ninguna URL se imprime. */
function elegirBase(): void {
  const base = leerValor('--base')
  if (base === undefined || base === 'local') return
  if (base !== 'render') throw new Error(`--base sólo acepta «render» o «local» (recibí «${base}»).`)
  if (!process.env.RENDER_DATABASE_URL) throw new Error('--base render: falta RENDER_DATABASE_URL en el entorno.')
  process.env.DATABASE_URL = process.env.RENDER_DATABASE_URL
}

function hostDeLaBase(): string {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? '').hostname
    } catch {
      return ''
    }
  })()
  if (!host) throw new Error('DATABASE_URL no es una URL con host (su valor no se imprime).')
  return host
}

async function main(): Promise<void> {
  elegirBase()
  const host = hostDeLaBase()
  // Después de elegir la base: el cliente de Prisma lee DATABASE_URL al crearse.
  const { default: prisma } = await import('../src/utils/prismaClient')
  const { apagarPausaSola, CLAVE_PAUSA_SOLA, prenderPausaSola } = await import('../src/services/online-ordering/interruptorPausaSola')
  try {
    const actual = await prisma.interruptorDePlataforma.findUnique({ where: { clave: CLAVE_PAUSA_SOLA } })
    console.log(`Base: ${host}`)
    console.log(
      actual?.desde
        ? `Hoy: PRENDIDA desde ${actual.desde.toISOString()} (por ${actual.actualizadoPor ?? '¿?'}, ${actual.updatedAt.toISOString()})`
        : 'Hoy: APAGADA (la tienda se porta como antes de la pausa sola)',
    )
    if (process.argv.includes('--ver')) return

    const prender = process.argv.includes('--prender')
    const apagar = process.argv.includes('--apagar')
    if (prender === apagar) throw new Error('Di --prender o --apagar (uno).')
    const por = leerValor('--por')
    if (!por) throw new Error('Falta --por <quién> (queda anotado).')
    const minutosTexto = leerValor('--minutos')
    const minutos = minutosTexto === undefined ? undefined : Number(minutosTexto)

    if (!process.argv.includes('--apply')) {
      console.log(prender ? `Haría: PRENDER desde ahora + ${minutos ?? 15} min.` : 'Haría: APAGAR.')
      console.log('Simulación: no se escribió nada (agrega --apply --confirm-host <host>).')
      return
    }
    if (leerValor('--confirm-host') !== host) throw new Error(`--confirm-host debe ser exactamente el host de la base (${host}).`)
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

main().catch(error => {
  console.error(`🔴 ${error instanceof Error ? error.message : String(error)} — no se escribió nada.`)
  process.exitCode = 1
})
