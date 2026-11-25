/**
 * Siembra la VERSIÓN 1 de la oferta de los planes (planes editables, B1): una foto de lo de hoy con los cuatro precios de las
 * llaves (`plan_pro_monthly`…) y las dos listas híbridas que venden `PLAN:PRO` y `PLAN:PREMIUM`.
 *
 *   export DATABASE_URL=<destino>      # OBLIGATORIO: dotenv nunca pisa un valor exportado; sin él se usa el .env
 *   npx ts-node -T -r tsconfig-paths/register scripts/seed-plan-offer-v1.ts                                  # simulación
 *   npx ts-node -T -r tsconfig-paths/register scripts/seed-plan-offer-v1.ts --apply --confirm-host <host> --confirm-db <nombre> [--staff <id>]
 *
 * `-T` (sólo transpilar) es obligatorio: un ts-node que revisa tipos se queda sin memoria con los tipos de Prisma.
 *
 * Sin --apply SÓLO LEE (la base y Stripe) e imprime el reporte: si se puede sembrar (CREATE), si ya existe (EXISTS) o qué
 * falta (MISSING, WRONG_PRODUCT, MISMATCH); los productos de los planes; y cuántas suscripciones vivas de plan reconoce cada
 * producto (por el catálogo, sólo por la llave o por nadie). 🔴 La Mac la corre contra producción ANTES de unir B1, cuando
 * esa base todavía no tiene las tablas de B1: entonces la revisión dice «sin versión (la base todavía no tiene las tablas de
 * B1)» y sigue. Con --apply, eso mismo es una negativa: primero la migración.
 *
 * Con --apply siembra sólo si la revisión dio CREATE (y vuelve a mirar las listas bajo sus candados). Con EXISTS no hace nada;
 * con otro resultado se niega (sale con 2) sin escribir.
 *
 * 🔴 Desde la v1, el precio de un plan sólo cambia publicando una versión (diseño «Planes editables», §15): nadie mueve llaves
 * `plan_*` ni archiva sus precios a mano, y `seed-plan-pro`, `seed-plan-premium` y `seed-plan-list-prices` se niegan.
 *
 * 🔴 Imprime primero el host y el nombre de la base de DATABASE_URL, y para escribir exige repetir LOS DOS en --confirm-host y
 * --confirm-db (el patrón de `seed-plan-list-prices.ts`). El cliente de Prisma se carga sólo después de esa comprobación.
 */
import { SeedRefusal, database } from './seed-plan-list-prices'
import type { ReporteDelSembrado, ResultadoDelSembrado } from '../src/services/billing/planOfferSeed'

export { SeedRefusal }

export interface SeedV1Options {
  apply: boolean
  confirmHost?: string
  confirmDb?: string
  staffId?: string
}

const pesos = (cents: number | null) => (cents === null ? 'sin monto' : `$${(cents / 100).toFixed(2)}`)

const RESUMEN: Record<ResultadoDelSembrado, (apply: boolean, versionId: string | null) => string> = {
  CREATE: (apply, versionId) => (apply ? `sembrada la versión 1 (${versionId})` : 'se sembraría la versión 1'),
  EXISTS: () => 'ya existe una versión vigente: no se revisó nada más y no se cambió nada',
  MISSING: () => 'falta algo (abajo): no se puede sembrar',
  WRONG_PRODUCT: () => 'un precio de llave vive en otro producto (abajo): no se puede sembrar',
  MISMATCH: () => 'algo no cuadra con lo de hoy (abajo): no se puede sembrar',
}

function imprimir(reporte: ReporteDelSembrado, apply: boolean, versionId: string | null, log: (line: string) => void) {
  if (reporte.sinTablasDeB1) log('Versión de la oferta: sin versión (la base todavía no tiene las tablas de B1)')
  log(`Resultado: ${reporte.resultado} — ${RESUMEN[reporte.resultado](apply, versionId)}`)
  if (reporte.ranuras.length) log('Precios de las llaves:')
  for (const r of reporte.ranuras)
    log(
      `  ${r.ranura} ${r.lookupKey} → ${r.priceId ?? 'sin precio'} en ${r.productId ?? '—'} (plan: ${r.productoEsperado ?? '—'}), ` +
        `${pesos(r.unitAmount)} (hoy ${pesos(r.esperado)}): ${r.resultado}${r.motivo ? ` · ${r.motivo}` : ''}`,
    )
  if (reporte.listas.length) log('Listas de los planes:')
  for (const l of reporte.listas)
    log(
      `  PLAN:${l.tier} ${l.publicationId ?? 'sin publicación'} ${l.price === null ? 'sin precio' : `$${l.price.toFixed(2)}`}: ` +
        `${l.resultado}${l.motivo ? ` · ${l.motivo}` : ''}`,
    )
  if (reporte.productos.length) log('Productos de los planes:')
  for (const p of reporte.productos) log(`  ${p.tier}: ${p.productId ?? 'sin producto'} «${p.nombre ?? 'sin nombre'}»`)
  if (reporte.resultado === 'EXISTS') return
  const vivas = reporte.suscripcionesVivas
  log(`Suscripciones vivas de plan: ${vivas.revisadas} revisadas` + (vivas.truncado ? ' (se detuvo en el tope: hay más sin revisar)' : ''))
  for (const s of vivas.porProducto) log(`  ${s.productId} · reconocida por ${s.reconocidoPor} · ${s.cuantas}`)
}

export async function seedPlanOfferV1(
  options: SeedV1Options,
  log: (line: string) => void = console.log,
): Promise<{ host: string; resultado: ResultadoDelSembrado; versionId: string | null; reporte: ReporteDelSembrado }> {
  const { host, name } = database()
  log(`Base: ${host}  base de datos: ${name}  modo: ${options.apply ? 'APLICAR' : 'SIMULACIÓN'}`)
  if (options.apply && (options.confirmHost !== host || options.confirmDb !== name))
    throw new SeedRefusal(
      `🔴 No se escribió NADA. Para escribir en esta base repite su host y su nombre exactos:  --confirm-host ${host} --confirm-db ${name}`,
    )

  // Se cargan después de la comprobación: el cliente lee DATABASE_URL al cargarse.
  const { default: prisma } = await import('../src/utils/prismaClient')
  const { revisarSembradoDeLaVersionUno, sembrarVersionUno, versionExistente } = await import('../src/services/billing/planOfferSeed')
  log(`Stripe: ${(process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live') ? 'PRODUCCIÓN (sk_live)' : 'PRUEBAS'}`)

  if (!options.apply) {
    const reporte = await revisarSembradoDeLaVersionUno()
    imprimir(reporte, false, null, log)
    return { host, resultado: reporte.resultado, versionId: null, reporte }
  }

  if ((await versionExistente()).sinTablasDeB1)
    throw new SeedRefusal('🔴 No se escribió NADA: la base todavía no tiene las tablas de B1; aplica primero la migración de B1.')

  const staff = options.staffId
    ? await prisma.staff.findUnique({ where: { id: options.staffId }, select: { id: true } })
    : await prisma.staff.findFirst({
        where: { venues: { some: { role: 'SUPERADMIN' } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      })
  if (!staff)
    throw new SeedRefusal(options.staffId ? `No existe el staff ${options.staffId}.` : 'No encontré un SUPERADMIN: pasa --staff <id>.')

  const { resultado, versionId, reporte } = await sembrarVersionUno(staff.id)
  imprimir(reporte, true, versionId, log)
  if (resultado !== 'CREATE' && resultado !== 'EXISTS')
    throw new SeedRefusal(`🔴 No se sembró: el resultado es ${resultado}. No se escribió nada; corrige lo de arriba y vuelve a correrlo.`)
  return { host, resultado, versionId, reporte }
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  await import('dotenv/config')
  await seedPlanOfferV1({
    apply: process.argv.includes('--apply'),
    confirmHost: flag('--confirm-host'),
    confirmDb: flag('--confirm-db'),
    staffId: flag('--staff'),
  })
  const { default: prisma } = await import('../src/utils/prismaClient')
  await prisma.$disconnect()
}

if (require.main === module)
  main()
    .then(() => process.exit(0))
    .catch(error => {
      // Una negativa o un error de negocio (p. ej. HYBRID_PRICE_BUSY: vuelve a correrlo) es sólo su mensaje.
      console.error(error instanceof SeedRefusal || error?.isOperational ? error.message : error)
      process.exit(error instanceof SeedRefusal ? 2 : 1)
    })
