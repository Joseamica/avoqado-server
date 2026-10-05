/**
 * Conecta un venue con su sucursal de TotalPass desde la terminal (la pantalla del dashboard hace lo mismo).
 *
 * Uso:
 *   TOTALPASS_PLACE_API_KEY=… npx ts-node -r tsconfig-paths/register scripts/aggregators/connect-totalpass.ts \
 *     <venueId> <productId>=<planId> [<productId>=<planId> …]
 *
 * · La llave de la sucursal se lee SÓLO de la variable de entorno: como argumento quedaría en el historial del shell.
 * · Nunca imprime la llave ni las URLs de los webhooks (llevan el secreto).
 * · Usa el mismo servicio que el dashboard: identifica la sucursal antes de tocar nada en TotalPass, no le quita la
 *   sucursal a otro negocio, reutiliza el secreto de los webhooks al reconectar y valida que cada producto sea una CLASE
 *   del venue y cada plan, un plan de la sucursal.
 * · Deja ligadas EXACTAMENTE las clases que se pasan: una clase ligada antes que no venga en la lista se desliga.
 * · Termina con código distinto de 0 y un mensaje en español si algo no cuadra.
 */
import prisma from '@/utils/prismaClient'
import { connectTotalPass, setPassProductLinks } from '@/services/aggregators/passIntegrations.service'

export type PlanPair = { productId: string; planId: string }

const USO = 'uso: TOTALPASS_PLACE_API_KEY=… connect-totalpass.ts <venueId> <productId>=<planId> [<productId>=<planId> …]'

/** `<productId>=<planId>` con planId numérico; sin productos repetidos. */
export function parsePlanPairs(args: string[]): PlanPair[] {
  if (args.length === 0) throw new Error(`Falta al menos un par <productId>=<planId>.\n${USO}`)
  const seen = new Set<string>()
  return args.map(arg => {
    const m = /^([^=\s]+)=(\d+)$/.exec(arg)
    if (!m) throw new Error(`«${arg}» no es un par válido <productId>=<planId> (el planId es el número del plan de TotalPass).`)
    const [, productId, planId] = m
    if (seen.has(productId)) throw new Error(`El producto ${productId} viene repetido.`)
    seen.add(productId)
    return { productId, planId }
  })
}

/** Exportada para probarla; desde la terminal se llama con los argumentos y la variable de entorno. */
export async function main(argv: string[] = process.argv.slice(2), placeKeyRaw: string | undefined = process.env.TOTALPASS_PLACE_API_KEY) {
  const [venueId, ...rawPairs] = argv
  if (!venueId) throw new Error(`Falta el venueId.\n${USO}`)
  const pairs = parsePlanPairs(rawPairs)
  const placeKey = placeKeyRaw?.trim()
  if (!placeKey) throw new Error(`Falta la variable de entorno TOTALPASS_PLACE_API_KEY (la llave de la sucursal).\n${USO}`)

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, name: true } })
  if (!venue) throw new Error(`No existe el venue ${venueId}.`)

  const view = await connectTotalPass(venueId, placeKey, null)
  const linked = await setPassProductLinks(
    venueId,
    'TOTALPASS',
    pairs.map(p => ({ productId: p.productId, externalPlanId: p.planId })),
    null,
  )

  console.log(`✅ ${venue.name} quedó conectado a la sucursal de TotalPass «${view.externalPlaceName ?? '?'}».`)
  console.log('Planes de la sucursal:')
  for (const p of view.plans) console.log(`  ${p.id}  ${p.name ?? '(sin nombre)'}  [${p.code ?? 'sin código'}]`)
  console.log('Clases ligadas:')
  for (const l of linked.productLinks) console.log(`  ${l.productName} → plan ${l.externalPlanId}`)
  console.log('El job publicará las clases de los próximos 14 días en ≤ 10 min.')
}

// Sólo corre si se invoca directo; importarlo desde un test no dispara nada.
if (require.main === module) {
  main()
    .catch(err => {
      console.error(`❌ ${err?.message ?? err}`)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
